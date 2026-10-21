// ============================================================
// test/check11.mjs — 纯文本导出（markdown，给 git 管理）
//
// 用户要求：「加一个导出为文本的功能，这样方便 git 管理」。
// 这里钉住三件让 git 好用的事：
//   ① 确定性：同样输入 → 同样字节（导出两次不会产生 diff）
//   ② 有内容：题干/答案/检查/经验/错题 都在，答案保留原始 LaTeX
//   ③ 只清理自己写过的文件：删掉套题 → 对应 md 被移除；
//      手动放进目录的文件绝不能被删
// ============================================================
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXPORT_HEADER,
  readManifest,
  renderCourseText,
  renderIndexText,
  renderMistakesText,
  renderSheetText,
  renderTextExport,
  syncTextExport,
} from '../lib/text-export.js';

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

// ---- 夹具：一门课 / 两套题 / 一条错题 ----
const course = {
  course_id: 'physik-1',
  title: 'Physik I',
  semester: 'WS 2026/27',
  module_code: 'PHY-1',
  sheets: [],
  created_at: 0,
  updated_at: 0,
};

const mkProblem = (id, label, text, answer, checks = [], lessons = []) => ({
  id,
  label,
  title: '',
  text,
  points: 4,
  page: 1,
  has_figure: false,
  figure_note: '',
  answer,
  answer_updated_at: 0,
  answer_edited_by: 'user',
  checks,
  mistakes: [],
  notes: '',
});

const check = (id, verdict, created_at) => ({
  id,
  created_at,
  model: 'deepseek-flash',
  verdict,
  score: 0.5,
  issues: [{ severity: 'error', text: '第二步符号错了' }],
  hints: ['如果把 $I$ 当常数，(2) 还成立吗？'],
  next_steps: ['先对 $\\dot\\omega$ 求导'],
  raw: '',
  answer_sha: '',
  stale: false,
});

const sheet1 = {
  id: 'ub01',
  number: 1,
  title: 'Mechanik',
  issued: '2026-10-15',
  due: '2026-10-22',
  source_pdf: 'source.pdf',
  source_pages: 2,
  import_mode: 'pdf',
  split_by: 'vision',
  has_page_images: true,
  imported_at: 0,
  needs_manual_text: false,
  progress_digest: '上次卡在：角动量',
  progress_digest_at: 0,
  problems: [
    mkProblem('p01', 'Aufgabe 1', 'Ein Körper gleitet eine schiefe Ebene hinab.\n\na) $a = ?$', 'a = $g\\sin\\alpha$', [check('c1', 'partial', 1792529000000)], []),
    mkProblem('p02', 'Aufgabe 2', 'Pendel: $T = ?$', '', []),
  ],
  lessons: [{ id: 'l1', text: '先判守恒条件再选轴', tags: [], source: 'user', created_at: 0, in_worldbook: true }],
  submitted_at: 0,
  submission_pdf: '',
  submission_pages: 0,
  version: 1,
};

const sheet2 = {
  ...sheet1,
  id: 'ub02',
  number: 2,
  title: 'Schwingungen',
  problems: [mkProblem('p01', 'Aufgabe 1', 'Federpendel', 'ok', [])],
  lessons: [],
};

const mistake = {
  id: 'm1',
  course_id: 'physik-1',
  course_title: 'Physik I',
  sheet_id: 'ub01',
  sheet_title: 'Mechanik',
  sheet_due: '2026-10-22',
  problem_id: 'p01',
  problem_label: 'Aufgabe 1',
  problem_text: 'Ein Körper gleitet eine schiefe Ebene hinab.',
  answer: 'a = $g\\sin\\alpha$',
  verdict: 'partial',
  issues: ['第二步符号错了'],
  tags: ['Mechanik'],
  lesson: '受力图先画全',
  created_at: 1792529000000,
  updated_at: 1792529400000,
  review_count: 0,
  mastered: false,
  in_worldbook: true,
  source_check_id: 'c1',
};

const input = { courses: [{ index: course, sheets: [sheet2, sheet1] }], mistakes: [mistake] };

t('renderSheetText：元信息 + 题干 + 解答（保留 LaTeX）+ 检查 + 经验', () => {
  const md = renderSheetText(course, sheet1, [mistake]);
  assert.ok(md.startsWith(EXPORT_HEADER));
  assert.match(md, /# Physik I · Übungsblatt 1 — Mechanik/);
  assert.match(md, /\| 进度 \| 1\/2 题有答案/);
  assert.match(md, /### Aufgabe 1（4 P）/);
  assert.match(md, /\$g\\sin\\alpha\$/, '答案里的 LaTeX 要原样保留');
  assert.match(md, /\*\*检查记录\*\*（1 次）/);
  assert.match(md, /- 提示：如果把 \$I\$ 当常数/);
  assert.match(md, /\*\*错题\*\*/);
  assert.match(md, /## 这套题教会我什么/);
  assert.match(md, /先判守恒条件再选轴/);
  assert.match(md, /_（未作答）_/);
});

t('renderCourseText：套题按编号排序、链接到 md', () => {
  const md = renderCourseText(course, [sheet2, sheet1]);
  assert.match(md, /\| 1 \| Mechanik \| 2026-10-22 \| 1\/2 \| \[ub01\]\(\.\/ub01\.md\) \|/);
  const i1 = md.indexOf('ub01.md');
  const i2 = md.indexOf('ub02.md');
  assert.ok(i1 > 0 && i2 > i1, '套题表要按编号升序');
});

t('renderMistakesText：未掌握优先，带结论/教训', () => {
  const md = renderMistakesText([mistake]);
  assert.match(md, /未掌握 1 条/);
  assert.match(md, /结论：部分正确/);
  assert.match(md, /教训：受力图先画全/);
});

t('renderIndexText：总览统计（课程/套数/错题）', () => {
  const md = renderIndexText([{ index: course, sheets: [sheet1, sheet2] }], [mistake]);
  assert.match(md, /共 1 门课 \/ 2 套题 \/ 1 条错题/);
  assert.match(md, /\[Physik I\]\(\.\/physik-1\/README\.md\)/);
});

t('renderTextExport：路径约定 + 内容确定性（两次结果完全相同）', () => {
  const a = renderTextExport(input);
  const b = renderTextExport(input);
  assert.deepEqual([...a.keys()].sort(), ['README.md', 'mistakes.md', 'physik-1/README.md', 'physik-1/ub01.md', 'physik-1/ub02.md']);
  for (const k of a.keys()) assert.equal(a.get(k), b.get(k), `文件 ${k} 两次渲染不一致`);
  assert.ok(!/\d{2}:\d{2}:\d{2}/.test(a.get('README.md')), '总览里不能有随机器时间');
});

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'ex-text-export-'));

await asyncT('syncTextExport：首次写出全部文件 + 相同内容第二次算 unchanged', async () => {
  const dir = tmpRoot();
  try {
    const files = renderTextExport(input);
    const first = syncTextExport(dir, files);
    assert.equal(first.written.length, files.size);
    assert.equal(first.unchanged.length, 0);
    assert.ok(existsSync(join(dir, 'README.md')));
    assert.ok(existsSync(join(dir, 'physik-1', 'ub01.md')));
    const second = syncTextExport(dir, files);
    assert.equal(second.written.length, 0, '内容没变不应重写');
    assert.equal(second.unchanged.length, files.size);
    assert.deepEqual(readManifest(dir), [...files.keys()].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await asyncT('syncTextExport：内容变了一个文件只重写它', async () => {
  const dir = tmpRoot();
  try {
    const files = renderTextExport(input);
    syncTextExport(dir, files);
    const edited = new Map(files);
    edited.set('physik-1/ub01.md', `${files.get('physik-1/ub01.md')}\n多一行\n`);
    const r = syncTextExport(dir, edited);
    assert.deepEqual(r.written, ['physik-1/ub01.md']);
    assert.ok(r.unchanged.length >= 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await asyncT('syncTextExport：删掉套题后移除对应 md，且不碰手工文件', async () => {
  const dir = tmpRoot();
  try {
    syncTextExport(dir, renderTextExport(input));
    const keep = join(dir, 'physik-1', 'notes-by-hand.md');
    writeFileSync(keep, '我自己写的\n', 'utf-8');
    // 第二套题被删掉
    const shrunk = renderTextExport({ courses: [{ index: course, sheets: [sheet1] }], mistakes: [mistake] });
    const r = syncTextExport(dir, shrunk);
    assert.deepEqual(r.removed, ['physik-1/ub02.md']);
    assert.ok(!existsSync(join(dir, 'physik-1', 'ub02.md')));
    assert.ok(existsSync(keep), '手工文件不能被删');
    assert.ok(existsSync(join(dir, 'physik-1', 'ub01.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await asyncT('syncTextExport：manifest 损坏也能继续导出', async () => {
  const dir = tmpRoot();
  try {
    mkdirSync(join(dir, 'physik-1'), { recursive: true });
    writeFileSync(join(dir, '.manifest.json'), '{ 坏掉的 json', 'utf-8');
    const r = syncTextExport(dir, renderTextExport(input));
    assert.equal(r.written.length, 5);
    assert.deepEqual(readManifest(dir).length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await asyncT('syncTextExport：`..` 越界的旧清单项不会被删', async () => {
  const dir = tmpRoot();
  try {
    mkdirSync(join(dir, '..', 'ex-outside'), { recursive: true });
    const outside = join(dir, '..', 'ex-outside', 'keep.txt');
    writeFileSync(outside, 'x', 'utf-8');
    // 伪造一份指向外部的 manifest
    writeFileSync(join(dir, '.manifest.json'), JSON.stringify({ version: 1, files: ['../ex-outside/keep.txt'] }), 'utf-8');
    syncTextExport(dir, renderTextExport(input));
    assert.ok(existsSync(outside), '越界的清单项不能被删');
    rmSync(join(dir, '..', 'ex-outside'), { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t('导出内容里带"请勿手改"提示', () => {
  const files = renderTextExport(input);
  for (const [name, content] of files) {
    assert.ok(content.startsWith(EXPORT_HEADER), `${name} 缺少自动生成声明`);
  }
});

console.log(`\n[exercise-text-export] ${passed} 项断言通过`);
