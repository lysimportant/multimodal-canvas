import {
  Check,
  Circle,
  Clock3,
  LoaderCircle,
  Power,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Wand2,
  X,
} from 'lucide-react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import type { Asset, RunStatus } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import { NodeHandles } from '../NodeHandles';
import { AssetPreview, type AssetPreviewLoadState } from './AssetPreview';
import { mediaIcons, mediaLabels, modeLabels } from './contracts';

export type NodeSelectionHandler = (data: AssetFlowNode['data']) => void;
export const NodeSelectionContext = createContext<NodeSelectionHandler | null>(null);
export type NodeResizeHandler = (nodeId: string, width: number, height: number) => void;
export const NodeResizeContext = createContext<NodeResizeHandler | null>(null);
export type NodeRetryHandler = (nodeId: string) => void | Promise<void>;
export const NodeRetryContext = createContext<NodeRetryHandler | null>(null);
export type NodeEnabledHandler = (nodeId: string, enabled: boolean) => void;
export const NodeEnabledContext = createContext<NodeEnabledHandler | null>(null);

type NodePresentationState = 'empty' | 'running' | 'failed' | 'cancelled' | 'preview' | 'missing';

export function AssetNode({ id, data, selected }: NodeProps<AssetFlowNode>) {
  const selectNode = useContext(NodeSelectionContext);
  const resizeNode = useContext(NodeResizeContext);
  const retryNode = useContext(NodeRetryContext);
  const setNodeEnabled = useContext(NodeEnabledContext);
  const [previewLoadState, setPreviewLoadState] = useState<AssetPreviewLoadState | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const Icon = mediaIcons[data.mediaType];
  const Resizer = NodeResizer;
  const enabled = data.enabled !== false;
  const resultPreviewAsset = data.resultAsset
    ? ({
        id: data.resultAsset.assetId,
        name: `${data.label}结果`,
        mediaType: data.mediaType,
        mimeType: data.resultAsset.mimeType ?? data.mimeType ?? 'application/octet-stream',
        sizeBytes: data.resultAsset.sizeBytes ?? 0,
        status: 'ready',
        contentUrl: data.resultAsset.contentUrl ?? '',
        tags: [],
      } satisfies Asset)
    : undefined;
  const previewAsset =
    resultPreviewAsset ??
    (data.assetId && data.contentUrl
      ? ({
          id: data.assetId,
          name: data.label,
          mediaType: data.mediaType,
          mimeType: data.mimeType ?? 'application/octet-stream',
          sizeBytes: 0,
          status: 'ready',
          contentUrl: data.contentUrl,
          tags: [],
        } satisfies Asset)
      : undefined);
  const previewIdentity = previewAsset
    ? `${previewAsset.id}:${previewAsset.contentUrl}:${previewAsset.mimeType}`
    : '';
  const presentationState = getNodePresentationState(data, previewAsset);
  const effectivePreviewLoadState = previewAsset?.contentUrl
    ? (previewLoadState ?? 'loading')
    : 'missing';
  const canRetry = Boolean(retryNode) && data.mode !== 'source';
  const handlePreviewLoadState = useCallback((state: AssetPreviewLoadState) => {
    setPreviewLoadState(state);
  }, []);

  useEffect(() => {
    setPreviewLoadState(null);
  }, [previewIdentity]);

  useEffect(() => {
    setRetryError(null);
    setIsRetrying(false);
  }, [data.runStatus]);

  const handleRetry = async () => {
    if (!retryNode || isRetrying) return;
    setIsRetrying(true);
    setRetryError(null);
    try {
      await retryNode(id);
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : '重试提交失败');
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div
      className={`flow-asset-node ${data.mode !== 'source' ? 'flow-generate-node' : ''} ${selected ? 'is-selected' : ''} ${enabled ? '' : 'is-disabled'}`}
      aria-disabled={!enabled}
      onClickCapture={() => selectNode?.(data)}
    >
      {Resizer ? (
        <Resizer
          isVisible={Boolean(selected)}
          minWidth={180}
          minHeight={140}
          color="#18794e"
          handleStyle={{ width: 9, height: 9, borderRadius: 2 }}
          onResizeEnd={(_, params) => {
            if (resizeNode && id && params.width > 0 && params.height > 0) {
              resizeNode(id, params.width, params.height);
            }
          }}
        />
      ) : null}
      <NodeHandles mediaType={data.mediaType} mode={data.mode} />
      <div className="flow-node-header">
        <span className={`media-icon media-icon-${data.mediaType}`}>
          <Icon size={15} strokeWidth={2} aria-hidden="true" />
        </span>
        <span className="flow-node-type">{mediaLabels[data.mediaType]}</span>
        <span
          className={`flow-node-mode-badge flow-node-mode-${data.mode}`}
          title={`${modeLabels[data.mode]}模式`}
        >
          {data.mode === 'generate' ? (
            <Sparkles size={10} aria-hidden="true" />
          ) : data.mode === 'transform' ? (
            <Wand2 size={10} aria-hidden="true" />
          ) : null}
          {modeLabels[data.mode]}
        </span>
        {!enabled && <span className="flow-node-disabled-badge">停用</span>}
        {data.stale && <span className="flow-node-stale-badge">待更新</span>}
        {setNodeEnabled ? (
          <button
            type="button"
            className="flow-node-enabled-toggle nodrag nopan nowheel"
            aria-label={enabled ? '停用节点' : '启用节点'}
            aria-pressed={enabled}
            title={enabled ? '停用节点' : '启用节点'}
            onClick={() => setNodeEnabled(id, !enabled)}
          >
            <Power size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : null}
        <span
          className={`flow-node-status ${effectivePreviewLoadState === 'error' || presentationState === 'missing' ? 'is-error' : ''}`}
        >
          <RunStatusIcon
            status={data.runStatus}
            artifactState={
              presentationState === 'preview'
                ? effectivePreviewLoadState
                : presentationState === 'missing'
                  ? 'missing'
                  : undefined
            }
          />
        </span>
      </div>
      {presentationState === 'preview' && previewAsset ? (
        <div className="flow-node-preview">
          <AssetPreview
            asset={previewAsset}
            className="flow-node-preview-content"
            mode="content"
            onLoadStateChange={handlePreviewLoadState}
          />
        </div>
      ) : (
        <NodeStateContent
          state={presentationState}
          status={data.runStatus}
          progress={data.runProgress}
          error={data.runError}
          canRetry={
            canRetry &&
            (presentationState === 'failed' ||
              presentationState === 'cancelled' ||
              presentationState === 'missing')
          }
          isRetrying={isRetrying}
          retryError={retryError}
          onRetry={() => void handleRetry()}
          emptyLabel={data.mode === 'source' ? '资源内容不可用' : '尚未生成'}
          icon={<Icon size={24} strokeWidth={1.7} aria-hidden="true" />}
        />
      )}
      <div className="flow-node-label" title={data.label}>
        {data.label}
      </div>
    </div>
  );
}

function NodeStateContent({
  state,
  status,
  progress,
  error,
  canRetry,
  isRetrying,
  retryError,
  onRetry,
  emptyLabel,
  icon,
}: {
  state: NodePresentationState;
  status?: RunStatus;
  progress?: number;
  error?: string;
  canRetry: boolean;
  isRetrying: boolean;
  retryError: string | null;
  onRetry: () => void;
  emptyLabel: string;
  icon: ReactNode;
}) {
  if (state === 'running') {
    return (
      <div
        className="flow-node-placeholder flow-node-runtime-state"
        role="status"
        aria-live="polite"
      >
        <LoaderCircle className="spin" size={22} aria-hidden="true" />
        <span>{status ? runStatusLabel(status) : '运行中'}</span>
        {typeof progress === 'number' ? (
          <span className="flow-node-progress" aria-label={`运行进度 ${progress}%`}>
            {progress}%
          </span>
        ) : null}
      </div>
    );
  }

  if (state === 'failed' || state === 'cancelled' || state === 'missing') {
    const message =
      state === 'missing'
        ? '产物不存在或已失效'
        : state === 'cancelled'
          ? '运行已取消'
          : error || '生成失败，请检查运行详情';
    return (
      <div className="flow-node-placeholder flow-node-runtime-state is-error" role="alert">
        {state === 'cancelled' ? (
          <X size={21} aria-hidden="true" />
        ) : (
          <TriangleAlert size={21} aria-hidden="true" />
        )}
        <span className="flow-node-state-message" title={message}>
          {message}
        </span>
        {canRetry ? (
          <button
            type="button"
            className="flow-node-retry nodrag nopan"
            onClick={onRetry}
            disabled={isRetrying}
          >
            {isRetrying ? (
              <LoaderCircle className="spin" size={13} aria-hidden="true" />
            ) : (
              <RefreshCw size={13} aria-hidden="true" />
            )}
            {isRetrying ? '提交中…' : '重试生成'}
          </button>
        ) : null}
        {retryError ? <span className="flow-node-retry-error">{retryError}</span> : null}
      </div>
    );
  }

  if (state === 'preview') return null;

  return (
    <div className="flow-node-placeholder">
      {icon}
      <span>{emptyLabel}</span>
    </div>
  );
}

function RunStatusIcon({
  status,
  artifactState,
}: {
  status?: RunStatus;
  artifactState?: AssetPreviewLoadState;
}) {
  if (artifactState === 'error') return <X size={12} aria-label="产物加载失败" />;
  if (artifactState === 'missing') return <TriangleAlert size={12} aria-label="产物不可用" />;
  if (artifactState === 'loading') {
    return <LoaderCircle className="spin" size={12} aria-label="产物加载中" />;
  }
  if (status === 'succeeded') return <Check size={12} aria-label="运行成功" />;
  if (status === 'failed' || status === 'cancelled') return <X size={12} aria-label="运行失败" />;
  if (status === 'queued' || status === 'preparing' || status === 'cancel_requested') {
    return <Clock3 size={12} aria-label="等待运行" />;
  }
  if (status === 'running' || status === 'processing') {
    return <LoaderCircle className="spin" size={12} aria-label="运行中" />;
  }
  return <Circle size={10} aria-label="未运行" />;
}

function getNodePresentationState(
  data: AssetFlowNode['data'],
  previewAsset?: Asset,
): NodePresentationState {
  if (
    data.runStatus === 'queued' ||
    data.runStatus === 'preparing' ||
    data.runStatus === 'running' ||
    data.runStatus === 'processing' ||
    data.runStatus === 'cancel_requested'
  ) {
    return 'running';
  }
  if (data.runStatus === 'failed') return 'failed';
  if (data.runStatus === 'cancelled') return 'cancelled';
  if (data.runStatus === 'succeeded' && !previewAsset?.contentUrl) return 'missing';
  if (previewAsset?.contentUrl) return 'preview';
  if (data.mode === 'source') return 'missing';
  return 'empty';
}

export function runStatusLabel(status: RunStatus) {
  const labels: Record<RunStatus, string> = {
    draft: '草稿',
    queued: '排队中',
    preparing: '准备中',
    running: '运行中',
    processing: '处理中',
    succeeded: '已完成',
    failed: '失败',
    cancel_requested: '取消中',
    cancelled: '已取消',
  };
  return labels[status];
}

export const nodeTypes = {
  text: AssetNode,
  image: AssetNode,
  audio: AssetNode,
  video: AssetNode,
};
