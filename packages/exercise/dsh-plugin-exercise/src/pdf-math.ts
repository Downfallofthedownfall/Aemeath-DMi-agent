// ============================================================
// pdf-math.ts — 服务端 LaTeX 渲染（KaTeX）+ 可内联的样式表
//
// 为什么用 KaTeX 而不是 MathLive（lecture 用的是 MathLive）：
//   · 提交 PDF 的页面必须能**离线打开**：dsh 的 Web 有认证 cookie，
//     headless Chromium 拿不到 → 走 file:// 才稳；file:// 下再去 HTTP
//     取 MathLive 的 JS/CSS 必然 401
//   · KaTeX 能在 **Node 里直接 renderToString**：HTML 生成时公式就已经是
//     静态标记，打印时**不需要执行任何 JS**（不依赖 virtual-time 等待）
//   · 字体可以打包成 base64 内联进 CSS → 单个 HTML 文件自包含
//
// 前端界面也统一用 KaTeX（见 client/math.tsx）：预览与 PDF 的排版完全一致，
// 不会出现"界面上是一个样、打印出来另一个样"。
// ============================================================

import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import katex from 'katex';
import { normalizeMathLive } from './mathlive-compat.js';

let katexDirCache: string | null | undefined;

/** katex 包目录（按 Node 解析规则找，不写死 cwd）。 */
function katexDir(): string | null {
  if (katexDirCache !== undefined) return katexDirCache;
  try {
    const req = createRequire(import.meta.url);
    katexDirCache = dirname(req.resolve('katex'));
  } catch {
    katexDirCache = null;
  }
  return katexDirCache;
}

/**
 * 渲染一个公式为 HTML。
 *
 * `throwOnError: false` 是刻意的：**用户写错的公式不该让整张提交 PDF 生成失败**。
 * KaTeX 会把它渲染成红字错误提示，用户一看就知道哪一处没写对。
 *
 * 渲染前先过 MathLive 兼容层（`\differentialD` → `\mathrm{d}` 等），
 * 与界面 `client/math.tsx` 用**同一个函数**，保证屏幕与打印一致。
 */
export function renderMathToHtml(tex: string, display: boolean): string {
  const src = normalizeMathLive((tex ?? '').trim()).tex;
  if (!src) return '';
  try {
    return katex.renderToString(src, {
      displayMode: display,
      throwOnError: false,
      errorColor: '#c0392b',
      strict: 'ignore',
      // 不允许 \href/\includegraphics 之类 —— 这是本地文档，没有信任边界问题，
      // 但保持关闭可以避免生成外链请求（打印时不该联网）。
      trust: false,
      output: 'html',
    });
  } catch {
    // 连 KaTeX 都崩（极少）：退化成可读源码，绝不吞掉用户写的内容
    const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code class="math-fallback">${esc}</code>`;
  }
}

/**
 * KaTeX 样式表 + **内联字体**（base64 woff2）。
 *
 * 为什么要内联：提交 PDF 走 file://（见文件头）。若 CSS 里还是
 * `url(fonts/KaTeX_Main-Regular.woff2)`，浏览器会按 file:// 相对路径去找 —— 找不到，
 * 公式就退化成无衬线碎字（`\sum` 的上下限错位）。
 *
 * 为什么先替换 woff2 再兜底 woff/ttf：KaTeX 的 @font-face 里同一字族有
 * `src: url(x.woff2) format('woff2'), url(x.woff) ...` 多条；
 * 只要 woff2 那条变成 data: 就足以命中，剩下的相对路径留着也无害，
 * 但为彻底离线，这里把同一字族的 woff/ttf 也替换成同一份 woff2 数据。
 */
export function katexCssInlined(): string {
  const dir = katexDir();
  if (!dir) return '';
  const cssFile = join(dir, 'dist', 'katex.min.css');
  if (!existsSync(cssFile)) return '';
  let css = readFileSync(cssFile, 'utf-8');

  const fontDir = join(dir, 'dist', 'fonts');
  const cache = new Map<string, string | null>();
  const dataUriOf = (family: string): string | null => {
    if (cache.has(family)) return cache.get(family)!;
    const p = join(fontDir, `${family}.woff2`);
    let uri: string | null = null;
    if (existsSync(p)) {
      try {
        uri = `data:font/woff2;base64,${readFileSync(p).toString('base64')}`;
      } catch {
        uri = null;
      }
    }
    cache.set(family, uri);
    return uri;
  };

  // 1) 收集 CSS 里引用到的全部字体名（.woff2/.woff/.ttf）
  const refs = new Set<string>();
  for (const m of css.matchAll(/url\(fonts\/([A-Za-z0-9_.-]+)\.(?:woff2|woff|ttf)\)/g)) refs.add(m[1]!);

  // 2) 逐字族替换成 woff2 的 data URI（三种扩展名都指向同一份数据）
  for (const family of refs) {
    const uri = dataUriOf(family);
    if (!uri) continue;
    const re = new RegExp(`url\\(fonts/${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?:woff2|woff|ttf)\\)`, 'g');
    css = css.replace(re, `url(${uri})`);
  }

  // 3) 兜底：仍有残留的相对路径（缺字体文件）→ 去掉该 src 条目会破坏语法，
  //    改为指向一份空的 data URI（渲染退回系统字体，但不会 404 拖慢打印）
  css = css.replace(/url\(fonts\/[A-Za-z0-9_.-]+\.(?:woff2|woff|ttf)\)/g, 'url(data:font/woff2;base64,)');
  return css;
}

/**
 * 供 **前端** 用的 KaTeX 资源路径（不内联）。
 *
 * 前端走 HTTP（有 cookie），不需要内联；字体由 assets.ts 的路由提供，
 * 浏览器按需请求并缓存（与 lecture 的 MathLive 做法一致）。
 */
export function katexAssetNames(): { css: string; font: string } {
  return { css: 'katex.min.css', font: 'fonts' };
}

/** 列出可以对外提供的 KaTeX 字体文件名（白名单，防路径穿越）。 */
export function katexFontFiles(): string[] {
  const dir = katexDir();
  if (!dir) return [];
  try {
    const abs = join(dir, 'dist', 'fonts');
    if (!existsSync(abs)) return [];
    return readFileSync(join(abs, '..', 'katex.min.css'), 'utf-8')
      .match(/url\(fonts\/([A-Za-z0-9_.-]+\.(?:woff2|woff|ttf))\)/g)
      ?.map((m) => basename(m.slice(5, -1)))
      .filter((v, i, a) => a.indexOf(v) === i) ?? [];
  } catch {
    return [];
  }
}

/** 读一个字体文件（返回 null = 不在白名单/不存在）。 */
export function readKatexFont(name: string): Buffer | null {
  const dir = katexDir();
  if (!dir) return null;
  const safe = basename(name);
  if (!/^KaTeX_[A-Za-z0-9_-]+\.(woff2|woff|ttf)$/.test(safe)) return null;
  const p = join(dir, 'dist', 'fonts', safe);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
}
