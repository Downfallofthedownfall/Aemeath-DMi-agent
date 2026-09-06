// ============================================================
// 记忆管理面板（M5 F2 v2）——按 L1/L2/L3 分层展示
//   L1 暂存区：会话内工作态（scratch，内存态，随进程存活）
//   L2 角色记忆：scope=mode（角色隔离）
//   L3 共享记忆：scope=global（跨角色共享）
// 数据源：host 端点 /aemeath/api/memory（GET {l1,l2,l3,stats} + POST delete）
//         新增：POST { action:'toWorldbook', id } —— 把一条 L2/L3 记忆写入世界书（纯手动）
// 增强（L2/L3 → 世界书，纯手动）：
//   1. 每条 L2/L3 记忆行加「加入世界书」按钮（手动确认 → 生成条目，热重载生效）。
//   2. 新条目检测：localStorage 记录已见 id + 首次基线；每次面板加载对比出新 L2/L3 记忆，
//      弹确认框问是否加入世界书（每次出现新条目才弹，符合"纯手动 + 弹出确认"）。
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

// —— 世界书桥接的本地状态（纯手动确认）：已见 id / 首次基线 / 是否自动弹确认 ——
const WB_SEEN_KEY = 'aemeath.wb.seen';
const WB_INIT_KEY = 'aemeath.wb.init';
const WB_SUGGEST_KEY = 'aemeath.wb.suggest';

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(WB_SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeSeen(set: Set<string>): void {
  try {
    localStorage.setItem(WB_SEEN_KEY, JSON.stringify([...set]));
  } catch {
    /* localStorage 不可用：忽略（提示位仅内存） */
  }
}

function readSuggest(): boolean {
  try {
    return localStorage.getItem(WB_SUGGEST_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeSuggest(v: boolean): void {
  try {
    localStorage.setItem(WB_SUGGEST_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

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

/** 调用 host 端点把一条记忆写入世界书（纯手动）。 */
async function apiToWorldbook(id: string, opts?: { library?: string; topic?: string }): Promise<{ id?: string; title?: string }> {
  const res = await fetch('/aemeath/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'toWorldbook', id, ...(opts ?? {}) }),
    signal: AbortSignal.timeout(8000),
  });
  const d = (await res.json()) as { ok?: boolean; id?: string; title?: string; code?: string; error?: string };
  if (!res.ok || !d.ok) throw new Error(localizeError(d.code, d.error ?? `add to worldbook failed (${res.status})`));
  return { id: d.id, title: d.title };
}

/** 一条 L2/L3 记忆行（含「加入世界书」+「删除」）。 */
function MemoryRow({ m, onDelete, deleting, onToWorldbook, wbBusy, wbMsg }: { m: MemoryItem; onDelete: (id: string) => void; deleting: boolean; onToWorldbook: (id: string) => void; wbBusy: boolean; wbMsg?: string }): JSX.Element {
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
        {wbMsg ? <div style={{ fontSize: 11, color: wbBusy ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-business-primary)', marginTop: 4 }}>{wbMsg}</div> : null}
      </div>
      <button
        type="button"
        onClick={() => onToWorldbook(m.id)}
        disabled={wbBusy}
        title={wbBusy ? t('memory.wb.adding.title') : t('memory.wb.add.title')}
        style={{
          flex: 'none',
          fontSize: 11,
          color: 'var(--dsw-alias-state-business-primary)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 4px',
          opacity: wbBusy ? 0.5 : 1,
        }}
      >
        {wbBusy ? t('memory.wb.adding') : t('memory.wb.add')}
      </button>
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

/** 新记忆确认弹窗：一次提示一条（每次出现新条目 → 弹确认），确认/暂不后推进到下一条。 */
function WorldbookConfirmModal({ pending, busy, onConfirm, onDismiss }: { pending: MemoryItem[]; busy: string | null; onConfirm: (m: MemoryItem) => void; onDismiss: (m: MemoryItem) => void }): JSX.Element | null {
  useLocale();
  const current = pending[0];
  if (!current) return null;
  const imp = importanceColor(current.importance);
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          width: 'min(560px, 100%)',
          maxHeight: '80vh',
          overflow: 'auto',
          background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 12,
          padding: 18,
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', marginBottom: 4 }}>{t('memory.wb.modal.title')}</div>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 }}>{t('memory.wb.modal.desc')}</div>

        {/* 待确认的新记忆内容卡片 */}
        <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, padding: '0 6px', borderRadius: 999, fontWeight: 700, background: imp.bg, color: imp.color }}>{current.importance}</span>
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>{CATEGORY_KEYS[current.category] ? t(CATEGORY_KEYS[current.category]) : current.category}</span>
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{PRESET_KEYS[current.preset] ? t(PRESET_KEYS[current.preset]) : current.preset}</span>
            <span style={{ fontSize: 10, padding: '0 6px', borderRadius: 999, background: 'var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)' }}>
              {current.scope === 'global' ? 'L3' : 'L2'}
            </span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)', marginTop: 6, lineHeight: 1.5 }}>{current.content}</div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <button
            type="button"
            onClick={() => onConfirm(current)}
            disabled={busy === current.id}
            style={{
              height: 30,
              padding: '0 14px',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              background: 'var(--dsw-alias-state-business-primary)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              opacity: busy === current.id ? 0.6 : 1,
            }}
          >
            {busy === current.id ? t('memory.wb.adding') : t('memory.wb.modal.confirm')}
          </button>
          <button
            type="button"
            onClick={() => onDismiss(current)}
            disabled={busy === current.id}
            style={{
              height: 30,
              padding: '0 12px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('memory.wb.modal.dismiss')}
          </button>
          {pending.length > 1 ? (
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
              {t('memory.wb.modal.remaining', { n: pending.length - 1 })}
            </span>
          ) : null}
        </div>
      </div>
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

  // —— 世界书桥接状态 ——
  const [wbBusy, setWbBusy] = useState<string | null>(null);
  const [wbMsg, setWbMsg] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<MemoryItem[]>([]);
  const [suggestOn, setSuggestOn] = useState<boolean>(() => readSuggest());

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/aemeath/api/memory', { signal: AbortSignal.timeout(8000) });
      const d = (await res.json()) as { ok?: boolean; l1?: ScratchEntry[]; l2?: MemoryItem[]; l3?: MemoryItem[]; stats?: MemoryStats; l1Buffer?: BufferSession[]; l1Capacity?: { capacity: number; threshold: number } | null; code?: string; error?: string };
      if (!res.ok || !d.ok) throw new Error(localizeError(d.code, d.error ?? `load failed (${res.status})`));
      setData({ l1: d.l1 ?? [], l2: d.l2 ?? [], l3: d.l3 ?? [], stats: d.stats ?? { active: 0, dormant: 0, byPreset: {}, byScope: {} }, l1Buffer: d.l1Buffer ?? [], l1Capacity: d.l1Capacity ?? null });
      // 新条目检测：首次运行建立基线（不弹，避免历史记忆洪水）；其后对比已见 id
      const l2l3 = [...(d.l2 ?? []), ...(d.l3 ?? [])];
      if (!localStorage.getItem(WB_INIT_KEY)) {
        writeSeen(new Set(l2l3.map((m) => m.id)));
        localStorage.setItem(WB_INIT_KEY, '1');
        setPending([]);
      } else if (readSuggest()) {
        const seen = readSeen();
        setPending(l2l3.filter((m) => !seen.has(m.id)));
      } else {
        setPending([]);
      }
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

  /** 标记某记忆为"已处理"（加入或跳过），不再在后续加载中弹出。 */
  const markSeen = (id: string): void => {
    const seen = readSeen();
    seen.add(id);
    writeSeen(seen);
  };

  /** 手动点「加入世界书」：写入 + 标记已见（同一记忆不再弹）。 */
  const manualToWorldbook = async (id: string): Promise<void> => {
    setWbBusy(id);
    try {
      await apiToWorldbook(id);
      setWbMsg((prev) => ({ ...prev, [id]: t('memory.wb.added') }));
      markSeen(id);
      setPending((prev) => prev.filter((x) => x.id !== id));
    } catch (e) {
      setWbMsg((prev) => ({ ...prev, [id]: t('memory.wb.addFailed', { message: (e as Error).message ?? String(e) }) }));
    } finally {
      setWbBusy(null);
    }
  };

  /** 弹窗确认：加入 + 标记已见 + 推进队列。写失败也从队列移除（下次加载重弹），不标记已见。 */
  const modalConfirm = async (m: MemoryItem): Promise<void> => {
    setWbBusy(m.id);
    try {
      await apiToWorldbook(m.id);
      setWbMsg((prev) => ({ ...prev, [m.id]: t('memory.wb.added') }));
      markSeen(m.id);
    } catch (e) {
      setWbMsg((prev) => ({ ...prev, [m.id]: t('memory.wb.addFailed', { message: (e as Error).message ?? String(e) }) }));
    } finally {
      setWbBusy(null);
      setPending((prev) => prev.filter((x) => x.id !== m.id));
    }
  };

  /** 弹窗暂不：标记已见（下次不弹），推进队列。 */
  const modalDismiss = (m: MemoryItem): void => {
    markSeen(m.id);
    setPending((prev) => prev.filter((x) => x.id !== m.id));
  };

  /** 切换"自动弹确认"开关：关闭立即关闭弹窗；打开按当前数据重算 pending。 */
  const toggleSuggest = (v: boolean): void => {
    setSuggestOn(v);
    writeSuggest(v);
    if (!v) {
      setPending([]);
      return;
    }
    const l2l3 = [...(data?.l2 ?? []), ...(data?.l3 ?? [])];
    const seen = readSeen();
    setPending(l2l3.filter((m) => !seen.has(m.id)));
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

      {/* 新记忆自动弹确认开关 */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' }}>
        <input type="checkbox" checked={suggestOn} onChange={(e) => toggleSuggest(e.target.checked)} />
        {t('memory.wb.modal.toggle')}
      </label>

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
              <MemoryRow key={m.id} m={m} deleting={deleting === m.id} onDelete={(id) => void remove(id)} onToWorldbook={(id) => void manualToWorldbook(id)} wbBusy={wbBusy === m.id} wbMsg={wbMsg[m.id]} />
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
              <MemoryRow key={m.id} m={m} deleting={deleting === m.id} onDelete={(id) => void remove(id)} onToWorldbook={(id) => void manualToWorldbook(id)} wbBusy={wbBusy === m.id} wbMsg={wbMsg[m.id]} />
            ))}
          </div>
        )}
      </div>

      {/* 新记忆确认弹窗（每次出现新条目 → 弹确认） */}
      <WorldbookConfirmModal pending={pending} busy={wbBusy} onConfirm={(m) => void modalConfirm(m)} onDismiss={modalDismiss} />
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
