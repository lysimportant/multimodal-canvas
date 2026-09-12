import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Asset } from '@multimodal-canvas/domain';
import { AssetPreview, type AssetPreviewLoadState } from './AssetPreview';
import { clearAuthSession, persistAuthSession } from '../auth-client';

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
  clearAuthSession();
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
  /** 合成会话只用于验证签名申请，不读取本机凭据。 */
  function signIn() {
    persistAuthSession({
      accessToken: 'synthetic-preview-test',
      tokenType: 'Bearer',
      expiresIn: 3600,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      user: {
        id: 'preview-user',
        email: 'preview@example.test',
        role: 'user',
        createdAt: '2026-01-01',
      },
    });
  }

  it('签名失败不请求未鉴权内容，重试相对地址使用 API origin', async () => {
    signIn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ url: '/v1/assets/asset_1/content?access_token=synthetic' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const view = render(
      <AssetPreview
        asset={makeAsset({
          mediaType: 'image',
          mimeType: 'image/png',
          contentUrl: '/v1/assets/asset_1/versions/2/content',
        })}
        mode="content"
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('503');
    expect(view.container.querySelector('img')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('img')).toHaveAttribute(
      'src',
      'http://localhost:3000/v1/assets/asset_1/content?access_token=synthetic',
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ version: 2 });
  });

  it('切换资产取消旧签名请求，晚到响应不覆盖新预览，CDN 不请求 Bearer 内容', async () => {
    signIn();
    let resolveOld!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ url: 'https://cdn.example/new.png' }));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(
      <AssetPreview
        asset={makeAsset({
          mediaType: 'image',
          mimeType: 'image/png',
          contentUrl: '/v1/assets/asset_1/content',
        })}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(
      <AssetPreview
        asset={makeAsset({
          id: 'new',
          mediaType: 'image',
          mimeType: 'image/png',
          contentUrl: '/v1/assets/new/content',
        })}
      />,
    );
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'https://cdn.example/new.png');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    resolveOld(Response.json({ url: 'https://cdn.example/old.png' }));
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', 'https://cdn.example/new.png'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('文字单击不编辑，双击粘贴换行后失焦保存，失败保留草稿并可重试', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('原文'))),
    );
    const save = vi.fn().mockRejectedValueOnce(new Error('保存失败')).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AssetPreview asset={makeAsset()} mode="content" onTextSave={save} />);
    const content = await screen.findByLabelText('文字结果');
    const displayShell = content.closest('.artifact-preview-text-content');
    expect(displayShell).not.toHaveClass('nodrag');
    await user.click(content);
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.dblClick(content);
    const editor = screen.getByRole('textbox', { name: '编辑文字结果' });
    expect(editor.closest('.artifact-preview-text-content')).toHaveClass(
      'nodrag',
      'nopan',
      'nowheel',
    );
    await user.clear(editor);
    await user.paste('第一行\n第二行');
    fireEvent.blur(editor);
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
    expect(editor).toHaveValue('第一行\n第二行');
    await user.click(screen.getByRole('button', { name: '重试保存' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(save).toHaveBeenNthCalledWith(2, '第一行\n第二行');
  });

  it('文字输入法期间 Escape 不退出，组合结束后 Escape 取消且不冒泡删除快捷键', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('原文')));
    const save = vi.fn();
    const parentKey = vi.fn();
    const user = userEvent.setup();
    render(
      <div onKeyDown={parentKey}>
        <AssetPreview asset={makeAsset()} mode="content" onTextSave={save} />
      </div>,
    );
    await user.dblClick(await screen.findByLabelText('文字结果'));
    const editor = screen.getByRole('textbox', { name: '编辑文字结果' });
    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: '中文草稿' } });
    fireEvent.keyDown(editor, { key: 'Escape', isComposing: true });
    expect(editor).toBeInTheDocument();
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: 'Delete' });
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(parentKey).not.toHaveBeenCalled();
  });
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
    expect(image).toHaveAttribute('draggable', 'false');
    expect(screen.queryByRole('link', { name: /查看大图/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '预览图片：城市夜景' }));
    const viewer = screen.getByRole('dialog', { name: '城市夜景' });
    expect(viewer).toBeVisible();
    expect(viewer.querySelector('img')).toHaveAttribute('src', 'https://assets.example/city.png');
    await user.click(screen.getByRole('button', { name: '关闭预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.error(image);

    expect(await screen.findByRole('alert')).toHaveTextContent('图片加载失败');
    expect(onLoadStateChange).toHaveBeenLastCalledWith('error');
    await user.click(screen.getByRole('button', { name: '重新加载' }));
    const retriedImage = await screen.findByRole('img', { name: '城市夜景' });
    fireEvent.load(retriedImage);
    await waitFor(() => expect(onLoadStateChange).toHaveBeenLastCalledWith('ready'));
  });

  it('预览对话框滚轮放大图片，并可重置缩放', async () => {
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
      />,
    );
    await user.click(screen.getByRole('button', { name: '预览图片：城市夜景' }));
    const viewer = screen.getByRole('dialog', { name: '城市夜景' });
    const stage = viewer.querySelector('.artifact-preview-viewer-stage');
    expect(stage).not.toBeNull();
    vi.spyOn(stage as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.wheel(stage as HTMLElement, { deltaY: -100, clientX: 200, clientY: 150 });
    const layer = viewer.querySelector('.artifact-preview-viewer-transform') as HTMLElement;
    expect(layer.style.transform).toContain('scale(1.12)');
    expect(screen.getByRole('button', { name: '重置预览缩放' })).toHaveTextContent('112%');
    await user.click(screen.getByRole('button', { name: '重置预览缩放' }));
    expect(layer.style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(screen.getByRole('button', { name: '重置预览缩放' })).toHaveTextContent('100%');
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
    expect(video).not.toHaveAttribute('controls');
    fireEvent.click(screen.getByRole('button', { name: '预览视频：生成结果' }));
    const viewer = screen.getByRole('dialog', { name: '生成结果' });
    expect(viewer).toBeVisible();
    expect(viewer.querySelector('video')).toHaveAttribute('controls');
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
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
