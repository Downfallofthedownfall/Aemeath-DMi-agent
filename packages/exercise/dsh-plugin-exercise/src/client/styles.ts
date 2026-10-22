// ============================================================
// client/styles.ts — 习题工作台样式
//
// **整份抄自 lecture**（用户定案："前端有点丑，照抄 lecture 的前端就行"）：
//   · 同一套 --aem-* 设计 token（卡片圆角/阴影/玫粉强调色/light-dark 双主题）
//   · 同一套栏位骨架：.lec-top / .lec-wb / .lec-wb-nav / .lec-wb-main / .lec-wb-side
//   · 同一套控件：.lec-btn / .lec-input / .lec-select / .lec-empty / .lec-hint
// 只有根类名从 .aem-lec 改成 .aem-ex（两个插件同时挂载时互不干扰），
// 并在 CSS 末尾追加习题专有的几块（题卡 / 判定 / 错题卡 / 导入弹层）——
// 那些也用同一批 --aem-* token，所以观感与 lecture 一致。
//
// 从 lecture 继承来的关键工程细节（真机踩过，别删）：
//   ① 顶栏 padding-top: 40px —— Electron 壳 titleBarStyle:'hidden' 顶部占 40px
//   ② -webkit-app-region: drag / no-drag —— 顶栏可拖窗口，按钮必须显式豁免
//   ③ z-index 低于宿主拖拽层，用 2147482000/2147483000
//   ④ 颜色全部走 light-dark() + --dsw-alias-*，跟随宿主亮/暗主题
// ============================================================

const STYLE_ID = 'aemeath-exercise-style';

export const EX_CLASS = 'aem-ex';

const CSS = `
.${EX_CLASS} {
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
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 2147482000;
  display: flex;
  flex-direction: column;
  background: var(--aem-bg);
  color: var(--aem-ink);
  font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  border-left: 1px solid var(--aem-line);
  box-shadow: var(--aem-shadow-pop);
  animation: aem-ex-in 0.18s ease-out;
}
@keyframes aem-ex-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
.${EX_CLASS} * { box-sizing: border-box; }

/* —— 收起态：只留一条窄边（不遮挡对话，随时点开） —— */
.${EX_CLASS}[data-collapsed="1"] { width: 44px; }

/* —— 独立窗口模式（Electron 壳开的第二个 BrowserWindow）——
   此时它是**整个窗口**，不该有"停靠面板"的投影，
   宽度也不该被 420px 限制（用户可以自由拉宽）。

   ⚠️ 真机踩过：早先这里写成 position:static，以为"整窗"就是不要定位。
   结果 .aem-lec 成了普通文档流元素，而宿主 shell 的内容还在它**前面**，
   于是主界面（对话、输入框）从上方透出来；且 z-index 对 static 元素**无效**，
   压不住宿主。截图表现为"课堂界面和主界面叠在一起"。
   正确做法：**保持 fixed + inset:0 + 不透明背景**，真正盖住整个视口。

   注意：本文件是 JS 模板字符串，注释里**不能出现反引号**（会提前结束字符串）。 */
.${EX_CLASS}[data-standalone="1"] {
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
.${EX_CLASS}[data-standalone="1"] .lec-top { padding: 10px 14px 8px; }

/* —— 顶栏（⚠️ 40px 顶部让位见文件头 ①；顶栏是拖拽区） —— */
.${EX_CLASS} .lec-top {
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
.${EX_CLASS}[data-collapsed="1"] .lec-top { padding: 40px 0 8px; justify-content: center; }
.${EX_CLASS} .lec-title {
  font-size: 14px; font-weight: 700; letter-spacing: 0.5px;
  background: linear-gradient(90deg, var(--aem-accent), var(--aem-accent-2));
  -webkit-background-clip: text; background-clip: text; color: transparent;
  white-space: nowrap;
}
.${EX_CLASS} .lec-sub {
  font-size: 10.5px; color: var(--aem-ink-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.${EX_CLASS} .lec-grow { flex: 1; min-width: 0; }
.${EX_CLASS} .lec-icon-btn {
  width: 28px; height: 28px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: var(--aem-radius-ctl);
  background: transparent; color: var(--aem-ink-soft);
  cursor: pointer; font-size: 13px; font-family: inherit;
  transition: background 0.15s, color 0.15s;
  -webkit-app-region: no-drag;
}
.${EX_CLASS} .lec-icon-btn:hover { background: var(--aem-accent-soft); color: var(--aem-accent); }

/* —— 页签（独立一行，不再与标题叠在一起） —— */
.${EX_CLASS} .lec-tabs {
  flex: none;
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
}
.${EX_CLASS} .lec-tab {
  flex: 1;
  padding: 7px 10px;
  border: none; border-radius: 10px;
  background: transparent; color: var(--aem-ink-soft);
  font-size: 12px; font-family: inherit; font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.${EX_CLASS} .lec-tab:hover { background: light-dark(rgba(255,255,255,0.9), var(--dsw-alias-interactive-bg-hover)); color: var(--aem-accent); }
.${EX_CLASS} .lec-tab[data-active="1"] {
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  color: #fff;
  box-shadow: 0 3px 10px light-dark(rgba(224, 90, 133, 0.28), rgba(0, 0, 0, 0.4));
}
.${EX_CLASS} .lec-tab:disabled { opacity: 0.4; cursor: default; }

/* —— 主体：单列滚动（面板窄，不做三栏） —— */
.${EX_CLASS} .lec-body {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  padding: 10px 12px 14px;
  overflow-y: auto;
}

/* —— 课程 / 单元选择：紧凑下拉 —— */
.${EX_CLASS} .lec-select {
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
.${EX_CLASS} .lec-select:focus { border-color: var(--aem-accent-2); box-shadow: 0 0 0 3px var(--aem-accent-soft); }

/* —— 区块标题（粉点装饰，同记忆工作区 h2） —— */
.${EX_CLASS} .lec-label {
  display: flex; align-items: center; gap: 6px;
  margin: 12px 0 6px;
  font-size: 11px; font-weight: 600; letter-spacing: 1.5px; color: var(--aem-ink-soft);
}
.${EX_CLASS} .lec-label::before {
  content: ""; width: 5px; height: 5px; border-radius: 50%;
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  flex: none;
}
.${EX_CLASS} .lec-label .lec-req { color: #d9534f; font-weight: 700; }
.${EX_CLASS} .lec-hint { font-size: 11px; line-height: 1.6; color: var(--aem-ink-dim); margin: 0 0 8px; }

/* —— 输入 —— */
.${EX_CLASS} textarea.lec-input,
.${EX_CLASS} input.lec-input {
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
.${EX_CLASS} textarea.lec-input:focus,
.${EX_CLASS} input.lec-input:focus { border-color: var(--aem-accent-2); box-shadow: 0 0 0 3px var(--aem-accent-soft); }
.${EX_CLASS} textarea.lec-shorthand {
  min-height: 120px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}
.${EX_CLASS} .lec-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.${EX_CLASS} textarea.lec-small { min-height: 62px; }

/* —— 符号输入辅助行（∑ 按钮 + 标记提示） —— */
.${EX_CLASS} .lec-toolbar {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin: 8px 0 0;
}
.${EX_CLASS} .lec-chip {
  font-size: 10.5px; padding: 2px 7px; border-radius: 6px;
  background: light-dark(#f4eef2, var(--dsw-alias-bg-layer-3));
  color: var(--aem-ink-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.${EX_CLASS} .lec-symbtn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 11px; border-radius: var(--aem-radius-pill);
  border: 1px solid var(--aem-line);
  background: var(--aem-surface);
  color: var(--aem-accent);
  font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.${EX_CLASS} .lec-symbtn:hover { border-color: var(--aem-accent-2); background: var(--aem-accent-soft); }
.${EX_CLASS} .lec-symbtn[data-open="1"] {
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  color: #fff; border-color: transparent;
}

/* —— 符号面板（**折叠**：默认收起，点 ∑ 才展开） —— */
.${EX_CLASS} .lec-sympanel {
  margin-top: 8px;
  border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-card);
  background: var(--aem-surface);
  box-shadow: var(--aem-shadow-card);
  overflow: hidden;
}
.${EX_CLASS} .lec-sympanel-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--aem-line);
}
.${EX_CLASS} .lec-sympanel-body { max-height: 260px; overflow-y: auto; padding: 8px 10px; }
.${EX_CLASS} .lec-symgroup { margin-bottom: 10px; }
.${EX_CLASS} .lec-symgroup-name {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.8px;
  color: var(--aem-ink-dim); margin: 0 0 5px 1px;
  cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 4px;
}
.${EX_CLASS} .lec-symgroup-name:hover { color: var(--aem-accent); }
.${EX_CLASS} .lec-symgrid { display: flex; flex-wrap: wrap; gap: 4px; }
.${EX_CLASS} .lec-sym {
  min-width: 30px; height: 27px; padding: 0 7px;
  border-radius: 7px;
  border: 1px solid var(--aem-line);
  background: light-dark(#fff, var(--dsw-alias-bg-layer-2));
  color: var(--aem-ink);
  font-family: inherit; font-size: 12.5px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.12s, border-color 0.12s;
}
.${EX_CLASS} .lec-sym:hover { background: var(--aem-accent-soft); border-color: var(--aem-accent-2); }
.${EX_CLASS} .lec-sym[data-structured="1"] { border-color: var(--aem-accent-2); font-weight: 600; }
/* 刚复制过的符号：短暂高亮，给"点了有反应"的反馈 */
.${EX_CLASS} .lec-sym[data-copied="1"] {
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  color: #fff; border-color: transparent;
}
/* 插入成功的额外提示：加一圈外发光（和"已复制"叠加，都能看出来） */
.${EX_CLASS} .lec-sym[data-inserted="1"] {
  box-shadow: 0 0 0 2px var(--aem-accent-2);
}

/* —— 课程折叠（真机反馈："几十上百节课都列出来了"）—— */
.${EX_CLASS} .lec-course-toggle {
  flex: none;
  width: 16px; height: 16px;
  padding: 0; margin-right: 2px;
  border: none; background: none;
  color: var(--aem-ink);
  opacity: 0.6;
  font-size: 10px; line-height: 1;
  cursor: pointer;
}
.${EX_CLASS} .lec-course-toggle:hover { opacity: 1; }
.${EX_CLASS} .lec-course-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: pointer;
}
/* 收起时显示"里面有几节"，免得完全看不出内容量 */
.${EX_CLASS} .lec-course-count {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 10px;
  background: color-mix(in srgb, var(--aem-accent) 22%, transparent);
}

/* —— 可编辑留白（我的理解 / 我的疑问）—— */
.${EX_CLASS} .lec-blank-edit {
  display: block;
  position: relative;
}
.${EX_CLASS} .lec-blank-input {
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
.${EX_CLASS} .lec-blank-input:focus {
  border-style: solid;
  border-color: var(--aem-accent);
  background: var(--dsw-alias-bg-base, #fff);
}
.${EX_CLASS} .lec-blank-state {
  position: absolute;
  right: 4px; bottom: 3px;
  font-size: 10px;
  opacity: 0.7;
  pointer-events: none;
}
.${EX_CLASS} .lec-blank-state[data-tone="saved"] { color: #3fa96a; opacity: 1; }
.${EX_CLASS} .lec-blank-state[data-tone="err"] { color: #d9534f; opacity: 1; }

/* —— 按钮 —— */
.${EX_CLASS} .lec-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 16px;
  border: none; border-radius: var(--aem-radius-ctl);
  background: linear-gradient(135deg, var(--aem-accent), var(--aem-accent-2));
  color: #fff; font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  box-shadow: 0 3px 10px light-dark(rgba(224, 90, 133, 0.24), rgba(0, 0, 0, 0.4));
}
.${EX_CLASS} .lec-btn:disabled { opacity: 0.55; cursor: default; box-shadow: none; }
.${EX_CLASS} .lec-btn-ghost {
  padding: 9px 14px; border-radius: var(--aem-radius-ctl);
  border: 1px solid var(--aem-line); background: transparent;
  color: var(--aem-ink-soft); font-family: inherit; font-size: 12.5px; cursor: pointer;
}
.${EX_CLASS} .lec-btn-ghost:hover { border-color: var(--aem-accent-2); color: var(--aem-accent); }
.${EX_CLASS} .lec-actions { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }

/* —— 卡片 / 提示 —— */
.${EX_CLASS} .lec-card {
  background: var(--aem-surface);
  border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-card);
  box-shadow: var(--aem-shadow-card);
  padding: 9px 12px;
  margin-bottom: 7px;
}
.${EX_CLASS} .lec-notice {
  padding: 9px 12px; border-radius: var(--aem-radius-ctl);
  background: light-dark(#fff8fb, var(--dsw-alias-bg-layer-2));
  border: 1px solid var(--aem-line);
  font-size: 11.5px; line-height: 1.6; color: var(--aem-ink-soft);
  margin: 8px 0;
}
.${EX_CLASS} .lec-warn {
  padding: 8px 12px; border-radius: var(--aem-radius-ctl); font-size: 11.5px; line-height: 1.55;
  background: light-dark(#fdecec, rgba(217, 83, 79, 0.14)); color: #a01a1a;
  border: 1px solid light-dark(#f5c2c2, rgba(217, 83, 79, 0.3));
  margin-top: 8px;
}
.${EX_CLASS} .lec-ok {
  padding: 8px 12px; border-radius: var(--aem-radius-ctl); font-size: 11.5px; line-height: 1.55;
  background: light-dark(#e6f6ec, rgba(28, 107, 63, 0.16)); color: #1c6b3f;
  border: 1px solid light-dark(#bfe6cd, rgba(28, 107, 63, 0.3));
  margin-top: 8px;
}
.${EX_CLASS} .lec-empty { color: var(--aem-ink-dim); font-size: 12px; padding: 14px 2px; line-height: 1.7; }

/* —— 块列表 —— */
.${EX_CLASS} .lec-pre {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  color: var(--aem-ink);
}
.${EX_CLASS} .lec-blank { margin-top: 6px; font-size: 12px; line-height: 1.55; }
.${EX_CLASS} .lec-blank b { color: var(--aem-ink-soft); font-weight: 700; }
.${EX_CLASS} .lec-meta {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 10.5px; color: var(--aem-ink-dim); margin-top: 5px;
}

/* —— 复盘：步骤徽章 —— */
.${EX_CLASS} .lec-step {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: var(--aem-radius-pill);
  font-size: 10.5px; font-weight: 700;
  background: light-dark(#f4eef2, var(--dsw-alias-bg-layer-3));
  color: var(--aem-ink-soft);
  margin-bottom: 8px;
}
.${EX_CLASS} .lec-step[data-step="recall"] { background: #ffe9f2; color: #a01a5a; }
.${EX_CLASS} .lec-step[data-step="compare"] { background: #e8f1fe; color: #1a4f8a; }
.${EX_CLASS} .lec-step[data-step="repair"] { background: #fff3d6; color: #8a5a0b; }
.${EX_CLASS} .lec-step[data-step="candidates"],
.${EX_CLASS} .lec-step[data-step="commit"] { background: #e6f6ec; color: #1c6b3f; }

/* —— 复盘：三栏对照（面板窄，改纵向堆叠） —— */
.${EX_CLASS} .lec-col3 { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.${EX_CLASS} .lec-col {
  border-radius: var(--aem-radius-ctl); padding: 8px 11px; margin-bottom: 6px;
  font-size: 12px; line-height: 1.6;
  border: 1px solid var(--aem-line); background: var(--aem-surface);
}
.${EX_CLASS} .lec-col h4 { margin: 0 0 5px; font-size: 11.5px; }
.${EX_CLASS} .lec-col[data-kind="remembered"] h4 { color: #1c6b3f; }
.${EX_CLASS} .lec-col[data-kind="missed"] h4 { color: #8a5a0b; }
.${EX_CLASS} .lec-col[data-kind="wrong"] h4 { color: #a01a1a; }
.${EX_CLASS} .lec-col ul { margin: 0; padding-left: 17px; }

/* —— 候选条目勾选 —— */
.${EX_CLASS} .lec-check {
  display: flex; gap: 7px; align-items: flex-start;
  font-size: 12px; line-height: 1.55; margin-top: 5px;
}
.${EX_CLASS} .lec-check input { margin-top: 3px; flex: none; }

/* —— 复盘容器 —— */
.${EX_CLASS} .lec-review { display: flex; flex-direction: column; }
.${EX_CLASS} .lec-unit-title { font-size: 12.5px; font-weight: 600; color: var(--aem-ink); }

/* —— 滚动条 —— */
.${EX_CLASS} ::-webkit-scrollbar { width: 9px; height: 9px; }
.${EX_CLASS} ::-webkit-scrollbar-track { background: transparent; }
.${EX_CLASS} ::-webkit-scrollbar-thumb {
  background: var(--aem-line); border-radius: 999px;
  border: 2px solid transparent; background-clip: content-box;
}
.${EX_CLASS} ::-webkit-scrollbar-thumb:hover { background: var(--aem-accent-2); background-clip: content-box; }

/* —— 收起态：竖排文字提示 —— */
.${EX_CLASS} .lec-collapsed-hint {
  writing-mode: vertical-rl;
  font-size: 11.5px; letter-spacing: 2px;
  color: var(--aem-ink-soft);
  margin: 12px auto 0;
  cursor: pointer;
  user-select: none;
}
.${EX_CLASS} .lec-collapsed-hint:hover { color: var(--aem-accent); }

@media (prefers-reduced-motion: reduce) {
  .${EX_CLASS} { animation: none; }
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
.${EX_CLASS}[data-workbench="1"] {
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
  animation: aem-ex-in 0.16s ease-out;
  z-index: 2147482500;
}
.${EX_CLASS}[data-workbench="1"][data-standalone="1"] { z-index: 2147483000; }

.${EX_CLASS} .lec-wb {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 0;
}

/* —— 左栏：课程 / 单元 ——
   ⚠️ 背景必须**不透明**（半透明的 color-mix 会让底层主 agent 透出来 ——
   真机截图看到左栏左上角露出"插件/工作区"，就是这里漏了实色底）。 */
.${EX_CLASS} .lec-wb-nav {
  flex: 0 0 232px;
  min-width: 0;
  overflow-y: auto;
  border-right: 1px solid var(--aem-line);
  padding: 6px 0 14px;
  background: var(--aem-nav-bg);
}
.${EX_CLASS} .lec-wb-navhead {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.55;
  padding: 6px 12px 8px;
}
.${EX_CLASS} .lec-course { margin-bottom: 10px; }
.${EX_CLASS} .lec-course-name {
  font-size: 12.5px;
  font-weight: 700;
  padding: 4px 12px;
  color: var(--aem-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${EX_CLASS} .lec-course-sem {
  font-weight: 400;
  opacity: 0.5;
  margin-left: 6px;
  font-size: 11px;
}
.${EX_CLASS} .lec-unit {
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
.${EX_CLASS} .lec-unit:hover { background: color-mix(in srgb, var(--aem-accent) 12%, transparent); }
.${EX_CLASS} .lec-unit[data-active="1"] {
  background: color-mix(in srgb, var(--aem-accent) 20%, transparent);
  font-weight: 600;
}
.${EX_CLASS} .lec-unit-title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${EX_CLASS} .lec-unit-meta { flex: none; font-size: 10.5px; opacity: 0.5; }

/* —— 删除按钮 ——
   平时几乎不可见（避免误点），悬停该行才显形并变红。
   真机反馈：早先**完全没有删除入口**，测试笔记只能手改文件。 */
.${EX_CLASS} .lec-unit-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.${EX_CLASS} .lec-unit-row .lec-unit { flex: 1 1 auto; }
.${EX_CLASS} .lec-del {
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
.${EX_CLASS} .lec-unit-row:hover .lec-del,
.${EX_CLASS} .lec-course-name:hover .lec-del { opacity: 0.5; }
.${EX_CLASS} .lec-del:hover { opacity: 1; background: #e05a85; color: #fff; }
.${EX_CLASS} .lec-del:disabled { opacity: 0.25; cursor: default; }
/* 课程级的删除按钮浮在课程名右侧 */
.${EX_CLASS} .lec-del-course { float: right; margin-right: 8px; margin-top: -2px; }

/* —— 中栏：笔记主体 —— */
.${EX_CLASS} .lec-wb-main {
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
.${EX_CLASS} .lec-wb-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 16px 20px;
}

/* —— 速记输入框（中栏底部）——
   用户要的就是"中间那片空闲放一个输入框"，所以做得朴素：
   一条分隔线 + 一个自动长高的 textarea + 右下角一个"记下"。 */
.${EX_CLASS} .lec-composer {
  flex: none;
  border-top: 1px solid var(--aem-line);
  padding: 8px 16px 10px;
  background: var(--aem-nav-bg);
}
.${EX_CLASS} .lec-composer-input {
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
.${EX_CLASS} .lec-composer-input:focus {
  border-color: var(--aem-accent);
}
.${EX_CLASS} .lec-composer-input:disabled { opacity: 0.6; }
.${EX_CLASS} .lec-composer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.${EX_CLASS} .lec-composer-hint {
  flex: 1 1 auto;
  font-size: 11px;
  opacity: 0.6;
  min-height: 14px;
}
.${EX_CLASS} .lec-composer-hint[data-tone="err"] { color: #d9534f; opacity: 1; }
.${EX_CLASS} .lec-composer-send {
  flex: none;
  padding: 5px 14px;
  border-radius: 7px;
  border: 1px solid var(--aem-accent);
  background: var(--aem-accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.${EX_CLASS} .lec-composer-send:disabled {
  opacity: 0.45;
  cursor: default;
}

/* —— 输入框的模式切换（文字 / 公式）——
   用户反馈："那现在是不是整个输入框都是公式文字了？正常文本怎么办呢"。
   所以默认文字模式，公式是显式选项。 */
.${EX_CLASS} .lec-composer-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
}
.${EX_CLASS} .lec-composer-tab {
  padding: 2px 10px;
  border-radius: 6px 6px 0 0;
  border: 1px solid var(--aem-line);
  border-bottom: none;
  background: transparent;
  color: var(--aem-ink);
  font-size: 11.5px;
  cursor: pointer;
  opacity: 0.7;
}
.${EX_CLASS} .lec-composer-tab[data-active="1"] {
  opacity: 1;
  font-weight: 600;
  background: var(--dsw-alias-bg-base, #fff);
  border-color: var(--aem-accent);
}
.${EX_CLASS} .lec-composer-modelabel {
  margin-left: auto;
  font-size: 10.5px;
  opacity: 0.55;
}
.${EX_CLASS} .lec-composer-loading {
  padding: 10px 4px;
  font-size: 12px;
  opacity: 0.6;
}
/* markdown 单框模式下的说明文字（不再是"文字/公式"两个按钮） */
.${EX_CLASS} .lec-composer-mode-static {
  margin-left: 0;
  margin-right: auto;
  opacity: 0.55;
  font-size: 11px;
}
.${EX_CLASS} .lec-composer-mode-static code {
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--aem-accent) 16%, transparent);
  font-size: 10.5px;
}

/* —— 预览区 ——
   写的时候就能看到公式渲染得对不对（提交后笔记区也会渲染，
   但写错了当场发现比事后翻笔记便宜）。 */
.${EX_CLASS} .lec-composer-preview {
  flex: none;
  max-height: 180px;
  overflow-y: auto;
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px dashed var(--aem-line);
  background: color-mix(in srgb, var(--aem-accent) 5%, transparent);
  font-size: 13px;
}
.${EX_CLASS} .lec-composer-previewhead {
  font-size: 10px;
  letter-spacing: 0.06em;
  opacity: 0.45;
  margin-bottom: 3px;
}

/* ============================================================
   笔记渲染（markdown + 行内公式）
   —— 由 math-markup.tsx 的 MathMarkup 产出
   ============================================================ */
.${EX_CLASS} .lec-md {
  font-size: 13px;
  line-height: 1.65;
  word-break: break-word;
}
.${EX_CLASS} .lec-md h3,
.${EX_CLASS} .lec-md h4,
.${EX_CLASS} .lec-md h5,
.${EX_CLASS} .lec-md h6 {
  margin: 10px 0 6px;
  font-weight: 600;
  line-height: 1.35;
}
.${EX_CLASS} .lec-md h3 { font-size: 16px; }
.${EX_CLASS} .lec-md h4 { font-size: 15px; }
.${EX_CLASS} .lec-md h5 { font-size: 14px; }
.${EX_CLASS} .lec-md h6 { font-size: 13px; }
.${EX_CLASS} .lec-md-p { margin: 2px 0; }
.${EX_CLASS} .lec-md-gap { height: 8px; }
.${EX_CLASS} .lec-md-li {
  display: flex;
  gap: 6px;
  margin: 1px 0 1px 2px;
}
.${EX_CLASS} .lec-md-dot { opacity: 0.5; flex: none; }
.${EX_CLASS} .lec-md-code {
  margin: 6px 0;
  padding: 7px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--aem-line) 40%, transparent);
  font-size: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
}
/* 行内公式：不要把行高顶开 */
.${EX_CLASS} .lec-math-inline {
  display: inline-block;
  vertical-align: middle;
  margin: 0 1px;
}
.${EX_CLASS} .lec-math-inline .ML__latex {
  font-size: 1.05em;
}
/* 渲染器不可用时的源码回退 */
.${EX_CLASS} .lec-math-src {
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--lec-accent, var(--aem-accent)) 14%, transparent);
  font-size: 0.92em;
  opacity: 0.8;
}
.${EX_CLASS} .lec-notehead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--aem-line);
  margin-bottom: 12px;
}
.${EX_CLASS} .lec-notehead-t { font-size: 15px; font-weight: 700; }
.${EX_CLASS} .lec-notehead-d { font-size: 12px; opacity: 0.55; }
.${EX_CLASS} .lec-notechunks { display: flex; flex-direction: column; gap: 12px; }
.${EX_CLASS} .lec-note {
  border: 1px solid var(--aem-line);
  border-radius: 10px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--aem-ink) 2%, transparent);
}
.${EX_CLASS} .lec-note-num { font-size: 10.5px; opacity: 0.45; margin-bottom: 4px; }
.${EX_CLASS} .lec-note-blanks { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.${EX_CLASS} .lec-blank {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.55;
}
.${EX_CLASS} .lec-blank > b { flex: none; width: 60px; opacity: 0.75; font-weight: 700; }
.${EX_CLASS} .lec-blank > span { flex: 1 1 auto; min-width: 0; }
/* 留白未填：明显但不刺眼（提示用户回对话里补） */
.${EX_CLASS} .lec-blank[data-empty="1"] > span { opacity: 0.42; font-style: italic; }

/* 开课卡片（中栏） */
.${EX_CLASS} .lec-startbox {
  max-width: 460px;
  margin: 24px auto 0;
  padding: 18px;
  border: 1px solid var(--aem-line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--aem-accent) 6%, transparent);
}
.${EX_CLASS} .lec-wb-h { font-size: 15px; font-weight: 700; margin-bottom: 12px; }

/* 空状态（中栏大字版） */
.${EX_CLASS} .lec-empty-big {
  max-width: 520px;
  margin: 60px auto 0;
  text-align: center;
  line-height: 1.9;
}
.${EX_CLASS} .lec-empty-h { font-size: 22px; font-weight: 700; margin-bottom: 14px; opacity: 0.9; }
.${EX_CLASS} .lec-empty-big p { margin: 8px 0; font-size: 13.5px; }

/* —— 右栏：符号键盘 / 复盘 —— */
.${EX_CLASS} .lec-wb-side {
  flex: 0 0 300px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--aem-line);
  background: var(--aem-nav-bg);
}
.${EX_CLASS} .lec-sidetabs {
  flex: none;
  display: flex;
  gap: 4px;
  padding: 8px 10px 0;
}
.${EX_CLASS} .lec-sidetab {
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
.${EX_CLASS} .lec-sidetab:hover { opacity: 0.95; }
.${EX_CLASS} .lec-sidetab[data-active="1"] {
  opacity: 1;
  font-weight: 700;
  background: color-mix(in srgb, var(--aem-accent) 18%, transparent);
  border-color: color-mix(in srgb, var(--aem-accent) 35%, transparent);
}
.${EX_CLASS} .lec-sidetab:disabled { opacity: 0.3; cursor: default; }
.${EX_CLASS} .lec-sidebody {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
}

/* 顶栏小按钮 */
.${EX_CLASS} .lec-btn-tiny {
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
.${EX_CLASS} .lec-btn-tiny:hover {
  border-color: var(--aem-accent);
  color: var(--aem-accent);
}

/* ============================================================
   习题专有：题卡 / 判定 / 错题 / 导入弹层
   全部复用上面的 --aem-* token，确保与 lecture 同一套观感。
   ============================================================ */

/* 中栏滚动容器：题卡很多时必须能一直滚到底（真机反馈："内容太长翻不下去"） */
.${EX_CLASS} .lec-wb-main { overflow: hidden; }
.${EX_CLASS} .lec-wb-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }

/* 套题头（沿用 lecture 的 notehead 观感） */
.${EX_CLASS} .lec-sheethead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 2px 0 10px; }
.${EX_CLASS} .lec-sheethead h1 { font-size: 16px; margin: 0; font-weight: 700; letter-spacing: 0.2px; }
.${EX_CLASS} .lec-sheethead .lec-hint { margin: 0; }
.${EX_CLASS} .lec-digest {
  margin: 8px 0 12px; padding: 10px 12px; border-radius: var(--aem-radius-card);
  background: var(--aem-accent-soft); border: 1px solid var(--aem-line);
  color: var(--aem-ink); font-size: 12px; line-height: 1.6; white-space: pre-wrap;
}
.${EX_CLASS} .lec-digest b { display: block; margin-bottom: 4px; font-size: 11px; color: var(--aem-accent); letter-spacing: 0.06em; }
.${EX_CLASS} .lec-nextstep {
  margin: 0 0 12px; padding: 8px 11px; border-radius: var(--aem-radius-ctl);
  background: light-dark(#fff6e6, rgba(240, 180, 90, 0.14));
  border: 1px solid light-dark(#f3dfb8, rgba(240, 180, 90, 0.3));
  color: light-dark(#7a5a12, #f0cd8a); font-size: 12px;
}

/* 题卡 */
.${EX_CLASS} .lec-problem {
  background: var(--aem-surface); border: 1px solid var(--aem-line);
  border-radius: var(--aem-radius-card); box-shadow: var(--aem-shadow-card);
  padding: 14px 16px; margin-bottom: 14px;
}
.${EX_CLASS} .lec-problem[data-state="needs_fix"] { border-color: light-dark(#f0c2b9, rgba(230, 120, 100, 0.42)); }
.${EX_CLASS} .lec-problem[data-state="checked"] { border-color: light-dark(#bfe3c8, rgba(110, 200, 140, 0.34)); }
.${EX_CLASS} .lec-problem-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.${EX_CLASS} .lec-problem-no { font-weight: 700; color: var(--aem-accent); font-size: 13px; }
.${EX_CLASS} .lec-problem-title { color: var(--aem-ink-soft); font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${EX_CLASS} .lec-problem-actions { display: flex; gap: 6px; margin-left: auto; }

/* 题干：**自己滚**，避免一道长题把解答框顶到屏幕外 */
.${EX_CLASS} .lec-statement {
  max-height: 34vh; overflow-y: auto; overscroll-behavior: contain;
  margin: 4px 0 10px; padding: 2px 0 2px 10px;
  border-left: 2px solid var(--aem-line);
  color: var(--aem-ink-soft); font-size: 12.5px; line-height: 1.65;
}

/* 徽章 */
.${EX_CLASS} .lec-badge {
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: var(--aem-radius-pill);
  font-size: 11px; font-weight: 600; border: 1px solid var(--aem-line);
  background: var(--aem-accent-soft); color: var(--aem-accent); white-space: nowrap;
}
.${EX_CLASS} .lec-badge[data-kind="points"] { background: light-dark(#fff6e6, rgba(240, 180, 90, 0.14)); color: light-dark(#8a6414, #f0cd8a); border-color: light-dark(#f3dfb8, rgba(240, 180, 90, 0.3)); }
.${EX_CLASS} .lec-badge[data-kind="todo"] { background: transparent; color: var(--aem-ink-dim); }
.${EX_CLASS} .lec-badge[data-kind="checked"] { background: light-dark(#eaf6ee, rgba(110, 200, 140, 0.16)); color: light-dark(#2f7d32, #6ccb6c); border-color: light-dark(#bfe3c8, rgba(110, 200, 140, 0.34)); }
.${EX_CLASS} .lec-badge[data-kind="needs_fix"] { background: light-dark(#fdecea, rgba(230, 120, 100, 0.16)); color: light-dark(#c2413a, #f1707a); border-color: light-dark(#f0c2b9, rgba(230, 120, 100, 0.42)); }

/* 答案区 */
.${EX_CLASS} .lec-answer-head { display: flex; align-items: center; gap: 8px; margin: 10px 0 6px; }
.${EX_CLASS} .lec-answer-head span { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; color: var(--aem-ink-dim); }
.${EX_CLASS} .lec-saved { font-weight: 500; letter-spacing: 0; color: var(--aem-ink-dim); font-size: 11px; }
.${EX_CLASS} .lec-textarea {
  width: 100%; min-height: 132px; resize: vertical; box-sizing: border-box;
  padding: 10px 12px; border-radius: var(--aem-radius-ctl);
  border: 1px solid var(--aem-line); background: var(--aem-surface);
  color: var(--aem-ink); font: 12.5px/1.6 "Cascadia Mono", Consolas, "Microsoft YaHei", monospace;
  outline: none;
}
.${EX_CLASS} .lec-textarea:focus { border-color: var(--aem-accent); box-shadow: 0 0 0 3px light-dark(rgba(224, 90, 133, 0.12), rgba(240, 139, 171, 0.16)); }
.${EX_CLASS} .lec-preview {
  margin-top: 8px; padding: 10px 12px; border-radius: var(--aem-radius-ctl);
  background: light-dark(#fdf7fa, rgba(255, 255, 255, 0.03));
  border: 1px dashed var(--aem-line); min-height: 20px;
}
.${EX_CLASS} .lec-preview:empty { display: none; }
.${EX_CLASS} .lec-toolrow { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.${EX_CLASS} .lec-toolrow .lec-grow { flex: 1; }

/* 判定面板 */
.${EX_CLASS} .lec-verdict { margin-top: 10px; padding: 10px 12px; border-radius: var(--aem-radius-ctl); background: light-dark(#fdf7fa, rgba(255, 255, 255, 0.03)); border: 1px solid var(--aem-line); }
.${EX_CLASS} .lec-verdict-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.${EX_CLASS} .lec-verdict[data-verdict="correct"] { border-color: light-dark(#bfe3c8, rgba(110, 200, 140, 0.34)); }
.${EX_CLASS} .lec-verdict[data-verdict="wrong"], .${EX_CLASS} .lec-verdict[data-verdict="partial"] { border-color: light-dark(#f0c2b9, rgba(230, 120, 100, 0.42)); }
.${EX_CLASS} .lec-issue { display: flex; gap: 6px; margin-top: 6px; font-size: 12px; }
.${EX_CLASS} .lec-issue .sev { flex: none; width: 38px; font-weight: 700; color: var(--aem-ink-dim); font-size: 11px; }
.${EX_CLASS} .lec-issue[data-sev="error"] .sev { color: light-dark(#c2413a, #f1707a); }
.${EX_CLASS} .lec-issue[data-sev="warn"] .sev { color: light-dark(#8a6414, #f0cd8a); }
.${EX_CLASS} .lec-stale { margin-top: 8px; padding: 6px 9px; border-radius: 6px; font-size: 11.5px; background: light-dark(#fff6e6, rgba(240, 180, 90, 0.14)); border: 1px solid light-dark(#f3dfb8, rgba(240, 180, 90, 0.3)); color: light-dark(#7a5a12, #f0cd8a); }

/* 答案附图（手画示意图）：预览区底部的缩略图条 */
.${EX_CLASS} .lec-figure-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--aem-line); }
.${EX_CLASS} .lec-figure { position: relative; margin: 0; border: 1px solid var(--aem-line); border-radius: 8px; background: light-dark(#fff, rgba(255, 255, 255, 0.04)); padding: 4px; }
.${EX_CLASS} .lec-figure img { display: block; max-width: 220px; max-height: 160px; border-radius: 5px; }
.${EX_CLASS} .lec-figure figcaption { font-size: 10.5px; color: var(--aem-ink-dim); margin-top: 2px; max-width: 220px; }
.${EX_CLASS} .lec-figure-del { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; line-height: 1; border-radius: 50%; border: 1px solid var(--aem-line); background: var(--aem-surface); color: var(--aem-ink-dim); cursor: pointer; font-size: 12px; padding: 0; }
.${EX_CLASS} .lec-figure-del:hover { color: light-dark(#b03030, #ff8a80); border-color: currentColor; }

/* 公式解析失败：显示源码（等宽 + 虚线下划线），不是"红字塞进公式里" */
.${EX_CLASS} .ex-math-error, .${EX_CLASS} .ex-math-fallback { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.94em; color: var(--aem-ink); background: light-dark(#fdf6e3, rgba(240, 200, 120, 0.12)); border: 1px solid light-dark(#e8d9b0, rgba(240, 200, 120, 0.28)); border-radius: 4px; padding: 0 3px; white-space: pre-wrap; cursor: help; }
/* 答辩（学生 vs 批改）：我的原话靠右、爱弥斯的回复靠左 */
.${EX_CLASS} .lec-rebut-thread { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.${EX_CLASS} .lec-rebut-turn { display: flex; flex-direction: column; gap: 4px; }
.${EX_CLASS} .lec-rebut-mine { align-self: flex-end; max-width: 92%; padding: 6px 9px; border-radius: 8px 8px 2px 8px; background: light-dark(#f2eef7, rgba(150, 130, 190, 0.16)); border: 1px solid var(--aem-line); font-size: 12px; color: var(--aem-ink); white-space: pre-wrap; }
.${EX_CLASS} .lec-rebut-ai { align-self: flex-start; max-width: 96%; padding: 7px 10px; border-radius: 8px 8px 8px 2px; background: light-dark(#fbf7ff, rgba(120, 96, 170, 0.12)); border: 1px solid light-dark(#e6dcf5, rgba(150, 130, 190, 0.28)); font-size: 12px; color: var(--aem-ink); }
.${EX_CLASS} .lec-rebut-ai[data-outcome="conceded"] { background: light-dark(#f1fbf3, rgba(90, 190, 120, 0.14)); border-color: light-dark(#cfeada, rgba(90, 190, 120, 0.32)); }
.${EX_CLASS} .lec-rebut-ai[data-outcome="upheld"] { background: light-dark(#fdf3f2, rgba(220, 120, 110, 0.12)); border-color: light-dark(#f0d6d2, rgba(220, 120, 110, 0.28)); }
.${EX_CLASS} .lec-rebut-who { display: block; font-size: 10.5px; letter-spacing: 0.02em; color: var(--aem-ink-dim); margin-bottom: 2px; }
.${EX_CLASS} .lec-rebut-input { width: 100%; box-sizing: border-box; margin-bottom: 6px; }

/* 错题卡 / 经验卡 */
.${EX_CLASS} .lec-mistake { border: 1px solid var(--aem-line); border-radius: var(--aem-radius-card); background: var(--aem-surface); padding: 10px 11px; margin-bottom: 8px; }
.${EX_CLASS} .lec-mistake[data-mastered="1"] { opacity: 0.62; }
.${EX_CLASS} .lec-mistake-path { font-size: 11px; color: var(--aem-ink-dim); }
.${EX_CLASS} .lec-mistake-issues { margin: 6px 0; padding-left: 16px; color: var(--aem-ink-soft); font-size: 11.5px; }
.${EX_CLASS} .lec-mistake-lesson { width: 100%; box-sizing: border-box; min-height: 54px; margin-top: 6px; resize: vertical; padding: 7px 9px; border-radius: 7px; border: 1px solid var(--aem-line); background: var(--aem-surface); color: var(--aem-ink); font: 12px/1.5 inherit; outline: none; }

/* 套题列表里的进度条（lecture 没有） */
.${EX_CLASS} .lec-progress { height: 4px; border-radius: 2px; background: light-dark(#f3e2ea, rgba(255, 255, 255, 0.1)); margin-top: 6px; overflow: hidden; }
.${EX_CLASS} .lec-progress > i { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--aem-accent), var(--aem-accent-2)); }

/* 导入弹层 */
.${EX_CLASS} .lec-modal-mask { position: fixed; inset: 0; z-index: 2147483100; display: flex; align-items: center; justify-content: center; background: light-dark(rgba(40, 20, 30, 0.34), rgba(0, 0, 0, 0.56)); }
.${EX_CLASS} .lec-modal { width: min(540px, 92vw); max-height: 86vh; overflow: auto; padding: 18px 20px; background: var(--aem-surface); border: 1px solid var(--aem-line); border-radius: var(--aem-radius-card); box-shadow: var(--aem-shadow-pop); }
.${EX_CLASS} .lec-modal h2 { margin: 0 0 4px; font-size: 15px; }
.${EX_CLASS} .lec-modal p { margin: 0 0 12px; color: var(--aem-ink-dim); font-size: 12px; }
.${EX_CLASS} .lec-field { margin-bottom: 10px; }
.${EX_CLASS} .lec-drop { border: 1.5px dashed var(--aem-line); border-radius: var(--aem-radius-card); padding: 18px; text-align: center; color: var(--aem-ink-dim); font-size: 12px; cursor: pointer; background: light-dark(#fdf7fa, rgba(255, 255, 255, 0.03)); }
.${EX_CLASS} .lec-drop[data-hot="1"] { border-color: var(--aem-accent); background: var(--aem-accent-soft); color: var(--aem-accent); }
.${EX_CLASS} .lec-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.${EX_CLASS} .lec-warnbox { margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 11.5px; background: light-dark(#fff6e6, rgba(240, 180, 90, 0.14)); border: 1px solid light-dark(#f3dfb8, rgba(240, 180, 90, 0.3)); color: light-dark(#7a5a12, #f0cd8a); }


/* ---- 答案编辑器：分栏实时渲染（写的时候右边就是排好版的公式） ---- */
.${EX_CLASS} .lec-answer-head .lec-tab { white-space: nowrap; }
.${EX_CLASS} .lec-editor { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
.${EX_CLASS} .lec-editor[data-mode="write"] { grid-template-columns: 1fr; }
.${EX_CLASS} .lec-editor[data-mode="write"] .lec-preview-pane { display: none; }
.${EX_CLASS} .lec-editor[data-mode="render"] { grid-template-columns: 1fr; }
.${EX_CLASS} .lec-editor[data-mode="render"] .lec-textarea { display: none; }
.${EX_CLASS} .lec-preview-pane {
  max-height: 260px; overflow-y: auto; overscroll-behavior: contain;
  padding: 10px 12px; border-radius: var(--aem-radius-ctl);
  border: 1px solid var(--aem-line); background: var(--aem-surface);
  font-size: 12.5px; line-height: 1.75;
}
.${EX_CLASS} .lec-preview-pane:empty::before { content: "（排版预览）"; color: var(--aem-ink-dim); }
.${EX_CLASS} .lec-editor[data-mode="render"] .lec-preview-pane { max-height: 46vh; }
@media (max-width: 900px) { .${EX_CLASS} .lec-editor { grid-template-columns: 1fr; } }

/* ---- 原题截图（多模态渲染出来的原卷页面） ---- */
.${EX_CLASS} .lec-pagefig { margin: 8px 0 4px; }
/* 原图容器：限高 + 自己滚，展开时不会把解答框顶到屏幕外 */
.${EX_CLASS} .lec-pagefig .lec-pageimg {
  margin-top: 6px; max-height: 58vh; overflow: auto; overscroll-behavior: contain;
  border-radius: var(--aem-radius-ctl); border: 1px solid var(--aem-line); background: #fff;
}
.${EX_CLASS} .lec-pagefig img {
  display: block; width: 100%; height: auto; background: #fff;
}
.${EX_CLASS} .lec-pagefig[data-figure="1"] { border-left: 3px solid var(--aem-accent); padding-left: 8px; }
.${EX_CLASS} .lec-fignote { font-size: 11.5px; color: var(--aem-ink-soft); margin-top: 4px; }
.${EX_CLASS} .lec-badge[data-kind="figure"] { background: var(--aem-accent-soft); color: var(--aem-accent); }
/* toast */
.${EX_CLASS} .lec-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  max-width: min(760px, 90vw); padding: 9px 14px; border-radius: var(--aem-radius-pill);
  background: light-dark(rgba(48, 24, 34, 0.92), rgba(28, 28, 30, 0.94)); color: #fff;
  font-size: 12px; z-index: 2147483200; box-shadow: var(--aem-shadow-pop); white-space: pre-wrap;
}


`;

/** 注入（幂等：同 id 已存在则跳过）。 */
export function injectExerciseStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}
