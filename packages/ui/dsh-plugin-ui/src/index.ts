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
import { readSetting, registerVolatileSettings } from '@aemeath/dsh-plugin-common';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import { buildMemoryOverview, buildTimelineView, buildGraphView, type MemoryServiceFace } from './memory-view.js';

export const name = 'aemeath-ui';
export const inject = ['webServer', 'settings', 'memory'];

/**
 * DSH 0.2.0：settings 不再由插件「注册命名空间」，而是把可编辑字段声明为插件
 * 自己 Config 上的 volatile 引用；框架据此生成设置页并写回 profile patch。
 *
 * 本插件原先注册了两个命名空间（aemeath-ui / aemeath-tts）。0.2.0 下一个插件
 * 只有一个 Config，命名空间 = profile 条目 id = 'aemeath-ui'；因此把 tts 的
 * 两个字段也并入本 Config（tts 引擎侧本来就无行为，只承载前端开关）。
 */
export const Config = z.object({
  /** 前端上报的 active locale（语言指令注入读它）。 */
  locale: z.string().default('').volatile(),
  /** 前端「朗读」开关（2026-08-17：启动时强制关闭，会话内可开启）。 */
  ttsEnabled: z.boolean().default(false).volatile(),
  /** 朗读音量。 */
  ttsVolume: z.number().default(1).volatile(),
});

export interface UiConfig {
  locale?: { get?: () => string };
  ttsEnabled?: { get?: () => boolean };
  ttsVolume?: { get?: () => number };
}

/** 无工作区时的自动兜底工作区：项目内空文件夹（打开即聊，用户无需选择）。 */
export const DEFAULT_WORKSPACE_DIR = '.chat';

/** 本插件管理的 settings namespaces（与引擎插件注册名一致）。 */
export const FEATURE_NAMESPACES = ['aemeath-common', 'aemeath-worldbook', 'aemeath-retriever', 'aemeath-memory', 'aemeath-workflow', 'aemeath-tts', 'aemeath-ui'];

/** 前端上报的 UI locale 所在 namespace/字段（语言指令注入读它）。 */
export const UI_LOCALE_NAMESPACE = 'aemeath-ui';
export const UI_LOCALE_FIELD = 'locale';

/** 允许前端切换默认角色的 settings namespace（DSH 0.2.0 行 id：agent-preset-registry）。 */
export const AGENT_PRESET_NAMESPACE = 'agent-preset-registry';

/**
 * DSH 0.2.0：前端沿用的「命名空间 → 字段」旧约定需要在 host 侧重映射，因为
 * 现在一个插件只有一个 Config（命名空间 = profile 条目 id）。
 *   - 'aemeath-tts' 的 enabled/volume 并入了本插件的 Config（字段 ttsEnabled/ttsVolume）
 *   - 'aemeath-ui' 的 locale 直接同名
 */
const FEATURE_NAMESPACE_ENTRY: Record<string, string> = {
  'aemeath-tts': 'aemeath-ui',
};
const FEATURE_NAMESPACE_FIELD_MAP: Record<string, Record<string, string>> = {
  'aemeath-tts': { enabled: 'ttsEnabled', volume: 'ttsVolume' },
};

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 读取前端上报的 UI locale（zh/en/''）——供 host 侧逻辑（如 TTS lang）使用。 */
function hostUiLocale(ctx: Context): string {
  try {
    const v = readSetting(ctx, UI_LOCALE_NAMESPACE);
    return v?.locale === 'en' ? 'en' : v?.locale === 'zh' ? 'zh' : '';
  } catch {
    return '';
  }
}

/**
 * 用户可见错误响应：返回稳定机器码 `code`（前端按 locale 映射文案）+ 中文 `error` 兜底。
 * 约定：code 是 i18n key `errors.<code>` 的后缀；前端无映射时回退 error 原文。
 */
function jsonError(res: ServerResponse, httpCode: number, code: string, fallback: string, extra?: Record<string, unknown>): void {
  json(res, httpCode, { ok: false, code, error: fallback, ...extra });
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

export function apply(ctx: Context, config: UiConfig = {}): void {
  const settings = ctx.settings;
  const webServer = ctx.webServer;
  // 归一化 volatile 引用（缺省时给出安全的静态回退；调用点无需再判空）。
  const uiConfig = {
    locale: { get: (): string => config.locale?.get?.() ?? '' },
    ttsEnabled: { get: (): boolean => config.ttsEnabled?.get?.() ?? false },
    ttsVolume: { get: (): number => config.ttsVolume?.get?.() ?? 1 },
  };

  // —— UI 改造 P1：默认亮色迁移（决策 Q1：默认亮色，深色仅设置页可选）——
  // 持久化偏好为 dark/system/缺失时 → 迁移为 light，避免每次启动先闪暗色；
  // 插件侧（theme.ts）再把 light → aemeath（金强调亮色）。
  // 用户若在设置页显式选过 aemeath/physicist，此处不覆盖。
  //
  // ⚠⚠ DSH 0.2.0 实测结论（2026-10-09，见 docs/DSH_0.2.0_MIGRATION.md §8）：
  //   写 **非本插件拥有** 的命名空间（这里是官方 dsh-client-ui-theme 的 'ui-theme'）
  //   会让 `settings.update()` 永不 resolve——实测该 promise 既不 resolve 也不
  //   reject，HTTP 写请求随之全部超时，且 .catch() 不会触发（重试逻辑形同虚设）。
  //   同一个 `settings.update()` 写**自己**的条目（'aemeath-ui'）则会完成并落盘。
  //   原因在 dsh 侧：configEditor.edit() 写完 profile patch 后要
  //   `await ctx.loader.await()` 做全树 reconcile，而 ui-theme 是 bundle 提供的
  //   条目、其 fiber 生命周期与本插件交错，reconcile 迟迟不 settle。
  //
  //   因此：**不再由本插件代改官方主题偏好**。改为只读 + 提示，真正的默认亮色
  //   由 theme.ts 在渲染层直接应用（它本来就把 light 映射到 aemeath 主题），
  //   不依赖持久化字段，也就没有启动期写入。
  //   —— 该改动同时消除了启动期的挂死：此前 TTS 重置写自己的条目虽然能落盘，
  //      但会被这个卡住的 promise 占住事件循环，表现为"设置开关全部失灵"。
  void (async () => {
    try {
      const cur = readSetting(ctx, 'ui-theme');
      const pref = cur?.preference;
      if (!pref || pref === 'dark' || pref === 'system') {
        // 只记录不写入：渲染层已按亮色渲染，用户显式选择后才需要持久化。
        console.log(`[aemeath-ui] ui-theme.preference=${pref ?? '(缺省)'} → 渲染层按亮色处理（0.2.0 下不再代写官方条目）`);
      }
    } catch {
      /* 读不到：渲染层仍按亮色兜底 */
    }
  })();

  // memory 服务（host 侧运行时提供；类型用结构断言）
  const memory = ctx.get('memory') as unknown as {
    list(): Array<{ key: string; rec: Record<string, unknown> }>;
    stats(): { active: number; dormant: number; byPreset: Record<string, number>; byScope: Record<string, number> };
    softDelete(idPrefix: string): Promise<boolean>;
    /** L0 用户画像事实（全局 userProfile.facts，记忆面板「画像」只读展示用）。 */
    profileFacts?(): string[];
    /** L1 采集缓冲（滚动对话，待总结）：会话列表 + 各会话轮次（2026-08-17 面板暴露）。 */
    l1Sessions?(): string[];
    l1Turns?(sid: string): Array<{ query?: string; reply?: string; kind?: string; ts?: number; preset?: string }>;
    l1CapacityOf?(): { capacity: number; threshold: number };
    /** 纯手动桥接：把一条 L2/L3 记忆写入世界书生成文件（生成条目哈希去重，热重载生效）。 */
    toWorldbook?(id: string, opts?: { library?: string; topic?: string }): Promise<{ ok: boolean; id?: string; title?: string; error?: string }>;
    /** T1 事实时间轴：某实体某属性的区间断言（借 ripples-of-aion 的 entityClaims）。 */
    timeline?(entity: string, attribute: string): Array<{ entity: string; attribute: string; value: string; valid_from: number; valid_until: number | null }>;
    /** T1：某实体某属性的当前有效断言（多条活跃取 valid_from 最大者）。 */
    currentClaim?(entity: string, attribute: string): { entity: string; attribute: string; value: string; valid_from: number; valid_until: number | null } | undefined;
    /** 时间轴筛选用的规范属性词表（attributes.ts 的 CANONICAL_ATTRS）。 */
    knownAttributes?(): string[];
    /** T3 洞察：最近一次自动整合的主题簇 + 疑似矛盾（只含 recordIds，不含原文）。 */
    currentInsights?(): {
      version: number;
      last_run_at: number;
      clusters: Array<{ id: string; label: string; recordIds: string[]; created_at: number }>;
      conflicts: Array<{ id: string; note: string; recordIds: [string, string]; created_at: number }>;
    };
    /** T3 手动触发一次空闲整合（autoDream）；null = 被闸门拦下或失败（旧洞察不变）。 */
    dreamNow?(): Promise<{ version: number; last_run_at: number; clusters: unknown[]; conflicts: unknown[] } | null>;
  } | undefined;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 无 CORS 头：端点仅服务同源前端（S3 修复；跨源读取/写入由浏览器同源策略拦截）
    if (req.method === 'GET') {
      // 读：返回每个 namespace 的当前值（各插件启动时登记进读表）+ preset 默认。
      // DSH 0.2.0：跨命名空间读改走 common 的 readSetting 注册表；官方 ui-theme
      // 的 preference 读不到（属它自己的 volatile 配置），前端按缺省处理。
      const out: Record<string, unknown> = {};
      for (const ns of FEATURE_NAMESPACES) {
        try {
          const value = readSetting(ctx, ns);
          if (value !== undefined) out[ns] = value;
        } catch {
          /* namespace 未登记：跳过 */
        }
      }
      try {
        const presets = (ctx as unknown as { agentPresets?: { defaultId?: string } }).agentPresets;
        const resolved =
          (typeof presets?.defaultId === 'string' && presets.defaultId) ||
          (readSetting(ctx, AGENT_PRESET_NAMESPACE)?.selectedDefault as string | undefined) ||
          (readSetting(ctx, AGENT_PRESET_NAMESPACE)?.default as string | undefined);
        if (resolved) out[AGENT_PRESET_NAMESPACE] = resolved;
        // 兼容前端既有读法：老键名 agent-presets.default
        if (resolved) out['agent-presets'] = resolved;
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
        // 允许写 agent-preset-registry（角色模式切换）；其余限 aemeath-* 白名单
        if (parsed.ns === AGENT_PRESET_NAMESPACE || parsed.ns === 'agent-presets') {
          if (!patchOk) return json(res, 400, { ok: false, error: 'agent-presets only supports patch (no unset)' });
          const patch = parsed.patch as Record<string, unknown>;
          if (typeof patch.default !== 'string') return json(res, 400, { ok: false, error: 'agent-presets patch requires {default: string}' });
          if (!['aemeath', 'physicist'].includes(patch.default)) return json(res, 400, { ok: false, error: `unsupported role: ${patch.default}` });
          // DSH 0.2.0：默认 preset 的 volatile 字段是 selectedDefault（官方实现
          // `defaultId = selectedDefault.get() ?? default`）。
          await settings.update(AGENT_PRESET_NAMESPACE, { selectedDefault: patch.default });
          json(res, 200, { ok: true });
          return;
        }
        if (!FEATURE_NAMESPACES.includes(parsed.ns)) return json(res, 403, { ok: false, error: `namespace not managed by aemeath-ui: ${parsed.ns}` });
        // DSH 0.2.0：命名空间即 profile 条目 id。除本插件自己的 'aemeath-ui' 外，
        // 其余 aemeath-* 条目由对应引擎插件持有（其 Config 上已声明 volatile 字段），
        // 因此这里仍按 ns 直接写——条目 id 是全局的。
        const remapped = FEATURE_NAMESPACE_FIELD_MAP[parsed.ns];
        const fieldFor = (f: string): string => remapped?.[f] ?? f;
        const entryId = FEATURE_NAMESPACE_ENTRY[parsed.ns] ?? parsed.ns;
        // DSH 0.2.0 护栏：settings.update/mutate 对某些条目可能永不 resolve
        //（实测：写非本插件拥有的条目时既不 resolve 也不 reject，
        //  见文件顶部主题迁移处与 docs/DSH_0.2.0_MIGRATION.md §8）。
        // 这里加超时，保证端点如实报错而不是静默挂死 30s+。
        const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
          Promise.race([
            p,
            new Promise<T>((_, rej) =>
              setTimeout(
                () => rej(new Error(`${label} 超时（${ms}ms）：DSH 0.2.0 对该条目的设置写入未返回`)),
                ms,
              ),
            ),
          ]);
        if (unsetOk) {
          // 删除字段 → settings.mutate 的 {op:'unset'}（恢复 base/默认，而非置值）
          await withTimeout(
            settings.mutate(
              entryId,
              (parsed.unset as string[]).map((f) => ({ op: 'unset', path: [fieldFor(f)] })),
            ),
            10_000,
            'settings.mutate',
          );
        }
        if (patchOk) {
          const patchIn = parsed.patch as Record<string, unknown>;
          const patchOut: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(patchIn)) patchOut[fieldFor(k)] = v;
          await withTimeout(settings.update(entryId, patchOut), 10_000, 'settings.update');
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

  // —— UI locale + TTS 开关（2026：前端上报 active locale / 朗读开关）——
  // DSH 0.2.0：不再 installSettingsSection；两者都是本插件 Config 上的 volatile
  // 字段（locale / ttsEnabled / ttsVolume），设置页由框架自动生成并写回
  // profile patch。注册进全局读表，供 common 的语言指令与 /tts/status 读取。
  registerVolatileSettings(UI_LOCALE_NAMESPACE, {
    locale: () => uiConfig.locale.get() ?? '',
    enabled: () => uiConfig.ttsEnabled.get() ?? false,
    volume: () => uiConfig.ttsVolume.get() ?? 1,
  });
  // 兼容旧命名空间名：0.1.1 时 TTS 开关写在 'aemeath-tts' 下。
  registerVolatileSettings('aemeath-tts', {
    enabled: () => uiConfig.ttsEnabled.get() ?? false,
    volume: () => uiConfig.ttsVolume.get() ?? 1,
  });
  console.log('[aemeath-ui] aemeath-ui 设置已接线（locale 上报 + TTS 开关，volatile）');
  // 2026-08-17：TTS 每次启动强制关闭（用户要求"启动时永远显示未开启"）——
  // 会话内可开启，重启后回到关闭态。
  // DSH 0.2.0：写的是**本插件自己**的条目（aemeath-ui），实测能正常落盘；
  // 但仍加超时护栏——若 dsh 侧 reconcile 卡住，不能让一个悬空的 promise
  // 拖住启动逻辑（此前正是这种悬空导致"设置开关全部失灵"）。
  let ttsResetAttempts = 0;
  const resetTtsAtBoot = (): void => {
    if (ttsResetAttempts > 10) return;
    ttsResetAttempts++;
    void Promise.race([
      settings.update(UI_LOCALE_NAMESPACE, { ttsEnabled: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tts reset timeout')), 8000)),
    ])
      .then(() => console.log('[aemeath-ui] aemeath-tts 已重置为关闭（启动默认）'))
      .catch(() => {
        setTimeout(resetTtsAtBoot, 1000);
      });
  };
  setTimeout(resetTtsAtBoot, 500);
  console.log('[aemeath-ui] TTS 开关已接线（volatile ttsEnabled/ttsVolume）');

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
      return readSetting(ctx, 'aemeath-tts')?.enabled === true; // 2026-08-17：默认关闭（开关初始为关）
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
      if (!checkWriteOrigin(req)) return jsonError(res, 403, 'tts.crossOrigin', 'cross-origin write denied');
      if (!ttsSettingsEnabled()) return jsonError(res, 400, 'tts.disabled', '语音朗读已关闭（设置 → 语音朗读）');
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || '{}') as { text?: unknown };
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      console.log(`[aemeath-ui] TTS 合成请求收到 text="${text.slice(0, 60)}" enabled=${ttsSettingsEnabled()}`);
      if (!text) return jsonError(res, 400, 'tts.textRequired', 'text required');
      if (text.length > 20000) return jsonError(res, 400, 'tts.textTooLong', `text 过长（${text.length} 字，上限 20000）`, { n: text.length });
      const cfg = ttsConfigStatus();
      if (!cfg.configured) {
        return jsonError(res, 500, 'tts.notConfigured', `未配置 TTS 引擎（python=${cfg.pythonExists} model=${cfg.modelConfigExists} voice=${cfg.voiceCount}）。请安装 IndexTTS2 到 D:\\index-tts 或设置 AEMEATH_TTS_PYTHON / AEMEATH_TTS_MODEL_DIR`);
      }
      if (!(await ensureTtsServer())) return jsonError(res, 500, 'tts.startFailed', 'TTS 服务启动失败');
      const r = await fetch(`${TTS_HTTP_BASE}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // lang 跟随前端 UI 设置（zh/en）；tts_mcp 的 _normalize_lang 会用，否则按文本自动判断
        body: JSON.stringify({ text, lang: hostUiLocale(ctx) || '' }),
        // 首次调用加载 3.4GB 模型，允许 1-3 分钟
        signal: AbortSignal.timeout(200000),
      });
      const d = (await r.json()) as { success?: boolean; audio_base64?: string; size_bytes?: number; error?: string };
      console.log(`[aemeath-ui] TTS 合成结果: HTTP ${r.status} success=${d.success} size=${d.size_bytes ?? 0} error=${d.error ?? ''}`);
      if (!r.ok || !d.success || !d.audio_base64) return jsonError(res, 500, 'tts.synthFailed', d.error ?? `合成失败（${r.status}）`, { status: r.status });
      json(res, 200, { ok: true, audio_base64: d.audio_base64, size_bytes: d.size_bytes ?? 0 });
    } catch (e) {
      jsonError(res, 500, 'tts.unknown', (e as Error).message);
    }
  }

  // POST /aemeath/api/tts/warmup —— 懒加载预热（仅加载模型，不合成；前端弹 99% 进度条）
  // 注意：不在 enabled 门控内——前端「开启开关」流程是"先预热、后置 enabled"，
  // 若此处检查 enabled 会把预热拒掉（开关还关着）→ 前端误报加载失败（2026-08-17 修复）。
  async function handleTtsWarmup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!checkWriteOrigin(req)) return jsonError(res, 403, 'tts.crossOrigin', 'cross-origin write denied');
      if (!(await ensureTtsServer())) return jsonError(res, 500, 'tts.startFailed', 'TTS 服务启动失败');
      const r = await fetch(`${TTS_HTTP_BASE}/warmup`, {
        method: 'POST',
        // 模型加载 1-3 分钟
        signal: AbortSignal.timeout(240000),
      });
      const d = (await r.json()) as { ok?: boolean; model_loaded?: boolean; error?: string };
      if (!r.ok || !d.ok) return jsonError(res, 500, 'tts.warmupFailed', d.error ?? `模型加载失败（${r.status}）`, { status: r.status });
      json(res, 200, { ok: true, model_loaded: !!d.model_loaded });
    } catch (e) {
      jsonError(res, 500, 'tts.unknown', (e as Error).message);
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
      jsonError(res, 503, 'memory.unavailable', 'memory service unavailable');
      return;
    }
    try {
      if (req.method === 'GET') {
        // —— 记忆工作区新增视图（ripples 五页 IA；全走 ctx.memory 服务，不依赖 memory 插件
        //    自己的 token 认证端点，因此前端无需持有任何 token）——
        // 视图构造抽在 memory-view.ts（纯函数，可用假 service 直接单测；本处理器只做
        // 参数解析 + json()）。
        const url = new URL(req.url ?? '/', 'http://localhost');
        const action = url.searchParams.get('action');
        const face = memory as unknown as MemoryServiceFace;
        if (action === 'timeline') {
          const entity = (url.searchParams.get('entity') ?? '用户').slice(0, 40);
          const attribute = (url.searchParams.get('attribute') ?? '').slice(0, 40);
          if (!attribute) {
            jsonError(res, 400, 'memory.timelineAttributeRequired', 'attribute required');
            return;
          }
          json(res, 200, buildTimelineView(face, entity, attribute));
          return;
        }
        if (action === 'insights') {
          json(res, 200, { ok: true, insights: memory.currentInsights?.() ?? null });
          return;
        }
        if (action === 'graph') {
          json(res, 200, buildGraphView(face));
          return;
        }
        json(res, 200, buildMemoryOverview(face));
        return;
      }
      if (req.method === 'POST') {
        if (!checkWriteOrigin(req)) return jsonError(res, 403, 'memory.crossOrigin', 'cross-origin write denied');
        const raw = await readBody(req);
        const parsed = JSON.parse(raw || '{}') as { idPrefix?: string; action?: string; id?: string; library?: string; topic?: string };
        // 记忆工作区「洞察」页：立即整合（autoDream，T3）。绝不在空闲之外自动触发。
        // 这是唯一会**花 token** 的写动作，故追加一条服务器日志（含 Origin 是否缺失）：
        // checkWriteOrigin 对无 Origin 的请求是有意放行的（非浏览器客户端；DNS rebinding 由
        // "Origin 必须是 loopback" 挡住），这里只做留痕便于事后审计是谁触发的整合。
        if (parsed.action === 'dream') {
          if (!memory.dreamNow) return jsonError(res, 500, 'memory.dreamUnavailable', 'consolidation unavailable');
          console.log(`[aemeath-ui] 记忆整合被触发（POST /aemeath/api/memory action=dream，Origin=${String(req.headers.origin ?? '(无)')}）`);
          const result = await memory.dreamNow();
          json(res, 200, { ok: true, ran: !!result, insights: result ?? memory.currentInsights?.() ?? null });
          return;
        }
        // 纯手动桥接：把一条 L2/L3 记忆写入世界书生成文件（前端确认后调用；绝不自动触发）
        if (parsed.action === 'toWorldbook') {
          if (!memory.toWorldbook) return jsonError(res, 500, 'memory.toWorldbookUnavailable', 'worldbook bridge unavailable');
          if (typeof parsed.id !== 'string' || !parsed.id) return jsonError(res, 400, 'memory.idRequired', 'id required');
          const r = await memory.toWorldbook(parsed.id, {
            library: typeof parsed.library === 'string' ? parsed.library : undefined,
            topic: typeof parsed.topic === 'string' ? parsed.topic : undefined,
          });
          if (!r.ok) return jsonError(res, 400, 'memory.toWorldbookFailed', r.error ?? 'add to worldbook failed');
          json(res, 200, { ok: true, id: r.id, title: r.title });
          return;
        }
        // 默认：软删（action:'delete' 或直接 { idPrefix } 向后兼容）
        if (!parsed.idPrefix) {
          jsonError(res, 400, 'memory.idPrefixRequired', 'idPrefix required');
          return;
        }
        const removed = await memory.softDelete(parsed.idPrefix);
        json(res, 200, { ok: true, removed });
        return;
      }
      jsonError(res, 405, 'memory.methodNotAllowed', 'method not allowed');
    } catch (e) {
      const err = e as Error & { status?: number };
      jsonError(res, err.status ?? 400, 'memory.deleteFailed', err.message);
    }
  }
}
