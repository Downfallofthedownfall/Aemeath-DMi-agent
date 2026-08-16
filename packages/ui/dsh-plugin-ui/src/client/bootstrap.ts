// ============================================================
// bootstrap.ts —— 无工作区自动兜底（"打开即聊，无需选择工作区"）
// 背景：dsh 硬约束下空白会话必须归属工作区才能输入（inert 只读）。
//   因此"完全不挂工作区"不可行；本模块在**零工作区**时自动把项目内
//   空文件夹（host 侧 boot-info 提供，默认 .chat）挂为工作区并接入会话——
//   用户无需选择任何东西，打开应用就能直接开始对话。
// 触发条件（严格收窄，避免干扰正常流程）：
//   - workspaces 基线就绪（baselinesReady）
//   - 工作区列表为空（items.length === 0）→ 才自动创建
//   - 已有工作区时官方流程（初始选择/新会话）本就自动接入，不干预
// 只执行一次；失败仅告警，不重试（官方"选择一个工作区开始"出口仍可用）。
// 同时导出 ensureFallbackChat / fetchFallbackWorkspacePath，供工作区选择器的
// 「无工作区」菜单项复用（点它 = 直接在兜底工作区开新对话）。
// ============================================================
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';

/** 客户端 workspaces 服务最小结构（跨版本结构断言，避免强依赖）。 */
export interface WorkspacesLike {
  list: {
    getSnapshot(): unknown;
    subscribe(fn: () => void): () => void;
  };
  create(input: { path: string }): Promise<{ workspaceId: string }>;
  startSession(workspaceId?: string): void;
}

/** 兜底聊天只需 create + startSession（工作区选择器注入的 workspaces 也满足）。 */
export type WorkspacesChatLike = Pick<WorkspacesLike, 'create' | 'startSession'>;

interface WorkspacesSnapshot {
  items?: unknown[];
  baselinesReady?: boolean;
}

/** 拉取兜底工作区路径（host 侧 boot-info；未就绪/失败返回 null）。 */
export async function fetchFallbackWorkspacePath(): Promise<string | null> {
  try {
    const res = await fetch('/aemeath/api/boot-info', { signal: AbortSignal.timeout(8000) });
    const info = (await res.json()) as { defaultWorkspacePath?: string };
    return info.defaultWorkspacePath ?? null;
  } catch {
    return null;
  }
}

/**
 * 确保兜底工作区（项目内空文件夹）已挂载，并接入一个新会话——「无工作区也能开始对话」。
 * create 幂等：路径已注册时返回既有工作区。返回是否成功。
 */
export async function ensureFallbackChat(workspaces: WorkspacesChatLike): Promise<boolean> {
  const path = await fetchFallbackWorkspacePath();
  if (!path) return false;
  try {
    const ws = await workspaces.create({ path });
    workspaces.startSession(ws.workspaceId);
    return true;
  } catch {
    return false;
  }
}

/** 注册无工作区兜底（幂等）。 */
export function registerWorkspaceBootstrap(ctx: ClientContext): void {
  const workspaces = ctx.workspaces as unknown as WorkspacesLike;
  if (!workspaces?.list) return;

  let done = false;
  let unsubscribe: (() => void) | null = null;

  const finish = (): void => {
    done = true;
    unsubscribe?.();
    unsubscribe = null;
  };

  const tryBootstrap = (): void => {
    if (done) return;
    let state: WorkspacesSnapshot | undefined;
    try {
      state = workspaces.list.getSnapshot() as WorkspacesSnapshot;
    } catch {
      finish();
      return;
    }
    if (!state?.baselinesReady) return; // 基线未就绪：等下一轮通知
    finish(); // 基线已就绪 → 本轮定案（无论是否创建，不再重复判断）

    if ((state.items?.length ?? 0) > 0) return; // 已有工作区：官方流程接管

    void (async () => {
      const ok = await ensureFallbackChat(workspaces);
      const path = ok ? await fetchFallbackWorkspacePath() : null;
      if (ok) {
        console.log('[aemeath-ui] 无工作区 → 已自动挂载项目内空文件夹为工作区:', path);
      } else {
        console.warn('[aemeath-ui] 自动工作区兜底失败（官方"选择一个工作区开始"仍可用）');
      }
    })();
  };

  unsubscribe = workspaces.list.subscribe(tryBootstrap);
  tryBootstrap();
  ctx.effect(() => () => {
    finish();
  });
}
