import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { clearAuthSession, persistAuthSession } from '../auth-client';
import { createAppQueryClient } from './client';
import { modelCatalogQueryKey, modelCatalogQueryKeyFor } from './models';
import {
  aiCredentialsQueryKey,
  useActivateAiCredential,
  useAiCredentialsQuery,
  useCreateIndependentAiCredential,
} from './credentials';

/** 为不同权限场景创建独立合成会话。 */
function switchAccount(id: string, role: 'admin' | 'user') {
  persistAuthSession({
    accessToken: `synthetic-${id}`,
    tokenType: 'Bearer',
    expiresIn: 900,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    user: { id, role, email: `${id}@example.test`, createdAt: '2026-01-01T00:00:00Z' },
  });
}

/** 只含可公开摘要的合成平台凭据，用于检查越权缓存回显。 */
const credentials = [
  {
    id: 'synthetic-credential',
    baseUrl: 'https://provider.example.test/v1',
    keyFingerprint: 'synthetic-fingerprint',
    active: true,
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

beforeEach(() => {
  clearAuthSession();
  switchAccount('admin-a', 'admin');
});
afterEach(() => {
  cleanup();
  clearAuthSession();
  vi.unstubAllGlobals();
});

describe('平台凭据缓存的身份边界', () => {
  it('enabled=false 不返回已经存在或后来写入的共享凭据摘要', async () => {
    const client = createAppQueryClient();
    client.setQueryData(aiCredentialsQueryKey, credentials);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAiCredentialsQuery(false), { wrapper });
    expect(result.current.data).toBeUndefined();
    await act(async () => {
      client.setQueryData(aiCredentialsQueryKey, [{ ...credentials[0], id: 'late-credential' }]);
    });
    expect(result.current.data).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('激活凭据的晚到响应不能把旧管理员摘要写入新用户缓存', async () => {
    const client = createAppQueryClient();
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useActivateAiCredential(), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.mutateAsync('synthetic-credential').catch((error: unknown) => error);
    });
    switchAccount('ordinary-b', 'user');
    client.clear();
    await act(async () => {
      finish(
        Response.json({
          settings: { configured: true, baseUrl: credentials[0].baseUrl, defaultModels: {} },
          credentials,
        }),
      );
      await pending;
    });
    expect(await pending).toBeInstanceOf(Error);
    expect(client.getQueryData(aiCredentialsQueryKey)).toBeUndefined();
  });
});

describe('独立凭据创建', () => {
  it('以 activate:false 保存，不切换活动连接也不改动其目录缓存', async () => {
    const independent = {
      id: 'synthetic-independent',
      baseUrl: 'https://independent.example.test/v1',
      keyFingerprint: 'synthetic-independent-fingerprint',
      active: false,
      updatedAt: '2026-01-02T00:00:00Z',
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        settings: { configured: true, baseUrl: credentials[0].baseUrl, defaultModels: {} },
        credentials: [...credentials, independent],
        createdCredentialId: independent.id,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createAppQueryClient();
    client.setQueryData(aiCredentialsQueryKey, credentials);
    client.setQueryData(modelCatalogQueryKeyFor(credentials[0].id), [{ id: 'active-model' }]);
    client.setQueryData(modelCatalogQueryKey, [{ id: 'active-model' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCreateIndependentAiCredential(), { wrapper });

    let created: { credentialId: string } | undefined;
    await act(async () => {
      created = await result.current.mutateAsync({
        baseUrl: independent.baseUrl,
        apiKey: 'synthetic-independent-key',
      });
    });

    expect(created?.credentialId).toBe(independent.id);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      baseUrl: independent.baseUrl,
      apiKey: 'synthetic-independent-key',
      activate: false,
    });
    expect(client.getQueryData(aiCredentialsQueryKey)).toEqual([...credentials, independent]);
    // 活动凭据未变化，其按 ID 的目录缓存与默认回退缓存都必须保留。
    expect(client.getQueryData(modelCatalogQueryKeyFor(credentials[0].id))).toEqual([
      { id: 'active-model' },
    ]);
    expect(client.getQueryData(modelCatalogQueryKey)).toEqual([{ id: 'active-model' }]);
    // 新凭据的目录只能按自己的 ID 读取，创建过程不会写入任何目录缓存。
    expect(client.getQueryData(modelCatalogQueryKeyFor(independent.id))).toBeUndefined();
    client.clear();
  });

  it('独立凭据创建的晚到响应不能写入新账户缓存', async () => {
    const client = createAppQueryClient();
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCreateIndependentAiCredential(), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current
        .mutateAsync({ apiKey: 'synthetic-independent-key' })
        .catch((error: unknown) => error);
    });
    switchAccount('ordinary-b', 'user');
    client.clear();
    await act(async () => {
      finish(
        Response.json({
          settings: { configured: true, baseUrl: credentials[0].baseUrl, defaultModels: {} },
          credentials: [
            ...credentials,
            { ...credentials[0], id: 'late-independent', active: false },
          ],
          createdCredentialId: 'late-independent',
        }),
      );
      await pending;
    });
    expect(await pending).toBeInstanceOf(Error);
    expect(client.getQueryData(aiCredentialsQueryKey)).toBeUndefined();
  });
});
