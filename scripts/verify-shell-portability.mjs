#!/usr/bin/env node
// ============================================================
// scripts/verify-shell-portability.mjs — shell 脚本可移植性检查
//
// 为什么需要（真机踩过，用户自己在 mac 上诊断出来的）：
//
//   scripts/lecture-mac.sh 里写了：
//       say "启动课堂记录模式（profile=lecture, port=$PORT）"
//                                              ^^^^^^ 后面紧跟全角 ）
//
//   macOS 自带的是 **bash 3.2**（2007 年的版本，Apple 因 GPLv3 一直没升级）。
//   它在 UTF-8 环境下解析变量名时，会把全角字符的首字节（0xEF）**吃进变量名**，
//   于是实际展开的是 `PORT\xef` 而不是 `PORT`，报出：
//       PORT\xef: unbound variable      （终端里显示成 PORT?: unbound variable）
//
//   极具迷惑性的是：**同一份脚本在 bash 4/5 上完全正常**
//   （Linux、Homebrew 装的 bash、Windows 的 Git Bash 都是 4+）。
//   所以在开发机上永远复现不出来，只有 mac 用户会踩到。
//
// 规则：`$VAR` 后面紧跟非 ASCII 字符时，必须写成 `${VAR}`。
//
// 用法：
//   node scripts/verify-shell-portability.mjs
// 退出码 0 = 通过；1 = 有问题
// ============================================================
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 递归收集 shell 脚本（跳过 node_modules / .git / 构建产物）。 */
function collectShellScripts(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'lib', 'dist', '.dsh-home'].includes(e.name)) continue;
      collectShellScripts(p, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (/\.(sh|command|bash)$/.test(e.name)) out.push(p);
  }
  return out;
}

// $VAR 后面紧跟非 ASCII 字符 —— bash 3.2 会把该字符的首字节并入变量名
const RISKY = /(?<!\\)\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/g;
// 已经是 ${VAR} 形式的没问题（花括号明确了边界）
const SAFE_BRACED = /\$\{[^}]*\}/g;
// 注释行里的引用无害（不参与展开）
const isComment = (line) => /^\s*#/.test(line);

let problems = 0;

const files = collectShellScripts(ROOT);
console.log(`扫描 ${files.length} 个 shell 脚本…\n`);

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const text = readFileSync(file, 'utf-8');
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;

    // 先把已被 ${} 包裹的部分挖掉，避免误报
    const masked = line.replace(SAFE_BRACED, (m) => '\u0000'.repeat(m.length));
    const hits = masked.match(RISKY);
    if (!hits) continue;

    // 再排除单引号字符串里的（单引号内不展开）
    const inSingleQuote = (() => {
      let inside = false;
      for (let k = 0; k < line.length; k++) {
        if (line[k] === "'") inside = !inside;
        if (masked.slice(k).match(/^\$[A-Za-z_]/) && inside) return true;
      }
      return false;
    })();
    if (inSingleQuote) continue;

    for (const hit of hits) {
      console.error(`  ✗ ${rel}:${i + 1}  ${hit}<非ASCII>`);
      console.error(`      ${line.trim()}`);
      problems++;
    }
  }
}

console.log('');
if (problems === 0) {
  console.log('没有发现 $VAR 紧跟非 ASCII 的写法。');
  console.log('（macOS 自带 bash 3.2 在这种写法下会把该字符的首字节吃进变量名；');
  console.log('  bash 4+ 没这个问题，所以开发机上复现不出来。）');
  process.exit(0);
}
console.error(`发现 ${problems} 处可移植性问题（macOS bash 3.2 会解析错）。`);
console.error('');
console.error('修复：给变量加花括号，明确边界。');
console.error('  改前：  echo "port=$PORT）"          ← ）是全角');
console.error('  改后：  echo "port=${PORT}）"');
process.exit(1);
