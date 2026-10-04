import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import { ResourceMentionEditor } from './ResourceMentionEditor';

/** 相机设备生命周期由组件自己的测试验证；这里只检查上传到节点引用的归属。 */
const camera = vi.hoisted(() => ({
  props: undefined as undefined | { onClose: () => void; onCapture: (file: File) => Promise<void> },
}));
vi.mock('./workspace/CameraCaptureDialog', () => ({
  CameraCaptureDialog: (props: NonNullable<typeof camera.props>) => {
    camera.props = props;
    return (
      <div role="dialog" aria-label="拍照引用">
        <button onClick={props.onClose}>关闭拍照</button>
      </div>
    );
  },
}));
/** 上传完成后的明确版本，不使用本地 base64 代替资源。 */
const photo: Asset = {
  id: 'camera-photo',
  name: '拍摄照片.jpg',
  mediaType: 'image',
  mimeType: 'image/jpeg',
  sizeBytes: 128,
  status: 'ready',
  latestVersion: 4,
  contentUrl: '/v1/assets/camera-photo/versions/4/content',
  tags: [],
};
/** 手动完成上传以覆盖取消和切换节点后的迟到返回。 */
function pendingUpload() {
  let resolve!: (asset: Asset) => void;
  const promise = new Promise<Asset>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  camera.props = undefined;
  vi.restoreAllMocks();
});

describe('拍照上传引用归属', () => {
  it('只有点击才打开相机，使用照片才上传，成功添加冻结版本而非新建节点', async () => {
    const onDocumentChange = vi.fn();
    const upload = vi.fn(async () => photo);
    render(
      <ResourceMentionEditor
        nodeId="a"
        value="保持人物 "
        ariaLabel="提示词"
        onUploadResource={upload}
        onDocumentChange={onDocumentChange}
        assets={[photo]}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '拍照引用' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(upload).not.toHaveBeenCalled();
    const file = new File(['photo'], '拍摄照片.jpg', { type: 'image/jpeg' });
    await act(() => camera.props!.onCapture(file));
    expect(upload).toHaveBeenCalledExactlyOnceWith(file);
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mention',
          assetId: photo.id,
          assetVersion: 4,
          mediaType: 'image',
        }),
      ]),
    );
    expect(screen.getByRole('article', { name: '参考资源 1：拍摄照片' })).toBeVisible();
  });

  it('关闭未确认的相机不上传，未配置上传时保留禁用入口', () => {
    const upload = vi.fn();
    const view = render(<ResourceMentionEditor nodeId="a" onUploadResource={upload} />);
    fireEvent.click(screen.getByRole('button', { name: '拍照引用' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭拍照' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
    view.rerender(<ResourceMentionEditor nodeId="a" />);
    expect(screen.getByRole('button', { name: '拍照引用' })).toBeDisabled();
  });

  it.each(['关闭窗口', '切换节点', '卸载编辑器', '关闭后重新打开'] as const)(
    '%s 后的迟到上传不能写入旧或新节点',
    async (action) => {
      const gate = pendingUpload();
      const change = vi.fn();
      const props = { onUploadResource: vi.fn(() => gate.promise), onDocumentChange: change };
      const view = render(<ResourceMentionEditor nodeId="a" {...props} />);
      fireEvent.click(screen.getByRole('button', { name: '拍照引用' }));
      let operation!: Promise<void>;
      act(() => {
        operation = camera.props!.onCapture(new File(['photo'], 'photo.jpg'));
      });
      if (action === '切换节点') view.rerender(<ResourceMentionEditor nodeId="b" {...props} />);
      else if (action === '卸载编辑器') view.unmount();
      else {
        fireEvent.click(screen.getByRole('button', { name: '关闭拍照' }));
        if (action === '关闭后重新打开')
          fireEvent.click(screen.getByRole('button', { name: '拍照引用' }));
      }
      await act(async () => {
        gate.resolve(photo);
        await operation;
      });
      expect(change).not.toHaveBeenCalled();
    },
  );

  it('上传失败传回相机供显式重试，不自动上传或写入空引用', async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('资源上传失败'))
      .mockResolvedValueOnce(photo);
    const change = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="a"
        onUploadResource={upload}
        onDocumentChange={change}
        assets={[photo]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '拍照引用' }));
    const file = new File(['photo'], 'photo.jpg');
    await act(async () => {
      await expect(camera.props!.onCapture(file)).rejects.toThrow('资源上传失败');
    });
    expect(change).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(1);
    await act(() => camera.props!.onCapture(file));
    await waitFor(() => expect(change).toHaveBeenCalledOnce());
  });
});
