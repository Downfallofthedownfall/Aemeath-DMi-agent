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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

/** 输入框对外的命令式接口（符号键盘用）。 */
interface ComposerApi {
  insert(snippet: string): void;
  focus(): void;
}

/**
 * 一个可编辑的留白栏（我的理解 / 我的疑问）。
 *
 * 保存时机是**失焦**或 **Ctrl/Cmd+Enter**，不是每次按键 ——
 * 打字过程中反复写盘既浪费，又可能把半句话存进记忆。
 * 失焦保存也符合直觉：写完点别处就算存了。
 */
function BlankField({
  label,
  emptyHint,
  value,
  onSave,
}: {
  label: string;
  emptyHint: string;
  value: string;
  onSave: (next: string) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'err'>('idle');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // 外部值变化（切笔记、重新载入）时同步进来 —— 但**不要打断正在输入的草稿**
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(value);
  }, [value]);

  const save = useCallback(async (): Promise<void> => {
    if (draft === value) return; // 没改就不发请求
    setState('saving');
    try {
      await onSave(draft);
      setState('saved');
      window.setTimeout(() => setState('idle'), 1200);
    } catch {
      setState('err');
    }
  }, [draft, value, onSave]);

  const resize = useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [draft, resize]);

  return (
    <div className="lec-blank lec-blank-edit" data-empty={draft.trim() ? '0' : '1'}>
      <b>{label}</b>
      <textarea
        ref={ref}
        className="lec-blank-input"
        rows={1}
        placeholder={emptyHint}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          resize();
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter 立刻保存（不想离开输入框时）
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
            ref.current?.blur();
          }
        }}
      />
      <span className="lec-blank-state" data-tone={state}>
        {state === 'saving' ? '保存中…' : state === 'saved' ? '已保存' : state === 'err' ? '保存失败' : ''}
      </span>
    </div>
  );
}

/** 右栏放什么。 */
type RightTab = 'symbols' | 'review';

/**
 * 速记输入框（中栏底部）。
 *
 * 设计取舍（都是真机反馈定的）：
 *   · **不嵌 dsh 的对话区**。用户原话："不要把整个主agent塞进去啊，
 *     放一个输入框就完了，反正固定physicist也用不到其他乱七八糟的功能，
 *     也不要分屏，本来中间的区域就有很多空闲放一个输入框就行了。"
 *   · **不经过 LLM**。上课现场在听讲，等模型回一轮太慢；
 *     而且课堂内 LLM 的输出按设计（D3）只在后端、前端不剧透。
 *     所以直接落盘（与 lecture_capture 工具同一个 store）。
 *   · **Enter 发送 / Shift+Enter 换行**（和一般聊天框一致，不用学）。
 *   · 自动长高（最多 ~10 行），免得中栏被输入框吃掉。
 */
function Composer({
  disabled,
  onSend,
  apiRef,
}: {
  disabled: boolean;
  onSend: (text: string) => Promise<void>;
  /**
   * 暴露给父组件的命令式接口 —— 供**符号键盘**往光标处插入。
   *
   * 为什么要 ref 而不是受控 state：符号面板在右栏、输入框在中栏，
   * 是两个兄弟子树；要"插到光标位置"就必须直接操作那个 textarea
   *（受控值 + 光标位置很难正确同步，尤其是中间已经有一段选中的文本时）。
   */
  apiRef?: { current: ComposerApi | null };
}): JSX.Element {
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // 自动长高：先归零再按 scrollHeight 设，否则删字时不会回缩
  const resize = useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);

  // 把插入能力暴露出去。依赖里带 text，保证闭包拿到的是最新值。
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      insert(snippet: string): void {
        const el = ref.current;
        if (!el) return;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        const next = el.value.slice(0, start) + snippet + el.value.slice(end);
        setText(next);
        // 光标落到插入内容之后（下一帧，等 React 渲染完新值）
        requestAnimationFrame(() => {
          const pos = start + snippet.length;
          el.focus();
          el.setSelectionRange(pos, pos);
          resize();
        });
      },
      focus(): void {
        ref.current?.focus();
      },
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, resize]);

  const submit = useCallback(async (): Promise<void> => {
    const v = text.trim();
    if (!v || disabled) return;
    setText('');
    setHint('');
    // 先清空再发送：现场速记不能因为网络慢就卡住输入
    requestAnimationFrame(resize);
    try {
      await onSend(v);
      setHint('已记下');
      window.setTimeout(() => setHint(''), 1200);
    } catch (e) {
      // 失败要把内容还给用户，不能吞
      setText(v);
      setHint(`没记上：${(e as Error).message}`);
      requestAnimationFrame(resize);
    }
  }, [text, disabled, onSend, resize]);

  return (
    <div className="lec-composer">
      <textarea
        ref={ref}
        className="lec-composer-input"
        rows={2}
        placeholder="在这里记 —— 写下你听到的内容，Enter 记下，Shift+Enter 换行"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          resize();
        }}
        onKeyDown={(e) => {
          // Enter 发送；Shift+Enter 换行；输入法组合中不拦截
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="lec-composer-row">
        <span className="lec-composer-hint" data-tone={hint.startsWith('没记上') ? 'err' : 'ok'}>
          {hint}
        </span>
        <button
          type="button"
          className="lec-composer-send"
          onClick={() => void submit()}
          disabled={disabled || !text.trim()}
        >
          {disabled ? '记录中…' : '记下'}
        </button>
      </div>
    </div>
  );
}

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
  /**
   * 每门课的折叠状态：`{ [courseId]: 是否收起 }`。
   *
   * 真机反馈："左边课程最好加一个折叠，免得到时候几十上百节课都列出来了"。
   * 未记录的课程按"当前选中那门展开、其余收起"处理（见渲染处）。
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /**
   * 中栏输入框的命令式句柄 —— 符号键盘点一下要能**插到光标处**。
   *
   * 用户要求："符号键盘可以做点击就直接输入输入框，不过复制也保留挺好用的"
   * → 点一下**同时**做两件事：插入 + 复制。想粘到别处也行，不用选。
   */
  const composerApi = useRef<ComposerApi | null>(null);
  const [starting, setStarting] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCourseId, setNewCourseId] = useState('');
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [newSemester, setNewSemester] = useState('');
  /** 开课时是"新建一门课"还是"记到已有课"。有课程时默认后者。 */
  const [newCourseMode, setNewCourseMode] = useState(false);
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

  /**
   * 开一节新课。
   *
   * 两种模式（真机反馈："大的课程章节也加不了"）：
   *   · 记到已有课程 → 用当前选中的 courseId，只建单元
   *   · 新建一门课程 → 用表单里的 course_id 建课程，再建第一个单元
   */
  const startLecture = async (): Promise<void> => {
    const t = newTitle.trim();
    if (!t) {
      setErr('请填这次课的主题');
      return;
    }
    const makingCourse = !hasCourses || newCourseMode;
    const cid = makingCourse ? newCourseId.trim() : courseId;
    if (!cid) {
      setErr(makingCourse ? '请填课程标识（例如 physik-2）' : '先选一门课程');
      return;
    }
    if (makingCourse && !/^[A-Za-z0-9._-]+$/.test(cid)) {
      setErr('课程标识只能用字母、数字、点、下划线、连字符（它会成为目录名）');
      return;
    }
    setBusy(true);
    setErr('');
    const r = await postJson<{ ok: boolean; error?: string; course_id?: string; unit_id?: string }>(API, {
      action: 'start',
      course_id: cid,
      title: t,
      // 只在**新建课程**时传课程元数据；记到已有课程时传了会覆盖已有标题
      course_title: makingCourse ? newCourseTitle.trim() || undefined : undefined,
      semester: makingCourse ? newSemester.trim() || undefined : undefined,
    });
    setBusy(false);
    if (!r?.ok) {
      setErr(r?.error ?? '开课失败');
      return;
    }
    setNewTitle('');
    setNewCourseId('');
    setNewCourseTitle('');
    setNewSemester('');
    await refresh();
    if (r.course_id) setCourseId(r.course_id);
    if (r.unit_id) setUnitId(r.unit_id);
    setStarting(false);
    setNewCourseMode(false);
  };

  const hasCourses = courses.length > 0;

  // ── 删除 ──
  // 真机反馈：测试笔记删不掉（早先一个删除入口都没有）。
  // 删除是**不可逆**的，所以一律二次确认；确认文案写清"删什么、删多少"。
  const [deleting, setDeleting] = useState('');

  /**
   * 改一块的留白。失败时**抛错**（BlankField 据此显示"保存失败"），
   * 不静默 —— 用户以为写上了、实际没存，比报错更糟。
   */
  const saveBlank = async (
    seq: number,
    patch: { my_understanding?: string; my_question?: string },
  ): Promise<void> => {
    const r = await fetch(API, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'blanks', course_id: courseId, unit_id: unitId, seq, ...patch }),
    });
    const d = (await r.json()) as { ok?: boolean; error?: string };
    if (!r.ok || !d.ok) throw new Error(d.error ?? `保存失败 (${r.status})`);
    await loadUnit(courseId, unitId);
  };

  const deleteUnit = async (course: string, unit: string, unitTitle: string): Promise<void> => {
    if (!window.confirm(`删除「${unitTitle}」？\n\n这一讲的速记、加工结果、复盘记录都会一并删除，无法撤销。`)) return;
    setDeleting(unit);
    const r = await postJson<{ ok: boolean; error?: string }>(API, {
      action: 'delete',
      scope: 'unit',
      course_id: course,
      unit_id: unit,
    });
    setDeleting('');
    if (!r?.ok) {
      setErr(r?.error ?? '删除失败');
      return;
    }
    // 删掉的正是当前选中项 → 清空选择，让界面回到"还没有选中"的状态
    if (course === courseId && unit === unitId) {
      setUnitId('');
      setChunks([]);
    }
    await refresh();
  };

  const deleteCourse = async (course: string, title: string, unitCount: number): Promise<void> => {
    if (
      !window.confirm(
        `删除整门课程「${title}」？\n\n` +
          `包括 ${unitCount} 讲的全部笔记、加工结果与复盘记录，无法撤销。`,
      )
    ) {
      return;
    }
    setDeleting(course);
    const r = await postJson<{ ok: boolean; error?: string }>(API, {
      action: 'delete',
      scope: 'course',
      course_id: course,
    });
    setDeleting('');
    if (!r?.ok) {
      setErr(r?.error ?? '删除失败');
      return;
    }
    if (course === courseId) {
      setCourseId('');
      setUnitId('');
      setChunks([]);
    }
    await refresh();
  };

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
            {courses.map((c) => {
              // 每门课独立折叠（真机反馈："左边课程最好加一个折叠，
              // 免得到时候几十上百节课都列出来了"）。
              //
              // 默认：**当前选中的那门课展开**，其余收起 ——
              // 这样一眼看到自己在上的课，又不会被上百门课淹没。
              // 用户手动开合过的以本地状态为准。
              const isOpen = collapsed[c.course_id] !== undefined
                ? !collapsed[c.course_id]
                : c.course_id === courseId;
              return (
                <div key={c.course_id} className="lec-course">
                  <div className="lec-course-name" title={c.course_id}>
                    <button
                      type="button"
                      className="lec-course-toggle"
                      aria-expanded={isOpen}
                      title={isOpen ? '收起这门课' : '展开这门课'}
                      onClick={() =>
                        setCollapsed((prev) => ({
                          ...prev,
                          [c.course_id]: isOpen, // 存"是否收起"
                        }))
                      }
                    >
                      {isOpen ? '▾' : '▸'}
                    </button>
                    <span
                      className="lec-course-title"
                      onClick={() => setCollapsed((prev) => ({ ...prev, [c.course_id]: isOpen }))}
                    >
                      {c.title}
                      {c.semester ? <span className="lec-course-sem">{c.semester}</span> : null}
                      {/* 收起时也让人知道里面有几节 */}
                      {!isOpen && c.units.length ? (
                        <span className="lec-course-count">{c.units.length}</span>
                      ) : null}
                    </span>
                    {/* 删整门课（悬停才明显，避免误点） */}
                    <button
                      type="button"
                      className="lec-del lec-del-course"
                      title={`删除整门课程「${c.title}」`}
                      disabled={deleting === c.course_id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteCourse(c.course_id, c.title, c.units.length);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  {isOpen && c.units.length === 0 ? (
                    <div className="lec-hint" style={{ padding: '2px 10px 6px' }}>
                      （还没有课堂记录）
                    </div>
                  ) : null}
                  {isOpen
                    ? c.units.map((u) => (
                        <div key={u.id} className="lec-unit-row">
                          <button
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
                            </span>
                          </button>
                          <button
                            type="button"
                            className="lec-del"
                            title={`删除「${u.title}」`}
                            disabled={deleting === `${c.course_id}/${u.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void deleteUnit(c.course_id, u.id, u.title);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ))
                    : null}
                </div>
              );
            })}
          </aside>
        ) : null}

        {/* ── 中栏：笔记主体 ── */}
        <main className="lec-wb-main">
          {/* 笔记区：自己滚动（输入框钉在下面，不跟着滚） */}
          <div className="lec-wb-scroll">
          {starting ? (
            <div className="lec-startbox">
              <div className="lec-wb-h">开始新的一节课</div>

              {/* 真机反馈："大的课程章节也加不了，只能加小节" ——
                  早先这里只在**一门课都没有**时才显示"新建课程"表单，
                  有一门课后就永远只能往那门课里加小节。
                  现在改成显式二选一：记到已有课程 / 新建一门课程。 */}
              {hasCourses ? (
                <div className="lec-actions" style={{ marginTop: 0 }}>
                  <button
                    type="button"
                    className="lec-tab"
                    data-active={newCourseMode ? '0' : '1'}
                    onClick={() => setNewCourseMode(false)}
                  >
                    记到已有课程
                  </button>
                  <button
                    type="button"
                    className="lec-tab"
                    data-active={newCourseMode ? '1' : '0'}
                    onClick={() => setNewCourseMode(true)}
                  >
                    新建一门课程
                  </button>
                </div>
              ) : null}

              {!hasCourses || newCourseMode ? (
                <>
                  <div className="lec-label">课程标识（英文/数字，会做文件夹名）</div>
                  <input
                    className="lec-input"
                    value={newCourseId}
                    onChange={(e) => setNewCourseId(e.target.value)}
                    placeholder="physik-2"
                  />
                  <div className="lec-label">课程全名</div>
                  <input
                    className="lec-input"
                    value={newCourseTitle}
                    onChange={(e) => setNewCourseTitle(e.target.value)}
                    placeholder="Physik II"
                  />
                  <div className="lec-label">学期</div>
                  <input
                    className="lec-input"
                    value={newSemester}
                    onChange={(e) => setNewSemester(e.target.value)}
                    placeholder="WiSe 2026"
                  />
                </>
              ) : (
                <>
                  <div className="lec-label">记到哪门课</div>
                  <select className="lec-select" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                    {courses.map((c) => (
                      <option key={c.course_id} value={c.course_id}>
                        {c.title}（{c.units.length} 讲）
                      </option>
                    ))}
                  </select>
                </>
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
                笔记在<b>下面的输入框</b>里记：写下你听到的内容，Enter 记下。
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
                  在<b>下面的输入框</b>里直接写下你听到的内容即可（Enter 记下）。
                </div>
              ) : null}
              <div className="lec-notechunks">
                {chunks.map((c) => (
                  <div key={c.seq} className="lec-note">
                    <div className="lec-note-num">#{c.seq + 1}</div>
                    <pre className="lec-pre">{c.raw}</pre>
                    <div className="lec-note-blanks">
                      {/* 留白**可编辑**（真机反馈："笔记的理解和疑问目前无法输入"）。
                          早先只是只读展示。
                          保存时机：失焦 或 Ctrl/Cmd+Enter —— 不在每次按键时发请求，
                          免得打字过程中反复写盘，也免得半句话被存进记忆。 */}
                      <BlankField
                        label="我的理解"
                        emptyHint="（点这里写 —— 这段讲了什么？）"
                        value={c.my_understanding}
                        onSave={(v) => saveBlank(c.seq, { my_understanding: v })}
                      />
                      <BlankField
                        label="我的疑问"
                        emptyHint="（点这里写 —— 哪里还没搞懂？）"
                        value={c.my_question}
                        onSave={(v) => saveBlank(c.seq, { my_question: v })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          </div>

          {/* ── 速记输入框 ──
              用户原话："本来中间的区域就有很多空闲放一个输入框就行了"。
              所以不嵌 dsh 的对话区、也不分屏 —— 就一个自己的输入框。

              为什么**不经过 LLM**：上课现场在听讲，等模型回一轮太慢，
              而且课堂内 LLM 的输出按设计（D3）只在后端出现、前端不剧透。
              所以这里直接把原文落盘（与 lecture_capture 工具同一个 store）。

              留白（[我的理解]/[我的疑问]）**不在这里填** ——
              那是复盘阶段的事（D12），现场没时间写；服务端也不再强制。 */}
          {!starting && unitId ? (
            <Composer
              disabled={busy}
              apiRef={composerApi}
              onSend={async (text) => {
                setBusy(true);
                try {
                  const r = await fetch(API, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      action: 'chunk',
                      course_id: courseId,
                      unit_id: unitId,
                      chunk: { raw: text },
                    }),
                  });
                  const data = (await r.json()) as { ok?: boolean; error?: string };
                  if (!r.ok || !data.ok) throw new Error(data.error ?? `落盘失败 (${r.status})`);
                  await loadUnit(courseId, unitId);
                } catch (e) {
                  window.alert(`没能记下来：${(e as Error).message}`);
                } finally {
                  setBusy(false);
                }
              }}
            />
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
            {right === 'symbols' ? (
              <SymbolPanel
                onInsert={(snippet) => {
                  composerApi.current?.insert(snippet);
                }}
              />
            ) : null}
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
