// ============================================================
// client/page-figure.tsx — 原卷页面截图（题卡 / 大题卡共用）
//
// 用户 2026-11-24："含图题目图片无法折叠且巨大无比，基本必然冲出界面"。
//   原因：精简布局时拿掉了外层 .lec-pagefig，而限高 / 限宽的样式都挂在它下面 ——
//   原卷按 2 倍渲染（约 1700×2400），图就按原尺寸铺开；唯一的开关是头部的小标签，
//   一滚就看不见了。
//   现在：图自己限高（58vh，内部滚动）、宽度不超过卡片；图的正上方就有「收起」。
//
// 同日追加（用户："图片收起就再也打不开了"）：
//   收起后原地什么都不剩，能重新展开的只有头部那个「原卷 p.N」小标签，看不出是开关。
//   现在收起 = **原地留一行**「▸ 原卷第 N 页（已收起）· 展开原题截图」，点哪儿都能展开。
// ============================================================

import { useT } from './i18n.ts';

export interface PageFigureProps {
  url: string;
  page: number;
  /** 这题带插图（左侧加一道强调色） */
  figure?: boolean;
  /** 展开 = 显示图；收起 = 只剩一行（不是消失） */
  open: boolean;
  onToggle: () => void;
}

/** 题卡里原卷截图的三种状态：从没展开过（只有头部标签）/ 展开 / 收起（原地留一行）。 */
export type PageView = 'hidden' | 'open' | 'closed';

export function nextPageView(v: PageView): PageView {
  return v === 'open' ? 'closed' : 'open';
}

export function PageFigure({ url, page, figure = false, open, onToggle }: PageFigureProps): JSX.Element {
  const t = useT();
  return (
    <div className="lec-pagefig" data-figure={figure ? '1' : '0'} data-open={open ? '1' : '0'}>
      <div className="lec-pagefig-bar">
        <button type="button" className="lec-linkbtn lec-pagefig-toggle" onClick={onToggle} aria-expanded={open}>
          {open ? '▾ ' : '▸ '}
          {open ? t('exercise.problem.pageBadge', { page }) : t('exercise.problem.pageCollapsed', { page })}
        </button>
        <span className="lec-grow" />
        <button type="button" className="lec-linkbtn" onClick={() => window.open(url, '_blank')}>
          {t('exercise.problem.openNewWindow')}
        </button>
        <button type="button" className="lec-linkbtn" onClick={onToggle}>
          {open ? t('exercise.problem.hidePage') : t('exercise.problem.expandPage')}
        </button>
      </div>
      {open ? (
        <div className="lec-pageimg">
          <img src={url} alt={t('exercise.problem.pageBadge', { page })} loading="lazy" />
        </div>
      ) : null}
    </div>
  );
}
