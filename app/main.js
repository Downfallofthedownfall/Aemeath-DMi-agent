// ============================================================
// main.js — Electron 主进程（M5 桌宠壳 v1）
// 职责：
//   1. 托管 dsh 进程：启动 `scripts/dsh.ps1 --profile aemeath --port 3081`
//      （或复用已在 3081 运行的实例），退出时停止。
//   2. 无边框品牌窗口：自绘标题栏（品牌位 + 窗口控制），加载本地 3081
//      （同源 fetch/WS 天然可用，__DSH_BOOT__ 由 host 注入）。
//   3. IPC 桥：窗口控制（最小化/最大化/关闭）、服务状态、外链。
// 形态说明：官方 file:// + fetch IPC 桥需要静态化 __DSH_BOOT__（host 运行时
//   注入）且 WebApiClient.doFetch 硬编码 globalThis.fetch；v1 采用「托管 +
//   本地 3081 加载」——功能等价、无需重写传输层，留 file:// 桥为后续增强。
// ============================================================
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const net = require('net');

const PORT = 3081;
const HOST = '127.0.0.1';
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_SCRIPT = path.join(REPO_ROOT, 'scripts', 'dsh.ps1');

let mainWindow = null;
let dshProc = null;
let isQuitting = false;

// ===== 服务探测 =====
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1200, () => { socket.destroy(); resolve(false); });
  });
}

async function waitForService(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ===== dsh 进程托管 =====
function startDsh() {
  // 若 3081 已有服务（用户自己起的），直接复用
  return new Promise((resolve) => {
    portOpen(PORT).then((open) => {
      if (open) {
        console.log('[shell] 复用已有 dsh 服务（3081）');
        resolve();
        return;
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
      // 等待就绪
      waitForService(PORT, 60000).then((ok) => {
        if (!ok) console.error('[shell] 等待 dsh 服务超时');
        resolve();
      });
    });
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

// ===== 窗口 =====
function createWindow() {
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 外链与下载走系统默认
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadURL(`http://${HOST}:${PORT}/`);
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
  url: `http://${HOST}:${PORT}/`,
  version: '2.0.0-m0',
}));

// ===== 生命周期 =====
app.whenReady().then(async () => {
  await startDsh();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
