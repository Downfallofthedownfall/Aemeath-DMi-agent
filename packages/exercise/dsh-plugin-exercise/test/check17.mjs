// ============================================================
// check17.mjs — 前端与桌面壳的接线护栏（2026-11 审查修复）
// 这些问题都发生在"组件和宿主的接线"上，类型检查和纯函数测试都抓不到。
// ============================================================
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const client = join(here, '../src/client');
const repo = join(here, '../../../..');
const read = (p) => readFileSync(p, 'utf-8');

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

t('自动保存：发请求前就取走待保存内容（否则保存途中打的字会被清掉）', () => {
  const src = read(join(client, 'answer-editor.tsx'));
  const take = src.indexOf('pending.current = {};');
  const send = src.indexOf('onSaveRef.current(patch)');
  assert.ok(take > 0 && send > 0, '找不到 flush 的关键语句');
  assert.ok(take < send, '必须先清 pending 再 await 保存');
  assert.doesNotMatch(src, /\}, \[onSave\]\);/, '卸载 effect 不能依赖 onSave：它每次渲染都变，清理逻辑会被反复触发');
});

t('自动保存串行：同一时间只发一个请求（否则后发先到，旧内容盖掉新内容）', () => {
  const src = read(join(client, 'answer-editor.tsx'));
  assert.ok(src.includes('if (inflightRef.current) return;'));
  assert.ok(src.includes('inflightRef.current ?? Promise.resolve()'), '卸载时的收尾保存也要排在进行中的保存之后');
});

t('切换题集：课程和题集一起换，题卡按题集区分（否则自动保存可能写进别的课）', () => {
  const wb = read(join(client, 'workbench.tsx'));
  const select = wb.slice(wb.indexOf('const selectSheet'), wb.indexOf('const refreshAfterWrite'));
  assert.ok(select.indexOf('await apiGet') < select.indexOf('setCourseId(cid)'), '要先取到题集再切课程');
  assert.ok(wb.includes('key={`${courseId}/${sheet.id}/${p.id}`}'), '题卡 key 要带课程和题集');
  assert.ok(wb.includes('viewRef.current.sheetId !== sheet.id'), '晚到的保存响应不能把界面切回去');
  assert.equal(wb.split('setCourseId(cid)').length - 1, 1, '其他入口都要走 selectSheet');
});

t('前端不用 window.prompt（Electron 不支持，调用即抛错）', () => {
  for (const pkg of ['exercise/dsh-plugin-exercise', 'lecture/dsh-plugin-lecture', 'ui/dsh-plugin-ui']) {
    const dir = join(repo, 'packages', pkg, 'src/client');
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f)) continue;
      assert.doesNotMatch(read(join(dir, f)), /window\.prompt\(/, `${pkg}/${f}`);
    }
  }
});

t('桌面壳：同源文档开应用内窗口，别的 http 地址仍然拒绝', () => {
  const main = read(join(repo, 'app/main.js'));
  assert.match(main, /function isAppDocumentUrl/);
  assert.match(main, /u\.origin === APP_ORIGIN && u\.pathname\.startsWith\('\/aemeath\/api\/'\)/);
  assert.equal((main.match(/setWindowOpenHandler\(\(\{ url \}\) => handleWindowOpen\(/g) ?? []).length, 2, '主窗口和课堂窗都要走同一策略');
  assert.equal((main.match(/did-create-window', lockDocumentWindow/g) ?? []).length, 2, '子窗口要锁导航');
});

t('删除题集 / 课程有入口且要确认', () => {
  const wb = read(join(client, 'workbench.tsx'));
  assert.match(wb, /apiPost\('delete', \{ scope: 'sheet'/);
  assert.match(wb, /apiPost\('delete', \{ scope: 'course'/);
  assert.equal((wb.match(/window\.confirm\(t\('exercise\.wb\.confirm\.delete/g) ?? []).length, 2);
});

t('切换题集时进度页跟着换；同名题集不会两门课同时高亮', () => {
  const wb = read(join(client, 'workbench.tsx'));
  const select = wb.slice(wb.indexOf('const selectSheet'), wb.indexOf('const refreshAfterWrite'));
  assert.match(select, /loadDigest\(cid\)/);
  assert.match(wb, /c\.course_id === courseId && sheet\?\.id === m\.id/);
});

console.log(`\n[exercise-wiring] ${passed} 项断言全部通过`);
