// ============================================================
// 分层记忆纯函数单测（M3.4：L1 容量阈值 / 封顶 / 兜底卸载 / 落库查重 / 提示词）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// ============================================================
import assert from 'node:assert/strict';
import { shouldTriggerL1, appendL1, removeL1Turns, fallbackUnload, consolidateTarget, buildSummarizePrompt, estimateTokens, sessionTokens, shouldTriggerL1ByTokens } from '../lib/layers.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const mkTurn = (over) => ({ sessionId: 's', query: 'q', reply: 'r', preset: 'physicist', ts: 1, kind: 'fact', ...over });

// —— 80% 阈值触发 ——
t('shouldTriggerL1：容量 40 阈值 0.8 → 32 轮触发', () => {
  assert.ok(!shouldTriggerL1(31, 40, 0.8));
  assert.ok(shouldTriggerL1(32, 40, 0.8));
  assert.ok(shouldTriggerL1(40, 40, 0.8));
});

t('shouldTriggerL1：边界与非法参数', () => {
  assert.ok(!shouldTriggerL1(0, 40, 0.8));
  assert.ok(!shouldTriggerL1(5, 0, 0.8));
  assert.ok(!shouldTriggerL1(3, 40, 0.1), '阈值 0.1 → ceil(40×0.1)=4 轮触发，3 轮不触发');
  assert.ok(shouldTriggerL1(4, 40, 0.1), '阈值 0.1 → 4 轮触发');
  assert.ok(shouldTriggerL1(1, 40, 0), '阈值 0 → 1 轮即触发');
});

t('appendL1：追加并封顶（丢弃最旧）', () => {
  let buf = [];
  for (let i = 0; i < 45; i++) buf = appendL1(buf, mkTurn({ query: `q${i}` }), 40);
  assert.equal(buf.length, 40);
  assert.equal(buf[0].query, 'q5', '最旧 5 条被丢弃，q5 成为队首');
  assert.equal(buf[39].query, 'q44');
});

t('removeL1Turns：精确移除（并发保护）', () => {
  const a = mkTurn({ query: 'a' });
  const b = mkTurn({ query: 'b' });
  const c = mkTurn({ query: 'c' });
  const buf = [a, b, c];
  assert.deepEqual(removeL1Turns(buf, [a, b]), [c], '只移除快照中的轮次');
  assert.deepEqual(removeL1Turns(buf, [a, b, c]), []);
});

// —— 规则兜底卸载 ——
t('fallbackUnload：knowledge 轮 → 知识候选', () => {
  const { result, dropped } = fallbackUnload([mkTurn({ query: 'F=ma 是什么意思', reply: '牛顿第二定律…', kind: 'knowledge' })]);
  assert.equal(result.knowledge.length, 1);
  assert.equal(result.memories.length, 0);
  assert.equal(dropped, 0);
});

t('fallbackUnload：fact 轮只保留规则层 save；无定论丢弃计数', () => {
  const { result, dropped } = fallbackUnload([mkTurn({ query: '我最近在准备热力学考试，感觉有点吃力' })]);
  assert.equal(result.memories.length, 0, 'pending 轮在规则兜底中无定论');
  assert.equal(dropped, 1);
});

t('fallbackUnload：显式"记住"已在即时通道，缓冲内 save 仍会兜底落库', () => {
  const { result } = fallbackUnload([mkTurn({ query: '记住，我喜欢喝拿铁咖啡' })]);
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].category, 'preference');
  assert.equal(result.memories[0].importance, 90);
});

// —— 落库查重 consolidate ——
t('consolidateTarget：无相似 → save', () => {
  assert.deepEqual(consolidateTarget('我新买了一只猫', [{ id: 'a', content: '我喜欢喝拿铁咖啡' }]), { action: 'save' });
});

t('consolidateTarget：高相似 + 时间证据 → supersede', () => {
  const existing = [{ id: 'a', content: '我下周三有物理考试' }];
  assert.deepEqual(consolidateTarget('我周三的物理考试考完了', existing), { action: 'supersede', targetId: 'a' });
});

t('consolidateTarget：高相似无时间证据 → merge', () => {
  const existing = [{ id: 'a', content: '我下周三有物理考试' }];
  assert.deepEqual(consolidateTarget('我下周三有物理考试，有点紧张', existing), { action: 'merge', targetId: 'a' });
});

// —— 总结提示词 ——
t('buildSummarizePrompt：含缓冲轮次与相似记忆上下文', () => {
  const prompt = buildSummarizePrompt([mkTurn({ query: '我下周三有物理考试' })], [{ id: 'abc', content: '我下周三有物理考试' }]);
  assert.ok(prompt.includes('memories'));
  assert.ok(prompt.includes('knowledge'));
  assert.ok(prompt.includes('我下周三有物理考试'));
  assert.ok(prompt.includes('abc'));
});

// —— 2026-08-17 修复：token 预算化 ——
t('estimateTokens：中文按 1.5 token/字，ASCII 按 4 字符/token', () => {
  assert.ok(estimateTokens('我是准大一') > 0);
  assert.ok(estimateTokens('abcdefgh') >= 2);
  assert.equal(estimateTokens(''), 0);
});

t('sessionTokens：多轮累计（query + reply）', () => {
  const buf = [mkTurn({ query: '我是准大一', reply: '欢迎' }), mkTurn({ query: '我今年读大二', reply: '好的' })];
  const t1 = estimateTokens('我是准大一') + estimateTokens('欢迎');
  const t2 = estimateTokens('我今年读大二') + estimateTokens('好的');
  assert.equal(sessionTokens(buf), t1 + t2);
});

t('shouldTriggerL1ByTokens：达预算触发，预算 ≤0 不启用', () => {
  assert.ok(shouldTriggerL1ByTokens(3000, 3000));
  assert.ok(shouldTriggerL1ByTokens(3200, 3000));
  assert.ok(!shouldTriggerL1ByTokens(2999, 3000));
  assert.ok(!shouldTriggerL1ByTokens(9999, 0), '预算 0 → 不启用');
});

t('buildSummarizePrompt：超长 query/reply 被截断（防提示词撑爆）', () => {
  const longReply = 'x'.repeat(2000);
  const prompt = buildSummarizePrompt([mkTurn({ query: 'q', reply: longReply })], []);
  assert.ok(prompt.length < 1500, '超长回复被截断，提示词有界');
  assert.ok(prompt.includes('…'));
});

console.log(`\n[memory-layers] ${passed} 项断言全部通过`);
