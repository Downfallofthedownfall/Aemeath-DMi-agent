// ============================================================
// compute-fill.ts — 「一键计算」里不经过模型的那一半（纯函数，零依赖；host 与前端共用）
//
//   · findComputeTargets：在答案里找"待算式"—— 公式里以 `=`（或 `= ?`、`\approx`）结尾的那一行，
//     要算的是最后一个等号之前的那一段（`v = \sqrt{2gh} =` → `\sqrt{2gh}`）。
//     **只有学生自己写了结尾 `=` 的地方才算**：算什么由学生决定，不由模型决定。
//   · latexSymbolBases / latexNumberTokens：防"做题"的确定性护栏用（转写里不许出现式子里没有的量和数）
//   · formatComputed：结果写成 LaTeX（默认 4 位有效数字；有舍入就把 `=` 换成 `\approx`）
//   · applyComputeFills：把结果填回答案；答案在计算途中被改过就按上下文重新定位，找不到就跳过
//
// 公式片段的切分规则与 math-parse.ts（界面渲染）保持一致：渲染成公式的地方才会被当成待算式。
// ============================================================

export interface ComputeTarget {
  id: string;
  /** 要算的那一段 LaTeX（等式链的最后一环） */
  latex: string;
  /** 所在行（给模型看上下文、给界面显示） */
  line: string;
  /** 结尾标记（`=` / `= ?` / `\approx`）在答案里的位置 */
  markerStart: number;
  markerEnd: number;
  marker: string;
  /** 标记前的一段原文（答案在计算途中被改过时用来重新定位） */
  anchor: string;
  /** 不能算的原因：empty（等号前没有式子）/ bare_symbol（只有一个字母 —— 式子要学生自己写） */
  skip?: 'empty' | 'bare_symbol';
}

const MATH_ENVS = [
  'aligned',
  'align',
  'align*',
  'alignedat',
  'array',
  'cases',
  'matrix',
  'pmatrix',
  'bmatrix',
  'vmatrix',
  'Bmatrix',
  'gathered',
  'gather',
  'gather*',
  'equation',
  'equation*',
  'split',
  'subarray',
];
const MATH_ENV_RE = new RegExp(
  `^\\\\begin\\{(${MATH_ENVS.map((e) => e.replace(/\*/g, '\\*')).join('|')})\\}([\\s\\S]+?)\\\\end\\{\\1\\}`,
);

interface MathRegion {
  /** 公式内容在答案里的起止（不含分隔符） */
  start: number;
  end: number;
}

/** 按 math-parse.ts 的规则找出所有公式片段（带位置）。代码围栏里的不算。 */
export function mathRegions(text: string): MathRegion[] {
  const out: MathRegion[] = [];
  let i = 0;
  let lineStart = true;
  let inFence = false;
  while (i < text.length) {
    if (lineStart && /^[ \t]*```/.test(text.slice(i, i + 64))) {
      inFence = !inFence;
      const nl = text.indexOf('\n', i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    lineStart = false;
    if (inFence) {
      const nl = text.indexOf('\n', i);
      if (nl === -1) break;
      i = nl + 1;
      lineStart = true;
      continue;
    }
    const ch = text[i]!;
    if (ch === '\n') {
      i++;
      lineStart = true;
      continue;
    }
    if (text.startsWith('$$', i)) {
      const end = text.indexOf('$$', i + 2);
      if (end !== -1) {
        out.push({ start: i + 2, end });
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith('\\[', i)) {
      const end = text.indexOf('\\]', i + 2);
      if (end !== -1) {
        out.push({ start: i + 2, end });
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith('\\begin{', i)) {
      const m = MATH_ENV_RE.exec(text.slice(i));
      if (m) {
        out.push({ start: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '$' && text[i + 1] !== '$') {
      const rest = text.slice(i + 1);
      const nl = rest.indexOf('\n');
      const line = nl === -1 ? rest : rest.slice(0, nl);
      if (!/^\s/.test(line)) {
        const end = line.indexOf('$');
        if (end > 0 && !/\d/.test(line[end + 1] ?? '')) {
          out.push({ start: i + 1, end: i + 1 + end });
          i = i + 1 + end + 1;
          continue;
        }
      }
    }
    if (text.startsWith('\\(', i)) {
      const end = text.indexOf('\\)', i + 2);
      if (end !== -1 && !text.slice(i + 2, end).includes('\n')) {
        out.push({ start: i + 2, end });
        i = end + 2;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** 区间内按 `\\`（花括号外）切行。 */
function splitLines(text: string, start: number, end: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let ls = start;
  for (let i = start; i < end; i++) {
    const c = text[i]!;
    if (c === '\\' && text[i + 1] === '\\' && depth === 0) {
      out.push({ start: ls, end: i });
      i++;
      ls = i + 1;
      continue;
    }
    if (c === '\\') {
      i++; // 跳过转义字符（`\{` 不算括号）
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  out.push({ start: ls, end });
  return out;
}

/** 去掉区间两头的 `\begin{env}{…}` / `\end{env}`（环境整块当公式时）。 */
function trimEnvTags(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  const head = /^\s*\\begin\{[A-Za-z*]+\}(?:\{[^{}]*\})?/.exec(text.slice(s, e));
  if (head) s += head[0].length;
  const tail = /\\end\{[A-Za-z*]+\}\s*$/.exec(text.slice(s, e));
  if (tail) e = s + tail.index;
  return { start: s, end: e };
}

/** 结尾标记：`=`、`= ?`、`=\,?`、`\approx`（前面不能是 `:` `<` `>` `!` `\`）。 */
const TRAILING_MARKER = /(?<![:<>!\\=])(=|\\approx)((?:\s|~|\\[,;:! ]|\\q?quad)*\?)?(?:\s|~|\\[,;:! ]|\\q?quad)*$/;
/** 关系符（花括号外的最后一个就是等式链最后一环的开头）。 */
const RELATION = /^(?:=|\\approx|\\simeq|\\equiv|\\Rightarrow|\\Leftrightarrow|\\implies)/;

function lastLink(text: string): string {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const m = RELATION.exec(text.slice(i));
      if (m && !(c === '=' && /[:<>!]/.test(text[i - 1] ?? ''))) {
        cut = i + m[0].length;
        i = cut - 1;
        continue;
      }
      if (c === '\\') {
        const cmd = /^\\[A-Za-z]+|^\\./.exec(text.slice(i));
        if (cmd) i += cmd[0].length - 1;
      }
    }
  }
  return text.slice(cut).replace(/^\s*&\s*/, '').replace(/\s*&\s*$/, '').trim();
}

/** 去掉排版用的空白命令，判断"只有一个字母"。 */
function isBareSymbol(latex: string): boolean {
  const s = latex
    .replace(/\\[,;:! ]|\\q?quad|~/g, '')
    .replace(/\\(?:left|right|displaystyle)\b/g, '')
    .replace(/\s+/g, '');
  return /^(?:[A-Za-z]|\\[A-Za-z]+)(?:_(?:\{[^{}]*\}|[A-Za-z0-9]))?(?:'|\^\{?\\prime\}?)?$/.test(s) && !/^\\(?:pi)$/.test(s);
}

/** 一次最多算几处。 */
export const MAX_COMPUTE_TARGETS = 12;

/** 找待算式（按出现顺序；id 是 t1、t2…）。 */
export function findComputeTargets(draft: string, max = MAX_COMPUTE_TARGETS): ComputeTarget[] {
  const text = draft;
  const out: ComputeTarget[] = [];
  for (const region of mathRegions(text)) {
    const inner = trimEnvTags(text, region.start, region.end);
    // 环境放在 $$ 里：再剥一层
    const body = trimEnvTags(text, inner.start, inner.end);
    let prevLink = '';
    for (const ln of splitLines(text, body.start, body.end)) {
      const lineText = text.slice(ln.start, ln.end);
      const m = TRAILING_MARKER.exec(lineText);
      if (!m) {
        prevLink = lastLink(lineText);
        continue;
      }
      const markerStart = ln.start + m.index;
      const markerEnd = markerStart + m[1]!.length + (m[2] ?? '').length;
      const before = lineText.slice(0, m.index);
      let latex = lastLink(before);
      if (!latex && /^\s*&?\s*$/.test(before)) latex = prevLink; // `&= \\ &=`：续上一行
      const target: ComputeTarget = {
        id: `t${out.length + 1}`,
        latex,
        line: lineText.trim(),
        markerStart,
        markerEnd,
        marker: text.slice(markerStart, markerEnd),
        anchor: text.slice(Math.max(ln.start, markerStart - 60), markerEnd),
      };
      if (!latex) target.skip = 'empty';
      else if (isBareSymbol(latex)) target.skip = 'bare_symbol';
      out.push(target);
      prevLink = latex;
      if (out.length >= max) return out;
    }
  }
  return out;
}

// ============================================================
// 护栏：式子里出现的字母 / 数字（确定性，不经过模型）
// ============================================================

/** 不是"量"的命令（函数、运算符、排版）。 */
const NON_SYMBOL_COMMANDS = new Set([
  'frac', 'dfrac', 'tfrac', 'cfrac', 'sqrt', 'cdot', 'times', 'div', 'pm', 'mp', 'left', 'right', 'big', 'Big', 'bigg', 'Bigg',
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'exp', 'ln', 'lg', 'log',
  'mathrm', 'text', 'textrm', 'mathit', 'mathbf', 'boldsymbol', 'operatorname', 'unit', 'si', 'SI', 'displaystyle',
  'quad', 'qquad', 'circ', 'degree', 'approx', 'cdots', 'ldots', 'dots', 'prime', 'abs', 'vert', 'lvert', 'rvert',
  'pi', 'infty', 'hat', 'vec', 'bar', 'dot', 'ddot', 'tilde', 'overline', 'underline',
]);
/** 内容是单位/文字的命令：里面的字母不是量。 */
const TEXT_COMMANDS = /\\(?:mathrm|text|textrm|operatorname|unit|si|SI)\s*\{[^{}]*\}/g;

/** 式子里出现的"量"的底名：单个字母（`v`）与希腊字母等命令（`alpha`，去掉 var 前缀）。 */
export function latexSymbolBases(latex: string): Set<string> {
  const out = new Set<string>();
  const s = latex.replace(TEXT_COMMANDS, ' ');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') {
      const cmd = /^\\([A-Za-z]+)/.exec(s.slice(i));
      if (cmd) {
        if (!NON_SYMBOL_COMMANDS.has(cmd[1]!)) out.add(cmd[1]!.replace(/^var/, ''));
        i += cmd[0].length - 1;
      } else i++;
      continue;
    }
    if (/[A-Za-z]/.test(c)) out.add(c);
  }
  return out;
}

/** 算式里的字母名（`v_0`、`alpha`、`Delta_t`）→ 底名（`v`、`alpha`、`Delta`）。 */
export function symbolBase(name: string): string {
  const base = name.split('_')[0] ?? name;
  return base.replace(/^var/, '');
}

/** 字母在式子里出现了吗（只看底名；下标写法太多，不苛求）。 */
export function symbolInLatex(name: string, latex: string): boolean {
  const bases = latexSymbolBases(latex);
  const base = symbolBase(name);
  if (bases.has(base)) return true;
  // `Dt` / `dv` 这种合写：每个字母都在才算
  return base.length > 1 && /^[A-Za-z]+$/.test(base) && [...base].every((ch) => bases.has(ch)) && !/[a-z]{3,}/.test(base);
}

/**
 * 原文里的数字串（只要数字，去掉小数点/小数逗号）：`9{,}81` → `981`、`1.5` → `15`、`\frac12` → `12`。
 * 用来核对"转写/数值里的数确实写在原文里"。
 */
export function latexNumberTokens(latex: string): string[] {
  const s = latex
    .replace(/\{,\}/g, '.')
    .replace(/(\d)\\[,;: ](?=\d{3}\b)/g, '$1') // 1\,000
    .replace(/(\d),(?=\d)/g, '$1.');
  return [...s.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0].replace('.', ''));
}

/** 数的有效数字串：`9.81` → `981`、`0.002` → `2`、`3000` → `3`、`1.5e3` → `15`。 */
export function mantissaDigits(text: string | number): string {
  const v = typeof text === 'number' ? text : Number(text);
  if (!Number.isFinite(v) || v === 0) return '0';
  const exp = Math.abs(v).toExponential(); // "9.81e+0"
  const mant = exp.split('e')[0]!.replace('.', '').replace(/0+$/, '');
  return mant || '0';
}

/** 数（有效数字串）在原文的某个数字串里出现了吗。 */
export function numberInTokens(value: string | number, tokens: readonly string[]): boolean {
  const d = mantissaDigits(value);
  return tokens.some((t) => t.includes(d));
}

/** 去掉空白/排版命令/花括号，用来做"原文片段确实在原文里"的比较。 */
export function normalizeQuote(s: string): string {
  return s
    .replace(/\{,\}/g, ',')
    .replace(/\\[,;:! ]|\\q?quad|~/g, '')
    .replace(/[\s{}$]/g, '');
}

// ============================================================
// 结果格式化与回填
// ============================================================

export interface FormattedNumber {
  /** LaTeX（`5.425`、`1.602 \times 10^{-19}`） */
  latex: string;
  /** 纯文本（`5.425`、`1.602e-19`） */
  plain: string;
  /** 没有舍入（写 `=`）；有舍入写 `\approx` */
  exact: boolean;
}

function stripZeros(m: string): string {
  return m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m;
}

/** 按有效数字格式化。|指数| 大时用 `a \times 10^{n}`。 */
export function formatComputed(value: number, digits = 4): FormattedNumber {
  const d = Math.min(12, Math.max(1, Math.round(digits)));
  if (value === 0 || Object.is(value, -0)) return { latex: '0', plain: '0', exact: true };
  if (Number.isInteger(value) && Math.abs(value) < 1e9) {
    return { latex: String(value), plain: String(value), exact: true };
  }
  const exp = Math.floor(Math.log10(Math.abs(value)));
  if (exp >= -3 && exp < 6) {
    // 整数位比有效数字还多（12345.6 取 4 位）：toPrecision 会给 1.235e+4，这里改成取整
    const fixed = exp >= d ? String(Math.round(value)) : stripZeros(value.toPrecision(d));
    const exact = Math.abs(Number(fixed) - value) <= Math.abs(value) * 1e-12;
    return { latex: fixed, plain: fixed, exact };
  }
  const [m, e] = value.toExponential(d - 1).split('e') as [string, string];
  const mant = stripZeros(m);
  const n = Number(e);
  const exact = Math.abs(Number(`${mant}e${n}`) - value) <= Math.abs(value) * 1e-12;
  const latex = mant === '1' ? `10^{${n}}` : mant === '-1' ? `-10^{${n}}` : `${mant} \\times 10^{${n}}`;
  return { latex, plain: `${mant}e${n}`, exact };
}

/** 有效数字更多的写法（结果框里给人看/复制）。 */
export function fullPrecision(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return stripZeros(value.toPrecision(12).replace(/e\+?/, 'e'));
}

/** 结尾标记换成什么：有舍入 `\approx 5.425`，精确 `= 5`。原来写的是 `\approx` 就保留。 */
export function fillReplacement(marker: string, formatted: FormattedNumber): string {
  const approx = !formatted.exact || /^\\approx/.test(marker);
  return `${approx ? '\\approx' : '='} ${formatted.latex}`;
}

export interface ComputeFill {
  id: string;
  markerStart: number;
  markerEnd: number;
  marker: string;
  anchor: string;
  replacement: string;
}

/**
 * 把结果填回答案。按位置从后往前替换；该位置的原文变了就用 anchor 在新答案里找
 * （必须**唯一**命中），还找不到就跳过 —— 绝不把数填错地方。
 */
export function applyComputeFills(
  draft: string,
  fills: readonly ComputeFill[],
): { text: string; applied: string[]; skipped: string[] } {
  const located: Array<{ fill: ComputeFill; start: number; end: number }> = [];
  const skipped: string[] = [];
  for (const f of fills) {
    if (draft.slice(f.markerStart, f.markerEnd) === f.marker && draft.slice(f.markerEnd - f.anchor.length, f.markerEnd) === f.anchor) {
      located.push({ fill: f, start: f.markerStart, end: f.markerEnd });
      continue;
    }
    const first = draft.indexOf(f.anchor);
    if (f.anchor && first !== -1 && draft.indexOf(f.anchor, first + 1) === -1) {
      const end = first + f.anchor.length;
      located.push({ fill: f, start: end - f.marker.length, end });
    } else {
      skipped.push(f.id);
    }
  }
  located.sort((a, b) => b.start - a.start);
  let text = draft;
  const applied: string[] = [];
  let lastStart = Infinity;
  for (const l of located) {
    if (l.end > lastStart) {
      skipped.push(l.fill.id); // 两处重叠（不该发生）：只填后面那处
      continue;
    }
    text = `${text.slice(0, l.start)}${l.fill.replacement}${text.slice(l.end)}`;
    lastStart = l.start;
    applied.push(l.fill.id);
  }
  return { text, applied: applied.reverse(), skipped };
}
