// ============================================================
// memory-tokens.ts — 记忆工作区的设计语言层（借 ripples-of-aion 面板的视觉语言）
//
// 借了什么：参考对象面板的"珍珠白底 + 柔粉强调 + 圆角软阴影"整套观感——具体数值取自其
//   panel/index.html 的 :root（--ink #5c4650 / --pink #e05a85 / --line #f6dce6、
//   背景 linear-gradient(175deg,#fff8fb,#fdeef5 55%,#fbe3ee)、卡片 #fff + 1px 边框 +
//   radius 14px + shadow 0 3px 14px rgba(224,90,133,.07)、h2 前 6px 粉点 + 2px 字距）。
//
// 不照抄的部分：参考对象是一套**固定亮色**主题（面板独立窗口，不跟随宿主）。Aemeath 的
// 工作区活在宿主 Web UI 里，必须跟随用户选的亮/暗主题——所以这里**不写死颜色**，而是：
//   ① 结构/质感（圆角、阴影、间距、字距、点饰）用固定值：这是"设计语言"的部分；
//   ② 颜色一律走宿主语义变量（--dsw-alias-*）：这是"主题感知"的部分；
//   ③ 只在需要"记忆工作区独有气质"的地方（标题渐变、卡片强调、时间轴色带）用
//      light-dark() 成对给出粉调值，随 colorScheme 自动切换。
// ============================================================

/** 工作区根节点的类名（所有样式挂在这个前缀下，避免污染宿主 UI）。 */
export const MEMORY_WORKSPACE_CLASS = 'aem-memws';

/**
 * 注入一次工作区样式（幂等：同 id 已存在则跳过）。返回清理函数。
 * 之所以用注入 <style> 而不是内联 style：面板里有大量 :hover / ::before / 滚动条等
 * 伪类与伪元素规则，React 内联样式表达不了。
 */
export function injectMemoryWorkspaceStyles(doc: Document = document): () => void {
  const ID = 'aemeath-memory-workspace-styles';
  if (doc.getElementById(ID)) return () => undefined;
  const el = doc.createElement('style');
  el.id = ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
  return () => el.remove();
}

const CSS = `
.${MEMORY_WORKSPACE_CLASS} {
  /* —— 质感层（固定值，来自参考对象） —— */
  --aem-radius-card: 14px;
  --aem-radius-ctl: 9px;
  --aem-radius-pill: 999px;
  --aem-shadow-card: 0 3px 14px light-dark(rgba(224, 90, 133, 0.07), rgba(0, 0, 0, 0.35));
  --aem-shadow-pop: 0 10px 34px light-dark(rgba(224, 90, 133, 0.16), rgba(0, 0, 0, 0.5));
  --aem-line: light-dark(#f6dce6, var(--dsw-alias-border-l2));
  --aem-accent: light-dark(#e05a85, #f08bab);
  --aem-accent-2: light-dark(#f08bab, #e05a85);
  --aem-accent-soft: light-dark(#fdeef4, rgba(240, 139, 171, 0.16));
  --aem-surface: light-dark(#ffffff, var(--dsw-alias-bg-layer-1));
  --aem-ink: var(--dsw-alias-label-primary);
  --aem-ink-soft: var(--dsw-alias-label-secondary);
  --aem-ink-dim: var(--dsw-alias-label-tertiary);
  --aem-bg: light-dark(linear-gradient(175deg, #fff8fb 0%, #fdeef5 55%, #fbe3ee 100%), var(--dsw-alias-bg-base));

  position: fixed;
  inset: 0;
  z-index: 2147482000;
  display: flex;
  flex-direction: column;
  background: var(--aem-bg);
  color: var(--aem-ink);
  font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  animation: aem-memws-in 0.16s ease-out;
}
@keyframes aem-memws-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.${MEMORY_WORKSPACE_CLASS} * { box-sizing: border-box; }

/* —— 顶栏：标题 + 居中页签 + 右侧动作 ——
   重要（Electron 壳兼容，真机截图暴露）：宿主窗口用 titleBarStyle:'hidden' +
   titleBarOverlay（高 40px，原生最小化/最大化/关闭按钮占右上 right:0..96px，且壳给 body
   注入了 z-index 2147483647 的拖拽层）。因此本层的顶栏必须**从这 40px 之下开始**——
   否则我的 ⟳/✕ 会被原生窗口按钮盖住、点了没反应（我在浏览器里验不出来，只有桌宠壳有这个）。
   顶栏自身做成拖拽区（-webkit-app-region: drag）好让用户拖窗口，按钮显式 no-drag 才可点。 */
.${MEMORY_WORKSPACE_CLASS} .mw-top {
  flex: none;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  height: auto;
  padding: 40px 16px 8px; /* 顶部 40px 让位给原生窗口按钮/拖拽条 */
  border-bottom: 1px solid var(--aem-line);
  background: light-dark(rgba(255, 255, 255, 0.72), var(--dsw-alias-bg-layer-2));
  backdrop-filter: blur(8px);
  -webkit-app-region: drag;
}
.${MEMORY_WORKSPACE_CLASS} .mw-title { display: flex; align-items: baseline; gap: 9px; min-width: 0; }
.${MEMORY_WORKSPACE_CLASS} .mw-title h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: linear-gradient(90deg, var(--aem-accent), var(--aem-accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  white-space: nowrap;
}
.${MEMORY_WORKSPACE_CLASS} .mw-title .mw-sub { font-size: 10.5px; color: var(--aem-ink-dim); white-space: nowrap; }
.${MEMORY_WORKSPACE_CLASS} .mw-tabs {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
}
.${MEMORY_WORKSPACE_CLASS} .mw-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 15px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--aem-ink-soft);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  -webkit-app-region: no-drag; /* 顶栏是拖拽区：交互控件必须显式豁免，否则点不动 */
}
.${MEMORY_WORKSPACE_CLASS} .mw-tab:hover { background: light-dark(rgba(255, 255, 255, 0.9), var(--dsw-alias-interactive-bg-hover)); color: var(--aem-accent); }
.${MEMORY_WORKSPACE_CLASS} .mw-tab[data-active="true"] {
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  color: #fff;
  font-weight: 600;
  box-shadow: 0 3px 10px light-dark(rgba(224, 90, 133, 0.28), rgba(0, 0, 0, 0.4));
}
.${MEMORY_WORKSPACE_CLASS} .mw-actions { display: flex; align-items: center; gap: 6px; -webkit-app-region: no-drag; }
.${MEMORY_WORKSPACE_CLASS} .mw-icon-btn {
  width: 30px; height: 30px;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: var(--aem-radius-ctl);
  background: transparent; color: var(--aem-ink-soft);
  cursor: pointer; font-size: 14px; font-family: inherit;
  transition: background 0.15s, color 0.15s;
  -webkit-app-region: no-drag;
}
.${MEMORY_WORKSPACE_CLASS} .mw-icon-btn:hover { background: var(--aem-accent-soft); color: var(--aem-accent); }

/* —— 页面与通用块 —— */
.${MEMORY_WORKSPACE_CLASS} .mw-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.${MEMORY_WORKSPACE_CLASS} .mw-page { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 6px 16px 12px; overflow: hidden; }
.${MEMORY_WORKSPACE_CLASS} .mw-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 0 0 6px; }
.${MEMORY_WORKSPACE_CLASS} .mw-page-title { font-size: 13px; font-weight: 600; color: var(--aem-ink); letter-spacing: 0.5px; }
.${MEMORY_WORKSPACE_CLASS} .mw-page-desc { margin: 2px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--aem-ink-dim); }
.${MEMORY_WORKSPACE_CLASS} h2 {
  display: flex; align-items: center; gap: 6px;
  margin: 14px 0 8px;
  font-size: 12px; font-weight: 600; letter-spacing: 2px; color: var(--aem-ink-soft);
}
.${MEMORY_WORKSPACE_CLASS} h2::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
}
.${MEMORY_WORKSPACE_CLASS} .mw-card {
  background: var(--aem-surface);
  border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-card);
  box-shadow: var(--aem-shadow-card);
  padding: 10px 14px;
}
.${MEMORY_WORKSPACE_CLASS} .mw-empty { color: var(--aem-ink-dim); font-size: 12px; padding: 10px 2px; }
.${MEMORY_WORKSPACE_CLASS} .mw-note { font-size: 11px; color: var(--aem-ink-dim); }
.${MEMORY_WORKSPACE_CLASS} .mw-pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: var(--aem-radius-pill);
  background: var(--aem-accent-soft); color: var(--aem-accent);
  font-size: 10.5px; font-weight: 600;
}
.${MEMORY_WORKSPACE_CLASS} .mw-pill[data-tone="muted"] { background: light-dark(#f2f2f4, var(--dsw-alias-bg-layer-3)); color: var(--aem-ink-soft); }

/* —— 三栏浏览（记忆页） —— */
.${MEMORY_WORKSPACE_CLASS} .mw-browser { flex: 1; min-height: 0; display: flex; gap: 14px; }
.${MEMORY_WORKSPACE_CLASS} .mw-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.${MEMORY_WORKSPACE_CLASS} .mw-col-filters { flex: none; width: 186px; overflow-y: auto; }
.${MEMORY_WORKSPACE_CLASS} .mw-col-main { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.${MEMORY_WORKSPACE_CLASS} .mw-col-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 600; letter-spacing: 1px; color: var(--aem-ink-soft);
  margin: 2px 0 6px;
}
.${MEMORY_WORKSPACE_CLASS} .mw-col-title::before {
  content: ""; width: 5px; height: 5px; border-radius: 50%;
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
}
.${MEMORY_WORKSPACE_CLASS} .mw-search { position: relative; }
.${MEMORY_WORKSPACE_CLASS} .mw-search input,
.${MEMORY_WORKSPACE_CLASS} .mw-field {
  width: 100%;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--aem-ink);
  padding: 8px 11px;
  border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-ctl);
  background: var(--aem-surface);
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.${MEMORY_WORKSPACE_CLASS} .mw-search input:focus,
.${MEMORY_WORKSPACE_CLASS} .mw-field:focus { border-color: var(--aem-accent-2); box-shadow: 0 0 0 3px var(--aem-accent-soft); }
.${MEMORY_WORKSPACE_CLASS} .mw-field { margin-bottom: 8px; }
.${MEMORY_WORKSPACE_CLASS} .mw-list { flex: 1; min-height: 0; overflow-y: auto; padding-right: 4px; }
.${MEMORY_WORKSPACE_CLASS} .mw-row {
  background: var(--aem-surface);
  border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-card);
  box-shadow: var(--aem-shadow-card);
  padding: 9px 13px;
  margin-bottom: 7px;
}
.${MEMORY_WORKSPACE_CLASS} .mw-row-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 5px; }
.${MEMORY_WORKSPACE_CLASS} .mw-row-text { font-size: 13px; line-height: 1.65; color: var(--aem-ink); word-break: break-word; }
.${MEMORY_WORKSPACE_CLASS} .mw-row-meta { margin-top: 6px; display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: var(--aem-ink-dim); flex-wrap: wrap; }
.${MEMORY_WORKSPACE_CLASS} .mw-link { background: none; border: none; padding: 0; color: var(--aem-accent); font-size: 10.5px; font-family: inherit; cursor: pointer; }
.${MEMORY_WORKSPACE_CLASS} .mw-link:hover { text-decoration: underline; }
.${MEMORY_WORKSPACE_CLASS} .mw-heat { width: 46px; height: 4px; border-radius: 999px; background: light-dark(#f6dce6, var(--dsw-alias-bg-layer-3)); overflow: hidden; }
.${MEMORY_WORKSPACE_CLASS} .mw-heat > i { display: block; height: 100%; background: linear-gradient(90deg, var(--aem-accent), var(--aem-accent-2)); }

/* —— 实体属性时间轴 —— */
.${MEMORY_WORKSPACE_CLASS} .mw-claims { flex: none; }
.${MEMORY_WORKSPACE_CLASS} .mw-claims-toggle {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  border: 1px dashed var(--aem-line); background: light-dark(rgba(255, 255, 255, 0.7), transparent);
  border-radius: var(--aem-radius-card); padding: 8px 12px;
  font-family: inherit; font-size: 12px; font-weight: 600; color: var(--aem-ink-soft); cursor: pointer;
}
.${MEMORY_WORKSPACE_CLASS} .mw-claims-toggle:hover { border-color: var(--aem-accent-2); color: var(--aem-accent); }
.${MEMORY_WORKSPACE_CLASS} .mw-claims-body { max-height: 34vh; overflow-y: auto; margin-top: 8px; }
.${MEMORY_WORKSPACE_CLASS} .mw-attr-block { margin-bottom: 10px; }
.${MEMORY_WORKSPACE_CLASS} .mw-attr-name { font-size: 11.5px; font-weight: 600; color: var(--aem-accent); letter-spacing: 1px; margin-bottom: 4px; }
.${MEMORY_WORKSPACE_CLASS} .mw-claim-line { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; border-bottom: 1px dashed var(--aem-line); }
.${MEMORY_WORKSPACE_CLASS} .mw-claim-line:last-child { border-bottom: none; }
.${MEMORY_WORKSPACE_CLASS} .mw-claim-value { font-size: 12.5px; color: var(--aem-ink); }
.${MEMORY_WORKSPACE_CLASS} .mw-claim-value[data-closed="true"] { color: var(--aem-ink-dim); text-decoration: line-through; }
.${MEMORY_WORKSPACE_CLASS} .mw-claim-range { margin-left: auto; font-size: 10.5px; color: var(--aem-ink-dim); white-space: nowrap; }

/* —— 图谱 —— */
.${MEMORY_WORKSPACE_CLASS} .mw-graph-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.${MEMORY_WORKSPACE_CLASS} .mw-graph {
  flex: 1; min-height: 0;
  position: relative;
  border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-card);
  background: var(--aem-surface);
  box-shadow: var(--aem-shadow-card);
  overflow: hidden;
}
.${MEMORY_WORKSPACE_CLASS} .mw-graph svg { display: block; width: 100%; height: 100%; }

/* —— 检索台 / 洞察 —— */
.${MEMORY_WORKSPACE_CLASS} .mw-console-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.${MEMORY_WORKSPACE_CLASS} .mw-console-bar input { flex: 1; }
.${MEMORY_WORKSPACE_CLASS} .mw-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 15px; border: none; border-radius: var(--aem-radius-ctl);
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  color: #fff; font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  box-shadow: 0 3px 10px light-dark(rgba(224, 90, 133, 0.24), rgba(0, 0, 0, 0.4));
}
.${MEMORY_WORKSPACE_CLASS} .mw-btn:disabled { opacity: 0.55; cursor: default; box-shadow: none; }
.${MEMORY_WORKSPACE_CLASS} .mw-score { font-size: 10.5px; color: var(--aem-ink-dim); font-variant-numeric: tabular-nums; }
.${MEMORY_WORKSPACE_CLASS} .mw-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 4px; }
.${MEMORY_WORKSPACE_CLASS} .mw-kv { display: flex; align-items: baseline; gap: 8px; padding: 6px 0; font-size: 12.5px; border-bottom: 1px dashed var(--aem-line); }
.${MEMORY_WORKSPACE_CLASS} .mw-kv:last-child { border-bottom: none; }
.${MEMORY_WORKSPACE_CLASS} .mw-kv > span:first-child { color: var(--aem-ink-soft); min-width: 84px; }
.${MEMORY_WORKSPACE_CLASS} .mw-kv > span:last-child { color: var(--aem-ink); font-variant-numeric: tabular-nums; }

/* —— 滚动条：粉底上默认细条几乎不可见，给一条能看见的 —— */
.${MEMORY_WORKSPACE_CLASS} ::-webkit-scrollbar { width: 9px; height: 9px; }
.${MEMORY_WORKSPACE_CLASS} ::-webkit-scrollbar-track { background: transparent; }
.${MEMORY_WORKSPACE_CLASS} ::-webkit-scrollbar-thumb {
  background: var(--aem-line);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: content-box;
}
.${MEMORY_WORKSPACE_CLASS} ::-webkit-scrollbar-thumb:hover { background: var(--aem-accent-2); background-clip: content-box; }

@media (prefers-reduced-motion: reduce) {
  .${MEMORY_WORKSPACE_CLASS} { animation: none; }
}
`;
