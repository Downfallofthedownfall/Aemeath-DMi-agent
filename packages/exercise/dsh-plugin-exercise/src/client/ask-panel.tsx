// ============================================================
// client/ask-panel.tsx — 做题时提问（苏格拉底式提示）
//
// 用户 2026-11-20："加入一个前端提问功能，注意不要注入 persona 也不要直接作答，
//   而是根据题目给出苏格拉底式提示"。
//
//   · 后端只回引导（ask.ts 的 prompt 不给答案、不扮角色）
//   · 问答只在前端内存里：刷新 / 换题集就没了，点「清空」也行
//   · Enter 发送，Shift+Enter 换行；输入法组合中不拦截
// ============================================================

import { useEffect, useRef, useState } from 'react';
import type { AskTurnView } from './api.ts';
import { MathText } from './math.tsx';
import { useT } from './i18n.ts';

export interface AskPanelProps {
  turns: AskTurnView[];
  busy: boolean;
  onAsk: (question: string) => Promise<boolean>;
  onClear: () => void;
  onClose: () => void;
}

export function AskPanel({ turns, busy, onAsk, onClear, onClose }: AskPanelProps): JSX.Element {
  const t = useT();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy]);

  const send = async (): Promise<void> => {
    const q = text.trim();
    if (!q || busy) return;
    // 失败时留住问题，方便重发
    if (await onAsk(q)) setText('');
  };

  return (
    <div className="lec-ask">
      <div className="lec-approach-head">
        <span className="lec-ask-title">{t('exercise.ask.heading')}</span>
        <span className="lec-hint" style={{ margin: 0 }}>
          {t('exercise.ask.lead')}
        </span>
        <span className="lec-grow" />
        {turns.length ? (
          <button type="button" className="lec-linkbtn" onClick={onClear} disabled={busy}>
            {t('exercise.ask.clear')}
          </button>
        ) : null}
        <button type="button" className="lec-linkbtn" onClick={onClose} title={t('exercise.ask.closeTitle')}>
          {t('exercise.common.collapse')}
        </button>
      </div>

      {turns.length || busy ? (
        <div className="lec-ask-list" ref={listRef}>
          {turns.map((turn, i) => (
            <div key={i} className="lec-ask-turn">
              <div className="lec-ask-q">{turn.question}</div>
              <div className="lec-ask-a">
                {turn.reply ? <MathText text={turn.reply} compact /> : null}
                {turn.questions.length ? (
                  <ul className="lec-ask-guides">
                    {turn.questions.map((g, j) => (
                      <li key={j}>
                        <MathText text={g} compact />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ))}
          {busy ? <div className="lec-hint">{t('exercise.ask.busy')}</div> : null}
        </div>
      ) : null}

      <div className="lec-ask-row">
        <textarea
          ref={inputRef}
          className="lec-textarea lec-ask-input"
          rows={2}
          value={text}
          placeholder={t('exercise.ask.placeholder')}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          spellCheck={false}
        />
        <button type="button" className="lec-btn" onClick={() => void send()} disabled={busy || !text.trim()}>
          {busy ? t('exercise.ask.sending') : t('exercise.ask.send')}
        </button>
      </div>
    </div>
  );
}
