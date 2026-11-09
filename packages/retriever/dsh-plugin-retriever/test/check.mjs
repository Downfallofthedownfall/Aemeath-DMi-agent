// ============================================================
// 讲义分块单测（M4：按 ## 切块 + 超长二次切分）
// 运行：npm test -w @aemeath/dsh-plugin-retriever
// ============================================================
import assert from 'node:assert/strict';
import { chunkText } from '../lib/chunker.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const SAMPLE = `# 力学讲义（示例）

## 牛顿运动定律
牛顿第二定律：F = ma。合外力等于质量乘加速度。

## 能量守恒
功 W = F·s·cosθ。机械能守恒：Ek + Ep = 常量。

## 动量守恒
系统合外力为零时总动量守恒。碰撞问题常与能量守恒联用。`;

t('按二级标题切块（含前言与 3 节）', () => {
  const chunks = chunkText('mechanics.txt', SAMPLE);
  assert.ok(chunks.length >= 3, `至少 3 块，实际 ${chunks.length}`);
  const sections = chunks.map((c) => c.section);
  assert.ok(sections.includes('牛顿运动定律'));
  assert.ok(sections.includes('能量守恒'));
  assert.ok(sections.includes('动量守恒'));
});

t('块 id 带文件前缀且唯一', () => {
  const chunks = chunkText('mechanics.txt', SAMPLE);
  const ids = new Set(chunks.map((c) => c.id));
  assert.equal(ids.size, chunks.length, 'id 唯一');
  assert.ok(chunks.every((c) => c.id.startsWith('mechanics.txt#')));
});

t('超长块按段落二次切分（≤maxLen）', () => {
  const long = '## 超长节\n' + Array.from({ length: 60 }, (_, i) => `这是第${i}段内容，讲物理知识，够长了吧。`).join('\n');
  const chunks = chunkText('long.txt', long, 200);
  assert.ok(chunks.every((c) => c.content.length <= 200), '每块 ≤200');
  assert.ok(chunks.length > 1, '切成了多块');
});

t('空输入返回空数组', () => {
  assert.deepEqual(chunkText('empty.txt', ''), []);
  assert.deepEqual(chunkText('empty.txt', '   '), []);
});

import('../lib/fts.js').then(({ queryTerms, buildFtsQuery, isRelevantChunk, toIndexable }) => {
  const idx = toIndexable('拉格朗日量 L = T - V，欧拉-拉格朗日方程');
  t('讲义相关度：问到内容才算命中', () => {
    assert.ok(isRelevantChunk(queryTerms('请推导拉格朗日方程'), idx));
    assert.ok(isRelevantChunk(queryTerms('拉格朗日'), idx));
  });
  t('讲义相关度：只撞上一个词 / 只有常用词不算', () => {
    assert.ok(!isRelevantChunk(queryTerms('今天天气方程式赛车比赛怎么样'), idx));
    assert.equal(queryTerms('什么').length, 0);
    assert.equal(queryTerms('怎么').length, 0);
    assert.ok(!isRelevantChunk([], idx));
  });
  t('讲义相关度：中文提问里夹一个外文术语也能命中外文讲义', () => {
    const de = toIndexable('Der Drehimpuls L = r x p ist eine Erhaltungsgroesse im Zentralfeld');
    assert.ok(isRelevantChunk(queryTerms('Drehimpuls 怎么推导'), de));
    assert.ok(isRelevantChunk(queryTerms('explain Drehimpuls'), de));
    assert.ok(!isRelevantChunk(queryTerms('PDF 怎么导入进来'), toIndexable('siehe PDF im Anhang')), '太短的外文词不能单独算命中');
  });
  t('讲义相关度：外文常用词不算命中', () => {
    const de = toIndexable('Der Drehimpuls ist eine Erhaltungsgroesse und die Energie ist auch erhalten');
    assert.deepEqual(queryTerms('what is the weather'), ['weather']);
    assert.ok(!isRelevantChunk(queryTerms('wie ist das Wetter und der Verkehr'), de));
  });
  t('FTS 查询：去重并转义', () => {
    assert.equal(buildFtsQuery(queryTerms('电场电场')), '"电场" OR "场电"');
  });
  console.log(`\n[retriever-chunker] ${passed} 项断言全部通过`);
});
