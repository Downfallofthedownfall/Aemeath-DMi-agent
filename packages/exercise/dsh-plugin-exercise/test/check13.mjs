// ============================================================
// test/check13.mjs — 答案附图（画图）+ 检查的推理强度
//
// 需求（2026-10-22）：「加一个图片附件功能，有时候需要画图」；
// 「reasoning effort 开到 high 或者 max，检查题目重在精而不是快」。
// 这里钉住：格式嗅探（不信扩展名）、存盘/读回、PDF 内联图片、
// 检查 prompt 里声明附图、以及 runCheck 把 reasoning 传给 LLM 通道。
// ============================================================
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageFileName, sniffImageType } from '../lib/images.js';
import { buildCheckPrompt, runCheck } from '../lib/checker.js';
import { ExerciseStore } from '../lib/store.js';
import { buildSubmissionHtml } from '../lib/pdf-html.js';

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

// ---- 最小的真实图片字节 ----
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0x20, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0))));
const GIF = Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0, 0, 0]));

t('嗅探：PNG / JPEG / WebP / GIF 都认（不信扩展名）', () => {
  assert.deepEqual(sniffImageType(PNG), { media: 'image/png', ext: 'png' });
  assert.deepEqual(sniffImageType(JPEG), { media: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(sniffImageType(WEBP), { media: 'image/webp', ext: 'webp' });
  assert.deepEqual(sniffImageType(GIF), { media: 'image/gif', ext: 'gif' });
});

t('嗅探：SVG / 文本 / 空数据 / 截断头部一律拒绝', () => {
  assert.equal(sniffImageType(Uint8Array.from([...'<svg xmlns="…">'].map((c) => c.charCodeAt(0)))), null);
  assert.equal(sniffImageType(Uint8Array.from([...'hello'].map((c) => c.charCodeAt(0)))), null);
  assert.equal(sniffImageType(new Uint8Array(0)), null);
  assert.equal(sniffImageType(Uint8Array.from([0x89, 0x50])), null);
});

t('文件名：时间 + 随机后缀 + 内容推导的扩展名', () => {
  const name = imageFileName(1792529000000, 'ab3', 'png');
  assert.match(name, /^img-[0-9a-z]+-ab3\.png$/);
});

await asyncT('store：图片写入 / 读回（media type 按扩展名）/ 删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ex-img-'));
  try {
    const store = new ExerciseStore({ rootDir: dir });
    const course = store.ensureCourse('physik-1', 'Physik I');
    assert.ok(course);
    const bytes = Buffer.from(PNG);
    const written = store.writeImage('physik-1', 'ub01', 'img-1-aa.png', bytes);
    assert.equal(written, bytes.length);
    const got = store.readImage('physik-1', 'ub01', 'img-1-aa.png');
    assert.ok(got);
    assert.equal(got.mediaType, 'image/png');
    assert.equal(got.bytes.length, bytes.length);
    assert.deepEqual([...got.bytes], [...bytes]);
    // 路径穿越不能逃出 images/ 目录
    const escaped = store.imageFile('physik-1', 'ub01', '../../sheet.json');
    assert.ok(!escaped.includes('..'), '文件名里的 .. 必须被清掉');
    assert.equal(store.deleteImage('physik-1', 'ub01', 'img-1-aa.png'), true);
    assert.equal(store.readImage('physik-1', 'ub01', 'img-1-aa.png'), null);
    assert.equal(store.deleteImage('physik-1', 'ub01', 'img-1-aa.png'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t('检查 prompt：声明学生附了手画图，并说明要把图算进答案', () => {
  const p = buildCheckPrompt({
    courseTitle: 'Physik I',
    sheetNumber: 3,
    sheetTitle: 'Mechanik',
    problemLabel: 'Aufgabe 1',
    problemTitle: '',
    points: 4,
    problemText: 'Bestimmen Sie $a$.',
    answer: '$a=g\\sin\\alpha$',
    answerImages: [{ base64: 'AAA', mediaType: 'image/png', name: 'img-1.png' }],
  });
  assert.match(p, /学生答案里附了 1 张手画图/);
  assert.match(p, /把图里的内容也算进答案/);
});

t('检查 prompt：没有附图时不会冒出这段话', () => {
  const p = buildCheckPrompt({
    courseTitle: 'Physik I',
    sheetNumber: 3,
    sheetTitle: '',
    problemLabel: 'Aufgabe 1',
    problemTitle: '',
    points: null,
    problemText: 'x',
    answer: 'y',
  });
  assert.ok(!p.includes('手画图'));
});

await asyncT('runCheck：把 reasoning=high 和 32000 token 传给文本通道（放开烧 token）', async () => {
  let seen = null;
  const askLlm = async (_prompt, opts) => {
    seen = opts;
    return JSON.stringify({ verdict: 'correct', score: 1, issues: [], hints: [], next_steps: [] });
  };
  const r = await runCheck(
    {
      courseTitle: 'Physik I',
      sheetNumber: 1,
      sheetTitle: '',
      problemLabel: 'Aufgabe 1',
      problemTitle: '',
      points: null,
      problemText: 'x',
      answer: 'y',
      reasoning: 'high',
    },
    askLlm,
  );
  assert.equal(r.ok, true);
  assert.equal(seen.reasoning, 'high');
  assert.equal(seen.maxTokens, 32000);
  assert.equal(seen.timeoutMs, 180_000, '批改给 180s，别被 60s 掐断');
});

await asyncT('runCheck：原题图 + 学生手画图一起送多模态（顺序：原题在前）', async () => {
  let images = null;
  let opts = null;
  const askLlm = async () => {
    throw new Error('不该走文本通道');
  };
  const askVision = async (_prompt, imgs, o) => {
    images = imgs;
    opts = o;
    return JSON.stringify({ verdict: 'partial', score: 0.5, issues: [], hints: [], next_steps: [] });
  };
  const r = await runCheck(
    {
      courseTitle: 'Physik I',
      sheetNumber: 1,
      sheetTitle: '',
      problemLabel: 'Aufgabe 1',
      problemTitle: '',
      points: null,
      problemText: 'x',
      answer: 'y',
      reasoning: 'high',
      pageImages: [{ base64: 'PAGE', mediaType: 'image/jpeg', page: 2 }],
      answerImages: [{ base64: 'DRAW', mediaType: 'image/png', name: 'img-1.png' }],
    },
    askLlm,
    askVision,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(images.map((i) => i.base64), ['PAGE', 'DRAW']);
  assert.equal(opts.reasoning, 'high');
  assert.equal(opts.maxTokens, 32000, '多模态批改也给足预算，推理不再被掐断');
  assert.equal(opts.timeoutMs, 180_000);
});

t('PDF：答案附图内联成 <figure><img>（带图注，无则只图）', () => {
  const html = buildSubmissionHtml({
    courseTitle: 'Physik I',
    courseId: 'physik-1',
    sheet: { id: 'ub01', number: 1, title: 'Mechanik', issued: '', due: '' },
    problems: [
      {
        label: 'Aufgabe 1',
        title: '',
        text: 'Bestimmen Sie $a$.',
        points: 4,
        answer: '$a=g\\sin\\alpha$',
        images: [
          { name: 'img-1.png', caption: '受力图', dataUri: 'data:image/png;base64,AAA' },
          { name: 'img-2.png', caption: '', dataUri: 'data:image/png;base64,BBB' },
        ],
      },
    ],
  });
  assert.match(html, /class="answer-figure"/);
  assert.match(html, /src="data:image\/png;base64,AAA"/);
  assert.match(html, /alt="受力图"/);
  assert.match(html, /<figcaption>受力图<\/figcaption>/);
  // 没有图注的不输出空 figcaption
  assert.ok(!/figcaption><\/figcaption>/.test(html));
});

t('PDF：没有附图时不产生 figure 块', () => {
  const html = buildSubmissionHtml({
    courseTitle: 'Physik I',
    courseId: 'physik-1',
    sheet: { id: 'ub01', number: 1, title: '', issued: '', due: '' },
    problems: [{ label: 'Aufgabe 1', title: '', text: 'x', points: null, answer: 'y' }],
  });
  assert.ok(!html.includes('<figure class="answer-figure"'), 'CSS 里本来就有 .answer-figure，这里查的是实际标记');
});


t('检查 prompt：题干截图单独声明（以图为准）', () => {
  const p = buildCheckPrompt({
    courseTitle: 'Physik I',
    sheetNumber: 1,
    sheetTitle: '',
    problemLabel: 'Aufgabe 1',
    problemTitle: '',
    points: null,
    problemText: 'OCR 文本',
    answer: 'x',
    statementImages: [{ base64: 'IMG', mediaType: 'image/png', name: 'problem.png' }],
  });
  assert.match(p, /题目以图片形式提供/);
  assert.match(p, /以图为准/);
});

await asyncT('runCheck：题干截图排在原题截图和学生手画图之前', async () => {
  let images = null;
  const askLlm = async () => {
    throw new Error('不该走文本通道');
  };
  const askVision = async (_p, imgs) => {
    images = imgs;
    return JSON.stringify({ verdict: 'correct', score: 1, issues: [], hints: [], next_steps: [] });
  };
  await runCheck(
    {
      courseTitle: 'Physik I',
      sheetNumber: 1,
      sheetTitle: '',
      problemLabel: 'A1',
      problemTitle: '',
      points: null,
      problemText: 'x',
      answer: 'y',
      statementImages: [{ base64: 'PROB', mediaType: 'image/png', name: 'p.png' }],
      pageImages: [{ base64: 'PAGE', mediaType: 'image/jpeg', page: 1 }],
      answerImages: [{ base64: 'DRAW', mediaType: 'image/png', name: 'a.png' }],
    },
    askLlm,
    askVision,
  );
  assert.deepEqual(images.map((i) => i.base64), ['PROB', 'PAGE', 'DRAW']);
});

t('跨页：多张原卷页一起发，prompt 明确"一道题跨页了"', () => {
  const p = buildCheckPrompt({
    courseTitle: 'Physik I',
    sheetNumber: 1,
    sheetTitle: '',
    problemLabel: 'A1',
    problemTitle: '',
    points: null,
    problemText: 'x',
    answer: 'y',
    pageImages: [
      { base64: 'P1', mediaType: 'image/jpeg', page: 2 },
      { base64: 'P2', mediaType: 'image/jpeg', page: 3 },
    ],
  });
  assert.match(p, /原卷第 2、3 页截图/);
  assert.match(p, /一道题跨页了/);
});
console.log(`\n[exercise-attachments] ${passed} 项断言通过`);
