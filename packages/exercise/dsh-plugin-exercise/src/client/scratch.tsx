// ============================================================
// client/scratch.tsx — 极简模式（临时做题）
//
// 用户 2026-10-26："拓展一个极简模式用来临时做题，主界面里打开然后去掉各种提交功能，
//   方便临时做书上看到的题目，注意要保留做题和审答案所需的功能；
//   因为是临时的所以不需要多项目管理，有一个工作区然后可以手动 reset 就行了。"
//
// 保留：题目输入 / 答案编辑（LaTeX + 附图）/ 手动检查 / 答辩 / 检查历史 / 符号面板
// 去掉：课程与套题列表 / 导入 PDF / 重新分块 / 提交 PDF / 导出握手 / 导出文本 / 错题本 / worldbook
//
// 数据：后端 `_scratch` 工作区（一道题），自动保存；「重置」清空（含附图）。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProblemView, SheetView } from './api.ts';
import { API_BASE, apiGet, apiPost, fileToBase64 } from './api.ts';
import { AnswerEditor, insertIntoActiveEditor } from './answer-editor.tsx';
import { CheckPanel } from './check-panel.tsx';
import { SymbolPanel } from './symbol-palette.tsx';
import { useT } from './i18n.ts';

const SCRATCH_COURSE = '_scratch';
const SCRATCH_SHEET = 'ub01';
const SCRATCH_PROBLEM = 'p01';
const SAVE_DEBOUNCE_MS = 700;

export interface ScratchWorkspaceProps {
  onToast: (msg: string) => void;
}

export function ScratchWorkspace({ onToast }: ScratchWorkspaceProps): JSX.Element {
  const t = useT();
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedHint, setSavedHint] = useState<string>('');
  const timer = useRef<number | null>(null);

  const problem: ProblemView | null = sheet?.problems[0] ?? null;

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await apiGet<{ sheet: SheetView }>('scratch');
      setSheet(r.sheet);
      setText(r.sheet.problems[0]?.text ?? '');
    } catch (e) {
      onToast(t('exercise.scratch.loadFailed', { error: (e as Error).message }));
    }
  }, [onToast, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 题目文本：本地即时、700ms 防抖落盘
  const scheduleText = (value: string): void => {
    setText(value);
    setSavedHint(t('exercise.scratch.saving'));
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await apiPost<{ sheet: SheetView }>('update_problem', {
            course_id: SCRATCH_COURSE,
            sheet_id: SCRATCH_SHEET,
            problem_id: SCRATCH_PROBLEM,
            patch: { text: value },
          });
          setSheet(r.sheet);
          setSavedHint(t('exercise.scratch.savedAt'));
        } catch (e) {
          onToast((e as Error).message);
        }
      })();
    }, SAVE_DEBOUNCE_MS);
  };

  const saveProblem = async (patch: { answer?: string; notes?: string }): Promise<void> => {
    const r = await apiPost<{ sheet: SheetView }>('update_problem', {
      course_id: SCRATCH_COURSE,
      sheet_id: SCRATCH_SHEET,
      problem_id: SCRATCH_PROBLEM,
      patch,
    });
    setSheet(r.sheet);
  };

  const runCheck = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiPost<{ sheet: SheetView }>('check', {
        course_id: SCRATCH_COURSE,
        sheet_id: SCRATCH_SHEET,
        problem_id: SCRATCH_PROBLEM,
      });
      setSheet(r.sheet);
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runRebuttal = async (userText: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiPost<{ sheet: SheetView }>('rebut', {
        course_id: SCRATCH_COURSE,
        sheet_id: SCRATCH_SHEET,
        problem_id: SCRATCH_PROBLEM,
        text: userText,
      });
      setSheet(r.sheet);
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const attachImage = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const base64 = await fileToBase64(file);
      const r = await apiPost<{ sheet: SheetView }>('add_attachment', {
        course_id: SCRATCH_COURSE,
        sheet_id: SCRATCH_SHEET,
        problem_id: SCRATCH_PROBLEM,
        base64,
        caption: file.name.replace(/\.[a-z0-9]+$/i, ''),
      });
      setSheet(r.sheet);
      onToast(t('exercise.wb.toast.imageAttached', { name: file.name }));
    } catch (e) {
      onToast(t('exercise.wb.toast.uploadFailed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const deleteImage = async (imageId: string): Promise<void> => {
    try {
      const r = await apiPost<{ sheet: SheetView }>('delete_attachment', {
        course_id: SCRATCH_COURSE,
        sheet_id: SCRATCH_SHEET,
        problem_id: SCRATCH_PROBLEM,
        image_id: imageId,
      });
      setSheet(r.sheet);
    } catch (e) {
      onToast((e as Error).message);
    }
  };

  const reset = async (): Promise<void> => {
    if (!window.confirm(t('exercise.scratch.resetConfirm'))) return;
    setBusy(true);
    try {
      const r = await apiPost<{ sheet: SheetView }>('reset_scratch', {});
      setSheet(r.sheet);
      setText('');
      setSavedHint('');
      onToast(t('exercise.scratch.resetDone'));
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const imageUrl = (name: string): string =>
    `${API_BASE}?action=attachment&course=${encodeURIComponent(SCRATCH_COURSE)}&sheet=${encodeURIComponent(
      SCRATCH_SHEET,
    )}&name=${encodeURIComponent(name)}`;

  return (
    <div className="lec-scratch">
      <div className="lec-scratch-head">
        <span className="lec-scratch-title">{t('exercise.scratch.title')}</span>
        <span className="lec-hint" style={{ margin: 0 }}>
          {t('exercise.scratch.hint')}
        </span>
        <span className="lec-grow" />
        {savedHint ? <span className="lec-saved">{savedHint}</span> : null}
        <button type="button" className="lec-btn lec-btn-ghost" onClick={() => void reset()} disabled={busy}>
          {t('exercise.scratch.reset')}
        </button>
      </div>

      <div className="lec-scratch-body">
        <div className="lec-scratch-main">
          {!problem ? (
            <div className="lec-empty">{t('exercise.common.loading')}</div>
          ) : (
            <>
              <div className="lec-scratch-problem">
                <div className="lec-answer-head">
                  <span>{t('exercise.scratch.problem')}</span>
                </div>
                <textarea
                  className="lec-textarea lec-scratch-input"
                  rows={5}
                  value={text}
                  placeholder={t('exercise.scratch.problemPlaceholder')}
                  onChange={(e) => scheduleText(e.currentTarget.value)}
                  spellCheck={false}
                />
              </div>

              <AnswerEditor
                problem={problem}
                onSave={saveProblem}
                onCheck={() => void runCheck()}
                onToast={onToast}
                busy={busy}
                onAttachImage={attachImage}
                onDeleteImage={(id) => void deleteImage(id)}
                imageUrl={imageUrl}
              />

              <CheckPanel
                problem={problem}
                onRecheck={() => void runCheck()}
                onRebuttal={runRebuttal}
                busy={busy}
              />
            </>
          )}
        </div>

        <aside className="lec-scratch-side">
          <SymbolPanel onInsert={insertIntoActiveEditor} onToast={onToast} />
        </aside>
      </div>
    </div>
  );
}
