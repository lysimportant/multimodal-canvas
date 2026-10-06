import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PublicAssetSharePage } from './PublicAssetSharePage';

/** 公开接口测试只使用合成分享身份，绝不读取真实账户。 */
const token = 'synthetic-share-token.signature';
/** jsdom 不解码图像；仅补齐舞台尺寸，缩放行为由真实查看器计算。 */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

/** 显式提供浏览器解码后的原图尺寸，避免把加载前的隐藏图片误当成可用预览。 */
function decodeImage(name = '分享的作品') {
  const image = screen.getByAltText(name);
  Object.defineProperties(image, {
    naturalWidth: { value: 1600, configurable: true },
    naturalHeight: { value: 1200, configurable: true },
  });
  fireEvent.load(image);
  return image;
}
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('公开资源分享预览', () => {
  it('受保护分享在解锁前不显示名称、媒体或下载，不自动尝试密码', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ code: 'SHARE_PASSWORD_REQUIRED' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicAssetSharePage token={token} />);
    expect(await screen.findByRole('heading', { name: '此分享已设置查看密码' })).toBeVisible();
    const input = screen.getByLabelText('查看密码');
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: '解锁查看' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'synthetic-password' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: '分享资源内容' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '打开原文件' })).not.toBeInTheDocument();
    expect(document.title).toBe('共享资源 · LoveTV');
  });

  it('错误密码可重试，正确密码仅通过匿名 POST 发送，内容绑定解锁凭据', async () => {
    const accessToken = 'synthetic-unlock-grant.signature';
    const response = makeShare('text');
    response.asset.contentUrl += '&access_token=' + accessToken;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: 'SHARE_PASSWORD_REQUIRED' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ code: 'SHARE_PASSWORD_INVALID' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ accessToken, expiresAt: response.expiresAt }))
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(new Response('解锁后的正文'));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicAssetSharePage token={token} />);
    const input = await screen.findByLabelText('查看密码');
    fireEvent.change(input, { target: { value: 'synthetic-wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '解锁查看' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('查看密码不正确');
    expect(screen.queryByText('解锁后的正文')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: ' synthetic-right ' } });
    fireEvent.click(screen.getByRole('button', { name: '解锁查看' }));
    expect(await screen.findByText('解锁后的正文')).toBeVisible();
    expect(fetchMock.mock.calls[2]).toEqual([
      'http://localhost:3000/v1/asset-shares/unlock',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token, password: ' synthetic-right ' }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      }),
    ]);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      `http://localhost:3000/v1/asset-shares?token=${token}&access_token=${accessToken}`,
    );
    expect(fetchMock.mock.calls[4]?.[0]).toBe('http://localhost:3000' + response.asset.contentUrl);
    expect(screen.getByRole('link', { name: '打开原文件' })).toHaveAttribute(
      'href',
      'http://localhost:3000' + response.asset.contentUrl,
    );
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('synthetic-right'))).toBe(
      true,
    );
  });

  it('重复提交只解锁一次，切换链接中止解锁并忽略迟到凭据', async () => {
    let resolveUnlock!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: 'SHARE_PASSWORD_REQUIRED' }, { status: 401 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveUnlock = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ code: 'SHARE_PASSWORD_REQUIRED' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<PublicAssetSharePage token={token} />);
    const input = await screen.findByLabelText('查看密码');
    fireEvent.change(input, { target: { value: 'synthetic-password' } });
    const form = input.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const signal = fetchMock.mock.calls[1]![1].signal as AbortSignal;
    view.rerender(<PublicAssetSharePage token="different-synthetic-share.signature" />);
    expect(signal.aborted).toBe(true);
    expect(await screen.findByLabelText('查看密码')).toHaveValue('');
    await act(async () =>
      resolveUnlock(
        Response.json({
          accessToken: 'synthetic-old-grant.signature',
          expiresAt: makeShare().expiresAt,
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('region', { name: '分享资源内容' })).not.toBeInTheDocument();
  });

  it('解锁凭据到期停止视频、清除内容并重新要求密码', async () => {
    vi.useFakeTimers();
    const accessToken = 'synthetic-short-grant.signature';
    const response = makeShare('video');
    response.asset.contentUrl += '&access_token=' + accessToken;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: 'SHARE_PASSWORD_REQUIRED' }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ accessToken, expiresAt: new Date(Date.now() + 1000).toISOString() }),
      )
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(Response.json({ code: 'SHARE_PASSWORD_REQUIRED' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicAssetSharePage token={token} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByLabelText('查看密码'), {
      target: { value: 'synthetic-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '解锁查看' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByLabelText('分享的作品')).toBeInTheDocument();
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(screen.queryByLabelText('分享的作品')).not.toBeInTheDocument();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(screen.getByLabelText('查看密码')).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent('本次查看已到期');
    expect(document.title).toBe('共享资源 · LoveTV');
  });

  it('拒绝已解锁元信息中缺失或错误的内容凭据', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: 'SHARE_PASSWORD_REQUIRED' }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          accessToken: 'synthetic-grant.signature',
          expiresAt: makeShare().expiresAt,
        }),
      )
      .mockResolvedValueOnce(Response.json(makeShare('text')));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicAssetSharePage token={token} />);
    fireEvent.change(await screen.findByLabelText('查看密码'), {
      target: { value: 'synthetic-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '解锁查看' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('分享资源地址无效');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('解锁限速明确提示，重试前不自动提交', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: 'SHARE_PASSWORD_REQUIRED' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({}, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicAssetSharePage token={token} />);
    fireEvent.change(await screen.findByLabelText('查看密码'), {
      target: { value: 'synthetic-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '解锁查看' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('访问过于频繁');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('无需登录展示固定版本，只请求公开接口且不附带会话', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(makeShare()));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicAssetSharePage token={token} />);
    expect(await screen.findByRole('heading', { name: '分享的作品' })).toBeVisible();
    expect(screen.getByText(/版本 2/)).toBeVisible();
    const image = decodeImage();
    expect(image).toHaveAttribute(
      'src',
      `http://localhost:3000/v1/asset-shares/content?token=${token}`,
    );
    expect(screen.getByText('共享资源', { exact: true }).parentElement).toHaveTextContent(
      'LoveTV · 共享资源',
    );
    expect(screen.getByRole('img', { name: 'LoveTV 大肥鱼（鲸鱼娘）' })).toHaveAttribute(
      'src',
      '/brand/lovetv-icon-192.png',
    );
    expect(image).toHaveAttribute('crossorigin', 'anonymous');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
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
    decodeImage();
    fireEvent.click(screen.getByRole('button', { name: '铺满窗口' }));
    expect(screen.getByRole('main')).toHaveClass('is-image-expanded');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(screen.queryByAltText('分享的作品')).not.toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveClass('is-image-expanded');
    expect(screen.getByAltText('LoveTV 大肥鱼（鲸鱼娘）')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('分享链接已失效');
  });

  it('卸载时恢复页面原有 Referrer 策略', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(makeShare())));
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'same-origin';
    document.head.append(meta);
    const view = render(<PublicAssetSharePage token={token} />);
    await screen.findByRole('heading', { name: '分享的作品' });
    view.unmount();
    expect(meta.content).toBe('same-origin');
    meta.remove();
  });

  it('退出分享页时不覆盖全局路由写入的新标题', async () => {
    document.title = '进入分享页前的标题';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(makeShare())));
    const view = render(<PublicAssetSharePage token={token} />);
    await screen.findByRole('heading', { name: '分享的作品' });

    document.title = 'LoveTV · 首页';
    view.unmount();

    expect(document.title).toBe('LoveTV · 首页');
  });

  it('分享图片可放大、旋转、恢复原图并铺满，Esc 从工具栏退出铺满', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(makeShare())));
    render(<PublicAssetSharePage token={token} />);
    await screen.findByRole('heading', { name: '分享的作品' });
    const image = decodeImage();
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('50%');
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('62.5%');
    fireEvent.click(screen.getByRole('button', { name: '向右旋转90度' }));
    expect(image.style.transform).toContain('rotate(90deg)');
    fireEvent.click(screen.getByRole('button', { name: '原图 1:1' }));
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('100%');
    fireEvent.click(screen.getByRole('button', { name: '铺满窗口' }));
    expect(screen.getByRole('main')).toHaveClass('is-image-expanded');
    fireEvent.keyDown(screen.getByRole('button', { name: '退出铺满窗口' }), { key: 'Escape' });
    expect(screen.getByRole('main')).not.toHaveClass('is-image-expanded');
    fireEvent.click(screen.getByRole('button', { name: '重置图片视图' }));
    expect(image.style.transform).toBe('rotate(0deg)');
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('50%');
  });

  it('图片加载失败退出铺满，重新加载会重新验证分享而不直接重试私有内容', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json(makeShare()));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicAssetSharePage token={token} />);
    await screen.findByRole('heading', { name: '分享的作品' });
    const image = decodeImage();
    fireEvent.click(screen.getByRole('button', { name: '铺满窗口' }));
    fireEvent.error(image);
    expect(screen.getByRole('alert')).toHaveTextContent('资源内容加载失败');
    expect(screen.getByRole('main')).not.toHaveClass('is-image-expanded');
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    await screen.findByRole('heading', { name: '分享的作品' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('main')).not.toHaveClass('is-image-expanded');
  });

  it.each(['video', 'audio'] as const)('%s 分享到期时卸载并停止播放器', async (kind) => {
    vi.useFakeTimers();
    const response = makeShare(kind);
    response.expiresAt = new Date(Date.now() + 1_000).toISOString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)));
    render(<PublicAssetSharePage token={token} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByLabelText('分享的作品').tagName.toLowerCase()).toBe(kind);
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(screen.queryByLabelText('分享的作品')).not.toBeInTheDocument();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('分享链接已失效');
  });
});
