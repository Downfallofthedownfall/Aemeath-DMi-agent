# ============================================================
# memory_store.py - 分层记忆系统（M1：L1 工作缓存 + L2 滚动摘要）
# 功能：
#   - SQLite 存储（./data/memory.db，WAL 模式，线程安全）
#   - L1：逐轮记录会话原文（l1_turns），超出上下文预算后由
#     DeepSeek 压缩为 session_summary 写入 L2，仅保留最近 N 轮
#   - L2：按模式隔离的情景记忆，status='active' 且 importance>=50
#     的最近 top_k 条，在组装上下文时以 "## Memory" 注入
#   - 任务暂存区（仅 physicist 模式）：解题过程 JSON 暂存，
#     不参与压缩、不被删除，组装上下文时始终注入
# 依赖：ai_service.py 启动时调用 init(config, script_dir)
# ============================================================

import os
import re
import json
import time
import sqlite3
import hashlib
import threading
import datetime
import urllib.request

# ===== 全局状态 =====
DB_PATH = None            # 数据库文件路径
CFG = {}                  # 全局配置（ai_service 启动时传入）
_INITED = False           # 数据库是否初始化成功

def _log(msg):
    """统一日志前缀"""
    print(f"[Memory] {msg}", flush=True)

# ===== 模式判定 =====
# 任务暂存区仅对"星炬物理学霸"（physicist）模式开放，aemeath 模式不触发
SCHOLAR_MODES = {'physicist'}

# ===== 解题触发词（规则层，命中则更新 scratch） =====
SCRATCH_TRIGGER_WORDS = ['推导', '证明', '这题', '这道题', '求解', '计算', '积分', '微分']

# ===== 卡点启发式关键词（规则层判断 current_blocker） =====
BLOCKER_KEYWORDS = ['无法', '不能', '不确定', '缺少', '卡住', '报错', '错误',
                    'Error', '失败', '不会', '信息不足', '需要更多']

# ===== 压缩提示词（要求严格 JSON 输出） =====
COMPRESSION_PROMPT = """你是对话记忆压缩器。请把下面整段对话压缩成结构化 JSON，必须严格只输出一个 JSON 对象，不要输出任何其他文字或 markdown：
{"summary": "整段对话摘要（保留关键细节与结论）", "key_facts": ["关键事实1", "关键事实2"], "user_prefs": ["用户偏好1"], "tasks": ["任务/待办1"], "emotions": ["情绪状态1"]}
规则：
- summary 必须覆盖对话核心内容
- 数组字段没有内容时返回空数组
- 不编造对话中没有的信息"""

# ===== 每会话压缩互斥锁（防止重复压缩） =====
_compress_lock_guard = threading.Lock()
_compress_locks = {}

def _session_lock(session_id):
    """获取该会话的压缩锁（不存在则创建）"""
    with _compress_lock_guard:
        if session_id not in _compress_locks:
            _compress_locks[session_id] = threading.Lock()
        return _compress_locks[session_id]

# ============================================================
# 初始化与配置
# ============================================================
def init(cfg, script_dir):
    """初始化数据库与配置。cfg 为 ai_service 的全局 config 字典"""
    global DB_PATH, CFG, _INITED
    CFG = cfg or {}
    data_dir = os.path.join(script_dir, 'data')
    try:
        os.makedirs(data_dir, exist_ok=True)
        DB_PATH = os.path.join(data_dir, 'memory.db')
        _create_tables()
        _INITED = True
        _log(f"SQLite 初始化完成: {DB_PATH}")
    except Exception as e:
        _INITED = False
        _log(f"数据库初始化失败，记忆功能停用: {e}")
    return _INITED

def is_enabled():
    """记忆功能是否可用（DB 就绪 且 memory.enabled）"""
    if not _INITED or not DB_PATH:
        return False
    return _mem('enabled', True)

def _mem(key, default=None):
    """读取 config.json 的 memory 段（缺省返回 default）"""
    return (CFG.get('memory', {}) or {}).get(key, default)

def _modes():
    return CFG.get('modes', {}) or {}

def _deepseek_key():
    return CFG.get('deepseek_api_key', '')

def _deepseek_base():
    return CFG.get('deepseek_api_base', 'https://api.deepseek.com')

def _compression_model():
    return _mem('model', 'deepseek-v4-flash')

# ============================================================
# 数据库连接与建表
# ============================================================
def _connect():
    """每次操作新建连接（SQLite 文件锁 + WAL 保证线程安全）"""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=10000")
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass
    return conn

def _create_tables():
    """建表（M1 阶段 4 张表 + 索引）"""
    conn = _connect()
    try:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions(
            session_id TEXT PRIMARY KEY,
            mode TEXT,
            title TEXT,
            created_at TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS l1_turns(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            mode TEXT,
            role TEXT,
            content TEXT,
            ts REAL,
            type TEXT DEFAULT 'chat'
        );
        CREATE TABLE IF NOT EXISTS l2_memories(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            mode TEXT,
            content TEXT,
            importance INTEGER DEFAULT 50,
            category TEXT,
            source TEXT,
            status TEXT DEFAULT 'active',
            created_at TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS audit_log(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL,
            action TEXT,
            memory_id INTEGER,
            detail TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_l1_session ON l1_turns(session_id, mode, type);
        CREATE INDEX IF NOT EXISTS idx_l2_mode ON l2_memories(mode, status, importance);
        """)
        conn.commit()
    finally:
        conn.close()

# ============================================================
# sessions 表
# ============================================================
def ensure_session(session_id, mode, title=''):
    """会话不存在则创建，存在则刷新 updated_at"""
    now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    conn = _connect()
    try:
        row = conn.execute("SELECT session_id FROM sessions WHERE session_id=?",
                           (session_id,)).fetchone()
        if row:
            conn.execute("UPDATE sessions SET updated_at=?, mode=? WHERE session_id=?",
                         (now, mode, session_id))
        else:
            conn.execute(
                "INSERT INTO sessions(session_id, mode, title, created_at, updated_at) VALUES(?,?,?,?,?)",
                (session_id, mode, (title or '')[:20], now, now))
        conn.commit()
    finally:
        conn.close()

# ============================================================
# L1：l1_turns
# ============================================================
def append_turn(session_id, mode, role, content, type='chat'):
    """追加一轮原文（chat / scratch）"""
    if not content:
        return
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO l1_turns(session_id, mode, role, content, ts, type) VALUES(?,?,?,?,?,?)",
            (session_id, mode, role, content, time.time(), type))
        conn.commit()
    finally:
        conn.close()

def get_l1_chat_turns(session_id, mode):
    """按时间顺序取本会话所有 chat 轮次（不含 scratch）"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, role, content, ts FROM l1_turns "
            "WHERE session_id=? AND mode=? AND type='chat' ORDER BY id ASC",
            (session_id, mode)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()

def estimate_l1_tokens(session_id, mode):
    """按字符数估算 L1 原文 token 数（中文≈1 字/token；len//4 会低估约 4 倍，
    导致压缩触发过晚）。只统计 chat 轮次（scratch 不参与压缩）。
    注意：M2 注入 Worldbook 后，预算口径应改为"组装后总消息"而非仅 L1 原文。"""
    total = 0
    for r in get_l1_chat_turns(session_id, mode):
        total += max(1, len(r["content"]))
    return total

def prune_l1(session_id, mode, keep_n):
    """压缩后清理：只保留最近 keep_n 轮 chat 原文（scratch 行不动）"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id FROM l1_turns WHERE session_id=? AND mode=? AND type='chat' "
            "ORDER BY id DESC LIMIT ?", (session_id, mode, keep_n)).fetchall()
        keep_ids = [r["id"] for r in rows]
        if keep_ids:
            ph = ",".join("?" * len(keep_ids))
            conn.execute(
                f"DELETE FROM l1_turns WHERE session_id=? AND mode=? AND type='chat' AND id NOT IN ({ph})",
                (session_id, mode, *keep_ids))
        else:
            conn.execute("DELETE FROM l1_turns WHERE session_id=? AND mode=? AND type='chat'",
                         (session_id, mode))
        conn.commit()
        _log(f"压缩后清理完成 session={session_id} 保留 {len(keep_ids)} 轮")
    finally:
        conn.close()

# ============================================================
# L2：l2_memories
# ============================================================
def insert_l2(session_id, mode, content, importance=50, category='', source=''):
    """写入一条 L2 记忆，返回新记录 id"""
    now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO l2_memories(session_id, mode, content, importance, category, source, status, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,'active',?,?)",
            (session_id, mode, content, importance, category, source, now, now))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()

def recall_l2(mode, top_k=5, min_importance=50):
    """按模式召回：status='active' 且 importance>=min_importance 的最近 top_k 条"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, content, importance, category, created_at FROM l2_memories "
            "WHERE mode=? AND status='active' AND importance>=? "
            "ORDER BY id DESC LIMIT ?",
            (mode, min_importance, top_k)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()

def _format_l2_content(content):
    """把 session_summary 的 JSON 渲染成易读文本（非 JSON 则原样返回）"""
    try:
        obj = json.loads(content)
        if isinstance(obj, dict) and obj.get('summary'):
            lines = [f"摘要：{obj['summary']}"]
            for key, label in (('key_facts', '关键事实'), ('user_prefs', '用户偏好'),
                               ('tasks', '任务'), ('emotions', '情绪')):
                vals = obj.get(key) or []
                if vals:
                    lines.append(f"{label}：" + "；".join(str(v) for v in vals))
            return "\n".join(lines)
    except Exception:
        pass
    return content

# ============================================================
# 审计日志
# ============================================================
def audit(action, memory_id=None, detail=''):
    conn = _connect()
    try:
        conn.execute("INSERT INTO audit_log(ts, action, memory_id, detail) VALUES(?,?,?,?)",
                     (time.time(), action, memory_id, (detail or '')[:500]))
        conn.commit()
    finally:
        conn.close()

# ============================================================
# 会话 ID 推导（前端不传 session_id，按 模式+首条用户消息 做稳定指纹）
# ============================================================
def derive_session_id(mode, history, query):
    """同一会话首条用户消息不变 → ID 稳定；新会话 → 新 ID。
    请求体显式传 session_id 时可覆盖本推导结果。"""
    first_user = query
    for m in history or []:
        if m.get('role') == 'user' and m.get('content'):
            first_user = m['content']
            break
    key = f"{mode}|{first_user}"
    return "auto_" + hashlib.sha1(key.encode('utf-8')).hexdigest()[:16]

# ============================================================
# 4. 任务暂存区（仅 physicist；始终注入，不参与压缩）
# ============================================================
def _heuristic_blocker(reply):
    """规则启发式：从回复中截取疑似卡点片段"""
    if not reply:
        return ''
    for kw in BLOCKER_KEYWORDS:
        idx = reply.find(kw)
        if idx != -1:
            return reply[max(0, idx - 30): idx + 40].replace('\n', ' ')
    return ''

def update_scratch(session_id, mode, query, reply):
    """规则层：query 命中解题触发词 → 更新 scratch（覆盖旧 scratch，只留最新一条）。
    attempted_steps 累积最近最多 10 步"""
    if mode not in SCHOLAR_MODES:
        return
    if not any(w in query for w in SCRATCH_TRIGGER_WORDS):
        return

    old = get_latest_scratch(session_id, mode)
    problem = query
    steps = []
    if old:
        try:
            old_obj = json.loads(old["content"])
        except Exception:
            old_obj = {}
        # 出现"换题"类词 → 视为新题；否则视为同一题的延续
        new_problem_markers = ['换一道', '新题', '另一道', '再来一题', '第二题', '下一题']
        if old_obj.get("problem") and not any(m in query for m in new_problem_markers):
            problem = old_obj["problem"]
        steps = old_obj.get("attempted_steps", []) or []
    steps.append({"q": query[:500], "a": (reply or '')[:800]})
    steps = steps[-10:]

    scratch_obj = {
        "problem": problem,
        "attempted_steps": steps,
        "current_blocker": _heuristic_blocker(reply),
    }
    # 同一事务内：删除旧 scratch → 插入新 scratch（只保留最新一条）
    conn = _connect()
    try:
        conn.execute("DELETE FROM l1_turns WHERE session_id=? AND mode=? AND type='scratch'",
                     (session_id, mode))
        conn.execute(
            "INSERT INTO l1_turns(session_id, mode, role, content, ts, type) VALUES(?,?,?,?,?,'scratch')",
            (session_id, mode, 'system', json.dumps(scratch_obj, ensure_ascii=False), time.time()))
        conn.commit()
        _log(f"scratch 已更新 session={session_id} mode={mode}")
    finally:
        conn.close()

def get_latest_scratch(session_id, mode):
    """取最新 scratch 行（无则 None）"""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id, content FROM l1_turns "
            "WHERE session_id=? AND mode=? AND type='scratch' ORDER BY id DESC LIMIT 1",
            (session_id, mode)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

# ============================================================
# DeepSeek 非流式调用
# 注意：ai_service.http_post() 带的是 X-Auth-Token（本地服务鉴权），
#       DeepSeek 需要 Authorization: Bearer，故沿用 llm_ooc_check
#       （ai_service.py 855 行）的 urllib 写法单独封装。
# ============================================================
def _deepseek_chat(messages, temperature=0.3, max_tokens=1024, timeout=60):
    url = f"{_deepseek_base()}/chat/completions"
    data = json.dumps({
        "model": _compression_model(),
        "messages": messages,
        "stream": False,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={
        'Authorization': f"Bearer {_deepseek_key()}",
        'Content-Type': 'application/json',
    }, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        result = json.loads(resp.read().decode('utf-8'))
    return result['choices'][0]['message']['content']

def _extract_json(text):
    """从 LLM 输出中稳健提取 JSON 对象（兼容代码块包裹）"""
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', (text or '').strip())
    for pat in (r'\{.*?\}', r'\{.*\}'):
        m = re.search(pat, text, re.DOTALL)
        if not m:
            continue
        try:
            return json.loads(m.group())
        except Exception:
            continue
    return None

# ============================================================
# 压缩（后台线程执行，不阻塞 SSE）
# ============================================================
def compress_session(session_id, mode):
    """压缩整段对话 → 写 L2 session_summary(importance=70) → 仅保留最近 N 轮原文"""
    lock = _session_lock(session_id)
    if not lock.acquire(blocking=False):
        _log(f"压缩已在进行中，跳过: {session_id}")
        return
    try:
        turns = get_l1_chat_turns(session_id, mode)
        if len(turns) < 2:
            return
        convo = "\n".join(f"<{r['role']}> {r['content']}</{r['role']}>" for r in turns)
        prompt = f"{COMPRESSION_PROMPT}\n\n对话内容：\n{convo}"
        content = _deepseek_chat([{"role": "user", "content": prompt}])
        parsed = _extract_json(content)
        if not isinstance(parsed, dict):
            raise ValueError("压缩输出不是有效 JSON")
        # 兜底补齐字段
        for key in ('summary', 'key_facts', 'user_prefs', 'tasks', 'emotions'):
            parsed.setdefault(key, [] if key != 'summary' else '')
        summary = json.dumps(parsed, ensure_ascii=False)
        new_id = insert_l2(session_id, mode, summary, importance=70,
                           category='session_summary', source='compression')
        prune_l1(session_id, mode, _mem('keep_recent_turns', 6))
        audit('compression', new_id, summary[:200])
        _log(f"压缩完成 session={session_id} 轮次={len(turns)} → L2#{new_id}")
    except Exception as e:
        _log(f"压缩失败（保留原文，下次重试）: {e}")
        try:
            audit('compression_failed', None, str(e)[:200])
        except Exception:
            pass
    finally:
        lock.release()

# ============================================================
# 上下文组装（供 handle_chat 调用）
# ============================================================
def build_context(base_messages, session_id, mode, history, shared_memory):
    """按顺序组装：
    system_prompt → 常驻规则 → L2 召回 → shared_memory → 任务暂存区 → history → query
    history 与 l1_turns 去重（history 优先），避免重复注入"""
    msgs = list(base_messages)

    # 1. 常驻规则（配置 modes.<mode>.standing_rules 或 memory.standing_rules，未配置则跳过）
    standing = _mem('standing_rules', '') or (_modes().get(mode, {}) or {}).get('standing_rules', '')
    if standing:
        msgs.append({"role": "system", "content": f"## 常驻规则\n{standing}"})

    # 2. L2 召回（按模式隔离）
    top_k = _mem('l2_recall_top_k', 5)
    l2_rows = recall_l2(mode, top_k)
    if l2_rows:
        block = "## Memory\n" + "\n".join(f"- {_format_l2_content(r['content'])}" for r in l2_rows)
        msgs.append({"role": "system", "content": block})

    # 3. shared_memory（原 "## User info" 块，保持不变）
    if shared_memory:
        msgs.append({"role": "system", "content": f"## User info\n{shared_memory}"})

    # 4. 任务暂存区（仅 physicist；始终注入，不参与压缩）
    scratch = get_latest_scratch(session_id, mode)
    if scratch:
        msgs.append({"role": "system", "content": f"## 任务暂存区\n{scratch['content']}"})

    # 5. history（与 l1_turns 去重：history 优先，相同轮次不重复注入）
    hist_keys = set()
    for m in history or []:
        role = m.get('role', '')
        content = m.get('content', '')
        if role in ('user', 'assistant') and content:
            msgs.append({"role": role, "content": content})
            hist_keys.add((role, content))
    # 6. 补充 l1 中 history 未覆盖的轮次（前端历史清空/截断时的兜底）
    for r in get_l1_chat_turns(session_id, mode):
        key = (r["role"], r["content"])
        if key not in hist_keys:
            msgs.append({"role": r["role"], "content": r["content"]})
            hist_keys.add(key)

    return msgs

# ============================================================
# 轮次后处理（响应流式结束后调用，不阻塞 SSE）
# ============================================================
def after_turn(session_id, mode, query, reply):
    """追加 assistant 轮次 → 更新 scratch → 检查预算 → 超预算异步压缩"""
    if not is_enabled():
        return
    append_turn(session_id, mode, 'assistant', reply)

    # 任务暂存区
    try:
        update_scratch(session_id, mode, query, reply)
    except Exception as e:
        _log(f"scratch 更新失败: {e}")

    # 上下文预算检查 → 超预算则后台压缩（不阻塞响应）
    try:
        est = estimate_l1_tokens(session_id, mode)
        max_ctx = _mem('max_context_tokens', 32768)
        ratio = _mem('context_budget_ratio', 0.75)
        budget = max_ctx * ratio
        if est > budget:
            _log(f"上下文超预算 {est:.0f}/{budget:.0f} tokens，启动后台压缩")
            threading.Thread(target=compress_session, args=(session_id, mode), daemon=True).start()
    except Exception as e:
        _log(f"预算检查失败: {e}")
