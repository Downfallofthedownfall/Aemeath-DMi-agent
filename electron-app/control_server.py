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
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok"
            }).encode('utf-8'))
        except Exception:
            pass  # 客户端断开就忽略


    
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else b'{}'
        
        try:
            data = json.loads(body)
        except:
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
            
                if not text:
                    self.send_json(200, {"success": True, "action": "type", "length": 0})
                    return
            
                import re
            
                # 1. 把文本中的 \n 替换成标准标记
                normalized = text.replace('\n', ' {ENTER} ')
            
                # 2. 按 {ENTER} 分段（大小写不敏感）
                segments = re.split(r'\{[Ee][Nn][Tt][Ee][Rr]\}', normalized)
            
                for i, segment in enumerate(segments):
                    # 先粘贴纯文本部分
                    clean = segment.strip()
                    if clean:
                        pyperclip.copy(clean)
                        time.sleep(0.2)
                        pyautogui.hotkey('ctrl', 'v')
                        time.sleep(0.2)
                
                    # 如果不是最后一段，每段后面按一次回车
                    if i < len(segments) - 1:
                        pyautogui.press('enter')
                        time.sleep(0.2)
            
            
                self.send_json(200, {
                    "success": True,
                    "action": "type",
                    "length": len(text),
                    "segments": len(segments)
                })



            
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
                all_windows = gw.getAllWindows()
                visible = [{"title": w.title, "minimized": w.isMinimized, "active": w.isActive}
                          for w in all_windows if w.title.strip()]
                self.send_json(200, {"success": True, "windows": visible[:30]})
            
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
                import subprocess
                subprocess.Popen(program, shell=True)
                
                # 如果有 text 参数，等一秒后自动输入
                text = data.get('text', '')
                if text:
                    time.sleep(1.0)
                    # 尝试激活窗口（按程序名找）
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
                
                # 用默认浏览器打开 URL（会复用已有窗口的新标签页）
                import subprocess
                # 用 cmd /c start 会使用默认浏览器，且通常开新标签页
                subprocess.run(['cmd', '/c', 'start', url], shell=True)
                
                self.send_json(200, {
                    "success": True,
                    "action": "open_url",
                    "url": url
                })
                

            
            # ========== 快捷操作（组合指令） ==========
            elif action == 'open_and_type':
                program = data.get('program', 'notepad')
                text = data.get('text', '')
                title = data.get('title', program)
                
                # 1. 打开程序
                import subprocess
                subprocess.Popen(program, shell=True)
                time.sleep(1.0)  # 等程序启动
                
                # 2. 激活窗口
                windows = gw.getWindowsWithTitle(title)
                if windows:
                    win = windows[0]
                    if win.isMinimized:
                        win.restore()
                    win.activate()
                    time.sleep(0.3)
                
                # 3. 输入文字
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
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Headers', '*')
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            # 客户端提前断开连接，忽略
            pass
        except Exception:
            # 其他写入错误也忽略
            pass

    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
    
    def log_message(self, format, *args):
        pass


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
    
    server = HTTPServer((HOST, PORT), ControlHandler)
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
