// ============================================================
// dsh-plugin-memory · 分层记忆插件（M3 v1）
// 职责：
//   1. 存储：ctx.storageDomain 域 'aemeath_memory'（memories 表 + audit 表 + userProfile 全局）
//   2. 事实采集：session/event 监听，缓冲每轮 (query, reply)
//   3. 守门员规则层（gatekeeper.ts 纯函数）→ save 直写 / knowledge_routed / skip / blocked / pending
//   4. LLM 判定层（配置启用时）：攒批 8 轮 → DeepSeek 判定 JSON 动作（默认关闭，M3 v2 细化）
//   5. 召回注入：agent/pre-step 按 preset 召回 L2(mode) + L3(global) top-k，MessageSource form='recall'
//   6. 审计：每次写入/更新/删除记 audit 表（可回放、可撤销）
//   7. 衰减：last_access 超 90 天 importance-10 → <30 dormant（setInterval 宿主级）
//   8. /memory 命令：list/stats/delete
// 注：M3 v1 交付核心闭环（采集→守门→存储→召回→审计）；容量淘汰/再巩固/管理端点/迁移脚本为 v2 增量。
// ============================================================

import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { z as zod } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import { decide, type MemoryAction, type Category } from './gatekeeper.js';

export const name = 'aemeath-memory';
export const inject = ['storageDomain', 'commands'];

// ===== 配置 =====
export const Config = z.object({
  l2RecallTopK: z.number(),
  llm: z.object({
    enabled: z.boolean(),
    apiKey: z.string(),
    baseUrl: z.string(),
    model: z.string(),
  }),
  decayDays: z.number(),
});

export interface MemoryConfig {
  l2RecallTopK?: number;
  llm?: { enabled?: boolean; apiKey?: string; baseUrl?: string; model?: string };
  decayDays?: number;
}

// ===== 存储域（zod 记录 schema） =====
const memoryRecord = zod.object({
  id: zod.string(),
  scope: zod.enum(['mode', 'global']),
  preset: zod.string(),
  content: zod.string(),
  category: zod.enum(['user_fact', 'study_log', 'preference', 'relationship', 'session_summary']),
  importance: zod.number(),
  confidence: zod.number(),
  source_mode: zod.string(),
  created_at: zod.number(),
  last_access: zod.number(),
  status: zod.enum(['active', 'dormant']),
  superseded_by: zod.string().optional(),
  deleted: zod.boolean().optional(),
});
type MemoryRecord = zod.infer<typeof memoryRecord>;

const auditRecord = zod.object({
  id: zod.string(),
  ts: zod.number(),
  action: zod.string(),
  memory_id: zod.string().optional(),
  detail: zod.string(),
});

const userProfileGlobal = zod.object({ facts: zod.array(zod.string()) });

const MEMORY_DOMAIN = defineDomain({
  name: 'aemeath_memory',
  version: 1,
  global: { schema: userProfileGlobal, initial: { facts: [] } },
  tables: {
    memories: domainTable<string, MemoryRecord>(memoryRecord),
    audit: domainTable<string, (typeof auditRecord)['_output']>(auditRecord),
  },
});

function log(msg: string): void {
  console.log(`[aemeath-memory] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[aemeath-memory] ⚠ ${msg}`);
}

/** 攒批判定：每 N 轮 flush 一次 LLM 判定（M3 v1 简化：直接落 pending 审计，不真正调 LLM 除非启用）。 */
const LLM_BATCH_SIZE = 8;

export async function apply(ctx: Context, config: MemoryConfig): Promise<void> {
  const topK = config.l2RecallTopK ?? 5;
  const decayDays = config.decayDays ?? 90;
  const llm = config.llm ?? { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' };

  // ---- 打开存储域 ----
  const domain = await ctx.storageDomain.open(MEMORY_DOMAIN);
  ctx.effect(() => () => {
    void domain.close();
  });
  const memories = domain.table('memories') as unknown as KvTable<string, MemoryRecord>;
  const audit = domain.table('audit') as unknown as KvTable<string, (typeof auditRecord)['_output']>;
  const profile = domain.global as unknown as { get(): { facts: string[] }; set(v: { facts: string[] }): Promise<void> };
  log(`存储域 aemeath_memory 已打开（memories=${memories.size} 条历史记录）`);

  const auditWrite = async (action: string, memoryId: string | undefined, detail: string): Promise<void> => {
    try {
      await audit.put(randomUUID(), { id: randomUUID(), ts: Date.now(), action, memory_id: memoryId, detail });
    } catch (e) {
      warn(`审计写入失败: ${(e as Error).message}`);
    }
  };

  // ---- 事实采集：缓冲每轮 (query, reply) ----
  interface PendingTurn { query: string; reply: string; preset: string; ts: number }
  const turnBuffer = new Map<string, PendingTurn>();
  const pendingBatch = new Map<string, PendingTurn[]>();

  ctx.on('session/event', (session, event) => {
    try {
      const sid = session.id;
      if (event.type === 'user/message' && (event.data.source?.kind ?? 'user') === 'user') {
        const text = (event.data.content ?? [])
          .map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : ''))
          .join('')
          .trim();
        if (text) turnBuffer.set(sid, { query: text, reply: '', preset: resolveSessionPreset(session) ?? '', ts: Date.now() });
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
        await saveMemory(turn.preset, decision.content, decision.category, decision.importance, 0.9, sid);
        break;
      }
      case 'pending': {
        const batch = pendingBatch.get(sid) ?? [];
        batch.push(turn);
        pendingBatch.set(sid, batch);
        if (batch.length >= LLM_BATCH_SIZE) await flushLlm(sid, batch);
        break;
      }
    }
  };

  const saveMemory = async (preset: string, content: string, category: Category, importance: number, confidence: number, sid: string): Promise<void> => {
    const id = randomUUID();
    const rec: MemoryRecord = {
      id,
      scope: 'mode', // M3 v1：先按角色域存；跨角色提升由 LLM 层/后续升级决定
      preset,
      content,
      category,
      importance,
      confidence,
      source_mode: preset,
      created_at: Date.now(),
      last_access: Date.now(),
      status: 'active',
    };
    await memories.put(id, rec);
    await auditWrite('save', id, `importance=${importance} category=${category}`);
    log(`记忆已写入 preset=${preset} cat=${category} imp=${importance}（${content.slice(0, 30)}…）`);
  };

  const flushLlm = async (sid: string, batch: PendingTurn[]): Promise<void> => {
    pendingBatch.delete(sid);
    if (!llm.enabled || !llm.apiKey) {
      await auditWrite('pending_skipped', undefined, `${batch.length} 轮待 LLM 判定（判定层未启用）`);
      return;
    }
    try {
      const prompt = [
        '你是记忆守门员的判定层。对以下每轮对话，输出 JSON 数组，每项含：',
        '{query, action: "save"|"update"|"merge"|"reconsolidate"|"skip", importance: 0-100, category: "user_fact"|"study_log"|"preference"|"relationship"|"session_summary", conflict: bool, content: "第一人称记忆内容"}',
        '规则：只记关于用户的事实；知识/闲聊 skip；第一人称书写；有冲突标 conflict。',
        JSON.stringify(batch.map((b) => ({ query: b.query, reply: b.reply }))),
      ].join('\n');
      const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          max_tokens: 1024,
          temperature: 0.2,
        }),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content ?? '[]';
      const parsed = JSON.parse(text) as Array<{ action: string; importance?: number; category?: Category; content?: string; conflict?: boolean }>;
      for (const item of parsed) {
        if (item.action === 'save' && item.content) {
          await saveMemory(batch[0].preset, item.content, item.category ?? 'session_summary', item.importance ?? 50, 0.7, sid);
        } else {
          await auditWrite(`llm_${item.action}`, undefined, `conflict=${!!item.conflict}`);
        }
      }
      log(`LLM 判定完成：${parsed.length} 项（${sid}）`);
    } catch (e) {
      await auditWrite('llm_error', undefined, `LLM 判定失败: ${(e as Error).message}`);
      warn(`LLM 判定失败: ${(e as Error).message}`);
    }
  };

  // ---- 召回注入（agent/pre-step，form='recall'） ----
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    const preset = resolveSessionPreset(payload.agent.session as never);
    if (!preset) return decision;

    const now = Date.now();
    const recs: MemoryRecord[] = [];
    for (const [, rec] of memories.entries()) {
      if (rec.deleted || rec.status !== 'active') continue;
      if (rec.scope === 'global' || rec.preset === preset) recs.push(rec);
    }
    recs.sort((a, b) => b.importance - a.importance);
    const top = recs.slice(0, topK);
    if (!top.length) return decision;

    // 更新 last_access（异步，不阻塞 step）
    for (const rec of top) {
      void memories.update(rec.id, (cur) => ({ ...cur, last_access: now })).catch(() => undefined);
    }

    const block = ['## 关于用户的记忆（第一人称）', ...top.map((r) => `- [${r.category}|imp=${r.importance}] ${r.content}`)].join('\n');
    log(`preset=${preset} 召回 ${top.length} 条记忆注入`);
    const injectMsg = createUserMessage({
      content: [{ type: 'text', text: block }],
      source: { kind: 'plugin', plugin: name, form: 'recall' },
    });
    return { kind: 'enter', messages: [...decision.messages, injectMsg] };
  });
  log('记忆召回注入已挂载（agent/pre-step）');

  // ---- 衰减（宿主级定时） ----
  const decayTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of memories.entries()) {
      if (rec.deleted) continue;
      if (now - rec.last_access > decayDays * 24 * 3600 * 1000) {
        const next = Math.max(0, rec.importance - 10);
        void memories
          .update(key, (cur) => ({ ...cur, importance: next, status: next < 30 ? 'dormant' : cur.status }))
          .then(() => auditWrite('decay', key, `importance ${rec.importance}→${next}`))
          .catch(() => undefined);
      }
    }
  }, 6 * 3600 * 1000);
  if (decayTimer.unref) decayTimer.unref();
  log(`衰减已启用（${decayDays} 天未访问 -10 importance）`);

  // ---- /memory 命令 ----
  ctx.commands.register({
    name: 'memory',
    description: '记忆管理：list / stats / delete <id>',
    input: { hint: 'list | stats | delete <id>' },
    handler: async ({ rawInput }) => {
      const args = (rawInput || '').trim().split(/\s+/);
      const cmd = args[0] || 'stats';
      const ok = (text: string) => ({ kind: 'success' as const, text });
      const err = (text: string) => ({ kind: 'error' as const, text });
      if (cmd === 'list') {
        const lines: string[] = [];
        for (const [, rec] of memories.entries()) {
          if (rec.deleted) continue;
          lines.push(`- ${rec.id.slice(0, 8)} [${rec.preset}|${rec.category}|imp=${rec.importance}|${rec.status}] ${rec.content}`);
        }
        return ok(lines.length ? `记忆列表（${lines.length} 条）:\n${lines.join('\n')}` : '（暂无记忆）');
      }
      if (cmd === 'delete' && args[1]) {
        const found = [...memories.entries()].find(([k]) => k.startsWith(args[1]));
        if (!found) return err(`未找到 ${args[1]}`);
        await memories.put(found[0], { ...found[1], deleted: true });
        await auditWrite('soft_delete', found[0], '用户删除');
        return ok(`已软删 ${args[1]}`);
      }
      if (cmd === 'stats') {
        let active = 0;
        let dormant = 0;
        const byPreset = new Map<string, number>();
        for (const [, rec] of memories.entries()) {
          if (rec.deleted) continue;
          if (rec.status === 'active') active++;
          else dormant++;
          byPreset.set(rec.preset, (byPreset.get(rec.preset) ?? 0) + 1);
        }
        return ok(`记忆统计：active=${active} dormant=${dormant} 按角色=${[...byPreset.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}`);
      }
      return ok('用法: /memory list | stats | delete <id>（支持 id 前缀）');
    },
  });
  log('/memory 命令已注册');
}
