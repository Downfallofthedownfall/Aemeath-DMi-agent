// ============================================================
// client/workbench.tsx — 习题工作台
//
// **骨架照抄 lecture**（用户定案："前端有点丑，照抄 lecture 的前端就行"）：
//   .lec-top 顶栏 / .lec-wb 三栏 / .lec-wb-nav 左栏 / .lec-wb-main 中栏（自己滚动）
//   / .lec-wb-side 右栏（.lec-sidetabs + .lec-sidebody）
// 类名沿用 lecture 的 lec-*（样式表是整份搬过来的，见 styles.ts 头注释）。
//
// 与 lecture 的差别只在**内容**：这里的主对象是一道一道的题，
// 所以中栏是"套题头 + 题卡列表"，右栏是"符号 / 错题本 / 经验 / 进度"。
//
// 滚动：中栏滚动交给 .lec-wb-scroll（flex:1 + overflow-y:auto），
// 题干再长也只在 .lec-statement 里自己滚（max-height 34vh）——
// 这样解答框永远在视野里（真机反馈过"内容太长翻不下去"）。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  API_BASE,
  ApiError,
  apiGet,
  apiPost,
  type CourseView,
  type DigestView,
  type MistakeView,
  type SheetMetaView,
  type SheetView,
} from './api.ts';
import { ProblemCard } from './problem-card.tsx';
import { MistakesPanel } from './mistakes-panel.tsx';
import { SymbolPanel } from './symbol-palette.tsx';
import { ImportDialog } from './import-dialog.tsx';
import { ScratchWorkspace } from './scratch.tsx';
import { insertIntoActiveEditor } from './answer-editor.tsx';
import { MathText } from './math.tsx';
import { EX_CLASS } from './styles.ts';
import { t as translate, useT } from './i18n.ts';
import { verdictLabel } from './check-panel.tsx';

type Tab = 'symbols' | 'mistakes' | 'lessons' | 'progress';
type Translate = (key: string, params?: Record<string, unknown>) => string;

export interface WorkbenchProps {
  onClose: () => void;
  standalone?: boolean;
}

function dueText(t: Translate, m: SheetMetaView): string {
  if (m.due_in_days == null) return '';
  if (m.due_in_days < 0) return t('exercise.wb.due.overdue', { n: -m.due_in_days });
  if (m.due_in_days === 0) return t('exercise.wb.due.today');
  return t('exercise.wb.due.inDays', { n: m.due_in_days });
}

/** File → base64（不带 data: 前缀；后端自己嗅探格式）。 */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(translate('exercise.common.readFileFailed')));
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s);
    };
    reader.readAsDataURL(file);
  });
}
export function Workbench({ onClose, standalone = false }: WorkbenchProps): JSX.Element {
  const t = useT();
  const [courses, setCourses] = useState<CourseView[]>([]);
  const [courseId, setCourseId] = useState('');
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [mistakes, setMistakes] = useState<MistakeView[]>([]);
  const [digest, setDigest] = useState<DigestView | null>(null);
  const [tab, setTab] = useState<Tab>('symbols');
  const [toast, setToast] = useState('');
  const [busyProblem, setBusyProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lessonDraft, setLessonDraft] = useState('');
  const [printUrl, setPrintUrl] = useState('');
  const [navOpen, setNavOpen] = useState(true);
  // 极简模式：临时做题（一个工作区、无课程/提交功能），偏好记在 localStorage
  const [minimal, setMinimal] = useState<boolean>(() => {
    try {
      return localStorage.getItem('aemeath-exercise-minimal') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('aemeath-exercise-minimal', minimal ? '1' : '0');
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
  }, [minimal]);
  /** 每门课的折叠状态（`true` = 收起）；未记录的课按"当前选中那门展开"处理。 */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toastTimer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 4200);
  }, []);

  const loadCourses = useCallback(async (): Promise<CourseView[]> => {
    const r = await apiGet<{ courses: CourseView[] }>('courses');
    setCourses(r.courses);
    return r.courses;
  }, []);

  const loadMistakes = useCallback(async () => {
    const r = await apiGet<{ mistakes: MistakeView[] }>('mistakes');
    setMistakes(r.mistakes);
  }, []);

  const loadSheet = useCallback(async (cid: string, sid: string) => {
    const r = await apiGet<{ sheet: SheetView }>('sheet', { course: cid, sheet: sid });
    setSheet(r.sheet);
  }, []);

  const loadDigest = useCallback(async (cid: string) => {
    if (!cid) {
      setDigest(null);
      return;
    }
    const r = await apiGet<DigestView>('digest', { course: cid });
    setDigest({ digest: r.digest, stats: r.stats });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const list = await loadCourses();
        await loadMistakes();
        const first = list[0];
        if (first) {
          setCourseId(first.course_id);
          const pick = first.sheets.find((s) => !s.submitted) ?? first.sheets[first.sheets.length - 1] ?? null;
          if (pick) await loadSheet(first.course_id, pick.id);
          await loadDigest(first.course_id);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadCourses, loadMistakes, loadSheet, loadDigest]);

  const current = useMemo(() => courses.find((c) => c.course_id === courseId) ?? null, [courses, courseId]);

  /** 选套题（跨课程也能选：左栏列出全部课程，和 lecture 一样）。 */
  const selectSheet = async (cid: string, sid: string): Promise<void> => {
    setCourseId(cid);
    await loadSheet(cid, sid);
    setPrintUrl('');
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const refreshAfterWrite = async (): Promise<void> => {
    if (!courseId) return;
    await loadCourses();
    if (sheet) await loadSheet(courseId, sheet.id);
    await loadMistakes();
  };

  // ---------- 写操作 ----------

  const saveProblem = useCallback(
    async (problemId: string, patch: Record<string, unknown>): Promise<void> => {
      if (!courseId || !sheet) return;
      const r = await apiPost<{ sheet: SheetView; stale?: number }>('update_problem', {
        course_id: courseId,
        sheet_id: sheet.id,
        problem_id: problemId,
        patch,
      });
      setSheet(r.sheet);
      if (r.stale) showToast(t('exercise.wb.toast.answerUpdated', { n: r.stale }));
    },
    [courseId, sheet, showToast],
  );

  const checkProblem = async (problemId: string): Promise<void> => {
    if (!courseId || !sheet) return;
    setBusyProblem(problemId);
    try {
      const r = await apiPost<{ sheet: SheetView; check: { verdict: string } }>('check', {
        course_id: courseId,
        sheet_id: sheet.id,
        problem_id: problemId,
      });
      setSheet(r.sheet);
      await loadMistakes();
      showToast(t('exercise.wb.toast.checked', { verdict: verdictLabel(t, r.check.verdict) }));
    } catch (e) {
      showToast(t('exercise.wb.toast.checkFailed', { error: (e as Error).message }));
    } finally {
      setBusyProblem('');
    }
  };

  const collectMistake = async (problemId: string): Promise<void> => {
    if (!courseId || !sheet) return;
    try {
      await apiPost('collect_mistake', { course_id: courseId, sheet_id: sheet.id, problem_id: problemId });
      await refreshAfterWrite();
      showToast(t('exercise.wb.toast.collected'));
    } catch (e) {
      showToast(t('exercise.wb.toast.collectFailed', { error: (e as Error).message }));
    }
  };

  const addProblem = async (): Promise<void> => {
    if (!courseId || !sheet) return;
    try {
      const r = await apiPost<{ sheet: SheetView }>('add_problem', { course_id: courseId, sheet_id: sheet.id });
      setSheet(r.sheet);
    } catch (e) {
      showToast(t('exercise.wb.toast.addFailed', { error: (e as Error).message }));
    }
  };

  const deleteProblem = async (problemId: string): Promise<void> => {
    if (!courseId || !sheet) return;
    try {
      const r = await apiPost<{ sheet: SheetView }>('delete_problem', {
        course_id: courseId,
        sheet_id: sheet.id,
        problem_id: problemId,
      });
      setSheet(r.sheet);
    } catch (e) {
      showToast(t('exercise.common.deleteFailed', { error: (e as Error).message }));
    }
  };

  const newSheet = async (): Promise<void> => {
    if (!courseId) {
      showToast(t('exercise.wb.toast.importFirst'));
      return;
    }
    const title = window.prompt(t('exercise.wb.prompt.sheetTitle'), '') ?? '';
    const due = window.prompt(t('exercise.wb.prompt.sheetDue'), '') ?? '';
    try {
      const r = await apiPost<{ sheet: SheetView }>('create', { course_id: courseId, title, due });
      await loadCourses();
      await loadSheet(courseId, r.sheet.id);
      showToast(t('exercise.wb.toast.sheetCreated', { number: r.sheet.number }));
    } catch (e) {
      showToast(t('exercise.wb.toast.createFailed', { error: (e as Error).message }));
    }
  };

  /** 重新分块：默认**用 LLM**（regex 对 LaTeX 排版基本没救）。 */
  const resplit = async (useLlm: boolean): Promise<void> => {
    if (!courseId || !sheet) return;
    const tip = useLlm ? t('exercise.wb.confirm.resplitLlm') : t('exercise.wb.confirm.resplitRules');
    if (!window.confirm(tip)) return;
    setBusy(true);
    try {
      const r = await apiPost<{ sheet: SheetView; used_llm?: boolean; note?: string }>('resplit', {
        course_id: courseId,
        sheet_id: sheet.id,
        use_llm: useLlm,
      });
      setSheet(r.sheet);
      showToast(
        t('exercise.wb.toast.resplit', {
          n: r.sheet.problems.length,
          mode: r.used_llm ? t('exercise.wb.toast.resplitLlm') : t('exercise.wb.toast.resplitRules'),
        }),
      );
    } catch (e) {
      showToast(t('exercise.wb.toast.resplitFailed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  /** 导出纯文本（markdown）：确定性输出，给 git 管理用。 */
  const exportText = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiPost<{
        dir: string;
        written: string[];
        unchanged: string[];
        removed: string[];
        files: string[];
      }>('export_text', {});
      await refreshAfterWrite();
      showToast(
        t('exercise.wb.toast.exported', {
          dir: r.dir,
          written: r.written.length,
          unchanged: r.unchanged.length,
          removed: r.removed.length ? t('exercise.wb.toast.exportedRemoved', { n: r.removed.length }) : '',
          files: r.files.length,
        }),
      );
    } catch (e) {
      showToast(t('exercise.wb.toast.exportFailed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const buildSubmission = async (): Promise<void> => {
    if (!courseId || !sheet) return;
    setBusy(true);
    setPrintUrl('');
    try {
      const r = await apiPost<{ url: string; pages: number; bytes: number; renderer?: string; math_warnings?: string[] }>(
        'build_submission',
        {
          course_id: courseId,
          sheet_id: sheet.id,
        },
      );
      await refreshAfterWrite();
      showToast(
        t('exercise.wb.toast.submission', {
          pages: r.pages,
          kb: Math.round(r.bytes / 1024),
          renderer: r.renderer ?? t('exercise.wb.renderer.browser'),
        }) +
          (r.math_warnings?.length
            ? t('exercise.wb.toast.submissionMathWarn', {
                n: r.math_warnings.length,
                list: r.math_warnings.join('\n'),
              })
            : ''),
      );
      window.open(r.url, '_blank');
    } catch (e) {
      const err = e as ApiError;
      showToast(err.message);
      if (typeof err.payload?.print_url === 'string') setPrintUrl(err.payload.print_url);
    } finally {
      setBusy(false);
    }
  };

  const syncWorldbook = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiPost<{ written: number; skipped: number; failed: number }>('sync_worldbook', {
        course_id: courseId || undefined,
      });
      await loadMistakes();
      if (sheet) await loadSheet(courseId, sheet.id);
      showToast(
        t('exercise.wb.toast.worldbook', {
          written: r.written,
          skipped: r.skipped,
          failed: r.failed,
        }),
      );
    } catch (e) {
      showToast(t('exercise.wb.toast.syncFailed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const exportHandoff = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiPost<{ files: string[]; dir: string }>('export_handoff', { course_id: courseId || undefined });
      showToast(
        t('exercise.wb.toast.handoffExported', {
          dir: r.dir,
          files: r.files.map((f) => f.split(/[\\/]/).pop()).join(t('exercise.common.enumSep')),
        }),
      );
    } catch (e) {
      showToast(t('exercise.wb.toast.exportFailed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const importHandoff = async (): Promise<void> => {
    setBusy(true);
    try {
      const pre = await apiPost<{
        degraded?: boolean;
        previews?: string[];
        memories?: number;
        worldbook?: number;
        dropped?: number;
        outcomes?: string[];
      }>('import_handoff', { dry_run: true });
      if (pre.degraded) {
        showToast(t('exercise.wb.toast.importPreview', { list: (pre.previews ?? []).join('\n') }));
        return;
      }
      const summary = (pre.outcomes ?? []).slice(0, 4).join('\n');
      const ok = window.confirm(
        t('exercise.wb.confirm.importHandoff', {
          memories: pre.memories ?? 0,
          worldbook: pre.worldbook ?? 0,
          dropped: pre.dropped ?? 0,
          summary,
        }),
      );
      if (!ok) {
        showToast(t('exercise.wb.toast.importCancelled'));
        return;
      }
      const r = await apiPost<{ memories?: number; worldbook?: number; dropped?: number }>('import_handoff', {
        dry_run: false,
      });
      await loadMistakes();
      if (sheet) await loadSheet(courseId, sheet.id);
      showToast(
        t('exercise.wb.toast.imported', {
          memories: r.memories ?? 0,
          worldbook: r.worldbook ?? 0,
          dropped: r.dropped ?? 0,
        }),
      );
    } catch (e) {
      showToast(t('exercise.wb.toast.importFailed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const addLesson = async (): Promise<void> => {
    if (!courseId || !sheet) return;
    const text = lessonDraft.trim();
    if (!text) return;
    try {
      const r = await apiPost<{ sheet: SheetView }>('lesson', {
        op: 'add',
        course_id: courseId,
        sheet_id: sheet.id,
        text,
      });
      setSheet(r.sheet);
      setLessonDraft('');
      showToast(t('exercise.wb.toast.lessonAdded'));
    } catch (e) {
      showToast(t('exercise.wb.toast.lessonFailed', { error: (e as Error).message }));
    }
  };

  const deleteLesson = async (lessonId: string): Promise<void> => {
    if (!courseId || !sheet) return;
    try {
      const r = await apiPost<{ sheet: SheetView }>('lesson', {
        op: 'delete',
        course_id: courseId,
        sheet_id: sheet.id,
        lesson_id: lessonId,
      });
      setSheet(r.sheet);
    } catch (e) {
      showToast(t('exercise.common.deleteFailed', { error: (e as Error).message }));
    }
  };

  const patchMistake = async (id: string, patch: { lesson?: string; mastered?: boolean; tags?: string[] }): Promise<void> => {
    await apiPost('patch_mistake', { id, patch });
    await loadMistakes();
  };

  const jumpToMistake = async (cid: string, sid: string, problemId: string): Promise<void> => {
    setCourseId(cid);
    await loadSheet(cid, sid);
    await loadDigest(cid);
    window.setTimeout(() => {
      document.getElementById(`lec-problem-${problemId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
  };

  const openPdf = (kind: 'source_pdf' | 'submission', download = false): void => {
    if (!courseId || !sheet) return;
    const q = new URLSearchParams({ action: kind, course: courseId, sheet: sheet.id });
    if (download) q.set('download', '1');
    window.open(`${API_BASE}?${q.toString()}`, '_blank');
  };

  const openPrint = (): void => {
    if (!courseId || !sheet) return;
    const u =
      printUrl || `${API_BASE}?action=print&course=${encodeURIComponent(courseId)}&sheet=${encodeURIComponent(sheet.id)}`;
    window.open(u, '_blank');
  };

  // ---------- 渲染 ----------

  if (loading) {
    return (
      <div className={EX_CLASS} data-standalone={standalone ? '1' : '0'}>
        <div className="lec-empty lec-empty-big" style={{ margin: 'auto' }}>
          <div className="lec-empty-h">{t('exercise.wb.title')}</div>
          <p>{t('exercise.common.loading')}</p>
        </div>
      </div>
    );
  }

  const progress = sheet?.progress;

  return (
    <div className={EX_CLASS} data-standalone={standalone ? '1' : '0'} data-workbench="1">
      {/* ── 顶栏 ── */}
      <div className="lec-top">
        {!minimal && (
          <button
            type="button"
            className="lec-icon-btn"
            title={navOpen ? t('exercise.wb.nav.collapse') : t('exercise.wb.nav.expand')}
            onClick={() => setNavOpen((v) => !v)}
          >
            {navOpen ? '‹' : '›'}
          </button>
        )}
        <span className="lec-title">{t('exercise.wb.title')}</span>
        <span className="lec-sub">
          {minimal
            ? t('exercise.scratch.title')
            : sheet
              ? `${current?.title ?? courseId} · Übungsblatt ${sheet.number}`
              : t('exercise.wb.noSheet')}
        </span>
        <span className="lec-grow" />
        {!minimal && (
          <>
            <button type="button" className="lec-btn-tiny" onClick={() => setImportOpen(true)}>
              {t('exercise.wb.importPdf')}
            </button>
            <button type="button" className="lec-btn-tiny" onClick={() => void newSheet()} disabled={!courseId}>
              {t('exercise.wb.newSheet')}
            </button>
            <button type="button" className="lec-btn-tiny" onClick={() => void exportHandoff()} disabled={busy}>
              {t('exercise.wb.exportHandoff')}
            </button>
            <button type="button" className="lec-btn-tiny" onClick={() => void importHandoff()} disabled={busy}>
              {t('exercise.wb.importHandoff')}
            </button>
            <button type="button" className="lec-btn" onClick={() => void buildSubmission()} disabled={busy || !sheet}>
              {busy ? t('exercise.wb.processing') : t('exercise.wb.buildSubmission')}
            </button>
          </>
        )}
        <button
          type="button"
          className="lec-btn-tiny"
          data-active={minimal ? '1' : '0'}
          title={minimal ? t('exercise.scratch.exit') : t('exercise.scratch.enter')}
          onClick={() => setMinimal((v) => !v)}
        >
          {minimal ? t('exercise.scratch.exit') : t('exercise.scratch.enter')}
        </button>
        <button type="button" className="lec-icon-btn" title={t('exercise.common.close')} onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="lec-wb" data-minimal={minimal ? '1' : '0'}>
        {minimal ? (
          <ScratchWorkspace onToast={showToast} />
        ) : (
          <>
        {/* ── 左栏：课程 / 套题 ── */}
        {navOpen ? (
          <aside className="lec-wb-nav">
            <div className="lec-wb-navhead">Übungsblätter</div>

            {!courses.length && (
              <div className="lec-hint" style={{ padding: '0 10px' }}>
                {t('exercise.wb.noCourses')}
                <br />
                {t('exercise.wb.noCoursesHint')}
              </div>
            )}

            {/* 课程列表：和 lecture 一样，每门课可折叠，套题列在课程下面 */}
            {courses.map((c) => {
              const isOpen = collapsed[c.course_id] !== undefined ? !collapsed[c.course_id] : c.course_id === courseId;
              return (
                <div key={c.course_id} className="lec-course">
                  <div className="lec-course-name" title={c.course_id}>
                    <button
                      type="button"
                      className="lec-course-toggle"
                      aria-expanded={isOpen}
                      title={isOpen ? t('exercise.wb.course.collapse') : t('exercise.wb.course.expand')}
                      onClick={() => setCollapsed((prev) => ({ ...prev, [c.course_id]: isOpen }))}
                    >
                      {isOpen ? '▾' : '▸'}
                    </button>
                    <span className="lec-course-title" onClick={() => setCollapsed((prev) => ({ ...prev, [c.course_id]: isOpen }))}>
                      {c.title}
                      {c.semester ? <span className="lec-course-sem">{c.semester}</span> : null}
                      {!isOpen && c.sheets.length ? <span className="lec-course-count">{c.sheets.length}</span> : null}
                    </span>
                  </div>
                  {isOpen && c.sheets.length === 0 ? (
                    <div className="lec-hint" style={{ padding: '2px 10px 6px' }}>
                      {t('exercise.wb.noSheets')}
                    </div>
                  ) : null}
                  {isOpen
                    ? c.sheets.map((m) => (
                        <div key={m.id} className="lec-unit-row">
                          <button
                            type="button"
                            className="lec-unit"
                            data-active={sheet?.id === m.id ? '1' : '0'}
                            onClick={() => void selectSheet(c.course_id, m.id)}
                            title={t('exercise.wb.unitTitle', {
                              answered: m.answered,
                              total: m.total,
                              hint: m.next_hint,
                            })}
                          >
                            <span className="lec-unit-title">
                              Blatt {m.number}
                              {m.title ? ` · ${m.title}` : ''}
                            </span>
                            <span className="lec-unit-meta">
                              {t('exercise.wb.unitMeta', { answered: m.answered, total: m.total })}
                              {m.needs_fix ? t('exercise.wb.needsFix', { n: m.needs_fix }) : ''}
                              {dueText(t, m) ? ` · ${dueText(t, m)}` : ''}
                            </span>
                            <span className="lec-progress">
                              <i style={{ width: `${Math.max(2, m.percent)}%` }} />
                            </span>
                          </button>
                        </div>
                      ))
                    : null}
                </div>
              );
            })}

            <div className="lec-wb-navhead" style={{ marginTop: 10 }}>
              {t('exercise.wb.tools')}
            </div>
            <div style={{ padding: '0 8px 8px' }}>
              <button type="button" className="lec-btn" style={{ width: '100%', marginBottom: 6 }} onClick={() => sheet && openPdf('source_pdf')} disabled={!sheet?.source_pdf}>
                {t('exercise.wb.openSourcePdf')}
              </button>
              <button type="button" className="lec-btn" style={{ width: '100%', marginBottom: 6 }} onClick={() => void resplit(true)} disabled={!sheet || busy}>
                {t('exercise.wb.resplitLlm')}
              </button>
              <button type="button" className="lec-btn lec-btn-ghost" style={{ width: '100%', marginBottom: 6 }} onClick={() => void resplit(false)} disabled={!sheet || busy}>
                {t('exercise.wb.resplitRules')}
              </button>
              <button type="button" className="lec-btn lec-btn-ghost" style={{ width: '100%', marginBottom: 6 }} onClick={() => void addProblem()} disabled={!sheet}>
                {t('exercise.wb.addProblem')}
              </button>
              {sheet?.submitted_at ? (
                <button type="button" className="lec-btn lec-btn-ghost" style={{ width: '100%', marginBottom: 6 }} onClick={() => openPdf('submission', true)}>
                  {t('exercise.wb.downloadSubmission')}
                </button>
              ) : null}
              <button
                type="button"
                className="lec-btn lec-btn-ghost"
                style={{ width: '100%' }}
                onClick={() => void exportText()}
                disabled={busy}
                title={t('exercise.wb.exportTextTitle')}
              >
                {t('exercise.wb.exportText')}
              </button>
            </div>
            {error ? <div className="lec-warn" style={{ padding: '0 10px' }}>{error}</div> : null}
          </aside>
        ) : null}

        {/* ── 中栏：套题 ── */}
        <main className="lec-wb-main">
          <div className="lec-wb-scroll" ref={scrollRef}>
            {!sheet && (
              <div className="lec-empty lec-empty-big">
                <div className="lec-empty-h">{t('exercise.wb.title')}</div>
                <p>
                  {t('exercise.wb.empty.lead')}
                  <b>{t('exercise.wb.empty.strong')}</b>
                  {t('exercise.wb.empty.tail')}
                </p>
                <p className="lec-hint">{t('exercise.wb.empty.hint')}</p>
              </div>
            )}

            {sheet && (
              <>
                <div className="lec-sheethead">
                  <h1>
                    Übungsblatt {sheet.number}
                    {sheet.title ? ` — ${sheet.title}` : ''}
                  </h1>
                  <span className="lec-hint">
                    {t('exercise.wb.summary', {
                      answered: progress?.answered ?? 0,
                      total: progress?.total ?? 0,
                      checked: progress?.checked ?? 0,
                    })}
                    {progress?.needsFix ? t('exercise.wb.needsFix', { n: progress.needsFix }) : ''}
                    {sheet.due ? t('exercise.wb.summaryDue', { date: sheet.due }) : ''}
                    {sheet.submitted_at ? t('exercise.wb.submitted', { pages: sheet.submission_pages }) : ''}
                  </span>
                </div>

                {sheet.progress_digest && (
                  <div className="lec-digest">
                    <b>{t('exercise.wb.progressDigest')}</b>
                    {sheet.progress_digest}
                  </div>
                )}
                {sheet.needs_manual_text && (
                  <div className="lec-nextstep">{t('exercise.wb.needsManualText')}</div>
                )}
                {sheet.next_hint && <div className="lec-nextstep">{sheet.next_hint}</div>}
                {printUrl && (
                  <div className="lec-nextstep">
                    {t('exercise.wb.noChrome')}
                    <button type="button" className="lec-btn lec-btn-ghost" style={{ marginLeft: 6 }} onClick={openPrint}>
                      {t('exercise.wb.openPrint')}
                    </button>
                  </div>
                )}

                {sheet.problems.length === 0 && (
                  <div className="lec-empty">{t('exercise.wb.noProblems')}</div>
                )}

                {sheet.problems.map((p) => (
                  <ProblemCard
                    key={p.id}
                    problem={p}
                    pageImageUrl={
                      sheet.has_page_images && courseId
                        ? `${API_BASE}?action=page&course=${encodeURIComponent(courseId)}&sheet=${encodeURIComponent(sheet.id)}&page=${p.page || 1}`
                        : undefined
                    }
                    busy={busyProblem === p.id}
                    mistakeCount={p.mistakes.length}
                    onSave={(patch) => saveProblem(p.id, patch)}
                    onCheck={() => void checkProblem(p.id)}
                    imageUrl={(name) =>
                      `${API_BASE}?action=attachment&course=${encodeURIComponent(courseId)}&sheet=${encodeURIComponent(sheet.id)}&name=${encodeURIComponent(name)}`
                    }
                    onAttachImage={async (file) => {
                      setBusyProblem(p.id);
                      try {
                        const base64 = await readFileAsBase64(file);
                        const r = await apiPost<{ sheet: SheetView }>('add_attachment', {
                          course_id: courseId,
                          sheet_id: sheet.id,
                          problem_id: p.id,
                          base64,
                          caption: file.name.replace(/\.[a-z0-9]+$/i, ''),
                        });
                        setSheet(r.sheet);
                        showToast(t('exercise.wb.toast.imageAttached', { name: file.name }));
                      } catch (e) {
                        showToast(t('exercise.wb.toast.uploadFailed', { error: (e as Error).message }));
                      } finally {
                        setBusyProblem('');
                      }
                    }}
                    onDeleteImage={async (imageId) => {
                      try {
                        const r = await apiPost<{ sheet: SheetView }>('delete_attachment', {
                          course_id: courseId,
                          sheet_id: sheet.id,
                          problem_id: p.id,
                          image_id: imageId,
                        });
                        setSheet(r.sheet);
                      } catch (e) {
                        showToast(t('exercise.common.deleteFailed', { error: (e as Error).message }));
                      }
                    }}
                    onRebuttal={async (text) => {
                      setBusyProblem(p.id);
                      try {
                        const r = await apiPost<{ sheet: SheetView }>('rebut', {
                          course_id: courseId,
                          sheet_id: sheet.id,
                          problem_id: p.id,
                          text,
                        });
                        setSheet(r.sheet);
                        const last = r.sheet.problems.find((x) => x.id === p.id)?.rebuttals.at(-1);
                        showToast(
                          last?.outcome === 'conceded'
                            ? t('exercise.wb.toast.rebuttalConceded')
                            : last?.outcome === 'upheld'
                              ? t('exercise.wb.toast.rebuttalUpheld')
                              : t('exercise.wb.toast.rebuttalPartial'),
                        );
                      } catch (e) {
                        showToast(t('exercise.wb.toast.rebuttalFailed', { error: (e as Error).message }));
                      } finally {
                        setBusyProblem('');
                      }
                    }}
                    onCollectMistake={() => void collectMistake(p.id)}
                    onDelete={() => void deleteProblem(p.id)}
                    onToast={showToast}
                  />
                ))}
                <div style={{ height: 40 }} />
              </>
            )}
          </div>
        </main>

        {/* ── 右栏：符号 / 错题本 / 经验 / 进度 ── */}
        <aside className="lec-wb-side">
          <div className="lec-sidetabs">
            <button type="button" className="lec-sidetab" data-active={tab === 'symbols' ? '1' : '0'} onClick={() => setTab('symbols')}>
              {t('exercise.wb.tab.symbols')}
            </button>
            <button type="button" className="lec-sidetab" data-active={tab === 'mistakes' ? '1' : '0'} onClick={() => setTab('mistakes')}>
              {t('exercise.wb.tab.mistakes')}
            </button>
            <button type="button" className="lec-sidetab" data-active={tab === 'lessons' ? '1' : '0'} onClick={() => setTab('lessons')}>
              {t('exercise.wb.tab.lessons')}
            </button>
            <button type="button" className="lec-sidetab" data-active={tab === 'progress' ? '1' : '0'} onClick={() => setTab('progress')}>
              {t('exercise.wb.tab.progress')}
            </button>
          </div>
          <div className="lec-sidebody">
            {tab === 'symbols' && (
              <SymbolPanel
                onInsert={(text, caret) => insertIntoActiveEditor(text, caret)}
                onToast={showToast}
              />
            )}

            {tab === 'mistakes' && (
              <MistakesPanel
                mistakes={mistakes}
                busy={busy}
                onPatch={patchMistake}
                onDelete={async (id) => {
                  await apiPost('delete_mistake', { id });
                  await loadMistakes();
                }}
                onJump={(cid, sid, pid) => void jumpToMistake(cid, sid, pid)}
                onSyncWorldbook={() => void syncWorldbook()}
                onToast={showToast}
              />
            )}

            {tab === 'lessons' && (
              <div>
                <div className="lec-hint">
                  {t('exercise.wb.lessons.hint')}
                </div>
                <textarea
                  className="lec-mistake-lesson"
                  placeholder={t('exercise.wb.lessons.placeholder')}
                  value={lessonDraft}
                  onChange={(e) => setLessonDraft(e.currentTarget.value)}
                />
                <div className="lec-toolrow">
                  <button type="button" className="lec-btn" onClick={() => void addLesson()} disabled={!lessonDraft.trim()}>
                    {t('exercise.wb.lessons.add')}
                  </button>
                  <span className="lec-grow" />
                  <button type="button" className="lec-btn lec-btn-ghost" onClick={() => void syncWorldbook()} disabled={busy}>
                    {t('exercise.wb.lessons.sync')}
                  </button>
                </div>

                {(sheet?.lessons.length ?? 0) === 0 && <div className="lec-empty">{t('exercise.wb.lessons.empty')}</div>}
                {sheet?.lessons.map((l) => (
                  <div key={l.id} className="lec-mistake">
                    <div className="lec-problem-head">
                      <span className="lec-badge">
                        {l.in_worldbook ? t('exercise.mistakes.inWorldbook') : t('exercise.wb.lessons.pendingSync')}
                      </span>
                      <span className="lec-mistake-path">{new Date(l.created_at).toLocaleDateString()}</span>
                      <span className="lec-grow" />
                      <button type="button" className="lec-del" onClick={() => void deleteLesson(l.id)}>
                        ✕
                      </button>
                    </div>
                    <MathText text={l.text} compact />
                  </div>
                ))}
              </div>
            )}

            {tab === 'progress' && (
              <div>
                {!digest && <div className="lec-empty">{t('exercise.wb.progress.pickCourse')}</div>}
                {digest && (
                  <>
                    <div className="lec-hint">{t('exercise.wb.progress.hint')}</div>
                    <div className="lec-digest" style={{ marginTop: 0 }}>
                      {digest.digest || t('exercise.wb.progress.empty')}
                    </div>
                    <div className="lec-hint" style={{ marginTop: 10 }}>
                      <div>
                        {t('exercise.wb.progress.sheets', {
                          submitted: digest.stats.sheetsSubmitted,
                          total: digest.stats.sheetsTotal,
                        })}
                      </div>
                      <div>
                        {t('exercise.wb.progress.problems', {
                          answered: digest.stats.problemsAnswered,
                          total: digest.stats.problemsTotal,
                        })}
                      </div>
                      <div>{t('exercise.wb.progress.checks', { n: digest.stats.checksPassed })}</div>
                      <div>{t('exercise.wb.progress.mistakes', { n: digest.stats.unmasteredMistakes })}</div>
                    </div>
                    {digest.stats.topWeakTags.length > 0 && (
                      <div className="lec-toolrow">
                        {digest.stats.topWeakTags.map((tag) => (
                          <span key={tag} className="lec-badge">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </aside>
          </>
        )}
      </div>

      <ImportDialog
        open={importOpen}
        defaultCourse={courseId}
        onClose={() => setImportOpen(false)}
        onImported={async (cid, s, warnings) => {
          await loadCourses();
          await loadSheet(cid, s.id);
          setCourseId(cid);
          await loadDigest(cid);
          if (warnings.length) showToast(warnings.join('\n'));
        }}
        onToast={showToast}
      />

      {toast && <div className="lec-toast">{toast}</div>}
    </div>
  );
}
