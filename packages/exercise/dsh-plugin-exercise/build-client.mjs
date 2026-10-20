// ============================================================
// build-client.mjs — dsh-plugin-exercise 的 browser 半区构建
//
// 产出 lib/client.js（window.__ModuleLoader__.load 格式），与 dsh-plugin-ui /
// dsh-plugin-lecture 的 build.mjs 同款做法：esbuild + cjs + banner/footer 包装。
// 外部依赖（react / @deepseek-ai/*）由浏览器 module 表在运行时解析。
//
// ⚠️ 与 lecture 的差异：本 Bundle 也把 mathlive 打进 client.js 吗？
//    不。mathlive 走**动态 import**（见 client/math.tsx），由 esbuild 单独
//    切一个 chunk 反而不稳（ModuleLoader 只认单文件 factory），
//    所以 mathlive 被 esbuild 静态内联进 client.js —— 与 lecture 一致。
//    公式渲染器只在真有 `$...$` 时才被调用，但包体确实变大（~800KB）。
//    这是既有约定（lecture 也是这么做的），保持一致。
// ============================================================
import { build } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf-8'));
const ID = pkg.name;

const external = ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'];
const outPath = join(here, 'lib/client.js');

try {
  await build({
    entryPoints: [join(here, 'src/client/index.tsx')],
    outfile: outPath,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
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
  console.log(`[dsh-plugin-exercise] client bundle 已产出: lib/client.js (${ID})`);
} catch (e) {
  const msg = e && e.message ? String(e.message) : String(e);
  const isSandboxSpawnBlock = /(esbuild.*spawn|spawn.*(esbuild|EPERM|EACCES)|could not spawn)/i.test(msg);
  const strict = !!process.env.CI || process.env.AEMEATH_BUILD_STRICT === '1';
  if (existsSync(outPath) && isSandboxSpawnBlock && !strict) {
    console.warn(
      `[dsh-plugin-exercise] ⚠ esbuild 不可用（${msg.slice(0, 80)}…），保留既有 bundle。\n` +
        `[dsh-plugin-exercise] ⚠ 注意：lib/client.js **未更新**，前端改动不会生效。`,
    );
  } else {
    console.error('[dsh-plugin-exercise] esbuild 构建失败:');
    throw e;
  }
}
