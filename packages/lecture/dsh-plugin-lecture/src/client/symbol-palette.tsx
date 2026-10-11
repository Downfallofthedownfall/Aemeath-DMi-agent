// ============================================================
// client/symbol-palette.tsx — 数学符号面板（**复制到剪贴板**）
//
// 形态（用户两轮定案）：
//   2026-10-11：折叠式，默认收起，点「∑ 符号」才展开；分组可折叠。
//   2026-10-12：**不再插入到某个输入框，而是复制到剪贴板**。
//
// 为什么改成复制：
//   产品设计修正后，记笔记发生在**主界面的对话输入框**里，
//   侧栏不再有自己的输入框（那样会让人困惑"到底在哪记"）。
//   于是"插入到光标处"没有目标了 —— 复制到剪贴板是唯一合理的做法：
//   点符号 → 切回对话输入框 → 粘贴。
//
// 插入逻辑仍然保留在 symbols.ts 的纯函数里（insertSymbol / shiftSlots），
// 已有单测覆盖，将来若宿主开放输入框扩展可以复用。
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { SYMBOL_GROUPS, type MathSymbol } from '../symbols.ts';

/** 最近用过的分组（localStorage；让面板下次打开时落在常用的那组）。 */
const RECENT_KEY = 'aemeath-lecture-symbol-group';

/** 复制到剪贴板：优先用 Clipboard API，失败回退到 execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级 */
  }
  // 降级：临时 textarea + execCommand（老浏览器 / 无权限时）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function SymbolPanel(): JSX.Element {
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    let last = '';
    try {
      last = localStorage.getItem(RECENT_KEY) ?? '';
    } catch {
      /* 隐私模式 */
    }
    return new Set([last || SYMBOL_GROUPS[0]?.id || '']);
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  // 卸载时清掉"已复制"提示的定时器
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

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

  const onClick = async (sym: MathSymbol, groupId: string): Promise<void> => {
    try {
      localStorage.setItem(RECENT_KEY, groupId);
    } catch {
      /* 忽略 */
    }
    const ok = await copyText(sym.insert);
    setCopied(ok ? sym.label : '');
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(''), 1600);
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

      {/* 用法提示 + 复制反馈 */}
      <div className="lec-hint" style={{ margin: '6px 10px 0' }}>
        {copied ? (
          <span style={{ color: 'var(--aem-accent)', fontWeight: 600 }}>已复制 {copied} —— 到对话输入框粘贴</span>
        ) : (
          <>点符号即复制到剪贴板，然后到<b>主界面的对话输入框</b>粘贴</>
        )}
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
                <span style={{ opacity: 0.6 }}>（{g.symbols.length}）</span>
              </div>
              {open ? (
                <div className="lec-symgrid">
                  {g.symbols.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      className="lec-sym"
                      data-structured={s.kind === 'structured' ? '1' : '0'}
                      data-copied={copied === s.label ? '1' : '0'}
                      title={s.hint ? `${s.label} — ${s.hint}\n点击复制：${s.insert}` : `点击复制：${s.insert}`}
                      onClick={() => void onClick(s, g.id)}
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
