// ============================================================
// client/check-panel.tsx — 一次手动检查的结果（外观照 lecture 的卡片/提示）
//
// 界面纪律：
//   ① 检查是**建议**不是判分 —— 只显示"哪一步不成立 + 下一步验证什么"
//   ② 答案改了 → 旧检查显式标灰，但**内容还在**（用户："修改答案不要让错误表消失"）
//      —— 改之前看到的错误列表是判断"是否真改了"的依据，直接清空反而更难用
//   ③ 历史可折叠（错题本要能回答"当时我是怎么错的"）
//   ④ 答辩：学生可以质疑批改，模型重新推导后承认（划掉 issues）或给出证据坚持
// ============================================================

import { useState } from 'react';
import type { CheckView, ProblemView, RebuttalView } from './api.ts';
import { MathText } from './math.tsx';

const VERDICT_LABEL: Record<string, string> = {
  correct: '正确',
  partial: '部分正确',
  wrong: '有错',
  unclear: '无法判定',
  error: '检查失败',
};

const OUTCOME_LABEL: Record<RebuttalView['outcome'], string> = {
  conceded: '认错并撤回',
  upheld: '维持原判',
  partial: '各有对错',
};

function timeOf(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一次检查的主体（issues / hints / next steps）。 */
function CheckBody({ check, stale }: { check: CheckView; stale?: boolean }): JSX.Element {
  const withdrawn = new Set(check.withdrawn ?? []);
  const remaining = check.remaining ?? [];
  return (
    <div data-stale={stale ? '1' : undefined}>
      <div className="lec-verdict-head">
        <span className="lec-badge">{VERDICT_LABEL[check.verdict] ?? check.verdict}</span>
        <span className="lec-mistake-path">
          {timeOf(check.created_at)}
          {check.model ? ` · ${check.model}` : ''}
          {check.provider ? ` · ${check.provider}` : ''}
          {check.reasoning
            ? ` · 推理${
                check.reasoning === 'off'
                  ? '关'
                  : check.reasoning.startsWith('off')
                    ? '关（降级）'
                    : check.reasoning === 'max'
                      ? ' max'
                      : ` ${check.reasoning}`
              }`
            : ''}
          {stale ? ' · 针对旧答案' : ''}
        </span>
      </div>

      {check.issues.map((i, idx) => {
        const gone = withdrawn.has(idx);
        return (
          <div
            key={idx}
            className="lec-issue"
            data-sev={i.severity}
            style={gone ? { opacity: 0.45, textDecoration: 'line-through' } : undefined}
            title={gone ? '这条已被你的答辩撤回' : undefined}
          >
            <span className="sev">{gone ? '已撤回' : i.severity === 'error' ? '错误' : i.severity === 'warn' ? '存疑' : '说明'}</span>
            <span>
              <MathText text={i.text} compact />
            </span>
          </div>
        );
      })}

      {remaining.length > 0 && withdrawn.size > 0 && (
        <div className="lec-hint" style={{ marginTop: 6 }}>
          <b>答辩后仍然成立：</b>
          <ul className="lec-mistake-issues">
            {remaining.map((i, idx) => (
              <li key={idx}>
                <MathText text={i.text} compact />
              </li>
            ))}
          </ul>
        </div>
      )}

      {check.hints.length > 0 && (
        <ul className="lec-mistake-issues">
          {check.hints.map((h, idx) => (
            <li key={idx}>
              <MathText text={h} compact />
            </li>
          ))}
        </ul>
      )}

      {check.next_steps.length > 0 && (
        <div className="lec-hint" style={{ marginTop: 6 }}>
          <b>下一步可以：</b>
          <ul className="lec-mistake-issues">
            {check.next_steps.map((s, idx) => (
              <li key={idx}>
                <MathText text={s} compact />
              </li>
            ))}
          </ul>
        </div>
      )}

      {check.verdict === 'error' && check.raw && (
        <details>
          <summary className="lec-hint" style={{ cursor: 'pointer' }}>
            模型原始输出（排障用）
          </summary>
          <pre className="lec-md-code">{check.raw.slice(0, 1200)}</pre>
        </details>
      )}
    </div>
  );
}

/** 答辩：输入框 + 历史对话。 */
function RebuttalBox({
  problem,
  onSubmit,
  busy,
}: {
  problem: ProblemView;
  onSubmit: (text: string) => Promise<void>;
  busy: boolean;
}): JSX.Element {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const thread = problem.rebuttals ?? [];
  const last = thread.at(-1);
  const canWrite = !!problem.checks.length;

  return (
    <div className="lec-rebut" style={{ marginTop: 8 }}>
      {thread.length > 0 && (
        <div className="lec-rebut-thread">
          {thread.map((r) => (
            <div key={r.id} className="lec-rebut-turn">
              <div className="lec-rebut-mine">
                <span className="lec-rebut-who">我</span> {r.user_text}
              </div>
              <div className="lec-rebut-ai" data-outcome={r.outcome}>
                <span className="lec-rebut-who">爱弥斯 · {OUTCOME_LABEL[r.outcome]}</span>{' '}
                <MathText text={r.reply} compact />
                {r.correct_parts.length > 0 && (
                  <div className="lec-hint" style={{ marginTop: 4 }}>
                    承认你对的部分：{r.correct_parts.join('；')}
                  </div>
                )}
                {r.remaining.length > 0 && (
                  <ul className="lec-mistake-issues" style={{ marginTop: 4 }}>
                    {r.remaining.map((i, idx) => (
                      <li key={idx}>
                        <MathText text={i.text} compact />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!open ? (
        <button
          type="button"
          className="lec-btn lec-btn-ghost"
          disabled={!canWrite || busy}
          title={canWrite ? '认为批改错了？让她重新推导一遍' : '先检查一次，才能答辩'}
          onClick={() => setOpen(true)}
        >
          {last?.outcome === 'upheld' ? '继续答辩' : '答辩 · 我认为这里没错'}
        </button>
      ) : (
        <div>
          <textarea
            className="lec-textarea lec-rebut-input"
            rows={3}
            value={text}
            placeholder="指出你觉得被误判的那一步，比如：这里 $N$ 由球面约束给出，不是 $mg\cos\alpha$；我第 2 行已经写了 $v=\dot x$…"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="lec-toolrow">
            <button
              type="button"
              className="lec-btn"
              disabled={busy || !text.trim()}
              onClick={() => {
                void onSubmit(text).then(() => setText(''));
              }}
            >
              {busy ? '她在重新推导…' : '提交答辩'}
            </button>
            <button type="button" className="lec-btn lec-btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
              取消
            </button>
            <span className="lec-hint" style={{ marginLeft: 'auto' }}>
              她会重新独立推导；你说得对就撤回，说不对会给具体证据
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export interface CheckPanelProps {
  problem: ProblemView;
  onRecheck: () => void;
  onRebuttal: (text: string) => Promise<void>;
  busy: boolean;
}

export function CheckPanel({ problem, onRecheck, onRebuttal, busy }: CheckPanelProps): JSX.Element | null {
  const [showHistory, setShowHistory] = useState(false);
  const fresh = problem.last_check;
  const last = problem.checks.at(-1) ?? null;
  const staleCount = problem.checks.filter((c) => c.stale).length;

  if (!problem.checks.length) return null;

  // 关键：没有"新鲜"检查时**不要把内容藏起来**（用户明确要求"修改答案不要让错误表消失"），
  // 而是继续展示最后一次检查的内容，只加一条"针对旧答案"的横幅。
  const shown = fresh ?? last;
  const isStale = !fresh;

  return (
    <div className="lec-verdict" data-verdict={isStale ? 'stale' : shown?.verdict}>
      {isStale && (
        <div className="lec-stale">
          答案改过了 —— 下面是{' '}
          <b>改之前</b>
          {' '}那次检查（{last ? VERDICT_LABEL[last.verdict] ?? last.verdict : '—'}
          {last ? `，${timeOf(last.created_at)}` : ''}）。它针对的是旧答案，仅供参考；改完可以重新检查一次。
        </div>
      )}

      {shown && <CheckBody check={shown} stale={isStale} />}

      {fresh && staleCount > 0 && (
        <div className="lec-hint" style={{ marginTop: 6 }}>
          另有 {staleCount} 条针对旧答案的检查（展开历史可看）。
        </div>
      )}

      <div className="lec-toolrow">
        <button type="button" className="lec-btn lec-btn-ghost" onClick={onRecheck} disabled={busy}>
          {busy ? '检查中…' : isStale ? '按新答案再检查' : '再检查一次'}
        </button>
        {problem.checks.length > 1 && (
          <button type="button" className="lec-btn lec-btn-ghost" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? '收起历史' : `历史（${problem.checks.length}）`}
          </button>
        )}
      </div>

      {showHistory && (
        <div>
          {[...problem.checks]
            .reverse()
            .slice(1)
            .map((c) => (
              <details key={c.id}>
                <summary className="lec-hint" style={{ cursor: 'pointer' }}>
                  {timeOf(c.created_at)} · {VERDICT_LABEL[c.verdict] ?? c.verdict}
                  {c.stale ? '（旧答案）' : ''}
                </summary>
                <CheckBody check={c} />
              </details>
            ))}
        </div>
      )}

      <RebuttalBox problem={problem} onSubmit={onRebuttal} busy={busy} />
    </div>
  );
}
