// ============================================================
// client/answer-editor.tsx — 答案编辑区
//
// 用户要求："写入的答案要可以修改"。所以这里是**永远可编辑的 textarea**，
// 没有"提交锁定"状态：
//   · 每 900ms 或失焦自动保存（不会因为切窗口丢草稿）
//   · 保存后 host 会重新算 stale（旧检查失效），界面立刻显示"过期"提示
//   · 预览区实时渲染 markdown + KaTeX（所见即所得的公式）
//
// 为什么用 textarea 而不是富文本/MathLive 编辑器：
//   · 答案的正文是**给助教看的推导**（多行、混排公式），不是单个公式框
//   · textarea 的撤销/粘贴/输入法行为最可靠（中文输入法在 rich text 里最容易出问题）
//   · 公式用 `$...$` 手写 + 下方实时预览，比"点开公式编辑器"快得多
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProblemView } from './api.ts';
import { MathText } from './math.tsx';

/** 插入器签名：把文本插到光标处（返回 false = 当前没有聚焦的编辑器）。 */
export type Inserter = (text: string, caretOffset: number) => boolean;

export interface AnswerEditorProps {
  problem: ProblemView;
  onSave: (patch: { answer?: string; notes?: string }) => Promise<void>;
  /** 注册"把符号插到光标处"的能力（符号面板会调用它）。 */
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

  // 外部（agent 写入 / 服务端刷新）改了答案且本地没有未保存改动 → 同步过来
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

  // 卸载/切题时把没保存的写回去（切题最容易丢草稿）
  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void onSave(pending.current).catch(() => undefined);
      }
    };
  }, [problem.id, onSave]);

  // 注册光标插入
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
      <div className="ex-answer-head">
        <span>我的解答</span>
        <span className="ex-saved">{savedLabel}</span>
        <span className="ex-topbar-spacer" />
        <button
          type="button"
          className="ex-btn ex-btn-sm ex-btn-ghost"
          onClick={() => setShowPreview((v) => !v)}
          title="切换公式预览（不影响保存的内容）"
        >
          {showPreview ? '隐藏预览' : '显示预览'}
        </button>
      </div>

      <textarea
        ref={taRef}
        className="ex-textarea"
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
        <div className="ex-answer-preview">
          <MathText text={draft} />
        </div>
      )}

      <div className="ex-answer-tools">
        <button type="button" className="ex-btn ex-btn-primary ex-btn-sm" onClick={onCheck} disabled={busy}>
          {busy ? '检查中…' : '让爱弥斯检查这题'}
        </button>
        <button type="button" className="ex-btn ex-btn-sm" onClick={onCollectMistake}>
          加入错题本
        </button>
        <span className="ex-spacer" />
        <input
          className="ex-input"
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
