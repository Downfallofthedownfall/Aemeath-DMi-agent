// ============================================================
// test/check10.mjs — 设置页的 `enabled` 开关真正控制 lecture_* 工具
//
// 早先 `enabled` 只打一行日志：设置页关掉后，工具照样挂在模型面前。
// 现在：关 → 从工具表拿掉；开 → 放回；启动时就是关的 → 一个都不挂。
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 假 ctx：register 返回的 dispose 会真的把工具从表里删掉，volatile 更新可手动派发。 */
function makeCtx() {
  const listeners = new Map();
  const tools = new Map();
  return {
    tools,
    fire: (event) => (listeners.get(event) ?? []).forEach((fn) => fn()),
    ctx: {
      on(event, fn) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
        return () => {};
      },
      tools: {
        register(def) {
          tools.set(def.name, def);
          return () => tools.delete(def.name);
        },
      },
      credentials: { resolve: async () => ({ value: '' }) },
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'lecture-test10-'));
try {
  await t('开着启动：全部 lecture_* 工具挂上；关 → 全部移除；再开 → 原样放回', async () => {
    const flag = { on: true };
    const a = makeCtx();
    await apply(a.ctx, { dataDir: join(tmp, 'a'), transcribe: false, llm: { apiKey: '' }, enabled: { get: () => flag.on } });
    const names = [...a.tools.keys()].sort();
    assert.ok(names.length >= 5, `工具太少：${names.join(',')}`);
    assert.ok(names.every((n) => n.startsWith('lecture_')));
    flag.on = false;
    a.fire('loader/volatile-update');
    assert.equal(a.tools.size, 0);
    a.fire('loader/volatile-update'); // 重复派发不出错
    assert.equal(a.tools.size, 0);
    flag.on = true;
    a.fire('loader/volatile-update');
    assert.deepEqual([...a.tools.keys()].sort(), names);
    a.fire('loader/volatile-update'); // 已挂上时再派发不会重复注册
    assert.deepEqual([...a.tools.keys()].sort(), names);
  });

  await t('关着启动：一个工具都不挂；打开后才出现', async () => {
    const flag = { on: false };
    const b = makeCtx();
    await apply(b.ctx, { dataDir: join(tmp, 'b'), transcribe: false, llm: { apiKey: '' }, enabled: { get: () => flag.on } });
    assert.equal(b.tools.size, 0);
    flag.on = true;
    b.fire('loader/volatile-update');
    assert.ok(b.tools.size >= 5);
  });

  await t('没有 enabled 配置（老配置 / 测试 ctx）= 默认开', async () => {
    const c = makeCtx();
    await apply(c.ctx, { dataDir: join(tmp, 'c'), transcribe: false, llm: { apiKey: '' } });
    assert.ok(c.tools.size >= 5);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n[lecture-enabled] ${passed} 项断言通过`);
