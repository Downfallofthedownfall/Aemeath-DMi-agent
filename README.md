# 🤖 爱弥斯桌面助手 / Aemeath Desktop Agent

> 🇨🇳 基于 Electron + DeepSeek 的桌面 AI 助手，支持双模态切换、语音交互、视觉识别、键盘鼠标控制、文件系统操作  
> 🇬🇧 A desktop AI assistant powered by Electron + DeepSeek, featuring dual-mode switching, voice interaction, visual recognition, keyboard/mouse control, and file system operations.

---

## ✨ 功能一览 / Features

### 🧠 AI 核心 / Core AI

| 🇨🇳 功能 | 🇬🇧 Feature | 状态 |
|---------|------------|:----:|
| DeepSeek 对话（流式） | DeepSeek Chat (Streaming) | ✅ |
| 双模态切换（爱弥斯桌宠/星炬学霸） | Dual-mode Switching | ✅ |
| 共享记忆（localStorage） | Shared Memory (localStorage) | ✅ |
| OOC 角色一致性检测 | OOC Character Consistency Check | ✅ |
| 工具自动调用（Function Calling） | Tool Calling (Function Calling) | ✅ |

### 🔧 工具系统 / Tool System

| 🇨🇳 功能 | 🇬🇧 Feature | 端口 |
|---------|------------|:---:|
| 本地命令执行 | Local Command Execution | `18888` |
| 键盘鼠标控制 | Keyboard & Mouse Control | `18890` |
| MCP 文件系统 | File System (MCP) | `18889` |
| YOLO 目标检测 | YOLO Object Detection | `18901` |
| OCR 文字识别 | OCR Text Recognition | `18901` |
| 屏幕场景描述 | Screen Description | `18901` |
| 网页爬虫 | Web Scraper | 内置 |
| 数学计算 | Math Calculation | 内置 |
| Python 代码解释器 | Python Code Interpreter | 内置 |
| arXiv 论文搜索 | arXiv Paper Search | 内置 |

### 🎙️ 语音系统 / Voice System

| 🇨🇳 功能 | 🇬🇧 Feature | 状态 |
|---------|------------|:----:|
| TTS 语音播报（IndexTTS2） | TTS (IndexTTS2) | ✅ |
| 语音输入（Web Speech API） | Voice Input (Web Speech API) | ✅ |
| 自训练音色模型 | Custom Voice Model | 🔄 待训练 |

### 🖥️ 桌面体验 / Desktop Experience

| 🇨🇳 功能 | 🇬🇧 Feature | 状态 |
|---------|------------|:----:|
| 深色科技风 UI | Dark Tech UI | ✅ |
| 系统托盘 | System Tray | ✅ |
| 全局快捷键 (Ctrl+Shift+Space) | Global Shortcut | ✅ |
| KaTeX 公式渲染 | KaTeX Formula Rendering | ✅ |
| 对话历史管理 | Chat History Management | ✅ |
| 开机自启 | Auto-start on Boot | ✅ |

---

## 🚀 快速开始 / Quick Start

### 📋 前提条件 / Prerequisites

| 软件 | Software | 版本 | 下载 |
|:----|:---------|:----|:----|
| Node.js | Node.js | 20+ | <https://nodejs.org> |
| Python | Python | 3.10+ | <https://python.org> |

### 🔑 获取 API Key

| Key | 用途 | 获取地址 |
|:----|:-----|:---------|
| DeepSeek API Key | 对话模型 | <https://platform.deepseek.com/api_keys> |

### 📥 安装 / Installation

```bash
# 克隆项目 / Clone the project
git clone https://github.com/Downfallofthedownfall/Aemeath-DMi-agent
cd Aemeath-DMi-agent

# Windows 一键部署 / One-click setup (Windows)
setup.bat

# 或者手动安装 / Or manual install:
pip install -r requirements.txt
cd electron-app
npm install
cd ..

```

---

## ⚙️ 配置 / Configuration

编辑 `electron-app/config.json`，填入你的 API Key：

```json
{
    "deepseek_api_key": "sk-你的DeepSeekAPIKey",
    "deepseek_api_base": "https://api.deepseek.com",
    "tts_model_path": "F:\\index-tts",
    "modes": {
        "aemeath": {
            "name": "爱弥斯桌宠",
            "system_prompt": "你是爱弥斯..."
        },
        "physicist": {
            "name": "星炬物理学霸",
            "system_prompt": "你是星炬学院..."
        }
    }
}

```

---

## 🚀 启动 / Launch

```bash
cd electron-app
npm start

```

---

## 📁 项目结构 / Project Structure

```
Aemeath-Desktop-Agent/
├── electron-app/                  # Electron 桌面应用
│   ├── main.js                    # 主进程（窗口、托盘、快捷键、服务管理）
│   ├── preload.js                 # 桥接文件
│   ├── config.json                # 配置（API Key 等，不上传 Git）
│   ├── package.json               # 打包配置
│   ├── ai_service.py              # ✅ AI 对话服务（替代 Dify）
│   ├── run_server.py              # 命令执行服务（端口 18888）
│   ├── control_server.py          # 键盘鼠标控制服务（端口 18890）
│   ├── vision_server.py           # 视觉识别服务（端口 18901）
│   ├── mcp-server.ts              # MCP 文件系统服务（端口 18889）
│   ├── py_config.json             # 命令白名单配置
│   ├── renderer/                  # 前端界面
│   │   ├── index.html
│   │   ├── style.css
│   │   └── app.js
│   └── assets/                    # 图标资源
├── setup.bat                      # 一键部署脚本
├── requirements.txt               # Python 依赖
└── README.md                      # 本文件

```

---

## 🛠️ 技术栈 / Tech Stack

| 技术 | Technology | 用途 |
|:----|:-----------|:----|
| Electron 28 | Electron 28 | 桌面应用框架 |
| DeepSeek V4 Flash | DeepSeek V4 Flash | 对话模型（Function Calling） |
| Python HTTP Server | Python HTTP Server | 后端微服务 |
| IndexTTS2 | IndexTTS2 | 语音合成 |
| YOLOv8 | YOLOv8 | 目标检测 |
| EasyOCR | EasyOCR | 文字识别 |
| pyautogui | pyautogui | 键盘鼠标控制 |
| KaTeX | KaTeX | 公式渲染 |
| FastMCP | FastMCP | MCP 文件系统协议 |

---

## 🔧 服务端口一览 / Service Ports

| 服务 | Service | 端口 |
|:----|:--------|:---:|
| 命令执行 | Command Execution | `18888` |
| MCP 文件系统 | MCP File System | `18889` |
| 键盘鼠标控制 | Keyboard & Mouse Control | `18890` |
| AI 对话 | AI Chat | `18892` |
| TTS 语音 | TTS Voice | `18900` |
| 视觉识别 | Visual Recognition | `18901` |

---

## 📦 打包 / Packaging

```bash
cd electron-app
npm run pack

```

---

## 📁 附：一键部署脚本 / `setup.bat`

```bat
@echo off
chcp 65001 >nul
echo ============================================
echo   爱弥斯桌面助手 - 一键部署
echo   Aemeath Desktop Agent - One-Click Setup
echo ============================================
echo.

echo [1/4] ⏳ 检查 Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ 请先安装 Node.js: https://nodejs.org
    pause
    exit /b 1
)
echo ✅ Node.js 已安装

echo [2/4] ⏳ 检查 Python...
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ 请安装 Python 3.10+: https://python.org
    pause
    exit /b 1
)
echo ✅ Python 已安装

echo [3/4] ⏳ 安装 Python 依赖...
pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo ❌ Python 依赖安装失败
    pause
    exit /b 1
)
echo ✅ Python 依赖安装完成

echo [4/4] ⏳ 安装 Node.js 依赖...
cd electron-app
npm install
if %errorlevel% neq 0 (
    echo ❌ Node.js 依赖安装失败
    pause
    exit /b 1
)
echo ✅ Node.js 依赖安装完成

echo.
echo ============================================
echo   ✅ 部署完成！
echo   Setup complete!
echo.
echo   启动命令 / Launch command:
echo   cd electron-app ^&^& npm start
echo ============================================
pause

```

---

## 📄 许可证 / License

MIT License

---

> 🇨🇳 项目还在持续开发中，欢迎提出 Issue 和 PR！  
> 🇬🇧 This project is under active development. Issues and PRs are welcome!