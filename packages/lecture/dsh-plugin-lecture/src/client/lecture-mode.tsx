// ============================================================
// client/lecture-mode.tsx — 课堂记录模式（右侧停靠面板）
//
// 形态（用户定案 2026-10-11）：**另外的窗口，放在边上** ——
//   不是全屏层（会遮死对话），而是右侧停靠面板，可折叠成窄条。
//
// 三个页签：
//   · 课堂记录：速记输入（标记语法）+ 强制留白 + **折叠式符号面板**
//   · 课后复盘：五步状态机
//   · 课程总览：课程分类归纳
//
// ⚠️ D3 边界（本文件最重要的约束）：
//   界面**绝不显示 LLM 加工结果**。后端 GET 也不返回（见 http.ts 的 findLeakedKeys）。
//   本文件里没有任何读 `.raw.json` 的代码路径。
//
// 数据来源：同源代理 /aemeath/api/lecture（前端不持有 token）。
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SymbolPanel } from './symbol-palette.tsx';
import { ReviewPanel } from './review-panel.tsx';
import { LECTURE_CLASS } from './styles.ts';

// ---------- 类型（与 host http.ts 的视图对齐） ----------

interface UnitView {
  id: string;
  date: string;
  title: string;
  reviewed: boolean;
  has_summary: boolean;
  chunk_count: number;
  blanks_ok: boolean;
}

interface CourseView {
  course_id: string;
  title: string;
  semester: string;
  module_code: string;
  units: UnitView[];
}

interface RawChunk {
  seq: number;
  raw: string;
  my_understanding: string;
  my_question: string;
  created_at: number;
}

// ---------- 数据层 ----------

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    return (await res.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

const API = '/aemeath/api/lecture';

// ---------- 主组件 ----------

type Tab = 'start' | 'notes' | 'review';

/**
 * @param standalone 是否跑在**独立窗口**里。
 *   true  → 整窗铺满（没有"收起到侧边"按钮，因为是自己的窗口）
 *   false → 主窗口里的侧边面板（可收成窄条）
 */
export function LectureMode({ onClose, standalone = false }: { onClose: () => void; standalone?: boolean }): JSX.Element {
  // 页签：开课 / 查阅 / 复盘。
  //
  // ⚠️ 产品设计的修正（真机反馈后）：
  //    早先侧栏把"速记输入"也包了进来，但**开课只能靠对话里调工具**，
  //    于是第一次打开只看到一句"还没有课程"，既没有输入框也不知道下一步 —— 死路。
  //    现在：**侧栏负责开课与查阅**，实际记笔记在主界面的对话里（agent 调 lecture_capture）。
  const [tab, setTab] = useState<Tab>('start');
  const [collapsed, setCollapsed] = useState(false);
  const [courses, setCourses] = useState<CourseView[]>([]);
  const [courseId, setCourseId] = useState<string>('');
  const [unitId, setUnitId] = useState<string>('');
  const [chunks, setChunks] = useState<RawChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [symOpen, setSymOpen] = useState(false);

  const refreshCourses = useCallback(async () => {
    const d = await getJson<{ ok: boolean; courses: CourseView[] }>(`${API}?action=courses`);
    if (d?.courses) {
      setCourses(d.courses);
      setCourseId((cur) => cur || d.courses[0]?.course_id || '');
      setUnitId((cur) => cur || d.courses[0]?.units[0]?.id || '');
    }
  }, []);

  useEffect(() => {
    void refreshCourses();
  }, [refreshCourses]);

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

  /** 开课成功后：刷新列表、选中新单元、跳到「笔记」页。 */
  const onStarted = useCallback(
    async (newCourseId: string, newUnitId: string) => {
      await refreshCourses();
      setCourseId(newCourseId);
      setUnitId(newUnitId);
      setTab('notes');
    },
    [refreshCourses],
  );

  // —— 收起态：只留一条窄边，点它展开（仅面板模式用；独立窗口不收） ——
  if (collapsed && !standalone) {
    return (
      <div className={LECTURE_CLASS} data-collapsed="1">
        <div className="lec-top">
          <button type="button" className="lec-icon-btn" title="展开课堂记录" onClick={() => setCollapsed(false)}>
            ‹
          </button>
        </div>
        <div className="lec-collapsed-hint" onClick={() => setCollapsed(false)}>
          课堂记录
        </div>
      </div>
    );
  }

  return (
    <div className={LECTURE_CLASS} data-standalone={standalone ? '1' : '0'}>
      {/* 顶栏（40px 顶部让位给 Electron 原生窗口按钮） */}
      <div className="lec-top">
        <span className="lec-title">课堂记录</span>
        <span className="lec-sub">
          {currentUnit ? `${currentCourse?.title ?? courseId} · ${currentUnit.title}` : '未选择课程'}
        </span>
        <span className="lec-grow" />
        {standalone ? null : (
          <button type="button" className="lec-icon-btn" title="收起到侧边" onClick={() => setCollapsed(true)}>
            ›
          </button>
        )}
        <button type="button" className="lec-icon-btn" title={standalone ? '关闭窗口' : '关闭'} onClick={onClose}>
          ✕
        </button>
      </div>

      {/* 页签（独立一行） */}
      <div className="lec-tabs">
        <button type="button" className="lec-tab" data-active={tab === 'start' ? '1' : '0'} onClick={() => setTab('start')}>
          开课
        </button>
        <button
          type="button"
          className="lec-tab"
          data-active={tab === 'notes' ? '1' : '0'}
          onClick={() => setTab('notes')}
          disabled={courses.length === 0}
          title={courses.length ? '查阅已记录的笔记' : '还没有课程'}
        >
          笔记
        </button>
        <button
          type="button"
          className="lec-tab"
          data-active={tab === 'review' ? '1' : '0'}
          onClick={() => setTab('review')}
          disabled={!currentUnit}
          title={currentUnit ? '课后复盘' : '先选择一讲'}
        >
          复盘
        </button>
      </div>

      <div className="lec-body">
        {/* 课程 / 单元选择（紧凑下拉，不占侧栏）。
            开课页不需要它（那里有专门的课程选择）。 */}
        {tab !== 'start' && courses.length > 0 ? (
          <select
            className="lec-select"
            value={`${courseId}::${unitId}`}
            onChange={(e) => {
              const [c, u] = e.target.value.split('::');
              setCourseId(c ?? '');
              setUnitId(u ?? '');
            }}
          >
            {courses.flatMap((c) =>
              c.units.length
                ? c.units.map((u) => (
                    <option key={`${c.course_id}::${u.id}`} value={`${c.course_id}::${u.id}`}>
                      {c.title} · {u.title}
                      {u.reviewed ? ' ✓' : ''}
                    </option>
                  ))
                : [
                    <option key={`${c.course_id}::`} value={`${c.course_id}::`}>
                      {c.title}（还没有课堂记录）
                    </option>,
                  ],
            )}
          </select>
        ) : null}

        {tab === 'start' ? <StartPanel courses={courses} onStarted={onStarted} defaultCourseTitle={currentCourse?.title ?? ''} /> : null}

        {tab === 'notes' ? (
          currentUnit ? (
            <NotesView courseId={courseId} unitId={unitId} chunks={chunks} loading={loading} />
          ) : (
            <div className="lec-empty">
              还没有笔记。
              <br />
              先去「开课」创建一节课。
            </div>
          )
        ) : null}

        {tab === 'review' ? (
          currentUnit ? (
            <ReviewPanel
              courseId={courseId}
              unitId={unitId}
              unitTitle={currentUnit.title}
              onFinished={async () => {
                await refreshCourses();
              }}
            />
          ) : (
            <div className="lec-empty">先选择一讲。</div>
          )
        ) : null}

        {/* 数学符号键盘：折叠式，点符号**复制到剪贴板**（再到主界面对话框粘贴）。
            放在开课/笔记两页都能拿到 —— 上课时随手要抄符号。 */}
        {tab !== 'review' ? (
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              className="lec-symbtn"
              data-open={symOpen ? '1' : '0'}
              onClick={() => setSymOpen((v) => !v)}
              title="数学符号（∫ √ 三角函数 ∑ 上下限 …）"
            >
              ∑ 符号键盘
            </button>
            {symOpen ? <SymbolPanel /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------- 开课 ----------

/**
 * 「开课」面板：直接在这里创建课程与本次课，不再绕道对话。
 *
 * 设计修正（真机反馈后）：早先只能靠对话里叫 agent 调 lecture_session_start，
 * 于是用户打开课堂界面只看到"还没有课程"，既没有输入框也不知道下一步 —— 死路。
 * 现在界面自己就能开课，开完自动跳到「笔记」。
 */
function StartPanel(props: {
  courses: CourseView[];
  onStarted: (courseId: string, unitId: string) => Promise<void>;
  defaultCourseTitle: string;
}): JSX.Element {
  const { courses, onStarted, defaultCourseTitle } = props;
  // 已有课程时默认选"继续上一门"，只需填主题；没有课程时两个都要填。
  const [mode, setMode] = useState<'new' | 'continue'>(courses.length ? 'continue' : 'new');
  const [newCourseId, setNewCourseId] = useState('');
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [pickCourse, setPickCourse] = useState(courses[0]?.course_id ?? '');
  const [title, setTitle] = useState('');
  const [semester, setSemester] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // 课程列表异步加载完时，补正初值（首帧可能还是空数组）
  useEffect(() => {
    if (courses.length && !pickCourse) setPickCourse(courses[0]!.course_id);
    if (!courses.length) setMode('new');
  }, [courses, pickCourse]);

  const start = async (): Promise<void> => {
    const isNew = mode === 'new' || courses.length === 0;
    const cid = isNew ? newCourseId.trim() : pickCourse;
    const t = title.trim();
    if (!cid) {
      setErr('请填课程标识（例如 physik-1）');
      return;
    }
    if (!t) {
      setErr('请填本次课的主题（例如 第3讲 角动量）');
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(cid)) {
      setErr('课程标识只能用字母、数字、点、下划线、连字符（它会成为目录名）');
      return;
    }
    setBusy(true);
    setErr('');
    const r = await postJson<{ ok: boolean; error?: string; course_id?: string; unit_id?: string }>(API, {
      action: 'start',
      course_id: cid,
      title: t,
      course_title: isNew ? newCourseTitle.trim() || cid : undefined,
      semester: semester.trim() || undefined,
    });
    setBusy(false);
    if (!r?.ok) {
      setErr(r?.error ?? '开课失败');
      return;
    }
    setTitle('');
    await onStarted(r.course_id ?? cid, r.unit_id ?? '');
  };

  return (
    <div>
      <p className="lec-hint">
        开一节课之后，就<b>在主界面的对话里</b>直接记笔记（爱弥斯会调用 <code>lecture_capture</code> 落盘）。
        这个边栏负责开课与事后查阅。
      </p>

      {courses.length > 0 ? (
        <div className="lec-actions" style={{ marginTop: 4 }}>
          <button
            type="button"
            className="lec-tab"
            data-active={mode === 'continue' ? '1' : '0'}
            onClick={() => setMode('continue')}
          >
            继续已有课程
          </button>
          <button type="button" className="lec-tab" data-active={mode === 'new' ? '1' : '0'} onClick={() => setMode('new')}>
            新建课程
          </button>
        </div>
      ) : null}

      {mode === 'continue' && courses.length > 0 ? (
        <>
          <div className="lec-label">课程</div>
          <select className="lec-select" value={pickCourse} onChange={(e) => setPickCourse(e.target.value)}>
            {courses.map((c) => (
              <option key={c.course_id} value={c.course_id}>
                {c.title}（{c.units.length} 讲）
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <div className="lec-label">课程标识</div>
          <input
            className="lec-input"
            value={newCourseId}
            onChange={(e) => setNewCourseId(e.target.value)}
            placeholder="physik-1"
          />
          <div className="lec-label">课程全名</div>
          <input
            className="lec-input"
            value={newCourseTitle}
            onChange={(e) => setNewCourseTitle(e.target.value)}
            placeholder={defaultCourseTitle || 'Physik I'}
          />
          <div className="lec-label">学期</div>
          <input className="lec-input" value={semester} onChange={(e) => setSemester(e.target.value)} placeholder="WiSe 2026" />
        </>
      )}

      <div className="lec-label">
        <span className="lec-req">*</span>本次课主题
      </div>
      <input
        className="lec-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) void start();
        }}
        placeholder="第3讲 角动量"
      />

      <div className="lec-actions">
        <button type="button" className="lec-btn" disabled={busy} onClick={() => void start()}>
          {busy ? '开课中…' : '开始这节课'}
        </button>
      </div>

      {err ? <div className="lec-warn">{err}</div> : null}

      {courses.length > 0 ? (
        <>
          <div className="lec-label">已有课程</div>
          {courses.map((c) => (
            <div key={c.course_id} className="lec-card">
              <strong style={{ fontSize: 13 }}>{c.title}</strong>
              <div className="lec-meta">
                {c.course_id}
                {c.semester ? ` · ${c.semester}` : ''} · {c.units.length} 讲
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

// ---------- 笔记查阅 ----------

/**
 * 「笔记」面板：**只读**查阅已记录的速记块。
 *
 * 真机反馈定案：记笔记发生在主界面的对话里，侧栏不该再放一个重复的输入框
 * （既让人困惑"到底在哪记"，也把侧栏塞满）。
 */
function NotesView(props: { courseId: string; unitId: string; chunks: RawChunk[]; loading: boolean }): JSX.Element {
  const { chunks, loading, courseId, unitId } = props;
  if (loading) return <div className="lec-hint">载入中…</div>;
  if (chunks.length === 0) {
    return (
      <div className="lec-empty">
        这一讲还没有笔记。
        <br />
        回到主界面的对话里，直接写下你听到的内容即可。
      </div>
    );
  }
  return (
    <div>
      <div className="lec-notice">
        共 {chunks.length} 块 · <code>{courseId}</code> / <code>{unitId}</code>
        <br />
        这里只是查阅。要补记，回主界面对话说。
      </div>
      {chunks.map((c) => (
        <div key={c.seq} className="lec-card">
          <div className="lec-meta" style={{ marginTop: 0, marginBottom: 4 }}>
            #{c.seq + 1}
          </div>
          <pre className="lec-pre">{c.raw}</pre>
          <div className="lec-blank">
            <b>[我的理解]</b> {c.my_understanding || <em>（空）</em>}
          </div>
          <div className="lec-blank">
            <b>[我的疑问]</b> {c.my_question || <em>（空）</em>}
          </div>
        </div>
      ))}
    </div>
  );
}
