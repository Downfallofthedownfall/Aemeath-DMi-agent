# ============================================================
# mcp_server.py - 通用 MCP 服务器（完全放开版）
# 没有任何路径限制，AI 可以读写任何文件
# 
# 在 Dify 中添加 MCP 工具时填入：
#   http://host.docker.internal:18889
#
# 如何添加新工具？
# 1. 写一个函数，用 @register_tool 装饰
# 2. 重启服务器
# 搞定。
# ============================================================
import sys
sys.stdout.reconfigure(line_buffering=True)
import os
import sys
import json
from http.server import HTTPServer, BaseHTTPRequestHandler

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

# ============================================================
# 工具注册表
# ============================================================

TOOL_REGISTRY = {}

def register_tool(name, description, input_schema):
    def decorator(func):
        TOOL_REGISTRY[name] = {
            "fn": func,
            "desc": description,
            "schema": input_schema
        }
        return func
    return decorator


# ============================================================
# 工具函数定义区
# ============================================================

# ----- 工具 1：列出目录 -----
@register_tool(
    name="list_files",
    description="列出指定目录中的文件和文件夹",
    input_schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "目录路径，默认为桌面"
            }
        }
    }
)
def handle_list_files(args):
    path = args.get("path", "D:/")
    try:
        items = os.listdir(path)
        return f"成功！路径 {path} 下共有 {len(items)} 项：\n" + "\n".join(items[:50])
    except Exception as e:
        return f"失败：{type(e).__name__} - {str(e)}"

# ----- 工具 2：读取文件 -----
@register_tool(
    name="read_file",
    description="读取文件内容",
    input_schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "文件完整路径"
            }
        },
        "required": ["path"]
    }
)
def handle_read_file(args):
    path = args.get("path", "")
    if not path:
        return "错误：缺少路径参数"
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        return "文件：" + path + "\n\n" + content
    except Exception as e:
        return "错误：" + str(e)


# ----- 工具 3：写入文件 -----
@register_tool(
    name="write_file",
    description="写入文件内容",
    input_schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "文件完整路径"
            },
            "content": {
                "type": "string",
                "description": "要写入的内容"
            }
        },
        "required": ["path", "content"]
    }
)
def handle_write_file(args):
    path = args.get("path", "")
    content = args.get("content", "")
    if not path:
        return "错误：缺少路径参数"
    try:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        return "已写入文件：" + path + "（" + str(len(content)) + " 字符）"
    except Exception as e:
        return "错误：" + str(e)


# ----- 工具 4：搜索文件 -----
@register_tool(
    name="search_files",
    description="按文件名搜索文件",
    input_schema={
        "type": "object",
        "properties": {
            "keyword": {
                "type": "string",
                "description": "搜索关键词"
            },
            "path": {
                "type": "string",
                "description": "搜索起始目录，默认为桌面"
            }
        },
        "required": ["keyword"]
    }
)
def handle_search_files(args):
    keyword = args.get("keyword", "")
    path = args.get("path", os.path.expanduser("~\\Desktop"))
    if not keyword:
        return "错误：缺少搜索关键词"
    try:
        results = []
        for root, dirs, files in os.walk(path):
            depth = root.replace(path, '').count(os.sep)
            if depth > 5:
                continue
            for file in files:
                if keyword.lower() in file.lower():
                    full_path = os.path.join(root, file)
                    size = os.path.getsize(full_path)
                    results.append(f"{full_path} ({size} 字节)")
        if results:
            return "搜索「" + keyword + "」找到 " + str(len(results)) + " 个结果：\n\n" + "\n".join(results)
        else:
            return "未找到包含「" + keyword + "」的文件"
    except Exception as e:
        return "错误：" + str(e)


# ============================================================
# MCP 协议层（不需要修改）
# ============================================================

class MCPHandler(BaseHTTPRequestHandler):
    
    def do_GET(self):
        if self.path in ['/health', '/mcp/health']:
            self.send_json(200, {"status": "ok", "service": "mcp-server", "tools": list(TOOL_REGISTRY.keys())})
            return
        self.send_json(404, {"error": "not found"})
    
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else b'{}'
        
        try:
            req_json = json.loads(body)
        except:
            req_json = {}
        
        # 打印收到的请求（调试用）
        print("[收到]", json.dumps(req_json, ensure_ascii=False, indent=2))
        
        method = req_json.get('method', '')
        req_id = req_json.get('id', None)
        
        # 1. 初始化
        if method == 'initialize':
            client_version = req_json.get('params', {}).get('protocolVersion', '2025-06-18')
            self.send_json(200, {
                "jsonrpc": "2.0",
                "result": {
                    "protocolVersion": client_version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "mcp-server", "version": "1.0.0"}
                },
                "id": req_id
            })
        
        # 2. 初始化完成通知
        elif method == 'notifications/initialized':
            self.send_response(202)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{}')
        
        # 3. 列出工具
        elif method == 'tools/list':
            tools = []
            for name, info in TOOL_REGISTRY.items():
                tools.append({
                    "name": name,
                    "description": info["desc"],
                    "inputSchema": info["schema"]
                })
            self.send_json(200, {
                "jsonrpc": "2.0",
                "result": {"tools": tools},
                "id": req_id
            })
        
        # 4. 调用工具
        elif method == 'tools/call':
            params = req_json.get('params', {})
            name = params.get('name', '')
            arguments = params.get('arguments', {})
            
            if name in TOOL_REGISTRY:
                try:
                    result_text = TOOL_REGISTRY[name]["fn"](arguments)
                except Exception as e:
                    result_text = "执行错误：" + str(e)
            else:
                result_text = "未知工具：" + name
            
            self.send_json(200, {
                "jsonrpc": "2.0",
                "result": {
                    "content": [{"type": "text", "text": result_text}]
                },
                "id": req_id
            })
        
        else:
            self.send_json(200, {
                "jsonrpc": "2.0",
                "result": {"content": [{"type": "text", "text": f"未知方法: {method}"}]},
                "id": req_id
            })
    
    def send_json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
    
    def log_message(self, format, *args):
        pass


def main():
    HOST = "0.0.0.0"
    PORT = 18889
    
    server = HTTPServer((HOST, PORT), MCPHandler)
    
    print("=" * 50)
    print("  通用 MCP 服务器（完全放开版）")
    print(f"  地址: http://{HOST}:{PORT}")
    print(f"  在 Dify 中填入: http://host.docker.internal:{PORT}")
    print("=" * 50)
    print(f"\n  已注册 {len(TOOL_REGISTRY)} 个工具:")
    for name in TOOL_REGISTRY:
        print(f"    - {name}: {TOOL_REGISTRY[name]['desc']}")
    print(f"\n  按 Ctrl+C 停止")
    
    server = HTTPServer((HOST, PORT), MCPHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭服务器...")
        server.server_close()
        print("服务器已停止。")


if __name__ == "__main__":
    main()
