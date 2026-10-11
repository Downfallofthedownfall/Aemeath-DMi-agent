// ============================================================
// build-client.mjs — dsh-plugin-lecture 的 browser 半区构建
//
// 产出 lib/client.js（window.__ModuleLoader__.load 格式）。
// 与 dsh-plugin-ui/build.mjs 同款做法：esbuild + cjs + banner/footer 包装。
// 外部依赖（react / @deepseek-ai/*）由浏览器 module 表在运行时解析。
//
// 为什么单独一个 mjs 而不复用 ui 的：两个包各自独立打包，
// 互不依赖（lecture 的 UI 属于 lecture 自己，D1/D2：不深度嵌入）。
// ============================================================
import { build } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf-8'));
const ID = pkg.name;

// react-dom/* 必须显式列：独立窗口用 createRoot（react-dom/client），
// 若被打进 bundle 会与宿主的 react 实例冲突（hooks 报错）。
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
  console.log(`[dsh-plugin-lecture] client bundle 已产出: lib/client.js (${ID})`);
} catch (e) {
  const msg = e && e.message ? String(e.message) : String(e);
  const isSandboxSpawnBlock = /(esbuild.*spawn|spawn.*(esbuild|EPERM|EACCES)|could not spawn)/i.test(msg);
  // ⚠️ 沙箱里 esbuild 起不来时，"保留旧 bundle"只是**本地开发**的便利，
  //    绝不能静默：CI 里那会构建失败却退出 0，产出的 lib/client.js 是旧的
  //    （前端改动看似"没生效"，实际是根本没构建）。
  //    所以：CI / 显式要求严格时一律抛错；本地才降级为警告，且必须显著提示。
  const strict = !!process.env.CI || process.env.AEMEATH_BUILD_STRICT === '1';
  if (existsSync(outPath) && isSandboxSpawnBlock && !strict) {
    console.warn(
      `[dsh-plugin-lecture] ⚠ esbuild 不可用（${msg.slice(0, 80)}…），保留既有 bundle。\n` +
        `[dsh-plugin-lecture] ⚠ 注意：lib/client.js **未更新**，前端改动不会生效。\n` +
        `[dsh-plugin-lecture] ⚠ 如需强制构建失败（CI 行为），设 CI=1 或 AEMEATH_BUILD_STRICT=1。`,
    );
  } else {
    console.error('[dsh-plugin-lecture] esbuild 构建失败:');
    if (existsSync(outPath) && strict) {
      console.error('[dsh-plugin-lecture] （严格模式：即使存在旧 bundle 也判定失败）');
    }
    throw e;
  }
}
