import {
  AudioLines,
  Copy,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { Asset, MediaType } from '@multimodal-canvas/domain';
import { apiFetch, getAuthToken } from '../auth-client';
import { resolveUploadUrl } from '../upload-utils';
import { API_BASE_URL } from './contracts';
import './artifact-preview.css';

export type AssetPreviewMode = 'compact' | 'content';
export type AssetPreviewLoadState = 'loading' | 'ready' | 'error' | 'missing';

export type AssetPreviewProps = {
  asset: Asset;
  className?: string;
  interactive?: boolean;
  mode?: AssetPreviewMode;
  onLoadStateChange?: (state: AssetPreviewLoadState) => void;
};

type ArtifactKind = MediaType | 'file';

function useAuthenticatedAssetUrl(asset: Asset, reloadKey: number): string {
  const fallback = asset.contentUrl ? resolveUploadUrl(asset.contentUrl, API_BASE_URL) : '';
  const [url, setUrl] = useState(fallback);

  useEffect(() => {
    let active = true;
    setUrl(fallback);
    const token = getAuthToken();
    if (!token || !asset.contentUrl.startsWith('/v1/assets/')) return;

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
    })
      .then(async (response) => {
        const result = (await response.json().catch(() => ({}))) as { url?: string };
        if (response.ok && result.url && active) setUrl(result.url);
      })
      .catch(() => {
        // Keep the relative URL as a fallback for anonymous/local development.
      });
    return () => {
      active = false;
    };
  }, [asset.contentUrl, asset.id, fallback, reloadKey]);

  return url;
}

export function AssetPreview({
  asset,
  className = '',
  interactive = false,
  mode,
  onLoadStateChange,
}: AssetPreviewProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const src = useAuthenticatedAssetUrl(asset, reloadKey);
  const previewMode = mode ?? (interactive ? 'content' : 'compact');
  const kind = resolveArtifactKind(asset);
  const retry = () => setReloadKey((current) => current + 1);

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
        key={`${src}:${reloadKey}`}
        url={src}
        className={`artifact-preview-text ${className}`}
        copyable
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
      allowOpen={previewMode === 'content'}
      onRetry={retry}
      onLoadStateChange={onLoadStateChange}
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

function MediaArtifactPreview({
  asset,
  kind,
  src,
  className,
  controls,
  allowOpen,
  onRetry,
  onLoadStateChange,
}: {
  asset: Asset;
  kind: 'image' | 'video' | 'audio';
  src: string;
  className: string;
  controls: boolean;
  allowOpen: boolean;
  onRetry: () => void;
  onLoadStateChange?: (state: AssetPreviewLoadState) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<AssetPreviewLoadState>('loading');

  useEffect(() => {
    setLoadState('loading');
  }, [attempt, src]);
  useReportLoadState(loadState, onLoadStateChange);

  const mediaClassName = `asset-preview-${kind} artifact-preview-media ${className}`;
  const markReady = () => setLoadState('ready');
  const markError = () => setLoadState('error');
  const media =
    kind === 'image' ? (
      <img
        key={`${src}:${attempt}`}
        className={mediaClassName}
        src={src}
        alt={asset.name}
        onLoad={markReady}
        onError={markError}
      />
    ) : kind === 'video' ? (
      <video
        key={`${src}:${attempt}`}
        className={mediaClassName}
        src={src}
        muted={!controls}
        controls={controls}
        preload="metadata"
        onLoadedMetadata={markReady}
        onError={markError}
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

  return (
    <div
      className={`artifact-preview-media-shell artifact-preview-${kind}-shell ${className} nodrag nopan nowheel`}
    >
      {kind === 'image' && allowOpen ? (
        <a
          className="artifact-preview-image-link"
          href={src}
          target="_blank"
          rel="noreferrer"
          aria-label={`查看大图：${asset.name}`}
        >
          {media}
          <ExternalLink className="artifact-preview-open-icon" size={15} aria-hidden="true" />
        </a>
      ) : (
        media
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
  state: 'error' | 'missing';
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onLoadStateChange?: (state: AssetPreviewLoadState) => void;
}) {
  useReportLoadState(state, onLoadStateChange);
  return (
    <div
      className={`artifact-preview-state artifact-preview-state-${state} ${className}`}
      role="alert"
    >
      <TriangleAlert size={18} aria-hidden="true" />
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
  const href = useAuthenticatedAssetUrl(asset, 0);
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
  onRetry?: () => void;
  onLoadStateChange?: (state: AssetPreviewLoadState) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
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
  if (error) {
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
  if (content === null) {
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
      await writeTextToClipboard(content);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div className={`artifact-preview-text-content ${className} nodrag nopan nowheel`}>
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
      {editable ? (
        <textarea
          className="inspector-result-text artifact-preview-text-body artifact-preview-text-editor"
          value={content}
          aria-label="编辑文字结果"
          onChange={(event) => {
            setContent(event.target.value);
            onChange?.(event.target.value);
          }}
        />
      ) : (
        <pre className="inspector-result-text artifact-preview-text-body">{content}</pre>
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
  try {
    const apiUrl = new URL(API_BASE_URL, window.location.href);
    const resultUrl = new URL(value, window.location.href);
    const apiPath = apiUrl.pathname.replace(/\/$/, '');
    return (
      resultUrl.origin === apiUrl.origin &&
      (!apiPath || apiPath === '/' || resultUrl.pathname.startsWith(apiPath))
    );
  } catch {
    return false;
  }
}
