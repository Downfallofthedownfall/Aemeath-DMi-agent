// ============================================================
// 爱弥斯会话列表（M5 UI 精简 v2 → UI 改造 P2 升级）
// 注册进 sidebar.workspaces（single 槽，priority 更低 → shadow 官方 ui-workspace）
// 内容：品牌头部（⚛ 小爱同学）+ 极简会话列表——只列历史会话（标题/预设徽章）。
//   「新会话」按钮由 dsh sidebar shell 自带（不重复添加）。
// 数据：useSessions 来自框架注入的标准 kit（SessionStandardProps），
//       不伪造——v1 的 bug 就是 inject 里塞了恒等函数导致列表恒空。
// ============================================================
import { memo, useCallback } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { BrandMark } from './brand.tsx';

/** 会话列表行（含删除按钮，hover 显示——纯 CSS）。 */
function SessionRow({
  title,
  subtitle,
  active,
  onClick,
  onDelete,
}: {
  title: string;
  subtitle: string;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        borderRadius: 10,
        background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      }}
      className="aemeath-session-row"
    >
      <button
        type="button"
        onClick={onClick}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 2,
          flex: 1,
          minWidth: 0,
          padding: '7px 10px',
          borderRadius: 10,
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
        }}
        aria-label={title}
      >
        <span style={{ fontSize: 13, fontWeight: active ? 700 : 500, lineHeight: 1.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
          {title}
        </span>
        {subtitle ? (
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
            {subtitle}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        data-session-delete
        onClick={onDelete}
        title="删除此对话"
        aria-label={`删除 ${title}`}
        style={{
          flex: 'none',
          width: 24,
          height: 24,
          marginRight: 4,
          borderRadius: 6,
          border: 'none',
          cursor: 'pointer',
          background: 'transparent',
          color: 'var(--dsw-alias-label-tertiary)',
          opacity: 0,
          transition: 'opacity 120ms',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3 3.5l8 8M11 3.5l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/** 品牌头部（UI 改造 P2）：侧边栏顶部身份位——⚛ 小爱同学 · 物理学习 Copilot。 */
export function SidebarBrandHeader({ wide }: { wide: boolean }): JSX.Element {
  return (
    <div
      data-aemeath-brand-header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 10px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        marginBottom: 6,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          borderRadius: 9,
          flex: 'none',
          background: 'var(--dsw-alias-state-business-tertiary)',
          color: 'var(--dsw-alias-state-business-primary)',
        }}
      >
        <BrandMark />
      </span>
      {wide ? (
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.35 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' }}>
            小爱同学
          </span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            物理学习 Copilot
          </span>
        </span>
      ) : null}
    </div>
  );
}

/** 会话列表主体：useSessions / useWorkspaces 由框架注入（标准 kit），非伪造。
 *  第三关：selector 收窄到所需切片（原全量 (s) => s 每次状态变化都重渲染），
 *  行组件 memo + useCallback，无关更新时跳过重渲染。 */
function SessionListBody({
  useSessions,
  useWorkspaces,
  wide,
  open,
  archive,
}: {
  useSessions: (selector: (s: unknown) => unknown) => unknown;
  useWorkspaces?: (selector: (s: unknown) => unknown) => unknown;
  wide: boolean;
  open: (id: string) => void;
  archive: (id: string) => void;
}): JSX.Element {
  const idsRaw = useSessions((s: unknown) => (s as { ids?: string[] })?.ids) as string[] | undefined;
  const current = useSessions((s: unknown) => (s as { current?: string })?.current) as string | undefined;
  const byId = useSessions((s: unknown) => (s as { byId?: Record<string, SessionInfo> })?.byId) as Record<string, SessionInfo> | undefined;
  // 归档集合只订阅 archivedSessionIds 切片（数组引用稳定，非每次全量状态变化都触发）
  const archived = useWorkspaces?.((s: unknown) => (s as { archivedSessionIds?: readonly string[] })?.archivedSessionIds) as readonly string[] | undefined;

  // 去重：极端重连/事件累积下 ids 可能出现重复（测试环境 18 次重连后实测每会话 3-4 份）
  const archivedSet = new Set(archived ?? []);
  const ids = Array.from(new Set((idsRaw ?? []).filter((id) => !archivedSet.has(id))));

  const remove = (id: string): void => {
    archive(id); // 归档成功后 workspaces.archivedSessionIds 更新 → 本列表自动隐藏
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflowY: 'auto' }}>
      <SidebarBrandHeader wide={wide} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '0 8px 8px', minHeight: 0, flex: 1, overflowY: 'auto' }}>
        {ids.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '12px 10px', textAlign: 'center' }}>
            {wide ? '还没有会话，点上方「新会话」开始' : '—'}
          </div>
        ) : (
          ids.map((id) => (
            <SessionRowMemo key={id} id={id} s={byId?.[id]} current={current} open={open} archive={remove} />
          ))
        )}
      </div>
    </div>
  );
}

interface SessionInfo {
  id: string;
  displayTitle?: string;
  agentPreset?: string;
  running?: boolean;
  blank?: boolean;
}

/** 行级 memo：props 稳定时跳过重渲染（第三关：全量 selector 的次级缓解）。 */
const SessionRowMemo = memo(function SessionRowMemo({
  id,
  s,
  current,
  open,
  archive,
}: {
  id: string;
  s: SessionInfo | undefined;
  current?: string;
  open: (id: string) => void;
  archive: (id: string) => void;
}): JSX.Element | null {
  if (!s || s.blank) return null;
  const presetLabel = s.agentPreset === 'aemeath' ? '小爱同学' : s.agentPreset === 'physicist' ? '爱弥斯-拉贝尔学部学霸' : s.agentPreset ?? '';
  const onClick = useCallback(() => open(id), [open, id]);
  const onDelete = useCallback(() => archive(id), [archive, id]);
  return (
    <SessionRow
      title={s.displayTitle ?? id.slice(0, 8)}
      subtitle={presetLabel}
      active={s.id === current}
      onClick={onClick}
      onDelete={onDelete}
    />
  );
});

/** 外层（零 hooks）：标准 kit props 由框架注入。 */
function AemeathSessionList(props: {
  wide?: boolean;
  useSessions?: (selector: (s: unknown) => unknown) => unknown;
  useWorkspaces?: (selector: (s: unknown) => unknown) => unknown;
  open?: (id: string) => void;
  archive?: (id: string) => void;
}): JSX.Element | null {
  const { wide, useSessions, useWorkspaces, open, archive } = props;
  if (!useSessions || !open || !archive) return null;
  return <SessionListBody useSessions={useSessions} useWorkspaces={useWorkspaces} wide={!!wide} open={open} archive={archive} />;
}

/** 注册：shadow 官方 sidebar.workspaces（会话列表 + 品牌头部）。 */
export function registerSessionList(ctx: ClientContext): void {
  // 注入 hover 显示删除按钮的 CSS
  if (typeof document !== 'undefined') {
    const style = document.createElement('style');
    style.setAttribute('data-plugin', 'aemeath-ui');
    style.setAttribute('data-plugin-css', '@aemeath/dsh-plugin-ui/session-delete');
    style.textContent = `
      .aemeath-session-row:hover [data-session-delete] { opacity: 1 !important; }
      .aemeath-session-row [data-session-delete]:hover { color: var(--dsw-alias-state-error-primary) !important; }
    `;
    document.head.appendChild(style);
  }
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces',
        priority: -100,
        // 注意：不提供 useSessions（框架 standard kit 注入）；只给业务回调
        inject: () => ({
          open: (id: string) => ctx.sessions.open(id as never),
          archive: (id: string) => void ctx.workspaces.archiveSession(id as never),
        }),
      },
      AemeathSessionList as never,
    ),
  );
  // 注：conversation.hero.workspace 已由 workspace-selector.tsx 接管（P3 恢复工作区选择）
}
