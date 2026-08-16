// ============================================================
// Worldbook 匹配逻辑单测（M2 验收：触发/排序/chain/防环/token 上限）
// 运行：npm test -w @aemeath/dsh-plugin-worldbook
// ============================================================
import assert from 'node:assert/strict';
import { normalize, matchWorldbook, hitSummary, MAX_CHAIN_DEPTH } from '../lib/match.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const EN = {
  id: 'newton_laws',
  title: '牛顿运动定律',
  kind: 'knowledge',
  triggers: ['牛顿', 'F=ma', 'traegheit'],
  constant: false,
  intrinsic_value: 95,
  priority: 180,
  chain: ['momentum_conservation'],
  content: 'F = ma（合力等于质量乘加速度）。',
  source: '第1周讲义 §1.1',
  exam_points: '受力分析（2023真题）',
  verifiable: true,
};
const MOM = {
  id: 'momentum_conservation',
  title: '动量守恒',
  triggers: ['动量'],
  constant: false,
  priority: 170,
  content: '系统合外力为零时总动量守恒。',
  source: '第2周讲义 §2.2',
};
const BIO = {
  id: 'physicist_bio',
  title: 'physicist 学霸自传',
  kind: 'identity',
  triggers: ['你是谁'],
  constant: true,
  priority: 200,
  content: '我是星炬学院物理学霸，先算后答，不会就承认，回答带来源。',
};
const CYCLE_A = { id: 'cycle_a', triggers: ['循环'], priority: 100, content: 'A', chain: ['cycle_b'] };
const CYCLE_B = { id: 'cycle_b', triggers: [], priority: 90, content: 'B', chain: ['cycle_a'] };

const all = [EN, MOM, BIO, CYCLE_A, CYCLE_B];

t('normalize 去空白与标点', () => {
  assert.equal(normalize('F = ma, 第二定律！'), 'fma第二定律');
  assert.equal(normalize(''), '');
});

t('中文触发命中', () => {
  const block = matchWorldbook('什么是牛顿第二定律', all, 3000);
  assert.ok(block.includes('牛顿运动定律'));
  assert.ok(block.includes('动量守恒'), 'chain 应补入动量守恒');
});

t('德文触发命中（traegheit）', () => {
  const block = matchWorldbook('Was ist Traegheit?', all, 3000);
  assert.ok(block.includes('牛顿运动定律'));
});

t('constant 无条件注入', () => {
  const block = matchWorldbook('帮我做道题', all, 3000);
  assert.ok(block.includes('physicist 学霸自传'));
  assert.ok(block.includes('先算后答'));
});

t('priority 排序：高优先级在前', () => {
  const block = matchWorldbook('动量守恒怎么用', all, 3000);
  // 命中的动量守恒(170) + constant 自传(200)：自传在前
  assert.ok(block.indexOf('physicist 学霸自传') < block.indexOf('动量守恒'));
});

t('chain 防环（A→B→A 不死循环）', () => {
  const block = matchWorldbook('循环', all, 3000);
  assert.ok(block.includes('A'));
  assert.ok(block.includes('B'));
  assert.ok(block.split('A').length - 1 <= 2, 'A 不重复注入（seen 去重）');
});

t('token 上限截断（至少注入首条）', () => {
  const block = matchWorldbook('动量', all, 30);
  assert.ok(block, '首条必须注入');
  assert.ok(block.length <= 1000, '超限截断生效');
});

t('无命中返回空串（无 constant 的馆）', () => {
  const noConstant = [EN, MOM];
  assert.equal(matchWorldbook('今天天气怎么样', noConstant, 3000), '');
  assert.equal(matchWorldbook('', all, 3000), '');
  assert.equal(matchWorldbook('x', [], 3000), '');
});

t('hitSummary 返回结构化命中', () => {
  const hits = hitSummary(all, '牛顿定律');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'newton_laws');
  assert.equal(hits[0].verifiable, true);
});

t('MAX_CHAIN_DEPTH 导出', () => {
  assert.equal(MAX_CHAIN_DEPTH, 3);
});

console.log(`\n[worldbook-match] ${passed} 项断言全部通过`);
