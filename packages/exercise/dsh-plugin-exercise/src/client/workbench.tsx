// ============================================================
// client/workbench.tsx — 习题工作台（三栏）
//
// 布局借 lecture 的工作台（左：课程/套题；中：题目与解答；右：符号/错题/进度），
// 但内容完全不同：这里的主对象是**一道一道的题**，不是课堂速记块。
//
// 交互原则：
//   · 中栏是"做题"的地方：题干只读（可点开改）、答案永远可编辑、检查结果附在下面
//   · 右栏默认停**符号**（做题时最常用），错题本/进度是复习时才看
//   · 所有写操作都**立刻落盘**（host 侧 sheet.json），没有"保存整个工作台"的概念
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
  type SheetView,
} from './api.ts';
import { ProblemCard } from './problem-card.tsx';
import { MistakesPanel } from './mistakes-panel.tsx';
import { SymbolPanel } from './symbol-palette.tsx';
import { ImportDialog } from './import-dialog.tsx';
import type { Inserter } from './answer-editor.tsx';
import { MathText } from './math.tsx';

type Tab = 'symbols' | 'mistakes' | 'lessons' | 'progress';

export interface WorkbenchProps {
  onClose: () => void;
  standalone?: boolean;
}

export function Workbench({ onClose, standalone = false }: WorkbenchProps): JSX.Element {
  const [courses, setCourses] = useState<CourseView[]>([]);
  const [courseId, setCourseId] = useState('');
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [mistakes, setMistakes] = useState<MistakeView[]>([]);
  const [digest, setDigest] = useState<DigestView | null>(null);
  const [tab, setTab] = useState<Tab>('symbols');
  const [toast, setToast] = useState<string>('');
  const [busyProblem, setBusyProblem] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lessonDraft, setLessonDraft] = useState('');
  const [printUrl, setPrintUrl] = useState<string>('');
  const inserterRef = useRef<Inserter | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 4200);
  }, []);

  const registerInserter = useCallback((fn: Inserter) => {
    inserterRef.current = fn;
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
    const r = await apiGet<DigestView & { ok: true }>('digest', { course: cid });
    setDigest({ digest: r.digest, stats: r.stats });
  }, []);

  // 首屏：课程 → 第一门课 → 最近一套未提交的（没有就最新一套）
  useEffect(() => {
    void (async () => {
      try {
        const list = await loadCourses();
        await loadMistakes();
        const first = list[0];
        if (first) {
          setCourseId(first.course_id);
          const pick =
            first.sheets.find((s) => !s.submitted) ?? first.sheets[first.sheets.length - 1] ?? null;
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

  const selectCourse = async (cid: string): Promise<void> => {
    setCourseId(cid);
    const c = courses.find((x) => x.course_id === cid);
    const pick = c?.sheets.find((s) => !s.submitted) ?? c?.sheets[c.sheets.length - 1] ?? null;
    if (pick) await loadSheet(cid, pick.id);
    else setSheet(null);
    await loadDigest(cid);
  };

  const selectSheet = async (sid: string): Promise<void> => {
    if (!courseId) return;
    await loadSheet(courseId, sid);
    setPrintUrl('');
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
      if (r.stale) showToast(`答案已更新 —— ${r.stale} 条旧检查已标记过期`);
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
      showToast(`检查完成：${r.check.verdict}`);
    } catch (e) {
      showToast(`检查失败：${(e as Error).message}`);
    } finally {
      setBusyProblem('');
    }
  };

  const collectMistake = async (problemId: string): Promise<void> => {
    if (!courseId || !sheet) return;
    try {
      await apiPost('collect_mistake', { course_id: courseId, sheet_id: sheet.id, problem_id: problemId });
      await refreshAfterWrite();
      showToast('已加入错题本 —— 右栏可以补写教训');
    } catch (e) {
      showToast(`加入失败：${(e as Error).message}`);
    }
  };

  const addProblem = async (): Promise<void> => {
    if (!courseId || !sheet) return;
    try {
      const r = await apiPost<{ sheet: SheetView }>('add_problem', { course_id: courseId, sheet_id: sheet.id });
      setSheet(r.sheet);
    } catch (e) {
      showToast(`添加失败：${(e as Error).message}`);
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
      showToast(`删除失败：${(e as Error).message}`);
    }
  };

  const newSheet = async (): Promise<void> => {
    if (!courseId) {
      showToast('先在左栏导入一份 PDF（会同时建课程）');
      return;
    }
    const title = window.prompt('这套题的主题（可留空）', '') ?? '';
    const due = window.prompt('截止日 YYYY-MM-DD（可留空）', '') ?? '';
    try {
      const r = await apiPost<{ sheet: SheetView }>('create', { course_id: courseId, title, due, number: undefined });
      await loadCourses();
      await loadSheet(courseId, r.sheet.id);
      showToast(`已新建 Übungsblatt ${r.sheet.number}（附上了当前学习进度）`);
    } catch (e) {
      showToast(`新建失败：${(e as Error).message}`);
    }
  };

  const resplit = async (): Promise<void> => {
    if (!courseId || !sheet) return;
    if (!window.confirm('用 source.md 重新拆题？已按题号保留的答案不会丢。')) return;
    try {
      const r = await apiPost<{ sheet: SheetView }>('resplit', { course_id: courseId, sheet_id: sheet.id });
      setSheet(r.sheet);
      showToast(`已重新拆题：${r.sheet.problems.length} 题`);
    } catch (e) {
      showToast(`重新拆题失败：${(e as Error).message}`);
    }
  };

  const buildSubmission = async (): Promise<void> => {
    if (!courseId || !sheet) return;
    setBusy(true);
    setPrintUrl('');
    try {
      const r = await apiPost<{ url: string; pages: number; bytes: number; renderer?: string }>('build_submission', {
        course_id: courseId,
        sheet_id: sheet.id,
      });
      setPrintUrl('');
      await refreshAfterWrite();
      showToast(`提交包已生成：${r.pages} 页（${Math.round(r.bytes / 1024)} KB，${r.renderer ?? '浏览器'}）—— 正在下载`);
      window.open(r.url, '_blank');
    } catch (e) {
      // host 生成失败时会带 print_url（没找到 Chrome/Edge 的降级路径）
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
      showToast(`worldbook：写入 ${r.written} 条，已存在 ${r.skipped} 条，失败 ${r.failed} 条（热重载 ≤3s 生效）`);
    } catch (e) {
      showToast(`同步失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const exportHandoff = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiPost<{ files: string[]; dir: string }>('export_handoff', { course_id: courseId || undefined });
      showToast(`握手包已导出到 ${r.dir}\n${r.files.map((f) => f.split(/[\\/]/).pop()).join('、')}`);
    } catch (e) {
      showToast(`导出失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 导入握手（接收侧）。
   *
   * 先 dry-run 给用户看"会写什么"，确认后才真写 —— 与工具版的 `dry_run` 缺省一致。
   * 在独立 exercise profile 里没有 memory 服务时，host 会返回 degraded 预览，
   * 这里就把预览原样显示出来（而不是假装成功）。
   */
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
        showToast(`只读预览（本 profile 没有 memory 服务）：\n${(pre.previews ?? []).join('\n')}`);
        return;
      }
      const summary = (pre.outcomes ?? []).slice(0, 4).join('\n');
      const ok = window.confirm(
        `试运行结果：记忆 ${pre.memories ?? 0} 条 · 世界书 ${pre.worldbook ?? 0} 条 · 跳过 ${pre.dropped ?? 0} 条\n\n${summary}\n\n确认写入？`,
      );
      if (!ok) {
        showToast('已取消（没有写入任何东西）');
        return;
      }
      const r = await apiPost<{ memories?: number; worldbook?: number; dropped?: number }>('import_handoff', {
        dry_run: false,
      });
      await loadMistakes();
      if (sheet) await loadSheet(courseId, sheet.id);
      showToast(`已导入：记忆 ${r.memories ?? 0} 条 · 世界书 ${r.worldbook ?? 0} 条 · 跳过 ${r.dropped ?? 0} 条`);
    } catch (e) {
      showToast(`导入失败：${(e as Error).message}`);
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
      showToast('经验已记录（可在「错题本」页同步进 worldbook）');
    } catch (e) {
      showToast(`记录失败：${(e as Error).message}`);
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
      showToast(`删除失败：${(e as Error).message}`);
    }
  };

  const patchMistake = async (
    id: string,
    patch: { lesson?: string; mastered?: boolean; tags?: string[] },
  ): Promise<void> => {
    await apiPost('patch_mistake', { id, patch });
    await loadMistakes();
  };

  const jumpToMistake = async (cid: string, sid: string, problemId: string): Promise<void> => {
    setCourseId(cid);
    await loadSheet(cid, sid);
    await loadDigest(cid);
    window.setTimeout(() => {
      document.getElementById(`ex-problem-${problemId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    const u = printUrl || `${API_BASE}?action=print&course=${encodeURIComponent(courseId)}&sheet=${encodeURIComponent(sheet.id)}`;
    window.open(u, '_blank');
  };

  // ---------- 渲染 ----------

  if (loading) {
    return (
      <div className="ex-app">
        <div className="ex-body" style={{ gridTemplateColumns: '1fr', alignItems: 'center', justifyContent: 'center' }}>
          <div className="ex-loading">习题工作台加载中…</div>
        </div>
      </div>
    );
  }

  const progress = sheet?.progress;

  return (
    <div className="ex-app">
      <div className="ex-topbar">
        <div className="ex-brand">
          <span className="ex-brand-dot" />
          Übungen
          <span className="ex-brand-sub">习题工作台</span>
        </div>
        <select className="ex-course-select" value={courseId} onChange={(e) => void selectCourse(e.currentTarget.value)}>
          {courses.length === 0 && <option value="">（还没有课程）</option>}
          {courses.map((c) => (
            <option key={c.course_id} value={c.course_id}>
              {c.title}
            </option>
          ))}
        </select>
        <span className="ex-topbar-spacer" />
        <button type="button" className="ex-btn ex-btn-sm" onClick={() => setImportOpen(true)}>
          导入 PDF
        </button>
        <button type="button" className="ex-btn ex-btn-sm" onClick={() => void newSheet()} disabled={!courseId}>
          新的一节
        </button>
        <button type="button" className="ex-btn ex-btn-sm" onClick={() => void exportHandoff()} disabled={busy}>
          导出握手
        </button>
        <button type="button" className="ex-btn ex-btn-sm" onClick={() => void importHandoff()} disabled={busy}>
          导入握手
        </button>
        <button type="button" className="ex-btn ex-btn-sm ex-btn-primary" onClick={() => void buildSubmission()} disabled={busy || !sheet}>
          {busy ? '处理中…' : '生成提交 PDF'}
        </button>
        {!standalone && (
          <button type="button" className="ex-btn ex-btn-sm ex-btn-ghost" onClick={onClose} title="关闭习题界面">
            ✕
          </button>
        )}
      </div>

      <div className="ex-body">
        {/* ── 左栏 ── */}
        <div className="ex-col ex-col-left">
          <div className="ex-section-title">
            <span>Übungsblätter</span>
            <span>{current?.sheets.length ?? 0}</span>
          </div>

          {!current && <div className="ex-empty">还没有课程 —— 点上方「导入 PDF」开始</div>}

          <div className="ex-sheet-list">
            {current?.sheets.map((s) => {
              const done = s.percent >= 100 || s.submitted;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={sheet?.id === s.id ? 'ex-sheet-item active' : 'ex-sheet-item'}
                  onClick={() => void selectSheet(s.id)}
                >
                  <div className="ex-sheet-row">
                    <span className="ex-sheet-no">Blatt {s.number}</span>
                    <span className="ex-sheet-title">{s.title || s.id}</span>
                  </div>
                  <div className="ex-sheet-meta">
                    <span>
                      {s.answered}/{s.total} 题
                    </span>
                    {s.needs_fix > 0 && <span style={{ color: 'var(--ex-danger)' }}>待修 {s.needs_fix}</span>}
                    {s.due_in_days != null && (
                      <span style={{ color: s.due_in_days < 0 ? 'var(--ex-danger)' : undefined }}>
                        {s.due_in_days < 0 ? `过期 ${-s.due_in_days} 天` : s.due_in_days === 0 ? '今天截止' : `还有 ${s.due_in_days} 天`}
                      </span>
                    )}
                    {s.submitted && <span style={{ color: 'var(--ex-ok)' }}>已生成提交包</span>}
                    {s.needs_manual_text && <span style={{ color: 'var(--ex-warn)' }}>需手补题干</span>}
                  </div>
                  <div className={done ? 'ex-progress done' : 'ex-progress'}>
                    <i style={{ width: `${Math.max(2, s.percent)}%` }} />
                  </div>
                </button>
              );
            })}
          </div>

          <div className="ex-left-actions">
            <button type="button" className="ex-btn ex-btn-sm" onClick={() => sheet && openPdf('source_pdf')} disabled={!sheet?.source_pdf}>
              打开原卷 PDF
            </button>
            <button type="button" className="ex-btn ex-btn-sm" onClick={() => void resplit()} disabled={!sheet}>
              重新拆题（source.md）
            </button>
            <button type="button" className="ex-btn ex-btn-sm" onClick={() => void addProblem()} disabled={!sheet}>
              + 添加题目
            </button>
            {sheet?.submitted_at ? (
              <button type="button" className="ex-btn ex-btn-sm" onClick={() => openPdf('submission', true)}>
                下载上次提交包
              </button>
            ) : null}
          </div>

          {error && <div className="ex-error">{error}</div>}
        </div>

        {/* ── 中栏 ── */}
        <div className="ex-col ex-col-center">
          {!sheet && (
            <div className="ex-empty">
              {current ? '左栏选一套题，或点上方「导入 PDF」' : '还没有课程 —— 点上方「导入 PDF」开始'}
            </div>
          )}

          {sheet && (
            <>
              <div className="ex-sheet-head">
                <h1>
                  Übungsblatt {sheet.number}
                  {sheet.title ? ` — ${sheet.title}` : ''}
                </h1>
                <div className="ex-sheet-head-meta">
                  <span>
                    {progress?.answered ?? 0}/{progress?.total ?? 0} 题有答案
                  </span>
                  <span>检查通过 {progress?.checked ?? 0}</span>
                  {progress?.needsFix ? <span style={{ color: 'var(--ex-danger)' }}>待修 {progress.needsFix}</span> : null}
                  {sheet.due ? <span>截止 {sheet.due}</span> : null}
                  {sheet.source_pages ? <span>原卷 {sheet.source_pages} 页</span> : null}
                  {sheet.submitted_at ? <span style={{ color: 'var(--ex-ok)' }}>已生成提交包（{sheet.submission_pages} 页）</span> : null}
                </div>

                {sheet.progress_digest && (
                  <div className="ex-digest">
                    <b>开这套题时的学习进度</b>
                    {sheet.progress_digest}
                  </div>
                )}
                {sheet.needs_manual_text && (
                  <div className="ex-next-hint">
                    PDF 抽不出文字（扫描版/公式为主）—— 请点每道题的「改题干」手动补上，或者直接添加题目。
                  </div>
                )}
                {sheet.next_hint && <div className="ex-next-hint">{sheet.next_hint}</div>}
                {printUrl && (
                  <div className="ex-next-hint">
                    没找到本机 Chrome/Edge，自动生成失败。点
                    <button type="button" className="ex-btn ex-btn-sm" style={{ margin: '0 4px' }} onClick={openPrint}>
                      打开打印页
                    </button>
                    然后在浏览器里「打印 → 另存为 PDF」。
                  </div>
                )}
              </div>

              {sheet.problems.length === 0 && (
                <div className="ex-empty">
                  这套题还没有题目 —— 用「+ 添加题目」手填，或导入 PDF 让其自动拆题。
                </div>
              )}

              {sheet.problems.map((p) => (
                <ProblemCard
                  key={p.id}
                  problem={p}
                  busy={busyProblem === p.id}
                  mistakeCount={p.mistakes.length}
                  onSave={(patch) => saveProblem(p.id, patch)}
                  onCheck={() => void checkProblem(p.id)}
                  onCollectMistake={() => void collectMistake(p.id)}
                  onDelete={() => void deleteProblem(p.id)}
                  registerInserter={registerInserter}
                  onToast={showToast}
                />
              ))}
            </>
          )}
        </div>

        {/* ── 右栏 ── */}
        <div className="ex-col-right">
          <div className="ex-tabs">
            <button type="button" className={tab === 'symbols' ? 'ex-tab active' : 'ex-tab'} onClick={() => setTab('symbols')}>
              符号
            </button>
            <button type="button" className={tab === 'mistakes' ? 'ex-tab active' : 'ex-tab'} onClick={() => setTab('mistakes')}>
              错题本
            </button>
            <button type="button" className={tab === 'lessons' ? 'ex-tab active' : 'ex-tab'} onClick={() => setTab('lessons')}>
              经验
            </button>
            <button type="button" className={tab === 'progress' ? 'ex-tab active' : 'ex-tab'} onClick={() => setTab('progress')}>
              进度
            </button>
          </div>

          <div className="ex-tab-body">
            {tab === 'symbols' && (
              <SymbolPanel
                onInsert={(text, caret) => {
                  const fn = inserterRef.current;
                  return fn ? fn(text, caret) : false;
                }}
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
                <div className="ex-symbol-note">
                  这套题教会我什么（一句话一条）。写完点「同步 worldbook」让主 agent 以后能提起。
                </div>
                <textarea
                  className="ex-mistake-lesson"
                  placeholder="例如：角动量题先判守恒条件，再选轴 —— 轴选错一律白算。"
                  value={lessonDraft}
                  onChange={(e) => setLessonDraft(e.currentTarget.value)}
                />
                <div className="ex-answer-tools">
                  <button type="button" className="ex-btn ex-btn-primary ex-btn-sm" onClick={() => void addLesson()} disabled={!lessonDraft.trim()}>
                    记下这条经验
                  </button>
                  <span className="ex-spacer" />
                  <button type="button" className="ex-btn ex-btn-sm" onClick={() => void syncWorldbook()} disabled={busy}>
                    同步 worldbook
                  </button>
                </div>

                {(sheet?.lessons.length ?? 0) === 0 && <div className="ex-empty">这套题还没有经验条目</div>}
                {sheet?.lessons.map((l) => (
                  <div key={l.id} className="ex-mistake">
                    <div className="ex-mistake-head">
                      <span className="ex-chip accent">{l.in_worldbook ? '已进知识库' : '待同步'}</span>
                      <span className="ex-mistake-path">{new Date(l.created_at).toLocaleDateString()}</span>
                      <span className="ex-spacer" />
                      <button type="button" className="ex-btn ex-btn-sm ex-btn-ghost" onClick={() => void deleteLesson(l.id)}>
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
                {!digest && <div className="ex-empty">选一门课才有进度</div>}
                {digest && (
                  <>
                    <div className="ex-symbol-note">这就是每开一套新题时自动附上的进度摘要（也会进检查的 prompt）。</div>
                    <div className="ex-digest" style={{ marginTop: 0 }}>
                      {digest.digest || '（还没有历史记录）'}
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <div className="ex-stat-row">
                        <span>题集</span>
                        <b>
                          {digest.stats.sheetsSubmitted}/{digest.stats.sheetsTotal} 已提交
                        </b>
                      </div>
                      <div className="ex-stat-row">
                        <span>题目</span>
                        <b>
                          {digest.stats.problemsAnswered}/{digest.stats.problemsTotal} 有答案
                        </b>
                      </div>
                      <div className="ex-stat-row">
                        <span>检查通过</span>
                        <b>{digest.stats.checksPassed}</b>
                      </div>
                      <div className="ex-stat-row">
                        <span>未掌握错题</span>
                        <b>{digest.stats.unmasteredMistakes}</b>
                      </div>
                      {digest.stats.topWeakTags.length > 0 && (
                        <div className="ex-tags">
                          {digest.stats.topWeakTags.map((t) => (
                            <span key={t} className="ex-chip">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
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

      {toast && <div className="ex-toast">{toast}</div>}
    </div>
  );
}
