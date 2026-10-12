import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Asset } from '@multimodal-canvas/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoRecreationSourcePicker } from './VideoRecreationSourcePicker';

afterEach(cleanup);

/** 构造可用的视频资源，覆盖字段用于验证候选和冻结版本边界。 */
function videoAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    name: id,
    mediaType: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 1024,
    latestVersion: 2,
    status: 'ready',
    contentUrl: `/v1/assets/${id}/versions/2/content`,
    tags: [],
    ...overrides,
  };
}

describe('VideoRecreationSourcePicker', () => {
  it('只列出就绪视频并禁用版本未知的候选；选择不自动绑定', async () => {
    const onBind = vi.fn();
    render(
      <VideoRecreationSourcePicker
        assets={[
          videoAsset('完整视频', { latestVersion: 3, metadata: { durationSeconds: 12.5 } }),
          videoAsset('版本未知', { latestVersion: undefined }),
          videoAsset('已归档', { status: 'archived' }),
          videoAsset('图片', { mediaType: 'image', mimeType: 'image/png' }),
        ]}
        onBind={onBind}
      />,
    );

    const source = screen.getByRole('combobox', { name: '参考视频' });
    expect(within(source).getByRole('option', { name: '完整视频 · v3' })).toBeEnabled();
    expect(within(source).getByRole('option', { name: '版本未知（版本未知）' })).toBeDisabled();
    expect(within(source).queryByRole('option', { name: /已归档|图片/ })).not.toBeInTheDocument();
    const bind = screen.getByRole('button', { name: '使用此视频' });
    expect(bind).toBeDisabled();
    expect(onBind).not.toHaveBeenCalled();

    await userEvent.selectOptions(source, '完整视频');
    expect(bind).toBeEnabled();
    expect(onBind).not.toHaveBeenCalled();
    await userEvent.click(bind);
    await waitFor(() =>
      expect(onBind).toHaveBeenCalledExactlyOnceWith({
        version: 1,
        source: {
          assetId: '完整视频',
          assetVersion: 3,
          name: '完整视频',
          durationSeconds: 12.5,
        },
        bindings: [],
      }),
    );
  });

  it('上传后仅绑定返回的明确版本，不自动分析或生成', async () => {
    const file = new File(['video'], 'source.mp4', { type: 'video/mp4' });
    const onUploadResource = vi.fn().mockResolvedValue(
      videoAsset('uploaded', {
        name: '上传的视频',
        latestVersion: 5,
        contentUrl: '/v1/assets/uploaded/versions/5/content',
      }),
    );
    const onBind = vi.fn();
    render(<VideoRecreationSourcePicker onUploadResource={onUploadResource} onBind={onBind} />);

    expect(screen.getByRole('button', { name: '使用此视频' })).toBeDisabled();
    expect(onUploadResource).not.toHaveBeenCalled();
    expect(onBind).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('上传参考视频'), { target: { files: [file] } });

    await waitFor(() => expect(onUploadResource).toHaveBeenCalledExactlyOnceWith(file));
    await waitFor(() =>
      expect(onBind).toHaveBeenCalledExactlyOnceWith({
        version: 1,
        source: { assetId: 'uploaded', assetVersion: 5, name: '上传的视频' },
        bindings: [],
      }),
    );
    expect(screen.getByLabelText('上传参考视频')).toBeEnabled();
  });

  it('上传返回没有版本的视频时明确报错，不保存不确定的来源', async () => {
    const onBind = vi.fn();
    const onUploadResource = vi
      .fn()
      .mockResolvedValue(videoAsset('unknown-version', { latestVersion: undefined }));
    render(<VideoRecreationSourcePicker onUploadResource={onUploadResource} onBind={onBind} />);

    fireEvent.change(screen.getByLabelText('上传参考视频'), {
      target: { files: [new File(['video'], 'source.mp4', { type: 'video/mp4' })] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '无法确认视频版本，请刷新资源后重试',
    );
    expect(onBind).not.toHaveBeenCalled();
    expect(screen.getByLabelText('上传参考视频')).toBeEnabled();
  });

  it('保存失败时保留已选来源并显示错误，不自行重试', async () => {
    const onBind = vi.fn().mockRejectedValue(new Error('保存参考视频失败'));
    render(<VideoRecreationSourcePicker assets={[videoAsset('clip')]} onBind={onBind} />);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: '参考视频' }), 'clip');
    await userEvent.click(screen.getByRole('button', { name: '使用此视频' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存参考视频失败');
    expect(screen.getByRole('combobox', { name: '参考视频' })).toHaveValue('clip');
    expect(screen.getByRole('button', { name: '使用此视频' })).toBeEnabled();
    expect(onBind).toHaveBeenCalledTimes(1);
  });
});
