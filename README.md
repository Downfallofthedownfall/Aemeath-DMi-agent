# 🤖 我的桌面助手 - 爱弥斯 / My Desktop Agent - Aemeath

> 🇨🇳 Ciallo～(∠・ω< )⌒☆ 一个支持语音、RAG、工具调用、双模态切换的桌面AI助手  
> 🇬🇧 A desktop AI assistant with voice, RAG, tool calling, and dual-mode switching.

![版本](https://img.shields.io/badge/版本-1.0.0-blue)
![Electron](https://img.shields.io/badge/Electron-28.0.0-47848F)
![DeepSeek](https://img.shields.io/badge/DeepSeek-Chat-4F46E5)

---

## ✨ 功能一览 / Features

### 🧠 AI 核心能力 / Core AI Capabilities

| 功能 / Feature | 状态 / Status | 说明 / Description |
|------|------|------|
| DeepSeek 对话 / DeepSeek Chat | ✅ | 双 Agent 独立运行 / Dual agents running independently |
| RAG 知识库 / RAG Knowledge Base | ✅ | 独立知识库，互不干扰 / Independent knowledge bases |
| 共享记忆 / Shared Memory | ✅ | 双模态共享用户信息 / Shared user info across modes |
| 深度思考 / Deep Thinking | ✅ | 保留思考，界面自动过滤 / Kept but filtered in UI |
| 双模态切换 / Dual-mode Switching | ✅ | 一键切换桌宠/学霸 / One-click switch: Pet ↔ Scholar |

### 🔧 工具与扩展 / Tools & Extensions

| 功能 / Feature | 状态 / Status | 说明 / Description |
|------|------|------|
| 联网搜索 / Web Search | ✅ | 实时搜索网络信息 / Real-time web search |
| 天气查询 / Weather | ✅ | 实时天气数据 / Real-time weather data |
| 数学计算 / Math | ✅ | 公式计算与推导 / Formula calculation |
| 代码执行 / Code Interpreter | ✅ | 执行 Python 代码 / Execute Python code |
| arXiv 论文搜索 / arXiv Search | ✅ | 学术论文检索 / Academic paper search |
| 本地命令执行 / Local Command | ✅ | 打开软件、操作电脑 / Open apps, control PC |
| MCP 扩展 / MCP Extensions | ✅ | 插件市场工具支持 / Marketplace tool support |
| 工作流技能 / Workflow Skills | ✅ | 自定义多步骤自动化 / Custom multi-step automation |

### 🖥️ 桌面体验 / Desktop Experience

| 功能 / Feature | 状态 / Status | 说明 / Description |
|------|------|------|
| 深色科技风 UI / Dark Tech UI | ✅ | 紫色/蓝色主题 / Purple-blue theme |
| 打字动画 / Typing Animation | ✅ | AI 回复实时显示 / Real-time streaming display |
| 语音输入 / Voice Input | ✅ | 麦克风录音转文字 / Mic recording to text |
| TTS 语音播报 / TTS | ✅ | AI 回复自动朗读 / Auto-read AI replies |
| KaTeX 公式渲染 / KaTeX Rendering | ✅ | 数学公式美观显示 / Beautiful math formula display |
| 对话历史管理 / Chat History | ✅ | 新建/切换/删除 / New, switch, delete conversations |
| 系统托盘 / System Tray | ✅ | 关窗口不退出 / Minimize to tray |
| 全局快捷键 / Global Shortcut | ✅ | Ctrl+Shift+Space 唤出/隐藏 |
| 开机自启 / Auto-start | ✅ | 电脑开机自动启动 / Auto-start on boot |

---

## 🎯 路线图 / Roadmap

### 第一阶段 / Phase 1 ✅ 已完成 / Completed

- [x] DeepSeek 对话 + RAG 知识库 / DeepSeek Chat + RAG Knowledge Base
- [x] 双模态切换 + 共享记忆 / Dual-mode Switching + Shared Memory
- [x] 工具调用 + MCP 扩展 / Tool Calling + MCP Extensions
- [x] 语音输入 + TTS 播报 / Voice Input + TTS
- [x] KaTeX 公式渲染 / KaTeX Formula Rendering
- [x] 系统托盘 + 全局快捷键 + 开机自启 / System Tray + Shortcut + Auto-start
- [x] 工作流技能 / Workflow Skills

### 第二阶段 / Phase 2 🟡 进行中 / In Progress

- [ ] 打包 exe 安装程序 / Package as exe installer
- [ ] 功能完善与优化 / Feature polishing & optimization
- [ ] 修复已知问题 / Bug fixes

### 第三阶段 / Phase 3 🔮 已规划 / Planned

#### ⭐⭐⭐ 防 OOC 检测 / OOC (Out of Character) Detection

- [ ] 关键词规则引擎 / Keyword rule engine (Electron)
- [ ] AI 辅助 OOC 评分 / AI-assisted OOC scoring (Workflow)
- [ ] 自动修正机制 / Auto-correction mechanism

#### ⭐⭐⭐ 视觉识别 / Visual Recognition

| 子任务 / Subtask | 状态 / Status |
|------|------|
| YOLO 对象检测 / YOLO Object Detection | ❌ |
| 屏幕截图分析 / Screenshot Analysis | ❌ |
| 多模态模型（Ollama + LLaVA）/ Multimodal Model | ❌ |

#### ⭐⭐ 自训练 TTS / Self-trained TTS (IndexTTS2)

| 阶段 / Phase | 内容 / Content | 状态 / Status |
|------|------|------|
| 数据准备 / Data Preparation | 录制 10~30 分钟语音 / Record 10-30 min of voice | ❌ |
| 模型训练 / Model Training | 本地 5070Ti 训练 IndexTTS2 / Train IndexTTS2 on 5070Ti | ❌ |
| Electron 集成 / Electron Integration | Python TTS 服务 + 替换 Web Speech API | ❌ |

#### ⭐ 高级扩展 / Advanced Extensions

- [ ] 自定义 MCP Server / Custom MCP Server
- [ ] 插件系统 / Plugin System
- [ ] 多语言支持 / Multi-language Support

---

## 🛠️ 技术栈 / Tech Stack

| 技术 / Technology | 用途 / Purpose |
|------|------|
| **Electron 28** | 桌面应用框架 / Desktop app framework |
| **Dify 1.15** | AI 引擎 / AI engine (DeepSeek, RAG, tools, workflows) |
| **DeepSeek Chat** | LLM 模型 / LLM model |
| **KaTeX** | 公式渲染 / Formula rendering |
| **Web Speech API** | 语音输入/输出 / Voice input/output |
| **Docker** | Dify 部署 / Dify deployment |

---

## 🚀 快速开始 / Quick Start

### 前置要求 / Prerequisites

- Node.js 20+
- Docker Desktop
- Git

### 安装与运行 / Installation & Run

```bash
# 克隆项目 / Clone the project
git clone https://github.com/你的用户名/my-desktop-agent.git
cd my-desktop-agent

# 启动 Dify / Start Dify
cd dify/docker
docker compose up -d

# 安装 Electron 依赖 / Install Electron dependencies
cd ../../electron-app
npm install

# 启动桌面应用 / Start the desktop app
npm start
