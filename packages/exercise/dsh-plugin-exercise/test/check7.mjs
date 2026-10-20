// ============================================================
// test/check7.mjs — LLM 分块（锚点模式：prompt / 解析 / 定位 / 覆盖率护栏）
//
// 这是"不联网"的纯逻辑测试：真正的模型调用由 index.ts 注入，
// 这里用假 ask 覆盖成功、失败、锚点定位不到、覆盖不足、文本过长、空输入几条路径。
//
// 重点：模型**只回边界**（label/points/起始句），正文由 locateAnchors() 在原文上裁切 ——
// 这样输出只有几百 token，不会被推理模型的 token 预算吃空（真机踩过的空文本）。
// ============================================================
import assert from 'node:assert/strict';
import {
  buildSegmentPrompt,
  chunkForSegmentation,
  locateAnchors,
  parseSegmentOutput,
  segmentWithLlm,
  SEGMENT_CHUNK_CHARS,
  SEGMENT_MAX_PARTS,
} from '../lib/llm-split.js';

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

const HEADER = `Universität Hamburg · Physik I
Übungsblatt 3                    Abgabe: 22.10.2026
`;

const A1 = `Aufgabe 1 (4 Punkte)
Ein Körper der Masse m = 2 kg gleitet reibungsfrei eine schiefe Ebene
mit dem Neigungswinkel alpha = 30 Grad hinab. Berechnen Sie a und N.
a) Stellen Sie das Kräftegleichgewicht auf.
b) Prüfen Sie das Ergebnis mit einer Dimensionsanalyse.`;

const A2 = `Aufgabe 2 (6 Punkte)
Ein Pendel der Länge l = 1 m schwingt mit kleiner Amplitude.
Bestimmen Sie die Schwingungsdauer T.
c) Was passiert bei großen Amplituden? Begründen Sie.`;

const SOURCE = `${HEADER}
${A1}

${A2}`;

const ANCHORS = [
  { label: 'Aufgabe 1', start: 'Ein Körper der Masse m = 2 kg gleitet reibungsfrei eine schiefe Ebene', points: 4, page: 1 },
  { label: 'Aufgabe 2', start: 'Ein Pendel der Länge l = 1 m schwingt mit kleiner Amplitude.', points: 6, page: 1 },
];

t('prompt 只问边界（不要复制正文 / 逐字照抄 / 子问不是新题）', () => {
  const p = buildSegmentPrompt(SOURCE);
  assert.match(p, /不要复制正文/);
  assert.match(p, /逐字照抄/);
  assert.match(p, /不是\*\*新题|不是\*\*新题/);
  assert.match(p, /严格 JSON/);
  assert.match(p, /Aufgabe 1 \(4 Punkte\)/);
});

t('prompt 分段时明确"这是第 i/n 段、不要编造别段"', () => {
  const p = buildSegmentPrompt('x', 2, 3);
  assert.match(p, /第 2\/3 段/);
  assert.match(p, /不要编造/);
});

t('chunkForSegmentation：短文本不切', () => {
  assert.equal(chunkForSegmentation(SOURCE).length, 1);
});

t('chunkForSegmentation：长文本按页切且每段不超过上限', () => {
  const page = 'x'.repeat(4000);
  const long = [page, page, page, page, page].join('\f');
  const chunks = chunkForSegmentation(long, 9000);
  assert.ok(chunks.length >= 2, `应当切成多段，实际 ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= 9000, `段长 ${c.length} 超过 9000`);
  assert.equal(SEGMENT_CHUNK_CHARS, 18000);
  assert.equal(SEGMENT_MAX_PARTS, 6);
});

t('parseSegmentOutput：干净 JSON（锚点，不含正文）', () => {
  const out = parseSegmentOutput(JSON.stringify({ problems: ANCHORS }));
  assert.equal(out.length, 2);
  assert.equal(out[0].label, 'Aufgabe 1');
  assert.equal(out[0].points, 4);
  assert.ok(out[0].start.startsWith('Ein Körper'));
});

t('parseSegmentOutput：```json 围栏 + 前后废话', () => {
  const raw = `好的：\n\`\`\`json\n${JSON.stringify({ problems: ANCHORS })}\n\`\`\`\n完成。`;
  assert.equal(parseSegmentOutput(raw).length, 2);
});

t('parseSegmentOutput：截断的 JSON 也能救回来', () => {
  const full = JSON.stringify({ problems: ANCHORS });
  const cut = full.slice(0, Math.floor(full.length * 0.68));
  const out = parseSegmentOutput(cut);
  assert.ok(out && out.length >= 1, '截断输出应当至少救回一题');
});

t('parseSegmentOutput：start 太短（模型只回题号）→ 丢掉该条', () => {
  const out = parseSegmentOutput(
    JSON.stringify({
      problems: [
        { label: 'Aufgabe 1', start: 'Aufgabe 1', points: 4 },
        { label: 'Aufgabe 2', start: ANCHORS[1].start, points: 6 },
      ],
    }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'Aufgabe 2');
});

t('parseSegmentOutput：垃圾输入返回 null', () => {
  assert.equal(parseSegmentOutput(null), null);
  assert.equal(parseSegmentOutput('我切好了'), null);
  assert.equal(parseSegmentOutput('{"problems": "nope"}'), null);
});

t('locateAnchors：按锚点裁切，正文是原文、页眉与下一题标题都不混进来', () => {
  const out = locateAnchors(SOURCE, parseSegmentOutput(JSON.stringify({ problems: ANCHORS })));
  assert.ok(out, '应当定位成功');
  assert.equal(out.length, 2);
  // 锚点指向"正文第一句"，所以题号行不在正文里（界面另有 label 徽章）
  assert.match(out[0].text, /^Ein Körper der Masse m = 2 kg/);
  assert.match(out[0].text, /Dimensionsanalyse/);
  assert.doesNotMatch(out[0].text, /Pendel/);
  // 下一题的标题行必须被剥掉，不能挂在上一题末尾
  assert.doesNotMatch(out[0].text, /Aufgabe 2/);
  assert.match(out[1].text, /^Ein Pendel der Länge l = 1 m/);
  assert.match(out[1].text, /Begründen Sie/);
  assert.doesNotMatch(out[1].text, /Universität/); // 页眉不进入任何题
});

t('locateAnchors：标题取正文首行（剥掉题号、限长 60 内）', () => {
  const out = locateAnchors(SOURCE, parseSegmentOutput(JSON.stringify({ problems: ANCHORS })));
  assert.ok(out[0].title.startsWith('Ein Körper der Masse m = 2 kg'));
  assert.ok(out[0].title.length <= 60, `标题太长: ${out[0].title}`);
});

t('locateAnchors：锚点里换行/多空格也能匹配（归一化）', () => {
  const anchors = [
    { label: 'Aufgabe 1', start: 'Ein  Körper der Masse m = 2 kg\n  gleitet reibungsfrei eine schiefe Ebene', points: 4, page: 1 },
    { label: 'Aufgabe 2', start: 'Ein Pendel der Länge l = 1 m schwingt mit kleiner Amplitude.', points: 6, page: 1 },
  ];
  const out = locateAnchors(SOURCE, anchors);
  assert.ok(out && out.length === 2);
});

t('locateAnchors：锚点在原文找不到 → null（不猜）', () => {
  const out = locateAnchors(SOURCE, [
    { label: 'Aufgabe 1', start: '这句话原文里根本没有出现过 ok?', points: 4, page: 1 },
  ]);
  assert.equal(out, null);
});

t('locateAnchors：两个锚点同一位置 → 只保留一个', () => {
  const out = locateAnchors(SOURCE, [
    { label: 'Aufgabe 1', start: ANCHORS[0].start, points: 4, page: 1 },
    { label: 'Aufgabe 1b', start: ANCHORS[0].start, points: 4, page: 1 },
  ]);
  assert.ok(out);
  assert.equal(out.length, 1);
});

t('locateAnchors：只覆盖很小一片（切歪了）→ null', () => {
  const onlyTail = locateAnchors(SOURCE, [
    { label: 'Aufgabe 2', start: 'c) Was passiert bei großen Amplituden? Begründen Sie.', points: 6, page: 1 },
  ]);
  assert.equal(onlyTail, null);
});

await asyncT('segmentWithLlm：成功（锚点 → 原文切片）', async () => {
  const r = await segmentWithLlm(SOURCE, async () => JSON.stringify({ problems: ANCHORS }));
  assert.equal(r.ok, true);
  assert.equal(r.problems.length, 2);
  assert.equal(r.parts, 1);
  assert.ok((r.coverage ?? 0) > 0.55);
  assert.match(r.problems[1].text, /Pendel der Länge/);
});

await asyncT('segmentWithLlm：模型不可用 → ok:false（调用方退回规则）', async () => {
  const r = await segmentWithLlm(SOURCE, async () => null);
  assert.equal(r.ok, false);
  assert.match(r.error, /LLM 不可用/);
});

await asyncT('segmentWithLlm：输出不可解析 → ok:false 并保留原文', async () => {
  const r = await segmentWithLlm(SOURCE, async () => '切好了');
  assert.equal(r.ok, false);
  assert.match(r.error, /锚点/);
  assert.equal(r.raw, '切好了');
});

await asyncT('segmentWithLlm：模型改写了原句（锚点定位不到）→ ok:false', async () => {
  const r = await segmentWithLlm(SOURCE, async () =>
    JSON.stringify({ problems: [{ label: 'Aufgabe 1', start: 'Ein Koerper der Masse m = 2 kg rutscht', points: 4 }] }),
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /定位不到/);
});

await asyncT('segmentWithLlm：文本过长（超过 maxParts）→ 明确拒绝', async () => {
  const page = 'y'.repeat(3000);
  const long = Array.from({ length: 10 }, () => page).join('\f');
  const r = await segmentWithLlm(long, async () => JSON.stringify({ problems: ANCHORS }), { chunkChars: 5000, maxParts: 6 });
  assert.equal(r.ok, false);
  assert.match(r.error, /文本过长/);
});

await asyncT('segmentWithLlm：空文本直接失败（不调模型）', async () => {
  let called = 0;
  const r = await segmentWithLlm('   ', async () => {
    called++;
    return '{}';
  });
  assert.equal(r.ok, false);
  assert.equal(called, 0);
});

console.log(`\n[exercise-llm-split] ${passed} 项断言通过`);
