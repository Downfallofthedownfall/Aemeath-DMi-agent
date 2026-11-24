// ============================================================
// client/page-figure.tsx — 原卷页面截图（题卡 / 大题卡共用）
//
// 用户 2026-11-24："含图题目图片无法折叠且巨大无比，基本必然冲出界面"。
//   原因：精简布局时拿掉了外层 .lec-pagefig，而限高 / 限宽的样式都挂在它下面 ——
//   原卷按 2 倍渲染（约 1700×2400），图就按原尺寸铺开；唯一的开关是头部的小标签，
//   一滚就看不见了。
//   现在：图自己限高（58vh，内部滚动）、宽度不超过卡片；图的正上方就有「收起」。
// ============================================================

import { useT } from './i18n.ts';

export interface PageFigureProps {
  url: string;
  page: number;
  /** 这题带插图（左侧加一道强调色） */
  figure?: boolean;
  onHide: () => void;
}

export function PageFigure({ url, page, figure = false, onHide }: PageFigureProps): JSX.Element {
  const t = useT();
  return (
    <div className="lec-pagefig" data-figure={figure ? '1' : '0'}>
      <div className="lec-pagefig-bar">
        <span>{t('exercise.problem.pageBadge', { page })}</span>
        <span className="lec-grow" />
        <button type="button" className="lec-linkbtn" onClick={() => window.open(url, '_blank')}>
          {t('exercise.problem.openNewWindow')}
        </button>
        <button type="button" className="lec-linkbtn" onClick={onHide}>
          {t('exercise.problem.hidePage')}
        </button>
      </div>
      <div className="lec-pageimg">
        <img src={url} alt={t('exercise.problem.pageBadge', { page })} loading="lazy" />
      </div>
    </div>
  );
}
