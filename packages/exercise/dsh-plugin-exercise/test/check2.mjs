// ============================================================
// check2.mjs — PDF 文本清洗 + 切题 单测
//
// 为什么这里**不测 extractPdfText**：它要真 PDF + pdfjs worker，仓库里没有
// fixture PDF。逻辑可测的部分全部下沉到 normalizePdfText / splitProblems
// 这两个纯函数（真实 PDF 的端到端验证在导入流程里做）。
//
// 注意：import 的是 ../lib/（tsc 产物），改 src 后必须先 npm run build。
// ============================================================
import assert from 'node:assert/strict';
import { normalizePdfText } from '../lib/pdf-text.js';
import { splitProblems, splitByFallback } from '../lib/split.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ============================================================
// 一、文本清洗（normalizePdfText）
// ============================================================

t('连字（ﬁ ﬂ ﬀ ﬃ ﬄ）展开成 ASCII', () => {
  assert.equal(normalizePdfText('ﬁnal ﬂow ﬀ ﬃ ﬄ'), 'final flow ff ffi ffl');
});

t('CRLF / 裸 CR 统一为 LF', () => {
  assert.equal(normalizePdfText('a\r\nb\rc'), 'a\nb\nc');
});

t('软连字符 \\u00ad 直接删除', () => {
  assert.equal(normalizePdfText('Silben\u00adtrennung'), 'Silbentrennung');
});

t('行尾连字符 + 小写续行 → 合并（并去掉续行缩进）', () => {
  assert.equal(normalizePdfText('Bestim-\n  men Sie die Kraft.'), 'Bestimmen Sie die Kraft.');
});

t('连字符后接大写 → 不合并（德语复合词/并列）', () => {
  assert.equal(normalizePdfText('Energie-\nErhaltung'), 'Energie-\nErhaltung');
});

t('连字符后接空行 → 不合并', () => {
  assert.equal(normalizePdfText('a-\n\nb'), 'a-\n\nb');
});

t('行内多空格/制表符折叠 + 行尾空白删除', () => {
  assert.equal(normalizePdfText('Die   Kraft\t\tF   \nist 0\t'), 'Die Kraft F\nist 0');
});

t('裸页码行（纯数字 ≤3 位 + 前后空行）删除', () => {
  assert.equal(normalizePdfText('Text A\n\n3\n\nText B'), 'Text A\n\nText B');
});

t('被正文包围的数字（非页码形态）保留', () => {
  assert.equal(normalizePdfText('Kapitel\n3\nSeite'), 'Kapitel\n3\nSeite');
});

t('四位数不是页码，保留', () => {
  assert.equal(normalizePdfText('Text\n\n1234\n\nText'), 'Text\n\n1234\n\nText');
});

t('连续空行折叠为一个空行', () => {
  assert.equal(normalizePdfText('a\n\n\n\n\nb'), 'a\n\nb');
});

t('空输入 / 非字符串 → 空串', () => {
  assert.equal(normalizePdfText(''), '');
  assert.equal(normalizePdfText(undefined), '');
  assert.equal(normalizePdfText(null), '');
});

t('公式（LaTeX）内容不被改写', () => {
  assert.equal(normalizePdfText('$F = m\\cdot a$   gilt.'), '$F = m\\cdot a$ gilt.');
});

// ============================================================
// 二、切题（splitProblems / splitByFallback）
// ============================================================

// 一份典型的德语作业：表头 + 三题，分值写法各不相同（行内 / 末尾 / 没有）
const deSheet = [
  'Universität Hamburg',
  'Physik I — Übungsblatt 3',
  '',
  'Aufgabe 1 (4 Punkte)',
  'Berechnen Sie die Kraft.',
  'a) Zerlegen Sie den Vektor.',
  'b) Bestimmen Sie den Betrag.',
  '',
  'Aufgabe 2:',
  'Ein Körper fällt.',
  '(6 P)',
  '',
  'Aufg. 3',
  'Was ist die Arbeit?',
].join('\n');

t('德语题号识别：Aufgabe / Aufgabe: / Aufg.', () => {
  const p = splitProblems(deSheet);
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((x) => x.label), ['Aufgabe 1', 'Aufgabe 2', 'Aufg. 3']);
});

t('标题 = 题干首行去掉题号前缀', () => {
  const p = splitProblems(deSheet);
  assert.equal(p[0].title, 'Berechnen Sie die Kraft.');
});

t('子问 a) / b) 留在父题里，不额外切分', () => {
  const p = splitProblems(deSheet);
  assert.equal(p.length, 3);
  assert.ok(p[0].text.includes('a) Zerlegen Sie den Vektor.'));
  assert.ok(p[0].text.includes('b) Bestimmen Sie den Betrag.'));
});

t('题号独占一行（Aufgabe 2:）时标题回退到下一行', () => {
  const p = splitProblems(deSheet);
  assert.equal(p[1].title, 'Ein Körper fällt.');
});

t('分值解析：行内 4 Punkte / 题尾 6 P / 无分值为 null', () => {
  const p = splitProblems(deSheet);
  assert.equal(p[0].points, 4);
  assert.equal(p[1].points, 6);
  assert.equal(p[2].points, null);
});

t('作业表头（第一题之前的内容）不进入任何题', () => {
  const p = splitProblems(deSheet);
  assert.ok(!p[0].text.includes('Übungsblatt'));
  assert.ok(p[0].text.startsWith('Aufgabe 1'));
});

const enSheet = ['Exercise 1 [2 P]', 'Show that A = B.', '', 'Problem 3', 'Find x.', '', 'Task 5 (10 Punkte)', 'Prove it.'].join('\n');

t('英语题号识别：Exercise / Problem / Task', () => {
  const p = splitProblems(enSheet);
  assert.deepEqual(p.map((x) => x.label), ['Exercise 1', 'Problem 3', 'Task 5']);
});

t('英语分值：[2 P] → 2，无分值 → null，(10 Punkte) → 10', () => {
  const p = splitProblems(enSheet);
  assert.deepEqual(p.map((x) => x.points), [2, null, 10]);
});

t('变音符与 ASCII 变体：Übung / Uebung / Hausaufgabe', () => {
  const p = splitProblems(['Übung 1', 'Erste Aufgabe.', '', 'Uebung 2', 'Zweite.', '', 'Hausaufgabe 3', 'Dritte.'].join('\n'));
  assert.deepEqual(p.map((x) => x.label), ['Übung 1', 'Uebung 2', 'Hausaufgabe 3']);
});

t('markdown 粗体题号（**Aufgabe 4**）也能识别', () => {
  const p = splitProblems('**Aufgabe 4** (2 Punkte)\nBerechne.');
  assert.equal(p.length, 1);
  assert.equal(p[0].label, 'Aufgabe 4');
  assert.equal(p[0].points, 2);
  assert.equal(p[0].title, 'Berechne.');
});

t('行内引用（Wie in Aufgabe 1 …）不切分', () => {
  const p = splitProblems('Aufgabe 1\nZeigen Sie alles.\nWie in Aufgabe 1 gezeigt, gilt x = 1.');
  assert.equal(p.length, 1);
  assert.ok(p[0].text.includes('Wie in Aufgabe 1'));
});

t('行首但后接小写动词的引用（Aufgabe 1 zeigt …）不切分', () => {
  const p = splitProblems('Aufgabe 1\nBerechnen Sie x.\nAufgabe 1 zeigt, dass y > 0.');
  assert.equal(p.length, 1);
  assert.ok(p[0].text.includes('zeigt, dass'));
});

t('子问标记 a) / (b) / i. 不触发切分', () => {
  const p = splitProblems('Aufgabe 1\na) erstens\n(b) zweitens\ni. drittens\nAufgabe 2\nnoch was');
  assert.deepEqual(p.map((x) => x.label), ['Aufgabe 1', 'Aufgabe 2']);
  assert.ok(p[0].text.includes('i. drittens'));
});

t('页码：按 \\f 计数，跨页依次为 1 / 2 / 3', () => {
  const p = splitProblems('Aufgabe 1\nText eins.\n\f\nAufgabe 2\nText zwei.\n\f\nAufgabe 3\nText drei.');
  assert.deepEqual(p.map((x) => x.page), [1, 2, 3]);
});

t('紧贴 \\f 的题号也算行首（\fAufgabe 2）', () => {
  const p = splitProblems('Aufgabe 1\nA\n\fAufgabe 2\nB');
  assert.deepEqual(p.map((x) => x.page), [1, 2]);
  assert.deepEqual(p.map((x) => x.label), ['Aufgabe 1', 'Aufgabe 2']);
});

t('题干里不留 \\f（换成空行）', () => {
  const p = splitProblems('Aufgabe 1\nText eins.\n\f\nAufgabe 2\nText zwei.');
  assert.ok(!p[0].text.includes('\f'));
});

t('纯数字兜底切分（1. / 2. / 3)）', () => {
  const p = splitProblems('1. Berechne x.\n2. Berechne y.\n3) Berechne z.');
  assert.deepEqual(p.map((x) => x.label), ['1', '2', '3']);
  assert.deepEqual(p.map((x) => x.title), ['Berechne x.', 'Berechne y.', 'Berechne z.']);
});

t('兜底需要 ≥2 个编号，单个不切（交给调用方整段当一题）', () => {
  assert.deepEqual(splitByFallback('1. nur eins'), []);
});

t('关键词题号存在时，数字编号不参与切分', () => {
  const mixed = 'Aufgabe 1\nErster Text.\n2. zweiter Punkt';
  assert.equal(splitProblems(mixed).length, 1);
  assert.deepEqual(splitByFallback(mixed), []); // 只有一个数字编号
});

t('没有任何题号 → 返回 []（不替调用方做"整段一题"的决定）', () => {
  assert.deepEqual(splitProblems('Nur Fließtext ohne Nummerierung.'), []);
});

t('空输入 → []', () => {
  assert.deepEqual(splitProblems(''), []);
  assert.deepEqual(splitProblems('   \n\n  '), []);
  assert.deepEqual(splitByFallback(''), []);
});

t('题干保留换行与原始 LaTeX', () => {
  const p = splitProblems('Aufgabe 1\n$E = mc^2$\nZeigen Sie: $\\int_0^1 x\\,dx = \\tfrac12$.');
  assert.equal(p.length, 1);
  assert.ok(p[0].text.includes('$E = mc^2$'));
  assert.ok(p[0].text.includes('\\int_0^1'));
  assert.equal(p[0].text.split('\n').length, 3);
});

t('标题超过 80 字符时截断', () => {
  const p = splitProblems(`Aufgabe 1: ${'A'.repeat(120)}`);
  assert.equal(p[0].title.length, 80);
  assert.ok(p[0].title.endsWith('…'));
});

t('分值变体：2,5 Punkte → 2.5 / （4 分）→ 4', () => {
  assert.equal(splitProblems('Aufgabe 1 (2,5 Punkte)\nText.').at(0).points, 2.5);
  assert.equal(splitProblems('Aufgabe 1（4 分）\nText.').at(0).points, 4);
});

console.log(`\n[exercise-pdf] ${passed} 项断言通过`);
