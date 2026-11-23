#!/usr/bin/env node
// ============================================================
// scripts/check-deps.mjs — 仓库根 node_modules 是否与 package-lock.json 一致
//
// 为什么需要（真机踩过：mac 上双击课堂/习题启动，打开的却是**标准版 dsh**）：
//   启动脚本早先只在 `node_modules/@deepseek-ai/dsh` **不存在**时才 npm install。
//   `git pull` 拉到"dsh 0.2.1 → 0.2.2"的升级后，node_modules 还是旧的 dsh，
//   而插件的 peerDependencies 已经要求 ^0.2.2-rc.5。
//   dsh 从 0.2.1-alpha.3 起会在启动时核对插件的 @deepseek-ai/dsh-* peer：
//   不满足就**停用那一行插件**（只打一行 `dsh: disabling profile plugin row …`），
//   其余照常启动 —— 于是浏览器里是没有课堂/习题界面的官方 web app。
//   Windows 上 scripts/dsh.ps1 会校验 dsh 版本并报错；mac 上没有任何检查。
//
// 检查方式：逐个比对 lockfile 里的**顶层**包（node_modules/<name>）与已装的版本。
//   · 嵌套包（node_modules/a/node_modules/b）不看：顶层对上了，npm 装的就是这份 lock
//   · workspace 链接（link: true）不看：由 verify-workspace-links.mjs 负责
//   · optional 包缺失不算（平台相关的二进制，如 @esbuild/darwin-arm64）
//
// 用法：
//   node scripts/check-deps.mjs            # 不一致时打印差异
//   node scripts/check-deps.mjs --quiet    # 只看退出码
// 退出码 0 = 一致（或没有 package-lock.json，无从判断）；1 = 缺包 / 版本不对
// ============================================================
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');
const say = (msg) => {
  if (!quiet) console.log(msg);
};

/**
 * 比对已装的顶层包与 lockfile。
 * @param {string} root 仓库根
 * @returns {{ checked: number, missing: string[], mismatched: Array<{ name: string, installed: string, locked: string }> } | null}
 *   没有 package-lock.json → null
 */
export function compareInstalled(root) {
  const lockFile = join(root, 'package-lock.json');
  if (!existsSync(lockFile)) return null;
  const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
  const missing = [];
  const mismatched = [];
  let checked = 0;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue;
    const name = key.slice('node_modules/'.length);
    if (name.includes('/node_modules/')) continue; // 嵌套包
    if (!entry || entry.link || typeof entry.version !== 'string') continue;
    let installed = null;
    try {
      installed = JSON.parse(readFileSync(join(root, key, 'package.json'), 'utf-8')).version ?? null;
    } catch {
      installed = null;
    }
    if (installed === null) {
      if (!entry.optional) missing.push(name);
      continue;
    }
    checked++;
    if (installed !== entry.version) mismatched.push({ name, installed, locked: entry.version });
  }
  return { checked, missing, mismatched };
}

function main() {
  const r = compareInstalled(ROOT);
  if (r === null) {
    say('[check-deps] 没有 package-lock.json，跳过一致性检查');
    return 0;
  }
  if (!r.missing.length && !r.mismatched.length) {
    say(`[check-deps] 依赖与 package-lock.json 一致（${r.checked} 个顶层包）`);
    return 0;
  }
  // dsh 本体放最前面：它不对是"打开成标准版 dsh"的直接原因
  const dshFirst = (a, b) => Number(b.name === '@deepseek-ai/dsh') - Number(a.name === '@deepseek-ai/dsh');
  const shown = 8;
  if (r.mismatched.length) {
    say(`[check-deps] ${r.mismatched.length} 个包的版本与 package-lock.json 不一致（已装 → 应为）：`);
    for (const m of [...r.mismatched].sort(dshFirst).slice(0, shown)) say(`    ${m.name}  ${m.installed} → ${m.locked}`);
    if (r.mismatched.length > shown) say(`    …另有 ${r.mismatched.length - shown} 个`);
  }
  if (r.missing.length) {
    say(`[check-deps] ${r.missing.length} 个包没装：${r.missing.slice(0, shown).join(', ')}${r.missing.length > shown ? ' …' : ''}`);
  }
  say('[check-deps] 修复：在仓库根执行 npm install（不要在 profiles/* 里装）');
  return 1;
}

// 被 import（测试）时不跑 main；仓库要求 Node 24.9+，import.meta.main 可用
if (import.meta.main) process.exit(main());
