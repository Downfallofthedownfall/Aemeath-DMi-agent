// ============================================================
// test/check21.mjs — 「一键计算」：计算器，不解题（2026-11-27）
//
//   1. 待算式只认学生自己写的结尾 `=`；等号前只有一个字母不算
//   2. 算式解析 / 求值 / 格式化（有舍入写 \approx）
//   3. 防做题护栏：转写里多出的量、多出的数、编造出处的数值都拒绝；常数以常数表为准
//   4. 复算：与 py-compute 一致才算"已复算"，不一致不填；没有 Python 照填并标出
//   5. 回填：答案在计算途中被改过，按上下文重新定位；找不到就跳过
//   6. 真 py-compute（有 Python + sympy 时）：与双精度结果一致
//   7. 真 HTTP 桥：POST action=compute（模型用假 fetch 顶替）
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { evalExpr, exprText, parseExpr, toPyCompute, COMPUTE_CONSTANTS } from '../lib/compute-expr.js';
import {
  applyComputeFills,
  findComputeTargets,
  formatComputed,
  latexNumbers,
  normalizeQuote,
  quoteInText,
  symbolInLatex,
} from '../lib/compute-fill.js';
import { assignedInText, evaluateTranscription, runCompute, sameNumber } from '../lib/compute.js';
import { createPyVerify, findPyComputeServer, pythonCandidates } from '../lib/py-compute.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../..');

// ───────────── 1. 待算式 ─────────────
await t('待算式：结尾 = / = ? / \\approx 才算；算的是最后一个等号前那一段', async () => {
  const draft = [
    '已知 $g = 9.81$，$h = 1{,}5\\,\\mathrm{m}$',
    '$v = \\sqrt{2 g h} =$',
    '$\\sin(30^\\circ) = ?$ 和 $x \\approx 2 \\cdot 3 \\approx$',
    '$a := 3 =$',
  ].join('\n');
  const ts = findComputeTargets(draft);
  assert.deepEqual(
    ts.map((x) => [x.latex, x.marker, x.skip ?? '']),
    [
      ['\\sqrt{2 g h}', '=', ''],
      ['\\sin(30^\\circ)', '= ?', ''],
      ['2 \\cdot 3', '\\approx', ''],
      ['a := 3', '=', ''], // `:=` 不算关系符：整段交给模型，它会判 unsupported
    ],
  );
  // 位置精确：标记就在答案里那个地方
  for (const x of ts) assert.equal(draft.slice(x.markerStart, x.markerEnd), x.marker);
});

await t('待算式：等号前只有一个字母 → 不算（式子要学生自己写）；没有结尾 = → 一个都没有', async () => {
  const ts = findComputeTargets('$F =$ 和 $v_0 =$ 和 $\\alpha_{1} = ?$ 和 $2 =$');
  assert.deepEqual(ts.map((x) => x.skip ?? ''), ['bare_symbol', 'bare_symbol', 'bare_symbol', '']);
  assert.equal(findComputeTargets('$v = \\sqrt{2gh}$，答案写完了').length, 0);
  assert.equal(findComputeTargets('没有公式 = 只有文字 =').length, 0);
});

await t('待算式：aligned 的续行 `&=` 算上一行；代码围栏里的不算；$$ 与 \\[ \\] 都认', async () => {
  const draft = [
    '$$\\begin{aligned} E &= \\frac12 m v^2 \\\\ &= \\end{aligned}$$',
    '```',
    '$x = 1 + 1 =$',
    '```',
    '\\[ p = m v = \\]',
  ].join('\n');
  const ts = findComputeTargets(draft);
  assert.deepEqual(ts.map((x) => x.latex), ['\\frac12 m v^2', 'm v']);
});

// ───────────── 2. 算式 ─────────────
await t('算式：优先级、隐式乘法、一元负号、阶乘、奇次实根、对数底', async () => {
  const ev = (s, vals = {}) => evalExpr(parseExpr(s), new Map(Object.entries(vals))).value;
  assert.equal(ev('-2^2'), -4);
  assert.equal(ev('2^-1'), 0.5);
  assert.equal(ev('2^3^2'), 512);
  assert.equal(ev('2pi'), 2 * Math.PI);
  assert.equal(ev('3!'), 6);
  assert.equal(ev('root(-8, 3)'), -2);
  assert.ok(Math.abs(ev('log(8, 2)') - 3) < 1e-12);
  assert.ok(Math.abs(ev('1/2*m*v^2', { m: 2, v: 3 }) - 9) < 1e-12);
  assert.ok(Number.isNaN(ev('sqrt(-1)')));
  assert.ok(Number.isNaN(ev('1/0')));
  assert.equal(exprText(parseExpr('sqrt(2*g*h)')), 'sqrt(2*g*h)');
  assert.throws(() => parseExpr('x = 3'));
  assert.throws(() => parseExpr('sin 3'));
  assert.throws(() => parseExpr('__import__(1)'));
  assert.throws(() => evalExpr(parseExpr('2*q'), new Map()), /no value for q/);
});

await t('格式化：默认 4 位有效数字；有舍入 → \\approx；精确 → =；大小数用 \\times 10^{n}', async () => {
  assert.deepEqual(formatComputed(5.424942396), { latex: '5.425', plain: '5.425', exact: false });
  assert.deepEqual(formatComputed(0.5), { latex: '0.5', plain: '0.5', exact: true });
  assert.equal(formatComputed(29.999999999999996).latex, '30');
  assert.equal(formatComputed(29.999999999999996).exact, true);
  assert.equal(formatComputed(12345.6).latex, '12346');
  assert.equal(formatComputed(1.602176634e-19).latex, '1.602 \\times 10^{-19}');
  assert.equal(formatComputed(1e-7).latex, '10^{-7}');
  assert.equal(formatComputed(5.424942396, 6).latex, '5.42494');
  // 舍入进位到下一个量级：toPrecision 会给 "1.000e+4"，那不是 LaTeX
  assert.deepEqual(formatComputed(9999.96), { latex: '10000', plain: '10000', exact: false });
  assert.equal(formatComputed(-9999.96).latex, '-10000');
  assert.equal(formatComputed(99.97, 2).latex, '100');
  assert.equal(formatComputed(9.97, 1).latex, '10');
  assert.equal(formatComputed(0.0099996).latex, '0.01');
});

// ───────────── 3. 护栏 ─────────────
const target = (draft) => findComputeTargets(draft).find((x) => !x.skip);
const base = (over = {}) => ({ id: 't1', status: 'ok', expr: '', values: [], missing: [], reason: '', note: '', ...over });
const val = (symbol, value, quote, source = 'draft', constant = '') => ({ symbol, value, unit: '', source, quote, constant });

await t('护栏：转写里出现式子里没有的量 → 拒绝（模型不许代别的公式）', async () => {
  const draft = '$v = \\sqrt{2 g h} =$';
  const r = evaluateTranscription(target(draft), base({ expr: 'sqrt(2*g*h)*cos(theta)' }), { draft, problemText: '' });
  assert.equal(r.item.status, 'rejected');
  assert.match(r.item.reason, /theta/);
});

await t('护栏：转写里多出式子里没有的数（算好的中间值）→ 拒绝；pi/180 换算允许', async () => {
  const draft = '$g = 9.81$ $h = 1.5$\n$v = \\sqrt{2 g h} =$';
  const r = evaluateTranscription(target(draft), base({ expr: 'sqrt(29.43)' }), { draft, problemText: '' });
  assert.equal(r.item.status, 'rejected');
  assert.match(r.item.reason, /29\.43/);
  const d2 = '$\\sin(30^\\circ) =$';
  const r2 = evaluateTranscription(target(d2), base({ expr: 'sin(30*pi/180)' }), { draft: d2, problemText: '' });
  assert.equal(r2.item.status, 'ok');
  assert.ok(Math.abs(r2.item.value - 0.5) < 1e-12);
});

await t('护栏：数值的原文片段必须真在草稿/题目里、且含那个数；编造的 → 缺数值', async () => {
  const draft = '$g = 9.81$\n$v = \\sqrt{2 g h} =$';
  const problem = 'Ein Stein fällt aus $h = 1{,}5\\,\\mathrm{m}$ Höhe.';
  const ok = evaluateTranscription(
    target(draft),
    base({ expr: 'sqrt(2*g*h)', values: [val('g', 9.81, 'g = 9.81'), val('h', 1.5, 'h = 1{,}5\\,\\mathrm{m}', 'problem')] }),
    { draft, problemText: problem },
  );
  assert.equal(ok.item.status, 'ok');
  assert.ok(Math.abs(ok.item.value - Math.sqrt(2 * 9.81 * 1.5)) < 1e-12);
  assert.deepEqual(ok.item.values.map((v) => v.source), ['draft', 'problem']);

  const fake = evaluateTranscription(
    target(draft),
    base({ expr: 'sqrt(2*g*h)', values: [val('g', 9.81, 'g = 9.81'), val('h', 2, 'h = 2 m', 'problem')] }),
    { draft, problemText: problem },
  );
  assert.equal(fake.item.status, 'missing');
  assert.deepEqual(fake.item.missing, ['h']);
  // 片段在原文里，但数不在片段里（模型换算过/编的）
  const wrongNumber = evaluateTranscription(
    target(draft),
    base({ expr: 'sqrt(2*g*h)', values: [val('g', 9.81, 'g = 9.81'), val('h', 3.7, 'h = 1{,}5\\,\\mathrm{m}', 'problem')] }),
    { draft, problemText: problem },
  );
  assert.equal(wrongNumber.item.status, 'missing');
});

await t('护栏：常数只认常数表的 id，数值以表为准（不信模型给的数）', async () => {
  const draft = '$E = \\hbar \\omega =$ 其中 $\\omega = 2$';
  const r = evaluateTranscription(
    target(draft),
    base({ expr: 'hbar*omega', values: [val('hbar', 1, '', 'constant', 'hbar'), val('omega', 2, '\\omega = 2')] }),
    { draft, problemText: '' },
  );
  assert.equal(r.item.status, 'ok');
  assert.equal(r.item.value, COMPUTE_CONSTANTS.hbar.value * 2);
  const bad = evaluateTranscription(
    target(draft),
    base({ expr: 'hbar*omega', values: [val('hbar', 1, '', 'constant', 'my_hbar'), val('omega', 2, '\\omega = 2')] }),
    { draft, problemText: '' },
  );
  assert.equal(bad.item.status, 'missing');
});

await t('护栏辅助：字母底名匹配（希腊字母、var 前缀、Δt 合写）与数字串', async () => {
  assert.ok(symbolInLatex('alpha', '\\sin\\alpha'));
  assert.ok(symbolInLatex('epsilon_0', '\\varepsilon_0 E'));
  assert.ok(symbolInLatex('Delta_t', 'v \\Delta t'));
  assert.ok(symbolInLatex('v_0', 'v_{0} t'));
  assert.ok(!symbolInLatex('theta', '\\sqrt{2gh}'));
  assert.ok(!symbolInLatex('m', 'F_{\\mathrm{m}}')); // 单位/文字里的字母不算量
  assert.deepEqual(latexNumbers('9{,}81 \\cdot 1,5 + \\frac12 + 1\\,000'), [9.81, 1.5, 1, 2, 1000]);
  assert.deepEqual(latexNumbers('q = -1{,}6 \\cdot 10^{-19}'), [-1.6, 10, -19, -1.6e-19]);
  assert.deepEqual(latexNumbers('U_1 - 5 \\approx -3'), [1, 5, -3]);
  assert.ok(latexNumbers('m = 1.000\\,\\mathrm{kg}').includes(1000)); // 德式千分位两种读法都算
});

await t('护栏：数按数值比 —— 子串（120 里的 12）、小数点挪位（1{,}5 → 15）、片段从数中间切出来，都不算', async () => {
  const draft = '$F = 120\\,\\mathrm{N}$ $m = 0{,}25$\n$a = \\frac{F}{m} =$';
  const tg = target(draft);
  const run = (vals) => evaluateTranscription(tg, base({ expr: 'F/m', values: vals }), { draft, problemText: '' }).item;
  const good = run([val('F', 120, 'F = 120'), val('m', 0.25, 'm = 0{,}25')]);
  assert.equal(good.status, 'ok');
  assert.equal(good.value, 480);
  // 早先这些都通过了护栏（数字串子串匹配 / 去掉小数点）
  for (const vals of [
    [val('F', 12, 'F = 120'), val('m', 0.25, 'm = 0{,}25')],
    [val('F', 20, 'F = 120'), val('m', 0.25, 'm = 0{,}25')],
    [val('F', 120, 'F = 120'), val('m', 25, 'm = 0{,}25')],
    [val('F', 120, 'F = 120'), val('m', 2, 'm = 0{,}25')],
    [val('F', 120, 'F = 120'), val('m', 0.25, '25')], // 片段 "25" 是从 0{,}25 中间切出来的
    [val('F', 2, '2'), val('m', 0.25, 'm = 0{,}25')],
  ]) {
    const r = run(vals);
    assert.equal(r.status, 'missing', JSON.stringify(vals));
  }
  // 小数点挪位：题目写 1{,}5，模型抄成 15
  const d2 = '$g = 9.81$\n$v = \\sqrt{2 g h} =$';
  const problem = 'aus $h = 1{,}5\\,\\mathrm{m}$ Höhe';
  const shifted = evaluateTranscription(
    target(d2),
    base({ expr: 'sqrt(2*g*h)', values: [val('g', 9.81, 'g = 9.81'), val('h', 15, 'h = 1{,}5\\,\\mathrm{m}', 'problem')] }),
    { draft: d2, problemText: problem },
  );
  assert.equal(shifted.item.status, 'missing');
  // 算式字面量同理：式子写 9{,}81，转写成 98.1 / 0.981 → 多出来的数
  const d3 = '$v = \\sqrt{2 \\cdot 9{,}81 \\cdot h} =$ $h = 2$';
  for (const expr of ['sqrt(2*98.1*h)', 'sqrt(2*0.981*h)', 'sqrt(20*9.81*h)']) {
    const r = evaluateTranscription(target(d3), base({ expr, values: [val('h', 2, 'h = 2')] }), { draft: d3, problemText: '' });
    assert.equal(r.item.status, 'rejected', expr);
  }
  const fine = evaluateTranscription(target(d3), base({ expr: 'sqrt(2*9.81*h)', values: [val('h', 2, 'h = 2')] }), { draft: d3, problemText: '' });
  assert.equal(fine.item.status, 'ok');
  // 负号也要对
  const d4 = '$U = -230$ $q = 2$\n$W = q U =$';
  const sign = (v) => evaluateTranscription(target(d4), base({ expr: 'q*U', values: [val('q', 2, 'q = 2'), val('U', v, 'U = -230')] }), { draft: d4, problemText: '' }).item;
  assert.equal(sign(-230).status, 'ok');
  assert.equal(sign(230).status, 'missing');
  // 片段边界
  assert.ok(quoteInText(normalizeQuote('m = 0{,}25'), normalizeQuote('$m = 0{,}25$, v = 3')));
  assert.ok(!quoteInText(normalizeQuote('m = 0{,}2'), normalizeQuote('$m = 0{,}25$')));
  assert.ok(!quoteInText('5', normalizeQuote('$m = 25$')));
});

await t('护栏：草稿/题目自己给了数值的量，不许用常数表顶替', async () => {
  const draft = '$g = 9{,}81\\,\\mathrm{m/s^2}$ $h = 2$\n$v = \\sqrt{2 g h} =$';
  const r = evaluateTranscription(
    target(draft),
    base({ expr: 'sqrt(2*g*h)', values: [val('g', 9.80665, '', 'constant', 'g_n'), val('h', 2, 'h = 2')] }),
    { draft, problemText: '' },
  );
  assert.equal(r.item.status, 'missing');
  assert.deepEqual(r.item.missing, ['g']);
  assert.match(r.item.reason, /常数表|constant table/);
  // 没给数值 → 常数表照用
  const d2 = '$h = 2$\n$v = \\sqrt{2 g h} =$';
  const ok = evaluateTranscription(
    target(d2),
    base({ expr: 'sqrt(2*g*h)', values: [val('g', 9.80665, '', 'constant', 'g_n'), val('h', 2, 'h = 2')] }),
    { draft: d2, problemText: '' },
  );
  assert.equal(ok.item.status, 'ok');
  assert.ok(assignedInText('epsilon_0', '$\\varepsilon_{0} = 8{,}85 \\cdot 10^{-12}$'));
  assert.ok(assignedInText('c', 'Lichtgeschwindigkeit c = 3 \\cdot 10^8 m/s'));
  assert.ok(!assignedInText('c', '$E = m c^2 =$'));
  assert.ok(!assignedInText('hbar', '$E = \\hbar \\omega =$ 其中 $\\omega = 2$'));
  assert.ok(!assignedInText('g', '$g_0 = 3$'));
});

// ───────────── 4. 整条流水线（假模型 + 假复算）─────────────
const fakeLlm = (payload, seen = []) => async (prompt, opts) => {
  seen.push({ prompt, opts });
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
};
const draft1 = '$g = 9.81$ $h = 1.5$\n$v = \\sqrt{2 g h} =$\n$F =$';
const transcription1 = {
  targets: [{ id: 't1', status: 'ok', expr: 'sqrt(2*g*h)', values: [val('g', 9.81, 'g = 9.81'), val('h', 1.5, 'h = 1.5')], missing: [] }],
};

await t('流水线：模型只转写（推理关、prompt 禁止出结果）；一致 → 已复算并给出回填', async () => {
  const seen = [];
  const verify = async (jobs) => ({ ok: true, results: new Map(jobs.map((j) => [j.id, { re: Math.sqrt(2 * 9.81 * 1.5), im: 0 }])) });
  const r = await runCompute({ draft: draft1, problemText: '', lang: 'zh' }, fakeLlm(transcription1, seen), verify);
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.noReasoning, true);
  assert.match(seen[0].prompt, /不要输出任何计算结果/);
  assert.match(seen[0].prompt, /t1: `\\sqrt\{2 g h\}`/);
  assert.doesNotMatch(seen[0].prompt, /- t2:/); // 只有一个字母的那处不发给模型
  const [a, b] = r.items;
  assert.equal(a.status, 'ok');
  assert.equal(a.verify, 'sympy');
  assert.equal(a.display, '\\approx 5.425');
  assert.equal(b.status, 'skipped');
  const filled = applyComputeFills(draft1, [a.fill]);
  assert.equal(filled.text, '$g = 9.81$ $h = 1.5$\n$v = \\sqrt{2 g h} \\approx 5.425$\n$F =$');
});

await t('流水线：与 py-compute 不一致 → 不填、标出两个数；py-compute 不可用 → 照填、标"未复算"', async () => {
  const wrong = async (jobs) => ({ ok: true, results: new Map(jobs.map((j) => [j.id, { re: 5.5, im: 0 }])) });
  const r = await runCompute({ draft: draft1, problemText: '', lang: 'zh' }, fakeLlm(transcription1), wrong);
  assert.equal(r.items[0].status, 'mismatch');
  assert.equal(r.items[0].fill, undefined);
  assert.match(r.items[0].reason, /5\.5/);
  const down = async () => ({ ok: false, error: 'Python not found' });
  const r2 = await runCompute({ draft: draft1, problemText: '', lang: 'zh' }, fakeLlm(transcription1), down);
  assert.equal(r2.items[0].status, 'ok');
  assert.equal(r2.items[0].verify, 'unavailable');
  assert.ok(r2.items[0].fill);
  assert.equal(r2.verifier.kind, 'none');
  assert.equal(r2.verifier.note, 'Python not found');
});

await t('流水线：没有结尾 = → 报错且不调模型；只有一个字母 → 不调模型；sin(pi) 这种相消按 0', async () => {
  const seen = [];
  const none = await runCompute({ draft: '$v = \\sqrt{2gh}$', problemText: '', lang: 'zh' }, fakeLlm({}, seen));
  assert.equal(none.ok, false);
  const bare = await runCompute({ draft: '$F =$', problemText: '', lang: 'zh' }, fakeLlm({}, seen));
  assert.equal(bare.ok, true);
  assert.equal(bare.items[0].status, 'skipped');
  assert.equal(seen.length, 0);
  const r = await runCompute(
    { draft: '$\\sin(\\pi) =$', problemText: '', lang: 'zh' },
    fakeLlm({ targets: [{ id: 't1', status: 'ok', expr: 'sin(pi)', values: [] }] }),
  );
  assert.equal(r.items[0].value, 0);
  assert.equal(r.items[0].display, '= 0');
  // 误差估计：sin(pi) 的 1.2e-16 落在误差里（与 SymPy 的 3.9e-25 算一致）……
  const sinPi = evalExpr(parseExpr('sin(pi)'), new Map());
  assert.ok(sameNumber(sinPi.value, 3.9e-25, sinPi.err));
  // ……但真正很小的结果不会被放宽：q·(U1−U2) = 3.2e-19，复算给 6.4e-19 必须算不一致
  const small = evalExpr(parseExpr('q*(U_1 - U_2)'), new Map([['q', 1.602176634e-19], ['U_1', 232], ['U_2', 230]]));
  assert.ok(Math.abs(small.value - 3.204353268e-19) < 1e-30);
  assert.ok(!sameNumber(small.value, 6.4e-19, small.err));
  assert.ok(sameNumber(small.value, 3.204353268e-19, small.err));
  // sqrt(0) 处导数发散：误差有限，后面再加 5 也不会被当成 0
  const edge = evalExpr(parseExpr('sqrt(x - x) + 5'), new Map([['x', 2]]));
  assert.ok(Number.isFinite(edge.err) && edge.err < 1e-6);
});

// ───────────── 5. 回填 ─────────────
await t('回填：答案在计算途中被改了前面 → 按上下文重新定位；上下文没了 → 跳过，不填错地方', async () => {
  const d = '$v = \\sqrt{2 g h} =$\n$s = v t =$';
  const ts = findComputeTargets(d);
  const fills = ts.map((x, i) => ({ ...x, replacement: i ? '= 12' : '\\approx 5.425' }));
  const edited = `前面加了一行\n${d}`;
  const r = applyComputeFills(edited, fills);
  assert.deepEqual(r.applied, ['t1', 't2']);
  assert.equal(r.text, '前面加了一行\n$v = \\sqrt{2 g h} \\approx 5.425$\n$s = v t = 12$');
  const gone = applyComputeFills('$v = \\sqrt{2 g h}$ 已经改掉了\n$s = v t =$', fills);
  assert.deepEqual(gone.applied, ['t2']);
  assert.deepEqual(gone.skipped, ['t1']);
});

// ───────────── 6. 真 py-compute ─────────────
const server = findPyComputeServer({ searchRoots: [repoRoot] });
await t('py-compute：仓库里能找到 sympy_mcp/server.py', async () => {
  assert.ok(server && server.endsWith('server.py'), String(server));
});

const verify = createPyVerify({ python: process.env.EXERCISE_PYTHON ?? '', searchRoots: [repoRoot] });
const cases = [
  ['sqrt(2*g*h)', { g: 9.81, h: 1.5 }],
  ['sin(30*pi/180)', {}],
  ['root(-8, 3)', {}],
  ['log10(1000) + log(8, 2) + ln(exp(2))', {}],
  ['sinh(1.5) - cosh(0.5) + tanh(0.3)', {}],
  ['abs(-3.5) * 5! / 10^2', {}],
  ['q*U', { q: 1.602176634e-19, U: -230 }],
];
const jobs = cases.map(([s, v], i) => {
  const node = parseExpr(s);
  const vals = new Map(Object.entries(v));
  return { id: `t${i + 1}`, code: toPyCompute(node, vals), js: evalExpr(node, vals) };
});
const real = await verify(jobs);
if (!real.ok) {
  console.log(`  - 跳过真 py-compute（${real.error}）`);
} else {
  await t('py-compute：compute_symbolic 复算与双精度结果一致（奇次实根、换底、双曲函数、阶乘、负数）', async () => {
    for (const j of jobs) {
      const got = real.results.get(j.id);
      assert.ok(got && !('error' in got), `${j.id}: ${JSON.stringify(got)} ← ${j.code}`);
      assert.ok(sameNumber(j.js.value, got.re, j.js.err), `${j.id}: ${j.js.value} vs ${got.re}`);
    }
  });
}
await t('py-compute：没有的函数（反三角）不送，抛错由调用方标"未复算"', async () => {
  assert.throws(() => toPyCompute(parseExpr('asin(0.5)'), new Map()), /asin/);
});

await t('py-compute（macOS）：找 Homebrew / python.org 的 python3；没装命令行工具时绝不碰 /usr/bin/python3', async () => {
  const mac = (files, pathEnv = '/usr/bin:/bin:/usr/sbin:/sbin') =>
    pythonCandidates({ platform: 'darwin', pathEnv, home: '/Users/s', exists: (p) => files.includes(p) }).map((c) => c.cmd);
  // 从 Finder 启动：PATH 很短、只有占位程序 → 一个都不试（不会弹"安装开发者工具"）
  assert.deepEqual(mac(['/usr/bin/python3']), []);
  // 装了命令行工具：占位程序就是真 Python，排最后
  assert.deepEqual(mac(['/usr/bin/python3', '/Library/Developer/CommandLineTools/usr/bin/python3']), ['/usr/bin/python3']);
  // Homebrew（Apple 芯片 / Intel）、python.org 安装包、pyenv 都能找到，且排在 /usr/bin 前面
  assert.deepEqual(
    mac([
      '/usr/bin/python3',
      '/Library/Developer/CommandLineTools/usr/bin/python3',
      '/opt/homebrew/bin/python3',
      '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
      '/Users/s/.pyenv/shims/python3',
    ]),
    [
      '/opt/homebrew/bin/python3',
      '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
      '/Users/s/.pyenv/shims/python3',
      '/usr/bin/python3',
    ],
  );
  // PATH 里的（例如 conda）优先
  assert.deepEqual(mac(['/opt/conda/bin/python3', '/usr/local/bin/python3'], '/opt/conda/bin:/usr/bin'), [
    '/opt/conda/bin/python3',
    '/usr/local/bin/python3',
  ]);
  // 显式配置只用它；Windows / Linux 按命令名找
  assert.deepEqual(pythonCandidates({ explicit: 'py -3.12', platform: 'darwin', exists: () => false }), [{ cmd: 'py', args: ['-3.12'] }]);
  assert.deepEqual(pythonCandidates({ platform: 'win32', exists: () => false }).map((c) => c.cmd), ['python', 'python3', 'py']);
  assert.deepEqual(pythonCandidates({ platform: 'linux', exists: () => false }).map((c) => c.cmd), ['python3', 'python']);
});

await t('py-compute：解释器没装 sympy / 起不来 → 复算不可用（不抛异常，计算照常）', async () => {
  // "能跑但没有 sympy"：-I -S 不加载 site-packages，LOADER 第一步就退出
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const r = await createPyVerify({ python: `${py} -I -S`, searchRoots: [repoRoot] })([{ id: 't1', code: '2.0*3.0' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /No module named 'sympy'|ENOENT/);
  // Windows 上配成 .cmd：Node 同步抛 EINVAL —— 早先直接变成未处理的异常
  const cmd = createPyVerify({ python: join(tmpdir(), 'no-such-python.cmd'), searchRoots: [repoRoot] });
  const r2 = await cmd([{ id: 't1', code: '2.0*3.0' }]);
  assert.equal(r2.ok, false);
});

// ───────────── 7. 真 HTTP 桥 ─────────────
await t('HTTP：POST action=compute 用前端传来的草稿算，结果不落盘', async () => {
  const root = mkdtempSync(join(tmpdir(), 'exercise-test21-'));
  delete process.env.EXERCISE_DATA_DIR;
  const routes = new Map();
  const tools = new Map();
  const services = { webServer: { register: (r) => (routes.set(r.path, r.handler), () => {}) }, connection: { requestRejection: () => undefined } };
  const realFetch = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    prompts.push(body);
    const content = JSON.stringify(transcription1);
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200 });
  };
  try {
    await apply(
      {
        on: () => () => {},
        effect: () => {},
        tools: { register: (def) => (tools.set(def.name, def), () => tools.delete(def.name)) },
        credentials: { resolve: async () => ({ value: '' }) },
        reflect: { get: (n) => services[n] },
      },
      { dataDir: join(root, 'data'), llm: { apiKey: 'test-key' }, pyComputeServer: server ?? '' },
    );
    const call = (name, args) => tools.get(name).execute(args, { agent: { session: { id: 's1' } } });
    const post = (body) =>
      new Promise((done) => {
        const req = Readable.from([Buffer.from(JSON.stringify(body))]);
        req.method = 'POST';
        req.url = '/aemeath/api/exercise';
        req.headers = {};
        const res = {
          status: 0,
          body: '',
          writeHead(code) {
            this.status = code;
            return this;
          },
          setHeader() {},
          write(c) {
            this.body += c;
            return true;
          },
          end(c) {
            if (c !== undefined) this.body += c;
            done({ status: this.status, data: JSON.parse(this.body || '{}') });
            return this;
          },
        };
        routes.get('/aemeath/api/exercise')(req, res);
      });
    const created = await call('exercise_new_sheet', { course_id: 'physik-1', title: 'Mechanik' });
    const S = created.data.sheet_id;
    const added = await post({ action: 'add_problem', course_id: 'physik-1', sheet_id: S, text: 'Freier Fall' });
    const P = added.data.sheet.problems[0].id;
    // 草稿开头有空白：位置必须按原样算（http 层不许 trim）
    const draft = `  \n${draft1}`;
    const r = await post({ action: 'compute', course_id: 'physik-1', sheet_id: S, problem_id: P, draft });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.items[0].status, 'ok');
    assert.equal(prompts[0].thinking?.type, 'disabled');
    const filled = applyComputeFills(draft, [r.data.items[0].fill]);
    assert.match(filled.text, /\$v = \\sqrt\{2 g h\} \\approx 5\.425\$/);
    assert.deepEqual(filled.skipped, []);
    // 不落盘：存的答案没变
    const stored = await call('exercise_problem', { course_id: 'physik-1', sheet_id: S, problem_id: P });
    assert.ok(!JSON.stringify(stored).includes('5.425'), JSON.stringify(stored));
    const none = await post({ action: 'compute', course_id: 'physik-1', sheet_id: S, problem_id: P, draft: '没有等号' });
    assert.equal(none.status, 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n[exercise-compute] ${passed} 项断言通过`);
