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
 * **不包 `$`**（用户定案）：插入裸 LaTeX，分隔符由用户自己写。
 * 模板自带 `$` 的也原样保留（那种数据本来就是要整段插入的）。
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
