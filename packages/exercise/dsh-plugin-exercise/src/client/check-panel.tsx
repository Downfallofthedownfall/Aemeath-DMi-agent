// ============================================================
// client/check-panel.tsx — 一次手动检查的结果展示
//
// 三条界面纪律（对应产品决策）：
//   ① 检查是**建议**，不是判分 —— 所以显示"结论 + 哪一步不成立 + 下一步验证什么"，
//      不显示"得分 3/4"这种会让人停下思考的东西（score 只做内部参考，默认不展示）
//   ② 答案改了 → 旧检查**必须显式标灰**（"这份结论针对的是旧答案"），
//      否则用户会拿着一个与当前答案无关的"正确"徽章走人
//   ③ 历史检查可折叠查看（错题本要能回答"当时我是怎么错的"）
// ============================================================

import { useState } from 'react';
import type { CheckView, ProblemView } from './api.ts';
import { MathText } from './math.tsx';

const VERDICT_LABEL: Record<string, string> = {
  correct: '正确',
  partial: '部分正确',
  wrong: '有错',
  unclear: '无法判定',
  error: '检查失败',
};

function timeOf(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 单次检查结果的正文（verdict 徽章 + issues + hints）。 */
function CheckBody({ check }: { check: CheckView }): JSX.Element {
  return (
    <div>
      <div className="ex-check-head">
        <span className={`ex-verdict ${check.verdict}`}>{VERDICT_LABEL[check.verdict] ?? check.verdict}</span>
        <span className="ex-mistake-path">
          {timeOf(check.created_at)}
          {check.model ? ` · ${check.model}` : ''}
          {check.stale ? ' · 针对旧答案' : ''}
        </span>
      </div>

      {check.issues.map((i, idx) => (
        <div key={idx} className={`ex-issue sev-${i.severity}`}>
          <span className="sev">{i.severity === 'error' ? '错误' : i.severity === 'warn' ? '存疑' : '说明'}</span>
          <span>
            <MathText text={i.text} compact />
          </span>
        </div>
      ))}

      {check.hints.length > 0 && (
        <ul className="ex-hint-list">
          {check.hints.map((h, idx) => (
            <li key={idx}>
              <MathText text={h} compact />
            </li>
          ))}
        </ul>
      )}

      {check.next_steps.length > 0 && (
        <div className="ex-check-history">
          <b>下一步可以：</b>
          <ul className="ex-hint-list">
            {check.next_steps.map((s, idx) => (
              <li key={idx}>
                <MathText text={s} compact />
              </li>
            ))}
          </ul>
        </div>
      )}

      {check.verdict === 'error' && check.raw && (
        <details className="ex-check-history">
          <summary>模型原始输出（排障用）</summary>
          <pre className="ex-md-code">{check.raw.slice(0, 1200)}</pre>
        </details>
      )}
    </div>
  );
}

export interface CheckPanelProps {
  problem: ProblemView;
  onRecheck: () => void;
  busy: boolean;
}

export function CheckPanel({ problem, onRecheck, busy }: CheckPanelProps): JSX.Element | null {
  const [showHistory, setShowHistory] = useState(false);
  const fresh = problem.last_check;
  const last = problem.checks.at(-1) ?? null;
  const staleCount = problem.checks.filter((c) => c.stale).length;

  if (!problem.checks.length) return null;

  return (
    <div className="ex-check">
      {fresh ? (
        <CheckBody check={fresh} />
      ) : (
        <div className="ex-stale-note">
          答案改过了 —— 上次检查（{last ? VERDICT_LABEL[last.verdict] ?? last.verdict : '—'}）针对的是旧答案，已过期。
          改完可以重新检查一次。
        </div>
      )}

      {fresh && staleCount > 0 && (
        <div className="ex-check-history">另有 {staleCount} 条针对旧答案的检查（展开历史可看）。</div>
      )}

      <div className="ex-answer-tools">
        <button type="button" className="ex-btn ex-btn-sm" onClick={onRecheck} disabled={busy}>
          {busy ? '检查中…' : '再检查一次'}
        </button>
        {problem.checks.length > 1 && (
          <button type="button" className="ex-btn ex-btn-sm ex-btn-ghost" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? '收起历史' : `历史（${problem.checks.length}）`}
          </button>
        )}
      </div>

      {showHistory && (
        <div className="ex-check-history">
          {[...problem.checks]
            .reverse()
            .slice(1)
            .map((c) => (
              <details key={c.id}>
                <summary>
                  {timeOf(c.created_at)} · {VERDICT_LABEL[c.verdict] ?? c.verdict}
                  {c.stale ? '（旧答案）' : ''}
                </summary>
                <CheckBody check={c} />
              </details>
            ))}
        </div>
      )}
    </div>
  );
}
