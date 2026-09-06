/** 用户分组资源库、受控媒体预览和任务中心。 */
import type { Asset } from '@multimodal-canvas/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  Download,
  FileImage,
  FileText,
  Film,
  FolderOpen,
  HardDrive,
  Headphones,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Tags,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '../auth-client';
import { AppLink } from '../routing';
import { API_BASE_URL } from '../workspace/contracts';
import { ManagementError, managementRequest, queryString, type ManagedUser } from './client';
import {
  formatBytes,
  formatDate,
  Modal,
  Notice,
  Pagination,
  QueryState,
  StatusBadge,
  useAction,
  UserIdentity,
} from './primitives';

/** 管理 DTO 为既有资源补充归属和产生时间，不改变画布资源契约。 */
type ManagementAsset = Asset & {
  ownerId: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  source: 'upload' | 'generated';
};

/** 资源组由服务端汇总，无归属历史资源仅在管理员范围展示。 */
type ResourceGroup = {
  ownerId: string | null;
  user: ManagedUser | null;
  resourceCount: number;
  storageBytes: number;
};

/** 跨用户资源入口固定为分组视图，不默认平铺混合资源。 */
export function ResourceGroupsPage({ userId }: { userId: string }) {
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: ['management', userId, 'resource-groups'],
    queryFn: ({ signal }) =>
      managementRequest<{ groups: ResourceGroup[] }>('/admin/resource-groups', { signal }),
  });
  const groups = query.data?.groups.filter(
    (group) =>
      !search.trim() ||
      `${group.user?.displayName ?? ''} ${group.user?.email ?? ''} ${group.user ? '' : '待确认归属'}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>RESOURCE OWNERS</p>
          <h1>用户资源</h1>
        </div>
        <button
          type="button"
          className="mg-icon"
          title="刷新资源分组"
          aria-label="刷新资源分组"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      <div className="mg-toolbar">
        <label className="mg-search">
          <Search size={17} />
          <input
            type="search"
            aria-label="搜索资源所属用户"
            placeholder="搜索用户昵称或邮箱"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <span className="mg-muted">{groups?.length ?? 0} 个用户分组</span>
      </div>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={groups?.length === 0 ? (search ? '没有匹配的用户分组' : '暂无用户资源') : undefined}
      >
        <div className="mg-owner-list">
          {groups?.map((group) => (
            <AppLink
              key={group.ownerId ?? 'unassigned'}
              to={`/admin/users/${encodeURIComponent(group.ownerId ?? 'unassigned')}/resources`}
              className="mg-owner-row"
            >
              {group.user ? (
                <UserIdentity
                  name={group.user.displayName}
                  email={group.user.email}
                  avatarUrl={group.user.avatarUrl}
                />
              ) : (
                <span className="mg-identity">
                  <span className="mg-avatar">
                    <HardDrive size={22} />
                  </span>
                  <span>
                    <strong>待确认归属</strong>
                    <small>历史资源</small>
                  </span>
                </span>
              )}
              <span className="mg-owner-count">
                <Database size={16} />
                {group.resourceCount} 项资源
              </span>
              <span className="mg-owner-size">{formatBytes(group.storageBytes)}</span>
              <ArrowRight size={18} />
            </AppLink>
          ))}
        </div>
      </QueryState>
    </>
  );
}

/** 资源列表分页契约。 */
type ResourcesResult = { assets: ManagementAsset[]; total: number; page: number; pageSize: number };

/** 资源类型的本地标签，保留一致的图标与筛选文本。 */
const mediaLabels = { text: '文本', image: '图片', audio: '音频', video: '视频' };

/** 资源类型图标固定尺寸，内容长度不会改变预览区域。 */
function MediaIcon({ type, size = 24 }: { type: string; size?: number }) {
  if (type === 'image') return <FileImage size={size} />;
  if (type === 'audio') return <Headphones size={size} />;
  if (type === 'video') return <Film size={size} />;
  return <FileText size={size} />;
}

/**
 * 个人资源只调用 account API，管理员资源必须传入明确 ownerId。
 * 用户切换时组件按 ownerId 重建，避免旧资源和旧选择短暂出现。
 */
export function ResourcesPage({ userId, ownerId }: { userId: string; ownerId?: string }) {
  const admin = ownerId !== undefined;
  const [search, setSearch] = useState('');
  const [queryText, setQueryText] = useState('');
  const [mediaType, setMediaType] = useState('');
  const [source, setSource] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [tags, setTags] = useState('');
  const [status, setStatus] = useState('ready');
  const [projectId, setProjectId] = useState(
    () => new URLSearchParams(window.location.search).get('projectId') ?? '',
  );
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ManagementAsset | null>(null);
  const basePath = admin ? '/admin/resources' : '/account/resources';
  const query = useQuery({
    queryKey: [
      'management',
      userId,
      'resources',
      ownerId ?? 'mine',
      queryText,
      mediaType,
      source,
      tags,
      status,
      projectId,
      page,
    ],
    queryFn: ({ signal }) =>
      managementRequest<ResourcesResult>(
        `${basePath}${queryString({ ...(admin ? { ownerId } : {}), query: queryText, mediaType, source, tags, status, projectId, page, pageSize: 24 })}`,
        { signal },
      ),
    refetchInterval: 30_000,
  });
  useEffect(() => {
    if (!query.data || query.isFetching) return;
    const lastPage = Math.max(1, Math.ceil(query.data.total / 24));
    if (page > lastPage) setPage(lastPage);
  }, [page, query.data, query.isFetching]);
  const owner = useQuery({
    queryKey: ['management', userId, 'user', ownerId],
    queryFn: ({ signal }) =>
      managementRequest<{ user: ManagedUser; projects: { id: string; name: string }[] }>(
        `/admin/users/${encodeURIComponent(ownerId!)}`,
        { signal },
      ),
    enabled: admin && ownerId !== 'unassigned',
  });
  const ownProjects = useQuery({
    queryKey: ['management', userId, 'own-projects'],
    queryFn: ({ signal }) =>
      managementRequest<{ projects: { id: string; name: string }[] }>(
        '/projects?includeArchived=true',
        { signal },
      ),
    enabled: !admin,
  });
  const projects = admin ? owner.data?.projects : ownProjects.data?.projects;
  return (
    <>
      {admin && (
        <AppLink to="/admin/resources" className="mg-back">
          <ArrowLeft size={16} />
          全部用户分组
        </AppLink>
      )}
      <header className="mg-heading">
        <div>
          <p>{admin ? 'USER RESOURCES' : 'MY RESOURCES'}</p>
          <h1>
            {admin
              ? ownerId === 'unassigned'
                ? '待确认归属的资源'
                : `${owner.data?.user.displayName || owner.data?.user.email || '用户'}的资源`
              : '我的资源'}
          </h1>
          {owner.data && <span className="mg-muted">{owner.data.user.email}</span>}
        </div>
        <button
          className="mg-icon"
          type="button"
          title="刷新资源"
          aria-label="刷新资源"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      <div className="mg-toolbar is-wrap">
        <form
          className="mg-search"
          onSubmit={(event) => {
            event.preventDefault();
            setQueryText(search.trim());
            setPage(1);
          }}
        >
          <Search size={17} />
          <input
            type="search"
            value={search}
            aria-label="搜索资源"
            placeholder="搜索资源名称"
            onChange={(event) => {
              setSearch(event.target.value);
              if (!event.target.value) {
                setQueryText('');
                setPage(1);
              }
            }}
          />
          <button type="submit" className="mg-icon" title="搜索" aria-label="提交资源搜索">
            <ArrowRight size={16} />
          </button>
        </form>
        <select
          value={mediaType}
          aria-label="资源类型"
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
        <select
          value={source}
          aria-label="资源来源"
          onChange={(event) => {
            setSource(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部来源</option>
          <option value="upload">上传资源</option>
          <option value="generated">生成资源</option>
        </select>
        <select
          value={status}
          aria-label="资源状态"
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="ready">正常资源</option>
          <option value="archived">已归档</option>
          <option value="">全部状态</option>
        </select>
        {projects && (
          <select
            value={projectId}
            aria-label="所属项目"
            onChange={(event) => {
              setProjectId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
        <form
          className="mg-search mg-tag-filter"
          onSubmit={(event) => {
            event.preventDefault();
            setTags(
              tagDraft
                .split(/[,，]/)
                .map((tag) => tag.trim())
                .filter(Boolean)
                .join(','),
            );
            setPage(1);
          }}
        >
          <Tags size={16} />
          <input
            type="search"
            value={tagDraft}
            maxLength={2048}
            aria-label="筛选资源标签"
            placeholder="筛选标签"
            onChange={(event) => {
              setTagDraft(event.target.value);
              if (!event.target.value) {
                setTags('');
                setPage(1);
              }
            }}
          />
          <button type="submit" className="mg-icon" title="应用标签筛选" aria-label="应用标签筛选">
            <ArrowRight size={16} />
          </button>
        </form>
        {projectId && !projects && (
          <button
            className="mg-text-button"
            onClick={() => {
              setProjectId('');
              setPage(1);
            }}
          >
            清除项目筛选
          </button>
        )}
      </div>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={
          query.data?.assets.length === 0
            ? queryText || mediaType || source || tags || projectId || status === 'archived'
              ? '没有符合条件的资源'
              : '暂无资源'
            : undefined
        }
      >
        <div className="mg-resource-grid">
          {query.data?.assets.map((asset) => (
            <button
              key={asset.id}
              type="button"
              className="mg-resource-item"
              onClick={() => setSelected(asset)}
            >
              <div className={`mg-resource-preview is-${asset.mediaType}`}>
                {asset.mediaType === 'image' ? (
                  <ResourceThumbnail asset={asset} basePath={basePath} />
                ) : (
                  <MediaIcon type={asset.mediaType} size={35} />
                )}
                <span className="mg-resource-type">{mediaLabels[asset.mediaType]}</span>
              </div>
              <div className="mg-resource-info">
                <strong title={asset.name}>{asset.name}</strong>
                <span>
                  {asset.source === 'generated' ? '生成资源' : '上传资源'}
                  <span>{formatBytes(asset.sizeBytes)}</span>
                </span>
                <small>{formatDate(asset.createdAt)}</small>
                <div className="mg-resource-tags">
                  {asset.status === 'archived' && <StatusBadge value="archived" />}
                  {asset.tags.slice(0, 3).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </div>
            </button>
          ))}
        </div>
      </QueryState>
      {query.data && (
        <Pagination
          page={page}
          pageSize={24}
          total={query.data.total}
          onChange={setPage}
          busy={query.isFetching}
        />
      )}
      {selected && (
        <ResourceModal
          key={selected.id}
          asset={selected}
          basePath={basePath}
          userId={userId}
          ownerLabel={
            owner.data?.user.email ?? (ownerId === 'unassigned' ? '待确认归属' : undefined)
          }
          onClose={() => setSelected(null)}
          onChanged={() => void query.refetch()}
        />
      )}
    </>
  );
}

/** 字节读取使用 Bearer 鉴权，不把令牌放进图片或下载 URL。 */
async function fetchResourceBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await apiFetch(`${API_BASE_URL.replace(/\/$/, '')}/v1${path}`, { signal });
  if (!response.ok)
    throw new ManagementError(`资源内容读取失败（${response.status}）`, response.status);
  return response.blob();
}

/** 可见缩略图才发起请求；用户切换或离开页面立即撤销对象 URL。 */
function ResourceThumbnail({ asset, basePath }: { asset: ManagementAsset; basePath: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    void fetchResourceBlob(
      `${basePath}/${encodeURIComponent(asset.id)}/content?derivative=thumbnail`,
      abort.signal,
    )
      .then((blob) => {
        if (!abort.signal.aborted) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => {
        /* 缩略图不可用时保留类型占位，原文件仍可在详情中读取。 */
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.id, basePath, visible]);
  return (
    <div ref={containerRef} className="mg-thumbnail">
      {url ? (
        <img src={url} alt="" loading="lazy" onError={() => setUrl(null)} />
      ) : (
        <FileImage size={35} />
      )}
    </div>
  );
}

/** 资源详情包含版本记录与项目名称，不返回存储密钥。 */
type ResourceDetail = {
  asset: ManagementAsset;
  versions: { version: number; sizeBytes: number; createdAt: string }[];
  project?: { id: string; name: string } | null;
};

/** 媒体详情和可恢复归档，在用户确认后才写入资源信息。 */
function ResourceModal({
  asset,
  basePath,
  userId,
  ownerLabel,
  onClose,
  onChanged,
}: {
  asset: ManagementAsset;
  basePath: string;
  userId: string;
  ownerLabel?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['management', userId, basePath, 'resource', asset.id],
    queryFn: ({ signal }) =>
      managementRequest<ResourceDetail>(`${basePath}/${encodeURIComponent(asset.id)}`, { signal }),
  });
  const current = query.data?.asset ?? asset;
  const [version, setVersion] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const action = useAction();
  /** 保存和归档只提交白名单字段，刷新当前用户作用域的服务端数据。 */
  const update = async (body: {
    name?: string;
    tags?: string[];
    status?: 'ready' | 'archived';
  }) => {
    await managementRequest(`${basePath}/${encodeURIComponent(asset.id)}`, {
      method: 'PATCH',
      body,
    });
    await query.refetch();
    await queryClient.invalidateQueries({ queryKey: ['management', userId, 'resource-groups'] });
    onChanged();
  };
  return (
    <Modal title={current.name} onClose={onClose} busy={action.busy}>
      <div className="mg-resource-detail">
        <section className="mg-media-region">
          <ResourceContent
            key={version}
            path={`${basePath}/${encodeURIComponent(asset.id)}/content${queryString({ version })}`}
            asset={current}
          />
          <div className="mg-form-actions">
            <button
              type="button"
              className="mg-button"
              disabled={action.busy}
              onClick={() =>
                void action.execute(async () => {
                  const blob = await fetchResourceBlob(
                    `${basePath}/${encodeURIComponent(asset.id)}/content${queryString({ version })}`,
                  );
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = current.name;
                  link.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                }, '下载已开始')
              }
            >
              <Download size={16} />
              下载
            </button>
            {Boolean(query.data?.versions.length) && (
              <select
                value={version}
                aria-label="资源版本"
                onChange={(event) => setVersion(event.target.value)}
              >
                <option value="">最新版本</option>
                {query.data?.versions.map((item) => (
                  <option key={item.version} value={item.version}>
                    版本 {item.version} · {formatDate(item.createdAt)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </section>
        <section>
          <QueryState
            loading={query.isLoading}
            error={query.error}
            onRetry={() => void query.refetch()}
          >
            <dl className="mg-details">
              <div>
                <dt>所属用户</dt>
                <dd>
                  {ownerLabel ??
                    (basePath.startsWith('/admin') ? current.ownerId || '待确认归属' : '我')}
                </dd>
              </div>
              <div>
                <dt>项目</dt>
                <dd>{query.data?.project?.name || current.projectId || '个人资源'}</dd>
              </div>
              <div>
                <dt>类型与来源</dt>
                <dd>
                  {mediaLabels[current.mediaType]} ·{' '}
                  {current.source === 'generated' ? '生成' : '上传'}
                </dd>
              </div>
              <div>
                <dt>文件大小</dt>
                <dd>{formatBytes(current.sizeBytes)}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{formatDate(current.createdAt)}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>
                  <StatusBadge value={current.status} />
                </dd>
              </div>
            </dl>
          </QueryState>
          <form
            className="mg-form"
            key={`${current.name}:${current.tags.join(',')}`}
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const tags = [
                ...new Set(
                  String(data.get('tags') ?? '')
                    .split(/[,，]/)
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                ),
              ];
              if (tags.length > 32 || tags.some((tag) => tag.length > 64)) {
                action.setNotice({
                  kind: 'error',
                  text: '最多添加 32 个标签，每个标签不超过 64 个字符',
                });
                return;
              }
              void action.execute(
                () =>
                  update({
                    name: String(data.get('name') ?? '').trim(),
                    tags,
                  }),
                '资源信息已保存',
              );
            }}
          >
            <label className="mg-field">
              <span>资源名称</span>
              <input name="name" defaultValue={current.name} required maxLength={240} />
            </label>
            <label className="mg-field">
              <span>标签</span>
              <input
                name="tags"
                defaultValue={current.tags.join(', ')}
                maxLength={1000}
                placeholder="用逗号分隔"
              />
            </label>
            <Notice value={action.notice} />
            <div className="mg-form-actions">
              <button className="mg-button is-primary" disabled={action.busy}>
                <Save size={16} />
                保存
              </button>
              <button
                className="mg-button"
                type="button"
                disabled={action.busy}
                onClick={() =>
                  current.status === 'archived'
                    ? void action.execute(() => update({ status: 'ready' }), '资源已恢复')
                    : setConfirmArchive(true)
                }
              >
                {current.status === 'archived' ? <RotateCcw size={16} /> : <Archive size={16} />}
                {current.status === 'archived' ? '恢复' : '归档'}
              </button>
            </div>
          </form>
          {confirmArchive && (
            <div className="mg-confirm-inline" role="alert">
              <p>确认归档“{current.name}”？资源将从正常列表移入归档，可随时恢复。</p>
              <div className="mg-form-actions">
                <button
                  type="button"
                  className="mg-button"
                  disabled={action.busy}
                  onClick={() =>
                    void action.execute(async () => {
                      await update({ status: 'archived' });
                      setConfirmArchive(false);
                    }, '资源已归档')
                  }
                >
                  <Archive size={16} />
                  确认归档
                </button>
                <button
                  type="button"
                  className="mg-text-button"
                  disabled={action.busy}
                  onClick={() => setConfirmArchive(false)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

/** 预览内容使用受限容器，文本按纯文本渲染，不执行上传脚本或 HTML。 */
function ResourceContent({ path, asset }: { path: string; asset: ManagementAsset }) {
  const [preview, setPreview] = useState<{ url?: string; text?: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | undefined;
    setPreview(null);
    setError(null);
    void fetchResourceBlob(path, abort.signal)
      .then(async (blob) => {
        if (abort.signal.aborted) return;
        if (asset.mediaType === 'text') {
          const text = await blob.slice(0, 256 * 1024).text();
          if (!abort.signal.aborted) setPreview({ text });
        } else {
          objectUrl = URL.createObjectURL(blob);
          setPreview({ url: objectUrl });
        }
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason);
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, asset.mediaType, retry]);
  let content: ReactNode = null;
  if (preview) {
    if (asset.mediaType === 'text') content = <pre>{preview.text || '空文本'}</pre>;
    else if (asset.mediaType === 'image')
      content = (
        <img
          src={preview.url}
          alt={asset.name}
          onError={() => setError(new Error('此图片无法预览，可以尝试下载原文件'))}
        />
      );
    else if (asset.mediaType === 'video')
      content = (
        <video
          src={preview.url}
          controls
          playsInline
          preload="metadata"
          onError={() => setError(new Error('此视频格式无法预览，可以下载原文件'))}
        />
      );
    else
      content = (
        <div className="mg-audio-preview">
          <Headphones size={45} />
          <audio
            src={preview.url}
            controls
            preload="metadata"
            onError={() => setError(new Error('此音频格式无法预览，可以下载原文件'))}
          />
        </div>
      );
  }
  return (
    <div className="mg-media-preview">
      <QueryState loading={!preview && !error} error={error} onRetry={() => setRetry(retry + 1)}>
        {content}
      </QueryState>
    </div>
  );
}

/** 任务列表省略冻结输入和 Provider 凭据，只保留可展示状态。 */
type ManagedRun = {
  id: string;
  projectId: string;
  targetNodeId: string;
  status: string;
  progress: number;
  provider: string;
  modelAlias: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  ownerId?: string | null;
  user?: ManagedUser | null;
  result?: { summary?: string; asset?: { assetId: string } };
};

/** 任务中心只刷新已创建任务，点击行不会触发付费重试。 */
export function RunsPage({ userId, admin = false }: { userId: string; admin?: boolean }) {
  const [status, setStatus] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [page, setPage] = useState(1);
  const [selectedSnapshot, setSelected] = useState<ManagedRun | null>(null);
  const query = useQuery({
    queryKey: ['management', userId, 'runs', admin, ownerId, status, page],
    queryFn: ({ signal }) =>
      managementRequest<{ runs: ManagedRun[]; total: number; page: number; pageSize: number }>(
        `${admin ? '/admin' : '/account'}/runs${queryString({ ...(admin ? { ownerId } : {}), status, page, pageSize: 20 })}`,
        { signal },
      ),
    refetchInterval: 10_000,
  });
  const groups = useQuery({
    queryKey: ['management', userId, 'resource-groups'],
    queryFn: ({ signal }) =>
      managementRequest<{ groups: ResourceGroup[] }>('/admin/resource-groups', { signal }),
    enabled: admin,
  });
  const selected =
    query.data?.runs.find((run) => run.id === selectedSnapshot?.id) ?? selectedSnapshot;
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>RUNS</p>
          <h1>{admin ? '全站任务' : '我的任务'}</h1>
        </div>
        <button
          className="mg-icon"
          type="button"
          title="刷新任务"
          aria-label="刷新任务"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      <div className="mg-toolbar">
        <select
          value={status}
          aria-label="任务状态"
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          <option value="queued">排队中</option>
          <option value="running">运行中</option>
          <option value="succeeded">已完成</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option>
        </select>
        {admin && (
          <select
            value={ownerId}
            aria-label="任务所属用户"
            onChange={(event) => {
              setOwnerId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部用户</option>
            {groups.data?.groups
              .filter((group) => group.ownerId)
              .map((group) => (
                <option key={group.ownerId} value={group.ownerId!}>
                  {group.user?.displayName || group.user?.email || group.ownerId}
                </option>
              ))}
          </select>
        )}
      </div>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={
          query.data?.runs.length === 0
            ? status || ownerId
              ? '没有符合条件的任务'
              : '暂无运行任务'
            : undefined
        }
      >
        <div className="mg-table-wrap">
          <table className="mg-table mg-runs-table">
            <thead>
              <tr>
                <th>任务与模型</th>
                {admin && <th>所属用户</th>}
                <th>状态</th>
                <th>进度</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <strong>{run.modelAlias || run.provider}</strong>
                    <small className="mg-truncate" title={run.id}>
                      {run.id}
                    </small>
                  </td>
                  {admin && (
                    <td>
                      {run.user?.displayName || run.user?.email || run.ownerId || '待确认归属'}
                    </td>
                  )}
                  <td>
                    <StatusBadge value={run.status} />
                  </td>
                  <td>
                    <span className="mg-run-progress">
                      <progress
                        max={100}
                        value={run.progress}
                        aria-label={`${run.modelAlias}的进度`}
                      />
                      <span>{run.progress}%</span>
                    </span>
                  </td>
                  <td>{formatDate(run.updatedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="mg-text-button"
                      onClick={() => setSelected(run)}
                    >
                      详情
                      <ArrowRight size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
      {query.data && (
        <Pagination
          page={page}
          pageSize={20}
          total={query.data.total}
          onChange={setPage}
          busy={query.isFetching}
        />
      )}
      {selected && (
        <Modal title="任务详情" onClose={() => setSelected(null)}>
          <dl className="mg-details is-horizontal">
            <div>
              <dt>任务</dt>
              <dd>{selected.id}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd>{selected.modelAlias}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>
                <StatusBadge value={selected.status} />
              </dd>
            </div>
            <div>
              <dt>进度</dt>
              <dd>{selected.progress}%</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{formatDate(selected.createdAt)}</dd>
            </div>
          </dl>
          {selected.error && <Notice value={{ kind: 'error', text: selected.error }} />}
          {selected.result?.summary && (
            <pre className="mg-run-result">{selected.result.summary}</pre>
          )}
          <div className="mg-form-actions">
            {(!admin || selected.ownerId === userId) && (
              <AppLink
                className="mg-button is-primary"
                to={`/projects/${encodeURIComponent(selected.projectId)}`}
              >
                <FolderOpen size={16} />
                返回画布
              </AppLink>
            )}
            <AppLink
              className="mg-button"
              to={
                admin
                  ? `/admin/users/${encodeURIComponent(selected.ownerId || 'unassigned')}/resources`
                  : '/resources'
              }
            >
              <Database size={16} />
              查看结果资源
            </AppLink>
            <button className="mg-button" type="button" onClick={() => setSelected(null)}>
              <Check size={16} />
              关闭
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
