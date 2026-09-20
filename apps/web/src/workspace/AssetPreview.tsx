import {
  AudioLines,
  Copy,
  Download,
  Expand,
  FileText,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type { Asset, MediaType } from '@multimodal-canvas/domain';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@multimodal-canvas/ui';
import { apiFetch, readAuthSession } from '../auth-client';
import { isApiOriginUrl, resolveUploadUrl } from '../upload-utils';
import { API_BASE_URL } from './contracts';
import './artifact-preview.css';

/** 资源预览展示方式：紧凑图标或完整内容。 */
export type AssetPreviewMode = 'compact' | 'content';
/** 资源加载结果，用于同步节点的加载和重试状态。 */
export type AssetPreviewLoadState = 'loading' | 'ready' | 'error' | 'missing';

/** 资源预览的展示、交互和加载通知配置。 */
export type AssetPreviewProps = {
  asset: Asset;
  className?: string;
  interactive?: boolean;
  mode?: AssetPreviewMode;
  /** 是否允许直接点击图片打开预览；节点应在输入编辑器打开后启用，展开按钮始终可用。 */
  mediaClickPreviewEnabled?: boolean;
  /** 覆盖默认点开行为；紧凑缩略图也可打开大图预览。 */
  allowOpen?: boolean;
  onLoadStateChange?: (state: AssetPreviewLoadState) => void;
  /** 图片或视频固有尺寸就绪后回调，供节点按内容适配宽高。 */
  onNaturalSize?: (width: number, height: number) => void;
  /** 双击编辑后的持久化回调；失败拒绝 Promise，编辑器保留草稿。 */
  onTextSave?: (text: string) => Promise<void>;
};

type ArtifactKind = MediaType | 'file';

/** 申请受保护产物的签名地址；相对签名按 API 地址解析，失败不降级成未鉴权请求。 */
function useAuthenticatedAssetUrl(
  asset: Asset,
  reloadKey: number,
  sign = true,
): { url: string; loading: boolean; error?: string } {
  const fallback = asset.contentUrl ? resolveUploadUrl(asset.contentUrl, API_BASE_URL) : '';
  const protectedAsset =
    sign &&
    Boolean(readAuthSession()) &&
    isApiResultUrl(fallback) &&
    new URL(fallback, window.location.href).pathname.includes('/v1/assets/');
  const identity = `${asset.id}:${fallback}:${reloadKey}`;
  const [resolved, setResolved] = useState<{ identity: string; url: string; error?: string }>();

  useEffect(() => {
    if (!protectedAsset) return;
    const abort = new AbortController();

    const versionMatch = asset.contentUrl.match(/\/versions\/(\d+)\/content(?:$|\?)/);
    const derivativeMatch = asset.contentUrl.match(
      /\/derivatives\/(thumbnail|poster|waveform)(?:$|\?)/,
    );
    const body: Record<string, unknown> = versionMatch
      ? { version: Number(versionMatch[1]) }
      : derivativeMatch
        ? { derivative: derivativeMatch[1] }
        : {};
    void apiFetch(`${API_BASE_URL}/v1/assets/${encodeURIComponent(asset.id)}/access-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    })
      .then(async (response) => {
        const result = (await response.json().catch(() => ({}))) as { url?: string };
        if (!response.ok || !result.url) throw new Error(`产物访问授权失败（${response.status}）`);
        if (!abort.signal.aborted)
          setResolved({ identity, url: resolveUploadUrl(result.url, API_BASE_URL) });
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted)
          setResolved({
            identity,
            url: '',
            error: reason instanceof Error ? reason.message : '产物访问授权失败',
          });
      });
    return () => {
      abort.abort();
    };
  }, [asset.contentUrl, asset.id, identity, protectedAsset]);

  return protectedAsset
    ? resolved?.identity === identity
      ? { ...resolved, loading: false }
      : { url: '', loading: true }
    : { url: fallback, loading: false };
}

/** 根据资源类型显示真实内容，加载失败时提供重试入口。 */
export function AssetPreview({
  asset,
  className = '',
  interactive = false,
  mode,
  mediaClickPreviewEnabled = true,
  allowOpen,
  onLoadStateChange,
  onNaturalSize,
  onTextSave,
}: AssetPreviewProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const kind = resolveArtifactKind(asset);
  const access = useAuthenticatedAssetUrl(asset, reloadKey, kind !== 'text');
  const src = access.url;
  const previewMode = mode ?? (interactive ? 'content' : 'compact');
  const retry = () => setReloadKey((current) => current + 1);

  if (access.loading || ('error' in access && access.error)) {
    return (
      <ArtifactState
        className={className}
        state={access.loading ? 'loading' : 'error'}
        message={access.loading ? '正在读取产物…' : access.error!}
        {...(!access.loading && previewMode === 'content'
          ? { actionLabel: '重新加载', onAction: retry }
          : {})}
        onLoadStateChange={onLoadStateChange}
      />
    );
  }

  if (!src) {
    return (
      <ArtifactState
        className={className}
        state="missing"
        message="产物不存在或已失效"
        onLoadStateChange={onLoadStateChange}
      />
    );
  }

  if (previewMode === 'compact' && (kind === 'text' || kind === 'audio' || kind === 'file')) {
    return (
      <CompactArtifactIcon
        kind={kind}
        className={className}
        onLoadStateChange={onLoadStateChange}
      />
    );
  }

  if (kind === 'text') {
    return (
      <TextResultContent
        key={reloadKey}
        url={src}
        className={`artifact-preview-text ${className}`}
        copyable
        onSave={onTextSave}
        onRetry={retry}
        onLoadStateChange={onLoadStateChange}
      />
    );
  }

  if (kind === 'file') {
    return (
      <FileArtifactPreview
        key={`${src}:${reloadKey}`}
        asset={asset}
        src={src}
        className={className}
        onRetry={retry}
        onLoadStateChange={onLoadStateChange}
      />
    );
  }

  return (
    <MediaArtifactPreview
      key={`${src}:${reloadKey}`}
      asset={asset}
      kind={kind}
      src={src}
      className={className}
      controls={interactive || previewMode === 'content'}
      allowOpen={allowOpen ?? previewMode === 'content'}
      mediaClickPreviewEnabled={mediaClickPreviewEnabled}
      onRetry={retry}
      onLoadStateChange={onLoadStateChange}
      onNaturalSize={onNaturalSize}
    />
  );
}

function CompactArtifactIcon({
  kind,
  className,
  onLoadStateChange,
}: {
  kind: 'text' | 'audio' | 'file';
  className: string;
  onLoadStateChange?: (state: AssetPreviewLoadState) => void;
}) {
  useReportLoadState('ready', onLoadStateChange);
  if (kind === 'audio') {
    return <AudioLines className={`asset-preview-audio ${className}`} aria-hidden="true" />;
  }
  return <FileText className={`asset-preview-text ${className}`} aria-hidden="true" />;
}

/** 预览缩放下限，避免缩到看不见。 */
const VIEWER_MIN_SCALE = 0.5;
/** 预览缩放上限，用于查看局部细节。 */
const VIEWER_MAX_SCALE = 8;
/** 每次滚轮或按钮缩放的倍率。 */
const VIEWER_ZOOM_FACTOR = 1.12;

/** 预览内容相对适配尺寸的缩放倍率和像素偏移。 */
type ViewerTransform = {
  scale: number;
  x: number;
  y: number;
};

/** 图片或视频解码后的原始像素尺寸，也用于表示适配后的显示尺寸。 */
type MediaDimensions = {
  width: number;
  height: number;
};

/** 对话框两侧留白合计，单位为 CSS 像素。 */
const VIEWER_VIEWPORT_MARGIN = 32;
/** 对话框左右内边距与边框合计，须与样式保持一致。 */
const VIEWER_HORIZONTAL_CHROME = 26;
/** 对话框上下内边距、边框、标题栏和行间距合计，单位为 CSS 像素。 */
const VIEWER_VERTICAL_CHROME = 72;

/**
 * 根据原始尺寸等比适配视口；小资源保持原尺寸，大资源缩小到可用区域。
 * @param naturalSize 已验证为有限正数的媒体原始尺寸。
 * @param viewport 当前视口的 CSS 像素尺寸。
 * @returns 留出对话框边距和标题栏后的媒体显示尺寸。
 */
function fitMediaDimensions(naturalSize: MediaDimensions, viewport: MediaDimensions) {
  const availableWidth = Math.max(
    1,
    viewport.width - VIEWER_VIEWPORT_MARGIN - VIEWER_HORIZONTAL_CHROME,
  );
  const availableHeight = Math.max(
    1,
    viewport.height - VIEWER_VIEWPORT_MARGIN - VIEWER_VERTICAL_CHROME,
  );
  const scale = Math.min(
    1,
    availableWidth / naturalSize.width,
    availableHeight / naturalSize.height,
  );
  return { width: naturalSize.width * scale, height: naturalSize.height * scale };
}

/**
 * 读取图片或视频原始尺寸后自适应展示；资源切换由 key 重建，窗口变化时重新适配。
 * 加载失败或解码尺寸无效时显示可重试错误，不沿用其他资源的尺寸。
 */
function NaturalMediaViewer({
  kind,
  src,
  name,
  resetKey,
}: {
  kind: 'image' | 'video';
  src: string;
  name: string;
  resetKey: string;
}) {
  /** 当前资源解码尺寸；未知时让媒体按自身布局加载。 */
  const [naturalSize, setNaturalSize] = useState<MediaDimensions>();
  /** 当前浏览器视口，窗口缩放后重新计算可用空间。 */
  const [viewport, setViewport] = useState<MediaDimensions>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  /** 解码失败或无效尺寸的用户可见原因。 */
  const [error, setError] = useState<string>();
  /** 增加尝试次数会重建媒体元素并触发重新加载。 */
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const updateViewport = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  /** 只有有效的解码尺寸才参与适配，损坏文件保留可恢复错误。 */
  const acceptDimensions = (width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      setError(`无法读取${mediaKindLabel(kind)}尺寸，请重新加载`);
      return;
    }
    setNaturalSize({ width, height });
    setError(undefined);
  };
  if (error) {
    return (
      <ArtifactState
        className="artifact-preview-viewer-state"
        state="error"
        message={error}
        actionLabel="重新加载预览"
        onAction={() => {
          setNaturalSize(undefined);
          setError(undefined);
          setAttempt((current) => current + 1);
        }}
      />
    );
  }
  const fittedSize = naturalSize ? fitMediaDimensions(naturalSize, viewport) : undefined;
  return (
    <ZoomableMediaStage
      resetKey={`${resetKey}:${attempt}:${viewport.width}:${viewport.height}`}
      enablePanAtFit={kind === 'image'}
      dimensions={fittedSize}
    >
      {kind === 'image' ? (
        <img
          key={attempt}
          src={src}
          alt={name}
          draggable={false}
          onLoad={(event) =>
            acceptDimensions(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
          }
          onError={() => setError('图片加载失败，请重新加载预览')}
        />
      ) : (
        <video
          key={attempt}
          src={src}
          controls
          autoPlay
          playsInline
          onLoadedMetadata={(event) =>
            acceptDimensions(event.currentTarget.videoWidth, event.currentTarget.videoHeight)
          }
          onError={() => setError('视频加载失败，请重新加载预览')}
        />
      )}
    </ZoomableMediaStage>
  );
}

/** 把缩放限制在预览允许的区间内。 */
function clampViewerScale(value: number) {
  return Math.min(VIEWER_MAX_SCALE, Math.max(VIEWER_MIN_SCALE, value));
}

/**
 * 在预览舞台内相对光标缩放，并支持拖拽平移。
 * @param resetKey 资源或对话框身份变化时重置变换。
 * @param enablePanAtFit 适配比例下是否允许平移；视频在 100% 时交给原生控件。
 * @param dimensions 按资源原比例计算的显示尺寸；加载期间使用媒体自身布局。
 */
function ZoomableMediaStage({
  children,
  resetKey,
  enablePanAtFit = true,
  dimensions,
}: {
  children: ReactNode;
  resetKey: string;
  enablePanAtFit?: boolean;
  dimensions?: MediaDimensions;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<ViewerTransform>({ scale: 1, x: 0, y: 0 });
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    setTransform({ scale: 1, x: 0, y: 0 });
    dragRef.current = null;
    setPanning(false);
  }, [resetKey]);

  const zoomAt = useCallback((clientX: number, clientY: number, nextScale: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const clamped = clampViewerScale(nextScale);
    const current = transformRef.current;
    if (clamped === current.scale) return;
    const rect = stage.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const contentX = (px - current.x) / current.scale;
    const contentY = (py - current.y) / current.scale;
    setTransform({
      scale: clamped,
      x: px - contentX * clamped,
      y: py - contentY * clamped,
    });
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const factor = event.deltaY < 0 ? VIEWER_ZOOM_FACTOR : 1 / VIEWER_ZOOM_FACTOR;
      zoomAt(event.clientX, event.clientY, transformRef.current.scale * factor);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const zoomFromCenter = (direction: 1 | -1) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const factor = direction > 0 ? VIEWER_ZOOM_FACTOR : 1 / VIEWER_ZOOM_FACTOR;
    zoomAt(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      transformRef.current.scale * factor,
    );
  };

  /** 取消缩放和平移，恢复打开预览时的适配大小。 */
  const resetTransform = () => setTransform({ scale: 1, x: 0, y: 0 });
  /** 是否仍为打开预览时的适配位置；用于禁用恢复原始大小。 */
  const atOriginalSize = transform.scale === 1 && transform.x === 0 && transform.y === 0;
  const canPan = enablePanAtFit || transform.scale !== 1;

  return (
    <>
      <div className="artifact-preview-viewer-zoom" role="group" aria-label="预览缩放">
        <button type="button" aria-label="缩小预览" title="缩小" onClick={() => zoomFromCenter(-1)}>
          <Minus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="重置预览缩放"
          title="重置为 100%"
          onClick={resetTransform}
        >
          {Math.round(transform.scale * 100)}%
        </button>
        <button type="button" aria-label="放大预览" title="放大" onClick={() => zoomFromCenter(1)}>
          <Plus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="artifact-preview-viewer-zoom-reset"
          aria-label="恢复原始大小"
          title="取消当前缩放，恢复原始大小"
          disabled={atOriginalSize}
          onClick={resetTransform}
        >
          <RotateCcw size={15} aria-hidden="true" />
          原始大小
        </button>
      </div>
      <div
        ref={stageRef}
        className={`artifact-preview-viewer-stage${panning ? ' is-panning' : ''}${
          transform.scale > 1 ? ' is-zoomed' : ''
        }`}
        style={dimensions}
        onPointerDown={(event) => {
          if (event.button !== 0 || !canPan) return;
          if (
            transformRef.current.scale === 1 &&
            (event.target as HTMLElement).closest('video, audio')
          )
            return;
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: transformRef.current.x,
            originY: transformRef.current.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          event.preventDefault();
          if (!panning) setPanning(true);
          setTransform({
            ...transformRef.current,
            x: drag.originX + event.clientX - drag.startX,
            y: drag.originY + event.clientY - drag.startY,
          });
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setPanning(false);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setPanning(false);
        }}
      >
        <div
          className="artifact-preview-viewer-transform"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        >
          {children}
        </div>
      </div>
    </>
  );
}

/** 页内预览弹窗的资源、打开状态和已解析地址。 */
export type AssetViewerDialogProps = {
  asset: Asset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已解析的媒体地址；节点预览可传入，避免重复签名。 */
  src?: string;
};

/**
 * 页内资源预览对话框：图片/视频支持滚轮缩放与拖拽平移。
 * @param asset 要预览的资源。
 * @param open 是否打开对话框。
 * @param onOpenChange 开关变化回调。
 * @param src 已解析地址；缺省时在对话框内自行解析。
 */
export function AssetViewerDialog({ asset, open, onOpenChange, src }: AssetViewerDialogProps) {
  const kind = resolveArtifactKind(asset);
  const needsSign = src == null && kind !== 'text';
  const access = useAuthenticatedAssetUrl(asset, 0, needsSign);
  const resolvedSrc = src ?? access.url;
  const viewerTitleId = useId();
  const resetKey = `${asset.id}:${resolvedSrc}:${open ? 'open' : 'closed'}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          className={`artifact-preview-viewer overflow-hidden${
            kind === 'image' || kind === 'video' ? ' is-zoomable' : ''
          }`}
          overlayClassName="artifact-preview-viewer-backdrop"
          aria-labelledby={viewerTitleId}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="artifact-preview-viewer-header">
            <DialogTitle id={viewerTitleId}>{asset.name}</DialogTitle>
            <DialogClose asChild>
              <button
                type="button"
                className="artifact-preview-viewer-close"
                aria-label="关闭预览"
                title="关闭"
              >
                <X size={17} aria-hidden="true" />
              </button>
            </DialogClose>
          </div>
          {access.loading ? (
            <ArtifactState
              className="artifact-preview-viewer-state"
              state="loading"
              message="正在读取产物…"
            />
          ) : 'error' in access && access.error ? (
            <ArtifactState
              className="artifact-preview-viewer-state"
              state="error"
              message={access.error}
            />
          ) : !resolvedSrc ? (
            <ArtifactState
              className="artifact-preview-viewer-state"
              state="missing"
              message="产物不存在或已失效"
            />
          ) : kind === 'image' || kind === 'video' ? (
            <NaturalMediaViewer
              key={resetKey}
              resetKey={resetKey}
              kind={kind}
              src={resolvedSrc}
              name={asset.name}
            />
          ) : kind === 'audio' ? (
            <div className="artifact-preview-viewer-audio">
              <audio src={resolvedSrc} controls autoPlay />
            </div>
          ) : kind === 'text' ? (
            <TextResultContent url={resolvedSrc} className="artifact-preview-viewer-text" />
          ) : (
            <FileArtifactPreview
              asset={asset}
              src={resolvedSrc}
              className="artifact-preview-viewer-file"
              onRetry={() => onOpenChange(true)}
            />
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * 节点内图片/视频默认可拖拽；预览改为页内 Dialog，不再打开新标签页。
 * 音频控件需要捕获指针，因此保留 nodrag。
 */
function MediaArtifactPreview({
  asset,
  kind,
  src,
  className,
  controls,
  allowOpen,
  mediaClickPreviewEnabled,
  onRetry,
  onLoadStateChange,
  onNaturalSize,
}: {
  asset: Asset;
  kind: 'image' | 'video' | 'audio';
  src: string;
  className: string;
  controls: boolean;
  allowOpen: boolean;
  mediaClickPreviewEnabled: boolean;
  onRetry: () => void;
  onLoadStateChange?: (state: AssetPreviewLoadState) => void;
  onNaturalSize?: (width: number, height: number) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<AssetPreviewLoadState>('loading');
  const [viewerOpen, setViewerOpen] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  /** 缓存图片可能在 effect 前完成加载，复核元素状态以免重新盖上加载遮罩。 */
  const imageRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** 记录按下时是否已打开节点编辑器，避免选中节点的同步更新吞掉第一次点击。 */
  const previewGestureEnabled = useRef<boolean | null>(null);
  /** 播放策略或解码器拒绝播放时保留原因，并允许用户再次尝试。 */
  const [playbackError, setPlaybackError] = useState<string>();

  useEffect(() => {
    const image = kind === 'image' ? imageRef.current : null;
    setLoadState(image?.complete ? (image.naturalWidth > 0 ? 'ready' : 'error') : 'loading');
    setVideoPlaying(false);
    setPlaybackError(undefined);
  }, [attempt, kind, src]);
  useReportLoadState(loadState, onLoadStateChange);

  const canPreviewInDialog = allowOpen && (kind === 'image' || kind === 'video');
  const showInlineControls = controls && !canPreviewInDialog;
  /** 节点内视频用自定义播放按钮，避免原生控件挡住拖拽。 */
  const useNativeVideoControls = kind === 'video' && controls && !canPreviewInDialog;
  const mediaClassName = `asset-preview-${kind} artifact-preview-media ${className}`;
  const markReady = () => setLoadState('ready');
  const markError = () => setLoadState('error');
  /** 切换节点内播放；播放失败保留浏览器错误并提供原位重试。 */
  const toggleVideoPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      setPlaybackError(undefined);
      void video.play().catch((reason: unknown) => {
        const detail = reason instanceof Error ? reason.message : '浏览器未能开始播放';
        setPlaybackError(`视频播放失败：${detail}。请点击播放按钮重试。`);
      });
    } else {
      video.pause();
    }
  };
  const openViewer = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    setViewerOpen(true);
  };
  const media =
    kind === 'image' ? (
      <img
        key={`${src}:${attempt}`}
        ref={imageRef}
        className={mediaClassName}
        src={src}
        alt={asset.name}
        draggable={false}
        onLoad={(event) => {
          markReady();
          onNaturalSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
        }}
        onError={markError}
        onPointerDown={() => {
          previewGestureEnabled.current = mediaClickPreviewEnabled;
        }}
        onPointerCancel={() => {
          previewGestureEnabled.current = null;
        }}
        onClick={
          canPreviewInDialog
            ? (event) => {
                const enabled = previewGestureEnabled.current ?? mediaClickPreviewEnabled;
                previewGestureEnabled.current = null;
                if (enabled) openViewer(event);
              }
            : undefined
        }
      />
    ) : kind === 'video' ? (
      <video
        key={`${src}:${attempt}`}
        ref={videoRef}
        className={mediaClassName}
        src={src}
        muted
        controls={useNativeVideoControls}
        preload="metadata"
        draggable={false}
        playsInline
        onLoadedMetadata={(event) => {
          markReady();
          onNaturalSize?.(event.currentTarget.videoWidth, event.currentTarget.videoHeight);
        }}
        onError={markError}
        onPlay={() => {
          setVideoPlaying(true);
          setPlaybackError(undefined);
        }}
        onPause={() => setVideoPlaying(false)}
      />
    ) : (
      <audio
        key={`${src}:${attempt}`}
        className={mediaClassName}
        src={src}
        controls={controls}
        preload="metadata"
        onLoadedMetadata={markReady}
        onError={markError}
      />
    );

  if (loadState === 'error') {
    return (
      <ArtifactState
        className={`artifact-preview-media-shell ${className}`}
        state="error"
        message={`${mediaKindLabel(kind)}加载失败`}
        actionLabel="重新加载"
        onAction={() => {
          setAttempt((current) => current + 1);
          onRetry();
        }}
      />
    );
  }

  const capturePointer = kind === 'audio' || showInlineControls || useNativeVideoControls;
  return (
    <div
      className={`artifact-preview-media-shell artifact-preview-${kind}-shell ${className}${capturePointer ? ' nodrag nopan nowheel' : ''}`}
    >
      {media}
      {playbackError && (
        <span className="artifact-preview-playback-error" role="alert">
          {playbackError}
        </span>
      )}
      {kind === 'video' && controls && !videoPlaying && loadState === 'ready' && (
        <button
          type="button"
          className="artifact-preview-play-button nodrag nopan nowheel"
          aria-label="播放视频"
          title="播放视频"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            toggleVideoPlayback();
          }}
        >
          <span aria-hidden="true" className="artifact-preview-play-icon" />
        </button>
      )}
      {canPreviewInDialog && (
        <button
          type="button"
          className="artifact-preview-open-button nodrag nopan nowheel"
          aria-label={`预览${mediaKindLabel(kind)}：${asset.name}`}
          title={`预览${mediaKindLabel(kind)}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={openViewer}
        >
          <Expand className="artifact-preview-open-icon" size={15} aria-hidden="true" />
        </button>
      )}
      {canPreviewInDialog && (
        <AssetViewerDialog asset={asset} open={viewerOpen} onOpenChange={setViewerOpen} src={src} />
      )}
      {loadState === 'loading' && (
        <span className="artifact-preview-loading" aria-live="polite">
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
          正在加载{mediaKindLabel(kind)}…
        </span>
      )}
    </div>
  );
}

function FileArtifactPreview({
  asset,
  src,
  className,
  onRetry,
  onLoadStateChange,
}: {
  asset: Asset;
  src: string;
  className: string;
  onRetry: () => void;
  onLoadStateChange?: (state: AssetPreviewLoadState) => void;
}) {
  const loadState = useFileLoadState(src, onLoadStateChange);
  if (loadState === 'loading') {
    return (
      <div className={`artifact-preview-file-pending ${className}`} role="status">
        <LoaderCircle className="spin" size={16} aria-hidden="true" />
        正在检查文件…
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <ArtifactState
        className={className}
        state="error"
        message="文件产物加载失败"
        actionLabel="重新加载"
        onAction={onRetry}
      />
    );
  }
  return (
    <div className={`artifact-preview-file ${className} nodrag nopan nowheel`}>
      <FileText className="artifact-preview-file-icon" size={22} aria-hidden="true" />
      <span className="artifact-preview-file-copy">
        <strong title={asset.name}>{asset.name}</strong>
        <span title={`${asset.mimeType} · ${formatBytes(asset.sizeBytes)}`}>
          {asset.mimeType} · {formatBytes(asset.sizeBytes)}
        </span>
      </span>
      <a
        className="artifact-preview-action"
        href={src}
        download={asset.name}
        aria-label={`下载文件：${asset.name}`}
        title="下载文件"
      >
        <Download size={16} aria-hidden="true" />
      </a>
    </div>
  );
}

function ArtifactState({
  className = '',
  state,
  message,
  actionLabel,
  onAction,
  onLoadStateChange,
}: {
  className?: string;
  state: 'error' | 'missing' | 'loading';
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onLoadStateChange?: (state: AssetPreviewLoadState) => void;
}) {
  useReportLoadState(state, onLoadStateChange);
  return (
    <div
      className={`artifact-preview-state artifact-preview-state-${state} ${className}`}
      role={state === 'loading' ? 'status' : 'alert'}
    >
      {state === 'loading' ? (
        <LoaderCircle className="spin" size={18} aria-hidden="true" />
      ) : (
        <TriangleAlert size={18} aria-hidden="true" />
      )}
      <span>{message}</span>
      {actionLabel && onAction ? (
        <button type="button" className="artifact-preview-retry nodrag nopan" onClick={onAction}>
          <RefreshCw size={14} aria-hidden="true" />
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function AuthenticatedAssetLink({
  asset,
  className,
  children,
  current,
}: {
  asset: Asset;
  className?: string;
  children: ReactNode;
  current?: boolean;
}) {
  const { url: href, loading, error } = useAuthenticatedAssetUrl(asset, 0);
  if (loading || error)
    return (
      <span className={className} title={error}>
        {children}
      </span>
    );
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-current={current ? 'true' : undefined}
    >
      {children}
    </a>
  );
}

export function TextResultContent({
  url,
  className = '',
  copyable = true,
  editable = false,
  onChange,
  onSave,
  onRetry,
  onLoadStateChange,
}: {
  url: string;
  className?: string;
  copyable?: boolean;
  /** 是否将文字结果渲染为可直接编辑的文本框。 */
  editable?: boolean;
  /** 编辑结果时回传最新文本。 */
  onChange?: (value: string) => void;
  /** 提交用户草稿并等待持久化完成；失败时保留编辑态与错误。 */
  onSave?: (value: string) => Promise<void>;
  onRetry?: () => void;
  onLoadStateChange?: (state: AssetPreviewLoadState) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  /** 草稿与远端正文分离，Esc 取消不会改写资产。 */
  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const composingRef = useRef(false);
  const cancelRef = useRef(false);
  const callbackRef = useRef(onLoadStateChange);
  callbackRef.current = onLoadStateChange;

  useEffect(() => {
    let active = true;
    setContent(null);
    setError(null);
    setCopyState('idle');
    if (!url) {
      callbackRef.current?.('missing');
      return () => {
        active = false;
      };
    }

    callbackRef.current?.('loading');
    const resolvedUrl = resolveUploadUrl(url, API_BASE_URL);
    // Signed S3/CDN URLs must never receive this application's Bearer token.
    const request = isApiResultUrl(resolvedUrl) ? apiFetch(resolvedUrl) : fetch(resolvedUrl);
    void request
      .then(async (response) => {
        if (!response.ok) throw new Error(`结果读取失败（${response.status}）`);
        return response.text();
      })
      .then((value) => {
        if (!active) return;
        setContent(value);
        callbackRef.current?.('ready');
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : '结果读取失败');
        callbackRef.current?.('error');
      });
    return () => {
      active = false;
    };
  }, [attempt, url]);

  if (!url) {
    return <ArtifactState className={className} state="missing" message="产物不存在或已失效" />;
  }
  if (error && draft === null) {
    return (
      <ArtifactState
        className={className}
        state="error"
        message={`文字产物加载失败：${error}`}
        actionLabel="重新加载"
        onAction={() => {
          setAttempt((current) => current + 1);
          onRetry?.();
        }}
      />
    );
  }
  if (content === null && draft === null) {
    return (
      <p
        className={`artifact-preview-text-pending inspector-result-pending ${className}`}
        role="status"
      >
        <LoaderCircle className="spin" size={15} aria-hidden="true" />
        正在读取文字结果…
      </p>
    );
  }

  const copyContent = async () => {
    try {
      await writeTextToClipboard(draft ?? content ?? '');
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  /** 失焦只提交一次，输入法组合及取消引起的失焦不保存。 */
  const commitDraft = async () => {
    if (!onSave || draft === null || savingRef.current || composingRef.current || cancelRef.current)
      return;
    if (draft === content && !saveError) {
      setDraft(null);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setContent(draft);
      setDraft(null);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : '文字保存失败');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      className={`artifact-preview-text-content ${className}${draft !== null ? ' nodrag nopan nowheel' : ''}`}
    >
      {copyable ? (
        <div className="artifact-preview-text-toolbar">
          <button
            type="button"
            className="artifact-preview-action nodrag nopan"
            onClick={() => void copyContent()}
            aria-label="复制文字结果"
            title="复制文字结果"
          >
            <Copy size={14} aria-hidden="true" />
          </button>
          <span aria-live="polite">
            {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : ''}
          </span>
        </div>
      ) : null}
      {draft !== null ? (
        <>
          <textarea
            autoFocus
            className="inspector-result-text artifact-preview-text-body artifact-preview-text-editor nodrag nopan nowheel"
            aria-label="编辑文字结果"
            value={draft}
            readOnly={saving}
            onChange={(event) => setDraft(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              if (document.activeElement !== event.currentTarget) void commitDraft();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (
                event.key === 'Escape' &&
                !event.nativeEvent.isComposing &&
                !composingRef.current &&
                !savingRef.current
              ) {
                cancelRef.current = true;
                setDraft(null);
                setSaveError(null);
              }
            }}
            onKeyUp={(event) => event.stopPropagation()}
            onBlur={() => void commitDraft()}
          />
          {saving && <span role="status">正在保存…</span>}
          {saveError && (
            <div role="alert">
              {saveError}
              <button
                type="button"
                className="artifact-preview-action"
                onClick={() => void commitDraft()}
              >
                重试保存
              </button>
            </div>
          )}
        </>
      ) : editable ? (
        <textarea
          className="inspector-result-text artifact-preview-text-body artifact-preview-text-editor"
          value={content ?? ''}
          aria-label="编辑文字结果"
          onChange={(event) => {
            setContent(event.target.value);
            onChange?.(event.target.value);
          }}
        />
      ) : (
        <pre
          className="inspector-result-text artifact-preview-text-body"
          tabIndex={onSave ? 0 : undefined}
          aria-label={onSave ? '文字结果' : undefined}
          onDoubleClick={
            onSave
              ? (event) => {
                  event.stopPropagation();
                  cancelRef.current = false;
                  setDraft(content);
                }
              : undefined
          }
          onKeyDown={
            onSave
              ? (event) => {
                  if (event.key === 'Enter' || event.key === 'F2') {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelRef.current = false;
                    setDraft(content);
                  }
                }
              : undefined
          }
        >
          {content}
        </pre>
      )}
    </div>
  );
}

function useReportLoadState(
  state: AssetPreviewLoadState,
  onLoadStateChange?: (state: AssetPreviewLoadState) => void,
) {
  const callbackRef = useRef(onLoadStateChange);
  callbackRef.current = onLoadStateChange;
  useEffect(() => {
    callbackRef.current?.(state);
  }, [state]);
}

function useFileLoadState(
  src: string,
  onLoadStateChange?: (state: AssetPreviewLoadState) => void,
): AssetPreviewLoadState {
  const [state, setState] = useState<AssetPreviewLoadState>('loading');

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const resolvedUrl = resolveUploadUrl(src, API_BASE_URL);

    setState('loading');
    if (!isApiResultUrl(resolvedUrl)) {
      setState('ready');
      return () => {
        active = false;
        controller.abort();
      };
    }

    void apiFetch(resolvedUrl, { method: 'HEAD', signal: controller.signal })
      .then((response) => {
        if (!active) return;
        // Some object stores do not implement HEAD; the download link is
        // still usable in that case, so only definite failures are errors.
        setState(
          response.ok || response.status === 405 || response.status === 501 ? 'ready' : 'error',
        );
      })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        setState('error');
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [src]);

  useReportLoadState(state, onLoadStateChange);
  return state;
}

function resolveArtifactKind(asset: Asset): ArtifactKind {
  const mimeType = asset.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript' ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml')
  ) {
    return 'text';
  }
  if (!mimeType) return asset.mediaType;
  if (mimeType === 'application/octet-stream') return 'file';
  return 'file';
}

function mediaKindLabel(kind: 'image' | 'video' | 'audio') {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

async function writeTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand?.('copy') ?? false;
  textArea.remove();
  if (!copied) throw new Error('clipboard unavailable');
}

function isApiResultUrl(value: string): boolean {
  return isApiOriginUrl(value, API_BASE_URL, window.location.href);
}
