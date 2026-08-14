// ============================================================
// chunker.ts — 讲义分块（纯函数，可单测）
// 规则：按二级标题（## ）切块；超长块（>maxLen）按段落二次切分
// ============================================================

export interface NoteChunk {
  id: string;
  file: string;
  section: string;
  content: string;
}

/** 段落级二次切分（保证块 ≤ maxLen，中文按字符数近似）。 */
function splitParagraph(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n+/)) {
    if (para.trim().length === 0) continue;
    if (cur.length + para.length + 1 > maxLen) {
      if (cur) out.push(cur.trim());
      cur = para;
    } else {
      cur = cur ? `${cur}\n${para}` : para;
    }
  }
  if (cur) out.push(cur.trim());
  return out;
}

/**
 * 将一份讲义文本按二级标题切块。
 * @param file 文件名（用于 chunk id 前缀）
 * @param raw  讲义全文
 * @param maxLen 单块最大字符数（默认 2000）
 */
export function chunkText(file: string, raw: string, maxLen = 2000): NoteChunk[] {
  const chunks: NoteChunk[] = [];
  const sections = raw.split(/^##\s+/m);
  // sections[0] 是标题前的头部；每个后续元素是一个 "标题\n内容"
  let fileIdx = 0;
  const pushChunk = (section: string, content: string): void => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const parts = splitParagraph(trimmed, maxLen);
    for (const part of parts) {
      chunks.push({ id: `${file}#${fileIdx++}`, file, section: section || '(前言)', content: part });
    }
  };
  if (sections[0] && sections[0].trim()) {
    pushChunk('(前言)', sections[0]);
  }
  for (let i = 1; i < sections.length; i++) {
    const nl = sections[i].indexOf('\n');
    const title = nl === -1 ? sections[i].trim() : sections[i].slice(0, nl).trim();
    const body = nl === -1 ? '' : sections[i].slice(nl + 1);
    pushChunk(title, body);
  }
  return chunks;
}
