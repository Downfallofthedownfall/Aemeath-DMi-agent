// ============================================================
// http.ts — 习题模块的同源 HTTP 桥（前端 ↔ 后端）
//
// 与 lecture 的 http.ts 同一套纪律：
//   · 前端经 /aemeath/api/exercise 读写，**不持有任何 token**
//   · 写请求（POST）校验 Origin 是回环地址（防 DNS 重绑定/跨站写）
//   · body 上限（这里比 lecture 大：要收 base64 的 PDF）
//   · 所有字符串参数做长度钳制
//
// 为什么上传 PDF 走 JSON base64 而不是 multipart：
//   前端是一个 client 插件（没有表单/没有 fetch 上传封装），
//   `FileReader.readAsDataURL` + JSON 是最少代码的路径；
//   代价是体积 +33%，对几百 KB 的 Übungsblatt 可以接受（上限 32MB）。
//
// 路由一览（GET 读 / POST 写）：
//   GET  ?action=courses                 课程 + 每套题状态
//   GET  ?action=sheet&course&sheet      一套题（题目/答案/检查/经验）
//   GET  ?action=source&course&sheet     PDF 抽出的原始文本
//   GET  ?action=source_pdf&course&sheet 原卷 PDF（inline，浏览器直接看）
//   GET  ?action=submission&course&sheet 生成的提交 PDF（inline/attachment）
//   GET  ?action=mistakes                错题本
//   GET  ?action=digest&course           下一套题的进度摘要（预览）
//   GET  ?action=symbols                 数学符号表（借 lecture 的数据）
//   GET  ?action=print&course&sheet      提交页 HTML（浏览器里手动打印/预览）
//   POST { action: 'import' | 'check' | 'build_submission' | ... }
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tr } from './locale.js';

/** 上传 PDF 需要更大的 body：32MB（base64 后约 24MB 原文件）。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

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

/** 写请求 Origin 校验（无 Origin 放行 = 非浏览器客户端，如 curl）。 */
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

export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
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
      if (size > maxBytes) {
        fail(413, `body too large (max ${Math.round(maxBytes / 1024 / 1024)}MB)`);
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

/** 以 PDF 形式返回一个文件（inline = 浏览器内预览；attachment = 下载）。 */
export function servePdfFile(res: ServerResponse, abs: string, downloadName?: string): void {
  if (!existsSync(abs)) {
    jsonError(res, 404, tr('文件不存在（还没生成？）', 'File not found (not generated yet?)'));
    return;
  }
  try {
    const st = statSync(abs);
    const body = readFileSync(abs);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-store',
      // 中文/德文文件名要 encodeURIComponent，否则头部会乱码
      'Content-Disposition': `${downloadName ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(
        downloadName ?? abs.split(/[\\/]/).pop() ?? 'submission.pdf',
      )}`,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    void st;
  } catch (e) {
    jsonError(res, 500, tr(`读取失败：${(e as Error).message}`, `Read failed: ${(e as Error).message}`));
  }
}

// ============================================================
// 依赖注入（所有真实逻辑在 index.ts；这里只做路由与参数收敛）
// ============================================================

export interface ExerciseHttpDeps {
  store: {
    rootPath: string;
  };
  /** GET courses */
  buildCourses(): unknown;
  /** GET sheet */
  buildSheetView(courseId: string, sheetId: string): { ok: true; sheet: unknown } | { ok: false; error: string };
  /** GET mistakes */
  buildMistakes(): unknown;
  /** GET digest（下一套题的进度摘要，含"这套开题时会附什么"） */
  buildDigestPreview(courseId: string): unknown;
  /** GET symbols（借 lecture 的符号表） */
  buildSymbols(): unknown;
  /** GET source：PDF 抽出的文本 */
  readSourceText(courseId: string, sheetId: string): string | null;
  /** GET source_pdf / submission 的物理路径（不存在返回 null） */
  sourcePdfPath(courseId: string, sheetId: string): string | null;
  /** 原卷页面截图（多模态读图渲染的 JPEG）；没有 → null */
  readPageImage(courseId: string, sheetId: string, page: number): { bytes: Uint8Array; mediaType: string } | null;
  submissionPdfPath(courseId: string, sheetId: string): string | null;
  /** GET print：提交页 HTML（浏览器手动打印/预览） */
  buildPrintHtml(courseId: string, sheetId: string, opts: { draft: boolean }): { ok: true; html: string } | { ok: false; error: string };

  /** POST import（PDF 导入） */
  onImport(input: {
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
  }): Promise<{ ok: boolean; error?: string; course_id?: string; sheet_id?: string; sheet?: unknown; warnings?: string[] }>;

  /** POST create（空套/手填） */
  onCreateSheet(input: { courseId: string; courseTitle?: string; title?: string; due?: string; number?: number }): Promise<{ ok: boolean; error?: string; sheet?: unknown }>;

  /** POST update_problem */
  onUpdateProblem(input: {
    courseId: string;
    sheetId: string;
    problemId: string;
    patch: { text?: string; title?: string; points?: number | null; answer?: string; notes?: string };
    editedBy?: 'user' | 'agent';
  }): Promise<{ ok: boolean; error?: string; sheet?: unknown; stale?: number }>;

  /** POST add_problem / delete_problem / resplit */
  onAddProblem(input: { courseId: string; sheetId: string; label?: string; text?: string }): Promise<{ ok: boolean; error?: string; sheet?: unknown }>;
  onDeleteProblem(input: { courseId: string; sheetId: string; problemId: string }): Promise<{ ok: boolean; error?: string; sheet?: unknown }>;
  onResplit(input: { courseId: string; sheetId: string; useLlm?: boolean }): Promise<{
    ok: boolean;
    error?: string;
    sheet?: unknown;
    used_llm?: boolean;
    note?: string;
  }>;

  /** POST check（手动触发的 LLM 检查） */
  onCheck(input: { courseId: string; sheetId: string; problemId: string }): Promise<{ ok: boolean; error?: string; check?: unknown; sheet?: unknown }>;

  /** POST collect_mistake */
  onCollectMistake(input: { courseId: string; sheetId: string; problemId: string; lesson?: string; tags?: string[] }): Promise<{ ok: boolean; error?: string; mistake?: unknown }>;
  /** POST patch_mistake / delete_mistake */
  onPatchMistake(input: { id: string; patch: Record<string, unknown> }): Promise<{ ok: boolean; error?: string; mistake?: unknown }>;
  onDeleteMistake(input: { id: string }): Promise<{ ok: boolean; error?: string }>;

  /** POST lesson（增/改/删） */
  onLesson(input: { op: 'add' | 'update' | 'delete'; courseId: string; sheetId: string; lessonId?: string; text?: string; tags?: string[] }): Promise<{ ok: boolean; error?: string; sheet?: unknown }>;

  /** POST sync_worldbook */
  onSyncWorldbook(input: { courseId?: string; sheetId?: string }): Promise<{ ok: boolean; error?: string; written?: number; skipped?: number; failed?: number; details?: string[] }>;

  /** POST build_submission */
  onBuildSubmission(input: {
    courseId: string;
    sheetId: string;
    includeSource?: boolean;
    order?: 'sheet-first' | 'solutions-first';
    draft?: boolean;
  }): Promise<{
    ok: boolean;
    error?: string;
    file?: string;
    pages?: number;
    bytes?: number;
    url?: string;
    print_url?: string;
    renderer?: string;
    hint?: string;
  }>;

  /** GET attachment：读答案附图（private，需要 cookie） */
  onReadAttachment(input: { courseId: string; sheetId: string; name: string }): { bytes: Buffer; mediaType: string } | null;

  /** POST add_attachment：上传答案附图（base64） */
  onAddAttachment(input: {
    courseId: string;
    sheetId: string;
    problemId: string;
    base64: string;
    caption?: string;
    /** 题目截图（problem）还是答案附图（answer，默认） */
    role?: 'answer' | 'problem';
  }): Promise<{ ok: boolean; error?: string; image?: unknown; sheet?: unknown }>;

  /** POST delete_attachment */
  onDeleteAttachment(input: {
    courseId: string;
    sheetId: string;
    problemId: string;
    imageId: string;
  }): Promise<{ ok: boolean; error?: string; sheet?: unknown }>;

  /** GET scratch：极简工作区（临时做题；必要时自动创建） */
  onScratch(): { ok: boolean; error?: string; sheet?: unknown };

  /** POST approach：思路检查（可重复、临时，不落盘） */
  onApproach(input: {
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
  }>;

  /** POST import_scratch_pdf：极简模式上传题目 PDF（base64） */
  onImportScratchPdf(input: { base64: string }): Promise<{
    ok: boolean;
    error?: string;
    sheet?: unknown;
    text_length?: number;
    pages?: number;
  }>;

  /** POST scratch（reset: true 重置） */
  onScratchReset(): { ok: boolean; error?: string; sheet?: unknown };

  /** POST rebut（答辩：学生质疑批改，模型重新推导后承认或给出证据） */
  onRebuttal(input: { courseId: string; sheetId: string; problemId: string; text: string }): Promise<{
    ok: boolean;
    error?: string;
    /** 相对 viewOf 的 sheet 视图（与其它写操作一致） */
    sheet?: unknown;
  }>;

  /** POST export_text（纯文本 / markdown，给 git 管理用） */
  onExportText(input: { courseId?: string }): Promise<{
    ok: boolean;
    error?: string;
    dir?: string;
    written?: string[];
    unchanged?: string[];
    removed?: string[];
    files?: string[];
  }>;

  /** POST export_handoff */
  onExportHandoff(input: { courseId?: string }): Promise<{ ok: boolean; error?: string; files?: string[]; summaries?: string[]; dir?: string }>;

  /**
   * POST import_handoff（**接收侧**：在主 agent 所在机器上导入习题握手包）。
   *
   * 为什么也做成 HTTP 动作：用户不该被逼着"先跟我说一句话"才能同步 ——
   * 界面上「导入握手」按钮先 dry-run 预览，再确认写入。
   * 缺省 dry_run=true（不可写任何东西）。
   */
  onImportHandoff(input: { file?: string; dryRun?: boolean; preset?: string }): Promise<{
    ok: boolean;
    error?: string;
    dry_run?: boolean;
    files?: string[];
    memories?: number;
    worldbook?: number;
    dropped?: number;
    outcomes?: string[];
    degraded?: boolean;
    previews?: string[];
    note?: string;
  }>;

  /** POST delete（sheet | course） */
  onDelete(input: { scope: 'sheet' | 'course'; courseId: string; sheetId?: string }): Promise<{ ok: boolean; error?: string }>;

  log(msg: string): void;
  warn(msg: string): void;
}

const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 处理 /aemeath/api/exercise。 */
export async function handleExerciseHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ExerciseHttpDeps,
): Promise<void> {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const action = url.searchParams.get('action') ?? 'courses';
      const course = str(url.searchParams.get('course'), 64);
      const sheet = str(url.searchParams.get('sheet'), 40);

      switch (action) {
        case 'courses':
          json(res, 200, { ok: true, courses: deps.buildCourses() });
          return;

        case 'scratch': {
          const r = deps.onScratch();
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'sheet': {
          if (!course || !sheet) {
            jsonError(res, 400, 'course/sheet required');
            return;
          }
          const view = deps.buildSheetView(course, sheet);
          if (!view.ok) {
            jsonError(res, 404, view.error);
            return;
          }
          json(res, 200, view);
          return;
        }

        case 'mistakes':
          json(res, 200, { ok: true, mistakes: deps.buildMistakes() });
          return;

        case 'digest': {
          if (!course) {
            jsonError(res, 400, 'course required');
            return;
          }
          json(res, 200, { ok: true, ...(deps.buildDigestPreview(course) as object) });
          return;
        }

        case 'symbols':
          json(res, 200, { ok: true, ...(deps.buildSymbols() as object) });
          return;

        case 'source': {
          if (!course || !sheet) {
            jsonError(res, 400, 'course/sheet required');
            return;
          }
          const text = deps.readSourceText(course, sheet);
          if (text == null) {
            jsonError(res, 404, tr('没有原文存档（手填的题集没有 source.md）', 'No source archive (a manually created sheet has no source.md)'));
            return;
          }
          json(res, 200, { ok: true, text });
          return;
        }

        case 'attachment': {
          const name = typeof url.searchParams.get('name') === 'string' ? String(url.searchParams.get('name')).slice(0, 200) : '';
          const course = url.searchParams.get('course') ?? '';
          const sheet = url.searchParams.get('sheet') ?? '';
          if (!course || !sheet || !name) {
            jsonError(res, 400, 'course / sheet / name required');
            return;
          }
          const got = deps.onReadAttachment({ courseId: course, sheetId: sheet, name });
          if (!got) {
            jsonError(res, 404, tr('图片不存在', 'Image not found'));
            return;
          }
          res.writeHead(200, {
            'Content-Type': got.mediaType,
            'Content-Length': String(got.bytes.length),
            'Cache-Control': 'private, max-age=60',
          });
          res.end(got.bytes);
          return;
        }

        case 'source_pdf': {
          if (!course || !sheet) {
            jsonError(res, 400, 'course/sheet required');
            return;
          }
          const p = deps.sourcePdfPath(course, sheet);
          if (!p) {
            jsonError(res, 404, tr('没有导入的原卷 PDF', 'No original PDF was imported'));
            return;
          }
          // 下载还是预览：?download=1
          const dl = url.searchParams.get('download') === '1';
          servePdfFile(res, p, dl ? `${course}-${sheet}.pdf` : undefined);
          return;
        }

        case 'page': {
          // 原卷页面截图（多模态读图渲染出来的 JPEG）。界面用它显示"原题截图"。
          if (!course || !sheet) {
            jsonError(res, 400, 'course/sheet required');
            return;
          }
          const pageNo = Number(url.searchParams.get('page') ?? '1');
          if (!Number.isFinite(pageNo) || pageNo < 1) {
            jsonError(res, 400, 'page must be >= 1');
            return;
          }
          const img = deps.readPageImage(course, sheet, Math.floor(pageNo));
          if (!img) {
            jsonError(res, 404, tr(`没有第 ${pageNo} 页截图（这套题可能没有页面图片）`, `No screenshot for page ${pageNo} (this sheet may have no page images)`));
            return;
          }
          res.writeHead(200, {
            'Content-Type': img.mediaType,
            'Content-Length': String(img.bytes.byteLength),
            'Cache-Control': 'private, max-age=600',
          });
          res.end(Buffer.from(img.bytes));
          return;
        }

        case 'submission': {
          if (!course || !sheet) {
            jsonError(res, 400, 'course/sheet required');
            return;
          }
          const p = deps.submissionPdfPath(course, sheet);
          if (!p) {
            jsonError(res, 404, tr('还没生成提交包（先 build_submission）', 'No submission package yet (run build_submission first)'));
            return;
          }
          const dl = url.searchParams.get('download') === '1';
          servePdfFile(res, p, dl ? p.split(/[\\/]/).pop() : undefined);
          return;
        }

        case 'print': {
          if (!course || !sheet) {
            jsonError(res, 400, 'course/sheet required');
            return;
          }
          const r = deps.buildPrintHtml(course, sheet, { draft: url.searchParams.get('draft') === '1' });
          if (!r.ok) {
            jsonError(res, 404, r.error);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(r.html);
          return;
        }

        default:
          jsonError(res, 400, `unknown action: ${action}`);
          return;
      }
    }

    if (req.method === 'POST') {
      if (!checkWriteOrigin(req)) {
        jsonError(res, 403, 'cross-origin write denied');
        return;
      }
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
      const action = str(parsed.action, 40);
      deps.log(`POST action=${action}`);

      const courseId = str(parsed.course_id, 64);
      const sheetId = str(parsed.sheet_id, 40);

      switch (action) {
        case 'import': {
          if (!courseId) {
            jsonError(res, 400, 'course_id required');
            return;
          }
          const pdfBase64 = typeof parsed.pdf_base64 === 'string' ? parsed.pdf_base64 : undefined;
          const text = typeof parsed.text === 'string' ? parsed.text : undefined;
          if (!pdfBase64 && !text) {
            jsonError(res, 400, tr('需要 pdf_base64 或 text（至少一个）', 'pdf_base64 or text is required (at least one)'));
            return;
          }
          const r = await deps.onImport({
            courseId,
            courseTitle: parsed.course_title ? str(parsed.course_title, 200) : undefined,
            semester: parsed.semester ? str(parsed.semester, 64) : undefined,
            moduleCode: parsed.module_code ? str(parsed.module_code, 64) : undefined,
            number: num(parsed.number),
            title: parsed.title ? str(parsed.title, 200) : undefined,
            issued: parsed.issued ? str(parsed.issued, 32) : undefined,
            due: parsed.due ? str(parsed.due, 32) : undefined,
            pdfBase64,
            filename: parsed.filename ? str(parsed.filename, 200) : undefined,
            text: text !== undefined ? String(text).slice(0, 400_000) : undefined,
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'create': {
          if (!courseId) {
            jsonError(res, 400, 'course_id required');
            return;
          }
          const r = await deps.onCreateSheet({
            courseId,
            courseTitle: parsed.course_title ? str(parsed.course_title, 200) : undefined,
            title: parsed.title ? str(parsed.title, 200) : undefined,
            due: parsed.due ? str(parsed.due, 32) : undefined,
            number: num(parsed.number),
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'update_problem': {
          if (!courseId || !sheetId || !parsed.problem_id) {
            jsonError(res, 400, 'course_id/sheet_id/problem_id required');
            return;
          }
          const patchIn = (parsed.patch ?? {}) as Record<string, unknown>;
          const patch: { text?: string; title?: string; points?: number | null; answer?: string; notes?: string } = {};
          if (typeof patchIn.text === 'string') patch.text = patchIn.text.slice(0, 40_000);
          if (typeof patchIn.title === 'string') patch.title = patchIn.title.slice(0, 200);
          if (typeof patchIn.answer === 'string') patch.answer = patchIn.answer.slice(0, 40_000);
          if (typeof patchIn.notes === 'string') patch.notes = patchIn.notes.slice(0, 8_000);
          if (patchIn.points === null) patch.points = null;
          else if (patchIn.points !== undefined) {
            const p = Number(patchIn.points);
            patch.points = Number.isFinite(p) ? p : null;
          }
          const r = await deps.onUpdateProblem({
            courseId,
            sheetId,
            problemId: str(parsed.problem_id, 24),
            patch,
            editedBy: parsed.edited_by === 'agent' ? 'agent' : 'user',
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'add_problem': {
          if (!courseId || !sheetId) {
            jsonError(res, 400, 'course_id/sheet_id required');
            return;
          }
          const r = await deps.onAddProblem({
            courseId,
            sheetId,
            label: parsed.label ? str(parsed.label, 60) : undefined,
            text: parsed.text ? String(parsed.text).slice(0, 40_000) : undefined,
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'delete_problem': {
          if (!courseId || !sheetId || !parsed.problem_id) {
            jsonError(res, 400, 'course_id/sheet_id/problem_id required');
            return;
          }
          const r = await deps.onDeleteProblem({ courseId, sheetId, problemId: str(parsed.problem_id, 24) });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'resplit': {
          if (!courseId || !sheetId) {
            jsonError(res, 400, 'course_id/sheet_id required');
            return;
          }
          // use_llm 缺省 true：规则分块对 LaTeX 排版基本没用（用户实测）
          const r = await deps.onResplit({ courseId, sheetId, useLlm: parsed.use_llm !== false });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'check': {
          if (!courseId || !sheetId || !parsed.problem_id) {
            jsonError(res, 400, 'course_id/sheet_id/problem_id required');
            return;
          }
          const r = await deps.onCheck({ courseId, sheetId, problemId: str(parsed.problem_id, 24) });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'add_attachment': {
          const problemId = parsed.problem_id ? str(parsed.problem_id, 64) : '';
          if (!courseId || !sheetId || !problemId) {
            jsonError(res, 400, 'course_id / sheet_id / problem_id required');
            return;
          }
          const r = await deps.onAddAttachment({
            courseId,
            sheetId,
            problemId,
            base64: str(parsed.base64 ?? '', 20 * 1024 * 1024),
            caption: parsed.caption ? str(parsed.caption, 200) : undefined,
            role: parsed.role === 'problem' ? 'problem' : 'answer',
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'delete_attachment': {
          const problemId = parsed.problem_id ? str(parsed.problem_id, 64) : '';
          const imageId = parsed.image_id ? str(parsed.image_id, 64) : '';
          if (!courseId || !sheetId || !problemId || !imageId) {
            jsonError(res, 400, 'course_id / sheet_id / problem_id / image_id required');
            return;
          }
          const r = await deps.onDeleteAttachment({ courseId, sheetId, problemId, imageId });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'rebut': {
          const problemId = parsed.problem_id ? str(parsed.problem_id, 64) : '';
          if (!courseId || !sheetId || !problemId) {
            jsonError(res, 400, 'course_id / sheet_id / problem_id required');
            return;
          }
          const text = str(parsed.text ?? '', 8000);
          if (!text.trim()) {
            jsonError(res, 400, tr('text required（写点你要答辩的内容）', 'text required (write what you are rebutting)'));
            return;
          }
          const r = await deps.onRebuttal({ courseId, sheetId, problemId, text });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'collect_mistake': {
          if (!courseId || !sheetId || !parsed.problem_id) {
            jsonError(res, 400, 'course_id/sheet_id/problem_id required');
            return;
          }
          const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t) => str(t, 40)).filter(Boolean).slice(0, 8) : undefined;
          const r = await deps.onCollectMistake({
            courseId,
            sheetId,
            problemId: str(parsed.problem_id, 24),
            lesson: parsed.lesson ? String(parsed.lesson).slice(0, 2000) : undefined,
            tags,
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'patch_mistake': {
          if (!parsed.id) {
            jsonError(res, 400, 'id required');
            return;
          }
          const patchIn = (parsed.patch ?? {}) as Record<string, unknown>;
          const patch: Record<string, unknown> = {};
          if (typeof patchIn.lesson === 'string') patch.lesson = patchIn.lesson.slice(0, 4000);
          if (typeof patchIn.mastered === 'boolean') patch.mastered = patchIn.mastered;
          if (Array.isArray(patchIn.tags)) patch.tags = patchIn.tags.map((t) => str(t, 40)).filter(Boolean).slice(0, 8);
          const r = await deps.onPatchMistake({ id: str(parsed.id, 64), patch });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'delete_mistake': {
          if (!parsed.id) {
            jsonError(res, 400, 'id required');
            return;
          }
          const r = await deps.onDeleteMistake({ id: str(parsed.id, 64) });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'lesson': {
          if (!courseId || !sheetId) {
            jsonError(res, 400, 'course_id/sheet_id required');
            return;
          }
          const op = str(parsed.op, 12) as 'add' | 'update' | 'delete';
          if (!['add', 'update', 'delete'].includes(op)) {
            jsonError(res, 400, tr('op 必须是 add/update/delete', 'op must be add/update/delete'));
            return;
          }
          const r = await deps.onLesson({
            op,
            courseId,
            sheetId,
            lessonId: parsed.lesson_id ? str(parsed.lesson_id, 64) : undefined,
            text: parsed.text ? String(parsed.text).slice(0, 4000) : undefined,
            tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => str(t, 40)).filter(Boolean).slice(0, 8) : undefined,
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'sync_worldbook': {
          const r = await deps.onSyncWorldbook({
            courseId: courseId || undefined,
            sheetId: sheetId || undefined,
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'build_submission': {
          if (!courseId || !sheetId) {
            jsonError(res, 400, 'course_id/sheet_id required');
            return;
          }
          const order = parsed.order === 'solutions-first' ? 'solutions-first' : 'sheet-first';
          const r = await deps.onBuildSubmission({
            courseId,
            sheetId,
            includeSource: parsed.include_source === true,
            order,
            draft: parsed.draft === true,
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'approach': {
          const courseId = str(parsed.course_id ?? '', 120);
          const sheetId = str(parsed.sheet_id ?? '', 40);
          if (!courseId || !sheetId || !parsed.problem_id) {
            jsonError(res, 400, 'course/sheet/problem required');
            return;
          }
          const r = await deps.onApproach({
            courseId,
            sheetId,
            problemId: str(parsed.problem_id, 40),
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'import_scratch_pdf': {
          const r = await deps.onImportScratchPdf({ base64: str(parsed.base64 ?? '', 40 * 1024 * 1024) });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'reset_scratch': {
          const r = deps.onScratchReset();
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'export_text': {
          const r = await deps.onExportText({ courseId: courseId || undefined });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'export_handoff': {
          const r = await deps.onExportHandoff({ courseId: courseId || undefined });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'import_handoff': {
          const r = await deps.onImportHandoff({
            file: parsed.file ? str(parsed.file, 400) : undefined,
            dryRun: parsed.dry_run !== false,
            preset: parsed.preset ? str(parsed.preset, 40) : undefined,
          });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        case 'delete': {
          const scope = parsed.scope === 'course' ? 'course' : 'sheet';
          if (!courseId) {
            jsonError(res, 400, 'course_id required');
            return;
          }
          if (scope === 'sheet' && !sheetId) {
            jsonError(res, 400, tr('sheet_id required（或 scope=course）', 'sheet_id required (or scope=course)'));
            return;
          }
          const r = await deps.onDelete({ scope, courseId, sheetId: sheetId || undefined });
          json(res, r.ok ? 200 : 400, r);
          return;
        }

        default:
          jsonError(res, 400, `unknown action: ${action}`);
          return;
      }
    }

    jsonError(res, 405, 'method not allowed');
  } catch (e) {
    const err = e as Error & { status?: number };
    deps.warn(`exercise http 失败: ${err.message}`);
    jsonError(res, err.status ?? 500, err.message);
  }
}
