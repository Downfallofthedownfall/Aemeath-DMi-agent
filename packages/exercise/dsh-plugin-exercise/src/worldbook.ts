// ============================================================
// worldbook.ts — 错题/经验 → physicist 世界书条目
//
// 用户要求：错题和经验要"汇总整合给主 agent 的 worldbook 和错题合集"。
//
// 两条腿（刻意分开）：
//   ① **本地错题本**（store 的 `_mistakes.json`）：完整、可复习、可编辑，
//      是"我的错题"这件事的权威数据。
//   ② **世界书条目**（本文件）：只放**可复用的一句话教训**，进 knowledge 注入，
//      让主 agent 在讲同类题时能主动提起"你上次在这里栽过"。
//      世界书注入预算只有 3000 token，所以条目必须短（≤ ~300 字）——
//      把整套错题塞进去等于把注入预算烧光。
//
// 为什么写独立文件 `generated_exercise.json` 而不是追加到 memory 的
// `generated_knowledge.json`：
//   · 两个插件各写各的文件，避免读-改-写竞争（memory 每次写都全量覆盖）
//   · worldbook 插件按目录扫全部 *.json（`loadLibrary`），文件名不影响加载
//   · 想整体清空"习题沉淀的知识"时，删一个文件即可，不碰记忆生成的知识
//
// 条目身份 = `ref`（不是内容哈希）：
//   早先 id 由内容哈希决定、只追加不更新 —— 改了教训会多出一条新的、旧的永远留着；
//   错题标"已掌握"/删掉后条目也还在，主 agent 一直提醒"你上次在这里栽过"；
//   本地同步与握手导入生成的文本略有不同（哈希不同）→ 同一道错题两条。
//   现在每条都带 `ref`（`mistake:<课>/<套>/<题>` 或 `lesson:<课>/<套>/<经验 id>`），
//   按 ref **整条替换 / 撤回**，两条路径写同一个 ref 只会留一条。
// ============================================================

import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { safeCourseId, safeSheetId, withFileLockSync, writeFileAtomicSync } from './store.js';
import { tr } from './locale.js';

export const WORLDBOOK_FILE = 'generated_exercise.json';

/** 条目由谁写的：本地同步（local）还是握手导入（handoff）。 */
export type EntryOrigin = 'local' | 'handoff';

/** 世界书条目（与 packages/worldbook/data/*.json 的字段一致；ref/origin 是习题专有的附加字段）。 */
export interface WorldbookEntry {
  id: string;
  title: string;
  kind: 'knowledge';
  triggers: string[];
  constant: boolean;
  intrinsic_value: number;
  priority: number;
  chain: string[];
  content: string;
  source: string;
  exam_points?: string;
  verifiable: boolean;
  /** 条目来源的稳定标识（见文件头）；老条目没有。 */
  ref?: string;
  origin?: EntryOrigin;
}

/**
 * 触发词：topic + 拉丁词 + 中文 bigram（与 memory 的 buildWorldbookTriggers 同款）。
 * 为什么不用 NLP：worldbook 匹配是**子串/词表**式的，bigram 对中文已经够用，
 * 加依赖不值。
 */
export function buildTriggers(content: string, topic: string, tags: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const t of tags) if (typeof t === 'string' && t.trim().length >= 2) out.add(t.trim());
  if (topic && topic.length >= 2) out.add(topic);
  for (const m of content.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) out.add(m);
  const cjk = (content || '').replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2));
  // 限制数量：太多触发词会把无关对话也命中（worldbook 是每轮匹配）
  return [...out].slice(0, 8);
}

/** 条目 id：有 ref 时由 ref 决定（内容改了 id 不变），否则由内容决定。 */
export function entryIdOf(key: string): string {
  return `ex_${createHash('sha1').update(key, 'utf-8').digest('hex').slice(0, 10)}`;
}

// ============================================================
// ref：条目身份
// ============================================================

// 课程/套题标识先过一遍净化：错题本里的 course_id 是当初调用方传进来的原值，
// 握手包里的是索引里的规范值；不规整的话同一道题会算出两个 ref。
export function mistakeRef(courseId: string, sheetId: string, problemId: string): string {
  return `mistake:${safeCourseId(courseId)}/${safeSheetId(sheetId)}/${problemId}`;
}

export function lessonRef(courseId: string, sheetId: string, lessonId: string): string {
  return `lesson:${safeCourseId(courseId)}/${safeSheetId(sheetId)}/${lessonId}`;
}

/** 一个条目落在哪门课/哪套题上（用于按范围同步与撤回）。 */
export interface EntryScope {
  kind: 'mistake' | 'lesson';
  /** 课程 id；老条目的经验来源里写的是课程**标题**，见 `legacy` */
  course: string;
  sheet: string;
  /** true = 从老条目的 source 文本里推出来的（course 可能是标题） */
  legacy: boolean;
}

/** 解析 ref（`mistake:c/s/p` / `lesson:c/s/l`）。 */
export function parseRef(ref: string): EntryScope | null {
  const m = /^(mistake|lesson):([^/]+)\/([^/]+)\/(.+)$/.exec(ref);
  if (!m) return null;
  return { kind: m[1] as 'mistake' | 'lesson', course: m[2]!, sheet: m[3]!, legacy: false };
}

/**
 * 老条目（没有 ref）的范围：从 `source` 文本反推。
 * 三种历史写法都认：本地 `Übungsblatt 错题（c/s/p）`、英文 `Übungsblatt mistake (c/s/p)`、
 * 经验 `Übungsblatt 经验（课程标题 / s）`。认不出来 → null（不是习题写的，绝不碰）。
 */
export function legacyScope(e: Pick<WorldbookEntry, 'source'>): EntryScope | null {
  const m = /^Übungsblatt\s*(错题|mistake|经验|lesson)\s*[（(](.+)[）)]\s*$/.exec((e.source ?? '').trim());
  if (!m) return null;
  const parts = m[2]!.split('/').map((x) => x.trim());
  const isMistake = m[1] === '错题' || m[1] === 'mistake';
  if (isMistake && parts.length === 3 && parts.every(Boolean)) {
    return { kind: 'mistake', course: parts[0]!, sheet: parts[1]!, legacy: true };
  }
  if (!isMistake && parts.length === 2 && parts.every(Boolean)) {
    return { kind: 'lesson', course: parts[0]!, sheet: parts[1]!, legacy: true };
  }
  return null;
}

/** 条目的范围（新条目看 ref，老条目看 source）。 */
export function scopeOf(e: Pick<WorldbookEntry, 'ref' | 'source'>): EntryScope | null {
  return e.ref ? parseRef(e.ref) : legacyScope(e);
}

/**
 * 条目是否属于某门课（可选：某套题）。
 * 老条目的经验来源里写的是课程标题，所以 `courseTitle` 也算命中。
 */
export function entryInScope(
  e: Pick<WorldbookEntry, 'ref' | 'source'>,
  scope: { courseId: string; courseTitle?: string; sheetId?: string },
): boolean {
  const s = scopeOf(e);
  if (!s) return false;
  const courseHit =
    safeCourseId(s.course) === safeCourseId(scope.courseId) ||
    (s.legacy && !!scope.courseTitle && s.course === scope.courseTitle.trim());
  if (!courseHit) return false;
  return !scope.sheetId || safeSheetId(s.sheet) === safeSheetId(scope.sheetId);
}

// ============================================================
// 组装条目（本地同步与握手导入共用同一套 → 同一个 ref 写出同样的内容）
// ============================================================

export interface EntryInput {
  content: string;
  title: string;
  tags?: string[];
  source?: string;
  priority?: number;
  intrinsicValue?: number;
  topic?: string;
  ref?: string;
  origin?: EntryOrigin;
}

/** 组装一条世界书条目（纯函数）。 */
export function buildWorldbookEntry(input: EntryInput): WorldbookEntry {
  const content = input.content.trim();
  const entry: WorldbookEntry = {
    id: entryIdOf(input.ref ?? content),
    title: (input.title || tr('习题教训', 'Exercise lesson')).slice(0, 60),
    kind: 'knowledge',
    triggers: buildTriggers(content, input.topic ?? input.title, input.tags ?? []),
    constant: false,
    intrinsic_value: input.intrinsicValue ?? 70,
    // 与 memory 生成条目（priority 1）区分：习题教训应优先于泛化知识注入
    priority: input.priority ?? 60,
    chain: [],
    content: content.slice(0, 600),
    source: input.source ?? tr('Übungsblatt 错题沉淀', 'Übungsblatt mistake digest'),
    verifiable: false,
  };
  if (input.ref) entry.ref = input.ref;
  if (input.origin) entry.origin = input.origin;
  return entry;
}

/** 生成错题条目需要的字段（本地 Mistake 与握手包里的错题快照都能凑出来）。 */
export interface MistakeEntrySource {
  course_id: string;
  course_title?: string;
  sheet_id: string;
  sheet_title?: string;
  problem_id: string;
  problem_label?: string;
  lesson?: string;
  issues?: readonly string[];
  tags?: readonly string[];
}

/** 一条错题 → 一条教训条目。没有 lesson 内容时用 issues 兜底（但不编造）。 */
export function mistakeToEntry(m: MistakeEntrySource, origin: EntryOrigin = 'local'): WorldbookEntry | null {
  const lesson = (m.lesson || '').trim();
  const issues = (m.issues ?? []).map((i) => i.trim()).filter(Boolean).slice(0, 3);
  if (!lesson && !issues.length) return null;
  const tags = [...(m.tags ?? [])];
  const head = tr(
    `【错题】${m.course_title || m.course_id} · ${m.sheet_title || m.sheet_id} · ${m.problem_label || m.problem_id}`,
    `[Mistake] ${m.course_title || m.course_id} · ${m.sheet_title || m.sheet_id} · ${m.problem_label || m.problem_id}`,
  );
  const body = [
    head,
    lesson ? tr(`教训：${lesson}`, `Lesson: ${lesson}`) : '',
    issues.length ? tr(`当时的问题：${issues.join('；')}`, `Problems at the time: ${issues.join('; ')}`) : '',
    tags.length ? tr(`主题：${tags.join('、')}`, `Topics: ${tags.join(', ')}`) : '',
  ]
    .filter(Boolean)
    .join('\n');
  return buildWorldbookEntry({
    content: body,
    title: tr(`${m.problem_label || '习题'} 错题教训`, `${m.problem_label || 'Problem'} mistake lesson`).slice(0, 60),
    tags,
    source: tr(`Übungsblatt 错题（${m.course_id}/${m.sheet_id}/${m.problem_id}）`, `Übungsblatt mistake (${m.course_id}/${m.sheet_id}/${m.problem_id})`),
    priority: 70,
    topic: m.problem_label,
    ref: mistakeRef(m.course_id, m.sheet_id, m.problem_id),
    origin,
  });
}

/** 生成经验条目需要的字段。 */
export interface LessonEntrySource {
  courseId: string;
  courseTitle: string;
  sheet: { id: string; number?: number; title?: string };
  lesson: { id: string; text: string; tags?: readonly string[] };
}

/** 一条经验 → 一条条目。 */
export function lessonToEntry(input: LessonEntrySource, origin: EntryOrigin = 'local'): WorldbookEntry | null {
  const text = (input.lesson.text || '').trim();
  if (!text) return null;
  const { sheet } = input;
  const sheetName = sheet.number ? `Übungsblatt ${sheet.number}` : sheet.title || sheet.id;
  const sheetSuffix = sheet.number && sheet.title ? tr(`（${sheet.title}）`, ` (${sheet.title})`) : '';
  const body = tr(
    `【习题经验】${input.courseTitle} · ${sheetName}${sheetSuffix}\n${text}`,
    `[Exercise lesson] ${input.courseTitle} · ${sheetName}${sheetSuffix}\n${text}`,
  );
  return buildWorldbookEntry({
    content: body,
    title: (sheet.number ? tr(`Blatt ${sheet.number} 经验`, `Blatt ${sheet.number} lesson`) : tr(`${sheetName} 经验`, `${sheetName} lesson`)).slice(0, 60),
    tags: [...(input.lesson.tags ?? [])],
    source: tr(`Übungsblatt 经验（${input.courseId}/${sheet.id}）`, `Übungsblatt lesson (${input.courseId}/${sheet.id})`),
    priority: 55,
    topic: sheet.title || sheetName,
    ref: lessonRef(input.courseId, sheet.id, input.lesson.id),
    origin,
  });
}

// ============================================================
// 落盘：一次读-改-写（跨进程锁 + 原子写）
// ============================================================

export interface WorldbookChanges {
  /** 按 ref（没有 ref 的按 id）整条替换；不存在就追加。 */
  upserts?: readonly WorldbookEntry[];
  /** 已有条目里返回 true 的删掉（与 upserts 同 key 的条目不受影响：它们会被替换）。 */
  remove?: (e: WorldbookEntry) => boolean;
  /**
   * true = upserts 只**替换已有**的同 key 条目，文件里没有的不新增。
   * 用于"内容该换了，但同步与否仍由用户决定"的场合（比如同一道题的另一条错题顶上来）。
   */
  replaceOnly?: boolean;
}

export interface WorldbookApplyResult {
  ok: boolean;
  error?: string;
  /** key = ref（没有 ref 的条目用 id） */
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  /** 新增 + 内容变化的条目（知识层只同步这些） */
  changed: WorldbookEntry[];
  file: string;
}

const keyOf = (e: Pick<WorldbookEntry, 'ref' | 'id'>): string => e.ref || e.id;

function resolveLibraryDir(libraryDir: string): string {
  return isAbsolute(libraryDir) ? libraryDir : join(process.cwd(), libraryDir);
}

/**
 * 把一组变更应用到馆目录的 `generated_exercise.json`。
 *
 * 全部变更**一次**写完（原子 rename）：要么全成、要么全不成 —— 调用方据此打同步标记，
 * 不会出现"写失败的也被标成已同步、以后再也不重试"。
 * `dryRun` 只算差异不落盘（握手导入的试运行用）。
 */
export function applyWorldbookChanges(
  libraryDir: string,
  changes: WorldbookChanges,
  opts: { dryRun?: boolean } = {},
): WorldbookApplyResult {
  const dir = resolveLibraryDir(libraryDir);
  const file = join(dir, WORLDBOOK_FILE);
  const result: WorldbookApplyResult = { ok: false, added: [], updated: [], unchanged: [], removed: [], changed: [], file };
  // 馆目录不存在 = 这个 profile 没挂 worldbook（或路径配错）→ 明确报错，不自己造目录：
  // 自己造一个空馆会让"写成功了"变成假象（worldbook 插件根本不看这个路径）。
  if (!existsSync(dir)) return { ...result, error: tr(`馆目录不存在: ${dir}`, `Library directory not found: ${dir}`) };

  const run = (): WorldbookApplyResult => {
    let existing: WorldbookEntry[] = [];
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf-8');
      try {
        const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown;
        if (!Array.isArray(parsed)) throw new Error('not an array');
        existing = parsed as WorldbookEntry[];
      } catch {
        // 坏文件：不覆盖（那可能是用户手改坏了，覆盖会丢他自己的内容）
        return { ...result, error: tr(`世界书文件不可解析，已跳过写入: ${file}`, `Worldbook file is unparseable; write skipped: ${file}`) };
      }
    }

    const pending = new Map<string, WorldbookEntry>();
    for (const e of changes.upserts ?? []) pending.set(keyOf(e), e);
    const seen = new Set<string>();
    const next: WorldbookEntry[] = [];
    for (const cur of existing) {
      if (!cur || typeof cur !== 'object') {
        next.push(cur);
        continue;
      }
      const key = keyOf(cur);
      // 同一个 key 出现两次（老版本按内容哈希追加 = 内容完全相同的重复）：只留第一条
      if (seen.has(key)) {
        result.removed.push(key);
        continue;
      }
      seen.add(key);
      const replacement = pending.get(key);
      if (replacement) {
        pending.delete(key);
        if (JSON.stringify(cur) === JSON.stringify(replacement)) {
          result.unchanged.push(key);
          next.push(cur);
        } else {
          result.updated.push(key);
          result.changed.push(replacement);
          next.push(replacement);
        }
        continue;
      }
      if (changes.remove?.(cur)) {
        result.removed.push(key);
        continue;
      }
      next.push(cur);
    }
    if (!changes.replaceOnly) {
      for (const [key, e] of pending) {
        result.added.push(key);
        result.changed.push(e);
        next.push(e);
      }
    }

    const dirty = result.added.length + result.updated.length + result.removed.length > 0;
    // 原子写：主 agent 的 worldbook 会重读馆里每个 .json（临时文件以 .tmp 结尾，不会被读到），
    // 馆目录又常在 OneDrive 里。写到一半被读 / 进程被杀留下半截 JSON 的话，
    // 上面的"坏文件不覆盖"会让之后的每次同步都跳过。
    if (dirty && !opts.dryRun) writeFileAtomicSync(file, JSON.stringify(next, null, 2));
    return { ...result, ok: true };
  };

  try {
    // 试运行不拿锁（只读）；真写时跨进程加锁：主 profile 与独立 profile 写同一个文件
    return opts.dryRun ? run() : withFileLockSync(file, run);
  } catch (e) {
    return { ...result, error: (e as Error).message };
  }
}

export interface WorldbookWriteResult {
  ok: boolean;
  id?: string;
  created?: boolean;
  error?: string;
}

/** 写一条（按 ref/id 去重；内容相同 = 已存在）。保留给老调用方，实现走 applyWorldbookChanges。 */
export function appendWorldbookEntry(libraryDir: string, entry: WorldbookEntry): WorldbookWriteResult {
  const r = applyWorldbookChanges(libraryDir, { upserts: [entry] });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, id: entry.id, created: r.changed.length > 0 };
}

/** 批量写（一次落盘）；返回"写了几条/跳过几条/失败几条"给界面。 */
export function appendWorldbookEntries(
  libraryDir: string,
  entries: readonly WorldbookEntry[],
): { written: number; skipped: number; failed: number; errors: string[] } {
  if (!entries.length) return { written: 0, skipped: 0, failed: 0, errors: [] };
  const r = applyWorldbookChanges(libraryDir, { upserts: entries });
  if (!r.ok) return { written: 0, skipped: 0, failed: entries.length, errors: r.error ? [r.error] : [] };
  return { written: r.changed.length, skipped: r.unchanged.length, failed: 0, errors: [] };
}
