// ============================================================
// status.ts —— 角色状态 store（UI 改造 P2 → 角色状态）
// 轻量纯 store：暴露 useCharacterStatus()，返回稳定快照
//   { state: 'idle' | 'thinking' | 'speaking', labelKey }
// 派生优先级：speaking（朗读中）> thinking（思考中）> idle（陪伴中）。
//   思考中：当前会话 model 正在响应（ConversationSnapshot.running），
//           由 status.tsx 的 pill 组件经 useSession 喂入 setStatusRunning。
//   朗读中：tts.tsx 的 speaking 标志（getSpeaking/subscribeSpeaking），
//           由 status.tsx 组件喂入 setStatusSpeaking。
//   陪伴中：以上皆非。
// React #310 安全：仅当派生 state 变化时才替换快照对象（getSnapshot
//   必须返回稳定引用，否则 useSyncExternalStore 死循环）。
// ============================================================
import { useSyncExternalStore } from 'react';

export type CharacterStatusState = 'idle' | 'thinking' | 'speaking';

export interface CharacterStatusSnapshot {
  state: CharacterStatusState;
  /** i18n key（如 status.thinking），组件经 t() 按当前 locale 求值。 */
  labelKey: string;
}

/** 稳定空快照：模块顶层构造，引用永远不变（React #310 安全）。 */
const IDLE_SNAPSHOT: CharacterStatusSnapshot = Object.freeze({ state: 'idle', labelKey: 'status.idle' });

// store 内部状态（不对外暴露，仅供派生）
let statusRunning = false;
let statusSpeaking = false;
let statusSnapshot: CharacterStatusSnapshot = IDLE_SNAPSHOT;
const statusListeners = new Set<() => void>();

/** 按优先级派生快照（speaking > thinking > idle）。 */
function deriveStatus(running: boolean, speaking: boolean): CharacterStatusSnapshot {
  if (speaking) return Object.freeze({ state: 'speaking', labelKey: 'status.speaking' });
  if (running) return Object.freeze({ state: 'thinking', labelKey: 'status.thinking' });
  return IDLE_SNAPSHOT;
}

/** 状态变化时重新派生；仅当派生 state 变化才替换快照并通知（稳定引用）。 */
function recomputeStatus(): void {
  const next = deriveStatus(statusRunning, statusSpeaking);
  if (next.state !== statusSnapshot.state) {
    statusSnapshot = next;
    for (const l of statusListeners) l();
  }
}

/** 喂入「模型正在响应」信号（think 驱动）。 */
export function setStatusRunning(v: boolean): void {
  if (v !== statusRunning) {
    statusRunning = v;
    recomputeStatus();
  }
}

/** 喂入「TTS 朗读中」信号（speaking 驱动）。 */
export function setStatusSpeaking(v: boolean): void {
  if (v !== statusSpeaking) {
    statusSpeaking = v;
    recomputeStatus();
  }
}

/** 订阅状态变化（useSyncExternalStore subscribe 侧）。 */
export function subscribeStatus(l: () => void): () => void {
  statusListeners.add(l);
  return () => {
    statusListeners.delete(l);
  };
}

/** 读取当前状态快照（稳定引用；useSyncExternalStore getSnapshot 侧）。 */
export function getStatusSnapshot(): CharacterStatusSnapshot {
  return statusSnapshot;
}

/** React hook：订阅角色状态（返回稳定快照对象，state 变化才触发重渲染）。 */
export function useCharacterStatus(): CharacterStatusSnapshot {
  return useSyncExternalStore(subscribeStatus, getStatusSnapshot);
}
