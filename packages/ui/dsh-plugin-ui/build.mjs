// ============================================================
// build.mjs — dsh-plugin-ui 构建脚本（M5）
// 产出：
//   lib/client.js  — browser 半区 bundle（window.__ModuleLoader__.load 格式）
//   lib/index.js   — host 半区（tsc 编译，见 tsconfig）
// 打包器：esbuild（format=cjs + banner/footer 包装 __ModuleLoader__.load）
// 外部依赖：react / @deepseek-ai/dsh-client-*（运行时从浏览器 module 表解析，
//           跨插件 value import 是构建错误 → 一律 external）
// ============================================================
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf-8'));
const ID = pkg.name;

/** 外部依赖：react / react-dom + dsh client 包（浏览器 module 表提供）。 */
const external = [
  'react',
  'react/*',
  'react-dom',
  '@deepseek-ai/*',
];

const outPath = join(here, 'lib/client.js');

try {
  await build({
    entryPoints: [join(here, 'src/client/index.ts')],
    outfile: outPath,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    // C16：AbortSignal.timeout 等 ES2022 API——target 与 client lib(ES2022) 对齐
    target: ['es2022'],
    jsx: 'automatic',
    external,
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
    },
    footer: {
      js: `return module.exports;
} });`,
    },
    sourcemap: false,
    logLevel: 'info',
  });
  console.log(`[dsh-plugin-ui] client bundle 已产出: lib/client.js (${ID})`);
} catch (e) {
  // C4 修复：只吞「沙箱下 esbuild 服务进程 spawn 被 EPERM 拒」这一种情况
  //（有既有产物时保留；用户需以完整权限重跑 build.mjs 重新打包）。
  // 其他任何 esbuild 失败（语法错误/构建错误等）一律重抛，绝不带过期 bundle 静默出货。
  const { existsSync } = await import('node:fs');
  const msg = e && e.message ? String(e.message) : String(e);
  const isSandboxSpawnBlock = /spawn.*EPERM|EPERM|EACCES|operation not permitted/i.test(msg);
  if (existsSync(outPath) && isSandboxSpawnBlock) {
    console.warn(`[dsh-plugin-ui] ⚠ esbuild 在当前权限下不可用（${msg.slice(0, 80)}…），保留既有 client bundle（完整权限重跑 build.mjs 重新打包）`);
  } else {
    console.error('[dsh-plugin-ui] esbuild 构建失败:');
    throw e;
  }
}
