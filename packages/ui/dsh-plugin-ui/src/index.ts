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
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { settingsNamespace, installSettingsSection } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-settings';

export const name = 'aemeath-ui';
export const inject = ['webServer', 'settings', 'memory'];

/** 无工作区时的自动兜底工作区：项目内空文件夹（打开即聊，用户无需选择）。 */
export const DEFAULT_WORKSPACE_DIR = '.chat';

/** 本插件管理的 settings namespaces（与引擎插件注册名一致）。 */
export const FEATURE_NAMESPACES = ['aemeath-common', 'aemeath-worldbook', 'aemeath-retriever', 'aemeath-memory', 'aemeath-workflow', 'aemeath-tts'];

/** 允许前端切换默认角色的 settings namespace（dsh 官方 agent-presets）。 */
export const AGENT_PRESET_NAMESPACE = 'agent-presets';

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/**
 * 写请求来源校验（S3 修复）：本插件的端点只服务同源前端（dsh web server 页面
 * fetch 相对路径），不再发任何 CORS 头。为防恶意网页经 no-cors/DNS rebinding
 * 发起的跨源 POST（浏览器仍会发出简单请求，只是读不到响应），对带 Origin 的
 * 写请求要求其 host 必须是回环地址。无 Origin（curl/非浏览器/同源 GET）放行。
 */
function isLoopbackHostname(host: string): boolean {
  const h = (host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0';
}

function checkWriteOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // 无 Origin（非浏览器客户端）放行
  if (origin === 'null') return false; // file:// / sandbox iframe：拒绝
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false; // 非法 Origin 拒绝
  }
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB：settings/记忆写入均为小 body，超限直接拒绝（防 DoS）

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let done = false;
    const fail = (code: number, msg: string): void => {
      if (done) return;
      done = true;
      const err = new Error(msg) as Error & { status?: number };
      err.status = code;
      reject(err);
    };
    req.on('data', (c: Buffer | string) => {
      if (done) return;
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(413, 'body too large (max 1MB)');
        req.destroy();
        return;
      }
      body += c;
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(body);
    });
    req.on('error', (e) => fail(400, (e as Error).message));
  });
}

export function apply(ctx: Context): void {
  const settings = ctx.settings;
  const webServer = ctx.webServer;

  // —— UI 改造 P1：默认亮色迁移（决策 Q1：默认亮色，深色仅设置页可选）——
  // 持久化偏好为 dark/system/缺失时 → 迁移为 light，避免每次启动先闪暗色；
  // 插件侧（theme.ts）再把 light → aemeath（金强调亮色）。
  // 用户若在设置页显式选过 aemeath/physicist，此处不覆盖。
  void (async () => {
    try {
      const themeNs = settingsNamespace('ui-theme');
      const cur = settings.get(themeNs) as { preference?: string } | undefined;
      const pref = cur?.preference;
      if (!pref || pref === 'dark' || pref === 'system') {
        await settings.update(themeNs, { preference: 'light' });
        console.log(`[aemeath-ui] ui-theme.preference → light（${pref ? '原 ' + pref : '缺省'}，默认亮色）`);
      }
    } catch (e) {
      // settings 未就绪：忽略，下次启动再迁移
      console.warn('[aemeath-ui] 主题偏好迁移失败（可忽略）:', (e as Error).message);
    }
  })();

  // memory 服务（host 侧运行时提供；类型用结构断言）
  const memory = ctx.get('memory') as unknown as {
    list(): Array<{ key: string; rec: Record<string, unknown> }>;
    stats(): { active: number; dormant: number; byPreset: Record<string, number>; byScope: Record<string, number> };
    softDelete(idPrefix: string): Promise<boolean>;
    /** L1 采集缓冲（滚动对话，待总结）：会话列表 + 各会话轮次（2026-08-17 面板暴露）。 */
    l1Sessions?(): string[];
    l1Turns?(sid: string): Array<{ query?: string; reply?: string; kind?: string; ts?: number; preset?: string }>;
    l1CapacityOf?(): { capacity: number; threshold: number };
  } | undefined;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 无 CORS 头：端点仅服务同源前端（S3 修复；跨源读取/写入由浏览器同源策略拦截）
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
        if (!checkWriteOrigin(req)) return json(res, 403, { ok: false, error: 'cross-origin write denied' });
        const raw = await readBody(req);
        // C14：写请求支持 {ns, patch?}（合并）与 {ns, unset?: string[]}（删除字段——
        // 合并 patch 无法表达"删除"，旧实现 { [field]: undefined } 经 JSON 序列化即丢失）
        const parsed = JSON.parse(raw || '{}') as { ns?: unknown; patch?: unknown; unset?: unknown };
        if (typeof parsed.ns !== 'string') {
          return json(res, 400, { ok: false, error: 'body requires {ns: string}' });
        }
        const patchOk = typeof parsed.patch === 'object' && parsed.patch !== null && !Array.isArray(parsed.patch);
        const unsetOk = Array.isArray(parsed.unset) && parsed.unset.every((f) => typeof f === 'string') && parsed.unset.length > 0;
        if (!patchOk && !unsetOk) {
          return json(res, 400, { ok: false, error: 'body requires {patch: object} and/or {unset: string[]}' });
        }
        // 允许写 agent-presets.default（角色模式切换）；其余限 aemeath-* 白名单
        if (parsed.ns === AGENT_PRESET_NAMESPACE) {
          if (!patchOk) return json(res, 400, { ok: false, error: 'agent-presets only supports patch (no unset)' });
          const patch = parsed.patch as Record<string, unknown>;
          if (typeof patch.default !== 'string') return json(res, 400, { ok: false, error: 'agent-presets patch requires {default: string}' });
          if (!['aemeath', 'physicist'].includes(patch.default)) return json(res, 400, { ok: false, error: `unsupported role: ${patch.default}` });
          await settings.update(settingsNamespace(AGENT_PRESET_NAMESPACE), { default: patch.default });
          json(res, 200, { ok: true });
          return;
        }
        if (!FEATURE_NAMESPACES.includes(parsed.ns)) return json(res, 403, { ok: false, error: `namespace not managed by aemeath-ui: ${parsed.ns}` });
        const nsKey = settingsNamespace(parsed.ns);
        if (unsetOk) {
          // 删除字段 → settings.mutate 的 {op:'unset'}（恢复 base/默认，而非置值）
          await settings.mutate(
            nsKey,
            (parsed.unset as string[]).map((f) => ({ op: 'unset', path: [f] })),
          );
        }
        if (patchOk) {
          await settings.update(nsKey, parsed.patch as Record<string, unknown>);
        }
        json(res, 200, { ok: true });
      } catch (e) {
        const err = e as Error & { status?: number };
        json(res, err.status ?? 400, { ok: false, error: err.message });
      }
      return;
    }

    json(res, 405, { ok: false, error: 'method not allowed' });
  };

  // —— TTS 设置 namespace（2026-08-17：前端「朗读」开关，settings.yaml 持久化）——
  // 引擎侧无行为（合成在 tts HTTP 服务），仅承载 enabled 开关供前端门控。
  installSettingsSection(
    ctx,
    settingsNamespace('aemeath-tts'),
    z.object({ enabled: z.boolean(), volume: z.number() }),
    { enabled: false, volume: 1 },
    {
      setSource: () => undefined,
      onChange: () => undefined,
    },
  );
  // 2026-08-17：TTS 每次启动强制关闭（用户要求"启动时永远显示未开启"）——
  // 会话内可开启，重启后回到关闭态。注意：apply 早期 settings 可能未就绪，
  // update 会静默 reject，故延迟 500ms 启动并失败重试。
  let ttsResetAttempts = 0;
  const resetTtsAtBoot = (): void => {
    if (ttsResetAttempts > 10) return;
    ttsResetAttempts++;
    settings
      .update(settingsNamespace('aemeath-tts'), { enabled: false })
      .then(() => console.log('[aemeath-ui] aemeath-tts 已重置为关闭（启动默认）'))
      .catch(() => {
        setTimeout(resetTtsAtBoot, 1000);
      });
  };
  setTimeout(resetTtsAtBoot, 500);
  console.log('[aemeath-ui] aemeath-tts 设置 namespace 已注册');

  // —— TTS 后端（IndexTTS2）：懒启动 tts HTTP 服务 + 代理端点 ——
  // 2026-08-17：Electron 渲染器 Web Speech API 无系统语音（getVoices()=0，speak 无声），
  // 前端朗读改走本端点 → packages/py-services/tts_mcp/server.py --http（共享 IndexTTS2 模型）。
  const TTS_HTTP_PORT = 18896;
  const TTS_HTTP_BASE = `http://127.0.0.1:${TTS_HTTP_PORT}`;
  let ttsProc: ChildProcess | null = null;
  let ttsReadyPromise: Promise<boolean> | null = null;

  const ttsPythonPath = (): string => {
    const env = process.env.AEMEATH_TTS_PYTHON;
    if (env && existsSync(env)) return env;
    const def = 'D:\\index-tts\\.venv\\Scripts\\python.exe';
    return existsSync(def) ? def : 'python';
  };

  /** 配置状态（供前端"未配置弹提示"与 /tts/status）。 */
  const ttsConfigStatus = (): { configured: boolean; pythonExists: boolean; modelConfigExists: boolean; voiceCount: number; python: string; modelDir: string } => {
    const py = process.env.AEMEATH_TTS_PYTHON ?? 'D:\\index-tts\\.venv\\Scripts\\python.exe';
    const modelDir = process.env.AEMEATH_TTS_MODEL_DIR ?? 'D:\\index-tts';
    const pythonExists = existsSync(py);
    const modelConfigExists = existsSync(join(modelDir, 'checkpoints', 'config.yaml'));
    let voiceCount = 0;
    try {
      const voicesDir = join(process.cwd(), 'voices');
      if (existsSync(voicesDir)) voiceCount = readdirSync(voicesDir).filter((f) => f.toLowerCase().endsWith('.wav')).length;
    } catch { /* ignore */ }
    return { configured: pythonExists && modelConfigExists && voiceCount > 0, pythonExists, modelConfigExists, voiceCount, python: py, modelDir };
  };

  const ttsSettingsEnabled = (): boolean => {
    try {
      const v = settings.get(settingsNamespace('aemeath-tts')) as { enabled?: boolean } | undefined;
      return v?.enabled ?? false; // 2026-08-17：默认关闭（开关初始为关）
    } catch {
      return false;
    }
  };

  /** 懒启动 tts HTTP 服务（幂等；先探已有实例，无则 spawn）。 */
  const ensureTtsServer = (): Promise<boolean> => {
    if (ttsReadyPromise) return ttsReadyPromise;
    ttsReadyPromise = (async () => {
      // 已有实例（外部启动/上次残留）→ 直接复用
      for (let i = 0; i < 10; i++) {
        try {
          const r = await fetch(`${TTS_HTTP_BASE}/health`, { signal: AbortSignal.timeout(800) });
          if (r.ok) {
            console.log('[aemeath-ui] 复用已有 tts HTTP 服务');
            return true;
          }
        } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      const serverPath = join(process.cwd(), 'packages', 'py-services', 'tts_mcp', 'server.py');
      const py = ttsPythonPath();
      console.log(`[aemeath-ui] 启动 tts HTTP 服务（${py} --http ${TTS_HTTP_PORT}）…`);
      const proc = spawn(py, [serverPath, '--http', String(TTS_HTTP_PORT)], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      ttsProc = proc;
      proc.stdout.on('data', (d) => console.log('[tts-http]', String(d).trim()));
      proc.stderr.on('data', (d) => console.log('[tts-http]', String(d).trim()));
      proc.on('exit', (code) => {
        ttsProc = null;
        ttsReadyPromise = null;
        console.log(`[aemeath-ui] tts HTTP 服务已退出（${code}）`);
      });
      proc.on('error', (e) => {
        console.error('[aemeath-ui] tts HTTP 服务启动失败:', e.message);
        ttsReadyPromise = null;
      });
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(`${TTS_HTTP_BASE}/health`, { signal: AbortSignal.timeout(800) });
          if (r.ok) {
            console.log('[aemeath-ui] tts HTTP 服务就绪');
            return true;
          }
        } catch { /* wait */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
      console.error('[aemeath-ui] tts HTTP 服务 60s 未就绪');
      return false;
    })();
    return ttsReadyPromise;
  };

  // GET /aemeath/api/tts/status —— 配置状态（前端开启开关/点击朗读前检查，未配置弹提示）
  async function handleTtsStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    json(res, 200, { ok: true, ...ttsConfigStatus() });
  }

  // POST /aemeath/api/tts —— 合成并返回 base64 wav（前端直接播放）
  async function handleTts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!checkWriteOrigin(req)) return json(res, 403, { ok: false, error: 'cross-origin write denied' });
      if (!ttsSettingsEnabled()) return json(res, 400, { ok: false, error: '语音朗读已关闭（设置 → 语音朗读）' });
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || '{}') as { text?: unknown };
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      console.log(`[aemeath-ui] TTS 合成请求收到 text="${text.slice(0, 60)}" enabled=${ttsSettingsEnabled()}`);
      if (!text) return json(res, 400, { ok: false, error: 'text required' });
      if (text.length > 500) return json(res, 400, { ok: false, error: `text 过长（${text.length} 字，上限 500）` });
      const cfg = ttsConfigStatus();
      if (!cfg.configured) {
        return json(res, 500, {
          ok: false,
          error: `未配置 TTS 引擎（python=${cfg.pythonExists} model=${cfg.modelConfigExists} voice=${cfg.voiceCount}）。请安装 IndexTTS2 到 D:\\index-tts 或设置 AEMEATH_TTS_PYTHON / AEMEATH_TTS_MODEL_DIR`,
        });
      }
      if (!(await ensureTtsServer())) return json(res, 500, { ok: false, error: 'TTS 服务启动失败' });
      const r = await fetch(`${TTS_HTTP_BASE}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        // 首次调用加载 3.4GB 模型，允许 1-3 分钟
        signal: AbortSignal.timeout(200000),
      });
      const d = (await r.json()) as { success?: boolean; audio_base64?: string; size_bytes?: number; error?: string };
      console.log(`[aemeath-ui] TTS 合成结果: HTTP ${r.status} success=${d.success} size=${d.size_bytes ?? 0} error=${d.error ?? ''}`);
      if (!r.ok || !d.success || !d.audio_base64) return json(res, 500, { ok: false, error: d.error ?? `合成失败（${r.status}）` });
      json(res, 200, { ok: true, audio_base64: d.audio_base64, size_bytes: d.size_bytes ?? 0 });
    } catch (e) {
      json(res, 500, { ok: false, error: (e as Error).message });
    }
  }

  // POST /aemeath/api/tts/warmup —— 懒加载预热（仅加载模型，不合成；前端弹 99% 进度条）
  // 注意：不在 enabled 门控内——前端「开启开关」流程是"先预热、后置 enabled"，
  // 若此处检查 enabled 会把预热拒掉（开关还关着）→ 前端误报加载失败（2026-08-17 修复）。
  async function handleTtsWarmup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!checkWriteOrigin(req)) return json(res, 403, { ok: false, error: 'cross-origin write denied' });
      if (!(await ensureTtsServer())) return json(res, 500, { ok: false, error: 'TTS 服务启动失败' });
      const r = await fetch(`${TTS_HTTP_BASE}/warmup`, {
        method: 'POST',
        // 模型加载 1-3 分钟
        signal: AbortSignal.timeout(240000),
      });
      const d = (await r.json()) as { ok?: boolean; model_loaded?: boolean; error?: string };
      if (!r.ok || !d.ok) return json(res, 500, { ok: false, error: d.error ?? `模型加载失败（${r.status}）` });
      json(res, 200, { ok: true, model_loaded: !!d.model_loaded });
    } catch (e) {
      json(res, 500, { ok: false, error: (e as Error).message });
    }
  }

  ctx.effect(() => () => {
    if (ttsProc) {
      try {
        ttsProc.kill();
      } catch { /* ignore */ }
      ttsProc = null;
    }
  });

  // 注册路由（精确路径，含尾部斜杠变体）
  const disposers = [
    webServer.register({ kind: 'exact', path: '/aemeath/api/settings', handler: handle }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/settings/', handler: handle }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/memory', handler: handleMemory }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/memory/', handler: handleMemory }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/boot-info', handler: handleBootInfo }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/boot-info/', handler: handleBootInfo }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/tts', handler: handleTts }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/tts/', handler: handleTts }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/tts/warmup', handler: handleTtsWarmup }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/tts/warmup/', handler: handleTtsWarmup }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/tts/status', handler: handleTtsStatus }),
    webServer.register({ kind: 'exact', path: '/aemeath/api/tts/status/', handler: handleTtsStatus }),
  ];
  ctx.effect(() => () => disposers.forEach((d) => d()));
  console.log('[aemeath-ui] 设置端点已注册: GET/POST /aemeath/api/settings');

  // —— 启动信息端点（M5 P3.5）：暴露默认兜底工作区路径（项目内空文件夹 .chat）——
  // 前端在「零工作区」时据此自动挂载，实现"打开即聊、无需选择工作区"。
  async function handleBootInfo(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    try {
      const defaultWorkspacePath = join(process.cwd(), DEFAULT_WORKSPACE_DIR);
      mkdirSync(defaultWorkspacePath, { recursive: true }); // 确保空文件夹存在（幂等）
      json(res, 200, { ok: true, defaultWorkspacePath });
    } catch (e) {
      json(res, 500, { ok: false, error: (e as Error).message });
    }
  }

  // —— 记忆管理端点（M5 F2）：GET list/stats + POST delete（无 CORS；POST 校验 Origin）——
  async function handleMemory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!memory) {
      json(res, 503, { ok: false, error: 'memory service unavailable' });
      return;
    }
    try {
      if (req.method === 'GET') {
        const items = memory.list().map(({ key, rec }) => ({
          id: key,
          content: String(rec.content ?? '').slice(0, 200),
          category: rec.category ?? 'session_summary',
          importance: typeof rec.importance === 'number' ? rec.importance : 0,
          scope: rec.scope ?? 'mode',
          preset: rec.preset ?? '',
          status: rec.status ?? 'active',
          created_at: rec.created_at ?? 0,
        }));
        const stats = memory.stats();
        // L1 scratch（会话内暂存）+ L2 mode + L3 global 分组
        const scratch = (memory as unknown as { allScratch?: () => Record<string, Record<string, string>> }).allScratch?.() ?? {};
        const l1 = Object.entries(scratch).map(([sid, slot]) => ({
          sessionId: sid,
          items: Object.entries(slot).map(([k, v]) => ({ key: k, content: String(v).slice(0, 200) })),
        })).filter((s) => s.items.length > 0);
        // L1 采集缓冲（滚动对话，待总结）——与 scratch 工作态区分，面板可见"攒批中"的内容
        const l1Buffer = (memory.l1Sessions?.() ?? []).map((sid) => ({
          sessionId: sid,
          turns: (memory.l1Turns?.(sid) ?? []).map((t) => ({
            query: String(t.query ?? '').slice(0, 200),
            reply: String(t.reply ?? '').slice(0, 200),
            kind: t.kind ?? 'fact',
            ts: t.ts ?? 0,
          })),
        })).filter((s) => s.turns.length > 0);
        const l2 = items.filter((m) => m.scope === 'mode');
        const l3 = items.filter((m) => m.scope === 'global');
        json(res, 200, { ok: true, l1, l2, l3, stats, l1Buffer, l1Capacity: memory.l1CapacityOf?.() ?? null });
        return;
      }
      if (req.method === 'POST') {
        if (!checkWriteOrigin(req)) return json(res, 403, { ok: false, error: 'cross-origin write denied' });
        const raw = await readBody(req);
        const parsed = JSON.parse(raw || '{}') as { idPrefix?: string };
        if (!parsed.idPrefix) {
          json(res, 400, { ok: false, error: 'idPrefix required' });
          return;
        }
        const removed = await memory.softDelete(parsed.idPrefix);
        json(res, 200, { ok: true, removed });
        return;
      }
      json(res, 405, { ok: false, error: 'method not allowed' });
    } catch (e) {
      const err = e as Error & { status?: number };
      json(res, err.status ?? 400, { ok: false, error: err.message });
    }
  }
}
