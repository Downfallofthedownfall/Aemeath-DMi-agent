// ============================================================
// test/check5.mjs — 握手（借 lecture 的 schema）+ worldbook 沉淀 + 导入侧
//
// 关键断言（真机上最容易"看起来对、实际没写"的地方）：
//   · 导出的包必须能被 lecture 的 handoffSchema 解析（借用的前提）
//   · 只有**已提交**的套才进 claims（否则污染用户画像的时间轴）
//   · 导入侧缺省 dry-run 不写任何东西
//   · worldbook 条目按内容哈希幂等（重复导入不产生重复条目）
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoffSchema as lectureHandoffSchema } from '@aemeath/dsh-plugin-lecture/handoff';
import {
  buildExerciseHandoff,
  exerciseHandoffSchema,
  writeExerciseHandoff,
  readExerciseHandoff,
  findExerciseHandoffs,
  describeExerciseHandoff,
} from '../lib/handoff.js';
import {
  handoffWorldbookEntries,
  importExerciseHandoff,
  findExerciseHandoffFiles,
} from '../lib/import-handoff.js';
import { appendWorldbookEntries, WORLDBOOK_FILE, entryIdOf, buildTriggers } from '../lib/worldbook.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const asyncT = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), 'ex-handoff-'));
const wbDir = join(root, 'worldbook');
mkdirSync(wbDir, { recursive: true });
const handoffDir = join(root, 'handoff');
mkdirSync(handoffDir, { recursive: true });

const check = (verdict, issues = []) => ({
  id: 'c1',
  created_at: 1,
  model: 'm',
  verdict,
  score: null,
  issues: issues.map((text) => ({ severity: 'error', text })),
  hints: [],
  next_steps: [],
  raw: '',
  answer_sha: 'x',
  stale: false,
});

const mkSheet = (over = {}) => ({
  id: 'ub03',
  number: 3,
  title: 'Mechanik',
  issued: '2026-10-15',
  due: '2026-10-22',
  source_pdf: 'source.pdf',
  source_pages: 2,
  import_mode: 'pdf',
  imported_at: 1,
  needs_manual_text: false,
  progress_digest: '上次做到 Blatt 2',
  progress_digest_at: 1,
  problems: [
    {
      id: 'p01',
      label: 'Aufgabe 1',
      title: 'Kraft',
      text: 'Berechne $F$',
      points: 4,
      page: 1,
      answer: 'F = ma',
      answer_updated_at: 1,
      answer_edited_by: 'user',
      checks: [check('wrong', ['方向搞反了'])],
      mistakes: [],
      notes: '',
    },
  ],
  lessons: [{ id: 'l1', text: '先画受力图，再写分量式', tags: ['力学'], source: 'user', created_at: 2, in_worldbook: false }],
  submitted_at: 99,
  submission_pdf: 'physik-1-ub03-submission.pdf',
  submission_pages: 3,
  version: 1,
  ...over,
});

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

const index = {
  version: 1,
  course_id: 'physik-1',
  title: 'Physik I',
  semester: 'WiSe',
  module_code: 'PHY-101',
  sheets: [],
};

t('导出包能被 lecture 的 handoffSchema 解析（借用成立）', () => {
  const h = buildExerciseHandoff({ index, sheets: [mkSheet()], mistakes: [mkMistake()], now: 1000 });
  const parsed = lectureHandoffSchema.safeParse(h);
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  assert.equal(h.kind, 'exercise');
  assert.equal(h.course.id, 'physik-1');
  assert.equal(h.progress[0].unit, 'ub03');
  assert.equal(h.progress[0].reviewed, true);
  assert.equal(h.weak_points.length, 1);
  assert.match(h.weak_points[0].topic, /先画受力图/);
  assert.equal(h.lessons.length, 1);
  assert.equal(h.mistakes.length, 1);
});

t('未提交的套：进度照传、claims 不传（不污染画像）', () => {
  const h = buildExerciseHandoff({
    index,
    sheets: [mkSheet({ submitted_at: 0, submission_pdf: '' })],
    mistakes: [],
    now: 1,
  });
  assert.equal(h.progress[0].reviewed, false);
  assert.equal(h.claims.length, 0);
});

t('已提交 → 生成一条 ubung_progress 断言', () => {
  const h = buildExerciseHandoff({ index, sheets: [mkSheet()], mistakes: [], now: 1 });
  assert.equal(h.claims.length, 1);
  assert.equal(h.claims[0].attribute, 'ubung_progress');
  assert.match(h.claims[0].value, /Übungsblatt 3 已提交/);
});

t('已掌握的错题仍传但置信度更低', () => {
  const a = buildExerciseHandoff({ index, sheets: [mkSheet()], mistakes: [mkMistake()], now: 1 });
  const b = buildExerciseHandoff({ index, sheets: [mkSheet()], mistakes: [mkMistake({ mastered: true })], now: 1 });
  assert.ok(a.weak_points[0].confidence > b.weak_points[0].confidence);
});

t('写文件 / 读回 / 扫描 / 摘要', () => {
  const h = buildExerciseHandoff({ index, sheets: [mkSheet()], mistakes: [mkMistake()], now: 1 });
  const file = writeExerciseHandoff(h, handoffDir);
  assert.equal(file.endsWith('physik-1-exercise-handoff.json'), true);
  const back = readExerciseHandoff(file);
  assert.equal(back.lessons.length, 1);
  assert.equal(back.mistakes[0].lesson, '先画受力图');
  const found = findExerciseHandoffs(handoffDir);
  assert.equal(found.length, 1);
  // 与 lecture 的 glob 不重叠：*-handoff.json 也会匹配本文件，但 lecture 的
  // findHandoffFiles 用 endsWith('-handoff.json') —— 我们的文件名同样以它结尾，
  // 这是刻意的（让用户的文件管理器一眼看出是握手包），导入侧靠 schema 区分。
  assert.ok(found[0].endsWith('-exercise-handoff.json'));
  const desc = describeExerciseHandoff(h);
  assert.match(desc, /课程：Physik I/);
  assert.match(desc, /未掌握 1/);
  assert.equal(findExerciseHandoffFiles(handoffDir).length, 1);
});

t('readExerciseHandoff 对坏文件返回 null', () => {
  const bad = join(handoffDir, 'x-exercise-handoff.json');
  writeFileSync(bad, '{oops', 'utf-8');
  assert.equal(readExerciseHandoff(bad), null);
  rmSync(bad);
});

t('worldbook 条目：跳过已掌握与空教训', () => {
  const h = buildExerciseHandoff({
    index,
    sheets: [mkSheet()],
    mistakes: [mkMistake(), mkMistake({ id: 'm2', mastered: true }), mkMistake({ id: 'm3', lesson: '', issues: [] })],
    now: 1,
  });
  const entries = handoffWorldbookEntries(h);
  // 1 条未掌握的错题 + 1 条经验
  assert.equal(entries.length, 2);
  assert.ok(entries.some((e) => e.content.includes('先画受力图')));
  assert.ok(entries.some((e) => e.content.includes('习题经验')));
  for (const e of entries) {
    assert.ok(e.id.startsWith('ex_'));
    assert.ok(e.triggers.length > 0);
    assert.ok(e.content.length <= 600);
  }
});

t('worldbook 写入：幂等 + 保留已有内容', () => {
  const entry = {
    id: entryIdOf('第一条教训'),
    title: '测试',
    kind: 'knowledge',
    triggers: ['测试'],
    constant: false,
    intrinsic_value: 70,
    priority: 60,
    chain: [],
    content: '第一条教训',
    source: 'test',
    verifiable: false,
  };
  const r1 = appendWorldbookEntries(wbDir, [entry]);
  assert.equal(r1.written, 1);
  const r2 = appendWorldbookEntries(wbDir, [entry]);
  assert.equal(r2.written, 0);
  assert.equal(r2.skipped, 1);
  const arr = JSON.parse(readFileSync(join(wbDir, WORLDBOOK_FILE), 'utf-8'));
  assert.equal(arr.length, 1);
  // 追加第二条不会覆盖第一条
  appendWorldbookEntries(wbDir, [{ ...entry, id: 'ex_second', content: '第二条教训' }]);
  assert.equal(JSON.parse(readFileSync(join(wbDir, WORLDBOOK_FILE), 'utf-8')).length, 2);
});

t('buildTriggers 生成拉丁词 + 中文 bigram，且限量', () => {
  const tr = buildTriggers('角动量守恒 angular momentum', '力学', ['转动']);
  assert.ok(tr.includes('转动'));
  assert.ok(tr.includes('角动')); // 中文 bigram 覆盖
  assert.ok(tr.includes('angular'));
  assert.ok(tr.length <= 8);
});

// ---------- 导入侧 ----------
const fakeGk = () => {
  const saved = [];
  return {
    saved,
    decide: (q) => ({ kind: 'save', content: q, category: 'study_log', importance: 70 }),
    writeGate: () => ({ action: 'accept', reason: '' }),
    save: async (input) => {
      saved.push(input);
      return `id-${saved.length}`;
    },
    knowledgeAdd: async () => 'k1',
    log: () => undefined,
    warn: () => undefined,
  };
};

await asyncT('dry-run 不写记忆、不写 worldbook', async () => {
  const h = buildExerciseHandoff({ index, sheets: [mkSheet()], mistakes: [mkMistake()], now: 1 });
  const gk = fakeGk();
  const before = existsSync(join(wbDir, WORLDBOOK_FILE));
  const out = await importExerciseHandoff(h, gk, { dryRun: true, worldbookDir: wbDir });
  assert.equal(gk.saved.length, 0);
  assert.equal(existsSync(join(wbDir, WORLDBOOK_FILE)), before);
  assert.ok(out.memoriesWritten >= 2); // weak_point + claim
  assert.ok(out.worldbookWritten >= 2);
  assert.ok(out.details.some((d) => d.reason.includes('[试运行]')));
});

await asyncT('真导入：记忆过守门员 + worldbook 落盘 + 二次导入幂等', async () => {
  const h = buildExerciseHandoff({ index, sheets: [mkSheet()], mistakes: [mkMistake()], now: 1 });
  const gk = fakeGk();
  const out = await importExerciseHandoff(h, gk, { dryRun: false, worldbookDir: wbDir });
  assert.ok(out.memoriesWritten >= 2);
  assert.equal(gk.saved.length, out.memoriesWritten);
  assert.ok(gk.saved.some((s) => s.sourceMode === 'exercise' && s.sourceExercise.sheet === 'ub03'));
  // claims 带结构化断言
  const withClaims = gk.saved.find((s) => s.entityClaims && s.entityClaims.length);
  assert.ok(withClaims, '应当写入一条带 entityClaims 的记忆');
  assert.equal(withClaims.entityClaims[0].attribute, 'ubung_progress');
  // worldbook 增加（之前的 2 条测试条目 + 本次 2 条）
  const arr = JSON.parse(readFileSync(join(wbDir, WORLDBOOK_FILE), 'utf-8'));
  assert.ok(arr.length >= 3);
  // 二次导入：worldbook 不重复
  const gk2 = fakeGk();
  const out2 = await importExerciseHandoff(h, gk2, { dryRun: false, worldbookDir: wbDir });
  assert.equal(out2.worldbookWritten, 0);
  assert.ok(out2.worldbookSkipped >= 1);
});

await asyncT('未提交的套：短板与 claims 都被跳过', async () => {
  const h = buildExerciseHandoff({
    index,
    sheets: [mkSheet({ submitted_at: 0 })],
    mistakes: [mkMistake()],
    now: 1,
  });
  const gk = fakeGk();
  const out = await importExerciseHandoff(h, gk, { dryRun: false, worldbookDir: wbDir });
  assert.equal(gk.saved.length, 0);
  assert.ok(out.dropped >= 1);
});

await asyncT('worldbookDir 缺失：不报错，明确说跳过', async () => {
  const h = buildExerciseHandoff({ index, sheets: [mkSheet()], mistakes: [mkMistake()], now: 1 });
  const gk = fakeGk();
  const out = await importExerciseHandoff(h, gk, { dryRun: false });
  assert.equal(out.worldbookWritten, 0);
  assert.ok(out.details.some((d) => d.kind === 'worldbook' && d.reason.includes('未配置')));
});

rmSync(root, { recursive: true, force: true });
console.log(`\n[exercise-handoff] ${passed} 项断言通过`);
