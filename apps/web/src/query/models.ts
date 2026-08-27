import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth-client';
import { API_BASE_URL, type ModelEntry } from '../workspace/contracts';

export const modelCatalogQueryKey = ['model-catalog'] as const;

export async function fetchModelCatalog(signal?: AbortSignal): Promise<ModelEntry[]> {
  const response = await apiFetch(`${API_BASE_URL}/v1/models`, { signal });
  const result = (await response.json().catch(() => ({}))) as {
    models?: ModelEntry[];
    error?: string;
  };
  if (!response.ok || !result.models) throw new Error(result.error ?? '模型列表加载失败');
  return result.models;
}

export async function refreshModelCatalog(): Promise<ModelEntry[]> {
  const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai/models/refresh`, {
    method: 'POST',
  });
  const result = (await response.json().catch(() => ({}))) as {
    models?: ModelEntry[];
    error?: string;
  };
  if (!response.ok || !result.models) throw new Error(result.error ?? '模型刷新失败');
  return result.models;
}

export function useModelCatalogQuery() {
  return useQuery({
    queryKey: modelCatalogQueryKey,
    queryFn: ({ signal }) => fetchModelCatalog(signal),
  });
}

export function useRefreshModelCatalog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: refreshModelCatalog,
    onSuccess: async (models) => {
      await queryClient.cancelQueries({
        queryKey: modelCatalogQueryKey,
        exact: true,
      });
      queryClient.setQueryData(modelCatalogQueryKey, models);
      await queryClient.invalidateQueries({
        queryKey: modelCatalogQueryKey,
        exact: true,
        refetchType: 'none',
      });
    },
  });
}
