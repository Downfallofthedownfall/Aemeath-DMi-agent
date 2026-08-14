// ============================================================
// route.ts — 解题分流（纯函数，可单测）
// plan（解题工作流）：含解题触发词 或 长问题（>80 字）
// direct（日常对话）：其余
// ============================================================

/** 解题触发词（中文 + 英文/德文）。 */
const PLAN_TRIGGERS = /解|推导|证明|计算|分析|求解|求导|积分|求极限|应用题|证明题|怎么算|怎么解|berechnen|ableiten|integrieren|lösen|beweisen|compute|derive|integrate|prove|solve/i;

/** 长问题阈值（字符）。 */
export const LONG_QUERY_LENGTH = 80;

export interface RouteResult {
  kind: 'plan' | 'direct';
  reason: string;
}

/** 分流：返回 plan（走解题工作流）或 direct（日常）。 */
export function routeQuery(query: string): RouteResult {
  const q = (query || '').trim();
  if (!q) return { kind: 'direct', reason: '空输入' };
  if (q.length > LONG_QUERY_LENGTH) return { kind: 'plan', reason: '长问题（>80 字）' };
  if (PLAN_TRIGGERS.test(q)) return { kind: 'plan', reason: '解题触发词' };
  return { kind: 'direct', reason: '日常对话' };
}

/** 解题规范提示（soul 格式）：注入到 plan 模式的 pre-step。 */
export const SOLVER_PROMPT = `【解题工作流】这是一个需要推导/计算的问题。请严格按以下规范作答：
1. 计划：先列出解题步骤（1. 2. 3. ...），用「计划：」开头。
2. 执行：分步推导，每步写明依据；涉及代数运算/解方程的步骤，必须调用 compute_verify 工具验证。
3. 验证标记：每步计算结论标注 ✅（已验证）或 ❌（验证失败，需修正重算）。
4. 结论：最终答案，并附来源（Worldbook 条目 id / 讲义章节）。
5. 诚实：无法验证、条件不足或不确定时，明确说"这个问题需要进一步查证"，绝不编造数值或公式。`;
