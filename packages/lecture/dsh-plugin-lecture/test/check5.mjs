// ============================================================
// check5.mjs — 数学符号边栏单测（纯函数：光标逻辑 + 数据完整性）
//
// 为什么单独测：光标落点最容易错（括号配对 / 选区替换 / 模板插槽 / Tab 跳转），
// 而且错了以后前端表现是"打字位置莫名跳走"，很难定位。
// 这里把逻辑与 DOM 分离后就能直接断言。
// ============================================================
import assert from 'node:assert/strict';
import {
  SYMBOL_GROUPS,
  allSymbols,
  findSymbol,
  insertSymbol,
  insertedAlphabet,
  renderTemplate,
  nextSlot,
  shiftSlots,
} from '../lib/symbols.js';
import { parseShorthand, textsOfKind } from '../lib/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LectureStore, parseUnitMarkdown } from '../lib/store.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---------- 数据完整性 ----------

t('分组非空且 id/label 齐全', () => {
  assert.ok(SYMBOL_GROUPS.length >= 10, `分组偏少: ${SYMBOL_GROUPS.length}`);
  for (const g of SYMBOL_GROUPS) {
    assert.ok(g.id && g.label, `分组缺字段: ${JSON.stringify(g)}`);
    assert.ok(g.symbols.length > 0, `分组为空: ${g.id}`);
  }
});

t('分组 id 唯一', () => {
  const ids = SYMBOL_GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
});

t('每个符号有 label / insert / 合法 caret', () => {
  const valid = new Set(['end', 'braces', 'parens', 'subscript']);
  for (const s of allSymbols()) {
    assert.ok(s.label, '缺 label');
    assert.ok(typeof s.insert === 'string', `insert 非字符串: ${s.label}`);
    assert.ok(valid.has(s.caret), `caret 非法: ${s.label} → ${s.caret}`);
  }
});

t('label 全局唯一（前端用它做点击 key）', () => {
  const labels = allSymbols().map((s) => s.label);
  const dups = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))];
  assert.deepEqual(dups, [], `重复 label: ${dups.join(', ')}`);
});

t('符号总量足够覆盖"全谱"要求（>=200）', () => {
  assert.ok(allSymbols().length >= 200, `仅 ${allSymbols().length} 个`);
});

t('复杂结构数量足够（>=25 个带插槽模板）', () => {
  const n = allSymbols().filter((s) => s.kind === 'structured').length;
  assert.ok(n >= 25, `仅 ${n} 个 structured`);
});

t('findSymbol 能查到 / 查不到返回 undefined', () => {
  assert.equal(findSymbol('∫').insert, '∫');
  assert.equal(findSymbol('不存在的符号'), undefined);
});

// ---------- 用户点名要的符号都在 ----------

t('用户点名（第一轮）：∫ √ 三角 d/dt', () => {
  const labels = new Set(allSymbols().map((s) => s.label));
  for (const need of ['∫', '√', 'sin', 'cos', 'tan', 'd/dt', '∂/∂x', 'd/dx']) {
    assert.ok(labels.has(need), `缺少: ${need}`);
  }
});

t('用户点名（第二轮）：∏ 及其各种形态', () => {
  const labels = new Set(allSymbols().map((s) => s.label));
  for (const need of ['∏', '∏ 上下限', '∏ 仅下', '∑ 上下限', '∑ 仅下']) {
    assert.ok(labels.has(need), `缺少: ${need}`);
  }
});

t('用户点名（第三轮）：∑ / lim / ∈ / ∀ gilt 这类带条件的', () => {
  const labels = new Set(allSymbols().map((s) => s.label));
  for (const need of ['∑ 上下限', 'lim', '∈', '∀ 任意', '∃ 存在', '∫ 上下限', 'ℝ', '⋃ 上下限', '⋂ 上下限']) {
    assert.ok(labels.has(need), `缺少: ${need}`);
  }
});

t('矢量/导数记号（本校约定：点号 + 半箭头 + 帽子 + 上划线）', () => {
  const labels = new Set(allSymbols().map((s) => s.label));
  for (const need of ['r⃗ 矢量', 'ṙ 时间导数', 'r̈ 二阶时间导数', 'r̄ 平均值', 'r̂ 单位矢量']) {
    assert.ok(labels.has(need), `缺少: ${need}`);
  }
});

t('量子力学 bra-ket 在', () => {
  const labels = new Set(allSymbols().map((s) => s.label));
  for (const need of ['⟨ψ| 左矢', '|ψ⟩ 右矢', '⟨φ|ψ⟩ 内积', '⟨A⟩ 期望值']) {
    assert.ok(labels.has(need), `缺少: ${need}`);
  }
});

t('集合与逻辑齐全', () => {
  const labels = new Set(allSymbols().map((s) => s.label));
  for (const need of ['∈', '∉', '⊂', '⊆', '∪', '∩', '∅', '∧', '∨', '¬', 'ℕ', 'ℤ', 'ℚ', 'ℂ', 'ℝ']) {
    assert.ok(labels.has(need), `缺少: ${need}`);
  }
});

t('带条件的符号用 template 且 kind=structured', () => {
  for (const label of ['∑ 上下限', '∑ 仅下', '∏ 上下限', '∏ 仅下', 'lim', '∫ 上下限', '∮ 路径', '∀ 任意', '∃ 存在', '⋃ 上下限']) {
    const s = findSymbol(label);
    assert.ok(s, `找不到 ${label}`);
    assert.ok(s.template, `${label} 缺 template`);
    assert.equal(s.kind, 'structured', `${label} kind 应为 structured`);
  }
});

t('template 里不出现字面占位文本（避免污染笔记）', () => {
  for (const s of allSymbols()) {
    if (!s.template) continue;
    assert.doesNotMatch(s.template, /\bi=1\b/, `${s.label} 模板含字面量 i=1`);
    assert.doesNotMatch(s.template, /\bx→0\b/, `${s.label} 模板含字面量 x→0`);
  }
});

t('每个 template 的插槽数与 slots 声明一致', () => {
  for (const s of allSymbols()) {
    if (!s.template) continue;
    const declared = new Set((s.slots ?? []).map((x) => x.index));
    const inTemplate = new Set([...s.template.matchAll(/\$(\d)/g)].map((m) => Number(m[1])));
    assert.deepEqual(
      [...inTemplate].sort((a, b) => a - b),
      [...declared].sort((a, b) => a - b),
      `${s.label}: 模板插槽 ${[...inTemplate]} vs 声明 ${[...declared]}`,
    );
  }
});

// ---------- 插入：末尾追加 ----------

t('end 型：末尾追加，光标在末尾', () => {
  const r = insertSymbol('L = r ', 6, 6, findSymbol('× 叉乘'));
  assert.equal(r.text, 'L = r ×');
  assert.equal(r.caret, r.text.length);
});

t('end 型：行中插入，光标随之偏移', () => {
  const r = insertSymbol('abcd', 2, 2, findSymbol('× 叉乘'));
  assert.equal(r.text, 'ab×cd');
  assert.equal(r.caret, 3);
});

t('autoSpace：前面是字母时自动补空格', () => {
  const r = insertSymbol('L = r', 5, 5, findSymbol('× 叉乘'), { autoSpace: true });
  assert.equal(r.text, 'L = r ×');
});

t('autoSpace：前面已是空白则不重复补', () => {
  const r = insertSymbol('L = r ', 6, 6, findSymbol('× 叉乘'), { autoSpace: true });
  assert.equal(r.text, 'L = r ×');
});

t('autoSpace：行首不补空格', () => {
  const r = insertSymbol('', 0, 0, findSymbol('× 叉乘'), { autoSpace: true });
  assert.equal(r.text, '×');
});

// ---------- 插入：括号类（光标落点在括号内） ----------

t('parens 型：sin → sin() 且光标在括号内', () => {
  const r = insertSymbol('= ', 2, 2, findSymbol('sin'));
  assert.equal(r.text, '= sin()');
  assert.equal(r.caret, 6);
  assert.equal(r.text.slice(0, r.caret), '= sin(');
  assert.equal(r.text.slice(r.caret), ')');
});

t('parens 型：√ → √() 光标在括号内', () => {
  const r = insertSymbol('x = ', 4, 4, findSymbol('√'));
  assert.equal(r.text, 'x = √()');
  assert.equal(r.text.slice(r.caret), ')');
});

t('end 型但 insert 自带开括号：∛( 会补闭括号', () => {
  const r = insertSymbol('', 0, 0, findSymbol('∛'));
  assert.equal(r.text, '∛()');
  assert.equal(r.caret, 2);
});

t('下标型：xₙ 插入 Unicode 下标（非 _）', () => {
  const r = insertSymbol('', 0, 0, findSymbol('xₙ'));
  assert.equal(r.text, 'ₙ');
  assert.equal(r.caret, 1);
});

t('subscript 型：xⁿ 插入 ^ 光标在其后', () => {
  const r = insertSymbol('', 0, 0, findSymbol('xⁿ'));
  assert.equal(r.text, '^');
  assert.equal(r.caret, 1);
});

// ---------- 插入：选区替换 ----------

t('有选区：替换选区内容', () => {
  const r = insertSymbol('x = abcd', 4, 8, findSymbol('θ'));
  assert.equal(r.text, 'x = θ');
  assert.equal(r.caret, 5);
});

t('有选区 + parens：选区被替换成函数调用', () => {
  const r = insertSymbol('sin x', 4, 5, findSymbol('sin'));
  assert.equal(r.text, 'sin sin()');
  assert.equal(r.text.slice(r.caret), ')');
});

// ---------- 边界：越界索引不崩 ----------

t('越界 selStart 被钳制', () => {
  const r = insertSymbol('abc', 999, 999, findSymbol('θ'));
  assert.equal(r.text, 'abcθ');
});

t('负数 selStart 被钳制', () => {
  const r = insertSymbol('abc', -5, -5, findSymbol('θ'));
  assert.equal(r.text, 'θabc');
});

t('selEnd < selStart 时不产生负长度切片', () => {
  const r = insertSymbol('abcd', 3, 1, findSymbol('θ'));
  assert.equal(r.text, 'abcθd');
});

// ---------- 关键：插入的符号能被现有链路无损处理 ----------

t('插入的符号是合法速记（不破坏标记解析）', () => {
  const lines = parseShorthand('= ∫_0^x sin(θ) dθ');
  assert.equal(lines[0].kind, 'formula');
  assert.equal(textsOfKind(lines, 'formula')[0], '∫_0^x sin(θ) dθ');
});

t('模拟边栏插入一整条公式后仍解析为公式行', () => {
  let text = '= ';
  let caret = text.length;
  for (const label of ['∫', 'sin', 'θ']) {
    const r = insertSymbol(text, caret, caret, findSymbol(label));
    text = r.text;
    caret = r.caret;
  }
  assert.ok(text.startsWith('= ∫'), text);
  assert.equal(parseShorthand(text)[0].kind, 'formula');
});

t('符号往返落盘无损（∫ √ θ ℏ ω 等）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sym-'));
  try {
    const store = new LectureStore({ rootDir: tmp });
    store.ensureCourse('c', 'C');
    const unit = { id: 'u01', date: '2026-10-10', title: 'T', file: '2026-10-10-u01.md', reviewed: false, has_summary: false };
    store.upsertUnit('c', unit);
    const raw = '= ∫_0^x √(θ) dθ\n= ℏ²/2m\n= ω × r\n= ∑_i x_i\n= ∏_k a_k\n= ⟨ψ|Ĥ|ψ⟩';
    store.writeUnitMarkdown('c', unit,
      { course: 'C', unit: 'T', date: '2026-10-10', semester: '', module: '' },
      [{ seq: 0, raw, my_understanding: '理解', my_question: '疑问', created_at: 0 }]);
    const back = parseUnitMarkdown(store.readUnitMarkdown('c', unit)).chunks[0].raw;
    for (const sym of ['∫', '√', 'θ', 'ℏ', '²', 'ω', '×', '∑', '∏', '⟨', 'ψ', '⟩']) {
      assert.ok(back.includes(sym), `往返丢失符号: ${sym}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

t('insertedAlphabet 返回去重字符集', () => {
  const alpha = insertedAlphabet();
  assert.ok(alpha.length > 50, `字符集偏小: ${alpha.length}`);
  assert.equal(new Set(alpha).size, alpha.length, '含重复字符');
});

// ---------- 模板渲染 ----------

t('renderTemplate：单插槽', () => {
  const { rendered, slots } = renderTemplate('lim_{$1} ', 0);
  assert.equal(rendered, 'lim_{} ');
  assert.deepEqual(slots, [5]);
});

t('renderTemplate：双插槽位置正确', () => {
  const { rendered, slots } = renderTemplate('∑_{$1}^{$2} ', 0);
  assert.equal(rendered, '∑_{}^{} ');
  assert.deepEqual(slots, [3, 6]);
});

t('renderTemplate：带偏移量（行中插入）', () => {
  const { rendered, slots } = renderTemplate('∫_{$1}^{$2} ', 10);
  assert.equal(rendered, '∫_{}^{} ');
  assert.deepEqual(slots, [13, 16]);
});

t('renderTemplate：prefix 影响插槽位', () => {
  const { slots } = renderTemplate('∑_{$1} ', 4, 1);
  assert.deepEqual(slots, [8]);
});

t('renderTemplate：四插槽（矩阵）', () => {
  const { rendered, slots } = renderTemplate('[$1 $2; $3 $4]', 0);
  assert.equal(rendered, '[ ;  ]');
  assert.equal(slots.length, 4);
  assert.deepEqual(slots, [1, 2, 4, 5]);
});

t('insertSymbol 用 template：∑ 插入后光标在第一个插槽', () => {
  const r = insertSymbol('= ', 2, 2, findSymbol('∑ 上下限'));
  assert.equal(r.text, '= ∑_{}^{} ');
  assert.equal(r.slots.length, 2);
  assert.equal(r.caret, r.slots[0]);
  assert.equal(r.activeSlot, 1);
  assert.equal(r.text[r.caret - 1], '{');
});

t('insertSymbol 用 template：lim 单插槽', () => {
  const r = insertSymbol('', 0, 0, findSymbol('lim'));
  assert.equal(r.text, 'lim_{} ');
  assert.equal(r.slots.length, 1);
  assert.equal(r.caret, 5);
  assert.equal(r.text[r.caret - 1], '{');
});

t('insertSymbol 用 template：∀x∈A', () => {
  const r = insertSymbol('', 0, 0, findSymbol('∀ 任意'));
  assert.equal(r.text, '∀∈: ');
  assert.equal(r.slots.length, 2);
  assert.equal(r.caret, 1);
  assert.equal(r.slots[1], 2);
});

t('insertSymbol 用 template：∏ 上下限', () => {
  const r = insertSymbol('', 0, 0, findSymbol('∏ 上下限'));
  assert.equal(r.text, '∏_{}^{} ');
  assert.equal(r.slots.length, 2);
});

t('template 与 autoSpace 共存', () => {
  const r = insertSymbol('x', 1, 1, findSymbol('∑ 上下限'), { autoSpace: true });
  assert.equal(r.text, 'x ∑_{}^{} ');
  assert.equal(r.caret, r.slots[0]);
});

t('template 替换选区', () => {
  const r = insertSymbol('= old', 2, 5, findSymbol('lim'));
  assert.equal(r.text, '= lim_{} ');
  assert.equal(r.slots.length, 1);
});

// ---------- Tab 跳转 ----------

t('nextSlot：1 → 2', () => {
  const r = insertSymbol('', 0, 0, findSymbol('∑ 上下限'));
  assert.equal(nextSlot(r.slots, 1), r.slots[1]);
});

t('nextSlot：最后一个 → null（前端应放行 Tab）', () => {
  const r = insertSymbol('', 0, 0, findSymbol('∑ 上下限'));
  assert.equal(nextSlot(r.slots, 2), null);
});

t('nextSlot：无插槽 → null', () => {
  assert.equal(nextSlot([], 1), null);
});

t('nextSlot：四插槽依次推进', () => {
  const r = insertSymbol('', 0, 0, findSymbol('矩阵 2×2'));
  assert.equal(r.slots.length, 4);
  assert.equal(nextSlot(r.slots, 1), r.slots[1]);
  assert.equal(nextSlot(r.slots, 2), r.slots[2]);
  assert.equal(nextSlot(r.slots, 3), r.slots[3]);
  assert.equal(nextSlot(r.slots, 4), null);
});

t('shiftSlots：插槽内输入后，后续插槽右移', () => {
  const { slots } = renderTemplate('∑_{$1}^{$2} ', 0);
  const shifted = shiftSlots(slots, 3, 3);
  assert.equal(shifted[0], 6);
  assert.equal(shifted[1], 9);
});

t('shiftSlots：输入位置之前的插槽不动', () => {
  assert.deepEqual(shiftSlots([10, 20], 30, 5), [10, 20]);
  assert.deepEqual(shiftSlots([10, 20], 0, 5), [15, 25]);
});

t('完整还原一次 ∑ 输入流程', () => {
  const r = insertSymbol('', 0, 0, findSymbol('∑ 上下限'));
  let text = r.text;
  assert.equal(text, '∑_{}^{} ');
  const s1 = r.slots[0];
  text = text.slice(0, s1) + 'i=1' + text.slice(s1);
  const slots = shiftSlots(r.slots, s1, 3);
  const s2 = nextSlot(slots, 1);
  text = text.slice(0, s2) + 'n' + text.slice(s2);
  assert.equal(text, '∑_{i=1}^{n} ');
  const lines = parseShorthand('= ' + text + 'x_i');
  assert.equal(lines[0].kind, 'formula');
  assert.match(textsOfKind(lines, 'formula')[0], /∑_\{i=1\}\^\{n\}/);
});

t('完整还原一次 ∏ 输入流程', () => {
  const r = insertSymbol('', 0, 0, findSymbol('∏ 上下限'));
  let text = r.text;
  const s1 = r.slots[0];
  text = text.slice(0, s1) + 'k=1' + text.slice(s1);
  const slots = shiftSlots(r.slots, s1, 3);
  const s2 = nextSlot(slots, 1);
  text = text.slice(0, s2) + 'n' + text.slice(s2);
  assert.equal(text, '∏_{k=1}^{n} ');
});

t('完整还原一次 bra-ket 输入流程', () => {
  const r = insertSymbol('', 0, 0, findSymbol('⟨φ|ψ⟩ 内积'));
  let text = r.text;
  assert.equal(text, '⟨|⟩ ');
  const s1 = r.slots[0];
  text = text.slice(0, s1) + 'φ' + text.slice(s1);
  const slots = shiftSlots(r.slots, s1, 1);
  const s2 = nextSlot(slots, 1);
  text = text.slice(0, s2) + 'ψ' + text.slice(s2);
  assert.equal(text, '⟨φ|ψ⟩ ');
});

console.log(`\n[check5.mjs] ${passed} 项断言通过`);
