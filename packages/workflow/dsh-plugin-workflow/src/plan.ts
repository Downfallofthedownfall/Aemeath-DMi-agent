// ============================================================
// plan.ts — 解题计划 scratch 纯函数（M6 v2，可单测）
// plan 步骤 JSON 落 scratch（模型显式调用 plan_step 工具）：
//   scratch key = 'workflow.plan'，value = JSON 数组（步骤字符串）。
// 本模块只做确定性逻辑：解析 / 增插步骤。
// ============================================================

/** 解析 scratch 中的 plan JSON（容错：非数组/坏 JSON → 空）。 */
export function parsePlan(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw) as unknown;
    if (!Array.isArray(p)) return [];
    return p.map((s) => String(s)).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 增插一步：index 缺省追加末尾；越界夹紧到 [0, length]。
 * 返回新数组（不修改入参）。
 */
export function upsertStep(steps: string[], step: string, index?: number): string[] {
  const s = (step || '').trim();
  if (!s) return steps;
  const i = index == null ? steps.length : Math.max(0, Math.min(steps.length, Math.floor(Number(index))));
  const next = [...steps];
  next.splice(i, 0, s);
  return next;
}

/** 步骤缺失提示文案（post-execute 给模型的 notice）。 */
export const PLAN_MISSING_NOTICE = '【解题工作流】验证/执行已发生，但 scratch 中没有计划步骤。请先用 plan_step 工具列出解题计划（若已列过请检查是否落 scratch），再继续执行。';
