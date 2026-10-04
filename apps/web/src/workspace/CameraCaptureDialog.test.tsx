import '@testing-library/jest-dom/vitest';
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '@multimodal-canvas/ui';
import { CameraCaptureDialog } from './CameraCaptureDialog';

/** 手动控制授权、播放、编码及保存的返回顺序，不访问真实设备或服务。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 用两个轨道检查 getTracks 全量释放，而不只释放首条视频轨道。 */
function mockStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { tracks, stream: { getTracks: () => tracks } as unknown as MediaStream };
}

/** 记录父层操作；仅使用照片时允许触发保存。 */
function callbacks() {
  return {
    onClose: vi.fn(),
    onCapture: vi.fn<(file: File) => Promise<void>>().mockResolvedValue(undefined),
  };
}

/** 等待预览后显式拍照，返回的文件仍需用户确认才会保存。 */
async function capturePhoto() {
  await waitFor(() => expect(screen.getByRole('button', { name: '拍照' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '拍照' }));
  await screen.findByRole('img', { name: '拍摄的照片' });
}

/** 保存原属性描述，测试后恢复浏览器对象，避免干扰其他组件。 */
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
/** 每次测试都替换设备申请接口，绝不保留真实 getUserMedia。 */
const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>();
/** 记录内存 URL 的创建和撤销；不生成真实外部地址。 */
const createObjectURL = vi.fn(() => 'blob:camera-test-photo');
const revokeObjectURL = vi.fn();
/** 记录绘制原始分辨率画面，避免 jsdom 的未实现 canvas 接口。 */
const drawImage = vi.fn();
/** 当前用例独占的模拟流。 */
let device: ReturnType<typeof mockStream>;

beforeEach(() => {
  device = mockStream();
  getUserMedia.mockReset().mockResolvedValue(device.stream);
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  drawImage.mockReset();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
    callback(new Blob(['photo'], { type: 'image/jpeg' })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('独立拍照窗口', () => {
  it('仅挂载时申请视频，回调变化不重启设备，确认时使用最新回调', async () => {
    const first = callbacks();
    const latest = callbacks();
    const view = render(<></>);
    expect(getUserMedia).not.toHaveBeenCalled();
    view.rerender(<CameraCaptureDialog {...first} />);
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce());
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: true, audio: false });
    await waitFor(() => expect(screen.getByRole('dialog', { name: '拍照' })).toBeVisible());
    const video = screen.getByLabelText('摄像头预览') as HTMLVideoElement;
    expect(video.muted).toBe(true);
    expect(video).toHaveAttribute('playsinline');
    view.rerender(<CameraCaptureDialog {...latest} />);
    expect(getUserMedia).toHaveBeenCalledOnce();
    await capturePhoto();
    expect(latest.onCapture).not.toHaveBeenCalled();
    expect(first.onCapture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '使用照片' }));
    await waitFor(() => expect(latest.onClose).toHaveBeenCalledOnce());
    expect(latest.onCapture).toHaveBeenCalledOnce();
    expect(first.onClose).not.toHaveBeenCalled();
  });

  it.each(['关闭拍照', '取消', 'Escape', '遮罩'])(
    '待授权时%s，晚返回的所有轨道立即释放且不播放',
    async (action) => {
      const gate = deferred<MediaStream>();
      const actions = callbacks();
      getUserMedia.mockReturnValue(gate.promise);
      render(<CameraCaptureDialog {...actions} />);
      if (action === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
      else if (action === '遮罩') {
        const mask = document.querySelector('.ant-modal-wrap')!;
        fireEvent.mouseDown(mask);
        fireEvent.click(mask);
      } else fireEvent.click(screen.getByRole('button', { name: action }));
      expect(actions.onClose).toHaveBeenCalledOnce();
      await act(async () => gate.resolve(device.stream));
      for (const track of device.tracks) expect(track.stop).toHaveBeenCalledOnce();
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      expect(actions.onCapture).not.toHaveBeenCalled();
      expect(actions.onClose).toHaveBeenCalledOnce();
    },
  );

  it.each(['授权前', '预览中'])('%s 卸载会释放流，不调用父层关闭', async (phase) => {
    const gate = deferred<MediaStream>();
    const actions = callbacks();
    getUserMedia.mockReturnValue(gate.promise);
    const view = render(<CameraCaptureDialog {...actions} />);
    if (phase === '预览中') await act(async () => gate.resolve(device.stream));
    view.unmount();
    if (phase === '授权前') await act(async () => gate.resolve(device.stream));
    for (const track of device.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(actions.onClose).not.toHaveBeenCalled();
    expect(actions.onCapture).not.toHaveBeenCalled();
  });

  it('取帧后在编码完成前停流，只有确认才上传原始尺寸 JPEG File', async () => {
    let finish!: BlobCallback;
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) => {
      finish = callback;
    });
    const actions = callbacks();
    render(<CameraCaptureDialog {...actions} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '拍照' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '拍照' }));
    expect(drawImage).toHaveBeenCalledWith(screen.getByLabelText('摄像头预览'), 0, 0, 1280, 720);
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/jpeg',
      0.92,
    );
    for (const track of device.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(actions.onCapture).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    await act(async () => finish(new Blob(['jpeg-data'], { type: 'image/jpeg' })));
    expect(screen.getByRole('img', { name: '拍摄的照片' })).toHaveAttribute(
      'src',
      'blob:camera-test-photo',
    );
    expect(actions.onCapture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '使用照片' }));
    await waitFor(() => expect(actions.onClose).toHaveBeenCalledOnce());
    const file = actions.onCapture.mock.calls[0]![0];
    expect(file).toBeInstanceOf(File);
    expect(file.name).toMatch(/^camera-[0-9]+[.]jpg$/);
    expect(file.type).toBe('image/jpeg');
    expect(file.size).toBe(9);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:camera-test-photo');
  });

  it('上传失败保留同一照片，显式重试不重复拍摄或申请摄像头', async () => {
    const actions = callbacks();
    actions.onCapture.mockRejectedValueOnce(new Error('上传连接中断'));
    render(<CameraCaptureDialog {...actions} />);
    await capturePhoto();
    fireEvent.click(screen.getByRole('button', { name: '使用照片' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('照片保存失败：上传连接中断');
    expect(screen.getByRole('img', { name: '拍摄的照片' })).toBeVisible();
    expect(actions.onClose).not.toHaveBeenCalled();
    expect(actions.onCapture).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '使用照片' }));
    await waitFor(() => expect(actions.onClose).toHaveBeenCalledOnce());
    expect(actions.onCapture).toHaveBeenCalledTimes(2);
    expect(actions.onCapture.mock.calls[0]![0]).toBe(actions.onCapture.mock.calls[1]![0]);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledOnce();
  });

  it('重拍显式重启相机并撤销旧 URL，卸载同时释放新照片 URL', async () => {
    const second = mockStream();
    getUserMedia.mockResolvedValueOnce(device.stream).mockResolvedValueOnce(second.stream);
    createObjectURL.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
    const view = render(<CameraCaptureDialog {...callbacks()} />);
    await capturePhoto();
    expect(getUserMedia).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '重拍' }));
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:first');
    await capturePhoto();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    for (const track of second.tracks) expect(track.stop).toHaveBeenCalledOnce();
    view.unmount();
    expect(revokeObjectURL.mock.calls).toEqual([['blob:first'], ['blob:second']]);
  });

  it.each(['关闭', '卸载'])('toBlob 待返回时%s，忽略迟到照片且不创建 URL', async (action) => {
    let finish!: BlobCallback;
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) => {
      finish = callback;
    });
    const actions = callbacks();
    const view = render(<CameraCaptureDialog {...actions} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '拍照' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '拍照' }));
    if (action === '关闭') fireEvent.click(screen.getByRole('button', { name: '关闭拍照' }));
    else view.unmount();
    await act(async () => finish(new Blob(['late'], { type: 'image/jpeg' })));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(actions.onCapture).not.toHaveBeenCalled();
    expect(actions.onClose).toHaveBeenCalledTimes(action === '关闭' ? 1 : 0);
    for (const track of device.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each(['关闭成功', '关闭失败', '卸载成功'])(
    '保存期间%s，不重复提交且不晚调用 onClose',
    async (action) => {
      const gate = deferred<void>();
      const actions = callbacks();
      actions.onCapture.mockReturnValue(gate.promise);
      const view = render(<CameraCaptureDialog {...actions} />);
      await capturePhoto();
      const useButton = screen.getByRole('button', { name: '使用照片' });
      fireEvent.click(useButton);
      fireEvent.click(useButton);
      expect(actions.onCapture).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '重拍' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
      if (action === '卸载成功') view.unmount();
      else fireEvent.click(screen.getByRole('button', { name: '关闭拍照' }));
      await act(async () => {
        if (action === '关闭失败') gate.reject(new Error('迟到上传错误'));
        else gate.resolve(undefined);
      });
      expect(actions.onClose).toHaveBeenCalledTimes(action === '卸载成功' ? 0 : 1);
      expect(revokeObjectURL).toHaveBeenCalledOnce();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it.each([
    ['NotAllowedError', '摄像头权限'],
    ['NotFoundError', '未找到可用摄像头'],
    ['NotReadableError', '摄像头被占用'],
    ['AbortError', '摄像头被占用'],
    ['UnknownError', '无法启动摄像头'],
  ])('%s 有中文错误，只在显式重试后重新申请', async (name, message) => {
    getUserMedia.mockRejectedValueOnce(new DOMException('device error', name));
    render(<CameraCaptureDialog {...callbacks()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(message!);
    expect(getUserMedia).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '重试相机' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '拍照' })).toBeEnabled());
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['非安全上下文', '浏览器不支持'])('%s 时不申请设备并明确提示', async (reason) => {
    if (reason === '非安全上下文') vi.stubGlobal('isSecureContext', false);
    else Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    render(<CameraCaptureDialog {...callbacks()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      reason === '非安全上下文' ? '安全上下文' : '不支持摄像头拍照',
    );
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('预览 play 失败释放所有轨道，不能拍照且不自动重启', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('play blocked'));
    render(<CameraCaptureDialog {...callbacks()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('无法播放摄像头预览');
    for (const track of device.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '拍照' })).not.toBeInTheDocument();
  });

  it.each(['成功', '失败'])('关闭后的 play %s 不恢复窗口或再次关闭', async (outcome) => {
    const gate = deferred<void>();
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(gate.promise);
    const actions = callbacks();
    render(<CameraCaptureDialog {...actions} />);
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await act(async () =>
      outcome === '成功' ? gate.resolve(undefined) : gate.reject(new Error('late play')),
    );
    expect(actions.onClose).toHaveBeenCalledOnce();
    expect(actions.onCapture).not.toHaveBeenCalled();
    for (const track of device.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['零尺寸', '无当前帧', '无绘图上下文', '绘制异常', '空 Blob', '零字节 Blob', '编码异常'])(
    '%s 拍摄失败会停流并支持手动重试',
    async (reason) => {
      if (reason === '无绘图上下文')
        vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
      if (reason === '绘制异常')
        drawImage.mockImplementation(() => {
          throw new Error('无法读取当前画面');
        });
      if (reason === '空 Blob')
        vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) =>
          callback(null),
        );
      if (reason === '零字节 Blob')
        vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) =>
          callback(new Blob()),
        );
      if (reason === '编码异常')
        vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(() => {
          throw new Error('无法编码照片');
        });
      const actions = callbacks();
      render(<CameraCaptureDialog {...actions} />);
      await waitFor(() => expect(screen.getByRole('button', { name: '拍照' })).toBeEnabled());
      if (reason === '零尺寸')
        vi.mocked(
          Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoWidth')!.get!,
        ).mockReturnValue(0);
      if (reason === '无当前帧')
        vi.mocked(
          Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState')!.get!,
        ).mockReturnValue(1);
      fireEvent.click(screen.getByRole('button', { name: '拍照' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('拍照失败');
      for (const track of device.tracks) expect(track.stop).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: '重试相机' })).toBeEnabled();
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(actions.onCapture).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
    },
  );

  it('首帧未加载或 loadeddata 仍为零尺寸时禁用拍照，画面就绪不重启相机', async () => {
    const width = vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(0);
    const ready = vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(1);
    render(<CameraCaptureDialog {...callbacks()} />);
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce());
    const shoot = screen.getByRole('button', { name: '拍照' });
    expect(shoot).toBeDisabled();
    const video = screen.getByLabelText('摄像头预览');
    ready.mockReturnValue(2);
    fireEvent.loadedData(video);
    expect(shoot).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('画面尺寸为 0');
    expect(getUserMedia).toHaveBeenCalledOnce();
    width.mockReturnValue(1280);
    fireEvent.loadedData(video);
    await waitFor(() => expect(shoot).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(HTMLCanvasElement.prototype.toBlob).not.toHaveBeenCalled();
    for (const track of device.tracks) expect(track.stop).not.toHaveBeenCalled();
  });

  it('StrictMode 重挂载隔离旧授权，旧流不能顶替当前预览', async () => {
    const first = deferred<MediaStream>();
    const second = mockStream();
    getUserMedia.mockReturnValueOnce(first.promise).mockResolvedValueOnce(second.stream);
    const view = render(
      <StrictMode>
        <CameraCaptureDialog {...callbacks()} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '拍照' })).toBeEnabled());
    await act(async () => first.resolve(device.stream));
    for (const track of device.tracks) expect(track.stop).toHaveBeenCalledOnce();
    for (const track of second.tracks) expect(track.stop).not.toHaveBeenCalled();
    expect((screen.getByLabelText('摄像头预览') as HTMLVideoElement).srcObject).toBe(second.stream);
    view.unmount();
    for (const track of second.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each(['窗口', '拍照按钮'])(
    '从%s 发出的 Escape 只关闭相机，不关闭嵌套完整编辑器或传播到画布',
    async (target) => {
      const outerClose = vi.fn();
      const canvasEscape = vi.fn();
      const cameraClose = vi.fn();
      /** 保留真实 Dialog 嵌套和条件卸载，模拟完整编辑器中的共享入口。 */
      function NestedEditor() {
        const [show, setShow] = useState(true);
        return (
          <Dialog open onOpenChange={outerClose}>
            <DialogContent>
              <DialogTitle>完整编辑器</DialogTitle>
              {show && (
                <CameraCaptureDialog
                  onClose={() => {
                    cameraClose();
                    setShow(false);
                  }}
                  onCapture={async () => {}}
                />
              )}
            </DialogContent>
          </Dialog>
        );
      }
      window.addEventListener('keydown', canvasEscape);
      const view = render(<NestedEditor />);
      try {
        await waitFor(() => expect(screen.getByRole('button', { name: '拍照' })).toBeEnabled());
        fireEvent.keyDown(
          target === '窗口' ? window : screen.getByRole('button', { name: '拍照' }),
          { key: 'Escape' },
        );
        expect(cameraClose).toHaveBeenCalledOnce();
        expect(outerClose).not.toHaveBeenCalled();
        expect(canvasEscape).not.toHaveBeenCalled();
        await waitFor(() =>
          expect(screen.getByRole('dialog', { name: '完整编辑器' })).toBeVisible(),
        );
        expect(screen.queryByRole('dialog', { name: '拍照' })).not.toBeInTheDocument();
        view.unmount();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(canvasEscape).toHaveBeenCalledOnce();
      } finally {
        window.removeEventListener('keydown', canvasEscape);
      }
    },
  );
});
