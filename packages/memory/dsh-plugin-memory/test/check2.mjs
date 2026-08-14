// ============================================================
// BM25 查重 + 时间证据单测（M3 v2）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// ============================================================
import assert from 'node:assert/strict';
import { tokenize, search } from '../lib/bm25.js';
import { hasTimeEvidence } from '../lib/gatekeeper.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const DOCS = [
  { id: 'a', content: '我下周三有物理考试，我有点紧张' },
  { id: 'b', content: '我喜欢喝拿铁咖啡' },
  { id: 'c', content: '我在汉堡大学读物理专业' },
];

t('tokenize：英文词 + 中文 bigram', () => {
  const toks = tokenize('F = ma 物理');
  assert.ok(toks.includes('f'));
  assert.ok(toks.includes('ma'));
  assert.ok(toks.includes('物理'));
  assert.ok(toks.includes('物理'.slice(0, 2)) || toks.includes('物理'));
});

t('BM25 中文检索命中相关文档', () => {
  const hits = search('我下周物理考试', DOCS, 2);
  assert.equal(hits[0].id, 'a');
  assert.ok(hits[0].score > 0);
});

t('BM25 英文混合命中', () => {
  const hits = search('物理专业 汉堡大学', DOCS, 1);
  assert.equal(hits[0].id, 'c');
});

t('BM25 top-k 截断', () => {
  const hits = search('物理', DOCS, 2);
  assert.ok(hits.length <= 2);
});

t('BM25 空输入返回空', () => {
  assert.deepEqual(search('', DOCS, 3), []);
  assert.deepEqual(search('x', [], 3), []);
});

t('BM25 无关查询分数低/无命中', () => {
  const hits = search('今天天气很好', DOCS, 3);
  assert.ok(hits.every((h) => h.score < 1), '无关查询不应高分');
});

t('时间证据：考完了 → true', () => {
  assert.ok(hasTimeEvidence('我周三的物理考试考完了'));
  assert.ok(hasTimeEvidence('已经学会动量守恒了'));
  assert.ok(hasTimeEvidence('不需要再提醒我考试了'));
});

t('时间证据：无变化信号 → false', () => {
  assert.ok(!hasTimeEvidence('我下周三有物理考试'));
  assert.ok(!hasTimeEvidence('我喜欢喝咖啡'));
});

console.log(`\n[memory-bm25+conflict] ${passed} 项断言全部通过`);
