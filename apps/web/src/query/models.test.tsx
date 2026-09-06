import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from './client';
import { clearAuthSession, persistAuthSession } from '../auth-client';
import {
  modelCatalogQueryKey,
  modelCatalogQueryKeyFor,
  useModelCatalogQuery,
  useRefreshModelCatalog,
} from './models';

afterEach(() => {
  cleanup();
  clearAuthSession();
  vi.unstubAllGlobals();
});

describe('model catalog query', () => {
  it('模型刷新晚于换号完成时不重填新账户的目录缓存', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const client = createAppQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRefreshModelCatalog(), { wrapper });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.mutateAsync('old-credential').catch((error: unknown) => error);
    });
    persistAuthSession({
      accessToken: 'synthetic-new-account',
      tokenType: 'Bearer',
      expiresIn: 900,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      user: {
        id: 'new-account',
        role: 'user',
        email: 'new@example.test',
        createdAt: '2026-01-01T00:00:00Z',
      },
    });
    client.clear();
    await act(async () => {
      finish(
        Response.json({
          models: [{ id: 'private-model', name: 'Private model', mediaTypes: ['text'] }],
        }),
      );
      await pending;
    });
    expect(await pending).toBeInstanceOf(Error);
    expect(client.getQueryData(modelCatalogQueryKeyFor('old-credential'))).toBeUndefined();
  });
  it('caches the catalog and invalidates it after a manual refresh', async () => {
    const initialModels = [{ id: 'text-v1', name: 'Text V1', mediaTypes: ['text'] }];
    const refreshedModels = [{ id: 'text-v2', name: 'Text V2', mediaTypes: ['text'] }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: initialModels }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: refreshedModels }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = createAppQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({ catalog: useModelCatalogQuery(), refresh: useRefreshModelCatalog() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.catalog.data).toEqual(initialModels));

    await act(async () => {
      await result.current.refresh.mutateAsync();
    });

    expect(client.getQueryData(modelCatalogQueryKey)).toEqual(refreshedModels);
    expect(client.getQueryState(modelCatalogQueryKey)?.isInvalidated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts an older catalog request before committing refreshed models', async () => {
    const staleModels = [{ id: 'text-stale', name: 'Text stale', mediaTypes: ['text'] }];
    const refreshedModels = [{ id: 'text-current', name: 'Text current', mediaTypes: ['text'] }];
    let resolveStaleRequest: ((response: Response) => void) | undefined;
    let initialSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === '/v1/models') {
        initialSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveStaleRequest = resolve;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ models: refreshedModels }), { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createAppQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({ catalog: useModelCatalogQuery(), refresh: useRefreshModelCatalog() }),
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh.mutateAsync();
    });

    expect(initialSignal).toBeInstanceOf(AbortSignal);
    expect(initialSignal?.aborted).toBe(true);
    expect(client.getQueryData(modelCatalogQueryKey)).toEqual(refreshedModels);

    await act(async () => {
      resolveStaleRequest?.(new Response(JSON.stringify({ models: staleModels }), { status: 200 }));
      await Promise.resolve();
    });

    expect(client.getQueryData(modelCatalogQueryKey)).toEqual(refreshedModels);
  });

  it('隔离不同凭据的查询缓存并按凭据刷新', async () => {
    const models = [{ id: 'image-v1', name: 'Image V1', mediaTypes: ['image'] }];
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ models }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createAppQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({
        catalog: useModelCatalogQuery('credential-image'),
        refresh: useRefreshModelCatalog(),
      }),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current.catalog.data?.[0]?.credentialId).toBe('credential-image'),
    );

    await act(async () => {
      await result.current.refresh.mutateAsync('credential-image');
    });

    expect(client.getQueryData(modelCatalogQueryKeyFor('credential-image'))).toEqual([
      { ...models[0], credentialId: 'credential-image' },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('credentialId=credential-image');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      credentialId: 'credential-image',
    });
  });
});
