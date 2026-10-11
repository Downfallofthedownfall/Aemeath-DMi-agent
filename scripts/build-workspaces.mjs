#!/usr/bin/env node
// ============================================================
// scripts/build-workspaces.mjs — 按**依赖顺序**构建所有 workspace 包
//
// 为什么不用 `npm run build --workspaces`：
//   npm 不保证按依赖拓扑顺序执行，而且实测会出现**竞态**——
//   某个包在它的依赖产出 .d.ts 之前就开始了编译，于是报：
//       src/index.ts:33  error TS2307: Cannot find module '@aemeath/dsh-plugin-common'
//       src/index.ts:782 error TS2307: Cannot find module '@aemeath/dsh-plugin-memory/gatekeeper'
//   这两条错极易误诊为"链接缺失"（真机上我就先往那个方向查了半天），
//   实际是"依赖还没构建"。
//
//   注意：错误只在**全新 clone** 上出现 —— 本地开发时 lib/ 早就建好了，
//   竞态被既存产物掩盖。所以这个顺序必须由脚本保证，不能靠运气。
//
// 做法：读每个包的 @aemeath 依赖 → 拓扑排序 → 依次 spawn。
// 包之间若有环，直接报错而不是死循环。
// ============================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 收集所有 workspace 包。 */
function collect() {
  const base = join(ROOT, 'packages');
  const pkgs = new Map(); // name -> { dir, deps:Set<name>, script?:string }
  if (!existsSync(base)) return pkgs;
  for (const area of readdirSync(base, { withFileTypes: true })) {
    if (!area.isDirectory()) continue;
    const areaPath = join(base, area.name);
    for (const sub of readdirSync(areaPath, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const dir = join(areaPath, sub.name);
      const pj = join(dir, 'package.json');
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, 'utf-8'));
      if (!pkg.name) continue;
      const deps = new Set();
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const k of Object.keys(pkg[field] ?? {})) {
          if (k.startsWith('@aemeath/')) deps.add(k);
        }
      }
      pkgs.set(pkg.name, { dir, deps, script: pkg.scripts?.build });
    }
  }
  return pkgs;
}

/** 拓扑排序（依赖在前）。有环则抛。 */
function topoSort(pkgs) {
  const out = [];
  const state = new Map(); // name -> 'visiting' | 'done'
  const visit = (name, chain) => {
    const st = state.get(name);
    if (st === 'done') return;
    if (st === 'visiting') {
      throw new Error(`workspace 依赖成环：${[...chain, name].join(' → ')}`);
    }
    state.set(name, 'visiting');
    const p = pkgs.get(name);
    for (const d of p?.deps ?? []) {
      // 只关心仓库内的包（外部依赖不管）
      if (pkgs.has(d)) visit(d, [...chain, name]);
    }
    state.set(name, 'done');
    if (p) out.push(name);
  };
  for (const name of pkgs.keys()) visit(name, []);
  return out;
}

const pkgs = collect();
if (pkgs.size === 0) {
  console.log('[build] 没有找到 workspace 包');
  process.exit(0);
}

let order;
try {
  order = topoSort(pkgs);
} catch (e) {
  console.error('[build] ' + e.message);
  process.exit(1);
}

const buildable = order.filter((n) => pkgs.get(n).script);
console.log(`[build] 按依赖顺序构建 ${buildable.length} 个包：`);
for (const n of buildable) {
  const deps = [...pkgs.get(n).deps].filter((d) => pkgs.has(d));
  console.log(`  ${n}${deps.length ? `  (依赖 ${deps.join(', ')})` : ''}`);
}
console.log('');

for (const name of buildable) {
  console.log(`[build] ▶ ${name}`);
  const r = spawnSync('npm', ['run', 'build', '-w', name], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32', // Windows 上 npm 是 .cmd
  });
  if (r.status !== 0) {
    console.error('');
    console.error(`[build] ✗ ${name} 构建失败（退出码 ${r.status}）`);
    console.error('[build] 提示：若报 "Cannot find module @aemeath/..."，');
    console.error('[build]       先确认是"包目录找不到"（链接问题 → npm install）');
    console.error('[build]       还是"类型声明找不到"（依赖没构建 → 本脚本已按序处理）。');
    process.exit(r.status ?? 1);
  }
}

console.log('');
console.log(`[build] 全部 ${buildable.length} 个包构建完成。`);
