// 一次性测量脚本（不入库）：用真实记忆数据量化 claim 规则抽取的触发率
import { readFileSync } from 'node:fs';
import { extractClaims } from '../lib/gatekeeper.js';
import { canonicalAttr } from '../lib/attributes.js';

const raw = JSON.parse(readFileSync(new URL('../../../../.dsh-home/storages/aemeath_memory.json', import.meta.url), 'utf-8'));
const memories = Object.values(raw.tables.memories ?? {});
console.log(`真实记忆条数: ${memories.length}`);

const byCategory = {};
let withClaims = 0;
const attrTally = {};
const misses = [];
let totalClaims = 0;

for (const rec of memories) {
  const cat = rec.category ?? '?';
  byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  const claims = extractClaims(rec.content ?? '', '用户');
  if (claims.length) {
    withClaims++;
    totalClaims += claims.length;
    for (const c of claims) {
      const a = canonicalAttr(c.attribute);
      attrTally[a] = (attrTally[a] ?? 0) + 1;
    }
  } else {
    misses.push({ cat, content: (rec.content ?? '').slice(0, 60) });
  }
}

const pct = (n) => `${((n / memories.length) * 100).toFixed(1)}%`;
console.log(`规则层抽到 claim 的记忆: ${withClaims}/${memories.length} = ${pct(withClaims)}`);
console.log(`抽出的 claim 总数: ${totalClaims}（平均 ${(totalClaims / memories.length).toFixed(2)} 条/记忆）`);
console.log(`按 category 分布: ${JSON.stringify(byCategory)}`);
console.log(`命中属性分布: ${JSON.stringify(attrTally)}`);
console.log(`\n—— 未命中（这些就是 LLM 层要补的候选）——`);
for (const m of misses) console.log(`  [${m.cat}] ${m.content}`);

// 额外：把未命中的按"是否含第一人称事实信号"粗分，估计 LLM 层潜在收益
const personaLikely = misses.filter((m) => /我|我的|本人/.test(m.content) && m.cat !== 'session_summary');
console.log(`\n未命中里"第一人称 + 非会话摘要"（LLM 层最可能有收益）: ${personaLikely.length}/${misses.length}`);
for (const m of personaLikely) console.log(`  [${m.cat}] ${m.content}`);

// ——— 抽取源对比：content only / content+query / query only ———
let hitContent = 0;
let hitBoth = 0;
let hitQueryOnly = 0;
for (const rec of memories) {
  const c = extractClaims(rec.content ?? '', '用户').length;
  const q = extractClaims(rec.query ?? '', '用户').length;
  if (c) hitContent++;
  if (c || q) hitBoth++;
  if (!c && q) hitQueryOnly++;
}
console.log(`\n—— 抽取源对比（${memories.length} 条）——`);
console.log(`只从 content 抽到: ${hitContent} (${pct(hitContent)})`);
console.log(`content 或 query 任一抽到（现管线口径）: ${hitBoth} (${pct(hitBoth)})`);
console.log(`仅 query 能补上的: +${hitQueryOnly}（${hitQueryOnly ? '值得合并两个来源' : '无增益'}）`);

// ——— 数据质量：前导标点 / 命令词残留（影响 claim 抽取与可读性） ———
const leadPunct = memories.filter((r) => /^[，,、。；;：:\s]/.test(r.content ?? ''));
const cmdLeftover = memories.filter((r) => /^(记住|记一下|记下来|记着)/.test(r.content ?? ''));
console.log(`\n—— 数据质量 ——`);
console.log(`内容前导标点（提取层没剥净）: ${leadPunct.length}/${memories.length}`);
console.log(`内容里残留命令词（"记住…"）: ${cmdLeftover.length}/${memories.length}`);

// ——— 审计：写入侧事件频率（冲突/去重/闭合） ———
const audits = Object.values(raw.tables.audit ?? {});
const byAction = {};
for (const a of audits) byAction[a.action] = (byAction[a.action] ?? 0) + 1;
console.log(`\n—— 审计动作分布（共 ${audits.length} 条）——`);
console.log(JSON.stringify(byAction, null, 1));
const knowledge = Object.values(raw.tables.knowledge ?? {});
const kb = {};
for (const k of knowledge) kb[k.status] = (kb[k.status] ?? 0) + 1;
console.log(`知识层: ${knowledge.length} 条 ${JSON.stringify(kb)}`);

