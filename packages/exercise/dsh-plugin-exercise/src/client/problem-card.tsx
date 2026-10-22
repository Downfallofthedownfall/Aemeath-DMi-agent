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
import { CheckPanel } from './check-panel.tsx';
import { MathText } from './math.tsx';

const STATUS_LABEL: Record<string, string> = {
  todo: '未作答',
  draft: '草稿',
  answered: '已作答',
  checked: '检查通过',
  needs_fix: '待修',
  done: '完成',
};

export interface ProblemCardProps {
  problem: ProblemView;
  /** 原题截图 URL（没有页面图片 → undefined） */
  pageImageUrl?: string;
  onSave: (patch: { answer?: string; notes?: string; text?: string; title?: string; points?: number | null }) => Promise<void>;
  onCheck: () => void;
  /** 答辩：把学生的话发给爱弥斯（重新推导后承认或坚持） */
  onRebuttal: (text: string) => Promise<void>;
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
  onCollectMistake,
  onDelete,
  onToast,
  busy,
  mistakeCount,
}: ProblemCardProps): JSX.Element {
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
      onToast('题干已更新');
    } catch (e) {
      onToast(`保存失败：${(e as Error).message}`);
    } finally {
      setSavingText(false);
    }
  };

  return (
    <div className="lec-problem" data-state={status} id={`lec-problem-${problem.id}`}>
      <div className="lec-problem-head">
        <span className="lec-problem-no">{problem.label || problem.id}</span>
        {problem.points != null && <span className="lec-badge" data-kind="points">{problem.points} P</span>}
        <span className="lec-badge" data-kind={status}>{STATUS_LABEL[status] ?? status}</span>
        {problem.has_figure && <span className="lec-badge" data-kind="figure">含图</span>}
        {problem.page > 0 && <span className="lec-badge" data-kind="todo">原卷第 {problem.page} 页</span>}
        {problem.answer_edited_by === 'agent' && <span className="lec-badge">agent 代笔</span>}
        {problem.title && <span className="lec-problem-title">{problem.title}</span>}
        <span className="lec-problem-actions">
          <button type="button" className="lec-btn lec-btn-ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? '取消' : '改题干'}
          </button>
          <button
            type="button"
            className="lec-del"
            title="删除这道题"
            onClick={() => {
              if (window.confirm(`删除 ${problem.label || problem.id}？（答案与检查记录一并删除）`)) onDelete();
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
              {savingText ? '保存中…' : '保存题干'}
            </button>
            <span className="lec-hint" style={{ margin: 0 }}>
              支持 markdown 与 $公式$
            </span>
          </div>
        </div>
      ) : (
        <div className="lec-statement">
          {problem.text.trim() ? (
            <MathText text={problem.text} compact />
          ) : (
            <span className="lec-hint">（题干缺失 —— 点「改题干」补上，或看下面的原题截图）</span>
          )}
        </div>
      )}

      {problem.figure_note && <div className="lec-fignote">图注：{problem.figure_note}</div>}

      {pageImageUrl && (
        <div className="lec-pagefig" data-figure={problem.has_figure ? '1' : '0'}>
          <div className="lec-toolrow" style={{ marginTop: 4 }}>
            <button type="button" className="lec-btn lec-btn-ghost" onClick={() => setShowPage((v) => !v)}>
              {showPage ? '收起原题截图' : `原题截图（第 ${problem.page || 1} 页）`}
            </button>
            <a className="lec-btn lec-btn-ghost" href={pageImageUrl} target="_blank" rel="noreferrer">
              新窗口打开
            </a>
          </div>
          {showPage && (
            <div className="lec-pageimg">
              <img src={pageImageUrl} alt={`原卷第 ${problem.page || 1} 页`} loading="lazy" />
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
      />

      {mistakeCount > 0 && (
        <div className="lec-hint" style={{ marginTop: 8 }}>
          已加入错题本（{mistakeCount} 条记录）—— 右栏「错题本」里补写教训。
        </div>
      )}

      <CheckPanel problem={problem} onRecheck={onCheck} onRebuttal={onRebuttal} busy={busy} />
    </div>
  );
}
