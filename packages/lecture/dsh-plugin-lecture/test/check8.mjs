// ============================================================
// check8.mjs — 客户端主题与独立窗口形态的静态回归
//
// 这些是**真机联调踩过的坑**，用静态断言固化，防止再犯：
//
//   1. 背景色被硬编码 → 主题钉死在深色（用户报"主题色固定深色不会调"）
//   2. CSS 模板字符串里出现裸反引号 → 整个 client bundle 构建失败
//   3. standalone 布局写成 position:static → 主界面透出来
//   4. standalone 挂载点没有 display:none 隐藏宿主 → 同上
//
// 为什么是静态检查而不是渲染测试：这些约束都能从源码/产物直接判定，
// 不需要起浏览器（CI 里也跑得动）。
// ============================================================
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 去掉注释，只看"活代码"（旧颜色会留在注释里解释 bug 由来，那是应该保留的）。 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const stylesSrc = readFileSync(join(root, 'src/client/styles.ts'), 'utf-8');
const indexSrc = readFileSync(join(root, 'src/client/index.tsx'), 'utf-8');
// host 侧入口（nextSeq / 指针 / 摘要出口都在这里，不在 client）
const hostSrc = readFileSync(join(root, 'src/index.ts'), 'utf-8');
const bundle = readFileSync(join(root, 'lib/client.js'), 'utf-8');

console.log('\n[主题跟随]');

t('活代码里没有硬编码的深色背景（#16181d）', () => {
  assert.ok(
    !stripComments(bundle).includes('#16181d'),
    '构建产物里出现 #16181d：会把主题钉死在深色',
  );
});

t('活代码里没有硬编码的深色背景（#141821）', () => {
  assert.ok(!stripComments(bundle).includes('#141821'), '出现 #141821');
});

t('standalone 底色引用宿主变量而非写死', () => {
  assert.match(
    stylesSrc,
    /--aem-standalone-bg:[^;]*var\(--dsw-alias-bg-base\)/,
    '应定义 --aem-standalone-bg 并引用 --dsw-alias-bg-base',
  );
});

t('--aem-bg 暗色分支引用宿主变量（不是纯硬编码）', () => {
  const m = stylesSrc.match(/--aem-bg:\s*light-dark\(([\s\S]*?)\);\n/);
  assert.ok(m, '找不到 --aem-bg 的 light-dark 定义');
  assert.ok(m[1].includes('--dsw-alias-bg-base'), '暗色分支应引用 --dsw-alias-bg-base');
});

t('挂载点背景走 --dsw-alias-bg-base', () => {
  assert.match(
    indexSrc,
    /background:var\(--dsw-alias-bg-base/,
    'StandaloneMount 的容器背景应引用宿主变量',
  );
});

t('html/body 背景走 --dsw-alias-bg-base', () => {
  assert.match(
    indexSrc,
    /background:\s*var\(--dsw-alias-bg-base/,
    '注入的 html,body 样式应引用宿主变量',
  );
});

console.log('\n[CSS 模板完整性]');

t('CSS 模板内没有裸反引号（会截断模板字符串）', () => {
  const m = stylesSrc.match(/const CSS = `([\s\S]*?)`;\n/);
  assert.ok(m, 'CSS 模板无法解析——很可能注释里有反引号提前结束了字符串');
  assert.ok(!m[1].includes('`'), 'CSS 模板内出现多余反引号');
});

console.log('\n[独立窗口形态]');

t('standalone 是 fixed 定位（static 会让主界面透出来、z-index 也失效）', () => {
  const m = stylesSrc.match(/\[data-standalone="1"\]\s*\{([\s\S]*?)\}/);
  assert.ok(m, '找不到 data-standalone 样式块');
  assert.match(m[1], /position:\s*fixed/, 'standalone 必须是 fixed');
  assert.ok(!/position:\s*static/.test(m[1]), 'standalone 不能是 static');
});

t('standalone 有 z-index（压住宿主拖拽层）', () => {
  const m = stylesSrc.match(/\[data-standalone="1"\]\s*\{([\s\S]*?)\}/);
  assert.match(m[1], /z-index:\s*\d{6,}/, 'standalone 需要足够大的 z-index');
});

t('挂载点用 display:none 隐藏宿主 shell 内容', () => {
  assert.match(
    indexSrc,
    /body > \*:not\(#\$\{HOST_ID\}\)\s*\{\s*display:\s*none/,
    '应隐藏宿主 body 直接子节点，否则主界面会透出来',
  );
});

t('standalone 判定优先读 preload 同步标记', () => {
  assert.match(indexSrc, /isLectureWindow === true/, '应优先用 shell.isLectureWindow');
});

// ============================================================
// 本轮评审修复的回归护栏
// ============================================================

const httpSrc = readFileSync(join(root, 'src/client/../http.ts'), 'utf-8');

console.log('\n[D3 泄漏护栏覆盖度]');

t('LEAK_KEYS 覆盖 formulas[] 的字段名（shorthand/latex）', () => {
  // types.ts:209 定义 formulas: [{ shorthand, latex }]
  // 只列 processed/formulas 不够：一旦 formulas 泄漏，其元素字段也跟着漏
  assert.match(httpSrc, /LEAK_KEYS\s*=\s*\[[^\]]*'shorthand'/, 'LEAK_KEYS 应含 shorthand');
  assert.match(httpSrc, /LEAK_KEYS\s*=\s*\[[^\]]*'latex'/, 'LEAK_KEYS 应含 latex');
});

t('有形态式兜底（改名也拦得住）', () => {
  assert.match(httpSrc, /looksProcessed/, '应有 looksProcessed 形态兜底');
});

console.log('\n[时序与一致性]');

t('速记序号用 max(seq)+1（不是 length，删除后会错位）', () => {
  assert.match(hostSrc, /function nextSeq/, '应有 nextSeq 助手');
  assert.ok(!/const seq = (cur\.chunks|existing)\.length/.test(hostSrc), '不该再用 length 当序号');
});

t('日期用本地时区（不能用 toISOString，那是 UTC）', () => {
  assert.match(hostSrc, /function localDateString/, '应有 localDateString');
  assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(hostSrc), '不该用 toISOString 取日期');
});

t('摘要只有单一出口（两条路径语义一致）', () => {
  assert.match(hostSrc, /const writeSummaryFor/, '应有 writeSummaryFor 统一出口');
  // 除了 helper 内部，不该再有裸的 store.writeSummary 调用
  const raw = hostSrc.match(/store\.writeSummary\(/g) ?? [];
  assert.equal(raw.length, 1, `store.writeSummary 应只出现在 helper 里，实际 ${raw.length} 处`);
});

t('ReviewMachine.commit 不再假装接收参数', () => {
  // 去注释：契约注释里会引用旧签名来解释 bug 由来，那是应该保留的
  const reviewSrc = stripComments(readFileSync(join(root, 'src/review.ts'), 'utf-8'));
  assert.match(reviewSrc, /commit\(\): ReviewState/, 'commit 应无参数');
  assert.ok(!/commit\(accepted: Candidates\)/.test(reviewSrc), '不该保留误导性参数');
});

console.log('\n[多 owner 指针隔离]');

t('课堂指针按会话分片（不是单个 _active.json）', () => {
  assert.match(hostSrc, /pointerFileOf/, '应有 pointerFileOf');
  assert.match(hostSrc, /ownerHash/, '应有 ownerHash');
  assert.ok(!/POINTER_FILE = '_active\.json'/.test(hostSrc), '不该再用固定单文件');
});

t('恢复时只认自己的指针', () => {
  assert.match(hostSrc, /readPointer\(sid\)/, 'readPointer 应按 sid 分片');
});

t('会检出其他 owner 的指针并警告', () => {
  assert.match(hostSrc, /warnForeignPointers/, '应有跨 owner 警告');
});

console.log('\n[构建安全]');

t('CI 下 esbuild 失败不再静默保留旧 bundle', () => {
  const b = readFileSync(join(root, 'build-client.mjs'), 'utf-8');
  assert.match(b, /AEMEATH_BUILD_STRICT|process\.env\.CI/, '应有严格模式开关');
  assert.match(b, /lib\/client\.js \*\*未更新\*\*/, '降级时必须显著提示 bundle 未更新');
});

console.log(`\n[check8.mjs] ${passed} 项断言通过`);
