// ============================================================
// faces.ts —— 数据 face 工厂（UI 改造 P2）
// 把 apply() 里散落的 settings/role/credentials/scopes 抽成可复用模块：
//   侧边栏（sidebar.tsx）、快速设置（quick-settings.tsx）、设置页（settings.tsx）
// 数据流：前端 fetch GET/POST /aemeath/api/settings（host 桥，避开 api-proxy allowlist）
//         → ctx.settings → settings.yaml → 引擎插件 watch 实时生效。
// ============================================================
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
import type { CredentialView, IApiClient } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import { FEATURE_NAMESPACES } from './constants.ts';
import { CREDENTIALS } from './settings.tsx';

/** 同源设置桥。 */
export interface SettingsBridge {
  read(): Promise<Record<string, unknown>>;
  /** C14：写请求统一为 {patch?} 或 {unset?: string[]}（unset 走 host 端 mutate 删除字段）。 */
  write(ns: string, req: { patch?: Record<string, unknown>; unset?: string[] }): Promise<void>;
}

/** 角色模式 face（可订阅：useSyncExternalStore 兼容）。 */
export interface RoleFace {
  current: string;
  subscribe(l: () => void): () => void;
  getSnapshot(): string;
  set(role: string): Promise<void>;
  refresh(): Promise<void>;
  /** 内部实现：订阅者集合（notify 由 set/refresh 调用）。 */
  listeners: Set<() => void>;
  notify(): void;
}

/** 凭据 face（C11：可订阅——保存/清除 key 后徽章状态实时刷新）。 */
export interface CredentialsFace {
  views: Record<string, CredentialView | undefined>;
  refresh(): Promise<void>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
  /** 订阅视图变化（refresh/set/unset 后通知）。 */
  subscribe(l: () => void): () => void;
  getSnapshot(): Record<string, CredentialView | undefined>;
}

/** SettingsScope 扩展：额外暴露 reload（供 settings/document-updated 事件刷新开关）。 */
export interface FetchScope extends SettingsScope<Record<string, unknown>> {
  load(): Promise<void>;
}

export interface Faces {
  settingsApi: SettingsBridge;
  role: RoleFace;
  credentials: CredentialsFace;
  scopes: Map<string, FetchScope>;
}

/** 构建全部数据 face（在 client apply 中调用一次，随后分发给各注册点）。 */
export function createFaces(ctx: ClientContext): Faces {
  // —— 同源设置桥（GET 读 / POST 写；写支持 patch 合并与 unset 删除字段）——
  const settingsApi: SettingsBridge = {
    read: async (): Promise<Record<string, unknown>> => {
      const res = await fetch('/aemeath/api/settings', { signal: AbortSignal.timeout(8000) });
      const data = (await res.json()) as { ok?: boolean; namespaces?: Record<string, unknown> };
      return data.namespaces ?? {};
    },
    write: async (ns: string, req: { patch?: Record<string, unknown>; unset?: string[] }): Promise<void> => {
      const body: { ns: string; patch?: Record<string, unknown>; unset?: string[] } = { ns };
      if (req.patch !== undefined) body.patch = req.patch;
      if (req.unset?.length) body.unset = req.unset;
      const res = await fetch('/aemeath/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `write failed (${res.status})`);
    },
  };

  // —— 角色模式 face（写 agent-presets.default；可订阅保证 UI 刷新）——
  /** 内部实现类型：公开面 + 订阅内部字段。 */
  type RoleFaceImpl = RoleFace & { listeners: Set<() => void>; notify(): void };
  const roleFace: RoleFaceImpl = {
    current: 'aemeath',
    listeners: new Set<() => void>(),
    subscribe(l: () => void): () => void {
      roleFace.listeners.add(l);
      return () => roleFace.listeners.delete(l);
    },
    getSnapshot: (): string => roleFace.current,
    notify: (): void => {
      for (const l of roleFace.listeners) l();
    },
    refresh: async (): Promise<void> => {
      try {
        const all = await settingsApi.read();
        const ap = all['agent-presets'];
        if (typeof ap === 'string') {
          roleFace.current = ap;
          roleFace.notify();
        }
      } catch {
        /* ignore */
      }
    },
    set: async (role: string): Promise<void> => {
      await settingsApi.write('agent-presets', { patch: { default: role } });
      roleFace.current = role;
      roleFace.notify();
    },
  };
  void roleFace.refresh();

  // —— 凭据 face（describe/set/unset，值单向传输；可订阅保证 UI 刷新）——
  const connection = ctx.get('connection');
  const api: IApiClient = connection.api;
  const credListeners = new Set<() => void>();
  const credNotify = (): void => {
    for (const l of credListeners) l();
  };
  const credentialsFace: CredentialsFace = {
    views: {},
    subscribe(l: () => void): () => void {
      credListeners.add(l);
      return () => credListeners.delete(l);
    },
    getSnapshot: (): Record<string, CredentialView | undefined> => credentialsFace.views,
    refresh: async (): Promise<void> => {
      const refs = CREDENTIALS.map((c) => c.ref);
      try {
        const res = await api.credentials.describe({ refs }, AbortSignal.timeout(8000));
        if (res.result.ok) {
          credentialsFace.views = res.result.value.credentials;
          credNotify(); // C11：视图引用替换后通知订阅者
        }
      } catch {
        /* 连接问题：保持旧视图 */
      }
    },
    set: async (ref: string, value: string): Promise<void> => {
      const res = await api.credentials.set({ ref, value }, AbortSignal.timeout(8000));
      if (!res.result.ok) throw new Error(res.result.error.message + ` (${res.result.error.code})`);
      await credentialsFace.refresh();
    },
    unset: async (ref: string): Promise<void> => {
      const res = await api.credentials.unset({ ref }, AbortSignal.timeout(8000));
      if (!res.result.ok) throw new Error(res.result.error.message + ` (${res.result.error.code})`);
      await credentialsFace.refresh();
    },
  };
  void credentialsFace.refresh();

  // —— settings scopes（引擎插件 namespaces 的浏览器端视图）——
  const scopes = new Map<string, FetchScope>();
  for (const ns of FEATURE_NAMESPACES) {
    scopes.set(ns, makeFetchScope(ns, settingsApi));
  }

  return { settingsApi, role: roleFace, credentials: credentialsFace, scopes };
}

/**
 * 基于同源 HTTP 端点的 SettingsScope 适配实现（浏览器端）
 * —— dsh 的 ctx.settingsScope.bind 走 api-proxy settings.* RPC（allowlist 限制），
 * 这里用自定义端点替代：read 拉快照，set/unset 写 patch。
 */
function makeFetchScope(
  ns: string,
  api: SettingsBridge,
): FetchScope {
  type Snapshot = SettingsScopeSnapshot<Record<string, unknown>>;
  let snap: Snapshot = {
    status: 'loading',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: true,
    mode: 'host',
  };
  const listeners = new Set<() => void>();
  const publish = (): void => {
    for (const l of listeners) l();
  };
  const load = async (): Promise<void> => {
    try {
      const all = await api.read();
      snap = {
        ...snap,
        status: 'ready',
        value: (all[ns] as Record<string, unknown> | undefined) ?? undefined,
        revision: (snap.revision ?? 0) + 1,
      };
    } catch {
      snap = { ...snap, status: 'unavailable', value: undefined };
    }
    publish();
  };
  void load();
  // C14：写串行化——快速连点开关时按调用顺序落地（SettingsScope 契约要求
  // 有序；HTTP 并发 POST 到达 host 的顺序无保证，必须前端排队）。
  let writeQueue: Promise<void> = Promise.resolve();
  const enqueueWrite = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    getSnapshot: () => snap,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    // M9：显式暴露 load（原实现未返回、调用方 as never 空转 → document-updated
    // 事件实际不刷新开关）。闭包箭头保证 this 绑定正确。
    load: (): Promise<void> => load(),
    set: async (field: string, value: unknown): Promise<void> => {
      await enqueueWrite(() => api.write(ns, { patch: { [field]: value } }));
      await load();
    },
    unset: async (field: string): Promise<void> => {
      // C14：原实现 { [field]: undefined } 会被 JSON.stringify 丢弃（清除永不生效）；
      // 改为显式 unset 列表，host 端走 settings.mutate({op:'unset'}) 删除字段
      await enqueueWrite(() => api.write(ns, { unset: [field] }));
      await load();
    },
  };
}
