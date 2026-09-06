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
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-agent';
import { parseCurriculum, currentSemester, semesterSummary, searchModules, formatModuleDetail, allModules, WINTER, SUMMER, type CurriculumData } from './curriculum.js';

export const name = 'aemeath-curriculum';
export const inject = ['tools', 'systemPrompt', 'agents', 'settings'];

export const Config = z.object({
  enabled: z.boolean(),
  defaultPreset: z.string(),
  modulhandbuchFile: z.string(),
  currentSemester: z.string(),
  injectTokens: z.number(),
});

export interface CurriculumConfig {
  enabled?: boolean;
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

/** 实时角色：前端选择写入的 agent-presets.default（与 common 插件 persona 一致）。 */
function liveRole(ctx: Context): string | undefined {
  try {
    const ap = ctx.settings?.get?.(settingsNamespace('agent-presets')) as { default?: string } | undefined;
    return ap?.default;
  } catch {
    return undefined;
  }
}

export async function apply(ctx: Context, config: CurriculumConfig): Promise<void> {
  if (config.enabled === false) {
    log('课程上下文已禁用（config.enabled=false）');
    return;
  }
  const defaultPreset = config.defaultPreset ?? 'physicist';
  const filePath = isAbsolute(config.modulhandbuchFile ?? '') ? config.modulhandbuchFile! : join(process.cwd(), config.modulhandbuchFile ?? 'packages/library/physicist/modulhandbuch.json');
  const injectTokens = config.injectTokens ?? 800;

  // ---- settings 接线（前端设置页实时开关） ----
  const runtime = { enabled: true };
  const FeatureSettingsSchema = z.object({ enabled: z.boolean() });
  const featureBase = { enabled: true };
  let currentSource: () => typeof featureBase = () => featureBase;
  installSettingsSection(ctx, settingsNamespace('aemeath-curriculum'), FeatureSettingsSchema, featureBase, {
    setSource: (current) => {
      currentSource = current;
    },
    onChange: () => {
      runtime.enabled = currentSource().enabled;
      log(`settings 已应用: enabled=${runtime.enabled}`);
    },
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
  ctx.on('agent/created', ({ agent }) => mountContext(agent));

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
