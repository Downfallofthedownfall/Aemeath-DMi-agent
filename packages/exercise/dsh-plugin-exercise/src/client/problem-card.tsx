// ============================================================
// client/problem-card.tsx — 一道题的卡片（题干 + 原题截图 + 解答 + 检查）
//
// 外观照 lecture 的笔记卡（.lec-problem 用同一批 --aem-* token）。
//
// 2026-10-20 增补（用户实测："OCR 不太准还会漏掉图片，放一张截图更好"）：
//   每道题下面可以展开**原卷页面截图**（导入时渲染的 pages/page-NN.jpg）。
//   题干文本仍保留（能搜、能改、能喂检索），但"以图为准"：
//   带图的题会显示「含图」徽章 + 模型给的图注。
//
// 题干可编辑：多模态转录也可能漏字，用户必须能改。
// ============================================================

import { useState } from 'react';
import type { ProblemView } from './api.ts';
import { AnswerEditor } from './answer-editor.tsx';
import { ApproachPanel, type ApproachResult } from './approach-panel.tsx';
import { CheckPanel } from './check-panel.tsx';
import { MathText } from './math.tsx';
import { useT } from './i18n.ts';

const STATUS_KEY: Record<string, string> = {
  todo: 'exercise.problem.status.todo',
  draft: 'exercise.problem.status.draft',
  answered: 'exercise.problem.status.answered',
  checked: 'exercise.problem.status.checked',
  needs_fix: 'exercise.problem.status.needs_fix',
  done: 'exercise.common.done',
};

function statusLabel(t: (key: string) => string, status: string): string {
  const key = STATUS_KEY[status];
  return key ? t(key) : status;
}

export interface ProblemCardProps {
  problem: ProblemView;
  /** 原题截图 URL（没有页面图片 → undefined） */
  pageImageUrl?: string;
  onSave: (patch: { answer?: string; notes?: string; text?: string; title?: string; points?: number | null }) => Promise<void>;
  onCheck: () => void;
  /** 答辩：把学生的话发给爱弥斯（重新推导后承认或坚持） */
  onRebuttal: (text: string) => Promise<void>;
  /** 思路检查（可重复、临时，不落盘） */
  onApproach?: () => Promise<ApproachResult & { ok: boolean; error?: string }>;
  /** 上传/删除答案附图，以及拼图片 URL */
  onAttachImage?: (file: File) => Promise<void>;
  onDeleteImage?: (imageId: string) => void;
  imageUrl?: (name: string) => string;
  onCollectMistake: () => void;
  onDelete: () => void;
  onToast: (msg: string) => void;
  busy: boolean;
  mistakeCount: number;
}

export function ProblemCard({
  problem,
  pageImageUrl,
  onSave,
  onCheck,
  onRebuttal,
  onApproach,
  onAttachImage,
  onDeleteImage,
  imageUrl,
  onCollectMistake,
  onDelete,
  onToast,
  busy,
  mistakeCount,
}: ProblemCardProps): JSX.Element {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(problem.text);
  const [savingText, setSavingText] = useState(false);
  const [showPage, setShowPage] = useState(problem.has_figure);

  const status = problem.status;

  const saveText = async (): Promise<void> => {
    setSavingText(true);
    try {
      await onSave({ text });
      setEditing(false);
      onToast(t('exercise.problem.textSaved'));
    } catch (e) {
      onToast(t('exercise.common.saveFailed', { error: (e as Error).message }));
    } finally {
      setSavingText(false);
    }
  };

  return (
    <div className="lec-problem" data-state={status} id={`lec-problem-${problem.id}`}>
      <div className="lec-problem-head">
        <span className="lec-problem-no">{problem.label || problem.id}</span>
        {problem.points != null && <span className="lec-badge" data-kind="points">{problem.points} P</span>}
        <span className="lec-badge" data-kind={status}>{statusLabel(t, status)}</span>
        {problem.has_figure && <span className="lec-badge" data-kind="figure">{t('exercise.problem.hasFigure')}</span>}
        {problem.page > 0 && <span className="lec-badge" data-kind="todo">{t('exercise.problem.pageBadge', { page: problem.page })}</span>}
        {problem.answer_edited_by === 'agent' && <span className="lec-badge">{t('exercise.problem.agentEdited')}</span>}
        {problem.title && <span className="lec-problem-title">{problem.title}</span>}
        <span className="lec-problem-actions">
          <button type="button" className="lec-btn lec-btn-ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? t('exercise.common.cancel') : t('exercise.problem.edit')}
          </button>
          <button
            type="button"
            className="lec-del"
            title={t('exercise.problem.deleteTitle')}
            onClick={() => {
              if (window.confirm(t('exercise.problem.deleteConfirm', { label: problem.label || problem.id }))) onDelete();
            }}
          >
            ✕
          </button>
        </span>
      </div>

      {editing ? (
        <div>
          <textarea className="lec-textarea" value={text} onChange={(e) => setText(e.currentTarget.value)} spellCheck={false} />
          <div className="lec-toolrow">
            <button type="button" className="lec-btn" onClick={() => void saveText()} disabled={savingText}>
              {savingText ? t('exercise.common.saving') : t('exercise.problem.save')}
            </button>
            <span className="lec-hint" style={{ margin: 0 }}>
              {t('exercise.problem.editHint')}
            </span>
          </div>
        </div>
      ) : (
        <div className="lec-statement">
          {problem.text.trim() ? (
            <MathText text={problem.text} compact />
          ) : (
            <span className="lec-hint">{t('exercise.problem.missingText')}</span>
          )}
        </div>
      )}

      {problem.figure_note && (
        <div className="lec-fignote">{t('exercise.problem.figureNote', { note: problem.figure_note })}</div>
      )}

      {pageImageUrl && (
        <div className="lec-pagefig" data-figure={problem.has_figure ? '1' : '0'}>
          <div className="lec-toolrow" style={{ marginTop: 4 }}>
            <button type="button" className="lec-btn lec-btn-ghost" onClick={() => setShowPage((v) => !v)}>
              {showPage
                ? t('exercise.problem.hidePage')
                : t('exercise.problem.showPage', { page: problem.page || 1 })}
            </button>
            <a className="lec-btn lec-btn-ghost" href={pageImageUrl} target="_blank" rel="noreferrer">
              {t('exercise.problem.openNewWindow')}
            </a>
          </div>
          {showPage && (
            <div className="lec-pageimg">
              <img src={pageImageUrl} alt={t('exercise.problem.pageBadge', { page: problem.page || 1 })} loading="lazy" />
            </div>
          )}
        </div>
      )}

      <AnswerEditor
        problem={problem}
        onSave={onSave}
        onCheck={onCheck}
        onCollectMistake={onCollectMistake}
        onToast={onToast}
        busy={busy}
        onAttachImage={onAttachImage}
        onDeleteImage={onDeleteImage}
        imageUrl={imageUrl}
      />

      {mistakeCount > 0 && (
        <div className="lec-hint" style={{ marginTop: 8 }}>
          {t('exercise.problem.inMistakes', { n: mistakeCount })}
        </div>
      )}

      {onApproach ? <ApproachPanel onRun={onApproach} hasDraft={!!problem.answer.trim()} onToast={onToast} /> : null}
      <CheckPanel problem={problem} onRecheck={onCheck} onRebuttal={onRebuttal} busy={busy} />
    </div>
  );
}
