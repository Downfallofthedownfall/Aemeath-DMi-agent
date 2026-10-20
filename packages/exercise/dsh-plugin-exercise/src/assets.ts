// ============================================================
// assets.ts — 前端用的 KaTeX 静态资源（CSS + 字体）
//
// 与 lecture 的 assets.ts 同款问题与解法：
//   `renderToString` 只产出 HTML（`katex` 类名），样式和字体要另外加载；
//   不加载的话公式会退化成碎字（`\sum` 的上下限错位、`\neq` 变豆腐块）。
//
// 为什么不把 CSS/字体打进 client bundle：
//   字体 20 多个 woff2 共 ~300KB，base64 进 bundle 会让**所有页面**无条件多下载；
//   走路由则只有真在渲染公式时才请求，且浏览器缓存。
//
// 提交 PDF 不走这里（那条路径把 CSS 和字体**内联**进 HTML，见 pdf-math.ts）。
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readKatexFont } from './pdf-math.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** 挂载点（与前端常量一致）。 */
export const ASSETS_PREFIX = '/aemeath/api/exercise/assets';

function katexDistDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return join(dirname(req.resolve('katex')), 'dist');
  } catch {
    return null;
  }
}

/**
 * 处理一个资产请求。
 * @returns true 表示已处理（调用方不必再看别的路由）
 */
export function serveExerciseAsset(req: IncomingMessage, res: ServerResponse, url: string): boolean {
  const pathname = (url.split('?')[0] ?? '');
  if (!pathname.startsWith(ASSETS_PREFIX)) return false;
  const rel = decodeURIComponent(pathname.slice(ASSETS_PREFIX.length)).replace(/^\/+/, '');
  if (!rel) {
    res.writeHead(404).end('not found');
    return true;
  }

  // 1) 样式表
  if (rel === 'katex.min.css') {
    const dir = katexDistDir();
    if (!dir) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('katex not installed');
      return true;
    }
    const p = join(dir, 'katex.min.css');
    if (!existsSync(p)) {
      res.writeHead(404).end('not found');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8',
      // 跟随包版本变化，缓存短一点（与 lecture 的取舍一致）
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(readFileSync(p));
    return true;
  }

  // 2) 字体：只允许白名单里的 KaTeX_*.{woff2,woff,ttf}
  if (rel.startsWith('fonts/')) {
    const name = rel.slice('fonts/'.length);
    const body = readKatexFont(name);
    if (!body) {
      res.writeHead(404).end('not found');
      return true;
    }
    const type = name.endsWith('.woff2')
      ? 'font/woff2'
      : name.endsWith('.woff')
        ? 'font/woff'
        : 'font/ttf';
    res.writeHead(200, {
      'Content-Type': type,
      // 字体随包版本固定 → 长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return true;
  }

  res.writeHead(404).end('not found');
  return true;
}
