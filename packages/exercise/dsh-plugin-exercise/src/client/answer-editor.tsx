// ============================================================
// client/answer-editor.tsx — 答案编辑区（**边写边渲染 LaTeX**）
//
// 用户要求：
//   ① "输入框最好也要能渲染 LaTeX，否则做题的时候眼花缭乱的"
//   ② "符号键盘也要可以点击后注入当前输入框，复制功能也保留"
//
// ① 的做法：输入框与渲染结果**左右并排**（.lec-editor），滚动同步；
//    另有「只写」和「只看渲染」两个模式。不做"输入框内直接排版"的原因：
//    textarea 里没法渲染 KaTeX，真 WYSIWYG 要 contentEditable，
//    光标/撤销/中文输入法/公式边界都会崩 —— 分栏是稳妥且好用的折中。
//
// ② 的做法（2026-10-20 修）：**按 DOM 元素登记**插入器（WeakMap），
//    focus 时把该 textarea 记为"当前目标"，点符号时先看活动元素、
//    再退回"最近聚焦的 textarea"。早先按函数身份登记 + 在每次 render 的
//    effect 清理里把 active 置空 —— 结果**只有第一次点进输入框能插入**，
//    之后 active 永远是 null（用户实测报的就是这个）。
//
// 保存：900ms 防抖 + 失焦；答案一改，host 会把旧检查标 stale（D6）。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProblemView } from './api.ts';
import { MathText } from './math.tsx';
import { useT, useLocale } from './i18n.ts';
import { hasMath } from '../math-parse.ts';
import { collectMathLiveReplacements, collectMathIssuesInText } from '../mathlive-compat.ts';

export type Inserter = (text: string, caretOffset: number) => boolean;

/** 每个 textarea 自己的插入实现（WeakMap：元素换/卸载自动失效，不需要手动清理）。 */
const inserters = new WeakMap<HTMLTextAreaElement, Inserter>();
/** 最近聚焦的答案框（符号面板在右栏，点按钮时它仍应是活动目标）。 */
let activeTextArea: HTMLTextAreaElement | null = null;

export function registerInserter(ta: HTMLTextAreaElement, fn: Inserter): void {
  inserters.set(ta, fn);
}

export function setActiveTextArea(ta: HTMLTextAreaElement | null): void {
  activeTextArea = ta;
  if (typeof document !== 'undefined') {
    if (ta) document.body.dataset.exActiveEditor = '1';
    else delete document.body.dataset.exActiveEditor;
  }
}

/**
 * 符号面板调用：插到当前答案框；返回 false 表示"没有可插入的目标"
 * （调用方退回复制到剪贴板）。
 */
export function insertIntoActiveEditor(text: string, caretOffset: number): boolean {
  const el =
    activeTextArea ??
    (typeof document !== 'undefined' && document.activeElement instanceof HTMLTextAreaElement
      ? document.activeElement
      : null);
  if (!el) return false;
  const fn = inserters.get(el);
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
  /** 可选：极简模式没有错题本，不传就不显示按钮 */
  onCollectMistake?: () => void;
  onToast: (msg: string) => void;
  busy?: boolean;
  /** 图片附件：上传（File → 后端存盘）/ 删除 / 取 URL */
  onAttachImage?: (file: File) => Promise<void>;
  onDeleteImage?: (imageId: string) => void;
  imageUrl?: (name: string) => string;
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
  onAttachImage,
  onDeleteImage,
  imageUrl,
}: AnswerEditorProps): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState(problem.answer);
  const [notes, setNotes] = useState(problem.notes);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [mode, setMode] = useState<EditorMode>('split');
  // 公式内容层面的提示（渲染期兼容 + 未知命令）
  const mathReplacements = useMemo(() => collectMathLiveReplacements(draft, locale === 'en' ? 'en' : 'zh'), [draft, locale]);
  const mathIssues = useMemo(() => collectMathIssuesInText(draft, locale === 'en' ? 'en' : 'zh'), [draft, locale]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const pending = useRef<{ answer?: string; notes?: string }>({});
  const dirtyRef = useRef(false);
  /** 让"稳定的插入器"始终调到最新的 schedule 实现（避免每次 render 重建插入器）。 */
  const scheduleRef = useRef<(patch: { answer?: string; notes?: string }) => void>(() => undefined);

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
      onToast(t('exercise.common.saveFailed', { error: (e as Error).message }));
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
  scheduleRef.current = schedule;

  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void onSave(pending.current).catch(() => undefined);
      }
      const ta = taRef.current;
      if (ta && activeTextArea === ta) setActiveTextArea(null);
    };
  }, [onSave]);

  /**
   * 插入器只建一次（依赖全在 ref 里）：读 textarea 的真实值/选区，
   * 写回 React 状态并恢复光标。稳定身份 → WeakMap 里的登记永远有效。
   */
  const inserterRef = useRef<Inserter>((text, caretOffset) => {
    const ta = taRef.current;
    if (!ta) return false;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const next = `${ta.value.slice(0, start)}${text}${ta.value.slice(end)}`;
    setDraft(next);
    scheduleRef.current({ answer: next });
    const caret = start + Math.max(0, Math.min(caretOffset, text.length));
    window.requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
    return true;
  });

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    registerInserter(ta, inserterRef.current);
    return () => {
      // 元素卸载后 WeakMap 自然释放；只需保证活动目标不指向已卸载元素
      if (activeTextArea === ta) setActiveTextArea(null);
    };
  }, []);

  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    const pv = previewRef.current;
    if (!ta || !pv) return;
    const max = ta.scrollHeight - ta.clientHeight;
    if (max <= 0) return;
    pv.scrollTop = (ta.scrollTop / max) * Math.max(0, pv.scrollHeight - pv.clientHeight);
  }, []);

  const savedLabel = saving
    ? t('exercise.common.saving')
    : dirty
      ? t('exercise.common.unsaved')
      : savedAt
        ? t('exercise.common.saved')
        : '';

  return (
    <div>
      <div className="lec-answer-head">
        <span>{t('exercise.answer.heading')}</span>
        <span className="lec-saved">{savedLabel}</span>
        <span className="lec-grow" />
        <div className="lec-toolrow" style={{ marginTop: 0 }}>
          <button type="button" className="lec-tab" data-active={mode === 'split' ? '1' : '0'} onClick={() => setMode('split')}>
            {t('exercise.answer.mode.split')}
          </button>
          <button type="button" className="lec-tab" data-active={mode === 'write' ? '1' : '0'} onClick={() => setMode('write')}>
            {t('exercise.answer.mode.write')}
          </button>
          <button type="button" className="lec-tab" data-active={mode === 'render' ? '1' : '0'} onClick={() => setMode('render')}>
            {t('exercise.answer.mode.render')}
          </button>
        </div>
      </div>

      <div className="lec-editor" data-mode={mode}>
        <textarea
          ref={taRef}
          className="lec-textarea"
          value={draft}
          placeholder={t('exercise.answer.placeholder')}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setDraft(v);
            schedule({ answer: v });
          }}
          onScroll={syncScroll}
          onFocus={(e) => setActiveTextArea(e.currentTarget)}
          onBlur={(e) => {
            // 点符号时按钮 mousedown 已 preventDefault，不会走到这里；
            // 走到这里就是真的离开了 → 清掉活动目标
            if (activeTextArea === e.currentTarget) setActiveTextArea(null);
            void flush();
          }}
          spellCheck={false}
        />
        <div className="lec-preview-pane" ref={previewRef}>
          {draft.trim() ? <MathText text={draft} /> : null}
          {(problem.images ?? []).filter((i) => i.role !== 'problem').length > 0 && (
            <div className="lec-figure-strip">
              {(problem.images ?? []).filter((i) => i.role !== 'problem').map((img) => (
                <figure key={img.id} className="lec-figure">
                  <img src={imageUrl?.(img.name)} alt={img.caption || img.name} loading="lazy" />
                  {img.caption ? <figcaption>{img.caption}</figcaption> : null}
                  {onDeleteImage ? (
                    <button type="button" className="lec-figure-del" title={t('exercise.answer.deleteImageTitle')} onClick={() => onDeleteImage(img.id)}>
                      ×
                    </button>
                  ) : null}
                </figure>
              ))}
            </div>
          )}
        </div>
      </div>

      {onAttachImage ? (
        <div className="lec-toolrow" style={{ marginTop: 6 }}>
          <label className="lec-btn lec-btn-ghost" style={{ cursor: 'pointer', margin: 0 }}>
            {t('exercise.answer.addImage')}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (file) void onAttachImage(file);
              }}
            />
          </label>
          <span className="lec-hint">{t('exercise.answer.imageHint')}</span>
        </div>
      ) : null}

      {draft.trim() && !hasMath(draft) && /\\[A-Za-z]+/.test(draft) && (
        <div className="lec-hint" style={{ marginTop: 6 }}>
          {t('exercise.answer.rawCmd.lead')} <code>{t('exercise.answer.rawCmd.code')}</code> {t('exercise.answer.rawCmd.mid')}{' '}
          <code>$…$</code> {t('exercise.answer.rawCmd.tail')}
        </div>
      )}

      {/* 公式内容层面的问题（这条与上一条分工不同：上一行是"没认成公式"，这里是"认成了但内容错"） */}
      {mathReplacements.length > 0 && (
        <div className="lec-hint" style={{ marginTop: 6 }}>
          {t('exercise.answer.mathlive.lead')}
          {mathReplacements.map((r) => (
            <span key={r.from}>
              {' '}
              <code>{r.from}</code> → <code>{r.to}</code>
            </span>
          ))}
          {mathReplacements.some((r) => r.note) && (
            <>
              <br />
              {mathReplacements
                .filter((r) => r.note)
                .map((r) => r.note)
                .join(t('exercise.common.listSep'))}
            </>
          )}
        </div>
      )}
      {mathIssues.length > 0 && (
        <div className="lec-warn" style={{ marginTop: 6, fontWeight: 400 }}>
          {t('exercise.answer.katexError.lead')}
          {mathIssues.map((i) => (
            <div key={i.command} style={{ marginTop: 2 }}>
              <code>{i.command}</code>
              {i.position > 0 ? t('exercise.answer.katexError.position', { pos: i.position }) : ''} —— {i.hint}
            </div>
          ))}
        </div>
      )}

      <div className="lec-toolrow">
        <button type="button" className="lec-btn" onClick={onCheck} disabled={busy}>
          {busy ? t('exercise.check.busy') : t('exercise.answer.check')}
        </button>
        {onCollectMistake ? (
          <button type="button" className="lec-btn lec-btn-ghost" onClick={onCollectMistake}>
            {t('exercise.answer.collectMistake')}
          </button>
        ) : null}
        <span className="lec-grow" />
        <input
          className="lec-input"
          style={{ width: 220 }}
          placeholder={t('exercise.answer.notesPlaceholder')}
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
