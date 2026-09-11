// ============================================================
// gatekeeper.ts — 记忆守门员·规则层（纯函数，可单测）
// 双层判定第一层：确定性规则，零成本，先于 LLM 判定。
// 输入：一轮 (query, reply)；输出：动作决策。
// 动作：
//   save              —— 显式记忆命令（"记住/以后叫我…"关键词）→ 直接写 L2/L3（不经 LLM）
//   knowledge_direct  —— 规则初筛命中强知识模式（公式/定律/数学术语）→ 直接进知识层/worldbook（不经 LLM）
//   skip / blocked    —— 丢弃 / 凭据拦截
//   pending           —— 规则层拿不准 → 进 L1 缓冲攒批 → LLM 总结审核（省 token）
// ============================================================

import { overlapScore } from './bm25.js';
import { canonicalAttr } from './attributes.js';

export type MemoryAction =
  | { kind: 'blocked'; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'knowledge_direct'; content: string; topic: string; reason: string }
  | { kind: 'save'; importance: number; category: Category; content: string }
  | { kind: 'pending'; reason: string };

export type Category = 'user_fact' | 'study_log' | 'preference' | 'relationship' | 'session_summary';

/**
 * 个人学习计划/目标（semester plan 类）：直存 user_fact → L3 global（跨角色稳定事实）。
 * 与身份模式同源——都是用户关于自己的、值得跨会话/跨角色记住的安排。
 * 位置：在强知识识别之前，避免含"积分/微分/矩阵"等强知识词的计划句（如
 * "我的目标是把微积分学好"）被误判为 knowledge_direct——那是计划不是知识。
 * 收敛：需明确的计划/意向动词 + 学习/考试类宾语；"我打算今天吃…/去超市"无学习
 * 宾语，不命中；"今天吃什么"无计划动词，不命中。
 */
const PERSONAL_PLAN_PATTERN = /(我|我的)?(计划|打算|目标|准备|决定|希望|要|想).{0,15}(学|读|复习|考|攻克|掌握|通过|完成|写完|记牢|练习|刷)/;

/** 进行中状态信号：排除"在准备/正在…考试"这类当前活动陈述（不是计划/目标）。
 *  否则"我最近在准备热力学考试"会被误判为个人计划而直存，违背"信息充足但待定 → L1 采集"的意图。 */
const ONGOING_STUDY_PATTERN = /(正在|最近在|现在在|目前在)\s*(准备|准备着|学|复习)/;

export function isPersonalPlan(text: string): boolean {
  if (ONGOING_STUDY_PATTERN.test(text)) return false;
  return PERSONAL_PLAN_PATTERN.test(text);
}

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

/**
 * 显式记忆命令关键词：用户明确要求记录 → 规则初筛直达（不经 LLM）。
 * 不只公式：这类"记住/记一下"关键词同样是 worldbook/知识层入口的规则层信号。
 */
const EXPLICIT_SAVE_PATTERNS = [
  /记住/i, /记得[，。！？!?]*我/, /以后(就)?叫/, /别忘(了|记)/, /我的名字是/,
  /记一下|记下来|记着/, /收藏|存一下|收录/,
  /我(的)?(生日|年龄|专业|学校|家乡)/, /我(正在|要)学/, /我(喜欢|讨厌|最爱)/,
  /remember/i, /my name is/i, /i (like|love|hate)/i, /call me/i,
];

/**
 * 疑问信号：命中则身份句式不直存（防"我毕业了吗/我现在读高中吗/我现在要上大学的
 * 课吗"这类带问尾/问词的语句被误判为身份声明）。命中消息交 L1 采集，由总结层
 * LLM 拆分"身份 + 提问"两部分，而非把整句原样写成 user_fact。
 */
const QUESTION_SIGNALS = /[吗么呢吧]|怎么|什么|为什么|如何|多少|几|哪|是不是|能不能|该不该|要不要|？|\?/;

/**
 * 身份事实句式：无需"记住"关键词也直存（2026-08-17 用户反馈：
 * "我是准大一"被规则层静默丢弃——身份是稳定事实，等攒批反而慢）。
 * 类别恒为 user_fact → L3 global（跨角色共享）。
 * 模式收敛（2026-09 加固，防"我是想问…"类疑问句被误判为身份声明）：
 *   - #1 必须"我"开头 + 身份词（"准大一新生该买什么"这类提问不再裸触发）；
 *   - #2 时间词后的连接词只取 就要/要/就/是，且后面必须跟学籍/身份名词
 *     （"我现在是想问…/我目前是纠结…/我今年是打算…"这类开场白不匹配；
 *      注意 (就?要)? 这类"全可选内容 + 外层可选组"对 CJK 会退化为空匹配，
 *      必须用显式三选一 (就要|要|就)）；
 *   - #3 是/叫 后必须跟身份名词（含 高一~高三/研一~研三）；
 *   - 疑问句由 decide() 的 QUESTION_SIGNALS 门统一排除，不在各模式里加 lookahead。
 */
const IDENTITY_PATTERNS = [
  /^我?(是|就是)?(准大一|大一新生|应届(生|高考)?生?)/,
  /我(今年|现在|目前|马上|即将)(就要|要|就|是)?(上|读|进|成为)?(大一|大二|大三|大四|研一|研二|研三|研究生|硕士|博士|本科生|专科生|高中生|初中生|小学生|新生|学生|大学|高中|初中|小学|本科|高一|高二|高三)/,
  /我(是|叫|叫做)(一名|一位|个)?(大一|大二|大三|大四|研一|研二|研三|研究生|硕士|博士|本科生|专科生|高中生|初中生|小学生|新生|学生|高一|高二|高三)/,
  /我(刚|刚刚|已经)?(高考完|中考完|毕业|考上|考进|被录取)/,
];

/**
 * 强知识模式（公式/定律/数学术语）：规则初筛命中的知识 → knowledge_direct，
 * 直接进知识层/worldbook，不经 LLM 审核。
 */
const KNOWLEDGE_PATTERNS = [
  /F\s*=\s*ma/, /E\s*=\s*mc/, /Σ|∫|∂|∇|Δ/, /d\/dx|dy\/dx/, /牛顿第/, /能量守恒/,
  /动量守恒/, /热力学第/, /薛定谔/, /麦克斯韦/, /电磁感应/, /简谐振动/, /sine|cos|tan/i,
  /积分|微分|导数|矩阵|特征值/i, /波长|频率|折射|衍射|干涉/i, /洛伦兹|安培|欧姆|焦耳/,
];

/** 规则初筛：文本是否含强知识模式（供 save 分支二次判断"显式命令+知识内容"）。 */
export function isStrongKnowledge(text: string): boolean {
  return KNOWLEDGE_PATTERNS.some((re) => re.test(text));
}

/** 从提问中提取知识主题（topic）：优先取公式/拉丁符号，其次取连续中文片段（≤6 字）。 */
export function classifyKnowledgeTopic(query: string): string {
  const latin = (query || '').match(/[A-Za-z]{1,6}/);
  if (latin) return latin[0];
  const cjk = (query || '').match(/[\u4e00-\u9fff]{2,6}/);
  return cjk ? cjk[0] : '物理/数学';
}

/** 闲聊/情绪模式 → skip。 */
const CHAT_PATTERNS = [
  /^(你好|嗨|哈喽|在吗|早上好|晚上好|下午好|再见|拜拜)/,
  /今天(天气|心情)/, /吃(了|饭)吗/, /在干嘛/, /晚安|早安/,
  /^哈哈+$/, /^嗯+$/, /^好的?$/, /^谢谢/, /^不客气/, /^加油/,
];

/** 纯占位（单字/无意义）阈值：低于此长度 → skip；其余短陈述进 L1 滚动捕获。 */
const MIN_ROLLING_CAPTURE_LENGTH = 2;

/** 时间证据：事实状态已变化（"考完了/学会了/结束了"）→ 应 update + supersede 旧记忆。 */
const TIME_EVIDENCE_PATTERNS = [
  /考完(了|试)?/, /学完(了)?/, /已经(学会|掌握|解决|完成|通过)/, /不需要(了|再)?/,
  /结束(了)?/, /毕业(了)?/, /分手(了)?/, /不再(需要|用|学)/, /考过了/, /通过了/,
];

/** 检测文本是否含时间证据（事实状态变化信号）。 */
export function hasTimeEvidence(text: string): boolean {
  return TIME_EVIDENCE_PATTERNS.some((re) => re.test(text));
}

// ============================================================
// B5 — user_fact 写门（L0 身份）。借用 Cyrene 记忆设计：核心画像只接收用户
// 明确自述（certainty=explicit & attribution=user_explicit）的事实；须尊重用户
// 锁存（"不要记/别记/忘了它"），并拒绝无来源/悬挂字段名的幻觉内容。
// 纯函数、可单测；本块只做判定，不改 L1 缓冲机制。
// ============================================================

/** 用户主动锁存信号：命中则 drop（或 demote）该 user_fact。 */
const USER_LOCK_PATTERNS = [
  /不要记/, /别记/, /忘了它/, /忘掉(它)?/, /不用记/, /别存/, /不要存/, /别记住/,
  /不用记住/, /删掉它/, /不用记了/,
];

/** 空/悬挂字段名（疑似幻觉、无可靠来源）：null/None/不详/待定/纯标点等。 */
const HALLUCINATED_FACT_PATTERNS = [
  /^(null|none|nil|n\/a|undefined|unknown|unknown_value|不详|未知|无|没有|空|无信息|待补充|待定|未提供|我不知道)\s*[:：]?\s*$/i,
  /^[：:，,\s。.!！?？、;；]*$/,
];

export type WriteGateAction = 'accept' | 'demote' | 'drop';
export interface WriteGateVerdict {
  action: WriteGateAction;
  reason: string;
  /** demote 时建议的置信度（其余为 undefined）。 */
  confidence?: number;
}

/**
 * user_fact 写门：判定一条拟写入核心画像的事实是否放行。
 * @param query   本轮用户原话（引述来源 = 用户）
 * @param content 拟写入的 user_fact 内容
 * @returns accept（放行）/ demote（降置信保存）/ drop（拦截，仅审计）
 */
export function writeGate(query: string, content: string): WriteGateVerdict {
  const q = (query || '').trim();
  const c = (content || '').trim();
  // 用户锁存：明确要求"不要记/别记/忘了它" → drop（尊重用户意志）
  if (USER_LOCK_PATTERNS.some((re) => re.test(q))) {
    return { action: 'drop', reason: '用户主动锁存（不要记/别记/忘了它）' };
  }
  // 幻觉/悬挂字段名守卫：空值、无来源占位 → drop（不污染画像）
  if (!c || c.length < 2 || HALLUCINATED_FACT_PATTERNS.some((re) => re.test(c))) {
    return { action: 'drop', reason: '空/悬挂字段名——无可信来源（疑似幻觉）' };
  }
  // userExplicit=explicit & attribution=user_explicit：须第一人称自述 + 直陈句
  const firstPerson = /我|我的|本人/.test(q);
  const directStatement = !QUESTION_SIGNALS.test(q);
  if (!firstPerson) {
    return { action: 'demote', reason: '非第一人称直接陈述，来源可靠性降级', confidence: 0.5 };
  }
  if (!directStatement) {
    return { action: 'demote', reason: '疑问句式非用户自述，来源可靠性降级', confidence: 0.5 };
  }
  return { action: 'accept', reason: '用户明确第一人称自述（user_explicit）' };
}

// ============================================================
// B6 — 类型化冲突（借用 Cyrene 记忆设计）。把"裸 supersede"升级为：先分类
// （preference_evolution / direct_conflict）再解决（新值生效），并把类型写进
// 审计/冲突日志。LLM 可用时可选判定，否则走下方的确定性规则兜底（测试稳定）。
// ============================================================

export type ConflictType = 'preference_evolution' | 'direct_conflict';
export interface ConflictDecision {
  type: ConflictType;
  reason: string;
  /** 是否经 LLM 判定；false = 确定性规则兜底。 */
  viaLlm: boolean;
}

/**
 * 确定性冲突分类器（纯函数，可单测；也是 LLM 判定不可用时的兜底）。
 * 信号：hasTimeEvidence（状态变化）、overlapScore（同一话题）、category（偏好域）、
 *      内容中的"变更"词（改/换/不喜欢/更喜欢/现在）。
 * - preference_evolution：偏好域内用户改变了偏好（旧偏好 → 新偏好，新值生效）；
 * - direct_conflict：直接冲突/被取代（如时间证据"考完了"取代"有考试"，新值生效）。
 * 两类"新值生效"的 supersede 语义保持一致，仅 type/reason 不同。
 */
export function classifyConflict(oldContent: string, newContent: string, oldCategory: Category, newCategory: Category): ConflictDecision {
  const timeNew = hasTimeEvidence(newContent);
  const overlap = overlapScore(oldContent, newContent);
  const prefDomain = oldCategory === 'preference' || newCategory === 'preference';
  const prefChange = /(改成|改为|不喜欢|不再喜欢|更喜欢|换成|现在喜欢|改喝|换喝|决定|想要|想喝|想学|喜欢上)/.test(newContent);
  if (prefDomain && prefChange) {
    return {
      type: 'preference_evolution',
      reason: `偏好演变：旧「${oldContent.slice(0, 12)}」→ 新「${newContent.slice(0, 12)}」（用户改变偏好，新值生效；overlap=${overlap.toFixed(2)}）`,
      viaLlm: false,
    };
  }
  return {
    type: 'direct_conflict',
    reason: `直接冲突/状态变化：新「${newContent.slice(0, 12)}」取代旧「${oldContent.slice(0, 12)}」（时间证据=${timeNew}，overlap=${overlap.toFixed(2)}，新值生效）`,
    viaLlm: false,
  };
}

/** 模块代码模式（汉堡物理系 Modulhandbuch）：PHY-XX / MATH\d → 学习语境。 */
export const MODULE_CODE_PATTERN = /PHY-[A-Z0-9]+|MATH\d|MATH\s?\d/i;

/** 实体类别关键词（save 时分类；身份事实优先）。 */
export function classifyCategory(query: string, reply: string): Category {
  const t = `${query} ${reply}`;
  // 身份事实最强信号（"我叫/我是/我的名字/生日/专业"等）优先
  if (/我叫|我是|我的名字|名字叫|生日|年龄|来自|家乡|住在|专业是|学的是/.test(t)) return 'user_fact';
  if (/喜欢|讨厌|最爱|爱吃|想(要|去)|希望|担心|害怕/.test(t)) return 'preference';
  if (/朋友|家人|同学|室友|导师|他|她|我们|对象|男朋友|女朋友/.test(t)) return 'relationship';
  // 学习语境：通用学习词 + Modulhandbuch 模块代码（"PHY-E1 考什么 / 我在上 MATH1"）
  if (/学|课|考试|作业|习题|复习|预习|教授|讲义|大学/.test(t) || MODULE_CODE_PATTERN.test(t)) return 'study_log';
  return 'session_summary';
}

/**
 * 从对话中提取拟写入的第一人称记忆内容（规则层启发式：取用户原话精简）。
 *
 * 2026-09 加固（真实数据实测：24 条记忆里 4 条带前导标点、1 条残留"记住"命令词，
 * 既污染展示也污染 claim 抽取）：
 *   ① 先剥掉命令前缀（"记住/记一下/以后叫我…"）**再**剥前导标点，不能反过来
 *      （"记住，我住在北京" 的命令词后面跟的就是标点）；
 *   ② 命令词剥离支持"句子开头 + 任意标点/空白"的形态，而不是只认后随空格；
 *   ③ 末尾多余标点一并清掉。
 */
export function extractMemory(query: string): string {
  let q = (query ?? '').trim();
  // 命令前缀剥离：命令词在句首（可带标点/空白分隔），可能出现多次（"记住，记一下…"）。
  // 「以后叫我 X」「我的名字是 X」属替换型命令：连命令词一起剥、X 作为正文留下
  // （但**不能只剥"以后"**：那会把「以后叫我小星就好」变成「我小星就好」——实测踩到过）。
  // 注意：正则交替**长 token 必须排在前面**，否则 `叫我` 会先匹配掉 `叫我` 再因后续不匹配而
  // 整体失败，且不会回溯到更长的 `以后叫我` 分支（JavaScript 交替的首个成功即定，实测踩到过）。
  const CMD_PREFIX = /^(?:请?)?(?:以后(?:就)?叫我|以后(?:就)?叫|我的名字是|名字叫|叫我|记住|记一下|记下来|记着|别忘(?:了|记)|帮我记(?:一下)?|记到|写入记忆|存进记忆|列入记忆|记笔记)\s*[，,、。；;：:!！?\s]*/;
  for (let i = 0; i < 3 && CMD_PREFIX.test(q); i++) q = q.replace(CMD_PREFIX, '').trim();
  // 前导标点/空白（"…，我下周三有物理考试" 这类脏数据的前导逗号）
  q = q.replace(/^[，,、。；;：:!！?？\s"'「『【]+/, '').trim();
  q = q.replace(/[，,、。；;：:\s]+$/, '').trim();
  return q.length > 40 ? `${q.slice(0, 40)}…` : q;
}

/**
 * 知识直达内容提取（B1 修复）：知识命中可能来自用户提问，也可能来自模型回复
 * （例如用户问"这是什么？"，回复含 "F=ma"）。知识命中自回复时，必须把回复文本
 * 写入知识层/worldbook，而不是把用户提问（"这是什么？"）当知识内容。
 * @returns 拟写入知识层的内容文本（回复优先，超长截断）。
 */
export function extractKnowledge(query: string, reply: string): string {
  const r = (reply || '').trim();
  if (isStrongKnowledge(r)) {
    const clean = r.replace(/\s+/g, ' ').trim();
    return clean.length > 120 ? clean.slice(0, 120) + '…' : clean;
  }
  return extractMemory(query);
}

/**
 * 规则层主入口：返回动作决策。
 * @param query 用户输入
 * @param reply physicist/爱弥斯回复
 */
export function decide(query: string, reply: string): MemoryAction {
  const q = (query || '').trim();
  const r = (reply || '').trim();

  // 1) 凭据：无论上下文，blocked
  for (const re of CREDENTIAL_PATTERNS) {
    if (re.test(q) || re.test(r)) return { kind: 'blocked', reason: '含凭据特征' };
  }

  // 2) 个人学习计划/目标（semester plan）→ save（user_fact，直存 L3 global）
  //      置于显式记忆命令之前：否则"这学期我要学物理"会先被 EXPLICIT_SAVE 的
  //      /我(正在|要)学/ 拦截成 study_log（mode=L2），到不了 L3。
  //      且优先于强知识：含"积分/微分"等强知识词的计划句是"计划"不是知识
  //      （如"我的目标是把微积分学好"）——否则会被 knowledge_direct 误入库。
  //      疑问信号不直存（"我这学期要学什么？"是提问不是计划），交 L1 采集。
  if (!QUESTION_SIGNALS.test(q) && isPersonalPlan(q)) {
    return {
      kind: 'save',
      importance: 70,
      category: 'user_fact',
      content: extractMemory(q),
    };
  }

  // 3) 显式记忆命令 → save（importance 90）
  if (EXPLICIT_SAVE_PATTERNS.some((re) => re.test(q))) {
    return {
      kind: 'save',
      importance: 90,
      category: classifyCategory(q, r),
      content: extractMemory(q),
    };
  }

  // 3.5) 身份事实句式 → save（user_fact，直存 L3 global，无需"记住"关键词）
  //      疑问信号（吗/呢/怎么/什么…）→ 不直存，交 L1 采集由 LLM 拆分"身份+提问"，
  //      身份规则只对纯陈述句生效（防"我毕业了吗/我现在读高中吗"带问尾误判）。
  if (!QUESTION_SIGNALS.test(q) && IDENTITY_PATTERNS.some((re) => re.test(q))) {
    return {
      kind: 'save',
      importance: 85,
      category: 'user_fact',
      content: extractMemory(q),
    };
  }

  // 4) 强知识模式（公式/定律/数学术语）→ knowledge_direct（规则初筛直达，不经 LLM）
  //    B1 修复：知识命中来源决定内容/主题取哪个——提问本身含知识（如"F=ma 是什么？"）
  //    取提问；仅回复含知识（如问"这是什么？"答"F=ma"）则取回复文本，避免把
  //    "这是什么？"这类提问本身当成知识写入知识层/worldbook。
  {
    const hitQuery = isStrongKnowledge(q);
    const hitReply = !hitQuery && isStrongKnowledge(r);
    if (hitQuery || hitReply) {
      return {
        kind: 'knowledge_direct',
        content: hitReply ? extractKnowledge(q, r) : extractMemory(q),
        topic: classifyKnowledgeTopic(hitReply ? r : q),
        reason: '规则初筛：强知识模式（公式/定律/术语），直达知识层',
      };
    }
  }

  // 4) 闲聊/纯情绪 → skip
  if (CHAT_PATTERNS.some((re) => re.test(q))) return { kind: 'skip', reason: '闲聊/情绪' };
  // 纯占位单字 → skip；其余（含短身份陈述如"我是准大一"）→ pending 进 L1 滚动捕获，
  // 由总结层（LLM/规则兜底）决定取舍——不再静默丢弃普通陈述（2026-08-17 修复）。
  if (q.length < MIN_ROLLING_CAPTURE_LENGTH) return { kind: 'skip', reason: '过短无信息量' };

  // 5) 其余 → pending（进 L1 采集缓冲，交 LLM 总结审核）
  return { kind: 'pending', reason: '待 L1 采集（滚动捕获）' };
}

// ============================================================
// T1/T4 — 轻量 claim 抽取（纯函数，规则层）
//
// 借了什么思想：ripples-of-aion 每轮用 LLM 抽出 facts + claims（entity/attribute/
// value 三元组）喂给时间轴。Aemeath 的规则层已有身份/偏好特征，够抽出**用户自身**
// 的关键属性——这里只做「确定性、封闭词表、可单测」的轻量抽取：
//   - 属性必须落在 attributes.ts 的规范词表（或别名）上，否则不抽（宁缺勿错）；
//   - 实体固定为传入的 entity（user_fact 场景即"用户"）；
//   - 抽取到的旧值不在这里判断——值的新旧由时间轴闭合决定（T1）。
// 抽取不到就返回空数组：调用方不写 entity_claims 字段（机制照常完好）。
// ============================================================

/** 属性 → 值 的抽取模式（`值` 捕获组；属性一侧允许"我的/我"前缀）。 */
const CLAIM_PATTERNS: ReadonlyArray<{ attr: string; re: RegExp }> = [
  { attr: '姓名', re: /(?:我叫|我的名字(?:是|叫)?|名字(?:是|叫)?|全名(?:是)?)[\s:：]*([^，,。；;！!？?\n]{1,24})/ },
  { attr: '称呼', re: /(?:以后叫我|叫我|可以叫我|昵称(?:是|叫)?)[\s:：]*([^，,。；;！!？?\n]{1,16})/ },
  { attr: '学校', re: /(?:我(?:在|就读于|读|上)|就读(?:于)?|毕业于)[\s:：]*([^，,。；;！!？?\n]{1,24}?(?:大学|学院|高中|中学|学校|Uni|Universität))/ },
  { attr: '学校', re: /(?:我的)?(?:学校|大学|院校)(?:是|叫|在)[\s:：]*([^，,。；;！!？?\n]{2,24})/ },
  { attr: '专业', re: /(?:我的)?专业(?:是|为|叫)[\s:：]*([^，,。；;！!？?\n]{1,24})/ },
  { attr: '专业', re: /我(?:学的是|学的是|主修|读的是)[\s:：]*([^，,。；;！!？?\n]{1,24})/ },
  { attr: '年级', re: /(?:我是|我读|我上)[\s:：]*(大一|大二|大三|大四|研一|研二|研三|博一|博二|准大一|[0-9一二三四五六七八九十]+年级|[0-9]+\.\s?Semester|第[0-9一二三四五六七八九十]+学期)/ },
  { attr: '所在地', re: /我(?:住在|搬到|搬去|居住在|定居在|来自)[\s:：]*([^，,。；;！!？?\n]{1,24}(?:市|区|州|省|国|镇|城)?)/ },
  { attr: '学习目标', re: /我的(?:学习)?目标(?:是|为)?[\s:：]*([^，,。；;！!？?\n]{2,40})/ },
  { attr: '薄弱环节', re: /我(?:的)?(?:薄弱(?:环节|点)?|弱项|短板)(?:是|在|为)?[\s:：]*([^，,。；;！!？?\n]{2,30})/ },
  { attr: '偏好', re: /我(?:最|很|比较)?(?:喜欢|爱|偏好|讨厌|不喜欢)[\s:：]*([^，,。；;！!？?\n]{1,30})/ },
  { attr: '作息', re: /我(?:一般|通常|习惯)?[\s:：]*(?:在)?[\s:：]*([0-9一二三四五六七八九十]{1,2}\s*点[^，,。；;！!？?\n]{0,20}(?:睡|起|学习|起床))/ },
  { attr: '联系方式', re: /我(?:的)?(?:邮箱|邮件|手机号?|电话|微信|联系方式)(?:是|为)[\s:：]*([^，,。；;！!？?\n]{3,32})/ },
  { attr: '健康状况', re: /我(?:的)?(?:健康状况|身体(?:状况|状态)|健康)(?:是|为|不太好|不好)?[\s:：]*([^，,。；;！!？?\n]{1,24})/ },
  { attr: '成绩', re: /我(?:的)?(?:成绩|分数|绩点|得分)(?:是|为|考了|拿了)[\s:：]*([^，,。；;！!？?\n]{1,20})/ },
  { attr: '考试', re: /我(?:的)?(?:考试|考期|Klausur)(?:是|在|定在|安排(?:在)?)[\s:：]*(?:下?周[一二三四五六日天]|下个?月|[0-9]{1,2}月|[0-9]{1,2}[日号]|[一二三四五六七八九十]+月)?[\s:：]*([^，,。；;！!？?\n]{2,24})/ },
  // 选课枚举（"我这学期选了热力学和光学两门课"）：只认"选了/选了课"这类**稳定选课**陈述，
  // 不认"在复习物理课"（那是进行中活动，不是属性）——实测这两类是真实数据里的主要漏抽来源
  { attr: '课程', re: /我(?:这学期|上学期|下学期|本学期)?(?:选(?:了|修)?|报(?:了|名)?|注册(?:了)?)([^，,。；;！!？?\n]{2,24}?)(?:两门|三门|门)?(?:课|课程)/ },
];

/** claim 抽取用的宽松结构（valid_from 由写入侧补）。 */
export interface ExtractedClaim {
  entity: string;
  attribute: string;
  value: string;
}

/** 单条记忆最多挂的 claim 数（护栏；参考对象每轮最多 8 条）。 */
export const MAX_CLAIMS_PER_RECORD = 8;

/** 值清洗：去首尾标点/空白、压内部空白、去掉尾随句末虚词。 */
function cleanClaimValue(raw: string): string {
  let v = (raw ?? '').trim().replace(/^[，,、：:\s"'「【]+/, '').replace(/[，,、：:\s"'」】]+$/, '');
  v = v.replace(/\s+/g, ' ');
  v = v.replace(/(?:了|啦|吧|呀|啊|哦|呢|的)$/u, '');
  return v.trim();
}

/**
 * 疑问残留判定：抽出疑似值的**提问**不是事实。
 * 真实数据里出现过 `姓名=什么名字吗` 这种噪声（用户问"你还记得我叫什么名字吗？"），
 * claim 抽取跑在规则层动作判定之前，拿不到"这句是不是问句"的信号，故在此自查。
 */
const QUESTION_RESIDUE = /[?？]|吗$|呢$|什么|怎么|哪里|哪儿|多少|几号|哪一?[个天月年课]/;

/** 值是否可信（排掉提问残留与纯占位）。 */
function isPlausibleClaimValue(value: string): boolean {
  if (!value) return false;
  if (QUESTION_RESIDUE.test(value)) return false;
  if (/^(null|none|nil|n\/a|undefined|unknown|不详|未知|无|没有|空|待定|未提供)$/i.test(value)) return false;
  return true;
}

/**
 * 从文本抽 claim（确定性规则；抽不到返回 []）。
 * @param text 待抽取文本（一般取写入门禁后的 content）
 * @param entity 实体名（user_fact 场景传 '用户'）
 */
export function extractClaims(text: string, entity = '用户'): ExtractedClaim[] {
  const src = (text ?? '').trim();
  const ent = (entity ?? '').trim();
  if (!src || !ent) return [];
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const { attr, re } of CLAIM_PATTERNS) {
    const m = re.exec(src);
    if (!m) continue;
    const value = cleanClaimValue(m[1] ?? '');
    if (!isPlausibleClaimValue(value)) continue;
    // 值不能就是属性名本身（"我的专业是专业"这类脏数据）
    if (value === attr) continue;
    const key = `${attr}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entity: ent, attribute: attr, value });
    if (out.length >= MAX_CLAIMS_PER_RECORD) break;
  }
  return out;
}

/**
 * 新值判定（T2 用）：本次抽到的 claim 与旧记忆的活跃 claim 相比，是否存在
 * **同一 (entity, canonicalAttr) 但值不同**的项 → 属"同一属性取值变化"（演进）。
 * 两侧属性都过 canonicalAttr（老数据里的非规范字面量也能命中）。
 * 值完全相同的重述由写入侧去重（hasActiveClaim），此处只看"变了没有"。
 */
export function hasNewClaimValue(
  oldClaims: ReadonlyArray<{ entity: string; attribute: string; value: string; valid_until: number | null }> | undefined,
  newClaims: ReadonlyArray<{ entity: string; attribute: string; value: string }>,
): boolean {
  if (!oldClaims?.length || !newClaims.length) return false;
  const norm = (s: unknown): string => String(s ?? '').trim().replace(/\s+/g, '').toLowerCase();
  for (const nc of newClaims) {
    const key = `${norm(nc.entity)}\u0000${canonicalAttr(nc.attribute)}`;
    for (const oc of oldClaims) {
      if (oc.valid_until !== null) continue; // 只比活跃断言
      if (`${norm(oc.entity)}\u0000${canonicalAttr(oc.attribute)}` !== key) continue;
      if (norm(oc.value) !== norm(nc.value)) return true;
    }
  }
  return false;
}
