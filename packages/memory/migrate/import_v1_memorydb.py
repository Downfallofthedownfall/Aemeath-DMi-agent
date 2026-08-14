# -*- coding: utf-8 -*-
# ============================================================
# import_v1_memorydb.py — v1 memory.db → v2 记忆存储迁移脚本（M3 遗留补全）
#
# 读取 v1（electron-app/data/memory.db，SQLite L1/L2），把 l2_memories 表
# 转为 v2 MemoryRecord，合并写入 .dsh-home/storages/aemeath_memory.json
# （dsh-storage-domain 的 JSON 后端，unit/tables 布局）。
#
# 幂等：导入记录 id = "v1-" + sha1(content+mode+created_at)，重复运行跳过已存在；
# 写前自动备份原文件为 aemeath_memory.json.bak-<ts>。
#
# 用法：python packages/memory/migrate/import_v1_memorydb.py [--v1-db PATH] [--dry-run]
# ============================================================
import argparse
import datetime
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:  # noqa: BLE001
    pass

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DEFAULT_V1_DB = os.path.join(REPO_ROOT, 'electron-app', 'data', 'memory.db')
DEFAULT_V2_STORAGE = os.path.join(REPO_ROOT, '.dsh-home', 'storages', 'aemeath_memory.json')

# v1 mode → v2 preset 映射（v1 config.json 用 physicist；v2 preset 用 scholar）
MODE_MAP = {'physicist': 'scholar', 'aemeath': 'aemeath'}

# v1 自由文本 category → v2 枚举
CATEGORY_RULES = [
    (('user', '用户', '个人信息', '姓名', '名字', '生日', '职业'), 'user_fact'),
    (('study', '学习', '考试', '课程', '物理', '数学', '讲义', '作业', '复习'), 'study_log'),
    (('prefer', '喜欢', '偏好', '爱好', '讨厌', '爱'), 'preference'),
    (('关系', '朋友', '家人', '同学', 'relationship', 'family', 'friend'), 'relationship'),
]
CATEGORY_FALLBACK = 'session_summary'


def parse_v1_time(s):
    """'YYYY-MM-DD HH:MM:SS' → epoch ms；失败返回 0。"""
    if not s:
        return 0
    try:
        return int(datetime.datetime.strptime(s, '%Y-%m-%d %H:%M:%S').timestamp() * 1000)
    except Exception:  # noqa: BLE001
        try:
            return int(float(s) * 1000)
        except Exception:  # noqa: BLE001
            return 0


def map_category(text):
    text = (text or '').lower()
    for kws, cat in CATEGORY_RULES:
        if any(k.lower() in text for k in kws):
            return cat
    return CATEGORY_FALLBACK


def migrate(v1_db, v2_storage, dry_run):
    if not os.path.exists(v1_db):
        print(f"✗ v1 数据库不存在: {v1_db}（跳过，无数据可迁移）")
        return 0

    conn = sqlite3.connect(v1_db)
    try:
        rows = conn.execute(
            "SELECT session_id, mode, content, importance, category, source, status, "
            "created_at, updated_at FROM l2_memories"
        ).fetchall()
    except sqlite3.Error as e:
        print(f"✗ 读取 l2_memories 失败: {e}")
        return 0
    finally:
        conn.close()

    if not rows:
        print("ℹ l2_memories 为空（v1 没有 L2 记忆），无需迁移")
        return 0

    # 读取 v2 存储（不存在则建新结构）
    data = {"unit": {"name": "aemeath_memory", "version": 1},
            "global": None,
            "tables": {"memories": {}, "audit": {}}}
    if os.path.exists(v2_storage):
        with open(v2_storage, 'r', encoding='utf-8') as f:
            data = json.load(f)
    memories = data.setdefault('tables', {}).setdefault('memories', {})
    audit = data.setdefault('tables', {}).setdefault('audit', {})

    now = int(time.time() * 1000)
    imported = skipped = 0
    for sid, mode, content, importance, category, source, status, created_at, updated_at in rows:
        if not content or not str(content).strip():
            continue
        preset = MODE_MAP.get((mode or '').lower(), (mode or 'scholar').lower())
        key = 'v1-' + hashlib.sha1(f"{content}|{mode}|{created_at}".encode('utf-8')).hexdigest()[:32]
        if key in memories:
            skipped += 1
            continue
        rec = {
            "id": key,
            "scope": "mode",
            "preset": preset,
            "content": str(content).strip(),
            "category": map_category(category),
            "importance": int(importance or 50),
            "confidence": 0.8,
            "source_mode": (mode or preset).lower(),
            "created_at": parse_v1_time(created_at) or now,
            "last_access": parse_v1_time(updated_at) or now,
            "status": "active" if status == 'active' else "dormant",
            "superseded_by": None,
            "deleted": None,
        }
        memories[key] = rec
        audit[f"v1-imp-{key[3:]}"] = {
            "id": f"v1-imp-{key[3:]}", "ts": now,
            "action": "import_v1", "memory_id": key,
            "detail": f"imported from v1 memory.db (mode={mode}, source={source or ''})",
        }
        imported += 1

    print(f"读取 {len(rows)} 条 v1 L2 记录：新导入 {imported}，跳过已有 {skipped}")
    if imported == 0:
        print("ℹ 无新增记录，未写文件")
        return 0
    if dry_run:
        print(f"ℹ dry-run：不写文件（v2 存储将新增 {imported} 条）")
        return imported

    # 备份后写回
    if os.path.exists(v2_storage):
        bak = f"{v2_storage}.bak-{int(time.time())}"
        shutil.copy2(v2_storage, bak)
        print(f"备份原存储 → {bak}")
    with open(v2_storage, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"✅ 已写入 {v2_storage}（记忆 {len(memories)} 条，审计 {len(audit)} 条）")
    return imported


def main():
    parser = argparse.ArgumentParser(description='v1 memory.db → v2 记忆存储迁移')
    parser.add_argument('--v1-db', default=DEFAULT_V1_DB, help='v1 SQLite 路径')
    parser.add_argument('--v2-storage', default=DEFAULT_V2_STORAGE, help='v2 存储 JSON 路径')
    parser.add_argument('--dry-run', action='store_true', help='只统计不写文件')
    args = parser.parse_args()

    # 提示：dsh 运行时该存储由进程持有，写回可能被覆盖
    if os.path.exists(os.path.join(REPO_ROOT, '.dsh-home')) and not args.dry_run:
        print("⚠ 建议先停止 dsh（3081）再执行，避免存储被运行时覆盖")
    n = migrate(args.v1_db, args.v2_storage, args.dry_run)
    sys.exit(0 if n is not None else 1)


if __name__ == '__main__':
    main()
