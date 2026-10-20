// ============================================================
// checker.ts — 手动触发的 LLM 检查（批改）
//
// D3（本模块的核心约束）：**只能手动触发**。
//   没有"自动判题"、没有 post-execute 钩子、没有后台队列。
//   理由：判错会直接把人带偏 —— 学习者无法区分"我真的错了"和"模型看错了"。
//   所以检查永远是用户点一下按钮（或明确让 agent 检查）才发生的动作，
//   而且模型输出是**建议**，不是判分：界面要把它和用户自己的答案并排显示。
//
// 教学取向（与 lecture 的 D12 一致）：
//   · 不直接给完整答案（苏格拉底式：指出哪一步不成立 + 下一步该验证什么）
//   · 不能验证的地方必须说"无法判定"，不许编
//   · 若答案为空，判 unclear 并说明缺什么 —— 不替用户做题
//
// 本文件是纯函数（prompt 组装 + 输出解析），LLM 调用由 index.ts 注入。
// ============================================================

import { z } from 'zod';
import { checkIssueSchema, type Verdict } from './types.js';

/** LLM 通道（与 lecture 的 AskLlm 同形，便于复用同一种接线）。 */
export interface AskLlm {
  (
    prompt: string,
    opts: {
      maxTokens: number;
      purpose: string;
      /** 结构型小任务（分块）：关掉推理，避免思考把 token 预算吃光（真机踩过）。 */
      noReasoning?: boolean;
      /** 跳过全局 LLM 运行时、直接走直连（上一次运行时的输出不可用时才这样重试）。 */
      preferDirect?: boolean;
    },
  ): Promise<string | null>;
}

export interface CheckInput {
  courseTitle: string;
  sheetNumber: number;
  sheetTitle: string;
  problemLabel: string;
  problemTitle: string;
  points: number | null;
  problemText: string;
  answer: string;
  notes?: string;
  /** 开这套题时的学习进度摘要（让批改知道他最近在补什么）。 */
  progressDigest?: string;
  /** 同主题的历史错题（避免重复踩同一个坑）。 */
  priorMistakes?: string[];
  /** 解释语言：默认中文（用户母语），题目原文保持德语。 */
  lang?: 'zh' | 'de';
}

export interface ParsedCheck {
  verdict: Verdict;
  score: number | null;
  issues: Array<{ severity: 'error' | 'warn' | 'info'; text: string }>;
  hints: string[];
  next_steps: string[];
}

const parsedSchema = z.object({
  verdict: z.enum(['correct', 'partial', 'wrong', 'unclear']).default('unclear'),
  score: z.number().min(0).max(1).nullable().default(null),
  issues: z.array(checkIssueSchema).default([]),
  hints: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
});

/**
 * 组装批改 prompt。
 *
 * 刻意把"禁止给完整答案"写进 system 段的第一条：模型很容易一上来就把标准解写出来，
 * 那样用户就只是抄一遍，检查变成"答案生成器"。
 */
export function buildCheckPrompt(input: CheckInput): string {
  const lang = input.lang ?? 'zh';
  const lines: string[] = [];
  lines.push('你是一位德国大学的物理/数学 Übungsblatt 批改助教（Tutor）。你在**检查学生自己写的解答**，不是替他做题。');
  lines.push('');
  lines.push('## 硬性规则（违反即视为批改失败）');
  lines.push('1. **不要写出完整解答**。最多指出"哪一步不成立/缺少什么"，并给出**下一步该验证什么**。');
  lines.push('2. 只有当你**真的能判断**时才下结论；看不清/信息不足 → verdict="unclear" 并说明缺什么。');
  lines.push('3. 学生答案为空 → verdict="unclear"，issues 里说明"还没有答案"，hints 里给一个**破题问题**（不要给解法）。');
  lines.push('4. 不要臆造题目条件。题目文本里没有的东西，不要假设它存在。');
  lines.push('5. 数学表达式一律用 LaTeX（行内 `$...$`），保持题目原有的德语术语。');
  lines.push('');
  lines.push('## 输出格式（严格 JSON，不要 markdown 代码块，不要多余文字）');
  lines.push('{"verdict":"correct|partial|wrong|unclear","score":0.0,"issues":[{"severity":"error|warn|info","text":"…"}],"hints":["…"],"next_steps":["…"]}');
  lines.push('- verdict：correct=结论与关键步骤都对；partial=思路对但有关键错误/缺步骤；wrong=结论错误；unclear=无法判断');
  lines.push('- score：学生对**本题**的完成度自评 0..1（仅供参考）');
  lines.push('- issues：最多 4 条，按严重度排序；每条**不超过 60 字**，指出具体位置（"第二行把 $\\omega$ 当成常数了"）');
  lines.push('- hints：最多 2 条，苏格拉底式提问（"如果 $I$ 随时间变化，(2) 式还成立吗？"）');
  lines.push('- next_steps：最多 2 条，**具体动作**（"先对 $\\dot\\omega$ 求导再代入"），不要写推导');
  lines.push('- 输出必须是**完整、可解析**的 JSON（宁可少写一条，也不要在中途截断）');
  lines.push('');
  lines.push(`## 上下文`);
  lines.push(`- 课程：${input.courseTitle} · Übungsblatt ${input.sheetNumber}${input.sheetTitle ? `（${input.sheetTitle}）` : ''}`);
  lines.push(`- 题号：${input.problemLabel}${input.points != null ? `（${input.points} Punkte）` : ''}`);
  if (input.progressDigest) {
    lines.push('- 学生开这套题时的学习进度（用于调整语气与提示深度，不要直接念给他）：');
    for (const l of input.progressDigest.split('\n').slice(0, 12)) lines.push(`    ${l}`);
  }
  if (input.priorMistakes?.length) {
    lines.push('- 他以前在同类题上踩过的坑（如果这次又踩了，优先指出）：');
    for (const m of input.priorMistakes.slice(0, 5)) lines.push(`    · ${m.slice(0, 200)}`);
  }
  lines.push('');
  lines.push('## 题目原文');
  lines.push(input.problemText.trim() || '(题干缺失)');
  lines.push('');
  lines.push('## 学生的解答');
  lines.push(input.answer.trim() || '(空)');
  if (input.notes?.trim()) {
    lines.push('');
    lines.push('## 学生自己的备注');
    lines.push(input.notes.trim());
  }
  lines.push('');
  lines.push(
    lang === 'de'
      ? '请用德语写 issues/hints/next_steps。'
      : '请用**中文**写 issues/hints/next_steps（题目术语保留德语原文）。',
  );
  return lines.join('\n');
}

/**
 * 截断 JSON 的抢救修复（真机踩过）。
 *
 * 现象：模型把 issues 写得很长，`max_tokens` 在**字符串中间**截断，
 * 于是 `JSON.parse` 抛 "Unterminated string" —— 一次有效的批改（verdict=partial）
 * 被整条丢掉，界面上只剩"检查失败"，这是最糟的体验：用户白写了一遍。
 *
 * 做法（保守，绝不猜内容）：
 *   1. 去掉末尾不完整的片段（`"` 没闭合 → 补上闭合引号）
 *   2. 末尾如果是 `,` / `:` 这种悬空符号 → 退回到最后一个完整的 `,` 或 `{`
 *   3. 按扫描到的括号栈补齐 `}` / `]`
 * 补不出来的情况下调用方还有最后一层兜底（正则取 verdict）。
 */
export function repairTruncatedJson(text: string): string | null {
  const s = text.trim();
  if (!s.startsWith('{')) return null;

  /** 扫一遍：未闭合的括号栈 + 全部"安全切点"（紧跟 `{` / `[` / `,` 之后）。 */
  const scan = (src: string): { inString: boolean; closers: string[]; cuts: number[] } => {
    const closers: string[] = [];
    const cuts: number[] = [];
    let inString = false;
    let escaped = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{' || ch === '[') {
        closers.push(ch === '{' ? '}' : ']');
        cuts.push(i + 1);
        continue;
      }
      if (ch === '}' || ch === ']') {
        closers.pop();
        continue;
      }
      if (ch === ',') cuts.push(i + 1);
    }
    return { inString, closers, cuts };
  };

  // ① 字符串被截断：补一个闭合引号 —— 截断处的半句话**保留**为字段值，
  //    它通常正是最有信息量的那句"问题描述"，丢掉可惜。
  let body = s;
  if (scan(body).inString) body = `${body}"`;
  // ② 悬空分隔符（`...,` / `..."key":`）
  body = body.replace(/[,:]\s*$/, '');
  // ③ 悬空的**成员名**（`...,"text"` 但值还没写）→ 退到最后一个安全切点。
  //    注意：`:` 绝不能当切点 —— 切在它后面会留下 `{"text"` 这种非法结构
  //    （第一版就是这么错的，真机 JSON.parse 立刻报错）。
  if (/[{,]\s*"[^"]*"\s*$/.test(body)) {
    const { cuts } = scan(body);
    const cut = cuts.length ? cuts[cuts.length - 1]! : -1;
    if (cut > 0) body = body.slice(0, cut).replace(/[,:]\s*$/, '');
  }
  // ④ 按当前扫描结果补齐括号
  const { inString, closers } = scan(body);
  if (inString) body += '"';
  while (closers.length) body += closers.pop();
  return body;
}

/**
 * 解析模型输出。
 *
 * 三级策略（照 ripples-of-aion 的"抢救解析"思想）：
 *   ① 剥 ```json 围栏 + 取第一个 `{` 到最后一个 `}`
 *   ② 严格 zod 校验
 *   ③ 失败 → 抢救：补全被截断的 JSON；再失败 → 正则取 verdict
 *
 * 仍然解析不了 → 返回 null（调用方记一条 verdict=error 的检查，保留原文供排障）。
 */
export function parseCheckOutput(raw: string | null): ParsedCheck | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);

  const attempt = (json: string): unknown | null => {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  };

  let obj = attempt(candidate);
  if (obj === null) {
    const repaired = repairTruncatedJson(candidate);
    if (repaired) obj = attempt(repaired);
  }

  // 最后一层：连修复都失败 → 只要 verdict 能抠出来，就按"只有结论"处理
  if (obj === null) {
    const v = /"verdict"\s*:\s*"(correct|partial|wrong|unclear)"/.exec(candidate)?.[1];
    if (!v) return null;
    return { verdict: v as Verdict, score: null, issues: [], hints: [], next_steps: [] };
  }

  const parsed = parsedSchema.safeParse(obj);
  if (!parsed.success) {
    // 抢救：只要 verdict 在，其他字段给默认值也算成功
    const v = (obj as { verdict?: unknown }).verdict;
    if (typeof v === 'string' && ['correct', 'partial', 'wrong', 'unclear'].includes(v)) {
      const o = obj as { issues?: unknown; hints?: unknown; next_steps?: unknown; score?: unknown };
      return {
        verdict: v as Verdict,
        score: typeof o.score === 'number' ? o.score : null,
        issues: Array.isArray(o.issues)
          ? o.issues
              .map((i) => (typeof i === 'string' ? { severity: 'warn' as const, text: i } : (i as { severity?: 'error' | 'warn' | 'info'; text?: string })))
              .filter((i): i is { severity: 'error' | 'warn' | 'info'; text: string } => !!i && typeof i.text === 'string')
              .slice(0, 6)
          : [],
        hints: Array.isArray(o.hints) ? o.hints.filter((h): h is string => typeof h === 'string').slice(0, 3) : [],
        next_steps: Array.isArray(o.next_steps)
          ? o.next_steps.filter((h): h is string => typeof h === 'string').slice(0, 3)
          : [],
      };
    }
    return null;
  }
  return parsed.data as ParsedCheck;
}

/**
 * 跑一次检查。**不抛**：任何失败都折成 `{ ok:false, error }`，
 * 让上层能区分"模型挂了"与"答案错了"（前者不该进错题本）。
 */
export async function runCheck(
  input: CheckInput,
  askLlm: AskLlm,
): Promise<{ ok: boolean; check: ParsedCheck | null; raw: string | null; error?: string }> {
  const prompt = buildCheckPrompt(input);
  // 2400 token 是实测出来的：1200 时模型把 issues 写长会被**截断在字符串中间**，
  // 整条有效批改变成"解析失败"（真机第一次检查就踩到了）。
  const raw = await askLlm(prompt, { maxTokens: 2400, purpose: 'exercise-check' });
  if (!raw) return { ok: false, check: null, raw: null, error: 'LLM 不可用（无 apiKey / 请求失败 / 超时）' };
  const check = parseCheckOutput(raw);
  if (!check) return { ok: false, check: null, raw, error: 'LLM 输出不可解析（已保留原文供排障）' };
  return { ok: true, check, raw };
}
