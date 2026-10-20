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
// 2026-10-20 第二次改版（真机日志）：
//   第一版让模型**把每道题的正文原样抄进 JSON**。结果在长文档上：
//     `全局 LLM 返回空文本（deepseek-flash）` → 直连也空 → 退回规则分块。
//   原因是输出太长（几千字正文）+ 推理模型把 token 预算吃在 reasoning 上，
//   要么空、要么被 max-tokens 截断。
//
//   现在改成**只问边界（锚点）**：模型只回 label/points/起始句（40~120 字逐字照抄），
//   切分由本地 `locateAnchors()` 在原文上按锚点裁切。
//   好处：输出只有几百 token（不会被截断、省钱、快），而且**正文永远是原文**，
//   模型没有机会改写/翻译/漏段。
//
// 约束（与 checker 同一套纪律）：
//   · 只定位边界，**不改写**：不许翻译、不许补全公式、不许合并/总结
//   · 子问 a)/b)/i) 留在父题里（它们不是新锚点）
//   · 锚点找不到 / 覆盖率过低 → 判失败，退回规则分块（原因写进导入提示）
//   · 一次调用失败不影响导入：调用方拿到 ok:false 就退回规则
//
// 本文件是纯函数（prompt 组装 + 输出解析 + 锚点定位 + 分块），LLM 由 index.ts 注入。
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
/** 覆盖率下限：按锚点切出的正文总长 / 原文非空白字符。（低于此值说明锚点定得离谱） */
const MIN_COVERAGE = 0.55;
/** 锚点短于这个长度就没法可靠定位（模型经常只回 "Aufgabe 1"）。 */
const MIN_ANCHOR_CHARS = 12;

const anchorSchema = z.object({
  label: z.string().default(''),
  /** 该题正文的起始句，**逐字**取自原文 */
  start: z.string().default(''),
  points: z.number().nullable().default(null),
  page: z.number().default(0),
});

const outputSchema = z.object({
  problems: z.array(anchorSchema).default([]),
});

export interface AnchorPart {
  label: string;
  start: string;
  points: number | null;
  page: number;
}

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

/**
 * 组装切题 prompt。**只问边界**，不让模型抄正文（见文件头第二次改版说明）。
 * `index/total` > 1 时明确告诉模型"这只是其中一段"。
 */
export function buildSegmentPrompt(text: string, index = 1, total = 1): string {
  const lines: string[] = [];
  lines.push('你在把一份德语/英语的 Übungsblatt（大学物理/数学作业）的纯文本按题号分段。');
  lines.push('');
  lines.push('## 你要做的事');
  lines.push('**不要复制正文**。只找出每道题的**起始位置**，其余交给程序按锚点裁切。');
  lines.push('');
  lines.push('## 硬性规则');
  lines.push('1. 每道题给出一个 `start`：该题正文的**第一句**，从原文里**逐字照抄**（40~120 字符，含题号那行也可以）。');
  lines.push(`2. \`start\` 必须能在原文中一字不差地找到（标点、空格、公式符号都照原样，别改写成 LaTeX）。`);
  lines.push('3. 子问 `a) b) c)` / `(i) (ii)` **不是**新题，不要给它们 start。');
  lines.push('4. 页眉/页脚/页码/姓名栏/"Abgabe: …" **不是**题，不要给 start。');
  lines.push('5. 题号按原文写（`Aufgabe 1`、`1.`、`Problem 2` …）。');
  lines.push('6. 分值从 `(4 Punkte)` / `[6 P]` / `（4 分）` 提取到 points，没有就 null。');
  lines.push('7. 顺序必须与原文一致（按出现位置从前往后）。');
  if (total > 1) {
    lines.push(
      `8. **这是第 ${index}/${total} 段**：只给这一段的题。不要编造别段的题，也不要给不完整的题补 start。`,
    );
  }
  lines.push('');
  lines.push('## 输出格式（严格 JSON，不要代码块，不要多余文字）');
  lines.push('{"problems":[{"label":"Aufgabe 1","start":"Ein Körper der Masse m = 2 kg gleitet","points":4,"page":1}]}');
  lines.push('');
  lines.push(`## 待分段文本${total > 1 ? `（第 ${index}/${total} 段）` : ''}`);
  lines.push(text);
  return lines.join('\n');
}

/** 解析模型输出（与 checker 同一套抢救策略）。返回锚点，正文由本地裁切。 */
export function parseSegmentOutput(raw: string | null): AnchorPart[] | null {
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

  const out: AnchorPart[] = [];
  for (const p of parsed.data.problems) {
    const anchor = (p.start ?? '').trim();
    if (anchor.length < MIN_ANCHOR_CHARS) continue;
    out.push({
      label: (p.label ?? '').trim() || `Aufgabe ${out.length + 1}`,
      start: anchor.slice(0, 400),
      points: p.points == null || !Number.isFinite(p.points) ? null : p.points,
      page: Number.isFinite(p.page) && p.page > 0 ? Math.floor(p.page) : 0,
    });
    if (out.length >= MAX_PROBLEMS) break;
  }
  return out.length ? out : null;
}

/** 归一化：折叠所有空白（含换行），并记住每个归一化字符对应的原文位置。 */
function normalizeWithMap(source: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += ' ';
      map.push(i);
      pendingSpace = false;
    }
    text += ch;
    map.push(i);
  }
  return { text, map };
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * 按锚点在原文上裁切。
 *
 * 返回 `null` 表示锚点不可用（找不到/顺序全乱/覆盖率过低）——调用方退回规则分块，
 * 绝不"猜"着切。
 */
export function locateAnchors(source: string, anchors: readonly AnchorPart[]): SplitProblem[] | null {
  if (!source.trim() || !anchors.length) return null;
  const { text: hay, map } = normalizeWithMap(source);

  interface Hit {
    offset: number;
    anchor: AnchorPart;
  }
  const hits: Hit[] = [];
  for (const a of anchors) {
    const needle = norm(a.start);
    if (needle.length < MIN_ANCHOR_CHARS) return null;
    const at = hay.indexOf(needle);
    if (at === -1) return null;
    hits.push({ offset: map[at]!, anchor: a });
  }
  hits.sort((x, y) => x.offset - y.offset);

  // 同一个起点只能算一道题（模型偶尔重复报同一条）
  const unique: Hit[] = [];
  for (const h of hits) {
    if (unique.length && unique[unique.length - 1]!.offset === h.offset) continue;
    unique.push(h);
  }
  if (!unique.length) return null;

  const problems: SplitProblem[] = [];
  for (let i = 0; i < unique.length; i++) {
    const from = unique[i]!.offset;
    const to = i + 1 < unique.length ? unique[i + 1]!.offset : source.length;
    const body = stripTrailingHeading(source.slice(from, to).trim());
    if (!body) continue;
    problems.push({
      label: unique[i]!.anchor.label || `Aufgabe ${i + 1}`,
      title: firstLine(body),
      text: body,
      page: unique[i]!.anchor.page,
      points: unique[i]!.anchor.points ?? null,
    });
  }
  if (!problems.length) return null;

  const normLen = (s: string): number => s.replace(/\s+/g, '').length;
  const srcLen = normLen(source);
  const outLen = normLen(problems.map((p) => p.text).join(''));
  // 第一个锚点之前的页眉会被丢掉，所以覆盖率不必是 100%，但太低就说明切歪了
  if (srcLen > 0 && outLen / srcLen < MIN_COVERAGE) return null;

  return problems;
}

/**
 * 切片的末尾常带着**下一题的标题行**（锚点指向"下一题正文第一句"，标题行在它前面）。
 * 不去掉的话，上一题的正文会以 `Aufgabe 2 (6 Punkte)` 结尾。
 */
function stripTrailingHeading(text: string): string {
  const lines = text.split(/\r?\n/);
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]!.trim();
    if (!line) {
      end--;
      continue;
    }
    if (/^(Aufgabe|Aufg\.?|Übung|Exercise|Problem|Task|Hausaufgabe)\s*\d+/i.test(line) && line.length < 120) {
      end--;
      continue;
    }
    break;
  }
  return lines.slice(0, end).join('\n').trim();
}

function firstLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 逐行找"像正文"的那一行：跳过纯题号行、纯分值行（`(4 Punkte)`），
  // 否则标题会变成 "(4 Punkte)"（真机截图里见过）。
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
 * 跑一次 LLM 分块（锚点模式）。
 *
 * 失败（模型不可用 / 输出不可解析 / 锚点找不到 / 覆盖率过低）→ `ok:false`，
 * 调用方退回规则分块并把 error 写进导入提示。**绝不**因为分块失败而让导入失败。
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
    return {
      ok: false,
      problems: [],
      parts: chunks.length,
      error: `文本过长（${chunks.length} 段 > ${maxParts}），跳过 LLM 分块`,
    };
  }

  const problems: SplitProblem[] = [];
  const raws: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const prompt = buildSegmentPrompt(chunk, i + 1, chunks.length);
    const purpose = `exercise-segment-${i + 1}`;
    // noReasoning：分块是结构型小任务，推理只会把 token 预算吃光（真机踩过空文本）
    let raw = await ask(prompt, { maxTokens: 1500, purpose, noReasoning: true });
    let anchors = parseSegmentOutput(raw);
    if (!anchors) {
      // 运行时模型这类任务上可能仍不可用（推理/截断/改写了原句）→
      // 用直连（非推理模型）再要一次；key 还是全局凭据，只是换通道。
      const retry = await ask(prompt, { maxTokens: 3000, purpose: `${purpose}-retry`, noReasoning: true, preferDirect: true });
      if (retry) {
        raw = retry;
        anchors = parseSegmentOutput(raw);
      }
    }
    if (!raw) {
      return { ok: false, problems: [], parts: chunks.length, error: 'LLM 不可用或请求失败（返回空）', raw: raws.join('\n---\n') };
    }
    raws.push(raw);
    if (!anchors) {
      return {
        ok: false,
        problems: [],
        parts: chunks.length,
        error: 'LLM 输出里没有可用的锚点（不是预期 JSON 或 start 太短）',
        raw: raw.slice(0, 2000),
      };
    }
    const located = locateAnchors(chunk, anchors);
    if (!located) {
      return {
        ok: false,
        problems: [],
        parts: chunks.length,
        error: 'LLM 给的锚点在原文里定位不到（模型改写了原句）',
        raw: raw.slice(0, 2000),
      };
    }
    problems.push(...located);
  }

  const merged = dedupe(problems);
  if (!merged.length) return { ok: false, problems: [], parts: chunks.length, error: 'LLM 没有切出任何题' };

  const normLen = (s: string): number => s.replace(/\s+/g, '').length;
  const srcLen = normLen(source);
  const outLen = normLen(merged.map((p) => p.text).join(''));
  const coverage = srcLen ? outLen / srcLen : 1;
  if (coverage < MIN_COVERAGE) {
    return {
      ok: false,
      problems: merged,
      parts: chunks.length,
      coverage,
      error: `切出的正文只覆盖原文 ${(coverage * 100).toFixed(0)}%（< ${Math.round(MIN_COVERAGE * 100)}%），退回规则分块`,
      raw: raws.join('\n---\n').slice(0, 2000),
    };
  }

  return { ok: true, problems: merged, parts: chunks.length, coverage, raw: raws.join('\n---\n') };
}

/** 去掉完全重复的题（分块边界偶尔会重复输出同一题）。 */
function dedupe(list: SplitProblem[]): SplitProblem[] {
  const seen = new Set<string>();
  const out: SplitProblem[] = [];
  for (const p of list) {
    const key = `${p.label}\u0000${p.text.replace(/\s+/g, ' ').slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
