// ============================================================
// plan-feed.ts —— 当前会话解题计划的**共享**轮询源
//
// 为什么单独一个模块（真机测出来的）：解题计划浮卡（workflow-todo，每 4s）和
//   计划确认卡（composer-cards，每 5s）原先各自轮询 GET /aemeath/api/memory ——
//   那是整份记忆总览（全部 L2/L3 + L1 缓冲，~70KB），两张卡只读其中 plans[sessionId]。
//   空闲时 20s 内 9 次请求，约 110MB/小时的 JSON 序列化。
// 现在：
//   · 只请求 ?action=plan&session=…（host 只读这一个会话的 scratch）；
//   · 同一会话的所有订阅者共用一个定时器（引用计数，最后一个退订即停）；
//   · 步骤没变就不通知（快照引用稳定，订阅组件不会每次轮询都重渲染）；
//   · 页面不可见时不发请求，重新可见时立刻补拉一次。
// ============================================================
import { useCallback, useSyncExternalStore } from 'react';

const POLL_MS = 4000;
const EMPTY: readonly string[] = Object.freeze([]);

interface Feed {
  steps: readonly string[];
  key: string;
  listeners: Set<() => void>;
  timer: number;
  inflight: boolean;
}

const feeds = new Map<string, Feed>();

async function fetchPlan(sessionId: string): Promise<string[] | null> {
  try {
    const res = await fetch(`/aemeath/api/memory?action=plan&session=${encodeURIComponent(sessionId)}`, {
      signal: AbortSignal.timeout(8000),
    });
    const d = (await res.json()) as { ok?: boolean; steps?: unknown };
    if (!res.ok || !d.ok || !Array.isArray(d.steps)) return null;
    return d.steps.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null; // 网络抖动：保留上一次的步骤，不闪空
  }
}

function tick(sessionId: string): void {
  const feed = feeds.get(sessionId);
  if (!feed || feed.inflight) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  feed.inflight = true;
  void fetchPlan(sessionId).then((steps) => {
    feed.inflight = false;
    if (steps === null || feeds.get(sessionId) !== feed) return;
    const key = JSON.stringify(steps);
    if (key === feed.key) return;
    feed.key = key;
    feed.steps = steps.length ? Object.freeze(steps) : EMPTY;
    for (const l of feed.listeners) l();
  });
}

let visibilityHooked = false;
function hookVisibility(): void {
  if (visibilityHooked || typeof document === 'undefined') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const sessionId of feeds.keys()) tick(sessionId);
  });
}

/** 订阅某会话的计划步骤（首个订阅者启动轮询，最后一个退订时停止）。 */
export function subscribePlan(sessionId: string, listener: () => void): () => void {
  if (!sessionId) return () => undefined;
  hookVisibility();
  let feed = feeds.get(sessionId);
  if (!feed) {
    feed = { steps: EMPTY, key: '[]', listeners: new Set(), timer: 0, inflight: false };
    feeds.set(sessionId, feed);
    feed.timer = window.setInterval(() => tick(sessionId), POLL_MS);
    tick(sessionId);
  }
  feed.listeners.add(listener);
  const own = feed;
  return () => {
    own.listeners.delete(listener);
    if (own.listeners.size === 0) {
      window.clearInterval(own.timer);
      if (feeds.get(sessionId) === own) feeds.delete(sessionId);
    }
  };
}

/** 当前快照（稳定引用：步骤不变则同一个数组）。 */
export function getPlanSteps(sessionId: string): readonly string[] {
  return feeds.get(sessionId)?.steps ?? EMPTY;
}

/** React hook：当前会话的计划步骤（无会话 / 无计划 → 空数组）。 */
export function usePlanSteps(sessionId: string): readonly string[] {
  const subscribe = useCallback((l: () => void) => subscribePlan(sessionId, l), [sessionId]);
  const snapshot = useCallback(() => getPlanSteps(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, snapshot);
}
