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

import { search as bm25Search } from './bm25.js';
import type { Category } from './gatekeeper.js';
import { decide, extractMemory, hasTimeEvidence } from './gatekeeper.js';
import type { L1Turn } from './types.js';

/** 总结层产出的"用户记忆"候选（落 L2 mode / L3 global）。 */
export interface L1MemoryCandidate {
  content: string;
  category: Category;
  importance: number;
  scope: 'mode' | 'global';
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

/**
 * 总结层 LLM 提示词：把 L1 缓冲轮次 + 现有记忆相似候选，总结为
 * JSON { memories: [{content, category, importance, scope}], knowledge: [{content, topic}] }。
 * @param turns  缓冲轮次
 * @param similar 每条缓冲轮的相似记忆（BM25 top-k，喂给 LLM 做合并/冲突参考）
 */
export function buildSummarizePrompt(turns: L1Turn[], similar: Array<{ id: string; content: string }>): string {
  const lines = turns.map((t) => `- [${t.kind}] ${t.preset}｜用户：${t.query}｜星炬：${t.reply || '（无）'}`);
  const similarBlock = similar.length ? similar.map((s) => `  - ${s.id}：${s.content}`).join('\n') : '  （无相似记忆）';
  return [
    '你是分层记忆的总结层。下面是一段 L1 工作区缓冲的对话轮次（每轮含用户提问与回复；kind=fact 是用户事实，kind=knowledge 是物理/数学知识）。',
    '请总结为 JSON（不要输出其他内容）：',
    '{"memories":[{"content":"第一人称记忆内容","category":"user_fact|study_log|preference|relationship|session_summary","importance":0-100,"scope":"mode|global"}],"knowledge":[{"content":"知识条目","topic":"主题标签"}]}',
    '规则：',
    '1. memories 只记关于用户的稳定事实：身份、学习计划、进度、偏好、关系；重复信息合并为一条；闲聊/情绪/一次性的不记；',
    '2. scope 判定：跨角色稳定事实（身份/长期偏好/基本习惯）→ global；角色相关（学习计划/进度/课程/日程）→ mode；',
    '3. knowledge 记可复用的物理/数学知识点（公式、定律、方法），每次提问一条，去重；',
    '4. 不确定的 memories 宁缺毋滥（skip），不要编造。',
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
      knowledge.push({ content: extractMemory(t.query), topic: '用户提问' });
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
 *  - BM25 top-1 相似度 > 0.8 且内容含时间证据（考完/学会/结束…）→ supersede（替换旧记忆）
 *  - 相似度 > 0.8 → merge（合并进旧记忆）
 *  - 否则 → save（新记忆）
 */
export function consolidateTarget(content: string, existing: ExistingMemoryRef[]): { action: 'save' | 'merge' | 'supersede'; targetId?: string } {
  const hits = bm25Search(content, existing, 1);
  if (hits.length > 0 && hits[0].score > 0.8) {
    if (hasTimeEvidence(content)) return { action: 'supersede', targetId: hits[0].id };
    return { action: 'merge', targetId: hits[0].id };
  }
  return { action: 'save' };
}

/** 兜底提示词（给 /memory l1 命令展示缓冲内容）。 */
export function describeL1Turn(t: L1Turn): string {
  return `${t.preset}｜[${t.kind}] ${t.query.slice(0, 40)}${t.reply ? ' → ' + t.reply.slice(0, 30) : ''}`;
}
