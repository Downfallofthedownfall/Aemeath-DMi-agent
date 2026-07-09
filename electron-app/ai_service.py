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
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# ===== 配置 =====
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(SCRIPT_DIR, 'config.json')
DEFAULT_HOST = '127.0.0.1'
DEFAULT_PORT = 18892

def load_config():
    if not os.path.exists(CONFIG_FILE):
        print(f"错误: 配置文件 {CONFIG_FILE} 不存在")
        sys.exit(1)
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"错误: 读取配置失败: {e}")
        sys.exit(1)

config = load_config()
DEEPSEEK_API_KEY = config.get('deepseek_api_key', '')
DEEPSEEK_API_BASE = config.get('deepseek_api_base', 'https://api.deepseek.com')
MODES_CONFIG = config.get('modes', {})

if not DEEPSEEK_API_KEY or '把你的' in DEEPSEEK_API_KEY:
    print("错误: config.json 中未设置有效的 deepseek_api_key")
    sys.exit(1)

api_lock = threading.Lock()


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
        return {"success": False, "error": f"连接失败: {e.reason}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================
# 工具执行器
# ============================================================

def execute_tool(name, args):
    """执行工具调用，返回字符串结果"""
    print(f"[工具] 调用: {name}")
    try:
        # ---- 文件系统 ----
        if name == 'list_files':
            target = args.get('path', os.path.expanduser('~\\Desktop'))
            items = os.listdir(target)
            dirs, files = [], []
            for item in sorted(items):
                full = os.path.join(target, item)
                if os.path.isdir(full):
                    dirs.append(f"  [文件夹] {item}")
                else:
                    try:
                        size = os.path.getsize(full)
                        files.append(f"  [文件] {item} ({size} 字节)")
                    except:
                        files.append(f"  [文件] {item}")
            return f"目录: {target}\n\n文件夹:\n" + "\n".join(dirs) + "\n\n文件:\n" + "\n".join(files)

        if name == 'read_file':
            p = args['path']
            with open(p, 'r', encoding='utf-8') as f:
                c = f.read()
            return f"文件: {p}\n\n{c[:5000]}" + ("\n\n...(截断)" if len(c) > 5000 else "")

        if name == 'write_file':
            p, c = args['path'], args['content']
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'w', encoding='utf-8') as f:
                f.write(c)
            return f"已写入文件: {p} ({len(c)} 字符)"

        if name == 'search_files':
            kw = args['keyword']
            target = args.get('path', os.path.expanduser('~\\Desktop'))
            results = []
            for root, _, files in os.walk(target):
                if len(results) >= 50: break
                for f in files:
                    if kw.lower() in f.lower():
                        fp = os.path.join(root, f)
                        try:
                            sz = os.path.getsize(fp)
                            results.append(f"{fp} ({sz} 字节)")
                        except:
                            results.append(fp)
                        if len(results) >= 50: break
            if results:
                return f"搜索 '{kw}' 找到 {len(results)} 个:\n" + "\n".join(results)
            return f"未找到包含 '{kw}' 的文件"

        # ---- 命令执行 ----
        if name == 'execute_command':
            r = http_post('http://127.0.0.1:18888/execute', {"command": args['command']}, timeout=15)
            if r.get('error'):
                return f"执行失败: {r['error']}"
            out = (r.get('stdout') or '')[:2000]
            err = (r.get('stderr') or '')[:1000]
            ret = r.get('returncode', -1)
            return f"返回码: {ret}\n输出: {out}\n错误: {err}"

        # ---- 鼠标控制 ----
        if name == 'control_mouse':
            payload = {"action": args['action']}
            for k in ['x', 'y', 'button', 'clicks', 'amount', 'duration']:
                if k in args: payload[k] = args[k]
            r = http_post('http://127.0.0.1:18890', payload, timeout=10)
            if r.get('success'):
                return f"鼠标{args['action']}成功"
            return f"鼠标操作失败: {r.get('error', '未知')}"

        # ---- 键盘控制 ----
        if name == 'control_keyboard':
            act = args['action']
            payload = {"action": act}
            if act == 'type':
                payload['text'] = args.get('text', '')
            elif act == 'press':
                payload['key'] = args.get('keys', 'enter')
                payload['presses'] = args.get('presses', 1)
            elif act == 'hotkey':
                payload['keys'] = args.get('hotkey', ['ctrl', 'c'])
            r = http_post('http://127.0.0.1:18890', payload, timeout=10)
            if r.get('success'):
                return f"键盘{act}成功"
            return f"键盘操作失败: {r.get('error', '未知')}"

        # ---- 窗口控制 ----
        if name == 'control_window':
            act = args['action']
            payload = {"action": act}
            if 'title' in args: payload['title'] = args['title']
            if 'program' in args: payload['program'] = args['program']
            if 'text' in args: payload['text'] = args['text']
            r = http_post('http://127.0.0.1:18890', payload, timeout=10)
            if r.get('success'):
                return f"窗口操作成功"
            return f"窗口操作失败: {r.get('error', '未知')}"

        # ---- 打开 URL（用浏览器新标签页） ----
        if name == 'open_url':
            url = args['url']
            subprocess.run(['cmd', '/c', 'start', url], shell=True, capture_output=True)
            return f"已在浏览器中打开: {url}"

        # ---- 视觉识别 ----
        if name == 'detect_screen':
            r = http_post('http://127.0.0.1:18901/detect_screen', {}, timeout=15)
            if r.get('success'):
                return r.get('summary', str(r)[:500])
            return f"检测失败: {r.get('error', '')}"

        if name == 'ocr_screen':
            r = http_post('http://127.0.0.1:18901/ocr_screen', {}, timeout=15)
            if r.get('success'):
                return r.get('summary', str(r)[:500])
            return f"OCR失败: {r.get('error', '')}"

        if name == 'describe_screen':
            r = http_post('http://127.0.0.1:18901/describe_screen', {}, timeout=20)
            if r.get('success'):
                return r.get('scene_description', str(r)[:500])
            return f"描述失败: {r.get('error', '')}"

        # ---- 内置工具 ----
        if name == 'get_current_time':
            tz = args.get('timezone', 'Asia/Shanghai')
            try:
                import zoneinfo
                now = datetime.datetime.now(zoneinfo.ZoneInfo(tz))
                return f"当前时间({tz}): {now.strftime('%Y-%m-%d %H:%M:%S')}"
            except:
                return f"当前时间: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"

        if name == 'calculate':
            expr = args['expression']
            ns = {'__builtins__': {}}
            for fn in ['sqrt', 'sin', 'cos', 'tan', 'log', 'log10', 'floor', 'ceil',
                       'pow', 'radians', 'degrees', 'pi', 'e', 'abs', 'round', 'int']:
                if hasattr(math, fn):
                    ns[fn] = getattr(math, fn)
            ns['math'] = math
            try:
                result = eval(expr, ns)
                return f"{expr} = {result}"
            except Exception as e:
                return f"计算错误: {e}"

        if name == 'web_scraper':
            url = args['url']
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                html = resp.read().decode('utf-8', errors='replace')
            text = re.sub(r'<[^>]+>', ' ', html)
            text = re.sub(r'\s+', ' ', text).strip()
            return f"网页内容:\n\n{text[:3000]}" + ("\n\n...(截断)" if len(text) > 3000 else "")

        if name == 'run_python':
            code = args['code']
            r = subprocess.run(['python', '-c', code], capture_output=True, text=True, timeout=10)
            if r.stdout.strip(): return f"输出:\n{r.stdout.strip()[:2000]}"
            if r.stderr.strip(): return f"错误:\n{r.stderr.strip()[:2000]}"
            return "执行完毕(无输出)"

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
                    f"标题: {(title.group(1).strip() if title else '未知')}\n"
                    f"作者: {', '.join(authors[:3])}\n"
                    f"摘要: {(summary.group(1).strip()[:200] if summary else '无')}..."
                )
            if results:
                return f"arXiv 搜索 '{args['query']}':\n\n" + "\n---\n".join(results)
            return "未找到相关论文"

        # 未匹配到任何工具
        return f"错误: 未知工具 {name}"

    except subprocess.TimeoutExpired:
        return "执行超时"
    except Exception as e:
        return f"执行错误: {e}"


# ============================================================
# 工具定义（DeepSeek Function Calling 格式）
# ============================================================

TOOLS = [
    {"type": "function", "function": {
        "name": "list_files",
        "description": "列出指定目录中的文件和文件夹",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "目录路径，默认为桌面"}
        }}
    }},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "读取文件内容",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "文件完整路径"}
        }, "required": ["path"]}
    }},
    {"type": "function", "function": {
        "name": "write_file",
        "description": "写入或覆盖文件",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "文件完整路径"},
            "content": {"type": "string", "description": "写入的内容"}
        }, "required": ["path", "content"]}
    }},
    {"type": "function", "function": {
        "name": "search_files",
        "description": "按文件名搜索文件",
        "parameters": {"type": "object", "properties": {
            "keyword": {"type": "string", "description": "搜索关键词"},
            "path": {"type": "string", "description": "起始目录，默认桌面"}
        }, "required": ["keyword"]}
    }},
    {"type": "function", "function": {
        "name": "execute_command",
        "description": "执行系统命令（notepad, calc, explorer 等白名单命令）",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "要执行的命令"}
        }, "required": ["command"]}
    }},
    {"type": "function", "function": {
        "name": "control_mouse",
        "description": "鼠标操作: move移动, click点击, double_click双击, right_click右键, scroll滚动",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["move", "click", "double_click", "right_click", "scroll"]},
            "x": {"type": "integer"}, "y": {"type": "integer"},
            "button": {"type": "string", "enum": ["left", "right", "middle"]},
            "clicks": {"type": "integer"}, "amount": {"type": "integer"}
        }, "required": ["action"]}
    }},
    {"type": "function", "function": {
        "name": "control_keyboard",
        "description": "键盘操作: type输入文字, press按键(hotkey组合键)",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["type", "press", "hotkey"]},
            "text": {"type": "string", "description": "要输入的文字(type时用)"},
            "keys": {"type": "string", "description": "按键名(press时用), 如 enter, tab"},
            "hotkey": {"type": "array", "items": {"type": "string"}, "description": "组合键, 如 ['ctrl','c']"}
        }, "required": ["action"]}
    }},
    {"type": "function", "function": {
        "name": "control_window",
        "description": "窗口操作: focus_window切换, list_windows列出, open打开程序, minimize_window最小化, close_window关闭",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["focus_window", "list_windows", "open", "minimize_window", "close_window"]},
            "title": {"type": "string"}, "program": {"type": "string"}, "text": {"type": "string"}
        }, "required": ["action"]}
    }},
    {"type": "function", "function": {
        "name": "open_url",
        "description": "在默认浏览器的新标签页中打开网址",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "完整网址, 如 https://www.baidu.com"}
        }, "required": ["url"]}
    }},
    {"type": "function", "function": {
        "name": "detect_screen",
        "description": "检测屏幕中的物体(YOLO目标检测)",
        "parameters": {"type": "object", "properties": {}}
    }},
    {"type": "function", "function": {
        "name": "ocr_screen",
        "description": "识别屏幕上的文字(OCR)",
        "parameters": {"type": "object", "properties": {}}
    }},
    {"type": "function", "function": {
        "name": "describe_screen",
        "description": "综合描述屏幕内容(YOLO+OCR)",
        "parameters": {"type": "object", "properties": {}}
    }},
    {"type": "function", "function": {
        "name": "get_current_time",
        "description": "获取当前日期和时间",
        "parameters": {"type": "object", "properties": {
            "timezone": {"type": "string", "description": "时区, 如 Asia/Shanghai, UTC"}
        }}
    }},
    {"type": "function", "function": {
        "name": "calculate",
        "description": "计算数学表达式, 如 2+2, sqrt(16), sin(30)",
        "parameters": {"type": "object", "properties": {
            "expression": {"type": "string", "description": "数学表达式"}
        }, "required": ["expression"]}
    }},
    {"type": "function", "function": {
        "name": "web_scraper",
        "description": "获取网页内容文本",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "网页URL"}
        }, "required": ["url"]}
    }},
    {"type": "function", "function": {
        "name": "run_python",
        "description": "执行Python代码(代码解释器)",
        "parameters": {"type": "object", "properties": {
            "code": {"type": "string", "description": "Python代码"}
        }, "required": ["code"]}
    }},
    {"type": "function", "function": {
        "name": "arxiv_search",
        "description": "搜索arXiv学术论文",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "搜索关键词"}
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
        problems.append("含 emoji")
    if mode == 'aemeath':
        if re.search(r'[\\][\([]|牛顿|薛定谔|麦克斯韦|[∫∑∂∇]|mc²', reply):
            problems.append("aemeath 不应使用学术术语")
    if mode == 'physicist':
        if re.search(r'好哒|嘤嘤|人家|喵~|Ciallo|本宝宝|嘤嘤嘤', reply):
            problems.append("physicist 不应卖萌")
    if not problems:
        return {"score": 10, "passed": True}, "rule"
    return {"score": 7, "passed": True, "warning": "；".join(problems)}, "rule_warn"


# ============================================================
# DeepSeek API 调用（含工具循环）
# ============================================================

def call_deepseek_with_tools(messages, mode='aemeath', max_rounds=15):
    current_messages = list(messages)
    for round_num in range(1, max_rounds + 1):
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

        with api_lock:
            print(f"[AI] 第{round_num}轮 | 消息数: {len(current_messages)}")
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    resp_data = json.loads(resp.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                body = e.read().decode('utf-8', errors='replace')[:300]
                return f"DeepSeek API 错误 (HTTP {e.code}): {body}", True
            except urllib.error.URLError as e:
                return f"无法连接 DeepSeek API: {e.reason}", True

        choice = resp_data['choices'][0]
        msg = choice['message']
        tool_calls = msg.get('tool_calls', [])

        if not tool_calls:
            return msg.get('content', '') or '', False

        print(f"[工具] 第{round_num}轮: {len(tool_calls)} 个调用")

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
            print(f"[工具] {name} 完成")

    return "工具调用次数过多，请简化操作", True


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

    def handle_chat(self):
        try:
            body = self.read_body()
            query = body.get('query', '').strip()
            mode = body.get('mode', 'aemeath')
            history = body.get('history', [])
            shared_memory = body.get('shared_memory', '')

            if not query:
                self.send_json(400, {"error": "missing query"})
                return

            system_prompt = MODES_CONFIG.get(mode, {}).get('system_prompt', '你是一个AI助手。')

            messages = [{"role": "system", "content": system_prompt}]
            if shared_memory:
                messages.append({"role": "system", "content": f"## 用户信息\n{shared_memory}"})
            for msg in history:
                r, c = msg.get('role', ''), msg.get('content', '')
                if r in ('user', 'assistant') and c:
                    messages.append({"role": r, "content": c})
            messages.append({"role": "user", "content": query})

            print(f"[AI] 处理 | 模式: {mode} | 查询: {query[:30]}...")

            final_text, is_error = call_deepseek_with_tools(messages, mode)
            if is_error:
                self.send_json(500, {"error": True, "message": final_text})
                return

            # OOC 检测（仅警告，不重试，避免耗时）
            ooc_result, ooc_method = fast_ooc_check(final_text, mode)

            # 流式输出
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            for i in range(0, len(final_text), 5):
                chunk = final_text[i:i+5]
                self.wfile.write(f"data: {json.dumps({'answer': chunk})}\n\n".encode('utf-8'))
                self.wfile.flush()
                time.sleep(0.01)

            self.wfile.write("data: [DONE]\n\n".encode('utf-8'))
            self.wfile.flush()

            print(f"[AI] 完成 | {len(final_text)} 字符")

        except Exception as e:
            print(f"[AI] 错误: {e}")
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
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def log_message(self, format, *args):
        pass


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    print("=" * 55)
    print("  [AI] Aemeath AI Chat Service v3")
    print(f"  端口: {DEFAULT_HOST}:{DEFAULT_PORT}")
    print(f"  模型: deepseek-v4-flash")
    print(f"  模式: {', '.join(MODES_CONFIG.keys())}")
    print(f"  工具: {len(TOOLS)} 个")
    print("=" * 55)

    server = ThreadedHTTPServer((DEFAULT_HOST, DEFAULT_PORT), AIHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n关闭中...")
        server.server_close()
