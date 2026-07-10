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

// ===== 创建加载窗口（显示启动进度） =====
let loadingWindow = null;

function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 440,
    height: 360,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 把服务列表序列化到 HTML 中
  const servicesJSON = JSON.stringify(ALL_SERVICES);

  const loadingHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      display: flex; justify-content: center;
      min-height: 100vh;
      background: rgba(15, 15, 30, 0.95);
      font-family: 'Segoe UI', Arial, sans-serif;
      border-radius: 16px;
      overflow: hidden;
    }
    .container {
      width: 100%;
      padding: 28px 30px 22px;
      text-align: center;
      color: #e0e0ff;
    }
    .title {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 2px;
      background: linear-gradient(135deg, #a78bfa, #60a5fa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      font-size: 12px;
      color: #8888bb;
      margin-bottom: 18px;
    }
    .spinner {
      display: inline-block;
      width: 28px; height: 28px;
      border: 3px solid #2a2a4a;
      border-top-color: #a78bfa;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 14px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .service-list {
      text-align: left;
      font-size: 13px;
      margin-top: 4px;
    }
    .service-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 10px;
      border-radius: 6px;
      margin-bottom: 2px;
      background: rgba(255,255,255,0.03);
    }
    .service-name {
      color: #c0c0e0;
    }
    .service-status {
      font-size: 12px;
      min-width: 60px;
      text-align: right;
    }
    .status-waiting { color: #555577; }
    .status-loading { color: #fbbf24; }
    .status-ready   { color: #34d399; }
    .status-failed  { color: #f87171; }
    .status-checking { color: #60a5fa; }
    .footer-status {
      margin-top: 12px;
      font-size: 11px;
      color: #6666aa;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="title">✦ Aemeath ✦</div>
    <div class="subtitle">Awaking...</div>
    <div class="spinner"></div>
    <div class="service-list" id="serviceList"></div>
    <div class="footer-status" id="footerStatus">Initializing...</div>
  </div>
  <script>
    // 可选服务标记
    const SERVICES = ${servicesJSON};

    // 状态映射
    const STATUS = {};
    SERVICES.forEach(s => { STATUS[s.name] = 'waiting'; });

    const listEl = document.getElementById('serviceList');
    const footerEl = document.getElementById('footerStatus');

    function renderList() {
      let html = '';
      let readyCount = 0;
      let totalCount = SERVICES.length;

      SERVICES.forEach(s => {
        const st = STATUS[s.name] || 'waiting';
        let statusText = '';
        let statusClass = '';

        switch(st) {
          case 'waiting':  statusText = '⏳ waiting'; statusClass = 'status-waiting'; break;
          case 'checking': statusText = '🔄 checking'; statusClass = 'status-checking'; break;
          case 'ready':    statusText = '✅ ready'; statusClass = 'status-ready'; readyCount++; break;
          case 'failed':   statusText = '❌ failed'; statusClass = 'status-failed'; break;
        }

        html += '<div class="service-item">'
             +   '<span class="service-name">' + s.name + '</span>'
             +   '<span class="service-status ' + statusClass + '">' + statusText + '</span>'
             + '</div>';
      });

      listEl.innerHTML = html;

      if (readyCount === totalCount) {
        footerEl.textContent = 'All services ready! Launching...';
      } else {
        footerEl.textContent = readyCount + '/' + totalCount + ' services ready';
      }
    }

    // 检查单个服务
    async function checkOne(service) {
      // MCP 不走浏览器 fetch（fastmcp 的 CORS 有问题），由主进程检查
      if (service.name === 'MCP filesystem') {
        STATUS[service.name] = 'checking';
        renderList();
        return;
      }
      
      STATUS[service.name] = 'checking';
      renderList();

      try {
        const resp = await fetch('http://' + service.host + ':' + service.port + service.path, {
          method: 'GET',
          signal: AbortSignal.timeout(3000)
        });
        STATUS[service.name] = 'ready';
      } catch (e) {
        STATUS[service.name] = 'failed';
      }
      renderList();
    }


    // 主循环：每 1.5 秒检查一次所有未就绪的服务
    async function checkLoop() {
      while (true) {
        const allReady = SERVICES.every(s => STATUS[s.name] === 'ready');
        if (allReady) {
          renderList();
          break;
        }

        // 找出未就绪的，同时检查（并发）
        const pending = SERVICES.filter(s => STATUS[s.name] !== 'ready');
        await Promise.all(pending.map(s => checkOne(s)));

        // 等 1.5 秒再试
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // 启动
    renderList();
    checkLoop();
  </script>
</body>
</html>`;

  loadingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHTML)}`);
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
    title: 'Aemeath',
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
app.whenReady().then(async () => {
  // 先启动必需服务
  startPythonService();     // 端口 18888
  startAIService();         // 端口 18892
  startControlService();    // 端口 18890
  startMCPService();        // 端口 18889

  // 视觉和 TTS 延迟 3 秒启动（给内存和 CPU 喘息空间）
  setTimeout(() => startVisionService(), 3000);  // 端口 18901
  setTimeout(() => startTTSService(), 5000);     // 端口 18900

  // 创建加载窗口
  createLoadingWindow();

  // 等待所有服务就绪（最多等 30 秒）
  const allReady = await waitForAllServices(30, 1000);

  // 关闭加载窗口
  if (loadingWindow) {
    loadingWindow.close();
    loadingWindow = null;
  }

  // 创建主窗口
  createWindow();
  createTray();
  registerShortcuts();

  // 通知渲染进程启动状态
  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('services-ready', allReady);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

// ===== 服务健康检查 =====
const net = require('net');

// REQUIRED 服务：必须就绪才能显示界面
const REQUIRED_SERVICES = [
  { name: 'AI chatbot',          host: '127.0.0.1', port: 18892, path: '/health' },
  { name: 'command execute',     host: '127.0.0.1', port: 18888, path: '/health' },
  { name: 'keyboard and mouse',  host: '127.0.0.1', port: 18890, path: '/health' },
  { name: 'visual services',     host: '127.0.0.1', port: 18901, path: '/health' },
  { name: 'MCP filesystem',      host: '127.0.0.1', port: 18889, path: '/mcp' },
];

// OPTIONAL 服务：不阻塞界面，但会显示在加载列表中
const OPTIONAL_SERVICES = [
  { name: 'TTS voice services',  host: '127.0.0.1', port: 18900, path: '/health' },
];

// 合并所有服务（用于传给加载窗口）
const ALL_SERVICES = [...REQUIRED_SERVICES, ...OPTIONAL_SERVICES];

// 检查单个服务是否就绪（TCP 端口检测，只验证端口是否在监听）
function checkService(service) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);  // 3秒超时
    
    sock.on('connect', () => {
      sock.destroy();
      resolve(true);
    });
    
    sock.on('error', () => {
      sock.destroy();
      resolve(false);
    });
    
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    
    sock.connect(service.port, service.host);
  });
}



// 等待所有必需服务就绪
async function waitForAllServices(maxRetries = 40, interval = 1000) {
  console.log('waiting for services...');
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const results = await Promise.all(REQUIRED_SERVICES.map(checkService));
    const allReady = results.every(r => r === true);
    const readyCount = results.filter(r => r === true).length;
    
    console.log(`  检查第 ${attempt}/${maxRetries} 次: ${readyCount}/${REQUIRED_SERVICES.length} 个必需服务就绪`);
    
    if (allReady) {
      console.log('All services ready!');
      return true;
    }
    
    await new Promise(r => setTimeout(r, interval));
  }
  
  // 超时了，打印哪些服务没起来
  console.warn('Some necessary services failed to load：');
  for (let i = 0; i < REQUIRED_SERVICES.length; i++) {
    const ready = await checkService(REQUIRED_SERVICES[i]);
    if (!ready) {
      console.warn(`  ❌ ${REQUIRED_SERVICES[i].name} (端口 ${REQUIRED_SERVICES[i].port})`);
    }
  }
  return false;
}


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
