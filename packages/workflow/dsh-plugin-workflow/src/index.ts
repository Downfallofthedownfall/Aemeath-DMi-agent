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
//      （compute_verify 每回合预算超限 → deny 并引导诚实降级；settings 开关关 → deny）。
//      不做自研用户询问（askTools/ctx.userQuestions 已移除，2026-08-16）；
//      S4 修复：对 mcp__control__*（键鼠/程序控制）的强制审批在 dsh-plugin-common
//      （tools/pre-execute 返回 kind:'ask'，approval 服务缺省 fail-closed）。
//   7. presentAs('code')（v2，config 门控默认关）：计算密集流代码呈现模式
//   8. 爱弥斯零回归：aemeath preset 不注入；工具隐藏统一在 common 插件（AEMEATH_HIDDEN_TOOLS）
// ============================================================

import type { Context } from '@deepseek-ai/cordis';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolvePresetCompat, registerVolatileSettings } from '@aemeath/dsh-plugin-common';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-subprocess';
import type {} from '@deepseek-ai/dsh-tools';
import { routeQuery, SOLVER_PROMPT } from './route.js';
import { parsePlan, upsertStep, PLAN_MISSING_NOTICE } from './plan.js';
import { SYMPY_SCRIPT, DIMENSION_SCRIPT } from './scripts.js';

export const name = 'aemeath-workflow';
export const inject = ['tools', 'subprocess', 'settings', 'agents'];

export const Config = z.object({
  defaultPreset: z.string(),
  // DSH 0.2.0：原 installSettingsSection('aemeath-workflow') 的用户层开关与
  // composition 的 enabled 合并为本字段（volatile = 可在设置页改、热更新生效）。
  enabled: z.boolean().default(true).volatile(),
  /** M6 v2：plan 步骤落 scratch（plan_step 工具 + post-execute 缺失提示）。 */
  planScratch: z.boolean(),
  /** compute_verify 每回合调用预算，超限 deny 并引导诚实降级（dsh 原版 deny 语义）。 */
  verifyBudget: z.number(),
  /** M6 v2：量纲检查工具开关。 */
  dimensionCheck: z.boolean(),
  /** M6 v2：计算密集流代码呈现模式（需 codeRuntime，默认关）。 */
  codeMode: z.boolean(),
});

export interface WorkflowConfig {
  defaultPreset?: string;
  /** DSH 0.2.0 volatile 引用：工作流总开关。 */
  enabled?: { get?: () => boolean };
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

/** scratch 里 plan 的 key（与 ctx.memory scratch 约定一致）。 */
const PLAN_SCRATCH_KEY = 'workflow.plan';

export async function apply(ctx: Context, config: WorkflowConfig): Promise<void> {
  // ---- settings 接线（M5：前端设置界面 → 实时开关） ----
  // DSH 0.2.0：installSettingsSection 已移除；可编辑字段改为 Config 上的 volatile
  // 引用（见 Config 定义），框架据此生成设置页并写回 profile patch。
  // 注：0.1.1 时这里对 config.enabled===false 直接 return（编译期禁用）；现在
  // enabled 是 volatile，值可在运行时改动，故改为「装配始终完成、每次使用前查值」，
  // 这样在设置页关掉开关能立即生效，而不需要重启。
  const enabledRef = (config as { enabled?: { get?: () => boolean } }).enabled;
  const runtime = {
    get enabled(): boolean {
      return enabledRef?.get?.() ?? true;
    },
  };
  log(`settings 已应用: enabled=${runtime.enabled}`);
  registerVolatileSettings('aemeath-workflow', { enabled: () => runtime.enabled });
  ctx.on('loader/volatile-update', () => {
    log(`settings 已应用: enabled=${runtime.enabled}`);
  });
  const defaultPreset = config.defaultPreset ?? 'physicist';
  const planScratch = config.planScratch ?? true;
  const dimensionCheck = config.dimensionCheck ?? true;
  const codeMode = config.codeMode ?? false;
  const verifyBudget = Math.max(1, config.verifyBudget ?? 3);

  // ---- compute_verify 每回合调用计数（预算 → 超限 deny 引导诚实降级；新回合开始时清零，见 pre-step） ----
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
        // 第三关：输入钳制（防 LLM 被诱导提交超长/超大指数表达式 → sympify 大整数计算炸弹）
        const MAX_EXPR_LEN = 300;
        if (args.expression.length > MAX_EXPR_LEN || args.claimed.length > MAX_EXPR_LEN) {
          return { verified: false, error: `表达式/声称解过长（≤${MAX_EXPR_LEN} 字符），已拒绝计算` };
        }
        // 大整数炸弹（sympify 会先把具体数值的幂算成完整大整数，可到 10 亿位级别）：
        //   ① `2**100000`——** 后 ≥5 位数字的字面指数；
        //   ② `10**(10**10)`——具体底数后紧跟括号指数（** 后是 `(`）；
        //   ③ `10**10**10`——链式 **（sympy 按右结合解析 → 10**(10**10)，等价炸弹）。
        // 符号表达式（x**(1/2)、(x+1)**(1/2)）不含这三类，不受影响；子进程 10s
        // 超时仍是最终兜底（正则覆盖常见形式，不追求完备）。
        const DANGEROUS_POW = /(\d+\s*\*\*\s*\d{5,})|(\d+\s*\*\*\s*\()|(\*\*\s*\d+\s*\*\*)/;
        if (DANGEROUS_POW.test(args.expression) || DANGEROUS_POW.test(args.claimed)) {
          return { verified: false, error: '表达式含超大指数/嵌套指数运算（如 2**100000、10**(10**10)），已拒绝计算' };
        }
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
          const MAX_EXPR_LEN = 300;
          if (args.expression.length > MAX_EXPR_LEN || (args.expected?.length ?? 0) > MAX_EXPR_LEN) {
            return { ok: false, error: `表达式过长（≤${MAX_EXPR_LEN} 字符），已拒绝检查` };
          }
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
          log(`plan_step（${sid.replace(/^session-/, '').slice(0, 8)}）：计划 ${next.length} 步（${args.step.slice(0, 30)}…）`);
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

    // 只在本轮第一步注入（与 memory/worldbook/retriever 对齐，防多 step 上下文线性膨胀）
    if (payload.step !== 1) return decision;

    // 新回合：验证预算清零
    verifyCounts.delete(payload.agent.session.id);

    const preset = resolvePresetCompat(ctx, payload.agent.session) ?? defaultPreset;
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
    // 新的解题回合从空计划开始：scratch 不清的话，上一题的步骤会混进这一题的计划
    // （SOLVER_PROMPT 每次都要求先列计划，所以这里清掉不会丢东西）
    if (planScratch && memorySvc()) writePlan(payload.agent.session.id, []);
    const injectMsg = createUserMessage({
      content: [{ type: 'text', text: SOLVER_PROMPT }],
      source: { kind: 'aemeath-workflow', form: 'notice', summary: `解题工作流已启用（${route.reason}）` },
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

    const preset = resolvePresetCompat(ctx, exec.agent?.session) ?? defaultPreset;
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

  // 第三关：verifyCounts 随会话结束清理（防长跑无界增长）
  // ⚠️ 不能挂 session/flush：那是每请求的持久化检查点，回合进行中也会触发，预算会被反复清零。
  ctx.on('session/disposed', (session) => {
    verifyCounts.delete(session.id);
  });

  // 注：mcp__control__*（键鼠/程序控制）的强制审批在 dsh-plugin-common（S4 修复），
  // 放公共插件可保证与 workflow.enabled 开关无关、始终挂载（全 preset）。

  // ---- post-execute：compute_verify 后核对 plan 落 scratch（缺失提示） ----
  if (planScratch) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      if (decision.kind === 'block') return decision;
      if (!runtime.enabled) return decision;
      const preset = resolvePresetCompat(ctx, exec.agent?.session) ?? defaultPreset;
      if (preset !== 'physicist') return decision;
      if (exec.name !== 'compute_verify') return decision;
      const sid = exec.agent?.session?.id;
      if (!sid) return decision;
      if (readPlan(sid).length === 0) {
        log(`[plan] ${sid.replace(/^session-/, '').slice(0, 8)} 验证时 scratch 无计划，提示模型补计划`);
        return {
          kind: 'accept',
          additionalContexts: [
            createUserMessage({
              content: [{ type: 'text', text: PLAN_MISSING_NOTICE }],
              source: { kind: 'aemeath-workflow', form: 'notice', summary: 'plan 缺失提示' },
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

  // 爱弥斯隐藏解题工具：统一在 common 插件做（AEMEATH_HIDDEN_TOOLS，含空白会话改选角色的情况）

  // ---- presentAs('ptc')（v2，config 门控默认关） ----
  // DSH 0.2.0：呈现模式由 'code' 改名为 'ptc'（native | ptc | both），且
  // presentAs 现在返回一个「恢复部署默认」的 disposer，须交给 ctx.effect 释放。
  if (codeMode) {
    const applyCodeMode = (agent: { id: string; ctx: Context; session: { header?: unknown } }): void => {
      const preset = resolvePresetCompat(ctx, agent.session) ?? defaultPreset;
      if (preset !== 'physicist') return;
      try {
        const restore = agent.ctx.tools.presentAs('ptc');
        agent.ctx.effect(() => restore);
        log(`preset=${preset}（${agent.id}）已启用 ptc 呈现模式`);
      } catch (e) {
        warn(`codeMode 需要 ptcRuntime 与 SDK renderer，当前不可用: ${(e as Error).message}`);
      }
    };
    for (const agent of ctx.agents.list()) applyCodeMode(agent);
    ctx.on('agent/created', ({ agent }) => {
      applyCodeMode(agent);
      return undefined;
      });
    log('codeMode 已启用（presentAs("ptc")，physicist 计算密集流）');
  } else {
    log('codeMode 默认关闭（presentAs("ptc") 可选，需 ptcRuntime）');
  }
}
