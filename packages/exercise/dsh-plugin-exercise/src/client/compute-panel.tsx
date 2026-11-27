// ============================================================
// client/compute-panel.tsx — 「计算 =」的结果框（临时，不保存）
//
// 用户 2026-11-27："一键填充 compute，在用户写好式子之后计算最终结果……
//   注意不要让模型做题，只是代替计算器"。
//
// 按钮在答案编辑框顶栏（answer-editor.tsx），数直接填进答案；这里只列每一处是怎么算的：
//   · 算式（模型转写的）+ 每个字母取的数和出处（草稿 / 题目 / 常数表）—— 学生能一眼看出代错没有
//   · SymPy 复算一致 / 未复算 / 不一致（不一致的不填）
//   · 没算的原因（缺数值、只有一个字母、转写越界……）
// 和思路检查一样：编辑答案不会让它消失，点「清除」才收起；「撤销填入」把答案恢复成填之前。
// ============================================================

import { useState } from 'react';
import type { ComputeFill } from '../compute-fill.ts';
import { MathText } from './math.tsx';
import { useT } from './i18n.ts';

export interface ComputeValueView {
  symbol: string;
  value: number;
  unit: string;
  source: 'draft' | 'problem' | 'constant';
  quote: string;
}

export interface ComputeItemView {
  id: string;
  latex: string;
  line: string;
  status: 'ok' | 'mismatch' | 'missing' | 'unsupported' | 'rejected' | 'error' | 'skipped';
  expr?: string;
  values: ComputeValueView[];
  missing: string[];
  reason?: string;
  note?: string;
  value?: number;
  display?: string;
  full?: string;
  verify: 'sympy' | 'mismatch' | 'unavailable' | 'skipped';
  verifyNote?: string;
  fill?: ComputeFill;
}

export interface ComputeResultView {
  ok: boolean;
  error?: string;
  items: ComputeItemView[];
  verifier: { kind: string; note?: string };
  digits: number;
  provider?: string;
}

/** 前端回填之后的结果：哪些真的填进去了 */
export interface ComputeOutcome extends ComputeResultView {
  applied: string[];
  skipped: string[];
}

const STATUS_KEY: Record<string, string> = {
  mismatch: 'exercise.compute.status.mismatch',
  missing: 'exercise.compute.status.missing',
  unsupported: 'exercise.compute.status.unsupported',
  rejected: 'exercise.compute.status.rejected',
  error: 'exercise.compute.status.error',
  skipped: 'exercise.compute.status.skipped',
};

const SOURCE_KEY: Record<string, string> = {
  draft: 'exercise.compute.source.draft',
  problem: 'exercise.compute.source.problem',
  constant: 'exercise.compute.source.constant',
};

function shortNumber(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e12) return String(v);
  return String(Number(v.toPrecision(10)));
}

export function ComputeBox({
  result,
  canUndo,
  onUndo,
  onClear,
}: {
  result: ComputeOutcome;
  canUndo: boolean;
  onUndo?: () => void;
  onClear: () => void;
}): JSX.Element {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const filled = result.applied.length;
  const notFilled = result.items.length - filled;

  return (
    <div className="lec-approach lec-compute">
      <div className="lec-approach-head">
        <button type="button" className="lec-linkbtn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '▾' : '▸'} {t('exercise.compute.heading')} ·{' '}
          {filled ? t('exercise.compute.summary', { n: filled }) : t('exercise.compute.nothingFilled')}
          {notFilled > 0 ? ` · ${t('exercise.compute.summarySkipped', { n: notFilled })}` : ''}
        </button>
        <span className="lec-grow" />
        {onUndo ? (
          <button
            type="button"
            className="lec-linkbtn"
            onClick={onUndo}
            disabled={!canUndo}
            title={canUndo ? undefined : t('exercise.compute.undoStale')}
          >
            {t('exercise.compute.undo')}
          </button>
        ) : null}
        <button type="button" className="lec-linkbtn" onClick={onClear} title={t('exercise.approach.clearHint')}>
          {t('exercise.compute.clear')}
        </button>
      </div>
      {expanded ? (
        <div className="lec-approach-box lec-compute-box">
          {result.items.map((it) => {
            const applied = result.applied.includes(it.id);
            const lost = it.fill && !applied;
            const status = lost ? 'moved' : it.status;
            return (
              <div key={it.id} className="lec-compute-row" data-status={status}>
                <div className="lec-compute-main">
                  <span className="lec-compute-tex">
                    <MathText text={`$${it.latex || '\\;'}$`} compact />
                  </span>
                  {it.status === 'ok' && it.display ? (
                    <span className="lec-compute-result">
                      <MathText text={`$${it.display}$`} compact />
                    </span>
                  ) : null}
                  <span className="lec-grow" />
                  {it.status === 'ok' ? (
                    <span className="lec-compute-badge" data-verify={it.verify}>
                      {it.verify === 'sympy' ? `✓ ${t('exercise.compute.verified')}` : t('exercise.compute.unverified')}
                    </span>
                  ) : (
                    <span className="lec-compute-badge" data-verify="bad">
                      {t(STATUS_KEY[it.status] ?? STATUS_KEY.error!)}
                    </span>
                  )}
                </div>
                {it.expr && (it.status === 'ok' || it.status === 'mismatch') ? (
                  <div className="lec-compute-detail">
                    {t('exercise.compute.via')} <code>{it.expr}</code>
                    {it.values.length > 0 ? '：' : ''}
                    {it.values.map((v, i) => (
                      <span key={v.symbol} title={v.quote}>
                        {i ? t('exercise.common.listSep') : ''}
                        <code>{v.symbol}</code> = {shortNumber(v.value)}
                        {v.unit ? ` ${v.unit}` : ''}（{t(SOURCE_KEY[v.source] ?? SOURCE_KEY.draft!)}）
                      </span>
                    ))}
                  </div>
                ) : null}
                {it.status === 'ok' && it.full ? (
                  <div className="lec-compute-detail">
                    {t('exercise.compute.full', { value: it.full })}
                    {it.verify !== 'sympy' && it.verifyNote ? ` · ${it.verifyNote}` : ''}
                  </div>
                ) : null}
                {lost ? <div className="lec-compute-detail lec-compute-why">{t('exercise.compute.moved')}</div> : null}
                {it.reason ? <div className="lec-compute-detail lec-compute-why">{it.reason}</div> : null}
                {it.note ? <div className="lec-compute-detail">{t('exercise.compute.note', { note: it.note })}</div> : null}
              </div>
            );
          })}
          <div className="lec-hint" style={{ marginTop: 4, opacity: 0.65 }}>
            {result.provider ? `${result.provider} · ` : ''}
            {t('exercise.compute.footer')}
            {result.verifier.kind !== 'sympy' && result.verifier.note ? ` · ${t('exercise.compute.noVerifier', { note: result.verifier.note })}` : ''} ·{' '}
            {t('exercise.compute.transient')}
          </div>
        </div>
      ) : null}
    </div>
  );
}
