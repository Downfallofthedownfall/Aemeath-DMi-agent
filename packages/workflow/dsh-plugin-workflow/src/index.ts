// ============================================================
// dsh-plugin-workflow · physicist 解题工作流（M6 v2）
// 职责（仅 physicist preset 生效，config.workflow.enabled）：
//   1. 分流（route.ts）：plan（解题触发词/长问题）vs direct（日常）
//   2. 规范注入：plan 模式 pre-step 注入 SOLVER_PROMPT（soul 格式）
//   3. compute_verify 工具：SymPy 回代验证（ctx.subprocess 调 python，rtol 1e-6）
//   4. check_dimensions 工具（v2）：量纲检查（单位维度向量一致性 + 期望量纲比对）
//   5. plan_step / plan_status 工具（v2）：解题计划步骤 JSON 落 ctx.memory scratch
//      （模型显式调用；post-execute 对无计划即验证给缺失提示）
//   6. 工具流 = dsh 原版逻辑：tools/pre-execute 只做 allow/deny
//      （compute_verify 会话级预算超限 → deny 并引导诚实降级；settings 开关关 → deny）。
//      不做自研用户询问（askTools/ctx.userQuestions 已移除，2026-08-16）；
//      S4 修复：对 mcp__control__*（键鼠/程序控制）的强制审批在 dsh-plugin-common
//      （tools/pre-execute 返回 kind:'ask'，approval 服务缺省 fail-closed）。
//   7. presentAs('code')（v2，config 门控默认关）：计算密集流代码呈现模式
//   8. 爱弥斯零回归：aemeath preset 注入/工具全隔离（ctx.tools.restrict deny）
// ============================================================

import type { Context } from '@deepseek-ai/cordis';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-subprocess';
import type {} from '@deepseek-ai/dsh-tools';
import { routeQuery, SOLVER_PROMPT } from './route.js';
import { parsePlan, upsertStep, PLAN_MISSING_NOTICE } from './plan.js';

export const name = 'aemeath-workflow';
export const inject = ['tools', 'subprocess', 'settings', 'agents'];

export const Config = z.object({
  defaultPreset: z.string(),
  enabled: z.boolean(),
  /** M6 v2：plan 步骤落 scratch（plan_step 工具 + post-execute 缺失提示）。 */
  planScratch: z.boolean(),
  /** compute_verify 每会话调用预算，超限 deny 并引导诚实降级（dsh 原版 deny 语义）。 */
  verifyBudget: z.number(),
  /** M6 v2：量纲检查工具开关。 */
  dimensionCheck: z.boolean(),
  /** M6 v2：计算密集流代码呈现模式（需 codeRuntime，默认关）。 */
  codeMode: z.boolean(),
});

export interface WorkflowConfig {
  defaultPreset?: string;
  enabled?: boolean;
  planScratch?: boolean;
  verifyBudget?: number;
  dimensionCheck?: boolean;
  codeMode?: boolean;
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

/** 量纲检查脚本（python -c 传参：expression [expected]）。单位表：M L T I Θ N。 */
const DIMENSION_SCRIPT = `
import sys, json
from sympy import Symbol
from sympy.parsing.sympy_parser import parse_expr

UNITS = {
 'kg': (1,0,0,0,0,0), 'g': (1,0,0,0,0,0),
 'm': (0,1,0,0,0,0), 'cm': (0,1,0,0,0,0), 'km': (0,1,0,0,0,0), 'mm': (0,1,0,0,0,0),
 's': (0,0,1,0,0,0), 'min': (0,0,1,0,0,0), 'h': (0,0,1,0,0,0),
 'A': (0,0,0,1,0,0), 'K': (0,0,0,0,1,0), 'mol': (0,0,0,0,0,1),
 'N': (1,1,-2,0,0,0), 'J': (1,2,-2,0,0,0), 'W': (1,2,-3,0,0,0),
 'Pa': (1,-1,-2,0,0,0), 'Hz': (0,0,-1,0,0,0), 'C': (0,0,1,1,0,0),
 'V': (1,2,-3,-1,0,0), 'O': (1,2,-3,-2,0,0), 'F': (-1,-2,4,2,0,0),
 'H': (1,2,-2,-2,0,0), 'T': (1,0,-2,-1,0,0), 'Wb': (1,2,-2,-1,0,0),
}
BASE = ['kg', 'm', 's', 'A', 'K', 'mol']
# 单位名强制为 Symbol（避免 N=数值函数/C/I/E 等 sympy 内建冲突）
LOCAL = {name: Symbol(name) for name in UNITS}

def vec_add(a, b):
    return tuple(x + y for x, y in zip(a, b))

def vec_scale(a, k):
    return tuple(x * k for x in a)

def dim_of(expr_str):
    """返回表达式各加项的量纲向量集合；含未知符号 → None。"""
    expr = parse_expr(expr_str, local_dict=LOCAL)
    terms = list(expr.as_ordered_terms()) if expr.is_Add else [expr]
    out = set()
    for t in terms:
        v = (0,0,0,0,0,0)
        factors = list(t.as_ordered_factors()) if t.is_Mul else [t]
        ok = True
        for f in factors:
            if f.is_Number:
                continue
            if f.is_Symbol:
                name = str(f)
                if name in UNITS:
                    v = vec_add(v, UNITS[name])
                else:
                    ok = False; break
            elif f.is_Pow:
                b, e = f.args
                if b.is_Symbol and str(b) in UNITS:
                    try:
                        k = float(e)
                    except Exception:
                        ok = False; break
                    v = vec_add(v, vec_scale(UNITS[str(b)], k))
                else:
                    ok = False; break
            else:
                ok = False; break
        if not ok:
            return None
        out.add(v)
    return out

def render(vec):
    parts = []
    for i, e in enumerate(vec):
        if e == 0: continue
        s = BASE[i]
        parts.append(s if e == 1 else (s + '^' + (str(int(e)) if float(e).is_integer() else str(e))))
    return '*'.join(parts) if parts else '（无量纲）'

try:
    expr_s = sys.argv[1]
    expected_s = sys.argv[2] if len(sys.argv) > 2 else ''
    dims = dim_of(expr_s)
    if dims is None:
        print(json.dumps({'ok': False, 'error': '表达式中含无法判定的量（非单位符号），请只使用单位/数值组合' }))
        sys.exit(0)
    consistent = len(dims) == 1
    expr_dim = list(dims)[0] if dims else (0,0,0,0,0,0)
    out = {'ok': consistent, 'consistent': consistent, 'expression_dim': render(expr_dim), 'expression_vector': list(expr_dim)}
    if expected_s:
        ed = dim_of(expected_s)
        if ed is None or len(ed) != 1:
            out['expected_error'] = '期望量纲表达式无法判定'
        else:
            ev = list(ed)[0]
            out['expected_dim'] = render(ev)
            out['ok'] = out['ok'] and (ev == list(expr_dim))
            if not (ev == list(expr_dim)):
                out['mismatch'] = {'expression': render(expr_dim), 'expected': render(ev)}
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
`;

/** scratch 里 plan 的 key（与 ctx.memory scratch 约定一致）。 */
const PLAN_SCRATCH_KEY = 'workflow.plan';

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
  const defaultPreset = config.defaultPreset ?? 'physicist';
  const planScratch = config.planScratch ?? true;
  const dimensionCheck = config.dimensionCheck ?? true;
  const codeMode = config.codeMode ?? false;
  const verifyBudget = Math.max(1, config.verifyBudget ?? 3);

  // ---- 会话级 compute_verify 调用计数（预算 → 超限 deny 引导诚实降级） ----
  const verifyCounts = new Map<string, number>();

  /**
   * B3 修复：SymPy/量纲脚本异步执行（promisified execFile）——原 execFileSync
   * 会同步阻塞 Web 主进程事件循环最多 10 秒，多会话并发时全部会话一起卡。
   */
  const runPython = promisify(execFile);
  const PY_MAX_BUFFER = 4 * 1024 * 1024; // 4MB stdout 上限（防脚本洪水输出）

  /** ctx.memory 最小面（仅 scratch 读写）。 */
  interface MemoryScratch {
    getScratch(sessionId: string, key: string): string | undefined;
    setScratch(sessionId: string, key: string, value: string): void;
  }
  /**
   * 经 ctx.reflect.get('memory') 读取，避免 cordis 的 inject 要求
   * （未注入直接访问 ctx.memory 会抛 "without inject"；reflect 无此限制，
   * memory 插件未加载时返回 undefined → plan 落 scratch 优雅降级）。
   */
  const memorySvc = (): MemoryScratch | undefined => {
    try {
      return (ctx as unknown as { reflect?: { get(name: string): unknown } }).reflect?.get('memory') as MemoryScratch | undefined;
    } catch {
      return undefined;
    }
  };

  /** 读/写 plan scratch（经 ctx.memory；不可用时优雅降级为空/丢弃）。 */
  const readPlan = (sid: string): string[] => {
    const raw = memorySvc()?.getScratch(sid, PLAN_SCRATCH_KEY);
    return parsePlan(raw);
  };
  const writePlan = (sid: string, steps: string[]): void => {
    memorySvc()?.setScratch(sid, PLAN_SCRATCH_KEY, JSON.stringify(steps));
  };

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
          const { stdout } = await runPython('python', ['-c', SYMPY_SCRIPT, args.expression, args.claimed, args.variable ?? 'x'], {
            encoding: 'utf-8',
            timeout: 10_000,
            maxBuffer: PY_MAX_BUFFER,
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

  // ---- check_dimensions 工具（v2）：量纲检查 ----
  if (dimensionCheck) {
    ctx.tools.register(
      defineTool({
        name: 'check_dimensions',
        description:
          '量纲检查：核对单位组合的量纲一致性，可选与期望量纲比对。表达式只允许单位/数值组合（kg m s A K mol 及派生 N J W Pa Hz C V Ω F H T Wb），未知符号无法判定。',
        parameters: {
          expression: { type: 'string', required: true, description: '量纲表达式，如 "N*s/kg" 或 "m/s + 2*m/s"' },
          expected: { type: 'string', description: '期望量纲（可选），如 "m/s"' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args: { expression: string; expected?: string }) => {
          try {
            const argv = ['-c', DIMENSION_SCRIPT, args.expression];
            if (args.expected) argv.push(args.expected);
            const { stdout } = await runPython('python', argv, { encoding: 'utf-8', timeout: 10_000, maxBuffer: PY_MAX_BUFFER });
            return JSON.parse(stdout); // any → JsonValue
          } catch (e) {
            const msg = (e as Error & { stdout?: string | Buffer }).stdout?.toString() ?? (e as Error).message;
            return { ok: false, error: msg.slice(0, 300) };
          }
        },
      }),
    );
    log('工具 check_dimensions 已注册（量纲检查）');
  }

  // ---- plan_step 工具（v2）：计划步骤落 scratch ----
  if (planScratch) {
    ctx.tools.register(
      defineTool({
        name: 'plan_step',
        description: '把解题计划的一步写入工作暂存（scratch）。解题工作流中每列出一步计划调用一次（step=该步描述）；返回当前已落步骤列表。',
        parameters: {
          step: { type: 'string', required: true, description: '本步计划描述，如 "写出受力方程 F=ma"' },
          index: { type: 'number', description: '步骤序号（从 0 开始）；缺省追加到末尾' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args: { step: string; index?: number }, exec) => {
          const sid = exec.agent?.session?.id;
          if (!sid) return { ok: false, count: 0, steps: [], error: '无会话上下文' };
          if (!memorySvc()) return { ok: false, count: 0, steps: [], error: 'plan scratch 不可用（memory 插件未加载）' };
          const next = upsertStep(readPlan(sid), args.step, args.index);
          writePlan(sid, next);
          log(`plan_step（${sid.slice(0, 8)}）：计划 ${next.length} 步（${args.step.slice(0, 30)}…）`);
          return { ok: true, count: next.length, steps: next, error: null };
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: 'plan_status',
        description: '读取 scratch 中已落的解题计划步骤（核对计划是否完整）。',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (_args, exec) => {
          const sid = exec.agent?.session?.id;
          if (!sid) return { ok: false, count: 0, steps: [], error: '无会话上下文' };
          if (!memorySvc()) return { ok: false, count: 0, steps: [], error: 'plan scratch 不可用（memory 插件未加载）' };
          return { ok: true, count: readPlan(sid).length, steps: readPlan(sid), error: null };
        },
      }),
    );
    log('工具 plan_step / plan_status 已注册（plan 步骤落 scratch）');
  }

  // ---- 分流 + 规范注入（agent/pre-step，仅 physicist） ----
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    if (!runtime.enabled) return decision;

    const preset = resolveSessionPreset(payload.agent.session as never) ?? defaultPreset;
    if (preset !== 'physicist') return decision;

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

    log(`preset=physicist 分流=plan（${route.reason}）：${query.slice(0, 30)}…`);
    const injectMsg = createUserMessage({
      content: [{ type: 'text', text: SOLVER_PROMPT }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: `解题工作流已启用（${route.reason}）` },
    });
    return { kind: 'enter', messages: [...decision.messages, injectMsg] };
  });
  log('解题分流 + 规范注入已挂载（agent/pre-step，physicist 模式）');

  // ---- 工具流 = dsh 原版逻辑（tools/pre-execute 只做 allow/deny） ----
  // compute_verify 会话级预算：超限 deny 并引导诚实降级（防盲目重试；不做自研用户询问）。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow') return decision;
    if (!runtime.enabled) return decision;

    const preset = resolveSessionPreset(exec.agent?.session as never) ?? defaultPreset;
    if (preset !== 'physicist') return decision;

    if (exec.name === 'compute_verify') {
      const sid = exec.agent?.session?.id ?? '';
      const n = (verifyCounts.get(sid) ?? 0) + 1;
      verifyCounts.set(sid, n);
      if (n > verifyBudget) {
        log(`[gate] compute_verify 第 ${n} 次（预算 ${verifyBudget}），deny 并引导诚实降级`);
        return {
          kind: 'deny',
          reason: `compute_verify 已调用 ${n} 次超过预算（${verifyBudget}）。请停止盲目重试，改为手工精确验证并如实说明验证方式与置信度（诚实降级原则）。`,
        };
      }
    }
    return decision;
  });
  log(`工具流已挂载（tools/pre-execute，dsh 原版 allow/deny，verifyBudget=${verifyBudget}）`);

  // 注：mcp__control__*（键鼠/程序控制）的强制审批在 dsh-plugin-common（S4 修复），
  // 放公共插件可保证与 workflow.enabled 开关无关、始终挂载（全 preset）。

  // ---- post-execute：compute_verify 后核对 plan 落 scratch（缺失提示） ----
  if (planScratch) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      if (decision.kind === 'block') return decision;
      if (!runtime.enabled) return decision;
      const preset = resolveSessionPreset(exec.agent?.session as never) ?? defaultPreset;
      if (preset !== 'physicist') return decision;
      if (exec.name !== 'compute_verify') return decision;
      const sid = exec.agent?.session?.id;
      if (!sid) return decision;
      if (readPlan(sid).length === 0) {
        log(`[plan] ${sid.slice(0, 8)} 验证时 scratch 无计划，提示模型补计划`);
        return {
          kind: 'accept',
          additionalContexts: [
            createUserMessage({
              content: [{ type: 'text', text: PLAN_MISSING_NOTICE }],
              source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'plan 缺失提示' },
            }),
          ],
        };
      }
      return decision;
    });
    log('post-execute 已挂载（compute_verify → plan 缺失提示）');
  }

  // ---- 开关联动：settings enabled=false 时拒绝解题工具执行 ----
  const WORKFLOW_TOOLS = planScratch ? ['compute_verify', 'check_dimensions', 'plan_step', 'plan_status'] : ['compute_verify', 'check_dimensions'];
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow') return decision;
    if (!WORKFLOW_TOOLS.includes(exec.name)) return decision;
    if (runtime.enabled) return decision;
    log(`开关已关闭：拒绝 ${exec.name} 调用`);
    return {
      kind: 'deny' as const,
      reason: '解题工作流已关闭（设置 → 功能开关）。如需 SymPy 验证/量纲检查，请重新开启。',
    };
  });
  log('工具开关联动已挂载（tools/pre-execute，解题工具集）');

  // ---- 爱弥斯零回归：aemeath preset 隐藏全部解题工具（工具集隔离） ----
  const restrictAemeath = (agent: { id: string; ctx: Context; session: { header?: unknown } }): void => {
    const preset = resolveSessionPreset(agent.session as never) ?? defaultPreset;
    if (preset !== 'aemeath') return;
    try {
      agent.ctx.tools.restrict({ deny: WORKFLOW_TOOLS });
      log(`preset=${preset}（${agent.id}）已隐藏解题工具（compute_verify/check_dimensions/plan_step/plan_status）`);
    } catch (e) {
      warn(`爱弥斯工具隔离失败: ${(e as Error).message}`);
    }
  };
  for (const agent of ctx.agents.list()) restrictAemeath(agent);
  ctx.on('agent/created', ({ agent }) => restrictAemeath(agent));
  log('爱弥斯零回归：aemeath preset 工具隔离已挂载');

  // ---- presentAs('code')（v2，config 门控默认关） ----
  if (codeMode) {
    const applyCodeMode = (agent: { id: string; ctx: Context; session: { header?: unknown } }): void => {
      const preset = resolveSessionPreset(agent.session as never) ?? defaultPreset;
      if (preset !== 'physicist') return;
      try {
        agent.ctx.tools.presentAs('code');
        log(`preset=${preset}（${agent.id}）已启用 code 呈现模式`);
      } catch (e) {
        warn(`codeMode 需要 codeRuntime 与 SDK renderer，当前不可用: ${(e as Error).message}`);
      }
    };
    for (const agent of ctx.agents.list()) applyCodeMode(agent);
    ctx.on('agent/created', ({ agent }) => applyCodeMode(agent));
    log('codeMode 已启用（presentAs("code")，physicist 计算密集流）');
  } else {
    log('codeMode 默认关闭（presentAs("code") 可选，需 codeRuntime）');
  }
}
