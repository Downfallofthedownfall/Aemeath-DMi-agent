// ============================================================
// dsh-plugin-ui · browser 半区入口（M5 → UI 改造 P2）
// 组装：设计系统（fluent + de-dsh）→ 主题（亮色）→ 品牌 → 会话列表
//       → 欢迎屏（角色卡片）→ TTS → 设置页 / 快速设置（P3）
// 数据 face（settings/role/credentials/scopes）统一由 faces.ts 工厂构建。
// ============================================================
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import { registerThemes } from './theme.ts';
import { applyBrand } from './brand.tsx';
import { registerSettingsSection, FEATURES } from './settings.tsx';
import { registerSessionList } from './sessions.tsx';
import { registerHero } from './hero.tsx';
import { registerTts } from './tts.tsx';
import { registerQuickSettings } from './quick-settings.tsx';
import { registerWorkspaceSelector } from './workspace-selector.tsx';
import { registerWorkspaceBootstrap } from './bootstrap.ts';
import { injectFluentStyles } from './styles/fluent.ts';
import { injectDeDshStyles } from './styles/de-dsh.ts';
import { createFaces } from './faces.ts';
export { FEATURE_NAMESPACES } from './constants.ts';

export const name = 'aemeath-ui';
export const inject = ['slots', 'theme', 'connection', 'remote', 'sessions', 'workspaces'];

export function apply(ctx: ClientContext): void {
  // 0) 设计系统基础层（Win11 fluent token + dsh 覆盖注册表）——最先注入，避免闪烁
  injectFluentStyles();
  injectDeDshStyles();

  // 0.5) 数据 face（settings 桥 / 角色 / 凭据 / scopes）——一次构建，多处复用
  const faces = createFaces(ctx);

  // 1) 主题（幂等；默认亮色映射见 theme.ts）
  registerThemes(ctx as never);

  // 2) 品牌层（标题 + 隐藏 dsh logo；侧边栏品牌位见 sessions.tsx）
  applyBrand(ctx);

  // 2.5) 会话列表 + 品牌头部（shadow 官方 workspace 浏览器）
  registerSessionList(ctx);

  // 2.6) 欢迎屏（问候语 + 角色卡片）
  registerHero(ctx, { role: () => faces.role });

  // 2.7) TTS 朗读按钮（assistant 消息操作区）+ 输入框 TTS 开关（conversation.input.right）
  //   resolveMessageText：通过 messageId 从会话快照取 assistant 消息文本（可靠，替代 DOM 抓取）
  const resolveMessageText = (messageId: string): string | undefined => {
    try {
      const sessions = ctx.get('sessions') as unknown as
        | {
            manager?: { get(id: string): { getSnapshot(): { nodes?: Array<{ kind: string; messageId?: string; blocks?: Array<{ kind: string; text?: string }> }> } } };
            list?: { getSnapshot(): { current?: string } };
          }
        | undefined;
      if (!sessions?.manager) return undefined;
      const currentId = sessions.list?.getSnapshot?.().current;
      if (!currentId) return undefined;
      const snap = sessions.manager.get(currentId).getSnapshot();
      const node = (snap.nodes ?? []).find((n) => n.kind === 'assistant' && n.messageId === messageId);
      if (!node) return undefined;
      const text = (node.blocks ?? [])
        .filter((b) => b.kind === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      return text || undefined;
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
  registerWorkspaceSelector(ctx, {
    workspaces: ctx.workspaces as never,
    openSession: (id: string) => ctx.sessions.open(id as never),
  });

  // 2.9.5) 无工作区自动兜底：零工作区时挂项目内空文件夹为工作区，打开即聊
  registerWorkspaceBootstrap(ctx);
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
    remote.$on('credentials/updated', () => {
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

  // 暴露给测试/检查脚本（cordis ctx 为代理对象，不可直接 setProperty）
  void FEATURES;
}
