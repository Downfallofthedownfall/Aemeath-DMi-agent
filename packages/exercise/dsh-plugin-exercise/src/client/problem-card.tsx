// ============================================================
// client/problem-card.tsx — 一道题的卡片（题干 + 解答 + 检查）
//
// 外观照 lecture 的笔记卡（.lec-problem 用的是同一批 --aem-* token）：
//   卡片圆角/阴影/边框与课堂笔记一致；题干放进 .lec-statement（自己滚，
//   长题不会把解答框顶出屏幕）；状态用 .lec-badge[data-kind] 表达。
//
// 题干可编辑：PDF 抽文本对公式为主的作业并不可靠，用户必须能改/补；
// 改完可以「LLM 重新分块」（按题号保留已写答案）。
// ============================================================

import { useState } from 'react';
import type { ProblemView } from './api.ts';
import { AnswerEditor, type Inserter } from './answer-editor.tsx';
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
  onSave: (patch: { answer?: string; notes?: string; text?: string; title?: string; points?: number | null }) => Promise<void>;
  onCheck: () => void;
  onCollectMistake: () => void;
  onDelete: () => void;
  registerInserter: (fn: Inserter) => void;
  onToast: (msg: string) => void;
  busy: boolean;
  mistakeCount: number;
}

export function ProblemCard({
  problem,
  onSave,
  onCheck,
  onCollectMistake,
  onDelete,
  registerInserter,
  onToast,
  busy,
  mistakeCount,
}: ProblemCardProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(problem.text);
  const [savingText, setSavingText] = useState(false);

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
            <span className="lec-hint">（题干缺失 —— 点「改题干」补上）</span>
          )}
        </div>
      )}

      <AnswerEditor
        problem={problem}
        onSave={onSave}
        registerInserter={registerInserter}
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

      <CheckPanel problem={problem} onRecheck={onCheck} busy={busy} />
    </div>
  );
}
