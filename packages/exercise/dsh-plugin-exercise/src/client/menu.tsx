// ============================================================
// client/menu.tsx — 「⋯」下拉菜单
//
// 用户 2026-11-20："exercise 精简一下前端，目前各个按钮乱七八糟占地也大"。
// 不常用的操作（改题干、拆小题、附图、导出握手……）都收进这里，
// 界面上只留每一处最常用的一两个按钮。
// ============================================================

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** 删除类操作：红字 */
  danger?: boolean;
  title?: string;
}

export interface MenuProps {
  items: ReadonlyArray<MenuItem | null | false>;
  /** 按钮上的字（默认 ⋯） */
  label?: ReactNode;
  title?: string;
  /** 菜单向哪边展开（靠右的按钮向左展开，免得出界） */
  align?: 'left' | 'right';
  className?: string;
}

export function Menu({ items, label = '⋯', title, align = 'right', className }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const shown = items.filter((x): x is MenuItem => !!x);
  return (
    <span className={`lec-menu ${className ?? ''}`} ref={rootRef}>
      <button
        type="button"
        className="lec-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open ? (
        <span className="lec-menu-list" role="menu" data-align={align}>
          {shown.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="lec-menu-item"
              data-danger={it.danger ? '1' : '0'}
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
