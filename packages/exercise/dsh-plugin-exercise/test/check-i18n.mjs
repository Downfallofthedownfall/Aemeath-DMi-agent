// 静态 i18n 护栏：zh/en 键集一致 + 客户端 t() 引用的键都存在。
// 不扫描注释/样式，避免误报；界面文案是否还有硬编码中文由人工 review + 构建验证。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const locales = readFileSync(join(root, 'src/client/locales.ts'), 'utf-8');

function keysOf(name) {
  const re = new RegExp(`export const ${name}[^=]*= \\{`);
  const m = locales.match(re);
  assert.ok(m, `找不到 ${name} 字典`);
  const start = m.index;
  const end = locales.indexOf('\n};', start);
  const end2 = locales.indexOf('\n} as const;', start);
  const stop = end === -1 ? end2 : end2 === -1 ? end : Math.min(end, end2);
  assert.ok(stop > start, `找不到 ${name} 字典结尾`);
  return [...locales.slice(start, stop).matchAll(/^\s*'([^']+)'\s*:/gm)].map((x) => x[1]);
}

const zh = keysOf('zh');
const en = keysOf('en');
assert.equal(new Set(zh).size, zh.length, 'zh 字典有重复键');
assert.equal(new Set(en).size, en.length, 'en 字典有重复键');
assert.deepEqual([...new Set(zh)].sort(), [...new Set(en)].sort(), 'zh/en 键集必须完全一致');

const dir = join(root, 'src/client');
const used = new Set();
for (const f of readdirSync(dir)) {
  if (!/\.(ts|tsx)$/.test(f) || f === 'locales.ts' || f === 'i18n.ts') continue;
  const src = readFileSync(join(dir, f), 'utf-8');
  for (const m of src.matchAll(/\b(?:t|translate)\(\s*'([^']+)'/g)) used.add(m[1]);
}
const unknown = [...used].filter((k) => !new Set(zh).has(k));
assert.deepEqual(unknown, [], `客户端引用了不存在的 i18n key: ${unknown.join(', ')}`);
console.log(`[i18n] zh ${zh.length} / en ${en.length} keys；客户端引用 ${used.size} 个 key，全部存在`);
