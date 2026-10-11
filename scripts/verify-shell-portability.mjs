#!/usr/bin/env node
// ============================================================
// scripts/verify-shell-portability.mjs — shell 脚本可移植性检查
//
// 检查两类"只在别人机器上炸"的问题：
//
// 【一】$VAR 紧跟非 ASCII —— macOS 自带 bash 3.2 会解析错
//
//   scripts/lecture-mac.sh 里写过：
//       say "启动课堂记录模式（profile=lecture, port=$PORT）"
//                                              ^^^^^^ 后面紧跟全角 ）
//
//   macOS 自带的是 **bash 3.2**（2007 年的版本，Apple 因 GPLv3 一直没升级）。
//   它在 UTF-8 环境下解析变量名时，会把全角字符的首字节（0xEF）**吃进变量名**，
//   于是实际展开的是 PORT\xef 而不是 PORT，报出：
//       PORT\xef: unbound variable      （终端里显示成 PORT?: unbound variable）
//
//   极具迷惑性的是：**同一份脚本在 bash 4/5 上完全正常**
//   （Linux、Homebrew 装的 bash、Windows 的 Git Bash 都是 4+）。
//   所以在开发机上永远复现不出来，只有 mac 用户会踩到。
//
// 【二】CRLF 行尾 —— mac/Linux 上以各种方式炸掉
//
//   真机踩过：脚本以 CRLF 提交后，mac 上 `./scripts/lecture-mac.sh` 报
//       line 207: syntax error near unexpected token `<'
//   而第 207 行是 `done < <(node -e '...` —— 进程替换本身没问题，
//   是行尾的 \r 被当成了命令的一部分。
//   **报错位置和真正的原因（行尾）看起来毫无关系**，极难联想。
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
  // 注意：这里读的是**原始字节**（'latin1' 保留每字节一字符），
  // 用 'utf-8' 读会把 \r\n 规范化掉，就看不出 CRLF 了。
  const raw = readFileSync(file, 'latin1');

  // ---- 检查二：CRLF 行尾 ----
  const crlfCount = (raw.match(/\r\n/g) || []).length;
  if (crlfCount > 0) {
    console.error(`  ✗ ${rel}  含 ${crlfCount} 处 CRLF 行尾`);
    console.error('      mac/Linux 上 \\r 会被当成命令的一部分，');
    console.error('      报错位置（syntax error near unexpected token）与真正原因（行尾）毫无关联。');
    console.error('      修复：转成 LF，并确认 .gitattributes 里有对应规则。');
    problems++;
  }

  const text = raw.replace(/\r\n/g, '\n');
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
  console.log('shell 脚本可移植性检查通过：');
  console.log('  · 没有 $VAR 紧跟非 ASCII 的写法');
  console.log('    （macOS 自带 bash 3.2 会把该字符的首字节吃进变量名；bash 4+ 不会，');
  console.log('      所以开发机上复现不出来）');
  console.log('  · 没有 CRLF 行尾');
  console.log('    （\\r 在 mac/Linux 上会被当成命令的一部分，报错位置极具误导性）');
  process.exit(0);
}
console.error(`发现 ${problems} 处可移植性问题（macOS bash 3.2 会解析错）。`);
console.error('');
console.error('修复：给变量加花括号，明确边界。');
console.error('  改前：  echo "port=$PORT）"          ← ）是全角');
console.error('  改后：  echo "port=${PORT}）"');
process.exit(1);
