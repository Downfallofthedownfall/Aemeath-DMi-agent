// ============================================================
// client/symbol-palette.tsx — 数学符号面板（外观照 lecture 的符号键盘）
//
// 数据来源：host 的 `?action=symbols`，借的是 lecture 的符号表（250+ 项）。
// 点一下 = 插入到答案光标处；没有聚焦的编辑器时 = 复制到剪贴板。
//
// 为什么走 HTTP 而不是前端 import lecture 的包：
//   client bundle 是 __ModuleLoader__ 单文件格式，跨插件 import 会变成运行时依赖；
//   走 HTTP 则 lecture 没装时也能优雅退化成空表。
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { apiGet, type SymbolGroupView, type SymbolView } from './api.ts';

/** 把模板渲染成可插入文本：`$1`/`$2` → 空的待填位。 */
export function renderTemplate(template: string): string {
  return template.replace(/\$(\d+)/g, '');
}

/** 插入什么 + 光标落哪（纯文本 textarea，落进第一个空 {} / () / []）。 */
export function symbolInsertion(s: SymbolView): { text: string; caret: number } {
  const text = s.template ? renderTemplate(s.template) : s.insert;
  const idx = text.search(/\{\}|\(\)|\[\]/);
  const caret = idx === -1 ? text.length : idx + 1;
  return { text, caret };
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
  onInsert: (text: string, caretOffset: number) => boolean;
  onToast?: (msg: string) => void;
}

export function SymbolPanel({ onInsert, onToast }: SymbolPanelProps): JSX.Element {
  const [groups, setGroups] = useState<SymbolGroupView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

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
          (s) =>
            s.label.toLowerCase().includes(needle) ||
            s.insert.toLowerCase().includes(needle) ||
            (s.hint ?? '').toLowerCase().includes(needle),
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

  if (groups === null) return <div className="lec-hint">符号表加载中…</div>;
  if (error) {
    return (
      <div>
        <div className="lec-warn">符号表不可用：{error}</div>
        <div className="lec-hint">（独立 profile 里没有挂 lecture 插件时会这样；不影响做题与导出）</div>
      </div>
    );
  }
  if (!groups.length) return <div className="lec-empty">符号表为空 —— lecture 插件未安装，可手动输入 LaTeX</div>;

  return (
    <div>
      <input
        className="lec-symsearch"
        placeholder="搜索符号（试：积分 / sum / 根号 / 矢量）"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      <div className="lec-hint">
        点符号 = 插入到答案光标处；没有聚焦编辑器时 = 复制。
        {q ? ` 过滤：${filtered.reduce((n, g) => n + g.symbols.length, 0)} 个` : ''}
      </div>
      {filtered.map((g, gi) => (
        // 默认展开前两组（常用：微积分 / 求和），其余折叠 —— 与 lecture 的手感一致：
        // 一进来就能点到 ∫ 和 ∑，又不会被十几组淹没。
        <details key={g.id} open={!!q || gi < 2}>
          <summary className="lec-symgroup-name">{g.label}</summary>
          <div className="lec-symgrid">
            {g.symbols.map((s, i) => (
              <button
                key={`${g.id}-${i}`}
                type="button"
                className="lec-symbtn"
                title={`${s.label}${s.hint ? ` — ${s.hint}` : ''}`}
                onClick={() => void insert(s)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
