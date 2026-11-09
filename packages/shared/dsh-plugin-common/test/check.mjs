// ============================================================
// OOC 规则层检查脚本（M0 验收：规则分支全覆盖）
// 运行：npm test -w @aemeath/dsh-plugin-common
// 注：用 node 直接执行（node:test 的子进程 spawn 在沙箱下不可用）
// ============================================================
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { checkOoc, extractText, executionDirective, relationshipCueFor, resolveRole, rejectUnauthenticated, describeToolArgs, registerVolatileSettings, readSetting, fetchWithSsrfGuard, sessionPresetOf, AEMEATH_HIDDEN_TOOLS } from '../lib/index.js';

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

t('executionDirective 非空且为执行指令', () => {
  const d = executionDirective();
  assert.ok(d.length > 0);
  assert.match(d, /任务正确/);
  assert.match(d, /工具/);
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

// 键鼠/程序控制审批：参数必须让用户看到（早先只显示工具名 = 盲批）
t('describeToolArgs：参数原样 JSON 化，超长截断，空参数为空串', () => {
  assert.equal(describeToolArgs({ program: 'C:\\x\\payload.exe' }), '{"program":"C:\\\\x\\\\payload.exe"}');
  const long = describeToolArgs({ text: 'a'.repeat(500) });
  assert.equal(long.length, 201);
  assert.ok(long.endsWith('…'));
  assert.equal(describeToolArgs({}), '');
  assert.equal(describeToolArgs(undefined), '');
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => describeToolArgs(circular));
});

t('ask-notify.ps1：参数摘要进 toast（XML 转义）与气泡', () => {
  const ps = readFileSync(new URL('../scripts/ask-notify.ps1', import.meta.url), 'utf-8');
  assert.match(ps, /\$detail = \$env:AEMEATH_ASK_DETAIL/);
  assert.match(ps, /\$detailEsc = Esc-Xml \$detail/);
  assert.match(ps, /<text id="3">\$detailEsc<\/text>/);
  assert.doesNotMatch(ps, />\$detail</, 'toast 里不能放未转义的 $detail');
  assert.match(ps, /\$balloon = "\$balloon`n\$detail"/);
});

// —— 2026-11 审查修复的回归护栏 ——
const pluginIndexes = () => {
  const root = new URL('../../../', import.meta.url);
  const out = [];
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const pkg of readdirSync(new URL(group.name + '/', root), { withFileTypes: true })) {
      if (!pkg.isDirectory() || !pkg.name.startsWith('dsh-plugin-')) continue;
      const file = new URL(group.name + '/' + pkg.name + '/src/index.ts', root);
      if (existsSync(file)) out.push({ name: pkg.name, src: readFileSync(file, 'utf-8') });
    }
  }
  return out;
};

t('registerVolatileSettings：取值函数每次读都是最新值', () => {
  let on = true;
  registerVolatileSettings('check-live', { enabled: () => on });
  assert.equal(readSetting({}, 'check-live').enabled, true);
  on = false;
  assert.equal(readSetting({}, 'check-live').enabled, false);
});

/**
 * 取出源码里每个 registerVolatileSettings(...) 调用的完整文本（按括号配对找结尾）。
 * ⚠️ 不能用 /registerVolatileSettings\([^)]*\)/：取值函数 `() =>` 的右括号就把匹配截断了，
 *   第一个字段之后的内容根本没被检查。
 */
const volatileSettingsCalls = (src) => {
  const calls = [];
  const marker = 'registerVolatileSettings(';
  for (let at = src.indexOf(marker); at !== -1; at = src.indexOf(marker, at + marker.length)) {
    let depth = 0;
    let end = at + marker.length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    calls.push(src.slice(at, end + 1));
  }
  return calls;
};
const SNAPSHOT_FIELD = /:\s*runtime\.\w+/;

t('所有插件登记开关时都传取值函数（传 runtime.x 是启动时快照，开关会弹回去）', () => {
  // 先确认扫描本身能看到后面的字段
  const sample = "registerVolatileSettings('x', { a: () => runtime.a, b: runtime.b });";
  assert.equal(volatileSettingsCalls(sample).length, 1);
  assert.match(volatileSettingsCalls(sample)[0], SNAPSHOT_FIELD, '扫描漏掉了第二个字段');
  assert.doesNotMatch(volatileSettingsCalls("registerVolatileSettings('x', { a: () => runtime.a, b: () => runtime.b });")[0], SNAPSHOT_FIELD);
  let seen = 0;
  for (const { name, src } of pluginIndexes()) {
    for (const call of volatileSettingsCalls(src)) {
      seen++;
      assert.doesNotMatch(call, SNAPSHOT_FIELD, name + ' 把快照传给了 registerVolatileSettings: ' + call);
    }
  }
  assert.ok(seen >= 8, '扫描到的调用太少，可能没扫到插件源码');
});

t('sessionPresetOf：调用方没 inject 也能读到会话中途选的角色（走 reflect）', () => {
  const session = { header: { agentPreset: 'aemeath' } };
  const ctx = new Proxy(
    { reflect: { get: (n) => (n === 'sessionProjections' ? { stateOf: () => 'physicist' } : undefined) } },
    {
      get(target, prop) {
        if (prop === 'sessionProjections') throw new Error('cannot get property without inject');
        return target[prop];
      },
    },
  );
  assert.equal(sessionPresetOf(ctx, session), 'physicist');
  assert.equal(resolveRole(ctx, session, 'aemeath'), 'physicist');
});

t('AEMEATH_HIDDEN_TOOLS 覆盖所有学习类工具（新增工具要加进去）', () => {
  const names = new Set();
  for (const { src } of pluginIndexes()) {
    for (const m of src.matchAll(/name:\s*'((?:lecture|exercise|curriculum)_[a-z_]+|compute_verify|check_dimensions|plan_step|plan_status)'/g)) {
      names.add(m[1]);
    }
  }
  assert.ok(names.size > 20, '扫描到的工具太少，正则可能失效了');
  for (const n of names) assert.ok(AEMEATH_HIDDEN_TOOLS.includes(n), n + ' 没有加入 AEMEATH_HIDDEN_TOOLS');
});

// fetchWithSsrfGuard 是异步的，单独跑（IP 字面量不需要 DNS，不依赖网络）
{
  const hops = [];
  const fakeFetch = async (url) => {
    hops.push(url);
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3081/aemeath/api/memory' } });
  };
  const blocked = await fetchWithSsrfGuard('http://93.184.216.34/start', {}, fakeFetch);
  assert.equal(blocked, null, '重定向到回环地址必须被拦下');
  assert.deepEqual(hops, ['http://93.184.216.34/start'], '回环地址不能被真正请求');
  const ok = await fetchWithSsrfGuard('http://93.184.216.34/page', {}, async () => new Response('hi', { status: 200 }));
  assert.equal(await ok.text(), 'hi');
  assert.equal(await fetchWithSsrfGuard('http://127.0.0.1/x', {}, fakeFetch), null);
  passed++;
  console.log('  ✓ web_scraper：重定向的每一跳都校验私网地址');
}

console.log(`\n[ooc-check] ${passed} 项断言全部通过`);
