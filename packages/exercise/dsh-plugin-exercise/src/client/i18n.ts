// ============================================================
// client/i18n.ts — 习题模式的浏览器端 i18n（zh/en）
//
// 与 lecture 的实现同构，但命名空间独立（aemeath-exercise）：
// 两个 client bundle 各自注册，不能共用 dsh-plugin-ui 的 aemeath 字典。
// ============================================================
import { useSyncExternalStore } from 'react';
import { zh, en } from './locales.ts';

/** 本插件的 locale 命名空间。 */
export const LOCALE_NS = 'aemeath-exercise';

type Translate = (key: string, params?: Record<string, unknown>) => string;
type LocaleSnapshot = { active: string; revision: number };

interface LocaleFace {
  register(ns: string, localeId: string, dict: Record<string, string>): () => void;
  bind(ns: string): Translate;
  subscribe(l: () => void): () => void;
  getSnapshot(): LocaleSnapshot;
}

let tFn: Translate | null = null;
let runtime: { subscribe(l: () => void): () => void; getSnapshot(): LocaleSnapshot } | null = null;

function interpolate(tpl: string, params?: Record<string, unknown>): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])));
}

function fallbackTranslate(key: string, params?: Record<string, unknown>): string {
  const tpl = (zh as Record<string, string>)[key] ?? key;
  return interpolate(tpl, params);
}

/** 在 client apply() 中调用一次。 */
export function installI18n(ctx: unknown): void {
  const locale = (ctx as { locale?: LocaleFace } | undefined)?.locale;
  if (locale) {
    for (const [id, dict] of [
      ['zh', zh],
      ['en', en],
    ] as const) {
      try {
        locale.register(LOCALE_NS, id, dict as Record<string, string>);
      } catch {
        /* 已注册过（HMR）：跳过 */
      }
    }
    tFn = locale.bind(LOCALE_NS);
    runtime = {
      subscribe: (l) => locale.subscribe(l),
      getSnapshot: () => locale.getSnapshot(),
    };
    return;
  }
  tFn = fallbackTranslate;
  runtime = {
    subscribe: () => () => undefined,
    getSnapshot: () => ({ active: 'zh', revision: 0 }),
  };
}

/** 翻译函数（非组件里也可调用）。 */
export function t(key: string, params?: Record<string, unknown>): string {
  if (!tFn) return fallbackTranslate(key, params);
  const out = tFn(key, params);
  return interpolate(out ?? key, params);
}

function subscribe(l: () => void): () => void {
  return runtime?.subscribe(l) ?? (() => undefined);
}
function getSnapshot(): string {
  return runtime?.getSnapshot().active ?? 'zh';
}

/** 组件内使用：返回 t()，并订阅 locale 切换。 */
export function useT(): (key: string, params?: Record<string, unknown>) => string {
  useSyncExternalStore(subscribe, getSnapshot);
  return t;
}

/** 当前 active locale id（组件内使用）。 */
export function useLocale(): string {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 非组件场景读取当前 locale（未安装时 zh）。 */
export function currentLocale(): string {
  return getSnapshot();
}
