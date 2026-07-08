# 🤖 爱弥斯DMi助手 / Aemeath DMi Agent

> 🇨🇳 一个支持语音、视觉、RAG、工具调用、双模态切换的桌面 AI 助手  
> 🇬🇧 A desktop AI assistant with voice, vision, RAG, tool calling, and dual-mode switching.

![版本](https://img.shields.io/badge/版本-2.0.0-blue)
![Electron](https://img.shields.io/badge/Electron-28.0.0-47848F)
![DeepSeek](https://img.shields.io/badge/DeepSeek-Chat-4F46E5)
![Python](https://img.shields.io/badge/Python-3.10+-3776AB)

---

## ✨ 功能一览 / Features

### 🧠 AI 核心能力 / Core AI Capabilities

| 功能 / Feature | 状态 / Status | 说明 / Description |
|------|------|------|
| DeepSeek 对话 / DeepSeek Chat | ✅ | 双 Agent 独立运行 / Dual agents running independently |
| RAG 知识库 / RAG Knowledge Base | ✅ | 独立知识库 / Independent knowledge bases |
| 共享记忆 / Shared Memory | ✅ | 双模态共享用户信息 / Shared user info across modes |
| 深度思考 / Deep Thinking | ✅ | 保留思考，界面自动过滤 / Kept but filtered in UI |
| 双模态切换 / Dual-mode Switching | ✅ | 一键切换桌宠/学霸 / One-click: Pet ↔ Scholar |
| OOC 自动修正 / Auto OOC Correction | ✅ | 语义级角色一致性检测与自动修正 / Semantic role consistency check & auto-fix |

### 👁️ 视觉与识别 / Vision & Recognition

| 功能 / Feature | 技术栈 / Tech Stack | 说明 / Description |
|------|--------|------|
| 目标检测 / Object Detection | YOLOv8 | 实时检测屏幕中的人、物体 / Real-time detection of people & objects |
| OCR 文字识别 / OCR | EasyOCR | 从屏幕截图提取文字 / Extract text from screenshots |
| 场景描述 / Scene Description | 自定义 / Custom | 综合检测 + OCR 描述屏幕内容 / Combined detection + OCR description |
| 屏幕分析 / Screen Analysis | MSS + OpenCV | 快速截屏与区域分析 / Fast screenshot & region analysis |

### 🔧 工具与扩展 / Tools & Extensions

| 功能 / Feature | 协议 / Protocol | 说明 / Description |
|------|------|------|
| 联网搜索 / Web Search | Dify 内置 | 实时搜索网络信息 / Real-time web search |
| 天气查询 / Weather | Dify 内置 | 实时天气数据 / Real-time weather data |
| 数学计算 / Math | Dify 内置 | 公式计算与推导 / Formula calculation |
| 代码执行 / Code Interpreter | Dify 内置 | 执行 Python 代码 / Execute Python code |
| 文件系统 / File System | MCP (TypeScript) | 浏览、读写、搜索本地文件 / Browse, read, write local files |
| 本地命令 / Local Command | HTTP API | 打开软件、操作电脑 / Open apps, control PC |
| **键盘鼠标 / Keyboard & Mouse** | **HTTP API (PyAutoGUI)** | **模拟点击、输入、快捷键、窗口切换 / Simulate clicks, typing, hotkeys, window switching** |
| **视觉识别 / Vision** | **HTTP API (YOLOv8 + EasyOCR)** | **屏幕分析、文字提取、物体检测 / Screen analysis, OCR, object detection** |
| MCP 扩展 / MCP Extensions | Dify 市场 | 插件市场工具支持 / Marketplace tool support |
| 工作流技能 / Workflow Skills | Dify 工作流 | 自定义多步骤自动化 / Custom multi-step automation |

### 🎙️ 语音能力 / Voice Capabilities

| 功能 / Feature | 技术栈 / Tech Stack | 说明 / Description |
|------|--------|------|
| 语音输入 / Voice Input | Web Speech API | 麦克风录音转文字 / Mic recording to text |
| **自训练 TTS / Self-trained TTS** | **IndexTTS2** | **用自己的声音训练模型，实时合成语音 / Train with your own voice for real-time synthesis** |
| 情感控制 / Emotion Control | IndexTTS2 | 情感向量 + 文本情感引导 / Emotion vector + text emotion guidance |

### 🖥️ 桌面体验 / Desktop Experience

| 功能 / Feature | 状态 / Status | 说明 / Description |
|------|------|------|
| 深色科技风 UI / Dark Tech UI | ✅ | 紫色/蓝色主题 / Purple-blue theme |
| 流式显示 / Streaming Display | ✅ | AI 回复实时逐字出现 / Real-time character-by-character display |
| KaTeX 公式渲染 / KaTeX Rendering | ✅ | 数学公式美观显示 / Beautiful math formula display |
| 对话历史管理 / Chat History | ✅ | 新建、切换、删除 / New, switch, delete conversations |
| 系统托盘 / System Tray | ✅ | 关窗口不退出 / Minimize to tray |
| 全局快捷键 / Global Shortcut | ✅ | Ctrl+Shift+Space 唤出/隐藏 / Show/Hide |
| 开机自启 / Auto-start | ✅ | 电脑开机自动启动 / Auto-start on boot |

---

## 🛠️ 技术栈 / Tech Stack

| 技术 / Technology | 用途 / Purpose |
|------|------|
| **Electron 28** | 桌面应用框架 / Desktop app framework |
| **Dify 1.15** | AI 引擎 / AI engine (DeepSeek, RAG, tools, workflows) |
| **DeepSeek Chat** | LLM 模型 / LLM model |
| **IndexTTS2** | 自训练 TTS 语音合成 / Self-trained TTS |
| **KaTeX** | 公式渲染 / Formula rendering |
| **Web Speech API** | 语音输入 / Voice input |
| **YOLOv8** | 目标检测 / Object detection |
| **EasyOCR** | 文字识别 / Text recognition |
| **PyAutoGUI** | 键盘鼠标自动化 / Keyboard & mouse automation |
| **PyGetWindow** | 窗口管理 / Window management |
| **MCP (TypeScript)** | 文件系统协议 / File system protocol |
| **Docker** | Dify 部署 / Dify deployment |

---

## 🚀 一键部署 / One-Click Setup

### 前提条件 / Prerequisites

| 工具 / Tool | 版本 / Version | 下载 / Download |
|------|---------|------|
| Node.js | 20+ | https://nodejs.org |
| Docker Desktop | 最新 / Latest | https://docker.com |
| Python | 3.10+ | https://python.org |
| Git | 最新 / Latest | https://git-scm.com |

### Windows 一键安装 / One-Click Windows Setup

```batch
git clone https://github.com/你的用户名/my-desktop-agent.git
cd my-desktop-agent
setup.bat

setup.bat 会自动完成 / Automatically completes:

✅ 检查 Node.js、Docker、Python 环境 / Check Node.js, Docker, Python
✅ 安装所有 Python 依赖 / Install Python dependencies
✅ 安装 Electron 依赖 / Install Electron dependencies
✅ 启动 Dify 服务 / Start Dify service

手动安装 / Manual Setup
# 1. 克隆项目 / Clone the project
git clone https://github.com/你的用户名/my-desktop-agent.git
cd my-desktop-agent

# 2. 安装 Python 依赖 / Install Python dependencies
pip install -r requirements.txt

# 3. 安装 IndexTTS2（可选，用于自训练音色） / Install IndexTTS2 (optional)
cd F:\index-tts  # 或你的模型路径 / or your model path
uv sync --all-extras
cd ..

# 4. 启动 Dify / Start Dify
cd dify/docker
docker compose up -d
cd ../..

# 5. 安装 Electron 依赖 / Install Electron dependencies
cd electron-app
npm install

# 6. 启动桌面应用 / Start the desktop app
npm start