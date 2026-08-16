// ============================================================
// styles/de-dsh.ts —— dsh 原版元素 隐藏/覆盖 选择器注册表（UI 改造 P1）
//
// 职责：集中管理所有针对 dsh 原版 DOM 的结构选择器（避开 hash class）。
//   升级 dsh 后若样式失效，先查本文件对应条目（按 §编号）。
//   品牌层隐藏（鲸鱼 logo/wordmark）见 brand.tsx；hero 文案隐藏见 hero.tsx。
// 原则：
//   1. 只用稳定钩子：data-* 属性、aria-label（zh/en 双语）、语义结构、:has()
//   2. 不做视觉破坏性覆盖，只做"产品化"调整（圆角/阴影/间距/表面）
//   3. 每一条带注释说明意图，失效时可快速定位
// ============================================================

export const DE_DSH_CSS_ID = '@aemeath/dsh-plugin-ui/de-dsh';

export const DeDshCss = `
/* ============ §1 应用框架表面（Win11 Mica 观感） ============ */
/* AppFrame 根：白底（token 已驱动）；body 兜底浅灰见 fluent.ts */

/* ============ §2 会话头部（Win11 命令栏观感） ============ */
/* dsh ConversationRoot header：含 nav[aria-label="会话层级"]（zh）/ "Session hierarchy"（en）
   注意：只加分隔线，**不要**改 padding/min-height——dsh 原始 padding
   "12px 28px 0 20px" 决定标题垂直位置，覆盖为 "0 20px" 会把标题顶上去
   （"标题向上飘逸"用户反馈修复） */
header:has(nav[aria-label="会话层级"]),
header:has(nav[aria-label="Session hierarchy"]) {
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

/* ============ §3 输入框（composer）卡 ============ */
/* dsh composer 卡根节点带 data-composer-card 属性 */
[data-composer-card] {
  border-radius: var(--fluent-radius-lg, 12px);
  border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: var(--fluent-shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.05));
  background: var(--fluent-surface, #ffffff);
}

/* 输入框工具行按钮统一圆角（aria 钩子：accessMode / commands / stop / 发送） */
[data-composer-card] button {
  border-radius: var(--fluent-radius-md, 8px);
}

/* ============ §4 上下文注入卡（世界书/讲义检索命中） ============ */
/* dsh context 注入区：data-context-injection-body / data-context-source */
[data-context-injection-body] {
  border-radius: var(--fluent-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1, #f9f9f8);
}

/* ============ §5 消息气泡与 markdown 容器 ============ */
/* 消息内容区排版微调：代码块圆角（token 已定色，这里补圆角） */
[class*="markdown"] pre,
pre {
  border-radius: var(--fluent-radius-md, 8px);
}

/* ============ §6 弹层 / 菜单（Acrylic 质感） ============ */
/* dsh 下拉/弹层：aria-haspopup 菜单、tooltip、popover 容器 */
[role="menu"],
[role="listbox"],
[role="dialog"],
[data-radix-popper-content-wrapper] {
  border-radius: var(--fluent-radius-lg, 12px);
  border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: var(--fluent-shadow-md, 0 2px 8px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06));
  background: var(--fluent-acrylic, rgba(255, 255, 255, 0.82));
  backdrop-filter: var(--fluent-blur, blur(20px) saturate(140%));
}

/* ============ §7 侧边栏（官方骨架保底 restyle，UI 改造 P2） ============ */
/* 说明：侧边栏保留官方 SidebarRoot 骨架（槽位声明级联风险，不做整列替换）；
   内容槽已被替换：workspaces → 会话列表+品牌头部，footer 品牌位移除。
   这里只 restyle 官方骨架本身的视觉。hash class 前缀 rc.6 锁版稳定。 */

/* 7.1 logoRow：隐藏品牌按钮（鲸鱼+wordmark，aria 与「新会话」同名 → 用父容器区分），
     仅保留右侧折叠切换按钮；行高收紧 */
[class*="_logoRow"] button[aria-label="新建会话"],
[class*="_logoRow"] button[aria-label="New session"] {
  display: none !important;
}
[class*="_logoRow"] {
  height: 40px !important;
  margin-bottom: 2px !important;
}

/* 7.2 新建会话按钮 → Win11 主按钮（强调淡底胶囊，hover 填满强调色）
     注意：选择器必须限定 button 元素——"[class*=_newSession]" 会误伤
     "_newSessionLabel"（文字标签 span），把 min-height 加到标签上导致
     文字"向上飘逸"（用户反馈修复） */
button[class*="_newSession"] {
  border-radius: var(--fluent-radius-md, 8px) !important;
  background: var(--dsw-alias-state-business-tertiary, #f7f0dd) !important;
  color: var(--dsw-alias-state-business-primary, #c8a031) !important;
  min-height: 34px !important;
  font-weight: 600 !important;
  box-shadow: none !important;
}
button[class*="_newSession"]:hover {
  background: var(--dsw-alias-state-business-primary, #c8a031) !important;
  color: #fff !important;
}

/* 7.3 底部区域：分隔线 + 设置入口圆角 */
[class*="_footArea"] {
  border-top: 1px solid var(--dsw-alias-border-l1) !important;
  margin-top: 6px !important;
  padding-top: 6px !important;
}
[class*="_settingsArea"] {
  border-radius: var(--fluent-radius-md, 8px) !important;
}
/* 注：§7.4（隐藏官方 hero WorkspaceChip）已移除——官方 chip + 官方选择器回归原位，
   作为 inert 态（"选择一个工作区开始"）的原生出口；用户要求工作区 dropdown
   只保留对话框的（我们的 hero chip 已移除，见 workspace-selector.tsx）。 */

/* ============ §8 hero 残留（配合 hero.tsx 替换） ============ */
/* hero 工作区触发器在 P3 恢复前保持隐藏（sessions.tsx 空组件 shadow）； */
/* 若官方 EmptyHero 出现未覆盖的"选择工作区"按钮，双语隐藏： */
button[aria-label="选择工作区"] { display: none !important; }
button[aria-label="Choose workspace"] { display: none !important; }

/* ============ §9 其他 dsh 开发工具痕迹 ============ */
/* 兜底：aria-hidden 的品牌 svg（与 brand.tsx 同规则，双保险） */
.ds-brand, [class*="brand"] svg[aria-hidden="true"] { display: none !important; }
`;

/** 注入 de-dsh 覆盖层（幂等）。返回是否首次注入。 */
export function injectDeDshStyles(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.querySelector(`style[data-plugin-css="${DE_DSH_CSS_ID}"]`)) return false;
  const style = document.createElement('style');
  style.setAttribute('data-plugin', 'aemeath-ui');
  style.setAttribute('data-plugin-css', DE_DSH_CSS_ID);
  style.textContent = DeDshCss;
  document.head.appendChild(style);
  return true;
}
