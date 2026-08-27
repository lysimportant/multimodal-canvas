import { Check, Circle, Clock3, LoaderCircle, Sparkles, Wand2, X } from 'lucide-react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { createContext, useContext } from 'react';

import type { Asset, RunStatus } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import { NodeHandles } from '../NodeHandles';
import { AssetPreview } from './AssetPreview';
import { mediaIcons, mediaLabels, modeLabels } from './contracts';

export type NodeSelectionHandler = (data: AssetFlowNode['data']) => void;
export const NodeSelectionContext = createContext<NodeSelectionHandler | null>(null);
export type NodeResizeHandler = (nodeId: string, width: number, height: number) => void;
export const NodeResizeContext = createContext<NodeResizeHandler | null>(null);

function AssetNode({ id, data, selected }: NodeProps<AssetFlowNode>) {
  const selectNode = useContext(NodeSelectionContext);
  const resizeNode = useContext(NodeResizeContext);
  const Icon = mediaIcons[data.mediaType];
  const Resizer = NodeResizer;
  const enabled = data.enabled !== false;
  const resultPreviewAsset = data.resultAsset?.contentUrl
    ? ({
        id: data.resultAsset.assetId,
        name: `${data.label}结果`,
        mediaType: data.mediaType,
        mimeType: data.resultAsset.mimeType ?? data.mimeType ?? 'application/octet-stream',
        sizeBytes: data.resultAsset.sizeBytes ?? 0,
        status: 'ready',
        contentUrl: data.resultAsset.contentUrl,
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
        <span className="flow-node-status">
          <RunStatusIcon status={data.runStatus} />
        </span>
      </div>
      {previewAsset ? (
        <div className="flow-node-preview">
          <AssetPreview asset={previewAsset} className="flow-node-preview-content" />
        </div>
      ) : (
        <div className="flow-node-placeholder">
          <Icon size={24} strokeWidth={1.7} aria-hidden="true" />
          <span>{data.runStatus ? runStatusLabel(data.runStatus) : '等待运行'}</span>
        </div>
      )}
      <div className="flow-node-label" title={data.label}>
        {data.label}
      </div>
    </div>
  );
}

function RunStatusIcon({ status }: { status?: RunStatus }) {
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
