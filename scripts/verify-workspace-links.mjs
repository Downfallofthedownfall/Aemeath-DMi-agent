#!/usr/bin/env node
// ============================================================
// scripts/verify-workspace-links.mjs — 检查 workspace 包能否被解析
//
// 为什么需要（真机踩过）：
//   仓库根 node_modules/@aemeath/* 的链接**曾经是手工建的**，没进版本控制、
//   也没在 package.json 声明。Windows 上因为链接恰好存在所以一切正常；
//   全新 clone 到 macOS 后 `npm install` 不会创建它们，
//   于是构建直接报 TS2307。
//
// ⚠️ 检查方式：看**链接/目录是否存在**，而不是 `require.resolve()`。
//    早期版本用 require.resolve 判断"能否加载"，那是错的：
//    插件的构建产物在 `packages/**/lib/`，而它**被 gitignore**
//    （.gitignore:198），全新 clone 里根本不存在；
//    同时 exports 指向 ./lib/index.js。
//    于是全新 clone 上 resolve 必然失败——**即使链接完全正常**，
//    报出的却是一句"@aemeath/* 无法解析"，误导人往 npm install 上找原因。
//    链接存在 ≠ 产物已构建，这两件事必须分开检查。
//
// 用法：
//   node scripts/verify-workspace-links.mjs
// 退出码 0 = 链接齐备；1 = 有缺失（并打印怎么修）
// ============================================================
import { readFileSync, readdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  if (!existsSync(f)) return { name: null, deps: [], optional: new Set() };
  const pkg = JSON.parse(readFileSync(f, 'utf-8'));
  const deps = new Set();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const k of Object.keys(pkg[field] ?? {})) {
      if (k.startsWith('@aemeath/')) deps.add(k);
    }
  }
  const optional = new Set(Object.keys(pkg.peerDependenciesMeta ?? {}));
  return { name: pkg.name, deps: [...deps], optional };
}

/** 仓库里所有 workspace 包目录。 */
function workspaceDirs() {
  const base = join(ROOT, 'packages');
  if (!existsSync(base)) return [];
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

/**
 * 一个包名能否从 fromDir 解析到**真实存在的目录**。
 *
 * 逐级往上找 node_modules/<scope>/<name>，判断它是目录（真实或链接），
 * 且能 realpath 到一个存在的路径。**不看 lib/ 产物**——那是构建的事。
 */
function resolvesToDir(fromDir, pkgName) {
  const parts = pkgName.split('/');
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', ...parts);
    if (existsSync(candidate)) {
      try {
        // 符号链接/junction：确认指向的东西真的存在（断链要能被发现）
        const real = realpathSync(candidate);
        if (existsSync(real)) return { ok: true, path: real };
        return { ok: false, why: `断链：${candidate} → ${real}（目标不存在）` };
      } catch (e) {
        return { ok: false, why: `无法解析：${candidate}（${e.code}）` };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return { ok: false, why: `未找到 ${pkgName}（已上溯到文件系统根）` };
    dir = parent;
  }
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

console.log('\n=== 2) 每个包的 @aemeath 依赖能否解析到目录 ===');
for (const dir of workspaceDirs()) {
  const { name, deps } = depsOf(dir);
  if (!name) continue;
  for (const dep of deps) {
    const r = resolvesToDir(dir, dep);
    if (r.ok) ok(`${name} → ${dep}`);
    else fail(`${name} → ${dep}：${r.why}`);
  }
}

console.log('\n=== 3) 动态 import 的包是否也声明了 ===');
// lecture 通过动态 import 拿 memory 的 gatekeeper（D2：不硬依赖）。
// 动态 import 逃得过类型检查的"使用处"，但逃不过声明检查——这里专门盯它。
const lectureDir = join(ROOT, 'packages/lecture/dsh-plugin-lecture');
const dyn = [];
const lectureSrc = join(lectureDir, 'src');
if (existsSync(lectureSrc)) {
  for (const f of readdirSync(lectureSrc)) {
    if (!f.endsWith('.ts')) continue;
    const src = readFileSync(join(lectureSrc, f), 'utf-8');
    for (const m of src.matchAll(/await\s+import\(\s*['"](@aemeath\/[^'"]+)['"]\s*\)/g)) {
      dyn.push({ file: f, spec: m[1] });
    }
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

console.log('\n=== 4) 代码 import 的 @aemeath 包是否都声明了 ===');
// 通用护栏：任何包 import 了 @aemeath/* 却没在 package.json 声明，
// 都是"靠根 node_modules 里恰好存在的链接过活"——全新 clone 就暴露。
// 真机踩过：curriculum 与 ui 都 import 了 common 但没声明。
for (const dir of workspaceDirs()) {
  const pj = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pj, 'utf-8'));
  if (!pkg.name) continue;
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const used = new Set();
  const src = join(dir, 'src');
  if (existsSync(src)) {
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        const t = readFileSync(p, 'utf-8');
        // 静态 import ... from '@aemeath/x' 与动态 import('@aemeath/x')
        for (const m of t.matchAll(/from\s+['"](@aemeath\/[^'"]+)['"]/g)) used.add(m[1]);
        for (const m of t.matchAll(/import\(\s*['"](@aemeath\/[^'"]+)['"]/g)) used.add(m[1]);
      }
    };
    walk(src);
  }
  for (const u of used) {
    const name = u.split('/').slice(0, 2).join('/');
    if (name === pkg.name) continue;
    if (declared.has(name)) ok(`${pkg.name} 声明了 ${name}`);
    else fail(`${pkg.name} import 了 ${name}，但 package.json 未声明`);
  }
}

console.log('');
if (problems === 0) {
  console.log('workspace 链接全部可解析，依赖声明完整。');
  console.log('（注：此处只验证链接与声明。插件的 lib/ 构建产物由 build 脚本产出，');
  console.log('  它们被 .gitignore 排除，全新 clone 里本来就不存在。）');
  process.exit(0);
}
console.error(`发现 ${problems} 个问题。`);
console.error('');
console.error('修复方式：');
console.error('  · 链接缺失 → 在仓库根执行 npm install（不要在 profiles/* 里装依赖）');
console.error('  · 依赖未声明 → 把该包加入对应 package.json 的 devDependencies');
console.error('    并用 file:../../../packages/<area>/<pkg> 形式指向源码');
process.exit(1);

