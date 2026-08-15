// ============================================================
// constants.ts —— 客户端共享常量（UI 改造 P2）
// FEATURE_NAMESPACES 原本定义在 client/index.ts，被 faces.ts 复用，
// 抽出到独立模块避免循环依赖。
// ============================================================

/** 引擎插件 settings namespaces（与各引擎插件 installSettingsSection 注册名一致）。 */
export const FEATURE_NAMESPACES = [
  'aemeath-common',
  'aemeath-worldbook',
  'aemeath-retriever',
  'aemeath-memory',
  'aemeath-workflow',
] as const;

/** 允许前端切换默认角色的 settings namespace（dsh 官方 agent-presets）。 */
export const AGENT_PRESET_NAMESPACE = 'agent-presets';
