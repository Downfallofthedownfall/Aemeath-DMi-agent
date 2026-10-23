// ============================================================
// client/mistakes-panel.tsx — 错题本（外观照 lecture 的卡片）
//
// 跨套题汇总；每条带坐标（课/套/题号），点「回到原题」能跳回去。
// "这题教会我什么"一句话是核心字段 —— 它会进 worldbook。
// ============================================================

import { useMemo, useState } from 'react';
import type { MistakeView } from './api.ts';
import { MathText } from './math.tsx';
import { useT } from './i18n.ts';
import { verdictLabel } from './check-panel.tsx';

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
  const t = useT();
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
    onToast(t('exercise.mistakes.lessonSaved'));
  };

  return (
    <div>
      <div className="lec-toolrow" style={{ marginTop: 0, marginBottom: 8 }}>
        <button type="button" className="lec-tab" data-active={onlyOpen ? '1' : '0'} onClick={() => setOnlyOpen(true)}>
          {t('exercise.mistakes.tab.open', { n: openCount })}
        </button>
        <button type="button" className="lec-tab" data-active={onlyOpen ? '0' : '1'} onClick={() => setOnlyOpen(false)}>
          {t('exercise.mistakes.tab.all', { n: mistakes.length })}
        </button>
        <span className="lec-grow" />
        <button
          type="button"
          className="lec-btn lec-btn-ghost"
          disabled={busy || !unsynced}
          title={t('exercise.mistakes.syncTitle')}
          onClick={onSyncWorldbook}
        >
          {unsynced ? t('exercise.mistakes.syncCount', { n: unsynced }) : t('exercise.mistakes.sync')}
        </button>
      </div>

      {!list.length && (
        <div className="lec-empty">{onlyOpen ? t('exercise.mistakes.emptyOpen') : t('exercise.mistakes.empty')}</div>
      )}

      {list.map((m) => (
        <div key={m.id} className="lec-mistake" data-mastered={m.mastered ? '1' : '0'}>
          <div className="lec-problem-head">
            <span className="lec-badge" data-kind={m.mastered ? 'checked' : 'needs_fix'}>
              {verdictLabel(t, m.verdict)}
            </span>
            <span className="lec-mistake-path">
              {m.sheet_title || m.sheet_id} · {m.problem_label || m.problem_id}
            </span>
            {m.in_worldbook && <span className="lec-badge">{t('exercise.mistakes.inWorldbook')}</span>}
            <span className="lec-grow" />
            <span className="lec-mistake-path">{dateOf(m.created_at)}</span>
          </div>

          {m.issues.length > 0 && (
            <ul className="lec-mistake-issues">
              {m.issues.slice(0, 4).map((i, idx) => (
                <li key={idx}>
                  <MathText text={i} compact />
                </li>
              ))}
            </ul>
          )}

          <textarea
            className="lec-mistake-lesson"
            placeholder={t('exercise.mistakes.lessonPlaceholder')}
            value={drafts[m.id] ?? m.lesson}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [m.id]: e.currentTarget.value }))}
            onBlur={() => void saveLesson(m)}
          />

          {m.tags.length > 0 && (
            <div className="lec-toolrow">
              {m.tags.slice(0, 5).map((tag) => (
                <span key={tag} className="lec-badge">
                  {tag}
                </span>
              ))}
            </div>
          )}

          <div className="lec-toolrow">
            <button type="button" className="lec-btn lec-btn-ghost" onClick={() => onJump(m.course_id, m.sheet_id, m.problem_id)}>
              {t('exercise.mistakes.jump')}
            </button>
            <button
              type="button"
              className="lec-btn lec-btn-ghost"
              onClick={() =>
                void onPatch(m.id, { mastered: !m.mastered }).then(() =>
                  onToast(m.mastered ? t('exercise.mistakes.unmasteredToast') : t('exercise.mistakes.masteredToast')),
                )
              }
            >
              {m.mastered ? t('exercise.mistakes.unmaster') : t('exercise.mistakes.master')}
            </button>
            <span className="lec-grow" />
            <button
              type="button"
              className="lec-del"
              title={t('exercise.mistakes.deleteTitle')}
              onClick={() => {
                if (window.confirm(t('exercise.mistakes.deleteConfirm'))) void onDelete(m.id);
              }}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
