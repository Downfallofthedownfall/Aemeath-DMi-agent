// ============================================================
// check3.mjs — 转录员 / 五步复盘 / 握手 单测
// 重点验证三条硬约束：
//   D3  转录员越界护栏 + 输出解析
//   D4  摘要只在复盘第 4 步后允许生成
//   D12 第 3 步引导不得直接给答案
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTranscribePrompt,
  parseTranscribeOutput,
  transcribeChunk,
  looksLikeSummary,
  isOverExpanded,
  TRANSCRIBER_PROMPT,
} from '../lib/transcriber.js';
import { INSTITUTIONAL_NOTATION } from '../lib/symbol-data.js';
import { ReviewMachine, looksLikeDirectAnswer } from '../lib/review.js';
import { buildHandoff, filterReviewed, writeHandoff, readHandoff, describeHandoff } from '../lib/handoff.js';
import { parseShorthand } from '../lib/types.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};
const ta = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'lecture-test3-'));

// ============================================================
// 转录员（D3）
// ============================================================

t('TRANSCRIBER_PROMPT 含禁止项（防扩写）', () => {
  assert.match(TRANSCRIBER_PROMPT, /转录员/);
  assert.match(TRANSCRIBER_PROMPT, /不要补充任何用户没说过的/);
  assert.match(TRANSCRIBER_PROMPT, /不要生成/);
  assert.match(TRANSCRIBER_PROMPT, /待验证/); // 诚实标记
});

t('TRANSCRIBER_PROMPT 含记号约定（不许改记号）', () => {
  assert.match(TRANSCRIBER_PROMPT, /记号约定/);
  assert.match(TRANSCRIBER_PROMPT, /点号/); // 时间导数
  assert.match(TRANSCRIBER_PROMPT, /半箭头/); // 矢量（本校约定）
  assert.match(TRANSCRIBER_PROMPT, /d\/dx/); // 其余导数
});

t('记号约定段由 INSTITUTIONAL_NOTATION 生成（单一数据源，防漂移）', () => {
  // 若 prompt 与 symbol-data 各写一份，改一处就会漂移
  const n = INSTITUTIONAL_NOTATION;
  assert.ok(TRANSCRIBER_PROMPT.includes(n.timeDerivative), 'timeDerivative 未注入 prompt');
  assert.ok(TRANSCRIBER_PROMPT.includes(n.otherDerivative), 'otherDerivative 未注入 prompt');
  assert.ok(TRANSCRIBER_PROMPT.includes(n.vector), 'vector 未注入 prompt');
});

t('buildTranscribePrompt 保留标记语义', () => {
  const lines = parseShorthand('# 角动量\n= L = r × p\n? 为什么\n! 重点');
  const p = buildTranscribePrompt(lines);
  assert.match(p, /=L = r × p/);
  assert.match(p, /\?为什么/);
  assert.match(p, /!重点/);
  assert.match(p, /共 1 条/);
});

t('parseTranscribeOutput：纯 JSON', () => {
  const r = parseTranscribeOutput('{"formulas":[{"shorthand":"hbar^2/2m","latex":"\\\\frac{\\\\hbar^2}{2m}"}],"processed":"规范化文本"}');
  assert.ok(r);
  assert.equal(r.formulas.length, 1);
  assert.equal(r.formulas[0].shorthand, 'hbar^2/2m');
  assert.equal(r.processed, '规范化文本');
});

t('parseTranscribeOutput：带 ```json 围栏', () => {
  const r = parseTranscribeOutput('```json\n{"formulas":[],"processed":"x"}\n```');
  assert.ok(r);
  assert.equal(r.processed, 'x');
});

t('parseTranscribeOutput：前后有说明文字（抢救解析）', () => {
  const r = parseTranscribeOutput('好的，这是结果：\n{"formulas":[],"processed":"y"}\n以上。');
  assert.ok(r);
  assert.equal(r.processed, 'y');
});

t('parseTranscribeOutput：非法 JSON → null（不抛）', () => {
  assert.equal(parseTranscribeOutput('完全不是 JSON'), null);
  assert.equal(parseTranscribeOutput(null), null);
  assert.equal(parseTranscribeOutput(''), null);
});

t('parseTranscribeOutput：缺字段容错', () => {
  const r = parseTranscribeOutput('{"processed":"只有正文"}');
  assert.ok(r);
  assert.deepEqual(r.formulas, []);
  assert.equal(r.processed, '只有正文');
});

await ta('transcribeChunk：假 LLM 成功', async () => {
  const fake = async () => '{"formulas":[{"shorthand":"F=dp/dt","latex":"F = \\\\frac{dp}{dt}"}],"processed":"F = dp/dt 规范化"}';
  const r = await transcribeChunk('# 牛顿\n= F=dp/dt', fake);
  assert.ok(r);
  assert.equal(r.formulas.length, 1);
});

await ta('transcribeChunk：LLM 返回 null → null（优雅降级）', async () => {
  const fake = async () => null;
  assert.equal(await transcribeChunk('= x', fake), null);
});

await ta('transcribeChunk：空内容不调 LLM', async () => {
  let called = false;
  const fake = async () => {
    called = true;
    return '{}';
  };
  await transcribeChunk('   \n  ', fake);
  assert.equal(called, false);
});

t('looksLikeSummary 抓越界信号', () => {
  assert.equal(looksLikeSummary('核心概念：角动量守恒'), true);
  assert.equal(looksLikeSummary('本节小结'), true);
  assert.equal(looksLikeSummary('检查问题：为什么…'), true);
  assert.equal(looksLikeSummary('L = r × p'), false);
  assert.equal(looksLikeSummary('角动量定义，定轴转动'), false);
});

t('isOverExpanded 抓显著扩写', () => {
  assert.equal(isOverExpanded('L = r×p', 'L = r×p'), false);
  // 大幅扩写（远超 3 倍 + 200 字符）→ 判为越界
  assert.equal(isOverExpanded('短', '短'.repeat(500)), true);
  // 正常 LaTeX 补全（长度增加约 2 倍）不应误报
  assert.equal(isOverExpanded('hbar^2/2m', '\\frac{\\hbar^2}{2m}'), false);
});

// ============================================================
// 五步复盘（D4 / D12）
// ============================================================

t('复盘初始在 recall 步', () => {
  const m = new ReviewMachine('u01');
  assert.equal(m.step, 'recall');
  assert.equal(m.isDone, false);
});

t('D4：recall 步不允许生成摘要', () => {
  const m = new ReviewMachine('u01');
  assert.equal(m.canGenerateSummary(), false);
  assert.throws(() => m.buildCandidatesPrompt([], null), /不允许生成结构化摘要/);
});

t('D4：compare / repair 步仍不允许生成摘要', () => {
  const m = new ReviewMachine('u01');
  m.submitRecall('我记得角动量');
  assert.equal(m.canGenerateSummary(), false);
  m.setComparison({ remembered: [], missed: ['x'], wrong_or_vague: [] });
  assert.equal(m.canGenerateSummary(), false);
  assert.throws(() => m.buildCandidatesPrompt([], null));
});

t('D4：repair 完成后（candidates 步）才允许', () => {
  const m = new ReviewMachine('u01');
  m.submitRecall('r');
  m.setComparison({ remembered: [], missed: ['x'], wrong_or_vague: [] });
  assert.equal(m.canGenerateSummary(), false);
  m.finishRepair();
  assert.equal(m.canGenerateSummary(), true);
  assert.doesNotThrow(() => m.buildCandidatesPrompt([], null));
});

t('步骤顺序校验：不能跳步提交 recall', () => {
  const m = new ReviewMachine('u01');
  m.submitRecall('r');
  assert.throws(() => m.submitRecall('again'), /步骤不匹配/);
});

t('addRepairTurn 记录问答', () => {
  const m = new ReviewMachine('u01');
  m.submitRecall('r');
  m.setComparison({ remembered: [], missed: ['转动惯量'], wrong_or_vague: [] });
  m.addRepairTurn('转动惯量的定义是什么？', '是质量分布');
  assert.equal(m.current.repair_turns.length, 1);
  assert.equal(m.current.repair_turns[0].answer, '是质量分布');
});

t('buildComparePrompt 含学生回忆与记录', () => {
  const m = new ReviewMachine('u01');
  const chunks = [{ seq: 0, raw: '# 角动量\n= L = r × p', my_understanding: 'u', my_question: 'q', created_at: 0 }];
  const p = m.buildComparePrompt('我只记得 L = r × p', chunks);
  assert.match(p, /对照/);
  assert.match(p, /我只记得 L = r × p/);
  assert.match(p, /L = r × p/);
  assert.match(p, /remembered/);
});

t('D12：repair prompt 明确禁止给答案', () => {
  const m = new ReviewMachine('u01');
  m.submitRecall('r');
  m.setComparison({ remembered: [], missed: ['转动惯量'], wrong_or_vague: ['角动量方向'] });
  const p = m.buildRepairPrompt();
  assert.match(p, /不要给出答案/);
  // 注：早期这里断言的是"引导者"三个字。后来提示词重写（用户嫌追问太强迫症），
  // 那句话换成了"确认学生听懂了这节课该懂的"—— 语义仍然是不给答案、只提问。
  assert.match(p, /确认学生听懂了/);
  assert.match(p, /转动惯量/); // 只针对漏/错
  assert.match(p, /角动量方向/);
});

t('D12：looksLikeDirectAnswer 抓直答句式', () => {
  assert.equal(looksLikeDirectAnswer('答案是 2'), true);
  assert.equal(looksLikeDirectAnswer('正确结果是 L = Iω'), true);
  assert.equal(looksLikeDirectAnswer('推导如下：…'), true);
  assert.equal(looksLikeDirectAnswer('结论：角动量守恒'), true);
  assert.equal(looksLikeDirectAnswer('你觉得这个量和什么有关？'), false);
  assert.equal(looksLikeDirectAnswer('如果只有保守力做功，会怎样？'), false);
});

t('parseComparison：正常 JSON', () => {
  const c = ReviewMachine.parseComparison('{"remembered":["a"],"missed":["b"],"wrong_or_vague":["c"]}');
  assert.deepEqual(c.remembered, ['a']);
  assert.deepEqual(c.missed, ['b']);
  assert.deepEqual(c.wrong_or_vague, ['c']);
});

t('parseComparison：围栏 + 缺字段容错', () => {
  const c = ReviewMachine.parseComparison('```json\n{"missed":["x"]}\n```');
  assert.deepEqual(c.missed, ['x']);
  assert.deepEqual(c.remembered, []);
});

t('parseComparison：非法 → null', () => {
  assert.equal(ReviewMachine.parseComparison('nope'), null);
  assert.equal(ReviewMachine.parseComparison(null), null);
});

t('parseCandidates：完整解析', () => {
  const c = ReviewMachine.parseCandidates(
    JSON.stringify({
      worldbook_entries: [{ title: '角动量', content: 'L = r × p', topic: '力学' }],
      entity_claims: [{ entity: '用户', attribute: '薄弱点', value: '转动惯量' }],
      unresolved_questions: ['q1'],
      insights: ['i1'],
    }),
    'u01',
  );
  assert.ok(c);
  assert.equal(c.unit_id, 'u01');
  assert.equal(c.worldbook_entries[0].title, '角动量');
  assert.equal(c.entity_claims[0].attribute, '薄弱点');
  assert.deepEqual(c.unresolved_questions, ['q1']);
});

t('parseCandidates：过滤空内容条目', () => {
  const c = ReviewMachine.parseCandidates(
    JSON.stringify({ worldbook_entries: [{ title: 'x', content: '' }, { title: 'y', content: 'ok' }] }),
    'u01',
  );
  assert.equal(c.worldbook_entries.length, 1);
  assert.equal(c.worldbook_entries[0].title, 'y');
});

t('parseCandidates：非法 → null', () => {
  assert.equal(ReviewMachine.parseCandidates('x', 'u01'), null);
});

t('完整五步流转到 done', () => {
  const m = new ReviewMachine('u01');
  m.submitRecall('r');
  m.setComparison({ remembered: ['a'], missed: ['b'], wrong_or_vague: [] });
  m.addRepairTurn('q', 'a');
  m.finishRepair();
  assert.equal(m.step, 'candidates');
  m.setCandidates();
  assert.equal(m.step, 'commit');
  m.commit({ unit_id: 'u01', worldbook_entries: [], entity_claims: [], unresolved_questions: [], insights: [], created_at: 1 });
  assert.equal(m.step, 'done');
  assert.equal(m.isDone, true);
});

t('状态可从 existing 恢复（断点续做）', () => {
  const saved = {
    unit_id: 'u01', step: 'repair', recall_text: 'r',
    comparison: { remembered: [], missed: ['x'], wrong_or_vague: [] },
    repair_turns: [{ question: 'q', answer: 'a' }], updated_at: 1,
  };
  const m = new ReviewMachine('u01', saved);
  assert.equal(m.step, 'repair');
  assert.equal(m.current.repair_turns.length, 1);
});

// ============================================================
// 握手（D7）
// ============================================================

const mkIndex = (units) => ({ version: 1, course_id: 'physik-1', title: 'Physik I', semester: 'WiSe', module_code: 'PHY-101', units });

t('buildHandoff：组装进度/短板/单元', () => {
  const index = mkIndex([
    { id: 'u01', date: '2026-10-15', title: '角动量', file: 'a.md', reviewed: true, has_summary: true },
    { id: 'u02', date: '2026-10-22', title: '刚体', file: 'b.md', reviewed: false, has_summary: false },
  ]);
  const cands = new Map([
    ['u01', { unit_id: 'u01', worldbook_entries: [{ title: '角动量守恒', content: 'x', topic: '力学' }], entity_claims: [], unresolved_questions: ['积分怎么算'], insights: [], created_at: 1 }],
    ['u02', null],
  ]);
  const reviews = new Map([
    ['u01', { unit_id: 'u01', step: 'done', recall_text: '', comparison: { remembered: ['a'], missed: ['转动惯量'], wrong_or_vague: ['方向'] }, repair_turns: [], updated_at: 1 }],
    ['u02', null],
  ]);
  const h = buildHandoff({ index, candidatesByUnit: cands, reviewByUnit: reviews, now: 0 });
  assert.equal(h.version, 1);
  assert.equal(h.course.id, 'physik-1');
  assert.equal(h.progress.length, 2);
  // 短板：missed + wrong_or_vague + unresolved
  assert.equal(h.weak_points.length, 3);
  const wrong = h.weak_points.find((w) => w.topic === '方向');
  assert.equal(wrong.confidence, 0.7); // 记错 > 漏掉
  const missed = h.weak_points.find((w) => w.topic === '转动惯量');
  assert.equal(missed.confidence, 0.5);
});

t('buildHandoff：未复盘单元不产生短板', () => {
  const index = mkIndex([{ id: 'u02', date: 'd', title: 't', file: 'b.md', reviewed: false, has_summary: false }]);
  const h = buildHandoff({
    index,
    candidatesByUnit: new Map([['u02', { unit_id: 'u02', worldbook_entries: [], entity_claims: [], unresolved_questions: ['不该出现'], insights: [], created_at: 1 }]]),
    reviewByUnit: new Map([['u02', null]]),
  });
  assert.equal(h.weak_points.length, 0);
});

t('buildHandoff：短板去重（保留高置信）', () => {
  const index = mkIndex([{ id: 'u01', date: 'd', title: 't', file: 'a.md', reviewed: true, has_summary: false }]);
  const reviews = new Map([['u01', { unit_id: 'u01', step: 'done', recall_text: '', comparison: { remembered: [], missed: ['同一点'], wrong_or_vague: ['同一点'] }, repair_turns: [], updated_at: 1 }]]);
  const h = buildHandoff({ index, candidatesByUnit: new Map([['u01', null]]), reviewByUnit: reviews });
  assert.equal(h.weak_points.length, 1);
  assert.equal(h.weak_points[0].confidence, 0.7);
});

t('filterReviewed：未复盘单元不传 topics / 断言', () => {
  const h = {
    version: 1, generated_at: 'x',
    course: { id: 'c', title: 'C', module: '' },
    progress: [
      { unit: 'u01', title: 'A', date: 'd', reviewed: true },
      { unit: 'u02', title: 'B', date: 'd', reviewed: false },
    ],
    weak_points: [{ unit: 'u02', topic: '不该留', evidence: '', confidence: 0.5 }],
    units: [
      { unit: 'u01', title: 'A', topics: ['t1'], summary_ref: 's' },
      { unit: 'u02', title: 'B', topics: ['t2'], summary_ref: 's2' },
    ],
    claims: [
      { unit: 'u01', entity: '用户', attribute: '掌握度', value: '熟练' },
      { unit: 'u02', entity: '用户', attribute: '掌握度', value: '薄弱' },
    ],
  };
  const f = filterReviewed(h);
  assert.equal(f.weak_points.length, 0);
  assert.deepEqual(f.units[0].topics, ['t1']);
  assert.deepEqual(f.units[1].topics, []); // 未复盘 → 清空
  assert.equal(f.units[1].summary_ref, '');
  assert.equal(f.progress.length, 2); // 进度照传
  // 断言同样受 D4 门控：未复盘单元的 claim 不传
  assert.equal(f.claims.length, 1);
  assert.equal(f.claims[0].unit, 'u01');
});

t('握手包不含原始速记字段（D7 只传粗略内容）', () => {
  const index = mkIndex([{ id: 'u01', date: 'd', title: 't', file: 'a.md', reviewed: true, has_summary: true }]);
  const h = buildHandoff({ index, candidatesByUnit: new Map([['u01', null]]), reviewByUnit: new Map([['u01', null]]) });
  const s = JSON.stringify(h);
  assert.doesNotMatch(s, /raw/);
  assert.doesNotMatch(s, /my_understanding/);
  assert.doesNotMatch(s, /repair_turns/);
  assert.doesNotMatch(s, /recall_text/);
});

t('writeHandoff / readHandoff 往返', () => {
  const index = mkIndex([{ id: 'u01', date: 'd', title: '角动量', file: 'a.md', reviewed: true, has_summary: false }]);
  const h = buildHandoff({ index, candidatesByUnit: new Map([['u01', null]]), reviewByUnit: new Map([['u01', null]]) });
  const f = writeHandoff(h, tmp, 'c-handoff.json');
  assert.ok(existsSync(f));
  const back = readHandoff(f);
  assert.ok(back);
  assert.equal(back.course.id, 'physik-1');
  assert.equal(back.progress[0].title, '角动量');
});

t('readHandoff：不存在/畸形 → null', () => {
  assert.equal(readHandoff(join(tmp, 'nope.json')), null);
});

t('describeHandoff 摘要可读', () => {
  const index = mkIndex([{ id: 'u01', date: 'd', title: 't', file: 'a.md', reviewed: true, has_summary: false }]);
  const h = buildHandoff({ index, candidatesByUnit: new Map([['u01', null]]), reviewByUnit: new Map([['u01', null]]) });
  const d = describeHandoff(h);
  assert.match(d, /Physik I/);
  assert.match(d, /已复盘 1 讲/);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[check3.mjs] ${passed} 项断言通过`);
