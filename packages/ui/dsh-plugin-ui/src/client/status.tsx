// ============================================================
// 角色状态 pill + 浮动状态簇（UI 改造 P2 → 角色状态）
// 借 Cyrene 的 CharacterStatusPill(头像+角色名+状态徽章) 与
//   StatusFloat(浮动状态指示) 结构思路——只借结构不抄代码，用 Aemeath
//   自己的 BrandMark / t() / SettingsScope 实现。
// 1. 会话顶栏 pill：avatar(BrandMark) + 角色名 + 彩色状态徽章（本地化 label），
//    注册进 conversation.session.header.actions（会话作用域，自带 useSession）。
// 2. 浮动状态簇：右下角小簇，text-only（无 emoji，TTS 友好），微动画；
//    由 pill 组件经 createPortal 挂 body（quick-settings 同款 Electron 安全做法）。
// 3. 信号接线：思考中=useSession 的 running；朗读中=tts speak 标志；
//    其余=陪伴中。均喂入 status.ts 纯 store。
// 4. 持久化：settings.aemeath-ui 的 showStatusPill / showStatusFloat（默认开）。
// ============================================================
import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { RoleFace } from './faces.ts';
import { BrandMark } from './brand.tsx';
import { t, useLocale } from './i18n.ts';
import { getSpeaking, subscribeSpeaking } from './tts.tsx';
import { useCharacterStatus, setStatusRunning, setStatusSpeaking, type CharacterStatusSnapshot } from './status.ts';

export interface CharacterStatusDeps {
  role?: RoleFace;
  scopes?: Record<string, SettingsScope<Record<string, unknown>>>;
}

/** 角色状态持久化 namespace（与外观设置共用 aemeath-ui）。 */
const STATUS_NS = 'aemeath-ui';

// —— useSyncExternalStore 稳定空快照 / no-op 订阅（缺注入时不崩，React #290/#310 安全）——
const EMPTY_SNAPSHOT: SettingsScopeSnapshot<Record<string, unknown>> = Object.freeze({
  status: 'loading',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory',
});
const GET_EMPTY_SNAPSHOT = (): SettingsScopeSnapshot<Record<string, unknown>> => EMPTY_SNAPSHOT;
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined;
const GET_DEFAULT_ROLE = (): string => 'aemeath';

/** 读取「是否显示 pill / float」设置（默认开）。 */
function useStatusVisibility(scopes?: Record<string, SettingsScope<Record<string, unknown>>>): { showPill: boolean; showFloat: boolean } {
  const scope = scopes?.[STATUS_NS];
  const snap = useSyncExternalStore(scope ? scope.subscribe : NOOP_SUBSCRIBE, scope ? scope.getSnapshot : GET_EMPTY_SNAPSHOT);
  const v = snap?.value as { showStatusPill?: boolean; showStatusFloat?: boolean } | undefined;
  return {
    showPill: v?.showStatusPill !== false, // 缺省开
    showFloat: v?.showStatusFloat !== false, // 缺省开
  };
}

/** 浮动状态簇：右下角小簇，text-only + 微动画（纯装饰，不覆盖 composer）。 */
function StatusFloat({ status }: { status: CharacterStatusSnapshot }): JSX.Element {
  useLocale(); // locale 切换时刷新文案
  return (
    <div className="aemeath-status-float" data-state={status.state} aria-hidden="true">
      <span className="aemeath-status-float__dot" />
      <span className="aemeath-status-float__label">{t(status.labelKey)}</span>
    </div>
  );
}

/** pill 内层（hooks 全在此，无条件调用）。 */
function CharacterStatusPillInner({
  useSession,
  role,
  scopes,
}: {
  useSession?: <S>(sel: (s: ConversationSnapshot) => S, eq?: (a: S, b: S) => boolean) => S;
  role?: RoleFace;
  scopes?: Record<string, SettingsScope<Record<string, unknown>>>;
}): JSX.Element | null {
  useLocale(); // locale 切换时刷新角色名/状态文案

  // 信号 1：当前会话模型是否正在响应（思考中）——会话作用域框架 kit 提供
  const running = useSession?.((s) => s.running) ?? false;
  useEffect(() => {
    setStatusRunning(running);
  }, [running]);

  // 信号 2：TTS 是否正在朗读（朗读中）——复用 tts.tsx 的 speaking 标志
  const speaking = useSyncExternalStore(subscribeSpeaking, getSpeaking);
  useEffect(() => {
    setStatusSpeaking(speaking);
  }, [speaking]);

  // 角色状态 + 可见性设置
  const status = useCharacterStatus();
  const { showPill, showFloat } = useStatusVisibility(scopes);

  // 角色名：订阅 role face；role 缺省时回退品牌名（constant getter 保稳定引用）
  const roleId = useSyncExternalStore(role ? role.subscribe : NOOP_SUBSCRIBE, role ? role.getSnapshot : GET_DEFAULT_ROLE);
  const roleLabel = role ? (roleId === 'physicist' ? t('hero.role.physicist') : t('hero.role.aemeath')) : t('brand.name');

  return (
    <>
      {showPill ? (
        <span className="aemeath-status-pill" data-aemeath-status-pill data-state={status.state}>
          <span className="aemeath-status-pill__avatar">
            <BrandMark />
          </span>
          <span className="aemeath-status-pill__name">{roleLabel}</span>
          <span className="aemeath-status-pill__divider">·</span>
          <span className="aemeath-status-pill__badge">{t(status.labelKey)}</span>
        </span>
      ) : null}
      {showFloat && typeof document !== 'undefined' ? createPortal(<StatusFloat status={status} />, document.body) : null}
    </>
  );
}

/** pill 外层（零 hooks）：会话作用域缺 useSession 时返回 null（不渲染）。 */
export function CharacterStatusPill(props: CharacterStatusDeps & { useSession?: <S>(sel: (s: ConversationSnapshot) => S, eq?: (a: S, b: S) => boolean) => S }): JSX.Element | null {
  const { role, scopes, useSession } = props;
  if (!useSession) return null;
  return <CharacterStatusPillInner role={role} scopes={scopes} useSession={useSession} />;
}

/** 注入一次样式（幂等）。 */
function injectStatusStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('aemeath-status-styles')) return;
  const style = document.createElement('style');
  style.id = 'aemeath-status-styles';
  style.textContent = `
    @keyframes aemeath-status-pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
    @keyframes aemeath-status-float-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
    /* —— 顶栏状态 pill —— */
    .aemeath-status-pill {
      display: inline-flex; align-items: center; gap: 7px;
      height: 26px; padding: 0 10px 0 6px; border-radius: 999px;
      border: 1px solid var(--dsw-alias-border-l2);
      background: var(--dsw-alias-bg-layer-1);
      color: var(--dsw-alias-label-secondary);
      font-size: 12px; line-height: 1; white-space: nowrap;
    }
    .aemeath-status-pill__avatar {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 6px; flex: none;
      color: var(--dsw-alias-state-business-primary);
    }
    .aemeath-status-pill__name { font-weight: 600; color: var(--dsw-alias-label-primary); }
    .aemeath-status-pill__divider { color: var(--dsw-alias-label-tertiary); }
    .aemeath-status-pill__badge {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
      background: var(--dsw-alias-bg-layer-2);
      color: var(--dsw-alias-label-secondary);
    }
    .aemeath-status-pill__badge::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%; flex: none;
      background: var(--dsw-alias-label-tertiary);
      animation: aemeath-status-pulse 1.8s ease-in-out infinite;
    }
    .aemeath-status-pill[data-state="thinking"] .aemeath-status-pill__badge {
      background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
      color: var(--dsw-alias-state-business-primary);
    }
    .aemeath-status-pill[data-state="thinking"] .aemeath-status-pill__badge::before { background: var(--dsw-alias-state-business-primary); }
    .aemeath-status-pill[data-state="speaking"] .aemeath-status-pill__badge {
      background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);
      color: var(--dsw-alias-state-success-primary);
    }
    .aemeath-status-pill[data-state="speaking"] .aemeath-status-pill__badge::before { background: var(--dsw-alias-state-success-primary); }
    /* —— 浮动状态簇 —— */
    .aemeath-status-float {
      position: fixed; right: 18px; bottom: 150px; z-index: 9990;
      display: inline-flex; align-items: center; gap: 7px; pointer-events: none;
      padding: 6px 12px; border-radius: 999px;
      border: 1px solid var(--dsw-alias-border-l2);
      background: var(--dsw-alias-bg-layer-2);
      color: var(--dsw-alias-label-secondary);
      font-size: 12px; line-height: 1;
      box-shadow: var(--fluent-shadow-sm, 0 1px 3px rgba(0,0,0,0.06));
      animation: aemeath-status-float-float 3.2s ease-in-out infinite;
    }
    .aemeath-status-float__dot {
      width: 8px; height: 8px; border-radius: 50%; flex: none;
      background: var(--dsw-alias-label-tertiary);
      animation: aemeath-status-pulse 1.8s ease-in-out infinite;
    }
    .aemeath-status-float[data-state="thinking"] .aemeath-status-float__dot { background: var(--dsw-alias-state-business-primary); }
    .aemeath-status-float[data-state="speaking"] .aemeath-status-float__dot { background: var(--dsw-alias-state-success-primary); }
  `;
  document.head.appendChild(style);
}

/** 注册：会话顶栏状态 pill（角色状态）。 */
export function registerCharacterStatus(ctx: ClientContext, deps: () => CharacterStatusDeps): void {
  injectStatusStyles();
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'aemeath-status',
        order: -100, // 负值 = 紧跟 title 的静态会话上下文（先于交互 action）
        inject: () => deps(),
      },
      CharacterStatusPill as never,
    ),
  );
}
