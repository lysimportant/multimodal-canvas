import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, getAuthSessionGeneration } from '../auth-client';
import { API_BASE_URL, type ModelEntry } from '../workspace/contracts';

export const modelCatalogQueryKey = ['model-catalog'] as const;

export function modelCatalogQueryKeyFor(credentialId?: string) {
  return credentialId ? ([...modelCatalogQueryKey, credentialId] as const) : modelCatalogQueryKey;
}

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
  if (!response.ok || !result.models) throw new Error(result.error ?? '模型列表加载失败');
  return result.models.map((model) =>
    credentialId && !model.credentialId ? { ...model, credentialId } : model,
  );
}

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
  if (!response.ok || !result.models) throw new Error(result.error ?? '模型刷新失败');
  return result.models.map((model) =>
    credentialId && !model.credentialId ? { ...model, credentialId } : model,
  );
}

export function useModelCatalogQuery(credentialId?: string) {
  return useQuery({
    queryKey: modelCatalogQueryKeyFor(credentialId),
    queryFn: ({ signal }) => fetchModelCatalog(signal, credentialId),
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
      const queryKey = modelCatalogQueryKeyFor(credentialId);
      await queryClient.cancelQueries({
        queryKey,
        exact: true,
      });
      if (getAuthSessionGeneration() !== requestGeneration)
        throw new Error('账户状态已改变，请重新操作');
      queryClient.setQueryData(queryKey, models);
      await queryClient.invalidateQueries({
        queryKey,
        exact: true,
        refetchType: 'none',
      });
    },
  });
}
