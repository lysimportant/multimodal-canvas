import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, getAuthSessionGeneration } from '../auth-client';
import { API_BASE_URL, type ModelEntry } from '../workspace/contracts';
import type { AiCredentialSummary } from '../contracts';
import { fetchMarketplace, marketplaceSelection } from '../marketplace/client';

/** 节点只读取已上架平台商品，分页合并保留每个稳定商品身份。 */
export function usePlatformModelCatalogQuery(ownerId?: string) {
  return useQuery({
    queryKey: ['platform-model-catalog', ownerId],
    enabled: Boolean(ownerId),
    queryFn: async ({ signal }) => {
      const items: ModelEntry[] = [];
      for (let page = 1; ; page += 1) {
        const result = await fetchMarketplace({ page, signal });
        items.push(...result.items.map(marketplaceSelection));
        if (!result.items.length || items.length >= result.total) return items;
      }
    },
  });
}

export const modelCatalogQueryKey = ['model-catalog'] as const;

export function modelCatalogQueryKeyFor(credentialId?: string) {
  return credentialId ? ([...modelCatalogQueryKey, credentialId] as const) : modelCatalogQueryKey;
}

/** 将服务端的缺失凭据错误转为可操作的中文提示，其他错误保留原有上下文。 */
function catalogErrorMessage(error: string | undefined, fallback: string): string {
  return error?.trim().toLowerCase() === 'credential not found'
    ? '连接凭据不存在或已删除，请重新保存连接后再刷新模型'
    : (error ?? fallback);
}

/** 按凭据 ID 读取模型目录；缺失凭据或加载失败时抛出错误，signal 可取消请求。 */
export async function fetchModelCatalog(
  signal?: AbortSignal,
  credentialId?: string,
): Promise<ModelEntry[]> {
  const query = credentialId ? `?${new URLSearchParams({ credentialId }).toString()}` : '';
  const response = await apiFetch(`${API_BASE_URL}/v1/models${query}`, { signal });
  const result = (await response.json().catch(() => ({}))) as {
    models?: ModelEntry[];
    error?: string;
  };
  if (!response.ok || !result.models)
    throw new Error(catalogErrorMessage(result.error, '模型列表加载失败'));
  return result.models.map((model) =>
    credentialId && !model.credentialId ? { ...model, credentialId } : model,
  );
}

/** 刷新指定凭据的目录并返回带来源的模型；省略 ID 时刷新活动连接，失败时抛出错误。 */
export async function refreshModelCatalog(credentialId?: string): Promise<ModelEntry[]> {
  const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai/models/refresh`, {
    method: 'POST',
    ...(credentialId
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ credentialId }),
        }
      : {}),
  });
  const result = (await response.json().catch(() => ({}))) as {
    models?: ModelEntry[];
    error?: string;
  };
  if (!response.ok || !result.models)
    throw new Error(catalogErrorMessage(result.error, '模型刷新失败'));
  return result.models.map((model) =>
    credentialId && !model.credentialId ? { ...model, credentialId } : model,
  );
}

export function useModelCatalogQuery(credentialId?: string, enabled = true) {
  return useQuery({
    queryKey: modelCatalogQueryKeyFor(credentialId),
    queryFn: ({ signal }) => fetchModelCatalog(signal, credentialId),
    enabled,
  });
}

/**
 * 按凭据读取模型目录；未启用时返回空查询，避免普通用户触发平台模型接口。
 * @param credentialIds 需要读取的凭据 ID；空列表代表当前激活凭据。
 * @param enabled 是否允许发起平台模型目录请求。
 */
export function useCredentialModelCatalogQueries(credentialIds: readonly string[], enabled = true) {
  const uniqueCredentialIds = [...new Set(credentialIds.filter(Boolean))];
  const scopes: Array<string | undefined> = !enabled
    ? []
    : uniqueCredentialIds.length > 0
      ? uniqueCredentialIds
      : [undefined];
  return useQueries({
    queries: scopes.map((credentialId) => ({
      queryKey: modelCatalogQueryKeyFor(credentialId),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchModelCatalog(signal, credentialId),
    })),
  });
}

export function useRefreshModelCatalog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: refreshModelCatalog,
    onMutate: () => getAuthSessionGeneration(),
    onSuccess: async (models, credentialId, requestGeneration) => {
      if (getAuthSessionGeneration() !== requestGeneration)
        throw new Error('账户状态已改变，请重新操作');
      const credentials = queryClient.getQueryData<AiCredentialSummary[]>(['ai-credentials']);
      if (credentialId && credentials && !credentials.some((entry) => entry.id === credentialId))
        throw new Error('凭据已删除，请选择可用的 API Key');
      const queryKey = modelCatalogQueryKeyFor(credentialId);
      await queryClient.cancelQueries({
        queryKey,
        exact: true,
      });
      if (getAuthSessionGeneration() !== requestGeneration)
        throw new Error('账户状态已改变，请重新操作');
      const currentCredentials = queryClient.getQueryData<AiCredentialSummary[]>([
        'ai-credentials',
      ]);
      if (
        credentialId &&
        currentCredentials &&
        !currentCredentials.some((entry) => entry.id === credentialId)
      )
        throw new Error('凭据已删除，请选择可用的 API Key');
      queryClient.setQueryData(queryKey, models);
      await queryClient.invalidateQueries({
        queryKey,
        exact: true,
        refetchType: 'none',
      });
    },
  });
}
