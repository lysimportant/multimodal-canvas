import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import { AssetCompression } from './AssetCompression';
import * as downloads from './node-asset-download';
import * as compression from './lossless-png';
import * as jpegCompression from './lossless-jpeg';
import * as exports from '../export-utils';

const asset: Asset = {
  id: 'synthetic',
  name: '图片.png',
  mimeType: 'image/png',
  mediaType: 'image',
  sizeBytes: 2048,
  contentUrl: '/v1/assets/synthetic/versions/2/content',
  latestVersion: 2,
  status: 'ready',
  tags: [],
};
afterEach(cleanup);

describe('压缩副本', () => {
  it('JPG 使用无损优化并保留 JPG 扩展名', async () => {
    vi.spyOn(downloads, 'fetchNodeAssetDownload').mockResolvedValue({
      blob: new Blob(['jpeg']),
      filename: '照片.jpeg',
    });
    const blob = new Blob(['jpg']);
    const jpeg = vi
      .spyOn(jpegCompression, 'compressJpegLosslessly')
      .mockResolvedValue({ blob, originalBytes: 4, compressedBytes: 3, improved: true });
    const save = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
    render(<AssetCompression asset={{ ...asset, mimeType: 'image/jpeg' }} />);
    fireEvent.click(screen.getByRole('button', { name: '无损压缩副本' }));
    await screen.findByRole('status');
    expect(jpeg).toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({ blob, filename: '照片-无损压缩.jpeg' });
  });

  it('不支持的图片格式明确说明支持范围', () => {
    render(<AssetCompression asset={{ ...asset, mimeType: 'image/webp' }} />);
    expect(screen.getByText('暂支持 PNG、JPG 无损压缩')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('按当前版本下载并保存独立文件名，展示实际大小', async () => {
    const fetcher = vi
      .spyOn(downloads, 'fetchNodeAssetDownload')
      .mockResolvedValue({ blob: new Blob(['original']), filename: '图片.png' });
    const blob = new Blob(['compressed']);
    vi.spyOn(compression, 'compressPngLosslessly').mockResolvedValue({
      blob,
      originalBytes: 2048,
      compressedBytes: 1024,
      improved: true,
    });
    const save = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
    render(<AssetCompression asset={asset} />);
    fireEvent.click(screen.getByRole('button', { name: '无损压缩副本' }));
    expect(await screen.findByRole('status')).toHaveTextContent('节省 50.0%');
    expect(fetcher).toHaveBeenCalledWith(asset, expect.any(AbortSignal), 32 * 1024 * 1024);
    expect(save).toHaveBeenCalledWith({ blob, filename: '图片-无损压缩.png' });
  });

  it('无收益不触发保存，错误允许重试', async () => {
    vi.spyOn(downloads, 'fetchNodeAssetDownload').mockResolvedValue({
      blob: new Blob(['original']),
      filename: '图片.png',
    });
    vi.spyOn(compression, 'compressPngLosslessly')
      .mockRejectedValueOnce(new Error('文件损坏'))
      .mockResolvedValueOnce({
        blob: new Blob(),
        originalBytes: 7,
        compressedBytes: 7,
        improved: false,
      });
    const save = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
    render(<AssetCompression asset={asset} />);
    fireEvent.click(screen.getByRole('button', { name: '无损压缩副本' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('文件损坏');
    fireEvent.click(screen.getByRole('button', { name: '无损压缩副本' }));
    expect(await screen.findByRole('status')).toHaveTextContent('未减小体积');
    expect(save).not.toHaveBeenCalled();
  });

  it('取消或关闭后，晚到的压缩结果不下载', async () => {
    let complete!: (result: Awaited<ReturnType<typeof compression.compressPngLosslessly>>) => void;
    vi.spyOn(downloads, 'fetchNodeAssetDownload').mockResolvedValue({
      blob: new Blob(['original']),
      filename: '图片.png',
    });
    const compress = vi.spyOn(compression, 'compressPngLosslessly').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const save = vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
    const { unmount } = render(<AssetCompression asset={asset} />);
    fireEvent.click(screen.getByRole('button', { name: '无损压缩副本' }));
    await waitFor(() => expect(compress).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '取消压缩' }));
    expect(compress.mock.calls[0]![1]!.aborted).toBe(true);
    unmount();
    complete({ blob: new Blob(['x']), originalBytes: 7, compressedBytes: 1, improved: true });
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
  });
});
