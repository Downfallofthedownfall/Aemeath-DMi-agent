// ============================================================
// dsh-plugin-exercise · Übungen（习题）模块
//
// 定位（docs/exercise-mode-plan.md）：
//   lecture 的姊妹模块 —— 同一套文件存储 / 前端语言 / 单向握手，
//   但做的是"每周一张 Übungsblatt"这件事：
//     导入 PDF → 拆题 → 自己写答案（可随时改）→ **手动**让 LLM 检查
//     → 错题/经验沉淀（错题本 + worldbook）→ 生成可提交的合并 PDF
//
// 与主 agent 的关系（不像 lecture 那样刻意隔离）：
//   · 习题的产物（教训、薄弱点、进度）**应该**进主记忆与知识库
//   · 但进入的方式是**单向握手 + 守门员**，不是直接写 memory
//   · 检查(LLM) 用本插件自己的通道（与 lecture 同款），不走主 agent 的对话
//
// 工具（供 LLM 调用）：
//   exercise_list / exercise_open / exercise_problem / exercise_new_sheet
//   exercise_save_answer / exercise_check / exercise_collect_mistake
//   exercise_lessons / exercise_sync_worldbook / exercise_build_submission
//   exercise_progress / exercise_export_handoff / exercise_import_handoff
// ============================================================

import { join, isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { registerVolatileSettings } from '@aemeath/dsh-plugin-common';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-tools';

import {
  ExerciseStore,
  problemIdOf,
  safeSheetId,
  type StoreOptions,
} from './store.js';
import { extractPdfText, type PdfExtractResult } from './pdf-text.js';
import { splitProblems, type SplitProblem } from './split.js';
import { segmentWithLlm } from './llm-split.js';
import { renderPdfPages, type RenderedPage } from './pdf-image.js';
import { segmentWithVision, type AskVision, type VisionPage } from './vision.js';
import { collectMathIssuesInText } from './mathlive-compat.js';
import { imageFileName, sniffImageType } from './images.js';
import { renderTextExport, syncTextExport, type CourseSnapshot } from './text-export.js';
import {
  buildProgressDigest,
  daysUntil,
  nextActionHint,
  type DigestResult,
  type LectureProgress,
} from './digest.js';
import { buildCheckPrompt, parseCheckOutput, runApproach, runCheck, runRebuttal, type AskLlm } from './checker.js';
import { answerFingerprint } from './hash.js';
import {
  buildExerciseHandoff,
  describeExerciseHandoff,
  findExerciseHandoffs,
  writeExerciseHandoff,
} from './handoff.js';
import {
  importExerciseHandoff,
  describeExerciseOutcome,
  loadExerciseHandoff,
  findExerciseHandoffFiles,
  type ExerciseGatekeeper,
  type GateDecision,
  type WriteGateResult,
} from './import-handoff.js';
import { lessonToEntry, mistakeToEntry, appendWorldbookEntries } from './worldbook.js';
import { buildSubmissionHtml, type SubmissionProblem } from './pdf-html.js';
import { katexCssInlined, renderMathToHtml } from './pdf-math.js';
import { findChromium, renderSubmissionPdf } from './pdf-render.js';
import { handleExerciseHttp, type ExerciseHttpDeps } from './http.js';
import { setLocaleContext, tr, uiLang } from './locale.js';
import { ASSETS_PREFIX, serveExerciseAsset } from './assets.js';
import {
  deriveTitle,
  lastFreshCheck,
  mistakeIdAt,
  normalizeAnswer,
  parsePoints,
  problemStatus,
  sheetProgress,
  shouldCollectMistake,
  submissionFileName,
  type Check,
  type CourseIndex,
  type Lesson,
  type Mistake,
  type Problem,
  type ProblemImage,
  type Rebuttal,
  type Sheet,
} from './types.js';

export const name = 'aemeath-exercise';
// webServer 可选：headless profile 里没有它，故用 reflect.get 惰性取（见 HTTP 桥）。
export const inject = ['tools', 'settings', 'credentials'];

const PROFILE_NAME = process.env.DSH_PROFILE || 'unknown';

export const Config = z.object({
  defaultPreset: z.string(),
  /** 是否挂载工具（volatile：设置页可关）。 */
  enabled: z.boolean().default(true).volatile(),
  /** 这个 profile 是否**就是**习题独立界面（host 据此注入 boot 标记）。 */
  standalone: z.boolean().default(false),
  /** 数据根目录（D2：放 physicist 里）。 */
  dataDir: z.string(),
  /** 握手导出目录（空 = 数据根目录下的 handoff/）。 */
  handoffDir: z.string().default(''),
  /** worldbook 的 physicist 馆目录（写经验/教训条目）。 */
  worldbookLibraryDir: z.string().default('packages/worldbook/data/physicist'),
  /** lecture 的数据目录（只读：算学习进度摘要用）。 */
  lectureDataDir: z.string().default('packages/library/physicist/lectures'),
  /** 检查结果 wrong/partial 时自动进错题本（仍可手动改/删）。 */
  autoCollectMistakes: z.boolean().default(true),
  /**
   * 纯文本导出目录（markdown，内容管理用）。
   * 空 = `packages/library/physicist-md/`（默认 gitignored；内容与 harness 分开管理）。
   */
  textExportDir: z.string().default(''),
  /** 生成提交包时的默认学生姓名（留空 → PDF 上留签名线）。 */
  studentName: z.string().default(''),
  /** 是否把原卷合并进提交包。 */
  /** 提交包是否合并原卷 PDF。默认 false：只输出生成的解答页（用户 2026-10-24 定案）。 */
  includeSourcePdf: z.boolean().default(false),
  /** 合并顺序：sheet-first（原卷在前）| solutions-first（解答在前）。 */
  submissionOrder: z.string().default('sheet-first'),
  /**
   * 检查/答辩的推理强度：high（默认；评测里 max 并不更好）| max | low | off。
   * 分块/读图这类结构化任务不受影响（它们固定 off）。
   */
  checkReasoning: z.string().default('high'),
  /** 浏览器路径（空 = 自动发现 Chrome/Edge/Chromium）。 */
  chromePath: z.string().default(''),
  llm: z.object({
    /** 显式覆盖（一般留空）：空 = 走全局 dsh 的 LLM 运行时（主 agent 同一个模型）。 */
    provider: z.string().default(''),
    model: z.string().default(''),
    apiKey: z.string().default(''),
    baseUrl: z.string().default('https://api.deepseek.com'),
  }),
});

export interface ExerciseConfig {
  defaultPreset?: string;
  enabled?: { get?: () => boolean };
  standalone?: boolean;
  dataDir?: string;
  handoffDir?: string;
  worldbookLibraryDir?: string;
  lectureDataDir?: string;
  autoCollectMistakes?: boolean;
  textExportDir?: string;
  studentName?: string;
  includeSourcePdf?: boolean;
  submissionOrder?: string;
  chromePath?: string;
  checkReasoning?: string;
  llm?: { provider?: string; apiKey?: string; baseUrl?: string; model?: string };
}

function log(msg: string): void {
  console.log(`[aemeath-exercise] ${msg}`);
}
function warn(msg: string): void {
  console.warn(`[aemeath-exercise] ⚠ ${msg}`);
}

/** 本地日期 YYYY-MM-DD（不用 toISOString：那是 UTC，会把东八区的课/作业记到前一天）。 */
function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 工具返回形状（与 lecture 一致：值里不允许 undefined）。 */
type ToolResult = { ok: boolean; data: Record<string, string | number | boolean | string[] | null> };
function ok(data: Record<string, string | number | boolean | string[] | null> = {}): ToolResult {
  return { ok: true, data };
}
function fail(error: string, extra: Record<string, string | number | boolean | string[] | null> = {}): ToolResult {
  return { ok: false, data: { error, ...extra } };
}
const renderJson = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: JSON.stringify(value) },
];

const LLM_TIMEOUT_MS = 60_000;

export async function apply(ctx: Context, config: ExerciseConfig): Promise<void> {
  setLocaleContext(ctx);
  const enabledRef = (config as { enabled?: { get?: () => boolean } }).enabled;
  const runtime = {
    get enabled(): boolean {
      return enabledRef?.get?.() ?? true;
    },
  };
  registerVolatileSettings('aemeath-exercise', { enabled: runtime.enabled });
  ctx.on('loader/volatile-update', () => {
    log(`settings 已更新: enabled=${runtime.enabled}`);
  });

  // 测试/多实例隔离：EXERCISE_DATA_DIR 可以覆盖数据目录（e2e 用独立目录，避免动到真实题库）
  const dataDir = (process.env.EXERCISE_DATA_DIR ?? '').trim() || config.dataDir || 'packages/library/physicist/exercises';
  const store = new ExerciseStore({ rootDir: dataDir } satisfies StoreOptions);
  const handoffDir = config.handoffDir || join(dataDir, 'handoff');
  const worldbookDir = config.worldbookLibraryDir ?? 'packages/worldbook/data/physicist';
  const lectureDataDir = config.lectureDataDir ?? 'packages/library/physicist/lectures';
  const autoCollect = config.autoCollectMistakes ?? true;
  // 批改/答辩的推理强度（用户定案 2026-10-23：默认 high —— 评测里 max 并不更好；
  // **但绝不因为预算而降级关推理**：推理没了基本必错，宁可烧 token）
  const checkReasoning: 'off' | 'low' | 'high' | 'max' =
    config.checkReasoning === 'off' || config.checkReasoning === 'low' || config.checkReasoning === 'high' || config.checkReasoning === 'max'
      ? config.checkReasoning
      : 'high';
  // 文本导出目录：空 = packages/library/physicist-md/（gitignored；内容数据单独管理）
  const textExportDir = config.textExportDir || 'packages/library/physicist-md';
  const studentName = config.studentName ?? '';
  // 默认不合并原卷：只留自己生成的页面（用户定案：习题自己的 pdf 就不要了）
  const includeSourceDefault = config.includeSourcePdf ?? false;
  const submissionOrder = config.submissionOrder === 'solutions-first' ? 'solutions-first' : 'sheet-first';
  const llm = {
    /** 显式覆盖（一般留空）：空 = 走全局 dsh 的 LLM 运行时。 */
    apiKey: config.llm?.apiKey ?? '',
    baseUrl: config.llm?.baseUrl ?? 'https://api.deepseek.com',
    provider: config.llm?.provider ?? '',
    model: config.llm?.model ?? '',
  };

  log(`已挂载：dataDir=${store.rootPath} handoffDir=${handoffDir} worldbook=${worldbookDir} profile=${PROFILE_NAME}`);

  // ============================================================
  // LLM 通道
  //
  // 用户定案：**API 与模型直接走 lecture / 主模型 / 全局 dsh** ——
  // 习题插件不再自带一套 key/model。顺序：
  //   ① 全局 dsh 的 LLM 运行时（ctx.llm）：与主 agent **同一个 provider、同一个模型、
  //      同一份凭据**（UI 里换模型，检查也跟着换）
  //      路由 = 最近一个 live agent 的 options（就是 UI 里选的那条）→
  //             否则第一个 provider + 它目录里的默认模型
  //   ② 全局凭据直连 DeepSeek（headless / 无 llm 运行时的兜底；key 仍是
  //      .dsh-home/.credentials.yaml 里那一份）
  //   ③ 插件配置里的 llm.* 只在显式填写时作为覆盖（默认全空）
  // ============================================================
  const LLM_TIMEOUT_MS_LOCAL = LLM_TIMEOUT_MS;
  const llmRuntime = (): {
    prepareCall?: (cfg: { provider: string; model: string; maxTokens?: number }, signal?: AbortSignal) => Promise<{
      config: Record<string, unknown>;
      stream: (o: Record<string, unknown>) => AsyncIterable<unknown>;
    }>;
    listProviders?: () => Array<{ id: string }>;
    listModels?: (p: string) => Promise<Array<{ id: string }>>;
  } | null => {
    const c = ctx as unknown as { llm?: unknown; reflect?: { get(n: string): unknown } };
    // ⚠️ 顺序很重要：`ctx.llm` 在**没有 inject 'llm'** 时会抛（cordis 服务代理），
    // 所以先走 reflect.get（它对"服务不存在"只返回 undefined），再退回属性访问。
    // 第一版写成 `c.llm ?? c.reflect?.get('llm')`，属性访问先抛 → 整条被 catch →
    // 永远拿不到运行时，检查会静默降级成"直连"。真机日志发现的。
    try {
      const viaReflect = c.reflect?.get?.('llm');
      if (viaReflect) return viaReflect as ReturnType<typeof llmRuntime>;
    } catch {
      /* 没有 reflect 服务 */
    }
    try {
      return (c.llm ?? null) as ReturnType<typeof llmRuntime>;
    } catch {
      return null;
    }
  };

  /** 解析「主模型」路由：显式覆盖 → 最近 live agent → provider 默认。 */
  const resolveLlmRoute = async (): Promise<{ provider: string; model: string } | null> => {
    if (llm.provider && llm.model) return { provider: llm.provider, model: llm.model };
    // ① 主模型：UI 里当前选中的那条（最近创建的 agent 的 options）
    try {
      const agents = (ctx as unknown as { agents?: { list?: () => Array<{ options?: { provider?: string; model?: string } }> } }).agents?.list?.() ?? [];
      for (let i = agents.length - 1; i >= 0; i--) {
        const o = agents[i]?.options;
        if (o?.provider && o?.model) return { provider: o.provider, model: o.model };
      }
    } catch {
      /* 没有 agents 服务（headless/独立 profile 刚启动）→ 继续兜底 */
    }
    // ② provider 目录兜底
    const rt = llmRuntime();
    if (!rt?.listProviders) return null;
    try {
      const providers = rt.listProviders();
      const p = providers.find((x) => x.id === 'deepseek') ?? providers[0];
      if (!p) return null;
      let model = llm.model || 'deepseek-v4-flash';
      try {
        const models = (await rt.listModels?.(p.id)) ?? [];
        const ids = models.map((m) => m.id);
        if (ids.length && !ids.includes(model)) model = ids.includes('deepseek-v4-flash') ? 'deepseek-v4-flash' : ids[0]!;
      } catch {
        /* 模型目录不可用：用默认 id，交给 adapter 判定 */
      }
      return { provider: p.id, model };
    } catch {
      return null;
    }
  };

  const resolveLlmKey = async (): Promise<string> => {
    if (llm.apiKey) return llm.apiKey;
    try {
      const resolved = await ctx.credentials?.resolve(credentialRef('DEEPSEEK_API_KEY'));
      return resolved?.value ?? process.env.DEEPSEEK_API_KEY ?? '';
    } catch {
      return process.env.DEEPSEEK_API_KEY ?? '';
    }
  };

  /** 走全局 dsh LLM 运行时（与主 agent 同一套 provider/key/model）。 */
  // 最近一次真正用到的通道（界面显示"谁批的"；也方便排查"推理是不是关了"）
  let lastLlmRoute = '';
  let lastLlmReasoning = '';
  const llmProvider = (): string => lastLlmRoute || (llm.provider ? `${llm.provider}/${llm.model}` : 'unknown');
  const llmReasoningState = (): string => lastLlmReasoning || 'high';

  const askViaRuntime = async (
    prompt: string,
    opts: {
      maxTokens: number;
      purpose: string;
      noReasoning?: boolean;
      attempt?: number;
      /** 推理强度；批改/答辩给 `high`，分块给 `off` */
      reasoning?: 'off' | 'low' | 'high' | 'max';
      /** 单次调用超时（批改 180s；分块用默认 60s） */
      timeoutMs?: number;
    },
  ): Promise<string | null> => {
    const rt = llmRuntime();
    if (!rt?.prepareCall) return null;
    // ⚠️ 必须 bind：prepareCall 内部读 this.registration（TypertRemoteService），
    // 直接解构出来单独调用会得到 "Cannot read properties of undefined (reading 'registration')"。
    const prepareCall = rt.prepareCall.bind(rt);
    const route = await resolveLlmRoute();
    if (!route) return null;
    lastLlmRoute = `dsh:${route.provider}/${route.model}`;
    lastLlmReasoning = opts.noReasoning ? 'off' : (opts.reasoning ?? 'high');
    const deadline = AbortSignal.timeout(opts.timeoutMs ?? LLM_TIMEOUT_MS_LOCAL);
    const request = async (noReasoning: boolean): Promise<string | null> => {
      const call = await prepareCall(
        {
          provider: route.provider,
          model: route.model,
          maxTokens: opts.maxTokens,
          // 结构型小任务（分块）关掉推理：真机上 deepseek-flash 会把 1500~12000 token
          // 全花在 reasoning 上，finish=max-tokens、blocks=reasoning、正文为空。
          // 批改/答辩则显式要 max —— 用户定案"检查重在精不在快"。
          ...(noReasoning ? { reasoningEffort: 'off' } : opts.reasoning ? { reasoningEffort: opts.reasoning } : {}),
        },
        deadline,
      );
      const assembler = new BlockAssembler();
      const stream = call.stream({
        ...call.config,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: opts.maxTokens,
        purpose: opts.purpose,
        signal: deadline,
      });
      for await (const chunk of stream) assembler.push(chunk as never);
      const blocks = assembler.blocks();
      const text = blocks
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')
        .trim();
      if (text) return text;

      const finish = assembler.finish;
      const kinds = blocks.map((b) => b.type).join(',') || 'none';
      const usage = JSON.stringify(assembler.usage ?? {});
      warn(
        `全局 LLM 返回空文本（${route.provider}/${route.model}，finish=${finish?.kind ?? 'unknown'}，` +
          `blocks=${kinds}，usage=${usage}，maxTokens=${opts.maxTokens}，noReasoning=${noReasoning}）`,
      );
      const attempt = opts.attempt ?? 1;
      if (finish?.kind === 'max-tokens' && attempt < 3) {
        // 有推理的任务（批改/答辩）：**只放大预算，绝不关推理** ——
        // 用户定案"推理没了基本百分百会批错"，宁可烧 token 让模型自己放弃（verdict=unclear）。
        const next = Math.min(opts.maxTokens * 2, 128_000);
        const keepReasoning = !!opts.reasoning && opts.reasoning !== 'off' && !opts.noReasoning;
        log(
          `空文本来自 max-tokens 截断 → 预算放大到 ${next}` +
            (keepReasoning ? '，推理保持' : '，关闭推理重试') +
            `（第 ${attempt + 1} 次）`,
        );
        return askViaRuntime(prompt, {
          ...opts,
          maxTokens: next,
          noReasoning: keepReasoning ? undefined : true,
          attempt: attempt + 1,
        });
      }
      return null;
    };

    try {
      const text = await request(opts.noReasoning === true);
      if (text) log(`LLM（全局 dsh）：${route.provider}/${route.model} ← ${opts.purpose}`);
      return text;
    } catch (e) {
      const msg = (e as Error).message;
      // 'off' 是 DeepSeek adapter 的取值；别的 provider 可能没有这个档位 →
      // 去掉 reasoningEffort 再试一次，而不是整条通道失败。
      if (opts.noReasoning && /reasoning|effort/i.test(msg)) {
        warn(`该 provider 不支持 reasoningEffort=off（${msg}）→ 去掉该参数重试`);
        try {
          const text = await request(false);
          if (text) log(`LLM（全局 dsh）：${route.provider}/${route.model} ← ${opts.purpose}（无 reasoning 开关）`);
          return text;
        } catch (e2) {
          warn(`全局 LLM 调用失败（${route.provider}/${route.model}）：${(e2 as Error).message}`);
          return null;
        }
      }
      warn(`全局 LLM 调用失败（${route.provider}/${route.model}）：${msg}`);
      if (process.env.EXERCISE_LLM_DEBUG === '1') warn(`stack: ${(e as Error).stack ?? ''}`);
      return null;
    }
  };

  const askLlm: AskLlm = async (prompt, opts) => {
    // ① 全局 dsh LLM（首选：同一套 provider/model/凭据）
    if (!opts.preferDirect) {
      const viaRuntime = await askViaRuntime(prompt, {
        maxTokens: opts.maxTokens,
        purpose: opts.purpose,
        noReasoning: opts.noReasoning,
        reasoning: opts.reasoning,
        timeoutMs: opts.timeoutMs,
      });
      if (viaRuntime) return viaRuntime;
    }

    // ② 直连兜底（key 仍来自全局 credentials；仅在没有 llm 运行时的环境下走）
    const apiKey = await resolveLlmKey();
    if (!apiKey) {
      warn(`LLM 不可用（${opts.purpose}）：既没有全局 LLM 运行时，也没有 DEEPSEEK_API_KEY`);
      return null;
    }
    try {
      const t0 = Date.now();
      lastLlmRoute = `direct:${llm.model || 'deepseek-v4-flash'}`;
      lastLlmReasoning = 'off';
      const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: llm.model || 'deepseek-v4-flash',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          max_tokens: opts.maxTokens,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS_LOCAL),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
        usage?: Record<string, unknown>;
      };
      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? '';
      const finishReason = choice?.finish_reason ?? 'unknown';
      log(
        `LLM（直连兜底）：${llm.model || 'deepseek-v4-flash'} ${Date.now() - t0}ms ` +
          `len=${content.length} finish=${finishReason} usage=${JSON.stringify(data.usage ?? {})}`,
      );
      if (!content.trim()) {
        warn(
          `LLM 直连返回空文本（${opts.purpose}，finish=${finishReason}，` +
            `reasoning=${(choice?.message?.reasoning_content ?? '').length} 字）`,
        );
        return null;
      }
      return content;
    } catch (e) {
      warn(`LLM 直连失败（${opts.purpose}）: ${(e as Error).message}`);
      return null;
    }
  };

  /**
   * 多模态通道：把页面截图（data URI）交给模型读题 / 纠错。
   *
   * 为什么是直连而不是 `ctx.llm`：dsh 的 LLM 运行时把图片当**附件**（`ImageAttachmentRef`），
   * 需要 `ctx.attachments` 先登记字节；习题这边只想要"把这张截图塞进请求"，
   * 直连 OpenAI 兼容接口最直接。凭据仍是**全局那一份**，模型 id 也优先用运行时路由的模型
   * （界面上选的是 deepseek-flash，就发这个），只是传输层不同。
   *
   * `thinking: {type:'disabled'}` 是关键：DeepSeek 的推理模型会把 max_tokens
   * 全花在 reasoning 上，正文为空（真机踩过）。结构化读图/纠错不需要那层思考。
   */
  const askVision: AskVision = async (prompt, images, opts) => {
    const apiKey = await resolveLlmKey();
    if (!apiKey) {
      warn(`多模态不可用（${opts.purpose}）：没有全局凭据 DEEPSEEK_API_KEY`);
      return null;
    }
    const route = await resolveLlmRoute().catch(() => null);
    const model = route?.model || llm.model || 'deepseek-v4-flash';
    const content: unknown[] = [{ type: 'text', text: prompt }];
    for (const img of images) {
      content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
    }
    // 批改要看图，推理强度由调用方给（默认 high）。
    // **推理不再被关掉**（用户 2026-10-23 定案）：推理没了基本必错；宁可放开烧 token，
    // 预算不够就放大预算重试，实在算不出来让模型自己给 `unclear`。
    const wantReasoning = opts.reasoning && opts.reasoning !== 'off' ? opts.reasoning : undefined;
    const t0 = Date.now();
    const call = async (m: string, withReasoning: boolean, budget = opts.maxTokens): Promise<Response> => {
      const body = {
        model: m,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        max_tokens: budget,
        temperature: 0.1,
        ...(withReasoning ? { reasoning_effort: wantReasoning } : { thinking: { type: 'disabled' } }),
      };
      return fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? LLM_TIMEOUT_MS_LOCAL),
      });
    };
    const read = async (resp: Response): Promise<{ text: string; finish: string; reasoningChars: number; usage: unknown } | null> => {
      if (!resp.ok) {
        warn(`多模态 HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`);
        return null;
      }
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
        usage?: Record<string, unknown>;
      };
      const choice = data.choices?.[0];
      return {
        text: (choice?.message?.content ?? '').trim(),
        finish: choice?.finish_reason ?? '?',
        reasoningChars: (choice?.message?.reasoning_content ?? '').length,
        usage: data.usage ?? {},
      };
    };
    lastLlmRoute = `direct:${model}`;
    lastLlmReasoning = wantReasoning ?? 'off';
    try {
      let withReasoning = !!wantReasoning;
      let resp = await call(model, withReasoning).catch(() => null);
      if (resp && (resp.status === 400 || resp.status === 404)) {
        // 模型 id 不被接受（不同 provider 目录的命名不同）→ 退回经典 id 再试一次
        const alt = 'deepseek-v4-flash';
        if (model !== alt) {
          warn(`多模态：模型 ${model} 被拒（HTTP ${resp.status}）→ 换 ${alt} 重试`);
          resp = await call(alt, withReasoning);
        }
      }
      let got = resp ? await read(resp) : null;
      log(
        `多模态（${model}，推理${withReasoning ? wantReasoning : '关'}）：${images.length} 图 ${Date.now() - t0}ms ` +
          `len=${got?.text.length ?? 0} finish=${got?.finish ?? '?'} usage=${JSON.stringify(got?.usage ?? {})}`,
      );
      // 推理吃满预算 → **放大预算、保持推理**重试（绝不关推理：推理没了基本必错）。
      // 用户 2026-10-23："放开烧 token 就行了" —— 最多放大三档（32k → 64k → 128k）。
      let budget = opts.maxTokens;
      for (let round = 1; got && !got.text && withReasoning && got.finish === 'length' && round <= 3; round++) {
        const bigger = Math.min(budget * 2, 128_000);
        warn(
          `多模态返回空文本（推理吃满 max_tokens=${budget}，finish=${got.finish}，` +
            `reasoning=${got.reasoningChars} 字）→ 预算放大到 ${bigger}，推理保持 ${wantReasoning}`,
        );
        budget = bigger;
        got = await read(await call(model, true, budget));
        log(`多模态重试（预算 ${budget}）：len=${got?.text.length ?? 0} finish=${got?.finish ?? '?'}`);
        if (budget >= 128_000) break;
      }
      if (!got?.text) {
        warn(`多模态返回空文本（${opts.purpose}，finish=${got?.finish ?? '?'}）`);
        return null;
      }
      return got.text;
    } catch (e) {
      warn(`多模态调用失败（${opts.purpose}）：${(e as Error).message}`);
      return null;
    }
  };
  // 启动自检：连上了全局 LLM 运行时没有（只打日志，不影响功能）
  void (async () => {
    const rt = llmRuntime();
    if (!rt?.prepareCall) {
      log('LLM 通道：未发现全局 llm 运行时 → 检查将走直连兜底（凭据仍取全局 credentials）');
      return;
    }
    try {
      const providers = rt.listProviders?.() ?? [];
      const route = await resolveLlmRoute();
      log(
        `LLM 通道：全局 dsh 运行时可用（providers=${providers.map((p) => p.id).join(',') || '?'}，` +
          `当前路由=${route ? `${route.provider}/${route.model}` : '未解析（首次调用时再解析）'}）`,
      );
    } catch (e) {
      warn(`LLM 通道自检失败：${(e as Error).message}`);
    }
  })();

  // ============================================================
  // lecture 进度（只读另一模块的数据目录；读不到就省略这段）
  // ============================================================
  const lectureProgress = (): LectureProgress | null => {
    try {
      const root = isAbsolute(lectureDataDir) ? lectureDataDir : join(process.cwd(), lectureDataDir);
      if (!existsSync(root)) return null;
      let reviewed = 0;
      let total = 0;
      let latest: LectureProgress['latest'] = null;
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const idxFile = join(root, dir.name, 'index.json');
        if (!existsSync(idxFile)) continue;
        try {
          const idx = JSON.parse(readFileSync(idxFile, 'utf-8').replace(/^\uFEFF/, '')) as {
            units?: Array<{ id?: string; date?: string; title?: string; reviewed?: boolean }>;
          };
          for (const u of idx.units ?? []) {
            total++;
            if (u.reviewed) reviewed++;
            const date = String(u.date ?? '');
            if (!latest || date > latest.date) {
              latest = { unit: String(u.id ?? ''), title: String(u.title ?? ''), date };
            }
          }
        } catch {
          /* 单个课程索引坏掉不影响整体 */
        }
      }
      return total > 0 ? { reviewed, total, latest } : null;
    } catch {
      return null;
    }
  };

  // ============================================================
  // 学习进度摘要（D7：新开一套题时附上）
  // ============================================================
  const digestFor = (courseId: string, excludeSheetId?: string): DigestResult => {
    const sheets = store.listSheets(courseId).filter((s) => s.id !== excludeSheetId);
    const mistakes = store.readMistakes().filter((m) => !courseId || m.course_id === courseId);
    return buildProgressDigest({ sheets, mistakes, lecture: lectureProgress() });
  };

  /** 把最新摘要写进 sheet（开题时调用一次；之后不自动刷新——它是"当时"的快照）。 */
  const attachDigest = (courseId: string, sheet: Sheet): Sheet => {
    const d = digestFor(courseId, sheet.id);
    const next: Sheet = { ...sheet, progress_digest: d.text, progress_digest_at: Date.now() };
    store.writeSheet(courseId, next);
    return next;
  };

  // ============================================================
  // 导入 / 新建
  // ============================================================

  /**
   * 去掉题干开头那一行"题号标题"。
   *
   * 为什么：拆分器返回的 text 是**无损原文**（含 `Aufgabe 1 (4 Punkte)`），
   * 而界面已经把题号与分值渲染成徽章了 —— 题干里再出现一遍就是重复。
   * 只在首行确实以该 label 开头时才删，避免误删正文。
   */
  const stripHeadingLine = (text: string, label: string): string => {
    const lines = text.split(/\r?\n/);
    const first = (lines[0] ?? '').trim();
    if (!first) return text.trim();
    const norm = (v: string): string => v.replace(/\s+/g, ' ').trim();
    if (label && norm(first).startsWith(norm(label))) {
      return lines.slice(1).join('\n').trim();
    }
    // 没有 label 时也认一个"纯标题行"（`Aufgabe 2` / `2.` 开头且很短）
    if (/^(Aufgabe|Übung|Exercise|Problem|Task|Hausaufgabe|Aufg\.?)\s*\d+/i.test(first) && first.length < 80) {
      return lines.slice(1).join('\n').trim();
    }
    return text.trim();
  };

  /**
   * 切题：**先 LLM，再规则**。
   *
   * 用户实测：LaTeX 排版的 PDF 抽出来的文本用正则切基本没救
   * （题号与正文粘连、公式碎成散字母、分页把题劈开）。
   * 所以默认交给模型；模型不可用/输出不可信时退回规则，并把原因写进导入提示。
   */
  const splitProblemsFor = async (
    text: string,
    warnings: string[],
    pages: readonly VisionPage[] = [],
  ): Promise<{ parts: SplitProblem[]; by: 'vision' | 'llm' | 'rules' }> => {
    // ① 多模态读图（最准：公式/插图/多栏都不依赖 OCR）
    if (pages.length) {
      const vision = await segmentWithVision(pages, askVision, { lang: uiLang() });
      if (vision.ok) {
        const figs = vision.problems.filter((p) => p.has_figure === true).length;
        log(
          `多模态分块成功：${vision.problems.length} 题（${vision.pages} 页截图` +
            `${figs ? `，其中 ${figs} 题带图` : ''}）`,
        );
        return { parts: vision.problems, by: 'vision' };
      }
      warn(`多模态分块失败：${vision.error ?? '未知原因'}`);
      warnings.push(tr(`多模态读图分块失败（${vision.error ?? '未知原因'}）—— 已退回文本分块`, `Multimodal page reading failed (${vision.error ?? 'unknown reason'}) — fell back to text splitting`));
    }

    const trimmed = text.trim();
    if (!trimmed) return { parts: [], by: 'rules' };

    // ② 文本锚点分块（模型只给边界）
    const seg = await segmentWithLlm(trimmed, askLlm);
    if (seg.ok) {
      log(
        `LLM 分块成功：${seg.problems.length} 题（覆盖率 ${Math.round((seg.coverage ?? 1) * 100)}%，${seg.parts} 段）`,
      );
      return { parts: seg.problems, by: 'llm' };
    }
    warn(`LLM 分块失败：${seg.error ?? '未知原因'}`);
    warnings.push(tr(`LLM 分块不可用（${seg.error ?? '未知原因'}）—— 已用规则分块，可能需要在界面里手动调整`, `LLM splitting unavailable (${seg.error ?? 'unknown reason'}) — used rule-based splitting; you may need to adjust it in the UI`));

    // ③ 规则兜底
    const rules = splitProblems(trimmed);
    return { parts: rules, by: 'rules' };
  };

  /** 把 split 结果变成 Problem[]。 */
  const problemsFromSplit = (parts: readonly SplitProblem[]): Problem[] =>
    parts.map((p, i) => ({
      id: problemIdOf(i),
      label: p.label || `Aufgabe ${i + 1}`,
      title: p.title || deriveTitle(stripHeadingLine(p.text, p.label)),
      text: stripHeadingLine(p.text, p.label),
      points: p.points ?? parsePoints(p.text),
      page: p.page,
      has_figure: p.has_figure === true,
      figure_note: p.figure_note ?? '',
      answer: '',
      answer_updated_at: 0,
      answer_edited_by: 'user' as const,
      checks: [],
      rebuttals: [],
      images: [],
      mistakes: [],
      notes: '',
    }));

  interface ImportResult {
    ok: boolean;
    error?: string;
    sheet?: Sheet;
    warnings?: string[];
  }

  const importSheet = async (input: {
    courseId: string;
    courseTitle?: string;
    semester?: string;
    moduleCode?: string;
    number?: number;
    title?: string;
    issued?: string;
    due?: string;
    pdfBase64?: string;
    filename?: string;
    text?: string;
  }): Promise<ImportResult> => {
    const courseId = input.courseId.trim();
    if (!courseId) return { ok: false, error: tr('course_id 不能为空', 'course_id must not be empty') };
    const index = store.ensureCourse(courseId, input.courseTitle || courseId, input.semester ?? '', input.moduleCode ?? '');

    // 编号：指定就用指定的，否则沿用"最大 +1"
    const ident = input.number
      ? { number: input.number, id: `ub${String(input.number).padStart(2, '0')}` }
      : store.nextSheetIdentity(courseId);
    let sheetId = safeSheetId(ident.id);
    // 同号重复：加后缀而不是覆盖（覆盖会静默毁掉已经写好的答案）
    if (store.readSheet(courseId, sheetId)) {
      let n = 2;
      while (store.readSheet(courseId, `${sheetId}-b${n}`)) n++;
      sheetId = `${sheetId}-b${n}`;
      warn(`第 ${ident.number} 套已存在，导入为 ${sheetId}`);
    }

    const warnings: string[] = [];
    let pdfBytes: Uint8Array | null = null;
    if (input.pdfBase64) {
      try {
        const b64 = input.pdfBase64.includes(',') ? input.pdfBase64.slice(input.pdfBase64.indexOf(',') + 1) : input.pdfBase64;
        pdfBytes = Buffer.from(b64, 'base64');
        if (pdfBytes.byteLength > 24 * 1024 * 1024) return { ok: false, error: tr('PDF 太大（上限 24MB）', 'PDF is too large (24MB limit)') };
      } catch (e) {
        return { ok: false, error: tr(`base64 解码失败：${(e as Error).message}`, `base64 decoding failed: ${(e as Error).message}`) };
      }
    }

    let extracted: PdfExtractResult | null = null;
    let text = input.text ?? '';
    let rendered: RenderedPage[] = [];
    if (pdfBytes) {
      // ① 先渲染页面截图：多模态读图 + 界面"原题截图"都靠它（文本只是后备）
      try {
        rendered = await renderPdfPages(new Uint8Array(pdfBytes));
        log(`页面截图：${rendered.length} 页（${Math.round(rendered.reduce((n, p) => n + p.bytes.byteLength, 0) / 1024)} KB）`);
      } catch (e) {
        warnings.push(tr(`页面截图失败：${(e as Error).message}（将退回文本模式）`, `Page screenshot failed: ${(e as Error).message} (falling back to text mode)`));
        warn(`页面渲染失败：${(e as Error).message}`);
      }
      // ② 文本抽取（后备链路 + 检索/人可读）
      try {
        extracted = await extractPdfText(new Uint8Array(pdfBytes));
        warnings.push(...extracted.warnings);
        if (extracted.hasText) text = extracted.text;
        else warnings.push(tr('这份 PDF 抽不出文本（扫描件/纯图片/公式为主）—— 已改用页面截图读题', 'No extractable text in this PDF (scan/image/formula-only) — switched to reading page screenshots'));
      } catch (e) {
        warnings.push(tr(`PDF 文本解析失败：${(e as Error).message}`, `PDF text parsing failed: ${(e as Error).message}`));
      }
    }

    const visionPages: VisionPage[] = rendered.map((p) => ({
      page: p.page,
      mediaType: p.mediaType,
      base64: Buffer.from(p.bytes).toString('base64'),
    }));
    const segmented = await splitProblemsFor(text, warnings, visionPages);
    const parts = segmented.parts;
    if (text.trim() && parts.length === 0) {
      warnings.push(tr('没切出题目（多模态/LLM 与规则都没识别出题号）——整篇作为一道题导入，可手动拆', 'No problems detected (neither multimodal/LLM nor rules found a problem number) — imported the whole page as one problem; you can split it manually'));
    }
    let problems: Problem[] = problemsFromSplit(parts);
    if (!problems.length && text.trim()) {
      problems = problemsFromSplit([
        { label: 'Aufgabe 1', title: deriveTitle(text), text: text.trim(), page: 1, points: parsePoints(text) },
      ]);
    }

    const now = Date.now();
    const sheet: Sheet = {
      id: sheetId,
      number: ident.number,
      title: input.title ?? '',
      issued: input.issued ?? localDateString(new Date()),
      due: input.due ?? '',
      source_pdf: pdfBytes ? 'source.pdf' : '',
      source_pages: extracted?.pageCount || rendered.length,
      import_mode: pdfBytes ? 'pdf' : 'manual',
      split_by: problems.length ? segmented.by : 'manual',
      has_page_images: rendered.length > 0,
      imported_at: now,
      needs_manual_text: !!pdfBytes && !text.trim() && rendered.length === 0,
      progress_digest: '',
      progress_digest_at: 0,
      problems,
      lessons: [],
      submitted_at: 0,
      submission_pdf: '',
      submission_pages: 0,
      version: 1,
    };

    // 原卷 + 页面截图 + 文本存档
    if (pdfBytes) store.writeSourcePdf(courseId, sheet.id, pdfBytes);
    for (const page of rendered) store.writePageImage(courseId, sheet.id, page.page, page.bytes);
    if (text.trim()) store.writeSourceText(courseId, sheet.id, text);

    const withDigest = attachDigest(courseId, sheet);
    store.writeSheetMarkdown(courseId, withDigest);
    log(
      `导入完成：${courseId}/${sheet.id} 第 ${withDigest.number} 套，${withDigest.problems.length} 题` +
        `${pdfBytes ? `，原卷 ${withDigest.source_pages} 页` : '（手填）'}`,
    );
    return { ok: true, sheet: withDigest, warnings };
  };

  const createSheet = async (input: {
    courseId: string;
    courseTitle?: string;
    title?: string;
    due?: string;
    number?: number;
  }): Promise<{ ok: boolean; error?: string; sheet?: Sheet }> => {
    const index = store.readIndex(input.courseId) ?? store.ensureCourse(input.courseId, input.courseTitle || input.courseId);
    void index;
    const ident = input.number
      ? { number: input.number, id: `ub${String(input.number).padStart(2, '0')}` }
      : store.nextSheetIdentity(input.courseId);
    let sheetId = safeSheetId(ident.id);
    if (store.readSheet(input.courseId, sheetId)) {
      let n = 2;
      while (store.readSheet(input.courseId, `${sheetId}-b${n}`)) n++;
      sheetId = `${sheetId}-b${n}`;
    }
    const sheet: Sheet = {
      id: sheetId,
      number: ident.number,
      title: input.title ?? '',
      issued: localDateString(),
      due: input.due ?? '',
      source_pdf: '',
      source_pages: 0,
      import_mode: 'manual',
      split_by: 'manual',
      has_page_images: false,
      imported_at: Date.now(),
      needs_manual_text: false,
      progress_digest: '',
      progress_digest_at: 0,
      problems: [],
      lessons: [],
      submitted_at: 0,
      submission_pdf: '',
      submission_pages: 0,
      version: 1,
    };
    const withDigest = attachDigest(input.courseId, sheet);
    store.writeSheet(input.courseId, withDigest);
    log(`新建题集：${input.courseId}/${sheetId}（手填模式）`);
    return { ok: true, sheet: withDigest };
  };

  // ============================================================
  // 题目 / 答案
  // ============================================================

  interface UpdateProblemInput {
    courseId: string;
    sheetId: string;
    problemId: string;
    patch: { text?: string; title?: string; points?: number | null; answer?: string; notes?: string };
    editedBy?: 'user' | 'agent';
  }

  /**
   * 改题目/答案。
   *
   * ⚠️ 答案一改，**已有的检查结果全部标记 stale**（不删除）：
   *   检查是针对"当时那份答案"的结论；不标脏会让界面显示一个
   *   与当前答案无关的"正确/错误"徽章 —— 那比不给结论更误导。
   */
  const updateProblem = async (input: UpdateProblemInput): Promise<{ ok: boolean; error?: string; sheet?: Sheet; stale?: number }> => {
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return { ok: false, error: tr(`题集不存在: ${input.courseId}/${input.sheetId}`, `Sheet not found: ${input.courseId}/${input.sheetId}`) };
    const p = store.findProblem(sheet, input.problemId);
    if (!p) return { ok: false, error: tr(`题目不存在: ${input.problemId}`, `Problem not found: ${input.problemId}`) };

    let staled = 0;
    const nextAnswer = typeof input.patch.answer === 'string' ? input.patch.answer : p.answer;
    const answerChanged = normalizeAnswer(nextAnswer) !== normalizeAnswer(p.answer);
    if (answerChanged) {
      const sha = answerFingerprint(normalizeAnswer(nextAnswer));
      for (const c of p.checks) {
        if (!c.stale && c.answer_sha !== sha) {
          c.stale = true;
          staled++;
        }
      }
      p.answer = input.patch.answer ?? p.answer;
      p.answer_updated_at = Date.now();
      p.answer_edited_by = input.editedBy ?? 'user';
    }
    if (typeof input.patch.text === 'string' && input.patch.text !== p.text) {
      p.text = input.patch.text;
      if (!p.title || p.title === deriveTitle(p.text)) p.title = deriveTitle(p.text);
    }
    if (typeof input.patch.title === 'string') p.title = input.patch.title;
    if (input.patch.points !== undefined) p.points = input.patch.points;
    if (typeof input.patch.notes === 'string') p.notes = input.patch.notes;

    store.writeSheet(input.courseId, sheet);
    store.writeSheetMarkdown(input.courseId, sheet);
    if (staled) log(`答案已改（${input.problemId}）→ ${staled} 条旧检查标记过期`);
    return { ok: true, sheet, stale: staled };
  };

  const addProblem = async (input: { courseId: string; sheetId: string; label?: string; text?: string }) => {
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return { ok: false, error: tr('题集不存在', 'Sheet not found') };
    const text = (input.text ?? '').trim();
    const p: Problem = {
      id: problemIdOf(sheet.problems.length),
      label: input.label ?? `Aufgabe ${sheet.problems.length + 1}`,
      title: deriveTitle(text),
      text,
      points: parsePoints(text),
      page: 0,
      has_figure: false,
      figure_note: '',
      answer: '',
      answer_updated_at: 0,
      answer_edited_by: 'user',
      checks: [],
      rebuttals: [],
      images: [],
      mistakes: [],
      notes: '',
    };
    // 避免 id 冲突（删过题之后 length 可能与已用 id 重复）
    const used = new Set(sheet.problems.map((x) => x.id));
    let n = sheet.problems.length;
    while (used.has(problemIdOf(n))) n++;
    p.id = problemIdOf(n);
    sheet.problems.push(p);
    store.writeSheet(input.courseId, sheet);
    return { ok: true, sheet };
  };

  const deleteProblem = async (input: { courseId: string; sheetId: string; problemId: string }) => {
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return { ok: false, error: tr('题集不存在', 'Sheet not found') };
    const i = sheet.problems.findIndex((p) => p.id === input.problemId);
    if (i === -1) return { ok: false, error: tr('题目不存在', 'Problem not found') };
    sheet.problems.splice(i, 1);
    store.writeSheet(input.courseId, sheet);
    return { ok: true, sheet };
  };

  /**
   * 用 source.md 重新分块（用户改了原文之后）。**保留已有答案**（按 label 对齐）。
   *
   * `useLlm` 缺省 true：LaTeX 排版抽出来的文本用规则切基本切不准，
   * 所以界面上的「重新分块」默认走 LLM；想省 token 才用规则那一个按钮。
   */
  const resplit = async (input: { courseId: string; sheetId: string; useLlm?: boolean }) => {
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return { ok: false, error: tr('题集不存在', 'Sheet not found') };
    const text = store.readSourceText(input.courseId, input.sheetId) ?? '';
    let pageNumbers = store.listPageImages(input.courseId, input.sheetId);

    // 老题集（多模态之前导入的）只有 source.pdf、没有页面截图 ——
    // 重新分块时顺手**补渲染**，否则"点重新分块不会生成图片"（用户实测）。
    if (pageNumbers.length === 0 && store.hasSourcePdf(input.courseId, input.sheetId)) {
      try {
        const pdfBytes = readFileSync(store.sourcePdfFile(input.courseId, input.sheetId));
        const rendered = await renderPdfPages(new Uint8Array(pdfBytes));
        for (const page of rendered) store.writePageImage(input.courseId, input.sheetId, page.page, page.bytes);
        if (rendered.length) {
          sheet.has_page_images = true;
          sheet.source_pages = Math.max(sheet.source_pages, rendered.length);
          pageNumbers = rendered.map((p) => p.page);
          store.writeSheet(input.courseId, sheet);
          log(
            `补渲染页面截图：${rendered.length} 页（${Math.round(rendered.reduce((n, p) => n + p.bytes.byteLength, 0) / 1024)} KB）`,
          );
        }
      } catch (e) {
        warn(`补渲染页面截图失败：${(e as Error).message}（继续用文本分块）`);
      }
    }

    if (!text.trim() && pageNumbers.length === 0) {
      return { ok: false, error: tr('没有原文存档（source.md）也没有页面截图，无法重新分块', 'No source.md and no page images — cannot re-split') };
    }

    let parts: SplitProblem[];
    let by: 'vision' | 'llm' | 'rules' = 'rules';
    let note = '';
    if (input.useLlm !== false && pageNumbers.length > 0) {
      // 有原卷截图 → 多模态重切（最准；也顺手刷新 has_figure）
      const visionPages: VisionPage[] = pageNumbers.map((n) => {
        const img = store.readPageImage(input.courseId, input.sheetId, n)!;
        return { page: n, mediaType: img.mediaType, base64: img.bytes.toString('base64') };
      });
      const v = await segmentWithVision(visionPages, askVision, { lang: uiLang() });
      if (v.ok) {
        parts = v.problems;
        by = 'vision';
        log(`多模态重新分块：${parts.length} 题（${v.pages} 页截图）`);
      } else {
        warn(`多模态重新分块失败：${v.error ?? '未知原因'} → 退回文本`);
        note = `多模态读图失败（${v.error ?? '未知原因'}），已退回文本分块`;
        const seg = await segmentWithLlm(text, askLlm);
        if (seg.ok) {
          parts = seg.problems;
          by = 'llm';
        } else {
          warn(`文本重切也失败：${seg.error ?? '未知原因'} → 规则`);
          parts = splitProblems(text);
          by = 'rules';
        }
      }
    } else if (input.useLlm !== false) {
      const seg = await segmentWithLlm(text, askLlm);
      if (seg.ok) {
        parts = seg.problems;
        by = 'llm';
        log(`LLM 重新分块：${parts.length} 题（覆盖率 ${Math.round((seg.coverage ?? 1) * 100)}%）`);
      } else {
        warn(`LLM 重新分块失败：${seg.error ?? '未知原因'} → 退回规则`);
        note = `LLM 分块不可用（${seg.error ?? '未知原因'}），已用规则`;
        parts = splitProblems(text);
      }
    } else {
      parts = splitProblems(text);
    }
    if (!parts.length) return { ok: false, error: tr('没识别出题目（多模态/LLM 与规则都没有结果）', 'No problems recognised (neither multimodal/LLM nor rules produced a result)') };

    const fresh = problemsFromSplit(parts);
    // 按 label 对齐旧答案（题号是最稳的锚点；重新分块也不该丢答案）
    let kept = 0;
    for (const p of fresh) {
      const old = sheet.problems.find((o) => o.label === p.label);
      if (old && old.answer.trim()) {
        p.answer = old.answer;
        p.checks = old.checks;
        p.notes = old.notes;
        p.mistakes = old.mistakes;
        kept++;
      }
    }
    sheet.problems = fresh;
    sheet.split_by = by;
    store.writeSheet(input.courseId, sheet);
    log(`重新分块：${sheet.problems.length} 题（${by}，保留 ${kept} 题的答案）`);
    return { ok: true, sheet, used_llm: by !== 'rules', note };
  };

  // ============================================================
  // 极简模式（临时做题）：一个隐藏的 _scratch 工作区
  //
  // 用户："拓展一个极简模式用来临时做题…因为是临时的所以不需要多项目管理，
  //       有一个工作区然后可以手动 reset 就行了"。
  //
  // 做法：复用同一套 Sheet/Problem 模型，但放在 `_scratch` 课程下（列表里过滤掉），
  // 固定只有一道题；重置 = 覆盖成空 sheet + 删掉附图。
  // ============================================================

  const SCRATCH_COURSE = '_scratch';
  const SCRATCH_SHEET = 'ub01';
  const SCRATCH_PROBLEM = 'p01';

  const blankScratchSheet = (): Sheet => ({
    id: SCRATCH_SHEET,
    number: 1,
    title: '',
    issued: '',
    due: '',
    source_pdf: '',
    source_pages: 0,
    import_mode: 'manual',
    split_by: 'manual',
    has_page_images: false,
    imported_at: Date.now(),
    needs_manual_text: false,
    progress_digest: '',
    progress_digest_at: 0,
    problems: [
      {
        id: SCRATCH_PROBLEM,
        label: '',
        title: '',
        text: '',
        points: null,
        page: 0,
        has_figure: false,
        figure_note: '',
        answer: '',
        answer_updated_at: 0,
        answer_edited_by: 'user',
        checks: [],
        rebuttals: [],
        images: [],
        mistakes: [],
        notes: '',
      },
    ],
    lessons: [],
    submitted_at: 0,
    submission_pdf: '',
    submission_pages: 0,
    version: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
  } as Sheet);

  /** 取（必要时创建）极简工作区的 sheet。 */
  const scratchSheet = (): Sheet => {
    store.ensureCourse(SCRATCH_COURSE, tr('临时做题', 'Scratch'));
    const existing = store.readSheet(SCRATCH_COURSE, SCRATCH_SHEET);
    if (existing) {
      // 老数据/手改过的 JSON 可能没有题目 → 补一道空的，保证界面总有东西可写
      if (!existing.problems.length) {
        existing.problems = blankScratchSheet().problems;
        store.writeSheet(SCRATCH_COURSE, existing);
      }
      return existing;
    }
    const fresh = blankScratchSheet();
    store.writeSheet(SCRATCH_COURSE, fresh);
    return fresh;
  };

  /**
   * 极简模式：上传题目 PDF。
   *
   * 用户："我题目怎么上传啊" —— 书上/资料里的题往往是 PDF 或照片，不该逼着他手打。
   * 做法：抽文本（有文本就填进题目框）+ 渲染前两页当页面截图（检查时多模态以图为准）。
   */
  const importScratchPdf = async (input: { base64: string }): Promise<{
    ok: boolean;
    error?: string;
    sheet?: Sheet;
    text_length?: number;
    pages?: number;
  }> => {
    const sheet = scratchSheet();
    const p = sheet.problems[0];
    if (!p) return { ok: false, error: tr('极简工作区没有题目', 'Scratch has no problem') };
    const raw = (input.base64 ?? '').replace(/^data:[^;]+;base64,/, '').trim();
    if (!raw) return { ok: false, error: tr('没有 PDF 数据', 'No PDF data') };
    const bytes = Buffer.from(raw, 'base64');
    if (!bytes.length) return { ok: false, error: tr('PDF 为空', 'Empty PDF') };

    const extracted = await extractPdfText(bytes);
    let pages = 0;
    try {
      const rendered = await renderPdfPages(bytes, { maxPages: 4 });
      for (const pg of rendered) {
        store.writePageImage(SCRATCH_COURSE, SCRATCH_SHEET, pg.page, pg.bytes);
        pages++;
      }
    } catch (e) {
      warn(`极简模式：PDF 页面渲染失败（仍可用文本）：${(e as Error).message}`);
    }
    if (extracted.hasText) p.text = extracted.text.slice(0, 12_000).trim();
    sheet.has_page_images = pages > 0;
    store.writeSheet(SCRATCH_COURSE, sheet);
    log(`极简模式：导入题目 PDF（${extracted.pageCount} 页，文本 ${p.text.length} 字，截图 ${pages} 张）`);
    return { ok: true, sheet, text_length: p.text.length, pages };
  };
  /**
   * 思路检查（**可重复、临时**，不落盘）。
   *
   * 用户 2026-10-28："做题做一半的时候 LLM 检查做题思路和路径，避免让 llm 写出解题方法，
   *   只要指出错误点，避免白白浪费时间科技树点歪，尽量保守提示。"
   * 之后又澄清："人工激活，不是说做到一半检查一次，就加一个检查思路的可重复执行就行了，
   *   输出就临时的不要一直占用前端篇幅，但是也不要一改内容就消失，毕竟要看着改的，
   *   就人工重置就行了。"
   *
   * 因此：不发自动触发、不写 sheet.json、不进错题本 —— 只把当前草稿和题目交给模型，
   * 返回一份临时结果，前端自己拿在手里，直到用户点「清除」。
   */
  const checkApproach = async (input: {
    courseId: string;
    sheetId: string;
    problemId: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    verdict?: string;
    issues?: Array<{ severity: string; text: string }>;
    note?: string;
    model?: string;
    provider?: string;
    reasoning?: string;
  }> => {
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return { ok: false, error: tr('题集不存在', 'Sheet not found') };
    const p = store.findProblem(sheet, input.problemId);
    if (!p) return { ok: false, error: tr('题目不存在', 'Problem not found') };
    const draft = (p.answer ?? '').trim();
    if (!draft) return { ok: false, error: tr('答案还是空的 —— 先写两行思路再来检查', 'The answer is empty - write a couple of lines first') };

    const course = store.readIndex(input.courseId);
    const pageNumbers = store.listPageImages(input.courseId, input.sheetId);
    const pageNos =
      input.courseId === SCRATCH_COURSE
        ? pageNumbers.slice(0, 4)
        : (p.page > 0 ? [p.page, p.page + 1] : pageNumbers.slice(0, 1)).filter((n) => pageNumbers.includes(n));
    const pageImages: Array<{ base64: string; mediaType: string; page: number }> = [];
    for (const n of pageNos) {
      const got = store.readPageImage(input.courseId, input.sheetId, n);
      if (got) pageImages.push({ base64: got.bytes.toString('base64'), mediaType: got.mediaType, page: n });
    }
    const readImages = (role: 'problem' | 'answer'): Array<{ base64: string; mediaType: string; name: string }> =>
      p.images
        .filter((img) => (role === 'problem' ? img.role === 'problem' : img.role !== 'problem'))
        .slice(0, 3)
        .map((img) => {
          const got = store.readImage(input.courseId, input.sheetId, img.name);
          return got ? { base64: got.bytes.toString('base64'), mediaType: got.mediaType, name: img.name } : null;
        })
        .filter((x): x is { base64: string; mediaType: string; name: string } => !!x);

    const result = await runApproach(
      {
        courseTitle: course?.title ?? input.courseId,
        sheetNumber: sheet.number,
        sheetTitle: sheet.title,
        problemLabel: p.label || p.id,
        problemTitle: p.title,
        points: p.points,
        problemText: p.text,
        draft,
        notes: p.notes,
        statementImages: readImages('problem'),
        pageImages,
        answerImages: readImages('answer'),
        lang: uiLang(),
      },
      askViaRuntime,
      askVision,
    );
    if (!result.ok || !result.parsed) {
      warn(`思路检查失败（${p.id}）：${result.error}`);
      return { ok: false, error: result.error ?? tr('模型没返回可解析的结果', 'Unparseable model output') };
    }
    log(`思路检查（${p.id}）：${result.parsed.verdict} · ${result.parsed.issues.length} 条`);
    return {
      ok: true,
      verdict: result.parsed.verdict,
      issues: result.parsed.issues,
      note: result.parsed.note,
      model: llm.model,
      provider: llmProvider(),
      reasoning: llmReasoningState(),
    };
  };
  /** 重置极简工作区：清空题目/答案/检查/附图。 */
  const resetScratch = (): Sheet => {
    const fresh = blankScratchSheet();
    // 删掉旧附图（它们挂在旧 sheet 目录下）
    const imgDir = store.imagesDir(SCRATCH_COURSE, SCRATCH_SHEET);
    if (existsSync(imgDir)) {
      try {
        rmSync(imgDir, { recursive: true, force: true });
      } catch {
        /* 删不掉不影响重置 */
      }
    }
    store.writeSheet(SCRATCH_COURSE, fresh);
    log('极简工作区已重置');
    return fresh;
  };
  // ============================================================
  // 手动检查（D3）
  // ============================================================

  const checkProblem = async (input: {
    courseId: string;
    sheetId: string;
    problemId: string;
  }): Promise<{ ok: boolean; error?: string; check?: Check; sheet?: Sheet; mistake?: Mistake }> => {
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return { ok: false, error: tr('题集不存在', 'Sheet not found') };
    const p = store.findProblem(sheet, input.problemId);
    if (!p) return { ok: false, error: tr('题目不存在', 'Problem not found') };
    if (!p.answer.trim() && !p.notes.trim()) {
      return { ok: false, error: tr('还没有答案 —— 先自己写点什么（哪怕写错）再检查，检查不是替你做题', 'No answer yet — write something yourself first (even if wrong), then check. The check is not there to solve it for you') };
    }

    const course = store.readIndex(input.courseId);
    // 历史错题只作为"过去"的参考：**排除本题自己** —— 用户改了答案之后，
    // 若把本题的旧错题也塞进去，模型会继续按旧错误批（"改了还说我有原来的错误"）。
    const prior = store
      .readMistakes()
      .filter((m) => !m.mastered && m.course_id === input.courseId && !(m.sheet_id === input.sheetId && m.problem_id === p.id))
      .slice(0, 3)
      .map((m) => `${m.problem_label || m.problem_id}：${m.lesson || m.issues.join('；')}`);

    // 有原卷截图就带上：OCR 漏掉的公式/插图在图上还在（多模态检查）。
    // **跨页**：一道题常常写满两页 → 极简模式把前 4 页都带上；普通套题带 p.page 和下一页。
    const pageNumbers = store.listPageImages(input.courseId, input.sheetId);
    const pageNos =
      input.courseId === SCRATCH_COURSE
        ? pageNumbers.slice(0, 4)
        : (p.page > 0 ? [p.page, p.page + 1] : pageNumbers.slice(0, 1)).filter((n) => pageNumbers.includes(n));
    const pageImages: Array<{ base64: string; mediaType: string; page: number }> = [];
    for (const n of pageNos) {
      const got = store.readPageImage(input.courseId, input.sheetId, n);
      if (got) pageImages.push({ base64: got.bytes.toString('base64'), mediaType: got.mediaType, page: n });
    }
    if (pageImages.length) log(`检查附带原图：第 ${pageImages.map((i) => i.page).join('、')} 页（多模态）`);
    // 学生自己画的手画图（受力图/草图）也要看：最多 3 张，避免请求过大
    const readImages = (role: 'problem' | 'answer'): Array<{ base64: string; mediaType: string; name: string }> =>
      p.images
        .filter((img) => (role === 'problem' ? img.role === 'problem' : img.role !== 'problem'))
        .slice(0, 3)
        .map((img) => {
          const got = store.readImage(input.courseId, input.sheetId, img.name);
          return got ? { base64: got.bytes.toString('base64'), mediaType: got.mediaType, name: img.name } : null;
        })
        .filter((x): x is { base64: string; mediaType: string; name: string } => !!x);
    const statementImages = readImages('problem');
    const answerImages = readImages('answer');
    if (statementImages.length) log(`检查附带题目截图：${statementImages.length} 张`);
    if (answerImages.length) log(`检查附带手画图：${answerImages.length} 张`);

    const result = await runCheck(
      {
        courseTitle: course?.title ?? input.courseId,
        sheetNumber: sheet.number,
        sheetTitle: sheet.title,
        problemLabel: p.label || p.id,
        problemTitle: p.title,
        points: p.points,
        problemText: p.text,
        answer: p.answer,
        notes: p.notes,
        progressDigest: sheet.progress_digest,
        priorMistakes: prior,
        lang: uiLang(),
        reasoning: checkReasoning,
        statementImages,
        answerImages,
        pageImages,
      },
      askLlm,
      askVision,
    );

    const now = Date.now();
    const check: Check = {
      id: `c${now.toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
      created_at: now,
      model: llm.model,
      verdict: result.check?.verdict ?? 'error',
      score: result.check?.score ?? null,
      issues: result.check?.issues ?? [],
      hints: result.check?.hints ?? [],
      next_steps: result.check?.next_steps ?? [],
      raw: (result.raw ?? '').slice(0, 4000),
      answer_sha: answerFingerprint(normalizeAnswer(p.answer)),
      stale: false,
      provider: llmProvider(),
      reasoning: llmReasoningState(),
      withdrawn: [],
      remaining: [],
      rebutted_at: 0,
    };
    p.checks.push(check);
    store.writeSheet(input.courseId, sheet);

    if (!result.ok) {
      warn(`检查失败（${p.id}）：${result.error}`);
      return { ok: false, error: result.error, check, sheet };
    }

    // 错 → 自动进错题本（可手动删/标注；autoCollectMistakes=false 时只提示）
    // 极简模式（临时做题）不进错题本：没有多项目管理，错题本只会变成垃圾场。
    let mistake: Mistake | undefined;
    if (input.courseId !== SCRATCH_COURSE && shouldCollectMistake(p.checks)) {
      if (autoCollect) {
        mistake =
          collectMistakeInternal({
            courseId: input.courseId,
            sheetId: input.sheetId,
            problemId: p.id,
            lesson: '',
            tags: [],
          }) ?? undefined;
        log(`检查 verdict=${check.verdict} → 已加入错题本（${mistake?.id}）`);
      } else {
        log(`检查 verdict=${check.verdict} → 建议加入错题本（autoCollect 关闭）`);
      }
    }

    store.writeSheetMarkdown(input.courseId, sheet);
    return { ok: true, check, sheet, mistake };
  };

  // ============================================================
  // 答案附图（手画示意图）：存在 <sheet>/images/，检查/PDF/界面都带
  // ============================================================


  const addAttachment = async (input: {
    courseId: string;
    sheetId: string;
    problemId: string;
    base64: string;
    caption?: string;
    /** 题目截图 or 答案附图（默认 answer） */
    role?: 'answer' | 'problem';
  }): Promise<{ ok: boolean; error?: string; image?: ProblemImage; sheet?: Sheet }> => {
    // 极简模式：第一次上传时工作区可能还没创建 → 按需建好，别让用户看到"题集不存在"
    if (input.courseId === SCRATCH_COURSE) scratchSheet();
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return { ok: false, error: tr('题集不存在', 'Sheet not found') };
    const p = store.findProblem(sheet, input.problemId);
    if (!p) return { ok: false, error: tr('题目不存在', 'Problem not found') };
    if (p.images.length >= 8) return { ok: false, error: tr('这题最多 8 张图（够画示意图了）', 'At most 8 images per problem (enough for a sketch)') };

    const raw = (input.base64 ?? '').replace(/^data:[^;]+;base64,/, '').trim();
    if (!raw) return { ok: false, error: tr('没有图片数据', 'No image data') };
    let bytes: Buffer;
    try {
      bytes = Buffer.from(raw, 'base64');
    } catch {
      return { ok: false, error: tr('图片 base64 解析失败', 'Could not parse the image base64') };
    }
    if (!bytes.length) return { ok: false, error: tr('图片为空', 'Image is empty') };
    if (bytes.length > 10 * 1024 * 1024) return { ok: false, error: tr('单张图片超过 10MB —— 截图/压缩一下再传', 'A single image exceeds 10MB — screenshot/compress it and try again') };
    const kind = sniffImageType(bytes);
    if (!kind) return { ok: false, error: tr('只支持 PNG / JPEG / WebP / GIF', 'Only PNG / JPEG / WebP / GIF are supported') };

    const now = Date.now();
    const name = `img-${now.toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}.${kind.ext}`;
    store.writeImage(input.courseId, input.sheetId, name, bytes);
    const image: ProblemImage = {
      id: `im${now.toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
      name,
      media_type: kind.media,
      bytes: bytes.length,
      caption: (input.caption ?? '').trim().slice(0, 200),
      role: input.role === 'problem' ? 'problem' : 'answer',
      created_at: now,
    };
    p.images.push(image);
    store.writeSheet(input.courseId, sheet);
    store.writeSheetMarkdown(input.courseId, sheet);
    log(`附图：${p.label || p.id} + ${name}（${Math.round(bytes.length / 1024)} KB）`);
    return { ok: true, image, sheet };
  };

  const deleteAttachment = async (input: {
    courseId: string;
    sheetId: string;
    problemId: string;
    imageId: string;
  }): Promise<{ ok: boolean; error?: string; sheet?: Sheet }> => {
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return { ok: false, error: tr('题集不存在', 'Sheet not found') };
    const p = store.findProblem(sheet, input.problemId);
    if (!p) return { ok: false, error: tr('题目不存在', 'Problem not found') };
    const idx = p.images.findIndex((i) => i.id === input.imageId);
    if (idx < 0) return { ok: false, error: tr('图片不存在', 'Image not found') };
    const [gone] = p.images.splice(idx, 1);
    if (gone) store.deleteImage(input.courseId, input.sheetId, gone.name);
    store.writeSheet(input.courseId, sheet);
    store.writeSheetMarkdown(input.courseId, sheet);
    return { ok: true, sheet };
  };
  // ============================================================
  // 答辩（学生 vs 批改）：让模型重新独立推导，必须承认或给出证据
  // ============================================================

  const rebutProblem = async (input: {
    courseId: string;
    sheetId: string;
    problemId: string;
    text: string;
  }): Promise<{ ok: boolean; error?: string; rebuttal?: Rebuttal; sheet?: Sheet; check?: Check }> => {
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return { ok: false, error: tr('题集不存在', 'Sheet not found') };
    const p = store.findProblem(sheet, input.problemId);
    if (!p) return { ok: false, error: tr('题目不存在', 'Problem not found') };
    const text = input.text.trim();
    if (!text) return { ok: false, error: tr('写点你要答辩的内容（"这一步为什么对"）', 'Write what you are rebutting ("why this step is correct")') };
    const target = lastFreshCheck(p.checks) ?? p.checks.at(-1) ?? null;
    if (!target) return { ok: false, error: tr('这题还没检查过 —— 先让爱弥斯检查一次，再来答辩', 'This problem has not been checked yet — ask Aemeath to check it first, then rebut') };

    const course = store.readIndex(input.courseId);
    const pageNumbers = store.listPageImages(input.courseId, input.sheetId);
    const pageNos =
      input.courseId === SCRATCH_COURSE
        ? pageNumbers.slice(0, 4)
        : (p.page > 0 ? [p.page, p.page + 1] : pageNumbers.slice(0, 1)).filter((n) => pageNumbers.includes(n));
    const pageImages: Array<{ base64: string; mediaType: string; page: number }> = [];
    for (const n of pageNos) {
      const got = store.readPageImage(input.courseId, input.sheetId, n);
      if (got) pageImages.push({ base64: got.bytes.toString('base64'), mediaType: got.mediaType, page: n });
    }
    const answerImages = p.images
      .filter((img) => img.role !== 'problem')
      .slice(0, 3)
      .map((img) => {
        const got = store.readImage(input.courseId, input.sheetId, img.name);
        return got ? { base64: got.bytes.toString('base64'), mediaType: got.mediaType, name: img.name } : null;
      })
      .filter((x): x is { base64: string; mediaType: string; name: string } => !!x);
    const statementImages = p.images
      .filter((img) => img.role === 'problem')
      .slice(0, 3)
      .map((img) => {
        const got = store.readImage(input.courseId, input.sheetId, img.name);
        return got ? { base64: got.bytes.toString('base64'), mediaType: got.mediaType, name: img.name } : null;
      })
      .filter((x): x is { base64: string; mediaType: string; name: string } => !!x);

    const result = await runRebuttal(
      {
        check: {
          courseTitle: course?.title ?? input.courseId,
          sheetNumber: sheet.number,
          sheetTitle: sheet.title,
          problemLabel: p.label || p.id,
          problemTitle: p.title,
          points: p.points,
          problemText: p.text,
          answer: p.answer,
          notes: p.notes,
          progressDigest: sheet.progress_digest,
          lang: uiLang(),
          statementImages,
          answerImages,
          pageImages,
        },
        previous: { verdict: target.verdict, issues: target.issues },
        userText: text,
        history: p.rebuttals.slice(-4).map((r) => ({ user: r.user_text, ai: r.reply, outcome: r.outcome })),
        reasoning: checkReasoning,
      },
      askLlm,
      askVision,
    );

    if (!result.ok || !result.rebuttal) return { ok: false, error: result.error ?? tr('答辩失败', 'Rebuttal failed') };

    const now = Date.now();
    const rb: Rebuttal = {
      id: `rb${now.toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
      created_at: now,
      user_text: text,
      reply: result.rebuttal.reply,
      outcome: result.rebuttal.outcome,
      withdrawn: result.rebuttal.withdrawn,
      correct_parts: result.rebuttal.correct_parts,
      remaining: result.rebuttal.remaining,
      check_id: target.id,
      model: llmProvider(),
    };
    p.rebuttals.push(rb);

    // 被撤回的 issue 记在那次检查上（UI 划掉；原始记录保留，可追溯）
    const merged = {
      withdrawn: [...new Set([...target.withdrawn, ...rb.withdrawn])],
      remaining: rb.remaining,
      rebutted_at: now,
    };
    for (const c of p.checks) {
      if (c.id !== target.id) continue;
      c.withdrawn = merged.withdrawn;
      c.remaining = merged.remaining;
      c.rebutted_at = merged.rebutted_at;
    }
    target.withdrawn = merged.withdrawn;
    target.remaining = merged.remaining;
    target.rebutted_at = merged.rebutted_at;

    // 爱弥斯认错 → 该题错题自动标"已掌握"（否则错题本永远挂着一条被撤回的"错误"）
    if (rb.outcome === 'conceded') {
      const m = store.findMistakeFor(input.courseId, input.sheetId, p.id);
      if (m) {
        m.mastered = true;
        m.updated_at = now;
        m.lesson = m.lesson || '答辩后确认：原批改有误，答案本身是对的';
        store.writeMistakes(store.readMistakes().map((x) => (x.id === m.id ? m : x)));
        log(`答辩撤回批改 → 错题 ${m.id} 标为已掌握`);
      }
    }

    store.writeSheet(input.courseId, sheet);
    store.writeSheetMarkdown(input.courseId, sheet);
    log(`答辩：outcome=${rb.outcome}（撤回 ${rb.withdrawn.length} 条，保留 ${rb.remaining.length} 条）`);
    return { ok: true, rebuttal: rb, sheet, check: target };
  };

  // ============================================================
  // 错题本
  // ============================================================

  const collectMistakeInternal = (input: {
    courseId: string;
    sheetId: string;
    problemId: string;
    lesson?: string;
    tags?: string[];
  }): Mistake | null => {
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return null;
    const p = store.findProblem(sheet, input.problemId);
    if (!p) return null;
    const course = store.readIndex(input.courseId);
    const existing = store.findMistakeFor(input.courseId, input.sheetId, p.id);
    const check = lastFreshCheck(p.checks) ?? p.checks.at(-1) ?? null;
    const now = Date.now();
    const tags = (input.tags ?? []).length
      ? input.tags!
      : [
          ...new Set(
            [
              sheet.title || `Übungsblatt ${sheet.number}`,
              ...(course?.title ? [course.title] : []),
            ].filter(Boolean),
          ),
        ].slice(0, 4);
    const m: Mistake = existing ?? {
      id: mistakeIdAt(now, store.readMistakes().length + 1),
      course_id: input.courseId,
      course_title: course?.title ?? input.courseId,
      sheet_id: sheet.id,
      sheet_title: `Übungsblatt ${sheet.number}${sheet.title ? ` ${sheet.title}` : ''}`,
      sheet_due: sheet.due,
      problem_id: p.id,
      problem_label: p.label || p.id,
      problem_text: p.text.slice(0, 4000),
      answer: p.answer.slice(0, 4000),
      verdict: check?.verdict ?? 'wrong',
      issues: (check?.issues ?? []).map((i) => i.text).slice(0, 6),
      tags,
      // 这里不能用 `existing?.lesson` —— TS 在本分支已把 existing 收窄成 null
      //（`existing ?? {...}` 的右操作数只在 existing 为 null 时求值），写出来恒为空。
      lesson: input.lesson ?? '',
      created_at: now,
      updated_at: now,
      review_count: 0,
      mastered: false,
      in_worldbook: false,
      source_check_id: check?.id ?? '',
    };
    // 已存在则刷新"当时错在哪"的最新证据（但保留用户写的 lesson / tags 选择）
    if (existing) {
      m.answer = p.answer.slice(0, 4000);
      m.verdict = check?.verdict ?? existing.verdict;
      m.issues = (check?.issues ?? []).map((i) => i.text).slice(0, 6);
      m.source_check_id = check?.id ?? existing.source_check_id;
      m.updated_at = now;
    }
    if (input.lesson) m.lesson = input.lesson.slice(0, 2000);
    if (input.tags?.length) m.tags = input.tags.slice(0, 8);
    store.upsertMistake(m);
    if (!p.mistakes.includes(m.id)) {
      p.mistakes.push(m.id);
      store.writeSheet(input.courseId, sheet);
    }
    log(`错题本 +1：${m.id}（${m.course_id}/${m.sheet_id}/${m.problem_id}）`);
    return m;
  };

  // ============================================================
  // 经验（lessons）
  // ============================================================

  const lessons = async (input: {
    op: 'add' | 'update' | 'delete';
    courseId: string;
    sheetId: string;
    lessonId?: string;
    text?: string;
    tags?: string[];
  }) => {
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!sheet) return { ok: false, error: tr('题集不存在', 'Sheet not found') };
    if (input.op === 'add') {
      const text = (input.text ?? '').trim();
      if (!text) return { ok: false, error: tr('经验内容为空', 'Lesson content is empty') };
      const lesson: Lesson = {
        id: `l${Date.now().toString(36)}`,
        text: text.slice(0, 2000),
        tags: (input.tags ?? []).slice(0, 6),
        source: 'user',
        created_at: Date.now(),
        in_worldbook: false,
      };
      sheet.lessons.push(lesson);
    } else {
      const i = sheet.lessons.findIndex((l) => l.id === input.lessonId);
      if (i === -1) return { ok: false, error: tr('经验条目不存在', 'Lesson not found') };
      if (input.op === 'delete') {
        sheet.lessons.splice(i, 1);
      } else {
        if (input.text !== undefined) {
          sheet.lessons[i]!.text = input.text.slice(0, 2000);
          sheet.lessons[i]!.in_worldbook = false; // 内容变了要重新同步
        }
        if (input.tags) sheet.lessons[i]!.tags = input.tags.slice(0, 6);
      }
    }
    store.writeSheet(input.courseId, sheet);
    store.writeSheetMarkdown(input.courseId, sheet);
    return { ok: true, sheet };
  };

  // ============================================================
  // worldbook 同步（错题教训 + 经验）
  // ============================================================

  const syncWorldbook = async (input: { courseId?: string; sheetId?: string }) => {
    const courses = input.courseId ? [input.courseId] : store.listCourses();
    if (!courses.length) return fail('还没有课程');
    const entries = [];
    const touchedLessons: Array<{ courseId: string; sheet: Sheet; lesson: Lesson }> = [];
    const touchedMistakes: Mistake[] = [];
    for (const cid of courses) {
      const course = store.readIndex(cid);
      if (!course) continue;
      for (const sheet of store.listSheets(cid)) {
        if (input.sheetId && sheet.id !== input.sheetId) continue;
        for (const lesson of sheet.lessons) {
          if (lesson.in_worldbook) continue;
          const e = lessonToEntry(course.title, sheet, lesson);
          if (e) {
            entries.push(e);
            touchedLessons.push({ courseId: cid, sheet, lesson });
          }
        }
      }
    }
    for (const m of store.readMistakes()) {
      if (m.in_worldbook) continue;
      if (input.courseId && m.course_id !== input.courseId) continue;
      if (input.sheetId && m.sheet_id !== input.sheetId) continue;
      const e = mistakeToEntry(m);
      if (e) {
        entries.push(e);
        touchedMistakes.push(m);
      }
    }
    if (!entries.length) {
      return ok({ written: 0, skipped: 0, failed: 0, note: '没有新的经验/错题教训需要同步' });
    }
    const r = appendWorldbookEntries(worldbookDir, entries);
    if (r.failed && !r.written) {
      return fail(`世界书写入失败：${r.errors[0] ?? '未知错误'}`, {
        worldbook_dir: worldbookDir,
        written: 0,
      });
    }
    // 只有真正写进去（或已存在）的才 mark，避免"标了但没写"
    for (const t of touchedLessons) {
      t.lesson.in_worldbook = true;
      store.writeSheet(t.courseId, t.sheet);
    }
    for (const m of touchedMistakes) store.patchMistake(m.id, { in_worldbook: true });
    log(`worldbook 同步：写入 ${r.written} 条，已存在 ${r.skipped} 条，失败 ${r.failed} 条 → ${worldbookDir}`);
    return ok({
      written: r.written,
      skipped: r.skipped,
      failed: r.failed,
      worldbook_dir: worldbookDir,
      details: r.errors.slice(0, 5),
      note: 'worldbook 热重载 ≤3s 生效（主 agent 讲同类题时会主动提起）',
    });
  };

  // ============================================================
  // 提交 PDF
  // ============================================================

  const submissionProblemsOf = (courseId: string, sheet: Sheet): SubmissionProblem[] =>
    sheet.problems.map((p) => ({
      label: p.label || p.id,
      title: p.title,
      text: p.text,
      points: p.points,
      answer: p.answer,
      verdict: lastFreshCheck(p.checks)?.verdict ?? null,
      note: p.notes,
      // 附图：读成 data URI 内联（PDF 走 file://，不能引用 http 资源）。
      // 题干截图（role=problem）印在题目下面，解答附图印在 Lösung 下面。
      statementImages: p.images
        .filter((img) => img.role === 'problem')
        .map((img) => {
          const got = store.readImage(courseId, sheet.id, img.name);
          return got
            ? { name: img.name, caption: img.caption, dataUri: `data:${got.mediaType};base64,${got.bytes.toString('base64')}` }
            : null;
        })
        .filter((x): x is { name: string; caption: string; dataUri: string } => !!x),
      images: p.images
        .filter((img) => img.role !== 'problem')
        .map((img) => {
          const got = store.readImage(courseId, sheet.id, img.name);
          return got
            ? { name: img.name, caption: img.caption, dataUri: `data:${got.mediaType};base64,${got.bytes.toString('base64')}` }
            : null;
        })
        .filter((x): x is { name: string; caption: string; dataUri: string } => !!x),
    }));

  const printHtmlOf = (courseId: string, sheetId: string, opts: { draft: boolean }): { ok: true; html: string } | { ok: false; error: string } => {
    const course = store.readIndex(courseId);
    const sheet = store.readSheet(courseId, sheetId);
    if (!course || !sheet) return { ok: false, error: tr('课程或题集不存在', 'Course or sheet not found') };
    const html = buildSubmissionHtml({
      courseTitle: course.title,
      courseId: course.course_id,
      sheet: { id: sheet.id, number: sheet.number, title: sheet.title, issued: sheet.issued, due: sheet.due },
      problems: submissionProblemsOf(courseId, sheet),
      lessons: opts.draft ? sheet.lessons.map((l) => l.text) : [],
      studentName,
      mathAssetsBase: ASSETS_PREFIX,
      lang: 'de',
      renderMath: renderMathToHtml,
      inlineCss: katexCssInlined(),
    });
    return { ok: true, html };
  };

  const buildSubmission = async (input: {
    courseId: string;
    sheetId: string;
    includeSource?: boolean;
    order?: 'sheet-first' | 'solutions-first';
    draft?: boolean;
  }) => {
    const course = store.readIndex(input.courseId);
    const sheet = store.readSheet(input.courseId, input.sheetId);
    if (!course || !sheet) return { ok: false, error: tr('课程或题集不存在', 'Course or sheet not found') } as const;
    if (!sheet.problems.length) return { ok: false, error: tr('这套题还没有题目', 'This sheet has no problems yet') } as const;

    const built = printHtmlOf(input.courseId, input.sheetId, { draft: input.draft ?? false });
    if (!built.ok) return { ok: false, error: built.error } as const;

    // 打印页落到 temp/（gitignored），file:// 打开时不需要 dsh 认证 cookie
    const tmpDir = isAbsolute('temp/exercise') ? 'temp/exercise' : join(process.cwd(), 'temp', 'exercise');
    try {
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    } catch {
      /* 忽略：后面写文件会报错 */
    }
    const htmlFile = join(tmpDir, `${input.courseId}-${input.sheetId}.html`);
    try {
      writeFileSync(htmlFile, built.html, 'utf-8');
    } catch (e) {
      return { ok: false, error: tr(`写打印页失败：${(e as Error).message}`, `Failed to write the print page: ${(e as Error).message}`) } as const;
    }

    const outPdf = store.submissionFile(input.courseId, input.sheetId, sheet);
    const includeSource = input.includeSource ?? includeSourceDefault;
    const sheetPdf = includeSource && store.hasSourcePdf(input.courseId, input.sheetId)
      ? store.sourcePdfFile(input.courseId, input.sheetId)
      : undefined;

    const chrome = findChromium(config.chromePath ? [config.chromePath] : undefined);
    if (!chrome) {
      return {
        ok: false,
        error: tr(
          '没找到 Chrome / Edge / Chromium —— 无法自动生成 PDF。\n可以：① 装一个 Chrome/Edge；② 或者在设置里填 chromePath；\n③ 或者用下面的打印页在浏览器里「打印 → 另存为 PDF」（本机浏览器一定有）。',
          'No Chrome / Edge / Chromium found — cannot generate the PDF automatically.\nOptions: 1) install Chrome/Edge; 2) set chromePath in the settings;\n3) use the print page below and choose “Print → Save as PDF” in your browser (every machine has a browser).',
        ),
        print_url: `/aemeath/api/exercise/print?course=${encodeURIComponent(input.courseId)}&sheet=${encodeURIComponent(input.sheetId)}&draft=0&autoprint=1`,
      } as const;
    }

    const res = await renderSubmissionPdf({
      url: `file:///${htmlFile.replace(/\\/g, '/')}`,
      outPdf,
      sheetPdf,
      order: input.order ?? (submissionOrder as 'sheet-first' | 'solutions-first'),
      chromePath: chrome.path,
      log,
      warn,
    });

    if (!res.ok) {
      return {
        ok: false,
        error: tr(`PDF 生成失败：${res.error ?? '未知错误'}`, `PDF generation failed: ${res.error ?? 'unknown error'}`),
        print_url: `/aemeath/api/exercise/print?course=${encodeURIComponent(input.courseId)}&sheet=${encodeURIComponent(input.sheetId)}&autoprint=1`,
        command: res.command ?? '',
      } as const;
    }

    sheet.submitted_at = Date.now();
    sheet.submission_pdf = outPdf.split(/[\\/]/).pop() ?? submissionFileName(input.courseId, sheet);
    sheet.submission_pages = res.pages ?? 0;
    store.writeSheet(input.courseId, sheet);
    store.writeSheetMarkdown(input.courseId, sheet);

    // 公式里有没有 KaTeX 不认识的命令（讲义 MathLive 宏已在渲染期归一，
    // 这里抓的是"归一之后仍然解析不了"的）：PDF 会和预览一样显示红字，
    // 至少要让用户知道是哪个命令、该写成什么。
    const mathWarnings: string[] = [];
    for (const p of sheet.problems) {
      const issues = collectMathIssuesInText(`${p.text}\n${p.answer}`, uiLang());
      for (const i of issues) {
        const line = tr(
          `${p.label || p.id}：KaTeX 不认识 ${i.command}（${i.hint}）`,
          `${p.label || p.id}: KaTeX does not recognise ${i.command} (${i.hint})`,
        );
        if (!mathWarnings.includes(line)) mathWarnings.push(line);
      }
    }
    if (mathWarnings.length) {
      warn(`提交包里有 ${mathWarnings.length} 处公式命令问题：\n  ${mathWarnings.join('\n  ')}`);
    }

    log(
      `提交包已生成：${outPdf}（${res.pages} 页 / ${Math.round((res.bytes ?? 0) / 1024)} KB）` +
        `renderer=${res.renderer ?? chrome.name} merged=${res.merged}`,
    );
    return {
      ok: true,
      file: outPdf,
      pages: res.pages ?? 0,
      bytes: res.bytes ?? 0,
      renderer: res.renderer ?? chrome.name,
      math_warnings: mathWarnings,
      url: `/aemeath/api/exercise/submission?course=${encodeURIComponent(input.courseId)}&sheet=${encodeURIComponent(input.sheetId)}&download=1`,
      print_url: `/aemeath/api/exercise/print?course=${encodeURIComponent(input.courseId)}&sheet=${encodeURIComponent(input.sheetId)}`,
    } as const;
  };

  // ============================================================
  // 纯文本导出（markdown，给 git 管理用）
  // ============================================================

  /**
   * 把习题库导出成纯文本。
   *
   * 用户要求：「加一个导出为文本的功能，这样方便 git 管理」。
   * 确定性（内容不变就不产生 diff）+ 只清理自己写过的文件（见 text-export.ts）。
   */
  const exportText = async (input: { courseId?: string } = {}) => {
    const ids = input.courseId ? [input.courseId] : store.listCourses();
    const courses: CourseSnapshot[] = [];
    for (const id of ids) {
      const index = store.readIndex(id);
      if (!index) continue;
      courses.push({ index, sheets: store.listSheets(id) });
    }
    if (!courses.length) return { ok: false, error: tr('还没有课程（先导入或新建一套题）', 'No courses yet (import or create a sheet first)') } as const;

    const mistakes = store.readMistakes().filter((m) => !input.courseId || m.course_id === input.courseId);
    const files = renderTextExport({ courses, mistakes });
    try {
      const r = syncTextExport(textExportDir, files);
      log(
        `文本导出：${r.dir}（写 ${r.written.length} · 未变 ${r.unchanged.length}` +
          `${r.removed.length ? ` · 删 ${r.removed.length}` : ''}）`,
      );
      return { ok: true, ...r, files: [...files.keys()].sort() } as const;
    } catch (e) {
      return { ok: false, error: tr(`写导出目录失败：${(e as Error).message}`, `Failed to write the export directory: ${(e as Error).message}`) } as const;
    }
  };

  // ============================================================
  // 握手导出 / 导入
  // ============================================================

  const exportHandoff = async (input: { courseId?: string }) => {
    const ids = input.courseId ? [input.courseId] : store.listCourses();
    if (!ids.length) return { ok: false, error: tr('还没有课程', 'No courses yet') } as const;
    const files: string[] = [];
    const summaries: string[] = [];
    const dir = handoffDir;
    for (const cid of ids) {
      const index = store.readIndex(cid);
      if (!index) continue;
      const sheets = store.listSheets(cid);
      const mistakes = store.readMistakes().filter((m) => m.course_id === cid);
      const h = buildExerciseHandoff({ index, sheets, mistakes });
      files.push(writeExerciseHandoff(h, dir));
      summaries.push(describeExerciseHandoff(h));
    }
    if (!files.length) return { ok: false, error: tr('没有可导出的课程', 'No courses to export') } as const;
    log(`握手包已导出 ${files.length} 个 → ${dir}`);
    return { ok: true, files, summaries, dir } as const;
  };

  const buildGatekeeper = async (): Promise<ExerciseGatekeeper | null> => {
    try {
      const gkMod = (await import('@aemeath/dsh-plugin-memory/gatekeeper')) as {
        decide: (q: string, r: string) => GateDecision;
        writeGate: (q: string, c: string) => WriteGateResult;
      };
      const memory = (ctx as unknown as { reflect?: { get(n: string): unknown } }).reflect?.get('memory') as
        | {
            save(input: {
              content: string;
              category: string;
              importance?: number;
              confidence?: number;
              scope?: string;
              preset: string;
              source_mode?: string;
              entityClaims?: Array<{
                entity: string;
                attribute: string;
                value: string;
                valid_from: number;
                valid_until: number | null;
              }>;
            }): Promise<string>;
            knowledgeAdd(input: {
              preset: string;
              content: string;
              topic: string;
              sourceKind: 'user_query' | 'llm_extract';
              sourceSession: string;
              status?: string;
            }): Promise<string>;
          }
        | undefined;
      if (!memory) {
        log('未检测到 memory 服务 —— 握手接收侧降级为只读（试运行）');
        return null;
      }
      return {
        decide: (q, r) => gkMod.decide(q, r),
        writeGate: (q, c) => gkMod.writeGate(q, c),
        save: async (input) => {
          const id = await memory.save({
            content: input.content,
            category: input.category,
            importance: input.importance,
            confidence: input.confidence,
            scope: input.scope,
            preset: input.preset,
            source_mode: input.sourceExercise
              ? `${input.sourceMode}@${input.sourceExercise.course}/${input.sourceExercise.sheet}`
              : input.sourceMode,
            entityClaims: input.entityClaims,
          });
          return id;
        },
        knowledgeAdd: async (input) =>
          memory.knowledgeAdd({
            preset: input.preset,
            content: input.content,
            topic: input.topic,
            sourceKind: 'llm_extract',
            sourceSession: input.sourceSession,
            status: 'pending',
          }),
        log,
        warn,
      };
    } catch (e) {
      log(`握手接收侧不可用（memory 未加载 / 包缺失）：${(e as Error).message}`);
      return null;
    }
  };

  const importHandoff = async (input: { file?: string; dryRun?: boolean; preset?: string }) => {
    const files = input.file ? [input.file] : findExerciseHandoffFiles(handoffDir);
    if (!files.length) {
      return fail(
        tr(
          `没有找到习题握手文件。\n已扫描目录：${handoffDir}\n把 mac 导出的 *-exercise-handoff.json 放进该目录，或用 file 参数指定绝对路径。`,
          `No exercise handoff file found.\nScanned directory: ${handoffDir}\nPut the *-exercise-handoff.json exported from the Mac into that directory, or pass an absolute path via file.`,
        ),
      );
    }
    const gk = await buildGatekeeper();
    if (!gk) {
      const previews = files.map((f) => {
        const h = loadExerciseHandoff(f);
        return h ? describeExerciseHandoff(h) : tr(`（不可解析：${f}）`, `(unparseable: ${f})`);
      });
      return ok({
        dry_run: true,
        degraded: true,
        note: tr('memory 服务不可用（可能是独立 profile）——只读预览，未写入。', 'Memory service unavailable (likely the standalone profile) — read-only preview, nothing was written.'),
        previews,
      });
    }
    const outcomes: string[] = [];
    let mem = 0;
    let wb = 0;
    let drop = 0;
    for (const f of files) {
      const h = loadExerciseHandoff(f);
      if (!h) {
        warn(`握手文件不可解析：${f}`);
        continue;
      }
      const o = await importExerciseHandoff(h, gk, {
        dryRun: input.dryRun ?? true,
        preset: input.preset ?? 'physicist',
        worldbookDir,
      });
      outcomes.push(describeExerciseOutcome(o));
      mem += o.memoriesWritten;
      wb += o.worldbookWritten;
      drop += o.dropped;
    }
    return ok({
      dry_run: input.dryRun ?? true,
      files,
      memories: mem,
      worldbook: wb,
      dropped: drop,
      outcomes,
      note:
        (input.dryRun ?? true)
          ? tr('这是试运行结果 —— 确认无误后把 dry_run 设为 false 真正写入。', 'This is a dry run — set dry_run to false to actually write.')
          : tr('已写入主记忆与世界书。', 'Written to main memory and worldbook.'),
    });
  };

  // ============================================================
  // 视图（HTTP 与工具共用）
  // ============================================================

  const buildCourseViews = () =>
    store.listCourses().map((cid) => {
      const idx = store.readIndex(cid)!;
      return {
        course_id: idx.course_id,
        title: idx.title,
        semester: idx.semester,
        module_code: idx.module_code,
        sheets: store.listSheets(cid).map((s) => {
          const prog = sheetProgress(s);
          return {
            id: s.id,
            number: s.number,
            title: s.title,
            issued: s.issued,
            due: s.due,
            due_in_days: daysUntil(s.due),
            total: prog.total,
            answered: prog.answered,
            checked: prog.checked,
            needs_fix: prog.needsFix,
            percent: prog.percent,
            submitted: s.submitted_at > 0,
            submission_pages: s.submission_pages,
            import_mode: s.import_mode,
            needs_manual_text: s.needs_manual_text,
            lesson_count: s.lessons.length,
            progress_digest: s.progress_digest,
            next_hint: nextActionHint(s),
          };
        }),
      };
    });

  const buildSheetView = (courseId: string, sheetId: string) => {
    const sheet = store.readSheet(courseId, sheetId);
    if (!sheet) return { ok: false as const, error: tr(`题集不存在: ${courseId}/${sheetId}`, `Sheet not found: ${courseId}/${sheetId}`) };
    const course = store.readIndex(courseId);
    const prog = sheetProgress(sheet);
    return {
      ok: true as const,
      sheet: {
        ...sheet,
        // 派生字段（不落盘，避免两处真相）
        progress: prog,
        next_hint: nextActionHint(sheet),
        course: course ? { id: course.course_id, title: course.title, semester: course.semester } : null,
        problems: sheet.problems.map((p) => ({
          ...p,
          status: problemStatus(p),
          last_check: lastFreshCheck(p.checks),
          check_count: p.checks.length,
        })),
      },
    };
  };

  const buildMistakesView = () =>
    store.readMistakes().map((m) => ({
      ...m,
      age_days: Math.max(0, Math.round((Date.now() - m.created_at) / 86_400_000)),
    }));

  const buildDigestPreview = (courseId: string) => {
    const d = digestFor(courseId);
    return { digest: d.text, stats: d.stats, lecture: lectureProgress() };
  };

  const buildSymbolsView = async () => {
    try {
      // 借 lecture 的符号表（用户要求"符号之类的可以适当抄 lecture"）。
      // 动态 import：exercise 可能在没装 lecture 的 profile 里跑（独立 profile），
      // 静态 import 会让整个插件在那种情况下加载失败。
      const mod = (await import('@aemeath/dsh-plugin-lecture/symbols')) as {
        SYMBOL_GROUPS?: unknown;
        SYMBOL_LABEL_EN?: unknown;
        SYMBOL_HINT_EN?: unknown;
        INSTITUTIONAL_NOTATION?: unknown;
        COMBINING?: unknown;
      };
      const labelEn = (mod.SYMBOL_LABEL_EN ?? {}) as Record<string, string>;
      const hintEn = (mod.SYMBOL_HINT_EN ?? {}) as Record<string, string>;
      type RawSymbol = { label?: string; hint?: string; [k: string]: unknown };
      type RawGroup = { label?: string; symbols?: RawSymbol[]; [k: string]: unknown };
      const rawGroups = (Array.isArray(mod.SYMBOL_GROUPS) ? mod.SYMBOL_GROUPS : []) as RawGroup[];
      const groups = rawGroups.map((g) => ({
        ...g,
        labelEn: g.label ? labelEn[g.label] : undefined,
        symbols: (g.symbols ?? []).map((s) => ({
          ...s,
          labelEn: s.label ? labelEn[s.label] : undefined,
          hintEn: s.hint ? hintEn[s.hint] : undefined,
        })),
      }));
      return { groups, notation: mod.INSTITUTIONAL_NOTATION ?? null, combining: mod.COMBINING ?? null };
    } catch (e) {
      warn(`符号表不可用（lecture 未安装）：${(e as Error).message}`);
      return { groups: [], notation: null, combining: null };
    }
  };

  // ============================================================
  // 工具集
  // ============================================================

  ctx.tools.register(
    defineTool({
      name: 'exercise_list',
      description:
        '列出全部 Übungsblatt（习题套）与进度。用户说"我的作业/Übungen/这周的题"时先调它。' +
        '返回每套的编号、题数、已答/已检查数、截止日剩余天数、是否已生成提交包。',
      parameters: {
        course_id: { type: 'string', description: '只看某门课（缺省全部）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id?: string }) => {
        const all = buildCourseViews();
        const filtered = args.course_id ? all.filter((c) => c.course_id === args.course_id) : all;
        return ok({ courses: JSON.stringify(filtered), count: filtered.length });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_new_sheet',
      description:
        '新建一套空白 Übung（不含 PDF；导入 PDF 请在习题界面里点「导入 PDF」，或把文本用 text 传进来）。' +
        '会自动附上当前学习进度摘要（progress_digest）。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识，如 "physik-1"' },
        title: { type: 'string', description: '这套题的主题（可选）' },
        due: { type: 'string', description: '截止日 YYYY-MM-DD（可选）' },
        number: { type: 'number', description: '第几套（缺省自动 +1）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string; title?: string; due?: string; number?: number }) => {
        const r = await createSheet({
          courseId: args.course_id,
          title: args.title,
          due: args.due,
          number: args.number,
        });
        if (!r.ok || !r.sheet) return fail(r.error ?? tr('新建失败', 'Creation failed'));
        return ok({
          course_id: args.course_id,
          sheet_id: r.sheet.id,
          progress_digest: r.sheet.progress_digest,
          note: '下一步：加题目（界面里点「+ 添加题目」）或把 PDF 拖进习题界面导入',
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_open',
      description:
        '打开一套题：返回题号、题干、是否有答案、检查状态。用于"看看我写到哪了"。' +
        '要看某题完整题干与答案，用 exercise_problem。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
        sheet_id: { type: 'string', required: true, description: '套题标识，如 "ub03"' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string; sheet_id: string }) => {
        const view = buildSheetView(args.course_id, args.sheet_id);
        if (!view.ok) return fail(view.error);
        const s = view.sheet as unknown as Sheet & { progress: ReturnType<typeof sheetProgress>; next_hint: string };
        return ok({
          sheet_id: s.id,
          number: s.number,
          title: s.title,
          due: s.due,
          progress_digest: s.progress_digest,
          next_hint: s.next_hint,
          progress: JSON.stringify(s.progress),
          problems: JSON.stringify(
            s.problems.map((p) => ({
              id: p.id,
              label: p.label,
              title: p.title,
              points: p.points,
              page: p.page,
              status: problemStatus(p),
              answered: !!p.answer.trim(),
              check_count: p.checks.length,
              last_verdict: lastFreshCheck(p.checks)?.verdict ?? null,
            })),
          ),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_problem',
      description:
        '读一道题的完整内容（题干 + 用户当前答案 + 最近一次检查结论）。' +
        '在帮用户解题/批改之前必须先读它，不要凭空猜题目。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
        sheet_id: { type: 'string', required: true, description: '套题标识' },
        problem_id: { type: 'string', required: true, description: '题目 id，如 "p02"' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string; sheet_id: string; problem_id: string }) => {
        const sheet = store.readSheet(args.course_id, args.sheet_id);
        if (!sheet) return fail('题集不存在');
        const p = store.findProblem(sheet, args.problem_id);
        if (!p) return fail('题目不存在');
        return ok({
          problem_id: p.id,
          label: p.label,
          title: p.title,
          points: p.points ?? 0,
          page: p.page,
          text: p.text,
          answer: p.answer,
          notes: p.notes,
          status: problemStatus(p),
          last_check: JSON.stringify(lastFreshCheck(p.checks)),
          check_count: p.checks.length,
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_save_answer',
      description:
        '把答案写进某道题（用户随时可以在界面上改；你写的内容会标记为 edited_by=agent）。' +
        '写答案前先 exercise_problem 读题干。**不要**在用户没要求时替他把所有题都写了。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
        sheet_id: { type: 'string', required: true, description: '套题标识' },
        problem_id: { type: 'string', required: true, description: '题目 id' },
        answer: { type: 'string', required: true, description: '答案正文（markdown + $公式$）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string; sheet_id: string; problem_id: string; answer: string }) => {
        const r = await updateProblem({
          courseId: args.course_id,
          sheetId: args.sheet_id,
          problemId: args.problem_id,
          patch: { answer: args.answer },
          editedBy: 'agent',
        });
        if (!r.ok) return fail(r.error ?? '写入失败');
        return ok({
          saved: true,
          stale_checks: r.stale ?? 0,
          note:
            (r.stale ?? 0) > 0
              ? `答案已更新；${r.stale} 条旧检查已标记过期（它们针对的是旧答案）`
              : '答案已更新',
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_check',
      description:
        '手动触发对某道题的 LLM 检查（批改）。**只在用户明确要求"检查/批改/看看我写得对不对"时调用**——' +
        '不要自动检查、不要一次检查多题。检查是建议不是判分：它会指出哪一步不成立，但不会给完整答案。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
        sheet_id: { type: 'string', required: true, description: '套题标识' },
        problem_id: { type: 'string', required: true, description: '题目 id' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string; sheet_id: string; problem_id: string }) => {
        const r = await checkProblem({ courseId: args.course_id, sheetId: args.sheet_id, problemId: args.problem_id });
        if (!r.ok) return fail(r.error ?? '检查失败', { verdict: r.check?.verdict ?? 'error' });
        const c = r.check!;
        return ok({
          verdict: c.verdict,
          score: c.score ?? 0,
          issues: JSON.stringify(c.issues),
          hints: JSON.stringify(c.hints),
          next_steps: JSON.stringify(c.next_steps),
          mistake_added: r.mistake ? r.mistake.id : '',
          note: '把结论讲给用户听时，**不要**顺手把完整解答写出来（检查的边界）。',
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_collect_mistake',
      description:
        '把一道题加入错题本（可附"这题教会我什么"）。检查判错时通常已经自动加入；' +
        '这里用于用户主动说"把这题记到错题本"或补写教训。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
        sheet_id: { type: 'string', required: true, description: '套题标识' },
        problem_id: { type: 'string', required: true, description: '题目 id' },
        lesson: { type: 'string', description: '一句话教训（用户口述的，不要编）' },
        tags: { type: 'array', items: { type: 'string' }, description: '主题标签（如 角动量、量纲）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: {
        course_id: string;
        sheet_id: string;
        problem_id: string;
        lesson?: string;
        tags?: string[];
      }) => {
        const m = collectMistakeInternal({
          courseId: args.course_id,
          sheetId: args.sheet_id,
          problemId: args.problem_id,
          lesson: args.lesson,
          tags: args.tags,
        });
        if (!m) return fail('加入失败（题集或题目不存在）');
        return ok({ id: m.id, verdict: m.verdict, issues: JSON.stringify(m.issues), tags: m.tags });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_lessons',
      description:
        '读/写某套题的"经验"条目（这题教会我什么）。op=list 读；op=add 加；op=update/delete 改删。' +
        '经验会经 exercise_sync_worldbook 沉淀进 worldbook。',
      parameters: {
        op: { type: 'string', required: true, description: 'list | add | update | delete' },
        course_id: { type: 'string', required: true, description: '课程标识' },
        sheet_id: { type: 'string', required: true, description: '套题标识' },
        lesson_id: { type: 'string', description: 'op=update/delete 时必填' },
        text: { type: 'string', description: '经验正文（op=add/update）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: {
        op: string;
        course_id: string;
        sheet_id: string;
        lesson_id?: string;
        text?: string;
      }) => {
        const op = args.op as 'list' | 'add' | 'update' | 'delete';
        if (op === 'list') {
          const sheet = store.readSheet(args.course_id, args.sheet_id);
          if (!sheet) return fail('题集不存在');
          return ok({ lessons: JSON.stringify(sheet.lessons), count: sheet.lessons.length });
        }
        if (!['add', 'update', 'delete'].includes(op)) return fail('op 必须是 list/add/update/delete');
        const r = await lessons({
          op,
          courseId: args.course_id,
          sheetId: args.sheet_id,
          lessonId: args.lesson_id,
          text: args.text,
        });
        if (!r.ok) return fail(r.error ?? '操作失败');
        return ok({ lessons: JSON.stringify((r.sheet as Sheet).lessons) });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_sync_worldbook',
      description:
        '把错题教训与经验写进 worldbook（physicist 馆的 generated_exercise.json，热重载生效）。' +
        '用户说"把这些错题记进知识库/让主 agent 以后记得"时调用。只会写**还没同步过**的条目。',
      parameters: {
        course_id: { type: 'string', description: '只同步某门课（缺省全部）' },
        sheet_id: { type: 'string', description: '只同步某一套（缺省全部）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id?: string; sheet_id?: string }) => syncWorldbook({ courseId: args.course_id, sheetId: args.sheet_id }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_build_submission',
      description:
        '生成提交用 PDF：解答页（LaTeX 已渲染）+ 原卷合并成一个文件。' +
        '需要本机有 Chrome/Edge（自动发现）；没有则返回打印页地址，用户可在浏览器里「另存为 PDF」。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
        sheet_id: { type: 'string', required: true, description: '套题标识' },
        include_source: { type: 'boolean', description: '是否合并原卷 PDF（缺省 false：只输出生成的解答页）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string; sheet_id: string; include_source?: boolean }) => {
        const r = await buildSubmission({
          courseId: args.course_id,
          sheetId: args.sheet_id,
          includeSource: args.include_source,
        });
        return r.ok ? ok(r as unknown as Record<string, string | number | boolean | string[] | null>) : fail(r.error ?? '生成失败', r as unknown as Record<string, string | number | boolean | string[] | null>);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_progress',
      description:
        '查看学习进度摘要（就是每开一套新题时自动附上的那段）：上次做到哪、累计题量、错题本未掌握项、课堂进度。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string }) => {
        const d = buildDigestPreview(args.course_id);
        return ok({ digest: d.digest, stats: JSON.stringify(d.stats) });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_scratch',
      description:
        '极简模式（临时做题）：一个独立工作区，只有一道题 —— 粘题目、写答案、手动检查/答辩。' +
        '没有多项目管理、没有提交/导出。传 `reset: true` 清空（题目、答案、检查、附图）。',
      parameters: {
        reset: { type: 'boolean', description: 'true = 清空工作区后返回' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { reset?: boolean }) => {
        const sheet = args.reset === true ? resetScratch() : scratchSheet();
        const p = sheet.problems[0];
        return ok({
          course_id: SCRATCH_COURSE,
          sheet_id: SCRATCH_SHEET,
          problem_id: SCRATCH_PROBLEM,
          text: p?.text ?? '',
          answer: p?.answer ?? '',
          checks: String(p?.checks.length ?? 0),
          reset: args.reset === true,
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_attach_image',
      description:
        '给某道题附一张图（手画示意图/受力图/照片）。图会：① 在答案旁边显示；② 检查时随多模态一起发给模型；' +
        '③ 印进提交 PDF。支持 png/jpeg/webp/gif（按内容嗅探，≤10MB）。传 `path`（本地文件）或 `base64`。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
        sheet_id: { type: 'string', required: true, description: '题集标识' },
        problem_id: { type: 'string', required: true, description: '题目标识（p01…）' },
        path: { type: 'string', description: '本地图片路径（相对 cwd 或绝对路径）；与 base64 二选一' },
        base64: { type: 'string', description: '图片 base64（可带 data: 前缀）；与 path 二选一' },
        caption: { type: 'string', description: '一句话说明（如"受力图"）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string; sheet_id: string; problem_id: string; path?: string; base64?: string; caption?: string }) => {
        let b64 = args.base64 ?? '';
        if (!b64 && args.path) {
          const file = isAbsolute(args.path) ? args.path : join(process.cwd(), args.path);
          if (!existsSync(file)) return fail(`找不到文件：${args.path}`);
          b64 = readFileSync(file).toString('base64');
        }
        if (!b64) return fail('需要 path 或 base64');
        const r = await addAttachment({
          courseId: args.course_id,
          sheetId: args.sheet_id,
          problemId: args.problem_id,
          base64: b64,
          caption: args.caption,
        });
        if (!r.ok) return fail(r.error ?? '附图失败');
        return ok({
          name: r.image?.name ?? '',
          bytes: r.image?.bytes ?? 0,
          media_type: r.image?.media_type ?? '',
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_rebut',
      description:
        '答辩：学生认为批改错了，让爱弥斯**重新独立推导**再裁决。' +
        '她会要么承认批错（并撤回对应 issues、把这题错题标为已掌握），' +
        '要么给出具体证据坚持（反例/代入数值），不允许只重复原结论。' +
        '每轮追加保存，历史不覆盖。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
        sheet_id: { type: 'string', required: true, description: '题集标识' },
        problem_id: { type: 'string', required: true, description: '题目标识（p01…）' },
        text: { type: 'string', required: true, description: '你的答辩内容（指控哪一步被误判、为什么）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string; sheet_id: string; problem_id: string; text: string }) => {
        const r = await rebutProblem({
          courseId: args.course_id,
          sheetId: args.sheet_id,
          problemId: args.problem_id,
          text: args.text,
        });
        if (!r.ok || !r.rebuttal) return fail(r.error ?? '答辩失败');
        return ok({
          outcome: r.rebuttal.outcome,
          reply: r.rebuttal.reply,
          withdrawn: JSON.stringify(r.rebuttal.withdrawn),
          remaining: JSON.stringify(r.rebuttal.remaining.map((i) => i.text)),
          correct_parts: JSON.stringify(r.rebuttal.correct_parts),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_export_text',
      description:
        '把习题库导出成**纯文本 markdown**（题干/答案/检查/经验/错题），方便 git 管理：' +
        '确定性输出（内容没变不产生 diff），套题删除后重新导出会移除对应文件。' +
        '目录由 config.textExportDir 决定（默认数据目录同级的 exercises-md/）。',
      parameters: {
        course_id: { type: 'string', description: '只导出某一门课（缺省 = 全部）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id?: string }) => {
        const r = await exportText({ courseId: args.course_id });
        if (!r.ok) return fail(r.error);
        return ok({
          dir: r.dir,
          written: r.written.length,
          unchanged: r.unchanged.length,
          removed: r.removed.length,
          files: JSON.stringify(r.files),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_export_handoff',
      description:
        '导出习题握手包（进度 + 错题 + 经验）供另一台机器的主 agent 导入。' +
        '与 lecture 的 handoff 同形（progress/weak_points/units/claims），另加 lessons/mistakes。',
      parameters: {
        course_id: { type: 'string', description: '只导出某门课（缺省全部）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id?: string }) => {
        const r = await exportHandoff({ courseId: args.course_id });
        if (!r.ok) return fail(r.error ?? '导出失败');
        return ok({
          files: r.files,
          handoff_dir: r.dir,
          summaries: r.summaries,
          note: '把这些文件搬到主 agent 所在机器，在那里调 exercise_import_handoff（先 dry_run）。',
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_import_handoff',
      description:
        '【主 agent 侧】导入习题握手包（*-exercise-handoff.json）：过守门员写主记忆，并把经验/错题教训写进 worldbook。' +
        '缺省 dry_run（先看会写什么）。',
      parameters: {
        file: { type: 'string', description: '单个文件路径；缺省扫描 handoffDir' },
        dry_run: { type: 'boolean', description: '试运行（**缺省 true**）' },
        preset: { type: 'string', description: '目标馆，缺省 physicist' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { file?: string; dry_run?: boolean; preset?: string }) =>
        importHandoff({ file: args.file, dryRun: args.dry_run, preset: args.preset }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'exercise_resplit',
      description:
        '用原文存档（source.md）重新分块某套题。默认 **LLM 分块**（PDF 抽出的文本用规则切基本切不准）；' +
        '会产生的新题目按题号保留已有答案。用户说"这道题切错了/把两题切开了"时用。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
        sheet_id: { type: 'string', required: true, description: '套题标识' },
        use_llm: { type: 'boolean', description: '是否用 LLM（缺省 true；false = 规则分块）' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string; sheet_id: string; use_llm?: boolean }) => {
        const r = await resplit({ courseId: args.course_id, sheetId: args.sheet_id, useLlm: args.use_llm });
        if (!r.ok) return fail(r.error ?? tr('重新分块失败', 'Re-split failed'));
        const sheet = store.readSheet(args.course_id, args.sheet_id);
        return ok({
          sheet_id: args.sheet_id,
          problems: sheet ? sheet.problems.length : 0,
          used_llm: r.used_llm === true,
          labels: sheet ? JSON.stringify(sheet.problems.map((p) => p.label)) : '[]',
          note: r.note ?? '',
        });
      },
    }),
  );

  // ============================================================
  // HTTP 桥（前端）
  // ============================================================
  const webServer = ((): { register?: (r: { kind: string; path: string; handler: unknown }) => () => void } | undefined => {
    try {
      return (ctx as unknown as { reflect?: { get(n: string): unknown } }).reflect?.get('webServer') as
        | { register?: (r: { kind: string; path: string; handler: unknown }) => () => void }
        | undefined;
    } catch {
      return undefined;
    }
  })();

  // 独立界面标记（与 lecture 同一机制：在 index.html 渲染时注入全局量）
  try {
    const hooks = ctx as unknown as { on?: (ev: string, cb: (table: unknown[]) => void) => void };
    if (typeof hooks.on === 'function') {
      hooks.on('webserver/index-inject', (table: unknown[]) => {
        if (!config.standalone) return;
        table.push({ kind: 'global', name: '__AEMEATH_EXERCISE_STANDALONE__', value: true });
      });
      if (config.standalone) log('已开启独立界面模式：将向页面注入 __AEMEATH_EXERCISE_STANDALONE__=true');
    }
  } catch (e) {
    warn(`注入 standalone 标记失败：${(e as Error).message}`);
  }

  if (webServer?.register) {
    /**
     * 写操作统一返回**视图**（而不是 sheet.json 的裸数据）。
     *
     * 为什么：视图带 `status` / `last_check` / `progress` / `next_hint` 这些派生字段，
     * 前端拿到裸数据后得自己再算一遍 —— 真机验证时发现「保存答案后状态徽章消失」
     * 就是这个原因（problem.status 变成 undefined）。
     * 派生逻辑只放在 host 一处，前端永远只消费视图。
     */
    const viewOf = (courseId: string, sheetId: string): unknown => {
      const v = buildSheetView(courseId, sheetId);
      return v.ok ? v.sheet : null;
    };

    const deps: ExerciseHttpDeps = {
      store: { rootPath: store.rootPath },
      buildCourses: () => buildCourseViews(),
      buildSheetView: (c, s) => {
        const v = buildSheetView(c, s);
        return v.ok ? { ok: true, sheet: v.sheet } : { ok: false, error: v.error };
      },
      buildMistakes: () => buildMistakesView(),
      buildDigestPreview: (c) => buildDigestPreview(c),
      buildSymbols: () => ({ groups: [], notation: null, combining: null }),
      readSourceText: (c, s) => store.readSourceText(c, s),
      sourcePdfPath: (c, s) => (store.hasSourcePdf(c, s) ? store.sourcePdfFile(c, s) : null),
      readPageImage: (c, s, page) => store.readPageImage(c, s, page),
      submissionPdfPath: (c, s) => {
        const sheet = store.readSheet(c, s);
        if (!sheet?.submission_pdf) return null;
        const p = store.submissionFile(c, s, sheet);
        return existsSync(p) ? p : null;
      },
      buildPrintHtml: (c, s, opts) => printHtmlOf(c, s, opts),
      onImport: async (input) => {
        const r = await importSheet(input);
        if (!r.ok || !r.sheet) return { ok: false, error: r.error ?? tr('导入失败', 'Import failed') };
        return {
          ok: true,
          course_id: input.courseId,
          sheet_id: r.sheet.id,
          sheet: viewOf(input.courseId, r.sheet.id) ?? r.sheet,
          warnings: r.warnings,
        };
      },
      onCreateSheet: async (input) => {
        const r = await createSheet(input);
        return { ok: r.ok, error: r.error, sheet: r.sheet ? (viewOf(input.courseId, r.sheet.id) ?? r.sheet) : undefined };
      },
      onUpdateProblem: async (input) => {
        const r = await updateProblem(input);
        return { ...r, sheet: (viewOf(input.courseId, input.sheetId) ?? r.sheet) as never };
      },
      onAddProblem: async (input) => {
        const r = await addProblem(input);
        return { ...r, sheet: (viewOf(input.courseId, input.sheetId) ?? r.sheet) as never };
      },
      onDeleteProblem: async (input) => {
        const r = await deleteProblem(input);
        return { ...r, sheet: (viewOf(input.courseId, input.sheetId) ?? r.sheet) as never };
      },
      onResplit: async (input) => {
        const r = await resplit(input);
        return { ...r, sheet: (viewOf(input.courseId, input.sheetId) ?? r.sheet) as never };
      },
      onCheck: async (input) => {
        const r = await checkProblem(input);
        return {
          ok: r.ok,
          error: r.error,
          check: r.check,
          mistake: r.mistake,
          sheet: (viewOf(input.courseId, input.sheetId) ?? r.sheet) as never,
        };
      },
      onCollectMistake: async (input) => {
        const m = collectMistakeInternal(input);
        return m ? { ok: true, mistake: m } : { ok: false, error: tr('加入失败（题集或题目不存在）', 'Could not add (sheet or problem not found)') };
      },
      onPatchMistake: async (input) => {
        const allowed: Partial<Mistake> = {};
        if (typeof input.patch.lesson === 'string') allowed.lesson = input.patch.lesson;
        if (typeof input.patch.mastered === 'boolean') allowed.mastered = input.patch.mastered;
        if (Array.isArray(input.patch.tags)) allowed.tags = input.patch.tags as string[];
        const m = store.patchMistake(input.id, allowed);
        return m ? { ok: true, mistake: m } : { ok: false, error: tr('错题不存在', 'Mistake not found') };
      },
      onDeleteMistake: async (input) => {
        const done = store.deleteMistake(input.id);
        return done ? { ok: true } : { ok: false, error: tr('错题不存在', 'Mistake not found') };
      },
      onLesson: async (input) => {
        const r = await lessons(input);
        return { ...r, sheet: (viewOf(input.courseId, input.sheetId) ?? r.sheet) as never };
      },
      onSyncWorldbook: async (input) => {
        const r = await syncWorldbook(input);
        const d = r.data;
        return {
          ok: r.ok,
          error: typeof d.error === 'string' ? d.error : undefined,
          written: typeof d.written === 'number' ? d.written : 0,
          skipped: typeof d.skipped === 'number' ? d.skipped : 0,
          failed: typeof d.failed === 'number' ? d.failed : 0,
          details: Array.isArray(d.details) ? (d.details as string[]) : [],
        };
      },
      onBuildSubmission: async (input) => {
        const r = await buildSubmission(input);
        const d = r as unknown as Record<string, unknown>;
        return {
          ok: !!d.ok,
          error: typeof d.error === 'string' ? d.error : undefined,
          file: typeof d.file === 'string' ? d.file : undefined,
          pages: typeof d.pages === 'number' ? d.pages : undefined,
          bytes: typeof d.bytes === 'number' ? d.bytes : undefined,
          url: typeof d.url === 'string' ? d.url : undefined,
          print_url: typeof d.print_url === 'string' ? d.print_url : undefined,
          renderer: typeof d.renderer === 'string' ? d.renderer : undefined,
          hint: typeof d.hint === 'string' ? d.hint : undefined,
          math_warnings: Array.isArray(d.math_warnings) ? (d.math_warnings as string[]) : undefined,
        };
      },
            onScratch: () => {
        try {
          scratchSheet();
          return { ok: true, sheet: viewOf(SCRATCH_COURSE, SCRATCH_SHEET) };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
      onApproach: (input) => checkApproach(input),
      onImportScratchPdf: async (input) => {
        const r = await importScratchPdf(input);
        if (!r.ok) return { ok: false, error: r.error };
        return {
          ok: true,
          sheet: viewOf(SCRATCH_COURSE, SCRATCH_SHEET),
          text_length: r.text_length,
          pages: r.pages,
        };
      },
      onScratchReset: () => {
        try {
          resetScratch();
          return { ok: true, sheet: viewOf(SCRATCH_COURSE, SCRATCH_SHEET) };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
      onReadAttachment: (input) => store.readImage(input.courseId, input.sheetId, input.name),
      onAddAttachment: async (input) => {
        const r = await addAttachment(input);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, image: r.image, sheet: viewOf(input.courseId, input.sheetId) };
      },
      onDeleteAttachment: async (input) => {
        const r = await deleteAttachment(input);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, sheet: viewOf(input.courseId, input.sheetId) };
      },
      onRebuttal: async (input) => {
        const r = await rebutProblem(input);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, sheet: viewOf(input.courseId, input.sheetId) };
      },
      onExportText: async (input) => {
        const r = await exportText(input);
        return r.ok
          ? {
              ok: true,
              dir: r.dir,
              written: r.written,
              unchanged: r.unchanged,
              removed: r.removed,
              files: r.files,
            }
          : { ok: false, error: r.error };
      },
      onExportHandoff: async (input) => {
        const r = await exportHandoff(input);
        return r.ok ? { ok: true, files: r.files, summaries: r.summaries, dir: r.dir } : { ok: false, error: r.error };
      },
      onImportHandoff: async (input) => {
        const r = await importHandoff({ file: input.file, dryRun: input.dryRun, preset: input.preset });
        const d = r.data;
        const str1 = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
        const num1 = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
        return {
          ok: r.ok,
          error: str1(d.error),
          dry_run: d.dry_run === true,
          files: Array.isArray(d.files) ? (d.files as string[]) : undefined,
          memories: num1(d.memories),
          worldbook: num1(d.worldbook),
          dropped: num1(d.dropped),
          outcomes: Array.isArray(d.outcomes) ? (d.outcomes as string[]) : undefined,
          degraded: d.degraded === true,
          previews: Array.isArray(d.previews) ? (d.previews as string[]) : undefined,
          note: str1(d.note),
        };
      },
      onDelete: async (input) => {
        if (input.scope === 'course') {
          const done = store.deleteCourse(input.courseId);
          return done ? { ok: true } : { ok: false, error: tr('课程不存在', 'Course not found') };
        }
        const done = store.deleteSheet(input.courseId, input.sheetId ?? '');
        return done ? { ok: true } : { ok: false, error: tr('题集不存在', 'Sheet not found') };
      },
      log,
      warn,
    };

    // symbols 走异步（动态 import lecture），所以这里包一层再交给 http
    deps.buildSymbols = () => ({ groups: [], notation: null, combining: null });
    const symbolHandler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.searchParams.get('action') === 'symbols') {
        const payload = await buildSymbolsView();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...payload }));
        return true;
      }
      return false;
    };

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      void (async () => {
        try {
          if (await symbolHandler(req, res)) return;
          await handleExerciseHttp(req, res, deps);
        } catch (e) {
          warn(`HTTP 处理异常：${(e as Error).message}`);
          try {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'internal error' }));
          } catch {
            /* 响应可能已发送 */
          }
        }
      })();
    };

    const dispose = webServer.register({ kind: 'exact', path: '/aemeath/api/exercise', handler });
    const disposeSlash = webServer.register({ kind: 'exact', path: '/aemeath/api/exercise/', handler });
    const disposeAssets = webServer.register({
      kind: 'prefix',
      path: ASSETS_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (!serveExerciseAsset(req, res, req.url ?? '')) res.writeHead(404).end('not found');
      },
    });

    ctx.effect(() => () => {
      try {
        dispose?.();
        disposeSlash?.();
        disposeAssets?.();
      } catch {
        /* 服务可能已卸载 */
      }
    });
    log('HTTP 桥已注册: GET/POST /aemeath/api/exercise（前端不持有 token）');
    log(`KaTeX 静态资源已注册: ${ASSETS_PREFIX}/{katex.min.css,fonts/*.woff2}`);
  } else {
    log('未检测到 webServer（headless profile）——HTTP 桥跳过，工具路径不受影响');
  }

  // 会话退役：清理临时打印页（避免 temp/ 越积越多）
  ctx.on('session/disposed', () => {
    try {
      const dir = join(process.cwd(), 'temp', 'exercise');
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.html')) rmSync(join(dir, f), { force: true });
      }
    } catch {
      /* 清理失败不影响功能 */
    }
  });

  log(
    '工具已注册：exercise_list / exercise_new_sheet / exercise_open / exercise_problem / ' +
      'exercise_save_answer / exercise_resplit / exercise_check / exercise_collect_mistake / exercise_lessons / ' +
        'exercise_scratch / exercise_attach_image / exercise_export_text / ' +
      'exercise_sync_worldbook / exercise_build_submission / exercise_progress / ' +
      'exercise_export_handoff / exercise_import_handoff',
  );
}
