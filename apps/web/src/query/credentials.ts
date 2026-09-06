import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type { AiCredentialSummary } from '../contracts';
import { apiFetch, getAuthSessionGeneration } from '../auth-client';
import { API_BASE_URL, type AiSettings } from '../workspace/contracts';

export const aiCredentialsQueryKey = ['ai-credentials'] as const;

export type CredentialMutationResult = {
  settings: AiSettings;
  credentials: AiCredentialSummary[];
};

export async function fetchAiCredentials(signal?: AbortSignal): Promise<AiCredentialSummary[]> {
  const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai/credentials`, { signal });
  const result = (await response.json().catch(() => ({}))) as {
    credentials?: AiCredentialSummary[];
    error?: string;
  };
  if (!response.ok || !result.credentials) {
    throw new Error(result.error ?? '凭据列表加载失败');
  }
  return result.credentials;
}

export async function activateAiCredential(
  credentialId: string,
): Promise<CredentialMutationResult> {
  const response = await apiFetch(
    `${API_BASE_URL}/v1/settings/ai/credentials/${encodeURIComponent(credentialId)}/activate`,
    { method: 'POST' },
  );
  const result = (await response.json().catch(() => ({}))) as Partial<CredentialMutationResult> & {
    error?: string;
  };
  if (!response.ok || !result.settings || !result.credentials) {
    throw new Error(result.error ?? '凭据激活失败');
  }
  return { settings: result.settings, credentials: result.credentials };
}

/** 将本次管理员操作的摘要写入缓存；身份变化后拒绝晚到结果，取消旧请求期间再次校验。 */
export async function replaceAiCredentials(
  queryClient: QueryClient,
  credentials: AiCredentialSummary[],
  requestGeneration: number,
) {
  if (getAuthSessionGeneration() !== requestGeneration)
    throw new Error('账户状态已改变，请重新操作');
  await queryClient.cancelQueries({ queryKey: aiCredentialsQueryKey, exact: true });
  if (getAuthSessionGeneration() !== requestGeneration)
    throw new Error('账户状态已改变，请重新操作');
  queryClient.setQueryData(aiCredentialsQueryKey, credentials);
  await queryClient.invalidateQueries({
    queryKey: aiCredentialsQueryKey,
    exact: true,
    refetchType: 'none',
  });
}

/** 只有有权管理平台凭据的页面才读取摘要；禁用时也隐藏已经存在的共享缓存。 */
export function useAiCredentialsQuery(enabled = true) {
  const query = useQuery({
    queryKey: aiCredentialsQueryKey,
    queryFn: ({ signal }) => fetchAiCredentials(signal),
    enabled,
  });
  return enabled ? query : { ...query, data: undefined };
}

export function useActivateAiCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: activateAiCredential,
    onMutate: () => getAuthSessionGeneration(),
    onSuccess: async ({ credentials }, _credentialId, requestGeneration) => {
      if (requestGeneration === undefined) throw new Error('缺少凭据操作身份，请重新操作');
      await replaceAiCredentials(queryClient, credentials, requestGeneration);
    },
  });
}
