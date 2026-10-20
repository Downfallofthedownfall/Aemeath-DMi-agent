// ============================================================
// split.ts — 把一整份作业 PDF 的文本切成"题"
//
// 为什么单独一层、为什么这么保守：
//   · 切错了比切不开更糟。切开只是"三道题拼成一道"（用户改题干即可），
//     切错则是"把一道题劈成两半"，用户会在一道题下面写半截答案，
//     之后检查（LLM）看到的题干就是残的——错误会被放大到整个学习闭环。
//     所以这里所有启发式都偏向"少切"：
//       - 只认**行首**的题号（行内引用 `Wie in Aufgabe 1 zeigt …` 不算）
//       - 行首但后面直接跟小写单词的（`Aufgabe 1 zeigt …`）当成引用，不切
//       - 没有任何题号时先尝试纯数字编号，再不行就**不切**（交给调用方
//         把整段当一道题）
//   · 子问 `a)` `(b)` `i.` **不参与切分**：它们天然落在某个题号之后，
//     留在父题文本里正是我们想要的结果（题干 + 全部子问 = 一道题）。
//
// 本模块纯函数、零依赖，可直接单测（test/check2.mjs）。
// ============================================================

export interface SplitProblem {
  /** 原样题号标签，如 'Aufgabe 1' / '1' / 'Problem 3' */
  label: string;
  /** 题干首行（≤80 字符，去掉 label 前缀） */
  title: string;
  /** 题干正文（markdown 友好：保留换行，公式保持原样 LaTeX） */
  text: string;
  /** 1 基页码（由 \f 计） */
  page: number;
  points: number | null;
}

// ============================================================
// 题号识别
// ============================================================

/**
 * 德语/英语题号关键词。
 *
 * 为什么要这么多写法：实际讲义里同一门课会混用
 * `Aufgabe` / `Aufg.` / `Übung`（奥地利/瑞士字体常写成 `Uebung`，
 * PDF 抽出来也可能丢变音符）/ `Hausaufgabe` / `Exercise` / `Problem` / `Task`。
 * 漏掉一种，整份作业就会退化成"一道题"。
 *
 * 只匹配**行首**（`^` + m 标志）：题号在行中通常是交叉引用，切了会把
 * 正文劈开。允许行首空白与 markdown 粗体 `**`（用户会把 PDF 文本粘成
 * markdown 再编辑）。
 */
const KEYWORD_HEADING_RE = /^[ \t]*(?:\*\*[ \t]*)?(aufgabe|aufg\.?|übung|uebung|hausaufgabe|exercise|problem|task)[ \t]+(\d{1,3})(?![0-9])/gim;

/**
 * 纯数字编号（`1.` / `1)`）。
 *
 * 只在"全文找不到任何 Aufgabe 式题号"时启用——否则会与子问、公式编号、
 * 文献列表互相误伤。要求点号后**至少一个空格**，这样 `1.5 m` 这种小数
 * 不会被当成题号。
 *
 * 数字限 1–2 位：作业一页最多十几题，而 `2026.` 这种年份/日期在讲义行首
 * 并不罕见——放宽到 3 位会把它们当成题号。
 */
const NUMBER_HEADING_RE = /^[ \t]*(\d{1,2})[.)][ \t]+/gm;

/** 允许出现在数字后面、表示"标签结束"的标点（`Aufgabe 1:` / `Aufgabe 1.`）。 */
const LABEL_SEPARATOR_RE = /^[:.)\]\-–—]/;
const LABEL_SEPARATOR_STRIP_RE = /^[:.)\]\-–—]+[ \t]*/;

/** 标题长度上限（规格要求 ≤80）。超长截断并加省略号。 */
const TITLE_MAX = 80;

interface Heading {
  /** 在（规范化后的）全文中的字符偏移 */
  index: number;
  /** 原样标签，如 `Aufgabe 1` / `Aufg. 3` / `1` */
  label: string;
  /** 标题行去掉标签后剩下的部分（已清洗；可能是空串） */
  inline: string;
}

function lineAt(text: string, index: number): string {
  const nl = text.indexOf('\n', index);
  return nl === -1 ? text.slice(index) : text.slice(index, nl);
}

/**
 * 清洗标签后面剩下的行内文字，并给出"这到底是不是标题"的判定。
 *
 * 返回 `null` = **不是标题**（应当在 collect 阶段丢弃）。
 *
 * 唯一的拒绝条件：既没有标点分隔符、又直接跟小写字母。
 * 例子：`Aufgabe 1 zeigt, dass …` —— 这是正文里的引用，不是题号。
 * 而 `Aufgabe 1: berechne …`（有冒号）与 `Aufgabe 1 Berechne …`（大写开头）
 * 都放行。这个判据很便宜，却能挡掉最多的一类误切。
 */
function cleanInline(rest: string): string | null {
  let s = rest.replace(/^[ \t*]+/, '');
  const hasSeparator = LABEL_SEPARATOR_RE.test(s);
  if (hasSeparator) s = s.replace(LABEL_SEPARATOR_STRIP_RE, '');
  s = s.replace(/[ \t]*\*+[ \t]*$/, ''); // markdown 粗体收尾 `**`

  const first = s.length > 0 ? s[0]! : '';
  if (!hasSeparator && first.length > 0 && /\p{Ll}/u.test(first)) return null;
  return s;
}

/**
 * 收集关键词式题号。
 *
 * `probe` 是把 `\f` 换成 `\n` 的副本（长度不变 → 偏移全部通用）。
 * 为什么需要这一手：页分隔符在 PDF 里是 `\f`，而正则的 `^`（m 标志）
 * 只认 `\n`。不做替换，跨页第一行的题号会识别不到——作业恰好常按
 * "每题一页"排版。
 */
function collectKeywordHeadings(probe: string): Heading[] {
  const out: Heading[] = [];
  const re = new RegExp(KEYWORD_HEADING_RE.source, 'gim');
  let m: RegExpExecArray | null;
  while ((m = re.exec(probe)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++; // 零宽匹配防御（理论上不会发生）
      continue;
    }
    const line = lineAt(probe, m.index);
    const inline = cleanInline(line.slice(m[0].length));
    if (inline === null) continue;
    out.push({ index: m.index, label: `${m[1]} ${m[2]}`, inline });
  }
  return out;
}

// ============================================================
// 分值
// ============================================================

/**
 * 抠分值：`(4 Punkte)` / `[6 P]` / `（4 分）`。
 *
 * 刻意与 types.ts 的 `parsePoints` 保持一致而**没有直接 import**：
 * types.ts 顶层 `import { z } from 'zod'`，为了让这两个模块保持
 * 自包含（不把 schema 库拖进纯文本处理路径），这里保留同一份正则。
 * 改动时两处同改（行为一致，仅此处多了 `punkten` 变体）。
 */
function pointsOf(text: string): number | null {
  if (!text) return null;
  const t = text.slice(0, 400); // 分值不会写在第 400 字符之后
  const de = /(\d+(?:[.,]\d+)?)\s*(?:punkte|punkten|p\b)/i.exec(t);
  if (de) return Number(de[1]!.replace(',', '.'));
  const cn = /(\d+)\s*分/.exec(t);
  if (cn) return Number(cn[1]);
  return null;
}

/** 块内最后一个非空行（德语作业常把 `(4 Punkte)` 写在题干末尾）。 */
function lastMeaningfulLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t.length > 0) return t;
  }
  return '';
}

// ============================================================
// 标题
// ============================================================

/**
 * 去掉标题里的"分值/粗体/多余空白"。
 *
 * 只在**标题行**上做，不动正文——正文里的 `4 Punkte` 可能是题目内容
 * （"Ein 4 Punkte großer Körper"），删了就篡改题意。
 */
function cleanTitle(s: string): string {
  return s
    .replace(/[([{]\s*\d+(?:[.,]\d+)?\s*(?:punkte|punkten|p|分)\s*\.?\s*[)\]}]/gi, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*(?:punkte|punkten)\b/gi, ' ')
    .replace(/\d+\s*(?:p|分)\b/gi, ' ')
    .replace(/[*#]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function truncateTitle(s: string): string {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s;
}

/**
 * 题干首行 → 标题。
 *
 * 两级回退：
 *   ① 题号行上紧跟的文字（`Aufgabe 1: Berechne die Kraft` → `Berechne die Kraft`）
 *   ② 题号独占一行时，正文的第一行非空内容
 * 都拿不到就返回空串（UI 用 label 兜底展示，好过显示 `(4 Punkte)`）。
 */
function titleOf(inline: string, lines: readonly string[]): string {
  let t = cleanTitle(inline);
  if (t.length === 0) {
    for (let i = 1; i < lines.length; i++) {
      const cand = cleanTitle(lines[i] ?? '');
      if (cand.length > 0) {
        t = cand;
        break;
      }
    }
  }
  return truncateTitle(t);
}

// ============================================================
// 组装
// ============================================================

/** 1 基页码：数一数该偏移之前有多少个 `\f`。 */
function pageAt(src: string, index: number): number {
  let page = 1;
  for (let i = 0; i < index; i++) {
    if (src.charCodeAt(i) === 12) page++; // 12 = \f
  }
  return page;
}

function buildProblems(src: string, headings: readonly Heading[]): SplitProblem[] {
  const out: SplitProblem[] = [];

  for (let i = 0; i < headings.length; i++) {
    const head = headings[i]!;
    const end = i + 1 < headings.length ? headings[i + 1]!.index : src.length;

    // 页分隔符 → 空行：题干里不该出现 `\f`（前端按 markdown 渲染，
    // 控制字符会原样漏成方块），但"跨页"这个信息用空行保留下来。
    const block = src
      .slice(head.index, end)
      .replace(/\n?\f\n?/g, '\n\n')
      .trim();

    // 空块（两个题号之间什么都没有）直接丢弃——不产出"空题"
    if (block.length === 0) continue;

    const lines = block.split('\n');
    const headingLine = lines[0] ?? '';
    // 分值可能写在题号行，也可能写在题干末尾；先看题号行
    const points = pointsOf(headingLine) ?? pointsOf(lastMeaningfulLine(lines));

    out.push({
      label: head.label,
      title: titleOf(head.inline, lines),
      text: block,
      page: pageAt(src, head.index),
      points,
    });
  }

  return out;
}

/**
 * 收输入的公共前置：类型兜底 + CRLF 归一。
 *
 * 归一 CRLF 是为了让"行"的判定可靠（`\r` 会让 `lineAt` 的返回值带尾巴，
 * 进而让 label 后面的分隔符判定失效）。偏移在归一后的串上统一计算，
 * 页码只依赖 `\f`，因此不受影响。
 */
function prepare(text: string): string {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
}

// ============================================================
// 对外 API
// ============================================================

/**
 * 切题（主入口）。
 *
 * 顺序：关键词题号 → 纯数字编号 → 不切（返回 `[]`，**由调用方决定**
 * 是否把整段当一道题；这里不替调用方做产品决策）。
 */
export function splitProblems(text: string): SplitProblem[] {
  const src = prepare(text);
  if (src.trim().length === 0) return [];

  // `\f` → `\n` 的等长副本，让 `^` 能匹配跨页行首
  const probe = src.replace(/\f/g, '\n');

  const headings = collectKeywordHeadings(probe);
  if (headings.length < 1) return splitByFallback(src);

  return buildProblems(src, headings);
}

/**
 * 兜底切分：只有纯数字编号（`1.` / `1)`）的作业。
 *
 * 为什么要求 **≥2 个**匹配：单个 `1.` 极其可能是正文里的列表项或
 * "1. Hauptsatz"（热力学第一定律）这类内容，据此切一份作业会把
 * 整份文档切成"前言 + 一道题"。宁可返回 `[]` 让调用方整段当一题。
 */
export function splitByFallback(text: string): SplitProblem[] {
  const src = prepare(text);
  if (src.trim().length === 0) return [];

  const probe = src.replace(/\f/g, '\n');
  const headings: Heading[] = [];
  const re = new RegExp(NUMBER_HEADING_RE.source, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(probe)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const line = lineAt(probe, m.index);
    // fallback 的 rest 就是编号后的行内文字；不做小写守卫
    // （纯数字编号本来就没有关键词那种"引用句式"）
    const inline = line.slice(m[0].length).replace(/[ \t]*\*+[ \t]*$/, '');
    headings.push({ index: m.index, label: m[1]!, inline });
  }

  if (headings.length < 2) return [];
  return buildProblems(src, headings);
}
