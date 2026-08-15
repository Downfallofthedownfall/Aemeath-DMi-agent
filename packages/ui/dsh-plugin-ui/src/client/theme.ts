// ============================================================
// 爱弥斯主题（M5 F1 → UI 改造 P1 重构）
// 设计语言：Windows 11 Fluent（亮色优先）
//
// 三层结构（解决"注册主题 preference 不持久化导致 token 丢失"的根因）：
//   1. register(aemeathLight / physicistDark) —— 供设置页 Appearance 选择
//      （决定 colorScheme 与"活跃主题 id"，其自身 tokens 仅作兜底）
//   2. overrideTokens('@aemeath/dsh-plugin-ui', PALETTE) —— 真正的调色板覆盖层，
//      不依赖 preference：无论活跃主题是内置 light/dark 还是注册主题，本层按
//      当前 colorScheme 取 {light|dark} 值并压顶 —— 视觉一致且不会被 host 同步回滚
//   3. 默认亮色映射（决策 Q1：默认亮色，深色仅可选）：
//      system/light 内置偏好 → setTheme('aemeath')（尽力而为，仅影响活跃主题 id）
//      dark 内置偏好 → setTheme('physicist')
// ============================================================
import type { ThemeDefinition } from '@deepseek-ai/dsh-client-ui-theme/client';

/** Win11 亮色 token 值（淡蓝冷调 · 略深 · 玫粉强调 #FF8CBD；与 DARK 成对组成覆盖层）。 */
const LIGHT: Record<string, string> = {
  // —— 文字（冷调深蓝灰，柔和不刺眼）——
  '--dsw-alias-label-primary': '#303b4c',
  '--dsw-alias-label-secondary': '#5d6b80',
  '--dsw-alias-label-tertiary': '#8d98a9',
  '--dsw-alias-label-caption': '#5d6b80',
  '--dsw-alias-label-dimmed': '#8d98a9',
  '--dsw-alias-label-primary-dimmed': '#4a5669',
  '--dsw-alias-label-primary-foreground': '#303b4c',
  // —— 背景（淡蓝冷调，比暖纸色略深）——
  '--dsw-alias-bg-base': '#eef1f6',
  '--dsw-alias-bg-layer-1': '#e7ebf1',
  '--dsw-alias-bg-layer-2': '#dfe4ec',
  '--dsw-alias-bg-layer-3': '#d6dce6',
  '--dsw-alias-bg-overlay': '#f7f9fc',
  '--dsw-alias-bg-mask-1': 'rgba(24, 44, 86, 0.05)',
  '--dsw-alias-bg-mask-2': 'rgba(24, 44, 86, 0.10)',
  '--dsw-alias-bg-mask-3': 'rgba(24, 44, 86, 0.15)',
  '--dsw-alias-bg-skeleton': '#d6dce6',
  '--dsw-alias-bg-module-platform': '#dfe4ec',
  '--dsw-alias-bg-multi-select': '#ffe9f3',
  // —— 边框（冷灰蓝）——
  '--dsw-alias-border-l1': '#e0e5ec',
  '--dsw-alias-border-l2': '#d4dae4',
  '--dsw-alias-border-l3': '#c5cdd9',
  '--dsw-alias-border-l4': '#b6bfce',
  '--dsw-alias-border-inverted': '#f7f9fc',
  // —— 强调：玫粉 #FF8CBD ——
  '--dsw-alias-state-business-primary': '#ff8cbd',
  '--dsw-alias-state-business-primary-hover': '#f25e9e',
  '--dsw-alias-state-business-tertiary': '#ffe9f3',
  '--dsw-alias-accent': '#ff8cbd',
  '--dsw-alias-brand-primary': '#ff8cbd',
  '--dsw-alias-brand-primary-invert': '#ffffff',
  '--dsw-alias-brand-text': '#c2367b',
  // —— 按钮 ——
  '--dsw-alias-button-primary-fill': '#ff8cbd',
  '--dsw-alias-button-primary-hover': '#f25e9e',
  '--dsw-alias-button-primary-dimmed': '#ffd0e6',
  '--dsw-alias-button-contrast-fill': '#303b4c',
  '--dsw-alias-button-elevated-fill': '#f7f9fc',
  '--dsw-alias-button-floating-fill': '#f7f9fc',
  '--dsw-alias-button-floating-hover': '#e5eaf2',
  '--dsw-alias-button-ghost-active-fill': '#d9e0ea',
  '--dsw-alias-button-ghost-active-hover': '#dfe5ee',
  '--dsw-alias-button-ghost-active-border': '#c5cdd9',
  '--dsw-alias-button-info-fill': '#e7ebf1',
  '--dsw-alias-button-info-hover': '#dfe4ec',
  '--dsw-alias-button-tool-bar-fill': 'transparent',
  '--dsw-alias-button-tool-bar-fill-invisible': 'transparent',
  '--dsw-alias-button-tool-bar-hover': '#e5eaf2',
  // —— 交互 ——
  '--dsw-alias-interactive-bg-hover': '#e5eaf2',
  '--dsw-alias-interactive-bg-active': '#d9e0ea',
  '--dsw-alias-interactive-bg-hover-accent': '#ffe9f3',
  '--dsw-alias-interactive-bg-hover-danger': '#fbe9e5',
  '--dsw-alias-interactive-bg-hover-solid': '#f25e9e',
  // —— 状态语义色 ——
  '--dsw-alias-state-error-primary': '#c2413a',
  '--dsw-alias-state-error-secondary': '#fbe9e5',
  '--dsw-alias-state-success-primary': '#2f7d32',
  '--dsw-alias-state-success-secondary': '#e4f2e2',
  '--dsw-alias-state-success-tertiary': '#d0e9cc',
  '--dsw-alias-state-warn-label': '#6b4a00',
  '--dsw-alias-state-warn-primary': '#8f5f00',
  '--dsw-alias-state-warn-secondary': '#fbf1dc',
  '--dsw-alias-state-warn-tertiary': '#f5e5bd',
  // —— 滚动条 ——
  '--dsw-alias-scrollbar-bg-l1': 'transparent',
  '--dsw-alias-scrollbar-bg-l2': '#c4ccd8',
  '--dsw-alias-scrollbar-hover-l1': 'transparent',
  '--dsw-alias-scrollbar-hover-l2': '#a9b4c4',
  // —— Markdown / 提示 ——
  '--dsw-alias-markdown-inline-code': '#e8edf4',
  '--dsw-alias-markdown-code-block': '#f2f5f9',
  '--dsw-alias-markdown-code-block-banner': '#dfe5ee',
  '--dsw-alias-markdown-tag': '#ffe9f3',
  '--dsw-alias-markdown-placeholder': '#c5cdd9',
  '--dsw-alias-tooltip-bg': '#f7f9fc',
  '--dsw-alias-toast-bg': '#f7f9fc',
  // —— specific（结构表面，淡蓝）——
  '--dsw-specific-sidebar-fill': 'rgba(242, 245, 249, 0.8)',
  '--dsw-specific-sidebar-nav-item-active': '#e3e8f0',
  '--dsw-specific-sidebar-nav-item-active-accent': '#ffe9f3',
  '--dsw-specific-sidebar-nav-item-hover': '#d9dfe9',
  '--dsw-specific-bubble': '#e4e9f0',
  '--dsw-specific-bubble-highlight': '#ffe9f3',
  '--dsw-specific-menu': '#f7f9fc',
  '--dsw-specific-input-major': '#f7f9fc',
  '--dsw-specific-selector': '#ffe9f3',
  '--dsw-specific-tip': '#fff2f8',
};

/** Fluent 深色 token 值（与 LIGHT 成对；随 physicist 深色主题使用）。 */
const DARK: Record<string, string> = {
  '--dsw-alias-label-primary': '#e8ecf4',
  '--dsw-alias-label-secondary': '#aab4c8',
  '--dsw-alias-label-tertiary': '#7a859c',
  '--dsw-alias-label-caption': '#aab4c8',
  '--dsw-alias-label-dimmed': '#7a859c',
  '--dsw-alias-bg-base': '#1f1f1f',
  '--dsw-alias-bg-layer-1': '#282828',
  '--dsw-alias-bg-layer-2': '#2d2d2d',
  '--dsw-alias-bg-layer-3': '#383838',
  '--dsw-alias-bg-overlay': '#232323',
  '--dsw-alias-bg-mask-1': 'rgba(255, 255, 255, 0.04)',
  '--dsw-alias-bg-mask-2': 'rgba(255, 255, 255, 0.08)',
  '--dsw-alias-bg-mask-3': 'rgba(255, 255, 255, 0.12)',
  '--dsw-alias-bg-skeleton': '#383838',
  '--dsw-alias-bg-module-platform': '#2d2d2d',
  '--dsw-alias-bg-multi-select': '#24304a',
  '--dsw-alias-border-l1': '#3a3a3a',
  '--dsw-alias-border-l2': '#464646',
  '--dsw-alias-border-l3': '#555555',
  '--dsw-alias-border-l4': '#666666',
  '--dsw-alias-border-inverted': '#1f1f1f',
  '--dsw-alias-state-business-primary': '#5b8def',
  '--dsw-alias-state-business-primary-hover': '#4a7cdd',
  '--dsw-alias-state-business-tertiary': '#24304a',
  '--dsw-alias-accent': '#5b8def',
  '--dsw-alias-brand-primary': '#5b8def',
  '--dsw-alias-brand-primary-invert': '#0d1117',
  '--dsw-alias-brand-text': '#8fb0f5',
  '--dsw-alias-button-primary-fill': '#5b8def',
  '--dsw-alias-button-primary-hover': '#4a7cdd',
  '--dsw-alias-button-primary-dimmed': '#2a3a5e',
  '--dsw-alias-button-contrast-fill': '#ffffff',
  '--dsw-alias-button-elevated-fill': '#2d2d2d',
  '--dsw-alias-button-floating-fill': '#2d2d2d',
  '--dsw-alias-button-floating-hover': '#383838',
  '--dsw-alias-button-ghost-active-fill': '#3a3a3a',
  '--dsw-alias-button-ghost-active-hover': '#404040',
  '--dsw-alias-button-ghost-active-border': '#555555',
  '--dsw-alias-button-info-fill': '#2d2d2d',
  '--dsw-alias-button-info-hover': '#383838',
  '--dsw-alias-button-tool-bar-fill': 'transparent',
  '--dsw-alias-button-tool-bar-fill-invisible': 'transparent',
  '--dsw-alias-button-tool-bar-hover': '#2f2f2f',
  '--dsw-alias-interactive-bg-hover': '#2f2f2f',
  '--dsw-alias-interactive-bg-active': '#3a3a3a',
  '--dsw-alias-interactive-bg-hover-accent': '#24304a',
  '--dsw-alias-interactive-bg-hover-danger': '#3d1d1a',
  '--dsw-alias-interactive-bg-hover-solid': '#4a7cdd',
  '--dsw-alias-state-error-primary': '#f1707a',
  '--dsw-alias-state-error-secondary': '#3d1d1a',
  '--dsw-alias-state-success-primary': '#6ccb6c',
  '--dsw-alias-state-success-secondary': '#14331a',
  '--dsw-alias-state-success-tertiary': '#1e4426',
  '--dsw-alias-state-warn-label': '#ffd58a',
  '--dsw-alias-state-warn-primary': '#e8a94e',
  '--dsw-alias-state-warn-secondary': '#3a2c14',
  '--dsw-alias-state-warn-tertiary': '#4a3a18',
  '--dsw-alias-scrollbar-bg-l1': 'transparent',
  '--dsw-alias-scrollbar-bg-l2': '#4a4a4a',
  '--dsw-alias-scrollbar-hover-l1': 'transparent',
  '--dsw-alias-scrollbar-hover-l2': '#5c5c5c',
  '--dsw-alias-markdown-inline-code': '#2d2d2d',
  '--dsw-alias-markdown-code-block': '#282828',
  '--dsw-alias-markdown-code-block-banner': '#383838',
  '--dsw-alias-markdown-tag': '#24304a',
  '--dsw-alias-markdown-placeholder': '#555555',
  '--dsw-alias-tooltip-bg': '#2d2d2d',
  '--dsw-alias-toast-bg': '#2d2d2d',
  '--dsw-specific-sidebar-fill': 'rgba(31, 31, 31, 0.8)',
  '--dsw-specific-sidebar-nav-item-active': '#2f2f2f',
  '--dsw-specific-sidebar-nav-item-active-accent': '#24304a',
  '--dsw-specific-sidebar-nav-item-hover': '#2a2a2a',
  '--dsw-specific-bubble': '#2b2b2b',
  '--dsw-specific-bubble-highlight': '#24304a',
  '--dsw-specific-menu': '#282828',
  '--dsw-specific-input-major': '#282828',
  '--dsw-specific-selector': '#24304a',
  '--dsw-specific-tip': '#2a2c1e',
};

/** 调色板覆盖层：{light, dark} 成对，随当前 colorScheme 取值（核心机制）。 */
export const PALETTE_OVERRIDES: Record<string, { light: string; dark: string }> = Object.fromEntries(
  [...new Set([...Object.keys(LIGHT), ...Object.keys(DARK)])].map((k) => [
    k,
    { light: LIGHT[k] ?? DARK[k]!, dark: DARK[k] ?? LIGHT[k]! },
  ]),
) as Record<string, { light: string; dark: string }>;

/** 注册主题（供 Appearance 行选择，决定 colorScheme）。tokens 仅兜底，视觉由覆盖层保证。 */
export const aemeathLight: ThemeDefinition = { id: 'aemeath', colorScheme: 'light', tokens: LIGHT };
export const physicistDark: ThemeDefinition = { id: 'physicist', colorScheme: 'dark', tokens: DARK };

/** 注册主题 + 覆盖层 + 默认亮色映射。 */
export function registerThemes(ctx: {
  theme?: {
    register(d: ThemeDefinition): () => void;
    setTheme(id: string): void;
    getTheme(): { preference: string; active: { id: string } };
    overrideTokens(source: string, tokens: Record<string, { light: string; dark: string }>): () => void;
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
  // 覆盖层：不依赖 preference 的调色板（修复"注册主题 preference 不持久化 → token 丢失"）
  try {
    theme.overrideTokens('@aemeath/dsh-plugin-ui', PALETTE_OVERRIDES);
  } catch (e) {
    console.warn('[aemeath-ui] 主题覆盖层应用失败:', (e as Error).message);
  }
  // 默认亮色（尽力而为：影响活跃主题 id 与 colorScheme；覆盖层保证视觉）
  try {
    const current = theme.getTheme();
    const pref = current.preference;
    if (pref === 'system' || pref === 'light') theme.setTheme('aemeath');
    else if (pref === 'dark') theme.setTheme('physicist');
  } catch {
    /* 主题服务未就绪：忽略 */
  }
}
