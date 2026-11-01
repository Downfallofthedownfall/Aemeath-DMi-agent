// ============================================================
// bootstrap.ts —— 兜底工作区（项目内空文件夹，host 侧 boot-info 提供，默认 .chat）
// 背景：dsh 硬约束下空白会话必须归属工作区才能输入（inert 只读）。
// 供工作区选择器的「无工作区」菜单项使用：点它 = 直接在兜底工作区开新对话。
//
// ⚠️ 这里原本还有 registerWorkspaceBootstrap（零工作区时自动挂 .chat）：
//   它等的是 0.1 的 `baselinesReady` 字段，0.2 的快照只有 `phase`，所以从没执行过；
//   而 dsh 0.2.1 的 ui-workspace 在「零工作区 + 零会话」时自己会 initializeDefault。
//   若改好字段名，它会和官方初始化抢跑，还会调 ctx.workspaces 上已不存在的
//   startSession。已删除 —— 行为与删除前一致（它本来就不运行）。
// ============================================================

/** 兜底聊天只需 create + startSession（工作区选择器注入的适配器满足它，见 index.ts）。 */
export interface WorkspacesChatLike {
  create(input: { path: string }): Promise<{ workspaceId: string }>;
  startSession(workspaceId?: string): void;
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
