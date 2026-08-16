// ============================================================
// workspace-selector.tsx —— 工作区选择器（多轮反馈修订 · 最终形态）
// 形态（用户明确要求：**只保留对话框（输入框）的**）：
//   - chip 只注册在 conversation.input.left（输入框工具行左下）；菜单锚定输入框卡
//     左下角，下方空间不足时**向上弹出**；菜单高度实测后贴边（修复"错位"）。
//   - hero 不注册任何工作区 UI（官方选择器由 ui-workspace 自带处理 inert 态出口）。
// 语义：
//   - 工作区非必填：未归属会话 chip 显示「无工作区」；菜单首项「无工作区」为
//     状态指示（未分组时选中态）。
//   - 「无工作区」**非破坏性**（⚠ 不要删工作区：删除后 新会话/历史 会掉进 inert
//     软锁）：在会话已关联工作区时点击 → 打开已有未分组会话（如有）；没有则提示。
//   - 切换工作区：ctx.workspaces.startSession(workspaceId)（连接 + 打开）。
//   - 选择文件夹：ctx.workspaces.pickDirectory() → create({path}) → startSession。
// 数据：useWorkspaces（标准 feed）；会话归属 = items.find(w => w.sessionIds.includes(sid))。
// ⚠ dsh 硬约束：inert（无工作区空白会话/无会话）下输入框工具行座位不渲染
//   （leftItems = zone===undefined ? null : ...）——inert 态由官方 hero 流程接管。
// ============================================================
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { ensureFallbackChat, fetchFallbackWorkspacePath } from './bootstrap.ts';

/** 注入面：workspaces 服务 + 会话打开（无工作区切换用）。 */
export interface WorkspaceSelectorDeps {
  workspaces?: {
    startSession(workspaceId?: string): void;
    pickDirectory(): Promise<string | null>;
    create(input: { path: string }): Promise<{ workspaceId: string; title: string }>;
  };
  openSession?: (sessionId: string) => void;
}

interface WorkspaceSelectorProps extends WorkspaceSelectorDeps {
  /** 当前会话 id（InputZone.session.sessionId）。 */
  sessionId?: string;
  useWorkspaces?: (sel: (s: unknown) => unknown) => unknown;
  useSessions?: (sel: (s: unknown) => unknown) => unknown;
}

/** 当前会话归属工作区（items.find sessionIds 包含 sessionId）。 */
function currentWorkspace(items: Array<{ workspaceId: string; title: string; path: string; sessionIds: string[] }>, sessionId: string | undefined) {
  if (!sessionId) return undefined;
  return items.find((w) => w.sessionIds.includes(sessionId));
}

/** 文件夹图标（inline svg，Fluent 风格）。 */
function FolderGlyph({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.4 1.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12v-8.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** 下拉菜单（Win11 Acrylic 面板；锚定输入框卡左下，实测高度后贴边定位）。
    `measure` 模式：静态布局（不 fixed），供隐藏测量器测真实高度——
    fixed 元素脱离文档流会让父容器测高恒为 0（"点了没反应"根因）。 */
function WorkspaceMenu({
  items,
  currentId,
  ungrouped,
  onPickNone,
  onPick,
  onPickDirectory,
  onClose,
  placement,
}: {
  items: Array<{ workspaceId: string; title: string; path: string }>;
  currentId: string | undefined;
  ungrouped: boolean;
  onPickNone: () => void;
  onPick: (id: string) => void;
  onPickDirectory: () => void;
  onClose: () => void;
  /** 视口钳制定位：left + (top 向下 | bottom 向上) + maxHeight，保证菜单永远在视口内。 */
  placement: { left: number; top?: number; bottom?: number; maxHeight: number };
}): JSX.Element {
  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: Math.max(8, placement.left),
        top: placement.top,
        bottom: placement.bottom,
        zIndex: 9999,
        minWidth: 280,
        maxWidth: 380,
        maxHeight: placement.maxHeight,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        padding: 6,
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--fluent-acrylic, rgba(247,249,252,0.92))',
        backdropFilter: 'var(--fluent-blur, blur(20px) saturate(140%))',
        boxShadow: 'var(--fluent-shadow-lg, 0 4px 12px rgba(0,0,0,0.07), 0 16px 40px rgba(0,0,0,0.09))',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      }}
    >
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)', padding: '6px 10px 4px' }}>
        工作区（可选）
      </div>

      {/* 无工作区（未分组）—— 首项，选中态表示当前会话不归属任何工作区 */}
      <button
        type="button"
        role="menuitem"
        data-aemeath-ws-none
        aria-pressed={ungrouped}
        onClick={onPickNone}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 10px',
          borderRadius: 8,
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          background: ungrouped ? 'var(--dsw-alias-state-business-tertiary)' : 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          fontWeight: ungrouped ? 700 : 500,
        }}
      >
        <span style={{ color: ungrouped ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)', display: 'inline-flex', fontSize: 13 }}>
          ◇
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>无工作区</span>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {ungrouped ? '当前会话不归属任何工作区' : '开始对话（无需选择工作区）'}
          </span>
        </span>
        {ungrouped ? <span style={{ color: 'var(--dsw-alias-state-business-primary)', fontSize: 12 }}>✓</span> : null}
      </button>

      {items.length > 0 ? <div style={{ borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '4px 0' }} /> : null}
      {items.length > 0 ? (
        items.map((w) => {
          const active = w.workspaceId === currentId;
          return (
            <button
              key={w.workspaceId}
              type="button"
              role="menuitem"
              onClick={() => onPick(w.workspaceId)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 13,
              }}
            >
              <span style={{ color: active ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)', display: 'inline-flex' }}>
                <FolderGlyph />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: active ? 700 : 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.title}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.path}</span>
              </span>
            </button>
          );
        })
      ) : (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '4px 10px 2px' }}>
          还没有工作区——需要时选择一个文件夹即可
        </div>
      )}
      <div style={{ borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '4px 0' }} />
      <button
        type="button"
        role="menuitem"
        onClick={onPickDirectory}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 10px',
          borderRadius: 8,
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          background: 'transparent',
          color: 'var(--dsw-alias-state-business-primary)',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <span style={{ display: 'inline-flex' }}>＋</span> 选择文件夹作为工作区…
      </button>
      <button type="button" role="menuitem" onClick={onClose} style={{ marginTop: 2, padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, textAlign: 'left' }}>
        ✕ 关闭
      </button>
    </div>
  );
}

/** 选择器主体（hooks 全在此）。 */
function SelectorLoaded({
  sessionId,
  useWorkspaces,
  useSessions,
  workspaces,
  openSession,
}: {
  sessionId?: string;
  useWorkspaces: NonNullable<WorkspaceSelectorProps['useWorkspaces']>;
  useSessions: NonNullable<WorkspaceSelectorProps['useSessions']>;
  workspaces: NonNullable<WorkspaceSelectorProps['workspaces']>;
  openSession: NonNullable<WorkspaceSelectorProps['openSession']>;
}): JSX.Element {
  const [openMenu, setOpenMenu] = useState(false);
  const [anchorRect, setAnchorRect] = useState<{ left: number; top: number; bottom: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 视口钳制定位（无测量、无估算）：
  //   **优先向下**（下方空间 ≥200px 就向下，菜单贴住输入框左下角——hero 态输入框
  //   在屏幕中部时菜单落在其正下方，而不是飘到上方半空"跑到右上"）；
  //   输入框贴底（活跃会话）才向上；右缘钳制防溢出。
  const MENU_MIN_H = 180;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const placement = anchorRect
    ? vh - anchorRect.bottom >= 200
      ? { left: Math.min(anchorRect.left, vw - 392), top: anchorRect.bottom + 6, maxHeight: Math.max(MENU_MIN_H, vh - anchorRect.bottom - 20) }
      : { left: Math.min(anchorRect.left, vw - 392), bottom: vh - anchorRect.top + 6, maxHeight: Math.max(MENU_MIN_H, anchorRect.top - 20) }
    : null;

  // 第三关：selector 收窄到所需切片（原 (s) => s 全量选择，任何状态变化都重渲染）
  const wsItems = useWorkspaces((s) => (s as { items?: Array<{ workspaceId: string; title: string; path: string; sessionIds: string[] }> })?.items) as Array<{ workspaceId: string; title: string; path: string; sessionIds: string[] }> | undefined;
  const wsArchived = useWorkspaces((s) => (s as { archivedSessionIds?: readonly string[] })?.archivedSessionIds) as readonly string[] | undefined;
  const sessCurrent = useSessions((s) => (s as { current?: string })?.current) as string | undefined;
  const sessByBlank = useSessions((s) => (s as { byId?: Record<string, { blank?: boolean }> })?.byId) as Record<string, { blank?: boolean }> | undefined;
  const items = wsItems ?? [];
  const resolvedSessionId = sessionId ?? sessCurrent;
  const current = currentWorkspace(items, resolvedSessionId);
  const currentId = current?.workspaceId;
  const currentTitle = current?.title;
  const ungrouped = !currentId;

  const toggle = (e: React.MouseEvent<HTMLElement>): void => {
    e.stopPropagation(); // 防止冒泡到 composer 卡（inert 态的卡级 onClick 会开官方选择器）
    if (openMenu) {
      setOpenMenu(false);
      return;
    }
    // 锚定输入框卡左下角（用户反馈：dropdown 在输入框左下）
    const card = e.currentTarget.closest('[data-composer-card]') as HTMLElement | null;
    const rect = (card ?? e.currentTarget).getBoundingClientRect();
    setAnchorRect({ left: rect.left, top: rect.top, bottom: rect.bottom });
    setOpenMenu(true);
    setError(null);
  };

  // 第三关：菜单开启期间窗口 resize/滚动时重钳制定位（placement 按当前 vw/vh 重算，
  // 防止菜单随视口变化跑出屏幕）
  useEffect(() => {
    if (!openMenu) return;
    const reclamp = (): void => setAnchorRect((r) => (r ? { ...r } : r));
    window.addEventListener('resize', reclamp);
    window.addEventListener('scroll', reclamp, true);
    return () => {
      window.removeEventListener('resize', reclamp);
      window.removeEventListener('scroll', reclamp, true);
    };
  }, [openMenu]);

  const pick = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setOpenMenu(false);
    try {
      workspaces.startSession(id);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  // 「无工作区」非破坏性：点击后保证落到一个**能输入**的对话——
  // 1) 已有「可用」（有内容、未归档）的未分组会话 → 切过去；
  // 2) 没有 → 自动在兜底工作区（项目内空文件夹 .chat）开一个新对话（无需选择）；
  // 3) 已在兜底工作区（"无工作区"等效态）→ no-op。
  const pickNone = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setOpenMenu(false);
    try {
      if (ungrouped || !currentId) return; // 当前已在无工作区状态
      const byId = (sessByBlank ?? {}) as Record<string, { blank?: boolean }>;
      const archived = new Set(wsArchived ?? []);
      const usable = Object.keys(byId).filter(
        (id) => !byId[id]?.blank && !archived.has(id) && !items.some((w) => w.sessionIds.includes(id)),
      );
      if (usable.length > 0) {
        openSession(usable[0]);
        return;
      }
      // ⚠ 空白/已归档的未分组会话在 dsh 里是只读死局，不能切过去——
      // 改为直接在兜底工作区开新对话（用户零选择，打开即聊）。
      const fallbackPath = await fetchFallbackWorkspacePath();
      if (fallbackPath && current?.path === fallbackPath) return; // 已在兜底工作区
      const ok = await ensureFallbackChat(workspaces);
      if (!ok) setError('无法启动新对话（兜底工作区不可用）；请选择一个工作区或文件夹。');
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const pickDirectory = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const path = await workspaces.pickDirectory();
      if (path) {
        const ws = await workspaces.create({ path });
        workspaces.startSession(ws.workspaceId);
      }
      setOpenMenu(false);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const label = currentTitle ?? '无工作区';

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        data-aemeath-ws="chip"
        aria-label="切换工作区"
        title={ungrouped ? '当前无工作区 · 点击选择工作区' : `工作区：${label}`}
        disabled={busy}
        onClick={toggle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          padding: '0 10px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-base)',
          color: ungrouped ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          fontSize: 12,
        }}
      >
        <span style={{ display: 'inline-flex', color: ungrouped ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-business-primary)' }}>
          {ungrouped ? <span style={{ fontSize: 11 }}>◇</span> : <FolderGlyph size={13} />}
        </span>
        <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {openMenu && placement ? (
        // ⚠ 必须 portal 到 document.body：Electron 28（Chromium 120）下
        //   position:fixed 元素若挂在应用深树里会被错误偏移（实测 +card.left/+row.top，
        //   菜单开出视口外 = "点了没反应"）；挂到 body 下则正常（浏览器端同样正确）。
        createPortal(
          <WorkspaceMenu
            items={items}
            currentId={currentId}
            ungrouped={ungrouped}
            onPickNone={() => void pickNone()}
            onPick={(id) => void pick(id)}
            onPickDirectory={() => void pickDirectory()}
            onClose={() => setOpenMenu(false)}
            placement={placement}
          />,
          document.body,
        )
      ) : null}
      {error ? (
        createPortal(
          <div style={{ position: 'fixed', top: 48, left: anchorRect?.left ?? 8, zIndex: 9999, fontSize: 11.5, color: 'var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-bg-overlay)', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', maxWidth: 320 }}>
            {error}
          </div>,
          document.body,
        )
      ) : null}
    </div>
  );
}

/** 外层（零 hooks）：依赖未注入时返回 null（React #290 安全模式）。 */
export function WorkspaceSelector(props: WorkspaceSelectorProps): JSX.Element | null {
  const { sessionId, useWorkspaces, useSessions, workspaces, openSession } = props;
  if (!useWorkspaces || !useSessions || !workspaces || !openSession) return null;
  return <SelectorLoaded sessionId={sessionId} useWorkspaces={useWorkspaces} useSessions={useSessions} workspaces={workspaces} openSession={openSession} />;
}

/** 注册：仅输入框工具行 chip（用户要求：工作区 dropdown 只保留对话框的）。 */
export function registerWorkspaceSelector(ctx: ClientContext, deps: WorkspaceSelectorDeps): void {
  // chip → conversation.input.left（session 作用域：InputZone.session.sessionId）
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'aemeath-ws-chip',
        order: -100,
        inject: () => ({ ...deps }),
      },
      ((props: unknown) => {
        const p = props as { session?: { sessionId?: string } };
        return <WorkspaceSelector sessionId={p.session?.sessionId} {...(deps as unknown as object)} {...(p as object)} />;
      }) as never,
    ),
  );
  // 注：hero.workspace 槽不再注册（官方 ui-workspace 的选择器回归原位，
  // 由 dsh 官方流程处理 inert 态"选择一个工作区开始"的出口）
}
