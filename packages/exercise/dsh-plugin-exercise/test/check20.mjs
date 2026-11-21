// ============================================================
// test/check20.mjs — 2026-11-21 review 修掉的几处（跨进程 / 世界书撤回 / 导入台账）
//
//   1. 跨进程锁：两个等锁的进程同时看到过期锁 → 都删、都建 → 两边都以为持锁。
//      现在清理过期锁本身要先抢 `.break`；释放时核对持有者标记，不删别人的锁。
//      用**真的子进程**并发抢锁验证互斥。
//   2. 错题 id 在锁外分配：主 profile 与独立 profile 同时收错题会算出同一个 id、互相改写。
//      现在查找 + 分配 + 写回在一把锁里（store.upsertMistakeFor），同样用子进程并发验证。
//   3. 撤回只扫默认 preset 的馆：导入进 aemeath 馆的条目，本地删错题 / 标已掌握后撤不掉。
//   4. 一道题挂着几条错题（合并小题后）时，删一条就整条撤回 → 现在用同题剩下的那条重写。
//   5. 导入台账：写入成功但台账写失败被报成"写入失败"；has() 看不到另一个进程写的台账。
// ============================================================
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { apply } from '../lib/index.js';
import { ExerciseStore, withFileLockSync } from '../lib/store.js';
import { mistakeIdAt, nextMistakeId } from '../lib/types.js';
import { buildExerciseHandoff } from '../lib/handoff.js';
import { fileLedger, importExerciseHandoff } from '../lib/import-handoff.js';
import { WORLDBOOK_FILE, applyWorldbookChanges, mistakeRef, mistakeToEntry } from '../lib/worldbook.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), 'exercise-test20-'));
delete process.env.EXERCISE_DATA_DIR;
const storeUrl = pathToFileURL(resolve('lib/store.js')).href;
const typesUrl = pathToFileURL(resolve('lib/types.js')).href;
const readWb = (dir) => (existsSync(join(dir, WORLDBOOK_FILE)) ? JSON.parse(readFileSync(join(dir, WORLDBOOK_FILE), 'utf-8')) : []);
const old = (path) => {
  const d = new Date(Date.now() - 120_000);
  utimesSync(path, d, d);
};

/** 跑一个子进程（ESM 代码串）；非 0 退出 → reject 带 stderr。 */
const child = (code) =>
  new Promise((ok, fail) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (c) => (c === 0 ? ok() : fail(new Error(`子进程退出 ${c}：${err}`))));
  });
/** 子进程共用的起跑线：等 go 文件出现再一起开抢（尽量让它们同时撞上锁）。 */
const startLine = (go) => `
  import { existsSync } from 'node:fs';
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 2500 && !existsSync(${JSON.stringify(go)}); i++) sleep(2);
`;
const race = async (n, code, go) => {
  const runs = Array.from({ length: n }, (_, i) => child(code(i)));
  await new Promise((r) => setTimeout(r, 400)); // 等子进程都起来
  writeFileSync(go, '1');
  await Promise.all(runs);
};

const mkMistake = (over = {}) => ({
  id: 'm1',
  course_id: 'physik-1',
  course_title: 'Physik I',
  sheet_id: 'ub03',
  sheet_title: 'Übungsblatt 3',
  sheet_due: '2026-10-22',
  problem_id: 'p01',
  problem_label: 'Aufgabe 1',
  problem_text: 'Berechne $F$',
  answer: 'F = -ma',
  verdict: 'wrong',
  issues: ['方向搞反了'],
  tags: ['力学'],
  lesson: '先画受力图',
  created_at: 5,
  updated_at: 5,
  review_count: 0,
  mastered: false,
  in_worldbook: false,
  source_check_id: 'c1',
  ...over,
});

try {
  // ───────────── 1. 跨进程锁 ─────────────
  await t('锁：4 个进程同时撞上一把过期锁，临界区仍然互斥（只有一个能清掉过期锁）', async () => {
    const target = join(root, 'race.json');
    const log = join(root, 'race.log');
    const go = join(root, 'race.go');
    mkdirSync(`${target}.lock`);
    old(`${target}.lock`);
    await race(
      4,
      (i) => `${startLine(go)}
        import { appendFileSync } from 'node:fs';
        import { withFileLockSync } from ${JSON.stringify(storeUrl)};
        for (let k = 0; k < 5; k++) {
          withFileLockSync(${JSON.stringify(target)}, () => {
            appendFileSync(${JSON.stringify(log)}, 'in ${i}\\n');
            sleep(15);
            appendFileSync(${JSON.stringify(log)}, 'out ${i}\\n');
          });
        }`,
      go,
    );
    const lines = readFileSync(log, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 40);
    for (let k = 0; k < lines.length; k += 2) {
      const [a, b] = [lines[k], lines[k + 1]];
      assert.ok(a.startsWith('in ') && b === `out ${a.slice(3)}`, `临界区重叠：第 ${k} 行起 ${a} / ${b}`);
    }
    assert.equal(existsSync(`${target}.lock`), false, '最后一把锁要释放');
    assert.equal(existsSync(`${target}.lock.break`), false, '清理锁不能残留');
  });

  await t('锁：自己的锁被当成过期清掉、别人接手后，释放时不删接手者的锁', async () => {
    const target = join(root, 'owner.json');
    withFileLockSync(target, () => {
      // 模拟：持有者慢到被别的进程判成过期、清掉、换上了自己的锁
      rmSync(`${target}.lock`, { recursive: true, force: true });
      mkdirSync(`${target}.lock`);
      writeFileSync(join(`${target}.lock`, 'owner'), 'someone-else');
    });
    assert.equal(readFileSync(join(`${target}.lock`, 'owner'), 'utf-8'), 'someone-else', '接手者的锁被删了');
    rmSync(`${target}.lock`, { recursive: true, force: true });
  });

  await t('锁：清理锁也是死进程留下的（过期）→ 顺手清掉，照样拿到锁', async () => {
    const target = join(root, 'breaker.json');
    mkdirSync(`${target}.lock`);
    mkdirSync(`${target}.lock.break`);
    old(`${target}.lock`);
    old(`${target}.lock.break`);
    assert.equal(withFileLockSync(target, () => 7), 7);
    assert.equal(existsSync(`${target}.lock`), false);
    assert.equal(existsSync(`${target}.lock.break`), false);
  });

  await t('锁：被活着的进程占着 → 约 2s 后放弃（不把主进程冻住 5s）', async () => {
    const target = join(root, 'busy.json');
    mkdirSync(`${target}.lock`);
    const t0 = Date.now();
    assert.throws(() => withFileLockSync(target, () => 1), /被另一个进程占用|locked by another process/);
    const waited = Date.now() - t0;
    assert.ok(waited >= 1500 && waited < 3500, `等了 ${waited}ms`);
    assert.equal(existsSync(`${target}.lock`), true, '别人的新鲜锁不能删');
    rmSync(`${target}.lock`, { recursive: true, force: true });
  });

  // ───────────── 2. 错题 id 在锁里分配 ─────────────
  await t('错题：查找 + 分配 id 在锁里进行；不合 schema 的原始条目占着的 id 也不复用', async () => {
    const dir = join(root, 'ids');
    const store = new ExerciseStore({ rootDir: dir });
    const at = new Date(2026, 10, 21, 9).getTime();
    mkdirSync(dir, { recursive: true });
    // 一条坏条目（保留原样写回），它占着当天第 1 号
    writeFileSync(join(dir, '_mistakes.json'), JSON.stringify([{ id: mistakeIdAt(at, 1), broken: true }]));
    let sawLock = false;
    const m = store.upsertMistakeFor({ courseId: 'physik-1', sheetId: 'ub03', problemId: 'p01' }, (existing, taken) => {
      sawLock = existsSync(join(dir, '_mistakes.json.lock'));
      assert.equal(existing, null);
      return mkMistake({ id: nextMistakeId(at, taken), created_at: at, updated_at: at });
    });
    assert.ok(sawLock, 'make 应在锁里被调用');
    assert.notEqual(m.id, mistakeIdAt(at, 1), '撞上了坏条目的 id');
    // 同一道题再来一次 → 拿到的是已有那条（副本），按 id 更新而不是新增
    const again = store.upsertMistakeFor({ courseId: 'physik-1', sheetId: 'ub03', problemId: 'p01' }, (existing) => {
      assert.equal(existing?.id, m.id);
      return { ...existing, lesson: '改过的教训' };
    });
    assert.equal(again.id, m.id);
    assert.equal(store.readMistakes().length, 1);
    assert.equal(store.readMistakes()[0].lesson, '改过的教训');
    const raw = JSON.parse(readFileSync(join(dir, '_mistakes.json'), 'utf-8'));
    assert.ok(raw.some((x) => x.broken === true), '坏条目要原样保留');
  });

  await t('错题：两个进程同时为不同题收错题（同一天、同一时刻）→ id 不撞、谁也不改写谁', async () => {
    const dir = join(root, 'ids-race');
    const go = join(root, 'ids.go');
    mkdirSync(dir, { recursive: true });
    const base = mkMistake();
    await race(
      2,
      (i) => `${startLine(go)}
        import { ExerciseStore } from ${JSON.stringify(storeUrl)};
        import { nextMistakeId } from ${JSON.stringify(typesUrl)};
        const store = new ExerciseStore({ rootDir: ${JSON.stringify(dir)} });
        const at = ${new Date(2026, 10, 21, 9).getTime()};
        const base = ${JSON.stringify(base)};
        for (let k = 0; k < 8; k++) {
          const problemId = 'p${i}' + k;
          store.upsertMistakeFor({ courseId: base.course_id, sheetId: base.sheet_id, problemId }, (existing, taken) =>
            existing ?? { ...base, id: nextMistakeId(at, taken), problem_id: problemId, created_at: at, updated_at: at });
        }`,
      go,
    );
    const all = new ExerciseStore({ rootDir: dir }).readMistakes();
    assert.equal(all.length, 16, `应有 16 条，实际 ${all.length}`);
    assert.equal(new Set(all.map((m) => m.id)).size, 16, 'id 撞了');
    assert.equal(new Set(all.map((m) => m.problem_id)).size, 16, '有错题被别的题改写了');
  });

  // ───────────── 3. 导入台账 ─────────────
  await t('台账：has() 看得到另一个实例（另一个进程）后来写进去的记录', async () => {
    const file = join(root, 'ledger-shared.json');
    const a = fileLedger(file);
    const b = fileLedger(file);
    assert.equal(a.has('k1'), false);
    b.add('k1', 'mem-1');
    assert.equal(a.has('k1'), true, 'a 还在用启动时读的旧缓存');
  });

  await t('台账写失败：记忆照样算"已写入"，只提醒一句，不报成写入失败', async () => {
    const index = { version: 1, course_id: 'physik-1', title: 'Physik I', semester: 'WiSe', module_code: '', sheets: [] };
    const sheet = {
      id: 'ub03', number: 3, title: 'Mechanik', issued: '2026-10-15', due: '2026-10-22', source_pdf: '', source_pages: 0,
      import_mode: 'manual', imported_at: 1, needs_manual_text: false, progress_digest: '', progress_digest_at: 0, problems: [],
      lessons: [{ id: 'l1', text: '先画受力图，再写分量式', tags: ['力学'], source: 'user', created_at: 2, in_worldbook: false }],
      submitted_at: 99, submission_pdf: '', submission_pages: 0, version: 1,
    };
    const h = buildExerciseHandoff({ index, sheets: [sheet], mistakes: [mkMistake()], now: 1 });
    const saved = [];
    const knowledge = [];
    const warns = [];
    const gk = {
      decide: (q) => ({ kind: 'save', content: q, category: 'study_log', importance: 60 }),
      writeGate: () => ({ action: 'accept', reason: '' }),
      save: async (input) => (saved.push(input), `mem-${saved.length}`),
      knowledgeAdd: async (input) => (knowledge.push(input), `k-${knowledge.length}`),
      log: () => undefined,
      warn: (m) => warns.push(m),
    };
    const ledger = {
      has: () => false,
      add: () => {
        throw new Error('文件被另一个进程占用（锁未释放）');
      },
    };
    const wb = join(root, 'wb-ledger-fail');
    mkdirSync(wb, { recursive: true });
    const o = await importExerciseHandoff(h, gk, { dryRun: false, worldbookDir: wb, ledger });
    assert.ok(saved.length >= 1);
    assert.equal(o.memoriesWritten, saved.length, '写进去的记忆都应算已写入');
    assert.ok(!o.details.some((d) => /写入失败|Write failed/.test(d.reason)), JSON.stringify(o.details));
    assert.ok(warns.some((w) => /台账/.test(w)), '应提醒台账没记上');
    assert.ok(!warns.some((w) => /知识层写入失败/.test(w)), '知识层其实写成功了，不该报失败');
    assert.equal(knowledge.length, 2);
  });

  // ───────────── 4. 世界书：每个馆都撤回 / 同题多条错题 ─────────────
  await t('replaceOnly：只替换已有条目，文件里没有的不新增', async () => {
    const wb = join(root, 'wb-replace');
    mkdirSync(wb, { recursive: true });
    const e = mistakeToEntry(mkMistake());
    const r = applyWorldbookChanges(wb, { upserts: [e], replaceOnly: true });
    assert.equal(r.ok, true);
    assert.deepEqual([r.added.length, r.updated.length], [0, 0]);
    assert.deepEqual(readWb(wb), []);
    applyWorldbookChanges(wb, { upserts: [e] });
    const r2 = applyWorldbookChanges(wb, { upserts: [mistakeToEntry(mkMistake({ lesson: '新教训' }))], replaceOnly: true });
    assert.equal(r2.updated.length, 1);
    assert.match(readWb(wb)[0].content, /新教训/);
  });

  // 插件实例：挂了 worldbook 服务（physicist / aemeath 两个馆）+ HTTP 桥
  const wbA = join(root, 'wb-physicist');
  const wbB = join(root, 'wb-aemeath');
  mkdirSync(wbA, { recursive: true });
  mkdirSync(wbB, { recursive: true });
  const routes = new Map();
  const tools = new Map();
  const services = {
    webServer: { register: (r) => (routes.set(r.path, r.handler), () => {}) },
    connection: { requestRejection: () => undefined },
    worldbook: { libraries: { physicist: wbA, aemeath: wbB } },
  };
  const dataDir = join(root, 'data');
  await apply(
    {
      on: () => () => {},
      effect: () => {}, // HTTP 桥只在 effect 里放卸载逻辑，测试里不卸载
      tools: { register: (def) => (tools.set(def.name, def), () => tools.delete(def.name)) },
      credentials: { resolve: async () => ({ value: '' }) },
      reflect: { get: (n) => services[n] },
    },
    { dataDir, llm: { apiKey: 'test-key' } },
  );
  const call = (name, args) => tools.get(name).execute(args, { agent: { session: { id: 's1' } } });
  /** 走真 HTTP 桥 POST 一个 action。 */
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
  const store = new ExerciseStore({ rootDir: dataDir });
  const created = await call('exercise_new_sheet', { course_id: 'physik-1', title: 'Mechanik' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const S = created.data.sheet_id;
  const ref = (p) => mistakeRef('physik-1', S, p);
  const refsIn = (dir) => readWb(dir).map((e) => e.ref);

  await t('删一条错题：同题还有未掌握的错题 → 条目改用剩下那条重写，而不是整条撤回', async () => {
    // 合并小题后两条错题指向同一道题 p01；m1 较早，同步时它的内容最后写入
    store.upsertMistake(mkMistake({ id: 'm1', sheet_id: S, lesson: 'L-eins', created_at: 5 }));
    store.upsertMistake(mkMistake({ id: 'm2', sheet_id: S, lesson: 'L-zwei', created_at: 6 }));
    store.upsertMistake(mkMistake({ id: 'm3', sheet_id: S, problem_id: 'p02', problem_label: 'Aufgabe 2', lesson: 'L-drei', created_at: 7 }));
    const sync = await call('exercise_sync_worldbook', { course_id: 'physik-1' });
    assert.equal(sync.ok, true, JSON.stringify(sync));
    assert.match(readWb(wbA).find((e) => e.ref === ref('p01')).content, /L-eins/);
    const r = await post({ action: 'delete_mistake', id: 'm1' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const entry = readWb(wbA).find((e) => e.ref === ref('p01'));
    assert.ok(entry, '同题还有未掌握的 m2，条目不该被撤回');
    assert.match(entry.content, /L-zwei/, '条目应改用 m2 的教训');
    assert.doesNotMatch(entry.content, /L-eins/);
    // 最后一条也删了 → 撤回
    await post({ action: 'delete_mistake', id: 'm2' });
    assert.ok(!refsIn(wbA).includes(ref('p01')));
  });

  await t('标已掌握：主馆和握手导入写进的 aemeath 馆都撤回', async () => {
    applyWorldbookChanges(wbB, { upserts: [mistakeToEntry(mkMistake({ sheet_id: S, problem_id: 'p02', lesson: 'L-drei' }), 'handoff')] });
    assert.ok(refsIn(wbA).includes(ref('p02')) && refsIn(wbB).includes(ref('p02')), '前提：两个馆里都有 p02');
    const r = await post({ action: 'patch_mistake', id: 'm3', patch: { mastered: true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(!refsIn(wbA).includes(ref('p02')), '主馆没撤');
    assert.ok(!refsIn(wbB).includes(ref('p02')), 'aemeath 馆没撤（早先只扫默认 preset 的馆）');
  });

  await t('同步：已掌握错题在其它馆里的握手条目也撤回；同题还有未掌握错题的 ref 不撤', async () => {
    store.upsertMistake(mkMistake({ id: 'm4', sheet_id: S, problem_id: 'p03', problem_label: 'Aufgabe 3', lesson: 'L-vier', mastered: true, created_at: 8 }));
    store.upsertMistake(mkMistake({ id: 'm5', sheet_id: S, problem_id: 'p04', problem_label: 'Aufgabe 4', lesson: 'L-fuenf-alt', mastered: true, created_at: 9 }));
    store.upsertMistake(mkMistake({ id: 'm6', sheet_id: S, problem_id: 'p04', problem_label: 'Aufgabe 4', lesson: 'L-fuenf', created_at: 10 }));
    applyWorldbookChanges(wbB, {
      upserts: [
        mistakeToEntry(mkMistake({ sheet_id: S, problem_id: 'p03', lesson: 'L-vier' }), 'handoff'),
        mistakeToEntry(mkMistake({ sheet_id: S, problem_id: 'p04', lesson: 'L-fuenf' }), 'handoff'),
      ],
    });
    const r = await call('exercise_sync_worldbook', { course_id: 'physik-1' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!refsIn(wbB).includes(ref('p03')), 'aemeath 馆里已掌握的 p03 没撤');
    assert.ok(refsIn(wbB).includes(ref('p04')), 'p04 还有未掌握的 m6，不该撤');
    assert.ok(r.data.removed >= 1);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n[exercise-review-1121] ${passed} 项断言通过`);
