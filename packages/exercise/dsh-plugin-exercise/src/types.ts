// ============================================================
// types.ts — Übungen（习题）模块的公共类型 + 纯函数
//
// 设计依据：docs/exercise-mode-plan.md
//   D1 习题 = lecture 的姊妹模块（同一套文件存储/前端语言/握手）
//   D2 数据目录 packages/library/physicist/exercises/（retriever 可直接消费）
//   D3 LLM 检查**只能手动触发**（没有"自动判题"——判错会毁掉学习闭环）
//   D4 答案始终可改；每次改 → 已有检查结果标记 stale（不删除历史）
//   D5 错题/经验落 worldbook（physicist 馆）+ 本地错题本
//   D6 提交物 = 原卷 + 解答合成的一个 PDF（LaTeX 公式必须真渲染）
//
// 本文件是**纯类型 + 纯函数**：不碰 fs、不碰 dsh，可直接单测（client 也能读）。
// ============================================================

import { z } from 'zod';

// ============================================================
// 题目
// ============================================================

/** 题目状态（由答案与检查结果派生，见 problemStatus）。 */
export type ProblemStatus = 'todo' | 'draft' | 'answered' | 'checked' | 'needs_fix' | 'done';

export const PROBLEM_STATUSES: readonly ProblemStatus[] = ['todo', 'draft', 'answered', 'checked', 'needs_fix', 'done'];

/** 检查结论（LLM 给的判定；`unclear` = 看不清/信息不足，`error` = 调用失败）。 */
export type Verdict = 'correct' | 'partial' | 'wrong' | 'unclear' | 'error';

export const checkIssueSchema = z.object({
  severity: z.enum(['error', 'warn', 'info']).default('warn'),
  text: z.string(),
});
export type CheckIssue = z.infer<typeof checkIssueSchema>;

/**
 * 一次 LLM 检查记录。
 *
 * ⚠️ 追加式（append-only）：用户改答案后**不删除**旧检查，只把 `stale` 置真。
 *    为什么：错题本要能回答"当时我是怎么错的"，删掉历史就只剩最后一次。
 */
export const checkSchema = z.object({
  id: z.string(),
  created_at: z.number(),
  model: z.string().default(''),
  verdict: z.enum(['correct', 'partial', 'wrong', 'unclear', 'error']).default('unclear'),
  /** 模型自评的正确度 0..1（仅供参考，不参与任何自动判定）。 */
  score: z.number().nullable().default(null),
  issues: z.array(checkIssueSchema).default([]),
  /** 苏格拉底式提示（不直接给答案）。 */
  hints: z.array(z.string()).default([]),
  /** 关键步骤补全（仅在用户已经给出思路时给出——见 checker.ts 的 prompt 约束）。 */
  next_steps: z.array(z.string()).default([]),
  /** 模型原文（排障用；UI 默认折叠）。 */
  raw: z.string().default(''),
  /** 检查时的答案指纹：答案一变，本次检查即过期。 */
  answer_sha: z.string().default(''),
  stale: z.boolean().default(false),
  /** 实际用的 provider / model（老数据为空；界面显示"谁批的"） */
  provider: z.string().default(''),
  /** 这次检查是否开了推理（off = 关；空 = 未知/老数据） */
  reasoning: z.string().default(''),
  /** 被答辩撤回的 issue 下标（0 基），UI 上划掉 */
  withdrawn: z.array(z.number().int()).default([]),
  /** 答辩后仍成立的问题（覆盖 issues 的展示） */
  remaining: z.array(checkIssueSchema).default([]),
  /** 是否已被答辩（conceded/upheld/partial 之后为 true） */
  rebutted_at: z.number().default(0),
});
export type Check = z.infer<typeof checkSchema>;

export const rebuttalSchema = z.object({
  id: z.string(),
  created_at: z.number(),
  /** 学生这一轮说了什么 */
  user_text: z.string().default(''),
  /** 爱弥斯的回复 */
  reply: z.string().default(''),
  outcome: z.enum(['conceded', 'upheld', 'partial']).default('partial'),
  /** 被撤回的 issue 下标（相对当时的 check.issues） */
  withdrawn: z.array(z.number().int()).default([]),
  /** 你认为答案里对的部分 */
  correct_parts: z.array(z.string()).default([]),
  /** 仍然坚持的问题 */
  remaining: z.array(checkIssueSchema).default([]),
  /** 指向哪次检查（checks[].id） */
  check_id: z.string().default(''),
  model: z.string().default(''),
});
export type Rebuttal = z.infer<typeof rebuttalSchema>;

/** 答案里附的图片（手画示意图/草图；检查与提交 PDF 都会带上）。 */
export const problemImageSchema = z.object({
  id: z.string(),
  /** 落盘文件名（`img-<ts>-<rand>.jpg`） */
  name: z.string(),
  media_type: z.string().default('image/jpeg'),
  /** 原始字节数（界面显示/限制用） */
  bytes: z.number().default(0),
  /** 一句话说明（可选，比如"受力图"） */
  caption: z.string().default(''),
  /** 这张图属于哪边：answer=我的解答（默认）；problem=题干/题目截图 */
  role: z.enum(['answer', 'problem']).default('answer'),
  created_at: z.number().default(0),
});
export type ProblemImage = z.infer<typeof problemImageSchema>;

export const problemSchema = z.object({
  /** 稳定 id（`p01`…），作为文件名/键使用 */
  id: z.string(),
  /** 原始题号标签（`Aufgabe 1` / `1a`），保留原样便于对照原卷 */
  label: z.string().default(''),
  /** 标题（题干首行，截断；可编辑） */
  title: z.string().default(''),
  /** 题干（markdown + `$...$`；可编辑——PDF 抽不干净时用户手补） */
  text: z.string().default(''),
  /** 分值（可选） */
  points: z.number().nullable().default(null),
  /** 原 PDF 页码（1 基；0 = 未知） */
  page: z.number().default(0),
  /** 这题带插图/示意图（多模态读图判定；界面据此提示"看原卷截图"） */
  has_figure: z.boolean().default(false),
  /** 插图的一句话描述（多模态读图时由模型给出） */
  figure_note: z.string().default(''),
  /** 用户答案（markdown + 公式；**始终可改**，D4） */
  answer: z.string().default(''),
  answer_updated_at: z.number().default(0),
  /** 最后一次写入者：用户自己写 vs 让 agent 代笔（可追溯） */
  answer_edited_by: z.enum(['user', 'agent']).default('user'),
  checks: z.array(checkSchema).default([]),
  /** 答案附图（手画示意图；检查时随多模态发给模型，PDF 也会印） */
  images: z.array(problemImageSchema).default([]),
  /** 答辩历史（追加式；学生质疑批改时用） */
  rebuttals: z.array(rebuttalSchema).default([]),
  /** 关联的错题 id（错题本） */
  mistakes: z.array(z.string()).default([]),
  /** 用户自己的备注（"这题我老忘方向"），与 LLM 检查分开 */
  notes: z.string().default(''),
});
export type Problem = z.infer<typeof problemSchema>;

// ============================================================
// 经验条目（这道/这一套题教会我什么）
// ============================================================

export const lessonSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** 主题标签（由 LLM 或用户给；用于错题本筛选与 worldbook triggers） */
  tags: z.array(z.string()).default([]),
  source: z.enum(['llm', 'user']).default('llm'),
  created_at: z.number(),
  /** 是否已经同步进 worldbook（避免重复写） */
  in_worldbook: z.boolean().default(false),
});
export type Lesson = z.infer<typeof lessonSchema>;

// ============================================================
// 一套 Übung（一张作业）
// ============================================================

export const sheetSchema = z.object({
  /** `ub01`（排序友好） */
  id: z.string(),
  number: z.number().default(1),
  title: z.string().default(''),
  issued: z.string().default(''),
  due: z.string().default(''),
  /** 原卷 PDF 文件名（相对 sheet 目录；空 = 纯手填） */
  source_pdf: z.string().default(''),
  source_pages: z.number().default(0),
  /** 导入方式：pdf = 从 PDF 抽文本；manual = 用户手填 */
  import_mode: z.enum(['pdf', 'manual']).default('manual'),
  /** 题目是怎么切出来的：vision = 多模态读图；llm = 文本锚点；rules = 规则兜底；manual = 手填/手拆（排障用） */
  split_by: z.enum(['vision', 'llm', 'rules', 'manual']).default('rules'),
  /** 是否存了原卷页面截图（pages/page-NN.jpg）—— 有图就能看原题、也能给多模态检查用 */
  has_page_images: z.boolean().default(false),
  imported_at: z.number().default(0),
  /** PDF 抽不出有效文本（扫描件/纯公式）→ UI 提示手补题干 */
  needs_manual_text: z.boolean().default(false),
  /**
   * 开这一套题时给的用户学习进度摘要（D7：新开 Übung 必须附上）。
   * 内容 = 上次做到哪 + 错题集中未掌握的项 + 近期检查结论分布。
   */
  progress_digest: z.string().default(''),
  progress_digest_at: z.number().default(0),
  problems: z.array(problemSchema).default([]),
  lessons: z.array(lessonSchema).default([]),
  /** 提交包生成时间（0 = 未生成） */
  submitted_at: z.number().default(0),
  submission_pdf: z.string().default(''),
  submission_pages: z.number().default(0),
  /** 数据版本，便于将来迁移 */
  version: z.number().default(1),
});
export type Sheet = z.infer<typeof sheetSchema>;

// ============================================================
// 课程索引
// ============================================================

export const sheetMetaSchema = z.object({
  id: z.string(),
  number: z.number().default(1),
  title: z.string().default(''),
  issued: z.string().default(''),
  due: z.string().default(''),
  problem_count: z.number().default(0),
  answered_count: z.number().default(0),
  checked_count: z.number().default(0),
  wrong_count: z.number().default(0),
  submitted: z.boolean().default(false),
  import_mode: z.enum(['pdf', 'manual']).default('manual'),
});
export type SheetMeta = z.infer<typeof sheetMetaSchema>;

export const courseIndexSchema = z.object({
  version: z.literal(1),
  course_id: z.string(),
  title: z.string(),
  semester: z.string().default(''),
  module_code: z.string().default(''),
  sheets: z.array(sheetMetaSchema).default([]),
});
export type CourseIndex = z.infer<typeof courseIndexSchema>;

export function emptyCourseIndex(courseId: string, title: string, semester = '', moduleCode = ''): CourseIndex {
  return { version: 1, course_id: courseId, title, semester, module_code: moduleCode, sheets: [] };
}

// ============================================================
// 错题本（跨课程汇总；独立文件 `_mistakes.json`）
// ============================================================

export const mistakeSchema = z.object({
  id: z.string(),
  course_id: z.string().default(''),
  course_title: z.string().default(''),
  sheet_id: z.string().default(''),
  sheet_title: z.string().default(''),
  sheet_due: z.string().default(''),
  problem_id: z.string().default(''),
  problem_label: z.string().default(''),
  problem_text: z.string().default(''),
  /** 出错时的答案快照（用户后来改对了也保留——这才是"错题"） */
  answer: z.string().default(''),
  verdict: z.enum(['correct', 'partial', 'wrong', 'unclear', 'error']).default('wrong'),
  issues: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  /** 这题教会我什么（用户/LLM 可编辑，同步 worldbook 的就是它） */
  lesson: z.string().default(''),
  created_at: z.number(),
  updated_at: z.number(),
  review_count: z.number().default(0),
  mastered: z.boolean().default(false),
  in_worldbook: z.boolean().default(false),
  source_check_id: z.string().default(''),
});
export type Mistake = z.infer<typeof mistakeSchema>;

// ============================================================
// 纯函数：状态派生
// ============================================================

/**
 * 题目状态。
 *
 * 语义（刻意简单，便于界面用同一套规则着色）：
 *   todo      — 没答案
 *   draft     — 有答案但用户还没标"写完了"（答案不完整也照存）
 *   answered  — 有答案，未检查
 *   checked   — 最近一次检查是 correct（且不过期）
 *   needs_fix — 最近一次检查是 wrong/partial（且不过期）
 *   done      — 检查 correct 后用户手动定稿（或提交后）
 */
export function problemStatus(p: Pick<Problem, 'answer' | 'checks' | 'notes'>): ProblemStatus {
  const answer = (p.answer ?? '').trim();
  if (!answer) return 'todo';
  const last = lastFreshCheck(p.checks);
  if (!last) return p.answer.length > 0 ? 'answered' : 'draft';
  if (last.verdict === 'correct') return 'checked';
  if (last.verdict === 'wrong' || last.verdict === 'partial') return 'needs_fix';
  return 'answered';
}

/** 最近一次**未过期**的检查（按时间倒序找）。 */
export function lastFreshCheck(checks: readonly Check[]): Check | null {
  for (let i = checks.length - 1; i >= 0; i--) {
    const c = checks[i]!;
    if (!c.stale) return c;
  }
  return null;
}

export function lastCheck(checks: readonly Check[]): Check | null {
  return checks.length ? checks[checks.length - 1]! : null;
}

/** 一套题的进度汇总（UI 顶栏/索引卡片用）。 */
export interface SheetProgress {
  total: number;
  answered: number;
  checked: number;
  needsFix: number;
  wrong: number;
  /** 0..100，按"已答 + 已检查通过"折算 */
  percent: number;
}

export function sheetProgress(sheet: Pick<Sheet, 'problems'>): SheetProgress {
  const total = sheet.problems.length;
  let answered = 0;
  let checked = 0;
  let needsFix = 0;
  for (const p of sheet.problems) {
    const st = problemStatus(p);
    if (st !== 'todo') answered++;
    if (st === 'checked' || st === 'done') checked++;
    if (st === 'needs_fix') needsFix++;
  }
  const percent = total === 0 ? 0 : Math.round(((answered + checked) / (total * 2)) * 100);
  return { total, answered, checked, needsFix, wrong: needsFix, percent };
}

// ============================================================
// 纯函数：答案/题干微调
// ============================================================

/** 规范化答案文本（用于指纹与比较，不改用户原文存储）。 */
export function normalizeAnswer(text: string): string {
  return (text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 题干首行 → 标题（截断）。 */
export function deriveTitle(text: string, max = 60): string {
  const first = (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return '';
  const clean = first.replace(/^#+\s*/, '');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** 从题干里抠分值（`(4 Punkte)` / `[6 P]` / `（4 分）`）。无法判定 → null。 */
export function parsePoints(text: string): number | null {
  const t = (text ?? '').slice(0, 400);
  const de = /(\d+(?:[.,]\d+)?)\s*(?:punkte|punkten|p\b)/i.exec(t);
  if (de) return Number(de[1]!.replace(',', '.'));
  const cn = /(\d+(?:\.\d+)?)\s*分/.exec(t);
  if (cn) return Number(cn[1]);
  return null;
}

// ============================================================
// 纯函数：检查结果 → 错题候选
// ============================================================

/**
 * 检查是否"值得进错题本"。
 *
 * 只认**未过期**的检查，且结论是 wrong/partial：
 *   · correct 不进错题本（哪怕用户手动点，也由界面二次确认）
 *   · stale 的检查不进（那是旧答案的结论）
 *   · error 不进（模型故障不是学习证据）
 */
export function shouldCollectMistake(checks: readonly Check[]): boolean {
  const c = lastFreshCheck(checks);
  return !!c && (c.verdict === 'wrong' || c.verdict === 'partial');
}

/** 新错题 id（时间 + 序号，人可读）。 */
export function mistakeIdAt(now: number, seq: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `m${y}${m}${day}-${String(seq).padStart(3, '0')}`;
}

// ============================================================
// 纯函数：提交 PDF 的文件名与标签
// ============================================================

/** 提交包文件名（人可读、可排序、无空格）。 */
export function submissionFileName(courseId: string, sheet: Pick<Sheet, 'id' | 'number' | 'title'>): string {
  const base = `${courseId}-${sheet.id}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  const nice = base.length > 80 ? base.slice(0, 80) : base;
  return `${nice}-submission.pdf`;
}
