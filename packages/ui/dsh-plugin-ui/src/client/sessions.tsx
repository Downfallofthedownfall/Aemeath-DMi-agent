// ============================================================
// 爱弥斯会话列表（M5 UI 精简 v2）——替换 dsh 的 workspace 浏览器
// 注册进 sidebar.workspaces（single 槽，priority 更低 → shadow 官方 ui-workspace）
// 内容：极简会话列表——只列历史会话（标题/预设徽章），点击打开。
//   「新会话」按钮由 dsh sidebar shell 自带（不重复添加）。
// 数据：useSessions 来自框架注入的标准 kit（SessionStandardProps），
//       不伪造——v1 的 bug 就是 inject 里塞了恒等函数导致列表恒空。
// ============================================================
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';

/** 会话列表行。 */
function SessionRow({
  title,
  subtitle,
  active,
  onClick,
}: {
  title: string;
  subtitle: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        width: '100%',
        padding: '7px 10px',
        borderRadius: 10,
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      }}
      aria-label={title}
    >
      <span style={{ fontSize: 13, fontWeight: active ? 700 : 500, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
        {title}
      </span>
      {subtitle ? (
        <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
          {subtitle}
        </span>
      ) : null}
    </button>
  );
}

/** 会话列表主体：useSessions 由框架注入（标准 kit），非伪造。 */
function SessionListBody({
  useSessions,
  wide,
  open,
}: {
  useSessions: (selector: (s: unknown) => unknown) => unknown;
  wide: boolean;
  open: (id: string) => void;
}): JSX.Element {
  const list = useSessions((s: unknown) => s) as {
    ids?: string[];
    byId?: Record<string, { id: string; displayTitle?: string; agentPreset?: string; running?: boolean; blank?: boolean }>;
    current?: string;
  };
  const ids = list.ids ?? [];
  const byId = list.byId ?? {};
  const current = list.current;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '4px 8px 8px', minHeight: 0, flex: 1, overflowY: 'auto' }}>
      {ids.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '12px 10px', textAlign: 'center' }}>
          {wide ? '还没有会话，点上方「新会话」开始' : '—'}
        </div>
      ) : (
        ids.map((id) => {
          const s = byId[id];
          if (!s || s.blank) return null;
          const presetLabel = s.agentPreset === 'aemeath' ? '小爱同学' : s.agentPreset === 'physicist' ? '爱弥斯-拉贝尔学部学霸' : s.agentPreset ?? '';
          return (
            <SessionRow
              key={id}
              title={s.displayTitle ?? id.slice(0, 8)}
              subtitle={presetLabel}
              active={s.id === current}
              onClick={() => open(id)}
            />
          );
        })
      )}
    </div>
  );
}

/** 外层（零 hooks）：标准 kit props 由框架注入。 */
function AemeathSessionList(props: {
  wide?: boolean;
  useSessions?: (selector: (s: unknown) => unknown) => unknown;
  open?: (id: string) => void;
}): JSX.Element | null {
  const { wide, useSessions, open } = props;
  if (!useSessions || !open) return null;
  return <SessionListBody useSessions={useSessions} wide={!!wide} open={open} />;
}

/** 隐藏 hero 里的工作区 dropdown（shadow 官方 WorkspacePicker 为空）。 */
function HiddenWorkspacePicker(): JSX.Element | null {
  return null;
}

/** 注册：shadow 官方 sidebar.workspaces + hero 工作区 picker。 */
export function registerSessionList(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces',
        priority: -100,
        // 注意：不提供 useSessions（框架 standard kit 注入）；只给业务回调
        inject: () => ({
          open: (id: string) => ctx.sessions.open(id as never),
        }),
      },
      AemeathSessionList as never,
    ),
  );
  // shadow 官方 hero 工作区 picker（WorkspacePicker）→ 空，隐藏 dropdown
  ctx.slots.inject('conversation.hero.workspace', () =>
    ctx.slots.register(
      {
        name: 'conversation.hero.workspace',
        priority: -100,
      },
      HiddenWorkspacePicker as never,
    ),
  );
}
