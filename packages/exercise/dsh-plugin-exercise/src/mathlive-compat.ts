// ============================================================
// mathlive-compat.ts — MathLive 方言 → KaTeX（渲染期兼容层）
//
// 背景（真机 bug，2026-10-21）：
//   讲义（lecture）用 MathLive 渲染，它有一批**专有宏**：
//     `\differentialD` `\exponentialE` `\imaginaryI` `\imaginaryJ` `\placeholder{}`
//   习题用 KaTeX，没有这些宏。用户从讲义复制 `$…$` 源码粘进答案框后：
//     KaTeX 报 "Undefined control sequence" → `throwOnError:false` 把它画成**红字内联**，
//     而 \frac 的分母里塞了红字 → 分数结构塌掉，看起来像"排版坏了"，还不知道哪条命令错。
//
// 修法（只做渲染期归一化，**绝不改写存储的文本**）：
//   ① 渲染前把已知 MathLive 宏换成通用写法（\mathrm{d} 之类）
//   ② 归一化之后仍然解析失败的，把错误**以文字形式**报出来（命令名 + 位置 + 建议）
//
// 为什么不在切分/存储层做：
//   · 用户原文要能原样撤销/检索/进 md 导出；
//   · 粘贴、存量笔记、LLM 输出都不经过符号面板，兼容层必须挂在渲染入口。
//
// 注意：不做"大小写不敏感"的模糊匹配（`\differentialD` 是 MathLive 的宏，
// 小写 `\differentiald` MathLive 自己也不认）。小写这里**显式**按 d 处理并在
// 界面上提示"非标准写法"，属于一张显式映射表，而不是猜测规则。
// ============================================================

import katex from 'katex';
import { splitMathSegments } from './math-parse.js';

export interface MacroReplacement {
  from: string;
  to: string;
  /** 需要额外提示的（例如大小写写错） */
  note?: string;
}

/** MathLive 专有宏 → KaTeX 通用写法（长模式在前）。 */
export const MATHLIVE_MACROS: ReadonlyArray<{ from: string; to: string; note?: string }> = [
  { from: '\\placeholder{}', to: '{}' },
  { from: '\\placeholder', to: '{}', note: '\\placeholder 是 MathLive 的占位框，通用写法是 {}' },
  { from: '\\differentialD', to: '\\mathrm{d}' },
  {
    from: '\\differentiald',
    to: '\\mathrm{d}',
    note: '\\differentiald 不是 MathLive 的宏（正确写法是 \\differentialD），已按 \\mathrm{d} 渲染',
  },
  { from: '\\exponentialE', to: '\\mathrm{e}' },
  { from: '\\imaginaryI', to: '\\mathrm{i}' },
  { from: '\\imaginaryJ', to: '\\mathrm{j}' },
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把 MathLive 方言归一成 KaTeX 能吃的写法。
 *
 * @returns `tex` 归一化后的文本（**只在渲染用**，不要写回用户数据）；
 *          `replaced` 实际发生的替换（界面据此给"已按 X 渲染"的提示）。
 */
export function normalizeMathLive(tex: string): { tex: string; replaced: MacroReplacement[] } {
  let out = tex ?? '';
  const replaced: MacroReplacement[] = [];
  for (const macro of MATHLIVE_MACROS) {
    const re = new RegExp(`${escapeRe(macro.from)}(?![A-Za-z])`, 'g');
    const before = out;
    out = out.replace(re, macro.to);
    if (out !== before) replaced.push({ from: macro.from, to: macro.to, note: macro.note });
  }
  // `\sum_{\placeholder{}}^{…}` → `\sum_{{}}^{{}}`：把多余的一层包裹收掉
  out = out.replace(/\{\{\}\}/g, '{}');
  return { tex: out, replaced };
}

export interface MathIssue {
  /** 出错的命令（含反斜杠），例如 `\foo` */
  command: string;
  /** KaTeX 报错里的字符串位置（1 基；找不到就是 -1） */
  position: number;
  /** KaTeX 原始报错（可能很长，界面只展示 command/建议） */
  message: string;
  /** 给用户的可读建议 */
  hint: string;
}

/** 给某个未定义命令的建议（已知 MathLive 宏 → 明确写法；其余 → 检查拼写）。 */
export function hintForCommand(command: string): string {
  const known: Record<string, string> = {
    '\\differentialD': '讲义（MathLive）专有宏，通用写法是 \\mathrm{d}',
    '\\differentiald': '大小写写错了：MathLive 的宏是 \\differentialD，通用写法 \\mathrm{d}',
    '\\exponentialE': '讲义（MathLive）专有宏，通用写法是 \\mathrm{e}',
    '\\imaginaryI': '讲义（MathLive）专有宏，通用写法是 \\mathrm{i}',
    '\\imaginaryJ': '讲义（MathLive）专有宏，通用写法是 \\mathrm{j}',
    '\\placeholder': 'MathLive 的占位框语法，通用写法是 {}',
  };
  return known[command] ?? 'KaTeX 没有这个命令：检查拼写，或改用标准 LaTeX';
}

const UNDEFINED_RE = /Undefined control sequence:\s*(\\[A-Za-z]+)/;
const POSITION_RE = /at position (\d+)/;

/**
 * 找出一段 TeX 里 KaTeX 解析不了的命令（**渲染前**调用，用于文字提示）。
 *
 * 做法：先跑一次 `throwOnError:true`，从报错里抠出命令名；再把该命令替换成
 * 无关紧要的 `\mathrm{x}` 重试，直到没有新错误（最多 `max` 次，防止死循环）。
 */
export function collectMathIssues(tex: string, opts: { max?: number } = {}): MathIssue[] {
  const max = opts.max ?? 5;
  let src = (tex ?? '').trim();
  if (!src) return [];
  const issues: MathIssue[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < max; i++) {
    try {
      katex.renderToString(src, { throwOnError: true, strict: 'ignore', displayMode: false, trust: false });
      return issues;
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      const cmd = UNDEFINED_RE.exec(message)?.[1];
      if (!cmd || seen.has(cmd)) return issues;
      seen.add(cmd);
      issues.push({
        command: cmd,
        position: Number(POSITION_RE.exec(message)?.[1] ?? -1),
        message,
        hint: hintForCommand(cmd),
      });
      src = src.replace(new RegExp(`${escapeRe(cmd)}(?![A-Za-z])`), '\\mathrm{x}');
    }
  }
  return issues;
}

/**
 * 扫一段"markdown + 公式"文本：返回里面所有**真正会渲染的公式**里的未知命令。
 *
 * 给答案编辑器的提示用（`MathText` 渲染的是同一批公式，所以提示和渲染不会错位）。
 */
export function collectMathIssuesInText(text: string): MathIssue[] {
  const issues: MathIssue[] = [];
  const seen = new Set<string>();
  for (const seg of splitMathSegments(text ?? '')) {
    if (seg.kind !== 'math') continue;
    for (const issue of collectMathIssues(normalizeMathLive(seg.tex).tex)) {
      if (seen.has(issue.command)) continue;
      seen.add(issue.command);
      issues.push(issue);
    }
  }
  return issues;
}

/** 一段文本里有哪些 MathLive 宏被兼容层"翻译"过（用于提示"已按 X 渲染"）。 */
export function collectMathLiveReplacements(text: string): MacroReplacement[] {
  const out: MacroReplacement[] = [];
  const seen = new Set<string>();
  for (const seg of splitMathSegments(text ?? '')) {
    if (seg.kind !== 'math') continue;
    for (const r of normalizeMathLive(seg.tex).replaced) {
      if (seen.has(r.from)) continue;
      seen.add(r.from);
      out.push(r);
    }
  }
  return out;
}
