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
//   ⚠️ 结构相同意味着**判定的形状也要照 memory 的真实返回写**：`decide()` 有
//   pending / knowledge_direct，它们**没有** content / category（见 resolveWritable）。
// ============================================================

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import {
  applyWorldbookChanges,
  entryInScope,
  lessonToEntry,
  mistakeRef,
  mistakeToEntry,
  type WorldbookEntry,
} from './worldbook.js';
import { readExerciseHandoff, type ExerciseHandoff } from './handoff.js';
import { withFileLockSync, writeFileAtomicSync } from './store.js';
import { tr } from './locale.js';

// ============================================================
// 窄接口（由主 agent 侧注入；与 memory 的 decide() 返回值结构一致）
// ============================================================

/** memory 接受的记忆分类。 */
export type WriteCategory = 'user_fact' | 'study_log' | 'preference' | 'relationship' | 'session_summary';
const WRITE_CATEGORIES: readonly WriteCategory[] = ['user_fact', 'study_log', 'preference', 'relationship', 'session_summary'];

/**
 * memory 守门员 `decide()` 的返回。
 *
 * 只有 `save` 带 category/importance；`knowledge_direct` 带 content/topic；
 * `pending` / `skip` / `blocked` 只有 reason。字段一律可选 —— 早先这里写成"必有"，
 * pending 一路走到 `save({ content: undefined })`（见 resolveWritable）。
 */
export interface GateDecision {
  kind: 'save' | 'knowledge_direct' | 'skip' | 'blocked' | 'pending';
  content?: string;
  category?: WriteCategory;
  importance?: number;
  topic?: string;
  reason?: string;
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
    category: WriteCategory;
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

/**
 * 把 `decide()` 的结果规整成"确实可以写入的东西"（与 lecture 的同名函数同一套规则）。
 *
 * ⚠️ 为什么必须有这一步（lecture 真机事故，exercise 曾漏掉同一个修复）：
 *   `pending` 的返回是 `{ kind: 'pending', reason }` —— 没有 content / category / importance。
 *   只排除 skip / blocked 的话，pending 会把 undefined 写进 memories 表；
 *   之后记忆域因 schema 不符**整个打不开**，memory 插件 apply 失败，所有导入都静默降级成试运行。
 *   习题握手的陈述（"练习短板：…"）几乎全被判成 pending，所以这里不是边角情况。
 *
 *   · skip / blocked        → null（不写）
 *   · pending               → 用调用方手上的原文 + study_log 兜底写入
 *                             （pending 的意思是"交 L1/LLM 决定"，导入场景没有那条链路）
 *   · knowledge_direct      → 同样按 study_log 写成记忆：短板是"关于用户的事"，
 *                             只是句子里带了"角动量守恒"这类物理词才被规则判成知识；
 *                             进知识层会变成一条"练习短板：…"的伪知识
 *   · save                  → 用 decide 给的 content / category / importance
 *
 * @returns null 表示不写；否则给出非空 content 与合法 category
 */
export function resolveWritable(
  decision: GateDecision,
  fallbackContent: string,
  fallbackCategory: WriteCategory = 'study_log',
): { content: string; category: WriteCategory; importance: number } | null {
  if (decision.kind === 'skip' || decision.kind === 'blocked') return null;
  const content = (decision.content ?? '').trim() || fallbackContent.trim();
  // 兜底文本也是空 → 宁可丢，也不写空记录（空记录会再次毒化存储）
  if (!content) return null;
  const raw = decision.kind === 'save' ? decision.category : undefined;
  const category: WriteCategory = raw && WRITE_CATEGORIES.includes(raw) ? raw : fallbackCategory;
  // importance 缺失时给中位值；undefined 传下去 memory 会当成 NaN/0
  const importance = typeof decision.importance === 'number' && Number.isFinite(decision.importance) ? decision.importance : 50;
  return { content, category, importance };
}

// ============================================================
// 导入台账：同一条内容只写一次
// ============================================================

/**
 * 记录"哪些内容已经写进过主记忆 / 知识层"。
 *
 * 为什么：memory.save 每次都生成新 id，握手文件导入后又留在目录里 ——
 * 早先每点一次「导入握手」就把全部短板/进度再写一遍。
 * 按 (种类, preset, 内容) 记一笔；内容变了（教训改了、进度更新了）才会再写。
 * 用户在记忆面板里删掉的记忆不会被下一次导入"复活"。
 */
export interface ImportLedger {
  has(key: string): boolean;
  add(key: string, value: string): void;
}

export function ledgerKey(kind: string, preset: string, content: string): string {
  return createHash('sha1').update(`${kind}\n${preset}\n${content}`, 'utf-8').digest('hex');
}

/**
 * 文件台账（JSON 对象：key → { id, at }）。每次 add 都落盘（跨进程锁 + 原子写）。
 *
 * `has()` 按文件 mtime 判断要不要重读：主 profile 与独立 profile 共用数据目录，
 * 只认启动时读进来的那份的话，另一个进程后来导入的内容这边看不到，会再写一遍。
 */
export function fileLedger(file: string): ImportLedger {
  const abs = isAbsolute(file) ? file : join(process.cwd(), file);
  const read = (): Record<string, { id: string; at: number }> => {
    if (!existsSync(abs)) return {};
    try {
      const raw = readFileSync(abs, 'utf-8');
      const data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown;
      return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, { id: string; at: number }>) : {};
    } catch {
      return {};
    }
  };
  const mtimeOf = (): number => {
    try {
      return statSync(abs).mtimeMs;
    } catch {
      return 0;
    }
  };
  let cache = read();
  let cachedAt = mtimeOf();
  const fresh = (): Record<string, { id: string; at: number }> => {
    const m = mtimeOf();
    if (m !== cachedAt) {
      cache = read();
      cachedAt = m;
    }
    return cache;
  };
  return {
    has: (key) => Object.prototype.hasOwnProperty.call(fresh(), key),
    add: (key, value) => {
      withFileLockSync(abs, () => {
        cache = { ...read(), [key]: { id: value, at: Date.now() } };
        writeFileAtomicSync(abs, JSON.stringify(cache, null, 2));
        cachedAt = mtimeOf();
      });
    },
  };
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
  /** 导入台账（不传 = 不去重，测试/一次性导入用）。 */
  ledger?: ImportLedger;
}

export interface ExerciseImportOutcome {
  course: string;
  memoriesWritten: number;
  claimsWritten: number;
  /** 以前导入过、这次跳过的记忆条数 */
  alreadyImported: number;
  /** 新增 + 内容更新的世界书条目 */
  worldbookWritten: number;
  /** 已存在且内容相同 */
  worldbookSkipped: number;
  /** 撤回的世界书条目（错题已掌握 / 已删除） */
  worldbookRemoved: number;
  dropped: number;
  details: Array<{ kind: string; content: string; reason: string }>;
}

/** 经验没有 id 时（老握手包）按文本生成一个稳定 id。 */
function lessonIdFallback(text: string): string {
  return `t${createHash('sha1').update(text, 'utf-8').digest('hex').slice(0, 8)}`;
}

/**
 * 把错题/经验转成待写的世界书条目（纯函数，便于 dry_run 预览与单测）。
 * 用的是与本地同步**同一套**组装函数，同一道题两条路径写出同一个 ref。
 */
export function handoffWorldbookEntries(h: ExerciseHandoff): WorldbookEntry[] {
  const out: WorldbookEntry[] = [];
  for (const m of h.mistakes) {
    if (m.mastered) continue; // 已掌握的不再反复注入
    const e = mistakeToEntry(
      {
        course_id: h.course.id,
        course_title: h.course.title,
        sheet_id: m.sheet,
        sheet_title: m.sheet_title,
        problem_id: m.problem,
        problem_label: m.label,
        lesson: m.lesson,
        issues: m.issues,
        tags: m.tags,
      },
      'handoff',
    );
    if (e) out.push(e);
  }
  for (const l of h.lessons) {
    const text = l.text.trim();
    if (!text) continue;
    const e = lessonToEntry(
      {
        courseId: h.course.id,
        courseTitle: h.course.title,
        sheet: { id: l.sheet, number: l.sheet_number || undefined, title: l.sheet_title },
        lesson: { id: l.id || lessonIdFallback(text), text, tags: l.tags },
      },
      'handoff',
    );
    if (e) out.push(e);
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
 *   · `mistakes`    → worldbook 里只写"未掌握且有教训"的；已掌握的**撤回**
 *   · 握手包是这门课的完整快照：之前由握手导入、这次不在包里的条目也撤回
 */
export async function importExerciseHandoff(
  handoff: ExerciseHandoff,
  gk: ExerciseGatekeeper,
  opts: ImportExerciseOptions = {},
): Promise<ExerciseImportOutcome> {
  const preset = opts.preset ?? 'physicist';
  const dryRun = opts.dryRun ?? false;
  const sessionId = opts.sessionId ?? `exercise-${handoff.course.id}`;
  const ledger = opts.ledger;
  const out: ExerciseImportOutcome = {
    course: handoff.course.id,
    memoriesWritten: 0,
    claimsWritten: 0,
    alreadyImported: 0,
    worldbookWritten: 0,
    worldbookSkipped: 0,
    worldbookRemoved: 0,
    dropped: 0,
    details: [],
  };

  const submitted = new Set(handoff.progress.filter((p) => p.reviewed).map((p) => p.unit));

  /** 过守门员 + 写门；返回 null = 不写（原因已记进 details）。 */
  const gate = (
    kind: string,
    statement: string,
    label: string,
    baseConfidence: number,
  ): { content: string; category: WriteCategory; importance: number; confidence: number } | null => {
    // decide 的语义是"一轮对话"：待判陈述放 query 位、reply 传空串（同 lecture 的注释）
    const decision = gk.decide(statement, '');
    const writable = resolveWritable(decision, statement, 'study_log');
    if (!writable) {
      out.dropped++;
      out.details.push({ kind, content: label, reason: tr(`守门员判定 ${decision.kind}`, `Gatekeeper decision: ${decision.kind}`) });
      return null;
    }
    let confidence = baseConfidence;
    let importance = writable.importance;
    if (writable.category === 'user_fact') {
      const wg = gk.writeGate(statement, writable.content);
      if (wg.action === 'drop') {
        out.dropped++;
        out.details.push({ kind, content: label, reason: tr(`写门拦截：${wg.reason}`, `Write gate blocked: ${wg.reason}`) });
        return null;
      }
      if (wg.action === 'demote') {
        confidence = wg.confidence ?? 0.55;
        importance = Math.max(0, importance - 20);
      }
    }
    return { ...writable, importance, confidence };
  };

  /**
   * 记一笔台账。**和写入本身分开处理**：记忆 / 知识已经写进去了，台账写失败（锁超时等）
   * 不能把这条报成"写入失败"；只提醒一句"下次导入可能重复"。
   */
  const recordImported = (key: string, id: string): void => {
    if (!ledger) return;
    try {
      ledger.add(key, id);
    } catch (e) {
      gk.warn(tr(`导入台账写入失败（下次导入可能重复写这一条）：${(e as Error).message}`, `Import ledger write failed (the next import may write this again): ${(e as Error).message}`));
    }
  };

  /** 台账里已有 → 跳过（试运行也照实说"已导入过"）。 */
  const seenBefore = (kind: string, content: string): boolean => {
    if (!ledger?.has(ledgerKey('memory', preset, content))) return false;
    out.alreadyImported++;
    out.details.push({ kind, content, reason: tr('以前导入过，跳过', 'Imported before — skipped') });
    return true;
  };

  // ── 1) 短板 → 记忆 ──
  for (const wp of handoff.weak_points) {
    if (!submitted.has(wp.unit)) {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: tr('该套未提交，跳过', 'Sheet not submitted — skipped') });
      continue;
    }
    const statement = tr(
      `练习短板：${wp.topic}。这是需要加强的地方。`,
      `Practice weak point: ${wp.topic}. This is something to work on.`,
    );
    const w = gate('weak_point', statement, wp.topic, 0.7);
    if (!w || seenBefore('weak_point', w.content)) continue;
    if (dryRun) {
      out.memoriesWritten++;
      out.details.push({ kind: 'weak_point', content: w.content, reason: tr(`[试运行] 将写入（${w.category}）`, `[dry run] would write (${w.category})`) });
      continue;
    }
    try {
      const id = await gk.save({
        preset,
        content: w.content,
        category: w.category,
        importance: w.importance,
        confidence: w.confidence,
        scope: 'mode',
        sourceMode: 'exercise',
        sourceExercise: { course: handoff.course.id, sheet: wp.unit },
      });
      // 台账写失败不抛（recordImported 只提醒）：记忆已经写进去了，不能报成写入失败
      recordImported(ledgerKey('memory', preset, w.content), id);
      out.memoriesWritten++;
      out.details.push({ kind: 'weak_point', content: w.content, reason: tr(`已写入（${w.category}）`, `Written (${w.category})`) });
    } catch (e) {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: tr(`写入失败：${(e as Error).message}`, `Write failed: ${(e as Error).message}`) });
    }
  }

  // ── 2) 进度断言 → 记忆（按套聚合） ──
  const byUnit = new Map<string, ExerciseHandoff['claims']>();
  for (const c of handoff.claims ?? []) {
    if (!submitted.has(c.unit)) {
      out.dropped++;
      out.details.push({ kind: 'claim', content: `${c.attribute}=${c.value}`, reason: tr('该套未提交，跳过', 'Sheet not submitted — skipped') });
      continue;
    }
    const list = byUnit.get(c.unit) ?? [];
    list.push(c);
    byUnit.set(c.unit, list);
  }
  for (const [unitId, list] of byUnit) {
    const statement = tr(
      `习题进度：${list.map((c) => `${c.attribute} = ${c.value}`).join('；')}`,
      `Exercise progress: ${list.map((c) => `${c.attribute} = ${c.value}`).join('; ')}`,
    );
    const w = gate('claim', statement, statement, 0.75);
    if (!w || seenBefore('claim', w.content)) continue;
    const now = Date.now();
    const entityClaims = list.map((c) => ({
      entity: c.entity || tr('用户', 'User'),
      attribute: c.attribute,
      value: c.value,
      valid_from: now,
      valid_until: null,
    }));
    if (dryRun) {
      out.memoriesWritten++;
      out.claimsWritten += entityClaims.length;
      out.details.push({ kind: 'claim', content: w.content, reason: tr(`[试运行] 将写入（含 ${entityClaims.length} 条断言）`, `[dry run] would write (${entityClaims.length} claims)`) });
      continue;
    }
    try {
      const id = await gk.save({
        preset,
        content: w.content,
        category: w.category,
        importance: w.importance,
        confidence: w.confidence,
        scope: 'mode',
        sourceMode: 'exercise',
        sourceExercise: { course: handoff.course.id, sheet: unitId },
        entityClaims,
      });
      // 台账写失败不抛（recordImported 只提醒）：记忆已经写进去了，不能报成写入失败
      recordImported(ledgerKey('memory', preset, w.content), id);
      out.memoriesWritten++;
      out.claimsWritten += entityClaims.length;
      out.details.push({ kind: 'claim', content: w.content, reason: tr(`已写入（含 ${entityClaims.length} 条断言）`, `Written (${entityClaims.length} claims)`) });
    } catch (e) {
      out.dropped++;
      out.details.push({ kind: 'claim', content: statement, reason: tr(`写入失败：${(e as Error).message}`, `Write failed: ${(e as Error).message}`) });
    }
  }

  // ── 3) 经验/错题教训 → worldbook（本模块与 lecture 接收侧的主要差异） ──
  const entries = handoffWorldbookEntries(handoff);
  // 包里明确"已掌握"的错题：不管条目是谁写的（本地同步 / 上次导入）都撤回
  const retract = new Set(handoff.mistakes.filter((m) => m.mastered).map((m) => mistakeRef(handoff.course.id, m.sheet, m.problem)));
  const courseScope = { courseId: handoff.course.id, courseTitle: handoff.course.title };
  if (!opts.worldbookDir) {
    out.details.push({
      kind: 'worldbook',
      content: tr(`${entries.length} 条`, `${entries.length} entries`),
      reason: tr('未配置 worldbook 馆目录 —— 跳过（在 mac 上属正常；到 Windows 侧再导一次即可）', 'No worldbook library directory configured — skipped (normal on macOS; import again on the Windows side)'),
    });
    return out;
  }
  const r = applyWorldbookChanges(
    opts.worldbookDir,
    {
      upserts: entries,
      remove: (e) => {
        if (e.ref) {
          if (retract.has(e.ref)) return true;
          // 快照语义：上次由握手导入、这次包里没有了（错题删了 / 经验删了）→ 撤回。
          // 本地同步写的条目不动：那是这台机器自己的数据。
          return e.origin === 'handoff' && entryInScope(e, courseScope);
        }
        // 老条目（没有 ref、按内容哈希追加的）：这门课的一律换成带 ref 的新条目
        return entryInScope(e, courseScope);
      },
    },
    { dryRun },
  );
  if (!r.ok) {
    out.dropped += entries.length;
    out.details.push({ kind: 'worldbook', content: '', reason: tr(`写入失败：${r.error ?? ''}`, `Write failed: ${r.error ?? ''}`) });
    return out;
  }
  out.worldbookWritten += r.added.length + r.updated.length;
  out.worldbookSkipped += r.unchanged.length;
  out.worldbookRemoved += r.removed.length;
  if (!entries.length && !r.removed.length) {
    out.details.push({ kind: 'worldbook', content: '', reason: tr('没有可写的经验/教训条目', 'No lessons/mistakes to write') });
  } else if (dryRun) {
    for (const e of r.changed) {
      out.details.push({ kind: 'worldbook', content: e.title, reason: tr(`[试运行] 将写入世界书（${e.id}）`, `[dry run] would write to worldbook (${e.id})`) });
    }
    if (r.removed.length) {
      out.details.push({ kind: 'worldbook', content: tr(`${r.removed.length} 条`, `${r.removed.length} entries`), reason: tr('[试运行] 将从世界书撤回（已掌握 / 已删除）', '[dry run] would retract from worldbook (mastered / deleted)') });
    }
  } else {
    out.details.push({
      kind: 'worldbook',
      content: tr(`${entries.length} 条`, `${entries.length} entries`),
      reason: tr(
        `新增 ${r.added.length} · 更新 ${r.updated.length} · 未变 ${r.unchanged.length} · 撤回 ${r.removed.length}`,
        `Added ${r.added.length} · updated ${r.updated.length} · unchanged ${r.unchanged.length} · retracted ${r.removed.length}`,
      ),
    });
  }

  // 顺带进知识层（让记忆面板/知识审核能看到）：只送**这次新增或改过**的条目，
  // 且按台账去重 —— 早先只要写成一条，就把全部条目再送一遍。失败不影响主流程。
  if (!dryRun && gk.knowledgeAdd) {
    for (const e of r.changed) {
      const key = ledgerKey('knowledge', preset, e.content);
      if (ledger?.has(key)) continue;
      try {
        const id = await gk.knowledgeAdd({ preset, content: e.content, topic: e.title, sourceSession: sessionId });
        recordImported(key, id);
      } catch (err) {
        gk.warn(`知识层写入失败（${e.title}）：${(err as Error).message}`);
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
    tr(`课程：${o.course}`, `Course: ${o.course}`),
    tr(
      `记忆 ${o.memoriesWritten} 条（含 ${o.claimsWritten} 条断言；以前导入过 ${o.alreadyImported} 条）· 世界书 ${o.worldbookWritten} 条（未变 ${o.worldbookSkipped}，撤回 ${o.worldbookRemoved}）· 丢弃 ${o.dropped} 条`,
      `Memory: ${o.memoriesWritten} written (${o.claimsWritten} claims; ${o.alreadyImported} imported before) · Worldbook: ${o.worldbookWritten} (unchanged ${o.worldbookSkipped}, retracted ${o.worldbookRemoved}) · Dropped: ${o.dropped}`,
    ),
    ...o.details.map((d) => `  · [${d.kind}] ${d.content || '—'} — ${d.reason}`),
  ].join('\n');
}
