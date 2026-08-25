import {
  Archive,
  AudioLines,
  Circle,
  Check,
  ChevronDown,
  Clock3,
  ExternalLink,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  Plus,
  Pencil,
  RotateCcw,
  Search,
  Settings,
  SquarePlus,
  Redo2,
  Undo2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type NodeProps,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  mediaTypes,
  portRoles,
  targetPortRolesForMediaType,
  type Asset,
  type CanvasDocument,
  type MediaType,
  type NodeMode,
  type RunRecord,
  type RunResultAsset,
  type RunStatus,
} from '@multimodal-canvas/domain';
import {
  fromCanvasDocument,
  copyCanvasSelection,
  pasteCanvasClipboard,
  parseCanvasClipboard,
  serializeCanvasClipboard,
  toCanvasDocument,
  type CanvasClipboard,
  type AssetFlowNode,
  type FlowEdge,
} from './canvas-utils';
import {
  buildUploadCompletePayload,
  buildUploadInitPayload,
  resolveCompleteUrl,
  resolveUploadUrl,
  sha256Hex,
} from './upload-utils';
import { validateCanvasConnection } from './connection-utils';
import { isCanvasShortcutTarget } from './keyboard-utils';
import { validateAiSettingsForm, type AiSettingsFormErrors } from './settings-utils';
import { fetchAssetVersions, type AssetVersionSummary } from './result-versions';

import '@xyflow/react/dist/style.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ASSET_DRAG_TYPE = 'application/x-multimodal-asset';
const PROJECT_STORAGE_KEY = 'multimodal-canvas:project-id';
const CANVAS_DRAFT_KEY = 'multimodal-canvas:canvas';
const CANVAS_BACKGROUND_KEY = 'multimodal-canvas:background';

const mediaLabels: Record<MediaType, string> = {
  text: '文字',
  image: '图片',
  audio: '音频',
  video: '视频',
};

const inferenceStrengthOptions = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const;

type InferenceStrength = (typeof inferenceStrengthOptions)[number]['value'];

const modeLabels: Record<NodeMode, string> = {
  source: '来源',
  generate: '生成',
  transform: '转换',
};

const mediaIcons: Record<MediaType, typeof FileText> = {
  text: FileText,
  image: ImageIcon,
  audio: AudioLines,
  video: Video,
};

const portLabels: Record<(typeof portRoles)[number], string> = {
  prompt: '提示词',
  negativePrompt: '负面提示词',
  content: '内容',
  style: '风格',
  character: '角色',
  firstFrame: '首帧',
  lastFrame: '尾帧',
  audioTrack: '音轨',
  transcript: '转录',
  mask: '遮罩',
};

type AssetFilter = 'all' | MediaType;
type CanvasApiDocument = CanvasDocument;
type LocalCanvasDraft = {
  revision: number;
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
};

type CanvasHistorySnapshot = {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
};

type AiSettings = {
  baseUrl: string;
  configured: boolean;
  keyFingerprint?: string;
  defaultModels: Partial<Record<MediaType, string>>;
};

type ModelEntry = { id: string; name: string; mediaTypes: MediaType[] };

type ProjectSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type CanvasBackground = 'dots' | 'lines' | 'cross' | 'blank';

function getFocusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

const canvasBackgroundOptions: Array<{ value: CanvasBackground; label: string }> = [
  { value: 'dots', label: '点' },
  { value: 'lines', label: '线条' },
  { value: 'cross', label: '十字' },
  { value: 'blank', label: '空白' },
];

function readCanvasBackground(): CanvasBackground {
  if (typeof window === 'undefined') return 'dots';
  const stored = window.localStorage.getItem(CANVAS_BACKGROUND_KEY);
  return canvasBackgroundOptions.some((option) => option.value === stored)
    ? (stored as CanvasBackground)
    : 'dots';
}

async function uploadAsset(file: File, onProgress: (progress: number) => void) {
  const content = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(content);
  const mimeType = file.type || 'application/octet-stream';
  const metadata = {
    name: file.name,
    mimeType,
    sizeBytes: content.byteLength,
    sha256,
  };
  const initResponse = await fetch(`${API_BASE_URL}/v1/assets/uploads/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildUploadInitPayload(metadata)),
  });
  const initResult = (await initResponse.json().catch(() => ({}))) as {
    uploadId?: string;
    uploadUrl?: string;
    completeUrl?: string;
    error?: string;
  };
  if (
    !initResponse.ok ||
    !initResult.uploadId ||
    !initResult.uploadUrl ||
    !initResult.completeUrl
  ) {
    throw new Error(initResult.error ?? `${file.name} 上传初始化失败`);
  }

  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', resolveUploadUrl(initResult.uploadUrl!, API_BASE_URL));
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 90));
    };
    request.onerror = () => reject(new Error(`${file.name} 上传请求失败`));
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`${file.name} 上传失败（${request.status}）`));
        return;
      }
      onProgress(90);
      resolve();
    };
    request.send(content);
  });

  const completeResponse = await fetch(resolveCompleteUrl(initResult.completeUrl!, API_BASE_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildUploadCompletePayload(initResult.uploadId, metadata)),
  });
  const completeResult = (await completeResponse.json().catch(() => ({}))) as {
    asset?: Asset;
    error?: string;
  };
  if (!completeResponse.ok || !completeResult.asset) {
    throw new Error(completeResult.error ?? `${file.name} 上传完成确认失败`);
  }
  onProgress(100);
  return completeResult.asset;
}

function AssetPreview({ asset, className = '' }: { asset: Asset; className?: string }) {
  const src = resolveUploadUrl(asset.contentUrl, API_BASE_URL);
  if (asset.mediaType === 'image') {
    return <img className={`asset-preview-image ${className}`} src={src} alt={asset.name} />;
  }
  if (asset.mediaType === 'video') {
    return (
      <video className={`asset-preview-video ${className}`} src={src} muted preload="metadata" />
    );
  }
  if (asset.mediaType === 'audio') {
    return <AudioLines className={`asset-preview-audio ${className}`} aria-hidden="true" />;
  }
  return <FileText className={`asset-preview-text ${className}`} aria-hidden="true" />;
}

function AssetNode({ data, selected }: NodeProps<AssetFlowNode>) {
  const Icon = mediaIcons[data.mediaType];
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
      className={`flow-asset-node ${data.mode !== 'source' ? 'flow-generate-node' : ''} ${selected ? 'is-selected' : ''}`}
    >
      {data.mode !== 'source'
        ? targetPortRolesForMediaType(data.mediaType).map((role, index, roles) => (
            <Handle
              key={role}
              type="target"
              position={Position.Left}
              id={`input:${role}`}
              title={portLabels[role]}
              style={{ top: `${((index + 1) / (roles.length + 1)) * 100}%` }}
            />
          ))
        : null}
      <div className="flow-node-header">
        <span className={`media-icon media-icon-${data.mediaType}`}>
          <Icon size={15} strokeWidth={2} aria-hidden="true" />
        </span>
        <span className="flow-node-type">
          {mediaLabels[data.mediaType]}
          {modeLabels[data.mode]}节点
        </span>
        <span className="flow-node-status">
          <RunStatusIcon status={data.runStatus} />
        </span>
      </div>
      {previewAsset ? (
        <AssetPreview asset={previewAsset} className="flow-node-preview" />
      ) : (
        <div className="flow-node-placeholder">
          <Icon size={24} strokeWidth={1.7} aria-hidden="true" />
          <span>{data.runStatus ? runStatusLabel(data.runStatus) : '等待运行'}</span>
        </div>
      )}
      <div className="flow-node-label" title={data.label}>
        {data.label}
      </div>
      <Handle type="source" position={Position.Right} id={`output:${data.mediaType}`} />
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

function runStatusLabel(status: RunStatus) {
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

const nodeTypes = {
  text: AssetNode,
  image: AssetNode,
  audio: AssetNode,
  video: AssetNode,
};

function ResourcePanel({
  assets,
  showArchived,
  activeFilter,
  query,
  isUploading,
  uploadProgress,
  onFilterChange,
  onToggleArchived,
  onQueryChange,
  onFilesSelected,
  onAssetDragStart,
  onAddAsset,
  onRenameAsset,
  onArchiveAsset,
  onDrop,
}: {
  assets: Asset[];
  showArchived: boolean;
  activeFilter: AssetFilter;
  query: string;
  isUploading: boolean;
  uploadProgress: number | null;
  onFilterChange: (filter: AssetFilter) => void;
  onToggleArchived: () => void;
  onQueryChange: (query: string) => void;
  onFilesSelected: (files: FileList | File[]) => void;
  onAssetDragStart: (event: DragEvent, asset: Asset) => void;
  onAddAsset: (asset: Asset) => void;
  onRenameAsset: (asset: Asset) => void;
  onArchiveAsset: (asset: Asset) => void;
  onDrop: (event: DragEvent) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const filteredAssets = assets.filter((asset) => {
    if (showArchived !== (asset.status === 'archived')) return false;
    const matchesFilter = activeFilter === 'all' || asset.mediaType === activeFilter;
    return matchesFilter && asset.name.toLowerCase().includes(query.toLowerCase());
  });
  const counts = assets.reduce<Record<AssetFilter, number>>(
    (result, asset) => {
      result[asset.mediaType] += 1;
      result.all += 1;
      return result;
    },
    { all: 0, text: 0, image: 0, audio: 0, video: 0 },
  );

  return (
    <aside
      className="resource-panel"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">资源库</p>
          <h1>项目资源</h1>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="上传资源"
          title="上传资源"
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
        >
          {isUploading ? <LoaderCircle className="spin" size={17} /> : <Plus size={18} />}
        </button>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="image/*,audio/*,video/*,text/*,.md,.json"
          multiple
          onChange={(event) => {
            if (event.target.files) onFilesSelected(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      <label className="search-field">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          placeholder="搜索资源"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="clear-search"
            aria-label="清除搜索"
            onClick={() => onQueryChange('')}
          >
            <X size={14} />
          </button>
        )}
      </label>
      <nav className="resource-filters" aria-label="资源类型">
        {(['all', 'text', 'image', 'audio', 'video'] as AssetFilter[]).map((filter) => (
          <button
            type="button"
            className={`resource-filter ${activeFilter === filter ? 'is-active' : ''}`}
            key={filter}
            onClick={() => onFilterChange(filter)}
          >
            <span>{filter === 'all' ? '全部' : mediaLabels[filter]}</span>
            <span className="resource-count">{counts[filter]}</span>
          </button>
        ))}
      </nav>
      <button
        type="button"
        className={`archive-filter ${showArchived ? 'is-active' : ''}`}
        onClick={onToggleArchived}
      >
        <Archive size={13} aria-hidden="true" />
        {showArchived ? '查看可用资源' : '查看已归档资源'}
      </button>
      {isUploading && uploadProgress !== null && (
        <div className="upload-progress" role="status">
          <div className="upload-progress-label">
            <span>上传中</span>
            <span>{uploadProgress}%</span>
          </div>
          <div className="upload-progress-track">
            <span style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}
      <div className="asset-list" aria-live="polite">
        {filteredAssets.map((asset) => (
          <article
            className={`asset-card ${asset.status === 'archived' ? 'is-archived' : ''}`}
            draggable={asset.status !== 'archived'}
            key={asset.id}
            onDragStart={(event) => onAssetDragStart(event, asset)}
            title={asset.status === 'archived' ? '已归档资源' : '拖入画布创建来源节点'}
          >
            <AssetPreview asset={asset} className="asset-card-preview" />
            <div className="asset-card-copy">
              <strong title={asset.name}>{asset.name}</strong>
              <span>
                {mediaLabels[asset.mediaType]} · {formatBytes(asset.sizeBytes)}
              </span>
            </div>
            <div className="asset-card-actions">
              <button
                type="button"
                className="asset-add-button"
                aria-label={
                  asset.status === 'archived' ? `恢复 ${asset.name}` : `添加 ${asset.name} 到画布`
                }
                title={asset.status === 'archived' ? '恢复资源' : '添加到画布'}
                onClick={() =>
                  asset.status === 'archived' ? onArchiveAsset(asset) : onAddAsset(asset)
                }
              >
                {asset.status === 'archived' ? <RotateCcw size={15} /> : <SquarePlus size={16} />}
              </button>
              <button
                type="button"
                className="asset-add-button"
                aria-label={`重命名 ${asset.name}`}
                title="重命名"
                onClick={() => onRenameAsset(asset)}
              >
                <Pencil size={14} />
              </button>
              {!showArchived && (
                <button
                  type="button"
                  className="asset-add-button"
                  aria-label={`归档 ${asset.name}`}
                  title="归档"
                  onClick={() => onArchiveAsset(asset)}
                >
                  <Archive size={14} />
                </button>
              )}
            </div>
          </article>
        ))}
        {filteredAssets.length === 0 && (
          <div className="empty-panel compact-empty">
            <Upload size={22} aria-hidden="true" />
            <strong>{assets.length === 0 ? '还没有资源' : '没有匹配资源'}</strong>
            <p>
              {assets.length === 0
                ? '点击右上角上传，或将文件拖到这里。'
                : '尝试调整搜索或筛选条件。'}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}

function SettingsPanel({
  onClose,
  onNotice,
  onModelsChange,
}: {
  onClose: () => void;
  onNotice: (notice: { kind: 'error' | 'success'; message: string }) => void;
  onModelsChange: (models: ModelEntry[]) => void;
}) {
  const [settings, setSettings] = useState<AiSettings>({
    baseUrl: '',
    configured: false,
    defaultModels: {},
  });
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [formErrors, setFormErrors] = useState<AiSettingsFormErrors>({});
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusableElements = getFocusableElements(dialog);
    if (focusableElements.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;
    if (event.shiftKey) {
      if (activeElement === first || !dialog.contains(activeElement)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (activeElement === last || !dialog.contains(activeElement)) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    void fetch(`${API_BASE_URL}/v1/settings/ai`)
      .then(async (response) => {
        if (!response.ok) throw new Error('设置加载失败');
        const result = (await response.json()) as { settings: AiSettings };
        setSettings(result.settings);
        setBaseUrl(result.settings.baseUrl);
      })
      .catch((error: unknown) =>
        onNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : '设置加载失败',
        }),
      );
  }, [onNotice]);

  const save = async () => {
    const errors = validateAiSettingsForm({
      baseUrl,
      apiKey,
      configured: settings.configured,
    });
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setBusy(true);
    try {
      const response = await fetch(`${API_BASE_URL}/v1/settings/ai`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, ...(apiKey ? { apiKey } : {}) }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        settings?: AiSettings;
        error?: string;
      };
      if (!response.ok || !result.settings) throw new Error(result.error ?? '设置保存失败');
      setSettings(result.settings);
      setApiKey('');
      onNotice({ kind: 'success', message: 'AI 设置已保存' });
    } catch (error) {
      onNotice({ kind: 'error', message: error instanceof Error ? error.message : '设置保存失败' });
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE_URL}/v1/settings/ai/test`, { method: 'POST' });
      const result = (await response.json()) as {
        result?: { ok: boolean; modelCount?: number; error?: string };
      };
      if (!result.result?.ok) throw new Error(result.result?.error ?? '连接失败');
      onNotice({
        kind: 'success',
        message: `连接成功，发现 ${result.result.modelCount ?? 0} 个模型`,
      });
    } catch (error) {
      onNotice({ kind: 'error', message: error instanceof Error ? error.message : '连接失败' });
    } finally {
      setBusy(false);
    }
  };

  const refreshModels = async () => {
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE_URL}/v1/settings/ai/models/refresh`, {
        method: 'POST',
      });
      const result = (await response.json()) as { models?: ModelEntry[]; error?: string };
      if (!response.ok || !result.models) throw new Error(result.error ?? '模型刷新失败');
      setModels(result.models);
      onModelsChange(result.models);
      onNotice({ kind: 'success', message: '模型列表已刷新' });
    } catch (error) {
      onNotice({ kind: 'error', message: error instanceof Error ? error.message : '模型刷新失败' });
    } finally {
      setBusy(false);
    }
  };

  const saveDefault = async (mediaType: MediaType, modelAlias: string) => {
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE_URL}/v1/settings/ai`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultModels: { [mediaType]: modelAlias || null } }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        settings?: AiSettings;
        error?: string;
      };
      if (!response.ok || !result.settings) throw new Error(result.error ?? '默认模型保存失败');
      setSettings(result.settings);
      onNotice({ kind: 'success', message: `${mediaLabels[mediaType]}默认模型已更新` });
    } catch (error) {
      onNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '默认模型保存失败',
      });
    } finally {
      setBusy(false);
    }
  };

  const deleteCredentials = async () => {
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE_URL}/v1/settings/ai/credentials`, {
        method: 'DELETE',
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? '凭据删除失败');
      setSettings((current) => ({
        ...current,
        configured: false,
        keyFingerprint: undefined,
      }));
      setApiKey('');
      onNotice({ kind: 'success', message: '凭据已删除' });
    } catch (error) {
      onNotice({ kind: 'error', message: error instanceof Error ? error.message : '凭据删除失败' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={dialogRef}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="panel-heading">
          <div>
            <p className="eyebrow">设置</p>
            <h1 id="settings-title">AI 连接</h1>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭设置"
            title="关闭"
            onClick={onClose}
            ref={closeButtonRef}
          >
            <X size={17} />
          </button>
        </div>
        <label className="settings-field">
          <span>New API Base URL</span>
          <input
            id="settings-base-url"
            aria-invalid={Boolean(formErrors.baseUrl)}
            aria-describedby={formErrors.baseUrl ? 'settings-base-url-error' : undefined}
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setFormErrors((current) => ({ ...current, baseUrl: undefined }));
            }}
            placeholder="https://newapi.example.com/v1"
          />
          {formErrors.baseUrl && (
            <span id="settings-base-url-error" className="settings-field-error" role="alert">
              {formErrors.baseUrl}
            </span>
          )}
        </label>
        <label className="settings-field">
          <span>API Key</span>
          <input
            id="settings-api-key"
            aria-invalid={Boolean(formErrors.apiKey)}
            aria-describedby={formErrors.apiKey ? 'settings-api-key-error' : undefined}
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setFormErrors((current) => ({ ...current, apiKey: undefined }));
            }}
            placeholder={
              settings.keyFingerprint ? `已配置 · ${settings.keyFingerprint}` : '输入服务端 Key'
            }
          />
          {formErrors.apiKey && (
            <span id="settings-api-key-error" className="settings-field-error" role="alert">
              {formErrors.apiKey}
            </span>
          )}
        </label>
        <div className="settings-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => void save()}
            disabled={busy}
          >
            保存
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void testConnection()}
            disabled={busy || !settings.configured}
          >
            测试连接
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void refreshModels()}
            disabled={busy || !settings.configured}
          >
            刷新模型
          </button>
        </div>
        <div className="settings-status">
          {settings.configured ? `已配置 · ${settings.keyFingerprint}` : '未配置'}
        </div>
        <div className="settings-models">
          <h2>默认模型</h2>
          {mediaTypes.map((mediaType) => (
            <label className="settings-field" key={mediaType}>
              <span>{mediaLabels[mediaType]}</span>
              <select
                value={settings.defaultModels[mediaType] ?? ''}
                onChange={(event) => void saveDefault(mediaType, event.target.value)}
                disabled={busy}
              >
                <option value="">继承服务端默认</option>
                {models
                  .filter((model) => model.mediaTypes.includes(mediaType))
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </div>
        <button
          type="button"
          className="settings-delete"
          onClick={() => void deleteCredentials()}
          disabled={busy || !settings.configured}
        >
          删除凭据
        </button>
      </section>
    </div>
  );
}

function WorkflowCanvas({
  nodes,
  edges,
  background,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeDragStart,
  onCanvasDrop,
  onNodeSelect,
  onAddGenerateNode,
  onBackgroundChange,
}: {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
  background: CanvasBackground;
  onNodesChange: OnNodesChange<AssetFlowNode>;
  onEdgesChange: OnEdgesChange<FlowEdge>;
  onConnect: (connection: Connection) => void;
  onNodeDragStart: () => void;
  onCanvasDrop: (
    files: File[],
    assetId: string | undefined,
    position: { x: number; y: number },
  ) => void;
  onNodeSelect: (node: AssetFlowNode) => void;
  onAddGenerateNode: (mediaType: MediaType) => void;
  onBackgroundChange: (background: CanvasBackground) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE) || undefined;
      onCanvasDrop(Array.from(event.dataTransfer.files), assetId, position);
    },
    [onCanvasDrop, screenToFlowPosition],
  );

  return (
    <section className="canvas-area" aria-label="工作流画布">
      <label className="canvas-background-picker">
        <span>背景</span>
        <select
          aria-label="画布背景"
          value={background}
          onChange={(event) => onBackgroundChange(event.target.value as CanvasBackground)}
        >
          {canvasBackgroundOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="canvas-node-tools" aria-label="添加生成节点">
        {mediaTypes.map((mediaType) => {
          const Icon = mediaIcons[mediaType];
          return (
            <button
              type="button"
              className={`canvas-node-tool media-icon-${mediaType}`}
              key={mediaType}
              aria-label={`新建${mediaLabels[mediaType]}生成节点`}
              title={`新建${mediaLabels[mediaType]}生成节点`}
              onClick={() => onAddGenerateNode(mediaType)}
            >
              <Icon size={15} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onDrop={handleDrop}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onNodeClick={(_, node) => onNodeSelect(node as AssetFlowNode)}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1.1 }}
        connectionLineStyle={{ stroke: '#18794e', strokeWidth: 2 }}
        defaultEdgeOptions={{ animated: true, style: { stroke: '#8aa597', strokeWidth: 2 } }}
        proOptions={{ hideAttribution: true }}
      >
        {background !== 'blank' && (
          <Background
            color="#cbd5d0"
            gap={background === 'lines' ? 28 : 24}
            size={background === 'cross' ? 7 : 1.2}
            variant={
              background === 'lines'
                ? BackgroundVariant.Lines
                : background === 'cross'
                  ? BackgroundVariant.Cross
                  : BackgroundVariant.Dots
            }
          />
        )}
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
      {nodes.length === 0 && (
        <div className="canvas-welcome">
          <span className="canvas-kicker">工作流画布</span>
          <h2>从一个节点开始</h2>
          <p>把资源拖到这里，来源节点会自动创建。</p>
        </div>
      )}
    </section>
  );
}

export function App() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeFilter, setActiveFilter] = useState<AssetFilter>('all');
  const [query, setQuery] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [selectedNode, setSelectedNode] = useState<AssetFlowNode | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelEntry[]>([]);
  const [runRecords, setRunRecords] = useState<Record<string, RunRecord>>({});
  const [resultVersions, setResultVersions] = useState<AssetVersionSummary[]>([]);
  const [resultVersionsLoading, setResultVersionsLoading] = useState(false);
  const [resultVersionsError, setResultVersionsError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [saveState, setSaveState] = useState('准备就绪');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('未命名项目');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [showProjects, setShowProjects] = useState(false);
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [projectCreateName, setProjectCreateName] = useState('未命名项目');
  const [projectCreateError, setProjectCreateError] = useState('');
  const [isProjectLoading, setIsProjectLoading] = useState(false);
  const [canvasBackground, setCanvasBackground] = useState<CanvasBackground>(readCanvasBackground);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsWasOpenRef = useRef(false);
  const canvasRevisionRef = useRef(0);
  const canvasDirtyRef = useRef(false);
  const saveRequestRef = useRef<Promise<void> | null>(null);
  const initializedRef = useRef(false);
  const nodesRef = useRef<AssetFlowNode[]>([]);
  const edgesRef = useRef<FlowEdge[]>([]);
  const historyRef = useRef<{ past: CanvasHistorySnapshot[]; future: CanvasHistorySnapshot[] }>({
    past: [],
    future: [],
  });
  const clipboardRef = useRef<CanvasClipboard | null>(null);
  const [nodes, setNodes, applyNodesChange] = useNodesState<AssetFlowNode>([]);
  const [edges, setEdges, applyEdgesChange] = useEdgesState<FlowEdge>([]);

  useEffect(() => {
    if (settingsWasOpenRef.current && !showSettings) {
      settingsTriggerRef.current?.focus();
    }
    settingsWasOpenRef.current = showSettings;
  }, [showSettings]);

  useEffect(() => {
    if (!notice || notice.kind !== 'success') return;
    const timer = window.setTimeout(() => {
      setNotice((current) => (current === notice ? null : current));
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    window.localStorage.setItem(CANVAS_BACKGROUND_KEY, canvasBackground);
  }, [canvasBackground]);

  useEffect(() => {
    if (!showProjects) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('.project-context')) {
        setShowProjects(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [showProjects]);

  useEffect(() => {
    if (!showProjectCreate) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isProjectLoading) setShowProjectCreate(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isProjectLoading, showProjectCreate]);

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [edges, nodes]);

  const rememberHistory = useCallback(() => {
    const current: CanvasHistorySnapshot = {
      nodes: structuredClone(nodesRef.current),
      edges: structuredClone(edgesRef.current),
    };
    const past = historyRef.current.past;
    const previous = past[past.length - 1];
    if (previous && JSON.stringify(previous) === JSON.stringify(current)) return;
    historyRef.current = { past: [...past.slice(-49), current], future: [] };
  }, []);

  const undoCanvas = useCallback(() => {
    const history = historyRef.current;
    const previous = history.past.pop();
    if (!previous) return;
    history.future.push({
      nodes: structuredClone(nodesRef.current),
      edges: structuredClone(edgesRef.current),
    });
    setNodes(structuredClone(previous.nodes));
    setEdges(structuredClone(previous.edges));
    canvasDirtyRef.current = true;
  }, [setEdges, setNodes]);

  const redoCanvas = useCallback(() => {
    const history = historyRef.current;
    const next = history.future.pop();
    if (!next) return;
    history.past.push({
      nodes: structuredClone(nodesRef.current),
      edges: structuredClone(edgesRef.current),
    });
    setNodes(structuredClone(next.nodes));
    setEdges(structuredClone(next.edges));
    canvasDirtyRef.current = true;
  }, [setEdges, setNodes]);

  useEffect(() => {
    void fetch(`${API_BASE_URL}/v1/models`)
      .then(async (response) => {
        if (!response.ok) return;
        const result = (await response.json()) as { models?: ModelEntry[] };
        setModelCatalog(result.models ?? []);
      })
      .catch(() => {
        // The settings panel can refresh the catalog when the API is configured.
      });
  }, []);

  useEffect(() => {
    setSelectedNode((current) => {
      if (!current) return null;
      return nodes.find((node) => node.id === current.id) ?? null;
    });
  }, [nodes]);

  const handleNodesChange: OnNodesChange<AssetFlowNode> = useCallback(
    (changes) => {
      if (
        changes.some((change) => ['position', 'add', 'remove', 'replace'].includes(change.type))
      ) {
        canvasDirtyRef.current = true;
      }
      if (changes.some((change) => ['add', 'remove', 'replace'].includes(change.type))) {
        rememberHistory();
      }
      applyNodesChange(changes);
    },
    [applyNodesChange, rememberHistory],
  );

  const handleNodeDragStart = useCallback(() => {
    rememberHistory();
    canvasDirtyRef.current = true;
  }, [rememberHistory]);

  const handleEdgesChange: OnEdgesChange<FlowEdge> = useCallback(
    (changes) => {
      canvasDirtyRef.current = true;
      if (changes.some((change) => ['add', 'remove', 'replace'].includes(change.type))) {
        rememberHistory();
      }
      applyEdgesChange(changes);
    },
    [applyEdgesChange, rememberHistory],
  );

  const loadAssets = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/v1/assets`);
      if (!response.ok) throw new Error('资源加载失败');
      const result = (await response.json()) as { assets: Asset[] };
      setAssets(result.assets);
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '资源加载失败',
      });
    }
  }, []);

  const updateAsset = useCallback(async (asset: Asset, patch: { name?: string }) => {
    const response = await fetch(`${API_BASE_URL}/v1/assets/${asset.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const result = (await response.json().catch(() => ({}))) as { asset?: Asset; error?: string };
    if (!response.ok || !result.asset) throw new Error(result.error ?? '资源更新失败');
    setAssets((current) => current.map((item) => (item.id === asset.id ? result.asset! : item)));
  }, []);

  const archiveAsset = useCallback(async (asset: Asset) => {
    const action = asset.status === 'archived' ? 'restore' : 'archive';
    const response = await fetch(`${API_BASE_URL}/v1/assets/${asset.id}/${action}`, {
      method: 'POST',
    });
    const result = (await response.json().catch(() => ({}))) as { asset?: Asset; error?: string };
    if (!response.ok || !result.asset) throw new Error(result.error ?? '资源状态更新失败');
    setAssets((current) => current.map((item) => (item.id === asset.id ? result.asset! : item)));
  }, []);

  const refreshProjects = useCallback(async () => {
    const response = await fetch(`${API_BASE_URL}/v1/projects`);
    const result = (await response.json().catch(() => ({}))) as {
      projects?: ProjectSummary[];
      error?: string;
    };
    if (!response.ok || !result.projects) throw new Error(result.error ?? '项目列表加载失败');
    setProjects(result.projects);
    return result.projects;
  }, []);

  const loadProjectCanvas = useCallback(
    async (requestedProjectId?: string, project?: ProjectSummary) => {
      setIsCanvasReady(false);
      setIsProjectLoading(true);
      try {
        let currentProjectId = requestedProjectId ?? localStorage.getItem(PROJECT_STORAGE_KEY);
        let currentProject = project;
        if (currentProjectId) {
          const existing = await fetch(`${API_BASE_URL}/v1/projects/${currentProjectId}`);
          if (!existing.ok) {
            if (requestedProjectId) throw new Error('目标项目不存在');
            currentProjectId = null;
          } else {
            currentProject = ((await existing.json()) as { project: ProjectSummary }).project;
          }
        }
        if (!currentProjectId) {
          const created = await fetch(`${API_BASE_URL}/v1/projects`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: '未命名项目' }),
          });
          if (!created.ok) throw new Error('项目创建失败');
          const result = (await created.json()) as { project: ProjectSummary };
          currentProjectId = result.project.id;
          currentProject = result.project;
          localStorage.setItem(PROJECT_STORAGE_KEY, currentProjectId);
        }

        const response = await fetch(`${API_BASE_URL}/v1/projects/${currentProjectId}/canvas`);
        if (!response.ok) throw new Error('画布加载失败');
        const result = (await response.json()) as { canvas: CanvasApiDocument };
        setProjectId(currentProjectId);
        setProjectName(currentProject?.name ?? '未命名项目');
        if (currentProject) {
          setProjects((current) =>
            current.some((item) => item.id === currentProject!.id)
              ? current.map((item) => (item.id === currentProject!.id ? currentProject! : item))
              : [currentProject!, ...current],
          );
        }
        localStorage.setItem(PROJECT_STORAGE_KEY, currentProjectId);
        canvasRevisionRef.current = result.canvas.revision;
        setCanvasRevision(result.canvas.revision);
        const flowCanvas = fromCanvasDocument(result.canvas);
        setNodes(flowCanvas.nodes);
        setEdges(flowCanvas.edges);
        setSelectedNode(null);
        setRunRecords({});
        setIsRunning(false);
        historyRef.current = { past: [], future: [] };
        canvasDirtyRef.current = false;
        setSaveState(result.canvas.revision > 0 ? '已从项目恢复' : '项目已连接');
      } catch (error) {
        if (requestedProjectId) {
          setNotice({
            kind: 'error',
            message: error instanceof Error ? error.message : '目标项目加载失败',
          });
          throw error;
        }
        setNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : '项目加载失败，将使用本地草稿',
        });
        try {
          const stored = localStorage.getItem(CANVAS_DRAFT_KEY);
          if (stored) {
            const parsed = JSON.parse(stored) as LocalCanvasDraft;
            canvasRevisionRef.current = parsed.revision ?? 0;
            setCanvasRevision(parsed.revision ?? 0);
            setNodes(parsed.nodes ?? []);
            setEdges(parsed.edges ?? []);
            historyRef.current = { past: [], future: [] };
            canvasDirtyRef.current = false;
            setSaveState('本地草稿已恢复');
          }
        } catch {
          setNotice({ kind: 'error', message: '本地画布草稿无法恢复' });
        }
      } finally {
        setIsCanvasReady(true);
        setIsProjectLoading(false);
      }
    },
    [setEdges, setNodes],
  );

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void loadAssets();
    void loadProjectCanvas();
    void refreshProjects().catch((error: unknown) =>
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '项目列表加载失败',
      }),
    );
  }, [loadAssets, loadProjectCanvas, refreshProjects]);

  useEffect(() => {
    if (!isCanvasReady) return;
    localStorage.setItem(
      CANVAS_DRAFT_KEY,
      JSON.stringify({ revision: canvasRevision, nodes, edges }),
    );
  }, [canvasRevision, edges, isCanvasReady, nodes]);

  const saveCanvas = useCallback(async () => {
    if (saveRequestRef.current) return saveRequestRef.current;
    if (!projectId || !canvasDirtyRef.current) return;
    const request = (async () => {
      const snapshot = JSON.stringify({ nodes, edges });
      setSaveState('保存中');
      const document = toCanvasDocument(nodes, edges, canvasRevisionRef.current);
      const response = await fetch(`${API_BASE_URL}/v1/projects/${projectId}/canvas`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(document),
      });
      const result = (await response.json().catch(() => ({}))) as {
        canvas?: CanvasApiDocument;
        error?: string;
        revision?: number;
      };
      if (response.status === 409) {
        setSaveState('保存冲突');
        throw new Error(`画布版本冲突，服务器版本为 ${result.revision ?? '未知'}`);
      }
      if (!response.ok || !result.canvas) throw new Error(result.error ?? '画布保存失败');
      canvasRevisionRef.current = result.canvas.revision;
      setCanvasRevision(result.canvas.revision);
      if (JSON.stringify({ nodes, edges }) === snapshot) canvasDirtyRef.current = false;
      setSaveState('已保存到项目');
    })();
    saveRequestRef.current = request;
    try {
      await request;
    } finally {
      if (saveRequestRef.current === request) saveRequestRef.current = null;
    }
  }, [edges, nodes, projectId]);

  const switchProject = useCallback(
    async (project: ProjectSummary) => {
      if (project.id === projectId || isProjectLoading) {
        setShowProjects(false);
        return;
      }
      try {
        await saveCanvas();
        await loadProjectCanvas(project.id, project);
        setShowProjects(false);
        setNotice({ kind: 'success', message: `已切换到「${project.name}」` });
      } catch (error) {
        setNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : '项目切换失败',
        });
      }
    },
    [isProjectLoading, loadProjectCanvas, projectId, saveCanvas],
  );

  const createProject = useCallback(async () => {
    if (isProjectLoading) return;
    const name = projectCreateName.trim();
    if (!name) {
      setProjectCreateError('请输入项目名称');
      return;
    }
    setProjectCreateError('');
    setIsProjectLoading(true);
    try {
      await saveCanvas();
      const response = await fetch(`${API_BASE_URL}/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        project?: ProjectSummary;
        error?: string;
      };
      if (!response.ok || !result.project) throw new Error(result.error ?? '项目创建失败');
      await loadProjectCanvas(result.project.id, result.project);
      await refreshProjects();
      setShowProjectCreate(false);
      setNotice({ kind: 'success', message: `项目「${name}」已创建` });
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '项目创建失败',
      });
    } finally {
      setIsProjectLoading(false);
    }
  }, [isProjectLoading, loadProjectCanvas, projectCreateName, refreshProjects, saveCanvas]);

  useEffect(() => {
    if (!isCanvasReady || !projectId || !canvasDirtyRef.current) return;
    const timer = window.setTimeout(async () => {
      try {
        await saveCanvas();
      } catch (error) {
        setSaveState('本地草稿已保存');
        setNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : '画布保存失败',
        });
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [isCanvasReady, projectId, saveCanvas]);

  const createNodeForAsset = useCallback(
    (asset: Asset, position: { x: number; y: number }): AssetFlowNode => {
      return {
        id: `node_${asset.id}_${crypto.randomUUID()}`,
        type: asset.mediaType,
        position,
        data: {
          label: asset.name,
          mediaType: asset.mediaType,
          mode: 'source',
          assetId: asset.id,
          contentUrl: asset.contentUrl,
          mimeType: asset.mimeType,
        },
      };
    },
    [],
  );

  const createGenerateNode = useCallback(
    (mediaType: MediaType, position: { x: number; y: number }): AssetFlowNode => ({
      id: `node_${mediaType}_${crypto.randomUUID()}`,
      type: mediaType,
      position,
      data: {
        label: `${mediaLabels[mediaType]}生成节点`,
        mediaType,
        mode: 'generate',
        inferenceStrength: 'medium',
      },
    }),
    [],
  );

  const uploadFiles = useCallback(
    async (files: File[], position?: { x: number; y: number }) => {
      if (files.length === 0) return;
      setIsUploading(true);
      setUploadProgress(0);
      setNotice(null);
      const uploaded: Asset[] = [];
      try {
        for (const file of files) {
          uploaded.push(await uploadAsset(file, setUploadProgress));
        }
        setAssets((current) => [...uploaded, ...current]);
        if (position) {
          rememberHistory();
          canvasDirtyRef.current = true;
          setNodes((current) => [
            ...current,
            ...uploaded.map((asset, index) =>
              createNodeForAsset(asset, { x: position.x + index * 34, y: position.y + index * 34 }),
            ),
          ]);
        }
        setNotice({ kind: 'success', message: `${uploaded.length} 个资源已加入项目` });
      } catch (error) {
        setNotice({ kind: 'error', message: error instanceof Error ? error.message : '上传失败' });
      } finally {
        setIsUploading(false);
        setUploadProgress(null);
      }
    },
    [createNodeForAsset, rememberHistory, setNodes],
  );

  const handleCanvasDrop = useCallback(
    (files: File[], assetId: string | undefined, position: { x: number; y: number }) => {
      if (assetId) {
        const asset = assets.find((item) => item.id === assetId);
        if (!asset) {
          setNotice({ kind: 'error', message: '资源已不存在，请刷新资源库' });
          return;
        }
        rememberHistory();
        setNodes((current) => [...current, createNodeForAsset(asset, position)]);
        canvasDirtyRef.current = true;
        return;
      }
      void uploadFiles(files, position);
    },
    [assets, createNodeForAsset, rememberHistory, setNodes, uploadFiles],
  );

  const handleAssetDragStart = useCallback((event: DragEvent, asset: Asset) => {
    event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

  const handleAddAsset = useCallback(
    (asset: Asset) => {
      const column = nodes.length % 3;
      const row = Math.floor(nodes.length / 3);
      rememberHistory();
      setNodes((current) => [
        ...current,
        createNodeForAsset(asset, { x: 80 + column * 230, y: 80 + row * 210 }),
      ]);
      canvasDirtyRef.current = true;
      setNotice({ kind: 'success', message: `${asset.name} 已添加到画布` });
    },
    [createNodeForAsset, nodes.length, rememberHistory, setNodes],
  );

  const handleRenameAsset = useCallback(
    (asset: Asset) => {
      const name = window.prompt('资源名称', asset.name)?.trim();
      if (!name || name === asset.name) return;
      void updateAsset(asset, { name }).then(
        () => setNotice({ kind: 'success', message: '资源已重命名' }),
        (error: unknown) =>
          setNotice({
            kind: 'error',
            message: error instanceof Error ? error.message : '重命名失败',
          }),
      );
    },
    [updateAsset],
  );

  const handleArchiveAsset = useCallback(
    (asset: Asset) => {
      void archiveAsset(asset).then(
        () =>
          setNotice({
            kind: 'success',
            message: asset.status === 'archived' ? '资源已恢复' : '资源已归档',
          }),
        (error: unknown) =>
          setNotice({
            kind: 'error',
            message: error instanceof Error ? error.message : '资源状态更新失败',
          }),
      );
    },
    [archiveAsset],
  );

  const handleAddGenerateNode = useCallback(
    (mediaType: MediaType) => {
      const column = nodes.length % 3;
      const row = Math.floor(nodes.length / 3);
      const node = createGenerateNode(mediaType, { x: 100 + column * 250, y: 100 + row * 220 });
      rememberHistory();
      setNodes((current) => [...current, node]);
      setSelectedNode(node);
      canvasDirtyRef.current = true;
      setNotice({ kind: 'success', message: `${mediaLabels[mediaType]}生成节点已添加` });
    },
    [createGenerateNode, nodes.length, rememberHistory, setNodes],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const validation = validateCanvasConnection(connection, nodes, edges);
      if (!validation.ok && validation.reason === 'cycle') {
        setNotice({ kind: 'error', message: '不能创建循环依赖' });
      }
      if (!validation.ok) return;
      rememberHistory();
      setEdges((current) => [
        ...current,
        {
          ...connection,
          id: `edge_${connection.source}_${connection.target}_${Date.now()}`,
          animated: true,
        },
      ]);
      canvasDirtyRef.current = true;
    },
    [edges, nodes, rememberHistory, setEdges],
  );

  const selectedAsset = selectedNode
    ? assets.find((asset) => asset.id === selectedNode.data.assetId)
    : undefined;

  const selectedRun = selectedNode ? runRecords[selectedNode.id] : undefined;
  const selectedResultAsset: RunResultAsset | undefined = selectedRun?.result?.asset;
  const selectedResultAssetId = selectedResultAsset?.assetId;
  const selectedResultVersion = selectedResultAsset?.version;

  useEffect(() => {
    let active = true;
    if (!selectedResultAssetId) {
      setResultVersions([]);
      setResultVersionsLoading(false);
      setResultVersionsError(null);
      return () => {
        active = false;
      };
    }

    setResultVersions([]);
    setResultVersionsLoading(true);
    setResultVersionsError(null);
    void fetchAssetVersions(selectedResultAssetId, API_BASE_URL).then(
      (versions) => {
        if (!active) return;
        setResultVersions(versions);
        setResultVersionsLoading(false);
      },
      (error: unknown) => {
        if (!active) return;
        setResultVersions([]);
        setResultVersionsLoading(false);
        setResultVersionsError(error instanceof Error ? error.message : '结果版本加载失败');
      },
    );
    return () => {
      active = false;
    };
  }, [selectedResultAssetId, selectedResultVersion]);

  const currentResultVersion =
    selectedResultAsset?.version ?? resultVersions[resultVersions.length - 1]?.version ?? 1;
  const currentResultVersionRecord = resultVersions.find(
    (version) => version.version === currentResultVersion,
  );
  const currentResultContentUrl =
    currentResultVersionRecord?.contentUrl ?? selectedResultAsset?.contentUrl;

  const updateSelectedModel = useCallback(
    (modelAlias: string) => {
      if (!selectedNode) return;
      rememberHistory();
      canvasDirtyRef.current = true;
      setNodes((current) =>
        current.map((node) =>
          node.id === selectedNode.id
            ? {
                ...node,
                data: { ...node.data, modelAlias: modelAlias.trim() || undefined },
              }
            : node,
        ),
      );
    },
    [rememberHistory, selectedNode, setNodes],
  );

  const updateSelectedPrompt = useCallback(
    (prompt: string) => {
      if (!selectedNode) return;
      rememberHistory();
      canvasDirtyRef.current = true;
      setNodes((current) =>
        current.map((node) =>
          node.id === selectedNode.id
            ? { ...node, data: { ...node.data, prompt: prompt || undefined } }
            : node,
        ),
      );
    },
    [rememberHistory, selectedNode, setNodes],
  );

  const updateSelectedInferenceStrength = useCallback(
    (inferenceStrength: InferenceStrength) => {
      if (!selectedNode) return;
      rememberHistory();
      canvasDirtyRef.current = true;
      setNodes((current) =>
        current.map((node) =>
          node.id === selectedNode.id
            ? { ...node, data: { ...node.data, inferenceStrength } }
            : node,
        ),
      );
    },
    [rememberHistory, selectedNode, setNodes],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isCanvasShortcutTarget(event.target)) return;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (command && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoCanvas();
        else undoCanvas();
        return;
      }
      if (command && key === 'y') {
        event.preventDefault();
        redoCanvas();
        return;
      }
      if (command && key === 'c') {
        const clipboard = copyCanvasSelection(nodesRef.current, edgesRef.current, selectedNode?.id);
        if (clipboard.nodes.length === 0) return;
        event.preventDefault();
        clipboardRef.current = clipboard;
        const writeText = window.navigator.clipboard?.writeText;
        if (writeText) {
          void writeText
            .call(window.navigator.clipboard, serializeCanvasClipboard(clipboard))
            .catch(() => undefined);
        }
        return;
      }
      if (command && key === 'v') {
        event.preventDefault();
        void (async () => {
          let clipboard = clipboardRef.current;
          const readText = window.navigator.clipboard?.readText;
          if (readText) {
            try {
              const parsed = parseCanvasClipboard(await readText.call(window.navigator.clipboard));
              if (parsed) clipboard = parsed;
            } catch {
              // Browser clipboard permissions are optional; use the in-memory fallback.
            }
          }
          if (!clipboard || clipboard.nodes.length === 0) return;
          rememberHistory();
          const pasted = pasteCanvasClipboard(clipboard);
          setNodes((current) => [
            ...current.map((node) => ({ ...node, selected: false })),
            ...pasted.nodes,
          ]);
          setEdges((current) => [...current, ...pasted.edges]);
          setSelectedNode(pasted.nodes[0] ?? null);
          canvasDirtyRef.current = true;
        })();
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const selectedNodeIds = new Set(
        nodesRef.current.filter((node) => node.selected).map((node) => node.id),
      );
      const selectedEdgeIds = new Set(
        edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id),
      );
      if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return;
      event.preventDefault();
      rememberHistory();
      setNodes((current) => current.filter((node) => !selectedNodeIds.has(node.id)));
      setEdges((current) =>
        current.filter(
          (edge) =>
            !selectedEdgeIds.has(edge.id) &&
            !selectedNodeIds.has(edge.source) &&
            !selectedNodeIds.has(edge.target),
        ),
      );
      setSelectedNode(null);
      canvasDirtyRef.current = true;
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [redoCanvas, rememberHistory, selectedNode, setEdges, setNodes, undoCanvas]);

  const updateNodeRunState = useCallback(
    (nodeId: string, run: RunRecord) => {
      setRunRecords((current) => ({ ...current, [nodeId]: run }));
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  runStatus: run.status,
                  runProgress: run.progress,
                  runError: run.error,
                  resultAsset: run.result?.asset,
                },
              }
            : node,
        ),
      );
    },
    [setNodes],
  );

  useEffect(() => {
    if (!projectId || typeof EventSource === 'undefined') return;
    const events = new EventSource(`${API_BASE_URL}/v1/projects/${projectId}/events`);
    const handleRunUpdate = (event: Event) => {
      try {
        const run = JSON.parse((event as MessageEvent<string>).data) as RunRecord;
        updateNodeRunState(run.targetNodeId, run);
      } catch {
        // Ignore malformed events and keep REST polling as a fallback.
      }
    };
    events.addEventListener('run.updated', handleRunUpdate);
    return () => {
      events.removeEventListener('run.updated', handleRunUpdate);
      events.close();
    };
  }, [projectId, updateNodeRunState]);

  const fetchRun = useCallback(
    async (runId: string, nodeId: string) => {
      const response = await fetch(`${API_BASE_URL}/v1/runs/${runId}`);
      const result = (await response.json().catch(() => ({}))) as {
        run?: RunRecord;
        error?: string;
      };
      if (!response.ok || !result.run) throw new Error(result.error ?? '运行状态加载失败');
      updateNodeRunState(nodeId, result.run);
      return result.run;
    },
    [updateNodeRunState],
  );

  const pollRun = useCallback(
    async (runId: string, nodeId: string) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const run = await fetchRun(runId, nodeId);
        if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('运行等待超时');
    },
    [fetchRun],
  );

  const runNode = useCallback(
    async (node: AssetFlowNode) => {
      if (!projectId) {
        setNotice({ kind: 'error', message: '项目尚未连接' });
        return;
      }
      if (node.data.mode === 'source') {
        setNotice({ kind: 'error', message: '来源节点不能直接运行，请选择生成或转换节点' });
        return;
      }
      setIsRunning(true);
      setNotice(null);
      try {
        await saveCanvas();
        const response = await fetch(`${API_BASE_URL}/v1/nodes/${node.id}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId,
            ...(node.data.modelAlias ? { modelAlias: node.data.modelAlias } : {}),
            parameters: {
              ...(node.data.prompt?.trim() ? { prompt: node.data.prompt.trim() } : {}),
              inferenceStrength: node.data.inferenceStrength ?? 'medium',
            },
          }),
        });
        const result = (await response.json().catch(() => ({}))) as {
          run?: RunRecord;
          error?: string;
        };
        if (!response.ok || !result.run) throw new Error(result.error ?? '运行提交失败');
        updateNodeRunState(node.id, result.run);
        const completed = await pollRun(result.run.id, node.id);
        if (completed.status === 'succeeded') {
          setNotice({ kind: 'success', message: `${node.data.label} 已完成` });
        } else {
          setNotice({
            kind: 'error',
            message: completed.error ?? runStatusLabel(completed.status),
          });
        }
      } catch (error) {
        setNotice({ kind: 'error', message: error instanceof Error ? error.message : '运行失败' });
      } finally {
        setIsRunning(false);
      }
    },
    [pollRun, projectId, saveCanvas, updateNodeRunState],
  );

  const cancelSelectedRun = useCallback(async () => {
    if (!selectedRun || !selectedNode) return;
    try {
      const response = await fetch(`${API_BASE_URL}/v1/runs/${selectedRun.id}/cancel`, {
        method: 'POST',
      });
      const result = (await response.json().catch(() => ({}))) as {
        run?: RunRecord;
        error?: string;
      };
      if (!response.ok || !result.run) throw new Error(result.error ?? '取消运行失败');
      updateNodeRunState(selectedNode.id, result.run);
      setNotice({ kind: 'success', message: '已请求取消运行' });
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '取消运行失败',
      });
    }
  }, [selectedNode, selectedRun, updateNodeRunState]);

  const retrySelectedRun = useCallback(async () => {
    if (!selectedRun || !selectedNode) return;
    setIsRunning(true);
    try {
      const response = await fetch(`${API_BASE_URL}/v1/runs/${selectedRun.id}/retry`, {
        method: 'POST',
      });
      const result = (await response.json().catch(() => ({}))) as {
        run?: RunRecord;
        error?: string;
      };
      if (!response.ok || !result.run) throw new Error(result.error ?? '重试提交失败');
      updateNodeRunState(selectedNode.id, result.run);
      await pollRun(result.run.id, selectedNode.id);
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '重试失败' });
    } finally {
      setIsRunning(false);
    }
  }, [pollRun, selectedNode, selectedRun, updateNodeRunState]);
  const assetSummary = useMemo(
    () =>
      assets.reduce(
        (summary, asset) => {
          summary[asset.mediaType] += 1;
          return summary;
        },
        { text: 0, image: 0, audio: 0, video: 0 } as Record<MediaType, number>,
      ),
    [assets],
  );

  return (
    <ReactFlowProvider>
      <main className="app-shell">
        <header className="topbar">
          <div className="brand-mark" aria-label="Multimodal Canvas">
            <span className="brand-icon">MC</span>
            <span>Multimodal Canvas</span>
          </div>
          <div className="project-context">
            <button
              type="button"
              className="project-switcher"
              aria-label="打开项目集合"
              aria-expanded={showProjects}
              aria-haspopup="menu"
              onClick={() => setShowProjects((current) => !current)}
              disabled={isProjectLoading}
            >
              <FolderOpen size={15} aria-hidden="true" />
              <span className="project-name">{projectName}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {showProjects && (
              <div className="project-menu" role="menu" aria-label="项目集合">
                <div className="project-menu-heading">
                  <span>项目集合</span>
                  <button
                    type="button"
                    className="project-menu-create"
                    onClick={() => {
                      setShowProjects(false);
                      setProjectCreateName('未命名项目');
                      setProjectCreateError('');
                      setShowProjectCreate(true);
                    }}
                    disabled={isProjectLoading}
                  >
                    <Plus size={14} aria-hidden="true" />
                    新建
                  </button>
                </div>
                <div className="project-menu-list">
                  {projects.map((project) => (
                    <button
                      type="button"
                      className={`project-menu-item ${project.id === projectId ? 'is-active' : ''}`}
                      key={project.id}
                      role="menuitem"
                      onClick={() => void switchProject(project)}
                      disabled={isProjectLoading}
                    >
                      <span className="project-menu-item-copy">
                        <strong>{project.name}</strong>
                        <small>{project.id === projectId ? '当前项目' : '一张工作流画布'}</small>
                      </span>
                      {project.id === projectId && <Check size={14} aria-hidden="true" />}
                    </button>
                  ))}
                  {projects.length === 0 && <p className="project-menu-empty">还没有项目</p>}
                </div>
                <p className="project-menu-note">每个项目独立保存一张工作流画布</p>
              </div>
            )}
            <span className="save-state">
              {saveState.includes('保存') ? <Check size={13} aria-hidden="true" /> : null}
              {saveState}
            </span>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-button"
              aria-label="撤销"
              title="撤销"
              onClick={undoCanvas}
              disabled={historyRef.current.past.length === 0}
            >
              <Undo2 size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="重做"
              title="重做"
              onClick={redoCanvas}
              disabled={historyRef.current.future.length === 0}
            >
              <Redo2 size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="打开设置"
              title="设置"
              onClick={() => setShowSettings(true)}
              ref={settingsTriggerRef}
            >
              <Settings size={16} />
            </button>
            <button type="button" className="button button-secondary" disabled>
              导出
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!selectedNode || selectedNode.data.mode === 'source' || isRunning}
              onClick={() => {
                if (selectedNode) void runNode(selectedNode);
              }}
              title={selectedNode ? '运行选中的生成节点' : '先选择生成或转换节点'}
            >
              {isRunning ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
              {isRunning ? '运行中' : '运行'}
            </button>
          </div>
        </header>

        {notice && (
          <div
            className={`notice notice-${notice.kind}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
          >
            {notice.kind === 'success' ? <Check size={15} /> : <X size={15} />}
            <span>{notice.message}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>
              <X size={14} />
            </button>
          </div>
        )}

        {showProjectCreate && (
          <div
            className="project-create-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !isProjectLoading) {
                setShowProjectCreate(false);
              }
            }}
          >
            <form
              className="project-create-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="project-create-title"
              onSubmit={(event) => {
                event.preventDefault();
                void createProject();
              }}
            >
              <div className="project-create-heading">
                <div>
                  <p className="eyebrow">项目集合</p>
                  <h2 id="project-create-title">新建项目</h2>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭新建项目"
                  title="关闭"
                  onClick={() => setShowProjectCreate(false)}
                  disabled={isProjectLoading}
                >
                  <X size={17} />
                </button>
              </div>
              <label className="project-create-field">
                <span>项目名称</span>
                <input
                  autoFocus
                  value={projectCreateName}
                  maxLength={80}
                  onChange={(event) => {
                    setProjectCreateName(event.target.value);
                    setProjectCreateError('');
                  }}
                  placeholder="例如：春季短片工作流"
                  aria-invalid={Boolean(projectCreateError)}
                  aria-describedby={projectCreateError ? 'project-create-error' : undefined}
                />
                {projectCreateError && (
                  <span id="project-create-error" className="project-create-error" role="alert">
                    {projectCreateError}
                  </span>
                )}
              </label>
              <div className="project-create-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setShowProjectCreate(false)}
                  disabled={isProjectLoading}
                >
                  取消
                </button>
                <button type="submit" className="button button-primary" disabled={isProjectLoading}>
                  {isProjectLoading && <LoaderCircle className="spin" size={15} />}
                  {isProjectLoading ? '创建中' : '创建项目'}
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="workspace">
          <ResourcePanel
            assets={assets}
            showArchived={showArchived}
            activeFilter={activeFilter}
            query={query}
            isUploading={isUploading}
            uploadProgress={uploadProgress}
            onFilterChange={setActiveFilter}
            onToggleArchived={() => setShowArchived((current) => !current)}
            onQueryChange={setQuery}
            onFilesSelected={(files) => void uploadFiles(Array.from(files))}
            onAssetDragStart={handleAssetDragStart}
            onAddAsset={handleAddAsset}
            onRenameAsset={handleRenameAsset}
            onArchiveAsset={handleArchiveAsset}
            onDrop={(event) => {
              event.preventDefault();
              void uploadFiles(Array.from(event.dataTransfer.files));
            }}
          />
          <WorkflowCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
            onNodeDragStart={handleNodeDragStart}
            onCanvasDrop={handleCanvasDrop}
            onNodeSelect={setSelectedNode}
            onAddGenerateNode={handleAddGenerateNode}
            background={canvasBackground}
            onBackgroundChange={setCanvasBackground}
          />
          <aside className="inspector-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">属性</p>
                <h1>节点设置</h1>
              </div>
            </div>
            {selectedNode && selectedAsset ? (
              <div className="inspector-content">
                <AssetPreview asset={selectedAsset} className="inspector-preview" />
                <span className="inspector-type">
                  {mediaLabels[selectedAsset.mediaType]}来源节点
                </span>
                <h2 className="inspector-name">{selectedAsset.name}</h2>
                <dl className="inspector-details">
                  <div>
                    <dt>资源类型</dt>
                    <dd>{selectedAsset.mimeType}</dd>
                  </div>
                  <div>
                    <dt>文件大小</dt>
                    <dd>{formatBytes(selectedAsset.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt>输入端口</dt>
                    <dd>content</dd>
                  </div>
                </dl>
              </div>
            ) : selectedNode ? (
              <div className="inspector-content">
                <div
                  className={`inspector-generate-icon media-icon media-icon-${selectedNode.data.mediaType}`}
                >
                  {(() => {
                    const Icon = mediaIcons[selectedNode.data.mediaType];
                    return <Icon size={26} aria-hidden="true" />;
                  })()}
                </div>
                <span className="inspector-type">
                  {mediaLabels[selectedNode.data.mediaType]}
                  {modeLabels[selectedNode.data.mode]}节点
                </span>
                <h2 className="inspector-name">{selectedNode.data.label}</h2>
                <dl className="inspector-details">
                  <div>
                    <dt>运行状态</dt>
                    <dd>{selectedRun ? runStatusLabel(selectedRun.status) : '未运行'}</dd>
                  </div>
                  {selectedRun && (
                    <div>
                      <dt>进度</dt>
                      <dd>{selectedRun.progress}%</dd>
                    </div>
                  )}
                  <div>
                    <dt>参考输入</dt>
                    <dd>{selectedRun?.snapshot.inputs.length ?? 0} 个</dd>
                  </div>
                </dl>
                {selectedNode.data.mode !== 'source' && (
                  <>
                    <label className="inspector-prompt">
                      <span>提示词</span>
                      <textarea
                        rows={4}
                        value={selectedNode.data.prompt ?? ''}
                        onChange={(event) => updateSelectedPrompt(event.target.value)}
                        placeholder="描述你希望节点生成或转换的内容"
                      />
                    </label>
                    <div className="inspector-generation-controls">
                      <label className="inspector-field inspector-field-model">
                        <span>模型</span>
                        <select
                          value={selectedNode.data.modelAlias ?? ''}
                          onChange={(event) => updateSelectedModel(event.target.value)}
                        >
                          <option value="">继承项目默认模型</option>
                          {selectedNode.data.modelAlias &&
                            !modelCatalog.some(
                              (model) => model.id === selectedNode.data.modelAlias,
                            ) && (
                              <option value={selectedNode.data.modelAlias}>
                                {selectedNode.data.modelAlias}
                              </option>
                            )}
                          {modelCatalog
                            .filter((model) =>
                              model.mediaTypes.includes(selectedNode.data.mediaType),
                            )
                            .map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className="inspector-field inspector-field-strength">
                        <span>推理强度</span>
                        <select
                          value={selectedNode.data.inferenceStrength ?? 'medium'}
                          onChange={(event) =>
                            updateSelectedInferenceStrength(event.target.value as InferenceStrength)
                          }
                        >
                          {inferenceStrengthOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <button
                      type="button"
                      className="button button-primary inspector-generate-button"
                      disabled={isRunning}
                      onClick={() => void runNode(selectedNode)}
                      title="使用当前提示词、模型和推理强度生成"
                    >
                      {isRunning ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
                      {isRunning ? '生成中' : '生成'}
                    </button>
                  </>
                )}
                <div className="inspector-run-actions">
                  {selectedRun &&
                    !['succeeded', 'failed', 'cancelled'].includes(selectedRun.status) && (
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void cancelSelectedRun()}
                      >
                        <X size={14} />
                        取消运行
                      </button>
                    )}
                  {selectedRun && ['failed', 'cancelled'].includes(selectedRun.status) && (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void retrySelectedRun()}
                      disabled={isRunning}
                    >
                      <RotateCcw size={14} />
                      重试
                    </button>
                  )}
                </div>
                {selectedRun?.error && <p className="inspector-run-error">{selectedRun.error}</p>}
                {selectedRun?.result && (
                  <section className="inspector-result" aria-label="运行结果">
                    <div className="inspector-result-heading">
                      <span className="inspector-type">运行结果</span>
                      <span className="inspector-result-version">版本 {currentResultVersion}</span>
                    </div>
                    {currentResultContentUrl ? (
                      <a
                        className="inspector-result-link"
                        href={resolveUploadUrl(currentResultContentUrl, API_BASE_URL)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <AssetPreview
                          asset={{
                            id:
                              selectedResultAsset?.assetId ??
                              currentResultVersionRecord?.assetId ??
                              'result',
                            name: `${selectedNode.data.label}结果`,
                            mediaType: selectedNode.data.mediaType,
                            mimeType:
                              selectedResultAsset?.mimeType ??
                              selectedNode.data.mimeType ??
                              'application/octet-stream',
                            sizeBytes:
                              selectedResultAsset?.sizeBytes ??
                              currentResultVersionRecord?.sizeBytes ??
                              0,
                            status: 'ready',
                            contentUrl: currentResultContentUrl,
                            tags: [],
                          }}
                          className="inspector-result-preview"
                        />
                        <span>打开结果</span>
                        <ExternalLink size={13} aria-hidden="true" />
                      </a>
                    ) : (
                      <p className="inspector-result-pending">结果已归档，内容链接待刷新。</p>
                    )}
                    {resultVersionsLoading && (
                      <p className="inspector-result-pending" aria-live="polite">
                        正在加载结果版本…
                      </p>
                    )}
                    {resultVersionsError && (
                      <p className="inspector-result-pending" aria-live="polite">
                        版本列表加载失败：{resultVersionsError}，仍显示当前结果。
                      </p>
                    )}
                    {!resultVersionsLoading &&
                      !resultVersionsError &&
                      resultVersions.length > 0 && (
                        <div className="inspector-result-version-list" aria-label="结果版本列表">
                          <span className="inspector-result-version-list-label">归档版本</span>
                          <ul>
                            {resultVersions.map((version) => {
                              const versionUrl = resolveUploadUrl(version.contentUrl, API_BASE_URL);
                              const isCurrent = version.version === currentResultVersion;
                              return (
                                <li key={version.id}>
                                  <a
                                    href={versionUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    aria-current={isCurrent ? 'true' : undefined}
                                  >
                                    版本 {version.version}
                                  </a>
                                  {isCurrent ? <span>（当前）</span> : null}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    <p className="inspector-result-summary">{selectedRun.result.summary}</p>
                  </section>
                )}
              </div>
            ) : (
              <div className="inspector-empty">
                <span className="inspector-line" />
                <p>选择画布中的节点查看属性。</p>
                <div className="asset-summary">
                  <span>资源总数</span>
                  <strong>{assets.length}</strong>
                  <small>
                    {assetSummary.image} 图片 · {assetSummary.audio} 音频 · {assetSummary.video}{' '}
                    视频
                  </small>
                </div>
              </div>
            )}
          </aside>
        </div>
        {showSettings && (
          <SettingsPanel
            onClose={() => setShowSettings(false)}
            onNotice={setNotice}
            onModelsChange={setModelCatalog}
          />
        )}
      </main>
    </ReactFlowProvider>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
