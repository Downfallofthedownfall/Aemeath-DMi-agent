// ============================================================
// engine.ts — 记忆生命周期纯函数（可单测；不依赖 domain/IO）
// ① 淘汰选择：L3 超容量时选激活值（importance×recency×命中抵抗）最低的 active 记忆
// ② 画像沉淀：从 user_fact 记忆提取跨角色稳定事实 → userProfile
// ③ partial DMAE 激活得分 + 三态分类（借 Cyrene L2 激活缓存思想）
// ============================================================

export interface EvictionCandidate {
  id: string;
  importance: number;
  lastAccess: number;
  scope: 'mode' | 'global';
  status: 'active' | 'dormant' | 'archived';
  /** 已算好的激活值（可选；缺省时由 importance+recency 现算）。 */
  activation?: number;
}

/** 时间衰减半衰期（天数）：importance 影响力随时间减半的尺度。 */
export const RECENCY_HALF_LIFE_DAYS = 45;

/** 归一化活性得分 0..1：越近访问越接近 1。 */
export function recencyScore(lastAccess: number, now: number): number {
  const ageDays = Math.max(0, (now - lastAccess) / (24 * 3600 * 1000));
  return Math.exp(-Math.log(2) * ageDays / RECENCY_HALF_LIFE_DAYS);
}

/** 淘汰价值：importance × recency（越低越先淘汰）。 */
export function evictionValue(rec: EvictionCandidate, now: number): number {
  return rec.importance * recencyScore(rec.lastAccess, now);
}

// ============================================================
// partial DMAE 记忆生命周期（借 Cyrene L2 激活得分缓存的"activation-scored
// 3-state cache"思想，只取思想不复制其完整 DMAE 数学）：
// 每条记忆有一个激活值（intrinsic 价值 + 近因 + 关键词/BM25 命中加成），按激活值
// 分三态：active（≥60）/ dormant（30–59）/ archived（<30）。高频回访的记忆靠命中
// 加成抵抗衰减（不易被遗忘/归档），归档记忆被召回时"唤醒"回 active。
// ============================================================

export const ACTIVATION_DEFAULT = 50;
export const ACTIVATION_ACTIVE_THRESHOLD = 60;
export const ACTIVATION_ARCHIVED_THRESHOLD = 30;
/** 每次召回/命中对激活值的加成（衰减抵抗——越常用越不易被遗忘/归档）。 */
export const ACTIVATION_HIT_BONUS = 12;

export type LifecycleStatus = 'active' | 'dormant' | 'archived';

export interface ActivationSignals {
  importance: number;
  lastAccess: number;
  now: number;
  /** 关键词/BM25 命中加成（0..1，越小越弱）；缺省 0。 */
  hitBonus?: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * 计算当前激活值（0..100）。取三个已存在的信号混合：
 * importance（intrinsic 价值，权重 45）+ recency（近因，权重 45）+ hitBonus（命中/衰减抵抗，权重 12）。
 * 返回 0..100 的整数。纯函数可单测。
 */
export function computeActivation(s: ActivationSignals): number {
  const intrinsic = clamp01(s.importance / 100);
  const recency = recencyScore(s.lastAccess, s.now);
  const hit = clamp01(s.hitBonus ?? 0);
  const score = 45 * intrinsic + 45 * recency + 12 * hit;
  return clamp(Math.round(score), 0, 100);
}

/** 按激活值把记忆分成三态：≥ACTIVE 阈值 → active，≥ARCHIVED 阈值 → dormant，否则 archived。 */
export function classifyActivation(activation: number): LifecycleStatus {
  if (activation >= ACTIVATION_ACTIVE_THRESHOLD) return 'active';
  if (activation >= ACTIVATION_ARCHIVED_THRESHOLD) return 'dormant';
  return 'archived';
}

/** 取一条记录的"当前激活值"（优先用已存的 activation，缺省现算）。 */
export function activationOf(rec: { importance: number; lastAccess: number; activation?: number }, now: number, hitBonus = 0): number {
  if (typeof rec.activation === 'number') return clamp(rec.activation, 0, 100);
  return computeActivation({ importance: rec.importance, lastAccess: rec.lastAccess, now, hitBonus });
}

/**
 * 召回后的激活/状态（wake-on-recall）：命中改判为 active（把 last_access 推到 now，使
 * 近因变满），并叠满命中加成（衰减抵抗）——归档记忆被召回即唤醒回 active。
 * 返回应写入记录的 { activation, status }。
 */
export function afterRecallActivation(rec: { importance: number; activation: number }, now: number): { activation: number; status: LifecycleStatus } {
  const act = computeActivation({ importance: rec.importance, lastAccess: now, now, hitBonus: 1 });
  return { activation: Math.max(act, ACTIVATION_ACTIVE_THRESHOLD), status: 'active' };
}

/**
 * 选出应淘汰的记录 id（升序激活值最低的 N 个）。
 * 只考虑指定 scope 且 status='active' 且未标记 deleted 的候选。
 * 淘汰依据改用 activation（本身已混合 importance + recency + 命中/衰减抵抗），
 * 低激活的活跃记忆（陈旧/低价值）先淘汰；dormant/archived 不再参与召回，不在此淘汰。
 * L2（scope='mode'）与 L3（scope='global'）各自独立容量、独立淘汰池。
 * @param records 全部记录（调用方过滤 deleted）
 * @param scope   淘汰池：'global'（L3）或 'mode'（L2）
 * @param capacity 容量上限
 * @param now      当前时间戳
 * @returns 需要淘汰的 id 列表（已超出容量的部分）
 */
export function selectEviction(records: EvictionCandidate[], scope: 'mode' | 'global', capacity: number, now: number): string[] {
  const active = records
    .filter((r) => r.scope === scope && r.status === 'active')
    .sort((a, b) => activationOf(a, now) - activationOf(b, now));
  const over = active.length - capacity;
  if (over <= 0) return [];
  return active.slice(0, over).map((r) => r.id);
}

/**
 * 从 user_fact 类记忆中提取跨角色稳定事实（去重、简短），供沉淀进 userProfile。
 * @param facts 候选事实字符串（记忆 content）
 * @param existing 已在画像中的事实（去重依据，子串匹配）
 * @param maxFacts 画像事实条数上限
 */
export function suggestProfileFacts(facts: string[], existing: string[], maxFacts = 20): string[] {
  const clean = (s: string): string => (s || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const out: string[] = [];
  for (const raw of facts) {
    const c = clean(raw);
    if (!c || c.length < 2) continue;
    // 去重：与已有事实或已收集事实子串/包含关系
    const dup = existing.some((e) => e.includes(c) || c.includes(e)) || out.some((o) => o.includes(c) || c.includes(o));
    if (dup) continue;
    out.push(c);
    if (out.length >= maxFacts) break;
  }
  return out;
}
