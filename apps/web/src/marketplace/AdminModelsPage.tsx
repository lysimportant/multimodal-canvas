/** 平台模型后台；人工资料、调用绑定和售价分别保存，发布始终由服务端校验。 */
import {
  formatCnyNanos,
  parseCnyNanos,
  type BillingPriceRule,
  type MediaType,
} from '@multimodal-canvas/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Plus, RefreshCw, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { managementRequest, queryString } from '../management/client';
import {
  formatDate,
  Modal,
  Notice,
  Pagination,
  QueryState,
  useAction,
} from '../management/primitives';
import { AppLink } from '../routing';
import './marketplace.css';

/** 管理员商品记录，绑定凭据只通过管理员独立接口读取。 */
type AdminModel = {
  id: string;
  name: string;
  description: string;
  mediaType: MediaType;
  specifications: Record<string, unknown>;
  status: string;
  availability: string;
  availabilityReason?: string;
  activeBindingId: string | null;
  activePricingVersionId: string | null;
  modelAlias?: string;
  pricing: Pricing | null;
  sortOrder: number;
};
/** 不可变价格记录；金额始终是 nanos 文本。 */
type Pricing = {
  id: string;
  revision: number;
  currency: string;
  rule: BillingPriceRule;
  effectiveAt: string;
};
/** 管理员可以选择的现有连接；version 缺失时必须手动确认。 */
type Credential = {
  id: string;
  baseUrl: string;
  keyFingerprint: string;
  active: boolean;
  version?: number;
};
/** 调用绑定的脱密版本信息。 */
type Binding = {
  id: string;
  revision: number;
  credentialId: string;
  credentialVersion: number;
  upstreamModelId: string;
  contract: string;
  verificationEvidence: string;
  verifiedAt: string;
};
/** 已规范候选明确保持未验证状态。 */
type Candidate = { id: string; name: string; mediaTypes: MediaType[] };
/** 同步状态失败时仍可能保留之前候选，缺失列表不自动删除商品。 */
type CatalogSync = {
  id: string;
  status: string;
  candidates: Candidate[];
  missing: string[];
  createdAt: string;
  errorCode?: string;
};
/** 管理分页响应。 */
type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
/** 已实现的四种媒体展示名称。 */
const mediaLabels: Record<MediaType, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
};
/** 价格单位显示与服务端规则一致。 */
const unitLabels: Record<BillingPriceRule['unit'], string> = {
  per_call: '按次',
  per_image: '按图片张数',
  per_token: '按 Token',
  per_second: '按秒',
  per_character: '按字符',
};

/** 模型列表、搜索、候选同步及编辑入口，缓存始终按管理员身份分离。 */
export function AdminModelsPage({ userId }: { userId: string }) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [mediaType, setMediaType] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<AdminModel | null>(null);
  const models = useQuery({
    queryKey: ['management', userId, 'models', query, status, mediaType, page],
    queryFn: ({ signal }) =>
      managementRequest<Page<AdminModel>>(
        `/admin/model-marketplace/models${queryString({ query, status, mediaType, page, pageSize: 20 })}`,
        { signal },
      ),
  });
  const credentials = useQuery({
    queryKey: ['management', userId, 'model-credentials'],
    queryFn: ({ signal }) =>
      managementRequest<{ credentials: Credential[] }>('/settings/ai/credentials', { signal }),
  });
  /** 成功保存后使列表失效，同时更新当前编辑对象，避免旧版本继续被误用。 */
  const saved = async (model?: AdminModel) => {
    await client.invalidateQueries({ queryKey: ['management', userId, 'models'] });
    if (model) setEditing(model);
  };
  if (editing)
    return (
      <ModelEditor
        key={editing.id}
        model={editing}
        userId={userId}
        credentials={credentials.data?.credentials ?? []}
        credentialError={credentials.error}
        onBack={() => setEditing(null)}
        onSaved={saved}
      />
    );
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>MODELS</p>
          <h1>模型管理</h1>
        </div>
        <div className="mp-actions">
          <button className="mg-button" type="button" onClick={() => setSyncing(true)}>
            <Download size={16} />
            同步导入
          </button>
          <button className="mg-button is-primary" type="button" onClick={() => setCreating(true)}>
            <Plus size={16} />
            手动新建
          </button>
        </div>
      </header>
      <p className="mg-muted">
        先保存平台模型，再配置经验证的调用绑定和人民币售价。更换连接会保留模型身份和历史版本。
      </p>
      <form
        className="mg-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setQuery(search);
        }}
      >
        <label className="mg-search">
          <Search size={16} />
          <input
            aria-label="搜索模型"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索模型名称"
          />
        </label>
        <select
          aria-label="发布状态"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="published">已上架</option>
          <option value="paused">已暂停</option>
        </select>
        <select
          aria-label="媒体类型筛选"
          value={mediaType}
          onChange={(event) => {
            setMediaType(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部类型</option>
          {Object.entries(mediaLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button className="mg-button" type="submit">
          搜索
        </button>
        <button
          className="mg-icon"
          type="button"
          aria-label="刷新模型"
          disabled={models.isFetching}
          onClick={() => void models.refetch()}
        >
          <RefreshCw size={17} />
        </button>
      </form>
      <QueryState
        loading={models.isLoading}
        error={models.error}
        onRetry={() => void models.refetch()}
        empty={
          models.data?.items.length === 0
            ? '还没有平台模型。可以手动新建，或从连接目录选择导入。'
            : undefined
        }
      >
        <div className="mg-table-wrap">
          <table className="mg-table mp-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>类型</th>
                <th>发布与可用状态</th>
                <th>平台售价</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {models.data?.items.map((model) => (
                <tr key={model.id}>
                  <td>
                    <strong>{model.name}</strong>
                    <small>{model.modelAlias ?? '尚未绑定上游模型'}</small>
                  </td>
                  <td>{mediaLabels[model.mediaType]}</td>
                  <td>
                    <span
                      className={`mg-badge is-${model.status === 'published' ? 'active' : 'pending'}`}
                    >
                      {model.status === 'published'
                        ? '已上架'
                        : model.status === 'paused'
                          ? '已暂停'
                          : '草稿'}
                    </span>
                    {model.availability !== 'available' && (
                      <small>{model.availabilityReason ?? '配置待完善'}</small>
                    )}
                  </td>
                  <td>{model.pricing ? priceLabel(model.pricing.rule) : '未定价'}</td>
                  <td>
                    <button type="button" className="mg-button" onClick={() => setEditing(model)}>
                      管理模型
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
      {models.data && (
        <Pagination
          page={page}
          pageSize={20}
          total={models.data.total}
          onChange={setPage}
          busy={models.isFetching}
        />
      )}
      {creating && (
        <CreateModelModal
          onClose={() => setCreating(false)}
          onCreated={async (model) => {
            setCreating(false);
            await saved(model);
          }}
        />
      )}
      {syncing && (
        <SyncModelsModal
          userId={userId}
          credentials={credentials.data?.credentials ?? []}
          credentialError={credentials.error}
          onClose={() => setSyncing(false)}
          onImported={async () => {
            await saved();
          }}
        />
      )}
    </>
  );
}

/** 可读价格摘要，微额价格不按分舍入。 */
function priceLabel(rule: BillingPriceRule): string {
  return rule.unit === 'per_token'
    ? `输入 ¥${formatCnyNanos(rule.inputPriceNanos)} / 输出 ¥${formatCnyNanos(rule.outputPriceNanos)} · 百万 Token`
    : `¥${formatCnyNanos(rule.unitPriceNanos)} · ${unitLabels[rule.unit]}`;
}

/** 手工建立不依赖上游同步的草稿商品，不能直接上架。 */
function CreateModelModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (model: AdminModel) => Promise<void>;
}) {
  const action = useAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mediaType, setMediaType] = useState<MediaType>('text');
  return (
    <Modal title="手动新建模型" onClose={onClose} busy={action.busy}>
      <form
        className="mp-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.execute(async () => {
            const result = await managementRequest<{ model: AdminModel }>(
              '/admin/model-marketplace/models',
              { method: 'POST', body: { name, description, mediaType } },
            );
            await onCreated(result.model);
          });
        }}
      >
        <Notice value={action.notice} />
        <label className="mg-field">
          <span>展示名称</span>
          <input
            required
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="mg-field">
          <span>媒体类型</span>
          <select
            value={mediaType}
            onChange={(event) => setMediaType(event.target.value as MediaType)}
          >
            {Object.entries(mediaLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="mg-field">
          <span>模型介绍</span>
          <textarea
            rows={3}
            maxLength={4000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <p className="mg-muted">
          创建后继续配置调用绑定和售价；媒体类型是商品合同的一部分，创建后保持固定。
        </p>
        <button type="submit" className="mg-button is-primary" disabled={action.busy}>
          {action.busy ? '正在创建…' : '创建草稿'}
        </button>
      </form>
    </Modal>
  );
}

/** 候选同步失败保留旧列表，但必须成功来源才能导入新草稿。 */
function SyncModelsModal({
  userId,
  credentials,
  credentialError,
  onClose,
  onImported,
}: {
  userId: string;
  credentials: Credential[];
  credentialError: unknown;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const action = useAction();
  const [credentialId, setCredentialId] = useState(credentials[0]?.id ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [imported, setImported] = useState<string[]>([]);
  const [mediaType, setMediaType] = useState<MediaType>('text');
  const query = useQuery({
    queryKey: ['management', userId, 'model-sync', credentialId],
    enabled: Boolean(credentialId),
    queryFn: ({ signal }) =>
      managementRequest<{ sync: CatalogSync | null }>(
        `/admin/model-marketplace/sync?credentialId=${encodeURIComponent(credentialId)}`,
        { signal },
      ),
  });
  const sync = query.data?.sync;
  return (
    <Modal title="同步候选并导入草稿" onClose={onClose} busy={action.busy}>
      <div className="mp-form">
        <Notice value={action.notice} />
        <QueryState error={credentialError} />
        <label className="mg-field">
          <span>来源连接</span>
          <select
            value={credentialId}
            disabled={action.busy}
            onChange={(event) => {
              setCredentialId(event.target.value);
              setSelected([]);
              setImported([]);
            }}
          >
            <option value="">请选择已保存的连接</option>
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.baseUrl} · {credential.keyFingerprint}
              </option>
            ))}
          </select>
        </label>
        {!credentials.length && (
          <p className="mg-muted">
            尚未保存连接。<AppLink to="/settings">前往连接与 Key</AppLink>
          </p>
        )}
        <button
          type="button"
          className="mg-button"
          disabled={!credentialId || action.busy}
          onClick={() =>
            void action.execute(async () => {
              const result = await managementRequest<{ sync: CatalogSync }>(
                '/admin/model-marketplace/sync',
                { method: 'POST', body: { credentialId } },
              );
              setSelected([]);
              await query.refetch();
              if (result.sync.status === 'failed')
                throw new Error('上游目录同步失败，已保留上次候选。请检查连接后重试。');
            }, '候选目录已更新，尚未上架任何模型')
          }
        >
          {action.busy ? '正在处理…' : '同步此连接'}
        </button>
        <QueryState
          loading={query.isLoading && Boolean(credentialId)}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          {!sync && <p className="mg-muted">此连接尚未同步。同步后选择需要导入的平台模型。</p>}
          {sync && (
            <>
              <p className="mg-muted">
                同步于 {formatDate(sync.createdAt)} ·{' '}
                {sync.status === 'succeeded'
                  ? `${sync.candidates.length} 个候选`
                  : '同步失败，显示上次候选'}
              </p>
              {sync.missing.length > 0 && (
                <p role="status" className="mg-muted">
                  本次目录缺少 {sync.missing.length} 个旧模型，已有平台模型继续保留。
                </p>
              )}
              <div className="mp-candidates">
                {sync.candidates.map((candidate) => (
                  <label className="mp-choice" key={candidate.id}>
                    <input
                      type="checkbox"
                      disabled={
                        action.busy ||
                        imported.includes(candidate.id) ||
                        sync.status !== 'succeeded'
                      }
                      checked={selected.includes(candidate.id)}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...selected, candidate.id]
                            : selected.filter((id) => id !== candidate.id),
                        )
                      }
                    />
                    <span>
                      <strong>{candidate.name}</strong>
                      <small>
                        {candidate.id}
                        {imported.includes(candidate.id) ? ' · 已导入' : ''}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              <label className="mg-field">
                <span>导入后的媒体类型</span>
                <select
                  value={mediaType}
                  onChange={(event) => setMediaType(event.target.value as MediaType)}
                >
                  {Object.entries(mediaLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <small>请按真实调用合同确认；候选名称和类型推断不代表已验证能力。</small>
              </label>
              <button
                className="mg-button is-primary"
                type="button"
                disabled={action.busy || selected.length === 0 || sync.status !== 'succeeded'}
                onClick={() =>
                  void action.execute(async () => {
                    for (const id of selected) {
                      await managementRequest('/admin/model-marketplace/models', {
                        method: 'POST',
                        body: { source: { syncId: sync.id, upstreamModelId: id }, mediaType },
                      });
                      setImported((current) => [...current, id]);
                      setSelected((current) => current.filter((value) => value !== id));
                    }
                    await onImported();
                  }, '所选模型已导入为草稿')
                }
              >
                导入所选 {selected.length} 个模型
              </button>
            </>
          )}
        </QueryState>
      </div>
    </Modal>
  );
}

/** 模型编辑保留当前商品身份，切换绑定和价格必须明确点击。 */
function ModelEditor({
  model,
  userId,
  credentials,
  credentialError,
  onBack,
  onSaved,
}: {
  model: AdminModel;
  userId: string;
  credentials: Credential[];
  credentialError: unknown;
  onBack: () => void;
  onSaved: (model?: AdminModel) => Promise<void>;
}) {
  const action = useAction();
  const [tab, setTab] = useState<'details' | 'binding' | 'pricing'>('details');
  const [name, setName] = useState(model.name);
  const [description, setDescription] = useState(model.description);
  const [sortOrder, setSortOrder] = useState(String(model.sortOrder));
  const [sizes, setSizes] = useState(readList(model.specifications.sizes));
  const [qualities, setQualities] = useState(readList(model.specifications.qualities));
  const [extra, setExtra] = useState(JSON.stringify(model.specifications, null, 2));
  /** 更新后取回服务端当前版本指针与状态。 */
  const patch = async (body: unknown) => {
    const result = await managementRequest<{ model: AdminModel }>(
      `/admin/model-marketplace/models/${model.id}`,
      { method: 'PATCH', body },
    );
    await onSaved(result.model);
  };
  return (
    <>
      <button type="button" className="mg-back" onClick={onBack}>
        <ArrowLeft size={16} />
        返回模型列表
      </button>
      <header className="mg-heading">
        <div>
          <p>{mediaLabels[model.mediaType]} · 平台模型</p>
          <h1>{model.name}</h1>
        </div>
        <button
          className="mg-button is-primary"
          type="button"
          disabled={
            action.busy ||
            ((!model.activeBindingId || !model.activePricingVersionId) &&
              model.status !== 'published')
          }
          onClick={() =>
            void action.execute(
              () => patch({ status: model.status === 'published' ? 'paused' : 'published' }),
              model.status === 'published' ? '模型已暂停，新任务不可再选用' : '模型已上架',
            )
          }
        >
          {model.status === 'published' ? '暂停模型' : '上架模型'}
        </button>
      </header>
      <p className="mg-muted">
        平台编号：{model.id} · {model.availabilityReason ?? '当前配置可用'}
      </p>
      <Notice value={action.notice} />
      <nav className="mp-tabs" aria-label="模型设置">
        <button type="button" aria-pressed={tab === 'details'} onClick={() => setTab('details')}>
          基本资料
        </button>
        <button type="button" aria-pressed={tab === 'binding'} onClick={() => setTab('binding')}>
          调用绑定
        </button>
        <button type="button" aria-pressed={tab === 'pricing'} onClick={() => setTab('pricing')}>
          平台定价
        </button>
      </nav>
      <div hidden={tab !== 'details'}>
        <form
          className="mg-section mp-form"
          onSubmit={(event) => {
            event.preventDefault();
            void action.execute(
              () =>
                patch({
                  name,
                  description,
                  sortOrder: Number(sortOrder),
                  specifications: {
                    ...parseObject(extra),
                    sizes: splitList(sizes),
                    qualities: splitList(qualities),
                  },
                }),
              '模型资料已保存',
            );
          }}
        >
          <div className="mp-grid">
            <label className="mg-field">
              <span>展示名称</span>
              <input
                required
                maxLength={160}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="mg-field">
              <span>排序值</span>
              <input
                required
                type="number"
                min={-1000000}
                max={1000000}
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value)}
              />
            </label>
          </div>
          <label className="mg-field">
            <span>模型介绍</span>
            <textarea
              rows={3}
              maxLength={4000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="mp-grid">
            <label className="mg-field">
              <span>展示尺寸或分辨率</span>
              <input
                value={sizes}
                onChange={(event) => setSizes(event.target.value)}
                placeholder="1024x1024, 1536x1024"
              />
            </label>
            <label className="mg-field">
              <span>展示质量档位</span>
              <input
                value={qualities}
                onChange={(event) => setQualities(event.target.value)}
                placeholder="standard, high"
              />
            </label>
          </div>
          <details>
            <summary>其他规格（高级）</summary>
            <label className="mg-field">
              <span>规格 JSON</span>
              <textarea
                className="mp-code"
                rows={5}
                value={extra}
                onChange={(event) => setExtra(event.target.value)}
              />
            </label>
          </details>
          <p className="mg-muted">
            媒体类型：{mediaLabels[model.mediaType]}。展示规格不代替调用绑定中的真实能力约束。
          </p>
          <button type="submit" className="mg-button is-primary" disabled={action.busy}>
            保存资料
          </button>
        </form>
      </div>
      <div hidden={tab !== 'binding'}>
        <BindingForm
          model={model}
          userId={userId}
          credentials={credentials}
          credentialError={credentialError}
          onSaved={onSaved}
        />
      </div>
      <div hidden={tab !== 'pricing'}>
        <PricingForm model={model} userId={userId} onSaved={onSaved} />
      </div>
    </>
  );
}

/** 绑定表单要求真实模型 ID、支持的合同与人工验证依据，提交不触发生成。 */
function BindingForm({
  model,
  userId,
  credentials,
  credentialError,
  onSaved,
}: {
  model: AdminModel;
  userId: string;
  credentials: Credential[];
  credentialError: unknown;
  onSaved: (model?: AdminModel) => Promise<void>;
}) {
  const action = useAction();
  const [credentialId, setCredentialId] = useState(credentials[0]?.id ?? '');
  const [version, setVersion] = useState(String(credentials[0]?.version ?? 1));
  const [upstreamModelId, setUpstreamModelId] = useState(model.modelAlias ?? '');
  const [contract, setContract] = useState(
    model.mediaType === 'video'
      ? 'newapi-video-v1'
      : model.mediaType === 'image'
        ? 'openai-images'
        : model.mediaType === 'audio'
          ? 'openai-audio'
          : 'openai-chat-completions',
  );
  const [sizes, setSizes] = useState('');
  const [maxImages, setMaxImages] = useState('');
  const [imageEdit, setImageEdit] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [capabilities, setCapabilities] = useState('{}');
  const [limitations, setLimitations] = useState('{}');
  const [activate, setActivate] = useState(true);
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: ['management', userId, 'model-bindings', model.id, page],
    queryFn: ({ signal }) =>
      managementRequest<Page<Binding>>(
        `/admin/model-marketplace/models/${model.id}/bindings?page=${page}`,
        { signal },
      ),
  });
  /** 刷新父列表及绑定历史后同步当前商品，避免旧 activeBindingId 留在按钮状态中。 */
  const refresh = async () => {
    await history.refetch();
    const result = await managementRequest<{ model: AdminModel }>(
      `/admin/model-marketplace/models/${model.id}`,
    );
    await onSaved(result.model);
  };
  return (
    <section className="mg-section">
      <h2>新建调用绑定</h2>
      <Notice value={action.notice} />
      <QueryState error={credentialError} />
      <form
        className="mp-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.execute(async () => {
            await managementRequest(`/admin/model-marketplace/models/${model.id}/bindings`, {
              method: 'POST',
              body: {
                credentialId,
                credentialVersion: Number(version),
                upstreamModelId,
                contract,
                capabilities: {
                  ...parseObject(capabilities),
                  mediaTypes: [model.mediaType],
                  ...(sizes ? { sizes: splitList(sizes) } : {}),
                  ...(model.mediaType === 'image' ? { imageEdit: { supported: imageEdit } } : {}),
                },
                limitations: {
                  ...parseObject(limitations),
                  ...(maxImages ? { maxImages: Number(maxImages) } : {}),
                },
                verificationEvidence: evidence,
                activate,
              },
            });
            await refresh();
            setEvidence('');
          }, '调用绑定新版本已保存');
        }}
      >
        <div className="mp-grid">
          <label className="mg-field">
            <span>调用连接</span>
            <select
              required
              value={credentialId}
              onChange={(event) => {
                setCredentialId(event.target.value);
                setVersion(
                  String(credentials.find((item) => item.id === event.target.value)?.version ?? 1),
                );
              }}
            >
              <option value="">选择已保存连接</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.baseUrl} · {credential.keyFingerprint}
                </option>
              ))}
            </select>
          </label>
          <label className="mg-field">
            <span>凭据版本</span>
            <input
              required
              type="number"
              min={1}
              step={1}
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              readOnly={Boolean(credentials.find((item) => item.id === credentialId)?.version)}
            />
          </label>
        </div>
        <label className="mg-field">
          <span>精确上游模型 ID</span>
          <input
            required
            maxLength={512}
            value={upstreamModelId}
            onChange={(event) => setUpstreamModelId(event.target.value)}
            placeholder="保留大小写、后缀及按次标记"
          />
        </label>
        <label className="mg-field">
          <span>调用合同</span>
          <select value={contract} onChange={(event) => setContract(event.target.value)}>
            {(model.mediaType === 'video'
              ? ['newapi-video-v1', 'newapi-unified-v1', 'legacy-v1']
              : [contract]
            ).map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <div className="mp-grid">
          <label className="mg-field">
            <span>已验证尺寸</span>
            <input
              value={sizes}
              onChange={(event) => setSizes(event.target.value)}
              placeholder="用逗号分隔，留空表示未声明"
            />
          </label>
          <label className="mg-field">
            <span>最多图片数量</span>
            <input
              type="number"
              min={1}
              value={maxImages}
              onChange={(event) => setMaxImages(event.target.value)}
            />
          </label>
        </div>
        {model.mediaType === 'image' && (
          <label className="mp-choice">
            <input
              type="checkbox"
              checked={imageEdit}
              onChange={(event) => setImageEdit(event.target.checked)}
            />
            已验证图片编辑能力
          </label>
        )}
        <label className="mg-field">
          <span>验证依据</span>
          <textarea
            required
            rows={3}
            maxLength={4000}
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            placeholder="记录已核实的合同、输入限制与验证结果；不要填写 Key"
          />
        </label>
        <details>
          <summary>更多能力和参数限制（高级）</summary>
          <div className="mp-grid">
            <label className="mg-field">
              <span>已验证能力 JSON</span>
              <textarea
                className="mp-code"
                rows={5}
                value={capabilities}
                onChange={(event) => setCapabilities(event.target.value)}
              />
            </label>
            <label className="mg-field">
              <span>参数限制 JSON</span>
              <textarea
                className="mp-code"
                rows={5}
                value={limitations}
                onChange={(event) => setLimitations(event.target.value)}
              />
            </label>
          </div>
        </details>
        <label className="mp-choice">
          <input
            type="checkbox"
            checked={activate}
            onChange={(event) => setActivate(event.target.checked)}
          />
          保存后启用此版本，用于之后的新任务
        </label>
        <button
          className="mg-button is-primary"
          type="submit"
          disabled={action.busy || !credentialId}
        >
          {action.busy ? '正在保存…' : '保存调用绑定'}
        </button>
      </form>
      <h3>历史绑定</h3>
      <QueryState
        loading={history.isLoading}
        error={history.error}
        empty={history.data?.items.length === 0 ? '尚无绑定版本' : undefined}
      >
        <div className="mp-version-list">
          {history.data?.items.map((binding) => (
            <div key={binding.id}>
              <span>
                <strong>
                  版本 {binding.revision} · {binding.upstreamModelId}
                </strong>
                <small>
                  {binding.contract} · 凭据版本 {binding.credentialVersion} ·{' '}
                  {formatDate(binding.verifiedAt)}
                </small>
              </span>
              <button
                className="mg-button"
                type="button"
                disabled={action.busy || model.activeBindingId === binding.id}
                onClick={() =>
                  void action.execute(async () => {
                    await managementRequest(`/admin/model-marketplace/models/${model.id}`, {
                      method: 'PATCH',
                      body: { activeBindingId: binding.id },
                    });
                    await refresh();
                  }, '当前绑定已切换')
                }
              >
                {model.activeBindingId === binding.id ? '当前使用' : '启用版本'}
              </button>
            </div>
          ))}
        </div>
      </QueryState>
      {history.data && (
        <Pagination
          page={page}
          pageSize={30}
          total={history.data.total}
          onChange={setPage}
          busy={history.isFetching}
        />
      )}
    </section>
  );
}

/** 人民币定价表单把元文本精确转为 nanos，不以 number 处理用户价格。 */
function PricingForm({
  model,
  userId,
  onSaved,
}: {
  model: AdminModel;
  userId: string;
  onSaved: (model?: AdminModel) => Promise<void>;
}) {
  const action = useAction();
  const [unit, setUnit] = useState<BillingPriceRule['unit']>('per_call');
  const [price, setPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [maxQuantity, setMaxQuantity] = useState('1');
  const [maxDuration, setMaxDuration] = useState('10');
  const [maxInput, setMaxInput] = useState('10000');
  const [maxOutput, setMaxOutput] = useState('4096');
  const [maxCharacters, setMaxCharacters] = useState('10000');
  const [rounding, setRounding] = useState('exact');
  const [source, setSource] = useState('output_metadata');
  const [variants, setVariants] = useState('');
  const [activate, setActivate] = useState(true);
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: ['management', userId, 'model-pricing', model.id, page],
    queryFn: ({ signal }) =>
      managementRequest<Page<Pricing>>(
        `/admin/pricing-versions?platformModelId=${model.id}&page=${page}`,
        { signal },
      ),
  });
  /** 当前商品及版本列表在写入后重新读取，旧价格历史继续显示。 */
  const refresh = async () => {
    await history.refetch();
    const result = await managementRequest<{ model: AdminModel }>(
      `/admin/model-marketplace/models/${model.id}`,
    );
    await onSaved(result.model);
  };
  /** 构造当前收费单位的明确计量合同，单价为空时不会解释成零元。 */
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.execute(async () => {
      const pricing =
        unit === 'per_token'
          ? {
              unit,
              meteringSource: 'provider_usage',
              inputPriceNanos: parseCnyNanos(price),
              outputPriceNanos: parseCnyNanos(outputPrice),
              maxInputTokens: Number(maxInput),
              maxOutputTokens: Number(maxOutput),
            }
          : {
              unit,
              meteringSource:
                unit === 'per_call'
                  ? 'fixed'
                  : unit === 'per_character'
                    ? 'input_characters'
                    : unit === 'per_image'
                      ? 'output_metadata'
                      : source,
              unitPriceNanos: parseCnyNanos(price),
              ...(unit === 'per_image' || unit === 'per_second'
                ? { minQuantity: 1, maxQuantity: Number(maxQuantity) }
                : {}),
              ...(unit === 'per_second'
                ? { maxDurationSeconds: maxDuration, durationRounding: rounding }
                : {}),
              ...(unit === 'per_character' ? { maxCharacters: Number(maxCharacters) } : {}),
            };
      let parsedVariants: unknown;
      if (variants.trim()) {
        parsedVariants = JSON.parse(variants);
        if (!Array.isArray(parsedVariants)) throw new Error('规格价格必须是 JSON 数组');
      }
      await managementRequest('/admin/pricing-versions', {
        method: 'POST',
        body: {
          platformModelId: model.id,
          currency: 'CNY',
          rule: { ...pricing, ...(parsedVariants ? { variants: parsedVariants } : {}) },
          activate,
        },
      });
      await refresh();
    }, '人民币价格新版本已保存');
  };
  const units: BillingPriceRule['unit'][] =
    model.mediaType === 'text'
      ? ['per_call', 'per_token']
      : model.mediaType === 'image'
        ? ['per_call', 'per_image']
        : model.mediaType === 'video'
          ? ['per_call', 'per_second']
          : ['per_call', 'per_second', 'per_character'];
  return (
    <section className="mg-section">
      <h2>新建价格版本</h2>
      <Notice value={action.notice} />
      <form className="mp-form" onSubmit={submit}>
        <label className="mg-field">
          <span>收费单位</span>
          <select
            value={unit}
            onChange={(event) => setUnit(event.target.value as BillingPriceRule['unit'])}
          >
            {units.map((value) => (
              <option key={value} value={value}>
                {unitLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <div className="mp-grid">
          <label className="mg-field">
            <span>
              {unit === 'per_token'
                ? '输入单价（元 / 百万 Token）'
                : `单价（元 / ${unit === 'per_call' ? '次' : unit === 'per_image' ? '张' : unit === 'per_second' ? '秒' : '字符'}）`}
            </span>
            <input
              required
              inputMode="decimal"
              pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder="例如 0.002；免费请明确填写 0"
            />
          </label>
          {unit === 'per_token' && (
            <label className="mg-field">
              <span>输出单价（元 / 百万 Token）</span>
              <input
                required
                inputMode="decimal"
                value={outputPrice}
                onChange={(event) => setOutputPrice(event.target.value)}
              />
            </label>
          )}
        </div>
        {(unit === 'per_image' || unit === 'per_second') && (
          <label className="mg-field">
            <span>单个子调用最多交付数量</span>
            <input
              required
              type="number"
              min={1}
              max={10000}
              value={maxQuantity}
              onChange={(event) => setMaxQuantity(event.target.value)}
            />
          </label>
        )}
        {unit === 'per_second' && (
          <div className="mp-grid">
            <label className="mg-field">
              <span>每份输出最长秒数</span>
              <input
                required
                inputMode="decimal"
                value={maxDuration}
                onChange={(event) => setMaxDuration(event.target.value)}
              />
            </label>
            <label className="mg-field">
              <span>时长计量来源</span>
              <select value={source} onChange={(event) => setSource(event.target.value)}>
                <option value="output_metadata">已交付文件时长</option>
                <option value="provider_usage">上游已验证用量</option>
              </select>
            </label>
            <label className="mg-field">
              <span>时长取整</span>
              <select value={rounding} onChange={(event) => setRounding(event.target.value)}>
                <option value="exact">按实际时长</option>
                <option value="ceil_second">每份向上取整到秒</option>
              </select>
            </label>
          </div>
        )}
        {unit === 'per_token' && (
          <div className="mp-grid">
            <label className="mg-field">
              <span>最大输入 Token</span>
              <input
                required
                type="number"
                min={0}
                value={maxInput}
                onChange={(event) => setMaxInput(event.target.value)}
              />
            </label>
            <label className="mg-field">
              <span>最大输出 Token</span>
              <input
                required
                type="number"
                min={0}
                value={maxOutput}
                onChange={(event) => setMaxOutput(event.target.value)}
              />
            </label>
          </div>
        )}
        {unit === 'per_character' && (
          <label className="mg-field">
            <span>最大输入字符数</span>
            <input
              required
              type="number"
              min={1}
              value={maxCharacters}
              onChange={(event) => setMaxCharacters(event.target.value)}
            />
          </label>
        )}
        <details>
          <summary>按规格覆盖单价（高级）</summary>
          <label className="mg-field">
            <span>规格价格 JSON 数组</span>
            <textarea
              className="mp-code"
              rows={5}
              value={variants}
              onChange={(event) => setVariants(event.target.value)}
              placeholder={'[{"parameters":{"size":"1024x1024"},"unitPriceNanos":"200000000"}]'}
            />
            <small>
              金额使用十亿分之一元整数字符串；有规格价格时必须精确匹配，不回退默认价格。
            </small>
          </label>
        </details>
        <label className="mp-choice">
          <input
            type="checkbox"
            checked={activate}
            onChange={(event) => setActivate(event.target.checked)}
          />
          保存后启用此价格版本
        </label>
        <p className="mg-muted">缺少实际计量的任务将待核实。定价不会改动已确认任务的价格。</p>
        <button className="mg-button is-primary" type="submit" disabled={action.busy}>
          {action.busy ? '正在保存…' : '保存价格版本'}
        </button>
      </form>
      <h3>价格历史</h3>
      <QueryState
        loading={history.isLoading}
        error={history.error}
        empty={history.data?.items.length === 0 ? '尚无价格版本' : undefined}
      >
        <div className="mp-version-list">
          {history.data?.items.map((pricing) => (
            <div key={pricing.id}>
              <span>
                <strong>
                  版本 {pricing.revision} · {priceLabel(pricing.rule)}
                </strong>
                <small>{formatDate(pricing.effectiveAt)} 生效</small>
              </span>
              <button
                type="button"
                className="mg-button"
                disabled={action.busy || pricing.id === model.activePricingVersionId}
                onClick={() =>
                  void action.execute(async () => {
                    await managementRequest(`/admin/model-marketplace/models/${model.id}`, {
                      method: 'PATCH',
                      body: { activePricingVersionId: pricing.id },
                    });
                    await refresh();
                  }, '当前售价已切换')
                }
              >
                {pricing.id === model.activePricingVersionId ? '当前使用' : '启用版本'}
              </button>
            </div>
          ))}
        </div>
      </QueryState>
      {history.data && (
        <Pagination
          page={page}
          pageSize={30}
          total={history.data.total}
          onChange={setPage}
          busy={history.isFetching}
        />
      )}
    </section>
  );
}

/** 高级输入必须为对象；错误交由现有操作反馈展示。 */
function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new Error('高级配置必须是 JSON 对象');
  return value as Record<string, unknown>;
}
/** 逗号或换行列表不改变每个实际值的大小写。 */
function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
/** 显示现有数组以便编辑，未知结构交由高级 JSON 保留。 */
function readList(value: unknown): string {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').join(', ') : '';
}
