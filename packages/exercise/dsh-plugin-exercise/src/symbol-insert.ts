// ============================================================
// symbol-insert.ts — 把 lecture 的符号模板变成"纯文本答案框"能用的插入文本
//
// 背景（用户实测，三轮修正）：
//   ① 「符号全是 placeholder」：lecture 的 insert 是给 MathLive 的
//      （`\int_{\placeholder{}}^{\placeholder{}}`），普通 textarea 里就是字面量。
//      → `toPlainLatex()` 把 `_{\placeholder{}}` / `_{$1}` 转成 `_{}`。
//   ② 「插入后不渲染」：lecture 数据是**数学模式内的片段**，不带 `$` 分隔符；
//      而习题答案框是"markdown + 公式"混排，必须有分隔符。
//      → 插入时**自动包一层**：普通符号 `$…$`，含换行/`\begin{…}` 的结构用 `$$…$$`；
//        已经带 `$` 的模板不动（避免 `$$` 套 `$`）。
//   ③ 光标：包了分隔符之后，偏移要把开分隔符的长度算进去。
//
// 纯函数，单测见 test/check8.mjs。
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
 * - 已含 `$` 的模板：原样（不再包）
 * - 含换行 / `\begin{…}`：`$$…$$`
 * - 其余：`$…$`
 * - `caret` 是相对插入文本的偏移（含开分隔符）；调用方加到插入位置上即可
 */
export function symbolInsertion(sym: SymbolLike): SymbolInsertion {
  const raw = sym.template && sym.template.trim() ? sym.template : (sym.insert ?? '');
  const core0 = toPlainLatex(raw);

  // 结尾空白放在分隔符**外面**：`$\int$ ` 比 `$\int $` 更贴近视觉
  const m = /(\s+)$/.exec(core0);
  const trailing = m ? m[1]! : '';
  const core = trailing ? core0.slice(0, -trailing.length) : core0;

  const inner = core.search(/\{\}|\(\)|\[\]/);
  const innerOffset = inner === -1 ? core.length : inner + 1;

  if (core.includes('$')) {
    // 模板自带分隔符：不动它
    return { text: core0, caret: innerOffset + trailing.length };
  }

  const display = core.includes('\n') || /\\begin\{/.test(core);
  const open = display ? '$$' : '$';
  return {
    text: `${open}${core}${open}${trailing}`,
    caret: open.length + innerOffset,
  };
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
