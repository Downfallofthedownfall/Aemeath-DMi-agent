// ============================================================
// TTS 朗读（M5 F6 最小版）——爱弥斯回复朗读
// 注册 conversation.chat.assistant-actions（list 槽，session scope）：
// 每条 assistant 消息的操作区加「朗读」按钮。
// 文本获取：点击时从 DOM 读取按钮所在消息气泡的文本（零数据依赖，
//   不依赖 standard kit 注入——assistant-actions 在 TurnTail 渲染，
//   非标准 session 渲染路径，useSession 可能不注入）。
// 引擎：浏览器 Web Speech API（speechSynthesis），Windows 自带中文语音。
// ============================================================
import { useState } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';

/** 点击时从 DOM 向上找消息气泡文本。 */
function readMessageText(el: HTMLElement): string {
  // 向上找最近的"消息内容"容器：dsh 消息文本块常带 markdown class
  let node: HTMLElement | null = el;
  for (let i = 0; i < 8 && node; i++) {
    node = node.parentElement;
    if (!node) break;
    // 消息文本块：包含较多文字且不含按钮/输入框
    const text = (node.textContent ?? '').trim();
    const hasControls = !!node.querySelector('button, input, textarea');
    if (text.length > 20 && !hasControls && !text.includes('Session log') && !text.includes('上下文注入')) {
      return text;
    }
  }
  // 兜底：取按钮相邻文本
  const siblings = el.parentElement?.textContent ?? '';
  return siblings.trim();
}

/** 朗读按钮（owner 传 messageId；点击时读 DOM 文本）。 */
export function TtsAction(props: { messageId?: string }): JSX.Element | null {
  const { messageId } = props;
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState(false);

  if (error) return null;
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;

  const toggle = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const text = readMessageText(e.currentTarget);
    if (!text) return;
    const utter = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const zh = voices.find((v) => v.lang?.toLowerCase().startsWith('zh'));
    if (zh) utter.voice = zh;
    utter.rate = 1.0;
    utter.pitch = 1.1;
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => {
      setSpeaking(false);
      setError(true);
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    setSpeaking(true);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={speaking ? '停止朗读' : '朗读'}
      title={speaking ? '停止朗读' : '朗读'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 28,
        border: 'none',
        cursor: 'pointer',
        background: 'transparent',
        color: speaking ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)',
      }}
    >
      {speaking ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M2 5.5v3h2.2L8 11.5v-9L4.2 5.5H2z" fill="currentColor" />
          <path d="M10 5c.6.6 1 1.3 1 2s-.4 1.4-1 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M11.5 3.5c1 1.1 1.5 2.2 1.5 3.5s-.5 2.4-1.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

/** 注册：每条 assistant 消息的朗读按钮。 */
export function registerTts(ctx: ClientContext): void {
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.assistant-actions',
        id: 'aemeath-tts',
        order: 100,
      },
      TtsAction as never,
    ),
  );
}
