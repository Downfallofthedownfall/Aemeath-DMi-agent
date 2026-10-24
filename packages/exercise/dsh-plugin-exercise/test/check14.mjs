// ============================================================
// test/check14.mjs — 打印侧"整行裸 LaTeX"宽容（PDF 里别印源码）
//
// 用户 2026-10-24："回答里写的 LaTeX 公式在提交 pdf 会变成字符串"。
// 屏幕端按定案只认 `$`，但打印是交付物：整行就是 LaTeX 的行要在纸上排版出来。
// 判据必须窄 —— 散文 / Windows 路径 / 金额 / 代码围栏 一律不动。
// ============================================================
import assert from 'node:assert/strict';
import { looksLikeBareLatex, wrapBareLatexLines } from '../lib/print-normalize.js';
import { buildSubmissionHtml } from '../lib/pdf-html.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

t('整行 LaTeX 认出来（含 \\frac / 下标 / 希腊字母）', () => {
  assert.equal(looksLikeBareLatex('F = m \\frac{dv}{dt}'), true);
  assert.equal(looksLikeBareLatex('\\sum_{i=1}^{n} \\frac{1}{i}'), true);
  assert.equal(looksLikeBareLatex('v_0 = \\omega r + \\alpha'), true);
});

t('散文 / 路径 / 金额 / 代码 / 已带分隔符 → 不认', () => {
  assert.equal(looksLikeBareLatex('用 \\sum 求和时要注意上下限'), false, '中文句子');
  assert.equal(looksLikeBareLatex('the \\sum of these values'), false, '英文句子');
  assert.equal(looksLikeBareLatex('C:\\Users\\xinka'), false, 'Windows 路径');
  assert.equal(looksLikeBareLatex('$5 and $6'), false, '金额');
  assert.equal(looksLikeBareLatex('$a = g\\sin\\alpha$'), false, '已经带 $');
  assert.equal(looksLikeBareLatex('\\(x\\)'), false);
  assert.equal(looksLikeBareLatex('见 `\\frac{a}{b}` 这个写法'), false, '反引号');
  assert.equal(looksLikeBareLatex('\\Users'), false, '命令不在白名单');
  assert.equal(looksLikeBareLatex(''), false);
});

t('wrapBareLatexLines：只包整行 LaTeX，其余原样', () => {
  const src = ['答案：', '', 'F = m \\frac{dv}{dt}', '', '$E = mc^2$', '', '用 \\sum 求和'].join('\n');
  const out = wrapBareLatexLines(src);
  assert.ok(out.includes('$$F = m \\frac{dv}{dt}$$'), '裸行被包成块级公式');
  assert.ok(out.includes('$E = mc^2$'), '已有 $ 的行不动');
  assert.ok(out.includes('用 \\sum 求和'), '中文句子不动');
});

t('wrapBareLatexLines：代码围栏里不动', () => {
  const src = ['```', 'F = m \\frac{dv}{dt}', '```'].join('\n');
  assert.equal(wrapBareLatexLines(src), src);
});

t('提交 HTML：裸 LaTeX 行渲染成公式，不再印源码', () => {
  const html = buildSubmissionHtml({
    courseTitle: 'Physik I',
    courseId: 'physik-1',
    sheet: { id: 'ub01', number: 1, title: '', issued: '', due: '' },
    problems: [
      {
        label: 'Aufgabe 1',
        title: '',
        text: 'Test',
        points: 4,
        answer: '牛顿第二定律：\n\nF = m \\frac{dv}{dt}\n\n$E = mc^2$',
      },
    ],
    renderMath: (tex, display) => `<span class="katex" data-tex="${tex}" data-display="${display}"></span>`,
  });
  assert.ok(html.includes('data-tex="F = m \\frac{dv}{dt}"'), '裸行应按公式渲染');
  assert.ok(!html.includes('$$F'), '不该残留 $$');
  assert.ok(html.includes('data-display="true"'), '块级公式用 display 模式');
  assert.ok(html.includes('data-tex="E = mc^2"'), '带 $ 的行照常渲染');
});

t('有序列表保留原始序号（3) → start="3"）', () => {
  const html = buildSubmissionHtml({
    courseTitle: 'Physik I',
    courseId: 'physik-1',
    sheet: { id: 'ub01', number: 1, title: '', issued: '', due: '' },
    problems: [{ label: 'A1', title: '', text: 'x', points: null, answer: '3) dritter Punkt\n4) vierter Punkt' }],
  });
  assert.match(html, /<ol start="3">/);
});

t('wrapBareLatexLines：**已在 $$ 块里的行不再二次包裹**（真机踩过）', () => {
  const src = ['$$', '\\frac{dx}{dt} = v_0 + a t', '$$', '', 'F = m \\frac{dv}{dt}'].join('\n');
  const out = wrapBareLatexLines(src);
  // 块内的 \frac 行不能被包，块外那行要包
  assert.ok(out.includes('$$\n\\frac{dx}{dt} = v_0 + a t\n$$'), '块内保持原样');
  assert.ok(out.includes('$$F = m \\frac{dv}{dt}$$'), '块外的裸行要包');
  assert.equal((out.match(/\$\$/g) ?? []).length, 4, '$$ 数量必须成对且不嵌套');
});

t('wrapBareLatexLines：\\[ … \\] 与 \\begin{env} 块里也不包裹', () => {
  const bracket = ['\\[', 'x = y + 1', '\\]'].join('\n');
  assert.equal(wrapBareLatexLines(bracket), bracket);
  const env = ['\\begin{aligned}', 'x &= v_0 t', '\\end{aligned}'].join('\n');
  assert.equal(wrapBareLatexLines(env), env);
});

console.log(`\n[exercise-print-normalize] ${passed} 项断言通过`);
