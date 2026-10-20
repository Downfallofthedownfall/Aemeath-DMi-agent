// ============================================================
// symbol-insert.ts — 把 lecture 的符号模板变成"纯文本答案框"能用的插入文本
//
// 背景（用户实测）：「目前符号全是 placeholder」。原因是 lecture 的符号表是给
// MathLive 写的：`insert` 里用 `\placeholder{}` 表示"可点进去填的空框"
// （例如 `\int_{\placeholder{}}^{\placeholder{}} `）。MathLive 会把它画成占位框，
// 但习题的答案框是普通 textarea —— 原样插进去就是一堆 `\placeholder{}` 字面量。
//
// 这里做两件事（纯函数，可单测）：
//   ① `\placeholder{}` → `{}`（合法 LaTeX 空组）；`$1 $2` 模板同样换成 `{}`
//   ② 光标落到**第一个**空组里，点完 ∫ 上下限 就能直接打上限
// ============================================================

export interface SymbolLike {
  /** 实际插入文本（lecture 里可能带 `\placeholder{}`） */
  insert?: string;
  /** 多插槽模板（`$1` `$2`） */
  template?: string;
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
 * 计算"点一下符号"要插什么、光标落哪。
 *
 * `caret` 是相对插入文本的偏移：调用方把它加到插入位置上即可。
 */
export function symbolInsertion(sym: SymbolLike): SymbolInsertion {
  const raw = sym.template && sym.template.trim() ? sym.template : (sym.insert ?? '');
  const text = toPlainLatex(raw);
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
