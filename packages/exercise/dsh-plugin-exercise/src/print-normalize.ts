// ============================================================
// print-normalize.ts — **只用于打印/PDF** 的预处理
//
// 背景（用户 2026-10-24）："回答里写的 LaTeX 公式在提交 pdf 会变成字符串"。
//
// 为什么只在打印侧做：
//   · 屏幕端按用户定案"只有写了 `$` 才渲染"（2026-10-22，避免"没写 $$ 也自己渲染"）；
//   · 但打印是最终交付物，一行**整行就是 LaTeX**（`F = m \frac{dv}{dt}`）印成源码很难看，
//     所以印刷时把这种行**包成块级公式**再交给 KaTeX。
//
// 判据必须窄（宁可少认，不能把散文/路径当公式）：
//   · 有中日韩字符 → 散文，不认
//   · `C:\Users` / UNC 路径 → 不认
//   · 已经带 `$` / `\(` / `\[` → 不认（交给常规管线）
//   · 反引号（代码）→ 不认；代码围栏里的行一律不动
//   · 至少一个反斜杠命令，且命令都在白名单里
//   · 去掉命令后不能像"三个以上英文单词"的句子
// ============================================================

/** 无歧义的数学命令白名单（用于"整行是不是 LaTeX"的判定）。 */
const MATH_CMDS = new Set([
  'sum', 'prod', 'coprod', 'int', 'iint', 'iiint', 'oint',
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
  'quad', 'qquad', 'hspace', 'phantom', 'boxed', 'underbrace', 'overbrace',
  'begin', 'end', 'displaystyle', 'textstyle', 'cdots', 'ldots', 'dots', 'vdots', 'ddots',
  'degree', 'prime', 'ell', 'hbar', 'Re', 'Im', 'aleph', 'colon', 'backslash',
]);

const MATH_ENVS = new Set([
  'aligned', 'align', 'alignat', 'alignedat', 'gathered', 'gather', 'split', 'cases',
  'array', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix',
  'eqnarray', 'subequations',
]);

const MATH_CHARS_RE = /^[\sA-Za-z0-9\\{}^_&|()[\]+\-*/=<>.,;:!%'"~$@]*$/;

/** 这一整行是不是"裸 LaTeX"（不带分隔符）？ */
export function looksLikeBareLatex(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // 中文/日文/韩文 → 散文
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(t)) return false;
  // Windows 路径 / UNC
  if (/[A-Za-z]:[\\/]/.test(t) || t.includes('\\\\')) return false;
  // 已经带分隔符 / 代码
  if (t.includes('$') || t.includes('`') || t.startsWith('\\(') || t.startsWith('\\[')) return false;
  // 至少一个命令，且都在白名单（或合法环境名）
  const cmds = [...t.matchAll(/\\([A-Za-z]+)/g)].map((m) => m[1]!);
  if (!cmds.length) return false;
  if (!cmds.every((c) => MATH_CMDS.has(c) || MATH_ENVS.has(c) || MATH_ENVS.has(c.replace(/\*$/, '')))) return false;
  // 字符集
  if (!MATH_CHARS_RE.test(t)) return false;
  // 去掉命令后不能像自然语言
  const stripped = t.replace(/\\[A-Za-z]+/g, ' ');
  if (/\b[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}\b/i.test(stripped)) return false;
  return true;
}

/**
 * 把"整行裸 LaTeX"包成 `$$…$$`（供打印管线使用）。
 *
 * **必须跳过已经在公式块里的行**，否则会二次包裹（`$$` 里面又出现 `$$`），
 * 打印时块级公式的配对会被打乱 —— 真机踩过：整个"块级公式 + 后面几行"被吞进一个公式里。
 * 所以维护三个状态：代码围栏 / `$$` 或 `\[ \]` 块 / `\begin{env}` 深度。
 */
export function wrapBareLatexLines(src: string): string {
  const text = src ?? '';
  if (!text) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let inDisplay = false; // $$ … $$（或 \[ … \]）
  let inBracket = false;
  let envDepth = 0;

  const count = (line: string, re: RegExp): number => (line.match(re) ?? []).length;

  for (const line of lines) {
    // 代码围栏：整块原样
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // 块级公式状态：`$$` / `\[` / `\]` 的奇偶决定进出
    const dd = count(line, /\$\$/g);
    const openBracket = count(line, /\\\[/g);
    const closeBracket = count(line, /\\\]/g);

    if (inDisplay || inBracket) {
      out.push(line);
      if (dd % 2 === 1) inDisplay = !inDisplay;
      for (let i = 0; i < openBracket; i++) inBracket = true;
      for (let i = 0; i < closeBracket; i++) inBracket = false;
      continue;
    }
    if (dd % 2 === 1) {
      out.push(line);
      inDisplay = true;
      continue;
    }
    if (openBracket > closeBracket) {
      out.push(line);
      inBracket = true;
      continue;
    }

    // `\begin{env} … \end{env}` 深度：块内不包（normalizeMathDelimiters 会处理整个环境）
    const begins = count(line, /\\begin\{/g);
    const ends = count(line, /\\end\{/g);
    if (envDepth > 0) {
      envDepth += begins - ends;
      out.push(line);
      continue;
    }
    if (begins > 0) {
      envDepth += begins - ends;
      out.push(line);
      continue;
    }

    out.push(looksLikeBareLatex(line) ? `$$${line.trim()}$$` : line);
  }
  return out.join('\n');
}
