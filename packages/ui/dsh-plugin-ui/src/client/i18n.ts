// ============================================================
// i18n.ts —— Aemeath UI 本地化基础设施（三语：zh/en/de）
// 接线：接入平台 dsh-client-locale 服务（ctx.locale）。
//   - register：向平台注册 aemeath 命名空间字典（zh/en/de）
//   - t()：模块级翻译函数（组件 import 直接调用；读取当前 active locale）
//   - useLocale()：React hook，订阅 locale 切换触发重渲染
// 平台限制：dsh-client-locale 的 LOCALES 常量只有 zh/en（setLocale('de') 会
//   throw），德文需 patch 平台包（见 scripts/patch-de-locale.ps1）。
//   但 register 的字典查找链支持任意 locale id：active 命中 de 字典即生效。
// ============================================================
import { useSyncExternalStore } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client';
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots';
import { zh, en, de } from './locales.ts';

export const LOCALE_NS = 'aemeath';

/** 模块级翻译函数：平台 locale 服务绑定（bind 返回稳定引用）。 */
let tFn: Translate | null = null;

/** 模块级 locale 快照源（useLocale hook 用）。 */
let localeRuntime:
  | {
      subscribe(l: () => void): () => void;
      getSnapshot(): LocaleSnapshot;
    }
  | null = null;

/** 已注册的字典（模块级，供 t() 兜底 + 测试注入）。 */
const fallbackDicts: Record<string, Record<string, string>> = { zh, en, de };

/**
 * 安装 i18n：向平台注册 aemeath 字典，绑定 t()。
 * 在 client apply() 中调用一次。
 */
export function installI18n(ctx: ClientContext): void {
  const locale = (ctx as unknown as { locale?: unknown }).locale as
    | {
        register(ns: string, localeId: string, dict: Record<string, string>): () => void;
        bind(ns: string): Translate;
        subscribe(l: () => void): () => void;
        getSnapshot(): LocaleSnapshot;
      }
    | undefined;

  if (locale) {
    // 平台 register 的类型化重载只接受 zh/en（Record<LocaleId, ...>）；
    // 这里用单语 untyped 重载逐个注册，de 也能注册进查找链。
    const disposers = [locale.register(LOCALE_NS, 'zh', zh), locale.register(LOCALE_NS, 'en', en), locale.register(LOCALE_NS, 'de', de)];
    tFn = locale.bind(LOCALE_NS);
    localeRuntime = {
      subscribe: (l) => locale.subscribe(l),
      getSnapshot: () => locale.getSnapshot(),
    };
    ctx.effect(() => () => disposers.forEach((d) => d()));
    return;
  }

  // 平台 locale 服务缺失（测试/独立环境）：退化为本地字典查找。
  let active: 'zh' | 'en' | 'de' = 'zh';
  const listeners = new Set<() => void>();
  tFn = (key, params) => {
    const tpl = fallbackDicts[active]?.[key] ?? zh[key as keyof typeof zh] ?? key;
    if (!params) return tpl;
    return tpl.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])));
  };
  localeRuntime = {
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => ({ active, locales: [], revision: 0 }),
  };
}

/**
 * 翻译函数：读取当前 active locale（平台 bind 在调用时解析），
 * 支持 {name} 模板插值。未安装时返回 key 本身。
 */
export function t(key: string, params?: Record<string, unknown>): string {
  if (!tFn) return key;
  const out = tFn(key, params);
  return out ?? key;
}

/**
 * React hook：订阅 locale 切换，触发组件重渲染（locale/change → revision 变更）。
 * 在需要跟随语言切换的组件中调用（返回 active locale id 供调试/条件渲染）。
 */
export function useLocale(): string {
  const snap = useSyncExternalStore(
    (l) => localeRuntime?.subscribe(l) ?? (() => undefined),
    () => localeRuntime?.getSnapshot() ?? ({ active: 'zh', locales: [], revision: 0 } as LocaleSnapshot),
  );
  return snap.active;
}
