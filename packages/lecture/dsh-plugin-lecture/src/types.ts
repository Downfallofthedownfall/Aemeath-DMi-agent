// ============================================================
// types.ts — Lecture Mode 公共类型（纯类型 + zod schema，无副作用）
//
// 设计依据：docs/lecture-mode-plan.md
//   D6  数据存储 = 文件为主（markdown + JSON 索引），不先上数据库
//   D3  课堂内 LLM 要加工，但只留后端；前端不剧透
//   D4  复盘完成后才生成完整结构化摘要
//   D11 数据目录 = packages/library/physicist/lectures/
// ============================================================

import { z } from 'zod';

// ============================================================
// 标记语法（用户设计）：# 主题 / = 公式 / ? 疑问 / ! 重点 / > 例子 / --- 分块
// ============================================================

/** 速记行类型。`text` = 普通叙述行。 */
export type MarkerKind = 'topic' | 'formula' | 'question' | 'keypoint' | 'example' | 'divider' | 'text';

export const MARKER_KINDS: readonly MarkerKind[] = ['topic', 'formula', 'question', 'keypoint', 'example', 'divider', 'text'];

/** 标记字符 → 语义类型。`---`（分块）单独处理，因为它以 `-` 开头。 */
export const MARKER_PREFIX: Readonly<Record<string, MarkerKind>> = {
  '#': 'topic',
  '=': 'formula',
  '?': 'question',
  '!': 'keypoint',
  '>': 'example',
  '-': 'divider', // 仅当整行是 `---`（见 classifyLine）
};

export interface ShorthandLine {
  kind: MarkerKind;
  /** 去掉标记前缀后的正文（已 trim）。divider 恒为空串。 */
  text: string;
  /** 原始整行（含标记）；用于无损回写与调试。 */
  raw: string;
}

/**
 * 判定一行速记的类型。
 *
 * 注意 `---` 必须在 `-` 之前判定：我们把「整行恰好是三个及以上连字符」视为分块，
 * 而不是普通文本——否则 `---` 会被当成 text 而丢失分块语义。
 */
export function classifyLine(raw: string): ShorthandLine {
  const line = raw.trim();
  if (!line) return { kind: 'text', text: '', raw };
  // 分块：整行仅由 3+ 个连字符（允许中间空格）构成
  if (/^-{3,}$/.test(line.replace(/\s+/g, ''))) return { kind: 'divider', text: '', raw };
  const head = line[0];
  if (head && head in MARKER_PREFIX && MARKER_PREFIX[head] !== 'divider') {
    // ⚠️ `#` 要剥掉**全部**连续的 `#`，不是一个。
    //
    //   真机踩过：用户按 markdown 写 `## 1.2 Vektorraeume`，
    //   这里只剥一个 `#` → text = `# 1.2 …`，
    //   而 writeUnitMarkdown 又统一加 `## ` 前缀 →
    //   存成 `## # 1.2 Vektorraeume`，渲染出来标题前面多一个 `#`。
    //
    //   现在 `## x` / `### x` 都规整成 `x`，写回时统一是 `## x`
    //   （每块就是一个小节，层次没有语义差别）。
    if (head === '#') {
      return { kind: MARKER_PREFIX[head]!, text: line.replace(/^#+\s*/, ''), raw };
    }
    return { kind: MARKER_PREFIX[head]!, text: line.slice(1).trim(), raw };
  }
  return { kind: 'text', text: line, raw };
}

/** 解析整段速记文本为结构化行序列。 */
export function parseShorthand(input: string): ShorthandLine[] {
  return input.split(/\r?\n/).map(classifyLine);
}

/** 反向：结构化行 → 速记文本（用于无损回写）。 */
export function renderShorthand(lines: readonly ShorthandLine[]): string {
  return lines
    .map((l) => {
      if (l.kind === 'divider') return '---';
      if (l.kind === 'text') return l.text;
      const prefix = Object.entries(MARKER_PREFIX).find(([, k]) => k === l.kind)?.[0] ?? '';
      return `${prefix} ${l.text}`.trim();
    })
    .join('\n');
}

/** 按 divider 把速记行切成块（RawChunk 的边界）。 */
export function splitChunks(lines: readonly ShorthandLine[]): ShorthandLine[][] {
  const out: ShorthandLine[][] = [];
  let cur: ShorthandLine[] = [];
  for (const l of lines) {
    if (l.kind === 'divider') {
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    cur.push(l);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 提取某类行（如全部 formula）的正文。 */
export function textsOfKind(lines: readonly ShorthandLine[], kind: MarkerKind): string[] {
  return lines.filter((l) => l.kind === kind && l.text).map((l) => l.text);
}

/**
 * 强制留白检查（D3 / 原版提示词）：每块必须填 [我的理解] 与 [我的疑问]。
 * 不填不继续——返回缺失项，空数组 = 通过。
 *
 * 用「含标签且标签后有非空白内容」判定；仅有标签无内容不算填。
 */
export const BLANK_MARKERS = ['[我的理解]', '[我的疑问]'] as const;

export function missingBlanks(text: string): string[] {
  const missing: string[] = [];
  for (const marker of BLANK_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx === -1) {
      missing.push(marker);
      continue;
    }
    const after = text.slice(idx + marker.length);
    // 取标签后到下一个标签/分块之前的内容，判断是否只有空白
    const stop = after.search(/\[我的(理解|疑问)\]|---/);
    const body = (stop === -1 ? after : after.slice(0, stop)).trim();
    if (!body) missing.push(marker);
  }
  return missing;
}

// ============================================================
// 存储 schema（D6：markdown 为主 + JSON 索引）
// ============================================================

/** 课程单元（一讲）。 */
export const unitMetaSchema = z.object({
  id: z.string(),
  date: z.string(),
  title: z.string(),
  file: z.string(),
  /** 是否已完成课后复盘（D4 门控：只有 true 才允许生成结构化摘要/握手）。 */
  reviewed: z.boolean().default(false),
  /** 是否已生成结构化摘要（复盘第 4 步之后）。 */
  has_summary: z.boolean().default(false),
});
export type UnitMeta = z.infer<typeof unitMetaSchema>;

/** 单门课程的索引（`index.json`）。 */
export const courseIndexSchema = z.object({
  version: z.literal(1),
  course_id: z.string(),
  title: z.string(),
  semester: z.string().default(''),
  module_code: z.string().default(''),
  units: z.array(unitMetaSchema).default([]),
});
export type CourseIndex = z.infer<typeof courseIndexSchema>;

/** 新建课程索引。 */
export function emptyCourseIndex(courseId: string, title: string, semester = '', moduleCode = ''): CourseIndex {
  return { version: 1, course_id: courseId, title, semester, module_code: moduleCode, units: [] };
}

// ============================================================
// 课堂记录 front-matter（markdown 头部）
// ============================================================

export interface LectureFrontMatter {
  course: string;
  unit: string;
  date: string;
  semester: string;
  module: string;
}

/** 渲染 markdown front-matter（`---` 包围的 YAML 子集，仅本插件自用）。 */
export function renderFrontMatter(fm: LectureFrontMatter): string {
  return [
    '---',
    `course: ${fm.course}`,
    `unit: ${fm.unit}`,
    `date: ${fm.date}`,
    `semester: ${fm.semester}`,
    `module: ${fm.module}`,
    '---',
  ].join('\n');
}

/**
 * 解析 front-matter。缺失/畸形时返回 null（调用方优雅降级，不抛）。
 * 只认简单 `key: value` 行——够用且避免引入 YAML 依赖。
 */
export function parseFrontMatter(md: string): { front: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { front: {}, body: md };
  const front: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { front, body: md.slice(m[0].length) };
}

// ============================================================
// D3 加工结果（后端存储，前端不剧透）
// ============================================================

/**
 * 后端加工记录。**这张表的内容绝不回显前端**（D3）。
 *
 * 之所以用 `source.kind = 'aemeath-lecture'` 标记注入消息，见 plan §5：
 * 前端按 source.kind 过滤，而不是按文本匹配（文本匹配不可靠）。
 */
export const processingSchema = z.object({
  unit_id: z.string(),
  chunk_seq: z.number(),
  /** LLM 规范化后的 LaTeX 公式（原样速记 → 规范形式）。 */
  formulas: z.array(z.object({ shorthand: z.string(), latex: z.string() })).default([]),
  /** LLM 加工后的结构化正文（**不前端回显**）。 */
  processed: z.string().default(''),
  /** 加工时使用的模型；便于回溯。 */
  model: z.string().default(''),
  created_at: z.number(),
});
export type ProcessingRecord = z.infer<typeof processingSchema>;

/** 课堂采集的原始块（含用户强制留白）。 */
export const rawChunkSchema = z.object({
  seq: z.number(),
  /** 用户原始速记（无损）。 */
  raw: z.string(),
  /** 我的理解（强制留白）。 */
  my_understanding: z.string().default(''),
  /** 我的疑问（强制留白）。 */
  my_question: z.string().default(''),
  created_at: z.number(),
});
export type RawChunk = z.infer<typeof rawChunkSchema>;

// ============================================================
// 课后复盘（五步状态机）
// ============================================================

/** 复盘步骤（plan §6）。 */
export type ReviewStep = 'recall' | 'compare' | 'repair' | 'candidates' | 'commit' | 'done';

export const REVIEW_STEPS: readonly ReviewStep[] = ['recall', 'compare', 'repair', 'candidates', 'commit', 'done'];

/** 第 2 步「对照」三栏。 */
export const comparisonSchema = z.object({
  remembered: z.array(z.string()).default([]),
  missed: z.array(z.string()).default([]),
  wrong_or_vague: z.array(z.string()).default([]),
});
export type Comparison = z.infer<typeof comparisonSchema>;

/**
 * 第 4 步候选条目（复盘**之后**才生成，D4）。
 * 与主 agent 的 memory 层对应但**不直接写入**——第 5 步逐条确认后才走握手。
 */
export const candidatesSchema = z.object({
  unit_id: z.string(),
  worldbook_entries: z.array(z.object({ title: z.string(), content: z.string(), topic: z.string().default('物理/数学') })).default([]),
  entity_claims: z.array(z.object({ entity: z.string().default('用户'), attribute: z.string(), value: z.string() })).default([]),
  unresolved_questions: z.array(z.string()).default([]),
  insights: z.array(z.string()).default([]),
  created_at: z.number(),
});
export type Candidates = z.infer<typeof candidatesSchema>;

/** 复盘会话状态。 */
export const reviewStateSchema = z.object({
  unit_id: z.string(),
  step: z.enum(['recall', 'compare', 'repair', 'candidates', 'commit', 'done']),
  /** 第 1 步：用户凭记忆说出的内容（不给任何提示）。 */
  recall_text: z.string().default(''),
  comparison: comparisonSchema.nullable().default(null),
  /** 第 3 步：苏格拉底式问答记录（只针对漏/错）。 */
  repair_turns: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  updated_at: z.number(),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;
