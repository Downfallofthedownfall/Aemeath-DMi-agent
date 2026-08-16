// ============================================================
// dsh-plugin-worldbook · Worldbook 知识库插件（M2）
// 职责：
//   1. 双馆隔离加载：libraries.physicist / libraries.aemeath（JSON 目录，兼容数组/单对象）
//   2. 热重载：mtime 轮询（可配置间隔）
//   3. 触发注入：agent/pre-step 追加匹配条目（constant + hits + chain，≤maxInjectTokens，
//      带 MessageSource form='catalog'，模型可见即已记录）
//   4. retrieve_worldbook 工具：结构化检索（id/source/verifiable）
//   5. 工具可见性隔离：爱弥斯（aemeath）会话不暴露检索工具（ctx.tools.restrict）
// 注：自传头已由 persona 承担；本插件注入"触发条目 + constant 常驻"，与 v1 行为对齐。
// ============================================================

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { Service, type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-settings';
import { matchWorldbook, hitSummary, type WorldbookEntry } from './match.js';

export const name = 'aemeath-worldbook';
export const inject = ['tools', 'agents', 'settings'];

export const Config = z.object({
  defaultPreset: z.string(),
  libraries: z.dict(z.string()),
  maxInjectTokens: z.number(),
  hotReloadInterval: z.number(),
});

export interface WorldbookConfig {
  defaultPreset?: string;
  libraries?: Record<string, string>;
  maxInjectTokens?: number;
  hotReloadInterval?: number;
}

interface LibState {
  entries: WorldbookEntry[];
  mtimes: Map<string, number>;
}

function log(msg: string): void {
  console.log(`[aemeath-worldbook] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[aemeath-worldbook] ⚠ ${msg}`);
}

/**
 * C8 修复：worldbook 配置 service（name='worldbook'）——把 preset→馆目录映射
 * 暴露给其他插件（memory 的 worldbook 桥接直接读取），消除 cordis.patch.yml 里
 * libraries 在 worldbook 与 memory 各抄一份的漂移。memory 插件经
 * ctx.reflect.get('worldbook') 读取（未加载时优雅降级到自身配置/默认）。
 */
export class WorldbookService extends Service {
  readonly libraries: Record<string, string>;
  readonly maxInjectTokens: number;
  constructor(ctx: Context, opts: { libraries: Record<string, string>; maxInjectTokens: number }) {
    super(ctx, 'worldbook');
    this.libraries = opts.libraries;
    this.maxInjectTokens = opts.maxInjectTokens;
  }
}

/** 读取一个馆目录下全部 .json（兼容数组=多条 / 单对象=一条）。 */
function loadLibrary(dir: string): LibState {
  const entries: WorldbookEntry[] = [];
  const mtimes = new Map<string, number>();
  if (!existsSync(dir)) {
    warn(`知识馆目录不存在: ${dir}`);
    return { entries, mtimes };
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) {
    const path = join(dir, f);
    try {
      mtimes.set(path, statSync(path).mtimeMs);
      const data = JSON.parse(readFileSync(path, 'utf-8')) as WorldbookEntry | WorldbookEntry[];
      const items = Array.isArray(data) ? data : [data];
      for (const it of items) {
        if (it && typeof it === 'object' && it.id) entries.push(it);
        else warn(`跳过无效条目: ${f} → ${String(it).slice(0, 60)}`);
      }
    } catch (e) {
      warn(`加载失败 ${f}: ${(e as Error).message}`);
    }
  }
  return { entries, mtimes };
}

/**
 * 从进入 step 的 messages 中提取最后一条真实用户文本（注入匹配源）。
 * B2 修复：只取 source.kind === 'user' 的消息——memory 的 recall 块、workflow 的
 * SOLVER_PROMPT、worldbook 自己的 catalog 块都是 role='user' 但 source.kind='plugin'，
 * 若不过滤会形成自触发注入循环（上一步注入的块成为下一步的"用户输入"再次命中，
 * 每步重复注入、上下文无界增长）。与 retriever/memory/workflow 的取法一致。
 */
function extractUserText(
  messages: readonly { role?: string; source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] }[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.source?.kind === 'user') {
      return (m.content || [])
        .map((b) => (b.type === 'text' ? b.text ?? '' : ''))
        .join('')
        .trim();
    }
  }
  return '';
}

export function apply(ctx: Context, config: WorldbookConfig): void {
  // ---- settings 接线（M5：前端设置界面 → 实时开关） ----
  const runtime = { enabled: true };
  const FeatureSettingsSchema = z.object({ enabled: z.boolean() });
  const featureBase = { enabled: true };
  let currentSource: () => typeof featureBase = () => featureBase;
  installSettingsSection(
    ctx,
    settingsNamespace('aemeath-worldbook'),
    FeatureSettingsSchema,
    featureBase,
    {
      setSource: (current) => {
        currentSource = current;
      },
      onChange: () => {
        const v = currentSource();
        runtime.enabled = v.enabled;
        log(`settings 已应用: enabled=${runtime.enabled}`);
      },
    },
  );

  const maxTokens = config.maxInjectTokens ?? 3000;
  const reloadSec = config.hotReloadInterval ?? 3;
  const libs = new Map<string, LibState>();

  // C8：注册配置 service（供 memory 等插件读取 libraries，消除配置漂移）
  new WorldbookService(ctx, { libraries: config.libraries ?? {}, maxInjectTokens: maxTokens });

  const resolveDir = (p: string): string => (isAbsolute(p) ? p : join(process.cwd(), p));

  const loadAll = (): void => {
    for (const [lib, p] of Object.entries(config.libraries ?? {})) {
      try {
        libs.set(lib, loadLibrary(resolveDir(p)));
        log(`馆 ${lib} 加载完成 ${libs.get(lib)!.entries.length} 条`);
      } catch (e) {
        warn(`馆 ${lib} 加载失败: ${(e as Error).message}`);
      }
    }
  };
  loadAll();

  // ---- 热重载（mtime 轮询） ----
  const timer = setInterval(() => {
    let changed = false;
    for (const [lib, p] of Object.entries(config.libraries ?? {})) {
      const state = libs.get(lib);
      if (!state) continue;
      const dir = resolveDir(p);
      if (!existsSync(dir)) continue;
      const current = new Map<string, number>();
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const path = join(dir, f);
        try {
          current.set(path, statSync(path).mtimeMs);
        } catch {
          /* 文件被删：忽略 */
        }
      }
      if (current.size !== state.mtimes.size) changed = true;
      else {
        for (const [path, mt] of current) {
          if (Math.abs((state.mtimes.get(path) ?? 0) - mt) > 1e-6) {
            changed = true;
            break;
          }
        }
      }
    }
    if (changed) {
      loadAll();
      log('热重载完成（检测到文件变更）');
    }
  }, Math.max(0.5, reloadSec) * 1000);
  if (timer.unref) timer.unref();

  // ---- 触发注入（agent/pre-step waterfall，按 agent preset 选馆） ----
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    if (!runtime.enabled) return decision;

    const preset = resolveSessionPreset(payload.agent.session as never) ?? config.defaultPreset;
    const lib = preset ? libs.get(preset) : undefined;
    if (!lib || !lib.entries.length) return decision;

    const query = extractUserText(decision.messages);
    if (!query) return decision;

    const block = matchWorldbook(query, lib.entries, maxTokens);
    if (!block) return decision;

    log(`preset=${preset} agent=${payload.agent.id} 注入 ${block.length} 字符（≤${maxTokens} tokens 预算）`);
    const injectMsg = createUserMessage({
      content: [{ type: 'text', text: block }],
      source: { kind: 'plugin', plugin: name, form: 'catalog' },
    });
    return { kind: 'enter', messages: [...decision.messages, injectMsg] };
  });
  log('触发注入已挂载（agent/pre-step）');

  // ---- retrieve_worldbook 工具 ----
  ctx.tools.register(
    defineTool({
      name: 'retrieve_worldbook',
      description: '从 Worldbook 知识库检索物理/数学知识条目，返回带来源与可验证标记的条目列表与注入文本。',
      parameters: {
        query: { type: 'string', required: true, description: '检索词（中文/英文/德文均可）' },
        library: { type: 'string', description: '知识馆：physicist（物理）或 aemeath（陪伴）；缺省取当前角色馆' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args: { query: string; library?: string }, exec) => {
        const libName = args.library || exec?.agent?.id || 'physicist';
        const entries = libs.get(libName)?.entries ?? [];
        const block = matchWorldbook(args.query, entries, maxTokens);
        return {
          library: libName,
          hits: hitSummary(entries, args.query),
          injected: block,
        };
      },
    }),
  );
  log('工具 retrieve_worldbook 已注册');

  // ---- 工具可见性隔离：爱弥斯（aemeath preset）不暴露检索工具 ----
  const restrictAemeath = (agent: { id: string; ctx: Context; session: { header?: unknown } }): void => {
    const preset = resolveSessionPreset(agent.session as never) ?? config.defaultPreset;
    if (preset !== 'aemeath') return;
    agent.ctx.tools.restrict({ deny: ['retrieve_worldbook'] });
    log(`preset=${preset}（${agent.id}）已隐藏 retrieve_worldbook 工具（工具集隔离）`);
  };
  for (const agent of ctx.agents.list()) restrictAemeath(agent);
  ctx.on('agent/created', ({ agent }) => restrictAemeath(agent));

  // ---- 开关联动：settings enabled=false 时拒绝工具执行（全局动态 guard）----
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow') return decision;
    if (exec.name !== 'retrieve_worldbook') return decision;
    if (runtime.enabled) return decision;
    log(`开关已关闭：拒绝 retrieve_worldbook 调用`);
    return {
      kind: 'deny' as const,
      reason: '世界书注入已关闭（设置 → 功能开关）。如需使用知识库检索，请重新开启。',
    };
  });
  log('工具开关联动已挂载（tools/pre-execute，retrieve_worldbook）');
}
