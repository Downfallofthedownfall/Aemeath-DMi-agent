// ============================================================
// locale.ts — host 侧 UI 语言读取（供错误/摘要/导出文案使用）
//
// 与 lecture 的同名模块同构：前端把 active locale 上报到
// settings.aemeath-ui.locale，这里通过 common 的 readSetting 惰性读取。
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

/** 双语文案选择。 */
export function tr(zh: string, en: string): string {
  return uiLang() === 'en' ? en : zh;
}
