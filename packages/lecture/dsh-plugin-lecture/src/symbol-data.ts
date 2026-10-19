// ============================================================
// symbol-data.ts — 数学/物理符号板的数据表（纯数据，无逻辑）
//
// 设计依据（用户 2026-10 定案）：
//   1. **记号没有全局标准** —— "每个教授写法都不一样，甚至有些教授一堂课的
//      向量有三种写法"。所以这里**不假设一种规范**，把常见变体都放上，
//      由用户按当堂教授的习惯挑。
//   2. **本校本人的固定约定**（见 INSTITUTIONAL_NOTATION）：
//        · 对时间求导 → 点号 ṙ r̈
//        · 其余导数 → d/dx、∂/∂x
//        · 矢量 → 上划半箭头 r⃗（而非全箭头 →）
//      这组约定必须传给转录员，**不允许 LLM 改成 \vec 或 \frac{d}{dt}**。
//   3. 只放"键盘打起来费劲或打不出"的；`+ - =` 这类不放。
//
// 字符选择说明：
//   · 矢量箭头用 **U+20D7 组合上箭头**（"上划半箭头"），紧跟字母：
//     `r` + U+20D7 = r⃗。之所以不用 U+20D7 之外的全箭头（U+2192 →），
//     是因为全箭头在行内太宽、与"趋于"号混淆。
//   · 点号导数用 **U+0307 组合上点**（`r` + U+0307 = ṙ）、
//     **U+0308 组合双点**（`r` + U+0308 = r̈）。
//   · 上划线用 **U+0304 组合长音符号**（`r` + U+0304 = r̄），平均值/共轭用。
//   · 帽子用 **U+0302**（`r` + U+0302 = r̂），单位矢量用。
//   这些组合字符在笔记里是"一个字母 + 一个组合符号"，读起来正常、
//   LLM 也能理解；比 LaTeX 的 \vec{r} 更贴近手写习惯。
// ============================================================

import type { MathSymbol, SymbolGroup } from './symbols.js';

/** 组合附加符号（跟在字母后使用）。 */
export const COMBINING = {
  /** 矢量：上划半箭头（本校约定） */
  vector: '\u20D7',
  /** 对时间求导：一个点 */
  dot: '\u0307',
  /** 对时间求导：两个点 */
  ddot: '\u0308',
  /** 平均值 / 共轭：上划线 */
  bar: '\u0304',
  /** 单位矢量 / 算符：帽子 */
  hat: '\u0302',
  /** 波浪：近似 / 相位 */
  tilde: '\u0303',
  /** 下划线 */
  under: '\u0332',
} as const;

/**
 * 本校（汉堡大学 Physik I）固定记号约定。
 *
 * ⚠️ 这份表要**传给转录员**（见 transcriber.ts）——
 * 否则 LLM 会好心地把 `ṙ` 规范成 `\frac{dr}{dt}`、
 * 把半箭头矢量改成 `\vec{r}`，从而违背课上使用的记号。
 * 转录员的职责是"补 LaTeX 语法"，**不是改记号**。
 */
export const INSTITUTIONAL_NOTATION = {
  timeDerivative: '点号（ṙ、r̈）表示对时间求导 —— 不要改成 d/dt 或 \\frac{d}{dt}',
  otherDerivative: '其余导数用 d/dx、∂/∂x 写法',
  vector: '矢量用上划半箭头（组合符 U+20D7，如 r⃗）—— 不要改成 \\vec{r} 或粗体',
} as const;

/** 生成"字母 + 组合符"的按钮项（label 用示意字母 r）。 */
function combining(
  base: string,
  comb: string,
  label: string,
  hint: string,
): MathSymbol {
  return { label, insert: base + comb, caret: 'end', hint };
}

export const SYMBOL_DATA: readonly SymbolGroup[] = [
  // ============================================================
  // 1. 微积分
  // ============================================================
  {
    id: 'calculus',
    label: '微积分',
    symbols: [
      /**
       * ⚠️ 这里放的是**LaTeX**，不是 Unicode ∫。
       *
       * 为什么改（用户原话）：
       *   "最好做成 word 的等式输入那种吧"
       *   "也没有积分符号之类的上下左右填充"
       *
       * 早先 `∫ 上下限` 的 insert 是光秃秃的 `'∫'`，template 里那套 `$1/$2`
       * 前端**根本没读**（它只用了 sym.insert）→ 上下限得自己手打 LaTeX，
       * 上课来不及。现在交给 MathLive 解析成可视化结构。
       *
       * ⚠️⚠️ 必须用 `\placeholder{}` 而不是 `_{}^{}` —— 真机实测：
       *   插入 `\\int_{}^{}` 后打字，字符跑到积分**后面**（`\int_{}^{}7`），
       *   空花括号不是"可填的框"，只是空组。
       *   用 `\placeholder{}` 才真的产生**可点进去的占位框**：
       *       插入 `\int_{\placeholder{}}^{\placeholder{}}` → 打字落在下限里
       *       （实测得到 `\int_7^{\placeholder{}}`）。
       */
      { label: '∫', insert: '\\int ', caret: 'end', hint: '不定积分（后面补被积函数）' },
      {
        label: '∫ 上下限',
        insert: '\\int_{\\placeholder{}}^{\\placeholder{}} ',
        caret: 'end',
        hint: '定积分 —— 上下限框可直接点进去填（Tab 跳下一个框）',
      },
      {
        label: '∮ 路径',
        insert: '\\oint_{\\placeholder{}}^{\\placeholder{}} ',
        caret: 'end',
        hint: '闭合路径积分（环流）',
      },
      { label: '∮', insert: '\\oint ', caret: 'end', hint: '闭合路径积分（不带上下限）' },
      { label: '∬', insert: '\\iint ', caret: 'end', hint: '二重积分' },
      {
        label: '∬ 区域',
        insert: '\\iint_{\\placeholder{}}^{\\placeholder{}} ',
        caret: 'end',
        hint: '带区域的二重积分',
      },
      { label: '∭', insert: '\\iiint ', caret: 'end', hint: '三重积分' },
      {
        label: '∭ 体积',
        insert: '\\iiint_{\\placeholder{}}^{\\placeholder{}} ',
        caret: 'end',
        hint: '带体积的三重积分',
      },
      { label: '∯', insert: '\\oiint ', caret: 'end', hint: '闭合曲面积分（高斯定理）' },
      { label: 'd/dx', insert: 'd/dx ', caret: 'end', hint: '常导数（本校约定）' },
      { label: 'd/dt', insert: 'd/dt ', caret: 'end', hint: '对时间求导（写不出点号时用）' },
      { label: '∂/∂x', insert: '∂/∂x ', caret: 'end', hint: '偏导数' },
      { label: '∂²/∂x²', insert: '∂²/∂x² ', caret: 'end', hint: '二阶偏导' },
      { label: '∂²/∂x∂y', insert: '∂²/∂x∂y ', caret: 'end', hint: '混合偏导' },
      { label: '∇', insert: '∇', caret: 'end', hint: '纳布拉算子' },
      { label: '∇·', insert: '∇·', caret: 'end', hint: '散度 div' },
      { label: '∇×', insert: '∇×', caret: 'end', hint: '旋度 rot/curl' },
      { label: '∇²', insert: '∇²', caret: 'end', hint: '拉普拉斯算子' },
      { label: 'Δx 增量', insert: 'Δ', caret: 'end', hint: '增量 / 差分（大写 delta）' },
      { label: 'δ 变分', insert: 'δ', caret: 'end', hint: '变分 / 微小量 / 狄拉克 δ' },
      { label: 'lim', insert: 'lim', caret: 'end', kind: 'structured', template: 'lim_{$1} ', slots: [{ index: 1, hint: '趋近条件，如 x→0' }], hint: '极限（下方写条件）' },
      { label: 'lim sup', insert: 'lim sup', caret: 'end', kind: 'structured', template: 'lim sup_{$1} ', slots: [{ index: 1, hint: '条件，如 n→∞' }], hint: '上极限' },
      { label: 'lim inf', insert: 'lim inf', caret: 'end', kind: 'structured', template: 'lim inf_{$1} ', slots: [{ index: 1, hint: '条件，如 n→∞' }], hint: '下极限' },
      { label: '[待验证]', insert: '[待验证] ', caret: 'end', hint: '不确定的符号——诚实标记，绝不猜测' },
    ],
  },

  // ============================================================
  // 2. 求和 / 连乘 / 序列
  // ============================================================
  {
    id: 'sums',
    label: '求和与连乘',
    symbols: [
      { label: '∑', insert: '∑', caret: 'end', hint: '不带上下限的求和' },
      {
        label: '∑ 上下限',
        insert: '\\sum_{\\placeholder{}}^{\\placeholder{}} ',
        caret: 'end',
        kind: 'structured',
        hint: '带上下限的求和（Summenzeichen）',
      },
      {
        label: '∑ 仅下',
          insert: '\\sum_{\\placeholder{}} ',
        caret: 'end',
        kind: 'structured',
        template: '∑_{$1} ',
        slots: [{ index: 1, hint: '条件，如 i∈A' }],
        hint: '只有下标的求和',
      },
      { label: '∏', insert: '∏', caret: 'end', hint: '不带上下限的连乘' },
      {
        label: '∏ 上下限',
        insert: '\\prod_{\\placeholder{}}^{\\placeholder{}} ',
        caret: 'end',
        kind: 'structured',
        hint: '带上下限的连乘（Produktzeichen）',
      },
      {
        label: '∏ 仅下',
          insert: '\\prod_{\\placeholder{}} ',
        caret: 'end',
        kind: 'structured',
        template: '∏_{$1} ',
        slots: [{ index: 1, hint: '条件' }],
        hint: '只有下标的连乘',
      },
      { label: '⋃', insert: '⋃', caret: 'end', hint: '并集' },
      { label: '⋂', insert: '⋂', caret: 'end', hint: '交集' },
      {
        label: '⋃ 上下限',
        insert: '\\bigcup_{\\placeholder{}}^{\\placeholder{}} ',
        caret: 'end',
        kind: 'structured',
        hint: '带上下限的并集',
      },
      {
        label: '⋂ 上下限',
        insert: '\\bigcap_{\\placeholder{}}^{\\placeholder{}} ',
        caret: 'end',
        kind: 'structured',
        hint: '带上下限的交集',
      },
      { label: '⋯', insert: '⋯', caret: 'end', hint: '省略号（居中）' },
      { label: '…', insert: '…', caret: 'end', hint: '省略号（基线）' },
      { label: '⋮', insert: '⋮', caret: 'end', hint: '垂直省略号' },
    ],
  },

  // ============================================================
  // 3. 根号与上下标
  // ============================================================
  {
    id: 'roots',
    label: '根号与上下标',
    symbols: [
      { label: '√', insert: '√(', caret: 'parens', hint: '平方根' },
      {
        label: 'ⁿ√ 高次根',
        insert: '√',
        caret: 'end',
        kind: 'structured',
        template: '^{$1}√($2)',
        slots: [
          { index: 1, hint: '根次，如 3' },
          { index: 2, hint: '被开方数' },
        ],
        hint: 'n 次根',
      },
      { label: '∛', insert: '∛(', caret: 'parens', hint: '立方根' },
      { label: '∜', insert: '∜(', caret: 'parens', hint: '四次根' },
      { label: 'x²', insert: '²', caret: 'end', hint: '平方（上标）' },
      { label: 'x³', insert: '³', caret: 'end', hint: '立方' },
      { label: 'xⁿ', insert: '^', caret: 'end', hint: '任意次幂' },
      { label: 'x⁻¹', insert: '⁻¹', caret: 'end', hint: '倒数' },
      { label: 'x₀', insert: '₀', caret: 'end', hint: '下标 0' },
      { label: 'x₁', insert: '₁', caret: 'end', hint: '下标 1' },
      { label: 'x₂', insert: '₂', caret: 'end', hint: '下标 2' },
      { label: 'xᵢ', insert: 'ᵢ', caret: 'end', hint: '下标 i（爱因斯坦求和常用）' },
      { label: 'xⱼ', insert: 'ⱼ', caret: 'end', hint: '下标 j' },
      { label: 'xₖ', insert: 'ₖ', caret: 'end', hint: '下标 k' },
      { label: 'xₙ', insert: 'ₙ', caret: 'end', hint: '下标 n' },
      { label: 'xₘ', insert: 'ₘ', caret: 'end', hint: '下标 m' },
      { label: 'a_{ij}', insert: '_{', caret: 'end', kind: 'structured', template: '_{$1}', slots: [{ index: 1, hint: '双下标，如 ij' }], hint: '多字符下标（矩阵元）' },
      { label: 'x^{n+1}', insert: '^{', caret: 'end', kind: 'structured', template: '^{$1}', slots: [{ index: 1, hint: '复合指数，如 n+1' }], hint: '多字符上标' },
    ],
  },

  // ============================================================
  // 4. 矢量与导数记号（本校约定：点号 = 时间导数；半箭头 = 矢量）
  // ============================================================
  {
    id: 'vectors',
    label: '矢量与导数记号',
    symbols: [
      /**
       * ⚠️ 矢量改成 `\vec{}`，**字母可自定义**。
       *
       * 真机反馈："符号键盘的向量不可以自定义向量字母"
       * —— 早先全是硬编码的 `r⃗`（combining 组合符拼出来的），
       * 上课要标 a⃗、v⃗、F⃗、B⃗ 就傻眼了。
       *
       * 现在：插进去的是 `\vec{}`，花括号里**随便填字母**。
       * 本校约定仍是"上划半箭头"——MathLive 渲染 `\vec{a}` 就是 a 上加半箭头，
       * 符合 INSTITUTIONAL_NOTATION，不需要改成别的写法。
       */
      { label: 'a⃗ 矢量', insert: '\\vec{\\placeholder{}} ', caret: 'end', hint: '矢量 —— 点进花括号填任意字母（a v F B…）' },
      { label: 'ṙ 时间导数', insert: '\\dot{\\placeholder{}} ', caret: 'end', hint: '一个点 = d/dt（本校约定）—— 字母可自定义' },
      { label: 'r̈ 二次', insert: '\\ddot{\\placeholder{}} ', caret: 'end', hint: '两个点 = d²/dt²' },
      { label: 'r̄ 平均值', insert: '\\overline{\\placeholder{}} ', caret: 'end', hint: '上划线：平均 / 复数共轭' },
      { label: 'r̂ 单位矢量', insert: '\\hat{\\placeholder{}} ', caret: 'end', hint: '帽子：单位矢量 / 算符' },
      { label: 'r̃ 波浪', insert: '\\tilde{\\placeholder{}} ', caret: 'end', hint: '波浪：近似 / 相位' },
      { label: 'r̲ 下划线', insert: '\\underline{\\placeholder{}} ', caret: 'end', hint: '下划线：强调 / 张量分量' },
      /** 纯 Unicode 版本：不想进公式模式、只想打普通文本时用。 */
      combining('r', COMBINING.vector, 'r⃗ 纯文本', '上划半箭头（不带公式）—— 加在任意字母后'),
      { label: '→ 趋于', insert: '→', caret: 'end', hint: '趋于（极限）' },
      { label: '↦ 映射到', insert: '↦', caret: 'end', hint: '映射' },
      { label: '⇒ 推出', insert: '⇒', caret: 'end', hint: '蕴含（folgt）' },
      { label: '⇔ 等价', insert: '⇔', caret: 'end', hint: '当且仅当（gdw.）' },
      { label: '· 点乘', insert: '·', caret: 'end', hint: '标量积 / 普通乘法' },
      { label: '× 叉乘', insert: '×', caret: 'end', hint: '矢量积 / 普通乘号' },
      { label: '⊗', insert: '⊗', caret: 'end', hint: '张量积' },
      { label: '⟨ ⟩ 尖括号', insert: '⟨⟩', caret: 'end', hint: '内积 / 期望值' },
      {
        label: '⟨ψ| 左矢',
        insert: '⟨',
        caret: 'end',
        kind: 'structured',
        template: '⟨$1| ',
        slots: [{ index: 1, hint: '态，如 ψ' }],
        hint: 'bra（量子力学）',
      },
      {
        label: '|ψ⟩ 右矢',
        insert: '|',
        caret: 'end',
        kind: 'structured',
        template: '|$1⟩ ',
        slots: [{ index: 1, hint: '态，如 ψ' }],
        hint: 'ket（量子力学）',
      },
      {
        label: '⟨φ|ψ⟩ 内积',
        insert: '⟨',
        caret: 'end',
        kind: 'structured',
        template: '⟨$1|$2⟩ ',
        slots: [
          { index: 1, hint: '左态' },
          { index: 2, hint: '右态' },
        ],
        hint: 'braket（量子力学）',
      },
      {
        label: '⟨A⟩ 期望值',
        insert: '⟨',
        caret: 'end',
        kind: 'structured',
        template: '⟨$1⟩ ',
        slots: [{ index: 1, hint: '物理量，如 x' }],
        hint: '期望值 / 平均值',
      },
    ],
  },

  // ============================================================
  // 5. 三角函数与双曲函数
  // ============================================================
  {
    id: 'trig',
    label: '三角函数',
    symbols: [
      { label: 'sin', insert: 'sin(', caret: 'parens' },
      { label: 'cos', insert: 'cos(', caret: 'parens' },
      { label: 'tan', insert: 'tan(', caret: 'parens' },
      { label: 'cot', insert: 'cot(', caret: 'parens' },
      { label: 'sec', insert: 'sec(', caret: 'parens' },
      { label: 'csc', insert: 'csc(', caret: 'parens' },
      { label: 'arcsin', insert: 'arcsin(', caret: 'parens' },
      { label: 'arccos', insert: 'arccos(', caret: 'parens' },
      { label: 'arctan', insert: 'arctan(', caret: 'parens' },
      { label: 'sin²', insert: 'sin²(', caret: 'parens', hint: '平方写法（sin²θ）' },
      { label: 'cos²', insert: 'cos²(', caret: 'parens' },
      { label: 'sinh', insert: 'sinh(', caret: 'parens' },
      { label: 'cosh', insert: 'cosh(', caret: 'parens' },
      { label: 'tanh', insert: 'tanh(', caret: 'parens' },
      { label: 'arsinh', insert: 'arsinh(', caret: 'parens', hint: '反双曲正弦（德式写法）' },
      { label: 'arcosh', insert: 'arcosh(', caret: 'parens' },
      { label: 'artanh', insert: 'artanh(', caret: 'parens' },
      { label: 'eˣ', insert: 'e^', caret: 'end', hint: '指数（自己补指数）' },
      { label: 'exp', insert: 'exp(', caret: 'parens', hint: '指数函数' },
      { label: 'ln', insert: 'ln(', caret: 'parens', hint: '自然对数（德式常用）' },
      { label: 'log', insert: 'log(', caret: 'parens' },
      { label: 'lg', insert: 'lg(', caret: 'parens', hint: '常用对数（底 10）' },
      { label: 'log₂', insert: 'log₂(', caret: 'parens', hint: '以 2 为底' },
    ],
  },

  // ============================================================
  // 6. 希腊字母（小写全 + 常用大写）
  // ============================================================
  {
    id: 'greek',
    label: '希腊字母',
    symbols: [
      { label: 'α', insert: 'α', caret: 'end' },
      { label: 'β', insert: 'β', caret: 'end' },
      { label: 'γ', insert: 'γ', caret: 'end' },
      { label: 'δ', insert: 'δ', caret: 'end' },
      { label: 'ε', insert: 'ε', caret: 'end', hint: 'epsilon' },
      { label: 'ϑ', insert: 'ϑ', caret: 'end', hint: 'theta 变体（vartheta）' },
      { label: 'ζ', insert: 'ζ', caret: 'end' },
      { label: 'η', insert: 'η', caret: 'end' },
      { label: 'θ', insert: 'θ', caret: 'end', hint: '角度（与 ω 易混）' },
      { label: 'ι', insert: 'ι', caret: 'end' },
      { label: 'κ', insert: 'κ', caret: 'end' },
      { label: 'λ', insert: 'λ', caret: 'end', hint: '波长 / 特征值' },
      { label: 'μ', insert: 'μ', caret: 'end', hint: '摩擦系数 / 微（10⁻⁶）' },
      { label: 'ν', insert: 'ν', caret: 'end', hint: '频率（与 v 区分！）' },
      { label: 'ξ', insert: 'ξ', caret: 'end' },
      { label: 'π', insert: 'π', caret: 'end' },
      { label: 'ϱ', insert: 'ϱ', caret: 'end', hint: 'rho 变体' },
      { label: 'ρ', insert: 'ρ', caret: 'end', hint: '密度 / 电阻率' },
      { label: 'σ', insert: 'σ', caret: 'end', hint: '应力 / 标准差' },
      { label: 'ς', insert: 'ς', caret: 'end', hint: 'sigma 词尾形' },
      { label: 'τ', insert: 'τ', caret: 'end', hint: '力矩 / 时间常数' },
      { label: 'υ', insert: 'υ', caret: 'end' },
      { label: 'φ', insert: 'φ', caret: 'end', hint: '相位 / 角度' },
      { label: 'ϕ', insert: 'ϕ', caret: 'end', hint: 'phi 变体（varphi 的另一种字形）' },
      { label: 'χ', insert: 'χ', caret: 'end', hint: '磁化率' },
      { label: 'ψ', insert: 'ψ', caret: 'end', hint: '波函数' },
      { label: 'ω', insert: 'ω', caret: 'end', hint: '角速度（与 w 易混！）' },
      { label: 'Γ', insert: 'Γ', caret: 'end' },
      { label: 'Δ', insert: 'Δ', caret: 'end', hint: '增量（与 δ 区分）' },
      { label: 'Θ', insert: 'Θ', caret: 'end' },
      { label: 'Λ', insert: 'Λ', caret: 'end' },
      { label: 'Ξ', insert: 'Ξ', caret: 'end' },
      { label: 'Π', insert: 'Π', caret: 'end' },
      { label: 'Σ', insert: 'Σ', caret: 'end' },
      { label: 'Υ', insert: 'Υ', caret: 'end' },
      { label: 'Φ', insert: 'Φ', caret: 'end', hint: '磁通' },
      { label: 'Ψ', insert: 'Ψ', caret: 'end', hint: '波函数（大写）' },
      { label: 'Ω 欧姆', insert: 'Ω', caret: 'end', hint: '欧姆 / 立体角（大写 omega）' },
      { label: 'Ω 立体角', insert: 'Ω', caret: 'end', hint: '立体角（sr）' },
    ],
  },

  // ============================================================
  // 7. 集合与逻辑
  // ============================================================
  {
    id: 'sets',
    label: '集合与逻辑',
    symbols: [
      { label: '∈', insert: '∈', caret: 'end', hint: '属于（Element von）' },
      { label: '∉', insert: '∉', caret: 'end', hint: '不属于' },
      { label: '∋', insert: '∋', caret: 'end', hint: '包含某元素' },
      { label: '⊂', insert: '⊂', caret: 'end', hint: '真子集' },
      { label: '⊆', insert: '⊆', caret: 'end', hint: '子集（可相等）' },
      { label: '⊃', insert: '⊃', caret: 'end', hint: '真超集' },
      { label: '⊇', insert: '⊇', caret: 'end', hint: '超集' },
      { label: '⊄', insert: '⊄', caret: 'end', hint: '非子集' },
      { label: '∪', insert: '∪', caret: 'end', hint: '并集' },
      { label: '∩', insert: '∩', caret: 'end', hint: '交集' },
      { label: '∅', insert: '∅', caret: 'end', hint: '空集' },
      { label: '\\', insert: '\\', caret: 'end', hint: '差集（A\\B）' },
      { label: '× 笛卡尔积', insert: '×', caret: 'end', hint: 'A×B 笛卡尔积' },
      {
        label: '∀ 任意',
        insert: '∀',
        caret: 'end',
        kind: 'structured',
        template: '∀$1∈$2: ',
        slots: [
          { index: 1, hint: '变量，如 x' },
          { index: 2, hint: '集合，如 ℝ' },
        ],
        hint: '对所有 x∈A 成立（für alle gilt）',
      },
      {
        label: '∃ 存在',
        insert: '∃',
        caret: 'end',
        kind: 'structured',
        template: '∃$1∈$2: ',
        slots: [
          { index: 1, hint: '变量' },
          { index: 2, hint: '集合' },
        ],
        hint: '存在 x∈A（es existiert）',
      },
      { label: '∄', insert: '∄', caret: 'end', hint: '不存在' },
      { label: '¬', insert: '¬', caret: 'end', hint: '非 / 否定' },
      { label: '∧', insert: '∧', caret: 'end', hint: '且' },
      { label: '∨', insert: '∨', caret: 'end', hint: '或' },
      {
        label: '| 条件',
        insert: ' | ',
        caret: 'end',
        hint: '满足条件（如 {x | x>0}）',
      },
      { label: 'ℝ', insert: 'ℝ', caret: 'end', hint: '实数集' },
      { label: 'ℕ', insert: 'ℕ', caret: 'end', hint: '自然数集' },
      { label: 'ℤ', insert: 'ℤ', caret: 'end', hint: '整数集' },
      { label: 'ℚ', insert: 'ℚ', caret: 'end', hint: '有理数集' },
      { label: 'ℂ', insert: 'ℂ', caret: 'end', hint: '复数集' },
      { label: '𝔽', insert: '𝔽', caret: 'end', hint: '域' },
      { label: '∘ 复合', insert: '∘', caret: 'end', hint: '函数复合（f∘g）' },
      { label: '□ Q.E.D.', insert: '□', caret: 'end', hint: '证毕（qed）' },
    ],
  },

  // ============================================================
  // 8. 关系与比较
  // ============================================================
  {
    id: 'relations',
    label: '关系与比较',
    symbols: [
      { label: '≈', insert: '≈', caret: 'end', hint: '约等于' },
      { label: '≠', insert: '≠', caret: 'end', hint: '不等于' },
      { label: '≡', insert: '≡', caret: 'end', hint: '恒等 / 同余' },
      { label: '≅', insert: '≅', caret: 'end', hint: '同构 / 全等' },
      { label: '∼', insert: '∼', caret: 'end', hint: '相似 / 成正比' },
      { label: '∝', insert: '∝', caret: 'end', hint: '正比于' },
      { label: '≤', insert: '≤', caret: 'end', hint: '小于等于' },
      { label: '≥', insert: '≥', caret: 'end', hint: '大于等于' },
      { label: '≪', insert: '≪', caret: 'end', hint: '远小于（近似常用）' },
      { label: '≫', insert: '≫', caret: 'end', hint: '远大于' },
      { label: '≃', insert: '≃', caret: 'end', hint: '渐近等于' },
      { label: '≐', insert: '≐', caret: 'end', hint: '定义为' },
      { label: ':=', insert: ':=', caret: 'end', hint: '定义为（德式常见）' },
      { label: '≙', insert: '≙', caret: 'end', hint: '对应于' },
      { label: '⭐ 定义', insert: '≔', caret: 'end', hint: '定义为' },
      { label: '⊥', insert: '⊥', caret: 'end', hint: '正交 / 垂直' },
      { label: '∥', insert: '∥', caret: 'end', hint: '平行' },
      { label: '∠', insert: '∠', caret: 'end', hint: '角' },
      { label: '°', insert: '°', caret: 'end', hint: '度' },
      { label: '′', insert: '′', caret: 'end', hint: '撇（导数 / 角分）' },
      { label: '″', insert: '″', caret: 'end', hint: '双撇（二阶导 / 角秒）' },
    ],
  },

  // ============================================================
  // 9. 物理常用
  // ============================================================
  {
    id: 'physics',
    label: '物理常用',
    symbols: [
      { label: 'ℏ', insert: 'ℏ', caret: 'end', hint: '约化普朗克常数' },
      { label: 'ħ', insert: 'ħ', caret: 'end', hint: 'h-bar 另一字形' },
      { label: 'µ', insert: 'µ', caret: 'end', hint: '微（10⁻⁶，注意是 U+00B5）' },
      { label: 'Å', insert: 'Å', caret: 'end', hint: '埃（10⁻¹⁰ m）' },
      { label: '℃', insert: '℃', caret: 'end', hint: '摄氏度' },
      { label: '∂', insert: '∂', caret: 'end', hint: '偏导符号（单独用）' },
      { label: '⊤', insert: '⊤', caret: 'end', hint: '转置 / 真' },
      { label: '†', insert: '†', caret: 'end', hint: '厄米共轭' },
      { label: '*', insert: '*', caret: 'end', hint: '复共轭 / 卷积' },
      { label: '⊛', insert: '⊛', caret: 'end', hint: '卷积' },
      { label: '⊙', insert: '⊙', caret: 'end', hint: '哈达玛积' },
      { label: '∼ 渐近', insert: '∼', caret: 'end', hint: '渐近 / 相似' },
      { label: '⌐', insert: '⌐', caret: 'end', hint: '否定（逻辑）' },
      { label: 'O( )', insert: 'O(', caret: 'parens', hint: '大 O 记号（渐近复杂度）' },
      { label: '𝒪( )', insert: '𝒪(', caret: 'parens', hint: '大 O（花体）' },
      { label: 'Θ( )', insert: 'Θ(', caret: 'parens', hint: 'Theta 记号（紧确界）' },
      { label: 'µ₀', insert: 'µ₀', caret: 'end', hint: '真空磁导率' },
      { label: 'ε₀', insert: 'ε₀', caret: 'end', hint: '真空介电常数' },
      { label: 'Δx', insert: 'Δ', caret: 'end', hint: '不确定度 / 增量' },
      { label: '√(2π)', insert: '√(2π)', caret: 'end', hint: '高斯积分常用' },
    ],
  },

  // ============================================================
  // 10. 箭头与映射
  // ============================================================
  {
    id: 'arrows',
    label: '箭头与映射',
    symbols: [
      { label: '→', insert: '→', caret: 'end', hint: '趋于 / 映射到' },
      { label: '←', insert: '←', caret: 'end', hint: '反方向' },
      { label: '↔', insert: '↔', caret: 'end', hint: '双向' },
      { label: '⇒', insert: '⇒', caret: 'end', hint: '推出（folgt）' },
      { label: '⇐', insert: '⇐', caret: 'end', hint: '被推出' },
      { label: '⇔', insert: '⇔', caret: 'end', hint: '当且仅当' },
      { label: '↑', insert: '↑', caret: 'end', hint: '上升 / 自旋向上' },
      { label: '↓', insert: '↓', caret: 'end', hint: '下降 / 自旋向下' },
      { label: '↗', insert: '↗', caret: 'end' },
      { label: '↘', insert: '↘', caret: 'end' },
      { label: '⟶ 长箭头', insert: '⟶', caret: 'end', hint: '长右箭头（映射）' },
      { label: '↦', insert: '↦', caret: 'end', hint: '映射到（元素级）' },
    ],
  },

  // ============================================================
  // 11. 括号与结构
  // ============================================================
  {
    id: 'brackets',
    label: '括号与结构',
    symbols: [
      { label: '( )', insert: '(', caret: 'parens', hint: '圆括号' },
      { label: '[ ]', insert: '[', caret: 'end', kind: 'structured', template: '[$1]', slots: [{ index: 1, hint: '内容' }], hint: '方括号（单位 / 区间）' },
      { label: '{ }', insert: '{', caret: 'end', kind: 'structured', template: '{$1}', slots: [{ index: 1, hint: '内容' }], hint: '花括号（集合）' },
      { label: '⌈ ⌉', insert: '⌈', caret: 'end', kind: 'structured', template: '⌈$1⌉', slots: [{ index: 1, hint: '内容' }], hint: '上取整' },
      { label: '⌊ ⌋', insert: '⌊', caret: 'end', kind: 'structured', template: '⌊$1⌋', slots: [{ index: 1, hint: '内容' }], hint: '下取整' },
      {
        label: '|x| 绝对值',
        insert: '|',
        caret: 'end',
        kind: 'structured',
        template: '|$1|',
        slots: [{ index: 1, hint: '内容' }],
        hint: '绝对值 / 模',
      },
      {
        label: '‖x‖ 范数',
        insert: '‖',
        caret: 'end',
        kind: 'structured',
        template: '‖$1‖',
        slots: [{ index: 1, hint: '内容' }],
        hint: '范数',
      },
      {
        label: '分数',
        insert: '(',
        caret: 'parens',
        hint: '打 (a)/(b) —— 转录员会转成 LaTeX 分式',
      },
      {
        label: '(a)/(b) 分式',
        insert: '(',
        caret: 'end',
        kind: 'structured',
        template: '($1)/($2)',
        slots: [
          { index: 1, hint: '分子' },
          { index: 2, hint: '分母' },
        ],
        hint: '显式分式（Tab 跳分子→分母）',
      },
      {
        label: '矩阵 2×2',
        insert: '(',
        caret: 'end',
        kind: 'structured',
        template: '[$1 $2; $3 $4]',
        slots: [
          { index: 1, hint: 'a11' },
          { index: 2, hint: 'a12' },
          { index: 3, hint: 'a21' },
          { index: 4, hint: 'a22' },
        ],
        hint: '2×2 矩阵（分号换行）',
      },
      {
        label: '行列式',
        insert: '|',
        caret: 'end',
        kind: 'structured',
        template: '|$1|',
        slots: [{ index: 1, hint: '矩阵元素' }],
        hint: '行列式',
      },
      {
        label: '组合 C(n,k)',
        insert: '(',
        caret: 'end',
        kind: 'structured',
        template: '($1 choose $2)',
        slots: [
          { index: 1, hint: 'n' },
          { index: 2, hint: 'k' },
        ],
        hint: '二项式系数',
      },
      { label: '⎛⎝ 大括号', insert: '(', caret: 'end', hint: '需要大括号时手动配' },
    ],
  },

  // ============================================================
  // 12. 单位与常量（物理题高频）
  // ============================================================
  {
    id: 'units',
    label: '单位',
    symbols: [
      { label: '°C', insert: '°C', caret: 'end', hint: '摄氏度' },
      { label: 'Ω', insert: 'Ω', caret: 'end', hint: '欧姆' },
      { label: 'µF', insert: 'µF', caret: 'end', hint: '微法' },
      { label: 'µA', insert: 'µA', caret: 'end', hint: '微安' },
      { label: 'µm', insert: 'µm', caret: 'end', hint: '微米' },
      { label: 'nm', insert: 'nm', caret: 'end', hint: '纳米（波长常用）' },
      { label: 'kHz', insert: 'kHz', caret: 'end' },
      { label: 'MHz', insert: 'MHz', caret: 'end' },
      { label: 'GHz', insert: 'GHz', caret: 'end' },
      { label: 'eV', insert: 'eV', caret: 'end', hint: '电子伏特' },
      { label: 'keV', insert: 'keV', caret: 'end' },
      { label: 'MeV', insert: 'MeV', caret: 'end' },
      { label: 'GeV', insert: 'GeV', caret: 'end' },
      { label: '·10⁻¹', insert: '·10⁻¹', caret: 'end', hint: '数量级写法' },
      { label: '·10⁻³', insert: '·10⁻³', caret: 'end' },
      { label: '·10⁻⁶', insert: '·10⁻⁶', caret: 'end' },
      { label: '·10⁻⁹', insert: '·10⁻⁹', caret: 'end' },
      { label: '·10³', insert: '·10³', caret: 'end' },
      { label: '·10⁶', insert: '·10⁶', caret: 'end' },
      { label: '·10⁹', insert: '·10⁹', caret: 'end' },
      { label: '×10ⁿ', insert: '×10^', caret: 'end', hint: '科学计数法（自己补指数）' },
    ],
  },
];

/** 分组数量（自检用）。 */
export const SYMBOL_GROUP_COUNT = SYMBOL_DATA.length;