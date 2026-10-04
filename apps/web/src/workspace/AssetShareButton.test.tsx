import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Asset } from '@multimodal-canvas/domain';
import { Dialog, DialogContent, DialogTitle } from '@multimodal-canvas/ui';

const auth = vi.hoisted(() => {
  let listener: (() => void) | undefined;
  class AuthSessionChangedError extends Error {}
  return {
    apiFetch: vi.fn(),
    getAuthSessionGeneration: vi.fn(() => 7),
    subscribeAuthSession: vi.fn((next: () => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    }),
    emitAuthSessionChange: () => listener?.(),
    AuthSessionChangedError,
  };
});

vi.mock('../auth-client', () => auth);

import { AssetShareButton, resolveAssetShareVersion } from './AssetShareButton';

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');

/** 创建仅供分享交互测试的持久化资源。 */
function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset/share target',
    name: '分享资源',
    mediaType: 'image',
    mimeType: 'image/png',
    sizeBytes: 32,
    status: 'ready',
    latestVersion: 9,
    contentUrl: '/v1/assets/asset%2Fshare/versions/4/content',
    tags: [],
    ...overrides,
  };
}

/** 生成相对当前时间仍有效的接口过期时间。 */
function futureExpiry(offsetMs = 7 * 24 * 60 * 60 * 1000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** 安装可逐次成功或失败的剪贴板写入模拟。 */
function mockClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

/** 创建成功响应，避免用例依赖固定日历日期。 */
function shareResponse(token: string, version = 4, expiresAt = futureExpiry()): Response {
  return Response.json({ token, expiresAt, version });
}

afterEach(() => {
  cleanup();
  auth.apiFetch.mockReset();
  auth.getAuthSessionGeneration.mockReset();
  auth.getAuthSessionGeneration.mockReturnValue(7);
  auth.subscribeAuthSession.mockClear();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(window.navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined });
  }
});

describe('AssetShareButton', () => {
  it('明确点击才创建冻结版本链接，并把浮层 Portal 到裁切容器之外', async () => {
    const writeText = mockClipboard();
    auth.apiFetch.mockResolvedValue(shareResponse('share token/+'));
    const view = render(
      <div className="artifact-preview-viewer" style={{ overflow: 'hidden' }}>
        <AssetShareButton asset={makeAsset()} />
      </div>,
    );

    expect(auth.apiFetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '分享当前版本' }));

    const panel = await screen.findByRole('group', { name: '资源分享链接' });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(view.container.contains(panel)).toBe(false);
    expect(panel.closest('.asset-share-popover')).toBeInTheDocument();
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    expect(String(auth.apiFetch.mock.calls[0]?.[0])).toBe(
      'http://localhost:3000/v1/assets/asset%2Fshare%20target/share',
    );
    expect(auth.apiFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ version: 4 }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(auth.apiFetch.mock.calls[0]?.[2]).toEqual({ expectedAuthGeneration: 7 });
    const publicUrl = String(writeText.mock.calls[0]?.[0]);
    expect(publicUrl).toContain('/share#token=share%20token%2F%2B');
    expect(publicUrl).not.toContain('accessToken');
    expect(screen.getByRole('textbox', { name: '分享链接' })).toHaveValue(publicUrl);
    expect(screen.getByText('分享链接已复制')).toBeInTheDocument();
  });

  it('Escape 先关闭分享浮层、保留外层预览，并把焦点归还触发按钮', async () => {
    mockClipboard();
    auth.apiFetch.mockResolvedValue(shareResponse('escape-token'));
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>资源预览</DialogTitle>
          <AssetShareButton asset={makeAsset()} />
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: '分享当前版本' });
    await userEvent.click(trigger);
    const close = await screen.findByRole('button', { name: '关闭分享面板' });
    await waitFor(() => expect(close).toHaveFocus());

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('group', { name: '资源分享链接' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '资源预览' })).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('复制失败保留手动链接，复制重试不重复创建分享', async () => {
    const writeText = mockClipboard(
      vi
        .fn()
        .mockRejectedValueOnce(new DOMException('permission denied', 'NotAllowedError'))
        .mockResolvedValueOnce(undefined),
    );
    auth.apiFetch.mockResolvedValue(shareResponse('retry-token', 9));
    render(
      <AssetShareButton
        asset={makeAsset({ contentUrl: '/v1/assets/asset/share/content', latestVersion: 9 })}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '分享当前版本' }));
    expect(await screen.findByText(/自动复制失败/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重新复制分享链接' }));

    expect(await screen.findByText('分享链接已复制')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    expect(auth.apiFetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ version: 9 }));
  });

  it('过期链接不再复制或复用，必须由用户明确重新创建', async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const writeText = mockClipboard();
    auth.apiFetch
      .mockResolvedValueOnce(shareResponse('old-token', 4, new Date(now + 10_000).toISOString()))
      .mockResolvedValueOnce(shareResponse('new-token', 4, new Date(now + 70_000).toISOString()));
    render(<AssetShareButton asset={makeAsset()} />);

    const trigger = screen.getByRole('button', { name: '分享当前版本' });
    await userEvent.click(trigger);
    await screen.findByRole('textbox', { name: '分享链接' });
    await userEvent.click(screen.getByRole('button', { name: '关闭分享面板' }));
    nowSpy.mockReturnValue(now + 20_000);
    await userEvent.click(trigger);

    expect(await screen.findByText(/原分享链接已过期/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '分享链接' })).toBeNull();
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: '关闭分享面板' }));
    await userEvent.click(trigger);
    expect(await screen.findByText(/原分享链接已过期/)).toBeInTheDocument();
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: '重新创建分享链接' }));
    await waitFor(() => expect(auth.apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(String(writeText.mock.calls[1]?.[0])).toContain('new-token');
  });

  it('账户切换立即清除链接，并忽略关闭或换账号后的剪贴板迟到结果', async () => {
    let resolveFirst!: () => void;
    let rejectSecond!: (reason: unknown) => void;
    const writeText = mockClipboard(
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>((_, reject) => {
              rejectSecond = reject;
            }),
        )
        .mockResolvedValue(undefined),
    );
    auth.apiFetch
      .mockResolvedValueOnce(shareResponse('account-one'))
      .mockResolvedValueOnce(shareResponse('account-two'));
    render(<AssetShareButton asset={makeAsset()} />);
    const trigger = screen.getByRole('button', { name: '分享当前版本' });

    await userEvent.click(trigger);
    await screen.findByRole('textbox', { name: '分享链接' });
    await userEvent.click(screen.getByRole('button', { name: '关闭分享面板' }));
    await act(async () => resolveFirst());
    expect(screen.queryByText('分享链接已复制')).toBeNull();

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('button', { name: '复制分享链接' }));
    auth.getAuthSessionGeneration.mockReturnValue(8);
    act(() => auth.emitAuthSessionChange());
    await act(async () => rejectSecond(new DOMException('late failure', 'NotAllowedError')));

    expect(screen.queryByRole('group', { name: '资源分享链接' })).toBeNull();
    expect(screen.queryByText(/自动复制失败/)).toBeNull();
    await userEvent.click(trigger);
    await waitFor(() => expect(auth.apiFetch).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenCalledTimes(3);
  });

  it('创建中防重复，关闭浮层或更换资源会取消并忽略迟到响应', async () => {
    mockClipboard();
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    auth.apiFetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const view = render(<AssetShareButton asset={makeAsset()} />);
    const trigger = screen.getByRole('button', { name: '分享当前版本' });

    await userEvent.click(trigger);
    expect(trigger).toBeDisabled();
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    const firstSignal = auth.apiFetch.mock.calls[0]?.[1]?.signal as AbortSignal;
    await userEvent.click(screen.getByRole('button', { name: '关闭分享面板' }));
    expect(firstSignal.aborted).toBe(true);
    await act(async () => resolveFirst(shareResponse('late-first')));
    expect(screen.queryByRole('textbox', { name: '分享链接' })).toBeNull();

    await userEvent.click(trigger);
    const secondSignal = auth.apiFetch.mock.calls[1]?.[1]?.signal as AbortSignal;
    view.rerender(
      <AssetShareButton
        asset={makeAsset({
          id: 'asset-next',
          contentUrl: '/v1/assets/asset-next/versions/2/content',
        })}
      />,
    );
    expect(secondSignal.aborted).toBe(true);
    await act(async () => resolveSecond(shareResponse('late-second', 2)));
    expect(screen.queryByRole('textbox', { name: '分享链接' })).toBeNull();
  });

  it('服务端失败可重试，缺少资源 ID 或内容时禁用', async () => {
    mockClipboard();
    auth.apiFetch
      .mockResolvedValueOnce(
        Response.json({ message: '演示或临时资源尚未持久化，无法分享' }, { status: 422 }),
      )
      .mockResolvedValueOnce(shareResponse('persisted'));
    const view = render(<AssetShareButton asset={makeAsset()} />);

    await userEvent.click(screen.getByRole('button', { name: '分享当前版本' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('演示或临时资源尚未持久化');
    await userEvent.click(screen.getByRole('button', { name: '重试创建' }));
    expect(await screen.findByText('分享链接已复制')).toBeInTheDocument();

    view.rerender(<AssetShareButton asset={makeAsset({ id: ' ', contentUrl: undefined })} />);
    expect(screen.getByRole('button', { name: '分享当前版本' })).toBeDisabled();
  });

  it('没有明确版本时交给后端确认当前版本', async () => {
    mockClipboard();
    auth.apiFetch.mockResolvedValue(shareResponse('server-version', 3));
    const asset = makeAsset({
      contentUrl: '/v1/assets/asset/share/content',
      latestVersion: undefined,
    });
    expect(resolveAssetShareVersion(asset)).toBeUndefined();
    render(<AssetShareButton asset={asset} />);

    await userEvent.click(screen.getByRole('button', { name: '分享当前版本' }));
    await waitFor(() => expect(auth.apiFetch).toHaveBeenCalledTimes(1));
    expect(auth.apiFetch.mock.calls[0]?.[1]?.body).toBe('{}');
  });
});
