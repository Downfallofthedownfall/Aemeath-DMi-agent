// ============================================================
// OOC 规则层检查脚本（M0 验收：规则分支全覆盖）
// 运行：npm test -w @aemeath/dsh-plugin-common
// 注：用 node 直接执行（node:test 的子进程 spawn 在沙箱下不可用）
// ============================================================
import assert from 'node:assert/strict';
import { checkOoc, extractText, runtimeContextDirective, executionDirective, relationshipCueFor, resolveRole, rejectUnauthenticated } from '../lib/index.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

t('命中禁止模式 → 返回 {pattern, matched}', () => {
  const v = checkOoc('科学表明，这不对', ['根据研究', '科学表明']);
  assert.ok(v);
  assert.equal(v.pattern, '科学表明');
  assert.equal(v.matched, '科学表明');
});

t('大小写不敏感', () => {
  const v = checkOoc('Ciallo world', ['ciallo']);
  assert.ok(v);
  assert.equal(v.matched, 'Ciallo');
});

t('多条规则按模式列表顺序取首个命中', () => {
  const v = checkOoc('喵~ 然后 人家', ['人家', '喵~']);
  assert.ok(v);
  assert.equal(v.pattern, '人家');
});

t('无命中 → null', () => {
  assert.equal(checkOoc('严谨推导：F = ma', ['嘤嘤嘤', 'Ciallo']), null);
});

t('非法正则跳过不抛错', () => {
  assert.doesNotThrow(() => checkOoc('任意文本', ['[bad(']));
  assert.equal(checkOoc('任意文本', ['[bad(']), null);
});

t('空文本/空规则 → null', () => {
  assert.equal(checkOoc('', ['x']), null);
  assert.equal(checkOoc('abc', []), null);
});

t('extractText 只取 text 块', () => {
  const blocks = [
    { type: 'text', text: '结论：' },
    { type: 'tool_use', text: '不应出现' },
    { type: 'text', text: 'F=ma' },
  ];
  assert.equal(extractText(blocks), '结论：F=ma');
});

t('extractText 容忍 undefined', () => {
  assert.equal(extractText(undefined), '');
});

t('runtimeContextDirective 始终非空且区分中英', () => {
  const zh = runtimeContextDirective('zh');
  const en = runtimeContextDirective('en');
  const fallback = runtimeContextDirective('');
  assert.ok(zh.length > 0);
  assert.ok(en.length > 0);
  assert.ok(fallback.length > 0);
  assert.notEqual(zh, en);
  assert.match(zh, /上下文/);
  assert.match(en, /Runtime context/);
});

t('executionDirective 非空且为执行指令', () => {
  const d = executionDirective();
  assert.ok(d.length > 0);
  assert.match(d, /任务正确/);
  assert.match(d, /工具/);
});

// —— A4 relationship cue 注入（借 Cyrene 想法；返回给 runtime-context 段） ——
t('runtimeContextDirective：无 cue 时保持占位且不含线索块', () => {
  const zh = runtimeContextDirective('zh');
  assert.match(zh, /上下文/);
  assert.ok(!zh.includes('【近期关系线索】'));
  assert.equal(runtimeContextDirective('zh', ''), zh);
});

t('runtimeContextDirective：带 cue 时把线索块一并注入', () => {
  const cue = '【近期关系线索】\n- 当前状态：难过';
  const zh = runtimeContextDirective('zh', cue);
  assert.ok(zh.includes('【近期关系线索】'));
  assert.match(zh, /当前状态：难过/);
  assert.match(zh, /上下文/); // 占位说明仍在
  const en = runtimeContextDirective('en', cue);
  assert.ok(en.includes('【近期关系线索】'));
  assert.match(en, /Runtime context/);
});

// —— relationshipCueFor：记忆插件缺失/异常时安全回退 ''（绝不抛错） ——
t('relationshipCueFor：无 memory 服务 → 空串', () => {
  assert.equal(relationshipCueFor({}, 'physicist'), '');
  assert.equal(relationshipCueFor({ reflect: {} }, 'aemeath'), '');
});

t('relationshipCueFor：memory 提供 recallRelationshipCue → 返回 cue', () => {
  const ctx = {
    reflect: {
      get: () => ({ recallRelationshipCue: (preset) => (preset === 'physicist' ? '【近期关系线索】ok' : '') }),
    },
  };
  assert.equal(relationshipCueFor(ctx, 'physicist'), '【近期关系线索】ok');
  assert.equal(relationshipCueFor(ctx, 'other'), '');
});

t('relationshipCueFor：reflect.get 抛错 → 回退空串（不抛给调用方）', () => {
  const ctx = {
    reflect: {
      get: () => {
        throw new Error('boom');
      },
    },
  };
  assert.doesNotThrow(() => relationshipCueFor(ctx, 'physicist'));
  assert.equal(relationshipCueFor(ctx, 'physicist'), '');
});

// 角色解析：会话 → 全局默认 → fallback（全局默认排前面会短路会话级）
const roleCtx = (defaultId) => ({
  sessionProjections: { stateOf: (s, k) => (k === 'agentPreset' ? (s.preset ?? null) : null) },
  agentPresets: { defaultId },
});

t('resolveRole：会话选了 preset → 用会话的，不被全局默认短路', () => {
  assert.equal(resolveRole(roleCtx('aemeath'), { preset: 'physicist' }, 'aemeath'), 'physicist');
  assert.equal(resolveRole(roleCtx('physicist'), { preset: 'aemeath' }, 'physicist'), 'aemeath');
});

t('resolveRole：projection 为空 → 读 header.agentPreset', () => {
  assert.equal(resolveRole(roleCtx('aemeath'), { header: { agentPreset: 'physicist' } }), 'physicist');
});

t('resolveRole：会话没选 → 回退全局默认', () => {
  assert.equal(resolveRole(roleCtx('aemeath'), { preset: null }, 'physicist'), 'aemeath');
});

t('resolveRole：没会话也没 registry 服务 → 回退 fallback', () => {
  assert.equal(resolveRole({}, undefined, 'physicist'), 'physicist');
  assert.equal(resolveRole(undefined, undefined), undefined);
});

// /aemeath/api/* 鉴权：复用 dsh connection.requestRejection（与 /api 同一道门）
const fakeRes = () => {
  const r = { status: undefined, body: undefined };
  r.writeHead = (s) => { r.status = s; return r; };
  r.end = (b) => { r.body = b; };
  return r;
};
const connCtx = (verdict) => ({ reflect: { get: (name) => (name === 'connection' ? { requestRejection: () => verdict } : undefined) } });
const req = { headers: { host: '127.0.0.1:3081' } };

t('rejectUnauthenticated：已登录 → 放行，不写响应', () => {
  const res = fakeRes();
  assert.equal(rejectUnauthenticated(connCtx(undefined), req, res), false);
  assert.equal(res.status, undefined);
});

t('rejectUnauthenticated：无 cookie / Host 不受信 → 401 / 403 并结束响应', () => {
  for (const code of [401, 403]) {
    const res = fakeRes();
    assert.equal(rejectUnauthenticated(connCtx(code), req, res), true);
    assert.equal(res.status, code);
    assert.equal(JSON.parse(res.body).ok, false);
  }
});

t('rejectUnauthenticated：取不到 connection 服务 → fail closed（503）', () => {
  for (const ctx of [{}, undefined, { reflect: { get: () => { throw new Error('no inject'); } } }]) {
    const res = fakeRes();
    assert.equal(rejectUnauthenticated(ctx, req, res), true);
    assert.equal(res.status, 503);
  }
});

console.log(`\n[ooc-check] ${passed} 项断言全部通过`);
