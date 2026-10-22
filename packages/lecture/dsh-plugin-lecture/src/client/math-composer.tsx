// ============================================================
// client/math-composer.tsx — 速记输入框（markdown + 实时预览）
//
// 演进过程（每一步都是真机反馈逼出来的）：
//
//   ① 最早是普通 textarea。
//   ② 用户要 Word 式公式编辑 → 整体换成 MathLive → 但整个输入框成了数学模式，
//      中文变斜体、空格被吞、不能多行。
//   ③ 拆成「文字 / 公式」两个模式 → 用户下一句是：
//      "目前的架构无法再文本中插入公式，很繁琐得分成几块，
//       最好还是做成 word 那样文本编辑可以插入一个公式块"
//   ④ 现在：**一个框，写 markdown，公式用 `$...$` 内联**
//      —— 文字和公式在同一段里，不再分块；下方实时预览。
//
// 为什么是 markdown 而不是 contenteditable 富文本：
//   · 存储是纯文本 → LLM 能读（转录员要读它）、handoff 友好、跨版本存活
//   · 没有 contenteditable 的光标/输入法/撤销那些坑（中文输入法尤其）
//   · 用户能直接看懂、直接改（`$\int_0^1$` 比富文本节点好维护）
//
// 为什么还要预览：
//   提交后笔记区会渲染，但**写的时候**看不到 LaTeX 对不对。
//   预览可折叠 —— 屏幕小的时候收起来，只留编辑框。
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { MathMarkup } from './math-markup.tsx';

export interface MathComposerApi {
  /**
   * 往当前光标处插入一段内容。
   *
   * @param latex 符号的 LaTeX（来自符号键盘，可能含 `\placeholder{}`）
   * @param plainFallback 该符号的可读形式（纯文本符号用，如 `∇`、`d/dx`）
   */
  insert(latex: string, plainFallback?: string): void;
  focus(): void;
}

/**
 * 把符号键盘的 LaTeX 变成**可编辑的 markdown 片段**。
 *
 * - `\int_{\placeholder{}}^{}` → `$\int_{}^{}$`（去掉编辑期占位符再加美元符）
 * - `∇` / `d/dx` 这类本来就是纯文本的，原样插入（不包 `$`）
 */
export function markdownOf(latex: string, plainFallback?: string): string {
  const stripped = latex.replace(/\\placeholder\{\}/g, '');
  // 有反斜杠命令 → 是真 LaTeX，包成行内公式
  if (/\\[a-zA-Z]/.test(stripped)) return `$${stripped.trim()}$`;
  // 没反斜杠 → 纯文本符号，优先用可读回退
  return (plainFallback ?? stripped).trim();
}

/**
 * 光标此刻是不是**在一行内公式 `$…$` 的内部**。
 *
 * 为什么需要（真机反馈："有些符号注入会带着 $$"）：
 *   光标停在公式结尾那个 `$` **之前**时（编辑公式时很常见），
 *   再把新符号包成 `$…$` 插进去，就会和后面那个 `$` 拼成 `$$`：
 *
 *       $a+b|$   ← 光标在这，插入 $\nabla$
 *       $a+b$\nabla$$     ← 末尾多出一对 $
 *
 *   正确做法是：既然已经在公式里，就插**裸 LaTeX**，不再套 `$`。
 *
 * 判定只看**当前行**：跨行数 `$` 没有意义（每行是独立的段落）。
 * 转义的 `\$` 不算定界符。
 */
export function insideMath(value: string, pos: number): boolean {
  const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
  const before = value.slice(lineStart, pos);
  const dollars = (before.match(/(?<!\\)\$/g) ?? []).length;
  return dollars % 2 === 1;
}

/** 符号的 LaTeX 体（去掉编辑期占位符）。 */
function latexBody(latex: string): string {
  return latex.replace(/\\placeholder\{\}/g, '').trim();
}

/** 这个符号是不是真 LaTeX（有反斜杠命令），而不是 ∇、d/dx 这种纯文本。 */
function isLatex(latex: string): boolean {
  return /\\[a-zA-Z]/.test(latex.replace(/\\placeholder\{\}/g, ''));
}

export function MathComposer({
  disabled,
  onSubmit,
  apiRef,
}: {
  disabled: boolean;
  /** 提交一段 markdown（就是用户写的原文）。 */
  onSubmit: (markdown: string) => Promise<void>;
  apiRef?: { current: MathComposerApi | null };
}): JSX.Element {
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const [showPreview, setShowPreview] = useState(true);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  /** 自动长高（输入区随内容长）。 */
  const resize = useCallback((): void => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [text, resize]);

  /** 往光标处插入（保留选区语义：有选中就替换选中）。 */
  const insertInto = useCallback((latex: string, plainFallback?: string): void => {
    const el = taRef.current;
    if (!el) {
      setText((v) => v + markdownOf(latex, plainFallback));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const value = el.value;

    // 1) 决定插什么
    //    · 光标在公式内部 → 插**裸 LaTeX**（再包 `$` 会拼出 `$$`）
    //    · 光标在公式外部 → 真 LaTeX 包成 `$…$`；纯文本符号（∇、d/dx）原样插
    const body = isLatex(latex) ? latexBody(latex) : (plainFallback ?? latexBody(latex)).trim();
    const alreadyInMath = insideMath(value, start);
    const wrap = isLatex(latex) && !alreadyInMath;
    const core = wrap ? `$${body}$` : body;

    // 2) 和相邻的 `$` 隔开，避免粘成 `$$`
    //    —— 光标在公式**结尾**的 `$` 之后（前导）或**开头**的 `$` 之前（尾随）。
    const prevChar = value.slice(0, start).replace(/\s+$/, '').slice(-1);
    const nextChar = value.slice(end).replace(/^\s+/, '').slice(0, 1);
    const lead = wrap && prevChar === '$' ? ' ' : '';
    const tail = wrap && nextChar === '$' ? ' ' : '';

    const patch = lead + core + tail;
    const next = value.slice(0, start) + patch + value.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      // 光标落在插入内容之后（tail 之后，方便接着打字）
      const pos = start + patch.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    if (disabled) return;
    const v = text.trim();
    if (!v) return;
    setHint('');
    try {
      await onSubmit(v);
      setText('');
      requestAnimationFrame(resize);
      setHint('已记下');
      window.setTimeout(() => setHint(''), 1200);
    } catch (e) {
      // 失败不清空 —— 内容必须留住
      setHint(`没记上：${(e as Error).message}`);
    }
  }, [disabled, text, onSubmit, resize]);

  // 暴露给符号键盘
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      insert(latex: string, plainFallback?: string): void {
        // 注意传**原始** latex（不是 markdownOf 处理过的）——
        // insertInto 需要知道"是不是真 LaTeX"，才能决定要不要包 $。
        insertInto(latex, plainFallback);
      },
      focus(): void {
        taRef.current?.focus();
      },
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, insertInto]);

  return (
    <div className="lec-composer">
      <div className="lec-composer-tabs">
        <span className="lec-composer-modelabel lec-composer-mode-static">
          文字 + 公式（公式写成 <code>$...$</code>）
        </span>
        <button
          type="button"
          className="lec-composer-tab"
          data-active={showPreview ? '1' : '0'}
          onClick={() => setShowPreview((v) => !v)}
          title={showPreview ? '收起预览' : '展开预览'}
        >
          {showPreview ? '预览 ✓' : '预览'}
        </button>
      </div>

      <div className="lec-composer-field">
        <textarea
          ref={taRef}
          className="lec-composer-input"
          rows={2}
          placeholder={'写笔记：普通文字直接写；公式用 $ 包起来，例如 梯度 $\\nabla f$\nEnter 记下，Shift+Enter 换行'}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter 提交 / Shift+Enter 换行 / 输入法组合中不拦截
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>

      {/* 预览：写的时候就能看到公式对不对 */}
      {showPreview && text.trim() ? (
        <div className="lec-composer-preview">
          <div className="lec-composer-previewhead">预览</div>
          <MathMarkup text={text} />
        </div>
      ) : null}

      <div className="lec-composer-row">
        <span className="lec-composer-hint" data-tone={hint.startsWith('没记上') ? 'err' : 'ok'}>
          {hint}
        </span>
        <button
          type="button"
          className="lec-composer-send"
          onClick={() => void submit()}
          disabled={disabled || !text.trim()}
        >
          {disabled ? '记录中…' : '记下'}
        </button>
      </div>
    </div>
  );
}
