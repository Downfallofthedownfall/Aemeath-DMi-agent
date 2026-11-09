// ============================================================
// scripts.ts — compute_verify / check_dimensions 的 Python 脚本（python -c 传参）
//
// ⚠️⚠️ 安全边界（审查实测过）：sympify / parse_expr 底层都是 eval。
//   早先直接 `sympify(模型给的字符串)`，传 `__import__('os').system(...)` 就能执行任意
//   代码，而且这两个工具不需要审批 —— 被网页/PDF 注入的模型可以绕过沙箱和键鼠审批。
//   这里统一走 safe_parse：
//     · token 黑名单在 standard_transformations **之前**运行（之后名字已被 auto_symbol
//       改写成字符串，黑名单就查不到了）；
//     · 拒绝所有点号属性访问与 __ 名称（挡 ().__class__.__base__ 这类逃逸）；
//     · 拒绝字符串字面量（Python 3.11 及以下 f-string 是一个 STRING token，
//       里面的表达式照样会执行）；
//     · global_dict 只放数学名，__builtins__ 置空；
//     · 白名单外的函数名直接报错。⚠️ 不报错的话 auto_symbol 会把它改写成
//       Function('foo') 这种"未定义函数"，回代永远算不出数，正确答案被标成验证失败；
//     · 白名单里的函数名不带括号时按变量处理（gamma*m*c**2 里的 gamma 是洛伦兹因子，不是 Γ 函数）；
//     · ^ 当乘方（sympify 的默认行为，模型常这么写）。
//   改这里要同步 packages/py-services/sympy_mcp/server.py 的 SAFE_PARSE_SNIPPET。
// ============================================================

const SAFE_PARSE = `
import sympy as _sp
from keyword import iskeyword as _iskeyword
from tokenize import NAME as _NAME, OP as _OP, STRING as _STRING
from sympy.parsing.sympy_parser import parse_expr, standard_transformations, convert_xor

def _reject_dangerous(tokens, local_dict, global_dict):
    out = []
    for i, tok in enumerate(tokens):
        num, val = tok[0], tok[1]
        if num == _NAME and val.startswith('__'):
            raise ValueError('forbidden name: ' + val)
        if num == _OP and val == '.':
            raise ValueError('attribute access is not allowed')
        if num == _STRING:
            raise ValueError('string literals are not allowed')
        if num == _NAME and val not in local_dict and not _iskeyword(val):
            nxt = tokens[i + 1][1] if i + 1 < len(tokens) else ''
            if nxt == '(' and val not in global_dict:
                raise ValueError('unknown function: ' + val + ' (write multiplication as ' + val + '*(...))')
            if nxt not in ('(', '=') and callable(global_dict.get(val)):
                # 没带括号的函数名（gamma / beta / N ...）是物理里常见的变量名，按符号处理
                out.extend([(_NAME, 'Symbol'), (_OP, '('), (_STRING, repr(val)), (_OP, ')')])
                continue
        out.append(tok)
    return out

_TRANSFORMS = (_reject_dangerous,) + standard_transformations + (convert_xor,)
# 只放纯数学名（没有任何 I/O 面）。不直接用 from sympy import *：里面有 preview / test / plot 这类会起进程、开窗口的东西。
_MATH_NAMES = ['Integer', 'Float', 'Symbol', 'Function', 'Rational', 'factorial', 'factorial2', 'binomial',
    'Eq', 'Ne', 'Lt', 'Le', 'Gt', 'Ge', 'pi', 'E', 'I', 'oo', 'zoo', 'nan', 'EulerGamma', 'GoldenRatio',
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinc', 'asin', 'acos', 'atan', 'acot', 'asec', 'acsc', 'atan2',
    'sinh', 'cosh', 'tanh', 'coth', 'sech', 'csch', 'asinh', 'acosh', 'atanh', 'acoth',
    'exp', 'log', 'ln', 'sqrt', 'root', 'cbrt', 'Abs', 'sign', 'floor', 'ceiling', 'Max', 'Min', 'Mod',
    're', 'im', 'arg', 'conjugate', 'gamma', 'loggamma', 'beta', 'erf', 'erfc', 'zeta', 'LambertW',
    'besselj', 'bessely', 'besseli', 'besselk', 'legendre', 'hermite', 'laguerre', 'chebyshevt',
    'Heaviside', 'DiracDelta', 'KroneckerDelta', 'Piecewise',
    'diff', 'integrate', 'limit', 'summation', 'product', 'series',
    'Derivative', 'Integral', 'Sum', 'Product', 'Limit',
    'simplify', 'expand', 'factor', 'cancel', 'together', 'apart', 'collect',
    'trigsimp', 'powsimp', 'radsimp', 'nsimplify', 'expand_trig', 'expand_log', 'N']

def _safe_global():
    out = {'__builtins__': {}}
    for name in _MATH_NAMES:
        obj = getattr(_sp, name, None)  # 老版本 sympy 缺某个名字时跳过，不拖垮整个脚本
        if obj is not None:
            out[name] = obj
    return out

def safe_parse(text, local=None):
    if not text or not text.strip():
        raise ValueError('empty expression')
    if len(text) > 500:
        raise ValueError('input too long')
    return parse_expr(text, local_dict=local or {}, global_dict=_safe_global(), transformations=_TRANSFORMS)
`;

/** SymPy 验证脚本（python -c 传参：expression claimed [variable]）。 */
export const SYMPY_SCRIPT = `
import sys, json, re
try:
${indent(SAFE_PARSE)}
    expr_s = sys.argv[1]; claimed_s = sys.argv[2]; var_s = sys.argv[3] if len(sys.argv) > 3 else 'x'
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,20}', var_s) or var_s.startswith('__'):
        print(json.dumps({'verified': False, 'error': 'invalid variable name'})); sys.exit(0)
    x = _sp.Symbol(var_s)
    expr = safe_parse(expr_s)
    try:
        sols = _sp.solve(expr, x)
    except Exception:
        # solve 对 Max / gamma / erf 这类方程没有解法（NotImplementedError）：
        # 解不出来不等于答案错，照样拿声称的解回代检验
        sols = []
    checked = []
    for c in [t for t in claimed_s.replace(' ', '').split(',') if t]:
        try:
            val = _sp.N(expr.subs(x, safe_parse(c)), 15)
            ok = abs(val) < 1e-6
            checked.append({'claimed': c, 'ok': bool(ok), 'residual': float(abs(val))})
        except Exception:
            checked.append({'claimed': c, 'ok': False, 'residual': None})
    # 第三关：solve 返回空（无解析解/恒等式）时，只要声称的解全部回代成立也算通过——
    # 原实现 bool(sols) 为空时一律 verified:false，即使答案正确
    verified = all(c['ok'] for c in checked) if checked else bool(sols)
    print(json.dumps({'verified': verified, 'solutions': [str(s) for s in sols], 'checked': checked}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

/** 量纲检查脚本（python -c 传参：expression [expected]）。单位表：M L T I Θ N。 */
export const DIMENSION_SCRIPT = `
import sys, json
from sympy import Symbol
${SAFE_PARSE}

UNITS = {
 'kg': (1,0,0,0,0,0), 'g': (1,0,0,0,0,0),
 'm': (0,1,0,0,0,0), 'cm': (0,1,0,0,0,0), 'km': (0,1,0,0,0,0), 'mm': (0,1,0,0,0,0),
 's': (0,0,1,0,0,0), 'min': (0,0,1,0,0,0), 'h': (0,0,1,0,0,0),
 'A': (0,0,0,1,0,0), 'K': (0,0,0,0,1,0), 'mol': (0,0,0,0,0,1),
 'N': (1,1,-2,0,0,0), 'J': (1,2,-2,0,0,0), 'W': (1,2,-3,0,0,0),
 'Pa': (1,-1,-2,0,0,0), 'Hz': (0,0,-1,0,0,0), 'C': (0,0,1,1,0,0),
 'V': (1,2,-3,-1,0,0), 'O': (1,2,-3,-2,0,0), 'Ω': (1,2,-3,-2,0,0), 'F': (-1,-2,4,2,0,0),
 'H': (1,2,-2,-2,0,0), 'T': (1,0,-2,-1,0,0), 'Wb': (1,2,-2,-1,0,0),
}
BASE = ['kg', 'm', 's', 'A', 'K', 'mol']
# 单位名强制为 Symbol（避免 N=数值函数/C/I/E 等 sympy 内建冲突）
LOCAL = {name: Symbol(name) for name in UNITS}

def vec_add(a, b):
    return tuple(x + y for x, y in zip(a, b))

def vec_scale(a, k):
    return tuple(x * k for x in a)

def dim_of(expr_str):
    """返回表达式各加项的量纲向量集合；含未知符号 → None。"""
    expr = safe_parse(expr_str, LOCAL)
    terms = list(expr.as_ordered_terms()) if expr.is_Add else [expr]
    out = set()
    for t in terms:
        v = (0,0,0,0,0,0)
        factors = list(t.as_ordered_factors()) if t.is_Mul else [t]
        ok = True
        for f in factors:
            if f.is_Number:
                continue
            if f.is_Symbol:
                name = str(f)
                if name in UNITS:
                    v = vec_add(v, UNITS[name])
                else:
                    ok = False; break
            elif f.is_Pow:
                b, e = f.args
                if b.is_Symbol and str(b) in UNITS:
                    try:
                        k = float(e)
                    except Exception:
                        ok = False; break
                    v = vec_add(v, vec_scale(UNITS[str(b)], k))
                else:
                    ok = False; break
            else:
                ok = False; break
        if not ok:
            return None
        out.add(v)
    return out

def render(vec):
    parts = []
    for i, e in enumerate(vec):
        if e == 0: continue
        s = BASE[i]
        parts.append(s if e == 1 else (s + '^' + (str(int(e)) if float(e).is_integer() else str(e))))
    return '*'.join(parts) if parts else '（无量纲）'

try:
    expr_s = sys.argv[1]
    expected_s = sys.argv[2] if len(sys.argv) > 2 else ''
    if len(expr_s) > 500 or len(expected_s) > 500:
        print(json.dumps({'ok': False, 'error': 'input too long'})); sys.exit(0)
    dims = dim_of(expr_s)
    if dims is None:
        print(json.dumps({'ok': False, 'error': '表达式中含无法判定的量（非单位符号），请只使用单位/数值组合' }))
        sys.exit(0)
    consistent = len(dims) == 1
    expr_dim = list(dims)[0] if dims else (0,0,0,0,0,0)
    out = {'ok': consistent, 'consistent': consistent, 'expression_dim': render(expr_dim), 'expression_vector': list(expr_dim)}
    if expected_s:
        ed = dim_of(expected_s)
        if ed is None or len(ed) != 1:
            out['ok'] = False
            out['expected_error'] = '期望量纲表达式无法判定'
        else:
            ev = list(ed)[0]
            out['expected_dim'] = render(ev)
            # ⚠️ 两边都是 tuple 才能比：早先写成 ev == list(expr_dim)，tuple 与 list 恒不等，
            #   传了 expected 就必报 mismatch（连 m*s^-1 对 m*s^-1 都算错）
            matches = ev == expr_dim
            out['ok'] = out['ok'] and matches
            if not matches:
                out['mismatch'] = {'expression': render(expr_dim), 'expected': render(ev)}
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
`;

/** 把一段 Python 缩进进 try 块。 */
function indent(code: string): string {
  return code
    .split('\n')
    .map((line) => (line ? `    ${line}` : line))
    .join('\n');
}
