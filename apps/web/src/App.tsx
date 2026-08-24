import {
  AudioLines,
  Check,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
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

import type { Asset, MediaType } from '@multimodal-canvas/domain';

import '@xyflow/react/dist/style.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ASSET_DRAG_TYPE = 'application/x-multimodal-asset';

const mediaLabels: Record<MediaType, string> = {
  text: '文字',
  image: '图片',
  audio: '音频',
  video: '视频',
};

const mediaIcons: Record<MediaType, typeof FileText> = {
  text: FileText,
  image: ImageIcon,
  audio: AudioLines,
  video: Video,
};

type AssetNodeData = {
  label: string;
  mediaType: MediaType;
  mode: 'source';
  assetId: string;
  contentUrl: string;
  mimeType: string;
};

type AssetFlowNode = Node<AssetNodeData, MediaType>;
type FlowEdge = Edge;
type AssetFilter = 'all' | MediaType;

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
  const previewAsset: Asset = {
    id: data.assetId,
    name: data.label,
    mediaType: data.mediaType,
    mimeType: data.mimeType,
    sizeBytes: 0,
    status: 'ready',
    contentUrl: data.contentUrl,
  };

  return (
    <div className={`flow-asset-node ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} id="input:content" />
      <div className="flow-node-header">
        <span className={`media-icon media-icon-${data.mediaType}`}>
          <Icon size={15} strokeWidth={2} aria-hidden="true" />
        </span>
        <span className="flow-node-type">{mediaLabels[data.mediaType]}来源</span>
        <span className="flow-node-status">
          <Check size={12} aria-hidden="true" />
        </span>
      </div>
      <AssetPreview asset={previewAsset} className="flow-node-preview" />
      <div className="flow-node-label" title={data.label}>
        {data.label}
      </div>
      <Handle type="source" position={Position.Right} id={`output:${data.mediaType}`} />
    </div>
  );
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
  const [nodes, setNodes, onNodesChange] = useNodesState<AssetFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [activeFilter, setActiveFilter] = useState<AssetFilter>('all');
  const [query, setQuery] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [selectedNode, setSelectedNode] = useState<AssetFlowNode | null>(null);
  const [saveState, setSaveState] = useState('准备就绪');

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

  useEffect(() => {
    void loadAssets();
    try {
      const stored = localStorage.getItem('multimodal-canvas:canvas');
      if (stored) {
        const parsed = JSON.parse(stored) as { nodes?: AssetFlowNode[]; edges?: typeof edges };
        setNodes(parsed.nodes ?? []);
        setEdges(parsed.edges ?? []);
        setSaveState('本地草稿已恢复');
      }
    } catch {
      setNotice({ kind: 'error', message: '本地画布草稿无法恢复' });
    }
  }, [loadAssets, setEdges, setNodes]);

  useEffect(() => {
    localStorage.setItem('multimodal-canvas:canvas', JSON.stringify({ revision: 0, nodes, edges }));
    if (nodes.length > 0 && saveState === '本地草稿已恢复') return;
    if (nodes.length > 0) setSaveState('已保存到本地草稿');
  }, [edges, nodes, saveState]);

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
      setNotice({ kind: 'success', message: `${asset.name} 已添加到画布` });
    },
    [createNodeForAsset, nodes.length, setNodes],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target)
        return;
      const duplicate = edges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          edge.targetHandle === connection.targetHandle,
      );
      if (duplicate || connection.targetHandle !== 'input:content') return;
      setEdges((current) => [
        ...current,
        {
          ...connection,
          id: `edge_${connection.source}_${connection.target}_${Date.now()}`,
          animated: true,
        },
      ]);
    },
    [edges, setEdges],
  );

  const selectedAsset = selectedNode
    ? assets.find((asset) => asset.id === selectedNode.data.assetId)
    : undefined;
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
            <button type="button" className="button button-primary" disabled={nodes.length === 0}>
              运行
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
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onCanvasDrop={handleCanvasDrop}
            onNodeSelect={setSelectedNode}
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
