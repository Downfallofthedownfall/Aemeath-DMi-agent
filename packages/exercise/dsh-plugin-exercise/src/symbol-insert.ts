// ============================================================
// symbol-insert.ts — 把 lecture 的符号模板变成"纯文本答案框"能用的插入文本
//
// 三轮修正后的最终形态（用户定案 2026-10-21）：
//   ① 「符号全是 placeholder」：lecture 的 insert 是给 MathLive 的
//      （`\int_{\placeholder{}}^{\placeholder{}}`），普通 textarea 里就是字面量。
//      → `toPlainLatex()` 把 `_{\placeholder{}}` / `_{$1}` 转成 `_{}`。
//   ② 「插入后不渲染」：曾短暂地在插入时自动包 `$…$`。
//      → **已撤销**（用户："不要注入 $ 了，反正大部分时间都是在 LaTeX 里写一长串，
//        所以 $ 我自己手动就行了"）。
//        插入的就是**裸 LaTeX**，`$` 由用户自己写。
//        单独成行的裸 LaTeX 仍然会渲染（math-parse 的 isBareLatexLine），
//        所以"开一行写一条公式"这条路不需要 `$`；句子里混排才需要。
//   ③ 光标：落在第一个空组里（`\sum_{}^{}` → `{}` 之间），点完直接打上限。
//
// 纯函数，单测见 test/check8.mjs。
// ============================================================

export interface SymbolLike {
  /** 实际插入文本（lecture 里可能带 `\placeholder{}`） */
  insert?: string;
  /** 多插槽模板（`$1` `$2`） */
  template?: string;
  /** lecture 的光标提示；`parens` = insert 以 `(` 结尾、要补 `)` */
  caret?: string;
}

export interface SymbolInsertion {
  text: string;
  /** 相对插入文本起点的光标偏移 */
  caret: number;
}

/** 把讲义模板转成纯文本 LaTeX（去掉 MathLive 的占位框语法）。 */
export function toPlainLatex(insert: string): string {
  return (
    insert
      // `_{\placeholder{}}` → `_{}`（上下标包一层的情况：避免变成 `_{{}}`）
      .replace(/([_^])?\{\\placeholder\{\}\}/g, '$1{}')
      .replace(/([_^])?\{\$\d+\}/g, '$1{}')
      // 剩下裸露的占位符/模板槽 → 空组
      .replace(/\\placeholder\{\}/g, '{}')
      .replace(/\$\d+/g, '{}')
      // 兜底：`{{}}` 这种多余包裹收一层
      .replace(/\{\{\}\}/g, '{}')
  );
}

/**
 * 讲义符号表里的函数名是**纯文本**（`sin(`、`ln(`、`lim`）——那是给 lecture 速记用的，
 * 落在答案框的 LaTeX 里会排成斜体的 s·i·n，`lim_{x→0}` 也不是极限算子。
 * 这里换成 LaTeX 算子；KaTeX 没有的（德式 arsinh 等）用 \operatorname。
 */
const OPERATOR_NAMES: Readonly<Record<string, string>> = {
  'lim sup': '\\limsup',
  'lim inf': '\\liminf',
  lim: '\\lim',
  sin: '\\sin',
  cos: '\\cos',
  tan: '\\tan',
  cot: '\\cot',
  sec: '\\sec',
  csc: '\\csc',
  arcsin: '\\arcsin',
  arccos: '\\arccos',
  arctan: '\\arctan',
  sinh: '\\sinh',
  cosh: '\\cosh',
  tanh: '\\tanh',
  arsinh: '\\operatorname{arsinh}',
  arcosh: '\\operatorname{arcosh}',
  artanh: '\\operatorname{artanh}',
  exp: '\\exp',
  ln: '\\ln',
  log: '\\log',
  lg: '\\lg',
};

/**
 * 开头的 Unicode 根号 → `\sqrt{…}`（`√(` 在 LaTeX 里只是个孤零零的根号字形，没有横线）。
 * `√(` → `\sqrt{}`；`√(2π)` → `\sqrt{2π}`（括号里有内容就搬进花括号）。
 */
const ROOT_PREFIX: Readonly<Record<string, string>> = { '√': '\\sqrt', '∛': '\\sqrt[3]', '∜': '\\sqrt[4]' };

/** Unicode 上下标字符 → 普通字符（KaTeX 没有它们的字形度量，排出来大小/基线都不对）。 */
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹⁻ⁿ';
const SUPERSCRIPT_PLAIN = '0123456789-n';
const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉ᵢⱼₖₙₘ';
const SUBSCRIPT_PLAIN = '0123456789ijknm';

function scriptRuns(text: string, chars: string, plain: string, mark: '^' | '_'): string {
  return text.replace(new RegExp(`[${chars}]+`, 'g'), (run) => {
    const body = [...run].map((c) => plain[chars.indexOf(c)]).join('');
    return body.length === 1 ? `${mark}${body}` : `${mark}{${body}}`;
  });
}

/**
 * 讲义的纯文本写法 → 答案框的 LaTeX：
 *   · 开头的函数名 / 根号：`sin(` → `\sin(`、`lim` → `\lim`、`√(` → `\sqrt{}`
 *   · Unicode 上下标：`x₀` 键 → `_0`、`·10⁻³` → `·10^{-3}`、`sin²(` → `\sin^2(`
 *   · 收尾的 `^`（xⁿ、eˣ、×10ⁿ）→ `^{}`：光标进花括号，多位指数也能直接打
 *   · 差集键的裸 `\` → `\setminus`（单个反斜杠 KaTeX 直接报错）
 */
export function toLatexOperators(text: string): string {
  if (text === '\\') return '\\setminus ';
  let out = text;
  const root = /^([√∛∜])\(([^()]*)\)?/.exec(out);
  if (root) {
    out = `${ROOT_PREFIX[root[1]!]}{${root[2]}}${out.slice(root[0].length)}`;
  } else {
    const m = /^(lim sup|lim inf|[a-z]+)/.exec(out);
    const op = m ? OPERATOR_NAMES[m[1]!] : undefined;
    if (m && op) out = op + out.slice(m[0].length);
  }
  out = scriptRuns(out, SUPERSCRIPT, SUPERSCRIPT_PLAIN, '^');
  out = scriptRuns(out, SUBSCRIPT, SUBSCRIPT_PLAIN, '_');
  return out.replace(/\^$/, '^{}');
}

/**
 * 计算"点一下符号"要插什么、光标落哪。
 *
 * **不包 `$`**（用户定案）：插入裸 LaTeX，分隔符由用户自己写。
 * 模板自带 `$` 的也原样保留（那种数据本来就是要整段插入的）。
 *
 * 取哪个字段：insert 里有 `\placeholder{}` 的是**新写法**（真 LaTeX，如 `\sum_{…}`），
 * 优先用它；template 是早年的纯文本插槽写法（`∑_{$1}`），只在 insert 没有可填框时才用。
 */
export function symbolInsertion(sym: SymbolLike): SymbolInsertion {
  const insert = sym.insert ?? '';
  const useTemplate = !!sym.template?.trim() && !insert.includes('\\placeholder{}');
  let text = toLatexOperators(toPlainLatex(useTemplate ? sym.template! : insert));
  // `sin(` 这类：补上闭括号，光标落在括号里（lecture 的 insertSymbol 也是这么做的）
  if (sym.caret === 'parens' && text.endsWith('(')) text += ')';
  const idx = text.search(/\{\}|\(\)|\[\]/);
  return { text, caret: idx === -1 ? text.length : idx + 1 };
}

/** 在选区处插入（纯函数，便于单测；DOM 部分在 client 侧）。 */
export function applyInsertion(
  current: string,
  selStart: number,
  selEnd: number,
  insertion: SymbolInsertion,
): { text: string; caret: number } {
  const a = Math.max(0, Math.min(selStart, current.length));
  const b = Math.max(a, Math.min(selEnd, current.length));
  const text = `${current.slice(0, a)}${insertion.text}${current.slice(b)}`;
  return { text, caret: a + insertion.caret };
}
