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
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { RoleFace } from './faces.ts';
import { t, useLocale } from './i18n.ts';

/** 角色卡片选项（id/glyph 静态；label/hint 随 locale 渲染时解析）。 */
const ROLE_OPTIONS = [
  { id: 'aemeath', hintKey: 'hero.role.aemeath.hint', glyph: '✦' },
  { id: 'physicist', hintKey: 'hero.role.physicist.hint', glyph: '⚛' },
] as const;

/** 角色卡片（选中 = 强调边框 + 淡底 + 右上角对勾；样式见 HERO_CSS）。 */
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
    <button type="button" className="aem-hero__card" data-role={id} onClick={() => onPick(id)} aria-pressed={active}>
      <span className="aem-hero__avatar" aria-hidden="true">
        {glyph}
      </span>
      <span className="aem-hero__card-text">
        <span className="aem-hero__card-label">{label}</span>
        <span className="aem-hero__card-hint">{hint}</span>
      </span>
      <span className="aem-hero__check" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 5.2l2 2 4-4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  );
}

/** 欢迎屏主体（hooks 全在此：角色订阅 + locale 订阅）。 */
function HeroLoaded({ role }: { role: RoleFace }): JSX.Element {
  const current = useSyncExternalStore(role.subscribe, role.getSnapshot);
  useLocale(); // 订阅 locale 切换 → 重渲染以刷新文案
  const roleLabel = (id: 'aemeath' | 'physicist'): string =>
    id === 'aemeath' ? t('hero.role.aemeath') : t('hero.role.physicist');
  return (
    <div className="aem-hero">
      <div className="aem-hero__greeting">{t('hero.greeting')}</div>
      <div className="aem-hero__subtitle">{t('hero.subtitle')}</div>
      <div className="aem-hero__cards" role="group" aria-label={t('modeswitch.aria')}>
        {ROLE_OPTIONS.map((opt) => (
          <RoleCard
            key={opt.id}
            id={opt.id}
            label={roleLabel(opt.id)}
            hint={t(opt.hintKey)}
            glyph={opt.glyph}
            active={current === opt.id}
            onPick={(id) => void role.set(id)}
          />
        ))}
      </div>
      <div className="aem-hero__note">{t('hero.note')}</div>
    </div>
  );
}

const HERO_CSS = `
.aem-hero {
  display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; width: 100%; min-width: 0; padding: 18px 24px 14px; text-align: center;
}
.aem-hero__greeting { font-size: 26px; font-weight: 700; letter-spacing: 0.3px; color: var(--dsw-alias-label-primary); }
.aem-hero__subtitle { max-width: 460px; font-size: 13.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.aem-hero__cards {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px;
  width: 100%; max-width: 540px; margin-top: 14px;
}
.aem-hero__card {
  position: relative; display: flex; align-items: center; gap: 12px;
  padding: 12px 14px; border-radius: 14px; cursor: pointer; text-align: left;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary); font: inherit;
  transition: border-color var(--fluent-motion), background var(--fluent-motion), box-shadow var(--fluent-motion), transform var(--fluent-motion);
}
.aem-hero__card:hover { border-color: var(--dsw-alias-border-l3); transform: translateY(-1px); box-shadow: var(--fluent-shadow-sm); }
.aem-hero__card[aria-pressed="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary) inset;
}
.aem-hero__avatar {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 38px; height: 38px; border-radius: 50%; font-size: 17px; color: #fff;
  background: linear-gradient(135deg, #ffa8cd, #f25e9e);
}
.aem-hero__card[data-role="physicist"] .aem-hero__avatar { background: linear-gradient(135deg, #8ec5ff, #4a7fe2); }
.aem-hero__card-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.aem-hero__card-label { font-size: 14.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aem-hero__card-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.aem-hero__check {
  position: absolute; top: 8px; right: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 50%; color: #fff;
  background: var(--dsw-alias-state-business-primary);
  opacity: 0; transform: scale(0.6); transition: opacity var(--fluent-motion), transform var(--fluent-motion);
}
.aem-hero__card[aria-pressed="true"] .aem-hero__check { opacity: 1; transform: none; }
.aem-hero__note { margin-top: 4px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
@media (prefers-reduced-motion: reduce) { .aem-hero__card, .aem-hero__check { transition: none; } .aem-hero__card:hover { transform: none; } }
`;

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
    /* dsh 0.2 把文字容器改名为 titleGroup（headlineText 不再匹配 →「探索未至之境」
       又露出来，和我们的问候语叠成两行标题）。整行 headline 一起收掉，不留空白。 */
    [class*="_headline"]:has(> [class*="_titleGroup"]) { display: none !important; }
    /* 注：hero 工作区行已由 workspace-selector.tsx 接管（P3），
       不在此隐藏官方触发器（避免误伤自定义选择器）；
       若官方 EmptyHero 仍有残留按钮，由 de-dsh.ts §8 的 aria-label 规则兜底。 */
    ${HERO_CSS}
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
