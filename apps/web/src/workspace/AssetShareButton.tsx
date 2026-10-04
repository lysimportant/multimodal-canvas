import { Check, Copy, LoaderCircle, Share2, X } from 'lucide-react';
import { Popover } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Asset } from '@multimodal-canvas/domain';
import { Button } from '@multimodal-canvas/ui';
import {
  apiFetch,
  AuthSessionChangedError,
  getAuthSessionGeneration,
  subscribeAuthSession,
} from '../auth-client';
import { API_BASE_URL } from './contracts';
import './asset-share.css';

/** 分享创建接口的未校验响应；读取前必须逐字段确认类型和范围。 */
type ShareResponse = {
  token?: unknown;
  expiresAt?: unknown;
  version?: unknown;
};

/** 当前预览资源已创建的只读链接及其冻结版本、过期时间。 */
type ShareRecord = {
  identity: string;
  url: string;
  expiresAt: string;
  version: number;
};

/** 剪贴板写入结果；失败时保留输入框供用户手动复制。 */
type CopyState = 'idle' | 'copied' | 'failed';

/** 预览标题栏分享按钮的资源配置。 */
export type AssetShareButtonProps = {
  asset: Asset;
};

/** 从冻结内容地址读取版本；旧地址没有版本时回退资源索引的最新版本。 */
export function resolveAssetShareVersion(asset: Asset): number | undefined {
  const match = asset.contentUrl?.match(/\/versions\/(\d+)\/content(?:[/?#]|$)/);
  if (match) {
    const version = Number(match[1]);
    if (Number.isSafeInteger(version) && version > 0) return version;
  }
  return Number.isSafeInteger(asset.latestVersion) && (asset.latestVersion ?? 0) > 0
    ? asset.latestVersion
    : undefined;
}

/** 判断分享记录是否已经到期，复制与复用前都必须重新检查。 */
function isShareExpired(share: ShareRecord, now = Date.now()): boolean {
  return Date.parse(share.expiresAt) <= now;
}

/**
 * 为当前资源版本创建七天只读分享链接，并在本次预览中复用未过期结果。
 * @param asset 当前预览资源；必须有持久化资源 ID 和内容地址。
 * @returns 标题栏按钮及挂载到 document.body 的分享浮层。
 */
export function AssetShareButton({ asset }: AssetShareButtonProps) {
  const identity = [asset.id, asset.contentUrl ?? '', asset.latestVersion ?? ''].join(':');
  const version = resolveAssetShareVersion(asset);
  const disabledReason = !asset.id.trim()
    ? '资源尚未保存，无法分享'
    : !asset.contentUrl
      ? '资源内容不存在，无法分享'
      : undefined;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  const panelOpenRef = useRef(false);
  const identityRef = useRef(identity);
  const authGenerationRef = useRef(getAuthSessionGeneration());
  const lifecycleRef = useRef(0);
  const copyAttemptRef = useRef(0);
  const requestRef = useRef<{
    identity: string;
    authGeneration: number;
    lifecycle: number;
    abort: AbortController;
  } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [share, setShare] = useState<ShareRecord>();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [error, setError] = useState<string>();
  const [, setExpiryRevision] = useState(0);

  identityRef.current = identity;
  const shareForIdentity = share?.identity === identity ? share : undefined;
  const shareExpired = Boolean(shareForIdentity && isShareExpired(shareForIdentity));
  const currentShare = shareExpired ? undefined : shareForIdentity;
  const expiresLabel = useMemo(() => {
    if (!currentShare) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(currentShare.expiresAt));
  }, [currentShare]);

  /** 浮层关闭后将键盘焦点归还标题栏触发按钮。 */
  const restoreTriggerFocus = useCallback(() => {
    window.setTimeout(() => {
      if (mountedRef.current) triggerRef.current?.focus({ preventScroll: true });
    }, 0);
  }, []);

  /** 使当前请求和复制尝试失效；账户或资源变化时同时清除已创建链接。 */
  const resetShareState = useCallback(
    ({ clearShare, restoreFocus }: { clearShare: boolean; restoreFocus: boolean }) => {
      const wasOpen = panelOpenRef.current;
      lifecycleRef.current += 1;
      copyAttemptRef.current += 1;
      requestRef.current?.abort.abort();
      requestRef.current = null;
      panelOpenRef.current = false;
      setPanelOpen(false);
      setCreating(false);
      setCopyState('idle');
      setError(undefined);
      if (clearShare) setShare(undefined);
      if (restoreFocus && wasOpen) restoreTriggerFocus();
    },
    [restoreTriggerFocus],
  );

  /** 用户关闭只隐藏浮层并保留仍有效的本次分享链接。 */
  const closePanel = useCallback(() => {
    resetShareState({ clearShare: false, restoreFocus: true });
  }, [resetShareState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      copyAttemptRef.current += 1;
      requestRef.current?.abort.abort();
      requestRef.current = null;
    };
  }, []);

  useEffect(() => {
    resetShareState({ clearShare: true, restoreFocus: true });
  }, [identity, resetShareState]);

  useEffect(
    () =>
      subscribeAuthSession(() => {
        const nextGeneration = getAuthSessionGeneration();
        if (nextGeneration === authGenerationRef.current) return;
        authGenerationRef.current = nextGeneration;
        resetShareState({ clearShare: true, restoreFocus: true });
      }),
    [resetShareState],
  );

  useEffect(() => {
    if (!shareForIdentity) return;
    const remaining = Date.parse(shareForIdentity.expiresAt) - Date.now();
    if (remaining <= 0) return;
    const timeout = window.setTimeout(
      () => {
        copyAttemptRef.current += 1;
        setCopyState('idle');
        setExpiryRevision((current) => current + 1);
      },
      Math.min(remaining + 1, 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [shareForIdentity]);

  useEffect(() => {
    if (!panelOpen) return;
    const timeout = window.setTimeout(() => {
      closeButtonRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [panelOpen]);

  useEffect(() => {
    if (!panelOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.isComposing || event.keyCode === 229) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [closePanel, panelOpen]);

  /** 复制未过期公开地址；失效上下文的迟到结果不得更新当前界面。 */
  const copyLink = async (record: ShareRecord) => {
    const expectedIdentity = identity;
    const expectedAuthGeneration = getAuthSessionGeneration();
    const expectedLifecycle = lifecycleRef.current;
    const copyAttempt = ++copyAttemptRef.current;
    const isCurrentAttempt = () =>
      mountedRef.current &&
      panelOpenRef.current &&
      identityRef.current === expectedIdentity &&
      lifecycleRef.current === expectedLifecycle &&
      copyAttemptRef.current === copyAttempt &&
      getAuthSessionGeneration() === expectedAuthGeneration;

    if (isShareExpired(record)) {
      if (isCurrentAttempt()) {
        setCopyState('idle');
        setExpiryRevision((current) => current + 1);
      }
      return;
    }

    setCopyState('idle');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不允许访问剪贴板');
      await navigator.clipboard.writeText(record.url);
      if (!isCurrentAttempt() || isShareExpired(record)) {
        if (isCurrentAttempt() && isShareExpired(record))
          setExpiryRevision((current) => current + 1);
        return;
      }
      setCopyState('copied');
    } catch {
      if (!isCurrentAttempt() || isShareExpired(record)) {
        if (isCurrentAttempt() && isShareExpired(record))
          setExpiryRevision((current) => current + 1);
        return;
      }
      setCopyState('failed');
    }
  };

  /** 仅在用户明确展开浮层后创建；复制重试不会重复发送 POST。 */
  const createShare = async () => {
    if (disabledReason || requestRef.current || currentShare || !panelOpenRef.current) return;

    const expectedAuthGeneration = getAuthSessionGeneration();
    authGenerationRef.current = expectedAuthGeneration;
    const expectedLifecycle = lifecycleRef.current;
    const abort = new AbortController();
    requestRef.current = {
      identity,
      authGeneration: expectedAuthGeneration,
      lifecycle: expectedLifecycle,
      abort,
    };
    setShare(undefined);
    setCreating(true);
    setCopyState('idle');
    setError(undefined);
    try {
      const response = await apiFetch(
        API_BASE_URL + '/v1/assets/' + encodeURIComponent(asset.id) + '/share',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(version === undefined ? {} : { version }),
          signal: abort.signal,
        },
        { expectedAuthGeneration },
      );
      const result = (await response.json().catch(() => ({}))) as ShareResponse & {
        error?: unknown;
        message?: unknown;
      };
      if (!response.ok) {
        const detail =
          typeof result.message === 'string'
            ? result.message
            : typeof result.error === 'string'
              ? result.error
              : undefined;
        throw new Error(detail || '分享创建失败（' + response.status + '）');
      }
      if (
        typeof result.token !== 'string' ||
        !result.token ||
        typeof result.expiresAt !== 'string' ||
        Number.isNaN(Date.parse(result.expiresAt)) ||
        Date.parse(result.expiresAt) <= Date.now() ||
        !Number.isSafeInteger(result.version) ||
        Number(result.version) <= 0
      )
        throw new Error('分享服务返回了无效或已过期的结果，请重试');
      if (
        abort.signal.aborted ||
        requestRef.current?.abort !== abort ||
        requestRef.current.identity !== identity ||
        requestRef.current.authGeneration !== expectedAuthGeneration ||
        requestRef.current.lifecycle !== expectedLifecycle ||
        identityRef.current !== identity ||
        lifecycleRef.current !== expectedLifecycle ||
        !panelOpenRef.current ||
        getAuthSessionGeneration() !== expectedAuthGeneration
      )
        return;

      const shareUrl = new URL('/share', window.location.origin);
      shareUrl.hash = 'token=' + encodeURIComponent(result.token);
      const record: ShareRecord = {
        identity,
        url: shareUrl.toString(),
        expiresAt: result.expiresAt,
        version: Number(result.version),
      };
      requestRef.current = null;
      setCreating(false);
      setShare(record);
      void copyLink(record);
    } catch (reason) {
      if (
        reason instanceof AuthSessionChangedError ||
        abort.signal.aborted ||
        requestRef.current?.abort !== abort ||
        identityRef.current !== identity ||
        lifecycleRef.current !== expectedLifecycle ||
        !panelOpenRef.current ||
        getAuthSessionGeneration() !== expectedAuthGeneration
      )
        return;
      setError(reason instanceof Error ? reason.message : '分享创建失败，请重试');
    } finally {
      if (requestRef.current?.abort === abort) {
        requestRef.current = null;
        setCreating(false);
      }
    }
  };

  /** Popover 只负责展开状态，创建动作仍由本组件按用户点击显式触发。 */
  const handlePanelOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      closePanel();
      return;
    }
    panelOpenRef.current = true;
    setPanelOpen(true);
    if (!currentShare && !shareExpired) void createShare();
  };

  const panel = (
    <div
      className="asset-share-panel"
      role="group"
      aria-label="资源分享链接"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="asset-share-panel-header">
        <strong>分享当前版本</strong>
        <Button
          ref={closeButtonRef}
          autoFocus
          type="button"
          className="asset-share-panel-close"
          aria-label="关闭分享面板"
          onClick={closePanel}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      </div>
      {creating ? (
        <p className="asset-share-status" role="status">
          正在创建只读分享链接…
        </p>
      ) : error ? (
        <div className="asset-share-error" role="alert">
          <span>{error}</span>
          <Button type="button" onClick={() => void createShare()}>
            重试创建
          </Button>
        </div>
      ) : shareExpired ? (
        <div className="asset-share-expired" role="status">
          <span>原分享链接已过期，不能继续复制或发送。</span>
          <Button type="button" aria-label="重新创建分享链接" onClick={() => void createShare()}>
            重新创建
          </Button>
        </div>
      ) : currentShare ? (
        <>
          <div className="asset-share-copy-row">
            <input
              aria-label="分享链接"
              value={currentShare.url}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              type="button"
              aria-label={copyState === 'failed' ? '重新复制分享链接' : '复制分享链接'}
              onClick={() => void copyLink(currentShare)}
            >
              {copyState === 'copied' ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <Copy size={15} aria-hidden="true" />
              )}
              {copyState === 'failed' ? '重新复制' : '复制'}
            </Button>
          </div>
          <p className={'asset-share-copy-state is-' + copyState} aria-live="polite">
            {copyState === 'copied'
              ? '分享链接已复制'
              : copyState === 'failed'
                ? '自动复制失败，请选择上方链接手动复制'
                : '可复制链接发送给其他人'}
          </p>
          <p className="asset-share-note">
            当前第 {currentShare.version} 版，默认 7 天有效，将于 {expiresLabel} 到期。
          </p>
          <p className="asset-share-note">持有链接的人无需登录即可只读查看此资源。</p>
        </>
      ) : null}
    </div>
  );

  return (
    <div className="asset-share" onPointerDown={(event) => event.stopPropagation()}>
      <Popover
        trigger="click"
        open={panelOpen}
        onOpenChange={handlePanelOpenChange}
        afterOpenChange={(open) => {
          if (open) closeButtonRef.current?.focus({ preventScroll: true });
        }}
        placement="bottomRight"
        destroyOnHidden
        arrow={false}
        getPopupContainer={() => document.body}
        classNames={{ root: 'asset-share-popover' }}
        content={panel}
      >
        <Button
          ref={triggerRef}
          type="button"
          className="artifact-preview-viewer-download asset-share-trigger"
          aria-label="分享当前版本"
          aria-expanded={panelOpen}
          aria-busy={creating}
          title={disabledReason ?? '创建当前版本的只读分享链接'}
          disabled={Boolean(disabledReason) || creating}
        >
          {creating ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : (
            <Share2 size={16} aria-hidden="true" />
          )}
          <span role={creating ? 'status' : undefined}>{creating ? '创建中…' : '分享'}</span>
        </Button>
      </Popover>
    </div>
  );
}
