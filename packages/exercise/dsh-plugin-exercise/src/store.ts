// ============================================================
// store.ts — Übungen 文件存储（与 lecture 同款：文件为主，人可读可 diff）
//
// 目录布局（D2：放 physicist 里，retriever 可直接消费）：
//   packages/library/physicist/exercises/
//     _mistakes.json                 ← 跨课程错题本（全局一份）
//     <course_id>/
//       index.json                   ← 课程 + 每套题的状态摘要
//       <sheet_id>/
//         sheet.json                 ← 题目 / 答案 / 检查记录 / 经验（唯一事实源）
//         source.pdf                 ← 导入的原卷（提交时合并到末尾/开头）
//         source.md                  ← PDF 抽出的文本（人可改；题目文本被用户改过后不再回读）
//         submission.pdf             ← 生成的提交包
//         <sheet_id>.md              ← 人可读导出（含答案，喂 retriever / git diff）
//
// 为什么 sheet.json 而不是"每题一个文件"：
//   · 一套题通常 4–8 题，一次改动要原子落盘；拆文件会引入"改一半"的中间态
//   · 手改成本：一个 JSON 体量可控（几十 KB），比 8 个文件好核对
// 为什么还要 source.md + <sheet>.md：
//   · source.md 是"PDF 原文的存档"，用户可以直接改它再重新拆题
//   · <sheet>.md 是给人看/给 LLM 检索的，不进 UI
//
// 本模块是**纯文件层**：不依赖 dsh，可单测。
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, extname, join, isAbsolute } from 'node:path';
import { pageImageName, pageFromImageName } from './pdf-image.js';
import {
  courseIndexSchema,
  sheetSchema,
  mistakeSchema,
  sheetProgress,
  emptyCourseIndex,
  submissionFileName,
  type CourseIndex,
  type Sheet,
  type SheetMeta,
  type Mistake,
  type Problem,
  type Check,
  type Lesson,
} from './types.js';

function log(msg: string): void {
  console.log(`[aemeath-exercise] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[aemeath-exercise] ⚠ ${msg}`);
}

/**
 * id 净化（与 lecture 的 sanitizeId 同一套，理由见其注释）：
 * 路径分隔符折叠、白名单字符、**删掉任何点号序列**（防 `..` 残留）、去首尾连字符。
 */
function sanitizeId(id: string, maxLen: number): string {
  return id
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
}

export function safeCourseId(id: string): string {
  return sanitizeId(id.toLowerCase(), 64);
}

export function safeSheetId(id: string): string {
  return sanitizeId(id.toLowerCase(), 40) || 'sheet';
}

/** 题目 id：`p01` 这种，只允许小写字母数字与连字符。 */
export function safeProblemId(id: string): string {
  return sanitizeId(id.toLowerCase(), 24) || 'p';
}

/** 由序号生成题目 id。 */
export function problemIdOf(index: number): string {
  return `p${String(index + 1).padStart(2, '0')}`;
}

export interface StoreOptions {
  /** 数据根目录（相对仓库根或绝对路径）。 */
  rootDir: string;
}

export class ExerciseStore {
  private readonly root: string;

  constructor(opts: StoreOptions) {
    this.root = isAbsolute(opts.rootDir) ? opts.rootDir : join(process.cwd(), opts.rootDir);
  }

  get rootPath(): string {
    return this.root;
  }

  courseDir(courseId: string): string {
    return join(this.root, safeCourseId(courseId));
  }

  sheetDir(courseId: string, sheetId: string): string {
    return join(this.courseDir(courseId), safeSheetId(sheetId));
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** 读 JSON 并容忍 UTF-8 BOM（人可手改的文件；Windows 记事本会写 BOM）。 */
  private readJson(file: string): unknown {
    const raw = readFileSync(file, 'utf-8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  }

  private writeJson(file: string, value: unknown): void {
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
  }

  // ============================================================
  // 课程
  // ============================================================

  listCourses(): string[] {
    if (!existsSync(this.root)) return [];
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(this.root, d.name, 'index.json')))
        .map((d) => d.name)
        .sort();
    } catch (e) {
      warn(`列出课程失败: ${(e as Error).message}`);
      return [];
    }
  }

  readIndex(courseId: string): CourseIndex | null {
    const file = join(this.courseDir(courseId), 'index.json');
    if (!existsSync(file)) return null;
    try {
      const parsed = courseIndexSchema.safeParse(this.readJson(file));
      if (!parsed.success) {
        warn(`索引 schema 不符（${courseId}）：${parsed.error.message.slice(0, 200)}`);
        return null;
      }
      return parsed.data;
    } catch (e) {
      warn(`读索引失败（${courseId}）: ${(e as Error).message}`);
      return null;
    }
  }

  writeIndex(index: CourseIndex): void {
    const dir = this.courseDir(index.course_id);
    this.ensureDir(dir);
    this.writeJson(join(dir, 'index.json'), index);
  }

  ensureCourse(courseId: string, title: string, semester = '', moduleCode = ''): CourseIndex {
    const existing = this.readIndex(courseId);
    if (existing) {
      // 幂等：已有课程时允许补全标题/学期（用户后来填的）
      const next: CourseIndex = {
        ...existing,
        title: existing.title || title,
        semester: existing.semester || semester,
        module_code: existing.module_code || moduleCode,
      };
      if (next.title !== existing.title || next.semester !== existing.semester || next.module_code !== existing.module_code) {
        this.writeIndex(next);
      }
      return next;
    }
    const index = emptyCourseIndex(safeCourseId(courseId), title, semester, moduleCode);
    this.writeIndex(index);
    log(`课程已创建: ${index.course_id}（${title}）`);
    return index;
  }

  /** 新增/更新索引里的一套题摘要（由 sheet.json 派生）。 */
  upsertSheetMeta(courseId: string, sheet: Sheet): CourseIndex {
    const index = this.readIndex(courseId);
    if (!index) throw new Error(`课程不存在: ${courseId}`);
    const prog = sheetProgress(sheet);
    const meta: SheetMeta = {
      id: sheet.id,
      number: sheet.number,
      title: sheet.title,
      issued: sheet.issued,
      due: sheet.due,
      problem_count: prog.total,
      answered_count: prog.answered,
      checked_count: prog.checked,
      wrong_count: prog.needsFix,
      submitted: sheet.submitted_at > 0,
      import_mode: sheet.import_mode,
    };
    const i = index.sheets.findIndex((s) => s.id === meta.id);
    if (i === -1) index.sheets.push(meta);
    else index.sheets[i] = meta;
    index.sheets.sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
    this.writeIndex(index);
    return index;
  }

  // ============================================================
  // 一套题（sheet.json = 唯一事实源）
  // ============================================================

  sheetFile(courseId: string, sheetId: string): string {
    return join(this.sheetDir(courseId, sheetId), 'sheet.json');
  }

  readSheet(courseId: string, sheetId: string): Sheet | null {
    const file = this.sheetFile(courseId, sheetId);
    if (!existsSync(file)) return null;
    try {
      const parsed = sheetSchema.safeParse(this.readJson(file));
      if (!parsed.success) {
        warn(`sheet schema 不符（${courseId}/${sheetId}）：${parsed.error.message.slice(0, 240)}`);
        return null;
      }
      return parsed.data;
    } catch (e) {
      warn(`读 sheet 失败（${courseId}/${sheetId}）: ${(e as Error).message}`);
      return null;
    }
  }

  writeSheet(courseId: string, sheet: Sheet): string {
    const dir = this.sheetDir(courseId, sheet.id);
    this.ensureDir(dir);
    const file = this.sheetFile(courseId, sheet.id);
    this.writeJson(file, sheet);
    // 索引跟着走（单一写入口，避免"界面已更新、索引还是旧的"）
    try {
      this.upsertSheetMeta(courseId, sheet);
    } catch (e) {
      warn(`更新索引失败（${courseId}/${sheet.id}）: ${(e as Error).message}`);
    }
    return file;
  }

  /** 列出某课程全部题集（按编号）。坏文件跳过不抛。 */
  listSheets(courseId: string): Sheet[] {
    const index = this.readIndex(courseId);
    if (!index) return [];
    const out: Sheet[] = [];
    for (const meta of index.sheets) {
      const s = this.readSheet(courseId, meta.id);
      if (s) out.push(s);
    }
    return out;
  }

  /** 下一套题的编号与 id（`ub03`）。 */
  nextSheetIdentity(courseId: string): { number: number; id: string } {
    const index = this.readIndex(courseId);
    const max = index ? index.sheets.reduce((m, s) => Math.max(m, s.number), 0) : 0;
    const n = max + 1;
    return { number: n, id: `ub${String(n).padStart(2, '0')}` };
  }

  // ============================================================
  // 题目 / 答案 / 检查（都在 sheet.json 里，这里只提供安全的小操作）
  // ============================================================

  /** 找到某题；不存在返回 null。 */
  findProblem(sheet: Sheet, problemId: string): Problem | null {
    return sheet.problems.find((p) => p.id === safeProblemId(problemId)) ?? null;
  }

  /** 追加一条检查记录（**只由手动触发路径调用**，见 index.ts 的注释）。 */
  appendCheck(courseId: string, sheetId: string, problemId: string, check: Check): Sheet {
    const sheet = this.readSheet(courseId, sheetId);
    if (!sheet) throw new Error(`题集不存在: ${courseId}/${sheetId}`);
    const p = this.findProblem(sheet, problemId);
    if (!p) throw new Error(`题目不存在: ${problemId}`);
    p.checks.push(check);
    this.writeSheet(courseId, sheet);
    return sheet;
  }

  /** 追加一条经验。 */
  appendLesson(courseId: string, sheetId: string, lesson: Lesson): Sheet {
    const sheet = this.readSheet(courseId, sheetId);
    if (!sheet) throw new Error(`题集不存在: ${courseId}/${sheetId}`);
    sheet.lessons.push(lesson);
    this.writeSheet(courseId, sheet);
    return sheet;
  }

  // ============================================================
  // 文件：原卷 / 提交包 / 文本存档 / 人可读导出
  // ============================================================

  sourcePdfFile(courseId: string, sheetId: string): string {
    return join(this.sheetDir(courseId, sheetId), 'source.pdf');
  }

  sourceTextFile(courseId: string, sheetId: string): string {
    return join(this.sheetDir(courseId, sheetId), 'source.md');
  }

  submissionFile(courseId: string, sheetId: string, sheet?: Sheet): string {
    const name = sheet ? submissionFileName(courseId, sheet) : `${safeCourseId(courseId)}-${safeSheetId(sheetId)}-submission.pdf`;
    return join(this.sheetDir(courseId, sheetId), name);
  }

  /** 落盘原卷 PDF。返回写入字节数。 */
  writeSourcePdf(courseId: string, sheetId: string, bytes: Uint8Array): number {
    const dir = this.sheetDir(courseId, sheetId);
    this.ensureDir(dir);
    const file = this.sourcePdfFile(courseId, sheetId);
    writeFileSync(file, bytes);
    return bytes.byteLength;
  }

  /** 落盘 PDF 抽出的原文存档（用户可直接编辑，再重新拆题）。 */
  writeSourceText(courseId: string, sheetId: string, text: string): void {
    const dir = this.sheetDir(courseId, sheetId);
    this.ensureDir(dir);
    writeFileSync(this.sourceTextFile(courseId, sheetId), text, 'utf-8');
  }

  readSourceText(courseId: string, sheetId: string): string | null {
    const file = this.sourceTextFile(courseId, sheetId);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
  }

  /** 原卷 PDF 是否存在（决定提交包是否合并原卷）。 */
  hasSourcePdf(courseId: string, sheetId: string): boolean {
    const f = this.sourcePdfFile(courseId, sheetId);
    return existsSync(f) && statSync(f).size > 1024;
  }

  // ---------- 原卷页面截图（多模态读图 + 界面"原题截图"） ----------

  pagesDir(courseId: string, sheetId: string): string {
    return join(this.sheetDir(courseId, sheetId), 'pages');
  }

  pageImageFile(courseId: string, sheetId: string, page: number): string {
    return join(this.pagesDir(courseId, sheetId), pageImageName(page));
  }

  /** 落盘一页截图（JPEG）。返回写入字节数。 */
  writePageImage(courseId: string, sheetId: string, page: number, bytes: Uint8Array): number {
    const dir = this.pagesDir(courseId, sheetId);
    this.ensureDir(dir);
    writeFileSync(this.pageImageFile(courseId, sheetId, page), bytes);
    return bytes.byteLength;
  }

  /** 读一页截图（没有 → null）。 */
  readPageImage(courseId: string, sheetId: string, page: number): { bytes: Buffer; mediaType: 'image/jpeg' } | null {
    const file = this.pageImageFile(courseId, sheetId, page);
    if (!existsSync(file)) return null;
    try {
      return { bytes: readFileSync(file), mediaType: 'image/jpeg' };
    } catch {
      return null;
    }
  }

  /** 已经存了哪些页（升序页码）。 */
  listPageImages(courseId: string, sheetId: string): number[] {
    const dir = this.pagesDir(courseId, sheetId);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .map((f) => pageFromImageName(f))
        .filter((n) => n > 0)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  // ---------- 答案附图（手画示意图；检查/PDF 都带） ----------

  imagesDir(courseId: string, sheetId: string): string {
    return join(this.sheetDir(courseId, sheetId), 'images');
  }

  /** 图片文件名安全化（只留 `[A-Za-z0-9._-]`，防止 `../`）。 */
  imageFile(courseId: string, sheetId: string, name: string): string {
    const safe = basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
    return join(this.imagesDir(courseId, sheetId), safe);
  }

  writeImage(courseId: string, sheetId: string, name: string, bytes: Uint8Array): number {
    const dir = this.imagesDir(courseId, sheetId);
    this.ensureDir(dir);
    writeFileSync(this.imageFile(courseId, sheetId, name), bytes);
    return bytes.byteLength;
  }

  readImage(courseId: string, sheetId: string, name: string): { bytes: Buffer; mediaType: string } | null {
    const file = this.imageFile(courseId, sheetId, name);
    if (!existsSync(file)) return null;
    try {
      const ext = extname(file).toLowerCase();
      const mediaType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
      return { bytes: readFileSync(file), mediaType };
    } catch {
      return null;
    }
  }

  deleteImage(courseId: string, sheetId: string, name: string): boolean {
    const file = this.imageFile(courseId, sheetId, name);
    if (!existsSync(file)) return false;
    try {
      unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  /** 生成人可读的 markdown 导出（含题目/答案/检查结论/经验）。 */
  renderSheetMarkdown(course: CourseIndex, sheet: Sheet): string {
    const parts: string[] = [];
    parts.push(`---`);
    parts.push(`course: ${course.title}`);
    parts.push(`sheet: ${sheet.id}`);
    parts.push(`number: ${sheet.number}`);
    parts.push(`title: ${sheet.title}`);
    parts.push(`issued: ${sheet.issued}`);
    parts.push(`due: ${sheet.due}`);
    parts.push(`---`, '');
    parts.push(`# ${course.title} · Übungsblatt ${sheet.number}${sheet.title ? ` — ${sheet.title}` : ''}`, '');
    if (sheet.progress_digest) {
      parts.push('> **开这套题时的学习进度**', ...sheet.progress_digest.split('\n').map((l) => `> ${l}`), '');
    }
    for (const p of sheet.problems) {
      parts.push(`## ${p.label || p.id}${p.points != null ? `（${p.points} P）` : ''}`, '');
      if (p.title) parts.push(`**${p.title}**`, '');
      parts.push(p.text || '_(无题干)_', '');
      parts.push('### 解答', '');
      parts.push(p.answer || '_(未作答)_', '');
      const last = p.checks.filter((c) => !c.stale).at(-1);
      if (last) {
        parts.push(`### 检查（${last.verdict}${last.stale ? '，已过期' : ''}）`, '');
        // 手改过的 JSON 可能缺数组字段（用户只留了 verdict）→ 用 ?? [] 兜底，
        // 不要因为一个字段缺失让整个导出（以及 worldbook 同步）崩掉。
        for (const i of last.issues ?? []) parts.push(`- [${i.severity}] ${i.text}`);
        for (const h of last.hints ?? []) parts.push(`- 提示：${h}`);
        parts.push('');
      }
      if (p.notes) parts.push(`> 我的备注：${p.notes}`, '');
    }
    if (sheet.lessons.length) {
      parts.push('## 经验', '');
      for (const l of sheet.lessons) parts.push(`- ${l.text}`);
      parts.push('');
    }
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  /** 写人可读导出。返回绝对路径。 */
  writeSheetMarkdown(courseId: string, sheet: Sheet): string {
    const course = this.readIndex(courseId);
    if (!course) throw new Error(`课程不存在: ${courseId}`);
    const dir = this.sheetDir(courseId, sheet.id);
    this.ensureDir(dir);
    const file = join(dir, `${safeSheetId(sheet.id)}.md`);
    writeFileSync(file, this.renderSheetMarkdown(course, sheet), 'utf-8');
    return file;
  }

  /** 把整套题导出到 retriever 的 notesDir（单向、可选）。 */
  exportForRetrieval(courseId: string, sheet: Sheet, targetDir: string): string | null {
    try {
      const course = this.readIndex(courseId);
      if (!course) return null;
      const abs = isAbsolute(targetDir) ? targetDir : join(process.cwd(), targetDir);
      this.ensureDir(abs);
      const out = join(abs, `${safeCourseId(courseId)}-${safeSheetId(sheet.id)}.md`);
      writeFileSync(out, this.renderSheetMarkdown(course, sheet), 'utf-8');
      log(`已导出检索用题解: ${out}`);
      return out;
    } catch (e) {
      warn(`导出题解失败: ${(e as Error).message}`);
      return null;
    }
  }

  // ============================================================
  // 删除
  // ============================================================

  deleteSheet(courseId: string, sheetId: string): boolean {
    const index = this.readIndex(courseId);
    if (!index) return false;
    const i = index.sheets.findIndex((s) => s.id === safeSheetId(sheetId));
    if (i === -1) return false;
    rmSync(this.sheetDir(courseId, sheetId), { recursive: true, force: true });
    index.sheets.splice(i, 1);
    this.writeIndex(index);
    return true;
  }

  deleteCourse(courseId: string): boolean {
    if (!this.readIndex(courseId)) return false;
    rmSync(this.courseDir(courseId), { recursive: true, force: true });
    return true;
  }

  // ============================================================
  // 错题本（跨课程，根目录一个文件）
  //
  // 为什么单独一份而不是散在各 sheet 里：
  //   用户复习错题时不该先想"那是哪套作业的第几题" —— 错题本是**按主题/时间**看的。
  //   每条都带 course/sheet/problem 坐标，点一下能跳回原题。
  // ============================================================

  private mistakesFile(): string {
    return join(this.root, '_mistakes.json');
  }

  readMistakes(): Mistake[] {
    const file = this.mistakesFile();
    if (!existsSync(file)) return [];
    try {
      const data = this.readJson(file);
      if (!Array.isArray(data)) return [];
      const out: Mistake[] = [];
      for (const item of data) {
        const parsed = mistakeSchema.safeParse(item);
        if (parsed.success) out.push(parsed.data);
        else warn(`跳过无效错题条目: ${JSON.stringify(item).slice(0, 120)}`);
      }
      return out;
    } catch (e) {
      warn(`读错题本失败: ${(e as Error).message}`);
      return [];
    }
  }

  writeMistakes(list: readonly Mistake[]): void {
    this.ensureDir(this.root);
    this.writeJson(this.mistakesFile(), list);
  }

  /** 新增或按 id 覆盖（重复加入同一题不会产生两条：调用方传同一 id）。 */
  upsertMistake(m: Mistake): Mistake {
    const list = this.readMistakes();
    const i = list.findIndex((x) => x.id === m.id);
    if (i === -1) list.push(m);
    else list[i] = { ...list[i]!, ...m, created_at: list[i]!.created_at };
    list.sort((a, b) => b.created_at - a.created_at);
    this.writeMistakes(list);
    return m;
  }

  patchMistake(id: string, patch: Partial<Mistake>): Mistake | null {
    const list = this.readMistakes();
    const i = list.findIndex((x) => x.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i]!, ...patch, id: list[i]!.id, updated_at: Date.now() };
    this.writeMistakes(list);
    return list[i]!;
  }

  deleteMistake(id: string): boolean {
    const list = this.readMistakes();
    const next = list.filter((x) => x.id !== id);
    if (next.length === list.length) return false;
    this.writeMistakes(next);
    return true;
  }

  /** 同一题是否已有错题条目（按 course/sheet/problem 判，防止重复收集）。 */
  findMistakeFor(courseId: string, sheetId: string, problemId: string): Mistake | null {
    return this.readMistakes().find((m) => m.course_id === courseId && m.sheet_id === sheetId && m.problem_id === problemId) ?? null;
  }
}
