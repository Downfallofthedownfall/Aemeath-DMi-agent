// ============================================================
// import-handoff.ts — 接收侧（在主 agent 上跑）
//
// 与 lecture 的接收侧同一套纪律（docs/lecture-mode-plan.md §7）：
//   · **绝不**直接 ctx.memory.save() —— 它要求"守门员已判定后调用"，
//     直接调会绕过 BM25 查重 / typed 冲突 / user_fact 写门
//   · 本模块自己跑 decide() / writeGate()，把判定结果一并交给 save()
//   · 缺省 dry_run（先给人看会写什么）
//
// 习题比 lecture 多一步：**经验/错题教训要写进 worldbook**。
//   lecture 的产物是课程进度与短板；习题的产物是"这道题教会我什么"，
//   它的正确归宿是世界书（主 agent 讲同类题时会主动提起），而不是又一条记忆。
//
// 为什么自己定义 Gatekeeper 接口而不 import lecture 的：
//   lecture 的 package.json exports 里没有 `./import-handoff`（那是内部模块）。
//   与其为了一个类型去 import 别人的 src（会把对方的实现拖进编译），
//   不如在这里写一份**结构相同**的窄接口 —— 运行时由 index.ts 注入 memory 的实现。
// ============================================================

import { existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  buildWorldbookEntry,
  appendWorldbookEntries,
  type WorldbookEntry,
  type WorldbookWriteResult,
} from './worldbook.js';
import { readExerciseHandoff, type ExerciseHandoff } from './handoff.js';

// ============================================================
// 窄接口（由主 agent 侧注入；与 lecture 的 HandoffGatekeeper 结构一致）
// ============================================================

export interface GateDecision {
  kind: 'save' | 'knowledge_direct' | 'skip' | 'blocked';
  content: string;
  category: 'user_fact' | 'study_log' | 'preference' | 'relationship' | 'session_summary';
  importance: number;
  topic?: string;
}

export interface WriteGateResult {
  action: 'accept' | 'demote' | 'drop';
  reason: string;
  confidence?: number;
}

export interface ExerciseGatekeeper {
  decide(query: string, reply: string): GateDecision;
  writeGate(query: string, content: string): WriteGateResult;
  save(input: {
    preset: string;
    content: string;
    category: GateDecision['category'];
    importance: number;
    confidence: number;
    scope: 'mode' | 'global';
    sourceMode: string;
    sourceExercise?: { course: string; sheet: string; problem?: string };
    entityClaims?: Array<{ entity: string; attribute: string; value: string; valid_from: number; valid_until: number | null }>;
  }): Promise<string>;
  /** 知识层（让记忆面板看得到"习题沉淀的知识"）。 */
  knowledgeAdd?(input: { preset: string; content: string; topic: string; sourceSession: string }): Promise<string>;
  log(msg: string): void;
  warn(msg: string): void;
}

export interface ImportExerciseOptions {
  preset?: string;
  dryRun?: boolean;
  sessionId?: string;
  /**
   * worldbook 馆目录（相对仓库根或绝对）。传了就写条目；不传 = 只导记忆。
   * mac 上没有主 agent 的馆目录，所以这一步只在 Windows 侧生效。
   */
  worldbookDir?: string;
}

export interface ExerciseImportOutcome {
  course: string;
  memoriesWritten: number;
  claimsWritten: number;
  worldbookWritten: number;
  worldbookSkipped: number;
  dropped: number;
  details: Array<{ kind: string; content: string; reason: string }>;
}

/** 把错题/经验转成待写的世界书条目（纯函数，便于 dry_run 预览与单测）。 */
export function handoffWorldbookEntries(h: ExerciseHandoff): WorldbookEntry[] {
  const out: WorldbookEntry[] = [];
  for (const m of h.mistakes) {
    if (m.mastered) continue; // 已掌握的不再反复注入
    const text = (m.lesson || m.issues.join('；') || '').trim();
    if (!text) continue;
    out.push(
      buildWorldbookEntry({
        content: [
          `【错题】${h.course.title} · ${m.sheet} · ${m.label || m.problem}`,
          m.lesson ? `教训：${m.lesson}` : `当时的问题：${m.issues.join('；')}`,
          m.tags.length ? `主题：${m.tags.join('、')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        title: `${m.label || '习题'} 错题教训`.slice(0, 60),
        tags: m.tags,
        source: `Übungsblatt 错题（${h.course.id}/${m.sheet}/${m.problem}）`,
        priority: 70,
      }),
    );
  }
  for (const l of h.lessons) {
    if (!l.text.trim()) continue;
    out.push(
      buildWorldbookEntry({
        content: `【习题经验】${h.course.title} · ${l.sheet}\n${l.text.trim()}`,
        title: `${l.sheet} 经验`.slice(0, 60),
        tags: l.tags,
        source: `Übungsblatt 经验（${h.course.id}/${l.sheet}）`,
        priority: 55,
      }),
    );
  }
  return out;
}

/**
 * 导入一个习题握手包。
 *
 * 写入策略（保守）：
 *   · `weak_points` → 记忆（study_log / user_fact，过守门员）——只处理**已提交**的套
 *   · `claims`      → 按套聚合成一条记忆 + 结构化断言（T1 时间轴）
 *   · `lessons`     → worldbook（+ 知识层，如果注入了 knowledgeAdd）
 *   · `mistakes`    → worldbook 里只写"未掌握且有教训"的；已掌握的跳过
 */
export async function importExerciseHandoff(
  handoff: ExerciseHandoff,
  gk: ExerciseGatekeeper,
  opts: ImportExerciseOptions = {},
): Promise<ExerciseImportOutcome> {
  const preset = opts.preset ?? 'physicist';
  const dryRun = opts.dryRun ?? false;
  const sessionId = opts.sessionId ?? `exercise-${handoff.course.id}`;
  const out: ExerciseImportOutcome = {
    course: handoff.course.id,
    memoriesWritten: 0,
    claimsWritten: 0,
    worldbookWritten: 0,
    worldbookSkipped: 0,
    dropped: 0,
    details: [],
  };

  const submitted = new Set(handoff.progress.filter((p) => p.reviewed).map((p) => p.unit));

  // ── 1) 短板 → 记忆 ──
  for (const wp of handoff.weak_points) {
    if (!submitted.has(wp.unit)) {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: '该套未提交，跳过' });
      continue;
    }
    // decide 的语义是"一轮对话"：待判陈述放 query 位、reply 传空串（同 lecture 的注释）
    const statement = `练习短板：${wp.topic}。这是需要加强的地方。`;
    const decision = gk.decide(statement, '');
    if (decision.kind === 'skip' || decision.kind === 'blocked') {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: `守门员判定 ${decision.kind}` });
      continue;
    }
    let confidence = 0.7;
    let importance = decision.importance;
    if (decision.category === 'user_fact') {
      const wg = gk.writeGate(statement, decision.content);
      if (wg.action === 'drop') {
        out.dropped++;
        out.details.push({ kind: 'weak_point', content: wp.topic, reason: `写门拦截：${wg.reason}` });
        continue;
      }
      if (wg.action === 'demote') {
        confidence = wg.confidence ?? 0.55;
        importance = Math.max(0, importance - 20);
      }
    }
    if (dryRun) {
      out.memoriesWritten++;
      out.details.push({ kind: 'weak_point', content: decision.content, reason: `[试运行] 将写入（${decision.category}）` });
      continue;
    }
    try {
      await gk.save({
        preset,
        content: decision.content,
        category: decision.category,
        importance,
        confidence,
        scope: 'mode',
        sourceMode: 'exercise',
        sourceExercise: { course: handoff.course.id, sheet: wp.unit },
      });
      out.memoriesWritten++;
      out.details.push({ kind: 'weak_point', content: decision.content, reason: `已写入（${decision.category}）` });
    } catch (e) {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: `写入失败：${(e as Error).message}` });
    }
  }

  // ── 2) 进度断言 → 记忆（按套聚合） ──
  const byUnit = new Map<string, ExerciseHandoff['claims']>();
  for (const c of handoff.claims ?? []) {
    if (!submitted.has(c.unit)) {
      out.dropped++;
      out.details.push({ kind: 'claim', content: `${c.attribute}=${c.value}`, reason: '该套未提交，跳过' });
      continue;
    }
    const list = byUnit.get(c.unit) ?? [];
    list.push(c);
    byUnit.set(c.unit, list);
  }
  for (const [unitId, list] of byUnit) {
    const content = `习题进度：${list.map((c) => `${c.attribute} = ${c.value}`).join('；')}`;
    const decision = gk.decide(content, '');
    if (decision.kind === 'skip' || decision.kind === 'blocked') {
      out.dropped++;
      out.details.push({ kind: 'claim', content, reason: `守门员判定 ${decision.kind}` });
      continue;
    }
    let confidence = 0.75;
    let importance = decision.importance;
    if (decision.category === 'user_fact') {
      const wg = gk.writeGate(content, decision.content);
      if (wg.action === 'drop') {
        out.dropped++;
        out.details.push({ kind: 'claim', content, reason: `写门拦截：${wg.reason}` });
        continue;
      }
      if (wg.action === 'demote') {
        confidence = wg.confidence ?? 0.55;
        importance = Math.max(0, importance - 20);
      }
    }
    const now = Date.now();
    const entityClaims = list.map((c) => ({
      entity: c.entity || '用户',
      attribute: c.attribute,
      value: c.value,
      valid_from: now,
      valid_until: null,
    }));
    if (dryRun) {
      out.memoriesWritten++;
      out.claimsWritten += entityClaims.length;
      out.details.push({ kind: 'claim', content: decision.content, reason: `[试运行] 将写入（含 ${entityClaims.length} 条断言）` });
      continue;
    }
    try {
      await gk.save({
        preset,
        content: decision.content,
        category: decision.category,
        importance,
        confidence,
        scope: 'mode',
        sourceMode: 'exercise',
        sourceExercise: { course: handoff.course.id, sheet: unitId },
        entityClaims,
      });
      out.memoriesWritten++;
      out.claimsWritten += entityClaims.length;
      out.details.push({ kind: 'claim', content: decision.content, reason: `已写入（含 ${entityClaims.length} 条断言）` });
    } catch (e) {
      out.dropped++;
      out.details.push({ kind: 'claim', content, reason: `写入失败：${(e as Error).message}` });
    }
  }

  // ── 3) 经验/错题教训 → worldbook（本模块与 lecture 接收侧的主要差异） ──
  const entries = handoffWorldbookEntries(handoff);
  if (!entries.length) {
    out.details.push({ kind: 'worldbook', content: '', reason: '没有可写的经验/教训条目' });
  } else if (!opts.worldbookDir) {
    out.details.push({
      kind: 'worldbook',
      content: `${entries.length} 条`,
      reason: '未配置 worldbook 馆目录 —— 跳过（在 mac 上属正常；到 Windows 侧再导一次即可）',
    });
  } else if (dryRun) {
    for (const e of entries) {
      out.details.push({ kind: 'worldbook', content: e.title, reason: `[试运行] 将写入世界书（${e.id}）` });
    }
    out.worldbookWritten += entries.length;
  } else {
    const r = appendWorldbookEntries(opts.worldbookDir, entries);
    out.worldbookWritten += r.written;
    out.worldbookSkipped += r.skipped;
    if (r.failed) {
      out.dropped += r.failed;
      for (const err of r.errors) out.details.push({ kind: 'worldbook', content: '', reason: `写入失败：${err}` });
    }
    out.details.push({
      kind: 'worldbook',
      content: `${entries.length} 条`,
      reason: `写入 ${r.written} 条（已存在跳过 ${r.skipped} 条，失败 ${r.failed} 条）`,
    });
    // 顺带进知识层（让记忆面板/知识审核能看到），失败不影响主流程
    if (r.written && gk.knowledgeAdd) {
      for (const e of entries) {
        try {
          await gk.knowledgeAdd({ preset, content: e.content, topic: e.title, sourceSession: sessionId });
        } catch (err) {
          gk.warn(`知识层写入失败（${e.title}）：${(err as Error).message}`);
        }
      }
    }
  }

  return out;
}

/** 扫描目录下的习题握手包（`*-exercise-handoff.json`）。 */
export function findExerciseHandoffFiles(dir: string): string[] {
  const abs = isAbsolute(dir) ? dir : join(process.cwd(), dir);
  if (!existsSync(abs)) return [];
  try {
    return readdirSync(abs)
      .filter((f) => f.endsWith('-exercise-handoff.json'))
      .map((f) => join(abs, f))
      .sort();
  } catch {
    return [];
  }
}

/** 读一个文件（畸形 → null）。 */
export function loadExerciseHandoff(file: string): ExerciseHandoff | null {
  return readExerciseHandoff(file);
}

/** 导入结果可读摘要。 */
export function describeExerciseOutcome(o: ExerciseImportOutcome): string {
  return [
    `课程：${o.course}`,
    `记忆 ${o.memoriesWritten} 条（含 ${o.claimsWritten} 条断言）· 世界书 ${o.worldbookWritten} 条（跳过 ${o.worldbookSkipped}）· 丢弃 ${o.dropped} 条`,
    ...o.details.map((d) => `  · [${d.kind}] ${d.content || '—'} — ${d.reason}`),
  ].join('\n');
}
