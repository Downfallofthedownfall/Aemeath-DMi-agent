// ============================================================
// test/check18.mjs — 大题 / 小题（parts.ts）
//
// 用户 2026-11-20："题目做成大题中的小题也分开管理，这样子检查的时候不用重复检查正确的小题"。
//   · 认 a) / (a) / **a)** / a. / i) 标记，必须按顺序连续出现（宁可不拆也别拆错）
//   · 公式里的 f(a) 不算标记
//   · 拆已有的题：答案按 a) b) 分给小题，检查标过期；合并能原样拆回去
//   · "检查这道大题"跳过已经 correct 的小题
// ============================================================
import assert from 'node:assert/strict';
import {
  splitParts,
  splitProblemInSheet,
  mergeGroupInSheet,
  groupFreshProblems,
  statementFor,
  partsNeedingCheck,
  pruneEmptyGroups,
} from '../lib/parts.js';
import { sheetSchema } from '../lib/types.js';
import { buildSubmissionHtml } from '../lib/pdf-html.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const problem = (over = {}) => ({
  id: 'p01',
  label: 'Aufgabe 1',
  title: '',
  text: '',
  points: null,
  page: 2,
  has_figure: false,
  figure_note: '',
  answer: '',
  answer_updated_at: 0,
  answer_edited_by: 'user',
  checks: [],
  rebuttals: [],
  images: [],
  mistakes: [],
  notes: '',
  group: '',
  part: '',
  ...over,
});
const check = (verdict, over = {}) => ({
  id: `c-${verdict}-${Math.random()}`,
  created_at: 1,
  model: '',
  verdict,
  score: null,
  issues: [],
  hints: [],
  next_steps: [],
  raw: '',
  answer_sha: '',
  stale: false,
  provider: '',
  reasoning: '',
  withdrawn: [],
  remaining: [],
  rebutted_at: 0,
  ...over,
});
const sheetWith = (problems) => sheetSchema.parse({ id: 'ub01', problems });

const STATEMENT = [
  'Ein Körper der Masse $m$ gleitet eine schiefe Ebene hinab (Winkel $\\alpha$).',
  '',
  'a) Zeichnen Sie alle Kräfte ein. (2 Punkte)',
  'b) Berechnen Sie die Beschleunigung $a$.',
  '   Hinweis: reibungsfrei.',
  'c) Wie lange dauert es bis $s = 1\\,\\mathrm{m}$?',
].join('\n');

t('行首 a) b) c)：题干 + 三个小题，小题正文含续行', () => {
  const r = splitParts(STATEMENT);
  assert.ok(r);
  assert.match(r.stem, /^Ein Körper/);
  assert.deepEqual(r.parts.map((p) => p.key), ['a', 'b', 'c']);
  assert.match(r.parts[1].text, /Beschleunigung[\s\S]*reibungsfrei/);
});

t('其它写法：(a) / **a)** / a. / 罗马数字 / 接在句子后面', () => {
  assert.deepEqual(splitParts('Gegeben x.\n(a) eins\n(b) zwei').parts.map((p) => p.key), ['a', 'b']);
  assert.deepEqual(splitParts('**a)** eins\n**b)** zwei').parts.map((p) => p.key), ['a', 'b']);
  assert.deepEqual(splitParts('a. eins\nb. zwei').parts.map((p) => p.key), ['a', 'b']);
  assert.deepEqual(splitParts('Text\ni) eins\nii) zwei\niii) drei').parts.map((p) => p.key), ['i', 'ii', 'iii']);
  const inline = splitParts('Gegeben sei $f$. a) Zeigen Sie X. b) Berechnen Sie Y.');
  assert.deepEqual(inline.parts.map((p) => p.key), ['a', 'b']);
  assert.equal(inline.stem, 'Gegeben sei $f$.');
});

t('不拆：只有一个标记 / 不连续 / 公式里的 f(a) / 普通括号', () => {
  assert.equal(splitParts('a) nur eine Teilaufgabe'), null);
  assert.equal(splitParts('a) eins\nc) drei'), null);
  assert.equal(splitParts('Berechne $f(a)$ und $f(b)$ für alle Werte.'), null);
  assert.equal(splitParts('Die Fälle (a) und (b) sind gleich.'), null);
});

t('拆已有的题：答案按 a) b) 分给小题；检查/错题/附图归第一小题，检查标过期', () => {
  const s = sheetWith([
    problem({
      text: STATEMENT,
      points: 6,
      answer: 'Skizze siehe Bild\n\na) Gewicht, Normalkraft\nb) $a = g\\sin\\alpha$',
      answer_updated_at: 123,
      checks: [check('partial')],
      mistakes: ['m1'],
      images: [{ id: 'im1', name: 'x.png', media_type: 'image/png', bytes: 1, caption: '', role: 'answer', created_at: 1 }],
    }),
    problem({ id: 'p02', label: 'Aufgabe 2', text: 'Ohne Teilaufgaben.' }),
  ]);
  const ids = splitProblemInSheet(s, 'p01');
  assert.deepEqual(ids, ['p01a', 'p01b', 'p01c']);
  assert.deepEqual(s.problems.map((p) => p.id), ['p01a', 'p01b', 'p01c', 'p02'], '小题留在原位');
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].id, 'p01');
  assert.equal(s.groups[0].points, 6, '只有 a) 标了分 → 用原题的分值');
  assert.match(s.groups[0].text, /^Ein Körper/);
  const [a, b, c] = s.problems;
  assert.equal(a.label, 'Aufgabe 1 a)');
  assert.equal(a.points, 2, '小题自己的分值');
  assert.match(a.answer, /^Skizze siehe Bild\n\nGewicht/, '标记之前的部分并进第一小题');
  assert.equal(b.answer, '$a = g\\sin\\alpha$');
  assert.equal(c.answer, '');
  assert.equal(a.checks.length, 1);
  assert.equal(a.checks[0].stale, true, '评的是整道题 → 过期');
  assert.deepEqual(a.mistakes, ['m1']);
  assert.equal(a.images.length, 1);
  assert.equal(b.page, 2);
  assert.equal(splitProblemInSheet(s, 'p02'), null, '拆不开的不动');
  assert.equal(splitProblemInSheet(s, 'p01a'), null, '小题不能再拆');
});

t('合并：小题并回一道题，答案带 a) b) 前缀 —— 再拆一次能原样分回去', () => {
  const s = sheetWith([problem({ text: STATEMENT, answer: 'a) eins\nb) zwei' })]);
  splitProblemInSheet(s, 'p01');
  s.problems[2].answer = 'drei';
  const merged = mergeGroupInSheet(s, 'p01');
  assert.equal(merged.id, 'p01');
  assert.equal(s.groups.length, 0);
  assert.equal(s.problems.length, 1);
  assert.equal(merged.answer, 'a) eins\n\nb) zwei\n\nc) drei');
  assert.match(merged.text, /^Ein Körper[\s\S]*a\) Zeichnen[\s\S]*c\) Wie lange/);
  splitProblemInSheet(s, 'p01');
  assert.deepEqual(s.problems.map((p) => p.answer), ['eins', 'zwei', 'drei']);
});

t('大题分值：每个小题都标了分 → 取和（不是第一个小题的分）', () => {
  const text = ['Angabe.', 'a) eins (2 Punkte)', 'b) zwei (3 Punkte)'].join('\n');
  const r = groupFreshProblems([problem({ text, points: 2 })]);
  assert.equal(r.groups[0].points, 5);
});

t('新导入的题：能拆的自动拆，不能拆的原样', () => {
  const r = groupFreshProblems([problem({ text: STATEMENT }), problem({ id: 'p02', label: 'Aufgabe 2', text: 'Kurz.' })]);
  assert.deepEqual(r.problems.map((p) => p.id), ['p01a', 'p01b', 'p01c', 'p02']);
  assert.equal(r.groups.length, 1);
});

t('给模型的题目：小题 = 大题题干 + 本小题；前面小题的作答作上下文', () => {
  const s = sheetWith([problem({ text: STATEMENT, answer: 'a) Kräfte\nb) g sin' })]);
  splitProblemInSheet(s, 'p01');
  const st = statementFor(s, s.problems[1]);
  assert.match(st.text, /^Ein Körper[\s\S]*【b\)】 Berechnen/);
  assert.doesNotMatch(st.text, /Zeichnen Sie/, '别的小题的题目不进来');
  assert.deepEqual(st.earlier, [{ part: 'a', answer: 'Kräfte' }]);
  assert.equal(st.part, 'b');
  const plain = statementFor(s, problem({ id: 'p09', text: 'X' }));
  assert.equal(plain.text, 'X');
  assert.equal(plain.part, '');
});

t('"检查这道大题"：跳过 correct 的小题和空答案；correct 但答案改过（过期）的要重查', () => {
  const parts = [
    problem({ id: 'a', answer: 'x', checks: [check('correct')] }),
    problem({ id: 'b', answer: 'y', checks: [check('wrong')] }),
    problem({ id: 'c', answer: '' }),
    problem({ id: 'd', answer: 'z' }),
    problem({ id: 'e', answer: 'w', checks: [check('correct', { stale: true })] }),
  ];
  assert.deepEqual(partsNeedingCheck(parts).map((p) => p.id), ['b', 'd', 'e']);
});

t('删光小题的大题会被清掉', () => {
  const s = sheetWith([problem({ text: STATEMENT })]);
  splitProblemInSheet(s, 'p01');
  s.problems = [];
  pruneEmptyGroups(s);
  assert.deepEqual(s.groups, []);
});

t('提交 PDF：大题题干只印一次，在它的第一个小题前面', () => {
  const sp = (label, extra = {}) => ({ label, title: '', text: `${label} Text`, points: null, answer: 'x', ...extra });
  const html = buildSubmissionHtml({
    courseTitle: 'Physik I',
    courseId: 'physik-1',
    sheet: { id: 'ub01', number: 1, title: '', issued: '', due: '' },
    problems: [
      sp('Aufgabe 1 a)', { groupHead: { label: 'Aufgabe 1', title: '', text: 'GEMEINSAME ANGABE', points: 6 } }),
      sp('Aufgabe 1 b)'),
      sp('Aufgabe 2'),
    ],
  });
  assert.equal(html.split('GEMEINSAME ANGABE').length - 1, 1, '题干只印一次');
  assert.ok(html.indexOf('GEMEINSAME ANGABE') < html.indexOf('Aufgabe 1 a) Text'), '在第一个小题前面');
  assert.equal((html.match(/class="group-head"/g) ?? []).length, 1);
});

console.log(`\n[exercise-parts] ${passed} 项断言通过`);
