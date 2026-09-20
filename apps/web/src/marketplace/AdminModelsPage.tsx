/** 平台模型后台；人工资料、调用绑定和售价分别保存，发布始终由服务端校验。 */
import {
  formatCnyNanos,
  parseCnyNanos,
  type BillingPriceRule,
  type MarketplacePriceRule,
  type MediaType,
} from '@multimodal-canvas/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
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
import { credentialSourceLabel } from '../settings-utils';
import { ConnectionSyncNotice, useSyncConnections } from './ConnectionSync';
import './marketplace.css';
import { NewApiSquareAdmin } from './NewApiSquare';

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
  rule: MarketplacePriceRule;
  effectiveAt: string;
};
/** 管理员可以选择的现有连接；version 缺失时必须手动确认。 */
type Credential = {
  id: string;
  baseUrl: string;
  keyFingerprint: string;
  keySuffix?: string;
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
/** 同步来源决定目录读取合同，通用模型与 New API 定价快照分别保存。 */
type CatalogSourceType = 'models' | 'newapi_pricing' | 'newapi_managed';
/** 上游原始参考价仅供管理员核对，不换汇、不执行表达式或生成平台售价。 */
type PricingReference = {
  source: 'newapi_pricing';
  quotaType?: 0 | 1;
  modelPrice?: { amount: string; currency: 'USD'; unit: 'per_call' };
  ratios: Array<{ name: string; value: string }>;
  groups: Array<{ name: string; ratio?: string; description?: string }>;
  billingMode?: string;
  expression?: string;
  pricingVersion?: string;
  incomplete?: true;
};
/** 已规范候选明确保持未验证状态；端点声明不代表已验证能力。 */
type Candidate = {
  id: string;
  name: string;
  mediaTypes: MediaType[];
  description?: string;
  vendorName?: string;
  tags?: string[];
  endpointTypes?: string[];
  pricingReference?: PricingReference;
  managed?: { available: boolean; contract?: string; pricingVersion: string; reason?: string };
};
/** 同步状态失败时仍可能保留之前候选，缺失列表不自动删除商品。 */
type CatalogSync = {
  id: string;
  sourceType: CatalogSourceType;
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
  const connectionSync = useSyncConnections();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [mediaType, setMediaType] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<AdminModel | null>(null);
  const [deleting, setDeleting] = useState<AdminModel | null>(null);
  const [deletedNotice, setDeletedNotice] = useState('');
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
    await Promise.all([
      client.invalidateQueries({ queryKey: ['management', userId, 'models'] }),
      client.invalidateQueries({ queryKey: ['marketplace', userId] }),
      client.invalidateQueries({ queryKey: ['platform-model-catalog', userId] }),
    ]);
    if (model) setEditing(model);
  };
  const deleteDialog = deleting && (
    <DeleteModelModal
      model={deleting}
      onClose={() => setDeleting(null)}
      onDeleted={async () => {
        setDeleting(null);
        setEditing(null);
        setDeletedNotice(`已删除“${deleting.name}”，历史账单和已提交任务保留`);
        if (page > 1 && models.data?.items.length === 1) setPage(page - 1);
        await saved();
      }}
    />
  );
  if (editing)
    return (
      <>
        <ModelEditor
          key={editing.id}
          model={editing}
          userId={userId}
          credentials={credentials.data?.credentials ?? []}
          credentialError={credentials.error}
          onBack={() => setEditing(null)}
          onSaved={saved}
          onDelete={() => setDeleting(editing)}
        />
        {deleteDialog}
      </>
    );
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>MODELS</p>
          <h1>模型管理</h1>
        </div>
        <div className="mp-actions">
          <AppLink to="/settings" className="mg-button">
            管理连接与 Key
          </AppLink>
          <button className="mg-button" type="button" onClick={() => setSyncing(true)}>
            <Download size={16} />
            同步导入
          </button>
          <button
            className="mg-button"
            type="button"
            disabled={connectionSync.isPending}
            onClick={() => connectionSync.mutate(undefined)}
          >
            <RefreshCw size={16} />
            {connectionSync.isPending ? '正在同步全部连接…' : '同步全部连接到画布'}
          </button>
          <button className="mg-button is-primary" type="button" onClick={() => setCreating(true)}>
            <Plus size={16} />
            手动新建
          </button>
        </div>
      </header>
      <NewApiSquareAdmin
        userId={userId}
        onSynced={async () => {
          await connectionSync.mutateAsync(undefined);
          await saved();
        }}
      />
      <p className="mg-muted">
        同步全部连接后，用户可在画布按 Key 选择模型。New API
        模型沿用上游价格；手工模型保留独立配置。
      </p>
      <ConnectionSyncNotice
        result={connectionSync.data}
        error={connectionSync.error}
        labels={Object.fromEntries(
          (credentials.data?.credentials ?? []).map((entry) => [
            entry.id,
            credentialSourceLabel(entry),
          ]),
        )}
      />
      <Notice value={deletedNotice ? { kind: 'success', text: deletedNotice } : null} />
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
                    <div className="mp-actions">
                      <button type="button" className="mg-button" onClick={() => setEditing(model)}>
                        管理模型
                      </button>
                      <button
                        type="button"
                        className="mg-button is-danger"
                        aria-label={`删除模型 ${model.name}`}
                        onClick={() => setDeleting(model)}
                      >
                        <Trash2 size={15} />
                        删除
                      </button>
                    </div>
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
      {deleteDialog}
    </>
  );
}

/** 删除前说明对新任务和历史记录的影响；请求失败保留对话框，不自动重试。 */
function DeleteModelModal({
  model,
  onClose,
  onDeleted,
}: {
  model: AdminModel;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const action = useAction();
  return (
    <Modal title="删除模型" onClose={onClose} busy={action.busy}>
      <p>确定删除“{model.name}”？</p>
      <p className="mg-muted">
        删除后，该模型将退出模型管理、广场和新任务选择。历史账单、价格版本及已提交任务保留，后续同步不会自动恢复该模型。
      </p>
      <Notice value={action.notice} />
      <div className="mp-actions">
        <button type="button" className="mg-button" disabled={action.busy} onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="mg-button is-danger"
          disabled={action.busy}
          onClick={() =>
            void action.execute(async () => {
              await managementRequest<void>(`/admin/model-marketplace/models/${model.id}`, {
                method: 'DELETE',
              });
              await onDeleted();
            })
          }
        >
          {action.busy ? '正在删除…' : '确认删除'}
        </button>
      </div>
    </Modal>
  );
}

/** 可读价格摘要，微额价格不按分舍入。 */
function priceLabel(rule: MarketplacePriceRule): string {
  if (rule.unit === 'upstream_cost') return '沿用 New API 价格 · 人民币结算';
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
  const [sourceType, setSourceType] = useState<CatalogSourceType>('models');
  const [selected, setSelected] = useState<string[]>([]);
  const [imported, setImported] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [mediaType, setMediaType] = useState<MediaType | ''>('text');
  const query = useQuery({
    queryKey: ['management', userId, 'model-sync', credentialId, sourceType],
    enabled: Boolean(credentialId),
    queryFn: ({ signal }) =>
      managementRequest<{ sync: CatalogSync | null }>(
        `/admin/model-marketplace/sync${queryString({ credentialId, sourceType })}`,
        { signal },
      ),
  });
  const sync = query.data?.sync;
  const managed = sourceType === 'newapi_managed';
  const searchText = search.trim().toLocaleLowerCase();
  const candidates = (sync?.candidates ?? []).filter((candidate) =>
    [
      candidate.id,
      candidate.name,
      candidate.description,
      candidate.vendorName,
      ...(candidate.tags ?? []),
      ...(candidate.endpointTypes ?? []),
    ].some((value) => value?.toLocaleLowerCase().includes(searchText)),
  );
  const selectableIds = candidates
    .filter(
      (candidate) => !imported.includes(candidate.id) && (!managed || candidate.managed?.available),
    )
    .map((candidate) => candidate.id);
  /** 来源或连接变更后清空批次，避免旧来源的选择、类型和反馈混入新目录。 */
  const resetSelection = (nextSource: CatalogSourceType) => {
    setSelected([]);
    setImported([]);
    setSearch('');
    setMediaType(nextSource === 'newapi_pricing' ? '' : 'text');
    action.setNotice(null);
  };
  return (
    <Modal title="同步模型" onClose={onClose} busy={action.busy}>
      <div className="mp-form mp-sync-form">
        <Notice value={action.notice} />
        <QueryState error={credentialError} />
        <label className="mg-field">
          <span>目录来源</span>
          <select
            aria-label="目录来源"
            value={sourceType}
            disabled={action.busy}
            onChange={(event) => {
              const nextSource = event.target.value as CatalogSourceType;
              setSourceType(nextSource);
              resetSelection(nextSource);
            }}
          >
            <option value="models">通用模型目录</option>
            <option value="newapi_managed">New API 模型与价格联动</option>
            <option value="newapi_pricing">New API 定价目录</option>
          </select>
          {sourceType === 'newapi_pricing' && (
            <small>仅浏览公开目录。需要直接沿用价格，请选择“New API 模型与价格联动”。</small>
          )}
          {managed && (
            <small>沿用此 Key 对应的 New API 价格，画布人民币钱包结算，无需逐个定价。</small>
          )}
        </label>
        <label className="mg-field">
          <span>来源连接</span>
          <select
            value={credentialId}
            disabled={action.busy}
            onChange={(event) => {
              setCredentialId(event.target.value);
              resetSelection(sourceType);
            }}
          >
            <option value="">请选择已保存的连接</option>
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credentialSourceLabel(credential)}
              </option>
            ))}
          </select>
        </label>
        <p className="mg-muted">
          {!credentials.length && '尚未保存连接。'}
          <AppLink to="/settings">管理已保存连接</AppLink>，可添加或删除连接。
        </p>
        <button
          type="button"
          className="mg-button"
          disabled={!credentialId || action.busy}
          onClick={() =>
            void action.execute(async () => {
              const result = await managementRequest<{ sync: CatalogSync }>(
                '/admin/model-marketplace/sync',
                { method: 'POST', body: { credentialId, sourceType } },
              );
              setSelected([]);
              await query.refetch();
              if (result.sync.status === 'failed')
                throw new Error(
                  managed
                    ? '联动失败，已保留上次目录。请确认 New API 已升级并开启画布联动，且当前 Key 有效。'
                    : '上游目录同步失败，已保留上次候选。请检查连接后重试。',
                );
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
              <div className="mp-actions">
                <label className="mg-search">
                  <Search size={16} />
                  <input
                    aria-label="搜索候选模型"
                    placeholder="搜索名称、供应商或标签"
                    value={search}
                    disabled={action.busy}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <button
                  className="mg-button"
                  type="button"
                  disabled={
                    action.busy ||
                    sync.status !== 'succeeded' ||
                    selectableIds.every((id) => selected.includes(id))
                  }
                  onClick={() =>
                    setSelected((current) => [...new Set([...current, ...selectableIds])])
                  }
                >
                  全选当前结果
                </button>
                <button
                  className="mg-button"
                  type="button"
                  disabled={action.busy || selected.length === 0}
                  onClick={() => setSelected([])}
                >
                  清空选择
                </button>
              </div>
              <p className="mg-muted" role="status">
                当前显示 {candidates.length} 个候选 · 已选 {selected.length} 个
              </p>
              <div className="mp-candidates">
                {candidates.length === 0 && (
                  <p className="mg-muted">没有符合搜索条件的候选模型。</p>
                )}
                {candidates.map((candidate) => (
                  <article
                    className="mp-candidate"
                    key={candidate.id}
                    aria-label={`候选模型 ${candidate.id}`}
                  >
                    <label className="mp-choice">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${candidate.id}`}
                        disabled={
                          action.busy ||
                          imported.includes(candidate.id) ||
                          (managed && !candidate.managed?.available) ||
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
                    <div className="mp-candidate-info">
                      {candidate.description && <p>{candidate.description}</p>}
                      {managed && (
                        <p>
                          {candidate.managed?.available
                            ? `${candidate.mediaTypes.map((type) => mediaLabels[type]).join(' · ')} · 沿用 New API 价格`
                            : candidate.managed?.reason === 'missing_pricing'
                              ? 'New API 尚未配置价格'
                              : candidate.managed?.reason === 'invalid_model_id'
                                ? '模型 ID 不符合联动接口的长度或格式要求'
                                : 'New API 尚未提供此模型可用的调用合同'}
                        </p>
                      )}
                      {candidate.vendorName && <p>供应商：{candidate.vendorName}</p>}
                      {!!candidate.tags?.length && <p>标签：{candidate.tags.join(' · ')}</p>}
                      {!!candidate.endpointTypes?.length && (
                        <p>上游声明端点：{candidate.endpointTypes.join(' · ')}</p>
                      )}
                      {candidate.pricingReference && (
                        <CandidatePricingDetails reference={candidate.pricingReference} />
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {!managed && (
                <label className="mg-field">
                  <span>导入后的媒体类型</span>
                  <select
                    aria-label="导入后的媒体类型"
                    value={mediaType}
                    disabled={action.busy}
                    onChange={(event) => setMediaType(event.target.value as MediaType | '')}
                  >
                    {sourceType === 'newapi_pricing' && (
                      <option value="">请选择本批模型的媒体类型</option>
                    )}
                    {Object.entries(mediaLabels).map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <small>
                    本批所选模型使用同一类型。请按真实调用合同确认，名称和端点声明不代表已验证能力。
                  </small>
                </label>
              )}
              <button
                className="mg-button is-primary"
                type="button"
                disabled={
                  action.busy ||
                  selected.length === 0 ||
                  (!managed && !mediaType) ||
                  sync.status !== 'succeeded'
                }
                onClick={() =>
                  void action.execute(
                    async () => {
                      if (!managed && !mediaType) throw new Error('请先确认本批模型的媒体类型');
                      for (const id of selected) {
                        await managementRequest('/admin/model-marketplace/models', {
                          method: 'POST',
                          body: {
                            source: { syncId: sync.id, upstreamModelId: id },
                            ...(managed ? { managed: true } : { mediaType }),
                          },
                        });
                        setImported((current) => [...current, id]);
                        setSelected((current) => current.filter((value) => value !== id));
                      }
                      await onImported();
                    },
                    managed
                      ? '所选模型已联动，价格沿用 New API；已有暂停状态保持不变'
                      : '所选模型已导入为草稿',
                  )
                }
              >
                {managed ? '联动所选' : '导入所选'} {selected.length} 个模型
              </button>
            </>
          )}
        </QueryState>
      </div>
    </Modal>
  );
}

/** 展示原始目录参考数据；金额和分组大小写原样保留，表达式仅作为文本显示。 */
function CandidatePricingDetails({ reference }: { reference: PricingReference }) {
  return (
    <details className="mp-pricing-reference">
      <summary>上游参考价格 · USD</summary>
      <p>目录价格和分组用于参考，实际费用以所用 Key 和上游账单为准。</p>
      {reference.incomplete && <p>插件计费参考不完整，需到上游核实。</p>}
      <dl>
        {reference.expression || reference.billingMode || reference.incomplete ? (
          <div>
            <dt>目录计费方式</dt>
            <dd>
              {reference.expression
                ? '表达式'
                : reference.incomplete
                  ? '插件计费'
                  : reference.billingMode}
            </dd>
          </div>
        ) : reference.quotaType !== undefined ? (
          <div>
            <dt>目录计费方式</dt>
            <dd>{reference.quotaType === 1 ? '按次' : 'Token 倍率'}</dd>
          </div>
        ) : null}
        {reference.modelPrice && (
          <div>
            <dt>目录基础价</dt>
            <dd>{reference.modelPrice.amount} USD / 次</dd>
          </div>
        )}
        {reference.billingMode && (
          <div>
            <dt>计费模式</dt>
            <dd>{reference.billingMode}</dd>
          </div>
        )}
        {reference.ratios.map((ratio) => (
          <div key={ratio.name}>
            <dt>{ratio.name}</dt>
            <dd>{ratio.value}</dd>
          </div>
        ))}
        {reference.groups.map((group) => (
          <div key={group.name}>
            <dt>分组 {group.name}</dt>
            <dd>
              倍率：{group.ratio ?? '未提供'}
              {group.description ? ` · ${group.description}` : ''}
            </dd>
          </div>
        ))}
        {reference.pricingVersion && (
          <div>
            <dt>来源版本标记</dt>
            <dd>{reference.pricingVersion}</dd>
          </div>
        )}
      </dl>
      {!!reference.ratios.length &&
        (reference.expression || reference.billingMode || reference.incomplete) && (
          <p>上述倍率是目录原始字段，实际计费还需结合上游表达式或插件规则核实。</p>
        )}
      {reference.expression && (
        <>
          <p>上游计费表达式（仅展示）</p>
          <pre className="mp-evidence">{reference.expression}</pre>
        </>
      )}
    </details>
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
  onDelete,
}: {
  model: AdminModel;
  userId: string;
  credentials: Credential[];
  credentialError: unknown;
  onBack: () => void;
  onSaved: (model?: AdminModel) => Promise<void>;
  onDelete: () => void;
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
        <div className="mp-actions">
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
          <button
            type="button"
            className="mg-button is-danger"
            disabled={action.busy}
            onClick={onDelete}
          >
            <Trash2 size={15} />
            删除模型
          </button>
        </div>
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
        {model.pricing?.rule.unit === 'upstream_cost' ? (
          <section className="mg-panel">
            <h2>New API 价格</h2>
            <p>
              该模型直接使用 New API 计价。请返回模型管理，在上方 New API
              广场点击“修改价格”，保存后同步写回。
            </p>
            <button type="button" className="mg-button" onClick={onBack}>
              返回 New API 广场
            </button>
          </section>
        ) : (
          <PricingForm model={model} userId={userId} onSaved={onSaved} />
        )}
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
                  {credentialSourceLabel(credential)}
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
  const [mode, setMode] = useState<'manual' | 'newapi'>(
    model.pricing?.rule.unit === 'upstream_cost' ? 'newapi' : 'manual',
  );
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
      <label className="mg-field">
        <span>价格来源</span>
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as 'manual' | 'newapi')}
        >
          <option value="newapi">沿用 New API 价格</option>
          <option value="manual">手工定价</option>
        </select>
      </label>
      {mode === 'newapi' ? (
        <div className="mp-form">
          <p className="mg-muted">
            价格由 New API
            维护，无需填写单价。提交前确认人民币预算，交付后按最终账单结算，扣款不超过确认金额。
          </p>
          {!model.activeBindingId && (
            <p className="mg-muted">请先完成调用绑定，或从“New API 模型与价格联动”导入。</p>
          )}
          <button
            type="button"
            className="mg-button is-primary"
            disabled={
              action.busy || !model.activeBindingId || model.pricing?.rule.unit === 'upstream_cost'
            }
            onClick={() =>
              void action.execute(async () => {
                await managementRequest('/admin/pricing-versions', {
                  method: 'POST',
                  body: {
                    platformModelId: model.id,
                    currency: 'CNY',
                    rule: { unit: 'upstream_cost', meteringSource: 'newapi_receipt' },
                    activate: true,
                  },
                });
                await refresh();
              }, '已沿用 New API 价格，无需重复定价')
            }
          >
            {model.pricing?.rule.unit === 'upstream_cost'
              ? '当前沿用 New API 价格'
              : '启用 New API 价格'}
          </button>
        </div>
      ) : (
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
      )}
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
