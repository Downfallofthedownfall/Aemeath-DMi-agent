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
import { lookup } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-agent';
export const name = 'aemeath-common';
export const inject = ['tools', 'systemPrompt', 'agents', 'credentials', 'settings'];

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
  /** 系统审批弹窗（S7）：mcp__control__* 等需审批的调用改弹系统级 MessageBox
   *  （前台显示 + 回车允许/Esc 拒绝），免去切回 dsh Web UI 点审批。默认开。 */
  systemApproval: z.boolean(),
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
  systemApproval?: boolean;
}

// ===== 日志（[前缀] 约定） =====
export function log(msg: string): void {
  console.log(`[aemeath-common] ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[aemeath-common] ⚠ ${msg}`);
}

// ============================================================
// S7：系统审批（免 alt-tab 切回 Web UI）
// mcp__control__* 等敏感工具调用 → 系统级审批，两种形态：
//   首选：右下角通知 + 全局快捷键（scripts/ask-notify.ps1）——
//     气泡通知右下角弹出、托盘图标常驻、全程不抢焦点不切窗口；
//     Ctrl+Alt+1 = 允许，Ctrl+Alt+2 = 拒绝，点击通知/托盘菜单亦可。
//   fallback：模态 MessageBox（回车=允许 Esc=拒绝），通知脚本不可用时使用。
// 实现：spawn powershell；参数经环境变量传入（防注入）；脚本需 UTF-8 BOM
// （PowerShell 5.1 无 BOM 按 GBK 读，中文会破坏解析）。
// 超时/失败 → unavailable，由调用方回退 Web UI 审批（fail-open 到既有路径）。
// ============================================================
const execFileAsync = promisify(execFile);

/** 系统审批超时（秒/毫秒）：用户有足够时间决策；超时回退 Web UI。 */
const SYSTEM_ASK_TIMEOUT_SEC = 120;
const SYSTEM_ASK_TIMEOUT_MS = SYSTEM_ASK_TIMEOUT_SEC * 1000;

/** 并发信号量：同一时刻只弹一个审批（并发调用排队，第二个回退 Web UI）。 */
let systemAskActive = false;

/** 右下角通知脚本（ESM：import.meta.url → lib/index.js，../scripts/ 与包同目录）。 */
const SYSTEM_ASK_NOTIFY_PS = fileURLToPath(new URL('../scripts/ask-notify.ps1', import.meta.url));

/** fallback：模态 MessageBox 脚本（单引号 TS 字符串：$ / 反引号均为字面量，PS 侧解释）。 */
const SYSTEM_ASK_PS_ZH = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$tool = $env:AEMEATH_ASK_TOOL',
  '$reason = $env:AEMEATH_ASK_REASON',
  '$msg = "爱弥斯想调用：$tool`n`n$reason`n`n是否允许？`n（回车=允许，Esc=拒绝）"',
  '$r = [System.Windows.Forms.MessageBox]::Show($msg, "爱弥斯 · 权限确认", "YesNo", "Question", "Button1")',
  "if ($r -eq 'Yes') { Write-Output 'ALLOW' } else { Write-Output 'DENY' }",
].join('; ');

/** fallback：模态 MessageBox 脚本（英文版，locale=en 时用）。 */
const SYSTEM_ASK_PS_EN = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$tool = $env:AEMEATH_ASK_TOOL',
  '$reason = $env:AEMEATH_ASK_REASON',
  '$msg = "Aemeath wants to call: $tool`n`n$reason`n`nAllow it?`n(Enter = Allow, Esc = Reject)"',
  '$r = [System.Windows.Forms.MessageBox]::Show($msg, "Aemeath · Permission Request", "YesNo", "Question", "Button1")',
  "if ($r -eq 'Yes') { Write-Output 'ALLOW' } else { Write-Output 'DENY' }",
].join('; ');

async function systemApproval(toolName: string, reason: string, locale: string): Promise<'allow' | 'deny' | 'unavailable'> {
  if (systemAskActive) return 'unavailable';
  systemAskActive = true;
  try {
    // 首选：右下角通知 + 全局快捷键（F5 同意 / F6 拒绝 / 点击通知按钮）
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SYSTEM_ASK_NOTIFY_PS, '-TimeoutSec', String(SYSTEM_ASK_TIMEOUT_SEC)],
        {
          timeout: SYSTEM_ASK_TIMEOUT_MS + 10_000,
          // 参数走环境变量：避免命令行拼接注入（reason 可能含引号/换行）；locale 供脚本双语切换
          env: { ...process.env, AEMEATH_ASK_TOOL: toolName, AEMEATH_ASK_REASON: reason, AEMEATH_ASK_LOCALE: locale },
          windowsHide: true, // 隐藏 PowerShell 控制台黑框（通知/托盘是 GUI，不受影响）
        },
      );
      const out = stdout.trim().toUpperCase();
      if (out === 'ALLOW') return 'allow';
      if (out === 'DENY') return 'deny';
      return 'unavailable'; // TIMEOUT：用户未决策 → 回退 Web UI
    } catch {
      warn('系统通知审批不可用，回退模态 MessageBox');
    }
    // fallback：模态 MessageBox（回车=允许，Esc=拒绝；按 locale 选文案）
    const msgScript = locale === 'en' ? SYSTEM_ASK_PS_EN : SYSTEM_ASK_PS_ZH;
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', msgScript], {
      timeout: SYSTEM_ASK_TIMEOUT_MS,
      env: { ...process.env, AEMEATH_ASK_TOOL: toolName, AEMEATH_ASK_REASON: reason },
      windowsHide: true,
    });
    return stdout.trim().toUpperCase().includes('ALLOW') ? 'allow' : 'deny';
  } catch (e) {
    warn(`系统审批不可用（回退 Web UI 审批）：${(e as Error).message}`);
    return 'unavailable';
  } finally {
    systemAskActive = false;
  }
}

/**
 * 读取当前 UI locale 偏好（settings.locale.preference，由 dsh 平台 locale 插件
 * 注册；缺省 zh）。host 侧无法感知浏览器语言，只能读用户显式选择的偏好。
 */
function currentLocale(ctx: Context): string {
  try {
    const v = ctx.settings?.get(settingsNamespace('locale')) as { preference?: string } | undefined;
    return v?.preference === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

/**
 * 按 locale 解析人格文件路径：<base>.en.md 存在时优先，否则回退配置的 file。
 * 中文（zh）直接使用默认 file。
 */
function personaFileForLocale(file: string, locale: string): string {
  if (locale !== 'en') return file;
  const localized = file.replace(/\.md$/, '') + '.en.md';
  try {
    readFileSync(localized, 'utf-8');
    return localized;
  } catch {
    return file;
  }
}

/**
 * 读取前端上报的 UI locale（settings.aemeath-ui.locale，前端在 locale 变化时
 * 通过 /aemeath/api/settings 写入）。这是"跟随前端语言"提示词的权威来源：
 * 前端能感知浏览器语言与显式选择，host 只读平台 preference 无法覆盖"跟随浏览器"。
 * 返回 'en' / 'zh'；未上报返回 ''（不注入语言指令）。
 */
function uiLocale(ctx: Context): string {
  try {
    const v = ctx.settings?.get(settingsNamespace('aemeath-ui')) as { locale?: string } | undefined;
    const l = v?.locale;
    return l === 'en' || l === 'zh' ? l : '';
  } catch {
    return '';
  }
}

/**
 * 语言指令文本：注入 system prompt，约束模型回复语言跟随前端 UI。
 * 前端 locale=en → 英文回复；zh → 中文回复；未上报（''）→ 不注入（跟随 persona/对话）。
 */
function languageDirective(locale: string): string {
  if (locale === 'en') {
    return 'Language: Always reply in English. The user interface language is English — keep all answers in English, including when quoting the knowledge base or lecture notes (translate/paraphrase content rather than switching to Chinese).';
  }
  if (locale === 'zh') {
    return '语言：请始终用中文回复。界面语言为中文——所有回答（含引用知识库/讲义内容时）都用中文表达。';
  }
  return '';
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
// web_scraper SSRF 防护（S6）：拒绝私网/回环/保留地址，防止模型被诱导
// 抓取本地服务（含 dsh 自身的管理端点、其他 localhost 应用）。
// 先对 URL hostname 做字面量校验（直接 IP），再 DNS 解析校验（防域名指向内网）。
// ============================================================
const IPV4_PART = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isPrivateHostname(hostname: string): boolean {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.startsWith('::ffff:')) return isPrivateHostname(h.slice(7)); // IPv4-mapped IPv6
  if (h.includes(':')) {
    // IPv6：回环 ::1、链路本地 fe80::/10、ULA fc00::/7、IPv4 兼容
    if (h === '::1' || h === '::') return true;
    if (/^fe[89ab]/.test(h) || /^f[cd]/.test(h)) return true;
    return false;
  }
  const m = h.match(IPV4_PART);
  if (!m) return false; // 域名：交给 DNS 解析后校验
  const [a, b, c] = m.slice(1).map(Number);
  if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

async function resolveBlocksPrivate(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    if (isPrivateHostname(u.hostname)) return true;
    const addrs = await lookup(u.hostname, { all: true });
    return addrs.length === 0 || addrs.some(({ address }) => isPrivateHostname(address));
  } catch {
    return true; // URL 非法 / DNS 解析失败：一律拒绝
  }
}

// ⚠ 已知残留：DNS rebinding（TOCTOU）。此处先 lookup 校验、随后 fetch 由 Node
// 在连接时重新解析——恶意域名可在两次解析之间从公网 IP 切到内网，绕过本检查。
// 对本地桌宠威胁模型影响小（需攻击者控制被抓取域名的 DNS 且内网可达），故未做
// 钉 IP + Host 头的严格化；如需加固，改为自行解析后经自定义 Agent/net.connect
// 连接已校验的公网 IP 并携带 Host 头。

// 搜索引擎结果页 URL（bing/google/baidu/ddg/yahoo 的 search 形态）：有反爬
// （验证页/403/空壳结果），抓取必然失败；搜索应走 dsh 内置 web_search 工具
// （DeepSeek 官方搜索接口，结构化结果 + 来源）。命中直接拒绝并指路。
const SEARCH_PAGE_URL = /(bing\.com|cn\.bing\.com)\/search|google\.com\/search|baidu\.com\/s(?=[?/]|$)|duckduckgo\.com\/\?q=|search\.yahoo\.com\/search/i;

// ============================================================
// 插件主体
// ============================================================
export function apply(ctx: Context, config: CommonConfig): void {
  // ---- 0) settings 接线（M5：前端设置界面 → 实时开关） ----
  // namespace: aemeath.common；base = 本插件 composition config 的派生值；
  // 用户层（前端设置页写入）覆盖后 watch 实时生效。
  const runtime = {
    oocRulesEnabled: true,
    oocLlmEnabled: config.oocLlm?.enabled ?? false,
  };
  const FeatureSettingsSchema = z.object({
    oocRulesEnabled: z.boolean(),
    oocLlmEnabled: z.boolean(),
  });
  const featureBase = { oocRulesEnabled: true, oocLlmEnabled: config.oocLlm?.enabled ?? false };
  let currentSource: () => typeof featureBase = () => featureBase;
  installSettingsSection(
    ctx,
    settingsNamespace('aemeath-common'),
    FeatureSettingsSchema,
    featureBase,
    {
      setSource: (current) => {
        currentSource = current;
      },
      onChange: () => {
        const v = currentSource();
        runtime.oocRulesEnabled = v.oocRulesEnabled;
        runtime.oocLlmEnabled = v.oocLlmEnabled;
        log(`settings 已应用: oocRulesEnabled=${runtime.oocRulesEnabled} oocLlmEnabled=${runtime.oocLlmEnabled}`);
      },
    },
  );

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
      execute: async () => `aemeath ${VERSION} (dsh 0.1.1-rc.2)`,
    }),
  );
  log('冒烟工具 aemeath/version 已注册');

  // ---- S4/S7 修复：键鼠/程序控制工具强制审批（全 preset 生效） ----
  // control_mcp 的工具（mcp__control__*）会在用户机器上真实操作键鼠/窗口、启动程序，
  // 且 control_open 白名单含任意存在的 .exe 路径。模型被注入后可直接调用，因此这里
  // 对所有 mcp__control__* 调用强制审批。审批方式（S7，默认开）：
  //   系统级审批——右下角通知 + 托盘图标 + 全局快捷键（Ctrl+Alt+1 允许 /
  //   Ctrl+Alt+2 拒绝，点击通知亦可），不抢焦点不切窗口；通知不可用时回退
  //   模态 MessageBox；仍不可用 → 回退 kind:'ask' 走 dsh 原生 Web UI 审批
  //   （缺省策略 ask 交给 answerer，无人应答 fail-closed deny）。
  // 放在公共插件（而非 workflow）是为了与 workflow.enabled 开关无关、始终挂载。
  const systemApprovalEnabled = config.systemApproval ?? true;
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow') return decision;
    if (!exec.name.startsWith('mcp__control__')) return decision;
    const reason = `${exec.name} 会在用户机器上真实操作键鼠/窗口或启动程序，需要您确认后才会执行。`;
    if (systemApprovalEnabled) {
      const verdict = await systemApproval(exec.name, reason, currentLocale(ctx));
      if (verdict === 'allow') {
        log(`[gate] ${exec.name} 用户已批准（系统通知）`);
        return decision;
      }
      if (verdict === 'deny') {
        log(`[gate] ${exec.name} 用户拒绝（系统通知）`);
        return { kind: 'deny' as const, reason: '用户在系统审批中拒绝了该操作。' };
      }
    }
    // 系统弹窗关闭/不可用 → 回退 Web UI 审批
    return { kind: 'ask' as const, reason };
  });
  log(`键鼠/程序控制工具审批已挂载（tools/pre-execute，mcp__control__* 全 preset；系统审批通知=${systemApprovalEnabled ? '开' : '关（回退 Web UI）'}）`);

  // ---- 1.5) v1 轻量工具迁移：get_current_time / web_scraper / arxiv_search ----
  ctx.tools.register(
    defineTool({
      name: 'get_current_time',
      description: '返回当前日期与时间（YYYY-MM-DD HH:mm:ss）。涉及截止日期/今日安排时先调用它。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async () => {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'web_scraper',
      description:
        '抓取具体网页的正文文本（去除 script/style 与标签，返回前 3000 字符）。用于查证已知 URL 的文章/文档/新闻内容。' +
        '⚠ 搜索不要用它：抓取搜索引擎结果页（bing/google/baidu 的 search URL）会被反爬拦截。搜索请用 dsh 内置 web_search 工具，拿到来源 URL 后再用本工具抓正文。',
      parameters: {
        url: { type: 'string', required: true, description: '具体的文章/页面 URL（非搜索引擎结果页），如 https://example.com/page' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async (args: { url: string }) => {
        const url = args.url;
        try {
          // 搜索引擎结果页：反爬必失败，拒绝并指路 dsh 内置 web_search
          if (SEARCH_PAGE_URL.test(url)) {
            return `Web scraper error: 这是搜索引擎结果页（${url.slice(0, 100)}），有反爬且不适合抓取。请改用 dsh 内置的 web_search 工具搜索，再对返回的具体文章 URL 调用本工具。`;
          }
          // S6：SSRF 防护——私网/回环/保留地址或非 http(s) 一律拒绝
          if (await resolveBlocksPrivate(url)) {
            return `Web scraper error: URL 不可访问（拒绝私网/回环/保留地址或非 http(s)）: ${url.slice(0, 120)}`;
          }
          const resp = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(10_000),
          });
          if (!resp.ok) return `Web scraper error: HTTP ${resp.status} (${url})`;
          const html = await resp.text();
          const noScript = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
          const text = noScript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          return `Web content:\n\n${text.slice(0, 3000)}${text.length > 3000 ? '\n\n...(truncated)' : ''}`;
        } catch (e) {
          return `Web scraper error: ${(e as Error).message}`;
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'arxiv_search',
      description: '搜索 arXiv 学术论文（标题/作者/摘要，最多 5 篇）。用于查证物理/数学文献。',
      parameters: {
        query: { type: 'string', required: true, description: '检索关键词，如 "harmonic oscillator" 或 "quantum mechanics"（可加 +AND 组合）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async (args: { query: string }) => {
        try {
          // 第三关：http → https（明文泄露查询内容）
          const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(args.query)}&max_results=5`;
          const resp = await fetch(url, {
            headers: { 'User-Agent': 'Aemeath/1.0' },
            signal: AbortSignal.timeout(10_000),
          });
          if (!resp.ok) return `arXiv error: HTTP ${resp.status}`;
          const xml = await resp.text();
          const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
          if (!entries.length) return 'No results found';
          const results = entries.slice(0, 5).map((entry) => {
            const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1]?.trim() ?? 'Unknown';
            const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim()).slice(0, 3);
            const summary = /<summary>([\s\S]*?)<\/summary>/.exec(entry)?.[1]?.trim().slice(0, 200) ?? 'N/A';
            return `Title: ${title}\nAuthors: ${authors.join(', ')}\nAbstract: ${summary}...`;
          });
          return `arXiv '${args.query}':\n\n${results.join('\n---\n')}`;
        } catch (e) {
          return `arXiv search error: ${(e as Error).message}`;
        }
      },
    }),
  );
  log('轻量工具已注册：get_current_time / web_scraper / arxiv_search（v1 迁移）');

  // ---- 2) 双人格注册（agent 作用域 shadowing，按 agent preset 分流；无 preset 时用 defaultPreset） ----
  const mountedAgentPersonas = new Set<string>();
  const mountPersona = (agent: { id: string; ctx: Context; session: { header?: unknown } }): void => {
    const preset = resolveSessionPreset(agent.session as never) ?? config.defaultPreset;
    const persona = config.personas?.[preset ?? ''];
    if (!persona) return;
    // i18n：按 settings.locale.preference 选择人格文件（zh 用默认，en/de 用 <base>.<locale>.md）
    const locale = currentLocale(ctx);
    let text = persona.text ?? '';
    if (!text && persona.file) {
      const localized = personaFileForLocale(persona.file, locale);
      const p = isAbsolute(localized) ? localized : join(process.cwd(), localized);
      try {
        text = readFileSync(p, 'utf-8').trim();
      } catch (e) {
        warn(`读取人格文件失败 ${p}: ${(e as Error).message}`);
        return;
      }
      if (localized !== persona.file) log(`人格按 locale 选择: ${persona.file} → ${localized}（locale=${locale}）`);
    }
    if (!text) return;
    if (mountedAgentPersonas.has(agent.id)) {
      warn(`人格已挂载过（跳过重复）: agent=${agent.id}`);
      return;
    }
    // 在 agent 作用域上下文注册 persona 槽（shadowing，不全局冲突）
    try {
      agent.ctx.systemPrompt.section({
        name: 'deployment:persona',
        order: 0,
        text,
      });
      // 语言指令 section（order 紧贴 persona 之后）：provider 每次 assembly 求值，
      // 读前端上报的 aemeath-ui.locale —— 前端切语言后无需重挂 agent，下一条回复即生效。
      // 未上报（''）时 section 文本为空，renderPrompt 会丢弃空 section，不影响 prompt。
      agent.ctx.systemPrompt.section({
        name: 'aemeath:language',
        order: 1,
        text: () => languageDirective(uiLocale(agent.ctx)),
      });
      const uiLoc = uiLocale(agent.ctx);
      log(`语言指令已挂载 → agent=${agent.id} locale=${uiLoc || '(未上报，不注入)'}`);
      mountedAgentPersonas.add(agent.id);
      log(`人格已挂载 → preset=${preset} agent=${agent.id}（${text.length} 字符）`);
    } catch (e) {
      warn(`人格挂载失败（agent=${agent.id} preset=${preset}）: ${(e as Error).message}`);
    }
  };

  // 先补挂已存在的 agents（插件启动晚于 agent-loop，会错过 agent/created）
  for (const agent of ctx.agents.list()) mountPersona(agent);
  log(`现存 agents: ${ctx.agents.list().map((a) => a.id).join(', ') || '(无)'}`);
  ctx.on('agent/created', ({ agent }) => mountPersona(agent));

  // ---- 3) OOC 规则层（agent/pre-step） ----
  const steeredTurns = new Map<string, number>();
  // 第三关：steeredTurns 防无界增长（长跑会话/多 agent 累积），超上限淘汰最旧
  const STEERED_MAX = 2000;
  const trimSteered = (): void => {
    while (steeredTurns.size > STEERED_MAX) {
      const oldest = steeredTurns.keys().next().value;
      if (oldest === undefined) break;
      steeredTurns.delete(oldest);
    }
  };

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    if (!runtime.oocRulesEnabled) return decision;

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
    trimSteered();

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
  if (oocLlm.enabled || runtime.oocLlmEnabled) {
    ctx.on('session/event', async (session, event) => {
      try {
        if (!runtime.oocLlmEnabled) return;
        if (event.type !== 'assistant/message') return;
        const preset = resolveSessionPreset(session as never) ?? config.defaultPreset;
        if (!preset) return;
        const text = (event.data.message?.content ?? [])
          .map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : ''))
          .join('')
          .trim();
        if (!text) return;
        const personaName = preset === 'aemeath' ? '爱弥斯（桌宠，活泼俏皮，不讲物理公式）' : 'physicist（物理学霸，严谨专业，不卖萌）';
        let apiKey = oocLlm.apiKey;
        if (!apiKey) {
          try {
            apiKey = (await ctx.credentials?.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value ?? '';
          } catch {
            apiKey = '';
          }
        }
        if (!apiKey) return; // 无可用凭据：判定层静默跳过
        // 每回合最多判定一次（与规则层同款去重，防反复 steer / 重复扣费）
        const llmTurnKey = `${session.id}:${(event.data as { turn?: number }).turn ?? 0}`;
        if (steeredTurns.get(llmTurnKey)) return;
        steeredTurns.set(llmTurnKey, 1);
        trimSteered();
        const resp = await fetch(`${oocLlm.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
