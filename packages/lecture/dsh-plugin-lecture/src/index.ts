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
import { existsSync, writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { registerVolatileSettings } from '@aemeath/dsh-plugin-common';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-tools';
import { LectureStore, allBlanksOk, parseUnitMarkdown } from './store.js';
import { transcribeChunk, looksLikeSummary, isOverExpanded, type AskLlm } from './transcriber.js';
import { ReviewMachine, looksLikeDirectAnswer } from './review.js';
import { buildHandoff, filterReviewed, writeHandoff, describeHandoff, type Handoff } from './handoff.js';
import { handleLectureHttp } from './http.js';
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
type ToolResult = { ok: boolean; data: Record<string, string | number | boolean | string[] | null> };

/** 成功结果：data 内不应有 undefined（调用方保证）。 */
function ok(data: Record<string, string | number | boolean | string[] | null> = {}): ToolResult {
  return { ok: true, data };
}

/** 失败结果：统一 `{ ok:false, error }`，错误信息放 data.error。 */
function fail(error: string, extra: Record<string, string | number | boolean | string[] | null> = {}): ToolResult {
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

  const askLlm: AskLlm = async (prompt, opts) => {
    const apiKey = await resolveLlmKey();
    if (!apiKey) {
      warn(`LLM 无 apiKey，跳过（${opts.purpose}）`);
      return null;
    }
    try {
      const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          max_tokens: opts.maxTokens,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? null;
    } catch (e) {
      warn(`LLM 调用失败（${opts.purpose}）: ${(e as Error).message}`);
      return null;
    }
  };

  // ---- 会话内状态（key = dsh sessionId） ----
  const active = new Map<string, ActiveLecture>();
  const machines = new Map<string, ReviewMachine>();

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
          note: '已记录（后台规范化中，结果不回显）',
          // 缺留白时把"该问用户什么"明确交回去，模型照着问即可，不要自己编答案。
          ...(missing.length
            ? {
                blanks_missing: missing,
                ask_user:
                  `这段已记下，但还缺 ${missing.join('、')} —— ` +
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
      description: '查看当前课堂记录状态：课程、单元、已记录块数与强制留白完成情况。',
      parameters: {},
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (_args, exec) => {
        const sid = exec.agent?.session?.id ?? 'default';
        const cur = activeOf(sid);
        if (!cur) return fail('当前无进行中的课堂', { active: false });
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
        const machine = new ReviewMachine(args.unit_id, existing);
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
          const chunks = loadChunksFromFile(sid, m.current.unit_id);
          const prompt = m.buildComparePrompt(m.current.recall_text, chunks);
          const out = await askLlm(prompt, { maxTokens: 1500, purpose: 'lecture-compare' });
          const comp = ReviewMachine.parseComparison(out);
          if (!comp) {
            persistReview(sid, m);
            return ok({ step: 'compare', comparison: null, note: '对照生成失败（LLM 不可用或输出不可解析），可手动填写三栏后继续' });
          }
          m.setComparison(comp);
          persistReview(sid, m);
          return ok({
            step: m.step,
            comparison: JSON.stringify(comp),
            instruction: '这是对照结果。接下来做定点补漏：只针对"漏了/记错"的点。',
          });
        }

        // 第 3 步：记录回答，给出下一个追问
        if (m.step === 'repair') {
          const lastQ = m.current.repair_turns.filter((t) => t.answer === '').at(-1)?.question ?? m.current.repair_turns.at(-1)?.question ?? '(未记录的上一问)';
          m.addRepairTurn(lastQ, text);
          persistReview(sid, m);
          const out = await askLlm(m.buildRepairPrompt(), { maxTokens: 500, purpose: 'lecture-repair' });
          if (!out) return ok({ step: 'repair', question: null, note: '追问生成失败（LLM 不可用）' });
          const q = out.trim();
          // D12 护栏：引导者不得直接给答案（启发式，见 review.ts）
          if (looksLikeDirectAnswer(q)) {
            warn('引导输出疑似直接给答案（D12 护栏触发），已拦截');
            return ok({
              step: 'repair',
              question: null,
              warning: 'LLM 输出疑似直接给答案，已拦截。请让学生继续尝试，或换个角度提问。',
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

        if (m.step === 'repair') {
          m.finishRepair();
          const chunks = loadChunksFromFile(sid, m.current.unit_id);
          const unitId = m.current.unit_id;
          const processing = store.readProcessing(cid, unitId);
          const out = await askLlm(m.buildCandidatesPrompt(chunks, processing), { maxTokens: 2500, purpose: 'lecture-candidates' });
          const cand = ReviewMachine.parseCandidates(out, unitId);
          if (!cand) {
            persistReview(sid, m);
            return ok({ step: m.step, candidates: null, note: '候选条目生成失败（LLM 不可用或输出不可解析）' });
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

  ctx.tools.register(
    defineTool({
      name: 'lecture_export_handoff',
      description:
        '导出握手包（课程进度 + 用户短板 + 粗略单元内容）到局域网文件，供上传到主 agent。' +
        '只导出已复盘单元的内容；不含课堂原始速记。',
      parameters: {
        course_id: { type: 'string', required: true, description: '课程标识；缺省导出全部课程' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { course_id?: string }) => {
        const ids = args.course_id ? [args.course_id] : store.listCourses();
        if (!ids.length) return fail('没有可导出的课程');
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
          const file = writeHandoff(h, handoffDir, `${cid}-handoff.json`);
          written.push(file);
          summaries.push(describeHandoff(h));
        }
        log(`握手包已导出 ${written.length} 个 → ${handoffDir}`);
        return ok({ files: written, summaries, note: '请把文件上传到主 agent（放学后人工上传）。' });
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
  const buildGatekeeper = async (): Promise<HandoffGatekeeper | null> => {
    // memory 插件的 gatekeeper 是模块内部函数，不在 service 上；
    // 因此这里走**动态 import** 其包（peer 依赖），拿 decide/writeGate。
    // 包不可用时（lecture 独立 profile）返回 null → 只读不写。
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
              sourceKind: string;
              sourceSession: string;
              status?: string;
            }): Promise<string>;
          }
        | undefined;
      if (!memory) {
        log('未检测到 memory 服务——握手接收侧降级为只读（试运行）');
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
        '【主 agent 侧】导入 lecture 导出的学习进度/短板（handoff.json）。' +
        '会**自动过守门员**（查重/冲突/写门）后写入主记忆；未复盘的单元会被跳过。' +
        'dry_run=true 时只判定不写入，用于上传前先看一眼会写什么。',
      parameters: {
        file: { type: 'string', description: 'handoff 文件路径；缺省扫描 dataDir 下全部 *-handoff.json' },
        dry_run: { type: 'boolean', description: '试运行：只判定不写入（建议先跑一次）' },
        preset: { type: 'string', description: '目标馆，缺省 physicist' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args: { file?: string; dry_run?: boolean; preset?: string }) => {
        const files = args.file ? [args.file] : findHandoffFiles(handoffDir);
        if (!files.length) {
          return fail(`没有找到 handoff 文件（目录：${handoffDir}）`);
        }
        const gk = await buildGatekeeper();
        const dryRun = args.dry_run ?? true; // 缺省试运行（安全默认）
        if (!gk) {
          // 降级：能读能描述，但不写
          const previews: string[] = [];
          for (const f of files) {
            const h = loadHandoffFile(f);
            if (h) previews.push(describeHandoff(h));
          }
          return ok({
            dry_run: true,
            degraded: true,
            note: 'memory 服务不可用（当前可能是 lecture 独立 profile）——只读出预览，未写入。',
            previews,
          });
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
            if (!index || !unit) return { ok: false, error: '课程或单元不存在' };
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
        // 前端复盘操作 → 复用状态机（与工具路径同一套 ReviewMachine）
        onReview: async (op, payload) => {
          const courseId = String(payload.course_id ?? '');
          const unitId = String(payload.unit_id ?? '');
          const index = store.readIndex(courseId);
          const unit = index?.units.find((u) => u.id === unitId);
          if (!index || !unit) return { error: '课程或单元不存在' };

          // 每次操作都从磁盘恢复状态机（前端可能刷新/换设备）
          const existing = store.readReviewState(courseId, unitId);
          const m = new ReviewMachine(unitId, existing);
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
            if (m.step !== 'recall') return { step: m.step, error: `当前步骤 ${m.step} 不接受"你先说"` };
            const text = String(payload.text ?? '').trim();
            if (!text) return { error: '内容为空' };
            m.submitRecall(text);
            const chunks = loadChunksFromFile(`web:${courseId}`, unitId);
            const out = await askLlm(m.buildComparePrompt(m.current.recall_text, chunks), {
              maxTokens: 1500,
              purpose: 'lecture-compare',
            });
            const comp = ReviewMachine.parseComparison(out);
            if (!comp) {
              save();
              return { step: 'compare', comparison: null, note: '对照生成失败（LLM 不可用）' };
            }
            m.setComparison(comp);
            save();
            return { step: 'compare', comparison: comp };
          }

          if (op === 'repair_answer') {
            if (m.step !== 'repair') return { step: m.step, error: `当前步骤 ${m.step} 不接受补漏回答` };
            const text = String(payload.text ?? '').trim();
            if (!text) return { error: '内容为空' };
            const lastQ = m.current.repair_turns.filter((t) => t.answer === '').at(-1)?.question ?? '(追问)';
            m.addRepairTurn(lastQ, text);
            save();
            const out = await askLlm(m.buildRepairPrompt(), { maxTokens: 500, purpose: 'lecture-repair' });
            if (!out) return { step: 'repair', question: null, note: '追问生成失败（LLM 不可用）' };
            const q = out.trim();
            // D12 护栏：引导者不得直接给答案
            if (looksLikeDirectAnswer(q)) {
              warn('引导输出疑似直接给答案（D12），已拦截');
              return { step: 'repair', question: null, warning: '模型输出疑似直接给答案，已拦截。换个角度再答一次。' };
            }
            m.addRepairTurn(q, '');
            save();
            return { step: 'repair', question: q };
          }

          if (op === 'next') {
            if (m.step === 'compare') {
              // 用户点"开始补漏"：comparison 已在 recall 步骤写入并带入 repair，
              // 这里只生成第一个问题（setComparison 已完成 compare→repair 转换）。
              if (!m.current.comparison) {
                return { step: 'compare', error: '还没有对照结果，请先完成第 1 步' };
              }
              const out = await askLlm(m.buildRepairPrompt(), { maxTokens: 500, purpose: 'lecture-repair' });
              const q = out && !looksLikeDirectAnswer(out) ? out.trim() : null;
              if (q) {
                m.addRepairTurn(q, '');
                save();
              }
              return { step: 'repair', question: q };
            }
            if (m.step === 'repair') {
              m.finishRepair();
              const chunks = loadChunksFromFile(`web:${courseId}`, unitId);
              const processing = store.readProcessing(courseId, unitId);
              const out = await askLlm(m.buildCandidatesPrompt(chunks, processing), {
                maxTokens: 2500,
                purpose: 'lecture-candidates',
              });
              const cand = ReviewMachine.parseCandidates(out, unitId);
              if (!cand) {
                save();
                return { step: 'candidates', candidates: null, note: '候选生成失败（LLM 不可用）' };
              }
              store.writeCandidates(courseId, cand);
              // D4：候选生成即写摘要（与工具路径同一出口，保证 has_summary 语义一致）
              writeSummaryFor(courseId, unitId, cand, llm.model);
              save();
              return { step: 'candidates', candidates: cand };
            }
            return { step: m.step, error: `当前步骤 ${m.step} 不能推进` };
          }

          if (op === 'commit') {
            if (m.step !== 'candidates' && m.step !== 'commit') {
              return { step: m.step, error: `当前步骤 ${m.step} 不能确认写入` };
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
            return { step: 'done' };
          }

          return { error: `未实现的复盘操作: ${op}` };
        },
      });
    };
    const dispose = webServer.register({ kind: 'exact', path: '/aemeath/api/lecture', handler });
    const disposeSlash = webServer.register({ kind: 'exact', path: '/aemeath/api/lecture/', handler });
    ctx.effect(() => () => {
      try {
        dispose?.();
        disposeSlash?.();
      } catch {
        /* 服务可能已卸载 */
      }
    });
    log('HTTP 桥已注册: GET/POST /aemeath/api/lecture（前端不持有 token）');
  } else {
    log('未检测到 webServer（headless profile）——HTTP 桥跳过，工具路径不受影响');
  }

  log('工具已注册：lecture_session_start / lecture_capture / lecture_status / lecture_review_start / lecture_review_submit / lecture_review_next / lecture_export_handoff');
}
