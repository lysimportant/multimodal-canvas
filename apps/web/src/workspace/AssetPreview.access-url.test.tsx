import '@testing-library/jest-dom/vitest';

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Asset } from '@multimodal-canvas/domain';
import { clearAuthSession, getAuthSessionGeneration, persistAuthSession } from '../auth-client';
import { AssetPreview } from './AssetPreview';

/** 合成版本资源；所有请求都由本文件截获，不读取用户素材或账号。 */
const asset: Asset = {
  id: 'access-url-preview',
  name: '签名预览测试',
  mediaType: 'image',
  mimeType: 'image/png',
  sizeBytes: 10,
  status: 'ready',
  contentUrl: '/v1/assets/access-url-preview/versions/2/content',
  latestVersion: 2,
  tags: [],
};

/** 切换真实前端会话代次，不创建后端账号，也不使用令牌。 */
function signIn(id = 'preview-session-a', role: 'user' | 'admin' = 'user', renewal = false) {
  persistAuthSession({ user: { id, role, createdAt: '2026-01-01' } }, { renewal });
}

/** 返回合成签名和服务端到期时间；仅检查地址是否复用，不下载图片字节。 */
function signedUrl(marker = 'first', expiresAt = new Date(Date.now() + 300_000).toISOString()) {
  return Response.json({ url: `https://assets.example/${marker}.png`, expiresAt });
}

/** 控制请求完成时间，验证共享消费者释放和迟到结果。 */
function pendingResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  signIn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  clearAuthSession();
  vi.unstubAllGlobals();
});

describe('AssetPreview 签名请求共享', () => {
  it('卡片、内联和悬浮预览同时挂载只授权一次，保持精确版本和 Cookie 请求', async () => {
    const pending = pendingResponse();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetch);
    render(
      <>
        <AssetPreview asset={asset} mode="compact" />
        <AssetPreview asset={asset} mode="content" />
        <AssetPreview
          asset={{ ...asset, contentUrl: `http://localhost:3000${asset.contentUrl}?display=hover` }}
          mode="compact"
        />
      </>,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ version: 2 }),
      }),
    );
    expect(new Headers(fetch.mock.calls[0][1].headers).has('authorization')).toBe(false);
    await act(async () => pending.resolve(signedUrl()));
    expect(screen.getAllByRole('img')).toHaveLength(3);
    expect(
      screen
        .getAllByRole('img')
        .every((image) => image.getAttribute('src') === 'https://assets.example/first.png'),
    ).toBe(true);
  });

  it('关闭后很快重开同版本悬浮预览复用未过期签名，不缓存资源内容', async () => {
    const fetch = vi.fn().mockImplementation(async () => signedUrl());
    vi.stubGlobal('fetch', fetch);
    const view = render(<AssetPreview asset={asset} />);
    await screen.findByRole('img');
    view.unmount();
    render(<AssetPreview asset={asset} mode="content" />);
    expect(await screen.findByRole('img')).toHaveAttribute(
      'src',
      'https://assets.example/first.png',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/access-url');
  });

  it('卸载一个消费者保留共享请求，最后消费者卸载后才中止', async () => {
    const pending = pendingResponse();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetch);
    const view = render(
      <>
        <AssetPreview key="card" asset={asset} />
        <AssetPreview key="hover" asset={asset} mode="content" />
      </>,
    );
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    view.rerender(<AssetPreview key="card" asset={asset} />);
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    view.unmount();
    await act(async () => {});
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(signedUrl('aborted')));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('严格模式的立即释放与重挂载共享尚未完成的请求', async () => {
    const pending = pendingResponse();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetch);
    render(
      <StrictMode>
        <AssetPreview asset={asset} />
      </StrictMode>,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    await act(async () => pending.resolve(signedUrl()));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://assets.example/first.png');
  });

  it('同组件换账号立即隐藏旧签名，新账号单独授权；普通续期继续复用', async () => {
    const current = pendingResponse();
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => signedUrl('account-a'))
      .mockReturnValueOnce(current.promise);
    vi.stubGlobal('fetch', fetch);
    render(<AssetPreview asset={asset} />);
    await screen.findByRole('img');
    const generation = getAuthSessionGeneration();
    act(() => signIn('preview-session-a', 'user', true));
    expect(getAuthSessionGeneration()).toBe(generation);
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => signIn('preview-session-b'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(signedUrl('account-b')));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://assets.example/account-b.png');
  });

  it('旧账户正文迟到不进入新缓存，角色变化后拒绝时也不回退旧图', async () => {
    let resolveBody!: (value: unknown) => void;
    const previous = signedUrl();
    const json = vi.spyOn(previous, 'json').mockReturnValue(
      new Promise((done) => {
        resolveBody = done;
      }),
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(previous)
      .mockImplementationOnce(async () => signedUrl('account-b'))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    render(<AssetPreview asset={asset} mode="content" />);
    await waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    act(() => signIn('preview-session-b'));
    expect(await screen.findByRole('img')).toHaveAttribute(
      'src',
      'https://assets.example/account-b.png',
    );
    await act(async () =>
      resolveBody({
        url: 'https://assets.example/account-a.png',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    );
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://assets.example/account-b.png');
    act(() => signIn('preview-session-b', 'admin', true));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('403');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { label: '服务端到期', expiresIn: 5_000, advance: 5_000 },
    { label: '短期缓存到期', expiresIn: 300_000, advance: 31_000 },
  ])('$label 后重开重新授权', async ({ expiresIn, advance }) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        signedUrl('current', new Date(now + expiresIn).toISOString()),
      );
    vi.stubGlobal('fetch', fetch);
    const view = render(<AssetPreview asset={asset} />);
    await screen.findByRole('img');
    view.unmount();
    now += advance;
    render(<AssetPreview asset={asset} />);
    await screen.findByRole('img');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('明确重新加载绕过成功缓存，随后重开复用新签名', async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => signedUrl('first'))
      .mockImplementationOnce(async () => signedUrl('reloaded'));
    vi.stubGlobal('fetch', fetch);
    const view = render(<AssetPreview asset={asset} mode="content" />);
    fireEvent.error(await screen.findByRole('img'));
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('img')).toHaveAttribute(
      'src',
      'https://assets.example/reloaded.png',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    view.unmount();
    render(<AssetPreview asset={asset} />);
    expect(await screen.findByRole('img')).toHaveAttribute(
      'src',
      'https://assets.example/reloaded.png',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('重新加载旧资产后切换资产会复用新资产已有签名', async () => {
    const nextAsset: Asset = {
      ...asset,
      id: 'access-url-next-cached',
      name: '已缓存的新资产',
      contentUrl: '/v1/assets/access-url-next-cached/versions/3/content',
      latestVersion: 3,
    };
    let currentCalls = 0;
    const fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes(nextAsset.id)) return signedUrl('next-cached');
      currentCalls++;
      return signedUrl(currentCalls === 1 ? 'current' : 'current-reloaded');
    });
    vi.stubGlobal('fetch', fetch);
    render(<AssetPreview asset={nextAsset} />);
    expect(await screen.findByAltText(nextAsset.name)).toHaveAttribute(
      'src',
      'https://assets.example/next-cached.png',
    );

    const current = render(<AssetPreview asset={asset} mode="content" />);
    fireEvent.error(await screen.findByAltText(asset.name));
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByAltText(asset.name)).toHaveAttribute(
      'src',
      'https://assets.example/current-reloaded.png',
    );
    current.rerender(<AssetPreview asset={nextAsset} mode="content" />);

    await waitFor(() => expect(screen.getAllByAltText(nextAsset.name)).toHaveLength(2));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('重新加载旧资产后切换资产会继续共享新资产在途签名', async () => {
    const nextAsset: Asset = {
      ...asset,
      id: 'access-url-next-pending',
      name: '在途的新资产',
      contentUrl: '/v1/assets/access-url-next-pending/versions/4/content',
      latestVersion: 4,
    };
    const pending = pendingResponse();
    let nextCalls = 0;
    let currentCalls = 0;
    const fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes(nextAsset.id)) {
        nextCalls++;
        return nextCalls === 1
          ? pending.promise
          : Promise.resolve(signedUrl('unexpected-duplicate'));
      }
      currentCalls++;
      return Promise.resolve(signedUrl(currentCalls === 1 ? 'current' : 'current-reloaded'));
    });
    vi.stubGlobal('fetch', fetch);
    render(<AssetPreview asset={nextAsset} />);
    const current = render(<AssetPreview asset={asset} mode="content" />);
    fireEvent.error(await screen.findByAltText(asset.name));
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    await screen.findByAltText(asset.name);

    current.rerender(<AssetPreview asset={nextAsset} mode="content" />);
    expect(nextCalls).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    await act(async () => pending.resolve(signedUrl('next-pending')));
    await waitFor(() => expect(screen.getAllByAltText(nextAsset.name)).toHaveLength(2));
    expect(
      screen
        .getAllByAltText(nextAsset.name)
        .every((image) => image.getAttribute('src') === 'https://assets.example/next-pending.png'),
    ).toBe(true);
  });

  it('版本切换单独授权，无版本资源仅合并在途请求；失败不作负缓存', async () => {
    const fetch = vi.fn().mockImplementation(async () => signedUrl());
    vi.stubGlobal('fetch', fetch);
    const view = render(<AssetPreview asset={asset} />);
    await screen.findByRole('img');
    view.rerender(
      <AssetPreview
        asset={{ ...asset, contentUrl: asset.contentUrl.replace('/2/', '/3/'), latestVersion: 3 }}
      />,
    );
    await screen.findByRole('img');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ version: 3 });
    view.unmount();
    const mutable = {
      ...asset,
      contentUrl: '/v1/assets/access-url-preview/content',
      latestVersion: undefined,
    };
    const first = render(<AssetPreview asset={mutable} />);
    await screen.findByRole('img');
    first.unmount();
    const second = render(<AssetPreview asset={mutable} />);
    await screen.findByRole('img');
    expect(fetch).toHaveBeenCalledTimes(4);
    second.unmount();
    fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const denied = render(<AssetPreview asset={mutable} mode="content" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('503');
    denied.unmount();
    render(<AssetPreview asset={mutable} />);
    await screen.findByRole('img');
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
