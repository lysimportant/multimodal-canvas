import {
  Archive,
  Check,
  ChevronDown,
  Clock3,
  Download,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  LoaderCircle,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Pencil,
  RotateCcw,
  Search,
  Settings,
  Redo2,
  Undo2,
  Upload,
  UserCircle,
  Video,
  X,
} from 'lucide-react';
import {
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type InputHTMLAttributes,
} from 'react';

import {
  type Asset,
  type CanvasDocument,
  type MediaType,
  type NodeMode,
  type RunRecord,
} from '@multimodal-canvas/domain';
import {
  fromCanvasDocument,
  copyCanvasSelection,
  pasteCanvasClipboard,
  parseCanvasClipboard,
  serializeCanvasClipboard,
  toCanvasDocument,
  markDownstreamNodesStale,
  withNodeAutoGrowthLimit,
  withoutNodeAutoGrowthLimit,
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
import { createUniqueNodeLabel } from './app-contract-utils';
import { validateResolvedCanvasConnection, validateCanvasConnection } from './connection-utils';
import { isCanvasShortcutTarget } from './keyboard-utils';
import { isImeKeyboardEvent, useImeDraft } from './ime';
import { downloadProjectExport, fetchProjectExport, type ProjectExportKind } from './export-utils';
import { ProjectHub } from './ProjectHub';
import { TextPromptEditor } from './TextPromptEditor';
import { CommandPalette, type CommandPaletteCommand } from './CommandPalette';
import { AppNavigation } from './navigation';
import {
  ContactPage,
  HomePage,
  NotFoundPage,
  ProjectCanvasPage,
  SettingsPage,
  WorkspacePage,
} from './pages';
import {
  ProjectQueryError,
  projectQueryKeys,
  useProjectQuery,
  useProjectsQuery,
  type ProjectSummary,
} from './query/projects';
import { appPaths, useAppNavigate, useAppRoute, type AppRoute } from './routing';
import { AssetPreview, TextResultContent } from './workspace/AssetPreview';
import { runStatusLabel } from './workspace/AssetNode';
import { ResourcePanel } from './workspace/ResourcePanel';
import { RunPanel } from './workspace/RunPanel';
import { SettingsPanel } from './workspace/SettingsPanel';
import { WorkflowCanvas } from './workspace/WorkflowCanvas';
import type { InferenceStrength } from './workspace/NodeQuickEditor';
import { useRunResultState } from './workspace/useRunResultState';
import { AppQueryProvider } from './query/client';
import { useAiCredentialsQuery } from './query/credentials';
import { useCredentialModelCatalogQueries } from './query/models';
import {
  mergeRunUpdate,
  shouldApplyRunUpdate,
  shouldClearNodeStale,
  type RunUpdate,
} from './run-update-utils';
import { useWorkspacePreferences, type CanvasTheme } from './state/workspace-preferences';
import {
  API_BASE_URL,
  ASSET_DRAG_TYPE,
  formatBytes,
  mediaIcons,
  mediaLabels,
  modeLabels,
  type AssetFilter,
  type CanvasBackground,
  type ModelEntry,
  type ModelSelection,
} from './workspace/contracts';
import {
  apiFetch,
  clearAuthSession,
  getAuthToken,
  login as loginWithApi,
  logout as logoutWithApi,
  notifyUnauthorized,
  openAuthEventStream,
  readAuthSession,
  register as registerWithApi,
  setUnauthorizedHandler,
  type AuthUser,
  type StoredAuthSession,
} from './auth-client';

import '@xyflow/react/dist/style.css';

const PROJECT_STORAGE_KEY = 'multimodal-canvas:project-id';
const CANVAS_DRAFT_KEY_PREFIX = 'multimodal-canvas:canvas';

type CanvasApiDocument = CanvasDocument;
type LocalCanvasDraft = CanvasDocument;

function canvasDraftKey(projectId: string) {
  return `${CANVAS_DRAFT_KEY_PREFIX}:${projectId}`;
}

type ImeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd' | 'onBlur'
> & {
  value: string;
  identity?: string;
  onValueChange: (value: string) => void;
  onValueBlur?: (value: string) => void;
};

function ImeInput({ value, identity, onValueChange, onValueBlur, ...props }: ImeInputProps) {
  const { bind } = useImeDraft<HTMLInputElement>({
    value,
    identity,
    onCommit: onValueChange,
    onBlur: onValueBlur,
  });
  return <input {...props} {...bind} />;
}

function ProjectCreateDialog({
  open,
  name,
  error,
  busy,
  onNameChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  name: string;
  error: string;
  busy: boolean;
  onNameChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event)) return;
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;
  return (
    <div
      className="project-create-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="project-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-create-title"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && isImeKeyboardEvent(event)) event.preventDefault();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
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
            onClick={onClose}
            disabled={busy}
          >
            <X size={17} />
          </button>
        </div>
        <label className="project-create-field">
          <span>项目名称</span>
          <ImeInput
            autoFocus
            value={name}
            maxLength={80}
            onValueChange={onNameChange}
            placeholder="例如：春季短片工作流"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'project-create-error' : undefined}
          />
          {error && (
            <span id="project-create-error" className="project-create-error" role="alert">
              {error}
            </span>
          )}
        </label>
        <div className="project-create-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy && <LoaderCircle className="spin" size={15} />}
            {busy ? '创建中' : '创建项目'}
          </button>
        </div>
      </form>
    </div>
  );
}

type CanvasHistorySnapshot = {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
};

const themeOptions: Array<{ value: CanvasTheme; label: string; swatch: string }> = [
  { value: 'eye-care', label: '护眼', swatch: 'theme-swatch-eye-care' },
  { value: 'light', label: '明亮', swatch: 'theme-swatch-light' },
  { value: 'dark', label: '深色', swatch: 'theme-swatch-dark' },
  { value: 'sepia', label: '暖白', swatch: 'theme-swatch-sepia' },
  { value: 'contrast', label: '高对比', swatch: 'theme-swatch-contrast' },
];

const canvasBackgroundOptions: Array<{ value: CanvasBackground; label: string }> = [
  { value: 'dots', label: '点' },
  { value: 'lines', label: '线条' },
  { value: 'cross', label: '十字' },
  { value: 'blank', label: '空白' },
];

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
  const initResponse = await apiFetch(`${API_BASE_URL}/v1/assets/uploads/init`, {
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
    const token = getAuthToken();
    if (token) request.setRequestHeader('authorization', `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 90));
    };
    request.onerror = () => reject(new Error(`${file.name} 上传请求失败`));
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        if (request.status === 401) {
          notifyUnauthorized();
        }
        reject(new Error(`${file.name} 上传失败（${request.status}）`));
        return;
      }
      onProgress(90);
      resolve();
    };
    request.send(content);
  });

  const completeResponse = await apiFetch(
    resolveCompleteUrl(initResult.completeUrl!, API_BASE_URL),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildUploadCompletePayload(initResult.uploadId, metadata)),
    },
  );
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

function WorkspaceApp({
  route,
  initialProject,
  authUser,
  onRequestLogin,
  onLoggedOut,
  onNavigate,
}: {
  route: Extract<AppRoute, { id: 'project' }>;
  initialProject: ProjectSummary;
  authUser: AuthUser | null;
  onRequestLogin: () => void;
  onLoggedOut: () => void;
  onNavigate: (to: string) => void;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeFilter, setActiveFilter] = useState<AssetFilter>('all');
  const [query, setQuery] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const credentialsQuery = useAiCredentialsQuery();
  const credentialModelQueries = useCredentialModelCatalogQueries(
    (credentialsQuery.data ?? []).map((credential) => credential.id),
  );
  const modelCatalog = useMemo(() => {
    const credentials = credentialsQuery.data ?? [];
    const credentialLabels = new Map(
      credentials.map((credential) => [
        credential.id,
        `${credential.baseUrl} · ${credential.keyFingerprint}`,
      ]),
    );
    const catalog = new Map<string, ModelEntry>();
    for (const queryResult of credentialModelQueries) {
      for (const model of queryResult.data ?? []) {
        const key = `${model.credentialId ?? 'active'}\0${model.id}`;
        catalog.set(key, {
          ...model,
          ...(model.credentialId
            ? { credentialLabel: credentialLabels.get(model.credentialId) ?? model.credentialLabel }
            : {}),
        });
      }
    }
    return [...catalog.values()];
  }, [credentialModelQueries, credentialsQuery.data]);
  const [runRecords, setRunRecords] = useState<Record<string, RunRecord>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [saveState, setSaveState] = useState('准备就绪');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('未命名项目');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [showProjects, setShowProjects] = useState(false);
  const [showProjectHub, setShowProjectHub] = useState(false);
  const [includeArchivedProjects, setIncludeArchivedProjects] = useState(false);
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [projectCreateName, setProjectCreateName] = useState('未命名项目');
  const [projectCreateError, setProjectCreateError] = useState('');
  const [isProjectLoading, setIsProjectLoading] = useState(false);
  const canvasBackground = useWorkspacePreferences((state) => state.canvasBackground);
  const setCanvasBackground = useWorkspacePreferences((state) => state.setCanvasBackground);
  const canvasTheme = useWorkspacePreferences((state) => state.canvasTheme);
  const setCanvasTheme = useWorkspacePreferences((state) => state.setCanvasTheme);
  const [showBackgroundMenu, setShowBackgroundMenu] = useState(false);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const isResourceCollapsed = useWorkspacePreferences((state) => state.isResourcePanelCollapsed);
  const setIsResourceCollapsed = useWorkspacePreferences(
    (state) => state.setResourcePanelCollapsed,
  );
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const commandPaletteTriggerRef = useRef<HTMLButtonElement>(null);
  const backgroundTriggerRef = useRef<HTMLButtonElement>(null);
  const backgroundMenuRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const canvasCenterPositionRef = useRef<{ x: number; y: number } | null>(null);
  const exportMenuWasOpenRef = useRef(false);
  const settingsWasOpenRef = useRef(false);
  const canvasRevisionRef = useRef(0);
  const canvasDirtyRef = useRef(false);
  const saveRequestRef = useRef<Promise<void> | null>(null);
  const refreshedResultAssetKeysRef = useRef(new Set<string>());
  const runRecordsRef = useRef<Record<string, RunRecord>>({});
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
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  useEffect(() => {
    if (settingsWasOpenRef.current && !showSettings) settingsTriggerRef.current?.focus();
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
    if (!showBackgroundMenu) return;
    const focusFrame = window.requestAnimationFrame(() => {
      backgroundMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
        ?.focus();
    });
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest('.background-control, .canvas-node-background-tool')
      ) {
        setShowBackgroundMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event)) return;
      if (event.key === 'Escape') {
        setShowBackgroundMenu(false);
        backgroundTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showBackgroundMenu]);

  useEffect(() => {
    if (!showThemeMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('.theme-control')) {
        setShowThemeMenu(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [showThemeMenu]);

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
    if (!showExportMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('.export-control')) {
        setShowExportMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event)) return;
      if (event.key === 'Escape') setShowExportMenu(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showExportMenu]);

  useEffect(() => {
    if (exportMenuWasOpenRef.current && !showExportMenu) {
      exportTriggerRef.current?.focus();
    }
    exportMenuWasOpenRef.current = showExportMenu;
  }, [showExportMenu]);

  useEffect(() => {
    const handleCommandShortcut = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event)) return;
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey)) return;

      // 搜索是全局命令，即使焦点在输入控件中也应拦截浏览器默认行为。
      if (key === 'e') {
        event.preventDefault();
        setShowCommandPalette(true);
        return;
      }

      if (key !== 'k' || isCanvasShortcutTarget(event.target)) return;
      event.preventDefault();
      setShowCommandPalette(true);
    };
    window.addEventListener('keydown', handleCommandShortcut);
    return () => window.removeEventListener('keydown', handleCommandShortcut);
  }, []);

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

  /**
   * 清空当前画布中的节点与连线。
   *
   * 清空属于可逆的画布编辑操作：执行前要求用户确认，并将当前快照写入
   * 历史记录，因此仍可通过撤销恢复；项目资源库中的资产不会被删除。
   */
  const clearCanvas = useCallback(() => {
    if (nodesRef.current.length === 0 && edgesRef.current.length === 0) return;
    if (!window.confirm('确定清空当前画布吗？画布资源不会删除，且可以通过撤销恢复。')) return;
    rememberHistory();
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    canvasDirtyRef.current = true;
    setNotice({ kind: 'success', message: '画布已清空，可通过撤销恢复' });
  }, [rememberHistory, setEdges, setNodes]);

  const handleNodesChange: OnNodesChange<AssetFlowNode> = useCallback(
    (changes) => {
      if (
        changes.some((change) =>
          ['position', 'dimensions', 'add', 'remove', 'replace'].includes(change.type),
        )
      ) {
        canvasDirtyRef.current = true;
      }
      if (
        changes.some((change) => ['dimensions', 'add', 'remove', 'replace'].includes(change.type))
      ) {
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

  const handleResizeNode = useCallback(
    (nodeId: string, width: number, height: number) => {
      rememberHistory();
      canvasDirtyRef.current = true;
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId ? withNodeAutoGrowthLimit({ ...node, width, height }) : node,
        ),
      );
    },
    [rememberHistory, setNodes],
  );

  const handleResizeStart = useCallback(
    (nodeId: string) => {
      setNodes((current) =>
        current.map((node) => (node.id === nodeId ? withoutNodeAutoGrowthLimit(node) : node)),
      );
    },
    [setNodes],
  );

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
      const response = await apiFetch(`${API_BASE_URL}/v1/assets`);
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
    const response = await apiFetch(`${API_BASE_URL}/v1/assets/${asset.id}`, {
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
    const response = await apiFetch(`${API_BASE_URL}/v1/assets/${asset.id}/${action}`, {
      method: 'POST',
    });
    const result = (await response.json().catch(() => ({}))) as { asset?: Asset; error?: string };
    if (!response.ok || !result.asset) throw new Error(result.error ?? '资源状态更新失败');
    setAssets((current) => current.map((item) => (item.id === asset.id ? result.asset! : item)));
  }, []);

  const refreshProjects = useCallback(async (includeArchived = false) => {
    const query = includeArchived ? '?includeArchived=true' : '';
    const response = await apiFetch(`${API_BASE_URL}/v1/projects${query}`);
    const result = (await response.json().catch(() => ({}))) as {
      projects?: ProjectSummary[];
      error?: string;
    };
    if (!response.ok || !result.projects) throw new Error(result.error ?? '项目列表加载失败');
    setProjects(result.projects);
    return result.projects;
  }, []);

  const renameProject = useCallback(
    async (project: ProjectSummary, name: string) => {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/projects/${encodeURIComponent(project.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        project?: ProjectSummary;
        error?: string;
      };
      if (!response.ok || !result.project) throw new Error(result.error ?? '项目重命名失败');
      setProjects((current) =>
        current.map((item) => (item.id === project.id ? result.project! : item)),
      );
      if (project.id === projectId) setProjectName(result.project.name);
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      setNotice({ kind: 'success', message: `项目已重命名为「${result.project.name}」` });
    },
    [projectId, queryClient],
  );

  const setProjectArchived = useCallback(
    async (project: ProjectSummary, archived: boolean) => {
      if (archived && project.id === projectId) {
        throw new Error('请先切换到其他项目，再归档当前项目');
      }
      const action = archived ? 'archive' : 'restore';
      const response = await apiFetch(
        `${API_BASE_URL}/v1/projects/${encodeURIComponent(project.id)}/${action}`,
        { method: 'POST' },
      );
      const result = (await response.json().catch(() => ({}))) as {
        project?: ProjectSummary;
        error?: string;
      };
      if (!response.ok || !result.project) {
        throw new Error(result.error ?? (archived ? '项目归档失败' : '项目恢复失败'));
      }
      if (includeArchivedProjects) {
        setProjects((current) =>
          current.map((item) => (item.id === project.id ? result.project! : item)),
        );
      } else if (archived) {
        setProjects((current) => current.filter((item) => item.id !== project.id));
      } else {
        setProjects((current) =>
          [...current.filter((item) => item.id !== project.id), result.project!].sort(
            (left, right) => right.updatedAt.localeCompare(left.updatedAt),
          ),
        );
      }
      setNotice({
        kind: 'success',
        message: archived ? `项目「${project.name}」已归档` : `项目「${project.name}」已恢复`,
      });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
    },
    [includeArchivedProjects, projectId, queryClient],
  );

  const toggleArchivedProjects = useCallback(() => {
    const next = !includeArchivedProjects;
    setIncludeArchivedProjects(next);
    void refreshProjects(next).catch((error: unknown) =>
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '项目列表加载失败',
      }),
    );
  }, [includeArchivedProjects, refreshProjects]);

  const loadProjectCanvas = useCallback(
    async (requestedProjectId?: string, project?: ProjectSummary) => {
      setIsCanvasReady(false);
      setIsProjectLoading(true);
      try {
        let currentProjectId = requestedProjectId ?? localStorage.getItem(PROJECT_STORAGE_KEY);
        let currentProject = project;
        if (currentProjectId && !currentProject) {
          const existing = await apiFetch(`${API_BASE_URL}/v1/projects/${currentProjectId}`);
          if (!existing.ok) {
            if (requestedProjectId) throw new Error('目标项目不存在');
            currentProjectId = null;
          } else {
            currentProject = ((await existing.json()) as { project: ProjectSummary }).project;
          }
        }
        if (!currentProjectId) {
          const created = await apiFetch(`${API_BASE_URL}/v1/projects`, {
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

        const response = await apiFetch(`${API_BASE_URL}/v1/projects/${currentProjectId}/canvas`);
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
        setSelectedNodeId(null);
        runRecordsRef.current = {};
        setRunRecords({});
        refreshedResultAssetKeysRef.current.clear();
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
          const fallbackProjectId = requestedProjectId ?? localStorage.getItem(PROJECT_STORAGE_KEY);
          const stored = fallbackProjectId
            ? localStorage.getItem(canvasDraftKey(fallbackProjectId))
            : null;
          if (stored) {
            const parsed = JSON.parse(stored) as LocalCanvasDraft;
            canvasRevisionRef.current = parsed.revision ?? 0;
            setCanvasRevision(parsed.revision ?? 0);
            const flowCanvas = fromCanvasDocument(parsed);
            setNodes(flowCanvas.nodes);
            setEdges(flowCanvas.edges);
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
    void loadProjectCanvas(initialProject.id, initialProject);
    void refreshProjects().catch((error: unknown) =>
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '项目列表加载失败',
      }),
    );
  }, [initialProject, loadAssets, loadProjectCanvas, refreshProjects]);

  useEffect(() => {
    if (!isCanvasReady || !projectId) return;
    localStorage.setItem(
      canvasDraftKey(projectId),
      JSON.stringify(toCanvasDocument(nodes, edges, canvasRevision)),
    );
  }, [canvasRevision, edges, isCanvasReady, nodes, projectId]);

  const saveCanvas = useCallback(async () => {
    if (!projectId) return;
    if (saveRequestRef.current) await saveRequestRef.current;
    if (!canvasDirtyRef.current) return;
    const request = (async () => {
      const snapshotNodes = structuredClone(nodesRef.current);
      const snapshotEdges = structuredClone(edgesRef.current);
      const snapshot = JSON.stringify({ nodes: snapshotNodes, edges: snapshotEdges });
      setSaveState('保存中');
      const document = toCanvasDocument(snapshotNodes, snapshotEdges, canvasRevisionRef.current);
      const response = await apiFetch(`${API_BASE_URL}/v1/projects/${projectId}/canvas`, {
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
        // A second tab or an already queued autosave may have advanced the
        // revision. Refresh the server revision and retry the exact snapshot
        // once so clicking 生成 does not fail just because autosave raced it.
        const latestResponse = await apiFetch(`${API_BASE_URL}/v1/projects/${projectId}/canvas`);
        const latestResult = (await latestResponse.json().catch(() => ({}))) as {
          canvas?: CanvasApiDocument;
        };
        if (!latestResponse.ok || !latestResult.canvas) {
          throw new Error(`画布版本冲突，服务器版本为 ${result.revision ?? '未知'}`);
        }
        canvasRevisionRef.current = latestResult.canvas.revision;
        setCanvasRevision(latestResult.canvas.revision);
        const retryDocument = toCanvasDocument(
          snapshotNodes,
          snapshotEdges,
          latestResult.canvas.revision,
        );
        const retryResponse = await apiFetch(`${API_BASE_URL}/v1/projects/${projectId}/canvas`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(retryDocument),
        });
        const retryResult = (await retryResponse.json().catch(() => ({}))) as {
          canvas?: CanvasApiDocument;
          error?: string;
        };
        if (!retryResponse.ok || !retryResult.canvas) {
          throw new Error(retryResult.error ?? '画布保存失败，请重试');
        }
        canvasRevisionRef.current = retryResult.canvas.revision;
        setCanvasRevision(retryResult.canvas.revision);
        if (JSON.stringify({ nodes: nodesRef.current, edges: edgesRef.current }) === snapshot) {
          canvasDirtyRef.current = false;
        }
        setSaveState('已保存到项目');
        return;
      }
      if (!response.ok || !result.canvas) throw new Error(result.error ?? '画布保存失败');
      canvasRevisionRef.current = result.canvas.revision;
      setCanvasRevision(result.canvas.revision);
      if (JSON.stringify({ nodes: nodesRef.current, edges: edgesRef.current }) === snapshot) {
        canvasDirtyRef.current = false;
      }
      setSaveState('已保存到项目');
    })();
    saveRequestRef.current = request;
    try {
      await request;
    } finally {
      if (saveRequestRef.current === request) saveRequestRef.current = null;
    }
  }, [projectId]);

  const exportProject = useCallback(
    async (kind: ProjectExportKind) => {
      if (!projectId) {
        setNotice({ kind: 'error', message: '项目尚未加载，暂时无法导出' });
        return;
      }
      setIsExporting(true);
      setShowExportMenu(false);
      try {
        // Flush the latest canvas revision before asking the API for a snapshot.
        await saveCanvas();
        const download = await fetchProjectExport(API_BASE_URL, projectId, kind, apiFetch);
        downloadProjectExport(download);
        setNotice({
          kind: 'success',
          message: kind === 'workflow' ? '工作流已导出' : '结果包已导出',
        });
      } catch (error) {
        setNotice({ kind: 'error', message: error instanceof Error ? error.message : '导出失败' });
      } finally {
        setIsExporting(false);
      }
    },
    [projectId, saveCanvas],
  );

  const switchProject = useCallback(
    async (project: ProjectSummary) => {
      if (project.id === projectId || isProjectLoading) {
        setShowProjects(false);
        return;
      }
      try {
        await saveCanvas();
        setShowProjects(false);
        onNavigate(appPaths.project(project.id));
      } catch (error) {
        setNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : '项目切换失败',
        });
      }
    },
    [isProjectLoading, onNavigate, projectId, saveCanvas],
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
      const response = await apiFetch(`${API_BASE_URL}/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        project?: ProjectSummary;
        error?: string;
      };
      if (!response.ok || !result.project) throw new Error(result.error ?? '项目创建失败');
      setProjects((current) => [result.project!, ...current]);
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      setShowProjectCreate(false);
      onNavigate(appPaths.project(result.project.id));
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '项目创建失败',
      });
    } finally {
      setIsProjectLoading(false);
    }
  }, [isProjectLoading, onNavigate, projectCreateName, queryClient, saveCanvas]);

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
  }, [edges, isCanvasReady, nodes, projectId, saveCanvas]);

  const createNodeForAsset = useCallback(
    (asset: Asset, position: { x: number; y: number }): AssetFlowNode => {
      const label = createUniqueNodeLabel(
        asset.name,
        nodesRef.current.map((node) => node.data.label),
      );
      return withNodeAutoGrowthLimit({
        id: `node_${asset.id}_${crypto.randomUUID()}`,
        type: asset.mediaType,
        position,
        data: {
          label,
          mediaType: asset.mediaType,
          mode: 'source',
          assetId: asset.id,
          contentUrl: asset.contentUrl,
          mimeType: asset.mimeType,
        },
      });
    },
    [],
  );

  const createOperationNode = useCallback(
    (
      mediaType: MediaType,
      position: { x: number; y: number },
      mode: Exclude<NodeMode, 'source'>,
    ): AssetFlowNode =>
      withNodeAutoGrowthLimit({
        id: `node_${mediaType}_${mode}_${crypto.randomUUID()}`,
        type: mediaType,
        position,
        data: {
          label: createUniqueNodeLabel(
            `${mediaLabels[mediaType]}${modeLabels[mode]}节点`,
            nodesRef.current.map((node) => node.data.label),
          ),
          mediaType,
          mode,
        },
      }),
    [],
  );

  const createGenerateNode = useCallback(
    (mediaType: MediaType, position: { x: number; y: number }) =>
      createOperationNode(mediaType, position, 'generate'),
    [createOperationNode],
  );

  const createTransformNode = useCallback(
    (mediaType: MediaType, position: { x: number; y: number }) =>
      createOperationNode(mediaType, position, 'transform'),
    [createOperationNode],
  );

  const selectCanvasNode = useCallback(
    (nodeId: string | null) => {
      setSelectedNodeId(nodeId);
      setNodes((current) => {
        let changed = false;
        const next = current.map((node) => {
          const selected = node.id === nodeId;
          if (node.selected === selected) return node;
          changed = true;
          return { ...node, selected };
        });
        return changed ? next : current;
      });
    },
    [setNodes],
  );

  const appendNodesAndSelect = useCallback(
    (newNodes: AssetFlowNode[]) => {
      if (newNodes.length === 0) return;
      const selectedId = newNodes[newNodes.length - 1].id;
      setNodes((current) => [
        ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
        ...newNodes.map((node) => ({ ...node, selected: node.id === selectedId })),
      ]);
      setSelectedNodeId(selectedId);
    },
    [setNodes],
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
          appendNodesAndSelect(
            uploaded.map((asset, index) =>
              createNodeForAsset(asset, { x: position.x + index * 34, y: position.y + index * 34 }),
            ),
          );
        }
        setNotice({ kind: 'success', message: `${uploaded.length} 个资源已加入项目` });
      } catch (error) {
        setNotice({ kind: 'error', message: error instanceof Error ? error.message : '上传失败' });
      } finally {
        setIsUploading(false);
        setUploadProgress(null);
      }
    },
    [appendNodesAndSelect, createNodeForAsset, rememberHistory],
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
        const node = createNodeForAsset(asset, position);
        appendNodesAndSelect([node]);
        canvasDirtyRef.current = true;
        return;
      }
      void uploadFiles(files, position);
    },
    [appendNodesAndSelect, assets, createNodeForAsset, rememberHistory, uploadFiles],
  );

  const handleAssetDragStart = useCallback((event: DragEvent, asset: Asset) => {
    event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

  const handleAddAsset = useCallback(
    (asset: Asset) => {
      const column = nodes.length % 3;
      const row = Math.floor(nodes.length / 3);
      const position =
        canvasCenterPositionRef.current ?? ({ x: 80 + column * 230, y: 80 + row * 210 } as const);
      const node = createNodeForAsset(asset, position);
      rememberHistory();
      appendNodesAndSelect([node]);
      canvasDirtyRef.current = true;
      setNotice({ kind: 'success', message: `${asset.name} 已添加到画布` });
    },
    [appendNodesAndSelect, createNodeForAsset, nodes.length, rememberHistory],
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
    (mediaType: MediaType, position?: { x: number; y: number }) => {
      const column = nodes.length % 3;
      const row = Math.floor(nodes.length / 3);
      const nodePosition =
        position ??
        canvasCenterPositionRef.current ??
        ({ x: 100 + column * 250, y: 100 + row * 220 } as const);
      const node = createGenerateNode(mediaType, nodePosition);
      rememberHistory();
      appendNodesAndSelect([node]);
      canvasDirtyRef.current = true;
      setNotice({ kind: 'success', message: `${mediaLabels[mediaType]}生成节点已添加` });
    },
    [appendNodesAndSelect, createGenerateNode, nodes.length, rememberHistory],
  );

  const handleAddTransformNode = useCallback(
    (mediaType: MediaType, position?: { x: number; y: number }) => {
      const column = nodes.length % 3;
      const row = Math.floor(nodes.length / 3);
      const nodePosition =
        position ??
        canvasCenterPositionRef.current ??
        ({ x: 100 + column * 250, y: 100 + row * 220 } as const);
      const node = createTransformNode(mediaType, nodePosition);
      rememberHistory();
      appendNodesAndSelect([node]);
      canvasDirtyRef.current = true;
      setNotice({ kind: 'success', message: `${mediaLabels[mediaType]}转换节点已添加` });
    },
    [appendNodesAndSelect, createTransformNode, nodes.length, rememberHistory],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const validation = validateResolvedCanvasConnection(connection, nodes, edges);
      if (!validation.ok && validation.reason === 'cycle') {
        setNotice({ kind: 'error', message: '不能创建循环依赖' });
      }
      if (!validation.ok) return;
      rememberHistory();
      const resolvedConnection = validation.connection;
      setEdges((current) => [
        ...current,
        {
          ...resolvedConnection,
          id: `edge_${resolvedConnection.source}_${resolvedConnection.target}_${Date.now()}`,
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
  const runResultState = useRunResultState(selectedNode, selectedRun);

  const updateNodeDataAndMarkDownstreamStale = useCallback(
    (nodeId: string, update: (data: AssetFlowNode['data']) => AssetFlowNode['data']) => {
      setNodes((current) =>
        markDownstreamNodesStale(
          current.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: {
                    ...update(node.data),
                    ...(node.data.mode !== 'source' ? { stale: true } : {}),
                  },
                }
              : node,
          ),
          edgesRef.current,
          [nodeId],
        ),
      );
    },
    [setNodes],
  );

  const updateSelectedModel = useCallback(
    ({ modelAlias, credentialId }: ModelSelection, nodeId?: string) => {
      const targetNodeId = nodeId ?? selectedNode?.id;
      if (!targetNodeId) return;
      rememberHistory();
      canvasDirtyRef.current = true;
      updateNodeDataAndMarkDownstreamStale(targetNodeId, (data) => ({
        ...data,
        modelAlias: modelAlias.trim() || undefined,
        credentialId: modelAlias.trim() && credentialId ? credentialId : undefined,
      }));
    },
    [rememberHistory, selectedNode, updateNodeDataAndMarkDownstreamStale],
  );

  const updateNodeEnabled = useCallback(
    (nodeId: string, enabled: boolean) => {
      rememberHistory();
      canvasDirtyRef.current = true;
      updateNodeDataAndMarkDownstreamStale(nodeId, (data) => ({ ...data, enabled }));
    },
    [rememberHistory, updateNodeDataAndMarkDownstreamStale],
  );

  const updateCanvasCenterPosition = useCallback((position: { x: number; y: number }) => {
    canvasCenterPositionRef.current = position;
  }, []);

  const updateSelectedEnabled = useCallback(
    (enabled: boolean) => {
      if (!selectedNode) return;
      updateNodeEnabled(selectedNode.id, enabled);
    },
    [selectedNode, updateNodeEnabled],
  );

  const updateSelectedPrompt = useCallback(
    (prompt: string, nodeId?: string) => {
      const targetNodeId = nodeId ?? selectedNode?.id;
      if (!targetNodeId) return;
      rememberHistory();
      canvasDirtyRef.current = true;
      updateNodeDataAndMarkDownstreamStale(targetNodeId, (data) => ({
        ...data,
        prompt: prompt || undefined,
      }));
    },
    [rememberHistory, selectedNode, updateNodeDataAndMarkDownstreamStale],
  );

  const updateSelectedParameters = useCallback(
    (parameters: Record<string, unknown>, nodeId?: string) => {
      const targetNodeId = nodeId ?? selectedNode?.id;
      if (!targetNodeId) return;
      rememberHistory();
      canvasDirtyRef.current = true;
      updateNodeDataAndMarkDownstreamStale(targetNodeId, (data) => ({
        ...data,
        parameters,
      }));
    },
    [rememberHistory, selectedNode, updateNodeDataAndMarkDownstreamStale],
  );

  const updateSelectedLabel = useCallback(
    (label: string) => {
      if (!selectedNode) return;
      rememberHistory();
      canvasDirtyRef.current = true;
      updateNodeDataAndMarkDownstreamStale(selectedNode.id, (data) => ({ ...data, label }));
    },
    [rememberHistory, selectedNode, updateNodeDataAndMarkDownstreamStale],
  );

  const updateSelectedMode = useCallback(
    (mode: NodeMode) => {
      if (!selectedNode || selectedNode.data.mode === mode) return;
      rememberHistory();
      canvasDirtyRef.current = true;
      updateNodeDataAndMarkDownstreamStale(selectedNode.id, (data) => ({ ...data, mode }));
    },
    [rememberHistory, selectedNode, updateNodeDataAndMarkDownstreamStale],
  );

  const normalizeSelectedLabel = useCallback(
    (value: string) => {
      if (!selectedNode || value.trim()) return;
      updateSelectedLabel(
        `${mediaLabels[selectedNode.data.mediaType]}${modeLabels[selectedNode.data.mode]}节点`,
      );
    },
    [selectedNode, updateSelectedLabel],
  );

  const copySourcePrompt = useCallback(async (node: AssetFlowNode) => {
    const value = node.data.prompt?.trim() || node.data.label;
    try {
      if (!window.navigator.clipboard) throw new Error('clipboard unavailable');
      await window.navigator.clipboard.writeText(value);
      setNotice({ kind: 'success', message: '来源内容已复制' });
    } catch {
      setNotice({ kind: 'error', message: '当前浏览器不允许访问剪贴板' });
    }
  }, []);

  const addTransformFromSource = useCallback(
    (sourceNode: AssetFlowNode) => {
      const transformNode = createTransformNode(sourceNode.data.mediaType, {
        x: sourceNode.position.x + 280,
        y: sourceNode.position.y,
      });
      const connection: Connection = {
        source: sourceNode.id,
        sourceHandle: `output:${sourceNode.data.mediaType}`,
        target: transformNode.id,
        targetHandle: 'input:content',
      };
      const validation = validateCanvasConnection(connection, [...nodes, transformNode], edges);
      if (!validation.ok) {
        setNotice({ kind: 'error', message: '无法为该来源创建转换节点' });
        return;
      }
      rememberHistory();
      appendNodesAndSelect([transformNode]);
      setEdges((current) => [
        ...current,
        {
          ...connection,
          id: `edge_${connection.source}_${connection.target}_${Date.now()}`,
          animated: true,
        },
      ]);
      canvasDirtyRef.current = true;
      setNotice({ kind: 'success', message: '已创建转换节点并接入来源' });
    },
    [appendNodesAndSelect, createTransformNode, edges, nodes, rememberHistory, setEdges],
  );

  const updateSelectedInferenceStrength = useCallback(
    (inferenceStrength: InferenceStrength, nodeId?: string) => {
      const targetNodeId = nodeId ?? selectedNode?.id;
      if (!targetNodeId) return;
      rememberHistory();
      canvasDirtyRef.current = true;
      updateNodeDataAndMarkDownstreamStale(targetNodeId, (data) => ({
        ...data,
        inferenceStrength,
      }));
    },
    [rememberHistory, selectedNode, updateNodeDataAndMarkDownstreamStale],
  );

  const deleteCanvasSelection = useCallback(
    (nodeIds?: readonly string[]) => {
      const selectedNodeIds = new Set(
        nodeIds ?? nodesRef.current.filter((node) => node.selected).map((node) => node.id),
      );
      const selectedEdgeIds = new Set(
        nodeIds ? [] : edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id),
      );
      if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return false;
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
      setSelectedNodeId((current) => (current && selectedNodeIds.has(current) ? null : current));
      canvasDirtyRef.current = true;
      return true;
    },
    [rememberHistory, setEdges, setNodes],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event)) return;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (key === 'delete' || key === 'backspace') {
        const target = event.target instanceof Element ? event.target : null;
        const isInsideCanvas = Boolean(target?.closest('.canvas-area'));
        const isEditable = Boolean(
          (target instanceof HTMLElement && target.isContentEditable) ||
          target?.closest(
            'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
          ),
        );
        if (isEditable || (isCanvasShortcutTarget(event.target) && !isInsideCanvas)) return;
        if (!deleteCanvasSelection()) return;
        event.preventDefault();
        return;
      }

      // 保存是全局画布命令，即使焦点在输入控件中也应保留 Ctrl/Cmd+S。
      if (command && key === 's') {
        event.preventDefault();
        void saveCanvas().catch((error: unknown) => {
          setSaveState('保存失败');
          setNotice({
            kind: 'error',
            message: error instanceof Error ? error.message : '画布保存失败',
          });
        });
        return;
      }

      if (isCanvasShortcutTarget(event.target)) return;

      if (command && key === 'a') {
        if (nodesRef.current.length === 0) return;
        event.preventDefault();
        setNodes((current) => {
          const next = current.map((node) => (node.selected ? node : { ...node, selected: true }));
          return next.every((node, index) => node === current[index]) ? current : next;
        });
        return;
      }
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
          setSelectedNodeId(pasted.nodes[0]?.id ?? null);
          canvasDirtyRef.current = true;
        })();
        return;
      }
      return;
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    deleteCanvasSelection,
    redoCanvas,
    rememberHistory,
    saveCanvas,
    selectedNode,
    setEdges,
    setNodes,
    undoCanvas,
  ]);

  const updateNodeRunState = useCallback(
    (nodeId: string, incoming: RunUpdate) => {
      const currentRun = runRecordsRef.current[nodeId];
      if (!shouldApplyRunUpdate(currentRun, incoming)) return;
      const run = mergeRunUpdate(currentRun, incoming);
      if (!run) return;
      runRecordsRef.current = { ...runRecordsRef.current, [nodeId]: run };
      setRunRecords(runRecordsRef.current);
      const resultAsset = run.status === 'succeeded' ? run.result?.asset : undefined;
      const resultAssetKey = resultAsset
        ? `${resultAsset.assetId}:${resultAsset.version ?? 0}:${resultAsset.contentUrl ?? ''}`
        : undefined;
      if (resultAssetKey && !refreshedResultAssetKeysRef.current.has(resultAssetKey)) {
        refreshedResultAssetKeysRef.current.add(resultAssetKey);
        void loadAssets();
      }
      const hasResultAsset = Boolean(run.result?.asset);
      setNodes((current) => {
        const clearStale = shouldClearNodeStale(
          run,
          canvasRevisionRef.current,
          canvasDirtyRef.current,
        );
        const updated = current.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  runStatus: run.status,
                  runProgress: run.progress,
                  runError: run.error,
                  resultAsset: hasResultAsset ? run.result?.asset : undefined,
                  ...(clearStale ? { stale: false } : {}),
                },
              }
            : node,
        );
        return run.status === 'succeeded'
          ? markDownstreamNodesStale(updated, edgesRef.current, [nodeId]).map((node) =>
              node.id === nodeId && clearStale
                ? { ...node, data: { ...node.data, stale: false } }
                : node,
            )
          : updated;
      });
    },
    [loadAssets, setNodes],
  );

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void openAuthEventStream(
      `${API_BASE_URL}/v1/projects/${projectId}/events`,
      (eventName, data) => {
        if (eventName !== 'run.updated') return;
        try {
          const run = JSON.parse(data) as RunUpdate;
          updateNodeRunState(run.targetNodeId, run);
        } catch {
          // Ignore malformed events and keep REST polling as a fallback.
        }
      },
      controller.signal,
    ).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // REST polling remains the fallback when SSE is unavailable.
    });
    return () => {
      controller.abort();
    };
  }, [projectId, updateNodeRunState]);

  const fetchRun = useCallback(
    async (runId: string, nodeId: string) => {
      const response = await apiFetch(`${API_BASE_URL}/v1/runs/${runId}`);
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

  // Restore the latest run/result for every node when a project is opened.
  // SSE remains the live update channel, but a REST snapshot is required for
  // browsers where EventSource is unavailable or the stream reconnects late.
  useEffect(() => {
    if (!projectId || !isCanvasReady) return;
    let active = true;
    void apiFetch(`${API_BASE_URL}/v1/projects/${projectId}/runs`)
      .then(async (response) => {
        const result = (await response.json().catch(() => ({}))) as {
          runs?: RunRecord[];
          error?: string;
        };
        if (!response.ok || !Array.isArray(result.runs)) {
          throw new Error(result.error ?? '运行记录加载失败');
        }
        if (!active) return;
        for (const run of result.runs) {
          if (!active) break;
          updateNodeRunState(run.targetNodeId, run);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice({
            kind: 'error',
            message: error instanceof Error ? error.message : '运行记录加载失败',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [isCanvasReady, projectId, updateNodeRunState]);

  const pollRun = useCallback(
    async (runId: string, nodeId: string) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const run = await fetchRun(runId, nodeId);
        if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
        // SSE normally delivers updates immediately; this REST fallback backs
        // off gradually so an unavailable stream does not hammer the API.
        const delayMs = Math.min(1_000, 250 * 2 ** Math.min(2, Math.floor(attempt / 10)));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      throw new Error('运行等待超时');
    },
    [fetchRun],
  );

  const runNode = useCallback(
    async (node: AssetFlowNode) => {
      let nodeSnapshot = nodesRef.current.find((candidate) => candidate.id === node.id) ?? node;
      if (!projectId) {
        setNotice({ kind: 'error', message: '项目尚未连接' });
        return;
      }
      if (nodeSnapshot.data.mode === 'source') {
        setNotice({ kind: 'error', message: '来源节点不能直接运行，请选择生成或转换节点' });
        return;
      }
      if (nodeSnapshot.data.enabled === false) {
        setNotice({ kind: 'error', message: '节点已停用，请先启用后再运行' });
        return;
      }
      setIsRunning(true);
      setNotice(null);
      try {
        await saveCanvas();
        // Quick-editor input handlers update the canvas before a new render has
        // necessarily refreshed the selected-node closure. Submit the saved
        // canvas snapshot so an immediate click never sends stale parameters.
        nodeSnapshot =
          nodesRef.current.find((candidate) => candidate.id === node.id) ?? nodeSnapshot;
        const response = await apiFetch(`${API_BASE_URL}/v1/nodes/${nodeSnapshot.id}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId,
            ...(nodeSnapshot.data.modelAlias ? { modelAlias: nodeSnapshot.data.modelAlias } : {}),
            ...(nodeSnapshot.data.credentialId
              ? { credentialId: nodeSnapshot.data.credentialId }
              : {}),
            parameters: {
              ...(nodeSnapshot.data.prompt?.trim()
                ? { prompt: nodeSnapshot.data.prompt.trim() }
                : {}),
              ...(nodeSnapshot.data.parameters ?? {}),
              ...(nodeSnapshot.data.inferenceStrength
                ? { inferenceStrength: nodeSnapshot.data.inferenceStrength }
                : {}),
            },
          }),
        });
        const result = (await response.json().catch(() => ({}))) as {
          run?: RunRecord;
          error?: string;
        };
        if (!response.ok || !result.run) throw new Error(result.error ?? '运行提交失败');
        updateNodeRunState(nodeSnapshot.id, result.run);
        const completed = await pollRun(result.run.id, nodeSnapshot.id);
        if (completed.status === 'succeeded') {
          setNotice({ kind: 'success', message: `${nodeSnapshot.data.label} 已完成` });
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
      const response = await apiFetch(`${API_BASE_URL}/v1/runs/${selectedRun.id}/cancel`, {
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

  const retryNodeRun = useCallback(
    async (nodeId: string) => {
      const run = runRecordsRef.current[nodeId];
      const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
      if (!run || !node) throw new Error('没有可重试的运行记录');
      setIsRunning(true);
      try {
        const response = await apiFetch(`${API_BASE_URL}/v1/runs/${run.id}/retry`, {
          method: 'POST',
        });
        const result = (await response.json().catch(() => ({}))) as {
          run?: RunRecord;
          error?: string;
        };
        if (!response.ok || !result.run) throw new Error(result.error ?? '重试提交失败');
        updateNodeRunState(nodeId, result.run);
        const completed = await pollRun(result.run.id, nodeId);
        if (completed.status !== 'succeeded') {
          throw new Error(completed.error ?? runStatusLabel(completed.status));
        }
        setNotice({ kind: 'success', message: `${node.data.label} 重试完成` });
      } finally {
        setIsRunning(false);
      }
    },
    [pollRun, updateNodeRunState],
  );

  const retrySelectedRun = useCallback(async () => {
    if (!selectedNode) return;
    try {
      await retryNodeRun(selectedNode.id);
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '重试失败' });
    }
  }, [retryNodeRun, selectedNode]);

  const retryNodeFromCanvas = useCallback(
    async (nodeId: string) => {
      try {
        await retryNodeRun(nodeId);
      } catch (error) {
        setNotice({ kind: 'error', message: error instanceof Error ? error.message : '重试失败' });
        throw error;
      }
    },
    [retryNodeRun],
  );

  const commandPaletteCommands = useMemo<CommandPaletteCommand[]>(() => {
    const commands: CommandPaletteCommand[] = [
      {
        id: 'new-text-node',
        label: '新建文字生成节点',
        category: '画布',
        description: '在画布中添加一个可编辑的提示词节点',
        shortcut: 'T',
        icon: <FileText size={15} aria-hidden="true" />,
        onSelect: () => handleAddGenerateNode('text'),
      },
      {
        id: 'upload-asset',
        label: '上传资源',
        category: '资源',
        description: '上传图片、音频、视频或文本资源',
        icon: <Upload size={15} aria-hidden="true" />,
        onSelect: () => uploadInputRef.current?.click(),
      },
      {
        id: 'open-project-hub',
        label: '打开工作台',
        category: '项目',
        description: '查看和切换所有画布项目',
        shortcut: 'H',
        icon: <LayoutGrid size={15} aria-hidden="true" />,
        onSelect: () => setShowProjectHub(true),
      },
      {
        id: 'save-canvas',
        label: '保存画布',
        category: '画布',
        description: '立即保存当前工作流',
        shortcut: '⌘S',
        icon: <Check size={15} aria-hidden="true" />,
        disabled: !projectId || isProjectLoading,
        onSelect: async () => {
          await saveCanvas();
          setNotice({ kind: 'success', message: '画布已保存' });
        },
      },
      {
        id: 'export-workflow',
        label: '导出工作流 JSON',
        category: '导出',
        description: '导出节点、连线和运行元数据',
        icon: <Download size={15} aria-hidden="true" />,
        disabled: !projectId || isExporting,
        onSelect: () => exportProject('workflow'),
      },
      {
        id: 'export-results',
        label: '导出结果 ZIP',
        category: '导出',
        description: '导出工作流清单和结果文件',
        icon: <Archive size={15} aria-hidden="true" />,
        disabled: !projectId || isExporting,
        onSelect: () => exportProject('results'),
      },
      {
        id: 'open-settings',
        label: '打开设置',
        category: '应用',
        description: '管理 API 连接和默认模型',
        icon: <Settings size={15} aria-hidden="true" />,
        onSelect: () => setShowSettings(true),
      },
      {
        id: 'toggle-resource-panel',
        label: isResourceCollapsed ? '展开资源栏' : '折叠资源栏',
        category: '布局',
        icon: isResourceCollapsed ? (
          <PanelLeftOpen size={15} aria-hidden="true" />
        ) : (
          <PanelLeftClose size={15} aria-hidden="true" />
        ),
        onSelect: () => setIsResourceCollapsed((current) => !current),
      },
    ];

    nodes.forEach((node) => {
      const Icon = mediaIcons[node.data.mediaType];
      commands.push({
        id: `node-${node.id}`,
        label: node.data.label,
        category: '当前项目节点',
        description: `${mediaLabels[node.data.mediaType]}${modeLabels[node.data.mode]}节点`,
        icon: <Icon size={15} aria-hidden="true" />,
        keywords: [node.id, node.data.mediaType, node.data.mode],
        onSelect: () => selectCanvasNode(node.id),
      });
    });

    themeOptions.forEach((option) => {
      commands.push({
        id: `theme-${option.value}`,
        label: `切换到${option.label}主题`,
        category: '主题',
        icon: <Palette size={15} aria-hidden="true" />,
        disabled: canvasTheme === option.value,
        onSelect: () => setCanvasTheme(option.value),
      });
    });

    if (selectedNode && selectedNode.data.mode !== 'source') {
      commands.unshift({
        id: 'run-selected-node',
        label: `运行「${selectedNode.data.label}」`,
        category: '运行',
        description: '使用当前提示词、模型和推理强度',
        shortcut: 'R',
        icon: <Play size={15} aria-hidden="true" />,
        disabled: isRunning || selectedNode.data.enabled === false,
        onSelect: () => runNode(selectedNode),
      });
    }
    return commands;
  }, [
    canvasTheme,
    exportProject,
    handleAddGenerateNode,
    isExporting,
    isProjectLoading,
    isResourceCollapsed,
    isRunning,
    nodes,
    onNavigate,
    projectId,
    runNode,
    saveCanvas,
    selectCanvasNode,
    selectedNode,
  ]);
  return (
    <ReactFlowProvider>
      <main className="app-shell" data-theme={canvasTheme}>
        <AppNavigation route={route} projectId={projectId} className="mc-canvas-navigation" />
        <header className="topbar">
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
            <button
              type="button"
              className="icon-button project-hub-trigger"
              aria-label="打开工作台"
              title="工作台：查看所有画布"
              onClick={() => {
                setShowProjects(false);
                setShowProjectHub(true);
              }}
              disabled={isProjectLoading}
            >
              <LayoutGrid size={15} aria-hidden="true" />
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
            <span className="save-state" role="status" aria-label={saveState} title={saveState}>
              {saveState.includes('保存') ? <Check size={13} aria-hidden="true" /> : null}
              <span className="save-state-label">{saveState}</span>
            </span>
          </div>
          <div className="topbar-actions">
            <div className="topbar-tool-cluster" aria-label="画布编辑工具">
              <button
                type="button"
                className="icon-button command-palette-trigger"
                ref={commandPaletteTriggerRef}
                aria-label="打开命令面板"
                title="命令面板（Ctrl/Cmd+K）"
                onClick={() => setShowCommandPalette(true)}
              >
                <Search size={16} aria-hidden="true" />
                <span className="command-palette-trigger-label">命令</span>
              </button>
              <span className="topbar-tool-divider" aria-hidden="true" />
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
              <span className="topbar-tool-divider" aria-hidden="true" />
              <div className="background-control">
                <button
                  type="button"
                  className="topbar-background-picker"
                  ref={backgroundTriggerRef}
                  aria-label="选择画布背景"
                  aria-expanded={showBackgroundMenu}
                  aria-haspopup="menu"
                  aria-controls="canvas-background-menu"
                  title="画布背景"
                  onClick={() => {
                    setShowThemeMenu(false);
                    setShowBackgroundMenu((current) => !current);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      setShowThemeMenu(false);
                      setShowBackgroundMenu(true);
                    }
                  }}
                >
                  <LayoutGrid size={15} aria-hidden="true" />
                  <span>背景</span>
                  <strong>
                    {canvasBackgroundOptions.find((option) => option.value === canvasBackground)
                      ?.label ?? '点'}
                  </strong>
                  <ChevronDown size={12} aria-hidden="true" />
                </button>
                {showBackgroundMenu && (
                  <div
                    className="background-menu"
                    id="canvas-background-menu"
                    ref={backgroundMenuRef}
                    role="menu"
                    aria-label="画布背景"
                    onKeyDown={(event) => {
                      const options = Array.from(
                        event.currentTarget.querySelectorAll<HTMLButtonElement>(
                          '[role="menuitemradio"]',
                        ),
                      );
                      const currentIndex = options.indexOf(
                        document.activeElement as HTMLButtonElement,
                      );
                      let nextIndex: number | undefined;
                      if (event.key === 'ArrowDown')
                        nextIndex = (currentIndex + 1) % options.length;
                      if (event.key === 'ArrowUp') {
                        nextIndex = (currentIndex - 1 + options.length) % options.length;
                      }
                      if (event.key === 'Home') nextIndex = 0;
                      if (event.key === 'End') nextIndex = options.length - 1;
                      if (nextIndex !== undefined) {
                        event.preventDefault();
                        options[nextIndex]?.focus();
                      }
                    }}
                  >
                    {canvasBackgroundOptions.map((option) => (
                      <button
                        type="button"
                        className="background-option"
                        role="menuitemradio"
                        aria-checked={canvasBackground === option.value}
                        key={option.value}
                        onClick={() => {
                          setCanvasBackground(option.value);
                          setShowBackgroundMenu(false);
                          backgroundTriggerRef.current?.focus();
                        }}
                      >
                        <span
                          className={`background-swatch background-swatch-${option.value}`}
                          aria-hidden="true"
                        />
                        <span>{option.label}</span>
                        {canvasBackground === option.value && (
                          <Check size={14} aria-hidden="true" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="theme-control">
                <button
                  type="button"
                  className="theme-toggle"
                  aria-label="切换主题"
                  aria-expanded={showThemeMenu}
                  title="主题"
                  onClick={() => {
                    setShowBackgroundMenu(false);
                    setShowThemeMenu((current) => !current);
                  }}
                >
                  <Palette size={16} />
                  <span className="theme-toggle-label">
                    {themeOptions.find((option) => option.value === canvasTheme)?.label}
                  </span>
                </button>
                {showThemeMenu && (
                  <div className="theme-menu" role="listbox" aria-label="界面主题">
                    {themeOptions.map((option) => (
                      <button
                        type="button"
                        className="theme-option"
                        role="option"
                        aria-selected={canvasTheme === option.value}
                        key={option.value}
                        onClick={() => {
                          setCanvasTheme(option.value);
                          setShowThemeMenu(false);
                        }}
                      >
                        <span className={`theme-swatch ${option.swatch}`} aria-hidden="true" />
                        {option.label}
                        {canvasTheme === option.value && <Check size={14} aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
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
            {authUser ? (
              <button
                type="button"
                className="icon-button"
                aria-label="退出登录"
                title={`退出登录（${authUser.displayName ?? authUser.email}）`}
                onClick={onLoggedOut}
              >
                <UserCircle size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="icon-button"
                aria-label="登录"
                title="登录"
                onClick={onRequestLogin}
              >
                <UserCircle size={16} />
              </button>
            )}
            <div className="export-control">
              <button
                type="button"
                className="button button-secondary"
                ref={exportTriggerRef}
                aria-haspopup="menu"
                aria-expanded={showExportMenu}
                aria-controls="project-export-menu"
                aria-busy={isExporting}
                onClick={() => setShowExportMenu((current) => !current)}
                disabled={isExporting || !projectId}
                title={!projectId ? '项目加载后可导出' : '导出工作流或结果'}
              >
                {isExporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
                {isExporting ? '导出中' : '导出'}
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              {showExportMenu && (
                <div
                  className="export-menu"
                  id="project-export-menu"
                  role="menu"
                  aria-label="导出选项"
                >
                  <button
                    type="button"
                    role="menuitem"
                    aria-label="导出工作流 JSON"
                    className="export-menu-item"
                    onClick={() => void exportProject('workflow')}
                    disabled={isExporting}
                  >
                    <FileText size={15} aria-hidden="true" />
                    <span>
                      <strong>导出工作流 JSON</strong>
                      <small>节点、连线和运行元数据</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label="导出结果 ZIP"
                    className="export-menu-item"
                    onClick={() => void exportProject('results')}
                    disabled={isExporting}
                  >
                    <Archive size={15} aria-hidden="true" />
                    <span>
                      <strong>导出结果 ZIP</strong>
                      <small>工作流、清单和生成结果文件</small>
                    </span>
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="button button-primary"
              disabled={
                !selectedNode ||
                selectedNode.data.mode === 'source' ||
                selectedNode.data.enabled === false ||
                isRunning
              }
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

        <ProjectHub
          open={showProjectHub}
          projects={projects}
          activeProjectId={projectId}
          isLoading={isProjectLoading}
          includeArchived={includeArchivedProjects}
          onClose={() => setShowProjectHub(false)}
          onSelectProject={(project) => {
            setShowProjectHub(false);
            void switchProject(project);
          }}
          onRenameProject={renameProject}
          onSetArchivedProject={setProjectArchived}
          onToggleArchived={toggleArchivedProjects}
          onCreateProject={() => {
            setShowProjectHub(false);
            setProjectCreateName('未命名项目');
            setProjectCreateError('');
            setShowProjectCreate(true);
          }}
        />

        <CommandPalette
          open={showCommandPalette}
          commands={commandPaletteCommands}
          onClose={() => setShowCommandPalette(false)}
          restoreFocusRef={commandPaletteTriggerRef}
        />

        <ProjectCreateDialog
          open={showProjectCreate}
          name={projectCreateName}
          error={projectCreateError}
          busy={isProjectLoading}
          onNameChange={(value) => {
            setProjectCreateName(value);
            setProjectCreateError('');
          }}
          onClose={() => setShowProjectCreate(false)}
          onSubmit={() => void createProject()}
        />

        <div
          className={`workspace ${isResourceCollapsed ? 'resource-panel-collapsed' : ''} ${selectedNode ? 'has-inspector' : ''}`}
        >
          <ResourcePanel
            assets={assets}
            collapsed={isResourceCollapsed}
            showArchived={showArchived}
            activeFilter={activeFilter}
            query={query}
            isUploading={isUploading}
            uploadProgress={uploadProgress}
            onToggleArchived={() => setShowArchived((current) => !current)}
            onFilterChange={setActiveFilter}
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
            onToggleCollapsed={() => setIsResourceCollapsed((current) => !current)}
            uploadInputRef={uploadInputRef}
          />
          <WorkflowCanvas
            nodes={nodes}
            edges={edges}
            selectedNode={selectedNode}
            models={modelCatalog}
            busy={isRunning}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
            onNodeDragStart={handleNodeDragStart}
            onCanvasDrop={handleCanvasDrop}
            onNodeSelect={(node) => selectCanvasNode(node.id)}
            onClearNodeSelection={() => selectCanvasNode(null)}
            onResizeNode={handleResizeNode}
            onResizeStart={handleResizeStart}
            onNodeEnabledChange={updateNodeEnabled}
            onRetryNode={retryNodeFromCanvas}
            onPromptChange={updateSelectedPrompt}
            onParametersChange={updateSelectedParameters}
            onModelChange={updateSelectedModel}
            onInferenceStrengthChange={updateSelectedInferenceStrength}
            onRunNode={(node) => void runNode(node)}
            onDeleteNode={(nodeId) => deleteCanvasSelection([nodeId])}
            onAddGenerateNode={handleAddGenerateNode}
            onAddTransformNode={handleAddTransformNode}
            onCanvasCenterChange={updateCanvasCenterPosition}
            onRequestUpload={() => uploadInputRef.current?.click()}
            onClearCanvas={clearCanvas}
            onUndoCanvas={undoCanvas}
            onRedoCanvas={redoCanvas}
            onOpenSearch={() => {
              setShowBackgroundMenu(false);
              setShowThemeMenu(false);
              setShowCommandPalette(true);
            }}
            onOpenBackground={() => {
              setShowThemeMenu(false);
              setShowCommandPalette(false);
              setShowBackgroundMenu((current) => !current);
            }}
            canClearCanvas={nodes.length > 0 || edges.length > 0}
            canUndo={historyRef.current.past.length > 0}
            canRedo={historyRef.current.future.length > 0}
            onOpenProjectHub={() => setShowProjectHub(true)}
            background={canvasBackground}
          />
          {selectedNode && (
            <aside className="inspector-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">属性</p>
                  <h1>节点设置</h1>
                </div>
              </div>
              {selectedNode && selectedAsset && selectedNode.data.mode === 'source' ? (
                <div className="inspector-content">
                  <AssetPreview asset={selectedAsset} className="inspector-preview" interactive />
                  <span className="inspector-type">
                    {mediaLabels[selectedAsset.mediaType]}来源节点
                  </span>
                  <h2 className="inspector-name">{selectedAsset.name}</h2>
                  <label className="inspector-field inspector-label-field">
                    <span>节点名称</span>
                    <ImeInput
                      aria-label="节点名称"
                      value={selectedNode.data.label}
                      identity={selectedNode.id}
                      onValueChange={updateSelectedLabel}
                      onValueBlur={normalizeSelectedLabel}
                      placeholder="给这个来源节点命名"
                    />
                  </label>
                  <label className="inspector-toggle-field">
                    <input
                      type="checkbox"
                      checked={selectedNode.data.enabled !== false}
                      onChange={(event) => updateSelectedEnabled(event.target.checked)}
                    />
                    <span>
                      <strong>启用节点</strong>
                      <small>关闭后不作为下游节点的参考输入</small>
                    </span>
                  </label>
                  <label className="inspector-field">
                    <span>节点模式</span>
                    <select
                      aria-label="节点模式"
                      value={selectedNode.data.mode}
                      onChange={(event) => updateSelectedMode(event.target.value as NodeMode)}
                    >
                      {(Object.keys(modeLabels) as NodeMode[]).map((mode) => (
                        <option key={mode} value={mode}>
                          {modeLabels[mode]}
                        </option>
                      ))}
                    </select>
                  </label>
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
                  <label className="inspector-prompt inspector-source-content">
                    <span>
                      {selectedAsset.mediaType === 'text' ? '文本内容' : '来源提示 / 说明'}
                    </span>
                    <TextPromptEditor
                      nodeId={selectedNode.id}
                      value={selectedNode.data.prompt ?? ''}
                      onChange={updateSelectedPrompt}
                      placeholder={
                        selectedAsset.mediaType === 'text'
                          ? '输入来源文本，运行下游节点时会作为参考'
                          : '补充这份来源的用途、风格或处理要求（可选）'
                      }
                    />
                  </label>
                  <div className="inspector-source-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void copySourcePrompt(selectedNode)}
                    >
                      <FileText size={14} />
                      复制内容
                    </button>
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => addTransformFromSource(selectedNode)}
                    >
                      <Play size={14} />
                      创建转换
                    </button>
                  </div>
                </div>
              ) : selectedNode ? (
                <div className="inspector-content">
                  {runResultState.currentContentUrl ? (
                    <div className="inspector-generate-result-preview" aria-label="运行结果预览">
                      {selectedNode.data.mediaType === 'text' ? (
                        <TextResultContent
                          url={runResultState.currentContentUrl}
                          editable
                          onChange={updateSelectedPrompt}
                        />
                      ) : (
                        <AssetPreview
                          asset={runResultState.currentPreviewAsset}
                          mode="content"
                          className="inspector-result-preview"
                          interactive
                        />
                      )}
                    </div>
                  ) : (
                    <div
                      className={`inspector-generate-icon media-icon media-icon-${selectedNode.data.mediaType}`}
                    >
                      {(() => {
                        const Icon = mediaIcons[selectedNode.data.mediaType];
                        return <Icon size={26} aria-hidden="true" />;
                      })()}
                    </div>
                  )}
                  <span className="inspector-type">
                    {mediaLabels[selectedNode.data.mediaType]}
                    {modeLabels[selectedNode.data.mode]}节点
                  </span>
                  <h2 className="inspector-name">{selectedNode.data.label}</h2>
                  <label className="inspector-field inspector-label-field">
                    <span>节点名称</span>
                    <ImeInput
                      aria-label="节点名称"
                      value={selectedNode.data.label}
                      identity={selectedNode.id}
                      onValueChange={updateSelectedLabel}
                      onValueBlur={normalizeSelectedLabel}
                      placeholder="给这个节点命名"
                    />
                  </label>
                  <label className="inspector-toggle-field">
                    <input
                      type="checkbox"
                      checked={selectedNode.data.enabled !== false}
                      onChange={(event) => updateSelectedEnabled(event.target.checked)}
                    />
                    <span>
                      <strong>启用节点</strong>
                      <small>关闭后不参与下游参考；节点自身也不能运行</small>
                    </span>
                  </label>
                  <label className="inspector-field">
                    <span>节点模式</span>
                    <select
                      aria-label="节点模式"
                      value={selectedNode.data.mode}
                      onChange={(event) => updateSelectedMode(event.target.value as NodeMode)}
                    >
                      {(Object.keys(modeLabels) as NodeMode[]).map((mode) => (
                        <option key={mode} value={mode}>
                          {modeLabels[mode]}
                        </option>
                      ))}
                    </select>
                  </label>
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
                      <dd>{selectedRun?.snapshot?.inputs?.length ?? 0} 个</dd>
                    </div>
                  </dl>
                  {selectedNode.data.mode === 'source' && (
                    <>
                      <label className="inspector-prompt inspector-source-content">
                        <span>来源内容 / 提示</span>
                        <TextPromptEditor
                          nodeId={selectedNode.id}
                          value={selectedNode.data.prompt ?? ''}
                          onChange={updateSelectedPrompt}
                          placeholder="补充来源内容，供下游节点参考"
                        />
                      </label>
                      <div className="inspector-source-actions">
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => void copySourcePrompt(selectedNode)}
                        >
                          <FileText size={14} />
                          复制内容
                        </button>
                        <button
                          type="button"
                          className="button button-primary"
                          onClick={() => addTransformFromSource(selectedNode)}
                        >
                          <Play size={14} />
                          创建转换
                        </button>
                      </div>
                    </>
                  )}
                  <RunPanel
                    node={selectedNode}
                    run={selectedRun}
                    resultState={runResultState}
                    busy={isRunning}
                    onCancel={cancelSelectedRun}
                    onRetry={retrySelectedRun}
                    onResultEdit={updateSelectedPrompt}
                  />
                </div>
              ) : null}
            </aside>
          )}
        </div>
        {showSettings && (
          <SettingsPanel
            projectId={projectId}
            projectName={projectName}
            onClose={() => setShowSettings(false)}
            onNotice={setNotice}
          />
        )}
      </main>
    </ReactFlowProvider>
  );
}

function LoginScreen({
  apiBaseUrl,
  onAuthenticated,
  onContinueAnonymous,
  returnFocusTo,
}: {
  apiBaseUrl: string;
  onAuthenticated: (session: StoredAuthSession) => void;
  onContinueAnonymous: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = backdropRef.current;
    const backgroundSiblings = Array.from(backdrop?.parentElement?.children ?? []).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop,
    );
    const backgroundState = backgroundSiblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    backgroundSiblings.forEach((element) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });

    const focusableElements = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    focusableElements()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!busyRef.current && !isImeKeyboardEvent(event) && event.key === 'Escape') {
        event.preventDefault();
        onContinueAnonymous();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      backgroundState.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      const focusTarget = returnFocusTo?.isConnected ? returnFocusTo : previousFocus;
      if (focusTarget?.isConnected) focusTarget.focus();
    };
  }, [onContinueAnonymous, returnFocusTo]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setError('请输入邮箱和密码');
      return;
    }
    if (mode === 'register' && password.length < 8) {
      setError('密码至少需要 8 个字符');
      return;
    }
    setBusy(true);
    try {
      const session =
        mode === 'login'
          ? await loginWithApi(apiBaseUrl, { email: normalizedEmail, password })
          : await registerWithApi(apiBaseUrl, {
              email: normalizedEmail,
              password,
              ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            });
      onAuthenticated(session);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : '认证失败';
      setError(
        message === 'invalid email or password'
          ? '邮箱或密码不正确'
          : message === 'email is already registered'
            ? '该邮箱已注册，请直接登录'
            : message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={backdropRef}
      className="settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onContinueAnonymous();
      }}
    >
      <section
        ref={dialogRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
      >
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Multimodal Canvas</p>
            <h1 id="auth-title">{mode === 'login' ? '登录工作区' : '创建账户'}</h1>
          </div>
          <div className="auth-heading-actions">
            <UserCircle size={22} aria-hidden="true" />
            <button
              type="button"
              className="icon-button"
              aria-label="关闭登录"
              title="关闭"
              disabled={busy}
              onClick={onContinueAnonymous}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
        <p className="settings-status">
          {mode === 'login'
            ? '登录后可访问项目、资源和运行记录。'
            : '注册后即可开始创建多模态工作流。'}
        </p>
        <form
          onKeyDown={(event) => {
            if (event.key === 'Enter' && isImeKeyboardEvent(event)) event.preventDefault();
          }}
          onSubmit={(event) => void submit(event)}
        >
          {mode === 'register' && (
            <label className="settings-field">
              <span>显示名称（可选）</span>
              <ImeInput value={displayName} onValueChange={setDisplayName} autoComplete="name" />
            </label>
          )}
          <label className="settings-field">
            <span>邮箱</span>
            <ImeInput
              type="email"
              required
              value={email}
              onValueChange={setEmail}
              autoComplete="email"
              autoFocus
            />
          </label>
          <label className="settings-field">
            <span>密码</span>
            <ImeInput
              type="password"
              required
              minLength={mode === 'register' ? 8 : undefined}
              value={password}
              onValueChange={setPassword}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {error && (
            <p className="settings-field-error" role="alert">
              {error}
            </p>
          )}
          <div className="settings-actions">
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy && <LoaderCircle className="spin" size={15} />}
              {busy ? '处理中' : mode === 'login' ? '登录' : '注册'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => {
                setMode((current) => (current === 'login' ? 'register' : 'login'));
                setError(null);
              }}
            >
              {mode === 'login' ? '创建账户' : '返回登录'}
            </button>
          </div>
        </form>
        <button
          type="button"
          className="settings-delete"
          disabled={busy}
          onClick={onContinueAnonymous}
        >
          继续匿名使用
        </button>
      </section>
    </div>
  );
}

function RoutedApplication({
  authUser,
  onRequestLogin,
  onLoggedOut,
}: {
  authUser: AuthUser | null;
  onRequestLogin: () => void;
  onLoggedOut: () => void;
}) {
  const route = useAppRoute();
  const navigate = useAppNavigate();
  const queryClient = useQueryClient();
  const projectsQuery = useProjectsQuery(false);
  const scopedProjectId =
    route.id === 'project'
      ? route.projectId
      : route.id === 'settings'
        ? route.projectId
        : undefined;
  const projectQuery = useProjectQuery(scopedProjectId);
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [projectCreateName, setProjectCreateName] = useState('未命名项目');
  const [projectCreateError, setProjectCreateError] = useState('');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [pageNotice, setPageNotice] = useState<{
    kind: 'error' | 'success';
    message: string;
  } | null>(null);
  const projects = projectsQuery.data ?? [];
  const lastProjectId = localStorage.getItem(PROJECT_STORAGE_KEY);
  const continueProject =
    projects.find((project) => project.id === lastProjectId) ?? projects[0] ?? null;

  const openProjectCreate = useCallback(() => {
    setProjectCreateName('未命名项目');
    setProjectCreateError('');
    setShowProjectCreate(true);
  }, []);

  const createWorkspaceProject = useCallback(async () => {
    const name = projectCreateName.trim();
    if (!name) {
      setProjectCreateError('请输入项目名称');
      return;
    }
    setIsCreatingProject(true);
    setProjectCreateError('');
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        project?: ProjectSummary;
        error?: string;
      };
      if (!response.ok || !result.project) throw new Error(result.error ?? '项目创建失败');
      queryClient.setQueryData<ProjectSummary[]>(projectQueryKeys.list(false), (current = []) => [
        result.project!,
        ...current.filter((project) => project.id !== result.project!.id),
      ]);
      queryClient.setQueryData(projectQueryKeys.detail(result.project.id), result.project);
      localStorage.setItem(PROJECT_STORAGE_KEY, result.project.id);
      setShowProjectCreate(false);
      navigate(appPaths.project(result.project.id));
    } catch (error) {
      setProjectCreateError(error instanceof Error ? error.message : '项目创建失败');
    } finally {
      setIsCreatingProject(false);
    }
  }, [navigate, projectCreateName, queryClient]);

  let content;
  if (route.id === 'home') {
    content = <HomePage continueProject={continueProject} />;
  } else if (route.id === 'workspace') {
    content = (
      <WorkspacePage
        projects={projects}
        activeProjectId={lastProjectId}
        isLoading={projectsQuery.isPending}
        error={projectsQuery.error instanceof Error ? projectsQuery.error.message : null}
        onRetry={() => void projectsQuery.refetch()}
        onCreateProject={openProjectCreate}
      />
    );
  } else if (route.id === 'contact') {
    content = <ContactPage />;
  } else if (route.id === 'settings') {
    const hasProjectContext = Boolean(route.projectId);
    const settingsError =
      hasProjectContext && projectQuery.error instanceof Error ? projectQuery.error.message : null;
    content = (
      <SettingsPage
        projectId={route.projectId}
        projectName={projectQuery.data?.name}
        isLoading={hasProjectContext && projectQuery.isPending}
        error={settingsError}
        onRetry={() => void projectQuery.refetch()}
      >
        {!settingsError && (!hasProjectContext || projectQuery.data) ? (
          <SettingsPanel
            presentation="page"
            projectId={route.projectId ?? null}
            projectName={projectQuery.data?.name ?? '平台全局'}
            onClose={() => navigate(appPaths.workspace)}
            onNotice={setPageNotice}
          />
        ) : null}
      </SettingsPage>
    );
  } else if (route.id === 'project') {
    const projectStatus = projectQuery.isPending
      ? 'loading'
      : projectQuery.error
        ? projectQuery.error instanceof ProjectQueryError && projectQuery.error.status === 404
          ? 'not-found'
          : 'error'
        : 'ready';
    content = (
      <ProjectCanvasPage
        projectId={route.projectId}
        status={projectStatus}
        error={projectQuery.error instanceof Error ? projectQuery.error.message : null}
        onRetry={() => void projectQuery.refetch()}
      >
        {projectQuery.data ? (
          <WorkspaceApp
            key={`${authUser?.id ?? 'anonymous'}:${route.projectId}`}
            route={route}
            initialProject={projectQuery.data}
            authUser={authUser}
            onRequestLogin={onRequestLogin}
            onLoggedOut={onLoggedOut}
            onNavigate={navigate}
          />
        ) : null}
      </ProjectCanvasPage>
    );
  } else {
    content = <NotFoundPage pathname={route.pathname} />;
  }

  return (
    <>
      {content}
      {pageNotice && (
        <div
          className={`notice notice-${pageNotice.kind}`}
          role={pageNotice.kind === 'error' ? 'alert' : 'status'}
        >
          {pageNotice.kind === 'success' ? <Check size={15} /> : <X size={15} />}
          <span>{pageNotice.message}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setPageNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      <ProjectCreateDialog
        open={showProjectCreate}
        name={projectCreateName}
        error={projectCreateError}
        busy={isCreatingProject}
        onNameChange={(value) => {
          setProjectCreateName(value);
          setProjectCreateError('');
        }}
        onClose={() => setShowProjectCreate(false)}
        onSubmit={() => void createWorkspaceProject()}
      />
    </>
  );
}

function AppContent() {
  const [authSession, setAuthSession] = useState<StoredAuthSession | null>(() => readAuthSession());
  const [authRequired, setAuthRequired] = useState(false);
  const authTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    return setUnauthorizedHandler(() => {
      clearAuthSession();
      setAuthSession(null);
      setAuthRequired(true);
    });
  }, []);

  const handleAuthenticated = useCallback((session: StoredAuthSession) => {
    setAuthSession(session);
    setAuthRequired(false);
  }, []);

  const handleRequestLogin = useCallback(() => {
    authTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAuthRequired(true);
  }, []);
  const handleContinueAnonymous = useCallback(() => setAuthRequired(false), []);

  const handleLogout = useCallback(() => {
    void logoutWithApi(API_BASE_URL).finally(() => {
      setAuthSession(null);
      setAuthRequired(true);
    });
  }, []);

  return (
    <>
      <RoutedApplication
        authUser={authSession?.user ?? null}
        onRequestLogin={handleRequestLogin}
        onLoggedOut={handleLogout}
      />
      {authRequired && (
        <LoginScreen
          apiBaseUrl={API_BASE_URL}
          onAuthenticated={handleAuthenticated}
          onContinueAnonymous={handleContinueAnonymous}
          returnFocusTo={authTriggerRef.current}
        />
      )}
    </>
  );
}

export function App() {
  const canvasTheme = useWorkspacePreferences((state) => state.canvasTheme);

  useEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-theme');
    root.setAttribute('data-theme', canvasTheme);

    return () => {
      if (previousTheme === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previousTheme);
    };
  }, [canvasTheme]);

  return (
    <AppQueryProvider>
      <AppContent />
    </AppQueryProvider>
  );
}
