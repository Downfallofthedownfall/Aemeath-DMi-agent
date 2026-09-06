// ============================================================
// mode-switch.tsx —— 会话顶栏 · 分段角色切换（feat #3）
// 借 Cyrene 的 ModeSwitch（cy-segmented 分段芯片：图标+标签，最后选择持久化到
//   LAST_MODE_STORAGE_KEY 并在重开时恢复）结构思路——只借结构不抄代码，用 Aemeath
//   自己的 role face / t() / --dsw-alias-state-business-* 主题令牌实现。
// 与 hero（欢迎屏角色卡片）/ quick-settings（分段角色）共用同一 role face：
//   点击芯片 → role.set(id) → 写 agent-presets.default（后端唯一真源）。
//   该控件仅补足「会话顶栏持续可切换」这层 UI，与既有入口互补、不冲突。
// 持久化：额外把「上次角色」镜像到 localStorage（key: aemeath.lastRole，Cyrene 式
//   LAST_MODE_STORAGE_KEY 思路），仅 UI 便利；真源仍是 role face（agent-presets.default），
//   两者保持一致——镜像在真源变化时同步写入，绝不反向改写后端。
// ============================================================
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { RoleFace } from './faces.ts';
import { t, useLocale } from './i18n.ts';

/** Cyrene 式 localStorage 键：镜像「上次选择的角色」，UI 便利，非真源。 */
export const LAST_ROLE_STORAGE_KEY = 'aemeath.lastRole';

/** 角色 face 的模块默认值（后端未读回前的初值，见 faces.ts roleFace.current 初始化）。 */
const DEFAULT_ROLE = 'aemeath';

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

export interface ModeSwitchDeps {
  role?: RoleFace;
}

/** 控制内部体（hooks 全在此，无条件调用）。 */
function ModeSwitchLoaded({ role }: { role: RoleFace }): JSX.Element {
  useLocale(); // locale 切换时刷新芯片文案
  const current = useSyncExternalStore(role.subscribe, role.getSnapshot);

  // 开机恢复：后端 agent-presets.default 异步读回前，先用 localStorage 上次选择作为
  // 乐观初值（避免闪回默认）；一旦 face 给出非默认值即全信真源，杜绝长时间背离。
  const [bootRole] = useState<string | null>(() => readLastRole());
  const active = bootRole && current === DEFAULT_ROLE ? bootRole : current;

  // 镜像：真源（face = agent-presets.default）变化时同步 localStorage；只写不读回真源。
  // 任何 role.set 来源（hero / quick-settings / 本控件）都会经 face notify 触发此处。
  useEffect(() => {
    persistLastRole(active);
  }, [active]);

  const pick = (id: string): void => {
    void role.set(id); // 写 agent-presets.default（后端真源），face notify → active 更新 → 镜像写入
  };

  return (
    <div className="aemeath-mode-switch" role="group" aria-label={t('modeswitch.aria')}>
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
export function ModeSwitch(props: ModeSwitchDeps): JSX.Element | null {
  if (!props.role) return null;
  return <ModeSwitchLoaded role={props.role} />;
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
