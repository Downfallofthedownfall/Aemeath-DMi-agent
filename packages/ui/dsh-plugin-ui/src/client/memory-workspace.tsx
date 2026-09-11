// ============================================================
// memory-workspace.tsx — 记忆工作区（五页 IA 借 ripples-of-aion 面板）
//
// 借了什么（信息架构 + 交互，不抄代码）：
//   ① 五页切分：记忆（三栏浏览 + 底部可展开的**实体属性时间轴**）/ 图谱（实体共现力导向图）/
//      检索台（检索调试视角，只读）/ 洞察（autoDream 主题簇 + 疑似矛盾 + 「立即做梦」）/ 状态；
//   ② 视觉语言（圆角软阴影卡片、粉调强调、标题点饰）见 memory-tokens.ts；
//   ③ 参考对象的面板是独立 Electron 窗口；Aemeath 的宿主 Web UI 只开放
//      sidebar / conversation / details / shell.overlay 四个座位，**没有独立路由页**，
//      因此本工作区做成挂在 shell.overlay 上的**全屏层**（宿主唯一的加法座位），
//      由侧边栏「快速设置」里的入口打开。
//
// 数据来源：全部走宿主 /aemeath/api/memory（UI 插件代理 → ctx.memory 服务），
//   前端不持有 memory 插件 admin 端点的 token。
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
// 引入布局插件的客户端类型声明（声明合并出 'shell.overlay' 等座位名；仅类型，无运行时代码）
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import { t } from './i18n.ts';
import { injectMemoryWorkspaceStyles, MEMORY_WORKSPACE_CLASS } from './memory-tokens.ts';

// ---------- 类型 ----------
interface ClaimRow {
  entity: string;
  attribute: string;
  value: string;
  valid_from: number;
  valid_until: number | null;
}

interface MemoryItem {
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
  claims: ClaimRow[];
}

interface BufferSession {
  sessionId: string;
  turns: Array<{ query: string; reply: string; kind: string; ts: number }>;
}

interface Insights {
  version: number;
  last_run_at: number;
  clusters: Array<{ id: string; label: string; recordIds: string[]; created_at: number }>;
  conflicts: Array<{ id: string; note: string; recordIds: [string, string]; created_at: number }>;
}

interface GraphData {
  nodes: Array<{ id: string; count: number }>;
  edges: Array<{ a: string; b: string; weight: number }>;
}

interface WorkspaceData {
  l2: MemoryItem[];
  l3: MemoryItem[];
  stats: { active: number; dormant: number; archived: number; byScope: Record<string, number> };
  l1Buffer?: BufferSession[];
  profile?: string[];
}

/** 时间轴筛选下拉的兜底属性词表（后端 knownAttributes 未就绪时用；与 attributes.ts 同源）。 */
const FALLBACK_ATTRS = [
  '姓名', '称呼', '学校', '专业', '年级', '课程', '考试', '成绩', '学习目标',
  '薄弱环节', '偏好', '作息', '关系', '健康状况', '联系方式', '所在地', '结论',
];

// ---------- 数据层 ----------
const jsonOrNull = async <T,>(url: string, init?: RequestInit): Promise<T | null> => {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
};

const postAction = <T,>(action: string) =>
  jsonOrNull<T>('/aemeath/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });

// ---------- 小工具 ----------
const fmtTime = (ts: number): string => {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 激活值 → 热度档位（与后端三态阈值一致：≥60 热 / 30–59 温 / <30 冷）。 */
const heatOf = (activation: number): 'hot' | 'warm' | 'cold' => (activation >= 60 ? 'hot' : activation >= 30 ? 'warm' : 'cold');

// ============================================================
// 实体共现图：零依赖力导向布局（参考对象用 canvas 自绘；这里用 SVG + 简易模拟退火）
// 节点半径 ∝ 提及次数，边宽 ∝ 共现次数；悬停高亮邻接，点击跳记忆页过滤。
// ============================================================
function EntityGraph({ data, onPick }: { data: GraphData; onPick: (entity: string) => void }): JSX.Element {
  const [hover, setHover] = useState<string | null>(null);
  const layout = useMemo(() => {
    const W = 900;
    const H = 560;
    const nodes = data.nodes.slice(0, 40);
    if (!nodes.length) return { W, H, points: [] as Array<{ id: string; x: number; y: number; r: number; count: number }> };
    // 初始摆位：黄金角螺旋（确定性 → 同一份数据每次渲染布局稳定，不会"跳动"）
    const pts = nodes.map((n, i) => {
      const angle = i * 2.399963;
      const radius = Math.sqrt(i / Math.max(1, nodes.length)) * Math.min(W, H) * 0.42;
      return { id: n.id, x: W / 2 + Math.cos(angle) * radius, y: H / 2 + Math.sin(angle) * radius, r: 6 + Math.min(16, n.count * 2), count: n.count };
    });
    const index = new Map(pts.map((p, i) => [p.id, i]));
    const edges = data.edges
      .map((e) => ({ i: index.get(e.a), j: index.get(e.b), weight: e.weight }))
      .filter((e): e is { i: number; j: number; weight: number } => e.i !== undefined && e.j !== undefined);
    // 简易力模拟：斥力（全对）+ 弹簧（边）+ 向心力
    for (let iter = 0; iter < 220; iter++) {
      const alpha = 1 - iter / 220;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[j].x - pts[i].x;
          const dy = pts[j].y - pts[i].y;
          const dist = Math.max(1, Math.hypot(dx, dy));
          const rep = (5200 / (dist * dist)) * alpha;
          const fx = (dx / dist) * rep;
          const fy = (dy / dist) * rep;
          pts[i].x -= fx; pts[i].y -= fy;
          pts[j].x += fx; pts[j].y += fy;
        }
      }
      for (const e of edges) {
        const a = pts[e.i];
        const b = pts[e.j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const target = 120 + 10 * e.weight;
        const f = ((dist - target) / dist) * 0.02 * alpha;
        const fx = dx * f;
        const fy = dy * f;
        a.x += fx; a.y += fy;
        b.x -= fx; b.y -= fy;
      }
      for (const p of pts) {
        p.x += (W / 2 - p.x) * 0.006 * alpha;
        p.y += (H / 2 - p.y) * 0.006 * alpha;
        p.x = Math.max(28, Math.min(W - 28, p.x));
        p.y = Math.max(28, Math.min(H - 28, p.y));
      }
    }
    return { W, H, points: pts.map((p) => ({ ...p, x: Math.round(p.x), y: Math.round(p.y) })), edges };
  }, [data]);

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of data.edges) {
      (map.get(e.a) ?? map.set(e.a, new Set()).get(e.a))!.add(e.b);
      (map.get(e.b) ?? map.set(e.b, new Set()).get(e.b))!.add(e.a);
    }
    return map;
  }, [data]);

  if (!data.nodes.length) return <div className="mw-empty">{t('memws.graph.empty')}</div>;

  const points = layout.points as Array<{ id: string; x: number; y: number; r: number; count: number }>;
  const edges = (layout as { edges?: Array<{ i: number; j: number; weight: number }> }).edges ?? [];
  const dim = (id: string): boolean => !!hover && hover !== id && !(neighbours.get(hover)?.has(id) ?? false);

  return (
    <div className="mw-graph">
      <svg viewBox={`0 0 ${layout.W} ${layout.H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t('memws.nav.graph')}>
        {edges.map((e, i) => {
          const a = points[e.i];
          const b = points[e.j];
          if (!a || !b) return null;
          const active = !hover || hover === a.id || hover === b.id;
          return (
            <line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke="var(--aem-accent-2)"
              strokeOpacity={active ? 0.35 : 0.08}
              strokeWidth={Math.min(4, 0.8 + e.weight * 0.8)}
            />
          );
        })}
        {points.map((p) => (
          <g key={p.id} opacity={dim(p.id) ? 0.25 : 1} style={{ cursor: 'pointer' }} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)} onClick={() => onPick(p.id)}>
            <circle cx={p.x} cy={p.y} r={p.r} fill="var(--aem-accent)" fillOpacity={hover === p.id ? 0.95 : 0.72} stroke="var(--aem-surface)" strokeWidth={1.5} />
            <text x={p.x} y={p.y - p.r - 4} textAnchor="middle" fontSize={11} fill="var(--aem-ink-soft)">
              {p.id}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ============================================================
// 工作区主体（五页）
// ============================================================
type PageId = 'memory' | 'graph' | 'console' | 'insights' | 'status';

const PAGES: Array<{ id: PageId; key: string }> = [
  { id: 'memory', key: 'memws.nav.memory' },
  { id: 'graph', key: 'memws.nav.graph' },
  { id: 'console', key: 'memws.nav.console' },
  { id: 'insights', key: 'memws.nav.insights' },
  { id: 'status', key: 'memws.nav.status' },
];

function WorkspaceView({ onClose }: { onClose: () => void }): JSX.Element {
  const [page, setPage] = useState<PageId>('memory');
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  // 记忆页筛选
  const [q, setQ] = useState('');
  const [heat, setHeat] = useState<'all' | 'hot' | 'warm' | 'cold'>('all');
  const [scope, setScope] = useState<'all' | 'global' | 'mode'>('all');
  const [entityFilter, setEntityFilter] = useState('all');
  const [claimsOpen, setClaimsOpen] = useState(false);
  // 时间轴
  const [timeline, setTimeline] = useState<Array<{ attribute: string; claims: ClaimRow[] }>>([]);
  const attrs = FALLBACK_ATTRS;
  // 图谱 / 洞察 / 检索台
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [dreaming, setDreaming] = useState(false);
  const [dreamSkipped, setDreamSkipped] = useState(false);
  const [cq, setCq] = useState('');
  const [hits, setHits] = useState<Array<{ id: string; content: string; score: number; category: string }> | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const res = await jsonOrNull<{ ok: boolean; l2: MemoryItem[]; l3: MemoryItem[]; stats: WorkspaceData['stats']; l1Buffer?: BufferSession[]; profile?: string[] }>('/aemeath/api/memory');
    if (!res?.ok) {
      setOffline(true);
      setLoading(false);
      return;
    }
    setOffline(false);
    setData({ l2: res.l2 ?? [], l3: res.l3 ?? [], stats: res.stats, l1Buffer: res.l1Buffer ?? [], profile: res.profile ?? [] });
    setLoading(false);
  }, []);

  const loadTimeline = useCallback(async (entity: string): Promise<void> => {
    const res = await jsonOrNull<{ ok: boolean; attributes: Array<{ attribute: string; claims: ClaimRow[] }> }>(
      `/aemeath/api/memory?action=timeline&entity=${encodeURIComponent(entity)}&attribute=${encodeURIComponent(attrs[0] ?? '姓名')}`,
    );
    if (res?.ok) setTimeline(res.attributes ?? []);
  }, [attrs]);

  // 首屏：主数据 + 时间轴 + 图谱；洞察按需
  useEffect(() => {
    void refresh();
    void (async () => {
      const g = await jsonOrNull<{ ok: boolean; nodes: GraphData['nodes']; edges: GraphData['edges'] }>('/aemeath/api/memory?action=graph');
      if (g?.ok) setGraph({ nodes: g.nodes ?? [], edges: g.edges ?? [] });
    })();
    void (async () => {
      const res = await jsonOrNull<{ ok: boolean; insights: Insights | null }>('/aemeath/api/memory?action=insights');
      if (res?.ok) setInsights(res.insights ?? null);
    })();
  }, [refresh]);

  useEffect(() => {
    if (claimsOpen && !timeline.length) void loadTimeline('用户');
  }, [claimsOpen, loadTimeline, timeline.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const all = useMemo(() => [...(data?.l3 ?? []), ...(data?.l2 ?? [])], [data]);
  const entityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of all) for (const c of m.claims) if (c.entity) set.add(c.entity);
    return [...set].sort();
  }, [all]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((m) => (heat === 'all' ? true : heatOf(m.activation) === heat))
      .filter((m) => (scope === 'all' ? true : m.scope === scope))
      .filter((m) => (entityFilter === 'all' ? true : m.claims.some((c) => c.entity === entityFilter)))
      .filter((m) => (!needle ? true : m.content.toLowerCase().includes(needle) || m.claims.some((c) => `${c.attribute}${c.value}`.toLowerCase().includes(needle))))
      .sort((a, b) => b.activation - a.activation || b.importance - a.importance);
  }, [all, q, heat, scope, entityFilter]);

  const runDream = useCallback(async (): Promise<void> => {
    setDreaming(true);
    setDreamSkipped(false);
    const res = await postAction<{ ok: boolean; ran: boolean; insights: Insights | null }>('dream');
    setDreaming(false);
    if (res?.insights) setInsights(res.insights);
    if (res && !res.ran) setDreamSkipped(true);
  }, []);

  const runSearch = useCallback(async (): Promise<void> => {
    const query = cq.trim();
    if (!query) return;
    const res = await jsonOrNull<{ ok: boolean; hits?: Array<{ id: string; content: string; score: number; category: string }> }>(
      `/aemeath/api/memory?action=search&q=${encodeURIComponent(query)}&k=10`,
    );
    // 代理暂无 search action 时退回本地 BM25 式粗筛（前端只做展示，不改变后端语义）
    if (res?.ok && res.hits) {
      setHits(res.hits);
      return;
    }
    const needle = query.toLowerCase();
    setHits(
      all
        .filter((m) => m.content.toLowerCase().includes(needle))
        .slice(0, 10)
        .map((m) => ({ id: m.id, content: m.content, score: m.activation / 100, category: m.category })),
    );
  }, [cq, all]);

  const body = ((): JSX.Element => {
    if (offline) return <div className="mw-page"><div className="mw-empty">{t('memws.offline')}</div></div>;
    if (loading && !data) return <div className="mw-page"><div className="mw-empty">{t('memws.loading')}</div></div>;

    if (page === 'memory') {
      return (
        <div className="mw-page">
          <div className="mw-page-head">
            <div>
              <div className="mw-page-title">{t('memws.nav.memory')}</div>
              <p className="mw-page-desc">{t('memws.memory.desc')}</p>
            </div>
            <span className="mw-pill" data-tone="muted">{t('memws.browse.count', { n: filtered.length })}</span>
          </div>
          <div className="mw-browser">
            <div className="mw-col mw-col-filters">
              <div className="mw-col-title">{t('memws.search')}</div>
              <div className="mw-search" style={{ marginBottom: 10 }}>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('memws.search.placeholder')} aria-label={t('memws.search.placeholder')} />
              </div>
              <div className="mw-col-title">{t('memws.filter.heat')}</div>
              <select className="mw-field" value={heat} onChange={(e) => setHeat(e.target.value as typeof heat)} aria-label={t('memws.filter.heat')}>
                <option value="all">{t('memws.filter.heat.all')}</option>
                <option value="hot">{t('memws.filter.heat.hot')}</option>
                <option value="warm">{t('memws.filter.heat.warm')}</option>
                <option value="cold">{t('memws.filter.heat.cold')}</option>
              </select>
              <div className="mw-col-title">{t('memws.filter.source')}</div>
              <select className="mw-field" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label={t('memws.filter.source')}>
                <option value="all">{t('memws.filter.source.all')}</option>
                <option value="global">L3 · {t('memws.badge.scope.global')}</option>
                <option value="mode">L2 · {t('memws.badge.scope.mode')}</option>
              </select>
              {entityOptions.length > 0 && (
                <>
                  <div className="mw-col-title">{t('memws.filter.attr')}</div>
                  <select className="mw-field" value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)} aria-label={t('memws.filter.attr')}>
                    <option value="all">{t('memws.filter.attr.all')}</option>
                    {entityOptions.map((e) => (
                      <option key={e} value={e}>{e}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <div className="mw-col mw-col-main">
              <div className="mw-list">
                {filtered.length === 0 && <div className="mw-empty">{t('memws.empty.memories')}</div>}
                {filtered.map((m) => (                  <div className="mw-row" key={m.id}>
                    <div className="mw-row-head">
                      <span className="mw-pill">{t(`memory.category.${m.category}`) === `memory.category.${m.category}` ? m.category : t(`memory.category.${m.category}`)}</span>
                      <span className="mw-pill" data-tone="muted">{m.scope === 'global' ? t('memws.badge.scope.global') : t('memws.badge.scope.mode')}</span>
                      {m.claims.map((c, i) => (
                        <span className="mw-pill" data-tone="muted" key={i}>
                          {c.attribute}={c.value}
                        </span>
                      ))}
                    </div>
                    <div className="mw-row-text">{m.content}</div>
                    <div className="mw-row-meta">
                      <span className="mw-heat" title={`activation=${m.activation}`}>
                        <i style={{ width: `${Math.max(4, Math.min(100, m.activation))}%` }} />
                      </span>
                      <span>{m.activation}</span>
                      <span>· {t('memory.preset.' + m.preset) === 'memory.preset.' + m.preset ? m.preset : t('memory.preset.' + m.preset)}</span>
                      <span>· {fmtTime(m.last_access || m.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
              {/* 实体属性时间轴：默认收起，展开时按属性分组显示区间 */}
              <div className="mw-claims">
                <button type="button" className="mw-claims-toggle" onClick={() => setClaimsOpen((v) => !v)} aria-expanded={claimsOpen}>
                  <span>{t('memws.claims.title')}</span>
                  <span>{claimsOpen ? '▴' : '▾'} {timeline.reduce((n, r) => n + r.claims.length, 0) || ''}</span>
                </button>
                {claimsOpen && (
                  <div className="mw-card mw-claims-body">
                    {timeline.length === 0 && <div className="mw-empty">{t('memws.claims.empty')}</div>}
                    {timeline.map((row) => (
                      <div className="mw-attr-block" key={row.attribute}>
                        <div className="mw-attr-name">{row.attribute}</div>
                        {row.claims.map((c, i) => (
                          <div className="mw-claim-line" key={i}>
                            <span className="mw-claim-value" data-closed={c.valid_until !== null}>
                              {c.value}
                            </span>
                            <span className="mw-pill" data-tone="muted">
                              {c.valid_until === null ? t('memws.claims.current') : t('memws.claims.closed')}
                            </span>
                            <span className="mw-claim-range">
                              {fmtTime(c.valid_from)} → {c.valid_until === null ? t('memws.claims.since') : fmtTime(c.valid_until)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (page === 'graph') {
      return (
        <div className="mw-page">
          <div className="mw-page-head">
            <div>
              <div className="mw-page-title">{t('memws.nav.graph')}</div>
              <p className="mw-page-desc">{t('memws.graph.desc')}</p>
            </div>
            <span className="mw-pill" data-tone="muted">
              {t('memws.graph.summary', { nodes: graph?.nodes.length ?? 0, edges: graph?.edges.length ?? 0 })}
            </span>
          </div>
          <div className="mw-graph-wrap">
            <div className="mw-note">{t('memws.graph.hint')}</div>
            {(graph?.nodes.length ?? 0) > 0 && (graph?.edges.length ?? 0) > 0 ? (
              <EntityGraph
                data={graph as GraphData}
                onPick={(entity) => {
                  setEntityFilter(entity);
                  setPage('memory');
                }}
              />
            ) : (
              // 只有孤立实体（或干脆没有 claim）时画不出图：给明确文案，别留一片空白像坏了
              <div className="mw-empty">{t('memws.graph.empty')}</div>
            )}
          </div>
        </div>
      );
    }

    if (page === 'console') {
      return (
        <div className="mw-page">
          <div className="mw-page-head">
            <div>
              <div className="mw-page-title">{t('memws.nav.console')}</div>
              <p className="mw-page-desc">{t('memws.console.desc')}</p>
            </div>
            {hits && <span className="mw-pill" data-tone="muted">{t('memws.console.meta', { n: hits.length, k: 10 })}</span>}
          </div>
          <div className="mw-console-bar">
            <input className="mw-field" style={{ marginBottom: 0 }} value={cq} onChange={(e) => setCq(e.target.value)} placeholder={t('memws.console.query')} onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} aria-label={t('memws.console.query')} />
            <button type="button" className="mw-btn" onClick={() => void runSearch()}>{t('memws.console.run')}</button>
          </div>
          <div className="mw-scroll">
            {hits === null && <div className="mw-empty">{t('memws.console.query')}</div>}
            {hits?.length === 0 && <div className="mw-empty">{t('memws.console.empty')}</div>}
            {(hits ?? []).map((h) => (
              <div className="mw-row" key={h.id}>
                <div className="mw-row-head">
                  <span className="mw-pill">{t(`memory.category.${h.category}`) === `memory.category.${h.category}` ? h.category : t(`memory.category.${h.category}`)}</span>
                  <span className="mw-score">{t('memws.console.score')} {h.score.toFixed(2)}</span>
                </div>
                <div className="mw-row-text">{h.content}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (page === 'insights') {
      return (
        <div className="mw-page">
          <div className="mw-page-head">
            <div>
              <div className="mw-page-title">{t('memws.nav.insights')}</div>
              <p className="mw-page-desc">{t('memws.insights.desc')}</p>
            </div>
            <button type="button" className="mw-btn" disabled={dreaming} onClick={() => void runDream()}>
              {dreaming ? t('memws.insights.running') : t('memws.insights.dream')}
            </button>
          </div>
          <div className="mw-note">
            {t('memws.insights.meta', { time: insights?.last_run_at ? fmtTime(insights.last_run_at) : t('memws.insights.never') })}
            {dreamSkipped ? ` · ${t('memws.insights.skipped')}` : ''}
          </div>
          <div className="mw-scroll" style={{ marginTop: 10 }}>
            {!insights?.clusters.length && !insights?.conflicts.length && <div className="mw-empty">{t('memws.insights.empty')}</div>}
            {!!insights?.clusters.length && (
              <>
                <h2>{t('memws.insights.clusters')}</h2>
                <div className="mw-card">
                  {insights.clusters.map((c) => (
                    <div className="mw-kv" key={c.id}>
                      <span>{c.label}</span>
                      <span>
                        {t('memws.insights.records', { n: c.recordIds.length })} · {c.recordIds.map((id) => id.slice(0, 8)).join(', ')}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {!!insights?.conflicts.length && (
              <>
                <h2>{t('memws.insights.conflicts')}</h2>
                <div className="mw-card">
                  {insights.conflicts.map((c) => (
                    <div className="mw-kv" key={c.id}>
                      <span>{c.recordIds.map((id) => id.slice(0, 8)).join(' ←→ ')}</span>
                      <span>{c.note}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      );
    }

    // status
    const l1Sessions = data?.l1Buffer?.length ?? 0;
    const l1Turns = (data?.l1Buffer ?? []).reduce((n, s) => n + s.turns.length, 0);
    return (
      <div className="mw-page">
        <div className="mw-page-head">
          <div>
            <div className="mw-page-title">{t('memws.nav.status')}</div>
            <p className="mw-page-desc">{t('memws.status.desc')}</p>
          </div>
        </div>
        <div className="mw-scroll">
          <h2>{t('memws.status.layers')}</h2>
          <div className="mw-card">
            <div className="mw-kv"><span>L3 · {t('memws.badge.scope.global')}</span><span>{data?.stats.byScope?.global ?? 0}</span></div>
            <div className="mw-kv"><span>L2 · {t('memws.badge.scope.mode')}</span><span>{data?.stats.byScope?.mode ?? 0}</span></div>
            <div className="mw-kv"><span>active</span><span>{data?.stats.active ?? 0}</span></div>
            <div className="mw-kv"><span>dormant</span><span>{data?.stats.dormant ?? 0}</span></div>
            <div className="mw-kv"><span>archived</span><span>{data?.stats.archived ?? 0}</span></div>
            <div className="mw-kv"><span>L0 profile</span><span>{data?.profile?.length ?? 0}</span></div>
          </div>
          <h2>{t('memws.status.l1')}</h2>
          <div className="mw-card">
            <div className="mw-kv">
              <span>{t('memws.status.l1')}</span>
              <span>{l1Sessions || l1Turns ? t('memws.status.l1Count', { sessions: l1Sessions, turns: l1Turns }) : t('memws.status.none')}</span>
            </div>
          </div>
        </div>
      </div>
    );
  })();

  return (
    <div className={MEMORY_WORKSPACE_CLASS} role="dialog" aria-modal="true" aria-label={t('memws.title')}>
      <div className="mw-top">
        <div className="mw-title">
          <h1>{t('memws.title')}</h1>
          <span className="mw-sub">{t('memws.subtitle')}</span>
        </div>
        <div className="mw-tabs" role="tablist">
          {PAGES.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={page === p.id} data-active={page === p.id} className="mw-tab" onClick={() => setPage(p.id)}>
              {t(p.key)}
            </button>
          ))}
        </div>
        <div className="mw-actions">
          <span className="mw-note" style={{ marginRight: 4, whiteSpace: 'nowrap' }}>{t('memws.escHint')}</span>
          <button type="button" className="mw-icon-btn" title={t('memws.refresh')} onClick={() => { void refresh(); }} aria-label={t('memws.refresh')}>⟳</button>
          <button type="button" className="mw-icon-btn" title={t('memws.close')} onClick={onClose} aria-label={t('memws.close')}>✕</button>
        </div>
      </div>
      <div className="mw-body">{body}</div>
    </div>
  );
}

/**
 * 工作区容器（供 shell.overlay 挂载）：按 open 状态渲染全屏层 + 注入样式。
 * 用 portal 挂到 body：宿主 overlay 层有自己的堆叠上下文，直接渲染会被列的
 * overflow/transform 裁掉。
 */
export function MemoryWorkspace({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    cleanupRef.current = injectMemoryWorkspaceStyles();
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [open]);
  if (!open) return null;
  return createPortal(<WorkspaceView onClose={onClose} />, document.body);
}

/** 启动器按钮派发的自定义事件名（工作区监听它来开关自己）。 */
export const MEMORY_WORKSPACE_EVENT = 'aemeath:open-memory-workspace';

/**
 * 注册：把一个**自持开关状态**的宿主组件挂到 shell.overlay 加法座位。
 * 宿主不给 overlay 条目任何 props，入口（侧边栏快速设置里的按钮）通过
 * window 自定义事件通知它打开——这样两个座位的组件之间不需要共享状态。
 */
export function registerMemoryWorkspace(ctx: ClientContext): void {
  function Host(): JSX.Element | null {
    const [open, setOpen] = useState(false);
    useEffect(() => {
      const onOpen = (): void => setOpen(true);
      window.addEventListener(MEMORY_WORKSPACE_EVENT, onOpen);
      return () => window.removeEventListener(MEMORY_WORKSPACE_EVENT, onOpen);
    }, []);
    return <MemoryWorkspace open={open} onClose={() => setOpen(false)} />;
  }
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'aemeath-memory-workspace' }, Host as never),
  );
}
