// ============================================================
// 记忆生命周期纯函数单测（M3 v3：淘汰选择 / 画像沉淀 / 活性得分）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// ============================================================
import assert from 'node:assert/strict';
import { recencyScore, evictionValue, selectEviction, suggestProfileFacts } from '../lib/engine.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const now = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

t('recencyScore：刚访问≈1，很久前→低', () => {
  assert.ok(recencyScore(now, now) > 0.99);
  assert.ok(recencyScore(now - 90 * DAY, now) < 0.3);
  assert.ok(recencyScore(now - 45 * DAY, now) > 0.45 && recencyScore(now - 45 * DAY, now) < 0.55);
});

t('evictionValue = importance × recency', () => {
  const freshHigh = evictionValue({ id: 'a', importance: 90, lastAccess: now, scope: 'global', status: 'active' }, now);
  const oldLow = evictionValue({ id: 'b', importance: 10, lastAccess: now - 200 * DAY, scope: 'global', status: 'active' }, now);
  assert.ok(oldLow < freshHigh);
});

t('selectEviction：超容量时淘汰价值最低的 global active', () => {
  const records = [
    { id: 'old', importance: 5, lastAccess: now - 300 * DAY, scope: 'global', status: 'active' },
    { id: 'fresh', importance: 95, lastAccess: now, scope: 'global', status: 'active' },
    { id: 'mid', importance: 50, lastAccess: now - 60 * DAY, scope: 'global', status: 'active' },
    { id: 'mode1', importance: 1, lastAccess: now - 400 * DAY, scope: 'mode', status: 'active' },
    { id: 'dorm', importance: 1, lastAccess: now - 400 * DAY, scope: 'global', status: 'dormant' },
  ];
  const evict = selectEviction(records, 'global', 2, now);
  assert.equal(evict.length, 1);
  assert.equal(evict[0], 'old', '应淘汰价值最低的 global active；mode/dormant 不受影响');
});

t('selectEviction：未超容量不淘汰', () => {
  const records = [
    { id: 'a', importance: 5, lastAccess: now - 300 * DAY, scope: 'global', status: 'active' },
    { id: 'b', importance: 95, lastAccess: now, scope: 'global', status: 'active' },
  ];
  assert.deepEqual(selectEviction(records, 'global', 10, now), []);
});

t('suggestProfileFacts：去重（子串级）+ 截断 + 上限', () => {
  const added = suggestProfileFacts(['我叫小星，喜欢物理', '我叫小星', '我喜欢物理', 'x'], ['我叫小星'], 20);
  assert.ok(!added.some((f) => f.includes('我叫小星，喜欢物理')), '与已有事实子串包含应剔除');
  assert.ok(!added.includes('x'), '过短剔除');
  assert.ok(added.some((f) => f.includes('我喜欢物理')));
});

t('suggestProfileFacts：maxFacts 上限', () => {
  const facts = Array.from({ length: 30 }, (_, i) => `事实编号${i}号`);
  const added = suggestProfileFacts(facts, [], 10);
  assert.ok(added.length <= 10);
});

console.log(`\n[memory-engine] ${passed} 项断言全部通过`);
