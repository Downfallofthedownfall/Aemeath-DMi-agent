# 🤖 Aemeath-DMi Agent v2 · physicist · 物理学习 Copilot

A local-first physics-study Copilot with a companion desktop pet, built as a plugin monorepo on
[DeepSeek Harness](https://github.com/deepseek-ai) (dsh `0.2.1-rc.2`). The engine stays vanilla
dsh; all domain capability — knowledge, memory, retrieval, solving workflow, class-note capture,
UI — lives in self-written TypeScript plugins under `packages/`.

One engine, two skins: **physicist** (the physics Copilot) and **Aemeath / 爱弥斯** (the companion
desktop pet). The two characters are isolated at the agent level — separate personas, separate
knowledge, no cross-talk.

---

## 🌍 English

### What is this?

| Character | Role | Personality |
|---|---|---|
| **physicist** | Physics-study Copilot | Reasons first, verifies calculations with SymPy, cites sources (Worldbook entry / lecture chapter), and **says "I don't know" when it doesn't** — it never pretends. |
| **Aemeath (爱弥斯)** | Companion desktop pet | Emotional companion persona. Personality and knowledge are fully separated from physicist by agent isolation. |

### Features

| Capability | Notes |
|---|---|
| Dual-role, dual-agent isolation | dsh personas, per-agent settings and knowledge isolation |
| OOC rule layer | Regex pre-step interception of out-of-character replies (optional LLM judge, off by default) |
| Worldbook knowledge base | Physik I / Math I entries in separate libraries, hot reload, `retrieve_worldbook` tool |
| Layered memory (L1/L2/L3) | Rule-first + LLM gatekeeper, BM25 dedup, typed conflicts (preference evolution vs. direct conflict), user-fact write gate, activation-scored lifecycle, mood observer and relationship cues |
| Fact timeline + idle consolidation | `entityClaims` with `valid_from` / `valid_until` intervals answer "what was true *then*"; attribute changes count as evolution, not conflict; idle consolidation writes topic clusters and suspected conflicts to a separate insights store and never rewrites memories |
| Memory workspace | Full-screen five-page panel: Memories (browse + timeline), Graph, Console, Insights, Status |
| Lecture retrieval + exam benchmark | SQLite FTS5 BM25 (Chinese bigram), five-metric report, headless runner |
| Solving workflow | Plan → execute → ✅/❌ SymPy verification → conclusion + source; honest degradation on tool failure |
| Desktop UI + Electron shell | Branded light-theme UI, quick settings, workspace picker, memory panel, TTS; Electron hosts dsh and opens the app window |
| i18n (zh/en) | UI strings via dsh locale service; personas per locale |
| Curriculum plugin | Modulhandbuch semester summary injection and `curriculum_query` |
| Lecture Mode | Class-note capture → backend-only processing → five-step manual review → one-way handoff (see below) |
| Übungen | PDF homework import → editable answers → manual check → mistake book + worldbook → merged submission PDF (see below) |
| Hardening | Guarded SymPy execution (10 s timeout, expression-size limits), loopback-only token-protected memory admin endpoint, origin-checked write endpoints, Electron navigation locked to the local app origin |

### Requirements

- **Windows 10/11** for the main app (physicist + Aemeath, Electron shell): Node.js ≥ 22.13, Python ≥ 3.10.
- **macOS** for Lecture Mode and Übungen only (no desktop shell, no Python): Node.js ≥ 20.
- A DeepSeek API key (or another provider configured in dsh).

### Quick start (Windows)

```powershell
# 1) Clone the repo anywhere you like (e.g. D:\dev)
cd D:\dev
git clone https://github.com/Downfallofthedownfall/Aemeath-DMi-agent.git
cd Aemeath-DMi-agent

# 2) Allow local scripts for this session (run once)
Set-ExecutionPolicy -Scope Process Bypass -Force

# 3) One-shot install: root deps, plugin build, profile deps, Python deps, Electron shell
.\setup.bat

# 4) Launch the desktop pet (Electron shell: hosts dsh + branded window)
cd app
npm start
```

> `npm start` (inside `app/`) is the **daily driver** — it starts or reuses the dsh service on
> port 3081 and opens the branded window automatically. Browser UI and other entry points:

```powershell
# Browser UI (alternative to the desktop shell)
.\scripts\dsh.ps1 --profile aemeath --port 3081   # → http://127.0.0.1:3081

# Übungen — exercise workbench as its own app (PDF in, submission PDF out)
.\scripts\dsh.ps1 --profile exercise --port 3084  # → http://127.0.0.1:3084

# Headless smoke test (no browser)
.\scripts\dsh.ps1 --profile aemeath-run "Hi, introduce yourself"

# Benchmark (headless, five metrics)
python packages\benchmark\run_benchmark.py --limit 5

# Memory admin endpoint (token is printed in the startup log)
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:18895/memory/stats
```

> `scripts/dsh.ps1` pins a project-local `DSH_HOME` (`.dsh-home/`, gitignored) so it never touches
> your global dsh profile. API key: Web UI **Settings → API Key**, or `.dsh-home/.credentials.yaml`,
> falling back to the `DEEPSEEK_API_KEY` environment variable. The memory admin API listens on
> port 18895.

### 🍎 macOS — Lecture Mode + Übungen

**There is no main agent on macOS, by design.** The physics Copilot (memory, persona, retriever,
Electron shell) is Windows-only. On a Mac you run the two standalone apps — **Lecture Mode** and
**Übungen (exercise mode)** — both fully standalone and zero-Python.

```bash
cd ~/aemeath-dmi-agent
./lecture-launch.command        # class notes (port 3083) — double-click works too
./exercise-launch.command       # homework: import PDF, solve, submit (port 3084)
```

> The launchers find Node themselves (Homebrew / nvm / volta / fnm), install dependencies, build
> the plugins, and link the profiles into `$DSH_HOME` on first run. Use the `.command` files, not
> the `.sh` scripts — double-clicking a `.sh` does not read `~/.zshrc`, so Node is usually missing
> from `PATH`. Submission PDFs need a local Chrome or Edge; without one, open the print page and
> save as PDF.

📖 **Full guides:**
[使用说明-课堂模式-macOS.md](使用说明-课堂模式-macOS.md) (class notes) ·
[使用说明-习题模式-macOS.md](使用说明-习题模式-macOS.md) (homework: import → solve → submit).
Both cover startup, the daily workflow, where data lives, configuration, and troubleshooting.

### Project structure

```
packages/              # dsh plugin monorepo
  shared/              #   common plugin: personas, OOC guard, dsh adapters
  worldbook/           #   knowledge base, hot reload, retrieve_worldbook
  memory/              #   L1/L2/L3 memory, gatekeeper, timeline, insights
  retriever/           #   lecture chunking + SQLite FTS5 BM25
  workflow/            #   solving workflow with SymPy verification
  curriculum/          #   Modulhandbuch summary + query
  lecture/             #   Lecture Mode (standalone profile)
  exercise/            #   Übungen (standalone profile)
  ui/                  #   frontend: theme, settings, memory workspace
  py-services/         #   Python MCP servers: sympy / vision / tts / control
  benchmark/           #   Altklausur benchmark runner + question set
  library/             #   local study content (gitignored, created on use)
profiles/              # dsh profiles: aemeath (main), aemeath-run (headless), lecture, exercise
scripts/               # dsh wrapper, build / link / verify helpers
app/                   # Electron desktop shell
electron-app/          # v1, frozen (shell reference only)
```

### Lecture Mode (class-note capture)

A standalone extension app for taking notes during lectures. **Deliberately not wired into the
main agent's memory pipeline** — classroom data stays in its own file store, and only course
progress / weak points are handed over to the main agent after a five-step manual review.

| Aspect | Design |
|---|---|
| In class | Shorthand markers (`#` topic / `=` formula / `?` question / `!` keypoint / `>` example / `---` split) plus mandatory blanks `[我的理解]` / `[我的疑问]` — the model asks instead of writing them |
| LLM processing | Runs in the background, **stored backend-only** — never shown in the UI (protects active recall) |
| Post-lecture | Five-step state machine; step 3 is Socratic and never gives the answer |
| Summary | Generated only after step 4 (`canGenerateSummary()` is the single gate) |
| Storage | Plain markdown + JSON index under `packages/library/physicist/lectures/` — directly consumable by the retriever |
| Platform | Runs on macOS with zero Python (no TTS / vision / control / SymPy needed) |
| Tools | `lecture_session_start` / `lecture_capture` / `lecture_status` / `lecture_review_start` / `lecture_review_submit` / `lecture_review_next` / `lecture_export_handoff` |

> Setup and internals: [`packages/lecture/dsh-plugin-lecture/README.md`](packages/lecture/dsh-plugin-lecture/README.md).
> macOS walkthrough: [`使用说明-课堂模式-macOS.md`](使用说明-课堂模式-macOS.md).

### Übungen (exercise mode)

A companion workbench for the weekly problem sheets. **Its whole point is honesty about what you
can do**: you write the answer yourself, and the model is only allowed to say *where* it breaks —
never to hand you the solution.

| Aspect | Design |
|---|---|
| Import | Drop in the sheet PDF → pages are rasterised and read by a multimodal model (LaTeX formulas, figures, points, page; cross-page continuations merged by problem label). Text extraction, anchor splitting and regex remain as fallbacks, so an import never blocks. Page screenshots serve as the "original page"; re-splitting keeps answers per problem number |
| Solving | Answer editor renders LaTeX side by side as you type (split / write-only / render-only, synced scrolling), autosaves (900 ms / on blur) and stays **always editable**; the symbol palette inserts raw LaTeX at the caret. Changing an answer marks older checks `stale` instead of deleting them |
| Check | **Manual only** (button / `exercise_check`): verdict + which step is wrong + Socratic hints + what to verify next. When page screenshots exist the check is multimodal. Runs on the **global dsh LLM** — same provider, model and credentials as the main agent, no separate key. Truncated output is repair-parsed; a parse failure is recorded as `error`, never as "your answer is wrong" |
| Mistakes | Cross-sheet mistake book (`_mistakes.json`) with your one-line lesson per entry, `mastered` toggles, auto-filled when a check says `wrong` / `partial` |
| Knowledge | Lessons and mistakes become worldbook entries in the physicist library (`generated_exercise.json`), hot-reloaded in ≤3 s |
| Submission | KaTeX-rendered solutions merged with the original sheet via `pdf-lib` into one PDF for the Übungsbetrieb; internal verdicts are print-hidden |
| Handoff | Reuses Lecture Mode's handoff schema and writer; one-way, received through the gatekeeper (`dry_run` by default) |
| Extras | Minimal mode for problems from a book (paste text or upload a screenshot/PDF), figure attachments checked multimodally and printed inline, rebuttal ("答辩") where the model must re-derive and either concede or hold its ground, approach check (mid-way, manual, repeatable, only flags wrong turns and never hands out the method; the result is transient and manually cleared), collapsible rebuttal thread, cross-page problems checked with both page screenshots, deterministic markdown export, and a progress digest on every new sheet |

```powershell
.\scripts\dsh.ps1 --profile exercise --port 3084   # standalone workbench
```

> Tools: `exercise_list` / `exercise_new_sheet` / `exercise_open` / `exercise_problem` /
> `exercise_save_answer` / `exercise_resplit` / `exercise_check` / `exercise_scratch` /
> `exercise_attach_image` / `exercise_rebut` / `exercise_collect_mistake` / `exercise_lessons` /
> `exercise_export_text` / `exercise_sync_worldbook` / `exercise_build_submission` /
> `exercise_progress` / `exercise_export_handoff` / `exercise_import_handoff`.
> macOS setup walkthrough: [`使用说明-习题模式-macOS.md`](使用说明-习题模式-macOS.md).

### Tech stack

| Tech | Purpose |
|---|---|
| **DeepSeek Harness (dsh) 0.2.1-rc.2** | Agent loop, tool pipeline, session event sourcing, approvals, plugin system (the engine) |
| DeepSeek API | Chat model (`deepseek-v4-flash`) |
| TypeScript + Cordis | dsh plugin monorepo (`packages/`) |
| Python MCP services | SymPy compute / YOLO-OCR vision / IndexTTS2 speech / keyboard-mouse control, wired through dsh `mcp-client` (`packages/py-services/`) |
| SQLite FTS5 | Lecture retrieval (BM25) |
| Electron 43 | Desktop pet shell (managed dsh + branded window, packaged with electron-builder) |
| i18n (zh/en) | UI strings via dsh locale service (`packages/ui/dsh-plugin-ui/src/client/`); personas per locale (`profiles/aemeath/personas/*.en.md`) |

### Localization (i18n)

- **UI**: all user-visible strings live in `packages/ui/dsh-plugin-ui/src/client/locales.ts`
  (zh is the key source; en completeness is enforced by the TS type). Components call `t(key)` /
  `useLocale()`; the language is switchable in **Settings → Language** (browser default otherwise).
  Chinese and English only.
- **Personas**: the `common` plugin picks `personas/<name>.en.md` when `settings.locale.preference`
  is `en`, falling back to the default Chinese file.
- **Out of scope** (by design): benchmark sets, backend/LLM-facing tool descriptions and prompts,
  debug logs, docs.

### Data on disk

- `.dsh-home/` — credentials, sessions, storages and linked profiles. Project-local and gitignored;
  `scripts/dsh.ps1` never touches your global dsh profile.
- `packages/library/` — lectures, homework sheets, mistake books and text exports. Gitignored:
  study content is managed separately from the harness.
- `packages/worldbook/data/` — the shipped knowledge base.

Everything runs on your machine; only model requests (and optional web search) leave it.

### Tests

Each plugin ships its own suite. From the repo root:

```bash
npm run verify                                    # workspace links + shell portability
npm test -w @aemeath/dsh-plugin-common            # and worldbook / memory / retriever /
                                                  # workflow / curriculum / lecture /
                                                  # exercise / ui
```

---

## 🇨🇳 中文

### 这是什么？

一个**本地优先的桌面 AI**，两个**严格隔离的角色**：

| 角色 | 定位 | 人格 |
|---|---|---|
| **physicist** | 物理学习 Copilot | 先讲原理再给结论；计算必过 SymPy 验证；回答带来源（Worldbook 条目 / 讲义章节）；**不会就诚实承认**，绝不编造。 |
| **爱弥斯** | 情感陪伴桌宠 | 陪伴型人格；与 physicist 通过 agent 隔离彻底分开，人格与知识互不串扰。 |

### 能力清单

| 能力 | 说明 |
|---|---|
| 双角色双 agent 隔离 | dsh persona 机制，人格、设置与知识按 agent 隔离 |
| OOC 规则层 | pre-step 正则拦截越界回复（可选的 LLM 判定层，默认关闭） |
| Worldbook 知识库 | Physik I / Math I 双馆隔离、热重载、`retrieve_worldbook` 工具 |
| 分层记忆 L1/L2/L3 | 规则层优先 + LLM 守门员、BM25 查重、typed 冲突（偏好演化 / 直接冲突）、用户事实写入门禁、激活分三态生命周期、情绪观察器与关系线索 |
| 事实时间轴 + 空闲整合 | `entityClaims` 带 `valid_from` / `valid_until` 区间，能回答「**当时**是什么」；属性取值变化=演进不是矛盾；空闲整合把主题簇与疑似矛盾写入独立洞察存储，绝不改写原记忆 |
| 记忆工作区 | 全屏五页：记忆（浏览 + 时间轴）/ 图谱 / 检索台 / 洞察 / 状态 |
| 讲义检索 + Altklausur 基准 | SQLite FTS5 BM25（中文 bigram）、五项指标报告、headless 驱动 |
| 解题工作流 | 计划 → 执行 → ✅/❌ SymPy 验证 → 结论 + 来源；工具故障时诚实降级 |
| 前端 + Electron 桌宠壳 | 品牌亮色界面、快速设置、工作区选择、记忆面板、TTS；Electron 托管 dsh 并打开品牌窗口 |
| i18n（中/英） | UI 文案走 locale 服务；人格按 locale 加载 |
| curriculum 课程插件 | Modulhandbuch 学期摘要注入 + `curriculum_query` |
| Lecture Mode 课堂记录 | 课堂速记 → 只落后端的 LLM 加工 → 五步人工复盘 → 单向握手（见下） |
| Übungen 习题模式 | PDF 作业导入 → 可编辑答案 → 手动检查 → 错题本 + worldbook → 合并提交 PDF（见下） |
| 安全加固 | SymPy 执行加护栏（10s 超时、表达式规模限制）、记忆管理端点仅回环 + token、写端点校验 Origin、Electron 导航锁定本地源 |

### 环境要求

- **Windows 10/11**（主程序：physicist + 爱弥斯 + Electron 壳）：Node.js ≥ 22.13，Python ≥ 3.10。
- **macOS**（仅课堂模式与习题模式，无桌宠壳、无需 Python）：Node.js ≥ 20。
- DeepSeek API Key（或在 dsh 中配置其他服务商）。

### 快速开始（Windows）

```powershell
# 1) 把仓库 clone 到任意目录（例如 D:\dev）
cd D:\dev
git clone https://github.com/Downfallofthedownfall/Aemeath-DMi-agent.git
cd Aemeath-DMi-agent

# 2) 允许本会话运行本地脚本（只需一次）
Set-ExecutionPolicy -Scope Process Bypass -Force

# 3) 一键安装：根依赖、插件构建、profile 依赖、Python 依赖、Electron 壳
.\setup.bat

# 4) 启动桌宠（Electron 壳：自动托管 dsh + 品牌窗口）
cd app
npm start
```

> `npm start`（app/ 内）是**日常入口**：自动拉起或复用 3081 的 dsh 服务并打开品牌窗口。
> 也可改用浏览器 UI 或其他入口：

```powershell
# 浏览器 UI（替代桌宠壳）
.\scripts\dsh.ps1 --profile aemeath --port 3081   # → http://127.0.0.1:3081

# Übungen 习题模式（独立 app：PDF 进 → 提交 PDF 出）
.\scripts\dsh.ps1 --profile exercise --port 3084  # → http://127.0.0.1:3084

# headless 冒烟测试（无需浏览器）
.\scripts\dsh.ps1 --profile aemeath-run "你好，自我介绍"

# 基准（headless，五项指标）
python packages\benchmark\run_benchmark.py --limit 5

# 记忆管理端点（token 见启动日志）
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:18895/memory/stats
```

> `scripts/dsh.ps1` 固定项目内 `DSH_HOME`（`.dsh-home/`，gitignored），不干扰全局 dsh profile。
> API Key：Web「设置 → API 密钥」填写，或写入 `.dsh-home/.credentials.yaml`，缺省回退环境变量
> `DEEPSEEK_API_KEY`。记忆管理 API 监听 18895 端口。

### 🍎 macOS —— 课堂模式 + 习题模式

mac 上**没有主 agent（设计如此）**，只有两个独立 app，都零 Python：

```bash
cd ~/aemeath-dmi-agent
./lecture-launch.command     # 课堂记录（3083），双击亦可
./exercise-launch.command    # 习题模式（3084）：导入 PDF / 做题 / 提交
```

> 入口脚本自己找 Node（Homebrew / nvm / volta / fnm），首次运行会自动装依赖、构建插件、把
> `profiles/<name>` 链到 `$DSH_HOME`。请用 `.command` 而不是 `.sh`：双击 `.sh` 不读
> `~/.zshrc`，Node 通常不在 `PATH` 里。提交 PDF 需要本机 Chrome/Edge；没有时用「打开打印页」
> → ⌘P → 存储为 PDF。

📖 详细说明：[课堂模式](使用说明-课堂模式-macOS.md) · [习题模式](使用说明-习题模式-macOS.md)
（含启动原理、日常流程、数据位置、配置与故障排查）。

### 项目结构

```
packages/              # dsh 插件 monorepo
  shared/              #   common 插件：人格、OOC 规则层、dsh 适配
  worldbook/           #   知识库、热重载、retrieve_worldbook
  memory/              #   L1/L2/L3 记忆、守门员、时间轴、洞察
  retriever/           #   讲义分块 + SQLite FTS5 BM25
  workflow/            #   解题工作流（SymPy 验证）
  curriculum/          #   Modulhandbuch 摘要 + 检索
  lecture/             #   课堂记录模式（独立 profile）
  exercise/            #   习题模式（独立 profile）
  ui/                  #   前端：主题、设置、记忆工作区
  py-services/         #   Python MCP：sympy / vision / tts / control
  benchmark/           #   Altklausur 基准驱动 + 题库
  library/             #   本地学习内容（gitignored，按需生成）
profiles/              # dsh profile：aemeath（主）、aemeath-run（headless）、lecture、exercise
scripts/               # dsh 包装脚本、构建 / 链接 / 校验工具
app/                   # Electron 桌宠壳
electron-app/          # v1（冻结，仅保留壳参考）
```

### Lecture Mode（课堂记录模式）

一个独立的课堂记录拓展 app。**刻意不接进主 agent 的记忆管线**——课堂数据留在自己的文件存储里，
只有**课程进度 / 用户短板**在**五步人工复盘**之后才交给主 agent。

| 方面 | 设计 |
|---|---|
| 课堂内 | 标记语法（`#` 主题 / `=` 公式 / `?` 疑问 / `!` 重点 / `>` 例子 / `---` 分块）+ 强制留白 `[我的理解]` / `[我的疑问]`——AI 不代笔，你没说它会问 |
| LLM 加工 | 后台运行，**只落后端**——绝不显示在界面上（保护主动回忆） |
| 课后 | 五步状态机；第 3 步是苏格拉底式引导，不直接给答案 |
| 摘要 | **只在第 4 步之后**生成（`canGenerateSummary()` 是唯一门控） |
| 存储 | `packages/library/physicist/lectures/` 下的纯 markdown + JSON 索引，retriever 可直接消费 |
| 平台 | **macOS 可用且零 Python**（不需要 TTS / vision / control / sympy） |
| 工具 | `lecture_session_start` / `lecture_capture` / `lecture_status` / `lecture_review_start` / `lecture_review_submit` / `lecture_review_next` / `lecture_export_handoff` |

> 安装与实现说明：[`packages/lecture/dsh-plugin-lecture/README.md`](packages/lecture/dsh-plugin-lecture/README.md)。
> macOS 配置与使用：[`使用说明-课堂模式-macOS.md`](使用说明-课堂模式-macOS.md)。

### Übungen（习题模式）

一个给「每周一张 Übungsblatt」用的工作台。**它的全部意义在于对你诚实**：答案是你自己写的，
模型只许说*哪一步不成立*，**绝不许**把解法给你。

| 方面 | 设计 |
|---|---|
| 导入 | 把作业 PDF 拖进来 → 每页渲染成截图，由**多模态模型看图**逐题转录（公式 LaTeX、插图、分值、页码；跨页续文按题号并回父题）。文本抽取、锚点切分、规则切分仍是后备链，任何一环失败都不挡导入。页面截图即「原题截图」；重切时**按题号保留答案** |
| 做题 | 答案编辑器**边写边渲染 LaTeX**（分栏 / 只写 / 只看渲染，滚动同步），自动保存（900ms / 失焦），**永远可改**；符号面板把原始 LaTeX 插到光标处。改动会把旧检查标 `stale`，不删除历史 |
| 检查 | **只能手动**（按钮 / `exercise_check`）：结论 + 哪一步错 + 苏格拉底式提问 + 下一步验证什么。有页面截图时走**多模态**。走**全局 dsh LLM**——与主 agent 同一个 provider、模型和凭据，无需单独配 key。输出被截断时会抢救解析；解析失败记为 `error`，**绝不**记成「你答错了」 |
| 错题 | 跨套题错题本（`_mistakes.json`），每条带你自己写的一句话教训；`mastered` 可切换；检查判 `wrong` / `partial` 时自动收录 |
| 知识 | 教训与错题写成 physicist 馆的世界书条目（`generated_exercise.json`），热重载 ≤3s |
| 提交 | 解答页（服务端 KaTeX 渲染 + 字体内联）用 `pdf-lib` 与原卷合并成**一份 PDF** 交给 Übungsbetrieb；内部 verdict 在打印时隐藏 |
| 握手 | **直接借用 lecture 的 handoff**：schema 继承、同一个写入器；方向单向，接收侧必过守门员（缺省 `dry_run`） |
| 其他 | 极简模式（书上题目：粘贴文字或上传截图/PDF）、附图（随检查一起发给模型并印进提交 PDF）、答辩（模型须重新独立推导，认错撤回或给出证据坚持）、思路检查（做到一半手动点：只挑明显走歪的地方，不给解法，结果临时、手动清除）、答辩折叠（默认只有一行摘要）、跨页题目（两页原图一起看）、确定性 markdown 导出、每套新题附进度摘要 |

```powershell
.\scripts\dsh.ps1 --profile exercise --port 3084   # 独立习题工作台
```

> 工具：`exercise_list` / `exercise_new_sheet` / `exercise_open` / `exercise_problem` /
> `exercise_save_answer` / `exercise_resplit` / `exercise_check` / `exercise_scratch` /
> `exercise_attach_image` / `exercise_rebut` / `exercise_collect_mistake` / `exercise_lessons` /
> `exercise_export_text` / `exercise_sync_worldbook` / `exercise_build_submission` /
> `exercise_progress` / `exercise_export_handoff` / `exercise_import_handoff`。
> macOS 配置与使用：[`使用说明-习题模式-macOS.md`](使用说明-习题模式-macOS.md)。

### 技术栈

| 技术 | 用途 |
|---|---|
| **DeepSeek Harness（dsh）0.2.1-rc.2** | agent loop、工具流水线、会话事件溯源、审批、插件体系（引擎本体） |
| DeepSeek API | 对话模型（`deepseek-v4-flash`） |
| TypeScript + Cordis | dsh 插件 monorepo（`packages/`） |
| Python MCP 服务 | SymPy 计算 / YOLO-OCR 视觉 / IndexTTS2 语音 / 键鼠控制，经 dsh `mcp-client` 接入（`packages/py-services/`） |
| SQLite FTS5 | 讲义检索（BM25） |
| Electron 43 | 桌宠壳（托管 dsh + 品牌窗口，electron-builder 打包） |
| i18n（中/英） | UI 文案走 dsh locale 服务（`packages/ui/dsh-plugin-ui/src/client/`）；人格按 locale 选文件（`profiles/aemeath/personas/*.en.md`） |

### 本地化（i18n）

- **UI**：所有用户可见文案集中在 `packages/ui/dsh-plugin-ui/src/client/locales.ts`（zh 为 key 源，
  en 由 TS 类型强制 key 集一致）。组件用 `t(key)` / `useLocale()`；语言在「设置 → 语言」切换
  （缺省跟随浏览器）。仅中文与英文。
- **人格**：`common` 插件在 `settings.locale.preference` 为 en 时加载 `personas/<名字>.en.md`，
  缺省回退中文文件。
- **明确不翻**（按产品决策）：基准题集、后端/LLM 侧工具描述与 prompt、debug 日志、文档。

### 数据位置

- `.dsh-home/` —— 凭据、会话、存储与链接的 profile；项目内且 gitignored，`scripts/dsh.ps1`
  不会碰你的全局 dsh profile。
- `packages/library/` —— 讲义、作业、错题本与文本导出；gitignored，学习内容与 harness 分开管理。
- `packages/worldbook/data/` —— 随仓库分发的知识库。

所有处理都在本机完成，只有模型请求（以及可选联网搜索）会离开本机。

### 测试

每个插件自带测试。在仓库根目录：

```bash
npm run verify                                    # workspace 链接 + 壳可移植性校验
npm test -w @aemeath/dsh-plugin-common            # 另有 worldbook / memory / retriever /
                                                  # workflow / curriculum / lecture /
                                                  # exercise / ui
```

---

## ⚠️ 免责声明 / Disclaimer

本项目为粉丝同人作品，角色「爱弥斯」「星炬」及其世界观出自游戏《鸣潮》（Kuro Games 库洛游戏）。本项目与 Kuro Games 无任何关联，未获其官方授权；仅供学习交流使用，**禁止商用**；角色美术、语音等素材版权归原作者/版权方所有；如涉及侵权，请联系删除相关内容。第三方组件、模型权重与许可证清单见 [Third_Party_Notices.md](Third_Party_Notices.md)（含 YOLOv8 AGPL-3.0 与 IndexTTS2 模型非商用协议提示）。

*This is a fan-made project. The characters "Aemeath" and "Stellar Torch" and their world belong to the game Wuthering Waves (Kuro Games). This project is not affiliated with or endorsed by Kuro Games. For learning purposes only — **no commercial use**; character art/voice assets belong to their respective owners; contact us to remove any infringing content. Third-party components, model weights and licenses are listed in [Third_Party_Notices.md](Third_Party_Notices.md) (including AGPL-3.0 notice for YOLOv8 and the non-commercial IndexTTS2 model license).*

## 📄 许可证 / License

MIT License (code). See [LICENSE](LICENSE) and [Third_Party_Notices.md](Third_Party_Notices.md).
