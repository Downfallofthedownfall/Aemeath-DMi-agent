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
import { installI18n, useT } from './i18n.ts';

export const name = 'aemeath-lecture-client';
export const inject = ['slots', 'locale'];

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
 * ⚠️⚠️ 真机踩过两次，方向都是"想复杂了"：
 *
 *   ① mac 上**没有输入框**（用户："我记个 der 的笔记"）。
 *      第一版把整个 dsh shell 都 `display:none` 掉，只留工作台 ——
 *      但"记笔记在主界面对话里"**只在 Windows 成立**，mac 上没有主 agent。
 *
 *   ② 我第一反应是**把 dsh 对话区整个接回来**，上下分屏。
 *      用户否掉了："不要把整个主 agent 塞进去啊，放一个输入框就完了，
 *      固定 physicist 也用不到其他乱七八糟的功能，也不要分屏，
 *      本来中间的区域就有很多空闲放一个输入框就行了。"
 *
 *   现在：**仍然独占整窗**（工作台本来就该铺满），
 *   输入框由**工作台自己的中栏**提供（见 workbench.tsx 的 Composer）。
 *   dsh shell 照旧隐藏 —— 不再需要它。
 */
function StandaloneMount(): void {
  if (typeof document === 'undefined') return;
  const HOST_ID = 'aemeath-lecture-standalone-root';
  if (document.getElementById(HOST_ID)) return;

  // body 可能尚未就绪（apply 的时机由加载器决定）→ 等 DOMContentLoaded
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => StandaloneMount(), { once: true });
    return;
  }

  // ⚠️ 背景一律引用宿主主题变量，**不要写死颜色**。
  //    曾经写死 #16181d，导致课堂窗永远是深色、不跟随宿主主题。
  const style = document.createElement('style');
  style.textContent = `
    html, body {
      overflow: hidden !important;
      margin: 0 !important;
      height: 100% !important;
      background: var(--dsw-alias-bg-base, #ffffff) !important;
    }
    /* 隐藏宿主 shell（含 sidebar / 会话列表 / 官方 composer）——
       课堂窗里这些都不需要：固定 physicist，没有会话切换，输入框是我们自己的。
       注意排除我们自己的挂载点。 */
    body > *:not(#${HOST_ID}) { display: none !important; }
  `;
  document.head.appendChild(style);

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483000;display:block;' +
    'background:var(--dsw-alias-bg-base,#ffffff);';
  document.body.appendChild(host);

  createRoot(host).render(<StandaloneApp />);
}

export function apply(ctx: ClientContext): void {
  // i18n 必须先装：下面的入口按钮/工作台都要 t()。
  installI18n(ctx);

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
  const t = useT();
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
      title={open ? t('lecture.launcher.titleOpen') : t('lecture.launcher.title')}
      aria-label={t('lecture.launcher.aria')}
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
      {t('lecture.launcher.label')}
    </button>
  );
}
