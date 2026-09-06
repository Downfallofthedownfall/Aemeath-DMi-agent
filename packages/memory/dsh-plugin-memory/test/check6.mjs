// ============================================================
// partial DMAE 记忆生命周期纯函数单测（借 Cyrene L2 激活得分缓存思想）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// 覆盖：computeActivation / classifyActivation / activationOf /
//       afterRecallActivation（wake-on-recall） / selectEviction 抗衰减淘汰
// ============================================================
import assert from 'node:assert/strict';
import {
  computeActivation,
  classifyActivation,
  activationOf,
  afterRecallActivation,
  selectEviction,
  ACTIVATION_DEFAULT,
  ACTIVATION_ACTIVE_THRESHOLD,
  ACTIVATION_ARCHIVED_THRESHOLD,
  ACTIVATION_HIT_BONUS,
} from '../lib/engine.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const now = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

// —— 激活值计算（importance intrinsic + recency + hitBonus/衰减抵抗） ——
t('computeActivation：满近因高价值 → 高激活（active）', () => {
  assert.equal(computeActivation({ importance: 100, lastAccess: now, now }), 90);
  assert.ok(classifyActivation(computeActivation({ importance: 100, lastAccess: now, now })) === 'active');
});

t('computeActivation：满近因零价值 → 中激活（dormant）', () => {
  assert.equal(computeActivation({ importance: 0, lastAccess: now, now }), 45);
  assert.ok(classifyActivation(computeActivation({ importance: 0, lastAccess: now, now })) === 'dormant');
});

t('computeActivation：陈旧低激活 → 归档（archived）', () => {
  const stale = computeActivation({ importance: 20, lastAccess: now - 400 * DAY, now });
  assert.ok(stale < ACTIVATION_ARCHIVED_THRESHOLD, `陈旧应归档: ${stale}`);
  assert.equal(classifyActivation(stale), 'archived');
});

t('computeActivation：命中加成抬高激活（衰减抵抗）', () => {
  const base = computeActivation({ importance: 50, lastAccess: now - 400 * DAY, now });
  const hit = computeActivation({ importance: 50, lastAccess: now - 400 * DAY, now, hitBonus: 1 });
  assert.ok(hit > base, `命中加成应抬高激活: base=${base} hit=${hit}`);
  assert.ok(abs(hit - base) <= ACTIVATION_HIT_BONUS, '加成上限 = ACTIVATION_HIT_BONUS');
});

// —— 三态分类阈值 ——
t('classifyActivation：阈值边界 Active(≥60) / Dormant(30–59) / Archived(<30)', () => {
  assert.equal(classifyActivation(ACTIVATION_ACTIVE_THRESHOLD), 'active');
  assert.equal(classifyActivation(100), 'active');
  assert.equal(classifyActivation(59), 'dormant', '59 归 dormant（活跃阈值以下）');
  assert.equal(classifyActivation(ACTIVATION_ARCHIVED_THRESHOLD), 'dormant', '30 归 dormant');
  assert.equal(classifyActivation(29), 'archived');
  assert.equal(classifyActivation(0), 'archived');
});

// —— activationOf：优先已存激活，缺省现算 ——
t('activationOf：优先已存激活值', () => {
  assert.equal(activationOf({ importance: 10, lastAccess: now - 400 * DAY, activation: 80 }, now), 80);
});

t('activationOf：缺省（旧记录无 activation）按信号现算', () => {
  assert.equal(activationOf({ importance: 100, lastAccess: now }, now), 90);
});

// —— afterRecallActivation：wake-on-recall ——
t('afterRecallActivation：召回归档记忆 → 唤醒回 active 并抬高激活', () => {
  const wake = afterRecallActivation({ importance: 10, activation: 20 }, now);
  assert.equal(wake.status, 'active');
  assert.ok(wake.activation >= ACTIVATION_ACTIVE_THRESHOLD, `唤醒后激活应≥active: ${wake.activation}`);
});

// —— selectEviction：高频命中（高激活）抗淘汰 ——
t('selectEviction：高激活（常召回）记忆抗淘汰', () => {
  const records = [
    { id: 'seldom', importance: 20, lastAccess: now - 400 * DAY, scope: 'global', status: 'active', activation: 15 },
    { id: 'hot', importance: 20, lastAccess: now - 400 * DAY, scope: 'global', status: 'active', activation: 80 },
  ];
  assert.deepEqual(selectEviction(records, 'global', 1, now), ['seldom'], '低激活先淘汰；high-hit 记忆保留');
});

// —— ACTIVATION_DEFAULT 兜底（旧记录读取） ——
t('ACTIVATION_DEFAULT：未写入激活的旧记录中性默认值', () => {
  assert.equal(ACTIVATION_DEFAULT, 50);
});

function abs(x) {
  return Math.abs(x);
}

console.log(`\n[memory-activation] ${passed} 项断言全部通过`);
