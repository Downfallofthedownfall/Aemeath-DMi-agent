// ============================================================
// plan 纯函数单测（M6 v2：parsePlan / upsertStep）
// 运行：npm test -w @aemeath/dsh-plugin-workflow
// ============================================================
import assert from 'node:assert/strict';
import { parsePlan, upsertStep } from '../lib/plan.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

t('parsePlan：JSON 数组解析 + 清洗', () => {
  assert.deepEqual(parsePlan('["写受力方程","解出 a","回代验证"]'), ['写受力方程', '解出 a', '回代验证']);
});

t('parsePlan：容错（空/坏 JSON/非数组）', () => {
  assert.deepEqual(parsePlan(undefined), []);
  assert.deepEqual(parsePlan(''), []);
  assert.deepEqual(parsePlan('not json'), []);
  assert.deepEqual(parsePlan('{"a":1}'), []);
  assert.deepEqual(parsePlan('[1, "  ", "x"]'), ['1', 'x'], '去空白空串并转字符串');
});

t('upsertStep：缺省追加末尾', () => {
  assert.deepEqual(upsertStep(['a', 'b'], 'c'), ['a', 'b', 'c']);
});

t('upsertStep：index 插入 + 越界夹紧', () => {
  assert.deepEqual(upsertStep(['a', 'b'], 'x', 0), ['x', 'a', 'b']);
  assert.deepEqual(upsertStep(['a', 'b'], 'x', 99), ['a', 'b', 'x'], '越界 → 末尾');
  assert.deepEqual(upsertStep(['a', 'b'], 'x', -5), ['x', 'a', 'b'], '负 index → 队首');
});

t('upsertStep：空 step 不变 + 不改入参', () => {
  const src = ['a'];
  assert.deepEqual(upsertStep(src, '   '), ['a']);
  assert.deepEqual(src, ['a'], '入参不被修改');
});

console.log(`\n[workflow-plan] ${passed} 项断言全部通过`);
