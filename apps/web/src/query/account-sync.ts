import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiFetch, getAuthSessionGeneration } from '../auth-client';
import { API_BASE_URL } from '../workspace/contracts';
import { modelCatalogQueryKey } from './models';

export type NewApiAccount = {
  issuer: string;
  externalUserId: string;
  displayName?: string;
  status: string;
  syncedAt?: string;
  error?: string;
  groups: Array<{
    group: string;
    credentialId?: string;
    credentialVersion?: number;
    repairable?: boolean;
    repairPending?: boolean;
    status: string;
    error?: string;
    modelCount?: number;
  }>;
  links: { models?: string; account?: string };
};

export const newApiAccountQueryKey = (userId?: string) =>
  ['newapi-account', userId ?? 'anonymous'] as const;

class AccountRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readAccountResponse(response: Response): Promise<NewApiAccount> {
  const payload: unknown = await response.json().catch(() => ({}));
  const result = (
    payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  ) as NewApiAccount | { account?: NewApiAccount; error?: string };
  const account = 'account' in result ? result.account : result;
  if (
    !response.ok ||
    !account ||
    typeof account !== 'object' ||
    !('groups' in account) ||
    !Array.isArray(account.groups)
  )
    throw new AccountRequestError(
      ('error' in result && result.error) || 'New API 账号加载或同步失败',
      response.status,
    );
  return account;
}

export async function fetchNewApiAccount(signal?: AbortSignal): Promise<NewApiAccount> {
  const response = await apiFetch(
    `${API_BASE_URL}/v1/account/newapi`,
    { signal },
    { expectedAuthGeneration: getAuthSessionGeneration(), skipUnauthorized: true },
  );
  return readAccountResponse(response);
}

export function useNewApiAccountQuery(userId?: string) {
  return useQuery({
    queryKey: newApiAccountQueryKey(userId),
    queryFn: ({ signal }) => fetchNewApiAccount(signal),
    enabled: Boolean(userId),
  });
}

const pendingSyncs = new WeakMap<QueryClient, Map<string, Promise<NewApiAccount>>>();

/** 手动与自动同步共享在途请求，旧会话的结果不能重新填入已清空的缓存。 */
export function synchronizeNewApiAccount(client: QueryClient, userId: string) {
  const generation = getAuthSessionGeneration();
  const identity = `${userId}:${generation}`;
  let pending = pendingSyncs.get(client);
  if (!pending) {
    pending = new Map();
    pendingSyncs.set(client, pending);
  }
  const existing = pending.get(identity);
  if (existing) return existing;
  const request = (async () => {
    const response = await apiFetch(
      `${API_BASE_URL}/v1/account/newapi/sync`,
      { method: 'POST' },
      { expectedAuthGeneration: generation },
    );
    const account = await readAccountResponse(response);
    if (generation !== getAuthSessionGeneration()) throw new Error('账号已变化，同步结果已忽略');
    await client.cancelQueries({ queryKey: newApiAccountQueryKey(userId) });
    if (generation !== getAuthSessionGeneration()) throw new Error('账号已变化，同步结果已忽略');
    client.setQueryData(newApiAccountQueryKey(userId), account);
    await client.invalidateQueries({
      queryKey: [...modelCatalogQueryKey, userId],
      refetchType: 'none',
    });
    return account;
  })().finally(() => pending.delete(identity));
  pending.set(identity, request);
  return request;
}

/** 每次打开应用或刷新页面同步一次；导航、普通重渲染和 StrictMode 不重复提交。 */
export function useAutomaticAccountSync(
  userId: string | undefined,
  ready: boolean,
  onError: (message: string) => void,
) {
  const client = useQueryClient();
  const generation = getAuthSessionGeneration();
  const attempted = useRef<string | null>(null);
  const mounted = useRef(false);
  const reportError = useRef(onError);
  reportError.current = onError;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ready || !userId) return;
    const identity = `${userId}:${generation}`;
    if (attempted.current === identity) return;
    attempted.current = identity;
    void (async () => {
      const account = await client.fetchQuery({
        queryKey: newApiAccountQueryKey(userId),
        queryFn: ({ signal }) => fetchNewApiAccount(signal),
        staleTime: 0,
      });
      if (
        !mounted.current ||
        generation !== getAuthSessionGeneration() ||
        attempted.current !== identity
      )
        return;
      if (
        !account.externalUserId ||
        !account.issuer ||
        !['active', 'unavailable'].includes(account.status)
      )
        return;
      const updated = await synchronizeNewApiAccount(client, userId);
      if (
        !mounted.current ||
        generation !== getAuthSessionGeneration() ||
        attempted.current !== identity
      )
        return;
      await client.refetchQueries(
        { queryKey: [...modelCatalogQueryKey, userId], type: 'active' },
        { throwOnError: true },
      );
      if (
        updated.status !== 'active' ||
        updated.error ||
        updated.groups.some((group) => group.status !== 'active')
      )
        throw new Error('账号或部分分组未同步成功');
    })().catch((error: unknown) => {
      if (
        !mounted.current ||
        generation !== getAuthSessionGeneration() ||
        attempted.current !== identity
      )
        return;
      // 本地账号或尚未授权的账号没有可自动同步的 New API 身份。
      if (error instanceof AccountRequestError && [401, 403, 404].includes(error.status)) return;
      reportError.current('模型与分组自动同步失败，当前数据已保留，可在设置中重试。');
    });
  }, [client, generation, ready, userId]);
}
