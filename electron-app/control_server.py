# ============================================================
# control_server.py - 键盘鼠标控制服务（完整版）
# 功能：鼠标操作、键盘输入（中文/英文）、窗口切换、截图等
# 监听端口：18890
# ============================================================

import os
import sys
import json
import time
import uuid
import tempfile
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn   # 多线程支持

AUTH_TOKEN = os.environ.get('AUTH_TOKEN', '')

def _check_auth(self):
    return bool(AUTH_TOKEN) and self.headers.get('X-Auth-Token', '') == AUTH_TOKEN

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

try:
    import pyautogui
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0.2
    HAS_PYAUTOGUI = True
except ImportError:
    HAS_PYAUTOGUI = False

try:
    import pyperclip
    HAS_CLIPBOARD = True
except ImportError:
    HAS_CLIPBOARD = False

try:
    import pygetwindow as gw
    HAS_WINDOW = True
except ImportError:
    HAS_WINDOW = False

SCREEN_WIDTH, SCREEN_HEIGHT = pyautogui.size() if HAS_PYAUTOGUI else (1920, 1080)

class ControlHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        if not _check_auth(self):
            self.send_json(401, {"success": False, "error": "unauthorized"})
            return
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', ''))
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode('utf-8'))
        except Exception:
            pass  # 客户端断开就忽略

    def do_POST(self):
        if not _check_auth(self):
            self.send_json(401, {"success": False, "error": "unauthorized"})
            return
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else b'{}'

        try:
            data = json.loads(body)
        except Exception:
            data = {}

        action = data.get('action', '')

        try:
            # ========== 鼠标操作 ==========
            if action == 'move':
                x = data.get('x', SCREEN_WIDTH // 2)
                y = data.get('y', SCREEN_HEIGHT // 2)
                duration = data.get('duration', 0.3)
                pyautogui.moveTo(x, y, duration=duration)
                self.send_json(200, {"success": True})

            elif action == 'click':
                x = data.get('x', None)
                y = data.get('y', None)
                button = data.get('button', 'left')
                clicks = data.get('clicks', 1)
                if x is not None and y is not None:
                    pyautogui.click(x, y, clicks=clicks, button=button)
                else:
                    pyautogui.click(clicks=clicks, button=button)
                self.send_json(200, {"success": True})

            elif action == 'double_click':
                x = data.get('x', None)
                y = data.get('y', None)
                if x is not None and y is not None:
                    pyautogui.doubleClick(x, y)
                else:
                    pyautogui.doubleClick()
                self.send_json(200, {"success": True})

            elif action == 'right_click':
                x = data.get('x', None)
                y = data.get('y', None)
                if x is not None and y is not None:
                    pyautogui.rightClick(x, y)
                else:
                    pyautogui.rightClick()
                self.send_json(200, {"success": True})

            elif action == 'scroll':
                amount = data.get('amount', -3)
                pyautogui.scroll(amount)
                self.send_json(200, {"success": True})

            elif action == 'type':
                text = data.get('text', '')
                title = data.get('title', '')

                if not text:
                    self.send_json(200, {"success": True, "action": "type", "length": 0})
                    return

                # 可选：先聚焦目标窗口
                if title:
                    try:
                        windows = gw.getWindowsWithTitle(title)
                        if windows:
                            win = windows[0]
                            if win.isMinimized:
                                win.restore()
                            win.activate()
                            time.sleep(0.4)
                    except Exception:
                        pass

                # 保存剪贴板（粘贴后恢复）
                saved = None
                try:
                    import subprocess
                    saved = subprocess.run(
                        ['powershell', '-NoProfile', '-Command', 'Get-Clipboard -Raw'],
                        capture_output=True, text=True, timeout=5
                    ).stdout
                except Exception:
                    pass

                try:
                    import re

                    # 1. 把文本中的 \n 替换成标准标记
                    normalized = text.replace('\n', ' {ENTER} ')

                    # 2. 按 {ENTER} 分段（大小写不敏感）
                    segments = re.split(r'\{[Ee][Nn][Tt][Ee][Rr]\}', normalized)

                    for i, segment in enumerate(segments):
                        clean = segment.strip()
                        if clean:
                            pyperclip.copy(clean)
                            time.sleep(0.2)
                            pyautogui.hotkey('ctrl', 'v')
                            time.sleep(0.2)

                        if i < len(segments) - 1:
                            pyautogui.press('enter')
                            time.sleep(0.2)

                    result = {
                        "success": True,
                        "action": "type",
                        "length": len(text),
                        "segments": len(segments),
                        "focused": bool(title)
                    }
                finally:
                    # 恢复剪贴板
                    try:
                        if saved and saved.strip():
                            pyperclip.copy(saved)
                    except Exception:
                        pass

                self.send_json(200, result)

            elif action == 'hotkey':
                keys = data.get('keys', [])
                pyautogui.hotkey(*keys)
                self.send_json(200, {"success": True, "keys": keys})

            elif action == 'press':
                key = data.get('key', '')
                presses = data.get('presses', 1)
                pyautogui.press(key, presses=presses)
                self.send_json(200, {"success": True})

            # ========== 窗口操作 ==========
            elif action == 'focus_window':
                title = data.get('title', '')
                if not title:
                    self.send_json(400, {"success": False, "error": "缺少 title 参数"})
                    return
                windows = gw.getWindowsWithTitle(title)
                if not windows:
                    self.send_json(404, {"success": False, "error": f"未找到包含「{title}」的窗口"})
                    return
                win = windows[0]
                if win.isMinimized:
                    win.restore()
                win.activate()
                time.sleep(0.3)
                self.send_json(200, {"success": True, "title": win.title})

            elif action == 'list_windows':
                # 【修复】解决"静默无响应"：
                # 1) 服务端改为多线程，单个请求卡住不阻塞其他操作；
                # 2) 枚举放入独立线程 + 3 秒硬超时：即使遇到无响应窗口导致
                #    GetWindowText 卡住，也保证 3 秒内必回包（返回已收集的部分结果）；
                # 3) 逐窗口 IsWindow + try/except 隔离坏窗口。
                import threading as _threading
                try:
                    import win32gui
                    HAS_WIN32GUI = True
                except ImportError:
                    HAS_WIN32GUI = False

                results = []
                done = _threading.Event()
                err_holder = {}

                def _collect():
                    try:
                        if HAS_WIN32GUI:
                            def _enum_cb(hwnd, _lparam):
                                try:
                                    if not win32gui.IsWindow(hwnd) or not win32gui.IsWindowVisible(hwnd):
                                        return True
                                    title = (win32gui.GetWindowText(hwnd) or '').strip()
                                    if not title:
                                        return True
                                    minimized = active = False
                                    try:
                                        minimized = win32gui.IsIconic(hwnd)
                                        active = win32gui.GetForegroundWindow() == hwnd
                                    except Exception:
                                        pass  # 附加状态拿不到就算了
                                    results.append({"title": title, "minimized": minimized, "active": active})
                                except Exception:
                                    pass  # 单个窗口异常直接跳过
                                return True
                            win32gui.EnumWindows(_enum_cb, None)
                        else:
                            # 兜底：pygetwindow（慢，仅后备，同样受 3 秒超时保护）
                            for w in gw.getAllWindows():
                                try:
                                    t = (w.title or '').strip()
                                    if t:
                                        results.append({"title": t, "minimized": w.isMinimized, "active": w.isActive})
                                except Exception:
                                    continue
                    except Exception as e:
                        err_holder['error'] = str(e)
                    finally:
                        done.set()

                _threading.Thread(target=_collect, daemon=True).start()
                done.wait(timeout=3.0)   # 硬超时：绝不无限挂起

                if not results and err_holder.get('error'):
                    print(f"[Control] list_windows 失败: {err_holder['error']}")
                    self.send_json(200, {"success": False, "error": f"list_windows failed: {err_holder['error']}"})
                    return
                print(f"[Control] list_windows: {len(results)} 个窗口 (timed_out={not done.is_set()})")
                self.send_json(200, {
                    "success": True,
                    "windows": results[:30],
                    "timed_out": not done.is_set(),   # True 说明有窗口卡住，返回的是部分列表
                })

            elif action == 'minimize_window':
                title = data.get('title', '')
                if not title:
                    self.send_json(400, {"success": False, "error": "缺少 title 参数"})
                    return
                windows = gw.getWindowsWithTitle(title)
                if not windows:
                    self.send_json(404, {"success": False, "error": f"未找到包含「{title}」的窗口"})
                    return
                windows[0].minimize()
                self.send_json(200, {"success": True})

            elif action == 'close_window':
                title = data.get('title', '')
                if not title:
                    self.send_json(400, {"success": False, "error": "缺少 title 参数"})
                    return
                windows = gw.getWindowsWithTitle(title)
                if not windows:
                    self.send_json(404, {"success": False, "error": f"未找到包含「{title}」的窗口"})
                    return
                windows[0].close()
                self.send_json(200, {"success": True})

            # ========== 其他 ==========
            elif action == 'position':
                x, y = pyautogui.position()
                self.send_json(200, {"success": True, "x": x, "y": y})

            elif action == 'screenshot':
                region = data.get('region', None)
                if region:
                    im = pyautogui.screenshot(region=tuple(region))
                else:
                    im = pyautogui.screenshot()
                path = os.path.join(tempfile.gettempdir(), f"screenshot_{uuid.uuid4().hex[:8]}.png")
                im.save(path)
                self.send_json(200, {"success": True, "path": path, "size": f"{im.width}x{im.height}"})

            elif action == 'open':
                program = data.get('program', '').lower()

                ALLOWED_PROGRAMS = {
                    'notepad': 'notepad.exe',
                    'calc': 'calc.exe',
                    'explorer': 'explorer.exe',
                    'cmd': 'cmd.exe',
                    'powershell': 'powershell.exe',
                    'msedge': 'msedge.exe',
                    'chrome': 'chrome.exe',
                    'firefox': 'firefox.exe',
                    'mspaint': 'mspaint.exe',
                    'taskmgr': 'taskmgr.exe',
                    'control': 'control.exe',
                }

                if program in ALLOWED_PROGRAMS:
                    import os as _os
                    _os.startfile(ALLOWED_PROGRAMS[program])   # 不经 shell，无注入
                elif program.endswith('.exe') and os.path.isfile(program):
                    os.startfile(program)
                elif program.startswith(('https://', 'http://')):
                    import webbrowser
                    webbrowser.open(program)
                else:
                    self.send_json(403, {"success": False, "error": f"程序 '{program}' 不在白名单中"})
                    return

                # 如果有 text 参数，等一秒后自动输入
                text = data.get('text', '')
                if text:
                    time.sleep(1.0)
                    windows = gw.getWindowsWithTitle(program)
                    if windows:
                        win = windows[0]
                        if win.isMinimized:
                            win.restore()
                        win.activate()
                        time.sleep(0.3)
                    pyperclip.copy(text)
                    time.sleep(0.2)
                    pyautogui.hotkey('ctrl', 'v')

                self.send_json(200, {"success": True, "program": program, "typed": bool(text)})

            elif action == 'open_url':
                url = data.get('url', '')
                if not url:
                    self.send_json(400, {"success": False, "error": "缺少 url 参数"})
                    return
                import webbrowser
                webbrowser.open(url)   # 不经 shell，URL 含 & 也无法逃逸
                self.send_json(200, {"success": True, "action": "open_url", "url": url})

            # ========== 快捷操作（组合指令） ==========
            elif action == 'open_and_type':
                program = data.get('program', 'notepad').lower()
                text = data.get('text', '')
                title = data.get('title', program)

                ALLOWED_PROGRAMS = {
                    'notepad': 'notepad.exe', 'calc': 'calc.exe',
                    'explorer': 'explorer.exe', 'cmd': 'cmd.exe',
                    'powershell': 'powershell.exe', 'mspaint': 'mspaint.exe',
                }
                if program in ALLOWED_PROGRAMS:
                    import os as _os
                    _os.startfile(ALLOWED_PROGRAMS[program])   # 不经 shell
                elif program.endswith('.exe') and os.path.isfile(program):
                    os.startfile(program)
                else:
                    self.send_json(403, {"success": False, "error": f"程序 '{program}' 不在白名单中"})
                    return
                time.sleep(1.0)

                # 激活窗口
                windows = gw.getWindowsWithTitle(title)
                if windows:
                    win = windows[0]
                    if win.isMinimized:
                        win.restore()
                    win.activate()
                    time.sleep(0.3)

                # 输入文字
                if text:
                    pyperclip.copy(text)
                    time.sleep(0.2)
                    pyautogui.hotkey('ctrl', 'v')

                self.send_json(200, {
                    "success": True,
                    "action": "open_and_type",
                    "program": program,
                    "text_length": len(text)
                })

            else:
                self.send_json(400, {"success": False, "error": f"未知操作: {action}"})

        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e)})

    def send_json(self, status, data):
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', ''))
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token')
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # 客户端提前断开连接，忽略
        except Exception:
            pass  # 其他写入错误也忽略

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', ''))
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def log_message(self, format, *args):
        pass


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if not HAS_PYAUTOGUI:
        print("错误: pyautogui 未安装，请执行: pip install pyautogui")
        sys.exit(1)
    if not HAS_CLIPBOARD:
        print("错误: pyperclip 未安装，请执行: pip install pyperclip")
        sys.exit(1)
    if not HAS_WINDOW:
        print("错误: pygetwindow 未安装，请执行: pip install pygetwindow")
        sys.exit(1)

    HOST = "127.0.0.1"
    PORT = 18890

    server = ThreadedHTTPServer((HOST, PORT), ControlHandler)
    print("键盘鼠标控制服务启动中...")
    print(f"  监听: http://{HOST}:{PORT}")
    print(f"  屏幕: {SCREEN_WIDTH}x{SCREEN_HEIGHT}")
    print(f"  可用操作: move, click, type(支持中文), hotkey, focus_window, etc.")
    print(f"  按 Ctrl+C 停止")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭...")
        server.server_close()


if __name__ == "__main__":
    main()
