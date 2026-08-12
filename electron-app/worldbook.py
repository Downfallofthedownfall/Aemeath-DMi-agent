# ============================================================
# worldbook.py - Worldbook 知识库（M2）
# 功能：
#   - 双馆隔离：worldbook/aemeath/ 与 worldbook/physicist/ 各自独立加载
#   - 热重载：后台线程轮询 mtime，改动自动重载并打印日志
#   - match_worldbook(query, mode)：触发词匹配 + 常驻（自传头）注入
#   - 注入顺序：constant(自传头) → 命中(priority/intrinsic_value 降序)
#     → chain 补入（去重）
#   - 注入 token 上限：worldbook.max_inject_tokens（默认 3000）
# 依赖：ai_service.py 启动时调用 init(config, script_dir)
# ============================================================

import os
import re
import json
import time
import threading

# ===== 全局状态 =====
_SCRIPT_DIR = None
_CFG = {}
_WB_DIR = None                             # worldbook 根目录
_ENTRIES = {'aemeath': [], 'physicist': []}    # {馆名: [条目, ...]}
_FILE_MTIMES = {}                          # {json路径: mtime}，热重载比对用
_LOCK = threading.Lock()
_INITED = False

def _log(msg):
    print(f"[Worldbook] {msg}", flush=True)

def _mem(key, default=None):
    """读取 config.json 的 worldbook 段（缺省返回 default）"""
    return (_CFG.get('worldbook', {}) or {}).get(key, default)

def init(cfg, script_dir):
    """初始化：加载全部 .json，按配置启动热重载线程"""
    global _SCRIPT_DIR, _CFG, _WB_DIR, _INITED
    _SCRIPT_DIR = script_dir
    _CFG = cfg or {}
    _WB_DIR = os.path.join(script_dir, 'worldbook')
    if not os.path.isdir(_WB_DIR):
        _log(f"警告：worldbook 目录不存在（{_WB_DIR}），知识库停用")
        _INITED = True
        return True
    try:
        _load_all()
        _INITED = True
        counts = {lib: len(es) for lib, es in _ENTRIES.items()}
        _log(f"加载完成 aemeath={counts['aemeath']}条 physicist={counts['physicist']}条")
        if _mem('hot_reload', True):
            interval = max(0.5, _mem('hot_reload_interval', 3.0))
            threading.Thread(target=_hot_reload_loop, daemon=True).start()
            _log(f"热重载已启用（每 {interval} 秒轮询 mtime）")
    except Exception as e:
        _INITED = False
        _log(f"初始化失败（Worldbook 停用）: {e}")
    return _INITED

def _mode_to_library(mode):
    """运行时模式 → 知识库馆名（统一为 aemeath/physicist）。
    scholar 为早期文档里的旧名，此处保留兼容映射到 physicist。"""
    if mode == 'scholar':
        return 'physicist'
    return mode

def _load_all():
    """重新扫描 worldbook/<馆>/*.json 并载入全部条目（兼容数组/单对象）"""
    global _ENTRIES, _FILE_MTIMES
    new_entries = {'aemeath': [], 'physicist': []}
    new_mtimes = {}
    for lib in new_entries.keys():
        lib_dir = os.path.join(_WB_DIR, lib)
        if not os.path.isdir(lib_dir):
            continue
        for fname in sorted(os.listdir(lib_dir)):
            if not fname.endswith('.json'):
                continue
            path = os.path.join(lib_dir, fname)
            try:
                new_mtimes[path] = os.path.getmtime(path)
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                # 兼容两种写法：数组=多条；单对象=一条
                items = data if isinstance(data, list) else [data]
                for it in items:
                    if isinstance(it, dict) and it.get('id'):
                        new_entries[lib].append(it)
                    else:
                        _log(f"跳过无效条目: {path} -> {str(it)[:60]}")
            except Exception as e:
                _log(f"加载失败 {path}: {e}")
    with _LOCK:
        _ENTRIES = new_entries
        _FILE_MTIMES = new_mtimes

def _hot_reload_loop():
    """后台线程：轮询 json 文件 mtime，有变化则重载"""
    interval = max(0.5, _mem('hot_reload_interval', 3.0))
    while True:
        time.sleep(interval)
        try:
            if _check_changed():
                _load_all()
                _log("reloaded（检测到文件变更）")
        except Exception as e:
            _log(f"热重载检查异常: {e}")

def _check_changed():
    """扫描当前 json 清单，与上次记录比对（新增/删除/修改）"""
    current = {}
    for lib in ('aemeath', 'physicist'):
        lib_dir = os.path.join(_WB_DIR, lib)
        if os.path.isdir(lib_dir):
            for fname in os.listdir(lib_dir):
                if fname.endswith('.json'):
                    path = os.path.join(lib_dir, fname)
                    try:
                        current[path] = os.path.getmtime(path)
                    except Exception:
                        pass
    with _LOCK:
        old = dict(_FILE_MTIMES)
    if set(current.keys()) != set(old.keys()):
        return True
    for path, mt in current.items():
        if abs(old.get(path, 0) - mt) > 1e-6:
            return True
    return False

# ============================================================
# 匹配与注入
# ============================================================
def _normalize(text):
    """归一化：小写 + 去空白/标点（保留字母、数字与中文）"""
    if not text:
        return ''
    return re.sub(r'[\s\W_]+', '', text.lower(), flags=re.UNICODE)

def _format_entry(e):
    """条目 → 注入文本。identity=第一人称正文；knowledge=正文+来源+考点"""
    kind = e.get('kind', 'knowledge')
    title = e.get('title') or e.get('id')
    content = (e.get('content') or '').strip()
    if kind == 'identity':
        return f"【{title}】\n{content}"
    lines = [f"【{title}】", content]
    src = (e.get('source') or '').strip()
    ep = (e.get('exam_points') or '').strip()
    if src:
        lines.append(f"来源：{src}")
    if ep:
        lines.append(f"考点：{ep}")
    return "\n".join(lines)

def match_worldbook(query, mode):
    """返回应注入的 Worldbook 文本块（无命中返回 ''）。
    顺序：constant(自传头) → 命中(priority/intrinsic_value 降序) → chain 递归补入（去重+防环）"""
    if not _INITED or not query:
        return ''
    lib = _mode_to_library(mode)
    with _LOCK:
        entries = list(_ENTRIES.get(lib, []))
    if not entries:
        return ''

    norm_q = _normalize(query)
    # id → 条目 映射（chain 查引用用 O(1)）
    by_id = {e['id']: e for e in entries}

    # 常驻条目（自传头）：无条件注入，按优先级排序保证确定性
    constants = [e for e in entries if e.get('constant')]
    constants.sort(key=lambda e: (e.get('priority', 0), e.get('intrinsic_value', 0)), reverse=True)

    # 触发条目：任一 trigger 子串命中（归一化后）
    hits = []
    for e in entries:
        if e.get('constant'):
            continue
        for t in (e.get('triggers') or []):
            nt = _normalize(t)
            if nt and nt in norm_q:
                hits.append(e)
                break
    hits.sort(key=lambda e: (e.get('priority', 0), e.get('intrinsic_value', 0)), reverse=True)

    # ===== chain 递归补入（修复循环引用 / 嵌套 chain） =====
    # 风险：chain 可能自引用（A→A）或互相引用（A→B→A），
    #       简单递归会死循环；同时嵌套 chain（chain 的 chain）也应展开。
    # 对策：seen 集合去重（已注入即跳过）+ 最大展开深度兜底；
    #       注入 token 上限（max_inject_tokens）是最终保险。
    MAX_CHAIN_DEPTH = 3
    ordered = []
    seen = set()

    def walk(e, depth):
        if e['id'] in seen or depth > MAX_CHAIN_DEPTH:
            return
        seen.add(e['id'])
        ordered.append(e)
        for cid in (e.get('chain') or []):
            ce = by_id.get(cid)
            if ce:
                walk(ce, depth + 1)

    for e in constants:
        walk(e, 0)
    for e in hits:
        walk(e, 0)

    # 注入 token 上限（中文≈1 字/token 保守估算，至少注入首条）
    max_tokens = _mem('max_inject_tokens', 3000)
    parts = []
    used = 0
    for e in ordered:
        text = _format_entry(e)
        approx = len(text)
        if parts and used + approx > max_tokens:
            _log(f"注入超限截断（已用 {used}/{max_tokens} tokens）")
            break
        parts.append(text)
        used += approx

    if not parts:
        return ''
    _log(f"命中 {len(hits)} 条 + 常驻 {len(constants)} 条 | 注入顺序: {[e['id'] for e in ordered]} | tokens≈{used}")
    return "## Worldbook 知识库\n" + "\n\n".join(parts)
