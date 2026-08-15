// ============================================================
// 记忆管理面板（M5 F2 v2）——按 L1/L2/L3 分层展示
//   L1 暂存区：会话内工作态（scratch，内存态，随进程存活）
//   L2 角色记忆：scope=mode（角色隔离）
//   L3 共享记忆：scope=global（跨角色共享）
// 数据源：host 端点 /aemeath/api/memory（GET {l1,l2,l3,stats} + POST delete）
// ============================================================
import { useState } from 'react';

export interface MemoryItem {
  id: string;
  content: string;
  category: string;
  importance: number;
  scope: string;
  preset: string;
  status: string;
  created_at: number;
}

export interface ScratchEntry {
  sessionId: string;
  items: Array<{ key: string; content: string }>;
}

export interface MemoryStats {
  active: number;
  dormant: number;
  byPreset: Record<string, number>;
  byScope: Record<string, number>;
}

export interface MemoryData {
  l1: ScratchEntry[];
  l2: MemoryItem[];
  l3: MemoryItem[];
  stats: MemoryStats;
}

const CATEGORY_LABELS: Record<string, string> = {
  user_fact: '用户事实',
  study_log: '学习记录',
  preference: '偏好',
  relationship: '关系',
  session_summary: '会话摘要',
};
const PRESET_LABELS: Record<string, string> = {
  aemeath: '小爱同学',
  physicist: '爱弥斯-拉贝尔学部学霸',
};

function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function importanceColor(imp: number): { bg: string; color: string } {
  if (imp >= 80) return { bg: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent)', color: 'var(--dsw-alias-state-error-primary)' };
  if (imp >= 50) return { bg: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)', color: 'var(--dsw-alias-state-business-primary)' };
  return { bg: 'var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-tertiary)' };
}

/** 一条 L2/L3 记忆行。 */
function MemoryRow({ m, onDelete, deleting }: { m: MemoryItem; onDelete: (id: string) => void; deleting: boolean }): JSX.Element {
  const imp = importanceColor(m.importance);
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '8px 10px',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, padding: '0 6px', borderRadius: 999, fontWeight: 700, background: imp.bg, color: imp.color }}>
            {m.importance}
          </span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>{CATEGORY_LABELS[m.category] ?? m.category}</span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{PRESET_LABELS[m.preset] ?? m.preset}</span>
          <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>{fmtTime(m.created_at)}</span>
          {m.status === 'dormant' ? (
            <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '0 5px' }}>沉睡</span>
          ) : null}
        </div>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-primary)', marginTop: 4, lineHeight: 1.5 }}>{m.content}</div>
      </div>
      <button
        type="button"
        onClick={() => onDelete(m.id.slice(0, 8))}
        disabled={deleting}
        title="删除这条记忆（软删，可审计）"
        style={{
          flex: 'none',
          fontSize: 11,
          color: 'var(--dsw-alias-state-error-primary)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 4px',
          opacity: deleting ? 0.5 : 1,
        }}
      >
        {deleting ? '删除中…' : '删除'}
      </button>
    </div>
  );
}

/** 记忆面板主体（hooks 在此）。 */
function MemoryPanelBody(): JSX.Element {
  const [data, setData] = useState<MemoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/aemeath/api/memory', { signal: AbortSignal.timeout(8000) });
      const d = (await res.json()) as { ok?: boolean; l1?: ScratchEntry[]; l2?: MemoryItem[]; l3?: MemoryItem[]; stats?: MemoryStats; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? `load failed (${res.status})`);
      setData({ l1: d.l1 ?? [], l2: d.l2 ?? [], l3: d.l3 ?? [], stats: d.stats ?? { active: 0, dormant: 0, byPreset: {}, byScope: {} } });
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  const remove = async (idPrefix: string): Promise<void> => {
    setDeleting(idPrefix);
    try {
      const res = await fetch('/aemeath/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idPrefix }),
        signal: AbortSignal.timeout(8000),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? 'delete failed');
      await load();
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setDeleting(null);
    }
  };

  const sortByImp = (list: MemoryItem[]): MemoryItem[] =>
    [...list].sort((a, b) => b.importance - a.importance || (b.created_at ?? 0) - (a.created_at ?? 0));
  const l2 = data ? sortByImp(data.l2) : [];
  const l3 = data ? sortByImp(data.l3) : [];
  const l1 = data?.l1 ?? [];
  const stats = data?.stats;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 统计行 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '2px 10px' }}>
          L1 暂存 {l1.length} 会话
        </span>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '2px 10px' }}>
          L2 角色 {l2.length}
        </span>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '2px 10px' }}>
          L3 共享 {l3.length}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-state-business-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
        >
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      {error ? <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</div> : null}

      {/* —— L1 暂存区 —— */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          L1 · 暂存区
          <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>会话内工作态（内存，随进程存活）</span>
        </div>
        {l1.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' }}>暂无暂存数据。</div>
        ) : (
          l1.map((s) => (
            <div key={s.sessionId} style={{ marginBottom: 6, padding: '8px 10px', borderRadius: 10, background: 'var(--dsw-alias-bg-base)', border: '1px dashed var(--dsw-alias-border-l2)' }}>
              <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 4 }}>会话 {s.sessionId.slice(0, 8)}</div>
              {s.items.map((it) => (
                <div key={it.key} style={{ fontSize: 12, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.5, padding: '2px 0' }}>
                  <span style={{ color: 'var(--dsw-alias-state-business-primary)', fontWeight: 600 }}>{it.key}</span>：{it.content}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* —— L2 角色记忆 —— */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          L2 · 角色记忆
          <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>scope=mode（角色隔离）</span>
        </div>
        {l2.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' }}>暂无角色记忆。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {l2.map((m) => (
              <MemoryRow key={m.id} m={m} deleting={deleting === m.id.slice(0, 8)} onDelete={(id) => void remove(id)} />
            ))}
          </div>
        )}
      </div>

      {/* —— L3 共享记忆 —— */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          L3 · 共享记忆
          <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>scope=global（跨角色共享）</span>
        </div>
        {l3.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' }}>暂无共享记忆。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {l3.map((m) => (
              <MemoryRow key={m.id} m={m} deleting={deleting === m.id.slice(0, 8)} onDelete={(id) => void remove(id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 记忆面板外层（零 hooks，适配设置页注入模式）。 */
export function MemoryPanel(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
        分层：L1 会话暂存 · L2 角色记忆 · L3 共享记忆。删除为软删（审计留痕）。
      </div>
      <MemoryPanelBody />
    </div>
  );
}
