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

// ⚠️ 这里的契约在真机反馈后**改过一次方向**，值得记下来：
//
//   第一版要求"底色引用 --dsw-alias-bg-base"，理由是"要跟随主题、不要写死"。
//   但那个变量在某些主题下**带透明度** → 面板半透明 → 底下的对话内容透出来
//   （真机截图能看到"探索未至之境"穿透面板）。
//
//   真正的契约是：**底色必须不透明**。"跟随主题"只适用于强调色，
//   不适用于面板底色 —— 底色透明就是 bug。
//
//   所以现在断言：底色是**不带 alpha 的实色**（6 位 hex 或 rgb()，而不是 rgba()/color-mix）。
const OPAQUE_HEX = /#[0-9a-fA-F]{6}\b/;

t('--aem-standalone-bg 是不透明实色（不能带 alpha）', () => {
  const m = stylesSrc.match(/--aem-standalone-bg:\s*([^;]+);/);
  assert.ok(m, '找不到 --aem-standalone-bg 定义');
  assert.ok(OPAQUE_HEX.test(m[1]), `应是 6 位 hex 实色，实际：${m[1].trim()}`);
  assert.ok(!/color-mix|rgba\(/.test(m[1]), '不该用 color-mix/rgba（会带透明度）');
});

t('--aem-bg 的暗色分支是不透明实色', () => {
  const m = stylesSrc.match(/--aem-bg:\s*light-dark\(([\s\S]*?)\n\s*\);/);
  assert.ok(m, '找不到 --aem-bg 的 light-dark 定义');
  const dark = m[1].split(',\n').slice(1).join(','); // 暗色分支（第二段）
  assert.ok(OPAQUE_HEX.test(dark), `暗色分支应是实色，实际：${dark.trim().slice(0, 80)}`);
  assert.ok(!/color-mix/.test(m[1]), '不该用 color-mix（宿主变量可能带透明度）');
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

// ============================================================
// 产品流程：界面必须能自己开课
//
// 背景（真机反馈）：早先只能靠对话里叫 agent 调 lecture_session_start 建课，
// 于是打开课堂界面只看到"还没有课程"，既没输入框也不知道下一步 —— 死路。
// ============================================================

console.log('\n[界面可自主开课]');

const httpSrc2 = readFileSync(join(root, 'src/http.ts'), 'utf-8');

t('HTTP 桥提供 start 动作（界面能自己建课）', () => {
  assert.match(httpSrc2, /action === 'start'/, 'HTTP 桥应有 start 动作');
  assert.match(httpSrc2, /onStartSession/, 'deps 应有 onStartSession');
});

t('工具与 HTTP 共用同一条开课路径（不分叉）', () => {
  assert.match(hostSrc, /const startSession = \(/, '应有 startSession 共用函数');
  assert.match(hostSrc, /onStartSession: async/, 'HTTP 侧应调用它');
  // 工具侧也必须走同一条路径
  const toolStart = hostSrc.match(/name: 'lecture_session_start'[\s\S]{0,2000}?startSession\(/);
  assert.ok(toolStart, 'lecture_session_start 工具也应调用 startSession');
});

console.log('\n[侧栏定位：开课 + 查阅，不重复输入]');

const lecMode = readFileSync(join(root, 'src/client/lecture-mode.tsx'), 'utf-8');

t('侧栏页签为 开课 / 笔记 / 复盘', () => {
  assert.match(lecMode, /type Tab = 'start' \| 'notes' \| 'review'/, '页签定义应为 start/notes/review');
});

t('侧栏不再有速记输入框（记录发生在主界面对话）', () => {
  // CapturePanel 已移除；不该再有 lec-shorthand 这类输入
  assert.ok(!/function CapturePanel/.test(lecMode), 'CapturePanel 应已移除');
  assert.ok(!/lec-shorthand/.test(lecMode), '侧栏不该再有速记输入框');
});

t('符号键盘改为复制到剪贴板', () => {
  const sym = readFileSync(join(root, 'src/client/symbol-palette.tsx'), 'utf-8');
  assert.match(sym, /navigator\.clipboard/, '应使用 Clipboard API');
  assert.match(sym, /execCommand\('copy'\)/, '应有降级路径');
  // 去注释后再找：注释里会提到 insertSymbol 解释历史，那是应该保留的
  const symLive = stripComments(sym);
  assert.ok(!/insertSymbol\(/.test(symLive), '活代码里不该再插入到输入框（侧栏没有输入框了）');
});

console.log('\n[profile 必须声明 preset 本体]');

// 背景（真机踩过两次）：
//   ① 只配了 agent-preset-registry 指向 physicist，却没声明 physicist 本体
//      → 创建会话报 `agent-preset/not-found: Unknown agent preset: physicist`
//   ② $DSH_HOME/profiles/lecture 是**真实目录副本**而非链接
//      → 在仓库里改 profile，dsh 读的是旧副本，改了"没生效"
//
// DSH 0.2.0 的机制：preset = profile patch 里的一个
// `@deepseek-ai/dsh-agent-preset` 条目（见 dsh-web-app/presets/standard.patch.yml）。
// **不是**扫 .agent-presets 目录（那是 0.1.1 的机制）。

// root = packages/lecture/dsh-plugin-lecture → 仓库根是 ../../..
const REPO_ROOT = join(root, '..', '..', '..');
const LECTURE_PROFILE = join(REPO_ROOT, 'profiles/lecture/cordis.patch.yml');

t('lecture profile 声明了 @deepseek-ai/dsh-agent-preset', () => {
  const p = readFileSync(LECTURE_PROFILE, 'utf-8');
  assert.match(p, /@deepseek-ai\/dsh-agent-preset/, '应声明 dsh-agent-preset 条目');
});

t('registry 指向的 preset 必须真的被声明', () => {
  const p = readFileSync(LECTURE_PROFILE, 'utf-8');
  // registry 说 default: physicist，就必须有 config.id = physicist 的声明，
  // 否则创建会话报 agent-preset/not-found（真机踩过）。
  const m = p.match(/default:\s*(\w+)/);
  assert.ok(m, 'registry 应有 default');
  const wanted = m[1];
  const declared = new RegExp(`id:\\s*${wanted}\\b`).test(p);
  assert.ok(declared, `registry 默认 ${wanted}，但 profile 里没有 id: ${wanted} 的 preset 声明`);
});

console.log(`\n[check8.mjs] ${passed} 项断言通过`);
