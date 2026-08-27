import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Asset } from '@multimodal-canvas/domain';
import { AssetPreview, type AssetPreviewLoadState } from './AssetPreview';

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset_1',
    name: '生成结果',
    mediaType: 'text',
    mimeType: 'text/plain',
    sizeBytes: 18,
    status: 'ready',
    contentUrl: 'https://assets.example/result.txt',
    tags: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalClipboardDescriptor) {
    Object.defineProperty(window.navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  }
});

describe('AssetPreview', () => {
  it('renders and copies the real multiline text result', async () => {
    const content = '第一行中文\nSecond line 123 !@#';
    const fetchMock = vi.fn().mockResolvedValue(new Response(content, { status: 200 }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<AssetPreview asset={makeAsset()} mode="content" />);

    const result = await screen.findByText((_, element) => element?.tagName === 'PRE');
    expect(result).toHaveTextContent('第一行中文');
    expect(result.textContent).toBe(content);
    expect(result).toHaveClass('artifact-preview-text-body');

    await user.click(screen.getByRole('button', { name: '复制文字结果' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(content));
    expect(screen.getByText('已复制')).toBeInTheDocument();
  });

  it('shows a retryable state when fetching text fails', async () => {
    const states: AssetPreviewLoadState[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('重试后内容', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <AssetPreview
        asset={makeAsset()}
        mode="content"
        onLoadStateChange={(state) => states.push(state)}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('文字产物加载失败');
    expect(states).toContain('error');
    await user.click(screen.getByRole('button', { name: '重新加载' }));

    expect(await screen.findByText('重试后内容')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe('ready');
  });

  it('opens a real image and exposes image load errors', async () => {
    const onLoadStateChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AssetPreview
        asset={makeAsset({
          name: '城市夜景',
          mediaType: 'image',
          mimeType: 'image/png',
          contentUrl: 'https://assets.example/city.png',
        })}
        mode="content"
        onLoadStateChange={onLoadStateChange}
      />,
    );

    const image = screen.getByRole('img', { name: '城市夜景' });
    expect(image).toHaveAttribute('src', 'https://assets.example/city.png');
    expect(screen.getByRole('link', { name: '查看大图：城市夜景' })).toHaveAttribute(
      'href',
      'https://assets.example/city.png',
    );
    fireEvent.error(image);

    expect(await screen.findByRole('alert')).toHaveTextContent('图片加载失败');
    expect(onLoadStateChange).toHaveBeenLastCalledWith('error');
    await user.click(screen.getByRole('button', { name: '重新加载' }));
    const retriedImage = await screen.findByRole('img', { name: '城市夜景' });
    fireEvent.load(retriedImage);
    await waitFor(() => expect(onLoadStateChange).toHaveBeenLastCalledWith('ready'));
  });

  it('preserves compact resource-card sizing hooks on the shell and media', () => {
    const { container } = render(
      <AssetPreview
        asset={makeAsset({
          mediaType: 'image',
          mimeType: 'image/webp',
          contentUrl: 'https://assets.example/thumb.webp',
        })}
        className="asset-card-preview"
      />,
    );

    expect(container.firstElementChild).toHaveClass(
      'artifact-preview-media-shell',
      'asset-card-preview',
    );
    expect(container.querySelector('img')).toHaveClass('asset-card-preview');
  });

  it('renders playable video and audio controls and reports media errors', async () => {
    const videoStates: AssetPreviewLoadState[] = [];
    const { container, rerender } = render(
      <AssetPreview
        asset={makeAsset({
          mediaType: 'video',
          mimeType: 'video/mp4',
          contentUrl: 'https://assets.example/result.mp4',
        })}
        mode="content"
        onLoadStateChange={(state) => videoStates.push(state)}
      />,
    );

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('controls');
    expect(screen.getByText('正在加载视频…')).toBeInTheDocument();
    fireEvent.error(video!);
    expect(await screen.findByRole('alert')).toHaveTextContent('视频加载失败');
    expect(videoStates).toContain('error');

    rerender(
      <AssetPreview
        asset={makeAsset({
          id: 'asset_audio',
          mediaType: 'audio',
          mimeType: 'audio/mpeg',
          contentUrl: 'https://assets.example/result.mp3',
        })}
        mode="content"
      />,
    );
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('src', 'https://assets.example/result.mp3');
  });

  it('renders unknown MIME output as a downloadable file attachment', () => {
    render(
      <AssetPreview
        asset={makeAsset({
          name: '模型输出.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: 1536,
          contentUrl: 'https://assets.example/output.bin',
        })}
        mode="content"
      />,
    );

    expect(screen.getByText('模型输出.bin')).toBeInTheDocument();
    expect(screen.getByText('application/octet-stream · 1.5 KB')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '下载文件：模型输出.bin' })).toHaveAttribute(
      'download',
      '模型输出.bin',
    );
  });

  it('distinguishes an absent or expired artifact URL', async () => {
    const onLoadStateChange = vi.fn();
    render(
      <AssetPreview
        asset={makeAsset({ contentUrl: '' })}
        mode="content"
        onLoadStateChange={onLoadStateChange}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('产物不存在或已失效');
    await waitFor(() => expect(onLoadStateChange).toHaveBeenCalledWith('missing'));
  });
});
