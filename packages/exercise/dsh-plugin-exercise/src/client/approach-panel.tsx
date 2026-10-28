// ============================================================
// client/approach-panel.tsx — 思路检查（做题中途，可重复、临时）
//
// 用户 2026-10-28："做题做一半的时候 LLM 检查做题思路和路径，避免让 llm 写出解题方法，
//   只要指出错误点，避免白白浪费时间科技树点歪，尽量保守提示。"
// 澄清："人工激活，不是说做到一半检查一次，就加一个检查思路的可重复执行就行了，
//   输出就临时的不要一直占用前端篇幅，但是也不要一改内容就消失，毕竟要看着改的，
//   就人工重置就行了。"
//
// 因此：
//   · 只由按钮手动触发，点几次都行（结果只留最新一次、模板里最多 2 条 issue）
//   · 结果**只在内存里**：不写 sheet.json、不进检查历史、刷新就没了
//   · 编辑答案**不会**清掉它（要边看边改）；只有点「清除」才消失
//   · 默认收起成一行摘要，不长期占用版面
// ============================================================

import { useState } from 'react';
import { MathText } from './math.tsx';
import { useT } from './i18n.ts';

export interface ApproachResult {
  verdict: string;
  issues: Array<{ severity: string; text: string }>;
  note: string;
  model: string;
  provider: string;
  reasoning: string;
}

const VERDICT_KEY: Record<string, string> = {
  on_track: 'exercise.approach.verdict.onTrack',
  at_risk: 'exercise.approach.verdict.atRisk',
  wrong: 'exercise.approach.verdict.wrong',
  unclear: 'exercise.approach.verdict.unclear',
};

export interface ApproachPanelProps {
  /** 真正发起请求的钩子（由外层注入，便于工作台和极简模式复用） */
  onRun: () => Promise<ApproachResult & { ok: boolean; error?: string }>;
  /** 答案为空时不让点（没什么可检查的） */
  hasDraft: boolean;
  onToast?: (msg: string) => void;
}

export function ApproachPanel({ onRun, hasDraft, onToast }: ApproachPanelProps): JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApproachResult | null>(null);
  const [expanded, setExpanded] = useState(true);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await onRun();
      if (!r.ok) {
        onToast?.(r.error ?? t('exercise.approach.failed', { error: '' }));
        return;
      }
      setResult(r);
      setExpanded(true);
    } catch (e) {
      onToast?.(t('exercise.approach.failed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const verdictLabel = result ? t(VERDICT_KEY[result.verdict] ?? VERDICT_KEY.unclear!) : '';

  return (
    <div className="lec-approach">
      <div className="lec-toolrow" style={{ marginTop: 0 }}>
        <button
          type="button"
          className="lec-btn lec-btn-ghost"
          onClick={() => void run()}
          disabled={busy || !hasDraft}
          title={hasDraft ? t('exercise.approach.title') : t('exercise.approach.disabledTitle')}
        >
          {busy ? t('exercise.approach.busy') : t('exercise.approach.run')}
        </button>
        {result ? (
          <>
            <button
              type="button"
              className="lec-btn lec-btn-ghost"
              data-open={expanded ? '1' : '0'}
              onClick={() => setExpanded((v) => !v)}
            >
              {verdictLabel}
              {expanded ? ` · ${t('exercise.common.collapse')}` : ` · ${t('exercise.common.expand')}`}
            </button>
            <button
              type="button"
              className="lec-btn lec-btn-ghost"
              onClick={() => setResult(null)}
              title={t('exercise.approach.clearHint')}
            >
              {t('exercise.approach.clear')}
            </button>
          </>
        ) : (
          <span className="lec-hint" style={{ margin: 0 }}>
            {t('exercise.approach.hint')}
          </span>
        )}
      </div>

      {result && expanded ? (
        <div className="lec-approach-box" data-verdict={result.verdict}>
          {result.issues.length > 0 ? (
            <ul className="lec-mistake-issues" style={{ marginTop: 0 }}>
              {result.issues.map((i, idx) => (
                <li key={idx} data-sev={i.severity}>
                  <MathText text={i.text} compact />
                </li>
              ))}
            </ul>
          ) : (
            <div className="lec-hint" style={{ margin: 0 }}>
              {t('exercise.approach.noIssues')}
            </div>
          )}
          {result.note ? (
            <div className="lec-hint" style={{ marginTop: 4 }}>
              <MathText text={result.note} compact />
            </div>
          ) : null}
          <div className="lec-hint" style={{ marginTop: 2, opacity: 0.65 }}>
            {result.provider}
            {result.reasoning ? ` · ${t('exercise.approach.reasoning', { value: result.reasoning })}` : ''} ·{' '}
            {t('exercise.approach.transient')}
          </div>
        </div>
      ) : null}
    </div>
  );
}
