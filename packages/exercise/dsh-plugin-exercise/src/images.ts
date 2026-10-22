// ============================================================
// images.ts — 答案附图的纯函数（格式嗅探 + 文件名）
//
// 为什么要嗅探：用户上传的东西扩展名不可信（截图改后缀、拖拽来的 webp），
// 而 `<img>`/PDF 内联都要正确的 media type。按**内容头部**判断，只放行
// PNG / JPEG / WebP / GIF（其余一律拒绝，避免 SVG 里带脚本）。
// ============================================================

export interface ImageType {
  media: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  ext: 'png' | 'jpg' | 'webp' | 'gif';
}

/** 从字节头判断图片格式；不认识 → null。 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a) {
    return { media: 'image/png', ext: 'png' };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { media: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 12) {
    const ascii = (from: number, to: number): string => String.fromCharCode(...b.slice(from, to));
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { media: 'image/webp', ext: 'webp' };
    if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { media: 'image/gif', ext: 'gif' };
  }
  return null;
}

/** 生成一个不会撞车的文件名（时间 + 随机后缀；扩展名由内容决定）。 */
export function imageFileName(now: number, rand: string, ext: string): string {
  return `img-${now.toString(36)}-${rand}.${ext}`;
}
