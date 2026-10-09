// ============================================================
// dsh-plugin-curriculum · 课程大纲插件（Modulhandbuch 融入）
// 职责：
//   1. 加载 Modulhandbuch JSON（数据在 packages/library/physicist/modulhandbuch.json，
//      已 gitignore；文件缺失/解析失败 → 优雅停用）
//   2. 常驻课程上下文：physicist（星炬）preset 的 agent 创建时，
//      systemPrompt.section 注册学期模块摘要（学位/学期/在开模块/学分）
//   3. curriculum_query 工具：模块检索（代码/标题/内容）→ 详情（带来源 Modulhandbuch）
//   4. settings 开关（aemeath-curriculum.enabled，前端设置页实时开关）
//   5. 学期判断：按月份 WiSe/SoSe，config.currentSemester 可覆盖
// 注：课程知识 = 知识层（不进 L1/L2/L3 记忆）；用户的"在学/考试"事实由
//     守门员经模块代码识别沉淀进记忆（gatekeeper 联动）。
// ============================================================

import { readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readSetting, registerVolatileSettings } from '@aemeath/dsh-plugin-common';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-agent';
import { parseCurriculum, currentSemester, semesterSummary, searchModules, formatModuleDetail, allModules, WINTER, SUMMER, type CurriculumData } from './curriculum.js';

export const name = 'aemeath-curriculum';
export const inject = ['tools', 'systemPrompt', 'agents', 'settings'];

export const Config = z.object({
  // DSH 0.2.0：原 installSettingsSection('aemeath-curriculum') 的用户层开关与
  // composition 的 enabled 合并为本字段（volatile = 设置页可改、热更新生效）。
  enabled: z.boolean().default(true).volatile(),
  defaultPreset: z.string(),
  modulhandbuchFile: z.string(),
  currentSemester: z.string(),
  injectTokens: z.number(),
});

export interface CurriculumConfig {
  /** DSH 0.2.0 volatile 引用：课程上下文注入总开关。 */
  enabled?: { get?: () => boolean };
  defaultPreset?: string;
  modulhandbuchFile?: string;
  currentSemester?: string;
  injectTokens?: number;
}

function log(msg: string): void {
  console.log(`[aemeath-curriculum] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[aemeath-curriculum] ⚠ ${msg}`);
}

/** 实时角色：前端选择写入的 preset 默认（与 common 插件 persona 一致）。
 *  DSH 0.2.0：行 id 由 'agent-presets' 改为 'agent-preset-registry'，优先问服务。 */
function liveRole(ctx: Context): string | undefined {
  try {
    const presets = (ctx as unknown as { agentPresets?: { defaultId?: string } }).agentPresets;
    if (typeof presets?.defaultId === 'string' && presets.defaultId) return presets.defaultId;
  } catch {
    /* 服务缺失：落到兼容读 */
  }
  try {
    const ap = readSetting(ctx, 'agent-preset-registry') ?? readSetting(ctx, 'agent-presets');
    const v = ap?.selectedDefault ?? ap?.default;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function apply(ctx: Context, config: CurriculumConfig): Promise<void> {
  const defaultPreset = config.defaultPreset ?? 'physicist';
  const filePath = isAbsolute(config.modulhandbuchFile ?? '') ? config.modulhandbuchFile! : join(process.cwd(), config.modulhandbuchFile ?? 'packages/library/physicist/modulhandbuch.json');
  const injectTokens = config.injectTokens ?? 800;

  // ---- settings 接线（前端设置页实时开关） ----
  // DSH 0.2.0：installSettingsSection 已移除；可编辑字段改为 Config 上的 volatile
  // 引用（见 Config 定义）。0.1.1 时 config.enabled===false 会直接 return（编译期
  // 禁用）；现在该字段是 volatile、可运行时改动，故装配始终完成、每次使用前查值。
  const enabledRef = (config as { enabled?: { get?: () => boolean } }).enabled;
  const runtime = {
    get enabled(): boolean {
      return enabledRef?.get?.() ?? true;
    },
  };
  log(`settings 已应用: enabled=${runtime.enabled}`);
  registerVolatileSettings('aemeath-curriculum', { enabled: runtime.enabled });
  ctx.on('loader/volatile-update', () => {
    log(`settings 已应用: enabled=${runtime.enabled}`);
  });

  // ---- 加载 Modulhandbuch ----
  let data: CurriculumData | null = null;
  try {
    if (!readableFile(filePath)) throw new Error(`文件不存在: ${filePath}`);
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    data = parseCurriculum(raw);
    const total = allModules(data).length;
    if (!total) throw new Error('解析后无有效模块');
    log(`Modulhandbuch 加载成功：${total} 个模块（${data.document_date || '日期未知'}）`);
  } catch (e) {
    warn(`Modulhandbuch 加载失败，课程上下文停用：${(e as Error).message}`);
    return;
  }

  const semester = currentSemester(new Date(), config.currentSemester);
  const summary = semesterSummary(data, semester);
  log(`当前学期判定：${semester}（可配置覆盖）`);

  // ---- 常驻注入（system prompt section；动态跟随实时角色，仅 defaultPreset=physicist 时注入） ----
  const mountContext = (agent: { id: string; ctx: Context; session: { header?: unknown } }): void => {
    if (!runtime.enabled) return;
    const summaryText = (): string => {
      const role = liveRole(ctx) ?? defaultPreset;
      if (role !== defaultPreset) return '';
      return summary.length > injectTokens ? `${summary.slice(0, injectTokens)}\n（课程清单已截断，可用 curriculum_query 查全量）` : summary;
    };
    agent.ctx.systemPrompt.section({
      name: 'aemeath:curriculum',
      order: 90, // persona(0) 之后、工具指引(100+) 之前
      text: summaryText,
    });
    log(`课程上下文段已挂载（动态跟随实时角色）→ agent=${agent.id.slice(0, 8)}`);
  };
  for (const agent of ctx.agents.list()) mountContext(agent);
  ctx.on('agent/created', ({ agent }) => {
    mountContext(agent);
    return undefined;
  });

  // ---- curriculum_query 工具 ----
  ctx.tools.register(
    defineTool({
      name: 'curriculum_query',
      description:
        '查询汉堡物理系课程大纲（Modulhandbuch）：模块详情、前置条件、学分、内容。输入模块代码（如 PHY-E1 / MATH1）或主题关键词（德语/中文均可）。',
      parameters: {
        query: { type: 'string', required: true, description: '模块代码或主题关键词' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args: { query: string }) => {
        const hits = searchModules(data!, args.query, 3);
        const source = `Modulhandbuch ${data!.document_date || ''}`.trim() || 'Modulhandbuch';
        return {
          hits: hits.map((m) => ({
            code: m.module_code,
            title: m.title,
            credits: m.credits,
            type: m.type,
            semesters: m.semesters,
            detail: formatModuleDetail(m),
          })),
          source,
          message: hits.length ? '' : `未找到与 "${args.query}" 匹配的模块`,
        };
      },
    }),
  );
  log('工具 curriculum_query 已注册');
}

/** 只读检查文件存在（无副作用）。 */
function readableFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
