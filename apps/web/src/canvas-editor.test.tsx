import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, createElement } from 'react';
import { flushSync } from 'react-dom';
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
    useUpdateNodeInternals: () => React.useCallback(() => {}, []),
  };
});

import { App } from './App';
import * as authClient from './auth-client';
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
/** 当前测试的项目与全局模型默认值，独立于节点和浏览器偏好。 */
let projectModelDefaults: Record<string, unknown>;
let globalModelDefaults: Record<string, unknown>;
/** 按节点覆写运行响应，用于覆盖失败后重试等交互；未覆写时仍返回成功。 */
let nodeRunOverrides: Map<string, { status: RunRecord['status']; error?: string }>;
let defaultNodeRunOverride: { status: RunRecord['status']; error?: string } | undefined;
let nodeRunRequestCounts: Map<string, number>;
let nodeRunRequestBodies: Map<string, Array<Record<string, unknown>>>;
let resultContent = new Map<string, { body: string; contentType: string }>();
/** 按 `runId\0nodeId` 存放的生成提示词记录，用于验证 Dialog 的读取路径。 */
let promptRecords: Map<string, Array<Record<string, unknown>>>;
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
    if (url.pathname === '/v1/settings/ai' && method === 'GET')
      return jsonResponse({
        settings: {
          baseUrl: 'https://example.test',
          configured: true,
          defaultModels: globalModelDefaults,
        },
      });
    if (url.pathname.endsWith('/models/defaults') && method === 'GET')
      return jsonResponse({ defaults: projectModelDefaults });
    const assetPrompts = url.pathname.match(
      /^\/v1\/assets\/([^/]+)\/versions\/(\d+)\/request-prompts$/,
    );
    if (assetPrompts && method === 'GET')
      return jsonResponse({
        records: [...promptRecords.values()]
          .flat()
          .filter(
            (record) =>
              record.assetId === decodeURIComponent(assetPrompts[1]!) &&
              record.assetVersion === Number(assetPrompts[2]),
          )
          .map((record) => ({ ...record, id: record.recordId })),
      });
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
      const override = nodeRunOverrides.get(nodeId) ?? defaultNodeRunOverride;
      nodeRunRequestCounts.set(nodeId, (nodeRunRequestCounts.get(nodeId) ?? 0) + 1);
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      nodeRunRequestBodies.set(nodeId, [...(nodeRunRequestBodies.get(nodeId) ?? []), payload]);
      const status = override?.status ?? 'succeeded';
      const contentUrl = `/v1/assets/asset-result-${nodeId}/content`;
      resultContent.set(contentUrl, {
        body: '这是已生成的正文。',
        contentType: 'text/plain; charset=utf-8',
      });
      const run = {
        id: `run_${nodeId}_${runs.size}`,
        targetNodeId: nodeId,
        status,
        progress: status === 'failed' ? 0 : 100,
        snapshot: { inputs: [] },
        ...(override?.error ? { error: override.error } : {}),
        ...(status === 'succeeded'
          ? {
              result: {
                provider: 'mock',
                summary: '完成',
                targetNodeId: nodeId,
                mediaType: 'text',
                inputCount: 0,
                asset: {
                  assetId: `asset-result-${nodeId}`,
                  version: 1,
                  contentUrl,
                  mimeType: 'text/plain',
                  sizeBytes: 24,
                },
              },
            }
          : {}),
      };
      runs.set(run.id, run);
      return jsonResponse({ run });
    }
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (runMatch && method === 'GET') {
      const run = runs.get(decodeURIComponent(runMatch[1]));
      if (run) return jsonResponse({ run });
    }
    // 生成提示词记录：列表只返回身份与摘要，完整文本按记录 ID 单独读取。
    const promptListMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/request-prompts$/);
    if (promptListMatch && method === 'GET') {
      const runId = decodeURIComponent(promptListMatch[1]);
      const nodeId = url.searchParams.get('nodeId') ?? '';
      const records = promptRecords.get(`${runId}\0${nodeId}`) ?? [];
      return jsonResponse({
        records: records.map((record) => ({
          id: record.recordId,
          nodeId,
          mediaType: record.mediaType,
        })),
      });
    }
    const promptRecordMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/request-prompts\/([^/]+)$/);
    if (promptRecordMatch && method === 'GET') {
      const runId = decodeURIComponent(promptRecordMatch[1]);
      const recordId = decodeURIComponent(promptRecordMatch[2]);
      for (const records of promptRecords.values()) {
        const found = records.find((record) => record.recordId === recordId);
        if (found && found.runId === runId) return jsonResponse({ record: found });
      }
      return jsonResponse({ error: 'request prompt record not found' }, 404);
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

/** 捕获项目 SSE 订阅，测试可发布运行事件而不依赖轮询计时或真实供应商。 */
function captureRunEvents() {
  let onEvent: Parameters<typeof authClient.openAuthEventStream>[1] | undefined;
  vi.spyOn(authClient, 'openAuthEventStream').mockImplementation(async (_input, callback) => {
    onEvent = callback;
  });
  return (run: RunRecord) => {
    if (!onEvent) throw new Error('项目运行事件尚未订阅');
    onEvent('run.updated', JSON.stringify(run));
  };
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

/** 画布上的连线，用于断言连接与删除范围。 */
function flowEdges() {
  return screen.queryAllByTestId('flow-edge');
}

function findNodeByLabel(label: string) {
  return flowNodes().find(
    (node) =>
      Boolean(within(node).queryByRole('group', { name: `节点操作：${label}` })) ||
      within(node).queryAllByText(label).length > 0,
  );
}

async function fillSelectedPrompt(
  user: Awaited<ReturnType<typeof renderCanvas>>['user'],
  prompt: string,
) {
  const editor = await screen.findByRole('region', { name: /设置$/ });
  const box = within(editor).getByRole('textbox', { name: /提示词|图片修改要求/ });
  await user.clear(box);
  await user.type(box, prompt);
  return editor;
}

/** 读取某节点最近一次 /runs POST 体。 */
function lastNodeRunBody(nodeId: string): Record<string, unknown> {
  const bodies = nodeRunRequestBodies.get(nodeId) ?? [];
  expect(bodies.length).toBeGreaterThan(0);
  return bodies.at(-1)!;
}

/** 读取运行请求里的提示词。 */
function runPromptOf(nodeId: string): string {
  const parameters = lastNodeRunBody(nodeId).parameters as { prompt?: string } | undefined;
  return parameters?.prompt ?? '';
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
    projectModelDefaults = {};
    globalModelDefaults = {};
    nodeRunOverrides = new Map();
    defaultNodeRunOverride = undefined;
    nodeRunRequestCounts = new Map();
    nodeRunRequestBodies = new Map();
    resultContent = new Map();
    promptRecords = new Map();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    previousClipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
    installClipboardMock();
    installApiMock();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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

  it('新节点优先继承项目默认的模型与凭据，不复制旧模型参数', async () => {
    projectModelDefaults = {
      image: { modelAlias: 'image-plain-model', credentialId: credentialSummary.id },
    };
    globalModelDefaults = {
      image: { modelAlias: 'image-edit-model', credentialId: credentialSummary.id },
    };
    canvas = {
      revision: 1,
      edges: [],
      nodes: [
        {
          id: 'old-image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: '旧图片节点',
            mode: 'generate',
            mediaType: 'image',
            modelAlias: 'image-edit-model',
            parameters: { legacyOption: true },
          },
        },
      ],
    };
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await waitFor(() => expect(canvas.nodes).toHaveLength(2));
    const created = canvas.nodes.find((node) => node.id !== 'old-image')!;
    expect(created.data.modelAlias).toBe('image-plain-model');
    expect(created.data.credentialId).toBe(credentialSummary.id);
    expect(created.data.parameters).not.toHaveProperty('legacyOption');
  });

  it('未设置项目默认时继承全局类型默认', async () => {
    globalModelDefaults = {
      image: { modelAlias: 'image-plain-model', credentialId: credentialSummary.id },
    };
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await waitFor(() => expect(canvas.nodes).toHaveLength(1));
    expect(canvas.nodes[0]!.data.modelAlias).toBe('image-plain-model');
    expect(canvas.nodes[0]!.data.credentialId).toBe(credentialSummary.id);
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
    await user.click(screen.getByRole('option', { name: /reference.png/ }));

    expect((prompt as HTMLTextAreaElement).value).toMatch(/根据\s+@?reference(\.png)?/);

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
        parameters: { prompt: expect.stringMatching(/根据\s+@?reference(\.png)?/) },
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
    await user.click(within(inferenceGroup).getByRole('combobox', { name: /^推理强度：/ }));
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

  it('恢复倒序运行记录时保留旧成功结果及其提示词和耗时，同时显示新失败', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    await waitFor(() => expect(canvas.nodes).toHaveLength(1));
    const node = persistedNode('text');
    const failed = createRestoredRun(node, { status: 'failed', error: '新请求失败，旧结果保留' });
    failed.id = 'run-new-failed';
    failed.createdAt = '2026-08-28T08:01:00.000Z';
    failed.updatedAt = '2026-08-28T08:01:03.000Z';
    failed.nodeTimings = {
      [node.id]: {
        nodeId: node.id,
        startedAt: failed.createdAt,
        finishedAt: failed.updatedAt,
        outcome: 'failed',
      },
    };
    const succeeded = createRestoredRun(node, { textContent: '旧版本的成功正文' });
    succeeded.nodeTimings = {
      [node.id]: {
        nodeId: node.id,
        startedAt: succeeded.createdAt,
        finishedAt: '2026-08-28T08:00:12.400Z',
        outcome: 'succeeded',
      },
    };
    projectRuns = [failed, succeeded];
    promptRecords.set(`${succeeded.id}\0${node.id}`, [
      {
        recordId: 'record-old-result',
        runId: succeeded.id,
        nodeId: node.id,
        attempt: 1,
        requestIdentity: 'POST /chat/completions#1',
        schemaVersion: 1,
        provider: 'newapi',
        modelAlias: 'text-model',
        mediaType: 'text',
        format: 'messages',
        parts: [{ order: 0, role: 'user', text: '旧版本实际发送的请求' }],
        resources: [],
        sendStatus: 'sent',
        createdAt: succeeded.createdAt,
        assetId: succeeded.result!.asset!.assetId,
        assetVersion: 1,
        summary: '旧结果的生成摘要',
      },
    ]);

    cleanup();
    fetchMock.mockClear();
    const restored = await renderCanvas();
    const restoredNode = await waitFor(() => {
      const current = findNodeByLabel('文字生成节点')!;
      expect(within(current).getByText('旧版本的成功正文')).toBeVisible();
      expect(within(current).getByLabelText('运行失败')).toBeInTheDocument();
      return current;
    });
    await restored.user.click(within(restoredNode).getByRole('button', { name: '查看节点信息' }));
    const info = await screen.findByRole('dialog', { name: '节点信息' });
    expect(within(info).getByRole('alert')).toHaveTextContent('新请求失败，旧结果保留');
    expect(within(info).getByText('12.4 s')).toBeVisible();
    expect(within(info).queryByText('3.0 s')).not.toBeInTheDocument();
    await restored.user.click(within(info).getByRole('button', { name: /查看生成提示词/ }));
    const dialog = await screen.findByRole('dialog', { name: '生成提示词' });
    expect(await within(dialog).findByText('旧结果的生成摘要')).toBeVisible();
    expect(within(dialog).getByText('[user] 旧版本实际发送的请求')).toBeVisible();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(
          `/assets/${succeeded.result!.asset!.assetId}/versions/1/request-prompts`,
        ),
      ),
    ).toBe(true);
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

  it('胶囊工具栏创建空组，整组移动带走成员，解散后成员与连线保留', async () => {
    const { user } = await renderCanvas();

    // 空组：没有选区时在视口中心创建固定尺寸区域。
    await user.click(screen.getByRole('button', { name: '新建分组' }));
    const group = await screen.findByText('组 1');
    expect(group).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();

    // 建两个节点并框选成组。
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const imageNode = findNodeByLabel('图片生成节点')!;
    const textNode = findNodeByLabel('文字生成节点')!;
    await user.click(imageNode);
    await user.keyboard('{Control>}a{/Control}');
    await user.click(screen.getByRole('button', { name: '新建分组' }));

    await waitFor(() => expect(screen.getByText('组 2')).toBeInTheDocument());
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);

    // 组只表达布局：不进入运行图，也不改变节点数量。
    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    expect(textNode).toBeTruthy();

    // 解散后成员与连线保留，区域移除。
    await user.click(screen.getByText('组 2'));
    await user.click(screen.getByLabelText('解散组 组 2'));
    await waitFor(() => expect(screen.queryByText('组 2')).not.toBeInTheDocument());
    expect(flowNodes()).toHaveLength(2);
  });

  it('整组复制粘贴保留区域并重建成员身份，撤销后恢复原组', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    await user.click(screen.getByRole('button', { name: '新建分组' }));
    await waitFor(() => expect(document.querySelectorAll('.canvas-group')).toHaveLength(1));

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    await waitFor(() => expect(clipboardMock.writeText).toHaveBeenCalledTimes(1));
    const copied = JSON.parse(clipboardMock.getText());
    expect(copied.groups).toHaveLength(1);
    expect(copied.groups[0].nodeIds).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    await waitFor(() => expect(flowNodes()).toHaveLength(4));
    expect(document.querySelectorAll('.canvas-group')).toHaveLength(2);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(canvas.groups).toHaveLength(2));
    const [original, pasted] = canvas.groups!;
    expect(pasted!.id).not.toBe(original!.id);
    expect(pasted!.nodeIds).toHaveLength(2);
    expect(pasted!.nodeIds.every((id) => !original!.nodeIds.includes(id))).toBe(true);
    expect(pasted!.nodeIds.every((id) => canvas.nodes.some((node) => node.id === id))).toBe(true);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    expect(document.querySelectorAll('.canvas-group')).toHaveLength(1);
  });

  it('清空菜单在 hover 后展开，取消确认不改变任何内容', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '新建分组' }));

    await user.hover(screen.getByRole('button', { name: '清空' }));
    const clearCanvasItem = await screen.findByRole('menuitem', { name: /清空画布/ });
    expect(clearCanvasItem).toHaveTextContent('1 节点');
    expect(clearCanvasItem).toHaveTextContent('1 组');

    // 取消确认：节点与组都不变。
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(clearCanvasItem);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(flowNodes()).toHaveLength(1);
    expect(screen.getByText('组 1')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('清空确认说明在途任务继续执行，迟到完成事件只刷新资源而不复活节点', async () => {
    const emitRun = captureRunEvents();
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    await waitFor(() => expect(canvas.nodes).toHaveLength(1));
    const node = persistedNode('text');
    const running = createRestoredRun(node, { status: 'running', includeAsset: false });
    act(() => emitRun(running));
    await user.hover(screen.getByRole('button', { name: '清空' }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(await screen.findByRole('menuitem', { name: /清空画布/ }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('当前有 1 个在途任务'));
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining('清空后仍会继续执行，结果保留在资源库'),
    );
    expect(flowNodes()).toHaveLength(0);
    expect(screen.queryByRole('region', { name: /设置$/ })).not.toBeInTheDocument();
    const requestsBeforeCompletion = fetchMock.mock.calls.length;

    const completed = createRestoredRun(node);
    completed.updatedAt = '2026-08-28T08:00:15.000Z';
    await act(async () => emitRun(completed));
    await waitFor(() => expect(canvas.nodes).toHaveLength(0));
    expect(flowNodes()).toHaveLength(0);
    expect(
      fetchMock.mock.calls
        .slice(requestsBeforeCompletion)
        .some(([input]) => /\/v1\/assets(?:\?|$)/.test(String(input))),
    ).toBe(true);
    expect(nodeRunRequestCounts.size).toBe(0);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/cancel'))).toBe(false);
  });

  it.each(['提示词', '运行'] as const)(
    '清空确认期间%s状态改变时保留节点，并重新确认剩余数量',
    async (change) => {
      const emitRun = captureRunEvents();
      const { user } = await renderCanvas();
      await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
      await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
      const changingNode = findNodeByLabel('文字生成节点')!;
      await user.click(changingNode);
      const prompt = screen.getByRole('textbox', { name: '提示词' });
      await waitFor(() => expect(canvas.nodes).toHaveLength(2));
      const running = createRestoredRun(persistedNode('text'), {
        status: 'running',
        includeAsset: false,
      });
      await user.hover(screen.getByRole('button', { name: '清空' }));
      const clearEmpty = await screen.findByRole('menuitem', { name: /清空空节点/ });
      expect(clearEmpty).toHaveTextContent('2 节点');
      const confirmSpy = vi
        .spyOn(window, 'confirm')
        .mockImplementationOnce(() => {
          flushSync(() => {
            if (change === '提示词')
              fireEvent.change(prompt, { target: { value: '确认期间新增的内容' } });
            else emitRun(running);
          });
          return true;
        })
        .mockReturnValue(true);

      await user.click(clearEmpty);
      expect(confirmSpy).toHaveBeenCalledTimes(2);
      expect(confirmSpy.mock.calls[0]?.[0]).toContain('2 个空节点');
      expect(confirmSpy.mock.calls[1]?.[0]).toContain('节点状态已变化');
      expect(confirmSpy.mock.calls[1]?.[0]).toContain('1 个空节点');
      expect(flowNodes()).toHaveLength(1);
      expect(findNodeByLabel('文字生成节点')).toBeTruthy();
      expect(findNodeByLabel('图片生成节点')).toBeUndefined();
      if (change === '提示词') expect(prompt).toHaveValue('确认期间新增的内容');
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      await waitFor(() => expect(flowNodes()).toHaveLength(2));
      if (change === '提示词')
        expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue('确认期间新增的内容');
    },
  );

  it('清空空节点时关闭被删除节点的提示词窗口和快速编辑器', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const node = findNodeByLabel('文字生成节点')!;
    await user.click(node);
    expect(screen.getByRole('region', { name: /设置$/ })).toBeVisible();
    const clearButton = screen.getByRole('button', { name: '清空' });
    await user.click(within(node).getByRole('button', { name: '查看节点信息' }));
    await user.click(await screen.findByRole('button', { name: /查看生成提示词/ }));
    expect(await screen.findByRole('dialog', { name: '生成提示词' })).toBeVisible();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(clearButton);
    fireEvent.click(screen.getByRole('menuitem', { name: /清空空节点/, hidden: true }));
    expect(flowNodes()).toHaveLength(0);
    expect(screen.queryByRole('dialog', { name: '生成提示词' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /设置$/ })).not.toBeInTheDocument();
  });

  it('清空画布关闭加载中的提示词窗口，迟到查询响应不能重新打开', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const node = findNodeByLabel('文字生成节点')!;
    await user.click(node);
    const editor = await fillSelectedPrompt(user, '生成旧结果');
    await user.click(within(editor).getByRole('button', { name: '生成' }));
    await waitFor(() => expect(within(node).getByText('这是已生成的正文。')).toBeVisible());
    const apiImplementation = fetchMock.getMockImplementation()!;
    let resolvePrompt: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/request-prompts')) {
        return new Promise<Response>((resolve) => {
          resolvePrompt = resolve;
        });
      }
      return apiImplementation(input, init);
    });
    const clearButton = screen.getByRole('button', { name: '清空' });
    await user.click(within(node).getByRole('button', { name: '查看节点信息' }));
    await user.click(await screen.findByRole('button', { name: /查看生成提示词/ }));
    await waitFor(() => expect(resolvePrompt).toBeDefined());
    expect(await screen.findByRole('dialog', { name: '生成提示词' })).toBeVisible();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(clearButton);
    fireEvent.click(screen.getByRole('menuitem', { name: /清空画布/, hidden: true }));
    expect(flowNodes()).toHaveLength(0);
    expect(screen.queryByRole('dialog', { name: '生成提示词' })).not.toBeInTheDocument();
    await act(async () => resolvePrompt!(jsonResponse({ records: [] })));
    expect(screen.queryByRole('dialog', { name: '生成提示词' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /设置$/ })).not.toBeInTheDocument();
  });

  it('清空空节点只移除空模板，保留已填写提示词与已绑定资源的节点，并可一次撤销', async () => {
    const { user } = await renderCanvas();

    // 空模板：候选。
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    const emptyNode = findNodeByLabel('图片生成节点')!;
    await user.click(emptyNode);
    // 已填写提示词：必须保留。
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const filledNode = findNodeByLabel('文字生成节点')!;
    await user.click(filledNode);
    await fillSelectedPrompt(user, '这段内容必须保留');
    // 新建的空模板未被选中，先取消选中再统计候选。
    await user.keyboard('{Escape}');

    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    await user.hover(screen.getByRole('button', { name: '清空' }));
    const clearEmptyItem = await screen.findByRole('menuitem', { name: /清空空节点/ });
    // 只有一个空模板是候选：已填写提示词的节点被保留。
    expect(clearEmptyItem).toHaveTextContent('1 节点');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(clearEmptyItem);
    await waitFor(() => expect(flowNodes()).toHaveLength(1));
    expect(findNodeByLabel('文字生成节点')).toBeTruthy();
    expect(findNodeByLabel('图片生成节点')).toBeUndefined();
    confirmSpy.mockRestore();

    // 一次撤销恢复节点与提示词。
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    expect(findNodeByLabel('图片生成节点')).toBeTruthy();
  });

  it('清空空节点保留有有效上游输入的空节点，只清理没有任何输入的模板', async () => {
    const { user } = await renderCanvas();

    // 来源节点 -> 生成节点：生成节点提示词为空，但它有有效上游输入，必须保留。
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    const upstream = findNodeByLabel('图片生成节点')!;
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const downstream = findNodeByLabel('文字生成节点')!;
    // 用拖线建立上游连接，形成真实的有效输入引用。
    await user.click(handleFor(upstream, 'output:image'));
    await user.click(handleFor(downstream, 'input:content'));
    await waitFor(() => expect(flowEdges()).toHaveLength(1));

    // 再建一个完全没有输入的模板节点，它才是候选。
    await user.click(screen.getByRole('button', { name: '新建音频生成节点' }));
    await user.keyboard('{Escape}');

    await waitFor(() => expect(flowNodes()).toHaveLength(3));
    await user.hover(screen.getByRole('button', { name: '清空' }));
    const clearEmptyItem = await screen.findByRole('menuitem', { name: /清空空节点/ });
    // 两个没有任何内容的模板都是候选；有上游输入的文字节点必须保留。
    expect(clearEmptyItem).toHaveTextContent('2 节点');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(clearEmptyItem);
    await waitFor(() => expect(flowNodes()).toHaveLength(1));
    expect(findNodeByLabel('文字生成节点')).toBeTruthy();
    expect(findNodeByLabel('图片生成节点')).toBeUndefined();
    expect(findNodeByLabel('音频生成节点')).toBeUndefined();
    confirmSpy.mockRestore();
  });

  it('提示词入口读取该节点真正发送的请求文本，缺失记录时明确说明', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const node = findNodeByLabel('文字生成节点')!;
    await user.click(node);
    const quickEditor = await fillSelectedPrompt(user, '写一段开头');
    await user.click(within(quickEditor).getByRole('button', { name: '生成' }));

    // 等运行结束后写入一条与本次运行对应的请求记录。
    await waitFor(() => expect(nodeRunRequestCounts.size).toBeGreaterThan(0));
    const nodeId = [...nodeRunRequestCounts.keys()][0]!;
    const runId = `run_${nodeId}_0`;
    promptRecords.set(`${runId}\0${nodeId}`, [
      {
        recordId: 'record-1',
        runId,
        nodeId,
        attempt: 1,
        requestIdentity: 'POST /chat/completions#1',
        schemaVersion: 1,
        provider: 'newapi',
        modelAlias: 'text-model',
        mediaType: 'text',
        format: 'messages',
        parts: [{ order: 0, role: 'user', text: '写一段开头' }],
        resources: [],
        sendStatus: 'sent',
        createdAt: '2026-09-16T10:00:00.000Z',
        assetId: `asset-result-${nodeId}`,
        assetVersion: 1,
        summary: '写一段开头。',
      },
    ]);

    // 提示词入口在节点信息面板内，属于只读查询，不是输入编辑入口。
    await user.click(within(node).getByRole('button', { name: '查看节点信息' }));
    await user.click(await screen.findByRole('button', { name: /查看生成提示词/ }));
    const dialog = await screen.findByRole('dialog', { name: '生成提示词' });
    expect(within(dialog).getByText('写一段开头。')).toBeVisible();
    expect(within(dialog).getByText('[user] 写一段开头')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: '关闭生成提示词' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '生成提示词' })).not.toBeInTheDocument(),
    );
  });

  it('没有生成记录的节点显示未记录生成提示词，不伪造内容', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const node = findNodeByLabel('文字生成节点')!;

    // 提示词入口在节点信息面板内，属于只读查询，不是输入编辑入口。
    await user.click(within(node).getByRole('button', { name: '查看节点信息' }));
    await user.click(await screen.findByRole('button', { name: /查看生成提示词/ }));
    const dialog = await screen.findByRole('dialog', { name: '生成提示词' });
    await waitFor(() => expect(within(dialog).getByText(/未记录生成提示词/)).toBeVisible());
    await user.click(within(dialog).getByRole('button', { name: '关闭生成提示词' }));
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
    await user.click(videoNode);
    const videoEditor = await screen.findByRole('region', { name: /生成设置$/ });
    await user.click(within(videoEditor).getByRole('combobox', { name: /^生成模式：/ }));
    await user.click(screen.getByRole('option', { name: /全能参考/ }));

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
    expect(within(source).getByRole('button', { name: '修改图片：reference.png' })).toBeDisabled();
    await user.click(source);
    const sourceEditor = await screen.findByRole('region', { name: /生成设置$/ });
    expect(within(sourceEditor).getByRole('button', { name: '生成' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const textNode = findNodeByLabel('文字生成节点')!;
    expect(within(textNode).queryByRole('button', { name: /^修改图片/ })).toBeNull();
  });

  it('无提示词时修改图片不建节点也不发请求', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    const button = within(source).getByRole('button', { name: '修改图片：reference.png' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(flowNodes()).toHaveLength(1);
    expect(nodeRunRequestCounts.size).toBe(0);
  });

  it('修改图片不复制提示词，但立刻用父提示词发请求，结果只写入新节点', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    const sourceId = source.getAttribute('data-id')!;
    await user.click(source);
    await fillSelectedPrompt(user, '换成夜景');
    const originalSource = await waitFor(() => {
      const persisted = canvas.nodes.find((node) => node.id === sourceId);
      expect(persisted?.data.prompt).toContain('换成夜景');
      return structuredClone(persisted!);
    });

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

    await waitFor(() => expect(nodeRunRequestCounts.get(createdId)).toBe(1));
    expect(runPromptOf(createdId)).toContain('换成夜景');
    await waitFor(() => {
      const saved = canvas.nodes.find((node) => node.id === createdId);
      expect(saved?.data.imageEditSource).toMatchObject({
        sourceNodeId: sourceId,
        assetId: 'asset-reference',
        sourceKind: 'asset',
      });
      expect(saved?.data.prompt).toBeUndefined();
      expect(saved?.data.promptDocument).toBeUndefined();
      expect(saved?.data.resourceRefs).toBeUndefined();
    });
    expect(canvas.nodes.find((node) => node.id === sourceId)).toMatchObject({
      position: originalSource.position,
      data: originalSource.data,
    });
    expect(await screen.findByRole('textbox', { name: '图片修改要求' })).toHaveValue('');
    const sourceCard = screen.getByRole('group', { name: '来源图（只读）' });
    expect(sourceCard).toHaveTextContent('reference.png');
    await waitFor(() => {
      expect(within(sourceCard).getByRole('img')).toHaveAttribute(
        'src',
        expect.stringContaining('access_token=synthetic-unit'),
      );
    });
  });

  it('图片修改节点与来源边可以整体撤销和重做', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    await user.click(source);
    await fillSelectedPrompt(user, '换成夜景');
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
    const sourceBefore = await waitFor(() => {
      const persisted = canvas.nodes.find((node) => node.id === sourceId);
      expect(persisted).toBeDefined();
      return structuredClone(persisted!);
    });
    await user.click(source);
    await fillSelectedPrompt(user, '第一次修改');
    await user.click(within(source).getByRole('button', { name: '修改图片：reference.png' }));
    const firstPosition = await waitFor(() => {
      const created = canvas.nodes.find((node) => node.data.imageEditSource);
      expect(created?.position).toBeDefined();
      return created!.position;
    });

    await user.click(screen.getByRole('button', { name: '画布空白' }));
    const sourceAfter = findNodeByLabel('reference.png')!;
    await user.click(sourceAfter);
    await fillSelectedPrompt(user, '第二次修改');
    await user.click(within(sourceAfter).getByRole('button', { name: '修改图片：reference.png' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(3));
    const secondPosition = await waitFor(() => {
      const created = canvas.nodes.filter((node) => node.data.imageEditSource);
      expect(created).toHaveLength(2);
      return created[1].position;
    });

    expect(secondPosition).not.toEqual(firstPosition);
    expect(canvas.nodes.find((node) => node.id === sourceId)).toMatchObject({
      position: sourceBefore.position,
      width: sourceBefore.width,
      height: sourceBefore.height,
    });
  });

  it('图片修改运行失败后保留原图与新节点，可改提示词重试', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    const sourceId = source.getAttribute('data-id')!;
    const editButton = within(source).getByRole('button', { name: '修改图片：reference.png' });
    const editLabel = `修改 ${editButton.getAttribute('aria-label')!.replace(/^修改图片：/, '')}`;
    defaultNodeRunOverride = { status: 'failed', error: '供应商拒绝：内容不合规' };
    await user.click(source);
    await fillSelectedPrompt(user, '第一次尝试');
    const sourceBefore = await waitFor(() => {
      const persisted = canvas.nodes.find((node) => node.id === sourceId);
      expect(persisted).toBeDefined();
      return structuredClone(persisted!);
    });
    await user.click(editButton);
    await waitFor(() => expect(flowNodes()).toHaveLength(3));

    const editNodeElement = await waitFor(() => {
      const node = findNodeByLabel(editLabel);
      expect(node).toBeTruthy();
      return node!;
    });
    const editNodeId = editNodeElement.getAttribute('data-id')!;
    await waitFor(() => expect(nodeRunRequestCounts.get(editNodeId)).toBe(1));
    expect(runPromptOf(editNodeId)).toContain('第一次尝试');
    await waitFor(() => {
      const node = findNodeByLabel(editLabel);
      expect(within(node!).getByRole('alert')).toHaveTextContent('供应商拒绝：内容不合规');
    });

    const editor = screen.getByRole('region', { name: `${editLabel}图片修改设置` });
    const prompt = within(editor).getByRole('textbox', { name: '图片修改要求' });
    expect(prompt).toHaveValue('');
    expect(within(editor).getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getAllByTestId('flow-edge')).toHaveLength(1);
    expect(canvas.nodes.find((node) => node.id === sourceId)).toMatchObject({
      position: sourceBefore.position,
      data: sourceBefore.data,
    });

    defaultNodeRunOverride = undefined;
    nodeRunOverrides.set(editNodeId, { status: 'succeeded' });
    await user.clear(prompt);
    await user.type(prompt, '换成夜景');
    await user.click(within(editor).getByRole('button', { name: '生成' }));

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
    await user.click(source);
    await fillSelectedPrompt(user, '换成夜景');
    await user.click(within(source).getByRole('button', { name: '修改图片：reference.png' }));
    const editor = await screen.findByRole('region', { name: /图片修改设置$/ });
    expect(within(editor).getByRole('textbox', { name: '图片修改要求' })).toHaveValue('');
    await waitFor(() => expect(nodeRunRequestCounts.size).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: '画布空白' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /图片修改设置$/ })).not.toBeInTheDocument(),
    );
    expect(findNodeByLabel('修改 reference.png')).toBeTruthy();
    expect(screen.getAllByTestId('flow-edge')).toHaveLength(1);

    await user.click(findNodeByLabel('修改 reference.png')!);
    const reopened = await screen.findByRole('region', { name: /图片修改设置$/ });
    expect(within(reopened).getByRole('textbox', { name: '图片修改要求' })).toHaveValue('');
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

  it('模型未声明图片编辑能力时仍可把修改结果生成到新节点', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '添加 reference.png 到画布' }));
    const source = findNodeByLabel('reference.png')!;
    await user.click(source);
    const editor = await fillSelectedPrompt(user, '换成夜景');
    expect(within(editor).getByRole('button', { name: '新节点' })).toBeEnabled();

    await user.click(within(editor).getByRole('combobox', { name: /^模型：/ }));
    await user.click(screen.getByRole('option', { name: '普通图片模型' }));
    expect(within(editor).getByRole('combobox', { name: /^模型：/ })).toHaveAttribute(
      'aria-label',
      '模型：普通图片模型',
    );
    expect(within(editor).getByRole('button', { name: '新节点' })).toBeEnabled();
    expect(within(editor).getByRole('button', { name: '新节点' })).toHaveAttribute(
      'title',
      '把修改结果写到新节点',
    );
    await user.click(within(editor).getByRole('button', { name: '新节点' }));
    await waitFor(() => {
      const child = canvas.nodes.find((node) => node.data.imageEditSource);
      expect(child).toBeDefined();
      expect(nodeRunRequestCounts.get(child!.id)).toBe(1);
    });
  });

  it('有回显后再点生成仍覆盖原节点，不新建节点也不写 imageEditSource', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    const node = findNodeByLabel('图片生成节点')!;
    await user.click(node);
    await fillSelectedPrompt(user, '第一张图');
    await user.click(
      within(screen.getByRole('region', { name: /生成设置$/ })).getByRole('button', {
        name: '生成',
      }),
    );
    const nodeId = node.getAttribute('data-id')!;
    await waitFor(() => expect(nodeRunRequestCounts.get(nodeId)).toBe(1));
    await waitFor(() => {
      expect(
        within(screen.getByRole('region', { name: /生成设置$/ })).getByRole('button', {
          name: '新节点',
        }),
      ).toBeEnabled();
    });
    expect(flowNodes()).toHaveLength(1);
    await user.click(
      within(screen.getByRole('region', { name: /生成设置$/ })).getByRole('button', {
        name: '生成',
      }),
    );
    await waitFor(() => expect(nodeRunRequestCounts.get(nodeId)).toBe(2));
    expect(flowNodes()).toHaveLength(1);
    expect(canvas.nodes.find((item) => item.id === nodeId)?.data.imageEditSource).toBeUndefined();
  });

  it('文字新节点不复制提示词，请求里带上原提示词和回显正文', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const source = findNodeByLabel('文字生成节点')!;
    const sourceId = source.getAttribute('data-id')!;
    await user.click(source);
    await user.click(screen.getByRole('button', { name: '新建分组' }));
    await user.click(source);
    await fillSelectedPrompt(user, '写一篇介绍');
    await user.click(
      within(screen.getByRole('region', { name: /生成设置$/ })).getByRole('button', {
        name: '生成',
      }),
    );
    await waitFor(() => expect(nodeRunRequestCounts.get(sourceId)).toBe(1));
    const editor = screen.getByRole('region', { name: /生成设置$/ });
    await waitFor(() =>
      expect(within(editor).getByRole('button', { name: '新节点' })).toBeEnabled(),
    );
    const parentBefore = structuredClone(canvas.nodes.find((node) => node.id === sourceId)!);
    await user.click(within(editor).getByRole('button', { name: '新节点' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    const child = canvas.nodes.find((node) => node.id !== sourceId);
    expect(child).toBeDefined();
    await waitFor(() => expect(nodeRunRequestCounts.get(child!.id)).toBe(1));
    expect(child?.data.prompt).toBeUndefined();
    expect(child?.data.promptDocument).toBeUndefined();
    expect(runPromptOf(child!.id)).toContain('写一篇介绍');
    expect(runPromptOf(child!.id)).toContain('【已生成内容】');
    expect(runPromptOf(child!.id)).toContain('这是已生成的正文。');
    expect(canvas.nodes.find((node) => node.id === sourceId)?.data.prompt).toBe(
      parentBefore.data.prompt,
    );
    expect(canvas.edges).toHaveLength(0);
    expect(canvas.groups?.[0]?.nodeIds).toEqual(expect.arrayContaining([sourceId, child!.id]));
    const group = canvas.groups![0]!;
    expect(group.position.x + group.width).toBeGreaterThanOrEqual(
      child!.position.x + (child!.width ?? 0),
    );
  });
});
