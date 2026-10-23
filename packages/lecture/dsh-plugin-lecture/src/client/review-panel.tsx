// ============================================================
// client/review-panel.tsx — 课后复盘五步界面
//
// 步骤（与后端 review.ts 的状态机一致）：
//   1 recall     你先说（**不给任何提示**——这是主动回忆的关键）
//   2 compare    对照：我记住了 / 我漏了 / 我记错了
//   3 repair     定点补漏（苏格拉底式追问，**不直接给答案**）
//   4 candidates 候选条目（**此时才出现结构化摘要**，D4）
//   5 commit     逐条确认写入
//
// ⚠️ D4 边界：第 1 步界面**不得展示任何课堂内容**。
//    本文件刻意不在 recall 阶段渲染 chunks——否则"你先说"就失去意义。
//    第 4 步之前也不请求 summary/candidates。
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { useT } from './i18n.ts';

const API = '/aemeath/api/lecture';

interface Comparison {
  remembered: string[];
  missed: string[];
  wrong_or_vague: string[];
}

interface Candidates {
  worldbook_entries: Array<{ title: string; content: string; topic: string }>;
  entity_claims: Array<{ entity: string; attribute: string; value: string }>;
  unresolved_questions: string[];
  insights: string[];
}

interface ReviewState {
  step: string;
  recall_text?: string;
  comparison?: Comparison | null;
  repair_turns?: Array<{ question: string; answer: string }>;
}

type Step = 'recall' | 'compare' | 'repair' | 'candidates' | 'commit' | 'done';

const STEP_KEY: Record<string, string> = {
  recall: 'lecture.review.step.recall',
  compare: 'lecture.review.step.compare',
  repair: 'lecture.review.step.repair',
  candidates: 'lecture.review.step.candidates',
  commit: 'lecture.review.step.commit',
  done: 'lecture.review.step.done',
};

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

async function postJson<T>(body: unknown): Promise<T | null> {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    return (await res.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

export function ReviewPanel(props: {
  courseId: string;
  unitId: string;
  unitTitle: string;
  onFinished: () => Promise<void>;
}): JSX.Element {
  const t = useT();
  const { courseId, unitId, unitTitle, onFinished } = props;
  const [step, setStep] = useState<Step>('recall');
  const [state, setState] = useState<ReviewState | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [question, setQuestion] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  /**
   * 确认写入后**自动导出**的握手包信息。
   *
   * 为什么要有这个 state：早先第 5 步完成后只说"已记录"，
   * 用户以为**已经同步进主记忆了**（真机原话："前端说写入主agent了，
   * 但是肯定没有，肯定只是在 mac 上面"）。
   * 实际只落在本机文件，必须人把文件搬过去再导入。
   * 现在把路径显示出来，并说清下一步，不再让人误会。
   */
  const [handoff, setHandoff] = useState<{ files: string[]; dir: string }>({ files: [], dir: '' });

  const load = useCallback(async () => {
    const d = await getJson<{ ok: boolean; step?: Step; state?: ReviewState; candidates?: Candidates }>(
      `${API}?action=review&course=${encodeURIComponent(courseId)}&unit=${encodeURIComponent(unitId)}`,
    );
    // 后端 review 状态走 POST（见下），GET 只用于兜底
    if (d?.step) setStep(d.step);
    if (d?.state) setState(d.state);
  }, [courseId, unitId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitRecall = async (): Promise<void> => {
    if (!text.trim()) {
      setErr(t('lecture.review.err.recallEmpty'));
      return;
    }
    setBusy(true);
    setErr('');
    const r = await postJson<{ ok: boolean; error?: string; comparison?: unknown; step?: Step }>({
      action: 'review',
      op: 'recall',
      course_id: courseId,
      unit_id: unitId,
      text,
    });
    setBusy(false);
    if (!r?.ok) {
      setErr(r?.error ?? t('common.submitFailed'));
      return;
    }
    setStep('compare');
    if (r.comparison) {
      try {
        const c = typeof r.comparison === 'string' ? JSON.parse(r.comparison) : r.comparison;
        setState((s) => ({ ...(s ?? { step: 'compare' }), comparison: c as Comparison }));
      } catch {
        /* 解析失败：显示空三栏 */
      }
    }
  };

  const nextFromRepair = async (): Promise<void> => {
    setBusy(true);
    setErr('');
    const r = await postJson<{ ok: boolean; error?: string; candidates?: unknown; step?: Step }>({
      action: 'review',
      op: 'next',
      course_id: courseId,
      unit_id: unitId,
    });
    setBusy(false);
    if (!r?.ok) {
      setErr(r?.error ?? t('lecture.review.err.candidatesFailed'));
      return;
    }
    setStep('commit');
    if (r.candidates) {
      try {
        const c = typeof r.candidates === 'string' ? JSON.parse(r.candidates) : r.candidates;
        setCandidates(c as Candidates);
        // 默认全部勾选（让用户"取消不要的"比"逐个勾"快）
        const init: Record<string, boolean> = {};
        (c as Candidates).worldbook_entries.forEach((_, i) => (init[`w${i}`] = true));
        (c as Candidates).entity_claims.forEach((_, i) => (init[`c${i}`] = true));
        setChecked(init);
      } catch {
        setErr(t('lecture.review.err.parseCandidates'));
      }
    }
  };

  const doCommit = async (): Promise<void> => {
    setBusy(true);
    const r = await postJson<{
      ok: boolean;
      error?: string;
      handoff_files?: string[];
      handoff_dir?: string;
    }>({
      action: 'review',
      op: 'commit',
      course_id: courseId,
      unit_id: unitId,
      confirmed_worldbook: candidates ? candidates.worldbook_entries.filter((_, i) => checked[`w${i}`]).length : 0,
      confirmed_claims: candidates ? candidates.entity_claims.filter((_, i) => checked[`c${i}`]).length : 0,
      accepted: candidates
        ? {
            ...candidates,
            worldbook_entries: candidates.worldbook_entries.filter((_, i) => checked[`w${i}`]),
            entity_claims: candidates.entity_claims.filter((_, i) => checked[`c${i}`]),
          }
        : null,
    });
    setBusy(false);
    if (!r?.ok) {
      setErr(r?.error ?? t('common.writeFailed'));
      return;
    }
    setHandoff({ files: r.handoff_files ?? [], dir: r.handoff_dir ?? '' });
    setStep('done');
    await onFinished();
  };

  return (
    <div className="lec-review">
      <span className="lec-step" data-step={step}>
        {t(STEP_KEY[step] ?? step)}
      </span>
      <p className="lec-label">{unitTitle} · {t('lecture.review.subtitle')}</p>

      {err ? <div className="lec-warn">{err}</div> : null}

      {/* —— 第 1 步：你先说（不给任何提示）—— */}
      {step === 'recall' ? (
        <div>
          <div className="lec-notice">
            <b>{t('lecture.review.recall.strong')}</b>{t('lecture.review.recall.body')}
            <br />
            <span className="lec-hint">
              {t('lecture.review.recall.hint')}
            </span>
          </div>
          <textarea
            className="lec-input"
            style={{ minHeight: 160 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('lecture.review.recall.placeholder')}
          />
          <div className="lec-actions">
            <button type="button" className="lec-btn" disabled={busy} onClick={() => void submitRecall()}>
              {busy ? t('lecture.review.recall.busy') : t('lecture.review.recall.submit')}
            </button>
          </div>
        </div>
      ) : null}

      {/* —— 第 2 步：对照（三栏）—— */}
      {step === 'compare' ? (
        <div>
          <ComparisonGrid comparison={state?.comparison ?? null} />
          <div className="lec-notice">{t('lecture.review.compare.notice')}</div>
          <div className="lec-actions">
            <button type="button" className="lec-btn" disabled={busy} onClick={() => void nextFromRepair()}>
              {t('lecture.review.compare.start')}
            </button>
          </div>
        </div>
      ) : null}

      {/* —— 第 3 步：定点补漏（苏格拉底式）—— */}
      {step === 'repair' ? (
        <div>
          <div className="lec-notice">
            {t('lecture.review.repair.lead')}<b>{t('lecture.review.repair.strong')}</b>{t('lecture.review.repair.tail')}
          </div>
          {question ? (
            <div className="lec-card">
              <b>{t('lecture.review.repair.question')}</b>
              <p className="lec-pre" style={{ marginTop: 6 }}>
                {question}
              </p>
            </div>
          ) : null}
          <textarea
            className="lec-input"
            style={{ minHeight: 100 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('lecture.review.repair.placeholder')}
          />
          <div className="lec-actions">
            <button
              type="button"
              className="lec-btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const r = await postJson<{ ok: boolean; question?: string | null; warning?: string }>({
                  action: 'review',
                  op: 'repair_answer',
                  course_id: courseId,
                  unit_id: unitId,
                  text,
                });
                setBusy(false);
                setText('');
                if (r?.question) setQuestion(r.question);
                else if (r?.warning) setErr(r.warning);
              }}
            >
              {busy ? t('lecture.review.repair.busy') : t('lecture.review.repair.answer')}
            </button>
            <button type="button" className="lec-btn" data-variant="ghost" disabled={busy} onClick={() => void nextFromRepair()}>
              {t('lecture.review.repair.finish')}
            </button>
          </div>
        </div>
      ) : null}

      {/* —— 第 4/5 步：候选条目 + 逐条确认 —— */}
      {step === 'commit' || step === 'candidates' ? (
        <div>
          <div className="lec-notice">
            {t('lecture.review.commit.noticeLead')}<b>{t('lecture.review.commit.strong')}</b>{t('lecture.review.commit.noticeTail')}
          </div>
          {candidates ? (
            <>
              <CandidatesBlock
                title={t('lecture.review.commit.worldbook')}
                items={candidates.worldbook_entries.map((e, i) => ({ key: `w${i}`, text: `${e.title}：${e.content}` }))}
                checked={checked}
                onToggle={(k, v) => setChecked((c) => ({ ...c, [k]: v }))}
              />
              <CandidatesBlock
                title={t('lecture.review.commit.claims')}
                items={candidates.entity_claims.map((e, i) => ({ key: `c${i}`, text: `${e.attribute} = ${e.value}` }))}
                checked={checked}
                onToggle={(k, v) => setChecked((c) => ({ ...c, [k]: v }))}
              />
              <CandidatesBlock title={t('lecture.review.commit.unresolved')} items={candidates.unresolved_questions.map((q, i) => ({ key: `q${i}`, text: q }))} checked={{}} onToggle={() => undefined} readOnly />
              <CandidatesBlock title={t('lecture.review.commit.insights')} items={candidates.insights.map((q, i) => ({ key: `i${i}`, text: q }))} checked={{}} onToggle={() => undefined} readOnly />
            </>
          ) : (
            <div className="lec-hint">{t('lecture.review.commit.empty')}</div>
          )}
          <div className="lec-actions">
            <button type="button" className="lec-btn" disabled={busy} onClick={() => void doCommit()}>
              {busy ? t('lecture.review.commit.busy') : t('lecture.review.commit.submit')}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="lec-ok">
          <div>{t('lecture.review.done.summary')}</div>

          {/* ⚠️ 必须说清"记到哪了"。早先这里只写"已记录"，
              用户以为已经同步进主记忆（"前端说写入主agent了，但是肯定没有"）。
              实际上：只落在**本机文件**，还要把文件搬到主 agent 那台机器上导入。 */}
          <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.7, opacity: 0.85 }}>
            {handoff.files.length ? (
              <>
                <div>
                  <b>{t('lecture.review.done.handoffStrong')}</b>{t('lecture.review.done.handoffFor')}
                </div>
                {handoff.files.map((f) => (
                  <div key={f} style={{ marginLeft: 10, wordBreak: 'break-all' }}>
                    <code>{f}</code>
                  </div>
                ))}
                <div style={{ marginTop: 6 }}>
                  <b>{t('lecture.review.done.nextStrong')}</b>{t('lecture.review.done.nextBody')}
                </div>
                <div style={{ marginTop: 4, opacity: 0.8 }}>
                  {t('lecture.review.done.noteLead')}<b>{t('lecture.review.done.noteStrong')}</b>{t('lecture.review.done.noteTail')}
                </div>
                <button
                  type="button"
                  className="lec-btn"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    void navigator.clipboard?.writeText(handoff.files.join('\n'));
                  }}
                >
                  {t('lecture.review.done.copyPaths')}
                </button>
              </>
            ) : (
              <div>
                {t('lecture.review.done.noHandoffLead')}<code>lecture_export_handoff</code>{t('lecture.review.done.noHandoffTail')}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ComparisonGrid({ comparison }: { comparison: Comparison | null }): JSX.Element {
  const t = useT();
  const cols: Array<{ kind: string; title: string; items: string[] }> = [
    { kind: 'remembered', title: t('lecture.review.compare.remembered'), items: comparison?.remembered ?? [] },
    { kind: 'missed', title: t('lecture.review.compare.missed'), items: comparison?.missed ?? [] },
    { kind: 'wrong', title: t('lecture.review.compare.wrong'), items: comparison?.wrong_or_vague ?? [] },
  ];
  return (
    <div className="lec-col3">
      {cols.map((c) => (
        <div key={c.kind} className="lec-col" data-kind={c.kind}>
          <h4>
            {c.title}{t('lecture.review.compare.count', { n: c.items.length })}
          </h4>
          {c.items.length ? (
            <ul>
              {c.items.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          ) : (
            <span className="lec-hint">{t('common.none')}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function CandidatesBlock(props: {
  title: string;
  items: Array<{ key: string; text: string }>;
  checked: Record<string, boolean>;
  onToggle: (key: string, v: boolean) => void;
  readOnly?: boolean;
}): JSX.Element | null {
  const { title, items, checked, onToggle, readOnly } = props;
  if (!items.length) return null;
  return (
    <div className="lec-card">
      <div className="lec-meta">
        <span className="lec-unit-title">{title}</span>
      </div>
      {items.map((it) => (
        <label key={it.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.7, marginTop: 4 }}>
          {readOnly ? null : (
            <input type="checkbox" checked={checked[it.key] ?? false} onChange={(e) => onToggle(it.key, e.target.checked)} style={{ marginTop: 4 }} />
          )}
          <span>{it.text}</span>
        </label>
      ))}
    </div>
  );
}
