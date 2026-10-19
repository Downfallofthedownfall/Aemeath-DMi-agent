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
import { readFileSync, existsSync } from 'node:fs';
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

// 注：这里曾经有过 "standalone 走普通流 / 清掉 inset" 的断言 —— 那是
// 「上下分屏、复用 dsh composer」那版方案留下的，已被用户否掉并回退。
// 现在独立模式照旧 fixed 铺满（输入框由工作台中栏自己提供），
// 相关断言在下面的「独立模式铺满整窗」与「中栏底部要有速记输入框」两节。

t('独立模式隐藏 dsh shell（输入框是我们自己的）', () => {
  // 回退说明：中间试过"不隐藏 shell、上下分屏、复用 dsh 的 composer"，
  // 用户否掉了 —— "不要把整个主agent塞进去啊，放一个输入框就完了……也不要分屏"。
  // 现在：shell 照旧隐藏，输入框由工作台中栏自己提供。
  assert.match(
    indexSrc,
    /body > \*:not\(#\$\{HOST_ID\}\)\s*\{\s*display:\s*none/,
    '应隐藏宿主 shell（含 sidebar / 会话列表 / 官方 composer）',
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

console.log('\n[工作台定位：开课 + 查阅，不重复输入]');

// 旧组件 src/client/lecture-mode.tsx 已删除（侧栏版，没有输入框、也无人引用）。
// 这些断言改指向实际的 workbench.tsx（wbSrc 在后面统一读取）。
const wbSrcEarly = readFileSync(join(root, 'src/client/workbench.tsx'), 'utf-8');

t('工作台侧签为 符号 / 复盘', () => {
  assert.match(wbSrcEarly, /'symbols' \| 'review'|type Side\s*=\s*'symbols' \| 'review'/, '侧签定义应为 symbols/review');
});

t('工作台不含速记输入框（记录走下面的对话输入框）', () => {
  // 工作台是只读的笔记视图；输入由 dsh 原生 composer 负责。
  assert.ok(!/function CapturePanel/.test(wbSrcEarly), 'CapturePanel 应已移除');
  assert.ok(!/lec-shorthand/.test(wbSrcEarly), '工作台不该再有速记输入框');
});

t('符号键盘改为复制到剪贴板', () => {
  const sym = readFileSync(join(root, 'src/client/symbol-palette.tsx'), 'utf-8');
  assert.match(sym, /navigator\.clipboard/, '应使用 Clipboard API');
  assert.match(sym, /execCommand\('copy'\)/, '应有降级路径');
  // 去注释后再找：注释里会提到 insertSymbol 解释历史，那是应该保留的
  const symLive = stripComments(sym);
  assert.ok(!/insertSymbol\(/.test(symLive), '活代码里不该再插入到输入框（工作台没有输入框）');
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

console.log('\n[profile 挂的每个 @aemeath 插件都必须在依赖里声明]');

// 背景（真机踩过三次同类问题）：
//   profiles/lecture/cordis.patch.yml 里写 `name: '@aemeath/xxx'`，
//   必须在 profiles/lecture/package.json 的 dependencies 里也声明，
//   否则 mac 脚本不会给它建链接 → 模块解析失败。
//
//   反过来更隐蔽：如果 `profiles/lecture/node_modules/@aemeath/xxx` 是
//   **真实目录副本**（误跑 npm install 留下的）而不是链接，
//   那么在仓库里改 packages/ 下的代码**不会生效** ——
//   症状是"改了、重启了、还是老样子"，极难联想。
//   真机踩过：加了 aemeath-ui 却看不到设计语言，就是因为它没被声明为依赖、
//   而 profile 里恰好躺着一份旧副本。

t('cordis.patch.yml 挂的每个 @aemeath 插件都在 package.json 里声明', () => {
  const cfg = readFileSync(LECTURE_PROFILE, 'utf-8');
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'profiles/lecture/package.json'), 'utf-8'));
  const declared = new Set(Object.keys(pkg.dependencies || {}));

  const used = new Set();
  for (const m of cfg.matchAll(/name:\s*'(@aemeath\/[^']+)'/g)) used.add(m[1]);

  const missing = [...used].filter((n) => !declared.has(n));
  assert.deepEqual(
    missing,
    [],
    `这些插件在 cordis.patch.yml 里挂了，但 package.json 没声明：${missing.join(', ')}\n` +
      '  → mac 脚本不会给它们建链接，加载会失败。',
  );
});

t('profile 声明的每个 @aemeath 依赖都指向真实存在的包', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'profiles/lecture/package.json'), 'utf-8'));
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    if (!name.startsWith('@aemeath/')) continue;
    const rel = String(spec).replace(/^file:/, '');
    const dir = join(REPO_ROOT, 'profiles/lecture', rel);
    assert.ok(existsSync(join(dir, 'package.json')), `${name} 指向的目录不存在：${rel}`);
  }
});

console.log('\n[留白只能由用户写（模型不得代笔）]');

// 真机反馈："模型错误理解为模型需要给出它的理解和疑问"。
// 根因：my_understanding / my_question 被设成 required，描述还写"必须同时给出"，
// 模型于是自己编了填进去 —— 主动回忆直接失效。
// 契约：留白**可选**（模型不填），缺失时返回 ask_user 让模型**回问用户**。
const hostSrcForBlanks = readFileSync(join(root, 'src/index.ts'), 'utf-8');

t('lecture_capture 的留白参数不是必填', () => {
  const seg = hostSrcForBlanks.match(/name: 'lecture_capture'[\s\S]{0,2600}?execute:/);
  assert.ok(seg, '找不到 lecture_capture 定义');
  // 这一段里不该出现 required: true 出现在留白参数上
  const myU = seg[0].match(/my_understanding:\s*\{[\s\S]{0,300}?\}/);
  assert.ok(myU, '找不到 my_understanding 参数定义');
  assert.ok(!/required:\s*true/.test(myU[0]), 'my_understanding 不该是必填（会逼模型自己编）');
});

t('留白缺失时返回 ask_user（让模型回问用户，而不是自己写）', () => {
  assert.match(hostSrcForBlanks, /blanks_missing/, '应返回 blanks_missing');
  assert.match(hostSrcForBlanks, /ask_user/, '应返回 ask_user 提示话术');
  assert.match(hostSrcForBlanks, /我不能替你写/, '话术里要明确"不能替你写"');
});

t('留白不再"不填不继续"（记录照收）', () => {
  // 不该再有"缺失就 return fail"的逻辑
  const seg = hostSrcForBlanks.match(/name: 'lecture_capture'[\s\S]{0,4000}?\n    \}\),/);
  assert.ok(seg, '找不到 lecture_capture 主体');
  assert.ok(
    !/if \(missing\.length\) \{\s*return fail/.test(seg[0]),
    '留白缺失不该再阻断记录（那会逼模型自己编留白）',
  );
});

console.log('\n[三栏工作台]');

const wbSrc = readFileSync(join(root, 'src/client/workbench.tsx'), 'utf-8');

t('工作台是三栏结构（左课程 / 中笔记 / 右符号+复盘）', () => {
  assert.match(wbSrc, /lec-wb-nav/, '应有左栏');
  assert.match(wbSrc, /lec-wb-main/, '应有中栏');
  assert.match(wbSrc, /lec-wb-side/, '应有右栏');
});

t('符号键盘常驻右栏（不再藏在折叠按钮后面）', () => {
  // 真机反馈"没看到按钮"：早先它在一个 .lec-symbtn 折叠按钮后面。
  // 现在直接渲染，并接上"点一下插入输入框"的能力。
  assert.match(wbSrc, /right === 'symbols' \? \(\s*<SymbolPanel/, '右栏应直接渲染 SymbolPanel');
  assert.ok(!/lec-symbtn/.test(wbSrc), '不该再依赖折叠按钮才能看到符号键盘');
});

t('工作台两种模式都铺满整窗', () => {
  assert.match(stylesSrc, /\[data-workbench="1"\]\s*\{[\s\S]{0,300}?position:\s*fixed/, '工作台应 fixed 铺满');
});

t('工作台栏底色是不透明实色（否则主 agent 会透出来）', () => {
  assert.match(stylesSrc, /--aem-nav-bg:\s*light-dark\(#[0-9a-fA-F]{6},\s*#[0-9a-fA-F]{6}\)/, '栏底色应是实色');
  assert.ok(!/lec-wb-nav\s*\{[\s\S]{0,240}?color-mix/.test(stylesSrc), '左栏底色不该用 color-mix（半透明会透出底层）');
});

console.log('\n[启动脚本必须能察觉"源码更新了但 bundle 没重建"]');

// 真机踩过（第四次"改了没生效"）：
//   packages/**/lib/ 被 gitignore → `git pull` 只更新源码，不更新 bundle。
//   而启动脚本原本的条件是"bundle **不存在**才构建"：
//       if [[ ! -f "$LECTURE_LIB" ]]; then npm run build; fi
//   bundle 已经存在（旧版）→ **永远跳过构建** →
//   用户 pull 了、重启了，界面一点没变（"和之前没区别"）。
//
//   正确做法：比对**时间戳**，源码比产物新就重建。
//
//   ⚠️ 而且必须**同时比 host 与 client**（真机又踩一次）：
//     只比 src/client → lib/client.js 的话，改 **host**（src/index.ts）不会被发现，
//     而那次的修复恰恰在 host（webserver/index-inject 注入）——
//     于是"改了、pull 了、重启了，还是老样子"再来一遍。
t('lecture-mac.sh 用时间戳判断是否需要重建（不是"文件存在就跳过"）', () => {
  const sh = readFileSync(join(REPO_ROOT, 'scripts/lecture-mac.sh'), 'utf-8');
  assert.match(sh, /needs_build/, '应有 needs_build 判断');
  assert.match(sh, /-newer/, '应比对新旧时间戳');
  // 旧写法必须消失：只判断"文件不存在"
  assert.ok(
    !/if \[\[ ! -f "\$COMMON_LIB" \|\| ! -f "\$LECTURE_LIB" \]\]; then\n\s*say "构建 workspace/.test(sh),
    '不该再是"文件存在就跳过构建"（那会让 pull 后永远用旧产物）',
  );
});

t('mac 脚本遍历所有 workspace 包，且**同时比 host 与 client**', () => {
  const sh = readFileSync(join(REPO_ROOT, 'scripts/lecture-mac.sh'), 'utf-8');
  // 遍历 packages/*/*
  assert.match(sh, /for pkg in "\$ROOT"\/packages\/\*\/\*/, '应遍历所有 workspace 包');
  // host 产物
  assert.match(sh, /host_lib=.*lib\/index\.js/, '应比较 host 产物 lib/index.js');
  // client 产物
  assert.match(sh, /client_lib=.*lib\/client\.js/, '应比较 client 产物 lib/client.js');
  // 关键：不能再只盯 lecture 的 client
  assert.ok(
    !/^LECTURE_SRC=.*src\/client$/m.test(sh) || /for pkg in/.test(sh),
    '不能只比较 lecture 的 src/client（那会漏掉 host 改动）',
  );
});

t('launcher 也做同样的判断（Windows 路径，含 host）', () => {
  const ps = readFileSync(join(REPO_ROOT, 'lecture-launch.ps1'), 'utf-8');
  assert.match(ps, /needsBuild/i, '应按时间戳判断是否需要构建');
  assert.match(ps, /lib\\index\.js/, 'Windows 也要比 host 产物 lib\\index.js');
  assert.match(ps, /packages\\\*\\\*/, 'Windows 也要遍历所有 workspace 包');
});

console.log('\n[独立界面模式必须有 boot 标记的生产者]');

// 真机踩过（用户定位到的根因），这是最隐蔽的一次：
//   lecture GUI 已经有了、bundle 也是新的、profile 链接也对，
//   但 mac（**纯浏览器，没有 Electron 壳**）上永远是主 agent 的前端。
//
//   因为客户端 detectStandalone() 三条判据在浏览器下全部落空：
//     ① window.shell.isLectureWindow —— 没有壳
//     ② URL 的 aemeath_lecture=1     —— dsh 认证 303 → ./ 会丢掉 query
//     ③ window.__AEMEATH_LECTURE_STANDALONE__ —— **从来没有生产者**（死分支）
//   → standalone=false → 走主界面模式 → dsh 官方主 shell 照常渲染。
//
//   修法：host 侧用 dsh 自己的 `webserver/index-inject` 注入该全局标记。
const clientSrc = readFileSync(join(root, 'src/client/index.tsx'), 'utf-8');

t('客户端会读 __AEMEATH_LECTURE_STANDALONE__', () => {
  assert.match(clientSrc, /__AEMEATH_LECTURE_STANDALONE__/, '客户端应检查该标记');
});

t('host 侧必须真的**生产**这个标记（不能只有读取）', () => {
  // 这条断言是这次踩坑的核心：读取分支存在了很久，但没人写入。
  assert.match(
    hostSrcForBlanks,
    /webserver\/index-inject/,
    'host 应挂 webserver/index-inject 才能注入 boot 标记',
  );
  assert.match(
    hostSrcForBlanks,
    /__AEMEATH_LECTURE_STANDALONE__/,
    'host 应写入 __AEMEATH_LECTURE_STANDALONE__',
  );
});

t('standalone 由配置控制（两个 profile 行为不同）', () => {
  assert.match(hostSrcForBlanks, /standalone:\s*z\.boolean/, 'Config 应有 standalone');
  const lecProfile = readFileSync(join(REPO_ROOT, 'profiles/lecture/cordis.patch.yml'), 'utf-8');
  assert.match(lecProfile, /standalone:\s*true/, 'lecture profile 必须开 standalone（它**就是**课堂界面）');
  const mainProfile = readFileSync(join(REPO_ROOT, 'profiles/aemeath/cordis.patch.yml'), 'utf-8');
  assert.ok(
    !/^\s*standalone:\s*true/m.test(mainProfile),
    '主 profile 不该开 standalone（要保留侧栏入口）',
  );
});

console.log('\n[aemeath-ui 不能硬依赖 memory]');

// lecture profile 按设计不挂记忆系统（D10/D2），
// 而 aemeath-ui 若把 memory 放进 inject，整个 host 半区会一直 pending：
//   aemeath-ui: pending (waiting for service: memory)
t('aemeath-ui 的 inject 里没有 memory（它是可选的）', () => {
  const uiSrc = readFileSync(join(REPO_ROOT, 'packages/ui/dsh-plugin-ui/src/index.ts'), 'utf-8');
  const m = uiSrc.match(/export const inject = \[([^\]]*)\]/);
  assert.ok(m, '找不到 aemeath-ui 的 inject');
  assert.ok(!/['"]memory['"]/.test(m[1]), 'memory 不该在 inject 里（会让无记忆 profile 一直 pending）');
  // 运行时仍要能取到（可选依赖）
  assert.match(uiSrc, /ctx\.get\('memory'\)/, '应改为运行时按需 ctx.get(memory)');
});

console.log('\n[launcher 必须显式设置 DSH_HOME]');

t('lecture-launch.command 启动 dsh 时带上 DSH_HOME', () => {
  const cmd = readFileSync(join(REPO_ROOT, 'lecture-launch.command'), 'utf-8');
  // 干净 shell 下不设 DSH_HOME → dsh 读 ~/.dsh，那里没有 lecture profile
  assert.match(cmd, /DSH_HOME=/, '应显式设置 DSH_HOME');
  assert.match(cmd, /export DSH_HOME/, '应 export 出去（子进程要能看到）');
});

console.log('\n[删除功能（真机反馈：测试笔记删不掉）]');

// 早先 8 个工具、6 个 HTTP 动作里**一个删的都没有** ——
// 测试数据清不掉，正式数据就容易被搅浑。
t('HTTP 桥提供 delete 动作（单元 + 课程两种范围）', () => {
  const httpSrc = readFileSync(join(root, 'src/http.ts'), 'utf-8');
  assert.match(httpSrc, /action === 'delete'/, '应有 delete 动作');
  assert.match(httpSrc, /scope === 'course'/, '应支持删整门课');
  assert.match(httpSrc, /deleteUnit/, '应调用 store.deleteUnit');
  assert.match(httpSrc, /deleteCourse/, '应调用 store.deleteCourse');
});

t('store 真的实现删除，并清理旁挂文件', () => {
  const storeSrc = readFileSync(join(root, 'src/store.ts'), 'utf-8');
  assert.match(storeSrc, /deleteUnit\(/, '应有 deleteUnit');
  assert.match(storeSrc, /deleteCourse\(/, '应有 deleteCourse');
  // 删单元要连 .raw.json / .summary.json 等一起清，否则残留会让"删不干净"
  assert.match(storeSrc, /\.raw\.json/, '应清理加工结果');
  assert.match(storeSrc, /\.summary\.json/, '应清理摘要');
  // 删单元不该把整门课目录删掉（可能还有别的讲）
  const m = storeSrc.match(/deleteUnit\([\s\S]{0,900}?\n  \}/);
  assert.ok(m, '找不到 deleteUnit 主体');
  assert.ok(!/rmSync\(this\.courseDir/.test(m[0]), 'deleteUnit 不该删除整个课程目录');
});

t('删除后清理内存态与磁盘指针（否则"删了又冒出来"）', () => {
  const httpSrc = readFileSync(join(root, 'src/http.ts'), 'utf-8');
  assert.match(httpSrc, /onAfterDelete/, 'HTTP 侧应有删除后的清理钩子');
  assert.match(hostSrcForBlanks, /onAfterDelete: \(scope, courseId, unitId\)/, 'host 应实现该钩子');
  assert.match(hostSrcForBlanks, /active\.delete\(sid\)/, '应清掉 active 里的课堂状态');
  assert.match(hostSrcForBlanks, /clearPointer\(sid\)/, '应清掉磁盘指针');
});

t('UI 有删除入口且二次确认', () => {
  const wb = readFileSync(join(root, 'src/client/workbench.tsx'), 'utf-8');
  assert.match(wb, /deleteUnit|deleteCourse/, '工作台应有删除函数');
  assert.match(wb, /window\.confirm/, '删除不可逆，必须二次确认');
  assert.match(wb, /lec-del/, '应有删除按钮');
});

console.log('\n[必须能新建课程（不只是小节）]');

// 真机反馈："大的课程章节也加不了，只能加小节"。
// 根因：开课表单里的"课程标识"输入框只在**一门课都没有**时显示
//（!hasCourses 分支），有了第一门课后就只能往它里面加小节。
t('开课表单在已有课程时仍能新建课程', () => {
  const wb = readFileSync(join(root, 'src/client/workbench.tsx'), 'utf-8');
  assert.match(wb, /newCourseMode/, '应有"新建课程 / 记到已有课程"的切换状态');
  assert.match(wb, /新建一门课程/, '应有显式的"新建课程"入口');
  // 关键：课程标识输入框的条件不能再只是 !hasCourses
  const m = wb.match(/\{!hasCourses \|\| newCourseMode \? \(/);
  assert.ok(m, '课程标识输入框的条件应包含 newCourseMode（否则有课后就再也建不了新课）');
});

t('记到已有课程时不覆盖该课的标题/学期', () => {
  const wb = readFileSync(join(root, 'src/client/workbench.tsx'), 'utf-8');
  // course_title / semester 只在 makingCourse 时传
  assert.match(wb, /makingCourse \? newCourseTitle/, 'course_title 应仅在新建课程时传');
  assert.match(wb, /makingCourse \? newSemester/, 'semester 应仅在新建课程时传');
});

console.log('\n[可选依赖必须惰性解析（不能缓存 apply 时的 undefined）]');

// 真机踩过：把 memory 从 aemeath-ui 的 inject 移出后，记忆工作区开始报
// "memory service unavailable"，而 memory 插件其实好好地挂着。
//
// 根因：代码是 `const memory = ctx.get('memory')` —— 在 **apply 时求值一次**。
//   有 inject 时，框架保证"memory 先就绪，ui 才 apply"，所以一次求值碰巧是对的；
//   去掉 inject 后这个保证没了，apply 时 memory 可能还没注册 → 拿到 undefined
//   并被**永久捕获**（闭包），此后每次请求都返回 503。
//
// 正确做法：把可选依赖包成函数，**每次用时现取**。
t('aemeath-ui 不在 apply 时缓存 memory 服务', () => {
  const raw = readFileSync(join(REPO_ROOT, 'packages/ui/dsh-plugin-ui/src/index.ts'), 'utf-8');
  // 去注释后再找：注释里会**引用**旧写法解释历史，那是应该保留的
  const uiSrc = stripComments(raw);
  assert.ok(
    !/const memory = ctx\.get\('memory'\)/.test(uiSrc),
    '不该在 apply 时一次性取 memory（会永久缓存 undefined）',
  );
  assert.match(uiSrc, /const getMemory = \(\)/, '应有惰性 getter');
  assert.match(uiSrc, /const memory = getMemory\(\)/, '使用处应现取');
});

t('惰性取值要能经得起"服务还不存在"', () => {
  const uiSrc = readFileSync(join(REPO_ROOT, 'packages/ui/dsh-plugin-ui/src/index.ts'), 'utf-8');
  const m = uiSrc.match(/const getMemory = \(\)[\s\S]{0,320}?\n  \};/);
  assert.ok(m, '找不到 getMemory 主体');
  assert.match(m[0], /try\s*\{/, 'ctx.get 可能抛错（服务未注册），要包起来');
  assert.match(m[0], /catch/, '应有 catch 兜底');
});

console.log('\n[人格必须跟随会话，不能被全局默认锁死]');

// 真机踩过（"人格锁死在 physicist，在会话里选小爱同学也没用"）：
//
//   personaTextFor 里写的是：
//       currentRole() ?? resolvePresetCompat(ctx, agent.session) ?? config.defaultPreset
//   而 currentRole() 返回 **ctx.agentPresets.defaultId（全局默认）** ——
//   它一旦有值就短路，按会话解析的那一项**永远轮不到**。
//   症状：所有会话都用全局默认人格，会话里选什么 preset 都不生效。
//
//   正确顺序：会话级 → 全局默认 → 配置默认。
t('角色解析以"会话级"优先（不能被全局默认短路）', () => {
  const src = readFileSync(join(REPO_ROOT, 'packages/shared/dsh-plugin-common/src/index.ts'), 'utf-8');
  const live = stripComments(src);

  // 必须存在这个 helper，且顺序正确
  const helper = live.match(/const roleForAgent = \(session[^)]*\)[^;]*;/);
  assert.ok(helper, '应有统一的角色解析 helper（避免多处顺序不一致）');
  const body = helper[0];
  const iSession = body.indexOf('resolvePresetCompat');
  const iGlobal = body.indexOf('currentRole()');
  assert.ok(iSession >= 0, 'helper 里应读会话级 preset');
  assert.ok(iGlobal >= 0, 'helper 里应回退全局默认');
  assert.ok(iSession < iGlobal, '会话级必须排在全局默认**之前**（否则全局默认会短路）');

  // 旧的错误顺序不能出现在活代码里
  assert.ok(
    !/currentRole\(\)\s*\?\?\s*resolvePresetCompat/.test(live),
    '不该再有 `currentRole() ?? resolvePresetCompat(...)`（全局默认会短路会话级）',
  );
});

t('人格段与日志用同一个解析函数（避免日志误导）', () => {
  const src = readFileSync(join(REPO_ROOT, 'packages/shared/dsh-plugin-common/src/index.ts'), 'utf-8');
  const live = stripComments(src);
  // 至少两处**调用**（人格段 + 挂载日志），外加定义本身。
  // 用 `= roleForAgent(agent.session)` 精确匹配调用，避免把定义算进来。
  const calls = (live.match(/= roleForAgent\(agent\.session\)/g) || []).length;
  assert.ok(calls >= 2, `人格段与日志都应调用 roleForAgent（实际 ${calls} 处）`);
});

console.log('\n[persona 必须说明"记住"由系统处理]');

// 真机反馈：用户说"记住它"，agent 去写 md 文件了。
// 根因：memory 插件**没有给 agent 工具**（只有 /memory 斜杠命令），
// 靠触发动词（"记住/记一下"…）自动总结落库；
// 而 persona 只说"不要输出记忆格式"，没说"系统会自动记住，你不用动手"。
t('四份 persona 都说明"记住"由系统自动处理、不要写文件', () => {
  const files = [
    'profiles/aemeath/personas/physicist.md',
    'profiles/aemeath/personas/aemeath.md',
    'profiles/aemeath/personas/physicist.en.md',
    'profiles/aemeath/personas/aemeath.en.md',
  ];
  for (const f of files) {
    const t = readFileSync(join(REPO_ROOT, f), 'utf-8');
    const zh = f.endsWith('.md') && !f.endsWith('.en.md');
    const needles = zh ? ['自动', '不要', '写文件'] : ['automatically', 'do **not** write files'];
    for (const n of needles) {
      assert.ok(t.includes(n), `${f} 应说明「${n}」（否则 agent 会去写文件）`);
    }
    assert.ok(!/写文件.{0,6}建笔记/.test(t) || zh, `${f} 语言与内容应一致`);
  }
});

console.log('\n[ui-agent-preset 不能被禁用（人格选择器的唯一提供者）]');

// 真机踩过两次，症状看起来无关，其实是同一个原因：
//   ① "preset 按钮点不了"
//   ② "前端上方模态锁在学霸" + "历史记录模态显示也没有"
//
//   主 profile 里把 `ui-agent-preset` 标了 `disabled: true`，
//   理由是"去掉 dsh 开发工具痕迹" —— 但它正是：
//     · conversation.hero.agentPreset      欢迎屏上方的人格模态
//     · conversation.session.header.actions 会话头部操作
//     · byId.agentPreset                    会话列表每行的人格标签
//   禁用它 → 槽位没人建 → aemeath-ui 往 hero 槽位的注册全部落空，
//   会话列表读的 `byId.agentPreset` 也没人填。
t('主 profile 没有禁用 ui-agent-preset', () => {
  const prof = readFileSync(join(REPO_ROOT, 'profiles/aemeath/cordis.patch.yml'), 'utf-8');
  // 找到该行及其后的 disabled 字段
  const m = prof.match(/- id: ui-agent-preset\s*\n(?:\s*#[^\n]*\n)*\s*disabled:\s*(\w+)/);
  assert.ok(m, '应能找到 ui-agent-preset 的 disabled 字段');
  assert.equal(m[1], 'false', 'ui-agent-preset 必须启用（否则人格选择器消失）');
});

t('aemeath-ui 依赖的 hero 槽位由该插件提供', () => {
  const hero = readFileSync(join(REPO_ROOT, 'packages/ui/dsh-plugin-ui/src/client/hero.tsx'), 'utf-8');
  assert.match(hero, /conversation\.hero\.agentPreset/, 'aemeath-ui 应往该槽位注册');
  // 提供方是官方插件，路径固定
  const provider = join(REPO_ROOT, 'node_modules/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js');
  if (existsSync(provider)) {
    const t = readFileSync(provider, 'utf-8');
    assert.match(t, /conversation\.hero\.agentPreset/, '提供方应定义该槽位');
  }
});

console.log('\n[访问 ctx.<service> 必须在 inject 里声明]');

// 真机踩过（"顶部模态锁死 + 历史标签为空 + 切换无效"）——
// 三个症状一个根因，而且最难查：
//
//   cordis 规则：读 `ctx.<service>` 前，服务名必须在 inject 数组里，
//   否则抛 `cannot get property "X" without inject`。
//
//   aemeath-ui 里裸写了 `ctx.agentPresets`，而 inject 只有 ['webServer','settings'] →
//   每次 GET /aemeath/api/settings 都在那里抛错 → 被 `catch {}` 静默吃掉 →
//   **preset 键一个都不返回** → 前端读不到角色（退回 localStorage 显示旧值），
//   写进去的也读不回来。整条链路没有一处报错。
t('aemeath-ui 的 inject 含它访问的服务', () => {
  const uiSrc = readFileSync(join(REPO_ROOT, 'packages/ui/dsh-plugin-ui/src/index.ts'), 'utf-8');
  const live = stripComments(uiSrc);
  const injectMatch = live.match(/export const inject = \[([^\]]*)\]/);
  assert.ok(injectMatch, '找不到 aemeath-ui 的 inject');
  const declared = injectMatch[1];

  // 它访问了 ctx.agentPresets → 必须在 inject 里
  if (/ctx(?: as unknown as \{[^}]*\})?\.agentPresets|\.agentPresets\b/.test(live)) {
    assert.ok(/agentPresets/.test(declared), 'inject 必须含 agentPresets（否则访问会抛错）');
  }
  // ctx.get('xxx') 形式不需要 inject（那是显式查找），但 ctx.xxx 需要
  // 这里只检查已知的几个直接属性访问
  for (const svc of ['webServer', 'settings']) {
    if (new RegExp(`ctx\\.${svc}\\b`).test(live)) {
      assert.ok(new RegExp(`['"]${svc}['"]`).test(declared), `inject 必须含 ${svc}`);
    }
  }
});

t('读服务失败时不再静默（要有可见日志）', () => {
  const uiSrc = readFileSync(join(REPO_ROOT, 'packages/ui/dsh-plugin-ui/src/index.ts'), 'utf-8');
  // 解析角色的那段 catch 里应有 console.warn，而不是空 catch
  const seg = uiSrc.match(/读 agentPresets 失败[\s\S]{0,160}/);
  assert.ok(seg, '读 agentPresets 失败时应有明确告警（不能再被 catch 静默吃掉）');
});

console.log('\n[mac 独立模式必须保留对话输入框]');

// 真机踩过（用户原话："mac 上没有输入框我记个 der 的笔记"）——
// 设计失误，不是实现 bug：
//
//   "记笔记在主界面的对话里"这个方案**只在 Windows 成立**（那里有主 agent）。
//   mac 上没有主 agent，所以隐藏 shell 之后必须**自带输入框**。
//
//   ⚠️ 中间试过一版"不隐藏 shell、上下分屏、复用 dsh 的 composer"，
//      用户否掉了："不要把整个主agent塞进去啊，放一个输入框就完了……也不要分屏"。
//      所以现在：**照旧隐藏 shell**，输入框由工作台中栏自己提供。
//      "不再隐藏"那类断言已随方案回退删除 —— 不要重新加回来。

t('独立模式铺满整窗（输入框由中栏自己提供）', () => {
  const m = stripComments(stylesSrc).match(/\[data-standalone="1"\]\s*\{([\s\S]*?)\}/);
  assert.ok(m, '找不到 data-standalone 样式块');
  assert.match(m[1], /position:\s*fixed/, 'standalone 应铺满整窗（课堂窗就是它）');
  assert.match(m[1], /inset:\s*0/, 'standalone 应占满视口');
});

t('UI 文案指向中栏下面的输入框（与实际位置一致）', () => {
  const wb = readFileSync(join(root, 'src/client/workbench.tsx'), 'utf-8');
  assert.match(wb, /下面的输入框/, '文案应指向中栏下面的输入框');
  assert.ok(!/主界面的对话/.test(wb), '不该再说"主界面"（mac 上没有主界面）');
  assert.ok(!/对话输入框/.test(wb), '不该再提"对话输入框"（那是已否掉的分屏方案）');
});

t('旧的 lecture-mode.tsx 已删除（避免改错文件）', () => {
  assert.ok(
    !existsSync(join(root, 'src/client/lecture-mode.tsx')),
    '旧的侧栏版组件应已删除（它没有输入框、也不再被引用）',
  );
});

console.log('\n[中栏底部要有速记输入框]');

// 真机踩过（用户："mac 上没有输入框我记个 der 的笔记"）——
// "记笔记在主界面对话里"只在 Windows 成立；mac 上 lecture 独装，没有主 agent。
// 用户定的形态："本来中间的区域就有很多空闲放一个输入框就行了"。
const wbLive2 = stripComments(readFileSync(join(root, 'src/client/workbench.tsx'), 'utf-8'));

t('中栏渲染了公式输入框（MathLive，不依赖 dsh）', () => {
  // 输入框从普通 textarea 换成了 MathLive 的 math-field（Word 式公式编辑）。
  const mc = readFileSync(join(root, 'src/client/math-composer.tsx'), 'utf-8');
  assert.match(mc, /export function MathComposer/, '应有 MathComposer 组件');
  assert.match(wbLive2, /<MathComposer\b/, '中栏应渲染 MathComposer');
  assert.match(mc, /createElement\('math-field'\)/, '应创建 math-field 元素');
  // 必须能降级：MathLive 不可用时至少还能记
  assert.match(mc, /lec-composer-input/, '应有 textarea 降级路径');
});

t('输入框直接落盘（不经 LLM、不依赖对话）', () => {
  // 上课现场等模型太慢；且课堂内 LLM 输出按 D3 只在后端
  assert.match(wbLive2, /action:\s*'chunk'/, '应调 chunk 端点落盘');
  assert.match(wbLive2, /fetch\(API\b/, '应打本插件的 HTTP 桥');
  assert.ok(!/lecture_capture/.test(wbLive2), '前端不该调工具（那是 agent 的路径）');
});

t('输入框可提交（MathLive 主路径 + 降级 textarea）', () => {
  const mc = readFileSync(join(root, 'src/client/math-composer.tsx'), 'utf-8');
  // MathLive 路径：Enter 由它自己处理，我们提供明确的「记下」按钮
  assert.match(mc, /lec-composer-send/, '应有「记下」按钮');
  // 降级路径：仍要 Enter 发送 / Shift+Enter 换行 / 输入法保护
  assert.match(mc, /e\.key === 'Enter'/, '降级 textarea 应处理 Enter');
  assert.match(mc, /!e\.shiftKey/, 'Shift+Enter 应留给换行');
  assert.match(mc, /isComposing/, '输入法组合中不应拦截 Enter（中文输入必需）');
});

t('笔记区自己滚动、输入框钉在底部', () => {
  // 否则输入框跟着内容滚走，上课要滚回底部才能打字
  assert.match(stylesSrc, /\.lec-composer\s*\{[\s\S]{0,200}?flex:\s*none/, '输入框不该被压缩');
  assert.match(stylesSrc, /\.lec-wb-scroll\s*\{[\s\S]{0,200}?overflow-y:\s*auto/, '笔记区应自己滚动');
});

t('提交失败不能吞（要有明确提示）', () => {
  const mc = readFileSync(join(root, 'src/client/math-composer.tsx'), 'utf-8');
  // MathLive 版本：失败时**不清空**（清空只在成功分支里），
  // 所以内容天然还留着；同时给明确提示，不静默。
  assert.match(mc, /没记上/, '应有明确失败提示');
  assert.match(mc, /catch \(e\)/, '应捕获提交失败');
  // 清空只能发生在成功之后（在 catch 里清空就会丢掉用户内容）
  const catchSeg = mc.match(/catch \(e\)[\s\S]{0,200}/);
  assert.ok(catchSeg, '找不到 catch');
  assert.ok(!/\.value = ''/.test(catchSeg[0]), 'catch 里不该清空内容（那会丢用户输入）');
});

console.log('\n[复盘确认后必须真的能送到主记忆]');

// 真机踩过（用户："前端说写入主agent了，但是肯定没有，肯定只是在mac上面"）：
//
//   commit 步只写本机 .candidates.json，前端却说"已记录" →
//   用户以为已经同步进主记忆。实际导出是**另一个手动工具**，没人调就永远不过去。
//
//   现实约束（决定了方案）：上课时 mac 在教室、Windows 在家，
//   **两台机器不可能同时在线** → 没有"自动推送"这个选项。
//   只能：mac 导出自包含文件 → 人搬运 → Windows 一键导入。
//
//   所以两件事都必须做：
//     ① commit 后**自动导出**（别让人记着调工具）
//     ② 前端**说清文件在哪、下一步做什么**（别再让人误会已同步）
const hostSrc3 = readFileSync(join(root, 'src/index.ts'), 'utf-8');
const rpSrc = readFileSync(join(root, 'src/client/review-panel.tsx'), 'utf-8');

t('commit 后自动导出握手包（不靠人记得调工具）', () => {
  assert.match(hostSrc3, /function exportHandoffNow/, '应抽出可复用的导出函数');
  // commit 分支里调用它
  const commitSeg = hostSrc3.match(/op === 'commit'[\s\S]{0,2400}?\n\s{10}\}/);
  assert.ok(commitSeg, '找不到 commit 分支');
  assert.match(commitSeg[0], /exportHandoffNow\(/, 'commit 后应自动导出');
  // 导出失败不能阻断复盘
  assert.match(commitSeg[0], /catch[\s\S]{0,120}自动导出握手包失败/, '导出失败应仅告警，不阻断');
});

t('commit 返回握手文件路径（前端才能显示）', () => {
  assert.match(hostSrc3, /handoff_files:\s*handoffFiles/, '应返回 handoff_files');
  assert.match(hostSrc3, /handoff_dir:\s*handoffDir/, '应返回 handoff_dir');
});

t('前端显示文件路径并说明"不会自动发生"', () => {
  assert.match(rpSrc, /handoff_files/, '前端应读 handoff_files');
  assert.match(rpSrc, /下一步/, '应说明下一步做什么');
  assert.match(rpSrc, /不会自动发生/, '必须点明"这一步不会自动发生"——否则用户以为已同步');
  assert.ok(
    !/已记录。回到主 agent 后可用 lecture_export_handoff/.test(rpSrc),
    '不该再是旧的模糊说法（它让人以为已经同步了）',
  );
});

t('导入工具自解释（用户说"导入讲义进度"就能命中）', () => {
  assert.match(hostSrc3, /导入讲义进度/, '工具描述里应含用户会说的自然语言触发词');
  assert.match(hostSrc3, /已扫描目录/, '找不到文件时应告知扫过哪些目录');
});

console.log('\n[三条使用反馈的回归]');

// 都是真机用了一段时间后提的：
//   ① "左边课程最好加一个折叠，免得到时候几十上百节课都列出来了"
//   ② "笔记的理解和疑问目前无法输入"
//   ③ "符号键盘可以做点击就直接输入输入框，不过复制也保留挺好用的"
const wbLive3 = stripComments(readFileSync(join(root, 'src/client/workbench.tsx'), 'utf-8'));
const symLive = stripComments(readFileSync(join(root, 'src/client/symbol-palette.tsx'), 'utf-8'));
const httpLive = stripComments(readFileSync(join(root, 'src/http.ts'), 'utf-8'));

t('课程可折叠（几十门课时不会淹没）', () => {
  assert.match(wbLive3, /const \[collapsed, setCollapsed\]/, '应有折叠状态');
  assert.match(wbLive3, /lec-course-toggle/, '应有折叠按钮');
  assert.match(wbLive3, /aria-expanded=/, '折叠按钮应有 aria-expanded（可访问性）');
  // 默认只展开当前选中那门
  assert.match(wbLive3, /c\.course_id === courseId/, '默认应只展开当前课程');
  // 收起时要能看到里面有几节
  assert.match(wbLive3, /lec-course-count/, '收起时应显示小节数量');
});

t('留白可编辑并保存（不再是只读展示）', () => {
  assert.match(wbLive3, /function BlankField/, '应有可编辑的留白组件');
  assert.match(wbLive3, /action: 'blanks'/, '应调 blanks 端点保存');
  assert.match(wbLive3, /onBlur=\{\(\) => void save\(\)\}/, '失焦应保存');
  // 不该再是纯文本展示
  const blanksSeg = wbLive3.match(/lec-note-blanks[\s\S]{0,600}/);
  assert.ok(blanksSeg, '找不到留白区');
  assert.ok(!/<span>\{c\.my_understanding/.test(blanksSeg[0]), '不该再把留白当纯文本渲染');
});

t('留白只走前端桥（不给 LLM 工具，防代笔）', () => {
  // D12：主动回忆的价值在于用户自己写；模型能调就是灾难
  const hostSrc4 = readFileSync(join(root, 'src/index.ts'), 'utf-8');
  assert.match(hostSrc4, /onUpdateBlanks/, 'host 侧应有 onUpdateBlanks');
  assert.ok(
    !/name: 'lecture_update_blanks'/.test(hostSrc4),
    '不该把改留白暴露成 LLM 工具（模型代笔会让复盘失去意义）',
  );
  // HTTP 侧要有校验
  assert.match(httpLive, /action === 'blanks'/, 'HTTP 应支持 blanks action');
  assert.match(httpLive, /action === 'blanks'[\s\S]{0,900}?!Number\.isInteger\(seq\)/, '应校验 seq');
});

t('符号点击同时插入输入框 + 复制', () => {
  // 两件事都做，不是二选一（用户："复制也保留挺好用的"）
  assert.match(symLive, /onInsert\?\.|onInsert\(/, '符号面板应支持插入回调');
  assert.match(symLive, /copyText\(sym\.insert\)/, '同时仍要复制（保留原有能力）');
  // 插入要在复制之前（先给输入框，复制是附加）
  // 注：调用签名是 onInsert(sym.insert, sym.label) —— 第二个参数是纯文本回退
  const insIdx = symLive.indexOf('onInsert(sym.insert');
  const copyIdx = symLive.indexOf('copyText(sym.insert)');
  assert.ok(insIdx >= 0 && copyIdx >= 0 && insIdx < copyIdx, '应先插入再复制');
});

t('插入走命令式 ref（兄弟子树才够得着光标）', () => {
  const mc = readFileSync(join(root, 'src/client/math-composer.tsx'), 'utf-8');
  assert.match(wbLive3, /composerApi/, '应有 composerApi ref');
  // 接口定义搬到 math-composer.tsx 了（ComposerApi → MathComposerApi）
  assert.match(mc, /interface MathComposerApi/, '应定义接口');
  assert.match(mc, /el\.insert\(latex\)/, 'MathLive 用 insert()（不是 executeCommand）');
  assert.match(wbLive3, /onInsert=\{\(snippet\)/, '应把插入能力接到符号面板');
});

console.log('\n[MathLive 公式输入（Word 式）]');

// 用户："最好做成 word 的等式输入那种吧"
//      "符号键盘的向量不可以自定义向量字母，也没有积分符号之类的上下左右填充"
const mcSrc = readFileSync(join(root, 'src/client/math-composer.tsx'), 'utf-8');
const dataSrc = readFileSync(join(root, 'src/symbol-data.ts'), 'utf-8');

t('用 math-field 而不是 textarea 做输入框', () => {
  assert.match(mcSrc, /createElement\('math-field'\)/, '应创建 MathLive 元素');
  assert.match(mcSrc, /from 'mathlive'|import\('mathlive'\)/, '应引入 mathlive');
});

t('MathLive 懒加载（823KB 不该在打开课堂时同步加载）', () => {
  assert.match(mcSrc, /await import\('mathlive'\)/, '应动态 import');
  assert.match(mcSrc, /mathlivePromise/, '应缓存加载 Promise（只加载一次）');
});

t('关掉 MathLive 自带虚拟键盘（我们用右栏的符号板）', () => {
  assert.match(mcSrc, /math-virtual-keyboard-policy'\s*,\s*'manual'/, '应设成 manual');
});

t('LaTeX 落盘（不是 HTML）', () => {
  // 笔记要能被 LLM 读、二次渲染、跨版本存活 → 存 LaTeX 源码
  assert.match(mcSrc, /\.value/, '应读 math-field 的 value（LaTeX 源码）');
  assert.ok(!/outerHTML|innerHTML/.test(mcSrc), '不该存 HTML');
});

t('积分/求和用 \\placeholder{} 而不是裸空花括号', () => {
  // 真机实测：`\int_{}^{}` 的空花括号**不是可填的框**，
  // 打字会跑到积分后面（得到 `\int_{}^{}7`）；
  // 必须 `\placeholder{}` 才产生真正可点进去的占位。
  for (const label of ['∫ 上下限', '∮ 路径', '∑ 上下限', '∏ 上下限']) {
    const re = new RegExp(`label: '${label}'[\\s\\S]{0,160}?insert: '([^']+)'`);
    const m = dataSrc.match(re);
    assert.ok(m, `找不到 ${label}`);
    assert.ok(m[1].includes('\\placeholder{}'), `${label} 应用 \\placeholder{}，实际：${m[1]}`);
    assert.ok(!/_\{\}\^?\{\}/.test(m[1]), `${label} 不该用裸 {} （框填不进去）`);
  }
});

t('矢量字母可自定义（\\vec{占位}，不是硬编码 r⃗）', () => {
  const m = dataSrc.match(/label: 'a⃗ 矢量'[\s\S]{0,140}?insert: '([^']+)'/);
  assert.ok(m, '应有矢量符号');
  assert.ok(m[1].includes('\\vec{'), '应是 \\vec{...}');
  assert.ok(m[1].includes('\\placeholder{}'), '里面应有可填字母的占位');
});

t('MathLive 挂了要能降级（上课时输入框不能消失）', () => {
  // 双模式之后，降级的含义变了：不再是"退回 textarea"，
  // 而是"公式模式标记不可用，文字模式照常工作"。
  assert.match(mcSrc, /setMathFailed\(true\)/, '加载失败应标记公式不可用');
  assert.match(mcSrc, /公式编辑器加载失败/, '应明确告知用户');
  assert.match(mcSrc, /lec-composer-input/, '文字模式仍用 textarea（照常记笔记）');
});

t('输入框有文字/公式双模式，默认文字', () => {
  // 真机反馈："那现在是不是整个输入框都是公式文字了？正常文本怎么办呢"
  // —— MathLive 是数学模式：中文/英文被当变量（斜体）、空格被吞、不能多行。
  // 所以拆成两个模式：默认文字（普通 textarea），需要时切公式。
  const mc = readFileSync(join(root, 'src/client/math-composer.tsx'), 'utf-8');
  assert.match(mc, /useState<ComposerMode>\('text'\)/, '**默认必须是文字模式**');
  assert.match(mc, /lec-composer-tab/, '应有模式切换按钮');
  // 文字模式要有真正的 textarea（空格/换行/中文靠它）
  assert.match(mc, /mode === 'text' \? \(/, '文字模式应渲染 textarea');
  assert.match(mc, /multi-line|rows=\{2\}/, 'textarea 应可多行');
});

t('公式模式才加载 MathLive（用不到就别下 823KB）', () => {
  const mc = readFileSync(join(root, 'src/client/math-composer.tsx'), 'utf-8');
  assert.match(mc, /mode !== 'math' \|\| mathReady/, '只有切到公式模式才加载');
});

t('文字模式下点符号会切到公式模式（否则 LaTeX 会变成一串反斜杠）', () => {
  const mc = readFileSync(join(root, 'src/client/math-composer.tsx'), 'utf-8');
  // 注意：`insert(latex: string...)` 出现两次 —— 接口声明（以 ; 结尾）和实现（以 { 开头）。
  // 要匹配的是**实现**那一处。
  const impl = mc.match(/insert\(latex: string[^)]*\)\s*:\s*void\s*\{[\s\S]{0,600}/);
  assert.ok(impl, '找不到 insert 实现');
  assert.match(impl[0], /if \(mode === 'text'\)\s*\{/, '应有文字模式分支');
  assert.match(impl[0], /setMode\('math'\)/, '文字模式应自动切公式');
});

console.log(`\n[check8.mjs] ${passed} 项断言通过`);
