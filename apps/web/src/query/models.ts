import { useQuery } from '@tanstack/react-query';

import { apiFetch, readStoredAuthSession } from '../auth-client';
import { API_BASE_URL, type ModelEntry } from '../workspace/contracts';

/** 模型目录缓存根键；实际查询必须追加用户身份和凭据范围。 */
export const modelCatalogQueryKey = ['model-catalog'] as const;

/** 返回当前浏览器公开会话的不可变用户 ID。 */
function currentUserId(): string | undefined {
  return readStoredAuthSession()?.user.id;
}

/**
 * 构造用户隔离的目录键。
 *
 * @param credentialId 可选分组凭据；省略时表示当前账号的完整目录。
 * @param userId 当前用户 ID；省略时从公开 Cookie 会话镜像读取。
 * @returns 包含用户和凭据范围的稳定 React Query 键。
 */
export function modelCatalogQueryKeyFor(credentialId?: string, userId = currentUserId()) {
  return [...modelCatalogQueryKey, userId ?? 'anonymous', credentialId ?? 'all'] as const;
}

/** 将服务端凭据错误转换为可操作提示，其他错误保留原文。 */
function catalogErrorMessage(
  error: string | undefined,
  code: string | undefined,
  fallback: string,
): string {
  if (code === 'group_credential_invalid' || code === 'credential_group_mismatch')
    return '所选分组授权已失效，请同步分组并明确重新选择';
  return error?.trim().toLowerCase() === 'credential not found'
    ? '分组授权不存在或已失效，请重新登录后同步分组'
    : (error ?? fallback);
}

/**
 * 读取当前账号的模型目录。
 *
 * @param signal 页面或查询生命周期取消信号。
 * @param credentialId 可选分组凭据 ID。
 * @returns 保留精确模型别名、分组和凭据身份的目录。
 * @throws 服务端拒绝或响应缺少模型数组时抛出可读错误。
 */
export async function fetchModelCatalog(
  signal?: AbortSignal,
  credentialId?: string,
): Promise<ModelEntry[]> {
  const query = credentialId ? `?${new URLSearchParams({ credentialId }).toString()}` : '';
  const response = await apiFetch(`${API_BASE_URL}/v1/models${query}`, { signal });
  const result = (await response.json().catch(() => ({}))) as {
    models?: ModelEntry[];
    error?: string;
    code?: string;
  };
  if (!response.ok || !result.models)
    throw new Error(catalogErrorMessage(result.error, result.code, '模型列表加载失败'));
  return result.models.map((model) => ({
    ...model,
    ...(credentialId && !model.credentialId ? { credentialId } : {}),
    ...(model.available !== undefined
      ? { availability: model.available ? ('available' as const) : ('unavailable' as const) }
      : {}),
  }));
}

/** 节点目录查询；用户 ID 变化会切换缓存且取消旧观察者。 */
export function usePlatformModelCatalogQuery(userId?: string) {
  return useQuery({
    queryKey: modelCatalogQueryKeyFor(undefined, userId),
    enabled: Boolean(userId),
    queryFn: ({ signal }) => fetchModelCatalog(signal),
  });
}

/** 设置面板目录查询；键从当前公开会话读取用户 ID。 */
export function useModelCatalogQuery(credentialId?: string, enabled = true) {
  const userId = currentUserId();
  return useQuery({
    queryKey: modelCatalogQueryKeyFor(credentialId, userId),
    queryFn: ({ signal }) => fetchModelCatalog(signal, credentialId),
    enabled: enabled && Boolean(userId),
  });
}
