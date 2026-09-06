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

export function useCredentialModelCatalogQueries(credentialIds: readonly string[]) {
  const uniqueCredentialIds = [...new Set(credentialIds.filter(Boolean))];
  const scopes: Array<string | undefined> =
    uniqueCredentialIds.length > 0 ? uniqueCredentialIds : [undefined];
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
