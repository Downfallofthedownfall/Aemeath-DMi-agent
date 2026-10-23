// ============================================================
// digest.ts — "开新一套 Übung 时附上的学习进度"
//
// 用户要求：每开启新的 Übung 时给 exercise 附上**简短的用户学习进度**。
//
// 为什么放在创建时（而不是每轮现算）：
//   · 它是**这一套题的上下文**：批改 prompt、提交 PDF 的封页、handoff 都要读它
//   · 存进 sheet.json（progress_digest）后跨机器/跨会话稳定，
//     不会因为主 agent 的记忆被改写而"上次的进度"漂移
//   · 也便于以后回看"我当时学到哪了"
//
// 输出必须**短**（≤12 行 / ~500 字）：它要进 prompt，太长会挤掉题目本身。
// 本文件是纯函数：数据由调用方读完传进来，便于单测。
// ============================================================

import { sheetProgress, problemStatus, type Sheet, type Mistake } from './types.js';
import { tr } from './locale.js';

export interface LectureProgress {
  /** 已复盘的讲数 */
  reviewed: number;
  /** 总讲数 */
  total: number;
  /** 最近一讲（标题 + 日期），没有则 null */
  latest: { unit: string; title: string; date: string } | null;
}

export interface DigestInput {
  /** 本课程已有的题集（**不含**正在开的新套；由调用方过滤） */
  sheets: readonly Sheet[];
  /** 全课程错题本 */
  mistakes: readonly Mistake[];
  /** lecture 的进度（可选；读不到就省略这一段） */
  lecture?: LectureProgress | null;
  /** 当前时间（测试注入） */
  now?: number;
}

export interface DigestResult {
  /** 给 prompt / 封页用的多行文本（无内容时为空串） */
  text: string;
  /** 结构化统计（UI 顶栏也能直接用） */
  stats: {
    sheetsTotal: number;
    sheetsSubmitted: number;
    problemsAnswered: number;
    problemsTotal: number;
    checksPassed: number;
    unmasteredMistakes: number;
    topWeakTags: string[];
  };
}

/** 距 `due` 还有几天（负数=已过期；空/非法 → null）。 */
export function daysUntil(due: string, now: number = Date.now()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((due ?? '').trim());
  if (!m) return null;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).getTime();
  if (!Number.isFinite(target)) return null;
  const d = new Date(now);
  const todayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime();
  return Math.round((target - todayEnd) / 86_400_000);
}

/** 统计最常出现的薄弱标签（未掌握错题优先）。 */
export function topTags(mistakes: readonly Mistake[], limit = 4): string[] {
  const score = new Map<string, number>();
  for (const m of mistakes) {
    if (m.mastered) continue;
    for (const t of m.tags ?? []) {
      const key = t.trim();
      if (!key) continue;
      score.set(key, (score.get(key) ?? 0) + 1);
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

/**
 * 组装进度摘要。
 *
 * 结构（每次都按这个顺序，便于人和模型快速定位）：
 *   1) 上次做到哪（最近一套未提交/最近的编号）
 *   2) 累计题量（已答/总题、检查通过数）
 *   3) 错题本里还没掌握的（数量 + top 标签）
 *   4) 课堂进度（有 lecture 数据时）
 */
export function buildProgressDigest(input: DigestInput): DigestResult {
  const now = input.now ?? Date.now();
  const lines: string[] = [];
  const sheets = [...input.sheets].sort((a, b) => a.number - b.number);
  const mistakes = [...input.mistakes];

  let problemsTotal = 0;
  let problemsAnswered = 0;
  let checksPassed = 0;
  let lastActive: { sheet: Sheet; answered: number; total: number } | null = null;
  let pending: Sheet | null = null;

  for (const s of sheets) {
    const prog = sheetProgress(s);
    problemsTotal += prog.total;
    problemsAnswered += prog.answered;
    checksPassed += prog.checked;
    if (prog.answered > 0 && prog.answered < prog.total) lastActive = { sheet: s, answered: prog.answered, total: prog.total };
    if (!pending && s.submitted_at === 0 && prog.total > 0) pending = s;
  }

  if (sheets.length === 0) {
    lines.push(tr(
      '这是第一套 Übung —— 还没有历史记录，从读题、列已知量开始。',
      'This is the first Übung — no history yet. Start by reading the problem and listing the knowns.',
    ));
  } else {
    // 1) 上次做到哪
    if (pending) {
      const prog = sheetProgress(pending);
      const d = daysUntil(pending.due, now);
      const dueBit =
        d == null
          ? ''
          : d < 0
            ? tr(`（已过期 ${-d} 天）`, ` (overdue by ${-d} days)`)
            : d === 0
              ? tr('（今天截止）', ' (due today)')
              : tr(`（还有 ${d} 天）`, ` (${d} days left)`);
      lines.push(
        tr(
          `上次没做完：Übungsblatt ${pending.number}${pending.title ? `（${pending.title}）` : ''} ` +
            `已答 ${prog.answered}/${prog.total} 题${dueBit}`,
          `Last unfinished: Übungsblatt ${pending.number}${pending.title ? ` (${pending.title})` : ''} ` +
            `${prog.answered}/${prog.total} answered${dueBit}`,
        ),
      );
    } else if (lastActive) {
      lines.push(tr(
        `上次做到：Übungsblatt ${lastActive.sheet.number} 已答 ${lastActive.answered}/${lastActive.total} 题（已提交）`,
        `Last worked on: Übungsblatt ${lastActive.sheet.number}, ${lastActive.answered}/${lastActive.total} answered (submitted)`,
      ));
    } else {
      const last = sheets[sheets.length - 1]!;
      lines.push(tr(
        `上次完成：Übungsblatt ${last.number}${last.submitted_at ? '（已提交）' : ''}`,
        `Last completed: Übungsblatt ${last.number}${last.submitted_at ? ' (submitted)' : ''}`,
      ));
    }
    // 2) 累计
    lines.push(tr(
      `累计：${sheets.length} 套题、${problemsAnswered}/${problemsTotal} 题有答案，其中 ${checksPassed} 题检查通过`,
      `Total: ${sheets.length} sheets, ${problemsAnswered}/${problemsTotal} answered, ${checksPassed} passed the check`,
    ));
  }

  // 3) 错题本
  const unmastered = mistakes.filter((m) => !m.mastered);
  const tags = topTags(mistakes);
  if (unmastered.length) {
    lines.push(
      tr(
        `错题本：${unmastered.length} 条未掌握` + (tags.length ? `，薄弱主题：${tags.join(' / ')}` : ''),
        `Mistakes: ${unmastered.length} not mastered` + (tags.length ? `, weak topics: ${tags.join(' / ')}` : ''),
      ),
    );
    // 最近一条错题的"教训"最有价值（一句话，不堆内容）
    const recent = [...unmastered].sort((a, b) => b.updated_at - a.updated_at)[0];
    if (recent?.lesson?.trim()) {
      lines.push(tr(
        `最近一条教训（Blatt ${recent.sheet_id} ${recent.problem_label}）：${recent.lesson.trim().slice(0, 120)}`,
        `Latest lesson (Blatt ${recent.sheet_id} ${recent.problem_label}): ${recent.lesson.trim().slice(0, 120)}`,
      ));
    }
  } else if (mistakes.length) {
    lines.push(tr(
      `错题本：${mistakes.length} 条全部已掌握，可以开始做新题了`,
      `Mistakes: all ${mistakes.length} mastered — ready for a new sheet`,
    ));
  }

  // 4) 课堂进度
  if (input.lecture && input.lecture.total > 0) {
    const l = input.lecture;
    const latest = l.latest ? tr(`，最近一讲「${l.latest.title}」(${l.latest.date})`, `, latest lecture "${l.latest.title}" (${l.latest.date})`) : '';
    lines.push(tr(
      `课堂进度：已复盘 ${l.reviewed}/${l.total} 讲${latest}`,
      `Lecture progress: ${l.reviewed}/${l.total} reviewed${latest}`,
    ));
  }

  const stats = {
    sheetsTotal: sheets.length,
    sheetsSubmitted: sheets.filter((s) => s.submitted_at > 0).length,
    problemsAnswered,
    problemsTotal,
    checksPassed,
    unmasteredMistakes: unmastered.length,
    topWeakTags: tags,
  };
  return { text: lines.join('\n'), stats };
}

/**
 * 给**当前这套题**的下一步建议（UI 右侧"进度"栏用，不进 prompt）。
 * 与 digest 分开：digest 是"开题时的历史"，这里是"这套题现在该干嘛"。
 */
export function nextActionHint(sheet: Sheet): string {
  const prog = sheetProgress(sheet);
  if (prog.total === 0) return tr('还没有题目 —— 先导入 PDF 或手动加一道题', 'No problems yet — import a PDF or add one manually');
  const todo = sheet.problems.filter((p) => problemStatus(p) === 'todo');
  if (todo.length)
    return tr(
      `还有 ${todo.length} 题没写答案（${todo.map((p) => p.label || p.id).join('、')}）`,
      `${todo.length} problems still need an answer (${todo.map((p) => p.label || p.id).join(', ')})`,
    );
  const fix = sheet.problems.filter((p) => problemStatus(p) === 'needs_fix');
  if (fix.length) return tr(`${fix.length} 题检查没过 —— 先按提示改，再重新检查`, `${fix.length} problems failed the check — apply the hints, then check again`);
  if (sheet.submitted_at === 0) return tr('所有题都检查通过了 —— 可以生成提交 PDF 了', 'All problems passed — you can generate the submission PDF');
  return tr(
    `已生成提交包（${sheet.submission_pages} 页）—— 下载后上传到 Übungsbetrieb`,
    `Submission package generated (${sheet.submission_pages} pages) — download it and upload to Übungsbetrieb`,
  );
}
