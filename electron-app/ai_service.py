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

        # ---- 命令执行 ----
        if name == 'execute_command':
            r = http_post('http://127.0.0.1:18888/execute', {"command": args['command']}, timeout=15)
            if r.get('error'): return f"Failed: {r['error']}"
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
# OOC 检测（规则优先）
# ============================================================

def fast_ooc_check(reply, mode):
    if not reply or len(reply) < 5:
        return {"score": 10, "passed": True}, "skip"
    problems = []
    if re.search('[\U0001F300-\U0001F9FF\u2600-\u27BF]', reply):
        problems.append("Contains emoji")
    if mode == 'aemeath':
        if re.search(r'[\\][\([]|Newton|Schrodinger|Maxwell|[∫∑∂∇]|mc²', reply):
            problems.append("aemeath should not use academic terms")
    if mode == 'physicist':
        if re.search(r'Good da|Ying ying|Ren jia|Miao~|Ciallo', reply):
            problems.append("physicist should not be cute")
    if not problems:
        return {"score": 10, "passed": True}, "rule"
    return {"score": 7, "passed": True, "warning": "; ".join(problems)}, "rule_warn"


# ============================================================
# 工具模式调用（含循环，最多15轮）
# ============================================================

def call_deepseek_with_tools(messages, mode='aemeath', max_rounds=15):
    """带工具循环的 DeepSeek 调用"""
    current_messages = list(messages)
    # 检查历史中是否已有助手回复
    has_previous_assistant = any(m['role'] == 'assistant' for m in current_messages[:-1])

    for round_num in range(1, max_rounds + 1):
        url = f"{DEEPSEEK_API_BASE}/chat/completions"

        request_body = {
            "model": "deepseek-v4-flash",
            "messages": current_messages,
            "stream": False,
            "temperature": 0.7,
            "max_tokens": 4096
        }

        # 有历史助手回复时，第一轮不带工具（避免重复执行）
        include_tools = not (round_num == 1 and has_previous_assistant)
        if include_tools:
            request_body["tools"] = TOOLS

        data = json.dumps(request_body).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers={
            'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
            'Content-Type': 'application/json',
        }, method='POST')

        print(f"[AI] Tool round {round_num} | Msgs: {len(current_messages)} | Tools: {include_tools}")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                resp_data = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')[:300]
            return f"DeepSeek API error (HTTP {e.code}): {body}", True
        except urllib.error.URLError as e:
            return f"Cannot connect to DeepSeek API: {e.reason}", True

        choice = resp_data['choices'][0]
        msg = choice['message']
        tool_calls = msg.get('tool_calls', [])

        if not tool_calls:
            return msg.get('content', '') or '', False

        print(f"[Tool] Round {round_num}: {len(tool_calls)} calls")

        current_messages.append({
            "role": "assistant",
            "content": msg.get('content', '') or '',
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
        elif self.path == '/health':
            self.send_json(200, {"status": "ok"})
        else:
            self.send_json(404, {"error": "not found"})

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
            skip_tools = body.get('skip_tools', False)

            if not query:
                self.send_json(400, {"error": "missing query"})
                return

            system_prompt = MODES_CONFIG.get(mode, {}).get('system_prompt', 'You are a helpful assistant.')

            # 2. 构造消息
            messages = [{"role": "system", "content": system_prompt}]
            if shared_memory:
                messages.append({"role": "system", "content": f"## User info\n{shared_memory}"})
            for msg in history:
                role = msg.get('role', '')
                content = msg.get('content', '')
                if role in ('user', 'assistant') and content:
                    messages.append({"role": role, "content": content})
            messages.append({"role": "user", "content": query})

            print(f"[AI] Mode: {mode} | Query: {query[:40]}... | History: {len(history)} msgs | Skip tools: {skip_tools}")

            # 3. 先发 SSE 响应头
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            # ===== skip_tools = true → 直接流式对话，不走工具循环 =====
            if skip_tools:
                print(f"[AI] Skip tools mode, streaming directly")
                url = f"{DEEPSEEK_API_BASE}/chat/completions"
                data = json.dumps({
                    "model": "deepseek-v4-flash",
                    "messages": messages,
                    "stream": True,
                    "temperature": 0.7,
                    "max_tokens": 4096
                }).encode('utf-8')

                req = urllib.request.Request(url, data=data, headers={
                    'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
                    'Content-Type': 'application/json',
                }, method='POST')

                try:
                    resp = urllib.request.urlopen(req, timeout=60)
                except urllib.error.HTTPError as e:
                    body = e.read().decode('utf-8', errors='replace')[:300]
                    self.wfile.write(f"data: {json.dumps({'answer': f'API error (HTTP {e.code})', 'error': True})}\n\n".encode('utf-8'))
                    self.wfile.write("data: [DONE]\n\n".encode('utf-8'))
                    self.wfile.flush()
                    return
                except urllib.error.URLError as e:
                    self.wfile.write(f"data: {json.dumps({'answer': f'Connection failed: {e.reason}', 'error': True})}\n\n".encode('utf-8'))
                    self.wfile.write("data: [DONE]\n\n".encode('utf-8'))
                    self.wfile.flush()
                    return

                # 流式转发
                full_answer = ""
                buf = ""
                for raw_bytes in resp:
                    if not raw_bytes: break
                    try: chunk = raw_bytes.decode('utf-8', errors='replace')
                    except: continue
                    buf += chunk
                    while '\n' in buf:
                        line, buf = buf.split('\n', 1)
                        line = line.strip()
                        if not line or line == 'data: [DONE]': continue
                        if line.startswith('data: '):
                            try:
                                data = json.loads(line[6:])
                                for choice in data.get('choices', []):
                                    content = choice.get('delta', {}).get('content', '')
                                    if content:
                                        full_answer += content
                                        self.wfile.write(f"data: {json.dumps({'answer': content})}\n\n".encode('utf-8'))
                                        self.wfile.flush()
                            except: pass

                self.wfile.write("data: [DONE]\n\n".encode('utf-8'))
                self.wfile.flush()

                # OOC 检测
                fast_ooc_check(full_answer, mode)
                print(f"[AI] Done | Skip tools | {len(full_answer)} chars")
                return

            # ===== skip_tools = false → 新对话，走工具循环 =====
            else:
                current_messages = list(messages)
                final_text = ""
                has_error = False

                for round_num in range(1, 16):
                    url = f"{DEEPSEEK_API_BASE}/chat/completions"
                    data = json.dumps({
                        "model": "deepseek-v4-flash",
                        "messages": current_messages,
                        "tools": TOOLS,
                        "stream": False,
                        "temperature": 0.7,
                        "max_tokens": 4096
                    }).encode('utf-8')

                    req = urllib.request.Request(url, data=data, headers={
                        'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
                        'Content-Type': 'application/json',
                    }, method='POST')

                    print(f"[AI] Tool round {round_num} | Msgs: {len(current_messages)}")
                    try:
                        with urllib.request.urlopen(req, timeout=60) as resp:
                            resp_data = json.loads(resp.read().decode('utf-8'))
                    except urllib.error.HTTPError as e:
                        body = e.read().decode('utf-8', errors='replace')[:300]
                        final_text = f"API error (HTTP {e.code}): {body}"
                        has_error = True
                        break
                    except urllib.error.URLError as e:
                        final_text = f"Cannot connect: {e.reason}"
                        has_error = True
                        break

                    choice = resp_data['choices'][0]
                    msg = choice['message']
                    tool_calls = msg.get('tool_calls', [])

                    if not tool_calls:
                        final_text = msg.get('content', '') or ''
                        break
                    else:
                        print(f"[Tool] Round {round_num}: {len(tool_calls)} calls")
                        current_messages.append({
                            "role": "assistant",
                            "content": msg.get('content', '') or '',
                            "tool_calls": tool_calls
                        })
                        for tc in tool_calls:
                            func = tc.get('function', {})
                            name = func.get('name', '')
                            try: args = json.loads(func.get('arguments', '{}'))
                            except: args = {}
                            tool_result = execute_tool(name, args)
                            current_messages.append({
                                "role": "tool",
                                "tool_call_id": tc.get('id', ''),
                                "content": str(tool_result)[:2000]
                            })
                        continue
                else:
                    final_text = "Too many tool calls, please simplify"

                if has_error:
                    self.wfile.write(f"data: {json.dumps({'answer': final_text, 'error': True})}\n\n".encode('utf-8'))
                    self.wfile.write("data: [DONE]\n\n".encode('utf-8'))
                    self.wfile.flush()
                    return

                # OOC 检测
                ooc_result, ooc_method = fast_ooc_check(final_text, mode)

                # 流式输出最终回答
                if len(final_text) < 100 or not final_text.strip():
                    self.wfile.write(f"data: {json.dumps({'answer': final_text})}\n\n".encode('utf-8'))
                    self.wfile.flush()
                else:
                    # 用 stream 实现打字效果
                    stream_messages = [
                        {"role": "system", "content": "Output the following text word by word, do not add anything:\n" + final_text},
                        {"role": "user", "content": query[:50] + "... (output the answer above word by word)"}
                    ]
                    stream_url = f"{DEEPSEEK_API_BASE}/chat/completions"
                    stream_data = json.dumps({
                        "model": "deepseek-v4-flash",
                        "messages": stream_messages,
                        "stream": True,
                        "temperature": 0.01,
                        "max_tokens": 4096
                    }).encode('utf-8')

                    stream_req = urllib.request.Request(stream_url, data=stream_data, headers={
                        'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
                        'Content-Type': 'application/json',
                    }, method='POST')

                    try:
                        with urllib.request.urlopen(stream_req, timeout=30) as stream_resp:
                            buf = ""
                            for raw_bytes in stream_resp:
                                if not raw_bytes: break
                                try: chunk = raw_bytes.decode('utf-8', errors='replace')
                                except: continue
                                buf += chunk
                                while '\n' in buf:
                                    line, buf = buf.split('\n', 1)
                                    line = line.strip()
                                    if not line or line == 'data: [DONE]': continue
                                    if line.startswith('data: '):
                                        try:
                                            data = json.loads(line[6:])
                                            for choice in data.get('choices', []):
                                                content = choice.get('delta', {}).get('content', '')
                                                if content:
                                                    self.wfile.write(f"data: {json.dumps({'answer': content})}\n\n".encode('utf-8'))
                                                    self.wfile.flush()
                                        except: pass
                    except Exception:
                        self.wfile.write(f"data: {json.dumps({'answer': final_text})}\n\n".encode('utf-8'))
                        self.wfile.flush()

                self.wfile.write("data: [DONE]\n\n".encode('utf-8'))
                self.wfile.flush()
                print(f"[AI] Done | Tool mode | {len(final_text)} chars")

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
