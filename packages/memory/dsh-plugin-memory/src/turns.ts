// ============================================================
// turns.ts — 每轮 (用户输入, 最终输出) 的配对（纯逻辑，可单测）
//
// 为什么单独一个文件（真机反馈"模型思考链也进了 L1"）：
//   dsh 每个模型 step 发一条 `assistant/message`（带 turn/step）。用了工具的一轮是：
//     step 0：「我先用 compute_verify 验算一下…」+ tool-call   ← 边想边说的中间步骤
//     step 1：（工具结果之后）真正的最终回答
//   旧实现拿**第一条** assistant/message 就配对结束 —— 进 L1 的恰恰是 step 0 的过程话，
//   最终回答反而被丢掉。推理块（type: 'reasoning'）本来就被 text 过滤挡住了，不是它。
// 现在：
//   · 带 tool-call 的消息是中间步骤，正文不要；
//   · 没有工具调用的消息才是候选最终输出，多条时取**最后一条**（OOC 拦截重写等会再走一步）；
//   · 等 `turn/end` 再交出这一轮；
//   · 兜底：正文里内联的 <think>…</think>（部分 OpenAI 兼容通道这样返回推理）也剥掉。
// ============================================================

/** 一轮采集结果（进入规则初筛 / L1 缓冲的单位）。 */
export interface CollectedTurn {
  query: string;
  /** 最终输出；这一轮没有任何不带工具的回复（失败、被打断在工具步骤上）时为空串。 */
  reply: string;
  preset: string;
  ts: number;
}

/** assistant/message 内容块的最小形状（dsh-llm ContentBlock 的超集都能传进来）。 */
export interface ContentBlockLike {
  type?: string;
  text?: string;
}

/** 未配对轮次的上限：会话中断等导致 turn/end 缺失时，超限淘汰最旧（Map 保持插入序）。 */
export const TURN_BUFFER_MAX = 200;

const INLINE_THINK_RE = /<think>[\s\S]*?(<\/think>|$)/gi;

/**
 * 一条 assistant 消息若是**最终输出**，返回其可见正文；是中间步骤（带工具调用）返回 null。
 * 只取 text 块：reasoning / tool-call / image 等都不算正文。
 */
export function finalReplyText(content: readonly ContentBlockLike[]): string | null {
  if (content.some((b) => b?.type === 'tool-call')) return null;
  return content
    .map((b) => (b?.type === 'text' ? b.text ?? '' : ''))
    .join('')
    .replace(INLINE_THINK_RE, '')
    .trim();
}

/** 按会话缓冲当前轮：user/message 开轮 → assistant/message 更新最终输出 → turn/end 交出。 */
export class TurnCollector {
  private readonly turns = new Map<string, CollectedTurn>();

  constructor(private readonly max = TURN_BUFFER_MAX) {}

  /** 用户发言：开启（或覆盖）该会话的当前轮。空文本不开轮。 */
  userMessage(sessionId: string, query: string, preset: string, ts: number): void {
    const text = query.trim();
    if (!text) return;
    this.turns.delete(sessionId); // 重新插入到末尾，保持"最旧在前"的淘汰序
    this.turns.set(sessionId, { query: text, reply: '', preset, ts });
    while (this.turns.size > this.max) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
  }

  /** 模型的一个 step：只有不带工具调用、且有正文的才覆盖最终输出。 */
  assistantMessage(sessionId: string, content: readonly ContentBlockLike[]): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const text = finalReplyText(content);
    if (text) turn.reply = text;
  }

  /** 回合结束：交出这一轮（之后该会话无未结轮次）。没有开过轮返回 undefined。 */
  turnEnd(sessionId: string): CollectedTurn | undefined {
    const turn = this.turns.get(sessionId);
    if (!turn) return undefined;
    this.turns.delete(sessionId);
    return turn;
  }

  /** 会话销毁：丢弃未结轮次。 */
  drop(sessionId: string): void {
    this.turns.delete(sessionId);
  }

  get size(): number {
    return this.turns.size;
  }
}
