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
  │ 你打速记（# 主题 / = 公式 / ? 疑问 /     │
  │           ! 重点 / > 例子 / --- 分块）    │
  │  ↓                                       │
  │ 强制留白：[我的理解] [我的疑问]           │
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

完整论证见 [`docs/lecture-mode-plan.md`](../../docs/lecture-mode-plan.md) §2。

---

## 快速开始

### 方式 A：在主程序里用（Windows 日常，推荐）

lecture **已挂进 aemeath 主 profile**，与 memory / worldbook / retriever 并存：

```powershell
cd app
npm start          # 托管 dsh（3081）+ 打开品牌窗口
```

窗口打开后，**侧边栏底部有蓝色的「课堂」胶囊按钮** —— 点它打开全屏课堂界面。

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
npm test  -w @aemeath/dsh-plugin-lecture        # 195 项断言
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

## 工具清单

| 工具 | 用途 |
|---|---|
| `lecture_session_start` | 开始一节课（课程不存在则创建；写磁盘指针） |
| `lecture_capture` | 记录速记（强制留白不填不继续；触发后台转录） |
| `lecture_status` | 查看当前课堂状态 / 留白完成情况 |
| `lecture_review_start` | 开始五步复盘（可断点续做） |
| `lecture_review_submit` | 提交"你先说"或补漏回答（返回对照 / 下一个追问） |
| `lecture_review_next` | 推进一步（repair→candidates 才生成摘要） |
| `lecture_export_handoff` | 导出握手包（进度 + 短板 + 粗略单元内容） |

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
| `check.mjs` | 24 | 标记语法解析 / 回写往返 / 强制留白 / front-matter |
| `check2.mjs` | 30 | 存储往返 / **目录穿越防护** / **UTF-8 BOM** / D3 分离 |
| `check3.mjs` | 39 | 转录员 / 五步状态机 / **D4 门控** / **D12 护栏** / 握手 / **记号约定** |
| `check4.mjs` | 12 | **工具链回归**（checkpoint flush 时序 + 重启恢复） |
| `check5.mjs` | 55 | **数学符号边栏**（数据完整性 / 光标落点 / 模板插槽 / Tab 跳转） |
| `check6.mjs` | 16 | **P3 前端契约**：D3 不泄漏（含反例）/ 服务端留白 |
| `check7.mjs` | 19 | **P4 握手接收侧**：过守门员 / D4 双端门控 / dry_run |

---

## 前端（P3）

挂在 `shell.overlay` 的**全屏课堂界面**（宿主没有 tab 系统，overlay 是唯一的加法座位）。

| 页签 | 内容 |
|---|---|
| 课堂记录 | 速记输入（标记语法）+ **强制留白**（不填不能提交）+ **数学符号边栏** |
| 课后复盘 | 五步：你先说 → 对照三栏 → 苏格拉底式补漏 → 候选条目 → 逐条确认 |
| 课程总览 | 课程分类归纳、复盘进度、留白状态 |

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

- **前端界面**（P3）：五步复盘逻辑完整且有测试，但没有 UI
- **主 agent 侧导入入口**（P4）：`handoff.json` 能生成，接收侧未做
  —— 做的时候**必须跑 gatekeeper**，别直接 `ctx.memory.save()`

---

## 相关文档

- [`docs/lecture-mode-plan.md`](../../docs/lecture-mode-plan.md) — 执行计划（14 项决策 / 代码核实依据 / 分期）
- [`docs/lecture-devlog.md`](../../docs/lecture-devlog.md) — 开发日志
- [`packages/memory/dsh-plugin-memory`](../memory/dsh-plugin-memory) — 主记忆层（lecture **不**直接依赖）
- [`packages/retriever/dsh-plugin-retriever`](../retriever/dsh-plugin-retriever) — 讲义检索（消费导出的 `.md`）
