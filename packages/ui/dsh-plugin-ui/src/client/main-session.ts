// ============================================================
// main-session.ts —— 主视图当前打开的是哪个会话
//
// ⚠️ 真机踩过：dsh 0.2.x 的 SessionListState 只有 ids / byId / phase /
//   projectionsBySession，**没有 `current` 字段**。侧栏、工作区选择器、TTS
//   早先都读 `s.current`（再用 `as { current?: string }` 强转绕过类型检查），
//   永远 undefined：侧栏从不高亮当前会话，TTS 的按消息取文本从没成功过。
//
// 官方 ui-workspace 的读法（client.js mainSessionId）：byId 里被主视图持有
// （retainedBy.mainView > 0）的那条 —— uiWorkspace 打开会话时以
// `{ source: 'mainView' }` retain 它。retainedBy 是 SessionSummary 的公开字段。
// ============================================================
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';

/** 主视图当前会话 id；没有打开任何会话时 undefined。 */
export function mainSessionIdOf(state: Pick<SessionListState, 'byId'> | undefined): string | undefined {
  if (!state?.byId) return undefined;
  for (const summary of Object.values(state.byId)) {
    // mainView 这个 source 由 ui-workspace 以模块增强声明，这里按字符串键读，不依赖增强是否可见
    const holders = summary.retainedBy as Readonly<Partial<Record<string, number>>> | undefined;
    if ((holders?.mainView ?? 0) > 0) return summary.id;
  }
  return undefined;
}
