# Third-Party Notices / 第三方组件声明

> 更新：2026-08-16 · 范围：v2（DeepSeek Harness 插件体系 + Electron 壳 + Python MCP 服务）与
> v1 冻结遗留（`electron-app/`，tag v1.0）。本文件所列许可证/协议归各权利方所有。

---

## 1. 核心引擎与框架（v2 · TypeScript / Node.js）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| DeepSeek Harness（`@deepseek-ai/dsh` 及全部 `@deepseek-ai/dsh-*` 包） | 0.1.0-rc.6 | MIT | agent loop、工具流水线、事件溯源、插件体系（引擎本体） |
| `@deepseek-ai/cordis` / `@deepseek-ai/cordis-plugin-*` | 4.0.1 / 1.x | MIT | 插件容器（双 Cordis 树：host + browser client） |
| `@deepseek-ai/schemastery` | 3.18.1 | MIT | 配置 schema |
| `@deepseek-ai/cosmokit` | 1.8.2 | MIT | 工具库 |
| Electron | 28.3.3（v1 `electron-app/` 与 v2 `app/` 当前运行实例；v2 声明 ^41.0.0） | MIT | 桌宠壳（桌面窗口 + 进程托管） |
| electron-builder | 24.x | MIT | Windows 打包（NSIS） |
| Node.js | 22.13+ | MIT | 运行环境（内嵌 npm） |
| TypeScript | 5.x | Apache-2.0 | 插件/前端源码编译 |
| esbuild | 0.2x | MIT | client bundle 打包（`packages/ui` build.mjs） |
| React / react-dom | 18.3.1 | MIT | 前端 client 插件 UI |
| zod | 4.x | MIT | 存储域 schema / 校验 |
| `@modelcontextprotocol/sdk` | 1.x | MIT | MCP 协议 |

## 2. Web 与前端运行库（dsh web / aemeath-ui 传递依赖）

| 组件 | 许可证 | 用途 |
|---|---|---|
| hono / express / express-rate-limit | MIT | Web 服务器与限流 |
| shiki / oniguruma-* | MIT | 代码高亮 |
| turndown | MIT | HTML → Markdown |
| sharp | Apache-2.0 | 图像处理 |
| openai | Apache-2.0 | LLM 客户端 |
| protobufjs | BSD-3-Clause | 协议序列化 |
| zustand / immer | MIT | 前端状态 |
| ws / eventsource / yaml / js-yaml 等其余传递依赖 | MIT / ISC / BSD-2-Clause 等 | 通用运行库 |

## 3. Python 微服务与计算/视觉/控制（v2 · `packages/py-services`）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| SymPy | 1.14 | BSD-3-Clause | 符号计算（`sympy_mcp` 沙箱白名单成员） |
| NumPy | 2.x | BSD-3-Clause | 数值计算 |
| SciPy | 1.18 | BSD-3-Clause（二进制分发包附带 OpenBLAS/LAPACK，BSD-3-Clause；GCC runtime，GPL-3.0-or-later WITH GCC-exception-3.1） | 数值积分/优化/信号 |
| Matplotlib | 3.8+ | Matplotlib License（BSD 风格，基于 PSF） | 绘图（compute_plot） |
| uncertainties | 3.1.7+ | BSD-3-Clause | 误差传播（沙箱白名单成员） |
| **Ultralytics YOLOv8** | 8.4.x | **AGPL-3.0** | 目标检测（`vision_mcp`，含权重 `yolov8n.pt`） |
| PyTorch | 2.x | BSD-3-Clause | 深度学习推理 |
| OpenCV-Python | 4.8+/5.x | Apache-2.0 | 图像处理 |
| EasyOCR | 1.7.x | Apache-2.0 | OCR 文字识别 |
| Pillow | 10+ | MIT-CMU（HPND） | 图像处理 |
| mss | 9+ | MIT | 屏幕截图 |
| PyAutoGUI | 0.9.54 | BSD-3-Clause | 键鼠控制（`control_mcp`） |
| Pyperclip | 1.11 | BSD-3-Clause | 剪贴板 |
| PyGetWindow | 0.0.9 | BSD-3-Clause | 窗口枚举 |
| pywin32 | 306+ | PSF | Win32 API（窗口列表，可选） |

> ⚠️ **AGPL-3.0 提示**：Ultralytics YOLOv8（含 `yolov8n.pt` 权重）采用 GNU Affero 通用公共许可证
> v3.0（AGPL-3.0）。若对本项目进行分发、修改或提供网络服务，请遵守 AGPL-3.0 的相应义务。
> 本项目定位为本地个人学习工具（见 README 免责声明：禁止商用），请在使用前自行评估。

## 4. 模型与音频资产

| 资产 | 位置 | 许可证/协议 | 说明 |
|---|---|---|---|
| yolov8n.pt（YOLOv8n 权重） | `packages/py-services/vision_mcp/` | AGPL-3.0（随 Ultralytics 包分发） | 目标检测权重 |
| IndexTTS2 语音合成引擎与模型 | 独立 venv（默认 `D:\index-tts`） | 代码 Apache-2.0；**模型权重另受 bilibili Index-TTS 模型使用许可协议约束（含非商用限制）** | 仅作本地个人使用；商用/分发前须取得授权（参见 https://github.com/index-tts/index-tts 与模型许可） |
| `voices/aemeath.wav` 等语音素材 | `voices/` | 本项目自有/用户提供 | 见 README 免责声明 |

## 5. v1 冻结遗留（`electron-app/`，tag v1.0，不再维护）

| 组件 | 许可证 |
|---|---|
| KaTeX | MIT |
| fastmcp / mcp-proxy | MIT |
| tsx | MIT |
| zod | MIT |
| @iflow-mcp/filesystem-mcp-server | Apache-2.0 |
| @google/genai | Apache-2.0 |
| winston / winston-daily-rotate-file | MIT |
| koa / koa-router | MIT |

> 其余 v1 传递依赖（axios、jsonwebtoken、tiktoken、sanitize-html、moment 等）均为常见 MIT /
> Apache-2.0 / ISC / BSD 许可证，详见 `electron-app/package-lock.json` 中各包 LICENSE 字段。

## 6. 远程服务

| 服务 | 说明 |
|---|---|
| DeepSeek API（`api.deepseek.com`） | 对话/推理模型（deepseek-v4-flash）由 DeepSeek 提供，按 DeepSeek 开放平台服务条款使用 |

## 7. 许可证全文

- MIT: https://opensource.org/license/mit
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
- BSD-3-Clause: https://opensource.org/license/bsd-3-clause
- AGPL-3.0: https://www.gnu.org/licenses/agpl-3.0.html
- HPND (MIT-CMU): https://opensource.org/license/hpnd
- PSF: https://www.python.org/psf/license/
- Node.js: https://raw.githubusercontent.com/nodejs/node/main/LICENSE
- Matplotlib: https://matplotlib.org/stable/project/license.html
- bilibili Index-TTS 模型许可: https://github.com/tabortao/index-tts2/blob/main/INDEX_MODEL_LICENSE

---

本项目的代码部分采用 MIT License（见 [LICENSE](LICENSE)）。角色「爱弥斯」「星炬」及其世界观出自游戏《鸣潮》
（Kuro Games），相关素材版权归原作者/版权方所有，本项目仅作学习交流、禁止商用。
