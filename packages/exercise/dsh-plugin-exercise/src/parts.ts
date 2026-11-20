// ============================================================
// parts.ts — 大题 / 小题（纯函数，不碰 fs）
//
// 用户 2026-11-20："题目做成大题中的小题也分开管理，这样子检查的时候不用重复检查正确的小题"。
//
// 模型：**每个小题就是一道完整的 Problem**（自己的答案 / 检查 / 答辩 / 错题），
// 只多两个字段：`group`（指向 sheet.groups 里的大题）和 `part`（a / b / ii）。
// 大题共用的题干（已知条件、"如图所示"）放在 group.text 上，检查小题时连同题干一起给模型。
//
// 好处：检查、过期、答辩、错题本、进度统计全部不用改 —— 已经判 correct 的小题
// 答案没变，检查就一直新鲜，"检查未通过的小题"只要跳过它们即可。
// ============================================================

import { deriveTitle, parsePoints, problemStatus, type Problem, type ProblemGroup, type Sheet } from './types.js';

const LETTERS = 'abcdefgh';
const ROMANS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii'];

/**
 * 行首的小题标记：`a)` `(a)` `a.` `**a)**` `- (a)` `Teilaufgabe a)`。
 * 冒号 / 句点后面跟的正文留在捕获组 2。
 */
const LINE_MARK =
  /^\s*(?:[-*•]\s+)?(?:\*\*|__)?(?:Teilaufgabe\s+|Teil\s+)?\(?([a-h]|i{1,3}|iv|vi{0,3})(?:\)|\.(?=\s))(?:\*\*|__)?[\s:：]*(.*)$/i;

/** 句中的小题标记（PDF 抽文本常把小题接在上一句后面）：`… gegeben. b) Zeigen Sie …` */
const INLINE_MARK = /(^|[.:;!?。；：]\s+|\s{2,})(?:\*\*)?\(?([a-h])\)(?:\*\*)?\s+/g;

export interface SplitPartsResult {
  /** 第一个小题标记之前的共用题干 */
  stem: string;
  parts: Array<{ key: string; text: string }>;
}

/** 把 `$…$` / `$$…$$` 里的字符换成空格（下标位置不变），免得 `$f(a)$` 被当成小题标记。 */
function maskMath(text: string): string {
  return text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 按顺序挑出 a,b,c…（或 i,ii,iii…）—— 不连续的候选一律不要，宁可不拆也别拆错。 */
function pickSequence<T extends { key: string }>(cands: readonly T[], seq: readonly string[]): T[] {
  const out: T[] = [];
  for (const c of cands) {
    if (c.key === seq[out.length]) out.push(c);
  }
  return out;
}

function byLines(text: string): SplitPartsResult | null {
  const lines = text.split(/\r?\n/);
  const masked = maskMath(text).split(/\r?\n/);
  const cands: Array<{ key: string; line: number; rest: string }> = [];
  masked.forEach((l, i) => {
    const m = LINE_MARK.exec(l);
    if (!m) return;
    // 正文取原行（掩码只用于判定）
    const orig = LINE_MARK.exec(lines[i]!);
    cands.push({ key: m[1]!.toLowerCase(), line: i, rest: (orig?.[2] ?? '').trim() });
  });
  let picked = pickSequence(cands, LETTERS.split(''));
  if (picked.length < 2) picked = pickSequence(cands, ROMANS);
  if (picked.length < 2) return null;
  const stem = lines.slice(0, picked[0]!.line).join('\n').trim();
  const parts = picked.map((p, j) => {
    const end = j + 1 < picked.length ? picked[j + 1]!.line : lines.length;
    return { key: p.key, text: [p.rest, ...lines.slice(p.line + 1, end)].join('\n').trim() };
  });
  return { stem, parts };
}

function inline(text: string): SplitPartsResult | null {
  const masked = maskMath(text);
  const cands: Array<{ key: string; at: number; bodyAt: number }> = [];
  for (const m of masked.matchAll(INLINE_MARK)) {
    const at = m.index! + m[1]!.length;
    cands.push({ key: m[2]!.toLowerCase(), at, bodyAt: m.index! + m[0].length });
  }
  const picked = pickSequence(cands, LETTERS.split(''));
  if (picked.length < 2) return null;
  const stem = text.slice(0, picked[0]!.at).trim();
  const parts = picked.map((p, j) => ({
    key: p.key,
    text: text.slice(p.bodyAt, j + 1 < picked.length ? picked[j + 1]!.at : text.length).trim(),
  }));
  return { stem, parts };
}

/**
 * 找出题干里的小题（至少两个、按 a,b,c… 或 i,ii,iii… 连续出现）。找不到 → null。
 * 先认行首标记；PDF 抽出来接成一段的，再认句中标记。
 */
export function splitParts(text: string): SplitPartsResult | null {
  const t = text ?? '';
  return byLines(t) ?? inline(t);
}

/** 按给定的小题键切答案（学生常写 "a) … b) …"）；没有标记 → null。 */
export function splitAnswerByKeys(answer: string, keys: readonly string[]): { prefix: string; byKey: Map<string, string> } | null {
  const r = splitParts(answer);
  if (!r) return null;
  const byKey = new Map<string, string>();
  for (const p of r.parts) if (keys.includes(p.key)) byKey.set(p.key, p.text);
  if (!byKey.size) return null;
  return { prefix: r.stem, byKey };
}

/** 小题的 Problem id：`p01` + `a` → `p01a`。 */
export function partId(baseId: string, key: string): string {
  return `${baseId}${key}`;
}

/** 小题的显示标签：`Aufgabe 1` + `a` → `Aufgabe 1 a)`。 */
export function partLabel(groupLabel: string, key: string): string {
  return `${groupLabel || ''} ${key})`.trim();
}

function blankPart(base: Problem, key: string, text: string): Problem {
  return {
    id: partId(base.id, key),
    label: partLabel(base.label, key),
    title: deriveTitle(text),
    text,
    points: parsePoints(text),
    page: base.page,
    has_figure: false,
    figure_note: '',
    answer: '',
    answer_updated_at: 0,
    answer_edited_by: 'user',
    checks: [],
    rebuttals: [],
    images: [],
    mistakes: [],
    notes: '',
    group: base.id,
    part: key,
  };
}

function groupOf(base: Problem, stem: string): ProblemGroup {
  return {
    id: base.id,
    label: base.label,
    title: base.title,
    text: stem,
    points: base.points,
    page: base.page,
    has_figure: base.has_figure,
    figure_note: base.figure_note,
  };
}

/**
 * 把一道题的用户数据搬到它拆出来的小题上（拆分 / 重新分块共用）。
 *
 *   · 答案里也有 a) b) → 按键分给各小题，标记之前的部分并进第一小题
 *   · 没有 → 整份答案给第一小题（界面会提示去挪）
 *   · 检查 / 答辩 / 附图 / 错题 / 备注 → 第一小题；检查一律标**过期**
 *     （它们评的是整道题，不是某个小题）
 */
export function distributeIntoParts(source: Problem, parts: Problem[]): void {
  if (!parts.length) return;
  const first = parts[0]!;
  const split = source.answer.trim() ? splitAnswerByKeys(source.answer, parts.map((p) => p.part)) : null;
  if (split) {
    for (const p of parts) {
      const a = split.byKey.get(p.part);
      if (a) p.answer = a;
    }
    if (split.prefix) first.answer = [split.prefix, first.answer].filter(Boolean).join('\n\n');
  } else {
    first.answer = source.answer;
  }
  for (const p of parts) {
    if (p.answer) {
      p.answer_updated_at = source.answer_updated_at;
      p.answer_edited_by = source.answer_edited_by;
    }
  }
  first.checks = source.checks.map((c) => ({ ...c, stale: true }));
  first.rebuttals = source.rebuttals;
  first.images = source.images;
  first.mistakes = source.mistakes;
  first.notes = source.notes;
}

/** 反过来：把几个小题并回一道题（合并 / 重新分块没再拆出小题时用）。 */
export function mergePartsInto(target: Problem, parts: readonly Problem[]): void {
  const answered = parts.filter((p) => p.answer.trim());
  target.answer = answered.map((p) => `${p.part}) ${p.answer.trim()}`).join('\n\n');
  target.answer_updated_at = Math.max(0, ...parts.map((p) => p.answer_updated_at));
  target.answer_edited_by = parts.some((p) => p.answer_edited_by === 'agent') ? 'agent' : 'user';
  target.checks = parts
    .flatMap((p) => p.checks.map((c) => ({ ...c, stale: true })))
    .sort((a, b) => a.created_at - b.created_at);
  target.rebuttals = parts.flatMap((p) => p.rebuttals).sort((a, b) => a.created_at - b.created_at);
  target.images = parts.flatMap((p) => p.images);
  target.mistakes = [...new Set(parts.flatMap((p) => p.mistakes))];
  target.notes = parts
    .filter((p) => p.notes.trim())
    .map((p) => `${p.part}) ${p.notes.trim()}`)
    .join('\n');
}

/** 一道题 → 大题 + 小题（不带用户数据）。拆不开 → null。 */
export function explodeProblem(p: Problem): { group: ProblemGroup; parts: Problem[] } | null {
  if (p.group) return null;
  const r = splitParts(p.text);
  if (!r) return null;
  const parts = r.parts.map((x) => blankPart(p, x.key, x.text));
  const group = groupOf(p, r.stem);
  // 整题的分值是从题干里抠的第一个"(N Punkte)" —— 有小题时那其实是 a) 的分。
  // 每个小题都标了分 → 大题分值取和；否则看大题题干里有没有自己的分值。
  if (parts.every((x) => x.points != null)) group.points = parts.reduce((sum, x) => sum + (x.points ?? 0), 0);
  else group.points = parsePoints(r.stem) ?? p.points;
  return { group, parts };
}

/**
 * 新分出来的题目（还没有用户数据）里能拆的都拆成小题。导入 / 重新分块后调用。
 * 返回新的 problems 与 groups（不改入参）。
 */
export function groupFreshProblems(problems: readonly Problem[]): { problems: Problem[]; groups: ProblemGroup[] } {
  const out: Problem[] = [];
  const groups: ProblemGroup[] = [];
  for (const p of problems) {
    const ex = explodeProblem(p);
    if (!ex) {
      out.push(p);
      continue;
    }
    groups.push(ex.group);
    out.push(...ex.parts);
  }
  return { problems: out, groups };
}

/** 拆一道已有的题（带着用户数据）。原地改 sheet；返回新的小题 id，拆不开 → null。 */
export function splitProblemInSheet(sheet: Sheet, problemId: string): string[] | null {
  const i = sheet.problems.findIndex((p) => p.id === problemId);
  if (i === -1) return null;
  const p = sheet.problems[i]!;
  const ex = explodeProblem(p);
  if (!ex) return null;
  // id 撞车（极少：手动加过一道 `p01a`）→ 不拆，别覆盖别的题
  const taken = new Set(sheet.problems.map((x) => x.id));
  if (ex.parts.some((x) => taken.has(x.id)) || sheet.groups.some((g) => g.id === ex.group.id)) return null;
  distributeIntoParts(p, ex.parts);
  sheet.problems.splice(i, 1, ...ex.parts);
  sheet.groups = [...sheet.groups, ex.group];
  return ex.parts.map((x) => x.id);
}

/** 合并一个大题的小题。原地改 sheet；返回合并后的那道题，找不到 → null。 */
export function mergeGroupInSheet(sheet: Sheet, groupId: string): Problem | null {
  const g = sheet.groups.find((x) => x.id === groupId);
  if (!g) return null;
  const parts = sheet.problems.filter((p) => p.group === groupId);
  const text = [g.text, ...parts.map((p) => `${p.part}) ${p.text}`)].filter((s) => s.trim()).join('\n\n');
  // 大题 id 就是拆分前那道题的 id；之后若有别的题占了它（手动加题），换一个
  const taken = new Set(sheet.problems.filter((p) => p.group !== groupId).map((p) => p.id));
  let id = g.id;
  for (let n = 2; taken.has(id); n++) id = `${g.id}-${n}`;
  const merged: Problem = {
    id,
    label: g.label,
    title: g.title || deriveTitle(text),
    text,
    points: g.points,
    page: g.page,
    has_figure: g.has_figure,
    figure_note: g.figure_note,
    answer: '',
    answer_updated_at: 0,
    answer_edited_by: 'user',
    checks: [],
    rebuttals: [],
    images: [],
    mistakes: [],
    notes: '',
    group: '',
    part: '',
  };
  mergePartsInto(merged, parts);
  const at = sheet.problems.findIndex((p) => p.group === groupId);
  sheet.problems = sheet.problems.filter((p) => p.group !== groupId);
  sheet.problems.splice(at === -1 ? sheet.problems.length : at, 0, merged);
  sheet.groups = sheet.groups.filter((x) => x.id !== groupId);
  return merged;
}

/** 删掉没有小题的大题（删题之后调用）。 */
export function pruneEmptyGroups(sheet: Sheet): void {
  const used = new Set(sheet.problems.map((p) => p.group).filter(Boolean));
  sheet.groups = sheet.groups.filter((g) => used.has(g.id));
}

/** 给模型看的题目上下文：小题 = 大题题干 + 本小题；前面小题的作答作参考。 */
export interface PromptStatement {
  label: string;
  title: string;
  points: number | null;
  text: string;
  /** 前面小题（同一大题）的作答 —— 只作上下文，不在本次检查范围 */
  earlier: Array<{ part: string; answer: string }>;
  /** 有值 = 这是小题 */
  part: string;
}

export function statementFor(sheet: Pick<Sheet, 'groups' | 'problems'>, p: Problem): PromptStatement {
  const g = p.group ? (sheet.groups ?? []).find((x) => x.id === p.group) : undefined;
  if (!g) return { label: p.label || p.id, title: p.title, points: p.points, text: p.text, earlier: [], part: '' };
  const siblings = sheet.problems.filter((x) => x.group === g.id);
  const idx = siblings.findIndex((x) => x.id === p.id);
  const earlier = siblings
    .slice(0, Math.max(0, idx))
    .filter((x) => x.answer.trim())
    .map((x) => ({ part: x.part, answer: x.answer.trim().slice(0, 3000) }));
  const text = [
    g.text.trim(),
    `【${p.part})】${p.text.trim() ? ` ${p.text.trim()}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return { label: p.label || p.id, title: p.title || g.title, points: p.points ?? null, text, earlier, part: p.part };
}

/**
 * 「检查这道大题」该检查哪些小题：有答案、且最近一次结论不是 correct 的
 * （改过答案的 correct 已经过期，会被重新检查）。
 */
export function partsNeedingCheck(parts: readonly Problem[]): Problem[] {
  return parts.filter((p) => {
    if (!p.answer.trim()) return false;
    const st = problemStatus(p);
    return st !== 'checked' && st !== 'done';
  });
}
