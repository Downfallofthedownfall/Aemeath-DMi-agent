// ============================================================
// 讲义分块单测（M4：按 ## 切块 + 超长二次切分）
// 运行：npm test -w @aemeath/dsh-plugin-retriever
// ============================================================
import assert from 'node:assert/strict';
import { chunkText } from '../lib/chunker.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const SAMPLE = `# 力学讲义（示例）

## 牛顿运动定律
牛顿第二定律：F = ma。合外力等于质量乘加速度。

## 能量守恒
功 W = F·s·cosθ。机械能守恒：Ek + Ep = 常量。

## 动量守恒
系统合外力为零时总动量守恒。碰撞问题常与能量守恒联用。`;

t('按二级标题切块（含前言与 3 节）', () => {
  const chunks = chunkText('mechanics.txt', SAMPLE);
  assert.ok(chunks.length >= 3, `至少 3 块，实际 ${chunks.length}`);
  const sections = chunks.map((c) => c.section);
  assert.ok(sections.includes('牛顿运动定律'));
  assert.ok(sections.includes('能量守恒'));
  assert.ok(sections.includes('动量守恒'));
});

t('块 id 带文件前缀且唯一', () => {
  const chunks = chunkText('mechanics.txt', SAMPLE);
  const ids = new Set(chunks.map((c) => c.id));
  assert.equal(ids.size, chunks.length, 'id 唯一');
  assert.ok(chunks.every((c) => c.id.startsWith('mechanics.txt#')));
});

t('超长块按段落二次切分（≤maxLen）', () => {
  const long = '## 超长节\n' + Array.from({ length: 60 }, (_, i) => `这是第${i}段内容，讲物理知识，够长了吧。`).join('\n');
  const chunks = chunkText('long.txt', long, 200);
  assert.ok(chunks.every((c) => c.content.length <= 200), '每块 ≤200');
  assert.ok(chunks.length > 1, '切成了多块');
});

t('空输入返回空数组', () => {
  assert.deepEqual(chunkText('empty.txt', ''), []);
  assert.deepEqual(chunkText('empty.txt', '   '), []);
});

console.log(`\n[retriever-chunker] ${passed} 项断言全部通过`);
