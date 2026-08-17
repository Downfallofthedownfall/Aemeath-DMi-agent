// ============================================================
// 守门员规则层单测（M3 验收：规则分支全覆盖）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// ============================================================
import assert from 'node:assert/strict';
import { decide, isStrongKnowledge, classifyKnowledgeTopic } from '../lib/gatekeeper.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

t('凭据特征 → blocked（API Key）', () => {
  const d = decide('我的 API Key 是 sk-1234567890abcdef1234567890abcdef', '好的，已记录');
  assert.equal(d.kind, 'blocked');
});

t('凭据特征 → blocked（password 词）', () => {
  assert.equal(decide('密码是 password123', '').kind, 'blocked');
});

t('显式记忆命令 → save importance=90', () => {
  const d = decide('记住，我喜欢喝拿铁咖啡', '好的，我记住了');
  assert.equal(d.kind, 'save');
  if (d.kind === 'save') {
    assert.equal(d.importance, 90);
    assert.equal(d.category, 'preference');
    assert.ok(d.content.includes('喜欢喝拿铁咖啡'));
  }
});

t('显式记忆命令（以后叫我）→ save', () => {
  const d = decide('以后叫我小星就好', '好的，小星！');
  assert.equal(d.kind, 'save');
  if (d.kind === 'save') assert.ok(d.content.includes('小星'));
});

t('显式关键词（记一下）→ save（规则初筛直达，不经 LLM）', () => {
  const d = decide('记一下，我喜欢早起跑步', '好的，记住了');
  assert.equal(d.kind, 'save');
});

t('物理公式 → knowledge_direct（规则初筛直达，不经 LLM）', () => {
  const d = decide('F = ma 是什么意思', 'F=ma 是牛顿第二定律…');
  assert.equal(d.kind, 'knowledge_direct');
  if (d.kind === 'knowledge_direct') {
    assert.ok(d.topic.length > 0);
    assert.ok(d.content.length > 0);
  }
});

t('物理术语（能量守恒）→ knowledge_direct', () => {
  assert.equal(decide('能量守恒定律怎么证明', '').kind, 'knowledge_direct');
});

t('isStrongKnowledge：公式/定律命中，闲聊不命中', () => {
  assert.ok(isStrongKnowledge('F = ma'));
  assert.ok(isStrongKnowledge('能量守恒定律'));
  assert.ok(isStrongKnowledge('求矩阵的特征值'));
  assert.ok(!isStrongKnowledge('我喜欢喝咖啡'));
  assert.ok(!isStrongKnowledge('今天天气不错'));
});

t('classifyKnowledgeTopic：优先拉丁符号，其次中文片段，无匹配兜底', () => {
  assert.equal(classifyKnowledgeTopic('F = ma 是什么意思'), 'F');
  assert.equal(classifyKnowledgeTopic('能量守恒定律怎么证明'), '能量守恒定律');
  assert.equal(classifyKnowledgeTopic('!!!'), '物理/数学');
});

t('纯情绪/过短 → skip', () => {
  assert.equal(decide('哈哈', '').kind, 'skip');
  assert.equal(decide('嗯', '').kind, 'skip');
  assert.equal(decide('好的', '').kind, 'skip');
});

t('闲聊 → skip', () => {
  assert.equal(decide('早上好呀', '').kind, 'skip');
  assert.equal(decide('今天天气怎么样', '').kind, 'skip');
});

t('信息量充足但不确定 → pending（进 L1 攒批，交 LLM 总结）', () => {
  const d = decide('我最近在准备热力学考试，感觉有点吃力', '加油，热力学注意卡诺循环');
  assert.equal(d.kind, 'pending');
});

t('学习类显式 → study_log 分类', () => {
  const d = decide('记住，我下周三有物理考试', '记住了，加油！');
  assert.equal(d.kind, 'save');
  if (d.kind === 'save') assert.equal(d.category, 'study_log');
});

t('模块代码（Modulhandbuch）→ study_log 分类', () => {
  const d = decide('记住，我这学期在上 PHY-E1 和 MATH1', '好的，已记录你的课程。');
  assert.equal(d.kind, 'save');
  if (d.kind === 'save') assert.equal(d.category, 'study_log');
});

// —— 2026-08-17 修复：身份句式直存 + 短陈述进 L1 滚动捕获 ——
t('身份句式（我是准大一）→ save user_fact（无需"记住"关键词）', () => {
  const d = decide('我是准大一', '欢迎来到大学！');
  assert.equal(d.kind, 'save');
  if (d.kind === 'save') {
    assert.equal(d.category, 'user_fact');
    assert.equal(d.importance, 85);
    assert.ok(d.content.includes('准大一'));
  }
});

t('身份句式（刚高考完/大一新生/我今年读）→ save user_fact', () => {
  const qs = ['我刚高考完', '我是大一新生', '我今年读大二', '我马上要上大学了', '准大一，请多指教'];
  for (const q of qs) {
    const d = decide(q, '');
    assert.equal(d.kind, 'save', `应直存: ${q}`);
    if (d.kind === 'save') assert.equal(d.category, 'user_fact');
  }
});

t('疑问句不被误判为身份（我是想问…）→ 不进 save', () => {
  assert.notEqual(decide('我是想问一下这道题怎么做', '').kind, 'save');
  assert.notEqual(decide('我是想问F=ma怎么推导', '').kind, 'save');
});

t('短陈述（≥2 字、非闲聊）→ pending 进 L1 滚动捕获（不再静默丢弃）', () => {
  const d = decide('在学热力学', '加油');
  assert.equal(d.kind, 'pending');
});

t('纯占位单字仍 → skip', () => {
  assert.equal(decide('嗯', '').kind, 'skip');
  assert.equal(decide('哦', '').kind, 'skip');
});

console.log(`\n[memory-gatekeeper] ${passed} 项断言全部通过`);
