// ============================================================
// math-parse.ts — 把"markdown + LaTeX"切成可渲染的片段（纯函数，零依赖）
//
// 为什么单独一层：界面的 MathText 与单测需要同一套切分逻辑；
// 纯函数放这里，client/math.tsx 只负责把片段变成 JSX。
//
// 支持的分隔符（2026-10-20 补）：
//   `$$ … $$`                块级（**可跨行** —— 之前按行切块的实现遇到多行
//                            `$$` 就整段当纯文本渲染，用户报的"还是没渲染"就是这个）
//   `\[ … \]`                块级（LaTeX 习惯写法）
//   `\begin{aligned} … \end{aligned}` 等环境 → 块级（不用写 `$$`）
//   `$ … $`                  行内（不跨行；`$` 后紧跟空白不算公式，避免 "$5 and $6"）
//   `\( … \)`                行内（LaTeX 习惯写法）
//
// 其余按 markdown 的极简子集：`# 标题` / `- 列表` / ``` 代码围栏``` / 段落。
// 代码围栏里的内容**不**做公式解析（贴一段 LaTeX 代码不该被渲染坏）。
// ============================================================

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'math'; tex: string; display: boolean };

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'li'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'p'; text: string };

/** KaTeX 能直接吃的块级环境（用户写 `\begin{aligned}` 时不加 `$$` 也渲染）。 */
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
  `\\\\begin\\{(${MATH_ENVS.map((e) => e.replace(/\*/g, '\\*')).join('|')})\\}([\\s\\S]+?)\\\\end\\{\\1\\}`,
);

/**
 * 切出**块级**公式（可跨行）。未闭合的 `$$` / `\[` / 环境不吞内容 ——
 * 退化成文本，绝不因为写作格式丢掉用户写的东西。
 */
export function splitDisplayMath(src: string): Segment[] {
  const text = src.replace(/\r\n?/g, '\n');
  const out: Segment[] = [];
  let i = 0;
  let buf = '';
  const flush = (): void => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };

  while (i < text.length) {
    if (text.startsWith('$$', i)) {
      const end = text.indexOf('$$', i + 2);
      if (end !== -1) {
        flush();
        out.push({ kind: 'math', tex: text.slice(i + 2, end), display: true });
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith('\\[', i)) {
      const end = text.indexOf('\\]', i + 2);
      if (end !== -1) {
        flush();
        out.push({ kind: 'math', tex: text.slice(i + 2, end), display: true });
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith('\\begin{', i)) {
      const m = MATH_ENV_RE.exec(text.slice(i));
      if (m && m.index === 0) {
        flush();
        out.push({ kind: 'math', tex: m[0], display: true });
        i += m[0].length;
        continue;
      }
    }
    buf += text[i]!;
    i++;
  }
  flush();
  return out;
}

/** 切出**行内**公式（不跨行；`$` 后紧跟空白不算，避免 "$5 and $6"）。 */
export function splitInlineMath(text: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let buf = '';
  const flush = (): void => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };

  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] !== '$') {
      const rest = text.slice(i + 1);
      const nl = rest.indexOf('\n');
      const line = nl === -1 ? rest : rest.slice(0, nl);
      if (!/^\s/.test(line)) {
        const end = line.indexOf('$');
        // 收尾 `$` 后面紧跟数字 → 多半是 "$5 and $6" 这种金额/序号，不当公式
        const closes = end > 0 && !/\d/.test(line[end + 1] ?? '');
        if (closes) {
          flush();
          out.push({ kind: 'math', tex: line.slice(0, end), display: false });
          i = i + 1 + end + 1;
          continue;
        }
      }
    }
    if (text.startsWith('\\(', i)) {
      const end = text.indexOf('\\)', i + 2);
      if (end !== -1 && !text.slice(i + 2, end).includes('\n')) {
        flush();
        out.push({ kind: 'math', tex: text.slice(i + 2, end), display: false });
        i = end + 2;
        continue;
      }
    }
    buf += text[i]!;
    i++;
  }
  flush();
  return out;
}

/** 全部公式段（块级 + 行内），用于 `hasMath` 与测试。 */
export function splitMathSegments(src: string): Segment[] {
  const out: Segment[] = [];
  for (const seg of splitDisplayMath(src)) {
    if (seg.kind === 'math') out.push(seg);
    else out.push(...splitInlineMath(seg.text));
  }
  return out;
}

/** 文本里有公式吗（决定要不要加载 KaTeX 样式）。 */
export function hasMath(text: string): boolean {
  if (splitMathSegments(text).some((s) => s.kind === 'math')) return true;
  // 整行裸 LaTeX（用户从符号面板插入、或手打 `\sum_{1}^{2}` 不带 $）也算
  return text.split(/\r?\n/).some((line) => isBareLatexLine(line));
}

// ============================================================
// 裸 LaTeX 行（不带 `$` 的分隔符）
//
// 为什么需要：符号面板的数据来自 lecture（MathLive 表单里天生就是数学模式），
// 插入 `\sum_{}^{}` 这种**不带分隔符**的串。用户"点符号 → 填上下限"是主输入路径，
// 如果解析器只认 `$`，这条路产出的内容就永远只按纯文本显示（真机报的 bug）。
//
// 判据必须**收窄到"整行就是一条 LaTeX"**，否则会把散文/路径误判：
//   · 有中日韩字符 → 不是（"用 \sum 求和" 这种是散文）
//   · `C:\Users` / UNC 路径 → 不是
//   · 提到反引号（代码）→ 不是
//   · 命令名必须在白名单里（`\sum` `\frac` `\alpha`…），`\Users` 不在
//   · 去掉命令后不能像"三个以上英文单词"的句子
// ============================================================

/** 无歧义的数学命令（白名单：宁可少认，也不能把散文当公式）。 */
const MATH_CMDS = new Set([
  'sum', 'prod', 'coprod', 'int', 'iint', 'iiint', 'oint', 'oiint',
  'frac', 'dfrac', 'tfrac', 'sqrt', 'root', 'binom', 'overline', 'underline',
  'hat', 'bar', 'vec', 'dot', 'ddot', 'tilde', 'widehat', 'widetilde', 'overrightarrow',
  'partial', 'nabla', 'infty', 'lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'arg',
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'log', 'ln', 'exp', 'det', 'dim', 'ker', 'deg', 'gcd',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta',
  'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma',
  'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
  'cdot', 'times', 'div', 'pm', 'mp', 'ast', 'star', 'circ', 'bullet',
  'leq', 'le', 'geq', 'ge', 'neq', 'ne', 'approx', 'equiv', 'sim', 'simeq', 'propto',
  'll', 'gg', 'subset', 'supset', 'subseteq', 'supseteq', 'in', 'notin', 'cup', 'cap',
  'emptyset', 'varnothing', 'forall', 'exists', 'neg', 'land', 'lor', 'lnot',
  'to', 'rightarrow', 'leftarrow', 'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow',
  'mapsto', 'uparrow', 'downarrow', 'mid', 'parallel', 'perp', 'angle', 'triangle',
  'langle', 'rangle', 'lvert', 'rvert', 'vert', 'Vert', 'lfloor', 'rfloor', 'lceil', 'rceil',
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'text', 'textrm', 'textbf', 'mathrm',
  'mathbf', 'mathit', 'mathbb', 'mathcal', 'mathfrak', 'mathsf', 'operatorname',
  'quad', 'qquad', 'hspace', 'vspace', 'phantom', 'boxed', 'underbrace', 'overbrace',
  'begin', 'end', 'displaystyle', 'textstyle', 'cdots', 'ldots', 'dots', 'vdots', 'ddots',
  'degree', 'prime', 'ell', 'hbar', 'Re', 'Im', 'aleph', 'colon', 'backslash',
]);

const MATH_PUNCT_RE = /^[\sA-Za-z0-9\\{}^_&|()[\]+\-*/=<>.,;:!%'"~#$@`]*$/;

/**
 * 这一整行是不是"裸 LaTeX"（不带 `$`）？
 *
 * 只用于**整行**判定；行内混排的散文一律不认（避免误渲染）。
 */
export function isBareLatexLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // 中日韩字符 → 散文（"用 \sum 求和"）
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(t)) return false;
  // Windows 路径 / UNC（`C:\Users` 里的 `\Users` 不是命令）
  if (/[A-Za-z]:[\\/]/.test(t) || t.includes('\\\\')) return false;
  // 已经带分隔符的（`$…$` / `$$…$$` / `\( \)` / `\[ \]`）不是"裸" LaTeX ——
  // 否则整行 `$T = 2\pi\sqrt{l/g}$` 会被当成裸 LaTeX 再包一层 `$$`，
  // KaTeX 见到里面的 `$` 直接报错，预览变成红字源码（真机 2026-10-22 踩到）。
  if (t.includes('$') || t.startsWith('\\(') || t.startsWith('\\[')) return false;
  // 代码（反引号）
  if (t.includes('`')) return false;
  // 至少一个反斜杠命令，且**所有**命令都在白名单里
  const cmds = [...t.matchAll(/\\([A-Za-z]+)/g)].map((m) => m[1]!);
  if (!cmds.length) return false;
  if (!cmds.every((c) => MATH_CMDS.has(c) || MATH_ENVS.includes(c) || MATH_ENVS.includes(`${c}*`))) return false;
  // 字符集：只允许数学/标点（出现中文标点、emoji 等就不认）
  if (!MATH_PUNCT_RE.test(t)) return false;
  // 去掉命令后不能像自然语言句子（"the sum of these values"）
  const stripped = t.replace(/\\[A-Za-z]+/g, ' ');
  if (/\b[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}\b/i.test(stripped)) return false;
  return true;
}

/**
 * 把 LaTeX 习惯写法归一成 `$` / `$$`：
 *   `\[…\]` → `$$…$$`，`\(…\)` → `$…$`，裸露的 `\begin{aligned}…\end{aligned}` → `$$…$$`
 *
 * 用途：**提交 PDF** 那条管线的公式抽取只认 `$$…$$`（历史实现），
 * 归一化之后用户写哪种写法都能打印出来。
 */
export function normalizeMathDelimiters(src: string): string {
  const pieces: string[] = [];
  for (const seg of splitDisplayMath(src)) {
    if (seg.kind === 'math') {
      const tex = seg.tex.trim();
      // 已经是 `$$…$$` 或 `\[…\]` 或环境 —— 统一成 `$$…$$`（渲染侧只认这个）
      pieces.push(`$$${tex}$$`);
      continue;
    }
    let text = seg.text;
    // 行内 `\( … \)` → `$ … $`
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => `$${String(tex).trim()}$`);
    // 整行裸 LaTeX（符号面板插入的 `\sum_{}^{}`、手打的 `\frac{a}{b}`）→ `$$…$$`
    text = text
      .split('\n')
      .map((line) => (isBareLatexLine(line) ? `$$${line.trim()}$$` : line))
      .join('\n');
    pieces.push(text);
  }
  return pieces.join('');
}

/** 极简块级解析：标题 / 列表 / 代码围栏 / 段落。 */
export function parseTextBlocks(src: string): Block[] {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      blocks.push({ kind: 'li', text: li[1]! });
      i++;
      continue;
    }
    blocks.push({ kind: 'p', text: line });
    i++;
  }
  return blocks;
}

/** 行内 token：`**粗**` / `*斜*` / `` `代码` ``（公式已由 splitInlineMath 切走）。 */
export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string };

export function parseInlineTokens(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  const re = /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`\n]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('**')) out.push({ kind: 'bold', text: tok.slice(2, -2) });
    else if (tok.startsWith('`')) out.push({ kind: 'code', text: tok.slice(1, -1) });
    else out.push({ kind: 'italic', text: tok.slice(1, -1) });
    last = m.index + tok.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** 渲染块：块级公式 / 标题 / 列表 / 代码 / 段落（段落带行内片段）。 */
export interface RenderBlock {
  kind: 'heading' | 'li' | 'code' | 'p' | 'math';
  level?: number;
  /** 行内片段（文本块用；代码块只有一段纯文本） */
  segments?: Segment[];
  /** 块级公式 */
  tex?: string;
  /** 块级公式用 display 模式（恒为 true；保留字段是为了渲染侧语义清晰） */
  display?: boolean;
  /** 空行 */
  whitespace?: boolean;
}

/**
 * 整段文本 → 渲染块流。
 *
 * 顺序很重要：**先切块级公式**（可跨行），再对剩下的文本做块级 markdown，
 * 最后在每个文本块里切行内公式。代码围栏里的 `$` 保持原样。
 */
export function buildRenderBlocks(src: string): RenderBlock[] {
  const out: RenderBlock[] = [];
  for (const seg of splitDisplayMath(src)) {
    if (seg.kind === 'math') {
      out.push({ kind: 'math', tex: seg.tex, display: true });
      continue;
    }
    // 公式切走后在文本段边缘会留下"空段落"（`$$` 前后的换行），
    // 它们在段首/段尾没有意义 —— 去掉，否则每道题都会多出一行空白。
    const chunk: RenderBlock[] = [];
    for (const block of parseTextBlocks(seg.text)) {
      if (block.kind === 'code') {
        chunk.push({ kind: 'code', segments: [{ kind: 'text', text: block.text }] });
      } else if (block.kind === 'heading') {
        chunk.push({ kind: 'heading', level: block.level, segments: splitInlineMath(block.text) });
      } else if (block.kind === 'li') {
        chunk.push({ kind: 'li', segments: splitInlineMath(block.text) });
      } else if (!block.text.trim()) {
        chunk.push({ kind: 'p', whitespace: true, segments: [] });
      } else if (isBareLatexLine(block.text)) {
        // 整行裸 LaTeX → 块级公式（符号面板插入的 `\sum_{}^{}` 就走这条）
        chunk.push({ kind: 'math', tex: block.text.trim(), display: true });
      } else {
        chunk.push({ kind: 'p', segments: splitInlineMath(block.text) });
      }
    }
    while (chunk.length && chunk[0]!.whitespace) chunk.shift();
    while (chunk.length && chunk[chunk.length - 1]!.whitespace) chunk.pop();
    out.push(...chunk);
  }
  return out;
}
