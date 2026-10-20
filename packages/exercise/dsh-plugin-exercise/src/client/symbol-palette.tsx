// ============================================================
// client/symbol-palette.tsx — 数学符号面板
//
// 数据来源：host 的 `/aemeath/api/exercise?action=symbols`，
// 它**借的是 lecture 的符号表**（250+ 项、十几个分组、带插槽模板）。
// 为什么不在前端直接 import lecture 的包：
//   · client bundle 是 `__ModuleLoader__` 单文件格式，跨插件 import 会变成运行时依赖；
//   · 走 HTTP 则 lecture 没装时也能优雅退化成空表（独立 profile 场景）。
//
// 形态（借 lecture 的两轮定案）：
//   · 折叠式分组，默认展开常用组；
//   · **点一下 = 插入到答案光标处**（本界面的答案编辑器是我们自己的，有真实光标）；
//     若当时没有聚焦的编辑器 → 复制到剪贴板（lecture 的形态）。
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { apiGet, type SymbolGroupView, type SymbolView } from './api.ts';

/** 把模板渲染成可插入文本：`$1`/`$2` → 空的 `{}`/`()` 待填位。 */
export function renderTemplate(template: string): string {
  return template.replace(/\$(\d+)/g, '');
}

/**
 * 计算"插入什么 + 光标落在哪"。
 *
 * 答案编辑器是**纯文本 textarea**（不是富文本），所以模板只能退化成
 * `∑_{}^{} ` 这种带空花括号的形态；光标要落在**第一个空 `{}` 里面**，
 * 用户接着打字就填进下限，Tab 由浏览器管不了 —— 界面上写清这一点。
 */
export function symbolInsertion(s: SymbolView): { text: string; caret: number } {
  const text = s.template ? renderTemplate(s.template) : s.insert;
  const idx = text.search(/\{\}|\(\)|\[\]/);
  const caret = idx === -1 ? text.length : idx + 1;
  return { text, caret };
}

/** 插入文本（有 template 用渲染结果，否则用 insert）。 */
export function textOfSymbol(s: SymbolView): string {
  return symbolInsertion(s).text;
}

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
  /** 有聚焦的答案编辑器时插入（caretOffset = 插入后光标的相对位置）；否则返回 false。 */
  onInsert: (text: string, caretOffset: number) => boolean;
  /** 提示条（复制成功等）。 */
  onToast?: (msg: string) => void;
}

export function SymbolPanel({ onInsert, onToast }: SymbolPanelProps): JSX.Element {
  const [groups, setGroups] = useState<SymbolGroupView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    apiGet<{ groups: SymbolGroupView[] }>('symbols')
      .then((r) => {
        if (alive) setGroups(r.groups ?? []);
      })
      .catch((e: Error) => {
        if (alive) {
          setError(e.message);
          setGroups([]);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const src = groups ?? [];
    if (!needle) return src;
    return src
      .map((g) => ({
        ...g,
        symbols: g.symbols.filter(
          (s) => s.label.toLowerCase().includes(needle) || s.insert.toLowerCase().includes(needle) || (s.hint ?? '').toLowerCase().includes(needle),
        ),
      }))
      .filter((g) => g.symbols.length > 0);
  }, [groups, q]);

  const insert = async (s: SymbolView): Promise<void> => {
    const { text, caret } = symbolInsertion(s);
    if (!text) {
      onToast?.('这个模板没有可插入的文本');
      return;
    }
    if (onInsert(text, caret)) return;
    const ok = await copyText(text);
    onToast?.(ok ? `已复制 ${text}` : '复制失败（浏览器拒绝了剪贴板写入）');
  };

  if (groups === null) return <div className="ex-loading">符号表加载中…</div>;
  if (error) {
    return (
      <div>
        <div className="ex-error">符号表不可用：{error}</div>
        <div className="ex-symbol-note">（独立 profile 里没有挂 lecture 插件时会这样；不影响做题与导出）</div>
      </div>
    );
  }
  if (!groups.length) {
    return <div className="ex-empty">符号表为空 —— lecture 插件未安装，可先手动输入 LaTeX</div>;
  }

  return (
    <div>
      <input
        className="ex-symbol-search"
        placeholder="搜索符号（试：积分 / sum / 根号 / 矢量）"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      <div className="ex-symbol-note">
        点符号 = 插入到答案光标处；没有聚焦编辑器时 = 复制到剪贴板。
        {q ? ` 过滤：${filtered.reduce((n, g) => n + g.symbols.length, 0)} 个` : ''}
      </div>
      {filtered.map((g) => {
        const open = !collapsed[g.id];
        return (
          <details
            key={g.id}
            className="ex-symbol-group"
            open={open || !!q}
            onToggle={(e) => {
              const isOpen = (e.currentTarget as HTMLDetailsElement).open;
              setCollapsed((prev) => ({ ...prev, [g.id]: !isOpen }));
            }}
          >
            <summary>{g.label}</summary>
            <div className="ex-symbol-grid">
              {g.symbols.map((s, i) => (
                <button
                  key={`${g.id}-${i}`}
                  type="button"
                  className="ex-symbol-btn"
                  title={`${s.label}${s.hint ? ` — ${s.hint}` : ''}`}
                  onClick={() => void insert(s)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}
