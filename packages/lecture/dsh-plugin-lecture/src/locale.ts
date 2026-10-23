// ============================================================
// locale.ts — host 侧 UI 语言读取（供错误/对话框/摘要文案使用）
//
// 前端把 active locale 上报到 settings.aemeath-ui.locale（见 dsh-plugin-ui），
// 这里通过 common 的 readSetting 惰性读取最新值；读不到时回退 zh。
//
// 为什么用模块级 holder：store/http/handoff 等纯函数没有 ctx 参数，
// 但同一进程只需一个读取器；apply() 里绑定一次即可。
// ============================================================
import { readSetting } from '@aemeath/dsh-plugin-common';

export type UiLang = 'zh' | 'en';

let getCtx: (() => unknown) | null = null;

/** 在 host 的 apply(ctx) 里调用一次。 */
export function setLocaleContext(ctx: unknown): void {
  getCtx = () => ctx;
}

/** 当前 UI 语言（每次调用都读最新设置，支持热切换）。 */
export function uiLang(): UiLang {
  try {
    const v = getCtx ? readSetting(getCtx(), 'aemeath-ui') : undefined;
    return v?.locale === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

/** 双语文案选择：英文 UI 用 en，否则 zh。 */
export function tr(zh: string, en: string): string {
  return uiLang() === 'en' ? en : zh;
}

/** 带占位符的双语模板；`{name}` 由调用方替换。 */
export function trf(zh: string, en: string, params: Record<string, string | number>): string {
  const tpl = tr(zh, en);
  return tpl.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])));
}
