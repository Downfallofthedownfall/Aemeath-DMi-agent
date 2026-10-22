// ============================================================
// vision.ts — 让多模态模型直接"看卷子"（替代不可靠的 OCR 文本分块）
//
// 用户实测反馈：
//   "习题文字 OCR 不太准还会漏掉图片，所以不要文字模式而是放一张截图之类的，
//    llm 纠错也用模型多模态能力，或者直接上传 pdf 用 llm 的多模态读取更准确"。
//
// 设计（按页请求，而不是一次塞全部页）：
//   · 输出体积小 → 不会被 max_tokens 截断（文本链路踩过这个坑）
//   · 每页天然知道页码 → `page` 字段不需要模型猜
//   · 跨页的题：模型在下一页用 `continues: "Aufgabe 2"` 标出"这是上一页某题的续文"，
//     `mergeVisionPages()` 把续文并回父题（不会变成"两道同名题"）
//
// 纪律：
//   · 逐字转录，不许翻译/简化；公式用 LaTeX
//   · 页眉/页脚/页码/"Abgabe" 不进任何题
//   · 插图：has_figure=true + figure_note 一句话描述（图本身由界面显示原页截图兜底）
//   · 每页都失败才整体失败；调用方退回"文本锚点 → 规则"链路
//
// 本文件纯函数（prompt 组装 / 解析 / 合并 / 调度），真正的 HTTP 请求由 index.ts 注入。
// ============================================================

import { z } from 'zod';
import { parseJsonLoose } from './checker.js';
import type { SplitProblem } from './split.js';

/** 多模态通道（index.ts 注入：直连 + 全局凭据 + 关闭推理）。 */
export type AskVision = (
  prompt: string,
  images: readonly { mediaType: string; base64: string }[],
  opts: { maxTokens: number; purpose: string; /** 推理强度（多模态默认 off；批改带学生手画图时用 high/max） */ reasoning?: 'off' | 'low' | 'high' | 'max' },
) => Promise<string | null>;

export interface VisionPage {
  page: number;
  mediaType: string;
  /** base64（不带 data: 前缀） */
  base64: string;
}

const MAX_PROBLEMS = 40;
const MIN_TEXT_CHARS = 15;

const problemSchema = z.object({
  label: z.string().default(''),
  text: z.string().default(''),
  points: z.number().nullable().default(null),
  page: z.number().default(0),
  has_figure: z.boolean().default(false),
  figure_note: z.string().default(''),
  /** 非空 = 这是上一页某题的续文（值是那道题的题号） */
  continues: z.string().default(''),
});

const outputSchema = z.object({
  problems: z.array(problemSchema).default([]),
});

export interface VisionProblem {
  label: string;
  text: string;
  points: number | null;
  page: number;
  has_figure: boolean;
  figure_note: string;
  continues: string;
}

export interface VisionSegmentResult {
  ok: boolean;
  problems: SplitProblem[];
  /** 用了几页图片 */
  pages: number;
  error?: string;
  raw?: string;
}

/** 组装单页的读图 prompt。 */
export function buildVisionPrompt(page: number, total: number): string {
  const lines: string[] = [];
  lines.push(`你在看一份德语/英语的 Übungsblatt（大学物理/数学作业）的**第 ${page} 页（共 ${total} 页）的截图**。`);
  lines.push('');
  lines.push('## 你要做的事');
  lines.push('把**这一页上出现的题目**逐字转录下来（后面程序会按题分块）。只回 JSON。');
  lines.push('');
  lines.push('## 硬性规则');
  lines.push('1. `text` 逐字转录本页上属于该题的正文（含 a) b) c) 子问）；不要翻译、不要改写、不要省略。');
  lines.push('2. 公式用 LaTeX：行内 `$...$`，独立一行 `$$...$$`（例如 $a = g\\sin\\alpha$）。');
  lines.push('3. 若某题**从上一页延续**到本页：把上一页的题号写进 `continues`（如 "Aufgabe 2"），`text` 只写本页的**续文**，不要重复题号行。');
  lines.push('4. 若某题在本页**开始**（哪怕延续到下一页）：正常给 `label` 与本题在本页的文本。');
  lines.push('5. 页眉/页脚/页码/姓名栏/"Abgabe: …"/"bitte wenden" 都不属于任何题，别写进 `text`。');
  lines.push('6. 有插图/示意图/表格：`has_figure` = true，`figure_note` 用一句话中文描述（例："斜面与物块的受力图"），并在 `text` 里保留图注文字（如 "Abb. 1"）。');
  lines.push('7. `points` 从 `(4 Punkte)` / `[6 P]` / `（4 分）` 提取，没有就 null。');
  lines.push('8. `page` 一律填 ' + page + '。');
  lines.push('');
  lines.push('## 输出格式（严格 JSON，不要代码块，不要多余文字）');
  lines.push(
    `{"problems":[{"label":"Aufgabe 1","text":"…","points":4,"page":${page},"has_figure":false,"figure_note":"","continues":""}]}`,
  );
  return lines.join('\n');
}

/** 解析一页的模型输出（fenced / 截断都可）。 */
export function parseVisionOutput(raw: string | null): VisionProblem[] | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);

  const obj = parseJsonLoose(candidate);
  if (obj === null) return null;

  const parsed = outputSchema.safeParse(obj);
  if (!parsed.success) return null;

  const out: VisionProblem[] = [];
  for (const p of parsed.data.problems) {
    const body = (p.text ?? '').trim();
    const continues = (p.continues ?? '').trim();
    // 续文允许短（"siehe oben" 之类），新题正文太短就没意义
    if (!body) continue;
    if (!continues && body.length < MIN_TEXT_CHARS) continue;
    out.push({
      label: (p.label ?? '').trim(),
      text: body,
      points: p.points == null || !Number.isFinite(p.points) ? null : p.points,
      page: Number.isFinite(p.page) && p.page > 0 ? Math.floor(p.page) : 0,
      has_figure: p.has_figure === true,
      figure_note: (p.figure_note ?? '').trim().slice(0, 120),
      continues,
    });
    if (out.length >= MAX_PROBLEMS) break;
  }
  // ⚠️ 空数组是**合法结果**（空白页/只有页脚的页）：解析成功但没有题目。
  // 只有"解析不了"才返回 null —— 否则一页空白就会把整份卷子的读图链路判死。
  return out;
}

/**
 * 合并多页结果：`continues` 指向的续文并回父题（按题号对齐）。
 *
 * 同一题号在本页重复出现（模型没标 continues）也按"续文"处理 ——
 * 宁可多并一段，也不要出现两道同名题。
 */
export function mergeVisionPages(pages: readonly { page: number; problems: readonly VisionProblem[] }[]): SplitProblem[] {
  interface Acc {
    label: string;
    parts: string[];
    points: number | null;
    page: number;
    hasFigure: boolean;
    figureNote: string;
  }
  const acc: Acc[] = [];
  const byLabel = new Map<string, number>();

  for (const page of [...pages].sort((a, b) => a.page - b.page)) {
    for (const p of page.problems) {
      const key = (p.continues || p.label || '').trim();
      const idx = key ? byLabel.get(key) : undefined;
      const target = idx === undefined ? undefined : acc[idx];
      if (target && (p.continues || p.label === target.label)) {
        target.parts.push(p.text);
        if (p.points != null) target.points = p.points;
        target.hasFigure = target.hasFigure || p.has_figure;
        if (!target.figureNote && p.figure_note) target.figureNote = p.figure_note;
        continue;
      }
      const label = p.label || `Aufgabe ${acc.length + 1}`;
      byLabel.set(label, acc.length);
      acc.push({
        label,
        parts: [p.text],
        points: p.points,
        page: p.page || page.page,
        hasFigure: p.has_figure,
        figureNote: p.figure_note,
      });
    }
  }

  return acc.map((a) => {
    const text = a.parts.join('\n').trim();
    return {
      label: a.label,
      title: firstLine(text),
      text,
      page: a.page,
      points: a.points,
      has_figure: a.hasFigure,
      figure_note: a.figureNote,
    };
  });
}

function firstLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const raw of lines) {
    const stripped = raw
      .replace(/^(Aufgabe|Aufg\.?|Übung|Exercise|Problem|Task|Hausaufgabe)\s*\d+\s*[).:]?\s*/i, '')
      .replace(/^\(?\d+([.,]\d+)?\s*(Punkte|P|Points|分)\)?\s*[:：]?\s*/i, '')
      .trim();
    if (stripped.length >= 12) return stripped.length > 60 ? `${stripped.slice(0, 59)}…` : stripped;
  }
  const first = lines[0] ?? '';
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/**
 * 逐页读图 → 合并成题目。
 *
 * 任何一页失败就整体失败（调用方退回文本链路）——
 * 半份卷子切出来的题比"退回规则分块"更糟。
 */
export async function segmentWithVision(
  pages: readonly VisionPage[],
  ask: AskVision,
  opts: { maxTokens?: number } = {},
): Promise<VisionSegmentResult> {
  if (!pages.length) return { ok: false, problems: [], pages: 0, error: '没有页面图片' };
  const total = pages.length;
  const collected: { page: number; problems: VisionProblem[] }[] = [];
  const raws: string[] = [];

  for (const p of [...pages].sort((a, b) => a.page - b.page)) {
    const raw = await ask(buildVisionPrompt(p.page, total), [{ mediaType: p.mediaType, base64: p.base64 }], {
      maxTokens: opts.maxTokens ?? 2500,
      purpose: `exercise-vision-${p.page}`,
    });
    if (!raw) {
      return { ok: false, problems: [], pages: total, error: `第 ${p.page} 页：模型没有返回内容`, raw: raws.join('\n---\n') };
    }
    raws.push(raw);
    const problems = parseVisionOutput(raw);
    if (problems === null) {
      return {
        ok: false,
        problems: [],
        pages: total,
        error: `第 ${p.page} 页：模型输出不是可解析的 JSON`,
        raw: raw.slice(0, 1500),
      };
    }
    collected.push({ page: p.page, problems });
  }

  const merged = mergeVisionPages(collected);
  if (!merged.length) {
    return { ok: false, problems: [], pages: total, error: '模型没有识别出任何题目', raw: raws.join('\n---\n').slice(0, 2000) };
  }
  return { ok: true, problems: merged, pages: total, raw: raws.join('\n---\n') };
}
