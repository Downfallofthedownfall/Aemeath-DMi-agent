// ============================================================
// test/check7.mjs — LLM 分块（prompt / 分块 / 解析 / 覆盖率护栏）
//
// 这些是"不联网"的纯逻辑测试：真正的模型调用在 index.ts 注入，
// 这里用假 ask 覆盖成功、失败、偷懒（覆盖率低）、文本过长四条路径。
// ============================================================
import assert from 'node:assert/strict';
import {
  buildSegmentPrompt,
  chunkForSegmentation,
  parseSegmentOutput,
  segmentWithLlm,
  SEGMENT_CHUNK_CHARS,
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

const SOURCE = `Universität Hamburg · Physik I
Übungsblatt 3                    Abgabe: 22.10.2026

Aufgabe 1 (4 Punkte)
Ein Körper der Masse m = 2 kg gleitet reibungsfrei eine schiefe Ebene
mit dem Neigungswinkel alpha = 30 Grad hinab. Berechnen Sie a und N.
a) Stellen Sie das Kräftegleichgewicht auf.
b) Prüfen Sie das Ergebnis mit einer Dimensionsanalyse.

Aufgabe 2 (6 Punkte)
Ein Pendel der Länge l = 1 m schwingt mit kleiner Amplitude.
Bestimmen Sie die Schwingungsdauer T.
c) Was passiert bei großen Amplituden?`;

const PROBS = [
  {
    label: 'Aufgabe 1',
    title: 'Schiefe Ebene',
    text: `Ein Körper der Masse m = 2 kg gleitet reibungsfrei eine schiefe Ebene
mit dem Neigungswinkel alpha = 30 Grad hinab. Berechnen Sie a und N.
a) Stellen Sie das Kräftegleichgewicht auf.
b) Prüfen Sie das Ergebnis mit einer Dimensionsanalyse.`,
    points: 4,
    page: 1,
  },
  {
    label: 'Aufgabe 2',
    title: 'Pendel',
    text: `Ein Pendel der Länge l = 1 m schwingt mit kleiner Amplitude.
Bestimmen Sie die Schwingungsdauer T.
c) Was passiert bei großen Amplituden?`,
    points: 6,
    page: 1,
  },
];

t('prompt 含全部硬性规则（只切分/子问留父题/丢页眉页脚/严格 JSON）', () => {
  const p = buildSegmentPrompt(SOURCE);
  assert.match(p, /只切分，不改写/);
  assert.match(p, /留在父题/);
  assert.match(p, /页眉\/页脚/);
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
});

t('parseSegmentOutput：干净 JSON', () => {
  const out = parseSegmentOutput(JSON.stringify({ problems: PROBS }));
  assert.equal(out.length, 2);
  assert.equal(out[0].label, 'Aufgabe 1');
  assert.equal(out[0].points, 4);
});

t('parseSegmentOutput：```json 围栏 + 前后废话', () => {
  const raw = `好的：\n\`\`\`json\n${JSON.stringify({ problems: PROBS })}\n\`\`\`\n完成。`;
  assert.equal(parseSegmentOutput(raw).length, 2);
});

t('parseSegmentOutput：截断的 JSON 也能救回来', () => {
  const full = JSON.stringify({ problems: PROBS });
  const cut = full.slice(0, Math.floor(full.length * 0.72));
  const out = parseSegmentOutput(cut);
  assert.ok(out && out.length >= 1, '截断输出应当至少救回一题');
});

t('parseSegmentOutput：丢掉空题干、按内容去重、无 label 自动补', () => {
  const out = parseSegmentOutput(
    JSON.stringify({
      problems: [
        { label: '', text: 'Erste Aufgabe mit Inhalt' },
        { label: 'Aufgabe 1', text: 'Erste Aufgabe mit Inhalt' }, // 与上一条正文相同 → 去重
        { label: 'Aufgabe 2', text: '   ' },
      ],
    }),
  );
  assert.equal(out.length, 1);
  // 没有 label 的题自动补成 Aufgabe 1；与它重复的那条（正文相同）被去掉
  assert.equal(out[0].label, 'Aufgabe 1');
});

t('parseSegmentOutput：垃圾输入返回 null', () => {
  assert.equal(parseSegmentOutput(null), null);
  assert.equal(parseSegmentOutput('我切好了'), null);
  assert.equal(parseSegmentOutput('{"problems": "nope"}'), null);
});

await asyncT('segmentWithLlm：成功（覆盖率达标）', async () => {
  const r = await segmentWithLlm(SOURCE, async () => JSON.stringify({ problems: PROBS }));
  assert.equal(r.ok, true);
  assert.equal(r.problems.length, 2);
  assert.equal(r.parts, 1);
  assert.ok((r.coverage ?? 0) > 0.55);
});

await asyncT('segmentWithLlm：模型不可用 → ok:false（调用方退回规则）', async () => {
  const r = await segmentWithLlm(SOURCE, async () => null);
  assert.equal(r.ok, false);
  assert.match(r.error, /LLM 不可用/);
});

await asyncT('segmentWithLlm：输出不可解析 → ok:false 并保留原文', async () => {
  const r = await segmentWithLlm(SOURCE, async () => '切好了');
  assert.equal(r.ok, false);
  assert.match(r.error, /不可解析/);
  assert.equal(r.raw, '切好了');
});

await asyncT('segmentWithLlm：模型偷懒（覆盖率低）→ ok:false 且报覆盖率', async () => {
  const lazy = { problems: [{ label: 'Aufgabe 1', text: 'Kurz.', points: 4, page: 1 }] };
  const r = await segmentWithLlm(SOURCE, async () => JSON.stringify(lazy));
  assert.equal(r.ok, false);
  assert.match(r.error, /只覆盖原文/);
  assert.ok((r.coverage ?? 1) < 0.55);
});

await asyncT('segmentWithLlm：文本过长（超过 maxParts）→ 明确拒绝', async () => {
  const page = 'y'.repeat(3000);
  const long = Array.from({ length: 10 }, () => page).join('\f');
  const r = await segmentWithLlm(long, async () => JSON.stringify({ problems: PROBS }), { chunkChars: 5000, maxParts: 6 });
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
