import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import { clearAuthSession, persistAuthSession } from '../auth-client';
import { AssetPreview, AssetViewerDialog } from './AssetPreview';

/** 合成冻结资源，最新版本与展示版本不同，以检测恢复是否偷换版本。 */
function makeAsset(mediaType: 'image' | 'video' | 'audio'): Asset {
  return {
    id: 'preview-recovery',
    name: '回显资源',
    mediaType,
    mimeType:
      mediaType === 'image' ? 'image/png' : mediaType === 'video' ? 'video/mp4' : 'audio/wav',
    sizeBytes: 100,
    status: 'ready',
    latestVersion: 7,
    contentUrl: '/v1/assets/preview-recovery/versions/2/content',
    tags: [],
  };
}

/** 每次授权返回不同地址，禁止用旧地址重载伪装成重新授权。 */
function mockAuthorization() {
  let attempt = 0;
  const fetch = vi.fn().mockImplementation(async () =>
    Response.json({
      url: `https://assets.example/attempt-${++attempt}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** 等待异步授权结束，并读取当前媒体元素而非已经卸载的上一份元素。 */
async function currentMedia(container: HTMLElement, kind: 'image' | 'video' | 'audio') {
  const selector = kind === 'image' ? 'img' : kind;
  await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
  return container.querySelector(selector)!;
}

beforeEach(() => {
  persistAuthSession({
    user: { id: 'preview-recovery-user', role: 'user', createdAt: '2026-01-01' },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  clearAuthSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('受保护资源回显恢复', () => {
  it.each(['image', 'video', 'audio'] as const)(
    '%s 网络失败只自动授权一次代理，持续失败后显式重试保持冻结版本',
    async (kind) => {
      const fetch = mockAuthorization();
      const { container } = render(<AssetPreview asset={makeAsset(kind)} mode="content" />);
      fireEvent.error(await currentMedia(container, kind));
      const recovered = await currentMedia(container, kind);
      expect(recovered).toHaveAttribute('src', 'https://assets.example/attempt-2');
      expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ version: 2, mode: 'proxy' });
      fireEvent.error(recovered);
      expect(screen.getByRole('alert')).toHaveTextContent('加载失败');
      await act(async () => {});
      expect(fetch).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
      expect(await currentMedia(container, kind)).toHaveAttribute(
        'src',
        'https://assets.example/attempt-3',
      );
      expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ version: 2 });
    },
  );

  it('已知解码失败不自动授权，手动重试仍获取新地址', async () => {
    const fetch = mockAuthorization();
    const { container } = render(<AssetPreview asset={makeAsset('video')} mode="content" />);
    const video = await currentMedia(container, 'video');
    Object.defineProperty(video, 'error', { value: { code: 3 } });
    fireEvent.error(video);
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await currentMedia(container, 'video')).toHaveAttribute(
      'src',
      'https://assets.example/attempt-2',
    );
  });

  it.each(['image', 'video', 'audio'] as const)(
    '%s 弹窗忽略旧签名，自动恢复和明确重试均重新授权',
    async (kind) => {
      const fetch = mockAuthorization();
      render(
        <AssetViewerDialog
          asset={makeAsset(kind)}
          open
          onOpenChange={vi.fn()}
          src="https://assets.example/expired-node-url"
        />,
      );
      const dialog = screen.getByRole('dialog');
      const first = await currentMedia(dialog, kind);
      expect(first).toHaveAttribute('src', 'https://assets.example/attempt-1');
      fireEvent.error(first);
      fireEvent.error(await currentMedia(dialog, kind));
      expect(fetch).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole('button', { name: '重新加载预览' }));
      expect(await currentMedia(dialog, kind)).toHaveAttribute(
        'src',
        'https://assets.example/attempt-3',
      );
      expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ version: 2 });
    },
  );

  it('弹窗关闭重开时重新检查过期签名，不先展示节点旧地址', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = mockAuthorization();
    const props = {
      asset: makeAsset('video'),
      onOpenChange: vi.fn(),
      src: 'https://assets.example/old',
    };
    const view = render(<AssetViewerDialog {...props} open />);
    await currentMedia(screen.getByRole('dialog'), 'video');
    view.rerender(<AssetViewerDialog {...props} open={false} />);
    now += 301_000;
    view.rerender(<AssetViewerDialog {...props} open />);
    expect(screen.getByRole('dialog').querySelector('video')).toBeNull();
    expect(await currentMedia(screen.getByRole('dialog'), 'video')).toHaveAttribute(
      'src',
      'https://assets.example/attempt-2',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('切换资源后返回原资源获得新的恢复机会', async () => {
    const fetch = mockAuthorization();
    const asset = makeAsset('video');
    const view = render(<AssetPreview asset={asset} mode="content" />);
    fireEvent.error(await currentMedia(view.container, 'video'));
    fireEvent.error(await currentMedia(view.container, 'video'));
    expect(screen.getByRole('alert')).toHaveTextContent('视频加载失败');
    view.rerender(
      <AssetPreview
        asset={{ ...asset, id: 'second', contentUrl: '/v1/assets/second/versions/2/content' }}
        mode="content"
      />,
    );
    await currentMedia(view.container, 'video');
    view.rerender(<AssetPreview asset={asset} mode="content" />);
    fireEvent.error(await currentMedia(view.container, 'video'));
    expect(await currentMedia(view.container, 'video')).toHaveAttribute(
      'src',
      'https://assets.example/attempt-4',
    );
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ version: 2, mode: 'proxy' });
  });

  it('外部资源失败不向本站发起授权，也不自动重复读取', () => {
    const fetch = mockAuthorization();
    const { container } = render(
      <AssetPreview
        asset={{ ...makeAsset('video'), contentUrl: 'https://external.example/video' }}
        mode="content"
      />,
    );
    fireEvent.error(container.querySelector('video')!);
    expect(screen.getByRole('alert')).toHaveTextContent('视频加载失败');
    expect(fetch).not.toHaveBeenCalled();
  });
});
