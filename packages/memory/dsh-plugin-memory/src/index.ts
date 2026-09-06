// ============================================================
// dsh-plugin-memory · 分层记忆插件（M3 v3 · M3.4 分层改造）
// 职责：
//   1. 存储：ctx.storageDomain 域 'aemeath_memory'（memories + audit + userProfile + knowledge）
//   2. 事实采集：session/event 缓冲每轮 (query, reply)
//   3. 守门员规则层 → save（显式，即时）/ knowledge_routed / skip / blocked / 其余进 L1 缓冲
//   4. L1 分层：有容量上限的采集缓冲（工作区），容量达 80% 触发总结卸载
//      —— LLM 总结层把缓冲总结为记忆候选（落 L2/L3）+ 知识候选（落知识层）；LLM 未启用走规则兜底
//   5. L1 暂存区（scratch）：会话内任务工作态（M6 解题用），与 L1 缓冲共存
//   6. L2（scope='mode' 角色隔离）/ L3（scope='global' 跨角色共享）
//   7. 知识层（knowledge 表）：知识路由写入目标，status='pending' 等人工评审
//   8. user_profile 沉淀 + L3 容量淘汰（importance×recency）
//   9. 召回注入：pre-step 按 preset 召回 L2+L3（form='recall'）
//   10. session/flush 接入：会话结束时把 L1 缓冲卸载落盘
//   11. ctx.memory Service：search/list/save/softDelete/stats/scratch/l1/knowledge
//   12. HTTP 管理端点（可选，仅回环 + token 认证）：/memory/list|stats|delete|knowledge|l1
//        （S5 加固：精确路径、方法校验、body 1MB 上限、Bearer/x-aemeath-token 认证）
//   13. 审计 + 衰减 + /memory 命令
// ============================================================

import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
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
import { decide, hasTimeEvidence, isStrongKnowledge, classifyKnowledgeTopic, writeGate, classifyConflict, type Category, type WriteGateVerdict, type ConflictDecision, type ConflictType } from './gatekeeper.js';
import { search as bm25Search, overlapScore } from './bm25.js';
import { selectEviction, suggestProfileFacts } from './engine.js';
import { buildSummarizePrompt, consolidateTarget, fallbackUnload, describeL1Turn, sessionTokens, shouldTriggerL1ByTokens, type L1MemoryCandidate, type L1KnowledgeCandidate } from './layers.js';
import { memoryRecordSchema, auditRecordSchema, userProfileSchema, knowledgeRecordSchema, l1TurnsSchema, relationshipRecordSchema, type MemoryRecord, type AuditRecord, type UserProfile, type KnowledgeRecord, type L1Turn, type RelationshipRecord } from './types.js';
import { MemoryService } from './service.js';
import { classifyMoodStable, majorityLabel, pushMoodWindow, relationshipSignalOf, nextCareCueOf, moodClassifierPrompt, MOOD_WINDOW_CAP } from './mood.js';

export const name = 'aemeath-memory';
export const inject = ['storageDomain', 'commands', 'credentials', 'settings'];

// ===== 配置 =====
export const Config = z.object({
  defaultPreset: z.string(),
  l2RecallTopK: z.number(),
  /** L3（global 池）容量上限：超限按 importance×recency 淘汰最低者。 */
  l3Capacity: z.number(),
  /** L2（mode 池）容量上限：同样超限淘汰（默认 1000；L2 无容量上限会导致
   *  学期级 study_log 记忆无界累积——旧实现只对 global 执行容量淘汰）。 */
  l2Capacity: z.number(),
  /** L1 采集缓冲容量（每会话轮次上限；80% 阈值触发总结卸载）。 */
  l1Capacity: z.number(),
  /** L1 触发阈值（0~1，默认 0.8）。 */
  l1Threshold: z.number(),
  /** L1 触发 token 预算（估算，默认 3000）：累计对话 token ≥ 预算即触发总结，与 80% 容量互为补充。 */
  l1MaxTokens: z.number(),
  llm: z.object({
    enabled: z.boolean(),
    apiKey: z.string(),
    baseUrl: z.string(),
    model: z.string(),
    batchSize: z.number(),
    /** LLM 总结审核最小批次：未达此数不调 LLM（攒批省 token），小批次留在 L1 持久化缓冲。 */
    minBatch: z.number(),
  }),
  knowledge: z.object({
    /** 知识路由写入开关（规则初筛 knowledge_direct → 知识层 accepted + worldbook 桥接）。 */
    enabled: z.boolean(),
  }),
  /** worldbook 桥接：规则初筛/评审通过的知识写入对应馆的生成文件（热重载生效）。 */
  worldbook: z.object({
    enabled: z.boolean(),
    /** 按 preset（馆）映射生成文件目录；不存在该馆则跳过桥接（不跨模态写）。 */
    libraries: z.dict(z.string()),
  }),
  decayDays: z.number(),
  /** 记忆触动词：用户说这些词时立即总结该会话 L1 缓冲（跳过 minBatch 攒批），
   *  让记忆当场落库、跨会话立即可用。默认内建一组，此处可追加/覆盖自定义触发词。 */
  termTriggerPhrases: z.array(z.string()),
  adminHttp: z.object({
    enabled: z.boolean(),
    port: z.number(),
    /** 访问 token（S5 加固）：留空则启动时自动生成并打印一次（schemastery 属性默认可选）。 */
    token: z.string(),
  }),
});

export interface MemoryConfig {
  defaultPreset?: string;
  l2RecallTopK?: number;
  l3Capacity?: number;
  l2Capacity?: number;
  l1Capacity?: number;
  l1Threshold?: number;
  l1MaxTokens?: number;
  llm?: { enabled?: boolean; apiKey?: string; baseUrl?: string; model?: string; batchSize?: number; minBatch?: number };
  knowledge?: { enabled?: boolean };
  worldbook?: { enabled?: boolean; libraries?: Record<string, string> };
  decayDays?: number;
  termTriggerPhrases?: string[];
  adminHttp?: { enabled?: boolean; port?: number; token?: string };
}

// ===== 存储域（zod 记录 schema，见 types.ts） =====
const MEMORY_DOMAIN = defineDomain({
  name: 'aemeath_memory',
  version: 1,
  global: { schema: userProfileSchema, initial: { facts: [] } },
  tables: {
    memories: domainTable<string, MemoryRecord>(memoryRecordSchema),
    audit: domainTable<string, AuditRecord>(auditRecordSchema),
    knowledge: domainTable<string, KnowledgeRecord>(knowledgeRecordSchema),
    l1: domainTable<string, L1Turn[]>(l1TurnsSchema),
    // A3/A4（借 Cyrene 想法）：关系/情绪上下文，按 preset（角色）各存一份
    relationship: domainTable<string, RelationshipRecord>(relationshipRecordSchema),
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
  const l2Capacity = config.l2Capacity ?? 1000;
  const l1Capacity = Math.max(8, config.l1Capacity ?? 40);
  const l1Threshold = Math.min(1, Math.max(0.1, config.l1Threshold ?? 0.8));
  const l1MaxTokens = Math.max(512, config.l1MaxTokens ?? 3000);
  const knowledgeEnabled = config.knowledge?.enabled ?? true;
  // C8：worldbook 桥接的 preset→馆目录映射优先取 worldbook 插件（service）的配置，
  // 避免 cordis.patch.yml 里 libraries 在两个插件各抄一份造成漂移；service 未加载
  // （worldbook 插件未挂）时退回自身配置/内置默认。
  const worldbookLibrariesFromService = ((): Record<string, string> | undefined => {
    try {
      const svc = (ctx as unknown as { reflect?: { get(n: string): unknown } }).reflect?.get('worldbook') as
        { libraries?: Record<string, string> } | undefined;
      return svc?.libraries && Object.keys(svc.libraries).length ? svc.libraries : undefined;
    } catch {
      return undefined;
    }
  })();
  const worldbook = {
    enabled: config.worldbook?.enabled ?? false,
    libraries: config.worldbook?.libraries ?? worldbookLibrariesFromService ?? { physicist: 'packages/worldbook/data/physicist', aemeath: 'packages/worldbook/data/aemeath' },
  };
  const decayDays = config.decayDays ?? 90;
  const llm = config.llm ?? { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', batchSize: LLM_BATCH_SIZE_DEFAULT, minBatch: 4 };
  const llmMinBatch = Math.max(2, llm.minBatch ?? 4);
  const adminHttp = config.adminHttp ?? { enabled: true, port: 18895 };

  // 记忆触动词：用户说这些词 → 立即总结当前会话 L1 缓冲（跳过 minBatch 攒批，
  // 记忆当场落库、跨会话立即可读）。默认内建一组；config.termTriggerPhrases 追加。
  const termTrigger = [
    /记住/i, /记一下/i, /记下来/i, /记着/i, /整理/i, /总结/i, /总结一下/i,
    /记到/i, /写入记忆/i, /存进记忆/i, /列入记忆/i, /记笔记/i, /回顾一下/i,
    ...(config.termTriggerPhrases ?? []).map((p) => new RegExp(p, 'i')),
  ];

  // ---- 打开存储域 ----
  const domain = await ctx.storageDomain.open(MEMORY_DOMAIN);
  ctx.effect(() => () => {
    void domain.close();
  });
  const memories = domain.table('memories') as unknown as KvTable<string, MemoryRecord>;
  const audit = domain.table('audit') as unknown as KvTable<string, AuditRecord>;
  const knowledge = domain.table('knowledge') as unknown as KvTable<string, KnowledgeRecord>;
  const l1 = domain.table('l1') as unknown as KvTable<string, L1Turn[]>;
  const relationship = domain.table('relationship') as unknown as KvTable<string, RelationshipRecord>;
  const profile = domain.global as unknown as { get(): UserProfile; set(v: UserProfile): Promise<void> };
  log(`存储域 aemeath_memory 已打开（memories=${memories.size} 条历史记录, knowledge=${knowledge.size} 条知识, L1 缓冲=${l1.size} 会话, L1 容量=${l1Capacity} 阈值=${l1Threshold} token预算=${l1MaxTokens} minBatch=${llmMinBatch}）`);

  const auditWrite = async (action: string, memoryId: string | undefined, detail: string): Promise<void> => {
    try {
      // 第三关：audit 记录 key 与记录内 id 用同一个 UUID（原实现两次 randomUUID 不一致）
      const id = randomUUID();
      await audit.put(id, { id, ts: Date.now(), action, memory_id: memoryId, detail });
    } catch (e) {
      warn(`审计写入失败: ${(e as Error).message}`);
    }
  };

  // ---- ctx.memory 服务 ----
  // writeWorldbook 依赖为延迟闭包：writeWorldbookEntry 在下方定义，closure 在调用时才解析，
  // 既避免了 undefined 引用，也让 service 的 toWorldbook（纯手动桥接）复用同一份写入逻辑。
  const memoryService = new MemoryService(
    ctx,
    { memories, audit, knowledge, l1, relationship, profile, auditWrite, writeWorldbook: (input) => writeWorldbookEntry(input.preset, input.content, input.topic, input.source) },
    { capacity: l1Capacity, threshold: l1Threshold },
  );
  log('ctx.memory 服务已注册（search/list/save/softDelete/stats/scratch/l1/knowledge/toWorldbook/relationshipCue）');

  // ---- 事实采集：缓冲每轮 (query, reply)，配对后进入 L1 分层 ----
  interface CollectedTurn { query: string; reply: string; preset: string; ts: number }
  const turnBuffer = new Map<string, CollectedTurn>();
  // 第三关：turnBuffer 防无界增长——单轮未配对（assistant 消息缺失/会话中断）会滞留，
  // 超过上限时淘汰最旧（Map 保持插入序）
  const TURN_BUFFER_MAX = 200;
  const trimTurnBuffer = (): void => {
    while (turnBuffer.size > TURN_BUFFER_MAX) {
      const oldest = turnBuffer.keys().next().value;
      if (oldest === undefined) break;
      turnBuffer.delete(oldest);
    }
  };

  // ---- A3 mood observer 滚动窗口（近 MOOD_WINDOW_CAP 轮观测做多数表决；按 preset 维护） ----
  const moodWindow = new Map<string, string[]>();
  const trimMoodWindow = (): void => {
    // 防无界增长：淘汰最旧（Map 保持插入序，超上限删最旧一条）
    while (moodWindow.size > 512) {
      const oldest = moodWindow.keys().next().value;
      if (oldest === undefined) break;
      moodWindow.delete(oldest);
    }
  };

  ctx.on('session/event', (session, event) => {
    try {
      if (!runtime.enabled) return;
      const sid = session.id;
      if (event.type === 'user/message' && (event.data.source?.kind ?? 'user') === 'user') {
        const text = (event.data.content ?? [])
          .map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : ''))
          .join('')
          .trim();
        if (text) {
          turnBuffer.set(sid, { query: text, reply: '', preset: resolveSessionPreset(session) ?? config.defaultPreset ?? '', ts: Date.now() });
          trimTurnBuffer();
        }
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
      } else if (event.type === 'turn/end') {
        // 兜底配对（2026-08-17 修复）：assistant/message 缺失/异常时（如 LLM 失败、
        // 流中断），turn/end 时仍处理已缓冲的用户轮次，避免事实丢失。
        const buf = turnBuffer.get(sid);
        if (!buf) return;
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

  // ---- L2/L3 容量淘汰：各 scope 独立容量，importance×recency 最低者淘汰 ----
  const enforceCapacity = async (scope: 'mode' | 'global', capacity: number): Promise<void> => {
    const candidates = memoryService
      .list()
      .map(({ key, rec }) => ({ id: key, importance: rec.importance, lastAccess: rec.last_access, scope: rec.scope, status: rec.status }));
    const evict = selectEviction(candidates, scope, capacity, Date.now());
    if (!evict.length) return;
    // L3（global）淘汰前先沉淀稳定画像；L2（mode）无 user_fact，跳过
    if (scope === 'global') await promoteProfileFacts();
    for (const id of evict) {
      const rec = memories.get(id);
      if (!rec) continue;
      await memories.put(id, { ...rec, deleted: true, status: 'dormant' });
      await auditWrite('capacity_evict', id, `${scope === 'global' ? 'L3' : 'L2'} 容量淘汰（${scope === 'global' ? '已先沉淀画像' : '直接淘汰'}）`);
      log(`${scope === 'global' ? 'L3' : 'L2'} 容量淘汰：${id.slice(0, 8)}（${rec.content.slice(0, 20)}…）`);
    }
  };

  const saveMemory = async (preset: string, content: string, category: Category, importance: number, confidence: number, sid: string, scope: 'mode' | 'global'): Promise<string> => {
    const id = await memoryService.save({ content, category, importance, confidence, scope, preset, source_mode: preset });
    await enforceCapacity(scope, scope === 'global' ? l3Capacity : l2Capacity);
    log(`记忆已写入 preset=${preset} cat=${category} imp=${importance} scope=${scope}（${content.slice(0, 30)}…）`);
    return id;
  };

  const supersedeMemory = async (oldKey: string, preset: string, content: string, category: Category, sid: string, clash: ConflictDecision): Promise<void> => {
    const old = memories.get(oldKey);
    if (!old) return;
    const newId = await saveMemory(preset, content, category, Math.max(60, old.importance), 0.8, sid, old.scope);
    await memories.put(oldKey, { ...old, superseded_by: newId, status: 'dormant', confidence: Math.max(0, old.confidence - 0.2) });
    await auditWrite('supersede', oldKey, `被 ${newId.slice(0, 8)} 取代（${clash.type}${clash.viaLlm ? '·LLM' : '·规则'}：${clash.reason}）`);
    log(`冲突 supersede（${clash.type}${clash.viaLlm ? '·LLM' : '·规则'}）：${oldKey.slice(0, 8)} → ${newId.slice(0, 8)}（${content.slice(0, 30)}…）`);
  };

  /**
   * 分层主入口：规则层初筛——
   *  blocked → 审计拦截；skip → 丢弃；
   *  save（显式"记住/记一下"关键词）→ 直接写 L2/L3（不经 LLM）；若内容是知识型 → 同时直达知识层/worldbook；
   *  knowledge_direct（公式/定律/数学术语）→ 直达知识层（accepted）+ worldbook 桥接（不经 LLM）；
   *  pending（规则拿不准）→ 进 L1 缓冲攒批 → 80% 或攒够 minBatch → LLM 总结审核（省 token）。
   */
  const processTurn = async (sid: string, turn: CollectedTurn): Promise<void> => {
    // A3（借 Cyrene 想法）：每轮更新角色情绪（mood observer）。fire-and-forget：
    // void 掉 await，绝不阻塞本轮；出错也只记日志，不影响记忆主流程。
    void observeMood(sid, turn).catch((e) => warn(`情绪观察失败: ${(e as Error).message}`));

    const decision = decide(turn.query, turn.reply);
    switch (decision.kind) {
      case 'blocked':
        await auditWrite('blocked', undefined, `凭据拦截（${sid}）`);
        break;
      case 'knowledge_direct':
        await handleKnowledgeDirect(turn.preset, decision.content, decision.topic, sid, 'user_query');
        break;
      case 'skip':
        break;
      case 'save': {
        // 显式记忆命令 → 即时写入（规则级冲突：时间证据 + 高相似 → supersede）
        const mems = allMemories();
        const hits = bm25Search(`${turn.query} ${turn.reply}`, mems, 1);
        // 第三关：相似度判定改用有界 overlapScore（原裸 BM25 分数阈值 0.8 无量纲、随语料漂移）
        const hitRec = hits.length > 0 ? memories.get(hits[0].id) : undefined;
        const conflictHit = !!hitRec && overlapScore(`${turn.query} ${turn.reply}`, hitRec.content) >= 0.5 && hasTimeEvidence(turn.query);
        // B5 写门：user_fact（核心画像）只接收用户明确自述的事实；锁存/幻觉 → 拦截（仅审计），
        // 非第一人称自述 → 降置信保存（demote）。
        const wg: WriteGateVerdict = decision.category === 'user_fact'
          ? writeGate(turn.query, decision.content)
          : { action: 'accept', reason: '非用户事实，不经写门' };
        // L3 升级：user_fact 类显式事实 → global（跨角色稳定）
        const scope: 'mode' | 'global' = decision.category === 'user_fact' ? 'global' : 'mode';
        if (wg.action === 'drop') {
          await auditWrite('write_gate', undefined, `user_fact 被写门拦截：${wg.reason}（「${decision.content.slice(0, 30)}」）`);
          log(`写门拦截 user_fact（${sid.slice(0, 8)}）：${wg.reason}`);
          break;
        }
        const confidence = wg.action === 'demote' ? (wg.confidence ?? 0.55) : 0.9;
        const importance = wg.action === 'demote' ? Math.max(0, decision.importance - 20) : decision.importance;
        if (conflictHit && hitRec) {
          // B6 类型化冲突：先分类（preference_evolution / direct_conflict）再 supersede，类型记入审计
          const clash = await resolveConflictTyped(hitRec.content, decision.content, hitRec.category, decision.category);
          await supersedeMemory(hits[0].id, turn.preset, decision.content, decision.category, sid, clash);
        } else {
          await saveMemory(turn.preset, decision.content, decision.category, importance, confidence, sid, scope);
        }
        // 规则初筛扩展：显式命令 + 内容是知识型（如"记住 F=ma"）→ 也直达知识层/worldbook（不经 LLM）
        if (knowledgeEnabled && isStrongKnowledge(decision.content)) {
          await handleKnowledgeDirect(turn.preset, decision.content, classifyKnowledgeTopic(decision.content), sid, 'user_query');
        }
        // 喂满 L1：显式 save 轮次的完整 (query+reply) 也进采集缓冲（此前 save 绕开 L1，
        // 直存只存命令文字，图片/回复里的真正内容如课表被丢弃）。L1 → 总结层 LLM 会把
        // 整轮（含模型复述的课表）提取为记忆。触动词（/记住|记一下/）下方会触发即时总结。
        await bufferL1(sid, { sessionId: sid, query: turn.query, reply: turn.reply, preset: turn.preset, ts: turn.ts, kind: 'fact' });
        break;
      }
      case 'pending':
        await bufferL1(sid, { sessionId: sid, query: turn.query, reply: turn.reply, preset: turn.preset, ts: turn.ts, kind: 'fact' });
        break;
    }

    // 记忆触动词：当前轮含"记住/整理/总结…" → 立即总结该会话 L1 缓冲（force 跳过
    // minBatch），记忆当场落库、跨会话立即可用。空缓冲时 summarizeL1 无副作用。
    if (termTrigger.some((re) => re.test(turn.query))) {
      log(`记忆触动词「${turn.query.slice(0, 20)}」→ 触发 ${sid.slice(0, 8)} 的 L1 即时总结（跨会话可读）`);
      await summarizeL1(sid, false, true);
    }
  };

  /** 规则初筛直达：知识层（accepted，不经 LLM/评审门）+ worldbook 桥接（physicist 馆，生成文件热重载）。 */
  const handleKnowledgeDirect = async (preset: string, content: string, topic: string, sid: string, sourceKind: 'user_query'): Promise<void> => {
    const clean = (content || '').trim().replace(/\s+/g, ' ');
    if (!clean) return;
    // 知识层去重（同内容跳过）
    const dup = memoryService.knowledgeList().some(({ rec }) => rec.content === clean && rec.preset === preset);
    if (dup) {
      log(`知识层去重跳过（已存在）：${clean.slice(0, 30)}…`);
      return;
    }
    await memoryService.knowledgeAdd({ preset, content: clean, topic: topic || '物理/数学', sourceKind, sourceSession: sid, status: 'accepted' });
    log(`规则初筛直达知识层（accepted）：[${topic}] ${clean.slice(0, 40)}…`);
    if (worldbook.enabled) await writeWorldbookEntry(preset, clean, topic);
    else await auditWrite('knowledge_direct', undefined, `规则直达知识层（${topic}），worldbook 桥接关闭`);
  };

  /**
   * worldbook 桥接：写 preset 对应馆的 generated_knowledge.json（数组追加、内容哈希去重）。
   * 模态隔离：每个模态的知识只写自己馆（不跨模态）；worldbook 注入本就按 preset 选馆，
   * 未命中时靠模型本身能力回答。热重载 ≤3s 生效。
   * @param source 条目来源标注（知识直达默认「规则层生成（用户提问）」；记忆桥接传「记忆桥接 L2/L3」）
   * @returns 成功（含"已存在"幂等）返回 { id, title }；不可写/失败返回 null
   */
  const writeWorldbookEntry = async (preset: string, content: string, topic: string, source = '规则层生成（用户提问）'): Promise<{ id: string; title: string } | null> => {
    const title = topic || '物理知识';
    const dir = worldbook.libraries[preset];
    if (!dir) {
      log(`worldbook 桥接跳过（无 ${preset} 馆目录，不跨模态写入）`);
      return null;
    }
    const absDir = isAbsolute(dir) ? dir : join(process.cwd(), dir);
    const file = join(absDir, 'generated_knowledge.json');
    try {
      if (!existsSync(absDir)) {
        warn(`worldbook 馆目录不存在: ${absDir}（跳过桥接）`);
        return null;
      }
      const raw = existsSync(file) ? readFileSync(file, 'utf-8') : '[]';
      const entries = (JSON.parse(raw || '[]') as Array<Record<string, unknown>>);
      const id = `gen_${createHash('sha1').update(content).digest('hex').slice(0, 8)}`;
      if (entries.some((e) => e.id === id)) return { id, title }; // 去重：已存在，幂等返回
      entries.push({
        id,
        title,
        kind: 'knowledge',
        triggers: buildWorldbookTriggers(content, topic),
        content,
        source,
        verifiable: false,
        priority: 1,
      });
      writeFileSync(file, JSON.stringify(entries, null, 2), 'utf-8');
      log(`worldbook 生成条目 +1（馆=${preset} ${id} [${topic}] ${content.slice(0, 30)}…，热重载 ≤3s 生效）`);
      return { id, title };
    } catch (e) {
      warn(`worldbook 写入失败: ${(e as Error).message}`);
      return null;
    }
  };

  /** 生成条目的触发词：topic + 拉丁符号 + 中文 bigram（归一化后做子串匹配）。 */
  const buildWorldbookTriggers = (content: string, topic: string): string[] => {
    const out = new Set<string>();
    if (topic && topic.length >= 2) out.add(topic);
    for (const m of content.toLowerCase().match(/[a-z0-9]+/g) ?? []) if (m) out.add(m);
    const cjk = (content || '').replace(/[^\u4e00-\u9fff]/g, '');
    for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2));
    return [...out].slice(0, 6);
  };

  /** 进 L1 缓冲（域表持久化）；达到 80% 容量或 token 预算触发总结卸载。 */
  const bufferL1 = async (sid: string, turn: L1Turn): Promise<void> => {
    const count = await memoryService.l1Append(turn);
    const tokens = sessionTokens(memoryService.l1Turns(sid));
    const byCount = memoryService.l1ShouldTrigger(sid);
    const byTokens = shouldTriggerL1ByTokens(tokens, l1MaxTokens);
    log(`L1 缓冲 +1（${sid.slice(0, 8)}，${count}/${l1Capacity} 轮，~${tokens}/${l1MaxTokens} token，kind=${turn.kind}）：${turn.query.slice(0, 30)}…`);
    if (byCount || byTokens) {
      log(`L1 触发总结卸载（${byTokens ? 'token 预算' : '容量 80%'}：${count}/${l1Capacity} 轮，~${tokens}/${l1MaxTokens} token）`);
      await summarizeL1(sid, byTokens);
    }
  };

  const allMemories = (): Array<{ id: string; content: string }> => {
    return memoryService.list().map(({ key, rec }) => ({ id: key, content: rec.content }));
  };

  /** 一条记忆候选落库（规则级 consolidate：supersede / merge / save）。preset 取该会话角色。 */
  const applyMemoryCandidate = async (m: L1MemoryCandidate, preset: string, sid: string): Promise<void> => {
    // B5 写门：L1 总结出的 user_fact 候选也只接收用户明确自述的事实；否则拦截/降置信（不污染画像）。
    const wg: WriteGateVerdict = m.category === 'user_fact'
      ? writeGate(m.content, m.content)
      : { action: 'accept', reason: '非用户事实，不经写门' };
    if (wg.action === 'drop') {
      await auditWrite('write_gate', undefined, `L1 user_fact 候选被写门拦截：${wg.reason}（「${m.content.slice(0, 30)}」）`);
      log(`写门拦截 L1 user_fact（${sid.slice(0, 8)}）：${wg.reason}`);
      return;
    }
    const confidence = wg.action === 'demote' ? (wg.confidence ?? 0.55) : 0.7;
    const target = consolidateTarget(m.content, allMemories());
    if (target.action === 'supersede' && target.targetId) {
      const old = memories.get(target.targetId);
      if (old) {
        // B6 类型化冲突：分类后再 supersede，类型记入审计
        const clash = await resolveConflictTyped(old.content, m.content, old.category, m.category);
        await supersedeMemory(target.targetId, old?.preset ?? preset, m.content, m.category, sid, clash);
      }
      return;
    }
    if (target.action === 'merge' && target.targetId) {
      const old = memories.get(target.targetId);
      if (old) {
        const merged = old.content.length + m.content.length < 200 ? `${old.content}；${m.content}` : m.content;
        await memories.update(target.targetId, (cur) => ({ ...cur, content: merged, importance: Math.max(cur.importance, m.importance), last_access: Date.now() }));
        await auditWrite('merge', target.targetId, `L1 总结合并（${m.content.slice(0, 30)}…）`);
        log(`记忆合并 → ${target.targetId.slice(0, 8)}`);
        return;
      }
    }
    const importance = wg.action === 'demote' ? Math.max(0, m.importance - 20) : m.importance;
    await saveMemory(preset, m.content, m.category, importance, confidence, sid, m.scope);
  };

  /** 一条知识候选落知识层（pending 评审门）。sourceKind 区分 LLM 总结提取 / 规则兜底直录。 */
  const applyKnowledgeCandidate = async (k: L1KnowledgeCandidate, preset: string, sid: string, sourceKind: 'llm_extract' | 'user_query'): Promise<void> => {
    const content = k.content.trim().replace(/\s+/g, ' ');
    if (!content) return;
    await memoryService.knowledgeAdd({ preset, content, topic: k.topic || '物理/数学', sourceKind, sourceSession: sid });
    log(`知识层 +1（pending 评审）：[${k.topic}] ${content.slice(0, 40)}…`);
  };

  /** 会话内总结进行中标记（防并发重复卸载）。 */
  const summarizing = new Set<string>();

  /**
   * L1 总结卸载：把会话缓冲总结为记忆候选（落 L2/L3）+ 知识候选（落知识层 pending）。
   * LLM 启用且批次 ≥ minBatch → 总结层 LLM（攒批省 token）；批次不足 → 留在缓冲继续攒（持久化）；
   * forceByTokens=true（token 预算触发）时跳过 minBatch 攒批——单轮超长对话不应卡在攒批里。
   * force=true（session 结束时强制）也跳过 minBatch：会话是独立 sessionId，轮次不跨会话累积，
   * 短会话（1-2 轮）永远达不到 minBatch，"攒批留到下次"实际永不发生 → L1 无限积压。
   * LLM 未启用/无 key → 规则兜底（fallbackUnload）。
   * 完成后精确移除已总结轮次（并发新进轮次不误清）。
   */
  const summarizeL1 = async (sid: string, forceByTokens = false, force = false): Promise<void> => {
    if (summarizing.has(sid)) return;
    const turns = memoryService.l1Turns(sid);
    if (!turns.length) return;
    summarizing.add(sid);
    try {
      const preset = turns[0].preset;
      let memoriesOut: L1MemoryCandidate[] = [];
      let knowledgeOut: L1KnowledgeCandidate[] = [];
      let viaLlm = false;
      let dropped = 0;

      const apiKey = await resolveLlmKey();
      if (llm.enabled && apiKey) {
        if (turns.length < llmMinBatch && !forceByTokens && !force) {
          // 攒批：批次不足不调 LLM，留在 L1 持久化缓冲，等下次会话继续攒（省 token）
          log(`L1 攒批中（${sid.slice(0, 8)}：${turns.length}/${llmMinBatch} 轮，未达最小批次，暂不总结）`);
          return;
        }
        // 每条缓冲轮附相似记忆上下文（BM25 top-3）
        const similar = turns.flatMap((t) =>
          bm25Search(`${t.query} ${t.reply}`, allMemories(), 3).map((h) => ({ id: h.id.slice(0, 8), content: (memories.get(h.id)?.content ?? '').slice(0, 80) })),
        );
        const parsed = await callSummarizeLlm(buildSummarizePrompt(turns, similar), apiKey);
        if (parsed) {
          memoriesOut = parsed.memories ?? [];
          knowledgeOut = parsed.knowledge ?? [];
          viaLlm = true;
        }
      }
      if (!viaLlm) {
        const fb = fallbackUnload(turns);
        memoriesOut = fb.result.memories;
        knowledgeOut = fb.result.knowledge;
        dropped = fb.dropped;
      }

      for (const m of memoriesOut) await applyMemoryCandidate(m, preset, sid);
      if (knowledgeEnabled) for (const k of knowledgeOut) await applyKnowledgeCandidate(k, preset, sid, viaLlm ? 'llm_extract' : 'user_query');

      await auditWrite('l1_summarize', undefined, `${turns.length} 轮 → ${memoriesOut.length} 记忆${viaLlm ? '(LLM)' : '(规则兜底)'} + ${knowledgeEnabled ? knowledgeOut.length : 0} 知识${!viaLlm && dropped ? `，${dropped} 轮无定论丢弃` : ''}`);
      log(`L1 总结卸载完成（${sid.slice(0, 8)}）：${turns.length} 轮 → ${memoriesOut.length} 记忆 + ${knowledgeOut.length} 知识（${viaLlm ? 'LLM' : '规则兜底'}）`);
      await memoryService.l1Remove(sid, turns);
    } catch (e) {
      await auditWrite('l1_error', undefined, `L1 总结失败: ${(e as Error).message}`);
      warn(`L1 总结失败（${sid.slice(0, 8)}）: ${(e as Error).message}`);
    } finally {
      summarizing.delete(sid);
    }
  };

  /**
   * 陈旧 L1 兜底卸载：攒批（未达 minBatch）且长期未更新的会话，规则兜底卸载并清空
   * ——防 LLM 攒批模式下 l1 域表行随废弃会话无限累积（session/flush 在批次不足时
   * 会 early return 保留缓冲）。
   */
  const flushStaleL1 = async (sid: string, reason: string): Promise<void> => {
    if (summarizing.has(sid)) return;
    const turns = memoryService.l1Turns(sid);
    if (!turns.length) return;
    summarizing.add(sid);
    try {
      const preset = turns[0].preset;
      const fb = fallbackUnload(turns);
      for (const m of fb.result.memories) await applyMemoryCandidate(m, preset, sid);
      if (knowledgeEnabled) for (const k of fb.result.knowledge) await applyKnowledgeCandidate(k, preset, sid, 'user_query');
      await auditWrite('l1_stale_flush', undefined, `${turns.length} 轮陈旧缓冲规则兜底卸载（${reason}）`);
      log(`L1 陈旧兜底卸载（${sid.slice(0, 8)}，${reason}）：${turns.length} 轮 → ${fb.result.memories.length} 记忆 + ${fb.result.knowledge.length} 知识`);
      await memoryService.l1Remove(sid, turns);
    } catch (e) {
      await auditWrite('l1_error', undefined, `L1 陈旧卸载失败: ${(e as Error).message}`);
      warn(`L1 陈旧卸载失败（${sid.slice(0, 8)}）: ${(e as Error).message}`);
    } finally {
      summarizing.delete(sid);
    }
  };

  const resolveLlmKey = async (): Promise<string> => {
    if (llm.apiKey) return llm.apiKey;
    try {
      const resolved = await ctx.credentials?.resolve(credentialRef('DEEPSEEK_API_KEY'));
      return resolved?.value ?? '';
    } catch {
      return '';
    }
  };

  /** 调总结层 LLM，返回 {memories, knowledge}；失败/解析失败返回 null（走规则兜底）。 */
  const callSummarizeLlm = async (prompt: string, apiKey: string): Promise<{ memories: L1MemoryCandidate[]; knowledge: L1KnowledgeCandidate[] } | null> => {
    try {
      const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          max_tokens: 1536,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(text) as { memories?: L1MemoryCandidate[]; knowledge?: L1KnowledgeCandidate[] };
      return { memories: parsed.memories ?? [], knowledge: parsed.knowledge ?? [] };
    } catch (e) {
      warn(`总结层 LLM 调用失败: ${(e as Error).message}`);
      return null;
    }
  };

  /**
   * B6 类型化冲突判定：LLM 启用且有 key 时可选经由 LLM 分类（preference_evolution /
   * direct_conflict）；否则/失败时退回 deterministic classifyConflict（规则兜底，测试稳定）。
   */
  const resolveConflictTyped = async (oldContent: string, newContent: string, oldCategory: Category, newCategory: Category): Promise<ConflictDecision> => {
    const apiKey = await resolveLlmKey();
    if (llm.enabled && apiKey) {
      const label = await callConflictLlm(oldContent, newContent, oldCategory, newCategory, apiKey);
      if (label) return { type: label.type, reason: label.reason, viaLlm: true };
    }
    return classifyConflict(oldContent, newContent, oldCategory, newCategory);
  };

  /** 调 LLM 做冲突类型判定（B6 可选 LLM 通道）；失败/解析失败返回 null（走规则兜底）。 */
  const callConflictLlm = async (oldContent: string, newContent: string, oldCategory: Category, newCategory: Category, apiKey: string): Promise<ConflictDecision | null> => {
    try {
      const prompt = `记忆冲突判定。旧记忆（${oldCategory}）：「${oldContent.slice(0, 120)}」；新记忆（${newCategory}）：「${newContent.slice(0, 120)}」。请仅输出 JSON {"type":"preference_evolution"|"direct_conflict","reason":"简短原因"}。preference_evolution=用户改变了偏好（新值生效）；direct_conflict=矛盾/被取代的事实（新值生效）。`;
      const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          max_tokens: 200,
          temperature: 0.0,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(text) as { type?: ConflictType; reason?: string };
      if (parsed.type !== 'preference_evolution' && parsed.type !== 'direct_conflict') return null;
      return { type: parsed.type, reason: parsed.reason ?? 'LLM 判定', viaLlm: true };
    } catch (e) {
      warn(`冲突判定 LLM 调用失败（走规则兜底）: ${(e as Error).message}`);
      return null;
    }
  };

  // ---- A3 mood observer（借 Cyrene 桌面伴侣想法：小模型读对话标角色情绪 +
  // 平滑 + 存关系日志；只取思想不复制代码） ----
  /** 调小模型给角色当前情绪打标签（仅在本轮表情观察时、llm.enabled && apiKey 时）。 */
  const callMoodLlm = async (query: string, reply: string, apiKey: string, personaHint: string): Promise<string | null> => {
    try {
      const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: 'user', content: moodClassifierPrompt(query, reply, personaHint) }],
          max_tokens: 16,
          temperature: 0.0,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
      const label = (data.choices?.[0]?.message?.content ?? '').trim().replace(/[\s。.!！，,]+$/g, '');
      return label || null;
    } catch (e) {
      warn(`情绪观察 LLM 调用失败（走规则兜底）: ${(e as Error).message}`);
      return null;
    }
  };

  /**
   * 情绪观察器：给定一轮 (query, reply)，分类角色当前情绪并平滑后写入关系表。
   * LLM 启用且有 key 时优先走 LLM（失败/无 key → 确定性规则兜底 classifyMoodStable）；
   * 平滑用近 MOOD_WINDOW_CAP 轮观测的多数表决（majorityLabel），避免单轮跳变。
   */
  const observeMood = async (sid: string, turn: CollectedTurn): Promise<void> => {
    if (!runtime.enabled) return;
    const preset = turn.preset || config.defaultPreset || 'default';
    // 直接读表（不走 service 的 relationshipGet，避免关键名差异；二者同源）
    const stored = relationship.get(preset);
    const apiKey = await resolveLlmKey();
    let label: string;
    if (llm.enabled && apiKey) {
      const llmLabel = await callMoodLlm(turn.query, turn.reply, apiKey, preset);
      label = llmLabel && llmLabel.trim() ? llmLabel.trim() : classifyMoodStable(turn.query, turn.reply);
    } else {
      label = classifyMoodStable(turn.query, turn.reply);
    }
    // 平滑：seed 窗口用已存情绪（跨重启连续），再推入新标签，多数表决
    const window = pushMoodWindow(moodWindow.get(preset) ?? (stored?.mood ? [stored.mood] : []), label);
    const mood = majorityLabel(window);
    moodWindow.set(preset, window);
    trimMoodWindow();
    const rec: RelationshipRecord = {
      mood,
      moodTs: Date.now(),
      signal: relationshipSignalOf(mood),
      preference: stored?.preference ?? '',
      nextCareCue: nextCareCueOf(mood),
      updatedTs: Date.now(),
    };
    await relationship.put(preset, rec);
    log(`情绪观察 preset=${preset} → ${mood}（本轮${label}，${window.length}/${MOOD_WINDOW_CAP} 窗）`);
  };

  // ---- 召回注入（agent/pre-step，form='recall'） ----
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    if (!runtime.enabled) return decision;

    const preset = resolveSessionPreset(payload.agent.session as never) ?? config.defaultPreset;
    if (!preset) return decision;

    // 第三关：召回注入只在每轮第一步（step===1）执行。dsh-agent-loop 会把每次
    // pre-step 注入的消息 append 进会话历史，并被后续每个 step 的 LLM 请求整体
    // 包含——若每个 step 都注入同一份召回块，多 step 解题流程（compute_verify
    // 等工具循环）上下文会随 step 数线性膨胀。
    if (payload.step !== 1) return decision;

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

  // ---- session/flush：L1 缓冲总结卸载 ----
  // 2026-08-17 修复：dsh 的 session/flush 是"每请求持久化检查点"，回合进行中会触发多次；
  // 原实现在这里 turnBuffer.delete(sid) + clearScratch(sid) 会把进行中的轮次直接清掉
  // （user/message 已缓冲 → flush 清空 → assistant/message 找不到 → 记忆永不保存）。
  // flush 只做 L1 总结卸载（minBatch/80% 守卫，幂等）；真正的会话级残留清理移到 session/disposed。
  ctx.on('session/flush', async (session) => {
    const sid = session.id;
    if (memoryService.l1Count(sid) > 0) {
      log(`session/flush：${sid.slice(0, 8)} 有 ${memoryService.l1Count(sid)} 轮 L1 缓冲，触发总结卸载`);
      await summarizeL1(sid);
    }
  });
  // ---- session/disposed：真正会话结束 → 强制总结 L1 + 清理缓冲/scratch ----
  // 会话结束才做强制总结（force=true 跳过 minBatch）：会话是独立 sessionId，轮次不跨会话
  // 累积，短会话（1-2 轮）永远达不到 minBatch——session/flush 的"攒批留到下次"对短会话
  // 实际永不发生，会导致 L1 无限积压（用户曾见 53 轮未清）。会话真正结束时强制落库清空。
  ctx.on('session/disposed', (session) => {
    turnBuffer.delete(session.id);
    memoryService.clearScratch(session.id);
    if (memoryService.l1Count(session.id) > 0) {
      void summarizeL1(session.id, false, true).catch((e) => warn(`L1 会话结束总结失败: ${(e as Error).message}`));
    }
  });
  log('session/flush 已接入（L1 缓冲总结卸载）；session/disposed 已接入（强制总结 + 残留清理）');

  // ---- 启动清理：一次性规则兜底清空历史积压 L1 ----
  // 历史短会话攒批永不达标而积压的轮次（进程重启前产生的）；规则兜底只落规则识别的
  // 记忆（计划/身份/知识类），其余丢弃，不调 LLM。此后正常会话经 session/disposed 即时总结。
  for (const sid of memoryService.l1Sessions()) {
    void flushStaleL1(sid, '启动积压清理');
  }

  // ---- 衰减（宿主级定时）+ 沉淀 + L1 陈旧清理 ----
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
    // L1 陈旧缓冲清理：最后轮次超过 14 天未更新的会话 → 规则兜底卸载并清空
    const STALE_L1_DAYS = 14;
    const staleCutoff = now - STALE_L1_DAYS * 24 * 3600 * 1000;
    for (const sid of memoryService.l1Sessions()) {
      const turns = memoryService.l1Turns(sid);
      // 用 reduce 而非 Math.max(...spread)：极端情况（攒批模式下超长缓冲）下
      // spread 超过 ~10 万元素会抛 RangeError，reduce 无此上限
      const lastTs = turns.length ? turns.reduce((m, t) => (t.ts > m ? t.ts : m), 0) : 0;
      if (lastTs > 0 && lastTs < staleCutoff) {
        void flushStaleL1(sid, `最后更新 ${Math.round((now - lastTs) / 86400000)} 天前`);
      }
    }
    // 陈旧行硬清理：dormant（衰减/supersede）或已删（容量淘汰/用户删除）的行
    // 距上次访问超过宽限期（decayDays + 30 天）后彻底删除——这些行不再参与召回，
    // 只占存储并拖慢 list/stats/检索与每 6h 遍历（此前的实现让它们永久驻留）。
    // 例外保护：user_fact 且未被取代的保留（画像沉淀每轮已抄录其要点，但此处
    // 不删原始行以防画像截断丢失细节）。
    const PURGE_GRACE_DAYS = 30;
    const purgeCutoff = now - (decayDays + PURGE_GRACE_DAYS) * 24 * 3600 * 1000;
    for (const [key, rec] of memories.entries()) {
      if (rec.last_access >= purgeCutoff) continue;
      const isGarbage = rec.deleted === true || (rec.status === 'dormant' && !(rec.category === 'user_fact' && !rec.superseded_by));
      if (!isGarbage) continue;
      void memories
        .delete(key)
        .then(() => auditWrite('purge_dormant', key, `陈旧行清理（status=${rec.status} deleted=${!!rec.deleted}，距上次访问 ${Math.round((now - rec.last_access) / 86400000)} 天）`))
        .catch(() => undefined);
    }
    void promoteProfileFacts();
  }, 6 * 3600 * 1000);
  if (decayTimer.unref) decayTimer.unref();
  log(`衰减已启用（${decayDays} 天未访问 -10 importance，每 6h 检查）`);

  // ---- /memory 命令 ----
  ctx.commands.register({
    name: 'memory',
    description: '记忆管理：list / stats / delete <id> / profile / scratch / l1 / knowledge',
    input: { hint: 'list | stats | delete <id> | profile | scratch <sessionId> | l1 | knowledge [pending|accept <id>|reject <id>]' },
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
      if (cmd === 'l1') {
        const cap = memoryService.l1CapacityOf();
        const sessions = memoryService.l1Sessions();
        if (!sessions.length) return ok(`L1 缓冲（容量 ${cap.capacity}，阈值 ${Math.round(cap.threshold * 100)}%）当前为空`);
        const lines = sessions.flatMap((sid) =>
          memoryService.l1Turns(sid).map((t, i) => `- ${sid.slice(0, 8)}#${i} ${describeL1Turn(t)}`),
        );
        return ok(`L1 缓冲（容量 ${cap.capacity}，阈值 ${Math.round(cap.threshold * 100)}%，${memoryService.stats().l1} 轮）:\n${lines.join('\n')}`);
      }
      if (cmd === 'knowledge') {
        const sub = args[1] || 'list';
        const items = memoryService.knowledgeList();
        if (sub === 'accept' && args[2]) {
          return ok((await memoryService.knowledgeSetStatus(args[2], 'accepted')) ? `已接受 ${args[2]}` : `未找到 ${args[2]}`);
        }
        if (sub === 'reject' && args[2]) {
          return ok((await memoryService.knowledgeSetStatus(args[2], 'rejected')) ? `已拒绝 ${args[2]}` : `未找到 ${args[2]}`);
        }
        const STATUSES = ['pending', 'accepted', 'rejected'];
        const byStatus = STATUSES.includes(sub);
        const byPreset = !byStatus && sub !== 'list' && sub !== 'all';
        const filtered = items.filter(({ rec }) => (byStatus ? rec.status === sub : byPreset ? rec.preset === sub : true));
        const lines = filtered.map(({ key, rec }) => `- ${key.slice(0, 8)} [${rec.preset}|${rec.status}|${rec.source_kind}] ${rec.topic ? `〈${rec.topic}〉` : ''}${rec.content.slice(0, 60)}`);
        return ok(`知识层（${filtered.length}/${items.length} 条${byPreset ? `，馆=${sub}` : ''}）:\n${lines.join('\n') || '（空）'}`);
      }
      if (cmd === 'stats') {
        const s = memoryService.stats();
        return ok(
          `记忆统计：active=${s.active} dormant=${s.dormant} 按角色=${Object.entries(s.byPreset).map(([k, v]) => `${k}:${v}`).join(' ')} 按层=${Object.entries(s.byScope).map(([k, v]) => `${k}:${v}`).join(' ')} L1缓冲=${s.l1} 知识层=${Object.entries(s.knowledge).map(([k, v]) => `${k}:${v}`).join(' ')}`,
        );
      }
      return ok('用法: /memory list | stats | delete <id> | profile | scratch <sessionId> | l1 | knowledge [pending|accept <id>|reject <id>]');
    },
  });
  log('/memory 命令已注册（list/stats/delete/profile/scratch/l1/knowledge）');

  // ---- HTTP 管理端点（可选，仅回环 + token 认证；S5 加固）----
  if (adminHttp.enabled) {
    try {
      // 访问 token：配置未给则自动生成（uuid 随机），启动时打印一次供本地脚本使用
      const adminToken = adminHttp.token ?? randomUUID();
      const MAX_ADMIN_BODY = 1024 * 1024; // 1MB body 上限（防内存耗尽）

      /** 读 JSON body，超过 1MB 直接拒绝（S5：原实现 body += c 无上限）。 */
      const readJsonLimited = (req: IncomingMessage): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          let body = '';
          let done = false;
          const fail = (code: number, msg: string): void => {
            if (done) return;
            done = true;
            const err = new Error(msg) as Error & { status?: number };
            err.status = code;
            reject(err);
          };
          req.on('data', (c) => {
            if (done) return;
            body += c;
            if (body.length > MAX_ADMIN_BODY) {
              fail(413, 'body too large (max 1MB)');
              req.destroy();
            }
          });
          req.on('end', () => {
            if (done) return;
            done = true;
            try {
              resolve(JSON.parse(body || '{}') as Record<string, unknown>);
            } catch (e) {
              reject(e);
            }
          });
          req.on('error', (e) => fail(400, (e as Error).message));
        });

      const server = createServer((req, res) => {
        const send = (code: number, obj: unknown): void => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(obj));
        };
        // 认证：所有端点均需 Bearer token 或 x-aemeath-token 头（S5）
        const authHeader = req.headers.authorization ?? '';
        const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
        const altToken = String(req.headers['x-aemeath-token'] ?? '');
        if (bearer !== adminToken && altToken !== adminToken) {
          send(401, { ok: false, error: 'unauthorized: missing or invalid token' });
          return;
        }
        void (async () => {
          try {
            // 精确路径匹配（S5：原实现用 url.startsWith 前缀匹配 + GET 也能触发删除语义）
            const url = (req.url ?? '').split('?')[0];
            if (url === '/memory/list') {
              if (req.method !== 'GET') return send(405, { ok: false, error: 'method not allowed: GET' });
              return send(200, { ok: true, items: memoryService.list().map(({ rec }) => ({ ...rec })) });
            }
            if (url === '/memory/stats') {
              if (req.method !== 'GET') return send(405, { ok: false, error: 'method not allowed: GET' });
              return send(200, { ok: true, stats: memoryService.stats(), profile: profile.get() });
            }
            if (url === '/memory/knowledge') {
              if (req.method !== 'GET') return send(405, { ok: false, error: 'method not allowed: GET' });
              return send(200, { ok: true, items: memoryService.knowledgeList().map(({ rec }) => ({ ...rec })) });
            }
            if (url === '/memory/l1') {
              if (req.method !== 'GET') return send(405, { ok: false, error: 'method not allowed: GET' });
              return send(200, { ok: true, stats: memoryService.stats(), capacity: memoryService.l1CapacityOf(), sessions: Object.fromEntries(memoryService.l1Sessions().map((sid) => [sid, memoryService.l1Turns(sid).map((t) => ({ ...t }))])) });
            }
            if (url === '/memory/delete') {
              if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed: POST' });
              const payload = await readJsonLimited(req);
              const prefix = payload.idPrefix;
              if (typeof prefix !== 'string' || !prefix) return send(400, { ok: false, error: 'idPrefix required' });
              return send(200, { ok: (await memoryService.softDelete(prefix)) > 0 });
            }
            if (url === '/memory/knowledge/status') {
              if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed: POST' });
              const payload = await readJsonLimited(req);
              const prefix = payload.idPrefix;
              const status = payload.status;
              if (typeof prefix !== 'string' || !prefix) return send(400, { ok: false, error: 'idPrefix required' });
              if (status !== 'accepted' && status !== 'rejected') return send(400, { ok: false, error: 'status must be accepted|rejected' });
              return send(200, { ok: await memoryService.knowledgeSetStatus(prefix, status) });
            }
            if (url === '/memory/toWorldbook') {
              // 纯手动桥接：把一条 L2/L3 记忆写入世界书生成文件（与 /aemeath/api/memory 同源，token 认证）
              if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed: POST' });
              const payload = await readJsonLimited(req);
              const id = payload.id;
              if (typeof id !== 'string' || !id) return send(400, { ok: false, error: 'id required' });
              const library = typeof payload.library === 'string' ? payload.library : undefined;
              const topic = typeof payload.topic === 'string' ? payload.topic : undefined;
              const r = await memoryService.toWorldbook(id, { library, topic });
              if (!r.ok) return send(400, { ok: false, error: r.error });
              return send(200, { ok: true, id: r.id, title: r.title });
            }
            return send(404, { ok: false, error: 'not found: use /memory/list | /memory/stats | /memory/delete | /memory/knowledge | /memory/knowledge/status | /memory/toWorldbook | /memory/l1' });
          } catch (e) {
            const err = e as Error & { status?: number };
            send(err.status ?? 400, { ok: false, error: err.message });
          }
        })();
      });
      server.listen(adminHttp.port, '127.0.0.1');
      ctx.effect(() => () => {
        server.close();
      });
      if (!adminHttp.token) log(`HTTP 管理端点已启动（http://127.0.0.1:${adminHttp.port}/memory/*，仅回环 + token 认证，自动生成 token=${adminToken}）`);
      else log(`HTTP 管理端点已启动（http://127.0.0.1:${adminHttp.port}/memory/*，仅回环 + token 认证，token 来自配置）`);
    } catch (e) {
      warn(`HTTP 管理端点启动失败: ${(e as Error).message}`);
    }
  }
}
