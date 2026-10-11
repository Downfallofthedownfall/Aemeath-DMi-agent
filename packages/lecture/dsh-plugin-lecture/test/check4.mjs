// ============================================================
// check4.mjs — 工具链回归：session_start → (检查点 flush) → capture → status
//
// 背景（真机复现，2026-10-10）：
//   dsh 的 session-checkpoint-policy 在**每个顶层工具体执行前**派发
//   `session/flush`（lib/index.js: ctx.on('tools/execute') → ctx.sessions.flush），
//   在每次模型请求前、每个 agent/pre-step 也各刷一次。
//   而本插件的 `session/flush` 监听器当时被用来“会话结束清理内存态”，
//   于是 active 课堂状态在**同一个会话内**就被清掉：
//     start（写入 active）→ flush₂（删掉 active）→ capture（找不到课堂，失败）
//   → 采集闭环 100% 不可用（step 2 起必失败）。
//
// 本测试即该时序的最小复现 + 回归护栏：
//   1) start 之后、capture 之前派发 session/flush —— 采集必须仍然成功
//   2) capture 之后 status 必须仍报 active
//   3) flush 之后仍能继续追加快照（chunk_count 递增）
//   4) flush 反复派发仍不清态；session/disposed 才清
//   5) 重启（新 apply，内存态为空）→ capture 明确失败（不猜单元），重新 start 即可继续
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

let passed = 0;
const ta = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 最小假 ctx：只实现插件用到的 on / tools.register / credentials。 */
function makeCtx() {
  const listeners = new Map();
  const tools = new Map();
  return {
    listeners,
    tools,
    ctx: {
      on(event, fn) {
        const arr = listeners.get(event) ?? [];
        arr.push(fn);
        listeners.set(event, arr);
        return () => {};
      },
      tools: {
        register(def) {
          tools.set(def.name, def);
          return () => {};
        },
      },
      credentials: { resolve: async () => ({ value: '' }) },
    },
  };
}

/** 按 checkpoint-policy 的语义派发一次 flush（顶层工具体执行前）。 */
async function flush(ctxBundle, session) {
  for (const fn of ctxBundle.listeners.get('session/flush') ?? []) await fn(session);
}

async function dispatch(ctxBundle, name, args, session = SESSION) {
  const def = ctxBundle.tools.get(name);
  assert.ok(def, `工具未注册：${name}`);
  const exec = { agent: { session: { id: session.id } } };
  return await def.execute(args, exec);
}

const tmp = mkdtempSync(join(tmpdir(), 'lecture-test4-'));
const SESSION = { id: 's1' };
const cfg = { dataDir: tmp, transcribe: false, llm: { apiKey: '' } };

try {
  const a = makeCtx();
  await apply(a.ctx, cfg);

  await ta('start → flush（检查点）→ capture 仍成功', async () => {
    const started = await dispatch(a, 'lecture_session_start', {
      course_id: 'physik-1',
      course_title: 'Physik I',
      title: '第3讲 角动量',
      semester: 'WiSe',
      module_code: 'PHY-101',
      date: '2026-10-10',
    }, SESSION);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.data.unit_id, 'u01');

    // 关键：模拟检查点策略在每个顶层工具调用前刷盘
    await flush(a, SESSION);

    const cap = await dispatch(a, 'lecture_capture', {
      raw: '# 角动量定义\n= L = r × p = Iω\n! 定轴转动才可写成 Iω\n? 为什么必须有对称轴',
      my_understanding: '角动量是转动版的动量',
      my_question: '为什么必须定轴',
    }, SESSION);
    assert.equal(cap.ok, true, `capture 失败：${JSON.stringify(cap)}`);
    assert.equal(cap.data.chunk_seq, 0);
  });

  await ta('capture → status 仍报 active 且块数正确', async () => {
    await flush(a, SESSION);
    const st = await dispatch(a, 'lecture_status', {}, SESSION);
    assert.equal(st.ok, true, JSON.stringify(st));
    assert.equal(st.data.active, true);
    assert.equal(st.data.unit_id, 'u01');
    assert.equal(st.data.chunk_count, 1);
    assert.equal(st.data.blanks_ok, true);
  });

  await ta('再 flush → 追加第二条速记（chunk 递增）', async () => {
    await flush(a, SESSION);
    const cap = await dispatch(a, 'lecture_capture', {
      raw: '= I = Σ m_i r_i^2',
      my_understanding: '转动惯量是质量按距离平方加权',
      my_question: '刚体才这样算吗',
    }, SESSION);
    assert.equal(cap.ok, true, JSON.stringify(cap));
    assert.equal(cap.data.chunk_count, 2);
  });

  await ta('落盘的 markdown 记录两条块 + 强制留白', async () => {
    const md = readFileSync(join(tmp, 'physik-1', '2026-10-10-u01.md'), 'utf8');
    assert.match(md, /角动量定义/);
    assert.match(md, /角动量是转动版的动量/);
    assert.match(md, /为什么必须定轴/);
    assert.match(md, /转动惯量是质量按距离平方加权/);
  });

  await ta('强制留白为空 → capture 拒绝（不填不继续）', async () => {
    const bad = await dispatch(a, 'lecture_capture', {
      raw: '= 只有速记',
      my_understanding: '   ',
      my_question: '',
    }, SESSION);
    assert.equal(bad.ok, false);
    assert.match(String(bad.data.error), /强制留白/);
  });

  await ta('同进程会话结束（flush 不再清态）后可继续记录', async () => {
    await flush(a, SESSION);
    const cap = await dispatch(a, 'lecture_capture', {
      raw: '! 角动量守恒',
      my_understanding: '外力矩为零则守恒',
      my_question: '非惯性系怎么办',
    }, SESSION);
    assert.equal(cap.ok, true, JSON.stringify(cap));
  });

  await ta('会话 flush 反复派发也不清内存态（回归护栏）', async () => {
    await flush(a, SESSION);
    await flush(a, SESSION);
    const st = await dispatch(a, 'lecture_status', {}, SESSION);
    assert.equal(st.ok, true, JSON.stringify(st));
    assert.equal(st.data.chunk_count, 3);
  });

  // 重启语义：新进程（新 apply）里内存态为空 —— 已知限制：不猜单元，capture 明确失败；
  // ⚠ 2026-10-10 更新：原先此处断言"重启后 capture 必须失败"。
  // 那是当时的已知限制；现已改为**从磁盘指针（_active.json）恢复**课堂状态，
  // 使进程重启（课堂上换电池/误关窗口）不丢失"正在记哪一讲"。
  // 断言随之改为：重启后 capture 应**成功**，且接着已落盘内容继续追加。
  const b = makeCtx();
  await apply(b.ctx, cfg);
  await ta('重启后（内存态为空）capture 从磁盘指针恢复并成功', async () => {
    await flush(b, SESSION);
    // 内存态确实为空（新 apply），但指针在磁盘上 → capture 应恢复
    const cap = await dispatch(b, 'lecture_capture', {
      raw: '= L = Iω（定轴）',
      my_understanding: '定轴转动才可把 L 写成 Iω',
      my_question: '为什么需要对称轴',
    }, SESSION);
    assert.equal(cap.ok, true, JSON.stringify(cap));
    // u01 在前面的阶段已落盘 3 块 → 恢复后序号接续为 3（不是从 0 重来）
    assert.equal(cap.data.chunk_seq, 3);
    assert.equal(cap.data.chunk_count, 4);
  });

  await ta('恢复后 status 报同一单元（不新建单元）', async () => {
    const st = await dispatch(b, 'lecture_status', {}, SESSION);
    assert.equal(st.ok, true, JSON.stringify(st));
    assert.equal(st.data.unit_id, 'u01');
    assert.equal(st.data.chunk_count, 4);
  });

  await ta('显式新 start 才切换到新单元（u02）', async () => {
    const started = await dispatch(b, 'lecture_session_start', {
      course_id: 'physik-1',
      title: '第3讲 角动量（续）',
      date: '2026-10-10',
    }, SESSION);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.data.unit_id, 'u02');
    await flush(b, SESSION);
    const cap = await dispatch(b, 'lecture_capture', {
      raw: '= L = Iω（定轴续）',
      my_understanding: '新单元第一块',
      my_question: '同上',
    }, SESSION);
    assert.equal(cap.ok, true, JSON.stringify(cap));
    assert.equal(cap.data.chunk_count, 1); // 新单元从 0 起
    const st = await dispatch(b, 'lecture_status', {}, SESSION);
    assert.equal(st.data.unit_id, 'u02');
  });

  await ta('session/disposed 才清内存态', async () => {
    for (const fn of b.listeners.get('session/disposed') ?? []) await fn(SESSION);
    const st = await dispatch(b, 'lecture_status', {}, SESSION);
    assert.equal(st.ok, false);
    assert.equal(st.data.active, false);
  });

  await ta('数据文件真实存在（课程索引）', () => {
    assert.ok(existsSync(join(tmp, 'physik-1', 'index.json')));
  });

  console.log(`\ncheck4: ${passed} 项通过`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
