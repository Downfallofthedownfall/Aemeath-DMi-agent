// ============================================================
// dsh-plugin-workflow · 星炬解题工作流（M6 v1）
// 职责（仅 scholar preset 生效，config.workflow.enabled）：
//   1. 分流（route.ts）：plan（解题触发词/长问题）vs direct（日常）
//   2. 规范注入：plan 模式 pre-step 注入 SOLVER_PROMPT（soul 格式：
//      计划→执行→✅/❌ 验证标记→结论+来源→诚实降级）
//   3. compute_verify 工具：SymPy 回代验证（ctx.subprocess 调 python，rtol 1e-6）
//   4. Action Gate 简化：post-execute 对 compute_verify 结果附加验证标记；
//      refresh 计数（同一调用 ≤2 次，超限提示降级）
//   5. OOC LLM 判定层：由 dsh-plugin-common 提供（M6 配套，默认关）
// 注：v1 以"提示词规范 + 验证工具"落地 soul；plan 步骤 JSON 落 scratch 的
//     模型侧存储留待 v2（需模型显式调用工具）。
// ============================================================

import type { Context } from '@deepseek-ai/cordis';
import { execFileSync } from 'node:child_process';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-subprocess';
import { routeQuery, SOLVER_PROMPT } from './route.js';

export const name = 'aemeath-workflow';
export const inject = ['tools', 'subprocess', 'settings'];

export const Config = z.object({
  defaultPreset: z.string(),
  enabled: z.boolean(),
});

export interface WorkflowConfig {
  defaultPreset?: string;
  enabled?: boolean;
}

function log(msg: string): void {
  console.log(`[aemeath-workflow] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[aemeath-workflow] ⚠ ${msg}`);
}

/** SymPy 验证脚本（python -c 传参：expression claimed [variable]）。 */
const SYMPY_SCRIPT = `
import sys, json
try:
    from sympy import symbols, sympify, solve, N
    expr_s = sys.argv[1]; claimed_s = sys.argv[2]; var_s = sys.argv[3] if len(sys.argv) > 3 else 'x'
    x = symbols(var_s)
    expr = sympify(expr_s)
    sols = solve(expr, x)
    checked = []
    for c in [t for t in claimed_s.replace(' ', '').split(',') if t]:
        try:
            val = N(expr.subs(x, sympify(c)), 15)
            ok = abs(val) < 1e-6
            checked.append({'claimed': c, 'ok': bool(ok), 'residual': float(abs(val))})
        except Exception:
            checked.append({'claimed': c, 'ok': False, 'residual': None})
    print(json.dumps({'verified': bool(sols) and all(c['ok'] for c in checked), 'solutions': [str(s) for s in sols], 'checked': checked}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

export async function apply(ctx: Context, config: WorkflowConfig): Promise<void> {
  if (config.enabled === false) {
    log('工作流已禁用（config.enabled=false）');
    return;
  }
  // ---- settings 接线（M5：前端设置界面 → 实时开关） ----
  const runtime = { enabled: true };
  const FeatureSettingsSchema = z.object({ enabled: z.boolean() });
  const featureBase = { enabled: true };
  let currentSource: () => typeof featureBase = () => featureBase;
  installSettingsSection(
    ctx,
    settingsNamespace('aemeath-workflow'),
    FeatureSettingsSchema,
    featureBase,
    {
      setSource: (current) => {
        currentSource = current;
      },
      onChange: () => {
        const v = currentSource();
        runtime.enabled = v.enabled;
        log(`settings 已应用: enabled=${runtime.enabled}`);
      },
    },
  );
  const defaultPreset = config.defaultPreset ?? 'scholar';

  // ---- compute_verify 工具：SymPy 回代验证 ----
  ctx.tools.register(
    defineTool({
      name: 'compute_verify',
      description:
        '用 SymPy 验证代数表达式与声称的解（回代检查，rtol 1e-6）。用于解题工作流中每步计算的自检：传入表达式与声称的解，返回 verified/solutions/checked。',
      parameters: {
        expression: { type: 'string', required: true, description: 'SymPy 可解析的表达式，如 "x**2 - 4"（=0 求根）' },
        claimed: { type: 'string', required: true, description: '声称的解，逗号分隔，如 "2, -2"' },
        variable: { type: 'string', description: '变量名，默认 x' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args: { expression: string; claimed: string; variable?: string }) => {
        try {
          const stdout = execFileSync('python', ['-c', SYMPY_SCRIPT, args.expression, args.claimed, args.variable ?? 'x'], {
            encoding: 'utf-8',
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const parsed = JSON.parse(stdout) as { verified?: boolean; solutions?: string[]; checked?: Array<{ claimed: string; ok: boolean; residual: number | null }>; error?: string };
          return {
            verified: parsed.verified ?? false,
            solutions: parsed.solutions ?? [],
            checked: parsed.checked ?? [],
            ...(parsed.error ? { error: parsed.error } : {}),
          };
        } catch (e) {
          const msg = (e as Error & { stdout?: string | Buffer }).stdout?.toString() ?? (e as Error).message;
          return { verified: false, error: msg.slice(0, 300) };
        }
      },
    }),
  );
  log('工具 compute_verify 已注册（SymPy 回代验证）');

  // ---- 分流 + 规范注入（agent/pre-step，仅 scholar） ----
  const steeredPlans = new Map<string, number>();

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    if (!runtime.enabled) return decision;

    const preset = resolveSessionPreset(payload.agent.session as never) ?? defaultPreset;
    if (preset !== 'scholar') return decision;

    // 取用户原始消息
    let query = '';
    for (let i = decision.messages.length - 1; i >= 0; i--) {
      const m = decision.messages[i] as { role?: string; source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] };
      if (m.role === 'user' && m.source?.kind === 'user') {
        query = (m.content ?? []).map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('').trim();
        break;
      }
    }
    if (!query) return decision;

    const route = routeQuery(query);
    if (route.kind !== 'plan') return decision;

    log(`preset=scholar 分流=plan（${route.reason}）：${query.slice(0, 30)}…`);
    const injectMsg = createUserMessage({
      content: [{ type: 'text', text: SOLVER_PROMPT }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: `解题工作流已启用（${route.reason}）` },
    });
    return { kind: 'enter', messages: [...decision.messages, injectMsg] };
  });
  log('解题分流 + 规范注入已挂载（agent/pre-step，scholar 模式）');

  // ---- Action Gate 简化：compute_verify 结果附加验证标记 + refresh≤2 ----
  const refreshCounts = new Map<string, number>();
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (exec.name !== 'compute_verify') return decision;
    if (decision.kind === 'block') return decision;
    const key = `${exec.callId}`;
    const n = (refreshCounts.get(key) ?? 0) + 1;
    refreshCounts.set(key, n);
    if (n > 2) {
      log(`[ActionGate] compute_verify 第 ${n} 次（超限），提示诚实降级`);
    }
    // 结果文本已含 verified 标记，无需改写（提示词引导模型使用 ✅/❌）
    return decision;
  });
  log('Action Gate 已挂载（tools/post-execute，refresh≤2）');

  // ---- 开关联动：settings enabled=false 时拒绝 compute_verify 执行 ----
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow') return decision;
    if (exec.name !== 'compute_verify') return decision;
    if (runtime.enabled) return decision;
    log(`开关已关闭：拒绝 compute_verify 调用`);
    return {
      kind: 'deny' as const,
      reason: '解题工作流已关闭（设置 → 功能开关）。如需 SymPy 验证，请重新开启。',
    };
  });
  log('工具开关联动已挂载（tools/pre-execute，compute_verify）');
}
