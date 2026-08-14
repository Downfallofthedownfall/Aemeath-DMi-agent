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

export type { Category };
