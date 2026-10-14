import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../auth-client';
import {
  createVideoRecreationFrameBatch,
  initialVideoRecreationPreviews,
  loadFrozenVideo,
  MAX_CACHED_VIDEO_BYTES,
  warmFrozenVideoCache,
  type VideoRecreationFrameBatch,
  type VideoRecreationPreviewItem,
} from './video-recreation-frames';

/** 冻结视频夹具；这些测试只验证浏览器事件、权限和生命周期，不访问实际用户素材。 */
const source = { assetId: 'source-video', assetVersion: 4 };
const actor: VideoRecreationPreviewItem = {
  id: 'actor_a',
  label: '左侧人物',
  preview: { timestampSeconds: 2, boundingBox: { x: 0.25, y: 0.1, width: 0.5, height: 0.5 } },
};
const product: VideoRecreationPreviewItem = {
  id: 'product_a',
  label: '手持商品',
  preview: { timestampSeconds: 6 },
};
const leases: VideoRecreationFrameBatch[] = [];
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
let videos: HTMLVideoElement[];
let seekTimes: number[];
let automaticLoad: boolean;
let automaticSeek: boolean;
let brokenDecoder: boolean;
let serial: number;
let currentTimes: WeakMap<HTMLMediaElement, number>;
let videoCaches: Map<string, Map<string, Response>>;
const drawImage = vi.fn();

/** 模拟完成解码的浏览器事件；真实编码和像素由 PC 浏览器烟测另外核验。 */
function loaded(video: HTMLVideoElement) {
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 1920 },
    videoHeight: { configurable: true, value: 1080 },
    duration: { configurable: true, value: 10 },
    readyState: { configurable: true, value: 2 },
    seeking: { configurable: true, value: false },
  });
  video.dispatchEvent(new Event('loadeddata'));
}

/** 模拟 seeked 前后状态，让测试发现未等待解码就绘制的错误。 */
function seeked(video: HTMLVideoElement) {
  Object.defineProperty(video, 'seeking', { configurable: true, value: false });
  video.dispatchEvent(new Event('seeked'));
}

/** 保存释放句柄，保证失败测试也不残留认证订阅或对象 URL。 */
function start(
  items: readonly VideoRecreationPreviewItem[] = [actor, product],
  options: Parameters<typeof createVideoRecreationFrameBatch>[2] = {},
) {
  const lease = createVideoRecreationFrameBatch(source, items, options);
  leases.push(lease);
  return lease;
}

beforeEach(() => {
  videos = [];
  seekTimes = [];
  automaticLoad = true;
  automaticSeek = true;
  brokenDecoder = false;
  serial = 0;
  currentTimes = new WeakMap();
  videoCaches = new Map();
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: async (name: string) => {
        let videoCache = videoCaches.get(name);
        if (!videoCache) {
          videoCache = new Map();
          videoCaches.set(name, videoCache);
        }
        return {
          match: async (key: string) => videoCache.get(key)?.clone(),
          put: async (key: string, response: Response) => {
            videoCache.set(key, response.clone());
          },
          keys: async () => [...videoCache.keys()].map((url) => new Request(url)),
          delete: async (key: string) => videoCache.delete(key),
        };
      },
      keys: async () => [...videoCaches.keys()],
      delete: async (name: string) => videoCaches.delete(name),
    },
  });
  drawImage.mockReset();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(
      (blob: Blob) => `blob:${blob.type.startsWith('video/') ? 'video' : 'frame'}-${++serial}`,
    ),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(auth, 'apiFetch').mockImplementation(
    async () =>
      new Response('isolated video fixture', { headers: { 'content-type': 'video/mp4' } }),
  );
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (
    this: HTMLVideoElement,
  ) {
    if (!this.getAttribute('src')) return;
    videos.push(this);
    if (brokenDecoder) {
      Object.defineProperty(this, 'error', { configurable: true, value: { code: 4 } });
      queueMicrotask(() => this.dispatchEvent(new Event('error')));
    } else if (automaticLoad) queueMicrotask(() => loaded(this));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'get').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    return currentTimes.get(this) ?? 0;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set').mockImplementation(function (
    this: HTMLVideoElement,
    value: number,
  ) {
    currentTimes.set(this, value);
    seekTimes.push(value);
    Object.defineProperty(this, 'seeking', { configurable: true, value: true });
    if (automaticSeek) queueMicrotask(() => seeked(this));
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    queueMicrotask(() => callback(new Blob(['isolated JPEG fixture'], { type: 'image/jpeg' })));
  });
});

afterEach(() => {
  leases.splice(0).forEach((lease) => lease.release());
  auth.clearAuthSession();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
  Reflect.deleteProperty(globalThis, 'caches');
});

describe('原视频截帧 batch', () => {
  it('创建后立即释放不会发送GET，严格模式的废弃挂载不重复下载视频', async () => {
    const lease = start([actor]);
    const rejected = expect(lease.promise).rejects.toMatchObject({ name: 'AbortError' });
    lease.release();
    await rejected;
    expect(auth.apiFetch).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('人物和商品只读一次冻结视频，等待解码并串行 seek，裁剪小图不超过480像素', async () => {
    const generation = auth.getAuthSessionGeneration();
    const lease = start();
    const results = await lease.promise;
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    expect(auth.apiFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/assets/source-video/versions/4/content',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
      { expectedAuthGeneration: generation },
    );
    expect(videos).toHaveLength(1);
    expect(seekTimes).toEqual([2, 6]);
    expect(drawImage).toHaveBeenNthCalledWith(1, videos[0], 480, 108, 960, 540, 0, 0, 480, 270);
    expect(drawImage).toHaveBeenNthCalledWith(2, videos[0], 0, 0, 1920, 1080, 0, 0, 480, 270);
    expect(results.get(actor.id)).toMatchObject({
      status: 'ready',
      timestampSeconds: 2,
      cropped: true,
      location: 'preview',
    });
    expect(results.get(product.id)).toMatchObject({
      status: 'ready',
      timestampSeconds: 6,
      cropped: false,
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:frame-2');
    expect(videos[0].getAttribute('src')).toBeNull();
    lease.release();
    lease.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('同账户重复打开相同冻结视频时从本地缓存复用，不重复网络下载', async () => {
    auth.persistAuthSession({
      user: { id: 'owner-a', role: 'user', createdAt: '2025-01-01T00:00:00.000Z' },
    });
    const first = await loadFrozenVideo(source, new AbortController().signal);
    await vi.waitFor(() =>
      expect(videoCaches.get('multimodal-canvas:video:v1:owner-a')?.size).toBe(1),
    );
    const second = await loadFrozenVideo(source, new AbortController().signal);

    expect(first.size).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(auth.apiFetch).toHaveBeenCalledTimes(2);
    expect(auth.apiFetch).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ method: 'HEAD', cache: 'no-store' }),
      expect.anything(),
    );
    expect([...videoCaches.get('multimodal-canvas:video:v1:owner-a')!.keys()]).toEqual([
      'http://localhost:3000/v1/assets/source-video/versions/4/content',
    ]);
  });

  it('后台缓存不等待预览组件存活，切换账户后不能读到旧账户视频', async () => {
    auth.persistAuthSession({
      user: { id: 'owner-a', role: 'user', createdAt: '2025-01-01T00:00:00.000Z' },
    });
    let releaseDownload!: (response: Response) => void;
    vi.mocked(auth.apiFetch).mockImplementationOnce(
      () => new Promise((resolve) => (releaseDownload = resolve)),
    );
    warmFrozenVideoCache(source, 20);
    await vi.waitFor(() => expect(auth.apiFetch).toHaveBeenCalledTimes(1));
    releaseDownload(new Response('cached video', { headers: { 'content-type': 'video/mp4' } }));
    await vi.waitFor(() =>
      expect(videoCaches.get('multimodal-canvas:video:v1:owner-a')?.size).toBe(1),
    );

    auth.persistAuthSession({
      user: { id: 'owner-b', role: 'user', createdAt: '2025-01-01T00:00:00.000Z' },
    });
    await loadFrozenVideo(source, new AbortController().signal);
    expect(auth.apiFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(auth.apiFetch).mock.calls[1]?.[1]).not.toMatchObject({ method: 'HEAD' });
    await vi.waitFor(() =>
      expect(videoCaches.has('multimodal-canvas:video:v1:owner-a')).toBe(false),
    );
    await vi.waitFor(() =>
      expect(videoCaches.get('multimodal-canvas:video:v1:owner-b')?.size).toBe(1),
    );
  });

  it('未知大小的视频先读取长度再缓存，超出上限时不下载正文', async () => {
    auth.persistAuthSession({
      user: { id: 'owner-size-check', role: 'user', createdAt: '2025-01-01T00:00:00.000Z' },
    });
    vi.mocked(auth.apiFetch).mockImplementation(async (_url, init) =>
      init?.method === 'HEAD'
        ? new Response(null, { headers: { 'content-length': '22' } })
        : new Response('isolated video fixture', { headers: { 'content-type': 'video/mp4' } }),
    );
    warmFrozenVideoCache(source);
    await vi.waitFor(() =>
      expect(videoCaches.get('multimodal-canvas:video:v1:owner-size-check')?.size).toBe(1),
    );
    expect(vi.mocked(auth.apiFetch).mock.calls.map(([, init]) => init?.method)).toEqual([
      'HEAD',
      undefined,
    ]);

    const oversized = { assetId: 'oversized-video', assetVersion: 1 };
    vi.mocked(auth.apiFetch)
      .mockClear()
      .mockResolvedValue(
        new Response(null, {
          headers: { 'content-length': String(MAX_CACHED_VIDEO_BYTES + 1) },
        }),
      );
    warmFrozenVideoCache(oversized);
    await vi.waitFor(() => expect(auth.apiFetch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(auth.apiFetch).mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD' });
    expect(videoCaches.get('multimodal-canvas:video:v1:owner-size-check')?.size).toBe(1);
  });

  it('没有画面定位不读取视频；旧出现时间可回退且不冒充模型preview', async () => {
    const missing = { id: 'old_actor', label: '旧角色' };
    const none = start([missing]);
    expect((await none.promise).get(missing.id)).toEqual({
      status: 'missing',
      error: '分析未提供画面定位',
    });
    expect(auth.apiFetch).not.toHaveBeenCalled();
    const old = start([{ ...missing, appearances: [{ startSeconds: 1.5, endSeconds: 4 }] }]);
    expect((await old.promise).get(missing.id)).toMatchObject({
      status: 'ready',
      timestampSeconds: 1.5,
      location: 'appearance',
      cropped: false,
    });
    expect(seekTimes).toEqual([1.5]);
  });

  it('loadeddata与seeked到达前不画图，也不提前开始第二个对象定位', async () => {
    automaticLoad = false;
    automaticSeek = false;
    const lease = start();
    await vi.waitFor(() => expect(videos).toHaveLength(1));
    expect(drawImage).not.toHaveBeenCalled();
    expect(seekTimes).toEqual([]);
    loaded(videos[0]);
    await vi.waitFor(() => expect(seekTimes).toEqual([2]));
    expect(drawImage).not.toHaveBeenCalled();
    seeked(videos[0]);
    await vi.waitFor(() => expect(seekTimes).toEqual([2, 6]));
    expect(drawImage).toHaveBeenCalledTimes(1);
    seeked(videos[0]);
    await lease.promise;
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it('取消未完成的解码立即清视频URL，迟到的事件不会创建截图', async () => {
    automaticLoad = false;
    const abort = new AbortController();
    const published = vi.fn();
    const lease = start([actor], { signal: abort.signal, onResult: published });
    const rejected = expect(lease.promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(videos).toHaveLength(1));
    abort.abort();
    await rejected;
    expect(videos[0].getAttribute('src')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video-1');
    loaded(videos[0]);
    await Promise.resolve();
    expect(drawImage).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('截图编码期间取消不会接纳迟到的Blob，已经发布的图片也被回收', async () => {
    let finishEncoding!: BlobCallback;
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementationOnce((callback) =>
        callback(new Blob(['first JPEG'], { type: 'image/jpeg' })),
      )
      .mockImplementationOnce((callback) => {
        finishEncoding = callback;
      });
    const abort = new AbortController();
    const published = vi.fn();
    const lease = start([actor, product], { signal: abort.signal, onResult: published });
    const rejected = expect(lease.promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(drawImage).toHaveBeenCalledTimes(2));
    expect(published).toHaveBeenCalledTimes(1);
    abort.abort();
    await rejected;
    finishEncoding(new Blob(['late JPEG'], { type: 'image/jpeg' }));
    await Promise.resolve();
    expect(published).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-2');
  });

  it('账户变化拒绝已收到响应但迟到的正文，不将旧账户视频写入新预览', async () => {
    let resolveBlob!: (value: Blob) => void;
    const response = new Response();
    vi.spyOn(response, 'blob').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBlob = resolve;
        }),
    );
    vi.mocked(auth.apiFetch).mockResolvedValueOnce(response);
    const published = vi.fn();
    const lease = start([actor], { onResult: published });
    const rejected = expect(lease.promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(response.blob).toHaveBeenCalled());
    auth.clearAuthSession();
    await rejected;
    resolveBlob(new Blob(['old account video'], { type: 'video/mp4' }));
    await Promise.resolve();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
  });

  it('浏览器不支持的格式提供可读错误，下一次显式batch可以重新读取', async () => {
    brokenDecoder = true;
    const failed = start([actor]);
    expect((await failed.promise).get(actor.id)).toEqual({
      status: 'error',
      error: '浏览器无法解码原视频，格式或编码可能不支持，请确认后重试',
    });
    expect(drawImage).not.toHaveBeenCalled();
    brokenDecoder = false;
    const retry = start([actor]);
    expect((await retry.promise).get(actor.id)).toMatchObject({ status: 'ready' });
    expect(auth.apiFetch).toHaveBeenCalledTimes(2);
  });

  it('下载正文超时会中断原GET并显示错误，不自动重复下载', async () => {
    vi.useFakeTimers();
    vi.mocked(auth.apiFetch).mockImplementation(() => new Promise(() => {}));
    const lease = start([actor]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await lease.promise).get(actor.id)).toEqual({
      status: 'error',
      error: '原视频读取超时，请重试',
    });
    expect(vi.mocked(auth.apiFetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('解码超时释放原视频且不造图片，仍能展示明确重试原因', async () => {
    vi.useFakeTimers();
    automaticLoad = false;
    const lease = start([actor]);
    await vi.waitFor(() => expect(videos).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await lease.promise).get(actor.id)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('解码超时'),
    });
    expect(drawImage).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video-1');
  });

  it('负时间、越界裁剪和视频结束点明确失败，不静默换成首帧或邻近时间', async () => {
    const invalidTime = { ...actor, id: 'bad_time', preview: { timestampSeconds: -1 } };
    const invalidBox = {
      ...actor,
      id: 'bad_box',
      preview: { timestampSeconds: 2, boundingBox: { x: 0.8, y: 0, width: 0.5, height: 1 } },
    };
    const atEnd = { ...product, preview: { timestampSeconds: 10 } };
    const initial = initialVideoRecreationPreviews([invalidTime, invalidBox]);
    expect(initial.get(invalidTime.id)).toMatchObject({ status: 'error' });
    expect(initial.get(invalidBox.id)).toMatchObject({ status: 'error' });
    const lease = start([invalidTime, invalidBox, atEnd]);
    expect((await lease.promise).get(atEnd.id)).toEqual({
      status: 'error',
      error: '画面时间点超出原视频时长，请检查分析结果',
    });
    expect(seekTimes).toEqual([]);
    expect(drawImage).not.toHaveBeenCalled();
  });
});
