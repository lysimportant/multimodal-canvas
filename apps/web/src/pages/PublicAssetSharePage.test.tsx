import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PublicAssetSharePage } from './PublicAssetSharePage';

/** 公开接口测试只使用合成分享身份，绝不读取真实账户。 */
const token = 'synthetic-share-token.signature';
/** 生成与匿名接口相同的最小白名单响应。 */
function makeShare(mediaType: 'image' | 'text' | 'video' | 'audio' = 'image') {
  return {
    asset: {
      name: '分享的作品',
      mediaType,
      mimeType: mediaType === 'text' ? 'text/plain' : `${mediaType}/test`,
      sizeBytes: 12,
      version: 2,
      contentUrl: `/v1/asset-shares/content?token=${token}`,
    },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('公开资源分享预览', () => {
  it('无需登录展示固定版本，只请求公开接口且不附带会话', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(makeShare()));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicAssetSharePage token={token} />);
    expect(await screen.findByRole('heading', { name: '分享的作品' })).toBeVisible();
    expect(screen.getByText(/版本 2/)).toBeVisible();
    expect(screen.getByRole('img')).toHaveAttribute(
      'src',
      `http://localhost:3000/v1/asset-shares/content?token=${token}`,
    );
    expect(screen.getByText('LoveTV · 共享资源')).toBeVisible();
    expect(document.title).toBe('分享的作品 · LoveTV 共享资源');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/v1/asset-shares?token=${token}`,
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      }),
    );
    expect(document.querySelector('meta[name=referrer]')).toHaveAttribute('content', 'no-referrer');
  });

  it('文字按原样显示，不执行 HTML，也不请求私有文本接口', async () => {
    const body = '<script>window.compromised = true</script>\n分享正文';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(makeShare('text')))
      .mockResolvedValueOnce(new Response(body));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<PublicAssetSharePage token={token} />);
    await screen.findByRole('heading', { name: '分享的作品' });
    expect(view.container.querySelector('pre')?.textContent).toBe(body);
    expect(view.container.querySelector('script')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://localhost:3000/v1/asset-shares/content?token=${token}`,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: 'omit' });
  });

  it.each(['video', 'audio'] as const)('%s 提供原生播放控件且不自动播放', async (kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(makeShare(kind))));
    render(<PublicAssetSharePage token={token} />);
    const media = await screen.findByLabelText('分享的作品');
    expect(media.tagName.toLowerCase()).toBe(kind);
    expect(media).toHaveAttribute('controls');
    expect(media).not.toHaveAttribute('autoplay');
    fireEvent.error(media);
    expect(screen.getByRole('alert')).toHaveTextContent('资源内容加载失败');
  });

  it('缺失令牌时不发出请求，失效链接不会跳登录', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 410 }));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<PublicAssetSharePage token="" />);
    expect(screen.getByRole('alert')).toHaveTextContent('分享链接不完整');
    expect(document.title).toBe('共享资源 · LoveTV');
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(<PublicAssetSharePage token={token} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('分享链接已失效');
    expect(screen.queryByRole('link', { name: /登录/ })).not.toBeInTheDocument();
  });

  it('请求失败可重试，换链接取消旧请求并忽略迟到结果', async () => {
    let resolveOld!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          ...makeShare(),
          asset: {
            ...makeShare().asset,
            name: '新的作品',
            contentUrl: '/v1/asset-shares/content?token=new-synthetic-share-token.signature',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<PublicAssetSharePage token={token} />);
    const oldSignal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    view.rerender(<PublicAssetSharePage token="new-synthetic-share-token.signature" />);
    expect(oldSignal.aborted).toBe(true);
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取');
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('heading', { name: '新的作品' })).toBeVisible();
    await act(async () => resolveOld(Response.json(makeShare())));
    expect(screen.queryByRole('heading', { name: '分享的作品' })).not.toBeInTheDocument();
  });

  it.each([
    'https://untrusted.example/content',
    '/v1/assets/private/content',
    '/v1/asset-shares/content?token=another-token',
  ])('拒绝公开接口返回的非当前分享内容地址 %s', async (contentUrl) => {
    const response = makeShare('text');
    response.asset.contentUrl = contentUrl;
    const fetchMock = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicAssetSharePage token={token} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('分享资源地址无效');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('到期后卸载已打开的媒体并提示链接失效', async () => {
    vi.useFakeTimers();
    const response = makeShare();
    response.expiresAt = new Date(Date.now() + 1_000).toISOString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)));
    render(<PublicAssetSharePage token={token} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('img')).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('分享链接已失效');
  });

  it('卸载时恢复页面原有 Referrer 策略', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(makeShare())));
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'same-origin';
    document.head.append(meta);
    const view = render(<PublicAssetSharePage token={token} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeVisible());
    view.unmount();
    expect(meta.content).toBe('same-origin');
    meta.remove();
  });

  it('退出分享页时不覆盖全局路由写入的新标题', async () => {
    document.title = '进入分享页前的标题';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(makeShare())));
    const view = render(<PublicAssetSharePage token={token} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeVisible());

    document.title = 'LoveTV · 首页';
    view.unmount();

    expect(document.title).toBe('LoveTV · 首页');
  });
});
