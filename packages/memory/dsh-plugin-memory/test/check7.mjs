// ============================================================
// T4 属性归一化 + T1 事实时间轴 + T2 演进≠矛盾 + T6 LLM 抢救解析
// 纯函数单测（借 ripples-of-aion 思想，只借算法不抄代码）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// 注：全部零网络、零 IO。
// ============================================================
import assert from 'node:assert/strict';
import { canonicalAttr, CANONICAL_ATTRS, ATTR_ALIASES, isKnownAttr } from '../lib/attributes.js';
import {
  hasActiveClaim,
  findClosableClaims,
  closeClaims,
  activeClaimOf,
  timelineOf,
  hasClosedTimelineOverlap,
  prepareClaims,
  normEntity,
  isActiveClaim,
} from '../lib/timeline.js';
import { parseLlmJson, toIndex } from '../lib/insights.js';
import { extractClaims, hasNewClaimValue } from '../lib/gatekeeper.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ——————————————————————————————————————————————
// T4 · canonicalAttr 归一化
// ——————————————————————————————————————————————
t('canonicalAttr：非 string → 空串（null / undefined / number / 对象）', () => {
  assert.equal(canonicalAttr(null), '');
  assert.equal(canonicalAttr(undefined), '');
  assert.equal(canonicalAttr(42), '');
  assert.equal(canonicalAttr({}), '');
});

t('canonicalAttr：全角 ASCII → 半角（ＡＢＣ → ABC）', () => {
  assert.equal(canonicalAttr('ＡＢＣ'), 'ABC');
  assert.equal(canonicalAttr('ｍａｊｏｒ'), '专业'); // 全角经半角后命中别名 major
});

t('canonicalAttr：trim + 去掉全部内部空白 + 全角空格', () => {
  assert.equal(canonicalAttr('  工作 地点  '), '所在地'); // 去空白后命中别名
  assert.equal(canonicalAttr('工\u3000作\u3000地点'), '所在地'); // U+3000 全角空格
  assert.equal(canonicalAttr('学 习 目 标'), '学习目标');
});

t('canonicalAttr：别名收敛（工作所在地 / 工作地点 → 同一规范属性）', () => {
  assert.equal(canonicalAttr('工作所在地'), canonicalAttr('工作地点'));
  assert.equal(canonicalAttr('居住地'), '所在地');
  assert.equal(canonicalAttr('Klausur'), '考试');
  assert.equal(canonicalAttr('大学'), '学校');
  assert.equal(canonicalAttr('昵称'), '称呼');
});

t('canonicalAttr：未登记的属性原样保留（不误收敛）', () => {
  assert.equal(canonicalAttr('某个自定义字段'), '某个自定义字段');
  assert.equal(canonicalAttr('量子场论'), '量子场论');
});

t('canonicalAttr：别名表键必须已去空白（不变量，防止查不中）', () => {
  for (const key of ATTR_ALIASES.keys()) {
    assert.equal(key.trim(), key, `别名键「${key}」含首尾空白`);
    assert.equal(/\s/.test(key), false, `别名键「${key}」含内部空白`);
  }
});

t('canonicalAttr：别名与规范词表自洽（每个值都在词表内）', () => {
  for (const [alias, canon] of ATTR_ALIASES) {
    assert.ok(CANONICAL_ATTRS.includes(canon), `别名「${alias}」指向未登记属性「${canon}」`);
  }
});

t('isKnownAttr：规范/别名判定，未知属性为 false', () => {
  assert.equal(isKnownAttr('工作所在地'), true);
  assert.equal(isKnownAttr('量子场论'), false);
});

// ——————————————————————————————————————————————
// T1 · 事实时间轴
// ——————————————————————————————————————————————
const claim = (entity, attribute, value, valid_from = 1000, valid_until = null) => ({ entity, attribute, value, valid_from, valid_until });

t('isActiveClaim：valid_until === null 才算活跃', () => {
  assert.equal(isActiveClaim(claim('用户', '所在地', '北京')), true);
  assert.equal(isActiveClaim(claim('用户', '所在地', '北京', 1000, 2000)), false);
  assert.equal(isActiveClaim(null), false);
});

t('hasActiveClaim：同三元组（含属性别名归一）→ true；值不同 → false', () => {
  const claims = [claim('用户', '所在地', '北京')];
  assert.equal(hasActiveClaim(claims, '用户', '居住地', '北京'), true); // 别名判同
  assert.equal(hasActiveClaim(claims, '用户', '所在地', '上海'), false);
  assert.equal(hasActiveClaim(claims, '别人', '所在地', '北京'), false);
});

t('hasActiveClaim：已闭合的断言不算活跃（重述可再写入）', () => {
  const claims = [claim('用户', '所在地', '北京', 1000, 2000)];
  assert.equal(hasActiveClaim(claims, '用户', '所在地', '北京'), false);
});

t('findClosableClaims：同 (entity, attr) 不同 value → 命中旧下标', () => {
  const existing = [
    { id: 'old1', entity_claims: [claim('用户', '所在地', '北京', 1000)] },
    { id: 'other', entity_claims: [claim('用户', '专业', '物理', 1000)] },
  ];
  const targets = findClosableClaims(existing, [claim('用户', '居住地', '上海', 5000)], 'new1');
  assert.deepEqual(targets, [{ recordId: 'old1', indexes: [0] }]);
});

t('findClosableClaims：已闭合 → 不重复命中（幂等）', () => {
  const existing = [{ id: 'old1', entity_claims: [claim('用户', '所在地', '北京', 1000, 2000)] }];
  assert.deepEqual(findClosableClaims(existing, [claim('用户', '所在地', '上海', 5000)], 'new1'), []);
});

t('findClosableClaims：selfId 自身跳过 / deleted 记录跳过 / 无 claim 跳过', () => {
  const dead = { id: 'dead', entity_claims: [claim('用户', '所在地', '北京', 1000)], deleted: true };
  const noclaims = { id: 'noclaims' };
  const newClaim = claim('用户', '所在地', '上海', 5000);
  // selfId = 'self' 时：自身跳过、dead 跳过、noclaims 跳过 → 无目标
  assert.deepEqual(findClosableClaims([{ id: 'self', entity_claims: [claim('用户', '所在地', '北京', 1000)] }, dead, noclaims], [newClaim], 'self'), []);
  // 换一个 selfId：只有这唯一一条真正的活跃旧断言会命中
  assert.deepEqual(findClosableClaims([{ id: 'self', entity_claims: [claim('用户', '所在地', '北京', 1000)] }, dead, noclaims], [newClaim], 'new1'), [
    { recordId: 'self', indexes: [0] },
  ]);
});

t('findClosableClaims：一条记录多条同键断言 → 下标全收且升序', () => {
  const existing = [{ id: 'old1', entity_claims: [claim('用户', '所在地', '北京', 1000), claim('用户', '居住地', '上海', 1500)] }];
  const targets = findClosableClaims(existing, [claim('用户', '所在地', '广州', 5000)], 'new1');
  assert.deepEqual(targets, [{ recordId: 'old1', indexes: [0, 1] }]);
});

t('closeClaims：只改目标下标、valid_until = at、不修改入参（常量性）', () => {
  const src = [claim('用户', '所在地', '北京', 1000), claim('用户', '专业', '物理', 1200), claim('用户', '年级', '大一', 1300)];
  const frozen = JSON.stringify(src);
  const out = closeClaims(src, [0, 2], 9999);
  assert.equal(out[0].valid_until, 9999);
  assert.equal(out[1].valid_until, null); // 未命中不动
  assert.equal(out[2].valid_until, 9999);
  assert.equal(JSON.stringify(src), frozen); // 入参未被改写
  assert.notEqual(out[0], src[0]);
});

t('closeClaims：已闭合的断言原样保留（不覆盖既有 valid_until）', () => {
  const src = [claim('用户', '所在地', '北京', 1000, 2000)];
  const out = closeClaims(src, [0], 9999);
  assert.equal(out[0].valid_until, 2000);
});

t('activeClaimOf：多条活跃取 valid_from 最大者；全闭合 → undefined', () => {
  const claims = [claim('用户', '所在地', '北京', 1000), claim('用户', '居住地', '上海', 5000), claim('用户', '所在地', '广州', 3000)];
  assert.equal(activeClaimOf(claims, '用户', '所在地')?.value, '上海');
  assert.equal(activeClaimOf(claims, '用户', '专业'), undefined);
  const allClosed = claims.map((c) => ({ ...c, valid_until: 9999 }));
  assert.equal(activeClaimOf(allClosed, '用户', '所在地'), undefined);
});

t('timelineOf：按 valid_from 升序，能回答「当时是什么」', () => {
  const claims = [claim('用户', '所在地', '上海', 5000), claim('用户', '所在地', '北京', 1000, 5000)];
  const tl = timelineOf(claims, '用户', '居住地');
  assert.deepEqual(tl.map((c) => c.value), ['北京', '上海']);
  assert.equal(tl[0].valid_until, 5000); // 北京在 5000 失效
  assert.equal(tl[1].valid_until, null); // 上海至今有效
});

t('prepareClaims：完全相同重述被丢弃、同批 valid_from 错峰（防零长区间）', () => {
  const existing = [claim('用户', '所在地', '北京', 1000)];
  const out = prepareClaims(
    [
      claim('用户', '所在地', '北京', 5000), // 重述 → 丢
      claim('用户', '所在地', '上海', 5000), // 新值 → 留
      claim('用户', '专业', '物理', 5000), // 新键 → 留
      claim('用户', '', '空属性', 5000), // 非法 → 丢
    ],
    existing,
    5000,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.value), ['上海', '物理']);
  assert.notEqual(out[0].valid_from, out[1].valid_from); // 错峰：不共享同一毫秒
  assert.deepEqual(out.map((c) => c.valid_until), [null, null]);
});

t('prepareClaims：同批重复三元组只留一条', () => {
  const out = prepareClaims([claim('用户', '所在地', '上海', 5000), claim('用户', '居住地', '上海', 5000)], [], 5000);
  assert.equal(out.length, 1);
});

t('normEntity：去空白/截断；非 string → 空串', () => {
  assert.equal(normEntity('  用 户  '), '用户');
  assert.equal(normEntity(null), '');
});

// ——————————————————————————————————————————————
// T2 · 演进 ≠ 矛盾
// ——————————————————————————————————————————————
t('hasClosedTimelineOverlap：共同键 + 任一侧已闭合 → true（演进）', () => {
  const a = [claim('用户', '所在地', '北京', 1000, 5000)]; // 已闭合
  const b = [claim('用户', '所在地', '上海', 5000)];
  assert.equal(hasClosedTimelineOverlap(a, b), true);
});

t('hasClosedTimelineOverlap：共同键但都未闭合 → false（真矛盾候选）', () => {
  const a = [claim('用户', '结论', '用A法', 1000)];
  const b = [claim('用户', '结论', '用B法', 2000)];
  assert.equal(hasClosedTimelineOverlap(a, b), false);
});

t('hasClosedTimelineOverlap：无共同键 → false；空输入 → false', () => {
  assert.equal(hasClosedTimelineOverlap([claim('用户', '所在地', '北京', 1000, 5000)], [claim('用户', '专业', '物理', 2000)]), false);
  assert.equal(hasClosedTimelineOverlap([], []), false);
  assert.equal(hasClosedTimelineOverlap(undefined, undefined), false);
});

t('hasClosedTimelineOverlap：属性别名判同（工作所在地 vs 工作地点）', () => {
  const a = [claim('用户', '工作所在地', '汉堡', 1000, 5000)];
  const b = [claim('用户', '工作地点', '柏林', 5000)];
  assert.equal(hasClosedTimelineOverlap(a, b), true);
});

t('真实场景回归：去年住北京 / 今年搬到上海 → 演进（不再报矛盾）', () => {
  const oldRec = [claim('用户', '所在地', '北京', 1000, 5000)];
  const newRec = [claim('用户', '所在地', '上海', 5000)];
  assert.equal(hasClosedTimelineOverlap(oldRec, newRec), true);
});

t('hasNewClaimValue：同属性值变化 → true；值相同/键不同/已闭合 → false', () => {
  const oldClaims = [claim('用户', '所在地', '北京', 1000)];
  assert.equal(hasNewClaimValue(oldClaims, extractClaims('我搬到上海', '用户')), true);
  assert.equal(hasNewClaimValue(oldClaims, [{ entity: '用户', attribute: '所在地', value: '北京' }]), false);
  assert.equal(hasNewClaimValue(oldClaims, [{ entity: '用户', attribute: '专业', value: '物理' }]), false);
  assert.equal(hasNewClaimValue([{ ...oldClaims[0], valid_until: 2000 }], [{ entity: '用户', attribute: '所在地', value: '上海' }]), false);
});

// ——————————————————————————————————————————————
// T6 · LLM 输出抢救解析
// ——————————————————————————————————————————————
t('parseLlmJson：裸 JSON 对象/数组', () => {
  assert.deepEqual(parseLlmJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseLlmJson('[1,2]'), [1, 2]);
});

t('parseLlmJson：```json 围栏剥离', () => {
  assert.deepEqual(parseLlmJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLlmJson('```\n{"a":2}\n```'), { a: 2 });
});

t('parseLlmJson：前后有噪声文字 → 取首个 {} / 首个 []', () => {
  assert.deepEqual(parseLlmJson('好的，结果如下：{"a":1} 完毕'), { a: 1 });
  assert.deepEqual(parseLlmJson('结果列出：\n[1,2,3]\n以上'), [1, 2, 3]);
});

t('parseLlmJson：完全非法 / 空 → null', () => {
  assert.equal(parseLlmJson('这不是 JSON'), null);
  assert.equal(parseLlmJson(''), null);
  assert.equal(parseLlmJson(null), null);
  assert.equal(parseLlmJson('{坏掉的'), null);
});

t('toIndex：合法整数通过，其余一律 null（LLM 无法凭空造 id）', () => {
  assert.equal(toIndex(1, 3), 1);
  assert.equal(toIndex(0, 3), 0);
  assert.equal(toIndex(-1, 3), null);
  assert.equal(toIndex(1.5, 3), null);
  assert.equal(toIndex('1', 3), null);
  assert.equal(toIndex(3, 3), null);
  assert.equal(toIndex(NaN, 3), null);
});

// ——————————————————————————————————————————————
// T1 的 claim 来源：规则层轻量抽取
// ——————————————————————————————————————————————
t('extractClaims：住址变化两轮各抽一条（时间轴的输入）', () => {
  const a = extractClaims('我住在北京', '用户');
  assert.deepEqual(a, [{ entity: '用户', attribute: '所在地', value: '北京' }]);
  const b = extractClaims('我搬到上海了', '用户');
  assert.deepEqual(b, [{ entity: '用户', attribute: '所在地', value: '上海' }]);
});

t('extractClaims：姓名 / 年级 / 专业 / 偏好', () => {
  assert.deepEqual(extractClaims('我叫林澈', '用户'), [{ entity: '用户', attribute: '姓名', value: '林澈' }]);
  assert.deepEqual(extractClaims('我是大二学生', '用户'), [{ entity: '用户', attribute: '年级', value: '大二' }]);
  assert.deepEqual(extractClaims('我学的是物理', '用户')[0].value, '物理');
  assert.deepEqual(extractClaims('我最喜欢量子力学', '用户'), [{ entity: '用户', attribute: '偏好', value: '量子力学' }]);
});

t('extractClaims：抽不到 → 空数组（不硬凑）', () => {
  assert.deepEqual(extractClaims('今天天气不错', '用户'), []);
  assert.deepEqual(extractClaims('', '用户'), []);
  assert.deepEqual(extractClaims('我叫林澈', ''), []);
});

t('extractClaims：单条上限 8 条', () => {
  const many = extractClaims('我叫林澈，我是大二学生，我学的是物理，我住在北京，我最喜欢量子力学，我的目标是考过 PHY-E1，我的薄弱环节是积分，我的邮箱是 a@b.de', '用户');
  assert.ok(many.length <= 8);
  assert.ok(many.length >= 4);
});

console.log(`\n[memory-timeline] ${passed} 项断言全部通过`);
