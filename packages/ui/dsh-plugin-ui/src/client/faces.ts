// ============================================================
// faces.ts —— 数据 face 工厂（UI 改造 P2）
// 把 apply() 里散落的 settings/role/credentials/scopes 抽成可复用模块：
//   侧边栏（sidebar.tsx）、快速设置（quick-settings.tsx）、设置页（settings.tsx）
// 数据流：前端 fetch GET/POST /aemeath/api/settings（host 桥，避开 api-proxy allowlist）
//         → ctx.settings → settings.yaml → 引擎插件 watch 实时生效。
// ============================================================
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import { FEATURE_NAMESPACES } from './constants.ts';
import { CREDENTIALS } from './settings.tsx';

/**
 * RemoteResult 的最小结构断言（避免强依赖 dsh-typert-protocol 的具体导出）。
 * 与 0.2.0 的 `RemoteResult<T>` 同形：ok=true 带 value，否则带 error。
 */
type RemoteLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

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
  views: Record<string, CredentialInfo | undefined>;
  refresh(): Promise<void>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
  /** 订阅视图变化（refresh/set/unset 后通知）。 */
  subscribe(l: () => void): () => void;
  getSnapshot(): Record<string, CredentialInfo | undefined>;
}

/**
 * 前端 settings scope 快照（DSH 0.2.0）。
 *
 * 0.1.1 的 `SettingsScope`/`SettingsScopeSnapshot` 随 dsh-client-runtime 一起
 * 移除了；0.2.0 官方改由 `SettingsDescribeMirror`（settings.describe 共享读）
 * 承担跨命名空间读取，写走 `remote.settings.update/mutate`。本插件本就用自建
 * 同源 HTTP 桥（/aemeath/api/settings）绕开 api-proxy allowlist，故这里只保留
 * 自有的最小快照形状，不再依赖平台类型。
 */
export interface ScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable';
  value: Record<string, unknown> | undefined;
  revision: number | undefined;
  writable: boolean;
  mode: 'host';
}

/** 本插件自有的 settings scope（读/订阅/写全走同源 HTTP 桥）。 */
export interface FetchScope {
  getSnapshot(): ScopeSnapshot;
  subscribe(l: () => void): () => void;
  load(): Promise<void>;
  set(field: string, value: unknown): Promise<void>;
  unset(field: string): Promise<void>;
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
  // DSH 0.2.0：credentials 不再挂在 connection.api（IApiClient 已随
  // dsh-host-apiproxy / dsh-client-runtime 移除），改为 Typert remote 命名空间
  // `ctx.remote.credentials`；参数由对象改为位置参数，返回 RemoteResult<T>
  // （成功取 .value，失败取 .error，与旧 RpcResult 同形）。
  const remote = (
    ctx as unknown as {
      remote?: {
        credentials?: {
          describe(refs: string[]): Promise<RemoteLike<Record<string, CredentialInfo>>>;
          set(ref: string, value: string): Promise<RemoteLike<void>>;
          unset(ref: string): Promise<RemoteLike<void>>;
        };
      };
    }
  ).remote;
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
    getSnapshot: (): Record<string, CredentialInfo | undefined> => credentialsFace.views,
    refresh: async (): Promise<void> => {
      const refs = CREDENTIALS.map((c) => c.ref);
      try {
        const creds = remote?.credentials;
        if (!creds) return; // remote 命名空间未挂载：保持旧视图
        const res = await creds.describe(refs);
        if (res.ok) {
          credentialsFace.views = res.value;
          credNotify(); // C11：视图引用替换后通知订阅者
        }
      } catch {
        /* 连接问题：保持旧视图 */
      }
    },
    set: async (ref: string, value: string): Promise<void> => {
      const creds = remote?.credentials;
      if (!creds) throw new Error('credentials remote unavailable');
      const res = await creds.set(ref, value);
      if (!res.ok) throw new Error(res.error.message + ` (${res.error.code})`);
      await credentialsFace.refresh();
    },
    unset: async (ref: string): Promise<void> => {
      const creds = remote?.credentials;
      if (!creds) throw new Error('credentials remote unavailable');
      const res = await creds.unset(ref);
      if (!res.ok) throw new Error(res.error.message + ` (${res.error.code})`);
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
 * 基于同源 HTTP 端点的 settings scope 适配实现（浏览器端）
 * —— dsh 的 settings RPC 有 api-proxy allowlist 限制，这里用自定义端点替代：
 * read 拉快照，set/unset 写 patch。
 */
function makeFetchScope(
  ns: string,
  api: SettingsBridge,
): FetchScope {
  let snap: ScopeSnapshot = {
    status: 'loading',
    value: undefined,
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
