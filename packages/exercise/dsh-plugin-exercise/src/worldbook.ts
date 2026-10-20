// ============================================================
// worldbook.ts — 错题/经验 → physicist 世界书条目
//
// 用户要求：错题和经验要"汇总整合给主 agent 的 worldbook 和错题合集"。
//
// 两条腿（刻意分开）：
//   ① **本地错题本**（store 的 `_mistakes.json`）：完整、可复习、可编辑，
//      是"我的错题"这件事的权威数据。
//   ② **世界书条目**（本文件）：只放**可复用的一句话教训**，进 knowledge 注入，
//      让主 agent 在讲同类题时能主动提起"你上次在这里栽过"。
//      世界书注入预算只有 3000 token，所以条目必须短（≤ ~300 字）——
//      把整套错题塞进去等于把注入预算烧光。
//
// 为什么写独立文件 `generated_exercise.json` 而不是追加到 memory 的
// `generated_knowledge.json`：
//   · 两个插件各写各的文件，避免读-改-写竞争（memory 每次写都全量覆盖）
//   · worldbook 插件按目录扫全部 *.json（`loadLibrary`），文件名不影响加载
//   · 想整体清空"习题沉淀的知识"时，删一个文件即可，不碰记忆生成的知识
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { Lesson, Mistake, Sheet } from './types.js';

export const WORLDBOOK_FILE = 'generated_exercise.json';

/** 世界书条目（与 packages/worldbook/data/*.json 的字段一致）。 */
export interface WorldbookEntry {
  id: string;
  title: string;
  kind: 'knowledge';
  triggers: string[];
  constant: boolean;
  intrinsic_value: number;
  priority: number;
  chain: string[];
  content: string;
  source: string;
  exam_points?: string;
  verifiable: boolean;
}

/**
 * 触发词：topic + 拉丁词 + 中文 bigram（与 memory 的 buildWorldbookTriggers 同款）。
 * 为什么不用 NLP：worldbook 匹配是**子串/词表**式的，bigram 对中文已经够用，
 * 加依赖不值。
 */
export function buildTriggers(content: string, topic: string, tags: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const t of tags) if (t.trim().length >= 2) out.add(t.trim());
  if (topic && topic.length >= 2) out.add(topic);
  for (const m of content.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) out.add(m);
  const cjk = (content || '').replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2));
  // 限制数量：太多触发词会把无关对话也命中（worldbook 是每轮匹配）
  return [...out].slice(0, 8);
}

/** 条目 id 由内容决定（同一条教训重复写 → 幂等）。 */
export function entryIdOf(content: string): string {
  return `ex_${createHash('sha1').update(content, 'utf-8').digest('hex').slice(0, 10)}`;
}

export interface EntryInput {
  content: string;
  title: string;
  tags?: string[];
  source?: string;
  priority?: number;
  intrinsicValue?: number;
  topic?: string;
}

/** 组装一条世界书条目（纯函数）。 */
export function buildWorldbookEntry(input: EntryInput): WorldbookEntry {
  const content = input.content.trim();
  return {
    id: entryIdOf(content),
    title: (input.title || '习题教训').slice(0, 60),
    kind: 'knowledge',
    triggers: buildTriggers(content, input.topic ?? input.title, input.tags ?? []),
    constant: false,
    intrinsic_value: input.intrinsicValue ?? 70,
    // 与 memory 生成条目（priority 1）区分：习题教训应优先于泛化知识注入
    priority: input.priority ?? 60,
    chain: [],
    content: content.slice(0, 600),
    source: input.source ?? 'Übungsblatt 错题沉淀',
    verifiable: false,
  };
}

/** 一条错题 → 一条教训条目。没有 lesson 内容时用 issues 兜底（但不编造）。 */
export function mistakeToEntry(m: Mistake): WorldbookEntry | null {
  const lesson = (m.lesson || '').trim();
  const issues = (m.issues ?? []).map((i) => i.trim()).filter(Boolean).slice(0, 3);
  if (!lesson && !issues.length) return null;
  const head = `【错题】${m.course_title || m.course_id} · ${m.sheet_title || m.sheet_id} · ${m.problem_label || m.problem_id}`;
  const body = [
    head,
    lesson ? `教训：${lesson}` : '',
    issues.length ? `当时的问题：${issues.join('；')}` : '',
    m.tags.length ? `主题：${m.tags.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return buildWorldbookEntry({
    content: body,
    title: `${m.problem_label || '习题'} 错题教训`.slice(0, 60),
    tags: m.tags,
    source: `Übungsblatt 错题（${m.course_id}/${m.sheet_id}/${m.problem_id}）`,
    priority: 70,
    topic: m.problem_label,
  });
}

/** 一条经验 → 一条条目。 */
export function lessonToEntry(courseTitle: string, sheet: Sheet, lesson: Lesson): WorldbookEntry | null {
  const text = (lesson.text || '').trim();
  if (!text) return null;
  const body = `【习题经验】${courseTitle} · Übungsblatt ${sheet.number}${sheet.title ? `（${sheet.title}）` : ''}\n${text}`;
  return buildWorldbookEntry({
    content: body,
    title: `Blatt ${sheet.number} 经验`.slice(0, 60),
    tags: lesson.tags,
    source: `Übungsblatt 经验（${courseTitle} / ${sheet.id}）`,
    priority: 55,
    topic: sheet.title || `Übungsblatt ${sheet.number}`,
  });
}

export interface WorldbookWriteResult {
  ok: boolean;
  id?: string;
  created?: boolean;
  error?: string;
}

/**
 * 把条目写进馆目录（数组追加 + id 去重 + 原子重写整文件）。
 *
 * 为什么不 append 一行：JSON 数组必须以 `]` 结尾，追加行会写坏文件；
 * 而"读-改-写"在单进程里没有并发（本插件是唯一写者），可以接受。
 */
export function appendWorldbookEntry(libraryDir: string, entry: WorldbookEntry): WorldbookWriteResult {
  try {
    const dir = isAbsolute(libraryDir) ? libraryDir : join(process.cwd(), libraryDir);
    // 馆目录不存在 = 这个 profile 没挂 worldbook（或路径配错）→ 明确报错，不自己造目录：
    // 自己造一个空馆会让"写成功了"变成假象（worldbook 插件根本不看这个路径）。
    if (!existsSync(dir)) return { ok: false, error: `馆目录不存在: ${dir}` };
    const file = join(dir, WORLDBOOK_FILE);
    let entries: WorldbookEntry[] = [];
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf-8');
      try {
        const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown;
        if (Array.isArray(parsed)) entries = parsed as WorldbookEntry[];
      } catch {
        // 坏文件：不覆盖（那可能是用户手改坏了，覆盖会丢他自己的内容）
        return { ok: false, error: `世界书文件不可解析，已跳过写入: ${file}` };
      }
    }
    if (entries.some((e) => e.id === entry.id)) return { ok: true, id: entry.id, created: false };
    entries.push(entry);
    writeFileSync(file, JSON.stringify(entries, null, 2), 'utf-8');
    return { ok: true, id: entry.id, created: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 批量写；返回每条结果（UI 要显示"写了几条/哪条失败"）。 */
export function appendWorldbookEntries(
  libraryDir: string,
  entries: readonly WorldbookEntry[],
): { written: number; skipped: number; failed: number; errors: string[] } {
  let written = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const e of entries) {
    const r = appendWorldbookEntry(libraryDir, e);
    if (!r.ok) {
      failed++;
      if (r.error) errors.push(r.error);
    } else if (r.created) written++;
    else skipped++;
  }
  return { written, skipped, failed, errors };
}
