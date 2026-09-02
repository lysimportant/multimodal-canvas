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
    children,
  }: {
    nodes: Array<{ id: string; type?: string; data: unknown; selected?: boolean }>;
    edges: Array<{ id: string; source: string; target: string }>;
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
    children?: React.ReactNode;
  }) {
    const [pending, setPending] = React.useState<{
      nodeId: string;
      handleId: string | null;
    } | null>(null);

    const connectHandle = React.useCallback(
      (nodeId: string, type: 'source' | 'target', handleId: string | null) => {
        if (!pending) {
          if (type === 'source') setPending({ nodeId, handleId });
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
        setPending({ nodeId, handleId });
      },
      [onConnect, pending],
    );

    return (
      <flowContext.Provider value={{ connectHandle }}>
        <div data-testid="rf__wrapper" className="react-flow" role="application">
          <button
            type="button"
            className="react-flow__pane"
            aria-label="画布空白"
            onClick={onPaneClick}
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
  };
});

import { App } from './App';

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
const modelCatalog = [
  {
    id: 'text-model',
    name: '文字模型',
    mediaTypes: ['text'],
    capabilities: { reasoning_effort: ['low', 'medium', 'high'] },
  },
];
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let canvas: CanvasDocument;
let projectRuns: RunRecord[];
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
    if (url.pathname === '/v1/assets' && method === 'GET') return jsonResponse({ assets });
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
      const run = {
        id: `run_${nodeId}`,
        targetNodeId: nodeId,
        status: 'succeeded',
        progress: 100,
        snapshot: { inputs: [] },
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
  const contentUrl = `/v1/assets/restored-${node.id}/content`;
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
  return flowNodes().find((node) => within(node).queryAllByText(label).length > 0);
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
    clipboardText = '';
    canvas = structuredClone(emptyCanvas);
    projectRuns = [];
    resultContent = new Map();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    previousClipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
    installClipboardMock();
    installApiMock();
  });

  afterEach(() => {
    cleanup();
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

  it('节点标题支持中文组合输入，并可作为一次编辑撤销', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    await user.click(findNodeByLabel('文字生成节点')!);
    const title = screen.getByRole('textbox', { name: '节点名称' });

    fireEvent.compositionStart(title);
    fireEvent.change(title, { target: { value: 'zhong wen' } });
    expect(title).toHaveValue('zhong wen');
    fireEvent.change(title, { target: { value: '中文标题' } });
    fireEvent.compositionEnd(title, { data: '中文标题' });
    expect(title).toHaveValue('中文标题');
    expect(findNodeByLabel('中文标题')).toBeTruthy();

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
    const inspector = document.querySelector<HTMLElement>('.inspector-panel');
    expect(inspector).toBeTruthy();
    expect(within(quickEditor).getByRole('textbox', { name: '提示词' })).toBeVisible();
    expect(within(quickEditor).getByRole('combobox', { name: /^模型：/ })).toBeVisible();
    expect(within(quickEditor).getByRole('combobox', { name: /^推理强度：/ })).toBeVisible();
    expect(within(quickEditor).getByRole('button', { name: '生成' })).toBeVisible();
    expect(within(inspector!).queryByRole('textbox', { name: '提示词' })).not.toBeInTheDocument();
    expect(within(inspector!).queryByRole('combobox', { name: /^模型：/ })).not.toBeInTheDocument();
    expect(
      within(inspector!).queryByRole('combobox', { name: /^推理强度：/ }),
    ).not.toBeInTheDocument();
    expect(within(inspector!).queryByRole('button', { name: '生成' })).not.toBeInTheDocument();

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

    const trigger = screen.getByRole('button', { name: '选择画布背景' });
    await user.click(trigger);

    expect(screen.getByRole('menu', { name: '画布背景' })).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: '点' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await user.click(screen.getByRole('menuitemradio', { name: '空白' }));
    expect(screen.queryByRole('menu', { name: '画布背景' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(window.localStorage.getItem('multimodal-canvas:background')).toBe('blank');
  });

  it('来源节点属性可编辑，并可从 Handle 附近打开属性与创建转换', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png');
    expect(source).toBeTruthy();

    const sourceHandle = handleFor(source!, 'output:image');
    await user.click(sourceHandle);
    expect(screen.getByRole('textbox', { name: '节点名称' })).toHaveValue('reference.png');

    const prompt = screen.getByRole('textbox', { name: '来源提示 / 说明' });
    await user.type(prompt, '作为角色参考');
    expect(prompt).toHaveValue('作为角色参考');

    await user.click(screen.getByRole('button', { name: '创建转换' }));
    expect(findNodeByLabel('图片转换节点')).toBeTruthy();
    expect(screen.queryAllByTestId('flow-edge')).toHaveLength(1);
  });

  it('工具栏可以创建四类转换节点', async () => {
    const { user } = await renderCanvas();

    for (const mediaType of ['文字', '图片', '音频', '视频']) {
      await user.click(screen.getByRole('button', { name: `新建${mediaType}转换节点` }));
    }

    expect(findNodeByLabel('文字转换节点')).toBeTruthy();
    expect(findNodeByLabel('图片转换节点')).toBeTruthy();
    expect(findNodeByLabel('音频转换节点')).toBeTruthy();
    expect(findNodeByLabel('视频转换节点')).toBeTruthy();
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
    expect(screen.getAllByText('文字生成节点').length).toBeGreaterThanOrEqual(2);

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
});
