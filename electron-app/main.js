// ============================================================
// main.js - Electron 主进程
// 负责：窗口管理、系统托盘、全局快捷键、开机自启、
//       自动启动/停止 Python 服务
// ============================================================

const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync, execSync } = require('child_process');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// 所有子进程管理
const childProcesses = {};

// ===== 读取 Electron 的配置文件 =====
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { modes: {} };
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ===== 获取图标路径 =====
function getIconPath() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  return fs.existsSync(iconPath) ? iconPath : iconPath;
}

// ===== 通用子进程启动器 =====
function startProcess(name, command, args, options = {}) {
  try {
    const proc = spawn(command, args, {
      cwd: options.cwd || __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: options.shell || false,
      env: options.env || undefined,
    });

    const prefix = `[${name}]`;
    proc.stdout.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log(prefix, msg);
    });
    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log(prefix, msg);
    });
    proc.on('error', (err) => console.error(`${prefix} 启动失败:`, err.message));
    proc.on('close', (code) => {
      console.log(`${prefix} 已退出 (${code})`);
      if (childProcesses[name] === proc) childProcesses[name] = null;
    });

    childProcesses[name] = proc;
    console.log(`${prefix} 已启动`);
    return proc;
  } catch (err) {
    console.error(`无法启动 ${name}:`, err.message);
    return null;
  }
}

// ===== 强制杀掉子进程（同步） =====
function killProcess(name) {
  const proc = childProcesses[name];
  if (!proc || !proc.pid) return;
  try {
    spawnSync('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    console.log(`[Cleanup] 已杀掉 ${name} (PID: ${proc.pid})`);
  } catch (e) {
    console.warn(`[Cleanup] 杀掉 ${name} 失败:`, e.message);
  }
  childProcesses[name] = null;
}

// ===== 启动 Python 本地服务 (run_server.py) =====
function startPythonService() {
  const script = path.join(__dirname, 'run_server.py');
  if (!fs.existsSync(script)) { console.warn('run_server.py 不存在'); return; }
  const pyConfig = path.join(__dirname, 'py_config.json');
  if (!fs.existsSync(pyConfig)) { console.warn('py_config.json 不存在，跳过'); return; }
  startProcess('run_server', 'python', [script]);
}

// ===== 启动 AI 对话服务 (ai_service.py) =====
function startAIService() {
  const script = path.join(__dirname, 'ai_service.py');
  if (!fs.existsSync(script)) { console.warn('ai_service.py 不存在'); return; }
  startProcess('ai_service', 'python', [script]);
}

// ===== 启动键盘鼠标控制服务 (control_server.py) =====
function startControlService() {
  const script = path.join(__dirname, 'control_server.py');
  if (!fs.existsSync(script)) { console.warn('control_server.py 不存在'); return; }
  startProcess('control_server', 'python', [script]);
}

// ===== 启动视觉识别服务 (vision_server.py) =====
function startVisionService() {
  const script = path.join(__dirname, 'vision_server.py');
  if (!fs.existsSync(script)) { console.warn('vision_server.py 不存在'); return; }
  startProcess('vision_server', 'python', [script]);
}

// ===== 启动 TTS 语音服务 (tts_server.py) =====
function startTTSService() {
  const ttsModelPath = loadConfig().tts_model_path || '';
  if (!ttsModelPath) {
    console.log('TTS 模型路径未配置，跳过语音服务。');
    return;
  }
  const script = path.join(ttsModelPath, 'tts_server.py');
  if (!fs.existsSync(script)) { console.warn('TTS 服务脚本不存在:', script); return; }
  startProcess('tts_server', 'uv', ['run', script, '--fp16'], {
    cwd: ttsModelPath,
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });
}

// ===== 启动 MCP 文件系统服务 (mcp-server.ts) =====
function startMCPService() {
  const script = path.join(__dirname, 'mcp-server.ts');
  if (!fs.existsSync(script)) { console.warn('mcp-server.ts 不存在'); return; }
  const tsxPath = path.join(__dirname, 'node_modules', '.bin', 'tsx.cmd');
  if (!fs.existsSync(tsxPath)) { console.warn('tsx 未安装，跳过 MCP'); return; }

  // 释放端口
  try {
    const out = execSync('netstat -ano | findstr :18889', { encoding: 'utf8' });
    const lines = out.split('\n').filter(l => l.includes('LISTENING'));
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid) { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); }
    }
  } catch (e) { /* 端口未被占用 */ }

  // 延迟启动，等端口释放
  setTimeout(() => {
    startProcess('mcp_server', 'npx', ['tsx', script], { shell: true });
  }, 800);
}

// ===== 创建系统托盘 =====
function createTray() {
  try {
    tray = new Tray(getIconPath());
  } catch (e) {
    console.warn('托盘图标加载失败:', e.message);
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          showAndFocusWindow();
        }
      }
    },
    {
      label: '隐藏窗口',
      click: () => {
        if (mainWindow) mainWindow.hide();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('我的桌面助手 - 爱弥斯');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        showAndFocusWindow();
      }
    }
  });
}

// ===== 显示并强制聚焦窗口 =====
function showAndFocusWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  // Electron 的 focus() 在某些 Windows 版本上不生效，用 setAlwaysOnTop 强制
  mainWindow.setAlwaysOnTop(true, 'normal');
  mainWindow.setAlwaysOnTop(false);
  mainWindow.moveTop();
  // 如果窗口最小化了，恢复
  if (mainWindow.isMinimized()) mainWindow.restore();
}

// ===== 注册全局快捷键 =====
function registerShortcuts() {
  const ret = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (mainWindow) {
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        showAndFocusWindow();
      }
    }
  });
  if (!ret) console.warn('全局快捷键注册失败');
}

// ===== 创建主窗口 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    title: '我的桌面助手 - 爱弥斯',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 窗口关闭时隐藏到托盘
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 创建后强制聚焦
  showAndFocusWindow();
}

// ===== IPC：获取配置 =====
ipcMain.handle('get-config', async () => {
  return loadConfig();
});

// ===== IPC：用系统浏览器打开外部链接 =====
ipcMain.handle('open-external-url', async (event, url) => {
  if (typeof url !== 'string') return false;
  // 只允许 http/https 协议
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  shell.openExternal(url);
  return true;
});

// ===== 应用就绪 =====
app.whenReady().then(() => {
  // 启动所有服务
  startPythonService();     // 端口 18888
  startAIService();         // 端口 18892
  startVisionService();     // 端口 18901
  startControlService();    // 端口 18890
  startMCPService();        // 端口 18889（延迟启动）
  startTTSService();        // 端口 18900

  // 创建窗口和托盘
  createWindow();
  createTray();
  registerShortcuts();

  // macOS 点击 Dock 图标时显示窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      showAndFocusWindow();
    }
  });
});

// ===== 窗口全关时（不退出，托盘还在） =====
app.on('window-all-closed', () => {
  // 不做任何操作，保持托盘运行
});

// ===== 退出前清理所有子进程 =====
app.on('will-quit', () => {
  globalShortcut.unregisterAll();

  console.log('[Cleanup] 正在清理所有子进程...');

  // 杀掉所有已记录的子进程
  const processNames = Object.keys(childProcesses);
  for (const name of processNames) {
    killProcess(name);
  }

  console.log('[Cleanup] 清理完成');
});

// ===== 开机自启 =====
app.setLoginItemSettings({
  openAtLogin: true,
});
