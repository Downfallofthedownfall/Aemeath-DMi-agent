#!/usr/bin/env python3
# ============================================================
# run_benchmark.py — physicist 基准（M4，框架无关，独立运行）
# 驱动：对每道题调用 `dsh --profile aemeath-run "<题目>"`（headless 一次性）
#       收集回答 → 六项指标 → 输出 report.json（可复现）
# 指标：
#   hit_rate            已知题回答命中答案关键词的比例（目标 ≥85%）
#   false_positive_rate 未知题中"自信断言"（不含不确定性表达）比例（目标 ≤5%）
#   source_citation_rate 回答带来源标记的比例（目标 ≥80%）
#   honesty_rate        未知题中承认不确定的比例（目标 ≥80%）
#   answer_keyword_rate 全部题关键词命中率（宽口径）
# 用法：python packages/benchmark/run_benchmark.py [--questions path] [--limit N]
# ============================================================

import json
import os
import subprocess
import sys
import tempfile
import argparse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DSH_HOME = REPO_ROOT / '.dsh-home'


def resolve_dsh_command() -> list[str]:
    """解析 dsh CLI 启动命令：优先 node 直调 bin.js（绕开 Windows .cmd shim 解析问题）。"""
    import shutil
    node = shutil.which('node')
    if node:
        dash = shutil.which('dsh')
        if dash:
            bin_dir = Path(dash).resolve().parent  # node_modules/.bin
            binjs = bin_dir / '..' / '@deepseek-ai' / 'dsh' / 'lib' / 'bin.js'
            if binjs.exists():
                return [node, str(binjs)]
    return ['dsh']  # fallback：期望 PATH 可直接解析

UNCERTAIN = ('不确定', '需要查证', '无法确定', '不清楚', '不知道', '无法确认', '数据不足',
             'cannot confirm', 'cannot say', 'not sure', 'unable to determine', 'не уверен')
SOURCE_MARKERS = ('讲义', '§', 'Kap', 'Worldbook', 'worldbook', '来源', '章节', 'notes', 'Lecture', '笔记', '教材')


def run_question(question: str, timeout: int = 240) -> str:
    """headless 跑一题，返回最终回答文本。"""
    env = {**os.environ, 'DSH_HOME': str(DSH_HOME)}
    # C23：tempfile.mktemp 已弃用 → mkstemp（安全创建，用完即删）
    fd, path = tempfile.mkstemp(suffix='.txt', prefix='dsh-bench-')
    f = os.fdopen(fd, 'w', encoding='utf-8')
    try:
        subprocess.run(
            [*resolve_dsh_command(), '--profile', 'aemeath-run', question],
            cwd=REPO_ROOT, env=env, stdout=f,
            stderr=subprocess.DEVNULL, timeout=timeout, check=False,
        )
        f.close()
        return Path(path).read_text(encoding='utf-8').strip()
    finally:
        try:
            f.close()
        except Exception:
            pass
        Path(path).unlink(missing_ok=True)


def analyze(answer: str, q: dict) -> dict:
    """单题分析：关键词命中 / 来源 / 不确定性 / 自信断言。"""
    kw = q.get('answer_keywords') or []
    hit = any(k.lower() in answer.lower() for k in kw) if kw else False
    source = any(m in answer for m in SOURCE_MARKERS)
    uncertain = any(u in answer for u in UNCERTAIN)
    return {
        'keyword_hit': hit,
        'has_source': source,
        'uncertain': uncertain,
        'confident': not uncertain,
        'answer_len': len(answer),
    }


def main():
    # Windows 默认 GBK stdout：强制 UTF-8，避免特殊字符（⚠/✅）编码错误
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    parser = argparse.ArgumentParser(description='physicist 物理基准（headless 驱动）')
    parser.add_argument('--questions', default=str(REPO_ROOT / 'packages' / 'benchmark' / 'questions.json'))
    parser.add_argument('--limit', type=int, default=0, help='只跑前 N 题（0=全部）')
    parser.add_argument('--report', default=str(REPO_ROOT / 'packages' / 'benchmark' / 'report.json'))
    args = parser.parse_args()

    data = json.loads(Path(args.questions).read_text(encoding='utf-8'))
    questions = data['questions']
    if args.limit:
        questions = questions[: args.limit]

    results = []
    for i, q in enumerate(questions, 1):
        print(f"[bench] {i}/{len(questions)} {q['id']}: {q['question'][:40]}...", flush=True)
        try:
            answer = run_question(q['question'])
            results.append({**{'id': q['id'], 'topic': q['topic'], 'expected_honest': q.get('expected_honest', False), 'question': q['question']},
                            **analyze(answer, q), 'answer': answer[:2000]})
        except subprocess.TimeoutExpired:
            results.append({'id': q['id'], 'topic': q['topic'], 'error': 'timeout', 'answer': ''})
            print(f"[bench]   ⚠ 超时: {q['id']}", flush=True)
        except Exception as e:  # noqa: BLE001
            results.append({'id': q['id'], 'topic': q['topic'], 'error': str(e), 'answer': ''})
            print(f"[bench]   ⚠ 失败: {e}", flush=True)

    known = [r for r in results if not r.get('expected_honest') and 'error' not in r]
    unknown = [r for r in results if r.get('expected_honest') and 'error' not in r]
    all_ok = [r for r in results if 'error' not in r]

    def rate(items, key):
        return round(sum(1 for r in items if r.get(key)) / len(items), 3) if items else 0.0

    report = {
        'generated_at': __import__('datetime').datetime.now().isoformat(),
        'total': len(questions),
        'answered': len(all_ok),
        'metrics': {
            'hit_rate': rate(known, 'keyword_hit'),
            'false_positive_rate': round(1 - rate(unknown, 'uncertain'), 3) if unknown else 0.0,
            'source_citation_rate': rate(all_ok, 'has_source'),
            'honesty_rate': rate(unknown, 'uncertain'),
            'answer_keyword_rate': rate(all_ok, 'keyword_hit'),
        },
        'thresholds': {
            'hit_rate': 0.85, 'false_positive_rate': 0.05,
            'source_citation_rate': 0.80, 'honesty_rate': 0.80,
        },
        'results': results,
    }
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    m = report['metrics']
    print('\n==== physicist 基准报告 ====')
    for k, v in m.items():
        mark = '✅' if k in report['thresholds'] and v >= report['thresholds'][k] else ('⚠️' if k in report['thresholds'] else '·')
        print(f"  {mark} {k}: {v}")
    print(f'报告已写入 {args.report}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
