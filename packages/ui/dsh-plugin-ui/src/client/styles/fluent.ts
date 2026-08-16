// ============================================================
// styles/fluent.ts —— Win11 (Fluent) 设计系统基础层（UI 改造 P1）
// 职责：
//   1. 定义 --fluent-* 设计 token（颜色/圆角/阴影/动效/字体/材质）
//   2. 基础表面 restyle：字体、color-scheme、滚动条、焦点环、选区
// 注入方式：运行时 <style data-plugin-css="@aemeath/dsh-plugin-ui/fluent">（与官方一致）
// 说明：dsh 组件级颜色由 ThemeDefinition（--dsw-alias-*）驱动（theme.ts），
//       本层只做 dsh token 管不到的"外壳/控件/质感"部分。
// ============================================================

export const FLUENT_CSS_ID = '@aemeath/dsh-plugin-ui/fluent';

export const FluentCss = `
:root {
  /* C15：color-scheme 跟随系统/主题（原硬编码 light 与深色主题冲突，导致"半深半浅"） */
  color-scheme: light dark;
  /* —— 字体（注意：不用 "Segoe UI Variable"——其垂直度量偏大，导致文字在按钮/行内"向上飘逸"；
       用度量稳定的经典 "Segoe UI"）—— */
  --fluent-font: "Segoe UI", system-ui, -apple-system, "Microsoft YaHei UI", "PingFang SC", sans-serif;
  --fluent-font-code: "Cascadia Code", ui-monospace, "SF Mono", Consolas, "Courier New", monospace;
  /* —— 强调（玫粉 #FF8CBD）—— */
  --fluent-accent: #ff8cbd;
  --fluent-accent-hover: #f25e9e;
  --fluent-accent-active: #e64d92;
  --fluent-accent-subtle: #ffe9f3;
  --fluent-accent-disabled: #ffc9e3;
  /* —— 表面（淡蓝冷调，略深）—— */
  --fluent-bg-base: #e9edf3;
  --fluent-surface: #f7f9fc;
  --fluent-surface-subtle: #f1f4f9;
  --fluent-surface-hover: #e5eaf2;
  --fluent-surface-pressed: #d9e0ea;
  --fluent-surface-disabled: #eef1f5;
  /* —— 文字（冷调深蓝灰）—— */
  --fluent-text-primary: #303b4c;
  --fluent-text-secondary: #5d6b80;
  --fluent-text-tertiary: #8d98a9;
  --fluent-text-disabled: #b6c0cd;
  /* —— 边框（冷灰蓝）—— */
  --fluent-border-l1: #e0e5ec;
  --fluent-border-l2: #d4dae4;
  --fluent-border-l3: #c5cdd9;
  /* —— 圆角 —— */
  --fluent-radius-sm: 6px;
  --fluent-radius-md: 8px;
  --fluent-radius-lg: 12px;
  --fluent-radius-xl: 16px;
  /* —— 阴影（冷调低眩光）—— */
  --fluent-shadow-sm: 0 1px 2px rgba(24, 44, 86, 0.05), 0 2px 8px rgba(24, 44, 86, 0.04);
  --fluent-shadow-md: 0 2px 8px rgba(24, 44, 86, 0.05), 0 8px 24px rgba(24, 44, 86, 0.07);
  --fluent-shadow-lg: 0 4px 12px rgba(24, 44, 86, 0.07), 0 16px 40px rgba(24, 44, 86, 0.09);
  /* —— 材质（Mica/Acrylic，淡蓝）—— */
  --fluent-mica: rgba(242, 245, 249, 0.8);
  --fluent-acrylic: rgba(247, 249, 252, 0.86);
  --fluent-blur: blur(20px) saturate(140%);
  /* —— 动效 —— */
  --fluent-motion: 150ms cubic-bezier(0.2, 0, 0, 1);
  --fluent-motion-slow: 200ms cubic-bezier(0.2, 0, 0, 1);
}

/* C15：深色主题下覆盖 --fluent-* 表面/文字/材质（按活跃主题 colorScheme 切换，
   而非 OS 偏好媒体查询——host 侧已把 dark/system 偏好迁移为默认亮色，OS 深色 ≠
   应用深色，跟随 prefers-color-scheme 会重现"半深半浅"）。
   dsh 主题呈现器以 body[data-ds-dark-theme] 暴露深色态（dsh-client-ui-layout 的
   DARK_ATTRIBUTE）；CSS 变量在 body 上定义、后代继承，portal 弹层同样生效。 */
body[data-ds-dark-theme] {
  --fluent-bg-base: #1f1f1f;
  --fluent-surface: #282828;
  --fluent-surface-subtle: #2d2d2d;
  --fluent-surface-hover: #2f2f2f;
  --fluent-surface-pressed: #3a3a3a;
  --fluent-surface-disabled: #383838;
  --fluent-text-primary: #e8ecf4;
  --fluent-text-secondary: #aab4c8;
  --fluent-text-tertiary: #7a859c;
  --fluent-text-disabled: #555555;
  --fluent-border-l1: #3a3a3a;
  --fluent-border-l2: #464646;
  --fluent-border-l3: #555555;
  --fluent-accent: #5b8def;
  --fluent-accent-hover: #4a7cdd;
  --fluent-accent-active: #3d6ccb;
  --fluent-accent-subtle: #24304a;
  --fluent-accent-disabled: #2a3a5e;
  --fluent-mica: rgba(31, 31, 31, 0.8);
  --fluent-acrylic: rgba(40, 40, 40, 0.86);
  --fluent-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3), 0 2px 8px rgba(0, 0, 0, 0.25);
  --fluent-shadow-md: 0 2px 8px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35);
  --fluent-shadow-lg: 0 4px 12px rgba(0, 0, 0, 0.35), 0 16px 40px rgba(0, 0, 0, 0.4);
}

html, body {
  font-family: var(--fluent-font);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

body {
  /* C15：背景/文字优先用 dsh 主题 token（theme.ts 按 colorScheme 切换），
     fluent 值只作兜底——深色模式下不再"半深半浅" */
  background: var(--dsw-alias-bg-base, var(--fluent-bg-base));
  color: var(--dsw-alias-label-primary, var(--fluent-text-primary));
}

/* 代码字体（markdown 代码块等） */
code, pre, kbd, samp {
  font-family: var(--fluent-font-code);
}

/* 选区（Win11 强调色淡底） */
::selection {
  background: var(--fluent-accent-subtle);
  color: var(--fluent-text-primary);
}

/* 焦点环（Win11：2px 强调色 + 2px 偏移） */
:where(button, input, textarea, select, [role="button"], [role="switch"], [tabindex]):focus-visible {
  outline: 2px solid var(--fluent-accent);
  outline-offset: 2px;
}

/* 滚动条（WebKit/Chromium，细圆角） */
*::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
*::-webkit-scrollbar-track {
  background: transparent;
}
*::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, #d9d9d6);
  border: 2px solid transparent;
  border-radius: 8px;
  background-clip: content-box;
}
*::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-scrollbar-hover-l2, #b5b5b2);
  border: 2px solid transparent;
  border-radius: 8px;
  background-clip: content-box;
}

/* 过渡基调：仅对交互相关属性生效，避免全局动画抖动 */
@media (prefers-reduced-motion: no-preference) {
  button, [role="button"], [role="switch"], input, textarea, select {
    transition: background-color var(--fluent-motion), border-color var(--fluent-motion), color var(--fluent-motion), box-shadow var(--fluent-motion), opacity var(--fluent-motion);
  }
}
`;

/** 注入 fluent 基础层（幂等）。返回是否首次注入。 */
export function injectFluentStyles(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.querySelector(`style[data-plugin-css="${FLUENT_CSS_ID}"]`)) return false;
  const style = document.createElement('style');
  style.setAttribute('data-plugin', 'aemeath-ui');
  style.setAttribute('data-plugin-css', FLUENT_CSS_ID);
  style.textContent = FluentCss;
  document.head.appendChild(style);
  return true;
}
