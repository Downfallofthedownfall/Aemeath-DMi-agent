// ============================================================
// bm25.ts — 轻量 BM25 检索（纯函数，可单测；无重型依赖）
// 用于：① 记忆查重（pending 候选 vs 现有记忆，top-3 喂给 LLM 判定层）
//       ② 冲突检测（时间证据命中时定位 target 记忆）
// 分词：英文按词（小写），中文按 bigram（对短文本鲁棒）
// ============================================================

export interface Bm25Doc {
  id: string;
  content: string;
}

/** 分词：英文词（小写）+ 中文 bigram。 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const latin = text.toLowerCase().match(/[a-z0-9]+/g);
  if (latin) out.push(...latin);
  const cjk = (text || '').replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) out.push(cjk.slice(i, i + 2));
  return out;
}

export interface Bm25Result {
  id: string;
  score: number;
}

/**
 * 有界 bigram 重叠相似度（第三关：consolidate/冲突判定不再用裸 BM25 分数阈值——
 * 原始分数无量纲、随语料规模漂移）。定义 = |A∩B| / min(|A|,|B|) ∈ [0,1]：
 * 较短短语的 bigram 被对方覆盖的比例。"我周三的物理考试考完了" vs
 * "我下周三有物理考试" = 4/8 = 0.5，语义上正是同一记忆的变体。
 */
export function overlapScore(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

const K1 = 1.5;
const B = 0.75;

/**
 * 对 query 与文档集计算 BM25 分数，返回按分数降序的 top-k。
 * @param query   检索词
 * @param docs    文档集（记忆记录）
 * @param topK    返回条数
 */
export function search(query: string, docs: Bm25Doc[], topK = 3): Bm25Result[] {
  if (!query || !docs.length) return [];

  const N = docs.length;
  const docTokens = docs.map((d) => tokenize(d.content));
  const docLengths = docTokens.map((t) => t.length);
  const avgLen = docLengths.reduce((a, b) => a + b, 0) / N || 1;

  const qTokens = tokenize(query);
  if (!qTokens.length) return [];

  // idf（含平滑，避免 0/负值）
  const idf = (df: number): number => Math.log(1 + (N - df + 0.5) / (df + 0.5));

  // 第三关：文档频率只算一次（原实现对每个 doc×term 重扫全量 → O(N²)）
  const dfByTerm = new Map<string, number>();
  for (const qt of qTokens) {
    if (dfByTerm.has(qt)) continue;
    let df = 0;
    for (const dt of docTokens) if (dt.includes(qt)) df++;
    dfByTerm.set(qt, df);
  }
  // 归一化分母：单次命中、平均长度文档的理论最高分（Σ idf）——把裸 BM25 分数
  // 压到 [0,1]，使跨查询/跨语料可比（consolidateTarget 的 0.8 阈值不再依赖量纲）
  const norm = qTokens.reduce((a, qt) => a + idf(dfByTerm.get(qt) ?? 0), 0) || 1;

  const scored: Bm25Result[] = [];
  for (let i = 0; i < N; i++) {
    const tokens = docTokens[i];
    if (!tokens.length) continue;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const len = docLengths[i];
    let score = 0;
    for (const qt of qTokens) {
      const f = tf.get(qt) ?? 0;
      if (!f) continue;
      score += idf(dfByTerm.get(qt) ?? 0) * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (len / avgLen))));
    }
    if (score > 0) scored.push({ id: docs[i].id, score: score / norm });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
