// ============================================================
// memory-view.ts — 记忆工作区的**宿主侧视图构造**（纯函数，可单测）
//
// 为什么单独放一个文件：这些逻辑原先内联在 src/index.ts 的 HTTP 处理器里，只能靠
// 起服务 + 发请求才能验证。抽出来之后：① 输入是"记忆服务的最小接口面"，输出是可直接
// 序列化的 JSON；② 可以在 node 里用一个假 service 直接测（test/check-memory-view.mjs）；
// ③ HTTP 处理器只负责取参数 + 调这里 + json()，不含业务逻辑。
// ============================================================

/** 记忆服务在本模块用到的**最小接口面**（真实 ctx.memory 是它的超集）。 */
export interface MemoryServiceFace {
  list(): Array<{ key: string; rec: Record<string, unknown> }>;
  stats(): { active: number; dormant: number; archived?: number; byPreset: Record<string, number>; byScope: Record<string, number> };
  profileFacts?(): string[];
  l1Sessions?(): string[];
  l1Turns?(sid: string): Array<{ query?: string; reply?: string; kind?: string; ts?: number; preset?: string }>;
  l1CapacityOf?(): { capacity: number; threshold: number };
  /** T1 时间轴（index.ts 注入的只读查询）。 */
  timeline?(entity: string, attribute: string): Array<{ entity: string; attribute: string; value: string; valid_from: number; valid_until: number | null }>;
  currentClaim?(entity: string, attribute: string): { entity: string; attribute: string; value: string; valid_from: number; valid_until: number | null } | undefined;
  knownAttributes?(): string[];
  /** T3 洞察。 */
  currentInsights?(): unknown;
  dreamNow?(): Promise<unknown>;
}

/** 时间轴视图里每个属性的断言序列。 */
export interface TimelineAttributeRow {
  attribute: string;
  claims: Array<{ entity: string; attribute: string; value: string; valid_from: number; valid_until: number | null }>;
}

const claimsOf = (rec: Record<string, unknown>): TimelineAttributeRow['claims'] => {
  if (!Array.isArray(rec.entity_claims)) return [];
  return (rec.entity_claims as Array<Record<string, unknown>>).map((c) => ({
    entity: String(c.entity ?? ''),
    attribute: String(c.attribute ?? ''),
    value: String(c.value ?? ''),
    valid_from: typeof c.valid_from === 'number' ? c.valid_from : 0,
    valid_until: typeof c.valid_until === 'number' ? c.valid_until : null,
  }));
};

/** 记忆列表（工作区「记忆」页 + 既有面板共用）。 */
export function buildMemoryList(memory: MemoryServiceFace): Array<{
  id: string;
  content: string;
  category: string;
  importance: number;
  scope: string;
  preset: string;
  status: string;
  activation: number;
  created_at: number;
  last_access: number;
  claims: TimelineAttributeRow['claims'];
}> {
  return memory.list().map(({ key, rec }) => ({
    id: key,
    content: String(rec.content ?? '').slice(0, 200),
    category: String(rec.category ?? 'session_summary'),
    importance: typeof rec.importance === 'number' ? rec.importance : 0,
    scope: String(rec.scope ?? 'mode'),
    preset: String(rec.preset ?? ''),
    status: String(rec.status ?? 'active'),
    activation: typeof rec.activation === 'number' ? rec.activation : 50,
    created_at: typeof rec.created_at === 'number' ? rec.created_at : 0,
    last_access: typeof rec.last_access === 'number' ? rec.last_access : 0,
    claims: claimsOf(rec),
  }));
}

/** 主视图（GET /aemeath/api/memory 的默认返回）。 */
export function buildMemoryOverview(memory: MemoryServiceFace): {
  ok: true;
  l1: Array<{ sessionId: string; items: Array<{ key: string; content: string }> }>;
  l2: ReturnType<typeof buildMemoryList>;
  l3: ReturnType<typeof buildMemoryList>;
  stats: ReturnType<MemoryServiceFace['stats']>;
  l1Buffer: Array<{ sessionId: string; turns: Array<{ query: string; reply: string; kind: string; ts: number }> }>;
  l1Capacity: { capacity: number; threshold: number } | null;
  profile: string[];
  plans: Record<string, string[]>;
} {
  const items = buildMemoryList(memory);
  const stats = memory.stats();
  const profile = memory.profileFacts?.() ?? [];
  const scratch = (memory as unknown as { allScratch?: () => Record<string, Record<string, string>> }).allScratch?.() ?? {};
  const l1 = Object.entries(scratch)
    .map(([sid, slot]) => ({ sessionId: sid, items: Object.entries(slot).map(([k, v]) => ({ key: k, content: String(v).slice(0, 200) })) }))
    .filter((s) => s.items.length > 0);
  const plans: Record<string, string[]> = {};
  for (const [sid, slot] of Object.entries(scratch)) {
    const raw = slot['workflow.plan'];
    if (!raw) continue;
    try {
      const p = JSON.parse(raw) as unknown;
      if (Array.isArray(p)) plans[sid] = p.map((s) => String(s)).map((s) => s.trim()).filter(Boolean);
    } catch {
      /* 坏 JSON：整会话跳过（前端显示空/off） */
    }
  }
  const l1Buffer = (memory.l1Sessions?.() ?? [])
    .map((sid) => ({
      sessionId: sid,
      turns: (memory.l1Turns?.(sid) ?? []).map((t) => ({
        query: String(t.query ?? '').slice(0, 200),
        reply: String(t.reply ?? '').slice(0, 200),
        kind: String(t.kind ?? 'fact'),
        ts: typeof t.ts === 'number' ? t.ts : 0,
      })),
    }))
    .filter((s) => s.turns.length > 0);
  return {
    ok: true,
    l1,
    l2: items.filter((m) => m.scope === 'mode'),
    l3: items.filter((m) => m.scope === 'global'),
    stats,
    l1Buffer,
    l1Capacity: memory.l1CapacityOf?.() ?? null,
    profile,
    plans,
  };
}

/**
 * 时间轴视图（GET ?action=timeline）：返回该实体**每一个有断言的属性**的区间序列。
 * 用 knownAttributes 遍历而只查一个属性：工作区需要"这个实体有哪些属性"才能画时间轴，
 * 一次请求把全部属性拿回来（每个属性一次内存遍历，量级可忽略）。
 */
export function buildTimelineView(
  memory: MemoryServiceFace,
  entity: string,
  probeAttribute = '',
): { ok: true; entity: string; attributes: TimelineAttributeRow[]; current: TimelineAttributeRow['claims'][number] | null } {
  const attrs = memory.knownAttributes?.() ?? [];
  const rows: TimelineAttributeRow[] = [];
  for (const attribute of attrs) {
    const claims = memory.timeline?.(entity, attribute) ?? [];
    if (claims.length) rows.push({ attribute, claims });
  }
  // 兜底：knownAttributes 不可用（旧版 memory 服务）时，退化为对指定属性单查一次
  if (!attrs.length && probeAttribute) {
    const claims = memory.timeline?.(entity, probeAttribute) ?? [];
    if (claims.length) rows.push({ attribute: probeAttribute, claims });
  }
  return { ok: true, entity, attributes: rows, current: memory.currentClaim?.(entity, probeAttribute) ?? null };
}

/** 图谱视图（GET ?action=graph）：节点=实体（提及次数），边=同记忆共现次数。 */
export function buildGraphView(memory: MemoryServiceFace): {
  ok: true;
  nodes: Array<{ id: string; count: number }>;
  edges: Array<{ a: string; b: string; weight: number }>;
} {
  const nodes = new Map<string, { id: string; count: number }>();
  const edges = new Map<string, { a: string; b: string; weight: number }>();
  for (const { rec } of memory.list()) {
    const entities = Array.from(new Set(claimsOf(rec).map((c) => c.entity.trim()).filter(Boolean)));
    if (!entities.length) continue;
    for (const e of entities) nodes.set(e, { id: e, count: (nodes.get(e)?.count ?? 0) + 1 });
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const [x, y] = entities[i] < entities[j] ? [entities[i], entities[j]] : [entities[j], entities[i]];
        const k = `${x}\u0000${y}`;
        const cur = edges.get(k);
        edges.set(k, { a: x, b: y, weight: (cur?.weight ?? 0) + 1 });
      }
    }
  }
  return {
    ok: true,
    nodes: [...nodes.values()].sort((a, b) => b.count - a.count).slice(0, 40),
    edges: [...edges.values()].sort((a, b) => b.weight - a.weight).slice(0, 80),
  };
}
