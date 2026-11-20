// ============================================================
// ask.ts — 做题时提问（苏格拉底式提示，**不给答案**）
//
// 用户 2026-11-20："exercise 加入一个前端提问功能，注意不要注入 persona 也不要直接作答，
//   而是根据题目给出苏格拉底式提示，直接沿用现有 llm 接口"。
//
//   · 不注入 persona：prompt 里没有角色设定 / 人设口吻，也不经过 agent 会话
//     （走的是批改同一个 askLlm / askVision：只有一条 user 消息，没有 system prompt）
//   · 不直接作答：不写结果、数值、表达式、完整推导，也不点名"用某某定理"——
//     只用提问和题目里的线索把学生引到下一步
//   · 临时：问答只在前端内存里，不写 sheet.json、不进检查历史
// ============================================================

import { parseJsonLoose, type AskLlm, type ReasoningEffort } from './checker.js';

export interface AskTurn {
  question: string;
  reply: string;
  questions: string[];
}

export interface AskInput {
  courseTitle: string;
  problemLabel: string;
  points: number | null;
  /** 题干（小题 = 大题题干 + 本小题，见 parts.ts 的 statementFor） */
  problemText: string;
  /** 同一大题前面小题的作答（只作上下文） */
  earlier?: Array<{ part: string; answer: string }>;
  /** 学生当前草稿（可能为空） */
  draft: string;
  question: string;
  /** 之前几轮（旧→新） */
  history?: readonly AskTurn[];
  lang: 'zh' | 'de' | 'en';
  statementImages?: Array<{ base64: string; mediaType: string; name: string }>;
  pageImages?: Array<{ base64: string; mediaType: string; page: number }>;
  answerImages?: Array<{ base64: string; mediaType: string; name: string }>;
}

export interface ParsedAsk {
  reply: string;
  questions: string[];
}

/** 历史最多带几轮（再多就是在喂 token，也容易让模型"顺着聊"把答案带出来）。 */
export const ASK_HISTORY_TURNS = 6;

export function buildAskPrompt(input: AskInput): string {
  const zh = input.lang === 'zh';
  const de = input.lang === 'de';
  const L = (zhText: string, deText: string, enText: string): string => (zh ? zhText : de ? deText : enText);
  const lines: string[] = [];

  lines.push(
    L(
      '下面是一道物理/数学作业题，学生在做题时提了一个问题。请用**苏格拉底式**的方式回应：通过提问、指向题目里的条件和线索，引导学生自己想出下一步。',
      'Unten steht eine Physik-/Mathe-Übungsaufgabe; die/der Studierende stellt beim Rechnen eine Frage. Antworte **sokratisch**: durch Gegenfragen und Hinweise auf Bedingungen in der Aufgabe, sodass sie/er den nächsten Schritt selbst findet.',
      'Below is a physics/maths exercise; the student asks a question while working on it. Respond **Socratically**: through questions and pointers to conditions in the problem, so the student finds the next step themselves.',
    ),
  );
  lines.push('');
  lines.push(
    L(
      '## 硬性规则\n' +
        '- **不给答案**：不写最终结果、数值、表达式，不写完整或部分推导，也不替学生写出下一步的公式 / 方程。\n' +
        '- **不点名方法**：不说"用某某定理 / 守恒律 / 换元"，改问能让学生自己意识到的问题（如"这个过程里有没有保持不变的量？"）。\n' +
        '- 可以做：澄清题目的字面意思（术语、记号、某个已知条件指什么）；指出学生问题里的误解；把卡住的地方拆成学生能回答的小问题；提醒回看题目里的某个条件或图。\n' +
        '- 学生直接要答案 / 要步骤：一句话说明不会直接给，然后给一个能让他往前走一步的问题。\n' +
        '- 问题与本题无关：一句话拉回到题目上。\n' +
        '- 草稿只用来判断他卡在哪里，**不要批改**，也不要说出草稿里哪一步对、哪一步错的结论。\n' +
        '- 简短：reply 不超过 4 句；questions 1–3 个，每个一句话，从容易到深入。\n' +
        '- 只用中性的说明口吻，不扮演任何角色；公式写成 $...$（LaTeX）。',
      '## Feste Regeln\n' +
        '- **Keine Lösung**: keine Endergebnisse, Zahlenwerte, Ausdrücke, keine (Teil-)Herleitung, keine Formel/Gleichung für den nächsten Schritt.\n' +
        '- **Keine Methode nennen**: nicht "benutze Satz X / Erhaltungssatz / Substitution", sondern eine Frage, die sie/ihn selbst darauf bringt.\n' +
        '- Erlaubt: Wortlaut der Aufgabe klären (Begriffe, Notation, was eine Angabe bedeutet); Missverständnisse in der Frage benennen; das Problem in beantwortbare Teilfragen zerlegen; auf eine Bedingung oder Skizze der Aufgabe verweisen.\n' +
        '- Wird direkt nach Lösung/Schritten gefragt: in einem Satz ablehnen, dann eine Frage für den nächsten Schritt.\n' +
        '- Frage ohne Bezug zur Aufgabe: in einem Satz zurück zur Aufgabe.\n' +
        '- Den Entwurf nur nutzen, um zu sehen, wo es hakt — **nicht korrigieren**, kein Urteil über einzelne Schritte.\n' +
        '- Kurz: reply höchstens 4 Sätze; questions 1–3, je ein Satz, von leicht nach tief.\n' +
        '- Neutraler, sachlicher Ton, keine Rolle spielen; Formeln als $...$ (LaTeX).',
      '## Hard rules\n' +
        '- **No answers**: no final results, numbers or expressions, no full or partial derivation, no formula/equation for the next step.\n' +
        '- **Do not name the method**: never "use theorem X / conservation law / substitution"; ask a question that lets the student realise it.\n' +
        '- Allowed: clarify the wording (terms, notation, what a given means); point out a misunderstanding in the question; break the sticking point into questions the student can answer; point back to a condition or figure in the problem.\n' +
        '- If the student asks for the answer or the steps: say in one sentence you will not give them, then ask one question that moves them forward.\n' +
        '- If the question is unrelated: bring it back to the problem in one sentence.\n' +
        '- Use the draft only to see where they are stuck — **do not grade it**, no verdict on individual steps.\n' +
        '- Short: reply at most 4 sentences; questions 1–3, one sentence each, from easy to deeper.\n' +
        '- Neutral, matter-of-fact tone, no role-play; formulas as $...$ (LaTeX).',
    ),
  );
  lines.push('');
  lines.push(
    L(
      '## 输出（严格 JSON，不要 Markdown 包裹）\n{"reply":"对问题的简短回应（不含答案）","questions":["引导性问题"]}\n用中文写（题目里的德语术语保持原样）。',
      '## Ausgabe (striktes JSON)\n{"reply":"kurze Antwort auf die Frage (ohne Lösung)","questions":["Leitfrage"]}\nAuf Deutsch.',
      '## Output (strict JSON)\n{"reply":"short response to the question (no solution)","questions":["guiding question"]}\nWrite in English (keep German problem terms as they are).',
    ),
  );

  lines.push('');
  lines.push(L(`# 题目（${input.courseTitle}）`, `# Aufgabe (${input.courseTitle})`, `# Problem (${input.courseTitle})`));
  lines.push(`- ${input.problemLabel}${input.points != null ? ` (${input.points} P.)` : ''}`);
  lines.push('');
  lines.push(input.problemText.trim() || L('（题干缺失，见图片）', '(keine Angabe, siehe Bild)', '(no statement, see image)'));
  if (input.statementImages?.length || input.pageImages?.length) {
    lines.push('');
    lines.push(L('（附件里有题目截图，以图为准）', '(Aufgabenbild im Anhang ist maßgeblich)', '(the attached problem image is authoritative)'));
  }
  if (input.earlier?.length) {
    lines.push('');
    lines.push(L('## 同一大题前面小题的作答（只作上下文）', '## Bisherige Teilaufgaben (nur Kontext)', '## Earlier parts of this problem (context only)'));
    for (const e of input.earlier) lines.push(`${e.part}) ${e.answer}`);
  }
  lines.push('');
  lines.push(L('## 学生当前的草稿', '## Aktueller Entwurf', '## Current draft'));
  lines.push(input.draft.trim().slice(0, 6000) || L('（还是空的）', '(noch leer)', '(still empty)'));

  const history = (input.history ?? []).slice(-ASK_HISTORY_TURNS);
  if (history.length) {
    lines.push('');
    lines.push(L('## 之前的问答（旧→新）', '## Bisheriger Verlauf (alt → neu)', '## Earlier exchange (old → new)'));
    for (const h of history) {
      lines.push(`${L('学生', 'Frage', 'Student')}: ${h.question}`);
      lines.push(`${L('回应', 'Antwort', 'Response')}: ${[h.reply, ...h.questions].filter(Boolean).join(' ')}`);
    }
  }
  lines.push('');
  lines.push(L('## 学生现在的问题', '## Aktuelle Frage', '## Current question'));
  lines.push(input.question.trim());
  lines.push('');
  lines.push(L('记住：只引导，不给答案。输出 JSON。', 'Denk daran: nur leiten, keine Lösung. Gib JSON aus.', 'Remember: guide only, no solution. Output JSON.'));
  return lines.join('\n');
}

export function parseAskOutput(raw: string | null): ParsedAsk | null {
  if (!raw || !raw.trim()) return null;
  // 同 parseCheckOutput：剥掉 ```json 围栏，只留第一个 { 到最后一个 } 之间
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a !== -1 && b > a) text = text.slice(a, b + 1);
  const obj = parseJsonLoose(text) as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return null;
  const reply = typeof obj.reply === 'string' ? obj.reply.trim() : '';
  const questions = Array.isArray(obj.questions)
    ? obj.questions
        .filter((q): q is string => typeof q === 'string')
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  if (!reply && !questions.length) return null;
  return { reply, questions };
}

export async function runAsk(
  input: AskInput,
  askLlm: AskLlm,
  askVision?: (
    prompt: string,
    images: readonly { mediaType: string; base64: string }[],
    opts: { maxTokens: number; purpose: string; reasoning?: ReasoningEffort; timeoutMs?: number },
  ) => Promise<string | null>,
): Promise<{ ok: boolean; parsed: ParsedAsk | null; raw: string; error?: string }> {
  const prompt = buildAskPrompt(input);
  const images = [
    ...(input.statementImages ?? []),
    ...(input.pageImages ?? []),
    ...(input.answerImages ?? []),
  ].map((i) => ({ mediaType: i.mediaType, base64: i.base64 }));
  const opts = { maxTokens: 8_000, purpose: 'exercise-ask', reasoning: 'high' as const, timeoutMs: 120_000 };
  const raw = images.length && askVision ? ((await askVision(prompt, images, opts)) ?? '') : ((await askLlm(prompt, opts)) ?? '');
  if (!raw.trim()) return { ok: false, parsed: null, raw: '', error: 'empty response' };
  const parsed = parseAskOutput(raw);
  if (!parsed) return { ok: false, parsed: null, raw, error: 'unparseable JSON' };
  return { ok: true, parsed, raw };
}
