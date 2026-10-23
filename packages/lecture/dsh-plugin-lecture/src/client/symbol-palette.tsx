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
import { useLocale, useT } from './i18n.ts';
import { SYMBOL_HINT_EN, SYMBOL_LABEL_EN } from '../symbol-en.ts';

/** 最近用过的分组（localStorage；让面板下次打开时落在常用的那组）。 */
const RECENT_KEY = 'aemeath-lecture-symbol-group';

/**
 * 从界面标签里取出**纯文字版**（文字模式插入用）。
 *
 * 符号数据的 `label` 是给人看的，常带中文说明：
 *   `'∫ 上下限'` → `'∫'`
 *   `'Δx 增量'`  → `'Δx'`
 *   `'δ 变分'`   → `'δ'`
 * 但有些标签本身就是完整符号、没有描述：
 *   `'lim sup'`  → `'lim sup'`（原样保留 —— 它有空格但字字是符号）
 *   `'∂²/∂x²'`   → 原样
 *
 * 判据：**中文/全角字符出现的位置**就是描述开始处。
 * 没有中文 → 整条都是符号本体。
 */
function plainOf(label: string): string {
  // 汉字、中文标点、全角字符
  const cut = label.search(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/);
  if (cut <= 0) return label.trim();
  const head = label.slice(0, cut).trim();
  // 切出来啥也不剩，或只剩括号之类（如 `[待验证]` → `[`）→ 用原标签。
  // 宁可插一条完整的标记，也不要插一个孤零零的 `[`。
  if (!head || /^[\s\[\](){}<>«»]+$/.test(head)) return label.trim();
  return head;
}

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

/**
 * @param onInsert 点到符号时，把它插到中栏输入框的光标处。
 *                 不传则退化为"只复制"（独立窗口以外没有输入框的场景）。
 */
export function SymbolPanel({ onInsert }: { onInsert?: (latex: string, plainFallback?: string) => void } = {}): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState('');
  /** 刚插入的符号（用于按钮上闪一下提示）。 */
  const [inserted, setInserted] = useState('');
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
  /** 显示用标签（英文界面优先用 overlay，缺失回退中文原标签）。 */
  const labelOf = (s: MathSymbol): string => (locale === 'en' ? SYMBOL_LABEL_EN[s.label] ?? s.label : s.label);
  const hintOf = (s: MathSymbol): string =>
    locale === 'en' ? SYMBOL_HINT_EN[s.hint ?? ''] ?? s.hint ?? '' : s.hint ?? '';
  const groupLabelOf = (label: string): string => (locale === 'en' ? SYMBOL_LABEL_EN[label] ?? label : label);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SYMBOL_GROUPS;
    return SYMBOL_GROUPS.map((g) => ({
      ...g,
      symbols: g.symbols.filter((s) => {
        const enLabel = (SYMBOL_LABEL_EN[s.label] ?? '').toLowerCase();
        const enHint = (SYMBOL_HINT_EN[s.hint ?? ''] ?? '').toLowerCase();
        return (
          s.label.toLowerCase().includes(q) ||
          s.insert.toLowerCase().includes(q) ||
          (s.hint ?? '').toLowerCase().includes(q) ||
          enLabel.includes(q) ||
          enHint.includes(q)
        );
      }),
    })).filter((g) => g.symbols.length > 0);
  }, [query]);

  const onClick = async (sym: MathSymbol, groupId: string): Promise<void> => {
    try {
      localStorage.setItem(RECENT_KEY, groupId);
    } catch {
      /* 忽略 */
    }

    // ⚠️ 点一下**同时**做两件事（真机反馈："符号键盘可以做点击就直接输入输入框，
    //    不过复制也保留挺好用的"）：
    //      ① 插到中栏输入框的光标处 —— 上课时不用来回切
    //      ② 复制到剪贴板 —— 想粘到别的地方（或别的程序）时直接 Ctrl+V
    //    两件事互不冲突，所以不做成"二选一"。
    //
    //    插入失败（比如输入框还没渲染）不影响复制 —— 各自独立降级。
    if (onInsert) {
      try {
        // 第二个参数是**纯文字模式**下插入的内容。
        // ⚠️ 不能用 sym.label —— 那是界面标签，带中文描述
        //    （`∫ 上下限`、`Δx 增量`）。把整条插进笔记会把描述文字也写进去。
        onInsert(sym.insert, plainOf(sym.label));
        setInserted(sym.label);
      } catch {
        /* 插入失败就只复制，不打扰用户 */
      }
    }

    const ok = await copyText(sym.insert);
    setCopied(ok ? sym.label : '');

    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied('');
      setInserted('');
    }, 1600);
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
          placeholder={t('lecture.symbol.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button type="button" className="lec-icon-btn" title={t('common.clear')} onClick={() => setQuery('')}>
            ✕
          </button>
        ) : null}
      </div>

      {/* 用法提示 + 复制反馈 */}
      <div className="lec-hint" style={{ margin: '6px 10px 0' }}>
        {copied ? (
          <span style={{ color: 'var(--aem-accent)', fontWeight: 600 }}>{t('lecture.symbol.copied', { label: locale === 'en' ? SYMBOL_LABEL_EN[copied] ?? copied : copied })}</span>
        ) : (
          <>{t('lecture.symbol.insertLead')}<b>{t('lecture.symbol.insertStrong')}</b>{t('lecture.symbol.insertTail')}</>
        )}
      </div>

      <div className="lec-sympanel-body">
        {groups.length === 0 ? <div className="lec-hint">{t('lecture.symbol.noMatch')}</div> : null}
        {groups.map((g) => {
          const open = searching || openGroups.has(g.id);
          return (
            <div key={g.id} className="lec-symgroup">
              <div className="lec-symgroup-name" onClick={() => toggleGroup(g.id)} title={t('lecture.symbol.toggle')}>
                <span>{open ? '▾' : '▸'}</span>
                {groupLabelOf(g.label)}
                <span style={{ opacity: 0.6 }}>{t('lecture.symbol.count', { n: g.symbols.length })}</span>
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
                      data-inserted={inserted === s.label ? '1' : '0'}
                      title={
                        s.hint
                          ? t('lecture.symbol.tip', { label: labelOf(s), hint: hintOf(s), insert: s.insert })
                          : t('lecture.symbol.tipNoHint', { insert: s.insert })
                      }
                      onClick={() => void onClick(s, g.id)}
                    >
                      {labelOf(s)}
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
