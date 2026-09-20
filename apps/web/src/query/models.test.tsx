import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, clearAuthSession, persistAuthSession, type AuthUser } from '../auth-client';
import { createAppQueryClient } from './client';
import {
  fetchModelCatalog,
  modelCatalogQueryKeyFor,
  useModelCatalogQuery,
  usePlatformModelCatalogQuery,
} from './models';

vi.mock('../auth-client', async (original) => ({
  ...(await original<typeof import('../auth-client')>()),
  apiFetch: vi.fn(),
}));

const user = (id: string): AuthUser => ({
  id,
  displayName: id,
  role: 'user',
  createdAt: '2026-09-21T00:00:00.000Z',
});

/** 为 Hook 提供独立查询缓存。 */
function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  clearAuthSession();
  vi.mocked(apiFetch).mockReset();
});

afterEach(() => {
  cleanup();
  clearAuthSession();
});

describe('New API 模型目录', () => {
  it('上游不可用状态传给模型选择器，不能被旧可用值覆盖', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      Response.json({
        models: [
          {
            id: 'blocked',
            group: 'vip',
            credentialId: 'vip-id',
            mediaTypes: ['text'],
            available: false,
            availability: 'available',
            unavailableReason: '分组已撤销',
          },
          {
            id: 'ready',
            group: 'default',
            credentialId: 'default-id',
            mediaTypes: ['text'],
            available: true,
          },
        ],
      }),
    );
    await expect(fetchModelCatalog()).resolves.toEqual([
      expect.objectContaining({
        id: 'blocked',
        availability: 'unavailable',
        unavailableReason: '分组已撤销',
      }),
      expect.objectContaining({ id: 'ready', availability: 'available' }),
    ]);
  });
  it('保留同名模型的分组和凭据身份', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      Response.json({
        models: [
          {
            id: 'same-model',
            name: '同名模型',
            group: 'general',
            credentialId: 'credential-general',
            mediaTypes: ['text'],
          },
          {
            id: 'same-model',
            name: '同名模型',
            group: 'premium',
            credentialId: 'credential-premium',
            mediaTypes: ['text'],
          },
        ],
      }),
    );
    await expect(fetchModelCatalog()).resolves.toEqual([
      expect.objectContaining({ group: 'general', credentialId: 'credential-general' }),
      expect.objectContaining({ group: 'premium', credentialId: 'credential-premium' }),
    ]);
    expect(apiFetch).toHaveBeenCalledWith('http://localhost:3000/v1/models', {
      signal: undefined,
    });
  });

  it('按凭据读取时补全服务端省略的凭据身份', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      Response.json({ models: [{ id: 'image-a', name: '图片 A', mediaTypes: ['image'] }] }),
    );
    await expect(fetchModelCatalog(undefined, 'credential-a')).resolves.toEqual([
      expect.objectContaining({ id: 'image-a', credentialId: 'credential-a' }),
    ]);
    expect(apiFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/models?credentialId=credential-a',
      { signal: undefined },
    );
  });

  it('所有实际目录键包含本人身份和凭据范围', async () => {
    persistAuthSession({ user: user('user-a') });
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ models: [] }));
    const client = createAppQueryClient();
    const view = renderHook(() => useModelCatalogQuery('credential-a'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(modelCatalogQueryKeyFor('credential-a')).toEqual([
      'model-catalog',
      'user-a',
      'credential-a',
    ]);
    expect(client.getQueryState(['model-catalog', 'user-a', 'credential-a'])).toBeDefined();
    expect(client.getQueryState(['model-catalog', 'credential-a'])).toBeUndefined();
    client.clear();
  });

  it('换号后迟到目录只能写入旧用户键，不能覆盖当前结果', async () => {
    let finishOld!: (response: Response) => void;
    let finishNew!: (response: Response) => void;
    vi.mocked(apiFetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishNew = resolve;
          }),
      );
    const client = createAppQueryClient();
    const view = renderHook(({ ownerId }) => usePlatformModelCatalogQuery(ownerId), {
      initialProps: { ownerId: 'user-old' },
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    view.rerender({ ownerId: 'user-new' });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await act(async () => {
      finishNew(
        Response.json({ models: [{ id: 'new-model', name: '新模型', mediaTypes: ['text'] }] }),
      );
    });
    await waitFor(() => expect(view.result.current.data?.[0]?.id).toBe('new-model'));
    await act(async () => {
      finishOld(
        Response.json({ models: [{ id: 'old-model', name: '旧模型', mediaTypes: ['text'] }] }),
      );
    });
    expect(view.result.current.data?.[0]?.id).toBe('new-model');
    expect(client.getQueryData(modelCatalogQueryKeyFor(undefined, 'user-new'))).toEqual([
      expect.objectContaining({ id: 'new-model' }),
    ]);
    client.clear();
  });

  it('授权失效时显示分组恢复提示', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      Response.json(
        { error: 'credential rejected', code: 'credential_group_mismatch' },
        { status: 409 },
      ),
    );
    await expect(fetchModelCatalog()).rejects.toThrow('所选分组授权已失效');
  });
});
