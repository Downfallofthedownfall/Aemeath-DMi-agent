// ============================================================
// 记忆管理面板（M5 F2 v2）——按 L1/L2/L3 分层展示
//   L1 暂存区：会话内工作态（scratch，内存态，随进程存活）
//   L2 角色记忆：scope=mode（角色隔离）
//   L3 共享记忆：scope=global（跨角色共享）
// 数据源：host 端点 /aemeath/api/memory（GET {l1,l2,l3,stats} + POST delete）
// ============================================================
import { useEffect, useState } from 'react';
import { t, useLocale } from './i18n.ts';

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
  l1Buffer?: BufferSession[];
  l1Capacity?: { capacity: number; threshold: number } | null;
}

export interface BufferTurn {
  query: string;
  reply: string;
  kind: string;
  ts: number;
}

export interface BufferSession {
  sessionId: string;
  turns: BufferTurn[];
}

const CATEGORY_KEYS: Record<string, string> = {
  user_fact: 'memory.category.user_fact',
  study_log: 'memory.category.study_log',
  preference: 'memory.category.preference',
  relationship: 'memory.category.relationship',
  session_summary: 'memory.category.session_summary',
};
const PRESET_KEYS: Record<string, string> = {
  aemeath: 'memory.preset.aemeath',
  physicist: 'memory.preset.physicist',
};

function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 按错误码本地化 host 错误文案（映射表见 locales.ts errors.*）。 */
function localizeError(code: string | undefined, fallback: string | undefined, params?: Record<string, unknown>): string {
  if (code) {
    const key = `errors.${code}`;
    const resolved = t(key, params);
    if (resolved !== key) return resolved;
  }
  return fallback ?? String(code ?? '');
}

function importanceColor(imp: number): { bg: string; color: string } {
  if (imp >= 80) return { bg: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent)', color: 'var(--dsw-alias-state-error-primary)' };
  if (imp >= 50) return { bg: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)', color: 'var(--dsw-alias-state-business-primary)' };
  return { bg: 'var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-tertiary)' };
}

/** 一条 L2/L3 记忆行。 */
function MemoryRow({ m, onDelete, deleting }: { m: MemoryItem; onDelete: (id: string) => void; deleting: boolean }): JSX.Element {
  useLocale();
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
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>{CATEGORY_KEYS[m.category] ? t(CATEGORY_KEYS[m.category]) : m.category}</span>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{PRESET_KEYS[m.preset] ? t(PRESET_KEYS[m.preset]) : m.preset}</span>
          <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>{fmtTime(m.created_at)}</span>
          {m.status === 'dormant' ? (
            <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '0 5px' }}>{t('memory.dormant')}</span>
          ) : null}
        </div>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-primary)', marginTop: 4, lineHeight: 1.5 }}>{m.content}</div>
      </div>
      <button
        type="button"
        // C17：传完整 id 而非 8 位前缀（前缀可能碰撞，softDelete 前缀语义会删到多条）
        onClick={() => onDelete(m.id)}
        disabled={deleting}
        title={t('memory.delete.title')}
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
        {deleting ? t('memory.delete.deleting') : t('memory.delete')}
      </button>
    </div>
  );
}

/** 记忆面板主体（hooks 在此）。 */
function MemoryPanelBody(): JSX.Element {
  useLocale(); // locale 切换时刷新面板文案
  const [data, setData] = useState<MemoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/aemeath/api/memory', { signal: AbortSignal.timeout(8000) });
      const d = (await res.json()) as { ok?: boolean; l1?: ScratchEntry[]; l2?: MemoryItem[]; l3?: MemoryItem[]; stats?: MemoryStats; l1Buffer?: BufferSession[]; l1Capacity?: { capacity: number; threshold: number } | null; code?: string; error?: string };
      if (!res.ok || !d.ok) throw new Error(localizeError(d.code, d.error ?? `load failed (${res.status})`));
      setData({ l1: d.l1 ?? [], l2: d.l2 ?? [], l3: d.l3 ?? [], stats: d.stats ?? { active: 0, dormant: 0, byPreset: {}, byScope: {} }, l1Buffer: d.l1Buffer ?? [], l1Capacity: d.l1Capacity ?? null });
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  // 挂载即加载（此前缺失：初始 loading=true 且 data=null → 一直"加载中…"无数据，点刷新才正常）
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时加载一次；load 内部只用稳定 setter
  }, []);

  const remove = async (idPrefix: string): Promise<void> => {
    setDeleting(idPrefix);
    try {
      const res = await fetch('/aemeath/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idPrefix }),
        signal: AbortSignal.timeout(8000),
      });
      const d = (await res.json()) as { ok?: boolean; code?: string; error?: string };
      if (!res.ok || !d.ok) throw new Error(localizeError(d.code, d.error ?? 'delete failed'));
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
  const l1Buffer = data?.l1Buffer ?? [];
  const l1BufferTurns = l1Buffer.reduce((n, s) => n + s.turns.length, 0);
  const bufCap = data?.l1Capacity?.capacity ?? 40;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 统计行 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '2px 10px' }}>
          {t('memory.stats.l1buffer', { n: l1BufferTurns })}
        </span>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '2px 10px' }}>
          {t('memory.stats.l1', { n: l1.length })}
        </span>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '2px 10px' }}>
          {t('memory.stats.l2', { n: l2.length })}
        </span>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, padding: '2px 10px' }}>
          {t('memory.stats.l3', { n: l3.length })}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-state-business-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
        >
          {loading ? t('memory.loading') : t('memory.refresh')}
        </button>
      </div>

      {error ? <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</div> : null}

      {/* —— L1 采集缓冲（滚动对话，待总结） —— */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('memory.section.l1buffer')}
          <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>
            {t('memory.section.l1buffer.hint', { cap: bufCap })}
          </span>
        </div>
        {l1Buffer.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' }}>{t('memory.empty.l1buffer')}</div>
        ) : (
          l1Buffer.map((s) => (
            <div key={s.sessionId} style={{ marginBottom: 6, padding: '8px 10px', borderRadius: 10, background: 'var(--dsw-alias-bg-base)', border: '1px dashed var(--dsw-alias-border-l2)' }}>
              <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 4 }}>{t('memory.session.turns', { id: s.sessionId.slice(0, 8), n: s.turns.length })}</div>
              {s.turns.map((turn, i) => (
                <div key={i} style={{ fontSize: 12, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.5, padding: '2px 0' }}>
                  <span style={{ color: 'var(--dsw-alias-state-business-primary)', fontWeight: 600 }}>{t('memory.q')}</span>：{turn.query}
                  {turn.reply ? (
                    <div style={{ paddingLeft: 22, color: 'var(--dsw-alias-label-secondary)' }}>
                      <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontWeight: 600 }}>{t('memory.a')}</span>：{turn.reply}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* —— L1 暂存区 —— */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('memory.section.l1scratch')}
          <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>{t('memory.section.l1scratch.hint')}</span>
        </div>
        {l1.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' }}>{t('memory.empty.l1scratch')}</div>
        ) : (
          l1.map((s) => (
            <div key={s.sessionId} style={{ marginBottom: 6, padding: '8px 10px', borderRadius: 10, background: 'var(--dsw-alias-bg-base)', border: '1px dashed var(--dsw-alias-border-l2)' }}>
              <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 4 }}>{t('memory.session.turns', { id: s.sessionId.slice(0, 8), n: s.items.length })}</div>
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
          {t('memory.section.l2')}
          <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>{t('memory.section.l2.hint')}</span>
        </div>
        {l2.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' }}>{t('memory.empty.l2')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {l2.map((m) => (
              <MemoryRow key={m.id} m={m} deleting={deleting === m.id} onDelete={(id) => void remove(id)} />
            ))}
          </div>
        )}
      </div>

      {/* —— L3 共享记忆 —— */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('memory.section.l3')}
          <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>{t('memory.section.l3.hint')}</span>
        </div>
        {l3.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' }}>{t('memory.empty.l3')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {l3.map((m) => (
              <MemoryRow key={m.id} m={m} deleting={deleting === m.id} onDelete={(id) => void remove(id)} />
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
        {t('memory.layout.note')}
      </div>
      <MemoryPanelBody />
    </div>
  );
}
