// ============================================================
// curriculum.ts — 课程大纲（Modulhandbuch）纯函数（可单测；不依赖 IO）
// 职责：
//   ① parseCurriculum —— 解析 Modulhandbuch JSON（容错）
//   ② currentSemester —— 按月份推断当前学期（WiSe 10–3 月 / SoSe 4–9 月；可配置覆盖）
//   ③ modulesInSemester —— 筛选某学期在开模块
//   ④ searchModules —— 模块检索（代码/标题/内容，德语关键词）
//   ⑤ semesterSummary —— 常驻注入文本（模块名/代码/学分/类型）
// ============================================================

export interface CurriculumPrerequisites {
  mandatory?: string;
  recommended?: string;
}

export interface CurriculumModule {
  title: string;
  module_code: string;
  semesters: string[];
  type: string;
  prerequisites: CurriculumPrerequisites;
  credits: number;
  workload?: { total_hours?: number; contact_hours?: number; self_study_hours?: number; exam_prep_hours?: number };
  language?: string;
  content: string[];
}

export interface CurriculumCategory {
  category: string;
  modules: CurriculumModule[];
}

export interface CurriculumData {
  university: string;
  faculty: string;
  degree_program: string;
  document_date: string;
  categories: CurriculumCategory[];
}

/** 标准学期名（Modulhandbuch 用词）。 */
export const WINTER = 'Wintersemester';
export const SUMMER = 'Sommersemester';

/** 解析 Modulhandbuch JSON（容错：字段缺失/结构异常时跳过问题模块）。 */
export function parseCurriculum(raw: unknown): CurriculumData {
  const root = (raw ?? {}) as {
    university?: string;
    faculty?: string;
    degree_program?: string;
    document_date?: string;
    modules?: Array<{ category?: string; details?: unknown[] }>;
  };
  const categories: CurriculumCategory[] = [];
  for (const group of root.modules ?? []) {
    const modules: CurriculumModule[] = [];
    for (const d of group.details ?? []) {
      const m = d as {
        title?: string;
        module_code?: string;
        semester?: string[];
        type?: string;
        prerequisites?: { mandatory?: string; recommended?: string };
        credits?: number;
        workload?: Record<string, number>;
        language?: string;
        content?: string[];
      };
      if (!m || typeof m !== 'object' || !m.module_code) continue;
      modules.push({
        title: m.title ?? m.module_code,
        module_code: m.module_code,
        semesters: Array.isArray(m.semester) ? m.semester : [],
        type: m.type ?? '',
        prerequisites: {
          mandatory: m.prerequisites?.mandatory ?? 'keine',
          recommended: m.prerequisites?.recommended ?? 'keine',
        },
        credits: m.credits ?? 0,
        workload: m.workload as CurriculumModule['workload'],
        language: m.language ?? '',
        content: Array.isArray(m.content) ? m.content : [],
      });
    }
    if (modules.length) categories.push({ category: group.category ?? 'Allgemein', modules });
  }
  return {
    university: root.university ?? '',
    faculty: root.faculty ?? '',
    degree_program: root.degree_program ?? '',
    document_date: root.document_date ?? '',
    categories,
  };
}

/** 全部模块（拍平）。 */
export function allModules(data: CurriculumData): CurriculumModule[] {
  return data.categories.flatMap((c) => c.modules);
}

/**
 * 按月份推断当前学期（德语学期制）。
 * WiSe：10 月 – 次年 3 月；SoSe：4 月 – 9 月。
 */
export function currentSemester(now: Date, override?: string): string {
  if (override && (override === WINTER || override === SUMMER)) return override;
  const m = now.getMonth() + 1; // 1-12
  return m >= 10 || m <= 3 ? WINTER : SUMMER;
}

/** 某学期在开模块（模块 semester 列表包含目标学期）。 */
export function modulesInSemester(data: CurriculumData, semester: string): CurriculumCategory[] {
  const out: CurriculumCategory[] = [];
  for (const cat of data.categories) {
    const mods = cat.modules.filter((m) => m.semesters.includes(semester));
    if (mods.length) out.push({ category: cat.category, modules: mods });
  }
  return out;
}

/** 模块检索：代码前缀/标题/内容关键词（大小写不敏感，德语可直接搜）。 */
export function searchModules(data: CurriculumData, query: string, topK = 3): CurriculumModule[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ m: CurriculumModule; score: number }> = [];
  for (const m of allModules(data)) {
    let score = 0;
    const code = m.module_code.toLowerCase();
    const title = m.title.toLowerCase();
    const content = m.content.join(' ').toLowerCase();
    if (code.includes(q)) score += 100; // 代码精确包含
    if (code.startsWith(q)) score += 50;
    if (title.includes(q)) score += 30;
    if (content.includes(q)) score += 10;
    // 逐个关键词子匹配（支持多词查询）
    for (const word of q.split(/[\s/]+/).filter((w) => w.length > 1)) {
      if (title.includes(word)) score += 5;
      if (content.includes(word)) score += 2;
    }
    if (score > 0) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.m);
}

/** 生成常驻课程上下文（注入文本）：学位 + 学期 + 在开模块清单。 */
export function semesterSummary(data: CurriculumData, semester: string): string {
  const lines: string[] = [];
  if (data.degree_program) lines.push(`学位：${data.degree_program}`);
  if (data.university) lines.push(`学校：${data.university}`);
  lines.push(`当前学期：${semester}（Modulhandbuch ${data.document_date || '（年份未知）'}）`);
  for (const cat of modulesInSemester(data, semester)) {
    lines.push(`\n【${cat.category}】`);
    for (const m of cat.modules) {
      lines.push(`- ${m.module_code} ${m.title} · ${m.credits} LP · ${m.type || '模块'}`);
    }
  }
  return lines.join('\n');
}

/** 模块详情格式化（供工具返回与回答引用）。 */
export function formatModuleDetail(m: CurriculumModule): string {
  const lines = [
    `【${m.module_code}】${m.title}`,
    `类型：${m.type || '—'} · 学分：${m.credits} LP · 学期：${m.semesters.join(' / ') || '—'}`,
  ];
  if (m.prerequisites.mandatory && m.prerequisites.mandatory !== 'keine') lines.push(`前置（必）：${m.prerequisites.mandatory}`);
  if (m.prerequisites.recommended && m.prerequisites.recommended !== 'keine') lines.push(`前置（荐）：${m.prerequisites.recommended}`);
  if (m.workload?.total_hours) lines.push(`工作量：${m.workload.total_hours} h（${m.workload.contact_hours ?? 0} 学时 / ${m.workload.self_study_hours ?? 0} 自学 / ${m.workload.exam_prep_hours ?? 0} 备考）`);
  if (m.content.length) lines.push(`内容：${m.content.join('；')}`);
  return lines.join('\n');
}
