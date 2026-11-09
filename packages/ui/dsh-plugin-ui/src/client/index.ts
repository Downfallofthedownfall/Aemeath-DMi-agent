// ============================================================
// dsh-plugin-ui · browser 半区入口（M5 → UI 改造 P2）
// 组装：设计系统（fluent + de-dsh）→ 主题（亮色）→ 品牌 → 会话列表
//       → 欢迎屏（角色卡片）→ TTS → 设置页 / 快速设置（P3）
// 数据 face（settings/role/credentials/scopes）统一由 faces.ts 工厂构建。
// ============================================================
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { mainSessionIdOf } from './main-session.ts';
import { installI18n, reportLocaleToHost, currentActiveLocale } from './i18n.ts';
import { registerThemes } from './theme.ts';
import { applyBrand } from './brand.tsx';
import { registerSettingsSection, FEATURES } from './settings.tsx';
import { registerSessionList } from './sessions.tsx';
import { registerHero } from './hero.tsx';
import { registerTts } from './tts.tsx';
import { registerQuickSettings } from './quick-settings.tsx';
import { registerWorkspaceSelector } from './workspace-selector.tsx';
import { registerCharacterStatus } from './status.tsx';
import { registerWorkflowTodo } from './workflow-todo.tsx';
import { registerComposerCards } from './composer-cards.tsx';
import { registerModeSwitch } from './mode-switch.tsx';
import { registerMemoryWorkspace, registerMemoryLauncher } from './memory-workspace.tsx';
import { injectFluentStyles } from './styles/fluent.ts';
import { injectDeDshStyles } from './styles/de-dsh.ts';
import { createFaces } from './faces.ts';
import { installAppearance } from './appearance.ts';
export { FEATURE_NAMESPACES } from './constants.ts';

export const name = 'aemeath-ui';
// DSH 0.2.0：新增 uiWorkspace（会话/工作区导航，接管已移除的 ctx.sessions.open）。
// ⚠️ remote.credentials 必须单独声明：cordis 把它当独立服务，只写 'remote' 时
//   读 ctx.remote.credentials 会抛 "cannot get property ... without inject"，
//   结果 API Key 保存必报错、徽章永远"未配置"。
export const inject = ['slots', 'theme', 'connection', 'remote', 'remote.credentials', 'sessions', 'workspaces', 'locale', 'uiWorkspace'];

export function apply(ctx: ClientContext): void {
  // 0) i18n：注册 aemeath 三语字典（zh/en/de）并绑定 t()（最先执行，供各组件使用）
  installI18n(ctx);

  // 0.5) 设计系统基础层（Win11 fluent token + dsh 覆盖注册表）——最先注入，避免闪烁
  injectFluentStyles();
  injectDeDshStyles();

  // 0.5) 数据 face（settings 桥 / 角色 / 凭据 / scopes）——一次构建，多处复用
  const faces = createFaces(ctx);

  // 0.6) 外观设置全局生效（不依赖设置页打开过）
  const appearanceScope = faces.scopes.get('aemeath-ui');
  if (appearanceScope) installAppearance(ctx, appearanceScope);

  // 1) 主题（幂等；默认亮色映射见 theme.ts）
  registerThemes(ctx as never);

  // 2) 品牌层（标题 + 隐藏 dsh logo；侧边栏品牌位见 sessions.tsx）
  applyBrand(ctx);

  // 2.5) 会话列表 + 品牌头部（shadow 官方 workspace 浏览器）
  registerSessionList(ctx);

  // 2.6) 欢迎屏（问候语 + 角色卡片）
  registerHero(ctx, {
    role: () => faces.role,
    blankPreset: {
      subscribe: (l) => ctx.sessions.list.subscribe(l),
      get: () => {
        const list = ctx.sessions.list.getSnapshot();
        const id = mainSessionIdOf(list);
        const summary = id ? list.byId[id as never] : undefined;
        const preset = summary?.blank ? (summary.projectionValues as { agentPreset?: unknown } | undefined)?.agentPreset : undefined;
        return typeof preset === 'string' ? preset : undefined;
      },
    },
  });

  // 2.7) TTS 朗读按钮（assistant 消息操作区）+ 输入框 TTS 开关（conversation.input.right）
  //   resolveMessageText：按 messageId 从会话事件流取 assistant 消息原文（DOM 抓取只作兜底）。
  //   ⚠️ 早先读私有的 sessions.manager + 不存在的 list.current + 0.1 的 nodes 结构，
  //      在 0.2.x 下永远返回 undefined —— 每次都静默退回 DOM 抓取。现在只走公开 API：
  //      sessions.binding(会话).eventSource 里的 `assistant/message` 事件，message.id 即 messageId。
  const resolveMessageText = (messageId: string, sessionId?: string): string | undefined => {
    try {
      const sessions = ctx.sessions;
      const sid = sessionId ?? mainSessionIdOf(sessions.list.getSnapshot());
      if (!sid) return undefined;
      const entries = sessions.binding(sid as never)?.eventSource.getSnapshot().entries ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.type !== 'event' || entry.event.type !== 'assistant/message') continue;
        const message = (entry.event as SessionEvent<'assistant/message'>).data.message;
        if (message.id !== messageId) continue;
        const text = message.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
          .trim();
        return text || undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };
  registerTts(ctx, () => ({ scopes: Object.fromEntries(faces.scopes), resolveMessageText }));

  // 2.8) 快速设置面板（侧边栏底部齿轮：角色 + 开关 + 记忆摘要 + API 徽章）
  registerQuickSettings(ctx, () => ({
    role: faces.role,
    scopes: Object.fromEntries(faces.scopes),
    credentials: {
      views: faces.credentials.views,
      refresh: () => void faces.credentials.refresh(),
      // C11：透传订阅能力，徽章在保存/清除 key 后实时刷新
      subscribe: faces.credentials.subscribe,
      getSnapshot: faces.credentials.getSnapshot,
    },
  }));

  // 2.9) 工作区选择器（仅输入框工具行 chip，用户要求：dropdown 只保留对话框的）
  // DSH 0.2.0：ISessions 不再有 open()（导航移交视图所有者），改用 uiWorkspace.openSession。
  // ⚠️ 真机踩过（"切换工作区显示 workspaces.startSession is not a function"）：
  //   0.2.x 的 ctx.workspaces（IWorkspaces）只剩数据操作（create/rename/archive…），
  //   startSession / pickDirectory 都搬到了 ctx.uiWorkspace。原先整个 ctx.workspaces
  //   以 `as never` 塞进来，类型检查被绕过 —— 点任一工作区、选文件夹都直接抛错。
  //   这里逐个方法接到真正的提供者上，不再整体强转。
  registerWorkspaceSelector(ctx, {
    workspaces: {
      startSession: (id) => ctx.uiWorkspace.startSession(id as never),
      pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
      create: (input) => ctx.workspaces.create(input),
    },
    openSession: (id: string) => ctx.uiWorkspace.openSession(id as never),
  });

  // 2.9.5) 零工作区时的默认工作区由 dsh 0.2.1 的 ui-workspace 自己初始化（见 bootstrap.ts 的说明）

  // 2.9.6) 角色状态 pill（会话顶栏：头像+名字+状态徽章）+ 浮动状态簇（右下角）
  //   状态信号：思考中=useSession.running；朗读中=tts speak；其余=陪伴中（见 status.tsx）
  registerCharacterStatus(ctx, () => ({
    scopes: Object.fromEntries(faces.scopes),
  }));

  // 2.9.6.5) 解题计划浮卡（feature #5）：当前会话 workflow.plan 步骤 + 进度，可拖动/折叠。
  //   数据只读 host /aemeath/api/memory 的 plans（workflow.plan scratch），非空且未隐藏才显示。
  registerWorkflowTodo(ctx);

  // 2.9.6.6) 输入区交互卡宿主（feature #6）：composer 上方浮卡（runId 路由 + 结算清除），
  //   当前真实信号 = 计划确认卡（复用 /aemeath/api/memory plans；动作仅结算/隐藏）。
  registerComposerCards(ctx);

  // 2.9.7) 会话顶栏 · 分段角色切换（ModeSwitch 芯片：与 hero/quick-settings 共用 role face，
  //   保持同步，不冲突；点击 → role.set → agent-presets.default，镜像到 localStorage）
  //   顶栏跟随**当前打开的对话**的角色（翻看历史对话时随之切换）：角色读会话列表投影
  //   byId[id].projectionValues.agentPreset（与侧栏人格标签同一路径）；
  //   在历史对话里点另一个角色 = 用那个角色开新对话（uiWorkspace.startSession 的 agentPreset）。
  //   只构建一次：inject 每次都调 deps()，subscribe 引用变了 useSyncExternalStore 会反复重订阅。
  const sessionRole = {
    subscribe: (l: () => void) => ctx.sessions.list.subscribe(l),
    presetOf: (sessionId: string): string | undefined => {
      if (!sessionId) return undefined;
      const summary = ctx.sessions.list.getSnapshot().byId[sessionId as never];
      if (!summary || summary.blank) return undefined;
      const preset = (summary.projectionValues as { agentPreset?: unknown } | undefined)?.agentPreset;
      return typeof preset === 'string' && preset ? preset : undefined;
    },
    startWith: (preset: string) => ctx.uiWorkspace.startSession(undefined, { agentPreset: preset }),
  };
  registerModeSwitch(ctx, () => ({
    role: faces.role,
    sessionRole,
  }));

  // 2.9.8) 记忆工作区（五页全屏层，借 ripples-of-aion 面板的信息架构）：
  //   挂在 shell.overlay 加法座位；入口是侧边栏底部**常驻的粉点胶囊按钮**（派发自定义事件打开；
  //   原先只在快速设置弹层里放一行文字，用户反馈"太不显眼"）。
  //   数据全部走 /aemeath/api/memory 代理，前端不持有 memory 插件的 admin token。
  registerMemoryWorkspace(ctx);
  registerMemoryLauncher(ctx);

  // 3) 设置页（P3 瘦身：功能开关 / 记忆管理 / API key；角色已前移主界面）
  registerSettingsSection(ctx, {
    scopes: () => Object.fromEntries(faces.scopes),
    credentials: () => ({
      views: faces.credentials.views,
      refresh: () => void faces.credentials.refresh(),
      set: faces.credentials.set,
      unset: faces.credentials.unset,
      // C11：透传订阅能力，保存/清除 key 后徽章实时刷新（不再依赖手动 refresh）
      subscribe: faces.credentials.subscribe,
      getSnapshot: faces.credentials.getSnapshot,
    }),
  });

  // 4) 事件订阅（凭据更新 / 设置文档更新 → 同步 face 与开关）
  const remote = ctx.remote;
  ctx.effect(() =>
    remote.$on('credentials/reference-updated', () => {
      void faces.credentials.refresh();
    }),
  );
  ctx.effect(() =>
    remote.$on('settings/document-updated', () => {
      for (const scope of faces.scopes.values()) {
        try {
          void scope.load(); // M9：makeFetchScope 已暴露 load（此前 as never 空转，开关不刷新）
        } catch {
          /* ignore */
        }
      }
      void faces.role.refresh();
    }),
  );

  // 4.5) UI locale → host 上报（语言指令注入用）：
  //   启动时上报一次当前 locale（跟随浏览器/持久化偏好），locale/change 时再上报。
  //   common 插件的 system-prompt 语言 section 每次 assembly 读 aemeath-ui.locale。
  ctx.effect(() => {
    reportLocaleToHost(currentActiveLocale());
    const off = ctx.on('locale/change', (snap) => {
      const id = (snap as { active?: string })?.active;
      if (id === 'en' || id === 'zh') reportLocaleToHost(id);
    });
    return off;
  });

  // 暴露给测试/检查脚本（cordis ctx 为代理对象，不可直接 setProperty）
  void FEATURES;
}
