import {
  Check,
  Circle,
  Clock3,
  Download,
  GripVertical,
  Info,
  LoaderCircle,
  Pencil,
  Power,
  RefreshCw,
  Trash2,
  Upload,
  TriangleAlert,
  WandSparkles,
  X,
} from 'lucide-react';
import { NodeResizer, useEdges, useViewport, type NodeProps } from '@xyflow/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type CSSProperties,
} from 'react';

import type { Asset, PortRole, RunStatus, VideoMode } from '@multimodal-canvas/domain';
import {
  displayVideoMode,
  isImageEditSourceNode,
  videoModeLabels,
} from '@multimodal-canvas/domain';
import { nodeHasPrompt } from './fork-generate-node';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@multimodal-canvas/ui';
import { fitNodeSizeToContent, type AssetFlowNode } from '../canvas-utils';
import { isImeKeyboardEvent } from '../ime';
import { NodeHandles, videoInputRoleLabel } from '../NodeHandles';
import { AssetPreview, type AssetPreviewLoadState } from './AssetPreview';
import { downloadProjectExport } from '../export-utils';
import { fetchNodeAssetDownload } from './node-asset-download';
import { mediaIcons, mediaLabels, modeLabels } from './contracts';
import './asset-node.css';

export type NodeSelectionHandler = (data: AssetFlowNode['data']) => void;
export const NodeSelectionContext = createContext<NodeSelectionHandler | null>(null);
/** 当前已打开输入编辑器的节点 ID；框选或全选状态不能代替实际编辑器状态。 */
export const NodeQuickEditorIdContext = createContext<string | null>(null);
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
/** 手动内容替换交由画布完成上传、历史记录与持久化；失败拒绝 Promise。 */
export type NodeContentHandlers = {
  upload: (nodeId: string, file: File, onProgress: (value: number) => void) => Promise<void>;
  saveText: (nodeId: string, text: string) => Promise<void>;
};
/** 节点内容写入能力，只在已加载的项目画布中提供。 */
export const NodeContentContext = createContext<NodeContentHandlers | null>(null);
/**
 * “修改图片”入口。回调只携带来源节点 ID，由画布层按「新节点」路径立刻图生图；
 * 来源节点本身不会被覆盖。
 */
export type NodeImageEditHandler = (nodeId: string) => void;
export const NodeImageEditContext = createContext<NodeImageEditHandler | null>(null);

type NodePresentationState = 'empty' | 'running' | 'failed' | 'cancelled' | 'preview' | 'missing';

/**
 * 悬浮栏图标旁的功能简述，始终与图标一起显示。
 * @param children 简短中文功能名。
 */
function NodeFloatingActionLabel({ children }: { children: ReactNode }) {
  return <span className="flow-node-action-label">{children}</span>;
}

/** 展示节点占位或产物；生成节点的控制栏悬浮在内容上方，不参与尺寸计算。 */
export function AssetNode({ id, data, selected, width, height }: NodeProps<AssetFlowNode>) {
  const { zoom } = useViewport();
  const incomingEdges = useEdges();
  const selectNode = useContext(NodeSelectionContext);
  const quickEditorNodeId = useContext(NodeQuickEditorIdContext);
  const changeLabel = useContext(NodeLabelChangeContext);
  const resizeNode = useContext(NodeResizeContext);
  const resizeStart = useContext(NodeResizeStartContext);
  const retryNode = useContext(NodeRetryContext);
  const setNodeEnabled = useContext(NodeEnabledContext);
  const deleteNode = useContext(NodeDeleteContext);
  const contentHandlers = useContext(NodeContentContext);
  const editImage = useContext(NodeImageEditContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  /** 用户拖拽改过尺寸后，不再用回显内容覆盖宽高。 */
  const userResizedRef = useRef(false);
  /** 当前下载请求；切换节点产物或卸载时取消，防止下载过时内容。 */
  const downloadAbort = useRef<AbortController | null>(null);
  /** 下载请求状态独立于上传，不阻塞节点内容编辑。 */
  const [isDownloading, setIsDownloading] = useState(false);
  /** 保留下载失败信息，用户可以再次点击下载按钮重试。 */
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [previewLoadState, setPreviewLoadState] = useState<AssetPreviewLoadState | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [draftLabel, setDraftLabel] = useState(data.label);
  const renameTitleId = useId();
  const infoTitleId = useId();
  const Icon = mediaIcons[data.mediaType];
  const Resizer = NodeResizer;
  const enabled = data.enabled !== false;
  /** 全部节点共用悬浮操作栏，保持内容区域固定尺寸。 */
  const floatingControls = true;
  const resultPreviewAsset =
    !data.manualOutput && data.resultAsset
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
  useEffect(() => {
    userResizedRef.current = false;
  }, [previewIdentity]);
  const writingDisabled = presentationState === 'running' || uploadProgress !== null;
  /** 仅图片和视频提供下载，下载内容始终与当前回显产物一致。 */
  const downloadableMedia = data.mediaType === 'image' || data.mediaType === 'video';
  /** 抵消画布缩放，让悬浮栏保持屏幕像素大小；宽度随图标和文字收缩。 */
  const floatingControlStyle = {
    '--flow-node-zoom': zoom,
    '--flow-node-inverse-zoom': 1 / zoom,
  } as CSSProperties;
  /** 文件选择和拖放共用同一上传入口，错误保留可重试文件。 */
  const uploadFile = async (file: File) => {
    if (!contentHandlers || writingDisabled || uploadLock.current) return;
    uploadLock.current = true;
    setRetryFile(file);
    setUploadProgress(0);
    setUploadError(null);
    try {
      await contentHandlers.upload(id, file, setUploadProgress);
      setRetryFile(null);
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : '上传失败');
    } finally {
      uploadLock.current = false;
      setUploadProgress(null);
    }
  };
  const effectivePreviewLoadState = previewAsset?.contentUrl
    ? (previewLoadState ?? 'loading')
    : 'missing';
  const canRetry = Boolean(retryNode) && data.mode !== 'source';
  const handlePreviewLoadState = useCallback((state: AssetPreviewLoadState) => {
    setPreviewLoadState(state);
  }, []);
  const handleNaturalSize = useCallback(
    (naturalWidth: number, naturalHeight: number) => {
      if (userResizedRef.current || !resizeNode || !id) return;
      const next = fitNodeSizeToContent(naturalWidth, naturalHeight);
      if (
        width !== undefined &&
        height !== undefined &&
        Math.abs(width - next.width) < 2 &&
        Math.abs(height - next.height) < 2
      ) {
        return;
      }
      resizeNode(id, next.width, next.height);
    },
    [height, id, resizeNode, width],
  );

  useEffect(() => {
    setPreviewLoadState(null);
    setDownloadError(null);
    setIsDownloading(false);
    return () => {
      downloadAbort.current?.abort();
      downloadAbort.current = null;
    };
  }, [previewIdentity]);

  useEffect(() => {
    setRetryError(null);
    setIsRetrying(false);
  }, [data.runStatus]);

  useEffect(() => {
    if (!renameOpen) setDraftLabel(data.label);
  }, [data.label, renameOpen]);

  /** 打开重命名对话框并带上当前名称。 */
  const openRename = () => {
    setDraftLabel(data.label);
    setRenameOpen(true);
  };

  /** 关闭重命名对话框并丢弃未提交草稿。 */
  const cancelRename = () => {
    setDraftLabel(data.label);
    setRenameOpen(false);
  };

  /** 保存非空名称；空白名称恢复原值，实际修改交给画布记录历史。 */
  const commitLabel = useCallback(() => {
    const nextLabel = draftLabel.trim();
    setRenameOpen(false);
    setDraftLabel(nextLabel || data.label);
    if (nextLabel && nextLabel !== data.label) changeLabel?.(id, nextLabel);
  }, [changeLabel, data.label, draftLabel, id]);

  /** Enter 保存名称；输入法确认键不提交。 */
  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || isImeKeyboardEvent(event)) return;
    event.preventDefault();
    commitLabel();
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

  /** 拉取当前版本内容并触发浏览器保存；失败显示错误，取消不产生下载。 */
  const handleDownload = async () => {
    if (!previewAsset?.contentUrl || downloadAbort.current) return;
    const abort = new AbortController();
    downloadAbort.current = abort;
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const download = await fetchNodeAssetDownload(previewAsset, abort.signal);
      if (!abort.signal.aborted) downloadProjectExport(download);
    } catch (reason) {
      if (!abort.signal.aborted) {
        setDownloadError(reason instanceof Error ? reason.message : '下载失败，请重试');
      }
    } finally {
      if (downloadAbort.current === abort) {
        downloadAbort.current = null;
        setIsDownloading(false);
      }
    }
  };

  /** 悬浮栏左侧名称；点击打开重命名对话框。 */
  const nodeLabel = (
    <div className="flow-node-label" title={data.label}>
      {changeLabel ? (
        <button
          type="button"
          className="flow-node-label-button nodrag nopan nowheel"
          aria-label={`重命名节点：${data.label}`}
          title="重命名节点"
          onClick={(event) => {
            event.stopPropagation();
            openRename();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              openRename();
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
  const statusTooltip = nodeStatusTooltip(
    data.runStatus,
    presentationState === 'preview'
      ? effectivePreviewLoadState
      : presentationState === 'missing'
        ? 'missing'
        : undefined,
  );

  return (
    <div
      className={`flow-asset-node ${data.mode !== 'source' ? 'flow-generate-node' : ''} ${selected ? 'is-selected' : ''} ${enabled ? '' : 'is-disabled'}`}
      aria-disabled={!enabled}
      onClickCapture={() => selectNode?.(data)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer.files.length !== 1) setUploadError('每次只能替换一个文件');
          else void uploadFile(event.dataTransfer.files[0]);
        }
      }}
    >
      {Resizer ? (
        <Resizer
          isVisible={Boolean(selected)}
          minWidth={180}
          minHeight={140}
          color="#18794e"
          handleStyle={{ width: 18, height: 18, borderRadius: 4 }}
          lineStyle={{ borderWidth: 2 }}
          onResizeStart={() => {
            userResizedRef.current = true;
            if (resizeStart && id) resizeStart(id);
          }}
          onResizeEnd={(_, params) => {
            if (resizeNode && id && params.width > 0 && params.height > 0) {
              resizeNode(id, params.width, params.height);
            }
          }}
        />
      ) : null}
      <NodeHandles
        mediaType={data.mediaType}
        mode={data.mode}
        videoMode={data.videoMode}
        modelAlias={data.modelAlias}
      />
      {data.mediaType === 'video' && data.mode === 'generate' ? (
        <VideoInputSummary nodeId={id} edges={incomingEdges} videoMode={data.videoMode} />
      ) : null}
      {contentHandlers ? (
        <input
          ref={inputRef}
          type="file"
          hidden
          aria-label={`上传到节点：${data.label}`}
          accept={
            data.mediaType === 'text' ? '.txt,.md,text/plain,text/markdown' : `${data.mediaType}/*`
          }
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void uploadFile(file);
          }}
        />
      ) : null}
      <div
        className={`flow-node-header${floatingControls ? ' flow-node-floating-controls' : ''}`}
        style={floatingControlStyle}
        role="group"
        aria-label={`节点操作：${data.label}`}
        aria-disabled={false}
      >
        {floatingControls ? (
          <>
            {changeLabel ? (
              <button
                type="button"
                className="flow-node-action-button flow-node-label-button nodrag nopan nowheel"
                aria-label={`重命名节点：${data.label}`}
                title="重命名节点"
                onClick={(event) => {
                  event.stopPropagation();
                  openRename();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    openRename();
                  }
                }}
              >
                <Pencil size={18} aria-hidden="true" />
                <NodeFloatingActionLabel>重命名</NodeFloatingActionLabel>
              </button>
            ) : null}
            <button
              type="button"
              className="flow-node-action-button flow-node-drag-handle"
              aria-label="拖动移动节点"
              title="拖动移动节点"
            >
              <GripVertical size={18} aria-hidden="true" />
              <NodeFloatingActionLabel>移动</NodeFloatingActionLabel>
            </button>
            <button
              type="button"
              className={`flow-node-action-button flow-node-info-button nodrag nopan nowheel${data.stale ? ' is-stale' : ''}`}
              aria-label="查看节点信息"
              title={data.stale ? '查看节点信息（待更新）' : '查看节点信息'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setInfoOpen(true);
              }}
            >
              <Info size={18} aria-hidden="true" />
              <NodeFloatingActionLabel>信息</NodeFloatingActionLabel>
            </button>
            {setNodeEnabled ? (
              <button
                type="button"
                className="flow-node-action-button flow-node-enabled-toggle nodrag nopan nowheel"
                aria-label={enabled ? '停用节点' : '启用节点'}
                aria-pressed={enabled}
                title={enabled ? '停用节点' : '启用节点'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setNodeEnabled(id, !enabled);
                }}
              >
                <Power size={18} strokeWidth={2.2} aria-hidden="true" />
                <NodeFloatingActionLabel>{enabled ? '停用' : '启用'}</NodeFloatingActionLabel>
              </button>
            ) : null}
            <span
              className={`flow-node-action-button flow-node-status ${
                effectivePreviewLoadState === 'error' || presentationState === 'missing'
                  ? 'is-error'
                  : ''
              }`}
              title={statusTooltip}
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
              <NodeFloatingActionLabel>{statusTooltip}</NodeFloatingActionLabel>
            </span>
            {contentHandlers && (
              <button
                type="button"
                className="flow-node-action-button flow-node-upload-button nodrag nopan nowheel"
                disabled={writingDisabled}
                aria-label={`上传到节点：${data.label}`}
                title="上传并替换节点内容"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  inputRef.current?.click();
                }}
              >
                {uploadProgress === null ? (
                  <Upload size={18} aria-hidden="true" />
                ) : (
                  <LoaderCircle className="spin" size={18} aria-hidden="true" />
                )}
                <NodeFloatingActionLabel>
                  {uploadProgress === null ? '上传' : '上传中'}
                </NodeFloatingActionLabel>
              </button>
            )}
            {editImage && isImageEditSourceNode({ data }) ? (
              <button
                type="button"
                className="flow-node-action-button flow-node-edit-image-button nodrag nopan nowheel"
                disabled={writingDisabled || !nodeHasPrompt(data)}
                aria-label={`修改图片：${data.label}`}
                title={
                  writingDisabled
                    ? '节点正在运行或保存，请稍后再修改图片'
                    : !nodeHasPrompt(data)
                      ? '请先填写提示词'
                      : '修改图片：把当前回显作为原图，结果写到新节点'
                }
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  // 与上传一致：运行或保存期间不进入编辑流程，避免半成品节点。
                  if (writingDisabled) return;
                  editImage(id);
                }}
              >
                <WandSparkles size={18} aria-hidden="true" />
                <NodeFloatingActionLabel>修改图片</NodeFloatingActionLabel>
              </button>
            ) : null}
            {downloadableMedia && (
              <button
                type="button"
                className="flow-node-action-button flow-node-download-button nodrag nopan nowheel"
                disabled={!previewAsset?.contentUrl || isDownloading}
                aria-label={`下载${mediaLabels[data.mediaType]}`}
                aria-busy={isDownloading}
                title={
                  isDownloading
                    ? '正在准备下载'
                    : previewAsset?.contentUrl
                      ? `下载${mediaLabels[data.mediaType]}`
                      : '暂无可下载内容'
                }
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDownload();
                }}
              >
                {isDownloading ? (
                  <LoaderCircle className="spin" size={18} aria-hidden="true" />
                ) : (
                  <Download size={18} aria-hidden="true" />
                )}
                <NodeFloatingActionLabel>
                  {isDownloading ? '下载中' : '下载'}
                </NodeFloatingActionLabel>
              </button>
            )}
            {deleteNode ? (
              <button
                type="button"
                className="flow-node-action-button flow-node-delete-button nodrag nopan nowheel"
                aria-label={`删除节点：${data.label}`}
                title="删除节点"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  deleteNode(id);
                }}
              >
                <Trash2 size={18} strokeWidth={2.2} aria-hidden="true" />
                <NodeFloatingActionLabel>删除</NodeFloatingActionLabel>
              </button>
            ) : null}
          </>
        ) : (
          <>
            <span className="flow-node-type">{mediaLabels[data.mediaType]}</span>
            <span
              className={`flow-node-mode-badge flow-node-mode-${data.mode}`}
              title={`${modeLabels[data.mode]}模式`}
            >
              {modeLabels[data.mode]}
            </span>
            {!enabled && <span className="flow-node-disabled-badge">停用</span>}
            {data.stale && (
              <span className="flow-node-stale-badge" title="上游内容已变更，节点待更新">
                待更新
              </span>
            )}
          </>
        )}
        {floatingControls ? null : (
          <>
            {setNodeEnabled ? (
              <button
                type="button"
                className="flow-node-enabled-toggle nodrag nopan nowheel"
                aria-label={enabled ? '停用节点' : '启用节点'}
                aria-pressed={enabled}
                title={enabled ? '停用节点' : '启用节点'}
                onClick={() => setNodeEnabled(id, !enabled)}
              >
                <Power size={18} strokeWidth={2.2} aria-hidden="true" />
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
          </>
        )}
      </div>
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          if (open) openRename();
          else cancelRename();
        }}
      >
        {renameOpen && (
          <DialogContent
            className="flow-node-dialog"
            overlayClassName="flow-node-dialog-backdrop"
            aria-labelledby={renameTitleId}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="flow-node-dialog-header">
              <DialogTitle id={renameTitleId}>重命名节点</DialogTitle>
              <DialogClose asChild>
                <button
                  type="button"
                  className="flow-node-dialog-close"
                  aria-label="关闭重命名"
                  title="关闭"
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </DialogClose>
            </div>
            <label className="flow-node-dialog-field">
              <span>节点名称</span>
              <input
                className="flow-node-label-input"
                aria-label="编辑节点名称"
                placeholder="输入节点名称"
                value={draftLabel}
                autoFocus
                onChange={(event) => setDraftLabel(event.currentTarget.value)}
                onKeyDown={handleRenameKeyDown}
              />
            </label>
            <div className="flow-node-dialog-actions">
              <button type="button" className="flow-node-dialog-secondary" onClick={cancelRename}>
                取消
              </button>
              <button type="button" className="flow-node-dialog-primary" onClick={commitLabel}>
                保存
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        {infoOpen && (
          <DialogContent
            className="flow-node-dialog"
            overlayClassName="flow-node-dialog-backdrop"
            aria-labelledby={infoTitleId}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="flow-node-dialog-header">
              <DialogTitle id={infoTitleId}>节点信息</DialogTitle>
              <DialogClose asChild>
                <button
                  type="button"
                  className="flow-node-dialog-close"
                  aria-label="关闭节点信息"
                  title="关闭"
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </DialogClose>
            </div>
            <p className="flow-node-dialog-intro">{nodeIntroduction(data)}</p>
            <dl className="flow-node-info-list">
              <div>
                <dt>名称</dt>
                <dd>{data.label}</dd>
              </div>
              <div>
                <dt>类型</dt>
                <dd>{mediaLabels[data.mediaType]}</dd>
              </div>
              <div>
                <dt>模式</dt>
                <dd>{modeLabels[data.mode]}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{enabled ? '已启用' : '已停用'}</dd>
              </div>
              <div>
                <dt>运行</dt>
                <dd>{data.runStatus ? runStatusLabel(data.runStatus) : '未运行'}</dd>
              </div>
              {data.stale ? (
                <div>
                  <dt>更新</dt>
                  <dd>上游已变更，节点待更新</dd>
                </div>
              ) : null}
            </dl>
          </DialogContent>
        )}
      </Dialog>
      {presentationState === 'preview' && previewAsset ? (
        <div className="flow-node-preview">
          <AssetPreview
            asset={previewAsset}
            className="flow-node-preview-content"
            mode="content"
            mediaClickPreviewEnabled={quickEditorNodeId === id}
            onTextSave={
              contentHandlers && !writingDisabled
                ? (text) => contentHandlers.saveText(id, text)
                : undefined
            }
            onLoadStateChange={handlePreviewLoadState}
            onNaturalSize={handleNaturalSize}
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
      {isDownloading && (
        <span className="flow-node-download-feedback" role="status">
          正在准备下载…
        </span>
      )}
      {downloadError && (
        <div className="flow-node-download-feedback is-error nodrag nopan" role="alert">
          {downloadError}
        </div>
      )}
      {uploadProgress !== null && (
        <span className="flow-node-upload-feedback" role="status">
          上传 {uploadProgress}%
        </span>
      )}
      {uploadError && (
        <div className="flow-node-upload-feedback is-error nodrag nopan" role="alert">
          {uploadError}
          {retryFile && (
            <button type="button" onClick={() => void uploadFile(retryFile)}>
              重试
            </button>
          )}
        </div>
      )}
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

/**
 * 按节点模式和媒体类型生成简短介绍，供信息对话框展示。
 * @param data 当前节点数据。
 * @returns 中文介绍文案。
 */
function nodeIntroduction(data: AssetFlowNode['data']): string {
  const media = mediaLabels[data.mediaType];
  if (data.mode === 'source') {
    return `来源${media}节点，把已有${media}素材放入画布，供下游节点引用。`;
  }
  return `生成${media}节点，根据提示词和上游输入生成${media}。`;
}

/**
 * 悬浮栏状态图标的文字提示。
 * @param status 运行状态。
 * @param artifactState 产物加载状态。
 * @returns 提示文案。
 */
function nodeStatusTooltip(status?: RunStatus, artifactState?: AssetPreviewLoadState): string {
  if (artifactState === 'error') return '产物加载失败';
  if (artifactState === 'missing') return '产物不可用';
  if (artifactState === 'loading') return '产物加载中';
  if (!status) return '未运行';
  return runStatusLabel(status);
}

function RunStatusIcon({
  status,
  artifactState,
}: {
  status?: RunStatus;
  artifactState?: AssetPreviewLoadState;
}) {
  if (artifactState === 'error') return <X size={16} aria-label="产物加载失败" />;
  if (artifactState === 'missing') return <TriangleAlert size={16} aria-label="产物不可用" />;
  if (artifactState === 'loading') {
    return <LoaderCircle className="spin" size={16} aria-label="产物加载中" />;
  }
  if (status === 'succeeded') return <Check size={16} aria-label="运行成功" />;
  if (status === 'failed' || status === 'cancelled') return <X size={16} aria-label="运行失败" />;
  if (status === 'queued' || status === 'preparing' || status === 'cancel_requested') {
    return <Clock3 size={16} aria-label="等待运行" />;
  }
  if (status === 'running' || status === 'processing') {
    return <LoaderCircle className="spin" size={16} aria-label="运行中" />;
  }
  return <Circle size={14} aria-label="未运行" />;
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
  if (data.manualOutput && previewAsset?.contentUrl) return 'preview';
  if (data.runStatus === 'failed') return 'failed';
  if (data.runStatus === 'cancelled') return 'cancelled';
  if (data.runStatus === 'succeeded' && !previewAsset?.contentUrl) return 'missing';
  if (previewAsset?.contentUrl) return 'preview';
  if (data.mode === 'source') return 'missing';
  return 'empty';
}

/**
 * 当公共运行记录仅包含生成资产标识时，构造受保护的 API 路径。
 * 内联或仅有远程地址的结果没有本地资产边界，必须等待供应商 URL；
 * 缺少版本时使用资产最新版本端点，避免成功结果无法回显。
 */
function getResultAssetContentUrl(assetId: string, version?: number): string {
  if (!assetId || assetId.startsWith('inline_') || assetId.startsWith('remote_')) {
    return '';
  }
  const encodedId = encodeURIComponent(assetId);
  return version === undefined
    ? `/v1/assets/${encodedId}/content`
    : `/v1/assets/${encodedId}/versions/${version}/content`;
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

type IncomingEdge = { target?: string; targetHandle?: string | null };

/**
 * 视频节点的紧凑输入摘要。绝对定位在预览上方，不参与外部尺寸计算。
 */
function VideoInputSummary({
  nodeId,
  edges,
  videoMode,
}: {
  nodeId: string;
  edges: IncomingEdge[];
  videoMode?: VideoMode;
}) {
  const roles: PortRole[] = [];
  const counts = new Map<PortRole, number>();
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    const handle = edge.targetHandle ?? '';
    if (!handle.startsWith('input:')) continue;
    const role = handle.slice('input:'.length) as PortRole;
    roles.push(role);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  const resolvedMode = displayVideoMode({ videoMode }, roles);
  const chips = [...counts.entries()].map(([role, count]) => ({
    role,
    count,
    label: videoInputRoleLabel(role, resolvedMode),
  }));
  const total = chips.reduce((sum, chip) => sum + chip.count, 0);
  return (
    <div className="flow-node-input-summary" aria-label={`视频输入 ${total} 项`}>
      <span className="flow-node-input-chip">{videoModeLabels[resolvedMode]}</span>
      {chips.map((chip) => (
        <span key={chip.role} className="flow-node-input-chip">
          {chip.label}
          {chip.count > 1 ? ` ×${chip.count}` : ''}
        </span>
      ))}
    </div>
  );
}

export const nodeTypes = {
  text: AssetNode,
  image: AssetNode,
  audio: AssetNode,
  video: AssetNode,
};
