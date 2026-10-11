// ============================================================
// constants.ts —— 客户端共享常量（UI 改造 P2）
// FEATURE_NAMESPACES 原本定义在 client/index.ts，被 faces.ts 复用，
// 抽出到独立模块避免循环依赖。
// ============================================================

/** 引擎插件 settings namespaces（与各引擎插件 installSettingsSection 注册名一致）。
 *  追加 aemeath-ui：host 侧已注册该 namespace（locale 上报），并把外观个人化
 *  字段（助手气泡/行高/段落间距/自定义字体）也持久化于此，供设置页外观 tab 使用。 */
export const FEATURE_NAMESPACES = [
  'aemeath-common',
  'aemeath-worldbook',
  'aemeath-retriever',
  'aemeath-memory',
  'aemeath-workflow',
  'aemeath-tts',
  'aemeath-ui',
] as const;

/**
 * 允许前端切换默认角色的 settings namespace。
 *
 * ⚠️ DSH 0.2.0 改名了（真机踩过）：0.1.1 的行 id 是 `agent-presets`，
 * 0.2.0 拆包后改为 `agent-preset-registry`。写错命名空间的后果是**静默失效**：
 * 前端本地乐观更新让界面看起来换了，但后端真源没写进去 →
 * 下次 refresh 读回旧值（表现为"顶部模态锁死在学霸"）。
 */
export const AGENT_PRESET_NAMESPACE = 'agent-preset-registry';

/**
 * 该 namespace 里表示"当前默认角色"的字段名 —— **前端发给后端时用的名字**。
 *
 * ⚠️ 这里必须是 `default`，不是 `selectedDefault`（真机踩过）：
 *   本插件的 settings 桥（host 侧 index.ts）约定前端发 `{ patch: { default: role } }`，
 *   由**后端**负责翻译成 dsh 0.2.0 真正的 volatile 字段：
 *       await settings.update('agent-preset-registry', { selectedDefault: patch.default })
 *   （0.2.0 的 registry Config 是 `{ default: required, selectedDefault: volatile }`，
 *    用户选择写在 selectedDefault 上。）
 *
 *   我一度把前端也改成发 `selectedDefault`，结果被后端的校验挡下：
 *       if (typeof patch.default !== 'string') return 400 'requires {default: string}'
 *   —— 请求 400、前端本地乐观更新让界面看着变了、刷新又变回去。
 *
 *   所以：**前端发 `default`，后端写 `selectedDefault`**，这条分界不要越过。
 */
export const AGENT_PRESET_FIELD = 'default';

/**
 * 从后端返回的 namespace 对象里**读出**当前角色时用的字段名。
 * 读的时候后端给的是 0.2.0 的真实字段名，所以是 `selectedDefault`（回退 `default`）。
 */
export const AGENT_PRESET_READ_FIELDS = ['selectedDefault', 'default'] as const;
