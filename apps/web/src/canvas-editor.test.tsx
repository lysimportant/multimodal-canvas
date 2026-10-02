import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, 1] }),
    useEdges: () => [],
    useNodeConnections: () => [],
    useUpdateNodeInternals: () => React.useCallback(() => {}, []),
  };
});

import { App } from './App';
import * as authClient from './auth-client';
import { clearAuthSession, persistAuthSession } from './auth-client';
import { clearImageThumbnailCache } from './workspace/image-thumbnail-cache';

/** 恢复测试前对象 URL 实现；缩略图夹具不访问真实网络。 */
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

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
/** 模型身份包含分组凭据，确保同名模型不会跨组串用。 */
const modelCredentialId = 'credential-model-catalog';
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
].map((model) => ({ ...model, group: 'default', credentialId: modelCredentialId }));
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let canvas: CanvasDocument;
let projectRuns: RunRecord[];
let workspaceProjects: (typeof project)[];
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

    if (url.pathname === '/v1/prompt-skills' && method === 'GET')
      return jsonResponse({ skills: [] });

    if (url.pathname === '/v1/models' && method === 'GET') {
      return jsonResponse({ models: modelCatalog });
    }
    if (url.pathname === '/v1/settings/ai' && method === 'GET')
      return jsonResponse({
        settings: {
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
    if (url.pathname === '/v1/assets' && method === 'GET') return jsonResponse({ assets });
    if (url.pathname.endsWith('/derivatives/thumbnail') && method === 'GET')
      return new Response('synthetic-thumbnail', {
        headers: {
          'content-type': 'image/jpeg',
          'x-original-width': '3840',
          'x-original-height': '2160',
        },
      });
    if (url.pathname.endsWith('/access-url') && method === 'POST')
      return jsonResponse({
        url: `${url.pathname.replace('/access-url', '/content')}?access_token=synthetic-unit`,
      });
    if (url.pathname === '/v1/projects' && method === 'GET') {
      return jsonResponse({ projects: workspaceProjects });
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

/** 测试环境浮层会重复使用 test-id；由真实确认按钮定位窗口，仍校验弹窗和范围文案。 */
async function findClearCanvasConfirmation() {
  const button = await screen.findByRole('button', { name: '确认清空' });
  const dialog = button.closest('[role="dialog"]') as HTMLElement;
  expect(dialog).toHaveTextContent('清空画布');
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
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

/** 从默认收起的资源抽屉添加测试图片；先悬停展开，不绕过隐藏控件命中限制。 */
async function addReferenceAsset(user: Awaited<ReturnType<typeof renderCanvas>>['user']) {
  const panel = screen.getByRole('complementary', { name: '项目资源' });
  await user.hover(panel);
  await user.click(within(panel).getByRole('button', { name: '添加 reference.png 到画布' }));
  await user.unhover(panel);
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

/** 真实 Ant Design 浮层增加挂载开销；单例多步业务回归仍逐项断言，限时只在本套件放宽。 */
describe('画布编辑器交互', { timeout: 15_000 }, () => {
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
    let thumbnailSerial = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => `blob:canvas-thumbnail-${++thumbnailSerial}`),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    clipboardText = '';
    canvas = structuredClone(emptyCanvas);
    projectRuns = [];
    workspaceProjects = [project];
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
    clearImageThumbnailCache();
    if (originalCreateObjectURL)
      Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
    else Reflect.deleteProperty(URL, 'createObjectURL');
    if (originalRevokeObjectURL)
      Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
    else Reflect.deleteProperty(URL, 'revokeObjectURL');
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

  it('新节点优先继承项目默认的分组模型，不复制旧模型参数', async () => {
    projectModelDefaults = {
      image: { modelAlias: 'image-plain-model', credentialId: modelCredentialId },
    };
    globalModelDefaults = {
      image: { modelAlias: 'image-edit-model', credentialId: modelCredentialId },
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
    expect(created.data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(canvas.nodes.find((node) => node.id === 'old-image')!.data.createdAt).toBeUndefined();
    expect(created.data.modelAlias).toBe('image-plain-model');
    expect(created.data.credentialId).toBe(modelCredentialId);
    expect(created.data.parameters).not.toHaveProperty('legacyOption');
  });

  it('未设置项目默认时继承全局类型默认', async () => {
    globalModelDefaults = {
      image: { modelAlias: 'image-plain-model', credentialId: modelCredentialId },
    };
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await waitFor(() => expect(canvas.nodes).toHaveLength(1));
    expect(canvas.nodes[0]!.data.modelAlias).toBe('image-plain-model');
    expect(canvas.nodes[0]!.data.credentialId).toBe(modelCredentialId);
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

  it('已登录账号的空工作台不再显示登录动作', async () => {
    workspaceProjects = [];
    window.history.replaceState(null, '', '/workspace');
    render(createElement(App));

    expect(await screen.findByText('还没有项目')).toBeVisible();
    expect(screen.getByRole('button', { name: '账户菜单' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '新建项目' })).toHaveLength(2);
  });

  it('通过工具栏和资源库创建生成节点与来源节点', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await addReferenceAsset(user);

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

  it('目录仅声明文字提及时，两份图片生成分别保留精确模型、资源提及和输入边', async () => {
    const modelAlias = 'gpt-image-2.5-sunburst';
    const reference = {
      ...assets[0]!,
      latestVersion: 1,
      contentUrl: '/v1/assets/asset-reference/versions/1/content',
    };
    const originalFetch = fetchMock.getMockImplementation()!;
    const submittedCanvases = new Map<string, CanvasDocument>();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === '/v1/assets') return jsonResponse({ assets: [reference] });
      if (path === '/v1/models') {
        return jsonResponse({
          models: [
            {
              id: modelAlias,
              name: modelAlias,
              mediaTypes: ['image'],
              capabilities: { mentionMediaTypes: ['text'] },
              group: 'default',
              credentialId: modelCredentialId,
            },
          ],
        });
      }
      const match = path.match(/\/nodes\/([^/]+)\/runs$/);
      if (match && init?.method === 'POST') {
        submittedCanvases.set(decodeURIComponent(match[1]!), structuredClone(canvas));
      }
      return originalFetch(input, init);
    });
    const { user } = await renderCanvas();
    await addReferenceAsset(user);
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    const source = findNodeByLabel('reference.png')!;
    const root = findNodeByLabel('图片生成节点')!;
    const sourceId = source.getAttribute('data-id')!;
    const rootId = root.getAttribute('data-id')!;
    await user.click(handleFor(source, 'output:image'));
    await user.click(handleFor(root, 'input:content'));
    await user.click(root);
    const editor = screen.getByLabelText('图片生成节点生成设置');
    await user.click(within(editor).getByRole('combobox', { name: /^模型：/ }));
    await user.click(screen.getByRole('option', { name: /gpt-image-2\.5-sunburst/ }));
    await user.type(within(editor).getByRole('textbox', { name: '提示词' }), 'Use @ref');
    await user.click(screen.getByRole('option', { name: /reference.png/ }));
    await user.click(within(editor).getByRole('combobox', { name: /^生成数量：/ }));
    await user.click(
      within(await screen.findByRole('listbox', { name: '生成数量选项' })).getByRole('option', {
        name: '2份',
      }),
    );
    expect(nodeRunRequestCounts.size).toBe(0);
    await user.click(within(editor).getByRole('button', { name: '生成' }));
    await screen.findByText('已完成 2 份生成');
    expect(flowNodes()).toHaveLength(3);
    expect([...nodeRunRequestCounts.values()]).toEqual([1, 1]);
    expect(submittedCanvases.size).toBe(2);
    const promptDocument = lastNodeRunBody(rootId).promptDocument;
    expect(promptDocument).toMatchObject({
      version: 1,
      blocks: [
        { type: 'text', text: 'Use ' },
        {
          type: 'mention',
          mentionId: expect.any(String),
          assetId: 'asset-reference',
          assetVersion: 1,
          label: 'reference.png',
          mediaType: 'image',
        },
      ],
    });
    for (const [nodeId, savedCanvas] of submittedCanvases) {
      expect(lastNodeRunBody(nodeId)).toMatchObject({
        projectId: project.id,
        modelAlias,
        credentialId: modelCredentialId,
        promptDocument,
        parameters: { prompt: runPromptOf(rootId) },
      });
      expect(lastNodeRunBody(nodeId).parameters).not.toHaveProperty('generationCount');
      expect(savedCanvas.nodes.find((node) => node.id === nodeId)?.data).toMatchObject({
        modelAlias,
        promptDocument,
      });
      expect(savedCanvas.nodes.find((node) => node.id === sourceId)?.data).toMatchObject({
        assetId: reference.id,
        contentUrl: reference.contentUrl,
        mimeType: reference.mimeType,
      });
      expect(savedCanvas.edges.filter((edge) => edge.targetNodeId === nodeId)).toEqual([
        expect.objectContaining({
          sourceNodeId: sourceId,
          sourceHandle: 'output:image',
          targetHandle: 'input:content',
          order: 0,
        }),
      ]);
    }
    expect(within(editor).getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it.each(['video_edit', 'video_extend'] as const)(
    '添加提示词参考素材后保留 %s 模式与参数',
    async (videoMode) => {
      canvas.nodes = [
        {
          id: 'video-reference-mode',
          type: 'video',
          position: { x: 0, y: 0 },
          data: {
            label: '视频参考模式',
            mediaType: 'video',
            mode: 'generate',
            videoMode,
            modelAlias: 'doubao-seedance-2-5-260628',
            parameters: { duration: videoMode === 'video_edit' ? -1 : 8, aspectRatio: 'adaptive' },
          },
        },
      ];
      const { user } = await renderCanvas();
      await user.click(findNodeByLabel('视频参考模式')!);
      const editor = screen.getByLabelText('视频参考模式生成设置');
      await user.type(within(editor).getByRole('textbox', { name: '提示词' }), 'Use @ref');
      await user.click(screen.getByRole('option', { name: /reference.png/ }));
      await waitFor(() => {
        expect(
          canvas.nodes[0]?.data.promptDocument?.blocks.some((block) => block.type === 'mention'),
        ).toBe(true);
        expect(canvas.nodes[0]?.data.videoMode).toBe(videoMode);
        expect(canvas.nodes[0]?.data.parameters?.aspectRatio).toBe('adaptive');
      });
    },
  );

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
    await user.click(await screen.findByRole('option', { name: '高' }));
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

  it('数量为 3 时分别运行并保存卡牌归属，展开状态可以持久化', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const editor = await fillSelectedPrompt(user, 'Create three independent drafts.');
    const quantity = within(editor).getByRole('combobox', { name: /^生成数量：/ });
    expect(quantity).toHaveAccessibleName('生成数量：1份');
    await user.click(quantity);
    await user.click(
      within(await screen.findByRole('listbox', { name: '生成数量选项' })).getByRole('option', {
        name: '3份',
      }),
    );
    expect(quantity).toHaveAccessibleName('生成数量：3份');
    await user.click(within(editor).getByRole('button', { name: '生成' }));
    await screen.findByText('已完成 3 份生成');
    expect(flowNodes()).toHaveLength(3);
    expect(nodeRunRequestCounts.size).toBe(3);
    expect([...nodeRunRequestCounts.values()]).toEqual([1, 1, 1]);
    const root = canvas.nodes.find((node) => node.data.generationBatch?.index === 0)!;
    expect(root.data.generationCount).toBe(3);
    expect(root.data.generationBatchExpanded).toBe(false);
    for (const node of canvas.nodes) {
      expect(node.data.generationBatch?.rootNodeId).toBe(root.id);
      expect(runPromptOf(node.id)).toBe('Create three independent drafts.');
      expect(lastNodeRunBody(node.id).parameters).not.toHaveProperty('generationCount');
    }
    await user.click(screen.getByRole('button', { name: /展开.*结果/ }));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() =>
      expect(canvas.nodes.find((node) => node.id === root.id)?.data.generationBatchExpanded).toBe(
        true,
      ),
    );
    expect(within(editor).getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it.each(['断网', 'HTTP 400'] as const)(
    '批量提交%s后停止后续 POST，保留已提交结果且不自动重试',
    async (failure) => {
      const { user } = await renderCanvas();
      await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
      const editor = await fillSelectedPrompt(user, 'Create independent drafts.');
      await user.click(within(editor).getByRole('combobox', { name: /^生成数量：/ }));
      await user.click(
        within(await screen.findByRole('listbox', { name: '生成数量选项' })).getByRole('option', {
          name: '3份',
        }),
      );
      const originalFetch = fetchMock.getMockImplementation()!;
      let attempts = 0;
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).match(/\/nodes\/[^/]+\/runs$/) && init?.method === 'POST') {
          attempts += 1;
          if (attempts === 2) {
            if (failure === '断网') throw new TypeError('Network disconnected');
            return jsonResponse({ error: '输入参数不合法' }, 400);
          }
        }
        return originalFetch(input, init);
      });
      await user.click(within(editor).getByRole('button', { name: '生成' }));
      await screen.findByText(/已完成 1\/3 份.*已停止后续提交/);
      expect(attempts).toBe(2);
      expect(nodeRunRequestCounts.size).toBe(1);
      expect(flowNodes()).toHaveLength(3);
      expect(within(editor).getByRole('button', { name: '生成' })).toBeEnabled();
    },
  );

  it('批量首份请求等待期间撤销新增节点，不再提交已移除的后续份数', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const editor = await fillSelectedPrompt(user, 'Create independent drafts.');
    await user.click(within(editor).getByRole('combobox', { name: /^生成数量：/ }));
    await user.click(
      within(await screen.findByRole('listbox', { name: '生成数量选项' })).getByRole('option', {
        name: '3份',
      }),
    );
    const originalFetch = fetchMock.getMockImplementation()!;
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let attempts = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).match(/\/nodes\/[^/]+\/runs$/) && init?.method === 'POST') {
        attempts += 1;
        if (attempts === 1) await firstRequest;
      }
      return originalFetch(input, init);
    });
    await user.click(within(editor).getByRole('button', { name: '生成' }));
    await waitFor(() => expect(attempts).toBe(1));
    expect(flowNodes()).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: '画布空白' }));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(flowNodes()).toHaveLength(1));
    await act(async () => {
      releaseFirst();
    });
    await screen.findByText(/已完成 1\/3 份.*生成节点已移除/);
    expect(attempts).toBe(1);
    expect(nodeRunRequestCounts.size).toBe(1);
    expect(flowNodes()).toHaveLength(1);
  });

  it('批量首份请求等待期间删除首节点，保留兄弟节点但停止后续提交', async () => {
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const editor = await fillSelectedPrompt(user, 'Create independent drafts.');
    await user.click(within(editor).getByRole('combobox', { name: /^生成数量：/ }));
    await user.click(
      within(await screen.findByRole('listbox', { name: '生成数量选项' })).getByRole('option', {
        name: '3份',
      }),
    );
    const originalFetch = fetchMock.getMockImplementation()!;
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let attempts = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      if (String(input).match(/\/nodes\/[^/]+\/runs$/) && init?.method === 'POST') {
        attempts += 1;
        if (attempts === 1) await firstResponse;
      }
      return response;
    });
    await user.click(within(editor).getByRole('button', { name: '生成' }));
    await waitFor(() => expect(attempts).toBe(1));
    const root = canvas.nodes.find((node) => node.data.generationBatch?.index === 0)!;
    expect(flowNodes()).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: '删除节点：文字生成节点' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    await act(async () => {
      releaseFirst();
    });
    await screen.findByText(/已完成 1\/3 份.*生成节点已移除/);
    expect(attempts).toBe(1);
    expect(nodeRunRequestCounts.size).toBe(1);
    expect(nodeRunRequestCounts.get(root.id)).toBe(1);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/v1/runs/run_${root.id}_0`)),
    ).toBe(true);
    expect(flowNodes()).toHaveLength(2);
    expect(findNodeByLabel('文字生成节点')).toBeUndefined();
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
      expect(image?.getAttribute('src')).toMatch(/^blob:canvas-thumbnail-/);
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes(
            `/v1/assets/${imageRun.result?.asset?.assetId}/versions/${imageRun.result?.asset?.version}/derivatives/thumbnail`,
          ),
        ),
      ).toBe(true);
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
    await waitFor(() => expect(within(info).getByText('12秒')).toBeVisible());
    expect(within(info).queryByText('3秒')).not.toBeInTheDocument();
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

    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: '主题、画布背景与连接线' })).toBeVisible(),
    );
    await user.click(screen.getByRole('tab', { name: '背景' }));
    expect(screen.getByRole('button', { name: '点' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '空白' }));
    expect(window.localStorage.getItem('multimodal-canvas:background')).toBe('blank');
  });

  it('来源节点不再打开右侧属性栏，并支持直接重命名', async () => {
    const { user } = await renderCanvas();

    await addReferenceAsset(user);
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
    const group = await screen.findByRole('button', { name: /^组 1/ });
    expect(group).toBeTruthy();
    expect(within(group).getByText('0')).toBeTruthy();

    // 建两个节点并框选成组。
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const imageNode = findNodeByLabel('图片生成节点')!;
    const textNode = findNodeByLabel('文字生成节点')!;
    await user.click(imageNode);
    await user.keyboard('{Control>}a{/Control}');
    await user.click(screen.getByRole('button', { name: '新建分组' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^组 2/ })).toBeInTheDocument());
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);

    // 组只表达布局：不进入运行图，也不改变节点数量。
    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    expect(textNode).toBeTruthy();

    // 解散后成员与连线保留，区域移除。
    await user.click(screen.getByRole('button', { name: /^组 2/ }));
    await user.click(screen.getByLabelText('解散组 组 2'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^组 2/ })).not.toBeInTheDocument(),
    );
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

    // 等待 Dropdown 完成挂载再激活，取消后节点与组都不变。
    await waitFor(() => expect(clearCanvasItem).toBeVisible());
    await user.click(clearCanvasItem);
    const dialog = await findClearCanvasConfirmation();
    expect(dialog).toHaveTextContent('1 个节点');
    expect(dialog).toHaveTextContent('1 个分组');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '清空画布' })).not.toBeInTheDocument(),
    );
    expect(flowNodes()).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^组 1/ })).toBeInTheDocument();
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
    await user.click(await screen.findByRole('menuitem', { name: /清空画布/ }));
    const dialog = await findClearCanvasConfirmation();
    expect(dialog).toHaveTextContent('当前有 1 个在途任务');
    expect(dialog).toHaveTextContent('清空后仍会继续执行，结果保留在资源库');
    await user.click(within(dialog).getByRole('button', { name: '确认清空' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(0));
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
      await user.click(clearEmpty);
      const initialDialog = await screen.findByRole('dialog', { name: '清空空节点' });
      expect(initialDialog).toHaveTextContent('2 个空节点');
      // 模拟确认等待期间回填的内容或运行事件，提交后必须重读最新候选。
      act(() => {
        if (change === '提示词')
          fireEvent.change(prompt, { target: { value: '确认期间新增的内容' } });
        else emitRun(running);
      });
      await user.click(within(initialDialog).getByRole('button', { name: '确认清理' }));
      const updatedContent = await screen.findByText(/节点状态已变化，请确认更新后的范围/);
      const updatedDialog = updatedContent.closest('[role="dialog"]') as HTMLElement;
      expect(updatedDialog).toHaveTextContent('1 个空节点');
      expect(flowNodes()).toHaveLength(2);
      await user.click(within(updatedDialog).getByRole('button', { name: '确认清理' }));
      await waitFor(() => expect(flowNodes()).toHaveLength(1));
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
    await user.click(
      within(await screen.findByRole('dialog', { name: '节点信息' })).getByRole('button', {
        name: /查看生成提示词/,
      }),
    );
    await waitFor(() => expect(screen.getByRole('dialog', { name: '生成提示词' })).toBeVisible());
    // 模拟弹窗存续期间触发画布操作，验证它随所属节点删除而关闭。
    fireEvent.click(clearButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: /清空空节点/, hidden: true }));
    const confirm = await screen.findByRole('dialog', { name: '清空空节点' });
    await user.click(within(confirm).getByRole('button', { name: '确认清理' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(0));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '生成提示词' })).not.toBeInTheDocument(),
    );
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
    await user.click(
      within(await screen.findByRole('dialog', { name: '节点信息' })).getByRole('button', {
        name: /查看生成提示词/,
      }),
    );
    await waitFor(() => expect(resolvePrompt).toBeDefined());
    await waitFor(() => expect(screen.getByRole('dialog', { name: '生成提示词' })).toBeVisible());
    fireEvent.click(clearButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: /清空画布/, hidden: true }));
    const confirm = await findClearCanvasConfirmation();
    await user.click(within(confirm).getByRole('button', { name: '确认清空' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(0));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '生成提示词' })).not.toBeInTheDocument(),
    );
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

    await user.click(clearEmptyItem);
    const dialog = await screen.findByRole('dialog', { name: '清空空节点' });
    await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(1));
    expect(findNodeByLabel('文字生成节点')).toBeTruthy();
    expect(findNodeByLabel('图片生成节点')).toBeUndefined();

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

    await user.click(clearEmptyItem);
    const dialog = await screen.findByRole('dialog', { name: '清空空节点' });
    await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
    await waitFor(() => expect(flowNodes()).toHaveLength(1));
    expect(findNodeByLabel('文字生成节点')).toBeTruthy();
    expect(findNodeByLabel('图片生成节点')).toBeUndefined();
    expect(findNodeByLabel('音频生成节点')).toBeUndefined();
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
    await user.click(
      within(await screen.findByRole('dialog', { name: '节点信息' })).getByRole('button', {
        name: /查看生成提示词/,
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: '生成提示词' });
    await waitFor(() => expect(within(dialog).getByText('写一段开头。')).toBeVisible());
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
    await user.click(
      within(await screen.findByRole('dialog', { name: '节点信息' })).getByRole('button', {
        name: /查看生成提示词/,
      }),
    );
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
    expect(
      screen.getAllByRole('alert').some((item) => item.textContent?.includes('不能创建循环依赖')),
    ).toBe(true);
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

  it.each(['2026-09-01T08:00:00.000Z', undefined])(
    '来源节点原地生成保留创建时间及缺失状态：%s',
    async (createdAt) => {
      const source: CanvasDocument['nodes'][number] = {
        id: 'source-created-at',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: '来源图片',
          mediaType: 'image',
          mode: 'source',
          assetId: assets[0].id,
          contentUrl: assets[0].contentUrl,
          mimeType: assets[0].mimeType,
          prompt: 'Draw a new landscape.',
          modelAlias: 'image-plain-model',
          credentialId: modelCredentialId,
          ...(createdAt !== undefined ? { createdAt } : {}),
        },
      };
      canvas.nodes = [source];
      const { user } = await renderCanvas();
      await user.click(findNodeByLabel(source.data.label)!);
      const editor = screen.getByRole('region', { name: '来源图片生成设置' });
      await user.click(within(editor).getByRole('button', { name: '生成' }));
      await waitFor(() => expect(nodeRunRequestCounts.get(source.id)).toBe(1));

      expect(canvas.nodes).toHaveLength(1);
      expect(canvas.nodes[0]).toMatchObject({ id: source.id, data: { mode: 'generate' } });
      if (createdAt === undefined) {
        expect(canvas.nodes[0].data).not.toHaveProperty('createdAt');
      } else {
        expect(canvas.nodes[0].data.createdAt).toBe(createdAt);
      }
    },
  );

  it('只有回显图片的节点才显示“修改图片”入口', async () => {
    const { user } = await renderCanvas();

    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    const empty = findNodeByLabel('图片生成节点')!;
    expect(within(empty).queryByRole('button', { name: /^修改图片/ })).toBeNull();

    await addReferenceAsset(user);
    const source = findNodeByLabel('reference.png')!;
    expect(within(source).getByRole('button', { name: '修改图片：reference.png' })).toBeVisible();
    expect(within(source).getByRole('button', { name: '修改图片：reference.png' })).toBeEnabled();
    await user.click(source);
    const sourceEditor = await screen.findByRole('region', { name: /生成设置$/ });
    expect(within(sourceEditor).getByRole('button', { name: '生成' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '新建文字生成节点' }));
    const textNode = findNodeByLabel('文字生成节点')!;
    expect(within(textNode).queryByRole('button', { name: /^修改图片/ })).toBeNull();
  });

  it('无提示词时修改图片只创建引用草稿，不发运行请求', async () => {
    const { user } = await renderCanvas();
    await addReferenceAsset(user);
    const source = findNodeByLabel('reference.png')!;
    const button = within(source).getByRole('button', { name: '修改图片：reference.png' });
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(flowNodes()).toHaveLength(2));
    expect(screen.getByTestId('flow-edge')).toHaveAttribute(
      'data-target-handle',
      'input:imageEdit',
    );
    const editor = await screen.findByRole('region', { name: /图片修改设置$/ });
    expect(within(editor).getByRole('textbox', { name: '图片修改要求' })).toHaveValue('');
    expect(within(editor).getByRole('button', { name: '生成' })).toBeDisabled();
    expect(nodeRunRequestCounts.size).toBe(0);
  });

  it('卸载画布后取消所有分叉节点的延迟层级更新', async () => {
    const { user } = await renderCanvas();
    await addReferenceAsset(user);
    const source = findNodeByLabel('reference.png')!;
    const edit = within(source).getByRole('button', { name: '修改图片：reference.png' });
    const timerWindow: Window = window;
    const scheduled = vi.spyOn(timerWindow, 'setTimeout');
    const cancelled = vi.spyOn(timerWindow, 'clearTimeout');
    try {
      fireEvent.click(edit);
      fireEvent.click(edit);
      expect(flowNodes()).toHaveLength(3);
      const forkTimers = scheduled.mock.calls.flatMap(([, delay], index) =>
        delay === 4000 ? [scheduled.mock.results[index]!.value] : [],
      );
      expect(forkTimers).toHaveLength(2);
      cancelled.mockClear();
      cleanup();
      for (const timer of forkTimers) expect(cancelled).toHaveBeenCalledWith(timer);
    } finally {
      cleanup();
      scheduled.mockRestore();
      cancelled.mockRestore();
    }
  });

  it('修改图片不复制提示词或自动运行，手动生成后结果只写入新节点', async () => {
    const { user } = await renderCanvas();

    await addReferenceAsset(user);
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

    expect(nodeRunRequestCounts.size).toBe(0);
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
    const editor = screen.getByRole('region', { name: /图片修改设置$/ });
    await user.type(within(editor).getByRole('textbox', { name: '图片修改要求' }), '改成水彩风格');
    await user.click(within(editor).getByRole('button', { name: '生成' }));
    await waitFor(() => expect(nodeRunRequestCounts.get(createdId)).toBe(1));
    expect(nodeRunRequestCounts.get(sourceId)).toBeUndefined();
    expect(runPromptOf(createdId)).toContain('改成水彩风格');
    expect(runPromptOf(createdId)).not.toContain('换成夜景');
    expect(canvas.nodes.find((node) => node.id === sourceId)).toMatchObject({
      position: originalSource.position,
      data: originalSource.data,
    });
  });

  it('图片修改节点与来源边可以整体撤销和重做', async () => {
    const { user } = await renderCanvas();

    await addReferenceAsset(user);
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

    await addReferenceAsset(user);
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
    await addReferenceAsset(user);
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
    const editor = screen.getByRole('region', { name: `${editLabel}图片修改设置` });
    const prompt = within(editor).getByRole('textbox', { name: '图片修改要求' });
    expect(prompt).toHaveValue('');
    expect(nodeRunRequestCounts.size).toBe(0);
    expect(within(editor).getByRole('button', { name: '生成' })).toBeDisabled();
    await user.type(prompt, '第一次尝试');
    await user.click(within(editor).getByRole('button', { name: '生成' }));
    await waitFor(() => expect(nodeRunRequestCounts.get(editNodeId)).toBe(1));
    expect(runPromptOf(editNodeId)).toContain('第一次尝试');
    await waitFor(() => {
      const node = findNodeByLabel(editLabel);
      expect(within(node!).getByRole('alert')).toHaveTextContent('供应商拒绝：内容不合规');
    });

    expect(prompt).toHaveValue('第一次尝试');
    expect(within(editor).getByRole('button', { name: '生成' })).toBeEnabled();
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
    await addReferenceAsset(user);
    const source = findNodeByLabel('reference.png')!;
    await user.click(source);
    await fillSelectedPrompt(user, '换成夜景');
    await user.click(within(source).getByRole('button', { name: '修改图片：reference.png' }));
    const editor = await screen.findByRole('region', { name: /图片修改设置$/ });
    expect(within(editor).getByRole('textbox', { name: '图片修改要求' })).toHaveValue('');
    expect(nodeRunRequestCounts.size).toBe(0);

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
    await addReferenceAsset(user);
    const source = findNodeByLabel('reference.png')!;
    await user.click(source);
    const editor = await fillSelectedPrompt(user, '换成夜景');
    expect(within(editor).getByRole('button', { name: '新节点' })).toBeDisabled();

    await user.click(within(editor).getByRole('combobox', { name: /^模型：/ }));
    await user.click(screen.getByRole('option', { name: /普通图片模型/ }));
    expect(within(editor).getByRole('combobox', { name: /^模型：/ })).toHaveAttribute(
      'aria-label',
      '模型：普通图片模型 · default',
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

  it.each([true, false])('图片新节点清理旧参考图并检查剩余文字要求：%s', async (hasText) => {
    const parent: CanvasDocument['nodes'][number] = {
      id: 'image-with-reference',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        label: '图片结果',
        mediaType: 'image',
        mode: 'generate',
        modelAlias: 'image-edit-model',
        credentialId: modelCredentialId,
        promptDocument: {
          version: 1,
          blocks: [
            { type: 'text', text: hasText ? 'Keep the composition. ' : '' },
            {
              type: 'mention',
              mentionId: 'old-reference',
              assetId: 'asset-reference',
              assetVersion: 1,
              label: 'reference.png',
              mediaType: 'image',
            },
          ],
        },
      },
    };
    canvas.nodes = [parent];
    projectRuns = [createRestoredRun(parent)];
    const originalDocument = structuredClone(parent.data.promptDocument);
    const { user } = await renderCanvas();
    await user.click(findNodeByLabel('图片结果')!);
    const editor = screen.getByRole('region', { name: '图片结果生成设置' });
    const fork = within(editor).getByRole('button', { name: '新节点' });
    await waitFor(() => expect(fork).toBeEnabled());
    await user.click(fork);
    if (hasText) {
      const child = await waitFor(() => {
        const node = canvas.nodes.find((candidate) => candidate.id !== parent.id);
        expect(node).toBeDefined();
        expect(nodeRunRequestCounts.get(node!.id)).toBe(1);
        return node!;
      });
      expect(lastNodeRunBody(child.id).promptDocument).toEqual({
        version: 1,
        blocks: [{ type: 'text', text: 'Keep the composition. ' }],
      });
      expect(runPromptOf(child.id)).toBe('Keep the composition.');
      expect(child.data.imageEditSource).toMatchObject({
        sourceNodeId: parent.id,
        assetId: `asset-restored-${parent.id}`,
        version: 1,
      });
      expect(child.data.promptDocument).toBeUndefined();
      expect(canvas.edges).toHaveLength(1);
      expect(canvas.edges[0]).toMatchObject({ sourceNodeId: parent.id, targetNodeId: child.id });
    } else {
      await screen.findByText('请先填写图片修改要求，再生成到新节点');
      expect(flowNodes()).toHaveLength(1);
      expect(nodeRunRequestCounts.size).toBe(0);
    }
    expect(canvas.nodes.find((node) => node.id === parent.id)?.data.promptDocument).toEqual(
      originalDocument,
    );
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
  it('空画布的整理节点按钮不可用', async () => {
    await renderCanvas();
    expect(screen.getByRole('button', { name: '整理节点' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '整理画布节点' })).toBeDisabled();
  });

  it('整理节点保留尺寸、内容和连线，重复整理不新增历史，并可一次撤销重做', async () => {
    canvas.nodes = [
      {
        id: 'arrange-a',
        type: 'text',
        position: { x: 900, y: 700 },
        width: 200,
        height: 210,
        data: {
          label: '文字 A',
          mediaType: 'text',
          mode: 'generate',
          enabled: true,
          prompt: '保留 A',
          mimeType: 'application/octet-stream',
        },
      },
      {
        id: 'arrange-b',
        type: 'text',
        position: { x: 100, y: 90 },
        width: 270,
        height: 320,
        data: {
          label: '文字 B',
          mediaType: 'text',
          mode: 'generate',
          enabled: true,
          prompt: '保留 B',
          mimeType: 'application/octet-stream',
        },
      },
      {
        id: 'arrange-c',
        type: 'text',
        position: { x: 440, y: 480 },
        width: 360,
        height: 240,
        data: {
          label: '文字 C',
          mediaType: 'text',
          mode: 'generate',
          enabled: true,
          prompt: '保留 C',
          mimeType: 'application/octet-stream',
        },
      },
    ];
    canvas.edges = [
      {
        id: 'arrange-edge',
        sourceNodeId: 'arrange-a',
        targetNodeId: 'arrange-b',
        sourceHandle: 'output:text',
        targetHandle: 'input:content',
        order: 0,
      },
    ];
    const original = structuredClone(canvas);
    const { user } = await renderCanvas();
    const arrange = screen.getByRole('button', { name: '整理节点' });
    await waitFor(() => expect(arrange).toBeEnabled());
    expect(arrange).toHaveAttribute('title', expect.stringContaining('每行最多 5 个'));
    expect(arrange).toHaveAttribute('title', expect.stringContaining('相连节点按层级排列'));
    await user.click(screen.getByRole('button', { name: '整理画布节点' }));
    await waitFor(() =>
      expect(canvas.nodes.map((node) => node.position)).not.toEqual(
        original.nodes.map((node) => node.position),
      ),
    );
    const positions = canvas.nodes.map((node) => node.position);
    const [parent, child, isolated] = canvas.nodes;
    expect(isolated!.position).toEqual({ x: 100, y: 90 });
    expect(child!.position.x).toBe(parent!.position.x + parent!.width! + 60);
    expect(parent!.position.y + parent!.height! / 2).toBeCloseTo(
      child!.position.y + child!.height! / 2,
      6,
    );
    expect(Math.min(parent!.position.y, child!.position.y)).toBe(
      isolated!.position.y + isolated!.height! + 80,
    );
    expect(canvas.nodes.map(({ position: _position, ...node }) => node)).toEqual(
      original.nodes.map(({ position: _position, ...node }) => node),
    );
    expect(canvas.edges).toEqual(original.edges);
    await user.click(arrange);
    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(canvas.nodes).toEqual(original.nodes));
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '重做' }));
    await waitFor(() => expect(canvas.nodes.map((node) => node.position)).toEqual(positions));
    expect(canvas.edges).toEqual(original.edges);
    expect(nodeRunRequestCounts.size).toBe(0);
  });
  it('整理简单分叉时父节点在第一列并垂直居中于第二列子节点', async () => {
    // 原数组不是拓扑顺序，父节点高度也不同，居中需要比较外框中心而不是顶部坐标。
    canvas.nodes = ['center-3', 'center-1', 'center-2'].map((id, index) => ({
      id,
      type: 'text' as const,
      position: { x: 900 - index * 150, y: 500 + index * 230 },
      width: 220,
      height: id === 'center-1' ? 200 : 160,
      data: {
        label: id,
        mediaType: 'text' as const,
        mode: 'generate' as const,
        enabled: true,
        prompt: '保留父子居中内容',
        mimeType: 'text/plain',
      },
    }));
    canvas.edges = ['center-2', 'center-3'].map((targetNodeId, index) => ({
      id: 'center-edge-' + index,
      sourceNodeId: 'center-1',
      targetNodeId,
      sourceHandle: 'output:text',
      targetHandle: 'input:content',
      order: 0,
    }));
    const original = structuredClone(canvas);
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '整理节点' }));
    await waitFor(() =>
      expect(canvas.nodes.map((node) => node.position)).not.toEqual(
        original.nodes.map((node) => node.position),
      ),
    );
    const nodeById = new Map(canvas.nodes.map((node) => [node.id, node]));
    const parent = nodeById.get('center-1')!;
    const children = [nodeById.get('center-3')!, nodeById.get('center-2')!];
    expect(children[0]!.position.x).toBe(parent.position.x + parent.width! + 60);
    expect(children[1]!.position.x).toBe(children[0]!.position.x);
    expect(children[1]!.position.y).toBe(children[0]!.position.y + children[0]!.height! + 80);
    expect(parent.position.y + parent.height! / 2).toBeCloseTo(
      children.reduce((total, child) => total + child.position.y + child.height! / 2, 0) / 2,
      6,
    );
    expect(canvas.nodes.map(({ position: _position, ...node }) => node)).toEqual(
      original.nodes.map(({ position: _position, ...node }) => node),
    );
    expect(canvas.edges).toEqual(original.edges);
    expect(canvas.groups ?? []).toEqual(original.groups ?? []);
    expect(nodeRunRequestCounts.size).toBe(0);
  });
  it('整理十一层连接链持续向右递进，不按独立节点的五列上限折行', async () => {
    const ids = Array.from({ length: 11 }, (_, index) => 'long-chain-' + index);
    canvas.nodes = [...ids].reverse().map((id, index) => ({
      id,
      type: 'text' as const,
      position: { x: 100 + index * 150, y: 90 + index * 100 },
      width: 220,
      height: 160,
      data: {
        label: id,
        mediaType: 'text' as const,
        mode: 'generate' as const,
        enabled: true,
        prompt: '保留长链内容',
        mimeType: 'text/plain',
      },
    }));
    canvas.edges = ids.slice(1).map((targetNodeId, index) => ({
      id: 'long-edge-' + index,
      sourceNodeId: ids[index]!,
      targetNodeId,
      sourceHandle: 'output:text',
      targetHandle: 'input:content',
      order: 0,
    }));
    const original = structuredClone(canvas);
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '整理节点' }));
    await waitFor(() =>
      expect(canvas.nodes.map((node) => node.position)).not.toEqual(
        original.nodes.map((node) => node.position),
      ),
    );
    const nodeById = new Map(canvas.nodes.map((node) => [node.id, node]));
    for (const edge of canvas.edges) {
      const source = nodeById.get(edge.sourceNodeId)!;
      const target = nodeById.get(edge.targetNodeId)!;
      expect(target.position.x).toBe(source.position.x + source.width! + 60);
      expect(target.position.y).toBe(source.position.y);
    }
    expect(canvas.nodes.map(({ position: _position, ...node }) => node)).toEqual(
      original.nodes.map(({ position: _position, ...node }) => node),
    );
    expect(canvas.edges).toEqual(original.edges);
    expect(canvas.groups ?? []).toEqual(original.groups ?? []);
    expect(nodeRunRequestCounts.size).toBe(0);
  });
  it('整理分叉与合流从左到右递进，同层节点处于同一列', async () => {
    // 原节点顺序与依赖顺序不同，且合流节点的两个父节点分属不同层级。
    canvas.nodes = ['merge', 'deep-child', 'right', 'root', 'left', 'tail'].map((id, index) => ({
      id,
      type: 'text' as const,
      position: { x: 100 + index * 150, y: 90 + index * 100 },
      width: 220,
      height: 160,
      data: {
        label: id,
        mediaType: 'text' as const,
        mode: 'generate' as const,
        enabled: true,
        prompt: '保留分叉合流内容',
        mimeType: 'text/plain',
      },
    }));
    canvas.edges = [
      ['root', 'left'],
      ['root', 'right'],
      ['left', 'deep-child'],
      ['right', 'merge'],
      ['deep-child', 'merge'],
      ['merge', 'tail'],
    ].map(([sourceNodeId, targetNodeId], index, edges) => ({
      id: 'branch-edge-' + index,
      sourceNodeId: sourceNodeId!,
      targetNodeId: targetNodeId!,
      sourceHandle: 'output:text',
      targetHandle: 'input:content',
      // 所有边使用 input:content；按目标节点分别从 0 编号，与保存合同一致。
      order: edges.slice(0, index).filter(([, target]) => target === targetNodeId).length,
    }));
    const original = structuredClone(canvas);
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '整理节点' }));
    await waitFor(() =>
      expect(canvas.nodes.map((node) => node.position)).not.toEqual(
        original.nodes.map((node) => node.position),
      ),
    );
    const nodeById = new Map(canvas.nodes.map((node) => [node.id, node]));
    expect(nodeById.get('right')!.position.x).toBe(nodeById.get('left')!.position.x);
    for (const edge of canvas.edges) {
      const source = nodeById.get(edge.sourceNodeId)!;
      const target = nodeById.get(edge.targetNodeId)!;
      expect(target.position.x).toBeGreaterThanOrEqual(source.position.x + source.width! + 60);
    }
    expect(canvas.nodes.map(({ position: _position, ...node }) => node)).toEqual(
      original.nodes.map(({ position: _position, ...node }) => node),
    );
    expect(canvas.edges).toEqual(original.edges);
    expect(canvas.groups ?? []).toEqual(original.groups ?? []);
    expect(nodeRunRequestCounts.size).toBe(0);
  });
  it('组内节点无法容纳时明确提示并保留原布局，不新增撤销历史', async () => {
    canvas.nodes = ['wide-a', 'wide-b'].map((id, index) => ({
      id,
      type: 'text' as const,
      position: { x: index * 300, y: 200 },
      width: 10_000,
      height: 220,
      data: {
        label: id,
        mediaType: 'text' as const,
        mode: 'generate' as const,
        enabled: true,
        prompt: '保留原布局',
      },
    }));
    canvas.groups = [
      {
        id: 'wide-group',
        name: '超宽节点组',
        position: { x: 0, y: 0 },
        width: 10_000,
        height: 600,
        nodeIds: ['wide-a', 'wide-b'],
      },
    ];
    const original = structuredClone(canvas);
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '整理节点' }));
    expect(await screen.findByText(/分组“超宽节点组”无法/)).toBeVisible();
    expect(canvas).toEqual(original);
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
    expect(nodeRunRequestCounts.size).toBe(0);
  });
  it('胶囊整理保留跨组连线和手动归属，组框包含成员且可一起撤销重做', async () => {
    canvas.nodes = [
      'free-a',
      'member-a',
      'free-b',
      'free-isolated',
      'member-isolated',
      'member-b',
      'other-a',
      'other-isolated',
      'other-b',
      'free-c',
      'member-c',
      'other-c',
    ].map((id, index) => ({
      id,
      type: 'text' as const,
      position: { x: 900 - index * 30, y: 500 + index * 230 },
      width: 220,
      height: 160,
      data: {
        label: id,
        mediaType: 'text' as const,
        mode: 'generate' as const,
        enabled: true,
        prompt: '保留内容',
        mimeType: 'text/plain',
      },
    }));
    canvas.groups = [
      {
        id: 'keep-group',
        name: '保留分组',
        position: { x: 100, y: 650 },
        width: 800,
        height: 800,
        nodeIds: ['member-c', 'member-b', 'member-isolated', 'member-a'],
      },
      {
        id: 'other-group',
        name: '另一分组',
        position: { x: 100, y: 2000 },
        width: 800,
        height: 900,
        nodeIds: ['other-c', 'other-b', 'other-isolated', 'other-a'],
      },
    ];
    // 后出现的分量先提供边；A 分量经另一组跨接，层级按全局有向关系计算。
    canvas.edges = [
      ['member-c', 'free-c'],
      ['other-c', 'member-c'],
      ['other-b', 'other-a'],
      ['free-b', 'other-a'],
      ['other-a', 'free-a'],
      ['member-b', 'free-b'],
      ['free-a', 'member-a'],
    ].map(([sourceNodeId, targetNodeId], index, edges) => ({
      id: 'group-edge-' + index,
      sourceNodeId: sourceNodeId!,
      targetNodeId: targetNodeId!,
      sourceHandle: 'output:text',
      targetHandle: 'input:content',
      // 所有边使用 input:content；按目标节点分别从 0 编号，与保存合同一致。
      order: edges.slice(0, index).filter(([, target]) => target === targetNodeId).length,
    }));
    const original = structuredClone(canvas);
    const { user } = await renderCanvas();
    await user.click(screen.getByRole('button', { name: '整理画布节点' }));
    await waitFor(() =>
      expect(canvas.groups?.[0]?.position).not.toEqual(original.groups?.[0]?.position),
    );
    const arranged = structuredClone(canvas);
    expect(arranged.groups).toHaveLength(2);
    expect(arranged.groups?.map(({ id, name, nodeIds }) => ({ id, name, nodeIds }))).toEqual(
      original.groups?.map(({ id, name, nodeIds }) => ({ id, name, nodeIds })),
    );
    const nodeById = new Map(arranged.nodes.map((node) => [node.id, node]));
    for (const group of arranged.groups!) {
      for (const id of group.nodeIds) {
        const node = nodeById.get(id)!;
        expect(node.position.x).toBeGreaterThanOrEqual(group.position.x + 24);
        expect(node.position.y).toBeGreaterThanOrEqual(group.position.y + 24);
        expect(node.position.x + node.width! + 24).toBeLessThanOrEqual(
          group.position.x + group.width,
        );
        expect(node.position.y + node.height! + 24).toBeLessThanOrEqual(
          group.position.y + group.height,
        );
      }
    }
    expect(arranged.nodes.map(({ position: _position, ...node }) => node)).toEqual(
      original.nodes.map(({ position: _position, ...node }) => node),
    );
    expect(arranged.edges).toEqual(original.edges);
    await user.click(screen.getByRole('button', { name: '整理节点' }));
    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(canvas.groups).toEqual(original.groups));
    expect(canvas.nodes).toEqual(original.nodes);
    expect(canvas.edges).toEqual(original.edges);
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '重做' }));
    await waitFor(() => expect(canvas.groups).toEqual(arranged.groups));
    expect(canvas.nodes).toEqual(arranged.nodes);
    expect(canvas.edges).toEqual(original.edges);
    expect(nodeRunRequestCounts.size).toBe(0);
  });
});
