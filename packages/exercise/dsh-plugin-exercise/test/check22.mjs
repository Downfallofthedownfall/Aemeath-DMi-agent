// ============================================================
// test/check22.mjs — 2026-11-27 review 修掉的几处（重新分块 / 删题 / 错题复发 / 跨进程写 sheet）
//
//   1. 重新分块：题号对不上的旧题（有作答）早先被新题列表直接盖掉 → 现在原样留在末尾，错题跟着走
//   2. 删题：错题本里指向它的错题和题号脱钩（`p03-deleted-…`），新题不会"出生就在错题本"；
//      老数据里还指着空题号的错题，「加一题」也不复用那个题号
//   3. 已掌握（含答辩认错自动标的）的错题再判错 → 回到未掌握，答辩自动写的教训清掉
//   4. sheet.json 的读-改-写跨进程加锁（store.updateSheet）：两个进程同时改同一套题，谁也不丢
//   5. 经验 id 同一毫秒也不撞
// ============================================================
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { apply } from '../lib/index.js';
import { ExerciseStore } from '../lib/store.js';
import { nextMistakeId } from '../lib/types.js';

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
  new Promise((resolveFetch) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    pending.push({ prompt: String(body.messages?.[0]?.content ?? ''), resolve: resolveFetch });
  });
const reply = (content) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const waitPending = async (n = 1) => {
  for (let i = 0; i < 500 && pending.length < n; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(pending.length >= n, `等不到 ${n} 个 LLM 请求（现有 ${pending.length}）`);
};
const releaseAll = (content) => {
  for (const p of pending.splice(0)) p.resolve(reply(content));
};
const WRONG = JSON.stringify({ verdict: 'wrong', score: 0, issues: [{ severity: 'error', text: '又错了' }], hints: [], next_steps: [] });

const tmp = mkdtempSync(join(tmpdir(), 'exercise-test22-'));
delete process.env.EXERCISE_DATA_DIR;
const C = 'physik-1';

const tools = new Map();
const routes = new Map();
const services = { webServer: { register: (r) => (routes.set(r.path, r.handler), () => {}) }, connection: { requestRejection: () => undefined } };
const post = (body) =>
  new Promise((done) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.url = '/aemeath/api/exercise';
    req.headers = {};
    const res = {
      status: 0,
      body: '',
      writeHead(code) {
        this.status = code;
        return this;
      },
      setHeader() {},
      write(c) {
        this.body += c;
        return true;
      },
      end(c) {
        if (c !== undefined) this.body += c;
        done({ status: this.status, data: JSON.parse(this.body || '{}') });
        return this;
      },
    };
    routes.get('/aemeath/api/exercise')(req, res);
  });

const blank = (id, label, text, over = {}) => ({
  id, label, title: label, text, points: null, page: 0, has_figure: false, figure_note: '',
  answer: '', answer_updated_at: 0, answer_edited_by: 'user',
  checks: [], rebuttals: [], images: [], mistakes: [], notes: '', group: '', part: '',
  ...over,
});

/** 给某题挂一条错题（错题本 + 题目上的引用）。 */
const seedMistake = (store, S, problemId, over = {}) => {
  const at = Date.now();
  const m = store.upsertMistakeFor({ courseId: C, sheetId: S, problemId }, (existing, taken) => ({
    id: existing?.id ?? nextMistakeId(at, taken),
    course_id: C,
    course_title: 'Physik I',
    sheet_id: S,
    sheet_title: 'Übungsblatt 1',
    sheet_due: '',
    problem_id: problemId,
    problem_label: problemId,
    problem_text: '',
    answer: '',
    verdict: 'wrong',
    issues: ['符号错了'],
    tags: [],
    lesson: '',
    created_at: at,
    updated_at: at,
    review_count: 0,
    mastered: false,
    in_worldbook: false,
    source_check_id: '',
    ...over,
  }));
  store.updateSheet(C, S, (s) => {
    store.findProblem(s, problemId).mistakes = [m.id];
  });
  return m;
};

/** 跑一个子进程（ESM 代码串）；非 0 退出 → reject 带 stderr。 */
const child = (code) =>
  new Promise((ok, fail) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (c) => (c === 0 ? ok() : fail(new Error(`子进程退出 ${c}：${err}`))));
  });

try {
  await apply(
    {
      on: () => () => {},
      effect: () => {},
      tools: { register: (def) => (tools.set(def.name, def), () => {}) },
      credentials: { resolve: async () => ({ value: '' }) },
      reflect: { get: (n) => services[n] },
    },
    { dataDir: tmp, llm: { apiKey: 'test-key' }, autoCollectMistakes: true },
  );
  const store = new ExerciseStore({ rootDir: tmp });
  const call = (name, args) => tools.get(name).execute(args, { agent: { session: { id: 's1' } } });
  const created = await call('exercise_new_sheet', { course_id: C, title: 'Mechanik' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const S = created.data.sheet_id;
  const sheet = () => store.readSheet(C, S);
  const mistake = (id) => store.readMistakes().find((m) => m.id === id);

  // ───────────── 1. 重新分块：对不上题号的旧题不丢 ─────────────
  await t('重新分块：题号对不上的旧题（有作答）原样留在末尾，错题跟着它走，结果里说明', async () => {
    store.updateSheet(C, S, (s) => {
      s.problems = [
        blank('p01', 'Aufgabe 1', 'Berechnen Sie x.'),
        blank('p02', 'Aufgabe 3', 'Bestimmen Sie z.', { answer: 'z = 3（只有这里写了）', notes: '别丢' }),
      ];
    });
    const m = seedMistake(store, S, 'p02');
    // 原卷改过 / 模型换了写法：这次只认出 Aufgabe 1、Aufgabe 2
    store.writeSourceText(C, S, 'Aufgabe 1 (3 Punkte)\nBerechnen Sie x.\n\nAufgabe 2 (4 Punkte)\nZeigen Sie y.\n');
    const r = await post({ action: 'resplit', course_id: C, sheet_id: S, use_llm: false });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const after = sheet();
    assert.deepEqual(after.problems.map((p) => [p.id, p.label]), [
      ['p01', 'Aufgabe 1'],
      ['p02', 'Aufgabe 2'],
      ['p03', 'Aufgabe 3'],
    ]);
    const kept = after.problems[2];
    assert.equal(kept.answer, 'z = 3（只有这里写了）', '旧题的作答被盖掉了');
    assert.equal(kept.notes, '别丢');
    assert.deepEqual(kept.mistakes, [m.id]);
    assert.equal(mistake(m.id).problem_id, 'p03', '错题还指着旧题号 p02（现在是另一道题）');
    assert.equal(store.findMistakeFor(C, S, 'p02'), null, '新的 Aufgabe 2 不该"已在错题本"');
    assert.match(r.data.note ?? '', /Aufgabe 3/);
  });

  // ───────────── 2. 删题：错题和题号脱钩 ─────────────
  await t('删题：错题留着但和题号脱钩；再「加一题」拿到同一个题号也不会接手它', async () => {
    const before = sheet().problems.find((p) => p.label === 'Aufgabe 3');
    const m = store.readMistakes().find((x) => x.problem_id === before.id);
    const del = await post({ action: 'delete_problem', course_id: C, sheet_id: S, problem_id: before.id });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    const detached = mistake(m.id);
    assert.ok(detached, '错题本里的记录不该跟着删（错题本是自包含快照）');
    assert.match(detached.problem_id, /^p03-deleted-/);
    const added = await post({ action: 'add_problem', course_id: C, sheet_id: S, text: 'Neue Aufgabe' });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    const fresh = added.data.sheet.problems.at(-1);
    assert.equal(fresh.id, 'p03');
    assert.equal(store.findMistakeFor(C, S, 'p03'), null, '新题一出生就"已在错题本"');
  });

  await t('加一题：老数据里还指着空题号的错题，那个题号不复用', async () => {
    // 模拟旧版本删题留下的孤儿：错题指着 p04，而 p04 这道题已经不存在
    seedMistake(store, S, 'p03');
    const orphan = store.readMistakes().find((x) => x.problem_id === 'p03');
    store.patchMistake(orphan.id, { problem_id: 'p04' });
    const added = await post({ action: 'add_problem', course_id: C, sheet_id: S, text: 'Noch eine' });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    assert.equal(added.data.sheet.problems.at(-1).id, 'p05');
  });

  // ───────────── 3. 已掌握的错题再判错 ─────────────
  await t('答辩认错标了"已掌握"的错题，再判错 → 回到未掌握，自动写的那句教训清掉', async () => {
    const save = await call('exercise_save_answer', { course_id: C, sheet_id: S, problem_id: 'p01', answer: 'x = 5' });
    assert.equal(save.ok, true, JSON.stringify(save));
    const m = seedMistake(store, S, 'p01', {
      mastered: true,
      lesson: '答辩后确认：原批改有误，答案本身是对的',
    });
    const checking = call('exercise_check', { course_id: C, sheet_id: S, problem_id: 'p01' });
    await waitPending(1);
    releaseAll(WRONG);
    const r = await checking;
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = mistake(m.id);
    assert.equal(after.mastered, false, '又错了还挂着"已掌握"');
    assert.equal(after.lesson, '', '"原批改有误"和新的 wrong 结论矛盾');
    assert.deepEqual(after.issues, ['又错了']);
    // 用户自己写的教训不动
    store.patchMistake(m.id, { mastered: true, lesson: '先画受力图' });
    const again = call('exercise_check', { course_id: C, sheet_id: S, problem_id: 'p01' });
    await waitPending(1);
    releaseAll(WRONG);
    await again;
    assert.equal(mistake(m.id).mastered, false);
    assert.equal(mistake(m.id).lesson, '先画受力图');
  });

  // ───────────── 4. 跨进程写同一套题 ─────────────
  await t('两个进程同时改同一套题的不同题（各 25 次读-改-写）：一次都不丢', async () => {
    const storeUrl = pathToFileURL(resolve('lib/store.js')).href;
    const go = join(tmp, 'race.go');
    const code = (pid) => `
      import { existsSync } from 'node:fs';
      import { ExerciseStore } from ${JSON.stringify(storeUrl)};
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      for (let i = 0; i < 2500 && !existsSync(${JSON.stringify(go)}); i++) sleep(2);
      const store = new ExerciseStore({ rootDir: ${JSON.stringify(tmp)} });
      for (let k = 0; k < 25; k++) {
        const r = store.updateSheet(${JSON.stringify(C)}, ${JSON.stringify(S)}, (s) => {
          const p = store.findProblem(s, ${JSON.stringify(pid)});
          sleep(2); // 拉长读-改-写的窗口
          p.notes += '${pid}:' + k + ';';
        });
        if (!r) throw new Error('sheet missing');
      }`;
    store.updateSheet(C, S, (s) => {
      store.findProblem(s, 'p01').notes = '';
      store.findProblem(s, 'p02').notes = '';
    });
    const runs = [child(code('p01')), child(code('p02'))];
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(go, '1');
    await Promise.all(runs);
    const s = sheet();
    const count = (id) => store.findProblem(s, id).notes.split(';').filter(Boolean).length;
    assert.equal(count('p01'), 25, `p01 丢了更新：${store.findProblem(s, 'p01').notes}`);
    assert.equal(count('p02'), 25, `p02 丢了更新：${store.findProblem(s, 'p02').notes}`);
    assert.equal(existsSync(join(tmp, C, S, 'sheet.json.lock')), false, '锁没释放');
    // 索引也还在、计数对得上
    assert.ok(store.readIndex(C).sheets.some((x) => x.id === S));
  });

  // ───────────── 5. 经验 id ─────────────
  await t('经验：同一毫秒连加两条，id 也不撞', async () => {
    const realNow = Date.now;
    Date.now = () => 1_800_000_000_000;
    try {
      await call('exercise_lessons', { op: 'add', course_id: C, sheet_id: S, text: '第一条' });
      await call('exercise_lessons', { op: 'add', course_id: C, sheet_id: S, text: '第二条' });
    } finally {
      Date.now = realNow;
    }
    const ids = sheet().lessons.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length, `经验 id 撞了：${ids.join(',')}`);
  });

  assert.equal(pending.length, 0, '还有没放行的 LLM 请求');
  console.log(`\n[exercise-review-1127] ${passed} 项断言通过`);
} finally {
  globalThis.fetch = realFetch;
}
