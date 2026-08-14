# -*- coding: utf-8 -*-
# ============================================================
# sympy_mcp/server.py — SymPy 计算 MCP server（自 v1 compute_service.py 移植）
# 工具（dsh 侧名称 mcp__sympy__<name>）：
#   compute_symbolic   符号推导（积分/微分/求极限/解方程/化简…，物理常量表）
#   compute_numeric    数值计算（受限 numpy/scipy 沙箱子进程，10KB 输出截断）
#   compute_plot       函数绘图（matplotlib Agg，base64 PNG）
#   compare_answers    表达式等价性比对（符号化简优先，数值代入回退）
# 安全：与 v1 一致——symbolic 用受限名字空间子进程解析；numeric 用白名单
#       import + 禁用危险内建 + 内存限制（尽力而为）+ 子进程隔离 + 超时钳制。
# 运行：python packages/py-services/sympy_mcp/server.py
# ============================================================
import os
import sys
import io
import json
import base64
import random
import subprocess

# ---- 允许从父目录导入 mcp_core（无论 cwd 在哪） ----
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mcp_core import McpServer  # noqa: E402

server = McpServer("sympy_mcp", "2.0.0-m0")

# ============================================================
# 符号与物理常量（喂给 parse_expr 的 local_dict；与 v1 一致）
# ============================================================
SYMBOL_TABLE_SOURCE = """
x, y, z, t, m, q = sp.symbols('x y z t m q')
omega, theta, phi = sp.symbols('omega theta phi')
e = sp.Symbol('e'); E = sp.E
hbar = 1.054571817e-34; c = 299792458; k_B = 1.380649e-23; g = 9.80665
"""

SYMBOL_TABLE_DICT = """{
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
}"""


def _clamp_timeout(t, lo=1, hi=30):
    try:
        return min(max(float(t), lo), hi)
    except Exception:  # noqa: BLE001
        return hi


def _symbol_local():
    """构建 parse_expr 的 local_dict（执行符号表源码 + 求值字典，含物理常量）。"""
    import sympy as sp
    ns = {"sp": sp}
    exec(SYMBOL_TABLE_SOURCE, ns)      # 定义 x/y/z/t/m/q/omega/theta/phi/e/E/hbar/c/k_B/g
    return eval(SYMBOL_TABLE_DICT, ns)  # 字符串本身带 {}，直接求值为 dict


def do_symbolic(expression, vars_dict=None, timeout=15):
    """符号计算：子进程受限名字空间解析（带超时，防复杂表达式卡死）。"""
    if not expression or not expression.strip():
        return {"success": False, "error": "缺少表达式"}
    script = f'''# -*- coding: utf-8 -*-
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import sympy as sp
from sympy.parsing.sympy_parser import parse_expr

{SYMBOL_TABLE_SOURCE}
local = {SYMBOL_TABLE_DICT}
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
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    try:
        proc = subprocess.run([sys.executable, '-u', '-c', script],
                              capture_output=True, text=True, timeout=timeout,
                              encoding='utf-8', errors='replace', env=env)
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"符号计算超时（{timeout}秒），表达式可能过于复杂"}
    try:
        return json.loads(proc.stdout.strip().split('\n')[-1])
    except Exception:  # noqa: BLE001
        return {"success": False, "error": (proc.stderr or "符号计算失败")[:500]}


# 尽力而为的受限沙箱（白名单 import + 禁用危险内建 + 内存限制；真实边界 = 子进程隔离）
SANDBOX_PRELUDE = '''
import builtins
import sys as _sys

try:
    _sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    _sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

_orig_import = builtins.__import__
_ALLOWED = {'numpy', 'scipy', 'sympy', 'math', 'uncertainties'}
_STDLIB = set(getattr(_sys, 'stdlib_module_names', ())) | set(_sys.builtin_module_names)

def _safe_import(name, *args, **kwargs):
    level = kwargs.get('level', 0)
    if len(args) > 3:
        level = args[3]
    if level > 0:
        return _orig_import(name, *args, **kwargs)
    base = name.split('.')[0]
    if base in _ALLOWED or base in _STDLIB or base.startswith('_') or base in _sys.modules:
        return _orig_import(name, *args, **kwargs)
    raise ImportError(f"禁止导入模块: {{name}}")

builtins.__import__ = _safe_import

import math
import numpy as np
from scipy import integrate, optimize, signal

for _bad in ('eval', 'exec', 'open', 'compile', 'input', 'breakpoint'):
    setattr(builtins, _bad, None)

try:
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
except Exception:
    pass
'''


def do_numeric(code, timeout=10, max_output=10240):
    """数值计算：子进程执行受限代码（修复 v1 的 env 变量缺失 bug）。"""
    if not code or not code.strip():
        return {"success": False, "error": "缺少代码"}
    full_code = SANDBOX_PRELUDE + "\n" + code
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    try:
        proc = subprocess.run(
            [sys.executable, '-u', '-c', full_code],
            capture_output=True, text=True, timeout=timeout,
            encoding='utf-8', errors='replace', env=env,
        )
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"代码执行超时（{timeout}秒）"}
    stdout = proc.stdout[:max_output]
    stderr = proc.stderr[:max_output]
    if proc.returncode != 0:
        return {"success": False, "error": stderr or "执行失败", "stdout": stdout}
    return {"success": True, "stdout": stdout, "stderr": stderr,
            "returncode": proc.returncode}


def do_plot(expression, x_min=-5, x_max=5, y_label='', caption=''):
    """绘图：matplotlib 生成 PNG，base64 输出。"""
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import numpy as np
    except ImportError:
        return {"success": False, "error": "matplotlib 未安装（pip install matplotlib）"}
    plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei',
                                       'Arial Unicode MS', 'DejaVu Sans']
    plt.rcParams['axes.unicode_minus'] = False

    try:
        import sympy as sp
        from sympy.parsing.sympy_parser import parse_expr
        local = _symbol_local()
        x = local['x']
        expr = parse_expr(expression, local_dict=local)
        f = sp.lambdify(x, expr, 'numpy')
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": f"表达式解析失败: {e}"}

    xs = np.linspace(float(x_min), float(x_max), 400)
    try:
        ys = f(xs)
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": f"求值失败: {e}"}

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.plot(xs, ys, color='#4f46e5', linewidth=2)
    ax.set_xlabel('x')
    ax.set_ylabel(y_label or 'y')
    ax.set_title(caption or f"y = {sp.latex(expr)}", fontsize=12)
    ax.grid(True, alpha=0.3)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)

    buf = io.BytesIO()
    fig.savefig(buf, format='png', dpi=100, bbox_inches='tight')
    plt.close(fig)
    img_b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    return {"success": True, "image_base64": img_b64,
            "caption": caption or f"y = {sp.latex(expr)}"}


def do_compare(a, b, samples=5, tol=1e-6):
    """答案比对：符号化简优先，失败回退多组随机数值代入。"""
    try:
        import sympy as sp
        from sympy.parsing.sympy_parser import parse_expr
        local = _symbol_local()
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": f"sympy 导入失败: {e}"}

    try:
        expr_a = parse_expr(a, local_dict=local)
        expr_b = parse_expr(b, local_dict=local)
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": f"表达式解析失败: {e}"}

    try:
        if sp.simplify(expr_a - expr_b) == 0:
            return {"success": True, "equivalent": True, "method": "symbolic"}
    except Exception:  # noqa: BLE001
        pass

    try:
        free = sorted(expr_a.free_symbols | expr_b.free_symbols, key=str)
        if not free:
            return {"success": True, "equivalent": False, "method": "numeric"}
        for _ in range(int(samples)):
            subs = {s: random.uniform(0.5, 5.0) for s in free}
            va = float(expr_a.evalf(subs=subs))
            vb = float(expr_b.evalf(subs=subs))
            if abs(va - vb) > float(tol):
                return {"success": True, "equivalent": False, "method": "numeric"}
        return {"success": True, "equivalent": True, "method": "numeric"}
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": str(e)}


# ============================================================
# 工具注册
# ============================================================
@server.tool(
    "compute_symbolic",
    "SymPy 符号计算：积分、微分、极限、级数、解方程（含微分方程）、化简、矩阵。"
    "支持物理常量（hbar/c/k_B/g）与常用符号（x y z t m q omega theta phi）。"
    "返回 result_str/result_latex/type。适合推导公式、验证恒等式、求原函数。",
    {
        "type": "object",
        "properties": {
            "expression": {"type": "string", "description": 'SymPy 表达式，如 "integrate(sin(x),x)" 或 "diff(x**3,x)" 或 "solve(x**2-4,x)"'},
            "vars": {"type": "object", "description": "可选变量代入，如 {\"m\": 2, \"g\": 9.8}"},
            "timeout": {"type": "number", "description": "超时秒数（1-30，默认 15）"},
        },
        "required": ["expression"],
        "additionalProperties": False,
    },
)
def compute_symbolic(expression: str, vars=None, timeout=15):  # noqa: A002
    return do_symbolic(expression, vars or {}, _clamp_timeout(timeout, 1, 30))


@server.tool(
    "compute_numeric",
    "数值计算：在受限 numpy/scipy 沙箱子进程中执行 Python 代码并返回 stdout。"
    "预置 import math / numpy as np / scipy 的 integrate、optimize、signal。"
    "用于需要数值解的场合（求根、积分、拟合）。禁止 import 白名单外模块。",
    {
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": 'Python 代码，如 "import numpy as np\\nprint(np.sqrt(2))" 或 "print(optimize.brentq(lambda x: x**2-2, 0, 2))"'},
            "timeout": {"type": "number", "description": "超时秒数（1-30，默认 10）"},
        },
        "required": ["code"],
        "additionalProperties": False,
    },
)
def compute_numeric(code: str, timeout=10):
    return do_numeric(code, _clamp_timeout(timeout, 1, 30))


@server.tool(
    "compute_plot",
    "函数绘图：对一元表达式 x 生成 matplotlib 折线图，返回 base64 PNG（image_base64）。"
    "用于展示函数形状、解的位置、物理运动轨迹等。",
    {
        "type": "object",
        "properties": {
            "expression": {"type": "string", "description": '一元表达式，如 "x**2-4" 或 "sin(x)*exp(-x/5)"'},
            "x_min": {"type": "number", "description": "x 下限，默认 -5"},
            "x_max": {"type": "number", "description": "x 上限，默认 5"},
            "y_label": {"type": "string", "description": "y 轴标签（可选）"},
            "caption": {"type": "string", "description": "图标题（可选）"},
        },
        "required": ["expression"],
        "additionalProperties": False,
    },
)
def compute_plot(expression: str, x_min=-5, x_max=5, y_label="", caption=""):
    try:
        return do_plot(expression, float(x_min), float(x_max), y_label, caption)
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": str(e)}


@server.tool(
    "compare_answers",
    "表达式等价性比对：判断两个表达式/答案是否等价。先符号化简，失败则多组"
    "随机数值代入（tol 1e-6）。返回 equivalent/method（symbolic 或 numeric）。",
    {
        "type": "object",
        "properties": {
            "a": {"type": "string", "description": '第一个表达式，如 "x**2-1"'},
            "b": {"type": "string", "description": '第二个表达式，如 "(x-1)*(x+1)"'},
            "samples": {"type": "number", "description": "数值回退抽样组数，默认 5"},
            "tol": {"type": "number", "description": "数值容差，默认 1e-6"},
        },
        "required": ["a", "b"],
        "additionalProperties": False,
    },
)
def compare_answers(a: str, b: str, samples=5, tol=1e-6):
    return do_compare(a, b, samples, tol)


if __name__ == "__main__":
    server.run()
