// ============================================================
// transcriber.ts — 课堂内 LLM 转录员（D3）
//
// 角色边界（严格，见 docs/lecture-mode-plan.md §1 D3 / §5）：
//   ✅ 允许：公式 LaTeX 补全、明显错字修正、按标记语法分块
//   ❌ 禁止：核心概念、逻辑连接、检查问题、结构化摘要
//           —— 这些是"替你完成理解"，破坏课后主动回忆（D4）
//
// **输出只落后端，绝不回显前端**（前端按 source.kind='aemeath-lecture' 过滤）。
//
// 本模块的 prompt 构造是纯函数，可单测；LLM 调用走注入的 askLlm 回调，
// 便于测试注入假实现（照 memory/insights.ts 的 Consolidator 模式）。
// ============================================================

import { parseShorthand, textsOfKind, type ShorthandLine } from './types.js';
import { INSTITUTIONAL_NOTATION } from './symbol-data.js';

/** LLM 通道：返回文本或 null（失败/无 key）。实现方负责超时与错误吞掉。 */
/**
 * 调用 LLM。
 *
 * `json` 决定是否要求结构化 JSON 输出（`response_format: json_object`）。
 *
 * ⚠️ **默认 false**，需要 JSON 的调用必须显式声明。
 *
 * 早先的实现对所有调用都硬塞 `response_format: json_object`，于是：
 *   DeepSeek 返回 400 —— "Prompt must contain the word 'json' in some form
 *   to use 'response_format' of type 'json_object'"。
 * 而「补漏」这一步要的是**一句自然语言的追问**，prompt 里本来就不该有 json 字样，
 * 结果第 3 步的每次调用都失败、输出恒为空。
 *
 * 默认 false 是刻意的：将来新增纯文本 prompt 时不会再撞上同一个坑。
 *
 * `maxTokens` **一般不要传**。
 *
 * 推理模型的思考 token 也计入 `max_tokens`，而思考能占到六成以上
 * （实测某次 candidates：completion 2404 里 1571 是思考）。
 * 定一个"看起来够大"的数只会把截断点往后挪一点，笔记本就是会撞上。
 * 不传时由 API 用默认上限（实测 18000+ token 仍能正常 `stop`），
 * 配合 `reasoning_effort: 'high'` 让模型自己决定想多久。
 */
export type AskLlm = (
  prompt: string,
  opts: { purpose: string; json?: boolean; maxTokens?: number },
) => Promise<string | null>;

/**
 * 记号约定段 —— **从 INSTITUTIONAL_NOTATION 生成**，不手写字面量。
 *
 * 为什么要生成：这份约定同时决定"符号边栏放什么"和"转录员不许改什么"。
 * 若两处各写一份，将来改了一处（比如教授换成全箭头）就会漂移——
 * 边栏给的是半箭头、转录员却把它改成全箭头，笔记当场自相矛盾。
 * 单一数据源（symbol-data.ts）保证两者永远一致。
 */
function notationBlock(): string {
  return [
    '【记号约定：只能补语法，不能改记号】',
    '课堂上使用的记号是固定的，你**不允许**把用户的记号"规范化"成别的写法：',
    `- ${INSTITUTIONAL_NOTATION.timeDerivative}`,
    `- ${INSTITUTIONAL_NOTATION.otherDerivative}`,
    `- ${INSTITUTIONAL_NOTATION.vector}`,
    '- 希腊字母、上下标、求和/连乘的上下限等，一律保持用户所写',
    '',
    '理由：这些记号是这门课/这位教授的习惯，改了会让笔记与板书对不上。',
  ].join('\n');
}

/**
 * 转录员系统提示词。
 *
 * 关键设计：**显式列出禁止项**，并要求「不得新增用户没说过的内容」。
 * 这不是可选的润色——它是 D3 边界的技术落点。
 */
export const TRANSCRIBER_PROMPT = `你是一个课堂速记的**转录员**，不是助教。

你的唯一任务是让用户的速记变得**规范、可检索**。你必须遵守：

【可以做的】
1. 把简写公式补成规范 LaTeX（如 "hbar^2/2m" → "\\\\frac{\\\\hbar^2}{2m}"）
2. 修正明显的错别字与拼写错误
3. 保留用户的分块结构

【绝对不可以做的】
1. 不要补充任何用户没说过的物理概念、定义、推导或解释
2. 不要生成"核心概念""逻辑连接""检查问题""总结"之类的结构化内容
3. 不要评价内容是否正确，不要纠正物理错误（那是课后复盘的事）
4. 不要扩写、不要举例、不要补充背景知识

${notationBlock()}

如果某处内容你无法确定（比如一个模糊的符号），**原样保留并在该处标注 [待验证]**，
绝对不要猜测填充。

【输出格式】
纯 JSON，不要输出其他任何内容：
{"formulas":[{"shorthand":"用户原文","latex":"规范 LaTeX"}],"processed":"逐行规范化后的文本"}

其中：
- formulas：只包含 = 开头的公式行；latex 用标准 LaTeX 数学记号（不带 $ 包裹）
- processed：把用户的速记行按原顺序输出，公式行用补全后的 LaTeX 替换，
  其余行只做错字修正；**行数与含义必须与输入一致**。`;

/** 构造转录员 user 提示词（纯函数，可单测）。 */
export function buildTranscribePrompt(lines: readonly ShorthandLine[]): string {
  const body = lines
    .filter((l) => l.text)
    .map((l) => `${l.kind === 'formula' ? '=' : l.kind === 'question' ? '?' : l.kind === 'keypoint' ? '!' : l.kind === 'example' ? '>' : ''}${l.text}`)
    .join('\n');
  const formulas = textsOfKind(lines, 'formula');
  return [
    '以下是用户课堂速记的原始内容（保留原始顺序）：',
    '```',
    body,
    '```',
    formulas.length ? `其中公式行共 ${formulas.length} 条，请逐条补全 LaTeX。` : '本次没有公式行。',
    '请按系统提示的 JSON 格式输出。记住：不要新增用户没说过的内容。',
  ].join('\n');
}

export interface TranscribeResult {
  formulas: Array<{ shorthand: string; latex: string }>;
  processed: string;
}

/**
 * 解析 LLM 输出。**宽容解析**（照 memory 的 parseLlmJson 抢救思路）：
 * LLM 可能包 ```json 围栏或带前后说明，这里逐层剥离；失败返回 null。
 */
export function parseTranscribeOutput(raw: string | null): TranscribeResult | null {
  if (!raw) return null;
  let text = raw.trim();
  // 剥 ```json ... ``` 围栏
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fence) text = fence[1]!.trim();
  // 退一步：截取第一个 { 到最后一个 }
  if (!text.startsWith('{')) {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s !== -1 && e > s) text = text.slice(s, e + 1);
  }
  try {
    const parsed = JSON.parse(text) as { formulas?: unknown; processed?: unknown };
    const formulas = Array.isArray(parsed.formulas)
      ? parsed.formulas
          .filter((f): f is { shorthand: unknown; latex: unknown } => !!f && typeof f === 'object')
          .map((f) => ({ shorthand: String(f.shorthand ?? ''), latex: String(f.latex ?? '') }))
          .filter((f) => f.latex || f.shorthand)
      : [];
    return { formulas, processed: typeof parsed.processed === 'string' ? parsed.processed : '' };
  } catch {
    return null;
  }
}

/**
 * 转录一块速记。
 *
 * @returns 成功返回 TranscribeResult；LLM 不可用/输出不可解析 → null（调用方保留原文，优雅降级）
 */
export async function transcribeChunk(raw: string, askLlm: AskLlm): Promise<TranscribeResult | null> {
  const lines = parseShorthand(raw);
  if (!lines.some((l) => l.text)) return null;
  const out = await askLlm(`${TRANSCRIBER_PROMPT}\n\n${buildTranscribePrompt(lines)}`, {
    purpose: 'lecture-transcribe',
    json: true, // 转录员输出结构化 JSON
    // 不传 maxTokens：思考 token 也算在内，设死了会截断
  });
  return parseTranscribeOutput(out);
}

// ============================================================
// 留白与「助教」边界：课堂内不生成摘要（D4）
// ============================================================

/**
 * 护栏：判定一段 LLM 输出是否**越界**（生成了摘要/概念/检查问题）。
 *
 * 用途：转录员输出落库前自检 + 测试断言。**不是**万无一失的机器验证——
 * 语义越界无法纯文本判定（plan R3 已登记此风险，需复盘时人工自查）。
 * 这里只抓最明显的信号（标题式总结、检查问题句式）。
 */
export function looksLikeSummary(text: string): boolean {
  const signals = [
    /核心概念/,
    /逻辑连接/,
    /检查问题/,
    /小结|总结|摘要/,
    /本节课.{0,6}(讲了|介绍)/,
    /^\s*\d+[.、)]\s*思考题/m,
  ];
  return signals.some((re) => re.test(text));
}

/**
 * 护栏：转录员的 processed 不应比输入"长太多"。
 *
 * 理由：转录是**等量替换**（简写→LaTeX），不应引入大量新内容。
 * 显著增长通常意味着模型在扩写/补充解释（越界）。
 * 宽松阈值（3 倍 + 200 字符）只为抓明显越界，不做严格约束。
 */
export function isOverExpanded(input: string, output: string): boolean {
  return output.length > input.length * 3 + 200;
}
