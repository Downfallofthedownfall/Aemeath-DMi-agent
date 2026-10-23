// ============================================================
// symbols.ts — 数学符号板的类型 + 插入逻辑（纯函数，无前端依赖）
//
// 数据表在 symbol-data.ts（250+ 项，十几个分组）；
// 本文件只放**逻辑**：模板渲染、光标落点、Tab 跳转。
//
// 用途（用户定案）：**边栏**，放"键盘打起来费劲或打不出"的符号——
//   积分、根号、三角函数、d/dt，以及 ∑/∏/lim/∀ 这类**要塞上下条件**的复杂结构。
//   不是"所有符号都放"，也不是"提速"（打字时间上不赶），而是**少敲几个字符**。
//
// 记号约定（用户定案，务必遵守）：
//   · 记号**没有全局标准**——每个教授写法不同，甚至同一堂课有三种矢量写法。
//     所以数据表把常见变体都放上，由用户按当堂习惯挑。
//   · 本校本人的固定约定见 symbol-data.ts 的 INSTITUTIONAL_NOTATION。
//
// 纯数据 + 纯函数 → 可单测、可在任何前端（lecture GUI）复用。
// ============================================================

/**
 * 符号表再导出（数据在 symbol-data.ts）。
 *
 * 为什么拆开：数据表 250+ 项、十几个分组，混在本文件里会淹没
 * renderTemplate / insertSymbol 这些真正需要读懂的**逻辑**。
 */
export {
  SYMBOL_DATA as SYMBOL_GROUPS,
  INSTITUTIONAL_NOTATION,
  COMBINING,
  SYMBOL_GROUP_COUNT,
} from './symbol-data.js';
export { SYMBOL_LABEL_EN, SYMBOL_HINT_EN } from './symbol-en.js';
import { SYMBOL_DATA } from './symbol-data.js';

/** 插入时的光标行为：决定插入后光标停在哪。 */
export type CaretHint =
  /** 插入后可继续直接打字（如 `×`、`θ`） */
  | 'end'
  /** 插入 `{...}` 结构并把光标放进花括号（如 `\frac{}{}`） */
  | 'braces'
  /** 插入 `()` 结构并把光标放进圆括号（如 `\sin()`） */
  | 'parens'
  /** 插入后光标停在下标位置（如 `x_`） */
  | 'subscript';

/**
 * 模板插槽：`template` 里用 `$1` `$2` 标记光标依次停留的位置（Tab 跳转）。
 *
 * 为什么不复用 CaretHint：CaretHint 只描述"单个落点"，
 * 而 `∑_{i=1}^{n}` 需要两个**独立**的下标/上标插槽，
 * `∀x∈A` 也需要两个。用 `$n` 占位更贴切。
 */
export interface TemplateSlot {
  /** 在 template 中的占位符编号（1 起）。 */
  index: number;
  /** 提示文本（前端可显示为该插槽的 placeholder）。 */
  hint: string;
}

export interface MathSymbol {
  /** 边栏按钮上显示的文本。 */
  label: string;
  /** 实际插入到速记里的文本（**Unicode 优先**——见下方说明）。 */
  insert: string;
  /** 光标落点提示。 */
  caret: CaretHint;
  /** 悬停说明（可选）。 */
  hint?: string;
  /**
   * 多插槽模板（可选）。给定 `template` 时**优先于 `insert`/`caret`**。
   * 用 `$1` `$2` … 标记插槽；渲染后第一个插槽获得光标，Tab 依次跳到下一个。
   *
   * 例：`∑` 的 template = `'∑_{$1}^{$2} '`
   */
  template?: string;
  /** 模板插槽的说明（与 template 配合；仅用于 UI 提示）。 */
  slots?: TemplateSlot[];
  /** 该符号是不是"带条件的复杂结构"（用于分组排序/筛选）。 */
  kind?: 'simple' | 'structured';
}

export interface SymbolGroup {
  id: string;
  label: string;
  symbols: MathSymbol[];
}

/**
 * 为什么插入 **Unicode** 而不是 LaTeX 命令？
 *
 * 因为这条链路已经实测过（`check2.mjs` / `check5.mjs` 的符号往返测试）：
 * 速记里的 Unicode 会**无损落盘**，并被 LLM 转录员转成规范 LaTeX。
 * 而如果边栏直接插 `\int_{0}^{2\pi}`，会出现两个问题：
 *   1. 与"转录员负责补 LaTeX"的职责重叠，且 LaTeX 混在中文速记里更难读
 *   2. 你速记时看到的是 `\int`，复盘时看到的却是渲染前的东西——可读性差
 *
 * 插入 Unicode 后：**你打得快、看得懂，LaTeX 交给后端**。
 * 这正好是 D3「课堂内加工只留后端」的自然延伸。
 */

/** 展平全部符号（查找/测试用）。 */
export function allSymbols(): MathSymbol[] {
  return SYMBOL_DATA.flatMap((g) => g.symbols);
}

/** 按 label 查找（前端点击回调用）。 */
export function findSymbol(label: string): MathSymbol | undefined {
  return allSymbols().find((s) => s.label === label);
}

export interface InsertResult {
  /** 插入后的完整文本。 */
  text: string;
  /** 光标应落到的位置（字符索引）。 */
  caret: number;
  /**
   * 多插槽模板的**全部插槽光标位**（按 `$1` `$2` … 顺序）。
   * 单插槽/无模板时为空数组；前端据此实现 Tab 跳转。
   */
  slots: number[];
  /** 当前落点对应的插槽序号（1 起）；0 = 非插槽落点。 */
  activeSlot: number;
}

/**
 * 渲染模板：把 `$1` `$2` … 替换为空串（插槽留空），并记录每个插槽的光标位。
 *
 * 为什么要"留空"而不是放占位符文本：占位符会被当成真实内容，
 * 用户若忘了改就会写进笔记（如 `∑_{i=1}^{n}` 里的 `i=1` 变成字面量）。
 * 留空 + 前端用 placeholder 显示提示，才不会污染数据。
 */
export function renderTemplate(
  template: string,
  baseOffset: number,
  prefixLen = 0,
): { rendered: string; slots: number[] } {
  const slots: number[] = [];
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch === '$' && /\d/.test(template[i + 1] ?? '')) {
      // 读连续数字（支持 $10 以上）
      let j = i + 1;
      while (j < template.length && /\d/.test(template[j]!)) j++;
      const idx = Number(template.slice(i + 1, j));
      slots[idx - 1] = baseOffset + prefixLen + out.length;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  // 补齐未显式出现的插槽（防模板写错导致 holes）
  for (let k = 0; k < slots.length; k++) {
    if (slots[k] === undefined) slots[k] = baseOffset + prefixLen + out.length;
  }
  return { rendered: out, slots };
}

/**
 * 在光标处插入符号 —— **纯函数**，前端只需把结果写回 textarea 并设置 selectionStart。
 *
 * 为什么做成纯函数：光标逻辑最容易出错（括号配对、选区替换、末尾插入、
 * 模板插槽跳转），抽出来就能用单测覆盖，前端只负责 DOM 部分。
 *
 * 行为优先级：
 *   1. 有 `template` → 按模板渲染，光标落第一个插槽，`slots` 供 Tab 跳转
 *   2. `caret: 'parens'` → 插入 `f(` + `)`，光标在括号内
 *   3. `caret: 'braces'` → 插入 `f{` + `}`，光标在花括号内
 *   4. `caret: 'subscript'` → 插入 `_`，光标在其后
 *   5. 其余 → 追加，光标在末尾
 *
 * @param text 当前文本
 * @param selStart 选区起点（无选区时 = 光标位）
 * @param selEnd 选区终点
 * @param sym 要插入的符号
 * @param opts.autoSpace 插入前若不处于行首/空白后，自动补一个空格（避免与前面的词粘连）
 */
export function insertSymbol(
  text: string,
  selStart: number,
  selEnd: number,
  sym: MathSymbol,
  opts: { autoSpace?: boolean } = {},
): InsertResult {
  const a = Math.max(0, Math.min(selStart, text.length));
  const b = Math.max(a, Math.min(selEnd, text.length));
  const before = text.slice(0, a);
  const after = text.slice(b);

  // 自动补空格：前一个字符是字母/数字/中文/右括号时不粘连（如 "r"+"×" → "r ×"）
  let prefix = '';
  if (opts.autoSpace && before && !/\s$/.test(before)) {
    const last = before.slice(-1);
    if (/[A-Za-z0-9\u4e00-\u9fff)]/.test(last)) prefix = ' ';
  }

  // —— 多插槽模板（最高优先级）——
  if (sym.template) {
    const { rendered, slots } = renderTemplate(sym.template, before.length, prefix.length);
    const ins = prefix + rendered;
    const first = slots.length ? slots[0]! : before.length + ins.length;
    return { text: before + ins + after, caret: first, slots, activeSlot: slots.length ? 1 : 0 };
  }

  switch (sym.caret) {
    case 'parens': {
      const ins = prefix + sym.insert + ')';
      // 光标落在 `(` 与 `)` 之间
      const caret = before.length + prefix.length + sym.insert.length;
      return { text: before + ins + after, caret, slots: [], activeSlot: 0 };
    }
    case 'braces': {
      const ins = prefix + sym.insert + '}';
      const caret = before.length + prefix.length + sym.insert.length;
      return { text: before + ins + after, caret, slots: [], activeSlot: 0 };
    }
    case 'subscript': {
      const ins = prefix + sym.insert;
      return { text: before + ins + after, caret: before.length + ins.length, slots: [], activeSlot: 0 };
    }
    case 'end':
    default: {
      // 'end' 型：`√(` 这类已含开括号的，补上闭括号
      const needsClose = /\($/.test(sym.insert);
      const ins = prefix + sym.insert + (needsClose ? ')' : '');
      const caret = needsClose
        ? before.length + prefix.length + sym.insert.length
        : before.length + ins.length;
      return { text: before + ins + after, caret, slots: [], activeSlot: 0 };
    }
  }
}

/**
 * Tab 跳转：给定一次插入产生的 `slots` 与当前插槽序号，返回下一个插槽位置。
 *
 * 语义（对齐常见编辑器补全习惯）：
 *   · 还有下一个插槽 → 跳到它
 *   · 已是最后一个 → 返回 `null`（前端应放行 Tab，让用户继续打字或缩进）
 *
 * 注意：插槽位置依赖"用户尚未在其中输入"。用户一旦在插槽里打字，
 * 后续插槽位置会右移 —— 前端需按**已输入长度**修正（见 `shiftSlots`）。
 */
export function nextSlot(slots: readonly number[], activeSlot: number): number | null {
  if (!slots.length) return null;
  const nextIdx = activeSlot; // activeSlot 是 1 起 → 数组下标正好是"下一个"
  if (nextIdx >= slots.length) return null;
  return slots[nextIdx] ?? null;
}

/**
 * 修正插槽位置：用户在 `typedAt` 处输入了 `typedLen` 个字符后，
 * 位于其后的插槽位置整体右移。
 *
 * 用途：Tab 跳转时若用户已在插槽里打字，之前记录的绝对位置就失效了。
 */
export function shiftSlots(slots: readonly number[], typedAt: number, typedLen: number): number[] {
  return slots.map((p) => (p >= typedAt ? p + typedLen : p));
}

/** 所有插入文本的字符集（供"符号面板是否会污染检索"之类检查）。 */
export function insertedAlphabet(): string[] {
  return [...new Set(allSymbols().map((s) => s.template ?? s.insert).join(''))].sort();
}
