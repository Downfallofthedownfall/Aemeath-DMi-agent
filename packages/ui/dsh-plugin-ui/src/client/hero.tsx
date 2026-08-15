// ============================================================
// 爱弥斯开场白（M5 UI 精简 v3 → UI 改造 P2 升级）——替换 dsh hero
// 「探索未至之境（预览版）」→ 爱弥斯欢迎屏 + 角色选择卡片。
// 实现：
//   1. CSS 隐藏原 hero headline 文字与 preview 徽章（结构选择器）；
//   2. 注册 conversation.hero.agentPreset 槽位（root single，官方 ui-agent-preset
//      已被禁用 → 槽位空），注入欢迎屏：问候语 + 角色卡片（小爱同学/学霸）。
// 角色切换语义（决策 Q2）：对新会话生效（写 agent-presets.default，roleFace）。
// ============================================================
import { useSyncExternalStore } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { RoleFace } from './faces.ts';

/** 爱弥斯开场白（新会话欢迎文案）。 */
export const HERO_GREETING = '你好呀，我是爱弥斯 ✦';
export const HERO_SUBTITLE = '想聊聊天，还是让学霸陪你学物理？我都在这里。';

const ROLE_OPTIONS = [
  { id: 'aemeath', label: '小爱同学', hint: '陪伴 · 日常聊天', glyph: '✦' },
  { id: 'physicist', label: '爱弥斯-拉贝尔学部学霸', hint: '物理学习 · 解题', glyph: '⚛' },
] as const;

/** 角色卡片（Win11 卡片样式，选中 = 强调边框 + 淡底）。 */
function RoleCard({
  id,
  label,
  hint,
  glyph,
  active,
  onPick,
}: {
  id: string;
  label: string;
  hint: string;
  glyph: string;
  active: boolean;
  onPick: (id: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      aria-pressed={active}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
        padding: '14px 16px',
        borderRadius: 14,
        cursor: 'pointer',
        textAlign: 'left',
        border: active
          ? '2px solid var(--dsw-alias-state-business-primary)'
          : '1px solid var(--dsw-alias-border-l2)',
        background: active
          ? 'var(--dsw-alias-state-business-tertiary)'
          : 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: active ? 'var(--fluent-shadow-sm)' : 'none',
        transition: 'border-color var(--fluent-motion), background var(--fluent-motion), box-shadow var(--fluent-motion)',
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--dsw-alias-state-business-primary)' }}>{glyph}</span>
        {label}
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }}>{hint}</span>
    </button>
  );
}

/** 欢迎屏主体（hooks 全在此：角色订阅）。 */
function HeroLoaded({ role }: { role: RoleFace }): JSX.Element {
  const current = useSyncExternalStore(role.subscribe, role.getSnapshot);
  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        width: '100%',
        minWidth: 0,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: '18px 24px 12px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: 'var(--dsw-alias-label-primary)',
          letterSpacing: 0.3,
        }}
      >
        {HERO_GREETING}
      </div>
      <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)', maxWidth: 460, lineHeight: 1.6 }}>
        {HERO_SUBTITLE}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 10,
          width: '100%',
          maxWidth: 520,
          marginTop: 10,
        }}
      >
        {ROLE_OPTIONS.map((opt) => (
          <RoleCard
            key={opt.id}
            id={opt.id}
            label={opt.label}
            hint={opt.hint}
            glyph={opt.glyph}
            active={current === opt.id}
            onPick={(id) => void role.set(id)}
          />
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 }}>
        选择后对之后新建的会话生效；当前会话保持创建时的角色。
      </div>
    </div>
  );
}

/** 外层（零 hooks）：role face 未注入时返回 null（React #290 安全模式）。 */
export function AemeathHero(props: { role?: RoleFace }): JSX.Element | null {
  if (!props.role) return null;
  return <HeroLoaded role={props.role} />;
}

/** 隐藏 dsh 原版 hero 文案（探索未至之境 / 预览版 / 工作区行）。 */
function injectHeroHideCss(): void {
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-plugin', 'aemeath-ui');
  style.setAttribute('data-plugin-css', '@aemeath/dsh-plugin-ui/hero-hide');
  style.textContent = `
    /* 隐藏 dsh hero 的 headline 文字与 preview 徽章（结构选择器，避开 hash class） */
    [class*="headline"] [class*="headlineText"] { display: none !important; }
    [class*="headline"] [class*="previewBadge"] { display: none !important; }
    /* 注：hero 工作区行已由 workspace-selector.tsx 接管（P3），
       不在此隐藏官方触发器（避免误伤自定义选择器）；
       若官方 EmptyHero 仍有残留按钮，由 de-dsh.ts §8 的 aria-label 规则兜底。 */
  `;
  document.head.appendChild(style);
}

/** 注册欢迎屏。 */
export function registerHero(ctx: ClientContext, deps: { role: () => RoleFace }): void {
  injectHeroHideCss();
  ctx.slots.inject('conversation.hero.agentPreset', () =>
    ctx.slots.register(
      {
        name: 'conversation.hero.agentPreset',
        priority: -100,
        inject: () => ({ role: deps.role() }),
      },
      AemeathHero as never,
    ),
  );
}
