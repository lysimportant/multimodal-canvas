import {
  AudioLines,
  Circle,
  Check,
  Clock3,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  Search,
  SquarePlus,
  Upload,
  Video,
  X,
} from 'lucide-react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import {
  isPortConnectionAllowed,
  mediaTypes,
  type Asset,
  type CanvasDocument,
  type MediaType,
  type NodeMode,
  type RunRecord,
  type RunStatus,
} from '@multimodal-canvas/domain';

import '@xyflow/react/dist/style.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ASSET_DRAG_TYPE = 'application/x-multimodal-asset';
const PROJECT_STORAGE_KEY = 'multimodal-canvas:project-id';
const CANVAS_DRAFT_KEY = 'multimodal-canvas:canvas';

const mediaLabels: Record<MediaType, string> = {
  text: '文字',
  image: '图片',
  audio: '音频',
  video: '视频',
};

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

type FlowNodeData = CanvasDocument['nodes'][number]['data'] & {
  runStatus?: RunStatus;
  runProgress?: number;
  runError?: string;
};

type AssetFlowNode = Node<FlowNodeData, MediaType>;
type FlowEdge = Edge;
type AssetFilter = 'all' | MediaType;
type CanvasApiDocument = CanvasDocument;
type LocalCanvasDraft = {
  revision: number;
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
};

function fromCanvasDocument(document: CanvasApiDocument) {
  return {
    nodes: document.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        mimeType: node.data.mimeType ?? 'application/octet-stream',
      },
    })) as AssetFlowNode[],
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      sourceHandle: edge.sourceHandle,
      target: edge.targetNodeId,
      targetHandle: edge.targetHandle,
    })) as FlowEdge[],
  };
}

function toCanvasDocument(
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
  revision: number,
): CanvasDocument {
  const orders = new Map<string, number>();
  return {
    revision,
    nodes: nodes.map(({ id, type, position, data }) => {
      const {
        runStatus: _runStatus,
        runProgress: _runProgress,
        runError: _runError,
        ...savedData
      } = data;
      return { id, type, position, data: savedData };
    }),
    edges: edges
      .filter((edge): edge is FlowEdge & { source: string; target: string } =>
        Boolean(edge.source && edge.target),
      )
      .map((edge) => {
        const orderKey = `${edge.target}:${edge.targetHandle ?? 'input:content'}`;
        const order = orders.get(orderKey) ?? 0;
        orders.set(orderKey, order + 1);
        return {
          id: edge.id,
          sourceNodeId: edge.source,
          sourceHandle: edge.sourceHandle ?? 'output:content',
          targetNodeId: edge.target,
          targetHandle: edge.targetHandle ?? 'input:content',
          order,
        };
      }),
  };
}

function assetUrl(contentUrl: string) {
  return contentUrl.startsWith('http') ? contentUrl : `${API_BASE_URL}${contentUrl}`;
}

function uploadAsset(file: File, onProgress: (progress: number) => void) {
  return new Promise<Asset>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API_BASE_URL}/v1/assets/uploads`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error('上传请求失败'));
    request.onload = () => {
      let result: { asset?: Asset; error?: string } = {};
      try {
        result = JSON.parse(request.responseText) as { asset?: Asset; error?: string };
      } catch {
        reject(new Error('上传响应无法解析'));
        return;
      }
      if (request.status < 200 || request.status >= 300 || !result.asset) {
        reject(new Error(result.error ?? `${file.name} 上传失败`));
        return;
      }
      resolve(result.asset);
    };
    const formData = new FormData();
    formData.append('file', file);
    request.send(formData);
  });
}

function AssetPreview({ asset, className = '' }: { asset: Asset; className?: string }) {
  const src = assetUrl(asset.contentUrl);
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
  const previewAsset =
    data.assetId && data.contentUrl
      ? ({
          id: data.assetId,
          name: data.label,
          mediaType: data.mediaType,
          mimeType: data.mimeType ?? 'application/octet-stream',
          sizeBytes: 0,
          status: 'ready',
          contentUrl: data.contentUrl,
        } satisfies Asset)
      : undefined;

  return (
    <div
      className={`flow-asset-node ${data.mode !== 'source' ? 'flow-generate-node' : ''} ${selected ? 'is-selected' : ''}`}
    >
      <Handle type="target" position={Position.Left} id="input:content" />
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
  activeFilter,
  query,
  isUploading,
  uploadProgress,
  onFilterChange,
  onQueryChange,
  onFilesSelected,
  onAssetDragStart,
  onAddAsset,
  onDrop,
}: {
  assets: Asset[];
  activeFilter: AssetFilter;
  query: string;
  isUploading: boolean;
  uploadProgress: number | null;
  onFilterChange: (filter: AssetFilter) => void;
  onQueryChange: (query: string) => void;
  onFilesSelected: (files: FileList | File[]) => void;
  onAssetDragStart: (event: DragEvent, asset: Asset) => void;
  onAddAsset: (asset: Asset) => void;
  onDrop: (event: DragEvent) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const filteredAssets = assets.filter((asset) => {
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
            className="asset-card"
            draggable
            key={asset.id}
            onDragStart={(event) => onAssetDragStart(event, asset)}
            title="拖入画布创建来源节点"
          >
            <AssetPreview asset={asset} className="asset-card-preview" />
            <div className="asset-card-copy">
              <strong title={asset.name}>{asset.name}</strong>
              <span>
                {mediaLabels[asset.mediaType]} · {formatBytes(asset.sizeBytes)}
              </span>
            </div>
            <button
              type="button"
              className="asset-add-button"
              aria-label={`添加 ${asset.name} 到画布`}
              title="添加到画布"
              onClick={() => onAddAsset(asset)}
            >
              <SquarePlus size={16} />
            </button>
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

function WorkflowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onCanvasDrop,
  onNodeSelect,
  onAddGenerateNode,
}: {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
  onNodesChange: OnNodesChange<AssetFlowNode>;
  onEdgesChange: OnEdgesChange<FlowEdge>;
  onConnect: (connection: Connection) => void;
  onCanvasDrop: (
    files: File[],
    assetId: string | undefined,
    position: { x: number; y: number },
  ) => void;
  onNodeSelect: (node: AssetFlowNode) => void;
  onAddGenerateNode: (mediaType: MediaType) => void;
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
        <Background color="#d8dde5" gap={24} size={1.2} />
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
  const [activeFilter, setActiveFilter] = useState<AssetFilter>('all');
  const [query, setQuery] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [selectedNode, setSelectedNode] = useState<AssetFlowNode | null>(null);
  const [runRecords, setRunRecords] = useState<Record<string, RunRecord>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [saveState, setSaveState] = useState('准备就绪');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const canvasRevisionRef = useRef(0);
  const canvasDirtyRef = useRef(false);
  const saveRequestRef = useRef<Promise<void> | null>(null);
  const initializedRef = useRef(false);
  const [nodes, setNodes, applyNodesChange] = useNodesState<AssetFlowNode>([]);
  const [edges, setEdges, applyEdgesChange] = useEdgesState<FlowEdge>([]);

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
      applyNodesChange(changes);
    },
    [applyNodesChange],
  );

  const handleEdgesChange: OnEdgesChange<FlowEdge> = useCallback(
    (changes) => {
      canvasDirtyRef.current = true;
      applyEdgesChange(changes);
    },
    [applyEdgesChange],
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

  const loadProjectCanvas = useCallback(async () => {
    setIsCanvasReady(false);
    try {
      let currentProjectId = localStorage.getItem(PROJECT_STORAGE_KEY);
      if (currentProjectId) {
        const existing = await fetch(`${API_BASE_URL}/v1/projects/${currentProjectId}`);
        if (!existing.ok) currentProjectId = null;
      }
      if (!currentProjectId) {
        const created = await fetch(`${API_BASE_URL}/v1/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '未命名项目' }),
        });
        if (!created.ok) throw new Error('项目创建失败');
        const result = (await created.json()) as { project: { id: string } };
        currentProjectId = result.project.id;
        localStorage.setItem(PROJECT_STORAGE_KEY, currentProjectId);
      }

      const response = await fetch(`${API_BASE_URL}/v1/projects/${currentProjectId}/canvas`);
      if (!response.ok) throw new Error('画布加载失败');
      const result = (await response.json()) as { canvas: CanvasApiDocument };
      setProjectId(currentProjectId);
      canvasRevisionRef.current = result.canvas.revision;
      setCanvasRevision(result.canvas.revision);
      const flowCanvas = fromCanvasDocument(result.canvas);
      setNodes(flowCanvas.nodes);
      setEdges(flowCanvas.edges);
      canvasDirtyRef.current = false;
      setSaveState(result.canvas.revision > 0 ? '已从项目恢复' : '项目已连接');
    } catch (error) {
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
          canvasDirtyRef.current = false;
          setSaveState('本地草稿已恢复');
        }
      } catch {
        setNotice({ kind: 'error', message: '本地画布草稿无法恢复' });
      }
    } finally {
      setIsCanvasReady(true);
    }
  }, [setEdges, setNodes]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void loadAssets();
    void loadProjectCanvas();
  }, [loadAssets, loadProjectCanvas]);

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
    [createNodeForAsset, setNodes],
  );

  const handleCanvasDrop = useCallback(
    (files: File[], assetId: string | undefined, position: { x: number; y: number }) => {
      if (assetId) {
        const asset = assets.find((item) => item.id === assetId);
        if (!asset) {
          setNotice({ kind: 'error', message: '资源已不存在，请刷新资源库' });
          return;
        }
        setNodes((current) => [...current, createNodeForAsset(asset, position)]);
        canvasDirtyRef.current = true;
        return;
      }
      void uploadFiles(files, position);
    },
    [assets, createNodeForAsset, setNodes, uploadFiles],
  );

  const handleAssetDragStart = useCallback((event: DragEvent, asset: Asset) => {
    event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

  const handleAddAsset = useCallback(
    (asset: Asset) => {
      const column = nodes.length % 3;
      const row = Math.floor(nodes.length / 3);
      setNodes((current) => [
        ...current,
        createNodeForAsset(asset, { x: 80 + column * 230, y: 80 + row * 210 }),
      ]);
      canvasDirtyRef.current = true;
      setNotice({ kind: 'success', message: `${asset.name} 已添加到画布` });
    },
    [createNodeForAsset, nodes.length, setNodes],
  );

  const handleAddGenerateNode = useCallback(
    (mediaType: MediaType) => {
      const column = nodes.length % 3;
      const row = Math.floor(nodes.length / 3);
      const node = createGenerateNode(mediaType, { x: 100 + column * 250, y: 100 + row * 220 });
      setNodes((current) => [...current, node]);
      setSelectedNode(node);
      canvasDirtyRef.current = true;
      setNotice({ kind: 'success', message: `${mediaLabels[mediaType]}生成节点已添加` });
    },
    [createGenerateNode, nodes.length, setNodes],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target)
        return;
      const source = nodes.find((node) => node.id === connection.source);
      const target = nodes.find((node) => node.id === connection.target);
      if (
        !source ||
        !target ||
        !connection.sourceHandle ||
        !connection.targetHandle ||
        !isPortConnectionAllowed(source, connection.sourceHandle, target, connection.targetHandle)
      )
        return;
      const duplicate = edges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          edge.targetHandle === connection.targetHandle,
      );
      if (duplicate) return;
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
    [edges, nodes, setEdges],
  );

  const selectedAsset = selectedNode
    ? assets.find((asset) => asset.id === selectedNode.data.assetId)
    : undefined;

  const selectedRun = selectedNode ? runRecords[selectedNode.id] : undefined;

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
                },
              }
            : node,
        ),
      );
    },
    [setNodes],
  );

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
          body: JSON.stringify({ projectId }),
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
            <span className="project-name">未命名项目</span>
            <span className="save-state">
              {saveState.includes('保存') ? <Check size={13} aria-hidden="true" /> : null}
              {saveState}
            </span>
          </div>
          <div className="topbar-actions">
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

        <div className="workspace">
          <ResourcePanel
            assets={assets}
            activeFilter={activeFilter}
            query={query}
            isUploading={isUploading}
            uploadProgress={uploadProgress}
            onFilterChange={setActiveFilter}
            onQueryChange={setQuery}
            onFilesSelected={(files) => void uploadFiles(Array.from(files))}
            onAssetDragStart={handleAssetDragStart}
            onAddAsset={handleAddAsset}
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
            onCanvasDrop={handleCanvasDrop}
            onNodeSelect={setSelectedNode}
            onAddGenerateNode={handleAddGenerateNode}
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
      </main>
    </ReactFlowProvider>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
