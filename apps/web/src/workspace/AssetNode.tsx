import {
  Check,
  Circle,
  Clock3,
  LoaderCircle,
  Power,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type { Asset, RunStatus } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import { NodeHandles } from '../NodeHandles';
import { AssetPreview, type AssetPreviewLoadState } from './AssetPreview';
import { mediaIcons, mediaLabels, modeLabels } from './contracts';
import './asset-node.css';

export type NodeSelectionHandler = (data: AssetFlowNode['data']) => void;
export const NodeSelectionContext = createContext<NodeSelectionHandler | null>(null);
/** 节点名称变更回调；由画布统一负责历史记录和持久化。 */
export type NodeLabelChangeHandler = (nodeId: string, label: string) => void;
export const NodeLabelChangeContext = createContext<NodeLabelChangeHandler | null>(null);
export type NodeResizeHandler = (nodeId: string, width: number, height: number) => void;
export const NodeResizeContext = createContext<NodeResizeHandler | null>(null);
export type NodeResizeStartHandler = (nodeId: string) => void;
export const NodeResizeStartContext = createContext<NodeResizeStartHandler | null>(null);
export type NodeRetryHandler = (nodeId: string) => void | Promise<void>;
export const NodeRetryContext = createContext<NodeRetryHandler | null>(null);
export type NodeEnabledHandler = (nodeId: string, enabled: boolean) => void;
export const NodeEnabledContext = createContext<NodeEnabledHandler | null>(null);
/** 删除指定节点；画布负责确认、关联边清理、撤销记录及持久化。 */
export type NodeDeleteHandler = (nodeId: string) => void;
/** 供节点顶部操作栏调用画布统一的删除行为。 */
export const NodeDeleteContext = createContext<NodeDeleteHandler | null>(null);

type NodePresentationState = 'empty' | 'running' | 'failed' | 'cancelled' | 'preview' | 'missing';

/** 展示节点占位或产物；生成与转换节点的控制栏悬浮在内容上方，不参与尺寸计算。 */
export function AssetNode({ id, data, selected }: NodeProps<AssetFlowNode>) {
  const selectNode = useContext(NodeSelectionContext);
  const changeLabel = useContext(NodeLabelChangeContext);
  const resizeNode = useContext(NodeResizeContext);
  const resizeStart = useContext(NodeResizeStartContext);
  const retryNode = useContext(NodeRetryContext);
  const setNodeEnabled = useContext(NodeEnabledContext);
  const deleteNode = useContext(NodeDeleteContext);
  const [previewLoadState, setPreviewLoadState] = useState<AssetPreviewLoadState | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState(false);
  const [draftLabel, setDraftLabel] = useState(data.label);
  const Icon = mediaIcons[data.mediaType];
  const Resizer = NodeResizer;
  const enabled = data.enabled !== false;
  /** 生成与转换节点共用仅由内容组成的外观，资源节点保留原卡片。 */
  const floatingControls = data.mode !== 'source';
  const resultPreviewAsset = data.resultAsset
    ? ({
        id: data.resultAsset.assetId,
        name: `${data.label}结果`,
        mediaType: data.mediaType,
        mimeType: data.resultAsset.mimeType ?? data.mimeType ?? 'application/octet-stream',
        sizeBytes: data.resultAsset.sizeBytes ?? 0,
        status: 'ready',
        // 公共运行记录会省略 contentUrl，但生成资产仍可通过受保护的资产边界访问。
        contentUrl:
          data.resultAsset.contentUrl ??
          getResultAssetContentUrl(data.resultAsset.assetId, data.resultAsset.version),
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

  useEffect(() => {
    if (!editingLabel) setDraftLabel(data.label);
  }, [data.label, editingLabel]);

  /** 保存非空名称；空白名称恢复原值，实际修改交给画布记录历史。 */
  const commitLabel = useCallback(() => {
    const nextLabel = draftLabel.trim();
    setEditingLabel(false);
    setDraftLabel(nextLabel || data.label);
    if (nextLabel && nextLabel !== data.label) changeLabel?.(id, nextLabel);
  }, [changeLabel, data.label, draftLabel, id]);

  /** Enter 保存名称，Escape 取消本次编辑。 */
  const handleLabelKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitLabel();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraftLabel(data.label);
      setEditingLabel(false);
    }
  };

  /** 提交重试并保留错误；同一节点在提交期间不重复发送请求。 */
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

  /** 顶部或资源卡片中的可编辑名称，键盘激活与双击均可开始编辑。 */
  const nodeLabel = (
    <div className="flow-node-label" title={data.label}>
      {editingLabel ? (
        <input
          className="flow-node-label-input nodrag nopan nowheel"
          aria-label="编辑节点名称"
          placeholder="输入节点名称"
          value={draftLabel}
          autoFocus
          onChange={(event) => setDraftLabel(event.currentTarget.value)}
          onBlur={commitLabel}
          onKeyDown={handleLabelKeyDown}
          onClick={(event) => event.stopPropagation()}
        />
      ) : changeLabel ? (
        <button
          type="button"
          className="flow-node-label-button nodrag nopan nowheel"
          aria-label={`重命名节点：${data.label}`}
          title="双击或按 Enter 修改节点名称"
          onDoubleClick={(event) => {
            event.stopPropagation();
            setEditingLabel(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              setEditingLabel(true);
            }
          }}
        >
          {data.label}
        </button>
      ) : (
        data.label
      )}
    </div>
  );

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
          handleStyle={{ width: 14, height: 14, borderRadius: 3 }}
          lineStyle={{ borderWidth: floatingControls ? 0 : 2 }}
          onResizeStart={() => {
            if (resizeStart && id) resizeStart(id);
          }}
          onResizeEnd={(_, params) => {
            if (resizeNode && id && params.width > 0 && params.height > 0) {
              resizeNode(id, params.width, params.height);
            }
          }}
        />
      ) : null}
      <NodeHandles mediaType={data.mediaType} mode={data.mode} />
      <div
        className={`flow-node-header${floatingControls ? ' flow-node-floating-controls' : ''}`}
        role="group"
        aria-label={`节点操作：${data.label}`}
        aria-disabled={false}
      >
        <span
          className={`media-icon media-icon-${data.mediaType}`}
          title={`${mediaLabels[data.mediaType]} · ${modeLabels[data.mode]}`}
        >
          <Icon size={15} strokeWidth={2} aria-hidden="true" />
        </span>
        {floatingControls ? (
          nodeLabel
        ) : (
          <span className="flow-node-type">{mediaLabels[data.mediaType]}</span>
        )}
        {!floatingControls && (
          <span
            className={`flow-node-mode-badge flow-node-mode-${data.mode}`}
            title={`${modeLabels[data.mode]}模式`}
          >
            {modeLabels[data.mode]}
          </span>
        )}
        {!enabled && !floatingControls && <span className="flow-node-disabled-badge">停用</span>}
        {data.stale && (
          <span className="flow-node-stale-badge" title="上游内容已变更，节点待更新">
            {floatingControls ? <RefreshCw size={11} aria-label="待更新" /> : '待更新'}
          </span>
        )}
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
        {deleteNode ? (
          <button
            type="button"
            className="flow-node-delete-button nodrag nopan nowheel"
            aria-label={`删除节点：${data.label}`}
            title="删除节点"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              deleteNode(id);
            }}
          >
            <Trash2 size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : null}
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
      {!floatingControls && nodeLabel}
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

/**
 * 当公共运行记录仅包含生成资产标识时，构造受保护的 API 路径。
 * 内联或仅有远程地址的结果没有本地资产边界，必须等待供应商 URL。
 */
function getResultAssetContentUrl(assetId: string, version?: number): string {
  if (
    !assetId ||
    version === undefined ||
    assetId.startsWith('inline_') ||
    assetId.startsWith('remote_')
  ) {
    return '';
  }
  const encodedId = encodeURIComponent(assetId);
  return `/v1/assets/${encodedId}/versions/${version}/content`;
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
