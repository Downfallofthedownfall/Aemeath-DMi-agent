// ============================================================
// compute.ts — 「一键计算」：学生写好式子、在末尾写 `=`，点一下把数填上（**计算器，不解题**）
//
// 用户 2026-11-27："加一个一键填充 compute，用来在用户写好式子之后计算最终结果，
//   可行的话用现有的 py-compute 验证，注意不要让模型做题，只是代替计算器"。
//
// 流水线（模型只做"按计算器的键"这一步）：
//   ① 找待算式（compute-fill.ts，确定性）：只有学生自己写了结尾 `=` 的公式才算；
//      等号前只有一个字母（`v =`）→ 不算，式子必须学生自己写。
//   ② 模型**转写**：LaTeX → 算式（`sqrt(2*g*h)`）+ 每个字母的数值与出处（原文片段）。
//      prompt 禁止改写/化简/解方程/补公式/输出结果；推理关掉（这是结构化抄写）。
//   ③ 确定性护栏（不信模型）：转写里的字母必须在式子里出现、数字必须在式子里出现；
//      数值的原文片段必须真在草稿/题目里、且包含那个数；常数只认常数表的 id（值以表为准）。
//      任何一条不过 → 这一处不算，告诉学生为什么。
//   ④ 计算：compute-expr.ts 的双精度求值（模型不出数）。
//   ⑤ 复算：py-compute（sympy_mcp 的 compute_symbolic：safe_parse 子进程 + SymPy/mpmath）。
//      一致 → 填；不一致 → 不填并标红；没有 Python → 照填，标"未经 SymPy 复算"。
// 结果是临时的：不写 sheet.json，只是把数填进答案（之后照常自动保存）。
// ============================================================

import { parseJsonLoose, type AskLlm } from './checker.js';
import {
  COMPUTE_CONSTANTS,
  ExprError,
  evalExpr,
  exprNumbers,
  exprSymbols,
  exprText,
  exprUsesPi,
  parseExpr,
  ZERO_ERR_FACTOR,
  toPyCompute,
} from './compute-expr.js';
import {
  fillReplacement,
  findComputeTargets,
  formatComputed,
  fullPrecision,
  latexNumbers,
  normalizeQuote,
  numberIn,
  quoteInText,
  symbolBase,
  symbolInLatex,
  type ComputeFill,
  type ComputeTarget,
} from './compute-fill.js';
import { tr } from './locale.js';
import type { StatementSource } from './parts.js';

/** 数值出处：草稿 / 本题（本小题）题干 / 大题共用题干 / 前面小题的题干 / 前面小题的解答 / 常数表 */
export type ComputeSource = 'draft' | 'problem' | 'stem' | 'part' | 'answer' | 'constant';

export interface ComputeValue {
  symbol: string;
  value: number;
  unit: string;
  source: ComputeSource;
  /** 前面哪个小题（source 是 part / answer 时） */
  part?: string;
  /** 原文片段（常数：常数表里的说明） */
  quote: string;
}

export type ComputeStatus = 'ok' | 'mismatch' | 'missing' | 'unsupported' | 'rejected' | 'error' | 'skipped';

export interface ComputeItem {
  id: string;
  latex: string;
  line: string;
  status: ComputeStatus;
  /** 模型转写的算式（字母未代入） */
  expr?: string;
  values: ComputeValue[];
  missing: string[];
  /** 不能算/没算的原因（给人看的话） */
  reason?: string;
  /** 模型的说明（例如"\\log 按 ln 算"） */
  note?: string;
  value?: number;
  /** 填进去的 LaTeX（`\approx 5.425`） */
  display?: string;
  /** 12 位有效数字（结果框里显示） */
  full?: string;
  verify: 'sympy' | 'mismatch' | 'unavailable' | 'skipped';
  verifyNote?: string;
  fill?: ComputeFill;
}

export interface ComputeResult {
  ok: boolean;
  error?: string;
  items: ComputeItem[];
  verifier: { kind: 'sympy' | 'none'; note?: string };
  digits: number;
}

/** py-compute 复算：每个 job 一个 compute_symbolic 表达式（数已代入），回传数值。 */
export type PyVerify = (
  jobs: ReadonlyArray<{ id: string; code: string }>,
) => Promise<{ ok: true; results: Map<string, { re: number; im: number } | { error: string }> } | { ok: false; error: string }>;

export interface ComputeInput {
  draft: string;
  /** 只有一段题干时的简写（= sources 里一条 problem） */
  problemText?: string;
  /** 能引用的原文，按优先级（见 parts.ts 的 statementSourcesFor）；给了就不看 problemText */
  sources?: readonly StatementSource[];
  lang: 'zh' | 'en';
  /** 填入的有效数字（默认 4） */
  digits?: number;
}

/** 每段原文给模型看的上限（字符）；前面的小题越早越先被截掉 */
const SOURCE_LIMITS: Record<StatementSource['kind'], number> = { problem: 6000, stem: 4000, part: 2000, answer: 3000 };
const SOURCES_BUDGET = 16_000;

/** 统一成按优先级排好的原文列表（空的去掉；超出总预算时丢掉最早的小题）。 */
export function sourcesOf(input: { problemText?: string; sources?: readonly StatementSource[] }): StatementSource[] {
  const list = (input.sources ?? [{ kind: 'problem' as const, text: input.problemText ?? '' }])
    .map((s) => ({ ...s, text: s.text.trim().slice(0, SOURCE_LIMITS[s.kind] ?? 2000) }))
    .filter((s) => s.text);
  const out: StatementSource[] = [];
  let used = 0;
  for (const s of list) {
    if (used + s.text.length > SOURCES_BUDGET && (s.kind === 'part' || s.kind === 'answer')) break;
    out.push(s);
    used += s.text.length;
  }
  return out;
}

/** 给人看/给模型看的出处名。 */
function sourceHeading(s: StatementSource, zh: boolean, standalone: boolean): string {
  switch (s.kind) {
    case 'problem':
      return standalone ? (zh ? '题目' : 'Problem') : zh ? `本小题 ${s.part ?? ''}) 的题干` : `This sub-part ${s.part ?? ''}): text`;
    case 'stem':
      return zh ? '大题共用题干' : 'Shared stem of the whole problem';
    case 'part':
      return zh ? `前面的小题 ${s.part}) 的题干` : `Earlier sub-part ${s.part}): text`;
    case 'answer':
      return zh ? `前面的小题 ${s.part}) —— 学生自己的解答` : `Earlier sub-part ${s.part}): the student's own answer`;
  }
}

interface RawTranscription {
  id: string;
  status: string;
  expr: string;
  values: Array<{ symbol: string; value: number; unit: string; source: string; quote: string; constant: string }>;
  missing: string[];
  reason: string;
  note: string;
}

// ============================================================
// prompt
// ============================================================

export function buildComputePrompt(input: {
  draft: string;
  problemText?: string;
  sources?: readonly StatementSource[];
  targets: readonly ComputeTarget[];
  lang: 'zh' | 'en';
}): string {
  const zh = input.lang === 'zh';
  const constants = Object.entries(COMPUTE_CONSTANTS)
    .map(([id, c]) => `- ${id}: ${zh ? c.zh : c.en} = ${c.value} ${c.unit}`)
    .join('\n');
  const targets = input.targets.map((t) => `- ${t.id}: \`${t.latex}\`  (${zh ? '所在行' : 'line'}: \`${t.line}\`)`).join('\n');
  const sources = sourcesOf(input);
  const standalone = !sources.some((s) => s.kind !== 'problem');
  const sourceBlocks = sources.length
    ? sources.flatMap((s) => [`## ${sourceHeading(s, zh, standalone)}`, '<<<', s.text, '>>>', ''])
    : [zh ? '## 题目' : '## Problem', zh ? '（没有题干）' : '(no problem text)', ''];
  const draft = input.draft.slice(0, 10000);
  const sourceRuleZh = standalone
    ? '3. 字母的数值只能来自：(a) 学生草稿里明确写出的赋值（优先）；(b) 题目里明确给出的数据；(c) 下面常数表（只能用表里的 id）。'
    : '3. 字母的数值只能来自（按优先级）：(a) 学生草稿里明确写出的赋值；(b) 本小题的题干；(c) 大题共用题干；' +
      '(d) 前面的小题 —— 题干里给的数据，以及学生在前面小题的解答里**已经写出来的数值结果**（越近的小题越优先）；(e) 下面常数表（只能用表里的 id）。' +
      '同一个字母在几处都有数值时取优先级最高的那处。';
  const sourceRuleEn = standalone
    ? "3. A letter's value may only come from: (a) an assignment written explicitly in the student's draft (preferred); (b) data given explicitly in the problem; (c) the constant table below (ids from the table only)."
    : "3. A letter's value may only come from (in this order): (a) an assignment written explicitly in the student's draft; (b) this sub-part's text; (c) the shared stem; " +
      "(d) earlier sub-parts - data in their text, and numeric results the student **already wrote** in their answers there (nearer sub-parts first); (e) the constant table below (ids from the table only). " +
      'If a letter has values in several places, take the highest-priority one.';
  const sourceEnum = standalone ? 'draft / problem / constant' : 'draft / problem / stem / part / answer / constant';
  const example =
    '{"targets":[{"id":"t1","status":"ok","expr":"sqrt(2*g*h)","values":[' +
    '{"symbol":"g","value":9.81,"unit":"m/s^2","source":"draft","quote":"g = 9.81\\\\,\\\\mathrm{m/s^2}","constant":""},' +
    '{"symbol":"h","value":1.5,"unit":"m","source":"problem","quote":"h = 1{,}5\\\\,\\\\mathrm{m}","constant":""}],' +
    '"missing":[],"reason":"","note":""}]}';

  if (zh) {
    return [
      '你是一个**计算器的输入转写器**，不是解题助手。学生已经自己把式子写好了，并在要算的地方写了结尾的 `=`。',
      '你只做一件事：把每个「待算式」**原样**转写成下面语法的算式，并说明每个字母取什么数值、这个数写在哪里。数由计算器算，不由你算。',
      '',
      '## 硬性规则',
      '1. 只转写待算式本身：不改写、不化简、不展开、不代入别的公式、不解方程、不补步骤。待算式里有哪些量，算式里就只有这些量。',
      '2. 不要输出任何计算结果，也不要心算任何中间值；算式里只能出现待算式里本来就有的数字。',
      sourceRuleZh,
      '   都没有 → 写进 missing。**不许估计，不许用别的公式推出来**（中间量要学生自己先算出来写进草稿；' +
        '前面小题里只写了公式、没写出数值的量也算没有）。',
      '4. 数值照原文的数字和单位取：不换算单位、不换算前缀（200 g 就是 200，unit 写 g）。',
      '5. 三角函数的参数是角度（写了 ° 或题目给的是度）→ 在算式里写成 `x*pi/180`。',
      '6. 待算式里有积分、导数、极限、求和、向量/矩阵、不等式，或者还有未知数要解 → status 写 "unsupported"，reason 说一句为什么。',
      '',
      '## 算式语法',
      '- 数字、`+ - * / ^`、括号；乘号一律写 `*`',
      '- 函数：sqrt(x)、root(x, n)、sin cos tan asin acos atan sinh cosh tanh（弧度）、exp(x)、ln(x)、log(x, b)、log10(x)、abs(x)、factorial(n)',
      '- 常数 pi；欧拉数写 exp(1)，不要写 e',
      '- 字母命名 `底_下标`：\\alpha → alpha，v_0 → v_0，F_{\\text{N}} → F_N，\\Delta t → Delta_t，\\varepsilon_0 → epsilon_0',
      '- `\\frac{a}{b}` → (a)/(b)，`\\sqrt[3]{x}` → root(x, 3)，`10^{-3}` → 10^(-3)，`a \\cdot b`、`a \\times b`、`ab` → a*b',
      '- `\\lg` → log10，`\\ln` → ln，`\\log_b` → log(x, b)；不带底的 `\\log` 当 ln，并在 note 里说一句',
      '',
      '## 常数表（id: 说明 = 值）',
      constants,
      '',
      ...sourceBlocks,
      standalone ? '## 学生草稿（完整）' : '## 学生草稿（本小题，完整）',
      '<<<',
      draft,
      '>>>',
      '',
      '## 待算式',
      targets,
      '',
      '## 输出',
      '只输出一个 JSON 对象，不要别的文字。示例：',
      example,
      '- status：ok（每个字母都有数值）/ missing（有字母找不到数值，名字列进 missing）/ unsupported',
      `- values：算式里每个字母一条。source 写 ${sourceEnum}；quote 是数值所在位置的**原文片段**（从上面那段原文里逐字复制，包含那个数）；`,
      '  常数：source 写 "constant"，constant 写表里的 id，quote 留空',
      '- 纯数字的待算式 values 留空数组',
    ].join('\n');
  }
  return [
    'You are the **input transcriber of a calculator**, not a tutor. The student has written the formulas themselves and put a trailing `=` where they want a number.',
    'Your only job: transcribe each "target" **exactly as written** into the expression syntax below, and say which value each letter takes and where that number is written. The calculator computes the number, not you.',
    '',
    '## Hard rules',
    '1. Transcribe the target itself only: no rewriting, simplifying, expanding, substituting other formulas, solving equations or adding steps. The expression contains exactly the quantities of the target.',
    '2. Never output a result and never compute an intermediate value; the expression may only contain numbers that appear in the target.',
    sourceRuleEn,
    '   None of these → put it in missing. **Never estimate and never derive it from another formula** (the student must compute intermediate quantities and write them into the draft; ' +
      'a quantity an earlier sub-part only gives as a formula, without a number, counts as missing).',
    '4. Take numbers and units exactly as written: no unit or prefix conversion (200 g stays 200, unit "g").',
    '5. A trig argument in degrees (written with ° or given in degrees) → write `x*pi/180` in the expression.',
    '6. Integrals, derivatives, limits, sums, vectors/matrices, inequalities, or unknowns still to be solved for → status "unsupported" with a one-line reason.',
    '',
    '## Expression syntax',
    '- numbers, `+ - * / ^`, parentheses; always write `*` for multiplication',
    '- functions: sqrt(x), root(x, n), sin cos tan asin acos atan sinh cosh tanh (radians), exp(x), ln(x), log(x, b), log10(x), abs(x), factorial(n)',
    '- constant pi; Euler\'s number is exp(1), never e',
    '- letters as `base_sub`: \\alpha → alpha, v_0 → v_0, F_{\\text{N}} → F_N, \\Delta t → Delta_t, \\varepsilon_0 → epsilon_0',
    '- `\\frac{a}{b}` → (a)/(b), `\\sqrt[3]{x}` → root(x, 3), `10^{-3}` → 10^(-3), `a \\cdot b`, `a \\times b`, `ab` → a*b',
    '- `\\lg` → log10, `\\ln` → ln, `\\log_b` → log(x, b); a bare `\\log` is ln, and say so in note',
    '',
    '## Constant table (id: meaning = value)',
    constants,
    '',
    ...sourceBlocks,
    standalone ? '## Student draft (complete)' : '## Student draft (this sub-part, complete)',
    '<<<',
    draft,
    '>>>',
    '',
    '## Targets',
    targets,
    '',
    '## Output',
    'Output a single JSON object and nothing else. Example:',
    example,
    '- status: ok (every letter has a value) / missing (some letter has no value; list it in missing) / unsupported',
    `- values: one entry per letter. source is ${sourceEnum}; quote is the **verbatim snippet** of that text where the number is written (it must contain the number);`,
    '  constants: source "constant", constant = the table id, quote empty',
    '- a purely numeric target has an empty values array',
  ].join('\n');
}

// ============================================================
// 解析模型输出
// ============================================================

export function parseComputeOutput(raw: string | null): RawTranscription[] | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const obj = parseJsonLoose(text.slice(start, end + 1)) as { targets?: unknown } | null;
  if (!obj || !Array.isArray(obj.targets)) return null;
  const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');
  return obj.targets
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      id: str(t.id, 16),
      status: str(t.status, 20),
      expr: str(t.expr, 600),
      values: (Array.isArray(t.values) ? t.values : [])
        .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
        .slice(0, 24)
        .map((v) => ({
          symbol: str(v.symbol, 40),
          value: typeof v.value === 'number' ? v.value : Number(str(v.value, 60)),
          unit: str(v.unit, 40),
          source: str(v.source, 20),
          quote: str(v.quote, 300),
          constant: str(v.constant, 40),
        })),
      missing: (Array.isArray(t.missing) ? t.missing : []).map((m) => str(m, 40)).filter(Boolean).slice(0, 12),
      reason: str(t.reason, 400),
      note: str(t.note, 400),
    }));
}

// ============================================================
// 护栏 + 计算
// ============================================================

/**
 * 原文里有没有给这个量赋数值（`g = 9{,}81`、`v_{0} = -3`、`\varepsilon_0 \approx 8.85`）。
 * 算式里的名字是 `底_下标`（`v_0`、`epsilon_0`）；底名多于一个字母的按 LaTeX 命令找（`\varepsilon`）。
 */
export function assignedInText(sym: string, text: string): boolean {
  if (!text) return false;
  // 不用 normalizeQuote：它连空白一起删，"Lichtgeschwindigkeit c = 3" 会粘成 "keitc=3"，认不出 c
  const norm = text
    .replace(/\{,\}/g, ',')
    .replace(/\\[,;:! ]|\\q?quad|~/g, ' ')
    .replace(/[{}$]/g, '');
  const base = symbolBase(sym);
  const sub = sym.includes('_') ? sym.slice(sym.indexOf('_') + 1) : '';
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = base.length === 1 ? `(?<![A-Za-z\\\\])${esc(base)}` : `\\\\(?:var)?${esc(base)}(?![A-Za-z])`;
  const tail = sub ? `\\s*_\\s*${esc(sub)}(?![A-Za-z0-9])` : '(?!\\s*_)';
  return new RegExp(`${head}${tail}\\s*(?:=|\\\\approx)\\s*[-−+]?\\s*\\.?\\d`).test(norm);
}

const RANGE_ERROR = (): string =>
  tr('超出实数范围（负数开平方、对数里 ≤ 0、除以 0 或溢出）', 'Outside the real numbers (root of a negative, log of ≤ 0, division by 0 or overflow)');

/** 一处待算式：校验转写 → 代入 → 求值。返回的 code 交给 py-compute 复算。 */
export function evaluateTranscription(
  target: ComputeTarget,
  r: RawTranscription | undefined,
  ctx: { draft: string; problemText?: string; sources?: readonly StatementSource[] },
): { item: ComputeItem; code?: string; err?: number; noVerify?: string } {
  const item: ComputeItem = {
    id: target.id,
    latex: target.latex,
    line: target.line,
    status: 'error',
    values: [],
    missing: [],
    verify: 'skipped',
  };
  if (!r) {
    item.reason = tr('模型没有转写这一处', 'The model did not transcribe this one');
    return { item };
  }
  if (r.note) item.note = r.note;
  if (r.status === 'unsupported') {
    item.status = 'unsupported';
    item.reason = r.reason || tr('这不是能直接按计算器的式子', 'This is not something a calculator can evaluate directly');
    return { item };
  }

  let node;
  try {
    node = parseExpr(r.expr);
  } catch (e) {
    item.reason = tr(`转写的算式解析不了：${(e as ExprError).message}`, `Could not parse the transcription: ${(e as ExprError).message}`);
    if (r.expr) item.expr = r.expr;
    return { item };
  }
  item.expr = exprText(node);

  // ---- 护栏 1：量必须是式子里的量（不许模型自己代别的公式进来）----
  const symbols = exprSymbols(node);
  const foreign = symbols.filter((s) => !symbolInLatex(s, target.latex));
  if (foreign.length) {
    item.status = 'rejected';
    item.reason = tr(
      `转写里出现了式子里没有的量：${foreign.join('、')} —— 只算你写出来的式子`,
      `The transcription uses quantities that are not in your formula: ${foreign.join(', ')} - only what you wrote gets computed`,
    );
    return { item };
  }
  // ---- 护栏 2：数必须是式子里的数（不许模型把算好的中间值塞进来）----
  // 按数值比（`9{,}81` 与 9.81 相同，但 0.981 / 98.1 / 120 里的 12 都不算）；字面量不带符号，只比大小
  const written = latexNumbers(target.latex);
  const allowed = [1];
  if (exprUsesPi(node)) allowed.push(180);
  if (/\\%|%/.test(target.latex)) allowed.push(100);
  const strayNumbers = exprNumbers(node).filter((n) => !numberIn(Number(n), allowed, false) && !numberIn(Number(n), written, false));
  if (strayNumbers.length) {
    item.status = 'rejected';
    item.reason = tr(
      `转写里多出了式子里没有的数：${strayNumbers.join('、')} —— 只算你写出来的式子`,
      `The transcription contains numbers that are not in your formula: ${strayNumbers.join(', ')} - only what you wrote gets computed`,
    );
    return { item };
  }

  // ---- 护栏 3：每个字母的数值必须有原文出处（常数以常数表为准）----
  // 出处按优先级：草稿 → 本题/本小题 → 大题题干 → 前面的小题（近的先，题干先于解答）。
  // 片段在哪一处**先**找到就记哪一处 —— 不信模型自己报的 source。
  const sources = sourcesOf(ctx);
  const texts: Array<{ source: Exclude<ComputeSource, 'constant'>; part?: string; raw: string; norm: string }> = [
    { source: 'draft', raw: ctx.draft, norm: normalizeQuote(ctx.draft) },
    ...sources.map((s) => ({ source: s.kind, ...(s.kind === 'part' || s.kind === 'answer' ? { part: s.part } : {}), raw: s.text, norm: normalizeQuote(s.text) })),
  ];
  const hasEarlier = sources.some((s) => s.kind === 'part' || s.kind === 'answer');
  const values = new Map<string, number>();
  const missing: string[] = [];
  const bad: string[] = [];
  /** 草稿/题目里有数值、模型却拿了常数表的 */
  const overridden: string[] = [];
  /** 草稿/本小题给了另一个数、模型却拿了大题题干或前面小题的 */
  const shadowed: string[] = [];
  for (const sym of symbols) {
    const v = r.values.find((x) => x.symbol === sym);
    if (!v || r.missing.includes(sym)) {
      missing.push(sym);
      continue;
    }
    if (v.source === 'constant') {
      // 写了 id 就必须是表里的 id；没写才按字母名找（`hbar`）
      const id = v.constant || v.symbol;
      const c = Object.prototype.hasOwnProperty.call(COMPUTE_CONSTANTS, id) ? COMPUTE_CONSTANTS[id] : undefined;
      if (!c) {
        missing.push(sym);
        bad.push(sym);
        continue;
      }
      // 学生（或题目、前面的小题）自己给了这个量的数值（`g = 9.81`）：计算器按写出来的数算，不许常数表顶替
      if (texts.some((t) => assignedInText(sym, t.raw))) {
        missing.push(sym);
        overridden.push(sym);
        continue;
      }
      values.set(sym, c.value);
      item.values.push({ symbol: sym, value: c.value, unit: c.unit, source: 'constant', quote: tr(c.zh, c.en) });
      continue;
    }
    // 片段要真在原文里（且不是从某个数的中间切出来的），数值要和片段里写的某个数**相等**（含符号）
    const q = normalizeQuote(v.quote);
    const found = texts.find((t) => quoteInText(q, t.norm));
    if (!Number.isFinite(v.value) || !found || !numberIn(v.value, latexNumbers(v.quote))) {
      missing.push(sym);
      bad.push(sym);
      continue;
    }
    // 草稿和本小题题干说了算：它们给了这个字母**另一个**数，转写却拿了更靠后的出处（大题题干、前面的小题）→ 不算。
    // 大题题干与前面小题之间不强求（"b) 起改成 m = 3 kg" 这种写法合理），出处会在结果框里标出来。
    const foundAt = texts.indexOf(found);
    const shadow = texts
      .slice(0, foundAt)
      .find((t) => (t.source === 'draft' || t.source === 'problem') && assignedInText(sym, t.raw) && !numberIn(v.value, latexNumbers(t.raw)));
    if (shadow) {
      missing.push(sym);
      shadowed.push(sym);
      continue;
    }
    values.set(sym, v.value);
    item.values.push({
      symbol: sym,
      value: v.value,
      unit: v.unit,
      source: found.source,
      ...(found.part ? { part: found.part } : {}),
      quote: v.quote.trim(),
    });
  }
  if (missing.length) {
    item.status = 'missing';
    item.missing = missing;
    item.reason = shadowed.length
      ? tr(
          `${shadowed.join('、')} 在你的草稿或本小题题干里另有数值，但转写用了大题题干/前面小题里的 —— 没有算，再点一次「计算」`,
          `${shadowed.join(', ')} has a different value in your draft or this sub-part's text, but the transcription took it from the stem or an earlier sub-part - nothing was computed; press "Compute" again`,
        )
      : overridden.length
      ? tr(
          `${overridden.join('、')} 你在草稿或题目（含前面的小题）里给了数值，但转写用了常数表的值 —— 没有算，再点一次「计算」`,
          `You gave a value for ${overridden.join(', ')} in the draft or problem (or an earlier sub-part), but the transcription used the constant table instead - nothing was computed; press "Compute" again`,
        )
      : bad.length
      ? tr(
          `${bad.join('、')} 的数值在${hasEarlier ? '草稿、题目和前面的小题' : '草稿和题目'}里都没找到原文：在草稿里写一行赋值（例如 $${bad[0]} = …$）再算`,
          `No source found for ${bad.join(', ')} in the draft${hasEarlier ? ', the problem or earlier sub-parts' : ' or problem'}: add an assignment to the draft (e.g. $${bad[0]} = …$) and compute again`,
        )
      : tr(
          `还缺数值：${missing.join('、')} —— 在草稿里写一行赋值（例如 $${missing[0]} = …$）再算`,
          `Missing values: ${missing.join(', ')} - add an assignment to the draft (e.g. $${missing[0]} = …$) and compute again`,
        );
    return { item };
  }

  // ---- 计算（双精度）----
  let res;
  try {
    res = evalExpr(node, values);
  } catch (e) {
    item.reason = (e as Error).message;
    return { item };
  }
  if (!Number.isFinite(res.value)) {
    item.reason = RANGE_ERROR();
    return { item };
  }
  let value = res.value;
  if (value !== 0 && Number.isFinite(res.err) && Math.abs(value) <= ZERO_ERR_FACTOR * res.err) value = 0; // sin(pi)：落在舍入误差里
  item.value = value;
  item.status = 'ok';
  try {
    return { item, code: toPyCompute(node, values), err: res.err };
  } catch (e) {
    // 反三角之类 py-compute 没有的函数：照算，标"未复算"
    return { item, err: res.err, noVerify: (e as Error).message };
  }
}

/** 两个结果一致吗：相对 1e-9；结果接近 0 时按双精度误差估计（evalExpr 的 err）给绝对容差。 */
export function sameNumber(a: number, b: number, err: number): boolean {
  const diff = Math.abs(a - b);
  return diff <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)) || (Number.isFinite(err) && diff <= ZERO_ERR_FACTOR * err);
}

export async function runCompute(input: ComputeInput, askLlm: AskLlm, verify?: PyVerify): Promise<ComputeResult> {
  const digits = Math.min(12, Math.max(1, Math.round(input.digits ?? 4)));
  const targets = findComputeTargets(input.draft);
  const base: ComputeResult = { ok: true, items: [], verifier: { kind: 'none' }, digits };
  if (!targets.length) {
    return {
      ...base,
      ok: false,
      error: tr(
        '没找到要算的地方：在式子末尾写一个 =（例如 $v = \\sqrt{2gh} =$），再点「计算」',
        'Nothing to compute: end a formula with = (e.g. $v = \\sqrt{2gh} =$) and press "Compute"',
      ),
    };
  }

  const items = new Map<string, ComputeItem>();
  for (const t of targets) {
    if (!t.skip) continue;
    items.set(t.id, {
      id: t.id,
      latex: t.latex,
      line: t.line,
      status: 'skipped',
      values: [],
      missing: [],
      verify: 'skipped',
      reason:
        t.skip === 'bare_symbol'
          ? tr('等号前只有一个字母：先把式子写出来，计算器只算你写好的式子', 'Only a single letter before the "=": write the formula first - the calculator only evaluates what you wrote')
          : tr('等号前面没有式子', 'There is no formula before the "="'),
    });
  }
  const live = targets.filter((t) => !t.skip);
  const order = (): ComputeItem[] => targets.map((t) => items.get(t.id)!).filter(Boolean);
  if (!live.length) return { ...base, items: order() };

  const prompt = buildComputePrompt({ draft: input.draft, problemText: input.problemText, sources: input.sources, targets: live, lang: input.lang });
  const raw = await askLlm(prompt, {
    maxTokens: 6000,
    purpose: 'exercise-compute',
    noReasoning: true,
    reasoning: 'off',
    timeoutMs: 60_000,
  });
  const parsed = parseComputeOutput(raw);
  if (!parsed) {
    return {
      ...base,
      ok: false,
      error: raw ? tr('模型没返回可解析的转写', 'The model returned an unparseable transcription') : tr('LLM 不可用或超时', 'LLM unavailable or timed out'),
      items: order(),
    };
  }

  const jobs: Array<{ id: string; code: string; err: number }> = [];
  for (const t of live) {
    const r = parsed.find((x) => x.id === t.id);
    const { item, code, err, noVerify } = evaluateTranscription(t, r, { draft: input.draft, problemText: input.problemText, sources: input.sources });
    items.set(t.id, item);
    if (item.status === 'ok' && code) jobs.push({ id: t.id, code, err: err ?? 0 });
    else if (item.status === 'ok') {
      item.verify = 'unavailable';
      item.verifyNote = noVerify;
    }
  }

  // ---- py-compute 复算 ----
  let verifier: ComputeResult['verifier'] = { kind: 'none', note: tr('没有配置 py-compute', 'py-compute is not configured') };
  if (jobs.length && verify) {
    const v = await verify(jobs).catch((e: Error) => ({ ok: false as const, error: e.message }));
    if (v.ok) {
      verifier = { kind: 'sympy' };
      for (const job of jobs) {
        const item = items.get(job.id)!;
        const got = v.results.get(job.id);
        if (!got || 'error' in got || !Number.isFinite(got.re)) {
          item.verify = 'unavailable';
          item.verifyNote = got && 'error' in got ? got.error : tr('SymPy 没给出数值', 'SymPy returned no number');
          continue;
        }
        const imagTiny = Math.abs(got.im) <= 1e-9 * Math.max(1, Math.abs(got.re));
        if (imagTiny && sameNumber(item.value!, got.re, job.err)) {
          item.verify = 'sympy';
          item.value = Number.isFinite(job.err) && Math.abs(got.re) <= ZERO_ERR_FACTOR * job.err ? 0 : got.re; // SymPy 的值位数更多
        } else {
          item.status = 'mismatch';
          item.verify = 'mismatch';
          item.verifyNote = imagTiny ? fullPrecision(got.re) : `${fullPrecision(got.re)} + ${fullPrecision(got.im)}i`;
          item.reason = tr(
            `计算器与 SymPy 结果不一致（${fullPrecision(item.value!)} vs ${item.verifyNote}），没有填入`,
            `Calculator and SymPy disagree (${fullPrecision(item.value!)} vs ${item.verifyNote}); nothing was filled in`,
          );
        }
      }
    } else {
      verifier = { kind: 'none', note: v.error };
      for (const job of jobs) {
        const item = items.get(job.id)!;
        item.verify = 'unavailable';
        item.verifyNote = v.error;
      }
    }
  } else if (jobs.length) {
    for (const job of jobs) items.get(job.id)!.verify = 'unavailable';
  }

  // ---- 结果 → 回填 ----
  for (const t of live) {
    const item = items.get(t.id)!;
    if (item.status !== 'ok' || item.value === undefined) continue;
    const f = formatComputed(item.value, digits);
    const replacement = fillReplacement(t.marker, f);
    item.display = replacement;
    item.full = fullPrecision(item.value);
    item.fill = {
      id: t.id,
      markerStart: t.markerStart,
      markerEnd: t.markerEnd,
      marker: t.marker,
      anchor: t.anchor,
      replacement,
    };
  }
  return { ...base, items: order(), verifier };
}
