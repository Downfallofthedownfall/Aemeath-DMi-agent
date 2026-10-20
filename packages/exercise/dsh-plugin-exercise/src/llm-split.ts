// ============================================================
// llm-split.ts — 用 LLM 把 Übungsblatt 文本切成一道道题
//
// 为什么不再只靠正则（用户实测反馈）：
//   LaTeX 排出的 PDF 抽出来的文本常常是这样的：
//       Aufgabe 1 (4 Punkte) Ein Körper der Masse m = 2 kg gleitet
//       reibungsfrei eine schiefe Ebene ... a) b)
//   题号行和正文粘在一起、公式被拆成散字母、分页把一道题劈成两半 ——
//   规则切分在这种文本上"看起来能跑"，实际切得乱七八糟。
//   模型读得懂"哪一句是新题的开头"，所以**首选 LLM**，规则只作兜底。
//
// 约束（与 checker 同一套纪律）：
//   · 只切分，**不改写**：不许翻译、不许补全公式、不许合并/总结
//   · 子问 a)/b)/i) 留在父题里
//   · 输出必须覆盖原文（覆盖率过低视为失败，退回规则分块）
//   · 一次调用失败不影响导入：调用方拿到 ok:false 就退回规则
//
// 本文件是纯函数（prompt 组装 + 输出解析 + 分块），LLM 由 index.ts 注入。
// ============================================================

import { z } from 'zod';
import { repairTruncatedJson, type AskLlm } from './checker.js';
import type { SplitProblem } from './split.js';

/** 单次送模型的字符上限（留出 prompt 与输出的余量）。 */
export const SEGMENT_CHUNK_CHARS = 18_000;
/** 超过这么多部分就直接放弃 LLM（避免一次导入烧掉十几万 token）。 */
export const SEGMENT_MAX_PARTS = 6;
/** 切出来的题数上限（防御模型把每一行都当一道题）。 */
const MAX_PROBLEMS = 40;
/** 覆盖率下限：切出来的正文总长 / 原文非空白字符。（低于此值说明模型丢了大段内容） */
const MIN_COVERAGE = 0.55;

const partSchema = z.object({
  label: z.string().default(''),
  title: z.string().default(''),
  text: z.string(),
  points: z.number().nullable().default(null),
  page: z.number().default(0),
});

const outputSchema = z.object({
  problems: z.array(partSchema).default([]),
});

export interface SegmentResult {
  ok: boolean;
  problems: SplitProblem[];
  /** 送了几段（长文档会分块） */
  parts: number;
  /** 失败原因（ok=false 时给调用方写进 warnings） */
  error?: string;
  /** 覆盖率（排障用） */
  coverage?: number;
  raw?: string;
}

/** 组装切题 prompt。`index/total` > 1 时明确告诉模型"这只是其中一段"。 */
export function buildSegmentPrompt(text: string, index = 1, total = 1): string {
  const lines: string[] = [];
  lines.push('你在把一份德语/英语的 Übungsblatt（大学物理/数学作业）的纯文本切分成一道道题。');
  lines.push('');
  lines.push('## 硬性规则');
  lines.push('1. **只切分，不改写**：不要翻译、不要改写、不要补全公式、不要总结。text 必须是原文片段（可以去掉行首行尾空白）。');
  lines.push('2. 题号与题干在同一行、或题号单独一行，都要正确归到该题。');
  lines.push('3. 子问 `a) b) c)` / `(i) (ii)` **留在父题**里，不要单独成题。');
  lines.push('4. 页眉/页脚/页码/姓名栏/"Abgabe: …" 这类**不属于任何题**的内容直接丢弃。');
  lines.push('5. 题号按原文写（`Aufgabe 1`、`1.`、`Problem 2` …）；没有题号的段落并入上一题。');
  lines.push('6. 分值从 `(4 Punkte)` / `[6 P]` / `（4 分）` 提取到 points，没有就 null。');
  lines.push('7. 只有真的跨页断裂、无法判断属于哪题时，才把 page 留 0。');
  if (total > 1) {
    lines.push(
      `8. **这是第 ${index}/${total} 段**：只切这一段的题。不要编造上一段/下一段的题，也不要把不完整的题补全。`,
    );
  }
  lines.push('');
  lines.push('## 输出格式（严格 JSON，不要代码块，不要多余文字）');
  lines.push('{"problems":[{"label":"Aufgabe 1","title":"短标题（≤40字）","text":"原文","points":4,"page":1}]}');
  lines.push('');
  lines.push(`## 待切分文本${total > 1 ? `（第 ${index}/${total} 段）` : ''}`);
  lines.push(text);
  return lines.join('\n');
}

/** 解析模型输出（与 checker 同一套抢救策略）。 */
export function parseSegmentOutput(raw: string | null): SplitProblem[] | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);

  const attempt = (json: string): unknown | null => {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  };
  let obj = attempt(candidate);
  if (obj === null) {
    const repaired = repairTruncatedJson(candidate);
    if (repaired) obj = attempt(repaired);
  }
  if (obj === null) return null;

  const parsed = outputSchema.safeParse(obj);
  if (!parsed.success) return null;

  const out: SplitProblem[] = [];
  for (const p of parsed.data.problems) {
    const body = (p.text ?? '').trim();
    if (!body) continue;
    out.push({
      label: (p.label ?? '').trim() || `Aufgabe ${out.length + 1}`,
      title: (p.title ?? '').trim() || firstLine(body),
      text: body,
      page: Number.isFinite(p.page) && p.page > 0 ? Math.floor(p.page) : 0,
      points: p.points == null || !Number.isFinite(p.points) ? null : p.points,
    });
    if (out.length >= MAX_PROBLEMS) break;
  }
  return out.length ? dedupe(out) : null;
}

function firstLine(text: string): string {
  const l = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  return l.length > 60 ? `${l.slice(0, 59)}…` : l;
}

/** 去掉完全重复的题（模型偶尔会把一段重复输出）。 */
function dedupe(list: SplitProblem[]): SplitProblem[] {
  const seen = new Set<string>();
  const out: SplitProblem[] = [];
  for (const p of list) {
    const key = `${p.label}\u0000${p.text.replace(/\s+/g, ' ').slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** 把长文本按页边界切成 ≤ limit 的段（保留 \f 以便模型判断页）。 */
export function chunkForSegmentation(text: string, limit = SEGMENT_CHUNK_CHARS): string[] {
  if (text.length <= limit) return [text];
  const pages = text.split('\f');
  const chunks: string[] = [];
  let cur = '';
  for (const page of pages) {
    const piece = page.length > limit ? page.slice(0, limit) : page;
    if (cur && cur.length + piece.length + 1 > limit) {
      chunks.push(cur.trim());
      cur = '';
    }
    cur += (cur ? '\f' : '') + piece;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}

/**
 * 跑一次 LLM 切题。
 *
 * 失败（模型不可用 / 输出不可解析 / 覆盖率过低）→ `ok:false`，
 * 调用方退回规则分块并把 error 写进导入提示。**绝不**因为切题失败而让导入失败。
 */
export async function segmentWithLlm(
  text: string,
  ask: AskLlm,
  opts: { chunkChars?: number; maxParts?: number } = {},
): Promise<SegmentResult> {
  const source = (text ?? '').trim();
  if (!source) return { ok: false, problems: [], parts: 0, error: '文本为空' };
  const chunks = chunkForSegmentation(source, opts.chunkChars ?? SEGMENT_CHUNK_CHARS);
  const maxParts = opts.maxParts ?? SEGMENT_MAX_PARTS;
  if (chunks.length > maxParts) {
    return { ok: false, problems: [], parts: chunks.length, error: `文本过长（${chunks.length} 段 > ${maxParts}），跳过 LLM 分块` };
  }

  const problems: SplitProblem[] = [];
  const raws: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const raw = await ask(buildSegmentPrompt(chunks[i]!, i + 1, chunks.length), {
      maxTokens: 3000,
      purpose: `exercise-segment-${i + 1}`,
    });
    if (!raw) {
      return { ok: false, problems: [], parts: chunks.length, error: 'LLM 不可用或请求失败' };
    }
    raws.push(raw);
    const parsed = parseSegmentOutput(raw);
    if (!parsed) {
      return { ok: false, problems: [], parts: chunks.length, error: 'LLM 输出不可解析（不是预期的 JSON）', raw };
    }
    problems.push(...parsed);
  }

  const merged = dedupe(problems);
  if (!merged.length) return { ok: false, problems: [], parts: chunks.length, error: 'LLM 没有切出任何题' };

  // 覆盖率护栏：模型偷懒（只给标题、丢正文）时会明显低于阈值
  const norm = (s: string): string => s.replace(/\s+/g, '');
  const srcLen = norm(source).length;
  const outLen = norm(merged.map((p) => p.text).join('')).length;
  const coverage = srcLen ? outLen / srcLen : 1;
  if (coverage < MIN_COVERAGE) {
    return {
      ok: false,
      problems: merged,
      parts: chunks.length,
      coverage,
      error: `切出的正文只覆盖原文 ${(coverage * 100).toFixed(0)}%（< ${Math.round(MIN_COVERAGE * 100)}%），退回规则分块`,
      raw: raws.join('\n---\n'),
    };
  }

  return { ok: true, problems: merged, parts: chunks.length, coverage, raw: raws.join('\n---\n') };
}
