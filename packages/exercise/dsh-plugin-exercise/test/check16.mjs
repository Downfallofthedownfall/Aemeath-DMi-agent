// ============================================================
// test/check16.mjs — 长耗时 LLM 调用期间的并发写入 / 错题 id / 重新分块保留作答
//
// 真插件 apply + 假 ctx + 假 fetch（LLM 走直连兜底，请求挂起直到测试放行）。
// 守护的都是"会丢用户数据"的坑：
//   1. 检查要跑一两分钟，期间自动保存的答案不能被检查开头读的旧 sheet 冲掉
//   2. 两题同时检查，后完成的不能把先完成的结果抹掉
//   3. 答辩同理
//   4. 失败的检查（verdict=error）不能盖住上一次真正的批改
//   5. 删过错题后新错题不能撞 id、把别的题的错题记录改写掉
//   6. 重新分块要带回附图/答辩，只有照片没打字的题也一样
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { ExerciseStore } from '../lib/store.js';
import { mistakeIdAt, nextMistakeId, problemStatus } from '../lib/types.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ── 假 LLM：每个请求挂起，由测试决定什么时候、返回什么 ──
const pending = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (_url, init) =>
  new Promise((resolve) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    pending.push({ prompt: String(body.messages?.[0]?.content ?? ''), resolve });
  });
const reply = (content) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
/** 等到至少 n 个 LLM 请求挂起。 */
const waitPending = async (n = 1) => {
  for (let i = 0; i < 500 && pending.length < n; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(pending.length >= n, `等不到 ${n} 个 LLM 请求（现有 ${pending.length}）`);
};
/** 放行挂起的请求里 prompt 含 `needle` 的那一个。 */
const release = (needle, content) => {
  const i = pending.findIndex((p) => p.prompt.includes(needle));
  assert.ok(i >= 0, `没有含「${needle}」的挂起请求`);
  const [p] = pending.splice(i, 1);
  p.resolve(reply(content));
};
const WRONG = JSON.stringify({ verdict: 'wrong', score: 0, issues: [{ severity: 'error', text: '符号错了' }], hints: [], next_steps: [] });

function makeCtx() {
  const tools = new Map();
  return {
    tools,
    ctx: {
      on: () => () => {},
      tools: { register: (def) => (tools.set(def.name, def), () => {}) },
      credentials: { resolve: async () => ({ value: '' }) },
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'exercise-test16-'));
delete process.env.EXERCISE_DATA_DIR;
const C = 'physik-1';

try {
  const a = makeCtx();
  await apply(a.ctx, { dataDir: tmp, llm: { apiKey: 'test-key' }, autoCollectMistakes: true });
  const store = new ExerciseStore({ rootDir: tmp });
  const call = (name, args) => a.tools.get(name).execute(args, { agent: { session: { id: 's1' } } });

  const created = await call('exercise_new_sheet', { course_id: C, title: 'Mechanik' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const S = created.data.sheet_id;

  // 种三道题（工具层没有"加题"，直接写 sheet）
  const seed = store.readSheet(C, S);
  const blank = (id, label, text) => ({
    id, label, title: label, text, points: null, page: 0, has_figure: false, figure_note: '',
    answer: '', answer_updated_at: 0, answer_edited_by: 'user',
    checks: [], rebuttals: [], images: [], mistakes: [], notes: '',
  });
  seed.problems = [
    blank('p01', 'Aufgabe 1', 'Berechnen Sie die Kraft F_EINS.'),
    blank('p02', 'Aufgabe 2', 'Zeigen Sie die Energie E_ZWEI.'),
    blank('p03', 'Aufgabe 3', 'Bestimmen Sie den Impuls P_DREI.'),
  ];
  store.writeSheet(C, seed);
  for (const [id, ans] of [['p01', 'F = 1 N'], ['p02', 'E = 2 J'], ['p03', 'p = 3 kg m/s']]) {
    const r = await call('exercise_save_answer', { course_id: C, sheet_id: S, problem_id: id, answer: ans });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const prob = (id) => store.findProblem(store.readSheet(C, S), id);

  await t('检查期间保存的答案不会被冲掉；本题答案改过 → 新检查一落地就是过期的', async () => {
    const checking = call('exercise_check', { course_id: C, sheet_id: S, problem_id: 'p01' });
    await waitPending(1);
    await call('exercise_save_answer', { course_id: C, sheet_id: S, problem_id: 'p02', answer: 'E = 20 J（检查期间改的）' });
    await call('exercise_save_answer', { course_id: C, sheet_id: S, problem_id: 'p01', answer: 'F = 10 N（检查期间改的）' });
    release('F_EINS', WRONG);
    await checking;
    assert.equal(prob('p02').answer, 'E = 20 J（检查期间改的）', '别的题的答案被旧 sheet 冲掉了');
    assert.equal(prob('p01').answer, 'F = 10 N（检查期间改的）', '本题的新答案被旧 sheet 冲掉了');
    assert.equal(prob('p01').checks.length, 1);
    assert.equal(prob('p01').checks[0].stale, true, '针对旧答案的检查应标为过期');
  });

  await t('两题同时检查：两条结果都在（后完成的不抹掉先完成的）', async () => {
    const c2 = call('exercise_check', { course_id: C, sheet_id: S, problem_id: 'p02' });
    const c3 = call('exercise_check', { course_id: C, sheet_id: S, problem_id: 'p03' });
    await waitPending(2);
    release('P_DREI', WRONG);
    await c3;
    release('E_ZWEI', WRONG);
    await c2;
    assert.equal(prob('p02').checks.length, 1, 'p02 的检查丢了');
    assert.equal(prob('p03').checks.length, 1, 'p03 的检查丢了');
    assert.equal(prob('p03').checks[0].verdict, 'wrong');
  });

  await t('答辩期间保存的答案不会被冲掉，撤回记在原检查上', async () => {
    const rebut = call('exercise_rebut', { course_id: C, sheet_id: S, problem_id: 'p03', text: '符号是对的' });
    await waitPending(1);
    await call('exercise_save_answer', { course_id: C, sheet_id: S, problem_id: 'p02', answer: 'E = 200 J（答辩期间改的）' });
    release('P_DREI', JSON.stringify({ outcome: 'upheld', reply: '代入 p=3 不成立', withdrawn: [0], remaining: [], correct_parts: [] }));
    const r = await rebut;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(prob('p02').answer, 'E = 200 J（答辩期间改的）', '答辩把别的题的答案冲掉了');
    const p3 = prob('p03');
    assert.equal(p3.rebuttals.length, 1);
    assert.deepEqual(p3.checks[0].withdrawn, [0]);
  });

  await t('失败的检查不盖住上一次真正的批改（状态 / 答辩目标）', async () => {
    const failing = call('exercise_check', { course_id: C, sheet_id: S, problem_id: 'p03' });
    await waitPending(1);
    release('P_DREI', ''); // 空输出 → 检查失败（verdict=error）
    await failing;
    const p3 = prob('p03');
    assert.equal(p3.checks.at(-1).verdict, 'error');
    assert.equal(problemStatus(p3), 'needs_fix', '失败的检查把「待修改」盖成了「已作答」');

    const rebut = call('exercise_rebut', { course_id: C, sheet_id: S, problem_id: 'p03', text: '再辩一次' });
    await waitPending(1);
    assert.match(pending[0].prompt, /符号错了/, '答辩应针对真正的批改（带着原 issue），而不是那条空的失败检查');
    release('P_DREI', JSON.stringify({ outcome: 'partial', reply: 'ok', withdrawn: [], remaining: [], correct_parts: [] }));
    await rebut;
    const after = prob('p03');
    assert.equal(after.rebuttals.at(-1).check_id, after.checks[0].id);
  });

  await t('删过错题后，新错题不撞 id、不改写别的题的错题', async () => {
    const all = store.readMistakes();
    // p01 的检查过期了（答案改过），p02/p03 是 wrong → 已自动进错题本
    const m2 = all.find((m) => m.problem_id === 'p02');
    const m3 = all.find((m) => m.problem_id === 'p03');
    assert.ok(m2 && m3, `错题本里应有 p02/p03：${JSON.stringify(all.map((m) => m.problem_id))}`);
    assert.ok(store.deleteMistake(m2.id));
    // 让 p01 重新检查成 wrong → 再收一条
    const c1 = call('exercise_check', { course_id: C, sheet_id: S, problem_id: 'p01' });
    await waitPending(1);
    release('F_EINS', WRONG);
    await c1;
    const now = store.readMistakes();
    const ids = now.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `错题 id 重复：${ids.join(',')}`);
    const still3 = now.find((m) => m.id === m3.id);
    assert.equal(still3?.problem_id, 'p03', 'p03 的错题被新错题改写了');
    assert.ok(now.some((m) => m.problem_id === 'p01'), 'p01 的错题没收进来');
  });

  await t('nextMistakeId 跳过已占用的 id', () => {
    const at = new Date(2026, 10, 3, 9).getTime();
    assert.equal(nextMistakeId(at, []), mistakeIdAt(at, 1));
    // 三条里删掉第一条 → 条数+1 = 3，正好撞上还在的第 3 条
    const left = [mistakeIdAt(at, 2), mistakeIdAt(at, 3)];
    const id = nextMistakeId(at, left);
    assert.ok(!left.includes(id), `撞 id：${id}`);
  });

  await t('重新分块带回附图 / 答辩 / 检查，只有照片没打字的题也一样', async () => {
    store.writeSourceText(C, S, 'Aufgabe 1 (3 Punkte)\nBerechnen Sie x.\n\nAufgabe 2 (4 Punkte)\nZeigen Sie y.\n');
    const s = store.readSheet(C, S);
    const p2 = store.findProblem(s, 'p02');
    p2.answer = ''; // 只有照片
    p2.images = [{ id: 'im1', name: 'img-a.png', media_type: 'image/png', bytes: 10, caption: '手写', role: 'answer', created_at: 1 }];
    store.writeSheet(C, s);
    const r = await call('exercise_resplit', { course_id: C, sheet_id: S, use_llm: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = store.readSheet(C, S);
    const a2 = after.problems.find((p) => p.label === 'Aufgabe 2');
    assert.equal(a2.images.length, 1, '附图在重新分块后丢了');
    assert.equal(a2.checks.length, 1, '检查记录丢了');
    const a1 = after.problems.find((p) => p.label === 'Aufgabe 1');
    assert.equal(a1.answer, 'F = 10 N（检查期间改的）');
  });

  assert.equal(pending.length, 0, '还有没放行的 LLM 请求');
  console.log(`\n[exercise-concurrency] ${passed} 项断言通过`);
} finally {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
}
