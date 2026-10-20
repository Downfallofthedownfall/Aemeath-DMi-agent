// ============================================================
// client/mistakes-panel.tsx — 错题本
//
// 为什么错题本独立于题集：
//   复习时想的是"我在哪些地方反复栽"（按主题/时间），而不是"那是第几套题"。
//   所以这里是**跨套题**的列表，每条带坐标（课/套/题号），点一下能跳回原题。
//
// "教训"一句话是错题本的核心字段：
//   · 它是被写进 worldbook 的内容（见 worldbook.ts 的 mistakeToEntry）
//   · 它由用户写（或用户口述让 agent 记），不由模型自动生成
//     —— 模型生成的"教训"往往是空话，写进知识库只会污染召回
// ============================================================

import { useMemo, useState } from 'react';
import type { MistakeView } from './api.ts';
import { MathText } from './math.tsx';

const VERDICT_LABEL: Record<string, string> = {
  correct: '正确',
  partial: '部分正确',
  wrong: '有错',
  unclear: '无法判定',
  error: '检查失败',
};

function dateOf(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface MistakesPanelProps {
  mistakes: MistakeView[];
  onPatch: (id: string, patch: { lesson?: string; mastered?: boolean; tags?: string[] }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onJump: (courseId: string, sheetId: string, problemId: string) => void;
  onSyncWorldbook: () => void;
  onToast: (msg: string) => void;
  busy: boolean;
}

export function MistakesPanel({
  mistakes,
  onPatch,
  onDelete,
  onJump,
  onSyncWorldbook,
  onToast,
  busy,
}: MistakesPanelProps): JSX.Element {
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const list = useMemo(() => {
    const base = onlyOpen ? mistakes.filter((m) => !m.mastered) : mistakes;
    return [...base].sort((a, b) => Number(a.mastered) - Number(b.mastered) || b.updated_at - a.updated_at);
  }, [mistakes, onlyOpen]);

  const openCount = mistakes.filter((m) => !m.mastered).length;
  const unsynced = mistakes.filter((m) => !m.in_worldbook && (m.lesson || m.issues.length)).length;

  const saveLesson = async (m: MistakeView): Promise<void> => {
    const text = drafts[m.id] ?? m.lesson;
    if (text === m.lesson) return;
    await onPatch(m.id, { lesson: text });
    onToast('教训已保存');
  };

  return (
    <div>
      <div className="ex-answer-tools" style={{ marginTop: 0, marginBottom: 8 }}>
        <button type="button" className={`ex-btn ex-btn-sm ${onlyOpen ? 'ex-btn-primary' : ''}`} onClick={() => setOnlyOpen(true)}>
          未掌握 {openCount}
        </button>
        <button type="button" className={`ex-btn ex-btn-sm ${onlyOpen ? '' : 'ex-btn-primary'}`} onClick={() => setOnlyOpen(false)}>
          全部 {mistakes.length}
        </button>
        <span className="ex-spacer" />
        <button
          type="button"
          className="ex-btn ex-btn-sm"
          disabled={busy || !unsynced}
          title="把未同步的教训写进 worldbook（物理馆，热重载生效）"
          onClick={onSyncWorldbook}
        >
          同步 worldbook{unsynced ? `（${unsynced}）` : ''}
        </button>
      </div>

      {!list.length && (
        <div className="ex-empty">
          {onlyOpen ? '没有未掌握的错题 —— 检查判错时会自动收进来' : '错题本还是空的'}
        </div>
      )}

      {list.map((m) => (
        <div key={m.id} className={m.mastered ? 'ex-mistake mastered' : 'ex-mistake'}>
          <div className="ex-mistake-head">
            <span className={`ex-verdict ${m.verdict}`}>{VERDICT_LABEL[m.verdict] ?? m.verdict}</span>
            <span className="ex-mistake-path">
              {m.course_title || m.course_id} · {m.sheet_title || m.sheet_id} · {m.problem_label || m.problem_id}
            </span>
            {m.in_worldbook && <span className="ex-chip accent">已进知识库</span>}
            {m.mastered && <span className="ex-chip checked">已掌握</span>}
          </div>

          <div className="ex-mistake-path">
            {dateOf(m.created_at)}
            {m.sheet_due ? ` · 截止 ${m.sheet_due}` : ''}
            {m.review_count > 0 ? ` · 复习过 ${m.review_count} 次` : ''}
          </div>

          {m.issues.length > 0 && (
            <ul className="ex-mistake-issues">
              {m.issues.slice(0, 4).map((i, idx) => (
                <li key={idx}>
                  <MathText text={i} compact />
                </li>
              ))}
            </ul>
          )}

          <textarea
            className="ex-mistake-lesson"
            placeholder="这题教会我什么？（一句话就够，会写进知识库）"
            value={drafts[m.id] ?? m.lesson}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [m.id]: e.currentTarget.value }))}
            onBlur={() => void saveLesson(m)}
          />

          <div className="ex-tags">
            {m.tags.slice(0, 5).map((t) => (
              <span key={t} className="ex-chip">
                {t}
              </span>
            ))}
          </div>

          <div className="ex-answer-tools">
            <button type="button" className="ex-btn ex-btn-sm ex-btn-ghost" onClick={() => onJump(m.course_id, m.sheet_id, m.problem_id)}>
              回到原题
            </button>
            <button
              type="button"
              className="ex-btn ex-btn-sm"
              onClick={() => void onPatch(m.id, { mastered: !m.mastered }).then(() => onToast(m.mastered ? '已取消"掌握"' : '标记为已掌握'))}
            >
              {m.mastered ? '标记未掌握' : '我掌握了'}
            </button>
            <span className="ex-spacer" />
            <button
              type="button"
              className="ex-btn ex-btn-sm ex-btn-danger"
              onClick={() => {
                if (window.confirm('从错题本删除这条？（不影响题目与答案）')) void onDelete(m.id);
              }}
            >
              删除
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
