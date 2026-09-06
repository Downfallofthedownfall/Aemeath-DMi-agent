// ============================================================
// A3 mood observer + A4 relationship cue 纯函数单测（借 Cyrene 想法）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// 注：LLM 通道默认关（llm.enabled=false），此处只测确定性规则兜底与平滑，
//    绝不依赖网络。
// ============================================================
import assert from 'node:assert/strict';
import {
  classifyMoodStable,
  pushMoodWindow,
  majorityLabel,
  relationshipSignalOf,
  nextCareCueOf,
  buildRelationshipCue,
  MOOD_WINDOW_CAP,
} from '../lib/mood.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// —— 确定性情绪分类（规则兜底，稳定） ——
t('classifyMoodStable：开心关键词 → 开心', () => {
  assert.equal(classifyMoodStable('我今天好开心啊'), '开心');
  assert.equal(classifyMoodStable('哈哈太棒了', '好的！'), '开心');
});

t('classifyMoodStable：难过关键词 → 难过', () => {
  assert.equal(classifyMoodStable('我有点难过'), '难过');
  assert.equal(classifyMoodStable('我好难过，哭了', '别哭，我在'), '难过');
});

t('classifyMoodStable：生气/害羞 → 对应标签', () => {
  assert.equal(classifyMoodStable('气死我了'), '生气');
  assert.equal(classifyMoodStable('有点不好意思'), '害羞');
});

t('classifyMoodStable：疑问/思考 → 思考', () => {
  assert.equal(classifyMoodStable('为什么这道题这样解'), '思考');
  assert.equal(classifyMoodStable('我在纠结要选哪个'), '思考');
});

t('classifyMoodStable：无情绪信号 → 平静', () => {
  assert.equal(classifyMoodStable('嗯', '好'), '平静');
  assert.equal(classifyMoodStable('' , ''), '平静');
});

// —— 滚动平滑（多数表决，不随单轮剧烈跳变） ——
t('pushMoodWindow 封顶：长度不超过 MOOD_WINDOW_CAP', () => {
  let w = [];
  for (let i = 0; i < 10; i++) w = pushMoodWindow(w, '开心'); 
  assert.equal(w.length, MOOD_WINDOW_CAP);
  assert.equal(w[0], '开心');
});

t('majorityLabel：多数票生效', () => {
  assert.equal(majorityLabel(['平静', '开心', '开心']), '开心');
});

t('majorityLabel：平局取最近出现者', () => {
  // 加计数相同：2 开心 / 2 平静，最近观测为 平静 → 返回 平静
  assert.equal(majorityLabel(['开心', '平静', '开心', '平静']), '平静');
});

t('majorityLabel：空窗口 → 平静', () => {
  assert.equal(majorityLabel([]), '平静');
});

t('smooth：单轮负面不覆盖连续正面观察', () => {
  // 已有 4 个 '平静'，来一个 '难过' → 多数仍是 '平静'
  const w = pushMoodWindow(['平静', '平静', '平静', '平静'], '难过');
  assert.equal(majorityLabel(w), '平静');
});

// —— 关系信号 / 照顾提示 ——
t('relationshipSignalOf / nextCareCueOf：确定性且非空', () => {
  assert.ok(relationshipSignalOf('难过').length > 0);
  assert.ok(nextCareCueOf('难过').length > 0);
  assert.match(relationshipSignalOf('难过'), /低落/);
  assert.match(nextCareCueOf('难过'), /安慰/);
});

// —— 关系线索注入块 ——
t('buildRelationshipCue：空记录 → 空串', () => {
  assert.equal(buildRelationshipCue(undefined), '');
  assert.equal(buildRelationshipCue(null), '');
  assert.equal(buildRelationshipCue({}), '');
});

t('buildRelationshipCue：含有内容时生成【近期关系线索】块', () => {
  const block = buildRelationshipCue({ mood: '难过', signal: '用户情绪低落，需要倾听', preference: '', nextCareCue: '先安慰陪伴' });
  assert.ok(block.startsWith('【近期关系线索】'));
  assert.match(block, /难过/);
  assert.match(block, /用户情绪低落/);
  assert.match(block, /先安慰陪伴/);
});

t('buildRelationshipCue：只填 preference 也应成块', () => {
  assert.match(buildRelationshipCue({ preference: '喜欢喝美式' }), /用户偏好：喜欢喝美式/);
});

console.log(`\n[memory-mood] ${passed} 项断言全部通过`);
