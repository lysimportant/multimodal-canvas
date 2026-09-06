import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { clearAuthSession, persistAuthSession } from '../auth-client';
import { createAppQueryClient } from './client';
import {
  aiCredentialsQueryKey,
  useActivateAiCredential,
  useAiCredentialsQuery,
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
