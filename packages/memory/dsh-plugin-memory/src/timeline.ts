// ============================================================
// timeline.ts — 事实时间轴（T1/T2：借 ripples-of-aion 的 entityClaims +
// valid_until 闭合理念，只借数据模型与算法，不抄代码）
//
// 借了什么思想：
//   ① 一条记忆里可以挂多个「实体-属性-值」断言（claim），断言带**有效区间**
//      [valid_from, valid_until)，valid_until === null 表示"当前仍有效"；
//      于是能回答"**当时**是什么"，而不只是"谁取代了谁"（Aemeath 原来只有
//      superseded_by 指针）。
//   ② 写新断言时，把同 (entity, canonicalAttr) 的旧**活跃**断言**闭合**到新
//      断言的 valid_from——属性变更 = 演进，不是矛盾（T2 的判据）。
//   ③ 完全相同的三元组由写入侧去重（hasActiveClaim），不产生任何闭合（时间轴无噪音）。
//
// 不抄的部分：参考对象的 claim 内嵌在它的 JSONL 记录里、闭合并发由 writeChain
// 串行化；Aemeath 用 domain KV 表 + 调用方（index.ts）在写完新记录后闭合旧记录，
// 失败只 warn 不回滚。
//
// 纯函数、零 IO、可单测。
// ============================================================

import { canonicalAttr } from './attributes.js';
import { CLAIM_VALUE_MAX_CHARS, ENTITY_MAX_CHARS } from './limits.js';

/** 一条实体-属性断言。valid_until === null 表示「当前有效」。 */
export interface EntityClaim {
  entity: string;
  /** 规范化后的属性（canonicalAttr）。 */
  attribute: string;
  value: string;
  /** 毫秒时间戳。 */
  valid_from: number;
  /** 毫秒时间戳；null = 尚未被取代。 */
  valid_until: number | null;
}

/** 用于比较的最小输入形态（记忆记录里的 claim 可能来自旧数据，缺字段也容忍）。 */
export interface ClaimLike {
  entity?: unknown;
  attribute?: unknown;
  value?: unknown;
  valid_from?: unknown;
  valid_until?: unknown;
}

/** 比较键：entity + '\0' + canonicalAttr(attribute)。entity 侧只 trim。 */
function keyOf(entity: unknown, attribute: unknown): string {
  return `${normEntity(entity)}\u0000${canonicalAttr(attribute)}`;
}

/** 实体名归一：非 string → ''，全角空白 trim，去内部空白，截断。 */
export function normEntity(entity: unknown): string {
  if (typeof entity !== 'string') return '';
  return entity.trim().replace(/\s+/g, '').slice(0, ENTITY_MAX_CHARS);
}

/** claim 的 value 归一：非 string → ''，压空白，截断。 */
export function normValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, CLAIM_VALUE_MAX_CHARS);
}

/** 该 claim 是否"当前有效"（未闭合）。 */
export function isActiveClaim(claim: ClaimLike | undefined | null): boolean {
  return !!claim && (claim.valid_until === null || claim.valid_until === undefined);
}

/**
 * 同一三元组是否仍有活跃断言（写入侧去重用）。属性两侧都过 canonicalAttr。
 * 完全相同的重述 → true → 调用方丢弃，不写 entity_claims、不产生闭合。
 */
export function hasActiveClaim(
  claims: readonly ClaimLike[] | undefined,
  entity: unknown,
  attribute: unknown,
  value: unknown,
): boolean {
  if (!claims || !claims.length) return false;
  const key = keyOf(entity, attribute);
  const v = normValue(value);
  return claims.some((c) => isActiveClaim(c) && keyOf(c.entity, c.attribute) === key && normValue(c.value) === v);
}

/** 找出被新断言取代的旧断言位置（按记录 id 分组的 claim 下标集合）。 */
export interface CloseTarget {
  recordId: string;
  indexes: number[];
}

/** findClosableClaims 的输入形态（只取需要的字段）。 */
export interface ClosableRecord {
  id: string;
  entity_claims?: readonly ClaimLike[] | null;
  deleted?: boolean | null;
}

/**
 * 找出「被新断言取代」的旧断言位置。
 * 冲突判定只比 (entity, canonicalAttr) 归一后相等，**不比 value**（与去重相反）；
 * 已闭合（valid_until != null）的跳过（幂等）；deleted 与 selfId 跳过。
 *
 * **每个键只闭最旧的那条活跃断言**（valid_from 最小者）：正常写入下每个键至多一条活跃断言，
 * 但历史数据/合并路径可能留下重复的活跃断言，此时若把同键的多条一起闭合，会出现「闭合时刻
 * 晚于某条新断言的 valid_from」的脏区间。取最旧者与「oldest active claim 被新值取代」的语义一致。
 *
 * **时间单调性护栏**：只闭 `valid_from < at` 的断言（at = 新记录 created_at）——同一轮的
 * 规则层直存与总结层卸载可能在同一毫秒先后写入同一三元组，此时"先写的那条"不应被"后写的
 * 闭合时刻"倒挂成 valid_until < valid_from（真机管线验证时实测到过 1–2ms 的负区间）。
 * @param existing 现有记忆（含 id 与 entity_claims）
 * @param newClaims 本次新写入的 claim（已规范化）
 * @param selfId 新记录自身的 id（跳过自闭合）
 * @param at 闭合时刻（缺省不启用单调性护栏，兼容既有调用）
 */
export function findClosableClaims(
  existing: readonly ClosableRecord[],
  newClaims: readonly ClaimLike[],
  selfId: string,
  at?: number,
): CloseTarget[] {
  if (!newClaims.length) return [];
  const newKeys = new Set<string>();
  for (const c of newClaims) {
    if (!normEntity(c.entity) || !canonicalAttr(c.attribute)) continue;
    newKeys.add(keyOf(c.entity, c.attribute));
  }
  if (!newKeys.size) return [];

  const closableFrom = (claim: ClaimLike): number => Number(claim.valid_from ?? 0);
  const passesMonotonic = (claim: ClaimLike): boolean => at === undefined || closableFrom(claim) < at;

  // 第一遍：每个待闭键的「最旧活跃且可闭断言」的 valid_from
  const oldestFrom = new Map<string, number>();
  for (const rec of existing) {
    if (!rec || rec.deleted || rec.id === selfId) continue;
    const claims = rec.entity_claims;
    if (!claims?.length) continue;
    for (const claim of claims) {
      if (!isActiveClaim(claim)) continue; // 已闭合 → 跳过（幂等）
      if (!passesMonotonic(claim)) continue; // 时间单调性：起点不早于闭合时刻 → 不闭
      const key = keyOf(claim.entity, claim.attribute);
      if (!newKeys.has(key)) continue;
      const from = closableFrom(claim);
      const cur = oldestFrom.get(key);
      if (cur === undefined || from < cur) oldestFrom.set(key, from);
    }
  }
  if (!oldestFrom.size) return [];

  // 第二遍：只收「valid_from == 该键最旧值」的活跃断言
  const targets = new Map<string, Set<number>>();
  for (const rec of existing) {
    if (!rec || rec.deleted || rec.id === selfId) continue;
    const claims = rec.entity_claims;
    if (!claims?.length) continue;
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      if (!isActiveClaim(claim)) continue;
      if (!passesMonotonic(claim)) continue;
      const key = keyOf(claim.entity, claim.attribute);
      if (!newKeys.has(key)) continue;
      if (closableFrom(claim) !== oldestFrom.get(key)) continue;
      const set = targets.get(rec.id) ?? new Set<number>();
      set.add(i);
      targets.set(rec.id, set);
    }
  }
  return [...targets].map(([recordId, set]) => ({ recordId, indexes: [...set].sort((a, b) => a - b) }));
}

/**
 * 把目标 claim 的 valid_until 置为 at（幂等：已闭合的不动）。
 * 返回新数组（不可变）；已闭合的 claim 原样保留（不动其 valid_until）。
 */
export function closeClaims(claims: readonly EntityClaim[], indexes: readonly number[], at: number): EntityClaim[] {
  const hit = new Set(indexes);
  return claims.map((c, i) => (hit.has(i) && isActiveClaim(c) ? { ...c, valid_until: at } : { ...c }));
}

/** 查询某实体某属性的「当前值」：多条活跃时取 valid_from 最大者；无则 undefined。 */
export function activeClaimOf(claims: readonly ClaimLike[], entity: unknown, attribute: unknown): ClaimLike | undefined {
  const key = keyOf(entity, attribute);
  let best: ClaimLike | undefined;
  for (const c of claims) {
    if (!isActiveClaim(c)) continue;
    if (keyOf(c.entity, c.attribute) !== key) continue;
    if (!best || Number(c.valid_from ?? 0) > Number(best.valid_from ?? 0)) best = c;
  }
  return best;
}

/** 时间轴（按 valid_from 升序，同刻按闭合者后置），供面板/工具展示。 */
export function timelineOf(claims: readonly ClaimLike[], entity: unknown, attribute: unknown): ClaimLike[] {
  const key = keyOf(entity, attribute);
  return claims
    .filter((c) => keyOf(c.entity, c.attribute) === key)
    .slice()
    .sort((a, b) => Number(a.valid_from ?? 0) - Number(b.valid_from ?? 0) || Number(a.valid_until ?? Infinity) - Number(b.valid_until ?? Infinity));
}

/**
 * T2 · 两条记忆是否存在「已被时间轴处理过的类型化冲突」。
 * 语义：它们有共同 (entity, canonicalAttr) 键，**且该键在任一侧已闭合**
 * → 只是先后演变（原来的值已被时间轴记录为"当时"），不是矛盾。
 * 用法：疑似矛盾候选对先过这个过滤器，再送 LLM/规则判定。
 */
export function hasClosedTimelineOverlap(a: readonly ClaimLike[] | undefined, b: readonly ClaimLike[] | undefined): boolean {
  if (!a?.length || !b?.length) return false;
  const keysOf = (claims: readonly ClaimLike[]): Map<string, boolean> => {
    const out = new Map<string, boolean>();
    for (const c of claims) {
      const k = keyOf(c.entity, c.attribute);
      if (k === '\u0000') continue;
      out.set(k, (out.get(k) ?? false) || !isActiveClaim(c));
    }
    return out;
  };
  const ka = keysOf(a);
  const kb = keysOf(b);
  for (const [k, closedA] of ka) {
    if (!kb.has(k)) continue;
    if (closedA || kb.get(k)) return true; // 任一侧已闭合 → 演进
  }
  return false;
}

/**
 * 写入侧 claim 后处理：① 去掉与现有活跃断言**完全相同**的重述（去重）；
 * ② 保证同批 claim 的 valid_from **互不相同**（附录 D-7：参考对象同轮多事实共享
 * 毫秒级 createdAt，同一 (entity,attr) 会互相闭合成**零长区间**）——
 * 同批第 i 条按 i 毫秒递增。
 *
 * **重要（写入侧调用约定）**：真实写入路径应传 `existing = []`（batch 内去重），
 * 而**不要**传全表活跃断言——否则第二次写入相同事实时 prepareClaims 会返回空数组，
 * 把本该发生的「闭合旧断言」一起丢掉（值相同的重述应在**记录层**（consolidateTarget
 * / 内容去重）被吸收，两侧混用会互相抵消）。
 * @returns 过滤+错峰后的新 claim 数组（可能为空 → 调用方不写 entity_claims 字段）
 */
export function prepareClaims(
  claims: readonly EntityClaim[],
  existingClaims: readonly ClaimLike[],
  baseTs: number,
): EntityClaim[] {
  const out: EntityClaim[] = [];
  const seen = new Set<string>();
  for (const c of claims) {
    const entity = normEntity(c.entity);
    const attribute = canonicalAttr(c.attribute);
    const value = normValue(c.value);
    if (!entity || !attribute || !value) continue;
    const key = `${entity}\u0000${attribute}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const offset = out.length;
    if (hasActiveClaim(existingClaims, entity, attribute, value)) continue; // 重述 → 丢弃
    out.push({ entity, attribute, value, valid_from: baseTs + offset, valid_until: null });
  }
  return out;
}
