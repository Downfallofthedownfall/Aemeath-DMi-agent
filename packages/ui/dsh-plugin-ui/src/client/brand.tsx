// ============================================================
// 品牌层（M5 F1）——页面标题 + 侧边栏品牌位
// 目标：告别 dsh 原版「开发工具」观感，呈现「爱弥斯 · 物理学习 Copilot」。
// 手段：
//   1. document.title：页面加载即设置（品牌标题）。
//   2. sidebar.footer.action：侧边栏底部品牌标识（图标 + 标题）。
//   3. settings.section：设置面板标题由注册者提供，见 settings.tsx。
// ============================================================
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';

export const BRAND_TITLE = '爱弥斯 · 物理学习 Copilot';
export const BRAND_SUBTITLE = 'Aemeath-DMi · 星炬 & 爱弥斯';

/** 品牌徽记：⚛ 爱弥斯。纯 inline SVG 避免外部资源。 */
export function BrandMark(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <ellipse cx="12" cy="12" rx="9" ry="4" stroke="currentColor" strokeWidth="1.2" />
      <ellipse cx="12" cy="12" rx="4" ry="9" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** 设置页面标题（品牌位）；供设置面板 header 复用。 */
export function BrandTitle(): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ color: 'var(--dsw-alias-state-business-primary)' }}>
        <BrandMark />
      </span>
      <span>爱弥斯 · 物理学习 Copilot</span>
    </span>
  );
}

/**
 * 侧边栏底部品牌位（sidebar.footer.action 注册项）。
 * 宽栏显示标题，窄栏（rail）只显示徽记。
 */
export function SidebarBrand({ wide }: { wide: boolean }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 6px',
        borderRadius: 8,
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.2,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: 'var(--dsw-alias-state-business-primary)', display: 'inline-flex' }}>
        <BrandMark />
      </span>
      {wide ? '爱弥斯 · 物理学习 Copilot' : null}
    </span>
  );
}

/** 设置页面标题为品牌位（替换 dsh 原版 "Settings"）。 */
export function BrandSettingsHeader(): JSX.Element {
  return <BrandTitle />;
}

/** 注册品牌层：页面标题 + 侧边栏品牌位 + 隐藏 dsh 原版品牌元素。 */
export function applyBrand(ctx: ClientContext): void {
  // 0) 隐藏 dsh 原版品牌/鲸鱼元素（FishLogo 的固定 viewBox + 相关品牌文字）
  if (typeof document !== 'undefined') {
    const style = document.createElement('style');
    style.setAttribute('data-plugin', 'aemeath-ui');
    style.setAttribute('data-plugin-css', '@aemeath/dsh-plugin-ui/brand-hide');
    style.textContent = `
      /* 隐藏 dsh 鲸鱼 logo（FishLogo viewBox 特征） */
      svg[viewBox="0 0 23.16 17.04"] { display: none !important; }
      /* 隐藏 dsh 品牌 wordmark（viewBox 特征） */
      svg[viewBox^="0 0 182 24"] { display: none !important; }
      /* 兜底：aria-hidden 的品牌 svg */
      .ds-brand, [class*="brand"] svg[aria-hidden="true"] { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  // 1) 页面标题（立即生效 + 持续保持）
  if (typeof document !== 'undefined') {
    document.title = BRAND_TITLE;
    const keep = (): void => {
      if (document.title !== BRAND_TITLE) document.title = BRAND_TITLE;
    };
    // 某些 UI 可能改写 title，周期性兜底（低频，无感）
    const timer = window.setInterval(keep, 5000);
    ctx.effect(() => () => window.clearInterval(timer));
  }

  // 2) 侧边栏底部品牌位（footer.action 列表槽）
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'aemeath-brand',
        order: -100,
        inject: () => ({}),
      },
      SidebarBrand,
    ),
  );
}
