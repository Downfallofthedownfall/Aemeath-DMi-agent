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
import { tr } from './locale.js';

/** LLM 通道（与 lecture 的 AskLlm 同形，便于复用同一种接线）。 */
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max';

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
      /** 单次调用的超时（批改给 180s：高推理 + 大预算，别被 60s 掐断） */
      timeoutMs?: number;
      /**
       * 推理强度（`off|low|high|max`）。批改/答辩默认 max —— "重在精不在快"；
       * 分块这类结构任务用 off。
       */
      reasoning?: ReasoningEffort;
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
  lang?: 'zh' | 'de' | 'en';
  /** 学生答案里附的手画图（多模态一起看：受力图/草图对判断很关键） */
  answerImages?: Array<{ base64: string; mediaType: string; name: string }>;
  /** 题目本身的截图/照片（极简模式：题目是拍/贴进来的，OCR 不可信 → 以图为准） */
  statementImages?: Array<{ base64: string; mediaType: string; name: string }>;
  /** 推理强度（批改默认 max：重在精不在快） */
  reasoning?: ReasoningEffort;
  /** 有原题页面截图时：附图检查（多模态），题干里可能有图/公式 OCR 不准。
   *  一道题**跨页**时会有多张（按页码升序）。 */
  pageImages?: Array<{ base64: string; mediaType: string; page: number }>;
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
 * 2026-10-22 大改（用户反馈"检查跟智障一样，模板答案都被说成一堆错误"）：
 *   ① **先自己独立解一遍**，再对照学生答案 —— 不这样做，模型会逐行"找不同"，
 *      把等价写法（$\sin\alpha$ vs $\sin(\alpha)$、$g$ vs $9.81$）都当成错；
 *   ② **只有数学上不成立才算 error**；记号/步骤详略/单位写法一律放 hints；
 *   ③ 结果一致 → `correct` + issues 空，**鼓励明确说"对"**；
 *   ④ 每条 issue 必须**引用学生原文片段**（≤30 字）+ 说明为什么错 —— 不许空泛；
 *   ⑤ 历史错题只是"过去"的记录，学生可能已改对，**不得当作当前答案的错误**。
 *
 * 刻意把"禁止给完整答案"写进第一条：模型很容易一上来就把标准解写出来，
 * 那样用户就只是抄一遍，检查变成"答案生成器"。
 */
export function buildCheckPrompt(input: CheckInput): string {
  const lang = input.lang ?? 'zh';
  const lines: string[] = [];
  lines.push('你是一位德国大学的物理/数学 Übungsblatt 批改助教（Tutor）。你在**检查学生自己写的解答**，不是替他做题。');
  lines.push('');
  lines.push('## 批改顺序（必须按这个顺序做）');
  lines.push('1. **先自己独立解一遍**：用题目条件推出你自己的结果（结论/关键式子），在草稿里完成，不要写进输出。');
  lines.push('2. **再对照学生答案**：只比较**数学内容**是否等价，逐项核对，写下差异。');
  lines.push('3. **最后下结论**：学生的结论与关键步骤和你一致 → `correct`，issues 留空。');
  lines.push('');
  lines.push('## 判定标准（这是本次批改的硬性口径）');
  lines.push('- **只有数学上不成立才算 `error`**：算错、用错公式、物理假设错、结论相反。');
  lines.push('- **下列都不算 error**，最多写进 hints：记号写法（$\\sin\\alpha$ vs $\\sin(\\alpha)$、$\\mathrm{d}$ vs $d$）、');
  lines.push('  步骤详略、单位写不写、中间式有没有跳步、排版和 LaTeX 写法、德语拼写。');
  lines.push('- 用了**等价但不同**的方法（能量法 vs 牛顿第二定律）→ 不算错。');
  lines.push('- 数值近似与理论值在 1% 内 → 不算错（不要把 $4.9$ 和 $4.905$ 判错）。');
  lines.push('- 题目没给的条件不要假设它存在；但学生答案里**明确写出的假设**要按它来判断。');
  lines.push('');
  lines.push('## 不给答案 / 不臆造');
  lines.push('1. **不要写出完整解答**。最多指出"哪一步不成立"，并给出**下一步该验证什么**。');
  lines.push('2. 看不清/信息不足 → verdict="unclear" 并说明缺什么。');
  lines.push('3. 学生答案为空 → verdict="unclear"，issues 说"还没有答案"，hints 给一个**破题问题**。');
  lines.push('4. **算不出来就放弃**：推理/推导很久仍确定不了对错时，直接给 `unclear` 并说明卡在哪（缺条件、图看不清、需要数值），');
  lines.push('   **不要为了凑出结论而硬判**，也不要编造一个"可能的问题"。宁可不判，也不要误判。');
  lines.push('5. 数学表达式一律用 LaTeX（行内 `$...$`），保持题目原有的德语术语。');
  lines.push('');
  lines.push('## 输出格式（严格 JSON，不要 markdown 代码块，不要多余文字）');
  lines.push('{"verdict":"correct|partial|wrong|unclear","score":0.0,"issues":[{"severity":"error|warn|info","text":"…"}],"hints":["…"],"next_steps":["…"]}');
  lines.push('- verdict：correct=结论与关键步骤都对（**对就说对**）；partial=结论对但关键一步有错/缺；wrong=结论错；unclear=无法判断');
  lines.push('- score：学生对**本题**的完成度自评 0..1（仅供参考）');
  lines.push('- issues：**最多 3 条**，只放真的错误；每条格式 `引用学生原话（≤30 字）→ 为什么不成立（≤40 字）`，');
  lines.push('  例：`"a = g sin α" → 把法向力也算进了沿斜面方向，应为 $a=g\\sin\\alpha$`。没有错误就不要写。');
  lines.push('- hints：最多 2 条，苏格拉底式提问（"如果 $I$ 随时间变化，(2) 式还成立吗？"）');
  lines.push('- next_steps：最多 2 条，**具体动作**（"先对 $\\dot\\omega$ 求导再代入"），不要写推导');
  lines.push('- 输出必须是**完整、可解析**的 JSON（宁可少写一条，也不要在中途截断）');
  lines.push('');
  lines.push(`## 上下文`);
  lines.push(`- 课程：${input.courseTitle} · Übungsblatt ${input.sheetNumber}${input.sheetTitle ? `（${input.sheetTitle}）` : ''}`);
  lines.push(`- 题号：${input.problemLabel}${input.points != null ? `（${input.points} Punkte）` : ''}`);
  if (input.statementImages?.length) {
    lines.push(
      `- **题目以图片形式提供**（${input.statementImages.length} 张，见附件，排在原题截图之前）：` +
        '题干文字可能是 OCR/手打的，**以图为准**；图里的公式、坐标系、示意图都要读。',
    );
  }
  if (input.answerImages?.length) {
    lines.push(
      `- **学生答案里附了 ${input.answerImages.length} 张手画图**（见附件，排在原题图之后）。` +
        '他的受力图/草稿可能只画在图上 —— 把图里的内容也算进答案再判断。',
    );
  }
  if (input.pageImages?.length) {
    const pages = input.pageImages.map((p) => p.page).join('、');
    lines.push(
      `- **本题原图见附件**（原卷第 ${pages} 页截图${input.pageImages.length > 1 ? '，**一道题跨页了：要把这些页连起来读**' : ''}）。` +
        `OCR 文本可能漏掉公式/插图，**以图片为准**；题干里的图、示意图、坐标系都在图上。判断学生答案时优先依据图。`,
    );
  }
  if (input.progressDigest) {
    lines.push('- 学生开这套题时的学习进度（用于调整语气与提示深度，不要直接念给他）：');
    for (const l of input.progressDigest.split('\n').slice(0, 12)) lines.push(`    ${l}`);
  }
  if (input.priorMistakes?.length) {
    lines.push(
      '- **过去的**错题记录（不是本题当前答案的一部分；学生可能已经改对了）。' +
        '只用于：如果**当前答案里**重现了同样的错误，可以在 hints 里点一句；' +
        '**不得**把它们当成当前答案的错误写进 issues，也不要暗示"你还在犯这个错"。',
    );
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
      : lang === 'en'
        ? 'Write issues/hints/next_steps in **English** (keep German problem terms as they are).'
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
/**
 * 宽松 JSON 解析。模型输出里最常见的两种"坏味"：
 *   ① **非法转义**：把 LaTeX 的 `\,` `\;` `\!` 直接写进 JSON 字符串
 *      （JSON 只认 `\" \\ \/ \b \f \n \r \t \uXXXX`）→ 整条 JSON.parse 失败。
 *      真机踩过：多模态检查明明给了 4 条 issues，解析却是 0 条。
 *   ② **被截断**：max_tokens 砍在字符串中间。
 * 依次尝试 原样 → 修转义 → 截断抢救，任一成功即返回对象。
 */
export function parseJsonLoose(text: string): unknown | null {
  const attempt = (s: string): unknown | null => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const escapeFix = (s: string): string => s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');

  const direct = attempt(text);
  if (direct !== null) return direct;

  const fixed = escapeFix(text);
  const afterFix = attempt(fixed);
  if (afterFix !== null) return afterFix;

  for (const candidate of [fixed, text]) {
    const repaired = repairTruncatedJson(candidate);
    if (!repaired) continue;
    const obj = attempt(repaired) ?? attempt(escapeFix(repaired));
    if (obj !== null) return obj;
  }
  return null;
}

export function parseCheckOutput(raw: string | null): ParsedCheck | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);

  let obj = parseJsonLoose(candidate);

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
 *
 * 传了 `askVision` 且题目有页面截图时走**多模态**（图 + 学生答案）：
 * OCR 漏掉的公式/插图在图上还在，判得更准。
 */
export async function runCheck(
  input: CheckInput,
  askLlm: AskLlm,
  askVision?: (
    prompt: string,
    images: readonly { mediaType: string; base64: string }[],
    opts: { maxTokens: number; purpose: string; reasoning?: ReasoningEffort; timeoutMs?: number },
  ) => Promise<string | null>,
): Promise<{ ok: boolean; check: ParsedCheck | null; raw: string | null; error?: string; vision?: boolean }> {
  const prompt = buildCheckPrompt(input);
  // 2400 token 是实测出来的：1200 时模型把 issues 写长会被**截断在字符串中间**，
  // 整条有效批改变成"解析失败"（真机第一次检查就踩到了）。
  // 图片：原题截图在前，学生手画图在后（prompt 里也按这个顺序描述的）
  const images = [
    // 顺序与 prompt 描述一致：题目截图 → 原卷页 → 学生手画图
    ...(input.statementImages ?? []).map((i) => ({ mediaType: i.mediaType, base64: i.base64 })),
    ...(input.pageImages ?? []).map((i) => ({ mediaType: i.mediaType, base64: i.base64 })),
    ...(input.answerImages ?? []).map((i) => ({ mediaType: i.mediaType, base64: i.base64 })),
  ];
  const vision = images.length && askVision ? askVision : undefined;
  // 检查追求"精"不追求"快"：推理默认 max（见 config.llm.checkReasoning），token 也给足，
  // 否则高推理会把预算烧在 reasoning 上、正文被截断（真机踩过）。
  const raw = vision
    ? await vision(prompt, images, {
        maxTokens: 32000,
        purpose: 'exercise-check-vision',
        reasoning: input.reasoning,
        timeoutMs: 180_000,
      })
    : await askLlm(prompt, { maxTokens: 32000, purpose: 'exercise-check', reasoning: input.reasoning, timeoutMs: 180_000 });
  if (!raw) {
    return {
      ok: false,
      check: null,
      raw: null,
      error: tr('LLM 不可用（无 apiKey / 请求失败 / 超时）', 'LLM unavailable (no apiKey / request failed / timed out)'),
      vision: !!vision,
    };
  }
  const check = parseCheckOutput(raw);
  if (!check) return { ok: false, check: null, raw, error: tr('LLM 输出不可解析（已保留原文供排障）', 'LLM output could not be parsed (raw output kept for debugging)'), vision: !!vision };
  return { ok: true, check, raw, vision: !!vision };
}

// ============================================================
// 答辩（用户："最好加一个和爱弥斯对线答辩我的答案的功能"）
//
// 场景：批改说答案错了，学生认为自己对 —— 让模型**重新独立推导**，
// 并且必须二选一：
//   · 学生确实对 → `conceded`（承认自己批错，并指出自己错在哪）
//   · 学生确实错 → `upheld`（给出**具体反例/代入数值**，不能只是重复原判）
//   · 说不清 → `partial`（指出双方各自哪里不对）
//
// 关键设计：把"原检查的 issues"作为**待反驳的主张**交进去（不是事实），
// 这样模型不会理所当然地维护自己上一次的结论。
// ============================================================


// ============================================================
// 思路检查（做题中途）：只挑"走歪了"，不给解法
//
// 用户 2026-10-28："做题做一半的时候 LLM 检查做题思路和路径，避免让 llm 写出解题方法，
//   只要指出错误点，避免白白浪费时间科技树点歪，尽量保守提示。"
//
// 设计约束（都写进 prompt，不靠模型自觉）：
//   ① 禁止给解法/步骤/公式/答案/中间结果 —— 一旦给了，这个功能就变成"代做"；
//   ② 只在**明确**不成立时提（物理前提、漏条件、方法不适用、量纲、数学上不成立）；
//   ③ 最多 2 条，每条只说"哪里不成立/缺什么"，不说怎么改；
//   ④ 不确定就不提（宁可漏报，不要误报打断思路）。
// ============================================================

export interface ApproachInput {
  courseTitle: string;
  sheetNumber: number;
  sheetTitle: string;
  problemLabel: string;
  problemTitle: string;
  points: number | null;
  problemText: string;
  /** 当前草稿（可能只有半页） */
  draft: string;
  notes?: string;
  /** 题目截图 / 页面截图 / 手画图（多模态一起看） */
  statementImages?: Array<{ base64: string; mediaType: string; name: string }>;
  pageImages?: Array<{ base64: string; mediaType: string; page: number }>;
  answerImages?: Array<{ base64: string; mediaType: string; name: string }>;
  lang: 'zh' | 'de' | 'en';
}

const APPROACH_VERDICTS = ['on_track', 'at_risk', 'wrong', 'unclear'] as const;
export type ApproachVerdict = (typeof APPROACH_VERDICTS)[number];

export interface ParsedApproach {
  verdict: ApproachVerdict;
  issues: Array<{ severity: 'error' | 'warn' | 'info'; text: string }>;
  note: string;
}

export function buildApproachPrompt(input: ApproachInput): string {
  const zh = input.lang === 'zh';
  const de = input.lang === 'de';
  const L = (zhText: string, deText: string, enText: string): string => (zh ? zhText : de ? deText : enText);

  const lines: string[] = [];
  lines.push(
    L(
      '你是一位严格的物理/数学助教。学生**正在做题**，做到一半把当前草稿给你看。',
      'Du bist ein strenger Physik-/Mathe-Tutor. Die/der Studierende **rechnet gerade** und zeigt dir den halbfertigen Entwurf.',
      'You are a strict physics/maths tutor. The student is **in the middle of solving** and shows you the current draft.',
    ),
  );
  lines.push('');
  lines.push(
    L(
      '## 你这次只做一件事：判断"思路/路径"有没有明显走歪\n' +
        '- **绝对不要**给出解题方法、步骤、公式变形、答案或任何中间结果；不要提示"先算 X 再算 Y"。\n' +
        '- 也不要在心里替他做完再"暗示"。你只做**路牌**，不做导航。',
      '## Deine einzige Aufgabe: prüfen, ob der **Lösungsweg** klar in die falsche Richtung läuft\n' +
        '- **Keine** Lösungsmethode, keine Schritte, keine Formeln, keine Ergebnisse, keine Zwischenwerte; kein "erst X, dann Y".\n' +
        '- Du bist ein Wegweiser, kein Navi.',
      '## Your only job: check whether the **approach** is clearly heading the wrong way\n' +
        '- **Never** give a method, steps, formula manipulations, answers or intermediate results; no "first X, then Y".\n' +
        '- You are a signpost, not a navigator.',
    ),
  );
  lines.push('');
  lines.push(
    L(
      '## 只有这些情况才算"错误点"（保守优先）\n' +
        '1. 物理前提/适用条件明显不成立（例：有摩擦却按无摩擦列方程；非惯性系漏惯性力；把刚体当质点）。\n' +
        '2. **明确**漏掉关键条件或已知量，且这个漏项必然导致结果错。\n' +
        '3. 方法从根本上不适用（例：非保守力做功却直接套机械能守恒）。\n' +
        '4. 量纲/单位明显不对。\n' +
        '5. 数学上明显不成立（例：把发散的积分硬拆、在奇点处直接代入）。\n\n' +
        '以下**不要提**：不确定的、只是"可能更简单"的、符号/写法风格、"你可以再想想"这类空话。\n' +
        '**宁可漏报，也不要误报** —— 误报会打断他的思路，比不报更糟。',
      '## Nur diese Fälle zählen als Fehler (konservativ!)\n' +
        '1. Physikalische Voraussetzung/Gültigkeit klar verletzt (z. B. Reibung ignoriert, Trägheitskraft im beschleunigten System vergessen).\n' +
        '2. Eine **klar** fehlende Randbedingung/Gegebene, die zwingend zum falschen Ergebnis führt.\n' +
        '3. Methode grundsätzlich ungeeignet (z. B. Energieerhaltung trotz nichtkonservativer Kräfte).\n' +
        '4. Einheiten/Dimensionen offensichtlich falsch.\n' +
        '5. Mathematisch offensichtlich falsch (z. B. divergentes Integral aufspalten).\n\n' +
        'Nicht nennen: Unsicheres, "vielleicht einfacher", reine Schreibweise, leere Floskeln.\n' +
        '**Lieber auslassen als falsch alarmieren.**',
      '## Only these count as error points (be conservative)\n' +
        '1. The physical premise clearly fails (friction ignored, inertial force missing, treating a rigid body as a point mass).\n' +
        '2. A **clear** missing constraint/given that unavoidably produces a wrong result.\n' +
        '3. The method is fundamentally inapplicable (energy conservation with non-conservative work).\n' +
        '4. Units/dimensions obviously wrong.\n' +
        '5. Mathematically obviously invalid (splitting a divergent integral, substituting at a singularity).\n\n' +
        'Do not mention: anything uncertain, "maybe simpler", style, or empty encouragement.\n' +
        '**Better to miss than to false-alarm.**',
    ),
  );
  lines.push('');
  lines.push(
    L(
      '## 输出（严格 JSON，不要 Markdown 包裹）\n' +
        '{"verdict":"on_track|at_risk|wrong|unclear","issues":[{"severity":"error|warn","text":"一句话：哪里不成立/缺什么"}],"note":"一句话补充"}\n' +
        '- verdict：`on_track`=没看到明显问题，可以继续；`at_risk`=有疑点但不致命；`wrong`=明确走歪；`unclear`=草稿太少看不出来。\n' +
        '- issues 最多 2 条；**只说"哪里不成立"，不说怎么改**；不确定就留空。\n' +
        '- note：可以是一句"这步没问题"，也可以是"继续写，我再看"；不要借 note 夹带解法。',
      '## Ausgabe (striktes JSON)\n' +
        '{"verdict":"on_track|at_risk|wrong|unclear","issues":[{"severity":"error|warn","text":"ein Satz: was gilt nicht / fehlt"}],"note":"ein Satz"}\n' +
        '- verdict: on_track = kein klares Problem; at_risk = Zweifel; wrong = klar falsche Richtung; unclear = zu wenig Entwurf.\n' +
        '- höchstens 2 issues; **nur was nicht gilt, nicht wie man es behebt**.\n' +
        '- note: ein Satz, keine Lösung.',
      '## Output (strict JSON)\n' +
        '{"verdict":"on_track|at_risk|wrong|unclear","issues":[{"severity":"error|warn","text":"one sentence: what does not hold / is missing"}],"note":"one sentence"}\n' +
        '- verdict: on_track = nothing clearly wrong; at_risk = doubt; wrong = clearly off track; unclear = draft too thin.\n' +
        '- at most 2 issues; **only what fails, never how to fix it**.\n' +
        '- note: one sentence, no solution.',
    ),
  );

  lines.push('');
  lines.push(
    L(`# 题目（${input.courseTitle}）`, `# Aufgabe (${input.courseTitle})`, `# Problem (${input.courseTitle})`),
  );
  lines.push(
    L(
      `- 题号：${input.problemLabel}${input.points != null ? `（${input.points} 分）` : ''}`,
      `- Aufgabe: ${input.problemLabel}${input.points != null ? ` (${input.points} P.)` : ''}`,
      `- Problem: ${input.problemLabel}${input.points != null ? ` (${input.points} pts)` : ''}`,
    ),
  );
  if (input.problemTitle) lines.push(`- ${input.problemTitle}`);
  lines.push('');
  lines.push(L('## 题干', '## Angabe', '## Statement'));
  lines.push(input.problemText.trim() || L('（题干缺失，只有图片）', '(keine Angabe, nur Bild)', '(no statement, image only)'));

  if (input.statementImages?.length) {
    lines.push('');
    lines.push(
      L(
        `## 题目的图片（${input.statementImages.length} 张，见附件，以图为准）`,
        `## Aufgabenbilder (${input.statementImages.length}, siehe Anhang)`,
        `## Problem images (${input.statementImages.length}, attached, authoritative)`,
      ),
    );
  }
  if (input.pageImages?.length) {
    const pages = input.pageImages.map((p) => p.page).join('、');
    lines.push('');
    lines.push(
      L(
        `## 原卷截图：第 ${pages} 页${input.pageImages.length > 1 ? '（跨页：连起来读）' : ''}`,
        `## Originalseiten: ${pages}`,
        `## Sheet pages: ${pages}`,
      ),
    );
  }

  lines.push('');
  lines.push(L('## 学生的当前草稿（可能只写了一半）', '## Aktueller Entwurf (evtl. halb fertig)', '## Current draft (maybe half done)'));
  lines.push(input.draft.trim() || L('（还是空的）', '(noch leer)', '(still empty)'));
  if (input.notes?.trim()) {
    lines.push('');
    lines.push(L(`## 学生自己写的备注：${input.notes.trim()}`, `## Notiz: ${input.notes.trim()}`, `## Student note: ${input.notes.trim()}`));
  }
  lines.push('');
  lines.push(
    L(
      '现在只检查路径，不要解题。输出 JSON。',
      'Prüfe jetzt nur den Weg, löse nicht. Gib JSON aus.',
      'Now check only the path, do not solve. Output JSON.',
    ),
  );
  return lines.join('\n');
}

export function parseApproachOutput(raw: string | null): ParsedApproach | null {
  if (!raw) return null;
  const obj = parseJsonLoose(raw) as Record<string, unknown> | null;
  if (!obj) return null;
  const verdict = typeof obj.verdict === 'string' && (APPROACH_VERDICTS as readonly string[]).includes(obj.verdict)
    ? (obj.verdict as ApproachVerdict)
    : 'unclear';
  const issues = Array.isArray(obj.issues)
    ? obj.issues
        .map((x) => {
          const item = x as Record<string, unknown>;
          const text = typeof item.text === 'string' ? item.text.trim() : '';
          if (!text) return null;
          const sev = item.severity === 'error' || item.severity === 'warn' ? item.severity : 'warn';
          return { severity: sev as 'error' | 'warn', text };
        })
        .filter((x): x is { severity: 'error' | 'warn'; text: string } => !!x)
        .slice(0, 2)
    : [];
  const note = typeof obj.note === 'string' ? obj.note.trim() : '';
  return { verdict, issues, note };
}

/** 跑一次思路检查。故意**不复用**批改的 prompt/结果，避免"批改结论"泄漏答案。 */
export async function runApproach(
  input: ApproachInput,
  askLlm: AskLlm,
  askVision?: (
    prompt: string,
    images: readonly { mediaType: string; base64: string }[],
    opts: { maxTokens: number; purpose: string; reasoning?: ReasoningEffort; timeoutMs?: number },
  ) => Promise<string | null>,
): Promise<{ ok: boolean; parsed: ParsedApproach | null; raw: string; error?: string }> {
  const prompt = buildApproachPrompt(input);
  const images = [
    ...(input.statementImages ?? []).map((i) => ({ mediaType: i.mediaType, base64: i.base64 })),
    ...(input.pageImages ?? []).map((i) => ({ mediaType: i.mediaType, base64: i.base64 })),
    ...(input.answerImages ?? []).map((i) => ({ mediaType: i.mediaType, base64: i.base64 })),
  ];
  const vision = images.length && askVision ? askVision : undefined;
  const raw = vision
    ? ((await vision(prompt, images, {
        maxTokens: 16_000,
        purpose: 'exercise-approach',
        reasoning: 'high',
        timeoutMs: 120_000,
      })) ?? '')
    : await askLlm(prompt, {
        maxTokens: 16_000,
        purpose: 'exercise-approach',
        reasoning: 'high',
        timeoutMs: 120_000,
      });
  if (!raw || !raw.trim()) return { ok: false, parsed: null, raw: '', error: 'empty response' };
  const parsed = parseApproachOutput(raw);
  if (!parsed) return { ok: false, parsed: null, raw, error: 'unparseable JSON' };
  return { ok: true, parsed, raw };
}
export interface RebuttalInput {
  check: CheckInput;
  /** 上一次检查的结论与 issues（作为"被质疑的主张"） */
  previous: Pick<ParsedCheck, 'verdict' | 'issues'>;
  /** 本轮学生说的话 */
  userText: string;
  /** 之前几轮（旧→新） */
  history?: Array<{ user: string; ai: string; outcome: string }>;
  /** 推理强度（默认 max：答辩同样重在精不在快） */
  reasoning?: ReasoningEffort;
}

export interface ParsedRebuttal {
  outcome: 'conceded' | 'upheld' | 'partial';
  /** 给学生的回复（讲道理，不是重复原判） */
  reply: string;
  /** 原检查里被撤回的 issues（0 基下标） */
  withdrawn: number[];
  /** 如果仍然坚持：新增/修正的问题 */
  remaining: Array<{ severity: 'error' | 'warn' | 'info'; text: string }>;
  /** 学生答案里对的部分（先承认对的部分） */
  correct_parts: string[];
}

const rebuttalSchema = z.object({
  outcome: z.enum(['conceded', 'upheld', 'partial']).default('partial'),
  reply: z.string().default(''),
  withdrawn: z.array(z.number().int().min(0)).default([]),
  remaining: z.array(checkIssueSchema).default([]),
  correct_parts: z.array(z.string()).default([]),
});

export function buildRebuttalPrompt(input: RebuttalInput): string {
  const { check, previous, userText, history } = input;
  const lines: string[] = [];
  lines.push('你是一位德国大学的 Übungsblatt 批改助教。学生对你之前的批改提出**答辩**，你要认真复核，不要为了维护面子坚持错误结论。');
  lines.push('');
  lines.push('## 你的任务（按顺序）');
  lines.push('1. **忘掉之前的结论，从题目条件重新独立推导一遍**（先在草稿里算，不要写进输出）。');
  lines.push('2. 判断学生这次说的事实/推理是否成立：他指出你误读了他的答案？还是他的推导确实对？');
  lines.push('3. 明确三选一：');
  lines.push('   - `conceded`：**学生是对的**，你之前批错了 → `withdrawn` 列出要撤回的 issues 下标，');
  lines.push('     `reply` 里说清楚"我错在哪"（哪一步看错/算错），不要客套。');
  lines.push('   - `upheld`：学生是错的 → `reply` 必须给出**具体证据**：代入具体数值/给出反例/指出他这一步的符号或物理错误；');
  lines.push('     **不允许**只重复原结论或用"教材上就是这样"敷衍。');
  lines.push('   - `partial`：双方各对一部分 → 分别说清。');
  lines.push('4. 任何时候都要先承认学生答案里**对的部分**（`correct_parts`）。');
  lines.push('');
  lines.push('## 口径（与批改一致）');
  lines.push('- 只有数学/物理上不成立才是错；记号、步骤详略、单位写法不算错。');
  lines.push('- 数值差在 1% 内算对。用了等价方法（能量法 vs 牛顿定律）算对。');
  lines.push('- 你看不清题目（OCR 缺失）就承认，不要把缺失当成学生的错。');
  lines.push('- **算不出来就放弃**：反复推导仍确定不了对错时，给 partial 并说明卡在哪（缺条件/看不清/需要数值），');
  lines.push('  不要为了分出胜负而硬判，也不要编造证据。');
  lines.push('');
  lines.push('## 输出格式（严格 JSON，不要代码块）');
  lines.push('{"outcome":"conceded|upheld|partial","reply":"…","withdrawn":[0,2],"remaining":[{"severity":"error|warn|info","text":"…"}],"correct_parts":["…"]}');
  lines.push(
    check.lang === 'en'
      ? '- `reply`: ≤200 words, in **English**; use inline `$...$` for math.'
      : '- `reply`：≤200 字，中文，讲清道理；数学用行内 `$...$`。',
  );
  lines.push('- `withdrawn`：原检查里被撤回的 issues 的**下标**（0 开始）；没有就空数组。');
  lines.push('- `remaining`：你仍然坚持的问题（最多 2 条），每条必须能落到学生答案的**具体片段**上。');
  lines.push('');
  lines.push('## 上下文');
  lines.push(`- 课程：${check.courseTitle} · Übungsblatt ${check.sheetNumber}${check.sheetTitle ? `（${check.sheetTitle}）` : ''}`);
  lines.push(`- 题号：${check.problemLabel}${check.points != null ? `（${check.points} Punkte）` : ''}`);
  lines.push('');
  lines.push('## 题目原文');
  lines.push(check.problemText.trim() || '(题干缺失)');
  lines.push('');
  lines.push('## 学生的解答（当前版本）');
  lines.push(check.answer.trim() || '(空)');
  if (check.notes?.trim()) {
    lines.push('');
    lines.push('## 学生备注');
    lines.push(check.notes.trim());
  }
  lines.push('');
  lines.push('## 你上一次的批改（**被质疑的主张**，不是事实）');
  lines.push(`verdict: ${previous.verdict}`);
  previous.issues.forEach((i, idx) => lines.push(`  [${idx}] (${i.severity}) ${i.text}`));
  if (!previous.issues.length) lines.push('  （当时 issues 为空）');
  if (history?.length) {
    lines.push('');
    lines.push('## 之前几轮答辩（旧→新）');
    for (const h of history.slice(-4)) {
      lines.push(`- 学生：${h.user.slice(0, 200)}`);
      lines.push(`  你（${h.outcome}）：${h.ai.slice(0, 200)}`);
    }
  }
  lines.push('');
  lines.push('## 学生这一轮的答辩');
  lines.push(userText.trim());
  lines.push('');
  lines.push(
    check.lang === 'en'
      ? 'Write `reply`/`remaining`/`correct_parts` in **English** (keep German problem terms as they are).'
      : '请用**中文**写 `reply`/`remaining`/`correct_parts`（题目术语保留德语原文）。',
  );
  return lines.join('\n');
}

/** 解析答辩输出（宽松 JSON + 兜底）。 */
export function parseRebuttal(raw: string): ParsedRebuttal | null {
  const m = /\{[\s\S]*\}/.exec(raw.trim());
  if (!m) return null;
  const obj = parseJsonLoose(m[0]);
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const outcome =
    o.outcome === 'conceded' || o.outcome === 'upheld' || o.outcome === 'partial' ? o.outcome : 'partial';
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
  const withdrawn = Array.isArray(o.withdrawn)
    ? o.withdrawn.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    : [];
  const remaining: ParsedRebuttal['remaining'] = Array.isArray(o.remaining)
    ? o.remaining
        .map((i) => (typeof i === 'string' ? { severity: 'warn' as const, text: i } : (i as { severity?: 'error' | 'warn' | 'info'; text?: string })))
        .filter((i): i is { severity: 'error' | 'warn' | 'info'; text: string } => !!i && typeof i.text === 'string' && !!i.text.trim())
        .slice(0, 4)
    : [];
  const parsed = rebuttalSchema.safeParse({ outcome, reply: typeof o.reply === 'string' ? o.reply : '', withdrawn, remaining, correct_parts: asStrings(o.correct_parts) });
  if (!parsed.success) return null;
  return parsed.data as ParsedRebuttal;
}

/**
 * 跑一轮答辩。与 `runCheck` 一样**不抛**：失败折成 `{ ok:false }`。
 */
export async function runRebuttal(
  input: RebuttalInput,
  askLlm: AskLlm,
  askVision?: (
    prompt: string,
    images: readonly { mediaType: string; base64: string }[],
    opts: { maxTokens: number; purpose: string; reasoning?: ReasoningEffort; timeoutMs?: number },
  ) => Promise<string | null>,
): Promise<{ ok: boolean; rebuttal: ParsedRebuttal | null; raw: string | null; error?: string }> {
  const prompt = buildRebuttalPrompt(input);
  const images = [
    ...(input.check.pageImages ?? []).map((i) => ({ mediaType: i.mediaType, base64: i.base64 })),
    ...(input.check.statementImages ?? []).map((i) => ({ mediaType: i.mediaType, base64: i.base64 })),
    ...(input.check.answerImages ?? []).map((i) => ({ mediaType: i.mediaType, base64: i.base64 })),
  ];
  const vision = images.length && askVision ? askVision : undefined;
  const raw = vision
    ? await vision(prompt, images, { maxTokens: 20000, purpose: 'exercise-rebut', reasoning: input.reasoning, timeoutMs: 180_000 })
    : await askLlm(prompt, { maxTokens: 20000, purpose: 'exercise-rebut', reasoning: input.reasoning, timeoutMs: 180_000 });
  if (!raw) return { ok: false, rebuttal: null, raw: null, error: tr('LLM 不可用（无 apiKey / 请求失败 / 超时）', 'LLM unavailable (no apiKey / request failed / timed out)') };
  const rebuttal = parseRebuttal(raw);
  if (!rebuttal) return { ok: false, rebuttal: null, raw, error: tr('答辩输出不可解析（已保留原文）', 'Rebuttal output could not be parsed (raw output kept)') };
  return { ok: true, rebuttal, raw };
}
