// ============================================================
// client/answer-editor.tsx — 答案编辑区（**边写边渲染 LaTeX**）
//
// 用户要求：
//   ① "输入框最好也要能渲染 LaTeX，否则做题的时候眼花缭乱的"
//   ② "符号键盘也要可以点击后注入当前输入框，复制功能也保留"
//
// ① 的做法：输入框与渲染结果**左右并排**（.lec-editor），滚动同步；
//    另外两个模式——「只写」（不要预览）和「只读渲染」（看排好版的结果）。
//    为什么不做"输入框内直接排版"：textarea 里没法渲染 KaTeX，真 WYSIWYG 需要
//    contentEditable，光标/撤销/中文输入法/公式边界都会崩 —— 分栏是稳妥且好用的折中。
//
// ② 的做法：每个编辑器把自己的 inserter 注册成"当前活动目标"（focus 时设、blur 时清），
//    符号面板点击时 **preventDefault**（不抢焦点），于是按钮点下去仍然插到光标处；
//    没有活动编辑器时退回"复制到剪贴板"（lecture 的老行为，保留）。
//
// 保存：900ms 防抖 + 失焦；答案一改，host 会把旧检查标 stale（D6）。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProblemView } from './api.ts';
import { MathText } from './math.tsx';

export type Inserter = (text: string, caretOffset: number) => boolean;

/** 当前聚焦的答案编辑器（跨组件：符号面板点一下要能插到"正在写的那个框"）。 */
let activeInserter: Inserter | null = null;

export function setActiveInserter(fn: Inserter | null): void {
  activeInserter = fn;
  // 调试/自检用：DOM 上留一个标记，headless 探针能看出"当前有没有活动编辑器"
  if (typeof document !== 'undefined') {
    if (fn) document.body.dataset.exActiveEditor = '1';
    else delete document.body.dataset.exActiveEditor;
  }
}

export function getActiveInserter(): Inserter | null {
  return activeInserter;
}

/** 符号面板调用：插到活动编辑器；没有就返回 false（调用方退回复制）。 */
export function insertIntoActiveEditor(text: string, caretOffset: number): boolean {
  const fn = activeInserter;
  if (!fn) return false;
  try {
    return fn(text, caretOffset);
  } catch {
    return false;
  }
}

export interface AnswerEditorProps {
  problem: ProblemView;
  onSave: (patch: { answer?: string; notes?: string }) => Promise<void>;
  onCheck: () => void;
  onCollectMistake: () => void;
  onToast: (msg: string) => void;
  busy?: boolean;
}

const SAVE_DEBOUNCE_MS = 900;

type EditorMode = 'split' | 'write' | 'render';

export function AnswerEditor({
  problem,
  onSave,
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
  const [mode, setMode] = useState<EditorMode>('split');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const pending = useRef<{ answer?: string; notes?: string }>({});
  const dirtyRef = useRef(false);
  const selfRef = useRef<Inserter | null>(null);

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
      if (activeInserter === selfRef.current) activeInserter = null;
    };
  }, [problem.id, onSave]);

  /** 注册"插入到光标处"的能力（focus 时成为活动目标）。 */
  const makeInserter = useCallback((): Inserter => {
    return (text: string, caretOffset: number): boolean => {
      const ta = taRef.current;
      if (!ta) return false;
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
    };
  }, [schedule]);

  useEffect(() => {
    selfRef.current = makeInserter();
    return () => {
      selfRef.current = null;
    };
  }, [makeInserter]);

  // 输入框滚动 → 预览同步滚动（两边行数不一样，按比例对齐就够用）
  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    const pv = previewRef.current;
    if (!ta || !pv) return;
    const max = ta.scrollHeight - ta.clientHeight;
    if (max <= 0) return;
    const ratio = ta.scrollTop / max;
    pv.scrollTop = ratio * Math.max(0, pv.scrollHeight - pv.clientHeight);
  }, []);

  const savedLabel = saving ? '保存中…' : dirty ? '未保存' : savedAt ? '已保存' : '';

  return (
    <div>
      <div className="lec-answer-head">
        <span>我的解答</span>
        <span className="lec-saved">{savedLabel}</span>
        <span className="lec-grow" />
        <div className="lec-toolrow" style={{ marginTop: 0 }}>
          <button type="button" className="lec-tab" data-active={mode === 'split' ? '1' : '0'} onClick={() => setMode('split')}>
            分栏
          </button>
          <button type="button" className="lec-tab" data-active={mode === 'write' ? '1' : '0'} onClick={() => setMode('write')}>
            只写
          </button>
          <button type="button" className="lec-tab" data-active={mode === 'render' ? '1' : '0'} onClick={() => setMode('render')}>
            只看渲染
          </button>
        </div>
      </div>

      <div className="lec-editor" data-mode={mode}>
        <textarea
          ref={taRef}
          className="lec-textarea"
          value={draft}
          placeholder="写下推导（可直接写 LaTeX：行内 $F=ma$，独立一行 $$...$$）。右边实时排版 —— 写错了也没关系，检查是给你看的，不是判分。"
          onChange={(e) => {
            const v = e.currentTarget.value;
            setDraft(v);
            schedule({ answer: v });
          }}
          onScroll={syncScroll}
          onFocus={() => setActiveInserter(selfRef.current)}
          onBlur={() => {
            setActiveInserter(null);
            void flush();
          }}
          spellCheck={false}
        />
        <div className="lec-preview-pane" ref={previewRef}>
          {draft.trim() ? <MathText text={draft} /> : null}
        </div>
      </div>

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
