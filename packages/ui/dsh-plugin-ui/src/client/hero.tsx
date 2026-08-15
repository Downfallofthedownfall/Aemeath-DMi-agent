// ============================================================
// 爱弥斯开场白（M5 UI 精简 v3）——替换 dsh hero「探索未至之境（预览版）」
// 实现：
//   1. CSS 隐藏原 hero headline 文字与 preview 徽章（hash class 不稳，
//      用结构选择器：HeroShell 的 headline 区域）；
//   2. 注册 conversation.hero.agentPreset 槽位（root single，
//      官方 ui-agent-preset 已被禁用 → 槽位空），注入爱弥斯开场白。
// ============================================================
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';

/** 爱弥斯开场白（新会话欢迎文案）。 */
export const HERO_GREETING = '你好呀，我是爱弥斯 ✦';
export const HERO_SUBTITLE = '想聊聊天，还是让爱弥斯-拉贝尔学部学霸陪你学物理？我都在这里。';

/** 开场白组件（注入 conversation.hero.agentPreset 槽位；全宽占满 hero workspace 行）。 */
export function AemeathHero(): JSX.Element {
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
        gap: 6,
        padding: '14px 0 10px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: 'var(--dsw-alias-label-primary)',
          letterSpacing: 0.3,
          whiteSpace: 'nowrap',
        }}
      >
        {HERO_GREETING}
      </div>
      <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)', maxWidth: 420, lineHeight: 1.6, whiteSpace: 'nowrap' }}>
        {HERO_SUBTITLE}
      </div>
    </div>
  );
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
    /* 隐藏 hero 的工作区 chip/dropdown（aria-label 特征，比 hash class 稳） */
    button[aria-label="选择工作区"] { display: none !important; }
    button[aria-label="Choose workspace"] { display: none !important; }
    [class*="_workspace"] { display: none !important; }
  `;
  document.head.appendChild(style);
}

/** 注册开场白。 */
export function registerHero(ctx: ClientContext): void {
  injectHeroHideCss();
  ctx.slots.inject('conversation.hero.agentPreset', () =>
    ctx.slots.register(
      {
        name: 'conversation.hero.agentPreset',
        priority: -100,
        inject: () => ({}),
      },
      AemeathHero as never,
    ),
  );
}
