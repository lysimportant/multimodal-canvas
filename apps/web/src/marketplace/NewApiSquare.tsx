import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import {
  newApiSquareSnapshotSchema,
  type NewApiPriceConfig,
  type NewApiPriceModel,
} from '@multimodal-canvas/domain';
import { managementRequest } from '../management/client';
import { Modal, Notice, QueryState, useAction } from '../management/primitives';
import { AppLink } from '../routing';
import { NewApiPrice } from './NewApiPrice';
import { compileBillingExpression } from './newapi/lib/billing-expression/parser';
import { visitExpression, type ExpressionNode } from './newapi/lib/billing-expression/types';
import './newapi-square.css';
import '../management/management.css';

/** 公开广场返回值不含管理授权或本地价格草稿。 */
export type Square = {
  configured: boolean;
  url: string | null;
  snapshot: ReturnType<typeof newApiSquareSnapshotSchema.parse> | null;
  availableModels?: Array<{ platformModelId: string; modelName: string }>;
};
/** 管理员只读取授权状态，不回显令牌。 */
type SquareAdmin = Square & {
  revision: number;
  authorized: boolean;
  drafts: Array<{ modelName: string; revision: number; status: string; error: string | null }>;
};
/** 上游配置、当前生效版本和草稿修订各有独立身份。 */
type EditPrice = {
  modelName: string;
  sourceRevision: number;
  version: string;
  latestVersion: string;
  configured: NewApiPriceConfig;
  effective: NewApiPriceConfig;
  baseline: NewApiPriceConfig;
  revision: number;
  status: string;
  error: string | null;
};

/** 同一账户复用服务端广场快照；切换账户时自然换查询键。 */
export function useNewApiSquare(userId?: string) {
  return useQuery({
    queryKey: ['marketplace', userId, 'newapi'],
    enabled: Boolean(userId),
    retry: false,
    queryFn: ({ signal }) => managementRequest<Square>('/model-marketplace/newapi', { signal }),
  });
}

/** New API 全目录展示：原模型名、厂商、分组和全部价格；可用连接仍由鉴权画布目录决定。 */
export function NewApiSquareCatalog({
  square,
  availableNames,
  onEdit,
}: {
  square: Square;
  availableNames?: Set<string>;
  onEdit?: (model: NewApiPriceModel) => void;
}) {
  const [search, setSearch] = useState('');
  const [vendor, setVendor] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const models = square.snapshot?.models ?? [];
  const vendors = Array.from(
    new Set(models.flatMap((model) => (model.vendor_name ? [model.vendor_name] : []))),
  ).sort();
  const filtered = models.filter(
    (model) =>
      model.model_name.toLowerCase().includes(search.toLowerCase()) &&
      (!vendor || model.vendor_name === vendor),
  );
  return (
    <section className="na-square" aria-label="New API 模型广场">
      <div className="na-square-toolbar">
        <label className="mg-search">
          <Search size={17} />
          <input
            aria-label="搜索 New API 模型"
            placeholder="搜索模型名称"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <select
          aria-label="模型厂商"
          value={vendor}
          onChange={(event) => {
            setVendor(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部厂商</option>
          {vendors.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <span>
          {filtered.length} 个模型 ·{' '}
          {square.snapshot
            ? new Date(square.snapshot.fetchedAt).toLocaleString('zh-CN')
            : '尚未同步'}
        </span>
        {square.url && (
          <a href={square.url} target="_blank" rel="noreferrer">
            查看原广场
          </a>
        )}
      </div>
      <div className="na-grid">
        {filtered.slice((page - 1) * 24, page * 24).map((model) => (
          <article className="na-card" key={model.model_name}>
            <div className="na-card-heading">
              <span>{model.vendor_name ?? 'New API'}</span>
              <small>
                {model.billing_mode === 'tiered_expr' || model.billing_plugin_variants?.length
                  ? '动态定价'
                  : model.quota_type === 1
                    ? '按次'
                    : '按 Token'}
              </small>
            </div>
            <h3>{model.model_name}</h3>
            {model.description && <p className="na-description">{model.description}</p>}
            <NewApiPrice
              model={model}
              rate={square.snapshot!.usdToCny}
              displayCurrency={square.snapshot!.displayCurrency}
            />
            <div className="na-card-actions">
              <button className="mg-button" onClick={() => setExpanded(model.model_name)}>
                完整价格
              </button>
              {onEdit ? (
                <button className="mg-button" onClick={() => onEdit(model)}>
                  修改价格
                </button>
              ) : availableNames?.has(model.model_name) ? (
                <AppLink to="/workspace" className="mg-button">
                  在画布使用
                </AppLink>
              ) : (
                <span className="mg-muted">连接尚未开放此模型</span>
              )}
            </div>
          </article>
        ))}
      </div>
      {!filtered.length && <p>没有符合条件的模型。</p>}
      {filtered.length > 24 && (
        <div className="na-pagination">
          <button className="mg-button" disabled={page === 1} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <span>
            {page} / {Math.ceil(filtered.length / 24)}
          </span>
          <button
            className="mg-button"
            disabled={page * 24 >= filtered.length}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
      {expanded && (
        <Modal title={expanded} onClose={() => setExpanded(null)}>
          <NewApiPrice
            key={expanded}
            model={models.find((model) => model.model_name === expanded)!}
            rate={square.snapshot!.usdToCny}
            displayCurrency={square.snapshot!.displayCurrency}
            detail
          />
        </Modal>
      )}
    </section>
  );
}

/** URL 配置、管理授权和显式写回位于模型管理首屏，原平台模型管理继续保留。 */
export function NewApiSquareAdmin({
  userId,
  onSynced,
}: {
  userId: string;
  onSynced: () => Promise<unknown>;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['management', userId, 'newapi-square'],
    retry: false,
    queryFn: ({ signal }) =>
      managementRequest<SquareAdmin>('/admin/model-marketplace/newapi', { signal }),
  });
  const action = useAction();
  const [url, setUrl] = useState<string | undefined>();
  const [token, setToken] = useState('');
  const [removeAuthorization, setRemoveAuthorization] = useState(false);
  const [editing, setEditing] = useState<NewApiPriceModel | null>(null);
  const [confirmSync, setConfirmSync] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState('');
  const pending = query.data?.drafts.filter((draft) => draft.status !== 'synced') ?? [];
  /** 广场写入已完成后，连接目录刷新失败单独提示，不把成功写回报告为失败。 */
  const refreshConnections = async () => {
    setConnectionNotice('');
    try {
      await onSynced();
    } catch {
      setConnectionNotice('广场数据已保存；画布连接刷新失败，请在连接列表重试同步。');
    }
  };
  /** 写回只能由用户明确点击触发；连接自动刷新不会走此路径。 */
  const synchronize = () =>
    action.execute(async () => {
      const result = await managementRequest<
        SquareAdmin & { results: Array<{ modelName: string; status: string; message?: string }> }
      >('/admin/model-marketplace/newapi/sync', {
        method: 'POST',
        body: { sourceRevision: query.data?.revision },
      });
      setConfirmSync(false);
      client.setQueryData(['management', userId, 'newapi-square'], result);
      await refreshConnections();
      const failures = result.results.filter((item) => item.status !== 'synced');
      if (failures.length)
        throw new Error(failures.map((item) => `${item.modelName}：${item.message}`).join('；'));
    }, '模型和价格已同步，修改价格已写回 New API');
  return (
    <section className="na-admin" aria-label="New API 广场设置">
      <h2>New API 模型广场</h2>
      <p className="mg-muted">
        填写广场地址，直接读取全部模型和价格。修改只保存为草稿，下次同步写回 New API
        并影响该站点的所有用户。
      </p>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        <form
          className="na-source-form"
          onSubmit={(event) => {
            event.preventDefault();
            void action.execute(async () => {
              const result = await managementRequest<SquareAdmin>(
                '/admin/model-marketplace/newapi',
                {
                  method: 'PUT',
                  body: {
                    url: url ?? query.data?.url ?? '',
                    revision: query.data?.revision ?? 0,
                    ...(token ? { accessToken: token } : {}),
                    ...(removeAuthorization ? { removeAuthorization: true } : {}),
                  },
                },
              );
              setToken('');
              setUrl(undefined);
              setRemoveAuthorization(false);
              setEditing(null);
              client.setQueryData(['management', userId, 'newapi-square'], result);
              await refreshConnections();
            }, '广场地址已保存，模型价格已读取');
          }}
        >
          <label>
            New API 广场地址
            <input
              required
              type="url"
              aria-label="New API 广场地址"
              placeholder="https://api.lolicon.beer/pricing"
              value={url ?? query.data?.url ?? ''}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <p className="mg-muted">
            更换站点会清除原管理授权并保留旧站草稿；模型调用连接的地址可在下方单独修改。
          </p>
          <details>
            <summary>
              价格写回授权 · {query.data?.authorized ? '已授权' : '尚未授权，仅可浏览'}
            </summary>
            <p>
              填写 New API
              超级管理员的个人访问令牌（PAT）。仅用于价格读取和写回，服务端加密保存，不作为模型调用
              Key。
            </p>
            <input
              type="password"
              aria-label="New API 管理访问令牌"
              autoComplete="new-password"
              placeholder={query.data?.authorized ? '已保存；留空保留原授权' : '不改价时无需填写'}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            {query.data?.authorized && (
              <label>
                <input
                  type="checkbox"
                  checked={removeAuthorization}
                  onChange={(event) => setRemoveAuthorization(event.target.checked)}
                />
                移除已保存的管理授权
              </label>
            )}
          </details>
          <div className="na-card-actions">
            <button className="mg-button is-primary" disabled={action.busy}>
              保存地址并读取
            </button>
            <button
              type="button"
              className="mg-button"
              disabled={action.busy || !query.data?.configured}
              onClick={() => (pending.length ? setConfirmSync(true) : void synchronize())}
            >
              <RefreshCw size={15} />
              同步模型与价格{pending.length ? `（${pending.length} 项待写回）` : ''}
            </button>
          </div>
        </form>
        <Notice value={action.notice} />
        {connectionNotice && <p role="status">{connectionNotice}</p>}
        {!!pending.length && (
          <div className="na-pending" aria-live="polite">
            {pending.map((draft) => (
              <p key={draft.modelName}>
                <strong>{draft.modelName}</strong> ·{' '}
                {draft.status === 'conflict'
                  ? '价格冲突'
                  : draft.status === 'failed'
                    ? '同步失败'
                    : draft.status === 'syncing'
                      ? '正在写回'
                      : '待同步'}
                {draft.error ? `：${draft.error}` : ''}
              </p>
            ))}
          </div>
        )}
        {query.data?.snapshot && (
          <NewApiSquareCatalog
            key={`${query.data.url}:${query.data.snapshot.displayCurrency}`}
            square={query.data}
            onEdit={setEditing}
          />
        )}
      </QueryState>
      {confirmSync && (
        <Modal title="同步价格到 New API" busy={action.busy} onClose={() => setConfirmSync(false)}>
          <p>
            将以下 {pending.length} 个模型的价格写回 {query.data?.url}。New API
            站点所有用户及画布后续请求都会采用新价；历史账单保持不变。
          </p>
          <ul>
            {pending.map((draft) => (
              <li key={draft.modelName}>{draft.modelName}</li>
            ))}
          </ul>
          <p>若 New API 后台已改价，本次同步会保留草稿并提示冲突。</p>
          <button
            className="mg-button is-primary"
            disabled={action.busy}
            onClick={() => void synchronize()}
          >
            确认同步并写回
          </button>
        </Modal>
      )}
      {editing && (
        <PriceEditor
          key={`${userId}:${query.data?.url}:${query.data?.revision}:${editing.model_name}`}
          userId={userId}
          sourceUrl={query.data?.url ?? ''}
          sourceRevision={query.data?.revision ?? 0}
          model={editing}
          authorized={query.data?.authorized ?? false}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await query.refetch();
          }}
        />
      )}
    </section>
  );
}

/** 数值编辑只定位 tier 价格表达式中的常数字面量，条件阈值、分组和请求倍率不受改价影响。 */
export function expressionPriceFields(
  source: string,
): Array<{ start: number; end: number; value: string; label: string }> {
  const result = compileBillingExpression(source);
  if (result.status !== 'ready') return [];
  const fields: Array<{ start: number; end: number; value: string; label: string }> = [];
  visitExpression(result.ast, (node) => {
    if (node.kind !== 'call' || node.name !== 'tier' || node.args.length !== 2) return;
    const label = node.args[0]?.kind === 'literal' ? String(node.args[0].value) : '价格';
    const walk = (price: ExpressionNode, subject = '') => {
      if (price.kind === 'literal' && typeof price.value === 'number')
        fields.push({
          start: price.start,
          end: price.end,
          value: source.slice(price.start, price.end),
          label: `${label}${subject ? ` · ${subject}` : ''}`,
        });
      else if (price.kind === 'binary') {
        if (price.operator === '/' && price.right.kind === 'literal') {
          walk(price.left, subject);
          return;
        }
        const term = source.slice(price.start, price.end);
        walk(price.left, subject || term);
        walk(price.right, subject || term);
      } else if (price.kind === 'call' && price.name === 'fixed') walk(price.args[0]!, 'USD / 次');
    };
    walk(node.args[1]!);
  });
  return fields;
}

/** 表达式保持原文，仅替换管理员改动的价格数字；复杂规则仍可通过原规则文本编辑。 */
function ExpressionPrices({
  value,
  onChange,
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  title: string;
}) {
  const fields = useMemo(() => expressionPriceFields(value), [value]);
  return (
    <section>
      <h4>{title}</h4>
      <div className="na-editor-fields">
        {fields.map((field) => (
          <label key={field.start}>
            {field.label}
            <input
              aria-label={field.label}
              type="number"
              min="0"
              step="any"
              value={field.value}
              onChange={(event) => {
                if (event.target.value !== '' && Number.isFinite(Number(event.target.value)))
                  onChange(
                    value.slice(0, field.start) + event.target.value + value.slice(field.end),
                  );
              }}
            />
          </label>
        ))}
      </div>
      <details open={!fields.length}>
        <summary>完整计费规则</summary>
        <textarea
          aria-label={`${title}完整规则`}
          rows={5}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </details>
    </section>
  );
}

/** 管理员修改上游现有价格，不创建平台单价、调用合同或计费规则。 */
function PriceEditor({
  userId,
  sourceUrl,
  sourceRevision,
  model,
  authorized,
  onClose,
  onSaved,
}: {
  userId: string;
  sourceUrl: string;
  sourceRevision: number;
  model: NewApiPriceModel;
  authorized: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const client = useQueryClient();
  const queryKey = [
    'management',
    userId,
    'newapi-price',
    sourceUrl,
    sourceRevision,
    model.model_name,
  ];
  const query = useQuery({
    queryKey,
    enabled: authorized,
    retry: false,
    queryFn: ({ signal }) =>
      managementRequest<EditPrice>(
        `/admin/model-marketplace/newapi/price?modelName=${encodeURIComponent(model.model_name)}`,
        { signal },
      ),
  });
  const action = useAction();
  const [draft, setDraft] = useState<NewApiPriceConfig | null>(null);
  const state = query.data;
  const config = draft ?? state?.configured ?? {};
  const effective = { ...state?.effective, ...config };
  const expressionKey = 'billing_setting.billing_expr' as const;
  const pluginKey = 'billing_setting.plugin_billing_expr' as const;
  const expression = config[expressionKey] ?? effective[expressionKey] ?? model.billing_expr;
  const isExpression =
    effective['billing_setting.billing_mode'] === 'tiered_expr' ||
    model.billing_mode === 'tiered_expr';
  return (
    <Modal title={`修改价格 · ${model.model_name}`} onClose={onClose} busy={action.busy}>
      {!authorized ? (
        <p role="alert">
          请在广场设置中填写 New API 管理访问令牌后修改价格。普通模型调用 Key 没有定价权限。
        </p>
      ) : (
        <QueryState
          loading={query.isLoading}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          <p>
            单价采用 New API 的 USD
            原始口径，分组倍率保持原值。保存后标记待同步，点击“同步模型与价格”才会写回生效。
          </p>
          {state?.version !== state?.latestVersion && (
            <p role="alert">New API 已有新价格。请先放弃本地草稿，读取最新价格后再编辑。</p>
          )}
          {isExpression && expression ? (
            <ExpressionPrices
              title="模型价格"
              value={expression}
              onChange={(value) =>
                setDraft({
                  ...config,
                  'billing_setting.billing_mode': 'tiered_expr',
                  [expressionKey]: value,
                })
              }
            />
          ) : (
            <div className="na-editor-fields">
              {(
                [
                  'ModelPrice',
                  'ModelRatio',
                  'CompletionRatio',
                  'CacheRatio',
                  'CreateCacheRatio',
                  'ImageRatio',
                  'AudioRatio',
                  'AudioCompletionRatio',
                ] as const
              )
                .filter((key) => typeof effective[key] === 'number')
                .map((key) => (
                  <label key={key}>
                    {
                      {
                        ModelPrice: '按次单价 USD',
                        ModelRatio: '输入单价 USD / 百万 Token',
                        CompletionRatio: '输出倍率',
                        CacheRatio: '缓存读取倍率',
                        CreateCacheRatio: '缓存写入倍率',
                        ImageRatio: '图片倍率',
                        AudioRatio: '音频输入倍率',
                        AudioCompletionRatio: '音频输出倍率',
                      }[key]
                    }
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={key === 'ModelRatio' ? effective[key]! * 2 : effective[key]}
                      onChange={(event) =>
                        setDraft({
                          ...config,
                          [key]: Number(event.target.value) / (key === 'ModelRatio' ? 2 : 1),
                        })
                      }
                    />
                  </label>
                ))}
            </div>
          )}
          {model.billing_plugin_variants?.map((variant) => (
            <ExpressionPrices
              key={variant.plugin_key}
              title={variant.plugin_name}
              value={config[pluginKey]?.[variant.plugin_key] ?? variant.billing_expr}
              onChange={(value) =>
                setDraft({
                  ...config,
                  [pluginKey]: { ...config[pluginKey], [variant.plugin_key]: value },
                })
              }
            />
          ))}
          <Notice value={action.notice} />
          <div className="na-card-actions">
            <button
              className="mg-button is-primary"
              disabled={action.busy || !state || !draft || state.version !== state.latestVersion}
              onClick={() =>
                void action.execute(async () => {
                  const saved = await managementRequest<EditPrice>(
                    '/admin/model-marketplace/newapi/price',
                    {
                      method: 'PUT',
                      body: {
                        modelName: model.model_name,
                        expectedVersion: state!.version,
                        sourceRevision: state!.sourceRevision,
                        revision: state!.revision,
                        pricing: draft,
                      },
                    },
                  );
                  setDraft(null);
                  client.setQueryData(queryKey, saved);
                  await onSaved();
                }, '价格草稿已保存，下次同步将写回 New API')
              }
            >
              保存待同步价格
            </button>
            {state && state.status !== 'clean' && (
              <button
                className="mg-button"
                disabled={action.busy}
                onClick={() =>
                  void action.execute(async () => {
                    const saved = await managementRequest<EditPrice>(
                      `/admin/model-marketplace/newapi/price?modelName=${encodeURIComponent(model.model_name)}&revision=${state.revision}&sourceRevision=${state.sourceRevision}`,
                      { method: 'DELETE' },
                    );
                    setDraft(null);
                    client.setQueryData(queryKey, saved);
                    await onSaved();
                  }, '本地草稿已放弃，已读取最新价格')
                }
              >
                放弃草稿并读取最新价格
              </button>
            )}
          </div>
        </QueryState>
      )}
    </Modal>
  );
}
