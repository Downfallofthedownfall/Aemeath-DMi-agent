// ============================================================
// http.ts — Lecture Mode 的同源 HTTP 桥（前端 ↔ 后端）
//
// 前端（lib/client.js）通过 /aemeath/api/lecture 读写课堂数据，**不持有任何 token**
// —— 与记忆工作区同款做法（UI 插件代理 → ctx.memory 服务）。
//
// 安全（照 dsh-plugin-ui/src/index.ts:113 的 checkWriteOrigin）：
//   · 写请求（POST）要求 Origin 是回环地址；无 Origin（curl/同源 GET）放行
//   · body 上限 1MB
//   · 所有参数做长度钳制（防 DoS / 超长 payload）
//
// ⚠️ 关键设计：**GET 绝不返回加工结果（.raw.json）**。
//    D3 要求"加工只落后端、前端不剧透"，所以本文件的 GET 分支刻意
//    不暴露 readProcessing()。唯一例外是复盘第 4 步之后
//    （candidates 阶段）——那时才允许把摘要交给前端。
//    这条边界由 `assertNoLeak` 测试守护（test/check6.mjs）。
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LectureStore } from './store.js';
import { allBlanksOk, chunkBlanksOk, parseUnitMarkdown } from './store.js';
import { SYMBOL_DATA } from './symbol-data.js';
import type { RawChunk, UnitMeta } from './types.js';

const MAX_BODY_BYTES = 1024 * 1024;

function json(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function jsonError(res: ServerResponse, code: number, error: string, extra?: Record<string, unknown>): void {
  json(res, code, { ok: false, error, ...(extra ?? {}) });
}

function isLoopbackHostname(host: string): boolean {
  const h = (host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0';
}

/** 写请求的 Origin 校验（无 Origin 放行 = 非浏览器客户端）。 */
export function checkWriteOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function readBody(req: IncomingMessage): Promise<string> {
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
      if (!done) {
        done = true;
        resolve(body);
      }
    });
    req.on('error', (e) => fail(400, (e as Error).message));
  });
}

// ============================================================
// 数据面（前端需要的全部视图）
// ============================================================

/** 课堂界面用的单元列表项。**不含**任何加工结果。 */
export interface UnitView {
  id: string;
  date: string;
  title: string;
  reviewed: boolean;
  has_summary: boolean;
  /** 块数（前端显示进度）。 */
  chunk_count: number;
  /** 强制留白是否齐备。 */
  blanks_ok: boolean;
}

export interface CourseView {
  course_id: string;
  title: string;
  semester: string;
  module_code: string;
  units: UnitView[];
}

/** 取某单元的块（**只读 markdown，绝不读 .raw.json**）。 */
function chunksOf(store: LectureStore, courseId: string, unit: UnitMeta): RawChunk[] {
  const md = store.readUnitMarkdown(courseId, unit);
  if (!md) return [];
  // 复用 store 的解析器，保证与写入侧对称
  return parseUnitMarkdown(md).chunks;
}

/** 列出全部课程（含单元列表）。 */
export function buildCourseList(store: LectureStore): CourseView[] {
  const out: CourseView[] = [];
  for (const cid of store.listCourses()) {
    const idx = store.readIndex(cid);
    if (!idx) continue;
    const units: UnitView[] = idx.units.map((u) => {
      const chunks = chunksOf(store, cid, u);
      const blanks = allBlanksOk(chunks);
      return {
        id: u.id,
        date: u.date,
        title: u.title,
        reviewed: u.reviewed,
        has_summary: u.has_summary,
        chunk_count: chunks.length,
        blanks_ok: blanks.ok,
      };
    });
    out.push({
      course_id: idx.course_id,
      title: idx.title,
      semester: idx.semester,
      module_code: idx.module_code,
      units,
    });
  }
  return out;
}

/**
 * 取某单元的课堂记录（速记 + 留白）。
 *
 * ⚠️ **不返回加工结果**（`.raw.json`）——D3 边界。
 */
export function buildUnitView(
  store: LectureStore,
  courseId: string,
  unitId: string,
): { ok: true; unit: UnitView; chunks: RawChunk[] } | { ok: false; error: string } {
  const idx = store.readIndex(courseId);
  if (!idx) return { ok: false, error: `课程不存在: ${courseId}` };
  const unit = idx.units.find((u) => u.id === unitId);
  if (!unit) return { ok: false, error: `单元不存在: ${unitId}` };
  const chunks = chunksOf(store, courseId, unit);
  const blanks = allBlanksOk(chunks);
  return {
    ok: true,
    unit: {
      id: unit.id,
      date: unit.date,
      title: unit.title,
      reviewed: unit.reviewed,
      has_summary: unit.has_summary,
      chunk_count: chunks.length,
      blanks_ok: blanks.ok,
    },
    chunks,
  };
}

/** 发送给前端的符号表（前端渲染边栏用；纯数据）。 */
export function buildSymbolPayload(): unknown {
  return { groups: SYMBOL_DATA };
}

/**
 * D3 泄漏自检：给定一个准备发给前端的对象，断言它不含加工结果字段。
 *
 * 用途：所有 GET 分支在 `json()` 之前调用一次（开发期护栏）；
 * 单测 `check6.mjs` 直接对每个视图断言。
 *
 * ⚠️ 黑名单式护栏的固有弱点：漏一个键就漏一条路。所以：
 *   · 覆盖**加工链路里确定会出现的所有字段名**
 *     （ProcessingRecord: processed/formulas/model/chunk_seq；
 *      其 formulas[] 元素: shorthand/latex——这两个确在 types.ts:209）
 *   · 另加形态式兜底 `looksProcessed()`：catch 改名字的情况
 */
const LEAK_KEYS = ['processed', 'formulas', 'model', 'chunk_seq', 'shorthand', 'latex'];

export function findLeakedKeys(payload: unknown): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (LEAK_KEYS.includes(k)) hits.push(`${path}.${k}`);
      walk(val, `${path}.${k}`);
    }
  };
  walk(payload, 'root');
  // 形态兜底：即使字段改了名，只要"同时出现 LaTeX 与规范文本"也判泄漏
  if (hits.length === 0 && looksProcessed(payload)) hits.push('root.<shape>');
  return hits;
}

/**
 * 形态式兜底：一个对象同时带 `latex` 与 `processed` 类键 → 几乎可以肯定
 * 是 ProcessingRecord（改名也躲不掉）。宁可误报也不放过——这是 D3 的最后一道闸。
 */
function looksProcessed(v: unknown): boolean {
  const seen = new Set<string>();
  const collect = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      x.forEach(collect);
      return;
    }
    for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
      seen.add(k.toLowerCase());
      collect(val);
    }
  };
  collect(v);
  return seen.has('latex') && (seen.has('processed') || seen.has('normalized'));
}

// ============================================================
// 路由处理
// ============================================================

export interface LectureHttpDeps {
  store: LectureStore;
  /** 写入快照：前端提交的速记块（服务端负责落盘 + 触发后台转录）。 */
  onSubmitChunk: (courseId: string, unitId: string, chunk: { raw: string; my_understanding: string; my_question: string }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 改某一块的留白（我的理解 / 我的疑问）。
   *
   * ⚠️ 只走前端桥，**不暴露成 LLM 工具** —— 留白必须是用户自己写的
   *（D12 主动回忆），让模型代笔会让整套复盘失去意义。
   */
  onUpdateBlanks?: (
    courseId: string,
    unitId: string,
    seq: number,
    patch: { my_understanding?: string; my_question?: string },
  ) => Promise<{ ok: boolean; error?: string; blanks_ok?: boolean }>;
  /**
   * 开始一节课（创建课程 + 单元，并把该会话的"当前课堂"指向它）。
   *
   * 为什么前端需要这个：早先只能靠**对话里叫 agent 调 lecture_session_start**
   * 来建课，于是用户点开课堂界面只看到一句"还没有课程"，
   * 既没有输入框也不知道下一步做什么 —— 死路。
   * 现在界面自己就能开课。
   */
  onStartSession: (input: {
    courseId: string;
    title: string;
    courseTitle?: string;
    semester?: string;
    moduleCode?: string;
    date?: string;
  }) => Promise<{ ok: boolean; error?: string; course_id?: string; unit_id?: string; date?: string }>;
  /** 复盘操作（推进状态机）。 */
  onReview: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /**
   * 删除之后的清理钩子（host 侧清内存态与磁盘指针）。
   *
   * 为什么需要：只删文件的话，`active` 里还留着"正在记这一讲"，
   * 后续 capture 会往**已删除**的单元里写 —— 表现为"删了又冒出来"。
   */
  onAfterDelete?: (scope: 'unit' | 'course', courseId: string, unitId?: string) => void;
  /** 日志。 */
  log: (msg: string) => void;
  /** 警告。 */
  warn: (msg: string) => void;
}

/**
 * 处理 /aemeath/api/lecture。
 *
 * GET  ?action=courses            → 课程 + 单元列表
 * GET  ?action=unit&course=&unit= → 某单元的速记块（**不含加工结果**）
 * GET  ?action=symbols            → 符号表
 * POST { action: 'chunk' | 'review' | ... }
 */
export async function handleLectureHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LectureHttpDeps,
): Promise<void> {
  const { store, log, warn } = deps;
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const action = url.searchParams.get('action') ?? 'courses';

      if (action === 'symbols') {
        json(res, 200, { ok: true, ...(buildSymbolPayload() as object) });
        return;
      }

      if (action === 'review') {
        // 前端初次载入复盘状态（后续操作走 POST）
        const course = (url.searchParams.get('course') ?? '').slice(0, 64);
        const unit = (url.searchParams.get('unit') ?? '').slice(0, 64);
        if (!course || !unit) {
          jsonError(res, 400, 'course/unit required');
          return;
        }
        const result = await deps.onReview('status', { course_id: course, unit_id: unit });
        json(res, 200, { ok: true, ...result });
        return;
      }

      if (action === 'unit') {
        const course = (url.searchParams.get('course') ?? '').slice(0, 64);
        const unit = (url.searchParams.get('unit') ?? '').slice(0, 64);
        if (!course || !unit) {
          jsonError(res, 400, 'course/unit required');
          return;
        }
        const view = buildUnitView(store, course, unit);
        if (!view.ok) {
          jsonError(res, 404, view.error);
          return;
        }
        // D3 自检：绝不把加工结果发出去
        const leaked = findLeakedKeys(view);
        if (leaked.length) {
          warn(`D3 泄漏拦截：unit 视图含 ${leaked.join(', ')}`);
          jsonError(res, 500, 'internal: response would leak processing output');
          return;
        }
        json(res, 200, view);
        return;
      }

      // 默认：课程列表
      const courses = buildCourseList(store);
      const leaked = findLeakedKeys(courses);
      if (leaked.length) {
        warn(`D3 泄漏拦截：courses 视图含 ${leaked.join(', ')}`);
        jsonError(res, 500, 'internal: response would leak processing output');
        return;
      }
      json(res, 200, { ok: true, courses });
      return;
    }

    if (req.method === 'POST') {
      if (!checkWriteOrigin(req)) {
        jsonError(res, 403, 'cross-origin write denied');
        return;
      }
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
      const action = String(parsed.action ?? '');
      log(`POST action=${action}`);

      if (action === 'start') {
        // 界面自己开课（不再要求用户先去对话里调工具）。
        const courseId = String(parsed.course_id ?? '').trim().slice(0, 64);
        const title = String(parsed.title ?? '').trim().slice(0, 200);
        if (!courseId || !title) {
          jsonError(res, 400, 'course_id 和 title 都是必填的');
          return;
        }
        const r = await deps.onStartSession({
          courseId,
          title,
          courseTitle: parsed.course_title ? String(parsed.course_title).slice(0, 200) : undefined,
          semester: parsed.semester ? String(parsed.semester).slice(0, 64) : undefined,
          moduleCode: parsed.module_code ? String(parsed.module_code).slice(0, 64) : undefined,
          date: parsed.date ? String(parsed.date).slice(0, 32) : undefined,
        });
        if (!r.ok) {
          jsonError(res, 400, r.error ?? '开课失败');
          return;
        }
        json(res, 200, { ok: true, course_id: r.course_id, unit_id: r.unit_id, date: r.date });
        return;
      }

      if (action === 'delete') {
        // 删除（真机反馈：用户测试笔记删不掉）。
        // scope: 'unit'（默认，删一讲）| 'course'（删整门课）
        const scope = String(parsed.scope ?? 'unit');
        const course = String(parsed.course_id ?? '').trim().slice(0, 64);
        if (!course) {
          jsonError(res, 400, 'course_id required');
          return;
        }
        if (scope === 'course') {
          const done = deps.store.deleteCourse(course);
          if (!done) {
            jsonError(res, 404, `课程不存在: ${course}`);
            return;
          }
          deps.log(`删除课程：${course}`);
          deps.onAfterDelete?.('course', course);
          json(res, 200, { ok: true, scope: 'course', course_id: course });
          return;
        }
        const unit = String(parsed.unit_id ?? '').trim().slice(0, 64);
        if (!unit) {
          jsonError(res, 400, 'unit_id required（或 scope=course 删整门课）');
          return;
        }
        const done = deps.store.deleteUnit(course, unit);
        if (!done) {
          jsonError(res, 404, `单元不存在: ${course}/${unit}`);
          return;
        }
        deps.log(`删除单元：${course}/${unit}`);
        deps.onAfterDelete?.('unit', course, unit);
        json(res, 200, { ok: true, scope: 'unit', course_id: course, unit_id: unit });
        return;
      }

      if (action === 'chunk') {
        const course = String(parsed.course_id ?? '').slice(0, 64);
        const unit = String(parsed.unit_id ?? '').slice(0, 64);
        const chunk = parsed.chunk as { raw?: string; my_understanding?: string; my_question?: string } | undefined;
        if (!course || !unit || !chunk) {
          jsonError(res, 400, 'course_id/unit_id/chunk required');
          return;
        }
        // ⚠️ 留白**不再强制**（与 lecture_capture 工具对齐）。
        //
        //    早先这里硬性要求 [我的理解] + [我的疑问] 都填，否则 400。
        //    但那是**复盘阶段**的事 —— 上课现场速记时你正在听讲，
        //    根本没时间写"我对这段的理解"。
        //
        //    现在：只写原文即可落盘，留白由用户在复盘时补。
        //    （留白本身仍然是**用户的**：模型代笔会让主动回忆失效，
        //      所以谁都不替它填，只是允许暂时空着。）
        const missing: string[] = [];
        if (!String(chunk.my_understanding ?? '').trim()) missing.push('[我的理解]');
        if (!String(chunk.my_question ?? '').trim()) missing.push('[我的疑问]');
        const r = await deps.onSubmitChunk(course, unit, {
          raw: String(chunk.raw ?? '').slice(0, 20000),
          my_understanding: String(chunk.my_understanding ?? '').slice(0, 4000),
          my_question: String(chunk.my_question ?? '').slice(0, 4000),
        });
        if (!r.ok) {
          jsonError(res, 400, r.error ?? 'submit failed');
          return;
        }
        // blanks_missing 让前端知道"这段还没留白"，提示用户复盘时补
        json(res, 200, { ok: true, blanks_missing: missing });
        return;
      }

      // 改留白：{ action:'blanks', course_id, unit_id, seq, my_understanding?, my_question? }
      //
      // 为什么单独一个 action 而不是复用 chunk：chunk 是**追加新块**，
      // 这里是**改已有块的留白**，语义不同（改错了不该多出一块）。
      if (action === 'blanks') {
        if (!deps.onUpdateBlanks) {
          jsonError(res, 501, 'blanks 更新未接线');
          return;
        }
        const course = String(parsed.course_id ?? '').slice(0, 64);
        const unit = String(parsed.unit_id ?? '').slice(0, 64);
        const seq = Number(parsed.seq);
        if (!course || !unit || !Number.isInteger(seq) || seq < 0) {
          jsonError(res, 400, 'course_id/unit_id/seq required');
          return;
        }
        const patch: { my_understanding?: string; my_question?: string } = {};
        if (typeof parsed.my_understanding === 'string') patch.my_understanding = parsed.my_understanding;
        if (typeof parsed.my_question === 'string') patch.my_question = parsed.my_question;
        if (!Object.keys(patch).length) {
          jsonError(res, 400, '需要 my_understanding 或 my_question');
          return;
        }
        const r = await deps.onUpdateBlanks(course, unit, seq, patch);
        if (!r.ok) {
          jsonError(res, 400, r.error ?? 'save failed');
          return;
        }
        json(res, 200, { ok: true, blanks_ok: r.blanks_ok ?? false });
        return;
      }

      if (action === 'review') {
        const result = await deps.onReview(String(parsed.op ?? ''), parsed);
        json(res, 200, { ok: true, ...result });
        return;
      }

      jsonError(res, 400, `unknown action: ${action}`);
      return;
    }

    jsonError(res, 405, 'method not allowed');
  } catch (e) {
    const err = e as Error & { status?: number };
    warn(`lecture http 失败: ${err.message}`);
    jsonError(res, err.status ?? 500, err.message);
  }
}

/** 前端可提交的留白校验（供 UI 复用同一逻辑）。 */
export function blankCheck(chunk: { my_understanding: string; my_question: string }): { ok: boolean; missing: string[] } {
  return chunkBlanksOk({
    seq: 0,
    raw: '',
    my_understanding: chunk.my_understanding,
    my_question: chunk.my_question,
    created_at: 0,
  });
}
