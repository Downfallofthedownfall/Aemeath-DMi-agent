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

/** 复盘状态机。纯逻辑 + 可注入 LLM，便于单测。 */
export class ReviewMachine {
  private state: ReviewState;

  constructor(unitId: string, existing?: ReviewState | null) {
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
      throw new Error(`复盘步骤不匹配：当前 ${this.state.step}，需要 ${allowed.join('/')}`);
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
      '{"remembered":["学生记住的要点"],"missed":["学生漏掉的要点"],"wrong_or_vague":["学生记错或模糊的要点"]}',
      '要求：',
      '- 只做对比，不要讲解、不要补充知识、不要评价学生',
      '- 每条简短（≤40 字），用学生能看懂的说法',
      '- missed 与 wrong_or_vague 是后续补漏的重点，请准确',
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
   */
  buildRepairPrompt(): string {
    const c = this.state.comparison;
    const focus = [...(c?.missed ?? []), ...(c?.wrong_or_vague ?? [])];
    return [
      '你在做课后复盘的第 3 步：**定点补漏**。',
      '你是引导者，**不是答题者**。绝对规则：',
      '1. **不要给出答案、不要讲解、不要推导**',
      '2. 用提问引导学生自己想起来；一次只问一个问题',
      '3. 只针对下面列出的"漏掉/记错"的点，不要扩大范围',
      '4. 学生答完后，再决定是追问、还是确认他答对了',
      '5. 如果学生明确说"不知道"，给一个**最小提示**（不是答案），再让他试',
      '',
      '需要补漏的点：',
      ...(focus.length ? focus.map((f, i) => `${i + 1}. ${f}`) : ['(无——学生全部记住，可直接进入下一步)']),
      '',
      this.state.repair_turns.length
        ? `已有问答记录：\n${this.state.repair_turns.map((t) => `问：${t.question}\n答：${t.answer}`).join('\n')}`
        : '(这是第一个问题)',
      '',
      '请输出你的下一个问题（只要问题本身，不要任何解释或答案）：',
    ].join('\n');
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
      throw new Error(`复盘尚未完成第 3 步（当前 ${this.state.step}），不允许生成结构化摘要（D4）`);
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
  static parseCandidates(raw: string | null, unitId: string): Candidates | null {
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
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
      return {
        unit_id: unitId,
        worldbook_entries: Array.isArray(parsed.worldbook_entries)
          ? (parsed.worldbook_entries as Array<Record<string, unknown>>)
              .filter((e) => e && typeof e === 'object')
              .map((e) => ({ title: String(e.title ?? ''), content: String(e.content ?? ''), topic: String(e.topic ?? '物理/数学') }))
              .filter((e) => e.content)
          : [],
        entity_claims: Array.isArray(parsed.entity_claims)
          ? (parsed.entity_claims as Array<Record<string, unknown>>)
              .filter((e) => e && typeof e === 'object')
              .map((e) => ({ entity: String(e.entity ?? '用户'), attribute: String(e.attribute ?? ''), value: String(e.value ?? '') }))
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
  ];
  return signals.some((re) => re.test(text));
}
