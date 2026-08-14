# -*- coding: utf-8 -*-
# ============================================================
# mcp_core.py — 极简 MCP stdio server 框架（零第三方依赖）
#
# 供 packages/py-services/ 下各服务复用。协议要点（对齐
# @deepseek-ai/dsh-mcp-client 所依赖的 @modelcontextprotocol/sdk）：
#   - 传输：stdin/stdout，换行分隔 JSON（每行一个 JSON-RPC 2.0 消息）
#   - 生命周期：initialize → notifications/initialized → tools/list → tools/call
#   - 工具 schema 必须是 dsh-tools 支持的 JSON Schema 子集
#     （type/oneOf/properties/required/additionalProperties/items/enum/const
#       + title/description/default 等注解；无 format/pattern/数值边界）
#   - 所有日志一律写 stderr（stdout 是协议通道，不可污染）
# ============================================================
import os
import sys
import json
import contextlib
import traceback

# 协议通道：锁定进程启动时的原始 stdout。库/预热线程可能用 redirect_stdout
# 临时替换 sys.stdout（进程级全局），_send 永远走这个通道，保证响应不被吞。
_PROTO_STDOUT = sys.stdout

# 调试：AEMEATH_MCP_DEBUG=1 时把异常堆栈额外写进文件（管道 stderr 常被客户端丢弃）
_DEBUG_FILE = None
if os.environ.get('AEMEATH_MCP_DEBUG'):
    import tempfile
    _DEBUG_FILE = open(os.path.join(tempfile.gettempdir(), "mcp_core_debug.log"), "a",
                       encoding="utf-8")


def _debug_log(text: str):
    if _DEBUG_FILE is not None:
        try:
            _DEBUG_FILE.write(text + "\n")
            _DEBUG_FILE.flush()
        except Exception:  # noqa: BLE001
            pass


class McpServer:
    def __init__(self, name: str, version: str = "0.1.0"):
        self.name = name
        self.version = version
        self._tools = {}  # name -> {fn, description, inputSchema}

    # ---- 工具注册 ----
    def tool(self, name: str, description: str, input_schema: dict):
        """装饰器：注册一个 MCP 工具。input_schema 必须为 dsh 支持子集。"""

        def deco(fn):
            self._tools[name] = {
                "fn": fn,
                "description": description,
                "inputSchema": input_schema,
            }
            return fn

        return deco

    # ---- 消息收发 ----
    def _send(self, msg: dict):
        _PROTO_STDOUT.write(json.dumps(msg, ensure_ascii=False) + "\n")
        _PROTO_STDOUT.flush()

    def _log(self, msg: str):
        sys.stderr.write(msg + "\n")
        sys.stderr.flush()

    def _handle(self, msg: dict):
        method = msg.get("method")
        msg_id = msg.get("id")
        is_notification = "id" not in msg

        try:
            if method == "initialize":
                params = msg.get("params", {}) or {}
                proto = params.get("protocolVersion", "2024-11-05")
                self._send({
                    "jsonrpc": "2.0", "id": msg_id, "result": {
                        "protocolVersion": proto,          # 回显客户端版本，避免协商失败
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": self.name, "version": self.version},
                    },
                })
            elif method == "notifications/initialized":
                pass  # 通知，无需响应
            elif method == "tools/list":
                tools = [
                    {"name": n, "description": t["description"], "inputSchema": t["inputSchema"]}
                    for n, t in self._tools.items()
                ]
                self._send({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": tools}})
            elif method == "tools/call":
                self._handle_call(msg_id, msg.get("params", {}) or {})
            elif method == "ping":
                self._send({"jsonrpc": "2.0", "id": msg_id, "result": {}})
            else:
                if not is_notification:
                    self._send({"jsonrpc": "2.0", "id": msg_id,
                                "error": {"code": -32601, "message": f"method not found: {method}"}})
        except Exception as e:  # noqa: BLE001
            self._log(f"[mcp_core] 处理 {method} 异常: {traceback.format_exc()}")
            if not is_notification:
                self._send({"jsonrpc": "2.0", "id": msg_id,
                            "error": {"code": -32603, "message": str(e)}})

    def _handle_call(self, msg_id, params: dict):
        name = params.get("name")
        args = params.get("arguments") or {}
        tool = self._tools.get(name)
        if tool is None:
            self._send({"jsonrpc": "2.0", "id": msg_id,
                        "error": {"code": -32602, "message": f"unknown tool: {name}"}})
            return
        try:
            # 工具执行期间把 stdout 重定向到 stderr：库（ultralytics/matplotlib/…）
            # 的日志输出不能污染 MCP 协议通道（stdout 只走换行分隔 JSON）。
            with contextlib.redirect_stdout(sys.stderr):
                result = tool["fn"](**args)
            text = json.dumps(result, ensure_ascii=False)
            self._send({"jsonrpc": "2.0", "id": msg_id,
                        "result": {"content": [{"type": "text", "text": text}]}})
        except TypeError as e:
            # 参数不匹配：把签名错误原样返回（模型可据此修正参数）
            tb = traceback.format_exc()
            self._log(f"[{self.name}] 工具 {name} TypeError:\n{tb}")
            _debug_log(f"[{self.name}] 工具 {name} TypeError:\n{tb}")
            self._send({"jsonrpc": "2.0", "id": msg_id,
                        "result": {"content": [{"type": "text",
                                                 "text": json.dumps({"success": False,
                                                                     "error": f"参数错误: {e}"},
                                                                    ensure_ascii=False)}],
                                   "isError": True}})
        except Exception as e:  # noqa: BLE001
            tb = traceback.format_exc()
            self._log(f"[{self.name}] 工具 {name} 执行异常:\n{tb}")
            _debug_log(f"[{self.name}] 工具 {name} 执行异常:\n{tb}")
            self._send({"jsonrpc": "2.0", "id": msg_id,
                        "result": {"content": [{"type": "text",
                                                 "text": json.dumps({"success": False,
                                                                     "error": str(e)},
                                                                    ensure_ascii=False)}],
                                   "isError": True}})

    # ---- 主循环 ----
    def run(self):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
        self._log(f"[{self.name}] MCP server 启动（{self.name} v{self.version}，"
                  f"{len(self._tools)} 个工具）")
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                self._log(f"[mcp_core] 忽略无法解析的行: {line[:200]}")
                continue
            if isinstance(msg, dict):
                try:
                    self._handle(msg)
                except Exception:  # noqa: BLE001
                    self._log(f"[mcp_core] 致命异常:\n{traceback.format_exc()}")
