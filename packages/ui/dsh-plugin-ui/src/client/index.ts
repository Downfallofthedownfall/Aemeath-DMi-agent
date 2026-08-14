// ============================================================
// dsh-plugin-ui · browser 半区入口（M5）
// 组装：爱弥斯主题 + 品牌层 + 设置界面（功能开关 + API key）
// 注册顺序：
//   1. 主题（ctx.theme.register）— 设置 → Appearance 可选
//   2. 品牌（document.title + sidebar.footer.action）
//   3. 设置页（settings.section）— 绑定引擎插件 settings namespaces
//      + ctx.remote.credentials 的 describe/set/unset
// ============================================================
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
import type { CredentialView, IApiClient } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import { registerThemes } from './theme.ts';
import { applyBrand } from './brand.tsx';
import { registerSettingsSection, FEATURES, CREDENTIALS } from './settings.tsx';
import { registerSessionList } from './sessions.tsx';
import { registerHero } from './hero.tsx';
import { registerTts } from './tts.tsx';

export const name = 'aemeath-ui';
export const inject = ['slots', 'theme', 'connection', 'remote', 'sessions', 'workspaces'];

// ===== 引擎插件 settings namespaces（与各引擎插件 installSettingsSection 注册名一致） =====
export const FEATURE_NAMESPACES = ['aemeath-common', 'aemeath-worldbook', 'aemeath-retriever', 'aemeath-memory', 'aemeath-workflow'];

export function apply(ctx: ClientContext): void {
  // 1) 主题（幂等）
  registerThemes(ctx as never);

  // 2) 品牌层
  applyBrand(ctx);

  // 2.5) 极简会话列表（shadow 官方 workspace 浏览器，去掉工作区/搜索/分组）
  registerSessionList(ctx);

  // 2.6) 爱弥斯开场白（替换 dsh hero「探索未至之境」）
  registerHero(ctx);

  // 2.7) TTS 朗读按钮（assistant 消息操作区）
  registerTts(ctx);

  // 3) 设置页
  // 注：settings namespaces 由引擎插件注册；浏览器读写走本插件 host 侧注册的
  // 同源端点 /aemeath/api/settings（dsh api-proxy 的 settings.* RPC 有 allowlist 限制）。
  const settingsApi = {
    read: async (): Promise<Record<string, unknown>> => {
      const res = await fetch('/aemeath/api/settings', { signal: AbortSignal.timeout(8000) });
      const data = (await res.json()) as { ok?: boolean; namespaces?: Record<string, unknown> };
      return data.namespaces ?? {};
    },
    write: async (ns: string, patch: Record<string, unknown>): Promise<void> => {
      const res = await fetch('/aemeath/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ns, patch }),
        signal: AbortSignal.timeout(8000),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `write failed (${res.status})`);
    },
  };

  // 凭据 face：describe/set/unset（值单向传输，永不回读明文）
  const connection = ctx.get('connection');
  const api: IApiClient = connection.api;

  // 角色模式 face：读当前默认角色 + 切换（写 agent-presets.default）
  // 可订阅（listeners + notify）：set 后触发 React 重渲染（否则按钮"点了没反应"）
  const roleFace = {
    current: 'aemeath',
    listeners: new Set<() => void>(),
    subscribe: (l: () => void): (() => void) => {
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
      await settingsApi.write('agent-presets', { default: role });
      roleFace.current = role;
      roleFace.notify();
    },
  };
  void roleFace.refresh();

  const credentialsFace = {
    views: {} as Record<string, CredentialView | undefined>,
    refresh: async (): Promise<void> => {
      const refs = CREDENTIALS.map((c) => c.ref);
      try {
        const res = await api.credentials.describe({ refs }, AbortSignal.timeout(8000));
        if (res.result.ok) credentialsFace.views = res.result.value.credentials;
      } catch {
        /* 连接问题：保持旧视图 */
      }
    },
    set: async (ref: string, value: string): Promise<void> => {
      const res = await api.credentials.set({ ref, value }, AbortSignal.timeout(8000));
      if (!res.result.ok) throw new Error(res.result.error.message + ` (${res.result.error.code})`);
    },
    unset: async (ref: string): Promise<void> => {
      const res = await api.credentials.unset({ ref }, AbortSignal.timeout(8000));
      if (!res.result.ok) throw new Error(res.result.error.message + ` (${res.result.error.code})`);
    },
  };

  // 设置页 scope 视图：读/写经 settingsApi 转发
  const scopes = new Map<string, SettingsScope<Record<string, unknown>>>();
  for (const ns of FEATURE_NAMESPACES) {
    scopes.set(ns, makeFetchScope(ns, settingsApi));
  }

  registerSettingsSection(ctx, {
    scopes: () => Object.fromEntries(scopes),
    credentials: () => ({
      views: credentialsFace.views,
      refresh: () => void credentialsFace.refresh(),
      set: credentialsFace.set,
      unset: credentialsFace.unset,
    }),
    role: () => ({
      subscribe: roleFace.subscribe,
      getSnapshot: roleFace.getSnapshot,
      set: roleFace.set,
    }),
  });

  // 首次拉取凭据状态（设置页打开时也会刷新）
  void credentialsFace.refresh();

  // 订阅凭据更新事件（其他来源写入后同步徽章）
  const remote = ctx.remote;
  ctx.effect(() =>
    remote.$on('credentials/updated', () => {
      void credentialsFace.refresh();
    }),
  );

  // 订阅设置文档更新（外部编辑 settings.yaml 后同步开关）
  ctx.effect(() =>
    remote.$on('settings/document-updated', () => {
      for (const scope of scopes.values()) {
        try {
          void (scope as unknown as { load?: () => Promise<void> }).load?.();
        } catch {
          /* ignore */
        }
      }
    }),
  );

  // 暴露给测试/检查脚本（cordis ctx 为代理对象，不可直接 setProperty）
  void FEATURES;
}

/**
 * 基于同源 HTTP 端点的 SettingsScope 适配实现（浏览器端）
 * —— dsh 的 ctx.settingsScope.bind 走 api-proxy settings.* RPC（allowlist 限制），
 * 这里用自定义端点替代：read 拉快照，set/unset 写 patch。
 */
function makeFetchScope(
  ns: string,
  api: { read(): Promise<Record<string, unknown>>; write(ns: string, patch: Record<string, unknown>): Promise<void> },
): SettingsScope<Record<string, unknown>> {
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
  return {
    getSnapshot: () => snap,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set: async (field: string, value: unknown): Promise<void> => {
      await api.write(ns, { [field]: value });
      await load();
    },
    unset: async (field: string): Promise<void> => {
      await api.write(ns, { [field]: undefined });
      await load();
    },
  } as unknown as SettingsScope<Record<string, unknown>>;
}
