// ============================================================
// workspace-selector.tsx —— 工作区选择器（UI 改造 P3 → 多轮反馈修订）
// 形态：
//   1. chip 变体 → conversation.input.left（输入框工具行左下）；菜单锚定输入框卡
//      左下角，下方空间不足时**向上弹出**；菜单高度实测后贴边（修复"错位"）。
//   2. hero 变体 → conversation.hero.workspace（新会话欢迎屏）；同时隐藏 dsh
//      自带的 WorkspaceChip（de-dsh §7.4），hero 行只剩我们的 chip，不挤歪居中。
// 语义（多轮反馈修订）：
//   - 工作区非必填：未归属会话 chip 显示「无工作区」；下拉首项「无工作区」。
//   - 「无工作区」= 移除当前工作区关联（ctx.workspaces.delete）——dsh 文档明确：
//     仅删除工作区注册，文件夹/会话文件不受影响，会话转为未分组且正常可用。
//     ⚠ 不要用"新建会话"实现无工作区：dsh 的 hero 态只允许"归属工作区的会话"
//     输入（inert = sessionId 空 或 hero && chipTitle 空），未归属的空白会话
//     必然掉进只读死局（"选择一个工作区开始"、无模型选择）。
//   - 切换工作区：ctx.workspaces.startSession(workspaceId)（连接 + 打开）。
//   - 选择文件夹：ctx.workspaces.pickDirectory() → create({path}) → startSession。
// 数据：useWorkspaces（标准 feed）；会话归属 = items.find(w => w.sessionIds.includes(sid))。
// ============================================================
import { useLayoutEffect, useRef, useState } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';

/** 注入面：workspaces 服务（startSession/pickDirectory/create/delete）。 */
export interface WorkspaceSelectorDeps {
  workspaces?: {
    startSession(workspaceId?: string): void;
    pickDirectory(): Promise<string | null>;
    create(input: { path: string }): Promise<{ workspaceId: string; title: string }>;
    delete(workspaceId: string): Promise<void>;
  };
}

interface WorkspaceSelectorProps extends WorkspaceSelectorDeps {
  variant: 'chip' | 'hero';
  /** 当前会话 id（chip 变体：InputZone.session.sessionId；hero 变体：useSessions.current）。 */
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

/** 下拉菜单（Win11 Acrylic 面板；锚定输入框卡左下，实测高度后贴边定位）。 */
function WorkspaceMenu({
  items,
  currentId,
  ungrouped,
  onPickNone,
  onPick,
  onPickDirectory,
  onClose,
  anchorLeft,
  anchorTop,
}: {
  items: Array<{ workspaceId: string; title: string; path: string }>;
  currentId: string | undefined;
  ungrouped: boolean;
  onPickNone: () => void;
  onPick: (id: string) => void;
  onPickDirectory: () => void;
  onClose: () => void;
  anchorLeft: number;
  anchorTop: number;
}): JSX.Element {
  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: Math.max(8, anchorLeft),
        top: anchorTop,
        zIndex: 9999,
        minWidth: 280,
        maxWidth: 380,
        maxHeight: 'min(440px, 60vh)',
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
            {ungrouped ? '当前会话不归属任何工作区' : '取消当前工作区关联（文件夹与会话不受影响）'}
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
  variant,
  sessionId,
  useWorkspaces,
  useSessions,
  workspaces,
}: {
  variant: WorkspaceSelectorProps['variant'];
  sessionId?: string;
  useWorkspaces: NonNullable<WorkspaceSelectorProps['useWorkspaces']>;
  useSessions: NonNullable<WorkspaceSelectorProps['useSessions']>;
  workspaces: NonNullable<WorkspaceSelectorProps['workspaces']>;
}): JSX.Element {
  const [openMenu, setOpenMenu] = useState(false);
  const [anchorRect, setAnchorRect] = useState<{ left: number; top: number; bottom: number } | null>(null);
  const [menuH, setMenuH] = useState<number | null>(null); // 实测菜单高度（贴边定位）
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 菜单挂载后实测高度 → 触发重渲染，用实测高度重算贴边位置（修复"错位/悬空"）
  useLayoutEffect(() => {
    if (!openMenu || !menuRef.current) return;
    const h = menuRef.current.getBoundingClientRect().height;
    setMenuH((prev) => (prev === null || Math.abs(prev - h) > 2 ? h : prev));
  }, [openMenu]);

  // 实测高度（若有）驱动的贴边定位：下方空间不足 → 向上，否则向下；左侧贴锚点
  const menuHNow = menuH ?? 260;
  const menuTop = anchorRect
    ? window.innerHeight - anchorRect.bottom < menuHNow + 12
      ? Math.max(8, anchorRect.top - menuHNow - 6)
      : anchorRect.bottom + 6
    : 0;

  const wsState = useWorkspaces((s) => s) as {
    items?: Array<{ workspaceId: string; title: string; path: string; sessionIds: string[] }>;
  } | undefined;
  const sessState = useSessions((s) => s) as { byId?: Record<string, unknown>; current?: string } | undefined;
  const items = wsState?.items ?? [];
  const resolvedSessionId = sessionId ?? sessState?.current;
  const current = currentWorkspace(items, resolvedSessionId);
  const currentId = current?.workspaceId;
  const currentTitle = current?.title;
  const ungrouped = !currentId;

  const toggle = (e: React.MouseEvent<HTMLElement>): void => {
    if (openMenu) {
      setOpenMenu(false);
      return;
    }
    // chip 变体锚定输入框卡左下角（用户反馈）；hero 变体锚定自身
    const card = e.currentTarget.closest('[data-composer-card]') as HTMLElement | null;
    const rect = (card ?? e.currentTarget).getBoundingClientRect();
    setAnchorRect({ left: rect.left, top: rect.top, bottom: rect.bottom });
    setMenuH(null); // 重新测量
    setOpenMenu(true);
    setError(null);
  };

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

  const pickNone = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setOpenMenu(false);
    try {
      if (ungrouped || !currentId) return; // 当前已在无工作区状态
      // 移除当前工作区关联（dsh 文档：仅删注册，文件夹/会话文件不受影响 → 会话转未分组）
      await workspaces.delete(currentId);
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

  const chip = variant === 'chip';
  const label = currentTitle ?? '无工作区';

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        data-aemeath-ws={variant}
        aria-label="切换工作区"
        title={ungrouped ? '当前无工作区 · 点击选择工作区' : `工作区：${label}`}
        disabled={busy}
        onClick={toggle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: chip ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-state-business-tertiary)',
          color: chip ? (ungrouped ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)') : 'var(--dsw-alias-state-business-primary)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          ...(chip
            ? { height: 28, padding: '0 10px', borderRadius: 8, fontSize: 12 }
            : { padding: '8px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600, boxShadow: 'var(--fluent-shadow-sm)' }),
        }}
      >
        <span style={{ display: 'inline-flex', color: ungrouped ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-business-primary)' }}>
          {ungrouped ? <span style={{ fontSize: chip ? 11 : 12 }}>◇</span> : <FolderGlyph size={chip ? 13 : 14} />}
        </span>
        <span style={{ maxWidth: chip ? 160 : 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {openMenu && anchorRect ? (
        <div ref={menuRef} style={{ position: 'absolute', top: 0, left: 0, visibility: 'hidden', pointerEvents: 'none' }} aria-hidden="true">
          <WorkspaceMenu
            items={items}
            currentId={currentId}
            ungrouped={ungrouped}
            onPickNone={() => void pickNone()}
            onPick={(id) => void pick(id)}
            onPickDirectory={() => void pickDirectory()}
            onClose={() => setOpenMenu(false)}
            anchorLeft={0}
            anchorTop={0}
          />
        </div>
      ) : null}
      {openMenu && anchorRect && menuH !== null ? (
        <WorkspaceMenu
          items={items}
          currentId={currentId}
          ungrouped={ungrouped}
          onPickNone={() => void pickNone()}
          onPick={(id) => void pick(id)}
          onPickDirectory={() => void pickDirectory()}
          onClose={() => setOpenMenu(false)}
          anchorLeft={anchorRect.left}
          anchorTop={menuTop}
        />
      ) : null}
      {error ? (
        <div style={{ position: 'fixed', top: menuTop || 40, left: anchorRect?.left ?? 8, zIndex: 9999, fontSize: 11.5, color: 'var(--dsw-alias-state-error-primary)', background: 'var(--dsw-alias-bg-overlay)', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)' }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** 外层（零 hooks）：依赖未注入时返回 null（React #290 安全模式）。 */
export function WorkspaceSelector(props: WorkspaceSelectorProps): JSX.Element | null {
  const { variant, sessionId, useWorkspaces, useSessions, workspaces } = props;
  if (!useWorkspaces || !useSessions || !workspaces) return null;
  return <SelectorLoaded variant={variant} sessionId={sessionId} useWorkspaces={useWorkspaces} useSessions={useSessions} workspaces={workspaces} />;
}

/** 注册：输入框工具行 chip + hero 工作区选择器。 */
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
        return <WorkspaceSelector variant="chip" sessionId={p.session?.sessionId} {...(deps as unknown as object)} {...(p as object)} />;
      }) as never,
    ),
  );
  // hero → conversation.hero.workspace（root 作用域；替换 dsh WorkspaceChip 槽位，
  // dsh 自带 chip 由 de-dsh §7.4 隐藏 → hero 行只剩我们的 chip，不挤歪居中）
  ctx.slots.inject('conversation.hero.workspace', () =>
    ctx.slots.register(
      {
        name: 'conversation.hero.workspace',
        priority: -100,
        inject: () => ({ ...deps }),
      },
      ((props: unknown) => <WorkspaceSelector variant="hero" {...(deps as unknown as object)} {...(props as object)} />) as never,
    ),
  );
}
