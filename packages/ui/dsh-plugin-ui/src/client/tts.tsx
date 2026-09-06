// ============================================================
// TTS 朗读（M5 F6 → 2026-08-17 重写）
// 引擎：后端 IndexTTS2（host POST /aemeath/api/tts → tts HTTP 服务 → wav base64）。
//   背景：Electron 渲染器 Web Speech API 无系统语音（getVoices()=0，speak 无声），
//   浏览器自带 TTS 在此环境不可用，故改走后端引擎。
// 组件：
//   1. TtsAction —— assistant 消息操作区「朗读」按钮（受 aemeath-tts.enabled 门控）
//   2. TtsToggle —— 对话输入框工具行（conversation.input.right）的 TTS 开关
//   3. 未配置 IndexTTS2 路径时：开启开关/点击朗读 → Toast 弹提示
// 文本获取：点击时从 DOM 读取按钮所在消息气泡的文本（零数据依赖）。
// ============================================================
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { t, useLocale } from './i18n.ts';

/** 注入 face：settings scopes（读/写 aemeath-tts.enabled）+ messageId → 消息文本解析器。 */
export interface TtsDeps {
  scopes: Record<string, SettingsScope<Record<string, unknown>>>;
  /**
   * 通过 messageId 从会话快照解析 assistant 消息文本（可靠方案，2026-08-17）。
   * DOM 向上抓取在 dsh 渲染结构下不可靠（按钮祖先链不含消息文本）。
   */
  resolveMessageText?: (messageId: string) => string | undefined;
}

/** 模块级解析器引用（自动朗读观察器与按钮共用）。 */
let resolveMessageTextFn: ((messageId: string) => string | undefined) | null = null;

const TTS_NS = 'aemeath-tts';

// ============================================================
// 后端调用
// ============================================================

/** 合成文本 → base64 wav。首次调用需加载模型（1-3 分钟），超时放宽到 200s。 */
async function synthesize(text: string): Promise<string> {
  const res = await fetch('/aemeath/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(200000),
  });
  const d = (await res.json()) as { ok?: boolean; audio_base64?: string; code?: string; error?: string };
  if (!res.ok || !d.ok || !d.audio_base64) {
    // host 返回稳定错误码 → 按 active locale 本地化；无映射回退 error 原文
    throw new Error(localizeError(d.code, d.error, { status: res.status }));
  }
  return d.audio_base64;
}

/** 按错误码本地化 host 错误文案（映射表见 locales.ts errors.*）。 */
function localizeError(code: string | undefined, fallback: string | undefined, params?: Record<string, unknown>): string {
  if (code) {
    const key = `errors.${code}`;
    const resolved = t(key, params);
    if (resolved !== key) return resolved;
  }
  return fallback ?? t('tts.error.failed', { status: params?.status ?? '-' });
}

/** 配置状态（未配置 → 前端弹提示）。 */
async function ttsStatus(): Promise<{ configured: boolean; error?: string }> {
  try {
    const res = await fetch('/aemeath/api/tts/status', { signal: AbortSignal.timeout(8000) });
    const d = (await res.json()) as { ok?: boolean; configured?: boolean; pythonExists?: boolean; modelConfigExists?: boolean; voiceCount?: number };
    if (!res.ok || !d.ok) return { configured: false };
    return { configured: !!d.configured };
  } catch {
    return { configured: false };
  }
}

// ============================================================
// 模型懒加载 popup（开启/首次朗读时：简易计时 + 卡 99% 进度条）
// 目的：IndexTTS2 首次加载 3.4GB 模型需 1-3 分钟，给用户可见的
//       进度反馈（计时器一直在走、进度条停在 99%），避免误以为卡死。
// ============================================================
let warmState: 'unknown' | 'loading' | 'ready' = 'unknown';
let warmPromise: Promise<void> | null = null;
let loadEl: HTMLDivElement | null = null;
let loadTimerHandle: ReturnType<typeof setInterval> | null = null;
let loadStart = 0;

/** 弹出模型加载 popup（幂等）。startedAt 为预热发起时刻，计时从此刻算起。 */
function showLoadingPopup(startedAt: number): void {
  if (loadEl) return;
  loadStart = startedAt;
  loadEl = document.createElement('div');
  loadEl.setAttribute('role', 'status');
  // 注意：cssText 必须用 CSS 属性名 z-index（zIndex 驼峰只用于 JSX 内联样式，
  // 写在 cssText 里会被忽略 → popup 无层级 → 被输入框遮挡，2026-08-17 修复）
  loadEl.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'display:flex', 'alignItems:center', 'justifyContent:center',
    'background:rgba(0,0,0,0.28)',
  ].join(';');
  loadEl.innerHTML = `
    <div style="width:360px;max-width:calc(100vw - 40px);padding:18px 20px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;box-shadow:0 12px 40px rgba(0,0,0,0.18)">
      <div style="font-weight:700;font-size:14px;margin-bottom:6px">${t('tts.loading.title')}</div>
      <div style="color:var(--dsw-alias-label-secondary);line-height:1.6;margin-bottom:12px">${t('tts.loading.desc')}</div>
      <div style="height:6px;border-radius:3px;background:var(--dsw-alias-border-l2);overflow:hidden;margin-bottom:8px">
        <div id="aemeath-tts-load-bar" style="height:100%;width:0;border-radius:3px;background:var(--dsw-alias-state-business-primary);transition:width 2.5s ease-out"></div>
      </div>
      <div style="display:flex;justify-content:space-between;color:var(--dsw-alias-label-tertiary);font-size:12px">
        <span id="aemeath-tts-load-timer">${t('tts.loading.waiting', { time: '00:00' })}</span>
      </div>
    </div>`;
  document.body.appendChild(loadEl);
  // 进度条卡在 99%（真实进度不可知，99% 表示"快好了，别关"）
  requestAnimationFrame(() => {
    const bar = loadEl?.querySelector('#aemeath-tts-load-bar') as HTMLDivElement | null;
    if (bar) bar.style.width = '99%';
  });
  loadTimerHandle = setInterval(() => {
    if (!loadEl) return;
    const s = Math.floor((Date.now() - loadStart) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    const timerEl = loadEl.querySelector('#aemeath-tts-load-timer');
    if (timerEl) timerEl.textContent = t('tts.loading.waiting', { time: `${mm}:${ss}` });
  }, 1000);
}

/** 关闭模型加载 popup。 */
function closeLoadingPopup(): void {
  if (loadTimerHandle) {
    clearInterval(loadTimerHandle);
    loadTimerHandle = null;
  }
  loadEl?.remove();
  loadEl = null;
}

/** 懒加载预热：首次调用触发模型加载；已就绪则直接返回。 */
async function ensureWarm(): Promise<void> {
  if (warmState === 'ready') return;
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    const started = Date.now();
    // 延迟弹出：1.2s 内完成（模型已加载/预热完成）不弹 popup——避免"假进度条"；
    // 真正加载（1-3 分钟）才弹，计时从发起时刻算起。
    const popupTimer = setTimeout(() => showLoadingPopup(started), 1200);
    try {
      const res = await fetch('/aemeath/api/tts/warmup', { method: 'POST', signal: AbortSignal.timeout(240000) });
      const d = (await res.json()) as { ok?: boolean; model_loaded?: boolean; error?: string };
      if (!res.ok || !d.ok || !d.model_loaded) throw new Error(d.error ?? t('tts.error.modelLoadFailed'));
      warmState = 'ready';
    } finally {
      clearTimeout(popupTimer);
      closeLoadingPopup();
      warmPromise = null;
    }
  })();
  return warmPromise;
}

// ============================================================
// 共享播放控制器（手动按钮 + 自动朗读共用；新播放会中止旧的）
// ============================================================
let currentAudio: HTMLAudioElement | null = null;
let speakingFlag = false;
let speakingVersion = 0;
let ttsVolume = 1; // 音量 0~1（settings aemeath-tts.volume 同步）
const speakingListeners = new Set<() => void>();

/** 同步音量（0~1 归一化）。 */
function setTtsVolume(v: number): void {
  ttsVolume = typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  if (currentAudio) currentAudio.volume = ttsVolume; // 播放中实时生效
}

function notifySpeaking(): void {
  speakingVersion++;
  for (const l of speakingListeners) l();
}

function subscribeSpeaking(l: () => void): () => void {
  speakingListeners.add(l);
  return () => {
    speakingListeners.delete(l);
  };
}

function getSpeaking(): boolean {
  return speakingFlag;
}

/** 中止当前播放（手动按钮/关闭开关时用）。 */
function stopPlayback(): void {
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
  if (speakingFlag) {
    speakingFlag = false;
    notifySpeaking();
  }
}

/** 播放 base64 wav（替换当前播放）。 */
function playAudio(b64: string): void {
  stopPlayback();
  const audio = playBase64Wav(b64);
  audio.volume = ttsVolume; // 应用音量设置
  currentAudio = audio;
  speakingFlag = true;
  notifySpeaking();
  audio.onended = () => {
    if (currentAudio === audio) {
      currentAudio = null;
      speakingFlag = false;
      notifySpeaking();
    }
  };
  audio.onerror = () => {
    if (currentAudio === audio) {
      currentAudio = null;
      speakingFlag = false;
      notifySpeaking();
    }
    showToast(t('tts.error.playFailed'));
  };
}

/** 合成并朗读一段文本（手动/自动共用）。 */
async function speakText(text: string): Promise<void> {
  try {
    await ensureWarm();
    const b64 = await synthesize(text);
    console.log('[aemeath-tts] 合成成功, base64 长度=', b64.length);
    playAudio(b64);
  } catch (err) {
    console.error('[aemeath-tts] 朗读失败:', err);
    showToast((err as Error).message || t('tts.error.failed', { status: '-' }));
  }
}

// ============================================================
// 自动朗读：TTS 开启后，新出现的 assistant 回复自动播放
// 机制：MutationObserver 监听带 [data-aemeath-tts] 标记的朗读按钮。
//   开启开关时对现有消息做快照（历史不读）；开启后新出现的气泡 → 自动朗读。
//   关闭开关 → 停止播放且不再自动读。
// ============================================================
let ttsEnabledFlag = false;
let autoSnapshotTaken = false;
// 【临时禁用】自动朗读 bug 多（不第一时间触发 / 乱字块等），先按用户要求关闭自动播放；手动朗读按钮仍可用。
// 恢复：把 AUTOPLAY_DISABLED 置为 false 即可（观察器逻辑保留）。
const AUTOPLAY_DISABLED = true;
let autoObserver: MutationObserver | null = null;
const seenAutoButtons = new WeakSet<Element>();

function setTtsEnabledFlag(v: boolean): void {
  const changed = v !== ttsEnabledFlag;
  ttsEnabledFlag = v;
  if (v && !AUTOPLAY_DISABLED) {
    // 开启瞬间快照：把已存在的朗读按钮标记为"历史"，不自动读
    if (!autoSnapshotTaken) {
      autoSnapshotTaken = true;
      if (typeof document !== 'undefined') {
        document.querySelectorAll('[data-aemeath-tts]').forEach((b) => seenAutoButtons.add(b));
        console.log('[aemeath-tts] 自动朗读快照：现有消息标记为历史');
      }
    }
  } else {
    stopPlayback();
  }
  if (changed) console.log('[aemeath-tts] 自动朗读 enabled=', v);
}

/** 初始化自动朗读观察器（registerTts 时调用一次）。 */
function initAutoReader(): void {
  // 【临时禁用】自动朗读 bug 多，先关；手动朗读按钮仍可用。
  if (AUTOPLAY_DISABLED) {
    console.log('[aemeath-tts] 自动朗读已临时禁用（AUTOPLAY_DISABLED）；手动朗读仍可用');
    return;
  }
  if (autoObserver || typeof document === 'undefined' || !('MutationObserver' in window)) return;
  autoObserver = new MutationObserver((mutations) => {
    if (!ttsEnabledFlag || !autoSnapshotTaken) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        let btns: NodeListOf<Element>;
        try {
          btns = node.querySelectorAll('[data-aemeath-tts]');
        } catch {
          continue;
        }
        for (const btn of btns) {
          if (seenAutoButtons.has(btn)) continue;
          seenAutoButtons.add(btn);
          // 优先按 messageId 从会话快照取文本；无 messageId 退回 DOM 抓取
          const mid = btn.getAttribute('data-message-id') ?? '';
          const text = (mid && resolveMessageTextFn?.(mid)) || readMessageText(btn as HTMLElement);
          if (text && text.length >= 2) {
            console.log('[aemeath-tts] 自动朗读新回复:', text.slice(0, 40));
            void speakText(text);
          }
        }
      }
    }
  });
  autoObserver.observe(document.body, { childList: true, subtree: true });
  console.log('[aemeath-tts] 自动朗读观察器已启动');
}

// ============================================================
// Toast（轻量全局提示：未配置 TTS 时弹提示）
// ============================================================
let toastEl: HTMLDivElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** 弹一个自动消失的全局提示（底部居中）。 */
export function showToast(msg: string): void {
  if (typeof document === 'undefined') return;
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.setAttribute('role', 'status');
    // cssText 里用 CSS 属性名 z-index（驼峰 zIndex 会被忽略 → 层级失效，2026-08-17 修复）
    toastEl.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:96px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'maxWidth:min(480px,calc(100vw - 32px))',
      'padding:10px 16px',
      'borderRadius:10px',
      'border:1px solid var(--dsw-alias-border-l2)',
      'background:var(--dsw-alias-bg-base)',
      'color:var(--dsw-alias-label-primary)',
      'fontSize:13px',
      'lineHeight:1.5',
      'boxShadow:0 8px 24px rgba(0,0,0,0.12)',
      'transition:opacity 240ms',
      'whiteSpace:pre-wrap',
    ].join(';');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.style.opacity = '0';
    setTimeout(() => {
      toastEl?.remove();
      toastEl = null;
    }, 260);
  }, 4200);
}

// ============================================================
// 公共工具
// ============================================================

/**
 * 清理消息文本：剔除 dsh UI 的统计/元数据段（回合尾部状态条），只留真实消息内容。
 * 2026-08-17：最初按"行过滤"实现——但消息正文与统计条常在同一段文本里
 * （"你好…20:47 · 用时 1秒 · 首 token 0.9秒 · 84 tok/s"），按行过滤会连同
 * 消息一起删光 → 提取为空 → 报"未找到可朗读的消息文本"。改为仅替换统计段。
 */
const TTS_STATS_SEGMENT =
  /(?:^\s*\d{1,2}:\d{2}\s*·\s*)?(?:·\s*)?用时\s*[\d.]+\s*秒\s*·\s*首\s*token\s*[\d.]+\s*秒\s*·\s*[\d.]+\s*tok\/s/g;

function cleanMessageText(raw: string): string {
  return (raw || '')
    .replace(/^\s*\d{1,2}:\d{2}\s*·\s*/, '') // 行首时间戳
    .replace(TTS_STATS_SEGMENT, '') // 完整统计段（可能嵌在消息文本中间）
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 点击时从 DOM 向上找消息气泡文本。
 * 2026-08-17 修复：原实现要求 `!hasControls`（容器内无按钮）才采信——但朗读按钮
 * 本身就渲染在消息气泡里，气泡必然含按钮，该条件永不满足 → 永远回退到相邻文本
 * （动作行，图标按钮无 textContent）→ 返回空串 → 点击静默无反应。去掉该限制，
 * 并清理统计行（见 cleanMessageText）。
 */
function readMessageText(el: HTMLElement): string {
  let node: HTMLElement | null = el;
  for (let i = 0; i < 10 && node; i++) {
    node = node.parentElement;
    if (!node) break;
    const raw = (node.textContent ?? '').trim();
    const text = cleanMessageText(raw);
    if (text.length > 20 && !text.includes('Session log') && !text.includes('上下文注入') && !text.includes('对话已压缩')) {
      return text;
    }
  }
  // 兜底：取按钮所在行的直接文本（同样清理）
  return cleanMessageText(el.parentElement?.textContent ?? '');
}

/** 播放 base64 wav；返回 Promise（结束时 resolve，出错 reject）。 */
function playBase64Wav(b64: string): HTMLAudioElement {
  const audio = new Audio(`data:audio/wav;base64,${b64}`);
  audio.play().catch(() => undefined); // 失败由 onerror 兜底
  return audio;
}

const noopSubscribe = (): (() => void) => () => void 0;
const emptySnap = (): SettingsScopeSnapshot<Record<string, unknown>> => ({
  status: 'loading',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory',
});

/** 读取 aemeath-tts.enabled（默认 false，2026-08-17：开关初始关闭），可订阅。 */
function useTtsEnabled(scopes?: Record<string, SettingsScope<Record<string, unknown>>>): boolean {
  const scope = scopes?.[TTS_NS];
  const snap = useSyncExternalStore(scope ? scope.subscribe : noopSubscribe, scope ? scope.getSnapshot : emptySnap);
  const val = snap?.value as { enabled?: boolean } | undefined;
  return val?.enabled ?? false;
}

/** 读取 aemeath-tts.volume（默认 1，0~1），可订阅。 */
function useTtsVolume(scopes?: Record<string, SettingsScope<Record<string, unknown>>>): number {
  const scope = scopes?.[TTS_NS];
  const snap = useSyncExternalStore(scope ? scope.subscribe : noopSubscribe, scope ? scope.getSnapshot : emptySnap);
  const val = snap?.value as { volume?: number } | undefined;
  const v = val?.volume;
  return typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

// ============================================================
// 朗读按钮（assistant 消息操作区）
// ============================================================
export function TtsAction({ scopes, messageId }: TtsDeps & { messageId?: string }): JSX.Element | null {
  const enabled = useTtsEnabled(scopes);
  const [synthesizing, setSynthesizing] = useState(false);
  const busyRef = useRef(false);
  const speaking = useSyncExternalStore(subscribeSpeaking, getSpeaking);
  useLocale(); // locale 切换时刷新按钮文案
  console.log('[aemeath-tts] 朗读按钮渲染, enabled=', enabled, 'messageId=', messageId ? messageId.slice(0, 8) : '(无)');

  // 卸载清理：本组件不持有音频（共享控制器），仅重置本地忙标志
  useEffect(() => {
    return () => {
      busyRef.current = false;
    };
  }, []);

  if (!enabled) return null;
  if (typeof window === 'undefined') return null;

  const toggle = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    console.log('[aemeath-tts] 点击朗读按钮, busy=', busyRef.current, 'speaking=', speaking);
    if (busyRef.current) return;
    // 正在朗读（含自动朗读）→ 点击即中止
    if (speaking) {
      console.log('[aemeath-tts] 停止朗读');
      stopPlayback();
      return;
    }
    // 优先按 messageId 从会话快照取文本（可靠）；失败退回 DOM 抓取
    const text = (messageId && resolveMessageTextFn?.(messageId)) || readMessageText(e.currentTarget);
    console.log('[aemeath-tts] 提取文本 len=', text.length, 'text="', text.slice(0, 60), '"');
    if (!text) {
      showToast(t('tts.error.noMessage'));
      return;
    }
    busyRef.current = true;
    setSynthesizing(true);
    try {
      await speakText(text);
    } finally {
      busyRef.current = false;
      setSynthesizing(false);
    }
  };

  return (
    <button
      type="button"
      data-aemeath-tts
      data-message-id={messageId ?? ''}
      onClick={(e) => void toggle(e)}
      aria-label={speaking ? t('tts.stop') : t('tts.speak')}
      title={speaking ? t('tts.stop') : synthesizing ? t('tts.synthesizing') : t('tts.speak.title')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 28,
        border: 'none',
        cursor: synthesizing ? 'default' : 'pointer',
        background: 'transparent',
        color: speaking ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)',
        opacity: synthesizing ? 0.6 : 1,
      }}
    >
      {synthesizing ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ animation: 'aemeath-spin 900ms linear infinite' }}>
          <path d="M7 1.5a5.5 5.5 0 1 0 5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      ) : speaking ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M2 5.5v3h2.2L8 11.5v-9L4.2 5.5H2z" fill="currentColor" />
          <path d="M10 5c.6.6 1 1.3 1 2s-.4 1.4-1 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M11.5 3.5c1 1.1 1.5 2.2 1.5 3.5s-.5 2.4-1.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

// ============================================================
// 对话输入框 TTS 开关（conversation.input.right）
// ============================================================
export function TtsToggle(props: TtsDeps): JSX.Element | null {
  const enabled = useTtsEnabled(props.scopes);
  const volume = useTtsVolume(props.scopes);
  const [busy, setBusy] = useState(false);
  const scope = props.scopes?.[TTS_NS];
  useLocale(); // locale 切换时刷新开关文案
  console.log('[aemeath-tts] 开关渲染, enabled=', enabled, 'volume=', volume, 'scope?=', !!scope);

  // 同步自动朗读开关状态（关闭时停止播放）
  useEffect(() => {
    setTtsEnabledFlag(enabled);
  }, [enabled]);

  // 同步音量
  useEffect(() => {
    setTtsVolume(volume);
  }, [volume]);

  if (!scope) return null;

  const toggle = async (): Promise<void> => {
    console.log('[aemeath-tts] 点击开关, 当前 enabled=', enabled, 'busy=', busy);
    if (busy) return;
    const next = !enabled;
    if (next) {
      // 开启前检查后端配置；未配置 → 弹提示且不开启
      const st = await ttsStatus();
      console.log('[aemeath-tts] 配置检查:', JSON.stringify(st));
      if (!st.configured) {
        showToast(t('tts.error.notConfigured'));
        return;
      }
    }
    setBusy(true);
    try {
      if (next) {
        // 懒加载预热（首次弹「加载模型」popup：计时 + 99% 进度条）
        await ensureWarm();
        console.log('[aemeath-tts] 预热完成，写入 enabled=true');
      }
      await scope.set('enabled', next);
      console.log('[aemeath-tts] 开关写入完成 enabled=', next);
    } catch (e) {
      console.error('[aemeath-tts] 开关流程失败:', e);
      showToast(t('tts.error.modelLoadFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={t('tts.toggle.aria')}
        title={enabled ? t('tts.toggle.title.on') : t('tts.toggle.title.off')}
        onClick={() => void toggle()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 5,
          height: 26,
          padding: '0 8px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2)',
          cursor: 'pointer',
          background: enabled ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent)' : 'var(--dsw-alias-bg-base)',
          color: enabled ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)',
          fontSize: 12,
          fontWeight: 600,
          opacity: busy ? 0.6 : 1,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M2 5.5v3h2.2L8 11.5v-9L4.2 5.5H2z" fill="currentColor" />
          <path d="M10 5c.6.6 1 1.3 1 2s-.4 1.4-1 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          {enabled ? <path d="M11.5 3.5c1 1.1 1.5 2.2 1.5 3.5s-.5 2.4-1.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /> : <line x1="2.5" y1="2.5" x2="11.5" y2="11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
        </svg>
        {t('tts.speak')}
      </button>
      {/* 音量滑块（0~100） */}
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round((volume ?? 1) * 100)}
        aria-label={t('tts.volume.aria')}
        title={t('tts.volume.title', { pct: Math.round((volume ?? 1) * 100) })}
        onChange={(e) => void scope.set('volume', Number(e.target.value) / 100).catch(() => undefined)}
        style={{
          width: 64,
          height: 20,
          cursor: 'pointer',
          accentColor: 'var(--dsw-alias-state-business-primary)',
        }}
      />
    </div>
  );
}

// ============================================================
// 注册：朗读按钮（assistant 消息）+ 输入框开关
// ============================================================
export function registerTts(ctx: ClientContext, deps: () => TtsDeps): void {
  // 捕获 messageId → 文本解析器（自动朗读观察器与按钮共用）
  const depsObj = deps();
  resolveMessageTextFn = depsObj.resolveMessageText ?? null;
  // 合成中 spinner 的 keyframes（幂等注入一次）
  if (typeof document !== 'undefined' && !document.getElementById('aemeath-tts-styles')) {
    const st = document.createElement('style');
    st.id = 'aemeath-tts-styles';
    st.textContent = '@keyframes aemeath-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
    document.head.appendChild(st);
  }
  // 自动朗读观察器（TTS 开启后新回复自动播放）
  initAutoReader();
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.assistant-actions',
        id: 'aemeath-tts',
        order: 100,
        inject: deps,
      },
      TtsAction as never,
    ),
  );
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'aemeath-tts-toggle',
        order: 100,
        inject: deps,
      },
      TtsToggle as never,
    ),
  );
}
