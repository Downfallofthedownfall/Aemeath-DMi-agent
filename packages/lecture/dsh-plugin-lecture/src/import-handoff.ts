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
  /** 规则层初筛（对应 memory 的 gatekeeper.decide）。 */
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
    dropped: 0,
    details: [],
  };

  // 只处理已复盘的单元（D4 门控在接收侧也要生效）
  const reviewed = new Set(handoff.progress.filter((p) => p.reviewed).map((p) => p.unit));

  for (const wp of handoff.weak_points) {
    if (!reviewed.has(wp.unit)) {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: '单元未复盘，跳过' });
      continue;
    }
    // 用户短板 → study_log（"我在 X 上薄弱"属于学习状态，不是身份事实）
    const query = `学习短板：${wp.topic}`;
    const decision = gk.decide(query, wp.topic);

    if (decision.kind === 'skip' || decision.kind === 'blocked') {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: `守门员判定 ${decision.kind}` });
      continue;
    }

    // user_fact 走写门（短板极少是 user_fact，但保持与 memory 一致的纪律）
    let confidence = 0.7;
    let importance = decision.importance;
    if (decision.category === 'user_fact') {
      const wg = gk.writeGate(query, decision.content);
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
      out.details.push({ kind: 'weak_point', content: decision.content, reason: `[试运行] 将写入（${decision.category}）` });
      out.memoriesWritten++;
      continue;
    }

    try {
      await gk.save({
        preset,
        content: decision.content,
        category: decision.category,
        importance,
        confidence,
        // 学习短板是"角色相关"（跟具体课程绑定）→ mode
        scope: 'mode',
        sourceMode: 'lecture',
        sourceLecture: { course: handoff.course.id, unit: wp.unit, date: '' },
      });
      out.memoriesWritten++;
      out.details.push({ kind: 'weak_point', content: decision.content, reason: `已写入（${decision.category}）` });
      gk.log(`握手导入：短板「${wp.topic}」→ 记忆（${decision.category}）`);
    } catch (e) {
      out.dropped++;
      out.details.push({ kind: 'weak_point', content: wp.topic, reason: `写入失败：${(e as Error).message}` });
      gk.warn(`握手导入失败（${wp.topic}）：${(e as Error).message}`);
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
    `课程：${o.course}`,
    `写入记忆 ${o.memoriesWritten} 条 · 知识 ${o.knowledgeWritten} 条 · 丢弃 ${o.dropped} 条`,
    ...o.details.map((d) => `  · [${d.kind}] ${d.content} — ${d.reason}`),
  ].join('\n');
}
