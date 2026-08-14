# -*- coding: utf-8 -*-
# ============================================================
# selftest.py — py-services MCP server 自检
# 用法：python packages/py-services/selftest.py [--server sympy|vision|tts|control]
# 行为：spawn server → initialize → tools/list → 每个工具一个冒烟调用 → 退出码
# ============================================================
import json
import os
import subprocess
import sys
import time
import argparse

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:  # noqa: BLE001
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class MCPClient:
    """极简 MCP stdio 客户端（仅测试用，换行分隔 JSON）。"""

    def __init__(self, argv, cwd, startup_wait=3.0):
        self.proc = subprocess.Popen(
            argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace',
            bufsize=1,
        )
        self.id = 0
        time.sleep(startup_wait)  # 给模型导入/启动留时间

    def send(self, method, params=None, notify=False):
        self.id += 1
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            msg["id"] = self.id
        self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        if notify:
            return None
        return self.recv()

    def recv(self, timeout=300):
        # 阻塞读一行；EOF 且进程已退出 = 服务器崩溃（立即报错，不再空转）
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"server 已退出 rc={self.proc.returncode}，"
                                   f"stderr={self.proc.stderr.read()[-2000:]}")
            line = self.proc.stdout.readline()
            if not line:
                time.sleep(0.1)
                continue
            msg = json.loads(line)
            if msg.get("id") == self.id:
                return msg
        raise TimeoutError(f"等待响应超时（{timeout}s）")

    def close(self):
        try:
            self.proc.kill()
        except Exception:  # noqa: BLE001
            pass

    def stderr_tail(self):
        try:
            return self.proc.stderr.read()[-1500:]
        except Exception:  # noqa: BLE001
            return ""


SERVERS = {
    "sympy": {
        "argv": [sys.executable, "packages/py-services/sympy_mcp/server.py"],
        "smoke": [
            ("compute_symbolic", {"expression": "integrate(sin(x),x)"}),
            ("compute_numeric", {"code": "import numpy as np\nprint(np.sqrt(2))"}),
            ("compute_plot", {"expression": "x**2"}),
            ("compare_answers", {"a": "x**2-1", "b": "(x-1)*(x+1)"}),
        ],
    },
    "vision": {
        "argv": [sys.executable, "packages/py-services/vision_mcp/server.py"],
        "smoke": [
            ("detect_screen", {}),
        ],
        "startup_wait": 25.0,
    },
    "tts": {
        "argv": [r"D:\index-tts\.venv\Scripts\python.exe",
                 "packages/py-services/tts_mcp/server.py", "--model-dir", r"D:\index-tts"],
        "smoke": [],
        "startup_wait": 15.0,
    },
    "control": {
        "argv": [sys.executable, "packages/py-services/control_mcp/server.py"],
        "smoke": [
            ("control_position", {}),
        ],
    },
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", choices=list(SERVERS), default=None, help="只测指定服务")
    args = parser.parse_args()

    targets = list(SERVERS) if args.server is None else [args.server]
    failed = []
    for name in targets:
        spec = SERVERS[name]
        print(f"\n===== {name} =====")
        client = None
        try:
            client = MCPClient(spec["argv"], ROOT, spec.get("startup_wait", 3.0))
            init = client.send("initialize", {"protocolVersion": "2025-06-18",
                                              "capabilities": {}, "clientInfo": {"name": "selftest"}})
            assert init.get("result", {}).get("protocolVersion") == "2025-06-18", "initialize 版本回显失败"
            client.send("notifications/initialized", notify=True)
            lst = client.send("tools/list")
            tools = {t["name"] for t in lst["result"]["tools"]}
            print(f"  tools ({len(tools)}): {sorted(tools)}")
            for tool_name, targs in spec["smoke"]:
                if tool_name not in tools:
                    print(f"  ✗ {tool_name}: 未注册")
                    failed.append(name)
                    continue
                res = client.send("tools/call", {"name": tool_name, "arguments": targs})
                result = res.get("result", {})
                content = result.get("content", [{}])
                text = content[0].get("text", "") if content else ""
                parsed = json.loads(text) if text else {}
                ok = parsed.get("success", False) and not result.get("isError")
                print(f"  {'✅' if ok else '✗'} {tool_name}: {text[:200]}")
                if not ok:
                    failed.append(name)
            print(f"  {name}: {'✅ 通过' if name not in failed else '✗ 失败'}")
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {name}: {e}")
            if client:
                print(f"    stderr: {client.stderr_tail()}")
            failed.append(name)
        finally:
            if client:
                client.close()

    print("\n===== 结果 =====")
    if failed:
        print(f"✗ 失败: {sorted(set(failed))}")
        sys.exit(1)
    print("✅ 全部通过")
    sys.exit(0)


if __name__ == "__main__":
    main()
