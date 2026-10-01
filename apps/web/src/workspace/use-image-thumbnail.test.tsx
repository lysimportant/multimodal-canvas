import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../auth-client';
import * as thumbnails from './image-thumbnail-cache';
import { useImageThumbnail } from './use-image-thumbnail';

/** 固定资源地址，换会话时不修改组件 props 或重新挂载组件。 */
const source: thumbnails.ImageThumbnailSource = {
  url: '/v1/assets/thumbnail-session-test/versions/1/derivatives/thumbnail',
  immutable: true,
};
/** 合成管理账户；通过真实会话通知模拟换号、角色变化和普通续期。 */
const user: auth.AuthUser = {
  id: 'thumbnail-session-a',
  role: 'admin',
  createdAt: '2026-01-01',
};
/** 旧会话的地址和原图尺寸，换会话后的加载态不能继续显示其中任何一项。 */
const previousThumbnail: thumbnails.ImageThumbnail = {
  url: 'blob:previous-session',
  originalWidth: 3840,
  originalHeight: 2160,
};
/** 新会话授权后的地址和原图尺寸，不复用旧会话结果。 */
const currentThumbnail: thumbnails.ImageThumbnail = {
  url: 'blob:current-session',
  originalWidth: 1920,
  originalHeight: 1080,
};

/** 将 hook 状态渲染为可见图片、尺寸和加载/错误提示，不发起实际图片请求。 */
function ThumbnailProbe() {
  const state = useImageThumbnail(source, 0);
  return (
    <div>
      {state.loading && <span role="status">正在加载缩略图</span>}
      {state.error && <span role="alert">{state.error}</span>}
      {state.url && <img src={state.url} alt="当前会话缩略图" />}
      {state.originalWidth && state.originalHeight && (
        <span>
          {state.originalWidth}×{state.originalHeight}
        </span>
      )}
    </div>
  );
}

/**
 * 创建无网络请求的可控缓存租约，隔离共享缓存的并行改动。
 * @returns lease 供 hook 持有和释放；resolve/reject 决定缩略图返回或拒绝的时机。
 */
function deferredThumbnail() {
  let resolve!: (value: thumbnails.ImageThumbnail) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<thumbnails.ImageThumbnail>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { lease: { promise, release: vi.fn() }, resolve, reject };
}

beforeEach(() => {
  auth.persistAuthSession({ user });
});
afterEach(() => {
  cleanup();
  auth.clearAuthSession();
  vi.restoreAllMocks();
});

describe('useImageThumbnail 鉴权代次隔离', () => {
  it('同组件换账号立即隐藏旧图和尺寸，重新授权成功后只显示新结果', async () => {
    const previous = deferredThumbnail();
    const current = deferredThumbnail();
    const acquire = vi
      .spyOn(thumbnails, 'acquireImageThumbnail')
      .mockReturnValue(current.lease)
      .mockReturnValueOnce(previous.lease);
    const view = render(<ThumbnailProbe />);
    await act(async () => previous.resolve(previousThumbnail));
    expect(screen.getByRole('img')).toHaveAttribute('src', previousThumbnail.url);
    expect(screen.getByText('3840×2160')).toBeInTheDocument();

    act(() => {
      auth.persistAuthSession({ user: { ...user, id: 'thumbnail-session-b' } });
    });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText('3840×2160')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('正在加载缩略图');
    expect(previous.lease.release).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenNthCalledWith(2, source, 0);

    await act(async () => current.resolve(currentThumbnail));
    expect(screen.getByRole('img')).toHaveAttribute('src', currentThumbnail.url);
    expect(screen.getByText('1920×1080')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.unmount();
    expect(current.lease.release).toHaveBeenCalledTimes(1);
    act(() => auth.clearAuthSession());
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('同组件角色变化后重新鉴权被拒绝，加载和失败期间均不显示旧图', async () => {
    const previous = deferredThumbnail();
    const current = deferredThumbnail();
    const acquire = vi
      .spyOn(thumbnails, 'acquireImageThumbnail')
      .mockReturnValue(current.lease)
      .mockReturnValueOnce(previous.lease);
    render(<ThumbnailProbe />);
    await act(async () => previous.resolve(previousThumbnail));
    expect(screen.getByRole('img')).toHaveAttribute('src', previousThumbnail.url);

    act(() => {
      auth.persistAuthSession({ user: { ...user, role: 'user' } }, { renewal: true });
    });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText('3840×2160')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(previous.lease.release).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(2);

    await act(async () => current.reject(new Error('缩略图读取失败（403），原文件未受影响')));
    expect(screen.getByRole('alert')).toHaveTextContent('缩略图读取失败（403）');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText('3840×2160')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each(['成功', '失败'] as const)('旧会话迟到的%s不能覆盖新会话图片', async (outcome) => {
    const previous = deferredThumbnail();
    const current = deferredThumbnail();
    const acquire = vi
      .spyOn(thumbnails, 'acquireImageThumbnail')
      .mockReturnValue(current.lease)
      .mockReturnValueOnce(previous.lease);
    render(<ThumbnailProbe />);
    act(() => {
      auth.persistAuthSession({ user: { ...user, id: 'thumbnail-session-b' } });
    });
    expect(previous.lease.release).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(currentThumbnail));
    expect(screen.getByRole('img')).toHaveAttribute('src', currentThumbnail.url);

    await act(async () => {
      if (outcome === '成功') previous.resolve(previousThumbnail);
      else previous.reject(new Error('旧会话缩略图读取失败（403）'));
    });
    expect(screen.getByRole('img')).toHaveAttribute('src', currentThumbnail.url);
    expect(screen.getByText('1920×1080')).toBeInTheDocument();
    expect(screen.queryByText('3840×2160')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('同账号同角色的普通续期不丢图、不重新请求或提前释放租约', async () => {
    const current = deferredThumbnail();
    const acquire = vi.spyOn(thumbnails, 'acquireImageThumbnail').mockReturnValue(current.lease);
    const view = render(<ThumbnailProbe />);
    await act(async () => current.resolve(currentThumbnail));
    const generation = auth.getAuthSessionGeneration();

    act(() => {
      auth.persistAuthSession(
        { user: { ...user, displayName: '已更新的公开名称' } },
        { renewal: true },
      );
    });
    expect(auth.getAuthSessionGeneration()).toBe(generation);
    expect(screen.getByRole('img')).toHaveAttribute('src', currentThumbnail.url);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(current.lease.release).not.toHaveBeenCalled();
    view.unmount();
    expect(current.lease.release).toHaveBeenCalledTimes(1);
  });
});
