import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type { MediaType, ModelSelection } from '@multimodal-canvas/domain';
import type { AiCredentialSummary } from '../contracts';
import { apiFetch, getAuthSessionGeneration } from '../auth-client';
import { API_BASE_URL, type AiSettings } from '../workspace/contracts';
import { modelCatalogQueryKey, modelCatalogQueryKeyFor } from './models';

export const aiCredentialsQueryKey = ['ai-credentials'] as const;

export type CredentialMutationResult = {
  settings: AiSettings;
  credentials: AiCredentialSummary[];
};

/** 新增独立凭据的输入；`label` 目前只是调用侧的连接草稿名称。 */
export type IndependentAiCredentialInput = {
  /** 省略时复用当前活动连接的基础地址。 */
  baseUrl?: string;
  apiKey: string;
  /** 服务端凭据模型没有用户可命名的连接名称字段，该值不会随请求发送。 */
  label?: string;
};

/** 单个凭据自身的类型默认模型；`null` 清除该媒体类型。 */
export type CredentialDefaultModelsInput = Partial<
  Record<MediaType, string | ModelSelection | null>
>;

/** 独立凭据创建结果；`credentialId` 可直接用于按凭据读取模型目录。 */
export type IndependentAiCredentialResult = {
  credentialId: string;
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

/**
 * 保存一个新的 API Key 并返回其凭据 ID，不切换全局活动连接。
 *
 * 请求使用 `activate: false`，因此活动连接的 ID、版本、地址、指纹和默认模型都保持不变；
 * Key 只出现在这次请求体里，响应仅返回摘要。
 */
export async function createIndependentAiCredential(
  input: IndependentAiCredentialInput,
): Promise<IndependentAiCredentialResult> {
  const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      apiKey: input.apiKey,
      activate: false,
    }),
  });
  const result = (await response.json().catch(() => ({}))) as {
    createdCredentialId?: string;
    credentials?: AiCredentialSummary[];
    error?: string;
  };
  if (!response.ok || !result.createdCredentialId || !result.credentials) {
    throw new Error(result.error ?? '独立凭据保存失败');
  }
  return { credentialId: result.createdCredentialId, credentials: result.credentials };
}

/** 更新单个凭据自身的类型默认模型，不激活该连接；返回最新摘要列表。 */
export async function updateCredentialDefaultModels(
  credentialId: string,
  defaults: CredentialDefaultModelsInput,
): Promise<AiCredentialSummary[]> {
  const response = await apiFetch(
    `${API_BASE_URL}/v1/settings/ai/credentials/${encodeURIComponent(credentialId)}/defaults`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(defaults),
    },
  );
  const result = (await response.json().catch(() => ({}))) as {
    credentials?: AiCredentialSummary[];
    error?: string;
  };
  if (!response.ok || !result.credentials) {
    throw new Error(result.error ?? '默认模型保存失败');
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
  const previous = queryClient.getQueryData<AiCredentialSummary[]>(aiCredentialsQueryKey) ?? [];
  const removed = previous.filter(
    (entry) => !credentials.some((current) => current.id === entry.id),
  );
  const resetFallback =
    previous.find((entry) => entry.active)?.id !== credentials.find((entry) => entry.active)?.id;
  for (const queryKey of [
    ...removed.map((entry) => modelCatalogQueryKeyFor(entry.id)),
    ...(resetFallback ? [modelCatalogQueryKey] : []),
  ]) {
    await queryClient.cancelQueries({ queryKey, exact: true });
    if (getAuthSessionGeneration() !== requestGeneration)
      throw new Error('账户状态已改变，请重新操作');
    queryClient.setQueryData(queryKey, []);
  }
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

/** 保存独立凭据但不切换全局活动连接；缓存写入沿用激活路径的身份校验与取消语义。 */
export function useCreateIndependentAiCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createIndependentAiCredential,
    onMutate: () => getAuthSessionGeneration(),
    onSuccess: async ({ credentials }, _input, requestGeneration) => {
      if (requestGeneration === undefined) throw new Error('缺少凭据操作身份，请重新操作');
      await replaceAiCredentials(queryClient, credentials, requestGeneration);
    },
  });
}

/** 更新单个凭据的类型默认模型；只替换凭据摘要缓存，不影响模型目录缓存。 */
export function useUpdateCredentialDefaultModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      credentialId,
      defaults,
    }: {
      credentialId: string;
      defaults: CredentialDefaultModelsInput;
    }) => updateCredentialDefaultModels(credentialId, defaults),
    onMutate: () => getAuthSessionGeneration(),
    onSuccess: async (credentials, _input, requestGeneration) => {
      if (requestGeneration === undefined) throw new Error('缺少凭据操作身份，请重新操作');
      await replaceAiCredentials(queryClient, credentials, requestGeneration);
    },
  });
}
