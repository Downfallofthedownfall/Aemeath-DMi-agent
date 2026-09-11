// ============================================================
// insights.ts — autoDream 空闲整合 + LLM 输出抢救解析（T3/T6：借
// ripples-of-aion 的 autoDream / parseIntegrationOutput 思想）
//
// 借了什么思想：
//   ① 空闲时对**已有记忆**做一次跨记忆整合，产出「主题簇」与「疑似矛盾」两类
//      **洞察**，写入**独立存储**；洞察只存 recordIds + label/note，**绝不复制
//      content、绝不改写原记忆**。
//   ② 主题簇 = 实体连通分量（并查集），**排除枢纽实体**（如"用户"出现太频繁，
//      一次 union 会把全库并成一簇）；再用质心余弦剪枝去掉离群成员。
//   ③ 候选矛盾对 = 同实体共现对 ∪ 簇内对，按热度降序取前 N。
//   ④ LLM 结构化输出三级抢救解析（围栏剥离 → JSON.parse → 首个 {} → 首个 []）
//      + 下标白名单（编号必须是合法整数且落在范围内）——LLM 无法凭空造 id。
//
// 不抄的部分：参考对象把整合器绑在它的 Cyrene 宿主与 JSONL 存储上；此处做成
// 纯函数 + 一个注入依赖（KV 表 / LLM 通道 / 时钟）的 Consolidator，宿主无关、可单测。
//
// 硬不变量（check9 集成测试守住）：
//   1. 整条整合路径不调用任何记忆写入 API；
//   2. 洞察只存 recordIds，不复制 content；
//   3. recordIds 只能来自边界校验过的下标；
//   4. 整合失败/输出不合法 → 保留旧洞察，绝不覆盖成空；
//   5. 与写入互斥（inFlight 标志）。
// ============================================================

import type { KvTable } from '@deepseek-ai/dsh-storage-domain';
import { canonicalAttr } from './attributes.js';
import {
  CONSOLIDATION_HUB_FRACTION,
  CONSOLIDATION_HUB_MIN_RECORDS,
  CONSOLIDATION_LABEL_MAX_CHARS,
  CONSOLIDATION_MAX_CANDIDATE_PAIRS,
  CONSOLIDATION_MAX_CLUSTERS,
  CONSOLIDATION_MAX_CONFLICTS,
  CONSOLIDATION_MAX_RECORDS,
  CONSOLIDATION_MAX_TOKENS,
  CONSOLIDATION_MIN_CENTROID_COSINE,
  CONSOLIDATION_MIN_CLUSTER_SIZE,
  CONSOLIDATION_MIN_RECORDS,
  CONSOLIDATION_NOTE_MAX_CHARS,
  CONSOLIDATION_SNIPPET_MAX_CHARS,
  CONSOLIDATION_TIMEOUT_MS,
} from './limits.js';
import { hasClosedTimelineOverlap, normEntity, type ClaimLike } from './timeline.js';
import { EMPTY_INSIGHTS, type InsightCluster, type InsightConflict, type Insights } from './types.js';

// ============================================================
// 数据模型（记录 schema 在 types.ts；此处只消费其类型/空洞察常量）
// ============================================================

export { EMPTY_INSIGHTS };
export type { InsightCluster, InsightConflict, Insights };

/** 洞察只引用这些字段（避免把 MemoryRecord 拖进本模块）。 */
export interface InsightRecordInput {
  id: string;
  content: string;
  entity_claims?: readonly ClaimLike[] | null;
  deleted?: boolean | null;
}

/** 结构校验：任何不合法 → 返回 EMPTY_INSIGHTS（不抛）。 */
export function sanitizeInsights(raw: unknown): Insights {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_INSIGHTS, clusters: [], conflicts: [] };
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return { ...EMPTY_INSIGHTS, clusters: [], conflicts: [] };
  const lastRun = typeof obj.last_run_at === 'number' && Number.isFinite(obj.last_run_at) ? obj.last_run_at : 0;
  const clustersIn = Array.isArray(obj.clusters) ? obj.clusters : [];
  const conflictsIn = Array.isArray(obj.conflicts) ? obj.conflicts : [];
  const clusters: InsightCluster[] = [];
  for (const c of clustersIn) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    if (typeof o.label !== 'string' || !o.label) continue;
    if (!Array.isArray(o.recordIds) || o.recordIds.length === 0) continue;
    const ids = o.recordIds.filter((x): x is string => typeof x === 'string' && !!x);
    if (!ids.length) continue;
    clusters.push({ id: o.id, label: o.label, recordIds: ids, created_at: typeof o.created_at === 'number' ? o.created_at : 0 });
  }
  const conflicts: InsightConflict[] = [];
  for (const c of conflictsIn) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    if (typeof o.note !== 'string' || !o.note) continue;
    if (!Array.isArray(o.recordIds) || o.recordIds.length !== 2) continue;
    const [a, b] = o.recordIds as unknown[];
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || a === b) continue;
    conflicts.push({ id: o.id, note: o.note, recordIds: [a, b], created_at: typeof o.created_at === 'number' ? o.created_at : 0 });
  }
  return { version: 1, last_run_at: lastRun, clusters, conflicts };
}

// ============================================================
// T6 · LLM 输出抢救解析（纯函数）
// ============================================================

/** 三级抢救解析：围栏剥离 → JSON.parse → 首个 {...} → 首个 [...] → null。 */
export function parseLlmJson(raw: unknown): unknown | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  // 1) Markdown 代码围栏：```json\n...\n```
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/, '');
    s = s.replace(/\r?\n?```\s*$/, '').trim();
  }
  // 2) 直接解析
  try {
    return JSON.parse(s) as unknown;
  } catch {
    /* 继续抢救 */
  }
  // 3) 首个 '{' 到末个 '}'
  const objStart = s.indexOf('{');
  const objEnd = s.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    try {
      return JSON.parse(s.slice(objStart, objEnd + 1)) as unknown;
    } catch {
      /* 继续抢救 */
    }
  }
  // 4) 首个 '[' 到末个 ']'
  const arrStart = s.indexOf('[');
  const arrEnd = s.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(s.slice(arrStart, arrEnd + 1)) as unknown;
    } catch {
      /* 放弃 */
    }
  }
  return null;
}

/** 下标白名单：必须是 integer 且 0 <= v < n，否则 null（LLM 无法凭空造 id）。 */
export function toIndex(v: unknown, n: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n ? v : null;
}

/** 文本字段清理：非 string → ''，压空白，截断。 */
function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').slice(0, max);
}

/** 簇标签回收（`{"clusters":[{"index":0,"label":"…"}]}`）；未命名/越界一律丢弃。 */
export function sanitizeLabels(parsed: unknown, clusterCount: number): Map<number, string> {
  const out = new Map<number, string>();
  const list = parsed && typeof parsed === 'object' && Array.isArray((parsed as { clusters?: unknown }).clusters)
    ? ((parsed as { clusters: unknown[] }).clusters)
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const idx = toIndex(o.index, clusterCount);
    if (idx === null || out.has(idx)) continue;
    const label = cleanText(o.label, CONSOLIDATION_LABEL_MAX_CHARS);
    if (!label) continue;
    out.set(idx, label);
  }
  return out;
}

/** 矛盾回收（`{"conflicts":[{"a":0,"b":1,"note":"…"}]}`）；越界/自比/重复一律丢弃。 */
export function sanitizeConflicts(parsed: unknown, pairCount: number): Array<{ a: number; b: number; note: string }> {
  const out: Array<{ a: number; b: number; note: string }> = [];
  const seen = new Set<string>();
  const list = parsed && typeof parsed === 'object' && Array.isArray((parsed as { conflicts?: unknown }).conflicts)
    ? ((parsed as { conflicts: unknown[] }).conflicts)
    : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const a = toIndex(o.a, pairCount);
    const b = toIndex(o.b, pairCount);
    if (a === null || b === null || a === b) continue;
    const note = cleanText(o.note, CONSOLIDATION_NOTE_MAX_CHARS);
    if (!note) continue;
    const key = `${Math.min(a, b)}|${Math.max(a, b)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b, note });
    if (out.length >= CONSOLIDATION_MAX_CONFLICTS) break;
  }
  return out;
}

// ============================================================
// 主题簇 / 剪枝 / 候选对（纯函数）
// ============================================================

/** 一条记录的实体集合（去重、归一）。 */
function entitiesOf(rec: InsightRecordInput): string[] {
  const out = new Set<string>();
  for (const c of rec.entity_claims ?? []) {
    const e = normEntity(c?.entity);
    if (e) out.add(e);
  }
  return [...out];
}

/**
 * 主题簇：实体连通分量（并查集），**排除枢纽实体**（出现次数 ≥
 * max(ceil(N*HUB_FRACTION), HUB_MIN_RECORDS)）。纯函数。
 * @returns 每组是 recordId 列表（单点簇已过滤，按大小降序、最多 MAX_CLUSTERS 组）
 */
export function entityClustersOf(records: readonly InsightRecordInput[]): string[][] {
  const n = records.length;
  const entities = records.map(entitiesOf);
  const frequency = new Map<string, number>();
  for (const list of entities) {
    for (const e of list) frequency.set(e, (frequency.get(e) ?? 0) + 1);
  }
  const hubMin = Math.max(Math.ceil(n * CONSOLIDATION_HUB_FRACTION), CONSOLIDATION_HUB_MIN_RECORDS);
  const isHub = (e: string): boolean => (frequency.get(e) ?? 0) >= hubMin;

  const parent = records.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r] as number;
    let cur = x;
    while (parent[cur] !== r) {
      const next = parent[cur] as number;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const firstByEntity = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    for (const e of entities[i] as string[]) {
      if (isHub(e)) continue; // 枢纽实体不参与连通 → 防一次 union 吞掉全库
      const first = firstByEntity.get(e);
      if (first === undefined) firstByEntity.set(e, i);
      else union(first, i);
    }
  }

  const groups = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(records[i]!.id);
    groups.set(root, list);
  }
  return [...groups.values()]
    .filter((g) => g.length >= CONSOLIDATION_MIN_CLUSTER_SIZE)
    .sort((a, b) => b.length - a.length)
    .slice(0, CONSOLIDATION_MAX_CLUSTERS);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 质心剪枝：剔除与簇质心余弦 < MIN_CENTROID_COSINE 的成员；剪枝后不足 2 人 → 丢弃整簇。
 * 向量缺失 / 长度不符 → **原样返回不校验**（没有向量就没有质心可比，别误删）。
 */
export function pruneClustersByCentroid(
  clusters: readonly string[][],
  vectorsOf: (id: string) => number[] | undefined,
): string[][] {
  const out: string[][] = [];
  for (const cluster of clusters) {
    const vectors = cluster.map((id) => vectorsOf(id));
    if (vectors.some((v) => !v || !v.length)) {
      out.push([...cluster]);
      continue;
    }
    const dim = (vectors[0] as number[]).length;
    if (vectors.some((v) => (v as number[]).length !== dim)) {
      out.push([...cluster]);
      continue;
    }
    const centroid = new Array<number>(dim).fill(0);
    for (const v of vectors as number[][]) {
      for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] as number) + (v[i] as number);
    }
    for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] as number) / cluster.length;
    const kept = cluster.filter((_, i) => cosine(vectors[i] as number[], centroid) >= CONSOLIDATION_MIN_CENTROID_COSINE);
    if (kept.length >= CONSOLIDATION_MIN_CLUSTER_SIZE) out.push(kept);
  }
  return out;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * 候选矛盾对：实体共现对 ∪ 簇内对 → 去重 → 按 heat(a)+heat(b) 降序 → 取前
 * MAX_CANDIDATE_PAIRS → 过 T2 的 hasClosedTimelineOverlap 过滤（已闭合=演进，不是矛盾）。
 */
export function candidatePairsOf(
  records: readonly InsightRecordInput[],
  clusters: readonly string[][],
  heatOf: (id: string) => number,
): [string, string][] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  const add = (a: string, b: string): void => {
    if (a === b) return;
    const key = pairKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(a < b ? [a, b] : [b, a]);
  };

  // (a) 同实体共现对（只取实体列表，不含枢纽概念——枢纽过滤只作用于"连通"）
  const byEntity = new Map<string, string[]>();
  for (const rec of records) {
    for (const e of entitiesOf(rec)) {
      const list = byEntity.get(e) ?? [];
      list.push(rec.id);
      byEntity.set(e, list);
    }
  }
  for (const ids of byEntity.values()) {
    // 单个实体出现过多（> MAX_CANDIDATE_PAIRS）时只取前 N+1 条，避免 O(n²) 爆炸
    const limited = ids.slice(0, CONSOLIDATION_MAX_CANDIDATE_PAIRS + 1);
    for (let i = 0; i < limited.length; i++) {
      for (let j = i + 1; j < limited.length; j++) add(limited[i] as string, limited[j] as string);
    }
  }
  // (b) 同簇内对
  for (const cluster of clusters) {
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) add(cluster[i] as string, cluster[j] as string);
    }
  }

  const heat = new Map<string, number>();
  for (const [a, b] of pairs) {
    if (!heat.has(a)) heat.set(a, heatOf(a));
    if (!heat.has(b)) heat.set(b, heatOf(b));
  }
  return pairs
    .sort((x, y) => (heat.get(y[0]) as number) + (heat.get(y[1]) as number) - ((heat.get(x[0]) as number) + (heat.get(x[1]) as number)))
    .slice(0, CONSOLIDATION_MAX_CANDIDATE_PAIRS)
    .filter(([a, b]) => {
      const ra = byId.get(a);
      const rb = byId.get(b);
      if (!ra || !rb) return true; // 记录不在输入集（异常）→ 保留，交给 LLM 判断
      // 时间轴已处理的演进（共同 (entity,attr) 且任一侧已闭合）→ 不是矛盾，剔除
      return !hasClosedTimelineOverlap(ra.entity_claims ?? [], rb.entity_claims ?? []);
    });
}

// ============================================================
// 整合 prompt（借参考对象的整合输出协议：只给编号，绝不编造）
// ============================================================

export function buildInsightsPrompt(records: readonly InsightRecordInput[], clusters: readonly string[][], pairs: readonly [string, string][]): string {
  const snippet = (rec: InsightRecordInput | undefined): string => {
    if (!rec) return '（缺失）';
    const s = (rec.content || '').trim().replace(/\s+/g, ' ');
    return (s.length > CONSOLIDATION_SNIPPET_MAX_CHARS ? `${s.slice(0, CONSOLIDATION_SNIPPET_MAX_CHARS)}…` : s) || '（空）';
  };
  const idx = new Map(records.map((r, i) => [r.id, i]));
  const clusterLines = clusters.length
    ? clusters.map((c, i) => `簇${i}：\n${c.map((id) => `  #${idx.get(id)}. ${snippet(records.find((r) => r.id === id))}`).join('\n')}`).join('\n')
    : '（无）';
  const pairLines = pairs.length
    ? pairs.map((p, i) => `对${i}：#${idx.get(p[0])}（${snippet(records.find((r) => r.id === p[0]))}）←→ #${idx.get(p[1])}（${snippet(records.find((r) => r.id === p[1]))}）`).join('\n')
    : '（无）';
  return [
    '为下列记忆簇命名（≤12 字）；并逐对甄别是否真矛盾（≤40 字）。',
    '只输出 JSON：{"clusters":[{"index":0,"label":"…"}],"conflicts":[{"a":0,"b":1,"note":"…"}]}',
    '只能使用给定编号，绝不编造；没有矛盾就输出空数组。',
    '注意：同一属性先后的取值变化（如"去年住北京/今年搬到上海"）属于**演变**，不是矛盾，不要报。',
    '',
    '【记忆条目】',
    records.map((r, i) => `#${i}. ${snippet(r)}`).join('\n'),
    '',
    '【主题候选簇】',
    clusterLines,
    '',
    '【疑似矛盾候选对】',
    pairLines,
  ].join('\n');
}

// ============================================================
// Consolidator（依赖注入：KV 表 / LLM 通道 / 时钟 → 宿主无关、可单测）
// ============================================================

export interface ConsolidatorDeps {
  /** 独立存储：单条记录（key 固定 'current'），结构与 memories 表无关。 */
  insights: KvTable<string, Insights>;
  /** 读当前记忆（只读！整合路径绝不写 memories）。 */
  listRecords: () => InsightRecordInput[];
  /** LLM 通道；返回 null 表示不可用/失败（→ 保留旧洞察）。 */
  askLlm: (prompt: string, opts: { maxTokens: number; purpose: string }) => Promise<string | null>;
  /** 记录热度的读取器（用于候选对排序）。 */
  heatOf: (id: string) => number;
  /** 向量读取器（可选；缺省 → 质心剪枝不生效，簇原样保留）。 */
  vectorsOf?: (id: string) => number[] | undefined;
  /** 日志。 */
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** 构造器关闭时（ctx 已 dispose）直接 skip。 */
  isDisposed?: () => boolean;
  now?: () => number;
  /** 护栏可覆盖（测试用）。 */
  minRecords?: number;
  maxRecords?: number;
}

const INSIGHTS_KEY = 'current';
let insightSeq = 0;

/** 洞察 id：cluster_<now>_<rand8> / conflict_<now>_<rand8>（不需要密码学强度）。 */
function insightId(prefix: string, now: number): string {
  insightSeq = (insightSeq + 1) % 0xffff;
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36).slice(0, 8);
  return `${prefix}_${now}_${rand}${insightSeq.toString(36)}`;
}

/** 空闲整合器：一次 run 产出 clusters + conflicts 到独立存储。 */
export class Consolidator {
  private readonly deps: ConsolidatorDeps;
  private inFlight = false;

  constructor(deps: ConsolidatorDeps) {
    this.deps = deps;
  }

  /** 当前洞察（结构校验过的；读失败 → EMPTY_INSIGHTS）。 */
  current(): Insights {
    try {
      return sanitizeInsights(this.deps.insights.get(INSIGHTS_KEY));
    } catch {
      return { ...EMPTY_INSIGHTS, clusters: [], conflicts: [] };
    }
  }

  /** 是否正在整合（调度器据此跳过重复触发）。 */
  get running(): boolean {
    return this.inFlight;
  }

  /**
   * 跑一次整合。
   * @returns 新洞察；被闸门拦下/记录不足/LLM 不可用/写回校验失败 → null（旧洞察不变）
   */
  async run(): Promise<Insights | null> {
    if (this.inFlight) return null; // 闸门：与写入互斥
    if (this.deps.isDisposed?.()) return null; // 闸门：ctx 已 dispose
    const log = this.deps.log ?? ((): void => undefined);
    const warn = this.deps.warn ?? ((): void => undefined);
    this.inFlight = true;
    const started = Date.now();
    try {
      const now = (this.deps.now ?? Date.now)();
      const all = this.deps.listRecords().filter((r) => !r.deleted && (r.content ?? '').trim().length > 0);
      const maxRecords = this.deps.maxRecords ?? CONSOLIDATION_MAX_RECORDS;
      // 取最近/最重要的前 N 条（调用方给什么顺序用什么，再按 created 无关地截断）
      const records = all.slice(0, Math.max(1, maxRecords));
      const minRecords = this.deps.minRecords ?? CONSOLIDATION_MIN_RECORDS;
      if (records.length < minRecords) {
        log(`记忆整合跳过：仅 ${records.length} 条 < 下限 ${minRecords}`);
        return null;
      }

      const clusters = this.deps.vectorsOf
        ? pruneClustersByCentroid(entityClustersOf(records), this.deps.vectorsOf)
        : entityClustersOf(records);
      const pairs = candidatePairsOf(records, clusters, this.deps.heatOf);
      if (!clusters.length && !pairs.length) {
        // 无主题也无候选：不再白花 token，旧洞察保持不变
        log(`记忆整合跳过：无主题簇也无候选矛盾对（${records.length} 条记忆）`);
        return null;
      }

      const raw = await this.deps.askLlm(buildInsightsPrompt(records, clusters, pairs), {
        maxTokens: CONSOLIDATION_MAX_TOKENS,
        purpose: 'consolidate-insights',
      });
      if (raw === null) {
        log('记忆整合：LLM 不可用/失败 → 保留旧洞察');
        return null;
      }
      const parsed = parseLlmJson(raw);
      const labels = sanitizeLabels(parsed, clusters.length);
      const conflictHits = sanitizeConflicts(parsed, pairs.length);

      const next: Insights = {
        version: 1,
        last_run_at: now,
        clusters: clusters.map((ids, i) => ({ id: insightId('cluster', now), label: labels.get(i) ?? '未命名主题', recordIds: [...ids], created_at: now })),
        conflicts: conflictHits.map(({ a, note }) => {
          const [x, y] = pairs[a] as [string, string];
          return { id: insightId('conflict', now), note, recordIds: [x, y] as [string, string], created_at: now };
        }),
      };

      await this.deps.insights.put(INSIGHTS_KEY, next);
      const back = this.deps.insights.get(INSIGHTS_KEY);
      if (!back || back.last_run_at !== next.last_run_at) {
        warn('记忆整合写回校验失败（last_run_at 不一致）→ 放弃本次结果');
        return null;
      }
      log(`[记忆整合] 簇 ${next.clusters.length} / 矛盾 ${next.conflicts.length}，耗时 ${Date.now() - started}ms`);
      return next;
    } catch (e) {
      warn(`记忆整合失败（保留旧洞察）: ${(e as Error).message}`);
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}

/** 便利构造：按同一套依赖建整合器。 */
export function createConsolidator(deps: ConsolidatorDeps): Consolidator {
  return new Consolidator(deps);
}

/** 属性归一化复导出（面板/工具同源），避免调用方各自 import 两份。 */
export { canonicalAttr };
