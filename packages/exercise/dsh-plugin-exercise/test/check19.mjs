// ============================================================
// test/check19.mjs — 跨插件协同：握手导入 / 世界书同步 / 工具开关 / LLM 通道
//
// 守护 2026-11-20 review 修掉的几处：
//   1. memory 守门员的 pending / knowledge_direct 判定**没有** content/category ——
//      早先原样写进记忆（content: undefined），会毒化整个记忆域。用**真的** gatekeeper 测。
//   2. 握手导入不幂等：每导一次就把短板/进度再写一遍记忆；知识层每次全量重送
//   3. 世界书条目只追加不更新/撤回；部分写失败也被标成已同步；两条路径写出重复条目
//   4. `enabled` 开关只打日志，工具照样挂着
//   5. 运行时调用失败时悄悄换成直连 DeepSeek（换了模型、关了推理）
//   6. 一门课的 index.json 坏了，整个课程列表 500
// ============================================================
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, writeGate } from '@aemeath/dsh-plugin-memory/gatekeeper';
import { apply } from '../lib/index.js';
import { ExerciseStore, withFileLockSync } from '../lib/store.js';
import { buildExerciseHandoff } from '../lib/handoff.js';
import { fileLedger, importExerciseHandoff, resolveWritable } from '../lib/import-handoff.js';
import {
  WORLDBOOK_FILE,
  applyWorldbookChanges,
  entryInScope,
  legacyScope,
  mistakeRef,
  mistakeToEntry,
} from '../lib/worldbook.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), 'exercise-test19-'));
delete process.env.EXERCISE_DATA_DIR;
const readWb = (dir) => JSON.parse(readFileSync(join(dir, WORLDBOOK_FILE), 'utf-8'));

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

const mkSheet = (over = {}) => ({
  id: 'ub03',
  number: 3,
  title: 'Mechanik',
  issued: '2026-10-15',
  due: '2026-10-22',
  source_pdf: '',
  source_pages: 0,
  import_mode: 'manual',
  imported_at: 1,
  needs_manual_text: false,
  progress_digest: '',
  progress_digest_at: 0,
  problems: [],
  lessons: [{ id: 'l1', text: '先画受力图，再写分量式', tags: ['力学'], source: 'user', created_at: 2, in_worldbook: false }],
  submitted_at: 99,
  submission_pdf: '',
  submission_pages: 0,
  version: 1,
  ...over,
});
const index = { version: 1, course_id: 'physik-1', title: 'Physik I', semester: 'WiSe', module_code: '', sheets: [] };

/** 真 memory 守门员 + 记录 save 入参的假存储。 */
const realGk = () => {
  const saved = [];
  const knowledge = [];
  return {
    saved,
    knowledge,
    decide,
    writeGate,
    save: async (input) => {
      saved.push(input);
      return `mem-${saved.length}`;
    },
    knowledgeAdd: async (input) => {
      knowledge.push(input);
      return `k-${knowledge.length}`;
    },
    log: () => undefined,
    warn: () => undefined,
  };
};

try {
  // ───────────── 1. 守门员判定规整 ─────────────
  await t('resolveWritable：pending/knowledge_direct 用原文 + study_log 兜底，skip/blocked 不写', async () => {
    const pending = resolveWritable({ kind: 'pending', reason: 'L1' }, '练习短板：X。');
    assert.deepEqual(pending, { content: '练习短板：X。', category: 'study_log', importance: 50 });
    const kd = resolveWritable({ kind: 'knowledge_direct', content: '练习短板：角动量守恒', topic: 't' }, 'fallback');
    assert.equal(kd.content, '练习短板：角动量守恒');
    assert.equal(kd.category, 'study_log');
    const save = resolveWritable({ kind: 'save', content: 'c', category: 'user_fact', importance: 80 }, 'f');
    assert.deepEqual(save, { content: 'c', category: 'user_fact', importance: 80 });
    assert.equal(resolveWritable({ kind: 'skip', reason: '' }, 'x'), null);
    assert.equal(resolveWritable({ kind: 'blocked', reason: '' }, 'x'), null);
    assert.equal(resolveWritable({ kind: 'pending', reason: '' }, '   '), null, '兜底文本也空 → 不写');
  });

  await t('真守门员：握手导入写进记忆的每条都有非空 content 与合法 category（不再写 undefined）', async () => {
    // 两条短板：一条普通（真 decide → pending），一条带物理词（→ knowledge_direct）
    const h = buildExerciseHandoff({
      index,
      sheets: [mkSheet()],
      mistakes: [mkMistake(), mkMistake({ id: 'm2', problem_id: 'p02', problem_label: 'Aufgabe 2', lesson: '角动量守恒要先选好参考点' })],
      now: 1,
    });
    const gk = realGk();
    const out = await importExerciseHandoff(h, gk, { dryRun: false });
    assert.ok(gk.saved.length >= 3, `应写入 2 条短板 + 1 条进度，实际 ${gk.saved.length}`);
    for (const s of gk.saved) {
      assert.equal(typeof s.content, 'string');
      assert.ok(s.content.trim().length > 0, '记忆内容不能为空');
      assert.ok(['user_fact', 'study_log', 'preference', 'relationship', 'session_summary'].includes(s.category), `非法分类 ${s.category}`);
      assert.ok(Number.isFinite(s.importance));
    }
    assert.ok(!out.details.some((d) => /undefined/.test(d.reason)), '试运行/结果说明里不该出现 undefined');
  });

  // ───────────── 2. 导入台账 ─────────────
  await t('导入台账：同一个握手包导两次，第二次记忆 0 条、全部"以前导入过"；知识层不重送', async () => {
    const wb = join(root, 'wb-ledger');
    mkdirSync(wb, { recursive: true });
    const ledger = fileLedger(join(root, 'ledger.json'));
    const h = buildExerciseHandoff({ index, sheets: [mkSheet()], mistakes: [mkMistake()], now: 1 });
    const gk1 = realGk();
    const o1 = await importExerciseHandoff(h, gk1, { dryRun: false, worldbookDir: wb, ledger });
    assert.ok(o1.memoriesWritten >= 2);
    assert.equal(gk1.knowledge.length, 2, '第一次：两条世界书条目进知识层');
    // 台账落盘了，换一个实例读回来也认
    const gk2 = realGk();
    const o2 = await importExerciseHandoff(h, gk2, { dryRun: false, worldbookDir: wb, ledger: fileLedger(join(root, 'ledger.json')) });
    assert.equal(gk2.saved.length, 0, '第二次不该再写记忆');
    assert.equal(o2.memoriesWritten, 0);
    assert.equal(o2.alreadyImported, o1.memoriesWritten);
    assert.equal(gk2.knowledge.length, 0, '条目没变 → 知识层不重送');
    assert.equal(o2.worldbookWritten, 0);
    // 试运行也照实说
    const o3 = await importExerciseHandoff(h, realGk(), { dryRun: true, worldbookDir: wb, ledger });
    assert.equal(o3.memoriesWritten, 0);
    assert.ok(o3.details.some((d) => /以前导入过|Imported before/.test(d.reason)));
  });

  // ───────────── 3. 世界书：按 ref 更新 / 撤回 / 去重 ─────────────
  await t('世界书：同一道错题本地同步与握手导入只留一条（按 ref）；改教训 = 整条替换', async () => {
    const wb = join(root, 'wb-ref');
    mkdirSync(wb, { recursive: true });
    const local = mistakeToEntry(mkMistake());
    assert.equal(local.ref, mistakeRef('physik-1', 'ub03', 'p01'));
    applyWorldbookChanges(wb, { upserts: [local] });
    const h = buildExerciseHandoff({ index, sheets: [mkSheet({ lessons: [] })], mistakes: [mkMistake()], now: 1 });
    await importExerciseHandoff(h, realGk(), { dryRun: false, worldbookDir: wb });
    let arr = readWb(wb);
    assert.equal(arr.filter((e) => e.ref === local.ref).length, 1, '同一 ref 只能有一条');
    // 教训改了 → 同 ref 整条替换（id 不变，内容变）
    const edited = mistakeToEntry(mkMistake({ lesson: '先画受力图，再定正方向' }));
    const r = applyWorldbookChanges(wb, { upserts: [edited] });
    assert.deepEqual([r.added.length, r.updated.length], [0, 1]);
    arr = readWb(wb);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].id, local.id);
    assert.match(arr[0].content, /再定正方向/);
  });

  await t('世界书：握手包里标了已掌握 → 撤回（不管条目是谁写的）；包里没了的握手条目也撤回', async () => {
    const wb = join(root, 'wb-retract');
    mkdirSync(wb, { recursive: true });
    const sheet = mkSheet({ lessons: [] });
    const two = [mkMistake(), mkMistake({ id: 'm2', problem_id: 'p02', lesson: '量纲先对一遍' })];
    await importExerciseHandoff(buildExerciseHandoff({ index, sheets: [sheet], mistakes: two, now: 1 }), realGk(), { dryRun: false, worldbookDir: wb });
    assert.equal(readWb(wb).length, 2);
    // 第二次：m1 已掌握，m2 删了
    const o = await importExerciseHandoff(
      buildExerciseHandoff({ index, sheets: [sheet], mistakes: [mkMistake({ mastered: true })], now: 2 }),
      realGk(),
      { dryRun: false, worldbookDir: wb },
    );
    assert.equal(o.worldbookRemoved, 2);
    assert.equal(readWb(wb).length, 0);
  });

  await t('世界书：老条目（没有 ref）能从 source 认出范围；别的课/非习题条目绝不碰', async () => {
    assert.deepEqual(legacyScope({ source: 'Übungsblatt 错题（physik-1/ub03/p01）' }), { kind: 'mistake', course: 'physik-1', sheet: 'ub03', legacy: true });
    assert.deepEqual(legacyScope({ source: 'Übungsblatt mistake (physik-1/ub03/p01)' }).kind, 'mistake');
    assert.deepEqual(legacyScope({ source: 'Übungsblatt 经验（Physik I / ub03）' }), { kind: 'lesson', course: 'Physik I', sheet: 'ub03', legacy: true });
    assert.equal(legacyScope({ source: 'test' }), null);
    const scope = { courseId: 'physik-1', courseTitle: 'Physik I' };
    assert.equal(entryInScope({ source: 'Übungsblatt 经验（Physik I / ub03）' }, scope), true, '老经验条目按课程标题认');
    assert.equal(entryInScope({ source: 'Übungsblatt 错题（mathe-1/ub01/p01）' }, scope), false);
  });

  await t('世界书：文件坏了 → 整体失败、什么都不写（不会"部分成功"）', async () => {
    const wb = join(root, 'wb-bad');
    mkdirSync(wb, { recursive: true });
    writeFileSync(join(wb, WORLDBOOK_FILE), '{oops', 'utf-8');
    const r = applyWorldbookChanges(wb, { upserts: [mistakeToEntry(mkMistake())] });
    assert.equal(r.ok, false);
    assert.equal(readFileSync(join(wb, WORLDBOOK_FILE), 'utf-8'), '{oops', '坏文件不覆盖');
    assert.equal(applyWorldbookChanges(join(root, 'nope'), { upserts: [] }).ok, false, '馆目录不存在 → 明确失败');
  });

  await t('跨进程锁：过期的锁会被清掉；锁在 fn 结束后释放', async () => {
    const file = join(root, 'lock-target.json');
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${file}.lock`, old, old);
    assert.equal(withFileLockSync(file, () => 42), 42);
    assert.equal(existsSync(`${file}.lock`), false);
    assert.throws(() => withFileLockSync(file, () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(`${file}.lock`), false, '抛错也要释放');
  });

  // ───────────── 4. 插件内：本地同步 / 撤回 / 开关 / 坏索引 ─────────────
  const makeCtx = (extra = {}) => {
    const tools = new Map();
    const handlers = new Map();
    return {
      tools,
      fire: (ev) => (handlers.get(ev) ?? []).forEach((h) => h()),
      ctx: {
        on: (ev, h) => {
          handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
          return () => {};
        },
        tools: {
          register: (def) => {
            tools.set(def.name, def);
            return () => tools.delete(def.name);
          },
        },
        credentials: { resolve: async () => ({ value: '' }) },
        ...extra,
      },
    };
  };
  const callOf = (tools) => (name, args) => tools.get(name).execute(args, { agent: { session: { id: 's1' } } });

  const dataDir = join(root, 'data');
  const wbDir = join(root, 'wb-local');
  mkdirSync(wbDir, { recursive: true });
  const flag = { on: true };
  const host = makeCtx();
  await apply(host.ctx, {
    dataDir,
    worldbookLibraryDir: wbDir,
    llm: { apiKey: 'test-key' },
    enabled: { get: () => flag.on },
  });
  const call = callOf(host.tools);
  const store = new ExerciseStore({ rootDir: dataDir });
  const created = await call('exercise_new_sheet', { course_id: 'physik-1', title: 'Mechanik' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const S = created.data.sheet_id;

  await t('本地同步：经验 + 未掌握错题按 ref 写入；再同步一次 = 全部未变', async () => {
    const added = await call('exercise_lessons', { op: 'add', course_id: 'physik-1', sheet_id: S, text: '先画受力图' });
    assert.equal(added.ok, true);
    store.upsertMistake(mkMistake({ sheet_id: S }));
    store.upsertMistake(mkMistake({ id: 'm2', sheet_id: S, problem_id: 'p02', mastered: true }));
    // 一条握手导入的条目（另一台机器的数据）+ 一条本课的老条目 + 一条别的课的老条目
    writeFileSync(
      join(wbDir, WORLDBOOK_FILE),
      JSON.stringify([
        { ...mistakeToEntry(mkMistake({ sheet_id: S, problem_id: 'p09' }), 'handoff') },
        { id: 'ex_legacy1', title: 'x', kind: 'knowledge', triggers: [], constant: false, intrinsic_value: 70, priority: 70, chain: [], content: '旧', source: `Übungsblatt 错题（physik-1/${S}/p07）`, verifiable: false },
        { id: 'ex_legacy2', title: 'y', kind: 'knowledge', triggers: [], constant: false, intrinsic_value: 70, priority: 70, chain: [], content: '别的课', source: 'Übungsblatt 错题（mathe-1/ub01/p01）', verifiable: false },
      ]),
    );
    const r = await call('exercise_sync_worldbook', { course_id: 'physik-1' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data.written, 2, '经验 + m1');
    assert.equal(r.data.removed, 1, '本课的老条目撤回');
    const arr = readWb(wbDir);
    assert.ok(arr.some((e) => e.origin === 'handoff'), '握手导入的条目不因本地没有而删');
    assert.ok(arr.some((e) => e.id === 'ex_legacy2'), '别的课的条目不碰');
    assert.ok(!arr.some((e) => e.ref === mistakeRef('physik-1', S, 'p02')), '已掌握的不写');
    const ms = store.readMistakes();
    assert.equal(ms.find((m) => m.id === 'm1').in_worldbook, true);
    assert.equal(ms.find((m) => m.id === 'm2').in_worldbook, false);
    assert.equal(store.readSheet('physik-1', S).lessons[0].in_worldbook, true);
    const again = await call('exercise_sync_worldbook', { course_id: 'physik-1' });
    assert.equal(again.data.written, 0);
    assert.equal(again.data.removed, 0);
  });

  await t('本地同步：改经验 → 原条目更新而不是多一条；错题标已掌握 → 撤回', async () => {
    const lessonId = store.readSheet('physik-1', S).lessons[0].id;
    await call('exercise_lessons', { op: 'update', course_id: 'physik-1', sheet_id: S, lesson_id: lessonId, text: '先画受力图，再写分量式' });
    assert.equal(store.readSheet('physik-1', S).lessons[0].in_worldbook, false, '改了 → 待同步');
    store.patchMistake('m1', { mastered: true });
    const before = readWb(wbDir).length;
    const r = await call('exercise_sync_worldbook', { course_id: 'physik-1' });
    assert.equal(r.data.written, 1, '经验更新');
    assert.equal(r.data.removed, 1, 'm1 撤回');
    const arr = readWb(wbDir);
    assert.equal(arr.length, before - 1);
    assert.equal(arr.filter((e) => e.ref?.startsWith('lesson:')).length, 1);
    assert.match(arr.find((e) => e.ref?.startsWith('lesson:')).content, /再写分量式/);
  });

  await t('删经验 → 世界书里那条立刻撤回', async () => {
    const lessonId = store.readSheet('physik-1', S).lessons[0].id;
    await call('exercise_lessons', { op: 'delete', course_id: 'physik-1', sheet_id: S, lesson_id: lessonId });
    assert.equal(readWb(wbDir).filter((e) => e.ref?.startsWith('lesson:')).length, 0);
  });

  await t('世界书文件坏了 → 同步报错，标记一个都不打', async () => {
    await call('exercise_lessons', { op: 'add', course_id: 'physik-1', sheet_id: S, text: '新经验' });
    writeFileSync(join(wbDir, WORLDBOOK_FILE), '{oops', 'utf-8');
    const r = await call('exercise_sync_worldbook', { course_id: 'physik-1' });
    assert.equal(r.ok, false);
    assert.equal(store.readSheet('physik-1', S).lessons.every((l) => !l.in_worldbook), true);
    rmSync(join(wbDir, WORLDBOOK_FILE));
  });

  await t('一门课的 index.json 坏了：exercise_list 跳过它，其它课照常', async () => {
    mkdirSync(join(dataDir, 'kaputt'), { recursive: true });
    writeFileSync(join(dataDir, 'kaputt', 'index.json'), '{not json', 'utf-8');
    const r = await call('exercise_list', {});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(JSON.stringify(r.data), /physik-1/);
  });

  await t('enabled 开关：关 → exercise_* 从工具表移除；开 → 放回', async () => {
    const n = host.tools.size;
    assert.ok(n >= 10);
    flag.on = false;
    host.fire('loader/volatile-update');
    assert.equal(host.tools.size, 0);
    flag.on = true;
    host.fire('loader/volatile-update');
    assert.equal(host.tools.size, n);
  });

  // ───────────── 5. LLM 通道：运行时在但调用失败 → 不悄悄换直连 ─────────────
  await t('运行时调用失败：检查报错，不掉到直连 DeepSeek（不换模型、不关推理）', async () => {
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 500 });
    };
    try {
      const runtime = {
        prepareCall: async () => {
          throw new Error('provider exploded');
        },
        listProviders: () => [{ id: 'deepseek' }],
        listModels: async () => [{ id: 'deepseek-v4-flash' }],
      };
      const h2 = makeCtx({ reflect: { get: (n) => (n === 'llm' ? runtime : undefined) } });
      const dir2 = join(root, 'data-llm');
      await apply(h2.ctx, { dataDir: dir2, worldbookLibraryDir: wbDir, llm: { apiKey: 'test-key' } });
      const call2 = callOf(h2.tools);
      const c = await call2('exercise_new_sheet', { course_id: 'physik-1', title: 'x' });
      const st = new ExerciseStore({ rootDir: dir2 });
      const sheet = st.readSheet('physik-1', c.data.sheet_id);
      sheet.problems = [
        { id: 'p01', label: 'A1', title: 'A1', text: 'Berechne F.', points: null, page: 0, has_figure: false, figure_note: '', answer: 'F = 1 N', answer_updated_at: 1, answer_edited_by: 'user', checks: [], rebuttals: [], images: [], mistakes: [], notes: '' },
      ];
      st.writeSheet('physik-1', sheet);
      const r = await call2('exercise_check', { course_id: 'physik-1', sheet_id: c.data.sheet_id, problem_id: 'p01' });
      assert.equal(r.ok, false, '运行时失败 → 检查失败');
      assert.equal(fetchCalls, 0, '不该再走直连');
      const last = st.findProblem(st.readSheet('physik-1', c.data.sheet_id), 'p01').checks.at(-1);
      assert.equal(last.provider, 'dsh:deepseek/deepseek-v4-flash', '来源按本次操作记录');
      assert.equal(last.model, 'deepseek-v4-flash', 'model 记实际模型（早先永远是空串）');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n[exercise-cross-plugin] ${passed} 项断言通过`);
