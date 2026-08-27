import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type { AiCredentialSummary } from '../contracts';
import { apiFetch } from '../auth-client';
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

export async function replaceAiCredentials(
  queryClient: QueryClient,
  credentials: AiCredentialSummary[],
) {
  await queryClient.cancelQueries({ queryKey: aiCredentialsQueryKey, exact: true });
  queryClient.setQueryData(aiCredentialsQueryKey, credentials);
  await queryClient.invalidateQueries({
    queryKey: aiCredentialsQueryKey,
    exact: true,
    refetchType: 'none',
  });
}

export function useAiCredentialsQuery() {
  return useQuery({
    queryKey: aiCredentialsQueryKey,
    queryFn: ({ signal }) => fetchAiCredentials(signal),
  });
}

export function useActivateAiCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: activateAiCredential,
    onSuccess: async ({ credentials }) => {
      await replaceAiCredentials(queryClient, credentials);
    },
  });
}
