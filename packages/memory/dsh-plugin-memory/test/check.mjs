// ============================================================
// 守门员规则层单测（M3 验收：规则分支全覆盖）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// ============================================================
import assert from 'node:assert/strict';
import { decide } from '../lib/gatekeeper.js';

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

t('物理知识 → knowledge_routed', () => {
  const d = decide('F = ma 是什么意思', 'F=ma 是牛顿第二定律…');
  assert.equal(d.kind, 'knowledge_routed');
});

t('物理术语（能量守恒）→ knowledge_routed', () => {
  assert.equal(decide('能量守恒定律怎么证明', '').kind, 'knowledge_routed');
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

t('信息量充足但不确定 → pending（交 LLM 层）', () => {
  const d = decide('我最近在准备热力学考试，感觉有点吃力', '加油，热力学注意卡诺循环');
  assert.equal(d.kind, 'pending');
});

t('学习类显式 → study_log 分类', () => {
  const d = decide('记住，我下周三有物理考试', '记住了，加油！');
  assert.equal(d.kind, 'save');
  if (d.kind === 'save') assert.equal(d.category, 'study_log');
});

console.log(`\n[memory-gatekeeper] ${passed} 项断言全部通过`);
