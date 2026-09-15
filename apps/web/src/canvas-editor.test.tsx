import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Asset, CanvasDocument, RunRecord } from '@multimodal-canvas/domain';

type FlowConnection = {
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
};

type FlowContextValue = {
  connectHandle: (nodeId: string, type: 'source' | 'target', handleId: string | null) => void;
};

const flowContext = createContext<FlowContextValue | null>(null);
const nodeContext = createContext<string | null>(null);

function applyNodeChanges<
  T extends { id: string; position?: { x: number; y: number }; selected?: boolean },
>(current: T[], changes: Array<Record<string, unknown>>) {
  return changes.reduce<T[]>((nodes, change) => {
    const id = typeof change.id === 'string' ? change.id : undefined;
    if (change.type === 'remove' && id) return nodes.filter((node) => node.id !== id);
    if (change.type === 'add' && change.item) return [...nodes, change.item as T];
    if (change.type === 'replace' && id && change.item) {
      return nodes.map((node) => (node.id === id ? (change.item as T) : node));
    }
    if (change.type === 'select' && id) {
      return nodes.map((node) =>
        node.id === id ? { ...node, selected: Boolean(change.selected) } : node,
      );
    }
    if (change.type === 'position' && id && change.position) {
      return nodes.map((node) =>
        node.id === id ? { ...node, position: change.position as { x: number; y: number } } : node,
      );
    }
    return nodes;
  }, current);
}

function applyEdgeChanges<T extends { id: string }>(
  current: T[],
  changes: Array<Record<string, unknown>>,
) {
  return changes.reduce<T[]>((edges, change) => {
    const id = typeof change.id === 'string' ? change.id : undefined;
    if (change.type === 'remove' && id) return edges.filter((edge) => edge.id !== id);
    if (change.type === 'add' && change.item) return [...edges, change.item as T];
    if (change.type === 'replace' && id && change.item) {
      return edges.map((edge) => (edge.id === id ? (change.item as T) : edge));
    }
    if (change.type === 'select' && id) {
      return edges.map((edge) =>
        edge.id === id ? { ...edge, selected: Boolean(change.selected) } : edge,
      );
    }
    return edges;
  }, current);
}

vi.mock('@xyflow/react', async () => {
  const React = await import('react');

  function ReactFlowProvider({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
  }

  function useNodesState<T>(initial: T[]) {
    const [nodes, setNodes] = React.useState(initial);
    const applyChanges = React.useCallback((changes: Array<Record<string, unknown>>) => {
      setNodes(
        (current) =>
          applyNodeChanges(
            current as Array<{
              id: string;
              position?: { x: number; y: number };
              selected?: boolean;
            }>,
            changes,
          ) as T[],
      );
    }, []);
    return [nodes, setNodes, applyChanges] as const;
  }

  function useEdgesState<T>(initial: T[]) {
    const [edges, setEdges] = React.useState(initial);
    const applyChanges = React.useCallback((changes: Array<Record<string, unknown>>) => {
      setEdges((current) => applyEdgeChanges(current as Array<{ id: string }>, changes) as T[]);
    }, []);
    return [edges, setEdges, applyChanges] as const;
  }

  function useReactFlow() {
    return {
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    };
  }

  function Handle({
    type = 'source',
    id = null,
    isConnectable: _isConnectable,
    ...props
  }: {
    type?: 'source' | 'target';
    id?: string | null;
    [key: string]: unknown;
  }) {
    const nodeId = React.useContext(nodeContext);
    const flow = React.useContext(flowContext);
    return (
      <button
        type="button"
        data-testid="flow-handle"
        data-handleid={id}
        data-nodeid={nodeId}
        data-handle-type={type}
        aria-label={`${type === 'source' ? '输出' : '输入'} ${id ?? ''}`}
        onClick={(event) => {
          event.stopPropagation();
          if (nodeId && flow) flow.connectHandle(nodeId, type, id);
        }}
        {...props}
      />
    );
  }

  function ReactFlow({
    nodes,
    edges,
    nodeTypes,
    onNodesChange,
    onNodeClick,
    onNodeMouseEnter,
    onNodeMouseLeave,
    onPaneClick,
    onConnect,
    onConnectStart,
    onConnectEnd,
    children,
  }: {
    nodes: Array<{ id: string; type?: string; data: unknown; selected?: boolean }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      targetHandle?: string | null;
    }>;
    nodeTypes: Record<
      string,
      React.ComponentType<{ id: string; data: unknown; selected?: boolean }>
    >;
    onNodesChange?: (changes: Array<Record<string, unknown>>) => void;
    onNodeClick?: (event: unknown, node: unknown) => void;
    onNodeMouseEnter?: (event: unknown, node: unknown) => void;
    onNodeMouseLeave?: (event: unknown, node: unknown) => void;
    onPaneClick?: () => void;
    onConnect?: (connection: FlowConnection) => void;
    onConnectStart?: (
      event: MouseEvent,
      params: {
        nodeId: string | null;
        handleId: string | null;
        handleType: 'source' | 'target' | null;
      },
    ) => void;
    onConnectEnd?: (
      event: MouseEvent,
      state: { toHandle?: unknown; toNode?: { id?: string } | null },
    ) => void;
    children?: React.ReactNode;
  }) {
    const [pending, setPending] = React.useState<{
      nodeId: string;
      handleId: string | null;
      handleType: 'source' | 'target';
    } | null>(null);

    const connectHandle = React.useCallback(
      (nodeId: string, type: 'source' | 'target', handleId: string | null) => {
        if (!pending) {
          onConnectStart?.(new MouseEvent('mousedown'), {
            nodeId,
            handleId,
            handleType: type,
          });
          setPending({ nodeId, handleId, handleType: type });
          return;
        }
        if (type === 'target') {
          onConnect?.({
            source: pending.nodeId,
            sourceHandle: pending.handleId,
            target: nodeId,
            targetHandle: handleId,
          });
          setPending(null);
          return;
        }
        onConnectStart?.(new MouseEvent('mousedown'), {
          nodeId,
          handleId,
          handleType: type,
        });
        setPending({ nodeId, handleId, handleType: type });
      },
      [onConnect, onConnectStart, pending],
    );

    return (
      <flowContext.Provider value={{ connectHandle }}>
        <div data-testid="rf__wrapper" className="react-flow" role="application">
          <button
            type="button"
            className="react-flow__pane"
            aria-label="画布空白"
            onClick={(event) => {
              if (pending) {
                Object.defineProperty(document, 'elementsFromPoint', {
                  configurable: true,
                  writable: true,
                  value: () => [],
                });
                onConnectEnd?.(event.nativeEvent, { toHandle: null, toNode: null });
                setPending(null);
              }
              onPaneClick?.();
            }}
          />
          <div className="react-flow__nodes">
            {nodes.map((node) => {
              const NodeComponent = nodeTypes[node.type ?? 'default'];
              if (!NodeComponent) return null;
              return (
                <div
                  key={node.id}
                  data-testid="flow-node"
                  data-node-id={node.id}
                  data-id={node.id}
                  className="react-flow__node"
                  onMouseEnter={(event) => onNodeMouseEnter?.(event, node)}
                  onMouseLeave={(event) => onNodeMouseLeave?.(event, node)}
                  onClick={(event) => {
                    onNodeClick?.(event, node);
                    onNodesChange?.([
                      ...nodes
                        .filter((item) => item.id !== node.id && item.selected)
                        .map((item) => ({ type: 'select', id: item.id, selected: false })),
                      { type: 'select', id: node.id, selected: true },
                    ]);
                  }}
                >
                  <nodeContext.Provider value={node.id}>
                    <NodeComponent
                      id={node.id}
                      data={node.data}
                      selected={Boolean(node.selected)}
                    />
                  </nodeContext.Provider>
                </div>
              );
            })}
          </div>
          <div className="react-flow__edges">
            {edges.map((edge) => (
              <div
                key={edge.id}
                data-testid="flow-edge"
                data-edge-id={edge.id}
                data-source={edge.source}
                data-target={edge.target}
                data-target-handle={edge.targetHandle ?? ''}
              />
            ))}
          </div>
          {children}
        </div>
      </flowContext.Provider>
    );
  }

  function NodeResizer() {
    return null;
  }

  function NodeToolbar({ children }: { children?: React.ReactNode }) {
    return <div className="react-flow__node-toolbar">{children}</div>;
  }

  return {
    Background: () => null,
    BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
    Controls: () => null,
    NodeResizer,
    NodeToolbar,
    Handle,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    ReactFlow,
    ReactFlowProvider,
    useEdgesState,
    useNodesState,
    useReactFlow,
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    useEdges: () => [],
  };
});

import { App } from './App';
import { clearAuthSession, persistAuthSession } from './auth-client';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const project = {
  id: 'project_canvas_test',
  name: '画布交互测试',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const assets: Asset[] = [
  {
    id: 'asset-reference',
    name: 'reference.png',
    mediaType: 'image',
    mimeType: 'image/png',
    sizeBytes: 1024,
    status: 'ready',
    contentUrl: '/v1/assets/asset-reference/content',
    tags: [],
  },
];

const emptyCanvas: CanvasDocument = { revision: 0, nodes: [], edges: [] };
/** 目录按凭据查询，因此测试会话需要一个凭据，节点才能继承到模型。 */
const credentialSummary = {
  id: 'credential-model-catalog',
  version: 1,
  baseUrl: 'https://mock.example.test/v1',
  keyFingerprint: 'synthetic',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const modelCatalog = [
  {
    id: 'text-model',
    name: '文字模型',
    mediaTypes: ['text'],
    capabilities: { reasoning_effort: ['low', 'medium', 'high'] },
  },
  {
    // 已声明图片编辑能力的图片模型；未声明的模型会被 fail-closed 拦在提交之前。
    id: 'image-edit-model',
    name: '图片编辑模型',
    mediaTypes: ['image'],
    capabilities: { imageEdit: { supported: true, mimeTypes: ['image/png'] } },
  },
  {
    id: 'image-plain-model',
    name: '普通图片模型',
    mediaTypes: ['image'],
  },
];
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let canvas: CanvasDocument;
let projectRuns: RunRecord[];
/** 按节点覆写运行响应，用于覆盖失败后重试等交互；未覆写时仍返回成功。 */
let nodeRunOverrides: Map<string, { status: RunRecord['status']; error?: string }>;
let nodeRunRequestCounts: Map<string, number>;
let resultContent = new Map<string, { body: string; contentType: string }>();
let fetchMock: ReturnType<typeof vi.fn>;
let clipboardMock: {
  writeText: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
  getText: () => string;
  setText: (value: string) => void;
};
let previousClipboardDescriptor: PropertyDescriptor | undefined;
let clipboardText = '';

function installClipboardMock() {
  const writeText = vi.fn(async (value: string) => {
    clipboardText = value;
  });
  const readText = vi.fn(async () => clipboardText);
  clipboardMock = {
    writeText,
    readText,
    getText: () => clipboardText,
    setText: (value: string) => {
      clipboardText = value;
    },
  };
  restoreClipboardMock();
}

function restoreClipboardMock() {
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: clipboardMock.writeText,
      readText: clipboardMock.readText,
    },
  });
}

function installApiMock() {
  const runs = new Map<string, Record<string, unknown>>();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, 'http://localhost:3000');
    const method = init?.method?.toUpperCase() ?? 'GET';

    if (url.pathname === '/v1/models' && method === 'GET') {
      return jsonResponse({ models: modelCatalog });
    }
    if (url.pathname === '/v1/settings/ai/credentials' && method === 'GET') {
      // 目录是按凭据查询的；没有凭据时 modelCatalog 为空，节点拿不到模型。
      return jsonResponse({ credentials: [credentialSummary] });
    }
    if (url.pathname === '/v1/assets' && method === 'GET') return jsonResponse({ assets });
    if (url.pathname.endsWith('/access-url') && method === 'POST')
      return jsonResponse({
        url: `${url.pathname.replace('/access-url', '/content')}?access_token=synthetic-unit`,
      });
    if (url.pathname === '/v1/projects' && method === 'GET') {
      return jsonResponse({ projects: [project] });
    }
    if (url.pathname === '/v1/projects' && method === 'POST') return jsonResponse({ project });
    if (url.pathname === `/v1/projects/${project.id}/canvas` && method === 'GET') {
      return jsonResponse({ canvas });
    }
    if (url.pathname === `/v1/projects/${project.id}/canvas` && method === 'PATCH') {
      canvas = JSON.parse(String(init?.body ?? '{}')) as CanvasDocument;
      canvas.revision += 1;
      return jsonResponse({ canvas });
    }
    if (url.pathname === `/v1/projects/${project.id}` && method === 'GET') {
      return jsonResponse({ project });
    }
    if (/^\/v1\/projects\/[^/]+$/.test(url.pathname) && method === 'GET') {
      return jsonResponse({ error: 'project not found' }, 404);
    }
    if (url.pathname === `/v1/projects/${project.id}/runs` && method === 'GET') {
      return jsonResponse({ runs: projectRuns });
    }
    const content = resultContent.get(url.pathname);
    if (content && method === 'GET') {
      return new Response(content.body, {
        headers: { 'content-type': content.contentType },
      });
    }
    const nodeRunMatch = url.pathname.match(/^\/v1\/nodes\/([^/]+)\/runs$/);
    if (nodeRunMatch && method === 'POST') {
      const nodeId = decodeURIComponent(nodeRunMatch[1]);
      const override = nodeRunOverrides.get(nodeId);
      if (override) nodeRunRequestCounts.set(nodeId, (nodeRunRequestCounts.get(nodeId) ?? 0) + 1);
      const run = {
        id: `run_${nodeId}_${runs.size}`,
        targetNodeId: nodeId,
        status: override?.status ?? 'succeeded',
        progress: override?.status === 'failed' ? 0 : 100,
        snapshot: { inputs: [] },
        ...(override?.error ? { error: override.error } : {}),
      };
      runs.set(run.id, run);
      return jsonResponse({ run });
    }
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (runMatch && method === 'GET') {
      const run = runs.get(decodeURIComponent(runMatch[1]));
      if (run) return jsonResponse({ run });
    }
    throw new Error(`Unhandled mock request: ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function createRestoredRun(
  node: CanvasDocument['nodes'][number],
  options: {
    status?: RunRecord['status'];
    includeAsset?: boolean;
    error?: string;
    textContent?: string;
  } = {},
): RunRecord {
  const status = options.status ?? 'succeeded';
  const includeAsset = options.includeAsset ?? true;
  const now = '2026-08-28T08:00:00.000Z';
  const mediaType = node.data.mediaType;
  const mimeType =
    mediaType === 'image'
      ? 'image/png'
      : mediaType === 'video'
        ? 'video/mp4'
        : mediaType === 'audio'
          ? 'audio/mpeg'
          : 'text/plain';
  const contentUrl = `/v1/assets/asset-restored-${node.id}/content`;
  const textContent = options.textContent ?? '这是刷新后从持久化运行记录回显的真实文本。';
  resultContent.set(contentUrl, {
    body: mediaType === 'text' ? textContent : `${mediaType} fixture bytes`,
    contentType: mimeType,
  });

  return {
    id: `run-restored-${node.id}`,
    projectId: project.id,
    targetNodeId: node.id,
    status,
    progress: status === 'succeeded' ? 100 : 0,
    attempt: 1,
    provider: 'mock',
    modelAlias: `restored-${mediaType}`,
    snapshot: {
      projectId: project.id,
      canvasRevision: canvas.revision,
      targetNodeId: node.id,
      modelAlias: `restored-${mediaType}`,
      parameters: {},
      submittedAt: now,
      nodes: [node],
      edges: [],
      inputs: [],
    },
    ...(status === 'failed'
      ? { error: options.error ?? '运行失败' }
      : {
          result: {
            provider: 'mock',
            summary: '持久化运行结果',
            targetNodeId: node.id,
            mediaType,
            inputCount: 0,
            ...(includeAsset
              ? {
                  asset: {
                    assetId: `asset-restored-${node.id}`,
                    version: 1,
                    contentUrl,
                    mimeType,
                    sizeBytes: 128,
                  },
                }
              : {}),
          },
        }),
    createdAt: now,
    updatedAt: now,
  } satisfies RunRecord;
}

function persistedNode(mediaType: CanvasDocument['nodes'][number]['data']['mediaType']) {
  const node = canvas.nodes.find((candidate) => candidate.data.mediaType === mediaType);
  if (!node) throw new Error(`Missing persisted ${mediaType} node`);
  return node;
}

function projectRunRequestCount() {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, 'http://localhost:3000');
    const method = init?.method?.toUpperCase() ?? 'GET';
    return url.pathname === `/v1/projects/${project.id}/runs` && method === 'GET';
  }).length;
}

async function renderCanvas() {
  const user = userEvent.setup();
  // userEvent installs its own Clipboard stub; replace it with the test spy
  // while keeping the text value across separate canvas instances.
  restoreClipboardMock();
  render(createElement(App));
  await screen.findByRole('button', { name: '新建文字生成节点' });
  await waitFor(() => expect(screen.getByRole('application')).toBeInTheDocument());
  return { user };
}

function flowNodes() {
  return screen.queryAllByTestId('flow-node');
}

function findNodeByLabel(label: string) {
  return flowNodes().find(
    (node) =>
      Boolean(within(node).queryByRole('group', { name: `节点操作：${label}` })) ||
      within(node).queryAllByText(label).length > 0,
  );
}

function handleFor(node: HTMLElement, handleId: string) {
  const handle = node.querySelector(`[data-handleid="${handleId}"]`);
  if (!(handle instanceof HTMLElement)) throw new Error(`Missing handle ${handleId}`);
  return handle;
}

describe('画布编辑器交互', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', `/projects/${project.id}`);
    window.localStorage.clear();
    clearAuthSession();
    // 私有画布测试使用合成有效会话，保留原有业务请求与断言。
    persistAuthSession({
      accessToken: 'synthetic-canvas-test-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      user: {
        id: 'canvas-test-user',
        email: 'canvas@example.com',
        role: 'admin',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    clipboardText = '';
    canvas = structuredClone(emptyCanvas);
    projectRuns = [];
    nodeRunOverrides = new Map();
    nodeRunRequestCounts = new Map();
    resultContent = new Map();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    previousClipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
    installClipboardMock();
    installApiMock();
  });

  afterEach(() => {
    cleanup();
    clearAuthSession();
    window.history.replaceState(null, '', '/');
    if (previousClipboardDescriptor) {
      Object.defineProperty(window.navigator, 'clipboard', previousClipboardDescriptor);
    } else {
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: undefined,
      });
    }
    vi.unstubAllGlobals();
  });

  it('在根路径显示主页且不会自动创建项目', async () => {
    window.history.replaceState(null, '', '/');
    render(createElement(App));

    expect(await screen.findByRole('heading', { name: 'Multimodal Canvas' })).toBeVisible();
    expect(screen.getByRole('link', { name: /进入工作台/ })).toHaveAttribute('href', '/workspace');
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input).includes('/v1/projects') && init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('工作台项目链接进入对应画布，并对不存在项目显示明确状态', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/workspace');
    const view = render(createElement(App));
    const projectLink = await screen.findByRole('link', { name: project.name });
    await user.click(projectLink);
    await screen.findByRole('application');
    expect(window.location.pathname).toBe(`/projects/${project.id}`);

    view.unmount();
    window.history.replaceState(null, '', '/projects/missing-project');
    render(createElement(App));
    expect(await screen.findByRole('heading', { name: '项目不存在' })).toBeVisible();
  });

  it('通过工具栏和资源库创建生成节点与来源节点', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));

    expect(findNodeByLabel('图片生成节点')).toBeTruthy();
    expect(findNodeByLabel('reference.png')).toBeTruthy();
    expect(flowNodes()).toHaveLength(2);
    expect(screen.getByText('reference.png 已添加到画布', { exact: true })).toBeVisible();
  });

  it.each(['Delete', 'Backspace'])('新建节点后 %s 可直接删除选中节点', async (key) => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    const node = findNodeByLabel('图片生成节点');
    expect(node?.querySelector('.is-selected')).toBeTruthy();

    await user.keyboard(`{${key}}`);
    await waitFor(() => expect(flowNodes()).toHaveLength(0));
  });

  it('可以直接在画布节点上启用或停用节点', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    const node = findNodeByLabel('图片生成节点');
    expect(node).toBeTruthy();

    await user.click(within(node!).getByRole('button', { name: '停用节点' }));
    expect(within(node!).getByRole('button', { name: '启用节点' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(node!.querySelector('.flow-asset-node')).toHaveClass('is-disabled');
  });

  it('选择文字生成节点后显示提示词输入并支持编辑', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const node = findNodeByLabel('文字生成节点');
    expect(node).toBeTruthy();
    await user.click(node!);

    const prompt = screen.getByRole('textbox', { name: '提示词' });

    expect(prompt).toBeVisible();
    const quickEditor = screen.getByLabelText('文字生成节点生成设置');
    expect(quickEditor).toHaveClass('nodrag', 'nopan', 'nowheel');
    expect(quickEditor).toContainElement(prompt);
    expect(document.querySelector('.inspector-panel textarea')).toBeNull();
    await user.click(prompt);
    await user.type(prompt, '写一段产品介绍');
    expect(prompt).toHaveValue('写一段产品介绍');

    fireEvent.mouseLeave(node!);
    await user.click(screen.getByRole('button', { name: '画布空白' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('文字生成节点生成设置')).not.toBeInTheDocument(),
    );
  });

  it('在工作台快速编辑器中搜索并保存结构化资源提及', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const node = findNodeByLabel('文字生成节点');
    expect(node).toBeTruthy();
    await user.click(node!);

    const quickEditor = screen.getByLabelText('文字生成节点生成设置');
    const prompt = within(quickEditor).getByRole('textbox', { name: '提示词' });
    await user.type(prompt, '根据 @ref');
    expect(screen.getByRole('listbox', { name: '选择资源' })).toBeInTheDocument();
    await user.keyboard('{Enter}');

    expect(prompt).toHaveValue('根据 @reference.png');
    expect(within(quickEditor).getByRole('article')).toHaveTextContent('@reference.png');

    await user.click(within(quickEditor).getByRole('button', { name: '生成' }));
    await waitFor(() => {
      const runCall = fetchMock.mock.calls.find(([input, init]) => {
        const rawUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return (
          new URL(rawUrl, 'http://localhost:3000').pathname.startsWith('/v1/nodes/') &&
          init?.method === 'POST'
        );
      });
      expect(runCall).toBeDefined();
      const body = JSON.parse(String((runCall?.[1] as RequestInit | undefined)?.body));
      expect(body).toMatchObject({
        promptDocument: {
          version: 1,
          blocks: [
            { type: 'text', text: '根据 ' },
            {
              type: 'mention',
              assetId: 'asset-reference',
              label: 'reference.png',
              mediaType: 'image',
            },
          ],
        },
        parameters: { prompt: '根据 @reference.png' },
      });
    });
  });

  it('节点标题支持中文组合输入，并可作为一次编辑撤销', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const node = findNodeByLabel('文字生成节点')!;
    await user.click(within(node).getByRole('button', { name: '重命名节点：文字生成节点' }));
    const title = screen.getByRole('textbox', { name: '编辑节点名称' });

    await user.clear(title);
    await user.type(title, '中文标题');
    await user.keyboard('{Enter}');
    expect(title).toHaveValue('中文标题');
    await waitFor(() => expect(findNodeByLabel('中文标题')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '画布空白' }));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(findNodeByLabel('文字生成节点')).toBeTruthy();
  });

  it('在节点浮层配置生成参数，并用最新值提交运行', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const node = findNodeByLabel('文字生成节点');
    expect(node).toBeTruthy();
    await user.click(node!);

    const quickEditor = screen.getByLabelText('文字生成节点生成设置');
    expect(document.querySelector<HTMLElement>('.inspector-panel')).toBeNull();
    expect(within(quickEditor).getByRole('textbox', { name: '提示词' })).toBeVisible();
    expect(within(quickEditor).getByRole('combobox', { name: /^模型：/ })).toBeVisible();
    expect(within(quickEditor).getByRole('combobox', { name: /^推理强度：/ })).toBeVisible();
    expect(within(quickEditor).getByRole('button', { name: '生成' })).toBeVisible();

    const prompt = within(quickEditor).getByRole('textbox', { name: '提示词' });
    await user.clear(prompt);
    await user.type(prompt, '用最新提示词生成');
    const inferenceGroup = within(quickEditor).getByText('推理强度').parentElement as HTMLElement;
    await user.hover(inferenceGroup);
    await user.click(within(inferenceGroup).getByRole('option', { name: '高' }));
    await user.click(within(quickEditor).getByRole('button', { name: '生成' }));

    await waitFor(() => {
      const runCall = fetchMock.mock.calls.find(([input, init]) => {
        const rawUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return (
          new URL(rawUrl, 'http://localhost:3000').pathname.startsWith('/v1/nodes/') &&
          init?.method === 'POST'
        );
      });
      expect(runCall).toBeDefined();
      const body = (runCall?.[1] as RequestInit | undefined)?.body;
      expect(JSON.parse(String(body))).toMatchObject({
        projectId: project.id,
        parameters: {
          prompt: '用最新提示词生成',
          inferenceStrength: 'high',
        },
      });
    });
  });

  it('重新进入同一项目时通过持久化运行记录回填文本、图片和视频产物', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '新建视频生成节点' }));
    await waitFor(() => expect(canvas.nodes).toHaveLength(3));

    const textNode = persistedNode('text');
    const imageNode = persistedNode('image');
    const videoNode = persistedNode('video');
    expect(canvas.nodes.every((node) => !('resultAsset' in node.data))).toBe(true);

    const restoredText = '这是刷新后从持久化运行记录回显的真实文本。';
    const textRun = createRestoredRun(textNode, { textContent: restoredText });
    const imageRun = createRestoredRun(imageNode);
    const videoRun = createRestoredRun(videoNode);
    projectRuns = [textRun, imageRun, videoRun];

    cleanup();
    fetchMock.mockClear();
    await renderCanvas();

    await waitFor(() => expect(projectRunRequestCount()).toBeGreaterThan(0));
    await waitFor(() => {
      const restoredTextNode = findNodeByLabel('文字生成节点');
      expect(restoredTextNode).toBeTruthy();
      expect(within(restoredTextNode!).getByText(restoredText)).toBeVisible();
    });
    await waitFor(() => {
      const restoredImageNode = findNodeByLabel('图片生成节点');
      const image = restoredImageNode?.querySelector('img');
      expect(image).toBeTruthy();
      expect(image?.getAttribute('src')).toContain(imageRun.result?.asset?.contentUrl);
    });
    await waitFor(() => {
      const restoredVideoNode = findNodeByLabel('视频生成节点');
      const video = restoredVideoNode?.querySelector('video');
      const source =
        video?.getAttribute('src') ?? video?.querySelector('source')?.getAttribute('src');
      expect(video).toBeTruthy();
      expect(source).toContain(videoRun.result?.asset?.contentUrl);
    });
  });

  it('重载时失败或没有 result.asset 的运行不显示成功产物', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await waitFor(() => expect(canvas.nodes).toHaveLength(2));

    projectRuns = [
      createRestoredRun(persistedNode('text'), {
        status: 'failed',
        includeAsset: false,
        error: '持久化运行失败',
      }),
      createRestoredRun(persistedNode('image'), { includeAsset: false }),
    ];

    cleanup();
    fetchMock.mockClear();
    await renderCanvas();

    await waitFor(() => expect(projectRunRequestCount()).toBeGreaterThan(0));
    await waitFor(() => {
      const failedNode = findNodeByLabel('文字生成节点');
      const missingNode = findNodeByLabel('图片生成节点');
      expect(failedNode).toBeTruthy();
      expect(missingNode).toBeTruthy();
      expect(within(failedNode!).getByRole('alert')).toHaveTextContent('持久化运行失败');
      expect(within(missingNode!).getByRole('alert')).toHaveTextContent('产物不存在或已失效');
    });

    const failedNode = findNodeByLabel('文字生成节点')!;
    const missingNode = findNodeByLabel('图片生成节点')!;
    expect(failedNode.querySelector('.flow-node-preview')).toBeNull();
    expect(missingNode.querySelector('.flow-node-preview')).toBeNull();
    expect(within(failedNode).queryByLabelText('运行成功')).not.toBeInTheDocument();
    expect(within(missingNode).queryByLabelText('运行成功')).not.toBeInTheDocument();
  });

  it('画布背景菜单可打开、切换并持久化选择', async () => {
    const { user } = await renderCanvas();

    const trigger = screen.getAllByRole('button', { name: '外观' })[0];
    await user.click(trigger);

    expect(screen.getByRole('dialog', { name: '主题、画布背景与连接线' })).toBeVisible();
    await user.click(screen.getByRole('tab', { name: '背景' }));
    expect(screen.getByRole('button', { name: '点' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '空白' }));
    expect(window.localStorage.getItem('multimodal-canvas:background')).toBe('blank');
  });

  it('来源节点不再打开右侧属性栏，并支持直接重命名', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png');
    expect(source).toBeTruthy();

    const sourceHandle = handleFor(source!, 'output:image');
    await user.click(sourceHandle);
    expect(document.querySelector<HTMLElement>('.inspector-panel')).toBeNull();
    await user.click(within(source!).getByRole('button', { name: '重命名节点：reference.png' }));
    const title = screen.getByRole('textbox', { name: '编辑节点名称' });
    await user.clear(title);
    await user.type(title, '角色参考');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(findNodeByLabel('角色参考')).toBeTruthy());
  });

  it('底部工具栏只创建四类生成节点并支持自动适配缩放', async () => {
    const { user } = await renderCanvas();

    for (const mediaType of ['文字', '图片', '音频', '视频']) {
      await user.click(screen.getByRole('button', { name: `新建${mediaType}生成节点` }));
    }

    expect(findNodeByLabel('文字生成节点')).toBeTruthy();
    expect(findNodeByLabel('图片生成节点')).toBeTruthy();
    expect(findNodeByLabel('音频生成节点')).toBeTruthy();
    expect(findNodeByLabel('视频生成节点')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新建文字转换节点' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '自动适配缩放' }));
  });

  it('支持复制粘贴，并能删除选中节点', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const original = findNodeByLabel('文字生成节点');
    expect(original).toBeTruthy();
    await user.click(original!);
    await user.keyboard('{Control>}c{/Control}');
    await user.keyboard('{Control>}v{/Control}');

    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    expect(
      screen.getAllByRole('group', { name: '节点操作：文字生成节点' }).length,
    ).toBeGreaterThanOrEqual(2);

    await user.keyboard('{Delete}');
    await waitFor(() => expect(flowNodes()).toHaveLength(1));
  });

  it('通过系统 Clipboard API 在不同画布实例之间粘贴', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    await user.click(findNodeByLabel('文字生成节点')!);
    await waitFor(() =>
      expect(findNodeByLabel('文字生成节点')?.querySelector('.is-selected')).toBeTruthy(),
    );
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    await waitFor(() => expect(clipboardMock.writeText).toHaveBeenCalledTimes(1));
    expect(clipboardMock.getText()).toContain('multimodal-canvas/clipboard');

    cleanup();
    const second = await renderCanvas();
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });

    await waitFor(() => expect(flowNodes()).toHaveLength(1));
    expect(findNodeByLabel('文字生成节点')).toBeTruthy();
    expect(clipboardMock.readText).toHaveBeenCalledTimes(1);
  });

  it('系统剪贴板内容非法或读取失败时回退到内存剪贴板', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    await user.click(findNodeByLabel('文字生成节点')!);
    await waitFor(() =>
      expect(findNodeByLabel('文字生成节点')?.querySelector('.is-selected')).toBeTruthy(),
    );
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    await waitFor(() => expect(clipboardMock.writeText).toHaveBeenCalledTimes(1));

    clipboardMock.readText.mockResolvedValueOnce('unrelated text');
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    await waitFor(() => expect(flowNodes()).toHaveLength(2));

    clipboardMock.readText.mockRejectedValueOnce(new Error('permission denied'));
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    await waitFor(() => expect(flowNodes()).toHaveLength(3));
  });

  it('支持撤销和重做节点删除', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建音频生成节点' }));
    const node = findNodeByLabel('音频生成节点');
    await user.click(node!);
    await user.keyboard('{Delete}');
    await waitFor(() => expect(flowNodes()).toHaveLength(0));

    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(1));
    expect(findNodeByLabel('音频生成节点')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '重做' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(0));
  });

  it('支持 Ctrl+A 全选节点，并用 Ctrl+S 保存当前画布', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(2));

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    await waitFor(() => {
      expect(flowNodes().filter((node) => node.querySelector('.is-selected')).length).toBe(2);
    });

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => {
      const saveRequests = fetchMock.mock.calls.filter(([input, init]) => {
        const rawUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(rawUrl, 'http://localhost:3000');
        return url.pathname === `/v1/projects/${project.id}/canvas` && init?.method === 'PATCH';
      });
      expect(saveRequests.length).toBeGreaterThan(0);
    });
  });

  it('用 Ctrl+E 拦截输入框默认行为并搜索当前项目节点', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const node = findNodeByLabel('文字生成节点');
    expect(node).toBeTruthy();
    await user.click(node!);

    const prompt = screen.getByRole('textbox', { name: '提示词' });
    const shortcutEvent = new KeyboardEvent('keydown', {
      key: 'e',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    prompt.dispatchEvent(shortcutEvent);

    expect(shortcutEvent.defaultPrevented).toBe(true);
    const searchbox = await screen.findByRole('searchbox', { name: '搜索命令…' });
    await user.type(searchbox, '文字生成节点');
    const nodeOptions = screen.getAllByRole('option', { name: /当前项目节点/ });
    expect(nodeOptions).toHaveLength(1);
    expect(nodeOptions[0]).toHaveTextContent('文字生成节点');
  });

  it('阻止非法端口连接，并提示循环依赖', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '新建视频生成节点' }));
    const imageNode = findNodeByLabel('图片生成节点')!;
    const videoNode = findNodeByLabel('视频生成节点')!;

    // 图片不能接到视频的 audioTrack 端口，连接应被静默拒绝。
    await user.click(handleFor(imageNode, 'output:image'));
    await user.click(handleFor(videoNode, 'input:audioTrack'));
    expect(screen.queryAllByTestId('flow-edge')).toHaveLength(0);

    // 图片角色参考是合法连线，随后反向连线会形成循环依赖。
    await user.click(handleFor(imageNode, 'output:image'));
    await user.click(handleFor(videoNode, 'input:character'));
    await waitFor(() => expect(screen.queryAllByTestId('flow-edge')).toHaveLength(1));

    await user.click(handleFor(videoNode, 'output:video'));
    await user.click(handleFor(imageNode, 'input:content'));
    expect(screen.getByRole('alert')).toHaveTextContent('不能创建循环依赖');
    expect(screen.queryAllByTestId('flow-edge')).toHaveLength(1);
  });

  it('从图片节点拖线到空白处可创建图生图节点并连上内容口', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    const source = findNodeByLabel('图片生成节点')!;
    await user.click(handleFor(source, 'output:image'));
    await user.click(screen.getByRole('button', { name: '画布空白' }));

    expect(await screen.findByRole('menu', { name: '选择要创建的节点' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: '图生图' }));

    const created = await waitFor(() => {
      const node = findNodeByLabel('图片生成节点 2');
      expect(node).toBeTruthy();
      return node!;
    });
    const edge = screen.getByTestId('flow-edge');
    expect(edge).toHaveAttribute('data-source', source.getAttribute('data-id'));
    expect(edge).toHaveAttribute('data-target', created.getAttribute('data-id'));
    expect(edge).toHaveAttribute('data-target-handle', 'input:content');
  });

  it('从图片节点拖线到空白处可创建视频首帧节点并连线', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    const source = findNodeByLabel('图片生成节点')!;
    await user.click(handleFor(source, 'output:image'));
    await user.click(screen.getByRole('button', { name: '画布空白' }));
    await user.click(await screen.findByRole('menuitem', { name: '视频首帧' }));

    const created = await waitFor(() => {
      const node = findNodeByLabel('视频生成节点');
      expect(node).toBeTruthy();
      return node!;
    });
    const edge = screen.getByTestId('flow-edge');
    expect(edge).toHaveAttribute('data-source', source.getAttribute('data-id'));
    expect(edge).toHaveAttribute('data-target', created.getAttribute('data-id'));
    expect(edge).toHaveAttribute('data-target-handle', 'input:firstFrame');
  });

  it('只有回显图片的节点才显示“修改图片”入口', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    const empty = findNodeByLabel('图片生成节点')!;
    expect(within(empty).queryByRole('button', { name: /^修改图片/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    expect(within(source).getByRole('button', { name: '修改图片：reference.png' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const textNode = findNodeByLabel('文字生成节点')!;
    expect(within(textNode).queryByRole('button', { name: /^修改图片/ })).toBeNull();
  });

  it('修改图片会新建独立节点、显式连上来源图并打开编辑器，原节点保持不变', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    const sourceId = source.getAttribute('data-id')!;
    const originalSource = await waitFor(() => {
      const persisted = canvas.nodes.find((node) => node.id === sourceId);
      expect(persisted).toBeDefined();
      return persisted!;
    });
    expect(screen.queryByRole('region', { name: /图片修改设置$/ })).toBeNull();

    await user.click(within(source).getByRole('button', { name: '修改图片：reference.png' }));

    const created = await waitFor(() => {
      const node = findNodeByLabel('修改 reference.png');
      expect(node).toBeTruthy();
      return node!;
    });
    const createdId = created.getAttribute('data-id')!;
    expect(createdId).not.toBe(sourceId);
    expect(flowNodes()).toHaveLength(2);

    const edge = screen.getByTestId('flow-edge');
    expect(edge).toHaveAttribute('data-source', sourceId);
    expect(edge).toHaveAttribute('data-target', createdId);
    expect(edge).toHaveAttribute('data-target-handle', 'input:imageEdit');

    // 来源节点保持原位置、尺寸、ID 和回显内容。
    const sourceAfter = findNodeByLabel('reference.png')!;
    expect(sourceAfter.getAttribute('data-id')).toBe(sourceId);

    // 新节点被选中并自动打开快速编辑器，提示询问修改意图。
    expect(await screen.findByRole('textbox', { name: '图片修改要求' })).toHaveAttribute(
      'placeholder',
      '想用这张图修改什么？例如：换成夜景、去掉背景',
    );
    expect(screen.getByRole('group', { name: '来源图（只读）' })).toHaveTextContent(
      '来源图固定版本',
    );
    // 编辑器只作用于新节点，来源节点没有被打开。
    expect(screen.getAllByRole('region', { name: /图片修改设置$/ })).toHaveLength(1);
    expect(screen.getByRole('region', { name: '修改 reference.png图片修改设置' })).toBeVisible();

    await waitFor(() => {
      const saved = canvas.nodes.find((node) => node.id === createdId);
      expect(saved?.data.imageEditSource).toMatchObject({
        sourceNodeId: sourceId,
        assetId: 'asset-reference',
        sourceKind: 'asset',
      });
    });
    // 来源节点数据在创建后与创建前完全一致。
    expect(canvas.nodes.find((node) => node.id === sourceId)).toEqual(originalSource);
  });

  it('图片修改节点与来源边可以整体撤销和重做', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    await user.click(within(source).getByRole('button', { name: '修改图片：reference.png' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    expect(screen.getAllByTestId('flow-edge')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(1));
    expect(screen.queryAllByTestId('flow-edge')).toHaveLength(0);
    expect(findNodeByLabel('reference.png')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '重做' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    expect(screen.getAllByTestId('flow-edge')).toHaveLength(1);
    expect(findNodeByLabel('reference.png')).toBeTruthy();
  });

  it('已在来源右侧的修改节点不会与已有节点重叠', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    const sourceId = source.getAttribute('data-id')!;
    await user.click(within(source).getByRole('button', { name: '修改图片：reference.png' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(2));

    const sourceBefore = await waitFor(() => {
      const persisted = canvas.nodes.find((node) => node.id === sourceId);
      expect(persisted).toBeDefined();
      return persisted!;
    });
    const firstPosition = await waitFor(() => {
      const created = canvas.nodes.find((node) => node.data.imageEditSource);
      expect(created?.position).toBeDefined();
      return created!.position;
    });

    await user.click(screen.getByRole('button', { name: '画布空白' }));
    const sourceAfter = findNodeByLabel('reference.png')!;
    await user.click(within(sourceAfter).getByRole('button', { name: '修改图片：reference.png' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(3));
    const secondPosition = await waitFor(() => {
      const created = canvas.nodes.filter((node) => node.data.imageEditSource);
      expect(created).toHaveLength(2);
      return created[1].position;
    });

    // 第二个修改节点避开第一个，且来源节点位置、尺寸在两次创建后都没被改动。
    expect(secondPosition).not.toEqual(firstPosition);
    expect(canvas.nodes.find((node) => node.id === sourceId)).toMatchObject({
      position: sourceBefore.position,
      width: sourceBefore.width,
      height: sourceBefore.height,
      data: sourceBefore.data,
    });
  });

  it('图片修改运行失败后保留原图与新节点，可改提示词重试', async () => {
    const { user } = await renderCanvas();

    // 先建一个图片生成节点，让新编辑节点继承目录里的图片模型与凭据。
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    const sourceId = source.getAttribute('data-id')!;
    const editButton = within(source).getByRole('button', { name: '修改图片：reference.png' });
    // 编辑节点名称由来源节点派生；测试从入口读取它而不是硬编码。
    const editLabel = `修改 ${editButton.getAttribute('aria-label')!.replace(/^修改图片：/, '')}`;
    await user.click(editButton);
    await waitFor(() => expect(flowNodes()).toHaveLength(3));

    const editNodeElement = await waitFor(() => {
      const node = findNodeByLabel(editLabel);
      expect(node).toBeTruthy();
      return node!;
    });
    const editNodeId = editNodeElement.getAttribute('data-id')!;
    expect(editNodeId).not.toBe(sourceId);
    const sourceBefore = await waitFor(() => {
      const persisted = canvas.nodes.find((node) => node.id === sourceId);
      expect(persisted).toBeDefined();
      return structuredClone(persisted!);
    });

    // 第一次运行失败：来源节点、编辑节点与来源边都必须保留。
    nodeRunOverrides.set(editNodeId, { status: 'failed', error: '供应商拒绝：内容不合规' });
    const editor = await screen.findByRole('region', { name: `${editLabel}图片修改设置` });
    const prompt = within(editor).getByRole('textbox', { name: '图片修改要求' });
    await user.type(prompt, '第一次尝试');
    await user.click(within(editor).getByRole('button', { name: '修改图片' }));

    await waitFor(() => expect(nodeRunRequestCounts.get(editNodeId)).toBe(1));
    await waitFor(() => {
      const node = findNodeByLabel(editLabel);
      expect(within(node!).getByRole('alert')).toHaveTextContent('供应商拒绝：内容不合规');
    });

    // 编辑器仍打开、提示词保留、运行按钮重新可用。
    expect(screen.getByRole('region', { name: `${editLabel}图片修改设置` })).toBeVisible();
    expect(prompt).toHaveValue('第一次尝试');
    expect(within(editor).getByRole('button', { name: '修改图片' })).toBeEnabled();
    expect(screen.getAllByTestId('flow-edge')).toHaveLength(1);
    expect(canvas.nodes.find((node) => node.id === sourceId)).toMatchObject({
      position: sourceBefore.position,
      data: sourceBefore.data,
    });

    // 改提示词后重试成功：只再提交一次运行，来源节点仍不变。
    nodeRunOverrides.set(editNodeId, { status: 'succeeded' });
    await user.clear(prompt);
    await user.type(prompt, '换成夜景');
    await user.click(within(editor).getByRole('button', { name: '修改图片' }));

    await waitFor(() => expect(nodeRunRequestCounts.get(editNodeId)).toBe(2));
    expect(canvas.nodes.find((node) => node.id === sourceId)).toMatchObject({
      position: sourceBefore.position,
      data: sourceBefore.data,
    });
    expect(canvas.nodes.filter((node) => node.data.imageEditSource)).toHaveLength(1);
  });

  it('关闭图片修改编辑器不会删除新节点，重新选中后设置仍在', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    await user.click(within(source).getByRole('button', { name: '修改图片：reference.png' }));
    const editor = await screen.findByRole('region', { name: /图片修改设置$/ });
    await user.type(within(editor).getByRole('textbox', { name: '图片修改要求' }), '换成夜景');

    // 关闭编辑器：只取消选中，不删除节点，也不触发运行。
    await user.click(screen.getByRole('button', { name: '画布空白' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /图片修改设置$/ })).not.toBeInTheDocument(),
    );
    expect(findNodeByLabel('修改 reference.png')).toBeTruthy();
    expect(screen.getAllByTestId('flow-edge')).toHaveLength(1);
    expect(nodeRunRequestCounts.size).toBe(0);

    // 重新选中后提示词与来源引用都还在。
    await user.click(findNodeByLabel('修改 reference.png')!);
    const reopened = await screen.findByRole('region', { name: /图片修改设置$/ });
    expect(within(reopened).getByRole('textbox', { name: '图片修改要求' })).toHaveValue('换成夜景');
    const reopenedNode = await waitFor(() => {
      const node = canvas.nodes.find((entry) => entry.data.imageEditSource);
      expect(node).toBeDefined();
      return node!;
    });
    expect(reopenedNode.data.imageEditSource).toMatchObject({
      sourceNodeId: source.getAttribute('data-id'),
      assetId: 'asset-reference',
    });
  });

  it('模型未声明图片编辑能力时阻止运行并说明原因', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    await user.click(within(source).getByRole('button', { name: '修改图片：reference.png' }));
    const editor = await screen.findByRole('region', { name: /图片修改设置$/ });
    // 新节点继承目录里的图片模型，声明生效时可以直接运行。
    expect(within(editor).getByRole('combobox', { name: /^模型：/ })).toHaveAttribute(
      'aria-label',
      '模型：图片编辑模型',
    );
    await user.type(within(editor).getByRole('textbox', { name: '图片修改要求' }), '换成夜景');
    expect(within(editor).getByRole('button', { name: '修改图片' })).toBeEnabled();

    // 切到没有声明图片编辑能力的图片模型：运行必须被拦下并说明原因。
    await user.click(within(editor).getByRole('combobox', { name: /^模型：/ }));
    await user.click(screen.getByRole('option', { name: '普通图片模型' }));
    expect(within(editor).getByRole('combobox', { name: /^模型：/ })).toHaveAttribute(
      'aria-label',
      '模型：普通图片模型',
    );
    expect(within(editor).getByRole('button', { name: '修改图片' })).toBeDisabled();
    expect(within(editor).getByRole('button', { name: '修改图片' })).toHaveAttribute(
      'title',
      '当前模型未声明支持图片编辑，请更换模型后再运行',
    );
  });
});
