// ============================================================
// client/problem-card.tsx — 一道题（或一个小题）的卡片：题干 + 解答 + 检查
//
// 外观照 lecture 的笔记卡（.lec-problem 用同一批 --aem-* token）。
//
// 2026-10-20：每道题下面可以展开**原卷页面截图**（OCR 不准时以图为准）。
// 2026-11-20 精简（用户："各个按钮乱七八糟占地也大"）：
//   · 头部右侧只留「原卷」开关和「⋯」菜单：改题干 / 拆成小题 / 加图片 / 备注 / 加入错题本 / 删除
//   · 解答下面只有一行操作栏：检查 · 思路 · 提问（problem-tools.tsx）
//   · 小题（isPart）：头部只写 `a)`，题干只有本小题 —— 大题题干和原卷截图在外层的大题卡上
//
// 题干可编辑：多模态转录也可能漏字，用户必须能改。
// ============================================================

import { useEffect, useRef, useState } from 'react';
import type { AskTurnView, ProblemView } from './api.ts';
import { AnswerEditor } from './answer-editor.tsx';
import type { ApproachResult } from './approach-panel.tsx';
import type { ComputeResultView } from './compute-panel.tsx';
import { CheckPanel } from './check-panel.tsx';
import { MathText } from './math.tsx';
import { Menu } from './menu.tsx';
import { nextPageView, PageFigure, type PageView } from './page-figure.tsx';
import { ProblemTools, type AskResult } from './problem-tools.tsx';
import { useT } from './i18n.ts';

const STATUS_KEY: Record<string, string> = {
  todo: 'exercise.problem.status.todo',
  draft: 'exercise.problem.status.draft',
  answered: 'exercise.problem.status.answered',
  checked: 'exercise.problem.status.checked',
  needs_fix: 'exercise.problem.status.needs_fix',
  done: 'exercise.common.done',
};

export function statusLabel(t: (key: string) => string, status: string): string {
  const key = STATUS_KEY[status];
  return key ? t(key) : status;
}

export interface ProblemCardProps {
  problem: ProblemView;
  /** 小题：头部只写 `a)`；大题题干与原卷截图由外层的大题卡负责 */
  isPart?: boolean;
  /** 原题截图 URL（没有页面图片 → undefined） */
  pageImageUrl?: string;
  onSave: (patch: { answer?: string; notes?: string; text?: string; title?: string; points?: number | null }) => Promise<void>;
  onCheck: () => void;
  /** 答辩：把学生的话发给模型（重新推导后承认或坚持） */
  onRebuttal: (text: string) => Promise<void>;
  /** 思路检查（可重复、临时，不落盘） */
  onApproach?: () => Promise<ApproachResult & { ok: boolean; error?: string }>;
  /** 提问（苏格拉底式提示，临时） */
  onAsk?: (question: string, history: AskTurnView[]) => Promise<AskResult>;
  /** 「计算 =」：算答案里以 = 结尾的式子（计算器，不解题） */
  onCompute?: (draft: string) => Promise<ComputeResultView>;
  /** 按 a) b) 拆成小题（独立题才有） */
  onSplitParts?: () => void;
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
  isPart = false,
  pageImageUrl,
  onSave,
  onCheck,
  onRebuttal,
  onApproach,
  onAsk,
  onCompute,
  onSplitParts,
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
  // 带图的题默认展开；收起后原地留一行，随时点开（见 page-figure.tsx）
  const [pageView, setPageView] = useState<PageView>(problem.has_figure && !isPart ? 'open' : 'hidden');
  const [showNotes, setShowNotes] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // 题干可能在外面变（重新分块 / agent 改过）：没在编辑时跟上，否则点"保存"会写回旧文本
  useEffect(() => {
    if (!editing) setText(problem.text);
  }, [problem.text, editing]);

  const status = problem.status;
  const page = problem.page || 1;

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

  const label = isPart ? `${problem.part ?? ''})` : problem.label || problem.id;

  return (
    <div className="lec-problem" data-state={status} data-part={isPart ? '1' : '0'} id={`lec-problem-${problem.id}`}>
      <div className="lec-problem-head">
        <span className="lec-problem-no">{label}</span>
        {problem.points != null && <span className="lec-badge" data-kind="points">{problem.points} P</span>}
        <span className="lec-badge" data-kind={status}>{statusLabel(t, status)}</span>
        {problem.has_figure && !isPart && <span className="lec-badge" data-kind="figure">{t('exercise.problem.hasFigure')}</span>}
        {problem.answer_edited_by === 'agent' && <span className="lec-badge">{t('exercise.problem.agentEdited')}</span>}
        {problem.title && !isPart && <span className="lec-problem-title">{problem.title}</span>}
        <span className="lec-problem-actions">
          {pageImageUrl && !isPart ? (
            <button
              type="button"
              className="lec-chip"
              data-open={pageView === 'open' ? '1' : '0'}
              title={pageView === 'open' ? t('exercise.problem.hidePage') : t('exercise.problem.showPage', { page })}
              onClick={() => setPageView(nextPageView)}
            >
              {pageView === 'open' ? '▾ ' : '▸ '}
              {t('exercise.problem.pageChip', { page })}
            </button>
          ) : null}
          <Menu
            title={t('exercise.common.more')}
            items={[
              { label: editing ? t('exercise.problem.cancelEdit') : t('exercise.problem.edit'), onSelect: () => setEditing((v) => !v) },
              !isPart && onSplitParts
                ? { label: t('exercise.problem.splitParts'), title: t('exercise.problem.splitPartsTitle'), onSelect: onSplitParts }
                : null,
              onAttachImage ? { label: t('exercise.problem.addImage'), title: t('exercise.answer.imageHint'), onSelect: () => fileRef.current?.click() } : null,
              { label: showNotes ? t('exercise.problem.hideNotes') : t('exercise.problem.notes'), onSelect: () => setShowNotes((v) => !v) },
              { label: t('exercise.answer.collectMistake'), onSelect: onCollectMistake },
              {
                label: t('exercise.problem.deleteTitle'),
                danger: true,
                onSelect: () => {
                  if (window.confirm(t('exercise.problem.deleteConfirm', { label: problem.label || problem.id }))) onDelete();
                },
              },
            ]}
          />
        </span>
        {onAttachImage ? (
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) void onAttachImage(file);
            }}
          />
        ) : null}
      </div>

      {editing ? (
        <div>
          <textarea className="lec-textarea" value={text} onChange={(e) => setText(e.currentTarget.value)} spellCheck={false} />
          <div className="lec-toolrow">
            <button type="button" className="lec-btn" onClick={() => void saveText()} disabled={savingText}>
              {savingText ? t('exercise.common.saving') : t('exercise.problem.save')}
            </button>
            <button type="button" className="lec-btn lec-btn-ghost" onClick={() => setEditing(false)}>
              {t('exercise.common.cancel')}
            </button>
            <span className="lec-hint" style={{ margin: 0 }}>
              {t('exercise.problem.editHint')}
            </span>
          </div>
        </div>
      ) : problem.text.trim() ? (
        <div className="lec-statement">
          <MathText text={problem.text} compact />
        </div>
      ) : isPart ? null : (
        <div className="lec-statement">
          <span className="lec-hint">{t('exercise.problem.missingText')}</span>
        </div>
      )}

      {problem.figure_note && !isPart && <div className="lec-fignote">{t('exercise.problem.figureNote', { note: problem.figure_note })}</div>}

      {pageImageUrl && pageView !== 'hidden' && !isPart && (
        <PageFigure
          url={pageImageUrl}
          page={page}
          figure={problem.has_figure}
          open={pageView === 'open'}
          onToggle={() => setPageView(nextPageView)}
        />
      )}

      <AnswerEditor
        problem={problem}
        onSave={onSave}
        onToast={onToast}
        busy={busy}
        onAttachImage={onAttachImage}
        onDeleteImage={onDeleteImage}
        imageUrl={imageUrl}
        compact
        showNotes={showNotes}
        onCompute={onCompute}
      />

      <ProblemTools
        problem={problem}
        busy={busy}
        onCheck={onCheck}
        onApproach={onApproach}
        onAsk={onAsk}
        onToast={onToast}
        extra={
          mistakeCount > 0 ? (
            <span className="lec-hint" style={{ margin: 0 }} title={t('exercise.problem.inMistakes', { n: mistakeCount })}>
              {t('exercise.problem.inMistakesShort', { n: mistakeCount })}
            </span>
          ) : null
        }
      />

      <CheckPanel problem={problem} onRecheck={onCheck} onRebuttal={onRebuttal} busy={busy} />
    </div>
  );
}
