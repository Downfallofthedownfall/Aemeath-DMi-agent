// ============================================================
// limits.ts — 护栏集中表（T7：把散落的魔数收拢为有名字的常量 + 中英注释）
//
// 原则（照文档 §12）：只**搬运**已存在的语义，不凭空改阈值。
//   ① 数值来自现有实现（engine/gatekeeper/layers/service/index 的现状值）；
//   ② 参考对象 ripples-of-aion 的对应护栏在注释里标 [roa]，便于对照；
//   ③ 各模块从此处 import，新增魔数时必须先在这里登记。
// ============================================================

// ---- 字段长度护栏（写入门禁 / 提取层） ----
/** 记忆内容最大字符数（提取层截断；参考对象同量级 200）。 */
export const CONTENT_MAX_CHARS = 200;
/** 单条记忆注入/摘要显示的最大字符数（召回块、面板）。 */
export const SUMMARY_MAX_CHARS = 80;
/** 实体/属性名最大字符数（T4 归一化截断，防异常长键污染比较）。 */
export const ATTR_MAX_CHARS = 24;
/** 实体名最大字符数（T1 claim 归一化）。 */
export const ENTITY_MAX_CHARS = 24;
/** 单个 claim 的 value 最大字符数（T1）。 */
export const CLAIM_VALUE_MAX_CHARS = 60;

// ---- 激活/生命周期（engine.ts，现状值，勿改语义） ----
/** 时间衰减半衰期（天）。 */
export const RECENCY_HALF_LIFE_DAYS = 45;
/** 新记忆默认激活值。 */
export const ACTIVATION_DEFAULT = 50;
/** active 阈值（≥ 即 active）。 [roa: heat 无三态，Aemeath 独有] */
export const ACTIVATION_ACTIVE_THRESHOLD = 60;
/** archived 阈值（< 即 archived；介于两者为 dormant）。 */
export const ACTIVATION_ARCHIVED_THRESHOLD = 30;
/** 召回命中加成（T5 改为渐近饱和增量；等同于原 ACTIVATION_HIT_BONUS=12 的量级）。 */
export const ACTIVATION_HIT_GAIN = 12;

// ---- 召回回写节流（T5，借参考对象的落盘节流 30 分钟） ----
/** 召回回写的最小落盘间隔：内存值照常更新，只抑制落盘。 [roa: 30 min] */
export const MEMORY_PERSIST_INTERVAL_MS = 30 * 60 * 1000;

// ---- 冲突/去重（gatekeeper/service，现状值） ----
/** 相似度去重阈值（overlapScore，有界 0..1）——≥ 即视为同一话题的改写。 */
export const OVERLAP_DEDUP_THRESHOLD = 0.5;
/** 冲突候选（BM25 top-N）；现状只取 1 条最佳命中。 */
export const CONFLICT_CANDIDATE_TOPK = 1;

// ---- 空闲整合（T3，参考对象的值见 [roa]） ----
/** 最少参与整合的记忆条数（低于此不跑）。 [roa: 5] */
export const CONSOLIDATION_MIN_RECORDS = 5;
/** 一次整合最多纳入的记忆条数。 [roa: 80] */
export const CONSOLIDATION_MAX_RECORDS = 80;
/** 最多主题簇数。 [roa: 8] */
export const CONSOLIDATION_MAX_CLUSTERS = 8;
/** 最小簇大小（单点簇丢弃）。 [roa: 2] */
export const CONSOLIDATION_MIN_CLUSTER_SIZE = 2;
/** 枢纽实体比例：出现次数 ≥ max(ceil(N*比例), 绝对下限) 的实体不参与连通。 [roa: 0.5] */
export const CONSOLIDATION_HUB_FRACTION = 0.5;
/** 枢纽实体绝对下限（小库防误判枢纽）。 [roa: 8] */
export const CONSOLIDATION_HUB_MIN_RECORDS = 8;
/** 质心剪枝的余弦下限（低于此剔除离群成员）。 [roa: 0.5] */
export const CONSOLIDATION_MIN_CENTROID_COSINE = 0.5;
/** 候选矛盾对上限。 [roa: 40] */
export const CONSOLIDATION_MAX_CANDIDATE_PAIRS = 40;
/** 产出矛盾上限。 [roa: 40] */
export const CONSOLIDATION_MAX_CONFLICTS = 40;
/** 簇标签最大字符数。 [roa: 80] */
export const CONSOLIDATION_LABEL_MAX_CHARS = 80;
/** 矛盾说明最大字符数。 [roa: 80] */
export const CONSOLIDATION_NOTE_MAX_CHARS = 80;
/** 送进 prompt 的单条候选摘要最大字符数。 [roa: 200] */
export const CONSOLIDATION_SNIPPET_MAX_CHARS = 200;
/** 整合 LLM maxTokens。 [roa: 2048] */
export const CONSOLIDATION_MAX_TOKENS = 2048;
/** 整合 LLM 超时（ms）。 */
export const CONSOLIDATION_TIMEOUT_MS = 60_000;
/** 空闲触发默认分钟数。 [roa: 30] */
export const CONSOLIDATION_IDLE_MINUTES = 30;
/** 启动补跑延迟（ms）。 [roa: 120s] */
export const CONSOLIDATION_CATCHUP_DELAY_MS = 120 * 1000;

// ---- LLM 通道（index.ts 现状值） ----
/** 总结层 LLM maxTokens。 */
export const SUMMARIZE_MAX_TOKENS = 1536;
/** 冲突判定 LLM maxTokens。 */
export const CONFLICT_MAX_TOKENS = 200;
/** 情绪观察 LLM maxTokens。 */
export const MOOD_MAX_TOKENS = 16;
