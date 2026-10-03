import {
  assetSchema,
  mediaTypeSchema,
  type Asset,
  type MediaType,
} from '@multimodal-canvas/domain';

import { apiFetch, AuthSessionChangedError, getAuthSessionGeneration } from './auth-client';
import { API_BASE_URL } from './workspace/contracts';

/** 与项目资源列表保持一致；服务端分页和旧协议本地切页均为每页 50 条。 */
const PAGE_SIZE = 50;

/** 项目资源提及的查询条件；只查询 ready 资源，不读取本地已知资源索引。 */
export type ProjectResourceSearchOptions = {
  /** 按接口规则去除首尾空白后最多 512 个字符；空字符串表示不限制关键词。 */
  query: string;
  /** all 不发送媒体类型筛选，其余值直接交由服务端查询。 */
  mediaType: 'all' | MediaType;
  /** 从 1 开始的安全整数；不自动回退或预取其它页。 */
  page: number;
  /** 取消后即使响应已经到达，也不允许返回可用资源。 */
  signal: AbortSignal;
};

/** 通过领域和分页校验的资源页；现代响应的筛选语义与总数由服务端决定。 */
export type ProjectResourceSearchPage = {
  /** 当前页的资源，最多 50 条；旧协议先过滤完整列表再切页。 */
  assets: Asset[];
  /** 当前查询的非负安全整数总数，非当前页长度。 */
  total: number;
  /** 与请求一致的页码，从 1 开始；越界页可为空。 */
  page: number;
  /** 固定为 50。 */
  pageSize: number;
};

/** 已由调用方绑定项目的查询回调；失败、取消或身份过期均拒绝 Promise。 */
export type ProjectResourceSearch = (
  options: ProjectResourceSearchOptions,
) => Promise<ProjectResourceSearchPage>;

/**
 * 通过认证接口搜索整个项目的可引用资源，失败不回退为全局查询或本地缓存。
 * @param projectId 非空项目 ID，去除首尾空白后最多 512 个字符；权限由服务端校验。
 * @param options 查询词、媒体类型、页码和取消信号；每次只请求一页 ready 资源。
 * @returns 当前页及总数；仅缺少全部分页字段的旧 assets 响应在本地过滤和切页。
 * @throws {Error} 参数非法、网络或 HTTP 请求失败、资源或分页响应不符合合同。
 * @throws {DOMException} 取消时抛出名为 AbortError 的异常，不返回迟到数据。
 * @throws {AuthSessionChangedError} 请求期间登录身份或权限代次改变。
 */
export async function searchProjectResources(
  projectId: string,
  options: ProjectResourceSearchOptions,
): Promise<ProjectResourceSearchPage> {
  const generation = getAuthSessionGeneration();
  const { query, mediaType, page, signal } = options;
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.trim().length > 512) {
    throw new Error('项目 ID 必须为 1–512 个字符');
  }
  if (typeof query !== 'string') throw new Error('搜索内容必须为字符串');
  const search = query.trim();
  if (search.length > 512) throw new Error('搜索内容不能超过 512 个字符');
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error('资源页码必须为正安全整数');
  }
  if (mediaType !== 'all' && !mediaTypeSchema.safeParse(mediaType).success) {
    throw new Error('资源媒体类型无效');
  }

  /** 响应头和正文分别校验，拒绝忽略 AbortSignal 或身份代次的迟到响应。 */
  function assertCurrentRequest(): void {
    if (signal.aborted) throw new DOMException('资源搜索已取消', 'AbortError');
    if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
  }

  assertCurrentRequest();
  const params = new URLSearchParams({
    projectId: projectId.trim(),
    page: String(page),
    pageSize: String(PAGE_SIZE),
    status: 'ready',
  });
  if (search) params.set('query', search);
  if (mediaType !== 'all') params.set('mediaType', mediaType);
  const response = await apiFetch(
    `${API_BASE_URL}/v1/assets?${params}`,
    { signal },
    { expectedAuthGeneration: generation },
  );
  assertCurrentRequest();
  const payload: unknown = await response.json().catch((cause: unknown) => {
    assertCurrentRequest();
    if (response.ok) throw new Error('资源分页响应格式无效', { cause });
    return null;
  });
  assertCurrentRequest();
  const body =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? '项目不存在或无权访问'
        : typeof body?.error === 'string'
          ? body.error
          : `资源搜索失败（${response.status}）`,
    );
  }
  const parsed = assetSchema.array().safeParse(body?.assets);
  if (!body || !parsed.success || body.error !== undefined) {
    throw new Error('资源分页响应格式无效');
  }
  if (['total', 'page', 'pageSize'].some((field) => field in body)) {
    const total = body.total;
    if (
      typeof total !== 'number' ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      body.page !== page ||
      body.pageSize !== PAGE_SIZE ||
      parsed.data.length > PAGE_SIZE ||
      parsed.data.length > Math.max(0, total - (page - 1) * PAGE_SIZE)
    ) {
      throw new Error('资源分页响应格式无效');
    }
    return { assets: parsed.data, total, page, pageSize: PAGE_SIZE };
  }

  // 旧 API 返回完整 assets；只有此分支在本地过滤，现代响应不重复解释查询语义。
  const keyword = search.toLocaleLowerCase();
  const matching = parsed.data.filter((asset) => {
    if (asset.status !== 'ready') return false;
    if (mediaType !== 'all' && asset.mediaType !== mediaType) return false;
    const aliases = asset.metadata?.aliases;
    const searchable = [
      asset.name,
      asset.mimeType,
      ...asset.tags,
      ...(typeof asset.metadata?.alias === 'string' ? [asset.metadata.alias] : []),
      ...(Array.isArray(aliases) ? aliases.filter((alias) => typeof alias === 'string') : []),
    ]
      .join('\u0000')
      .toLocaleLowerCase();
    return searchable.includes(keyword);
  });
  return {
    assets: matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: matching.length,
    page,
    pageSize: PAGE_SIZE,
  };
}
