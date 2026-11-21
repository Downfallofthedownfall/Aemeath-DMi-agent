// ============================================================
// check4.mjs — codeMode：agent 的 tools 服务缺失 / 没有 presentAs 时不抛
//
// dsh 0.2.1-rc.3 起 tools.presentAs 被移除；探测曾挪到 try 之外，
// agent.ctx.tools 为 undefined 时 `typeof tools.presentAs` 直接 TypeError，
// 从 apply（已有 agent）或 agent/created 钩子里冒出来。
// 运行：npm test -w @aemeath/dsh-plugin-workflow
// ============================================================
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 最小宿主：只够 apply 走完装配；agents.list 返回给定的 agent。 */
function host(agents) {
  const handlers = new Map();
  return {
    handlers,
    ctx: {
      on: (ev, h) => {
        handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
        return () => {};
      },
      tools: { register: () => () => {} },
      agents: { list: () => agents },
      effect: () => {},
      reflect: { get: () => undefined },
    },
  };
}

const physicist = (agentCtx) => ({ id: 'a1', ctx: agentCtx, session: { header: { agentPreset: 'physicist' } } });

await t('agent.ctx.tools 为 undefined：apply 不抛，agent/created 钩子也不抛', async () => {
  const h = host([physicist({ effect: () => {} })]);
  await apply(h.ctx, { codeMode: true, defaultPreset: 'physicist' });
  for (const fn of h.handlers.get('agent/created') ?? []) {
    assert.doesNotThrow(() => fn({ agent: physicist({ effect: () => {} }) }));
  }
});

await t('agent.ctx.tools 读取本身抛错（服务未注册）：同样按"没有 presentAs"处理', async () => {
  const throwing = {
    effect: () => {},
    get tools() {
      throw new Error('service tools is not registered');
    },
  };
  const h = host([physicist(throwing)]);
  await apply(h.ctx, { codeMode: true, defaultPreset: 'physicist' });
});

await t('老版本仍有 presentAs：照旧切到 ptc，并把恢复函数交给 effect', async () => {
  const calls = [];
  const effects = [];
  const agentCtx = {
    tools: { presentAs: (mode) => (calls.push(mode), () => calls.push('restore')) },
    effect: (fn) => effects.push(fn),
  };
  const h = host([physicist(agentCtx)]);
  await apply(h.ctx, { codeMode: true, defaultPreset: 'physicist' });
  assert.deepEqual(calls, ['ptc']);
  assert.equal(effects.length, 1);
  effects[0]()();
  assert.deepEqual(calls, ['ptc', 'restore']);
});

console.log(`\n[workflow-codemode] ${passed} 项断言通过`);
