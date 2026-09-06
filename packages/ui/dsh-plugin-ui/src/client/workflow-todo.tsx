// ============================================================
// 解题计划浮卡（feature #5）——可拖动 / 可折叠 / 带进度。
// 借 Cyrene 的 TodoPanel + useFloatingCard 思想（拖动 handle + 折叠开关 +
//   进度条 + 可勾选条目），只用其"结构/交互"（指针拖动、折叠、进度 %），
//   用 Aemeath 自己的 t()/主题 token 实现；不复制其代码，也无 mascot 图片
//   （保持轻量、无 emoji）。
// 数据源：host GET /aemeath/api/memory 的 plans 字段——当前会话 workflow.plan
//   scratch 已解析好的步骤字符串数组（host 侧解析、未截断；见 index.ts）。
// 完成度：plan scratch 只存步骤字符串（无"完成"状态），故勾选是本地 UX 状态
//   （localStorage 按 sessionId 持久化）；进度 = 已勾选 / 总数。
// 持久化：卡片位置 + 折叠 + 隐藏状态均在 localStorage（UI 便捷，不写设置）。
// 形态：仅当当前会话存在非空计划且未隐藏时才渲染（无计划 → 隐藏，诚实空态）。
// 注册位：conversation.session.header.actions（会话作用域，获得 useSession）。
// ============================================================
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
import { t, useLocale } from './i18n.ts';

const CARD_WIDTH = 256;
const MIN_VISIBLE_HEIGHT = 52;
const POLL_MS = 4000;

// —— localStorage 持久化 key（UI 便捷；不掺入 settings）——
const POS_KEY = 'aemeath.todo.pos';
const COLLAPSED_KEY = 'aemeath.todo.collapsed';
const HIDDEN_KEY = 'aemeath.todo.hidden';
const DONE_KEY = 'aemeath.todo.done';

interface PlanPayload {
  ok?: boolean;
  plans?: Record<string, string[]>;
}

function readBool(key: string, def: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? def : raw === '1';
  } catch {
    return def;
  }
}

function writeBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* localStorage 不可用：忽略 */
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略 */
  }
}

function readPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    return { x: p.x, y: p.y };
  } catch {
    return null;
  }
}

function writePos(p: { x: number; y: number }): void {
  writeJson(POS_KEY, p);
}

function readDone(sessionId: string): Set<number> {
  const all = readJson<Record<string, number[]>>(DONE_KEY, {});
  const arr = all[sessionId] ?? [];
  return new Set(arr.filter((n) => typeof n === 'number'));
}

function writeDone(sessionId: string, done: Set<number>): void {
  const all = readJson<Record<string, number[]>>(DONE_KEY, {});
  all[sessionId] = [...done];
  writeJson(DONE_KEY, all);
}

function clampPos(p: { x: number; y: number }): { x: number; y: number } {
  if (typeof window === 'undefined') return p;
  return {
    x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - CARD_WIDTH)),
    y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - MIN_VISIBLE_HEIGHT)),
  };
}

/** 拉取当前会话的解题计划步骤（host 已解析 scratch workflow.plan；无 → 空数组）。 */
async function fetchPlan(sessionId: string): Promise<string[]> {
  if (!sessionId) return [];
  try {
    const res = await fetch('/aemeath/api/memory', { signal: AbortSignal.timeout(8000) });
    const d = (await res.json()) as PlanPayload;
    if (!res.ok || !d.ok || !d.plans) return [];
    const steps = d.plans[sessionId];
    return Array.isArray(steps) ? steps.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 浮卡主体（hooks 全在此；由外层零 hooks 组件保证 useSession 已提供）。 */
function WorkflowTodoCard({
  useSession,
}: {
  useSession: <S>(sel: (s: ConversationSnapshot) => S, eq?: (a: S, b: S) => boolean) => S;
}): JSX.Element | null {
  useLocale(); // locale 切换时刷新文案
  const sessionId = String(useSession((s) => s.sessionId ?? '') ?? '');

  const [steps, setSteps] = useState<string[]>([]);
  const [done, setDone] = useState<Set<number>>(() => readDone(sessionId));
  const [collapsed, setCollapsed] = useState<boolean>(() => readBool(COLLAPSED_KEY, false));
  const [hidden, setHidden] = useState<boolean>(() => readBool(HIDDEN_KEY, false));
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    const stored = readPos();
    if (stored) return stored;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
    return { x: Math.max(0, vw - CARD_WIDTH - 18), y: 24 };
  });
  const posRef = useRef(pos);
  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  // sessionId 变化时重置本地勾选态（按会话隔离）
  useEffect(() => {
    setDone(readDone(sessionId));
  }, [sessionId]);

  // 拉取当前会话计划：挂载即时一次 + 每 POLL_MS 轮询（plan_step 工具落 scratch 是渐进式的）
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void fetchPlan(sessionId).then((s) => {
        if (alive) setSteps(s);
      });
    };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  // 拖动：pointerdown 于标题栏开始，window pointermove/up 驱动移动 + 落位持久化。
  // 全程用 ref 保存拖动态（不触发额外 render），跟随 Cyrene 的指针拖动手法。
  const dragRef = useRef<{ startX: number; startY: number; initialX: number; initialY: number } | null>(null);
  const movedRef = useRef(false);
  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
      setPos(clampPos({ x: d.initialX + dx, y: d.initialY + dy }));
    };
    const up = (): void => {
      if (dragRef.current) {
        writePos(posRef.current);
        dragRef.current = null;
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-todo-toggle]') || target.closest('[data-todo-hide]')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, initialX: pos.x, initialY: pos.y };
    movedRef.current = false;
  };
  const onHeaderClick = (): void => {
    if (movedRef.current) return;
    const v = !collapsed;
    setCollapsed(v);
    writeBool(COLLAPSED_KEY, v);
  };

  const toggleStep = (i: number): void => {
    const next = new Set(done);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setDone(next);
    writeDone(sessionId, next);
  };
  const hide = (): void => {
    setHidden(true);
    writeBool(HIDDEN_KEY, true);
  };

  // 无计划 / 已隐藏 / 无会话 → 诚实空态（不渲染）
  if (hidden || !sessionId || steps.length === 0) return null;

  const completed = steps.reduce((n, _s, i) => n + (done.has(i) ? 1 : 0), 0);
  const progress = Math.round((completed / steps.length) * 100);

  const cardStyle: CSSProperties = {
    position: 'fixed',
    left: pos.x,
    top: pos.y,
    width: CARD_WIDTH,
    zIndex: 9990,
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 12,
    boxShadow: 'var(--fluent-shadow-md, 0 6px 18px rgba(0,0,0,0.12))',
    color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    cursor: 'grab',
    userSelect: 'none',
    background: 'var(--dsw-alias-bg-layer-3)',
    borderBottom: collapsed ? 'none' : '1px solid var(--dsw-alias-border-l1)',
  };

  return createPortal(
    <div className="aemeath-workflow-todo" style={cardStyle} role="region" aria-label={t('workflowtodo.title')}>
      {/* 标题栏 = 拖动 handle + 折叠开关 + 隐藏 */}
      <div style={headerStyle} onPointerDown={onHeaderPointerDown} onClick={onHeaderClick} title={t('workflowtodo.drag')}>
        <span style={{ flex: 'none', fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }}>
          {t('workflowtodo.title')}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ flex: 'none', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>
          {collapsed ? `${progress}%` : t('workflowtodo.progress', { completed, total: steps.length })}
        </span>
        <button
          type="button"
          data-todo-toggle
          onClick={(e) => {
            e.stopPropagation();
            onHeaderClick();
          }}
          title={collapsed ? t('workflowtodo.expand') : t('workflowtodo.collapse')}
          aria-expanded={!collapsed}
          style={{
            flex: 'none',
            width: 20,
            height: 20,
            border: 'none',
            borderRadius: 6,
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          {collapsed ? '+' : '−'}
        </button>
        <button
          type="button"
          data-todo-hide
          onClick={(e) => {
            e.stopPropagation();
            hide();
          }}
          title={t('workflowtodo.hide')}
          style={{
            flex: 'none',
            width: 20,
            height: 20,
            border: 'none',
            borderRadius: 6,
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* 展开主体：进度条 + 可勾选步骤列表 */}
      {!collapsed ? (
        <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <div
              style={{
                flex: 1,
                height: 6,
                borderRadius: 999,
                background: 'var(--dsw-alias-border-l1)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${progress}%`,
                  borderRadius: 999,
                  background: 'var(--dsw-alias-state-business-primary)',
                  transition: 'width 200ms',
                }}
              />
            </div>
            <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-secondary)', minWidth: 30, textAlign: 'right' }}>{progress}%</span>
          </div>

          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 208, overflowY: 'auto' }}>
            {steps.map((s, i) => {
              const isDone = done.has(i);
              return (
                <li key={`${i}-${s}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={isDone}
                    onChange={() => toggleStep(i)}
                    aria-label={s}
                    style={{ flex: 'none', marginTop: 2, accentColor: 'var(--dsw-alias-state-business-primary)', cursor: 'pointer' }}
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      lineHeight: 1.4,
                      color: isDone ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)',
                      textDecoration: isDone ? 'line-through' : 'none',
                      wordBreak: 'break-word',
                    }}
                  >
                    {s}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/** 外层（零 hooks）：会话作用域缺 useSession 时返回 null（不渲染）。 */
export function WorkflowTodo(props: { useSession?: <S>(sel: (s: ConversationSnapshot) => S, eq?: (a: S, b: S) => boolean) => S }): JSX.Element | null {
  const { useSession } = props;
  if (!useSession) return null;
  return <WorkflowTodoCard useSession={useSession} />;
}

/** 注入一次样式（幂等）。 */
function injectWorkflowTodoStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('aemeath-workflow-todo-styles')) return;
  const style = document.createElement('style');
  style.id = 'aemeath-workflow-todo-styles';
  style.textContent = `
    .aemeath-workflow-todo { font-family: inherit; }
    .aemeath-workflow-todo ul::-webkit-scrollbar { width: 6px; }
    .aemeath-workflow-todo ul::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 999px; }
  `;
  document.head.appendChild(style);
}

/** 注册：会话顶栏 action 位，浮卡经 createPortal 挂 body（不动 composer）。 */
export function registerWorkflowTodo(ctx: ClientContext): void {
  injectWorkflowTodoStyles();
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'aemeath-workflow-todo',
        order: -90, // 紧贴 title 的静态会话上下文之后（先于其他交互 action）
      },
      WorkflowTodo as never,
    ),
  );
}
