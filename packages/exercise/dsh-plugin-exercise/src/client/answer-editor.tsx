// ============================================================
// client/answer-editor.tsx — 答案编辑区
//
// 用户要求："写入的答案要可以修改"。所以这里是**永远可编辑的 textarea**：
//   · 每 900ms 或失焦自动保存
//   · 保存后 host 会重算 stale（旧检查失效），界面立刻显示"过期"
//   · 预览区实时渲染 markdown + KaTeX
//
// 外观与 lecture 的输入框同一套（.lec-textarea / .lec-preview / .lec-toolrow）。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProblemView } from './api.ts';
import { MathText } from './math.tsx';

export type Inserter = (text: string, caretOffset: number) => boolean;

export interface AnswerEditorProps {
  problem: ProblemView;
  onSave: (patch: { answer?: string; notes?: string }) => Promise<void>;
  registerInserter: (fn: Inserter) => void;
  onCheck: () => void;
  onCollectMistake: () => void;
  onToast: (msg: string) => void;
  busy?: boolean;
}

const SAVE_DEBOUNCE_MS = 900;

export function AnswerEditor({
  problem,
  onSave,
  registerInserter,
  onCheck,
  onCollectMistake,
  onToast,
  busy = false,
}: AnswerEditorProps): JSX.Element {
  const [draft, setDraft] = useState(problem.answer);
  const [notes, setNotes] = useState(problem.notes);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const timer = useRef<number | null>(null);
  const pending = useRef<{ answer?: string; notes?: string }>({});
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!dirtyRef.current) {
      setDraft(problem.answer);
      setNotes(problem.notes);
    }
  }, [problem.answer, problem.notes, problem.answer_updated_at]);

  const flush = useCallback(async (): Promise<void> => {
    if (!dirtyRef.current) return;
    const patch = pending.current;
    dirtyRef.current = false;
    setDirty(false);
    setSaving(true);
    try {
      await onSave(patch);
      setSavedAt(Date.now());
      pending.current = {};
    } catch (e) {
      dirtyRef.current = true;
      setDirty(true);
      onToast(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [onSave, onToast]);

  const schedule = useCallback(
    (patch: { answer?: string; notes?: string }) => {
      pending.current = { ...pending.current, ...patch };
      dirtyRef.current = true;
      setDirty(true);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void flush();
      }, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void onSave(pending.current).catch(() => undefined);
      }
    };
  }, [problem.id, onSave]);

  useEffect(() => {
    registerInserter((text, caretOffset) => {
      const ta = taRef.current;
      if (!ta || document.activeElement !== ta) return false;
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? start;
      const next = `${ta.value.slice(0, start)}${text}${ta.value.slice(end)}`;
      setDraft(next);
      schedule({ answer: next });
      const caret = start + Math.max(0, Math.min(caretOffset, text.length));
      window.requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
      return true;
    });
  }, [registerInserter, schedule]);

  const savedLabel = saving ? '保存中…' : dirty ? '未保存' : savedAt ? '已保存' : '';

  return (
    <div>
      <div className="lec-answer-head">
        <span>我的解答</span>
        <span className="lec-saved">{savedLabel}</span>
        <span className="lec-grow" />
        <button
          type="button"
          className="lec-btn lec-btn-ghost"
          onClick={() => setShowPreview((v) => !v)}
          title="切换公式预览（不影响保存的内容）"
        >
          {showPreview ? '隐藏预览' : '显示预览'}
        </button>
      </div>

      <textarea
        ref={taRef}
        className="lec-textarea"
        value={draft}
        placeholder="写下推导（可直接写 LaTeX：行内 $F=ma$，独立一行 $$...$$）。写错了也没关系 —— 检查是给你看的，不是判分。"
        onChange={(e) => {
          const v = e.currentTarget.value;
          setDraft(v);
          schedule({ answer: v });
        }}
        onBlur={() => void flush()}
        spellCheck={false}
      />

      {showPreview && draft.trim() && (
        <div className="lec-preview">
          <MathText text={draft} />
        </div>
      )}

      <div className="lec-toolrow">
        <button type="button" className="lec-btn" onClick={onCheck} disabled={busy}>
          {busy ? '检查中…' : '让爱弥斯检查这题'}
        </button>
        <button type="button" className="lec-btn lec-btn-ghost" onClick={onCollectMistake}>
          加入错题本
        </button>
        <span className="lec-grow" />
        <input
          className="lec-input"
          style={{ width: 220 }}
          placeholder="备注（这题我老忘什么）"
          value={notes}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setNotes(v);
            schedule({ notes: v });
          }}
          onBlur={() => void flush()}
        />
      </div>
    </div>
  );
}
