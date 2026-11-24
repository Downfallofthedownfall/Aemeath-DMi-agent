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

t('原卷截图：限高限宽挂在图容器自己身上，图上方有「收起」（不能冲出界面）', () => {
  // 2026-11-24 真机："含图题目图片无法折叠且巨大无比"。精简布局拿掉了外层 .lec-pagefig，
  // 而限高样式写成了 `.lec-pagefig .lec-pageimg` —— 图按 2 倍渲染的原尺寸铺开。
  const css = read(join(client, 'styles.ts'));
  const box = css.match(/\.\$\{EX_CLASS\} \.lec-pageimg \{([^}]*)\}/);
  assert.ok(box, '.lec-pageimg 要有自己的规则（不挂在别的父级下面）');
  assert.match(box[1], /max-height:\s*\d+vh/, '要限高');
  assert.match(box[1], /overflow:\s*auto/, '超出部分在框里滚');
  const img = css.match(/\.\$\{EX_CLASS\} \.lec-pageimg img \{([^}]*)\}/);
  assert.ok(img, '.lec-pageimg img 要有规则');
  assert.match(img[1], /max-width:\s*100%/, '宽度不超过卡片');
  const fig = read(join(client, 'page-figure.tsx'));
  assert.match(fig, /className="lec-pageimg"/);
  assert.match(fig, /onClick=\{onToggle\}/, '图上方要有收起 / 展开按钮');
  // 2026-11-24 追加（"图片收起就再也打不开了"）：收起 = 原地留一行可点开的条，不是整块消失
  assert.match(fig, /\{open \? \(\s*<div className="lec-pageimg">/, '只有图本身随收起消失，条要留着');
  assert.match(fig, /exercise\.problem\.expandPage/, '收起后那一行要有「展开」');
  for (const f of ['problem-card.tsx', 'group-card.tsx']) {
    const src = read(join(client, f));
    assert.match(src, /<PageFigure\b/, `${f} 要用 PageFigure`);
    assert.match(src, /pageView !== 'hidden'/, `${f}：收起后 PageFigure 还要渲染（只是不显示图）`);
    assert.doesNotMatch(src, /showPage &&/, `${f}：不能再按 showPage 整块卸掉`);
    assert.doesNotMatch(src, /className="lec-pageimg"/, `${f} 不要自己拼图容器`);
  }
});

console.log(`\n[exercise-wiring] ${passed} 项断言全部通过`);
