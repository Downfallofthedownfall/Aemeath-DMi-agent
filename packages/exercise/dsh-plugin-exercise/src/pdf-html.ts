// ============================================================
// pdf-html.ts — 提交用 PDF 的 HTML 生成（**纯函数**）
//
// 设计依据：docs/exercise-mode-plan.md D6 —— 提交物 = 原卷 + 解答合成的**一个** PDF，
// 且公式必须**真渲染**（助教按 PDF 打分，看到 `$x^2$` 源码等于没有解答）。
//
// 分工（刻意拆开，便于单测）：
//   · 本文件只产出 HTML 字符串：不碰 fs、不碰 child_process、**不 import pdf-lib**
//   · pdf-render.ts 负责"把这个 HTML 交给本机 Chromium 打成 PDF"并合并原卷
//   · 公式渲染器由 host **注入**（`renderMath`），本文件不依赖 KaTeX/MathLive，
//     也不产出任何 <script>：打印页可能以 file:// 打开（没有 dsh 的认证 cookie），
//     在线加载 mathlive.js/css 会 401，而且 headless 打印不该依赖 JS 执行完成。
//     没有注入渲染器时退化成 `<code class="math-fallback">` 显示 TeX 源码 ——
//     可读、等宽、不空白，一眼能看出是渲染管线没接上。
//
// 三条硬约束（都是踩过坑换来的）：
//   1) **转义顺序安全**：先整体 escape → 再做 markdown 子集 → 最后才生成 HTML 片段。
//      任何"先拼 HTML 再转义"的写法都会把用户输入（题干来自 PDF/LLM，不可信）
//      变成注入面。
//   2) **确定性**：不读任何时钟/随机量。同一输入必须得到同一份 HTML，
//      否则"同一套题重新导出 → 文件不同"会让用户无法判断是否以及时更新。
//   3) **打印优先**：A4、页脚、`break-inside: avoid`；内部判卷徽章（verdict）打印时隐藏 ——
//      交给助教的 PDF 里**不能**出现"我们自己说这题对不对"。
// ============================================================

import { normalizeMathDelimiters } from './math-parse.js';
import { wrapBareLatexLines } from './print-normalize.js';

// ============================================================
// 对外类型（与 types.ts 的 Problem 解耦：导出层不依赖 zod，client 也能直接读）
// ============================================================

/** host 注入的公式渲染器：返回**受信任的 HTML**（KaTeX 的 renderToString 产物）。 */
export type MathRenderer = (tex: string, display: boolean) => string;

export interface SubmissionProblem {
  label: string;
  title: string;
  text: string;      // markdown-ish + `$inline$` / `$$display$$` LaTeX
  points: number | null;
  answer: string;    // same format
  verdict?: 'correct' | 'partial' | 'wrong' | 'unclear' | 'error' | null;
  note?: string;     // 用户备注（可选，小字）
  /** 答案附图（data URI；由 host 从 store 读出后注入，保持渲染层无 IO） */
  images?: Array<{ name: string; caption?: string; dataUri: string }>;
  /** 题干截图（极简模式上传的题目图片） */
  statementImages?: Array<{ name: string; caption?: string; dataUri: string }>;
}

export interface SubmissionHtmlInput {
  courseTitle: string;
  courseId: string;
  sheet: { id: string; number: number; title: string; issued: string; due: string };
  problems: SubmissionProblem[];
  /** 本套题沉淀的经验（可选，附在最后一页） */
  lessons?: string[];
  studentName?: string;
  /** 由 host 注入的公式渲染器（KaTeX）；返回受信任的 HTML。缺省 = 静态兜底（显示 TeX 源码） */
  renderMath?: MathRenderer;
  /** 直接内联进 <style> 的 CSS（host 会传入 KaTeX CSS + base64 字体） */
  inlineCss?: string;
  /** 已经不再需要，但保留可选以便将来做在线预览 */
  mathAssetsBase?: string;
  /** 'de' | 'zh'（默认 de：作业要交给德国助教） */
  lang?: 'de' | 'zh';
}

// ============================================================
// 转义（单趟替换 —— 绝不能用链式 replace）
//
// 为什么强调单趟：`s.replace(/&/g,'&amp;').replace(/</g,'&lt;')…` 这类写法里，
// 后一趟会把前一趟产出的 `&amp;` 再拆一次（`&` → `&amp;amp;`），
// 于是用户输入 `&lt;` 会变成字面上的 `&lt;` 而不是 `<`。单趟回调只扫原始字符，
// 不存在二次转义，也天然不可能漏掉某一种字符。
// ============================================================

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  // 单引号也转：虽然我们只用双引号属性，但 `data-tex` 里出现 `'` 时
  // 某些校验器/编辑器会把它当属性边界，转掉最省心。
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/**
 * 反向转义（只认我们自己产出的 5 种实体）。
 *
 * 为什么需要它：markdown 管线全程在**已转义**文本上运行，所以公式内容抠出来时
 * 是 `a&lt;b`。注入的渲染器要的是**原始 TeX**（`a<b`）——把实体原样喂给 KaTeX
 * 会把它当成字符序列 `&`、`l`、`t` 排版，或直接报错。
 *
 * 单趟 + 只认固定实体，不存在"解两次"（`&amp;lt;` 只会变成 `&lt;`）。
 */
const HTML_UNESCAPES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function unescapeHtml(s: string): string {
  return String(s ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (m) => HTML_UNESCAPES[m]!);
}

// ============================================================
// 占位符
//
// 用 NUL 包裹的占位符把"已经处理过的片段"藏起来，避免后续规则二次加工
// （典型事故：`**$x$**` 里先做 bold 会污染公式片段）。
//
// 安全性：输入在 normalizeSource 里**先删掉所有 NUL 字符**，
// 因此占位符只可能由本文件产生，用户文本无法伪装成占位符。
// ============================================================

const NUL = '\u0000';

/** 行内占位符：`\`code\`` 与公式在 bold 之前先被抽走。 */
function placeholder(kind: 'B' | 'C', index: number): string {
  return `${NUL}${kind}${index}${NUL}`;
}

function displayPlaceholderRe(): RegExp {
  // 每次新建：/g 正则带 lastIndex 状态，递归/重入时共享实例会串位。
  return new RegExp(`${NUL}B(\\d+)${NUL}`, 'g');
}

/** 解答超过这个长度才单独起页（短答案挤在一起省纸）。 */
const LONG_ANSWER_CHARS = 800;

// ============================================================
// 输入规范化
// ============================================================

function normalizeSource(src: string): string {
  return String(src ?? '')
    .replace(/\r\n?/g, '\n') // CRLF → LF：Windows 上直接粘贴的文本会带 \r
    // 控制字符（保留 \t / \n）：NUL 是占位符字符，必须先清掉，否则可被伪造；
    // 其余 C0 控制符（除 \t \n）在 PDF 里没有意义，留着只会干扰排版。
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// ============================================================
// 公式片段
//
// 两种形态：
//   · 有 renderMath → 内联渲染器返回的受信任 HTML（外面套 .math 便于打印样式）
//   · 无 renderMath → `<code class="math-fallback">` 显示 TeX 源码（已转义）
//
// ⚠️ 传进 renderMath 的必须是 **unescape 之后的原始 TeX**（见 unescapeHtml 注释）。
// ============================================================

function mathInlineHtml(escapedTex: string, renderMath?: MathRenderer): string {
  const tex = escapedTex.trim();
  if (renderMath) {
    return `<span class="math">${renderMath(unescapeHtml(tex), false)}</span>`;
  }
  return `<code class="math math-fallback">${tex}</code>`;
}

function mathDisplayHtml(escapedTex: string, renderMath?: MathRenderer): string {
  const tex = escapedTex.trim();
  if (renderMath) {
    return `<div class="math display">${renderMath(unescapeHtml(tex), true)}</div>`;
  }
  return `<div class="math display"><code class="math-fallback">${tex}</code></div>`;
}

// ============================================================
// markdown 子集（**在已转义文本上**运行）
//
// 只支持：段落 / 换行 / 粗体 / 行内代码 / 列表 / 标题 + 行内与块级公式。
// 刻意不引 markdown-it（零新依赖、行为可预测），也不支持表格/链接/图片 ——
// 提交件里不需要，且它们每一个都是额外的注入面。
//
// 行内规则**单趟扫描**（code | math | bold 三个分支），不是三趟 replace：
// 三趟 replace 会让先产出的 HTML 被后一趟规则二次加工，产生坏属性。
// ============================================================

const INLINE_RE_SRC = /`([^`\n]+)`|\$([^$\n]+?)\$|\*\*([^\n]+?)\*\*/;

/**
 * 行内片段 → HTML。
 *
 * `depth` 只服务于粗体内部的递归（`**$x$**` 里的公式仍要渲染）。
 * 上限 3：足以覆盖真实写法，又能挡住病态输入（`**` 嵌套几百层）的调用栈风险。
 */
function inlineToHtml(escaped: string, renderMath?: MathRenderer, depth = 0): string {
  if (!escaped) return '';
  const re = new RegExp(INLINE_RE_SRC.source, 'g');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(escaped)) !== null) {
    out += escaped.slice(last, m.index);
    if (m[1] !== undefined) {
      // 行内代码：内容已转义，原样放进 <code>；不再二次处理（`$`/`**` 在代码里是字面量）
      out += `<code>${m[1]}</code>`;
    } else if (m[2] !== undefined) {
      out += mathInlineHtml(m[2], renderMath);
    } else if (m[3] !== undefined) {
      const inner = depth < 3 ? inlineToHtml(m[3], renderMath, depth + 1) : m[3];
      out += `<strong>${inner}</strong>`;
    }
    last = m.index + m[0].length;
  }
  out += escaped.slice(last);
  return out;
}

function splitListMarker(line: string): { kind: 'ul' | 'ol'; content: string; num?: number } | null {
  // 无续行/嵌套：只认平铺列表。`*x*`（斜体）不会被误判，因为标记后必须跟空白。
  const m = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
  if (!m) return null;
  const marker = m[1]!;
  const kind: 'ul' | 'ol' = /^\d/.test(marker) ? 'ol' : 'ul';
  // 保留原始序号：`3)` 要印成 3.，不能被 CSS 重新从 1 开始编号
  return { kind, content: m[2]!, num: kind === 'ol' ? Number(marker.replace(/[.)]$/, '')) : undefined };
}

function renderBlocks(escapedBlockText: string, displayBlocks: string[], renderMath?: MathRenderer): string {
  const lines = escapedBlockText.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[]; start?: number } | null = null;

  const flushPara = (): void => {
    if (para.length === 0) return;
    // 行间 <br>：markdown 的软换行在作业解答里通常是有意义的换行
    // （多行推导），压成空格会让推导变成一坨。
    out.push(`<p>${para.map((l) => inlineToHtml(l, renderMath)).join('<br>')}</p>`);
    para = [];
  };

  const flushList = (): void => {
    if (!list) return;
    const tag = list.kind;
    const startAttr = list.kind === 'ol' && list.start && list.start > 1 ? ` start="${list.start}"` : '';
    out.push(`<${tag}${startAttr}>${list.items.map((it) => `<li>${inlineToHtml(it, renderMath)}</li>`).join('')}</${tag}>`);
    list = null;
  };

  for (const line of lines) {
    // 块级公式占位符：可能独占一行，也可能夹在一行文字中间。
    // 无论哪种都输出 <div>（块级公式不该被塞进 <p>，那是不合法的嵌套），
    // 代价是同一行文字会在公式前后断成两个段落 —— 打印上可接受。
    if (line.includes(NUL)) {
      flushList();
      flushPara();
      const re = displayPlaceholderRe();
      let cursor = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const before = line.slice(cursor, m.index).trim();
        if (before) out.push(`<p>${inlineToHtml(before, renderMath)}</p>`);
        const idx = Number(m[1]);
        out.push(mathDisplayHtml(displayBlocks[idx] ?? '', renderMath));
        cursor = m.index + m[0].length;
      }
      const after = line.slice(cursor).trim();
      if (after) out.push(`<p>${inlineToHtml(after, renderMath)}</p>`);
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inlineToHtml(heading[2]!, renderMath)}</h${level}>`);
      continue;
    }

    const item = splitListMarker(line);
    if (item) {
      flushPara();
      if (!list || list.kind !== item.kind) {
        flushList();
        list = { kind: item.kind, items: [], start: item.num };
      }
      list.items.push(item.content);
      continue;
    }

    flushList();
    para.push(line);
  }

  flushPara();
  flushList();
  return out.join('\n');
}

function renderFragment(src: string, renderMath?: MathRenderer): string {
  // ① 打印侧宽容：**整行就是 LaTeX** 的（`F = m \frac{dv}{dt}`）包成 $$…$$，
  //    用户屏幕按 `$` 规则写、纸上也不会印出源码（见 print-normalize.ts）。
  // ② \[…\] / \(…\) / 裸露的 \begin{aligned} 统一成 $$… / $…$，
  //    之后这条管线只认 $ 形式（用户写哪种都能打印出来）。
  const normalized = normalizeMathDelimiters(normalizeSource(wrapBareLatexLines(src)));
  if (normalized.trim() === '') return '';

  // 1) 先转义：此后整条管线里不存在"原始用户 HTML"
  const escaped = escapeHtml(normalized);

  // 2) 抽出块级公式（可跨行）。必须在切行之前做，否则多行公式会被拆成多段。
  const displayBlocks: string[] = [];
  const withPlaceholders = escaped.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => {
    displayBlocks.push(String(tex).trim());
    return placeholder('B', displayBlocks.length - 1);
  });

  // 3) 块级解析 + 行内转换
  return renderBlocks(withPlaceholders, displayBlocks, renderMath);
}

/**
 * markdown 子集 → HTML 片段（**无公式渲染器**：公式退化为 `.math-fallback` 源码）。
 *
 * 顺序被测试钉住：先整体 escape（用户 `<script>` 到此已变成文本）→
 * 抽出跨行 `$$…$$`（转义后仍能识别）→ 行级块解析 → 行内规则。
 * 任何一步提前生成 HTML 都会给用户输入留出绕过转义的缝隙。
 *
 * 注意：签名刻意保持两参数不变（供测试与外部复用）；需要真渲染公式时走
 * `buildSubmissionHtml({ renderMath })`，内部会用到同一个 renderFragment。
 */
export function renderMarkdownFragment(src: string): string {
  return renderFragment(src, undefined);
}

// ============================================================
// 文案（de 默认 / zh 自查草稿）
// ============================================================

interface Labels {
  sheet: string;
  issued: string;
  due: string;
  name: string;
  answer: string;
  problem: string;
  points: string;
  lessons: string;
  note: string;
  noText: string;
  noAnswer: string;
  verdicts: Record<'correct' | 'partial' | 'wrong' | 'unclear' | 'error', string>;
}

const LABELS: Record<'de' | 'zh', Labels> = {
  de: {
    sheet: 'Übungsblatt',
    issued: 'Ausgegeben',
    due: 'Abgabe',
    name: 'Name',
    answer: 'Lösung',
    problem: 'Aufgabe',
    points: 'P',
    lessons: 'Erkenntnisse',
    note: 'Notiz',
    noText: '(kein Aufgabentext)',
    noAnswer: '(keine Lösung eingetragen)',
    verdicts: {
      correct: 'richtig',
      partial: 'teilweise',
      wrong: 'falsch',
      unclear: 'unklar',
      error: 'Fehler',
    },
  },
  zh: {
    sheet: '第',
    issued: '布置',
    due: '截止',
    name: '姓名',
    answer: '解答',
    problem: '第',
    points: '分',
    lessons: '本套题的经验',
    note: '备注',
    noText: '（题干缺失）',
    noAnswer: '（还没有写解答）',
    verdicts: {
      correct: '正确',
      partial: '部分正确',
      wrong: '错误',
      unclear: '不确定',
      error: '出错',
    },
  },
};

const VERDICTS = ['correct', 'partial', 'wrong', 'unclear', 'error'] as const;

// ============================================================
// 打印 CSS
//
// 页码：**用 paged-media 的 margin box**。
//
// 这里有一条与"常见说法"相反的实测结论（Edge 43x / Chromium 13x，真机打印后
// 用 pdfjs 读文本坐标验证）：
//   · `@page { @bottom-right { content: counter(page) } }` **是生效的** ——
//     页码真的画在每页右下角（y≈20pt）。
//   · 而 `position: fixed` 的页脚 div 在打印里不可靠：实测在第 2 页被放到**页顶**
//     （y≈770，跟标题行重叠），第 1 页干脆不出现。这是引擎把 fixed 元素
//     按"每页独立视口"处理的副作用，不是字体/边距问题。
// 所以页码走 margin box，彻底不用 fixed div：不支持 margin box 的老引擎
// 只是少一个页码，绝不会错位压字。
// 两条 @page 分开写：万一某个引擎不认 margin box，也不会连带丢掉 size/margin。
//
// ⚠️ 2026-10-24（用户要求）：**不要在这张纸上出现任何工具/AI 品牌**——
// 之前页脚/页眉有 "generated by Aemeath" + 生成时间戳，助教会以为作业是 AI 做的。
// 现在整页只有：课程 / 套题 / 日期 / 姓名占位 / 题目 / 解答 / 页码。
// ============================================================

const PRINT_CSS = `
:root {
  --sans: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  --serif: "Cambria", "Georgia", "Times New Roman", "Songti SC", "SimSun", serif;
  --mono: ui-monospace, "Cascadia Mono", "Consolas", "SF Mono", monospace;
  --ink: #1a1a1a;
  --muted: #5c5c5c;
  --line: #d5d5d5;
  --accent: #7b5aa6;
  --bg: #ffffff;
}

@page {
  size: A4;
  margin: 18mm 16mm;
}

@page {
  @bottom-right { content: counter(page); }
}

html {
  background: #f2f2f2;
  /* 彩色徽章/表头背景要真的打印出来，不能被"省墨"模式吃掉 */
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

body {
  box-sizing: border-box;
  margin: 0 auto;
  max-width: 210mm;
  padding: 18mm 16mm;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 10.5pt;
  line-height: 1.55;
}

@media screen {
  body { box-shadow: 0 2px 16px rgba(0, 0, 0, 0.12); }
}

h1, h2, h3 { font-family: var(--sans); line-height: 1.3; }

/* === 头部 === */

.sheet-header { margin-bottom: 8mm; }

.course-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4mm;
  color: var(--muted);
  font-size: 9.5pt;
}

.course { font-weight: 600; color: var(--ink); }
.course-id { font-family: var(--mono); font-size: 8.5pt; }

.sheet-heading {
  margin: 2mm 0 0;
  font-size: 20pt;
  font-weight: 700;
  letter-spacing: 0.2pt;
}

.sheet-sub { margin-top: 1.5mm; color: var(--muted); font-size: 12pt; }

.dates {
  display: flex;
  flex-wrap: wrap;
  gap: 6mm;
  margin-top: 3mm;
  font-size: 10pt;
}

.dates .k, .student .k { color: var(--muted); margin-right: 1.5mm; }

.student { margin-top: 4mm; font-size: 11pt; }
.name-value { border-bottom: 1px solid var(--ink); padding: 0 2mm; }


/* === 题目卡片 === */

.problem {
  margin: 0 0 5mm;
  padding: 3.5mm 4mm;
  border: 1px solid var(--line);
  border-radius: 2mm;
  /* 一道题尽量不跨页：卡片被切成两半时，题干和答案分居两页，
     助教要来回翻，且"这题答案在哪"会变得难以确认 */
  break-inside: avoid;
  page-break-inside: avoid;
}

.problem-head { margin-bottom: 2.5mm; }

.problem-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2.5mm;
}

.label { font-family: var(--mono); font-size: 9pt; color: var(--muted); }

.points {
  padding: 0.3mm 1.8mm;
  border: 1px solid var(--line);
  border-radius: 1.5mm;
  color: var(--muted);
  font-size: 8.5pt;
  white-space: nowrap;
}

.problem-title { margin: 0.8mm 0 0; font-size: 13pt; font-weight: 600; }

.answer-head {
  margin: 3mm 0 1.5mm;
  font-size: 9pt;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6pt;
  color: var(--accent);
}

.answer { font-family: var(--serif); font-size: 11pt; }
.answer-figure { margin: 2mm 0; text-align: center; page-break-inside: avoid; }
.answer-figure img { max-width: 100%; max-height: 120mm; border: 0.3mm solid #d8d2c4; border-radius: 1mm; background: #fff; }
.answer-figure figcaption { margin-top: 1mm; font-size: 8.5pt; color: var(--muted); }
.statement { font-family: var(--serif); font-size: 10.5pt; }
.statement p, .answer p { margin: 1.5mm 0; }
.statement ul, .answer ul, .statement ol, .answer ol { margin: 1.5mm 0; padding-left: 6mm; }
.statement li, .answer li { margin: 0.8mm 0; }
.statement h1, .statement h2, .statement h3,
.answer h1, .answer h2, .answer h3 { margin: 3mm 0 1.5mm; font-size: 11.5pt; }

.note {
  margin-top: 2.5mm;
  padding-top: 1.5mm;
  border-top: 1px dashed var(--line);
  color: var(--muted);
  font-size: 9pt;
}

.note-label { margin-right: 1.5mm; font-weight: 600; }
.note p { margin: 0.8mm 0; }

.muted { color: var(--muted); font-style: italic; }

/* === 判卷徽章（仅内部草稿；打印时隐藏，见 @media print） === */

.verdict {
  padding: 0.3mm 2mm;
  border-radius: 3mm;
  font-size: 8.5pt;
  font-weight: 600;
  white-space: nowrap;
}

.verdict--correct { background: #e6f4ea; color: #1e6b34; }
.verdict--partial { background: #fdf3dc; color: #7a5b0b; }
.verdict--wrong   { background: #fbe9e7; color: #8c2b22; }
.verdict--unclear { background: #eef0f2; color: #4a4f55; }
.verdict--error   { background: #f0e6f7; color: #5b2d7a; }

/* === 公式 ===
   渲染过的公式由 KaTeX 自己的 CSS 负责排版（inlineCss 注入，排在本文之后，
   因此可以覆盖这里的规则）；只有"没接渲染器"时的源码回退是等宽。 */

.math-fallback {
  font-family: var(--mono);
  font-size: 0.95em;
  padding: 0 0.5mm;
  overflow-wrap: anywhere;
}

.math.display {
  display: block;
  margin: 2.5mm 0;
  text-align: center;
  /* ⚠️ 不要给这里加横向滚动：那会让浏览器画出一根滚动条，
     而滚动条的 ▲▼ 按钮在打印/PDF 里也会被印出来（真机 2026-10-24：公式右侧出现 ▲▼）。
     超宽公式宁可略微溢出，也不要让纸上多出这些符号。 */
  overflow: visible;
  max-width: 100%;
}

/* KaTeX display 自带 margin，这里压掉一层，避免和 .math.display 叠加 */
.math.display .katex-display { margin: 0; }

/* === 经验（最后一页） === */

.lessons { margin-top: 6mm; }
.lessons h2 { font-size: 14pt; margin: 0 0 2mm; }
.lessons ul { margin: 0; padding-left: 5mm; }
.lessons li { margin: 1.2mm 0; font-family: var(--serif); font-size: 10.5pt; }

/* === 页脚 ===
   页脚/页码全部交给 @page 的 margin box（见上方 @page 块里的实测说明）。
   这里**没有** position:fixed 的页脚 div：实测它会错位到页顶并压住标题。 */

@media print {
  html { background: #fff; }

  body {
    max-width: none;
    margin: 0;
    padding: 0;
    box-shadow: none;
  }

  /* 内部判卷结果绝不进提交件 */
  .verdict { display: none; }

  .problem {
    margin: 0 0 7mm;
    padding: 0;
    border: 0;
    border-radius: 0;
  }

  .problem-head { border-bottom: 1px solid var(--line); padding-bottom: 2mm; }

  /* 长解答单独起页：短答案挤在一起省纸，长答案不拆开看 */
  .problem.break-before {
    break-before: page;
    page-break-before: always;
  }

  .lessons {
    break-before: page;
    page-break-before: always;
  }
}
`;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}


function formatPoints(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * 内联 CSS 的防逃逸处理。
 *
 * host 注入的是受信任的 KaTeX CSS，但它可能包含 `</style>`（例如 content: "…"）
 * 从而提前闭合 <style>，把后面的 HTML 当成文本/标签解析。
 * CSS 里 `<\/style` 在字符串中合法、在选择器里本就不成立，替换是安全的最小防护。
 */
function guardInlineCss(css: string): string {
  return String(css ?? '').replace(/<\/style/gi, '<\\/style');
}

// ============================================================
// 主函数
// ============================================================

export function buildSubmissionHtml(input: SubmissionHtmlInput): string {
  const lang: 'de' | 'zh' = input.lang === 'zh' ? 'zh' : 'de';
  const t = LABELS[lang];
  const renderMath = input.renderMath;
  const inlineCss = typeof input.inlineCss === 'string' && input.inlineCss.trim() !== ''
    ? guardInlineCss(input.inlineCss)
    : '';

  const courseTitle = String(input.courseTitle ?? '');
  const courseId = String(input.courseId ?? '');
  const sheet = input.sheet ?? { id: '', number: 0, title: '', issued: '', due: '' };
  const sheetNumber = Number.isFinite(Number(sheet.number)) ? Number(sheet.number) : 0;
  const problems = Array.isArray(input.problems) ? input.problems : [];
  const lessons = (Array.isArray(input.lessons) ? input.lessons : [])
    .map((l) => String(l ?? '').trim())
    .filter((l) => l.length > 0);

  // 学生姓名：空 → 留一条下划线让打印后手写（用下划线而不是 CSS border：
  // 任何打印引擎、任何字体下都稳定显示）。
  const nameRaw = String(input.studentName ?? '').trim();
  const nameHtml = nameRaw
    ? `<span class="name-value">${escapeHtml(nameRaw)}</span>`
    : '<span class="name-value">______________</span>';

  const problemHtml = problems.map((p, i) => {
    const labelRaw = String(p.label ?? '').trim();
    const label = labelRaw || `${t.problem} ${i + 1}`;
    const titleRaw = String(p.title ?? '').trim();
    const textSrc = String(p.text ?? '');
    const answerSrc = String(p.answer ?? '');

    // 长解答才单独起页；且第一题不起页（否则封面后立刻空一页）
    const longAnswer = answerSrc.trim().length > LONG_ANSWER_CHARS;
    const cls = longAnswer && i > 0 ? 'problem break-before' : 'problem';

    const points =
      typeof p.points === 'number' && Number.isFinite(p.points)
        ? `<span class="points">${escapeHtml(formatPoints(p.points))} ${t.points}</span>`
        : '';

    // verdict 来自运行期数据（可能是旧 JSON），白名单一次再拼 class，
    // 避免任意字符串进 class 属性。
    const verdictKey = VERDICTS.find((v) => v === p.verdict);
    const verdict = verdictKey
      ? `<span class="verdict verdict--${verdictKey}">${t.verdicts[verdictKey]}</span>`
      : '';

    const statement = renderFragment(textSrc, renderMath) || `<p class="muted">${t.noText}</p>`;
    const answer = renderFragment(answerSrc, renderMath) || `<p class="muted">${t.noAnswer}</p>`;
    // 题干截图（极简模式上传的题目图片）：印在题目下面
    const statementPics = (p.statementImages ?? [])
      .map(
        (img) =>
          `<figure class="answer-figure statement-figure"><img src="${img.dataUri}" alt="${escapeHtml(img.caption || img.name)}" />` +
          (img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : '') +
          `</figure>`,
      )
      .join('\n');
    // 答案附图（手画示意图）：data URI 内联，PDF 生成走 file:// 也能显示
    const pics = (p.images ?? [])
      .map(
        (img) =>
          `<figure class="answer-figure"><img src="${img.dataUri}" alt="${escapeHtml(img.caption || img.name)}" />` +
          (img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : '') +
          `</figure>`,
      )
      .join('\n');
    const noteRaw = String(p.note ?? '');
    const note = noteRaw.trim()
      ? `<div class="note"><span class="note-label">${t.note}</span>${renderFragment(noteRaw, renderMath)}</div>`
      : '';

    return [
      `<article class="${cls}" data-label="${escapeHtml(label)}">`,
      '<div class="problem-head">',
      '<div class="problem-meta">',
      `<span class="label">${escapeHtml(label)}</span>`,
      points,
      verdict,
      '</div>',
      // 标题里也可能有公式（LLM 生成的标题常带 `$m$`）→ 走行内渲染，别原样印 `$m$`
      titleRaw ? `<h2 class="problem-title">${inlineToHtml(escapeHtml(titleRaw), renderMath)}</h2>` : '',
      '</div>',
      `<div class="statement">${statement}${statementPics}</div>`,
      '<div class="answer">',
      `<h3 class="answer-head">${t.answer}</h3>`,
      answer,
      pics,
      '</div>',
      note,
      '</article>',
    ]
      .filter((s) => s !== '')
      .join('\n');
  });

  const lessonsHtml = lessons.length
    ? [
        '<section class="lessons">',
        `<h2>${t.lessons}</h2>`,
        '<ul>',
        ...lessons.map((l) => `<li>${inlineToHtml(escapeHtml(normalizeSource(l)), renderMath)}</li>`),
        '</ul>',
        '</section>',
      ].join('\n')
    : '';

  const sheetTitle = String(sheet.title ?? '').trim();
  const docTitle = `${courseTitle || t.sheet} · ${t.sheet} ${sheetNumber}`;

  // 德语作业的标题就是 "Übungsblatt 3"；中文界面下用 "第 N 次作业"（见 LABELS）。
  const heading = lang === 'zh' ? `${t.sheet} ${sheetNumber} 次作业` : `${t.sheet} ${sheetNumber}`;
  const langAttr = lang === 'zh' ? 'zh-CN' : 'de';

  const styleBlock = inlineCss ? `<style>\n${PRINT_CSS}\n${inlineCss}\n</style>` : `<style>${PRINT_CSS}</style>`;

  return [
    '<!DOCTYPE html>',
    `<html lang="${langAttr}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(docTitle)}</title>`,
    styleBlock,
    '</head>',
    '<body>',
    '<header class="sheet-header">',
    '<div class="course-row">',
    `<span class="course">${escapeHtml(courseTitle)}</span>`,
    `<span class="course-id">${escapeHtml(courseId)}</span>`,
    '</div>',
    `<h1 class="sheet-heading">${escapeHtml(heading)}</h1>`,
    sheetTitle ? `<div class="sheet-sub">${inlineToHtml(escapeHtml(sheetTitle), renderMath)}</div>` : '',
    '<div class="dates">',
    `<span><span class="k">${t.issued}:</span>${escapeHtml(String(sheet.issued ?? ''))}</span>`,
    `<span><span class="k">${t.due}:</span>${escapeHtml(String(sheet.due ?? ''))}</span>`,
    '</div>',
    `<div class="student"><span class="k">${t.name}:</span> ${nameHtml}</div>`,
    '</header>',
    '<main class="problems">',
    ...problemHtml,
    '</main>',
    lessonsHtml,
    '</body>',
    '</html>',
  ]
    .filter((s) => s !== '')
    .join('\n');
}
