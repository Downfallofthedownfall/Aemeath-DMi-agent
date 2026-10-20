# 🤖 Aemeath-DMi Agent v2 · physicist · 物理学习 Copilot

> **定位 / Positioning**: A physics-study Copilot trained on real lecture notes, past Altklausur exams, and weekly usage logs from Universität Hamburg's Physik I / Math I — plus a companion desktop pet (爱弥斯 / Aemeath) as the attention gateway. One engine, two skins.
>
> **架构 / Architecture**: v2 is rebuilt on the DeepSeek Harness (dsh) plugin system. **The platform is just the engine — the moat is the physics content track**: Worldbook knowledge base, exam benchmark, weekly usage log (see [docs/usage-log.md](docs/usage-log.md) and migration plan `docs/v2-migration-plan.md`).
>
> **状态 / Status**: M0–M6 engine + M5 frontend delivered; curriculum (Modulhandbuch) plugin, i18n (en), multi-model ports (openai responses/completions + anthropic messages) added; security hardening done; memory/persona enhanced (borrowing Cyrene ideas: typed conflict, write-gate, DMAE activation lifecycle, mood/relationship cue, live-role + stable/dynamic persona; borrowing ripples-of-aion ideas: fact timeline with valid_from/valid_until, evolution-vs-conflict, autoDream idle consolidation into a separate insights store, canonical attribute normalization, recall write throttle, LLM salvage parsing); frontend enhanced (Cyrene borrow: tabbed settings+appearance, status pill, mode chips, tiered memory panel, floating plan todo card, in-composer cards); TTS upgraded to IndexTTS-2.5; **Lecture Mode (class-note capture) P0–P4 complete — standalone macOS-capable profile, zero Python, full-screen UI with a 250-symbol math palette, gatekeeper-checked handoff importer**; **Übungen (exercise mode) done 2026-10 — PDF homework import → manual LLM check → editable answers → mistake book + worldbook → merged submission PDF (KaTeX-rendered), zero Python on mac**; 689 unit-test assertions green (30 files).

---

## 🌍 English

### What is this?

A local-first desktop AI with **two strictly isolated characters**:

| Character | Role | Personality |
|---|---|---|
| **physicist** | Physics-study Copilot | Solves with reasoning first, verifies with SymPy, cites sources (Worldbook id / lecture chapter), and **honestly admits when it doesn't know** — it never pretends. |
| **Aemeath (爱弥斯)** | Companion desktop pet | Emotional companion persona. Personality and knowledge are fully separated from physicist by agent isolation. |

Built on [DeepSeek Harness](https://github.com/deepseek-ai) (dsh `0.2.0-rc.2`) as a TypeScript plugin monorepo — the engine stays vanilla dsh; all domain capability (knowledge / memory / retrieval / solving workflow / class-note capture / UI) lives in self-written plugins.

### Features

| Capability | Status | Notes |
|---|---|---|
| Dual-role dual-agent isolation (physicist / Aemeath) | ✅ M0 | dsh persona mechanism, per-agent isolation |
| OOC rule layer (out-of-character correction) | ✅ M0 | Regex pre-step interception (LLM judge layer: M6, off by default) |
| Smoke tool `aemeath/version` | ✅ M0 | Tool registration + session log verification |
| Worldbook physics knowledge base (59+8 entries) | ✅ M2 | Physik I + Math I entries, dual-library isolation, hot reload, `retrieve_worldbook` tool |
| Layered memory L1/L2/L3 + gatekeeper (Cyrene-inspired) | ✅ 2026-08 | Rule-first + LLM judge, BM25 dedup, typed conflict (preference_evolution / direct_conflict), user-fact write-gate, activation-scored 3-state lifecycle (Active/Dormant/Archived), mood observer + relationship cue, HTTP admin endpoint |
| Fact timeline + idle consolidation (ripples-of-aion-inspired) | ✅ 2026-09 | `entityClaims` with valid_from/valid_until intervals → answers "what was true *then*"; attribute-change is evolution, not conflict; autoDream idle consolidation into a separate insights store (topic clusters + suspected conflicts, recordIds only, never rewrites memories); canonical attribute normalization; recall write throttle + asymptotic saturation; LLM output salvage parsing; claims produced inside the existing summarizer call (no extra LLM calls) |
| Memory workspace (5 pages, ripples panel IA) | ✅ 2026-09 | Full-screen layer on the host's `shell.overlay` seat (opened from the sidebar quick settings): Memories (three-column browse + collapsible entity-attribute timeline) / Graph (entity co-occurrence force layout) / Console (read-only retrieval debug) / Insights (autoDream clusters + suspected conflicts + "dream now") / Status. Design language borrowed from the reference panel (soft pink, 14px cards) but theme-aware; data via the `/aemeath/api/memory` proxy |
| Lecture retrieval + Altklausur benchmark | ✅ M4 | SQLite FTS5 BM25 (Chinese bigram), 6 metrics, headless runner |
| Solving workflow (SymPy verification) | ✅ M6 | Plan → execute → ✅/❌ verify → conclusion + source; honest degradation on tool failure |
| Frontend overhaul + desktop shell | ✅ M5→2026-08 | Forced light theme, brand layer, hero + role cards, quick settings, workspace picker, memory panel, TTS button, Electron shell; Cyrene-borrowed: tabbed settings + appearance, character status pill, mode-switch chips, tiered memory panel, floating plan todo card, in-composer interaction cards; TTS IndexTTS-2.5 |
| i18n (zh/en) | ✅ 2026-08 | UI strings via locale service; personas per locale (`*.en.md`) |
| Curriculum plugin (Modulhandbuch) | ✅ 2026-08 | Semester module summary injection + `curriculum_query` tool, WiSe/SoSe detection, gatekeeper link |
| **Lecture Mode (class-note capture)** | ✅ P0–P4 done, 2026-10 | Standalone profile with its own **three-column workbench** (courses / notes / symbols+review), filling the viewport — not a skin over the main shell. In-class shorthand is typed **in the conversation**; the backend LLM normalizes formulas and **never shows the result** (protects active recall) → 5-step manual review (recall-first, Socratic, no direct answers) → summary only after step 4 → one-way handoff of progress/weak points. **250-symbol math palette** (12 groups, 30 slot-templates with Tab-navigation) pinned in the right column, copying to the clipboard. The `[我的理解]` / `[我的疑问]` blanks are **user-owned**: the model asks instead of writing them. Create/delete courses and lectures from the UI. **macOS-capable with zero Python**; own file store, deliberately isolated from the memory pipeline. |
| **Übungen (exercise mode)** | ✅ 2026-10 | Import a weekly Übungsblatt PDF → problems split automatically → **you** write the answer (always editable, autosaved) → **manual** LLM check (never automatic, never hands you the solution) → wrong answers into a cross-sheet mistake book + `generated_exercise.json` in the physicist worldbook (hot-reloaded) → one merged submission PDF (original sheet + KaTeX-rendered solutions, via local Chrome/Edge) → lecture-compatible handoff back to the main agent. Every new sheet carries a **learning-progress digest** (last unfinished sheet, unmastered mistakes, lecture progress). Zero Python, macOS-capable, port 3084. Tools: 14 × `exercise_*`. |
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

# Übungen — exercise workbench as its own app (PDF in, submission PDF out)
.\scripts\dsh.ps1 --profile exercise --port 3084  # → http://127.0.0.1:3084

# Headless smoke test (no browser)
.\scripts\dsh.ps1 --profile aemeath-run "Hi, introduce yourself"

# Benchmark (headless, six metrics)
python packages\benchmark\run_benchmark.py --limit 5

# Memory admin endpoint (token is printed in the startup log)
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:18895/memory/stats
```

### 🍎 macOS — Lecture Mode + Übungen

**There is no main agent on macOS, by design.** The physics Copilot (memory,
persona, retriever, Electron shell) is Windows-only. On a Mac you run the two
standalone apps — **Lecture Mode** and **Übungen (exercise mode)** — both fully
standalone and zero-Python.

```bash
cd ~/aemeath-dmi-agent
./lecture-launch.command        # class notes (port 3083) — double-click works too
./exercise-launch.command       # homework: import PDF, solve, submit (port 3084)
```

> Both launchers find Node themselves (Homebrew / nvm / volta / fnm and the
> `.command`-vs-`.sh` trap are handled — see
> [docs/lecture-frontend-pitfalls.md](docs/lecture-frontend-pitfalls.md)), and
> both rebuild `lib/` when a source file is newer than the bundle.

📖 **Full guides:**
[使用说明-课堂模式-macOS.md](使用说明-课堂模式-macOS.md) (class notes) ·
[使用说明-习题模式-macOS.md](使用说明-习题模式-macOS.md) (homework: import → solve → submit)
Both cover startup (and why you must use `.command`, not `.sh`), macOS's missing
Node in PATH, the daily workflow, where data lives, configuration, and troubleshooting.

Equivalent manual install steps (bash):

```bash
npm install --legacy-peer-deps --cache .npm-cache
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
| **DeepSeek Harness (dsh) 0.2.0-rc.2** | Agent loop, tool pipeline, session event sourcing, approval, plugin system (the engine) |
| DeepSeek API | Chat model (deepseek-v4-flash) |
| TypeScript (plugins) · Cordis | dsh plugin monorepo (`packages/`) |
| Python microservices (MCP) | SymPy compute / YOLO-OCR vision / IndexTTS-2.5 TTS / keyboard-mouse control, wired via dsh `mcp-client` (`packages/py-services/`) |
| SQLite FTS5 | Lecture retrieval (BM25) |
| Curriculum plugin | Modulhandbuch course catalog → semester summary injection + module query (`packages/curriculum/`) |
| Electron (41) | Desktop pet shell (managed dsh + branded window, packaging via electron-builder) |
| **i18n (zh/en)** | UI strings via dsh locale service (`packages/ui/dsh-plugin-ui/src/client/i18n.ts` + `locales.ts`); personas per locale (`profiles/aemeath/personas/*.en.md`) |

### Localization (i18n)

- **UI**: all user-visible strings live in `packages/ui/dsh-plugin-ui/src/client/locales.ts` (zh = key source, en checked complete by TS). Components call `t(key)` / `useLocale()` from `i18n.ts`; language is switchable in **Settings → Language** (browser default applies otherwise). Chinese and English only.
- **Personas**: `common` plugin picks `personas/<name>.en.md` when `settings.locale.preference` is `en`, falling back to the default Chinese file.
- **Out of scope** (by design): benchmark sets, backend/LLM-facing tool descriptions & prompts, debug logs, docs.

### Project structure

```
packages/            # v2 plugin monorepo (common/worldbook/memory/retriever/workflow/curriculum/lecture/benchmark/py-services/ui)
packages/lecture     # Lecture Mode: in-class capture → backend-only processing → 5-step post-lecture review (standalone profile, macOS-capable, zero Python)
packages/exercise    # Übungen: PDF homework import → editable answers → manual LLM check → mistake book + worldbook → merged submission PDF (port 3084, macOS-capable, zero Python)
packages/py-services # v1 Python microservices → MCP servers (sympy/vision/tts/control, zero-dep mcp_core)
profiles/            # dsh profiles (aemeath = Web main, aemeath-run = one-shot/benchmark, lecture = class mode)
scripts/dsh.ps1      # dsh wrapper (project-local DSH_HOME + cwd + preset sync)
docs/                # migration plan + usage log + handover + project report (gitignored)
app/                 # Electron desktop shell (hosts dsh + branded window)
electron-app/        # v1 (frozen, tag v1.0; migrated files removed, shell reference only)
```

### Lecture Mode (class-note capture)

A standalone extension app for taking notes during lectures. **Deliberately not wired into
the main agent's memory pipeline** — classroom data stays in its own file store, and only
course progress / weak points are handed over to the main agent after a **5-step manual
review** (you-recall-first → compare → targeted repair → candidates → confirm).

| Aspect | Design |
|---|---|
| In class | shorthand markers (`#` topic / `=` formula / `?` question / `!` keypoint / `>` example / `---` split) + **mandatory blanks** `[我的理解]` / `[我的疑问]` |
| LLM processing | runs in background, **stored backend-only** — never shown in the UI (protects active recall) |
| Post-lecture | 5-step state machine; step 3 is Socratic (**never gives the answer**) |
| Summary | generated **only** after step 4 (`canGenerateSummary()` is the single gate) |
| Storage | plain markdown + JSON index under `packages/library/physicist/lectures/` — directly consumable by the retriever |
| Platform | runs on **macOS with zero Python** (no TTS/vision/control/sympy needed) |
| Tools | `lecture_session_start` / `lecture_capture` / `lecture_status` / `lecture_review_start` / `lecture_review_submit` / `lecture_review_next` / `lecture_export_handoff` |

```powershell
.\node_modules\.bin\dsh.cmd --profile lecture "开始课堂记录"
```

> See [`packages/lecture/dsh-plugin-lecture/README.md`](packages/lecture/dsh-plugin-lecture/README.md)
> for setup, and [`docs/lecture-mode-plan.md`](docs/lecture-mode-plan.md) for the full design rationale.

### Übungen (exercise mode)

A companion workbench for the weekly problem sheets. **Its whole point is honesty about
what you can do**: you write the answer yourself, and the model is only allowed to say
*where* it breaks — never to hand you the solution.

| Aspect | Design |
|---|---|
| Import | Drop the sheet PDF in → every page is **rasterised to an image** (pdfjs + canvas, 144 dpi) → a **multimodal model reads the pages** and transcribes each problem (LaTeX formulas, figure flags, points, page; cross-page continuations merged by label). Text extraction stays as fallback ①, a verbatim-anchor splitter as ②, regex as ③ — the chain never blocks an import. Page screenshots are kept as `pages/page-NN.jpg` and shown in the UI as **"original page"**; the left rail re-splits with the same chain and preserves answers by problem number |
| Solving | Answer editor renders LaTeX **side by side as you type** (split / write-only / render-only, synced scroll), autosave (900 ms / on blur), **always editable**; the symbol palette is copied wholesale from lecture (search / collapsible groups / counts / recent group), inserts at the caret of the focused editor — `\placeholder{}` templates are converted to real LaTeX `{}` — with copy fallback kept; changing the answer marks older checks `stale` instead of deleting them |
| Check | **Manual only** (button / `exercise_check`). Returns verdict + which step is wrong + Socratic hints + "what to verify next". When page screenshots exist the check is **multimodal** (original page image + your answer), so figures and OCR-mangled formulas are judged from the picture. Runs on the **global dsh LLM** — same provider, model and credentials as the main agent (no separate API key/model to configure). Truncated model output is repair-parsed, and a parse failure is recorded as `error` — never as "your answer is wrong" |
| Mistakes | Cross-sheet mistake book (`_mistakes.json`) with your one-line lesson per entry; `mastered` toggles; auto-filled when a check says `wrong`/`partial` |
| Knowledge | Lessons/mistakes become worldbook entries in the physicist library (`generated_exercise.json`), hot-reloaded ≤3 s — so the Copilot can say "you fell for this before" |
| Handoff | **Reuses lecture's handoff**: schema extends `handoffSchema`, same `writeHandoff`; direction is one-way, received with the gatekeeper (`dry_run` by default) |
| Submission | Solutions page (KaTeX rendered server-side, fonts inlined) merged with the original sheet via `pdf-lib` → **one PDF** for the Übungsbetrieb; internal verdicts are print-hidden |
| Progress | Every new sheet gets a `progress_digest`: last unfinished sheet, answered/checked counts, unmastered top topics, lecture review progress |

```powershell
.\scripts\dsh.ps1 --profile exercise --port 3084   # standalone workbench
```

> Tools: `exercise_list` / `exercise_new_sheet` / `exercise_open` / `exercise_problem` /
> `exercise_save_answer` / `exercise_resplit` / `exercise_check` / `exercise_collect_mistake` / `exercise_lessons` /
> `exercise_sync_worldbook` / `exercise_build_submission` / `exercise_progress` /
> `exercise_export_handoff` / `exercise_import_handoff`.
> Full design + verification log: [`docs/exercise-mode-plan.md`](docs/exercise-mode-plan.md).
> macOS setup walkthrough: [`使用说明-习题模式-macOS.md`](使用说明-习题模式-macOS.md).

### Testing

```bash
npm test -w @aemeath/dsh-plugin-common       # 15 (OOC rule layer + persona craft/runtime/execution)
npm test -w @aemeath/dsh-plugin-worldbook    # 10 (trigger/order/chain/token budget)
npm test -w @aemeath/dsh-plugin-memory       # 193 assertions (gatekeeper/BM25-conflict/engine/L1 buffer + write-gate/typed-conflict/mood/relationship/DMAE-activation + fact-timeline/evolution-vs-conflict/autoDream consolidation/recall-throttle + real-plugin e2e)
npm test -w @aemeath/dsh-plugin-retriever    # 4  (chunker)
npm test -w @aemeath/dsh-plugin-workflow     # 13 (routing/plan scratch + dimensions)
npm test -w @aemeath/dsh-plugin-curriculum   # 9  (parse/semester/search/summary/detail)
npm test -w @aemeath/dsh-plugin-lecture      # 282 (markers/storage/traversal-guard/BOM + transcriber/5-step-review/D4-gate/D12-guard/notation + tool-chain regression + math-symbol palette + P3 no-leak contract + P4 handoff importer + workbench/standalone-mode/delete/create-course/stale-detection regression)
npm test -w @aemeath/dsh-plugin-exercise     # 216 (types+digest / PDF text extraction + problem split / LLM anchor segmentation / multimodal vision segmentation / file store / submission HTML / lecture-compatible handoff + worldbook / manual-check parsing (incl. loose JSON) + HTTP routing)
npm test -w @aemeath/dsh-plugin-ui           # 12 (memory workspace proxy views: list/timeline/graph)
# Total: 754 unit-test assertions (all green, 31 files — measured 2026-10-20)
# (lecture 282 + memory 193 + exercise 166 + common 15 + ui 12 + workflow 13 + worldbook 10 + curriculum 9 + retriever 4)
```

### Roadmap (next)

1. **Lecture Mode on real hardware**: verify the macOS path on an actual M2 and run the cross-machine handoff (mac → LAN → Windows). Code and Windows-side verification are done; these two need the physical machines.
2. Frontend polish: P4 inline tool UIs, P5 shell light-theme polish; memory workspace follow-ups (retrieval-console source badges, inline memory edit).
3. Content track: real lecture notes + Altklausur exams + complete Modulhandbuch → full 6-metric benchmark.
4. M6 v2 / M3 leftovers: codeMode enablement, knowledge-layer → retriever bridge, v1 memory.db migration run-through.
5. Memory follow-ups (ripples-of-aion P3 track, see `docs/RIPPLES_OF_AION_ADOPTION.md` §13): entity-weighted retrieval, memory graph refinements, retrieval debug view badges.

---

## 🇨🇳 中文

### 这是什么？

一个**本地优先的桌面 AI**，两个**严格隔离的角色**：

| 角色 | 定位 | 人格 |
|---|---|---|
| **physicist** | 物理学习 Copilot | 先讲原理再给结论；计算必过 SymPy 验证；回答带来源（Worldbook id / 讲义章节）；**不会就诚实承认**，绝不编造。 |
| **爱弥斯** | 情感陪伴桌宠 | 陪伴型人格；与 physicist 通过 agent 隔离彻底分开，人格与知识互不串扰。 |

基于 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh `0.2.0-rc.2`）的 TypeScript 插件 monorepo 构建——引擎保持原版 dsh，所有领域能力（知识/记忆/检索/解题流/课堂记录/前端）都是自研插件。

### 能力清单

| 能力 | 状态 | 说明 |
|---|---|---|
| 双角色（physicist/爱弥斯）双 agent 隔离 | ✅ M0 | dsh persona 机制，人格按 agent 隔离 |
| OOC 规则层（越界纠偏） | ✅ M0 | pre-step 正则拦截（LLM 判定层：M6，默认关） |
| 冒烟工具 aemeath/version | ✅ M0 | 工具注册 + 会话日志验证 |
| Worldbook 物理知识库（59+8 条） | ✅ M2 | Physik I + Math I 双馆隔离、热重载、retrieve_worldbook 工具 |
| 分层记忆 L1/L2/L3 + 守门员（借 Cyrene 思想） | ✅ 2026-08 | 规则层优先 + LLM 判定，BM25 查重、typed 冲突（偏好演化/直接冲突）、用户事实写入门禁、激活分三态生命周期（Active/Dormant/Archived）、情绪观察器 + 关系线索、HTTP 管理端点 |
| 事实时间轴 + 空闲整合（借 ripples-of-aion 思想） | ✅ 2026-09 | `entityClaims` 带 valid_from/valid_until 区间 → 能回答「**当时**是什么」；属性取值变化=演进不是矛盾；autoDream 空闲整合进独立洞察存储（主题簇 + 疑似矛盾，只存 recordIds，绝不改写原记忆）；属性名归一化；召回回写节流 + 渐近饱和；LLM 输出抢救解析 |
| 讲义检索 + Altklausur 基准 | ✅ M4 | SQLite FTS5 BM25（中文 bigram），六指标，headless 驱动 |
| 解题工作流（SymPy 验证） | ✅ M6 | 计划→执行→✅/❌ 验证标记→结论+来源；工具故障诚实降级 |
| 前端改造 + 桌宠壳 | ✅ M5→2026-08 | 强制亮色、品牌层、hero + 角色卡、快速设置、工作区选择、记忆面板、TTS 按钮、Electron 壳；借 Cyrene：设置分区+外观、角色状态 pill、模式切换 chips、分层记忆面板、悬浮计划待办卡、输入框交互卡；TTS 升级 IndexTTS-2.5 |
| i18n（中/英） | ✅ 2026-08 | UI 文案走 locale 服务；人格按 locale 加载（`*.en.md`） |
| curriculum 课程插件（Modulhandbuch） | ✅ 2026-08 | 学期模块摘要常驻注入 + curriculum_query 工具，WiSe/SoSe 学期判断，gatekeeper 联动 |
| **Lecture Mode 课堂记录模式** | ✅ P0–P4 已完成，2026-10 | 独立 profile：课堂速记采集 → **只落后端**的 LLM 加工（不回显，保护主动回忆）→ 五步人工复盘（你先说 / 苏格拉底式引导 / 不直接给答案）→ 第 4 步后才生成摘要 → 单向握手进度与短板。**全屏界面**（`shell.overlay`）+ **250 符号数学边栏**（30 个带插槽模板，Tab 跳转）；握手接收侧**过守门员**。**macOS 可用且零 Python**；自带文件存储，刻意与记忆管线隔离。 |
| **Übungen 习题模式** | ✅ 2026-10 | 导入每周 Übungsblatt PDF → 自动拆题 → **自己写答案**（永远可改、自动保存）→ **手动**触发 LLM 检查（绝不自动、不给完整答案）→ 错题进跨套题错题本 + physicist 馆 `generated_exercise.json`（热重载 ≤3s）→ 原卷 + KaTeX 渲染解答合并成**一份提交 PDF**（本机 Chrome/Edge 打印）→ 与 lecture 同形的握手回主 agent。每开一套新题自动附**学习进度摘要**（上次没做完哪套 / 未掌握错题 / 课堂复盘进度）。零 Python、macOS 可用、端口 3084，14 个 `exercise_*` 工具。 |
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

# Übungen 习题模式（独立 app：PDF 进 → 提交 PDF 出）
.\scripts\dsh.ps1 --profile exercise --port 3084  # → http://127.0.0.1:3084

# headless 冒烟测试（无需浏览器）
.\scripts\dsh.ps1 --profile aemeath-run "你好，自我介绍"

# 基准（headless，六指标）
python packages\benchmark\run_benchmark.py --limit 5

# 记忆管理端点（token 见启动日志）
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:18895/memory/stats
```

等价手动安装步骤（bash）：

```bash
npm install --legacy-peer-deps --cache .npm-cache
npm run build
cd profiles\aemeath && npm install --legacy-peer-deps --cache ..\..\.npm-cache && cd ..\..
cd profiles\aemeath-run && npm install --legacy-peer-deps --cache ..\..\.npm-cache && cd ..\..
pip install -r requirements.txt
cd app && npm install
```

> `scripts/dsh.ps1` 固定项目内 DSH_HOME（`.dsh-home/`，gitignored），不干扰全局 web profile。API Key：Web「设置 → API 密钥」填写，或写入 `.dsh-home/.credentials.yaml`，缺省回退环境变量 `DEEPSEEK_API_KEY`。

### 🍎 macOS

mac 上**没有主 agent（设计如此）**，只有两个独立 app，都零 Python：

```bash
cd ~/aemeath-dmi-agent
./lecture-launch.command     # 课堂记录（3083）
./exercise-launch.command    # 习题模式（3084）：导入 PDF / 做题 / 提交
```

- 入口脚本自己找 Node（Homebrew / nvm / volta / fnm），并处理 macOS 的
  「双击 `.sh` 不读 `~/.zshrc`」坑 —— 所以**用 `.command`，不要双击 `.sh`**
- 首次运行自动：装依赖 → 构建 → 把 `profiles/<name>` 链到 `$DSH_HOME/profiles/`
  → 逐包链 `@aemeath/*` 与 `@deepseek-ai`（两套模块实例会让工具调度器报错）
- 提交 PDF 需要本机 Chrome/Edge；没有时用「打开打印页」→ ⌘P → 存储为 PDF
- API Key：界面左下「设置 → Models」，或写 `$DSH_HOME/.credentials.yaml`

📖 详细说明：[课堂模式](使用说明-课堂模式-macOS.md) · [习题模式](使用说明-习题模式-macOS.md)

### 技术栈

| 技术 | 用途 |
|---|---|
| **DeepSeek Harness（dsh）0.2.0-rc.2** | agent loop、工具流水线、会话事件溯源、审批、插件体系（引擎） |
| DeepSeek API | 对话模型（deepseek-v4-flash） |
| TypeScript（插件）· Cordis | dsh 插件 monorepo（`packages/`） |
| Python 微服务（MCP） | SymPy 计算 / YOLO-OCR 视觉 / IndexTTS-2.5 语音 / 键鼠控制，经 dsh `mcp-client` 接入（`packages/py-services/`） |
| SQLite FTS5 | 讲义检索（BM25） |
| curriculum 插件 | Modulhandbuch 课程目录 → 学期摘要注入 + 模块检索（`packages/curriculum/`） |
| Electron（41） | 桌宠壳（托管 dsh + 品牌窗口，electron-builder 打包） |
| **i18n（中/英）** | UI 文案走 dsh locale 服务（`packages/ui/dsh-plugin-ui/src/client/i18n.ts` + `locales.ts`）；人格按 locale 选文件（`profiles/aemeath/personas/*.en.md`） |

### 本地化（i18n）

- **UI**：所有用户可见文案集中在 `packages/ui/dsh-plugin-ui/src/client/locales.ts`（zh 为 key 源，en 由 TS 类型强制 key 集一致）。组件用 `i18n.ts` 的 `t(key)` / `useLocale()`；语言在「设置 → 语言」切换（缺省跟随浏览器）。仅中文与英文。
- **人格**：`common` 插件在 `settings.locale.preference` 为 en 时加载 `personas/<名字>.en.md`，缺省回退中文文件。
- **明确不翻**（按产品决策）：基准题集、后端/LLM 侧工具描述与 prompt、debug 日志、文档。

### 项目结构

```
packages/            # v2 插件 monorepo（common/worldbook/memory/retriever/workflow/curriculum/lecture/benchmark/py-services/ui）
packages/lecture     # Lecture Mode：课堂采集 → 只落后端的加工 → 五步课后复盘（独立 profile，macOS 可用，零 Python）
packages/exercise    # Übungen 习题模式：PDF 作业导入 → 可编辑答案 → 手动 LLM 检查 → 错题本 + worldbook → 合并提交 PDF（端口 3084，macOS 可用，零 Python）
packages/py-services # v1 Python 微服务 → MCP server（sympy/vision/tts/control，mcp_core 零依赖）
profiles/            # dsh profile（aemeath=Web 主 profile，aemeath-run=一次性/基准，lecture=课堂模式）
scripts/dsh.ps1      # dsh 包装脚本（项目内 DSH_HOME + cwd + preset 同步）
docs/                # 迁移计划 + 使用日志 + 交接 + 项目报告（gitignored）
app/                 # Electron 桌宠壳（托管 dsh + 品牌窗口）
electron-app/        # v1（冻结，tag v1.0；已迁移文件删除，仅留壳参考）
```

### Lecture Mode（课堂记录模式）

一个独立的课堂记录拓展 app。**刻意不接进主 agent 的记忆管线**——课堂数据留在自己的文件存储里，
只有**课程进度 / 用户短板**在**五步人工复盘**之后才交给主 agent
（你先说 → 对照 → 定点补漏 → 候选条目 → 确认写入）。

| 方面 | 设计 |
|---|---|
| 课堂内 | 标记语法（`#` 主题 / `=` 公式 / `?` 疑问 / `!` 重点 / `>` 例子 / `---` 分块）+ **强制留白** `[我的理解]` / `[我的疑问]` |
| LLM 加工 | 后台运行，**只落后端**——绝不显示在界面上（保护主动回忆） |
| 课后 | 五步状态机；第 3 步是苏格拉底式引导（**不直接给答案**） |
| 摘要 | **只在第 4 步之后**生成（`canGenerateSummary()` 是唯一门控） |
| 存储 | `packages/library/physicist/lectures/` 下的纯 markdown + JSON 索引——retriever 可直接消费 |
| 平台 | **macOS 可用且零 Python**（不需要 TTS / vision / control / sympy） |
| 工具 | `lecture_session_start` / `lecture_capture` / `lecture_status` / `lecture_review_start` / `lecture_review_submit` / `lecture_review_next` / `lecture_export_handoff` |

```powershell
.\node_modules\.bin\dsh.cmd --profile lecture "开始课堂记录"
```

> 安装见 [`packages/lecture/dsh-plugin-lecture/README.md`](packages/lecture/dsh-plugin-lecture/README.md)；
> 完整设计论证见 [`docs/lecture-mode-plan.md`](docs/lecture-mode-plan.md)。

### Übungen（习题模式）

一个给"每周一张 Übungsblatt"用的工作台。**它的全部意义在于对你诚实**：
答案是你自己写的，模型只许说*哪一步不成立*，**绝不许**把解法给你。

| 方面 | 设计 |
|---|---|
| 导入 | 把作业 PDF 拖进来 → 每页**渲染成截图**（pdfjs + canvas，144dpi）→ **多模态模型看图**逐题转录（公式 LaTeX、插图标记、分值、页码；跨页续文按题号并回父题）。文本抽取是后备①、逐字锚点切分②、规则③ —— 任何一环失败都不挡导入。页面截图存 `pages/page-NN.jpg`，界面里就是**「原题截图」**；左栏重切走同一条链，**按题号保留答案** |
| 做题 | 答案编辑器**边写边渲染 LaTeX**（分栏 / 只写 / 只看渲染，滚动同步）+ 自动保存（900ms / 失焦），**永远可改**；符号面板**整份照抄 lecture**（搜索/分组折叠/计数/记住上次的组），点一下**插到光标处**（`\placeholder{}` 转成真正的 LaTeX `{}`，无焦点则复制）；改动会把旧检查标 `stale`（不删除历史） |
| 检查 | **只能手动**（按钮 / `exercise_check`）。返回结论 + 哪一步错 + 苏格拉底式提问 + "下一步验证什么"。有页面截图时走**多模态**（原题图 + 你的答案），图和 OCR 烂掉的公式都以图为准。走**全局 dsh LLM** —— 与主 agent 同一个 provider、模型和凭据（**不需要**单独配 API key / 模型）。模型输出被截断时会抢救解析；解析失败记为 `error`，**绝不**记成"你答错了" |
| 错题 | 跨套题错题本（`_mistakes.json`），每条带**你自己写的一句话教训**；`mastered` 可切换；检查判 `wrong`/`partial` 时自动收录 |
| 知识 | 教训/经验写成 physicist 馆的世界书条目（`generated_exercise.json`），热重载 ≤3s —— 于是爱弥斯能在同类题上说"你上次在这里栽过" |
| 握手 | **直接借用 lecture 的 handoff**：schema 继承 `handoffSchema`、同一个 `writeHandoff`；方向单向，接收侧**必过守门员**（缺省 `dry_run`） |
| 提交 | 解答页（服务端 KaTeX 渲染 + 字体内联）用 `pdf-lib` 与原卷合并 → **一份 PDF** 交给 Übungsbetrieb；内部 verdict 在打印时隐藏 |
| 进度 | 每开一套新题自动附 `progress_digest`：上次没做完哪套、已答/已检查、未掌握的高频主题、课堂复盘进度 |

```powershell
.\scripts\dsh.ps1 --profile exercise --port 3084   # 独立习题工作台
```

> 工具：`exercise_list` / `exercise_new_sheet` / `exercise_open` / `exercise_problem` /
> `exercise_save_answer` / `exercise_resplit` / `exercise_check` / `exercise_collect_mistake` / `exercise_lessons` /
> `exercise_sync_worldbook` / `exercise_build_submission` / `exercise_progress` /
> `exercise_export_handoff` / `exercise_import_handoff`。
> 完整设计与验证记录：[`docs/exercise-mode-plan.md`](docs/exercise-mode-plan.md)。
> macOS 配置与使用：[`使用说明-习题模式-macOS.md`](使用说明-习题模式-macOS.md)。

### 测试

```bash
npm test -w @aemeath/dsh-plugin-common       # 15 （OOC 规则层 + 人格 craft/runtime/execution）
npm test -w @aemeath/dsh-plugin-worldbook    # 10 （触发/排序/chain 防环/token 预算）
npm test -w @aemeath/dsh-plugin-memory       # 193 （守门员/BM25 冲突/引擎/L1 缓冲 + 写门/typed 冲突/情绪/关系/DMAE 激活 + 事实时间轴/演进≠矛盾/空闲整合/召回节流 + 真插件端到端）
npm test -w @aemeath/dsh-plugin-retriever    # 4  （分块器）
npm test -w @aemeath/dsh-plugin-workflow     # 13 （分流/plan 落 scratch + 量纲）
npm test -w @aemeath/dsh-plugin-curriculum   # 9  （解析/学期/检索/摘要/详情）
npm test -w @aemeath/dsh-plugin-lecture      # 282（标记语法/存储/穿越防护/BOM + 转录员/五步复盘/D4/D12/记号约定 + 工具链回归 + 符号边栏 + P3 不泄漏契约 + P4 握手接收 + 三栏工作台/独立界面模式/删除/新建课程/陈旧检测回归）
npm test -w @aemeath/dsh-plugin-exercise     # 216（types+digest / PDF 抽文本 + 拆题 / LLM 锚点分块 / 多模态读图分块 / 文件存储 / 提交 HTML / 借用 lecture 的握手 + worldbook / 手动检查解析（含宽松 JSON）+ HTTP 路由）
npm test -w @aemeath/dsh-plugin-ui           # 12 （记忆工作区代理视图：列表/时间轴/图谱）
# 合计：754 项断言（全绿，31 个测试文件，2026-10-20 实测）
# （lecture 282 + memory 193 + exercise 216 + common 15 + ui 12 + workflow 13 + worldbook 10 + curriculum 9 + retriever 4）
```

### 下一步

1. **Lecture Mode 上真机**：在 M2 上验证 macOS 路径，并跑通跨机器握手（mac → 局域网 → Windows）。代码与 Windows 侧验证已完成，这两项需要你的实际机器。
2. 前端打磨收尾：P4 工具内联 UI、P5 桌宠壳亮色打磨；记忆工作区后续（检索台来源徽章、记忆内联编辑）。
3. 内容轨：真实讲义 + Altklausur 真题 + Modulhandbuch 数据完善 → 完整六指标基准。
4. M6 v2 / M3 遗留：codeMode 启用、知识层 → retriever 桥接、v1 memory.db 迁移跑通。
5. 记忆层后续（ripples-of-aion P3 轨，见 `docs/RIPPLES_OF_AION_ADOPTION.md` §13）：实体提及加权、记忆图谱细化、检索台来源徽章。

---

## ⚠️ 免责声明 / Disclaimer

本项目为粉丝同人作品，角色「爱弥斯」「星炬」及其世界观出自游戏《鸣潮》（Kuro Games 库洛游戏）。本项目与 Kuro Games 无任何关联，未获其官方授权；仅供学习交流使用，**禁止商用**；角色美术、语音等素材版权归原作者/版权方所有；如涉及侵权，请联系删除相关内容。第三方组件、模型权重与许可证清单见 [Third_Party_Notices.md](Third_Party_Notices.md)（含 YOLOv8 AGPL-3.0 与 IndexTTS2 模型非商用协议提示）。

*This is a fan-made project. The characters "Aemeath" and "Stellar Torch" and their world belong to the game Wuthering Waves (Kuro Games). This project is not affiliated with or endorsed by Kuro Games. For learning purposes only — **no commercial use**; character art/voice assets belong to their respective owners; contact us to remove any infringing content. Third-party components, model weights and licenses are listed in [Third_Party_Notices.md](Third_Party_Notices.md) (including AGPL-3.0 notice for YOLOv8 and the non-commercial IndexTTS2 model license).*

## 📄 许可证 / License

MIT License (code). See [LICENSE](LICENSE) and [Third_Party_Notices.md](Third_Party_Notices.md).
