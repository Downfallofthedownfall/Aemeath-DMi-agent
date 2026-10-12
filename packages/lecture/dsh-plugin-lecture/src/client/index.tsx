// ============================================================
// client/index.ts — Lecture Mode browser 半区入口
//
// 注册一个挂在 shell.overlay 的全屏课堂界面（与记忆工作区同款做法，
// 因为宿主**没有 tab/router 系统**，overlay 是唯一的加法座位）。
//
// 入口（两个都要，用户定案 D9）：
//   1. 独立入口：lecture profile 单独启动 → 这是主界面
//   2. 主 agent 内启动：侧边栏胶囊按钮 → 派发 CustomEvent 打开本层
// 两个座位之间**不共享 React state**，靠 window CustomEvent 通信。
// ============================================================
import { useEffect, useState } from 'react';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
// 声明合并出 'shell.overlay' 等座位名（仅类型，无运行时代码）
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
// 侧边栏底栏动作位（registerSidebarFooterAction 的座位名声明）
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Workbench } from './workbench.tsx';
import { injectLectureStyles } from './styles.ts';

export const name = 'aemeath-lecture-client';
export const inject = ['slots'];

/** 打开课堂模式的窗口事件名（入口按钮派发，浏览器降级时用）。 */
export const LECTURE_OPEN_EVENT = 'aemeath:open-lecture-mode';

/** Electron 壳暴露的桥（浏览器模式下为 undefined）。 */
interface ShellBridge {
  /** 本窗口是否课堂独立窗口（preload 从 process.argv 同步读出）。 */
  isLectureWindow?: boolean;
  lecture?: {
    open(): Promise<{ ok: boolean; reason?: string }>;
    close(): Promise<{ ok: boolean }>;
    isOpen(): Promise<{ open: boolean }>;
    onStateChange(cb: (s: { open: boolean }) => void): () => void;
  };
}
function shellBridge(): ShellBridge {
  return (window as unknown as { shell?: ShellBridge }).shell ?? {};
}
function shellLecture(): ShellBridge['lecture'] | undefined {
  return shellBridge().lecture;
}

/**
 * 本页面是否跑在**课堂独立窗口**里。
 *
 * 判定顺序（可靠性从高到低）：
 *   1. `window.shell.isLectureWindow` —— preload 从 process.argv 同步读出。
 *      **这是主判据**：additionalArguments 在渲染进程启动前注入，
 *      任何 URL 跳转/重定向都丢不掉。
 *   2. URL query / hash 的 `aemeath_lecture=1`（兼容手动打开的场景）
 *   3. window 标记（兼容旧壳）
 *
 * ⚠️ 曾经用 URL query 作主判据，实测**失败**：dsh 的认证流程
 *    （?token= → 换 cookie → 303 → ./）会把 URL 重写成裸路径，
 *    query 上的标记被丢掉（location.search 变空）→ 独立窗口里渲染了主界面。
 *
 * ⚠️ 还必须在 `apply()` 里**同步**判定：晚一步就会先按主界面渲染，
 *    而座位注册是一次性的，之后改不回来。
 */
function detectStandalone(): boolean {
  // 1) preload 同步标记（首选）
  const bridge = (window as unknown as { shell?: ShellBridge }).shell;
  if (bridge?.isLectureWindow === true) return true;

  // 2) URL query / hash（手动带上标记时）
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.get('aemeath_lecture') === '1') return true;
    if (/(?:^|[#&])aemeath_lecture=1(?:&|$)/.test(u.hash)) return true;
  } catch {
    /* 异常 URL：继续兜底 */
  }

  // 3) window 标记（旧壳兼容）
  return (window as unknown as { __AEMEATH_LECTURE_STANDALONE__?: boolean })
    .__AEMEATH_LECTURE_STANDALONE__ === true;
}

/** 独立窗口里的根组件：整窗铺满的课堂界面。 */
function StandaloneApp(): JSX.Element {
  return <Workbench standalone onClose={() => shellLecture()?.close()} />;
}

/**
 * 独立窗口的挂载：把一个全屏容器插到 body，用 React root 渲染课堂界面。
 *
 * 关键（真机踩过：主界面透出来）：
 *   ① 容器必须 **fixed + inset:0 + 不透明背景** —— 只给 z-index 不够，
 *      若容器自身没有背景，宿主内容会从"课堂层没铺到的地方"透出来。
 *   ② 同时把宿主 shell 的直接子节点**隐藏**（display:none），
 *      而不是只靠层叠盖住：这样彻底不渲染、也不会有滚动条/焦点串扰。
 *      —— 课堂窗是独立窗口，宿主 UI 在这里没有任何用处。
 *   ③ 隐藏 body 滚动条。
 *
 * 幂等：重复调用只挂一次。
 */
/**
 * 独立界面模式的挂载。
 *
 * ⚠️⚠️ 真机踩过（mac 上"没有输入框，我记个 der 的笔记"）：
 *
 *   早先这里把 **整个 dsh shell 都 `display:none` 掉**，只留我们自己的工作台。
 *   但"记笔记在主界面的对话里"这个设计**只在 Windows 成立** ——
 *   那里有主 agent、有对话界面。**mac 上没有主 agent**，
 *   隐藏 shell 就等于把唯一的输入框也隐藏了 → 用户根本没法记笔记。
 *
 *   现在改成：**不再隐藏 shell**，而是把页面纵向分成两块：
 *     ┌──────────────────────────────┐
 *     │  课堂工作台（课程/笔记/符号）  │  ← 占上部
 *     ├──────────────────────────────┤
 *     │  dsh 自己的对话区 + 输入框     │  ← 保留在下方
 *     └──────────────────────────────┘
 *
 *   这样"在对话里记笔记"在 mac 上也成立：输入框就是 dsh 原生那个，
 *   爱弥斯收到内容后调 lecture_capture 落盘，工作台实时反映。
 *
 *   注意：这里**不再**把 shell 隐藏掉，所以布局必须用 flex 让两部分各占一半高度，
 *   否则 shell 会按自己的全屏样式铺满、把工作台盖住。
 */
function StandaloneMount(): void {
  if (typeof document === 'undefined') return;
  const HOST_ID = 'aemeath-lecture-standalone-root';
  const ROOT_ID = 'aemeath-lecture-shell-root';
  if (document.getElementById(HOST_ID)) return;

  // body 可能尚未就绪（apply 的时机由加载器决定）→ 等 DOMContentLoaded
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => StandaloneMount(), { once: true });
    return;
  }

  // ⚠️ 背景一律引用宿主主题变量，**不要写死颜色**。
  //    曾经写死 #16181d，导致课堂窗永远是深色、不跟随宿主主题。
  //
  // ⚠️ 顺序：工作台必须**插到 body 最前面**（order:-1），
  //    否则 dsh shell 先渲染、工作台被挤到下面，而 shell 还是全屏高度 →
  //    两者重叠、且工作台压住对话输入框（真机截图见过）。
  const style = document.createElement('style');
  style.textContent = `
    html, body {
      margin: 0 !important;
      background: var(--dsw-alias-bg-base, #ffffff) !important;
      height: 100% !important;
      overflow: hidden !important;
    }
    /* 纵向两段：工作台在上、dsh 对话区在下。
       用 flex 而不是 fixed 定位 —— 因为 shell 不再被隐藏，
       要让它们**各占一部分**而不是互相覆盖。 */
    body {
      display: flex !important;
      flex-direction: column !important;
    }
    /* 工作台：固定上半高度，且排在最前 */
    #${HOST_ID} {
      order: -1 !important;
      flex: 0 0 auto !important;
      height: 52vh !important;
      min-height: 240px !important;
      overflow: hidden !important;
      border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25)) !important;
    }
    /* dsh shell 的根节点：吃掉剩余高度，并允许内部滚动。
       ⚠️ 必须显式给 height:0 + flex:1，否则它按内容撑开（全屏）→ 溢出重叠。 */
    body > *:not(#${HOST_ID}) {
      flex: 1 1 0 !important;
      height: 0 !important;
      min-height: 0 !important;
      overflow: hidden !important;
    }
  `;
  document.head.appendChild(style);

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'display:block;background:var(--dsw-alias-bg-base,#ffffff);';
  document.body.appendChild(host);

  createRoot(host).render(<StandaloneApp />);
  void ROOT_ID; // 保留：将来若需要给 shell 根节点加标记
}

export function apply(ctx: ClientContext): void {
  // ⚠️ 样式必须在**插件加载时**就注入，不能等到 Host 渲染时——
  //    真机踩过：只写 ensureStyles() 但没调用，导致 .aem-lec 的 CSS 完全没生效，
  //    面板以 position:static 被挤到页面底部（DOM 在、看上去"没打开"）。
  injectLectureStyles();

  // ── 模式判定：preload 的同步标记（见 detectStandalone 的注释）──
  const standalone = detectStandalone();

  if (standalone) {
    // 独立窗口：**不挂任何座位**，直接把课堂界面挂到 document.body 上。
    //
    // 为什么不用 ctx.slots.register('root')：'root' 是框架自己的
    // 「render tree's root hole」（single/singleton，见 dsh-client-ui-slots
    // 的 SlotCore 注释）——插件往那里注册会与 shell 抢根节点。
    StandaloneMount();
    return;
  }

  // ── 主窗口：侧边栏入口 ──
  // 有壳桥 → 点按钮开**独立窗口**（用户要的形态）；
  // 无壳桥（浏览器）→ 降级为侧边面板（原有行为）。
  function Host(): JSX.Element | null {
    const [open, setOpen] = useState(false);
    useEffect(() => {
      const onOpen = (): void => setOpen(true);
      window.addEventListener(LECTURE_OPEN_EVENT, onOpen);
      return () => window.removeEventListener(LECTURE_OPEN_EVENT, onOpen);
    }, []);
    if (!open) return null;
    return createPortal(<Workbench onClose={() => setOpen(false)} />, document.body);
  }

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'aemeath-lecture-mode' }, Host as never),
  );
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'aemeath-lecture-launcher', order: -105 },
      Launcher as never,
    ),
  );
}

/** 侧边栏常驻入口按钮（主 agent 内启动，D9）。 */
function Launcher(): JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const lecture = shellLecture();
    if (!lecture) return undefined;
    void lecture.isOpen().then((s) => setOpen(!!s?.open)).catch(() => undefined);
    return lecture.onStateChange((s) => setOpen(!!s?.open));
  }, []);

  const onClick = (): void => {
    const lecture = shellLecture();
    if (lecture) {
      // 独立窗口模式：开/聚焦窗口
      void lecture.open().then((r) => {
        if (!r?.ok) {
          // 拿不到认证 URL（复用了外部 dsh 实例）→ 退回面板，至少能用
          window.dispatchEvent(new CustomEvent(LECTURE_OPEN_EVENT));
        }
      });
      return;
    }
    // 浏览器降级：面板
    window.dispatchEvent(new CustomEvent(LECTURE_OPEN_EVENT));
  };

  return (
    <button
      type="button"
      title={open ? '课堂记录（窗口已打开）' : '课堂记录'}
      aria-label="课堂记录"
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
          background: 'linear-gradient(135deg, #8ec5ff, #4a90e2)',
          flex: 'none',
        }}
      />
      课堂
    </button>
  );
}
