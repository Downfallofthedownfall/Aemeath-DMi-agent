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
import { useT } from './i18n.ts';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** verdict → i18n key（模块级只存 key，渲染时再 t()，切换语言才会重渲染）。 */
export const VERDICT_KEY: Record<string, string> = {
  correct: 'exercise.check.verdict.correct',
  partial: 'exercise.check.verdict.partial',
  wrong: 'exercise.check.verdict.wrong',
  unclear: 'exercise.check.verdict.unclear',
  error: 'exercise.check.verdict.error',
};

/** 已知 verdict 查字典，未知值原样显示（后端将来加值也不会变成空标签）。 */
export function verdictLabel(t: Translate, verdict: string): string {
  const key = VERDICT_KEY[verdict];
  return key ? t(key) : verdict;
}

const OUTCOME_KEY: Record<RebuttalView['outcome'], string> = {
  conceded: 'exercise.check.outcome.conceded',
  upheld: 'exercise.check.outcome.upheld',
  partial: 'exercise.check.outcome.partial',
};

const SEVERITY_KEY: Record<string, string> = {
  error: 'exercise.check.sev.error',
  warn: 'exercise.check.sev.warn',
  info: 'exercise.check.sev.info',
};

/** 推理模式：off / 降级 需要翻译，max 等值本身是语言无关的。 */
function reasoningValue(t: Translate, reasoning: string): string {
  if (reasoning === 'off') return t('exercise.check.reasoning.off');
  if (reasoning.startsWith('off')) return t('exercise.check.reasoning.offDegraded');
  return reasoning;
}

function timeOf(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一次检查的主体（issues / hints / next steps）。 */
function CheckBody({ check, stale }: { check: CheckView; stale?: boolean }): JSX.Element {
  const t = useT();
  const withdrawn = new Set(check.withdrawn ?? []);
  const remaining = check.remaining ?? [];
  return (
    <div data-stale={stale ? '1' : undefined}>
      <div className="lec-verdict-head">
        <span className="lec-badge">{verdictLabel(t, check.verdict)}</span>
        <span className="lec-mistake-path">
          {timeOf(check.created_at)}
          {check.model ? ` · ${check.model}` : ''}
          {check.provider ? ` · ${check.provider}` : ''}
          {check.reasoning ? t('exercise.check.reasoning', { value: reasoningValue(t, check.reasoning) }) : ''}
          {stale ? t('exercise.check.staleMark') : ''}
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
            title={gone ? t('exercise.check.withdrawnTitle') : undefined}
          >
            <span className="sev">
              {gone ? t('exercise.check.sev.withdrawn') : t(SEVERITY_KEY[i.severity] ?? 'exercise.check.sev.info')}
            </span>
            <span>
              <MathText text={i.text} compact />
            </span>
          </div>
        );
      })}

      {remaining.length > 0 && withdrawn.size > 0 && (
        <div className="lec-hint" style={{ marginTop: 6 }}>
          <b>{t('exercise.check.remaining')}</b>
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
          <b>{t('exercise.check.nextSteps')}</b>
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
            {t('exercise.check.rawOutput')}
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
  const t = useT();
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
                <span className="lec-rebut-who">{t('exercise.check.who.me')}</span> {r.user_text}
              </div>
              <div className="lec-rebut-ai" data-outcome={r.outcome}>
                <span className="lec-rebut-who">
                  {t('exercise.check.who.aemeath')} · {t(OUTCOME_KEY[r.outcome])}
                </span>{' '}
                <MathText text={r.reply} compact />
                {r.correct_parts.length > 0 && (
                  <div className="lec-hint" style={{ marginTop: 4 }}>
                    {t('exercise.check.concededParts')}
                    {r.correct_parts.join(t('exercise.common.listSep'))}
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
          title={
            canWrite ? t('exercise.check.rebuttal.title') : t('exercise.check.rebuttal.disabledTitle')
          }
          onClick={() => setOpen(true)}
        >
          {last?.outcome === 'upheld' ? t('exercise.check.rebuttal.continue') : t('exercise.check.rebuttal.start')}
        </button>
      ) : (
        <div>
          <textarea
            className="lec-textarea lec-rebut-input"
            rows={3}
            value={text}
            placeholder={t('exercise.check.rebuttal.placeholder')}
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
              {busy ? t('exercise.check.rebuttal.busy') : t('exercise.check.rebuttal.submit')}
            </button>
            <button type="button" className="lec-btn lec-btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t('exercise.common.cancel')}
            </button>
            <span className="lec-hint" style={{ marginLeft: 'auto' }}>
              {t('exercise.check.rebuttal.hint')}
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
  const t = useT();
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
          {t('exercise.check.staleBanner.lead')}
          <b>{t('exercise.check.staleBanner.strong')}</b>
          {t('exercise.check.staleBanner.after', {
            verdict: last ? verdictLabel(t, last.verdict) : '—',
            date: last ? t('exercise.check.staleBanner.date', { date: timeOf(last.created_at) }) : '',
          })}
        </div>
      )}

      {shown && <CheckBody check={shown} stale={isStale} />}

      {fresh && staleCount > 0 && (
        <div className="lec-hint" style={{ marginTop: 6 }}>
          {t('exercise.check.moreStale', { n: staleCount })}
        </div>
      )}

      <div className="lec-toolrow">
        <button type="button" className="lec-btn lec-btn-ghost" onClick={onRecheck} disabled={busy}>
          {busy ? t('exercise.check.busy') : isStale ? t('exercise.check.recheckStale') : t('exercise.check.recheck')}
        </button>
        {problem.checks.length > 1 && (
          <button type="button" className="lec-btn lec-btn-ghost" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? t('exercise.check.hideHistory') : t('exercise.check.history', { n: problem.checks.length })}
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
                  {timeOf(c.created_at)} · {verdictLabel(t, c.verdict)}
                  {c.stale ? t('exercise.check.oldAnswer') : ''}
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
