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
  /* 工作台栏底色：**必须实色**（半透明会让底层主 agent 透出来，真机截图见过） */
  --aem-nav-bg: light-dark(#fdf4f8, #1f1f21);
  --aem-ink: var(--dsw-alias-label-primary);
  --aem-ink-soft: var(--dsw-alias-label-secondary);
  --aem-ink-dim: var(--dsw-alias-label-tertiary);
  /* ⚠️ 面板必须**不透明**。
     曾经写成 color-mix(... var(--dsw-alias-bg-base) ...)，看起来"跟随主题"，
     但宿主的 bg-base 在某些主题下带透明度 → color-mix 的结果也半透明 →
     底下的对话内容透出来（真机截图能看到"探索未至之境"穿透面板）。
     所以暗色分支用一个**明确的实色**，并在最外层再兜一层不透明底。
     （要跟随主题的只有"强调色"，底色必须是实色。） */
  --aem-bg: light-dark(
    linear-gradient(175deg, #fff8fb 0%, #fdeef5 55%, #fbe3ee 100%),
    #1b1b1c
  );
  /* 独立窗口的不透明底色（同样必须是实色，理由见上面的 --aem-bg） */
  --aem-standalone-bg: light-dark(#fdeef5, #1b1b1c);

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
  /* 独立界面模式：铺满整窗。
     输入框由工作台**自己的中栏**提供（见 workbench.tsx 的 Composer），
     不依赖 dsh 的 shell —— 所以这里可以放心铺满。 */
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
/* 刚复制过的符号：短暂高亮，给"点了有反应"的反馈 */
.${LECTURE_CLASS} .lec-sym[data-copied="1"] {
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  color: #fff; border-color: transparent;
}
/* 插入成功的额外提示：加一圈外发光（和"已复制"叠加，都能看出来） */
.${LECTURE_CLASS} .lec-sym[data-inserted="1"] {
  box-shadow: 0 0 0 2px var(--aem-accent-2);
}

/* —— 课程折叠（真机反馈："几十上百节课都列出来了"）—— */
.${LECTURE_CLASS} .lec-course-toggle {
  flex: none;
  width: 16px; height: 16px;
  padding: 0; margin-right: 2px;
  border: none; background: none;
  color: var(--aem-ink);
  opacity: 0.6;
  font-size: 10px; line-height: 1;
  cursor: pointer;
}
.${LECTURE_CLASS} .lec-course-toggle:hover { opacity: 1; }
.${LECTURE_CLASS} .lec-course-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: pointer;
}
/* 收起时显示"里面有几节"，免得完全看不出内容量 */
.${LECTURE_CLASS} .lec-course-count {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 10px;
  background: color-mix(in srgb, var(--aem-accent) 22%, transparent);
}

/* —— 可编辑留白（我的理解 / 我的疑问）—— */
.${LECTURE_CLASS} .lec-blank-edit {
  display: block;
  position: relative;
}
.${LECTURE_CLASS} .lec-blank-input {
  width: 100%;
  box-sizing: border-box;
  margin-top: 3px;
  padding: 5px 8px;
  resize: none;
  min-height: 26px; max-height: 160px;
  border-radius: 6px;
  border: 1px dashed var(--aem-line);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  outline: none;
}
.${LECTURE_CLASS} .lec-blank-input:focus {
  border-style: solid;
  border-color: var(--aem-accent);
  background: var(--dsw-alias-bg-base, #fff);
}
.${LECTURE_CLASS} .lec-blank-state {
  position: absolute;
  right: 4px; bottom: 3px;
  font-size: 10px;
  opacity: 0.7;
  pointer-events: none;
}
.${LECTURE_CLASS} .lec-blank-state[data-tone="saved"] { color: #3fa96a; opacity: 1; }
.${LECTURE_CLASS} .lec-blank-state[data-tone="err"] { color: #d9534f; opacity: 1; }

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

/* ============================================================
   学习工作台（三栏）—— [data-workbench="1"] 时启用
   ============================================================
   布局：左栏课程导航（可收起） / 中栏笔记主体 / 右栏符号+复盘。
   独立窗口模式下三栏铺满整窗；嵌在主 agent 里时也尽量给宽（见上面对 width 的覆盖）。
*/

/* 工作台是一个**独立工作区**，不是"右侧边栏"。
   ⚠️ 真机截图发现：早先嵌在主 agent 里时只覆盖了一部分，
   左边还露着会话列表/插件/工作区，右边露着输入框 ——
   用户的原话是"这和主 agent 前端一模一样不行啊，只保留 lecture 里面需要的东西"。
   一个三栏工作台挤在侧栏里既放不下、也仍然"长得像主 agent"。
   所以：**两种模式都铺满**，只是一个在独立窗口里、一个做全屏浮层。 */
.${LECTURE_CLASS}[data-workbench="1"] {
  /* 两种模式都铺满整窗：
       · 嵌入主 agent 时 —— 全屏浮层（盖住主界面）
       · standalone（mac）—— 固定定位铺满（就是课堂窗本身）
     输入框由工作台中栏自己提供，两种模式都不依赖 dsh 的 composer。 */
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  border-left: none;
  box-shadow: none;
  animation: aem-lec-in 0.16s ease-out;
  z-index: 2147482500;
}
.${LECTURE_CLASS}[data-workbench="1"][data-standalone="1"] { z-index: 2147483000; }

.${LECTURE_CLASS} .lec-wb {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 0;
}

/* —— 左栏：课程 / 单元 ——
   ⚠️ 背景必须**不透明**（半透明的 color-mix 会让底层主 agent 透出来 ——
   真机截图看到左栏左上角露出"插件/工作区"，就是这里漏了实色底）。 */
.${LECTURE_CLASS} .lec-wb-nav {
  flex: 0 0 232px;
  min-width: 0;
  overflow-y: auto;
  border-right: 1px solid var(--aem-line);
  padding: 6px 0 14px;
  background: var(--aem-nav-bg);
}
.${LECTURE_CLASS} .lec-wb-navhead {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.55;
  padding: 6px 12px 8px;
}
.${LECTURE_CLASS} .lec-course { margin-bottom: 10px; }
.${LECTURE_CLASS} .lec-course-name {
  font-size: 12.5px;
  font-weight: 700;
  padding: 4px 12px;
  color: var(--aem-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${LECTURE_CLASS} .lec-course-sem {
  font-weight: 400;
  opacity: 0.5;
  margin-left: 6px;
  font-size: 11px;
}
.${LECTURE_CLASS} .lec-unit {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: calc(100% - 12px);
  margin: 1px 6px;
  padding: 6px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--aem-ink);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.${LECTURE_CLASS} .lec-unit:hover { background: color-mix(in srgb, var(--aem-accent) 12%, transparent); }
.${LECTURE_CLASS} .lec-unit[data-active="1"] {
  background: color-mix(in srgb, var(--aem-accent) 20%, transparent);
  font-weight: 600;
}
.${LECTURE_CLASS} .lec-unit-title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${LECTURE_CLASS} .lec-unit-meta { flex: none; font-size: 10.5px; opacity: 0.5; }

/* —— 删除按钮 ——
   平时几乎不可见（避免误点），悬停该行才显形并变红。
   真机反馈：早先**完全没有删除入口**，测试笔记只能手改文件。 */
.${LECTURE_CLASS} .lec-unit-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.${LECTURE_CLASS} .lec-unit-row .lec-unit { flex: 1 1 auto; }
.${LECTURE_CLASS} .lec-del {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  margin-right: 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--aem-ink);
  opacity: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: opacity 0.12s ease-out;
}
.${LECTURE_CLASS} .lec-unit-row:hover .lec-del,
.${LECTURE_CLASS} .lec-course-name:hover .lec-del { opacity: 0.5; }
.${LECTURE_CLASS} .lec-del:hover { opacity: 1; background: #e05a85; color: #fff; }
.${LECTURE_CLASS} .lec-del:disabled { opacity: 0.25; cursor: default; }
/* 课程级的删除按钮浮在课程名右侧 */
.${LECTURE_CLASS} .lec-del-course { float: right; margin-right: 8px; margin-top: -2px; }

/* —— 中栏：笔记主体 —— */
.${LECTURE_CLASS} .lec-wb-main {
  flex: 1 1 auto;
  min-width: 0;
  /* ⚠️ 改成纵向 flex：笔记区自己滚，输入框**钉在底部**。
     早先是整栏 overflow-y:auto —— 那样输入框会跟着内容滚走，
     上课时又要滚回底部才能打字。 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}
/* 笔记区：吃掉剩余高度并自己滚动 */
.${LECTURE_CLASS} .lec-wb-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 16px 20px;
}

/* —— 速记输入框（中栏底部）——
   用户要的就是"中间那片空闲放一个输入框"，所以做得朴素：
   一条分隔线 + 一个自动长高的 textarea + 右下角一个"记下"。 */
.${LECTURE_CLASS} .lec-composer {
  flex: none;
  border-top: 1px solid var(--aem-line);
  padding: 8px 16px 10px;
  background: var(--aem-nav-bg);
}
.${LECTURE_CLASS} .lec-composer-input {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  min-height: 44px;
  max-height: 220px;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid var(--aem-line);
  background: var(--dsw-alias-bg-base, #fff);
  color: inherit;
  font: inherit;
  line-height: 1.5;
  outline: none;
}
.${LECTURE_CLASS} .lec-composer-input:focus {
  border-color: var(--aem-accent);
}
.${LECTURE_CLASS} .lec-composer-input:disabled { opacity: 0.6; }
.${LECTURE_CLASS} .lec-composer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.${LECTURE_CLASS} .lec-composer-hint {
  flex: 1 1 auto;
  font-size: 11px;
  opacity: 0.6;
  min-height: 14px;
}
.${LECTURE_CLASS} .lec-composer-hint[data-tone="err"] { color: #d9534f; opacity: 1; }
.${LECTURE_CLASS} .lec-composer-send {
  flex: none;
  padding: 5px 14px;
  border-radius: 7px;
  border: 1px solid var(--aem-accent);
  background: var(--aem-accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.${LECTURE_CLASS} .lec-composer-send:disabled {
  opacity: 0.45;
  cursor: default;
}
.${LECTURE_CLASS} .lec-notehead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--aem-line);
  margin-bottom: 12px;
}
.${LECTURE_CLASS} .lec-notehead-t { font-size: 15px; font-weight: 700; }
.${LECTURE_CLASS} .lec-notehead-d { font-size: 12px; opacity: 0.55; }
.${LECTURE_CLASS} .lec-notechunks { display: flex; flex-direction: column; gap: 12px; }
.${LECTURE_CLASS} .lec-note {
  border: 1px solid var(--aem-line);
  border-radius: 10px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--aem-ink) 2%, transparent);
}
.${LECTURE_CLASS} .lec-note-num { font-size: 10.5px; opacity: 0.45; margin-bottom: 4px; }
.${LECTURE_CLASS} .lec-note-blanks { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.${LECTURE_CLASS} .lec-blank {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.55;
}
.${LECTURE_CLASS} .lec-blank > b { flex: none; width: 60px; opacity: 0.75; font-weight: 700; }
.${LECTURE_CLASS} .lec-blank > span { flex: 1 1 auto; min-width: 0; }
/* 留白未填：明显但不刺眼（提示用户回对话里补） */
.${LECTURE_CLASS} .lec-blank[data-empty="1"] > span { opacity: 0.42; font-style: italic; }

/* 开课卡片（中栏） */
.${LECTURE_CLASS} .lec-startbox {
  max-width: 460px;
  margin: 24px auto 0;
  padding: 18px;
  border: 1px solid var(--aem-line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--aem-accent) 6%, transparent);
}
.${LECTURE_CLASS} .lec-wb-h { font-size: 15px; font-weight: 700; margin-bottom: 12px; }

/* 空状态（中栏大字版） */
.${LECTURE_CLASS} .lec-empty-big {
  max-width: 520px;
  margin: 60px auto 0;
  text-align: center;
  line-height: 1.9;
}
.${LECTURE_CLASS} .lec-empty-h { font-size: 22px; font-weight: 700; margin-bottom: 14px; opacity: 0.9; }
.${LECTURE_CLASS} .lec-empty-big p { margin: 8px 0; font-size: 13.5px; }

/* —— 右栏：符号键盘 / 复盘 —— */
.${LECTURE_CLASS} .lec-wb-side {
  flex: 0 0 300px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--aem-line);
  background: var(--aem-nav-bg);
}
.${LECTURE_CLASS} .lec-sidetabs {
  flex: none;
  display: flex;
  gap: 4px;
  padding: 8px 10px 0;
}
.${LECTURE_CLASS} .lec-sidetab {
  flex: 1 1 0;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--aem-ink);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  opacity: 0.65;
}
.${LECTURE_CLASS} .lec-sidetab:hover { opacity: 0.95; }
.${LECTURE_CLASS} .lec-sidetab[data-active="1"] {
  opacity: 1;
  font-weight: 700;
  background: color-mix(in srgb, var(--aem-accent) 18%, transparent);
  border-color: color-mix(in srgb, var(--aem-accent) 35%, transparent);
}
.${LECTURE_CLASS} .lec-sidetab:disabled { opacity: 0.3; cursor: default; }
.${LECTURE_CLASS} .lec-sidebody {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
}

/* 顶栏小按钮 */
.${LECTURE_CLASS} .lec-btn-tiny {
  flex: none;
  padding: 4px 10px;
  border: 1px solid var(--aem-line);
  border-radius: 999px;
  background: transparent;
  color: var(--aem-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.${LECTURE_CLASS} .lec-btn-tiny:hover {
  border-color: var(--aem-accent);
  color: var(--aem-accent);
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
