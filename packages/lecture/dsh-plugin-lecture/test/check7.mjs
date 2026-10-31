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
//
// ⚠️ 注意 content 用 **q**（query 位）而不是 r：
//    真实 decide 的语义是一轮对话，导入侧把待判文本放 query 位、reply 传空串。
//    早先这个假实现用 r 拼 content，于是"导入侧把 topic 同时塞进 q 和 r"
//    这个 bug 在测试里完全看不出来（r 恰好也有值）。
//    现在断言 reply 必须为空 —— 这样传参错了测试就会红。
function makeGk(opts = {}) {
  const calls = { decide: [], writeGate: [], save: [], knowledgeAdd: [] };
  return {
    calls,
    decide(q, r) {
      calls.decide.push({ q, r });
      // decideRaw：完全照抄真实 decide 的某个分支（可以**缺字段**）。
      // 用来复现 pending 那种 `{kind:'pending'}` 没有 content/category 的返回。
      if (opts.decideRaw) return opts.decideRaw;
      if (opts.decideKind) return { kind: opts.decideKind, content: `判定：${q}`, category: 'study_log', importance: 50 };
      return { kind: 'save', content: `判定：${q}`, category: 'study_log', importance: 60 };
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
    // 第 5 步人工确认的学习状态断言（u02 未复盘 → 必须被 D4 门控拦住）
    claims: [
      { unit: 'u01', entity: '用户', attribute: '掌握度', value: '角动量守恒熟练' },
      { unit: 'u01', entity: '用户', attribute: '薄弱点', value: '转动惯量' },
      { unit: 'u02', entity: '用户', attribute: '掌握度', value: '不该进主记忆' },
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

await ta('已复盘单元的两条短板都写入（另有 1 条聚合断言）', async () => {
  const gk = makeGk();
  const o = await importHandoff(mkHandoff(), gk, {});
  // 2 条短板 + 1 条 u01 的聚合断言记录 = 3
  const weakSaves = gk.calls.save.filter((s) => !s.entityClaims?.length);
  assert.equal(weakSaves.length, 2, '两条短板');
  assert.equal(gk.calls.save.length, 3, '加上 1 条断言记录');
  assert.equal(o.memoriesWritten, 3);
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
  // 2 条短板 + 1 条聚合断言
  assert.equal(o.memoriesWritten, 3, 'dry_run 也报告"将会写入"的条数');
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
  // 3 条短板（含未复盘的 1 条）+ 1 条聚合断言 + u02 的 1 条断言 = 5
  assert.equal(o.dropped, 5);
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

await ta('空 handoff（无短板无断言）→ 正常返回零', async () => {
  const gk = makeGk();
  const h = mkHandoff();
  h.weak_points = [];
  h.claims = [];
  const o = await importHandoff(h, gk, {});
  assert.equal(o.memoriesWritten, 0);
  assert.equal(o.dropped, 0);
});

await ta('只有断言、没有短板 → 断言照样写入', async () => {
  const gk = makeGk();
  const h = mkHandoff();
  h.weak_points = [];
  const o = await importHandoff(h, gk, {});
  assert.equal(o.claimsWritten, 2, 'u01 的 2 条断言应写入');
  assert.equal(o.memoriesWritten, 1);
});

// ============================================================
// 文件层
// ============================================================

// ============================================================
// 第 5 步「逐条确认」的学习状态断言必须真的落地
//
// 背景（严重 bug）：这些断言曾在界面上以 checkbox 呈现，用户认真勾选、
// 落盘到本地 candidates，但 handoff schema 里**根本没有它们的字段** ——
// 永远没有读者。界面承诺了语义、后端没实现，比单纯的未实现更糟。
// 下面每组断言都对应当时缺失的一环。
// ============================================================

await ta('学习状态断言被写进记忆（不是只有界面勾选）', async () => {
  const gk = makeGk();
  const o = await importHandoff(mkHandoff(), gk, {});
  assert.ok(o.claimsWritten > 0, `应写入断言，实际 claimsWritten=${o.claimsWritten}`);
});

await ta('断言以 entityClaims 透传给 save（不是降级成纯文本）', async () => {
  const gk = makeGk();
  await importHandoff(mkHandoff(), gk, {});
  const withClaims = gk.calls.save.filter((s) => s.entityClaims?.length);
  assert.ok(withClaims.length > 0, 'save 应带 entityClaims');
  const c = withClaims[0].entityClaims[0];
  assert.equal(c.attribute, '掌握度');
  assert.equal(c.value, '角动量守恒熟练');
  // memory 的 EntityClaim 要求 valid_from/valid_until，缺了 schema 校验会挂
  assert.equal(typeof c.valid_from, 'number');
  assert.equal(c.valid_until, null);
});

await ta('未复盘单元的断言受 D4 门控（不进主记忆）', async () => {
  const gk = makeGk();
  const o = await importHandoff(mkHandoff(), gk, {});
  const all = gk.calls.save.flatMap((s) => s.entityClaims ?? []);
  assert.ok(!all.some((c) => c.value === '不该进主记忆'), '未复盘单元的断言不该写入');
  assert.ok(
    o.details.some((d) => d.kind === 'claim' && d.reason.includes('未复盘')),
    '应有"未复盘跳过"的明细',
  );
});

await ta('同一单元的断言聚合成一条记忆（不是 N 条碎片）', async () => {
  const gk = makeGk();
  await importHandoff(mkHandoff(), gk, {});
  const claimSaves = gk.calls.save.filter((s) => s.entityClaims?.length);
  assert.equal(claimSaves.length, 1, 'u01 的 2 条断言应聚合成 1 条记忆');
  assert.equal(claimSaves[0].entityClaims.length, 2);
});

await ta('断言也过守门员（接收侧不绕过规则层）', async () => {
  const gk = makeGk({ decideKind: 'skip' });
  const o = await importHandoff(mkHandoff(), gk, {});
  assert.equal(o.claimsWritten, 0, '守门员 skip 时不该写入断言');
});

// ============================================================
// decide 传参语义（曾经"生造"：把 topic 同时塞进 query 和 reply）
// ============================================================

await ta('导入侧调 decide 时 reply 传空串（不是把同一段文本塞两处）', async () => {
  const gk = makeGk();
  await importHandoff(mkHandoff(), gk, {});
  assert.ok(gk.calls.decide.length > 0);
  for (const c of gk.calls.decide) {
    assert.equal(c.r, '', `reply 应为空串，实际 ${JSON.stringify(c.r)}`);
    assert.ok(c.q.length > 0, 'query 位应承载待判文本');
  }
});

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

/**
 * ⚠️ 真机事故回归：pending 的判词不能把 undefined 写进存储。
 *
 * 真实的 `decide()` 有四种 kind，只有 `save` / `knowledge_direct` 带 content。
 * `pending` 的返回是 `{ kind: 'pending', reason: '待 L1 采集' }` ——
 * content、category、importance **三个字段全没有**。
 *
 * 旧代码只排除了 skip/blocked，于是 pending 一路走到
 * `save({ content: undefined, category: undefined })`，把 undefined 写进
 * memories 表。后果不是丢一条，而是**整个记忆域打不开**：
 *     DomainError: stored record '…' does not match its schema
 *   → memory 插件 apply 失败 → 服务不存在
 *   → 之后每次导入都静默降级成 dry_run（用户："传 dry_run:false 仍然原地退回"）。
 *
 * 这条断言检查：无论 decide 怎么返回，落到 save 的字段必须合法。
 */
await ta('pending 判词也写出合法记录（不能写 undefined）', async () => {
  // 完全照抄 pending 分支：三个字段都缺
  const gk = makeGk({ decideRaw: { kind: 'pending', reason: '待 L1 采集（滚动捕获）' } });
  await importHandoff(mkHandoff(), gk, {});
  assert.ok(gk.calls.save.length > 0, '应仍然写入（用调用方手上的原文兜底）');
  for (const s of gk.calls.save) {
    assert.equal(typeof s.content, 'string', 'content 必须是字符串');
    assert.ok(s.content.trim().length > 0, 'content 不能是空串');
    assert.equal(typeof s.category, 'string', 'category 必须是字符串');
    assert.ok(
      ['user_fact', 'study_log', 'preference', 'relationship', 'session_summary'].includes(s.category),
      `category 必须是 schema 认的值，实际 ${s.category}`,
    );
    assert.equal(typeof s.importance, 'number', 'importance 必须是数字');
    assert.ok(!Number.isNaN(s.importance), 'importance 不能是 NaN');
  }
});

await ta('任何 decide 返回都不该让 save 收到 undefined', async () => {
  // 四种 kind 全扫一遍（save / knowledge_direct / pending / skip / blocked）
  const kinds = [
    { kind: 'save', content: 'c', category: 'study_log', importance: 60 },
    { kind: 'knowledge_direct', content: 'k', topic: 't' },
    { kind: 'pending', reason: 'r' },
    { kind: 'skip', reason: 'r' },
    { kind: 'blocked', reason: 'r' },
  ];
  for (const raw of kinds) {
    const gk = makeGk({ decideRaw: raw });
    await importHandoff(mkHandoff(), gk, {});
    for (const s of gk.calls.save) {
      assert.ok(
        typeof s.content === 'string' && s.content.trim(),
        `kind=${raw.kind} 时 content 非法：${String(s.content)}`,
      );
      assert.ok(typeof s.category === 'string' && s.category, `kind=${raw.kind} 时 category 非法`);
    }
  }
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n[check7.mjs] ${passed} 项断言通过`);
