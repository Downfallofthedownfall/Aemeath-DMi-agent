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

console.log(`\n[memory-gatekeeper] ${passed} 项断言全部通过`);
