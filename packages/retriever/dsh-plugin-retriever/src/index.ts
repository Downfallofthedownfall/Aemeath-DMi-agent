// ============================================================
// dsh-plugin-retriever · 讲义检索插件（M4 v1）
// 职责：
//   1. 讲义分块（chunker.ts，按 ## 二级标题，≤2000 字符/块）
//   2. SQLite FTS5 索引（node:sqlite 原生 bm25() 排序，D4 落地）
//   3. scholar 注入：query>8 字或含物理术语 → top-3 块注入 "## Lecture Notes"（≤1500 token）
//   4. 无讲义时优雅降级（目录空 → 不注入，日志提示）
// 注：内容轨——library/scholar/notes/ 由用户后续填充真实讲义；世界书触发优先的联动优化留待 v2。
// ============================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import type {} from '@deepseek-ai/dsh-agent';
import { chunkText, type NoteChunk } from './chunker.js';

export const name = 'aemeath-retriever';
export const inject = [];

export const Config = z.object({
  defaultPreset: z.string(),
  notesDir: z.string(),
  maxInjectTokens: z.number(),
});

export interface RetrieverConfig {
  defaultPreset?: string;
  notesDir?: string;
  maxInjectTokens?: number;
}

function log(msg: string): void {
  console.log(`[aemeath-retriever] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[aemeath-retriever] ⚠ ${msg}`);
}

/** 中文 bigram 化（"牛顿第二定律" → "牛顿 顿第 第二 二定 定律"）。 */
function bigramize(cjk: string): string {
  const grams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i++) grams.push(cjk.slice(i, i + 2));
  return grams.join(' ');
}

/** 可索引文本：中文转 bigram + 英文/数字保留（供 FTS5 unicode61 检索中文子串）。 */
function toIndexable(text: string): string {
  let out = '';
  let buf = '';
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      buf += ch;
      continue;
    }
    if (buf) {
      out += bigramize(buf) + ' ';
      buf = '';
    }
    if (/[a-zA-Z0-9]/.test(ch)) out += ch.toLowerCase();
    else out += ' ';
  }
  if (buf) out += bigramize(buf);
  return out;
}

/** FTS5 MATCH 查询：bigram 化后按词 OR 组合（中文短词召回）。 */
function escapeFtsQuery(query: string): string {
  const terms = toIndexable(query)
    .split(/\s+/)
    .map((t) => t.trim().replace(/"/g, ''))
    .filter((t) => t.length > 0);
  if (!terms.length) return '';
  return terms.map((t) => `"${t}"`).join(' OR ');
}

/** 物理/数学术语触发模式（scholar 注入条件之一）。 */
const PHYSICS_TERM = /F\s*=\s*ma|牛顿|能量|动量|热力学|电磁|量子|波动|干涉|衍射|光|力学|统计|微分|积分|矩阵|特征值|熵|温度|压强|力|质量|速度|加速度|角动量|力矩|功|薛定谔|麦克斯韦|拉格朗日|哈密顿|简谐|谐振|电容|电感|磁场|电场|相对论|热容/i;

export function apply(ctx: Context, config: RetrieverConfig): void {
  const maxTokens = config.maxInjectTokens ?? 1500;
  const notesDir = isAbsolute(config.notesDir ?? '') ? config.notesDir! : join(process.cwd(), config.notesDir ?? 'packages/library/scholar/notes');

  // ---- 构建 FTS5 索引（内存库，启动重建；讲义量小，足够） ----
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE notes USING fts5(id, file, section, content, idx)');
  const insert = db.prepare('INSERT INTO notes (id, file, section, content, idx) VALUES (?, ?, ?, ?, ?)');

  let chunkCount = 0;
  const rebuild = (): void => {
    db.exec('DELETE FROM notes');
    chunkCount = 0;
    if (!existsSync(notesDir)) {
      warn(`讲义目录不存在: ${notesDir}（内容轨待填充，检索停用）`);
      return;
    }
    for (const f of readdirSync(notesDir).filter((x) => x.endsWith('.txt') || x.endsWith('.md')).sort()) {
      const path = join(notesDir, f);
      try {
        const raw = readFileSync(path, 'utf-8');
        const chunks = chunkText(f, raw);
        for (const c of chunks) {
          insert.run(c.id, c.file, c.section, c.content, toIndexable(c.content));
          chunkCount++;
        }
      } catch (e) {
        warn(`讲义加载失败 ${f}: ${(e as Error).message}`);
      }
    }
    log(`讲义索引构建完成：${chunkCount} 块`);
  };
  rebuild();

  // 热重建：讲义文件 mtime 变化时重建（轻量轮询，与 worldbook 一致）
  const fileMtimes = new Map<string, number>();
  const scanMtimes = (): boolean => {
    let changed = false;
    const current = new Map<string, number>();
    if (existsSync(notesDir)) {
      for (const f of readdirSync(notesDir).filter((x) => x.endsWith('.txt') || x.endsWith('.md'))) {
        try {
          current.set(f, statSync(join(notesDir, f)).mtimeMs);
        } catch { /* ignore */ }
      }
    }
    if (current.size !== fileMtimes.size) changed = true;
    else for (const [f, mt] of current) if (Math.abs((fileMtimes.get(f) ?? 0) - mt) > 1e-6) changed = true;
    if (changed) {
      fileMtimes.clear();
      for (const [f, mt] of current) fileMtimes.set(f, mt);
      rebuild();
    }
    return changed;
  };
  const reloadTimer = setInterval(scanMtimes, 5000);
  if (reloadTimer.unref) reloadTimer.unref();

  // ---- scholar 注入（agent/pre-step） ----
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;

    const preset = resolveSessionPreset(payload.agent.session as never) ?? config.defaultPreset;
    log(`[dbg] pre-step agent=${payload.agent.id.slice(0, 8)} preset=${preset} msgs=${decision.messages.length}`);
    if (preset !== 'scholar') return decision;

    // 取进入 step 的用户原始文本（跳过插件注入消息，如 worldbook/recall）
    let query = '';
    for (let i = decision.messages.length - 1; i >= 0; i--) {
      const m = decision.messages[i] as { role?: string; source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] };
      if (m.role === 'user' && m.source?.kind === 'user') {
        query = (m.content ?? [])
          .map((b) => (b.type === 'text' ? b.text ?? '' : ''))
          .join('')
          .trim();
        break;
      }
    }
    if (!query) return decision;
    // 注入条件：query>8 字 或 含物理术语
    if (query.length <= 8 && !PHYSICS_TERM.test(query)) return decision;
    log(`[dbg] query="${query.slice(0, 30)}" len=${query.length}`);

    const rows = db
      .prepare('SELECT id, file, section, content FROM notes WHERE notes MATCH ? ORDER BY bm25(notes) LIMIT 3')
      .all(escapeFtsQuery(query)) as Array<{ id: string; file: string; section: string; content: string }>;
    if (!rows.length) return decision;
    const parts: string[] = [];
    let used = 0;
    for (const r of rows) {
      const text = `【${r.file} › ${r.section}】\n${r.content}`;
      const approx = text.length;
      if (parts.length && used + approx > maxTokens) break;
      parts.push(text);
      used += approx;
    }
    if (!parts.length) return decision;

    const block = `## Lecture Notes\n${parts.join('\n\n')}`;
    log(`preset=scholar 讲义注入 ${block.length} 字符（≤${maxTokens} tokens 预算）`);
    const injectMsg = createUserMessage({
      content: [{ type: 'text', text: block }],
      source: { kind: 'plugin', plugin: name, form: 'catalog' },
    });
    return { kind: 'enter', messages: [...decision.messages, injectMsg] };
  });
  log('讲义注入已挂载（agent/pre-step，scholar 模式）');
}
