// ============================================================
// T3 autoDream 空闲整合 · 纯函数单测（借 ripples-of-aion 的
// entityClustersOf / pruneClustersByCentroid / candidatePairsOf 思想）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// 注：零网络、零 IO；只测纯函数（整合器与不变量在 check9 集成测）。
// ============================================================
import assert from 'node:assert/strict';
import {
  entityClustersOf,
  pruneClustersByCentroid,
  candidatePairsOf,
  sanitizeLabels,
  sanitizeConflicts,
  sanitizeInsights,
  buildInsightsPrompt,
  parseLlmJson,
  toIndex,
  EMPTY_INSIGHTS,
  Consolidator,
} from '../lib/insights.js';
import {
  CONSOLIDATION_HUB_MIN_RECORDS,
  CONSOLIDATION_MAX_CANDIDATE_PAIRS,
  CONSOLIDATION_MAX_CLUSTERS,
  CONSOLIDATION_MAX_CONFLICTS,
} from '../lib/limits.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// 造一条带 claim 的记忆记录
let seq = 0;
const claim = (attribute, value, entity = '用户') => ({ entity, attribute, value, valid_from: 1000, valid_until: null });
const rec = (content, claims = [], id) => ({ id: id ?? `m${++seq}`, content, entity_claims: claims, deleted: false });

// ——————————————————————————————————————————————
// entityClustersOf：实体连通分量 + 枢纽实体排除
// ——————————————————————————————————————————————
t('entityClustersOf：共享非枢纽实体 → 同簇（并查集传递）', () => {
  const records = [
    rec('a', [claim('专业', '物理')], 'a'),
    rec('b', [claim('专业', '物理'), claim('所在地', '北京')], 'b'),
    rec('c', [claim('所在地', '北京')], 'c'),
  ];
  const clusters = entityClustersOf(records);
  assert.deepEqual(clusters, [['a', 'b', 'c']]);
});

t('entityClustersOf：无共享实体 → 各自单点，单点簇被过滤 → 空', () => {
  // 注意：簇的连通性只看 claim 的 entity（用户/物理/数学…），属性名不参与
  const records = [rec('a', [claim('专业', '物理', '物理')], 'a'), rec('b', [claim('专业', '数学', '数学')], 'b'), rec('c', [claim('所在地', '柏林', '柏林')], 'c')];
  assert.deepEqual(entityClustersOf(records), []);
});

t('entityClustersOf：枢纽实体不参与连通（≥ max(50%N, 8) 次出现）', () => {
  // 8 条记录全挂「用户」枢纽（出现 8 次 = 绝对下限）→ 它自己一次 union 都不做；
  // 另有 3 条额外共享非枢纽实体「物理」→ 这 3 条才成簇。
  const records = [];
  for (let i = 0; i < 8; i++) records.push(rec(`r${i}`, [claim('姓名', `名字${i}`, '用户')], `user${i}`));
  for (let i = 0; i < 3; i++) records.push(rec(`p${i}`, [claim('课程', 'PHY-E1', '物理')], `phy${i}`));
  assert.equal(CONSOLIDATION_HUB_MIN_RECORDS, 8);
  assert.deepEqual(entityClustersOf(records), [['phy0', 'phy1', 'phy2']]);
});

t('entityClustersOf：小库里的高频实体不被误判为枢纽（绝对下限 8 生效）', () => {
  // N=3：ceil(3*0.5)=2，但绝对下限 8 更大 → 出现 3 次的实体**仍**参与连通
  const records = [rec('a', [claim('姓名', '用户')], 'a'), rec('b', [claim('姓名', '用户')], 'b'), rec('c', [claim('姓名', '用户')], 'c')];
  assert.deepEqual(entityClustersOf(records), [['a', 'b', 'c']]);
});

t('entityClustersOf：簇按大小降序，且不超过 MAX_CLUSTERS', () => {
  const records = [];
  for (let g = 0; g < CONSOLIDATION_MAX_CLUSTERS + 3; g++) {
    for (let k = 0; k <= g; k++) records.push(rec(`g${g}k${k}`, [claim('课程', `课程${g}`)]));
  }
  const clusters = entityClustersOf(records);
  assert.ok(clusters.length <= CONSOLIDATION_MAX_CLUSTERS);
  for (let i = 1; i < clusters.length; i++) assert.ok(clusters[i - 1].length >= clusters[i].length);
});

t('entityClustersOf：deleted 不在输入范围内由调用方过滤；空输入 → 空', () => {
  assert.deepEqual(entityClustersOf([]), []);
});

// ——————————————————————————————————————————————
// pruneClustersByCentroid：质心剪枝
// ——————————————————————————————————————————————
t('pruneClustersByCentroid：离群成员被剔除', () => {
  const vectors = { a: [1, 0], b: [0.99, 0.01], c: [-1, 0] };
  const out = pruneClustersByCentroid([['a', 'b', 'c']], (id) => vectors[id]);
  assert.deepEqual(out, [['a', 'b']]);
});

t('pruneClustersByCentroid：剪枝后剩 1 人 → 整簇丢弃', () => {
  const vectors = { a: [1, 0], b: [0.99, 0.01], c: [-1, 0] };
  const out = pruneClustersByCentroid([['a', 'c']], (id) => vectors[id]);
  assert.deepEqual(out, []);
});

t('pruneClustersByCentroid：向量缺失 / 长度不符 → 原样返回不校验', () => {
  const missing = pruneClustersByCentroid([['a', 'b', 'c']], (id) => (id === 'c' ? undefined : [1, 0]));
  assert.deepEqual(missing, [['a', 'b', 'c']]);
  const badDim = pruneClustersByCentroid([['a', 'b']], (id) => (id === 'a' ? [1, 0] : [1, 0, 0]));
  assert.deepEqual(badDim, [['a', 'b']]);
});

t('pruneClustersByCentroid：全部贴合质心 → 全保留', () => {
  const out = pruneClustersByCentroid([['a', 'b', 'c']], () => [1, 1]);
  assert.deepEqual(out, [['a', 'b', 'c']]);
});

// ——————————————————————————————————————————————
// candidatePairsOf：共现对 ∪ 簇内对 → 去重 → 热度降序 → 截断 → 过时间轴过滤
// ——————————————————————————————————————————————
t('candidatePairsOf：5 条同实体记录 → 10 个唯一对，元素升序、自身不成对', () => {
  const records = ['a', 'b', 'c', 'd', 'e'].map((id) => rec(`内容${id}`, [claim('课程', 'PHY-E1')], id));
  const pairs = candidatePairsOf(records, [], () => 0);
  assert.equal(pairs.length, 10);
  for (const [x, y] of pairs) {
    assert.ok(x < y); // 归一化顺序
    assert.notEqual(x, y);
  }
  assert.equal(new Set(pairs.map((p) => p.join('|'))).size, 10); // 无重复
});

t('candidatePairsOf：共现对与簇内对去重（不重复上报同一对）', () => {
  const records = ['a', 'b', 'c'].map((id) => rec(`内容${id}`, [claim('课程', 'PHY-E1')], id));
  const pairs = candidatePairsOf(records, [['a', 'b', 'c']], () => 0);
  assert.equal(pairs.length, 3); // 共现与簇内是同一批对 → 去重后仍是 3
});

t('candidatePairsOf：按 heat 之和降序', () => {
  const records = ['a', 'b', 'c'].map((id) => rec(`内容${id}`, [claim('课程', 'PHY-E1')], id));
  const heat = { a: 90, b: 50, c: 1 };
  const pairs = candidatePairsOf(records, [], (id) => heat[id]);
  assert.deepEqual(pairs[0], ['a', 'b']); // 90+50 = 140 最高
  assert.deepEqual(pairs[1], ['a', 'c']); // 91
  assert.deepEqual(pairs[2], ['b', 'c']); // 51
});

t('candidatePairsOf：截断到 MAX_CANDIDATE_PAIRS（40）', () => {
  const records = [];
  for (let i = 0; i < 30; i++) records.push(rec(`r${i}`, [claim('课程', 'PHY-E1')], `id${i}`)); // C(30,2)=435
  const pairs = candidatePairsOf(records, [], () => 0);
  assert.equal(pairs.length, CONSOLIDATION_MAX_CANDIDATE_PAIRS);
});

t('candidatePairsOf：过时间轴过滤——一侧已闭合 → 不算矛盾候选', () => {
  const closed = rec('去年住北京', [{ entity: '用户', attribute: '所在地', value: '北京', valid_from: 1000, valid_until: 5000 }], 'old');
  const now = rec('今年搬到上海', [claim('所在地', '上海')], 'new');
  assert.deepEqual(candidatePairsOf([closed, now], [], () => 1), []);
});

t('candidatePairsOf：共同键但都未闭合 → 仍作为矛盾候选上报', () => {
  const a = rec('结论用A法', [claim('结论', '用A法')], 'a');
  const b = rec('结论用B法', [claim('结论', '用B法')], 'b');
  assert.deepEqual(candidatePairsOf([a, b], [], () => 1), [['a', 'b']]);
});

// ——————————————————————————————————————————————
// 输出回收：sanitizeLabels / sanitizeConflicts / sanitizeInsights
// ——————————————————————————————————————————————
t('sanitizeLabels：合法下标 + 标签回收；越界/重复/空标签丢弃', () => {
  const out = sanitizeLabels({ clusters: [{ index: 0, label: '  物理学习  ' }, { index: 5, label: '越界' }, { index: 1, label: '' }, { index: 1, label: '第二个' }, { index: 1.5, label: '小数' }] }, 3);
  assert.equal(out.get(0), '物理学习'); // trim
  assert.equal(out.get(1), '第二个');
  assert.equal(out.has(5), false);
  assert.equal(out.size, 2);
});

t('sanitizeLabels：非对象/缺 clusters → 空 Map（不抛）', () => {
  assert.equal(sanitizeLabels(null, 3).size, 0);
  assert.equal(sanitizeLabels({}, 3).size, 0);
  assert.equal(sanitizeLabels('坏输出', 3).size, 0);
});

t('sanitizeConflicts：越界 / a===b / 空 note / 重复对 → 丢弃', () => {
  const out = sanitizeConflicts(
    {
      conflicts: [
        { a: 0, b: 1, note: '真矛盾' },
        { a: 0, b: 0, note: '自比' },
        { a: 0, b: 9, note: '越界' },
        { a: 1, b: 0, note: '重复对（反序）' },
        { a: 2, b: 3, note: '' },
      ],
    },
    5,
  );
  assert.deepEqual(out, [{ a: 0, b: 1, note: '真矛盾' }]);
});

t('sanitizeConflicts：上限 MAX_CONFLICTS', () => {
  const conflicts = [];
  for (let i = 0; i < CONSOLIDATION_MAX_CONFLICTS + 20; i++) conflicts.push({ a: i, b: i + 1, note: `n${i}` });
  const out = sanitizeConflicts({ conflicts }, CONSOLIDATION_MAX_CONFLICTS + 40);
  assert.equal(out.length, CONSOLIDATION_MAX_CONFLICTS);
});

t('sanitizeInsights：合法结构原样保留', () => {
  const raw = {
    version: 1,
    last_run_at: 12345,
    clusters: [{ id: 'cluster_1', label: '物理', recordIds: ['a', 'b'], created_at: 1 }],
    conflicts: [{ id: 'conflict_1', note: '冲突', recordIds: ['a', 'b'], created_at: 1 }],
  };
  assert.deepEqual(sanitizeInsights(raw), raw);
});

t('sanitizeInsights：缺 version / 类型错 / recordIds 为空 → 回落 EMPTY_INSIGHTS', () => {
  assert.deepEqual(sanitizeInsights({ last_run_at: 1, clusters: [], conflicts: [] }), EMPTY_INSIGHTS);
  assert.deepEqual(sanitizeInsights({ version: 2, last_run_at: 1, clusters: [], conflicts: [] }), EMPTY_INSIGHTS);
  assert.deepEqual(sanitizeInsights(null), EMPTY_INSIGHTS);
  assert.deepEqual(sanitizeInsights('坏'), EMPTY_INSIGHTS);
  const badCluster = sanitizeInsights({ version: 1, last_run_at: 9, clusters: [{ id: 'c', label: 'x', recordIds: [], created_at: 1 }], conflicts: [] });
  assert.equal(badCluster.clusters.length, 0);
  assert.equal(badCluster.last_run_at, 9); // last_run_at 仍保留（说明结构可读）
});

t('sanitizeInsights：conflicts 的 recordIds 长度必须为 2', () => {
  const out = sanitizeInsights({ version: 1, last_run_at: 1, clusters: [], conflicts: [{ id: 'c', note: 'n', recordIds: ['a'], created_at: 1 }] });
  assert.equal(out.conflicts.length, 0);
});

// ——————————————————————————————————————————————
// prompt 构造（编号只能来自给定集合）
// ——————————————————————————————————————————————
t('buildInsightsPrompt：只给编号 + 要求 JSON + 演进提示', () => {
  const records = [rec('我住在北京', [claim('所在地', '北京')], 'a'), rec('我搬到上海', [claim('所在地', '上海')], 'b')];
  const prompt = buildInsightsPrompt(records, [['a', 'b']], [['a', 'b']]);
  assert.match(prompt, /只输出 JSON/);
  assert.match(prompt, /绝不编造/);
  assert.match(prompt, /演变/);
  assert.match(prompt, /#0\. 我住在北京/);
  assert.match(prompt, /簇0：/);
  assert.match(prompt, /对0：#0/);
});

t('buildInsightsPrompt：空簇/空对也成文（不抛）', () => {
  const prompt = buildInsightsPrompt([], [], []);
  assert.match(prompt, /（无）/);
});

// ——————————————————————————————————————————————
// Consolidator 依赖注入形态（不跑 LLM：askLlm 立即返回 null）
// ——————————————————————————————————————————————
t('Consolidator.current()：空表 → EMPTY_INSIGHTS；running 初值 false', () => {
  const table = { get: () => undefined, put: async () => {} };
  const c = new Consolidator({ insights: table, listRecords: () => [], askLlm: async () => null, heatOf: () => 0 });
  assert.deepEqual(c.current(), EMPTY_INSIGHTS);
  assert.equal(c.running, false);
});

t('Consolidator.run()：记忆不足 MIN_RECORDS → null（不调 LLM、不写表）', async () => {
  let puts = 0;
  let llmCalls = 0;
  const table = { get: () => undefined, put: async () => { puts++; } };
  const records = [rec('a', [claim('所在地', '北京')], 'a'), rec('b', [claim('所在地', '上海')], 'b')];
  const c = new Consolidator({ insights: table, listRecords: () => records, askLlm: async () => { llmCalls++; return null; }, heatOf: () => 0, minRecords: 5 });
  const r = await c.run();
  assert.equal(r, null);
  assert.equal(puts, 0);
  assert.equal(llmCalls, 0);
});

t('Consolidator.run()：LLM 返回 null（通道不可用）→ 保留旧洞察、不写表', async () => {
  let puts = 0;
  const old = { version: 1, last_run_at: 777, clusters: [{ id: 'c0', label: '旧', recordIds: ['x', 'y'], created_at: 1 }], conflicts: [] };
  const table = { get: () => old, put: async () => { puts++; } };
  const records = ['a', 'b', 'c', 'd', 'e'].map((id) => rec(`内容${id}`, [claim('课程', 'PHY-E1')], id));
  const c = new Consolidator({ insights: table, listRecords: () => records, askLlm: async () => null, heatOf: () => 0, minRecords: 5 });
  assert.equal(await c.run(), null);
  assert.equal(puts, 0);
  assert.deepEqual(c.current(), old); // 旧洞察原样
});

console.log(`\n[memory-insights] ${passed} 项断言全部通过`);
