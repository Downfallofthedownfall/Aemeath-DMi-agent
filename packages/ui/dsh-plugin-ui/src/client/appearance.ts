// ============================================================
// appearance.ts —— 设置页「外观」的全局生效层
//
// 为什么单独一个模块：外观要在页面一加载就生效，而设置页组件只有打开设置时才挂载。
// 早先 CSS 变量只在设置页里写（没打开过设置就不生效），而且根本没有样式规则读这些变量 ——
// 整页控件动了也没有任何效果。
//
// 钩子选 dsh 的 data-chat-* 属性（稳定），不用 hash class。
// 只有用户设置过的项才加规则（html[data-aemeath-*] 门控），没设置时完全是 dsh 默认样式。
// ============================================================
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { FetchScope } from './faces.ts';

const STYLE_ID = 'aemeath-appearance-styles';

const CSS = `
html[data-aemeath-font] [data-chat-flow],
html[data-aemeath-font] [data-chat-flow] :is(p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th) { font-family: var(--aemeath-font); }
html[data-aemeath-line-height] [data-chat-flow] :is(p, li, blockquote) { line-height: var(--aemeath-line-height); }
html[data-aemeath-para-spacing] [data-chat-flow] :is(p, ul, ol, blockquote) { margin-block: calc(var(--aemeath-para-spacing) * 1em); }
html[data-aemeath-bubbles] [data-chat-flow-kind="assistant-step"] {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  padding: 10px 14px;
}
`;

const setVar = (name: string, attr: string, value: string | null): void => {
  const root = document.documentElement;
  if (value === null) {
    root.style.removeProperty(name);
    root.removeAttribute(attr);
  } else {
    root.style.setProperty(name, value);
    root.setAttribute(attr, '');
  }
};

/** 拖滑块时的本地预览（还没写回 host）。 */
export function previewAppearance(field: 'chatLineHeight' | 'chatParaSpacing', value: number): void {
  if (typeof document === 'undefined') return;
  if (field === 'chatLineHeight') setVar('--aemeath-line-height', 'data-aemeath-line-height', String(value));
  else setVar('--aemeath-para-spacing', 'data-aemeath-para-spacing', String(value));
}

/** 把一份外观设置应用到根元素。 */
export function applyAppearance(value: Record<string, unknown> | undefined): void {
  if (typeof document === 'undefined' || !value) return;
  const font = typeof value.font === 'string' ? value.font.trim() : '';
  setVar('--aemeath-font', 'data-aemeath-font', font || null);
  const lh = typeof value.chatLineHeight === 'number' && value.chatLineHeight > 0 ? value.chatLineHeight : null;
  setVar('--aemeath-line-height', 'data-aemeath-line-height', lh === null ? null : String(lh));
  const ps = typeof value.chatParaSpacing === 'number' && value.chatParaSpacing > 0 ? value.chatParaSpacing : null;
  setVar('--aemeath-para-spacing', 'data-aemeath-para-spacing', ps === null ? null : String(ps));
  if (value.assistantBubbles === true) document.documentElement.setAttribute('data-aemeath-bubbles', '');
  else document.documentElement.removeAttribute('data-aemeath-bubbles');
}

/** 注入样式并跟随设置变化。 */
export function installAppearance(ctx: ClientContext, scope: FetchScope): void {
  if (typeof document === 'undefined') return;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const apply = (): void => applyAppearance(scope.getSnapshot().value);
  apply();
  ctx.effect(() => scope.subscribe(apply));
}
