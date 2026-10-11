// ============================================================
// check7.mjs — P4 握手接收侧单测
//
// 重点验证：
//   1. **必须过守门员**（不是直接 save）——这是 plan §7 的硬要求
//   2. 未复盘单元的内容不进主记忆（D4 门控在接收侧也生效）
//   3. dry_run 只判定不写入
//   4. 守门员的 skip/blocked/drop 都真的拦得住
//   5. 写入失败不中断整体（一条坏不影响其余）
//
// 用假 gatekeeper 注入 —— 这正是把 HandoffGatekeeper 做成窄接口的目的：
// 不必起 memory 插件就能测边界。
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importHandoff, findHandoffFiles, describeOutcome, loadHandoffFile } from '../lib/import-handoff.js';
import { writeHandoff } from '../lib/handoff.js';

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

const tmp = mkdtempSync(join(tmpdir(), 'lec-p4-'));

// ---------- 假 gatekeeper：记录调用，可控判定 ----------
function makeGk(opts = {}) {
  const calls = { decide: [], writeGate: [], save: [], knowledgeAdd: [] };
  return {
    calls,
    decide(q, r) {
      calls.decide.push({ q, r });
      if (opts.decideKind) return { kind: opts.decideKind, content: `短板：${r}`, category: 'study_log', importance: 50 };
      return { kind: 'save', content: `学习短板：${r}`, category: 'study_log', importance: 60 };
    },
    writeGate(q, c) {
      calls.writeGate.push({ q, c });
      return opts.writeGate ?? { action: 'accept', reason: 'ok' };
    },
    async save(input) {
      if (opts.saveThrows) throw new Error('故意失败');
      calls.save.push(input);
      return `id-${calls.save.length}`;
    },
    async knowledgeAdd(input) {
      calls.knowledgeAdd.push(input);
      return `k-${calls.knowledgeAdd.length}`;
    },
    log() {},
    warn() {},
  };
}

/** 造一个 handoff：u01 已复盘（2 条短板），u02 未复盘（1 条短板）。 */
function mkHandoff() {
  return {
    version: 1,
    generated_at: '2026-10-15T18:00:00Z',
    course: { id: 'physik-1', title: 'Physik I', module: 'PHY-101' },
    progress: [
      { unit: 'u01', title: '角动量', date: '2026-10-15', reviewed: true },
      { unit: 'u02', title: '刚体', date: '2026-10-22', reviewed: false },
    ],
    weak_points: [
      { unit: 'u01', topic: '转动惯量计算', evidence: '复盘漏掉', confidence: 0.5 },
      { unit: 'u01', topic: '角动量方向', evidence: '复盘记错', confidence: 0.7 },
      { unit: 'u02', topic: '不该进主记忆', evidence: '未复盘', confidence: 0.5 },
    ],
    units: [
      { unit: 'u01', title: '角动量', topics: ['角动量守恒'], summary_ref: 'u01.summary.json' },
      { unit: 'u02', title: '刚体', topics: [], summary_ref: '' },
    ],
  };
}

// ============================================================
// 核心：必须过守门员
// ============================================================

await ta('导入时**确实调用了**守门员（不是绕过直接 save）', async () => {
  const gk = makeGk();
  await importHandoff(mkHandoff(), gk, {});
  assert.ok(gk.calls.decide.length >= 2, `decide 应被调用，实际 ${gk.calls.decide.length}`);
});

await ta('写入的 preset 正确（physicist 馆）', async () => {
  const gk = makeGk();
  await importHandoff(mkHandoff(), gk, { preset: 'physicist' });
  assert.ok(gk.calls.save.length > 0);
  for (const s of gk.calls.save) assert.equal(s.preset, 'physicist');
});

await ta('写入带 sourceMode=lecture（可追溯来源）', async () => {
  const gk = makeGk();
  await importHandoff(mkHandoff(), gk, {});
  for (const s of gk.calls.save) {
    assert.equal(s.sourceMode, 'lecture');
    assert.ok(s.sourceLecture, '应带 sourceLecture 标记');
    assert.equal(s.sourceLecture.course, 'physik-1');
  }
});

// ============================================================
// D4：未复盘单元不进主记忆
// ============================================================

await ta('未复盘单元的短板被跳过', async () => {
  const gk = makeGk();
  const o = await importHandoff(mkHandoff(), gk, {});
  const contents = gk.calls.save.map((s) => s.content).join('\n');
  assert.doesNotMatch(contents, /不该进主记忆/, '未复盘内容泄漏进主记忆');
  assert.ok(o.dropped >= 1, '应记录被丢弃数');
  assert.ok(o.details.some((d) => d.reason.includes('未复盘')));
});

await ta('已复盘单元的两条短板都写入', async () => {
  const gk = makeGk();
  const o = await importHandoff(mkHandoff(), gk, {});
  assert.equal(o.memoriesWritten, 2);
  assert.equal(gk.calls.save.length, 2);
});

await ta('短板进 mode 作用域（跟课程绑定，不是全局身份）', async () => {
  const gk = makeGk();
  await importHandoff(mkHandoff(), gk, {});
  for (const s of gk.calls.save) assert.equal(s.scope, 'mode');
});

// ============================================================
// dry_run
// ============================================================

await ta('dry_run=true：只判定，**不写入**', async () => {
  const gk = makeGk();
  const o = await importHandoff(mkHandoff(), gk, { dryRun: true });
  assert.equal(gk.calls.save.length, 0, 'dry_run 不应写入');
  assert.ok(gk.calls.decide.length >= 2, '但应做判定');
  assert.equal(o.memoriesWritten, 2, 'dry_run 也报告"将会写入"的条数');
  assert.ok(o.details.some((d) => d.reason.includes('试运行')));
});

await ta('dry_run 明细可读（人工核对用）', async () => {
  const gk = makeGk();
  const o = await importHandoff(mkHandoff(), gk, { dryRun: true });
  const s = describeOutcome(o);
  assert.match(s, /physik-1/);
  assert.match(s, /试运行/);
});

// ============================================================
// 守门员真的拦得住
// ============================================================

await ta('decide=skip → 全部丢弃', async () => {
  const gk = makeGk({ decideKind: 'skip' });
  const o = await importHandoff(mkHandoff(), gk, {});
  assert.equal(gk.calls.save.length, 0);
  assert.equal(o.memoriesWritten, 0);
  assert.equal(o.dropped, 3);
});

await ta('decide=blocked → 全部丢弃（凭据拦截）', async () => {
  const gk = makeGk({ decideKind: 'blocked' });
  const o = await importHandoff(mkHandoff(), gk, {});
  assert.equal(gk.calls.save.length, 0);
  assert.ok(o.details.some((d) => d.reason.includes('blocked')));
});

// ============================================================
// 写门（user_fact 才走）
// ============================================================

await ta('user_fact + 写门 drop → 不写入', async () => {
  const gk = makeGk();
  gk.decide = (q, r) => ({ kind: 'save', content: r, category: 'user_fact', importance: 70 });
  gk.writeGate = () => ({ action: 'drop', reason: '非第一人称自述' });
  const o = await importHandoff(mkHandoff(), gk, {});
  assert.equal(gk.calls.save.length, 0);
  assert.ok(o.details.some((d) => d.reason.includes('写门拦截')));
});

await ta('user_fact + 写门 demote → 降置信写入', async () => {
  const gk = makeGk();
  gk.decide = (q, r) => ({ kind: 'save', content: r, category: 'user_fact', importance: 70 });
  gk.writeGate = () => ({ action: 'demote', reason: '非第一人称', confidence: 0.55 });
  await importHandoff(mkHandoff(), gk, {});
  assert.ok(gk.calls.save.length > 0);
  for (const s of gk.calls.save) {
    assert.equal(s.confidence, 0.55);
    assert.ok(s.importance <= 50, `importance 应被降：${s.importance}`);
  }
});

await ta('study_log 不走写门（只 user_fact 走）', async () => {
  const gk = makeGk();
  await importHandoff(mkHandoff(), gk, {});
  assert.equal(gk.calls.writeGate.length, 0, 'study_log 不该触发写门');
});

// ============================================================
// 容错
// ============================================================

await ta('单条写入失败不中断整体', async () => {
  const gk = makeGk({ saveThrows: true });
  const o = await importHandoff(mkHandoff(), gk, {});
  // 两条都失败，但流程走完、有明细
  assert.equal(o.memoriesWritten, 0);
  assert.ok(o.details.length >= 3);
  assert.ok(o.details.some((d) => d.reason.includes('写入失败')));
});

await ta('空 handoff（无短板）→ 正常返回零', async () => {
  const gk = makeGk();
  const h = mkHandoff();
  h.weak_points = [];
  const o = await importHandoff(h, gk, {});
  assert.equal(o.memoriesWritten, 0);
  assert.equal(o.dropped, 0);
});

// ============================================================
// 文件层
// ============================================================

t('findHandoffFiles 找到 *-handoff.json', () => {
  const h = mkHandoff();
  writeHandoff(h, tmp, 'physik-1-handoff.json');
  const files = findHandoffFiles(tmp);
  assert.ok(files.length >= 1);
  assert.ok(files.some((f) => f.endsWith('physik-1-handoff.json')));
});

t('findHandoffFiles 目录不存在 → 空数组（不抛）', () => {
  assert.deepEqual(findHandoffFiles(join(tmp, 'nope')), []);
});

t('loadHandoffFile 能读回', () => {
  const files = findHandoffFiles(tmp);
  const h = loadHandoffFile(files[0]);
  assert.ok(h);
  assert.equal(h.course.id, 'physik-1');
});

t('loadHandoffFile 畸形 → null', () => {
  writeFileSync(join(tmp, 'broken-handoff.json'), '{ 不是 json');
  assert.equal(loadHandoffFile(join(tmp, 'broken-handoff.json')), null);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[check7.mjs] ${passed} 项断言通过`);
