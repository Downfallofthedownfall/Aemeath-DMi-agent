// ============================================================
// client/math.tsx — 题面/答案的渲染（轻量 markdown + KaTeX 公式）
//
// 为什么和 lecture 不一样（lecture 用 MathLive）：
//   习题的产物要进**提交 PDF**，而 PDF 是服务端用 KaTeX 渲染的（pdf-math.ts）。
//   如果界面用 MathLive、PDF 用 KaTeX，同一道题在屏幕上和纸上排版会不一样 ——
//   用户会觉得"我写的公式被打乱了"。统一用 KaTeX，预览即所得。
//
// 为什么用 `dangerouslySetInnerHTML` 只包住公式那一小段：
//   KaTeX 的输出是它自己生成的受控标记；**用户文本永远走 React 文本节点**
//   （转义交给 React），不会把笔记当 HTML 解析。
// ============================================================

import { useMemo } from 'react';
import katex from 'katex';

/** 注入 KaTeX 样式表（只一次；字体由 host 的 assets 路由提供）。 */
let cssInjected = false;
function ensureMathCss(): void {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const id = 'aemeath-exercise-katex-css';
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = '/aemeath/api/exercise/assets/katex.min.css';
  document.head.appendChild(link);
}

/** 渲染一段 LaTeX（失败 → 可读源码，绝不丢内容）。 */
export function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      errorColor: '#c0392b',
      strict: 'ignore',
      trust: false,
    });
  } catch {
    return `<code class="ex-math-fallback">${tex.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`;
  }
}

/** 文本里有没有公式（决定要不要注入 CSS）。 */
export function hasMath(text: string): boolean {
  return /\$(?!\s)[^$\n]+?\$/.test(text) || /\$\$[\s\S]+?\$\$/.test(text);
}

type Inline = string | { tex: string; display: boolean };

/**
 * 行内切分：`$$…$$`（块级）→ `$…$`（行内）→ 其余文本。
 * 顺序很重要：先匹配 `$$`，否则 `$$x$$` 会被切成两个空的 `$…$`。
 */
export function splitMath(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]+?)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index));
    if (m[1] !== undefined) out.push({ tex: m[1], display: true });
    else if (m[2] !== undefined) out.push({ tex: m[2], display: false });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

/** 单个公式节点。 */
function MathNode({ tex, display }: { tex: string; display: boolean }): JSX.Element {
  const html = useMemo(() => renderTex(tex, display), [tex, display]);
  if (display) {
    return <div className="ex-math-display" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <span className="ex-math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 行内：`**粗体**`、`*斜体*`、`` `代码` ``、`$公式$`。 */
function parseInline(text: string): Array<string | JSX.Element> {
  const out: Array<string | JSX.Element> = [];
  let key = 0;
  // 先按公式切，再在每段文本里处理粗体/代码（避免正则互相打架）
  for (const part of splitMath(text)) {
    if (typeof part !== 'string') {
      out.push(part.display ? <MathNode key={`m${key++}`} tex={part.tex} display /> : <MathNode key={`m${key++}`} tex={part.tex} display={false} />);
      continue;
    }
    const re = /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`\n]+`)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(part)) !== null) {
      if (m.index > last) out.push(part.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('**')) out.push(<strong key={`b${key++}`}>{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith('`')) out.push(<code key={`c${key++}`}>{tok.slice(1, -1)}</code>);
      else out.push(<em key={`i${key++}`}>{tok.slice(1, -1)}</em>);
      last = m.index + tok.length;
    }
    if (last < part.length) out.push(part.slice(last));
  }
  return out;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'li'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'p'; text: string };

/** 极简块级解析：标题 / 列表 / 围栏代码 / 段落（段落保留换行）。 */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
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
 * 渲染一段 markdown + 公式。
 * `compact` 用于题面（行距更紧）；答案区用默认。
 */
export function MathText({ text, compact = false }: { text: string; compact?: boolean }): JSX.Element {
  if (hasMath(text)) ensureMathCss();
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={compact ? 'ex-md ex-md-compact' : 'ex-md'}>
      {blocks.map((b, idx) => {
        if (b.kind === 'heading') {
          const Tag = (`h${Math.min(6, b.level + 2)}`) as 'h3' | 'h4' | 'h5' | 'h6';
          return <Tag key={idx}>{parseInline(b.text)}</Tag>;
        }
        if (b.kind === 'li') {
          return (
            <div key={idx} className="ex-md-li">
              <span className="ex-md-dot">·</span>
              <span>{parseInline(b.text)}</span>
            </div>
          );
        }
        if (b.kind === 'code') {
          return (
            <pre key={idx} className="ex-md-code">
              {b.text}
            </pre>
          );
        }
        if (!b.text.trim()) return <div key={idx} className="ex-md-gap" />;
        return (
          <div key={idx} className="ex-md-p">
            {parseInline(b.text)}
          </div>
        );
      })}
    </div>
  );
}
