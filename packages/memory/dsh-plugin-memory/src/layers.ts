// ============================================================
// layers.ts — 记忆分层纯函数（可单测；不依赖 domain/IO）
// 记忆分层设想（2026-08-15 用户提出）：
//   L1（工作区，有容量上限的采集缓冲）→ 容量达 80% 后 LLM 总结卸载 → L2（角色记忆）
//   → L3（共享层）→ 知识层（知识路由写入目标，pending 评审门）
// 本模块只做确定性逻辑：
//   ① shouldTriggerL1 / appendL1 —— 容量 + 80% 阈值 + 封顶
//   ② buildSummarizePrompt —— 总结层 LLM 提示词（含相似记忆上下文）
//   ③ fallbackUnload —— 规则层兜底卸载（LLM 未启用时）
//   ④ consolidateTarget —— 卸载落库前查重（merge / supersede / save）
// ============================================================

import { search as bm25Search, overlapScore } from './bm25.js';
import { CANONICAL_ATTRS } from './attributes.js';
import type { Category } from './gatekeeper.js';
import { decide, extractMemory, hasTimeEvidence, classifyKnowledgeTopic } from './gatekeeper.js';
import type { L1Turn } from './types.js';

/** 总结层产出的"用户记忆"候选（落 L2 mode / L3 global）。 */
export interface L1MemoryCandidate {
  content: string;
  category: Category;
  importance: number;
  scope: 'mode' | 'global';
  /**
   * 2026-09（借 ripples-of-aion 的 claims 输出）：总结层**在同一次 LLM 调用里**顺带产出的
   * 事实断言三元组。规则层正则抽不到的表述（作息/偏好/多事实句/考试日程）由它补上，
   * 且不增加 LLM 调用次数（增量只是输出 JSON 里多几个 token）。
   * 缺省 = 该候选没有属性化断言（时间轴只保留记录本身）。
   */
  claims?: Array<{ entity?: string; attribute: string; value: string }>;
}

/** 一条候选携带的 claim 数上限（护栏：LLM 可能给一大堆）。 */
export const MAX_CLAIMS_PER_CANDIDATE = 4;

/** 属性名最大字符数（与 attributes/lite 护栏同量级；LLM 可能给出超长脏属性）。 */
const CLAIM_ATTR_MAX_CHARS = 24;
/** 值最大字符数。 */
const CLAIM_VALUE_MAX_CHARS = 60;

/**
 * 总结层 claims 字段的清洗（纯函数，可单测）：
 *   - 非数组 → []；单条非对象/缺 attribute/value → 丢弃；
 *   - attribute 必须在给定词表内（`knownAttrs`），否则丢弃——**白名单**是这里的关键护栏：
 *     LLM 编造的属性名会让时间轴出现永远查不到的键；
 *   - 每候选最多 MAX_CLAIMS_PER_CANDIDATE 条，按 (attribute, value) 去重；
 *   - entity 缺省 '用户'（与规则层抽取口径一致）。
 * @param raw LLM 输出的 claims 数组（未知类型一律安全丢弃）
 * @param knownAttrs 允许的属性名集合（调用方传 attributes.ts 的规范词表）
 */
export function sanitizeCandidateClaims(raw: unknown, knownAttrs: readonly string[]): Array<{ entity: string; attribute: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const known = new Set(knownAttrs);
  const out: Array<{ entity: string; attribute: string; value: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const attribute = typeof o.attribute === 'string' ? o.attribute.trim().slice(0, CLAIM_ATTR_MAX_CHARS) : '';
    const value = typeof o.value === 'string' ? o.value.trim().replace(/\s+/g, ' ').slice(0, CLAIM_VALUE_MAX_CHARS) : '';
    const entity = typeof o.entity === 'string' && o.entity.trim() ? o.entity.trim() : '用户';
    if (!attribute || !value) continue;
    if (!known.has(attribute)) continue; // 白名单：编造的属性名不进时间轴
    const key = `${entity}\u0000${attribute}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entity, attribute, value });
    if (out.length >= MAX_CLAIMS_PER_CANDIDATE) break;
  }
  return out;
}

/** 总结层产出的"知识"候选（落知识层 pending 评审门）。 */
export interface L1KnowledgeCandidate {
  content: string;
  topic: string;
}

/** 一次 L1 卸载的完整结果。 */
export interface L1SummarizeResult {
  memories: L1MemoryCandidate[];
  knowledge: L1KnowledgeCandidate[];
}

/** 80% 阈值触发判断：count ≥ ceil(capacity × threshold)。 */
export function shouldTriggerL1(count: number, capacity: number, threshold = 0.8): boolean {
  if (capacity <= 0 || count <= 0) return false;
  if (threshold <= 0) return count >= 1;
  return count >= Math.ceil(capacity * threshold);
}

/**
 * 粗略 token 估算（供 L1 预算化触发与提示词容量预估，不追求精确）：
 * CJK/日文假名按 1 字 ≈ 1.5 token，ASCII 按 4 字符 ≈ 1 token，其余按 1 字符 ≈ 1 token。
 */
export function estimateTokens(text: string): number {
  const s = text ?? '';
  let cjk = 0;
  let ascii = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(ch)) cjk++;
    else if (ch.charCodeAt(0) < 128) ascii++;
  }
  const other = s.length - cjk - ascii;
  return Math.ceil(cjk * 1.5 + ascii / 4 + other);
}

/** 会话 L1 缓冲的累计 token 估算（query + reply）。 */
export function sessionTokens(turns: L1Turn[]): number {
  return turns.reduce((sum, t) => sum + estimateTokens(t.query) + estimateTokens(t.reply ?? ''), 0);
}

/** token 预算触发：累计估算 token ≥ 预算（maxTokens ≤ 0 视为不启用）。 */
export function shouldTriggerL1ByTokens(tokens: number, maxTokens: number): boolean {
  return maxTokens > 0 && tokens >= maxTokens;
}

/** 追加一轮并封顶：超出容量丢弃最旧（防止缓冲无界增长，L1 是工作区不是仓库）。 */
export function appendL1(turns: L1Turn[], turn: L1Turn, capacity: number): L1Turn[] {
  const next = [...turns, turn];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/** 从缓冲中精确移除某批轮次（总结并发时防止误清新进轮次）。 */
export function removeL1Turns(turns: L1Turn[], toRemove: readonly L1Turn[]): L1Turn[] {
  const ids = new Set(toRemove);
  return turns.filter((t) => !ids.has(t));
}

/** 每轮写入提示词的文本上限（token 预算化：防长回复把提示词撑爆）。 */
const TRUNC_QUERY_CHARS = 300;
const TRUNC_REPLY_CHARS = 600;

function truncate(text: string, max: number): string {
  const s = text ?? '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 总结层 LLM 提示词：把 L1 缓冲轮次 + 现有记忆相似候选，总结为
 * JSON { memories: [{content, category, importance, scope}], knowledge: [{content, topic}] }。
 * @param turns  缓冲轮次
 * @param similar 每条缓冲轮的相似记忆（BM25 top-k，喂给 LLM 做合并/冲突参考）
 * @param knownAttrs claims 的 attribute 白名单（缺省取 attributes.ts 的规范词表）
 */
export function buildSummarizePrompt(
  turns: L1Turn[],
  similar: Array<{ id: string; content: string }>,
  knownAttrs: readonly string[] = CANONICAL_ATTRS,
): string {
  const lines = turns.map((t) => `- [${t.kind}] ${t.preset}｜用户：${truncate(t.query, TRUNC_QUERY_CHARS)}｜physicist：${truncate(t.reply || '', TRUNC_REPLY_CHARS)}`);
  const similarBlock = similar.length ? similar.map((s) => `  - ${s.id}：${s.content}`).join('\n') : '  （无相似记忆）';
  return [
    '你是分层记忆的总结层。下面是一段 L1 工作区缓冲的对话轮次（每轮含用户提问与回复；kind=fact 是用户事实，kind=knowledge 是物理/数学知识）。',
    '请总结为 JSON（不要输出其他内容）：',
    '{"memories":[{"content":"第一人称记忆内容","category":"user_fact|study_log|preference|relationship|session_summary","importance":0-100,"scope":"mode|global","claims":[{"attribute":"属性名","value":"值"}]}],"knowledge":[{"content":"知识条目","topic":"主题标签"}]}',
    '规则：',
    '1. memories 只记关于用户的稳定事实：身份、学习计划、进度、偏好、关系；重复信息合并为一条；闲聊/情绪/一次性的不记；',
    '2. scope 判定：跨角色稳定事实（身份/长期偏好/基本习惯）→ global；角色相关（学习计划/进度/课程/日程）→ mode；',
    '3. knowledge 记可复用的物理/数学知识点（公式、定律、方法），每次提问一条，去重；',
    '4. 不确定的 memories 宁缺毋滥（skip），不要编造。',
    `5. claims=该记忆的属性断言（可选，≤${MAX_CLAIMS_PER_CANDIDATE} 条）；attribute 只能取：${knownAttrs.join('/')}；value ≤20 字。`,
    '   例：考试=下周三、作息=早上做数学题。无明确属性则省略 claims。',
    '现有记忆相似候选（供合并/更新参考，不强制使用）：',
    similarBlock,
    '对话轮次：',
    lines.join('\n'),
  ].join('\n');
}

/**
 * 规则层兜底卸载（LLM 未启用时）：逐轮 decide()。
 * 显式"记住"类已走即时通道不会进缓冲；这里只处理缓冲里的 fact/knowledge 轮。
 * fact 轮只保留规则层判定为 save 的（其余 pending/skip 视为无定论，丢弃并计数）。
 */
export function fallbackUnload(turns: L1Turn[]): { result: L1SummarizeResult; dropped: number } {
  const memories: L1MemoryCandidate[] = [];
  const knowledge: L1KnowledgeCandidate[] = [];
  let dropped = 0;
  for (const t of turns) {
    if (t.kind === 'knowledge') {
      // 第三关：topic 不再固定"用户提问"，按内容提取（公式/拉丁符号优先）
      knowledge.push({ content: extractMemory(t.query), topic: classifyKnowledgeTopic(t.query) });
      continue;
    }
    const d = decide(t.query, t.reply);
    if (d.kind === 'save') {
      const scope: 'mode' | 'global' = d.category === 'user_fact' ? 'global' : 'mode';
      memories.push({ content: d.content, category: d.category, importance: d.importance, scope });
    } else {
      dropped++;
    }
  }
  return { result: { memories, knowledge }, dropped };
}

export interface ExistingMemoryRef {
  id: string;
  content: string;
}

/**
 * 落库前查重（规则级 consolidate）：
 *  - BM25 top-1 命中，且 bigram 重叠相似度（|∩|/min，有界 [0,1]）≥ 0.5：
 *    - 内容含时间证据（考完/学会/结束…）→ supersede（替换旧记忆）
 *    - 否则 → merge（合并进旧记忆）
 *  - 否则 → save（新记忆）
 * 第三关：相似度改用有界 overlapScore（原裸 BM25 分数无量纲、随语料漂移，0.8 阈值脆弱）。
 */
export function consolidateTarget(content: string, existing: ExistingMemoryRef[]): { action: 'save' | 'merge' | 'supersede'; targetId?: string } {
  const hits = bm25Search(content, existing, 1);
  if (hits.length > 0) {
    const hit = existing.find((e) => e.id === hits[0].id);
    if (hit && overlapScore(content, hit.content) >= 0.5) {
      if (hasTimeEvidence(content)) return { action: 'supersede', targetId: hit.id };
      return { action: 'merge', targetId: hit.id };
    }
  }
  return { action: 'save' };
}

/** 兜底提示词（给 /memory l1 命令展示缓冲内容）。 */
export function describeL1Turn(t: L1Turn): string {
  return `${t.preset}｜[${t.kind}] ${t.query.slice(0, 40)}${t.reply ? ' → ' + t.reply.slice(0, 30) : ''}`;
}
