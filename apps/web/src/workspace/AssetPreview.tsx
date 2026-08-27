import { AudioLines, FileText } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import type { Asset } from '@multimodal-canvas/domain';
import { apiFetch, getAuthToken } from '../auth-client';
import { resolveUploadUrl } from '../upload-utils';
import { API_BASE_URL } from './contracts';

type AssetPreviewProps = {
  asset: Asset;
  className?: string;
  interactive?: boolean;
};

function useAuthenticatedAssetUrl(asset: Asset): string {
  const fallback = resolveUploadUrl(asset.contentUrl, API_BASE_URL);
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
  }, [asset.contentUrl, asset.id, fallback]);

  return url;
}

export function AssetPreview({ asset, className = '', interactive = false }: AssetPreviewProps) {
  const src = useAuthenticatedAssetUrl(asset);
  if (asset.mediaType === 'image') {
    return <img className={`asset-preview-image ${className}`} src={src} alt={asset.name} />;
  }
  if (asset.mediaType === 'video') {
    return (
      <video
        className={`asset-preview-video ${className}`}
        src={src}
        muted={!interactive}
        controls={interactive}
        preload="metadata"
      />
    );
  }
  if (asset.mediaType === 'audio') {
    if (interactive) {
      return (
        <audio
          className={`asset-preview-audio ${className}`}
          src={src}
          controls
          preload="metadata"
        />
      );
    }
    return <AudioLines className={`asset-preview-audio ${className}`} aria-hidden="true" />;
  }
  return <FileText className={`asset-preview-text ${className}`} aria-hidden="true" />;
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
  const href = useAuthenticatedAssetUrl(asset);
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

export function TextResultContent({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setContent(null);
    setError(null);
    const resolvedUrl = resolveUploadUrl(url, API_BASE_URL);
    // Result content may be a signed S3/CDN URL. Only this app's API needs
    // the session Bearer header; forwarding it to an external origin can
    // trigger CORS failures and leaks credentials across origins.
    const request = isApiResultUrl(resolvedUrl) ? apiFetch(resolvedUrl) : fetch(resolvedUrl);
    void request
      .then(async (response) => {
        if (!response.ok) throw new Error(`结果读取失败（${response.status}）`);
        return response.text();
      })
      .then((value) => {
        if (active) setContent(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '结果读取失败');
      });
    return () => {
      active = false;
    };
  }, [url]);

  if (error) return <p className="inspector-result-pending">{error}</p>;
  if (content === null) return <p className="inspector-result-pending">正在读取文字结果…</p>;
  return <pre className="inspector-result-text">{content}</pre>;
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
