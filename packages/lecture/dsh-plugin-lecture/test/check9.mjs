// ============================================================
// check9.mjs — 速记不互相覆盖 / 复盘认准自己的课程 / 补漏与候选的状态机（端到端）
//
// 真插件 apply + 假 ctx（含假 webServer、connection）+ 假 fetch（LLM 按 prompt 回话）。
// 守护的坑：
//   1. 对话里 capture 拿内存旧块整份重写 → 冲掉工作台改的留白 / 追加的块
//   2. review_start 塞 `chunks: []` 占位课堂 → 之后 capture 把整讲笔记只剩一块
//   3. 前端复盘靠 `web:<课程>` 指针反推课程 → 对话里开的课，对照拿「(无记录)」去比
//   4. 一轮补漏存两条 → 轮数上限只问到一半
//   5. 候选生成失败 → 前端仍能"确认"，单元被标成已复盘，其实什么都没产出
//   6. 带 error 的复盘结果却回 ok:true
//   7. 工具路径跨课复盘 → 读写到"正在记的那门课"的目录
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ── 假 LLM：按 prompt 内容决定回什么；记下每次的 prompt ──
const prompts = [];
let llm = () => '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const prompt = String(JSON.parse(String(init?.body ?? '{}')).messages?.[0]?.content ?? '');
  prompts.push(prompt);
  const content = llm(prompt);
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
const isCompare = (p) => p.includes('**对照**');
const isRepair = (p) => p.includes('**定点补漏**');
const isCandidates = (p) => p.includes('候选条目');
const COMPARE = JSON.stringify({ remembered: ['定义'], missed: ['转动惯量'], wrong_or_vague: [] });
const CANDIDATES = JSON.stringify({
  worldbook_entries: [
    { title: '角动量', content: 'L = r × p', topic: '力学' },
    { title: '转动惯量', content: 'I = Σ m r²', topic: '力学' },
  ],
  entity_claims: [],
  unresolved_questions: [],
  insights: [],
});

function makeCtx() {
  const tools = new Map();
  const routes = new Map();
  const ctx = {
    on: () => () => {},
    effect: () => {},
    tools: { register: (def) => (tools.set(def.name, def), () => {}) },
    credentials: { resolve: async () => ({ value: '' }) },
    reflect: {
      get(name) {
        if (name === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => {}) };
        if (name === 'connection') return { requestRejection: () => undefined };
        return undefined;
      },
    },
  };
  return { ctx, tools, routes };
}

const tmp = mkdtempSync(join(tmpdir(), 'lecture-test9-'));

try {
  const a = makeCtx();
  await apply(a.ctx, { dataDir: tmp, transcribe: false, llm: { apiKey: 'test-key' } });
  const handler = a.routes.get('/aemeath/api/lecture');
  assert.ok(handler, 'HTTP 桥没注册');

  const tool = (name, args, sid = 's1') => a.tools.get(name).execute(args, { agent: { session: { id: sid } } });
  const http = (method, body, query = '') =>
    new Promise((resolve) => {
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      req.method = method;
      req.url = `/aemeath/api/lecture${query}`;
      req.headers = { host: '127.0.0.1:5173', 'content-type': 'application/json' };
      const res = {
        statusCode: 0,
        writeHead(code) {
          this.statusCode = code;
          return this;
        },
        setHeader() {},
        end(b) {
          resolve({ status: this.statusCode, body: JSON.parse(String(b)) });
        },
      };
      handler(req, res);
    });
  const review = (op, extra = {}) => http('POST', { action: 'review', op, course_id: 'physik-1', unit_id: 'u01', ...extra });
  const md = (course, file) => readFileSync(join(tmp, course, file), 'utf8');

  // —— 对话里开课、记两块 ——
  const started = await tool('lecture_session_start', { course_id: 'physik-1', title: '角动量', date: '2026-11-03' });
  assert.equal(started.ok, true, JSON.stringify(started));
  await tool('lecture_capture', { raw: '# 角动量定义\n= L = r × p' });
  await tool('lecture_capture', { raw: '# 转动惯量\n= I = Σ m r^2' });
  const FILE = '2026-11-03-u01.md';

  await t('工作台改的留白 / 追加的块，不会被对话里的下一次 capture 冲掉', async () => {
    const b = await http('POST', { action: 'blanks', course_id: 'physik-1', unit_id: 'u01', seq: 0, my_understanding: '我自己写的理解' });
    assert.equal(b.body.ok, true, JSON.stringify(b.body));
    const c = await http('POST', { action: 'chunk', course_id: 'physik-1', unit_id: 'u01', chunk: { raw: '# 工作台追加的块' } });
    assert.equal(c.body.ok, true, JSON.stringify(c.body));
    const cap = await tool('lecture_capture', { raw: '# 对话里的第四块' });
    assert.equal(cap.ok, true, JSON.stringify(cap));
    assert.equal(cap.data.chunk_count, 4, '应在磁盘已有的 3 块之后追加');
    const text = md('physik-1', FILE);
    assert.match(text, /我自己写的理解/, '留白被冲掉了');
    assert.match(text, /工作台追加的块/, '工作台追加的块被冲掉了');
    assert.match(text, /对话里的第四块/);
  });

  await t('新会话里先 review_start 再 capture：不会把这一讲重写成只剩一块', async () => {
    const before = md('physik-1', FILE);
    const rs = await tool('lecture_review_start', { course_id: 'physik-1', unit_id: 'u01' }, 's-fresh');
    assert.equal(rs.ok, true, JSON.stringify(rs));
    const cap = await tool('lecture_capture', { raw: '# 不该写进去' }, 's-fresh');
    assert.equal(cap.ok, false, '没开课就不该能 capture');
    assert.equal(md('physik-1', FILE), before, '笔记被改动了');
  });

  await t('前端复盘一门在对话里开的课：对照拿的是真的笔记（不是「(无记录)」）', async () => {
    llm = (p) => (isCompare(p) ? COMPARE : '');
    const r = await review('recall', { text: '记得角动量的定义' });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(r.body.comparison, JSON.stringify(r.body));
    const cmp = prompts.filter(isCompare).at(-1);
    assert.match(cmp, /角动量定义/, '对照 prompt 里没有课堂记录');
    assert.ok(!cmp.includes('(无记录)'), '对照拿着空记录在比');
  });

  await t('补漏：每轮问答只占一条，问满 6 个问题才收尾', async () => {
    let n = 0;
    llm = (p) => (isRepair(p) ? `第${++n}个问题是什么？` : '');
    const first = await review('next');
    assert.equal(first.body.question, '第1个问题是什么？', JSON.stringify(first.body));
    let last;
    for (let i = 1; i <= 6; i++) last = await review('repair_answer', { text: `回答${i}` });
    assert.equal(last.body.done, true, JSON.stringify(last.body));
    const st = await http('GET', null, '?action=review&course=physik-1&unit=u01');
    const turns = st.body.state.repair_turns;
    assert.equal(turns.length, 6, `应正好 6 轮：${JSON.stringify(turns)}`);
    assert.deepEqual(
      turns.map((x) => x.answer),
      ['回答1', '回答2', '回答3', '回答4', '回答5', '回答6'],
    );
    assert.equal(turns[0].question, '第1个问题是什么？');
    // 已有问答里不该出现"答："为空的重复问题
    const lastRepair = prompts.filter(isRepair).at(-1);
    assert.equal((lastRepair.match(/第1个问题是什么？/g) ?? []).length, 1, '同一个问题在提示词里出现了两次');
  });

  await t('候选生成失败：可重试，且失败时不能确认（单元不被标成已复盘）', async () => {
    llm = (p) => (isCandidates(p) ? '这不是 JSON' : '');
    const fail1 = await review('next');
    assert.equal(fail1.body.ok, true);
    assert.equal(fail1.body.step, 'candidates');
    assert.equal(fail1.body.candidates, null);
    assert.match(fail1.body.note, /候选生成失败/);

    const commit1 = await review('commit', { accepted: null });
    assert.equal(commit1.body.ok, false, '没有候选却能确认');
    const idx1 = JSON.parse(readFileSync(join(tmp, 'physik-1', 'index.json'), 'utf8'));
    assert.equal(idx1.units[0].reviewed, false, '失败后单元被标成了已复盘');

    llm = (p) => (isCandidates(p) ? CANDIDATES : '');
    const ok2 = await review('next');
    assert.equal(ok2.body.ok, true, JSON.stringify(ok2.body));
    assert.equal(ok2.body.candidates.worldbook_entries.length, 2);

    // 刷新回来：GET 能拿回候选（前端据此恢复确认页）
    const st = await http('GET', null, '?action=review&course=physik-1&unit=u01');
    assert.equal(st.body.candidates.worldbook_entries.length, 2);

    const accepted = { ...ok2.body.candidates, worldbook_entries: ok2.body.candidates.worldbook_entries.slice(0, 1) };
    const commit2 = await review('commit', { accepted });
    assert.equal(commit2.body.ok, true, JSON.stringify(commit2.body));
    assert.equal(commit2.body.step, 'done');
    const saved = JSON.parse(readFileSync(join(tmp, 'physik-1', 'u01.candidates.json'), 'utf8'));
    assert.equal(saved.worldbook_entries.length, 1, '勾掉的条目应不写入');
    assert.equal(saved.unit_id, 'u01');
    const idx2 = JSON.parse(readFileSync(join(tmp, 'physik-1', 'index.json'), 'utf8'));
    assert.equal(idx2.units[0].reviewed, true);
  });

  await t('带 error 的复盘结果回 ok:false', async () => {
    const r = await review('recall', { text: '已经复盘完了还交' });
    assert.equal(r.body.ok, false, JSON.stringify(r.body));
    assert.ok(r.body.error);
  });

  await t('工具路径跨课复盘：读写的是复盘那门课，不是正在记的那门', async () => {
    // s3 正在记 chem-1；复盘 physik-1/u01 —— 先给 physik-1 开第二讲作为复盘对象
    await tool('lecture_session_start', { course_id: 'physik-1', title: '第二讲', date: '2026-11-04' }, 's-p');
    await tool('lecture_capture', { raw: '# 动量守恒\n= Σp = const' }, 's-p');
    await tool('lecture_session_start', { course_id: 'chem-1', title: '化学', date: '2026-11-04' }, 's3');
    const rs = await tool('lecture_review_start', { course_id: 'physik-1', unit_id: 'u02' }, 's3');
    assert.equal(rs.ok, true, JSON.stringify(rs));
    llm = (p) => (isCompare(p) ? COMPARE : '');
    const sub = await tool('lecture_review_submit', { text: '动量守恒' }, 's3');
    assert.equal(sub.ok, true, JSON.stringify(sub));
    assert.match(prompts.filter(isCompare).at(-1), /动量守恒/, '对照没拿到复盘那门课的笔记');
    assert.ok(existsSync(join(tmp, 'physik-1', 'u02.review.json')), '复盘状态没写到 physik-1');
    assert.ok(!existsSync(join(tmp, 'chem-1', 'u02.review.json')), '复盘状态写进了正在记的 chem-1');
  });

  console.log(`\n[check9.mjs] ${passed} 项断言通过`);
} finally {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
}
