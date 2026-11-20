// ============================================================
// client/problem-tools.tsx — 每道题（小题）一行操作栏：检查 · 思路 · 提问
//
// 用户 2026-11-20："精简一下前端，目前各个按钮乱七八糟占地也大"。
// 早先每张题卡竖着排了四行按钮（附图 / 检查 + 错题本 + 备注 / 思路 + 说明文字），
// 现在只留一行三个，其余进题卡右上角的「⋯」。思路检查和提问的结果都是临时的，
// 在这一行下面展开、手动收起；题卡和极简模式共用这一个组件。
// ============================================================

import { useState, type ReactNode } from 'react';
import type { AskTurnView, ProblemView } from './api.ts';
import { ApproachBox, type ApproachResult } from './approach-panel.tsx';
import { AskPanel } from './ask-panel.tsx';
import { useT } from './i18n.ts';

export type AskResult = { ok: boolean; error?: string; reply?: string; questions?: string[] };

export interface ProblemToolsProps {
  problem: ProblemView;
  busy: boolean;
  onCheck: () => void;
  onApproach?: () => Promise<ApproachResult & { ok: boolean; error?: string }>;
  onAsk?: (question: string, history: AskTurnView[]) => Promise<AskResult>;
  onToast: (msg: string) => void;
  /** 操作栏右侧的附加内容（错题本提示之类） */
  extra?: ReactNode;
}

export function ProblemTools({ problem, busy, onCheck, onApproach, onAsk, onToast, extra }: ProblemToolsProps): JSX.Element {
  const t = useT();
  const [approach, setApproach] = useState<ApproachResult | null>(null);
  const [approachBusy, setApproachBusy] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [askBusy, setAskBusy] = useState(false);
  const [turns, setTurns] = useState<AskTurnView[]>([]);
  const hasDraft = !!problem.answer.trim();

  const runApproach = async (): Promise<void> => {
    if (!onApproach) return;
    setApproachBusy(true);
    try {
      const r = await onApproach();
      if (!r.ok) onToast(r.error ?? t('exercise.approach.failed', { error: '' }));
      else setApproach(r);
    } catch (e) {
      onToast(t('exercise.approach.failed', { error: (e as Error).message }));
    } finally {
      setApproachBusy(false);
    }
  };

  const ask = async (question: string): Promise<boolean> => {
    if (!onAsk) return false;
    setAskBusy(true);
    try {
      const r = await onAsk(question, turns);
      if (!r.ok) {
        onToast(t('exercise.ask.failed', { error: r.error ?? '' }));
        return false;
      }
      setTurns((prev) => [...prev, { question, reply: r.reply ?? '', questions: r.questions ?? [] }]);
      return true;
    } catch (e) {
      onToast(t('exercise.ask.failed', { error: (e as Error).message }));
      return false;
    } finally {
      setAskBusy(false);
    }
  };

  return (
    <div className="lec-tools">
      <div className="lec-actionbar">
        <button type="button" className="lec-btn" onClick={onCheck} disabled={busy} title={t('exercise.tools.checkTitle')}>
          {busy ? t('exercise.check.busy') : t('exercise.tools.check')}
        </button>
        {onApproach ? (
          <button
            type="button"
            className="lec-btn lec-btn-ghost"
            onClick={() => void runApproach()}
            disabled={approachBusy || !hasDraft}
            title={hasDraft ? t('exercise.approach.title') : t('exercise.approach.disabledTitle')}
          >
            {approachBusy ? t('exercise.approach.busy') : t('exercise.tools.approach')}
          </button>
        ) : null}
        {onAsk ? (
          <button
            type="button"
            className="lec-btn lec-btn-ghost"
            data-open={askOpen ? '1' : '0'}
            onClick={() => setAskOpen((v) => !v)}
            title={t('exercise.ask.title')}
          >
            {t('exercise.tools.ask')}
            {turns.length ? ` · ${turns.length}` : ''}
          </button>
        ) : null}
        <span className="lec-grow" />
        {extra}
      </div>
      {approach ? <ApproachBox result={approach} onClear={() => setApproach(null)} /> : null}
      {askOpen && onAsk ? (
        <AskPanel turns={turns} busy={askBusy} onAsk={ask} onClear={() => setTurns([])} onClose={() => setAskOpen(false)} />
      ) : null}
    </div>
  );
}
