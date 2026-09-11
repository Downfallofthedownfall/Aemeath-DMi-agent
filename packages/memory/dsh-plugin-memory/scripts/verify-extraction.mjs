// 一次性验证脚本（不入库）：检查修复后的抽取结果 + 旧数据回放
import { readFileSync } from 'node:fs';
import { extractClaims, extractMemory } from '../lib/gatekeeper.js';

console.log('—— extractMemory 清洗 ——');
for (const q of [
  '记住，我住在北京',
  '记一下我的10月第一星期课程表',
  '，我下周三有物理考试，我有点紧张。',
  '以后叫我小星就好',
  '记住，记住，我叫林澈',
  ' 我的名字是 林澈 。',
]) {
  console.log(`  ${JSON.stringify(q)} → ${JSON.stringify(extractMemory(q))}`);
}

console.log('\n—— extractClaims 新增/修正模式 ——');
for (const t of [
  '我下周三有物理考试，我有点紧张。',
  '我周三的物理考试考完了，感觉还不错',
  '我这学期选了热力学和光学两门课',
  '我选修了量子力学',
  '我在复习物理课',
  '我住在北京',
  '我搬到上海了',
  '我的考试在二月',
]) {
  const c = extractClaims(t, '用户');
  console.log(`  ${JSON.stringify(t)} → ${c.length ? JSON.stringify(c.map((x) => `${x.attribute}=${x.value}`)) : '（无）'}`);
}

console.log('\n—— 真实记忆回放（修复后触发率）——');
const raw = JSON.parse(readFileSync(new URL('../../../../.dsh-home/storages/aemeath_memory.json', import.meta.url), 'utf-8'));
const memories = Object.values(raw.tables.memories ?? {});
let hit = 0;
let fromCleaned = 0;
for (const rec of memories) {
  const content = extractMemory(rec.content ?? '');
  const direct = extractClaims(rec.content ?? '', '用户');
  const cleaned = extractClaims(content, '用户');
  if (cleaned.length) hit++;
  if (!direct.length && cleaned.length) fromCleaned++;
  if (cleaned.length) console.log(`  ✓ [${rec.category}] ${JSON.stringify(content.slice(0, 40))} → ${cleaned.map((c) => `${c.attribute}=${c.value}`).join(', ')}`);
}
console.log(`\n触发率: ${hit}/${memories.length} = ${((hit / memories.length) * 100).toFixed(1)}%（修复前 5/24 = 20.8%）`);
console.log(`其中靠 extractMemory 清洗才抽到的: +${fromCleaned}`);
