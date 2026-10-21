// ============================================================
// test/check10.mjs — MathLive 方言 → KaTeX 兼容层 + 未知命令的可读报错
//
// 真机 bug（2026-10-21）：从讲义复制出来的 `\differentialD` 是 MathLive 专有宏，
// KaTeX 不认；`throwOnError:false` 把它画成红字塞进 `\frac` 分母，结构塌掉且没有提示。
// 这里钉住：① 已知宏都有映射；② 未知命令能报出命令名/位置/建议；③ 不误伤正常命令。
// ============================================================
import assert from 'node:assert/strict';
import { renderMathToHtml } from '../lib/pdf-math.js';
import {
  MATHLIVE_MACROS,
  collectMathIssues,
  collectMathIssuesInText,
  collectMathLiveReplacements,
  hintForCommand,
  normalizeMathLive,
} from '../lib/mathlive-compat.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

t('normalizeMathLive：\\differentialD → \\mathrm{d}（讲义里的大写写法）', () => {
  const r = normalizeMathLive('v=\\dot{x}=\\frac{dx(t)}{\\differentialD t}');
  assert.equal(r.tex, 'v=\\dot{x}=\\frac{dx(t)}{\\mathrm{d} t}');
  assert.equal(r.replaced.length, 1);
  assert.equal(r.replaced[0].from, '\\differentialD');
});

t('normalizeMathLive：小写 \\differentiald 也按 d 处理，但带"非标准写法"提示', () => {
  const r = normalizeMathLive('\\frac{dx}{\\differentiald t}');
  assert.equal(r.tex, '\\frac{dx}{\\mathrm{d} t}');
  assert.match(r.replaced[0].note ?? '', /不是 MathLive 的宏/);
});

t('normalizeMathLive：\\exponentialE / \\imaginaryI / \\imaginaryJ 都有映射', () => {
  assert.equal(normalizeMathLive('e^{\\exponentialE t}').tex, 'e^{\\mathrm{e} t}');
  assert.equal(normalizeMathLive('\\imaginaryI^2').tex, '\\mathrm{i}^2');
  assert.equal(normalizeMathLive('\\imaginaryJ').tex, '\\mathrm{j}');
});

t('normalizeMathLive：\\placeholder{} → {}（两种写法都认）', () => {
  assert.equal(normalizeMathLive('\\sum_{\\placeholder{}}^{\\placeholder{}}').tex, '\\sum_{}^{}');
  assert.equal(normalizeMathLive('\\frac{\\placeholder}{x}').tex, '\\frac{}{x}');
});

t('normalizeMathLive：不误伤前缀相似的真实命令', () => {
  // \differentialDelta 不存在，但 \mathrm 等不能被吃掉；\differentialDx 不是宏
  assert.equal(normalizeMathLive('\\mathrm{d}x').tex, '\\mathrm{d}x');
  assert.equal(normalizeMathLive('\\differentialDx').tex, '\\differentialDx');
  assert.equal(normalizeMathLive('a+b').tex, 'a+b');
});

t('映射表本身覆盖报告里点名的全部宏', () => {
  const froms = MATHLIVE_MACROS.map((m) => m.from);
  for (const m of ['\\differentialD', '\\differentiald', '\\exponentialE', '\\imaginaryI', '\\imaginaryJ', '\\placeholder{}', '\\placeholder']) {
    assert.ok(froms.includes(m), `缺少映射：${m}`);
  }
});

t('collectMathIssues：未知命令给出命令名 + 位置 + 建议', () => {
  const issues = collectMathIssues('v=\\frac{dx}{\\foo t}');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].command, '\\foo');
  assert.ok(issues[0].position > 0, '应当报出位置');
  assert.match(issues[0].hint, /KaTeX 没有这个命令/);
});

t('collectMathIssues：归一化之后正常 → 没有 issue（\differentialD 不再报错）', () => {
  const tex = normalizeMathLive('\\frac{dx(t)}{\\differentialD t}').tex;
  assert.deepEqual(collectMathIssues(tex), []);
});

t('collectMathIssues：一次能抓出多个未知命令', () => {
  const issues = collectMathIssues('\\foo + \\baz');
  assert.deepEqual(
    issues.map((i) => i.command).sort(),
    ['\\baz', '\\foo'],
  );
});

t('hintForCommand：已知 MathLive 宏给出具体写法', () => {
  assert.match(hintForCommand('\\differentialD'), /\\mathrm\{d\}/);
  assert.match(hintForCommand('\\exponentialE'), /\\mathrm\{e\}/);
  assert.match(hintForCommand('\\placeholder'), /通用写法是 \{\}/);
});

t('collectMathIssuesInText：只扫真正会渲染的公式段', () => {
  const issues = collectMathIssuesInText('文字 $\\foo$ 与 $\\baz$');
  assert.deepEqual(issues.map((i) => i.command).sort(), ['\\baz', '\\foo']);
  // 不在公式里的 `\foo`（英文句子）不该报
  assert.deepEqual(collectMathIssuesInText('the \\foo command'), []);
  // 归一化之后能渲染的讲义宏也不该报
  assert.deepEqual(collectMathIssuesInText('$\\differentialD x$'), []);
});

t('collectMathLiveReplacements：报出用了哪些讲义宏', () => {
  const reps = collectMathLiveReplacements('$\\differentialD x$ 和 $\\exponentialE^t$');
  assert.deepEqual(reps.map((r) => r.from).sort(), ['\\differentialD', '\\exponentialE']);
});

t('PDF 渲染器同样走兼容层（屏幕与打印一致）', () => {
  const html = renderMathToHtml('v=\\frac{dx(t)}{\\differentialD t}', false);
  assert.match(html, /katex/);
  assert.ok(!html.includes('differentialD'), 'PDF 里不能出现 differentialD 原文');
  const lower = renderMathToHtml('\\frac{dx}{\\differentiald t}', false);
  assert.ok(!lower.includes('differentiald'));
});

t('PDF 渲染器对未知命令不抛异常（红字 + 可读源码兜底）', () => {
  const html = renderMathToHtml('\\foo x', false);
  assert.ok(html.length > 0);
  assert.match(html, /katex|math-fallback/);
});

t('normalizeMathLive 不改变正常公式（幂等）', () => {
  const src = 'a^2+b^2=c^2';
  assert.equal(normalizeMathLive(src).tex, src);
  assert.deepEqual(normalizeMathLive(src).replaced, []);
});

console.log(`\n[exercise-mathlive-compat] ${passed} 项断言通过`);
