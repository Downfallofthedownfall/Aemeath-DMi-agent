// ============================================================
// 爱弥斯主题（M5 F1）——注册进 dsh 主题系统（ctx.theme.register）
// 基于 dsh 的 --dsw-alias-* token 覆盖层；light/dark 双模式。
// 配色灵感：爱弥斯（暖金 + 深蓝 + 米白），爱弥斯-拉贝尔学部学霸（学术蓝）。
// ============================================================
import type { ThemeDefinition } from '@deepseek-ai/dsh-client-ui-theme/client';

/** 爱弥斯主题：白色基底 + 极淡暖黄（柔和、不刺眼），暖金主色。 */
export const aemeathLight: ThemeDefinition = {
  id: 'aemeath',
  colorScheme: 'light',
  tokens: {
    '--dsw-alias-state-business-primary': '#c9a227',
    '--dsw-alias-state-business-primary-hover': '#b8921f',
    '--dsw-alias-accent': '#c9a227',
    '--dsw-alias-label-primary': '#2a2a28',
    '--dsw-alias-label-secondary': '#5c5a52',
    '--dsw-alias-bg-base': '#fdfcf9',
    '--dsw-alias-bg-subtle': '#faf8f2',
    '--dsw-alias-border-l1': '#eee9dc',
    '--dsw-alias-border-l2': '#e2dbc8',
    '--dsw-alias-state-business-tertiary': '#f7f1dd',
  },
};

/** 爱弥斯-拉贝尔学部学霸主题：学术蓝主色（严谨的物理学习），深色基底。 */
export const physicistDark: ThemeDefinition = {
  id: 'physicist',
  colorScheme: 'dark',
  tokens: {
    '--dsw-alias-state-business-primary': '#5b8def',
    '--dsw-alias-state-business-primary-hover': '#4a7cdd',
    '--dsw-alias-accent': '#5b8def',
    '--dsw-alias-label-primary': '#e8ecf4',
    '--dsw-alias-label-secondary': '#aab4c8',
    '--dsw-alias-bg-base': '#141821',
    '--dsw-alias-bg-subtle': '#1b2130',
    '--dsw-alias-border-l1': '#2a3245',
    '--dsw-alias-border-l2': '#36405a',
  },
};

/** 注册两个主题（幂等：同一 id 重复注册会 throw，dispose 可卸载）。 */
export function registerThemes(ctx: {
  theme?: {
    register(d: ThemeDefinition): () => void;
    setTheme(id: string): void;
    getTheme(): { preference: string; active: { id: string } };
  };
}): void {
  const theme = ctx.theme;
  if (!theme) return;
  try {
    theme.register(aemeathLight);
  } catch {
    /* 已注册：忽略 */
  }
  try {
    theme.register(physicistDark);
  } catch {
    /* 已注册：忽略 */
  }
  // 默认切到爱弥斯主题（白色淡黄）；仅当用户尚未明确选择时
  try {
    const current = theme.getTheme();
    if (current.preference === 'system' || current.preference === 'light') {
      theme.setTheme('aemeath');
    }
  } catch {
    /* 主题服务未就绪：忽略 */
  }
}
