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
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
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
 *   'foreign'  端口开放但被非 dsh 进程占用
 *   'timeout'  超时未就绪
 */
async function waitForService(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) {
      if (await isDshService(port)) return 'ready';
      return 'foreign';
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'timeout';
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
async function startDsh() {
  // 若 3081 已有 dsh 实例（用户自己起的），直接复用
  if (await portOpen(PORT)) {
    if (await isDshService(PORT)) {
      console.log('[shell] 复用已有 dsh 服务（3081）');
      return 'ready';
    }
    console.error('[shell] 3081 被非 dsh 进程占用，不再启动本服务');
    return 'foreign';
  }
  console.log('[shell] 启动 dsh 服务（3081）…');
  const args = ['-ExecutionPolicy', 'Bypass', '-File', DSH_SCRIPT, '--profile', 'aemeath', '--port', String(PORT)];
  dshProc = spawn('powershell', args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  dshProc.stdout.on('data', (d) => {
    const msg = String(d).trim();
    if (msg) console.log('[dsh]', msg);
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
function errorPageHtml(title, detail) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
  <body style="background:#141821;color:#e8ecf4;font-family:Segoe UI,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center;max-width:520px">
    <h2 style="margin:0 0 12px">${esc(title)}</h2>
    <p style="color:#aab4c8;font-size:13px;line-height:1.6">${esc(detail)}</p>
    <button onclick="location.reload()" style="margin-top:16px;padding:8px 20px;border:none;border-radius:8px;background:#5b8def;color:#fff;cursor:pointer;font-size:13px">重试</button>
  </div></body></html>`;
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

  // C24：导航守卫——只允许本地 3081 源（防被重定向到任意页面）
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) e.preventDefault();
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

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadURL(loadUrl);
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

// ===== 生命周期 =====
app.whenReady().then(async () => {
  const depsOk = await ensureDshCli();
  const serviceState = depsOk ? await startDsh() : 'unavailable';
  if (serviceState === 'ready') {
    createWindow(APP_ORIGIN + '/');
  } else if (serviceState === 'foreign') {
    // C24：端口被非 dsh 进程占用——不加载外来内容，显示错误页
    createWindow('data:text/html;charset=utf-8,' + encodeURIComponent(
      errorPageHtml('端口 3081 被其他程序占用',
        '检测到 3081 端口上运行的不是 Aemeath 服务（可能是其他程序）。\n请先关闭占用该端口的程序，或修改 app/main.js 的 PORT 后重试。'),
    ));
  } else {
    // C24：等待超时/依赖缺失——错误页而非白屏
    createWindow('data:text/html;charset=utf-8,' + encodeURIComponent(
      errorPageHtml(depsOk ? 'Aemeath 服务启动超时' : '依赖安装失败',
        depsOk
          ? 'dsh 服务未在 60 秒内就绪。请查看控制台日志；确认已执行 npm install 与 pip install -r requirements.txt。'
          : 'npm ci 未能补齐运行依赖，请手动在项目目录执行 npm install 后重试。'),
    ));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(APP_ORIGIN + '/');
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

// 兜底：进程异常退出也停 dsh
process.on('exit', () => stopDsh());
