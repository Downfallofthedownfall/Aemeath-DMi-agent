// ============================================================
// service.ts — ctx.memory 服务（M3 v3）
// 对外暴露：search / list / save / softDelete / stats / scratch（L1 暂存）
// 供：pre-step 召回注入、/memory 命令、HTTP 管理端点、M5 记忆面板、其他插件
// 生命周期：Service 构造时 super(ctx, 'memory') 即注册，随插件 fiber 自动注销
// ============================================================

import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { KvTable } from '@deepseek-ai/dsh-storage-domain';
import { search as bm25Search } from './bm25.js';
import type { MemoryRecord, AuditRecord, UserProfile, Category } from './types.js';

export interface MemoryServiceDeps {
  memories: KvTable<string, MemoryRecord>;
  audit: KvTable<string, AuditRecord>;
  profile: { get(): UserProfile; set(v: UserProfile): Promise<void> };
  auditWrite(action: string, memoryId: string | undefined, detail: string): Promise<void>;
}

export interface MemorySearchResult {
  id: string;
  scope: 'mode' | 'global';
  preset: string;
  content: string;
  category: Category;
  importance: number;
  status: 'active' | 'dormant';
}

export interface MemorySaveInput {
  content: string;
  category?: Category;
  importance?: number;
  confidence?: number;
  scope?: 'mode' | 'global';
  preset: string;
  source_mode?: string;
}

export class MemoryService extends Service {
  private readonly deps: MemoryServiceDeps;
  /** L1 工作缓存：会话内任务暂存区（scratch），内存态，随进程存活。 */
  private readonly scratchMap = new Map<string, Record<string, string>>();

  constructor(ctx: Context, deps: MemoryServiceDeps) {
    super(ctx, 'memory');
    this.deps = deps;
  }

  private allActive(): Array<{ key: string; rec: MemoryRecord }> {
    const out: Array<{ key: string; rec: MemoryRecord }> = [];
    for (const [key, rec] of this.deps.memories.entries()) {
      if (rec.deleted) continue;
      out.push({ key, rec });
    }
    return out;
  }

  /** 检索记忆（BM25 优先，退回 importance 排序）。 */
  search(query: string, opts: { preset?: string; topK?: number } = {}): MemorySearchResult[] {
    const all = this.allActive();
    if (query) {
      const hits = bm25Search(query, all.map(({ key, rec }) => ({ id: key, content: rec.content })), opts.topK ?? 5);
      const hitIds = new Map(hits.map((h) => [h.id, h]));
      return hits
        .map((h) => {
          const hit = hitIds.get(h.id);
          const found = hit ? all.find((a) => a.key === h.id) : undefined;
          return found ? toResult(found.key, found.rec) : undefined;
        })
        .filter((x): x is MemorySearchResult => !!x);
    }
    return all
      .filter(({ rec }) => (opts.preset ? rec.preset === opts.preset : true))
      .sort((a, b) => b.rec.importance - a.rec.importance)
      .slice(0, opts.topK ?? 5)
      .map(({ key, rec }) => toResult(key, rec));
  }

  /** 按 preset 召回（L2 mode + L3 global），供 pre-step 注入。 */
  recallForPreset(preset: string, topK: number): Array<{ key: string; rec: MemoryRecord }> {
    return this.allActive()
      .filter(({ rec }) => rec.status === 'active' && (rec.scope === 'global' || rec.preset === preset))
      .sort((a, b) => b.rec.importance - a.rec.importance)
      .slice(0, topK);
  }

  /** 列出全部未删除记忆（供 /memory 命令与面板）。 */
  list(): Array<{ key: string; rec: MemoryRecord }> {
    return this.allActive();
  }

  /** 写入一条记忆（守门员已判定后调用；scope 支持 mode/global）。 */
  async save(input: MemorySaveInput): Promise<string> {
    const id = randomUUID();
    const rec: MemoryRecord = {
      id,
      scope: input.scope ?? 'mode',
      preset: input.preset,
      content: input.content,
      category: input.category ?? 'session_summary',
      importance: input.importance ?? 50,
      confidence: input.confidence ?? 0.7,
      source_mode: input.source_mode ?? input.preset,
      created_at: Date.now(),
      last_access: Date.now(),
      status: 'active',
    };
    await this.deps.memories.put(id, rec);
    await this.deps.auditWrite('save', id, `importance=${rec.importance} category=${rec.category} scope=${rec.scope}`);
    return id;
  }

  /** 软删（可撤销；审计留痕）。 */
  async softDelete(idPrefix: string): Promise<boolean> {
    const found = this.allActive().find(({ key }) => key.startsWith(idPrefix));
    if (!found) return false;
    await this.deps.memories.put(found.key, { ...found.rec, deleted: true });
    await this.deps.auditWrite('soft_delete', found.key, '用户删除');
    return true;
  }

  /** 统计（/memory stats 与面板）。 */
  stats(): { active: number; dormant: number; byPreset: Record<string, number>; byScope: Record<string, number> } {
    const out = { active: 0, dormant: 0, byPreset: {} as Record<string, number>, byScope: {} as Record<string, number> };
    for (const { rec } of this.allActive()) {
      if (rec.status === 'active') out.active++;
      else out.dormant++;
      out.byPreset[rec.preset] = (out.byPreset[rec.preset] ?? 0) + 1;
      out.byScope[rec.scope] = (out.byScope[rec.scope] ?? 0) + 1;
    }
    return out;
  }

  // ===== L1 暂存区（scratch，会话内工作态） =====
  getScratch(sessionId: string, key: string): string | undefined {
    return this.scratchMap.get(sessionId)?.[key];
  }

  setScratch(sessionId: string, key: string, value: string): void {
    const slot = this.scratchMap.get(sessionId) ?? {};
    slot[key] = value;
    this.scratchMap.set(sessionId, slot);
  }

  clearScratch(sessionId: string): void {
    this.scratchMap.delete(sessionId);
  }

  scratchKeys(sessionId: string): string[] {
    return Object.keys(this.scratchMap.get(sessionId) ?? {});
  }
}

function toResult(key: string, rec: MemoryRecord): MemorySearchResult {
  return {
    id: key,
    scope: rec.scope,
    preset: rec.preset,
    content: rec.content,
    category: rec.category,
    importance: rec.importance,
    status: rec.status,
  };
}
