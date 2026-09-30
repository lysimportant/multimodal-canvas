import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Asset } from '@multimodal-canvas/domain';
import { AssetPreview, AssetViewerDialog, type AssetPreviewLoadState } from './AssetPreview';
import { clearAuthSession, persistAuthSession } from '../auth-client';
import * as exports from '../export-utils';
import type { ProjectExportDownload } from '../export-utils';
import * as downloads from './node-asset-download';

/** 保存测试前的剪贴板配置，避免不同用例之间泄漏模拟状态。 */
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');

/** 创建独立合成资源，不依赖本机账号或真实网络产物。 */
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

/**
 * 模拟图片舞台的实际布局与尺寸观察，避免使用窗口尺寸代替 Dialog 内部可用空间。
 * @param width 初始可用宽度，单位为 CSS 像素。
 * @param height 初始可用高度，单位为 CSS 像素。
 * @returns 调整舞台矩形并发出 ResizeObserver 通知的函数。
 */
function mockImageStageSize(width = 800, height = 600) {
  vi.stubGlobal('devicePixelRatio', 1);
  let rect = new DOMRect(0, 0, width, height);
  let observed:
    { target: Element; observer: ResizeObserver; callback: ResizeObserverCallback } | undefined;
  const readWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!.get!;
  const readHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!.get!;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('artifact-preview-image-stage')
      ? rect.width
      : readWidth.call(this);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('artifact-preview-image-stage')
      ? rect.height
      : readHeight.call(this);
  });
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('artifact-preview-image-stage') ? rect : measure.call(this);
  });
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      /** 保存浏览器尺寸回调，通知时仍执行组件自身的测量逻辑。 */
      constructor(private readonly callback: ResizeObserverCallback) {}
      /** 仅接管图片舞台，不为 Dialog 内其他组件虚构布局。 */
      observe(target: Element) {
        if (target.classList.contains('artifact-preview-image-stage'))
          observed = { target, observer: this, callback: this.callback };
      }
      /** 停止指定图片舞台的观察。 */
      unobserve(target: Element) {
        if (observed?.target === target) observed = undefined;
      }
      /** 换资源卸载时仅清理当前观察器，避免误删新舞台。 */
      disconnect() {
        if (observed?.observer === this) observed = undefined;
      }
    },
  );
  return (nextWidth: number, nextHeight: number) => {
    rect = new DOMRect(0, 0, nextWidth, nextHeight);
    act(() => {
      if (observed)
        observed.callback(
          [{ target: observed.target, contentRect: rect } as ResizeObserverEntry],
          observed.observer,
        );
    });
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

  it('缓存图片已解码时不重置为加载中，换图后重新等待加载事件', () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1);
    const onLoadStateChange = vi.fn();
    const asset = makeAsset({
      mediaType: 'image',
      mimeType: 'image/png',
      contentUrl: 'https://assets.example/cached.png',
    });
    try {
      const view = render(<AssetPreview asset={asset} onLoadStateChange={onLoadStateChange} />);
      expect(onLoadStateChange).toHaveBeenLastCalledWith('ready');
      expect(view.container.querySelector('.artifact-preview-loading')).toBeNull();
      complete.mockReturnValue(false);
      view.rerender(
        <AssetPreview
          asset={{ ...asset, contentUrl: 'https://assets.example/new.png' }}
          onLoadStateChange={onLoadStateChange}
        />,
      );
      expect(onLoadStateChange).toHaveBeenLastCalledWith('loading');
      expect(view.container.querySelector('.artifact-preview-loading')).not.toBeNull();
      fireEvent.load(screen.getByRole('img'));
      expect(onLoadStateChange).toHaveBeenLastCalledWith('ready');
    } finally {
      complete.mockRestore();
      width.mockRestore();
    }
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
    await waitFor(() => expect(viewer).toBeVisible());
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

  it('预览对话框按实际尺寸缩放原图，并区分适应窗口与1:1', async () => {
    mockImageStageSize(400, 300);
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
    expect(screen.getByRole('button', { name: '原图 1:1' })).toBeDisabled();
    const stage = viewer.querySelector<HTMLElement>('.artifact-preview-image-stage')!;
    const image = stage.querySelector('img')!;
    Object.defineProperties(image, {
      naturalWidth: { value: 1600 },
      naturalHeight: { value: 1200 },
    });
    fireEvent.load(image);
    expect(image).toHaveStyle({ width: '400px', height: '300px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^25%$/);
    fireEvent.wheel(stage, { deltaY: -100, clientX: 200, clientY: 150 });
    expect(image).toHaveStyle({ width: '500px', height: '375px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^31\.3%$/);
    const content = viewer.querySelector<HTMLElement>('.artifact-preview-image-content')!;
    expect(content.style.transform).not.toMatch(/scale/i);
    await user.click(screen.getByRole('button', { name: '原图 1:1' }));
    expect(image).toHaveStyle({ width: '1600px', height: '1200px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^100%$/);
    await user.click(screen.getByRole('button', { name: '适应窗口' }));
    expect(image).toHaveStyle({ width: '400px', height: '300px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^25%$/);
    expect(image).toHaveAttribute('src', 'https://assets.example/city.png');
  });

  it('图片首次按下后即使节点变为选中也只打开编辑器，再次点击才预览', async () => {
    const asset = makeAsset({ mediaType: 'image', mimeType: 'image/png' });
    const selectNode = vi.fn();
    const view = render(
      <div onClick={selectNode}>
        <AssetPreview asset={asset} mode="content" mediaClickPreviewEnabled={false} />
      </div>,
    );
    const image = screen.getByRole('img');
    fireEvent.pointerDown(image);
    view.rerender(
      <div onClick={selectNode}>
        <AssetPreview asset={asset} mode="content" mediaClickPreviewEnabled />
      </div>,
    );
    fireEvent.click(image);
    expect(selectNode).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.pointerDown(image);
    fireEvent.click(image);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    expect(selectNode).toHaveBeenCalledTimes(1);
  });

  it('图片未启用直接点击预览时，显式展开按钮仍可打开预览', async () => {
    render(
      <AssetPreview
        asset={makeAsset({ mediaType: 'image', mimeType: 'image/png' })}
        mode="content"
        mediaClickPreviewEnabled={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '预览图片：生成结果' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
  });

  it.each([
    { label: '横图', width: 1920, height: 1080 },
    { label: '竖图', width: 1080, height: 1920 },
    { label: '小图', width: 160, height: 90 },
  ])('$label 预览按原比例适配舞台，小图保持原尺寸', ({ width, height }) => {
    mockImageStageSize();
    render(
      <AssetViewerDialog
        asset={makeAsset({ mediaType: 'image', mimeType: 'image/png' })}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const viewer = screen.getByRole('dialog');
    const image = viewer.querySelector('img')!;
    Object.defineProperties(image, {
      naturalWidth: { value: width },
      naturalHeight: { value: height },
    });
    fireEvent.load(image);
    const scale = Math.min(1, 800 / width, 600 / height);
    expect(image).toHaveStyle({ width: width * scale + 'px', height: height * scale + 'px' });
    expect(screen.getByText('原图 ' + width + ' × ' + height)).toBeInTheDocument();
    expect(
      Number.parseFloat(image.style.width) / Number.parseFloat(image.style.height),
    ).toBeCloseTo(width / height);
    expect(screen.getByRole('button', { name: '适应窗口' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('切换资源清除旧尺寸，舞台变化后重新适配当前资源', () => {
    const resizeStage = mockImageStageSize();
    const view = render(
      <AssetViewerDialog
        asset={makeAsset({ mediaType: 'image', mimeType: 'image/png' })}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const image = screen.getByRole('dialog').querySelector('img')!;
    Object.defineProperties(image, {
      naturalWidth: { value: 1080 },
      naturalHeight: { value: 1920 },
    });
    fireEvent.load(image);
    expect(image).toHaveStyle({ width: '337.5px', height: '600px' });
    view.rerender(
      <AssetViewerDialog
        asset={makeAsset({
          id: 'small-image',
          mediaType: 'image',
          mimeType: 'image/png',
          contentUrl: 'https://assets.example/small.png',
        })}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const nextImage = screen.getByRole('dialog').querySelector('img')!;
    expect(nextImage).not.toBe(image);
    expect(screen.queryByText('原图 1080 × 1920')).not.toBeInTheDocument();
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('—');
    expect(screen.getByRole('button', { name: '原图 1:1' })).toBeDisabled();
    Object.defineProperties(nextImage, {
      naturalWidth: { value: 180 },
      naturalHeight: { value: 120 },
    });
    fireEvent.load(nextImage);
    expect(nextImage).toHaveStyle({ width: '180px', height: '120px' });
    resizeStage(144, 96);
    expect(nextImage).toHaveStyle({ width: '144px', height: '96px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^80%$/);
  });

  it.each(['切换同地址资源', '关闭重开'])(
    '%s按Dialog身份重建图片视图，不保留旧旋转和缩放',
    (method) => {
      mockImageStageSize();
      const asset = makeAsset({ mediaType: 'image', mimeType: 'image/png' });
      const onOpenChange = vi.fn();
      const view = render(<AssetViewerDialog asset={asset} open onOpenChange={onOpenChange} />);
      const image = screen.getByRole('dialog').querySelector('img')!;
      Object.defineProperties(image, {
        naturalWidth: { value: 1600 },
        naturalHeight: { value: 1200 },
      });
      fireEvent.load(image);
      fireEvent.click(screen.getByRole('button', { name: '原图 1:1' }));
      fireEvent.click(screen.getByRole('button', { name: '向右旋转90度' }));
      fireEvent.click(screen.getByRole('button', { name: '水平翻转' }));
      if (method === '切换同地址资源') {
        view.rerender(
          <AssetViewerDialog
            asset={{ ...asset, id: 'asset_2' }}
            open
            onOpenChange={onOpenChange}
          />,
        );
      } else {
        view.rerender(<AssetViewerDialog asset={asset} open={false} onOpenChange={onOpenChange} />);
        view.rerender(<AssetViewerDialog asset={asset} open onOpenChange={onOpenChange} />);
      }
      const nextImage = screen.getByRole('dialog').querySelector('img')!;
      expect(nextImage).not.toBe(image);
      expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('—');
      Object.defineProperties(nextImage, {
        naturalWidth: { value: 1600 },
        naturalHeight: { value: 1200 },
      });
      fireEvent.load(nextImage);
      expect(nextImage).toHaveStyle({ width: '800px', height: '600px', transform: 'rotate(0deg)' });
      expect(screen.getByRole('button', { name: '水平翻转' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(screen.getByRole('button', { name: '适应窗口' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    },
  );

  it('视频预览使用解码尺寸适配并保留原生播放控件', () => {
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 900);
    render(
      <AssetViewerDialog
        asset={makeAsset({ mediaType: 'video', mimeType: 'video/mp4' })}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const viewer = screen.getByRole('dialog');
    const video = viewer.querySelector('video')!;
    Object.defineProperties(video, {
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
    });
    fireEvent.loadedMetadata(video);
    expect(video).toHaveAttribute('controls');
    expect(viewer.querySelector('.artifact-preview-viewer-stage')).toHaveStyle({
      width: '1222px',
      height: '687.375px',
    });
  });

  it('预览尺寸无效或加载失败时给出错误和重新加载入口', async () => {
    render(
      <AssetViewerDialog
        asset={makeAsset({ mediaType: 'image', mimeType: 'image/png' })}
        open
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.load(screen.getByRole('dialog').querySelector('img')!);
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取图片尺寸');
    await userEvent.click(screen.getByRole('button', { name: '重新加载预览' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.error(screen.getByRole('dialog').querySelector('img')!);
    expect(screen.getByRole('alert')).toHaveTextContent('图片加载失败');
    expect(screen.getByRole('button', { name: '重新加载预览' })).toBeInTheDocument();
  });

  it('节点视频播放拒绝后显示具体原因，再次点击播放可以恢复', async () => {
    const { container } = render(
      <AssetPreview
        asset={makeAsset({ mediaType: 'video', mimeType: 'video/mp4' })}
        mode="content"
      />,
    );
    const video = container.querySelector('video')!;
    const play = vi
      .fn()
      .mockRejectedValueOnce(new Error('播放权限被浏览器拒绝'))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(video, 'play', { value: play });
    fireEvent.loadedMetadata(video);
    await userEvent.click(screen.getByRole('button', { name: '播放视频' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('播放权限被浏览器拒绝');
    await userEvent.click(screen.getByRole('button', { name: '播放视频' }));
    expect(play).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.play(video);
    expect(screen.queryByRole('button', { name: '播放视频' })).not.toBeInTheDocument();
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
    expect(container.firstElementChild).not.toHaveClass('nodrag');
    fireEvent.loadedMetadata(video!);
    expect(screen.getByRole('button', { name: '播放视频' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '预览视频：生成结果' }));
    const viewer = screen.getByRole('dialog', { name: '生成结果' });
    await waitFor(() => expect(viewer).toBeVisible());
    expect(viewer.querySelector('video')).toHaveAttribute('controls');
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '播放视频' })).toBeInTheDocument();
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

describe('AssetViewerDialog 原文件下载', () => {
  it('图片展开入口可下载当前版本，保存后仍保留预览', async () => {
    const asset = makeAsset({
      mediaType: 'image',
      mimeType: 'image/png',
      contentUrl: '/v1/assets/asset_1/versions/3/content',
    });
    const download = { blob: new Blob(['original']), filename: '原图.png' };
    const fetchDownload = vi.spyOn(downloads, 'fetchNodeAssetDownload').mockResolvedValue(download);
    const saveDownload = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
    render(<AssetPreview asset={asset} mode="content" mediaClickPreviewEnabled={false} />);

    await userEvent.click(screen.getByRole('button', { name: '预览图片：生成结果' }));
    const viewer = screen.getByRole('dialog');
    await userEvent.click(within(viewer).getByRole('button', { name: '下载原文件' }));

    await waitFor(() => expect(saveDownload).toHaveBeenCalledWith(download));
    expect(fetchDownload).toHaveBeenCalledWith(asset, expect.any(AbortSignal));
    expect(saveDownload).toHaveBeenCalledTimes(1);
    expect(viewer).toBeVisible();
    expect(within(viewer).getByRole('button', { name: '下载原文件' })).toBeEnabled();
    expect(within(viewer).queryByRole('button', { name: '取消下载' })).not.toBeInTheDocument();
  });

  it.each([
    { mediaType: 'image', mimeType: 'image/png', filename: 'original.png' },
    { mediaType: 'video', mimeType: 'video/mp4', filename: 'original.mp4' },
    { mediaType: 'audio', mimeType: 'audio/wav', filename: 'original.wav' },
  ] as const)(
    '$mediaType 下载版本原文件而非预览地址，保留文件名、MIME 和全部字节',
    async ({ mediaType, mimeType, filename }) => {
      const asset = makeAsset({
        mediaType,
        mimeType,
        contentUrl: '/v1/assets/asset_1/versions/3/content',
      });
      const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10, 0, 254]);
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(bytes, {
          headers: {
            'content-type': mimeType,
            'content-disposition': 'attachment; filename="' + filename + '"',
          },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const fetchDownload = vi.spyOn(downloads, 'fetchNodeAssetDownload');
      const saveDownload = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
      render(
        <AssetViewerDialog
          asset={asset}
          open
          onOpenChange={vi.fn()}
          src="https://cdn.example/preview-only"
        />,
      );

      await userEvent.click(screen.getByRole('button', { name: '下载原文件' }));

      await waitFor(() => expect(saveDownload).toHaveBeenCalledTimes(1));
      expect(fetchDownload).toHaveBeenCalledWith(asset, expect.any(AbortSignal));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://localhost:3000/v1/assets/asset_1/versions/3/content',
      );
      const saved = saveDownload.mock.calls[0][0];
      expect(saved.filename).toBe(filename);
      expect(saved.blob.type).toBe(mimeType);
      const savedBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(saved.blob);
      });
      expect(new Uint8Array(savedBytes)).toEqual(bytes);
    },
  );

  it.each([
    { reason: new Error('下载失败（403），请重试'), message: '下载失败（403），请重试' },
    { reason: '连接断开', message: '下载失败，请重试' },
  ])('下载失败保留具体或兜底错误，重新下载清除错误：$message', async ({ reason, message }) => {
    const download = { blob: new Blob(['original']), filename: '原图.png' };
    const fetchDownload = vi
      .spyOn(downloads, 'fetchNodeAssetDownload')
      .mockRejectedValueOnce(reason)
      .mockResolvedValueOnce(download);
    const saveDownload = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
    render(
      <AssetViewerDialog
        asset={makeAsset({ mediaType: 'image', mimeType: 'image/png' })}
        open
        onOpenChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '下载原文件' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(saveDownload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '下载原文件' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '下载原文件' }));
    await waitFor(() => expect(saveDownload).toHaveBeenCalledWith(download));
    expect(fetchDownload).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('浏览器保存失败显示错误且允许重试', async () => {
    const download = { blob: new Blob(['original']), filename: '原图.png' };
    vi.spyOn(downloads, 'fetchNodeAssetDownload').mockResolvedValue(download);
    const saveDownload = vi
      .spyOn(exports, 'downloadProjectExport')
      .mockImplementationOnce(() => {
        throw new Error('当前环境不支持文件下载');
      })
      .mockImplementation(() => {});
    render(
      <AssetViewerDialog
        asset={makeAsset({ mediaType: 'image', mimeType: 'image/png' })}
        open
        onOpenChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '下载原文件' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('当前环境不支持文件下载');
    await userEvent.click(screen.getByRole('button', { name: '下载原文件' }));
    await waitFor(() => expect(saveDownload).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['完成', '失败'])(
    '下载中禁止重复请求，取消后旧请求晚到$0不干扰新下载',
    async (outcome) => {
      let resolveOld!: (value: ProjectExportDownload) => void;
      let rejectOld!: (reason: Error) => void;
      let resolveNew!: (value: ProjectExportDownload) => void;
      const fetchDownload = vi
        .spyOn(downloads, 'fetchNodeAssetDownload')
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              resolveOld = resolve;
              rejectOld = reject;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveNew = resolve;
            }),
        );
      const saveDownload = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
      render(
        <AssetViewerDialog
          asset={makeAsset({ mediaType: 'image', mimeType: 'image/png' })}
          open
          onOpenChange={vi.fn()}
        />,
      );
      const button = screen.getByRole('button', { name: '下载原文件' });
      await userEvent.click(button);
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(within(button).getByRole('status')).toHaveTextContent('下载中');
      await userEvent.click(button);
      expect(fetchDownload).toHaveBeenCalledTimes(1);
      const oldSignal = fetchDownload.mock.calls[0][1];

      await userEvent.click(screen.getByRole('button', { name: '取消下载' }));
      expect(oldSignal?.aborted).toBe(true);
      expect(button).toBeEnabled();
      expect(screen.queryByRole('button', { name: '取消下载' })).not.toBeInTheDocument();
      await userEvent.click(button);
      await act(async () => {
        if (outcome === '完成') resolveOld({ blob: new Blob(['old']), filename: 'old.png' });
        else rejectOld(new Error('旧请求失败'));
      });
      expect(saveDownload).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(button).toBeDisabled();
      expect(fetchDownload.mock.calls[1][1]?.aborted).toBe(false);

      const current = { blob: new Blob(['current']), filename: 'current.png' };
      await act(async () => resolveNew(current));
      expect(saveDownload).toHaveBeenCalledExactlyOnceWith(current);
      expect(button).toBeEnabled();
    },
  );

  it.each([
    { label: '资产 ID', next: { id: 'asset_2' } },
    { label: '版本地址', next: { contentUrl: '/v1/assets/asset_1/versions/4/content' } },
    { label: '当前版本号', next: { latestVersion: 4 } },
  ])('切换$label取消旧下载，忽略旧响应并使用当前资源重试', async ({ next }) => {
    let resolveOld!: (value: ProjectExportDownload) => void;
    const current = { blob: new Blob(['current']), filename: 'current.png' };
    const fetchDownload = vi
      .spyOn(downloads, 'fetchNodeAssetDownload')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(current);
    const saveDownload = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
    const asset = makeAsset({ mediaType: 'image', mimeType: 'image/png', latestVersion: 3 });
    const onOpenChange = vi.fn();
    const view = render(<AssetViewerDialog asset={asset} open onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole('button', { name: '下载原文件' }));
    const oldSignal = fetchDownload.mock.calls[0][1];
    const nextAsset = { ...asset, ...next };
    view.rerender(<AssetViewerDialog asset={nextAsset} open onOpenChange={onOpenChange} />);
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: '下载原文件' })).toBeEnabled();
    await act(async () => resolveOld({ blob: new Blob(['old']), filename: 'old.png' }));
    expect(saveDownload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '下载原文件' }));
    await waitFor(() => expect(saveDownload).toHaveBeenCalledExactlyOnceWith(current));
    expect(fetchDownload).toHaveBeenLastCalledWith(nextAsset, expect.any(AbortSignal));
  });

  it.each(['关闭按钮', 'Escape', '受控关闭', '卸载'])(
    '$0取消下载，晚到响应不保存文件',
    async (method) => {
      let resolveDownload!: (value: ProjectExportDownload) => void;
      const fetchDownload = vi.spyOn(downloads, 'fetchNodeAssetDownload').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDownload = resolve;
          }),
      );
      const saveDownload = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
      const asset = makeAsset({ mediaType: 'image', mimeType: 'image/png' });
      const onOpenChange = vi.fn();
      const view = render(<AssetViewerDialog asset={asset} open onOpenChange={onOpenChange} />);
      await userEvent.click(screen.getByRole('button', { name: '下载原文件' }));
      const signal = fetchDownload.mock.calls[0][1];

      if (method === '关闭按钮')
        await userEvent.click(screen.getByRole('button', { name: '关闭预览' }));
      else if (method === 'Escape') await userEvent.keyboard('{Escape}');
      else if (method === '受控关闭')
        view.rerender(<AssetViewerDialog asset={asset} open={false} onOpenChange={onOpenChange} />);
      else view.unmount();
      expect(signal?.aborted).toBe(true);
      if (method === '关闭按钮' || method === 'Escape')
        expect(onOpenChange).toHaveBeenCalledWith(false);
      await act(async () => resolveDownload({ blob: new Blob(['old']), filename: 'old.png' }));
      expect(saveDownload).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      if (method === '受控关闭') {
        view.rerender(<AssetViewerDialog asset={asset} open onOpenChange={onOpenChange} />);
        expect(screen.getByRole('button', { name: '下载原文件' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: '取消下载' })).not.toBeInTheDocument();
      }
    },
  );

  it.each(['切换资源', '关闭重开'])('$0清除旧下载错误', async (method) => {
    vi.spyOn(downloads, 'fetchNodeAssetDownload').mockRejectedValueOnce(
      new Error('旧资源下载失败'),
    );
    const asset = makeAsset({ mediaType: 'image', mimeType: 'image/png' });
    const onOpenChange = vi.fn();
    const view = render(<AssetViewerDialog asset={asset} open onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole('button', { name: '下载原文件' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('旧资源下载失败');
    if (method === '切换资源')
      view.rerender(
        <AssetViewerDialog asset={{ ...asset, id: 'asset_2' }} open onOpenChange={onOpenChange} />,
      );
    else {
      view.rerender(<AssetViewerDialog asset={asset} open={false} onOpenChange={onOpenChange} />);
      view.rerender(<AssetViewerDialog asset={asset} open onOpenChange={onOpenChange} />);
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载原文件' })).toBeEnabled();
  });

  it('只刷新预览签名地址不取消原文件下载', async () => {
    let resolveDownload!: (value: ProjectExportDownload) => void;
    const fetchDownload = vi.spyOn(downloads, 'fetchNodeAssetDownload').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );
    const saveDownload = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
    const asset = makeAsset({ mediaType: 'image', mimeType: 'image/png' });
    const onOpenChange = vi.fn();
    const view = render(
      <AssetViewerDialog
        asset={asset}
        open
        onOpenChange={onOpenChange}
        src="https://cdn.example/original?token=old"
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '下载原文件' }));
    view.rerender(
      <AssetViewerDialog
        asset={{ ...asset }}
        open
        onOpenChange={onOpenChange}
        src="https://cdn.example/original?token=new"
      />,
    );
    expect(fetchDownload.mock.calls[0][1]?.aborted).toBe(false);
    expect(screen.getByRole('button', { name: '下载原文件' })).toBeDisabled();
    const download = { blob: new Blob(['original']), filename: 'original.png' };
    await act(async () => resolveDownload(download));
    expect(saveDownload).toHaveBeenCalledExactlyOnceWith(download);
  });

  it('没有原文件地址时禁用下载，不使用预览地址兜底', async () => {
    const fetchDownload = vi.spyOn(downloads, 'fetchNodeAssetDownload');
    render(
      <AssetViewerDialog
        asset={makeAsset({ mediaType: 'image', mimeType: 'image/png', contentUrl: '' })}
        open
        onOpenChange={vi.fn()}
        src="https://cdn.example/thumbnail.png"
      />,
    );
    const button = screen.getByRole('button', { name: '下载原文件' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(fetchDownload).not.toHaveBeenCalled();
  });
});
