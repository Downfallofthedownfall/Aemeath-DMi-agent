// ============================================================
// dsh-plugin-ui · Aemeath 前端 UI 插件（M5）
// host 侧职责：
//   1. 注册同源 HTTP 端点 /aemeath/api/settings（GET 读 / POST 写），
//      桥接前端设置界面 ↔ ctx.settings namespaces。
//      为什么自建端点：dsh api-proxy 的 settings.* RPC 有硬编码 allowlist
//      （WEB_SETTINGS_NAMESPACES + model providers + PRODUCT），
//      浏览器无法直接读写 aemeath-* namespaces；host 侧 ctx.settings 无此限制。
//   2. browser 半区经 exports["./client"] + package.json dsh.client 声明进入
//      window.__DSH_BOOT__（主题/品牌/设置界面）。
// 数据流：前端 fetch GET /aemeath/api/settings → 各 namespace 当前值；
//         POST {ns, patch} → ctx.settings.update → settings.yaml 持久化
//         → 引擎插件 installSettingsSection watch 实时生效。
// ============================================================
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-settings';

export const name = 'aemeath-ui';
export const inject = ['webServer', 'settings'];

/** 本插件管理的 settings namespaces（与引擎插件注册名一致）。 */
export const FEATURE_NAMESPACES = ['aemeath-common', 'aemeath-worldbook', 'aemeath-retriever', 'aemeath-memory', 'aemeath-workflow'];

/** 允许前端切换默认角色的 settings namespace（dsh 官方 agent-presets）。 */
export const AGENT_PRESET_NAMESPACE = 'agent-presets';

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function apply(ctx: Context): void {
  const settings = ctx.settings;
  const webServer = ctx.webServer;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // CORS（同源 3081 下一般不需要，但为 Electron/开发端口留口）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      // 读：返回每个 namespace 的 resolved 值（引擎插件注册后可用）+ agent-presets 默认
      const out: Record<string, unknown> = {};
      for (const ns of FEATURE_NAMESPACES) {
        try {
          const value = settings.get(settingsNamespace(ns));
          if (value !== undefined) out[ns] = value;
        } catch {
          /* namespace 未注册：跳过 */
        }
      }
      try {
        const ap = settings.get(settingsNamespace(AGENT_PRESET_NAMESPACE)) as { default?: string } | undefined;
        if (ap?.default) out[AGENT_PRESET_NAMESPACE] = ap.default;
      } catch {
        /* ignore */
      }
      json(res, 200, { ok: true, namespaces: out });
      return;
    }

    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const parsed = JSON.parse(raw || '{}') as { ns?: unknown; patch?: unknown };
        if (typeof parsed.ns !== 'string' || typeof parsed.patch !== 'object' || parsed.patch === null || Array.isArray(parsed.patch)) {
          return json(res, 400, { ok: false, error: 'body requires {ns: string, patch: object}' });
        }
        // 允许写 agent-presets.default（角色模式切换）；其余限 aemeath-* 白名单
        if (parsed.ns === AGENT_PRESET_NAMESPACE) {
          const patch = parsed.patch as Record<string, unknown>;
          if (typeof patch.default !== 'string') return json(res, 400, { ok: false, error: 'agent-presets patch requires {default: string}' });
          if (!['aemeath', 'scholar'].includes(patch.default)) return json(res, 400, { ok: false, error: `unsupported role: ${patch.default}` });
          await settings.update(settingsNamespace(AGENT_PRESET_NAMESPACE), { default: patch.default });
          json(res, 200, { ok: true });
          return;
        }
        if (!FEATURE_NAMESPACES.includes(parsed.ns)) return json(res, 403, { ok: false, error: `namespace not managed by aemeath-ui: ${parsed.ns}` });
        await settings.update(settingsNamespace(parsed.ns), parsed.patch as Record<string, unknown>);
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 400, { ok: false, error: (e as Error).message });
      }
      return;
    }

    json(res, 405, { ok: false, error: 'method not allowed' });
  };

  // 注册路由（精确路径，含尾部斜杠变体）
  const disposers = [
    webServer.register({ kind: 'exact', path: '/aemeath/api/settings', handler: handle }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/settings/', handler: handle }),
  ];
  ctx.effect(() => () => disposers.forEach((d) => d()));
  console.log('[aemeath-ui] 设置端点已注册: GET/POST /aemeath/api/settings');
}
