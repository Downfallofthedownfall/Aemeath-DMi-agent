// ============================================================
// client/styles.ts — 课堂模式样式（**复用记忆工作区的设计语言**）
//
// 与记忆工作区（memory-tokens.ts）同源，但形态不同：
//   · 记忆工作区：全屏层（inset:0）
//   · 课堂模式：**右侧停靠面板**（不遮死对话，可折叠）
//
// 从 memory-tokens.ts 抄来的**关键工程细节**（这些是真机踩过坑的）：
//   ① 顶栏 padding-top: 40px —— Electron 壳 titleBarStyle:'hidden' 在顶部占 40px，
//      不避开的话关闭按钮会被原生窗口按钮盖住（截图里正踩到这个）
//   ② -webkit-app-region: drag / no-drag —— 顶栏可拖窗口，但按钮必须显式豁免
//   ③ z-index 低于 2147483647（宿主拖拽层），用 2147482000
//   ④ 全部颜色走 --dsw-alias-* + light-dark()，跟随宿主主题
// ============================================================

const STYLE_ID = 'aemeath-lecture-style';

export const LECTURE_CLASS = 'aem-lec';

const CSS = `
.${LECTURE_CLASS} {
  /* —— 质感层（与记忆工作区同一套数值，保证观感一致） —— */
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
  /* ⚠️ 不要硬编码背景色（也注意：本文件是 JS 模板字符串，注释里不能出现反引号）。
     曾经把暗色分支写成 #16181d、又在挂载点写死同色，
     结果**主题被钉死在深色**：宿主切亮色时课堂窗还是黑的。
     正确做法：暗色分支引用宿主变量（--dsw-alias-bg-base 会随主题变），
     并用 color-mix 加一点品牌粉调，保持 aemeath 的观感。 */
  --aem-bg: light-dark(
    linear-gradient(175deg, #fff8fb 0%, #fdeef5 55%, #fbe3ee 100%),
    linear-gradient(175deg,
      color-mix(in srgb, var(--dsw-alias-bg-base) 92%, var(--aem-accent) 8%) 0%,
      var(--dsw-alias-bg-base) 100%)
  );
  /* 独立窗口的不透明底色：跟随宿主主题，而不是写死深色 */
  --aem-standalone-bg: light-dark(#fdeef5, var(--dsw-alias-bg-base));

  /* —— 形态：右侧停靠面板（不是全屏层） —— */
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(420px, 92vw);
  z-index: 2147482000;
  display: flex;
  flex-direction: column;
  background: var(--aem-bg);
  color: var(--aem-ink);
  font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  border-left: 1px solid var(--aem-line);
  box-shadow: var(--aem-shadow-pop);
  animation: aem-lec-in 0.18s ease-out;
}
@keyframes aem-lec-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
.${LECTURE_CLASS} * { box-sizing: border-box; }

/* —— 收起态：只留一条窄边（不遮挡对话，随时点开） —— */
.${LECTURE_CLASS}[data-collapsed="1"] { width: 44px; }

/* —— 独立窗口模式（Electron 壳开的第二个 BrowserWindow）——
   此时它是**整个窗口**，不该有"停靠面板"的投影，
   宽度也不该被 420px 限制（用户可以自由拉宽）。

   ⚠️ 真机踩过：早先这里写成 position:static，以为"整窗"就是不要定位。
   结果 .aem-lec 成了普通文档流元素，而宿主 shell 的内容还在它**前面**，
   于是主界面（对话、输入框）从上方透出来；且 z-index 对 static 元素**无效**，
   压不住宿主。截图表现为"课堂界面和主界面叠在一起"。
   正确做法：**保持 fixed + inset:0 + 不透明背景**，真正盖住整个视口。

   注意：本文件是 JS 模板字符串，注释里**不能出现反引号**（会提前结束字符串）。 */
.${LECTURE_CLASS}[data-standalone="1"] {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 2147483000;
  border-left: none;
  box-shadow: none;
  animation: none;
  overflow: hidden;
}
/* 独立窗口用原生标题栏（未设 titleBarOverlay），顶部无需 40px 让位 */
.${LECTURE_CLASS}[data-standalone="1"] .lec-top { padding: 10px 14px 8px; }

/* —— 顶栏（⚠️ 40px 顶部让位见文件头 ①；顶栏是拖拽区） —— */
.${LECTURE_CLASS} .lec-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 40px 12px 8px;
  border-bottom: 1px solid var(--aem-line);
  background: light-dark(rgba(255, 255, 255, 0.72), var(--dsw-alias-bg-layer-2));
  backdrop-filter: blur(8px);
  -webkit-app-region: drag;
}
.${LECTURE_CLASS}[data-collapsed="1"] .lec-top { padding: 40px 0 8px; justify-content: center; }
.${LECTURE_CLASS} .lec-title {
  font-size: 14px; font-weight: 700; letter-spacing: 0.5px;
  background: linear-gradient(90deg, var(--aem-accent), var(--aem-accent-2));
  -webkit-background-clip: text; background-clip: text; color: transparent;
  white-space: nowrap;
}
.${LECTURE_CLASS} .lec-sub {
  font-size: 10.5px; color: var(--aem-ink-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.${LECTURE_CLASS} .lec-grow { flex: 1; min-width: 0; }
.${LECTURE_CLASS} .lec-icon-btn {
  width: 28px; height: 28px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: var(--aem-radius-ctl);
  background: transparent; color: var(--aem-ink-soft);
  cursor: pointer; font-size: 13px; font-family: inherit;
  transition: background 0.15s, color 0.15s;
  -webkit-app-region: no-drag;
}
.${LECTURE_CLASS} .lec-icon-btn:hover { background: var(--aem-accent-soft); color: var(--aem-accent); }

/* —— 页签（独立一行，不再与标题叠在一起） —— */
.${LECTURE_CLASS} .lec-tabs {
  flex: none;
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
}
.${LECTURE_CLASS} .lec-tab {
  flex: 1;
  padding: 7px 10px;
  border: none; border-radius: 10px;
  background: transparent; color: var(--aem-ink-soft);
  font-size: 12px; font-family: inherit; font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.${LECTURE_CLASS} .lec-tab:hover { background: light-dark(rgba(255,255,255,0.9), var(--dsw-alias-interactive-bg-hover)); color: var(--aem-accent); }
.${LECTURE_CLASS} .lec-tab[data-active="1"] {
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  color: #fff;
  box-shadow: 0 3px 10px light-dark(rgba(224, 90, 133, 0.28), rgba(0, 0, 0, 0.4));
}
.${LECTURE_CLASS} .lec-tab:disabled { opacity: 0.4; cursor: default; }

/* —— 主体：单列滚动（面板窄，不做三栏） —— */
.${LECTURE_CLASS} .lec-body {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  padding: 10px 12px 14px;
  overflow-y: auto;
}

/* —— 课程 / 单元选择：紧凑下拉 —— */
.${LECTURE_CLASS} .lec-select {
  width: 100%;
  font-family: inherit; font-size: 12.5px;
  color: var(--aem-ink);
  padding: 8px 11px;
  border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-ctl);
  background: var(--aem-surface);
  outline: none;
  margin-bottom: 10px;
}
.${LECTURE_CLASS} .lec-select:focus { border-color: var(--aem-accent-2); box-shadow: 0 0 0 3px var(--aem-accent-soft); }

/* —— 区块标题（粉点装饰，同记忆工作区 h2） —— */
.${LECTURE_CLASS} .lec-label {
  display: flex; align-items: center; gap: 6px;
  margin: 12px 0 6px;
  font-size: 11px; font-weight: 600; letter-spacing: 1.5px; color: var(--aem-ink-soft);
}
.${LECTURE_CLASS} .lec-label::before {
  content: ""; width: 5px; height: 5px; border-radius: 50%;
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  flex: none;
}
.${LECTURE_CLASS} .lec-label .lec-req { color: #d9534f; font-weight: 700; }
.${LECTURE_CLASS} .lec-hint { font-size: 11px; line-height: 1.6; color: var(--aem-ink-dim); margin: 0 0 8px; }

/* —— 输入 —— */
.${LECTURE_CLASS} textarea.lec-input,
.${LECTURE_CLASS} input.lec-input {
  width: 100%;
  font-family: inherit; font-size: 13px;
  color: var(--aem-ink);
  padding: 9px 11px;
  border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-ctl);
  background: var(--aem-surface);
  outline: none;
  resize: vertical;
  line-height: 1.6;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.${LECTURE_CLASS} textarea.lec-input:focus,
.${LECTURE_CLASS} input.lec-input:focus { border-color: var(--aem-accent-2); box-shadow: 0 0 0 3px var(--aem-accent-soft); }
.${LECTURE_CLASS} textarea.lec-shorthand {
  min-height: 120px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}
.${LECTURE_CLASS} .lec-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.${LECTURE_CLASS} textarea.lec-small { min-height: 62px; }

/* —— 符号输入辅助行（∑ 按钮 + 标记提示） —— */
.${LECTURE_CLASS} .lec-toolbar {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin: 8px 0 0;
}
.${LECTURE_CLASS} .lec-chip {
  font-size: 10.5px; padding: 2px 7px; border-radius: 6px;
  background: light-dark(#f4eef2, var(--dsw-alias-bg-layer-3));
  color: var(--aem-ink-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.${LECTURE_CLASS} .lec-symbtn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 11px; border-radius: var(--aem-radius-pill);
  border: 1px solid var(--aem-line);
  background: var(--aem-surface);
  color: var(--aem-accent);
  font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.${LECTURE_CLASS} .lec-symbtn:hover { border-color: var(--aem-accent-2); background: var(--aem-accent-soft); }
.${LECTURE_CLASS} .lec-symbtn[data-open="1"] {
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  color: #fff; border-color: transparent;
}

/* —— 符号面板（**折叠**：默认收起，点 ∑ 才展开） —— */
.${LECTURE_CLASS} .lec-sympanel {
  margin-top: 8px;
  border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-card);
  background: var(--aem-surface);
  box-shadow: var(--aem-shadow-card);
  overflow: hidden;
}
.${LECTURE_CLASS} .lec-sympanel-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--aem-line);
}
.${LECTURE_CLASS} .lec-sympanel-body { max-height: 260px; overflow-y: auto; padding: 8px 10px; }
.${LECTURE_CLASS} .lec-symgroup { margin-bottom: 10px; }
.${LECTURE_CLASS} .lec-symgroup-name {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.8px;
  color: var(--aem-ink-dim); margin: 0 0 5px 1px;
  cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 4px;
}
.${LECTURE_CLASS} .lec-symgroup-name:hover { color: var(--aem-accent); }
.${LECTURE_CLASS} .lec-symgrid { display: flex; flex-wrap: wrap; gap: 4px; }
.${LECTURE_CLASS} .lec-sym {
  min-width: 30px; height: 27px; padding: 0 7px;
  border-radius: 7px;
  border: 1px solid var(--aem-line);
  background: light-dark(#fff, var(--dsw-alias-bg-layer-2));
  color: var(--aem-ink);
  font-family: inherit; font-size: 12.5px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.12s, border-color 0.12s;
}
.${LECTURE_CLASS} .lec-sym:hover { background: var(--aem-accent-soft); border-color: var(--aem-accent-2); }
.${LECTURE_CLASS} .lec-sym[data-structured="1"] { border-color: var(--aem-accent-2); font-weight: 600; }

/* —— 按钮 —— */
.${LECTURE_CLASS} .lec-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 16px;
  border: none; border-radius: var(--aem-radius-ctl);
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  color: #fff; font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  box-shadow: 0 3px 10px light-dark(rgba(224, 90, 133, 0.24), rgba(0, 0, 0, 0.4));
}
.${LECTURE_CLASS} .lec-btn:disabled { opacity: 0.55; cursor: default; box-shadow: none; }
.${LECTURE_CLASS} .lec-btn-ghost {
  padding: 9px 14px; border-radius: var(--aem-radius-ctl);
  border: 1px solid var(--aem-line); background: transparent;
  color: var(--aem-ink-soft); font-family: inherit; font-size: 12.5px; cursor: pointer;
}
.${LECTURE_CLASS} .lec-btn-ghost:hover { border-color: var(--aem-accent-2); color: var(--aem-accent); }
.${LECTURE_CLASS} .lec-actions { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }

/* —— 卡片 / 提示 —— */
.${LECTURE_CLASS} .lec-card {
  background: var(--aem-surface);
  border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-card);
  box-shadow: var(--aem-shadow-card);
  padding: 9px 12px;
  margin-bottom: 7px;
}
.${LECTURE_CLASS} .lec-notice {
  padding: 9px 12px; border-radius: var(--aem-radius-ctl);
  background: light-dark(#fff8fb, var(--dsw-alias-bg-layer-2));
  border: 1px solid var(--aem-line);
  font-size: 11.5px; line-height: 1.6; color: var(--aem-ink-soft);
  margin: 8px 0;
}
.${LECTURE_CLASS} .lec-warn {
  padding: 8px 12px; border-radius: var(--aem-radius-ctl); font-size: 11.5px; line-height: 1.55;
  background: light-dark(#fdecec, rgba(217, 83, 79, 0.14)); color: #a01a1a;
  border: 1px solid light-dark(#f5c2c2, rgba(217, 83, 79, 0.3));
  margin-top: 8px;
}
.${LECTURE_CLASS} .lec-ok {
  padding: 8px 12px; border-radius: var(--aem-radius-ctl); font-size: 11.5px; line-height: 1.55;
  background: light-dark(#e6f6ec, rgba(28, 107, 63, 0.16)); color: #1c6b3f;
  border: 1px solid light-dark(#bfe6cd, rgba(28, 107, 63, 0.3));
  margin-top: 8px;
}
.${LECTURE_CLASS} .lec-empty { color: var(--aem-ink-dim); font-size: 12px; padding: 14px 2px; line-height: 1.7; }

/* —— 块列表 —— */
.${LECTURE_CLASS} .lec-pre {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  color: var(--aem-ink);
}
.${LECTURE_CLASS} .lec-blank { margin-top: 6px; font-size: 12px; line-height: 1.55; }
.${LECTURE_CLASS} .lec-blank b { color: var(--aem-ink-soft); font-weight: 700; }
.${LECTURE_CLASS} .lec-meta {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 10.5px; color: var(--aem-ink-dim); margin-top: 5px;
}

/* —— 复盘：步骤徽章 —— */
.${LECTURE_CLASS} .lec-step {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: var(--aem-radius-pill);
  font-size: 10.5px; font-weight: 700;
  background: light-dark(#f4eef2, var(--dsw-alias-bg-layer-3));
  color: var(--aem-ink-soft);
  margin-bottom: 8px;
}
.${LECTURE_CLASS} .lec-step[data-step="recall"] { background: #ffe9f2; color: #a01a5a; }
.${LECTURE_CLASS} .lec-step[data-step="compare"] { background: #e8f1fe; color: #1a4f8a; }
.${LECTURE_CLASS} .lec-step[data-step="repair"] { background: #fff3d6; color: #8a5a0b; }
.${LECTURE_CLASS} .lec-step[data-step="candidates"],
.${LECTURE_CLASS} .lec-step[data-step="commit"] { background: #e6f6ec; color: #1c6b3f; }

/* —— 复盘：三栏对照（面板窄，改纵向堆叠） —— */
.${LECTURE_CLASS} .lec-col3 { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.${LECTURE_CLASS} .lec-col {
  border-radius: var(--aem-radius-ctl); padding: 8px 11px; margin-bottom: 6px;
  font-size: 12px; line-height: 1.6;
  border: 1px solid var(--aem-line); background: var(--aem-surface);
}
.${LECTURE_CLASS} .lec-col h4 { margin: 0 0 5px; font-size: 11.5px; }
.${LECTURE_CLASS} .lec-col[data-kind="remembered"] h4 { color: #1c6b3f; }
.${LECTURE_CLASS} .lec-col[data-kind="missed"] h4 { color: #8a5a0b; }
.${LECTURE_CLASS} .lec-col[data-kind="wrong"] h4 { color: #a01a1a; }
.${LECTURE_CLASS} .lec-col ul { margin: 0; padding-left: 17px; }

/* —— 候选条目勾选 —— */
.${LECTURE_CLASS} .lec-check {
  display: flex; gap: 7px; align-items: flex-start;
  font-size: 12px; line-height: 1.55; margin-top: 5px;
}
.${LECTURE_CLASS} .lec-check input { margin-top: 3px; flex: none; }

/* —— 复盘容器 —— */
.${LECTURE_CLASS} .lec-review { display: flex; flex-direction: column; }
.${LECTURE_CLASS} .lec-unit-title { font-size: 12.5px; font-weight: 600; color: var(--aem-ink); }

/* —— 滚动条 —— */
.${LECTURE_CLASS} ::-webkit-scrollbar { width: 9px; height: 9px; }
.${LECTURE_CLASS} ::-webkit-scrollbar-track { background: transparent; }
.${LECTURE_CLASS} ::-webkit-scrollbar-thumb {
  background: var(--aem-line); border-radius: 999px;
  border: 2px solid transparent; background-clip: content-box;
}
.${LECTURE_CLASS} ::-webkit-scrollbar-thumb:hover { background: var(--aem-accent-2); background-clip: content-box; }

/* —— 收起态：竖排文字提示 —— */
.${LECTURE_CLASS} .lec-collapsed-hint {
  writing-mode: vertical-rl;
  font-size: 11.5px; letter-spacing: 2px;
  color: var(--aem-ink-soft);
  margin: 12px auto 0;
  cursor: pointer;
  user-select: none;
}
.${LECTURE_CLASS} .lec-collapsed-hint:hover { color: var(--aem-accent); }

@media (prefers-reduced-motion: reduce) {
  .${LECTURE_CLASS} { animation: none; }
}
`;

/** 注入（幂等：同 id 已存在则跳过）。 */
export function injectLectureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}
