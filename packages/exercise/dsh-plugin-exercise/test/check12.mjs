// ============================================================
// test/check12.mjs — 批改 prompt 的口径 + 答辩（对线）解析
//
// 用户反馈（2026-10-22）：
//   ① "检查答案跟智障一样，模板答案都是错误一堆" → prompt 必须要求"先独立解一遍"，
//      且明确"记号/详略/单位不算错"、"对就说对（issues 留空）"；
//   ② "历史错误改了之后还是说我有原来的错误" → 历史错题必须标成"过去"，不得当成本次错误；
//   ③ "和爱弥斯对线答辩" → 答辩 prompt 要求重新推导，必须承认（conceded）或给证据（upheld）。
// ============================================================
import assert from 'node:assert/strict';
import { buildCheckPrompt, buildRebuttalPrompt, parseRebuttal } from '../lib/checker.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const base = {
  courseTitle: 'Physik I',
  sheetNumber: 3,
  sheetTitle: 'Mechanik',
  problemLabel: 'Aufgabe 1',
  problemTitle: '',
  points: 4,
  problemText: 'Ein Körper gleitet eine schiefe Ebene hinab. Bestimmen Sie $a$.',
  answer: '$a = g\\sin\\alpha$',
};

t('检查 prompt：要求先独立解一遍，再对照（避免逐行找不同）', () => {
  const p = buildCheckPrompt(base);
  assert.match(p, /先自己独立解一遍/);
  assert.match(p, /再对照学生答案/);
  assert.match(p, /学生的结论与关键步骤和你一致 → `correct`，issues 留空/);
});

t('检查 prompt：只有数学不成立才算错；记号/详略/单位归 hints', () => {
  const p = buildCheckPrompt(base);
  assert.match(p, /只有数学上不成立才算 `error`/);
  assert.match(p, /记号写法/);
  assert.match(p, /步骤详略、单位写不写/);
  assert.match(p, /1% 内 → 不算错/);
});

t('检查 prompt：issue 要引用原话（可核查，不许空泛）', () => {
  const p = buildCheckPrompt(base);
  assert.match(p, /引用学生原话/);
  assert.match(p, /最多 3 条/);
});

t('检查 prompt：历史错题被标成"过去"，不得当作本次答案的错误', () => {
  const p = buildCheckPrompt({ ...base, priorMistakes: ['Aufgabe 1：把 $\\omega$ 当常数'] });
  assert.match(p, /\*\*过去的\*\*错题记录/);
  assert.match(p, /不得\*\*把它们当成当前答案的错误/);
  assert.match(p, /把 \$\\omega\$ 当常数/);
});

t('检查 prompt：带原图时声明"以图片为准"', () => {
  const p = buildCheckPrompt({ ...base, pageImage: { base64: 'x', mediaType: 'image/jpeg', page: 2 } });
  assert.match(p, /本题原图见附件/);
  assert.match(p, /以图片为准/);
});

const previous = {
  verdict: 'wrong',
  issues: [
    { severity: 'error', text: '把法向力当成了沿斜面方向的分量' },
    { severity: 'warn', text: '缺少单位' },
  ],
};

t('答辩 prompt：要求重新独立推导、把原判当作"被质疑的主张"', () => {
  const p = buildRebuttalPrompt({ check: base, previous, userText: '这里 $N = mg\\cos\\alpha$ 是对的' });
  assert.match(p, /忘掉之前的结论，从题目条件重新独立推导/);
  assert.match(p, /被质疑的主张/);
  assert.match(p, /\[0\] \(error\) 把法向力当成了沿斜面方向的分量/);
  assert.match(p, /\[1\] \(warn\) 缺少单位/);
  assert.match(p, /这里 \$N = mg\\cos\\alpha\$ 是对的/);
});

t('答辩 prompt：三种结局的定义（认错 / 坚持要证据 / 各有对错）', () => {
  const p = buildRebuttalPrompt({ check: base, previous, userText: 'x' });
  assert.match(p, /conceded/);
  assert.match(p, /upheld/);
  assert.match(p, /partial/);
  assert.match(p, /代入具体数值/);
  assert.match(p, /不允许\*\*只重复原结论/);
});

t('答辩 prompt：带上历史轮次，避免每轮都从零开始', () => {
  const p = buildRebuttalPrompt({
    check: base,
    previous,
    userText: '第二轮',
    history: [{ user: '第一轮我说了 X', ai: '我坚持 Y', outcome: 'upheld' }],
  });
  assert.match(p, /之前几轮答辩/);
  assert.match(p, /第一轮我说了 X/);
});

t('parseRebuttal：解析认错（带撤回下标）', () => {
  const r = parseRebuttal(
    JSON.stringify({ outcome: 'conceded', reply: '你说得对，我看错了分母', withdrawn: [0], remaining: [], correct_parts: ['$N=mg\\cos\\alpha$'] }),
  );
  assert.ok(r);
  assert.equal(r.outcome, 'conceded');
  assert.deepEqual(r.withdrawn, [0]);
  assert.equal(r.correct_parts.length, 1);
});

t('parseRebuttal：解析坚持（带 remaining）', () => {
  const r = parseRebuttal(
    JSON.stringify({
      outcome: 'upheld',
      reply: '代入 $\\alpha=30^\\circ$ 得 $a=4.9$，你的 $a=9.8$ 是分母漏了 $m$',
      withdrawn: [],
      remaining: [{ severity: 'error', text: '少了 1/2 的系数' }],
    }),
  );
  assert.ok(r);
  assert.equal(r.outcome, 'upheld');
  assert.equal(r.remaining[0].text, '少了 1/2 的系数');
});

t('parseRebuttal：容忍代码块包裹与字符串形式的 remaining', () => {
  const r = parseRebuttal(
    '```json\n{"outcome":"partial","reply":"对了一半","remaining":["分母符号错"],"withdrawn":[]}\n```',
  );
  assert.ok(r);
  assert.equal(r.outcome, 'partial');
  assert.equal(r.remaining[0].text, '分母符号错');
});

t('parseRebuttal：未知 outcome 归为 partial，非法输入返回 null', () => {
  const r = parseRebuttal('{"outcome":"whatever","reply":"…"}');
  assert.ok(r);
  assert.equal(r.outcome, 'partial');
  assert.equal(parseRebuttal('抱歉我无法回答'), null);
  assert.equal(parseRebuttal('{"outcome":"conceded"'), null);
});

console.log(`\n[exercise-checker-prompt] ${passed} 项断言通过`);
