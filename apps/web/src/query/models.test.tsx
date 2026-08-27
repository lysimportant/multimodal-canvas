import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from './client';
import { modelCatalogQueryKey, useModelCatalogQuery, useRefreshModelCatalog } from './models';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('model catalog query', () => {
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
});
