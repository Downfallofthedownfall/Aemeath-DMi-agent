// ============================================================
// import-handoff.ts — P4 握手接收侧（在主 agent 上跑）
//
// 流程（D7）：
//   lecture（mac）导出 handoff.json → 局域网传文件 → 放学后人工上传
//   → 本模块读文件 → **跑守门员** → 逐条写入主记忆/worldbook
//
// ⚠️ 绝对不要直接调 ctx.memory.save()：
//    它的注释写明「守门员已判定后调用」（dsh-plugin-memory/src/service.ts:134），
//    直接调用会绕过 BM25 查重 / typed 冲突 / user_fact 写门。
//    本模块**自己跑** decide() / writeGate()，把判定结果一并交给 save()。
//
// 设计取舍：本模块**不 import memory 插件的内部实现**（那会形成硬依赖，
// 且 memory 的 decide 在 index.ts 而非 service）。改为通过一个**窄接口**
// （HandoffGatekeeper）注入判定函数——主 agent 侧接线时传入 memory 的实现，
// 单测时传假实现。这样 lecture 包保持独立（D2）。
// ============================================================

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { readHandoff, type Handoff } from './handoff.js';
import { tr } from './locale.js';

// ============================================================
// 窄接口：由主 agent 侧提供（避免 lecture 硬依赖 memory 内部）
// ============================================================

/** 守门员判定结果（与 memory 的 MemoryAction 对齐，但只取本模块用得到的）。 */
export interface GateDecision {
  /** save = 写入；knowledge_direct = 直接进知识层；skip/blocked = 丢弃。 */
  kind: 'save' | 'knowledge_direct' | 'skip' | 'blocked';
  content: string;
  category: 'user_fact' | 'study_log' | 'preference' | 'relationship' | 'session_summary';
  importance: number;
  topic?: string;
}

/** user_fact 写门结果。 */
export interface WriteGateResult {
  action: 'accept' | 'demote' | 'drop';
  reason: string;
  confidence?: number;
}

/**
 * 主 agent 侧要提供的判定能力。
 *
 * 只暴露三个函数，而不是整个 memory 服务——这样：
 *   · lecture 不必知道 memory 的内部结构（D2 隔离）
 *   · 单测可注入假实现
 *   · 将来 memory 重构不会连带改本文件
 */
export interface HandoffGatekeeper {
  /**
   * 规则层初筛（对应 memory 的 gatekeeper.decide）。
   *
   * ⚠️ 语义是**一轮对话**（用户输入 + 助手回复），
   * 不是"给一段文本判个类"。握手导入不是对话，所以调用方必须
   * 把待判内容放在 **query 位**，reply 传空串——不要把同一段文本
   * 塞进两个位置：那会让基于对话形状的启发式（凭据双检、classifyCategory
   * 的 reply 分支）看到重复输入，判出奇怪的结果。
   */
  decide(query: string, reply: string): GateDecision;
  /** user_fact 写门（对应 memory 的 gatekeeper.writeGate）。 */
  writeGate(query: string, content: string): WriteGateResult;
  /** 写入一条记忆（对应 ctx.memory.save）。**调用方保证已过守门员**。 */
  save(input: {
    preset: string;
    content: string;
    category: GateDecision['category'];
    importance: number;
    confidence: number;
    scope: 'mode' | 'global';
    sourceMode: string;
    /**
     * 来源标记（本模块新增的语义；memory 侧可忽略或存入 source_mode）。
     * 用于回答"这条记忆是哪节课来的"。
     */
    sourceLecture?: { course: string; unit: string; date: string };
    /**
     * T1 事实时间轴断言（对应 memory 的 MemorySaveInput.entityClaims）。
     *
     * ⚠️ 必须透传：memory 侧要求 valid_from/valid_until，
     * 缺了就只能退化成纯文本——那样第 5 步"逐条确认"的结构化语义就丢了。
     * valid_from 由本模块在导入时刻赋值（课堂侧不猜主记忆的时间轴语义）。
     */
    entityClaims?: Array<{
      entity: string;
      attribute: string;
      value: string;
      valid_from: number;
      valid_until: number | null;
    }>;
  }): Promise<string>;
  /** 知识层直达（对应 memory 的 handleKnowledgeDirect / knowledgeAdd）。 */
  knowledgeAdd(input: { preset: string; content: string; topic: string; sourceSession: string }): Promise<string>;
  log(msg: string): void;
  warn(msg: string): void;
}

// ============================================================
// 导入结果
// ============================================================

export interface ImportOutcome {
  /** 处理的课程 id。 */
  course: string;
  /** 写入的记忆条数。 */
  memoriesWritten: number;
  /** 写入的知识条数。 */
  knowledgeWritten: number;
  /** 写入的**结构化断言**条数（第 5 步人工确认的学习状态）。 */
  claimsWritten: number;
  /** 被守门员丢弃的（skip/blocked/drop）。 */
  dropped: number;
  /** 逐条明细（供人工核对——"传了什么进来"必须可见）。 */
  details: Array<{ kind: string; content: string; reason: string }>;
}

/** 导入选项。 */
export interface ImportOptions {
  /** 目标 preset（馆）：physical 内容进 physicist。 */
  preset?: string;
  /** 试运行：只判定不写入（人工上传前先看一眼会写什么）。 */
  dryRun?: boolean;
  /** 覆盖会话来源 id（memory 的 source_session）。 */
  sessionId?: string;
}

// ============================================================
// 核心：把 handoff 的一条弱项/知识点过守门员后写入
// ============================================================

/**
 * 把 `decide()` 的结果规整成"确实可以写入的东西"。
 *
 * ⚠️ 为什么必须有这一步（真机事故）：
 *   `decide()` 有四种 kind，只有 `save` 和 `knowledge_direct` 带 `content`。
 *   `pending` 的返回是 `{ kind: 'pending', reason: '待 L1 采集' }` ——
 *   **没有 content、没有 category、没有 importance**。
 *
 *   早先这里只排除了 `skip` / `blocked`，于是 `pending` 一路走到
 *   `gk.save({ content: undefined, category: undefined })`，把 undefined
 *   写进了 memories 表。后果不是"少存一条"，而是**整个记忆域打不开**：
 *     DomainError: stored record ... does not match its schema
 *   记忆插件 apply 直接失败 → 服务不存在 → 之后所有导入都静默降级成试运行。
 *   （真机表现："传 dry_run:false 仍然原地退回 dry_run:true"。）
 *
 * 现在的语义：
 *   · skip / blocked   → null（不写）
 *   · pending          → 用**调用方手上的原文**兜底写入。
 *     pending 的含义是"交给 L1/LLM 判断要不要存"，而导入场景没有那条链路，
 *     直接丢掉又会让用户的短板凭空消失，所以用原句 + study_log 落库。
 *   · save / knowledge_direct → 用 decide 给的 content 和 category。
 *
 * @returns null 表示不写；否则给出非空 content 与合法 category
 */
// memory 接受的记忆分类（与 GateDecision 的 category 一致）
type WriteCategory = 'user_fact' | 'study_log' | 'preference' | 'relationship' | 'session_summary';
const WRITE_CATEGORIES: readonly WriteCategory[] = [
  'user_fact',
  'study_log',
  'preference',
  'relationship',
  'session_summary',
];

function resolveWritable(
  decision: GateDecision,
  fallbackContent: string,
  fallbackCategory: WriteCategory = 'study_log',
): { content: string; category: WriteCategory; importance: number } | null {
  if (decision.kind === 'skip' || decision.kind === 'blocked') return null;

  const content = (decision.content ?? '').trim() || fallbackContent.trim();
  // 兜底文本也是空 → 宁可丢，也不写空记录（空记录会再次毒化存储）
  if (!content) return null;

  // pending 没有 category；非法值也兜底，否则会写进 schema 不认的分类
  const raw = decision.category;
  const category: WriteCategory =
    raw && WRITE_CATEGORIES.includes(raw as WriteCategory) ? (raw as WriteCategory) : fallbackCategory;
  // importance 缺失时给中位值；undefined 传下去 memory 会当成 NaN/0
  const importance = typeof decision.importance === 'number' ? decision.importance : 50;
  return { content, category, importance };
}

/**
 * 导入一个 handoff 包。
 *
 * 写入策略（**保守**）：
 *   · `weak_points` → 作为 study_log / user_fact 候选，过 decide + writeGate
 *   · `units[].topics` → **不写**（只是标题，信息量不足，写了会污染知识层）
 *   · 只处理 `reviewed: true` 的单元（未复盘的内容不该进主记忆）
 *
 * @returns 逐条结果；异常已内部吞掉（不因一条失败中断整体）
 */
export async function importHandoff(
  handoff: Handoff,
  gk: HandoffGatekeeper,
  opts: ImportOptions = {},
): Promise<ImportOutcome> {
  const preset = opts.preset ?? 'physicist';
  const dryRun = opts.dryRun ?? false;
  const sessionId = opts.sessionId ?? `handoff-${handoff.course.id}`;
  const out: ImportOutcome = {
    course: handoff.course.id,
    memoriesWritten: 0,
    knowledgeWritten: 0,
    claimsWritten: 0,
    dropped: 0,
    details: [],
  };

  // 只处理已复盘的单元（D4 门控在接收侧也要生效）
  const reviewed = new Set(handoff.progress.filter((p) => p.reviewed).map((p) => p.unit));

  for (const wp of handoff.weak_points) {
    if (!reviewed.has(wp.unit)) {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: tr('单元未复盘，跳过', 'Lecture not reviewed — skipped') });
      continue;
    }
    // 用户短板 → study_log（"我在 X 上薄弱"属于学习状态，不是身份事实）
    //
    // ⚠️ decide 的语义是一轮对话。这里不是对话，所以把用于判定的陈述句
    //    放在 **query 位、reply 传空串** —— 不要把 topic 同时塞两处
    //    （那会让凭据检测双检、classifyCategory 走错分支）。
    const statement = tr(
      `学习短板：${wp.topic}。这是需要加强的地方。`,
      `Learning weak point: ${wp.topic}. This is something to work on.`,
    );
    const decision = gk.decide(statement, '');
    const query = statement; // writeGate 与 decide 用同一段文本，保持判定一致

    // 关键：pending 没有 content/category —— 必须在这里兜底，
    // 否则 undefined 会被写进存储（见 resolveWritable 的注释）。
    const writable = resolveWritable(decision, statement, 'study_log');
    if (!writable) {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: tr(`守门员判定 ${decision.kind}`, `Gatekeeper decision: ${decision.kind}`) });
      continue;
    }

    // user_fact 走写门（短板极少是 user_fact，但保持与 memory 一致的纪律）
    let confidence = 0.7;
    let importance = writable.importance;
    if (writable.category === 'user_fact') {
      const wg = gk.writeGate(query, writable.content);
      if (wg.action === 'drop') {
        out.dropped++;
        out.details.push({ kind: 'weak_point', content: wp.topic, reason: tr(`写门拦截：${wg.reason}`, `Write gate blocked: ${wg.reason}`) });
        continue;
      }
      if (wg.action === 'demote') {
        confidence = wg.confidence ?? 0.55;
        importance = Math.max(0, importance - 20);
      }
    }

    if (dryRun) {
      out.details.push({ kind: 'weak_point', content: writable.content, reason: tr(`[试运行] 将写入（${writable.category}）`, `[dry run] would write (${writable.category})`) });
      out.memoriesWritten++;
      continue;
    }

    try {
      await gk.save({
        preset,
        content: writable.content,
        category: writable.category,
        importance,
        confidence,
        // 学习短板是"角色相关"（跟具体课程绑定）→ mode
        scope: 'mode',
        sourceMode: 'lecture',
        sourceLecture: { course: handoff.course.id, unit: wp.unit, date: '' },
      });
      out.memoriesWritten++;
      out.details.push({ kind: 'weak_point', content: writable.content, reason: tr(`已写入（${writable.category}）`, `Written (${writable.category})`) });
      gk.log(`握手导入：短板「${wp.topic}」→ 记忆（${writable.category}）`);
    } catch (e) {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: tr(`写入失败：${(e as Error).message}`, `Write failed: ${(e as Error).message}`) });
      gk.warn(`握手导入失败（${wp.topic}）：${(e as Error).message}`);
    }
  }

  // ── 第 5 步人工确认过的学习状态断言 ──
  //
  // 这些是用户在复盘界面**逐条勾选**的（entity/attribute/value）。
  // 曾经它们只落到本地 candidates 文件、没有任何读者 —— 界面给了 checkbox
  // 却没有下游，等于对用户说谎。现在按单元聚合成一条记忆写入，
  // 并把结构化断言透传给 memory 的 T1 时间轴。
  //
  // 按单元聚合（而不是一条断言一条记忆）：断言之间是同一节课的同一批观察，
  // 拆成 N 条记忆会让召回时出现一堆碎片。
  const claimsByUnit = new Map<string, Handoff['claims']>();
  for (const c of handoff.claims ?? []) {
    if (!reviewed.has(c.unit)) {
      out.dropped++;
      out.details.push({ kind: 'claim', content: `${c.attribute}=${c.value}`, reason: tr('单元未复盘，跳过', 'Lecture not reviewed — skipped') });
      continue;
    }
    const list = claimsByUnit.get(c.unit) ?? [];
    list.push(c);
    claimsByUnit.set(c.unit, list);
  }

  for (const [unitId, list] of claimsByUnit) {
    const content = tr(
      `课堂学习状态：${list.map((c) => `${c.attribute} = ${c.value}`).join('；')}`,
      `Lecture learning state: ${list.map((c) => `${c.attribute} = ${c.value}`).join('; ')}`,
    );
    // 同样过守门员（与 weak_points 一致 —— 接收侧不绕过规则层）。
    // query 位放待判文本、reply 传空串（见接口注释）。
    const decision = gk.decide(content, '');
    // 同一套兜底（见 resolveWritable）：claims 常被判成 pending
    const writable = resolveWritable(decision, content, 'study_log');
    if (!writable) {
      out.dropped++;
      out.details.push({ kind: 'claim', content, reason: tr(`守门员判定 ${decision.kind}`, `Gatekeeper decision: ${decision.kind}`) });
      continue;
    }

    let confidence = 0.75;
    let importance = writable.importance;
    if (writable.category === 'user_fact') {
      const wg = gk.writeGate(content, writable.content);
      if (wg.action === 'drop') {
        out.dropped++;
        out.details.push({ kind: 'claim', content, reason: tr(`写门拦截：${wg.reason}`, `Write gate blocked: ${wg.reason}`) });
        continue;
      }
      if (wg.action === 'demote') {
        confidence = wg.confidence ?? 0.55;
        importance = Math.max(0, importance - 20);
      }
    }

    // valid_from = 导入时刻：课堂侧不知道主记忆的时间轴语义，
    // 猜一个更早的时间反而会污染 T1（见 handoff.ts 的 schema 注释）。
    const now = Date.now();
    const entityClaims = list.map((c) => ({
      entity: c.entity || tr('用户', 'User'),
      attribute: c.attribute,
      value: c.value,
      valid_from: now,
      valid_until: null,
    }));

    if (dryRun) {
      out.details.push({
        kind: 'claim',
        content: writable.content,
        reason: tr(`[试运行] 将写入（${writable.category}，含 ${entityClaims.length} 条断言）`, `[dry run] would write (${writable.category}, ${entityClaims.length} claims)`),
      });
      out.memoriesWritten++;
      continue;
    }

    try {
      await gk.save({
        preset,
        content: writable.content,
        category: writable.category,
        importance,
        confidence,
        scope: 'mode',
        sourceMode: 'lecture',
        sourceLecture: { course: handoff.course.id, unit: unitId, date: '' },
        entityClaims,
      });
      out.memoriesWritten++;
      out.claimsWritten += entityClaims.length;
      out.details.push({
        kind: 'claim',
        content: writable.content,
        reason: tr(`已写入（${writable.category}，含 ${entityClaims.length} 条断言）`, `Written (${decision.category}, ${entityClaims.length} claims)`),
      });
      gk.log(`握手导入：${unitId} 学习状态 → 记忆（${entityClaims.length} 条断言）`);
    } catch (e) {
      out.dropped++;
      out.details.push({ kind: 'claim', content, reason: tr(`写入失败：${(e as Error).message}`, `Write failed: ${(e as Error).message}`) });
      gk.warn(`握手导入断言失败（${unitId}）：${(e as Error).message}`);
    }
  }

  return out;
}

// ============================================================
// 文件扫描：找出待导入的 handoff 包
// ============================================================

/** 列出目录下所有 `*-handoff.json`（按文件名排序）。 */
export function findHandoffFiles(dir: string): string[] {
  const abs = isAbsolute(dir) ? dir : join(process.cwd(), dir);
  if (!existsSync(abs)) return [];
  try {
    return readdirSync(abs)
      .filter((f) => f.endsWith('-handoff.json') || f === 'handoff.json')
      .map((f) => join(abs, f))
      .sort();
  } catch {
    return [];
  }
}

/** 读一个握手文件（畸形 → null）。 */
export function loadHandoffFile(file: string): Handoff | null {
  return readHandoff(file);
}

/** 读取原始文件内容（供日志/核对；不解析）。 */
export function peekHandoffFile(file: string): string | null {
  const abs = isAbsolute(file) ? file : join(process.cwd(), file);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

/** 导入结果的可读摘要（人工上传后核对用）。 */
export function describeOutcome(o: ImportOutcome): string {
  return [
    tr(`课程：${o.course}`, `Course: ${o.course}`),
    tr(
      `写入记忆 ${o.memoriesWritten} 条（含 ${o.claimsWritten} 条结构化断言）· 知识 ${o.knowledgeWritten} 条 · 丢弃 ${o.dropped} 条`,
      `Memory: ${o.memoriesWritten} written (${o.claimsWritten} structured claims) · Knowledge: ${o.knowledgeWritten} · Dropped: ${o.dropped}`,
    ),
    ...o.details.map((d) => `  · [${d.kind}] ${d.content} — ${d.reason}`),
  ].join('\n');
}
