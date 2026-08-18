# 🤖 Aemeath-DMi Agent v2 · physicist · 物理学习 Copilot

> **定位 / Positioning**: A physics-study Copilot trained on real lecture notes, past Altklausur exams, and weekly usage logs from Universität Hamburg's Physik I / Math I — plus a companion desktop pet (爱弥斯 / Aemeath) as the attention gateway. One engine, two skins.
>
> **架构 / Architecture**: v2 is rebuilt on the DeepSeek Harness (dsh) plugin system. **The platform is just the engine — the moat is the physics content track**: Worldbook knowledge base, exam benchmark, weekly usage log (see [docs/usage-log.md](docs/usage-log.md) and migration plan `docs/v2-migration-plan.md`).
>
> **状态 / Status**: M0–M6 engine + M5 frontend delivered; security hardening (S1–S5 / C1–C26) done; 73 unit tests green.

---

## 🌍 English

### What is this?

A local-first desktop AI with **two strictly isolated characters**:

| Character | Role | Personality |
|---|---|---|
| **physicist** | Physics-study Copilot | Solves with reasoning first, verifies with SymPy, cites sources (Worldbook id / lecture chapter), and **honestly admits when it doesn't know** — it never pretends. |
| **Aemeath (爱弥斯)** | Companion desktop pet | Emotional companion persona. Personality and knowledge are fully separated from physicist by agent isolation. |

Built on [DeepSeek Harness](https://github.com/deepseek-ai) (dsh `0.1.0-rc.6`) as a TypeScript plugin monorepo — the engine stays vanilla dsh; all domain capability (knowledge / memory / retrieval / solving workflow / UI) lives in self-written plugins.

### Features

| Capability | Status | Notes |
|---|---|---|
| Dual-role dual-agent isolation (physicist / Aemeath) | ✅ M0 | dsh persona mechanism, per-agent isolation |
| OOC rule layer (out-of-character correction) | ✅ M0 | Regex pre-step interception (LLM judge layer: M6, off by default) |
| Smoke tool `aemeath/version` | ✅ M0 | Tool registration + session log verification |
| Worldbook physics knowledge base (59+8 entries) | ✅ M2 | Physik I + Math I entries, dual-library isolation, hot reload, `retrieve_worldbook` tool |
| Layered memory L1/L2/L3 + gatekeeper | ✅ M3 | Rule-first + LLM judge, BM25 dedup, conflict supersede, capacity eviction with user-profile sink, HTTP admin endpoint |
| Lecture retrieval + Altklausur benchmark | ✅ M4 | SQLite FTS5 BM25 (Chinese bigram), 6 metrics, headless runner |
| Solving workflow (SymPy verification) | ✅ M6 | Plan → execute → ✅/❌ verify → conclusion + source; honest degradation on tool failure |
| Frontend overhaul + desktop shell | ✅ M5 | Forced light theme, brand layer, hero + role cards, quick settings, workspace picker, memory panel, TTS button, Electron shell (`app/`) |
| Security hardening | ✅ 2026-08 | S1–S5 (sympy sandbox / clipboard / CORS / memory-http token) + C1–C26 (build / config / frontend / python / electron) |

> Full milestone & acceptance details: `docs/v2-migration-plan.md` (§5). Project report: `docs/PROJECT_REPORT.md`.

### Content track (the moat, developed in parallel)

- **Worldbook 30+ entries** (M2): `packages/worldbook/data/physicist/`
- **Altklausur past exams** (before M4): collected from Fachschaft → `packages/benchmark/altklausur/` (replace `questions.json` ≥50%, record `source_year`)
- **Weekly ≥2h real study**: `docs/usage-log.md`

### Quick start

**⚡ Full setup (PowerShell)** — clone → install → launch the desktop shell:

```powershell
# 1) Clone the repo anywhere you like (e.g. D:\dev)
cd D:\dev
git clone https://github.com/Downfallofthedownfall/Aemeath-DMi-agent.git
cd Aemeath-DMi-agent

# 2) Allow local scripts for this session (run once)
Set-ExecutionPolicy -Scope Process Bypass -Force

# 3) One-shot install (requires Node 22.13+ & Python 3.10+)
.\setup.bat

# 4) Launch the desktop pet (Electron shell: hosts dsh + branded window)
cd app
npm start
```

> `npm start` (inside `app/`) is the **daily driver** — it starts/hosts the dsh service on 3081 and opens the branded Electron window automatically. You can also use the browser UI or the other commands instead:

```powershell
# Browser UI (alternative to the desktop shell)
.\scripts\dsh.ps1 --profile aemeath --port 3081   # → http://127.0.0.1:3081

# Headless smoke test (no browser)
.\scripts\dsh.ps1 --profile aemeath-run "Hi, introduce yourself"

# Benchmark (headless, six metrics)
python packages\benchmark\run_benchmark.py --limit 5

# Memory admin endpoint (token is printed in the startup log)
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:18895/memory/stats
```

Equivalent manual install steps (bash):

```bash
npm install --cache .npm-cache
npm run build
cd profiles\aemeath && npm install --legacy-peer-deps --cache ..\..\.npm-cache && cd ..\..
cd profiles\aemeath-run && npm install --legacy-peer-deps --cache ..\..\.npm-cache && cd ..\..
pip install -r requirements.txt
cd app && npm install
```

> `scripts/dsh.ps1` pins a project-local DSH_HOME (`.dsh-home/`, gitignored) so it never touches your global dsh web profile. API key: Web UI **Settings → API Key**, or write `.dsh-home/.credentials.yaml`, falling back to the `DEEPSEEK_API_KEY` env var.

### Tech stack

| Tech | Purpose |
|---|---|
| **DeepSeek Harness (dsh) rc.6** | Agent loop, tool pipeline, session event sourcing, approval, plugin system (the engine) |
| DeepSeek API | Chat model (deepseek-v4-flash) |
| TypeScript (plugins) · Cordis | dsh plugin monorepo (`packages/`) |
| Python microservices (MCP) | SymPy compute / YOLO-OCR vision / IndexTTS2 TTS / keyboard-mouse control, wired via dsh `mcp-client` (`packages/py-services/`) |
| SQLite FTS5 | Lecture retrieval (BM25) |
| Electron (41) | Desktop pet shell (managed dsh + branded window, packaging via electron-builder) |
| **i18n (zh/en)** | UI strings via dsh locale service (`packages/ui/dsh-plugin-ui/src/client/i18n.ts` + `locales.ts`); personas per locale (`profiles/aemeath/personas/*.en.md`) |

### Localization (i18n)

- **UI**: all user-visible strings live in `packages/ui/dsh-plugin-ui/src/client/locales.ts` (zh = key source, en checked complete by TS). Components call `t(key)` / `useLocale()` from `i18n.ts`; language is switchable in **Settings → Language** (browser default applies otherwise). Chinese and English only.
- **Personas**: `common` plugin picks `personas/<name>.en.md` when `settings.locale.preference` is `en`, falling back to the default Chinese file.
- **Out of scope** (by design): benchmark sets, backend/LLM-facing tool descriptions & prompts, debug logs, docs.

### Project structure

```
packages/            # v2 plugin monorepo (common/worldbook/memory/retriever/workflow/benchmark/py-services/ui)
packages/py-services # v1 Python microservices → MCP servers (sympy/vision/tts/control, zero-dep mcp_core)
profiles/            # dsh profiles (aemeath = Web main, aemeath-run = one-shot/benchmark)
scripts/dsh.ps1      # dsh wrapper (project-local DSH_HOME + cwd + preset sync)
docs/                # migration plan + usage log + handover + project report (gitignored)
app/                 # Electron desktop shell (hosts dsh + branded window)
electron-app/        # v1 (frozen, tag v1.0; migrated files removed, shell reference only)
```

### Testing

```bash
npm test -w @aemeath/dsh-plugin-common       # 8  (OOC rule layer)
npm test -w @aemeath/dsh-plugin-worldbook    # 10 (trigger/order/chain/token budget)
npm test -w @aemeath/dsh-plugin-memory       # 38 (gatekeeper/BM25-conflict/engine/L1 buffer)
npm test -w @aemeath/dsh-plugin-retriever    # 4  (chunker)
npm test -w @aemeath/dsh-plugin-workflow     # 13 (routing/plan scratch + dimensions)
# Total: 73 unit tests (all green)
```

### Roadmap (next)

1. Frontend polish: P4 inline tool UIs, P5 shell light-theme polish.
2. Content track: real lecture notes + Altklausur exams → full 6-metric benchmark.
3. M6 v2 / M3 leftovers: codeMode enablement, knowledge-layer → retriever bridge, v1 memory.db migration run-through.

---

## 🇨🇳 中文

### 这是什么？

一个**本地优先的桌面 AI**，两个**严格隔离的角色**：

| 角色 | 定位 | 人格 |
|---|---|---|
| **physicist** | 物理学习 Copilot | 先讲原理再给结论；计算必过 SymPy 验证；回答带来源（Worldbook id / 讲义章节）；**不会就诚实承认**，绝不编造。 |
| **爱弥斯** | 情感陪伴桌宠 | 陪伴型人格；与 physicist 通过 agent 隔离彻底分开，人格与知识互不串扰。 |

基于 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh `0.1.0-rc.6`）的 TypeScript 插件 monorepo 构建——引擎保持原版 dsh，所有领域能力（知识/记忆/检索/解题流/前端）都是自研插件。

### 能力清单

| 能力 | 状态 | 说明 |
|---|---|---|
| 双角色（physicist/爱弥斯）双 agent 隔离 | ✅ M0 | dsh persona 机制，人格按 agent 隔离 |
| OOC 规则层（越界纠偏） | ✅ M0 | pre-step 正则拦截（LLM 判定层：M6，默认关） |
| 冒烟工具 aemeath/version | ✅ M0 | 工具注册 + 会话日志验证 |
| Worldbook 物理知识库（59+8 条） | ✅ M2 | Physik I + Math I 双馆隔离、热重载、retrieve_worldbook 工具 |
| 分层记忆 L1/L2/L3 + 守门员 | ✅ M3 | 规则层优先 + LLM 判定，BM25 查重、冲突 supersede、容量淘汰前沉淀画像、HTTP 管理端点 |
| 讲义检索 + Altklausur 基准 | ✅ M4 | SQLite FTS5 BM25（中文 bigram），六指标，headless 驱动 |
| 解题工作流（SymPy 验证） | ✅ M6 | 计划→执行→✅/❌ 验证标记→结论+来源；工具故障诚实降级 |
| 前端改造 + 桌宠壳 | ✅ M5 | 强制亮色、品牌层、hero + 角色卡、快速设置、工作区选择、记忆面板、TTS 按钮、Electron 壳（app/） |
| 安全加固 | ✅ 2026-08 | S1–S5（sympy 沙箱/剪贴板/CORS/记忆端点 token）+ C1–C26（构建/配置/前端/Python/Electron） |

> 完整里程碑与验收见 `docs/v2-migration-plan.md`（§5）；全项目报告见 `docs/PROJECT_REPORT.md`。

### 内容轨（与开发并行，护城河本体）

- **Worldbook 30+ 条**（M2 期间）：`packages/worldbook/data/physicist/`
- **Altklausur 真题**（M4 前）：Fachschaft 收集 → 替换 `questions.json` ≥50%（记 `source_year`）
- **每周 ≥2h 真实学习**：`docs/usage-log.md`

### 快速开始

**⚡ 全套流程（PowerShell）** —— clone → 安装 → 直接启动桌宠：

```powershell
# 1) 把仓库 clone 到任意目录（例如 D:\dev）
cd D:\dev
git clone https://github.com/Downfallofthedownfall/Aemeath-DMi-agent.git
cd Aemeath-DMi-agent

# 2) 允许本会话运行本地脚本（只需一次）
Set-ExecutionPolicy -Scope Process Bypass -Force

# 3) 一键安装（需 Node 22.13+ / Python 3.10+）
.\setup.bat

# 4) 启动桌宠（Electron 壳：自动托管 dsh + 品牌窗口）
cd app
npm start
```

> `npm start`（app/ 内）是**日常入口**：自动拉起/复用 3081 的 dsh 服务并打开品牌 Electron 窗口。也可改用浏览器 UI 或其他命令：

```powershell
# 浏览器 UI（替代桌宠壳）
.\scripts\dsh.ps1 --profile aemeath --port 3081   # → http://127.0.0.1:3081

# headless 冒烟测试（无需浏览器）
.\scripts\dsh.ps1 --profile aemeath-run "你好，自我介绍"

# 基准（headless，六指标）
python packages\benchmark\run_benchmark.py --limit 5

# 记忆管理端点（token 见启动日志）
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:18895/memory/stats
```

等价手动安装步骤（bash）：

```bash
npm install --cache .npm-cache
npm run build
cd profiles\aemeath && npm install --legacy-peer-deps --cache ..\..\.npm-cache && cd ..\..
cd profiles\aemeath-run && npm install --legacy-peer-deps --cache ..\..\.npm-cache && cd ..\..
pip install -r requirements.txt
cd app && npm install
```

> `scripts/dsh.ps1` 固定项目内 DSH_HOME（`.dsh-home/`，gitignored），不干扰全局 web profile。API Key：Web「设置 → API 密钥」填写，或写入 `.dsh-home/.credentials.yaml`，缺省回退环境变量 `DEEPSEEK_API_KEY`。

### 技术栈

| 技术 | 用途 |
|---|---|
| **DeepSeek Harness（dsh）rc.6** | agent loop、工具流水线、会话事件溯源、审批、插件体系（引擎） |
| DeepSeek API | 对话模型（deepseek-v4-flash） |
| TypeScript（插件）· Cordis | dsh 插件 monorepo（`packages/`） |
| Python 微服务（MCP） | SymPy 计算 / YOLO-OCR 视觉 / IndexTTS2 语音 / 键鼠控制，经 dsh `mcp-client` 接入（`packages/py-services/`） |
| SQLite FTS5 | 讲义检索（BM25） |
| Electron（41） | 桌宠壳（托管 dsh + 品牌窗口，electron-builder 打包） |
| **i18n（中/英）** | UI 文案走 dsh locale 服务（`packages/ui/dsh-plugin-ui/src/client/i18n.ts` + `locales.ts`）；人格按 locale 选文件（`profiles/aemeath/personas/*.en.md`） |

### 本地化（i18n）

- **UI**：所有用户可见文案集中在 `packages/ui/dsh-plugin-ui/src/client/locales.ts`（zh 为 key 源，en 由 TS 类型强制 key 集一致）。组件用 `i18n.ts` 的 `t(key)` / `useLocale()`；语言在「设置 → 语言」切换（缺省跟随浏览器）。仅中文与英文。
- **人格**：`common` 插件在 `settings.locale.preference` 为 en 时加载 `personas/<名字>.en.md`，缺省回退中文文件。
- **明确不翻**（按产品决策）：基准题集、后端/LLM 侧工具描述与 prompt、debug 日志、文档。

### 项目结构

```
packages/            # v2 插件 monorepo（common/worldbook/memory/retriever/workflow/benchmark/py-services/ui）
packages/py-services # v1 Python 微服务 → MCP server（sympy/vision/tts/control，mcp_core 零依赖）
profiles/            # dsh profile（aemeath=Web 主 profile，aemeath-run=一次性/基准）
scripts/dsh.ps1      # dsh 包装脚本（项目内 DSH_HOME + cwd + preset 同步）
docs/                # 迁移计划 + 使用日志 + 交接 + 项目报告（gitignored）
app/                 # Electron 桌宠壳（托管 dsh + 品牌窗口）
electron-app/        # v1（冻结，tag v1.0；已迁移文件删除，仅留壳参考）
```

### 测试

```bash
npm test -w @aemeath/dsh-plugin-common       # 8  （OOC 规则层）
npm test -w @aemeath/dsh-plugin-worldbook    # 10 （触发/排序/chain 防环/token 预算）
npm test -w @aemeath/dsh-plugin-memory       # 38 （守门员/BM25 冲突/引擎/L1 缓冲）
npm test -w @aemeath/dsh-plugin-retriever    # 4  （分块器）
npm test -w @aemeath/dsh-plugin-workflow     # 13 （分流/plan 落 scratch + 量纲）
# 合计：73 项单测（全绿）
```

### 下一步

1. 前端打磨收尾：P4 工具内联 UI、P5 桌宠壳亮色打磨。
2. 内容轨：真实讲义 + Altklausur 真题 → 完整六指标基准。
3. M6 v2 / M3 遗留：codeMode 启用、知识层 → retriever 桥接、v1 memory.db 迁移跑通。

---

## ⚠️ 免责声明 / Disclaimer

本项目为粉丝同人作品，角色「爱弥斯」「星炬」及其世界观出自游戏《鸣潮》（Kuro Games 库洛游戏）。本项目与 Kuro Games 无任何关联，未获其官方授权；仅供学习交流使用，**禁止商用**；角色美术、语音等素材版权归原作者/版权方所有；如涉及侵权，请联系删除相关内容。

*This is a fan-made project. The characters "Aemeath" and "Stellar Torch" and their world belong to the game Wuthering Waves (Kuro Games). This project is not affiliated with or endorsed by Kuro Games. For learning purposes only — **no commercial use**; character art/voice assets belong to their respective owners; contact us to remove any infringing content.*

## 📄 许可证 / License

MIT License (code). See [LICENSE](LICENSE).
