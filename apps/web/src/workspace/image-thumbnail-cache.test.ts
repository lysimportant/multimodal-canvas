import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import * as auth from '../auth-client';
import {
  acquireImageThumbnail,
  clearImageThumbnailCache,
  getImageThumbnailSource,
} from './image-thumbnail-cache';

/** 合成版本资源；不访问真实用户文件或供应商。 */
const asset: Asset = {
  id: 'thumbnail-test',
  name: '原图.png',
  mediaType: 'image',
  mimeType: 'image/png',
  sizeBytes: 30,
  status: 'ready',
  contentUrl: '/v1/assets/thumbnail-test/content',
  latestVersion: 2,
  tags: [],
};
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
let serial = 0;
/** 返回最小图片响应，原图尺寸只从专用响应头取得。 */
function thumbnailResponse() {
  return new Response('thumbnail', {
    headers: {
      'content-type': 'image/jpeg',
      'x-original-width': '3840',
      'x-original-height': '2160',
    },
  });
}
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:thumbnail-${++serial}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(auth, 'apiFetch').mockImplementation(async () => thumbnailResponse());
});
afterEach(() => {
  clearImageThumbnailCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('image thumbnail cache', () => {
  it('资源栏最新版与节点冻结版本归一到同一个缩略图源', () => {
    const latest = getImageThumbnailSource(asset);
    expect(latest).toEqual({
      url: 'http://localhost:3000/v1/assets/thumbnail-test/versions/2/derivatives/thumbnail',
      immutable: true,
    });
    expect(
      getImageThumbnailSource({
        ...asset,
        latestVersion: 9,
        contentUrl: '/v1/assets/thumbnail-test/versions/2/content',
      }),
    ).toEqual(latest);
  });
  it('外部图片、非图片、衍生图和不匹配的资源ID不转换', () => {
    for (const contentUrl of [
      'https://example.test/image.png',
      'data:image/png;base64,a',
      '/v1/assets/another/content',
      '/v1/assets/thumbnail-test/derivatives/thumbnail',
    ])
      expect(getImageThumbnailSource({ ...asset, contentUrl })).toBeNull();
    expect(getImageThumbnailSource({ ...asset, mediaType: 'video' })).toBeNull();
    expect(getImageThumbnailSource({ ...asset, latestVersion: undefined })?.immutable).toBe(false);
  });
  it('并发消费者只请求一次，卸载一个不撤销其他节点在用的URL', async () => {
    const source = getImageThumbnailSource(asset)!;
    const a = acquireImageThumbnail(source);
    const b = acquireImageThumbnail(source);
    expect(a.promise).toBe(b.promise);
    const result = await a.promise;
    expect(result).toMatchObject({ originalWidth: 3840, originalHeight: 2160 });
    a.release();
    a.release();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    b.release();
    const c = acquireImageThumbnail(source);
    expect(await c.promise).toEqual(result);
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    c.release();
  });
  it('新版本与用户重试使用独立请求，不命中旧图', async () => {
    const source = getImageThumbnailSource(asset)!;
    const a = acquireImageThumbnail(source);
    await a.promise;
    a.release();
    const b = acquireImageThumbnail(getImageThumbnailSource({ ...asset, latestVersion: 3 })!);
    await b.promise;
    b.release();
    const c = acquireImageThumbnail(source, 1);
    await c.promise;
    c.release();
    expect(auth.apiFetch).toHaveBeenCalledTimes(3);
    expect(auth.apiFetch).toHaveBeenLastCalledWith(
      source.url,
      expect.objectContaining({ cache: 'reload' }),
    );
  });
  it('错误不缓存且不请求原文件；下一次能恢复', async () => {
    vi.mocked(auth.apiFetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const source = getImageThumbnailSource(asset)!;
    const a = acquireImageThumbnail(source);
    await expect(a.promise).rejects.toThrow('503');
    a.release();
    const b = acquireImageThumbnail(source);
    await expect(b.promise).resolves.toMatchObject({ originalWidth: 3840 });
    b.release();
    expect(auth.apiFetch).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(auth.apiFetch)
        .mock.calls.every(([url]) => String(url).includes('/derivatives/thumbnail')),
    ).toBe(true);
  });
  it('账户切换撤销缓存并拒绝旧请求迟到的内容', async () => {
    const source = getImageThumbnailSource(asset)!;
    const first = acquireImageThumbnail(source);
    const original = await first.promise;
    clearImageThumbnailCache();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(original.url);
    let resolve!: (response: Response) => void;
    vi.mocked(auth.apiFetch).mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const pending = acquireImageThumbnail(source);
    const rejected = expect(pending.promise).rejects.toThrow();
    await Promise.resolve();
    auth.clearAuthSession();
    resolve(thumbnailResponse());
    await rejected;
    first.release();
    pending.release();
    const next = acquireImageThumbnail(source);
    await next.promise;
    next.release();
    expect(auth.apiFetch).toHaveBeenCalledTimes(3);
  });
  it('最后一个消费者离开后取消未完成请求', async () => {
    let signal: AbortSignal | null | undefined;
    vi.mocked(auth.apiFetch).mockImplementationOnce((_url, options) => {
      signal = options?.signal;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError'))),
      );
    });
    const lease = acquireImageThumbnail(getImageThumbnailSource(asset)!);
    const rejected = expect(lease.promise).rejects.toThrow('取消');
    lease.release();
    await rejected;
    expect(signal?.aborted).toBe(true);
  });
  it('超过128个闲置条目按最近使用顺序回收，已释放对象URL可重新请求', async () => {
    for (let index = 0; index < 130; index++) {
      const lease = acquireImageThumbnail({ url: `/thumb/${index}`, immutable: true });
      await lease.promise;
      lease.release();
    }
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    const lease = acquireImageThumbnail({ url: '/thumb/0', immutable: true });
    await lease.promise;
    lease.release();
    expect(auth.apiFetch).toHaveBeenCalledTimes(131);
  });
  it('无版本地址只缓存30秒，后续挂载会重新验证', async () => {
    vi.useFakeTimers();
    const source = getImageThumbnailSource({ ...asset, latestVersion: undefined })!;
    const a = acquireImageThumbnail(source);
    await a.promise;
    a.release();
    vi.setSystemTime(Date.now() + 31_000);
    const b = acquireImageThumbnail(source);
    await b.promise;
    b.release();
    expect(auth.apiFetch).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it('请求最多四路并发，排队任务取消不占用网络请求', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    vi.mocked(auth.apiFetch).mockImplementation(
      () => new Promise<Response>((resolve) => resolvers.push(resolve)),
    );
    const leases = Array.from({ length: 6 }, (_, index) =>
      acquireImageThumbnail({ url: '/queued/' + index, immutable: true }),
    );
    await Promise.resolve();
    expect(auth.apiFetch).toHaveBeenCalledTimes(4);
    const cancelled = expect(leases[5].promise).rejects.toThrow();
    leases[5].release();
    await cancelled;
    resolvers[0](thumbnailResponse());
    await leases[0].promise;
    await Promise.resolve();
    expect(auth.apiFetch).toHaveBeenCalledTimes(5);
    resolvers.slice(1).forEach((resolve) => resolve(thumbnailResponse()));
    await Promise.all(leases.slice(0, 5).map((lease) => lease.promise));
    leases.forEach((lease) => lease.release());
  });

  it('繁忙转码按 Retry-After 退避，不立刻冲刷队列且不重试其他503', async () => {
    vi.useFakeTimers();
    vi.mocked(auth.apiFetch).mockResolvedValueOnce(
      Response.json({ code: 'thumbnail_busy' }, { status: 503, headers: { 'retry-after': '1' } }),
    );
    const lease = acquireImageThumbnail(getImageThumbnailSource(asset)!);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(lease.promise).resolves.toMatchObject({ originalWidth: 3840 });
    lease.release();
    expect(auth.apiFetch).toHaveBeenCalledTimes(2);
  });

  it('TTL替换后仍显示的旧URL也会在账户切换时撤销', async () => {
    vi.useFakeTimers();
    const source = getImageThumbnailSource(asset)!;
    const first = acquireImageThumbnail(source);
    const before = await first.promise;
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const second = acquireImageThumbnail(source);
    const after = await second.promise;
    expect(after.url).not.toBe(before.url);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    clearImageThumbnailCache();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(before.url);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(after.url);
    first.release();
    second.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('无效或空的图片响应不会创建Blob URL', async () => {
    for (const response of [
      new Response('not-image'),
      new Response('', { headers: { 'content-type': 'image/jpeg' } }),
    ]) {
      vi.mocked(auth.apiFetch).mockResolvedValueOnce(response);
      const lease = acquireImageThumbnail(getImageThumbnailSource(asset)!);
      await expect(lease.promise).rejects.toThrow('内容无效');
      lease.release();
    }
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
