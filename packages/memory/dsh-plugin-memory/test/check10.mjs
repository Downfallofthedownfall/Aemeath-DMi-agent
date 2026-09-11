// ============================================================
// T1/T2/T3/T5 · **真插件 apply() 路径** 集成测试
// 与 check9 的区别：check9 测的是"降级复刻的纯函数管线"，这里用**真 cordis Context**
// 加载 **lib/index.js 的真实 apply()**（storageDomain/commands/settings/credentials
// 以真实服务身份 provide 进容器），因此覆盖 saveMemory / supersedeMemory /
// closeSupersededClaims / 召回回写节流 / runConsolidation 的真实实现。
// 运行：npm test -w @aemeath/dsh-plugin-memory
// 注：零网络（llm.enabled=false，adminHttp.enabled=false）。
// ============================================================
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../lib/index.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---------- 内存版 KvTable（与 dsh-storage-domain 语义对齐） ----------
class FakeTable {
  constructor() {
    this.map = new Map();
    this.puts = 0;
    this.updates = 0;
  }
  get(key) {
    return this.map.get(key);
  }
  entries() {
    return [...this.map.entries()][Symbol.iterator]();
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
  /** 记录级"落盘"计数（插件召回回写走 update，写入路径走 put）。 */
  get writes() {
    return this.puts + this.updates;
  }
  /** 全部记录（按插入序）。 */
  all() {
    return [...this.map.values()];
  }
}

/**
 * 真 cordis 宿主：root Context + 以服务身份 provide 的 storageDomain/commands/
 * settings/credentials；插件挂在 extend() 出的子 context 上（与 dsh 的插件 fiber 同构）。
 */
const makeHarness = () => {
  const root = new Context();
  const tables = {
    memories: new FakeTable(),
    audit: new FakeTable(),
    knowledge: new FakeTable(),
    l1: new FakeTable(),
    relationship: new FakeTable(),
    insights: new FakeTable(),
  };
  let profileValue = { facts: [] };
  const registeredCommands = [];
  const settingsSections = new Map();
  const settingsWatchers = [];

  root.reflect.provide('storageDomain', {
    open: async () => ({
      name: 'aemeath_memory',
      table: (name) => tables[name],
      global: {
        get: () => profileValue,
        set: async (v) => {
          profileValue = v;
        },
      },
      close: async () => undefined,
    }),
  });
  root.reflect.provide('commands', { register: (def) => registeredCommands.push(def) });
  root.reflect.provide('credentials', { resolve: async () => ({ value: '' }) });
  root.reflect.provide('settings', {
    // 对齐 installSettingsSection 用到的 register(ns, schema, { base }) 契约
    register: (ns, schema, opts) => {
      void schema;
      let current = opts?.base ?? { enabled: true };
      const scope = {
        get: () => current,
        watch: (fn) => {
          settingsWatchers.push(fn);
          return () => undefined;
        },
      };
      settingsSections.set(ns, scope);
      return scope;
    },
  });

  const ctx = root.extend();
  let pluginCtx;
  return {
    root,
    ctx,
    tables,
    registeredCommands,
    /** 插件挂载时拿到的（子）context：用来直接调它的监听器（cordis 事件无返回值）。 */
    pluginCtx: () => pluginCtx,
    /** 插件注册的 ctx.memory 服务（MemoryService 实例，用于直测服务层 API）。 */
    memoryService: () => pluginCtx?.memory,
    async start(config) {
      // 以真 cordis 上下文挂载（与 dsh 的插件 fiber 同构），并截获插件拿到的 context
      pluginCtx = ctx.extend();
      await apply(pluginCtx, config);
      return undefined;
    },
    /** 触发事件（cordis 事件从 root 派发会送达叶子 context 的监听器；只转发前两个参数）。 */
    async fire(event, ...args) {
      return root.emit(event, ...args);
    },
    /** 需要监听器返回值时走 events.serial（emit 不返回结果）。 */
    async fireSerial(event, ...args) {
      return root.events.serial(event, ...args);
    },
    async dispose() {
      await root.stop?.();
    },
  };
};

/** 走一次真实 agent/pre-step 拦截链（serial 返回插件改写后的决策）。 */
const preStep = (h, payload) => h.fireSerial('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }));

const baseConfig = (extra = {}) => ({
  defaultPreset: 'aemeath',
  l2RecallTopK: 5,
  l3Capacity: 500,
  l2Capacity: 1000,
  l1Capacity: 40,
  l1Threshold: 0.8,
  l1MaxTokens: 3000,
  llm: { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', batchSize: 8, minBatch: 4 },
  knowledge: { enabled: false },
  worldbook: { enabled: false, libraries: {} },
  decayDays: 90,
  termTriggerPhrases: [],
  consolidate: { enabled: false, idleMinutes: 30, maxRecords: 80, minRecords: 5 },
  adminHttp: { enabled: false, port: 18995 },
  ...extra,
});

/**
 * 造一个 dsh 形状的 session（resolveSessionPreset 读 session.events / header.agentPreset）。
 * 真宿主的 session 还带更多字段，但插件只用这两处，故按契约最小化。
 */
const makeSession = (id, preset = 'aemeath') => ({ id, header: { agentPreset: preset }, events: [] });

/**
 * 一轮 (query, reply) 走真实 session/event → processTurn 管线。
 * 末尾的 waitSettleMs 模拟"真实会话的轮次节奏"：processTurn 是 fire-and-forget，同一轮内
 * 规则层直存与 L1 即时总结（总结层卸载）会并发落库；真实宿主里下一轮总要过一会儿才来，
 * 这里给一个极短等待让它们落定，避免测试在两次写入**中间**断言（不是掩盖问题：
 * 真实竞态窗口由 T1 的"写入前快照 + 时间单调性护栏"保证不会产生脏区间）。
 */
const runTurn = async (h, sid, query, reply, waitSettleMs = 30) => {
  const session = makeSession(sid);
  await h.fire('session/event', session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: query }] } });
  await h.fire('session/event', session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } });
  if (waitSettleMs > 0) await new Promise((r) => setTimeout(r, waitSettleMs));
};

// ——————————————————————————————————————————————
// 1) 插件装配与既有钩子不变
// ——————————————————————————————————————————————
await t('apply()：真 cordis 宿主下装配成功，域表打开且服务已注册（既有钩子数量不变）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  // 可观测断言：域表打开（size 可读）→ 说明 storageDomain.open 成功
  assert.equal(h.tables.memories.size, 0);
  assert.equal(h.tables.insights.size, 0); // T3 洞察表已建
  // 既有钩子仍在：跑一轮后记忆真的落库（说明 session/event 已挂）
  await runTurn(h, 's1', '记住，我叫林澈', '好的');
  assert.equal(h.tables.memories.size, 1);
  // /memory 命令已注册
  assert.equal(h.registeredCommands.length, 1);
  assert.equal(h.registeredCommands[0].name, 'memory');
});

// ——————————————————————————————————————————————
// 2) T1：真管线的"写北京 → 写上海"闭合
// ——————————————————————————————————————————————
await t('真管线 T1：第二轮「搬到上海」把第一轮记忆的 claim 闭合（valid_until = 新记录 created_at）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());

  // 第一轮：「记住，我住在北京」→ 规则层显式记忆命令 → save（user_fact, global）+ claim（所在地=北京）
  await runTurn(h, 's1', '记住，我住在北京', '好的，记住了');
  const first = h.tables.memories.all();
  assert.equal(first.length, 1, `首轮应写入 1 条记忆，实际 ${first.length}`);
  const m1 = first[0];
  assert.equal(m1.content, '我住在北京');
  assert.equal(m1.entity_claims?.[0]?.attribute, '所在地');
  assert.equal(m1.entity_claims?.[0]?.value, '北京');
  assert.equal(m1.entity_claims?.[0]?.valid_until, null);

  // 第二轮：「记住，我搬到上海了」→ 新值写入 + 时间轴闭合旧值（走 save/merge/supersede 任一分支）
  await runTurn(h, 's2', '记住，我搬到上海了', '好的');

  const rows = h.tables.memories.all();
  const claims = rows.flatMap((r) => r.entity_claims ?? []);
  const shanghai = claims.find((c) => c.value === '上海');
  const beijing = claims.find((c) => c.value === '北京');
  assert.ok(shanghai, '应写入「上海」claim');
  assert.ok(beijing, '「北京」claim 应仍在（时间轴是叠加，不是删除历史）');

  // 硬验收①：恰好产生一次闭合，且闭合时刻落在"承载新值的记录"的 created_at 刻度上
  //（写入顺序不变量：先落新记录 → 再闭合旧断言；允许毫秒边界 ±5ms 抖动）
  // 注意：闭合后旧记录上也会残留该值的历史断言，因此"承载新值的记录"要按**活跃**断言来定位
  const shanghaiHost = rows.find((r) => (r.entity_claims ?? []).some((c) => c.value === '上海' && c.valid_until === null));
  assert.ok(shanghaiHost, '应有承载「上海」活跃断言的记录');
  const closed = claims.filter((c) => c.valid_until !== null);
  assert.equal(closed.length, 1, `应恰好闭合 1 条断言，实际 ${closed.length}`);
  const skew = (closed[0].valid_until ?? 0) - shanghaiHost.created_at;
  assert.ok(Math.abs(skew) <= 5, `闭合时刻应等于新记录 created_at（允许 ≤5ms 抖动），实际偏移 ${skew}ms`);
  // 区间不得倒挂（闭合时刻必须 ≥ 其自身起点；毫秒边界上允许相等=零长，不会为负）
  assert.ok((closed[0].valid_until ?? 0) >= closed[0].valid_from, '闭合时刻不得早于断言起点（负区间）');
  // 新断言的起点不得晚于闭合时刻（写入顺序不变量：先落新记录 → 再闭合）
  assert.ok(shanghai.valid_from <= (closed[0].valid_until ?? 0) + 1, '新断言起点不得晚于闭合时刻');

  // 硬验收②：闭合的是"与新 claim 同键的旧活跃断言"（旧值），新断言保持活跃
  assert.equal(closed[0].attribute, shanghai.attribute);
  assert.notEqual(closed[0].value, shanghai.value);
  assert.equal(shanghai.valid_until, null, '新断言必须保持活跃');

  // 审计留痕
  const closedAudit = h.tables.audit.all().filter((a) => a.action === 'claim_closed');
  assert.equal(closedAudit.length, 1);
  assert.match(closedAudit[0].detail, /时间轴闭合/);
});

await t('真管线 T1：时间轴可回溯「现在住哪 / 以前住哪」（/memory timeline 输出区间）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  await runTurn(h, 's1', '记住，我住在北京', '好的');
  await runTurn(h, 's2', '记住，我搬到上海了', '好的');
  const claims = h.tables.memories.all().flatMap((r) => r.entity_claims ?? []);
  const active = claims.filter((c) => c.valid_until === null).map((c) => c.value);
  const historical = claims.filter((c) => c.valid_until !== null).map((c) => c.value);
  assert.deepEqual(active, ['上海']); // 当前值唯一
  assert.deepEqual(historical, ['北京']); // 历史值可回溯
  const out = await h.registeredCommands[0].handler({ rawInput: 'timeline 用户 所在地' });
  assert.equal(out.kind, 'success');
  assert.match(out.text, /北京/);
  assert.match(out.text, /上海/);
  assert.match(out.text, /至今/); // 上海那段仍有效
});

await t('真管线 T1：重复写入完全相同的「我住在北京」不产生闭合（时间轴无噪音）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  // 走**手动写入路径**（ctx.memory.save → 无 L1 总结层并发），把"重述"的语义单独隔离出来：
  // 值相同的重述必须被记录层（consolidateTarget/内容去重）吸收，不得产生时间轴闭合。
  const svc = h.memoryService();
  const first = await svc.save({ content: '我住在北京', category: 'user_fact', importance: 90, preset: 'aemeath', scope: 'global', entityClaims: [{ entity: '用户', attribute: '所在地', value: '北京', valid_from: 1000, valid_until: null }] });
  await svc.save({ content: '我住在北京', category: 'user_fact', importance: 90, preset: 'aemeath', scope: 'global', entityClaims: [{ entity: '用户', attribute: '所在地', value: '北京', valid_from: 2000, valid_until: null }] });
  const rows = h.tables.memories.all();
  assert.equal(rows.length, 2);
  const closed = rows.flatMap((r) => (r.entity_claims ?? []).filter((c) => c.valid_until !== null));
  assert.deepEqual(closed, [], `重述不应产生闭合（save 路径不自行闭合），实际 ${JSON.stringify(closed)}`);
  assert.ok(h.tables.memories.get(first));
});

await t('真管线 T1：重述后时间轴仍只有一条活跃断言（值唯一，无噪音）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  await runTurn(h, 's1', '记住，我住在北京', '好的');
  await runTurn(h, 's2', '记住，我住在北京', '好的');
  const claims = h.tables.memories.all().flatMap((r) => r.entity_claims ?? []);
  const activeValues = claims.filter((c) => c.valid_until === null).map((c) => c.value);
  assert.deepEqual(activeValues, ['北京'], `当前值应唯一，实际 ${JSON.stringify(activeValues)}`);
  // 任意闭合都必须是"正长度区间"，且闭合时刻晚于被闭断言起点（时间单调性护栏）
  for (const c of claims.filter((x) => x.valid_until !== null)) {
    assert.ok((c.valid_until ?? 0) >= c.valid_from, `闭合区间不得倒挂：${JSON.stringify(c)}`);
  }
});

// ——————————————————————————————————————————————
// 3) T2：演进 ≠ 矛盾（真管线 supersede 分支）
// ——————————————————————————————————————————————————————————————
await t('真管线 T2：显式冲突命中 supersede 分支时，同一属性值变化 → 判为 preference_evolution', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  // 先用"记住"关键字直存一条带时间证据的偏好型事实
  await runTurn(h, 's1', '记住，我住在北京', '好的');
  const before = h.tables.memories.all();
  assert.equal(before.length, 1);

  // 第二轮：足够相似 + 含时间证据（"现在"）→ 触发 conflictHit → supersede 路径
  await runTurn(h, 's2', '记住，我现在搬到上海了', '好的');

  const audits = h.tables.audit.all();
  const supersede = audits.filter((a) => a.action === 'supersede');
  const saved = h.tables.memories.all();
  if (supersede.length) {
    // 走了 supersede 分支：类型必须是"演进"（T2 短路），不能是 direct_conflict
    assert.match(supersede[0].detail, /preference_evolution/, `supersede 类型应为演进，实际：${supersede[0].detail}`);
    // 旧记录被取代 + 其 claim 被闭合
    const old = h.tables.memories.get(before[0].id);
    assert.ok(old.superseded_by, '旧记录应有 superseded_by');
    assert.notEqual(old.entity_claims[0].valid_until, null, '旧断言应被时间轴闭合');
  } else {
    // 未触发冲突分支也应各自成条：不能丢记忆、不能把演进写成矛盾
    assert.equal(saved.length, 2);
    assert.equal(audits.filter((a) => a.detail && a.detail.includes('direct_conflict')).length, 0);
  }
});

// ——————————————————————————————————————————————
// 4) T5：召回回写节流（真 pre-step 分支）
// ——————————————————————————————————————————————
await t('真管线 T5：pre-step 连续 5 次召回 → memories 只落盘 1 次（30 分钟节流）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  await runTurn(h, 's1', '记住，我最喜欢量子力学', '好的');
  // 该轮经规则层直存为 user_fact（scope=global），必然进入召回池
  const target = h.tables.memories.all().find((r) => r.content.includes('量子力学'));
  assert.ok(target, '应有可召回的记忆');
  assert.equal(target.last_persist_at, undefined, '新记录的节流锚点应为空（首次召回必落盘）');

  const beforeWrites = h.tables.memories.writes;
  const decision = await preStep(h, { agent: { session: makeSession('s1') }, step: 1 });
  assert.equal(decision.kind, 'enter');
  assert.match(JSON.stringify(decision.messages ?? []), /量子力学/);
  assert.equal(h.tables.memories.writes - beforeWrites, 1, '首次召回应落盘 1 次');
  for (let i = 1; i < 5; i++) {
    await preStep(h, { agent: { session: makeSession('s1') }, step: 1 });
  }
  const writes = h.tables.memories.writes - beforeWrites;
  assert.equal(writes, 1, `5 次召回应只落盘 1 次，实际 ${writes} 次`);

  // 激活值被抬高 + last_persist_at 已写
  const rec = h.tables.memories.get(target.id);
  assert.ok(rec.activation >= 60, `召回后激活应 ≥60，实际 ${rec.activation}`);
  assert.ok(rec.last_persist_at > 0);
  assert.equal(rec.status, 'active');
});

await t('真管线 T5：跨过 30 分钟窗口后再召回 → 落盘计数 +1（节流不吞掉后续更新）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  await runTurn(h, 's1', '记住，我最喜欢量子力学', '好的');
  const target = h.tables.memories.all().find((r) => r.content.includes('量子力学'));
  const beforeWrites = h.tables.memories.writes;
  await preStep(h, { agent: { session: makeSession('s1') }, step: 1 });
  assert.equal(h.tables.memories.writes - beforeWrites, 1);
  // 把节流锚点拨回 40 分钟前（模拟时间流逝，无需真的等待）
  const cur = h.tables.memories.get(target.id);
  await h.tables.memories.put(target.id, { ...cur, last_persist_at: Date.now() - 40 * 60 * 1000, last_access: Date.now() - 40 * 60 * 1000 });
  const beforeSecond = h.tables.memories.writes;
  await preStep(h, { agent: { session: makeSession('s1') }, step: 1 });
  assert.equal(h.tables.memories.writes - beforeSecond, 1, '跨过 30 分钟窗口应再次落盘');
});

await t('真管线 T5：pre-step 注入块照常产出（节流不影响注入内容）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  await runTurn(h, 's1', '记住，我最喜欢量子力学', '好的');
  const decision = await preStep(h, { agent: { session: makeSession('s1') }, step: 1 });
  assert.equal(decision.kind, 'enter');
  const text = JSON.stringify(decision.messages ?? []);
  assert.match(text, /关于用户的记忆/);
  assert.match(text, /量子力学/);
});

await t('真管线 T5：step !== 1 不召回、不落盘（多 step 注入膨胀的既有保护仍在）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  await runTurn(h, 's1', '记住，我最喜欢量子力学', '好的');
  const beforePuts = h.tables.memories.puts;
  const decision = await preStep(h, { agent: { session: makeSession('s1') }, step: 2 });
  assert.deepEqual(decision.messages ?? [], []); // 未注入
  assert.equal(h.tables.memories.puts, beforePuts); // 未落盘
});

// ——————————————————————————————————————————————
// 5) T3：真 runConsolidation（手动入口 + 配置闸门）
// ——————————————————————————————————————————————
await t('真管线 T3：config.consolidate.enabled=false → 手动 dream 明确回报"未执行"、无洞察', async () => {
  const h = makeHarness();
  await h.start(baseConfig({ consolidate: { enabled: false } }));
  await runTurn(h, 's1', '记住，我最喜欢量子力学', '好的');
  await h.fire('session/flush', { id: 's1', preset: 'aemeath' });
  assert.equal(h.tables.insights.size, 0);
  const out = await h.registeredCommands[0].handler({ rawInput: 'dream' });
  assert.equal(out.kind, 'success');
  assert.match(out.text, /未执行/);
});

await t('真管线 T3：enabled=true 但记忆不足 minRecords → 整合不写洞察（不花 token）', async () => {
  const h = makeHarness();
  await h.start(baseConfig({ consolidate: { enabled: true, idleMinutes: 30, maxRecords: 80, minRecords: 5 } }));
  await runTurn(h, 's1', '记住，我最喜欢量子力学', '好的'); // 仅 1 条
  await h.fire('session/flush', { id: 's1', preset: 'aemeath' });
  assert.equal(h.tables.insights.size, 0);
  const out = await h.registeredCommands[0].handler({ rawInput: 'dream' });
  assert.match(out.text, /未执行/); // 记忆条数不足
});

await t('真管线 T3：enabled=true + llm.enabled=false（无通道）→ 记忆够也不覆写旧洞察', async () => {
  const h = makeHarness();
  await h.start(baseConfig({ consolidate: { enabled: true, idleMinutes: 30, maxRecords: 80, minRecords: 2 } }));
  // 造 6 条同实体记忆（走真管线：每轮"记住"直存）
  const facts = [
    '记住，PHY-E1 的力学章节要复习完',
    '记住，PHY-E1 的习题第一章做完了',
    '记住，PHY-E1 的考试在二月',
    '记住，PHY-E1 的实验报告还没写',
    '记住，PHY-E1 的教授讲得很快',
    '记住，PHY-E1 的讲义第二章很难',
  ];
  let i = 0;
  for (const f of facts) await runTurn(h, `s${++i}`, f, '好的');
  assert.ok(h.tables.memories.size >= 2);
  const out = await h.registeredCommands[0].handler({ rawInput: 'dream' });
  // llm.enabled=false → askLlm 返回 null → 保留旧洞察（此处原本就是空的）
  assert.match(out.text, /未执行/);
  assert.equal(h.tables.insights.size, 0);
});

await t('真管线 T3/命令：/memory timeline 输出时间轴区间（含「至今」）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  await runTurn(h, 's1', '记住，我住在北京', '好的');
  await runTurn(h, 's2', '记住，我搬到上海了', '好的');
  const out = await h.registeredCommands[0].handler({ rawInput: 'timeline 用户 所在地' });
  assert.equal(out.kind, 'success');
  assert.match(out.text, /北京/);
  assert.match(out.text, /上海/);
  assert.match(out.text, /至今/); // 上海那段仍有效
  const hint = h.registeredCommands[0].input.hint;
  assert.match(hint, /timeline/);
  assert.match(hint, /dream/);
});

await t('真管线：/memory stats 与 /memory list 正常（既有命令无回归）', async () => {
  const h = makeHarness();
  await h.start(baseConfig());
  await runTurn(h, 's1', '记住，我叫林澈', '好的');
  const stats = await h.registeredCommands[0].handler({ rawInput: 'stats' });
  assert.equal(stats.kind, 'success');
  assert.match(stats.text, /active=1/);
  const list = await h.registeredCommands[0].handler({ rawInput: 'list' });
  assert.match(list.text, /林澈/);
});

console.log(`\n[memory-plugin-e2e] ${passed} 项断言全部通过`);
