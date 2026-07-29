# ============================================================
# ai_service.py - AI 对话服务（替代 Dify）
# 功能：双模式切换、工具调用（文件/命令/控制/视觉）、
#       OOC 检测（规则优先）、流式输出
# 端口：18892
# ============================================================

import json
import os
import sys
import re
import time
import math
import datetime
import subprocess
import urllib.request
import urllib.parse
import urllib.error
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
import threading
import uuid 
import unicodedata   # 用于准确的 emoji 检测

# ===== 用户确认存储 =====
# {request_id: {"event": threading.Event(), "approved": None, "tool_calls": [...]}}
approval_store = {}
approval_lock = threading.Lock()

# ===== Windows 编码修复 =====
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ===== 配置 =====
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(SCRIPT_DIR, 'config.json')
DEFAULT_HOST = '127.0.0.1'
DEFAULT_PORT = 18892

def load_config():
    if not os.path.exists(CONFIG_FILE):
        print(f"Error: Config file {CONFIG_FILE} not found")
        sys.exit(1)
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error: Failed to read config: {e}")
        sys.exit(1)

config = load_config()
DEEPSEEK_API_KEY = config.get('deepseek_api_key', '')
DEEPSEEK_API_BASE = config.get('deepseek_api_base', 'https://api.deepseek.com')
MODES_CONFIG = config.get('modes', {})

if not DEEPSEEK_API_KEY or '把你的' in DEEPSEEK_API_KEY:
    print("Error: config.json missing valid deepseek_api_key")
    sys.exit(1)


# ============================================================
# HTTP 请求工具
# ============================================================

def http_post(url, data, timeout=15):
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')[:300]
        return {"success": False, "error": f"HTTP {e.code}: {body}"}
    except urllib.error.URLError as e:
        return {"success": False, "error": f"Connection failed: {e.reason}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================
# 工具执行器
# ============================================================

def execute_tool(name, args):
    """执行工具调用，返回字符串结果"""
    print(f"[Tool] {name}")
    try:
        # ---- 文件系统 ----
        if name == 'list_files':
            target = args.get('path', os.path.expanduser('~\\Desktop'))
            items = os.listdir(target)
            dirs, files = [], []
            for item in sorted(items):
                full = os.path.join(target, item)
                if os.path.isdir(full):
                    dirs.append(f"  [Folder] {item}")
                else:
                    try:
                        size = os.path.getsize(full)
                        files.append(f"  [File] {item} ({size} bytes)")
                    except:
                        files.append(f"  [File] {item}")
            return f"Directory: {target}\n\nFolders:\n" + "\n".join(dirs) + "\n\nFiles:\n" + "\n".join(files)

        if name == 'read_file':
            p = args['path']
            with open(p, 'r', encoding='utf-8') as f:
                c = f.read()
            return f"File: {p}\n\n{c[:5000]}" + ("\n\n...(truncated)" if len(c) > 5000 else "")

        if name == 'write_file':
            p, c = args['path'], args['content']
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'w', encoding='utf-8') as f:
                f.write(c)
            return f"Written: {p} ({len(c)} chars)"

        if name == 'search_files':
            kw = args['keyword']
            target = args.get('path', os.path.expanduser('~\\Desktop'))
            results = []
            for root, _, files in os.walk(target):
                if len(results) >= 50: break
                for f in files:
                    if kw.lower() in f.lower():
                        fp = os.path.join(root, f)
                        try: sz = os.path.getsize(fp); results.append(f"{fp} ({sz} bytes)")
                        except: results.append(fp)
                        if len(results) >= 50: break
            if results: return f"Search '{kw}': {len(results)} results\n" + "\n".join(results)
            return f"No results for '{kw}'"

        # ---- 命令执行（内置常用命令 + 白名单回退） ----
        if name == 'execute_command':
            cmd = args.get('command', '').strip()
            cmd_lower = cmd.lower()
            
            # 内置常用命令（不走白名单，直接跑）
            builtin_commands = {
                'notepad': ('notepad.exe', '记事本'),
                'calc': ('calc.exe', '计算器'),
                'explorer': ('explorer.exe', '资源管理器'),
                'cmd': ('cmd.exe', '命令提示符'),
                'powershell': ('powershell.exe', 'PowerShell'),
                'mspaint': ('mspaint.exe', '画图'),
                'taskmgr': ('taskmgr.exe', '任务管理器'),
                'control': ('control.exe', '控制面板'),
            }
            
            # 提取命令名（去掉 start 前缀）
            clean_cmd = cmd_lower.replace('start ', '').strip()
            
            handled = False
            for key, (exe, name) in builtin_commands.items():
                if clean_cmd == key or clean_cmd == exe or clean_cmd.startswith(key):
                    try:
                        subprocess.Popen(exe, shell=True)
                        print(f"[Tool] 内置命令: {name} 已打开")
                        # 如果有额外参数（如 URL），稍后处理
                        if 'http' in cmd_lower or 'https' in cmd_lower:
                            import re
                            urls = re.findall(r'https?://[^\s]+', cmd)
                            if urls:
                                time.sleep(0.5)
                                subprocess.Popen(['cmd', '/c', 'start', urls[0]], shell=True)
                                return f"{name} 已打开，并在浏览器中打开了: {urls[0]}"
                        return f"{name} 已打开"
                    except Exception as e:
                        handled = False  # 内置失败，尝试白名单
                        break
                    handled = True
                    break
            
            if not handled:
                # 回退到白名单服务
                r = http_post('http://127.0.0.1:18888/execute', {"command": cmd}, timeout=15)
                if r.get('error'):
                    # 白名单也失败，告诉 AI 不支持
                    return f"命令 '{cmd}' 不被支持。可用命令: {', '.join(builtin_commands.keys())}"
                out = (r.get('stdout') or '')[:2000]
                err = (r.get('stderr') or '')[:1000]
                ret = r.get('returncode', -1)
                return f"Return: {ret}\nOutput: {out}\nError: {err}"

        # ---- 鼠标控制 ----
        if name == 'control_mouse':
            payload = {"action": args['action']}
            for k in ['x', 'y', 'button', 'clicks', 'amount', 'duration']:
                if k in args: payload[k] = args[k]
            r = http_post('http://127.0.0.1:18890', payload, timeout=10)
            if r.get('success'): return f"Mouse {args['action']} done"
            return f"Mouse failed: {r.get('error', 'unknown')}"

        # ---- 键盘控制 ----
        if name == 'control_keyboard':
            act = args['action']
            payload = {"action": act}
            if act == 'type': payload['text'] = args.get('text', '')
            elif act == 'press': payload['key'] = args.get('keys', 'enter'); payload['presses'] = args.get('presses', 1)
            elif act == 'hotkey': payload['keys'] = args.get('hotkey', ['ctrl', 'c'])
            r = http_post('http://127.0.0.1:18890', payload, timeout=10)
            if r.get('success'): return f"Keyboard {act} done"
            return f"Keyboard failed: {r.get('error', 'unknown')}"

        # ---- 窗口控制 ----
        if name == 'control_window':
            act = args['action']
            payload = {"action": act}
            for k in ['title', 'program', 'text']:
                if k in args: payload[k] = args[k]
            r = http_post('http://127.0.0.1:18890', payload, timeout=10)
            if r.get('success'): return f"Window {act} done"
            return f"Window failed: {r.get('error', 'unknown')}"

        # ---- 打开 URL ----
        if name == 'open_url':
            url = args['url']
            subprocess.run(['cmd', '/c', 'start', url], shell=True, capture_output=True)
            return f"Opened in browser: {url}"

        # ---- 视觉识别 ----
        if name == 'detect_screen':
            r = http_post('http://127.0.0.1:18901/detect_screen', {}, timeout=15)
            if r.get('success'): return r.get('summary', str(r)[:500])
            return f"Detect failed: {r.get('error', '')}"

        if name == 'ocr_screen':
            r = http_post('http://127.0.0.1:18901/ocr_screen', {}, timeout=15)
            if r.get('success'): return r.get('summary', str(r)[:500])
            return f"OCR failed: {r.get('error', '')}"

        if name == 'describe_screen':
            r = http_post('http://127.0.0.1:18901/describe_screen', {}, timeout=20)
            if r.get('success'): return r.get('scene_description', str(r)[:500])
            return f"Describe failed: {r.get('error', '')}"

        # ---- 内置工具 ----
        if name == 'get_current_time':
            tz = args.get('timezone', 'Asia/Shanghai')
            try:
                import zoneinfo
                now = datetime.datetime.now(zoneinfo.ZoneInfo(tz))
                return f"Time({tz}): {now.strftime('%Y-%m-%d %H:%M:%S')}"
            except:
                return f"Time: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"

        if name == 'calculate':
            expr = args['expression']
            ns = {'__builtins__': {}}
            for fn in ['sqrt', 'sin', 'cos', 'tan', 'log', 'log10', 'floor', 'ceil',
                       'pow', 'radians', 'degrees', 'pi', 'e', 'abs', 'round', 'int']:
                if hasattr(math, fn): ns[fn] = getattr(math, fn)
            ns['math'] = math
            try:
                result = eval(expr, ns)
                return f"{expr} = {result}"
            except Exception as e:
                return f"Calc error: {e}"

        if name == 'web_scraper':
            url = args['url']
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                html = resp.read().decode('utf-8', errors='replace')
            text = re.sub(r'<[^>]+>', ' ', html)
            text = re.sub(r'\s+', ' ', text).strip()
            return f"Web content:\n\n{text[:3000]}" + ("\n\n...(truncated)" if len(text) > 3000 else "")

        if name == 'run_python':
            code = args['code']
            r = subprocess.run(['python', '-c', code], capture_output=True, text=True, timeout=10)
            if r.stdout.strip(): return f"Output:\n{r.stdout.strip()[:2000]}"
            if r.stderr.strip(): return f"Error:\n{r.stderr.strip()[:2000]}"
            return "Done (no output)"

        if name == 'arxiv_search':
            query = urllib.parse.quote(args['query'])
            url = f"http://export.arxiv.org/api/query?search_query=all:{query}&max_results=5"
            req = urllib.request.Request(url, headers={'User-Agent': 'Aemeath/1.0'})
            with urllib.request.urlopen(req, timeout=10) as resp:
                xml = resp.read().decode('utf-8')
            entries = re.findall(r'<entry>(.*?)</entry>', xml, re.DOTALL)
            results = []
            for entry in entries[:5]:
                title = re.search(r'<title>(.*?)</title>', entry, re.DOTALL)
                authors = re.findall(r'<name>(.*?)</name>', entry)
                summary = re.search(r'<summary>(.*?)</summary>', entry, re.DOTALL)
                results.append(
                    f"Title: {(title.group(1).strip() if title else 'Unknown')}\n"
                    f"Authors: {', '.join(authors[:3])}\n"
                    f"Abstract: {(summary.group(1).strip()[:200] if summary else 'N/A')}..."
                )
            if results: return f"arXiv '{args['query']}':\n\n" + "\n---\n".join(results)
            return "No results found"

        return f"Error: Unknown tool {name}"

    except subprocess.TimeoutExpired:
        return "Timeout"
    except Exception as e:
        return f"Error: {e}"


# ============================================================
# 工具定义（DeepSeek Function Calling 格式）
# ============================================================

TOOLS = [
    {"type": "function", "function": {
        "name": "list_files",
        "description": "List files and folders in a directory",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Directory path, default Desktop"}
        }}
    }},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Read file content",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Full file path"}
        }, "required": ["path"]}
    }},
    {"type": "function", "function": {
        "name": "write_file",
        "description": "Write or overwrite a file",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Full file path"},
            "content": {"type": "string", "description": "Content to write"}
        }, "required": ["path", "content"]}
    }},
    {"type": "function", "function": {
        "name": "search_files",
        "description": "Search files by name",
        "parameters": {"type": "object", "properties": {
            "keyword": {"type": "string", "description": "Search keyword"},
            "path": {"type": "string", "description": "Start directory, default Desktop"}
        }, "required": ["keyword"]}
    }},
    {"type": "function", "function": {
        "name": "execute_command",
        "description": "Execute system commands (notepad, calc, explorer, etc.)",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "Command to execute"}
        }, "required": ["command"]}
    }},
    {"type": "function", "function": {
        "name": "control_mouse",
        "description": "Mouse operations: move, click, double_click, right_click, scroll",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["move", "click", "double_click", "right_click", "scroll"]},
            "x": {"type": "integer"}, "y": {"type": "integer"},
            "button": {"type": "string", "enum": ["left", "right", "middle"]},
            "clicks": {"type": "integer"}, "amount": {"type": "integer"}
        }, "required": ["action"]}
    }},
    {"type": "function", "function": {
        "name": "control_keyboard",
        "description": "Keyboard: type text, press keys, or hotkey combos",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["type", "press", "hotkey"]},
            "text": {"type": "string", "description": "Text to type"},
            "keys": {"type": "string", "description": "Key to press"},
            "hotkey": {"type": "array", "items": {"type": "string"}, "description": "Hotkey combo like ['ctrl','c']"}
        }, "required": ["action"]}
    }},
    {"type": "function", "function": {
        "name": "control_window",
        "description": "Window: focus, list, open, minimize, close",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["focus_window", "list_windows", "open", "minimize_window", "close_window"]},
            "title": {"type": "string"}, "program": {"type": "string"}, "text": {"type": "string"}
        }, "required": ["action"]}
    }},
    {"type": "function", "function": {
        "name": "open_url",
        "description": "Open a URL in default browser (new tab)",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "Full URL like https://www.baidu.com"}
        }, "required": ["url"]}
    }},
    {"type": "function", "function": {
        "name": "detect_screen",
        "description": "Detect objects on screen (YOLO)",
        "parameters": {"type": "object", "properties": {}}
    }},
    {"type": "function", "function": {
        "name": "ocr_screen",
        "description": "Read text from screen (OCR)",
        "parameters": {"type": "object", "properties": {}}
    }},
    {"type": "function", "function": {
        "name": "describe_screen",
        "description": "Describe screen content (YOLO+OCR)",
        "parameters": {"type": "object", "properties": {}}
    }},
    {"type": "function", "function": {
        "name": "get_current_time",
        "description": "Get current date and time",
        "parameters": {"type": "object", "properties": {
            "timezone": {"type": "string", "description": "Timezone like Asia/Shanghai, UTC"}
        }}
    }},
    {"type": "function", "function": {
        "name": "calculate",
        "description": "Calculate math expressions like 2+2, sqrt(16)",
        "parameters": {"type": "object", "properties": {
            "expression": {"type": "string", "description": "Math expression"}
        }, "required": ["expression"]}
    }},
    {"type": "function", "function": {
        "name": "web_scraper",
        "description": "Fetch web page text content",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "Web page URL"}
        }, "required": ["url"]}
    }},
    {"type": "function", "function": {
        "name": "run_python",
        "description": "Execute Python code (code interpreter)",
        "parameters": {"type": "object", "properties": {
            "code": {"type": "string", "description": "Python code"}
        }, "required": ["code"]}
    }},
    {"type": "function", "function": {
        "name": "arxiv_search",
        "description": "Search arXiv academic papers",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "Search keywords"}
        }, "required": ["query"]}
    }},
]

# ============================================================
# OOC 检测（双层：规则 + LLM 语义兜底）
# ============================================================

# ── 辅助：检测 emoji ──
def _is_emoji(char):
    """用 Unicode 范围和类别判断字符是否为 emoji"""
    cp = ord(char)
    if 0x1F300 <= cp <= 0x1F9FF: return True
    if 0x2600 <= cp <= 0x27BF: return True
    if 0xFE00 <= cp <= 0xFE0F: return True
    if 0x1F1E0 <= cp <= 0x1F1FF: return True
    if 0x1FA00 <= cp <= 0x1FA6F: return True
    if 0x1FA70 <= cp <= 0x1FAFF: return True
    if 0x2702 <= cp <= 0x27B0: return True
    if 0x1F600 <= cp <= 0x1F64F: return True
    if 0x1F680 <= cp <= 0x1F6FF: return True
    try:
        if unicodedata.category(char) == 'So':
            return True
    except:
        pass
    return False


# ── Tier 1 关键词库 ──

# 爱弥斯桌宠 → 禁止的学术术语
AEMEATH_FORBIDDEN = [
    r'\bSchr[öo]dinger\b', r'\bMaxwell\b',
    r'\bFeynman\b', r'\bHamiltonian\b', r'\bLagrangian\b',
    r'\bLaplace\b', r'\bFourier\b', r'\bEuler\b', r'\bBoltzmann\b',
    r'\bPlanck\b', r'\bDirac\b', r'\bHeisenberg\b',
    r'\bwave\s*function\b', r'\bparticle\s*physics\b',
    r'\bthermodynamics\b', r'\belectromagnetic\b',
    r'\bSchwarzschild\b', r'\bHawking\b',
    r'mc\s*[²2]', r'E\s*=\s*m\s*c\^?2',
    r'\bdark\s*matter\b',
    r'\bstring\s*theory\b', r'\bquasar\b',
    r'\\\(', r'\\\[',           # LaTeX 行内/行间公式
    r'∫|∑|∂|∇|∮|∏|∞|√',        # 数学符号
]

# 星炬物理学霸 → 禁止的卖萌用语
PHYSICIST_FORBIDDEN = [
    r'(?i)\bgood\s+da\b', r'(?i)\bying\s+yi?ng\b',
    r'(?i)\bren\s+jia\b', r'(?i)\bmiao\s*[~～]\b',
    r'(?i)\bCiallo\b', r'(?i)\bnya[ao]?\b',
    r'(?i)\brawr\b', r'(?i)\bhehe\b',
    r'(?i)\bteehee\b', r'(?i)\bouo\b', r'(?i)\buvu\b',
    r'(?i)\b萌\b', r'(?i)\b可爱\b', r'(?i)\b卖萌\b',
    r'(?i)\b亲亲\b', r'(?i)\b抱抱\b', r'(?i)\b摸摸\b',
    r'(?i)\bbaby\b', r'(?i)\bsweetie\b', r'(?i)\bhoney\b',
    r'(?i)\bdarling\b', r'(?i)\bcutie\b',
    r'[～~]{3,}',                # 3个以上连续波浪号
]


# ── Tier 1：规则检测 ──
def rule_ooc_check(reply, mode):
    """
    基于关键词/规则的快速 OOC 检测。
    返回 (score, passed, warning, problems)
    
    返回值含义：
        score: 0-10（10=完美）
        passed: True=角色一致，False=越界
        warning: 警告文本（空串=无问题）
        problems: 问题列表
        action: 建议动作 "pass" / "fail" / "llm"
            "pass" — 明显通过，无需 LLM
            "fail" — 明显越界，无需 LLM
            "llm"  — 边界情况，建议调 LLM 进一步判断
    """
    if not reply or len(reply) < 5:
        return 10, True, "", [], "pass"

    problems = []
    penalty = 0.0

    # ── 通用：emoji 检测 ──
    emoji_count = sum(1 for c in reply if _is_emoji(c))
    if emoji_count > 0:
        p = min(emoji_count * 1.5, 4.0)
        penalty += p
        problems.append(f"使用了 {emoji_count} 个 emoji（扣{p}分）")

    # ── 模式特定关键词检测 ──
    if mode == 'aemeath':
        for pattern in AEMEATH_FORBIDDEN:
            m = re.search(pattern, reply)
            if m:
                penalty += 3.0
                problems.append(f"出现学术术语「{m.group()[:20]}」（扣3分）")
                break
        # 还能加分：aemeath 模式如果用了语气词加分
        if re.search(r'(?i)\b(好哒|喵|呐|鸭|呀|啦|捏|叭|喔)\b', reply):
            penalty -= 0.5  # 加分 = 减扣分

    elif mode == 'physicist':
        for pattern in PHYSICIST_FORBIDDEN:
            m = re.search(pattern, reply)
            if m:
                penalty += 3.5
                problems.append(f"出现卖萌用语「{m.group()[:20]}」（扣3.5分）")
                break
        # physicist 回答太短也扣分
        if len(reply) < 40:
            penalty += 1.0
            problems.append("回答缺乏深度（扣1分）")

    # ── 通用：思考标签残留 ──
    if re.search(r'<think>|</think>|<Thought>|</Thought>', reply):
        penalty += 0.5
        problems.append("包含思考标签残留（扣0.5分）")

    # ── 计算分数 ──
    score = max(0, round(10 - penalty, 1))

    if not problems:
        return 10, True, "", [], "pass"

    # 判断是否需要 LLM 兜底
    if 5 <= score < 8:
        # 边界情况：规则抓到了点东西但不太确定 → 交给 LLM
        return score, True, "; ".join(problems), problems, "llm"
    elif score >= 8:
        return score, True, "", [], "pass"
    else:
        # score < 5：明显越界
        return score, False, "; ".join(problems), problems, "fail"


# ── Tier 2：LLM 语义评分（兜底） ──
def llm_ooc_check(reply, mode, system_prompt, timeout=10):
    """
    用 DeepSeek API 对回复做语义级的角色一致性评分。
    只在 rule_ooc_check 返回 "llm" 时调用。
    返回 (score, passed, warning)
    """
    # 从 system_prompt 提取角色描述（取前200字作为角色摘要）
    role_summary = system_prompt[:200] if system_prompt else mode
    role_name = {"aemeath": "爱弥斯（萌系桌宠）", "physicist": "星炬（物理学霸助手）"}.get(mode, mode)

    prompt = f"""You are evaluating whether an AI assistant's response is "in character".
Character: {role_name}
Character description: {role_summary}

Response to evaluate:
---
{reply[:1500]}
---

Rate the response's character consistency on a scale of 1-10:
- 10: Perfectly in character, natural and fitting
- 8-9: Good, minor deviations
- 6-7: Noticeably off-character but acceptable
- 4-5: Clearly out of character
- 1-3: Completely wrong, opposite character

Only respond with a JSON object: {{"score": <1-10 number>, "reason": "<brief reason in Chinese, max 30 chars>"}}"""

    try:
        url = f"{DEEPSEEK_API_BASE}/chat/completions"
        data = json.dumps({
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "temperature": 0.1,
            "max_tokens": 128
        }).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers={
            'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
            'Content-Type': 'application/json',
        }, method='POST')
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        content = result['choices'][0]['message']['content']
        # 提取 JSON
        import re as _re
        json_match = _re.search(r'\{[^}]+\}', content)
        if json_match:
            parsed = json.loads(json_match.group())
            score = float(parsed.get('score', 7))
            reason = parsed.get('reason', '')
        else:
            score = 7.0
            reason = 'LLM returned invalid format'
    except Exception as e:
        print(f"[OOC] LLM check failed: {e}")
        score = 7.0
        reason = f'LLM check error: {str(e)[:30]}'

    score = max(1, min(10, score))
    passed = score >= 6.0
    warning = f"LLM评分 {score}/10: {reason}" if score < 8 else ""
    return score, passed, warning


# ── 入口：组合检测（Tier 1 → Tier 2） ──
def ooc_check(reply, mode, system_prompt, wfile=None):
    """
    双层 OOC 检测入口。
    1. 先跑规则检测（Tier 1）
    2. 如果规则返回 "llm"，再调 DeepSeek 评分（Tier 2）
    3. 将结果通过 SSE 发到前端（如有 wfile）
    
    返回 (score, passed, warning)
    """
    # Tier 1：规则检测
    score, passed, warning, problems, action = rule_ooc_check(reply, mode)
    print(f"[OOC] 一级评分: {score}分", flush=True) 

    # Tier 2：边界情况 → LLM 语义评分
    if action == "llm":
        print(f"[OOC] 规则边界 ({score}分)，调 LLM 语义评分...", flush=True)
        llm_score, llm_passed, llm_warning = llm_ooc_check(reply, mode, system_prompt)
        print(f"[OOC] 二级评分: {llm_score}分", flush=True)
        # 综合：取 LLM 评分，但规则的问题仍保留
        final_score = llm_score
        final_passed = llm_passed
        final_warning = llm_warning
        if problems:
            final_warning = f"[规则] {'; '.join(problems)} | [LLM] {llm_warning}" if llm_warning else f"[规则] {'; '.join(problems)}"
        print(f"[OOC] LLM 评分: {llm_score}/10, passed={llm_passed}", flush=True)
    else:
        print(f"[OOC] 一级评分: {score}分（无需二级）", flush=True)    
        final_score = score
        final_passed = passed
        final_warning = warning

    # 发送 SSE 事件到前端
    if wfile and not final_passed:
        try:
            wfile.write(f"data: {json.dumps({
                'type': 'ooc_warning',
                'warning': final_warning,
                'score': final_score,
                'problems': problems
            })}\n\n".encode('utf-8'))
            wfile.flush()
        except:
            pass

    if final_warning:
        print(f"[OOC] {'⚠️' if final_passed else '❌'} score={final_score}: {final_warning[:80]}")

    return final_score, final_passed, final_warning

def describe_tool_action(name, args):
    """把工具调用翻译成人类能看懂的话"""
    descriptions = {
        'execute_command': lambda a: f"在电脑上运行命令：{a.get('command', '')}",
        'open_url': lambda a: f"在浏览器中打开网页：{a.get('url', '')}",
        'control_mouse': lambda a: {
            'move': f"把鼠标移动到位置 ({a.get('x','?')}, {a.get('y','?')})",
            'click': f"在 ({a.get('x','当前位置')}, {a.get('y','当前位置')}) 处点击{'右键' if a.get('button')=='right' else '左键'}",
            'double_click': f"双击 ({a.get('x','?')}, {a.get('y','?')})",
            'scroll': f"滚动鼠标滚轮",
        }.get(a.get('action',''), f"鼠标操作：{a.get('action','')}"),
        'control_keyboard': lambda a: {
            'type': f"输入文字：{a.get('text','')[:30]}{'...' if len(a.get('text',''))>30 else ''}",
            'press': f"按下键盘按键：{a.get('keys','')}",
            'hotkey': f"按下组合键：{' + '.join(a.get('hotkey',[]))}",
        }.get(a.get('action',''), f"键盘操作：{a.get('action','')}"),
        'control_window': lambda a: {
            'focus_window': f"切换到窗口：{a.get('title','')}",
            'open': f"打开程序：{a.get('program','')}",
            'list_windows': f"列出所有打开的窗口",
            'minimize_window': f"最小化窗口：{a.get('title','')}",
            'close_window': f"关闭窗口：{a.get('title','')}",
        }.get(a.get('action',''), f"窗口操作：{a.get('action','')}"),
        'detect_screen': lambda a: "用摄像头识别屏幕上有什么东西",
        'ocr_screen': lambda a: "读取屏幕上的文字",
        'describe_screen': lambda a: "描述屏幕上显示的内容",
        'list_files': lambda a: f"查看 {a.get('path','桌面')} 里的文件和文件夹",
        'read_file': lambda a: f"读取文件：{a.get('path','')}",
        'write_file': lambda a: f"写入文件：{a.get('path','')}",
        'search_files': lambda a: f"搜索文件名包含「{a.get('keyword','')}」的文件",
        'run_python': lambda a: f"运行一段 Python 代码来帮您计算或处理数据",
        'web_scraper': lambda a: f"从网页上获取内容：{a.get('url','')}",
        'calculate': lambda a: f"计算数学表达式：{a.get('expression','')}",
        'get_current_time': lambda a: f"查看当前时间",
        'arxiv_search': lambda a: f"搜索学术论文：{a.get('query','')}",
    }
    
    desc_fn = descriptions.get(name)
    if desc_fn:
        return desc_fn(args)
    return f"执行操作：{name}"

# ============================================================
# 工具模式调用（含循环，最多15轮）
# ============================================================

# ============================================================
# 流式 + 工具循环（核心，始终 stream=True + tools）
# ============================================================

def stream_deepseek_with_tools(messages, wfile, approval_store, approval_lock, mode='aemeath', system_prompt='', max_rounds=15):
    """
    带工具循环的流式 DeepSeek 调用。
    每一轮：stream=True + tools，实时流式输出文字，
    流结束后检测 tool_calls → 发前端确认 → 执行 → 继续下一轮。
    返回 (final_text, has_error)
    """
    current_messages = list(messages)

    for round_num in range(1, max_rounds + 1):
        url = f"{DEEPSEEK_API_BASE}/chat/completions"
        request_body = {
            "model": "deepseek-v4-flash",
            "messages": current_messages,
            "stream": True,
            "temperature": 0.7,
            "max_tokens": 4096,
            "tools": TOOLS
        }

        data = json.dumps(request_body).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers={
            'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
            'Content-Type': 'application/json',
        }, method='POST')

        print(f"[AI] Stream round {round_num} | Msgs: {len(current_messages)}")

        try:
            resp = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')[:300]
            return f"API error (HTTP {e.code}): {body}", True
        except urllib.error.URLError as e:
            return f"Cannot connect: {e.reason}", True

        # ---- 读取流，累积文字 + tool_calls ----
        round_text = ""
        accumulated_tool_calls = {}  # index -> tool_call dict
        buf = ""

        for raw_bytes in resp:
            if not raw_bytes:
                break
            try:
                chunk = raw_bytes.decode('utf-8', errors='replace')
            except:
                continue
            buf += chunk
            while '\n' in buf:
                line, buf = buf.split('\n', 1)
                line = line.strip()
                if not line or line == 'data: [DONE]':
                    continue
                if line.startswith('data: '):
                    try:
                        json_data = json.loads(line[6:])
                        for choice in json_data.get('choices', []):
                            delta = choice.get('delta', {})

                            # 流式文字
                            content = delta.get('content', '')
                            if content:
                                round_text += content
                                wfile.write(f"data: {json.dumps({'answer': content})}\n\n".encode('utf-8'))
                                wfile.flush()

                            # 流式工具调用（按 index 累积）
                            for tc in delta.get('tool_calls', []):
                                idx = tc.get('index', 0)
                                if idx not in accumulated_tool_calls:
                                    accumulated_tool_calls[idx] = {
                                        'id': tc.get('id', ''),
                                        'type': tc.get('type', 'function'),
                                        'function': {'name': '', 'arguments': ''}
                                    }
                                func_delta = tc.get('function', {})
                                if func_delta.get('name'):
                                    accumulated_tool_calls[idx]['function']['name'] += func_delta['name']
                                if 'arguments' in func_delta:
                                    accumulated_tool_calls[idx]['function']['arguments'] += func_delta['arguments']
                                if tc.get('id'):
                                    accumulated_tool_calls[idx]['id'] = tc['id']
                    except:
                        pass

        # ---- 流结束，检查是否有工具调用 ----
        tool_calls = list(accumulated_tool_calls.values()) if accumulated_tool_calls else []

        if not tool_calls:
            print(f"[AI] 无工具调用，最终回答: {len(round_text)} 字符")

            # ===== 双层 OOC 检测 =====
            ooc_score, ooc_passed, ooc_warning = ooc_check(
                round_text, mode, system_prompt, wfile
            )

            return round_text, False

        print(f"[Tool] Round {round_num}: {len(tool_calls)} 个工具调用")

        # ---- 发前端确认 ----
        request_id = str(uuid.uuid4())
        event = threading.Event()
        with approval_lock:
            approval_store[request_id] = {
                "event": event,
                "approved": None,
                "tool_calls": tool_calls
            }

        tool_call_info = []
        for tc in tool_calls:
            name = tc.get('function', {}).get('name', '')
            try:
                args = json.loads(tc.get('function', {}).get('arguments', '{}'))
            except:
                args = {}
            description = describe_tool_action(name, args)
            tool_call_info.append({
                "name": name,
                "args": args,
                "description": description
            })

        wfile.write(f"data: {json.dumps({'type': 'tool_call', 'request_id': request_id, 'tool_calls': tool_call_info})}\n\n".encode('utf-8'))
        wfile.flush()
        print(f"[Tool] 等待用户确认: {request_id}")

        # 等用户批准（最长60秒）
        event.wait(timeout=60)

        with approval_lock:
            approved_flag = approval_store.get(request_id, {}).get('approved', False)
            if request_id in approval_store:
                del approval_store[request_id]

        if approved_flag:
            print(f"[Tool] 用户批准，执行 {len(tool_calls)} 个工具")
            current_messages.append({
                "role": "assistant",
                "content": round_text,
                "tool_calls": tool_calls
            })
            for tc in tool_calls:
                func = tc.get('function', {})
                name = func.get('name', '')
                try:
                    args = json.loads(func.get('arguments', '{}'))
                except:
                    args = {}
                tool_result = execute_tool(name, args)
                current_messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get('id', ''),
                    "content": str(tool_result)[:2000]
                })
                print(f"[Tool] {name} 完成")
        else:
            print(f"[Tool] 用户拒绝或超时")
            if round_text:
                current_messages.append({
                    "role": "assistant",
                    "content": round_text + "\n\n（用户拒绝了工具调用请求）"
                })
            current_messages.append({
                "role": "user",
                "content": "我已拒绝你的工具调用请求，请直接回答我的问题，不要调用任何工具。"
            })

        # 继续下一轮
        continue
    
    # ===== 所有工具循环结束，最终 OOC 检测 =====
    ooc_score, ooc_passed, ooc_warning = ooc_check(
        round_text, mode, system_prompt, wfile
    )
    
    return "Too many tool calls, please simplify", True

# ============================================================
# HTTP 处理器
# ============================================================

class AIHandler(BaseHTTPRequestHandler):
    timeout = 60

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS, GET')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {"status": "ok", "mode_count": len(MODES_CONFIG)})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == '/chat':
            self.handle_chat()
        elif self.path == '/ooc-check':
            self.handle_ooc_check()
        elif self.path == '/tool-approve':
            self.handle_tool_approve()
        elif self.path == '/tool-deny':
            self.handle_tool_deny()
        elif self.path == '/health':
            self.send_json(200, {"status": "ok"})
        else:
            self.send_json(404, {"error": "not found"})

    def handle_tool_approve(self):
        try:
            body = self.read_body()
            request_id = body.get('request_id', '')
            with approval_lock:
                if request_id in approval_store:
                    approval_store[request_id]['approved'] = True
                    approval_store[request_id]['event'].set()
            self.send_json(200, {"success": True})
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def handle_tool_deny(self):
        try:
            body = self.read_body()
            request_id = body.get('request_id', '')
            with approval_lock:
                if request_id in approval_store:
                    approval_store[request_id]['approved'] = False
                    approval_store[request_id]['event'].set()
            self.send_json(200, {"success": True})
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    # ============================================================
    # handle_chat - 核心对话处理
    # ============================================================

    def handle_chat(self):
        try:
            # 1. 解析请求
            body = self.read_body()
            query = body.get('query', '').strip()
            mode = body.get('mode', 'aemeath')
            history = body.get('history', [])
            shared_memory = body.get('shared_memory', '')
            # skip_tools 已彻底移除！所有对话始终带工具

            if not query:
                self.send_json(400, {"error": "missing query"})
                return

            system_prompt = MODES_CONFIG.get(mode, {}).get('system_prompt', 'You are a helpful assistant.')

            # 2. 构造消息（仅纯文本 user/assistant 历史）
            messages = [{"role": "system", "content": system_prompt}]
            if shared_memory:
                messages.append({"role": "system", "content": f"## User info\n{shared_memory}"})
            for msg in history:
                role = msg.get('role', '')
                content = msg.get('content', '')
                if role in ('user', 'assistant') and content:
                    messages.append({"role": role, "content": content})
            messages.append({"role": "user", "content": query})

            print(f"[AI] Mode: {mode} | Query: {query[:40]}... | History: {len(history)} msgs")

            # 3. 发 SSE 响应头
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            # 4. 调用流式工具循环（始终 streaming + tools）
            final_text, has_error = stream_deepseek_with_tools(
                messages, self.wfile, approval_store, approval_lock, mode=mode, system_prompt=system_prompt
            )

            if has_error:
                self.wfile.write(f"data: {json.dumps({'answer': final_text, 'error': True})}\n\n".encode('utf-8'))
                self.wfile.write("data: [DONE]\n\n".encode('utf-8'))
                self.wfile.flush()
                return

            self.wfile.write("data: [DONE]\n\n".encode('utf-8'))
            self.wfile.flush()
            print(f"[AI] Done | Stream with tools | {len(final_text)} chars")

        except Exception as e:
            print(f"[AI] Error: {e}")
            traceback.print_exc()
            try:
                self.send_json(500, {"error": True, "message": str(e)})
            except:
                pass

        except Exception as e:
            print(f"[AI] Error: {e}")
            traceback.print_exc()
            try:
                self.send_json(500, {"error": True, "message": str(e)})
            except:
                pass

    def handle_ooc_check(self):
        try:
            body = self.read_body()
            reply = body.get('reply', '').strip()
            mode = body.get('mode', 'aemeath')
            if not reply:
                self.send_json(400, {"error": "missing reply"})
                return
            result, method = fast_ooc_check(reply, mode)
            result['method'] = method
            self.send_json(200, result)
        except Exception as e:
            self.send_json(200, {"score": 10, "passed": True})

    def read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length == 0: return {}
        return json.loads(self.rfile.read(length))

    def send_json(self, status, data):
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
        except Exception:
            pass

    def log_message(self, format, *args):
        pass


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    print("=" * 55)
    print("  [AI] Aemeath AI Chat Service v3")
    print(f"  Port:     {DEFAULT_HOST}:{DEFAULT_PORT}")
    print(f"  Model:    deepseek-v4-flash")
    print(f"  Modes:    {', '.join(MODES_CONFIG.keys())}")
    print(f"  Tools:    {len(TOOLS)}")
    print("=" * 55)

    server = ThreadedHTTPServer((DEFAULT_HOST, DEFAULT_PORT), AIHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()
