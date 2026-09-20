import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import { clearAuthSession, persistAuthSession } from '../auth-client';
import { fetchNodeAssetDownload } from './node-asset-download';

/** 创建隔离测试产物，不访问真实 Provider 或本地用户文件。 */
function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-image',
    name: '节点图片',
    mediaType: 'image',
    mimeType: 'image/png',
    sizeBytes: 5,
    status: 'ready',
    contentUrl: '/v1/assets/asset-image/content',
    tags: [],
    ...overrides,
  };
}

/** 使用短期合成会话验证鉴权边界，不读取真实凭据。 */
function signIn(): void {
  persistAuthSession({
    accessToken: 'synthetic-node-download-test',
    tokenType: 'Bearer',
    expiresIn: 3600,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    user: {
      id: 'download-user',
      email: 'download@example.test',
      role: 'user',
      createdAt: '2026-01-01',
    },
  });
}

afterEach(() => {
  clearAuthSession();
  vi.unstubAllGlobals();
});

describe('节点媒体下载', () => {
  it('携带 API 会话下载指定版本并保留服务端文件名', async () => {
    signIn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('media', {
        headers: {
          'content-type': 'video/mp4',
          'content-disposition': "attachment; filename*=UTF-8''%E8%A7%86%E9%A2%91.mp4",
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const abort = new AbortController();
    const result = await fetchNodeAssetDownload(
      makeAsset({
        mediaType: 'video',
        mimeType: 'video/mp4',
        contentUrl: '/v1/assets/asset-video/versions/3/content',
      }),
      abort.signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/assets/asset-video/versions/3/content');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(init.credentials).toBe('include');
    expect(init.signal?.aborted).toBe(false);
    abort.abort();
    expect(init.signal?.aborted).toBe(true);
    expect(result.filename).toBe('视频.mp4');
    expect(result.blob.size).toBe(5);
    expect(result.blob.type).toBe('video/mp4');
  });

  it.each([
    'https://cdn.example/result.png?signature=synthetic',
    'data:image/png;base64,bWVkaWE=',
    'blob:http://localhost:5173/synthetic-blob',
  ])('外部或浏览器产物 %s 不携带 Bearer 与 Cookie', async (contentUrl) => {
    signIn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('media', { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchNodeAssetDownload(makeAsset({ contentUrl }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(contentUrl);
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(result.filename).toBe('节点图片.png');
  });

  it('授权失败显式拒绝，不降级为无鉴权请求', async () => {
    signIn();
    const fetchMock = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchNodeAssetDownload(makeAsset())).rejects.toThrow('下载失败（403）');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('空响应拒绝下载，不制造损坏文件', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    await expect(fetchNodeAssetDownload(makeAsset())).rejects.toThrow('下载内容为空');
  });

  it('网络失败保留原因但界面消息不包含地址或签名', async () => {
    const cause = new Error('https://cdn.example/result.png?signature=synthetic');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
    const error = await fetchNodeAssetDownload(makeAsset()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('下载失败，请检查网络或资源跨域权限后重试');
    expect((error as Error).cause).toBe(cause);
  });

  it('取消请求保留 AbortError 供节点忽略旧结果', async () => {
    const abort = new AbortController();
    abort.abort();
    const cause = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
    await expect(fetchNodeAssetDownload(makeAsset(), abort.signal)).rejects.toBe(cause);
  });
});
