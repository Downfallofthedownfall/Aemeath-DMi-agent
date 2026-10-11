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
  /** 复盘操作（推进状态机）。 */
  onReview: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** 日志。 */
  log: (msg: string) => void;
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

      if (action === 'chunk') {
        const course = String(parsed.course_id ?? '').slice(0, 64);
        const unit = String(parsed.unit_id ?? '').slice(0, 64);
        const chunk = parsed.chunk as { raw?: string; my_understanding?: string; my_question?: string } | undefined;
        if (!course || !unit || !chunk) {
          jsonError(res, 400, 'course_id/unit_id/chunk required');
          return;
        }
        // 强制留白：前端也会拦，但服务端必须再拦一次（前端可绕过）
        const missing: string[] = [];
        if (!String(chunk.my_understanding ?? '').trim()) missing.push('[我的理解]');
        if (!String(chunk.my_question ?? '').trim()) missing.push('[我的疑问]');
        if (missing.length) {
          jsonError(res, 400, `强制留白未填：${missing.join('、')}`, { missing });
          return;
        }
        const r = await deps.onSubmitChunk(course, unit, {
          raw: String(chunk.raw ?? '').slice(0, 20000),
          my_understanding: String(chunk.my_understanding ?? '').slice(0, 4000),
          my_question: String(chunk.my_question ?? '').slice(0, 4000),
        });
        if (!r.ok) {
          jsonError(res, 400, r.error ?? 'submit failed');
          return;
        }
        json(res, 200, { ok: true });
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
