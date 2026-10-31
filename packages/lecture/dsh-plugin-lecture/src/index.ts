// ============================================================
// dsh-plugin-lecture · 课堂记录模式（Lecture Mode）
//
// 定位（docs/lecture-mode-plan.md）：
//   是 Aemeath 的**拓展 app**（D1），底层复用 dsh + persona 设计，
//   但**不深度嵌入现有 agent harness 结构**（D2）：
//     · 不接 memory 召回注入
//     · 不接 worldbook 注入
//     · 不接 retriever 注入
//     · 不接 workflow（不调 compute_verify / check_dimensions）
//   可脱离主 agent 在 macOS 上独立运行（P0 验证项）。
//
// 职责：
//   1. 课堂采集：速记 → 分块 → 强制留白 → 落 markdown（D6/D11）
//   2. 课堂内 LLM 转录员加工（D3）：只落后端 .raw.json，**前端不剧透**
//   3. 课后五步复盘（review.ts），第 3 步苏格拉底式引导（D12）
//   4. 复盘完成后才生成结构化摘要 + 候选条目（D4）
//   5. 单向握手导出 handoff.json（D7）
//
// 工具（供 LLM 调用；preset 门控见下）：
//   lecture_session_start / lecture_capture / lecture_status
//   lecture_review_start / lecture_review_recall / lecture_review_next
//   lecture_export_handoff
// ============================================================

import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { registerVolatileSettings } from '@aemeath/dsh-plugin-common';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-tools';
import { LectureStore, allBlanksOk, parseUnitMarkdown } from './store.js';
import { ASSETS_PREFIX, serveAsset } from './assets.js';
import { transcribeChunk, looksLikeSummary, isOverExpanded, type AskLlm } from './transcriber.js';
import { ReviewMachine, looksLikeDirectAnswer } from './review.js';
import { buildHandoff, filterReviewed, writeHandoff, describeHandoff, type Handoff } from './handoff.js';
import { handleLectureHttp, buildCourseList } from './http.js';
import { setLocaleContext, tr, uiLang } from './locale.js';
import {
  importHandoff,
  findHandoffFiles,
  loadHandoffFile,
  describeOutcome,
  type HandoffGatekeeper,
  type GateDecision,
  type WriteGateResult,
} from './import-handoff.js';
import { emptyCourseIndex, type RawChunk, type UnitMeta, type ProcessingRecord, type Candidates, type ReviewState } from './types.js';

export const name = 'aemeath-lecture';
// webServer 可选（inject 里带上会在 headless profile 缺服务时抛错，
// 故用 reflect.get 惰性取——见下方 HTTP 桥接线）。
export const inject = ['tools', 'settings', 'credentials'];

/**
 * 本进程的 profile 名（用于课堂指针的归属判定）。
 *
 * 为什么需要区分 profile：主 profile（Windows 日常）与独立 lecture profile
 * （课堂上/mac）按设计共用同一份数据目录。若不分归属，两边同时记录会互相
 * 覆盖"正在记哪一讲"的指针，恢复时把速记静默追加进另一个单元。
 */
const PROFILE_NAME = process.env.DSH_PROFILE || 'unknown';

/** 主机名（写进指针，便于人工排查"这条是哪台机器写的"）。 */
const HOST_NAME = (() => {
  try {
    return hostname();
  } catch {
    return 'unknown';
  }
})();

export const Config = z.object({
  defaultPreset: z.string(),
  /** 是否挂载工具（volatile：设置页可关）。 */
  enabled: z.boolean().default(true).volatile(),
  /**
   * 这个 profile 是否**就是**课堂独立界面（而不是挂在主 agent 里的一个插件）。
   *
   * 为什么需要它：前端有两条互斥的渲染路径 ——
   *   standalone=true  → 铺满整窗的三栏工作台（StandaloneMount）
   *   standalone=false → 只注册侧栏「课堂」按钮 + shell.overlay 浮层
   * 而客户端的判定（detectStandalone）在**纯浏览器**里三条全部落空：
   *   ① 没有 Electron 壳 → 没有 window.shell.isLectureWindow
   *   ② 没有 URL 标记（dsh 认证 303 → ./ 会把 query 丢掉）
   *   ③ window.__AEMEATH_LECTURE_STANDALONE__ **从来没有生产者**（死分支）
   * 结果：mac 上（无 Electron）永远走主界面模式 ——
   * 用户看到的就是"和主 agent 一模一样的前端"。
   *
   * 所以由 host 侧在页面 boot **之前**注入这个全局标记（见 apply 里的
   * webserver/index-inject）。这比拼 URL 稳：不受认证重定向影响，
   * 浏览器和 Electron 都适用。
   */
  standalone: z.boolean().default(false),
  /** 数据根目录（相对仓库根或绝对路径）。D11：放 physicist 里。 */
  dataDir: z.string(),
  /** 课堂内是否启用 LLM 转录员（D3 加工）。关掉则只存原始速记。 */
  transcribe: z.boolean().default(true),
  /** 握手导出目录（局域网共享目录；空则导出到数据根目录）。 */
  handoffDir: z.string().default(''),
  /** 复盘完成后是否自动导出到 retriever 的 notesDir（便于主 agent 检索）。 */
  exportToNotes: z.boolean().default(false),
  /** retriever 的 notesDir（exportToNotes 为真时使用）。 */
  notesDir: z.string().default('packages/library/physicist/notes'),
  llm: z.object({
    apiKey: z.string().default(''),
    baseUrl: z.string().default('https://api.deepseek.com'),
    model: z.string().default('deepseek-v4-flash'),
  }),
});

export interface LectureConfig {
  defaultPreset?: string;
  enabled?: { get?: () => boolean };
  /** 这个 profile 就是课堂独立界面（host 侧据此注入 boot 标记）。 */
  standalone?: boolean;
  dataDir?: string;
  transcribe?: boolean;
  handoffDir?: string;
  exportToNotes?: boolean;
  notesDir?: string;
  llm?: { apiKey?: string; baseUrl?: string; model?: string };
}

function log(msg: string): void {
  console.log(`[aemeath-lecture] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[aemeath-lecture] ⚠ ${msg}`);
}

/**
 * 下一个速记块序号 = max(已有 seq) + 1。
 *
 * ⚠️ 不要用 `chunks.length`（早先的写法）：中间块被删掉后，
 * length 会与已落盘的 seq 错位，新块拿到重复序号；
 * 而 `allBlanksOk` 是按 seq 报错块的，错位会把报错指向错误的块。
 * 空数组 → 0。
 */
function nextSeq(chunks: ReadonlyArray<{ seq: number }>): number {
  let max = -1;
  for (const c of chunks) if (Number.isFinite(c.seq) && c.seq > max) max = c.seq;
  return max + 1;
}

/** 本地日期 YYYY-MM-DD（**不用 toISOString**：那是 UTC，
 *  东八区 00:00–08:00 记的课会落到前一天）。 */
function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** LLM 超时（转录是后台任务，可比交互式宽松）。 */
const LLM_TIMEOUT_MS = 60_000;

/**
 * 工具统一返回形状。
 *
 * 为什么不用裸对象字面量：dsh 的 `defineTool` 要求 `execute` 返回 `JsonValue`，
 * 其对象分支是 `{ [k: string]: JsonValue }`——**不允许值为 `undefined`**。
 * 若各分支返回形状不一（如有的带 `missing` 有的不带），TS 推断出的联合类型里
 * 会出现 `missing?: undefined`，从而违反索引签名。
 * 因此所有工具统一经 `ok()` / `fail()` 构造，保证键值永不为 undefined。
 */
type ToolResult = { ok: boolean; data: Record<string, JsonValue> };

/**
 * 成功结果：data 内不应有 undefined（调用方保证）。
 *
 * 值类型放宽到 unknown：工具输出本来就是任意 JSON（`output: { schema: { type: 'json' } }`），
 * 而"列出课程"这类返回天然是对象数组。原来的
 * `string | number | boolean | string[] | null` 逼得调用方把结构序列化成字符串，
 * 模型读起来反而更费劲。
 */
function ok(data: Record<string, JsonValue> = {}): ToolResult {
  return { ok: true, data };
}

/** 失败结果：统一 `{ ok:false, error }`，错误信息放 data.error。 */
function fail(error: string, extra: Record<string, JsonValue> = {}): ToolResult {
  return { ok: false, data: { error, ...extra } };
}

/** 工具输出渲染：统一 JSON 文本。 */
const renderJson = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: JSON.stringify(value) },
];

// ============================================================
// 会话内课堂状态（内存态；持久化在文件）
// ============================================================

interface ActiveLecture {
  courseId: string;
  unitId: string;
  title: string;
  date: string;
  chunks: RawChunk[];
}

export async function apply(ctx: Context, config: LectureConfig): Promise<void> {
  setLocaleContext(ctx);
  const enabledRef = (config as { enabled?: { get?: () => boolean } }).enabled;
  const runtime = {
    get enabled(): boolean {
      return enabledRef?.get?.() ?? true;
    },
  };
  registerVolatileSettings('aemeath-lecture', { enabled: runtime.enabled });
  ctx.on('loader/volatile-update', () => {
    log(`settings 已更新: enabled=${runtime.enabled}`);
  });

  const dataDir = config.dataDir ?? 'packages/library/physicist/lectures';
  const store = new LectureStore({ rootDir: dataDir });
  const llm = {
    apiKey: config.llm?.apiKey ?? '',
    baseUrl: config.llm?.baseUrl ?? 'https://api.deepseek.com',
    model: config.llm?.model ?? 'deepseek-v4-flash',
  };
  const transcribeEnabled = config.transcribe ?? true;
  const handoffDir = config.handoffDir || dataDir;
  const exportToNotes = config.exportToNotes ?? false;
  const notesDir = config.notesDir ?? 'packages/library/physicist/notes';

  log(`已挂载：dataDir=${store.rootPath} transcribe=${transcribeEnabled} handoffDir=${handoffDir}`);

  // ---- LLM 通道（照 memory 的 resolveLlmKey 模式） ----
  const resolveLlmKey = async (): Promise<string> => {
    if (llm.apiKey) return llm.apiKey;
    try {
      const resolved = await ctx.credentials?.resolve(credentialRef('DEEPSEEK_API_KEY'));
      return resolved?.value ?? '';
    } catch {
      return '';
    }
  };

  /**
   * 最近一次 LLM 失败的原因（空串 = 没有失败）。
   *
   * 为什么要有它：`AskLlm` 的返回类型是 `string | null`，null 把
   * "没 key / HTTP 500 / 输出被截断 / 模型返回空" 全压成同一个值，
   * 调用方只能回一句"LLM 不可用" —— 用户和我们都无从判断。
   * 现在失败原因记在这里，调用方取一次拼进提示里。
   */
  let lastLlmFailure = '';

  const askLlm: AskLlm = async (prompt, opts) => {
    lastLlmFailure = '';
    const apiKey = await resolveLlmKey();
    if (!apiKey) {
      lastLlmFailure = '没有可用的 API key（检查凭据 DEEPSEEK_API_KEY）';
      warn(`LLM 无 apiKey，跳过（${opts.purpose}）`);
      return null;
    }
    try {
      const body: Record<string, unknown> = {
        model: llm.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        // 让模型自己决定思考多久。
        //
        // 为什么不用 max_tokens 控制长度：推理模型的**思考 token 也计入
        // max_tokens**，实测某次 candidates 的 completion 2404 里 1571 是思考
        // —— 定死一个数只是把截断点往后挪，笔记本就会撞上，撞上就是截断的 JSON。
        reasoning_effort: 'high',
      };
      // 只有明确要求 JSON 才加 —— 否则 DeepSeek 会 400
      // （"Prompt must contain the word 'json' …"）。
      if (opts.json) body.response_format = { type: 'json_object' };
      // 默认**不传** max_tokens（由 API 用默认上限，实测 18000+ token 仍能 stop）。
      // 只有显式传了才带上，留给将来真的需要封顶的场景。
      if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;

      const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });

      if (!resp.ok) {
        // ⚠️ 必须把响应体带出来。
        // 早先只抛 `HTTP ${status}`，于是真实原因（缺 json 字样、余额不足、
        // 上下文超长）全被丢掉，日志里只剩一个 400，根本查不下去。
        let detail = '';
        try {
          const raw = await resp.text();
          // 尽量抽 error.message，抽不到就给原文前 300 字
          try {
            const j = JSON.parse(raw) as { error?: { message?: string } };
            detail = j.error?.message ?? raw.slice(0, 300);
          } catch {
            detail = raw.slice(0, 300);
          }
        } catch {
          /* 响应体读不出来就算了，至少还有状态码 */
        }
        throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
      }

      const data = (await resp.json()) as {
        choices?: {
          finish_reason?: string;
          message?: { content?: string | null; reasoning_content?: string | null };
        }[];
        usage?: { completion_tokens?: number; prompt_tokens?: number };
      };
      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? '';
      const finish = choice?.finish_reason ?? '(未知)';
      const reasoningLen = (choice?.message?.reasoning_content ?? '').length;

      if (!content.trim()) {
        // 空输出几乎总是下面两种之一，把线索一次打全，别让人猜。
        warn(
          `LLM 输出为空（${opts.purpose}）finish_reason=${finish} ` +
            `completion_tokens=${data.usage?.completion_tokens ?? '?'} ` +
            `reasoning_chars=${reasoningLen} ` +
            `max_tokens=${opts.maxTokens ?? '不限制'}` +
            (finish === 'length' ? ' ← 撞到 max_tokens 上限（思考 token 也算在内）' : ''),
        );
        lastLlmFailure =
          finish === 'length'
            ? `输出被截断（思考 token 也算在内，max_tokens=${opts.maxTokens ?? '默认'}）`
            : finish === '(未知)'
              ? '模型返回空内容'
              : `模型返回空内容（finish_reason=${finish}）`;
        return null;
      }
      if (finish === 'length') {
        // 截断的 JSON 解析出来一定是坏的，不如明确失败，让调用方走降级。
        warn(`LLM 输出被截断（${opts.purpose}）finish_reason=length，已丢弃`);
        lastLlmFailure = `输出被截断（max_tokens=${opts.maxTokens ?? '默认'}）`;
        return null;
      }
      return content;
    } catch (e) {
      // `fetch failed` 本身没有信息量 —— 真正的原因（ECONNREFUSED、
      // 证书错误、超时）在 cause 里，一并带出来。
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const cause = err.cause?.code ?? err.cause?.message ?? '';
      lastLlmFailure = cause ? `${err.message}（${cause}）` : err.message;
      warn(`LLM 调用失败（${opts.purpose}）: ${lastLlmFailure}`);
      return null;
    }
  };

  // ---- 会话内状态（key = dsh sessionId） ----
  const active = new Map<string, ActiveLecture>();
  const machines = new Map<string, ReviewMachine>();

  /**
   * 跑一次「对照」，把结果写进状态机。
   *
   * 抽成函数是因为它要在**两个地方**用到：
   *   · 提交「你先说」之后（正常路径）
   *   · 在"对照"页点「开始补漏」但还没有对照结果时（**重试**）
   *
   * 后者很关键：对照失败时 `submitRecall` 已经把 step 推到了 compare，
   * 前端又没有退回"你先说"的入口 —— 不给重试就是死路一条。
   */
  const runCompare = async (
    m: ReviewMachine,
    sessionKey: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const chunks = loadChunksFromFile(sessionKey, m.current.unit_id);
    const out = await askLlm(m.buildComparePrompt(m.current.recall_text, chunks), {
      // 2500：对照要输出三栏 JSON，而推理模型的思考 token 也计入这个预算。
      // 早先给 1500，笔记多一点就可能被截断（截断的 JSON 必然解析失败）。
      purpose: 'lecture-compare',
      json: true, // 对照结果是结构化 JSON
    });
    if (!out) return { ok: false, reason: lastLlmFailure || '模型没有返回内容' };
    const comp = ReviewMachine.parseComparison(out);
    if (!comp) {
      return {
        ok: false,
        reason: `模型返回的内容不是预期的三栏 JSON（前 80 字：${out.trim().slice(0, 80)}）`,
      };
    }
    m.setComparison(comp);
    return { ok: true };
  };

  /**
   * 写摘要（D4 的唯一出口）。
   *
   * 两条路径（工具 lecture_review_next / 前端 HTTP `op: 'next'`）都必须走这里，
   * 保证 `has_summary` 的含义一致：**候选生成 = 摘要就绪**。
   *
   * 早先的偏差：前端路径把摘要推迟到第 5 步 commit 才写，于是"已生成候选但未确认"
   * 的单元在两条路径下 `has_summary` 不同 —— 握手的 summary_ref 会时有时无。
   * 两者都不违反 D4（都不早于第 4 步），但语义分裂本身就是 bug。
   */
  const writeSummaryFor = (
    courseId: string,
    unitId: string,
    cand: Candidates,
    model: string,
  ): void => {
    try {
      store.writeSummary(courseId, unitId, {
        text: JSON.stringify(cand, null, 2),
        created_at: Date.now(),
        model,
      });
    } catch (e) {
      warn(`写摘要失败（${courseId}/${unitId}）：${(e as Error).message}`);
    }
  };

  /**
   * 当前课堂的**磁盘指针**。
   *
   * 为什么需要：`active` 是内存态，进程重启即空。若只靠内存，
   * 重启后 `lecture_capture` 会失败并被迫重新 `session_start`——
   * 而课堂上进程可能被重启（换电池/误关窗口），此时丢掉"正在记哪一讲"
   * 会直接打断记录。
   *
   * ⚠️ **为什么不只用单个 `_active.json`**（早先的实现，已修正）：
   *    当时的注释假设"一个数据目录同时只有一节进行中的课（课堂场景成立）"。
   *    但这个前提**不成立**：主 profile（Windows 日常）与独立 lecture profile
   *    （课堂上/mac）按设计共用同一份 `packages/library/physicist/lectures`
   *    （见 profiles/aemeath/cordis.patch.yml 与 README 的用法表）。
   *    于是两处同时记录会互相覆盖指针，恢复时把速记**静默追加进另一个单元**。
   *
   * 现在的做法：
   *   · 每个会话写自己的 `_active.<ownerHash>.json`（owner = profile|sessionId）
   *   · 指针里记录 `owner` 与 `host`，恢复时校验归属
   *   · 若同一目录存在**其他 owner 的活跃指针**，warn 一条（不阻断——
   *     跨机器场景下那可能是正常的另一台设备）
   */
  const POINTER_PREFIX = '_active';

  interface ActivePointer {
    course_id: string;
    unit_id: string;
    title: string;
    date: string;
    started_at: number;
    /** 归属标识（profile|sessionId 的短哈希）——用于多 owner 共存时避免互踩。 */
    owner?: string;
    /** 可读的主机名，便于人工排查"这条指针是谁写的"。 */
    host?: string;
  }

  /** owner 短哈希：把 profile|sessionId 压成文件名安全的小串。 */
  const ownerHash = (sid: string | undefined): string => {
    const seed = `${PROFILE_NAME}|${sid ?? 'unknown'}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };

  const pointerFileOf = (sid: string | undefined): string =>
    `${POINTER_PREFIX}.${ownerHash(sid)}.json`;

  /** 列出目录下所有活跃指针文件（含别的 owner 的）。 */
  const listPointerFiles = (): string[] => {
    try {
      return readdirSync(store.rootPath).filter(
        (f) => f.startsWith(`${POINTER_PREFIX}.`) && f.endsWith('.json'),
      );
    } catch {
      return [];
    }
  };

  const parsePointer = (file: string): ActivePointer | null => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ActivePointer>;
      if (!raw.course_id || !raw.unit_id) return null;
      return {
        course_id: String(raw.course_id),
        unit_id: String(raw.unit_id),
        title: String(raw.title ?? ''),
        date: String(raw.date ?? ''),
        started_at: Number(raw.started_at ?? 0),
        owner: raw.owner ? String(raw.owner) : undefined,
        host: raw.host ? String(raw.host) : undefined,
      };
    } catch {
      return null;
    }
  };

  /** 读**本会话自己**的指针。 */
  const readPointer = (sid: string | undefined): ActivePointer | null => {
    const file = join(store.rootPath, pointerFileOf(sid));
    if (!existsSync(file)) return null;
    return parsePointer(file);
  };

  const writePointer = (sid: string | undefined, p: ActivePointer): void => {
    try {
      if (!existsSync(store.rootPath)) mkdirSync(store.rootPath, { recursive: true });
      const full: ActivePointer = {
        ...p,
        owner: ownerHash(sid),
        host: HOST_NAME,
      };
      writeFileSync(join(store.rootPath, pointerFileOf(sid)), JSON.stringify(full, null, 2), 'utf-8');
    } catch (e) {
      warn(`写课堂指针失败: ${(e as Error).message}`);
    }
  };

  /** 清除本会话的指针（结束/销毁时）。 */
  const clearPointer = (sid: string | undefined): void => {
    try {
      rmSync(join(store.rootPath, pointerFileOf(sid)), { force: true });
    } catch {
      /* 忽略：清不掉不影响使用 */
    }
  };

  /**
   * 检出**其他 owner** 留下的活跃指针（多 profile / 多机器共用同一数据目录）。
   * 不阻断，只 warn —— 用户需要知道"这里还有另一处正在记录"。
   */
  const warnForeignPointers = (sid: string | undefined): void => {
    const mine = `${POINTER_PREFIX}.${ownerHash(sid)}.json`;
    for (const f of listPointerFiles()) {
      if (f === mine) continue;
      const p = parsePointer(join(store.rootPath, f));
      if (!p) continue;
      warn(
        `检测到其他课堂指针：${f} → ${p.course_id}/${p.unit_id}` +
          `${p.host ? `（来自 ${p.host}）` : ''}。` +
          '若那是另一台设备/另一个 profile，属正常；否则请确认不要重复记录。',
      );
    }
  };

  /**
   * 取当前课堂会话：内存优先；内存为空则**从磁盘指针恢复**（进程重启场景）。
   *
   * 恢复时会从已落盘的 markdown 重建 chunks（`parseUnitMarkdown`），
   * 使 capture 能接着追加而不丢已记内容。
   */
  const activeOf = (sid: string | undefined): ActiveLecture | null => {
    if (!sid) return null;
    const mem = active.get(sid);
    if (mem) return mem;
    // —— 磁盘恢复（只认本会话自己的指针，避免把速记写进别人的单元）——
    const p = readPointer(sid);
    if (!p) return null;
    const index = store.readIndex(p.course_id);
    const unit = index?.units.find((u) => u.id === p.unit_id);
    if (!unit) return null;
    const md = store.readUnitMarkdown(p.course_id, unit);
    const chunks = md ? parseUnitMarkdown(md).chunks : [];
    const restored: ActiveLecture = {
      courseId: p.course_id,
      unitId: p.unit_id,
      title: p.title || unit.title,
      date: p.date || unit.date,
      chunks,
    };
    active.set(sid, restored);
    log(`课堂状态已从磁盘恢复：${p.course_id}/${p.unit_id}（${chunks.length} 块）`);
    return restored;
  };

  // ============================================================
  // 开课（工具与 HTTP 共用同一条路径）
  // ============================================================

  /**
   * 开始一节课：确保课程存在 → 建单元 → 设为该会话的当前课堂 → 落磁盘指针。
   *
   * 为什么要抽出来：早先只有对话里的 `lecture_session_start` 工具能开课，
   * 前端点开课堂界面只看到一句"还没有课程"，既没有输入框也不知道下一步 ——
   * 死路。现在 HTTP 桥也走这条路径，界面自己就能开课。
   * 两条路径**共用**这段逻辑，避免再次出现"工具能做、界面不能做"的分叉。
   */
  const startSession = (
    sid: string,
    args: {
      courseId: string;
      title: string;
      courseTitle?: string;
      semester?: string;
      moduleCode?: string;
      date?: string;
      unitId?: string;
    },
  ): { course_id: string; unit_id: string; date: string; file: string } => {
    const date = args.date || localDateString();
    const index = store.ensureCourse(
      args.courseId,
      args.courseTitle || args.courseId,
      args.semester ?? '',
      args.moduleCode ?? '',
    );
    const unitId = args.unitId || `u${String(index.units.length + 1).padStart(2, '0')}`;
    const file = `${date}-${unitId}.md`;
    const unit: UnitMeta = { id: unitId, date, title: args.title, file, reviewed: false, has_summary: false };
    store.upsertUnit(index.course_id, unit);
    active.set(sid, { courseId: index.course_id, unitId, title: args.title, date, chunks: [] });
    // 磁盘指针：进程重启后 capture 仍能接着记（见 activeOf 的恢复逻辑）。
    // 按会话/归属分片 —— 多 profile 共用同一数据目录时不会互踩。
    writePointer(sid, { course_id: index.course_id, unit_id: unitId, title: args.title, date, started_at: Date.now() });
    // 检出别的 owner 的活跃指针（不阻断，只提醒）
    warnForeignPointers(sid);
    log(`课堂开始：${index.course_id}/${unitId}（${args.title}）`);
    return { course_id: index.course_id, unit_id: unitId, date, file };
  };

  // ============================================================
  // 工具集
  // ============================================================

  ctx.tools.register(
    defineTool({
      name: 'lecture_session_start',
      description:
        '开始一节课堂记录。指定课程（不存在则创建）与本次课的主题。返回单元 id，后续 lecture_capture 用它记录速记。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识，如 "physik-1"' },
        title: { type: 'string', required: true, description: '本次课主题，如 "第3讲 角动量"' },
        course_title: { type: 'string', description: '课程全名，如 "Physik I"；仅创建时使用' },
        semester: { type: 'string', description: '学期，如 "WiSe"' },
        module_code: { type: 'string', description: '模块号，如 "PHY-101"' },
        date: { type: 'string', description: '日期 YYYY-MM-DD；缺省今天' },
        unit_id: { type: 'string', description: '单元 id；缺省按日期+序号生成' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: {
        course_id: string;
        title: string;
        course_title?: string;
        semester?: string;
        module_code?: string;
        date?: string;
        unit_id?: string;
      }, exec) => {
        const sid = exec.agent?.session?.id ?? 'default';
        const r = startSession(sid, {
          courseId: args.course_id,
          title: args.title,
          courseTitle: args.course_title,
          semester: args.semester,
          moduleCode: args.module_code,
          date: args.date,
          unitId: args.unit_id,
        });
        return ok({ course_id: r.course_id, unit_id: r.unit_id, date: r.date, file: r.file, chunk_count: 0 });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'lecture_capture',
      description:
        '记录一段课堂速记（**只记录用户说的内容**）。用标记语法：# 主题、= 公式、? 疑问、! 重点、> 例子、--- 分块。' +
        '\n\n' +
        '⚠️ 留白（[我的理解] / [我的疑问]）**只能由用户本人写**，你绝对不能代笔：' +
        '这两栏是"主动回忆"的核心，你替用户写就等于把练习做掉了。' +
        '\n\n' +
        '所以调用本工具时：' +
        '\n  · 用户**已经说了**自己的理解/疑问 → 填进对应参数；' +
        '\n  · 用户**没说** → **不要编**，留空即可（工具会接受并返回需要追问的提示），' +
        '然后用一句话问用户"这段你自己的理解是什么？哪里还没搞懂？"，等用户回答后再补传。' +
        '\n\n' +
        '系统会在后台把速记规范化（公式补 LaTeX），加工结果不会显示在对话里。',
      parameters: {
        raw: { type: 'string', required: true, description: '原始速记文本（可用 --- 分多个块）' },
        // 注意：**不能写 required**（类型只接受 required: true 或省略）。
        // 这两个留白**可选**是故意的 —— 见上面的说明：模型不得代笔。
        my_understanding: {
          type: 'string',
          description:
            '[我的理解]：**必须原样引用用户自己说过的话**。用户没说就留空，不要自行总结、不要代写。',
        },
        my_question: {
          type: 'string',
          description: '[我的疑问]：同上，**只能来自用户本人**。用户没提就留空。',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { raw: string; my_understanding?: string; my_question?: string }, exec) => {
        const sid = exec.agent?.session?.id ?? 'default';
        const cur = activeOf(sid);
        if (!cur) return fail('尚未开始课堂（请先调用 lecture_session_start）');
        const understanding = (args.my_understanding ?? '').trim();
        const question = (args.my_question ?? '').trim();
        // 留白缺失时**照样落盘**，只是标记为未完成并提示追问。
        //
        // 为什么不再"不填不继续"：早先把这两个参数设成 required 且描述写"必须同时给出"，
        // 模型于是**自己编了理解与疑问**填进去 —— 用户明确反馈了这个错误
        //（"模型错误理解为模型需要给出它的理解和疑问"）。
        // 留白是**用户的**，模型代笔会让主动回忆完全失效。
        // 正确做法：记录照收，缺失就**回问用户**，由用户补齐。
        const missing: string[] = [];
        if (!understanding) missing.push('[我的理解]');
        if (!question) missing.push('[我的疑问]');
        const seq = nextSeq(cur.chunks);
        const chunk: RawChunk = {
          seq,
          raw: args.raw,
          my_understanding: understanding,
          my_question: question,
          created_at: Date.now(),
        };
        cur.chunks.push(chunk);
        persist(cur);
        // 后台转录（D3）：不阻塞、结果只落后端
        if (transcribeEnabled) void runTranscribe(cur, chunk);
        return ok({
          chunk_seq: seq,
          chunk_count: cur.chunks.length,
          note: tr('已记录（后台规范化中，结果不回显）', 'Saved (normalizing in the background; the result is not shown in the UI)'),
          // 缺留白时把"该问用户什么"明确交回去，模型照着问即可，不要自己编答案。
          ...(missing.length
            ? {
                blanks_missing: missing,
                ask_user:
                  uiLang() === 'en'
                    ? `Saved. This chunk still needs ${missing.join(', ')} — you have to write that yourself (active recall); I cannot do it for you. Can you say in your own words what this part was about and what is still unclear?`
                    : `这段已记下，但还缺 ${missing.join('、')} —— ` +
                      '这是要**你自己**写的（主动回忆），我不能替你写。' +
                      '能用自己的话说说这段讲了什么、哪里还没搞懂吗？说完我补记进去。',
              }
            : {}),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'lecture_status',
      description:
        '查看课堂记录状态。**这也是查"有哪些课"的入口** —— 没有进行中的课堂时，' +
        '它会列出磁盘上所有课程与单元（course_id / 标题 / 日期 / 是否已复盘）。' +
        '想知道"课堂讲了什么"、或需要 course_id 时先调它，不要靠猜或去翻文件系统。',
      parameters: {},
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (_args, exec) => {
        const sid = exec.agent?.session?.id ?? 'default';
        const cur = activeOf(sid);
        if (!cur) {
          // ⚠️ 真机踩过：这里原来只回 `active:false`，于是主 agent 被问
          //    "课堂讲了什么"时完全不知道有哪些课，只能猜一个 course_id
          //    （猜了 physik-1），猜错之后开始 glob 全盘找 json，最后放弃。
          //    没有进行中的课堂 ≠ 没有课堂数据 —— 必须把已有的列出来。
          let courses: JsonValue[] = [];
          try {
            courses = buildCourseList(store).map((c) => ({
              course_id: c.course_id,
              title: c.title,
              units: c.units.map((u) => ({
                unit_id: u.id,
                date: u.date,
                title: u.title,
                reviewed: u.reviewed,
                chunk_count: u.chunk_count,
              })),
            }));
          } catch (e) {
            warn(`列出课程失败：${(e as Error).message}`);
          }
          return ok({
            active: false,
            courses,
            hint: courses.length
              ? '当前没有正在记的课堂。上面是已有的课程；要看某一讲讲了什么，用它所在的课程目录下的 markdown（讲座目录见 lecture_export_handoff 的 handoff_dir）。'
              : '当前没有进行中的课堂，磁盘上也还没有任何课程记录。',
          });
        }
        const blanks = allBlanksOk(cur.chunks);
        return ok({
          active: true,
          course_id: cur.courseId,
          unit_id: cur.unitId,
          title: cur.title,
          date: cur.date,
          chunk_count: cur.chunks.length,
          blanks_ok: blanks.ok,
          blanks_bad: blanks.badSeqs.map(String),
        });
      },
    }),
  );

  // ---------- 课后复盘 ----------

  ctx.tools.register(
    defineTool({
      name: 'lecture_review_start',
      description:
        '开始课后复盘（五步）。第一步是「你先说」：不给任何提示，凭记忆复述这节课。' +
        '提示：开始前不要把课堂记录展示给用户（会破坏主动回忆）。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识' },
        unit_id: { type: 'string', required: true, description: '单元 id' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id: string; unit_id: string }, exec) => {
        const sid = exec.agent?.session?.id ?? 'default';
        const index = store.readIndex(args.course_id);
        if (!index) return fail(`课程不存在: ${args.course_id}`);
        const unit = index.units.find((u) => u.id === args.unit_id);
        if (!unit) return fail(`单元不存在: ${args.unit_id}`);
        const existing = store.readReviewState(index.course_id, args.unit_id);
        const machine = new ReviewMachine(args.unit_id, existing, uiLang());
        machines.set(sid, machine);
        // 让 courseIdOf() 在无 active 课堂时也能解析（会话重启后复盘）
        if (!active.has(sid)) {
          active.set(sid, { courseId: index.course_id, unitId: args.unit_id, title: unit.title, date: unit.date, chunks: [] });
        }
        log(`复盘开始：${index.course_id}/${args.unit_id}（step=${machine.step}）`);
        return ok({
          step: machine.step,
          unit_id: unit.id,
          unit_title: unit.title,
          unit_date: unit.date,
          instruction:
            machine.step === 'recall'
              ? '请**凭记忆**说出这节课你记得什么。不要查看任何资料，想到多少说多少。'
              : `上次进行到 ${machine.step} 步，可继续。`,
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'lecture_review_submit',
      description:
        '提交复盘内容。按当前步骤解释：recall=你凭记忆说的内容；repair_answer=对上一个追问的回答。' +
        '系统按步骤返回下一步（compare 会给出三栏对照；repair 给出下一个苏格拉底式追问）。',
      parameters: {
        text: { type: 'string', required: true, description: '本步要提交的文本' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { text: string }, exec) => {
        const sid = exec.agent?.session?.id ?? 'default';
        const m = machines.get(sid);
        if (!m) return fail('尚未开始复盘（请先调用 lecture_review_start）');
        const text = args.text.trim();
        if (!text) return fail('内容为空');

        // 第 1 步 → 第 2 步（对照）
        if (m.step === 'recall') {
          m.submitRecall(text);
          const cmp = await runCompare(m, sid);
          if (!cmp.ok) {
            persistReview(sid, m);
            // 把**具体原因**返回，而不是笼统的"LLM 不可用"
            return ok({
              step: 'compare',
              comparison: null,
              note: `${tr('对照生成失败', 'Comparison failed')}：${cmp.reason}`,
              retry: tr(
                '可以再调一次 lecture_review_next 重试对照（不用重新说一遍）',
                'Call lecture_review_next again to retry the comparison — no need to repeat your recall',
              ),
            });
          }
          persistReview(sid, m);
          return ok({
            step: m.step,
            comparison: JSON.stringify(m.current.comparison),
            instruction: '这是对照结果。接下来做定点补漏：只针对"漏了/记错"的点。',
          });
        }

        // 第 3 步：记录回答，给出下一个追问
        if (m.step === 'repair') {
          const lastQ = m.current.repair_turns.filter((t) => t.answer === '').at(-1)?.question ?? m.current.repair_turns.at(-1)?.question ?? '(未记录的上一问)';
          m.addRepairTurn(lastQ, text);
          persistReview(sid, m);

          // 问够了就收尾（用户："不要追着我一直问"）。
          // 两种结束条件：轮数到上限，或模型说 DONE。
          if (m.repairExhausted) {
            return ok({ step: 'repair', question: null, done: true, note: tr('补漏到此为止（已经问得够多了），可以进入下一步。', 'Enough repair questions — you can move on.') });
          }

          const out = await askLlm(m.buildRepairPrompt(), {
              purpose: 'lecture-repair',
              // 纯文本追问，不要 json
            });
          if (!out) return ok({ step: 'repair', question: null, note: tr('追问生成失败（LLM 不可用）', 'Follow-up generation failed (LLM unavailable)') });
          if (ReviewMachine.isRepairDone(out)) {
            return ok({ step: 'repair', question: null, done: true, note: tr('模型认为该确认的都确认了，可以进入下一步。', 'The model thinks everything needed has been confirmed — you can move on.') });
          }
          const q = out.trim();
          // D12 护栏：引导者不得直接给答案（启发式，见 review.ts）
          if (looksLikeDirectAnswer(q)) {
            warn('引导输出疑似直接给答案（D12 护栏触发），已拦截');
            return ok({
              step: 'repair',
              question: null,
              warning: tr('LLM 输出疑似直接给答案，已拦截。请让学生继续尝试，或换个角度提问。', 'The LLM output looked like a direct answer, so it was blocked. Let the student keep trying, or ask from a different angle.'),
            });
          }
          m.addRepairTurn(q, '');
          persistReview(sid, m);
          return ok({ step: 'repair', question: q, instruction: '让学生先回答，不要替他答。' });
        }

        return fail(`当前步骤 ${m.step} 不接受此提交（用 lecture_review_next 推进）`);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'lecture_review_next',
      description:
        '推进复盘到下一步。repair→candidates 会生成候选条目（此时才允许生成结构化摘要，D4）；' +
        'candidates→commit 进入逐条确认；commit 需传 confirmed 数量完成写入。',
      parameters: {
        confirmed_worldbook: { type: 'number', description: 'commit 步：确认写入的知识条目数' },
        confirmed_claims: { type: 'number', description: 'commit 步：确认写入的属性断言数' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { confirmed_worldbook?: number; confirmed_claims?: number }, exec) => {
        const sid = exec.agent?.session?.id ?? 'default';
        const m = machines.get(sid);
        if (!m) return fail('尚未开始复盘');
        const cid = courseIdOf(sid);

        if (m.step === 'compare') {
          // 对照失败后停在 compare：就地重试，不让用户重说一遍。
          if (!m.current.recall_text) return fail('还没有「你先说」的内容');
          const retry = await runCompare(m, sid);
          persistReview(sid, m);
          if (!retry.ok) return ok({ step: 'compare', comparison: null, note: `对照重试失败：${retry.reason}` });
          return ok({
            step: m.step,
            comparison: JSON.stringify(m.current.comparison),
            instruction: '对照已补上。再调用一次 lecture_review_next 开始定点补漏。',
          });
        }

        // ⚠️ 和 HTTP 路径同一个坑：这里原来直接 finishRepair()，
        //    于是"第一个补漏问题"从来没生成过 —— agent 只能自己编，
        //    或者补漏整个被跳过（D12 失效）。
        //    按"有没有问过问题"区分：没问过 = 生成第一个；问过了 = 结束补漏。
        if (m.step === 'repair' && m.current.repair_turns.length === 0) {
          const out = await askLlm(m.buildRepairPrompt(), {
            purpose: 'lecture-repair',
            // 纯文本追问，不要 json
          });
          if (!out) {
            persistReview(sid, m);
            return ok({ step: 'repair', question: null, note: `第一个问题生成失败：${lastLlmFailure || '模型没有返回内容'}` });
          }
          // 学生全都记住了 → 模型直接说 DONE，不用硬造问题
          if (ReviewMachine.isRepairDone(out)) {
            persistReview(sid, m);
            return ok({ step: 'repair', question: null, done: true, note: tr('没有需要补漏的点，可以直接进入下一步。', 'Nothing to repair — you can move on.') });
          }
          const firstQ = out.trim();
          if (looksLikeDirectAnswer(firstQ)) {
            warn('引导输出疑似直接给答案（D12 护栏触发），已拦截');
            persistReview(sid, m);
            return ok({
              step: 'repair',
              question: null,
              warning: tr('LLM 输出疑似直接给答案，已拦截。换个角度再试一次。', 'The LLM output looked like a direct answer, so it was blocked. Try a different angle.'),
            });
          }
          m.addRepairTurn(firstQ, '');
          persistReview(sid, m);
          return ok({ step: 'repair', question: firstQ, instruction: '让学生先回答，不要替他答。' });
        }

        if (m.step === 'repair') {
          m.finishRepair();
          const chunks = loadChunksFromFile(sid, m.current.unit_id);
          const unitId = m.current.unit_id;
          const processing = store.readProcessing(cid, unitId);
          const out = await askLlm(m.buildCandidatesPrompt(chunks, processing), {
            purpose: 'lecture-candidates',
            json: true, // 候选条目是结构化 JSON
          });
          const cand = ReviewMachine.parseCandidates(out, unitId, uiLang());
          if (!cand) {
            persistReview(sid, m);
            return ok({ step: m.step, candidates: null, note: tr('候选条目生成失败（LLM 不可用或输出不可解析）', 'Candidate generation failed (LLM unavailable or output unparseable)') });
          }
          store.writeCandidates(cid, cand);
          // D4：复盘到第 4 步（候选生成）才写摘要。
          //
          // ⚠️ 两条路径（工具 / HTTP）必须**在同一时刻**写摘要，否则
          //    `has_summary` 的含义会分裂：工具的路径第 4 步就有摘要，
          //    前端的路径要等第 5 步确认。两边都用本处语义：
          //    「候选生成 = 已产出可握手的内容」→ 写摘要。
          //    （早先前端路径把摘要在 commit 时才写，已统一到这里。）
          writeSummaryFor(cid, unitId, cand, llm.model);
          persistReview(sid, m);
          return ok({
            step: m.step,
            candidates: JSON.stringify(cand),
            instruction: '请逐条确认/修改/删除，然后调用 lecture_review_next 完成写入。',
          });
        }

        if (m.step === 'candidates') {
          const cand = store.readCandidates(cid, m.current.unit_id);
          if (!cand) return fail('候选条目缺失，无法进入确认步');
          m.setCandidates();
          persistReview(sid, m);
          return ok({ step: m.step, candidates: JSON.stringify(cand) });
        }

        if (m.step === 'commit') {
          const unitId = m.current.unit_id;
          const cand = store.readCandidates(cid, unitId);
          if (!cand) return fail('候选条目缺失');
          m.commit();
          store.markUnit(cid, unitId, { reviewed: true, has_summary: true });
          persistReview(sid, m);
          // 可选：导出为讲义供主 agent 检索（plan §4.2）
          let exported = '';
          if (exportToNotes) {
            const index = store.readIndex(cid);
            const unit = index?.units.find((u) => u.id === unitId);
            if (unit) exported = store.exportForRetrieval(cid, unit, notesDir) ?? '';
          }
          log(`复盘完成：${cid}/${unitId}`);
          return ok({
            step: 'done',
            exported_to: exported,
            worldbook_confirmed: args.confirmed_worldbook ?? cand.worldbook_entries.length,
            claims_confirmed: args.confirmed_claims ?? cand.entity_claims.length,
            instruction: '复盘完成。可调用 lecture_export_handoff 导出进度与短板，上传到主 agent。',
          });
        }

        return fail(`当前步骤 ${m.step} 无需推进`);
      },
    }),
  );

  // ---------- 握手导出 ----------

  // ============================================================
  // 握手**导出**（课堂侧 → 主 agent 侧）
  //
  // ⚠️ 为什么要抽成函数：复盘确认后要**自动导出**，不能只靠人记得调工具。
  //
  //   真机踩过（用户："前端说写入主agent了，但是肯定没有，
  //   肯定只是在mac上面，是不是还没做注入到windows主客户端这一块？"）：
  //   commit 步只写本机 .candidates.json，前端却提示"已记录"。
  //   而导出是**另一个手动工具**，没人调就永远不过去。
  //
  //   现实约束（决定了方案）：上课时 mac 在教室、Windows 在家，
  //   **两台机器不可能同时在线** → 不存在"自动推送"的选项，
  //   只能"mac 导出自包含文件 → 人搬运 → Windows 一键导入"。
  //   所以能自动化的是**导出**这一步（别让人记着调工具），
  //   导入那一步必须由人在 Windows 上触发（文件得先到那儿）。
  // ============================================================

  /**
   * 导出握手包。
   *
   * @param courseId 指定课程；缺省导出全部课程
   * @returns 写出的文件绝对路径 + 每个包的摘要
   */
  function exportHandoffNow(courseId?: string): { files: string[]; summaries: string[] } {
    const ids = courseId ? [courseId] : store.listCourses();
    const written: string[] = [];
    const summaries: string[] = [];
    for (const cid of ids) {
      const index = store.readIndex(cid);
      if (!index) continue;
      const cands = new Map<string, Candidates | null>();
      const reviews = new Map<string, ReviewState | null>();
      for (const u of index.units) {
        cands.set(u.id, store.readCandidates(cid, u.id));
        reviews.set(u.id, store.readReviewState(cid, u.id));
      }
      const h: Handoff = filterReviewed(buildHandoff({ index, candidatesByUnit: cands, reviewByUnit: reviews }));
      written.push(writeHandoff(h, handoffDir, `${cid}-handoff.json`));
      summaries.push(describeHandoff(h));
    }
    return { files: written, summaries };
  }

  ctx.tools.register(
    defineTool({
      name: 'lecture_export_handoff',
      description:
        '导出握手包（课程进度 + 用户短板 + 粗略单元内容）到局域网文件，供上传到主 agent。' +
        '只导出已复盘单元的内容；不含课堂原始速记。' +
        '**course_id 可以省略**（省略就导出全部课程）；不确定有哪些课时先调 lecture_status。',
      parameters: {
        // ⚠️ 这里原来是 required: true，而描述却写着"缺省导出全部课程"—— 自相矛盾。
        //    结果主 agent 必须传一个 id，但它不知道有哪些课，只能猜（猜了 physik-1），
        //    猜错后开始在文件系统里 glob 找 json。改成真可选。
        course_id: {
          type: 'string',
          
          description: '课程标识；省略 = 导出全部课程。用 lecture_status 可以查到所有 course_id。',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id?: string }) => {
        const known = store.listCourses();
        // 传了 id 但不存在 → 直接把可用的列出来，别让它去猜
        if (args.course_id && !known.includes(args.course_id)) {
          return fail(
            `没有课程 "${args.course_id}"。可用的 course_id：${known.length ? known.join('、') : '(磁盘上还没有任何课程)'}`,
            { active: false, course_id: args.course_id, available: known },
          );
        }
        const { files: written, summaries } = exportHandoffNow(args.course_id);
        if (!written.length) {
          return fail(
            known.length
              ? `没有可导出的课程内容。磁盘上的课程：${known.join('、')}（可能都还没复盘）`
              : '磁盘上还没有任何课程记录',
            { active: false, available: known },
          );
        }
        log(`握手包已导出 ${written.length} 个 → ${handoffDir}`);
        return ok({
          files: written,
          handoff_dir: handoffDir,
          summaries,
          note:
            '把这些文件搬到主 agent 所在的机器，然后在那边调 lecture_import_handoff 导入' +
            '（或直接说"导入讲义进度"，主 agent 会自动扫 handoffDir）。',
        });
      },
    }),
  );

  // ============================================================
  // 读笔记内容（"课堂讲了什么"）
  //
  // 真机踩过：用户在主 agent 里问"课堂讲了什么"，agent 手上只有
  // status / export / import 三个工具，没有一个能读笔记正文，
  // 于是它开始 glob 搜 `**/*.json`、`**/lecture*`，翻了七八次才摸到文件。
  //
  // 这个工具就是干这件事的：一句话拿到某一讲的 markdown 原文。
  // ============================================================
  ctx.tools.register(
    defineTool({
      name: 'lecture_read',
      description:
        '读某一讲的课堂笔记正文（markdown，公式是 $…$ 形式）。' +
        '用来回答"课堂讲了什么""这一节的笔记是什么"这类问题 —— ' +
        '不要靠 glob 去文件系统里找。' +
        '两个参数都可以省略：省略 course_id 用最近有记录的课程，省略 unit_id 用该课最近一讲。' +
        '不确定有哪些课时先调 lecture_status。',
      parameters: {
        course_id: {
          type: 'string',
          
          description: '课程标识；省略 = 最近有记录的课程。用 lecture_status 可查。',
        },
        unit_id: {
          type: 'string',
          
          description: '单元 id（如 u01）；省略 = 该课程最近一讲。',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id?: string; unit_id?: string }) => {
        const known = store.listCourses();
        if (!known.length) {
          return fail('磁盘上还没有任何课堂记录', { active: false, available: [] });
        }

        // 选课程：给了就用，没给就取最近修改的那门
        const pickCourse = (): string => {
          if (args.course_id) return args.course_id;
          return known[known.length - 1]!;
        };
        const cid = pickCourse();
        if (!known.includes(cid)) {
          return fail(`没有课程 "${cid}"。可用的 course_id：${known.join('、')}`, {
            active: false,
            available: known,
          });
        }

        const index = store.readIndex(cid);
        if (!index || !index.units.length) {
          return fail(`课程 "${cid}" 还没有任何单元`, { active: false, available: known });
        }

        // 选单元：给了就用；没给就取**最后一讲有内容的**。
        //
        // 真机场景：刚开课时会建出一个空单元（00 chunks）。如果直接取"最后一讲"，
        // 用户问"课堂讲了什么"会得到"读不到"——而上一讲其实有内容。
        const unitIdArg = args.unit_id;
        let unit = unitIdArg ? index.units.find((u) => u.id === unitIdArg) : undefined;
        if (!unit && !unitIdArg) {
          const reversed = [...index.units].reverse();
          unit = reversed.find((u) => store.readUnitMarkdown(cid, u)) ?? reversed[0];
        }
        if (!unit) {
          return fail(
            `课程 "${cid}" 没有单元 "${unitIdArg}"。可用的 unit_id：${index.units.map((u) => u.id).join('、')}`,
            { active: false, available: known },
          );
        }

        const md = store.readUnitMarkdown(cid, unit);
        if (!md) {
          return fail(`单元 ${cid}/${unit.id} 的笔记文件读不到（可能还没记录内容）`, {
            active: false,
            available: known,
          });
        }

        return ok({
          course_id: cid,
          course_title: index.title,
          unit_id: unit.id,
          date: unit.date,
          title: unit.title,
          reviewed: unit.reviewed,
          // 原文交给模型去回答"讲了什么"—— 不做摘要，避免二次丢失细节
          markdown: md,
          units: index.units.map((u) => ({ unit_id: u.id, date: u.date, title: u.title })),
        });
      },
    }),
  );

  // ============================================================
  // P4：握手**接收侧**（在主 agent 上跑）
  //
  // 与导出相对：读 handoff.json → 过守门员 → 写入主记忆。
  // ⚠️ 绝不直接 ctx.memory.save()（其注释写明「守门员已判定后调用」）。
  //    这里自己跑 decide/writeGate，判定结果一并交给 save。
  //
  // 主 agent 侧需提供 HandoffGatekeeper（三函数）。取不到时（比如在
  // lecture 自己的 profile 里）优雅降级：工具可读文件但不写入。
  // ============================================================
  /**
   * 取 memory 服务，并**留下诊断痕迹**。
   *
   * 为什么不是一行 `ctx.reflect.get('memory')`：
   *   cordis 的 `reflect.get(name, strict = true)` **默认只返回
   *   "提供者 fiber 当前活跃"的服务**。于是"插件根本没装"和
   *   "装了但 fiber 没就绪"会得到**同一个 undefined** ——
   *   排查时这两者的修法完全不同（换 profile vs 查加载顺序），
   *   却无法区分。
   *
   * 这里把三条路都试一遍并记录结果，最后把 trace 一起返回给调用方：
   *   1. `ctx.get('memory')`   —— 和 aemeath-ui 同一个入口（受 inject 约束）
   *   2. `reflect.get('memory')`        —— 严格模式
   *   3. `reflect.get('memory', false)` —— 非严格，能看到"未激活"的实现
   */
  const readMemoryService = (): { value: unknown; trace: string[] } => {
    const trace: string[] = [];
    const anyCtx = ctx as unknown as {
      get?: (n: string) => unknown;
      reflect?: { get?: (n: string, strict?: boolean) => unknown };
    };

    // 1) 标准服务访问（aemeath-ui 用的就是这条）
    try {
      const v = anyCtx.get?.('memory');
      trace.push(`ctx.get=${v ? 'ok' : 'undefined'}`);
      if (v) return { value: v, trace };
    } catch (e) {
      trace.push(`ctx.get=throw(${(e as Error).message.slice(0, 60)})`);
    }

    // 2) 反射严格模式
    try {
      const v = anyCtx.reflect?.get?.('memory');
      trace.push(`reflect.get(strict)=${v ? 'ok' : 'undefined'}`);
      if (v) return { value: v, trace };
    } catch (e) {
      trace.push(`reflect.get(strict)=throw(${(e as Error).message.slice(0, 60)})`);
    }

    // 3) 反射非严格：能拿到"装了但 fiber 不活跃"的实现
    try {
      const v = anyCtx.reflect?.get?.('memory', false);
      trace.push(`reflect.get(loose)=${v ? 'ok' : 'undefined'}`);
      if (v) return { value: v, trace };
    } catch (e) {
      trace.push(`reflect.get(loose)=throw(${(e as Error).message.slice(0, 60)})`);
    }

    return { value: undefined, trace };
  };
  /** 最近一次解析 memory 的诊断痕迹（供失败信息展示）。 */
  let lastMemoryTrace: string[] = [];

  const buildGatekeeper = async (): Promise<HandoffGatekeeper | null> => {
    // memory 插件的 gatekeeper 是模块内部函数，不在 service 上；
    // 因此这里走**动态 import** 其包（peer 依赖），拿 decide/writeGate。
    // 包不可用时（lecture 独立 profile）返回 null → 只读不写。
    try {
      const gkMod = (await import('@aemeath/dsh-plugin-memory/gatekeeper')) as {
        decide: (q: string, r: string) => GateDecision;
        writeGate: (q: string, c: string) => WriteGateResult;
      };
      const looked = readMemoryService();
      lastMemoryTrace = looked.trace;
      const memory = looked.value as
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
              sourceKind: string;
              sourceSession: string;
              status?: string;
            }): Promise<string>;
          }
        | undefined;
      if (!memory) {
        log(`未检测到 memory 服务——握手接收侧降级为只读（试运行）。查找记录：${looked.trace.join(' / ')}`);
        return null;
      }
      return {
        decide: (q, r) => gkMod.decide(q, r),
        writeGate: (q, c) => gkMod.writeGate(q, c),
        save: async (input) => {
          // ⚠️ entityClaims 必须透传：memory 侧要求 valid_from/valid_until，
          //    丢了就只能退化成纯文本，第 5 步"逐条确认"的结构化语义会丢。
          const id = await memory.save({
            content: input.content,
            category: input.category,
            importance: input.importance,
            confidence: input.confidence,
            scope: input.scope,
            preset: input.preset,
            // 来源可追溯：把"哪节课来的"编码进 source_mode
            //（memory 的 MemorySaveInput 没有独立的 sourceLecture 字段）。
            source_mode: input.sourceLecture
              ? `${input.sourceMode}@${input.sourceLecture.course}/${input.sourceLecture.unit}`
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

  ctx.tools.register(
    defineTool({
      name: 'lecture_import_handoff',
      description:
        '【主 agent 侧】导入课堂机导出的学习进度/短板（*-handoff.json）。' +
        '用户说「导入讲义进度」「同步课堂笔记」「导入 handoff」时调这个。' +
        '会**自动过守门员**（查重/冲突/写门）后写入主记忆；未复盘的单元会被跳过。' +
        '⚠️ 缺省是 dry_run（试运行）——先跑一次给用户看会写什么，再确认真正导入。',
      parameters: {
        file: { type: 'string', description: '单个 handoff 文件路径；缺省扫描 handoffDir 下全部 *-handoff.json' },
        dry_run: { type: 'boolean', description: '试运行：只判定不写入（**缺省 true**，确认无误后再传 false）' },
        preset: { type: 'string', description: '目标馆，缺省 physicist' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { file?: string; dry_run?: boolean; preset?: string }) => {
        const files = args.file ? [args.file] : findHandoffFiles(handoffDir);
        if (!files.length) {
          // 说清"去哪找过"，否则用户不知道文件该放哪
          return fail(
            `没有找到 handoff 文件。\n` +
              `已扫描目录：${handoffDir}\n` +
              `把课堂机导出的 *-handoff.json 放进该目录，或用 file 参数指定绝对路径。`,
          );
        }
        const gk = await buildGatekeeper();
        const dryRun = args.dry_run ?? true; // 缺省试运行（安全默认）
        if (!gk) {
          const previews: string[] = [];
          for (const f of files) {
            const h = loadHandoffFile(f);
            if (h) previews.push(describeHandoff(h));
          }
          // 用户本来就要试运行 → 给预览就好，这不算失败
          if (dryRun) {
            return ok({
              dry_run: true,
              degraded: true,
              previews,
              note: tr(
                '当前没有 memory 服务，所以这只是只读预览（你本来也没要求写入）。',
                'No memory service here, so this is a read-only preview (you did not ask to write anyway).',
              ),
            });
          }
          // ⚠️ 用户**明确要求写入**却写不了 —— 必须报错。
          //
          // 早先这里无条件 `return ok({ dry_run: true, degraded: true })`：
          // 传 dry_run:false 会**悄悄**退回试运行，调用方看到 ok:true
          // 很容易当成"导入成功"。真机就是这样：
          //   "我给 handoff2 传 dry_run: false 仍然原地退回。"
          // 这和"前端说写入了主记忆其实没写"是同一类静默失败。
          return fail(
            tr(
              '导入失败：当前会话拿不到 memory 服务，写不进去 —— 这**不是**握手文件的问题。\n' +
                `查找记录：${lastMemoryTrace.join(' / ') || '(未执行)'}\n` +
                '怎么判断：\n' +
                '  · 三条都是 undefined → 这个 profile 没装 memory 插件，换到**主 agent 会话**执行（那边装了）。\n' +
                '  · strict 为 undefined 但 loose 为 ok → 装了但 memory 的 fiber 未激活（加载/依赖问题），不是配置缺插件。\n' +
                '  · ctx.get 抛 inject 错但 reflect 有值 → 本插件 inject 里没有 memory，属于已知限制。\n' +
                '下面附只读预览，可以先确认文件内容对不对：',
              'Import failed: no memory service in this session, so nothing can be written — this is NOT a problem with the handoff file.\n' +
                `Lookup trace: ${lastMemoryTrace.join(' / ') || '(none)'}\n` +
                'How to read it:\n' +
                '  - all three undefined -> this profile does not load the memory plugin; use the main agent session instead.\n' +
                '  - strict undefined but loose ok -> the plugin is installed but its fiber is inactive, so this is a load order problem, not a missing plugin.\n' +
                '  - ctx.get throws an inject error but reflect has a value -> memory is simply not in this plugin\'s inject list.\n' +
                'Read-only preview follows, so you can check the file contents:',
            ),
            {
              degraded: true,
              dry_run_forced: true,
              // 结构化标记，方便调用方判断"是环境问题不是数据问题"
              reason: 'no-memory-service',
              memory_lookup: lastMemoryTrace,
              previews,
            },
          );
        }
        const outcomes: string[] = [];
        let totalMem = 0;
        let totalDrop = 0;
        for (const f of files) {
          const h = loadHandoffFile(f);
          if (!h) {
            warn(`握手文件不可解析：${f}`);
            continue;
          }
          const o = await importHandoff(h, gk, { dryRun, preset: args.preset ?? 'physicist' });
          outcomes.push(describeOutcome(o));
          totalMem += o.memoriesWritten;
          totalDrop += o.dropped;
        }
        log(`握手导入完成（dry_run=${dryRun}）：记忆 ${totalMem} 条，丢弃 ${totalDrop} 条`);
        return ok({
          dry_run: dryRun,
          files: files.map(String),
          memories: totalMem,
          dropped: totalDrop,
          outcomes,
          note: dryRun ? '这是试运行结果——确认无误后把 dry_run 设为 false 真正写入。' : '已写入主记忆。',
        });
      },
    }),
  );

  // ============================================================
  // 内部辅助
  // ============================================================

  const courseIdOf = (sid: string): string => activeOf(sid)?.courseId ?? machines.get(sid)?.current.unit_id ?? '';

  /** 落盘当前课堂记录（markdown）。 */
  function persist(cur: ActiveLecture): void {
    try {
      const index = store.readIndex(cur.courseId);
      const unit = index?.units.find((u) => u.id === cur.unitId);
      if (!unit) {
        warn(`单元不存在，无法落盘: ${cur.unitId}`);
        return;
      }
      store.writeUnitMarkdown(cur.courseId, unit, {
        course: index?.title ?? cur.courseId,
        unit: cur.title,
        date: cur.date,
        semester: index?.semester ?? '',
        module: index?.module_code ?? '',
      }, cur.chunks);
    } catch (e) {
      warn(`落盘失败: ${(e as Error).message}`);
    }
  }

  /** 后台转录单块（D3）：结果只写 .raw.json，绝不进入对话。 */
  async function runTranscribe(cur: ActiveLecture, chunk: RawChunk): Promise<void> {
    try {
      const result = await transcribeChunk(chunk.raw, askLlm);
      if (!result) {
        log(`转录跳过（chunk ${chunk.seq}，LLM 不可用或输出不可解析）`);
        return;
      }
      // 护栏：越界检测（只记日志，不阻断落盘——语义判定不可靠，plan R3）
      if (result.processed && looksLikeSummary(result.processed)) {
        warn(`转录输出疑似越界（含摘要/概念类内容），chunk ${chunk.seq}——请复盘时自查`);
      }
      if (result.processed && isOverExpanded(chunk.raw, result.processed)) {
        warn(`转录输出显著长于输入（chunk ${chunk.seq}，${chunk.raw.length}→${result.processed.length}），疑似扩写`);
      }
      const existing = store.readProcessing(cur.courseId, cur.unitId);
      const merged: ProcessingRecord = {
        unit_id: cur.unitId,
        chunk_seq: chunk.seq,
        formulas: [...(existing?.formulas ?? []), ...result.formulas],
        processed: [existing?.processed, result.processed].filter(Boolean).join('\n'),
        model: llm.model,
        created_at: Date.now(),
      };
      store.writeProcessing(cur.courseId, merged);
      log(`转录完成（chunk ${chunk.seq}）：公式 ${result.formulas.length} 条，仅落后端`);
    } catch (e) {
      warn(`转录失败（chunk ${chunk.seq}）: ${(e as Error).message}`);
    }
  }

  /** 从文件恢复块（会话重启后复盘仍可用）。 */
  function loadChunksFromFile(sid: string, unitId: string): RawChunk[] {
    const cid = courseIdOf(sid);
    if (!cid) return [];
    const index = store.readIndex(cid);
    const unit = index?.units.find((u) => u.id === unitId);
    if (!unit) return [];
    const md = store.readUnitMarkdown(cid, unit);
    if (!md) return [];
    return parseUnitMarkdown(md).chunks;
  }

  function persistReview(sid: string, m: ReviewMachine): void {
    const cid = courseIdOf(sid) || activeOf(sid)?.courseId;
    if (!cid) return;
    try {
      store.writeReviewState(cid, m.current);
    } catch (e) {
      warn(`复盘状态落盘失败: ${(e as Error).message}`);
    }
  }

  // 会话释放：清理内存态与磁盘指针（文件已落盘）。
  //
  // ⚠ 必须挂 session/disposed，**不能**挂 session/flush。
  // session/flush 是「持久化检查点」而非「会话结束」：dsh 的
  // @deepseek-ai/dsh-session-checkpoint-policy 在每个顶层工具体执行前、
  // 每次模型请求前、每个 agent/pre-step 都会派发一次
  // （lib/index.js: ctx.on('tools/execute') → ctx.sessions.flush）。
  // 曾在此清态，导致同一会话内 active 在工具之间就被删掉：
  //   lecture_session_start（写 active）→ flush（删 active）→ lecture_capture（找不到课堂，必失败）
  // 即采集闭环从第二个工具调用起 100% 不可用（test/check4.mjs 为该时序的回归护栏）。
  //
  // 磁盘指针也要在这里清：它的用途是「同一节课堂上进程崩溃/重启后接着记」，
  // **不是**跨会话续记。若会话正常结束仍留指针，下一个新会话会静默继承上一节课
  // （capture 写进旧单元）。故正常退役 = 清指针；崩溃 = 指针残留 = 可恢复。
  ctx.on('session/disposed', (session) => {
    active.delete(session.id);
    machines.delete(session.id);
    // 只清**本会话自己的**指针：别的 profile/会话的指针不归我们管
    //（早先单文件实现会把别人的指针一起删掉，属于跨 owner 误伤）。
    clearPointer(session.id);
  });

  // ============================================================
  // HTTP 桥（P3 前端）：/aemeath/api/lecture
  //
  // 与记忆工作区同款：前端经同源代理读写，**不持有 token**。
  // 经 ctx.reflect.get('webServer') 惰性取服务——headless profile 没有
  // Web 层，此时优雅降级（不注册路由，前端也不存在）。
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

  // ============================================================
  // 前端 boot 标记：告诉客户端"这个页面就是课堂独立界面"
  //
  // 为什么必须由 host 注入（真机踩过，用户定位到的根因）：
  //   客户端的 detectStandalone() 有三条判据，在**纯浏览器**下全部落空：
  //     ① Electron 壳的 window.shell.isLectureWindow —— 浏览器没有壳
  //     ② URL 上的 aemeath_lecture=1 —— dsh 认证 303 → ./ 会把 query 丢掉
  //     ③ window.__AEMEATH_LECTURE_STANDALONE__ —— **没有任何生产者**（死分支）
  //   于是 mac（无 Electron）永远走"主界面模式"：
  //   dsh 官方主 shell 照常渲染，lecture 只是一个侧栏按钮 ——
  //   用户看到的就是"和主 agent 一模一样的前端"，工作台 GUI 根本进不去。
  //
  // 注入位置：`webserver/index-inject`。这是 dsh 自己的机制
  //   （dsh-client-shortcuts 等插件都用它），在 index.html 渲染时
  //   把 `globalThis.NAME = value` 写进去，**先于任何客户端脚本执行**，
  //   且不受认证重定向影响。
  // ============================================================
  try {
    const hooks = ctx as unknown as { on?: (ev: string, cb: (table: unknown[]) => void) => void };
    if (typeof hooks.on === 'function') {
      hooks.on('webserver/index-inject', (table: unknown[]) => {
        if (!config.standalone) return;
        table.push({
          kind: 'global',
          name: '__AEMEATH_LECTURE_STANDALONE__',
          value: true,
        });
      });
      if (config.standalone) {
        log('已开启独立界面模式：将向页面注入 __AEMEATH_LECTURE_STANDALONE__=true');
      }
    }
  } catch (e) {
    warn(`注入 standalone 标记失败（前端可能退回主界面模式）：${(e as Error).message}`);
  }

  if (webServer?.register) {
    // 前端没有 dsh session，用 `web:<课程id>` 作为合成会话标识。
    // 与下面 loadChunksFromFile 的 `web:${courseId}` 约定一致
    //（courseIdOf 会把它解回课程 id）。
    const webSid = (courseId: string): string => `web:${courseId}`;

    const handler = (req: Parameters<typeof handleLectureHttp>[0], res: Parameters<typeof handleLectureHttp>[1]): void => {
      void handleLectureHttp(req, res, {
        store,
        log,
        warn,
        // 界面自己开课（与工具路径 startSession **同一套逻辑**）。
        // 用合成会话 id，指针/恢复照样按 owner 分片，不会和对话侧的课堂互相覆盖。
        onStartSession: async (input) => {
          try {
            const r = startSession(webSid(input.courseId), {
              courseId: input.courseId,
              title: input.title,
              courseTitle: input.courseTitle,
              semester: input.semester,
              moduleCode: input.moduleCode,
              date: input.date,
            });
            return { ok: true, course_id: r.course_id, unit_id: r.unit_id, date: r.date };
          } catch (e) {
            warn(`前端开课失败：${(e as Error).message}`);
            return { ok: false, error: (e as Error).message };
          }
        },
        // 前端提交速记 → 与工具路径**同一套逻辑**（落盘 + 强制留白 + 后台转录）
        onSubmitChunk: async (courseId, unitId, chunk) => {
          try {
            const index = store.readIndex(courseId);
            const unit = index?.units.find((u) => u.id === unitId);
            if (!index || !unit) return { ok: false, error: tr('课程或单元不存在', 'Course or lecture not found') };
            // 复用工具层的落盘：从 markdown 恢复已有块，追加新块
            const md = store.readUnitMarkdown(courseId, unit);
            const existing = md ? parseUnitMarkdown(md).chunks : [];
            const seq = nextSeq(existing);
            const next: RawChunk = {
              seq,
              raw: chunk.raw,
              my_understanding: chunk.my_understanding,
              my_question: chunk.my_question,
              created_at: Date.now(),
            };
            const all = [...existing, next];
            store.writeUnitMarkdown(courseId, unit, {
              course: index.title,
              unit: unit.title,
              date: unit.date,
              semester: index.semester,
              module: index.module_code,
            }, all);
            // 后台转录（D3：只落后端，前端看不到）
            if (transcribeEnabled) {
              void runTranscribe(
                { courseId, unitId, title: unit.title, date: unit.date, chunks: all },
                next,
              );
            }
            return { ok: true };
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
        },
        // 改某一块的留白（我的理解 / 我的疑问）。
        //
        // ⚠️ 留白**只能由用户本人填**（D12：主动回忆的价值就在于自己写）。
        //    所以这个入口**不暴露给 LLM 工具**，只有前端 HTTP 桥能调 ——
        //    模型代笔会让整套复盘失去意义。
        //
        // 真机反馈："笔记的理解和疑问目前无法输入" ——
        // 早先这两栏只是只读展示，写不进去。
        onUpdateBlanks: async (courseId, unitId, seq, patch) => {
          try {
            const index = store.readIndex(courseId);
            const unit = index?.units.find((u) => u.id === unitId);
            if (!index || !unit) return { ok: false, error: tr('课程或单元不存在', 'Course or lecture not found') };
            const md = store.readUnitMarkdown(courseId, unit);
            const chunks = md ? parseUnitMarkdown(md).chunks : [];
            const target = chunks.find((c) => c.seq === seq);
            if (!target) return { ok: false, error: tr(`找不到第 ${seq + 1} 块`, `Block ${seq + 1} not found`) };
            // 只改传入的字段（另一栏保持不动）
            if (typeof patch.my_understanding === 'string') {
              target.my_understanding = patch.my_understanding.slice(0, 4000);
            }
            if (typeof patch.my_question === 'string') {
              target.my_question = patch.my_question.slice(0, 4000);
            }
            store.writeUnitMarkdown(
              courseId,
              unit,
              {
                course: index.title,
                unit: unit.title,
                date: unit.date,
                semester: index.semester,
                module: index.module_code,
              },
              chunks,
            );
            // 留白填齐后就地重算（blanks_ok 是**读时派生**的，不落进 index）；
            // 前端保存后会重新拉 unit，所以这里只需要把结果回给调用方。
            const blanks = allBlanksOk(chunks);
            return { ok: true, blanks_ok: blanks.ok };
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
        },
        // 删除后清理内存态与磁盘指针。
        //
        // 为什么必须做：只删文件的话，`active` 里还留着"正在记这一讲"，
        // 后续 lecture_capture 会往一个**已经不存在**的单元里写 ——
        // 表现为"删了又冒出来"，比删不掉更让人困惑。
        onAfterDelete: (scope, courseId, unitId) => {
          for (const [sid, cur] of active) {
            const hitCourse = cur.courseId === courseId;
            const hitUnit = scope === 'course' || cur.unitId === unitId;
            if (hitCourse && hitUnit) {
              active.delete(sid);
              clearPointer(sid);
              log(`删除后清理课堂状态：${sid} → ${courseId}/${cur.unitId}`);
            }
          }
        },
        // 前端复盘操作 → 复用状态机（与工具路径同一套 ReviewMachine）
        onReview: async (op, payload) => {
          const courseId = String(payload.course_id ?? '');
          const unitId = String(payload.unit_id ?? '');
          const index = store.readIndex(courseId);
          const unit = index?.units.find((u) => u.id === unitId);
          if (!index || !unit) return { error: tr('课程或单元不存在', 'Course or lecture not found') };

          // 每次操作都从磁盘恢复状态机（前端可能刷新/换设备）
          const existing = store.readReviewState(courseId, unitId);
          const m = new ReviewMachine(unitId, existing, uiLang());
          const save = (): void => {
            try {
              store.writeReviewState(courseId, m.current);
            } catch (e) {
              warn(`复盘状态落盘失败: ${(e as Error).message}`);
            }
          };

          if (op === 'status') {
            return {
              step: m.step,
              state: m.current,
              candidates: store.readCandidates(courseId, unitId),
            };
          }

          if (op === 'recall') {
            if (m.step !== 'recall') return { step: m.step, error: tr(`当前步骤 ${m.step} 不接受“你先说”`, `Step ${m.step} does not accept a recall answer`) };
            const text = String(payload.text ?? '').trim();
            if (!text) return { error: tr('内容为空', 'Content is empty') };
            m.submitRecall(text);
            const cmp = await runCompare(m, `web:${courseId}`);
            if (!cmp.ok) {
              save();
              // 把具体原因带给前端；此时 step 停在 compare，
              // 用户点「开始补漏」会**重试对照**（见下面 next 的 compare 分支）
              return {
                step: 'compare',
                comparison: null,
                note: `${tr('对照生成失败', 'Comparison failed')}：${cmp.reason}`,
              };
            }
            save();
            return { step: 'compare', comparison: m.current.comparison };
          }

          if (op === 'repair_answer') {
            if (m.step !== 'repair') return { step: m.step, error: tr(`当前步骤 ${m.step} 不接受补漏回答`, `Step ${m.step} does not accept a repair answer`) };
            const text = String(payload.text ?? '').trim();
            if (!text) return { error: tr('内容为空', 'Content is empty') };
            const lastQ = m.current.repair_turns.filter((t) => t.answer === '').at(-1)?.question ?? tr('(追问)', '(follow-up)');
            m.addRepairTurn(lastQ, text);
            save();

            // 问够了就收尾（用户："不要追着我一直问"）。
            // 两种结束条件：轮数到上限，或模型说 DONE。
            if (m.repairExhausted) {
              return {
                step: 'repair',
                question: null,
                done: true,
                note: tr('补漏到此为止（已经问得够多了），可以进入下一步。', 'Enough repair questions — you can move on.'),
              };
            }

            const out = await askLlm(m.buildRepairPrompt(), {
              purpose: 'lecture-repair',
              // 纯文本追问，不要 json
            });
            if (!out) return { step: 'repair', question: null, note: tr('追问生成失败（LLM 不可用）', 'Follow-up generation failed (LLM unavailable)') };
            if (ReviewMachine.isRepairDone(out)) {
              return {
                step: 'repair',
                question: null,
                done: true,
                note: tr('模型认为该确认的都确认了，可以进入下一步。', 'The model thinks everything needed has been confirmed — you can move on.'),
              };
            }
            const q = out.trim();
            // D12 护栏：引导者不得直接给答案
            if (looksLikeDirectAnswer(q)) {
              warn('引导输出疑似直接给答案（D12），已拦截');
              return { step: 'repair', question: null, warning: tr('模型输出疑似直接给答案，已拦截。换个角度再答一次。', 'The model tried to give the answer directly, so it was blocked. Try a different angle.') };
            }
            m.addRepairTurn(q, '');
            save();
            return { step: 'repair', question: q };
          }

          if (op === 'next') {
            // ⚠️ 这里曾经有个**死分支**导致整个补漏步骤被跳过。
            //
            // 原代码：`if (m.step === 'compare') { 生成第一个问题 }`，
            // 但 `setComparison()` 在 recall 那一步就把 step 从 compare 推到了
            // repair（见 review.ts）—— 所以前端在"对照"页点「开始补漏」时，
            // 后端看到的已经是 repair，直接走 finishRepair() 去生成候选。
            //
            // 结果：第 3 步定点补漏**一次都没跑过**，而 D12（只引导、不给答案）
            // 正是整个复盘的核心。
            //
            // 现在有两种"还没开始补漏"的入口，分别处理：
            //   · step=compare 且没有对照结果 → 对照失败了，**重试对照**
            //   · step=repair 且没问过问题    → 正常开始补漏，生成第一个问题

            // 情形 A：对照失败后停在 compare。
            // 真机反馈："直接提示我重新提交【你先说】内容，然而根本没法退回那个阶段"
            // —— 前端确实没有退回入口，所以只能在这里**就地重试**。
            // recall_text 还在状态里，重试不需要用户再说一遍。
            if (m.step === 'compare') {
              if (!m.current.recall_text) {
                return {
                  step: 'compare',
                  comparison: null,
                  note: tr(
                    '还没有「你先说」的内容，请先在第 1 步写下你记得的东西。',
                    'No recall text yet — write down what you remember in step 1 first.',
                  ),
                };
              }
              const retry = await runCompare(m, `web:${courseId}`);
              save();
              if (!retry.ok) {
                return {
                  step: 'compare',
                  comparison: null,
                  note: `${tr('对照重试失败', 'Comparison retry failed')}：${retry.reason}`,
                };
              }
              // 对照成功，step 已经是 repair —— 落到下面的补漏分支生成第一个问题
            }

            if (m.step === 'repair' && m.current.repair_turns.length === 0) {
              if (!m.current.comparison) {
                return { step: 'compare', error: tr('还没有对照结果，请先完成第 1 步', 'No comparison yet — complete step 1 first') };
              }
              const out = await askLlm(m.buildRepairPrompt(), {
                purpose: 'lecture-repair',
                // 注意：**不传 json** —— 补漏要的是一句自然语言追问
              });
              if (!out) {
                return {
                  step: 'repair',
                  question: null,
                  note: tr('追问生成失败（LLM 未返回内容），可再试一次', 'Follow-up generation failed (LLM returned nothing) — try again'),
                };
              }
              // 没有需要补漏的点 → 模型直接 DONE，别硬造问题
              if (ReviewMachine.isRepairDone(out)) {
                return { step: 'repair', question: null, done: true, note: tr('没有需要补漏的点，可以直接进入下一步。', 'Nothing to repair — you can move on.') };
              }
              const q = out.trim();
              if (looksLikeDirectAnswer(q)) {
                warn('引导输出疑似直接给答案（D12），已拦截');
                return {
                  step: 'repair',
                  question: null,
                  warning: tr('模型输出疑似直接给答案，已拦截。换个角度再答一次。', 'The model tried to give the answer directly, so it was blocked. Try a different angle.'),
                };
              }
              m.addRepairTurn(q, '');
              save();
              return { step: 'repair', question: q };
            }
            if (m.step === 'repair') {
              m.finishRepair();
              const chunks = loadChunksFromFile(`web:${courseId}`, unitId);
              const processing = store.readProcessing(courseId, unitId);
              const out = await askLlm(m.buildCandidatesPrompt(chunks, processing), {
                purpose: 'lecture-candidates',
              json: true, // 候选条目是结构化 JSON
              });
              const cand = ReviewMachine.parseCandidates(out, unitId, uiLang());
              if (!cand) {
                save();
                return { step: 'candidates', candidates: null, note: tr('候选生成失败（LLM 不可用）', 'Candidate generation failed (LLM unavailable)') };
              }
              store.writeCandidates(courseId, cand);
              // D4：候选生成即写摘要（与工具路径同一出口，保证 has_summary 语义一致）
              writeSummaryFor(courseId, unitId, cand, llm.model);
              save();
              return { step: 'candidates', candidates: cand };
            }
            return { step: m.step, error: tr(`当前步骤 ${m.step} 不能推进`, `Step ${m.step} cannot advance`) };
          }

          if (op === 'commit') {
            if (m.step !== 'candidates' && m.step !== 'commit') {
              return { step: m.step, error: tr(`当前步骤 ${m.step} 不能确认写入`, `Step ${m.step} cannot confirm the commit`) };
            }
            if (m.step === 'candidates') m.setCandidates();
            const accepted = payload.accepted as Candidates | null;
            const cand = accepted ?? store.readCandidates(courseId, unitId);
            // 落盘在这里（状态机只管推进，见 ReviewMachine.commit 的契约注释）
            if (cand) store.writeCandidates(courseId, cand);
            m.commit();
            save();
            store.markUnit(courseId, unitId, { reviewed: true, has_summary: true });
            // ⚠️ 摘要不在这里写——已在第 4 步（候选生成）由 writeSummaryFor 写过。
            //    早先这里也写一次，导致"前端路径第 5 步才有摘要、工具路径第 4 步就有"，
            //    has_summary 的语义在两个入口下不一致。现在统一由 writeSummaryFor 负责。
            log(`复盘完成（前端）：${courseId}/${unitId}`);

            // ⚠️ 自动导出握手包 —— 别让人记着"还要再调一个工具"。
            //
            //    真机踩过：commit 只写本机 candidates，前端却提示"已记录"，
            //    用户以为已经进了主记忆（"前端说写入主agent了，但是肯定没有"）。
            //
            //    现实约束：上课时 mac 在教室、Windows 在家，
            //    **两台机器不可能同时在线** → 没有"自动推送"这个选项，
            //    只能"mac 导出自包含文件 → 人搬运 → Windows 一键导入"。
            //    所以能自动化的只有导出这一步；导入必须由人在 Windows 上触发。
            //
            //    导出失败不阻断复盘（复盘结果已落盘，导出是附加动作）。
            let handoffFiles: string[] = [];
            try {
              const r = exportHandoffNow(courseId);
              handoffFiles = r.files;
              log(`复盘后自动导出握手包：${handoffFiles.join(', ')}`);
            } catch (e) {
              warn(`自动导出握手包失败（复盘结果已保存，不影响）：${(e as Error).message}`);
            }
            return {
              step: 'done',
              // 前端据此显示"文件在哪、下一步要做什么"，
              // 不再让人误以为已经同步进主记忆了。
              handoff_files: handoffFiles,
              handoff_dir: handoffDir,
            };
          }

          return { error: tr(`未实现的复盘操作: ${op}`, `Unimplemented review action: ${op}`) };
        },
      });
    };
    const dispose = webServer.register({ kind: 'exact', path: '/aemeath/api/lecture', handler });
    const disposeSlash = webServer.register({ kind: 'exact', path: '/aemeath/api/lecture/', handler });

    // MathLive 的静态资源（CSS + 字体）。
    //
    // 为什么必须提供（真机截图）：`convertLatexToMarkup()` 只产出标记，
    // 样式和字体要另外加载 —— 不加载的话字形缺失，`\neq` 渲染成豆腐块 □。
    //
    // 为什么走 prefix 路由而不是把字体打进 bundle：
    // 20 个 woff2 共 254KB，base64 会无条件增加 ~340KB；
    // 走路由则只有真在渲染公式时才请求，且浏览器缓存。
    const disposeAssets = webServer.register({
      kind: 'prefix',
      path: ASSETS_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        // serveAsset 返回 false 表示不是它能处理的路径（理论上到不了这里）
        if (!serveAsset(req, res, req.url ?? '')) res.writeHead(404).end('not found');
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
    log('HTTP 桥已注册: GET/POST /aemeath/api/lecture（前端不持有 token）');
    log(`MathLive 静态资源已注册: ${ASSETS_PREFIX}/{mathlive-static.css,fonts/*.woff2}`);
  } else {
    log('未检测到 webServer（headless profile）——HTTP 桥跳过，工具路径不受影响');
  }

  log('工具已注册：lecture_session_start / lecture_capture / lecture_status / lecture_review_start / lecture_review_submit / lecture_review_next / lecture_export_handoff');
}
