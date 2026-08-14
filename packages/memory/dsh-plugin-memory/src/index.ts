// ============================================================
// dsh-plugin-memory · 分层记忆插件（M3 v3 · 完整版）
// 职责：
//   1. 存储：ctx.storageDomain 域 'aemeath_memory'（memories + audit + userProfile）
//   2. 事实采集：session/event 缓冲每轮 (query, reply)
//   3. 守门员规则层 → save/knowledge_routed/skip/blocked/pending
//   4. LLM 判定层：攒批 → DeepSeek JSON 动作（save/update/merge/reconsolidate/skip
//      + conflict + target_id + scope: mode|global）
//   5. L1 暂存区：MemoryService.scratch（会话内任务工作态，M6 解题用）
//   6. L2/L3：scope='mode' 角色隔离；scope='global' 跨角色共享
//   7. user_profile 沉淀：user_fact 归集进全局画像（衰减/淘汰前）
//   8. L3 容量淘汰：importance×recency 最低者先沉淀后淘汰
//   9. 召回注入：pre-step 按 preset 召回 L2+L3（form='recall'）
//   10. session/flush 接入：落盘时机触发 pending 批量判定
//   11. ctx.memory Service：search/list/save/softDelete/stats/scratch
//   12. HTTP 管理端点（可选，仅回环）：/memory/list|stats|delete
//   13. 审计 + 衰减 + /memory 命令
// ============================================================

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { KvTable } from '@deepseek-ai/dsh-storage-domain';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-credentials';
import { decide, hasTimeEvidence, classifyCategory, extractMemory, type Category } from './gatekeeper.js';
import { search as bm25Search } from './bm25.js';
import { selectEviction, suggestProfileFacts } from './engine.js';
import { memoryRecordSchema, auditRecordSchema, userProfileSchema, type MemoryRecord, type AuditRecord, type UserProfile } from './types.js';
import { MemoryService } from './service.js';

export const name = 'aemeath-memory';
export const inject = ['storageDomain', 'commands', 'credentials', 'settings'];

// ===== 配置 =====
export const Config = z.object({
  defaultPreset: z.string(),
  l2RecallTopK: z.number(),
  l3Capacity: z.number(),
  llm: z.object({
    enabled: z.boolean(),
    apiKey: z.string(),
    baseUrl: z.string(),
    model: z.string(),
    batchSize: z.number(),
  }),
  decayDays: z.number(),
  adminHttp: z.object({
    enabled: z.boolean(),
    port: z.number(),
  }),
});

export interface MemoryConfig {
  defaultPreset?: string;
  l2RecallTopK?: number;
  l3Capacity?: number;
  llm?: { enabled?: boolean; apiKey?: string; baseUrl?: string; model?: string; batchSize?: number };
  decayDays?: number;
  adminHttp?: { enabled?: boolean; port?: number };
}

// ===== 存储域（zod 记录 schema，见 types.ts） =====
const MEMORY_DOMAIN = defineDomain({
  name: 'aemeath_memory',
  version: 1,
  global: { schema: userProfileSchema, initial: { facts: [] } },
  tables: {
    memories: domainTable<string, MemoryRecord>(memoryRecordSchema),
    audit: domainTable<string, AuditRecord>(auditRecordSchema),
  },
});

function log(msg: string): void {
  console.log(`[aemeath-memory] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[aemeath-memory] ⚠ ${msg}`);
}

const LLM_BATCH_SIZE_DEFAULT = 8;

export async function apply(ctx: Context, config: MemoryConfig): Promise<void> {
  // ---- settings 接线（M5：前端设置界面 → 实时开关） ----
  const runtime = { enabled: true };
  const FeatureSettingsSchema = z.object({ enabled: z.boolean() });
  const featureBase = { enabled: true };
  let currentSource: () => typeof featureBase = () => featureBase;
  installSettingsSection(
    ctx,
    settingsNamespace('aemeath-memory'),
    FeatureSettingsSchema,
    featureBase,
    {
      setSource: (current) => {
        currentSource = current;
      },
      onChange: () => {
        const v = currentSource();
        runtime.enabled = v.enabled;
        log(`settings 已应用: enabled=${runtime.enabled}`);
      },
    },
  );

  const topK = config.l2RecallTopK ?? 5;
  const l3Capacity = config.l3Capacity ?? 500;
  const decayDays = config.decayDays ?? 90;
  const llm = config.llm ?? { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', batchSize: LLM_BATCH_SIZE_DEFAULT };
  const llmBatchSize = Math.max(2, llm.batchSize ?? LLM_BATCH_SIZE_DEFAULT);
  const adminHttp = config.adminHttp ?? { enabled: true, port: 18895 };

  // ---- 打开存储域 ----
  const domain = await ctx.storageDomain.open(MEMORY_DOMAIN);
  ctx.effect(() => () => {
    void domain.close();
  });
  const memories = domain.table('memories') as unknown as KvTable<string, MemoryRecord>;
  const audit = domain.table('audit') as unknown as KvTable<string, AuditRecord>;
  const profile = domain.global as unknown as { get(): UserProfile; set(v: UserProfile): Promise<void> };
  log(`存储域 aemeath_memory 已打开（memories=${memories.size} 条历史记录）`);

  const auditWrite = async (action: string, memoryId: string | undefined, detail: string): Promise<void> => {
    try {
      await audit.put(randomUUID(), { id: randomUUID(), ts: Date.now(), action, memory_id: memoryId, detail });
    } catch (e) {
      warn(`审计写入失败: ${(e as Error).message}`);
    }
  };

  // ---- ctx.memory 服务 ----
  const memoryService = new MemoryService(ctx, { memories, audit, profile, auditWrite });
  log('ctx.memory 服务已注册（search/list/save/softDelete/stats/scratch）');

  // ---- 事实采集：缓冲每轮 (query, reply) ----
  interface PendingTurn { query: string; reply: string; preset: string; ts: number }
  const turnBuffer = new Map<string, PendingTurn>();
  const pendingBatch = new Map<string, PendingTurn[]>();

  ctx.on('session/event', (session, event) => {
    try {
      if (!runtime.enabled) return;
      const sid = session.id;
      if (event.type === 'user/message' && (event.data.source?.kind ?? 'user') === 'user') {
        const text = (event.data.content ?? [])
          .map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : ''))
          .join('')
          .trim();
        if (text) turnBuffer.set(sid, { query: text, reply: '', preset: resolveSessionPreset(session) ?? config.defaultPreset ?? '', ts: Date.now() });
      } else if (event.type === 'assistant/message') {
        const buf = turnBuffer.get(sid);
        if (!buf) return;
        const text = (event.data.message?.content ?? [])
          .map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : ''))
          .join('')
          .trim();
        buf.reply = text;
        turnBuffer.delete(sid);
        void processTurn(sid, buf);
      }
    } catch (e) {
      warn(`采集失败: ${(e as Error).message}`);
    }
  });

  // ---- 画像沉淀：user_fact 类记忆归集进全局 userProfile ----
  const promoteProfileFacts = async (): Promise<void> => {
    try {
      const facts: string[] = [];
      for (const { rec } of memoryService.list()) {
        if (rec.deleted || rec.category !== 'user_fact') continue;
        facts.push(rec.content);
      }
      const existing = profile.get().facts;
      const added = suggestProfileFacts(facts, existing, 20);
      if (added.length) {
        await profile.set({ facts: [...existing, ...added].slice(-40) });
        await auditWrite('profile_promote', undefined, `沉淀 ${added.length} 条用户事实`);
        log(`画像沉淀：+${added.length} 条（${added[0].slice(0, 20)}…）`);
      }
    } catch (e) {
      warn(`画像沉淀失败: ${(e as Error).message}`);
    }
  };

  // ---- L3 容量淘汰：importance×recency 最低者先沉淀后淘汰 ----
  const enforceCapacity = async (): Promise<void> => {
    const candidates = memoryService
      .list()
      .map(({ key, rec }) => ({ id: key, importance: rec.importance, lastAccess: rec.last_access, scope: rec.scope, status: rec.status }));
    const evict = selectEviction(candidates, l3Capacity, Date.now());
    if (!evict.length) return;
    await promoteProfileFacts();
    for (const id of evict) {
      const rec = memories.get(id);
      if (!rec) continue;
      await memories.put(id, { ...rec, deleted: true, status: 'dormant' });
      await auditWrite('capacity_evict', id, 'L3 容量淘汰（已先沉淀画像）');
      log(`L3 容量淘汰：${id.slice(0, 8)}（${rec.content.slice(0, 20)}…）`);
    }
  };

  const saveMemory = async (preset: string, content: string, category: Category, importance: number, confidence: number, sid: string, scope: 'mode' | 'global'): Promise<string> => {
    const id = await memoryService.save({ content, category, importance, confidence, scope, preset, source_mode: preset });
    if (scope === 'global') await enforceCapacity();
    log(`记忆已写入 preset=${preset} cat=${category} imp=${importance} scope=${scope}（${content.slice(0, 30)}…）`);
    return id;
  };

  const supersedeMemory = async (oldKey: string, preset: string, content: string, category: Category, sid: string): Promise<void> => {
    const old = memories.get(oldKey);
    if (!old) return;
    const newId = await saveMemory(preset, content, category, Math.max(60, old.importance), 0.8, sid, old.scope);
    await memories.put(oldKey, { ...old, superseded_by: newId, status: 'dormant', confidence: Math.max(0, old.confidence - 0.2) });
    await auditWrite('supersede', oldKey, `被 ${newId.slice(0, 8)} 取代（时间证据冲突）`);
    log(`冲突 supersede：${oldKey.slice(0, 8)} → ${newId.slice(0, 8)}（${content.slice(0, 30)}…）`);
  };

  const processTurn = async (sid: string, turn: PendingTurn): Promise<void> => {
    const decision = decide(turn.query, turn.reply);
    switch (decision.kind) {
      case 'blocked':
        await auditWrite('blocked', undefined, `凭据拦截（${sid}）`);
        break;
      case 'knowledge_routed':
        await auditWrite('knowledge_routed', undefined, `${turn.preset} 知识轮次（${turn.query.slice(0, 30)}）`);
        break;
      case 'skip':
        break;
      case 'save': {
        // 规则级冲突：时间证据 + BM25 命中 → supersede
        const hits = bm25Search(`${turn.query} ${turn.reply}`, allMemories(), 1);
        const conflictHit = hits.length > 0 && hits[0].score > 0.8 && hasTimeEvidence(turn.query);
        // L3 升级：user_fact 类显式事实 → global（跨角色稳定）
        const scope: 'mode' | 'global' = decision.category === 'user_fact' ? 'global' : 'mode';
        if (conflictHit) {
          await supersedeMemory(hits[0].id, turn.preset, decision.content, decision.category, sid);
        } else {
          await saveMemory(turn.preset, decision.content, decision.category, decision.importance, 0.9, sid, scope);
        }
        break;
      }
      case 'pending': {
        // 规则级冲突（pending 也检查）：时间证据 + BM25 命中 → supersede，不必等 LLM
        const hits = bm25Search(`${turn.query} ${turn.reply}`, allMemories(), 1);
        if (hits.length > 0 && hits[0].score > 0.8 && hasTimeEvidence(turn.query)) {
          await supersedeMemory(hits[0].id, turn.preset, extractMemory(turn.query), classifyCategory(turn.query, turn.reply), sid);
          break;
        }
        const batch = pendingBatch.get(sid) ?? [];
        batch.push(turn);
        pendingBatch.set(sid, batch);
        if (batch.length >= llmBatchSize) await flushLlm(sid, batch);
        break;
      }
    }
  };

  const allMemories = (): Array<{ id: string; content: string }> => {
    return memoryService.list().map(({ key, rec }) => ({ id: key, content: rec.content }));
  };

  const applyLlmAction = async (item: { action: string; importance?: number; category?: Category; content?: string; conflict?: boolean; target_id?: string; scope?: string }, preset: string, sid: string): Promise<void> => {
    const action = item.action || 'skip';
    const cat = item.category ?? 'session_summary';
    const imp = item.importance ?? 50;
    const scope: 'mode' | 'global' = item.scope === 'global' ? 'global' : 'mode';
    let targetKey = item.target_id;
    if (!targetKey && item.content) {
      const hits = bm25Search(item.content, allMemories(), 1);
      if (hits.length) targetKey = hits[0].id;
    }
    const target = targetKey ? memories.get(targetKey) : undefined;

    switch (action) {
      case 'save':
        if (item.content) await saveMemory(preset, item.content, cat, imp, 0.7, sid, scope);
        break;
      case 'update':
        if (item.content && target) await supersedeMemory(targetKey!, preset, item.content, cat, sid);
        else if (item.content) await saveMemory(preset, item.content, cat, imp, 0.7, sid, scope);
        break;
      case 'merge': {
        if (item.content && target) {
          const merged = target.content.length + item.content.length < 200 ? `${target.content}；${item.content}` : item.content;
          await memories.put(targetKey!, { ...target, content: merged, importance: Math.max(target.importance, imp), last_access: Date.now() });
          await auditWrite('merge', targetKey, `合并新内容（${item.content.slice(0, 30)}…）`);
          log(`记忆合并 → ${targetKey!.slice(0, 8)}`);
        }
        break;
      }
      case 'reconsolidate': {
        if (target) {
          await memories.put(targetKey!, { ...target, importance: Math.min(100, target.importance + 10), last_access: Date.now() });
          await auditWrite('reconsolidate', targetKey, '再巩固（importance+10）');
          log(`记忆再巩固 → ${targetKey!.slice(0, 8)}`);
        }
        break;
      }
      default:
        await auditWrite(`llm_${action}`, targetKey, `conflict=${!!item.conflict}`);
    }
  };

  const flushLlm = async (sid: string, batch: PendingTurn[]): Promise<void> => {
    pendingBatch.delete(sid);
    if (!llm.enabled) {
      await auditWrite('pending_skipped', undefined, `${batch.length} 轮待 LLM 判定（判定层未启用）`);
      return;
    }
    let apiKey = llm.apiKey;
    if (!apiKey) {
      try {
        const resolved = await ctx.credentials?.resolve(credentialRef('DEEPSEEK_API_KEY'));
        apiKey = resolved?.value ?? '';
      } catch {
        apiKey = '';
      }
    }
    if (!apiKey) {
      await auditWrite('llm_no_key', undefined, 'LLM 判定层未配置 API key（credentialRef DEEPSEEK_API_KEY）');
      warn('LLM 判定层未配置 API key（credentialRef DEEPSEEK_API_KEY）');
      return;
    }
    try {
      // 每个候选查重 top-3（喂给 LLM 判断冲突/更新目标）
      const candidates = batch.map((b) => ({
        query: b.query,
        reply: b.reply,
        similar: bm25Search(`${b.query} ${b.reply}`, allMemories(), 3).map((h) => ({
          id: h.id.slice(0, 8),
          content: (memories.get(h.id)?.content ?? '').slice(0, 80),
        })),
      }));
      const prompt = [
        '你是记忆守门员的判定层。对以下每轮对话（含与现有记忆的相似候选），输出 JSON 数组，每项含：',
        '{query, action: "save"|"update"|"merge"|"reconsolidate"|"skip", importance: 0-100, category: "user_fact"|"study_log"|"preference"|"relationship"|"session_summary", conflict: bool, target_id: string|null, scope: "mode"|"global", content: "第一人称记忆内容"}',
        '规则：只记关于用户的事实；知识与闲聊 skip；第一人称书写；与候选记忆高度相似且事实有变化（如考完/学会）→ update（target_id 填相似记忆 id，content 写新状态）；相似但可合并 → merge；无冲突新事实 → save；无法确定 → skip。scope 判定：跨角色稳定事实（身份/长期偏好/基本习惯）→ global；角色相关（学习计划/进度/课程）→ mode。',
        JSON.stringify(candidates),
      ].join('\n');
      const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          max_tokens: 1024,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content ?? '[]';
      const parsed = JSON.parse(text) as Array<{ query?: string; action: string; importance?: number; category?: Category; content?: string; conflict?: boolean; target_id?: string; scope?: string }>;
      for (const item of parsed) {
        await applyLlmAction(item, batch[0].preset, sid);
      }
      await auditWrite('llm_batch', undefined, `${batch.length} 轮判定完成（${parsed.length} 项）`);
      log(`LLM 判定完成：${parsed.length} 项（${sid.slice(0, 8)}）`);
    } catch (e) {
      await auditWrite('llm_error', undefined, `LLM 判定失败: ${(e as Error).message}`);
      warn(`LLM 判定失败: ${(e as Error).message}`);
    }
  };

  // ---- 召回注入（agent/pre-step，form='recall'） ----
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    if (!runtime.enabled) return decision;

    const preset = resolveSessionPreset(payload.agent.session as never) ?? config.defaultPreset;
    if (!preset) return decision;

    const now = Date.now();
    const top = memoryService.recallForPreset(preset, topK);
    if (!top.length) return decision;

    for (const { key, rec } of top) {
      void memories.update(key, (cur) => ({ ...cur, last_access: now })).catch(() => undefined);
    }

    const block = ['## 关于用户的记忆（第一人称）', ...top.map(({ rec }) => `- [${rec.category}|imp=${rec.importance}|${rec.scope}] ${rec.content}`)].join('\n');
    log(`preset=${preset} 召回 ${top.length} 条记忆注入`);
    const injectMsg = createUserMessage({
      content: [{ type: 'text', text: block }],
      source: { kind: 'plugin', plugin: name, form: 'recall' },
    });
    return { kind: 'enter', messages: [...decision.messages, injectMsg] };
  });
  log('记忆召回注入已挂载（agent/pre-step）');

  // ---- session/flush 接入：落盘时机触发 pending 批量判定 ----
  ctx.on('session/flush', async (session) => {
    const sid = session.id;
    const batch = pendingBatch.get(sid);
    if (batch && batch.length > 0) {
      log(`session/flush：${sid.slice(0, 8)} 有 ${batch.length} 轮 pending，触发判定`);
      await flushLlm(sid, batch);
    }
  });
  log('session/flush 已接入（pending 批量判定）');

  // ---- 衰减（宿主级定时）+ 沉淀 ----
  const decayTimer = setInterval(() => {
    const now = Date.now();
    for (const { key, rec } of memoryService.list()) {
      if (now - rec.last_access > decayDays * 24 * 3600 * 1000) {
        const next = Math.max(0, rec.importance - 10);
        void memories
          .update(key, (cur) => ({ ...cur, importance: next, status: next < 30 ? 'dormant' : cur.status }))
          .then(() => auditWrite('decay', key, `importance ${rec.importance}→${next}`))
          .catch(() => undefined);
      }
    }
    void promoteProfileFacts();
  }, 6 * 3600 * 1000);
  if (decayTimer.unref) decayTimer.unref();
  log(`衰减已启用（${decayDays} 天未访问 -10 importance，每 6h 检查）`);

  // ---- /memory 命令 ----
  ctx.commands.register({
    name: 'memory',
    description: '记忆管理：list / stats / delete <id> / profile / scratch',
    input: { hint: 'list | stats | delete <id> | profile | scratch <sessionId>' },
    handler: async ({ rawInput }) => {
      const args = (rawInput || '').trim().split(/\s+/);
      const cmd = args[0] || 'stats';
      const ok = (text: string) => ({ kind: 'success' as const, text });
      const err = (text: string) => ({ kind: 'error' as const, text });
      if (cmd === 'list') {
        const lines = memoryService.list().map(({ key, rec }) => `- ${key.slice(0, 8)} [${rec.preset}|${rec.scope}|${rec.category}|imp=${rec.importance}|${rec.status}] ${rec.content}`);
        return ok(lines.length ? `记忆列表（${lines.length} 条）:\n${lines.join('\n')}` : '（暂无记忆）');
      }
      if (cmd === 'delete' && args[1]) {
        return ok((await memoryService.softDelete(args[1])) ? `已软删 ${args[1]}` : `未找到 ${args[1]}`);
      }
      if (cmd === 'profile') {
        const facts = profile.get().facts;
        return ok(`用户画像（${facts.length} 条）:\n${facts.map((f) => `- ${f}`).join('\n') || '（空）'}`);
      }
      if (cmd === 'scratch') {
        const sid = args[1] ?? '';
        if (!sid) return err('用法: /memory scratch <sessionId>');
        const keys = memoryService.scratchKeys(sid);
        return ok(`scratch(${sid.slice(0, 8)}) keys: ${keys.join(', ') || '（空）'}`);
      }
      if (cmd === 'stats') {
        const s = memoryService.stats();
        return ok(`记忆统计：active=${s.active} dormant=${s.dormant} 按角色=${Object.entries(s.byPreset).map(([k, v]) => `${k}:${v}`).join(' ')} 按层=${Object.entries(s.byScope).map(([k, v]) => `${k}:${v}`).join(' ')}`);
      }
      return ok('用法: /memory list | stats | delete <id> | profile | scratch <sessionId>');
    },
  });
  log('/memory 命令已注册（list/stats/delete/profile/scratch）');

  // ---- HTTP 管理端点（可选，仅回环；D8：本地信任模型） ----
  if (adminHttp.enabled) {
    try {
      const server = createServer((req, res) => {
        const send = (code: number, obj: unknown): void => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(obj));
        };
        const url = req.url ?? '';
        if (url === '/memory/list') {
          send(200, { ok: true, items: memoryService.list().map(({ rec }) => ({ ...rec })) });
        } else if (url === '/memory/stats') {
          send(200, { ok: true, stats: memoryService.stats(), profile: profile.get() });
        } else if (url.startsWith('/memory/delete')) {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            try {
              const { idPrefix } = JSON.parse(body || '{}') as { idPrefix?: string };
              if (!idPrefix) return send(400, { ok: false, error: 'idPrefix required' });
              send(200, { ok: await memoryService.softDelete(idPrefix) });
            } catch (e) {
              send(500, { ok: false, error: (e as Error).message });
            }
          });
        } else {
          send(404, { ok: false, error: 'not found: use /memory/list | /memory/stats | /memory/delete' });
        }
      });
      server.listen(adminHttp.port, '127.0.0.1');
      ctx.effect(() => () => {
        server.close();
      });
      log(`HTTP 管理端点已启动（http://127.0.0.1:${adminHttp.port}/memory/*，仅回环）`);
    } catch (e) {
      warn(`HTTP 管理端点启动失败: ${(e as Error).message}`);
    }
  }
}
