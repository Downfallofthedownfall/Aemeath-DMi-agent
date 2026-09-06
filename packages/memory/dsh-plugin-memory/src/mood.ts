// ============================================================
// mood.ts — A3 mood observer + A4 relationship cue（借 Cyrene 桌面伴侣
// "mood observer + relationship context"的想法，只取思想，不复制其代码）。
// 纯函数、可单测；LLM 通道（moodClassifierPrompt）只在 index.ts 的观察器里
// 于 llm.enabled && apiKey 时走，否则/失败一律回落这里的确定性规则。
// ============================================================

/** 角色情绪标签词表（中文主标签；LLM 可回其他标语，但平滑与展示以确定性词表为基准）。 */
export const MOOD_LABELS = ['平静', '开心', '难过', '思考', '害羞', '生气'] as const;
export type MoodLabel = (typeof MOOD_LABELS)[number];

/** 滚动平滑窗口长度（近 5 轮观测做多数表决，防止情绪标签跳变）。 */
export const MOOD_WINDOW_CAP = 5;

/**
 * 确定性情绪关键词规则（有序：靠前的更具体先命中）。命中→对应标签；
 * 全部未命中 → 平静。回复文本也参与（角色回复语气可反映情绪），但用户
 * 提问优先——规则按"更具体情绪词先于中性/问句"排列，避免"怎么"类问句
 * 把明显的好/坏情绪掩盖掉。
 */
const MOOD_KEYWORD_RULES: Array<[RegExp, string]> = [
  [/开心|高兴|哈哈|太棒|真棒|太好了|不错|喜欢|兴奋|满意|爽|棒|高兴|爱了|幸福/, '开心'],
  [/难过|伤心|哭|沮丧|低落|难受|郁闷|委屈|失望|心碎|emo|想哭|不开心/, '难过'],
  [/生气|气死|愤怒|恼火|烦死|烦|怒|讨厌|不爽/, '生气'],
  [/害羞|不好意思|尴尬|脸红|紧张|社恐|羞|拘谨/, '害羞'],
  [/思考|考虑|纠结|困惑|疑惑|犹豫|琢磨|想一想|想一下|怎么|什么|为什么|如何|分析|推敲|不懂|不会/, '思考'],
];

/** 确定性情绪分类（规则兜底，测试稳定；无 LLM / LLM 失败时使用）。 */
export function classifyMoodStable(query: string, reply = ''): string {
  const text = `${query || ''} ${reply || ''}`;
  for (const [re, label] of MOOD_KEYWORD_RULES) {
    if (re.test(text)) return label;
  }
  return '平静';
}

/**
 * 滚动平滑：把新增标签推进窗口（封顶），返回新窗口。
 * 配合 majorityLabel 一起，让情绪标签不随单轮输入剧烈跳变。
 */
export function pushMoodWindow(window: readonly string[], label: string, cap = MOOD_WINDOW_CAP): string[] {
  return [...window, label].slice(-cap);
}

/**
 * 多数表决平滑（确定性）：返回窗口中出现次数最多的标签；计数相同则取
 * 最近出现者（让最近的观测在平局时占优，更贴近"当前"状态）。
 */
export function majorityLabel(labels: readonly string[]): string {
  if (!labels.length) return '平静';
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  let best = labels[0];
  let bestCount = -1;
  // 用严格大于：从最新一条开始数，等票时保留"最近出现"的那个（更贴近当前状态）
  for (let i = labels.length - 1; i >= 0; i--) {
    const c = counts.get(labels[i])!;
    if (c > bestCount) {
      bestCount = c;
      best = labels[i];
    }
  }
  return best;
}

/** 由情绪标签确定性派生关系信号（供 cue 注入的"关系信号"一行）。 */
export function relationshipSignalOf(mood: string): string {
  switch (mood) {
    case '开心': return '用户情绪不错，氛围轻松';
    case '难过': return '用户情绪低落，需要倾听';
    case '生气': return '用户带着情绪，说话要平和';
    case '思考': return '用户在思考/提问，需要清晰解答';
    case '害羞': return '用户有些害羞/拘谨，节奏放慢';
    default: return '用户平静，日常交流';
  }
}

/** 由情绪标签确定性派生"下一轮照顾提示"。 */
export function nextCareCueOf(mood: string): string {
  switch (mood) {
    case '难过': return '先安慰陪伴，别急着讲道理';
    case '生气': return '先顺着对方，别顶撞，少说教';
    case '害羞': return '轻轻带动话题，别让气氛冷场';
    case '思考': return '给清晰简短的解答，别堆术语';
    case '开心': return '回应对方的兴致，别扫兴';
    default: return '自然回应，保持陪伴';
  }
}

/** 供 LLM 通道使用的提示词（同源思想：让模型读最近对话标一个情绪标签）。仅 LLM 启用时构串。 */
export function moodClassifierPrompt(query: string, reply: string, personaHint = ''): string {
  const q = (query || '').slice(0, 600);
  const r = (reply || '').slice(0, 600);
  return [
    `你是情绪观察器。读取下面这轮对话，判断"角色"此刻的情绪，只输出一个中文标签（${MOOD_LABELS.join(' / ')}）。`,
    personaHint ? `角色提示：${personaHint}` : '',
    q ? `用户：${q}` : '',
    r ? `角色回复：${r}` : '',
    '只输出标签本身，不要其他文字。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 生成【近期关系线索】注入块文本。任一字段为空（或整条记录为空）→ ''。
 * 由 ctx.memory.recallRelationshipCue() 调用，供人格插件注入模型上下文。
 */
export function buildRelationshipCue(rec: { mood?: string; signal?: string; preference?: string; nextCareCue?: string; updatedTs?: number } | undefined | null): string {
  if (!rec) return '';
  const mood = (rec.mood ?? '').trim();
  const signal = (rec.signal ?? '').trim();
  const preference = (rec.preference ?? '').trim();
  const nextCareCue = (rec.nextCareCue ?? '').trim();
  if (!mood && !signal && !preference && !nextCareCue) return '';
  const lines = ['【近期关系线索】'];
  if (mood) lines.push(`- 当前状态：${mood}`);
  if (signal) lines.push(`- 关系信号：${signal}`);
  if (preference) lines.push(`- 用户偏好：${preference}`);
  if (nextCareCue) lines.push(`- 照顾提示：${nextCareCue}`);
  return lines.join('\n');
}
