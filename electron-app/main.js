// ============================================================
// main.js - Electron 主进程
// 负责：窗口管理、系统托盘、全局快捷键、开机自启、
//       自动启动/停止 Python 服务
// ============================================================

const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;
let tray = null;
let pythonProcess = null;
let isQuitting = false;
let ttsProcess = null;
let visionProcess = null;
let controlProcess = null;

// ===== 读取 Electron 的配置文件 =====
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { dify_api_base: 'http://localhost/v1', modes: {} };
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ===== 获取图标路径 =====
function getIconPath() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) {
    return iconPath;
  }
  return iconPath;
}
// ===== 检查 tsx 是否安装 =====
function isTsxAvailable() {
  const tsxPath = path.join(__dirname, 'node_modules', '.bin', 'tsx');
  const tsxCmd = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const fullPath = path.join(__dirname, 'node_modules', '.bin', tsxCmd);
  return fs.existsSync(fullPath);
}
// ===== 启动 Python 本地服务 =====
function startPythonService() {
  const pythonScript = path.join(__dirname, 'run_server.py');
  
  // 检查 Python 脚本是否存在
  if (!fs.existsSync(pythonScript)) {
    console.warn('Python 服务脚本不存在，跳过启动:', pythonScript);
    return;
  }

  // 检查 Python 服务的配置文件是否存在
  const pyConfigPath = path.join(__dirname, 'py_config.json');
  if (!fs.existsSync(pyConfigPath)) {
    console.warn('Python 配置文件 py_config.json 不存在，跳过启动');
    return;
  }

  // Windows 上用 python，其他系统用 python3
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  try {
    pythonProcess = spawn(pythonCmd, [pythonScript], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true       // 不显示黑窗口
    });

    pythonProcess.stdout.on('data', (data) => {
      console.log('[Python服务]', data.toString().trim());
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error('[Python服务]', data.toString().trim());
    });

    pythonProcess.on('error', (err) => {
      console.error('Python 服务启动失败:', err.message);
      pythonProcess = null;
    });

    pythonProcess.on('close', (code) => {
      console.log(`Python 服务已退出 (退出码: ${code})`);
      pythonProcess = null;
    });

    console.log('✅ Python 本地服务已启动');
  } catch (err) {
    console.error('无法启动 Python 服务:', err.message);
    pythonProcess = null;
  }
}

// start pyautogui control service
function startControlService() {
  const script = path.join(__dirname, 'control_server.py');
  if (!fs.existsSync(script)) { console.warn('control_server.py 不存在'); return; }
  const pythonCmd = 'python';
  try {
    controlProcess = spawn(pythonCmd, [script], {
      cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    controlProcess.stdout.on('data', (d) => console.log('[控制服务]', d.toString().trim()));
    controlProcess.stderr.on('data', (d) => console.log('[控制服务]', d.toString().trim()));
    controlProcess.on('error', (e) => console.error('控制服务启动失败:', e.message));
    controlProcess.on('close', (c) => { controlProcess = null; console.log('控制服务退出:', c); });
    console.log('键盘鼠标控制服务已启动 (端口 18890)');
  } catch (err) { console.error('无法启动控制服务:', err.message); }
}

// ===== 启动 TTS 语音服务 =====
function startTTSService() {
  // 读取配置（直接用 loadConfig()，不用 const 声明）
  const ttsModelPath = loadConfig().tts_model_path || '';
  
  if (!ttsModelPath) {
    console.log('TTS 模型路径未配置，跳过语音服务启动。');
    console.log('如需语音功能，请在 config.json 中设置 tts_model_path');
    return;
  }

  const ttsScript = path.join(ttsModelPath, 'tts_server.py');
  
  if (!fs.existsSync(ttsScript)) {
    console.warn('TTS 服务脚本不存在，跳过启动:', ttsScript);
    return;
  }

  // 用 uv run 启动，确保能找到虚拟环境里的 torch
  const pythonCmd = 'uv';

  try {
    ttsProcess = spawn(pythonCmd, ['run', ttsScript, '--fp16'], {
      cwd: ttsModelPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    ttsProcess.stdout.on('data', (data) => {
      console.log('[TTS服务]', data.toString().trim());
    });

    ttsProcess.stderr.on('data', (data) => {
      console.log('[TTS服务]', data.toString().trim());
    });

    ttsProcess.on('error', (err) => {
      console.error('TTS 服务启动失败:', err.message);
    });

    ttsProcess.on('close', (code) => {
      console.log(`TTS 服务已退出 (退出码: ${code})`);
      ttsProcess = null;
    });

    console.log('TTS 语音服务已启动 (端口 18900, FP16)');
    console.log('  模型路径:', ttsModelPath);
    
  } catch (err) {
    console.error('无法启动 TTS 服务:', err.message);
  }
}

// ===== 启动视觉识别服务（YOLO） =====
function startVisionService() {
  const visionScript = path.join(__dirname, 'vision_server.py');
  
  if (!fs.existsSync(visionScript)) {
    console.warn('视觉服务脚本不存在，跳过启动:', visionScript);
    return;
  }

  const pythonCmd = 'python';

  try {
    visionProcess = spawn(pythonCmd, [visionScript], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    visionProcess.stdout.on('data', (data) => {
      console.log('[视觉服务]', data.toString().trim());
    });

    visionProcess.stderr.on('data', (data) => {
      console.log('[视觉服务]', data.toString().trim());
    });

    visionProcess.on('error', (err) => {
      console.error('视觉服务启动失败:', err.message);
    });

    visionProcess.on('close', (code) => {
      console.log(`视觉服务已退出 (退出码: ${code})`);
      visionProcess = null;
    });

    console.log('视觉识别服务已启动 (端口 18901)');
    
  } catch (err) {
    console.error('无法启动视觉服务:', err.message);
  }
}

// ===== 启动 TypeScript MCP 文件系统服务 (使用 @iflow-mcp/filesystem-mcp-server) =====
// ===== 启动公版 TypeScript MCP 文件系统服务（直接运行入口） =====
function startMCPService() {
  const tsScript = path.join(__dirname, 'mcp-server.ts');
  if (!fs.existsSync(tsScript)) {
    console.warn('TypeScript 服务脚本不存在:', tsScript);
    return;
  }

  // 检查 tsx 是否可用
  const tsxPath = path.join(__dirname, 'node_modules', '.bin', 'tsx.cmd');
  if (!fs.existsSync(tsxPath)) {
    console.warn('tsx 未安装，请先运行 npm install');
    return;
  }

  // ----- 强制释放 18889 端口 -----
  try {
    const { execSync } = require('child_process');
    // 查找占用 18889 端口的进程
    const stdout = execSync(`netstat -ano | findstr :18889`, { encoding: 'utf8' });
    const lines = stdout.split('\n').filter(line => line.includes('LISTENING'));
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid) {
        console.log(`[MCP] 终止占用端口 18889 的进程 PID: ${pid}`);
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      }
    }
  } catch (err) {
    // 没有找到进程或执行出错，忽略
    console.log('[MCP] 端口 18889 未被占用或释放失败');
  }

  // 等待端口释放
  console.log('[MCP] 等待端口释放...');
  setTimeout(() => {
    console.log('[MCP] 继续启动...');
  }, 500);

  // 启动命令：npx tsx mcp-server.ts
  const command = 'npx';
  const args = ['tsx', tsScript];

  try {
    const mcpProcess = spawn(command, args, {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true
    });

    mcpProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log('[MCP Custom]', msg);
    });

    mcpProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error('[MCP Custom]', msg);
    });

    mcpProcess.on('error', (err) => {
      console.error('自定义 MCP 服务启动失败:', err.message);
    });

    mcpProcess.on('close', (code) => {
      console.log(`自定义 MCP 服务已退出 (退出码: ${code})`);
      app.mcpProcess = null;
    });

    console.log('✅ 自定义 TypeScript MCP 文件系统服务已启动');
    app.mcpProcess = mcpProcess;
  } catch (err) {
    console.error('无法启动自定义 MCP 服务:', err.message);
  }
}

// ===== 停止 Python 服务 =====
function stopPythonService() {
  if (pythonProcess) {
    console.log('正在停止 Python 服务...');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', pythonProcess.pid.toString(), '/f', '/t']);
    } else {
      pythonProcess.kill('SIGTERM');
    }
    pythonProcess = null;
  }
}

// ===== 创建系统托盘 =====
function createTray() {
  const iconPath = getIconPath();
  
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    console.warn('托盘图标加载失败:', e.message);
    return;
  }
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '隐藏窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.hide();
        }
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
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// ===== 注册全局快捷键 =====
function registerShortcuts() {
  const ret = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (mainWindow) {
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
  
  if (!ret) {
    console.warn('全局快捷键注册失败');
  }
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

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ===== IPC：获取配置 =====
ipcMain.handle('get-config', async () => {
  return loadConfig();
});

// ===== 应用就绪 =====
app.whenReady().then(() => {
  // 先启动 Python 本地服务
  startPythonService();
  // 启动yolo服务
  startVisionService();
  // 再启动 MCP 文件系统服务
  startMCPService();
  // 启动键盘鼠标控制服务
  startControlService();
  // 再创建窗口和托盘
  createWindow();
  createTray();
  registerShortcuts();
  // start tts server
  startTTSService();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

// ===== 窗口全关时（不退出，托盘还在） =====
app.on('window-all-closed', () => {
  // 不做任何操作，保持托盘运行
});

const { spawnSync } = require('child_process'); // 换成同步引入

// ===== 退出前清理 =====
app.on('will-quit', (event) => {
  globalShortcut.unregisterAll();

  // 杀掉yolo视觉识别
  if (visionProcess) {
  spawn('taskkill', ['/pid', visionProcess.pid.toString(), '/f', '/t']);
  visionProcess = null;
  }

  // 1. 杀掉 MCP 进程 (同步强制)
  if (app.mcpProcess && app.mcpProcess.pid) {
    try {
      spawnSync('taskkill', ['/pid', app.mcpProcess.pid.toString(), '/f', '/t'], {
        stdio: 'ignore', // 静默执行，不输出乱码
        windowsHide: true,
      });
      console.log(`[Cleanup] Killed MCP PID: ${app.mcpProcess.pid}`);
    } catch (e) {}
    app.mcpProcess = null;
  }

  // 2. 杀掉 TTS 进程 (同步强制)
  if (ttsProcess && ttsProcess.pid) {
    try {
      spawnSync('taskkill', ['/pid', ttsProcess.pid.toString(), '/f', '/t'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      console.log(`[Cleanup] Killed TTS PID: ${ttsProcess.pid}`);
    } catch (e) {}
    ttsProcess = null;
  }
  // kill pyautogui service
  if (controlProcess) { spawn('taskkill', ['/pid', controlProcess.pid.toString(), '/f', '/t']); controlProcess = null; }

  // 3. 【严重警告】绝对不要写 spawnSync('taskkill', ['/f', '/im', 'python.exe']);
  // 那会让你的电脑鸡飞狗跳。只管理自己的 PID 即可。
  
  // 如果实在不放心，可以加一道 500ms 的微小延迟，确保系统回收句柄
  // 但 spawnSync 已经够用了。
});

// ===== 开机自启 =====
app.setLoginItemSettings({
  openAtLogin: true,
});