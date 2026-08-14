// ============================================================
// gatekeeper.ts — 记忆守门员·规则层（纯函数，可单测）
// 双层判定第一层：确定性规则，零成本，先于 LLM 判定。
// 输入：一轮 (query, reply)；输出：动作决策。
// 动作：save / update(冲突) / knowledge_routed / skip / blocked / pending(交 LLM 层)
// ============================================================

export type MemoryAction =
  | { kind: 'blocked'; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'knowledge_routed'; reason: string }
  | { kind: 'save'; importance: number; category: Category; content: string }
  | { kind: 'pending'; reason: string };

export type Category = 'user_fact' | 'study_log' | 'preference' | 'relationship' | 'session_summary';

/** 凭据特征（v1 敏感黑名单思路）：命中必须 blocked，绝不进记忆。 */
const CREDENTIAL_PATTERNS = [
  /api[_-]?key/i,
  /sk-[A-Za-z0-9]{16,}/,
  /password/i,
  /passwd/i,
  /credential/i,
  /bearer\s+[A-Za-z0-9._-]{10,}/i,
  /(^|\s)token[=:\s]/i,
];

/** 显式记忆命令：用户明确要求记住 → 高重要性直写。 */
const EXPLICIT_SAVE_PATTERNS = [
  /记住/i, /记得[，。！？!?]*我/, /以后(就)?叫/, /别忘(了|记)/, /我的名字是/,
  /我(的)?(生日|年龄|专业|学校|家乡)/, /我(正在|要)学/, /我(喜欢|讨厌|最爱)/,
  /remember/i, /my name is/i, /i (like|love|hate)/i, /call me/i,
];

/** 物理/数学公式或术语特征 → knowledge_routed（进知识层，不进用户记忆）。 */
const KNOWLEDGE_PATTERNS = [
  /F\s*=\s*ma/, /E\s*=\s*mc/, /Σ|∫|∂|∇|Δ/, /d\/dx|dy\/dx/, /牛顿第/, /能量守恒/,
  /动量守恒/, /热力学第/, /薛定谔/, /麦克斯韦/, /电磁感应/, /简谐振动/, /sine|cos|tan/i,
  /积分|微分|导数|矩阵|特征值/i,
];

/** 闲聊/情绪模式 → skip。 */
const CHAT_PATTERNS = [
  /^(你好|嗨|哈喽|在吗|早上好|晚上好|下午好|再见|拜拜)/,
  /今天(天气|心情)/, /吃(了|饭)吗/, /在干嘛/, /晚安|早安/,
  /^哈哈+$/, /^嗯+$/, /^好的?$/, /^谢谢/, /^不客气/, /^加油/,
];

/** 信息量阈值：query 过短且无显式/事实特征 → skip。 */
const MIN_INFORMATIVE_LENGTH = 8;

/** 时间证据：事实状态已变化（"考完了/学会了/结束了"）→ 应 update + supersede 旧记忆。 */
const TIME_EVIDENCE_PATTERNS = [
  /考完(了|试)?/, /学完(了)?/, /已经(学会|掌握|解决|完成|通过)/, /不需要(了|再)?/,
  /结束(了)?/, /毕业(了)?/, /分手(了)?/, /不再(需要|用|学)/, /考过了/, /通过了/,
];

/** 检测文本是否含时间证据（事实状态变化信号）。 */
export function hasTimeEvidence(text: string): boolean {
  return TIME_EVIDENCE_PATTERNS.some((re) => re.test(text));
}

/** 实体类别关键词（save 时分类；身份事实优先）。 */
export function classifyCategory(query: string, reply: string): Category {
  const t = `${query} ${reply}`;
  // 身份事实最强信号（"我叫/我是/我的名字/生日/专业"等）优先
  if (/我叫|我是|我的名字|名字叫|生日|年龄|来自|家乡|住在|专业是|学的是/.test(t)) return 'user_fact';
  if (/喜欢|讨厌|最爱|爱吃|想(要|去)|希望|担心|害怕/.test(t)) return 'preference';
  if (/朋友|家人|同学|室友|导师|他|她|我们|对象|男朋友|女朋友/.test(t)) return 'relationship';
  if (/学|课|考试|作业|习题|复习|预习|教授|讲义|大学/.test(t)) return 'study_log';
  return 'session_summary';
}

/** 从对话中提取拟写入的第一人称记忆内容（规则层启发式：取用户原话精简）。 */
export function extractMemory(query: string): string {
  const q = query.trim();
  // 显式命令句式剥离："记住/以后叫我 X" → 保留 X 部分
  const m = q.match(/(?:记住|以后(?:就)?叫|我的名字是|别忘(?:了|记))\s*(.+)/i);
  if (m) return m[1].trim().replace(/^[，,、：:\s]+/, '');
  return q.length > 40 ? q.slice(0, 40) + '…' : q;
}

/**
 * 规则层主入口：返回动作决策。
 * @param query 用户输入
 * @param reply 星炬/爱弥斯回复
 */
export function decide(query: string, reply: string): MemoryAction {
  const q = (query || '').trim();
  const r = (reply || '').trim();

  // 1) 凭据：无论上下文，blocked
  for (const re of CREDENTIAL_PATTERNS) {
    if (re.test(q) || re.test(r)) return { kind: 'blocked', reason: '含凭据特征' };
  }

  // 2) 显式记忆命令 → save（importance 90）
  if (EXPLICIT_SAVE_PATTERNS.some((re) => re.test(q))) {
    return {
      kind: 'save',
      importance: 90,
      category: classifyCategory(q, r),
      content: extractMemory(q),
    };
  }

  // 3) 物理/数学知识 → knowledge_routed
  if (KNOWLEDGE_PATTERNS.some((re) => re.test(q) || re.test(r))) {
    return { kind: 'knowledge_routed', reason: '物理/数学知识，不进用户记忆' };
  }

  // 4) 闲聊/纯情绪 → skip
  if (CHAT_PATTERNS.some((re) => re.test(q))) return { kind: 'skip', reason: '闲聊/情绪' };
  if (q.length < MIN_INFORMATIVE_LENGTH) return { kind: 'skip', reason: '过短无信息量' };

  // 5) 信息量充足但规则无法确定 → pending（交 LLM 判定层）
  return { kind: 'pending', reason: '待 LLM 判定层' };
}
