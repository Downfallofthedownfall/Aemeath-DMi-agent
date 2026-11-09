// ============================================================
// check-wiring.mjs — 前端接线护栏（2026-11 审查修复）
// 这些 bug 的共同点：类型检查和纯函数测试都是绿的，一跑起来才发现功能不存在。
// ============================================================
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const client = (f) => readFileSync(join(here, '../src/client', f), 'utf-8');
const host = readFileSync(join(here, '../src/index.ts'), 'utf-8');

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

t('读 ctx.remote.credentials 必须声明 inject（否则保存 API Key 抛错、徽章永远未配置）', () => {
  assert.match(client('index.ts'), /export const inject = \[[^\]]*'remote\.credentials'/);
});

t('欢迎屏 / 快速设置选角色要作用到当前空白对话', () => {
  assert.match(client('hero.tsx'), /role\.pick\(/);
  assert.match(client('quick-settings.tsx'), /role\.pick\(/);
  assert.match(client('faces.ts'), /startSession\(undefined, \{ agentPreset: role \}\)/);
});

t('外观设置：host 有对应字段，CSS 真的读这些变量，启动时就生效', () => {
  for (const field of ['font', 'chatLineHeight', 'chatParaSpacing', 'assistantBubbles']) {
    assert.match(host, new RegExp(`${field}: z\\.`), `Config 缺 ${field}（写入会被 400 拒绝）`);
    assert.match(host, new RegExp(`${field}: \\(\\) =>`), `读表缺 ${field}（读不回来）`);
  }
  const css = client('appearance.ts');
  for (const v of ['--aemeath-font', '--aemeath-line-height', '--aemeath-para-spacing']) {
    assert.match(css, new RegExp(`var\\(${v}\\)`), `没有样式规则读 ${v}`);
  }
  assert.match(css, /data-aemeath-font\] \[data-chat-flow\] :is\(p,/, 'Markdown 容器自带 font-family，只设在外层传不到正文');
  assert.match(client('index.ts'), /installAppearance\(ctx, /);
});

t('cssText 里不能写驼峰属性（整条会被浏览器忽略）', () => {
  const src = client('tts.tsx');
  for (const m of src.matchAll(/'([a-zA-Z-]+):[^']*'/g)) {
    if (/^(https?|data)$/.test(m[1])) continue;
    assert.doesNotMatch(m[1], /[A-Z]/, `驼峰属性：${m[1]}`);
  }
});

t('计划提醒卡不再假装能确认/重跑', () => {
  const src = client('composer-cards.tsx');
  assert.doesNotMatch(src, /composercards\.plan\.(approve|rerun)/);
  assert.doesNotMatch(client('locales.ts'), /确认后开始执行/);
});

t('解题计划浮卡：拖动后折叠按钮可用；隐藏只针对当前计划', () => {
  const src = client('workflow-todo.tsx');
  const down = src.slice(src.indexOf('const onHeaderPointerDown'), src.indexOf('const onHeaderClick'));
  assert.ok(down.indexOf('movedRef.current = false') < down.indexOf('[data-todo-toggle]'), '要先复位 movedRef 再判断是不是按钮');
  assert.doesNotMatch(src, /readBool\(HIDDEN_KEY/);
});

t('工作区菜单能用外部点击和 Esc 关闭', () => {
  const src = client('workspace-selector.tsx');
  assert.match(src, /addEventListener\('mousedown', onDoc\)/);
  assert.match(src, /e\.key === 'Escape'/);
});

t('记忆工作区：检索走后端、有删除入口；host 实现了 search', () => {
  const src = client('memory-workspace.tsx');
  assert.match(src, /action=search/);
  assert.doesNotMatch(src, /score: m\.activation \/ 100/, '不能拿激活值冒充检索分数');
  assert.match(src, /idPrefix: m\.id/);
  assert.match(host, /action === 'search'/);
});

t('会话列表：归档后能恢复', () => {
  const src = client('sessions.tsx');
  assert.match(src, /unarchiveSession\(/);
  assert.match(src, /sessions\.archived\.restore/);
});

console.log(`\n[ui-wiring] ${passed} 项断言全部通过`);
