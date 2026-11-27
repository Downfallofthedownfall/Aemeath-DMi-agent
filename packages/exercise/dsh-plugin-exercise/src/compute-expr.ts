// ============================================================
// compute-expr.ts — 「一键计算」的算式语言：解析 / 求值 / 转成 SymPy 代码（纯函数，零依赖）
//
// 用户 2026-11-27："加一个一键填充 compute，用来在用户写好式子之后计算最终结果，
//   可行的话用现有的 py-compute 验证，注意不要让模型做题，只是代替计算器"。
//
// 分工（见 compute.ts）：模型只把学生写的 LaTeX **转写**成这里的算式（`sqrt(2*g*h)`），
// 并说明每个字母的数值出自哪里；**数是这里算的**（双精度），再交给 py-compute
// （sympy_mcp 的 compute_symbolic，SymPy/mpmath）独立复算一遍。模型的输出里没有结果数字。
//
// 语法：数字、+ - * / ^ (**)、括号、隐式乘法（2pi、2(3)）、后缀 !、
//       函数 sqrt root sin cos tan asin acos atan sinh cosh tanh exp ln log log10 abs factorial，
//       常数 pi；其余标识符都是字母（变量），必须有数值。
// ============================================================

export const COMPUTE_FUNCTIONS = [
  'sqrt',
  'root',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'exp',
  'ln',
  'log',
  'log10',
  'abs',
  'factorial',
] as const;
export type ComputeFn = (typeof COMPUTE_FUNCTIONS)[number];
const FN_SET = new Set<string>(COMPUTE_FUNCTIONS);

export type ExprNode =
  | { k: 'num'; v: number; text: string }
  | { k: 'sym'; name: string }
  | { k: 'pi' }
  | { k: 'neg'; a: ExprNode }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: ExprNode; b: ExprNode }
  | { k: 'fn'; name: ComputeFn; args: ExprNode[] };

export class ExprError extends Error {}

type Tok =
  | { t: 'num'; v: number; text: string }
  | { t: 'id'; name: string }
  | { t: 'op'; op: string };

/** 算式最长多少字符（再长就不是"按计算器"了）。 */
export const MAX_EXPR_LENGTH = 400;

function tokenize(src: string): Tok[] {
  const s = src.replace(/[−–]/g, '-').replace(/[×·]/g, '*');
  if (s.length > MAX_EXPR_LENGTH) throw new ExprError('expression too long');
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (num) {
      const v = Number(num[0]);
      if (!Number.isFinite(v)) throw new ExprError(`bad number ${num[0]}`);
      out.push({ t: 'num', v, text: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z][A-Za-z0-9_]*/.exec(s.slice(i));
    if (id) {
      out.push({ t: 'id', name: id[0] });
      i += id[0].length;
      continue;
    }
    if (s.startsWith('**', i)) {
      out.push({ t: 'op', op: '^' });
      i += 2;
      continue;
    }
    if ('+-*/^(),!'.includes(c)) {
      out.push({ t: 'op', op: c });
      i++;
      continue;
    }
    throw new ExprError(`unexpected character "${c}"`);
  }
  return out;
}

/** 解析算式；语法不对抛 ExprError。 */
export function parseExpr(src: string): ExprNode {
  const toks = tokenize(src);
  let i = 0;
  const peek = (): Tok | undefined => toks[i];
  const isOp = (op: string): boolean => {
    const t = toks[i];
    return !!t && t.t === 'op' && t.op === op;
  };
  const expect = (op: string): void => {
    if (!isOp(op)) throw new ExprError(`expected "${op}"`);
    i++;
  };

  const expr = (): ExprNode => {
    let a = term();
    while (isOp('+') || isOp('-')) {
      const op = (toks[i++] as { op: '+' | '-' }).op;
      a = { k: 'bin', op, a, b: term() };
    }
    return a;
  };
  /** 一个因子能否开头（用于隐式乘法：`2pi`、`2(3)`、`g h`）。 */
  const startsPrimary = (): boolean => {
    const t = peek();
    return !!t && (t.t === 'num' || t.t === 'id' || (t.t === 'op' && t.op === '('));
  };
  const term = (): ExprNode => {
    let a = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = (toks[i++] as { op: '*' | '/' }).op;
        a = { k: 'bin', op, a, b: unary() };
      } else if (startsPrimary()) {
        a = { k: 'bin', op: '*', a, b: power() };
      } else {
        return a;
      }
    }
  };
  const unary = (): ExprNode => {
    if (isOp('-')) {
      i++;
      return { k: 'neg', a: unary() };
    }
    if (isOp('+')) {
      i++;
      return unary();
    }
    return power();
  };
  const power = (): ExprNode => {
    const base = postfix();
    if (isOp('^')) {
      i++;
      return { k: 'bin', op: '^', a: base, b: unary() }; // 右结合；`2^-1` 合法
    }
    return base;
  };
  const postfix = (): ExprNode => {
    let a = primary();
    while (isOp('!')) {
      i++;
      a = { k: 'fn', name: 'factorial', args: [a] };
    }
    return a;
  };
  const primary = (): ExprNode => {
    const t = peek();
    if (!t) throw new ExprError('unexpected end');
    if (t.t === 'num') {
      i++;
      return { k: 'num', v: t.v, text: t.text };
    }
    if (t.t === 'op' && t.op === '(') {
      i++;
      const inner = expr();
      expect(')');
      return inner;
    }
    if (t.t === 'id') {
      i++;
      if (FN_SET.has(t.name)) {
        if (!isOp('(')) throw new ExprError(`function ${t.name} needs (...)`);
        i++;
        const args: ExprNode[] = [expr()];
        while (isOp(',')) {
          i++;
          args.push(expr());
        }
        expect(')');
        const name = t.name as ComputeFn;
        const arity = name === 'root' ? [2] : name === 'log' ? [1, 2] : [1];
        if (!arity.includes(args.length)) throw new ExprError(`${name} takes ${arity.join(' or ')} argument(s)`);
        return { k: 'fn', name, args };
      }
      if (t.name === 'pi') return { k: 'pi' };
      return { k: 'sym', name: t.name };
    }
    throw new ExprError(`unexpected "${t.t === 'op' ? t.op : ''}"`);
  };

  const root = expr();
  if (i < toks.length) throw new ExprError('trailing input');
  return root;
}

/** 算式里出现的字母（去重，按出现顺序）。 */
export function exprSymbols(node: ExprNode): string[] {
  const out: string[] = [];
  const walk = (n: ExprNode): void => {
    if (n.k === 'sym') {
      if (!out.includes(n.name)) out.push(n.name);
    } else if (n.k === 'neg') walk(n.a);
    else if (n.k === 'bin') {
      walk(n.a);
      walk(n.b);
    } else if (n.k === 'fn') n.args.forEach(walk);
  };
  walk(node);
  return out;
}

/** 算式里出现的数字字面量（原文写法）。 */
export function exprNumbers(node: ExprNode): string[] {
  const out: string[] = [];
  const walk = (n: ExprNode): void => {
    if (n.k === 'num') out.push(n.text);
    else if (n.k === 'neg') walk(n.a);
    else if (n.k === 'bin') {
      walk(n.a);
      walk(n.b);
    } else if (n.k === 'fn') n.args.forEach(walk);
  };
  walk(node);
  return out;
}

export function exprUsesPi(node: ExprNode): boolean {
  if (node.k === 'pi') return true;
  if (node.k === 'neg') return exprUsesPi(node.a);
  if (node.k === 'bin') return exprUsesPi(node.a) || exprUsesPi(node.b);
  if (node.k === 'fn') return node.args.some(exprUsesPi);
  return false;
}

export interface EvalResult {
  value: number;
  /**
   * 双精度舍入误差的一阶估计（绝对值）：沿解析树传播（加减相加、乘除按相对误差、函数乘导数）。
   * `sin(pi)` 在双精度里是 1.2e-16 而不是 0，而它的误差估计 ~1e-15 —— 结果落在误差里就当 0；
   * 和 SymPy 比对时也按它给绝对容差。只按"加数有多大"估是不行的：`q·(U₁−U₂)` 会被放得太宽。
   */
  err: number;
}

const EPS = Number.EPSILON;

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

/** 一元函数的值（定义域外 NaN）。 */
function unary(name: ComputeFn, x: number): number {
  switch (name) {
    case 'sqrt':
      return x < 0 ? NaN : Math.sqrt(x);
    case 'sin':
      return Math.sin(x);
    case 'cos':
      return Math.cos(x);
    case 'tan':
      return Math.tan(x);
    case 'asin':
      return Math.asin(x);
    case 'acos':
      return Math.acos(x);
    case 'atan':
      return Math.atan(x);
    case 'sinh':
      return Math.sinh(x);
    case 'cosh':
      return Math.cosh(x);
    case 'tanh':
      return Math.tanh(x);
    case 'exp':
      return Math.exp(x);
    case 'ln':
    case 'log':
      return x <= 0 ? NaN : Math.log(x);
    case 'log10':
      return x <= 0 ? NaN : Math.log10(x);
    case 'abs':
      return Math.abs(x);
    case 'factorial':
      return factorial(x);
    default:
      return NaN;
  }
}

/** 一元函数的导数绝对值（误差传播用；阶乘只接受精确整数，不传播）。 */
function unaryDeriv(name: ComputeFn, x: number, fx: number): number {
  switch (name) {
    case 'sqrt':
      return fx > 0 ? 1 / (2 * fx) : Infinity;
    case 'sin':
      return Math.abs(Math.cos(x));
    case 'cos':
      return Math.abs(Math.sin(x));
    case 'tan':
      return 1 + fx * fx;
    case 'asin':
    case 'acos':
      return 1 / Math.sqrt(Math.max(0, 1 - x * x));
    case 'atan':
      return 1 / (1 + x * x);
    case 'sinh':
      return Math.abs(Math.cosh(x));
    case 'cosh':
      return Math.abs(Math.sinh(x));
    case 'tanh':
      return 1 - fx * fx;
    case 'exp':
      return Math.abs(fx);
    case 'ln':
    case 'log':
      return 1 / Math.abs(x);
    case 'log10':
      return 1 / (Math.abs(x) * Math.LN10);
    case 'abs':
      return 1;
    default:
      return 0;
  }
}

/** 求值。缺数值的字母抛 ExprError；定义域外（负数开平方等）得到 NaN，由调用方报。 */
export function evalExpr(node: ExprNode, values: ReadonlyMap<string, number>): EvalResult {
  type R = { v: number; e: number };
  const leaf = (v: number): R => ({ v, e: Math.abs(v) * EPS });
  const ev = (n: ExprNode): R => {
    switch (n.k) {
      case 'num':
        return leaf(n.v);
      case 'pi':
        return leaf(Math.PI);
      case 'sym': {
        const v = values.get(n.name);
        if (v === undefined) throw new ExprError(`no value for ${n.name}`);
        return leaf(v);
      }
      case 'neg': {
        const a = ev(n.a);
        return { v: -a.v, e: a.e };
      }
      case 'bin': {
        const a = ev(n.a);
        const b = ev(n.b);
        let v: number;
        let e: number;
        switch (n.op) {
          case '+':
            v = a.v + b.v;
            e = a.e + b.e;
            break;
          case '-':
            v = a.v - b.v;
            e = a.e + b.e;
            break;
          case '*':
            v = a.v * b.v;
            e = Math.abs(a.v) * b.e + Math.abs(b.v) * a.e;
            break;
          case '/':
            v = b.v === 0 ? NaN : a.v / b.v;
            e = (a.e + Math.abs(v) * b.e) / Math.abs(b.v);
            break;
          case '^': {
            v = Math.pow(a.v, b.v);
            // d(a^b) = b·a^(b-1)·da + a^b·ln|a|·db
            const da = a.v === 0 ? 0 : Math.abs((b.v * v) / a.v) * a.e;
            const db = a.v > 0 ? Math.abs(v * Math.log(a.v)) * b.e : 0;
            e = da + db;
            break;
          }
        }
        return { v, e: e + Math.abs(v) * EPS };
      }
      case 'fn': {
        const xs = n.args.map(ev);
        const x = xs[0]!;
        if (n.name === 'root') {
          const k = xs[1]!.v;
          if (k === 0) return { v: NaN, e: 0 };
          const neg = x.v < 0;
          if (neg && !(Number.isInteger(k) && Math.abs(k) % 2 === 1)) return { v: NaN, e: 0 };
          const v = neg ? -Math.pow(-x.v, 1 / k) : Math.pow(x.v, 1 / k);
          const e = x.v === 0 ? 0 : Math.abs(v / (k * x.v)) * x.e;
          return { v, e: e + Math.abs(v) * EPS };
        }
        if (n.name === 'log' && xs.length === 2) {
          const b = xs[1]!;
          if (x.v <= 0 || b.v <= 0 || b.v === 1) return { v: NaN, e: 0 };
          const lb = Math.log(b.v);
          const v = Math.log(x.v) / lb;
          const e = x.e / Math.abs(x.v * lb) + Math.abs(v / (b.v * lb)) * b.e;
          return { v, e: e + Math.abs(v) * EPS };
        }
        const v = unary(n.name, x.v);
        let e = unaryDeriv(n.name, x.v, v) * x.e;
        // 导数在端点发散（sqrt(0)、asin(±1)）：误差是 √δ 量级，不是无穷
        if (!Number.isFinite(e) || Number.isNaN(e)) e = 2 * Math.sqrt(x.e);
        return { v, e: e + Math.abs(v) * EPS };
      }
    }
  };
  const r = ev(node);
  return { value: r.v, err: Number.isFinite(r.e) ? r.e : Infinity };
}

/** 结果落在舍入误差里（`sin(pi)` = 1.2e-16）就当 0。 */
export const ZERO_ERR_FACTOR = 64;

/** 数 → SymPy 会当成 Float 的写法（必须带小数点或指数：`2` → `2.0`、`1e-20`）。 */
export function floatLiteral(v: number): string {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** pi 写成长小数：SymPy 拿 Float 输入就按数值算（符号 pi 会留成 `0.1667*pi` 这种不求值的形式）。 */
const PI_LITERAL = '3.14159265358979323846264338';

/** py-compute 的 compute_symbolic 没有这些函数（解析时会变成未定义函数）。 */
const NOT_IN_PY_COMPUTE = new Set<ComputeFn>(['asin', 'acos', 'atan']);

/** compute_symbolic 的表达式长度上限（server.py 的 safe_parse）。 */
export const PY_COMPUTE_MAX_LENGTH = 500;

/**
 * 转成现有 py-compute（sympy_mcp 的 compute_symbolic）能解析的表达式，字母已代入数值：
 * 只用它符号表里有的名字（sqrt sin cos tan exp log factorial），数一律写成 Float，
 * 让 SymPy 自己按数值算 —— 和这里的双精度求值是两条独立的路（不同的引擎、不同的函数实现）。
 * 用到 py-compute 没有的函数（反三角）抛 ExprError，调用方标"未复算"。
 */
export function toPyCompute(node: ExprNode, values: ReadonlyMap<string, number>): string {
  const num = (v: number): string => (v < 0 ? `(-${floatLiteral(-v)})` : floatLiteral(v));
  const s = (n: ExprNode): string => {
    switch (n.k) {
      case 'num':
        return num(n.v);
      case 'pi':
        return PI_LITERAL;
      case 'sym': {
        const v = values.get(n.name);
        if (v === undefined) throw new ExprError(`no value for ${n.name}`);
        return num(v);
      }
      case 'neg':
        return `(-(${s(n.a)}))`;
      case 'bin':
        return `((${s(n.a)})${n.op === '^' ? '**' : n.op}(${s(n.b)}))`;
      case 'fn': {
        if (NOT_IN_PY_COMPUTE.has(n.name)) throw new ExprError(`py-compute has no ${n.name}`);
        const a = n.args.map(s);
        switch (n.name) {
          case 'root': {
            // 负数的奇次方根取实根（与 evalExpr 一致）；SymPy 的 ** 会给主值复根
            const x = evalExpr(n.args[0]!, values).value;
            const k = evalExpr(n.args[1]!, values).value;
            return x < 0 && Number.isInteger(k) && Math.abs(k) % 2 === 1
              ? `(-((-(${a[0]}))**(1.0/(${a[1]}))))`
              : `((${a[0]})**(1.0/(${a[1]})))`;
          }
          case 'ln':
            return `log(${a[0]})`;
          case 'log':
            return a.length === 2 ? `(log(${a[0]})/log(${a[1]}))` : `log(${a[0]})`;
          case 'log10':
            return `(log(${a[0]})/log(10.0))`;
          case 'abs':
            return `sqrt((${a[0]})**2)`;
          case 'sinh':
            return `((exp(${a[0]})-exp(-(${a[0]})))/2.0)`;
          case 'cosh':
            return `((exp(${a[0]})+exp(-(${a[0]})))/2.0)`;
          case 'tanh':
            return `((exp(${a[0]})-exp(-(${a[0]})))/(exp(${a[0]})+exp(-(${a[0]}))))`;
          default:
            return `${n.name}(${a[0]})`; // sqrt sin cos tan exp factorial
        }
      }
    }
  };
  const out = s(node);
  if (out.length > PY_COMPUTE_MAX_LENGTH) throw new ExprError('too long for py-compute');
  return out;
}

/** 给界面看的算式（字母不代入）：`sqrt(2*g*h)`。 */
export function exprText(node: ExprNode): string {
  const prec = (n: ExprNode): number =>
    n.k === 'bin' ? (n.op === '+' || n.op === '-' ? 1 : n.op === '^' ? 3 : 2) : n.k === 'neg' ? 1.5 : 4;
  const s = (n: ExprNode): string => {
    switch (n.k) {
      case 'num':
        return n.text;
      case 'pi':
        return 'pi';
      case 'sym':
        return n.name;
      case 'neg':
        return `-${prec(n.a) < 2 ? `(${s(n.a)})` : s(n.a)}`;
      case 'bin': {
        const p = prec(n);
        const left = prec(n.a) < p || (n.op === '^' && prec(n.a) <= p) ? `(${s(n.a)})` : s(n.a);
        const rightNeeds = n.op === '^' ? prec(n.b) < p : prec(n.b) < p || (prec(n.b) === p && (n.op === '-' || n.op === '/'));
        const right = rightNeeds ? `(${s(n.b)})` : s(n.b);
        return n.op === '+' || n.op === '-' ? `${left} ${n.op} ${right}` : `${left}${n.op}${right}`;
      }
      case 'fn':
        return `${n.name}(${n.args.map(s).join(', ')})`;
    }
  };
  return s(node);
}

// ============================================================
// 常数表（计算器的 CONST 键）：只有表里的 id 能用；数值以这里为准，不信模型给的数。
// CODATA 2018；g_n 是标准重力加速度（想用 9.81 就在草稿里写一行 `$g = 9.81$`）。
// ============================================================
export interface ComputeConstant {
  value: number;
  unit: string;
  zh: string;
  en: string;
}

export const COMPUTE_CONSTANTS: Readonly<Record<string, ComputeConstant>> = {
  c: { value: 299792458, unit: 'm/s', zh: '真空光速 c', en: 'speed of light c' },
  h_planck: { value: 6.62607015e-34, unit: 'J·s', zh: '普朗克常数 h', en: 'Planck constant h' },
  hbar: { value: 1.054571817e-34, unit: 'J·s', zh: '约化普朗克常数 ħ', en: 'reduced Planck constant ħ' },
  e_charge: { value: 1.602176634e-19, unit: 'C', zh: '元电荷 e', en: 'elementary charge e' },
  k_B: { value: 1.380649e-23, unit: 'J/K', zh: '玻尔兹曼常数 k_B', en: 'Boltzmann constant k_B' },
  N_A: { value: 6.02214076e23, unit: '1/mol', zh: '阿伏伽德罗常数 N_A', en: 'Avogadro constant N_A' },
  R: { value: 8.314462618, unit: 'J/(mol·K)', zh: '摩尔气体常数 R', en: 'gas constant R' },
  G: { value: 6.6743e-11, unit: 'm³/(kg·s²)', zh: '引力常数 G', en: 'gravitational constant G' },
  epsilon_0: { value: 8.8541878128e-12, unit: 'F/m', zh: '真空介电常数 ε₀', en: 'vacuum permittivity ε₀' },
  mu_0: { value: 1.25663706212e-6, unit: 'N/A²', zh: '真空磁导率 μ₀', en: 'vacuum permeability μ₀' },
  m_e: { value: 9.1093837015e-31, unit: 'kg', zh: '电子质量 m_e', en: 'electron mass m_e' },
  m_p: { value: 1.67262192369e-27, unit: 'kg', zh: '质子质量 m_p', en: 'proton mass m_p' },
  u: { value: 1.6605390666e-27, unit: 'kg', zh: '原子质量单位 u', en: 'atomic mass unit u' },
  g_n: { value: 9.80665, unit: 'm/s²', zh: '标准重力加速度 g', en: 'standard gravity g' },
  sigma_SB: { value: 5.670374419e-8, unit: 'W/(m²·K⁴)', zh: '斯特藩-玻尔兹曼常数 σ', en: 'Stefan–Boltzmann constant σ' },
};
