// ============================================================
// 角色状态 pill + 浮动状态簇（UI 改造 P2 → 角色状态）
// 借 Cyrene 的 CharacterStatusPill 与 StatusFloat(浮动状态指示) 结构思路——
//   只借结构不抄代码，用 Aemeath 自己的 t() / SettingsScope 实现。
// 1. 会话顶栏 pill：彩色状态徽章（本地化 label；角色由旁边的分段切换显示），
//    注册进 conversation.session.header.actions（会话作用域，自带 useSession）。
// 2. 浮动状态簇：右下角小簇，只在思考 / 朗读时出现，text-only（无 emoji，TTS 友好）；
//    由 pill 组件经 createPortal 挂 body（quick-settings 同款 Electron 安全做法）。
// 3. 信号接线：思考中=useSession 的 running；朗读中=tts speak 标志；
//    其余=陪伴中。均喂入 status.ts 纯 store。
// 4. 持久化：settings.aemeath-ui 的 showStatusPill / showStatusFloat（默认开）。
// ============================================================
import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { FetchScope as SettingsScope, ScopeSnapshot as SettingsScopeSnapshot } from './faces.ts';
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { t, useLocale } from './i18n.ts';
import { getSpeaking, subscribeSpeaking } from './tts.tsx';
import { useCharacterStatus, setStatusRunning, setStatusSpeaking, type CharacterStatusSnapshot } from './status.ts';

export interface CharacterStatusDeps {
  scopes?: Record<string, SettingsScope>;
}

/** 角色状态持久化 namespace（与外观设置共用 aemeath-ui）。 */
const STATUS_NS = 'aemeath-ui';

// —— useSyncExternalStore 稳定空快照 / no-op 订阅（缺注入时不崩，React #290/#310 安全）——
const EMPTY_SNAPSHOT: SettingsScopeSnapshot = Object.freeze({
  status: 'loading',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'host',
});
const GET_EMPTY_SNAPSHOT = (): SettingsScopeSnapshot => EMPTY_SNAPSHOT;
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined;

/** 读取「是否显示 pill / float」设置（默认开）。 */
function useStatusVisibility(scopes?: Record<string, SettingsScope>): { showPill: boolean; showFloat: boolean } {
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

/**
 * pill 内层（hooks 全在此，无条件调用）。
 *
 * 只显示状态（陪伴中 / 思考中 / 朗读中），不再带头像 + 角色名：紧挨着的分段切换
 * （mode-switch.tsx）已经高亮了当前角色，顶栏原先把同一个名字并排写了两遍。
 * 浮动状态簇只在思考 / 朗读时出现——空闲时右下角一直漂着"陪伴中"只是噪音。
 */
function CharacterStatusPillInner({
  useSession,
  scopes,
}: {
  useSession?: <S>(sel: (s: SessionSnapshot) => S, eq?: (a: S, b: S) => boolean) => S;
  scopes?: Record<string, SettingsScope>;
}): JSX.Element | null {
  useLocale(); // locale 切换时刷新状态文案

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

  return (
    <>
      {showPill ? (
        <span className="aemeath-status-pill" data-aemeath-status-pill data-state={status.state} role="status">
          {t(status.labelKey)}
        </span>
      ) : null}
      {showFloat && status.state !== 'idle' && typeof document !== 'undefined'
        ? createPortal(<StatusFloat status={status} />, document.body)
        : null}
    </>
  );
}

/** pill 外层（零 hooks）：会话作用域缺 useSession 时返回 null（不渲染）。 */
export function CharacterStatusPill(props: CharacterStatusDeps & { useSession?: <S>(sel: (s: SessionSnapshot) => S, eq?: (a: S, b: S) => boolean) => S }): JSX.Element | null {
  const { scopes, useSession } = props;
  if (!useSession) return null;
  return <CharacterStatusPillInner scopes={scopes} useSession={useSession} />;
}

/** 注入一次样式（幂等）。 */
function injectStatusStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('aemeath-status-styles')) return;
  const style = document.createElement('style');
  style.id = 'aemeath-status-styles';
  style.textContent = `
    @keyframes aemeath-status-pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
    @keyframes aemeath-status-float-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
    /* —— 顶栏状态 pill（只有状态：角色已由旁边的分段切换显示）—— */
    .aemeath-status-pill {
      display: inline-flex; align-items: center; gap: 6px;
      height: 24px; padding: 0 10px 0 8px; border-radius: 999px;
      background: var(--dsw-alias-bg-layer-2);
      color: var(--dsw-alias-label-secondary);
      font-size: 11.5px; font-weight: 600; line-height: 1; white-space: nowrap;
    }
    .aemeath-status-pill::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%; flex: none;
      background: var(--dsw-alias-label-tertiary);
    }
    .aemeath-status-pill[data-state="thinking"] {
      background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
      color: var(--dsw-alias-state-business-primary);
    }
    .aemeath-status-pill[data-state="thinking"]::before {
      background: var(--dsw-alias-state-business-primary);
      animation: aemeath-status-pulse 1.2s ease-in-out infinite;
    }
    .aemeath-status-pill[data-state="speaking"] {
      background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);
      color: var(--dsw-alias-state-success-primary);
    }
    .aemeath-status-pill[data-state="speaking"]::before {
      background: var(--dsw-alias-state-success-primary);
      animation: aemeath-status-pulse 1.2s ease-in-out infinite;
    }
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
    @media (prefers-reduced-motion: reduce) {
      .aemeath-status-pill::before, .aemeath-status-float, .aemeath-status-float__dot { animation: none !important; }
    }
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
