// ============================================================
// check4.mjs — 提交 PDF 的两块：pdf-html（HTML 生成）+ pdf-render（浏览器打印/合并）
//
// 为什么这两块一起测：
//   它们是"答案 → 提交件"这一条链的上游与下游，中间唯一接口就是 HTML 字符串
//   和 RenderResult。分开测会漏掉"HTML 里少了公式锚点 / 多了一个 <script>"这类
//   只在下游才暴露的问题。
//
// 刻意**不启动浏览器**：
//   · CI / 沙箱里没有 GUI，也不该在单测里拉起 200 MB 的 Edge 进程
//   · 浏览器那一段的正确性靠"jsdom 无法替代"的打印参数与文件校验兜底，
//     测试只验证"找不到浏览器/路径错误时不抛异常、返回结构化错误"
//
// 用法：node test/check4.mjs（需先 npm run build，lib/ 是可执行产物）
// ============================================================
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 依赖：pdf-lib 只用于"造两张真 PDF 再合并"，不参与产品逻辑
import { PDFDocument } from 'pdf-lib';

import { buildSubmissionHtml, renderMarkdownFragment } from '../lib/pdf-html.js';
import { katexCssInlined } from '../lib/pdf-math.js';
import { countPdfPages, findChromium, mergePdfs, renderSubmissionPdf } from '../lib/pdf-render.js';

let passed = 0;

/** 断言包装：失败即整个脚本非 0 退出（与仓库其它 check*.mjs 同风格）。 */
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ============================================================
// 临时目录（仓库根 temp/ex-sub/）
//
// 用 import.meta.url 反推仓库根，而不是 process.cwd()：
// 测试既可能从仓库根跑，也可能从包目录跑（npm test -w 会切 cwd），
// 靠 cwd 会在包内生成 temp/，污染源码树。
// ============================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const TMP = join(REPO_ROOT, 'temp', 'ex-sub');

function resetTmp() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

async function makeOnePagePdf(file) {
  const doc = await PDFDocument.create();
  // A4，与真实原卷/解答页同尺寸
  doc.addPage([595.28, 841.89]);
  const bytes = await doc.save({ useObjectStreams: false });
  writeFileSync(file, bytes);
}

// ============================================================
// 测试固定数据
// ============================================================

const NOW = Date.UTC(2026, 9, 20, 19, 0, 0); // 固定时刻：确定性断言的前提

function baseInput(overrides = {}) {
  return {
    courseTitle: 'Physik I',
    courseId: 'physik-1',
    sheet: {
      id: 'ub03',
      number: 3,
      title: 'Drehimpuls',
      issued: '2026-10-15',
      due: '2026-10-22',
    },
    problems: [
      {
        label: 'Aufgabe 1',
        title: 'Drehimpuls einer Scheibe',
        text: 'Berechne $x^2$ für die Scheibe.',
        points: 4,
        answer: 'Aus $L = I\\omega$ folgt **L = 2** kg m²/s.',
        verdict: 'partial',
        note: 'Einheit nicht vergessen',
      },
    ],
    lessons: ['**Drehimpuls** ist nur bei feststehender Achse $I\\omega$'],
    studentName: '',
    lang: 'de',
    now: NOW,
    ...overrides,
  };
}

// ============================================================
// 1) renderMarkdownFragment —— 转义顺序 + markdown 子集
// ============================================================

await t('renderMarkdownFragment：<script> 被转义，不产生标签', () => {
  const out = renderMarkdownFragment('<script>alert(1)</script>');
  assert.ok(out.includes('&lt;script&gt;'), '应包含转义后的 script 文本');
  assert.ok(!out.includes('<script'), '绝不能留下真实 <script 标签');
});

await t('renderMarkdownFragment：& < > " \' 全部转义（单趟，无二次转义）', () => {
  const out = renderMarkdownFragment('a & b < c > d "e" \'f\'');
  assert.ok(out.includes('&amp;'));
  assert.ok(out.includes('&lt;'));
  assert.ok(out.includes('&gt;'));
  assert.ok(out.includes('&quot;'));
  assert.ok(out.includes('&#39;'));
  // 二次转义的典型症状：&amp;amp;
  assert.ok(!out.includes('&amp;amp;'));
});

await t('renderMarkdownFragment：粗体 → <strong>', () => {
  const out = renderMarkdownFragment('das ist **wichtig** hier');
  assert.ok(out.includes('<strong>wichtig</strong>'));
});

await t('renderMarkdownFragment：行内代码 → <code>，且内部内容再被转义', () => {
  const out = renderMarkdownFragment('nutze `a<b` als Symbol');
  assert.ok(out.includes('<code>a&lt;b</code>'));
});

await t('renderMarkdownFragment：代码块里的 ** 不会被加粗', () => {
  const out = renderMarkdownFragment('`**x**`');
  assert.ok(out.includes('<code>**x**</code>'));
  assert.ok(!out.includes('<strong>'));
});

await t('renderMarkdownFragment：无序列表 → <ul><li>', () => {
  const out = renderMarkdownFragment('- eins\n- zwei');
  assert.ok(out.includes('<ul>'));
  assert.ok(out.includes('<li>eins</li>'));
  assert.ok(out.includes('<li>zwei</li>'));
});

await t('renderMarkdownFragment：有序列表 → <ol><li>', () => {
  const out = renderMarkdownFragment('1. erst\n2. dann');
  assert.ok(out.includes('<ol>'));
  assert.ok(out.includes('<li>erst</li>'));
});

await t('renderMarkdownFragment：标题 → <hN>', () => {
  assert.ok(renderMarkdownFragment('## Lösung').includes('<h2>Lösung</h2>'));
  assert.ok(renderMarkdownFragment('# Titel').includes('<h1>Titel</h1>'));
});

await t('renderMarkdownFragment：单换行保留为 <br>', () => {
  const out = renderMarkdownFragment('Zeile 1\nZeile 2');
  assert.ok(out.includes('Zeile 1<br>Zeile 2'));
});

await t('renderMarkdownFragment：行内公式退化为 .math-fallback，且不留 $…$ 源码', () => {
  const out = renderMarkdownFragment('es gilt $x^2$ hier');
  assert.ok(out.includes('<code class="math math-fallback">x^2</code>'));
  assert.ok(!out.includes('$x^2$'), '公式定界符必须被消费掉');
});

await t('renderMarkdownFragment：块级公式 → <div class="math display">，可跨行', () => {
  const out = renderMarkdownFragment('$$\n\\int_0^1 x\\,dx\n$$');
  assert.ok(out.includes('<div class="math display">'));
  assert.ok(out.includes('\\int_0^1 x\\,dx'));
  assert.ok(!out.includes('$$'));
});

await t('renderMarkdownFragment：粗体里的公式仍被识别（递归一次）', () => {
  const out = renderMarkdownFragment('**$v$**');
  assert.ok(out.includes('<strong>'));
  assert.ok(out.includes('math-fallback'));
});

await t('renderMarkdownFragment：空输入 → 空串', () => {
  assert.equal(renderMarkdownFragment(''), '');
  assert.equal(renderMarkdownFragment('   \n\n  '), '');
});

// ============================================================
// 2) buildSubmissionHtml —— 头部/卡片/打印规则（无注入渲染器）
// ============================================================

const htmlNoRenderer = buildSubmissionHtml(baseInput());

await t('buildSubmissionHtml：含课程名 / Übungsblatt N / 截止日期', () => {
  assert.ok(htmlNoRenderer.includes('Physik I'));
  assert.ok(htmlNoRenderer.includes('Übungsblatt 3'));
  assert.ok(htmlNoRenderer.includes('2026-10-22'));
  assert.ok(htmlNoRenderer.includes('2026-10-15'));
});

await t('buildSubmissionHtml：标题与 lang 属性正确', () => {
  assert.ok(/<title>[^<]*Physik I[^<]*<\/title>/.test(htmlNoRenderer));
  assert.ok(htmlNoRenderer.includes('<html lang="de">'));
});

await t('buildSubmissionHtml：每题含标签/分值/答案段', () => {
  assert.ok(htmlNoRenderer.includes('data-label="Aufgabe 1"'));
  assert.ok(htmlNoRenderer.includes('<span class="points">4 P</span>'));
  assert.ok(htmlNoRenderer.includes('<h3 class="answer-head">Lösung</h3>'));
});

await t('buildSubmissionHtml：无渲染器时公式走 .math-fallback，且无 $…$ 残留', () => {
  // 不能只搜 'math-fallback'：CSS 里本来就有这个类名，那样断言恒真。
  assert.ok(htmlNoRenderer.includes('<code class="math math-fallback">x^2</code>'));
  assert.ok(!htmlNoRenderer.includes('$x^2$'));
});

await t('buildSubmissionHtml：标题/副标题里的 `$…$` 也要渲染（不能原样印 `$m$`）', () => {
  const html = buildSubmissionHtml({
    courseTitle: 'Physik I',
    courseId: 'physik-1',
    sheet: { id: 'ub01', number: 1, title: 'Schwingungen mit $\\omega_0$', issued: '', due: '' },
    problems: [
      {
        label: 'Aufgabe 1',
        title: 'Masse $m$ auf schiefer Ebene',
        text: 'Bestimmen Sie $a$.',
        points: 4,
        answer: '$a = g\\sin\\alpha$',
      },
    ],
    renderMath: (tex, display) => `<span class="math" data-tex="${tex}" data-display="${display}"></span>`,
  });
  assert.ok(html.includes('data-tex="m"'), '标题里的 $m$ 应该渲染成公式');
  assert.ok(!html.includes('$m$'), '标题里不能再出现原始 $m$');
  assert.ok(html.includes('data-tex="\\omega_0"'), '副标题里的公式也要渲染');
  assert.ok(!html.includes('$\\omega_0$'));
});
await t('buildSubmissionHtml：**不出现任何工具/AI 品牌**（助教不该怀疑是 AI 做的）', () => {
  // 2026-10-24 用户要求：删掉页脚 "generated by Aemeath" 与生成时间戳
  assert.ok(!/aemeath/i.test(htmlNoRenderer), 'HTML 里不能出现 Aemeath');
  assert.ok(!/generated by/i.test(htmlNoRenderer));
  assert.ok(!/name="generator"/i.test(htmlNoRenderer), '不要 meta generator');
  assert.ok(!/doc-meta/.test(htmlNoRenderer), '不再输出生成信息页脚');
  assert.ok(!/AI generated|AI-generiert|von KI/i.test(htmlNoRenderer), '不要任何“AI 生成”字样');
  // 页码仍然要有（margin box）
  assert.ok(htmlNoRenderer.includes('counter(page)'));
});
await t('buildSubmissionHtml：**不含任何 <script>**（打印页不依赖 JS）', () => {
  assert.ok(!htmlNoRenderer.includes('<script'), '提交件里不该出现 script 标签');
  assert.ok(!htmlNoRenderer.includes('</script'));
  assert.ok(!htmlNoRenderer.includes('mathlive'));
});

await t('buildSubmissionHtml：verdict 徽章存在，且打印时被 CSS 隐藏', () => {
  assert.ok(htmlNoRenderer.includes('<span class="verdict verdict--partial">'));
  assert.match(htmlNoRenderer, /@media print\s*\{[\s\S]*?\.verdict\s*\{\s*display:\s*none;\s*\}/);
});

await t('buildSubmissionHtml：A4 页面规则 + 卡片不跨页', () => {
  assert.ok(htmlNoRenderer.includes('size: A4'));
  assert.ok(htmlNoRenderer.includes('margin: 18mm 16mm'));
  assert.ok(htmlNoRenderer.includes('break-inside: avoid'));
  assert.ok(htmlNoRenderer.includes('-webkit-print-color-adjust: exact'));
});

await t('buildSubmissionHtml：字体栈含 Segoe UI / PingFang SC / Microsoft YaHei', () => {
  assert.ok(htmlNoRenderer.includes('"Segoe UI"'));
  assert.ok(htmlNoRenderer.includes('"PingFang SC"'));
  assert.ok(htmlNoRenderer.includes('"Microsoft YaHei"'));
});

await t('buildSubmissionHtml：page 1 有"Name: ______"（未填姓名时）', () => {
  assert.ok(htmlNoRenderer.includes('Name:'));
  assert.ok(htmlNoRenderer.includes('______________'));
});

await t('buildSubmissionHtml：填了姓名就用姓名，不再留横线', () => {
  const html = buildSubmissionHtml(baseInput({ studentName: 'Xin Kai' }));
  assert.ok(html.includes('<span class="name-value">Xin Kai</span>'));
});

await t('buildSubmissionHtml：确定性（同一输入两次结果完全相同）', () => {
  const a = buildSubmissionHtml(baseInput());
  const b = buildSubmissionHtml(baseInput());
  assert.equal(a, b);
  assert.equal(htmlNoRenderer, a);
});

await t('buildSubmissionHtml：用户输入不会变成标签（题干/课程名/标题）', () => {
  const html = buildSubmissionHtml(
    baseInput({
      courseTitle: '<img src=x onerror=alert(1)>',
      sheet: { id: 'ub1', number: 1, title: '<b>fett</b>', issued: '', due: '' },
      problems: [
        {
          label: '<svg onload=alert(1)>',
          title: '<iframe src="x">',
          text: 'x',
          points: null,
          answer: 'y',
          verdict: 'correct',
          note: '<script>bad()</script>',
        },
      ],
    }),
  );
  assert.ok(!html.includes('<img'), '课程名里的标签必须被转义');
  assert.ok(!html.includes('<iframe'), '标题里的标签必须被转义');
  assert.ok(!html.includes('<b>fett</b>'));
  assert.ok(!html.includes('<script>bad'));
  assert.ok(html.includes('&lt;iframe'));
});

await t('buildSubmissionHtml：长解答单独起页，短解答不', () => {
  // 注意：CSS 里本来就有 `.problem.break-before` 规则，所以不能直接搜字符串，
  // 必须只看 <article> 的 class —— 否则这个断言永远"通过"且永远没有意义。
  const short = buildSubmissionHtml(baseInput());
  assert.equal((short.match(/<article class="[^"]*break-before/g) ?? []).length, 0, '短答案不该起新页');

  const long = buildSubmissionHtml(
    baseInput({
      problems: [
        { label: 'A1', title: 'kurz', text: 't', points: 1, answer: 'kurz' },
        { label: 'A2', title: 'lang', text: 't', points: 1, answer: 'x'.repeat(900) },
      ],
    }),
  );
  assert.equal((long.match(/<article class="[^"]*break-before/g) ?? []).length, 1);
  assert.ok(long.includes('class="problem break-before"'));
});

await t('buildSubmissionHtml：经验列表附在最后', () => {
  assert.ok(htmlNoRenderer.includes('<section class="lessons">'));
  assert.ok(htmlNoRenderer.includes('<strong>Drehimpuls</strong>'));
});

await t('buildSubmissionHtml：zh 文案切换（第 N 次作业 / 解答）', () => {
  const html = buildSubmissionHtml(baseInput({ lang: 'zh' }));
  assert.ok(html.includes('第 3 次作业'));
  assert.ok(html.includes('解答'));
  assert.ok(html.includes('<html lang="zh-CN">'));
});

// ============================================================
// 3) buildSubmissionHtml —— host 注入的公式渲染器
// ============================================================

await t('buildSubmissionHtml：注入 renderMath 后内联其 HTML，且仍无 <script>', () => {
  const html = buildSubmissionHtml(
    baseInput({
      renderMath: (tex) => `<span class="k">${tex}</span>`,
    }),
  );
  assert.ok(html.includes('<span class="math"><span class="k">x^2</span></span>'), '应内联渲染器返回的 HTML');
  assert.ok(!html.includes('<script'));
  // 同样不能搜类名字符串（CSS 里有），要看真实的 <code> 元素
  assert.ok(!html.includes('<code class="math math-fallback">'), '有渲染器时不该出现源码回退');
  assert.ok(!html.includes('<code class="math-fallback">'));
});

await t('buildSubmissionHtml：renderMath 收到的是**未转义**的原始 TeX', () => {
  const calls = [];
  buildSubmissionHtml(
    baseInput({
      problems: [
        { label: 'A1', title: '', text: 'vergleiche $a<b$ mit $c$', points: null, answer: 'ok' },
      ],
      lessons: [],
      renderMath: (tex, display) => {
        calls.push([tex, display]);
        return `<span class="k">${tex}</span>`;
      },
    }),
  );
  assert.deepEqual(calls[0], ['a<b', false], '实体必须还原成原始 TeX 再交给渲染器');
  assert.deepEqual(calls[1], ['c', false]);
});

await t('buildSubmissionHtml：display 公式以 display=true 调用，并包成块级容器', () => {
  const calls = [];
  const html = buildSubmissionHtml(
    baseInput({
      problems: [
        { label: 'A1', title: '', text: '$$\\int_0^1 x\\,dx$$', points: null, answer: 'ok' },
      ],
      lessons: [],
      renderMath: (tex, display) => {
        calls.push([tex, display]);
        return `<span class="k">${tex}</span>`;
      },
    }),
  );
  assert.deepEqual(calls[0], ['\\int_0^1 x\\,dx', true]);
  assert.ok(html.includes('<div class="math display"><span class="k">\\int_0^1 x\\,dx</span></div>'));
});

await t('buildSubmissionHtml：inlineCss 原样注入且排在内置打印 CSS 之后', () => {
  const html = buildSubmissionHtml(
    baseInput({
      inlineCss: '/*katex-test*/ .katex{font-size:1.1em}',
      renderMath: (tex) => `<span class="k">${tex}</span>`,
    }),
  );
  assert.ok(html.includes('/*katex-test*/ .katex{font-size:1.1em}'));
  assert.ok(html.indexOf('/*katex-test*/') > html.indexOf('@page'), '注入 CSS 应能覆盖内置打印样式');
});

await t('buildSubmissionHtml：inlineCss 里的 </style> 不能提前闭合 style 标签', () => {
  const html = buildSubmissionHtml(baseInput({ inlineCss: 'a::after{content:"</style>"}' }));
  // 只应有一个 </style>（我们自己的收尾），注入内容里的那个被转义
  const closing = html.split('</style>').length - 1;
  assert.equal(closing, 1);
});

// ============================================================
// 4) findChromium —— 只做"有则真实存在"的弱断言
// ============================================================

await t('findChromium：返回 null 或一个真实存在的可执行文件', () => {
  const info = findChromium();
  if (info !== null) {
    assert.equal(typeof info.path, 'string');
    assert.ok(info.path.length > 0);
    assert.ok(existsSync(info.path), `报告的浏览器路径必须存在：${info.path}`);
    assert.equal(typeof info.name, 'string');
  }
});

await t('findChromium：extraPaths 里不存在的文件被忽略（不会误报）', () => {
  const info = findChromium([join(TMP, 'definitely-not-chrome.exe')]);
  if (info !== null) assert.ok(existsSync(info.path));
});

// ============================================================
// 5) mergePdfs / countPdfPages —— 真造 PDF，不碰浏览器
// ============================================================

resetTmp();

await t('mergePdfs：两页合成两页，文件非空且可解析', async () => {
  const a = join(TMP, 'a.pdf');
  const b = join(TMP, 'b.pdf');
  const out = join(TMP, 'merged.pdf');
  await makeOnePagePdf(a);
  await makeOnePagePdf(b);

  const res = await mergePdfs([a, b], out);
  assert.equal(res.pages, 2);
  assert.ok(res.bytes > 0);
  assert.ok(existsSync(out));
  assert.ok(statSync(out).size > 0);
  assert.equal(await countPdfPages(out), 2);
});

await t('countPdfPages：单页 PDF 报 1 页', async () => {
  const one = join(TMP, 'one.pdf');
  await makeOnePagePdf(one);
  assert.equal(await countPdfPages(one), 1);
});

await t('mergePdfs：空数组 → 明确抛错（编程错误不静默）', async () => {
  await assert.rejects(() => mergePdfs([], join(TMP, 'never.pdf')), /至少需要一个 PDF/);
});

// ============================================================
// 6) renderSubmissionPdf —— 失败路径（不起浏览器）
// ============================================================

await t('renderSubmissionPdf：chromePath 不存在时返回 ok:false，不抛异常', async () => {
  const res = await renderSubmissionPdf({
    url: 'http://127.0.0.1:1/never',
    outPdf: join(TMP, 'never.pdf'),
    chromePath: join(TMP, 'no-such-chrome.exe'),
    timeoutMs: 500,
  });
  assert.equal(res.ok, false);
  assert.equal(res.merged, false);
  assert.match(res.error, /chromePath/);
});

await t('renderSubmissionPdf：无原卷时 merged 为 false（失败结果也有结构）', async () => {
  const res = await renderSubmissionPdf({
    url: 'http://127.0.0.1:1/never',
    outPdf: join(TMP, 'never2.pdf'),
    chromePath: join(TMP, 'no-such-chrome.exe'),
    timeoutMs: 500,
  });
  assert.equal(res.ok, false);
  assert.equal(res.merged, false);
  assert.equal(typeof res.error, 'string');
});

await t('katexCssInlined：真的找到了 katex.min.css（分数线/上下标靠它）', () => {
  const css = katexCssInlined();
  assert.ok(css.length > 10_000, `CSS 太小（${css.length}）：说明没找到 katex.min.css`);
  assert.ok(css.includes('.mfrac'), '必须有分数规则');
  assert.ok(css.includes('.katex'), '必须有 katex 基础规则');
  assert.ok(css.includes('data:font/woff2;base64,'), '字体要内联（file:// 下不能引用相对路径）');
});

await t('打印 CSS：.math.display 不能有 overflow-x:auto（会在 PDF 里画出滚动条 ▲▼）', () => {
  const html = buildSubmissionHtml({
    courseTitle: 'Physik I',
    courseId: 'physik-1',
    sheet: { id: 'ub01', number: 1, title: '', issued: '', due: '' },
    problems: [{ label: 'A1', title: '', text: 'x', points: null, answer: '$$a=b$$' }],
    renderMath: (tex) => `<span class="katex">${tex}</span>`,
  });
  const i = html.indexOf('.math.display {');
  assert.ok(i > 0, '要有 .math.display 规则');
  const rule = html.slice(i, i + 260);
  assert.ok(!/^\s*overflow-x\s*:\s*auto/m.test(rule), '横向滚动会印出滚动条按钮');
  assert.match(rule, /overflow:\s*visible/);
});

console.log(`\n[exercise-pdf-html] ${passed} 项断言通过`);

