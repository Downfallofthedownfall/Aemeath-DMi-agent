# 🤖 Aemeath-DMi Agent · 爱弥斯 / 星炬学院学霸
       
> Dual-persona desktop AI agent: 爱弥斯 (companion pet) as the face, 星炬学院学霸 (physics study copilot) as the engine.
                
> 🇨🇳 基于 Electron + Python 微服务 + DeepSeek 的桌面 AI 助手：双角色模式、语音交互、视觉识别、系统控制、
> 分层记忆系统（规划中）、物理学习工具链（规划中）。面向物理学习场景设计与验证。
> 🇬🇧 A desktop AI assistant built on Electron + Python microservices + DeepSeek: dual-persona modes, voice,
> vision, system control, layered memory (planned), and a physics-learning toolchain (planned) —
> designed and validated around real physics coursework.

---

## 🎯 项目定位 / Positioning

| 角色 | 定位 | 职责 |
|:----|:----|:----|
| **爱弥斯** 🐾 | 桌宠 / 陪伴 | 日常聊天、情绪陪伴、语音交互——**注意力的入口** |
| **星炬** 🎓 | 物理学霸 / 学习引擎 | 讲义 RAG、解题陪练、错题记忆、模拟考试——**价值的核心** |

**核心理念：** 一个引擎，两种皮肤。对话、工具、记忆系统全共享，角色规则与知识库按模式隔离。

---

## ✨ 功能一览 / Features

### 🧠 AI 核心 / Core AI

| 功能 | Feature | 状态 |
|------|---------|:----:|
| DeepSeek 对话（SSE 流式） | DeepSeek Chat (SSE Streaming) | ✅ |
| 双角色切换（爱弥斯/星炬） | Dual-persona Switching | ✅ |
| 共享记忆（localStorage） | Shared Memory (localStorage) | ✅ |
| OOC 角色一致性检测（规则+LLM 双层） | OOC Check (rule + LLM dual-layer) | ✅ |
| Function Calling 工具链 | Tool Calling | ✅ |
| **分层记忆系统 L1/L2/L3（Zen3 式共享 L3）** | **Layered Memory (L1/L2/L3)** | 🧪 规划中 |
| **记忆守门员（去重/防污染/冲突处理）** | **Memory Gatekeeper** | 🧪 规划中 |
| **物理 Worldbook 知识库（触发词注入）** | **Physics Worldbook KB** | 🧪 规划中 |
| **讲义 BM25 检索 + Altklausur 基准测试** | **Notes Retrieval + Exam Benchmark** | 🧪 规划中 |
| **SymPy 符号计算验证（会算不编）** | **SymPy-verified Computation** | 🧪 规划中 |

### 🧠 记忆系统架构 / Memory Architecture（规划中）

```
┌──────────────────────────── 上下文组装 ────────────────────────────┐
│  系统规则 + Worldbook(常驻/触发) + L2 召回 + L3 + 讲义检索 + 历史    │
└───────────▲──────────────────────────────┬───────────────────────┘
            │ 读路径（按需注入）             │ 写路径（守门员判定）
┌───────────┴────────┐        ┌────────────▼───────────────────────┐
│ L1 工作缓存（按模式） │        │ 记忆守门员（双层）                   │
│ 爱弥斯-L1 / 星炬-L1 │        │ 规则层：显式命令/敏感信息/闲聊过滤    │
│ · 最近N轮 + 滚动摘要 │        │ LLM 层：去重/冲突/重要性评分/知识边界  │
│ · 任务暂存区(解题)    │        └────────────┬───────────────────────┘
└───────────┬────────┘        ┌────────────▼───────────────────────┐
┌───────────▼────────┐        │ L3 共享长期库（全局，Active/Dormant） │
│ L2 情景缓存（按模式） │◄───────│ 用户画像 · 学习史 · 跨模式事实        │
│ 错题 · 偏好 · 摘要   │        └────────────┬───────────────────────┘
└────────────────────┘        ┌────────────▼───────────────────────┐
                              │ 图书馆×2（知识层，模式隔离）           │
                              │ 爱弥斯馆：角色 Worldbook              │
                              │ 星炬馆：物理 Worldbook + 讲义向量检索  │
                              └─────────────────────────────────────┘
```

- L1/L2 按角色模式隔离，L3 共享（类比 CPU 的 Zen3 架构）
- 知识全部进图书馆，记忆只存"关于用户的事"——守门员强制这条边界
- 所有写入可审计、可撤销、可在管理界面查看/编辑/删除

### 🔧 工具系统 / Tool System

| 功能 | Feature | 端口 |
|------|---------|:---:|
| 本地命令执行（进程白名单） | Local Command Execution (whitelist) | `18888` |
| 键盘鼠标控制 | Keyboard & Mouse Control | `18890` |
| MCP 文件系统 | File System (MCP) | `18889` |
| YOLO 目标检测 | YOLO Object Detection | `18901` |
| OCR 文字识别 | OCR Text Recognition | `18901` |
| 屏幕场景描述 | Screen Description | `18901` |
| 网页爬虫 | Web Scraper | 内置 |
| Python 代码解释器 | Python Code Interpreter | 内置 |
| arXiv 论文搜索 | arXiv Paper Search | 内置 |

### 🎙️ 语音系统 / Voice System

| 功能 | Feature | 状态 |
|------|---------|:----:|
| TTS 语音播报（IndexTTS2） | TTS (IndexTTS2) | ✅ |
| 语音输入（Web Speech API） | Voice Input (Web Speech API) | ✅ |

### 🖥️ 桌面体验 / Desktop Experience

| 功能 | Feature | 状态 |
|------|---------|:----:|
| 深色科技风 UI + KaTeX 公式渲染 | Dark UI + KaTeX | ✅ |
| 系统托盘 / 全局快捷键 / 开机自启 | Tray / Shortcut / Autostart | ✅ |
| 对话历史管理（按模式存储） | Chat History (per-mode) | ✅ |
| **记忆管理界面（查看/编辑/删除）** | **Memory Management UI** | 🧪 规划中 |

---

## 🔒 安全设计 / Security

| 措施 | 说明 |
|:----|:----|
| AUTH_TOKEN 认证 | 随机 token 由主进程生成、经环境变量注入，所有服务拒绝未认证请求 |
| 命令白名单 + 动态校验 | 进程白名单 + 内置命令回退，修复命令注入与路径遍历风险 |
| 敏感路径黑名单 | 阻止读取凭据类文件 |
| 子进程生命周期管理 | 防内存溢出与端口占用 |
| 本地数据优先 | 记忆/配置存本机；API Key 走环境变量（后续升级 DPAPI 加密） |

---

## 🚀 快速开始 / Quick Start

### 📋 前提条件 / Prerequisites

| 软件 | 版本 |
|:----|:----|
| Node.js | 20+ |
| Python | 3.10+ |

### 🔑 API Key

| Key | 用途 |
|:----|:----|
| DeepSeek API Key | 对话模型 | https://platform.deepseek.com/api_keys |

### 📥 安装 / Installation

```bash
git clone https://github.com/Downfallofthedownfall/Aemeath-DMi-agent
cd Aemeath-DMi-agent

# Windows 一键部署
setup.bat

# 或手动安装
pip install -r requirements.txt
cd electron-app && npm install && cd ..
```

### ⚙️ 配置 / Configuration

编辑 `electron-app/config.json`：

```json
{
    "deepseek_api_key": "sk-你的DeepSeekAPIKey",
    "deepseek_api_base": "https://api.deepseek.com",
    "tts_model_path": "Path to local TTS",
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

### 🚀 启动 / Launch

```bash
cd electron-app
npm start
```

---

## 📁 项目结构 / Project Structure

```
Aemeath-DMi-agent/
├── electron-app/
│   ├── main.js                  # 主进程（窗口/托盘/快捷键/服务管理）
│   ├── preload.js               # IPC 桥接
│   ├── config.json              # 配置（不上传 Git）
│   ├── ai_service.py            # ✅ AI 对话服务（端口 18892）
│   ├── memory_store.py          # 🧪 记忆存储（L1/L2/L3，SQLite）
│   ├── worldbook.py             # 🧪 Worldbook 知识库加载与触发注入
│   ├── gatekeeper.py            # 🧪 记忆守门员（规则层 + LLM 判定层）
│   ├── retriever.py             # 🧪 BM25 检索
│   ├── run_server.py            # ✅ 命令执行服务（18888）
│   ├── control_server.py        # ✅ 键鼠控制服务（18890）
│   ├── vision_server.py         # ✅ 视觉识别服务（18901）
│   ├── mcp-server.ts            # ✅ MCP 文件系统（18889）
│   ├── worldbook/               # 🧪 aemeath/ + physicist/ 知识条目
│   ├── library/                 # 🧪 讲义全文库（physicist/notes/）
│   ├── benchmarks/              # 🧪 基准测试（questions.json + run_benchmark.py）
│   ├── data/                    # 🧪 本地数据库（gitignore）
│   ├── renderer/                # 前端（index.html / style.css / app.js）
│   └── assets/
├── setup.bat
├── requirements.txt
└── README.md
```

> ✅ 已实现 · 🧪 规划中（暑假开发路线，见下方 Roadmap）

---

## 🗺️ 路线图 / Roadmap

| 阶段 | 内容 | 状态 |
|:----|:----|:----:|
| M1 | L1 工作缓存 + L2 滚动摘要（按模式隔离） | 🧪 |
| M2 | 物理 Worldbook 知识库（30 条 Physik I + Math I 条目）+ 触发注入 | 🧪 |
| M3 | 记忆守门员（去重/防污染/冲突处理/知识边界）+ 管理端点 | 🧪 |
| M4 | 讲义 BM25 检索 + Altklausur 基准测试（可复现指标） | 🧪 |
| M5 | 记忆管理界面 + 任务暂存区 UI | 🧪 |

**设计原则：** 写入有门槛，读取有预算；规则层兜底 + LLM 判定层（与 OOC 检测同一范式）；不引入重型框架（自研实现每层）。

---

## 🛠️ 技术栈 / Tech Stack

| 技术 | 用途 |
|:----|:----|
| Electron 28 | 桌面应用框架 |
| DeepSeek API | 对话模型（Function Calling） |
| Python HTTP Server（自研多微服务） | 后端服务 |
| IndexTTS2 | 语音合成 |
| YOLOv8 / EasyOCR | 视觉识别 |
| pyautogui | 键鼠控制 |
| KaTeX | 公式渲染 |
| FastMCP | MCP 文件系统协议 |
| SQLite · BM25 · SymPy（🧪） | 记忆存储 / 检索 / 计算验证 |

---

## 🔧 服务端口一览 / Service Ports

| 服务 | 端口 |
|:----|:---:|
| 命令执行 | `18888` |
| MCP 文件系统 | `18889` |
| 键鼠控制 | `18890` |
| AI 对话 | `18892` |
| TTS 语音 | `18900` |
| 视觉识别 | `18901` |

---

## 📦 打包 / Packaging

```bash
cd electron-app
npm run pack
```

---

## ⚠️ 免责声明 / Disclaimer

本项目为**粉丝同人作品**，角色「爱弥斯」「星炬」及其世界观出自游戏《鸣潮》（Kuro Games 库洛游戏）。
- 本项目与 Kuro Games 无任何关联，未获其官方授权；
- 仅供学习交流使用，**禁止商用**；
- 角色美术、语音等素材版权归原作者/版权方所有；
- 如涉及侵权，请联系删除相关内容。

## 📄 致谢 / Acknowledgments

- 参考与灵感：OpenClaw（个人 Agent 网关架构）、Cyrene-Agent（Worldbook 记忆设计）、Mem0（记忆抽取/冲突处理模式）
- 开源依赖：DeepSeek API、IndexTTS2、YOLOv8、EasyOCR、FastMCP、KaTeX 等（详细授权文件见 `assets/notices/`）

## 📄 许可证 / License

MIT License（代码部分）

---

> 🇨🇳 项目持续开发中——正在为星炬构建物理学习工具链与基准测试。欢迎 Issue / PR！
> 🇬🇧 Under active development — building a physics-learning toolchain and exam benchmark for 星炬. Issues and PRs welcome!
