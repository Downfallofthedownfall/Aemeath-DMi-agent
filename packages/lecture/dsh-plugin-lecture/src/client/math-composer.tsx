// ============================================================
// client/math-composer.tsx — 速记输入框（文字 / 公式 双模式）
//
// 演进过程（每一步都是真机反馈逼出来的）：
//
//   ① 最早是普通 textarea —— 用户要在中栏记笔记（"mac 上没有输入框"）。
//   ② 用户要 Word 式公式编辑："最好做成 word 的等式输入那种吧"，
//      于是整体换成 MathLive。
//   ③ 用户立刻发现新问题："那现在是不是整个输入框都是公式文字了？
//      正常文本怎么办呢"
//
//   —— 他是对的。MathLive 是**数学模式**：
//      · 中文和普通英文被当变量名，渲染成斜体（"今天教授" 像变量）
//      · 空格在数学模式里无意义，会被吞掉
//      · 只能一行，写不了段落
//
//   ④ 现在：**两个模式，各司其职**
//      · 文字（默认）—— 普通 textarea：空格、换行、中文、标点全都正常
//      · 公式 —— MathLive：积分上下限框、矢量箭头、分数……
//
//   绝大多数课堂速记是文字里夹几个公式，所以**默认文字**，
//   需要公式时点一下切换（或直接点右栏符号，见下）。
//
// 关于右栏符号：在**文字模式**下点符号，会自动切到公式模式再插入 ——
//   因为 `\int_{}^{}` 这类 LaTeX 放进 textarea 只会变成一串反斜杠，
//   对用户毫无用处。"点了符号却没反应"比"自动切模式"更让人困惑。
//
// 存储：公式模式存 LaTeX 源码；文字模式存原文。
//   两者都落进同一份 markdown（`raw` 字段），互不干扰。
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';

/** 输入模式。默认文字 —— 上课大多在记事，不是在推导。 */
export type ComposerMode = 'text' | 'math';

/** MathLive 的 math-field 元素（只写我们用到的部分，避免依赖其类型包）。 */
interface MathFieldElement extends HTMLElement {
  value: string;
  focus(): void;
  /**
   * 在光标处插入 LaTeX 并**解析成结构化节点**。
   *
   * ⚠️ 不是 `executeCommand('insert ...')` —— 那是无效命令，
   *    真机报 `Unknown command "insert \int_{}^{} "`，插入静默失败。
   *    正确 API 是 `insert()`。
   */
  insert(s: string): boolean;
}

/** MathLive 模块加载一次即可（全局注册自定义元素）。 */
let mathlivePromise: Promise<void> | null = null;

/**
 * 懒加载 MathLive（823KB，不该在打开课堂时同步加载）。
 * 失败时降级成"公式模式不可用"，文字模式照常工作。
 */
async function loadMathLive(): Promise<boolean> {
  if (mathlivePromise) {
    await mathlivePromise;
    return typeof customElements !== 'undefined' && !!customElements.get('math-field');
  }
  mathlivePromise = (async () => {
    try {
      await import('mathlive');
    } catch {
      /* 由调用方降级 */
    }
  })();
  await mathlivePromise;
  return typeof customElements !== 'undefined' && !!customElements.get('math-field');
}

export interface MathComposerApi {
  /**
   * 插入一段内容。
   *
   * @param latex 要插入的 LaTeX（公式模式用）
   * @param plainFallback 文字模式下插入的等价文本（可选；不给就用 latex 原文）
   *
   * 为什么带两份：符号键盘点一下，希望"公式模式插结构、文字模式插可读文本"。
   * 例如 `∑`：公式模式是 `\sum_{\placeholder{}}`，文字模式直接放 `∑`。
   */
  insert(latex: string, plainFallback?: string): void;
  focus(): void;
}

export function MathComposer({
  disabled,
  onSubmit,
  apiRef,
}: {
  disabled: boolean;
  /** 提交一段内容（文字模式的原文 / 公式模式的 LaTeX）。 */
  onSubmit: (content: string, mode: ComposerMode) => Promise<void>;
  apiRef?: { current: MathComposerApi | null };
}): JSX.Element {
  const [mode, setMode] = useState<ComposerMode>('text');
  const [mathReady, setMathReady] = useState(false);
  const [mathFailed, setMathFailed] = useState(false);
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<MathFieldElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 只有切到公式模式才加载 MathLive（进一步省流量：很多人从不用公式）
  useEffect(() => {
    if (mode !== 'math' || mathReady || mathFailed) return;
    let alive = true;
    void loadMathLive().then((ok) => {
      if (!alive) return;
      if (ok) setMathReady(true);
      else setMathFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [mode, mathReady, mathFailed]);

  // 公式模式下创建 math-field
  useEffect(() => {
    if (mode !== 'math' || !mathReady || !hostRef.current) return;
    if (fieldRef.current) return;
    const el = document.createElement('math-field') as MathFieldElement;
    // 关掉 MathLive 自带的虚拟键盘 —— 我们右栏已经有符号板了
    el.setAttribute('math-virtual-keyboard-policy', 'manual');
    el.setAttribute('smart-fence', 'off');
    el.setAttribute('aria-label', '公式输入');
    el.style.cssText =
      'width:100%;min-height:44px;border:none;outline:none;background:transparent;' +
      'font-size:15px;color:inherit;padding:4px 0;';
    hostRef.current.appendChild(el);
    fieldRef.current = el;
    el.focus();
    return () => {
      el.remove();
      fieldRef.current = null;
    };
  }, [mode, mathReady]);

  /** 自动长高（文字模式）。 */
  const resize = useCallback((): void => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    if (mode === 'text') resize();
  }, [mode, text, resize]);

  const submit = useCallback(async (): Promise<void> => {
    if (disabled) return;
    const content = (mode === 'math' ? fieldRef.current?.value ?? '' : text).trim();
    if (!content) return;
    setHint('');
    try {
      await onSubmit(content, mode);
      if (mode === 'math') {
        if (fieldRef.current) fieldRef.current.value = '';
      } else {
        setText('');
        requestAnimationFrame(resize);
      }
      setHint('已记下');
      window.setTimeout(() => setHint(''), 1200);
    } catch (e) {
      // 失败不清空 —— 内容必须留住
      setHint(`没记上：${(e as Error).message}`);
    }
  }, [disabled, mode, text, onSubmit, resize]);

  // 把插入能力暴露给符号键盘
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      insert(latex: string, plainFallback?: string): void {
        // ⚠️ 文字模式下点符号 → **自动切到公式模式**再插入。
        //    因为 LaTeX 放进 textarea 只会变成一串反斜杠，对用户没用；
        //    "点了没反应"比"自动切模式"更让人困惑。
        if (mode === 'text') {
          setMode('math');
          // 等 math-field 挂载后（下一帧）再插
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const el = fieldRef.current;
              if (el) {
                el.insert(latex);
                el.focus();
              }
            });
          });
          return;
        }
        const el = fieldRef.current;
        if (el) {
          el.insert(latex);
          el.focus();
          return;
        }
        // 公式模式还没就绪：先把文字塞进 textarea，至少不丢
        setText((v) => v + (plainFallback ?? latex));
      },
      focus(): void {
        if (mode === 'math' && fieldRef.current) fieldRef.current.focus();
        else textareaRef.current?.focus();
      },
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, mode]);

  return (
    <div className="lec-composer">
      {/* 模式切换：默认文字，需要公式时点「公式」 */}
      <div className="lec-composer-tabs">
        <button
          type="button"
          className="lec-composer-tab"
          data-active={mode === 'text' ? '1' : '0'}
          onClick={() => setMode('text')}
          title="普通文字：空格、换行、中文都正常"
        >
          文字
        </button>
        <button
          type="button"
          className="lec-composer-tab"
          data-active={mode === 'math' ? '1' : '0'}
          onClick={() => setMode('math')}
          title="公式：积分上下限、矢量箭头、分式……"
        >
          公式
        </button>
        <span className="lec-composer-modelabel">
          {mode === 'text' ? '记事模式' : mathFailed ? '公式编辑器不可用' : '公式模式'}
        </span>
      </div>

      <div className="lec-composer-field">
        {/* 文字模式：普通 textarea —— 空格/多行/中文全都正常 */}
        {mode === 'text' ? (
          <textarea
            ref={textareaRef}
            className="lec-composer-input"
            rows={2}
            placeholder="在这里记 —— 写下你听到的内容，Enter 记下，Shift+Enter 换行"
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        ) : null}

        {/* 公式模式：MathLive */}
        {mode === 'math' ? (
          <>
            <div ref={hostRef} className="lec-mathhost" data-ready={mathReady ? '1' : '0'} />
            {!mathReady && !mathFailed ? (
              <div className="lec-composer-loading">公式编辑器载入中…</div>
            ) : null}
            {mathFailed ? (
              <div className="lec-composer-loading">
                公式编辑器加载失败（可能是网络问题）。用「文字」模式照常记笔记。
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="lec-composer-row">
        <span className="lec-composer-hint" data-tone={hint.startsWith('没记上') ? 'err' : 'ok'}>
          {hint}
        </span>
        <button
          type="button"
          className="lec-composer-send"
          onClick={() => void submit()}
          disabled={disabled || (mode === 'text' && !text.trim())}
        >
          {disabled ? '记录中…' : '记下'}
        </button>
      </div>
    </div>
  );
}
