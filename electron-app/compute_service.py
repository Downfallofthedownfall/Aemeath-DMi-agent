# ============================================================
# compute_service.py - 独立计算服务
# 监听端口: 18893
# 供 LLM 通过工具调用完成物理题计算，核心目标: 让 agent "会算不编"
#
# 用法示例:
#   symbolic: POST /compute  {"mode":"symbolic","expression":"integrate(sin(x),x)"}
#   numeric:  POST /compute  {"mode":"numeric","expression":"import numpy as np; print(np.sqrt(2))"}
#   plot:     POST /compute  {"mode":"plot","expression":"x**2","vars":{"x_min":-5,"x_max":5}}
#   compare:  POST /compare  {"a":"x**2-1","b":"(x-1)*(x+1)"}
# 认证: 请求头需带 X-Auth-Token（由 Electron 主进程注入环境变量 AUTH_TOKEN）
# ============================================================
print("STEP 1: 基础 import 前", flush=True)

import os
import sys
import io
import json
import base64
import random
import traceback
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

# ---- 认证（与其他本地服务一致） ----
AUTH_TOKEN = os.environ.get('AUTH_TOKEN', '')

def _check_auth(self):
    return bool(AUTH_TOKEN) and self.headers.get('X-Auth-Token', '') == AUTH_TOKEN

# ---- Windows 编码修复（保留行缓冲，避免输出被憋住） ----
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
    sys.stderr.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)

# ---- 符号计算依赖 ----
print("STEP 2: 准备导入 sympy", flush=True)
import sympy as sp
print("STEP 3: sympy 导入完成", flush=True)
from sympy.parsing.sympy_parser import parse_expr
print("STEP 4: parse_expr 导入完成", flush=True)

# ============================================================
# 常用符号与物理常量（供 symbolic / compare 模式使用）
# ============================================================
x, y, z, t, m, q = sp.symbols('x y z t m q')       # 常用变量
omega, theta, phi = sp.symbols('omega theta phi')  # 角频率、角度
e = sp.Symbol('e')                                 # 基本电荷（符号）
E = sp.E                                           # 欧拉数 2.718...
hbar = 1.054571817e-34                             # 约化普朗克常数 (J*s)
c = 299792458                                      # 光速 (m/s)
k_B = 1.380649e-23                                 # 玻尔兹曼常数 (J/K)
g = 9.80665                                        # 标准重力加速度 (m/s^2)

# 所有可用符号/常量的字典（喂给 parse_expr 的 local_dict）
SYMBOL_TABLE = {
    'x': x, 'y': y, 'z': z, 't': t, 'm': m, 'q': q,
    'omega': omega, 'theta': theta, 'phi': phi,
    'e': e, 'E': E, 'pi': sp.pi,
    'hbar': hbar, 'c': c, 'k_B': k_B, 'g': g,
    'sin': sp.sin, 'cos': sp.cos, 'tan': sp.tan,
    'exp': sp.exp, 'log': sp.log, 'sqrt': sp.sqrt,
    'integrate': sp.integrate, 'diff': sp.diff,
    'limit': sp.limit, 'series': sp.series,
    'solve': sp.solve, 'dsolve': sp.dsolve,
    'Matrix': sp.Matrix, 'simplify': sp.simplify,
    'oo': sp.oo, 'I': sp.I,
}

# "受限名字空间解析（仅暴露白名单符号，非完整沙箱；逃逸在子进程内，主进程不受影响）
def do_symbolic(expression, vars_dict=None, timeout=15):
    """符号计算模式：在子进程中解析计算（带超时，防止复杂表达式卡死主进程）"""
    if not expression or not expression.strip():
        return {"success": False, "error": "缺少表达式"}
    # 子进程脚本：重建符号表，parse_expr 受限名字空间解析（注意: 非完整沙箱）
    script = f'''# -*- coding: utf-8 -*-
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import sympy as sp
from sympy.parsing.sympy_parser import parse_expr

x, y, z, t, m, q = sp.symbols('x y z t m q')
omega, theta, phi = sp.symbols('omega theta phi')
e = sp.Symbol('e'); E = sp.E
hbar = 1.054571817e-34; c = 299792458; k_B = 1.380649e-23; g = 9.80665
local = {{
    'x': x, 'y': y, 'z': z, 't': t, 'm': m, 'q': q,
    'omega': omega, 'theta': theta, 'phi': phi,
    'e': e, 'E': E, 'pi': sp.pi, 'hbar': hbar, 'c': c, 'k_B': k_B, 'g': g,
    'sin': sp.sin, 'cos': sp.cos, 'tan': sp.tan,
    'exp': sp.exp, 'log': sp.log, 'sqrt': sp.sqrt,
    'integrate': sp.integrate, 'diff': sp.diff,
    'limit': sp.limit, 'series': sp.series,
    'solve': sp.solve, 'dsolve': sp.dsolve,
    'Matrix': sp.Matrix, 'simplify': sp.simplify,
    'oo': sp.oo, 'I': sp.I,
}}
vars_dict = {json.dumps(vars_dict or {})}
for k, v in vars_dict.items():
    local[k] = sp.sympify(v)
try:
    expr = parse_expr({expression!r}, local_dict=local)
    result = sp.simplify(expr)
    if result.is_number and not result.has(sp.I):
        rtype = 'float'
    elif isinstance(result, sp.MatrixBase):
        rtype = 'matrix'
    elif result.has(sp.I):
        rtype = 'complex'
    else:
        rtype = 'expr'
    out = {{"success": True, "result_str": str(result),
            "result_latex": sp.latex(result), "type": rtype}}
except Exception as exc:
    out = {{"success": False, "error": str(exc)}}
print(json.dumps(out, ensure_ascii=False))
'''
    try:
        proc = subprocess.run([sys.executable, '-u', '-c', script],
                              capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"符号计算超时（{timeout}秒），表达式可能过于复杂"}
    try:
        return json.loads(proc.stdout.strip().split('\n')[-1])   # 取最后一行 JSON
    except Exception:
        return {"success": False, "error": (proc.stderr or "符号计算失败")[:500]}


# 注意: 这是"尽力而为"的受限沙箱，不是完整安全边界。
# 白名单 import 挡住了绝大多数误操作; 经典对象内省逃逸
# (().__class__.__bases__[0].__subclasses__()) 理论上仍能摸到内存中的 os。
# 本地 + token 场景风险可接受; 若需暴露到非 localhost，
# 请改用 RestrictedPython 或 Docker 隔离。
SANDBOX_PRELUDE = '''
import builtins
import sys as _sys
_orig_import = builtins.__import__

_ALLOWED = {'numpy', 'scipy', 'sympy', 'math', 'uncertainties'}

def _safe_import(name, *args, **kwargs):
    base = name.split('.')[0]
    if base not in _ALLOWED:
        raise ImportError(f"禁止导入模块: {name}")
    return _orig_import(name, *args, **kwargs)

builtins.__import__ = _safe_import

# 禁用危险内建 + 对象内省逃逸辅助
for _bad in ('eval', 'exec', 'open', 'compile', 'input', 'breakpoint'):
    setattr(builtins, _bad, None)

# 尝试内存限制（Windows 不支持 resource，自动跳过）
try:
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
except Exception:
    pass

# 常用快捷导入
import math
import numpy as np
from scipy import integrate, optimize, signal
from sympy import symbols, diff, integrate as sint
'''

def do_numeric(code, timeout=10, max_output=10240):
    """数值计算模式：在子进程中执行受限代码"""
    if not code or not code.strip():
        return {"success": False, "error": "缺少代码"}
    full_code = SANDBOX_PRELUDE + "\n" + code
    try:
        proc = subprocess.run(
            [sys.executable, '-u', '-c', full_code],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"代码执行超时（{timeout}秒）"}
    stdout = proc.stdout[:max_output]     # 截断输出
    stderr = proc.stderr[:max_output]
    if proc.returncode != 0:              # 子进程报错
        return {"success": False, "error": stderr or "执行失败", "stdout": stdout}
    return {"success": True, "stdout": stdout, "stderr": stderr,
            "returncode": proc.returncode}

def do_plot(expression, x_min=-5, x_max=5, y_label='', caption=''):
    """绘图模式：matplotlib 生成图表，输出 base64 PNG"""
    import matplotlib
    matplotlib.use('Agg')               # 无界面后端（服务器环境必需）
    import matplotlib.pyplot as plt
    import numpy as np
    # 中文字体处理
    plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei',
                                       'Arial Unicode MS', 'DejaVu Sans']
    plt.rcParams['axes.unicode_minus'] = False    # 负号正常显示

    expr = parse_expr(expression, local_dict=SYMBOL_TABLE)
    f = sp.lambdify(x, expr, 'numpy')   # 符号表达式 -> numpy 函数

    xs = np.linspace(x_min, x_max, 400) # 400 个均匀采样点
    try:
        ys = f(xs)
    except Exception as e:
        return {"success": False, "error": f"求值失败: {e}"}

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.plot(xs, ys, color='#4f46e5', linewidth=2)
    ax.set_xlabel('x')
    ax.set_ylabel(y_label or 'y')
    ax.set_title(caption or f"y = {sp.latex(expr)}", fontsize=12)
    ax.grid(True, alpha=0.3)
    # 无边框：去掉上、右边框
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)

    buf = io.BytesIO()                  # 内存中的"文件"
    fig.savefig(buf, format='png', dpi=100, bbox_inches='tight')
    plt.close(fig)                      # 关闭图形，释放内存
    img_b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    return {"success": True, "image_base64": img_b64,
            "caption": caption or f"y = {sp.latex(expr)}"}

def do_compare(a, b, samples=5, tol=1e-6):
    """答案比对：先符号化简，失败回退数值代入"""
    # 解析单独放一个 try：任一边失败都直接返回明确错误（避免 NameError 陷阱）
    try:
        expr_a = parse_expr(a, local_dict=SYMBOL_TABLE)
        expr_b = parse_expr(b, local_dict=SYMBOL_TABLE)
    except Exception as e:
        return {"success": False, "error": f"表达式解析失败: {e}"}

    # 1. 符号比对：a - b 化简是否为 0
    try:
        if sp.simplify(expr_a - expr_b) == 0:
            return {"success": True, "equivalent": True, "method": "symbolic"}
    except Exception:
        pass    # 化简失败就回退数值

    # 2. 数值回退：多组随机数代入
    try:
        free = sorted(expr_a.free_symbols | expr_b.free_symbols, key=str)
        if not free:
            # 纯数值但符号比对失败 → 直接判不等
            return {"success": True, "equivalent": False, "method": "numeric"}
        for _ in range(samples):
            subs = {s: random.uniform(0.5, 5.0) for s in free}
            va = float(expr_a.evalf(subs=subs))
            vb = float(expr_b.evalf(subs=subs))
            if abs(va - vb) > tol:
                return {"success": True, "equivalent": False, "method": "numeric"}
        return {"success": True, "equivalent": True, "method": "numeric"}
    except Exception as e:
        return {"success": False, "error": str(e)}


class ComputeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not _check_auth(self):
            self.send_json(401, {"success": False, "error": "unauthorized"})
            return
        if self.path == '/health':
            self.send_json(200, {"success": True, "service": "compute"})
        else:
            self.send_json(404, {"success": False, "error": "not found"})

    def do_POST(self):
        if not _check_auth(self):
            self.send_json(401, {"success": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length > 1024 * 1024:                          # 1MB 上限
                self.send_json(413, {"success": False, "error": "请求体过大（最大 1MB）"})
                return
            body = self.rfile.read(length) if length else b'{}'
            data = json.loads(body)
            if self.path == '/compute':
                self.handle_compute(data)
            elif self.path == '/compare':
                self.handle_compare(data)
            else:
                self.send_json(404, {"success": False, "error": "not found"})
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e),
                                 "trace": traceback.format_exc()})
            
    def handle_compute(self, data):
        mode = data.get('mode', 'symbolic')
        expression = data.get('expression', '')
        vars_dict = data.get('vars', {}) or {}
        # timeout 钳制在 1~30 秒之间，防止请求方绕过超时
        timeout = min(max(data.get('timeout', 10), 1), 30)
        if mode == 'symbolic':
            result = do_symbolic(expression, vars_dict, timeout)
        elif mode == 'numeric':
            result = do_numeric(expression, timeout, 10240)   # 输出固定 10KB
        elif mode == 'plot':
            result = do_plot(expression,
                             float(vars_dict.get('x_min', -5)),
                             float(vars_dict.get('x_max', 5)),
                             vars_dict.get('y_label', ''),
                             data.get('caption', ''))
        else:
            result = {"success": False, "error": f"未知模式: {mode}"}
        self.send_json(200, result)

    def handle_compare(self, data):
        self.send_json(200, do_compare(data.get('a', ''), data.get('b', '')))

    def send_json(self, status, data):
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', ''))
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token')
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
        except Exception:
            pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', ''))
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def log_message(self, format, *args):
        pass    # 关闭默认访问日志


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """多线程服务器：一个计算任务不阻塞其他请求"""
    daemon_threads = True

def self_test():
    """演示三个模式各一个调用（自测失败不影响服务启动）"""
    print("===== 自测开始 =====")
    try:
        r = do_symbolic("integrate(sin(x), x)")
        print("[symbolic]", r.get('result_str', r.get('error')))
    except Exception as e:
        print("[symbolic] 自测异常:", e)
    try:
        r = do_numeric("import numpy as np\nprint(np.sqrt(2))")
        print("[numeric]", r.get('error') or r.get('stdout', '').strip())
    except Exception as e:
        print("[numeric] 自测异常:", e)
    try:
        r = do_plot("x**2")
        print("[plot] PNG base64 长度:", len(r.get('image_base64', '')))
    except Exception as e:
        print("[plot] 自测异常:", e)
    try:
        r = do_compare("x**2-1", "(x-1)*(x+1)")
        print("[compare]", r)
    except Exception as e:
        print("[compare] 自测异常:", e)
    print("===== 自测结束 =====")

if __name__ == '__main__':
    self_test()     # 先跑三个模式自测
    HOST, PORT = '127.0.0.1', 18893
    server = ThreadedHTTPServer((HOST, PORT), ComputeHandler)
    print(f"计算服务已启动: http://{HOST}:{PORT}")
    print("  模式: symbolic / numeric / plot / compare")
    print("  AUTH_TOKEN 已启用" if AUTH_TOKEN else "  警告: 未设置 AUTH_TOKEN")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭...")
        server.server_close()
