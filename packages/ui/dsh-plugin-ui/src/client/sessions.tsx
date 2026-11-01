// ============================================================
// 爱弥斯会话列表（M5 UI 精简 v2 → UI 改造 P2 升级 → 时间分组版）
// 注册进 sidebar.workspaces（single 槽，priority 更低 → shadow 官方 ui-workspace）
// 内容：品牌头部（⚛ 小爱同学）+ 会话列表——按最近更新时间分组（今天 / 昨天 /
//   近 7 天 / 更早），每行：标题 + 角色色点 + 时间；回复中的会话带脉冲点。
//   「新会话」按钮由 dsh sidebar shell 自带（不重复添加）。
// 数据：useSessions 来自框架注入的标准 kit（SessionStandardProps），
//       不伪造——v1 的 bug 就是 inject 里塞了恒等函数导致列表恒空。
// 样式：类名 + 一次性注入的样式表（hover / 激活条 / 删除按钮都是伪类，内联写不了）。
// ============================================================
import { memo, useCallback } from 'react';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client';
import { BrandMark } from './brand.tsx';
import { t, useLocale, currentActiveLocale } from './i18n.ts';
import { mainSessionIdOf } from './main-session.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

type GroupKey = 'today' | 'yesterday' | 'week' | 'older';

/** 按本地日历日分组（不是"距今 24 小时"：昨晚 23 点的会话今早看应在「昨天」）。 */
function groupOf(ts: number, now: number): GroupKey {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return 'today';
  if (ts >= startOfToday - DAY_MS) return 'yesterday';
  if (ts >= startOfToday - 6 * DAY_MS) return 'week';
  return 'older';
}

/** 行内时间：今天显示时刻，其余显示月日（跨年再带年份）。 */
function formatTime(ts: number, group: GroupKey, now: number): string {
  if (!ts) return '';
  const locale = currentActiveLocale() === 'en' ? 'en-US' : 'zh-CN';
  const d = new Date(ts);
  if (group === 'today') return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

/** 会话列表行（hover 显示删除按钮、隐藏时间——纯 CSS）。 */
function SessionRow({
  title,
  untitled,
  role,
  roleLabel,
  time,
  running,
  active,
  wide,
  onClick,
  onDelete,
}: {
  title: string;
  untitled: boolean;
  role: string;
  roleLabel: string;
  time: string;
  running: boolean;
  active: boolean;
  wide: boolean;
  onClick: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="aem-sl__row" data-active={active || undefined}>
      <button type="button" className="aem-sl__open" onClick={onClick} aria-label={title} aria-current={active ? 'page' : undefined}>
        <span className="aem-sl__title" data-untitled={untitled || undefined}>
          {running ? <span className="aem-sl__running" title={t('sessions.running')} /> : null}
          <span className="aem-sl__title-text">{title}</span>
        </span>
        {wide && (roleLabel || time) ? (
          <span className="aem-sl__meta">
            {roleLabel ? (
              <span className="aem-sl__role" data-role={role}>
                {roleLabel}
              </span>
            ) : null}
            {time ? <span className="aem-sl__time">{time}</span> : null}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="aem-sl__delete"
        onClick={onDelete}
        title={t('sessions.delete.title')}
        aria-label={t('sessions.delete.aria', { title })}
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
    <div data-aemeath-brand-header className="aem-sl__id">
      <span className="aem-sl__id-mark">
        <BrandMark />
      </span>
      {wide ? (
        <span className="aem-sl__id-text">
          <span className="aem-sl__id-name">{t('brand.sidebar.name')}</span>
          <span className="aem-sl__id-sub">{t('brand.sidebar.subtitle')}</span>
        </span>
      ) : null}
    </div>
  );
}

/** 模块级稳定 no-op hook（M11：useWorkspaces 缺失时的兜底——保持 SessionListBody
 *  内 hook 调用无条件，避免条件调用违反 Rules of Hooks）。 */
const NOOP_USE_WORKSPACES = (): unknown => undefined;

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
  useWorkspaces: (selector: (s: unknown) => unknown) => unknown;
  wide: boolean;
  open: (id: string) => void;
  archive: (id: string) => void;
}): JSX.Element {
  // 状态按 dsh 的真实快照类型读：字段改名时编译即报错（`current` 就是被手写形状掩盖的）
  const idsRaw = useSessions((s: unknown) => (s as SessionListState | undefined)?.ids) as string[] | undefined;
  // 0.2.x 没有 `current` 字段：按官方读法取主视图持有的会话（见 main-session.ts）
  const current = useSessions((s: unknown) => mainSessionIdOf(s as SessionListState)) as string | undefined;
  const byId = useSessions((s: unknown) => (s as SessionListState | undefined)?.byId) as Record<string, SessionInfo> | undefined;
  // 归档集合只订阅 archivedSessionIds 切片（数组引用稳定，非每次全量状态变化都触发）
  const archived = useWorkspaces((s: unknown) => (s as WorkspaceSnapshot | undefined)?.archivedSessionIds) as readonly string[] | undefined;
  useLocale(); // locale 切换时刷新分组标题/空态/删除 tooltip 等文案

  // 去重：极端重连/事件累积下 ids 可能出现重复（测试环境 18 次重连后实测每会话 3-4 份）
  const archivedSet = new Set(archived ?? []);
  const ids = Array.from(new Set((idsRaw ?? []).filter((id) => !archivedSet.has(id))));

  // 按更新时间分组：先按 updatedAt 降序（稳定排序，缺时间戳的保持原相对次序沉底），再切组。
  // blank 行不渲染（与 SessionRowMemo 的过滤一致），否则会留下没有内容的分组标题。
  const now = Date.now();
  const visible = ids.filter((id) => byId?.[id] && !byId[id]!.blank);
  const sorted = visible
    .map((id, i) => ({ id, i, ts: byId?.[id]?.updatedAt ?? 0 }))
    .sort((a, b) => b.ts - a.ts || a.i - b.i);
  const groups: Array<{ key: GroupKey; items: Array<{ id: string; ts: number }> }> = [];
  for (const row of sorted) {
    const key = groupOf(row.ts, now);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(row);
    else groups.push({ key, items: [row] });
  }

  return (
    <div className="aem-sl">
      <SidebarBrandHeader wide={wide} />
      <div className="aem-sl__list">
        {sorted.length === 0 ? (
          <div className="aem-sl__empty">{wide ? t('sessions.empty') : '—'}</div>
        ) : (
          groups.map((g) => (
            <div key={g.key} className="aem-sl__group" role="group" aria-label={t(`sessions.group.${g.key}`)}>
              {wide ? <div className="aem-sl__group-title">{t(`sessions.group.${g.key}`)}</div> : null}
              {g.items.map(({ id, ts }) => (
                <SessionRowMemo
                  key={id}
                  id={id}
                  s={byId?.[id]}
                  current={current}
                  time={formatTime(ts, g.key, now)}
                  wide={wide}
                  open={open}
                  archive={archive}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface SessionInfo {
  id: string;
  /** host 投影的持久标题；缺失时 displayTitle 会退回项目目录名（对用户没有信息量）。 */
  title?: string;
  displayTitle?: string;
  /**
   * 会话的 agent preset。
   *
   * ⚠️ 真机踩过（"历史记录里没有人格标签"）：这里的字段路径必须是
   *   `byId[id].projectionValues.agentPreset`
   * —— 官方 ui-agent-preset 的 AgentPresetLabel 读的就是这条路径
   *   （`state.byId[sessionId]?.projectionValues?.agentPreset`）。
   * 早先我只在顶层找 `agentPreset`，永远取不到 → 标签空。
   */
  projectionValues?: { agentPreset?: string };
  agentPreset?: string;
  running?: boolean;
  blank?: boolean;
  updatedAt?: number;
}

/** 行级 memo：props 稳定时跳过重渲染（第三关：全量 selector 的次级缓解）。 */
const SessionRowMemo = memo(function SessionRowMemo({
  id,
  s,
  current,
  time,
  wide,
  open,
  archive,
}: {
  id: string;
  s: SessionInfo | undefined;
  current?: string;
  time: string;
  wide: boolean;
  open: (id: string) => void;
  archive: (id: string) => void;
}): JSX.Element | null {
  useLocale(); // locale 切换时强制刷新预设徽章文案
  // 铁律：hooks 必须无条件调用。Open/archive 的回调在 if 之前构造，
  // 否则 s 在 undefined/blank → 就绪 之间跳变时 hooks 数量随之跳变 → React #310 崩溃
  //（开新对话时 byId 某帧缺该项：先 return null 跳过 useCallback，下一帧恢复即崩）。
  const onClick = useCallback(() => open(id), [open, id]);
  const onDelete = useCallback(() => archive(id), [archive, id]);
  if (!s || s.blank) return null;
  // ⚠️ 路径：官方把它挂在 projectionValues 下（见 SessionInfo 的注释）。
  //    兼容读顶层是为了不破坏可能存在的旧结构；两者都没有就不显示标签。
  const presetId = s.projectionValues?.agentPreset ?? s.agentPreset ?? '';
  const roleLabel =
    presetId === 'aemeath' ? t('sessions.preset.short.aemeath') : presetId === 'physicist' ? t('sessions.preset.short.physicist') : presetId;
  // 没有持久标题时 displayTitle 是项目目录名（列表里一排"Aemeath-DMi-agent"）——改显示"未命名对话"
  const untitled = !s.title;
  return (
    <SessionRow
      title={untitled ? t('sessions.untitled') : s.title!}
      untitled={untitled}
      role={presetId}
      roleLabel={roleLabel}
      time={time}
      running={!!s.running}
      active={s.id === current}
      wide={wide}
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
  // M11：useWorkspaces 缺失时用稳定 no-op 兜底，保证 SessionListBody 内 hook 恒调用
  return <SessionListBody useSessions={useSessions} useWorkspaces={useWorkspaces ?? NOOP_USE_WORKSPACES} wide={!!wide} open={open} archive={archive} />;
}

const SESSION_LIST_CSS = `
.aem-sl { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.aem-sl__id {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 10px 10px; margin: 0 4px 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.aem-sl__id-mark {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 30px; height: 30px; border-radius: 9px;
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-alias-state-business-primary);
}
.aem-sl__id-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.35; }
.aem-sl__id-name { font-size: 13.5px; font-weight: 700; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.aem-sl__id-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.aem-sl__list { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 8px; }
.aem-sl__empty { font-size: 12px; color: var(--dsw-alias-label-tertiary); padding: 16px 10px; text-align: center; line-height: 1.6; }
.aem-sl__group { display: flex; flex-direction: column; gap: 1px; }
/* 不做 sticky：侧栏底色是半透明的（rgba(31,31,31,.8)），吸顶标题下会透出滚过去的行 */
.aem-sl__group-title {
  padding: 12px 10px 4px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
  color: var(--dsw-alias-label-tertiary);
}

.aem-sl__row { position: relative; border-radius: 8px; }
.aem-sl__row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.aem-sl__row[data-active] { background: var(--dsw-alias-state-business-tertiary); }
.aem-sl__row[data-active]::before {
  content: ''; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px; border-radius: 2px;
  background: var(--dsw-alias-state-business-primary);
}
.aem-sl__open {
  display: flex; flex-direction: column; gap: 2px; width: 100%; min-width: 0;
  padding: 6px 10px 6px 12px; border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer;
}
.aem-sl__title { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.4; }
.aem-sl__row[data-active] .aem-sl__title { font-weight: 600; }
.aem-sl__title[data-untitled] { color: var(--dsw-alias-label-secondary); }
.aem-sl__title-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aem-sl__running {
  flex: none; width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-business-primary);
  animation: aem-sl-pulse 1.4s ease-in-out infinite;
}
@keyframes aem-sl-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

.aem-sl__meta { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 11px; line-height: 1.3; color: var(--dsw-alias-label-tertiary); }
.aem-sl__role { display: inline-flex; align-items: center; gap: 5px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aem-sl__role::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.aem-sl__role[data-role="aemeath"]::before { background: #ff8cbd; }
.aem-sl__role[data-role="physicist"]::before { background: #6aa8ff; }
.aem-sl__time { margin-left: auto; flex: none; font-variant-numeric: tabular-nums; }

/* 删除：hover/聚焦时出现在行右侧，同时让出时间的位置 */
.aem-sl__delete {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border: none; border-radius: 6px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  opacity: 0; pointer-events: none; transition: opacity 120ms;
}
.aem-sl__row:hover .aem-sl__delete,
.aem-sl__delete:focus-visible { opacity: 1; pointer-events: auto; }
.aem-sl__row:hover .aem-sl__time { visibility: hidden; }
.aem-sl__delete:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover); }

@media (prefers-reduced-motion: reduce) { .aem-sl__running { animation: none; opacity: 1; } }
`;

/** 注册：shadow 官方 sidebar.workspaces（会话列表 + 品牌头部）。 */
export function registerSessionList(ctx: ClientContext): void {
  if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="@aemeath/dsh-plugin-ui/session-list"]')) {
    const style = document.createElement('style');
    style.setAttribute('data-plugin', 'aemeath-ui');
    style.setAttribute('data-plugin-css', '@aemeath/dsh-plugin-ui/session-list');
    style.textContent = SESSION_LIST_CSS;
    document.head.appendChild(style);
  }
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces',
        priority: -100,
        // 注意：不提供 useSessions（框架 standard kit 注入）；只给业务回调
        inject: () => ({
          open: (id: string) => ctx.uiWorkspace.openSession(id as never),
          archive: (id: string) => void ctx.workspaces.archiveSession(id as never),
        }),
      },
      AemeathSessionList as never,
    ),
  );
  // 注：conversation.hero.workspace 已由 workspace-selector.tsx 接管（P3 恢复工作区选择）
}
