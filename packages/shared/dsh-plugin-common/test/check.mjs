// ============================================================
// OOC 规则层检查脚本（M0 验收：规则分支全覆盖）
// 运行：npm test -w @aemeath/dsh-plugin-common
// 注：用 node 直接执行（node:test 的子进程 spawn 在沙箱下不可用）
// ============================================================
import assert from 'node:assert/strict';
import { checkOoc, extractText, runtimeContextDirective, executionDirective } from '../lib/index.js';

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

console.log(`\n[ooc-check] ${passed} 项断言全部通过`);
