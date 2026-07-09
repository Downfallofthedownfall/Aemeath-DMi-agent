# 导入必要的标准库模块
import json                     # 用于解析 JSON 配置文件
import os                       # 用于检查文件路径和存在性
import sys                      # 用于程序退出
import subprocess               # 用于执行系统命令
from http.server import HTTPServer, BaseHTTPRequestHandler  # 用于创建 HTTP 服务器

# ========== 全局配置变量（默认值） ==========
DEFAULT_TIMEOUT = 10            # 默认命令执行超时秒数
DEFAULT_HOST = '127.0.0.1'       # 默认监听地址
DEFAULT_PORT = 18888            # 默认监听端口

# 定义配置文件路径（与脚本同目录）
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(SCRIPT_DIR, 'py_config.json')


# ========== 加载配置函数 ==========
def load_config(filepath):
    """
    从 py_config.json 加载所有配置（超时、监听地址端口、白名单）。
    支持的键：
        - timeout_seconds: 命令执行超时秒数（int/float）
        - host: 监听地址（str）
        - port: 监听端口（int）
        - allowed_commands: 白名单命令列表（数组，每个元素为字符串）
    返回一个字典，包含以下处理后的键：
        'timeout_seconds': float/int
        'host': str
        'port': int
        'allowed_commands': set (小写字符串集合)
    缺失的键使用默认值，格式错误时程序退出。
    """
    if not os.path.exists(filepath):
        print(f"错误：配置文件 '{filepath}' 不存在。")
        sys.exit(1)

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            raw_config = json.load(f)
    except json.JSONDecodeError as e:
        print(f"错误：配置文件 JSON 格式无效: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"错误：读取配置文件失败: {e}")
        sys.exit(1)

    # 初始化默认配置
    config = {
        'timeout_seconds': DEFAULT_TIMEOUT,
        'host': DEFAULT_HOST,
        'port': DEFAULT_PORT,
        'allowed_commands': set(),
    }

    # ---------- 处理超时时间 ----------
    if 'timeout_seconds' in raw_config:
        val = raw_config['timeout_seconds']
        if isinstance(val, (int, float)) and val > 0:
            config['timeout_seconds'] = val
        else:
            print(f"警告：timeout_seconds 必须为正数，将使用默认值 {DEFAULT_TIMEOUT}")

    # ---------- 处理监听地址 ----------
    if 'host' in raw_config:
        val = raw_config['host']
        if isinstance(val, str) and val.strip():
            config['host'] = val.strip()
        else:
            print(f"警告：host 必须是非空字符串，将使用默认值 {DEFAULT_HOST}")

    # ---------- 处理监听端口 ----------
    if 'port' in raw_config:
        val = raw_config['port']
        if isinstance(val, int) and 1 <= val <= 65535:
            config['port'] = val
        else:
            print(f"警告：port 必须是 1-65535 的整数，将使用默认值 {DEFAULT_PORT}")

    # ---------- 处理白名单（最关键部分） ----------
    if 'allowed_commands' not in raw_config:
        print("错误：配置文件中缺少 'allowed_commands' 字段。")
        sys.exit(1)

    raw_commands = raw_config['allowed_commands']
    if not isinstance(raw_commands, list):
        print("错误：allowed_commands 必须是数组（列表）。")
        sys.exit(1)

    cleaned = set()
    for cmd in raw_commands:
        if isinstance(cmd, str):
            stripped = cmd.strip()
            if stripped:
                cleaned.add(stripped.lower())   # 统一转为小写，方便后续不区分大小写匹配
        else:
            print(f"警告：忽略非字符串类型的命令: {cmd}")

    if not cleaned:
        print("错误：allowed_commands 中没有包含任何有效命令。")
        sys.exit(1)

    config['allowed_commands'] = cleaned
    print(f"已加载白名单，共 {len(cleaned)} 条命令。")
    return config


# ========== 动态路径规则检查 ==========
def is_allowed_dynamic_exe(command):
    """
    检查命令是否符合动态规则：
    "start " 后跟一个实际存在的 .exe 文件路径（可为绝对或相对路径，可带引号）
    示例：
        start C:\\tools\\myapp.exe
        start "C:\\Program Files\\app\\app.exe"
    返回 True 表示允许，False 表示不符合。
    """
    cmd_lower = command.lower()
    if not cmd_lower.startswith("start "):
        return False

    # 提取 "start " 后面的部分（保留原始大小写用于文件系统检查）
    tail = command[6:].strip()

    # 处理可能存在的引号（双引号或单引号）
    path_candidate = tail
    if len(path_candidate) >= 2 and path_candidate[0] == path_candidate[-1] and path_candidate[0] in ('"', "'"):
        path_candidate = path_candidate[1:-1].strip()

    # 检查文件扩展名是否为 .exe（忽略大小写）
    if not path_candidate.lower().endswith('.exe'):
        return False

    # 检查该文件是否真实存在
    if os.path.isfile(path_candidate):
        return True
    return False


# ========== 加载配置 ==========
config = load_config(CONFIG_FILE)
ALLOWED_COMMANDS = config['allowed_commands']   # 静态白名单集合（小写）
TIMEOUT = config['timeout_seconds']
HOST = config['host']
PORT = config['port']


# ========== HTTP 请求处理器 ==========
class ExecuteHandler(BaseHTTPRequestHandler):
    """
    处理 POST /execute 请求，执行安全的 Windows 命令。
    安全策略：
        1. 命令必须在静态白名单（ALLOWED_COMMANDS）中；
        2. 或者命令以 "start " 开头，且后面是一个实际存在的 .exe 文件路径。
    """

    def do_POST(self):
        if self.path != '/execute':
            self.send_error_response(404, "路径未找到，请使用 POST /execute")
            return

        try:
            # 读取请求体长度
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length == 0:
                self.send_error_response(400, "请求体为空")
                return

            # 解析 JSON 请求体
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self.send_error_response(400, "请求体不是有效的 JSON 格式")
                return

            command = data.get('command', '').strip()
            if not command:
                self.send_error_response(400, "缺少 'command' 字段或为空")
                return

            # ---------- 安全检查 ----------
            allowed = False
            # 检查1：静态白名单（不区分大小写）
            if command.lower() in ALLOWED_COMMANDS:
                allowed = True
            # 检查2：动态 exe 路径规则
            elif is_allowed_dynamic_exe(command):
                allowed = True

            if not allowed:
                self.send_error_response(
                    403,
                    f"命令 '{command}' 不在白名单中，且不符合 'start <exe文件路径>' 规则"
                )
                return

            # ---------- 执行命令 ----------
            result = subprocess.run(
                ['cmd', '/c', command],
                capture_output=True,
                text=True,
                timeout=TIMEOUT
            )

            # 构建成功响应
            response_data = {
                "success": True,
                "command": command,
                "returncode": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr
            }
            self.send_json_response(200, response_data)

        except subprocess.TimeoutExpired:
            self.send_error_response(408, f"命令执行超时 ({TIMEOUT}秒)")
        except Exception as e:
            self.send_error_response(500, f"服务器内部错误: {str(e)}")

    def send_json_response(self, status_code, data):
        """发送 JSON 格式的成功/错误响应"""
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def send_error_response(self, status_code, message):
        """发送统一的错误 JSON 响应"""
        self.send_json_response(status_code, {"success": False, "error": message})

    def log_message(self, format, *args):
        # 禁用默认的访问日志（可注释以启用）
        pass


# ========== 主程序入口 ==========
if __name__ == '__main__':
    print(f"服务器配置：")
    print(f"  监听地址: {HOST}:{PORT}")
    print(f"  命令超时: {TIMEOUT} 秒")
    print(f"  白名单命令数: {len(ALLOWED_COMMANDS)}")
    print(f"按 Ctrl+C 停止服务器")

    server = HTTPServer((HOST, PORT), ExecuteHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭服务器...")
        server.server_close()
        print("服务器已停止。")
