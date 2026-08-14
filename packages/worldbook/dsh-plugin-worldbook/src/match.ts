// ============================================================
// match.ts — Worldbook 匹配逻辑（v1 worldbook.py 移植为纯函数，可单测）
// 顺序：constant(自传头) → 触发命中(priority/intrinsic_value 降序) → chain 递归补入（去重+防环）
// token 上限：maxTokens（中文≈1 字/token 保守估算，至少注入首条）
// ============================================================

export interface WorldbookEntry {
  id: string;
  title?: string;
  kind?: 'identity' | 'knowledge';
  triggers?: string[];
  constant?: boolean;
  intrinsic_value?: number;
  priority?: number;
  chain?: string[];
  content: string;
  source?: string;
  exam_points?: string;
  verifiable?: boolean;
}

/** 归一化：小写 + 去空白/标点（Unicode 属性类保留所有字母与数字，含中文）。 */
export function normalize(text: string): string {
  if (!text) return '';
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 条目 → 注入文本。identity=第一人称正文；knowledge=正文+来源+考点。 */
export function formatEntry(e: WorldbookEntry): string {
  const title = e.title || e.id;
  const content = (e.content || '').trim();
  const lines = [`【${title}】`, content];
  const src = (e.source || '').trim();
  const ep = (e.exam_points || '').trim();
  if (src) lines.push(`来源：${src}`);
  if (ep) lines.push(`考点：${ep}`);
  return lines.join('\n');
}

/** 按 (priority, intrinsic_value) 降序（确定性排序）。 */
function byPriority(a: WorldbookEntry, b: WorldbookEntry): number {
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pb - pa;
  return (b.intrinsic_value ?? 0) - (a.intrinsic_value ?? 0);
}

export const MAX_CHAIN_DEPTH = 3;

/**
 * 匹配并组装注入文本。返回 '' 表示无命中。
 * @param query     用户输入（归一化后做 trigger 子串匹配）
 * @param entries   当前馆全部条目
 * @param maxTokens 注入 token 上限（约等于字符数）
 */
export function matchWorldbook(query: string, entries: WorldbookEntry[], maxTokens: number): string {
  if (!query || !entries?.length) return '';
  const normQ = normalize(query);
  const byId = new Map(entries.map((e) => [e.id, e]));

  // 常驻条目：无条件注入，按优先级排序保证确定性
  const constants = entries.filter((e) => e.constant).sort(byPriority);
  // 触发条目：任一 trigger 子串命中（归一化后）
  const hits = entries
    .filter((e) => {
      if (e.constant) return false;
      return (e.triggers || []).some((t) => {
        const nt = normalize(t);
        return nt.length > 0 && normQ.includes(nt);
      });
    })
    .sort(byPriority);

  // chain 递归补入（去重 + 最大深度防环）
  const ordered: WorldbookEntry[] = [];
  const seen = new Set<string>();

  const walk = (e: WorldbookEntry, depth: number): void => {
    if (seen.has(e.id) || depth > MAX_CHAIN_DEPTH) return;
    seen.add(e.id);
    ordered.push(e);
    for (const cid of e.chain || []) {
      const ce = byId.get(cid);
      if (ce) walk(ce, depth + 1);
    }
  };

  for (const e of constants) walk(e, 0);
  for (const e of hits) walk(e, 0);

  // 注入 token 上限（至少注入首条）
  const parts: string[] = [];
  let used = 0;
  for (const e of ordered) {
    const text = formatEntry(e);
    const approx = text.length;
    if (parts.length && used + approx > maxTokens) break;
    parts.push(text);
    used += approx;
  }

  if (!parts.length) return '';
  return '## Worldbook 知识库\n' + parts.join('\n\n');
}

/** 命中概要（供 retrieve_worldbook 工具返回结构化结果）。 */
export function hitSummary(entries: WorldbookEntry[], query: string, limit = 5): Array<{ id: string; title: string; source: string; verifiable: boolean }> {
  if (!query) return [];
  const normQ = normalize(query);
  return entries
    .filter((e) => (e.triggers || []).some((t) => {
      const nt = normalize(t);
      return nt.length > 0 && normQ.includes(nt);
    }))
    .sort(byPriority)
    .slice(0, limit)
    .map((e) => ({ id: e.id, title: e.title || e.id, source: e.source || '', verifiable: !!e.verifiable }));
}
