// ============================================================
// 记忆工作区「宿主侧视图构造」单测（纯函数 + 假 memory service）
// 运行：npm run test -w @aemeath/dsh-plugin-ui
// 覆盖：记忆列表 / 主视图（L1·L2·L3 分组、画像、plan 解析）/ 时间轴视图 / 共现图视图。
// 注：不起 HTTP 服务——这些函数就是 HTTP 处理器的全部业务逻辑（处理器只剩参数解析 + json）。
// ============================================================
import assert from 'node:assert/strict';
import { buildMemoryList, buildMemoryOverview, buildTimelineView, buildGraphView } from '../lib/memory-view.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const claim = (entity, attribute, value, validFrom = 1000, validUntil = null) => ({ entity, attribute, value, valid_from: validFrom, valid_until: validUntil });

/** 假记忆服务（真实 ctx.memory 的最小可用子集）。 */
const fakeService = (over = {}) => ({
  list: () => [
    {
      key: 'm1',
      rec: { content: '我住在北京', category: 'user_fact', importance: 90, scope: 'global', preset: 'aemeath', status: 'active', activation: 88, created_at: 100, last_access: 200, entity_claims: [claim('用户', '所在地', '北京', 1000, 5000)] },
    },
    {
      key: 'm2',
      rec: { content: '我搬到上海了', category: 'user_fact', importance: 90, scope: 'global', preset: 'aemeath', status: 'active', activation: 75, created_at: 5000, last_access: 5100, entity_claims: [claim('用户', '所在地', '上海', 5000, null), claim('用户', '专业', '物理', 5000, null)] },
    },
    {
      key: 'm3',
      rec: { content: '本周目标是刷完三套题', category: 'study_log', importance: 60, scope: 'mode', preset: 'aemeath', status: 'dormant', activation: 40, created_at: 6000, last_access: 6100 },
    },
  ],
  stats: () => ({ active: 2, dormant: 1, archived: 0, byPreset: { aemeath: 3 }, byScope: { global: 2, mode: 1 } }),
  profileFacts: () => ['住在上海', '学物理'],
  l1Sessions: () => ['s1'],
  l1Turns: () => [{ query: '我下周三有考试', reply: '记下了', kind: 'fact', ts: 123 }],
  l1CapacityOf: () => ({ capacity: 40, threshold: 0.8 }),
  allScratch: () => ({ s1: { 'workflow.plan': '["读题","列式"]', other: 'x' } }),
  knownAttributes: () => ['姓名', '所在地', '专业', '考试'],
  timeline: (entity, attribute) => {
    const all = [
      { entity: '用户', attribute: '所在地', value: '北京', valid_from: 1000, valid_until: 5000 },
      { entity: '用户', attribute: '所在地', value: '上海', valid_from: 5000, valid_until: null },
      { entity: '用户', attribute: '专业', value: '物理', valid_from: 5000, valid_until: null },
    ];
    return all.filter((c) => c.entity === entity && c.attribute === attribute);
  },
  currentClaim: (entity, attribute) => (attribute === '所在地' ? claim('用户', '所在地', '上海', 5000, null) : undefined),
  currentInsights: () => ({ version: 1, last_run_at: 7, clusters: [], conflicts: [] }),
  dreamNow: async () => null,
  ...over,
});

t('buildMemoryList：字段映射 + claim 透传 + 缺省值兜底', () => {
  const items = buildMemoryList(fakeService());
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    id: 'm1',
    content: '我住在北京',
    category: 'user_fact',
    importance: 90,
    scope: 'global',
    preset: 'aemeath',
    status: 'active',
    activation: 88,
    created_at: 100,
    last_access: 200,
    claims: [{ entity: '用户', attribute: '所在地', value: '北京', valid_from: 1000, valid_until: 5000 }],
  });
  // 无 entity_claims 的记录 → 空数组（不是 undefined，前端可安全 .map）
  assert.deepEqual(items[2].claims, []);
});

t('buildMemoryList：缺字段/类型错误 → 安全兜底（不抛、不泄漏 unknown）', () => {
  const svc = fakeService({
    list: () => [
      { key: 'bad', rec: { entity_claims: 'not-an-array', activation: 'high', importance: null } },
      { key: 'bad2', rec: { entity_claims: [{ entity: 42, attribute: null, value: undefined }] } },
    ],
  });
  const items = buildMemoryList(svc);
  assert.equal(items[0].content, '');
  assert.equal(items[0].category, 'session_summary');
  assert.equal(items[0].scope, 'mode');
  assert.equal(items[0].status, 'active');
  assert.equal(items[0].activation, 50); // 非 number → 默认
  assert.equal(items[0].importance, 0);
  assert.deepEqual(items[0].claims, []);
  assert.deepEqual(items[1].claims, [{ entity: '42', attribute: '', value: '', valid_from: 0, valid_until: null }]);
});

t('buildMemoryOverview：L2/L3 按 scope 分组 + L1 缓冲 + 画像 + plan 解析', () => {
  const view = buildMemoryOverview(fakeService());
  assert.equal(view.ok, true);
  assert.deepEqual(view.l2.map((m) => m.id), ['m3']);
  assert.deepEqual(view.l3.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(view.profile, ['住在上海', '学物理']);
  assert.deepEqual(view.l1Capacity, { capacity: 40, threshold: 0.8 });
  assert.equal(view.l1Buffer.length, 1);
  assert.equal(view.l1Buffer[0].turns[0].query, '我下周三有考试');
  // scratch → plans（workflow.plan 解析成字符串数组；其他 key 进 l1）
  assert.deepEqual(view.plans, { s1: ['读题', '列式'] });
  assert.deepEqual(view.l1[0].items.map((i) => i.key).sort(), ['other', 'workflow.plan']);
});

t('buildMemoryOverview：无 l1/scratch/profile 能力时（旧版服务）→ 空数组不抛', () => {
  const view = buildMemoryOverview(
    fakeService({
      l1Sessions: undefined,
      l1Turns: undefined,
      l1CapacityOf: undefined,
      profileFacts: undefined,
      allScratch: undefined,
    }),
  );
  assert.deepEqual(view.l1Buffer, []);
  assert.deepEqual(view.l1, []);
  assert.deepEqual(view.profile, []);
  assert.deepEqual(view.plans, {});
  assert.equal(view.l1Capacity, null);
});

t('buildMemoryOverview：坏 plan JSON → 整会话跳过（不毒化其它会话）', () => {
  const view = buildMemoryOverview(
    fakeService({ allScratch: () => ({ s1: { 'workflow.plan': '{坏' }, s2: { 'workflow.plan': '["ok"]' } }) }),
  );
  assert.deepEqual(view.plans, { s2: ['ok'] });
});

t('buildTimelineView：遍历 knownAttributes 只保留有断言的属性（时间轴分组）', () => {
  const view = buildTimelineView(fakeService(), '用户', '所在地');
  assert.equal(view.entity, '用户');
  assert.deepEqual(view.attributes.map((a) => a.attribute), ['所在地', '专业']); // 姓名/考试 无断言 → 不出现
  const location = view.attributes[0];
  assert.deepEqual(location.claims.map((c) => c.value), ['北京', '上海']);
  assert.equal(location.claims[0].valid_until, 5000); // 历史值已闭合
  assert.equal(location.claims[1].valid_until, null); // 当前值
  assert.equal(view.current.value, '上海');
});

t('buildTimelineView：knownAttributes 不可用（旧服务）→ 退化为对指定属性单查', () => {
  const view = buildTimelineView(fakeService({ knownAttributes: undefined }), '用户', '所在地');
  assert.deepEqual(view.attributes.map((a) => a.attribute), ['所在地']);
  assert.equal(view.attributes[0].claims.length, 2);
});

t('buildTimelineView：无任何断言的实体 → 空属性列表（面板显示引导文案）', () => {
  // 注意 currentClaim 由服务端按自己的语义返回；本视图只透传，故断言只看 attributes
  const view = buildTimelineView(fakeService({ currentClaim: () => undefined }), '别人', '所在地');
  assert.deepEqual(view.attributes, []);
  assert.equal(view.current, null); // undefined → null（JSON 友好）
});

t('buildGraphView：节点=实体提及次数、边=同记忆内实体共现', () => {
  // 假 service 里所有 claim 的 entity 都是「用户」（值「物理」是专业取值，不是实体）→ 单节点无边
  const single = buildGraphView(fakeService());
  assert.deepEqual(single.nodes, [{ id: '用户', count: 2 }]);
  assert.deepEqual(single.edges, []);
  // 一条记忆里出现两个实体 → 该记忆贡献一条共现边（节点同次数，只断言集合与计数）
  const multi = buildGraphView(
    fakeService({
      list: () => [
        { key: 'm1', rec: { entity_claims: [claim('用户', '所在地', '北京'), claim('物理', '课程', 'PHY-E1')] } },
      ],
    }),
  );
  assert.equal(multi.nodes.length, 2);
  assert.deepEqual(Object.fromEntries(multi.nodes.map((n) => [n.id, n.count])), { 用户: 1, 物理: 1 });
  assert.deepEqual(multi.edges, [{ a: '物理', b: '用户', weight: 1 }]); // 键归一：按码点升序
});

t('buildGraphView：边去重与权重累加（同一对多处共现 → weight 累加、键归一）', () => {
  const svc = fakeService({
    list: () => [
      { key: 'a', rec: { entity_claims: [claim('乙', 'x', '1'), claim('甲', 'y', '1')] } },
      { key: 'b', rec: { entity_claims: [claim('甲', 'x', '2'), claim('乙', 'y', '2')] } },
    ],
  });
  const view = buildGraphView(svc);
  assert.deepEqual(view.edges, [{ a: '乙', b: '甲', weight: 2 }]); // 归一顺序（码点升序），权重累加
  // 节点按提及次数降序；同次数时保持首次出现序（不断言具体先后）
  const byId = Object.fromEntries(view.nodes.map((n) => [n.id, n.count]));
  assert.deepEqual(byId, { 甲: 2, 乙: 2 });
  assert.equal(view.nodes.length, 2);
});

t('buildGraphView：无 assert 的记忆 → 空图（前端显示"不足"文案）', () => {
  const view = buildGraphView(fakeService({ list: () => [{ key: 'x', rec: { content: '没有断言' } }] }));
  assert.deepEqual(view.nodes, []);
  assert.deepEqual(view.edges, []);
});

t('buildGraphView：节点上限 40 / 边上限 80（护栏，防大库把 SVG 压垮）', () => {
  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push({ key: `k${i}`, rec: { entity_claims: Array.from({ length: 5 }, (_, j) => claim(`e${i}_${j}`, 'a', 'v')) } });
  }
  const view = buildGraphView(fakeService({ list: () => many }));
  assert.equal(view.nodes.length, 40);
  assert.ok(view.edges.length <= 80);
  // 排序：节点按提及次数降序（不变量）
  for (let i = 1; i < view.nodes.length; i++) assert.ok(view.nodes[i - 1].count >= view.nodes[i].count);
});

console.log(`\n[ui-memory-view] ${passed} 项断言全部通过`);
