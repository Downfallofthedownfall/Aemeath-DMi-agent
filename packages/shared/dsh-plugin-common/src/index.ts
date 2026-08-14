// ============================================================
// dsh-plugin-common · Aemeath 公共插件（M0）
// 职责：
//   1. 日志 [前缀] 约定（模块头注释块，日志带 [aemeath-common]）
//   2. aemeath/version 冒烟工具（验证工具注册 + 会话日志）
//   3. 双人格注册：agent/created → agent 作用域 shadowing 人格段
//      （deployment:persona 槽，按 agent.id 选文本；不全局冲突）
//   4. OOC 规则层：agent/pre-step 检查上一轮 assistant 输出，
//      命中角色禁止模式 → [OOC] 日志 + steer 纠偏（规则函数纯函数，
//      可单测；LLM 判定层留待 M6）
// 端口/外部依赖：无（纯 harness 内插件）
// ============================================================

import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-agent';

export const name = 'aemeath-common';
export const inject = ['tools', 'systemPrompt', 'agents', 'credentials'];

/** 当前 v2 版本标识（M0）。 */
export const VERSION = '2.0.0-m0';

// ===== 配置（schemastery：属性默认可选，required() 才必填） =====
export const Config = z.object({
  defaultPreset: z.string(),
  personas: z.dict(
    z.object({
      file: z.string(),
      text: z.string(),
    }),
  ),
  oocRules: z.dict(
    z.object({
      forbidPatterns: z.array(z.string()),
    }),
  ),
  oocLlm: z.object({
    enabled: z.boolean(),
    apiKey: z.string(),
    baseUrl: z.string(),
    model: z.string(),
  }),
});

export interface PersonaConfig {
  file?: string;
  text?: string;
}

export interface OocRuleConfig {
  forbidPatterns?: string[];
}

export interface CommonConfig {
  defaultPreset?: string;
  personas?: Record<string, PersonaConfig>;
  oocRules?: Record<string, OocRuleConfig>;
  oocLlm?: { enabled?: boolean; apiKey?: string; baseUrl?: string; model?: string };
}

// ===== 日志（[前缀] 约定） =====
export function log(msg: string): void {
  console.log(`[aemeath-common] ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[aemeath-common] ⚠ ${msg}`);
}

// ============================================================
// OOC 规则层（纯函数，供单测）
// ============================================================
export interface OocViolation {
  pattern: string;
  matched: string;
}

/** 检查一段文本是否命中禁止模式。返回首个命中的 {pattern, matched}。 */
export function checkOoc(text: string, forbidPatterns: string[]): OocViolation | null {
  for (const raw of forbidPatterns) {
    try {
      const re = new RegExp(raw, 'i');
      const m = re.exec(text);
      if (m) return { pattern: raw, matched: m[0] };
    } catch {
      // 非法正则：跳过并告警（不阻断对话）
      warn(`非法 forbidPattern，已跳过: ${raw}`);
    }
  }
  return null;
}

/** 从 ContentBlock[] 中提取纯文本（供规则层扫描）。 */
export function extractText(blocks: readonly { type?: string; text?: string }[] | undefined): string {
  if (!blocks) return '';
  return blocks
    .map((b) => (b.type === 'text' ? b.text ?? '' : ''))
    .join('')
    .trim();
}

// ============================================================
// 插件主体
// ============================================================
export function apply(ctx: Context, config: CommonConfig): void {
  // ---- 1) aemeath/version 冒烟工具 ----
  ctx.tools.register(
    defineTool({
      name: 'aemeath_version',
      description: '返回 Aemeath-DMi Agent v2 版本与引擎信息（M0 冒烟工具）。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async () => `aemeath ${VERSION} (dsh 0.1.0-rc.6)`,
    }),
  );
  log('冒烟工具 aemeath/version 已注册');

  // ---- 2) 双人格注册（agent 作用域 shadowing，按 agent preset 分流；无 preset 时用 defaultPreset） ----
  const mountPersona = (agent: { id: string; ctx: Context; session: { header?: unknown } }): void => {
    const preset = resolveSessionPreset(agent.session as never) ?? config.defaultPreset;
    const persona = config.personas?.[preset ?? ''];
    if (!persona) return;
    let text = persona.text ?? '';
    if (!text && persona.file) {
      const p = isAbsolute(persona.file) ? persona.file : join(process.cwd(), persona.file);
      try {
        text = readFileSync(p, 'utf-8').trim();
      } catch (e) {
        warn(`读取人格文件失败 ${p}: ${(e as Error).message}`);
        return;
      }
    }
    if (!text) return;
    // 在 agent 作用域上下文注册 persona 槽（shadowing，不全局冲突）
    agent.ctx.systemPrompt.section({
      name: 'deployment:persona',
      order: 0,
      text,
    });
    log(`人格已挂载 → preset=${preset} agent=${agent.id}（${text.length} 字符）`);
  };

  // 先补挂已存在的 agents（插件启动晚于 agent-loop，会错过 agent/created）
  for (const agent of ctx.agents.list()) mountPersona(agent);
  log(`现存 agents: ${ctx.agents.list().map((a) => a.id).join(', ') || '(无)'}`);
  ctx.on('agent/created', ({ agent }) => mountPersona(agent));

  // ---- 3) OOC 规则层（agent/pre-step） ----
  const steeredTurns = new Map<string, number>();

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    const preset = resolveSessionPreset(payload.agent.session as never) ?? config.defaultPreset;
    const rules = config.oocRules?.[preset ?? ''];
    if (!rules?.forbidPatterns?.length) return decision;

    // 检查会话日志中最近一条 assistant 文本（上一轮模型输出）
    let lastAssistant = '';
    try {
      const msgs = payload.agent.session.deriveMessages();
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'assistant') {
          lastAssistant = extractText(m.content as { type?: string; text?: string }[]);
          break;
        }
      }
    } catch (e) {
      warn(`读取会话日志失败: ${(e as Error).message}`);
      return decision;
    }

    const violation = checkOoc(lastAssistant, rules.forbidPatterns);
    if (!violation) return decision;

    const key = `${payload.agent.id}:${payload.turn}`;
    if (steeredTurns.get(key)) return decision; // 每回合最多纠偏一次
    steeredTurns.set(key, 1);

    log(`[OOC] preset=${preset} 命中禁止模式 pattern=${violation.pattern} matched=${violation.matched.slice(0, 40)} turn=${payload.turn} → steer 纠偏`);
    payload.agent.steer({
      content: [
        {
          type: 'text',
          text: `（系统提示）你刚才的回答不符合角色设定（命中禁止项 ${violation.pattern}）。请立即修正：保持角色，不要使用被禁止的表达，直接重答。`,
        },
      ],
    } as never);
    return decision;
  });

  log('OOC 规则层已挂载（agent/pre-step）');

  // ---- 4) OOC LLM 判定层（M6，默认关；assistant 回复后异步判定越界 → steer 纠偏） ----
  const oocLlm = config.oocLlm ?? { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' };
  if (oocLlm.enabled) {
    ctx.on('session/event', async (session, event) => {
      try {
        if (event.type !== 'assistant/message') return;
        const preset = resolveSessionPreset(session as never) ?? config.defaultPreset;
        if (!preset) return;
        const text = (event.data.message?.content ?? [])
          .map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : ''))
          .join('')
          .trim();
        if (!text) return;
        const personaName = preset === 'aemeath' ? '爱弥斯（桌宠，活泼俏皮，不讲物理公式）' : '星炬（物理学霸，严谨专业，不卖萌）';
        let apiKey = oocLlm.apiKey;
        if (!apiKey) {
          try {
            apiKey = (await ctx.credentials?.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value ?? '';
          } catch {
            apiKey = '';
          }
        }
        if (!apiKey) return;
        const resp = await fetch(`${oocLlm.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oocLlm.apiKey}` },
          body: JSON.stringify({
            model: oocLlm.model,
            messages: [
              { role: 'system', content: '你是角色一致性判定器。判断回复是否符合角色设定，只输出 JSON：{"ooc": true/false, "reason": "简要原因"}' },
              { role: 'user', content: `角色：${personaName}\n回复：${text.slice(0, 600)}` },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 120,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
        const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as { ooc?: boolean; reason?: string };
        if (parsed.ooc) {
          log(`[OOC-LLM] preset=${preset} 越界（${parsed.reason}）→ steer 纠偏`);
          const agent = ctx.agents.get(session.id);
          if (agent) {
            agent.steer({
              content: [{ type: 'text', text: `（系统提示）你刚才的回答偏离了角色（${parsed.reason}）。请立即修正：保持角色，直接重答。` }],
            } as never);
          }
        }
      } catch {
        /* OOC LLM 判定失败静默（不影响对话） */
      }
    });
    log('OOC LLM 判定层已挂载（session/event，assistant 回复后）');
  }
}
