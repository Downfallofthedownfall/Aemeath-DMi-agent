// ============================================================
// 守门员规则层单测（M3 验收：规则分支全覆盖）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// ============================================================
import assert from 'node:assert/strict';
import { decide, isStrongKnowledge, classifyKnowledgeTopic, writeGate, classifyConflict } from '../lib/gatekeeper.js';
import { buildWorldbookTriggers } from '../lib/layers.js';

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

t('用户陈述的公式 → knowledge_direct（规则初筛直达，不经 LLM）', () => {
  const d = decide('F = ma 是牛顿第二定律', '对');
  assert.equal(d.kind, 'knowledge_direct');
  if (d.kind === 'knowledge_direct') {
    assert.ok(d.topic.length > 0);
    assert.ok(d.content.length > 0);
  }
});

t('问句不是知识：含术语的提问进 L1，不直达', () => {
  assert.equal(decide('能量守恒定律怎么证明', '').kind, 'pending');
  assert.equal(decide('F = ma 是什么意思', 'F=ma 是牛顿第二定律…').kind, 'pending');
});

t('第一人称不是知识：用户的进度/状态不能被当成知识吞掉', () => {
  assert.equal(decide('我下周三考 Physik 1，能帮我看看这道积分吗', '分部积分 ∫x dx').kind, 'pending');
  assert.equal(decide('今天我复习了电磁学，麦克斯韦方程组还是记不住', '方程组是…').kind, 'pending');
});

t('公式里的符号 I / i 不是第一人称；含"几 / 么"的陈述不是问句', () => {
  assert.equal(decide('欧姆定律 U = R I', '对').kind, 'knowledge_direct');
  assert.equal(decide('欧拉公式 e^(i π) + 1 = 0，由 cos 和 sin 的级数得到', '对').kind, 'knowledge_direct');
  assert.equal(decide('解析几何里椭圆的离心率由焦距决定，面积用积分算', '对').kind, 'knowledge_direct');
  assert.equal(decide('I think F = ma is wrong', 'no').kind, 'pending');
  assert.equal(decide("I'm stuck on the integral ∫x dx", 'ok').kind, 'pending');
  assert.equal(decide('椭圆的离心率是几', '').kind, 'pending');
});

t('模型回复里的公式不直达（没核实的输出，交总结层进 pending 评审）', () => {
  assert.equal(decide('这道题我不太懂，能讲讲吗', '根据牛顿第二定律 F=ma，可得 a=2').kind, 'pending');
});

t('三角函数按整词匹配（instance / standard 不算知识）', () => {
  assert.ok(isStrongKnowledge('sin(x) 的导数'));
  assert.ok(!isStrongKnowledge('an instance of standard usage'));
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

// —— B5：user_fact 写门（Cyrene L0 身份：只收用户明确自述；锁存/幻觉拦截） ——
t('B5 writeGate：第一人称直陈自述 → accept', () => {
  const v = writeGate('我是准大一', '我是准大一');
  assert.equal(v.action, 'accept');
  assert.ok(v.reason.includes('第一人称'));
});

t('B5 writeGate：用户锁存（别记/忘了它）→ drop', () => {
  assert.equal(writeGate('别记这个，我只是随便说说', '我是准大一').action, 'drop');
  assert.equal(writeGate('忘了它吧', '我喜欢喝咖啡').action, 'drop');
  assert.equal(writeGate('不要记这个', '我是准大一').action, 'drop');
});

t('B5 writeGate：空/悬挂字段名（疑似幻觉）→ drop', () => {
  assert.equal(writeGate('我是准大一', '不详').action, 'drop');
  assert.equal(writeGate('我是准大一', '  ').action, 'drop');
  assert.equal(writeGate('我是准大一', '').action, 'drop');
});

t('B5 writeGate：非第一人称 → demote（降置信，仍保存）', () => {
  const v = writeGate('他是准大一', '准大一，请多指教');
  assert.equal(v.action, 'demote');
  assert.equal(v.confidence, 0.5);
});

t('B5 writeGate：疑问句式非自述 → demote', () => {
  const v = writeGate('我是准大一吗？', '我是准大一吗');
  assert.equal(v.action, 'demote');
  assert.equal(v.confidence, 0.5);
});

// —— B6：类型化冲突（Cyrene：preference_evolution / direct_conflict） ——
t('B6 classifyConflict：偏好改变 → preference_evolution（新值生效）', () => {
  const c = classifyConflict('我喜欢喝拿铁咖啡', '我现在更喜欢喝美式咖啡', 'preference', 'preference');
  assert.equal(c.type, 'preference_evolution');
  assert.equal(c.viaLlm, false);
  assert.ok(c.reason.includes('偏好演变'));
});

t('B6 classifyConflict：时间证据状态变化 → direct_conflict（新值生效）', () => {
  const c = classifyConflict('我下周三有物理考试', '我周三的物理考试考完了', 'study_log', 'study_log');
  assert.equal(c.type, 'direct_conflict');
  assert.equal(c.viaLlm, false);
});

t('B6 classifyConflict：非偏好无时间证据高相似 → 默认 direct_conflict', () => {
  const c = classifyConflict('我下周三有物理考试', '我下周三有物理考试，有点紧张', 'study_log', 'study_log');
  assert.equal(c.type, 'direct_conflict');
});

t('世界书触发词：不产出单字母、虚词（否则任何问题都会误中）', () => {
  const t1 = buildWorldbookTriggers('F=ma', 'F');
  assert.deepEqual(t1, ['F=ma']);
  const t2 = buildWorldbookTriggers('能量守恒的一个应用是什么', '能量守恒');
  assert.ok(t2.includes('能量守恒'));
  assert.ok(!t2.includes('的一') && !t2.includes('一个') && !t2.includes('什么'));
  assert.ok(buildWorldbookTriggers('Newton law of motion', '').every((w) => w.length >= 3));
  assert.ok(buildWorldbookTriggers('很长的内容一二三四五六七八九十'.repeat(5), '主题').length <= 6);
});

console.log(`\n[memory-gatekeeper] ${passed} 项断言全部通过`);
