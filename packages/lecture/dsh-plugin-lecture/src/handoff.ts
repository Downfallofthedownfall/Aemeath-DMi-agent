// ============================================================
// handoff.ts — 与主 agent 的单向握手（D7）
//
// 只传三样（用户定案）：课程进度、用户短板、粗略单元内容。
// **不传**：课堂原始速记、加工中间态、复盘问答细节。
//
// 传输方式：局域网传文件（放学回家后人工上传）。
// 之所以不用 HTTP 做数据通道：跨机器 HTTP 需两边同时在线且有网络，
// 而流程是"回家再上传"，文件更稳（plan §7）。
//
// ⚠️ 接收侧必须跑 gatekeeper，不要直接 ctx.memory.save()
//    （其注释写明「守门员已判定后调用」，service.ts:134）。
// ============================================================

import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Candidates, CourseIndex, ReviewState, UnitMeta } from './types.js';

/** 握手包 schema（版本化：接收侧据 version 决定兼容策略）。 */
export const handoffSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  course: z.object({
    id: z.string(),
    title: z.string(),
    module: z.string().default(''),
  }),
  progress: z.array(
    z.object({
      unit: z.string(),
      title: z.string(),
      date: z.string(),
      reviewed: z.boolean(),
    }),
  ),
  weak_points: z.array(
    z.object({
      unit: z.string(),
      topic: z.string(),
      evidence: z.string().default(''),
      confidence: z.number().default(0.5),
    }),
  ),
  units: z.array(
    z.object({
      unit: z.string(),
      title: z.string(),
      topics: z.array(z.string()).default([]),
      summary_ref: z.string().default(''),
    }),
  ),
});
export type Handoff = z.infer<typeof handoffSchema>;

export interface BuildHandoffInput {
  index: CourseIndex;
  /** 每单元：候选条目（可能还没生成——只有复盘完的才有）。 */
  candidatesByUnit: Map<string, Candidates | null>;
  /** 每单元：复盘状态（用于提取短板）。 */
  reviewByUnit: Map<string, ReviewState | null>;
  now?: number;
}

/**
 * 组装握手包（纯函数，可单测）。
 *
 * 短板来源：复盘第 2 步的 missed + wrong_or_vague，
 * 以及第 4 步的 unresolved_questions（作为 topic 线索）。
 */
export function buildHandoff(input: BuildHandoffInput): Handoff {
  const { index, candidatesByUnit, reviewByUnit } = input;
  const progress: Handoff['progress'] = [];
  const weakPoints: Handoff['weak_points'] = [];
  const units: Handoff['units'] = [];

  for (const unit of index.units) {
    progress.push({ unit: unit.id, title: unit.title, date: unit.date, reviewed: unit.reviewed });

    // 粗略单元内容：从候选的 worldbook 条目标题提取 topics（不传正文）
    const cand = candidatesByUnit.get(unit.id) ?? null;
    const topics = cand ? cand.worldbook_entries.map((e) => e.title).filter(Boolean).slice(0, 20) : [];
    units.push({
      unit: unit.id,
      title: unit.title,
      topics,
      summary_ref: unit.has_summary ? `${unit.id}.summary.json` : '',
    });

    // 短板：只从**已复盘**单元提取（未复盘 = 没有可信的短板数据）
    if (!unit.reviewed) continue;
    const st = reviewByUnit.get(unit.id) ?? null;
    const comp = st?.comparison ?? null;
    for (const topic of [...(comp?.missed ?? []), ...(comp?.wrong_or_vague ?? [])]) {
      weakPoints.push({
        unit: unit.id,
        topic: topic.slice(0, 120),
        evidence: '复盘对照：漏掉或记错',
        // 记错（wrong_or_vague）比单纯漏掉更值得关注，置信度略高
        confidence: comp?.wrong_or_vague?.includes(topic) ? 0.7 : 0.5,
      });
    }
    for (const q of cand?.unresolved_questions ?? []) {
      weakPoints.push({ unit: unit.id, topic: q.slice(0, 120), evidence: '未解决问题', confidence: 0.6 });
    }
  }

  // 去重：同一 (unit, topic) 只留一条（保留最高 confidence）
  const dedup = new Map<string, Handoff['weak_points'][number]>();
  for (const w of weakPoints) {
    const key = `${w.unit}\u0000${w.topic}`;
    const prev = dedup.get(key);
    if (!prev || w.confidence > prev.confidence) dedup.set(key, w);
  }

  return {
    version: 1,
    generated_at: new Date(input.now ?? Date.now()).toISOString(),
    course: { id: index.course_id, title: index.title, module: index.module_code },
    progress,
    weak_points: [...dedup.values()],
    units,
  };
}

/**
 * 只允许**已复盘**的单元进入握手包（D4 门控）。
 *
 * 未复盘的单元：进度照传（reviewed=false，让主 agent 知道讲到哪了），
 * 但不传 topics/短板——因为加工与摘要都还没解锁。
 */
export function filterReviewed(handoff: Handoff): Handoff {
  const reviewed = new Set(handoff.progress.filter((p) => p.reviewed).map((p) => p.unit));
  return {
    ...handoff,
    weak_points: handoff.weak_points.filter((w) => reviewed.has(w.unit)),
    units: handoff.units.map((u) => (reviewed.has(u.unit) ? u : { unit: u.unit, title: u.title, topics: [], summary_ref: '' })),
  };
}

/** 写握手文件（默认落盘到 targetDir/handoff.json）。返回绝对路径。 */
export function writeHandoff(handoff: Handoff, targetDir: string, filename = 'handoff.json'): string {
  const abs = isAbsolute(targetDir) ? targetDir : join(process.cwd(), targetDir);
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  const out = join(abs, filename);
  writeFileSync(out, JSON.stringify(handoff, null, 2), 'utf-8');
  return out;
}

/** 读握手文件（接收侧用；畸形返回 null 而非抛）。 */
export function readHandoff(file: string): Handoff | null {
  const abs = isAbsolute(file) ? file : join(process.cwd(), file);
  if (!existsSync(abs)) return null;
  try {
    const parsed = handoffSchema.safeParse(JSON.parse(readFileSync(abs, 'utf-8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 握手包摘要（供人工上传前核对——"要传什么"必须可见）。
 * 不包含任何原始速记内容。
 */
export function describeHandoff(h: Handoff): string {
  const reviewed = h.progress.filter((p) => p.reviewed).length;
  return [
    `课程：${h.course.title}（${h.course.id}${h.course.module ? ' / ' + h.course.module : ''}）`,
    `进度：${h.progress.length} 讲，其中已复盘 ${reviewed} 讲`,
    `短板：${h.weak_points.length} 条`,
    `单元内容：${h.units.filter((u) => u.topics.length).length} 讲有主题`,
    `生成时间：${h.generated_at}`,
  ].join('\n');
}

/** 供 store 层调用的便捷入口：从 store 读取并组装。 */
export interface HandoffSource {
  index: CourseIndex;
  unit: UnitMeta;
  candidates: Candidates | null;
  review: ReviewState | null;
}
