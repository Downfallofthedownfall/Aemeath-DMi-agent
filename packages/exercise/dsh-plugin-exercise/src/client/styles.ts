// ============================================================
// client/styles.ts — 习题工作台的样式（一次性注入，类名前缀 `ex-`）
//
// 设计语言借 lecture（同一套卡片/边栏/中栏结构、同一套字体与圆角），
// 但主色换成**青绿**：课堂模式是蓝色、记忆工作区是粉紫，
// 习题要能一眼区分开（用户同时开着几个界面时不会点错）。
//
// 颜色一律走宿主 token + 暖色兜底（不写死深色/浅色）：
//   · 宿主切主题时自动跟随，不会出现"习题界面还是上一版配色"
//   · 兜底值取自 UI 改造后的暖纸色（#faf9f6 / #3b3832）
// ============================================================

export const EX_CLASS = 'ex-app';

const CSS = `
.${EX_CLASS} {
  --ex-bg: var(--dsw-alias-bg-base, #eef1f6);
  --ex-surface: var(--dsw-alias-bg-layer-1, #e7ebf1);
  --ex-surface-2: var(--dsw-alias-bg-layer-2, #f6f5f2);
  --ex-border: var(--dsw-alias-border-1, #e7e4de);
  --ex-border-strong: var(--dsw-alias-border-2, #d6d2c9);
  --ex-text: var(--dsw-alias-label-primary, #303b4c);
  --ex-text-2: var(--dsw-alias-label-secondary, #6b665d);
  --ex-text-3: var(--dsw-alias-label-tertiary, #9a948a);
  /*
   * 强调色**继承 aemeath 主 agent 的设计语言**，不自己发明配色。
   * 主 agent 的品牌色是玫粉（state-business-primary / brand-text /
   * state-business-tertiary），由 aemeath-ui 的 PALETTE_OVERRIDES 按主题改写；
   * 这里只引用、不覆盖 → 习题界面与主界面在亮/暗两种主题下自动一致，
   * 也跟随用户以后改品牌色的决定（改一处，所有界面一起变）。
   *
   * var() 的第二参数只是**宿主主题缺失时**的兜底（例如把页面单独存成 HTML 打开）。
   */
  --ex-accent: var(--dsw-alias-state-business-primary, #ff8cbd);
  --ex-accent-strong: var(--dsw-alias-brand-text, #c2367b);
  --ex-accent-soft: var(--dsw-alias-state-business-tertiary, #ffe9f3);
  --ex-accent-line: color-mix(in srgb, var(--ex-accent) 42%, transparent);
  /* 语义色同样走宿主 token（aemeath-ui 的调色板里 success/warn/error 都有配套色阶） */
  --ex-ok: var(--dsw-alias-state-success-primary, #2f7d32);
  --ex-ok-soft: var(--dsw-alias-state-success-secondary, #e4f2e2);
  --ex-ok-line: var(--dsw-alias-state-success-tertiary, #d0e9cc);
  --ex-warn: var(--dsw-alias-state-warn-primary, #8f5f00);
  --ex-warn-soft: var(--dsw-alias-state-warn-secondary, #fbf1dc);
  --ex-warn-line: var(--dsw-alias-state-warn-tertiary, #f5e5bd);
  --ex-danger: var(--dsw-alias-state-error-primary, #c2413a);
  --ex-danger-soft: var(--dsw-alias-state-error-secondary, #fbe9e5);
  --ex-danger-line: color-mix(in srgb, var(--ex-danger) 40%, transparent);
  /* 「已作答」这类中性状态也用品牌色（不引入第二套蓝） */
  --ex-info: var(--ex-accent-strong);
  --ex-info-soft: var(--ex-accent-soft);
  --ex-info-line: var(--ex-accent-line);
  --ex-radius: 12px;
  --ex-radius-sm: 8px;
  --ex-shadow: 0 1px 2px rgba(30, 25, 20, .05), 0 6px 18px rgba(30, 25, 20, .05);
  position: fixed;
  inset: 0;
  z-index: 2147482900;
  display: flex;
  flex-direction: column;
  background: var(--ex-bg);
  color: var(--ex-text);
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif;
  font-size: 13.5px;
  line-height: 1.55;
  overflow: hidden;
}

/* ── 顶栏 ───────────────────────────────────────────── */
.ex-topbar {
  display: flex; align-items: center; gap: 10px;
  height: 46px; flex: none; padding: 0 14px;
  background: var(--ex-surface);
  border-bottom: 1px solid var(--ex-border);
}
.ex-brand { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: .2px; }
.ex-brand-dot { width: 8px; height: 8px; border-radius: 50%; background: linear-gradient(135deg, var(--ex-accent), var(--ex-accent-strong)); }
.ex-brand-sub { font-weight: 500; color: var(--ex-text-3); font-size: 12px; }
.ex-topbar-spacer { flex: 1; }
.ex-course-select {
  height: 30px; min-width: 150px; padding: 0 8px; border-radius: var(--ex-radius-sm);
  border: 1px solid var(--ex-border-strong); background: var(--ex-surface); color: var(--ex-text);
  font: inherit; cursor: pointer;
}

/* ── 三栏 ───────────────────────────────────────────── */
.ex-body { flex: 1; display: grid; grid-template-columns: 296px minmax(0, 1fr) 344px; min-height: 0; }
.ex-col { min-height: 0; overflow: auto; padding: 12px; }
.ex-col-left { border-right: 1px solid var(--ex-border); background: var(--ex-surface); }
.ex-col-center { background: var(--ex-bg); padding: 14px 18px 60px; }
.ex-col-right { border-left: 1px solid var(--ex-border); background: var(--ex-surface); padding: 0; display: flex; flex-direction: column; }
@media (max-width: 1180px) {
  .ex-body { grid-template-columns: 240px minmax(0, 1fr) 300px; }
}

/* ── 左栏：课程/套题 ─────────────────────────────────── */
.ex-section-title {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: var(--ex-text-3); margin: 6px 2px 8px;
}
.ex-sheet-list { display: flex; flex-direction: column; gap: 6px; }
.ex-sheet-item {
  position: relative; text-align: left; width: 100%;
  padding: 9px 10px 10px; border-radius: var(--ex-radius-sm);
  border: 1px solid transparent; background: transparent; color: inherit;
  font: inherit; cursor: pointer;
}
.ex-sheet-item:hover { background: var(--ex-surface-2); }
.ex-sheet-item.active { background: var(--ex-accent-soft); border-color: var(--ex-accent-line); }
.ex-sheet-row { display: flex; align-items: baseline; gap: 6px; }
.ex-sheet-no { font-weight: 700; color: var(--ex-accent-strong); }
.ex-sheet-title { color: var(--ex-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-sheet-meta { display: flex; gap: 8px; margin-top: 4px; font-size: 11.5px; color: var(--ex-text-3); flex-wrap: wrap; }
.ex-progress { height: 4px; border-radius: 2px; background: var(--ex-border); margin-top: 7px; overflow: hidden; }
.ex-progress > i { display: block; height: 100%; background: var(--ex-accent); border-radius: 2px; transition: width .25s ease; }
.ex-progress.done > i { background: var(--ex-ok); }
.ex-left-actions { display: flex; flex-direction: column; gap: 6px; margin: 12px 0 4px; }

/* ── 按钮 ───────────────────────────────────────────── */
.ex-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 11px; border-radius: var(--ex-radius-sm);
  border: 1px solid var(--ex-border-strong); background: var(--ex-surface); color: var(--ex-text);
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.ex-btn:hover { background: var(--ex-surface-2); }
.ex-btn:disabled { opacity: .5; cursor: default; }
.ex-btn-primary { border-color: var(--ex-accent); background: var(--ex-accent); color: #fff; }
.ex-btn-primary:hover { background: var(--ex-accent-strong); }
.ex-btn-ghost { border-color: transparent; background: transparent; color: var(--ex-text-2); }
.ex-btn-ghost:hover { background: var(--ex-surface-2); }
.ex-btn-danger { border-color: var(--ex-danger-line); background: var(--ex-danger-soft); color: var(--ex-danger); }
.ex-btn-sm { height: 26px; padding: 0 9px; font-size: 12px; }

/* ── 中栏：题集头 + 题目卡 ────────────────────────────── */
.ex-sheet-head { margin-bottom: 14px; }
.ex-sheet-head h1 { font-size: 19px; margin: 0 0 4px; letter-spacing: .2px; }
.ex-sheet-head-meta { display: flex; flex-wrap: wrap; gap: 12px; color: var(--ex-text-3); font-size: 12px; }
.ex-digest {
  margin-top: 12px; padding: 10px 12px; border-radius: var(--ex-radius);
  background: var(--ex-accent-soft); border: 1px solid var(--ex-accent-line);
  color: var(--ex-text); font-size: 12.5px; white-space: pre-wrap;
}
.ex-digest b { display: block; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--ex-accent-strong); margin-bottom: 4px; }
.ex-next-hint {
  margin-top: 10px; padding: 8px 12px; border-radius: var(--ex-radius-sm);
  background: var(--ex-warn-soft); border: 1px solid var(--ex-warn-line); color: var(--ex-text); font-size: 12.5px;
}

.ex-problem-card {
  background: var(--ex-surface); border: 1px solid var(--ex-border); border-radius: var(--ex-radius);
  box-shadow: var(--ex-shadow); padding: 14px 16px; margin-bottom: 14px;
}
.ex-problem-card.needs-fix { border-color: var(--ex-danger-line); }
.ex-problem-card.checked { border-color: var(--ex-ok-line); }
.ex-problem-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.ex-problem-label { font-weight: 700; color: var(--ex-accent-strong); }
.ex-problem-title { color: var(--ex-text-2); font-size: 12.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-problem-head-actions { display: flex; gap: 6px; margin-left: auto; }

.ex-chip {
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; background: var(--ex-surface-2); color: var(--ex-text-2); border: 1px solid var(--ex-border);
}
.ex-chip.points { color: var(--ex-warn); border-color: var(--ex-warn-line); background: var(--ex-warn-soft); }
.ex-chip.todo { color: var(--ex-text-3); }
.ex-chip.answered { color: var(--ex-info); border-color: var(--ex-info-line); background: var(--ex-info-soft); }
.ex-chip.checked { color: var(--ex-ok); border-color: var(--ex-ok-line); background: var(--ex-ok-soft); }
.ex-chip.needs_fix { color: var(--ex-danger); border-color: var(--ex-danger-line); background: var(--ex-danger-soft); }
.ex-chip.stale { color: var(--ex-warn); border-color: var(--ex-warn-line); background: var(--ex-warn-soft); }
.ex-chip.accent { color: var(--ex-accent-strong); border-color: var(--ex-accent-line); background: var(--ex-accent-soft); }

.ex-problem-text {
  border-left: 3px solid var(--ex-border); padding: 2px 0 2px 10px; margin: 6px 0 10px;
  color: var(--ex-text-2); font-size: 13px;
}
.ex-problem-text .ex-md { color: var(--ex-text-2); }

.ex-answer-head { display: flex; align-items: center; gap: 8px; margin: 10px 0 6px; }
.ex-answer-head span { font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ex-text-3); }
.ex-answer-head .ex-saved { font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--ex-text-3); font-size: 11.5px; }

.ex-textarea {
  width: 100%; min-height: 132px; resize: vertical; box-sizing: border-box;
  padding: 10px 12px; border-radius: var(--ex-radius-sm);
  border: 1px solid var(--ex-border-strong); background: var(--ex-surface);
  color: var(--ex-text); font: 13px/1.6 "Cascadia Mono", Consolas, "PingFang SC", monospace;
  outline: none;
}
.ex-textarea:focus { border-color: var(--ex-accent); box-shadow: 0 0 0 3px rgba(14, 140, 126, .12); }
.ex-answer-preview {
  margin-top: 8px; padding: 10px 12px; border-radius: var(--ex-radius-sm);
  background: var(--ex-surface-2); border: 1px dashed var(--ex-border-strong); min-height: 24px;
}
.ex-answer-preview:empty { display: none; }
.ex-answer-tools { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.ex-answer-tools .ex-spacer { flex: 1; }

/* ── 检查面板 ───────────────────────────────────────── */
.ex-check {
  margin-top: 10px; border-radius: var(--ex-radius-sm); border: 1px solid var(--ex-border);
  background: var(--ex-surface-2); padding: 10px 12px;
}
.ex-check-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ex-verdict { font-weight: 700; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid; }
.ex-verdict.correct { color: var(--ex-ok); border-color: var(--ex-ok-line); background: var(--ex-ok-soft); }
.ex-verdict.partial { color: var(--ex-warn); border-color: var(--ex-warn-line); background: var(--ex-warn-soft); }
.ex-verdict.wrong { color: var(--ex-danger); border-color: var(--ex-danger-line); background: var(--ex-danger-soft); }
.ex-verdict.unclear { color: var(--ex-text-2); border-color: var(--ex-border-strong); background: var(--ex-surface); }
.ex-verdict.error { color: var(--ex-danger); border-color: var(--ex-danger-line); background: var(--ex-danger-soft); }
.ex-issue { display: flex; gap: 6px; margin-top: 6px; font-size: 12.5px; }
.ex-issue .sev { flex: none; width: 42px; font-size: 11px; font-weight: 700; color: var(--ex-text-3); }
.ex-issue.sev-error .sev { color: var(--ex-danger); }
.ex-issue.sev-warn .sev { color: var(--ex-warn); }
.ex-hint-list { margin: 8px 0 0; padding-left: 18px; color: var(--ex-text-2); font-size: 12.5px; }
.ex-hint-list li { margin: 2px 0; }
.ex-stale-note {
  margin-top: 8px; padding: 6px 9px; border-radius: 6px; font-size: 12px;
  background: var(--ex-warn-soft); border: 1px solid var(--ex-warn-line); color: var(--ex-text);
}
.ex-check-history { margin-top: 8px; font-size: 12px; color: var(--ex-text-3); }
.ex-check-history summary { cursor: pointer; }

/* ── 右栏：tabs ─────────────────────────────────────── */
.ex-tabs { display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid var(--ex-border); }
.ex-tab {
  height: 30px; padding: 0 10px; border: none; background: transparent; color: var(--ex-text-3);
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; border-bottom: 2px solid transparent;
}
.ex-tab.active { color: var(--ex-accent-strong); border-bottom-color: var(--ex-accent); }
.ex-tab-body { flex: 1; overflow: auto; padding: 12px; }

.ex-symbol-search {
  width: 100%; box-sizing: border-box; height: 30px; padding: 0 10px; margin-bottom: 10px;
  border-radius: var(--ex-radius-sm); border: 1px solid var(--ex-border-strong);
  background: var(--ex-surface); color: var(--ex-text); font: inherit; font-size: 12.5px; outline: none;
}
.ex-symbol-group { margin-bottom: 10px; }
.ex-symbol-group > summary { cursor: pointer; font-size: 11.5px; font-weight: 700; color: var(--ex-text-3); text-transform: uppercase; letter-spacing: .06em; }
.ex-symbol-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); gap: 5px; margin-top: 6px; }
.ex-symbol-btn {
  height: 30px; padding: 0 4px; border-radius: 6px; border: 1px solid var(--ex-border);
  background: var(--ex-surface); color: var(--ex-text); font-size: 13px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ex-symbol-btn:hover { border-color: var(--ex-accent); color: var(--ex-accent-strong); background: var(--ex-accent-soft); }
.ex-symbol-note { font-size: 11.5px; color: var(--ex-text-3); margin: 4px 0 10px; line-height: 1.5; }

.ex-mistake {
  border: 1px solid var(--ex-border); border-radius: var(--ex-radius-sm); padding: 10px;
  background: var(--ex-surface); margin-bottom: 8px;
}
.ex-mistake.mastered { opacity: .62; }
.ex-mistake-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
.ex-mistake-path { font-size: 11.5px; color: var(--ex-text-3); }
.ex-mistake-issues { margin: 6px 0; padding-left: 16px; color: var(--ex-text-2); font-size: 12px; }
.ex-mistake-lesson {
  width: 100%; box-sizing: border-box; min-height: 54px; margin-top: 6px; resize: vertical;
  padding: 7px 9px; border-radius: 6px; border: 1px solid var(--ex-border-strong);
  background: var(--ex-surface); color: var(--ex-text); font: 12.5px/1.5 inherit; outline: none;
}
.ex-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }

.ex-stat-row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px dashed var(--ex-border); font-size: 12.5px; }
.ex-stat-row b { color: var(--ex-text); }
.ex-stat-row span { color: var(--ex-text-3); }

/* ── 导入弹层 ───────────────────────────────────────── */
.ex-modal-mask { position: fixed; inset: 0; background: rgba(28, 24, 20, .38); display: flex; align-items: center; justify-content: center; z-index: 2147483100; }
.ex-modal {
  width: min(520px, 92vw); max-height: 86vh; overflow: auto; padding: 18px 20px;
  background: var(--ex-surface); border-radius: 16px; box-shadow: 0 24px 60px rgba(20, 16, 12, .28);
}
.ex-modal h2 { margin: 0 0 4px; font-size: 16px; }
.ex-modal p { margin: 0 0 12px; color: var(--ex-text-3); font-size: 12.5px; }
.ex-field { margin-bottom: 10px; }
.ex-field label { display: block; font-size: 12px; color: var(--ex-text-2); margin-bottom: 3px; }
.ex-input {
  width: 100%; box-sizing: border-box; height: 32px; padding: 0 10px; border-radius: var(--ex-radius-sm);
  border: 1px solid var(--ex-border-strong); background: var(--ex-surface); color: var(--ex-text); font: inherit; font-size: 13px; outline: none;
}
.ex-input:focus { border-color: var(--ex-accent); }
.ex-drop {
  border: 1.5px dashed var(--ex-border-strong); border-radius: var(--ex-radius); padding: 18px;
  text-align: center; color: var(--ex-text-3); font-size: 12.5px; cursor: pointer; background: var(--ex-surface-2);
}
.ex-drop.hot { border-color: var(--ex-accent); background: var(--ex-accent-soft); color: var(--ex-accent-strong); }
.ex-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.ex-warn-list { margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--ex-warn-soft); border: 1px solid var(--ex-warn-line); color: var(--ex-text); font-size: 12px; }
.ex-warn-list ul { margin: 4px 0 0; padding-left: 16px; }

/* ── 提示条 ─────────────────────────────────────────── */
.ex-toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  max-width: min(720px, 90vw); padding: 9px 14px; border-radius: 999px;
  background: rgba(32, 28, 24, .92); color: #fff; font-size: 12.5px; z-index: 2147483200;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .2); white-space: pre-wrap;
}
.ex-empty { color: var(--ex-text-3); font-size: 12.5px; padding: 14px 4px; text-align: center; }
.ex-error { color: var(--ex-danger); font-size: 12.5px; }
.ex-loading { color: var(--ex-text-3); font-size: 12.5px; }

/* ── Markdown / 公式 ────────────────────────────────── */
.ex-md p, .ex-md .ex-md-p { margin: 0 0 4px; white-space: pre-wrap; }
.ex-md-compact .ex-md-p { margin-bottom: 2px; }
.ex-md h3, .ex-md h4, .ex-md h5, .ex-md h6 { margin: 8px 0 4px; font-size: 13.5px; }
.ex-md-li { display: flex; gap: 6px; }
.ex-md-dot { color: var(--ex-text-3); }
.ex-md-code { background: var(--ex-surface-2); border-radius: 6px; padding: 8px 10px; font-size: 12px; overflow: auto; }
.ex-md-gap { height: 6px; }
.ex-math-inline { display: inline-block; }
.ex-math-display { margin: 6px 0; overflow-x: auto; overflow-y: hidden; }
.ex-math-fallback { color: var(--ex-danger); font-size: 12px; }
.ex-app .katex { font-size: 1.03em; }
.ex-app .katex-display { margin: 6px 0; }

/* 打印页面（提交 PDF 的 HTML）在浏览器里预览时的微调 */
@media print {
  .ex-app { display: none; }
}
`;

let injected = false;

/** 注入样式（幂等；必须在插件加载时调用，不能等组件渲染）。 */
export function injectExerciseStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const id = 'aemeath-exercise-styles';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = CSS;
  document.head.appendChild(style);
}
