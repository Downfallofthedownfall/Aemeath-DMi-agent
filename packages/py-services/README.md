# packages/py-services — v1 Python 微服务 → dsh MCP 形态（合并产物）

> 自 v1（`electron-app/`，tag `v1.0`）迁移。每个服务 = 一个 MCP stdio server，
> 由 dsh `mcp-client` 插件拉起，模型侧工具名 `mcp__<serverName>__<rawName>`。
> 帧格式：换行分隔 JSON（对齐 `@modelcontextprotocol/sdk` 1.x）。

## 服务一览

| 服务 | serverName | 工具 | 运行解释器 | 依赖状态 |
|---|---|---|---|---|
| `sympy_mcp/` | `sympy` | compute_symbolic / compute_numeric / compute_plot / compare_answers | 系统 python 3.14 | ✅ 已具备 |
| `vision_mcp/` | `vision` | detect_screen / ocr_screen / describe_screen | 系统 python 3.14 | ✅ 已具备（yolov8n.pt 在本目录） |
| `tts_mcp/` | `tts` | tts_generate | `D:\index-tts\.venv\Scripts\python.exe`（py3.10+torch） | ✅ 已具备 |
| `control_mcp/` | `control` | control_mouse_* / control_keyboard_* / control_window_* / control_open / control_position | 系统 python 3.14 | ✅ 已具备 |

## 运行（MCP server 由 dsh 自动拉起，也可手动调试）

```powershell
# 手动跑一个 server（按行读 stdin、按行写 stdout）
python packages/py-services/sympy_mcp/server.py
D:\index-tts\.venv\Scripts\python.exe packages/py-services/tts_mcp/server.py --model-dir D:\index-tts
```

## 自检

```powershell
python packages/py-services/selftest.py            # 全部
python packages/py-services/selftest.py --server sympy    # 单个
```

## 配置（profiles/*/cordis.patch.yml）

```yaml
- insert:
    - id: mcp-sympy
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: sympy
        command: python
        args: ['packages/py-services/sympy_mcp/server.py']
        cwd: '.'            # dsh.ps1 固定仓库根为 cwd
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

要点：
- `cwd` 用仓库根（`scripts/dsh.ps1` 固定），`args` 用相对路径，四个 server 统一。
- `tts` 的 `command` 必须指向 IndexTTS venv 的 python.exe（`D:\index-tts\.venv\Scripts\python.exe`），
  并传 `--model-dir D:\index-tts`；首调用加载 3.4GB 模型，`toolCallTimeoutMs` 给足（≥300000）。
- `failOnStartupError: false`：缺依赖时不拖垮主 profile（服务降级为不可用）。
- `vision` 首次 OCR 加载 EasyOCR 较慢，`toolCallTimeoutMs` ≥120000。

## 安全说明

- symbolic/numeric 沿用 v1 的受限子进程沙箱（白名单 import + 禁用危险内建 + 内存限制
  + 超时钳制）；这是"尽力而为"，真实边界是本地子进程隔离。
- `control` 系列工具会真实操作键鼠/窗口，建议在 dsh 侧对 `mcp__control__*` 挂审批
  （tools/pre-execute ask），当前 profile 默认放行（本地个人使用，与 v1 AUTH_TOKEN 本地态等价）。
- TTS 合成产物写入 `voices/tts/`（`.gitignore` 已忽略 `.wav`）。

## 已修复的坑（2026-08-14 实测，务必遵守）

1. **协议通道与 stdout 隔离**（mcp_core）：`_send` 锁定进程启动时的原始 stdout
   （`_PROTO_STDOUT`）；工具执行与预热线程内的 `redirect_stdout(sys.stderr)` 是进程级
   全局替换，若 `_send` 用 `sys.stdout` 会被一起重定向 → 客户端永远收不到响应。
2. **剪贴板写入必须校验**（control_mcp `_clipboard_set_verified`）：pyperclip 在剪贴板
   被占用时静默失败，粘贴的是旧内容 → **中文输入乱码的根因**。写后读回比对，失败重试，
   仍失败则放弃粘贴并报错。
3. **EasyOCR 空图像 readtext 会毒化 reader**：预热里对零矩阵做 readtext 后，后续
   readtext 全部返回空。预热只允许 `_get_ocr()` 加载 reader，禁止空识别。
4. **`_get_ocr` 加载窗口**：`_ocr_loaded=True` 但 `_ocr_reader=None`（另一线程加载中）
   时快速路径会返回 None → 该次 OCR 空结果。必须走 `_ocr_load_lock` 等加载完成。
5. **YOLO 首次推理不能在预热线程做**：与工具线程并发首次推理会触发 ultralytics
   predictor 懒初始化竞态（`self.predictor` 为 None → "'NoneType' object is not
   callable"）。预热只管 EasyOCR；YOLO 首推由工具线程在 `_model_infer_lock` 内串行完成。
