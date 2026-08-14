// ============================================================
// engine.ts — 记忆生命周期纯函数（可单测；不依赖 domain/IO）
// ① 淘汰选择：L3 超容量时选 importance×recency 最低的 active 记忆
// ② 画像沉淀：从 user_fact 记忆提取跨角色稳定事实 → userProfile
// ============================================================

export interface EvictionCandidate {
  id: string;
  importance: number;
  lastAccess: number;
  scope: 'mode' | 'global';
  status: 'active' | 'dormant';
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

/**
 * 选出应淘汰的记录 id（升序价值最低的 N 个）。
 * 只考虑 scope='global' 且 status='active' 且未标记 deleted 的候选。
 * @param records 全部记录（调用方过滤 deleted）
 * @param capacity 容量上限
 * @param now      当前时间戳
 * @returns 需要淘汰的 id 列表（已超出容量的部分）
 */
export function selectEviction(records: EvictionCandidate[], capacity: number, now: number): string[] {
  const globalActive = records
    .filter((r) => r.scope === 'global' && r.status === 'active')
    .sort((a, b) => evictionValue(a, now) - evictionValue(b, now));
  const over = globalActive.length - capacity;
  if (over <= 0) return [];
  return globalActive.slice(0, over).map((r) => r.id);
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
