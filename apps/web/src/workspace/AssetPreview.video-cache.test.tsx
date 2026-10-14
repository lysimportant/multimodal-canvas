import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Asset } from '@multimodal-canvas/domain';
import { clearAuthSession, persistAuthSession } from '../auth-client';
import { AssetViewerDialog } from './AssetPreview';

const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const cacheName = 'multimodal-canvas:video:v1:video-preview-user';

function videoAsset(id: string): Asset {
  return {
    id,
    name: '测试视频',
    mediaType: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 20,
    status: 'ready',
    contentUrl: `/v1/assets/${id}/versions/4/content`,
    latestVersion: 4,
    tags: [],
  };
}

function fakeCacheStorage() {
  const entries = new Map<string, Map<string, Response>>();
  vi.stubGlobal('caches', {
    open: async (name: string) => {
      let cache = entries.get(name);
      if (!cache) {
        cache = new Map();
        entries.set(name, cache);
      }
      return {
        match: async (key: string) => cache.get(key)?.clone(),
        put: async (key: string, value: Response) => {
          cache.set(key, value.clone());
        },
        keys: async () => [...cache.keys()].map((key) => new Request(key)),
        delete: async (key: string) => cache.delete(key),
      };
    },
    keys: async () => [...entries.keys()],
    delete: async (name: string) => entries.delete(name),
  });
  return entries;
}

beforeEach(() => {
  persistAuthSession({
    user: { id: 'video-preview-user', role: 'user', createdAt: '2026-01-01T00:00:00Z' },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:cached-preview-video'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  clearAuthSession();
  vi.unstubAllGlobals();
  if (originalCreateObjectUrl)
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectUrl)
    Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('视频 Dialog 本地缓存', () => {
  it.each([20, 0])('资源大小为 %i 时先播放签名地址，关闭后缓存并复用', async (sizeBytes) => {
    const asset = { ...videoAsset(`preview-stream-first-${sizeBytes}`), sizeBytes };
    const cache = fakeCacheStorage();
    let completeDownload!: (value: Response) => void;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/access-url'))
        return Promise.resolve(
          Response.json({
            url: 'https://assets.example/signed-video.mp4',
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
        );
      if (init?.method === 'HEAD')
        return Promise.resolve(new Response(null, { headers: { 'content-length': '17' } }));
      return new Promise((resolve) => (completeDownload = resolve));
    });
    vi.stubGlobal('fetch', fetcher);
    const onOpenChange = vi.fn();
    const view = render(<AssetViewerDialog asset={asset} open onOpenChange={onOpenChange} />);
    const video = await waitFor(() => {
      const element = screen.getByRole('dialog').querySelector('video');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(video).toHaveAttribute('src', 'https://assets.example/signed-video.mp4');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(0);

    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(sizeBytes ? 2 : 3));
    expect(video).toHaveAttribute('src', 'https://assets.example/signed-video.mp4');

    view.rerender(<AssetViewerDialog asset={asset} open={false} onOpenChange={onOpenChange} />);
    await act(async () =>
      completeDownload(
        new Response('cached-video-body', { headers: { 'content-type': 'video/mp4' } }),
      ),
    );
    await waitFor(() => expect(cache.get(cacheName)?.size).toBe(1));

    view.rerender(<AssetViewerDialog asset={asset} open onOpenChange={onOpenChange} />);
    await waitFor(() =>
      expect(screen.getByRole('dialog').querySelector('video')).toHaveAttribute(
        'src',
        'blob:cached-preview-video',
      ),
    );
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'HEAD')).toHaveLength(
      sizeBytes ? 1 : 2,
    );
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'HEAD')).toHaveLength(2);
  });

  it.each([20, 0])('本地缓存命中且资源大小为 %i 时只校验读取权限', async (sizeBytes) => {
    const asset = { ...videoAsset(`preview-cache-hit-${sizeBytes}`), sizeBytes };
    const entries = fakeCacheStorage();
    entries.set(
      cacheName,
      new Map([
        [
          `http://localhost:3000${asset.contentUrl}`,
          new Response('cached-video-body', { headers: { 'content-type': 'video/mp4' } }),
        ],
      ]),
    );
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      return new Response(null);
    });
    vi.stubGlobal('fetch', fetcher);
    render(<AssetViewerDialog asset={asset} open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole('dialog').querySelector('video')).toHaveAttribute(
        'src',
        'blob:cached-preview-video',
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('HEAD');
  });
});
