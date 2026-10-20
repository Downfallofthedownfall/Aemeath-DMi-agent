// ============================================================
// test/check8.mjs — 多模态读图分块（prompt / 解析 / 跨页合并 / 页码工具）
//
// 不联网：真正的多模态请求由 index.ts 注入（直连 + 全局凭据 + thinking disabled），
// 这里用假 ask 覆盖"每页一个请求 → 合并"的完整逻辑，以及跨页续文的合并规则。
// ============================================================
import assert from 'node:assert/strict';
import {
  buildVisionPrompt,
  mergeVisionPages,
  parseVisionOutput,
  segmentWithVision,
} from '../lib/vision.js';
import { pageFromImageName, pageImageName } from '../lib/pdf-image.js';

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

const p1 = {
  problems: [
    {
      label: 'Aufgabe 1',
      text: 'Ein Körper der Masse $m = 2\\,\\mathrm{kg}$ gleitet reibungsfrei eine schiefe Ebene mit $\\alpha = 30^\\circ$ hinab.\na) Stellen Sie das Kräftegleichgewicht auf.\nb) Prüfen Sie das Ergebnis mit einer Dimensionsanalyse.',
      points: 4,
      page: 1,
      has_figure: true,
      figure_note: '斜面与物块的受力图',
      continues: '',
    },
    {
      label: 'Aufgabe 2',
      text: 'Ein Pendel der Länge $l = 1\\,\\mathrm{m}$ schwingt mit kleiner Amplitude. Bestimmen Sie die Schwingungsdauer $T$.',
      points: 6,
      page: 1,
      has_figure: false,
      figure_note: '',
      continues: '',
    },
  ],
};

const p2 = {
  problems: [
    {
      label: 'Aufgabe 3',
      // 续文：从上一页延续
      text: 'c) Was passiert bei großen Amplituden? Begründen Sie mit der Reihenentwicklung.',
      points: null,
      page: 2,
      has_figure: false,
      figure_note: '',
      continues: 'Aufgabe 2',
    },
    {
      label: 'Aufgabe 4',
      text: 'Zwei Massen $m_1 = 1\\,\\mathrm{kg}$ und $m_2 = 3\\,\\mathrm{kg}$ stoßen zentral zusammen.',
      points: 5,
      page: 2,
      has_figure: false,
      figure_note: '',
      continues: '',
    },
  ],
};

t('prompt 含关键约束（逐字转录 / LaTeX / 跨页 continues / 页眉丢弃 / 图注 / 页码）', () => {
  const p = buildVisionPrompt(2, 3);
  assert.match(p, /第 2 页（共 3 页）/);
  assert.match(p, /逐字转录/);
  assert.match(p, /LaTeX/);
  assert.match(p, /continues/);
  assert.match(p, /页眉\/页脚/);
  assert.match(p, /figure_note/);
  assert.match(p, /一律填 2/);
});

t('parseVisionOutput：干净 JSON', () => {
  const out = parseVisionOutput(JSON.stringify(p1));
  assert.equal(out.length, 2);
  assert.equal(out[0].label, 'Aufgabe 1');
  assert.equal(out[0].points, 4);
  assert.equal(out[0].has_figure, true);
  assert.match(out[0].figure_note, /斜面/);
});

t('parseVisionOutput：```json 围栏', () => {
  const raw = '好的\n```json\n' + JSON.stringify(p1) + '\n```\n';
  assert.equal(parseVisionOutput(raw).length, 2);
});

t('parseVisionOutput：截断也能救回至少一题', () => {
  const full = JSON.stringify(p1);
  const cut = full.slice(0, Math.floor(full.length * 0.75));
  const out = parseVisionOutput(cut);
  assert.ok(out && out.length >= 1);
});

t('parseVisionOutput：新题太短被丢、续文短也保留', () => {
  const out = parseVisionOutput(
    JSON.stringify({
      problems: [
        { label: 'Aufgabe 1', text: 'kurz', continues: '' },
        { label: 'Aufgabe 2', text: 'siehe oben', continues: 'Aufgabe 1', page: 2 },
      ],
    }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].continues, 'Aufgabe 1');
});

t('parseVisionOutput：垃圾 → null', () => {
  assert.equal(parseVisionOutput(null), null);
  assert.equal(parseVisionOutput('ok'), null);
  assert.equal(parseVisionOutput('{"problems":"x"}'), null);
});

t('parseVisionOutput：空白页 {"problems":[]} 是合法结果（不是失败）', () => {
  const out = parseVisionOutput('{"problems":[]}');
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 0);
});

t('mergeVisionPages：跨页续文并回父题（不是两道同名题）', () => {
  const merged = mergeVisionPages([
    { page: 1, problems: parseVisionOutput(JSON.stringify(p1)) },
    { page: 2, problems: parseVisionOutput(JSON.stringify(p2)) },
  ]);
  assert.equal(merged.length, 3, `应当是 3 题，实际 ${merged.length}`);
  assert.deepEqual(
    merged.map((m) => m.label),
    ['Aufgabe 1', 'Aufgabe 2', 'Aufgabe 4'],
  );
  const a2 = merged.find((m) => m.label === 'Aufgabe 2');
  assert.match(a2.text, /Schwingungsdauer/);
  assert.match(a2.text, /Was passiert bei großen Amplituden/, '续文应并进 Aufgabe 2');
  assert.equal(a2.points, 6, '父题分值不被续文的 null 覆盖');
  assert.equal(a2.page, 1, '页码取父题起始页');
});

t('mergeVisionPages：同一题号重复出现（模型没标 continues）也合并', () => {
  const merged = mergeVisionPages([
    { page: 1, problems: [{ label: 'Aufgabe 1', text: 'Erster Teil der Aufgabe eins.', points: 4, page: 1, has_figure: false, figure_note: '', continues: '' }] },
    { page: 2, problems: [{ label: 'Aufgabe 1', text: 'Zweiter Teil der Aufgabe eins.', points: null, page: 2, has_figure: true, figure_note: 'Skizze', continues: '' }] },
  ]);
  assert.equal(merged.length, 1);
  assert.match(merged[0].text, /Zweiter Teil/);
  assert.equal(merged[0].has_figure, true, '带图标记要并集');
  assert.equal(merged[0].figure_note, 'Skizze');
});

t('mergeVisionPages：按页码排序合并（输入乱序也稳）', () => {
  const merged = mergeVisionPages([
    { page: 2, problems: parseVisionOutput(JSON.stringify(p2)) },
    { page: 1, problems: parseVisionOutput(JSON.stringify(p1)) },
  ]);
  assert.equal(merged[0].label, 'Aufgabe 1');
});

t('pageImageName / pageFromImageName：补零与反解', () => {
  assert.equal(pageImageName(1), 'page-01.jpg');
  assert.equal(pageImageName(12), 'page-12.jpg');
  assert.equal(pageFromImageName('page-07.jpg'), 7);
  assert.equal(pageFromImageName('page-07.png'), 7);
  assert.equal(pageFromImageName('cover.jpg'), 0);
});

await asyncT('segmentWithVision：两页各一次请求 → 合并 3 题', async () => {
  let calls = 0;
  const r = await segmentWithVision(
    [
      { page: 1, mediaType: 'image/jpeg', base64: 'AAA' },
      { page: 2, mediaType: 'image/jpeg', base64: 'BBB' },
    ],
    async (prompt, images) => {
      calls++;
      assert.equal(images.length, 1, '每页只带一张图');
      return prompt.includes('第 1 页') ? JSON.stringify(p1) : JSON.stringify(p2);
    },
  );
  assert.equal(calls, 2);
  assert.equal(r.ok, true);
  assert.equal(r.problems.length, 3);
  assert.equal(r.pages, 2);
});

await asyncT('segmentWithVision：某页返回空 → 整体失败（不产生半份卷子）', async () => {
  const r = await segmentWithVision(
    [
      { page: 1, mediaType: 'image/jpeg', base64: 'AAA' },
      { page: 2, mediaType: 'image/jpeg', base64: 'BBB' },
    ],
    async (prompt) => (prompt.includes('第 1 页') ? JSON.stringify(p1) : null),
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /第 2 页/);
  assert.equal(r.problems.length, 0);
});

await asyncT('segmentWithVision：输出不可解析 → 失败并保留原文', async () => {
  const r = await segmentWithVision([{ page: 1, mediaType: 'image/jpeg', base64: 'AAA' }], async () => '我读好了');
  assert.equal(r.ok, false);
  assert.match(r.error, /不是可解析/);
  assert.equal(r.raw, '我读好了');
});

await asyncT('segmentWithVision：没有页面图片 → 直接失败', async () => {
  const r = await segmentWithVision([], async () => 'x');
  assert.equal(r.ok, false);
});

console.log(`\n[exercise-vision] ${passed} 项断言通过`);
