// ============================================================
// handoff.ts — Übungen → 主 agent 的单向握手（**沿用 lecture 的 handoff**
//
// 用户要求："可以直接借用 lecture 的 handoff"。
// 这里就是字面意义上的借用：
//   · schema **继承** lecture 的 `handoffSchema`（progress / weak_points / units / claims 四个字段
//     名字和语义完全一致），只 **extend** 出 `kind` / `lessons` / `mistakes` 三个习题专有字段
//   · 写文件用 lecture 的 `writeHandoff`（同一套落盘行为）
//   · 因此主 agent 侧既可以用 lecture 的 `lecture_import_handoff`（只吃通用四字段），
//     也可以用 exercise 自己的导入工具（额外把 lessons 写进 worldbook）
//
// 为什么还要 extend：
//   · 通用四字段装不下"经验"（那是习题模块最有价值的产物，要进 worldbook）
//   · 而 lecture 的 schema 是**非 strict** 的：extend 出来的字段若走它的解析会被 strip，
//     所以习题的接收侧必须用自己的 schema 读（见 import-handoff.ts）
//
// 方向仍然是单向（lecture 的 D7）：exercise → 主 agent，靠文件搬运，不做 HTTP 推送。
// ============================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { handoffSchema as lectureHandoffSchema, writeHandoff } from '@aemeath/dsh-plugin-lecture/handoff';
import { shouldCollectMistake, sheetProgress, type CourseIndex, type Mistake, type Sheet } from './types.js';

/** 习题握手包 = lecture 的通用字段 + 习题专有字段。 */
export const exerciseHandoffSchema = lectureHandoffSchema.extend({
  kind: z.literal('exercise').default('exercise'),
  /** 每套题的经验（**进 worldbook 的就是它**） */
  lessons: z
    .array(
      z.object({
        sheet: z.string(),
        text: z.string(),
        tags: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** 错题快照（接收侧据此写错题本 + 生成教训条目） */
  mistakes: z
    .array(
      z.object({
        id: z.string(),
        sheet: z.string(),
        problem: z.string(),
        label: z.string().default(''),
        verdict: z.string().default('wrong'),
        issues: z.array(z.string()).default([]),
        lesson: z.string().default(''),
        tags: z.array(z.string()).default([]),
        mastered: z.boolean().default(false),
      }),
    )
    .default([]),
});

export type ExerciseHandoff = z.infer<typeof exerciseHandoffSchema>;

export interface BuildExerciseHandoffInput {
  index: CourseIndex;
  sheets: readonly Sheet[];
  mistakes: readonly Mistake[];
  now?: number;
}

/**
 * 组装习题握手包（纯函数）。
 *
 * 只传"可复习的结论"，不传原始速记/检查原文：
 *   · 答案正文 **不传**（避免把整套解答拖过网）
 *   · 检查原文 raw **不传**（可能很长，且含模型废话）
 *   · 错题的 issues / lesson 传（那是教训本体）
 */
export function buildExerciseHandoff(input: BuildExerciseHandoffInput): ExerciseHandoff {
  const { index, mistakes } = input;
  const sheets = [...input.sheets].sort((a, b) => a.number - b.number);
  const progress: ExerciseHandoff['progress'] = [];
  const weakPoints: ExerciseHandoff['weak_points'] = [];
  const units: ExerciseHandoff['units'] = [];
  const claims: ExerciseHandoff['claims'] = [];
  const lessons: ExerciseHandoff['lessons'] = [];
  const mistakeViews: ExerciseHandoff['mistakes'] = [];

  for (const sheet of sheets) {
    const prog = sheetProgress(sheet);
    const submitted = sheet.submitted_at > 0;
    progress.push({
      unit: sheet.id,
      title: `Übungsblatt ${sheet.number}${sheet.title ? ` — ${sheet.title}` : ''}`,
      date: sheet.issued || sheet.due,
      reviewed: submitted,
    });
    units.push({
      unit: sheet.id,
      title: sheet.title || `Übungsblatt ${sheet.number}`,
      topics: sheet.problems.map((p) => p.label || p.id).slice(0, 20),
      summary_ref: submitted ? sheet.submission_pdf : '',
    });

    // 进度断言：只有**已提交**的套才算"学完了"（否则会污染用户画像的时间轴）
    if (submitted) {
      claims.push({
        unit: sheet.id,
        entity: '用户',
        attribute: 'ubung_progress',
        value: `Übungsblatt ${sheet.number} 已提交（${prog.answered}/${prog.total} 题作答，${prog.checked} 题检查通过）`,
      });
    }

    for (const l of sheet.lessons) {
      if (!l.text.trim()) continue;
      lessons.push({ sheet: sheet.id, text: l.text.trim().slice(0, 600), tags: l.tags.slice(0, 6) });
    }
  }

  for (const m of mistakes) {
    const text = (m.lesson || m.issues.join('；') || '').trim();
    if (!text) continue;
    weakPoints.push({
      unit: m.sheet_id,
      topic: `${m.problem_label || m.problem_id}：${text}`.slice(0, 200),
      evidence: m.verdict === 'partial' ? '检查：部分正确' : '检查：错误',
      // 未掌握的错题更需要被主 agent 提醒
      confidence: m.mastered ? 0.4 : 0.75,
    });
    mistakeViews.push({
      id: m.id,
      sheet: m.sheet_id,
      problem: m.problem_id,
      label: m.problem_label,
      verdict: m.verdict,
      issues: m.issues.slice(0, 5),
      lesson: m.lesson,
      tags: m.tags.slice(0, 6),
      mastered: m.mastered,
    });
  }

  return {
    kind: 'exercise',
    version: 1,
    generated_at: new Date(input.now ?? Date.now()).toISOString(),
    course: { id: index.course_id, title: index.title, module: index.module_code },
    progress,
    weak_points: weakPoints,
    units,
    claims,
    lessons,
    mistakes: mistakeViews,
  };
}

/** 写握手文件（借用 lecture 的 writeHandoff：同一套落盘行为）。 */
export function writeExerciseHandoff(handoff: ExerciseHandoff, targetDir: string, filename?: string): string {
  const name = filename ?? `${handoff.course.id}-exercise-handoff.json`;
  return writeHandoff(handoff, targetDir, name);
}

/** 读握手文件（畸形返回 null；**用习题自己的 schema**，否则 lessons 会被 strip）。 */
export function readExerciseHandoff(file: string): ExerciseHandoff | null {
  const abs = isAbsolute(file) ? file : join(process.cwd(), file);
  if (!existsSync(abs)) return null;
  try {
    const raw = readFileSync(abs, 'utf-8');
    const parsed = exerciseHandoffSchema.safeParse(JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 扫描目录下的习题握手包。
 *
 * 文件名刻意用 `*-exercise-handoff.json` 而不是 lecture 的 `*-handoff.json`：
 * 主 agent 的 `lecture_import_handoff` 用 `*-handoff.json` 做 glob，
 * 两边同名会让同一批数据被两个工具各导一次（记忆重复、审计噪音）。
 */
export function findExerciseHandoffs(dir: string): string[] {
  const abs = isAbsolute(dir) ? dir : join(process.cwd(), dir);
  if (!existsSync(abs)) return [];
  try {
    return readdirSync(abs)
      .filter((f) => f.endsWith('-exercise-handoff.json'))
      .map((f) => join(abs, f))
      .sort();
  } catch {
    return [];
  }
}

/** 人工上传前核对用摘要（不含答案与检查原文）。 */
export function describeExerciseHandoff(h: ExerciseHandoff): string {
  const submitted = h.progress.filter((p) => p.reviewed).length;
  const unmastered = h.mistakes.filter((m) => !m.mastered).length;
  return [
    `课程：${h.course.title}（${h.course.id}${h.course.module ? ` / ${h.course.module}` : ''}）`,
    `套数：${h.progress.length}，其中已提交 ${submitted}`,
    `错题：${h.mistakes.length} 条（未掌握 ${unmastered}）`,
    `经验：${h.lessons.length} 条`,
    `生成时间：${h.generated_at}`,
  ].join('\n');
}

/** 确保目录存在（导出前调用）。 */
export function ensureDir(dir: string): string {
  const abs = isAbsolute(dir) ? dir : join(process.cwd(), dir);
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  return abs;
}

/** 供上层判断"这套题里有没有值得导出的错题"（避免导出空包）。 */
export function hasExportableContent(sheets: readonly Sheet[], mistakes: readonly Mistake[]): boolean {
  if (mistakes.some((m) => !m.mastered && (m.lesson.trim() || m.issues.length))) return true;
  return sheets.some((s) => s.lessons.some((l) => l.text.trim()) || s.problems.some((p) => shouldCollectMistake(p.checks)));
}

/** 便捷：把错题按 sheet 分组（UI/摘要用）。 */
export function groupMistakesBySheet(mistakes: readonly Mistake[]): Map<string, Mistake[]> {
  const map = new Map<string, Mistake[]>();
  for (const m of mistakes) {
    const key = m.sheet_id || 'unknown';
    const arr = map.get(key) ?? [];
    arr.push(m);
    map.set(key, arr);
  }
  return map;
}

/** 写文件前的字节级 sanity：JSON 里不能有未转义的控制字符（手改过的 lesson 可能带 \u0000）。 */
export function sanitizeForJson(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 供 store 层落盘前收敛（导出给测试用，确保非法字符不会破坏 JSON）。 */
export function writeJsonSafe(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}
