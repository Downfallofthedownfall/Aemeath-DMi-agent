// ============================================================
// test/check9.mjs — markdown + LaTeX 切分（多行 $$ / \[ \] / 环境 / 行内 / 代码围栏）
//
// 真机反馈：「现在渲染的地方还是没有 latex 渲染出来」。
// 根因是按行切块 → 多行 `$$…$$` 被拆成两半，两半都不成对 → 整段当纯文本。
// 这里覆盖的正是这类"写作格式"边界，保证以后不会退化。
// ============================================================
import assert from 'node:assert/strict';
import {
  buildRenderBlocks,
  hasMath,
  parseInlineTokens,
  splitDisplayMath,
  splitInlineMath,
  splitMathSegments,
  normalizeMathDelimiters,
  isBareLatexLine,
} from '../lib/math-parse.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const kinds = (segs) => segs.map((s) => (s.kind === 'math' ? (s.display ? 'D' : 'I') : 'T')).join('');
const mathTex = (segs) => segs.filter((s) => s.kind === 'math').map((s) => s.tex);

t('单行 $$x$$ → 块级公式', () => {
  const segs = splitDisplayMath('前 $$a^2+b^2=c^2$$ 后');
  assert.equal(kinds(segs), 'TDT');
  assert.deepEqual(mathTex(segs), ['a^2+b^2=c^2']);
});

t('多行 $$ … $$ → **一整块**（用户报的 bug）', () => {
  const src = '推导：\n$$\n\\sum F = m a\n\\Rightarrow a = g\\sin\\alpha\n$$\n结束';
  const segs = splitDisplayMath(src);
  assert.equal(kinds(segs), 'TDT');
  assert.match(mathTex(segs)[0], /sum F = m a/);
  assert.match(mathTex(segs)[0], /Rightarrow/);
});

t('\\[ … \\] → 块级', () => {
  const segs = splitDisplayMath('\\[ E = mc^2 \\]');
  assert.equal(kinds(segs), 'D');
  assert.equal(mathTex(segs)[0].trim(), 'E = mc^2');
});

t('\\begin{aligned} … \\end{aligned} → 块级（不用写 $$）', () => {
  const src = '\\begin{aligned} a &= g\\sin\\alpha \\\\ N &= mg\\cos\\alpha \\end{aligned}';
  const segs = splitDisplayMath(src);
  assert.equal(kinds(segs), 'D');
  assert.match(mathTex(segs)[0], /^\\begin\{aligned\}/);
});

t('行内 $x$ 与 \\(x\\) 都能切出来', () => {
  assert.equal(kinds(splitInlineMath('速度 $v$ 与 \\(t\\) 无关')), 'TITIT');
});

t('$5 and $6 不被误判为公式', () => {
  const segs = splitInlineMath('$5 and $6');
  assert.equal(segs.filter((s) => s.kind === 'math').length, 0);
  assert.equal(segmentsText(segs), '$5 and $6');
});

function segmentsText(segs) {
  return segs.map((s) => (s.kind === 'text' ? s.text : `$${s.tex}$`)).join('');
}

t('公式里可以有换行以外的空白、中文与下标', () => {
  const segs = splitInlineMath('质量 $m_1 = 2\\,\\mathrm{kg}$ 的物块');
  assert.equal(kinds(segs), 'TIT');
  assert.equal(mathTex(segs)[0], 'm_1 = 2\\,\\mathrm{kg}');
});

t('未闭合的 $$ 不吞内容（退化成文本）', () => {
  const src = '开头 $$ a + b\n后面还有正文';
  const segs = splitDisplayMath(src);
  assert.equal(segs.filter((s) => s.kind === 'math').length, 0);
  assert.match(segmentsText(segs), /\$\$ a \+ b/);
  assert.match(segmentsText(segs), /后面还有正文/);
});

t('hasMath：各种写法都算', () => {
  assert.equal(hasMath('$x$'), true);
  assert.equal(hasMath('$$\nx\n$$'), true);
  assert.equal(hasMath('\\[x\\]'), true);
  assert.equal(hasMath('\\(x\\)'), true);
  assert.equal(hasMath('\\begin{cases} x \\end{cases}'), true);
  assert.equal(hasMath('纯文字，没有公式'), false);
  assert.equal(hasMath('$5 and $6'), false);
});

t('buildRenderBlocks：多行公式独立成块，前后文本各自成块', () => {
  const blocks = buildRenderBlocks('第一步：\n$$\na = 4.9\n$$\n所以 $a$ 约为 4.9');
  const kinds2 = blocks.map((b) => b.kind).join(',');
  assert.match(kinds2, /^p,math/);
  const math = blocks.find((b) => b.kind === 'math');
  assert.match(math.tex, /a = 4\.9/);
  const tail = blocks[blocks.length - 1];
  assert.equal(tail.kind, 'p');
  assert.equal(tail.segments.filter((s) => s.kind === 'math').length, 1, '行内 $a$ 要保留为公式');
});

t('buildRenderBlocks：标题/列表里的行内公式保留', () => {
  const blocks = buildRenderBlocks('## 第 $n$ 步\n- 用 $\\sin\\alpha$\n- 检查单位');
  assert.equal(blocks[0].kind, 'heading');
  assert.equal(blocks[0].segments.filter((s) => s.kind === 'math').length, 1);
  assert.equal(blocks[1].kind, 'li');
  assert.equal(blocks[1].segments.filter((s) => s.kind === 'math').length, 1);
});

t('buildRenderBlocks：代码围栏里的 $ 不当公式', () => {
  const blocks = buildRenderBlocks('```\n$a + b$\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'code');
  assert.equal(blocks[0].segments[0].kind, 'text');
  assert.equal(blocks[0].segments[0].text, '$a + b$');
});

t('buildRenderBlocks：空行保留为 whitespace 块', () => {
  const blocks = buildRenderBlocks('a\n\nb');
  assert.deepEqual(blocks.map((b) => b.kind), ['p', 'p', 'p']);
  assert.equal(blocks[1].whitespace, true);
});

t('parseInlineTokens：粗体/斜体/代码', () => {
  const toks = parseInlineTokens('**粗** *斜* `code` 普通');
  assert.deepEqual(toks.map((t2) => t2.kind), ['bold', 'text', 'italic', 'text', 'code', 'text']);
});

t('splitMathSegments：混合文档里公式数量正确', () => {
  const src = '# 提示\n用 $F=ma$，整体：\n$$\nF = m a\n$$\n结束';
  assert.equal(splitMathSegments(src).filter((s) => s.kind === 'math').length, 2);
});

t('normalizeMathDelimiters：\\[ \\] / \\( \\) / 裸环境 统一成 $ 形式（PDF 管线只认这个）', () => {
  assert.equal(normalizeMathDelimiters('\\[E=mc^2\\]'), '$$E=mc^2$$');
  assert.equal(normalizeMathDelimiters('速度 \\(v\\) 不变'), '速度 $v$ 不变');
  const aligned = normalizeMathDelimiters('\\begin{aligned} a &= b \\end{aligned}');
  assert.equal(aligned, '$$\\begin{aligned} a &= b \\end{aligned}$$');
  // 已经是 $$ 的不重复包裹
  assert.equal(normalizeMathDelimiters('$$x$$'), '$$x$$');
  // 多行 $$ 原样保留（内容只裁掉首尾空白）
  const multi = normalizeMathDelimiters('$$\na = 1\n$$');
  assert.equal(multi, '$$a = 1$$');
});

// ---- 裸 LaTeX（不带 $ 的整行）----
t('isBareLatexLine：裸命令行认；散文 / 路径 / 金额 / 反引号不认', () => {
  assert.equal(isBareLatexLine('\\sum_{1}^{2}'), true, '符号面板插入的形态');
  assert.equal(isBareLatexLine('\\frac{a}{b}'), true);
  assert.equal(isBareLatexLine('\\alpha + \\beta'), true);
  assert.equal(isBareLatexLine('\\int_{0}^{1} x^2 \\, dx'), true);
  assert.equal(isBareLatexLine('C:\\Users\\xinka'), false, 'Windows 路径');
  assert.equal(isBareLatexLine('用 \\sum 求和'), false, '中文散文');
  assert.equal(isBareLatexLine('$5 and $6'), false, '金额');
  assert.equal(isBareLatexLine('the \\sum of them'), false, '英文句子');
  assert.equal(isBareLatexLine('\\Users'), false, '命令不在白名单');
  assert.equal(isBareLatexLine('见 `\\sum` 命令'), false, '反引号 = 代码');
});

t('buildRenderBlocks：整行裸 LaTeX → 块级公式；散文里的 \\sum 保持文本', () => {
  const blocks = buildRenderBlocks('\\sum_{1}^{2}');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'math');
  assert.equal(blocks[0].tex, '\\sum_{1}^{2}');
  const prose = buildRenderBlocks('用 \\sum 求和时注意上下限');
  assert.equal(prose[0].kind, 'p');
  assert.equal(prose[0].segments.some((s) => s.kind === 'math'), false);
});

t('hasMath：裸命令行也算有公式（要注入 KaTeX 样式）', () => {
  assert.equal(hasMath('\\sum_{1}^{2}'), true);
  assert.equal(hasMath('C:\\Users\\xinka'), false);
});

t('normalizeMathDelimiters：裸命令行包成 $$…$$（PDF 与屏幕一致）', () => {
  assert.equal(normalizeMathDelimiters('\\sum_{1}^{2}'), '$$\\sum_{1}^{2}$$');
  assert.equal(normalizeMathDelimiters('C:\\Users\\xinka'), 'C:\\Users\\xinka');
  assert.equal(normalizeMathDelimiters('用 \\sum 求和'), '用 \\sum 求和');
});

t('整行只有 `$…$` 时必须是行内公式，不能再当"裸 LaTeX"（真机红字 bug 回归）', () => {
  assert.equal(isBareLatexLine('$T = 2\\pi\\sqrt{l/g}$'), false, '已经带分隔符的不能再包');
  assert.equal(isBareLatexLine('$$x$$'), false);
  assert.equal(isBareLatexLine('\\[x\\]'), false);
  assert.equal(isBareLatexLine('\\(x\\)'), false);
  const blocks = buildRenderBlocks('$T = 2\\pi\\sqrt{l/g}$');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'p');
  assert.equal(blocks[0].segments.length, 1);
  assert.equal(blocks[0].segments[0].kind, 'math');
  assert.equal(blocks[0].segments[0].display, false);
  // 带 `$$` 的块级仍然正常
  assert.equal(buildRenderBlocks('$$x$$')[0].kind, 'math');
});

console.log(`\n[exercise-math-parse] ${passed} 项断言通过`);
