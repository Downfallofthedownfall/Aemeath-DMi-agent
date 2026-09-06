// ============================================================
// service.ts — ctx.memory 服务（M3 v3 · M3.4 分层）
// 对外暴露：search / list / save / softDelete / stats / scratch（L1 暂存）
//           l1（分层采集缓冲）/ knowledge（知识层，pending 评审门）
// 供：pre-step 召回注入、/memory 命令、HTTP 管理端点、M5 记忆面板、其他插件
// 生命周期：Service 构造时 super(ctx, 'memory') 即注册，随插件 fiber 自动注销
// ============================================================

import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { KvTable } from '@deepseek-ai/dsh-storage-domain';
import { search as bm25Search } from './bm25.js';
import { appendL1, removeL1Turns, shouldTriggerL1 } from './layers.js';
import { buildRelationshipCue } from './mood.js';
import { computeActivation, activationOf, ACTIVATION_DEFAULT, type LifecycleStatus } from './engine.js';
import type { MemoryRecord, AuditRecord, KnowledgeRecord, UserProfile, RelationshipRecord, Category, L1Turn } from './types.js';

export interface MemoryServiceDeps {
  memories: KvTable<string, MemoryRecord>;
  audit: KvTable<string, AuditRecord>;
  knowledge: KvTable<string, KnowledgeRecord>;
  l1: KvTable<string, L1Turn[]>;
  /** 关系/情绪上下文存储（A3/A4，按 preset 各存一份）。 */
  relationship: KvTable<string, RelationshipRecord>;
  profile: { get(): UserProfile; set(v: UserProfile): Promise<void> };
  auditWrite(action: string, memoryId: string | undefined, detail: string): Promise<void>;
  /**
   * （可选）L2/L3 记忆 → worldbook 桥接写入。由 index.ts 注入（复用其
   * writeWorldbookEntry：写 preset 馆的 generated_knowledge.json，内容哈希去重）。
   * 返回 null 表示该馆不可写/目标不存在（跳过）；返回 { id, title } 表示成功（含"已存在"幂等）。
   */
  writeWorldbook?: (input: { preset: string; content: string; topic: string; source: string }) => Promise<{ id: string; title: string } | null>;
}

export interface MemorySearchResult {
  id: string;
  scope: 'mode' | 'global';
  preset: string;
  content: string;
  category: Category;
  importance: number;
  activation: number;
  status: LifecycleStatus;
}

export interface MemorySaveInput {
  content: string;
  category?: Category;
  importance?: number;
  confidence?: number;
  scope?: 'mode' | 'global';
  preset: string;
  source_mode?: string;
}

export class MemoryService extends Service {
  private readonly deps: MemoryServiceDeps;
  /** L1 工作缓存：会话内任务暂存区（scratch），内存态，随进程存活。 */
  private readonly scratchMap = new Map<string, Record<string, string>>();
  /** L1 分层采集缓冲：持久化在域表（攒批省 token：未达最小批次跨会话继续攒）。 */
  private readonly l1Capacity: number;
  private readonly l1Threshold: number;

  constructor(ctx: Context, deps: MemoryServiceDeps, l1Options: { capacity?: number; threshold?: number } = {}) {
    super(ctx, 'memory');
    this.deps = deps;
    this.l1Capacity = l1Options.capacity ?? 40;
    this.l1Threshold = l1Options.threshold ?? 0.8;
  }

  private allActive(): Array<{ key: string; rec: MemoryRecord }> {
    const out: Array<{ key: string; rec: MemoryRecord }> = [];
    for (const [key, rec] of this.deps.memories.entries()) {
      if (rec.deleted) continue;
      out.push({ key, rec });
    }
    return out;
  }

  /** 检索记忆（BM25 优先，退回 importance 排序）。第三关：带 query 时也应用 preset 过滤（原实现只在不带 query 分支过滤）。 */
  search(query: string, opts: { preset?: string; topK?: number } = {}): MemorySearchResult[] {
    const all = this.allActive();
    const candidates = opts.preset ? all.filter(({ rec }) => rec.preset === opts.preset) : all;
    if (query) {
      const hits = bm25Search(query, candidates.map(({ key, rec }) => ({ id: key, content: rec.content })), opts.topK ?? 5);
      const hitIds = new Map(hits.map((h) => [h.id, h]));
      return hits
        .map((h) => {
          const hit = hitIds.get(h.id);
          const found = hit ? candidates.find((a) => a.key === h.id) : undefined;
          return found ? toResult(found.key, found.rec) : undefined;
        })
        .filter((x): x is MemorySearchResult => !!x);
    }
    return candidates
      .sort((a, b) => b.rec.importance - a.rec.importance)
      .slice(0, opts.topK ?? 5)
      .map(({ key, rec }) => toResult(key, rec));
  }

  /**
   * 按 preset 召回（L2 mode + L3 global），供 pre-step 注入。
   * 借 Cyrene：按激活值降序（高激活优先），池含 active + archived——
   * archived（未超期归档）也参与召回并被"唤醒"回 active（由调用方写回激活/状态）。
   * dormant 不参与召回（保持原语义）。
   */
  recallForPreset(preset: string, topK: number): Array<{ key: string; rec: MemoryRecord }> {
    const now = Date.now();
    return this.allActive()
      .filter(({ rec }) => (rec.status === 'active' || rec.status === 'archived') && (rec.scope === 'global' || rec.preset === preset))
      .sort((a, b) => actOf(b.rec, now) - actOf(a.rec, now) || b.rec.importance - a.rec.importance)
      .slice(0, topK);
  }

  /** 列出全部未删除记忆（供 /memory 命令与面板）。 */
  list(): Array<{ key: string; rec: MemoryRecord }> {
    return this.allActive();
  }

  /** 写入一条记忆（守门员已判定后调用；scope 支持 mode/global）。 */
  async save(input: MemorySaveInput): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    const importance = input.importance ?? 50;
    // 借 Cyrene：新记忆激活值按现有信号现算（importance intrinsic + 满近因），缺省 50 兜底
    const activation = computeActivation({ importance, lastAccess: now, now });
    const rec: MemoryRecord = {
      id,
      scope: input.scope ?? 'mode',
      preset: input.preset,
      content: input.content,
      category: input.category ?? 'session_summary',
      importance,
      confidence: input.confidence ?? 0.7,
      source_mode: input.source_mode ?? input.preset,
      created_at: now,
      last_access: now,
      activation,
      status: 'active',
    };
    await this.deps.memories.put(id, rec);
    await this.deps.auditWrite('save', id, `importance=${rec.importance} category=${rec.category} scope=${rec.scope}`);
    return id;
  }

  /**
   * 软删（可撤销；审计留痕）。C17：前缀可能碰撞（id 前 8 位相同）——
   * 删除所有匹配该前缀的记忆，返回删除条数（避免只删第一条命中导致删错行）。
   */
  async softDelete(idPrefix: string): Promise<number> {
    const matches = this.allActive().filter(({ key }) => key.startsWith(idPrefix));
    if (!matches.length) return 0;
    for (const { key, rec } of matches) {
      await this.deps.memories.put(key, { ...rec, deleted: true });
      await this.deps.auditWrite('soft_delete', key, '用户删除');
    }
    return matches.length;
  }

  /** 统计（/memory stats 与面板）。 */
  stats(): { active: number; dormant: number; archived: number; byPreset: Record<string, number>; byScope: Record<string, number>; l1: number; knowledge: Record<string, number> } {
    const out = { active: 0, dormant: 0, archived: 0, byPreset: {} as Record<string, number>, byScope: {} as Record<string, number>, l1: 0, knowledge: { pending: 0, accepted: 0, rejected: 0 } };
    for (const { rec } of this.allActive()) {
      if (rec.status === 'active') out.active++;
      else if (rec.status === 'archived') out.archived++;
      else out.dormant++;
      out.byPreset[rec.preset] = (out.byPreset[rec.preset] ?? 0) + 1;
      out.byScope[rec.scope] = (out.byScope[rec.scope] ?? 0) + 1;
    }
    for (const [, turns] of this.deps.l1.entries()) out.l1 += turns.length;
    for (const [, rec] of this.deps.knowledge.entries()) {
      out.knowledge[rec.status] = (out.knowledge[rec.status] ?? 0) + 1;
    }
    return out;
  }

  // ===== L1 分层采集缓冲（工作区 → 80% 阈值 / 攒批达标 → 总结卸载 → L2/L3） =====
  /** 追加一轮（封顶丢弃最旧；域表持久化），返回当前缓冲长度。 */
  async l1Append(turn: L1Turn): Promise<number> {
    const cur = this.deps.l1.get(turn.sessionId) ?? [];
    const next = appendL1(cur, turn, this.l1Capacity);
    await this.deps.l1.put(turn.sessionId, next);
    return next.length;
  }

  l1Count(sessionId: string): number {
    return (this.deps.l1.get(sessionId) ?? []).length;
  }

  l1ShouldTrigger(sessionId: string): boolean {
    return shouldTriggerL1(this.l1Count(sessionId), this.l1Capacity, this.l1Threshold);
  }

  l1Turns(sessionId: string): L1Turn[] {
    return [...(this.deps.l1.get(sessionId) ?? [])];
  }

  /** 精确移除某批轮次（总结并发保护）；空则删整条。 */
  async l1Remove(sessionId: string, toRemove: readonly L1Turn[]): Promise<void> {
    const cur = this.deps.l1.get(sessionId);
    if (!cur) return;
    const next = removeL1Turns(cur, toRemove);
    if (next.length) await this.deps.l1.put(sessionId, next);
    else await this.deps.l1.delete(sessionId);
  }

  async l1Clear(sessionId: string): Promise<void> {
    await this.deps.l1.delete(sessionId);
  }

  /** 全部有缓冲的会话（session/flush 遍历用）。 */
  l1Sessions(): string[] {
    return [...this.deps.l1.keys()].filter((sid) => this.l1Count(sid) > 0);
  }

  l1CapacityOf(): { capacity: number; threshold: number } {
    return { capacity: this.l1Capacity, threshold: this.l1Threshold };
  }

  // ===== 知识层（知识路由写入目标；规则初筛直达 accepted / LLM 审核 pending） =====
  knowledgeList(): Array<{ key: string; rec: KnowledgeRecord }> {
    return [...this.deps.knowledge.entries()]
      .map(([key, rec]) => ({ key, rec }))
      .sort((a, b) => b.rec.created_at - a.rec.created_at);
  }

  async knowledgeAdd(input: { preset: string; content: string; topic: string; sourceKind: 'user_query' | 'llm_extract'; sourceSession: string; status?: 'pending' | 'accepted' }): Promise<string> {
    const id = randomUUID();
    const rec: KnowledgeRecord = {
      id,
      preset: input.preset,
      content: input.content,
      topic: input.topic,
      source_kind: input.sourceKind,
      status: input.status ?? 'pending',
      created_at: Date.now(),
      source_session: input.sourceSession,
    };
    await this.deps.knowledge.put(id, rec);
    await this.deps.auditWrite('knowledge_add', id, `topic=${input.topic} source=${input.sourceKind} status=${rec.status}`);
    return id;
  }

  async knowledgeSetStatus(idPrefix: string, status: 'accepted' | 'rejected'): Promise<boolean> {
    const found = this.knowledgeList().find(({ key }) => key.startsWith(idPrefix));
    if (!found) return false;
    await this.deps.knowledge.update(found.key, (cur) => ({ ...cur, status }));
    await this.deps.auditWrite(`knowledge_${status}`, found.key, `评审：${status}`);
    return true;
  }

  // ===== L2/L3 记忆 → worldbook（纯手动桥接，前端确认后调用） =====
  /**
   * 把一条 L2/L3 记忆提升为世界书条目（写 preset 馆的 generated_knowledge.json）。
   * 纯手动：仅在用户显式确认（前端按钮/弹窗）后调用，绝不自动触发。
   * library 缺省取记忆的 preset（馆）；topic 缺省为空（由写入方按内容推导）。
   * 返回 { ok, id, title }；worldbook 不可写（无依赖/无馆目录/失败）时返回 { ok:false, error }。
   */
  async toWorldbook(memoryId: string, opts: { library?: string; topic?: string } = {}): Promise<{ ok: boolean; id?: string; title?: string; error?: string }> {
    const writer = this.deps.writeWorldbook;
    if (!writer) return { ok: false, error: 'worldbook write unavailable' };
    const found = this.allActive().find(({ key }) => key === memoryId);
    if (!found) return { ok: false, error: 'memory not found' };
    const rec = found.rec;
    const library = opts.library ?? rec.preset;
    const topic = opts.topic ?? '';
    if (!rec.content.trim()) return { ok: false, error: 'empty memory content' };
    try {
      const entry = await writer({ preset: library, content: rec.content, topic, source: `记忆桥接（${rec.scope === 'global' ? 'L3' : 'L2'}）` });
      if (!entry) return { ok: false, error: `worldbook write skipped（馆 ${library} 不可写或目标不存在）` };
      await this.deps.auditWrite('to_worldbook', found.key, `L${rec.scope === 'global' ? '3' : '2'} 记忆 → worldbook（${entry.id}）`);
      return { ok: true, id: entry.id, title: entry.title };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ===== 关系/情绪 context（A3 mood observer + A4 relationship cue，借 Cyrene 想法） =====
  /**
   * 读取某 preset（角色/人格）的关系/情绪记录。未写入返回 undefined。
   * key 缺省 'default'（无 preset 时的兜底键）。
   */
  relationshipGet(preset?: string): RelationshipRecord | undefined {
    const key = preset && preset.trim() ? preset : 'default';
    return this.deps.relationship.get(key);
  }

  /** 写入某 preset 的关系/情绪记录。 */
  async relationshipSet(preset: string, rec: RelationshipRecord): Promise<void> {
    const key = preset && preset.trim() ? preset : 'default';
    await this.deps.relationship.put(key, rec);
  }

  /**
   * 生成【近期关系线索】注入块文本（A4）。从存储的 mood/signal/preference/
   * nextCareCue 组块；无内容（或未写入）→ ''。供人格插件经 ctx.memory 读取。
   */
  recallRelationshipCue(preset?: string): string {
    return buildRelationshipCue(this.relationshipGet(preset));
  }

  // ===== L1 暂存区（scratch，会话内工作态） =====
  getScratch(sessionId: string, key: string): string | undefined {
    return this.scratchMap.get(sessionId)?.[key];
  }

  setScratch(sessionId: string, key: string, value: string): void {
    const slot = this.scratchMap.get(sessionId) ?? {};
    slot[key] = value;
    this.scratchMap.set(sessionId, slot);
  }

  clearScratch(sessionId: string): void {
    this.scratchMap.delete(sessionId);
  }

  scratchKeys(sessionId: string): string[] {
    return Object.keys(this.scratchMap.get(sessionId) ?? {});
  }

  /** 全量 scratch 快照（M5 记忆面板 L1 展示用）：sessionId → {key → value}。 */
  allScratch(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [sid, slot] of this.scratchMap) {
      if (slot && Object.keys(slot).length > 0) out[sid] = { ...slot };
    }
    return out;
  }
}

function actOf(rec: MemoryRecord, now: number): number {
  return activationOf({ importance: rec.importance, lastAccess: rec.last_access, activation: rec.activation }, now);
}

function toResult(key: string, rec: MemoryRecord): MemorySearchResult {
  return {
    id: key,
    scope: rec.scope,
    preset: rec.preset,
    content: rec.content,
    category: rec.category,
    importance: rec.importance,
    activation: rec.activation ?? ACTIVATION_DEFAULT,
    status: rec.status,
  };
}
