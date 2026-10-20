// ============================================================
// client/math-markup.tsx — 笔记渲染：轻量 markdown + 行内公式
//
// 为什么要有这个文件（真机截图）：
//   用户记的笔记里出现的是
//       \sum_{i=1}^{n}\alpha_{i}\vec{a_{i}}=\alpha_1 a_1+\ldots=0
//   —— 原样 LaTeX，因为显示区是 `<pre>{raw}</pre>`，什么都不渲染。
//   公式模式记下来的东西**在界面上根本没法读**。
//
// 设计（用户定案）：
//   · 存储用 **markdown**（`文字 $公式$ 混排`）
//     —— 人类可读、LLM 可读（转录员要读它）、handoff 友好、跨版本存活
//   · 渲染用 MathLive 的 `convertLatexToMarkup`
//     —— **不引入新依赖**（mathlive 已经是本插件的依赖）
//   · 懒加载：没有 `$` 的笔记**完全不加载** mathlive（823KB）
//
// 为什么不自己拼 HTML 再 innerHTML 整篇：
//   那会把用户文本当 HTML 解析 → XSS + 格式错乱。
//   这里 markdown → **React 元素**，只有公式那一小段用 MathLive 的
//   输出（那是它自己生成的受控标记）。
// ============================================================
import { useEffect, useMemo, useState } from 'react';

/** 懒加载 MathLive 的静态渲染器（只加载一次）。 */
let rendererPromise: Promise<{ convertLatexToMarkup: (l: string) => string } | null> | null = null;

async function loadRenderer(): Promise<{ convertLatexToMarkup: (l: string) => string } | null> {
  if (rendererPromise) return rendererPromise;
  rendererPromise = (async () => {
    try {
      const mod = (await import('mathlive')) as {
        convertLatexToMarkup?: (l: string) => string;
      };
      return typeof mod.convertLatexToMarkup === 'function'
        ? { convertLatexToMarkup: mod.convertLatexToMarkup }
        : null;
    } catch {
      return null;
    }
  })();
  return rendererPromise;
}

/** 文本里有没有行内公式（决定要不要加载 mathlive）。 */
export function hasMath(text: string): boolean {
  // `$...$`，且 `$` 后面紧跟非空白（避免把 "价格 $5 到 $10" 误判）
  if (/\$(?!\s)[^$\n]+?\$/.test(text)) return true;
  // 旧数据：整行就是裸 LaTeX（见 looksLikeBareLatex）
  return text.split('\n').some((l) => looksLikeBareLatex(l));
}

/**
 * 这一行是不是**裸 LaTeX**（旧数据兼容）。
 *
 * 背景（真机截图）：早先"公式模式"把 LaTeX 源码直接落盘，
 * 存的是 `\sum_{i=1}^{n}\alpha_{i}\vec{a_{i}}=...` 这种，
 * 没有 `$` 定界符。用户当时就抱怨"速记框不渲染"。
 *
 * 判据刻意从严，只认**真 LaTeX 命令**：
 *   · 必须出现反斜杠 + **至少两个字母**（`\sum` `\alpha` `\int` `\vec`）
 *     —— 单个字母的 `\n` 之类不会被误判
 *   · 整行不含 `$`（有 `$` 就走正常行内公式路径）
 *   · 不以中文/常见标点开头（那是正常笔记）
 *
 * 不满足就按普通文本渲染 —— 宁可少渲染，也不要把正常文本搞乱。
 */
export function looksLikeBareLatex(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.includes('$')) return false;
  // 至少两个字母的 LaTeX 命令
  if (!/\\[a-zA-Z]{2,}/.test(t)) return false;
  // 含中文的行通常是正常笔记（中文 + 偶尔的反斜杠不该整行当公式）
  if (/[\u4e00-\u9fff]/.test(t)) return false;
  return true;
}

/**
 * 把 LaTeX 里的**编辑期占位符**去掉再显示。
 *
 * `\placeholder{}` 是 MathLive 编辑态的空框标记（用来让上下限"可填"）。
 * 落到笔记里显示时它只是个空框，没有意义 —— 但也不能直接删，
 * 否则 `\int_{}^{}` 会退化成没有上下限的样子。
 * 用一个细空格占位，保持结构。
 */
function displayLatex(latex: string): string {
  return latex.replace(/\\placeholder\{\}/g, '\\,');
}

/**
 * 注入 MathLive 的静态样式表（**只注入一次**）。
 *
 * ⚠️ 为什么必须注入（真机截图）：
 *    `convertLatexToMarkup()` 只产出 HTML 标记（`ML__*` 类名），
 *    样式和字体要另外加载。不加载的话字形缺失 ——
 *    `\neq` 会渲染成**豆腐块 □**（字体里没有那个字形）。
 *
 * 为什么用 `<link>` 而不是把 CSS 打进 bundle：
 *    CSS 里引用了 20 个 woff2（共 254KB），走 link 时浏览器按需请求并缓存；
 *    打进 bundle 则变成无条件 base64。
 */
const ASSETS_BASE = '/aemeath/api/lecture/assets';
let cssInjected = false;

function ensureMathCss(): void {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const id = 'aemeath-mathlive-static-css';
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `${ASSETS_BASE}/mathlive-static.css`;
  document.head.appendChild(link);
}

/** 单个行内公式。加载完成前显示原文，避免闪烁成空白。 */
function InlineMath({ latex }: { latex: string }): JSX.Element {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    ensureMathCss();
    void loadRenderer().then((r) => {
      if (!alive) return;
      if (!r) {
        setFailed(true);
        return;
      }
      try {
        setHtml(r.convertLatexToMarkup(displayLatex(latex)));
      } catch {
        setFailed(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [latex]);

  if (failed) {
    // 渲染器不可用：退回显示源码（至少能看清写了什么）
    return (
      <code className="lec-math-src" title="公式渲染器不可用">
        {latex}
      </code>
    );
  }
  if (html === null) {
    // 还没加载完：先显示源码，等渲染出来再换（不闪空白）
    return <code className="lec-math-src">{latex.replace(/\\/g, '')}</code>;
  }
  return (
    <span
      className="lec-math-inline"
      // MathLive 的 convertLatexToMarkup 输出的是它自己生成的受控标记；
      // 用户文本绝不走这里（见文件头的说明）。
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * 行内解析：`**粗体**`、`*斜体*`、`` `代码` ``、`$公式$`。
 *
 * 只做课堂笔记真正用得到的几种；不做链接/图片（上课不会边记边插链接，
 * 而且链接需要 URL 校验，收益不值这个风险）。
 */
function parseInline(text: string): Array<string | JSX.Element> {
  const out: Array<string | JSX.Element> = [];
  // 一次扫描，按出现顺序切分；比多次 replace 更不容易互相破坏
  const re = /(\$[^$\n]+?\$)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`\n]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('$')) {
      out.push(<InlineMath key={`m${key++}`} latex={tok.slice(1, -1)} />);
    } else if (tok.startsWith('**')) {
      out.push(<strong key={`b${key++}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`')) {
      out.push(<code key={`c${key++}`}>{tok.slice(1, -1)}</code>);
    } else {
      out.push(<em key={`i${key++}`}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 块类型判定。 */
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'li'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'p'; text: string };

/**
 * 极简块级解析。
 *
 * 只支持：`#`~`######` 标题、`-`/`*` 列表、``` 围栏代码、其余当段落。
 * 段落内**保留换行**（`white-space: pre-wrap`）—— 课堂速记里换行有意义，
 * 不能像标准 markdown 那样把单换行合并成空格。
 */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // 围栏代码块
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // 跳过结束围栏
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      blocks.push({ kind: 'li', text: li[1]! });
      i++;
      continue;
    }
    blocks.push({ kind: 'p', text: line });
    i++;
  }
  return blocks;
}

/**
 * 渲染一段课堂笔记（markdown + 行内公式）。
 *
 * 兼容旧数据：旧块是"纯文本 + 原样 LaTeX"，而纯文本本来就是合法 markdown；
 * 里面若是 `\int_{}` 这种**不带 `$` 的裸 LaTeX**，会按原文显示 ——
 * 这是刻意的：不猜哪些反斜杠序列是公式（猜错会把正常文本搞乱）。
 * 用户想让它变成公式，把那段包进 `$...$` 即可。
 */
export function MathMarkup({ text }: { text: string }): JSX.Element {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="lec-md">
      {blocks.map((b, idx) => {
        if (b.kind === 'heading') {
          // 标题层级压缩到 h3~h6（笔记卡片里不需要 h1 那么大）
          const Tag = (`h${Math.min(6, b.level + 2)}`) as 'h3' | 'h4' | 'h5' | 'h6';
          return <Tag key={idx}>{parseInline(b.text)}</Tag>;
        }
        if (b.kind === 'li') {
          return (
            <div key={idx} className="lec-md-li">
              <span className="lec-md-dot">·</span>
              <span>{parseInline(b.text)}</span>
            </div>
          );
        }
        if (b.kind === 'code') {
          return (
            <pre key={idx} className="lec-md-code">
              {b.text}
            </pre>
          );
        }
        // 空行保留（段落间距）
        if (!b.text.trim()) return <div key={idx} className="lec-md-gap" />;
        // 旧数据兼容：整行就是裸 LaTeX → 整行当公式渲染
        //（用户当时的原话就是"速记框不渲染"，这些老块必须能看）
        if (looksLikeBareLatex(b.text)) {
          return (
            <div key={idx} className="lec-md-p">
              <InlineMath latex={b.text.trim()} />
            </div>
          );
        }
        return <div key={idx} className="lec-md-p">{parseInline(b.text)}</div>;
      })}
    </div>
  );
}
