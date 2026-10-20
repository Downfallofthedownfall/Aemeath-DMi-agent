// ============================================================
// client/api.ts — 前端 ↔ host 的接口类型与取数函数
//
// 为什么这里**不 import ../types.ts**：
//   types.ts 里是 zod schema（host 侧校验用），打进浏览器 bundle 会白带
//   一整套 zod（~60KB）。前端只需要"视图"形状，所以在这里单独声明。
//   （两边字段靠 host 的 zod parse 保证一致；测试里有一致性断言。）
// ============================================================

export const API_BASE = '/aemeath/api/exercise';

export type Verdict = 'correct' | 'partial' | 'wrong' | 'unclear' | 'error';
export type ProblemStatus = 'todo' | 'draft' | 'answered' | 'checked' | 'needs_fix' | 'done';

export interface CheckIssue {
  severity: 'error' | 'warn' | 'info';
  text: string;
}

export interface CheckView {
  id: string;
  created_at: number;
  model: string;
  verdict: Verdict;
  score: number | null;
  issues: CheckIssue[];
  hints: string[];
  next_steps: string[];
  raw: string;
  answer_sha: string;
  stale: boolean;
}

export interface ProblemView {
  id: string;
  label: string;
  title: string;
  text: string;
  points: number | null;
  page: number;
  answer: string;
  answer_updated_at: number;
  answer_edited_by: 'user' | 'agent';
  checks: CheckView[];
  mistakes: string[];
  notes: string;
  status: ProblemStatus;
  last_check: CheckView | null;
  check_count: number;
}

export interface LessonView {
  id: string;
  text: string;
  tags: string[];
  source: 'llm' | 'user';
  created_at: number;
  in_worldbook: boolean;
}

export interface SheetProgressView {
  total: number;
  answered: number;
  checked: number;
  needsFix: number;
  wrong: number;
  percent: number;
}

export interface SheetView {
  id: string;
  number: number;
  title: string;
  issued: string;
  due: string;
  source_pdf: string;
  source_pages: number;
  import_mode: 'pdf' | 'manual';
  imported_at: number;
  needs_manual_text: boolean;
  progress_digest: string;
  progress_digest_at: number;
  problems: ProblemView[];
  lessons: LessonView[];
  submitted_at: number;
  submission_pdf: string;
  submission_pages: number;
  version: number;
  progress: SheetProgressView;
  next_hint: string;
  course: { id: string; title: string; semester: string } | null;
}

export interface SheetMetaView {
  id: string;
  number: number;
  title: string;
  issued: string;
  due: string;
  due_in_days: number | null;
  total: number;
  answered: number;
  checked: number;
  needs_fix: number;
  percent: number;
  submitted: boolean;
  submission_pages: number;
  import_mode: 'pdf' | 'manual';
  needs_manual_text: boolean;
  lesson_count: number;
  progress_digest: string;
  next_hint: string;
}

export interface CourseView {
  course_id: string;
  title: string;
  semester: string;
  module_code: string;
  sheets: SheetMetaView[];
}

export interface MistakeView {
  id: string;
  course_id: string;
  course_title: string;
  sheet_id: string;
  sheet_title: string;
  sheet_due: string;
  problem_id: string;
  problem_label: string;
  problem_text: string;
  answer: string;
  verdict: Verdict;
  issues: string[];
  tags: string[];
  lesson: string;
  created_at: number;
  updated_at: number;
  review_count: number;
  mastered: boolean;
  in_worldbook: boolean;
  source_check_id: string;
  age_days: number;
}

export interface SymbolView {
  label: string;
  insert: string;
  caret?: string;
  hint?: string;
  template?: string;
  slots?: Array<{ index: number; hint: string }>;
}

/** 符号分组（借 lecture 的 SYMBOL_GROUPS：{ id, label, symbols }）。 */
export interface SymbolGroupView {
  id: string;
  label: string;
  symbols: SymbolView[];
}

export interface DigestView {
  digest: string;
  stats: {
    sheetsTotal: number;
    sheetsSubmitted: number;
    problemsAnswered: number;
    problemsTotal: number;
    checksPassed: number;
    unmasteredMistakes: number;
    topWeakTags: string[];
  };
}

/** 带 payload 的错误：host 在 `ok:false` 时可能附带 `print_url` 之类的补充信息。 */
export class ApiError extends Error {
  readonly payload: Record<string, unknown>;
  constructor(message: string, payload: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.payload = payload;
  }
}

async function parse<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`服务返回了非 JSON（HTTP ${resp.status}）：${text.slice(0, 120)}`);
  }
  const obj = data as { ok?: boolean; error?: string };
  if (!resp.ok || obj.ok === false) {
    throw new ApiError(obj.error ?? `HTTP ${resp.status}`, (data ?? {}) as Record<string, unknown>);
  }
  return data as T;
}

export async function apiGet<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  const q = new URLSearchParams({ action, ...params });
  const resp = await fetch(`${API_BASE}?${q.toString()}`, { headers: { Accept: 'application/json' } });
  return parse<T>(resp);
}

export async function apiPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const resp = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  return parse<T>(resp);
}

/** 读文件为 base64（去掉 data URL 前缀）。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const s = String(reader.result ?? '');
      const i = s.indexOf(',');
      resolve(i === -1 ? s : s.slice(i + 1));
    };
    reader.readAsDataURL(file);
  });
}
