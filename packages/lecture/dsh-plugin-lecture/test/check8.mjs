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

console.log(`\n[check8.mjs] ${passed} 项断言通过`);
