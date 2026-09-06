// ============================================================
// in-composer interaction card host（feature #6）——runId 路由 + 结算清除。
// 借 Cyrene 的 AgentRunController.setInteraction/clearInteraction 结构思想
//   （per-run 卡片宿主 + runId 路由 + 终态结算广播清卡，防 zombie 卡片），
//   只用其"结构/交互"，用 Aemeath 自己的 t()/主题 token 实现，不复制其代码。
// 注册位：conversation.input.dock（composer 卡上方的整行）——卡片浮在 composer 上方。
// 宿主契约：模块级 composerBus（pushCard/settleCard/settleRun/settleSession/
//   clearComposerCards）+ useComposerCards() hook，供宿主代码/其他插件推卡。
// 真实信号（feature #6）：解题计划确认卡——只读 host GET /aemeath/api/memory 的
//   plans（workflow.plan scratch，host 侧已解析），非空且未确认过即推"计划确认"卡。
//   动作 Approve/Rerun/Dismiss 只结算/隐藏卡（无宿主动作可触发，见现状说明）。
// 结算清除（Cyrene 式）：① 按钮动作 → settleCard(id)；② 本会话新一轮运行开始
//   （running false→true）→ settleSession(sessionId)；③ 切换会话 → clearComposerCards()。
// ============================================================
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
import { t, useLocale } from './i18n.ts';

const POLL_MS = 5000;
const MAX_BODY_STEPS = 6;

// —— 卡片类型与宿主契约 ——
export interface ComposerCardAction {
  id: string;
  labelKey: string;
  kind?: 'primary' | 'default' | 'ghost';
  /** 宿主自定义动作（点击回调）；缺省时点击 = settleCard(card.id)。 */
  onSelect?: (card: ComposerCard) => void;
}

export interface ComposerCard {
  /** 卡片实例唯一键（settle/去重键；即 run 路由键）。 */
  id: string;
  /** Cyrene 式 run 路由键：宿主可整体 settleRun(runId)。缺省与 id 同。 */
  runId?: string;
  /** 归属会话：卡片只在所属会话的 composer 上方显示。 */
  sessionId: string;
  kind: string;
  titleKey: string;
  titleParams?: Record<string, unknown>;
  /** 已本地化的正文纯文本。 */
  body?: string;
  /** 本地化正文：渲染时按当前 locale 求值（优先于 body）。 */
  bodyKey?: string;
  bodyParams?: Record<string, unknown>;
  /** 可选的正文条目列表（如计划步骤）。 */
  items?: string[];
  actions: ComposerCardAction[];
  createdAt: number;
}

// —— store 内部状态（React #310 安全：getSnapshot 只返回稳定引用）——
let cardsByKey: Record<string, ComposerCard> = {};
let cardsSnapshot: readonly ComposerCard[] = [];
const listeners = new Set<() => void>();

function rebuildSnapshot(): void {
  cardsSnapshot = Object.values(cardsByKey).sort((a, b) => a.createdAt - b.createdAt);
}

function notify(): void {
  rebuildSnapshot();
  for (const l of listeners) l();
}

/** useSyncExternalStore subscribe 侧。 */
function subscribeComposerCards(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** useSyncExternalStore getSnapshot 侧（稳定引用）。 */
function getComposerCardsSnapshot(): readonly ComposerCard[] {
  return cardsSnapshot;
}

/** 推入（或按 id 更新）一张卡片——宿主代码/其他插件调用。 */
export function pushCard(card: ComposerCard): void {
  cardsByKey = { ...cardsByKey, [card.id]: { ...card, createdAt: card.createdAt || Date.now() } };
  notify();
}

/** 结算单张卡片（按钮动作/宿主调用）。 */
export function settleCard(id: string): void {
  if (!(id in cardsByKey)) return;
  const next = { ...cardsByKey };
  delete next[id];
  cardsByKey = next;
  notify();
}

/** 按 runId 结算（Cyrene 式：run 结算广播清卡）。 */
export function settleRun(runId: string | undefined): void {
  if (!runId) return;
  const ids = Object.values(cardsByKey).filter((c) => c.runId === runId).map((c) => c.id);
  if (ids.length === 0) return;
  const next = { ...cardsByKey };
  for (const id of ids) delete next[id];
  cardsByKey = next;
  notify();
}

/** 按会话结算（该会话的所有卡，如新一轮运行开始）。 */
export function settleSession(sessionId: string): void {
  const ids = Object.values(cardsByKey).filter((c) => c.sessionId === sessionId).map((c) => c.id);
  if (ids.length === 0) return;
  const next = { ...cardsByKey };
  for (const id of ids) delete next[id];
  cardsByKey = next;
  notify();
}

/** 清空所有卡片（切换会话）。 */
export function clearComposerCards(): void {
  if (Object.keys(cardsByKey).length === 0) return;
  cardsByKey = {};
  notify();
}

/** React hook：订阅当前卡片列表（cardsSnapshot 变化才触发重渲染）。 */
export function useComposerCards(): readonly ComposerCard[] {
  return useSyncExternalStore(subscribeComposerCards, getComposerCardsSnapshot);
}

/** 模块级 store 句柄：宿主代码/其他插件经此推卡 / 结算（Cyrene 的 per-run 卡片宿主契约）。 */
export const composerBus = {
  push: pushCard,
  settle: settleCard,
  settleRun,
  settleSession,
  clear: clearComposerCards,
};

// —— 计划确认卡的分内去重（每会话最后展示/已确认的计划 hash）——
const lastShownPlan = new Map<string, string>();
const actedPlan = new Map<string, string>();

/** 计划步骤 JSON 的内容 hash（作为 run 路由键/去重键；步骤变化 → 新 hash）。 */
function hashPlan(steps: string[]): string {
  let h = 0;
  for (const s of steps) {
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `${steps.length}:${Math.abs(h)}`;
}

function planCardId(sessionId: string, hash: string): string {
  return `${sessionId}:plan:${hash}`;
}

function planConfirmActions(): ComposerCardAction[] {
  return [
    { id: 'approve', labelKey: 'composercards.plan.approve', kind: 'primary' },
    { id: 'rerun', labelKey: 'composercards.plan.rerun', kind: 'default' },
    { id: 'dismiss', labelKey: 'composercards.plan.dismiss', kind: 'ghost' },
  ];
}

interface PlanPayload {
  ok?: boolean;
  plans?: Record<string, string[]>;
}

/** 拉取当前会话的解题计划步骤（host 已解析 scratch workflow.plan；无 → 空数组）。 */
async function fetchPlan(sessionId: string): Promise<string[]> {
  if (!sessionId) return [];
  try {
    const res = await fetch('/aemeath/api/memory', { signal: AbortSignal.timeout(8000) });
    const d = (await res.json()) as PlanPayload;
    if (!res.ok || !d.ok || !d.plans) return [];
    const steps = d.plans[sessionId];
    return Array.isArray(steps) ? steps.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// —— 渲染：一张交互卡 ——
function CardActionButton({
  action,
  card,
  onAction,
}: {
  action: ComposerCardAction;
  card: ComposerCard;
  onAction: (card: ComposerCard, action: ComposerCardAction) => void;
}): JSX.Element {
  const label = t(action.labelKey);
  const primary = action.kind === 'primary';
  const ghost = action.kind === 'ghost';
  const style: CSSProperties = primary
    ? { height: 28, padding: '0 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'var(--dsw-alias-state-business-primary)', color: '#fff', fontSize: 12, fontWeight: 600 }
    : ghost
      ? { height: 28, padding: '0 10px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
      : { height: 28, padding: '0 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: 12 };
  return (
    <button type="button" onClick={() => onAction(card, action)} style={style}>
      {label}
    </button>
  );
}

function ComposerCardView({
  card,
  onAction,
}: {
  card: ComposerCard;
  onAction: (card: ComposerCard, action: ComposerCardAction) => void;
}): JSX.Element {
  const title = t(card.titleKey, card.titleParams);
  return (
    <div className="aemeath-composer-card" role="region" aria-label={title}>
      <div className="aemeath-composer-card__header">
        <span className="aemeath-composer-card__title">{title}</span>
        {card.items && card.items.length > 0 ? (
          <span className="aemeath-composer-card__count">{t('composercards.plan.steps', { n: card.items.length })}</span>
        ) : null}
      </div>
      {card.bodyKey ? <div className="aemeath-composer-card__body">{t(card.bodyKey, card.bodyParams)}</div> : card.body ? <div className="aemeath-composer-card__body">{card.body}</div> : null}
      {card.items && card.items.length > 0 ? (
        <ul className="aemeath-composer-card__items">
          {card.items.map((s, i) => (
            <li key={`${i}-${s}`}>{s}</li>
          ))}
        </ul>
      ) : null}
      <div className="aemeath-composer-card__actions">
        {card.actions.map((a) => (
          <CardActionButton key={a.id} action={a} card={card} onAction={onAction} />
        ))}
      </div>
    </div>
  );
}

// —— 卡片宿主（hooks 全在此；由外层零 hooks 组件保证为当前会话）——
// 数据源：conversation.input.dock 的 owner share（InputZone.session 快照）——按规范
//   "Read only session/input off the owner share；点时刻快照由骨架代重渲染，勿自订阅"。
function ComposerCardHostInner({ session }: { session: ConversationSnapshot }): JSX.Element | null {
  useLocale(); // locale 切换时刷新文案

  const sessionId = session.sessionId ?? '';
  const running = session.running ?? false;
  const cards = useComposerCards();

  // —— 结算清除：切换会话 / 新一轮运行开始 ——
  const prevSessionRef = useRef(sessionId);
  const prevRunningRef = useRef(running);
  useEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      // 切换到另一会话：清空全部卡片并重置该会话的计划去重标记
      if (prevSessionRef.current) {
        lastShownPlan.delete(prevSessionRef.current);
        actedPlan.delete(prevSessionRef.current);
      }
      composerBus.clear();
      prevSessionRef.current = sessionId;
    } else if (running && !prevRunningRef.current) {
      // 新一轮运行开始：上一条 run 已结算，按 runId 清掉该 run 的卡（防 zombie 卡片）
      const shownHash = lastShownPlan.get(sessionId);
      if (shownHash) composerBus.settleRun(planCardId(sessionId, shownHash));
    }
    prevRunningRef.current = running;
  }, [running, sessionId]);

  // —— 计划确认卡数据源：只读 host plans（workflow.plan scratch）——
  const [planSteps, setPlanSteps] = useState<string[]>([]);
  useEffect(() => {
    if (!sessionId) {
      setPlanSteps([]);
      return;
    }
    let alive = true;
    const load = (): void => {
      void fetchPlan(sessionId).then((steps) => {
        if (alive) setPlanSteps(steps);
      });
    };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  // 把当前计划同步为"计划确认"卡（去重 + 结算旧卡，防 zombie / 重复弹）。
  useEffect(() => {
    if (!sessionId) return;
    const hash = planSteps.length > 0 ? hashPlan(planSteps) : '';
    const prevShown = lastShownPlan.get(sessionId);
    if (!hash) {
      // 计划清空：结算当前计划卡并重置标记
      if (prevShown) {
        composerBus.settle(planCardId(sessionId, prevShown));
        lastShownPlan.delete(sessionId);
      }
      return;
    }
    if (actedPlan.get(sessionId) === hash) return; // 已确认过同一计划：不再弹
    if (prevShown === hash) return; // 已在展示当前计划：勿重复推卡
    if (prevShown) composerBus.settle(planCardId(sessionId, prevShown)); // 计划变了：结算旧卡
    composerBus.push({
      id: planCardId(sessionId, hash),
      runId: planCardId(sessionId, hash),
      sessionId,
      kind: 'plan.confirm',
      titleKey: 'composercards.plan.title',
      bodyKey: 'composercards.plan.desc',
      items: planSteps.slice(0, MAX_BODY_STEPS),
      actions: planConfirmActions(),
      createdAt: Date.now(),
    });
    lastShownPlan.set(sessionId, hash);
  }, [planSteps, sessionId]);

  const visible = cards.filter((c) => c.sessionId === sessionId);
  if (visible.length === 0) return null;

  const onAction = (card: ComposerCard, action: ComposerCardAction): void => {
    if (action.onSelect) {
      action.onSelect(card);
      return;
    }
    if (card.kind === 'plan.confirm') {
      const hash = lastShownPlan.get(card.sessionId);
      if (hash) actedPlan.set(card.sessionId, hash);
    }
    composerBus.settle(card.id);
  };

  return (
    <div className="aemeath-composer-cards">
      {visible.map((card) => (
        <ComposerCardView key={card.id} card={card} onAction={onAction} />
      ))}
    </div>
  );
}

/** 外层（零 hooks）：非当前会话/无会话时返回 null（不渲染）。 */
export function ComposerCardHost(props: { session?: ConversationSnapshot }): JSX.Element | null {
  const { session } = props;
  if (!session?.sessionId) return null;
  return <ComposerCardHostInner session={session} />;
}

/** 注入一次样式（幂等）。 */
function injectComposerCardStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('aemeath-composer-cards-styles')) return;
  const style = document.createElement('style');
  style.id = 'aemeath-composer-cards-styles';
  style.textContent = `
    .aemeath-composer-cards { display: flex; flex-direction: column; gap: 8px; padding: 4px 2px; }
    .aemeath-composer-card {
      border: 1px solid var(--dsw-alias-border-l2);
      border-radius: 10px;
      background: var(--dsw-alias-bg-layer-2);
      color: var(--dsw-alias-label-primary);
      padding: 10px 12px;
      box-shadow: var(--fluent-shadow-sm, 0 1px 3px rgba(0,0,0,0.06));
    }
    .aemeath-composer-card__header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .aemeath-composer-card__title { font-size: 13px; font-weight: 700; }
    .aemeath-composer-card__count { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-left: auto; white-space: nowrap; }
    .aemeath-composer-card__body { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; }
    .aemeath-composer-card__items {
      margin: 0; padding: 0; list-style: none;
      display: flex; flex-direction: column; gap: 4px;
      font-size: 12px; line-height: 1.4;
    }
    .aemeath-composer-card__items li { padding-left: 12px; position: relative; color: var(--dsw-alias-label-primary); }
    .aemeath-composer-card__items li::before {
      content: ''; position: absolute; left: 0; top: 6px;
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--dsw-alias-state-business-primary);
    }
    .aemeath-composer-card__actions { display: flex; gap: 8px; margin-top: 8px; }
  `;
  document.head.appendChild(style);
}

/** 注册：输入区 dock 位（composer 卡上方整行），卡片浮在 composer 上方。 */
export function registerComposerCards(ctx: ClientContext): void {
  injectComposerCardStyles();
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'aemeath-composer-cards',
        order: -60, // 置于 plan/goal/queue 条之前，作为最上方的交互行
      },
      ComposerCardHost as never,
    ),
  );
}
