// ============================================================
// client/index.tsx — 习题模块的 browser 半区入口
//
// 两种形态（与 lecture 完全一致的两条路径）：
//   1. 独立界面（exercise profile / mac 的 lecture-launch 式入口）：
//      铺满整窗的工作台，宿主 shell 全部隐藏
//   2. 主 agent 内（Windows 日常）：侧边栏「Übungen」胶囊 → shell.overlay 浮层
//
// 判定顺序与 lecture 相同（真机踩过的坑）：
//   ① window.shell 的同步标记（Electron 壳；URL 重定向丢不掉它）
//   ② URL query/hash 标记（手动打开）
//   ③ host 注入的全局量 `__AEMEATH_EXERCISE_STANDALONE__`
//      —— 纯浏览器下 ①② 都拿不到，所以 ③ 才是 mac 上的主判据，
//         由 host 的 `webserver/index-inject` 在页面脚本之前写入。
// ============================================================

import { useEffect, useState } from 'react';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Workbench } from './workbench.tsx';
import { injectExerciseStyles } from './styles.ts';
import { installI18n, useT } from './i18n.ts';

export const name = 'aemeath-exercise-client';
export const inject = ['slots', 'locale'];

/** 打开习题界面的窗口事件名（侧栏按钮派发）。 */
export const EXERCISE_OPEN_EVENT = 'aemeath:open-exercise-mode';

interface ShellBridge {
  isExerciseWindow?: boolean;
  exercise?: {
    open(): Promise<{ ok: boolean; reason?: string }>;
    close(): Promise<{ ok: boolean }>;
    isOpen(): Promise<{ open: boolean }>;
    onStateChange(cb: (s: { open: boolean }) => void): () => void;
  };
}

function shellBridge(): ShellBridge {
  return (window as unknown as { shell?: ShellBridge }).shell ?? {};
}
function shellExercise(): ShellBridge['exercise'] | undefined {
  return shellBridge().exercise;
}

function detectStandalone(): boolean {
  const bridge = (window as unknown as { shell?: ShellBridge }).shell;
  if (bridge?.isExerciseWindow === true) return true;
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.get('aemeath_exercise') === '1') return true;
    if (/(?:^|[#&])aemeath_exercise=1(?:&|$)/.test(u.hash)) return true;
  } catch {
    /* 异常 URL：继续兜底 */
  }
  return (window as unknown as { __AEMEATH_EXERCISE_STANDALONE__?: boolean }).__AEMEATH_EXERCISE_STANDALONE__ === true;
}

/** 独立界面：整窗铺满，隐藏宿主 shell（见 lecture 的两次返工注释）。 */
function StandaloneMount(): void {
  if (typeof document === 'undefined') return;
  const HOST_ID = 'aemeath-exercise-standalone-root';
  if (document.getElementById(HOST_ID)) return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => StandaloneMount(), { once: true });
    return;
  }

  const style = document.createElement('style');
  style.textContent = `
    html, body {
      overflow: hidden !important;
      margin: 0 !important;
      height: 100% !important;
      background: var(--dsw-alias-bg-base, #eef1f6) !important;
    }
    body > *:not(#${HOST_ID}) { display: none !important; }
  `;
  document.head.appendChild(style);

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147482900;display:block;background:var(--dsw-alias-bg-base,#eef1f6);';
  document.body.appendChild(host);

  createRoot(host).render(<Workbench standalone onClose={() => shellExercise()?.close()} />);
}

export function apply(ctx: ClientContext): void {
  // i18n 先装：入口/工作台都依赖 t()。
  installI18n(ctx);

  // 样式必须在插件加载时就注入：等到组件渲染才注入的话，
  // 首帧会以 position:static 挤在页面底部（lecture 踩过这个坑）。
  injectExerciseStyles();

  const standalone = detectStandalone();
  if (standalone) {
    StandaloneMount();
    return;
  }

  function Host(): JSX.Element | null {
    const [open, setOpen] = useState(false);
    useEffect(() => {
      const onOpen = (): void => setOpen(true);
      window.addEventListener(EXERCISE_OPEN_EVENT, onOpen);
      return () => window.removeEventListener(EXERCISE_OPEN_EVENT, onOpen);
    }, []);
    if (!open) return null;
    return createPortal(<Workbench onClose={() => setOpen(false)} />, document.body);
  }

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'aemeath-exercise-mode' }, Host as never),
  );
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'aemeath-exercise-launcher', order: -106 }, Launcher as never),
  );
}

/** 侧边栏常驻入口（主 agent 内启动）。 */
function Launcher(): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const ex = shellExercise();
    if (!ex) return undefined;
    void ex.isOpen().then((s) => setOpen(!!s?.open)).catch(() => undefined);
    return ex.onStateChange((s) => setOpen(!!s?.open));
  }, []);

  const onClick = (): void => {
    const ex = shellExercise();
    if (ex) {
      void ex.open().then((r) => {
        if (!r?.ok) window.dispatchEvent(new CustomEvent(EXERCISE_OPEN_EVENT));
      });
      return;
    }
    window.dispatchEvent(new CustomEvent(EXERCISE_OPEN_EVENT));
  };

  return (
    <button
      type="button"
      title={open ? t('exercise.launcher.titleOpen') : t('exercise.launcher.title')}
      aria-label={t('exercise.launcher.aria')}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 12px 0 10px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-state-business-tertiary)',
        color: 'var(--dsw-alias-brand-text)',
        fontFamily: 'inherit',
        fontSize: 12.5,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flex: 'none',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--dsw-alias-state-business-primary, #ff8cbd), var(--dsw-alias-brand-text, #c2367b))',
          flex: 'none',
        }}
      />
      Übungen
    </button>
  );
}
