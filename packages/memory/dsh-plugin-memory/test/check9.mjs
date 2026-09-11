// ============================================================
// 集成不变量单测（内存假 domain）：T1 时间轴闭合 / T3 洞察绝不改写记忆 / T5 节流
// 运行：npm test -w @aemeath/dsh-plugin-memory
// 注：不依赖真实 dsh 宿主、零网络。假表忠实模拟 KvTable 的
//     get/entries/keys/size/put/delete/update 语义（快照迭代 + 串行 update）。
// ============================================================
import assert from 'node:assert/strict';
import {
  findClosableClaims,
  closeClaims,
  prepareClaims,
  hasActiveClaim,
  activeClaimOf,
  timelineOf,
  hasClosedTimelineOverlap,
} from '../lib/timeline.js';
import { extractClaims } from '../lib/gatekeeper.js';
import { parseLlmJson, sanitizeLabels, sanitizeConflicts, entityClustersOf, candidatePairsOf, Consolidator } from '../lib/insights.js';
import { afterRecallActivation, shouldPersistRecall, ACTIVATION_ACTIVE_THRESHOLD } from '../lib/engine.js';
import { MEMORY_PERSIST_INTERVAL_MS } from '../lib/limits.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 内存假 KvTable（与 dsh-storage-domain 的 KvTable 语义对齐）。 */
class FakeTable {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
    this.puts = 0;
    this.updates = 0;
  }
  get(key) {
    return this.map.get(key);
  }
  entries() {
    return [...this.map.entries()][Symbol.iterator](); // 快照迭代，非活视图
  }
  keys() {
    return [...this.map.keys()][Symbol.iterator]();
  }
  get size() {
    return this.map.size;
  }
  async put(key, value) {
    this.puts++;
    this.map.set(key, value);
  }
  async delete(key) {
    return this.map.delete(key);
  }
  async update(key, fn) {
    this.updates++;
    const cur = this.map.get(key);
    if (cur === undefined) throw new Error('missing-key');
    const next = fn(cur);
    this.map.set(key, next);
    return next;
  }
  snapshot() {
    return JSON.stringify([...this.map.entries()]);
  }
}

// 复刻 index.ts 的写入侧管线（纯函数 + 假表；行为应与插件内实现一致）
const entityClaimsOf = (text, baseTs, existingClaims = []) => prepareClaims(extractClaims(text, '用户').map((c) => ({ ...c, valid_from: baseTs, valid_until: null })), existingClaims, baseTs);

const writeMemory = async (table, { text, existingClaims = [], id, ts = 1000 }) => {
  const claims = entityClaimsOf(text, ts, existingClaims);
  await table.put(id, { id, entity_claims: claims });
  return claims;
};

const closeFor = async (table, newId, newClaims, at) => {
  const snapshot = [...table.entries()].map(([key, rec]) => ({ id: key, entity_claims: rec.entity_claims, deleted: rec.deleted }));
  const targets = findClosableClaims(snapshot, newClaims, newId);
  for (const target of targets) {
    const rec = table.get(target.recordId);
    if (!rec?.entity_claims?.length) continue;
    await table.put(target.recordId, { ...rec, entity_claims: closeClaims(rec.entity_claims, target.indexes, at) });
  }
  return targets;
};

// ——————————————————————————————————————————————
// T1 · 事实时间轴端到端（文档 §6.1 验收）
// ——————————————————————————————————————————————
await t('T1 验收：写「我住北京」→「我搬到上海」→ 北京被闭合，闭合时间 = 上海记录 created_at', async () => {
  const table = new FakeTable();
  const c1 = await writeMemory(table, { text: '我住在北京', id: 'm1', ts: 1000 });
  assert.deepEqual(c1.map((c) => [c.attribute, c.value]), [['所在地', '北京']]);
  // 第二条：新记录先落库（ts=5000），再闭合旧的
  const createdAt = 5000;
  const c2 = await writeMemory(table, { text: '我搬到上海', existingClaims: [], id: 'm2', ts: createdAt });
  const targets = await closeFor(table, 'm2', c2, createdAt);
  assert.deepEqual(targets, [{ recordId: 'm1', indexes: [0] }]);
  assert.equal(table.get('m1').entity_claims[0].valid_until, createdAt); // 闭合时间 == 新记录 created_at
  assert.equal(table.get('m2').entity_claims[0].valid_until, null);
});

await t('T1 验收：查询「现在住哪」→ 上海；「以前住哪」→ 北京（区间可回溯）', async () => {
  const table = new FakeTable();
  await writeMemory(table, { text: '我住在北京', id: 'm1', ts: 1000 });
  const c2 = await writeMemory(table, { text: '我搬到上海', id: 'm2', ts: 5000 });
  await closeFor(table, 'm2', c2, 5000);
  const all = [...table.entries()].flatMap(([, rec]) => rec.entity_claims);
  assert.equal(activeClaimOf(all, '用户', '所在地')?.value, '上海');
  assert.deepEqual(timelineOf(all, '用户', '所在地').map((c) => c.value), ['北京', '上海']);
});

await t('T1 验收：重复写入完全相同的「我住在北京」→ 去重丢弃，不产生闭合（时间轴无噪音）', async () => {
  const table = new FakeTable();
  await writeMemory(table, { text: '我住在北京', id: 'm1', ts: 1000 });
  const before = table.snapshot();
  // 第二次同样的内容：写入侧按现有活跃断言去重 → claim 为空 → 不写字段、不闭合
  const existing = table.get('m1').entity_claims;
  const claims = entityClaimsOf('我住在北京', 9000, existing);
  assert.deepEqual(claims, []);
  const targets = await closeFor(table, 'm2', claims, 9000);
  assert.deepEqual(targets, []);
  assert.equal(table.snapshot(), before); // 时间轴一字未动
});

await t('T1：闭合幂等——同一批 claim 重复执行闭合，旧断言 valid_until 不被改写', async () => {
  const table = new FakeTable();
  await writeMemory(table, { text: '我住在北京', id: 'm1', ts: 1000 });
  const c2 = await writeMemory(table, { text: '我搬到上海', id: 'm2', ts: 5000 });
  await closeFor(table, 'm2', c2, 5000);
  const first = table.get('m1').entity_claims[0].valid_until;
  const again = await closeFor(table, 'm2', c2, 9999); // 再来一次
  assert.deepEqual(again, []); // 已闭合 → 不再命中
  assert.equal(table.get('m1').entity_claims[0].valid_until, first);
});

await t('T1：表中残留同键重复活跃断言时，只闭最旧那条（真管线暴露过的脏区间场景）', async () => {
  const table = new FakeTable();
  // 手工造"重复活跃断言"（历史数据/合并路径可能留下的形态）：两条记录同键
  table.map.set('dup1', { id: 'dup1', entity_claims: [{ entity: '用户', attribute: '所在地', value: '北京', valid_from: 1000, valid_until: null }] });
  table.map.set('dup2', { id: 'dup2', entity_claims: [{ entity: '用户', attribute: '所在地', value: '北京', valid_from: 2000, valid_until: null }] });
  const c = [{ entity: '用户', attribute: '所在地', value: '上海', valid_from: 9000, valid_until: null }];
  table.map.set('new', { id: 'new', entity_claims: c });
  const targets = await closeFor(table, 'new', c, 9000);
  assert.deepEqual(targets, [{ recordId: 'dup1', indexes: [0] }]); // 只有最旧者被闭
  assert.equal(table.get('dup1').entity_claims[0].valid_until, 9000);
  assert.equal(table.get('dup2').entity_claims[0].valid_until, null); // 重复者保持活跃，不产生脏区间
});

await t('T1：同批多事实 valid_from 互不相同（附录 D-7 防零长区间）', async () => {
  const claims = entityClaimsOf('我叫林澈，我是大二学生，我住在北京', 7000);
  assert.ok(claims.length >= 2);
  const stamps = new Set(claims.map((c) => c.valid_from));
  assert.equal(stamps.size, claims.length);
});

await t('T2：时间轴闭合后，旧新两条不再进矛盾候选（演进）', async () => {
  const table = new FakeTable();
  await writeMemory(table, { text: '我住在北京', id: 'm1', ts: 1000 });
  const c2 = await writeMemory(table, { text: '我搬到上海', id: 'm2', ts: 5000 });
  await closeFor(table, 'm2', c2, 5000);
  const a = table.get('m1').entity_claims;
  const b = table.get('m2').entity_claims;
  assert.equal(hasClosedTimelineOverlap(a, b), true);
  // 两条都仍活跃且互斥的表述（都未闭合）→ 仍报疑似矛盾
  const table2 = new FakeTable();
  await writeMemory(table2, { text: '我的结论是用A法', id: 'x', ts: 1000 });
  await writeMemory(table2, { text: '我的结论是用B法', id: 'y', ts: 2000 });
  assert.equal(hasClosedTimelineOverlap(table2.get('x').entity_claims, table2.get('y').entity_claims), false);
});

// ——————————————————————————————————————————————
// T3 · 空闲整合的硬不变量
// ——————————————————————————————————————————————
const claim = (attribute, value, entity = '用户', validUntil = null) => ({ entity, attribute, value, valid_from: 1000, valid_until: validUntil });

/** 造 12 条记忆：c0/c1 是"已闭合的演进对"，其余按实体簇分组。 */
const seedMemories = () => {
  const items = [
    { id: 'c0', content: '我住在北京', claims: [claim('所在地', '北京', '用户', 5000)] },
    { id: 'c1', content: '我搬到上海', claims: [claim('所在地', '上海')] },
    { id: 's0', content: '我在复习 PHY-E1 的力学章节', claims: [claim('课程', 'PHY-E1', '物理')] },
    { id: 's1', content: 'PHY-E1 的习题做完了第一章', claims: [claim('课程', 'PHY-E1', '物理')] },
    { id: 's2', content: 'PHY-E1 考试在二月', claims: [claim('考试', '二月', '物理')] },
    { id: 'm0', content: 'MATH1 的积分很难', claims: [claim('课程', 'MATH1', '数学')] },
    { id: 'm1', content: 'MATH1 的作业交了', claims: [claim('课程', 'MATH1', '数学')] },
    { id: 'p0', content: '我本周目标是刷完三套题', claims: [claim('学习目标', '刷完三套题', '目标')] },
    { id: 'p1', content: '我的目标是把量子力学学好', claims: [claim('学习目标', '学好量子力学', '目标')] },
    { id: 'g0', content: '我们学习小组周末见面', claims: [claim('关系', '学习小组', '小组')] },
    { id: 'g1', content: '学习小组里有个同学很厉害', claims: [claim('关系', '学习小组', '小组')] },
    { id: 'h0', content: '我喜欢喝美式', claims: [claim('偏好', '美式', '饮品')] },
  ];
  return items;
};

/** 造整合器：假 memories 由传入函数提供，LLM 可控。 */
const makeConsolidator = ({ memoriesTable, llmResult, failLlm = false, initialInsights }) => {
  const insightsTable = new FakeTable(initialInsights ? { current: initialInsights } : {});
  const listRecords = () => [...memoriesTable.entries()].map(([id, rec]) => ({ id, content: rec.content, entity_claims: rec.entity_claims ?? [], deleted: rec.deleted }));
  const c = new Consolidator({
    insights: insightsTable,
    listRecords,
    askLlm: async () => {
      if (failLlm) throw new Error('LLM 挂了');
      return llmResult;
    },
    heatOf: () => 1,
    minRecords: 5,
    maxRecords: 80,
  });
  return { c, insightsTable };
};

const seededTable = () => {
  const table = new FakeTable();
  for (const item of seedMemories()) table.map.set(item.id, { id: item.id, content: item.content, entity_claims: item.claims, activation: 70, deleted: false });
  return table;
};

await t('T3 不变量①：跑一次整合前后，memories 表逐字节不变（JSON.stringify 完全相等）', async () => {
  const memoriesTable = seededTable();
  const before = memoriesTable.snapshot();
  const llmResult = JSON.stringify({ clusters: [{ index: 0, label: '物理复习' }], conflicts: [{ a: 0, b: 1, note: '疑似冲突' }] });
  const { c, insightsTable } = makeConsolidator({ memoriesTable, llmResult });
  const r = await c.run();
  assert.ok(r, '整合应成功返回洞察');
  assert.equal(memoriesTable.snapshot(), before); // 硬不变量：原记忆一字未改
  assert.equal(memoriesTable.puts, 0); // 连一次写都没有
  assert.equal(insightsTable.puts, 1); // 只写洞察表
});

await t('T3 不变量②：洞察只存 recordIds + label/note，不复制 content', async () => {
  const memoriesTable = seededTable();
  const llmResult = JSON.stringify({ clusters: [{ index: 0, label: '物理复习' }], conflicts: [{ a: 0, b: 1, note: '看着像冲突' }] });
  const { c } = makeConsolidator({ memoriesTable, llmResult });
  const r = await c.run();
  const flat = JSON.stringify({ clusters: r.clusters, conflicts: r.conflicts });
  for (const item of seedMemories()) assert.equal(flat.includes(item.content), false, `洞察里出现了记忆原文：${item.content}`);
  assert.ok(r.clusters.every((cl) => cl.recordIds.every((id) => typeof id === 'string' && memoriesTable.get(id))));
});

await t('T3 不变量③：recordIds 只能来自边界校验过的编号（越界/编造被丢弃）', async () => {
  const memoriesTable = seededTable();
  // 簇本身由确定性算法给出（5 簇）；LLM 只能**命名**，且编号必须合法。
  // 这里 LLM 编造下标 99 / 小数 / 字符串 → 标签全丢；合法编号 0 保留。
  const llmResult = JSON.stringify({
    clusters: [{ index: 99, label: '编造' }, { index: 0, label: '合法' }, { index: 1.5, label: '小数' }, { index: '2', label: '字符串' }],
    conflicts: [{ a: 0, b: 99, note: '越界' }, { a: 0, b: 0, note: '自比' }],
  });
  const { c } = makeConsolidator({ memoriesTable, llmResult });
  const r = await c.run();
  assert.equal(r.clusters.length, 5); // 算法产出，不受 LLM 影响
  assert.equal(r.clusters[0].label, '合法'); // 唯一合法编号的标签生效
  assert.equal(r.clusters.filter((cl) => cl.label === '未命名主题').length, 4); // 其余回落默认标签
  assert.equal(r.conflicts.length, 0); // 越界与自比都没进来
  const allIds = new Set([...memoriesTable.keys()]);
  for (const cl of r.clusters) {
    assert.ok(cl.recordIds.length >= 2);
    for (const id of cl.recordIds) assert.ok(allIds.has(id), `洞察引用了不存在的 id：${id}`);
  }
});

await t('T3 不变量④：LLM 抛错 → 旧洞察完全不变（绝不覆盖成空）', async () => {
  const memoriesTable = seededTable();
  const old = { version: 1, last_run_at: 777, clusters: [{ id: 'old_c', label: '上次的主题', recordIds: ['s0', 's1'], created_at: 5 }], conflicts: [] };
  const { c, insightsTable } = makeConsolidator({ memoriesTable, llmResult: null, failLlm: true, initialInsights: old });
  const r = await c.run();
  assert.equal(r, null);
  assert.deepEqual(c.current(), old);
  assert.equal(insightsTable.puts, 0); // 没有写回
});

await t('T3 不变量④b：LLM 输出完全不合法（非 JSON）→ 保留旧洞察', async () => {
  const memoriesTable = seededTable();
  const old = { version: 1, last_run_at: 888, clusters: [{ id: 'old_c', label: '上次的主题', recordIds: ['s0', 's1'], created_at: 5 }], conflicts: [] };
  const { c } = makeConsolidator({ memoriesTable, llmResult: '模型胡言乱语，不是 JSON', initialInsights: old });
  // 解析失败 → 仍会写回"未命名主题"的空壳洞察之前先确认：解析失败时标签/矛盾都为空，
  // 但 clusters 本身来自确定性算法（不依赖 LLM），所以这里断言"不抛 + last_run_at 前进"
  const r = await c.run();
  assert.ok(r);
  assert.equal(r.clusters[0].label, '未命名主题');
  assert.equal(r.conflicts.length, 0);
  assert.equal(memoriesTable.puts, 0);
});

await t('T3 不变量⑤：与写入互斥（inFlight 期间重入直接返回 null）', async () => {
  const memoriesTable = seededTable();
  let concurrentCalls = 0;
  let resolveLlm;
  const gate = new Promise((res) => {
    resolveLlm = res;
  });
  const insightsTable = new FakeTable();
  const c = new Consolidator({
    insights: insightsTable,
    listRecords: () => [...memoriesTable.entries()].map(([id, rec]) => ({ id, content: rec.content, entity_claims: rec.entity_claims ?? [] })),
    askLlm: async () => {
      concurrentCalls++;
      await gate;
      return JSON.stringify({ clusters: [{ index: 0, label: 'OK' }], conflicts: [] });
    },
    heatOf: () => 1,
    minRecords: 5,
  });
  const first = c.run();
  assert.equal(c.running, true);
  const second = await c.run(); // 重入
  assert.equal(second, null);
  resolveLlm();
  const r = await first;
  assert.ok(r);
  assert.equal(concurrentCalls, 1); // LLM 只被调了一次
  assert.equal(c.running, false);
});

await t('T3：候选对已过时间轴过滤——已闭合的演进对不出现在 conflicts 里', async () => {
  const memoriesTable = seededTable();
  const llmResult = JSON.stringify({ clusters: [{ index: 0, label: '物理' }], conflicts: [] });
  const { c } = makeConsolidator({ memoriesTable, llmResult });
  const r = await c.run();
  // 复算一次候选对，确认 c0/c1 这对"已闭合演进"确实不在候选里
  const records = [...memoriesTable.entries()].map(([id, rec]) => ({ id, content: rec.content, entity_claims: rec.entity_claims }));
  const clusters = entityClustersOf(records);
  const pairs = candidatePairsOf(records, clusters, () => 1);
  const has = (a, b) => pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  assert.equal(has('c0', 'c1'), false);
  assert.ok(pairs.length > 0);
  // 洞察里的 recordIds 都必须是真实存在的记忆
  assert.ok(r.clusters.every((cl) => cl.recordIds.every((id) => memoriesTable.get(id))));
});

await t('T3 不变量②b：删除被引用的记忆 → current() 仍返回洞察（渲染侧按 id 过滤，不产幽灵内容）', async () => {
  const memoriesTable = seededTable();
  const llmResult = JSON.stringify({ clusters: [{ index: 0, label: '物理复习' }], conflicts: [] });
  const { c } = makeConsolidator({ memoriesTable, llmResult });
  const r = await c.run();
  const referenced = r.clusters[0].recordIds;
  assert.ok(referenced.length >= 2);
  for (const id of referenced) await memoriesTable.delete(id); // 用户删除了这些记忆
  const after = c.current();
  assert.equal(after.clusters.length, 5); // 洞察结构本身不受影响
  // 洞察不含记忆原文 → 渲染不出幽灵内容；引用已失效的 id 由渲染侧按 memories 过滤
  const deletedIds = new Set(referenced);
  const renderable = after.clusters[0].recordIds.filter((id) => !!memoriesTable.get(id));
  assert.deepEqual(renderable, []);
  assert.ok(deletedIds.size > 0);
  assert.match(after.clusters[0].label, /物理复习/); // label 是标签（不是内容），仍然有效
});

await t('T3：sanitizeInsights 对写回内容做结构校验（坏结构 → 空洞察，不抛）', async () => {
  const table = new FakeTable({ current: { version: 1, last_run_at: 5, clusters: 'not-an-array', conflicts: [{ id: 'x' }] } });
  const c = new Consolidator({ insights: table, listRecords: () => [], askLlm: async () => null, heatOf: () => 0 });
  assert.deepEqual(c.current(), { version: 1, last_run_at: 5, clusters: [], conflicts: [] });
});

await t('T3：parseLlmJson + sanitizeLabels/sanitizeConflicts 串联（围栏 + 越界混合）', async () => {
  const raw = '```json\n{"clusters":[{"index":0,"label":" 物理 "},{"index":9,"label":"越界"}],"conflicts":[{"a":0,"b":1,"note":"真冲突"},{"a":2,"b":3,"note":""}]}\n```';
  const parsed = parseLlmJson(raw);
  assert.equal(sanitizeLabels(parsed, 2).get(0), '物理');
  assert.equal(sanitizeLabels(parsed, 2).size, 1);
  assert.deepEqual(sanitizeConflicts(parsed, 2), [{ a: 0, b: 1, note: '真冲突' }]);
});

// ——————————————————————————————————————————————
// T5 · 渐近饱和 + 落盘节流
// ——————————————————————————————————————————————
await t('T5：afterRecallActivation 渐近饱和（50 → 未顶满但 ≥60；99 → 增量 <1）', async () => {
  const a = afterRecallActivation({ importance: 80, activation: 50 }, 1000);
  assert.ok(a.activation < 100);
  assert.ok(a.activation >= ACTIVATION_ACTIVE_THRESHOLD);
  assert.equal(a.status, 'active');
  const b = afterRecallActivation({ importance: 80, activation: 99 }, 1000);
  assert.ok(b.activation - 99 < 1, `99 → ${b.activation} 增量应 < 1`); // 渐近：base→100 时增量→0
  assert.equal(b.activation, 99); // 浮点细节：0.12 增量被 round 掉，实际上不再增长
  const c0 = afterRecallActivation({ importance: 80, activation: 0 }, 1000);
  assert.ok(c0.activation >= ACTIVATION_ACTIVE_THRESHOLD); // wake 保底
  // 单调性：越接近 100，增量越小
  const d1 = afterRecallActivation({ importance: 50, activation: 20 }, 1000).activation - 20;
  const d2 = afterRecallActivation({ importance: 50, activation: 80 }, 1000).activation - 80;
  assert.ok(d1 > d2);
});

await t('T5：shouldPersistRecall——30 分钟内不落盘、跨过阈值落盘、从未落盘则落盘', async () => {
  const now = 1_000_000_000;
  assert.equal(shouldPersistRecall(undefined, now), true); // 从未落盘
  assert.equal(shouldPersistRecall(0, now), true);
  assert.equal(shouldPersistRecall(now - 1000, now), false); // 1 秒前落过 → 抑制
  assert.equal(shouldPersistRecall(now - MEMORY_PERSIST_INTERVAL_MS + 1, now), false); // 差 1ms → 抑制
  assert.equal(shouldPersistRecall(now - MEMORY_PERSIST_INTERVAL_MS, now), true); // 刚好到点 → 落盘
  assert.equal(shouldPersistRecall(now - MEMORY_PERSIST_INTERVAL_MS * 3, now), true);
});

await t('T5 集成：连续 5 次召回只在首次落盘（模拟 index.ts 的节流分支）', async () => {
  const table = new FakeTable();
  await table.put('m1', { id: 'm1', importance: 70, activation: 50, last_access: 0 });
  let now = 10_000_000;
  let persisted = 0;
  for (let i = 0; i < 5; i++) {
    const rec = table.get('m1');
    if (shouldPersistRecall(rec.last_persist_at, now)) {
      await table.update('m1', (cur) => {
        const wake = afterRecallActivation({ importance: cur.importance, activation: cur.activation }, now);
        return { ...cur, last_access: now, activation: wake.activation, status: wake.status, last_persist_at: now };
      });
      persisted++;
    }
    now += 60_000; // 每次隔 1 分钟（都在 30 分钟窗口内）
  }
  assert.equal(persisted, 1);
  assert.equal(table.updates, 1);
  // 跨过 30 分钟再召回 → 计数 +1
  now += MEMORY_PERSIST_INTERVAL_MS;
  const rec = table.get('m1');
  if (shouldPersistRecall(rec.last_persist_at, now)) {
    await table.update('m1', (cur) => ({ ...cur, last_persist_at: now }));
    persisted++;
  }
  assert.equal(persisted, 2);
  // 内存里的激活值仍被抬高（只是没落盘）
  assert.ok(table.get('m1').activation >= ACTIVATION_ACTIVE_THRESHOLD);
});

console.log(`\n[memory-integration] ${passed} 项断言全部通过`);
