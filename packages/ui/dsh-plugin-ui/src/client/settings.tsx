// ============================================================
// 设置界面（M5 核心）——「爱弥斯」设置页（v2 官方模式重构）
// 结构（对齐官方 ModelsSection 模式，修复 React #290）：
//   AemeathSettingsSection（外层，零 hooks）→ props 未注入时 return null；
//   注入后渲染 <Loaded>（内层，承载全部 hooks 与订阅）。
//   #290 根因：外层直接渲染带 hooks 的子组件树时，slot 注入前后
//   （props undefined → 完整）同一组件位置的 hooks 数量跳变。
//   官方解法：外层只做注入检查（零 hooks），hooks 全部下沉到条件渲染
//   的 Loaded 子组件 —— 注入前 Loaded 不存在（0 hooks），注入后首次
//   挂载（hooks 从 0 计），天然无跳变。
// 内容：
//   1. 功能开关组（引擎插件 settings namespaces 绑定，实时生效）
//   2. API key 配置（ctx.remote.credentials：describe/set/unset）
// ============================================================
import { useState, useSyncExternalStore } from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client';
import type { CredentialView } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import { MemoryPanel } from './memory.tsx';

// ===== 功能开关清单 =====
export interface FeatureSwitch {
  ns: string;
  field: string;
  label: string;
  hint: string;
  fallback: boolean;
}

export const FEATURES: FeatureSwitch[] = [
  {
    ns: 'aemeath-common',
    field: 'oocRulesEnabled',
    label: 'OOC 规则层',
    hint: '角色越界回复自动纠偏（禁止词扫描）',
    fallback: true,
  },
  {
    ns: 'aemeath-common',
    field: 'oocLlmEnabled',
    label: 'OOC LLM 判定层',
    hint: '用大模型判定角色一致性（需 API key）',
    fallback: false,
  },
  {
    ns: 'aemeath-worldbook',
    field: 'enabled',
    label: '世界书注入',
    hint: '物理知识库条目注入上下文（双馆）',
    fallback: true,
  },
  {
    ns: 'aemeath-retriever',
    field: 'enabled',
    label: '讲义检索',
    hint: 'FTS5 BM25 检索本地讲义并注入',
    fallback: true,
  },
  {
    ns: 'aemeath-memory',
    field: 'enabled',
    label: '分层记忆',
    hint: 'L2/L3 记忆召回与沉淀（门卫判定）',
    fallback: true,
  },
  {
    ns: 'aemeath-workflow',
    field: 'enabled',
    label: '解题工作流',
    hint: '学霸解题分流 + SymPy 验证',
    fallback: true,
  },
];

// ===== API key 条目 =====
export const CREDENTIALS: Array<{ ref: string; label: string; hint: string }> = [
  { ref: 'DEEPSEEK_API_KEY', label: 'DeepSeek API Key', hint: '对话模型与记忆判定（可选，缺省走环境变量）' },
];

// ============================================================
// 内层组件（承载全部 hooks）
// ============================================================

interface LoadedProps {
  scopes: Record<string, SettingsScope<Record<string, unknown>>>;
  credentials: {
    views: Record<string, CredentialView | undefined>;
    refresh: () => void;
    set: (ref: string, value: string) => Promise<void>;
    unset: (ref: string) => Promise<void>;
  };
  /** 角色模式（小爱同学/爱弥斯-拉贝尔学部学霸）：可订阅（useSyncExternalStore）保证切换后 UI 刷新 */
  role?: {
    subscribe: (l: () => void) => () => void;
    getSnapshot: () => string;
    set: (role: string) => Promise<void>;
  };
}

/** 角色模式选择：小爱同学（陪伴）/ 爱弥斯-拉贝尔学部学霸（物理学习）。hooks 无条件调用。 */
function RoleSelector({
  role,
}: {
  role: NonNullable<LoadedProps['role']>;
}): JSX.Element {
  const current = useSyncExternalStore(role.subscribe, role.getSnapshot);
  const options = [
    { id: 'aemeath', label: '小爱同学', hint: '陪伴 · 日常聊天' },
    { id: 'physicist', label: '爱弥斯-拉贝尔学部学霸', hint: '物理学习 · 解题' },
  ];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 8,
        padding: '12px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      }}
    >
      {options.map((opt) => {
        const active = current === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => void role.set(opt.id)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 2,
              padding: '10px 12px',
              borderRadius: 10,
              cursor: 'pointer',
              border: active
                ? '1.5px solid var(--dsw-alias-state-business-primary)'
                : '1px solid var(--dsw-alias-border-l2)',
              background: active
                ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)'
                : 'var(--dsw-alias-bg-base)',
              color: 'var(--dsw-alias-label-primary)',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700 }}>{opt.label}</span>
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>{opt.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

function SwitchRow({
  label,
  hint,
  value,
  busy,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean | undefined;
  busy: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 }}>{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={!!value}
        disabled={busy || value === undefined}
        onClick={() => onChange(!value)}
        style={{
          flex: 'none',
          width: 34,
          height: 20,
          borderRadius: 999,
          border: 'none',
          cursor: value === undefined ? 'default' : 'pointer',
          background: value ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)',
          position: 'relative',
          transition: 'background 160ms',
          opacity: value === undefined ? 0.5 : 1,
        }}
        aria-label={label}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: value ? 16 : 2,
            width: 16,
            height: 16,
            borderRadius: 999,
            background: '#fff',
            transition: 'left 160ms',
          }}
        />
      </button>
    </div>
  );
}

function ApiKeyRow({
  credRef,
  label,
  hint,
  view,
  onSave,
  onClear,
}: {
  credRef: string;
  label: string;
  hint: string;
  view: CredentialView | undefined;
  onSave: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const v = draft.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(v);
      setDraft('');
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onClear();
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const configured = view?.configured ?? false;
  const writable = view?.writable ?? true;

  return (
    <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{label}</span>
        <span
          style={{
            fontSize: 11,
            padding: '1px 8px',
            borderRadius: 999,
            background: configured
              ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)'
              : 'var(--dsw-alias-border-l1)',
            color: configured ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)',
          }}
        >
          {configured ? '已配置' : '未配置'}
        </span>
        {!writable ? (
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>（只读：环境变量覆盖）</span>
        ) : null}
      </div>
      <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '4px 0 8px' }}>{hint}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="password"
          value={draft}
          placeholder={configured ? '已保存，输入新值可覆盖' : 'sk-…'}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy || !writable}
          style={{
            flex: 1,
            minWidth: 0,
            height: 30,
            padding: '0 10px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !writable || !draft.trim()}
          style={{
            height: 30,
            padding: '0 14px',
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            background: 'var(--dsw-alias-state-business-primary)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          保存
        </button>
        {configured ? (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={busy || !writable}
            style={{
              height: 30,
              padding: '0 12px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            清除
          </button>
        ) : null}
      </div>
      {error ? (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', marginTop: 6 }}>{error}</div>
      ) : null}
    </div>
  );
}

/** 单行开关：独立组件以便使用 hook（React hooks 规则：不在循环/条件中调用）。 */
function FeatureSwitchCell({
  feature,
  scope,
  onChange,
}: {
  feature: FeatureSwitch;
  scope: SettingsScope<Record<string, unknown>> | undefined;
  onChange: (f: FeatureSwitch, v: boolean) => void;
}): JSX.Element {
  // hooks 必须无条件调用：scope 缺失时用 no-op 订阅，避免 hooks 数量跳变（React #290）
  const noopSubscribe = (): (() => void) => () => void 0;
  const emptySnap = (): SettingsScopeSnapshot<Record<string, unknown>> => ({
    status: 'loading',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
    mode: 'memory',
  });
  const snap = useSyncExternalStore(scope ? scope.subscribe : noopSubscribe, scope ? scope.getSnapshot : emptySnap);
  const val = snap?.value as Record<string, unknown> | undefined;
  const fieldVal = val ? (val[feature.field] as boolean | undefined) : undefined;
  const value = fieldVal ?? feature.fallback;
  return (
    <SwitchRow
      label={feature.label}
      hint={`${feature.hint}（${feature.ns}）`}
      value={scope ? value : undefined}
      busy={false}
      onChange={(v) => onChange(feature, v)}
    />
  );
}

/** 内层：设置页完整内容（hooks 全在此）。 */
function Loaded({ scopes, credentials, role }: LoadedProps): JSX.Element {
  const setFeature = async (f: FeatureSwitch, v: boolean): Promise<void> => {
    const scope = scopes[f.ns];
    if (!scope) return;
    try {
      await scope.set(f.field, v);
    } catch {
      /* 写失败：下轮快照自动回退 */
    }
  };

  const credViews = credentials.views ?? {};

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        padding: '4px 0 20px',
        maxWidth: 560,
      }}
    >
      {/* —— 角色模式 —— */}
      {role ? (
        <section>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 8px', color: 'var(--dsw-alias-label-primary)' }}>
            角色模式
          </h3>
          <div
            style={{
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 12,
              overflow: 'hidden',
              background: 'var(--dsw-alias-bg-subtle)',
            }}
          >
            <RoleSelector role={role} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 }}>
            选择后对之后新建的会话生效；当前会话保持创建时的角色。
          </div>
        </section>
      ) : null}

      {/* —— 功能开关 —— */}
      <section>
        <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 8px', color: 'var(--dsw-alias-label-primary)' }}>
          功能开关
        </h3>
        <div
          style={{
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 12,
            overflow: 'hidden',
            background: 'var(--dsw-alias-bg-subtle)',
          }}
        >
          {FEATURES.map((f) => (
            <FeatureSwitchCell key={`${f.ns}.${f.field}`} feature={f} scope={scopes[f.ns]} onChange={(ff, v) => void setFeature(ff, v)} />
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 }}>
          开关经 settings 实时生效，无需重启。注意：关闭「世界书注入/讲义检索」只停止知识库注入，模型仍会用自身知识回答。
        </div>
      </section>

      {/* —— 记忆管理 —— */}
      <section>
        <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 8px', color: 'var(--dsw-alias-label-primary)' }}>
          记忆管理
        </h3>
        <div
          style={{
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 12,
            padding: '12px 14px',
            background: 'var(--dsw-alias-bg-subtle)',
          }}
        >
          <MemoryPanel />
        </div>
      </section>

      {/* —— API key —— */}
      <section>
        <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 8px', color: 'var(--dsw-alias-label-primary)' }}>
          API 密钥
        </h3>
        <div
          style={{
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 12,
            overflow: 'hidden',
            background: 'var(--dsw-alias-bg-subtle)',
          }}
        >
          {CREDENTIALS.map((c) => (
            <ApiKeyRow
              key={c.ref}
              credRef={c.ref}
              label={c.label}
              hint={c.hint}
              view={credViews[c.ref]}
              onSave={async (v) => {
                await credentials.set(c.ref, v);
                credentials.refresh();
              }}
              onClear={async () => {
                await credentials.unset(c.ref);
                credentials.refresh();
              }}
            />
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 }}>
          密钥仅单向写入本机凭据库（.dsh-home/.credentials.yaml），界面永不回读明文。
        </div>
      </section>
    </div>
  );
}

// ============================================================
// 外层组件（零 hooks）：注入检查 → Loaded
// ============================================================

export interface AemeathSettingsSectionProps {
  scopes?: Record<string, SettingsScope<Record<string, unknown>>>;
  credentials?: {
    views: Record<string, CredentialView | undefined>;
    refresh: () => void;
    set: (ref: string, value: string) => Promise<void>;
    unset: (ref: string) => Promise<void>;
  };
  /** 角色模式（小爱同学/爱弥斯-拉贝尔学部学霸）切换：可订阅 */
  role?: {
    subscribe: (l: () => void) => () => void;
    getSnapshot: () => string;
    set: (role: string) => Promise<void>;
  };
}

export function AemeathSettingsSection({ scopes, credentials, role }: AemeathSettingsSectionProps): JSX.Element | null {
  // 零 hooks：注入未就绪时返回 null（官方模式），注入后首次挂载 Loaded。
  if (!scopes || !credentials) return null;
  return <Loaded scopes={scopes} credentials={credentials} role={role} />;
}

// ============================================================
// apply 侧注册：settings.section 槽位
// ============================================================

export function registerSettingsSection(
  ctx: ClientContext,
  deps: {
    scopes: () => Record<string, SettingsScope<Record<string, unknown>>>;
    credentials: () => AemeathSettingsSectionProps['credentials'];
    role: () => AemeathSettingsSectionProps['role'];
  },
): void {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'aemeath',
        order: 5,
        label: () => '小爱同学',
        inject: () => ({
          scopes: deps.scopes(),
          credentials: deps.credentials(),
          role: deps.role(),
        }),
      },
      AemeathSettingsSection,
    ),
  );
}
