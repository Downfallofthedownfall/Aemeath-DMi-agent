// ============================================================
// types.ts — 记忆公共类型（domain 记录 schema 的 TS 侧类型）
// ============================================================
import { z } from 'zod';
import type { Category } from './gatekeeper.js';

export const entityClaimSchema = z.object({
  entity: z.string(),
  attribute: z.string(),
  value: z.string(),
  valid_from: z.number(),
  valid_until: z.number().nullable(),
});
export type EntityClaimRecord = z.infer<typeof entityClaimSchema>;

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
  // 借 Cyrene L2 激活得分缓存的"partial DMAE 记忆生命周期"思想：给每条记录一个
  // activation（默认 50），驱动三态分类（active/dormant/archived）。字段名向后兼容。
  activation: z.number().default(50),
  // 三态生命周期状态：active（活跃召回）/ dormant（衰减降级）/ archived（归档）
  // —— 在原有 active|dormant 基础上扩展 archived（激活分类：≥60 active，30–59 dormant，<30 archived）。
  status: z.enum(['active', 'dormant', 'archived']),
  superseded_by: z.string().nullable().optional(),
  deleted: z.boolean().nullable().optional(),
  // T1（借 ripples-of-aion 的 entityClaims/valid_until 思想）：事实时间轴断言。
  // 缺省 = 无属性化断言（旧数据不受影响，只增不改既有字段）。
  entity_claims: z.array(entityClaimSchema).optional(),
  // T5：上次**落盘**召回回写的时间戳（节流锚点，与 last_access 区分：
  // last_access 表示"逻辑上最近访问"，每次召回都推进；last_persist_at 只在真正落盘时推进）。
  last_persist_at: z.number().optional(),
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

/**
 * T3（借 ripples-of-aion autoDream）：空闲整合洞察记录。
 * 独立存储、单条（key='current'）；**只存 recordIds + label/note，绝不复制 content**，
 * 也绝不改写 memories 表——洞察层是"只读视角"，不是第二份记忆。
 */
export const insightClusterSchema = z.object({
  id: z.string(),
  label: z.string(),
  recordIds: z.array(z.string()),
  created_at: z.number(),
});
export const insightConflictSchema = z.object({
  id: z.string(),
  note: z.string(),
  recordIds: z.tuple([z.string(), z.string()]),
  created_at: z.number(),
});
export const insightsSchema = z.object({
  version: z.literal(1),
  last_run_at: z.number(),
  clusters: z.array(insightClusterSchema),
  conflicts: z.array(insightConflictSchema),
});
export type InsightCluster = z.infer<typeof insightClusterSchema>;
export type InsightConflict = z.infer<typeof insightConflictSchema>;
export type Insights = z.infer<typeof insightsSchema>;
/** 空洞察（首次运行/结构不合法时的回落值）。 */
export const EMPTY_INSIGHTS: Insights = { version: 1, last_run_at: 0, clusters: [], conflicts: [] };

export type { Category };
