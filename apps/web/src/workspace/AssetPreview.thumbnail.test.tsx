import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import * as auth from '../auth-client';
import * as exports from '../export-utils';
import { AssetPreview } from './AssetPreview';
import { clearImageThumbnailCache } from './image-thumbnail-cache';

/** 独立合成的原文件版本，避免测试读取真实项目。 */
const asset: Asset = {
  id: 'thumbnail-view',
  name: '原文件',
  mediaType: 'image',
  mimeType: 'image/png',
  sizeBytes: 5000,
  status: 'ready',
  latestVersion: 2,
  contentUrl: '/v1/assets/thumbnail-view/versions/2/content',
  tags: [],
};
const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
/** 合成展示图响应；像素头描述原文件而不是展示图。 */
function thumb() {
  return new Response('small-jpeg', {
    headers: {
      'content-type': 'image/jpeg',
      'x-original-width': '3840',
      'x-original-height': '2160',
    },
  });
}
beforeEach(() => {
  auth.persistAuthSession({
    user: {
      id: 'thumbnail-user',
      email: 'thumbnail@example.test',
      role: 'user',
      createdAt: '2026-01-01',
    },
  });
  let serial = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:preview-${++serial}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  auth.clearAuthSession();
  clearImageThumbnailCache();
  vi.restoreAllMocks();
  if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('缩略图展示与原文件隔离', () => {
  it('卡片只请求小图，首次Dialog预览与下载使用同一版本原文件', async () => {
    const fetch = vi.spyOn(auth, 'apiFetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/derivatives/thumbnail')) return thumb();
      if (String(url).endsWith('/access-url'))
        return Response.json({ url: `${asset.contentUrl}?access_token=synthetic` });
      if (String(url).endsWith('/versions/2/content'))
        return new Response('original-png-bytes', {
          headers: {
            'content-type': 'image/png',
            'content-disposition': 'attachment; filename="original.png"',
          },
        });
      throw new Error(`非预期测试请求 ${url}`);
    });
    const save = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
    const natural = vi.fn();
    render(
      <AssetPreview
        asset={{ ...asset, contentUrl: '/v1/assets/thumbnail-view/content' }}
        thumbnail
        mode="content"
        onNaturalSize={natural}
      />,
    );
    const image = await screen.findByRole('img', { name: asset.name });
    expect(image).toHaveAttribute('src', 'blob:preview-1');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(natural).toHaveBeenCalledWith(3840, 2160);
    Object.defineProperties(image, { naturalWidth: { value: 640 }, naturalHeight: { value: 360 } });
    fireEvent.load(image);
    expect(natural).not.toHaveBeenCalledWith(640, 360);
    fireEvent.click(screen.getByRole('button', { name: `预览图片：${asset.name}` }));
    const dialog = await screen.findByRole('dialog');
    const original = await within(dialog).findByAltText(asset.name);
    expect(original).toHaveAttribute(
      'src',
      `http://localhost:3000${asset.contentUrl}?access_token=synthetic`,
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/access-url'),
      expect.objectContaining({ body: JSON.stringify({ version: 2 }) }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '下载原文件' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].filename).toBe('original.png');
    expect(save.mock.calls[0][0].blob.type).toBe('image/png');
    const downloaded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(save.mock.calls[0][0].blob);
    });
    expect(downloaded).toBe('original-png-bytes');
  });
  it('同版本节点和资源栏共享展示图，卸载其中一个保留另一张', async () => {
    const fetch = vi.spyOn(auth, 'apiFetch').mockImplementation(async () => thumb());
    const view = render(
      <>
        <AssetPreview key="node" asset={asset} thumbnail mode="content" />
        <AssetPreview
          key="sidebar"
          asset={{ ...asset, contentUrl: '/v1/assets/thumbnail-view/content' }}
          thumbnail
        />
      </>,
    );
    const images = await screen.findAllByRole('img', { name: asset.name });
    expect(images).toHaveLength(2);
    expect(images[0].getAttribute('src')).toBe(images[1].getAttribute('src'));
    expect(fetch).toHaveBeenCalledTimes(1);
    view.rerender(
      <AssetPreview
        key="sidebar"
        asset={{ ...asset, contentUrl: '/v1/assets/thumbnail-view/content' }}
        thumbnail
      />,
    );
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
  it('切换版本立即移除旧图，迟到的旧响应不能覆盖新图', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi
      .spyOn(auth, 'apiFetch')
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      )
      .mockImplementation(async () => thumb());
    const view = render(<AssetPreview asset={asset} thumbnail mode="content" />);
    view.rerender(
      <AssetPreview
        asset={{
          ...asset,
          latestVersion: 3,
          contentUrl: '/v1/assets/thumbnail-view/versions/3/content',
        }}
        thumbnail
        mode="content"
      />,
    );
    await screen.findByRole('img', { name: asset.name });
    await act(async () => {
      resolve(thumb());
    });
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/versions/3/derivatives/thumbnail'),
      expect.anything(),
    );
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
  it('缩略图失败显示原因且不偷偷加载原文件；显式重试恢复', async () => {
    const fetch = vi
      .spyOn(auth, 'apiFetch')
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockImplementation(async () => thumb());
    render(<AssetPreview asset={asset} thumbnail mode="content" />);
    await screen.findByText('缩略图读取失败（503），原文件未受影响');
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('img', { name: asset.name })).toHaveAttribute(
      'src',
      'blob:preview-1',
    );
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/derivatives/thumbnail'))).toBe(
      true,
    );
  });
});
