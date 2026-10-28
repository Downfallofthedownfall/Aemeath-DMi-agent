// ============================================================
// test/check15.mjs — 思路检查（做题中途，只挑错不给解法）
//
// 用户 2026-10-28："做题做一半的时候 LLM 检查做题思路和路径，避免让 llm 写出解题方法，
//   只要指出错误点，避免白白浪费时间科技树点歪，尽量保守提示。"
// 之后澄清：人工触发、可重复、结果临时（不落盘），改内容不消失、手动清除。
// ============================================================

import assert from 'node:assert/strict';
import { buildApproachPrompt, parseApproachOutput } from '../lib/checker.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const base = {
  courseTitle: 'Physik I',
  sheetNumber: 1,
  sheetTitle: 'Mechanik',
  problemLabel: 'Aufgabe 1',
  problemTitle: 'Schiefe Ebene',
  points: 4,
  problemText: 'Ein Körper gleitet reibungsfrei eine schiefe Ebene hinab. Bestimmen Sie $a$.',
  draft: 'Kräfte: $mg\\sin\\alpha$ nach unten, $N$ senkrecht. Also $a = g\\sin\\alpha$ …',
  notes: '',
  lang: 'zh',
};

t('prompt：明确禁止给解法/步骤/答案/中间结果', () => {
  const p = buildApproachPrompt(base);
  assert.match(p, /绝对不要\*\*给出解题方法/);
  assert.match(p, /不要提示"先算 X 再算 Y"/);
  assert.match(p, /路牌/);
});

t('prompt：保守规则（宁可漏报、不要误报）', () => {
  const p = buildApproachPrompt(base);
  assert.match(p, /宁可漏报，也不要误报/);
  assert.match(p, /不确定/);
});

t('prompt：只认 5 类错误点，且最多 2 条', () => {
  const p = buildApproachPrompt(base);
  for (const k of ['物理前提', '漏掉关键条件', '方法从根本上不适用', '量纲', '数学上明显不成立']) {
    assert.ok(p.includes(k), `缺规则：${k}`);
  }
  assert.match(p, /最多 2 条/);
});

t('prompt：带上题干、草稿与备注；草稿为空时也有占位', () => {
  const p = buildApproachPrompt(base);
  assert.ok(p.includes(base.problemText));
  assert.ok(p.includes('a = g\\sin\\alpha'));
  assert.match(buildApproachPrompt({ ...base, draft: '' }), /还是空的/);
});

t('parse：正常 JSON', () => {
  const r = parseApproachOutput(
    JSON.stringify({
      verdict: 'at_risk',
      issues: [{ severity: 'warn', text: '这里把摩擦当成 0 了，但题干没说。' }],
      note: '继续写。',
    }),
  );
  assert.equal(r.verdict, 'at_risk');
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].severity, 'warn');
  assert.equal(r.note, '继续写。');
});

t('parse：issues 超过 2 条会被截断（避免刷屏）', () => {
  const r = parseApproachOutput(
    JSON.stringify({
      verdict: 'wrong',
      issues: [
        { severity: 'error', text: 'a' },
        { severity: 'error', text: 'b' },
        { severity: 'error', text: 'c' },
      ],
    }),
  );
  assert.equal(r.issues.length, 2);
});

t('parse：非法 verdict → unclear；空文本 issue 丢弃；坏 JSON → null', () => {
  assert.equal(parseApproachOutput('{"verdict":"whatever"}').verdict, 'unclear');
  assert.equal(parseApproachOutput('{"verdict":"on_track","issues":[{"text":"  "}]}').issues.length, 0);
  assert.equal(parseApproachOutput('not json at all'), null);
  assert.equal(parseApproachOutput(null), null);
});

t('prompt：德语/英语提示也禁止给解法', () => {
  const de = buildApproachPrompt({ ...base, lang: 'de' });
  assert.match(de, /Keine\*\* Lösungsmethode/);
  const en = buildApproachPrompt({ ...base, lang: 'en' });
  assert.match(en, /Never\*\* give a method/);
});

console.log(`\n[exercise-approach] ${passed} 项断言通过`);
