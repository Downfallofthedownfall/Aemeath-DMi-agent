// ============================================================
// types.ts — 记忆公共类型（domain 记录 schema 的 TS 侧类型）
// ============================================================
import { z } from 'zod';
import type { Category } from './gatekeeper.js';

export const memoryRecordSchema = z.object({
  id: z.string(),
  scope: z.enum(['mode', 'global']),
  preset: z.string(),
  content: z.string(),
  category: z.enum(['user_fact', 'study_log', 'preference', 'relationship', 'session_summary']),
  importance: z.number(),
  confidence: z.number(),
  source_mode: z.string(),
  created_at: z.number(),
  last_access: z.number(),
  status: z.enum(['active', 'dormant']),
  superseded_by: z.string().nullable().optional(),
  deleted: z.boolean().nullable().optional(),
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const auditRecordSchema = z.object({
  id: z.string(),
  ts: z.number(),
  action: z.string(),
  memory_id: z.string().nullable().optional(),
  detail: z.string(),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export const userProfileSchema = z.object({ facts: z.array(z.string()) });
export type UserProfile = z.infer<typeof userProfileSchema>;

/**
 * L1 采集缓冲记录（持久化在域内，攒批省 token：未达最小批次的轮次留待下次会话继续攒）。
 * 结构对齐 layers.ts 的 L1Turn 逻辑类型（单源以本 schema 为准）。
 */
export const l1TurnSchema = z.object({
  sessionId: z.string(),
  query: z.string(),
  reply: z.string(),
  preset: z.string(),
  ts: z.number(),
  kind: z.enum(['fact', 'knowledge']),
});
export type L1Turn = z.infer<typeof l1TurnSchema>;
/** L1 域表值 schema：每会话一条记录（key=sessionId，value=轮次数组）。 */
export const l1TurnsSchema = z.array(l1TurnSchema);

/**
 * 知识层记录（分层记忆设想 · 知识路由写入目标）。
 * 来源：① 规则层初筛直达（公式/定律/显式"记住"关键词，status='accepted'，不经 LLM）；
 *       ② LLM 总结层审核（攒批，status='pending' 等待人工评审）。
 * worldbook 仍是只读的精选知识（人工内容轨）；本表是可写知识层，
 * accepted 条目同步桥接进 worldbook 生成文件（generated_knowledge.json，热重载生效）。
 */
export const knowledgeRecordSchema = z.object({
  id: z.string(),
  preset: z.string(),
  content: z.string(),
  topic: z.string(),
  source_kind: z.enum(['user_query', 'llm_extract']),
  status: z.enum(['pending', 'accepted', 'rejected']),
  created_at: z.number(),
  source_session: z.string(),
});
export type KnowledgeRecord = z.infer<typeof knowledgeRecordSchema>;

/**
 * 关系/情绪上下文记录（A3 mood observer + A4 relationship cue，借 Cyrene
 * 桌面伴侣的"mood observer + relationship context"思路，只取思想不复制代码）。
 * 按 preset（角色/人格）各存一份：mood 为平滑后的角色当前情绪标签，signal 为
 * 关系信号，preference 为用户偏好，nextCareCue 为下一轮"照顾提示"。
 * 供 ctx.memory.recallRelationshipCue() 生成【近期关系线索】注入块。
 */
export const relationshipRecordSchema = z.object({
  mood: z.string(),
  moodTs: z.number(),
  signal: z.string(),
  preference: z.string(),
  nextCareCue: z.string(),
  updatedTs: z.number(),
});
export type RelationshipRecord = z.infer<typeof relationshipRecordSchema>;

export type { Category };
