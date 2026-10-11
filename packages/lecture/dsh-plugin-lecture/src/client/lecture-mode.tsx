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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type Tab = 'capture' | 'review' | 'courses';

/**
 * @param standalone 是否跑在**独立窗口**里。
 *   true  → 整窗铺满（没有"收起到侧边"按钮，因为是自己的窗口）
 *   false → 主窗口里的侧边面板（可收成窄条）
 */
export function LectureMode({ onClose, standalone = false }: { onClose: () => void; standalone?: boolean }): JSX.Element {
  const [tab, setTab] = useState<Tab>('capture');
  const [collapsed, setCollapsed] = useState(false);
  const [courses, setCourses] = useState<CourseView[]>([]);
  const [courseId, setCourseId] = useState<string>('');
  const [unitId, setUnitId] = useState<string>('');
  const [chunks, setChunks] = useState<RawChunk[]>([]);
  const [loading, setLoading] = useState(false);

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

  const onSubmitted = useCallback(async () => {
    await loadUnit(courseId, unitId);
    await refreshCourses();
  }, [courseId, unitId, loadUnit, refreshCourses]);

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
        <button type="button" className="lec-tab" data-active={tab === 'capture' ? '1' : '0'} onClick={() => setTab('capture')}>
          记录
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
        <button type="button" className="lec-tab" data-active={tab === 'courses' ? '1' : '0'} onClick={() => setTab('courses')}>
          课程
        </button>
      </div>

      <div className="lec-body">
        {/* 课程 / 单元选择（紧凑下拉，不占侧栏） */}
        {tab !== 'courses' && courses.length > 0 ? (
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

        {tab === 'capture' ? (
          courses.length === 0 ? (
            <div className="lec-empty">
              还没有课程。
              <br />
              在对话里让爱弥斯调用 <code>lecture_session_start</code> 开始一节课，
              然后回到这里记速记。
            </div>
          ) : !currentUnit ? (
            <div className="lec-empty">这一讲还没有记录。先在对话里 lecture_session_start 开始。</div>
          ) : (
            <CapturePanel courseId={courseId} unitId={unitId} chunks={chunks} loading={loading} onSubmitted={onSubmitted} />
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

        {tab === 'courses' ? <CoursesPanel courses={courses} /> : null}
      </div>
    </div>
  );
}

// ---------- 速记面板 ----------

function CapturePanel(props: {
  courseId: string;
  unitId: string;
  chunks: RawChunk[];
  loading: boolean;
  onSubmitted: () => Promise<void>;
}): JSX.Element {
  const { courseId, unitId, chunks, loading, onSubmitted } = props;
  const rawRef = useRef<HTMLTextAreaElement | null>(null);
  const understandingRef = useRef<HTMLTextAreaElement | null>(null);
  const questionRef = useRef<HTMLTextAreaElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [symOpen, setSymOpen] = useState(false);

  const submit = async (): Promise<void> => {
    const raw = rawRef.current?.value ?? '';
    const understanding = understandingRef.current?.value ?? '';
    const question = questionRef.current?.value ?? '';
    const missing: string[] = [];
    if (!raw.trim()) missing.push('速记内容');
    if (!understanding.trim()) missing.push('[我的理解]');
    if (!question.trim()) missing.push('[我的疑问]');
    if (missing.length) {
      setErr(`还差：${missing.join('、')}`);
      setOkMsg('');
      return;
    }
    setBusy(true);
    setErr('');
    setOkMsg('');
    const r = await postJson<{ ok: boolean; error?: string }>(API, {
      action: 'chunk',
      course_id: courseId,
      unit_id: unitId,
      chunk: { raw, my_understanding: understanding, my_question: question },
    });
    setBusy(false);
    if (!r?.ok) {
      setErr(r?.error ?? '提交失败');
      return;
    }
    if (rawRef.current) rawRef.current.value = '';
    if (understandingRef.current) understandingRef.current.value = '';
    if (questionRef.current) questionRef.current.value = '';
    setOkMsg('已记录。加工在后台进行，结果不会显示——留给复盘时你自己先说。');
    await onSubmitted();
  };

  return (
    <div>
      <p className="lec-hint">
        标记语法：<span className="lec-chip"># 主题</span> <span className="lec-chip">= 公式</span>{' '}
        <span className="lec-chip">? 疑问</span> <span className="lec-chip">! 重点</span>{' '}
        <span className="lec-chip">&gt; 例子</span> <span className="lec-chip">--- 分块</span>
      </p>

      <textarea
        ref={rawRef}
        className="lec-input lec-shorthand"
        placeholder={'# 角动量定义\n= L = r⃗ × p⃗ = Iω\n! 定轴转动才可写成 Iω\n? 为什么必须有对称轴'}
      />

      <div className="lec-toolbar">
        <button
          type="button"
          className="lec-symbtn"
          data-open={symOpen ? '1' : '0'}
          onClick={() => setSymOpen((v) => !v)}
          title="数学符号（∫ √ 三角函数 ∑ 上下限 …）"
        >
          ∑ 符号
        </button>
        <span className="lec-hint" style={{ margin: 0 }}>
          {symOpen ? '点符号插入到光标处；带插槽的按 Tab 跳下一个' : '打不出的符号从这里插'}
        </span>
      </div>
      {symOpen ? <SymbolPanel /> : null}

      <div className="lec-label">
        <span className="lec-req">*</span>我的理解
      </div>
      <textarea ref={understandingRef} className="lec-input lec-small" placeholder="用自己的话说这段讲了什么" />

      <div className="lec-label">
        <span className="lec-req">*</span>我的疑问
      </div>
      <textarea ref={questionRef} className="lec-input lec-small" placeholder="还没搞懂的地方（不填不继续）" />

      <div className="lec-actions">
        <button type="button" className="lec-btn" disabled={busy} onClick={() => void submit()}>
          {busy ? '记录中…' : '记录这一块'}
        </button>
      </div>

      {err ? <div className="lec-warn">{err}</div> : null}
      {okMsg ? <div className="lec-ok">{okMsg}</div> : null}

      <div className="lec-label">
        已记录 {chunks.length} 块{loading ? '（载入中…）' : ''}
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
      {chunks.length === 0 && !loading ? <div className="lec-hint">还没有速记块。</div> : null}
    </div>
  );
}

// ---------- 课程总览 ----------

function CoursesPanel({ courses }: { courses: CourseView[] }): JSX.Element {
  if (courses.length === 0) {
    return (
      <div className="lec-empty">
        还没有课程。
        <br />
        在对话里让爱弥斯调用 <code>lecture_session_start</code> 开始一节课。
      </div>
    );
  }
  const total = courses.reduce((n, c) => n + c.units.length, 0);
  const reviewed = courses.reduce((n, c) => n + c.units.filter((u) => u.reviewed).length, 0);
  return (
    <div>
      <div className="lec-notice">
        共 {courses.length} 门课程 · {total} 讲 · 已复盘 {reviewed} 讲
        {total > 0 ? `（${Math.round((reviewed / total) * 100)}%）` : ''}
      </div>
      {courses.map((c) => {
        const done = c.units.filter((u) => u.reviewed).length;
        return (
          <div key={c.course_id} className="lec-card">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{c.title}</strong>
              <span className="lec-hint" style={{ margin: 0 }}>
                {done}/{c.units.length}
              </span>
            </div>
            <div className="lec-meta">
              {c.semester || '（未标学期）'}
              {c.module_code ? ` · ${c.module_code}` : ''}
            </div>
            <ul style={{ margin: '7px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.8 }}>
              {c.units.map((u) => (
                <li key={u.id}>
                  {u.date} · {u.title}
                  {u.reviewed ? ' ✓' : ''}
                  {u.blanks_ok ? '' : ' ⚠留白未齐'}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
