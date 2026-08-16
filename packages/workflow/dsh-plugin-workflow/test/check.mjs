// ============================================================
// 解题分流单测（M6：plan/direct 判定 + SOLVER_PROMPT 完整性）
// 运行：npm test -w @aemeath/dsh-plugin-workflow
// ============================================================
import assert from 'node:assert/strict';
import { routeQuery, SOLVER_PROMPT, LONG_QUERY_LENGTH } from '../lib/route.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

t('解题触发词 → plan（求解）', () => {
  assert.equal(routeQuery('求解方程 x²-4=0').kind, 'plan');
});

t('解题触发词 → plan（推导/证明/计算/分析）', () => {
  for (const q of ['推导能量守恒公式', '证明动量守恒', '计算加速度', '分析这个力系']) {
    assert.equal(routeQuery(q).kind, 'plan', q);
  }
});

t('英文/德文触发词 → plan', () => {
  assert.equal(routeQuery('Berechnen Sie die Ableitung').kind, 'plan');
  assert.equal(routeQuery('compute the integral').kind, 'plan');
});

t('长问题（>80 字）→ plan', () => {
  const long = '请帮我详细分析这个力学系统：一个质量为m的物块放在倾角为θ的斜面上，斜面与物块间动摩擦系数为μ，' + '求物块沿斜面下滑的加速度，并讨论θ取不同值时物块的运动状态变化。'.repeat(2);
  assert.ok(long.length > LONG_QUERY_LENGTH);
  assert.equal(routeQuery(long).kind, 'plan');
});

t('日常对话 → direct', () => {
  for (const q of ['你好', '今天天气怎么样', '讲讲星炬学院吧', '我有点累了']) {
    assert.equal(routeQuery(q).kind, 'direct', q);
  }
});

t('空输入 → direct', () => {
  assert.equal(routeQuery('').kind, 'direct');
});

t('SOLVER_PROMPT 含关键规范要素', () => {
  assert.ok(SOLVER_PROMPT.includes('计划'));
  assert.ok(SOLVER_PROMPT.includes('compute_verify'));
  assert.ok(SOLVER_PROMPT.includes('✅'));
  assert.ok(SOLVER_PROMPT.includes('❌'));
  assert.ok(SOLVER_PROMPT.includes('来源'));
  assert.ok(SOLVER_PROMPT.includes('查证'));
});

t('SOLVER_PROMPT 含 M6 v2 要素（plan_step 落 scratch + check_dimensions 量纲）', () => {
  assert.ok(SOLVER_PROMPT.includes('plan_step'), '应引导模型用 plan_step 落计划');
  assert.ok(SOLVER_PROMPT.includes('plan_status'), '应引导模型用 plan_status 核对');
  assert.ok(SOLVER_PROMPT.includes('check_dimensions'), '应引导模型用量纲检查');
  assert.ok(SOLVER_PROMPT.includes('scratch'), '应提到 scratch');
});

console.log(`\n[workflow-route] ${passed} 项断言全部通过`);
