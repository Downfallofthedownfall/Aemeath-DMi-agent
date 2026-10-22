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
import { insertIntoActiveEditor } from './answer-editor.tsx';
import { MathText } from './math.tsx';
import { EX_CLASS } from './styles.ts';

type Tab = 'symbols' | 'mistakes' | 'lessons' | 'progress';

export interface WorkbenchProps {
  onClose: () => void;
  standalone?: boolean;
}

function dueText(m: SheetMetaView): string {
  if (m.due_in_days == null) return '';
  if (m.due_in_days < 0) return `过期 ${-m.due_in_days} 天`;
  if (m.due_in_days === 0) return '今天截止';
  return `还有 ${m.due_in_days} 天`;
}

/** File → base64（不带 data: 前缀；后端自己嗅探格式）。 */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s);
    };
    reader.readAsDataURL(file);
  });
}
export function Workbench({ onClose, standalone = false }: WorkbenchProps): JSX.Element {
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
      showToast('已加入错题本 —— 右栏「错题本」里补写教训');
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
      const r = await apiPost<{ sheet: SheetView }>('create', { course_id: courseId, title, due });
      await loadCourses();
      await loadSheet(courseId, r.sheet.id);
      showToast(`已新建 Übungsblatt ${r.sheet.number}（附上了当前学习进度）`);
    } catch (e) {
      showToast(`新建失败：${(e as Error).message}`);
    }
  };

  /** 重新分块：默认**用 LLM**（regex 对 LaTeX 排版基本没救）。 */
  const resplit = async (useLlm: boolean): Promise<void> => {
    if (!courseId || !sheet) return;
    const tip = useLlm
      ? '用 LLM 重新分块？会用原文（source.md）重新识别题目边界，按题号保留已有答案。'
      : '用规则重新分块？按 Aufgabe/数字题号切分，按题号保留已有答案。';
    if (!window.confirm(tip)) return;
    setBusy(true);
    try {
      const r = await apiPost<{ sheet: SheetView; used_llm?: boolean; note?: string }>('resplit', {
        course_id: courseId,
        sheet_id: sheet.id,
        use_llm: useLlm,
      });
      setSheet(r.sheet);
      showToast(`已重新分块：${r.sheet.problems.length} 题${r.used_llm ? '（LLM）' : '（规则）'}`);
    } catch (e) {
      showToast(`重新分块失败：${(e as Error).message}`);
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
        `已导出文本到 ${r.dir}\n写 ${r.written.length} 个 · 未变 ${r.unchanged.length}` +
          `${r.removed.length ? ` · 删 ${r.removed.length}` : ''}（共 ${r.files.length} 个文件）`,
      );
    } catch (e) {
      showToast(`导出失败：${(e as Error).message}`);
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
        `提交包已生成：${r.pages} 页（${Math.round(r.bytes / 1024)} KB，${r.renderer ?? '浏览器'}）—— 正在下载` +
          (r.math_warnings?.length
            ? `\n⚠ 有 ${r.math_warnings.length} 处公式命令 KaTeX 不认（PDF 里会是红字）：\n${r.math_warnings.join('\n')}`
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
          <div className="lec-empty-h">习题</div>
          <p>加载中…</p>
        </div>
      </div>
    );
  }

  const progress = sheet?.progress;

  return (
    <div className={EX_CLASS} data-standalone={standalone ? '1' : '0'} data-workbench="1">
      {/* ── 顶栏 ── */}
      <div className="lec-top">
        <button
          type="button"
          className="lec-icon-btn"
          title={navOpen ? '收起套题列表' : '展开套题列表'}
          onClick={() => setNavOpen((v) => !v)}
        >
          {navOpen ? '‹' : '›'}
        </button>
        <span className="lec-title">习题</span>
        <span className="lec-sub">
          {sheet ? `${current?.title ?? courseId} · Übungsblatt ${sheet.number}` : '还没有题集'}
        </span>
        <span className="lec-grow" />
        <button type="button" className="lec-btn-tiny" onClick={() => setImportOpen(true)}>
          导入 PDF
        </button>
        <button type="button" className="lec-btn-tiny" onClick={() => void newSheet()} disabled={!courseId}>
          ＋ 新的一节
        </button>
        <button type="button" className="lec-btn-tiny" onClick={() => void exportHandoff()} disabled={busy}>
          导出握手
        </button>
        <button type="button" className="lec-btn-tiny" onClick={() => void importHandoff()} disabled={busy}>
          导入握手
        </button>
        <button type="button" className="lec-btn" onClick={() => void buildSubmission()} disabled={busy || !sheet}>
          {busy ? '处理中…' : '生成提交 PDF'}
        </button>
        <button type="button" className="lec-icon-btn" title="关闭" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="lec-wb">
        {/* ── 左栏：课程 / 套题 ── */}
        {navOpen ? (
          <aside className="lec-wb-nav">
            <div className="lec-wb-navhead">Übungsblätter</div>

            {!courses.length && (
              <div className="lec-hint" style={{ padding: '0 10px' }}>
                还没有课程。
                <br />
                点上方「导入 PDF」开始。
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
                      title={isOpen ? '收起这门课' : '展开这门课'}
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
                      （还没有套题）
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
                            title={`${m.answered}/${m.total} 题 · ${m.next_hint}`}
                          >
                            <span className="lec-unit-title">
                              Blatt {m.number}
                              {m.title ? ` · ${m.title}` : ''}
                            </span>
                            <span className="lec-unit-meta">
                              {m.answered}/{m.total} 题
                              {m.needs_fix ? ` · 待修 ${m.needs_fix}` : ''}
                              {dueText(m) ? ` · ${dueText(m)}` : ''}
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
              工具
            </div>
            <div style={{ padding: '0 8px 8px' }}>
              <button type="button" className="lec-btn" style={{ width: '100%', marginBottom: 6 }} onClick={() => sheet && openPdf('source_pdf')} disabled={!sheet?.source_pdf}>
                打开原卷 PDF
              </button>
              <button type="button" className="lec-btn" style={{ width: '100%', marginBottom: 6 }} onClick={() => void resplit(true)} disabled={!sheet || busy}>
                LLM 重新分块
              </button>
              <button type="button" className="lec-btn lec-btn-ghost" style={{ width: '100%', marginBottom: 6 }} onClick={() => void resplit(false)} disabled={!sheet || busy}>
                规则重新分块
              </button>
              <button type="button" className="lec-btn lec-btn-ghost" style={{ width: '100%', marginBottom: 6 }} onClick={() => void addProblem()} disabled={!sheet}>
                ＋ 添加题目
              </button>
              {sheet?.submitted_at ? (
                <button type="button" className="lec-btn lec-btn-ghost" style={{ width: '100%', marginBottom: 6 }} onClick={() => openPdf('submission', true)}>
                  下载上次提交包
                </button>
              ) : null}
              <button
                type="button"
                className="lec-btn lec-btn-ghost"
                style={{ width: '100%' }}
                onClick={() => void exportText()}
                disabled={busy}
                title="把全部习题导出成 markdown（确定性输出，方便 git diff）"
              >
                导出文本
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
                <div className="lec-empty-h">习题</div>
                <p>在<b>左边</b>选一套题，或点上方「导入 PDF」。</p>
                <p className="lec-hint">PDF 会由 LLM 拆成一道道题（识别不了就退回规则分块，再不行手补）。</p>
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
                    {progress?.answered ?? 0}/{progress?.total ?? 0} 题有答案 · 检查通过 {progress?.checked ?? 0}
                    {progress?.needsFix ? ` · 待修 ${progress.needsFix}` : ''}
                    {sheet.due ? ` · 截止 ${sheet.due}` : ''}
                    {sheet.submitted_at ? ` · 已生成提交包（${sheet.submission_pages} 页）` : ''}
                  </span>
                </div>

                {sheet.progress_digest && (
                  <div className="lec-digest">
                    <b>开这套题时的学习进度</b>
                    {sheet.progress_digest}
                  </div>
                )}
                {sheet.needs_manual_text && (
                  <div className="lec-nextstep">
                    PDF 抽不出可读文字（扫描版/公式为主）—— 请点每道题的「改题干」补上，或用「＋ 添加题目」。
                  </div>
                )}
                {sheet.next_hint && <div className="lec-nextstep">{sheet.next_hint}</div>}
                {printUrl && (
                  <div className="lec-nextstep">
                    没找到本机 Chrome/Edge，自动生成失败。
                    <button type="button" className="lec-btn lec-btn-ghost" style={{ marginLeft: 6 }} onClick={openPrint}>
                      打开打印页
                    </button>
                  </div>
                )}

                {sheet.problems.length === 0 && (
                  <div className="lec-empty">
                    这套题还没有题目 —— 用「＋ 添加题目」手填，或导入 PDF 让 LLM 拆题。
                  </div>
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
                        showToast(`已附上图片：${file.name}（检查时会一起发给爱弥斯）`);
                      } catch (e) {
                        showToast(`上传失败：${(e as Error).message}`);
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
                        showToast(`删除失败：${(e as Error).message}`);
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
                            ? '爱弥斯认错了 —— 已撤回那条批改'
                            : last?.outcome === 'upheld'
                              ? '她坚持原判，并给出了具体理由 —— 看下面的回复'
                              : '答辩完成 —— 各有对错，看她怎么说',
                        );
                      } catch (e) {
                        showToast(`答辩失败：${(e as Error).message}`);
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
              ∑ 符号
            </button>
            <button type="button" className="lec-sidetab" data-active={tab === 'mistakes' ? '1' : '0'} onClick={() => setTab('mistakes')}>
              错题本
            </button>
            <button type="button" className="lec-sidetab" data-active={tab === 'lessons' ? '1' : '0'} onClick={() => setTab('lessons')}>
              经验
            </button>
            <button type="button" className="lec-sidetab" data-active={tab === 'progress' ? '1' : '0'} onClick={() => setTab('progress')}>
              进度
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
                  这套题教会我什么（一句话一条）。写完点「同步 worldbook」，主 agent 以后能提起。
                </div>
                <textarea
                  className="lec-mistake-lesson"
                  placeholder="例如：角动量题先判守恒条件，再选轴 —— 轴选错一律白算。"
                  value={lessonDraft}
                  onChange={(e) => setLessonDraft(e.currentTarget.value)}
                />
                <div className="lec-toolrow">
                  <button type="button" className="lec-btn" onClick={() => void addLesson()} disabled={!lessonDraft.trim()}>
                    记下这条经验
                  </button>
                  <span className="lec-grow" />
                  <button type="button" className="lec-btn lec-btn-ghost" onClick={() => void syncWorldbook()} disabled={busy}>
                    同步 worldbook
                  </button>
                </div>

                {(sheet?.lessons.length ?? 0) === 0 && <div className="lec-empty">这套题还没有经验条目</div>}
                {sheet?.lessons.map((l) => (
                  <div key={l.id} className="lec-mistake">
                    <div className="lec-problem-head">
                      <span className="lec-badge">{l.in_worldbook ? '已进知识库' : '待同步'}</span>
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
                {!digest && <div className="lec-empty">选一门课才有进度</div>}
                {digest && (
                  <>
                    <div className="lec-hint">这就是每开一套新题时自动附上的摘要（也会进检查的 prompt）。</div>
                    <div className="lec-digest" style={{ marginTop: 0 }}>
                      {digest.digest || '（还没有历史记录）'}
                    </div>
                    <div className="lec-hint" style={{ marginTop: 10 }}>
                      <div>
                        题集：{digest.stats.sheetsSubmitted}/{digest.stats.sheetsTotal} 已提交
                      </div>
                      <div>
                        题目：{digest.stats.problemsAnswered}/{digest.stats.problemsTotal} 有答案
                      </div>
                      <div>检查通过：{digest.stats.checksPassed}</div>
                      <div>未掌握错题：{digest.stats.unmasteredMistakes}</div>
                    </div>
                    {digest.stats.topWeakTags.length > 0 && (
                      <div className="lec-toolrow">
                        {digest.stats.topWeakTags.map((t) => (
                          <span key={t} className="lec-badge">
                            {t}
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
