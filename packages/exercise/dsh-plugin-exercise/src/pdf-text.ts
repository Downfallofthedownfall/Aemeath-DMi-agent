// ============================================================
// pdf-text.ts — PDF 文本抽取（Übungen 导入的第一步）
//
// 为什么有这一层而不是直接调 pdfjs：
//   · PDF 里的文本是**绝对定位的碎片**，没有"行"的概念。教育类作业 PDF
//     （LaTeX 导出的 Übungsblatt）尤其碎：一个公式会被拆成十几个 item。
//     直接拿 `item.str` 拼出来的是一串没有换行、空格时有时无的流，
//     既不能给用户看，也不能按行切题号。
//   · 所以这里做两件事：**重建行**（按 y 分组、按 x 排序、按间隙补空格）
//     与**清洗**（连字/连字符/页码/空行）。切题（split.ts）依赖"每行是
//     语义上的一行"这个前提。
//
// 本模块**不进 dsh**，可在纯 Node 下单测（见 test/check2.mjs）。
// ============================================================

export interface PdfExtractResult {
  /** 全文（页间以 \f 分隔，保留页边界；已做清洗） */
  text: string;
  /** 每页文本（已清洗，未加 \f） */
  pages: string[];
  pageCount: number;
  /** 是否抽到了"有效文本"（启发式：去空白后 ≥ 40 字符） */
  hasText: boolean;
  /** 抽取过程中的非致命告警（供上层日志） */
  warnings: string[];
}

// ============================================================
// 常量：全部集中在这里，便于解释"为什么是这个数"
// ============================================================

/**
 * 同一行的 y 容差。
 *
 * 为什么是 2.5：同一行内混排不同字号（正文 + 上标/下标 + 脚注标记）时，
 * 基线差通常在 1–2pt；而正常行距一般 ≥ 8pt。2.5 落在两簇中间，
 * 既不把上下标甩到另一行，也不会把相邻两行粘成一行。
 */
const Y_TOLERANCE = 2.5;

/**
 * 补空格的间隙阈值 = 1.1 × 平均字宽。
 *
 * 为什么需要补：pdfjs 经常**不输出空格 item**（内容流里是「移动定位 + 画字」，
 * 空格由位移体现），若照原样拼接，`Die Kraft` 会变成 `DieKraft`。
 * 为什么是 1.1 倍而不是 0.5：同一单词被拆成多个 item（换字重、嵌公式）时
 * 间隙≈0；词间距≈0.25–0.5 个 em。取 1.1 意味着"只有明显大于一个字宽的空隙
 * 才算空格"——宁可少补（`DieKraft` 之后还有 split 的容错），也不要多补
 * （多补会把 `$v_0$` 拆成 `$v _0$`，公式直接废掉）。
 */
const SPACE_GAP_RATIO = 1.1;

/** 拿不到字宽时的兜底：间隙 > 2 就补一个空格。 */
const SPACE_GAP_FALLBACK = 2;

/**
 * "抽到有效文本"的阈值（去空白后的字符数）。
 *
 * 为什么是 40：扫描件（纯图片）抽出来是空串或零星的水印/页眉噪声；
 * 真正的题目正文几乎不可能少于 40 个非空白字符。UI 据此提示"手补题干"。
 */
const MIN_MEANINGFUL_CHARS = 40;

/**
 * 排版连字 → 展开。
 *
 * 为什么必须处理：LaTeX/pdfTeX 会把 f 连字写成单个码位，
 * `fl` 变成 `ﬂ`。用户在搜索框里敲 "fl" 永远搜不到，复制进 LLM 也容易被
 * tokenizer 当成怪字符。展开成 ASCII 才是"对下游友好"的文本。
 */
const LIGATURES: Readonly<Record<string, string>> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
};

// ============================================================
// 行重建
// ============================================================

/** pdfjs 的 TextItem 形状在各版本间有出入，这里只取用得到的字段，全部按 unknown 收。 */
interface PdfTextItemLike {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
}

/** 我们真正依赖的 pdfjs 面（只声明用到的部分，避免被 pdfjs 的完整类型绑死）。 */
interface PdfPageLike {
  getTextContent(): Promise<{ items?: unknown[] } | null | undefined>;
  cleanup?(): void;
}

interface PdfDocumentLike {
  numPages?: number;
  getPage(n: number): Promise<PdfPageLike>;
  destroy?(): Promise<void> | void;
}

interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
}

interface PdfJsLike {
  getDocument?(src: Record<string, unknown>): PdfLoadingTaskLike;
  default?: PdfJsLike;
}

interface LineItem {
  x: number;
  width: number;
  str: string;
}

function numeric(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 平均字宽估算。
 *
 * 用 `width / str.length`：pdfjs 给的 width 是这一小段文字的排版宽度，
 * 除以字符数就是平均字宽（含空格，这正是我们想要的——间隙要和"含空格的
 * 一个字符宽度"比）。
 * 取两个 item 的平均值：字体切换（正文 → 数学字体）时单侧估算偏差大。
 * 两边都拿不到（width=0 或空串）返回 0，调用方退回固定阈值。
 */
function avgCharWidth(a: LineItem, b: LineItem): number {
  const samples: number[] = [];
  if (a.width > 0 && a.str.length > 0) samples.push(a.width / a.str.length);
  if (b.width > 0 && b.str.length > 0) samples.push(b.width / b.str.length);
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s;
  return sum / samples.length;
}

/** 一行内的 item → 文本。单 item 行**绝不**插空格（它内部本来就是整段）。 */
function renderLine(items: LineItem[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!.str;

  const sorted = [...items].sort((a, b) => a.x - b.x);
  let out = sorted[0]!.str;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const gap = cur.x - (prev.x + prev.width);
    const cw = avgCharWidth(prev, cur);
    const needSpace = cw > 0 ? gap > cw * SPACE_GAP_RATIO : gap > SPACE_GAP_FALLBACK;
    // 已经以空白结尾/开头时不再叠加，否则 normalize 才有意义
    if (needSpace && !/\s$/.test(out) && !/^\s/.test(cur.str)) out += ' ';
    out += cur.str;
  }
  return out;
}

/**
 * 一页的 items → 带换行的文本。
 *
 * 为什么按 y **相邻分组**而不是全页排序后聚类：pdfjs 的 items 顺序就是内容流
 * 顺序，正常文档里天然是"从上到下、从左到右"。只把 y 差 < 2.5 的相邻项归为
 * 同一行，能保住阅读顺序；反过来按 y 全页排序会把双栏排版、脚注、边注
 * 全部打乱（脚注会插到正文中间）。
 */
function rebuildPageText(items: readonly unknown[]): string {
  const lines: LineItem[][] = [];
  let lineY: number | null = null;

  for (const raw of items) {
    const item = raw as PdfTextItemLike | null | undefined;
    const str = typeof item?.str === 'string' ? item.str : '';
    if (str.length === 0) continue;

    const tr = item?.transform;
    // 没有 transform 就无法定位；宁可丢掉这一小段，也不能把它的文字
    // 胡乱插到某一行中间（会把公式读错，比缺字更危险）。
    if (!Array.isArray(tr) || tr.length < 6) continue;

    const x = numeric(tr[4]);
    const y = numeric(tr[5]);
    const entry: LineItem = { x, width: numeric(item?.width), str };

    if (lineY !== null && Math.abs(y - lineY) < Y_TOLERANCE) {
      lines[lines.length - 1]!.push(entry);
      continue;
    }
    lineY = y;
    lines.push([entry]);
  }

  return lines.map(renderLine).join('\n');
}

// ============================================================
// 清洗
// ============================================================

/** 展开连字 + 删软连字符（这是**字符级**处理，先做，后面的行级逻辑才干净）。 */
function foldCharacters(input: string): string {
  let out = '';
  for (const ch of input) {
    const hit = LIGATURES[ch];
    if (hit !== undefined) {
      out += hit;
      continue;
    }
    if (ch === '\u00ad') continue; // 软连字符：不可见，只用于断词提示
    out += ch;
  }
  return out;
}

/**
 * 行尾连字符合并（断词还原）。
 *
 * 只在**同时满足**两个条件时合并：
 *   ① 上一行以 `-` 结尾（不是 – / —，那些是标点不是断词）；
 *   ② 下一行以**小写字母**开头。
 * 为什么必须限定小写：德语的复合词/人名常以大写开头（`Schrödinger-`
 * `Gleichung` 这种断词确实存在，但 `-` 后面接大写更常见于是**并列/破折号**
 * 或"题号 - 标题"的写法）。误合并会造出不存在的词，比留着连字符更难发现。
 * 覆盖的字母集合含 äöüß（德语讲义常见）。
 */
function dehyphenate(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const prev = out.length > 0 ? out[out.length - 1]! : undefined;
    if (prev !== undefined && /-$/.test(prev) && /^\s*[a-zäöüß]/.test(line)) {
      out[out.length - 1] = `${prev.slice(0, -1).replace(/[ \t]+$/, '')}${line.replace(/^\s+/, '')}`;
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * 删除"裸页码行"。
 *
 * 为什么限定极严（纯数字 + ≤3 位 + 前后都是空行）：
 * 讲义里到处都是数字——`3` 可能是题号、公式编号、向量分量。
 * 只有"单独成行、前后都有空行、且很短"的纯数字才几乎必然是页脚页码。
 * 不满足就**留着**（留着只是多一行噪声，删错会丢内容）。
 */
function dropBarePageNumbers(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const prevBlank = i > 0 && lines[i - 1]!.trim() === '';
    const nextBlank = i < lines.length - 1 && lines[i + 1]!.trim() === '';
    if (/^\d{1,3}$/.test(t) && prevBlank && nextBlank) continue;
    out.push(lines[i]!);
  }
  return out;
}

/**
 * 清洗一段 PDF 文本。
 *
 * 顺序很重要（每一步都为下一步准备输入）：
 *   1. CRLF/CR → LF      —— 后面全部按行处理
 *   2. 连字/软连字符      —— 字符级，先做
 *   3. 行内空白折叠      —— `a   b` → `a b`，并去掉行尾空白
 *   4. 断词合并          —— 依赖"上一行以 - 结尾"这种行形态
 *   5. 删裸页码          —— 依赖"前后是空行"，必须在折叠空行**之前**
 *   6. 折叠空行          —— 3 个以上换行（≥2 个空行）压成一个空行
 *
 * 注意本函数**不需要**是幂等的：extractPdfText 已保证每页只清洗一次。
 */
export function normalizePdfText(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';

  let s = raw.replace(/\r\n?/g, '\n');
  s = foldCharacters(s);

  let lines = s.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, ''));

  lines = dehyphenate(lines);
  lines = dropBarePageNumbers(lines);

  // `\n{3,}` = 两个及以上空行 → 压成一个空行。
  // 规格写的是"3 个以上空行"，这里更激进一档：连续 2 个空行已经没有任何
  // 排版含义（PDF 抽出来的空行本来就是分页/分栏的副产物）。
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return out.replace(/^\n+/, '').replace(/\n+$/, '');
}

// ============================================================
// 抽取
// ============================================================

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return '未知错误';
}

/** 去空白后的长度（`\f` 也算空白，这里的入参通常已不含它）。 */
function meaningfulLength(s: string): number {
  return s.replace(/\s+/g, '').length;
}

function failed(message: string): PdfExtractResult {
  return { text: '', pages: [], pageCount: 0, hasText: false, warnings: [message] };
}

/**
 * 从 PDF 字节抽文本。
 *
 * 关键设计：
 *   · **绝不抛**。损坏/加密/扫描件都是正常业务输入（老师发的 PDF 什么都有），
 *     抛异常会让上层的导入流程整个中断。失败时返回空结果 + warnings，
 *     由调用方决定"提示手补题干"。
 *   · **动态 import**。pdfjs 是 ESM-only，且模块顶层会探测 worker/字体/URL 等
 *     宿主能力。静态 import 会在 dsh 插件加载阶段就执行——插件跑在 host
 *     （Node）里，一旦探测失败就是整个 profile 起不来。放进函数体后，
 *     只有真正导入 PDF 时才付这笔成本；测试也不必配 worker。
 *   · **legacy build**。非 legacy 版依赖较新的浏览器内建（如某些 Canvas 门面），
 *     Node 下不稳；legacy 自带 polyfill，纯文本抽取足够。
 *   · `isEvalSupported: false` / `disableFontFace: true`：只抽文本，
 *     不需要求值字体也不需要渲染。关掉即减少 PDF 内嵌 JS 的攻击面与内存。
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtractResult> {
  const warnings: string[] = [];

  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      return failed('PDF 内容为空');
    }

    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsLike;
    const getDocument = pdfjs.getDocument ?? pdfjs.default?.getDocument;
    if (typeof getDocument !== 'function') {
      return failed('pdfjs-dist 未导出 getDocument（依赖版本不匹配？）');
    }

    const task = getDocument({
      data: bytes,
      useSystemFonts: false,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    });
    const doc = await task.promise;

    const total = typeof doc.numPages === 'number' && doc.numPages > 0 ? doc.numPages : 0;
    if (total === 0) {
      return failed('PDF 没有可读页面');
    }

    const pages: string[] = [];
    for (let i = 1; i <= total; i++) {
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const items = Array.isArray(content?.items) ? content.items : [];
        pages.push(normalizePdfText(rebuildPageText(items)));
        try {
          page.cleanup?.();
        } catch {
          // 清理失败不影响已抽到的文本
        }
      } catch (e) {
        // 单页失败不放弃整份文档：作业 PDF 常见"最后一页是扫描的评分标准"
        warnings.push(`第 ${i} 页文本抽取失败：${errorText(e)}`);
        pages.push('');
      }
    }

    // 释放 worker/字体资源；失败不影响结果
    try {
      await Promise.resolve(doc.destroy?.());
    } catch {
      /* ignore */
    }

    const text = pages.join('\n\f\n');
    const hasText = meaningfulLength(pages.join('')) >= MIN_MEANINGFUL_CHARS;
    if (!hasText) {
      warnings.push('未抽到有效文本（可能是扫描件/纯公式）：请手动补题干');
    }

    return { text, pages, pageCount: pages.length, hasText, warnings };
  } catch (e) {
    // 加密（PasswordException）、损坏、依赖缺失…… 一律降级
    return failed(`PDF 解析失败：${errorText(e)}`);
  }
}
