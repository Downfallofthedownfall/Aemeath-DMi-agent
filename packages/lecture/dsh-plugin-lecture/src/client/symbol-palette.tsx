// ============================================================
// client/symbol-palette.tsx — 数学符号面板（**折叠式**）
//
// 形态（用户定案 2026-10-11）：默认收起，点输入框旁的「∑ 符号」才展开。
// 展开后：
//   · 顶部搜索框（符号多，搜索比翻分组快）
//   · 分组可折叠（默认只展开上一次用过的那组，避免一次铺 250 个）
//
// 光标逻辑全部复用已在 check5.mjs 测过的纯函数
// （insertSymbol / shiftSlots）——本文件只负责 DOM 与 React 状态。
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { SYMBOL_GROUPS, type MathSymbol, insertSymbol, shiftSlots } from '../symbols.ts';

/** 记住最后聚焦的可编辑元素（点面板按钮时它已失焦）。 */
let lastEditable: HTMLTextAreaElement | HTMLInputElement | null = null;

function installFocusTracker(): () => void {
  const onFocus = (e: FocusEvent): void => {
    const el = e.target as HTMLElement | null;
    if (!el) return;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      lastEditable = el;
    }
  };
  document.addEventListener('focusin', onFocus);
  return () => document.removeEventListener('focusin', onFocus);
}

/** 插入后要跳转的插槽（供 Tab 键使用）。 */
interface PendingSlots {
  el: HTMLTextAreaElement | HTMLInputElement;
  slots: number[];
  active: number;
}

let pending: PendingSlots | null = null;

/**
 * Tab 键处理：若上一次插入留下了未走完的插槽，跳到下一个；
 * 否则返回 false（放行默认行为）。
 */
function handleTab(shift: boolean): boolean {
  if (!pending || !pending.slots.length) return false;
  const el = pending.el;
  const typedAt = el.selectionStart ?? 0;
  const remaining = shift
    ? pending.slots.slice(0, Math.max(0, pending.active - 1))
    : pending.slots.slice(pending.active);
  if (!remaining.length) {
    pending = null;
    return false;
  }
  const target = shift ? remaining[remaining.length - 1]! : remaining[0]!;
  const pos = Math.max(target, typedAt);
  el.setSelectionRange(pos, pos);
  pending.active += shift ? -1 : 1;
  if (!shift) pending.slots = shiftSlots(pending.slots, typedAt, 0);
  return true;
}

/** 最近用过的分组（localStorage；让面板下次打开时落在常用的那组）。 */
const RECENT_KEY = 'aemeath-lecture-symbol-group';

export function SymbolPanel(): JSX.Element {
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    // 默认只展开一个分组（上次用过的，否则第一个），避免一次铺开 250 个
    let last = '';
    try {
      last = localStorage.getItem(RECENT_KEY) ?? '';
    } catch {
      /* 隐私模式/localStorage 不可用 */
    }
    return new Set([last || SYMBOL_GROUPS[0]?.id || '']);
  });
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => installFocusTracker(), []);

  // Tab 键：捕获阶段拦截（textarea 内 Tab 默认会失焦）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const el = document.activeElement;
      if (!(el instanceof HTMLTextAreaElement)) return;
      if (handleTab(e.shiftKey)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // 搜索时忽略分组折叠状态（直接给全部命中）
  const searching = query.trim().length > 0;
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SYMBOL_GROUPS;
    return SYMBOL_GROUPS.map((g) => ({
      ...g,
      symbols: g.symbols.filter(
        (s) =>
          s.label.toLowerCase().includes(q) ||
          s.insert.toLowerCase().includes(q) ||
          (s.hint ?? '').toLowerCase().includes(q),
      ),
    })).filter((g) => g.symbols.length > 0);
  }, [query]);

  const onClick = (sym: MathSymbol, groupId: string): void => {
    try {
      localStorage.setItem(RECENT_KEY, groupId);
    } catch {
      /* 忽略 */
    }
    const el = lastEditable;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const r = insertSymbol(el.value, start, end, sym, { autoSpace: true });
    el.value = r.text;
    el.setSelectionRange(r.caret, r.caret);
    el.focus();
    pending = r.slots.length ? { el, slots: [...r.slots], active: r.activeSlot } : null;
  };

  const toggleGroup = (id: string): void => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="lec-sympanel" ref={rootRef}>
      <div className="lec-sympanel-head">
        <input
          className="lec-input"
          style={{ padding: '5px 9px', fontSize: 12 }}
          placeholder="搜索符号（积分 / sum / 矢量 …）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button type="button" className="lec-icon-btn" title="清空" onClick={() => setQuery('')}>
            ✕
          </button>
        ) : null}
      </div>
      <div className="lec-sympanel-body">
        {groups.length === 0 ? <div className="lec-hint">没有匹配的符号。</div> : null}
        {groups.map((g) => {
          const open = searching || openGroups.has(g.id);
          return (
            <div key={g.id} className="lec-symgroup">
              <div className="lec-symgroup-name" onClick={() => toggleGroup(g.id)} title="点击展开 / 收起">
                <span>{open ? '▾' : '▸'}</span>
                {g.label}
                <span style={{ opacity: 0.6 }}>
                  （{g.symbols.length}
                  {g.symbols.some((s) => s.kind === 'structured') ? ' · 含插槽' : ''}）
                </span>
              </div>
              {open ? (
                <div className="lec-symgrid">
                  {g.symbols.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      className="lec-sym"
                      data-structured={s.kind === 'structured' ? '1' : '0'}
                      title={s.hint ?? s.label}
                      onClick={() => onClick(s, g.id)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
