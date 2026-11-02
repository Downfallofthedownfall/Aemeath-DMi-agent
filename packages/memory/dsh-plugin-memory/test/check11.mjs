// ============================================================
// 每轮 (用户输入, 最终输出) 配对单测（turns.ts）
// 运行：npm test -w @aemeath/dsh-plugin-memory
// 背景：dsh 每个模型 step 发一条 assistant/message。旧实现拿第一条就配对，
//   用了工具的一轮里进 L1 的是 step 0 的"我先验算一下…"过程话，最终回答被丢掉。
// ============================================================
import assert from 'node:assert/strict';
import { TurnCollector, finalReplyText, TURN_BUFFER_MAX } from '../lib/turns.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const text = (s) => ({ type: 'text', text: s });
const reasoning = (s) => ({ type: 'reasoning', text: s });
const toolCall = (name) => ({ type: 'tool-call', id: `call-${name}`, name, input: {} });

t('finalReplyText：带 tool-call 的消息是中间步骤 → null', () => {
  assert.equal(finalReplyText([text('我先用 compute_verify 验算一下'), toolCall('compute_verify')]), null);
  assert.equal(finalReplyText([toolCall('plan_step')]), null);
});

t('finalReplyText：只收 text 块，reasoning 不算正文', () => {
  assert.equal(finalReplyText([reasoning('用户问的是…我应该…'), text('答案是 21。')]), '答案是 21。');
});

t('finalReplyText：剥掉内联 <think>…</think>（含未闭合的尾段）', () => {
  assert.equal(finalReplyText([text('<think>先想想单位</think>\n结果是 9.8 m/s²')]), '结果是 9.8 m/s²');
  assert.equal(finalReplyText([text('结论：守恒。<THINK>还没想完')]), '结论：守恒。');
});

t('工具轮：L1 拿到的是最终回答，不是工具前的过程话', () => {
  const c = new TurnCollector();
  c.userMessage('s1', '一个 2kg 的物体从 5m 落下，落地速度多少？', 'physicist', 100);
  c.assistantMessage('s1', [reasoning('需要用能量守恒'), text('我先列式，再用 SymPy 验算。'), toolCall('compute_verify')]);
  c.assistantMessage('s1', [text('落地速度约 9.9 m/s（√(2gh)，已验算 ✅）')]);
  const turn = c.turnEnd('s1');
  assert.deepEqual(turn, { query: '一个 2kg 的物体从 5m 落下，落地速度多少？', reply: '落地速度约 9.9 m/s（√(2gh)，已验算 ✅）', preset: 'physicist', ts: 100 });
  assert.equal(c.turnEnd('s1'), undefined, '交出后该会话没有未结轮次');
});

t('多个无工具 step（如 OOC 拦截后重写）→ 取最后一条', () => {
  const c = new TurnCollector();
  c.userMessage('s1', '你是谁', 'aemeath', 1);
  c.assistantMessage('s1', [text('我是一个 AI 语言模型。')]);
  c.assistantMessage('s1', [text('我是爱弥斯呀～')]);
  assert.equal(c.turnEnd('s1').reply, '我是爱弥斯呀～');
});

t('turn/end 前没有最终输出（失败 / 停在工具步骤上）→ reply 为空串，用户输入不丢', () => {
  const c = new TurnCollector();
  c.userMessage('s1', '我下周三考 Physik 1', 'physicist', 1);
  c.assistantMessage('s1', [text('让我查一下课程表'), toolCall('curriculum_query')]);
  const turn = c.turnEnd('s1');
  assert.equal(turn.query, '我下周三考 Physik 1');
  assert.equal(turn.reply, '');
});

t('没开轮的 assistant/message / turn/end 被忽略；空用户输入不开轮', () => {
  const c = new TurnCollector();
  c.assistantMessage('s1', [text('孤儿回复')]);
  assert.equal(c.turnEnd('s1'), undefined);
  c.userMessage('s1', '   ', 'aemeath', 1);
  assert.equal(c.size, 0);
});

t('会话互不串：各自配对；drop 丢弃未结轮次', () => {
  const c = new TurnCollector();
  c.userMessage('a', 'A 问', 'aemeath', 1);
  c.userMessage('b', 'B 问', 'physicist', 2);
  c.assistantMessage('b', [text('B 答')]);
  c.assistantMessage('a', [text('A 答')]);
  c.drop('b');
  assert.equal(c.turnEnd('a').reply, 'A 答');
  assert.equal(c.turnEnd('b'), undefined);
});

t('未结轮次有上限：超出淘汰最旧，刚活跃的会话保留', () => {
  const c = new TurnCollector(3);
  c.userMessage('s1', 'q1', 'p', 1);
  c.userMessage('s2', 'q2', 'p', 2);
  c.userMessage('s3', 'q3', 'p', 3);
  c.userMessage('s1', 'q1 again', 'p', 4); // s1 重新开轮 → 移到最新
  c.userMessage('s4', 'q4', 'p', 5);
  assert.equal(c.size, 3);
  assert.equal(c.turnEnd('s2'), undefined, '最旧的 s2 被淘汰');
  assert.equal(c.turnEnd('s1').query, 'q1 again');
  assert.equal(TURN_BUFFER_MAX, 200);
});

console.log(`\n[memory-turns] ${passed} 项断言全部通过`);
