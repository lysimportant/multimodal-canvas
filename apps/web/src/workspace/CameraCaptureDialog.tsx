import { useEffect, useRef, useState } from 'react';
import { Camera, RotateCcw, X } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@multimodal-canvas/ui';
import './CameraCaptureDialog.css';

/** 父层显式打开后才挂载；上传归属和引用保存由调用方负责。 */
type CameraCaptureDialogProps = {
  /** 取消或保存成功时关闭窗口；同一次挂载最多调用一次。 */
  onClose: () => void;
  /** 保存拍摄文件及引用；拒绝时保留原照片，只在用户点击后重试。 */
  onCapture: (file: File) => Promise<void>;
};

/** 相机与照片的互斥界面阶段；编码和保存期间不允许重复提交。 */
type CaptureStage = 'starting' | 'preview' | 'capturing' | 'photo' | 'saving' | 'error';

/** 同一张照片在保存重试时复用 File；预览 URL 只在本次窗口内有效。 */
type CapturedPhoto = { file: File; url: string };

/** 释放流中的全部轨道，也用于归还窗口关闭后才获批的流。 */
function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

/** 将浏览器设备错误转为可操作的中文说明，不把读取失败误报为权限拒绝。 */
function cameraError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return '无法获得摄像头权限，请在浏览器和系统设置中允许访问摄像头后重试。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '未找到可用摄像头，请连接设备后重试。';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return '摄像头被占用或无法读取，请关闭其他使用摄像头的应用后重试。';
    default:
      return '无法启动摄像头，请检查设备和浏览器设置后重试。';
  }
}

/**
 * 独立拍照窗口：挂载时仅申请视频，确认后才调用父层上传与引用保存。
 * @param props 关闭及保存回调；回调更新不重新申请设备。
 * @returns 由共享 Dialog 托管的模态窗口，不改变画布节点尺寸。
 * @remarks 拍到画面即停流。关闭与卸载使迟到结果失效，但不能撤回父层已发出的保存请求。
 */
export function CameraCaptureDialog({ onClose, onCapture }: CameraCaptureDialogProps) {
  const [open, setOpen] = useState(true);
  const [stage, setStage] = useState<CaptureStage>('starting');
  const [frameReady, setFrameReady] = useState(false);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const photoRef = useRef<CapturedPhoto | null>(null);
  const mounted = useRef(false);
  const closed = useRef(false);
  const operation = useRef(0);
  const capturing = useRef(false);
  const saving = useRef(false);
  const callbacks = useRef({ onClose, onCapture });
  callbacks.current = { onClose, onCapture };

  /** 操作编号隔离重拍、StrictMode 重挂载和关闭后的异步返回。 */
  function isCurrent(id: number) {
    return mounted.current && !closed.current && operation.current === id;
  }

  /** 清除预览引用并立即停流；重复清理不会再次停止已归还的轨道。 */
  function stopCamera() {
    const stream = streamRef.current;
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (stream) stopStream(stream);
  }

  /** 撤销本地照片 URL；不会删除父层已保存的文件或引用。 */
  function releasePhoto() {
    if (photoRef.current) URL.revokeObjectURL(photoRef.current.url);
    photoRef.current = null;
  }

  /** play 完成不等于首帧可读；媒体事件只更新就绪状态，绝不重新申请设备。 */
  function updateFrameReadiness() {
    const video = videoRef.current;
    if (!mounted.current || closed.current || !streamRef.current || !video) return;
    const ready = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
    setFrameReady(ready);
    setError(
      video.readyState >= 2 && !ready
        ? '摄像头画面尺寸为 0，暂时无法拍照，请等待画面就绪或重试相机。'
        : null,
    );
  }

  /** 在通知父层之前同步作废所有回调，防止保存成功再次关闭后方界面。 */
  function closeDialog() {
    if (closed.current || !mounted.current) return;
    closed.current = true;
    operation.current += 1;
    stopCamera();
    releasePhoto();
    setPhoto(null);
    setOpen(false);
    callbacks.current.onClose();
  }

  /** 首次挂载或显式重拍/重试时申请相机；迟到授权只释放设备，不恢复窗口。 */
  async function startCamera() {
    if (!mounted.current || closed.current || saving.current) return;
    const id = ++operation.current;
    stopCamera();
    releasePhoto();
    capturing.current = false;
    setPhoto(null);
    setError(null);
    setFrameReady(false);
    setStage('starting');
    if (!window.isSecureContext) {
      setError('当前页面不是安全上下文，请使用 HTTPS 或 localhost 打开后再拍照。');
      setStage('error');
      return;
    }
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      setError('当前浏览器不支持摄像头拍照，请使用支持此功能的浏览器。');
      setStage('error');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (cause) {
      if (isCurrent(id)) {
        setError(cameraError(cause));
        setStage('error');
      }
      return;
    }
    if (!isCurrent(id)) {
      stopStream(stream);
      return;
    }
    streamRef.current = stream;
    try {
      const video = videoRef.current;
      if (!video) throw new Error('预览区域未挂载');
      video.srcObject = stream;
      await video.play();
      if (isCurrent(id)) {
        updateFrameReadiness();
        setStage('preview');
      }
    } catch {
      if (!isCurrent(id)) return;
      stopCamera();
      setError('无法播放摄像头预览，请检查浏览器设置后重新启动相机。');
      setStage('error');
    }
  }

  useEffect(() => {
    mounted.current = true;
    void startCamera();
    /** 捕获阶段消费本层 Escape，阻止嵌套编辑器及 window 画布快捷键同时关闭。 */
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing || closed.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDialog();
    }
    window.addEventListener('keydown', handleEscape, true);
    return () => {
      mounted.current = false;
      operation.current += 1;
      window.removeEventListener('keydown', handleEscape, true);
      stopCamera();
      releasePhoto();
    };
  }, []);

  /** 拷贝当前原始分辨率画面后立即停流；编码失败只提供显式重拍，不自动重开相机。 */
  async function takePhoto() {
    const video = videoRef.current;
    if (!video || !streamRef.current || capturing.current || stage !== 'preview') return;
    const id = ++operation.current;
    capturing.current = true;
    setStage('capturing');
    setError(null);
    try {
      if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
        throw new Error('摄像头画面尚未准备好，无法拍照，请重新启动相机后重试。');
      }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('当前浏览器无法读取摄像头画面，请更换浏览器后重试。');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      stopCamera();
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.92),
      );
      if (!isCurrent(id)) return;
      if (!blob?.size) throw new Error('照片编码失败，未获得有效图片，请重新拍照。');
      const extension = blob.type === 'image/png' ? 'png' : 'jpg';
      const file = new File([blob], 'camera-' + Date.now() + '.' + extension, {
        type: blob.type || 'image/jpeg',
      });
      const capturedPhoto = { file, url: URL.createObjectURL(file) };
      photoRef.current = capturedPhoto;
      setPhoto(capturedPhoto);
      setStage('photo');
    } catch (cause) {
      if (!isCurrent(id)) return;
      stopCamera();
      setError(cause instanceof Error ? '拍照失败：' + cause.message : '拍照失败，请重新拍照。');
      setStage('error');
    } finally {
      if (isCurrent(id)) capturing.current = false;
    }
  }

  /** 用户确认后交给父层保存；失败复用同一 File，关闭后的完成结果不再触发 onClose。 */
  async function usePhoto() {
    const capturedPhoto = photoRef.current;
    const id = operation.current;
    if (!capturedPhoto || saving.current || !isCurrent(id)) return;
    saving.current = true;
    setStage('saving');
    setError(null);
    try {
      await callbacks.current.onCapture(capturedPhoto.file);
    } catch (cause) {
      if (isCurrent(id)) {
        const detail = cause instanceof Error && cause.message ? '：' + cause.message : '';
        setError('照片保存失败' + detail + '。照片已保留，请点击“使用照片”重试。');
        setStage('photo');
      }
      return;
    } finally {
      saving.current = false;
    }
    if (isCurrent(id)) closeDialog();
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closeDialog()}>
      <DialogContent
        className="camera-capture-dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="camera-capture-dialog-header">
          <DialogTitle>
            <Camera size={20} aria-hidden="true" />
            拍照
          </DialogTitle>
          <Button type="button" className="icon-button" aria-label="关闭拍照" onClick={closeDialog}>
            <X size={18} aria-hidden="true" />
          </Button>
        </header>
        <DialogDescription className="camera-capture-dialog-description">
          仅使用摄像头，不录音；拍照后关闭摄像头，确认后保存为引用图片。
        </DialogDescription>
        <div className="camera-capture-dialog-body">
          <div className="camera-capture-dialog-preview">
            <video
              ref={videoRef}
              aria-label="摄像头预览"
              muted
              playsInline
              onLoadedData={updateFrameReadiness}
              onCanPlay={updateFrameReadiness}
              onResize={updateFrameReadiness}
              onEmptied={updateFrameReadiness}
              hidden={!!photo || stage === 'error'}
            />
            {photo && <img src={photo.url} alt="拍摄的照片" />}
            {stage === 'error' && (
              <span className="camera-capture-dialog-placeholder">暂无相机画面</span>
            )}
          </div>
          <p className="camera-capture-dialog-status" role="status">
            {stage === 'starting' && '正在启动摄像头，请在浏览器提示中允许访问…'}
            {stage === 'preview' &&
              (frameReady ? '调整画面后点击“拍照”。' : '正在等待摄像头画面就绪…')}
            {stage === 'capturing' && '正在处理照片，摄像头已关闭…'}
            {stage === 'photo' && '摄像头已关闭。可使用这张照片，或重新拍摄。'}
            {stage === 'saving' && '正在保存照片…关闭窗口不会撤回已经提交的保存请求。'}
            {stage === 'error' && '相机未开启，可检查设置后重试。'}
          </p>
          {error && (
            <p className="camera-capture-dialog-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="camera-capture-dialog-actions">
          <Button type="button" className="button button-secondary" onClick={closeDialog}>
            取消
          </Button>
          <div>
            {stage === 'preview' && error && (
              <Button
                type="button"
                className="button button-secondary"
                onClick={() => void startCamera()}
              >
                重试相机
              </Button>
            )}
            {photo && (
              <Button
                type="button"
                className="button button-secondary"
                disabled={stage === 'saving'}
                onClick={() => void startCamera()}
              >
                <RotateCcw size={16} aria-hidden="true" />
                重拍
              </Button>
            )}
            {photo ? (
              <Button
                type="button"
                className="button button-primary"
                disabled={stage === 'saving'}
                onClick={() => void usePhoto()}
              >
                {stage === 'saving' ? '保存中…' : '使用照片'}
              </Button>
            ) : stage === 'error' ? (
              <Button
                type="button"
                className="button button-primary"
                onClick={() => void startCamera()}
              >
                重试相机
              </Button>
            ) : (
              <Button
                type="button"
                className="button button-primary"
                disabled={stage !== 'preview' || !frameReady}
                onClick={() => void takePhoto()}
              >
                <Camera size={16} aria-hidden="true" />
                拍照
              </Button>
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
