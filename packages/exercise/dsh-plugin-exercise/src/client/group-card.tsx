// ============================================================
// client/group-card.tsx — 大题卡：共用题干 + 原卷截图 + 一串小题
//
// 用户 2026-11-20："题目做成大题中的小题也分开管理，这样子检查的时候不用重复检查正确的小题"。
//   · 每个小题是一张独立的题卡（自己的解答 / 检查 / 提问）
//   · 「检查未通过的小题」只检查有答案、且还没判 correct 的小题；
//     已经 correct、答案又没改过的小题直接跳过
// ============================================================

import { useEffect, useState, type ReactNode } from 'react';
import type { ProblemGroupView, ProblemView } from './api.ts';
import { MathText } from './math.tsx';
import { Menu } from './menu.tsx';
import { PageFigure } from './page-figure.tsx';
import { useT } from './i18n.ts';

/** 「检查未通过的小题」要查哪些：有答案、最近一次结论不是 correct（改过答案的会重新查）。 */
export function partsToCheck(parts: readonly ProblemView[]): ProblemView[] {
  return parts.filter((p) => p.answer.trim() && p.status !== 'checked' && p.status !== 'done');
}

export interface GroupCardProps {
  group: ProblemGroupView;
  parts: ProblemView[];
  pageImageUrl?: string;
  /** 正在检查的小题数 */
  checking: number;
  onCheckParts: () => void;
  onSaveGroup: (patch: { text?: string; title?: string }) => Promise<void>;
  onMerge: () => void;
  onToast: (msg: string) => void;
  children: ReactNode;
}

export function GroupCard({
  group,
  parts,
  pageImageUrl,
  checking,
  onCheckParts,
  onSaveGroup,
  onMerge,
  onToast,
  children,
}: GroupCardProps): JSX.Element {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(group.text);
  const [saving, setSaving] = useState(false);
  const [showPage, setShowPage] = useState(group.has_figure);
  useEffect(() => {
    if (!editing) setText(group.text);
  }, [group.text, editing]);

  const passed = parts.filter((p) => p.status === 'checked' || p.status === 'done').length;
  const todo = partsToCheck(parts).length;
  const state = passed === parts.length ? 'checked' : parts.some((p) => p.status === 'needs_fix') ? 'needs_fix' : 'answered';
  const page = group.page || 1;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await onSaveGroup({ text });
      setEditing(false);
      onToast(t('exercise.problem.textSaved'));
    } catch (e) {
      onToast(t('exercise.common.saveFailed', { error: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="lec-group" data-state={state} id={`lec-group-${group.id}`}>
      <div className="lec-problem-head">
        <span className="lec-problem-no">{group.label || group.id}</span>
        {group.points != null && <span className="lec-badge" data-kind="points">{group.points} P</span>}
        <span className="lec-badge" data-kind={state}>
          {t('exercise.group.passed', { passed, total: parts.length })}
        </span>
        {group.has_figure && <span className="lec-badge" data-kind="figure">{t('exercise.problem.hasFigure')}</span>}
        {group.title && <span className="lec-problem-title">{group.title}</span>}
        <span className="lec-problem-actions">
          {pageImageUrl ? (
            <button
              type="button"
              className="lec-chip"
              data-open={showPage ? '1' : '0'}
              title={showPage ? t('exercise.problem.hidePage') : t('exercise.problem.showPage', { page })}
              onClick={() => setShowPage((v) => !v)}
            >
              {t('exercise.problem.pageChip', { page })}
            </button>
          ) : null}
          <button
            type="button"
            className="lec-btn"
            onClick={onCheckParts}
            disabled={checking > 0 || todo === 0}
            title={todo ? t('exercise.group.checkTitle') : t('exercise.group.nothingToCheck')}
          >
            {checking > 0 ? t('exercise.group.checking', { n: checking }) : t('exercise.group.check', { n: todo })}
          </button>
          <Menu
            title={t('exercise.common.more')}
            items={[
              { label: editing ? t('exercise.problem.cancelEdit') : t('exercise.group.editStem'), onSelect: () => setEditing((v) => !v) },
              {
                label: t('exercise.group.merge'),
                title: t('exercise.group.mergeTitle'),
                onSelect: () => {
                  if (window.confirm(t('exercise.group.mergeConfirm', { label: group.label || group.id }))) onMerge();
                },
              },
            ]}
          />
        </span>
      </div>

      {editing ? (
        <div>
          <textarea className="lec-textarea" value={text} onChange={(e) => setText(e.currentTarget.value)} spellCheck={false} />
          <div className="lec-toolrow">
            <button type="button" className="lec-btn" onClick={() => void save()} disabled={saving}>
              {saving ? t('exercise.common.saving') : t('exercise.problem.save')}
            </button>
            <button type="button" className="lec-btn lec-btn-ghost" onClick={() => setEditing(false)}>
              {t('exercise.common.cancel')}
            </button>
          </div>
        </div>
      ) : group.text.trim() ? (
        <div className="lec-statement">
          <MathText text={group.text} compact />
        </div>
      ) : null}

      {group.figure_note && <div className="lec-fignote">{t('exercise.problem.figureNote', { note: group.figure_note })}</div>}
      {pageImageUrl && showPage && (
        <PageFigure url={pageImageUrl} page={page} figure={group.has_figure} onHide={() => setShowPage(false)} />
      )}

      <div className="lec-group-parts">{children}</div>
    </section>
  );
}
