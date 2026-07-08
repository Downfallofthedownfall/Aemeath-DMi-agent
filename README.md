# 🤖 爱弥斯DMi助手
# 🤖 Aemeath Dual-Mode-intelligent Assistant

> 🇨🇳 一个支持语音、RAG、工具调用、视觉识别、双模态切换的桌面AI助手  
> 🇬🇧 A desktop AI assistant with voice, RAG, tool calling, visual recognition, and dual-mode switching.

---

## ✨ 功能一览 / Features

### 🧠 AI 核心能力 / Core AI

| 🇨🇳 功能 | 🇬🇧 Feature | 状态 |
|---------|------------|------|
| DeepSeek 对话 | DeepSeek Chat | ✅ |
| RAG 知识库 | RAG Knowledge Base | ✅ |
| 共享记忆 | Shared Memory | ✅ |
| 深度思考（自动过滤） | Deep Thinking (auto-filtered) | ✅ |
| 双模态切换 | Dual-mode Switching | ✅ |

### 🔧 工具与扩展 / Tools

| 🇨🇳 功能 | 🇬🇧 Feature | 状态 |
|---------|------------|------|
| 联网搜索 | Web Search | ✅ |
| 天气查询 | Weather Query | ✅ |
| 数学计算 | Math Calculations | ✅ |
| 代码执行 | Code Interpreter | ✅ |
| 文件系统操作 | File System Operations | ✅ |
| 键盘鼠标控制 | Keyboard & Mouse Control | ✅ |
| 本地命令执行 | Local Command Execution | ✅ |
| 工作流技能 | Workflow Skills | ✅ |

### 🎙️ 语音与视觉 / Voice & Vision

| 🇨🇳 功能 | 🇬🇧 Feature | 状态 |
|---------|------------|------|
| TTS 语音播报（自训练音色） | TTS (Custom Voice) | ✅ |
| 语音输入 | Voice Input | ✅ |
| YOLO 目标检测 | YOLO Object Detection | ✅ |
| OCR 文字识别 | OCR Text Recognition | ✅ |
| 屏幕场景描述 | Screen Scene Description | ✅ |

### 🖥️ 桌面体验 / Desktop Experience

| 🇨🇳 功能 | 🇬🇧 Feature | 状态 |
|---------|------------|------|
| KaTeX 公式渲染 | KaTeX Formula Rendering | ✅ |
| OOC 检测 + 自动修正 | OOC Detection + Auto-fix | ✅ |
| 系统托盘 | System Tray | ✅ |

---

## 🚀 一键部署 / One-Click Setup

### 📋 前提条件 / Prerequisites

| 🇨🇳 软件 | 🇬🇧 Software | 版本 / Version | 下载 / Download |
|---------|------------|---------------|----------------|
| Node.js | Node.js | 20+ | https://nodejs.org |
| Docker Desktop | Docker Desktop | latest | https://docker.com |
| Python | Python | 3.10+ | https://python.org |
| Git | Git | latest | https://git-scm.com |

### 🔑 需要准备的 API Key / API Keys Required

| 🇨🇳 Key | 🇬🇧 Key | 用途 / Purpose | 获取地址 / URL |
|---------|--------|---------------|---------------|
| DeepSeek API Key | DeepSeek API Key | 对话模型 / Chat Model | https://platform.deepseek.com/api_keys |
| 通义千问 API Key | Qwen API Key | 知识库重排序 / RAG Reranking | https://help.aliyun.com/zh/model-studio |

### 📥 安装步骤 / Installation Steps

# 🇨🇳 克隆项目
# 🇬🇧 Clone the project
git clone https://github.com/你的用户名/my-desktop-agent.git
cd my-desktop-agent

# 🇨🇳 一键部署（Windows）
# 🇬🇧 One-click deployment (Windows)
setup.bat

🇨🇳 setup.bat 会自动完成以下操作：
🇬🇧 setup.bat will automatically:
✅ 检查 Node.js / Docker / Python 是否已安装 / Check if Node.js, Docker, Python are installed
✅ 安装 Python 依赖 / Install Python dependencies (pip install -r requirements.txt)
✅ 安装 Electron 依赖 / Install Electron dependencies (npm install)
✅ 启动 Dify 服务 / Start Dify service (docker compose up -d)
✅ 导入预置应用配置（YAML）/ Import preset app configurations (YAML)
✅ 引导你填写 DeepSeek 和通义千问的 API Key / Guide you to enter API Keys

🇨🇳 手动启动（不通过 setup.bat）
🇬🇧 Manual Start (without setup.bat)

# 🇨🇳 启动 Dify
# 🇬🇧 Start Dify
cd dify/docker
docker compose up -d

# 🇨🇳 安装依赖并启动桌面应用
# 🇬🇧 Install dependencies and launch
cd ../../electron-app
npm install
npm start

首次配置 / First-time Setup
打开浏览器访问 http://localhost，注册 Dify 账号 
进入设置 → 模型供应商，配置 DeepSeek 和通义千问的 
复制 config.example.json 为 config.json，填入你的 
重启应用，预置配置将自动加载
Open http://localhost and register a Dify account API Key Go to Settings → Model Providers, configure API Keys API Key copy config.example.json to config.json, fill in your keys Restart the app, preset configs will load automatically

## 📁 项目结构

```text
Aemeath-Desktop-Agent/
├── electron-app/                  # Electron 桌面应用
│   ├── main.js                    # 主进程
│   ├── preload.js                 # 渲染进程桥接
│   ├── config.json                # 用户配置（含 API Key，不入库）
│   ├── config.example.json        # 配置模板
│   ├── dify_apps/                 # Dify 应用 YAML 导出
│   │   ├── aemeath.yml            # 爱弥斯桌宠
│   │   ├── physicist.yml          # 星炬物理学霸
│   │   └── ooc_check.yml          # OOC 检测工作流
│   ├── renderer/                  # 前端界面
│   │   ├── index.html
│   │   ├── style.css
│   │   └── app.js
│   ├── run_server.py              # 本地命令执行服务
│   ├── control_server.py          # 键盘鼠标控制服务
│   └── assets/                    # 图标资源
├── dify/                          # Dify Docker 服务
├── setup.bat                      # Windows 一键部署脚本
├── requirements.txt               # Python 依赖清单
└── README.md                      # 项目说明

## 🛠️ 技术栈

| 技术 | 用途 |
|------|------|
| Electron 28 | 桌面应用框架 |
| Dify 1.15 | AI 工作流引擎 |
| DeepSeek Chat | 对话模型 |
| 通义千问 (Qwen) | RAG 重排序 |
| IndexTTS2 | 语音合成 |
| YOLOv8 | 目标检测 |
| EasyOCR | 文字识别 |
| pyautogui | 键鼠控制 |
| KaTeX | 公式渲染 |
| Docker | Dify 容器化部署 |

---

## 🎯 路线图

### ✅ 第一阶段（已完成）
- DeepSeek 对话 + RAG 知识库
- 双模态切换 + 共享记忆
- 工具调用 + 文件系统
- TTS 语音播报 + 语音输入
- KaTeX 公式渲染
- 系统托盘 + 快捷键 + 开机自启
- OOC 检测 + 自动修正
- 视觉识别（YOLO + OCR）
- 键盘鼠标控制

### 🟡 第二阶段（进行中）
- 打包 exe 安装程序
- 一键部署脚本完善

### 🔮 第三阶段（已规划）
- 自定义 MCP Server
- 插件系统
- 多语言支持

---

## 📜 许可证

MIT License

---

## 💬 项目启动时间

2026年6月28日

