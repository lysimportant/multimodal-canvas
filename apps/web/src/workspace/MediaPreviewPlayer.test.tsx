import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPreviewPlayer } from './MediaPreviewPlayer';

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    this.dispatchEvent(new Event('play'));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
    this.dispatchEvent(new Event('pause'));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('共用媒体预览播放器', () => {
  it.each(['video', 'audio'] as const)(
    '%s 可播放暂停、倍速、循环和重播，关闭后停止',
    async (kind) => {
      const label = kind === 'video' ? '视频' : '音频';
      const view = render(
        <MediaPreviewPlayer
          kind={kind}
          src="/synthetic-media"
          name="测试资源"
          crossOrigin="anonymous"
        />,
      );
      const media = screen.getByLabelText('测试资源') as HTMLMediaElement;
      expect(media).toHaveAttribute('controls');
      expect(media).not.toHaveAttribute('autoplay');
      expect(media).toHaveAttribute('crossorigin', 'anonymous');
      fireEvent.loadedMetadata(media);
      await act(async () =>
        fireEvent.click(screen.getAllByRole('button', { name: '播放' + label })[0]!),
      );
      expect(media.paused).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: '暂停' + label }));
      expect(media.paused).toBe(true);
      fireEvent.change(screen.getByLabelText('播放速度'), { target: { value: '1.5' } });
      expect(media.playbackRate).toBe(1.5);
      fireEvent.click(screen.getByRole('button', { name: '循环播放' }));
      expect(media.loop).toBe(true);
      Object.defineProperty(media, 'ended', { configurable: true, value: true });
      media.currentTime = 4;
      fireEvent.ended(media);
      await act(async () =>
        fireEvent.click(screen.getAllByRole('button', { name: '重播' + label })[0]!),
      );
      expect(media.currentTime).toBe(0);
      vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
      view.unmount();
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
    },
  );

  it('播放拒绝显示原因，重新点击成功后清除错误', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('浏览器阻止播放'));
    render(<MediaPreviewPlayer kind="video" src="/synthetic-media" name="视频" />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '播放视频' })));
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器阻止播放');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '播放视频' })));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '暂停视频' })).toBeEnabled();
  });

  it('切换资源停止旧媒体，迟到的播放拒绝不污染新资源', async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const view = render(<MediaPreviewPlayer kind="video" src="/old" name="旧视频" />);
    fireEvent.click(screen.getByRole('button', { name: '播放视频' }));
    const old = screen.getByLabelText('旧视频');
    view.rerender(<MediaPreviewPlayer kind="video" src="/new" name="新视频" />);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(old).not.toBeInTheDocument();
    await act(async () => reject(new Error('旧视频拒绝播放')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('新视频')).toHaveAttribute('src', '/new');
    expect(screen.getByLabelText('播放速度')).toHaveValue('1');
  });

  it('解码失败可重建媒体重试，并保留选择的倍速', () => {
    const onError = vi.fn();
    render(
      <MediaPreviewPlayer kind="video" src="/synthetic-media" name="视频" onError={onError} />,
    );
    const media = screen.getByLabelText('视频');
    fireEvent.change(screen.getByLabelText('播放速度'), { target: { value: '2' } });
    fireEvent.error(media);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('视频加载失败');
    fireEvent.click(screen.getByRole('button', { name: '重新加载预览' }));
    const next = screen.getByLabelText('视频');
    expect(next).not.toBe(media);
    fireEvent.loadedMetadata(next);
    expect((next as HTMLMediaElement).playbackRate).toBe(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
