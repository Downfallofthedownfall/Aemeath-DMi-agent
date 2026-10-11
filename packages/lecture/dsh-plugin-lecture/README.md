# Lecture Mode · 课堂记录模式

> Aemeath 的**独立拓展 app**：课堂上采集速记 → 后端 LLM 加工（不回显）→ 课后五步人工复盘
> → 生成结构化摘要 → 把课程进度与短板**单向**同步回主 agent。
>
> **可脱离主 agent 在 macOS 上独立运行**（零 Python 依赖）。

---

## 这是什么

一个**音频/视频都不需要**的课堂记录模式：你打字做速记，AI 在后台把公式补成规范 LaTeX，
但**加工结果不会显示在你眼前** —— 因为课后的复盘要你先凭记忆说，不能被剧透。

```
课堂（mac 或 Windows）
  ┌──────────────────────────────────────────┐
  │ 你在**对话里**打速记（# 主题 / = 公式 /  │
  │   ? 疑问 / ! 重点 / > 例子 / --- 分块）   │
  │  ↓                                       │
  │ 留白：[我的理解] [我的疑问]               │
  │   —— **只能你自己写**，AI 不代笔；        │
  │      你说了它才记，没说它会问你           │
  │  ↓                                       │
  │ 落盘 markdown（人可读、可 diff）          │
  │  ↓（后台，不阻塞、不回显）                │
  │ LLM 转录员：公式补 LaTeX → .raw.json      │
  └──────────────────────────────────────────┘
                    ↓ 课后
  ┌──────────────────────────────────────────┐
  │ 五步复盘：                                │
  │  1 你先说（不给任何提示）                 │
  │  2 对照（我记住了 / 我漏了 / 我记错了）   │
  │  3 定点补漏（苏格拉底式追问，先让你答）   │
  │  4 候选条目（此时才生成结构化摘要）       │
  │  5 逐条确认写入                           │
  └──────────────────────────────────────────┘
                    ↓ 回家后人工上传
              主 agent（Windows）
              ├─ 课程进度
              ├─ 用户短板
              └─ 粗略单元内容
```

**注意流程的重点**：速记在**对话**里输入（P0 决策：输入 100% 走 LLM，才能规范化公式），
**工作台界面用于开课 / 查阅 / 复盘**。早先工作台里也有一个速记输入框，
但那样会让人困惑"到底在哪记"，已移除。

---

## 为什么独立（而不是接进 memory）

不是洁癖，是**现有代码的硬约束**（全部实测核实）：

| 发现 | 影响 |
|---|---|
| memory 召回注入**没有"课堂豁免"** | physicist preset 每轮必注入 topK=5 记忆 |
| retriever 注入 hard-gate 到 physicist | query > 8 字即注入 ≤1500 token 讲义 |
| L1 的 schema 是**对话轮形状**（`{query, reply}`） | 装不下课堂速记；总结提示词写死"用户提问+AI回复" |
| `ctx.memory.save()` **不跑守门员** | 直接调用会绕过 BM25 查重 / typed 冲突 / 写门 |
| 存储是**单文件全量 JSON** | 跨机器双写会整体覆盖，静默损坏 |
| 宿主**没有 tab/router 系统** | 只有 4 个 layout seat，"新界面" = `shell.overlay` 全屏层 |

完整论证见 [`docs/lecture-mode-plan.md`](../../../docs/lecture-mode-plan.md) §2。

---

## 快速开始

### 方式 A：在主程序里用（Windows 日常，推荐）

lecture **已挂进 aemeath 主 profile**，与 memory / worldbook / retriever 并存：

```powershell
cd app
npm start          # 托管 dsh（3081）+ 打开品牌窗口
```

窗口打开后，**侧边栏底部有蓝色的「课堂」胶囊按钮** —— 点它打开**独立的课堂窗口**
（可以拖到屏幕另一侧，不跟主窗口重叠）。

> 为什么是独立窗口而不是主界面里的一块：dsh 的 Web UI 只开放四个座位
> （sidebar/conversation/details/shell.overlay），**插件开不了新 OS 窗口**，
> 所以真窗口由 Electron 壳提供（`app/main.js` 的第二个 `BrowserWindow`）。
> 浏览器里没有壳桥时**降级为全屏浮层工作台**（同样是三栏），功能不变。

> 挂进主 profile 不违反 D2 隔离：本插件不注入 memory 召回 / worldbook /
> retriever / curriculum / workflow 的任何注入链，只是多了几个工具 + 一个 overlay 界面。

### 方式 B：独立 profile 跑（课堂上 / macOS）

```powershell
$env:DSH_HOME = "$PWD\.dsh-home"
.\node_modules\.bin\dsh.cmd --profile lecture --port 3083
```

lecture 自己就是主界面。mac 上只需 Node + dsh + DeepSeek key（**零 Python**）。

### 1. 构建与测试

```powershell
npm run build -w @aemeath/dsh-plugin-lecture    # host(tsc) + client(esbuild)
npm test  -w @aemeath/dsh-plugin-lecture        # 257 项断言
```

### 2. 落地独立 profile（仅方式 B 需要）

dsh 从 `$DSH_HOME/profiles/<name>/` 读取 profile，**不是**仓库的 `profiles/`：

```powershell
$dst = ".dsh-home\profiles\lecture"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item profiles\lecture\cordis.yml, profiles\lecture\cordis.patch.yml, profiles\lecture\package.json $dst -Force

# 插件用 junction 指向源码（改了 TS 只需 build，不用重装）
$nm  = Join-Path $dst "node_modules"
$aem = Join-Path $nm "@aemeath"
New-Item -ItemType Directory -Path $aem -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $aem "dsh-plugin-common")  -Target "$PWD\packages\shared\dsh-plugin-common"
New-Item -ItemType Junction -Path (Join-Path $aem "dsh-plugin-lecture") -Target "$PWD\packages\lecture\dsh-plugin-lecture"
# ⚠ @deepseek-ai 必须是 junction → 仓库根，否则双份依赖会让工具调度器报错
New-Item -ItemType Junction -Path (Join-Path $nm "@deepseek-ai") -Target "$PWD\node_modules\@deepseek-ai"
```

> ⚠️ **不要在 `profiles/*/` 内跑 `npm install`** —— npm 的 reify 会顺着 junction
> 把仓库根 `node_modules/@deepseek-ai` 清空（`scripts/dsh.ps1:98-104` 记录了此坑）。

### 3. 启动

```powershell
$env:DSH_HOME = "$PWD\.dsh-home"
.\node_modules\.bin\dsh.cmd --profile lecture "开始课堂记录"
```

> ⚠️ **改了代码要重启 dsh** —— 插件加载器不监视文件，没有热重载。

---

## macOS 上怎么跑

### 先搞清楚一件事：mac 上**没有**主 agent，这是设计如此

| | Windows | macOS |
|---|---|---|
| 主 agent（记忆 / 人格 / 解题 / SymPy…） | ✅ 有 | ❌ **没有，也不打算做**（D10） |
| **课堂记录** | ✅ 有 | ✅ **有 —— 这就是 mac 上你唯一要用的东西** |

课堂记录是**独立**的：它自己就是一个完整界面（自己的对话 + 速记 + 复盘），
**不需要**主 agent 在旁边。

> ⚠️ 如果你在 mac 上照着文档跑 `cd app && npm start`、或者找"侧边栏的课堂按钮"——
> 那些都是 **Windows** 的步骤，mac 上不存在。这就是以前看不懂的原因：
> 我把两件事混在一起写了。

### 就一条命令

```bash
cd <你的仓库目录>
git pull                 # 拉最新代码
./lecture-launch.command
```

如果提示 `Permission denied`，先给一次执行权限再重试：

```bash
chmod +x lecture-launch.command
```

**双击这个文件也一样**（Finder 里双击 = 运行）。

### 会发生什么

1. 检查 Node（不够会说人话，不是抛一句看不懂的错）
2. 首次运行装依赖 + 构建（几分钟），之后是秒级
   —— 启动脚本会自动比较"源码 vs 产物"的时间戳并重建
3. 启动服务，**浏览器自动打开**（带 token，不用手输）
4. **直接就是课堂工作台**（铺满整屏，没有 dsh 的会话列表/插件菜单）

> lecture profile 的 `standalone: true` 会让 host 往页面注入
> `__AEMEATH_LECTURE_STANDALONE__`，客户端据此直接渲染工作台。
> 主 profile 不设这个开关，所以在 Windows 主程序里仍然是"侧边栏按钮 → 独立窗口"。

**终端窗口不要关** —— 关了服务就停了。

> 📖 面向使用者的完整说明（含 Node 查找顺序、日常流程、排错）：
> [**使用说明-课堂模式-macOS.md**](../../../使用说明-课堂模式-macOS.md)

### 进去之后

1. 在对话里让爱弥斯调 `lecture_session_start`
   （例如"开始记录 Physik I 第 3 讲角动量"）
2. 左下角「课堂」→ 写速记
3. 课后切「复盘」页签，走五步

### 配 DeepSeek key（可选）

课堂内的 LLM 转录（把速记规范化、补公式）需要 key。

**推荐：启动后点左下角「设置」→ Models 填。** 这是 dsh 自带的页面，
会写进 `$DSH_HOME/.credentials.yaml`，**改完不用重启**。

或者终端里跑一次（持久）：

```bash
echo 'export DEEPSEEK_API_KEY=sk-你的key' >> ~/.zshrc
source ~/.zshrc
```

> **不填也能用**：速记照记、留白照填、复盘照做，只是不做后台规范化
> （`=` 公式行不会被规整成标准 LaTeX）。日志里会看到
> `⚠ LLM 无 apiKey，跳过`。

优先级（高 → 低）：环境变量 → `.credentials.yaml` → `.env` 文件。

### 想要"更技术"的入口

`lecture-launch.command` 是**日常入口**（双击、自动开浏览器、出错弹窗）。
若要在终端里手动控制：

```bash
./scripts/lecture-mac.sh                 # 前台运行，日志直接打在终端
./scripts/lecture-mac.sh --port 4000     # 换端口
./scripts/lecture-mac.sh --setup-only    # 只装配不启动
```

两者共用同一套装配逻辑，区别只是体验。

### 第 4 步：用起来

启动后终端会打印一个**带 token 的地址**，形如：

```
http://127.0.0.1:3083/?token=xxxxx
```

浏览器一般会自动打开；没打开就手动复制这个地址（**必须带 token**，裸访问会 401）。

进去之后是一个**三栏学习工作台**（铺满整屏）：

```
┌──────────┬────────────────────┬──────────────┐
│ 课程/单元 │ 笔记（本次课）      │ ∑ 符号 / 复盘 │
└──────────┴────────────────────┴──────────────┘
```

1. **开课**：右上角「＋ 新的一节」→ 选「新建一门课程」或「记到已有课程」
   → 填主题 → 「开始这节课」
2. **记笔记**：回到**对话**里直接写（工作台只用于回看），标记语法：
   `# 主题` / `= 公式` / `? 疑问` / `! 重点` / `> 例子` / `--- 分块`
3. **留白**：「我的理解」「我的疑问」**必须你自己写**。
   你说了 Aemeath 才记；没说它会**问你**（不会替你编 —— 那是主动回忆的核心）
4. **符号**：右栏「∑ 符号」常驻，点符号即**复制到剪贴板**，
   到对话输入框 ⌘V 粘贴。250 个符号 / 12 分组 / 支持搜索 / Tab 跳插槽
5. **复盘**：右栏「复盘」→ 五步：回忆 → 对照 → 补漏 → 候选 → 确认
6. **删除**：左栏课程/单元行**悬停出现 ✕**（单元 / 整门课，都会二次确认）

### 数据在哪

```
packages/library/physicist/lectures/<course-id>/
```

markdown 是主数据（人可读、可 git），JSON 是索引与加工中间态。

### 常见问题

**Q：`ln -s` 报错 / 脚本说"无法创建符号链接"**
macOS 上不该发生。若你在 Windows 的 Git Bash 里跑，请改用
`.\scripts\dsh.ps1 --profile lecture --port 3083`（脚本会直接拒绝并提示）。

**Q：工具调度器报 `Cannot read properties of undefined (reading 'prepare')`**
profile 里出现了**独立副本**的 `@deepseek-ai`（通常是误在 `profiles/*/` 里跑过 `npm install`）。
重跑 `./scripts/lecture-mac.sh --setup-only` 会把它修回链接。

> ⚠️ **永远不要在 `profiles/*/` 里跑 `npm install`** —— npm 的 reify 会顺着链接
> 把仓库根的 `@deepseek-ai` 删空。装依赖一律在仓库根。

**Q：改了配置/代码没生效**
插件加载器不监视文件，**没有热重载**。重启脚本即可。

**Q：和 Windows 上的记录会不会打架**
数据目录是共享的，但课堂指针按 `profile|sessionId` 分片，
不会互相覆盖（`_active.<hash>.json`）。若检测到别的设备的活跃指针会 warn 提示。
跨设备汇总走握手：mac 导出 `handoff.json` → 传到 Windows → 主 agent 的
`lecture_import_handoff` 导入（默认 `dry_run`，先看会写什么再真写）。

---

## 工具清单

| 工具 | 用途 |
|---|---|
| `lecture_session_start` | 开始一节课（课程不存在则创建；写磁盘指针） |
| `lecture_capture` | 记录速记（触发后台转录）。**留白缺失不阻断**：照收，并返回 `ask_user` 让模型回问用户 |
| `lecture_status` | 查看当前课堂状态 / 留白完成情况 |
| `lecture_review_start` | 开始五步复盘（可断点续做） |
| `lecture_review_submit` | 提交"你先说"或补漏回答（返回对照 / 下一个追问） |
| `lecture_review_next` | 推进一步（repair→candidates 才生成摘要） |
| `lecture_export_handoff` | 导出握手包（进度 + 短板 + 粗略单元内容） |
| `lecture_import_handoff` | 导入握手包（**只跑主 agent 侧**；默认 `dry_run`；必过守门员） |

> **留白为什么不是必填**：早先 `my_understanding` / `my_question` 是 `required`，
> 描述还写"必须同时给出"，结果**模型自己编了理解与疑问填进去** ——
> 那两栏是主动回忆的核心，模型代笔等于把练习做掉了。
> 现在是"记录照收 + 缺了就问用户"。HTTP 路径（界面上你自己打字）仍然拦截空留白，
> 这个不对称是**故意的**。

### 典型用法

```
lecture_session_start(course_id='physik-1', course_title='Physik I',
                      title='第3讲 角动量', semester='WiSe', module_code='PHY-101')

lecture_capture(raw='# 角动量定义
= L = r x p = Iw
! 定轴转动才可写成 Iw
? 为什么必须有对称轴',
                my_understanding='角动量是转动版的动量',
                my_question='为什么必须定轴')
```

---

## 数据格式

```
packages/library/physicist/lectures/
  _active.json                    ← 当前课堂指针（崩溃恢复用）
  <course_id>/
    index.json                    ← 课程索引（单元列表 / 复盘状态）
    2026-10-15-u01.md             ← 课堂记录（人可读；→ retriever 可直接检索）
    2026-10-15-u01.raw.json       ← LLM 加工结果（**前端不读**）
    2026-10-15-u01.review.json    ← 复盘状态机（可断点续做）
    2026-10-15-u01.candidates.json← 第 4 步候选条目
    2026-10-15-u01.summary.json   ← 结构化摘要（第 4 步之后）
```

课堂记录用 `## ` 二级标题分块 —— 与 `packages/retriever` 的 `chunker.ts` 同规则，
所以**课后丢进 `notesDir` 就能被主 agent 检索，零额外代码**。

### 标记语法

| 标记 | 含义 |
|---|---|
| `#` | 主题（会变成 `## ` 小节标题） |
| `=` | 公式 |
| `?` | 疑问 |
| `!` | 重点 |
| `>` | 例子 |
| `---` | 分块（整行三连字符以上） |

---

## 设计边界（三条硬约束）

这些不是建议，是代码里**有测试保证**的不变量：

1. **加工结果不回显前端**（D3）
   LLM 转录员的结果只写 `.raw.json`。转录员的 prompt 明令禁止补充概念/推导/总结，
   且 `looksLikeSummary()` / `isOverExpanded()` 会对越界输出告警。

2. **摘要只在复盘第 4 步之后生成**（D4）
   `ReviewMachine.canGenerateSummary()` 是唯一门控入口；在 recall/compare/repair
   阶段调用 `buildCandidatesPrompt()` 会**抛错**。

3. **第 3 步引导不得直接给答案**（D12）
   "中等 AI" = 不让 AI 直接解题，而是引导纠正。`looksLikeDirectAnswer()` 会拦截
   疑似直答的输出。注意此条**只在复盘第 3 步生效** —— 课堂内 LLM 是转录员，不受此约束。

---

## 测试

```powershell
npm test -w @aemeath/dsh-plugin-lecture
```

| 文件 | 断言 | 覆盖 |
|---|---|---|
| `check.mjs` | 24 | 标记语法解析 / 回写往返 / 留白校验 / front-matter |
| `check2.mjs` | 30 | 存储往返 / **目录穿越防护** / **UTF-8 BOM** / D3 分离 |
| `check3.mjs` | 39 | 转录员 / 五步状态机 / **D4 门控** / **D12 护栏** / 握手 / **记号约定** |
| `check4.mjs` | 16 | **工具链回归**（checkpoint flush 时序 + 重启恢复 + 多 owner 指针隔离 + 删除后落盘） |
| `check5.mjs` | 55 | **数学符号边栏**（数据完整性 / 光标落点 / 模板插槽 / Tab 跳转） |
| `check6.mjs` | 16 | **P3 前端契约**：D3 不泄漏（含反例）/ 服务端留白 |
| `check7.mjs` | 26 | **P4 握手接收侧**：过守门员 / D4 双端门控 / dry_run |
| `check8.mjs` | 51 | **静态契约回归**（见下表） |

合计 **257 项**。

`check8.mjs` 守的是**那些"只能在别人机器上炸"的坑** ——
每一条都对应一次真机事故：

| 分组 | 守什么 | 事故 |
|---|---|---|
| 主题跟随 | 底色必须**不透明实色** | 面板半透明，主界面透出来 |
| CSS 完整性 | 模板里不能有裸反引号 | 截断模板字符串，编译失败 |
| 独立窗口形态 | `fixed` + `z-index` + 隐藏宿主 | 面板被挤到页面底部 |
| D3 覆盖度 | `LEAK_KEYS` 覆盖 `formulas[]` | 加工结果泄漏 |
| profile 声明 preset | registry 指向的 preset 必须**被声明** | `unknown agent preset` |
| 插件依赖声明 | `cordis.patch.yml` 挂的必须**在 package.json 里** | 加载失败 |
| 留白归属 | 参数**不能是必填**（否则模型代笔） | 模型编造理解与疑问 |
| 三栏工作台 | 结构 / 符号常驻 / 铺满 / 实色底 | 看起来还是主 agent |
| boot 标记 | host 必须**生产** `__AEMEATH_LECTURE_STANDALONE__` | 永远退回主 shell |
| ui 依赖 memory | `inject` 里**不能有** `memory` | host 半区一直 pending |
| DSH_HOME | launcher 必须显式 export | 干净 shell 去读 `~/.dsh` |
| 删除功能 | HTTP 动作 / store 实现 / 清理指针 / 二次确认 | 测试笔记删不掉 |
| 新建课程 | 有课后仍能建新课（不被 `!hasCourses` 卡住） | 只能加小节 |
| 陈旧检测 | 遍历所有包，**同时比 host 与 client** | pull 后仍用旧产物 |

---

## 前端（P3）

**双形态**（同一份客户端代码，按环境自动选择）：

| 环境 | 形态 | 判定依据 |
|---|---|---|
| **lecture profile**（含 mac 纯浏览器） | **三栏工作台铺满整屏** | host 注入 `__AEMEATH_LECTURE_STANDALONE__` |
| Electron 主窗口 | 侧边栏「课堂」→ 开**独立窗口** | 有 `window.shell.lecture` 桥 |
| Electron 课堂窗口 | 整窗铺满 | `window.shell.isLectureWindow`（preload 从 `process.argv` 同步读） |
| 其它浏览器 | 全屏浮层工作台 | 无壳桥 → 直接用 portal |

> ⚠️ **`detectStandalone()` 的三条判据在纯浏览器下全都会落空**，这是踩过的坑：
> ① 没有 Electron 壳；② 认证 `303 → ./` 会丢掉 URL query；
> ③ `__AEMEATH_LECTURE_STANDALONE__` 曾经**只有读取、没有生产者**（死分支）。
> 结果是 mac 上永远退回 dsh 主 shell。
> 修法：host 侧用 `webserver/index-inject` 注入该全局标记
> （由 `aemeath-lecture` 的 `standalone: true` 控制；主 profile 不设）。

### 三栏结构（`workbench.tsx`）

```
┌──────────┬────────────────────┬──────────────┐
│ 课程/单元 │ 笔记（本次课）      │ ∑ 符号 / 复盘 │
│ 左栏导航  │ 中栏主区            │ 右栏工具      │
└──────────┴────────────────────┴──────────────┘
```

| 栏 | 内容 |
|---|---|
| 左栏 | 课程 / 单元列表，悬停出现删除 ✕；可收起 |
| 中栏 | 当前讲的笔记块（**只读查阅**）+ 开课表单 + 空状态引导 |
| 右栏 | **Σ 符号键盘（常驻）** / 复盘面板 |

**符号键盘是一等公民**：早先它藏在一个折叠按钮后面，用户反馈"没看到按钮"。
现在打开工作台就在右栏，点符号**复制到剪贴板**（侧栏不再有输入框，
"插入到光标处"没有目标了），到对话输入框粘贴。

**记笔记在对话里，不在工作台** —— 工作台是中栏只读的。
早先中栏也有输入框，但那样会让人困惑"到底在哪记"，已移除。

**入口有两个**（D9）：
- lecture profile 单独启动 → 它自己就是主界面
- 主 agent 内 → 侧边栏「课堂」胶囊按钮（派发 CustomEvent 打开）

**前端不持有 token**：数据走同源代理 `/aemeath/api/lecture`。

### ⚠️ D3 边界（改前端前必读）

界面**绝不显示 LLM 加工结果**。这条不只是纪律，有代码级护栏：

```ts
// host 侧每个 GET 分支在返回前自检
const leaked = findLeakedKeys(view);
if (leaked.length) {
  warn(`D3 泄漏拦截：含 ${leaked.join(', ')}`);
  return jsonError(res, 500, 'internal: response would leak processing output');
}
```

`check6.mjs` 断言视图不含 `processed` / `formulas` / `model` / `chunk_seq`，
并用**反例**验证护栏本身有效（只测干净对象是不够的）。

---

## 握手（P4）

### 发送（lecture 侧，mac）

```powershell
lecture_export_handoff(course_id='physik-1')
# → packages/library/physicist/lectures/physik-1-handoff.json
```

只传三样：**课程进度 / 用户短板 / 粗略单元内容**。
不含原始速记、不含复盘问答、不含加工中间态（有测试断言）。

### 接收（主 agent 侧，Windows）

```powershell
# 建议先试运行（dry_run 缺省就是 true）
lecture_import_handoff(dry_run=true)
# 确认后真正写入
lecture_import_handoff(dry_run=false)
```

**必须过守门员**：接收侧自己跑 `decide()` + `writeGate()`，
**绝不**直接调 `ctx.memory.save()`（其注释写明「守门员已判定后调用」）。

接收侧的保守策略：
- 只处理 `reviewed: true` 的单元（D4 门控在接收侧**也**生效）
- 单元标题（`topics`）**不写**（信息量不足，会污染知识层）
- 短板进 `mode` 作用域（跟课程绑定，不是全局身份）
- `dry_run` **缺省为 true** —— 安全默认

---

## 数学符号边栏（为前端准备）

数据与逻辑已就绪，前端只需接 UI：

```ts
import { SYMBOL_GROUPS, insertSymbol, nextSlot } from '@aemeath/dsh-plugin-lecture/symbols';

const r = insertSymbol(text, selStart, selEnd, sym, { autoSpace: true });
textarea.value = r.text;
textarea.setSelectionRange(r.caret, r.caret);
// Tab 键：跳到下一个插槽；null 则放行 Tab
const next = nextSlot(r.slots, activeSlot);
```

**250 个符号 / 12 个分组**：微积分、求和与连乘、根号与上下标、矢量与导数记号、
三角函数、希腊字母、集合与逻辑、关系与比较、物理常用、箭头与映射、括号与结构、单位。

其中 **30 个是"带条件的复杂结构"**，用模板 + 多插槽（Tab 跳转）：

| 按钮 | 插入结果 | 插槽 |
|---|---|---|
| `∑ 上下限` | `∑_{}^{} ` | 下限 → 上限 |
| `∏ 上下限` | `∏_{}^{} ` | 下限 → 上限 |
| `lim` | `lim_{} ` | 趋近条件 |
| `∀ 任意` | `∀∈: ` | 变量 → 集合 |
| `∫ 上下限` | `∫_{}^{} ` | 下限 → 上限 |
| `⟨φ\|ψ⟩ 内积` | `⟨\|⟩ ` | 左态 → 右态 |
| `矩阵 2×2` | `[ ;  ]` | 四个元素 |

### ⚠️ 记号约定（改代码前必读）

**记号没有全局标准** —— 每个教授写法不同，甚至同一堂课有三种矢量写法。
所以数据表**故意把常见变体都放上**（半箭头 / 全箭头 / 粗体；点号 / `d/dt`），
由用户按当堂习惯挑。**不要试图"统一"这些变体。**

本校固定约定（`symbol-data.ts` 的 `INSTITUTIONAL_NOTATION`）：

| 场景 | 约定 |
|---|---|
| 对时间求导 | **点号** `ṙ` `r̈` |
| 其余导数 | `d/dx`、`∂/∂x` |
| 矢量 | **上划半箭头** `r⃗` |

这段约定**同时注入转录员 prompt**（禁止 LLM 把 `ṙ` 改成 `\frac{dr}{dt}`），
且从**同一常量生成** —— 单一数据源，防止边栏与转录员漂移（有测试断言）。

---

## 已知问题与注意事项

### `session/flush` 不是"会话结束"（已修复，勿回退）

dsh 的 `dsh-session-checkpoint-policy` 在**每个顶层工具体执行前 / 每次模型请求前 /
每个 agent/pre-step** 都派发一次 `session/flush`。

初版把内存态清理挂在该事件上，导致采集闭环**从第二个工具调用起 100% 失败**：

```
lecture_session_start（写 active）→ flush（删 active）→ lecture_capture（找不到课堂）
```

现在挂 `session/disposed`（真正的会话退役事件）。`check4.mjs` 用假 ctx 派发真实
checkpoint flush 来固化这个时序，**不要删掉那个测试**。

### 进程重启恢复

`_active.json` 是磁盘指针。语义边界：

- **崩溃/重启** → 指针残留 → `lecture_capture` 从 markdown 重建并接着记
- **正常 `session/disposed`** → 清指针（防新会话静默继承旧课）

### 尚未实现

- **讲义导出到 retriever**（`exportToNotes`）：开关已接线，但只在主 profile 下有意义；
  尚未做端到端验证
- **跨机器握手实测**：schema / 导入器 / 单元测试都齐了，但还**没在两台真机上跑过一遍**
  （mac 导出 → 局域网 → Windows 导入）。这是唯一还靠"推理正确"而非"实测正确"的环节
- **课堂内 LLM 转录的端到端验证**：转录员本身有单测，但"真跑一遍看输出质量"还没做过

> **已完成**（本节早先写着"未做"，是文档债）：
> P3 前端（三栏工作台 + 独立界面模式）、P4 导入入口、**删除**（单元/课程）、
> **新建课程**、**macOS 实机启动**（用户实测通过）。

---

## 相关文档

- [**使用说明 · macOS**](../../../使用说明-课堂模式-macOS.md) — 面向使用者的启动与日常流程
- [`docs/lecture-mode-plan.md`](../../../docs/lecture-mode-plan.md) — 执行计划（14 项决策 / 代码核实依据 / 分期）
- [`docs/lecture-devlog.md`](../../../docs/lecture-devlog.md) — 开发日志（含每次真机事故的根因与教训）
- [`packages/memory/dsh-plugin-memory`](../memory/dsh-plugin-memory) — 主记忆层（lecture **不**直接依赖）
- [`packages/retriever/dsh-plugin-retriever`](../retriever/dsh-plugin-retriever) — 讲义检索（消费导出的 `.md`）
