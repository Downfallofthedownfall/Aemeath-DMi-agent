// ============================================================
// client/workbench.tsx — 课堂学习工作台（三栏）
//
// 为什么重做（用户原话）：
//   "这和主 agent 前端一模一样不行啊，只保留 lecture 里面需要的东西
//    设计一个新的 GUI"
//
// 早先是把课堂塞进主 agent 的侧栏，外观、布局、信息架构全是主 agent 的，
// 只是换了个皮。课堂其实**不需要**会话列表、插件管理、工作区选择、
// 模型切换那一整套 —— 那些是通用 agent 的东西。
//
// 课堂真正需要的是三件事，于是三栏：
//   ┌──────────┬────────────────────┬──────────────┐
//   │ 课程/单元 │ 笔记（本次课）      │ 复盘 / 符号   │
//   │ 左栏导航  │ 中栏主区            │ 右栏工具      │
//   └──────────┴────────────────────┴──────────────┘
//
// 符号键盘**常驻右栏**（用户反馈："没看到按钮"）——
// 早先它藏在侧栏底部一个折叠按钮后面，找不到。现在它是一等公民。
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReviewPanel } from './review-panel.tsx';
import { SymbolPanel } from './symbol-palette.tsx';
import { LECTURE_CLASS } from './styles.ts';

const API = '/aemeath/api/lecture';

export interface CourseView {
  course_id: string;
  title: string;
  semester?: string;
  module_code?: string;
  units: { id: string; date: string; title: string; reviewed: boolean; has_summary: boolean; chunk_count: number }[];
}

export interface RawChunk {
  seq: number;
  raw: string;
  my_understanding: string;
  my_question: string;
  created_at?: number;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** 右栏放什么。 */
type RightTab = 'symbols' | 'review';

/**
 * 课堂工作台。
 *
 * @param standalone 独立窗口（铺满整窗）还是嵌在主 agent 里（侧栏弹层）。
 */
export function Workbench({ onClose, standalone = false }: { onClose: () => void; standalone?: boolean }): JSX.Element {
  const [courses, setCourses] = useState<CourseView[]>([]);
  const [courseId, setCourseId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [chunks, setChunks] = useState<RawChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [right, setRight] = useState<RightTab>('symbols');
  const [navOpen, setNavOpen] = useState(true);
  const [starting, setStarting] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCourseId, setNewCourseId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    const d = await getJson<{ ok: boolean; courses: CourseView[] }>(`${API}?action=courses`);
    if (!d?.courses) return;
    setCourses(d.courses);
    setCourseId((cur) => cur || d.courses[0]?.course_id || '');
    setUnitId((cur) => cur || d.courses[0]?.units[0]?.id || '');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadUnit = useCallback(async (c: string, u: string) => {
    if (!c || !u) {
      setChunks([]);
      return;
    }
    setLoading(true);
    const d = await getJson<{ ok: boolean; chunks: RawChunk[] }>(
      `${API}?action=unit&course=${encodeURIComponent(c)}&unit=${encodeURIComponent(u)}`,
    );
    setChunks(d?.chunks ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadUnit(courseId, unitId);
  }, [courseId, unitId, loadUnit]);

  const currentCourse = useMemo(() => courses.find((c) => c.course_id === courseId) ?? null, [courses, courseId]);
  const currentUnit = useMemo(() => currentCourse?.units.find((u) => u.id === unitId) ?? null, [currentCourse, unitId]);

  /** 开一节新课（在最上面那门课程下）。 */
  const startLecture = async (): Promise<void> => {
    const t = newTitle.trim();
    if (!t) {
      setErr('请填这次课的主题');
      return;
    }
    setBusy(true);
    setErr('');
    const cid = courseId || newCourseId.trim();
    if (!cid) {
      setBusy(false);
      setErr('先选一门课程，或填一个新课程标识');
      return;
    }
    const r = await postJson<{ ok: boolean; error?: string; course_id?: string; unit_id?: string }>(API, {
      action: 'start',
      course_id: cid,
      title: t,
      course_title: courses.some((c) => c.course_id === cid) ? undefined : newCourseId.trim() || cid,
    });
    setBusy(false);
    if (!r?.ok) {
      setErr(r?.error ?? '开课失败');
      return;
    }
    setNewTitle('');
    await refresh();
    if (r.course_id) setCourseId(r.course_id);
    if (r.unit_id) setUnitId(r.unit_id);
    setStarting(false);
  };

  const hasCourses = courses.length > 0;

  return (
    <div className={LECTURE_CLASS} data-standalone={standalone ? '1' : '0'} data-workbench="1">
      {/* 顶栏 */}
      <div className="lec-top">
        <button
          type="button"
          className="lec-icon-btn"
          title={navOpen ? '收起课程列表' : '展开课程列表'}
          onClick={() => setNavOpen((v) => !v)}
        >
          {navOpen ? '‹' : '›'}
        </button>
        <span className="lec-title">课堂</span>
        <span className="lec-sub">
          {currentUnit ? `${currentCourse?.title ?? courseId} · ${currentUnit.title}` : '还没有课程'}
        </span>
        <span className="lec-grow" />
        <button type="button" className="lec-btn-tiny" onClick={() => setStarting((v) => !v)} title="开始新的一节课">
          {starting ? '取消' : '＋ 新的一节'}
        </button>
        <button type="button" className="lec-icon-btn" title={standalone ? '关闭窗口' : '关闭'} onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="lec-wb">
        {/* ── 左栏：课程 / 单元 ── */}
        {navOpen ? (
          <aside className="lec-wb-nav">
            <div className="lec-wb-navhead">课程</div>
            {!hasCourses ? (
              <div className="lec-hint" style={{ padding: '0 10px' }}>
                还没有课程。
                <br />
                点右上角「＋ 新的一节」开始。
              </div>
            ) : null}
            {courses.map((c) => (
              <div key={c.course_id} className="lec-course">
                <div className="lec-course-name" title={c.course_id}>
                  {c.title}
                  {c.semester ? <span className="lec-course-sem">{c.semester}</span> : null}
                </div>
                {c.units.length === 0 ? (
                  <div className="lec-hint" style={{ padding: '2px 10px 6px' }}>
                    （还没有课堂记录）
                  </div>
                ) : null}
                {c.units.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="lec-unit"
                    data-active={c.course_id === courseId && u.id === unitId ? '1' : '0'}
                    onClick={() => {
                      setCourseId(c.course_id);
                      setUnitId(u.id);
                    }}
                    title={`${u.date} · ${u.chunk_count} 块`}
                  >
                    <span className="lec-unit-title">{u.title}</span>
                    <span className="lec-unit-meta">
                      {u.date.slice(5)}
                      {u.chunk_count ? ` · ${u.chunk_count}` : ''}
                      {u.reviewed ? ' ✓' : ''}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </aside>
        ) : null}

        {/* ── 中栏：笔记主体 ── */}
        <main className="lec-wb-main">
          {starting ? (
            <div className="lec-startbox">
              <div className="lec-wb-h">开始新的一节课</div>
              {!hasCourses ? (
                <>
                  <div className="lec-label">课程标识（英文/数字，会做文件夹名）</div>
                  <input
                    className="lec-input"
                    value={newCourseId}
                    onChange={(e) => setNewCourseId(e.target.value)}
                    placeholder="physik-1"
                  />
                </>
              ) : (
                <div className="lec-hint">
                  记到课程 <b>{currentCourse?.title ?? courseId}</b> 下。
                  （要换课程请先在左栏选中）
                </div>
              )}
              <div className="lec-label">这次课讲什么</div>
              <input
                className="lec-input"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void startLecture();
                }}
                placeholder="第3讲 角动量"
                autoFocus
              />
              <div className="lec-actions">
                <button type="button" className="lec-btn" disabled={busy} onClick={() => void startLecture()}>
                  {busy ? '开课中…' : '开始这节课'}
                </button>
              </div>
              {err ? <div className="lec-warn">{err}</div> : null}
            </div>
          ) : null}

          {!starting && !currentUnit ? (
            <div className="lec-empty lec-empty-big">
              <div className="lec-empty-h">课堂记录</div>
              <p>
                在<b>左边的课程列表</b>选一讲，或点右上角「＋ 新的一节」开始。
              </p>
              <p className="lec-hint">
                笔记在<b>主界面的对话里</b>记：直接写你听到的内容，爱弥斯会落盘到这里。
                <br />
                这一栏用来回看、补漏、对着复习。
              </p>
            </div>
          ) : null}

          {!starting && currentUnit ? (
            <>
              <div className="lec-notehead">
                <span className="lec-notehead-t">{currentUnit.title}</span>
                <span className="lec-notehead-d">{currentUnit.date}</span>
                <span className="lec-grow" />
                <span className="lec-hint">共 {chunks.length} 块</span>
              </div>
              {loading ? <div className="lec-hint">载入中…</div> : null}
              {!loading && chunks.length === 0 ? (
                <div className="lec-empty">
                  这一讲还没有笔记。
                  <br />
                  回到<b>主界面的对话</b>，直接写下你听到的内容即可。
                </div>
              ) : null}
              <div className="lec-notechunks">
                {chunks.map((c) => (
                  <div key={c.seq} className="lec-note">
                    <div className="lec-note-num">#{c.seq + 1}</div>
                    <pre className="lec-pre">{c.raw}</pre>
                    <div className="lec-note-blanks">
                      <div className="lec-blank" data-empty={c.my_understanding ? '0' : '1'}>
                        <b>我的理解</b>
                        <span>{c.my_understanding || '（还没写 —— 在对话里说说这段讲了什么）'}</span>
                      </div>
                      <div className="lec-blank" data-empty={c.my_question ? '0' : '1'}>
                        <b>我的疑问</b>
                        <span>{c.my_question || '（还没写 —— 哪里还没搞懂？）'}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </main>

        {/* ── 右栏：符号键盘 / 复盘 ── */}
        <aside className="lec-wb-side">
          <div className="lec-sidetabs">
            <button type="button" className="lec-sidetab" data-active={right === 'symbols' ? '1' : '0'} onClick={() => setRight('symbols')}>
              ∑ 符号
            </button>
            <button
              type="button"
              className="lec-sidetab"
              data-active={right === 'review' ? '1' : '0'}
              onClick={() => setRight('review')}
              disabled={!currentUnit}
              title={currentUnit ? '课后复盘' : '先选一讲'}
            >
              复盘
            </button>
          </div>
          <div className="lec-sidebody">
            {right === 'symbols' ? <SymbolPanel /> : null}
            {right === 'review' && currentUnit ? (
              <ReviewPanel
                courseId={courseId}
                unitId={unitId}
                unitTitle={currentUnit.title}
                onFinished={async () => {
                  await refresh();
                }}
              />
            ) : null}
            {right === 'review' && !currentUnit ? <div className="lec-hint">先选一讲。</div> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
