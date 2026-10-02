import { assetSchema, type Asset } from '@multimodal-canvas/domain';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  apiFetch,
  getAuthSessionGeneration,
  readStoredAuthSession,
  subscribeAuthSession,
} from './auth-client';
import { API_BASE_URL, type AssetFilter } from './workspace/contracts';
import type { AssetFlowNode } from './canvas-utils';
import { resultAssetContentUrl } from './workspace/node-echo-text';

/** 与旧 API 默认首页的 50 项容量一致，避免既有首页资源从已知索引中缺失。 */
export const PROJECT_ASSET_PAGE_SIZE = 50;
/** 仅对已由输入法提交的搜索文字防抖，单位为毫秒。 */
export const PROJECT_ASSET_SEARCH_DELAY_MS = 250;

/** ResourcePanel 的受控分页；total=null 表示当前条件尚无可信总数。 */
export type ProjectAssetPagination = {
  page: number;
  pageSize: number;
  total: number | null;
  loading: boolean;
  error: string | null;
  onPageChange: (page: number) => void;
  onRetry: () => void;
};

/** 用户和项目缺一时不查询；身份只用于隔离缓存，授权仍由服务端校验。 */
export type ProjectAssetOptions = {
  projectId: string | null;
  userId: string | null;
  query: string;
  activeFilter: AssetFilter;
  showArchived: boolean;
};

/** 列表绑定完整查询，防止切换条件后的首帧显示旧结果。 */
type AssetPageState = {
  key: string;
  assets: Asset[];
  total: number | null;
  loading: boolean;
  error: string | null;
};

/** 合并已确认资源，同一 ID 的新记录覆盖旧记录，但不丢掉其他页的资源。 */
function mergeAssets(current: Asset[], incoming: readonly Asset[]): Asset[] {
  const index = new Map(current.map((asset) => [asset.id, asset]));
  for (const asset of incoming) index.set(asset.id, asset);
  return [...index.values()];
}

/** 空数组引用固定，避免未加载时使画布依赖随父组件重渲染而变化。 */
const EMPTY_ASSETS: Asset[] = [];

/**
 * 查询项目资源页，并维护独立的已知资源索引；翻页、搜索和归档筛选不清空索引。
 * @param options 当前认证用户、项目和已提交的筛选条件。
 * @returns pageAssets 仅供抽屉；knownAssets 供画布、提及与生成解析。
 * upsertAssets/removeAsset 合并已确认的业务结果并刷新当前页；旧项目回调会被忽略。
 * seedAssets 只补齐当前画布已有的显式资源记录，不覆盖索引、不刷新列表。
 * reload 仅重查当前页；失败通过 pagination.error 展示，权限失败同时清空索引。
 * 不预取其他页，也不假定存在按 ID 读取元数据的 API；未浏览资源需由调用方补齐。
 */
export function useProjectAssets({
  projectId,
  userId,
  query,
  activeFilter,
  showArchived,
}: ProjectAssetOptions) {
  const generation = useSyncExternalStore(subscribeAuthSession, getAuthSessionGeneration);
  const enabled = Boolean(projectId && userId && readStoredAuthSession()?.user.id === userId);
  const scope = JSON.stringify([projectId, userId, generation, enabled]);
  const identity = useMemo(
    () => ({ scope, accessDenied: false, removedIds: new Set<string>() }),
    [scope],
  );
  const search = query.trim();
  const filterKey = JSON.stringify([scope, search, activeFilter, showArchived]);
  const [selection, setSelection] = useState({ key: filterKey, page: 1 });
  const page = selection.key === filterKey ? selection.page : 1;
  const [revision, setRevision] = useState(0);
  const requestKey = JSON.stringify([filterKey, page, revision]);
  const [known, setKnown] = useState({ scope, assets: EMPTY_ASSETS });
  const [result, setResult] = useState<AssetPageState | null>(null);
  const scopeRef = useRef<typeof identity | null>(identity);
  const requestKeyRef = useRef(requestKey);
  const requestSequence = useRef(0);
  const previousSearch = useRef({ scope, search });
  scopeRef.current = identity;
  requestKeyRef.current = requestKey;

  useEffect(() => {
    setSelection((current) => (current.key === filterKey ? current : { key: filterKey, page: 1 }));
  }, [filterKey]);

  useEffect(() => {
    scopeRef.current = identity;
    setKnown({ scope, assets: EMPTY_ASSETS });
    return () => {
      scopeRef.current = null;
    };
  }, [scope, identity]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    const delay =
      previousSearch.current.scope === scope && previousSearch.current.search !== search
        ? PROJECT_ASSET_SEARCH_DELAY_MS
        : 0;
    previousSearch.current = { scope, search };
    if (!enabled) return;

    /** 再校验正文代次，兼容已返回响应头或忽略 AbortSignal 的请求。 */
    const isCurrent = () =>
      !controller.signal.aborted &&
      sequence === requestSequence.current &&
      requestKeyRef.current === requestKey &&
      scopeRef.current === identity &&
      generation === getAuthSessionGeneration();

    const empty = { key: requestKey, assets: EMPTY_ASSETS, total: null };
    if (search.length > 512) {
      setResult({ ...empty, loading: false, error: '搜索内容不能超过 512 个字符' });
      return;
    }
    setResult({ ...empty, loading: true, error: null });

    /** 失败不降级为无 projectId 的全局查询。 */
    const load = async () => {
      try {
        const params = new URLSearchParams({
          projectId: projectId!,
          page: String(page),
          pageSize: String(PROJECT_ASSET_PAGE_SIZE),
          status: showArchived ? 'archived' : 'ready',
        });
        if (search) params.set('query', search);
        if (activeFilter !== 'all') params.set('mediaType', activeFilter);
        const response = await apiFetch(
          `${API_BASE_URL}/v1/assets?${params}`,
          { signal: controller.signal },
          { expectedAuthGeneration: generation },
        );
        const payload = await response.json().catch(() => null);
        if (!isCurrent()) return;
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) {
            identity.accessDenied = true;
            setKnown({ scope, assets: EMPTY_ASSETS });
          }
          throw new Error(
            response.status === 404
              ? '项目不存在或无权访问'
              : typeof payload?.error === 'string'
                ? payload.error
                : `资源加载失败（${response.status}）`,
          );
        }
        const parsed = assetSchema.array().safeParse(payload?.assets);
        if (!parsed.success || payload.error !== undefined) {
          throw new Error('资源分页响应格式无效');
        }
        const hasPagination = ['total', 'page', 'pageSize'].some((field) => field in payload);
        let pageAssets = parsed.data;
        let total: number = payload.total;
        if (!hasPagination) {
          // 旧接口只返回完整 assets；仅此分支在本地过滤和切页，现代响应绝不二次过滤。
          const matching = parsed.data.filter((asset) => {
            if (asset.status !== (showArchived ? 'archived' : 'ready')) return false;
            if (activeFilter !== 'all' && asset.mediaType !== activeFilter) return false;
            const aliases = asset.metadata?.aliases;
            const searchable = [
              asset.name,
              asset.mimeType,
              ...asset.tags,
              ...(typeof asset.metadata?.alias === 'string' ? [asset.metadata.alias] : []),
              ...(Array.isArray(aliases)
                ? aliases.filter((alias) => typeof alias === 'string')
                : []),
            ]
              .join('\u0000')
              .toLocaleLowerCase();
            return searchable.includes(search.toLocaleLowerCase());
          });
          total = matching.length;
          pageAssets = matching.slice(
            (page - 1) * PROJECT_ASSET_PAGE_SIZE,
            page * PROJECT_ASSET_PAGE_SIZE,
          );
        }
        if (
          hasPagination &&
          (!Number.isSafeInteger(total) ||
            total < 0 ||
            payload.page !== page ||
            payload.pageSize !== PROJECT_ASSET_PAGE_SIZE ||
            pageAssets.length > PROJECT_ASSET_PAGE_SIZE ||
            pageAssets.length > total)
        ) {
          throw new Error('资源分页响应格式无效');
        }
        identity.accessDenied = false;
        const lastPage = Math.max(1, Math.ceil(total / PROJECT_ASSET_PAGE_SIZE));
        if (page > lastPage) {
          // 删除或归档使尾页消失时回到最后有效页，不展示误导性的空列表。
          setSelection({ key: filterKey, page: lastPage });
          return;
        }
        setKnown((current) => ({
          scope,
          assets: mergeAssets(current.scope === scope ? current.assets : EMPTY_ASSETS, parsed.data),
        }));
        setResult({
          key: requestKey,
          assets: pageAssets,
          total,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (!isCurrent()) return;
        setResult({
          ...empty,
          loading: false,
          error: error instanceof Error ? error.message : '资源加载失败',
        });
      }
    };
    const timer = delay ? setTimeout(() => void load(), delay) : undefined;
    if (!delay) void load();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    enabled,
    scope,
    identity,
    generation,
    projectId,
    filterKey,
    requestKey,
    search,
    activeFilter,
    showArchived,
    page,
  ]);

  /**
   * 刷新前立即作废在途读取，防止旧正文覆盖刚确认的业务结果。
   * 项目和认证不变时引用稳定，不依赖 query、类型、归档或页码；可供 App 初始化 effect 依赖。
   * 只推进刷新代次，由查询 effect 读取最新条件，避免旧回调重查旧页或触发画布重载。
   */
  const reload = useCallback(() => {
    if (!enabled || scopeRef.current !== identity || generation !== getAuthSessionGeneration())
      return;
    requestSequence.current++;
    setRevision((current) => current + 1);
  }, [enabled, identity, generation]);

  /**
   * 用当前已授权画布的显式记录补齐缺失资源，不发请求、不改变当前页和总数。
   * @param incoming 由 source/resultAsset 快照构造的完整 Asset；不得把冻结版本当作 latestVersion。
   * @returns 无返回值；重复 ID、已有索引和本作用域已永久删除的资源均不覆盖。
   * 切项目、身份变化、卸载或权限拒绝后的回调无效；后续服务端记录仍可覆盖快照。
   */
  const seedAssets = useCallback(
    (incoming: readonly Asset[]) => {
      if (
        !enabled ||
        scopeRef.current !== identity ||
        generation !== getAuthSessionGeneration() ||
        identity.accessDenied ||
        !incoming.length
      )
        return;
      setKnown((current) => {
        const existing = current.scope === scope ? current.assets : EMPTY_ASSETS;
        const ids = new Set(existing.map((asset) => asset.id));
        const additions = incoming.filter((asset) => {
          if (ids.has(asset.id) || identity.removedIds.has(asset.id)) return false;
          ids.add(asset.id);
          return true;
        });
        return additions.length ? { scope, assets: [...existing, ...additions] } : current;
      });
    },
    [enabled, scope, identity, generation],
  );

  /** 仅接收当前作用域内已确认的资源，不以当前页替换完整索引；随后重查列表。 */
  const upsertAssets = useCallback(
    (incoming: readonly Asset[]) => {
      if (
        !enabled ||
        scopeRef.current !== identity ||
        generation !== getAuthSessionGeneration() ||
        identity.accessDenied ||
        !incoming.length
      )
        return;
      for (const asset of incoming) identity.removedIds.delete(asset.id);
      setKnown((current) => ({
        scope,
        assets: mergeAssets(current.scope === scope ? current.assets : EMPTY_ASSETS, incoming),
      }));
      reload();
    },
    [enabled, scope, identity, generation, reload],
  );

  /** 永久删除成功后移除索引项并重查分页；归档使用 upsertAssets 保留历史引用。 */
  const removeAsset = useCallback(
    (assetId: string) => {
      if (!enabled || scopeRef.current !== identity || generation !== getAuthSessionGeneration())
        return;
      identity.removedIds.add(assetId);
      setKnown((current) => ({
        scope,
        assets:
          current.scope === scope
            ? current.assets.filter((asset) => asset.id !== assetId)
            : EMPTY_ASSETS,
      }));
      reload();
    },
    [enabled, scope, identity, generation, reload],
  );

  const current = enabled && result?.key === requestKey ? result : null;
  const total = current?.total ?? null;
  /** 页码从 1 开始；拒绝非整数和负数，已知总数时限制到最后一页。 */
  const onPageChange = useCallback(
    (nextPage: number) => {
      if (
        !enabled ||
        scopeRef.current !== identity ||
        !Number.isSafeInteger(nextPage) ||
        nextPage < 1
      )
        return;
      const lastPage =
        total === null ? page : Math.max(1, Math.ceil(total / PROJECT_ASSET_PAGE_SIZE));
      setSelection({ key: filterKey, page: Math.min(nextPage, lastPage) });
    },
    [enabled, identity, total, page, filterKey],
  );

  const loading = enabled && (current?.loading ?? true);
  const error = current?.error ?? null;
  const pagination = useMemo<ProjectAssetPagination>(
    () => ({
      page,
      pageSize: PROJECT_ASSET_PAGE_SIZE,
      total,
      loading,
      error,
      onPageChange,
      onRetry: reload,
    }),
    [page, total, loading, error, onPageChange, reload],
  );

  return {
    pageAssets: current?.assets ?? EMPTY_ASSETS,
    knownAssets: enabled && known.scope === scope ? known.assets : EMPTY_ASSETS,
    pagination,
    seedAssets,
    upsertAssets,
    removeAsset,
    reload,
  };
}

/**
 * 用当前已恢复画布的明确资源补齐解析索引，不把冻结版本冒充资源最新版。
 * @param nodes 当前项目加载成功后的节点，不能传入切项目前的旧节点。
 * @returns 可供 seedAssets 补缺的资源快照；缺少资源身份或内容地址时不构造资源。
 */
export function canvasAssetSeeds(nodes: readonly AssetFlowNode[]): Asset[] {
  return nodes.flatMap(({ data }) => {
    const result = data.manualOutput ? undefined : data.resultAsset;
    const id = result?.assetId ?? data.assetId;
    const contentUrl = result
      ? (result.contentUrl ?? resultAssetContentUrl(result.assetId, result.version))
      : data.contentUrl;
    if (!id || !contentUrl) return [];
    return [
      {
        id,
        name: data.label,
        mediaType: data.mediaType,
        mimeType: result?.mimeType ?? data.mimeType ?? 'application/octet-stream',
        sizeBytes: result?.sizeBytes ?? 0,
        contentUrl,
        status: 'ready' as const,
        tags: [],
      },
    ];
  });
}
