// ============================================================
// client/symbol-palette.tsx — 数学符号面板（**整份抄自 lecture**）
//
// 用户定案（2026-10-20）：「目前符号全是 placeholder，你直接去抄 lecture 的全套不就行了」。
// 之前那版是自己拼的网格 + 简单的 `$1` 替换，结果把 lecture 数据里的
// `\placeholder{}`（MathLive 的占位框语法）原样插进了纯文本答案框 —— 一按就是
// `\int_{\placeholder{}}^{\placeholder{}}`，看着就是"全是 placeholder"。
//
// 现在：
//   · 布局/交互/文案**照抄 lecture**：搜索框、分组折叠（记住上次用的组）、
//     点一下闪一下（data-inserted）、复制成功提示（data-copied）
//   · 数据同样来自 lecture 的 SYMBOL_GROUPS（host 经 HTTP 下发，见 index.ts）
//   · 插入：把 MathLive 的 `\placeholder{}` 换成 LaTeX 空组 `{}`，
//     光标落到第一个 `{}` 里（所以 ∫ 上下限 点完直接打上限）
//   · 没有聚焦的答案框时退回"复制到剪贴板"（lecture 的老行为）
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, type SymbolGroupView, type SymbolView } from './api.ts';
import { useT, useLocale } from './i18n.ts';
import { symbolInsertion } from '../symbol-insert.ts';

/** 最近用过的分组（localStorage；让面板下次打开落在常用的那组）。 */
const RECENT_KEY = 'aemeath-exercise-symbol-group';


/** 复制到剪贴板：优先 Clipboard API，失败回退 execCommand（同 lecture）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级 */
  }
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

export interface SymbolPanelProps {
  /** 插到聚焦答案框的光标处；返回 false 表示没有活动编辑器（退回复制） */
  onInsert: (text: string, caretOffset: number) => boolean;
  onToast?: (msg: string) => void;
}

export function SymbolPanel({ onInsert, onToast }: SymbolPanelProps): JSX.Element {
  const t = useT();
  const locale = useLocale();
  /** 显示用标签/提示：英文界面优先用 host 附带的英文，缺失回退中文原值。 */
  const groupLabel = (g: SymbolGroupView): string => (locale === 'en' ? g.labelEn ?? g.label : g.label);
  const symLabel = (s: SymbolView): string => (locale === 'en' ? s.labelEn ?? s.label : s.label);
  const symHint = (s: SymbolView): string => (locale === 'en' ? s.hintEn ?? s.hint ?? '' : s.hint ?? '');
  const [groups, setGroups] = useState<SymbolGroupView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState('');
  const [inserted, setInserted] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    let last = '';
    try {
      last = localStorage.getItem(RECENT_KEY) ?? '';
    } catch {
      /* 隐私模式 */
    }
    return new Set(last ? [last] : []);
  });
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    apiGet<{ groups: SymbolGroupView[] }>('symbols')
      .then((r) => {
        if (!alive) return;
        const list = r.groups ?? [];
        setGroups(list);
        // 没记住上次的组 → 默认展开第一组
        setOpenGroups((prev) => (prev.size ? prev : new Set([list[0]?.id ?? ''])));
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        setGroups([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const searching = query.trim().length > 0;
  const filtered = useMemo(() => {
    const list = groups ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list
      .map((g) => ({
        ...g,
        symbols: g.symbols.filter(
          (s) =>
            s.label.toLowerCase().includes(q) ||
            s.insert.toLowerCase().includes(q) ||
            (s.hint ?? '').toLowerCase().includes(q) ||
            (s.labelEn ?? '').toLowerCase().includes(q) ||
            (s.hintEn ?? '').toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.symbols.length > 0);
  }, [groups, query]);

  const onClick = async (sym: SymbolView, groupId: string): Promise<void> => {
    try {
      localStorage.setItem(RECENT_KEY, groupId);
    } catch {
      /* 忽略 */
    }
    const { text, caret } = symbolInsertion(sym);

    // ① 插到聚焦答案框的光标处（没有就退回复制）
    let didInsert = false;
    try {
      didInsert = onInsert(text, caret);
    } catch {
      didInsert = false;
    }
    if (didInsert) setInserted(symLabel(sym));

    // ② 复制（lecture 的老行为保留：想粘到别处也能用）
    const ok = await copyText(text);
    setCopied(ok ? symLabel(sym) : '');

    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied('');
      setInserted('');
    }, 1600);

    if (!didInsert && !ok) onToast?.(t('exercise.symbol.noTarget'));
  };

  const toggleGroup = (id: string): void => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (groups === null) return <div className="lec-hint">{t('exercise.symbol.loading')}</div>;
  if (error) {
    return (
      <div>
        <div className="lec-warn">{t('exercise.symbol.unavailable', { error })}</div>
        <div className="lec-hint">{t('exercise.symbol.unavailableHint')}</div>
      </div>
    );
  }
  if (!groups.length) return <div className="lec-empty">{t('exercise.symbol.empty')}</div>;

  return (
    <div className="lec-sympanel">
      <div className="lec-sympanel-head">
        <input
          className="lec-input"
          style={{ padding: '5px 9px', fontSize: 12 }}
          placeholder={t('exercise.symbol.search')}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        {query ? (
          <button type="button" className="lec-icon-btn" title={t('exercise.symbol.clear')} onClick={() => setQuery('')}>
            ✕
          </button>
        ) : null}
      </div>

      <div className="lec-hint" style={{ margin: '6px 10px 0' }}>
        {copied ? (
          <span style={{ color: 'var(--aem-accent)', fontWeight: 600 }}>{t('exercise.symbol.copied', { label: copied })}</span>
        ) : (
          <>
            {t('exercise.symbol.insertLead')}
            <b>{t('exercise.symbol.insertStrong')}</b>
            {t('exercise.symbol.insertTail')}
          </>
        )}
      </div>

      <div className="lec-sympanel-body">
        {filtered.length === 0 ? <div className="lec-hint">{t('exercise.symbol.noMatch')}</div> : null}
        {filtered.map((g) => {
          const open = searching || openGroups.has(g.id);
          return (
            <div key={g.id} className="lec-symgroup">
              <div className="lec-symgroup-name" onClick={() => toggleGroup(g.id)} title={t('exercise.symbol.toggle')}>
                <span>{open ? '▾' : '▸'}</span>
                {groupLabel(g)}
                <span style={{ opacity: 0.6 }}>{t('exercise.symbol.count', { n: g.symbols.length })}</span>
              </div>
              {open ? (
                <div className="lec-symgrid">
                  {g.symbols.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      className="lec-sym"
                      data-structured={s.kind === 'structured' ? '1' : '0'}
                      data-copied={copied === symLabel(s) ? '1' : '0'}
                      data-inserted={inserted === symLabel(s) ? '1' : '0'}
                      title={
                        s.hint
                          ? t('exercise.symbol.tip', { label: symLabel(s), hint: symHint(s) })
                          : t('exercise.symbol.tipNoHint', { label: symLabel(s) })
                      }
                      // 不抢焦点：否则插不到光标处
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void onClick(s, g.id)}
                    >
                      {symLabel(s)}
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
