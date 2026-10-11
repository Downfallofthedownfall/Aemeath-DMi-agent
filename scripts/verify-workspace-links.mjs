#!/usr/bin/env node
// ============================================================
// scripts/verify-workspace-links.mjs — 检查 workspace 包能否被解析
//
// 为什么需要（真机踩过）：
//   仓库根 node_modules/@aemeath/* 的链接**曾经是手工建的**，没进版本控制、
//   也没在 package.json 声明。Windows 上因为链接恰好存在所以一切正常；
//   全新 clone 到 macOS 后 `npm install` 不会创建它们，
//   于是构建直接报：
//       src/index.ts:33  error TS2307: Cannot find module '@aemeath/dsh-plugin-common'
//       src/index.ts:782 error TS2307: Cannot find module '@aemeath/dsh-plugin-memory/gatekeeper'
//   第二条尤其隐蔽：它是**动态 import**（D2 隔离设计），
//   只在运行时才解析，类型检查却能提前暴露声明缺失。
//
// 现在根 package.json 明确声明了这些 workspace 包，npm 会自己建链接。
// 本脚本是**回归护栏**：确保声明与实际解析能力一致，
// 而不是靠"我机器上能跑"。
//
// 用法：
//   node scripts/verify-workspace-links.mjs
// 退出码 0 = 全部可解析；1 = 有缺失（并打印怎么修）
// ============================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'noop.js'));

/** 本地 workspace 包（@aemeath/*）→ 其源码目录，由根 package.json 的声明推导。 */
function declaredWorkspaceDeps() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const out = new Map();
  for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
    if (!name.startsWith('@aemeath/')) continue;
    const m = String(spec).match(/^file:(.+)$/);
    if (m) out.set(name, m[1]);
  }
  return out;
}

/** 每个包的 package.json 里声明的 @aemeath 依赖（含 peer/dev）。 */
function depsOf(pkgDir) {
  const f = join(pkgDir, 'package.json');
  if (!existsSync(f)) return { name: null, deps: [] };
  const pkg = JSON.parse(readFileSync(f, 'utf-8'));
  const deps = new Set();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const k of Object.keys(pkg[field] ?? {})) {
      if (k.startsWith('@aemeath/')) deps.add(k);
    }
  }
  return { name: pkg.name, deps: [...deps] };
}

/** 仓库里所有 workspace 包目录。 */
function workspaceDirs() {
  const base = join(ROOT, 'packages');
  const dirs = [];
  for (const area of readdirSync(base, { withFileTypes: true })) {
    if (!area.isDirectory()) continue;
    const areaPath = join(base, area.name);
    for (const sub of readdirSync(areaPath, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const p = join(areaPath, sub.name);
      if (existsSync(join(p, 'package.json'))) dirs.push(p);
    }
  }
  return dirs;
}

let problems = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); problems++; };
const ok = (msg) => console.log('  ✓ ' + msg);

console.log('=== 1) 根 package.json 是否声明了所有 workspace 包 ===');
const declared = declaredWorkspaceDeps();
const all = workspaceDirs().map(depsOf).filter((x) => x.name?.startsWith('@aemeath/'));
for (const { name } of all) {
  if (declared.has(name)) ok(`已声明 ${name}`);
  else fail(`${name} 未在根 package.json 声明 —— 全新 clone 后 npm 不会建立链接`);
}

console.log('\n=== 2) 每个包的 @aemeath 依赖能否被 Node 解析 ===');
for (const dir of workspaceDirs()) {
  const { name, deps } = depsOf(dir);
  if (!name) continue;
  for (const dep of deps) {
    try {
      // 从该包所在目录解析（模拟 TS/运行时的解析路径）
      const req = createRequire(join(dir, 'noop.js'));
      req.resolve(dep);
      ok(`${name} → ${dep}`);
    } catch {
      fail(`${name} → ${dep} 解析失败`);
    }
  }
}

console.log('\n=== 3) 动态 import 的包是否也声明了 ===');
// lecture 通过动态 import 拿 memory 的 gatekeeper（D2：不硬依赖）。
// 动态 import 逃得过类型检查的"使用处"，但逃不过声明检查——这里专门盯它。
const lectureDir = join(ROOT, 'packages/lecture/dsh-plugin-lecture');
const dyn = [];
for (const f of readdirSync(join(lectureDir, 'src'))) {
  if (!f.endsWith('.ts')) continue;
  const src = readFileSync(join(lectureDir, 'src', f), 'utf-8');
  for (const m of src.matchAll(/await\s+import\(\s*['"](@aemeath\/[^'"]+)['"]\s*\)/g)) {
    dyn.push({ file: f, spec: m[1] });
  }
}
if (dyn.length === 0) {
  ok('未发现动态 import 的 @aemeath 包');
} else {
  const pkg = JSON.parse(readFileSync(join(lectureDir, 'package.json'), 'utf-8'));
  const declaredAnywhere = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  for (const { file, spec } of dyn) {
    // 动态 import 可能带子路径（@aemeath/dsh-plugin-memory/gatekeeper）→ 取包名
    const parts = spec.split('/');
    const pkgName = parts.slice(0, 2).join('/');
    if (declaredAnywhere.has(pkgName)) ok(`${file} 动态 import ${spec}（已声明 ${pkgName}）`);
    else fail(`${file} 动态 import ${spec}，但 ${pkgName} 未在 package.json 声明`);
  }
}

console.log('');
if (problems === 0) {
  console.log('workspace 链接全部可解析。');
  process.exit(0);
}
console.error(`发现 ${problems} 个问题。`);
console.error('');
console.error('修复方式：在仓库根执行 npm install（根 package.json 已声明这些 workspace 包，');
console.error('npm 会自动建立 node_modules/@aemeath/* 链接）。');
console.error('若仍失败，检查该包是否已加入根 package.json 的 devDependencies。');
process.exit(1);
