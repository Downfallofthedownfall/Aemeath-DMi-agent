// ============================================================
// review.ts — 课后复盘五步状态机（PostLectureReview）
//
// 五步（docs/lecture-mode-plan.md §6）：
//   1 recall     你先说（不给任何提示）
//   2 compare    对照：我记住了 / 我漏了 / 我记错了或模糊了
//   3 repair     定点补漏：只针对漏和错，苏格拉底式追问，先让你答
//   4 candidates 候选条目（worldbook_entries / entity_claims /
//                unresolved_questions / insights）
//   5 commit     逐条确认/修改/删除，再写入
//
// 「中等 AI」的落点（D12）：**只在第 3 步生效**——
//   不让 AI 直接解题，而是 AI 引导纠正。
//   课堂内 LLM 是转录员（transcriber.ts），不受此约束（课堂内本就不出答案，D4）。
//
// D4 硬保证：结构化摘要只在第 4 步之后产出。本模块用状态门控实现，
// 且 `canGenerateSummary()` 是唯一允许生成摘要的判定入口。
// ============================================================

import {
  comparisonSchema,
  REVIEW_STEPS,
  type ReviewStep,
  type ReviewState,
  type Comparison,
  type Candidates,
  type RawChunk,
  type ProcessingRecord,
} from './types.js';
import { parseShorthand, textsOfKind } from './types.js';
import type { AskLlm } from './transcriber.js';
import { parseTranscribeOutput } from './transcriber.js';
import { tr } from './locale.js';

/** 复盘状态机。纯逻辑 + 可注入 LLM，便于单测。 */
export class ReviewMachine {
  private state: ReviewState;
  /** 输出语言（UI 语言）：决定 LLM 生成的对照/追问/候选条目用中文还是英文。 */
  private readonly lang: 'zh' | 'en';

  constructor(unitId: string, existing?: ReviewState | null, lang: 'zh' | 'en' = 'zh') {
    this.lang = lang;
    this.state =
      existing ??
      {
        unit_id: unitId,
        step: 'recall',
        recall_text: '',
        comparison: null,
        repair_turns: [],
        updated_at: Date.now(),
      };
  }

  get current(): ReviewState {
    return { ...this.state, comparison: this.state.comparison ? { ...this.state.comparison } : null, repair_turns: [...this.state.repair_turns] };
  }

  get step(): ReviewStep {
    return this.state.step;
  }

  /** 步骤顺序校验（防跳步——尤其防跳到第 4 步提前拿摘要）。 */
  private requireStep(...allowed: ReviewStep[]): void {
    if (!allowed.includes(this.state.step)) {
      throw new Error(tr(
        `复盘步骤不匹配：当前 ${this.state.step}，需要 ${allowed.join('/')}`,
        `Review step mismatch: currently ${this.state.step}, expected ${allowed.join('/')}`,
      ));
    }
  }

  // ---------- 第 1 步：你先说 ----------

  /**
   * 提交「凭记忆说」的内容。
   * **不提供任何提示**——调用方不得在此时把课堂记录展示给用户（D4/主动回忆）。
   */
  submitRecall(text: string): ReviewState {
    this.requireStep('recall');
    this.state.recall_text = text.trim();
    this.state.step = 'compare';
    this.state.updated_at = Date.now();
    return this.current;
  }

  // ---------- 第 2 步：对照 ----------

  /** 构造对照提示词：把「用户的回忆」与「课堂记录」一起给 LLM，产出三栏。 */
  buildComparePrompt(recall: string, chunks: readonly RawChunk[]): string {
    const recordLines = chunks
      .map((c) => {
        const lines = parseShorthand(c.raw);
        const topics = textsOfKind(lines, 'topic').join('；');
        const formulas = textsOfKind(lines, 'formula').join('；');
        const keys = textsOfKind(lines, 'keypoint').join('；');
        return [`【块${c.seq + 1}】主题：${topics || '(无)'}`, formulas ? `公式：${formulas}` : '', keys ? `重点：${keys}` : '']
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');
    return [
      '你在帮学生做课后复盘的第 2 步：**对照**。',
      '下面是学生**凭记忆**写下的内容，以及这节课的实际记录。',
      '请客观对比，输出纯 JSON（不要其他内容）：',
      '{"remembered":["学生记住的要点"],"missed":["学生漏掉的要点"],"wrong_or_vague":["学生记错或说不清的点"]}',
      '要求：',
      '- 只做对比，不要讲解、不要补充知识、不要评价学生',
      '- 每条简短（≤40 字），**写成一句可以被追问的话**（学生能懂的说法）',
      '- 三栏都要写**具体内容**，不要写"记录里没有，无法核对"这类评论 ——',
      '  那些对下一步的追问毫无用处。学生说"记不清 X"，X 就是一条可追问的点。',
      '- missed：课上讲到、但学生完全没提的**要点**。',
      '  如果这节课的记录本身很单薄（只有标题或寥寥几句），missed 宁可留空，不要硬凑。',
      '- wrong_or_vague：学生提到但**说错或说不清**的点 ——',
      '  包括他自己承认"没跟上 / 记不清"的那些。',
      this.lang === 'en' ? '- Write every JSON string in English.' : '',
      '',
      '=== 学生的回忆 ===',
      recall || '(空)',
      '',
      '=== 这节课的记录 ===',
      recordLines || '(无记录)',
    ].join('\n');
  }

  /** 解析对照输出（宽容解析）。 */
  static parseComparison(raw: string | null): Comparison | null {
    if (!raw) return null;
    let text = raw.trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
    if (fence) text = fence[1]!.trim();
    if (!text.startsWith('{')) {
      const s = text.indexOf('{');
      const e = text.lastIndexOf('}');
      if (s !== -1 && e > s) text = text.slice(s, e + 1);
    }
    try {
      const parsed = comparisonSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** 设置对照结果并进入第 3 步。 */
  setComparison(c: Comparison): ReviewState {
    this.requireStep('compare');
    this.state.comparison = c;
    this.state.step = 'repair';
    this.state.updated_at = Date.now();
    return this.current;
  }

  // ---------- 第 3 步：定点补漏（「中等 AI」在此生效） ----------

  /**
   * 苏格拉底式追问提示词。
   *
   * **核心约束（D12）：不给答案，先让学生答。**
   * 只针对 missed / wrong_or_vague 里的点，一次只问一个。
   *
   * ⚠️ 但"引导"≠"审讯"。真机反馈：
   *   "过于细致入微和强迫症了……只要能看出我懂了需要懂得就行了，
   *    不要追着我一直问什么牛顿定律什么条件下不适配，tmd 相对论还没学呢"
   *
   * 原来的提示词只说了"不要给答案"和"一次一个问题"，没有**停止条件**，
   * 也没说"不许超纲"。于是模型：
   *   · 一个点换着说法问四五轮，非要逼出教科书式的表述；
   *   · 为了"深挖"引入后续课程的内容（经典力学问相对论边界），
   *     学生根本没学过，怎么答都是"不会"，纯属折磨。
   *
   * 现在把这几条写死：范围限本课、说到点子上就过、同点最多两轮、
   * 问完就输出 DONE 收尾。
   */
  buildRepairPrompt(): string {
    const c = this.state.comparison;
    const focus = [...(c?.missed ?? []), ...(c?.wrong_or_vague ?? [])];
    return [
      '你在做课后复盘的第 3 步：**定点补漏**。',
      '',
      '你的目标只有一个：**确认学生听懂了这节课该懂的**。',
      '不是考倒他，也不是把每个细节追问到底。',
      '',
      '规则：',
      '1. **不要给出答案、不要讲解、不要推导**',
      '2. 一次只问一个问题',
      '3. **只问本课讲过的东西。** 不要引入这门课后面才会讲的内容 ——',
      '   比如本课讲经典力学，就不要问"牛顿定律在什么条件下失效"这种',
      '   要用相对论才能回答的问题；也不要追问课上没强调的边角细节。',
      '   学生没学过的内容，问了也只会让他挫败。',
      '4. **说到点子上就算过。** 只要他的回答能看出理解了核心意思，就换下一个点。',
      '   不要抠字眼、不要要求更精确的表述、不要换个说法把同一个问题再问一遍。',
      '5. **同一个点最多追问 2 轮。** 两轮之后无论答成什么样都换下一个点。',
      '6. 学生说"不知道" → 给一个**最小提示**（不是答案）再试一次；',
      '   还答不出来就跳过这个点，不要死磕。',
      '7. **宁可少问，但该问的要问。** 下面列出的点如果还没确认过，',
      '   就问其中最重要的一个；只有当这些点都已经确认过（或跳过），才收尾。',
      '   不要因为"看起来他好像懂"就一个都不问。',
      '',
      '需要确认的点：',
      ...(focus.length ? focus.map((f, i) => `${i + 1}. ${f}`) : ['(无——学生全部记住，可以直接收尾)']),
      '',
      this.state.repair_turns.length
        ? `已有问答记录：\n${this.state.repair_turns.map((t) => `问：${t.question}\n答：${t.answer}`).join('\n')}`
        : '(这是第一个问题)',
      '',
      this.lang === 'en'
        ? 'Write your next question in English (only the question itself, no explanation or answer).\nIf nothing more needs asking, output exactly one line: DONE'
        : '请输出你的下一个问题（只要问题本身，不要任何解释或答案）。\n如果你认为已经够了、没有需要再问的，**只输出一行**：DONE',
    ].join('\n');
  }

  /**
   * 模型的这次输出是不是"可以收尾了"。
   *
   * 约定：补漏问完就输出 DONE。调用方据此结束第 3 步，而不是继续找问题。
   */
  static isRepairDone(output: string | null): boolean {
    if (!output) return false;
    return /^\s*DONE\s*[.。!！]?\s*$/i.test(output.trim());
  }

  /**
   * 补漏最多问几轮（含第一个问题）。
   *
   * 兜底：即使模型没输出 DONE，也不能无限追问下去 —— 用户明确说
   * "不要追着我一直问"。到上限就直接进候选。
   */
  static readonly MAX_REPAIR_TURNS = 6;

  /** 已经问够了吗（轮数上限兜底）。 */
  get repairExhausted(): boolean {
    return this.state.repair_turns.length >= ReviewMachine.MAX_REPAIR_TURNS;
  }

  /** 记录一轮问答。 */
  addRepairTurn(question: string, answer: string): ReviewState {
    this.requireStep('repair');
    this.state.repair_turns.push({ question: question.trim(), answer: answer.trim() });
    this.state.updated_at = Date.now();
    return this.current;
  }

  /** 结束补漏，进入第 4 步。 */
  finishRepair(): ReviewState {
    this.requireStep('repair');
    this.state.step = 'candidates';
    this.state.updated_at = Date.now();
    return this.current;
  }

  // ---------- 第 4 步：候选条目（D4：摘要只在此后生成） ----------

  /**
   * **唯一的摘要生成门控**（D4）。
   * 只有走到 candidates/commit/done 才允许生成结构化摘要。
   */
  canGenerateSummary(): boolean {
    const i = REVIEW_STEPS.indexOf(this.state.step);
    return i >= REVIEW_STEPS.indexOf('candidates');
  }

  /** 构造候选条目提示词（此时才允许生成结构化摘要）。 */
  buildCandidatesPrompt(chunks: readonly RawChunk[], processing: ProcessingRecord | null): string {
    if (!this.canGenerateSummary()) {
      throw new Error(tr(
        `复盘尚未完成第 3 步（当前 ${this.state.step}），不允许生成结构化摘要（D4）`,
        `Review has not reached step 3 (currently ${this.state.step}); structured summary is not allowed yet (D4)`,
      ));
    }
    const c = this.state.comparison;
    const recordLines = chunks
      .map((ch) => {
        const lines = parseShorthand(ch.raw);
        return [`【块${ch.seq + 1}】`, ...lines.filter((l) => l.text).map((l) => `${l.kind}: ${l.text}`)].join('\n');
      })
      .join('\n\n');
    return [
      '课后复盘已完成。请把这节课的内容提炼为**可写入长期知识库的候选条目**。',
      '输出纯 JSON（不要其他内容）：',
      '{"worldbook_entries":[{"title":"条目标题","content":"知识内容","topic":"主题"}],',
      ' "entity_claims":[{"entity":"用户","attribute":"属性","value":"值"}],',
      ' "unresolved_questions":["仍未解决的问题"],',
      ' "insights":["学习洞察/方法反思"]}',
      '要求：',
      '- worldbook_entries：可复用的物理/数学知识点（公式、定律、方法），去重、简洁',
      '- entity_claims：只写关于**学生学习状态**的稳定事实（如"薄弱点=转动惯量计算"）',
      '- unresolved_questions：学生仍没搞懂的（从下方补漏记录与学生疑问中提取）',
      '- insights：关于学习方式的观察（可选）',
      '- 不要编造；不确定的宁可省略',
      this.lang === 'en' ? '- Write every JSON string value in English.' : '',
      '',
      '=== 学生凭记忆说出的 ===',
      this.state.recall_text || '(空)',
      '',
      '=== 对照结果 ===',
      `记住了：${(c?.remembered ?? []).join('；') || '(无)'}`,
      `漏了：${(c?.missed ?? []).join('；') || '(无)'}`,
      `记错/模糊：${(c?.wrong_or_vague ?? []).join('；') || '(无)'}`,
      '',
      '=== 补漏问答 ===',
      this.state.repair_turns.map((t) => `问：${t.question}\n答：${t.answer}`).join('\n') || '(无)',
      '',
      '=== 课堂记录 ===',
      recordLines || '(无)',
      processing?.processed ? `\n=== 规范化后的速记 ===\n${processing.processed}` : '',
    ].join('\n');
  }

  /** 解析候选条目输出。 */
  static parseCandidates(raw: string | null, unitId: string, lang: 'zh' | 'en' = 'zh'): Candidates | null {
    if (!raw) return null;
    const defaults = lang === 'en'
      ? { topic: 'Physics/Math', entity: 'User' }
      : { topic: '物理/数学', entity: '用户' };
    let text = raw.trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
    if (fence) text = fence[1]!.trim();
    if (!text.startsWith('{')) {
      const s = text.indexOf('{');
      const e = text.lastIndexOf('}');
      if (s !== -1 && e > s) text = text.slice(s, e + 1);
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
      return {
        unit_id: unitId,
        worldbook_entries: Array.isArray(parsed.worldbook_entries)
          ? (parsed.worldbook_entries as Array<Record<string, unknown>>)
              .filter((e) => e && typeof e === 'object')
              .map((e) => ({ title: String(e.title ?? ''), content: String(e.content ?? ''), topic: String(e.topic ?? defaults.topic) }))
              .filter((e) => e.content)
          : [],
        entity_claims: Array.isArray(parsed.entity_claims)
          ? (parsed.entity_claims as Array<Record<string, unknown>>)
              .filter((e) => e && typeof e === 'object')
              .map((e) => ({ entity: String(e.entity ?? defaults.entity), attribute: String(e.attribute ?? ''), value: String(e.value ?? '') }))
              .filter((e) => e.attribute && e.value)
          : [],
        unresolved_questions: arr(parsed.unresolved_questions),
        insights: arr(parsed.insights),
        created_at: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** 保存候选条目，进入第 5 步。 */
  setCandidates(): ReviewState {
    this.requireStep('candidates');
    this.state.step = 'commit';
    this.state.updated_at = Date.now();
    return this.current;
  }

  // ---------- 第 5 步：确认写入 ----------

  /**
   * 完成第 5 步。
   *
   * ⚠️ 契约：本方法**只推进状态机**，不保存任何内容。
   *    候选条目的落盘由调用方负责（`store.writeCandidates(accepted)`）——
   *    因为"用户勾掉了哪些"是界面侧的知识，状态机不该猜。
   *
   *    早先的签名是 `commit(accepted: Candidates)` 但参数被无声忽略，
   *    看着像"提交这些条目"，实际什么都没做（API 误导）。
   *    现在参数移除，并把职责写清楚。
   */
  commit(): ReviewState {
    this.requireStep('commit');
    this.state.step = 'done';
    this.state.updated_at = Date.now();
    return this.current;
  }

  /** 是否已完成全部五步（握手前置条件）。 */
  get isDone(): boolean {
    return this.state.step === 'done';
  }
}

/**
 * 第 3 步的越界护栏（D12）：判定引导输出是否**直接给了答案**。
 *
 * 同样只是启发式（plan R3 已登记语义判定不可靠）：
 * 抓"答案是""正确结果是""推导如下"等典型直答句式。
 */
export function looksLikeDirectAnswer(text: string): boolean {
  const signals = [
    /答案(是|为|应该)/,
    /正确(的)?(结果|答案)/,
    /推导(如下|过程)/,
    /应该是\s*[A-Za-z$\\(]/,
    /结论[:：]/,
    /根据.{0,10}定律.{0,20}(可得|得到)/,
    // 英文输出同样要拦（UI 语言为 en 时模型会用英文直答）
    /\bthe answer is\s+[A-Za-z0-9$\\]/i,
    /\bcorrect (result|answer) is\b/i,
    /\bderivation (is|follows)\b/i,
    /\bhere('s| is) (the|a) (solution|derivation)\b/i,
    /\bin conclusion,?\s/i,
  ];
  return signals.some((re) => re.test(text));
}
