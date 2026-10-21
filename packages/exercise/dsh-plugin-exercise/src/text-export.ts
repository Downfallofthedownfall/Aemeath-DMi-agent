// ============================================================
// text-export.ts — 把整套习题库导出成**纯文本（markdown）**，专为 git 管理设计
//
// 用户要求：「加一个导出为文本的功能，这样方便 git 管理」。
//
// 设计取舍（都是为 diff 服务）：
//   · **确定性**：不写"导出于 <当前时间>"，不用随机量；同样的数据 → 同样的字节。
//     反复导出只会在你真的改了题/答案时产生 diff。
//   · **一题一段**：每题固定小节（题干 / 我的解答 / 备注 / 检查 / 错题），
//     顺序固定，答案原文保留（含 LaTeX），git 能看清改的是哪一行。
//   · **内容不变就不落盘**：先比字节，相同就跳过（避免 mtime 抖动、也不折腾编辑器）。
//   · **只清理自己写过的文件**：靠 `.manifest.json` 记住上次写了哪些；
//     套题删掉后下次导出会移除对应 md，**不会碰你手工放进这个目录的任何文件**。
//   · 头部带 `<!-- 自动生成，请勿手改 -->`：手改会在下次导出被覆盖。
//
// 目录结构：
//   <root>/README.md                 总览（课程表 + 用法说明）
//   <root>/mistakes.md               跨课程错题本
//   <root>/<course>/README.md        课程摘要 + 套题表
//   <root>/<course>/<sheet>.md       一套题的完整内容
//   <root>/.manifest.json            上次导出的文件清单（清理用）
//
// 纯函数部分（renderTextExport）不碰 fs → 可单测（test/check11.mjs）。
// ============================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute, relative, sep } from 'node:path';
import { sheetProgress, type CourseIndex, type Mistake, type Sheet } from './types.js';

export const EXPORT_MANIFEST = '.manifest.json';
export const EXPORT_HEADER = '<!-- 由 Aemeath 习题模式自动生成，请勿手改（下次导出会覆盖） -->';

export interface CourseSnapshot {
  index: CourseIndex;
  sheets: Sheet[];
}

export interface TextExportInput {
  courses: CourseSnapshot[];
  mistakes: Mistake[];
}

/** 渲染结果：相对路径 → 文件内容（纯函数，确定性）。 */
export type TextExportFiles = Map<string, string>;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 时间戳 → `YYYY-MM-DD`（本地时区；只在有值时用）。 */
function day(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 时间戳 → `YYYY-MM-DD HH:mm`。 */
function minute(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${day(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** markdown 表格单元格转义（`|` 会破坏表格）。 */
const cell = (s: string): string => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

/** 文件名安全化（课程/套题 id 已受限，但导出层再兜一层）。 */
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';

const VERDICT_LABEL: Record<string, string> = {
  correct: '正确',
  partial: '部分正确',
  wrong: '有错',
  unclear: '无法判定',
  error: '检查失败',
};

/** 渲染一套题（一题一段，顺序固定）。 */
export function renderSheetText(course: CourseIndex, sheet: Sheet, mistakes: readonly Mistake[]): string {
  const prog = sheetProgress(sheet);
  const out: string[] = [];
  out.push(EXPORT_HEADER);
  out.push('');
  out.push(`# ${course.title} · Übungsblatt ${sheet.number}${sheet.title ? ` — ${sheet.title}` : ''}`);
  out.push('');
  out.push('| 项 | 值 |');
  out.push('|---|---|');
  out.push(`| 课程 | ${cell(course.title)}（\`${course.course_id}\`） |`);
  out.push(`| 套题 | \`${sheet.id}\`（第 ${sheet.number} 套） |`);
  out.push(`| 布置 / 截止 | ${sheet.issued || '—'} / ${sheet.due || '—'} |`);
  out.push(`| 进度 | ${prog.answered}/${prog.total} 题有答案 · 检查通过 ${prog.checked} · 待修 ${prog.needsFix} |`);
  out.push(`| 切题方式 | ${sheet.split_by}${sheet.has_page_images ? '（含原卷截图）' : ''} |`);
  out.push(`| 提交 | ${sheet.submitted_at ? `${day(sheet.submitted_at)}（${sheet.submission_pages} 页）` : '未生成'} |`);
  out.push('');
  if (sheet.progress_digest) {
    out.push('## 开这套题时的学习进度');
    out.push('');
    for (const line of sheet.progress_digest.split('\n')) out.push(`> ${line}`);
    out.push('');
  }
  out.push('## 题目');
  out.push('');

  for (const p of sheet.problems) {
    out.push(`### ${p.label || p.id}${p.points != null ? `（${p.points} P）` : ''}`);
    out.push('');
    if (p.title) {
      out.push(`**${p.title}**`);
      out.push('');
    }
    out.push('**题干**');
    out.push('');
    out.push(p.text.trim() || '_（无题干）_');
    out.push('');
    out.push('**我的解答**');
    out.push('');
    out.push(p.answer.trim() || '_（未作答）_');
    out.push('');
    if (p.notes.trim()) {
      out.push('**备注**');
      out.push('');
      out.push(p.notes.trim());
      out.push('');
    }
    const checks = p.checks;
    if (checks.length) {
      out.push(`**检查记录**（${checks.length} 次）`);
      out.push('');
      for (const c of checks) {
        const stale = c.stale ? '（针对旧答案）' : '';
        out.push(`- ${minute(c.created_at)} · ${VERDICT_LABEL[c.verdict] ?? c.verdict}${stale}`);
        for (const i of c.issues ?? []) out.push(`  - [${i.severity}] ${i.text}`);
        for (const h of c.hints ?? []) out.push(`  - 提示：${h}`);
        for (const n of c.next_steps ?? []) out.push(`  - 下一步：${n}`);
      }
      out.push('');
    }
    const related = mistakes.filter((m) => m.problem_id === p.id && m.sheet_id === sheet.id && m.course_id === course.course_id);
    if (related.length) {
      out.push('**错题**');
      out.push('');
      for (const m of related) {
        out.push(`- ${m.mastered ? '已掌握' : '未掌握'}${m.in_worldbook ? ' · 已进知识库' : ''}：${m.lesson || m.issues[0] || '（无描述）'}`);
      }
      out.push('');
    }
  }

  if (sheet.lessons.length) {
    out.push('## 这套题教会我什么');
    out.push('');
    for (const l of sheet.lessons) out.push(`- ${l.text}${l.in_worldbook ? '（已进知识库）' : ''}`);
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** 渲染课程 README（套题表）。 */
export function renderCourseText(course: CourseIndex, sheets: readonly Sheet[]): string {
  const out: string[] = [];
  out.push(EXPORT_HEADER);
  out.push('');
  out.push(`# ${course.title}${course.semester ? `（${course.semester}）` : ''}`);
  out.push('');
  out.push(`课程标识：\`${course.course_id}\` · 共 ${sheets.length} 套`);
  out.push('');
  out.push('| 套 | 主题 | 截止 | 进度 | 文件 |');
  out.push('|---|---|---|---|---|');
  for (const s of [...sheets].sort((a, b) => a.number - b.number)) {
    const p = sheetProgress(s);
    out.push(
      `| ${s.number} | ${cell(s.title) || '—'} | ${s.due || '—'} | ${p.answered}/${p.total} | [${s.id}](./${s.id}.md) |`,
    );
  }
  out.push('');
  return `${out.join('\n').trimEnd()}\n`;
}

/** 渲染跨课程错题本（未掌握优先、更新时间倒序）。 */
export function renderMistakesText(mistakes: readonly Mistake[]): string {
  const out: string[] = [];
  out.push(EXPORT_HEADER);
  out.push('');
  const open = mistakes.filter((m) => !m.mastered);
  out.push(`# 错题本`);
  out.push('');
  out.push(`${mistakes.length} 条 · 未掌握 ${open.length} 条`);
  out.push('');
  const sorted = [...mistakes].sort((a, b) => Number(a.mastered) - Number(b.mastered) || b.updated_at - a.updated_at);
  if (!sorted.length) {
    out.push('_（还没有错题）_');
    out.push('');
    return `${out.join('\n').trimEnd()}\n`;
  }
  for (const m of sorted) {
    out.push(`## ${m.problem_label || m.problem_id} · ${m.sheet_title || m.sheet_id}（${m.course_id}）`);
    out.push('');
    out.push(`- 状态：${m.mastered ? '已掌握' : '未掌握'}${m.in_worldbook ? ' · 已进知识库' : ''}`);
    out.push(`- 结论：${VERDICT_LABEL[m.verdict] ?? m.verdict}`);
    out.push(`- 记录：${minute(m.created_at)}${m.updated_at && m.updated_at !== m.created_at ? `（更新 ${minute(m.updated_at)}）` : ''}`);
    if (m.tags.length) out.push(`- 标签：${m.tags.join('、')}`);
    if (m.issues.length) {
      out.push('- 问题：');
      for (const i of m.issues) out.push(`  - ${i}`);
    }
    if (m.lesson) out.push(`- 教训：${m.lesson}`);
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** 渲染总览 README。 */
export function renderIndexText(courses: readonly CourseSnapshot[], mistakes: readonly Mistake[]): string {
  const out: string[] = [];
  out.push(EXPORT_HEADER);
  out.push('');
  out.push('# 习题（Übungen）文本导出');
  out.push('');
  out.push('这个目录是**自动导出**的纯文本镜像，专门用来做 git 管理：');
  out.push('');
  out.push('- 每次导出都是**确定性**的：内容没变就不会产生 diff；');
  out.push('- 一题一段（题干 / 我的解答 / 备注 / 检查 / 错题），答案保留原始 LaTeX；');
  out.push('- 删除套题后重新导出会移除对应 `.md`（只清理导出器自己写过的文件）。');
  out.push('');
  out.push('> ⚠️ 手改这里的文件会在下次导出时被覆盖 —— 要改内容请回到习题界面（或直接改 `sheet.json`）。');
  out.push('');
  out.push('## 课程');
  out.push('');
  const totalSheets = courses.reduce((n, c) => n + c.sheets.length, 0);
  out.push(`共 ${courses.length} 门课 / ${totalSheets} 套题 / ${mistakes.length} 条错题。`);
  out.push('');
  out.push('| 课程 | 套数 | 已提交 | 未掌握错题 |');
  out.push('|---|---|---|---|');
  for (const c of [...courses].sort((a, b) => a.index.course_id.localeCompare(b.index.course_id))) {
    const submitted = c.sheets.filter((s) => s.submitted_at).length;
    const openMistakes = mistakes.filter((m) => m.course_id === c.index.course_id && !m.mastered).length;
    out.push(
      `| [${cell(c.index.title)}](./${safe(c.index.course_id)}/README.md) | ${c.sheets.length} | ${submitted} | ${openMistakes} |`,
    );
  }
  out.push('');
  out.push('另见：[错题本](./mistakes.md)');
  out.push('');
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * 渲染整个导出（纯函数）。
 *
 * 路径约定：`README.md` / `mistakes.md` / `<course>/README.md` / `<course>/<sheet>.md`
 */
export function renderTextExport(input: TextExportInput): TextExportFiles {
  const files: TextExportFiles = new Map();
  files.set('README.md', renderIndexText(input.courses, input.mistakes));
  files.set('mistakes.md', renderMistakesText(input.mistakes));
  for (const c of input.courses) {
    const dir = safe(c.index.course_id);
    files.set(`${dir}/README.md`, renderCourseText(c.index, c.sheets));
    for (const s of [...c.sheets].sort((a, b) => a.number - b.number)) {
      files.set(`${dir}/${safe(s.id)}.md`, renderSheetText(c.index, s, input.mistakes));
    }
  }
  return files;
}

export interface SyncResult {
  dir: string;
  written: string[];
  unchanged: string[];
  removed: string[];
}

/** 读上次的 manifest（坏文件当作空）。 */
export function readManifest(rootDir: string): string[] {
  const file = join(rootDir, EXPORT_MANIFEST);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { files?: unknown };
    return Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 把渲染结果同步到磁盘。
 *
 * @param rootDir 绝对路径（调用方负责解析配置里的相对路径）
 * @returns 写了哪些、哪些没变、删了哪些（给界面/工具回显）
 */
export function syncTextExport(rootDir: string, files: TextExportFiles): SyncResult {
  const root = isAbsolute(rootDir) ? rootDir : join(process.cwd(), rootDir);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  const previous = readManifest(root);
  const written: string[] = [];
  const unchanged: string[] = [];

  for (const [rel, content] of files) {
    const abs = join(root, rel);
    const dir = dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(abs)) {
      try {
        if (readFileSync(abs, 'utf-8') === content) {
          unchanged.push(rel);
          continue;
        }
      } catch {
        /* 读不了就当需要重写 */
      }
    }
    writeFileSync(abs, content, 'utf-8');
    written.push(rel);
  }

  // 只清理"上次导出写过、这次不再产出"的文件
  const removed: string[] = [];
  for (const rel of previous) {
    if (files.has(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    // 防越界：只删 root 里的文件
    if (relative(root, abs).startsWith('..')) continue;
    try {
      rmSync(abs, { force: true });
      removed.push(rel);
    } catch {
      /* 删不掉就留着，不影响导出 */
    }
  }

  // 清掉空目录（只往下删一层，避免误删深层结构）
  for (const dir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const abs = join(root, dir.name);
    try {
      if (readdirSync(abs).length === 0) rmSync(abs, { recursive: false, force: true });
    } catch {
      /* ignore */
    }
  }

  writeFileSync(
    join(root, EXPORT_MANIFEST),
    `${JSON.stringify({ version: 1, files: [...files.keys()].sort() }, null, 2)}\n`,
    'utf-8',
  );

  return {
    dir: root.split(sep).join('/'),
    written: written.sort(),
    unchanged: unchanged.sort(),
    removed: removed.sort(),
  };
}
