// ============================================================
// fts.ts — FTS5 查询构造与相关度判断（纯函数，可单测）
// ============================================================

/** 中文 bigram 化（"牛顿第二定律" → "牛顿 顿第 第二 二定 定律"）。 */
function bigramize(cjk: string): string {
  const grams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i++) grams.push(cjk.slice(i, i + 2));
  return grams.join(' ');
}

/** 可索引文本：中文转 bigram + 英文/数字保留（供 FTS5 unicode61 检索中文子串）。 */
export function toIndexable(text: string): string {
  let out = '';
  let buf = '';
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) {
      buf += ch;
      continue;
    }
    if (buf) {
      out += bigramize(buf) + ' ';
      buf = '';
    }
    if (/[a-zA-Z0-9]/.test(ch)) out += ch.toLowerCase();
    else out += ' ';
  }
  if (buf) out += bigramize(buf);
  return out;
}

/** 这些双字组几乎每句话都有，不能算"命中了讲义"。 */
const STOP_TERMS = new Set([
  '什么', '怎么', '为什', '如何', '一下', '可以', '这个', '那个', '这些', '那些', '一个', '我们', '你们', '他们', '就是', '如果',
  '因为', '所以', '但是', '还是', '或者', '以及', '然后', '现在', '知道', '觉得', '应该', '需要', '帮我', '请问', '没有', '不是',
  '的是', '是不', '不会', '不懂', '不太', '能不', '有没', '告诉', '讲讲', '说说', '看看',
]);

/**
 * 英文 / 德文里几乎每句都有的词（讲义多是德文或英文）。
 * 不去掉的话，is / the / der / und 就能凑够"命中 2 个词"，相关度门槛对外文提问形同虚设。
 */
const LATIN_STOP_TERMS = new Set([
  // English
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'not', 'no',
  'it', 'its', 'this', 'that', 'these', 'those', 'with', 'as', 'by', 'from', 'into', 'than', 'then', 'so', 'but', 'if', 'about',
  'what', 'how', 'why', 'when', 'where', 'which', 'who', 'can', 'could', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would',
  'should', 'there', 'their', 'we', 'you', 'he', 'she', 'they', 'me', 'my', 'your', 'our', 'please', 'help', 'tell', 'explain',
  'show', 'give', 'need', 'want', 'know', 'think', 'just', 'also', 'some', 'any', 'all', 'more', 'very', 'here', 'today',
  // Deutsch（变音字母在 toIndexable 里会被切开，这里只列纯 ASCII 的词）
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'und', 'oder', 'nicht', 'kein',
  'ist', 'sind', 'war', 'sein', 'im', 'an', 'auf', 'aus', 'bei', 'mit', 'nach', 'von', 'vor', 'zu', 'zum', 'zur', 'um', 'am',
  'wie', 'warum', 'wo', 'wer', 'wenn', 'dann', 'auch', 'es', 'er', 'sie', 'wir', 'ich', 'man', 'kann', 'wird', 'werden', 'hat',
  'haben', 'als', 'dass', 'sich', 'noch', 'nur', 'aber', 'durch', 'bitte', 'mir', 'mich', 'du', 'heute',
]);

const isCjkTerm = (term: string): boolean => /[一-鿿]/.test(term);

/** 外文词至少这么长才算"有辨识度的术语"（单独命中就够）。 */
const KEYWORD_MIN_LENGTH = 5;

/** 查询里真正用来检索的词（去重 + 去掉常用词）。 */
export function queryTerms(query: string): string[] {
  const terms = toIndexable(query)
    .split(/\s+/)
    .map((t) => t.trim().replace(/"/g, ''))
    .filter((t) => t.length > 0 && !STOP_TERMS.has(t) && !LATIN_STOP_TERMS.has(t));
  return [...new Set(terms)];
}

/** FTS5 MATCH 查询：按词 OR 组合（中文短词召回）；无可用词返回 ''。 */
export function buildFtsQuery(terms: readonly string[]): string {
  return terms.map((t) => `"${t}"`).join(' OR ');
}

/**
 * 一块讲义是否真的和问题相关。
 *
 * ⚠️ FTS 的 OR 查询只要撞上一个词就算命中，bm25 只负责排序、没有下限：
 *   学霸每条超过 8 个字的消息都会塞进 3 段讲义，哪怕毫不相关。这里要求至少命中 2 个
 *   不同的词（问题本身只有 1 个词时命中它即可），并且覆盖 20% 以上的查询词。
 *
 * ⚠️ 外文术语单独算：讲义是德文 / 英文、提问是中文时（"Drehimpuls 怎么推导"），
 *   中文连接词切出的双字组（么推 / 推导）也占词数，讲义里又不可能有它们 ——
 *   只按上面的规则，这种最常见的问法永远只命中 1 个词、永远被滤掉。
 *   所以命中一个够长的外文词、且它在外文词里占 20% 以上，也算相关。
 */
export function isRelevantChunk(terms: readonly string[], chunkIndexText: string): boolean {
  if (!terms.length) return false;
  const tokens = new Set(chunkIndexText.split(/\s+/));
  const matched = terms.filter((t) => tokens.has(t));
  if (matched.length >= Math.min(2, terms.length) && matched.length / terms.length >= 0.2) return true;
  const latinTerms = terms.filter((t) => !isCjkTerm(t));
  const keywords = matched.filter((t) => !isCjkTerm(t) && t.length >= KEYWORD_MIN_LENGTH);
  return keywords.length > 0 && keywords.length / latinTerms.length >= 0.2;
}
