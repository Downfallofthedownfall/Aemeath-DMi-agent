// ============================================================
// client/problem-card.tsx — 一道题的卡片（题干 + 解答 + 检查结果）
//
// 为什么题干也可编辑：
//   PDF 抽文本对**公式为主的题**并不可靠（LaTeX 的数学字体常常抽不出可读文本），
//   用户必须能补/改题干，否则整套流程在真机上第一张扫描版作业就卡死。
//   因此题干改动会落回 sheet.json（sheet.json 是唯一事实源），
//   并且可以随时用 source.md 重新拆题（resplit 会按题号保留已有答案）。
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
  const cardClass = status === 'needs_fix' ? 'ex-problem-card needs-fix' : status === 'checked' || status === 'done' ? 'ex-problem-card checked' : 'ex-problem-card';

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
    <div className={cardClass} id={`ex-problem-${problem.id}`}>
      <div className="ex-problem-head">
        <span className="ex-problem-label">{problem.label || problem.id}</span>
        {problem.points != null && <span className="ex-chip points">{problem.points} P</span>}
        <span className={`ex-chip ${status}`}>{STATUS_LABEL[status] ?? status}</span>
        {problem.page > 0 && <span className="ex-chip todo">原卷第 {problem.page} 页</span>}
        {problem.answer_edited_by === 'agent' && <span className="ex-chip accent">agent 代笔</span>}
        {problem.title && <span className="ex-problem-title">{problem.title}</span>}
        <span className="ex-problem-head-actions">
          <button type="button" className="ex-btn ex-btn-sm ex-btn-ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? '取消' : '改题干'}
          </button>
          <button
            type="button"
            className="ex-btn ex-btn-sm ex-btn-ghost"
            onClick={() => {
              if (window.confirm(`删除 ${problem.label || problem.id}？（答案与检查记录一并删除）`)) onDelete();
            }}
            title="删除这道题"
          >
            ✕
          </button>
        </span>
      </div>

      {editing ? (
        <div>
          <textarea className="ex-textarea" value={text} onChange={(e) => setText(e.currentTarget.value)} spellCheck={false} />
          <div className="ex-answer-tools">
            <button type="button" className="ex-btn ex-btn-primary ex-btn-sm" onClick={() => void saveText()} disabled={savingText}>
              {savingText ? '保存中…' : '保存题干'}
            </button>
            <span className="ex-saved">支持 markdown 与 $公式$</span>
          </div>
        </div>
      ) : (
        <div className="ex-problem-text">
          {problem.text.trim() ? <MathText text={problem.text} compact /> : <span className="ex-empty">（题干缺失 —— 点「改题干」补上）</span>}
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
        <div className="ex-check-history" style={{ marginTop: 8 }}>
          已加入错题本（{mistakeCount} 条记录）—— 可在右栏「错题本」补写教训。
        </div>
      )}

      <CheckPanel problem={problem} onRecheck={onCheck} busy={busy} />
    </div>
  );
}
