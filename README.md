# 🤖 Aemeath-DMi Agent v2 · 星炬 · 物理学习 Copilot

> **定位：物理学习 Copilot**。用汉堡大学 Physik I / Math I 的真实讲义、历年 Altklausur 真题和每周真实使用记录，训练一个"会算、会证、会带来源、不会就承认"的学习引擎——星炬。
>
> 爱弥斯（桌宠）是它的脸：注意力入口与陪伴，人格与知识完全隔离。一个引擎，两种皮肤。
>
> 🇨🇳 v2 基于 DeepSeek Harness（dsh）插件体系重构，**平台只是引擎，护城河是物理内容轨**：Worldbook 知识库、真题基准、每周使用日志（见 [docs/usage-log.md](docs/usage-log.md) 与迁移计划 `docs/v2-migration-plan.md`）。

---

## 🎓 星炬能做什么（当前进度：M0 引擎骨架）

| 能力 | 状态 | 说明 |
|---|---|---|
| 双角色（星炬/爱弥斯）双 agent 隔离 | ✅ M0 | dsh-persona 机制，人格按 agent 隔离 |
| OOC 规则层 | ✅ M0 | 越界回复自动纠偏（LLM 判定层 M6） |
| 冒烟工具 aemeath/version | ✅ M0 | 工具注册 + 会话日志验证 |
| Worldbook 物理知识库（30 条） | 🧪 M2 | 计划中：30 条 Physik I + Math I |
| 分层记忆 L1/L2/L3 + 守门员 | 🧪 M3 | 计划中 |
| 讲义检索 + Altklausur 真题基准 | 🧪 M4 | 计划中：六项指标可复现 |
| 解题工作流（SymPy 验证） | 🧪 M6 | 计划中：先算后答 |
| 记忆管理 / 审批 diff / 桌宠壳 | 🧪 M5 | 计划中 |

> 完整里程碑与验收见 `docs/v2-migration-plan.md`（§5）。

## 内容轨（与开发并行，护城河本体）

- **Worldbook 30 条**（M2 期间）：`packages/worldbook/data/scholar/`
- **Altklausur 真题**（M4 前）：Fachschaft 收集 → `packages/benchmark/altklausur/`
- **每周 ≥2h 真实学习**：`docs/usage-log.md`（本周记录：M0 冒烟）

---

## 🚀 快速开始（v2）

```bash
# 前置：Node 20+、npm、dsh CLI（@deepseek-ai/dsh@0.1.0-rc.6）
# 安装插件依赖并编译（profile 依赖用 --legacy-peer-deps，避免 dsh 核心包双份）
npm install --cache .npm-cache
npm run build
cd profiles\aemeath && npm install --legacy-peer-deps --cache ..\..\.npm-cache && cd ..\..
cd profiles\aemeath-run && npm install --legacy-peer-deps --cache ..\..\.npm-cache && cd ..\..

# 一次性冒烟（headless，无需浏览器）
.\scripts\dsh.ps1 --profile aemeath-run "你好，自我介绍"

# Web UI（主 profile，端口 3081）
.\scripts\dsh.ps1 --profile aemeath --port 3081
```

> `scripts/dsh.ps1` 固定项目内 DSH_HOME（`.dsh-home/`，gitignored），不干扰全局 web profile。

## 🛠️ 技术栈

| 技术 | 用途 |
|---|---|
| **DeepSeek Harness（dsh）rc.6** | agent loop、工具流水线、会话事件溯源、审批、插件体系（引擎） |
| DeepSeek API | 对话模型（deepseek-v4-flash） |
| TypeScript（插件）· Cordis | dsh 插件 monorepo（`packages/`） |
| Python 微服务（MCP，v1 迁移） | SymPy 计算 / YOLO-OCR 视觉 / IndexTTS2 语音 / 键鼠控制，经 dsh `mcp-client` 接入（`packages/py-services/`） |
| SQLite FTS5（M4） | 讲义检索（BM25） |
| Electron（M5） | 桌宠壳（file:// + IPC 桥） |

## 📁 结构

```
packages/            # v2 插件 monorepo（worldbook/memory/retriever/workflow/benchmark/py-services/shared/ui）
packages/py-services/# v1 Python 微服务 → MCP server（sympy/vision/tts/control，mcp_core 零依赖）
profiles/            # dsh profile（aemeath=Web 主 profile，aemeath-run=一次性/基准）
scripts/dsh.ps1      # dsh 包装脚本（项目内 DSH_HOME）
docs/                # 迁移计划 + 使用日志（gitignored）
electron-app/        # v1（冻结，tag v1.0；已迁移文件删除，仅留壳参考）
```

---

## ⚠️ 免责声明

本项目为粉丝同人作品，角色「爱弥斯」「星炬」及其世界观出自游戏《鸣潮》（Kuro Games 库洛游戏）。本项目与 Kuro Games 无任何关联，未获其官方授权；仅供学习交流使用，**禁止商用**；角色美术、语音等素材版权归原作者/版权方所有；如涉及侵权，请联系删除相关内容。

## 📄 许可证

MIT License（代码部分）
