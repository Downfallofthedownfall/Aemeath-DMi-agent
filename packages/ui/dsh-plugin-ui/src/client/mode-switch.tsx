// ============================================================
// mode-switch.tsx —— 会话顶栏 · 分段角色切换（feat #3）
// 借 Cyrene 的 ModeSwitch（cy-segmented 分段芯片：图标+标签，最后选择持久化到
//   LAST_MODE_STORAGE_KEY 并在重开时恢复）结构思路——只借结构不抄代码，用 Aemeath
//   自己的 role face / t() / --dsw-alias-state-business-* 主题令牌实现。
// 显示什么（真机反馈"翻看历史对话不会动态切换"后改过）：
//   · 打开的是**有角色的对话** → 高亮这条对话创建时的角色（会话列表投影的 agentPreset）；
//     对话的角色定了就改不了，所以点另一个角色 = 用那个角色开一个新对话（同时设为新对话默认）。
//   · 空白对话 / 读不到角色 → 高亮"新对话默认角色"（role face），点击只改默认。
// 与 hero（欢迎屏角色卡片）/ quick-settings（分段角色）共用同一 role face：
//   role.set(id) → 写 agent-presets.default（后端唯一真源）。
// 持久化：额外把「上次角色」镜像到 localStorage（key: aemeath.lastRole，Cyrene 式
//   LAST_MODE_STORAGE_KEY 思路），仅 UI 便利；真源仍是 role face（agent-presets.default），
//   两者保持一致——镜像在真源变化时同步写入，绝不反向改写后端。
// ============================================================
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { RoleFace } from './faces.ts';
import { t, useLocale } from './i18n.ts';
import { showToast } from './tts.tsx';

/** Cyrene 式 localStorage 键：镜像「上次选择的角色」，UI 便利，非真源。 */
export const LAST_ROLE_STORAGE_KEY = 'aemeath.lastRole';

function readLastRole(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(LAST_ROLE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistLastRole(role: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LAST_ROLE_STORAGE_KEY, role);
  } catch {
    /* localStorage 不可用：静默（仅 UI 便利，不影响真源） */
  }
}

const ROLE_OPTIONS = [
  { id: 'aemeath', labelKey: 'quick.role.aemeath' },
  { id: 'physicist', labelKey: 'quick.role.physicist' },
] as const;

/** 会话自身的角色（来自会话列表投影；index.ts 用 ctx.sessions.list / ctx.uiWorkspace 实现）。 */
export interface SessionRoleSource {
  subscribe(l: () => void): () => void;
  /** 这条对话创建时的角色；空白对话 / 列表里还没有 / 没有投影值 → undefined。 */
  presetOf(sessionId: string): string | undefined;
  /** 用指定角色开一个新对话（宿主复用空白对话或新建）。 */
  startWith(preset: string): void;
}

export interface ModeSwitchDeps {
  role?: RoleFace;
  sessionRole?: SessionRoleSource;
}

type UseSession = <S>(sel: (s: SessionSnapshot) => S, eq?: (a: S, b: S) => boolean) => S;

// 缺注入时的稳定兜底（模块级常量：保持 hook 调用次数与引用稳定）
const NO_SESSION: UseSession = <S,>(sel: (s: SessionSnapshot) => S): S => sel({} as SessionSnapshot);
const NO_SESSION_ROLE: SessionRoleSource = {
  subscribe: () => () => undefined,
  presetOf: () => undefined,
  startWith: () => undefined,
};

/** 订阅快照带上 loaded：后端读回的值恰好等于模块初值时，loaded 翻转也要触发重渲染。 */
function roleSnapshotOf(role: RoleFace): () => string {
  return () => `${role.loaded ? 'L' : 'B'}:${role.current}`;
}

/** 控制内部体（hooks 全在此，无条件调用）。 */
function ModeSwitchLoaded({
  role,
  sessionRole,
  useSession,
}: {
  role: RoleFace;
  sessionRole: SessionRoleSource;
  useSession: UseSession;
}): JSX.Element {
  useLocale(); // locale 切换时刷新芯片文案
  const [getSnapshot] = useState(() => roleSnapshotOf(role));
  const snapshot = useSyncExternalStore(role.subscribe, getSnapshot);
  const loaded = snapshot.startsWith('L:');
  const current = snapshot.slice(2);

  // 当前打开的对话自己的角色（切到历史对话时跟着变）
  const sessionId = String(useSession((s) => s.sessionId ?? '') ?? '');
  const getSessionPreset = useCallback(() => sessionRole.presetOf(sessionId), [sessionRole, sessionId]);
  const sessionPreset = useSyncExternalStore(sessionRole.subscribe, getSessionPreset);

  // 开机恢复：后端真值读回**之前**，先用 localStorage 上次选择作为乐观初值（避免闪回默认）。
  // ⚠️ 真机踩过（"顶部的模态不会换"）：早先的条件是 `current === 默认角色` 就用 bootRole，
  //   没有时限 —— 一旦存过"学霸"，之后真源是小爱同学时顶栏也永远显示学霸；
  //   点「小爱同学」写进了后端，但显示纹丝不动（还会把学霸再镜像回 localStorage）。
  //   现在：只要 face 读回过真值（loaded），一律以真源为准。
  const [bootRole] = useState<string | null>(() => readLastRole());
  const defaultRole = !loaded && bootRole ? bootRole : current;
  const active = sessionPreset ?? defaultRole;

  // 镜像：只镜像**真源**（face = agent-presets.default）；乐观初值不回写，免得自我强化。
  // 任何 role.set 来源（hero / quick-settings / 本控件）都会经 face notify 触发此处。
  useEffect(() => {
    if (loaded) persistLastRole(current);
  }, [loaded, current]);

  const pick = (id: string): void => {
    if (sessionPreset) {
      if (id === sessionPreset) return;
      // 已有角色的对话改不了角色：用新角色开一个新对话（角色显式传给宿主，不依赖默认值写成功）
      sessionRole.startWith(id);
    }
    // 写 agent-presets.default（后端真源），face notify → 默认角色更新 → 镜像写入。
    // 写失败时 face 不变：给出提示，不再静默"点了没反应"。
    role.set(id).catch(() => showToast(t('modeswitch.error')));
  };

  return (
    <div
      className="aemeath-mode-switch"
      role="group"
      aria-label={t('modeswitch.aria')}
      title={sessionPreset ? t('modeswitch.title.session') : t('modeswitch.title')}
    >
      {ROLE_OPTIONS.map((opt) => {
        const isActive = active === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => pick(opt.id)}
            aria-pressed={isActive}
            className={`aemeath-mode-switch__chip${isActive ? ' is-active' : ''}`}
          >
            <span className="aemeath-mode-switch__dot" />
            <span>{t(opt.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 外层（零 hooks）：role face 未注入时返回 null（React #290/#310 安全模式）。 */
export function ModeSwitch(props: ModeSwitchDeps & { useSession?: UseSession }): JSX.Element | null {
  if (!props.role) return null;
  return (
    <ModeSwitchLoaded
      role={props.role}
      sessionRole={props.sessionRole ?? NO_SESSION_ROLE}
      useSession={props.useSession ?? NO_SESSION}
    />
  );
}

/** 注入一次样式（幂等）。 */
function injectModeSwitchStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('aemeath-mode-switch-styles')) return;
  const style = document.createElement('style');
  style.id = 'aemeath-mode-switch-styles';
  style.textContent = `
    .aemeath-mode-switch {
      display: inline-flex; align-items: center; gap: 2px;
      padding: 2px; border-radius: 10px;
      border: 1px solid var(--dsw-alias-border-l2);
      background: var(--dsw-alias-bg-layer-2);
    }
    .aemeath-mode-switch__chip {
      display: inline-flex; align-items: center; gap: 6px;
      height: 22px; padding: 0 10px; border-radius: 8px;
      border: none; cursor: pointer;
      font-size: 12px; font-weight: 500; line-height: 1; white-space: nowrap;
      background: transparent; color: var(--dsw-alias-label-secondary);
      transition: background var(--fluent-motion), color var(--fluent-motion), box-shadow var(--fluent-motion);
    }
    .aemeath-mode-switch__chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .aemeath-mode-switch__chip.is-active {
      background: var(--dsw-alias-bg-base);
      color: var(--dsw-alias-state-business-primary);
      font-weight: 700;
      box-shadow: var(--fluent-shadow-sm);
    }
    .aemeath-mode-switch__dot {
      width: 6px; height: 6px; border-radius: 50%; flex: none;
      background: var(--dsw-alias-label-tertiary);
    }
    .aemeath-mode-switch__chip.is-active .aemeath-mode-switch__dot { background: var(--dsw-alias-state-business-primary); }
  `;
  document.head.appendChild(style);
}

/** 注册：会话顶栏 · 分段角色切换（紧随状态 pill 的静态会话上下文）。 */
export function registerModeSwitch(ctx: ClientContext, deps: () => ModeSwitchDeps): void {
  injectModeSwitchStyles();
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'aemeath-mode-switch',
        order: -90, // 负值 = 静态会话上下文（紧跟 status pill 的 -100）
        inject: () => deps(),
      },
      ModeSwitch as never,
    ),
  );
}
