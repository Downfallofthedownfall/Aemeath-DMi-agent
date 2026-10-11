// ============================================================
// main.js — Electron 主进程（M5 桌宠壳 v2）
// 职责：
//   1. 托管 dsh 进程：启动 `scripts/dsh.ps1 --profile aemeath --port 3081`
//      （或复用已在 3081 运行的实例），退出时停止。
//   2. 无边框品牌窗口：自绘标题栏（品牌位 + 窗口控制），加载本地 3081
//      （同源 fetch/WS 天然可用，__DSH_BOOT__ 由 host 注入）。
//   3. IPC 桥：窗口控制（最小化/最大化/关闭）、服务状态、外链。
// 形态说明：官方 file:// + fetch IPC 桥需要静态化 __DSH_BOOT__（host 运行时
//   注入）且 WebApiClient.doFetch 硬编码 globalThis.fetch；v1 采用「托管 +
//   本地 3081 加载」——功能等价、无需重写传输层，留 file:// 桥为后续增强。
//
// 安全（C24）：
//   - 单实例锁（requestSingleInstanceLock）；
//   - 端口探测后校验服务身份（HTTP GET 确认是 dsh 页面，非任意进程占 3081）；
//   - will-navigate 只允许本地 3081 源；外链 setWindowOpenHandler 只放 https；
//   - waitForService 超时/端口被占用 → 加载本地错误页而非白屏。
// 打包（C1）：extraResources 携带 scripts/profiles/packages/package*.json，
//   首次运行在 resources 下自动 npm ci 补齐 dsh CLI 与插件依赖。
// ============================================================
const { app, BrowserWindow, ipcMain, shell, session, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const http = require('http');

const PORT = 3081;
const HOST = '127.0.0.1';
// 开发态：app/ → 仓库根；打包态：resources/app.asar → resources（extraResources 落点）
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_SCRIPT = path.join(REPO_ROOT, 'scripts', 'dsh.ps1');
const APP_ORIGIN = `http://${HOST}:${PORT}`;

let mainWindow = null;
// 课堂记录模式的**独立窗口**。
// 为什么必须开第二个 BrowserWindow（而不是在宿主 Web UI 里做面板）：
//   dsh 的 Web UI 只开放 sidebar/conversation/details/shell.overlay 四个座位，
//   插件**没有能力**开新 OS 窗口（记忆工作区当初也因此退而做全屏层）。
//   用户要的是"可以摆到屏幕边上、不跟主窗口重叠"的真窗口 —— 只有壳能做到。
let lectureWindow = null;
// 记住认证 URL：主窗口启动时拿到，开课堂窗口时复用（同一 token）。
let authedUrlForChildren = null;
let dshProc = null;
let isQuitting = false;

// ===== 单实例锁（C24）=====
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ===== 服务探测（C24：端口连通 ≠ dsh，需校验服务身份）=====
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1200, () => { socket.destroy(); resolve(false); });
  });
}

/** 校验 3081 上跑的是 dsh（HTTP GET / 的页面含 dsh 特征）；非 dsh 返回 false。 */
function isDshService(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 20000) req.destroy();
      });
      res.on('end', () => resolve(/dsh/i.test(body)));
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 等待服务就绪。返回：
 *   'ready'    端口开放且身份校验通过（是 dsh）
 *   'foreign'  端口开放但**持续**被非 dsh 进程占用
 *   'timeout'  超时未就绪
 *
 * ⚠️ 真机踩过：早先版本在端口一开放时就**一次性**判定身份，
 * 失败即 return 'foreign'。但 dsh 的端口先于"能正确响应 HTTP"开放：
 * 那段启动窗口里 `isDshService` 会因连接重置/空响应返回 false，
 * 于是被误判成"外来进程"——用户看到的是"检测到 3081 上的不是 Aemeath 服务"，
 * 而实际上那正是刚要起来的 dsh（手动再点一次往往就好了，典型的竞态）。
 *
 * 现在改为：身份校验失败**不算终局**，在超时预算内持续重试；
 * 只有超时仍不是 dsh 才判定 'foreign'（真正的占用）。
 * 这样既保留 C24 的防护意图，又不会把启动竞态误报成占用。
 */
async function waitForService(port, timeoutMs) {
  const start = Date.now();
  let sawOpenPort = false;
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) {
      sawOpenPort = true;
      if (await isDshService(port)) return 'ready';
      // 端口开着但身份还没确认：可能是 dsh 正在启动 → 继续等，不立刻判死
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // 超时：端口确实一直开着但始终不是 dsh → 才认定为外来占用
  return sawOpenPort ? 'foreign' : 'timeout';
}

// ===== 首次运行依赖引导（C1：打包后 resources 无 node_modules，自动 npm ci）=====
function ensureDshCli() {
  return new Promise((resolve) => {
    const dshBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'dsh.cmd');
    if (fs.existsSync(dshBin)) {
      resolve(true);
      return;
    }
    console.log('[shell] 未找到 node_modules（打包环境），执行 npm ci 补齐依赖…');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(npm, ['ci', '--cache', path.join(REPO_ROOT, '.npm-cache')], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.stdout.on('data', (d) => console.log('[npm-ci]', String(d).trim()));
    proc.stderr.on('data', (d) => console.error('[npm-ci]', String(d).trim()));
    proc.on('error', (err) => {
      console.error('[shell] npm ci 启动失败:', err.message);
      resolve(false);
    });
    proc.on('close', (code) => {
      console.log(`[shell] npm ci ${code === 0 ? '完成' : `失败（${code}）`}`);
      resolve(code === 0);
    });
  });
}

// ===== dsh 进程托管 =====
/**
 * dsh 启动时打印的「带认证 token 的 URL」。
 * `dsh web` 用进程级 launch token 换 cookie 才能进 UI：裸访问 / 一律 401。
 * 所以必须从 stdout 抓 `dsh web: http://127.0.0.1:<port>/?token=...` 这一行，
 * 让窗口加载带 token 的地址（首次访问换取 cookie，之后即可正常导航）。
 */
let authenticatedUrl = null;
const AUTH_URL_RE = /dsh web:\s+(https?:\/\/\S+)/;

async function startDsh() {
  // 若 3081 已有 dsh 实例（用户自己起的），直接复用。
  // 注意：复用场景拿不到它的 token（token 只在其 stdout 里），
  // 因此这种情况下窗口很可能 401——此时提示用户自行在浏览器打开，
  // 或先关掉那一个实例让本壳自己拉起（见下方 createWindow 分支）。
  if (await portOpen(PORT)) {
    if (await isDshService(PORT)) {
      console.log('[shell] 复用已有 dsh 服务（3081）');
      return 'ready';
    }
    console.error('[shell] 3081 被非 dsh 进程占用，不再启动本服务');
    return 'foreign';
  }
  console.log('[shell] 启动 dsh 服务（3081）…');
  // --no-open：不要弹出系统默认浏览器——壳自己就是那个"浏览器"。
  // 否则会出现「浏览器打开一份 + Electron 里又一份」的双开。
  const args = [
    '-ExecutionPolicy', 'Bypass', '-File', DSH_SCRIPT,
    '--profile', 'aemeath', '--port', String(PORT), '--no-open',
  ];
  dshProc = spawn('powershell', args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  dshProc.stdout.on('data', (d) => {
    const msg = String(d).trim();
    if (msg) console.log('[dsh]', msg);
    // 抓取认证 URL（可能分片到达，故在累积缓冲上匹配）
    stdoutBuffer += String(d);
    const m = AUTH_URL_RE.exec(stdoutBuffer);
    if (m && !authenticatedUrl) {
      authenticatedUrl = m[1];
      console.log('[shell] 已获取认证 URL（窗口将加载带 token 的地址）');
      if (pendingResolve) { pendingResolve(); pendingResolve = null; }
    }
  });
  dshProc.stderr.on('data', (d) => {
    const msg = String(d).trim();
    if (msg) console.error('[dsh]', msg);
  });
  dshProc.on('error', (err) => console.error('[shell] dsh 启动失败:', err.message));
  dshProc.on('close', (code) => {
    console.log(`[shell] dsh 已退出（${code}）`);
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shell:status', { state: 'stopped' });
    }
    dshProc = null;
  });
  // 等待就绪（C24：超时返回，不在此开白屏——窗口层据结果决定加载内容）
  return waitForService(PORT, 60000);
}

/** stdout 累积缓冲（认证 URL 可能跨 chunk）+ 等待它出现的一次性 resolver。 */
let stdoutBuffer = '';
let pendingResolve = null;

/**
 * 等待认证 URL 出现（最多 timeoutMs）。
 * @returns 带 token 的 URL；超时返回 null（调用方回退裸 origin）。
 */
function waitForAuthUrl(timeoutMs) {
  if (authenticatedUrl) return Promise.resolve(authenticatedUrl);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingResolve = null; resolve(null); }, timeoutMs);
    pendingResolve = () => { clearTimeout(timer); resolve(authenticatedUrl); };
  });
}

function stopDsh() {
  if (!dshProc || !dshProc.pid) return;
  try {
    spawnSync('taskkill', ['/pid', String(dshProc.pid), '/f', '/t'], { stdio: 'ignore' });
  } catch (e) {
    console.error('[shell] 停止 dsh 失败:', e.message);
  }
  dshProc = null;
}

// ===== 本地错误页（C24：服务不可用时加载，不白屏、不加载外来内容）=====
// i18n：Electron 主进程无浏览器 locale 服务，按系统语言（app.getLocale）选择文案。
function errorPageHtml(title, detail) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const retryLabel = uiText('重试', 'Retry');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
  <body style="background:#141821;color:#e8ecf4;font-family:Segoe UI,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center;max-width:520px">
    <h2 style="margin:0 0 12px">${esc(title)}</h2>
    <p style="color:#aab4c8;font-size:13px;line-height:1.6">${esc(detail)}</p>
    <button onclick="location.reload()" style="margin-top:16px;padding:8px 20px;border:none;border-radius:8px;background:#5b8def;color:#fff;cursor:pointer;font-size:13px">${esc(retryLabel)}</button>
  </div></body></html>`;
}

/** 按系统语言返回文案（zh/en）。 */
function uiText(zh, en) {
  try {
    const lang = String(app.getLocale() ?? '').toLowerCase();
    if (lang.startsWith('en')) return en;
  } catch {
    /* fallthrough */
  }
  return zh;
}

// ===== 窗口 =====
function createWindow(loadUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    // 无边框 + 原生窗口控制按钮（titleBarOverlay），配色对齐爱弥斯深色主题
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#141821',
      symbolColor: '#e8ecf4',
      height: 40,
    },
    backgroundColor: '#141821',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 自绘标题栏需要窗口状态反馈（最大化还原）
  const sendState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shell:window-state', {
        maximized: mainWindow.isMaximized(),
        fullscreen: mainWindow.isFullScreen(),
      });
    }
  };
  mainWindow.on('maximize', sendState);
  mainWindow.on('unmaximize', sendState);
  mainWindow.on('enter-full-screen', sendState);
  mainWindow.on('leave-full-screen', sendState);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 自绘标题栏拖拽区：顶部 40px 可拖拽移动窗口（与 titleBarOverlay 同高），
  // 右侧窗口控制按钮区由系统处理（无需 no-drag）。
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.insertCSS(`
      html { --dsh-titlebar-height: 40px; }
      body::before {
        content: '';
        position: fixed;
        top: 0; left: 0; right: 96px;
        height: var(--dsh-titlebar-height);
        z-index: 2147483647;
        -webkit-app-region: drag;
        pointer-events: none;
      }
    `).catch(() => {});
  });

  // C24：导航守卫——只允许本地 3081 源（防被重定向到任意页面）。
  // 用 origin 精确比较而非 startsWith 前缀匹配：前缀匹配会被
  // "http://127.0.0.1:30810.evil.com" 这类端口粘连 URL 绕过。
  mainWindow.webContents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).origin !== APP_ORIGIN) e.preventDefault();
    } catch {
      e.preventDefault(); // 非法 URL：一律拦截
    }
  });

  // C24：外链只放 https（拒绝 http/自定义 scheme/file），交系统默认浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 外链与下载走系统默认
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 课堂窗是主窗口的**辅助窗**：主窗口关了它也不该独自留着
    // （否则 window-all-closed 不触发、应用退不出去）。
    closeLectureWindow();
  });

  mainWindow.loadURL(loadUrl);
}

// ============================================================
// 课堂记录模式：独立窗口
// ============================================================

/** 课堂窗口的位置/尺寸记忆（存在 userData 下的小 JSON）。 */
function lectureStatePath() {
  return path.join(app.getPath('userData'), 'lecture-window.json');
}

function loadLectureState() {
  try {
    const raw = fs.readFileSync(lectureStatePath(), 'utf-8');
    const s = JSON.parse(raw);
    if (typeof s?.width === 'number' && typeof s?.height === 'number') return s;
  } catch {
    /* 首次运行 / 文件损坏：用默认值 */
  }
  return null;
}

function saveLectureState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    fs.writeFileSync(lectureStatePath(), JSON.stringify({ ...b, maximized: win.isMaximized() }), 'utf-8');
  } catch {
    /* 忽略：位置记忆失败不该影响使用 */
  }
}

/**
 * 打开（或聚焦）课堂记录窗口。
 *
 * 复用规则：已有窗口 → 直接 focus（单例，符合"工具窗"直觉）。
 * 无认证 URL（比如复用了外部 dsh 实例）→ 返回 false，由调用方提示。
 */
function openLectureWindow() {
  if (lectureWindow && !lectureWindow.isDestroyed()) {
    if (lectureWindow.isMinimized()) lectureWindow.restore();
    lectureWindow.focus();
    return true;
  }
  if (!authedUrlForChildren) return false;

  // 默认摆到主窗口右侧（不重叠）——这正是用户要的"放在边上"。
  const saved = loadLectureState();
  let bounds = { width: 460, height: 860 };
  if (saved) {
    bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    const mb = mainWindow.getBounds();
    const disp = screen.getDisplayMatching(mb).workArea;
    // 优先贴主窗口右边缘；放不下则贴屏幕右侧
    const w = 460;
    let x = mb.x + mb.width - w;
    if (x + w > disp.x + disp.width) x = disp.x + disp.width - w - 12;
    bounds = { x, y: mb.y, width: w, height: mb.height };
  }

  lectureWindow = new BrowserWindow({
    ...bounds,
    minWidth: 360,
    minHeight: 420,
    // 课堂窗是辅助窗：标题栏用原生（简单、可拖），不抢主窗口的品牌样式
    title: '课堂记录 · Aemeath',
    // 首帧底色跟随系统主题（加载完由前端 --dsw-alias-bg-base 接管）。
    // 写死颜色会让亮色主题下启动瞬间闪一下深色。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#fdeef5',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // ⚠️ 用 additionalArguments 而不是 URL query 自报"我是课堂窗口"。
      //    踩过的坑：dsh 的认证流程会 `303 → ./` 把 URL 重写成裸路径，
      //    query 上的标记会被丢掉（实测 location.search 变成空）。
      //    additionalArguments 在**渲染进程启动前**就注入到 process.argv，
      //    preload 可同步读出并挂到 window 上 —— 任何跳转都丢不掉。
      additionalArguments: ['--aemeath-lecture-window=1'],
    },
  });

  if (saved?.maximized) lectureWindow.maximize();

  // 同一套安全策略（与主窗口一致）：只允许本地源；外链走系统浏览器
  lectureWindow.webContents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).origin !== APP_ORIGIN) e.preventDefault();
    } catch {
      e.preventDefault();
    }
  });
  lectureWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // ⚠️ 课堂窗口靠 **URL query** 自报身份，而不是 did-finish-load 里 executeJavaScript：
  //    标记必须在客户端插件 apply() 之前就可见，而 executeJavaScript 是在页面加载完成后
  //    才 push 进去的 —— 插件那时已经决定渲染面板还是整窗了（真机踩到：窗口里显示的是
  //    主 agent 界面，因为 standalone 判定拿到 false）。
  //    query 是同步可读的、先于任何脚本执行，没有竞态。
  lectureWindow.on('resize', () => saveLectureState(lectureWindow));
  lectureWindow.on('move', () => saveLectureState(lectureWindow));
  lectureWindow.once('ready-to-show', () => lectureWindow.show());
  lectureWindow.on('closed', () => {
    lectureWindow = null;
    // 通知主窗口：入口按钮状态复位
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shell:lecture-window', { open: false });
    }
  });

  // 身份标记走 webPreferences.additionalArguments（见上面的注释），
  // 这里只加载普通认证 URL —— URL 会被 dsh 的认证流程重写，不能承载标记。
  lectureWindow.loadURL(authedUrlForChildren);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shell:lecture-window', { open: true });
  }
  return true;
}

function closeLectureWindow() {
  if (lectureWindow && !lectureWindow.isDestroyed()) lectureWindow.close();
}

// ===== IPC =====
ipcMain.handle('shell:minimize', () => mainWindow?.minimize());
ipcMain.handle('shell:maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('shell:close', () => {
  isQuitting = true;
  app.quit();
});
ipcMain.handle('shell:get-info', () => ({
  port: PORT,
  host: HOST,
  url: APP_ORIGIN + '/',
  version: '2.0.0-m0',
}));

// ===== 课堂记录窗口（独立窗口）=====
// 渲染进程（侧边栏「课堂」按钮）经此请求开窗；**不在 Web UI 内做面板**。
ipcMain.handle('shell:lecture-open', () => {
  const ok = openLectureWindow();
  return { ok, reason: ok ? '' : 'no-auth-url' };
});
ipcMain.handle('shell:lecture-close', () => {
  closeLectureWindow();
  return { ok: true };
});
ipcMain.handle('shell:lecture-is-open', () => ({
  open: !!(lectureWindow && !lectureWindow.isDestroyed()),
}));

// ===== 生命周期 =====
app.whenReady().then(async () => {
  const depsOk = await ensureDshCli();
  const serviceState = depsOk ? await startDsh() : 'unavailable';
  if (serviceState === 'ready') {
    // 关键：必须加载**带认证 token** 的地址，否则 dsh 的浏览器信任栅栏
    // 会返回 401（"dsh web authentication required"）。
    // token 由 dsh 进程在 stdout 打印，startDsh 已在后台抓取。
    const authed = await waitForAuthUrl(8000);
    if (authed) {
      console.log('[shell] 加载认证 URL');
      // 课堂窗口复用同一 token（同源、同会话）
      authedUrlForChildren = authed;
      createWindow(authed);
    } else {
      // 拿不到 token：要么是复用了外部已有实例（其 token 我们无从获取），
      // 要么 dsh 还没来得及打印。加载一个说明页，而不是直接撞 401。
      console.warn('[shell] 未获取到认证 URL，显示引导页');
      createWindow('data:text/html;charset=utf-8,' + encodeURIComponent(
        errorPageHtml(
          uiText('需要手动完成一次认证', 'One-time sign-in required'),
          uiText(
            '检测到 3081 已在运行，但它不是本壳启动的，因此拿不到本次会话的认证凭据。\n'
            + '请任选其一：\n'
            + '  1) 关闭那个 dsh 实例后重启本程序（推荐，壳会自动完成认证）；\n'
            + '  2) 或在浏览器里打开 dsh 启动日志中打印的带 token 的 URL 完成一次认证。',
            'Port 3081 is already served, but not by this shell, so its session credential is unavailable.\n'
            + 'Either: (1) close that dsh instance and restart this app (recommended), or\n'
            + '(2) open the tokenized URL printed in the dsh startup log in a browser once.',
          ),
        ),
      ));
    }
  } else if (serviceState === 'foreign') {
    // C24：端口被非 dsh 进程占用——不加载外来内容，显示错误页
    createWindow('data:text/html;charset=utf-8,' + encodeURIComponent(
      errorPageHtml(
        uiText('端口 3081 被其他程序占用', 'Port 3081 is occupied by another program'),
        uiText(
          '检测到 3081 端口上运行的不是 Aemeath 服务（可能是其他程序）。\n请先关闭占用该端口的程序，或修改 app/main.js 的 PORT 后重试。',
          'Port 3081 is not running the Aemeath service (another program may be using it).\nClose the program occupying the port, or change PORT in app/main.js and retry.',
        ),
      ),
    ));
  } else {
    // C24：等待超时/依赖缺失——错误页而非白屏
    createWindow('data:text/html;charset=utf-8,' + encodeURIComponent(
      errorPageHtml(
        uiText(
          depsOk ? 'Aemeath 服务启动超时' : '依赖安装失败',
          depsOk ? 'Aemeath service startup timed out' : 'Dependency installation failed',
        ),
        uiText(
          depsOk
            ? 'dsh 服务未在 60 秒内就绪。请查看控制台日志；确认已执行 npm install 与 pip install -r requirements.txt。'
            : 'npm ci 未能补齐运行依赖，请手动在项目目录执行 npm install 后重试。',
          depsOk
            ? 'The dsh service was not ready within 60 seconds. Check the console logs; make sure you ran npm install and pip install -r requirements.txt.'
            : 'npm ci could not install the runtime dependencies. Run npm install in the project directory and retry.',
        ),
      ),
    ));
  }

  app.on('activate', () => {
    // 同样优先用认证 URL（cookie 已换取，但带 token 的地址依然有效）
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(authenticatedUrl ?? APP_ORIGIN + '/');
    }
  });
});

app.on('window-all-closed', () => {
  isQuitting = true;
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopDsh();
});

// 注：不注册 process.on('exit') 的 stopDsh——exit 处理器里 spawnSync(taskkill)
// 属于同步阻塞式清理，可能挂住进程退出；正常退出路径（window-all-closed →
// before-quit）已覆盖 stopDsh。异常崩溃时 dsh 子进程可能残留，由用户手动清理。
