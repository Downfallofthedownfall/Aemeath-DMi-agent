# -*- coding: utf-8 -*-
# ============================================================
# sympy_mcp/server.py — SymPy 计算 MCP server（自 v1 compute_service.py 移植）
# 工具（dsh 侧名称 mcp__sympy__<name>）：
#   compute_symbolic   符号推导（积分/微分/求极限/解方程/化简…，物理常量表）
#   compute_numeric    数值计算（受限 numpy/scipy 沙箱子进程，10KB 输出截断）
#   compute_plot       函数绘图（matplotlib Agg，base64 PNG）
#   compare_answers    表达式等价性比对（符号化简优先，数值代入回退）
# 安全（v2 加固）：
#   - 所有 parse/simplify/求值一律在子进程执行（主进程不 eval 任何模型输入）；
#   - parse_expr 统一走 safe_parse：token 黑名单（拒绝 __ 开头的名称与 . 属性访问）
#     + global_dict={'__builtins__': {}}（eval 时无任何内建）；
#   - compute_numeric 子进程：预载科学栈后安装严格导入白名单（仅
#     numpy/scipy/sympy/math/uncertainties 五模块，删除 _STDLIB/sys.modules/
#     level>0 直通分支）+ 置空危险内建 + 用户代码在隔离命名空间执行（不泄漏
#     _sys/_orig_import/builtins）+ 内存限制（尽力而为）+ 超时钳制。
#   真实边界 = 子进程隔离（沙箱内可被深度内省绕过，但可显著抬高利用成本）。
# 运行：python packages/py-services/sympy_mcp/server.py
# ============================================================
import os
import sys
import io
import json
import base64
import random
import threading
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


def _run_captured(argv, timeout, max_stdout, max_stderr):
    """带输出上限的子进程执行（防无界捕获：超限部分截断丢弃，管道仍被排空防死锁）。

    返回 dict：{returncode, stdout, stderr, timed_out, stdout_truncated, stderr_truncated}
    """
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding='utf-8', errors='replace', env=env)
    result = {'stdout': '', 'stderr': '', 'returncode': None,
              'timed_out': False, 'stdout_truncated': False, 'stderr_truncated': False}

    def _pump(stream, sink, cap, flag):
        buf = []
        n = 0
        try:
            while True:
                chunk = stream.read(8192)
                if not chunk:
                    break
                if n + len(chunk) > cap:
                    result[flag] = True
                    n += len(chunk)  # 只计数不累积，继续排空管道（防子进程写满阻塞）
                    continue
                buf.append(chunk)
                n += len(chunk)
        finally:
            result[sink] = ''.join(buf)

    threads = [
        threading.Thread(target=_pump, args=(proc.stdout, 'stdout', max_stdout, 'stdout_truncated')),
        threading.Thread(target=_pump, args=(proc.stderr, 'stderr', max_stderr, 'stderr_truncated')),
    ]
    for t in threads:
        t.start()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        result['timed_out'] = True
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        proc.wait()
    for t in threads:
        t.join(2.0)
    result['returncode'] = proc.returncode
    return result


def _run_child(script, timeout, max_stdout=2 * 1024 * 1024, max_stderr=64 * 1024):
    """在子进程运行脚本并解析最后一行 JSON 输出（UTF-8 安全，输出有上限）。"""
    r = _run_captured([sys.executable, '-u', '-c', script], timeout, max_stdout, max_stderr)
    if r['timed_out']:
        return {"success": False, "error": f"计算超时（{timeout}秒），表达式/代码可能过于复杂"}
    if not r['stdout'].strip():
        return {"success": False, "error": (r['stderr'] or "子进程无输出")[:500]}
    try:
        return json.loads(r['stdout'].strip().split('\n')[-1])
    except Exception:  # noqa: BLE001
        return {"success": False, "error": (r['stderr'] or "子进程输出解析失败")[:500]}


# ============================================================
# 安全符号解析片段（嵌入每个子进程脚本）：
#   - token 黑名单：拒绝 '__' 开头的 NAME（dunder 逃逸链，如 __class__/__import__）
#     与 OP '.'（属性访问，如 ().__class__ 的 '.'）；均在 eval 之前拦截；
#   - global_dict={'__builtins__': {}}：eval 时无任何内建可用（禁 __import__/open 等）。
# 注意：parse_expr 的默认 global_dict 会让 Python 自动注入真实 builtins，
#      必须显式置空 __builtins__ 才能封死 eval 逃逸。
# ============================================================
SAFE_PARSE_SNIPPET = '''
from sympy.parsing.sympy_parser import parse_expr, standard_transformations

def _reject_dangerous(tokens, local_dict, global_dict):
    for tok in tokens:
        if tok[0] == 'NAME' and tok[1].startswith('__'):
            raise ValueError("禁止的名称: " + tok[1])
        if tok[0] == 'OP' and tok[1] == '.':
            raise ValueError("禁止的属性访问（表达式不允许点号）")
    return tokens

_SAFE_TRANSFORMS = standard_transformations + (_reject_dangerous,)

# standard_transformations 的 auto_number/factorial_notation/auto_symbol/
# repeated_decimals 会在 token 流注入 Integer/Float/factorial/Symbol/Rational
# 等名字；默认 parse_expr 用 `from sympy import *` 提供它们。这里只放这几个
# 纯数学名（无任何 I/O 面），builtins 仍置空。
def _safe_global():
    import sympy as _sp
    return {
        '__builtins__': {},
        'Integer': _sp.Integer, 'Float': _sp.Float,
        'Symbol': _sp.Symbol, 'factorial': _sp.factorial,
        'Rational': _sp.Rational,
    }

def safe_parse(text, local=None):
    if not text or not text.strip():
        raise ValueError("空表达式")
    return parse_expr(text, local_dict=local or {},
                      global_dict=_safe_global(),
                      transformations=_SAFE_TRANSFORMS)
'''


# ============================================================
# compute_symbolic：子进程受限解析（safe_parse + 空 builtins + token 黑名单）
# ============================================================
def do_symbolic(expression, vars_dict=None, timeout=15):
    """符号计算：子进程受限名字空间解析（带超时，防复杂表达式卡死）。"""
    if not expression or not expression.strip():
        return {"success": False, "error": "缺少表达式"}
    script = SAFE_PARSE_SNIPPET + f'''# -*- coding: utf-8 -*-
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import sympy as sp

{SYMBOL_TABLE_SOURCE}
local = {SYMBOL_TABLE_DICT}
vars_dict = {json.dumps(vars_dict or {})}
try:
    for k, v in vars_dict.items():
        # vars 同样走安全解析（sympify(字符串) 底层也是 eval，必须同款防护）
        local[k] = safe_parse(str(v))
    expr = safe_parse({expression!r}, local)
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
    return _run_child(script, timeout)


# ============================================================
# compute_numeric：受限数值沙箱子进程（严格导入白名单 + 隔离命名空间）
# ============================================================
# 流程：闸门开启时预载科学栈（其内部 stdlib 导入在此完成）→ 安装严格白名单
#（仅 _ALLOWED 五模块）→ 置空危险内建 → 用户代码在隔离命名空间执行。
# 相比旧版：删除 _STDLIB/sys.modules/level>0/`_` 前缀直通分支（旧版可 import os；
# 且 sys.modules 已预置 os/subprocess，删除分支后仍可通过 _orig_import/_sys 泄漏绕过）。
SANDBOX_PRELUDE = '''
import builtins
import sys as _sys

try:
    _sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    _sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# 1) 闸门开启时预载科学栈（其内部 stdlib/ctypes 等导入在此完成；scipy.quad
#    会惰性 import ctypes，先预热一次，运行时不再触发）
import math
import numpy as np
from scipy import integrate, optimize, signal
integrate.quad(lambda _x: 0.0, 0.0, 1.0)
try:
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
except Exception:
    pass

# 2) 保存执行原语（sanitize 后 builtins.exec/compile 被置空，直接查名会拿 None）
_exec = exec
_compile = compile

# 3) 严格导入白名单：仅允许白名单五模块（拒绝相对导入）
_orig_import = builtins.__import__
_ALLOWED = {'numpy', 'scipy', 'sympy', 'math', 'uncertainties'}

def _safe_import(name, *args, **kwargs):
    if len(args) > 3:
        level = args[3]
    else:
        level = kwargs.get('level', 0)
    if level > 0:
        raise ImportError("相对导入被禁止")
    base = name.split('.')[0]
    if base not in _ALLOWED:
        raise ImportError(f"禁止导入模块: {name}")
    return _orig_import(name, *args, **kwargs)

builtins.__import__ = _safe_import

# 4) 置空危险内建（直接调用即 TypeError；import 由白名单把关）
for _bad in ('eval', 'exec', 'open', 'compile', 'input', 'breakpoint'):
    setattr(builtins, _bad, None)

# 5) 用户命名空间：只暴露公共名（math/np/integrate/optimize/signal），
#    不泄漏 _sys/_orig_import/_safe_import/builtins/_ALLOWED 等内部名；
#    __builtins__ 用已 sanitize 的 builtins 字典（__import__ 已是白名单闸门）
_ns = {k: globals()[k] for k in ('math', 'np', 'integrate', 'optimize', 'signal') if k in globals()}
_ns['__builtins__'] = builtins.__dict__
'''


def do_numeric(code, timeout=10, max_output=10240):
    """数值计算：子进程执行受限代码（严格白名单 + 隔离命名空间）。

    返回语义与 v1 一致：{success, stdout, stderr, returncode}——stdout/stderr 是
    代码的真实输出（各截断 max_output=10KB，超限带 stdout_truncated/stderr_truncated
    标记），不是 JSON 包装；失败/超时返回 {success: False, error, ...}。
    """
    if not code or not code.strip():
        return {"success": False, "error": "缺少代码"}
    full_code = SANDBOX_PRELUDE + "\n" + f"_exec(_compile({code!r}, '<user>', 'exec'), _ns)\n"
    r = _run_captured([sys.executable, '-u', '-c', full_code], timeout, max_output, max_output)
    if r['timed_out']:
        return {"success": False, "error": f"代码执行超时（{timeout}秒）",
                "stdout": r['stdout'], "stderr": r['stderr']}
    if r['returncode'] != 0:
        return {"success": False, "error": r['stderr'] or "执行失败", "stdout": r['stdout']}
    return {"success": True, "stdout": r['stdout'], "stderr": r['stderr'],
            "returncode": r['returncode'],
            "stdout_truncated": r['stdout_truncated'], "stderr_truncated": r['stderr_truncated']}


# ============================================================
# compute_plot：整体移入子进程（parse/lambdify/matplotlib 均在沙箱内）
# ============================================================
def do_plot(expression, x_min=-5, x_max=5, y_label='', caption='', timeout=30):
    """绘图：子进程内 safe_parse + matplotlib 生成 PNG，base64 输出。"""
    if not expression or not expression.strip():
        return {"success": False, "error": "缺少表达式"}
    script = SAFE_PARSE_SNIPPET + f'''# -*- coding: utf-8 -*-
import json, sys, io, base64
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np
except ImportError:
    print(json.dumps({{"success": False, "error": "matplotlib 未安装（pip install matplotlib）"}}))
    sys.exit(0)
import sympy as sp

{SYMBOL_TABLE_SOURCE}
local = {SYMBOL_TABLE_DICT}
try:
    expr = safe_parse({expression!r}, local)
    x = local['x']
    f = sp.lambdify(x, expr, 'numpy')
    x_min = {x_min!r}; x_max = {x_max!r}
    xs = np.linspace(float(x_min), float(x_max), 400)
    ys = f(xs)
except Exception as e:
    print(json.dumps({{"success": False, "error": "表达式解析/求值失败: " + str(e)}}))
    sys.exit(0)

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei',
                                   'Arial Unicode MS', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False
y_label = {y_label!r}
caption = {caption!r}

fig, ax = plt.subplots(figsize=(8, 5))
ax.plot(xs, ys, color='#4f46e5', linewidth=2)
ax.set_xlabel('x')
ax.set_ylabel(y_label or 'y')
ax.set_title(caption or f"y = {{sp.latex(expr)}}", fontsize=12)
ax.grid(True, alpha=0.3)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)

buf = io.BytesIO()
fig.savefig(buf, format='png', dpi=100, bbox_inches='tight')
plt.close(fig)
img_b64 = base64.b64encode(buf.getvalue()).decode('ascii')
print(json.dumps({{"success": True, "image_base64": img_b64,
                   "caption": caption or f"y = {{sp.latex(expr)}}"}}))
'''
    return _run_child(script, timeout)


# ============================================================
# compare_answers：整体移入子进程（safe_parse + 符号化简 + 数值回退）
# ============================================================
def do_compare(a, b, samples=5, tol=1e-6, timeout=15):
    """答案比对：子进程内符号化简优先，失败回退多组随机数值代入。

    samples 钳制到 [1, 20]（防恶意大值白白烧满子进程超时）；tol 钳制为有限正数。
    """
    if not a or not a.strip() or not b or not b.strip():
        return {"success": False, "error": "缺少表达式"}
    try:
        samples = max(1, min(int(samples), 20))
    except Exception:  # noqa: BLE001
        samples = 5
    try:
        tol = float(tol)
        if not (tol > 0 and tol != float('inf')):
            tol = 1e-6
    except Exception:  # noqa: BLE001
        tol = 1e-6
    script = SAFE_PARSE_SNIPPET + f'''# -*- coding: utf-8 -*-
import json, sys, io, random
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import sympy as sp

{SYMBOL_TABLE_SOURCE}
local = {SYMBOL_TABLE_DICT}
a = {a!r}; b = {b!r}
samples = {int(samples)!r}; tol = {float(tol)!r}
try:
    expr_a = safe_parse(a, local)
    expr_b = safe_parse(b, local)
except Exception as e:
    print(json.dumps({{"success": False, "error": "表达式解析失败: " + str(e)}}))
    sys.exit(0)

try:
    if sp.simplify(expr_a - expr_b) == 0:
        print(json.dumps({{"success": True, "equivalent": True, "method": "symbolic"}}))
        sys.exit(0)
except Exception:
    pass

try:
    free = sorted(expr_a.free_symbols | expr_b.free_symbols, key=str)
    if not free:
        print(json.dumps({{"success": True, "equivalent": False, "method": "numeric"}}))
        sys.exit(0)
    for _ in range(samples):
        subs = {{s: random.uniform(0.5, 5.0) for s in free}}
        va = float(expr_a.evalf(subs=subs))
        vb = float(expr_b.evalf(subs=subs))
        if abs(va - vb) > tol:
            print(json.dumps({{"success": True, "equivalent": False, "method": "numeric"}}))
            sys.exit(0)
    print(json.dumps({{"success": True, "equivalent": True, "method": "numeric"}}))
except Exception as e:
    print(json.dumps({{"success": False, "error": str(e)}}))
'''
    return _run_child(script, timeout)


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
    "数值计算：在受限 numpy/scipy 沙箱子进程中执行 Python 代码。"
    "返回 {stdout, stderr, returncode}——stdout 为代码真实输出（stdout/stderr 各截断"
    " 10KB，超限带 stdout_truncated 标记）；失败/超时返回 error 字段。"
    "预置 import math / numpy as np / scipy 的 integrate、optimize、signal。"
    "用于需要数值解的场合（求根、积分、拟合）。禁止 import 白名单外模块（含 os/subprocess），"
    "危险内建（eval/exec/open/compile）已禁用，文件 I/O 不可用。",
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
