// ============================================================
// client/math-composer.tsx — 可视化公式输入框（MathLive）
//
// 为什么换掉 textarea（用户原话）：
//   "最好做成 word 的等式输入那种吧"
//   "符号键盘的向量不可以自定义向量字母，也没有积分符号之类的上下左右填充"
//
// 原来点 `∫ 上下限` 只插入一个光秃秃的 `∫`，上下限得自己手打 LaTeX ——
// 上课时根本来不及。现在用 MathLive 做成 **Word 公式编辑器**那样：
//   · 点 ∫ → 输入框里真的出现一个带上下限框的积分
//   · 上下限框可以点进去直接填数字
//   · 回车提交，看到的就是最终样子
//
// 存储：以 **LaTeX 字符串** 落盘（`\\int_{0}^{1} f(x) dx`）。
//   不存 HTML —— 笔记要能被 LLM 读、被二次渲染、跨版本存活。
//   MathLive 负责「可视化编辑 ↔ LaTeX」双向转换。
//
// ⚠️ 加载策略：MathLive 823KB，**懒加载**（第一次真正输入公式时才 import），
//    否则打开课堂就要多等一秒多。绝大多数学员第一眼看到的是空白输入框。
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';

/** MathLive 的 math-field 元素（只写我们用到的部分，避免依赖其类型包）。 */
interface MathFieldElement extends HTMLElement {
  value: string;
  focus(): void;
  /**
   * 在光标处插入 LaTeX 并**解析成结构化节点**。
   *
   * ⚠️ 不是 `executeCommand('insert ...')` —— 那是无效命令，
   *    真机报 `Unknown command "insert \int_{}^{} "`，插入静默失败。
   *    正确 API 是 `insert()`（见 mathlive 类型定义
   *    `insert(s: string, options?: InsertOptions): boolean`）。
   */
  insert(s: string): boolean;
  executeCommand(cmd: string): boolean;
}

/** MathLive 模块加载一次即可（全局注册自定义元素）。 */
let mathlivePromise: Promise<void> | null = null;

/**
 * 懒加载 MathLive。
 *
 * 为什么是动态 import：823KB 不该在打开课堂时同步加载。
 * 失败时**降级成普通 textarea**（见 Composer 的 fallback），
 * 而不是让整个输入框消失 —— 上课时输入框没了比没有公式渲染严重得多。
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
  /** 在光标处插入 LaTeX 片段（符号键盘用）。 */
  insert(latex: string): void;
  focus(): void;
}

export function MathComposer({
  disabled,
  onSubmit,
  apiRef,
}: {
  disabled: boolean;
  onSubmit: (latex: string) => Promise<void>;
  apiRef?: { current: MathComposerApi | null };
}): JSX.Element {
  const [ready, setReady] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [plain, setPlain] = useState('');
  const [hint, setHint] = useState('');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<MathFieldElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 懒加载 MathLive；失败则退回 textarea
  useEffect(() => {
    let alive = true;
    void loadMathLive().then((ok) => {
      if (!alive) return;
      if (ok) setReady(true);
      else setFallback(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 元素就绪后创建 math-field 并接线
  useEffect(() => {
    if (!ready || fallback || !hostRef.current || fieldRef.current) return;
    const el = document.createElement('math-field') as MathFieldElement;
    // 关掉 MathLive 自带的虚拟键盘 —— 我们右栏已经有自己的符号板了，
    // 两套键盘同时冒出来会互相打架、还挡住内容。
    el.setAttribute('math-virtual-keyboard-policy', 'manual');
    el.setAttribute('smart-fence', 'off');
    el.setAttribute('aria-label', '课堂速记输入');
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
  }, [ready, fallback]);

  /** 把 LaTeX 交给父组件（落盘）。失败要把内容还给用户。 */
  const submit = useCallback(async (): Promise<void> => {
    if (disabled) return;
    const latex = (fieldRef.current?.value ?? plain).trim();
    if (!latex) return;
    setHint('');
    try {
      await onSubmit(latex);
      // 清空（提交成功后）
      if (fieldRef.current) {
        fieldRef.current.value = '';
      } else {
        setPlain('');
      }
      setHint('已记下');
      window.setTimeout(() => setHint(''), 1200);
    } catch (e) {
      setHint(`没记上：${(e as Error).message}`);
    }
  }, [disabled, onSubmit, plain]);

  // 暴露插入能力给符号键盘
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      insert(latex: string): void {
        const el = fieldRef.current;
        if (el) {
          // MathLive 的 `insert()` 会把 LaTeX **解析成结构化节点** ——
          // 所以 `\int_{}^{}` 进去就变成**看得见上下限框的积分**。
          //
          // ⚠️ 必须用 insert()，不能用 executeCommand('insert …')
          //    后者报 `Unknown command`，插入静默失败（真机踩过）。
          el.insert(latex);
          el.focus();
          return;
        }
        // 降级模式：拼到 textarea 末尾
        setPlain((v) => v + latex);
        textareaRef.current?.focus();
      },
      focus(): void {
        if (fieldRef.current) fieldRef.current.focus();
        else textareaRef.current?.focus();
      },
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef]);

  return (
    <div className="lec-composer">
      <div className="lec-composer-field">
        {/* MathLive 挂载点（就绪前是空的） */}
        <div ref={hostRef} className="lec-mathhost" data-ready={ready ? '1' : '0'} />

        {/* 降级：MathLive 不可用时用普通 textarea，至少还能记 */}
        {fallback ? (
          <textarea
            ref={textareaRef}
            className="lec-composer-input"
            rows={2}
            placeholder="在这里记（公式请用 LaTeX，如 \\int_{0}^{1} f(x) dx）"
            value={plain}
            disabled={disabled}
            onChange={(e) => setPlain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        ) : null}

        {!ready && !fallback ? (
          <div className="lec-composer-loading">公式编辑器载入中…</div>
        ) : null}
      </div>

      <div className="lec-composer-row">
        <span className="lec-composer-hint" data-tone={hint.startsWith('没记上') ? 'err' : 'ok'}>
          {hint}
        </span>
        <button
          type="button"
          className="lec-composer-send"
          // MathLive 里 Enter 默认换行/提交由它自己管，这里给一个明确的按钮
          onClick={() => void submit()}
          disabled={disabled}
        >
          {disabled ? '记录中…' : '记下'}
        </button>
      </div>
    </div>
  );
}
