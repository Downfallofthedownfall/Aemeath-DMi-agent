# 课堂模式 · macOS 使用说明

> 你在 mac 上唯一需要的东西。**主 agent 在 mac 上不存在，也不需要**。

---

## 一、启动（最常用）

macOS 自带的是 **bash 3.2**，且**默认 PATH 里没有 Node**（Homebrew 装的 node
在 `/opt/homebrew/bin`，nvm 装的在 `~/.nvm/...`）。所以**不要直接双击 .sh**，
用下面这个入口 —— 它会自己找 Node。

### 方式 A：双击（推荐）

在 Finder 里进入仓库目录，**双击 `lecture-launch.command`**。

- 会自动找 Node（`/opt/homebrew/bin`、`/usr/local/bin`、nvm、volta、fnm 都试一遍）
- 需要时自动装依赖、构建
- 启动后**自动打开浏览器**
- **终端窗口不要关**（关了服务就停了）

> 第一次双击若提示「无法打开，因为它来自身份不明的开发者」：
> **右键 → 打开 → 打开**（macOS 的 Gatekeeper 只拦第一次）。
>
> 若提示「Permission denied」，先跑一次 `chmod +x lecture-launch.command`。

### 方式 B：命令行

```bash
cd ~/aemeath-dmi-agent          # 换成你的路径
./lecture-launch.command
```

### 方式 C：只要服务，不要自动开浏览器

```bash
./scripts/lecture-mac.sh              # 默认 3083
./scripts/lecture-mac.sh --port 4000  # 换端口
AEMEATH_LECTURE_PORT=4000 ./lecture-launch.command   # 入口也支持换端口
```

终端会打印带 token 的地址，**手动复制到浏览器**打开即可。

### 停止

关掉终端窗口，或在该窗口按 **Control-C**。

---

## 二、Node 相关（脚本已自动处理，这里只解释）

启动脚本按这个顺序找 Node：

| 顺序 | 位置 | 说明 |
|---|---|---|
| 1 | 已在 PATH 里的 `node` | 如果终端能用，就直接用 |
| 2 | `/opt/homebrew/bin` | **Apple Silicon 的 Homebrew** |
| 3 | `/usr/local/bin` | Intel Mac 的 Homebrew / 官网安装包 |
| 4 | `~/.nvm/versions/node/*/bin` | nvm（取任意一个版本） |
| 5 | `~/.volta/bin`、`~/.fnm/...` | 其他版本管理器 |

**都找不到**会明确报错并告诉你去哪装，不会静默失败。

要求 **Node 20 或更新**。检查：

```bash
node -v      # 应输出 v20.x 或更高
```

没装的话：官网 https://nodejs.org 下 LTS 双击安装，或 `brew install node`。

> **为什么不双击 `.sh`**：macOS 双击 `.sh` 会用 Terminal 跑，
> 但**不会加载你的 `~/.zshrc`** → PATH 里没有 node → 报 `node: command not found`。
> `.command` 入口是专门为此写的，它自己带 PATH 引导。

---

## 三、切到课堂界面

启动后浏览器打开的是 **dsh 服务**，课堂界面**直接铺满整屏**（独立模式）。

看到的应该是：

```
┌──────────┬────────────────────┬──────────────┐
│ 课程/单元 │ 笔记（本次课）      │ ∑ 符号 / 复盘 │
└──────────┴────────────────────┴──────────────┘
```

**如果看到的是 dsh 原生界面**（有「新会话」「插件」「工作区」）：
说明 host 代码没重新构建。跑一次：

```bash
npm run build
```

再重启。启动脚本现在会自动检测（源码比产物新就重建），正常不该遇到。

---

## 四、日常流程

### 1. 建课程

右上角 **「＋ 新的一节」** → 选 **「新建一门课程」** → 填：

| 字段 | 例子 | 说明 |
|---|---|---|
| 课程标识 | `physik-2` | 只能用字母/数字/`.`/`_`/`-`，会成为文件夹名 |
| 课程全名 | `Physik II` | 显示用 |
| 学期 | `WiSe 2026` | 可选 |
| 这次课讲什么 | `第1讲 热力学` | 必填 |

点 **「开始这节课」**。

> 想往**已有课程**加新的一讲：同一个入口，选「记到已有课程」即可。

### 2. 记笔记 —— 在**主界面**里记

**这点最容易搞错**：课堂工作台是**回顾/查阅/复盘**的地方，
**记笔记要在对话里做**（因为输入 100% 走 LLM 规范化）。

在工作台的对话区直接写你听到的内容，用标记语法：

| 写法 | 含义 |
|---|---|
| `# 主题` | 小标题 |
| `= 公式` | 公式（后台会补 LaTeX） |
| `? 疑问` | 疑问 |
| `! 重点` | 重点 |
| `> 例子` | 例子 |
| `---` | 分成两块 |

**关于「我的理解 / 我的疑问」**：
这两栏**只能你自己写**，爱弥斯**不会替你写**（那是主动回忆的核心）。
你说了它才记；没说它会问你 —— 不要让它代笔。

### 3. 查符号

右栏 **「∑ 符号」** 常驻，点符号即**复制到剪贴板**，
然后到对话输入框 **⌘V 粘贴**。

分组：微积分 / 求和与连乘 / 根号与上下标 / 矢量与导数记号 /
三角函数 / 希腊字母。顶部可搜索（试 `积分`、`sum`、`矢量`）。

支持 Tab 跳插槽（如 `∫ 上下限`）。

### 4. 复盘

右栏点 **「复盘」** → 按步骤走（先说你的理解 → 对照 → 收敛 → 出摘要）。
**摘要只有在复盘走完后才生成**。

### 5. 删除

左栏课程/单元行**悬停时右侧出现 ✕**：

| 删什么 | 效果 |
|---|---|
| 单元行的 ✕ | 删这一讲（速记 + 加工结果 + 复盘记录），**课程保留** |
| 课程名右侧的 ✕ | 删整门课（含目录） |

**都会二次确认**，且**不可撤销**。

---

## 五、数据在哪

```
packages/library/physicist/lectures/
  <课程标识>/
    index.json          课程与单元清单
    <日期>-<单元>.md     速记本体（人可读，可直接改）
    <单元>.raw.json      后台加工结果（前端看不到）
    <单元>.summary.json  复盘后的摘要
```

**纯文件，可以直接编辑/备份/git 管理。**

---

## 六、出问题时

### 先跑诊断

```bash
bash scripts/diagnose-frontend.sh
```

它只读不写，会报告：产物时间、产物内容新旧、链接是否正常、
端口占用、服务提供的版本、源码是否需要重建。**把输出发我即可。**

### 常见症状

| 症状 | 原因 | 处理 |
|---|---|---|
| `node: command not found` | 双击的是 `.sh` 而不是 `.command` | 用 `lecture-launch.command` |
| `Permission denied` | 没有执行权限 | `chmod +x lecture-launch.command` |
| 来自身份不明的开发者 | Gatekeeper | 右键 → 打开 → 打开 |
| 界面是 dsh 原生的 | host 产物旧 | `npm run build` 后重启 |
| 端口被占用 | 旧进程还在 | `lsof -nP -iTCP:3083 -sTCP:LISTEN` 找到后 `kill <PID>` |
| 不能创建会话 / unknown preset | profile 没声明 preset | 跑诊断脚本，看第 7 项版本 |
| 课堂内 LLM 不可用 | 没配 API key | 界面左下角**设置 → Models** 里填 |

### 配 API key

**启动后**在界面左下角 **设置 → Models** 填 DeepSeek key。写进
`.dsh-home/.credentials.yaml`，**改完不用重启**。

不填也能用：速记照记、复盘照做，只是公式不做 LaTeX 规范化。

---

## 七、开发时改代码

改了 `packages/**/src` 之后：

```bash
npm run build          # 或直接重启，启动脚本会自动检测并重建
```

**注意**：`packages/**/lib/` 被 gitignore —— `git pull` **只更新源码不更新产物**。
启动脚本会比较"源码 vs 产物"的时间戳自动重建
（**host 和 client 都比**，这是踩过坑的地方）。

想手动确认：

```bash
git ls-files --eol scripts/lecture-mac.sh    # 应为 i/lf
node scripts/verify-shell-portability.mjs    # shell 可移植性
npm test -w @aemeath/dsh-plugin-lecture      # 257 项断言
```
