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

const STEP_LABEL: Record<string, string> = {
  recall: '第 1 步 · 你先说',
  compare: '第 2 步 · 对照',
  repair: '第 3 步 · 定点补漏',
  candidates: '第 4 步 · 候选条目',
  commit: '第 5 步 · 确认写入',
  done: '已完成',
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
      setErr('请先写下你记得的内容（这一步不看任何资料）。');
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
      setErr(r?.error ?? '提交失败');
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
      setErr(r?.error ?? '生成候选失败');
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
        setErr('候选条目解析失败');
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
      setErr(r?.error ?? '写入失败');
      return;
    }
    setHandoff({ files: r.handoff_files ?? [], dir: r.handoff_dir ?? '' });
    setStep('done');
    await onFinished();
  };

  return (
    <div className="lec-review">
      <span className="lec-step" data-step={step}>
        {STEP_LABEL[step] ?? step}
      </span>
      <p className="lec-label">{unitTitle} · 课后复盘</p>

      {err ? <div className="lec-warn">{err}</div> : null}

      {/* —— 第 1 步：你先说（不给任何提示）—— */}
      {step === 'recall' ? (
        <div>
          <div className="lec-notice">
            <b>凭记忆说</b>：这节课你记得什么？想到多少说多少，不用完整。
            <br />
            <span className="lec-hint">
              不要查看上面的速记——这一步的意义就在于先调用你自己的记忆。
            </span>
          </div>
          <textarea
            className="lec-input"
            style={{ minHeight: 160 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="我记得这节课讲了…"
          />
          <div className="lec-actions">
            <button type="button" className="lec-btn" disabled={busy} onClick={() => void submitRecall()}>
              {busy ? '对照中…' : '说完了，对照一下'}
            </button>
          </div>
        </div>
      ) : null}

      {/* —— 第 2 步：对照（三栏）—— */}
      {step === 'compare' ? (
        <div>
          <ComparisonGrid comparison={state?.comparison ?? null} />
          <div className="lec-notice">接下来做定点补漏：只针对「漏了 / 记错」的点，我先不告诉你答案。</div>
          <div className="lec-actions">
            <button type="button" className="lec-btn" disabled={busy} onClick={() => void nextFromRepair()}>
              开始补漏
            </button>
          </div>
        </div>
      ) : null}

      {/* —— 第 3 步：定点补漏（苏格拉底式）—— */}
      {step === 'repair' ? (
        <div>
          <div className="lec-notice">
            我会针对你漏掉/记错的点提问，<b>先自己回答</b>。答不上来也没关系，说"不知道"我再给最小提示。
          </div>
          {question ? (
            <div className="lec-card">
              <b>问题</b>
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
            placeholder="你的回答…"
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
              {busy ? '思考中…' : '回答'}
            </button>
            <button type="button" className="lec-btn" data-variant="ghost" disabled={busy} onClick={() => void nextFromRepair()}>
              补漏够了，生成候选条目
            </button>
          </div>
        </div>
      ) : null}

      {/* —— 第 4/5 步：候选条目 + 逐条确认 —— */}
      {step === 'commit' || step === 'candidates' ? (
        <div>
          <div className="lec-notice">
            复盘完成，已生成候选条目。<b>逐条确认</b>——取消勾选的不会写入。
          </div>
          {candidates ? (
            <>
              <CandidatesBlock
                title="知识条目（→ Worldbook）"
                items={candidates.worldbook_entries.map((e, i) => ({ key: `w${i}`, text: `${e.title}：${e.content}` }))}
                checked={checked}
                onToggle={(k, v) => setChecked((c) => ({ ...c, [k]: v }))}
              />
              <CandidatesBlock
                title="学习状态断言"
                items={candidates.entity_claims.map((e, i) => ({ key: `c${i}`, text: `${e.attribute} = ${e.value}` }))}
                checked={checked}
                onToggle={(k, v) => setChecked((c) => ({ ...c, [k]: v }))}
              />
              <CandidatesBlock title="仍未解决" items={candidates.unresolved_questions.map((q, i) => ({ key: `q${i}`, text: q }))} checked={{}} onToggle={() => undefined} readOnly />
              <CandidatesBlock title="学习洞察" items={candidates.insights.map((q, i) => ({ key: `i${i}`, text: q }))} checked={{}} onToggle={() => undefined} readOnly />
            </>
          ) : (
            <div className="lec-hint">候选条目为空（可能 LLM 不可用）。</div>
          )}
          <div className="lec-actions">
            <button type="button" className="lec-btn" disabled={busy} onClick={() => void doCommit()}>
              {busy ? '写入中…' : '确认写入'}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="lec-ok">
          <div>复盘完成 ✓ 这一讲的知识条目与短板已记录。</div>

          {/* ⚠️ 必须说清"记到哪了"。早先这里只写"已记录"，
              用户以为已经同步进主记忆（"前端说写入主agent了，但是肯定没有"）。
              实际上：只落在**本机文件**，还要把文件搬到主 agent 那台机器上导入。 */}
          <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.7, opacity: 0.85 }}>
            {handoff.files.length ? (
              <>
                <div>
                  <b>已导出握手包</b>（供主 agent 导入）：
                </div>
                {handoff.files.map((f) => (
                  <div key={f} style={{ marginLeft: 10, wordBreak: 'break-all' }}>
                    <code>{f}</code>
                  </div>
                ))}
                <div style={{ marginTop: 6 }}>
                  <b>下一步</b>：把上面的文件复制到主 agent 那台机器，然后对它说
                  「导入讲义进度」即可（会自动过守门员再写入主记忆）。
                </div>
                <div style={{ marginTop: 4, opacity: 0.8 }}>
                  注意：这一步**不会自动发生** —— 课堂机与主 agent 常常不在同一台设备上。
                </div>
                <button
                  type="button"
                  className="lec-btn"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    void navigator.clipboard?.writeText(handoff.files.join('\n'));
                  }}
                >
                  复制文件路径
                </button>
              </>
            ) : (
              <div>
                未生成握手包（导出可能失败，见日志）。知识条目已存本机，
                可在主 agent 侧用 <code>lecture_export_handoff</code> 重试。
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ComparisonGrid({ comparison }: { comparison: Comparison | null }): JSX.Element {
  const cols: Array<{ kind: string; title: string; items: string[] }> = [
    { kind: 'remembered', title: '我记住了', items: comparison?.remembered ?? [] },
    { kind: 'missed', title: '我漏了', items: comparison?.missed ?? [] },
    { kind: 'wrong', title: '我记错了 / 模糊', items: comparison?.wrong_or_vague ?? [] },
  ];
  return (
    <div className="lec-col3">
      {cols.map((c) => (
        <div key={c.kind} className="lec-col" data-kind={c.kind}>
          <h4>
            {c.title}（{c.items.length}）
          </h4>
          {c.items.length ? (
            <ul>
              {c.items.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          ) : (
            <span className="lec-hint">（无）</span>
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
