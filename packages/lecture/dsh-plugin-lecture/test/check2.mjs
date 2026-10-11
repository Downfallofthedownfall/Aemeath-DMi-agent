// ============================================================
// check2.mjs — 存储层单测（markdown 往返 + 目录穿越防护 + 索引）
// 用临时目录，不污染仓库。
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LectureStore, safeCourseId, safeUnitId, parseUnitMarkdown, allBlanksOk, chunkBlanksOk, chunkCount } from '../lib/store.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'lecture-test-'));
const store = new LectureStore({ rootDir: tmp });

const mkChunks = () => [
  { seq: 0, raw: '# 角动量定义\n= L = r × p\n! 定轴才可 Iω', my_understanding: '角动量是转动的动量', my_question: '为什么需要对称轴', created_at: 1 },
  { seq: 1, raw: '# 转动惯量\n= I = ∫r²dm', my_understanding: '跟质量分布有关', my_question: '怎么算积分', created_at: 2 },
];

// ---------- id 净化（防目录穿越） ----------

t('safeCourseId 净化危险字符', () => {
  assert.equal(safeCourseId('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeCourseId('Physik I'), 'physik-i');
  assert.equal(safeCourseId('physik-1'), 'physik-1');
});

t('safeUnitId 净化反斜杠与斜杠', () => {
  assert.equal(safeUnitId('..\\..\\win'), 'win');
  assert.equal(safeUnitId('u03/../../x'), 'u03-x');
});

t('safeUnitId 删除内部点号序列（防残留 ..）', () => {
  assert.equal(safeUnitId('u03/../../x'), 'u03-x');
  assert.equal(safeUnitId('a..b'), 'ab');
  assert.equal(safeUnitId('....'), 'unit'); // 全点 → 兜底
});

t('safeCourseId 全非法字符 → 空（调用方须拒绝）', () => {
  assert.equal(safeCourseId('...'), '');
});

// ---------- 课程索引 ----------

t('ensureCourse 创建 + 幂等', () => {
  const a = store.ensureCourse('physik-1', 'Physik I', 'WiSe', 'PHY-101');
  assert.equal(a.course_id, 'physik-1');
  assert.equal(a.version, 1);
  const b = store.ensureCourse('physik-1', '不该改名');
  assert.equal(b.title, 'Physik I'); // 已存在 → 原样返回
});

t('readIndex 返回已写课程', () => {
  const idx = store.readIndex('physik-1');
  assert.ok(idx);
  assert.equal(idx.module_code, 'PHY-101');
});

t('listCourses 列出有索引的课程', () => {
  assert.deepEqual(store.listCourses(), ['physik-1']);
});

t('upsertUnit 新增 + 更新', () => {
  store.upsertUnit('physik-1', { id: 'u01', date: '2026-10-15', title: '角动量', file: '2026-10-15-u01.md', reviewed: false, has_summary: false });
  let idx = store.readIndex('physik-1');
  assert.equal(idx.units.length, 1);
  store.upsertUnit('physik-1', { id: 'u01', date: '2026-10-15', title: '角动量（改）', file: '2026-10-15-u01.md', reviewed: true, has_summary: false });
  idx = store.readIndex('physik-1');
  assert.equal(idx.units.length, 1); // 不重复
  assert.equal(idx.units[0].title, '角动量（改）');
});

t('markUnit 设置 reviewed/has_summary', () => {
  store.markUnit('physik-1', 'u01', { reviewed: true, has_summary: true });
  const idx = store.readIndex('physik-1');
  assert.equal(idx.units[0].reviewed, true);
  assert.equal(idx.units[0].has_summary, true);
});

t('markUnit 单元不存在 → 抛错（不静默）', () => {
  assert.throws(() => store.markUnit('physik-1', 'nope', { reviewed: true }), /单元不存在/);
});

t('readIndex 畸形 JSON → null（不抛）', () => {
  const bad = new LectureStore({ rootDir: tmp });
  bad.ensureCourse('bad', 'Bad');
  writeFileSync(join(tmp, 'bad', 'index.json'), '{ 不是合法 json');
  assert.equal(bad.readIndex('bad'), null);
});

// ⚠️ 真实踩到的坑：Windows 记事本 / PowerShell `Set-Content -Encoding utf8`
// 默认写 **UTF-8 BOM**，而 JSON.parse 遇到 BOM 会抛
// "Unexpected token ''" → 表现成"文件在、课程读不出来"。
// 这些 JSON 是"人可手改"的（D6），所以必须容忍 BOM。
t('readIndex 容忍 UTF-8 BOM（Windows 编辑器默认会写）', () => {
  const s2 = new LectureStore({ rootDir: tmp });
  s2.ensureCourse('bom', 'BOM Test');
  const file = join(tmp, 'bom', 'index.json');
  const plain = readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  writeFileSync(file, '\uFEFF' + plain, 'utf-8'); // 手工加 BOM
  const idx = s2.readIndex('bom');
  assert.ok(idx, 'BOM 文件应能读出');
  assert.equal(idx.title, 'BOM Test');
});

t('readIndex 容忍 BOM：单元列表完整', () => {
  const s3 = new LectureStore({ rootDir: tmp });
  s3.ensureCourse('bom2', 'B2');
  s3.upsertUnit('bom2', { id: 'u01', date: 'd', title: 't', file: 'f.md', reviewed: false, has_summary: false });
  const file = join(tmp, 'bom2', 'index.json');
  const plain = readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  writeFileSync(file, '\uFEFF' + plain, 'utf-8');
  const idx = s3.readIndex('bom2');
  assert.ok(idx);
  assert.equal(idx.units.length, 1);
  assert.equal(idx.units[0].id, 'u01');
});

t('readReviewState 也容忍 BOM', () => {
  const s4 = new LectureStore({ rootDir: tmp });
  s4.ensureCourse('bom3', 'B3');
  s4.writeReviewState('bom3', {
    unit_id: 'u01', step: 'recall', recall_text: 'r',
    comparison: null, repair_turns: [], updated_at: 1,
  });
  const file = join(tmp, 'bom3', 'u01.review.json');
  const plain = readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  writeFileSync(file, '\uFEFF' + plain, 'utf-8');
  const st = s4.readReviewState('bom3', 'u01');
  assert.ok(st);
  assert.equal(st.step, 'recall');
});

// ---------- markdown 往返（核心契约） ----------

t('writeUnitMarkdown 落盘 + 读回', () => {
  const idx = store.readIndex('physik-1');
  const unit = idx.units[0];
  const chunks = mkChunks();
  const file = store.writeUnitMarkdown('physik-1', unit, {
    course: 'Physik I', unit: '角动量', date: '2026-10-15', semester: 'WiSe', module: 'PHY-101',
  }, chunks);
  assert.ok(existsSync(file));
  const md = readFileSync(file, 'utf-8');
  assert.match(md, /course: Physik I/);
  assert.match(md, /## 角动量定义/);
  assert.match(md, /## 转动惯量/);
  assert.match(md, /\[我的理解\] 角动量是转动的动量/);
  assert.match(md, /\[我的疑问\] 为什么需要对称轴/);
});

t('markdown 含标记语法（= ! ? 保留）', () => {
  const idx = store.readIndex('physik-1');
  const md = store.readUnitMarkdown('physik-1', idx.units[0]);
  assert.match(md, /= L = r × p/);
  assert.match(md, /! 定轴才可 Iω/);
});

t('markdown **不含** LLM 加工产物（D3：加工只在 .raw.json）', () => {
  const idx = store.readIndex('physik-1');
  const md = store.readUnitMarkdown('physik-1', idx.units[0]);
  assert.doesNotMatch(md, /\\\\frac/); // 没有 LaTeX 补全结果
  assert.doesNotMatch(md, /processed/);
});

t('parseUnitMarkdown 往返：块数与留白还原', () => {
  const idx = store.readIndex('physik-1');
  const md = store.readUnitMarkdown('physik-1', idx.units[0]);
  const { front, chunks } = parseUnitMarkdown(md);
  assert.equal(front.course, 'Physik I');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].my_understanding, '角动量是转动的动量');
  assert.equal(chunks[0].my_question, '为什么需要对称轴');
  assert.equal(chunks[1].my_understanding, '跟质量分布有关');
});

t('parseUnitMarkdown 保留块内主题与公式', () => {
  const idx = store.readIndex('physik-1');
  const md = store.readUnitMarkdown('physik-1', idx.units[0]);
  const { chunks } = parseUnitMarkdown(md);
  assert.match(chunks[0].raw, /# 角动量定义/);
  assert.match(chunks[0].raw, /= L = r × p/);
});

// ---------- 加工结果（D3） ----------

t('writeProcessing / readProcessing 往返', () => {
  store.writeProcessing('physik-1', {
    unit_id: 'u01', chunk_seq: 0,
    formulas: [{ shorthand: 'L = r × p', latex: '\\mathbf{L} = \\mathbf{r} \\times \\mathbf{p}' }],
    processed: '规范化后的文本', model: 'deepseek-v4-flash', created_at: 123,
  });
  const rec = store.readProcessing('physik-1', 'u01');
  assert.ok(rec);
  assert.equal(rec.formulas.length, 1);
  assert.equal(rec.formulas[0].latex, '\\mathbf{L} = \\mathbf{r} \\times \\mathbf{p}');
  assert.equal(rec.model, 'deepseek-v4-flash');
});

t('readProcessing 不存在 → null', () => {
  assert.equal(store.readProcessing('physik-1', 'nope'), null);
});

// ---------- 复盘产物（D4 门控） ----------

t('候选条目 写/读', () => {
  store.writeCandidates('physik-1', {
    unit_id: 'u01',
    worldbook_entries: [{ title: '角动量', content: 'L = r × p', topic: '力学' }],
    entity_claims: [{ entity: '用户', attribute: '薄弱点', value: '转动惯量' }],
    unresolved_questions: ['积分怎么算'],
    insights: ['需要多练转动惯量'],
    created_at: 1,
  });
  const c = store.readCandidates('physik-1', 'u01');
  assert.ok(c);
  assert.equal(c.worldbook_entries[0].title, '角动量');
  assert.equal(c.entity_claims[0].value, '转动惯量');
  assert.deepEqual(c.unresolved_questions, ['积分怎么算']);
});

t('摘要 写/存在性', () => {
  assert.equal(store.hasSummary('physik-1', 'u01'), false);
  store.writeSummary('physik-1', 'u01', { text: '摘要内容', created_at: 1, model: 'm' });
  assert.equal(store.hasSummary('physik-1', 'u01'), true);
});

t('复盘状态 写/读/清', () => {
  store.writeReviewState('physik-1', {
    unit_id: 'u01', step: 'repair', recall_text: '我记得角动量',
    comparison: { remembered: ['a'], missed: ['b'], wrong_or_vague: [] },
    repair_turns: [{ question: 'q', answer: 'a' }], updated_at: 1,
  });
  const st = store.readReviewState('physik-1', 'u01');
  assert.ok(st);
  assert.equal(st.step, 'repair');
  assert.deepEqual(st.comparison.missed, ['b']);
  store.clearReviewState('physik-1', 'u01');
  assert.equal(store.readReviewState('physik-1', 'u01'), null);
});

// ---------- 留白校验 ----------

t('allBlanksOk：全部填了 → ok', () => {
  const r = allBlanksOk(mkChunks());
  assert.equal(r.ok, true);
  assert.deepEqual(r.badSeqs, []);
});

t('allBlanksOk：有空的 → 报出 seq', () => {
  const chunks = mkChunks();
  chunks[1].my_question = '';
  const r = allBlanksOk(chunks);
  assert.equal(r.ok, false);
  assert.deepEqual(r.badSeqs, [1]);
});

t('chunkBlanksOk 单项校验', () => {
  assert.equal(chunkBlanksOk({ seq: 0, raw: 'x', my_understanding: 'a', my_question: 'b', created_at: 0 }).ok, true);
  const bad = chunkBlanksOk({ seq: 0, raw: 'x', my_understanding: '', my_question: 'b', created_at: 0 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ['[我的理解]']);
});

t('chunkCount 按 --- 计数', () => {
  assert.equal(chunkCount('# A\n= x\n---\n# B'), 2);
  assert.equal(chunkCount('# A\n= x'), 1);
});

// ---------- 导出检索（retriever 可消费） ----------

t('exportForRetrieval 写 .md 到目标目录', () => {
  const idx = store.readIndex('physik-1');
  const out = store.exportForRetrieval('physik-1', idx.units[0], join(tmp, 'notes'));
  assert.ok(out);
  assert.ok(existsSync(out));
  const md = readFileSync(out, 'utf-8');
  // retriever 按 `## ` 切块 —— 必须存在二级标题
  assert.match(md, /^## /m);
});

t('exportForRetrieval 无记录 → null', () => {
  assert.equal(store.exportForRetrieval('physik-1', { id: 'nope', date: 'x', title: 't', file: 'nope.md', reviewed: false, has_summary: false }, tmp), null);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[check2.mjs] ${passed} 项断言通过`);
