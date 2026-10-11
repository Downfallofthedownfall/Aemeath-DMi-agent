// ============================================================
// store.ts — Lecture Mode 文件存储（D6：markdown 为主 + JSON 索引）
//
// 设计要点（docs/lecture-mode-plan.md §4）：
//   · 数据目录 packages/library/physicist/lectures/<course_id>/
//     （D11：放 physicist 里 → retriever 可直接消费）
//   · 单次课堂记录 = 人可读可 diff 的 .md（`## ` 二级标题分块，≤2000 字符）
//     —— 复用 retriever 的 chunker 规则，课后丢进 notesDir 即可被检索
//   · 课程索引 = index.json
//   · 后端加工结果 = 独立 .raw.json（**前端不读**，D3）
//   · 复盘产物 = .summary.json / .candidates.json
//
// 本模块是**纯文件层**：不依赖 dsh，可直接单测。
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  courseIndexSchema,
  processingSchema,
  candidatesSchema,
  reviewStateSchema,
  renderFrontMatter,
  parseFrontMatter,
  parseShorthand,
  splitChunks,
  missingBlanks,
  type CourseIndex,
  type UnitMeta,
  type LectureFrontMatter,
  type ProcessingRecord,
  type Candidates,
  type ReviewState,
  type RawChunk,
} from './types.js';

function log(msg: string): void {
  console.log(`[aemeath-lecture] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[aemeath-lecture] ⚠ ${msg}`);
}

/**
 * id 净化：只允许安全字符，且**折叠掉任何点号序列**。
 *
 * 安全要点（course_id / unit_id 会拼进文件路径，且来源含 LLM 输出 = 不可信）：
 *   · 斜杠与反斜杠 → `-`（阻止跨目录）
 *   · 任何 `.` 序列整体删除 —— 而不只是去首尾：
 *     否则 `u03/../../x` 会先变成 `u03-..-..-x`，留下 `..` 片段。
 *     虽然它已是单一路径段（不构成穿越），但保留点号是不必要的风险面，
 *     且会让同名单元产生意外碰撞。这里直接删干净。
 *   · 长度截断，避免超长文件名。
 */
function sanitizeId(id: string, maxLen: number): string {
  return id
    .trim()
    .replace(/[\\/]+/g, '-') // 路径分隔符
    .replace(/[^A-Za-z0-9._-]+/g, '-') // 白名单
    .replace(/\.+/g, '') // 点号一律删除（含 .. / ... / .）
    .replace(/-{2,}/g, '-') // 折叠连续连字符（上一步删点后会留下 -- / ---）
    .replace(/^-+|-+$/g, '') // 去首尾连字符
    .slice(0, maxLen)
    .replace(/-+$/g, ''); // 截断后可能又出现尾连字符，再去一次
}

/** 课程 id 只允许安全字符（防目录穿越——course_id 来自用户/LLM，不可信）。 */
export function safeCourseId(id: string): string {
  return sanitizeId(id.toLowerCase(), 64);
}

/** 单元 id 同样净化（用于文件名，必须防穿越）。 */
export function safeUnitId(id: string): string {
  return sanitizeId(id, 64) || 'unit';
}

export interface StoreOptions {
  /** 数据根目录（相对仓库根或绝对路径）。 */
  rootDir: string;
}

export class LectureStore {
  private readonly root: string;

  constructor(opts: StoreOptions) {
    this.root = isAbsolute(opts.rootDir) ? opts.rootDir : join(process.cwd(), opts.rootDir);
  }

  /** 数据根目录（绝对）。 */
  get rootPath(): string {
    return this.root;
  }

  /** 某课程目录（绝对）。 */
  courseDir(courseId: string): string {
    return join(this.root, safeCourseId(courseId));
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /**
   * 读 JSON 文件并解析，**容忍 UTF-8 BOM**。
   *
   * 为什么必须处理 BOM：这些 JSON 是"人可手改"的文件（D6 的设计目标之一），
   * 而 Windows 记事本 / PowerShell 的 `Set-Content -Encoding utf8` 默认**写 BOM**。
   * 带 BOM 的文本交给 `JSON.parse` 会直接抛 "Unexpected token ''"，
   * 表现为"文件明明在，课程却读不出来"——极难自查。
   * 真机实测踩到过（用手工造的数据验证 HTTP 端点时）。
   */
  private readJson(file: string): unknown {
    const raw = readFileSync(file, 'utf-8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  }

  /** 列出全部课程 id（无索引文件不算课程）。 */
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

  /** 读课程索引；不存在/畸形 → null。 */
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

  /** 写课程索引（原子性由调用方保证顺序；此处直接覆盖）。 */
  writeIndex(index: CourseIndex): void {
    const dir = this.courseDir(index.course_id);
    this.ensureDir(dir);
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
  }

  /** 新建课程（已存在则原样返回，幂等）。 */
  ensureCourse(courseId: string, title: string, semester = '', moduleCode = ''): CourseIndex {
    const existing = this.readIndex(courseId);
    if (existing) return existing;
    const index: CourseIndex = {
      version: 1,
      course_id: safeCourseId(courseId),
      title,
      semester,
      module_code: moduleCode,
      units: [],
    };
    this.writeIndex(index);
    log(`课程已创建: ${index.course_id}（${title}）`);
    return index;
  }

  /** 新增/更新一个单元元数据（按 id 去重）。 */
  upsertUnit(courseId: string, unit: UnitMeta): CourseIndex {
    const index = this.readIndex(courseId);
    if (!index) throw new Error(`课程不存在: ${courseId}`);
    const i = index.units.findIndex((u) => u.id === unit.id);
    if (i === -1) index.units.push(unit);
    else index.units[i] = { ...index.units[i], ...unit };
    this.writeIndex(index);
    return index;
  }

  /** 标记单元已复盘 / 已生成摘要（D4 门控字段）。 */
  markUnit(courseId: string, unitId: string, patch: { reviewed?: boolean; has_summary?: boolean }): CourseIndex {
    const index = this.readIndex(courseId);
    if (!index) throw new Error(`课程不存在: ${courseId}`);
    const unit = index.units.find((u) => u.id === unitId);
    if (!unit) throw new Error(`单元不存在: ${unitId}`);
    if (patch.reviewed !== undefined) unit.reviewed = patch.reviewed;
    if (patch.has_summary !== undefined) unit.has_summary = patch.has_summary;
    this.writeIndex(index);
    return index;
  }

  // ============================================================
  // 课堂记录 markdown
  // ============================================================

  unitFile(courseId: string, unit: UnitMeta): string {
    return join(this.courseDir(courseId), unit.file);
  }

  /**
   * 渲染课堂记录的 markdown 正文。
   *
   * 结构：front-matter → 每块一个 `## ` 小节（用户原始速记）+ 强制留白。
   * **不含任何 LLM 加工结果**——加工结果写 .raw.json（D3）。
   */
  renderUnitMarkdown(fm: LectureFrontMatter, chunks: readonly RawChunk[]): string {
    const parts: string[] = [renderFrontMatter(fm), ''];
    for (const c of chunks) {
      const lines = parseShorthand(c.raw);
      // 用块内第一个 topic 作小节标题；没有则用序号
      const topicLine = lines.find((l) => l.kind === 'topic');
      const title = topicLine?.text || `速记块 ${c.seq + 1}`;
      parts.push(`## ${title}`, '');
      for (const l of lines) {
        if (l.kind === 'topic') continue; // 已作标题
        if (!l.text) continue;
        const prefix = { formula: '= ', question: '? ', keypoint: '! ', example: '> ' }[l.kind as string] ?? '';
        parts.push(`${prefix}${l.text}`);
      }
      parts.push('');
      // 强制留白（D3）：始终写出标签，未填则留空——便于复盘时定位
      parts.push(`[我的理解] ${c.my_understanding}`.trimEnd());
      parts.push(`[我的疑问] ${c.my_question}`.trimEnd());
      parts.push('');
    }
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  /** 写课堂记录 markdown。 */
  writeUnitMarkdown(courseId: string, unit: UnitMeta, fm: LectureFrontMatter, chunks: readonly RawChunk[]): string {
    const dir = this.courseDir(courseId);
    this.ensureDir(dir);
    const file = this.unitFile(courseId, unit);
    writeFileSync(file, this.renderUnitMarkdown(fm, chunks), 'utf-8');
    return file;
  }

  /** 读课堂记录 markdown（原文；解析交给调用方或 parseUnitMarkdown）。 */
  readUnitMarkdown(courseId: string, unit: UnitMeta): string | null {
    const file = this.unitFile(courseId, unit);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf-8');
    } catch (e) {
      warn(`读课堂记录失败（${unit.file}）: ${(e as Error).message}`);
      return null;
    }
  }

  // ============================================================
  // 后端加工结果（D3：前端不读）
  // ============================================================

  private processingFile(courseId: string, unitId: string): string {
    return join(this.courseDir(courseId), `${safeUnitId(unitId)}.raw.json`);
  }

  writeProcessing(courseId: string, rec: ProcessingRecord): void {
    this.ensureDir(this.courseDir(courseId));
    writeFileSync(this.processingFile(courseId, rec.unit_id), JSON.stringify(rec, null, 2), 'utf-8');
  }

  readProcessing(courseId: string, unitId: string): ProcessingRecord | null {
    const file = this.processingFile(courseId, unitId);
    if (!existsSync(file)) return null;
    try {
      const parsed = processingSchema.safeParse(this.readJson(file));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  // ============================================================
  // 复盘产物（D4：复盘完成后才有）
  // ============================================================

  private summaryFile(courseId: string, unitId: string): string {
    return join(this.courseDir(courseId), `${safeUnitId(unitId)}.summary.json`);
  }

  private candidatesFile(courseId: string, unitId: string): string {
    return join(this.courseDir(courseId), `${safeUnitId(unitId)}.candidates.json`);
  }

  private reviewFile(courseId: string, unitId: string): string {
    return join(this.courseDir(courseId), `${safeUnitId(unitId)}.review.json`);
  }

  writeCandidates(courseId: string, c: Candidates): void {
    this.ensureDir(this.courseDir(courseId));
    writeFileSync(this.candidatesFile(courseId, c.unit_id), JSON.stringify(c, null, 2), 'utf-8');
  }

  readCandidates(courseId: string, unitId: string): Candidates | null {
    const file = this.candidatesFile(courseId, unitId);
    if (!existsSync(file)) return null;
    try {
      const parsed = candidatesSchema.safeParse(this.readJson(file));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** 结构化摘要（复盘第 4 步之后才写，D4）。 */
  writeSummary(courseId: string, unitId: string, summary: { text: string; created_at: number; model: string }): void {
    this.ensureDir(this.courseDir(courseId));
    writeFileSync(this.summaryFile(courseId, unitId), JSON.stringify(summary, null, 2), 'utf-8');
  }

  hasSummary(courseId: string, unitId: string): boolean {
    return existsSync(this.summaryFile(courseId, unitId));
  }

  /**
   * 删除摘要。
   *
   * 为什么需要：`hasSummary` 只看文件存在性，而 `UnitMeta.has_summary` 是
   * 独立落盘的标志位。若没有删除路径，两者会永久不一致——
   * 手动删了 summary.json 而 index.json 仍写着 has_summary: true，
   * 握手就会导出一个指向不存在文件的 summary_ref。
   *
   * 调用方负责同时更新 UnitMeta（本层不碰索引，保持单一职责）。
   */
  clearSummary(courseId: string, unitId: string): boolean {
    try {
      const f = this.summaryFile(courseId, unitId);
      if (!existsSync(f)) return false;
      rmSync(f, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** 复盘状态机持久化（可中断续做）。 */
  writeReviewState(courseId: string, st: ReviewState): void {
    this.ensureDir(this.courseDir(courseId));
    writeFileSync(this.reviewFile(courseId, st.unit_id), JSON.stringify(st, null, 2), 'utf-8');
  }

  readReviewState(courseId: string, unitId: string): ReviewState | null {
    const file = this.reviewFile(courseId, unitId);
    if (!existsSync(file)) return null;
    try {
      const parsed = reviewStateSchema.safeParse(this.readJson(file));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** 删除某单元的复盘中间态（不删课堂记录本身）。 */
  clearReviewState(courseId: string, unitId: string): void {
    const file = this.reviewFile(courseId, unitId);
    if (existsSync(file)) rmSync(file, { force: true });
  }

  // ============================================================
  // 检索友好：把课堂记录导出为 retriever 可消费的 markdown
  // ============================================================

  /**
   * 导出为「讲义格式」markdown（`## ` 分块 ≤2000 字符），供 retriever 检索。
   * 返回写入的绝对路径，或 null（无内容/失败）。
   *
   * 用途：复盘完成后把该讲内容并入 `notesDir`，让主 agent 能检索到。
   * 注意：这是**单向导出**，不修改 lecture 自身存储。
   */
  exportForRetrieval(courseId: string, unit: UnitMeta, targetDir: string): string | null {
    const md = this.readUnitMarkdown(courseId, unit);
    if (!md) return null;
    try {
      const abs = isAbsolute(targetDir) ? targetDir : join(process.cwd(), targetDir);
      this.ensureDir(abs);
      const out = join(abs, `${safeCourseId(courseId)}-${safeUnitId(unit.id)}.md`);
      writeFileSync(out, md, 'utf-8');
      log(`已导出检索用讲义: ${out}`);
      return out;
    } catch (e) {
      warn(`导出讲义失败: ${(e as Error).message}`);
      return null;
    }
  }
}

/**
 * 从 markdown 正文重建块序列（供复盘读取强制留白）。
 * 与 renderUnitMarkdown 对称：`## ` 小节 = 一个块，`[我的理解]`/`[我的疑问]` 为留白字段。
 */
export function parseUnitMarkdown(md: string): { front: Record<string, string>; chunks: RawChunk[] } {
  const { front, body } = parseFrontMatter(md);
  const sections = body.split(/^##\s+/m).slice(1); // [0] 是首个 ## 之前的内容
  const chunks: RawChunk[] = [];
  sections.forEach((sec, i) => {
    const nl = sec.indexOf('\n');
    const title = nl === -1 ? sec.trim() : sec.slice(0, nl).trim();
    const content = nl === -1 ? '' : sec.slice(nl + 1);
    const understanding = /\[我的理解\]\s*([\s\S]*?)(?=\[我的疑问\]|$)/.exec(content)?.[1]?.trim() ?? '';
    const question = /\[我的疑问\]\s*([\s\S]*?)$/.exec(content)?.[1]?.trim() ?? '';
    // 去掉留白标签行，剩下的是速记正文；把标题还原成 `# ` 主题行
    const bodyLines = content
      .split(/\r?\n/)
      .filter((l) => !/^\s*\[我的(理解|疑问)\]/.test(l))
      .join('\n')
      .trim();
    const raw = [`# ${title}`, bodyLines].filter(Boolean).join('\n');
    chunks.push({ seq: i, raw, my_understanding: understanding, my_question: question, created_at: 0 });
  });
  return { front, chunks };
}

/** 校验一个块是否满足强制留白（复盘/提交前的门）。 */
export function chunkBlanksOk(chunk: RawChunk): { ok: boolean; missing: string[] } {
  const text = `[我的理解] ${chunk.my_understanding}\n[我的疑问] ${chunk.my_question}`;
  const missing = missingBlanks(text);
  return { ok: missing.length === 0, missing };
}

/** 全部块是否都填了留白。 */
export function allBlanksOk(chunks: readonly RawChunk[]): { ok: boolean; badSeqs: number[] } {
  const bad = chunks.filter((c) => !chunkBlanksOk(c).ok).map((c) => c.seq);
  return { ok: bad.length === 0, badSeqs: bad };
}

/** 导出块的块数（供 UI 显示进度）。 */
export function chunkCount(raw: string): number {
  return splitChunks(parseShorthand(raw)).length;
}
