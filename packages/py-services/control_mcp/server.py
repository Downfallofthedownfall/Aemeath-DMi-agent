# -*- coding: utf-8 -*-
# ============================================================
# control_mcp/server.py — 键鼠/窗口控制 MCP server（自 v1 control_server.py 移植）
# 工具（dsh 侧名称 mcp__control__<name>）：
#   鼠标：control_mouse_move / control_mouse_click / control_mouse_scroll
#   键盘：control_keyboard_type（支持中文，经剪贴板粘贴，{ENTER} 分段）
#         / control_keyboard_hotkey / control_keyboard_press
#   窗口：control_window_focus / control_window_minimize / control_window_close
#         / control_window_list（3 秒硬超时，返回部分列表）
#   其他：control_position / control_open（白名单程序 + start <exe> + url）
# 安全：FAILSAFE=True（鼠标甩到角落急停）；open 仅白名单/存在的 exe/URL
#      （白名单已移除 cmd/powershell；任意 .exe 路径放行仍需 dsh 侧审批兜底）。
# ⚠️ 这些工具会在用户机器上真实操作键鼠/窗口——dsh 侧已对 mcp__control__* 挂
#    tools/pre-execute 强制审批（见 dsh-plugin-workflow），本服务自身只做本地执行。
# 运行：python packages/py-services/control_mcp/server.py
# ============================================================
import os
import sys
import json
import time
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mcp_core import McpServer  # noqa: E402

server = McpServer("control_mcp", "2.0.0-m0")

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

try:
    import win32gui
    HAS_WIN32GUI = True
except ImportError:
    HAS_WIN32GUI = False

# C21：窗口枚举重入锁（防超时后 worker 线程堆积）
_window_collect_lock = threading.Lock()
# C21 加强：枚举完成事件（初始已 set=空闲）。3s 超时后旧 worker 仍在收尾时
# 未 set → 拒绝新调用，直到旧 worker 真正结束才恢复，杜绝线程随调用堆积。
_window_collect_done = threading.Event()
_window_collect_done.set()

# 输入钳制常量（防模型传超大参数长时间阻塞 MCP 主循环）
MAX_CLICKS = 100
MAX_PRESSES = 100
MAX_DURATION_S = 10.0
MAX_SCROLL_AMOUNT = 100
MAX_KEYBOARD_TEXT_LEN = 2000
MAX_ENTER_SEGMENTS = 50

ALLOWED_PROGRAMS = {
    'notepad': 'notepad.exe', 'calc': 'calc.exe', 'explorer': 'explorer.exe',
    'msedge': 'msedge.exe', 'chrome': 'chrome.exe', 'firefox': 'firefox.exe',
    'mspaint': 'mspaint.exe', 'taskmgr': 'taskmgr.exe', 'control': 'control.exe',
}


def _require_deps():
    missing = []
    if not HAS_PYAUTOGUI:
        missing.append('pyautogui')
    if not HAS_CLIPBOARD:
        missing.append('pyperclip')
    if not HAS_WINDOW:
        missing.append('pygetwindow')
    if missing:
        raise RuntimeError(f"缺少依赖: {', '.join(missing)}（pip install {' '.join(missing)}）")


# ============================================================
# 鼠标
# ============================================================
@server.tool(
    "control_mouse_move",
    "移动鼠标指针到屏幕坐标（x,y），可指定移动时长。",
    {
        "type": "object",
        "properties": {
            "x": {"type": "number", "description": "屏幕 x 坐标（0=最左）"},
            "y": {"type": "number", "description": "屏幕 y 坐标（0=最上）"},
            "duration": {"type": "number", "description": "移动时长秒数，默认 0.3"},
        },
        "required": ["x", "y"],
        "additionalProperties": False,
    },
)
def control_mouse_move(x: float, y: float, duration=0.3):
    _require_deps()
    duration = max(0.0, min(float(duration), MAX_DURATION_S))  # 钳制移动时长
    pyautogui.moveTo(int(x), int(y), duration=duration)
    return {"success": True, "x": int(x), "y": int(y), "duration": duration}


@server.tool(
    "control_mouse_click",
    "鼠标点击：可指定坐标与按钮（left/right/middle）、次数；不带坐标则在当前位置点击。",
    {
        "type": "object",
        "properties": {
            "x": {"type": "number", "description": "可选：点击 x 坐标"},
            "y": {"type": "number", "description": "可选：点击 y 坐标"},
            "button": {"type": "string", "description": "left/right/middle，默认 left"},
            "clicks": {"type": "number", "description": "点击次数，默认 1"},
        },
        "additionalProperties": False,
    },
)
def control_mouse_click(x=None, y=None, button="left", clicks=1):
    _require_deps()
    clicks = max(1, min(int(clicks), MAX_CLICKS))  # 钳制点击次数
    if button not in ("left", "middle", "right"):
        return {"success": False, "error": f"button 必须为 left/middle/right，收到: {button!r}"}
    if (x is None) != (y is None):
        return {"success": False, "error": "x/y 必须成对提供或都不提供"}
    if x is not None and y is not None:
        pyautogui.click(int(x), int(y), clicks=clicks, button=button)
    else:
        pyautogui.click(clicks=clicks, button=button)
    return {"success": True, "x": x, "y": y, "button": button, "clicks": clicks}


@server.tool(
    "control_mouse_scroll",
    "鼠标滚轮滚动（amount 为正向上，负为向下，默认 -3）。",
    {
        "type": "object",
        "properties": {"amount": {"type": "number", "description": "滚动量，默认 -3"}},
        "additionalProperties": False,
    },
)
def control_mouse_scroll(amount=-3):
    _require_deps()
    amount = max(-MAX_SCROLL_AMOUNT, min(int(amount), MAX_SCROLL_AMOUNT))  # 钳制滚动量
    pyautogui.scroll(amount)
    return {"success": True, "amount": amount}


# ============================================================
# 键盘
# ============================================================
@server.tool(
    "control_keyboard_type",
    "键盘输入文本（支持中文，经剪贴板粘贴实现）。可先聚焦指定窗口；"
    "文本中可用 {ENTER} 表示回车分段。输入完成后恢复原剪贴板。"
    "⚠ Web 应用输入框（GeoGebra/在线编辑器等）聚焦方式按优先级："
    "① tabFocus=N（先按 N 次 Tab 键盘导航聚焦，最可靠，推荐）——OCR 像素坐标常不准，"
    "键盘导航由浏览器保证命中可聚焦元素；② x/y（detect_screen 定位的坐标，仅键盘"
    "导航失败时用）。聚焦与输入必须在本调用内一次完成（审批弹窗交互会移走焦点，"
    "拆成两次调用时第二次输入会落空）。只激活窗口不聚焦输入框时粘贴会落空甚至"
    "触发权限弹窗。",
    {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": '要输入的文本，如 "42号混泥土" 或 "第一行{ENTER}第二行"'},
            "title": {"type": "string", "description": "可选：先激活标题包含此字符串的窗口"},
            "tabFocus": {"type": "number", "description": "可选：输入前先按 N 次 Tab 聚焦输入框（0-20，键盘导航优先，最可靠）"},
            "x": {"type": "number", "description": "可选：目标输入框屏幕 x 坐标（仅键盘导航失败时用，先点击聚焦再输入）"},
            "y": {"type": "number", "description": "可选：目标输入框屏幕 y 坐标（与 x 成对）"},
        },
        "required": ["text"],
        "additionalProperties": False,
    },
)
def control_keyboard_type(text: str, title="", tabFocus=0, x=None, y=None):
    _require_deps()
    if not text:
        return {"success": True, "action": "type", "length": 0}
    if len(text) > MAX_KEYBOARD_TEXT_LEN:
        return {"success": False, "action": "type",
                "error": f"text 过长（{len(text)} 字符，上限 {MAX_KEYBOARD_TEXT_LEN}）"}
    if text.upper().count('{ENTER}') > MAX_ENTER_SEGMENTS:
        return {"success": False, "action": "type",
                "error": f"分段过多（{{ENTER}} 超过 {MAX_ENTER_SEGMENTS} 个）"}
    if (x is None) != (y is None):
        return {"success": False, "action": "type", "error": "x/y 必须成对提供或都不提供"}

    if title:
        try:
            windows = gw.getWindowsWithTitle(title)
            if windows:
                win = windows[0]
                if win.isMinimized:
                    win.restore()
                win.activate()
                time.sleep(0.4)
        except Exception:  # noqa: BLE001
            pass

    # 键盘导航聚焦（优先）：按 N 次 Tab 把焦点移进目标输入框。浏览器/系统保证
    # Tab 命中当前可聚焦元素，比 OCR 像素坐标可靠（坐标在 canvas/缩放/多显示器下
    # 经常不准导致点击落空）。
    tabN = max(0, min(int(tabFocus or 0), 20))
    for _ in range(tabN):
        pyautogui.press('tab')
        time.sleep(0.15)

    # 坐标点击聚焦（fallback：键盘导航失败时用）
    if x is not None and y is not None:
        try:
            pyautogui.click(int(x), int(y))
            time.sleep(0.3)
        except Exception as e:  # noqa: BLE001
            return {"success": False, "action": "type",
                    "error": f"点击聚焦失败 ({int(x)},{int(y)}): {e}"}

    # 保存剪贴板（粘贴后恢复）
    saved = None
    try:
        saved = subprocess_run_powershell('Get-Clipboard -Raw')
    except Exception:  # noqa: BLE001
        pass

    try:
        import re
        normalized = text.replace('\n', ' {ENTER} ')
        segments = re.split(r'\{[Ee][Nn][Tt][Ee][Rr]\}', normalized)
        for i, segment in enumerate(segments):
            clean = segment.strip()
            if clean:
                if not _clipboard_set_verified(clean):
                    return {"success": False, "action": "type",
                            "error": "剪贴板写入校验失败（可能被其他程序占用），已取消粘贴以免输入乱码"}
                time.sleep(0.2)
                pyautogui.hotkey('ctrl', 'v')
                time.sleep(0.2)
            if i < len(segments) - 1:
                pyautogui.press('enter')
                time.sleep(0.2)
        result = {"success": True, "action": "type", "length": len(text),
                  "segments": len(segments), "focused": bool(title),
                  "tabFocus": tabN, "clicked": x is not None and y is not None}
    finally:
        try:
            if saved and saved.strip():
                pyperclip.copy(saved)
        except Exception:  # noqa: BLE001
            pass
    return result


def subprocess_run_powershell(command):
    import subprocess
    return subprocess.run(
        ['powershell', '-NoProfile', '-Command', command],
        capture_output=True, text=True, timeout=5,
    ).stdout


def _clipboard_set_verified(text, tries=3):
    """写剪贴板并读回校验（pyperclip 在剪贴板被占用时会静默失败，
    导致粘贴的是旧内容——中文乱码的常见根因）。失败自动重试。"""
    import pyperclip
    last_err = None
    for attempt in range(tries):
        try:
            pyperclip.copy(text)
            time.sleep(0.15)
            got = pyperclip.paste()
            if got == text:
                return True
            last_err = f"读回不一致（got {len(got)} chars, want {len(text)}）"
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
        time.sleep(0.3 * (attempt + 1))
    print(f"[control_mcp] 剪贴板写入校验失败（{tries} 次）：{last_err}", file=sys.stderr)
    return False


@server.tool(
    "control_keyboard_hotkey",
    "组合快捷键，如 ['ctrl','c'] 复制、['ctrl','v'] 粘贴、['alt','tab'] 切换窗口。",
    {
        "type": "object",
        "properties": {
            "keys": {"type": "array", "description": '按键列表，如 ["ctrl","c"]',
                     "items": {"type": "string"}},
        },
        "required": ["keys"],
        "additionalProperties": False,
    },
)
def control_keyboard_hotkey(keys):
    _require_deps()
    pyautogui.hotkey(*[str(k) for k in keys])
    return {"success": True, "keys": keys}


@server.tool(
    "control_keyboard_press",
    "单键按压，如 'enter'、'tab'、'esc'、'f5'、'space'（可指定次数）。",
    {
        "type": "object",
        "properties": {
            "key": {"type": "string", "description": "键名，如 enter/tab/esc/f5/space"},
            "presses": {"type": "number", "description": "次数，默认 1"},
        },
        "required": ["key"],
        "additionalProperties": False,
    },
)
def control_keyboard_press(key: str, presses=1):
    _require_deps()
    presses = max(1, min(int(presses), MAX_PRESSES))  # 钳制按压次数
    pyautogui.press(str(key), presses=presses)
    return {"success": True, "key": key, "presses": presses}


# ============================================================
# 窗口
# ============================================================
def _find_window(title):
    windows = gw.getWindowsWithTitle(title)
    if not windows:
        raise RuntimeError(f"未找到包含「{title}」的窗口")
    return windows[0]


@server.tool(
    "control_window_focus",
    "激活标题包含指定字符串的窗口（还原最小化后置前）。",
    {
        "type": "object",
        "properties": {"title": {"type": "string", "description": "窗口标题片段"}},
        "required": ["title"],
        "additionalProperties": False,
    },
)
def control_window_focus(title: str):
    _require_deps()
    win = _find_window(title)
    if win.isMinimized:
        win.restore()
    win.activate()
    time.sleep(0.3)
    return {"success": True, "title": win.title}


@server.tool(
    "control_window_minimize",
    "最小化标题包含指定字符串的窗口。",
    {
        "type": "object",
        "properties": {"title": {"type": "string", "description": "窗口标题片段"}},
        "required": ["title"],
        "additionalProperties": False,
    },
)
def control_window_minimize(title: str):
    _require_deps()
    _find_window(title).minimize()
    return {"success": True, "title": title}


@server.tool(
    "control_window_close",
    "关闭标题包含指定字符串的窗口。",
    {
        "type": "object",
        "properties": {"title": {"type": "string", "description": "窗口标题片段"}},
        "required": ["title"],
        "additionalProperties": False,
    },
)
def control_window_close(title: str):
    _require_deps()
    _find_window(title).close()
    return {"success": True, "title": title}


@server.tool(
    "control_window_list",
    "列出当前可见窗口（标题/最小化/是否前台）。枚举带 3 秒硬超时，"
    "遇到无响应窗口时返回已收集的部分列表（timed_out=true）。",
    {"type": "object", "properties": {}, "additionalProperties": False},
)
def control_window_list():
    _require_deps()
    # C21：重入守卫——上一次枚举超时后 worker 线程仍在跑时（完成事件未 set），
    # 跳过本次调用，防止窗口枚举线程随超时调用无限堆积（worker 为 daemon，
    # 不阻塞退出）；旧 worker 真正结束后完成事件 set，服务恢复可用。
    if not _window_collect_done.is_set():
        return {"success": False, "error": "上一次窗口枚举尚未完成（3s 超时后仍在收尾），请稍后重试"}
    _window_collect_done.clear()
    with _window_collect_lock:
        results = []
        done = threading.Event()
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
                            except Exception:  # noqa: BLE001
                                pass
                            results.append({"title": title, "minimized": minimized, "active": active})
                        except Exception:  # noqa: BLE001
                            pass
                        return True
                    win32gui.EnumWindows(_enum_cb, None)
                else:
                    for w in gw.getAllWindows():
                        try:
                            t = (w.title or '').strip()
                            if t:
                                results.append({"title": t, "minimized": w.isMinimized, "active": w.isActive})
                        except Exception:  # noqa: BLE001
                            continue
            except Exception as e:  # noqa: BLE001
                err_holder['error'] = str(e)
            finally:
                done.set()
                _window_collect_done.set()  # 收尾完成 → 允许下次调用

        threading.Thread(target=_collect, daemon=True).start()
        done.wait(timeout=3.0)

        if not results and err_holder.get('error'):
            return {"success": False, "error": f"list_windows failed: {err_holder['error']}"}
        return {"success": True, "windows": results[:30], "timed_out": not done.is_set()}


# ============================================================
# 其他
# ============================================================
@server.tool(
    "control_position",
    "返回鼠标当前屏幕坐标。",
    {"type": "object", "properties": {}, "additionalProperties": False},
)
def control_position():
    _require_deps()
    x, y = pyautogui.position()
    return {"success": True, "x": x, "y": y}


@server.tool(
    "control_open",
    "打开程序/URL：仅白名单程序（notepad/calc/explorer/msedge/chrome/"
    "firefox/mspaint/taskmgr/control，不含 cmd/powershell）、存在的 .exe 路径、"
    "或 http(s) URL。可带 text 在程序打开后自动输入。"
    "⚠ 注意：任意存在的 .exe 路径会被直接启动（等同以本机用户权限运行该程序），"
    "仅在用户明确要求打开时使用，不要自行启动未在对话中出现的程序。",
    {
        "type": "object",
        "properties": {
            "program": {"type": "string", "description": "白名单程序名 / .exe 路径 / http(s) URL"},
            "text": {"type": "string", "description": "可选：打开后自动输入（粘贴）的文本"},
        },
        "required": ["program"],
        "additionalProperties": False,
    },
)
def control_open(program: str, text=""):
    _require_deps()
    prog = program.lower()
    if prog in ALLOWED_PROGRAMS:
        os.startfile(ALLOWED_PROGRAMS[prog])
    elif prog.endswith('.exe') and os.path.isfile(program):
        os.startfile(program)
    elif prog.startswith(('https://', 'http://')):
        import webbrowser
        webbrowser.open(program)
    else:
        return {"success": False, "error": f"程序 '{program}' 不在白名单中"}

    if text:
        time.sleep(1.0)
        try:
            windows = gw.getWindowsWithTitle(prog)
            if windows:
                win = windows[0]
                if win.isMinimized:
                    win.restore()
                win.activate()
                time.sleep(0.3)
        except Exception:  # noqa: BLE001
            pass
        _clipboard_set_verified(text)
        time.sleep(0.2)
        pyautogui.hotkey('ctrl', 'v')
    return {"success": True, "program": program, "typed": bool(text)}


if __name__ == "__main__":
    server.run()
