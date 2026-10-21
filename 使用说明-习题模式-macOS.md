# 习题模式（Übungen）· macOS 使用说明

> 你在 mac 上做作业需要的全部东西。**主 agent 在 mac 上不存在，也不需要**。
> 习题模式是独立 app：导入 PDF → 自己做题 → 手动让爱弥斯检查 → 生成一份可提交的 PDF。

---

## 一、开始之前

| 需要 | 说明 |
|---|---|
| **Node 20+** | 唯一的硬依赖。脚本会自己找（Homebrew / nvm / volta / fnm 都试） |
| **Chrome 或 Edge**（可选） | 用来把提交页打印成 PDF。没有也能用：界面会给「打开打印页」，你按 **⌘P → 存储为 PDF** 一样出文件 |
| **DeepSeek API Key**（可选） | 只有「让爱弥斯检查」需要。**不用单独填**：用的是主 agent 那把全局 key（界面「设置 → Models」或 `$DSH_HOME/.credentials.yaml`）。不填也能导入/做题/生成 PDF/记错题 |
| 不需要 Python | 习题模式不调 sympy / vision / tts / control（那是 Windows 主 agent 的事） |

---

## 二、启动

### 方式 A：双击（推荐）

在 Finder 里进入仓库目录，**双击 `exercise-launch.command`**。

- 自己找 Node（`/opt/homebrew/bin`、`/usr/local/bin`、nvm、volta、fnm 全试一遍）
- 需要时自动装依赖、构建、把 profile 链到 `$DSH_HOME`
- 服务就绪后**自动打开浏览器**（带 token，不用手输）
- **终端窗口不要关**（关了服务就停）

> 第一次双击若提示「无法打开，因为它来自身份不明的开发者」：
> **右键 → 打开 → 打开**（Gatekeeper 只拦第一次）。
> 若提示「Permission denied」：`chmod +x exercise-launch.command`。

### 方式 B：命令行

```bash
cd ~/aemeath-dmi-agent
./exercise-launch.command              # 双击的等价物
./scripts/exercise-mac.sh              # 只在终端里跑（默认 3084，不自动开浏览器）
./scripts/exercise-mac.sh --port 4000  # 换端口
./scripts/exercise-mac.sh --setup-only # 只做装配（装依赖/构建/link profile），不启动
```

终端会打印形如 `dsh web: http://127.0.0.1:3084/?token=...` 的地址，手动打开即可（token 一次性换 cookie）。

### 方式 C：只要服务（配合远程/脚本）

```bash
AEMEATH_EXERCISE_PORT=4000 ./scripts/exercise-mac.sh
```

### 停止

关掉终端窗口，或在该窗口按 **Control-C**。

---

## 三、首次运行到底做了什么

按顺序，全部自动：

1. **找 Node**（并按 `node -p process.versions.node` 检查 ≥ 20）
2. **检查 shell 可移植性**（macOS 自带 bash 3.2 对 `$VAR` 紧跟中文的写法会解析错，
   脚本里已有自检，改了脚本也能立刻发现）
3. **装依赖**（仓库根 `npm install`，缺 `node_modules` 时）
4. **构建**（`npm run build`；判据是"任一包的源码比 `lib/` 产物新"——host 与 client 都比）
5. **把 profile 接到 dsh**：`$DSH_HOME/profiles/exercise` → 仓库 `profiles/exercise`（符号链接）
6. **建依赖链接**：`profiles/exercise/node_modules/@deepseek-ai` → 仓库根；
   `@aemeath/*` **逐包**链接（包名 ≠ 目录名，整目录链会解析不到）
7. **检查凭据**：有 `DEEPSEEK_API_KEY` 或 `$DSH_HOME/.credentials.yaml` 就跳过，否则给出设置提示

> ⚠️ **永远不要**在 `profiles/*` 里跑 `npm install` —— 那会顺着 `@deepseek-ai` 链接
> 把仓库根的依赖删空（Windows 上同理）。装依赖只在仓库根。

---

## 四、界面与日常流程

启动后浏览器打开的是**全屏习题工作台**（不是 dsh 原生界面），外观与 lecture 课堂模式同一套
（同样的玫粉强调色、圆角卡片、三栏骨架）：

```
┌──────────────┬────────────────────────────┬──────────────────┐
│ 课程 / 套题   │ 题目卡片（题干 + 我的解答）    │ 符号 / 错题 / 经验 / 进度 │
│ + 工具按钮    │  题干自己滚，解答框始终可见   │                  │
└──────────────┴────────────────────────────┴──────────────────┘
```

### 1. 导入一套作业

右上 **「导入 PDF」** → 拖入 PDF / 点选文件 → 填：

| 字段 | 例子 | 说明 |
|---|---|---|
| 课程标识 | `physik-1` | 只能用字母/数字/`.`/`_`/`-`，会成为文件夹名；**第一次填就建好课程** |
| 课程全名 | `Physik I` | 显示用 |
| 第几套 | 留空 = 自动 +1 | |
| 截止日 | `2026-10-22` | 左栏会显示"还有 N 天 / 今天截止 / 过期" |

导入器会：**把 PDF 每页渲染成截图** → 交给**多模态模型看图拆题**（公式、插图、多栏都能读）
→ 同时抽一份文本做后备（读图失败时退回文本锚点，再退回规则分块）→ 提取分值 → 记原卷页数。

> 看原题：每题下面有 **「原题截图（第 N 页）」**，点开就是原卷那一页（限高可滚），
> 也能「新窗口打开」。公式最准的永远是这张图 —— 题干文本只是给你搜/改的副本。

> **切错了怎么办**：左栏有 **「LLM 重新分块」**（首选）和「规则重新分块」两个按钮。
> 重切时**按题号保留已写答案**，不会白写。导入提示里会写清这次是 LLM 还是规则切的
> （`source.md` 里也能看到原文，想手改就改完再重切）。

> **扫描版/公式为主的 PDF** 抽不出文字时**不会报错**：会建一套空题集，
> 顶部提示"请手动补题干"，点每题右上「改题干」补。
> LLM 分块需要能用的全局 API key；没有 key 时自动退回规则分块，功能不受影响。

### 2. 做题

- 答案框就是普通文本框：**可以直接写 LaTeX**（行内 `$F=ma$`，独占一行 `$$...$$`）
- **左边写、右边当场排版**（KaTeX）：`分栏` 是默认，另有 `只写` / `只看渲染` 两个模式
- 停顿 0.9 秒或点到别处**自动保存**
- 右栏「符号」**整份照抄 lecture**：搜索框、分组折叠（记住上次用的组、显示条数）、点一下按钮闪一下
- 点符号 = **插到当前答案框的光标处** + 同时复制到剪贴板（想粘到别处也行）；没有聚焦答案框时只复制
- 复合符号（`∫ 上下限`、`∑`、`d/dx`）插进去**只有裸 LaTeX**（不自动加 `$`），光标落在第一个空组里 —— 直接打上限；
  `$` 自己写：单独一行写一条公式时**不用** `$`（会按裸 LaTeX 渲染），和文字混排时才需要
- 手打也行：**单独一行**写 `\sum_{1}^{2}` 这种不带 `$` 的公式现在也会渲染（屏幕和导出 PDF 都认）；
  夹在中文句子里的公式仍需要 `$…$`，预览下方会提示
- 答案**永远可改**：改完之前那次检查会被标成"针对旧答案"（不删历史）
- 右栏「符号」是 250+ 符号面板：点一下插到光标处（没有聚焦答案框时 = 复制到剪贴板）
- 备注框写"这题我老忘什么"，会跟题目一起保存

### 3. 让爱弥斯检查（**手动**）

每题下的 **「让爱弥斯检查这题」**。它只会：

- 说你哪一步不成立、缺什么
- 给 1–2 个苏格拉底式提问 + 下一步该验证什么
- **不会**把完整解法写给你（这是刻意的：检查不是答案生成器）

结论是建议不是判分。`有错 / 部分正确` 时会自动进错题本。

### 4. 错题本 + 经验

- 右栏「错题本」：跨套题汇总，每条带坐标（课/套/题号）、当时的答案、问题清单
- **「这题教会我什么」一句话**是你写（不是模型生成）——这一句才是会进知识库的东西
- 「我掌握了」可标记；「同步 worldbook」把未同步的教训写进物理馆
  （世界书热重载 ≤3 秒，主 agent 讲同类题时会主动提起）
- 右栏「经验」：这套题的整体经验（可多条），同样可同步

### 5. 生成提交 PDF

右上 **「生成提交 PDF」**：

1. 服务端用 KaTeX 把答案里的公式**真渲染**成静态页（字体内联，离线也能打开）
2. 用本机 Chrome/Edge 无头打印成 PDF
3. 用 pdf-lib 把**原卷**和你**解答**合成**一个文件**（默认原卷在前）
4. 自动下载 `physik-1-ub03-submission.pdf`

> 没装 Chrome/Edge 时：界面提示「打开打印页」→ 浏览器里 **⌘P → 存储为 PDF**。
> 内部 verdict 徽章打印时自动隐藏，不会印到交给助教的那份上。

### 6. 导出成文本（给 git 管理）

左栏最下面 **「导出文本」**：把题库导出成 markdown（`README.md` / `mistakes.md` / 每门课一份 `README.md` + 每套题一份 `<套>.md`）。

- **确定性**：内容没变就不重写、不产生 diff；改一题只重写那一个文件
- 一题一段（题干 / 我的解答 / 备注 / 检查 / 错题 / 经验），答案保留原始 LaTeX
- 删掉某套题后重新导出会移除对应 md；**你自己放进目录的文件不会被删**
- 目录默认 `packages/library/physicist-md/`（可用 `textExportDir` 改），它**不在 gitignore 里**：

```bash
git add packages/library/physicist-md
git commit -m "übungen: 第 3 套 + 错题整理"
```

> ⚠️ 这个目录里有你的答案和错题。不打算推到远端的话，把它加进 `.gitignore`，或只提交到私有仓库。
> ⚠️ 每个文件头都写着"自动生成，请勿手改" —— 手改会在下次导出被覆盖；要改内容回界面改。

### 7. 导出去主 agent（可选）

右上「导出握手」→ 生成 `*-exercise-handoff.json`（课程进度 + 错题 + 经验，**不含**答案原文）。
拿到 Windows 机器后，在主 agent 的习题界面点「导入握手」（先试运行给你看会写什么），
或直接说"导入习题进度"让 agent 调 `exercise_import_handoff`。

---

## 五、数据在哪

```
packages/library/physicist/exercises/
  _mistakes.json                错题本（跨套题）
  handoff/                      握手导出目录
  <课程标识>/index.json          课程与套题清单
  <课程标识>/<套>/sheet.json     题目 / 答案 / 检查 / 经验（唯一事实源）
  <课程标识>/<套>/source.pdf    导入的原卷
  <课程标识>/<套>/source.md     抽出的文本（可手改，再点「LLM 重新分块」）
  <课程标识>/<套>/pages/page-01.jpg  原卷页面截图（多模态读图 + 界面原题截图）
  <课程标识>/<套>/<套>.md       人可读导出（含答案）
  <课程标识>/<套>/*-submission.pdf
```

`sheet.json` 里 `split_by` 记录这套题是怎么切出来的（`llm` / `rules` / `manual`），
`source_pages` 是原卷页数 —— 切错了先看这两个字段。

**纯文件**：可以直接编辑、备份、git 管理。整个 `packages/library/physicist/` 默认 gitignored。

---

## 六、配置项（`profiles/exercise/cordis.patch.yml`）

改完**重启**（方式 A 就是关掉终端重开）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `packages/library/physicist/exercises` | 题集数据根目录 |
| `handoffDir` | `<dataDir>/handoff` | 握手导出目录（可指到共享目录） |
| `worldbookLibraryDir` | `packages/worldbook/data/physicist` | 教训写进的馆；目录不存在会明确报错 |
| `lectureDataDir` | `packages/library/physicist/lectures` | 只读，用于"开题时附课堂进度" |
| `autoCollectMistakes` | `true` | 检查判错时自动进错题本（仍可手删/标掌握） |
| `studentName` | 空 | 填了就印在提交 PDF 抬头（空着印签名线） |
| `includeSourcePdf` | `true` | 提交包是否合并原卷 |
| `submissionOrder` | `sheet-first` | `solutions-first` 则解答在前 |
| `chromePath` | 空 | 空 = 自动找 Chrome/Edge；填绝对路径可指定 |
| `llm.provider` / `llm.model` | 空 | **一般不用填**：留空就走全局 dsh 的 LLM（与主 agent 同一个 provider/模型/凭据）。只有想单独指定检查模型时才填 |
| `textExportDir` | `packages/library/physicist-md` | 纯文本导出目录（markdown）。**不在 gitignore 里**，`git add` 就能管；里面有你的答案，不想进远端就自己加 ignore |
| ui-theme.preference | dark | **与主 agent 保持一致**；改外观时两处一起改 |

---

## 七、出问题时

| 症状 | 原因 | 处理 |
|---|---|---|
| `node: command not found` | 双击了 `.sh` 而不是 `.command` | 用 `exercise-launch.command` |
| `Permission denied` | 没有执行权限 | `chmod +x exercise-launch.command` |
| 来自身份不明的开发者 | Gatekeeper | 右键 → 打开 → 打开 |
| 界面是 dsh 原生的（有「新会话」「插件」） | host 产物旧 / 没进独立模式 | `npm run build` 后重开；仍不行看下一条 |
| 「生成提交 PDF」说找不到浏览器 | 没装 Chrome/Edge | 点「打开打印页」→ ⌘P → 存储为 PDF |
| 检查按钮一直失败 | 没有 API Key / key 失效 / 模型不可用 | 左下角「设置 → Models」填（与主 agent 同一处）；或写 `$DSH_HOME/.credentials.yaml`。检查走的是全局 dsh LLM，模型跟随主 agent |
| 从讲义复制来的公式出现红字（如 `\differentialD`） | 讲义用 MathLive，有专有宏 | 已内置兼容层：渲染期自动换成 `\mathrm{d}` 等通用写法（**不改你的原文**），预览下方会说明；真正的未知命令（如 `\foo`）会给出命令名与位置 |
| 题目切错了 / 两题粘在一起 / 一道题被劈开 | 规则分块对 LaTeX 排版不可靠 | 左栏点 **「LLM 重新分块」**（首选）；仍不对就改 `source.md` 后再点一次，或手动「＋ 添加题目」 |
| 日志里出现 `多模态读图分块失败（…）` | 模型/网络这次没读懂页面截图 | 会自动退回文本锚点分块，功能不受影响；可以隔一会儿再点「LLM 重新分块」，或手动补题干 |
| 原题截图打不开 / 空白（旧题集） | 多模态之前导入的套题只有 source.pdf、没有页面截图 | 点左侧「LLM 重新分块」：会**先补渲染页面**（`pages/`）再读图；也可以重新导入一次 PDF |
| 日志里出现 `LLM 分块不可用（…）` | 模型这次没给出可用的锚点（推理/截断/改写原句） | 已内置"关推理 + 换直连通道重试"；仍失败会退回规则分块，界面会显示原因。可以隔一会儿再点一次「LLM 重新分块」 |
| 长题干看不到下面的解答框 | 旧版中栏不是滚动容器 | 已修：中栏整体滚动，题干在自己的框里滚（`max-height:34vh`）；升级后刷新页面即可 |
| 端口被占用 | 旧进程还在 | `lsof -nP -iTCP:3084 -sTCP:LISTEN` 找到后 `kill <PID>`，或 `--port 4000` |
| 改了代码界面没变 | 产物没重建 | 重启脚本（会自动比时间戳重建），或手动 `npm run build` |
| `profile not found` | `$DSH_HOME/profiles/exercise` 链接丢了 | 重跑 `./scripts/exercise-mac.sh --setup-only` |

自检（只读，不改任何东西）：

```bash
bash scripts/diagnose-frontend.sh     # 端口/产物/链接/服务版本一览
node scripts/verify-shell-portability.mjs
npm test -w @aemeath/dsh-plugin-exercise   # 151 项断言
```

---

## 八、开发时改代码

```bash
npm run build -w @aemeath/dsh-plugin-exercise   # 只建这一个包
npm run build                                   # 或全部（按依赖顺序）
npm test -w @aemeath/dsh-plugin-exercise        # 6 个测试文件 / 151 断言
npm run typecheck:client -w @aemeath/dsh-plugin-exercise   # 只查前端类型
```

改前端（`src/client/**`）之后**必须**重建 `lib/client.js`（`npm run build` 会做）；
启动脚本也会自动比对时间戳重建。`packages/**/lib/` 是 gitignore 的，`git pull` 不会更新它。

---

## 九、和课堂模式的区别（一分钟看懂）

| | 课堂模式（lecture） | 习题模式（exercise） |
|---|---|---|
| 干什么 | 上课记笔记 → 课后五步复盘 | 每周作业：导入 → 做题 → 检查 → 交 |
| 端口 | 3083 | **3084** |
| 数据 | `library/physicist/lectures/` | `library/physicist/exercises/` |
| 与主 agent | **刻意隔离**（课堂数据不外流） | **汇入**（错题/经验进 worldbook + 错题本） |
| LLM 角色 | 转录员（不剧透）+ 复盘引导 | 批改助教（指出问题，不给解法） |
| 提交物 | handoff.json（进度+短板） | **合并 PDF**（原卷+解答）+ handoff.json |
