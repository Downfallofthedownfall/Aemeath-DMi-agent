// ============================================================
// pdf-image.ts — 把 PDF 页面渲染成图片（给多模态模型"看卷子"，也给界面当原题截图）
//
// 为什么需要（用户实测反馈）：
//   "习题文字 OCR 不太准还会漏掉图片，所以不要文字模式而是放一张截图之类的，
//    llm 纠错也用模型多模态能力，或者直接上传 pdf 用 llm 的多模态读取更准确"。
//   文本抽取对公式/插图/多栏排版天生不可靠；图片是**保真**的，
//   而且多模态模型能直接读图，不再依赖 OCR。
//
// 实现：pdfjs-dist（legacy build）+ @napi-rs/canvas（pdfjs 的 optionalDependency，
//   mac/Windows 都有预编译二进制，零 Python）。渲染成 JPEG（体积约 PNG 的 3/4）。
//
// 纯函数 + 一个动态 import：没装 canvas 的环境（比如纯 headless）只是拿到
//   "图片不可用"，不影响文本链路。
// ============================================================

export interface RenderedPage {
  /** 1-based 页码 */
  page: number;
  mediaType: 'image/jpeg';
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface RenderOptions {
  /** 缩放（PDF 默认 72dpi；2 = 144dpi，公式/小字够清楚） */
  scale?: number;
  /** JPEG 质量 0-100 */
  quality?: number;
  /** 太多页就别渲染了（一次导入的合理上限） */
  maxPages?: number;
}

export const DEFAULT_RENDER: Required<RenderOptions> = { scale: 2, quality: 88, maxPages: 12 };

/**
 * 渲染 PDF 的每一页。
 *
 * 失败（没装 canvas / PDF 损坏 / 页数超限）→ 抛错，由调用方决定是否降级成纯文本。
 */
export async function renderPdfPages(bytes: Uint8Array, opts: RenderOptions = {}): Promise<RenderedPage[]> {
  const { scale, quality, maxPages } = { ...DEFAULT_RENDER, ...opts };
  const [{ createCanvas }, pdfjs] = await Promise.all([
    import('@napi-rs/canvas'),
    import('pdfjs-dist/legacy/build/pdf.mjs'),
  ]);

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  }).promise;

  try {
    const total = Math.min(doc.numPages, maxPages);
    const out: RenderedPage[] = [];
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      // 白底：PDF 背景透明时，暗色主题下贴图会黑成一团
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const jpeg = canvas.toBuffer('image/jpeg', quality);
      out.push({
        page: n,
        mediaType: 'image/jpeg',
        bytes: new Uint8Array(jpeg),
        width: canvas.width,
        height: canvas.height,
      });
      page.cleanup();
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/** 图片在目录里的文件名：page-01.jpg（页码补零，方便排序）。 */
export function pageImageName(page: number): string {
  return `page-${String(Math.max(1, Math.floor(page))).padStart(2, '0')}.jpg`;
}

/** 从 `page-07.jpg` 反解页码（找不到 → 0）。也认 `.png`：用户手放截图时不至于失效。 */
export function pageFromImageName(name: string): number {
  const m = /^page-(\d+)\.(?:jpe?g|png)$/i.exec(name);
  return m ? Number(m[1]) : 0;
}
