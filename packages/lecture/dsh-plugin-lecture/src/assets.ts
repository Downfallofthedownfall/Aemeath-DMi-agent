// ============================================================
// assets.ts — 提供 MathLive 的静态资源（CSS + 字体）
//
// 为什么需要这个（真机截图）：
//   `convertLatexToMarkup()` 只产出 HTML 标记（`ML__*` 类名），
//   样式和字体要另外加载。不加载的话字形缺失，`\neq` 会渲染成豆腐块 □。
//
// 为什么要走 HTTP 而不是把资源打进 bundle：
//   字体 20 个 woff2 共 254KB；base64 进 bundle 会让所有页面
//   无条件多下载 ~340KB。走路由则**只有真的在渲染公式时**才请求，
//   而且浏览器会缓存。
//
// 路由形状（一条 prefix 覆盖全部）：
//   GET /aemeath/api/lecture/assets/mathlive-static.css
//   GET /aemeath/api/lecture/assets/fonts/<name>.woff2
//
//   CSS 里的 `url(fonts/KaTeX_*.woff2)` 是**相对路径**，
//   相对 CSS 自身 URL 解析后正好落到 `/assets/fonts/...` ——
//   所以不需要改写 CSS 内容。
// ============================================================
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 挂载点（与前端常量一致）。 */
export const ASSETS_PREFIX = '/aemeath/api/lecture/assets';

/**
 * 定位 mathlive 包目录。
 *
 * 为什么用 createRequire 而不是 `join(process.cwd(), 'node_modules/mathlive')`：
 * 工作目录不一定是仓库根（dsh 可能从别处启动），写死 cwd 会找不到。
 * createRequire 按 Node 的解析规则走，和运行时实际加载的是同一个包。
 */
function mathliveDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve('mathlive'));
  } catch {
    return null;
  }
}

/** 允许提供的文件（白名单，杜绝路径穿越与乱读文件）。 */
const ALLOWED = new Map<string, { file: string; type: string }>([
  [
    'mathlive-static.css',
    { file: 'mathlive-static.css', type: 'text/css; charset=utf-8' },
  ],
]);

const FONT_RE = /^fonts\/(KaTeX_[A-Za-z0-9-]+\.woff2)$/;

/**
 * 处理一个资产请求。
 *
 * @returns true 表示已处理（调用方不必再看别的路由）
 */
export function serveAsset(req: IncomingMessage, res: ServerResponse, url: string): boolean {
  // 取 prefix 之后的部分（去掉 query）
  const pathname = url.split('?')[0] ?? '';
  if (!pathname.startsWith(ASSETS_PREFIX)) return false;
  const rel = decodeURIComponent(pathname.slice(ASSETS_PREFIX.length)).replace(/^\/+/, '');
  if (!rel) {
    res.writeHead(404).end('not found');
    return true;
  }

  const dir = mathliveDir();
  if (!dir) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('mathlive not installed');
    return true;
  }

  // 1) 白名单里的固定文件
  const fixed = ALLOWED.get(rel);
  if (fixed) {
    const p = join(dir, fixed.file);
    if (!existsSync(p)) {
      res.writeHead(404).end('not found');
      return true;
    }
    const body = readFileSync(p);
    res.writeHead(200, {
      'Content-Type': fixed.type,
      // CSS 会被经常更新（跟随包版本），缓存短一点
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return true;
  }

  // 2) 字体：只允许 fonts/ 下的 KaTeX_*.woff2
  const fm = rel.match(FONT_RE);
  if (fm) {
    // basename 再兜一层（正则已限制字符集，这里只是防御性）
    const name = basename(fm[1]!);
    const p = join(dir, 'fonts', name);
    if (!existsSync(p)) {
      res.writeHead(404).end('not found');
      return true;
    }
    const body = readFileSync(p);
    res.writeHead(200, {
      'Content-Type': 'font/woff2',
      // 字体随包版本固定，可以长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return true;
  }

  res.writeHead(404).end('not found');
  return true;
}
