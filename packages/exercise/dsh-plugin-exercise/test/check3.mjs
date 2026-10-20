// ============================================================
// test/check3.mjs — 文件存储（ExerciseStore）往返
//
// 覆盖真机上最容易出错的地方：
//   · 索引与 sheet.json 的两处真相（写 sheet 必须同步索引）
//   · 人可手改的文件（BOM / 空文件 / 坏 schema 不能把整个模块带崩）
//   · 目录穿越（id 来自 UI/LLM，绝不信）
//   · 删除（删题集必须连目录一起，索引也要摘）
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExerciseStore, safeCourseId, safeSheetId, problemIdOf } from '../lib/store.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), 'ex-store-'));
const store = new ExerciseStore({ rootDir: root });

const mkProblem = (n, over = {}) => ({
  id: problemIdOf(n),
  label: `Aufgabe ${n + 1}`,
  title: '',
  text: `题 ${n}`,
  points: 4,
  page: 1,
  answer: '',
  answer_updated_at: 0,
  answer_edited_by: 'user',
  checks: [],
  mistakes: [],
  notes: '',
  ...over,
});

const mkSheet = (id, n, over = {}) => ({
  id,
  number: n,
  title: '',
  issued: '2026-10-01',
  due: '2026-10-08',
  source_pdf: '',
  source_pages: 0,
  import_mode: 'pdf',
  imported_at: 0,
  needs_manual_text: false,
  progress_digest: '',
  progress_digest_at: 0,
  problems: [],
  lessons: [],
  submitted_at: 0,
  submission_pdf: '',
  submission_pages: 0,
  version: 1,
  ...over,
});

t('safeCourseId 删点号、折叠分隔符（防目录穿越）', () => {
  assert.equal(safeCourseId('physik-1'), 'physik-1');
  assert.equal(safeCourseId('a/b'), 'a-b');
  assert.equal(safeCourseId('u03/../../x'), 'u03-x');
  assert.equal(safeCourseId('..'), '');
  assert.equal(safeSheetId('Ub 03'), 'ub-03');
  assert.equal(safeSheetId(''), 'sheet');
});

t('ensureCourse 幂等，且能补全标题', () => {
  const a = store.ensureCourse('physik-1', 'Physik I', 'WiSe', 'PHY-101');
  assert.equal(a.course_id, 'physik-1');
  const b = store.ensureCourse('physik-1', '', '', '');
  assert.equal(b.title, 'Physik I');
  assert.equal(store.listCourses().includes('physik-1'), true);
});

t('nextSheetIdentity 从最大编号 +1', () => {
  store.writeSheet('physik-1', mkSheet('ub01', 1));
  store.writeSheet('physik-1', mkSheet('ub02', 2));
  assert.deepEqual(store.nextSheetIdentity('physik-1'), { number: 3, id: 'ub03' });
});

t('写 sheet 会同步索引摘要（单一写入口）', () => {
  const s = mkSheet('ub03', 3, {
    problems: [
      mkProblem(0, { answer: 'x' }),
      mkProblem(1),
    ],
  });
  store.writeSheet('physik-1', s);
  const idx = store.readIndex('physik-1');
  const meta = idx.sheets.find((x) => x.id === 'ub03');
  assert.equal(meta.problem_count, 2);
  assert.equal(meta.answered_count, 1);
  assert.equal(meta.submitted, false);
  assert.deepEqual(idx.sheets.map((x) => x.number), [1, 2, 3]);
});

t('sheet 往返：题目/答案/检查/经验都保留', () => {
  const s = store.readSheet('physik-1', 'ub03');
  const p = s.problems[0];
  p.checks.push({
    id: 'c1',
    created_at: 1,
    model: 'm',
    verdict: 'wrong',
    score: 0.2,
    issues: [{ severity: 'error', text: '符号错了' }],
    hints: ['先判方向'],
    next_steps: ['重写第二行'],
    raw: '{}',
    answer_sha: 'abc',
    stale: false,
  });
  s.lessons.push({ id: 'l1', text: '先判守恒条件', tags: ['角动量'], source: 'user', created_at: 2, in_worldbook: false });
  store.writeSheet('physik-1', s);
  const back = store.readSheet('physik-1', 'ub03');
  assert.equal(back.problems[0].checks[0].verdict, 'wrong');
  assert.equal(back.problems[0].checks[0].issues[0].text, '符号错了');
  assert.equal(back.lessons[0].text, '先判守恒条件');
  assert.equal(store.listSheets('physik-1').length, 3);
});

t('BOM 与坏 schema：读不出但不抛', () => {
  const file = join(root, 'physik-1', 'bad.json');
  writeFileSync(file, '', 'utf-8');
  const idxFile = join(root, 'physik-1', 'index.json');
  const cur = readFileSync(idxFile, 'utf-8');
  writeFileSync(idxFile, `\uFEFF${cur}`, 'utf-8');
  assert.equal(store.readIndex('physik-1').course_id, 'physik-1');
  assert.equal(store.readSheet('physik-1', 'nope'), null);
});

t('findProblem / appendCheck / appendLesson', () => {
  const s = store.readSheet('physik-1', 'ub03');
  const p = store.findProblem(s, 'p01');
  assert.equal(p.label, 'Aufgabe 1');
  const after = store.appendCheck('physik-1', 'ub03', 'p01', {
    id: 'c2',
    created_at: 3,
    model: 'm',
    verdict: 'correct',
    score: 1,
    issues: [],
    hints: [],
    next_steps: [],
    raw: '',
    answer_sha: 'x',
    stale: false,
  });
  assert.equal(after.problems[0].checks.length, 2);
  const after2 = store.appendLesson('physik-1', 'ub03', {
    id: 'l2',
    text: '单位先统一',
    tags: [],
    source: 'user',
    created_at: 4,
    in_worldbook: false,
  });
  assert.equal(after2.lessons.length, 2);
  assert.throws(() => store.appendCheck('physik-1', 'ub03', 'p99', {}), /题目不存在/);
});

t('renderSheetMarkdown 含题目/答案/检查/经验', () => {
  const s = store.readSheet('physik-1', 'ub03');
  const course = store.readIndex('physik-1');
  const md = store.renderSheetMarkdown(course, s);
  assert.match(md, /Übungsblatt 3/);
  assert.match(md, /Aufgabe 1/);
  assert.match(md, /### 解答/);
  assert.match(md, /检查（correct）/);
  assert.match(md, /先判守恒条件/);
  // 导出只写**最近一次未过期**的检查；用内存对象构造一条错的，确认 issues 也会进导出
  const withWrong = {
    ...s,
    problems: s.problems.map((p) => ({
      ...p,
      checks: p.checks.length
        ? [{ ...p.checks[0], verdict: 'wrong', stale: false, issues: [{ severity: 'error', text: '符号错了' }] }]
        : [],
    })),
  };
  assert.match(store.renderSheetMarkdown(course, withWrong), /符号错了/);
});

t('原卷 PDF：小文件视为不存在（防 0 字节占位）', () => {
  assert.equal(store.hasSourcePdf('physik-1', 'ub03'), false);
  store.writeSourcePdf('physik-1', 'ub03', Buffer.alloc(4096, 1));
  assert.equal(store.hasSourcePdf('physik-1', 'ub03'), true);
});

t('错题本：upsert 去重 / patch / 查找 / 删除', () => {
  const base = {
    id: 'm1',
    course_id: 'physik-1',
    course_title: 'Physik I',
    sheet_id: 'ub03',
    sheet_title: 'Übungsblatt 3',
    sheet_due: '2026-10-08',
    problem_id: 'p01',
    problem_label: 'Aufgabe 1',
    problem_text: '',
    answer: '错的答案',
    verdict: 'wrong',
    issues: ['符号'],
    tags: ['角动量'],
    lesson: '',
    created_at: 10,
    updated_at: 10,
    review_count: 0,
    mastered: false,
    in_worldbook: false,
    source_check_id: 'c1',
  };
  store.upsertMistake(base);
  store.upsertMistake({ ...base, lesson: '我写的教训' });
  const list = store.readMistakes();
  assert.equal(list.length, 1);
  assert.equal(list[0].lesson, '我写的教训');
  assert.equal(list[0].created_at, 10);
  assert.equal(store.findMistakeFor('physik-1', 'ub03', 'p01').id, 'm1');
  const patched = store.patchMistake('m1', { mastered: true });
  assert.equal(patched.mastered, true);
  assert.equal(store.deleteMistake('m1'), true);
  assert.equal(store.readMistakes().length, 0);
});

t('deleteSheet / deleteCourse 移除文件与索引', () => {
  const sheetDir = join(root, 'physik-1', 'ub01');
  assert.equal(existsSync(sheetDir), true);
  assert.equal(store.deleteSheet('physik-1', 'ub01'), true);
  assert.equal(existsSync(sheetDir), false);
  assert.equal(store.readIndex('physik-1').sheets.some((s) => s.id === 'ub01'), false);
  assert.equal(store.deleteCourse('physik-1'), true);
  assert.equal(existsSync(join(root, 'physik-1')), false);
  assert.equal(store.listCourses().length, 0);
});

t('坏索引不会拖垮 listCourses', () => {
  const dir = join(root, 'broken');
  store.ensureCourse('broken', 'Broken');
  writeFileSync(join(dir, 'index.json'), '{ not json', 'utf-8');
  assert.equal(store.readIndex('broken'), null);
  assert.equal(store.listSheets('broken').length, 0);
});

rmSync(root, { recursive: true, force: true });
console.log(`\n[exercise-store] ${passed} 项断言通过`);
