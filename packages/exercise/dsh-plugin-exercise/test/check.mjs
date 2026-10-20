// ============================================================
// test/check.mjs — types / digest 纯函数
// 为什么纯断言脚本而不是 node:test：沙箱下 node --test 的子进程会被 EPERM 拒，
// 全仓库统一用这种零依赖脚本（见 docs/PROJECT_REPORT.md 的"已知坑"）。
// ============================================================
import assert from 'node:assert/strict';
import {
  problemStatus,
  sheetProgress,
  normalizeAnswer,
  deriveTitle,
  parsePoints,
  shouldCollectMistake,
  lastFreshCheck,
  mistakeIdAt,
  submissionFileName,
  emptyCourseIndex,
} from '../lib/types.js';
import { buildProgressDigest, daysUntil, topTags, nextActionHint } from '../lib/digest.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const check = (verdict, extra = {}) => ({
  id: `c-${Math.random().toString(36).slice(2)}`,
  created_at: Date.now(),
  model: 'test',
  verdict,
  score: null,
  issues: [],
  hints: [],
  next_steps: [],
  raw: '',
  answer_sha: 'abc',
  stale: false,
  ...extra,
});

const problem = (over = {}) => ({
  id: 'p01',
  label: 'Aufgabe 1',
  title: '',
  text: 'Berechne $F=ma$',
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

const sheet = (over = {}) => ({
  id: 'ub01',
  number: 1,
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

// ── 状态派生 ──
t('没有答案 → todo', () => {
  assert.equal(problemStatus(problem()), 'todo');
  assert.equal(problemStatus(problem({ answer: '   ' })), 'todo');
});

t('有答案、无检查 → answered', () => {
  assert.equal(problemStatus(problem({ answer: 'x=2' })), 'answered');
});

t('检查 correct → checked', () => {
  assert.equal(problemStatus(problem({ answer: 'x=2', checks: [check('correct')] })), 'checked');
});

t('检查 wrong/partial → needs_fix', () => {
  assert.equal(problemStatus(problem({ answer: 'x=2', checks: [check('wrong')] })), 'needs_fix');
  assert.equal(problemStatus(problem({ answer: 'x=2', checks: [check('partial')] })), 'needs_fix');
});

t('检查 unclear → 退回 answered（不冒充通过）', () => {
  assert.equal(problemStatus(problem({ answer: 'x=2', checks: [check('unclear')] })), 'answered');
});

t('答案改了：旧检查 stale → 不再影响状态', () => {
  const p = problem({ answer: 'x=3', checks: [check('correct', { stale: true })] });
  assert.equal(problemStatus(p), 'answered');
  assert.equal(lastFreshCheck(p.checks), null);
});

t('lastFreshCheck 取最近一条未过期', () => {
  const fresh = check('wrong');
  const p = problem({ checks: [check('correct'), fresh, check('partial', { stale: true })] });
  assert.equal(lastFreshCheck(p.checks).id, fresh.id);
});

// ── 进度 ──
t('sheetProgress 统计正确', () => {
  const s = sheet({
    problems: [
      problem({ id: 'p01', answer: 'a', checks: [check('correct')] }),
      problem({ id: 'p02', answer: 'b', checks: [check('wrong')] }),
      problem({ id: 'p03' }),
      problem({ id: 'p04', answer: 'c' }),
    ],
  });
  const p = sheetProgress(s);
  assert.equal(p.total, 4);
  assert.equal(p.answered, 3);
  assert.equal(p.checked, 1);
  assert.equal(p.needsFix, 1);
  // (answered + checked) / (total*2) = (3+1)/8 = 50%
  assert.equal(p.percent, 50);
});

t('空题集 percent 为 0（不除零）', () => {
  assert.equal(sheetProgress(sheet()).percent, 0);
});

// ── 文本工具 ──
t('normalizeAnswer 只规范化空白，不改内容', () => {
  assert.equal(normalizeAnswer('  a  \r\n\r\n\r\nb  '), 'a\n\nb');
  assert.equal(normalizeAnswer('$x^2$'), '$x^2$');
});

t('deriveTitle 取首个非空行并去掉 #', () => {
  assert.equal(deriveTitle('\n\n## 角动量\n尾巴'), '角动量');
  assert.equal(deriveTitle('   '), '');
  assert.equal(deriveTitle('x'.repeat(100)).endsWith('…'), true);
});

t('parsePoints 认德语/中文分值', () => {
  assert.equal(parsePoints('(4 Punkte)'), 4);
  assert.equal(parsePoints('6 P'), 6);
  assert.equal(parsePoints('共 5 分'), 5);
  assert.equal(parsePoints('3,5 Punkte'), 3.5);
  assert.equal(parsePoints('没有分值'), null);
});

t('submissionFileName 安全且稳定', () => {
  const n = submissionFileName('physik-1', { id: 'ub03', number: 3, title: 'Mechanik' });
  assert.equal(n, 'physik-1-ub03-submission.pdf');
  assert.equal(submissionFileName('a/b', { id: 'ub 3', number: 3, title: '' }), 'a-b-ub-3-submission.pdf');
});

t('mistakeIdAt 带日期与序号', () => {
  const id = mistakeIdAt(new Date(2026, 9, 20, 10).getTime(), 7);
  assert.equal(id, 'm20261020-007');
});

// ── 错题判定 ──
t('只有 wrong/partial 才值得进错题本', () => {
  assert.equal(shouldCollectMistake([check('wrong')]), true);
  assert.equal(shouldCollectMistake([check('partial')]), true);
  assert.equal(shouldCollectMistake([check('correct')]), false);
  assert.equal(shouldCollectMistake([check('error')]), false);
  assert.equal(shouldCollectMistake([check('wrong', { stale: true })]), false);
  assert.equal(shouldCollectMistake([]), false);
});

// ── 进度摘要 ──
t('daysUntil 计到当天结束（不因时区差一天）', () => {
  const now = new Date(2026, 9, 20, 12).getTime();
  assert.equal(daysUntil('2026-10-20', now), 0);
  assert.equal(daysUntil('2026-10-23', now), 3);
  assert.equal(daysUntil('2026-10-18', now), -2);
  assert.equal(daysUntil('', now), null);
  assert.equal(daysUntil('2026/10/23', now), null);
});

t('topTags 只数未掌握且按频次排序', () => {
  const mk = (tags, mastered) => ({
    id: Math.random().toString(36),
    course_id: 'c',
    course_title: '',
    sheet_id: 's',
    sheet_title: '',
    sheet_due: '',
    problem_id: 'p',
    problem_label: '',
    problem_text: '',
    answer: '',
    verdict: 'wrong',
    issues: [],
    tags,
    lesson: '',
    created_at: 0,
    updated_at: 0,
    review_count: 0,
    mastered,
    in_worldbook: false,
    source_check_id: '',
  });
  // 角动量出现两次（最高），量纲只在未掌握的那条里出现一次
  const tags = topTags([mk(['角动量', '量纲'], false), mk(['角动量'], false), mk(['量纲'], true)]);
  assert.deepEqual(tags, ['角动量', '量纲']);
});

t('buildProgressDigest：第一套题给"从零开始"的话术', () => {
  const d = buildProgressDigest({ sheets: [], mistakes: [], now: new Date(2026, 9, 20).getTime() });
  assert.match(d.text, /第一套/);
  assert.equal(d.stats.sheetsTotal, 0);
});

t('buildProgressDigest：上一套没做完 + 错题 + 课堂进度', () => {
  const now = new Date(2026, 9, 20, 12).getTime();
  const sheets = [
    sheet({
      id: 'ub01',
      number: 1,
      problems: [problem({ id: 'p01', answer: 'a', checks: [check('correct')] }), problem({ id: 'p02' })],
    }),
  ];
  const mistakes = [
    {
      id: 'm1',
      course_id: 'c',
      course_title: 'Physik I',
      sheet_id: 'ub01',
      sheet_title: 'Übungsblatt 1',
      sheet_due: '',
      problem_id: 'p02',
      problem_label: 'Aufgabe 2',
      problem_text: '',
      answer: '',
      verdict: 'wrong',
      issues: [],
      tags: ['量纲'],
      lesson: '先统一单位再代数',
      created_at: 0,
      updated_at: now,
      review_count: 0,
      mastered: false,
      in_worldbook: false,
      source_check_id: '',
    },
  ];
  const d = buildProgressDigest({
    sheets,
    mistakes,
    lecture: { reviewed: 2, total: 3, latest: { unit: 'u03', title: '角动量', date: '2026-10-15' } },
    now,
  });
  assert.match(d.text, /上次没做完/);
  assert.match(d.text, /1\/2/);
  assert.match(d.text, /错题本：1 条未掌握/);
  assert.match(d.text, /量纲/);
  assert.match(d.text, /最近一条教训/);
  assert.match(d.text, /已复盘 2\/3 讲/);
  assert.equal(d.stats.unmasteredMistakes, 1);
  assert.deepEqual(d.stats.topWeakTags, ['量纲']);
});

t('buildProgressDigest：全部提交后不再说"没做完"', () => {
  const d = buildProgressDigest({
    sheets: [sheet({ problems: [problem({ answer: 'a' })], submitted_at: 1 })],
    mistakes: [],
    now: Date.now(),
  });
  assert.doesNotMatch(d.text, /上次没做完/);
});

t('nextActionHint 按状态给动作', () => {
  assert.match(nextActionHint(sheet()), /还没有题目/);
  assert.match(nextActionHint(sheet({ problems: [problem()] })), /没写答案/);
  assert.match(nextActionHint(sheet({ problems: [problem({ answer: 'a', checks: [check('wrong')] })] })), /检查没过/);
  assert.match(nextActionHint(sheet({ problems: [problem({ answer: 'a', checks: [check('correct')] })] })), /生成提交 PDF/);
});

t('emptyCourseIndex 形状稳定', () => {
  const c = emptyCourseIndex('physik-1', 'Physik I', 'WiSe', 'PHY-101');
  assert.equal(c.version, 1);
  assert.deepEqual(c.sheets, []);
});

console.log(`\n[exercise-types] ${passed} 项断言通过`);
