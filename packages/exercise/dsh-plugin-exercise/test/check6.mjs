// ============================================================
// test/check6.mjs — LLM 检查的 prompt/解析 + HTTP 路由
//
// 检查（D3）只在手动触发时发生，所以这里测的重点是：
//   · prompt 里"不许直接给答案 / 不许臆造条件"的约束**必须真的在**
//   · 模型输出再脏也要能解析或明确失败（绝不把解析失败当成"判错"）
// 路由侧测边界：跨站写必须拒、缺参数必须 400、未知 action 必须 400。
// ============================================================
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { buildCheckPrompt, parseCheckOutput, parseJsonLoose, runCheck, repairTruncatedJson } from '../lib/checker.js';
import { checkWriteOrigin, handleExerciseHttp } from '../lib/http.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};
const asyncT = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ============================================================
// checker
// ============================================================
const baseInput = {
  courseTitle: 'Physik I',
  sheetNumber: 3,
  sheetTitle: 'Mechanik',
  problemLabel: 'Aufgabe 2',
  problemTitle: 'Kraft',
  points: 4,
  problemText: 'Ein Körper der Masse $m$ …',
  answer: 'F = ma',
  notes: '我不确定方向',
  progressDigest: '上次没做完：Übungsblatt 2\n错题本：1 条未掌握',
  priorMistakes: ['Aufgabe 1：先画受力图'],
};

t('prompt 含全部硬性规则（不许给完整答案 / 不许臆造）', () => {
  const p = buildCheckPrompt(baseInput);
  assert.match(p, /不要写出完整解答/);
  assert.match(p, /题目没给的条件不要假设它存在/);
  assert.match(p, /verdict="unclear"/);
  assert.match(p, /严格 JSON/);
});

t('prompt 带题目/答案/进度/历史错题/备注', () => {
  const p = buildCheckPrompt(baseInput);
  assert.match(p, /Übungsblatt 3/);
  assert.match(p, /Aufgabe 2（4 Punkte）/);
  assert.match(p, /Ein Körper der Masse/);
  assert.match(p, /F = ma/);
  assert.match(p, /上次没做完/);
  assert.match(p, /先画受力图/);
  assert.match(p, /我不确定方向/);
});

t('prompt 语言：默认中文解释、de 时改德语', () => {
  assert.match(buildCheckPrompt(baseInput), /请用\*\*中文\*\*/);
  assert.match(buildCheckPrompt({ ...baseInput, lang: 'de' }), /请用德语/);
});

t('空答案时 prompt 明确写"(空)"（不编造）', () => {
  const p = buildCheckPrompt({ ...baseInput, answer: '   ' });
  assert.match(p, /## 学生的解答\n\(空\)/);
});

t('parseCheckOutput：干净 JSON', () => {
  const c = parseCheckOutput('{"verdict":"partial","score":0.5,"issues":[{"severity":"warn","text":"第二步缺符号"}],"hints":["判方向"],"next_steps":["重写第二行"]}');
  assert.equal(c.verdict, 'partial');
  assert.equal(c.score, 0.5);
  assert.equal(c.issues[0].text, '第二步缺符号');
  assert.deepEqual(c.hints, ['判方向']);
});

t('parseCheckOutput：```json 围栏 + 前后废话', () => {
  const raw = '好的，结果如下：\n```json\n{"verdict":"wrong","issues":[]}\n```\n希望有帮助。';
  assert.equal(parseCheckOutput(raw).verdict, 'wrong');
});

t('parseCheckOutput：字段缺失/类型错 → 抢救（verdict 在就算成功）', () => {
  const c = parseCheckOutput('{"verdict":"correct","issues":["字符串也能收","第三项"],"hints":"不是数组"}');
  assert.equal(c.verdict, 'correct');
  assert.equal(c.issues.length, 2);
  assert.deepEqual(c.hints, []);
});

t('parseCheckOutput：坏输入返回 null（绝不猜结论）', () => {
  assert.equal(parseCheckOutput(null), null);
  assert.equal(parseCheckOutput(''), null);
  assert.equal(parseCheckOutput('没有 JSON'), null);
  assert.equal(parseCheckOutput('{ bad json }'), null);
  assert.equal(parseCheckOutput('{"verdict":"maybe"}'), null);
});

await asyncT('runCheck：正常返回 ok', async () => {
  const r = await runCheck(baseInput, async () => '{"verdict":"correct","score":1,"issues":[],"hints":[],"next_steps":[]}');
  assert.equal(r.ok, true);
  assert.equal(r.check.verdict, 'correct');
  assert.ok(r.raw.includes('correct'));
});

await asyncT('runCheck：LLM 不可用 → ok:false，且不是"判错"', async () => {
  const r = await runCheck(baseInput, async () => null);
  assert.equal(r.ok, false);
  assert.match(r.error, /LLM 不可用/);
  assert.equal(r.check, null);
});

await asyncT('runCheck：输出不可解析 → ok:false 但保留原文', async () => {
  const r = await runCheck(baseInput, async () => '我觉得还行');
  assert.equal(r.ok, false);
  assert.match(r.error, /不可解析/);
  assert.equal(r.raw, '我觉得还行');
});

// ── 截断 JSON 的抢救（真机第一次检查就踩到：max_tokens 把 issues 截断在字符串中间）──
t('repairTruncatedJson：字符串中间被截断 → 补引号 + 闭合括号', () => {
  const raw = '{"verdict":"partial","score":0.7,"issues":[{"severity":"warn","text":"Teil (b) 没做量纲检验';
  const repaired = repairTruncatedJson(raw);
  assert.ok(repaired, '应当能修复');
  const obj = JSON.parse(repaired);
  assert.equal(obj.verdict, 'partial');
  assert.equal(obj.issues[0].text, 'Teil (b) 没做量纲检验');
});

t('repairTruncatedJson：悬空逗号/键名 → 退到安全切点', () => {
  const a = repairTruncatedJson('{"verdict":"wrong","issues":[{"severity":"warn","text":"x"},');
  assert.equal(JSON.parse(a).verdict, 'wrong');
  assert.equal(JSON.parse(a).issues.length, 1);
  const b = repairTruncatedJson('{"verdict":"wrong","issues":[{"severity":"warn","text":"x"},{"severity":');
  const obj = JSON.parse(b);
  assert.equal(obj.verdict, 'wrong');
  assert.ok(Array.isArray(obj.issues));
});

t('parseCheckOutput：真机那条被截断的输出也能解析出 verdict', () => {
  const raw =
    '{"verdict":"partial","score":0.7,"issues":[{"severity":"warn","text":"Teil (b) 的 Dimensionsanalyse 只写了 $[a]=\\\\mathrm{m\\\\,s^{-2}}$ ✓，这只是把题目要的结果单位重复一遍"},{"severity":"info","text":"没有说明所用的 Koordinatensystem（平行/垂直于 schiefe Ebene 的分量分解），Kräftezerlegung 的来源不透明。"},{"severity":"info","text":"$\\\\sin 30^\\\\circ=0{,}5$ 的代入过程以及所用 $g$ 的取值未注明。"},{"severity":"info","text":"$N\\\\approx17{,}0\\\\ \\\\mathrm{N}$ 数值可接受，但更精确应为 $16{,}97\\\\ \\\\mathrm{N}$；另外可顺带说明 reibungsfrei 意味着 keine Reibungskraft';
  const c = parseCheckOutput(raw);
  assert.ok(c, '应当抢救成功');
  assert.equal(c.verdict, 'partial');
  assert.ok(c.issues.length >= 2);
});

t('parseCheckOutput：完全不是 JSON 的文本仍然返回 null', () => {
  assert.equal(parseCheckOutput('我检查了一下，基本对。'), null);
});

// ============================================================
// HTTP
// ============================================================
function makeReq(method, url, body, headers = {}) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const stream = Readable.from(payload);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

function makeRes() {
  const out = { status: 0, headers: null, body: '' };
  return {
    out,
    writeHead(code, headers) {
      out.status = code;
      out.headers = headers ?? null;
      return this;
    },
    write(chunk) {
      out.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) out.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return this;
    },
    destroy() {},
  };
}

function fakeDeps(calls) {
  return {
    store: { rootPath: '/tmp' },
    buildCourses: () => [{ course_id: 'physik-1', title: 'Physik I', sheets: [] }],
    buildSheetView: (c, s) =>
      s === 'missing' ? { ok: false, error: '题集不存在' } : { ok: true, sheet: { id: s, course_id: c } },
    buildMistakes: () => [],
    buildDigestPreview: () => ({ digest: 'ok', stats: {} }),
    buildSymbols: () => ({ groups: [] }),
    readSourceText: () => 'text',
    sourcePdfPath: () => null,
    submissionPdfPath: () => null,
    buildPrintHtml: () => ({ ok: true, html: '<html>print</html>' }),
    onImport: async (input) => {
      calls.push(['import', input]);
      return { ok: true, course_id: input.courseId, sheet_id: 'ub01', sheet: { id: 'ub01' }, warnings: [] };
    },
    onCreateSheet: async () => ({ ok: true, sheet: { id: 'ub01' } }),
    onUpdateProblem: async () => ({ ok: true, sheet: { id: 'ub01' }, stale: 1 }),
    onAddProblem: async () => ({ ok: true, sheet: {} }),
    onDeleteProblem: async () => ({ ok: true, sheet: {} }),
    onResplit: async () => ({ ok: true, sheet: {} }),
    onCheck: async () => ({ ok: true, check: { verdict: 'wrong' }, sheet: {} }),
    onCollectMistake: async () => ({ ok: true, mistake: { id: 'm1' } }),
    onPatchMistake: async () => ({ ok: true }),
    onDeleteMistake: async () => ({ ok: true }),
    onLesson: async () => ({ ok: true, sheet: {} }),
    onSyncWorldbook: async () => ({ ok: true, written: 1, skipped: 0, failed: 0, details: [] }),
    onBuildSubmission: async (input) => {
      calls.push(['build', input]);
      return { ok: true, url: '/x.pdf', pages: 3, bytes: 1000 };
    },
    onExportHandoff: async () => ({ ok: true, files: ['a.json'], dir: '/h' }),
    onScratch: () => { calls.push(['onScratch']); return { ok: true, sheet: { id: 'ub01' } }; },
    onImportScratchPdf: async (input) => { calls.push(['import_scratch_pdf', input]); return { ok: true, sheet: {}, text_length: 10, pages: 1 }; },
    onAddAttachment: async (input) => { calls.push(['add_attachment', input]); return { ok: true, sheet: {} }; },
    onDeleteAttachment: async () => ({ ok: true, sheet: {} }),
    onReadAttachment: () => null,
    onScratchReset: () => { calls.push(['onScratchReset']); return { ok: true, sheet: { id: 'ub01' } }; },
    onDelete: async () => ({ ok: true }),
    log: () => undefined,
    warn: () => undefined,
  };
}

await asyncT('GET courses → 200 + JSON', async () => {
  const res = makeRes();
  await handleExerciseHttp(makeReq('GET', '/aemeath/api/exercise?action=courses'), res, fakeDeps([]));
  assert.equal(res.out.status, 200);
  const body = JSON.parse(res.out.body);
  assert.equal(body.ok, true);
  assert.equal(body.courses[0].course_id, 'physik-1');
});

await asyncT('GET sheet 缺参数 → 400；不存在 → 404', async () => {
  let res = makeRes();
  await handleExerciseHttp(makeReq('GET', '/aemeath/api/exercise?action=sheet'), res, fakeDeps([]));
  assert.equal(res.out.status, 400);

  res = makeRes();
  await handleExerciseHttp(makeReq('GET', '/aemeath/api/exercise?action=sheet&course=c&sheet=missing'), res, fakeDeps([]));
  assert.equal(res.out.status, 404);
});

await asyncT('GET print → HTML', async () => {
  const res = makeRes();
  await handleExerciseHttp(makeReq('GET', '/aemeath/api/exercise?action=print&course=c&sheet=s'), res, fakeDeps([]));
  assert.equal(res.out.status, 200);
  assert.match(res.out.headers['Content-Type'], /text\/html/);
  assert.match(res.out.body, /<html>print<\/html>/);
});

await asyncT('GET submission 没有文件 → 404（不返回空 PDF）', async () => {
  const res = makeRes();
  await handleExerciseHttp(makeReq('GET', '/aemeath/api/exercise?action=submission&course=c&sheet=s'), res, fakeDeps([]));
  assert.equal(res.out.status, 404);
});

await asyncT('POST 跨站 Origin → 403（DNS 重绑定/CSRF 防护）', async () => {
  const res = makeRes();
  await handleExerciseHttp(
    makeReq('POST', '/aemeath/api/exercise', { action: 'import', course_id: 'x' }, { origin: 'http://evil.example' }),
    res,
    fakeDeps([]),
  );
  assert.equal(res.out.status, 403);
});

await asyncT('POST 本机 Origin → 放行', async () => {
  const res = makeRes();
  await handleExerciseHttp(
    makeReq('POST', '/aemeath/api/exercise', { action: 'create', course_id: 'physik-1' }, { origin: 'http://127.0.0.1:3081' }),
    res,
    fakeDeps([]),
  );
  assert.equal(res.out.status, 200);
});

await asyncT('POST import 缺 pdf/text → 400', async () => {
  const res = makeRes();
  await handleExerciseHttp(
    makeReq('POST', '/aemeath/api/exercise', { action: 'import', course_id: 'physik-1' }),
    res,
    fakeDeps([]),
  );
  assert.equal(res.out.status, 400);
  assert.match(JSON.parse(res.out.body).error, /pdf_base64|text/);
});

await asyncT('POST import 透传文本与元数据', async () => {
  const calls = [];
  const res = makeRes();
  await handleExerciseHttp(
    makeReq('POST', '/aemeath/api/exercise', {
      action: 'import',
      course_id: 'physik-1',
      number: 3,
      due: '2026-10-22',
      text: 'Aufgabe 1 ...',
      filename: 'blatt3.pdf',
    }),
    res,
    fakeDeps(calls),
  );
  assert.equal(res.out.status, 200);
  const [kind, input] = calls[0];
  assert.equal(kind, 'import');
  assert.equal(input.number, 3);
  assert.equal(input.due, '2026-10-22');
  assert.equal(input.filename, 'blatt3.pdf');
});

await asyncT('POST build_submission 透传 order/include_source', async () => {
  const calls = [];
  const res = makeRes();
  await handleExerciseHttp(
    makeReq('POST', '/aemeath/api/exercise', {
      action: 'build_submission',
      course_id: 'physik-1',
      sheet_id: 'ub03',
      order: 'solutions-first',
      include_source: false,
    }),
    res,
    fakeDeps(calls),
  );
  assert.equal(JSON.parse(res.out.body).pages, 3);
  const [, input] = calls[0];
  assert.equal(input.order, 'solutions-first');
  assert.equal(input.includeSource, false);
});

await asyncT('POST build_submission 不传 include_source → 默认 false（只出解答页）', async () => {
  const calls = [];
  const res = makeRes();
  await handleExerciseHttp(
    makeReq('POST', '/aemeath/api/exercise', {
      action: 'build_submission',
      course_id: 'physik-1',
      sheet_id: 'ub03',
    }),
    res,
    fakeDeps(calls),
  );
  const [, input] = calls[0];
  assert.equal(input.includeSource, false, '2026-10-24 起默认不合并原卷');
});
await asyncT('POST 未知 action → 400；GET 未知 action → 400', async () => {
  let res = makeRes();
  await handleExerciseHttp(makeReq('POST', '/aemeath/api/exercise', { action: 'nope' }), res, fakeDeps([]));
  assert.equal(res.out.status, 400);
  res = makeRes();
  await handleExerciseHttp(makeReq('GET', '/aemeath/api/exercise?action=nope'), res, fakeDeps([]));
  assert.equal(res.out.status, 400);
});

await asyncT('PUT → 405', async () => {
  const res = makeRes();
  await handleExerciseHttp(makeReq('PUT', '/aemeath/api/exercise'), res, fakeDeps([]));
  assert.equal(res.out.status, 405);
});

t('checkWriteOrigin：无 Origin 放行；localhost 放行；null/外部拒', () => {
  assert.equal(checkWriteOrigin({ headers: {} }), true);
  assert.equal(checkWriteOrigin({ headers: { origin: 'http://localhost:3081' } }), true);
  assert.equal(checkWriteOrigin({ headers: { origin: 'http://[::1]:3081' } }), true);
  assert.equal(checkWriteOrigin({ headers: { origin: 'null' } }), false);
  assert.equal(checkWriteOrigin({ headers: { origin: 'https://evil.example' } }), false);
  assert.equal(checkWriteOrigin({ headers: { origin: '不是 URL' } }), false);
});

// ---- 宽松 JSON：LaTeX 的非法转义、截断 ----
t('parseJsonLoose：LaTeX 的 \\, \\; \\! 被写进 JSON 字符串也能解析', () => {
  const bad = '{"verdict":"partial","issues":[{"severity":"error","text":"$4.9\\,\\mathrm{m/s^2}$ 单位对了但 $\\;a$ 没写"}]}';
  const obj = parseJsonLoose(bad);
  assert.ok(obj, '应当能解析');
  assert.equal(obj.issues.length, 1);
  assert.match(obj.issues[0].text, /4\.9/);
});

t('parseJsonLoose：合法转义 \\n \\" \\\\ 不受影响', () => {
  const good = '{"text":"a\\nb \\"q\\" \\\\ end"}';
  const obj = parseJsonLoose(good);
  assert.equal(obj.text, 'a\nb "q" \\ end');
});

t('parseCheckOutput：转义坏味不再退化成"0 条 issues"', () => {
  const raw =
    '{"verdict":"partial","score":0.3,"issues":[{"severity":"error","text":"$g\\,\\sin\\alpha$ 用法对"},{"severity":"info","text":"$\\mu$ 别乱用"}],"hints":["如果把 $\\alpha$ 换成 $\\beta$ 呢？"],"next_steps":["先写 $\\sum F$"]}';
  const check = parseCheckOutput(raw);
  assert.equal(check.verdict, 'partial');
  assert.equal(check.issues.length, 2, 'issues 不能被丢掉');
  assert.equal(check.hints.length, 1);
});

await asyncT('GET scratch / POST reset_scratch 走的是极简工作区', async () => {
  const calls = [];
  let res = makeRes();
  await handleExerciseHttp(makeReq('GET', '/aemeath/api/exercise?action=scratch'), res, fakeDeps(calls));
  assert.equal(calls[0][0], 'onScratch');

  res = makeRes();
  await handleExerciseHttp(
    makeReq('POST', '/aemeath/api/exercise', { action: 'reset_scratch' }),
    res,
    fakeDeps(calls),
  );
  assert.equal(calls[1][0], 'onScratchReset');
});

await asyncT('POST import_scratch_pdf 透传 base64（极简模式上传题目）', async () => {
  const calls = [];
  const res = makeRes();
  await handleExerciseHttp(
    makeReq('POST', '/aemeath/api/exercise', { action: 'import_scratch_pdf', base64: 'JVBERi0=' }),
    res,
    fakeDeps(calls),
  );
  assert.equal(res.out.status, 200);
  const [name, input] = calls[0];
  assert.equal(name, 'import_scratch_pdf');
  assert.equal(input.base64, 'JVBERi0=');
});

await asyncT('POST add_attachment 透传 role=problem', async () => {
  const calls = [];
  const res = makeRes();
  await handleExerciseHttp(
    makeReq('POST', '/aemeath/api/exercise', {
      action: 'add_attachment',
      course_id: 'physik-1',
      sheet_id: 'ub01',
      problem_id: 'p01',
      base64: 'AAAA',
      role: 'problem',
    }),
    res,
    fakeDeps(calls),
  );
  assert.equal(res.out.status, 200);
});

console.log(`\n[exercise-check-http] ${passed} 项断言通过`);
