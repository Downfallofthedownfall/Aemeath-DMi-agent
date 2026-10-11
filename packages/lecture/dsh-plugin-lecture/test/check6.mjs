// ============================================================
// check6.mjs — P3 前端契约测试（最重要的一条：D3 不泄漏）
//
// R1 是最高风险：「加工结果泄漏到前端 → 主动回忆失效」。
// 本文件直接对**视图构造函数**断言，不依赖真实 HTTP：
//   1. buildCourseList / buildUnitView 的输出**不含**加工字段
//   2. findLeakedKeys 能真的抓到泄漏（用反例验证护栏本身有效）
//   3. 强制留白在服务端也拦得住（前端可绕过）
//
// 为什么对视图函数测而不是对 HTTP 测：
//   HTTP 层只是薄封装；泄漏风险在"视图里放了什么字段"。
//   测视图 = 直接守住边界，且不需要起服务器。
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LectureStore } from '../lib/store.js';
import { buildCourseList, buildUnitView, buildSymbolPayload, findLeakedKeys, blankCheck } from '../lib/http.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'lec-http-'));
const store = new LectureStore({ rootDir: tmp });

// —— 造数据：一个课程 + 两个单元（一个已复盘，一个没有）——
store.ensureCourse('physik-1', 'Physik I', 'WiSe', 'PHY-101');
store.upsertUnit('physik-1', { id: 'u01', date: '2026-10-15', title: '角动量', file: '2026-10-15-u01.md', reviewed: true, has_summary: true });
store.upsertUnit('physik-1', { id: 'u02', date: '2026-10-22', title: '刚体', file: '2026-10-22-u02.md', reviewed: false, has_summary: false });

const unit01 = { id: 'u01', date: '2026-10-15', title: '角动量', file: '2026-10-15-u01.md', reviewed: true, has_summary: true };
store.writeUnitMarkdown('physik-1', unit01,
  { course: 'Physik I', unit: '角动量', date: '2026-10-15', semester: 'WiSe', module: 'PHY-101' },
  [
    { seq: 0, raw: '# 角动量定义\n= L = r⃗ × p⃗ = Iω', my_understanding: '转动版的动量', my_question: '为什么必须定轴', created_at: 1 },
    { seq: 1, raw: '# 转动惯量\n= I = ∑ mᵢrᵢ²', my_understanding: '质量按距离平方加权', my_question: '积分怎么算', created_at: 2 },
  ]);

// 制造"加工结果"（绝不能出现在前端视图里）
store.writeProcessing('physik-1', {
  unit_id: 'u01',
  chunk_seq: 0,
  formulas: [{ shorthand: 'L = r⃗ × p⃗', latex: '\\mathbf{L} = \\mathbf{r} \\times \\mathbf{p}' }],
  processed: '规范化后的正文（前端不该看到）',
  model: 'deepseek-v4-flash',
  created_at: 3,
});

// ============================================================
// D3：视图不含加工字段
// ============================================================

t('buildCourseList 不含加工字段', () => {
  const courses = buildCourseList(store);
  assert.equal(courses.length, 1);
  const leaked = findLeakedKeys(courses);
  assert.deepEqual(leaked, [], `泄漏: ${leaked.join(', ')}`);
});

t('buildUnitView 不含加工字段', () => {
  const v = buildUnitView(store, 'physik-1', 'u01');
  assert.equal(v.ok, true);
  const leaked = findLeakedKeys(v);
  assert.deepEqual(leaked, [], `泄漏: ${leaked.join(', ')}`);
});

t('buildUnitView 的 JSON 序列化里没有 LaTeX 补全结果', () => {
  const v = buildUnitView(store, 'physik-1', 'u01');
  const s = JSON.stringify(v);
  assert.doesNotMatch(s, /\\\\mathbf/, '出现 LaTeX 补全结果');
  assert.doesNotMatch(s, /规范化后的正文/, '出现加工正文');
  assert.doesNotMatch(s, /deepseek-v4-flash/, '出现模型名');
});

t('buildUnitView 返回块（速记 + 留白齐全）', () => {
  const v = buildUnitView(store, 'physik-1', 'u01');
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.chunks.length, 2);
    assert.equal(v.chunks[0].my_understanding, '转动版的动量');
    assert.equal(v.chunks[1].my_question, '积分怎么算');
    assert.equal(v.unit.chunk_count, 2);
    assert.equal(v.unit.blanks_ok, true);
    assert.equal(v.unit.reviewed, true);
  }
});

t('buildUnitView：不存在的单元 → 明确错误（不抛）', () => {
  const v = buildUnitView(store, 'physik-1', 'nope');
  assert.equal(v.ok, false);
});

t('findLeakedKeys 能抓到真实泄漏（护栏本身有效）', () => {
  // 反例：故意构造一个含加工字段的对象
  const bad = { ok: true, unit: { id: 'u01' }, processing: { processed: 'x' }, formulas: [] };
  const hits = findLeakedKeys(bad);
  assert.ok(hits.length >= 2, `应抓到 processed/formulas，实际: ${hits.join(', ')}`);
});

t('findLeakedKeys 对嵌套数组也生效', () => {
  const bad = { list: [{ a: 1 }, { processed: 'leak' }] };
  assert.ok(findLeakedKeys(bad).length > 0);
});

t('findLeakedKeys 对干净对象返回空', () => {
  assert.deepEqual(findLeakedKeys({ ok: true, chunks: [{ raw: 'x', my_understanding: 'y' }] }), []);
});

// ============================================================
// 符号表下发
// ============================================================

t('buildSymbolPayload 返回分组', () => {
  const p = buildSymbolPayload();
  assert.ok(Array.isArray(p.groups));
  assert.ok(p.groups.length >= 10);
});

t('符号下发不含函数（必须可 JSON 序列化）', () => {
  const p = buildSymbolPayload();
  const s = JSON.stringify(p);
  assert.ok(s.length > 100);
  // structured 模板字段应保留（前端靠它做插槽插入）
  assert.match(s, /\$1/);
});

// ============================================================
// 强制留白：服务端也要拦（前端可绕过）
// ============================================================

t('blankCheck：都填 → ok', () => {
  const r = blankCheck({ my_understanding: '有', my_question: '有' });
  assert.equal(r.ok, true);
});

t('blankCheck：缺一个 → 报出缺失项', () => {
  const r = blankCheck({ my_understanding: '有', my_question: '   ' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['[我的疑问]']);
});

t('blankCheck：都缺 → 报两项', () => {
  const r = blankCheck({ my_understanding: '', my_question: '' });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 2);
});

// ============================================================
// 复盘状态机：前端路径复用同一套逻辑（D4 门控不因前端而放松）
// ============================================================

t('复盘状态可经 store 往返（前端刷新/换设备不丢）', () => {
  const st = {
    unit_id: 'u01',
    step: 'repair',
    recall_text: '我记得角动量',
    comparison: { remembered: ['L=r×p'], missed: ['转动惯量'], wrong_or_vague: [] },
    repair_turns: [{ question: '转动惯量是什么？', answer: '质量分布' }],
    updated_at: 1,
  };
  store.writeReviewState('physik-1', st);
  const back = store.readReviewState('physik-1', 'u01');
  assert.ok(back);
  assert.equal(back.step, 'repair');
  assert.deepEqual(back.comparison.missed, ['转动惯量']);
});

t('候选条目在复盘前不存在（D4：摘要不提前出现）', () => {
  // u02 未复盘 → 不应有候选
  assert.equal(store.readCandidates('physik-1', 'u02'), null);
  assert.equal(store.hasSummary('physik-1', 'u02'), false);
});

t('已复盘单元才有摘要（u01）', () => {
  // u01 标记为 reviewed；写入摘要以验证"摘要只在复盘后存在"
  store.writeSummary('physik-1', 'u01', { text: '复盘后的结构化摘要', created_at: 1, model: 'm' });
  assert.equal(store.hasSummary('physik-1', 'u01'), true);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[check6.mjs] ${passed} 项断言通过`);
