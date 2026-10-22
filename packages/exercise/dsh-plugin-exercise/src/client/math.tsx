// ============================================================
// client/math.tsx — 题面/答案的渲染（轻量 markdown + KaTeX 公式）
//
// 为什么和 lecture 不一样（lecture 用 MathLive）：
//   习题的产物要进**提交 PDF**，而 PDF 是服务端用 KaTeX 渲染的（pdf-math.ts）。
//   界面用 KaTeX 才能"预览即所得"。
//
// 切分逻辑全在 `src/math-parse.ts`（纯函数、可单测）；
// 这里只把片段变成 JSX。**用户文本永远走 React 文本节点**，
// 只有 KaTeX 自己生成的受控标记才 `dangerouslySetInnerHTML`。
// ============================================================

import { useMemo } from 'react';
import katex from 'katex';
import { normalizeMathLive } from '../mathlive-compat.ts';
import {
  buildRenderBlocks,
  hasMath,
  parseInlineTokens,
  type RenderBlock,
  type Segment,
} from '../math-parse.ts';

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

/**
 * 渲染一段 LaTeX（失败 → 可读源码 + 一行原因，绝不丢内容）。
 *
 * 用户反馈（2026-10-22）："有时候会变成红色的字不渲染latex" —— KaTeX 的
 * 旧写法 `throwOnError:false` 会把错误画成**红字塞进公式内部**（`\frac` 的分母被撑坏），
 * 看着像排版坏了还不知道为什么。
 * 现在：先严格渲染，失败就把**源码原样显示**（等宽、虚线下划线、悬停看原因），
 * 并在编辑器的提示区列出是哪个命令不认识 —— 既不会"悄悄渲染"，也不会一片红。
 */
export function renderTex(tex: string, display: boolean): string {
  const src = normalizeMathLive(tex).tex;
  try {
    return katex.renderToString(src, {
      displayMode: display,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
    });
  } catch (e) {
    const reason = (e as Error).message.replace(/^KaTeX parse error:\s*/i, '').slice(0, 200);
    const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const title = reason.replace(/"/g, '&quot;');
    return `<code class="ex-math-error" title="${title}">${esc}</code>`;
  }
}

function MathNode({ tex, display }: { tex: string; display: boolean }): JSX.Element {
  const html = useMemo(() => renderTex(tex, display), [tex, display]);
  if (display) return <div className="ex-math-display" dangerouslySetInnerHTML={{ __html: html }} />;
  return <span className="ex-math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 行内片段 → React 节点（公式 + 粗体/斜体/代码）。 */
function renderInline(segments: Segment[]): JSX.Element[] {
  const out: JSX.Element[] = [];
  let key = 0;
  for (const seg of segments) {
    if (seg.kind === 'math') {
      out.push(<MathNode key={`m${key++}`} tex={seg.tex} display={seg.display} />);
      continue;
    }
    for (const tok of parseInlineTokens(seg.text)) {
      if (tok.kind === 'text') out.push(<span key={`t${key++}`}>{tok.text}</span>);
      else if (tok.kind === 'bold') out.push(<strong key={`b${key++}`}>{tok.text}</strong>);
      else if (tok.kind === 'code') out.push(<code key={`c${key++}`}>{tok.text}</code>);
      else out.push(<em key={`i${key++}`}>{tok.text}</em>);
    }
  }
  return out;
}

function renderBlock(b: RenderBlock, idx: number): JSX.Element {
  if (b.kind === 'math') return <MathNode key={idx} tex={b.tex ?? ''} display={b.display !== false} />;
  if (b.kind === 'heading') {
    const Tag = `h${Math.min(6, (b.level ?? 1) + 2)}` as 'h3' | 'h4' | 'h5' | 'h6';
    return <Tag key={idx}>{renderInline(b.segments ?? [])}</Tag>;
  }
  if (b.kind === 'li') {
    return (
      <div key={idx} className="ex-md-li">
        <span className="ex-md-dot">·</span>
        <span>{renderInline(b.segments ?? [])}</span>
      </div>
    );
  }
  if (b.kind === 'code') {
    return (
      <pre key={idx} className="ex-md-code">
        {b.segments?.[0]?.kind === 'text' ? b.segments[0].text : ''}
      </pre>
    );
  }
  if (b.whitespace) return <div key={idx} className="ex-md-gap" />;
  return (
    <div key={idx} className="ex-md-p">
      {renderInline(b.segments ?? [])}
    </div>
  );
}

/**
 * 渲染一段 markdown + 公式。
 * `compact` 用于题面（行距更紧）；答案区用默认。
 */
export function MathText({ text, compact = false }: { text: string; compact?: boolean }): JSX.Element {
  if (hasMath(text)) ensureMathCss();
  const blocks = useMemo(() => buildRenderBlocks(text), [text]);
  return <div className={compact ? 'ex-md ex-md-compact' : 'ex-md'}>{blocks.map(renderBlock)}</div>;
}
