// ============================================================
// quick-settings.tsx —— 快速设置面板（UI 改造 P3，Win11 快捷设置样式）
// 入口：侧边栏底部齿轮按钮（sidebar.footer.action 列表槽）
// 形态：Acrylic 弹层面板（fixed 定位 + 外侧点击关闭），容纳主界面常用设置：
//   1. 角色模式（小爱同学 / 学霸，分段控件，对新会话生效）
//   2. 功能开关 ×6（世界书/检索/记忆/工作流/OOC，settings 桥实时生效）
//   3. 记忆状态摘要（active/dormant）
//   4. API key 状态徽章（已配置/未配置）
// 完整设置仍走官方 SettingsRoot（下方 ⚙ 设置入口）。
// ============================================================
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client';
import type { CredentialView } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { RoleFace } from './faces.ts';
import { FEATURES, FeatureSwitchCell, type FeatureSwitch } from './settings.tsx';

export interface QuickSettingsDeps {
  role?: RoleFace;
  scopes?: Record<string, SettingsScope<Record<string, unknown>>>;
  credentials?: {
    views: Record<string, CredentialView | undefined>;
    refresh: () => void;
  };
}

const ROLE_OPTIONS = [
  { id: 'aemeath', label: '小爱同学' },
  { id: 'physicist', label: '学霸' },
] as const;

/** 记忆状态摘要（/aemeath/api/memory 统计）。 */
function MemoryStatsLine(): JSX.Element {
  const [stats, setStats] = useState<{ active?: number; dormant?: number } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/aemeath/api/memory', { signal: AbortSignal.timeout(6000) })
      .then((r) => r.json() as Promise<{ stats?: { active?: number; dormant?: number } }>)
      .then((d) => {
        if (alive) setStats(d.stats ?? null);
      })
      .catch(() => {
        if (alive) setStats(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  if (!stats) {
    return <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>记忆 · …</span>;
  }
  return (
    <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--dsw-alias-state-success-primary)', display: 'inline-block' }} />
      记忆 {stats.active ?? 0} 活跃 · {stats.dormant ?? 0} 休眠
    </span>
  );
}

/** 面板主体（hooks 全在此）。 */
function QuickSettingsLoaded({
  role,
  scopes,
  credentials,
  anchor,
  onClose,
}: {
  role: RoleFace;
  scopes: Record<string, SettingsScope<Record<string, unknown>>>;
  credentials: NonNullable<QuickSettingsDeps['credentials']>;
  anchor: { left: number; top: number };
  onClose: () => void;
}): JSX.Element {
  const currentRole = useSyncExternalStore(role.subscribe, role.getSnapshot);
  const credViews = credentials.views ?? {};
  const apiConfigured = credViews['DEEPSEEK_API_KEY']?.configured ?? false;

  const setFeature = async (f: FeatureSwitch, v: boolean): Promise<void> => {
    const scope = scopes[f.ns];
    if (!scope) return;
    try {
      await scope.set(f.field, v);
    } catch {
      /* 写失败：下轮快照自动回退 */
    }
  };

  return (
    <div
      role="dialog"
      aria-label="快速设置"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: Math.max(8, anchor.left - 280),
        top: anchor.top + 8,
        zIndex: 9999,
        width: 312,
        maxHeight: 'min(560px, 75vh)',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        padding: 10,
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--fluent-acrylic, rgba(255,255,255,0.92))',
        backdropFilter: 'var(--fluent-blur, blur(20px) saturate(140%))',
        boxShadow: 'var(--fluent-shadow-lg, 0 4px 12px rgba(0,0,0,0.06), 0 16px 40px rgba(0,0,0,0.08))',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px 8px' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>快速设置</span>
        <button type="button" onClick={onClose} aria-label="关闭快速设置" style={{ width: 26, height: 26, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>
          ✕
        </button>
      </div>

      {/* —— 角色模式（分段控件） —— */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4, borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2)', marginBottom: 8 }}>
        {ROLE_OPTIONS.map((opt) => {
          const active = currentRole === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => void role.set(opt.id)}
              aria-pressed={active}
              style={{
                padding: '7px 8px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                fontSize: 12.5,
                fontWeight: active ? 700 : 500,
                background: active ? 'var(--dsw-alias-bg-base)' : 'transparent',
                color: active ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)',
                boxShadow: active ? 'var(--fluent-shadow-sm)' : 'none',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* —— 功能开关 —— */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {FEATURES.map((f) => (
          <FeatureSwitchCell key={`${f.ns}.${f.field}`} feature={f} scope={scopes[f.ns]} onChange={(ff, v) => void setFeature(ff, v)} />
        ))}
      </div>

      {/* —— 记忆状态 + API key 徽章 —— */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 6px 2px', borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 6 }}>
        <MemoryStatsLine />
        <span
          style={{
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 999,
            background: apiConfigured ? 'var(--dsw-alias-state-business-tertiary)' : 'var(--dsw-alias-bg-layer-2)',
            color: apiConfigured ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)',
          }}
        >
          API {apiConfigured ? '已配置' : '未配置'}
        </span>
      </div>

      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', padding: '6px 6px 0' }}>
        完整设置与 API 密钥见下方「⚙ 设置」。
      </div>
    </div>
  );
}

/** 触发器 + 弹层（外层零 hooks → 依赖缺失返回 null）。 */
export function QuickSettingsButton(props: QuickSettingsDeps): JSX.Element | null {
  const { role, scopes, credentials } = props;
  if (!role || !scopes || !credentials) return null;
  return <QuickSettingsInner role={role} scopes={scopes} credentials={credentials} />;
}

function QuickSettingsInner({
  role,
  scopes,
  credentials,
}: {
  role: RoleFace;
  scopes: Record<string, SettingsScope<Record<string, unknown>>>;
  credentials: NonNullable<QuickSettingsDeps['credentials']>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  // 外侧点击 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[data-aemeath-quick-settings-trigger]') || t?.closest?.('[role="dialog"]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (e: React.MouseEvent<HTMLElement>): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setAnchor({ left: rect.right, top: rect.top });
    setOpen(true);
    void credentials.refresh();
  };

  return (
    <>
      <button
        type="button"
        data-aemeath-quick-settings-trigger
        aria-label="快速设置"
        title="快速设置"
        onClick={toggle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          borderRadius: 8,
          border: 'none',
          cursor: 'pointer',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 15,
        }}
      >
        ⚙
      </button>
      {open && anchor ? <QuickSettingsLoaded role={role} scopes={scopes} credentials={credentials} anchor={anchor} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** 注册：侧边栏底部快速设置入口（sidebar.footer.action 列表槽）。 */
export function registerQuickSettings(ctx: ClientContext, deps: () => QuickSettingsDeps): void {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'aemeath-quick-settings',
        order: -100,
        inject: () => deps(),
      },
      QuickSettingsButton as never,
    ),
  );
}
