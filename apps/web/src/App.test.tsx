import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@multimodal-canvas/ui';
import type { ComponentProps, DragEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPromptDocument, resolveImageOutputParameters } from '@multimodal-canvas/domain';
import type {
  Asset,
  CanvasDocument,
  PromptDocument,
  RunRecord,
  RunSnapshot,
} from '@multimodal-canvas/domain';
import type { WorkflowCanvasProps } from './workspace/WorkflowCanvas';
import type { ResourcePanel } from './workspace/ResourcePanel';

/** 只替换重型画布视图，保留 App 的真实状态、请求与 Ant Design 交互。 */
const view = vi.hoisted(() => ({
  canvas: null as WorkflowCanvasProps | null,
  resource: null as ComponentProps<typeof ResourcePanel> | null,
}));
vi.mock('./workspace/WorkflowCanvas', () => ({
  WorkflowCanvas: (props: WorkflowCanvasProps) => {
    view.canvas = props;
    return (
      <section aria-label="测试画布">
        <Button type="button" onClick={props.onClearCanvas}>
          测试清空画布
        </Button>
        <Button type="button" onClick={props.onClearEmptyNodes}>
          测试清空空节点
        </Button>
        <Button type="button" onClick={props.onUndoCanvas}>
          测试撤销
        </Button>
        <output aria-label="画布节点">{props.nodes.map((node) => node.id).join(',')}</output>
      </section>
    );
  },
}));
vi.mock('./workspace/ResourcePanel', () => ({
  ResourcePanel: (props: ComponentProps<typeof ResourcePanel>) => {
    view.resource = props;
    return (
      <section aria-label="测试资源库">
        <Button type="button" onClick={props.onToggleCollapsed}>
          切换测试资源栏
        </Button>
        {props.assets.map((asset) => (
          <Button type="button" key={asset.id} onClick={() => props.onRenameAsset(asset)}>
            重命名 {asset.name}
          </Button>
        ))}
      </section>
    );
  },
}));

import { App } from './App';
import * as auth from './auth-client';
import * as exports from './export-utils';
import {
  RESOURCE_PANEL_DRAWER_VERSION_KEY,
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from './state/workspace-preferences';

/** 测试只使用合成项目、账户和资源，不访问真实服务。 */
const project = {
  id: 'modal-project',
  name: '弹窗测试项目',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const secondProject = { ...project, id: 'second-project', name: '第二个项目' };
const asset: Asset = {
  id: 'modal-asset',
  name: '原资源名称',
  mediaType: 'image',
  mimeType: 'image/png',
  contentUrl: '/v1/assets/modal-asset/content',
  sizeBytes: 1024,
  status: 'ready',
  tags: [],
};
const session = {
  user: {
    id: 'modal-user',
    role: 'admin' as const,
    email: 'modal@example.test',
    createdAt: project.createdAt,
  },
};

/** 构造无提示词、无资源的生成节点；额外字段按测试显式加入。 */
function emptyNode(id: string): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'text',
    position: { x: 100, y: 100 },
    data: { label: id, mode: 'generate', mediaType: 'text', parameters: {} },
  };
}

/** 构造图片生成节点，测试重试时只替换当前节点配置而不替换节点身份。 */
function imageNode(
  id: string,
  modelAlias: string,
  credentialId?: string,
): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'image',
    position: { x: 100, y: 100 },
    data: {
      label: '图片生成节点',
      mode: 'generate',
      mediaType: 'image',
      modelAlias,
      ...(credentialId ? { credentialId } : {}),
      parameters: { prompt: '重新生成图片' },
    },
  };
}

/** 构造视频生成节点，用于验证原任务的只读资源恢复。 */
function videoNode(id: string, modelAlias: string): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'video',
    position: { x: 100, y: 100 },
    data: {
      label: '视频生成节点',
      mode: 'generate',
      mediaType: 'video',
      modelAlias,
      prompt: '生成视频',
      parameters: { prompt: '生成视频' },
    },
  };
}

/** 构造图片节点重试使用的完整冻结快照，避免测试夹具绕过运行合同。 */
function imageRunSnapshot(canvasRevision: number, modelAlias: string): RunSnapshot {
  return {
    projectId: project.id,
    canvasRevision,
    targetNodeId: 'image-node',
    modelAlias,
    parameters: {},
    submittedAt: '2026-09-25T00:00:00.000Z',
    nodes: [imageNode('image-node', modelAlias)],
    edges: [],
    inputs: [],
  };
}

/** 为运行恢复和重试轮询提供最小的前端运行记录。 */
function runRecord(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'run-image-failed',
    projectId: project.id,
    targetNodeId: 'image-node',
    status: 'failed',
    progress: 100,
    attempt: 1,
    provider: 'newapi',
    modelAlias: 'image-old',
    snapshot: imageRunSnapshot(1, 'image-old'),
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:01:00.000Z',
    error: '上游请求失败',
    ...overrides,
  };
}
/** 保持视频 Run 的目标节点与冻结快照一致。 */
function videoRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return runRecord({
    id: 'run-video-failed',
    targetNodeId: 'video-node',
    modelAlias: 'video-old',
    snapshot: {
      ...imageRunSnapshot(1, 'video-old'),
      targetNodeId: 'video-node',
      nodes: [videoNode('video-node', 'video-old')],
    },
    ...overrides,
  });
}
/** 返回 JSON 响应并保留 HTTP 状态，供 App 的真实错误处理消费。 */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 人工释放请求，精确覆盖提交、轮询和画布保存的并发窗口。 */
function pendingResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 拦截每个节点的一次创建与独立轮询；调用方决定何时到达终态。 */
function pendingNodeRuns(nodeIds: string[], delayCreation = false) {
  const api = fetchMock.getMockImplementation()!;
  const posts: string[] = [];
  const creates = new Map(nodeIds.map((id) => [id, pendingResponse()]));
  const polls = new Map(nodeIds.map((id) => [id, pendingResponse()]));
  const runs = new Map(
    nodeIds.map((id) => [
      id,
      runRecord({
        id: 'run-' + id,
        targetNodeId: id,
        status: 'running',
        progress: 10,
        error: undefined,
      }),
    ]),
  );
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost:3000').pathname;
    for (const [id, run] of runs) {
      if (path === '/v1/nodes/' + id + '/runs' && init?.method === 'POST') {
        posts.push(id);
        return delayCreation ? creates.get(id)!.promise : Promise.resolve(json({ run }, 202));
      }
      if (path === '/v1/runs/' + run.id && (!init?.method || init.method === 'GET')) {
        return polls.get(id)!.promise;
      }
    }
    return api(input, init);
  });
  return { posts, creates, polls, runs };
}
let canvas: CanvasDocument;
/** 每个用例独立设置资源列表，拖拽回归使用 50 个合成资源。 */
let resourceAssets: Asset[];
let fetchMock: ReturnType<typeof vi.fn>;
let renameFailure: string | null;
let createFailure: string | null;
let saveFailure: string | null;
let projectRuns: RunRecord[];
let currentRun: RunRecord | null;

/** 按真实 URL 和方法提供最小后端合同；未声明请求直接使测试失败。 */
function installApi() {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost:3000',
    );
    const method = init?.method ?? 'GET';
    const name = url.pathname;
    if (name === '/v1/models') return json({ models: [] });
    if (name === '/v1/settings/ai') return json({ settings: { defaultModels: {} } });
    if (name.endsWith('/models/defaults')) return json({ defaults: {} });
    if (name === '/v1/prompt-skills') return json({ skills: [] });
    if (name === '/v1/assets' && method === 'GET') return json({ assets: resourceAssets });
    if (name === '/v1/assets/' + asset.id && method === 'PATCH') {
      if (renameFailure) return json({ error: renameFailure }, 500);
      const updated = {
        ...resourceAssets.find((entry) => entry.id === asset.id)!,
        ...JSON.parse(String(init?.body)),
      };
      resourceAssets = resourceAssets.map((entry) => (entry.id === asset.id ? updated : entry));
      return json({ asset: updated });
    }
    if (name === '/v1/projects' && method === 'GET')
      return json({ projects: [project, secondProject] });
    if (name === '/v1/projects' && method === 'POST') {
      if (createFailure) return json({ error: createFailure }, 500);
      return json({ project: { ...secondProject, ...JSON.parse(String(init?.body)) } });
    }
    if (name === '/v1/projects/' + project.id) return json({ project });
    if (name === '/v1/projects/' + secondProject.id) return json({ project: secondProject });
    if (name.endsWith('/canvas') && method === 'GET') return json({ canvas });
    if (name.endsWith('/canvas') && method === 'PATCH') {
      if (saveFailure) return json({ error: saveFailure }, 500);
      canvas = { ...JSON.parse(String(init?.body)), revision: canvas.revision + 1 };
      return json({ canvas });
    }
    if (name.endsWith('/runs') && method === 'GET') return json({ runs: projectRuns });
    if (name === '/v1/nodes/image-node/runs' && method === 'POST') {
      if (!currentRun) throw new Error('测试未准备新的运行记录');
      return json({ run: currentRun }, 202);
    }
    if (name === '/v1/runs/' + currentRun?.id && method === 'GET') {
      if (!currentRun) throw new Error('测试未准备新的运行记录');
      return json({ run: currentRun });
    }
    if (name.includes('/export/'))
      return new Response('export-fixture', {
        headers: { 'content-disposition': 'attachment; filename="workflow.json"' },
      });
    throw new Error('未声明的测试请求：' + method + ' ' + name);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** 等待画布和运行状态回填完毕，不使用空测试或固定时间替代加载断言。 */
async function renderCanvas(expectedEmptyNodes = 2) {
  const result = render(<App />);
  await screen.findByRole('region', { name: '测试画布' });
  await waitFor(() => expect(screen.getByRole('button', { name: '打开项目集合' })).toBeEnabled());
  await waitFor(() => expect(view.canvas?.clearCounts?.emptyNodes).toBe(expectedEmptyNodes));
  return result;
}

/** 获取实际的资源 PATCH 调用，取消和空值必须不产生写请求。 */
function renameRequests() {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).endsWith('/v1/assets/' + asset.id) && init?.method === 'PATCH',
  );
}

/** 模拟异步回填；通过实际画布更新接口提交，确保 App refs 和历史一起更新。 */
function fillNode(id: string, prompt: string) {
  const node = view.canvas!.nodes.find((node) => node.id === id)!;
  act(() =>
    view.canvas!.onNodesChange([
      { type: 'replace', id, item: { ...node, data: { ...node.data, prompt } } },
    ]),
  );
}

/** 找到重新确认的活动窗口，避免把关闭动画中的上一轮窗口当成当前范围。 */
async function changedConfirmation(kind: '画布' | '节点') {
  const content = await screen.findByText(new RegExp(kind + '状态已变化，请确认更新后的范围'));
  return content.closest('[role="dialog"]') as HTMLElement;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/projects/' + project.id);
  window.localStorage.clear();
  auth.clearAuthSession();
  auth.persistAuthSession(session);
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  vi.spyOn(auth, 'fetchCurrentSession').mockResolvedValue(session);
  vi.spyOn(auth, 'openAuthEventStream').mockResolvedValue(undefined);
  vi.spyOn(exports, 'downloadProjectExport').mockImplementation(() => {});
  canvas = { revision: 1, nodes: [emptyNode('empty-one'), emptyNode('empty-two')], edges: [] };
  resourceAssets = [asset];
  view.canvas = null;
  view.resource = null;
  renameFailure = null;
  createFailure = null;
  saveFailure = null;
  projectRuns = [];
  currentRun = null;
  installApi();
});
afterEach(() => {
  cleanup();
  auth.clearAuthSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
});

describe('App 资源抽屉集成', () => {
  it('50 个资源与已选节点连续 20 次位置更新保持侧栏和编辑回调稳定', async () => {
    resourceAssets = Array.from({ length: 50 }, (_, index) => ({
      ...asset,
      id: 'drag-asset-' + index,
    }));
    await renderCanvas();
    await waitFor(() => expect(view.resource!.assets).toHaveLength(50));
    const resourceChanges: Partial<Record<keyof ComponentProps<typeof ResourcePanel>, number>> = {};
    act(() => view.canvas!.onNodeSelect(view.canvas!.nodes[0]));
    await waitFor(() => expect(view.canvas!.skillLibraryLoading).toBe(false));
    expect(view.canvas!.selectedNode?.id).toBe('empty-one');
    const canvasChanges = {
      onRunNode: 0,
      // 复刻入口经 Context 传给全部节点，位置帧不能更换引用而广播重渲。
      onRecreateVideo: 0,
      onOpenSkillWorkbench: 0,
      onRetryNode: 0,
      onRecoverNode: 0,
      onNodeLabelChange: 0,
      onNodeEnabledChange: 0,
      onPromptDocumentChange: 0,
      onConnectedResourceRename: 0,
      onResourceRemove: 0,
      onPromptSkillChange: 0,
      onUploadResource: 0,
      onParametersChange: 0,
      onGenerationCountChange: 0,
      onBatchExpandedChange: 0,
      onCompletionActionChange: 0,
      onVideoModeChange: 0,
      onCompletionTargetNodeIdChange: 0,
      onModelChange: 0,
      onInferenceStrengthChange: 0,
      nodeContentHandlers: 0,
    };
    const expectedCanvasChanges = { ...canvasChanges };
    let previousResource = view.resource!;
    let previousCanvas = view.canvas!;

    for (let frame = 1; frame <= 20; frame += 1) {
      const position = { x: 100 + frame, y: 100 + frame * 2 };
      act(() =>
        view.canvas!.onNodesChange([
          { type: 'position', id: 'empty-one', position, dragging: true },
        ]),
      );
      expect(view.canvas!.nodes).not.toBe(previousCanvas.nodes);
      expect(view.canvas!.nodes.find((node) => node.id === 'empty-one')!.position).toEqual(
        position,
      );
      for (const key of Object.keys(previousResource) as Array<keyof typeof previousResource>) {
        if (!Object.is(previousResource[key], view.resource![key])) {
          resourceChanges[key] = (resourceChanges[key] ?? 0) + 1;
        }
      }
      for (const key of Object.keys(canvasChanges) as Array<keyof typeof canvasChanges>) {
        if (previousCanvas[key] !== view.canvas![key]) canvasChanges[key] += 1;
      }
      previousResource = view.resource!;
      previousCanvas = view.canvas!;
    }

    expect.soft(resourceChanges).toEqual({});
    // onRetryNode 的依赖链包含 runNode，避免仅稳定外层回调却忽略运行入口变化。
    expect(canvasChanges).toEqual(expectedCanvasChanges);
  });

  it('稳定的编辑回调保留最新节点数据，切换或移除选中节点后使用有效身份', async () => {
    canvas.nodes = ['first', 'second'].map((id) => ({
      ...emptyNode(id),
      type: 'video',
      data: { ...emptyNode(id).data, mediaType: 'video' },
    }));
    await renderCanvas(2);
    act(() => view.canvas!.onNodeSelect(view.canvas!.nodes[0]));
    const firstActions = view.canvas!;
    act(() => {
      view.canvas!.onNodesChange([
        { type: 'position', id: 'first', position: { x: 760, y: 420 }, dragging: true },
      ]);
    });
    act(() => view.canvas!.onNodeLabelChange!('first', '实时标题'));
    act(() => {
      firstActions.onModelChange({ modelAlias: 'fixture-video' });
      firstActions.onParametersChange!({ duration: 8 });
      firstActions.onPromptDocumentChange!({
        version: 1,
        blocks: [{ type: 'text', text: 'Latest prompt.' }],
      });
      firstActions.onPromptSkillChange!('current-skill');
      firstActions.onGenerationCountChange!(3);
      firstActions.onVideoModeChange!('first_frame');
      firstActions.onCompletionActionChange!('fill_designated_image_node');
      firstActions.onCompletionTargetNodeIdChange!('image-target');
      firstActions.onInferenceStrengthChange('medium');
    });
    expect(view.canvas!.nodes[0]).toMatchObject({
      position: { x: 760, y: 420 },
      data: {
        label: '实时标题',
        modelAlias: 'fixture-video',
        parameters: { duration: 8 },
        prompt: 'Latest prompt.',
        promptSkillId: 'current-skill',
        generationCount: 3,
        videoMode: 'first_frame',
        completionAction: 'fill_designated_image_node',
        completionTargetNodeId: 'image-target',
        inferenceStrength: 'medium',
      },
    });
    act(() => view.canvas!.onNodeSelect(view.canvas!.nodes[1]));
    expect(view.canvas!.onParametersChange).not.toBe(firstActions.onParametersChange);
    act(() => view.canvas!.onParametersChange!({ duration: 5 }));
    expect(view.canvas!.nodes[1].data.parameters).toEqual({ duration: 5 });
    expect(view.canvas!.nodes[0].data.parameters).toEqual({ duration: 8 });

    act(() => view.canvas!.onNodesChange([{ type: 'remove', id: 'second' }]));
    expect(view.canvas!.selectedNode).toBeNull();
    const remainingNodes = view.canvas!.nodes;
    act(() => view.canvas!.onParametersChange!({ duration: 99 }));
    expect(view.canvas!.nodes).toBe(remainingNodes);
    expect(() => view.canvas!.onConnectedResourceRename!(asset.id, '不存在的目标')).toThrow(
      '目标节点已不存在',
    );
  });

  it('资源回调在归档恢复后使用最新资产和画布中心，新增节点后更新默认落点', async () => {
    canvas.nodes = [
      {
        ...imageNode('source', 'image-model'),
        data: { label: '关联源', mediaType: 'image', mode: 'source', assetId: asset.id },
      },
      {
        ...emptyNode('target'),
        type: 'video',
        data: { ...emptyNode('target').data, mediaType: 'video', videoMode: 'first_frame' },
      },
    ];
    canvas.edges = [
      {
        id: 'source-target',
        sourceNodeId: 'source',
        targetNodeId: 'target',
        sourceHandle: 'output:image',
        targetHandle: 'input:firstFrame',
        order: 0,
      },
    ];
    const api = fetchMock.getMockImplementation()!;
    let currentAsset = asset;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === '/v1/assets/' + asset.id + '/archive' && init?.method === 'POST') {
        currentAsset = { ...currentAsset, status: 'archived' };
        resourceAssets = [currentAsset];
        return json({ asset: currentAsset });
      }
      if (path === '/v1/assets/' + asset.id + '/restore' && init?.method === 'POST') {
        currentAsset = { ...currentAsset, name: '最新资源', status: 'ready', latestVersion: 2 };
        resourceAssets = [currentAsset];
        return json({ asset: currentAsset });
      }
      if (path === '/v1/assets/' + asset.id && init?.method === 'DELETE') {
        resourceAssets = [];
        return new Response(null, { status: 204 });
      }
      return api(input, init);
    });
    await renderCanvas(0);
    act(() => view.canvas!.onNodeSelect(view.canvas!.nodes[1]));
    const previousRename = view.canvas!.onConnectedResourceRename;
    const actions = view.resource!;
    act(() => {
      actions.onQueryChange('资源');
      actions.onFilterChange('image');
      actions.onToggleArchived();
      actions.onArchiveAsset(actions.assets[0]);
    });
    await waitFor(() => expect(view.resource!.assets[0]?.status).toBe('archived'));
    expect(view.resource).toMatchObject({
      query: '资源',
      activeFilter: 'image',
      showArchived: true,
    });
    act(() => {
      actions.onToggleArchived();
      actions.onArchiveAsset(view.resource!.assets[0]);
    });
    await waitFor(() => expect(view.resource!.assets[0]?.name).toBe('最新资源'));
    expect(view.resource!.showArchived).toBe(false);
    expect(view.canvas!.onConnectedResourceRename).not.toBe(previousRename);
    act(() => view.canvas!.onConnectedResourceRename!(asset.id, '最新引用'));
    expect(view.canvas!.nodes[1].data.resourceRefs).toEqual([
      expect.objectContaining({ assetId: asset.id, name: '最新引用', assetVersion: 2 }),
    ]);
    act(() => actions.onAddAsset(view.resource!.assets[0]));
    expect(view.canvas!.nodes.at(-1)).toMatchObject({
      position: { x: 540, y: 80 },
      data: { label: '最新资源', assetId: asset.id },
    });
    expect(view.resource!.onAddAsset).not.toBe(actions.onAddAsset);
    act(() => view.resource!.onAddAsset(view.resource!.assets[0]));
    expect(view.canvas!.nodes.at(-1)!.position).toEqual({ x: 80, y: 290 });
    const addAtCenter = view.resource!.onAddAsset;
    act(() => view.canvas!.onCanvasCenterChange!({ x: 900, y: 600 }));
    act(() => addAtCenter(view.resource!.assets[0]));
    expect(view.canvas!.nodes.at(-1)!.position).toEqual({ x: 900, y: 600 });
    act(() => actions.onDeleteAsset!(view.resource!.assets[0]));
    await waitFor(() => expect(view.resource!.assets).toHaveLength(0));
  });

  it.each(['选择文件', '拖入文件'] as const)(
    '%s 回调持续同步上传状态、进度和新增资源',
    async (entry) => {
      const api = fetchMock.getMockImplementation()!;
      const complete = pendingResponse();
      const uploadedAsset = { ...asset, id: 'uploaded-asset', name: 'uploaded.png' };
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), 'http://localhost:3000').pathname;
        if (path === '/v1/assets/uploads/init')
          return json({
            uploadId: 'test-upload',
            uploadUrl: '/test-upload',
            completeUrl: '/v1/assets/uploads/complete',
          });
        if (path === '/v1/assets/uploads/complete') return complete.promise;
        return api(input, init);
      });
      const request = {
        open: vi.fn(),
        send: vi.fn(),
        setRequestHeader: vi.fn(),
        status: 200,
        upload: { onprogress: null as ((event: ProgressEvent) => void) | null },
        onload: null as (() => void) | null,
      };
      vi.stubGlobal(
        'XMLHttpRequest',
        vi.fn(function () {
          return request;
        }),
      );
      await renderCanvas();
      const file = new File(['image'], 'uploaded.png', { type: 'image/png' });
      Object.defineProperty(file, 'arrayBuffer', {
        value: async () => new Uint8Array([1, 2, 3]).buffer,
      });
      const preventDefault = vi.fn();
      act(() => {
        if (entry === '选择文件') view.resource!.onFilesSelected([file]);
        else
          view.resource!.onDrop({
            preventDefault,
            dataTransfer: { files: [file] },
          } as unknown as DragEvent);
      });
      expect(view.resource).toMatchObject({ isUploading: true, uploadProgress: 0 });
      await waitFor(() => expect(request.send).toHaveBeenCalledTimes(1));
      act(() =>
        request.upload.onprogress!({
          lengthComputable: true,
          loaded: 1,
          total: 2,
        } as ProgressEvent),
      );
      expect(view.resource!.uploadProgress).toBe(45);
      await act(async () => request.onload!());
      expect(view.resource).toMatchObject({ isUploading: true, uploadProgress: 90 });
      resourceAssets = [uploadedAsset, ...resourceAssets];
      await act(async () => complete.resolve(json({ asset: uploadedAsset })));
      await waitFor(() =>
        expect(view.resource).toMatchObject({ isUploading: false, uploadProgress: null }),
      );
      expect(view.resource!.assets.map((entry) => entry.id)).toEqual(['uploaded-asset', asset.id]);
      expect(view.canvas!.nodes).toHaveLength(2);
      expect(preventDefault).toHaveBeenCalledTimes(entry === '拖入文件' ? 1 : 0);
    },
  );

  it('鉴权身份变化重建资源状态，退出后卸载资源库', async () => {
    await renderCanvas();
    const previous = view.resource!;
    act(() => previous.onQueryChange('旧账户搜索'));
    resourceAssets = [{ ...asset, id: 'new-account-asset', name: '新账户资源' }];
    act(() =>
      auth.persistAuthSession({ ...session, user: { ...session.user, id: 'new-account' } }),
    );
    await waitFor(() => expect(view.resource!.assets[0]?.id).toBe('new-account-asset'));
    expect(view.resource!.query).toBe('');
    expect(view.resource!.onAddAsset).not.toBe(previous.onAddAsset);
    act(() => auth.clearAuthSession());
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '测试资源库' })).not.toBeInTheDocument(),
    );
  });

  it('默认紧凑且工作区不保留折叠侧栏列，显式切换仍由偏好状态控制', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    const workspace = screen.getByRole('region', { name: '测试资源库' }).parentElement!;
    expect(workspace).toHaveClass('workspace');
    expect(workspace).not.toHaveClass('resource-panel-collapsed');
    expect(view.resource!.collapsed).toBe(true);
    await user.click(screen.getByRole('button', { name: '切换测试资源栏' }));
    expect(view.resource!.collapsed).toBe(false);
    expect(useWorkspacePreferences.getState().isResourcePanelCollapsed).toBe(false);
    expect(window.localStorage.getItem(RESOURCE_PANEL_DRAWER_VERSION_KEY)).toBe('1');
    await user.click(screen.getByRole('button', { name: '切换测试资源栏' }));
    expect(view.resource!.collapsed).toBe(true);
    expect(workspace).not.toHaveClass('resource-panel-collapsed');
  });

  it('重命名弹窗的开关传回资源抽屉，取消后解锁且没有资源写入', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    expect(view.resource!.isRenameDialogOpen).toBe(false);
    await user.click(screen.getByRole('button', { name: '重命名 原资源名称' }));
    const dialog = await screen.findByRole('dialog', { name: '重命名资源' });
    expect(view.resource!.isRenameDialogOpen).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: /^取\s*消$/ }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(view.resource!.isRenameDialogOpen).toBe(false);
    expect(view.resource!.collapsed).toBe(true);
    expect(renameRequests()).toHaveLength(0);
  });
});

describe('App 组件库迁移', () => {
  it('A 未结束时 B 可提交，重渲染前后连点 A 都只创建一次运行', async () => {
    canvas.nodes = [imageNode('a', 'image-model'), imageNode('b', 'image-model')];
    const pending = pendingNodeRuns(['a', 'b']);
    await renderCanvas(2);
    const [a, b] = view.canvas!.nodes;
    act(() => {
      view.canvas!.onNodeSelect(a);
      view.canvas!.onRunNode(a);
      view.canvas!.onRunNode(a);
      view.canvas!.onRunNode(a, 'newNode');
    });
    await waitFor(() => expect(pending.posts).toEqual(['a']));
    expect(view.canvas!.busyNodeIds).toEqual(new Set(['a']));
    expect(screen.getByRole('button', { name: '停止' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '打开命令面板' }));
    expect(screen.getByRole('option', { name: /停止「图片生成节点」/ })).toBeEnabled();
    expect(screen.queryByRole('option', { name: /运行「图片生成节点」/ })).not.toBeInTheDocument();
    act(() => view.canvas!.onNodeSelect(b));
    expect(screen.getByRole('option', { name: /运行「图片生成节点」/ })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '运行' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '运行' }));
    act(() => {
      view.canvas!.onRunNode(a);
      view.canvas!.onRunNode(b);
    });
    await waitFor(() => expect(pending.posts).toEqual(['a', 'b']));
    expect(view.canvas!.busyNodeIds).toEqual(new Set(['a', 'b']));
    await act(async () =>
      pending.polls.get('b')!.resolve(
        json({
          run: { ...pending.runs.get('b'), status: 'succeeded', progress: 100 },
        }),
      ),
    );
    await waitFor(() => expect(view.canvas!.busyNodeIds).toEqual(new Set(['a'])));
    await act(async () =>
      pending.polls.get('a')!.resolve(
        json({
          run: { ...pending.runs.get('a'), status: 'succeeded', progress: 100 },
        }),
      ),
    );
    await waitFor(() => expect(view.canvas!.busyNodeIds?.size).toBe(0));
    expect(pending.posts).toEqual(['a', 'b']);
  });

  it.each(['queued', 'preparing', 'running', 'processing', 'cancel_requested'] as const)(
    '恢复 %s 任务后显示停止入口，直接回调和重试不能重复提交且不阻断其它节点',
    async (status) => {
      canvas.nodes = [imageNode('a', 'image-model'), imageNode('b', 'image-model')];
      projectRuns = [runRecord({ id: 'restored-a', targetNodeId: 'a', status })];
      const pending = pendingNodeRuns(['b']);
      await renderCanvas(1);
      const [a, b] = view.canvas!.nodes;
      expect(view.canvas!.busyNodeIds).toEqual(new Set(['a']));
      act(() => {
        view.canvas!.onNodeSelect(a);
        view.canvas!.onRunNode(a);
        view.canvas!.onRunNode(a, 'newNode');
      });
      await act(async () => {
        await view.canvas!.onRetryNode(a.id);
      });
      const stop = screen.getByRole('button', {
        name: status === 'cancel_requested' ? '停止中' : '停止',
      });
      if (status === 'cancel_requested') expect(stop).toBeDisabled();
      else expect(stop).toBeEnabled();
      act(() => view.canvas!.onNodeSelect(b));
      expect(screen.getByRole('button', { name: '运行' })).toBeEnabled();
      act(() => view.canvas!.onRunNode(b));
      await waitFor(() => expect(pending.posts).toEqual(['b']));
      const creates = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(creates).toHaveLength(1);
      await act(async () =>
        pending.polls.get('b')!.resolve(
          json({
            run: { ...pending.runs.get('b'), status: 'succeeded', progress: 100 },
          }),
        ),
      );
      await waitFor(() => expect(view.canvas!.busyNodeIds).toEqual(new Set(['a'])));
    },
  );

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    '旧 %s Run 不算忙碌，新的 POST pending 期间同步阻断 A 连点但不阻断 B',
    async (status) => {
      canvas.nodes = [imageNode('a', 'image-model'), imageNode('b', 'image-model')];
      projectRuns = [
        runRecord({
          id: 'old-a',
          targetNodeId: 'a',
          status,
          createdAt: '2026-09-24T00:00:00.000Z',
          updatedAt: '2026-09-24T00:01:00.000Z',
        }),
      ];
      const pending = pendingNodeRuns(['a', 'b'], true);
      await renderCanvas(2);
      await waitFor(() => expect(view.canvas!.nodes[0].data.runStatus).toBe(status));
      expect(view.canvas!.busyNodeIds?.size).toBe(0);
      const [a, b] = view.canvas!.nodes;
      act(() => {
        view.canvas!.onNodeSelect(a);
        view.canvas!.onRunNode(a);
        view.canvas!.onRunNode(a);
        view.canvas!.onRunNode(a, 'newNode');
      });
      await waitFor(() => expect(pending.posts).toEqual(['a']));
      expect(view.canvas!.nodes[0].data.runStatus).toBe(status);
      expect(view.canvas!.busyNodeIds).toEqual(new Set(['a']));
      expect(screen.getByRole('button', { name: '停止' })).toBeEnabled();
      act(() => {
        view.canvas!.onRunNode(a);
        view.canvas!.onNodeSelect(b);
        view.canvas!.onRunNode(b);
      });
      await act(async () => view.canvas!.onRetryNode(a.id));
      await waitFor(() => expect(pending.posts).toEqual(['a', 'b']));
      expect(view.canvas!.nodes).toHaveLength(2);
      await act(async () => {
        pending.creates.get('b')!.resolve(json({ run: pending.runs.get('b') }, 202));
        pending.polls
          .get('b')!
          .resolve(json({ run: { ...pending.runs.get('b'), status: 'succeeded', progress: 100 } }));
      });
      await waitFor(() => expect(view.canvas!.busyNodeIds).toEqual(new Set(['a'])));
      await act(async () =>
        pending.creates.get('a')!.resolve(json({ run: pending.runs.get('a') }, 202)),
      );
      await waitFor(() => expect(view.canvas!.nodes[0].data.runStatus).toBe('running'));
      act(() => view.canvas!.onRunNode(view.canvas!.nodes[0]));
      expect(pending.posts).toEqual(['a', 'b']);
      await act(async () =>
        pending.polls
          .get('a')!
          .resolve(json({ run: { ...pending.runs.get('a'), status: 'succeeded', progress: 100 } })),
      );
      await waitFor(() => expect(view.canvas!.busyNodeIds?.size).toBe(0));
    },
  );

  it('轮询失败不解除服务端仍在运行的节点，不自动重发创建请求', async () => {
    canvas.nodes = [imageNode('a', 'image-model')];
    const pending = pendingNodeRuns(['a']);
    await renderCanvas(1);
    act(() => view.canvas!.onRunNode(view.canvas!.nodes[0]));
    await waitFor(() => expect(pending.posts).toEqual(['a']));
    await act(async () => pending.polls.get('a')!.reject(new Error('运行结果未确认')));
    await screen.findByText('运行结果未确认');
    expect(view.canvas!.busyNodeIds).toEqual(new Set(['a']));
    act(() => view.canvas!.onRunNode(view.canvas!.nodes[0]));
    expect(pending.posts).toEqual(['a']);
  });

  it('批量创建结果不明时停止后续提交，不重发原 POST', async () => {
    const node = imageNode('a', 'image-model');
    canvas.nodes = [{ ...node, data: { ...node.data, generationCount: 3 } }];
    const api = fetchMock.getMockImplementation()!;
    const posts: string[] = [];
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/v1/nodes/') && init?.method === 'POST') {
        posts.push(String(input));
        return Promise.reject(new Error('创建结果 unknown，请先核对运行记录'));
      }
      return api(input, init);
    });
    await renderCanvas(1);
    act(() => {
      view.canvas!.onRunNode(view.canvas!.nodes[0]);
      view.canvas!.onRunNode(view.canvas!.nodes[0]);
    });
    await screen.findByText(/已停止后续提交，请先核对运行记录/);
    expect(posts).toHaveLength(1);
    expect(view.canvas!.nodes).toHaveLength(3);
    expect(view.canvas!.busyNodeIds?.size).toBe(0);
  });

  it('创建响应未返回时立即停止，取得 runId 后只取消一次', async () => {
    canvas.nodes = [imageNode('a', 'image-model')];
    const api = fetchMock.getMockImplementation()!;
    const create = pendingResponse();
    const poll = pendingResponse();
    const run = runRecord({
      id: 'run-stop-pending',
      targetNodeId: 'a',
      status: 'running',
      progress: 10,
      error: undefined,
    });
    let createCalls = 0;
    let cancelCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === '/v1/nodes/a/runs' && init?.method === 'POST') {
        createCalls += 1;
        return create.promise;
      }
      if (path === '/v1/runs/' + run.id + '/cancel' && init?.method === 'POST') {
        cancelCalls += 1;
        return Promise.resolve(json({ run: { ...run, status: 'cancel_requested' } }));
      }
      if (path === '/v1/runs/' + run.id && (!init?.method || init.method === 'GET'))
        return poll.promise;
      return api(input, init);
    });

    await renderCanvas(1);
    act(() => view.canvas!.onRunNode(view.canvas!.nodes[0]));
    await waitFor(() => expect(createCalls).toBe(1));
    await act(async () => view.canvas!.onStopNode?.('a'));
    expect(view.canvas!.nodeRunControlStore?.getSnapshot('a')).toMatchObject({
      stoppable: true,
      stopRequested: true,
    });

    await act(async () => create.resolve(json({ run }, 202)));
    await waitFor(() => expect(cancelCalls).toBe(1));
    await act(async () => view.canvas!.onStopNode?.('a'));
    expect(cancelCalls).toBe(1);
    expect(createCalls).toBe(1);

    await act(async () =>
      poll.resolve(json({ run: { ...run, status: 'cancelled', progress: 10 } })),
    );
    await waitFor(() => expect(view.canvas!.busyNodeIds?.size).toBe(0));
  });

  it('批量停止的取消失败可重试，且不会继续提交剩余创建请求', async () => {
    const node = imageNode('a', 'image-model');
    canvas.nodes = [{ ...node, data: { ...node.data, generationCount: 3 } }];
    const api = fetchMock.getMockImplementation()!;
    const create = pendingResponse();
    const poll = pendingResponse();
    const posts: string[] = [];
    let cancelCalls = 0;
    let createdRun: RunRecord | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      const match = path.match(/^\/v1\/nodes\/([^/]+)\/runs$/);
      if (match && init?.method === 'POST') {
        posts.push(match[1]!);
        return create.promise;
      }
      if (
        createdRun &&
        path === '/v1/runs/' + createdRun.id + '/cancel' &&
        init?.method === 'POST'
      ) {
        cancelCalls += 1;
        return cancelCalls === 1
          ? Promise.resolve(json({ error: '合成取消失败' }, 503))
          : Promise.resolve(json({ run: { ...createdRun, status: 'cancel_requested' } }));
      }
      if (
        createdRun &&
        path === '/v1/runs/' + createdRun.id &&
        (!init?.method || init.method === 'GET')
      )
        return poll.promise;
      return api(input, init);
    });

    await renderCanvas(1);
    act(() => view.canvas!.onRunNode(view.canvas!.nodes[0]));
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () => view.canvas!.onStopNode?.('a'));
    createdRun = runRecord({
      id: 'run-batch-stop-retry',
      targetNodeId: posts[0]!,
      status: 'running',
      progress: 10,
      error: undefined,
    });
    await act(async () => create.resolve(json({ run: createdRun }, 202)));

    await screen.findByText(/合成取消失败；可重试停止/);
    expect(cancelCalls).toBe(1);
    expect(posts).toHaveLength(1);
    expect(view.canvas!.nodeRunControlStore?.getSnapshot('a').stopRequested).toBe(false);

    await act(async () => view.canvas!.onStopNode?.('a'));
    await waitFor(() => expect(cancelCalls).toBe(2));
    expect(posts).toHaveLength(1);
    await act(async () =>
      poll.resolve(json({ run: { ...createdRun, status: 'cancelled', progress: 10 } })),
    );
    await waitFor(() => expect(view.canvas!.busyNodeIds?.size).toBe(0));
  });

  it('账号切换后丢弃迟到的创建响应和原会话停止意图', async () => {
    canvas.nodes = [imageNode('a', 'image-model')];
    const api = fetchMock.getMockImplementation()!;
    const create = pendingResponse();
    const run = runRecord({
      id: 'run-stale-session',
      targetNodeId: 'a',
      status: 'running',
      progress: 10,
      error: undefined,
    });
    let cancelCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === '/v1/nodes/a/runs' && init?.method === 'POST') return create.promise;
      if (path === '/v1/runs/' + run.id + '/cancel' && init?.method === 'POST') {
        cancelCalls += 1;
        return Promise.resolve(json({ run: { ...run, status: 'cancel_requested' } }));
      }
      return api(input, init);
    });

    await renderCanvas(1);
    act(() => view.canvas!.onRunNode(view.canvas!.nodes[0]));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => String(url).endsWith('/v1/nodes/a/runs') && init?.method === 'POST',
        ),
      ).toHaveLength(1),
    );
    await act(async () => view.canvas!.onStopNode?.('a'));
    act(() =>
      auth.persistAuthSession({ ...session, user: { ...session.user, id: 'next-account' } }),
    );
    await waitFor(() =>
      expect(view.canvas!.nodeRunControlStore?.getSnapshot('a').stoppable).toBe(false),
    );

    await act(async () => create.resolve(json({ run }, 202)));
    await waitFor(() => expect(cancelCalls).toBe(0));
    expect(view.canvas!.nodes.find((entry) => entry.id === 'a')?.data.runStatus).toBeUndefined();
    expect(screen.queryByText(/run-stale-session|已请求停止运行/)).not.toBeInTheDocument();
  });

  it('恢复运行的停止请求并发去重，失败后允许重试', async () => {
    canvas.nodes = [imageNode('a', 'image-model')];
    const run = runRecord({ id: 'restored-stop-a', targetNodeId: 'a', status: 'running' });
    projectRuns = [run];
    const api = fetchMock.getMockImplementation()!;
    const cancellation = pendingResponse();
    let cancelCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/runs/restored-stop-a/cancel') && init?.method === 'POST') {
        cancelCalls += 1;
        return cancelCalls === 1
          ? cancellation.promise
          : Promise.resolve(json({ run: { ...run, status: 'cancel_requested' } }));
      }
      return api(input, init);
    });
    await renderCanvas(0);
    await waitFor(() => expect(view.canvas!.nodes[0].data.runStatus).toBe('running'));
    let first: void | Promise<void>;
    let second: void | Promise<void>;
    act(() => {
      first = view.canvas!.onStopNode?.('a');
      second = view.canvas!.onStopNode?.('a');
    });
    expect(cancelCalls).toBe(1);
    expect(view.canvas!.nodeRunControlStore?.getSnapshot('a').stopRequested).toBe(true);
    await act(async () => {
      cancellation.resolve(json({ error: '合成取消失败' }, 503));
      await Promise.all([first, second]);
    });
    expect(view.canvas!.nodeRunControlStore?.getSnapshot('a').stopRequested).toBe(false);
    await act(async () => view.canvas!.onStopNode?.('a'));
    expect(cancelCalls).toBe(2);
    expect(view.canvas!.nodeRunControlStore?.getSnapshot('a').stopRequested).toBe(true);
    await act(async () => view.canvas!.onStopNode?.('a'));
    expect(cancelCalls).toBe(2);
  });

  it('已是 cancel_requested 的恢复运行不重复发送取消请求', async () => {
    canvas.nodes = [imageNode('a', 'image-model')];
    projectRuns = [
      runRecord({ id: 'run-cancel-requested', targetNodeId: 'a', status: 'cancel_requested' }),
    ];
    await renderCanvas(0);
    await waitFor(() => expect(view.canvas!.nodes[0].data.runStatus).toBe('cancel_requested'));

    await act(async () => view.canvas!.onStopNode?.('a'));
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/run-cancel-requested/cancel') && init?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('多个生成等待同一次保存后仍串行保存新修订，不并行 PATCH 或重发生成', async () => {
    canvas.nodes = ['a', 'b', 'c'].map((id) => imageNode(id, 'image-model'));
    const pending = pendingNodeRuns(['a', 'b', 'c'], true);
    const api = fetchMock.getMockImplementation()!;
    const saves: Array<{ gate: ReturnType<typeof pendingResponse>; document: CanvasDocument }> = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/canvas') && init?.method === 'PATCH') {
        const gate = pendingResponse();
        saves.push({ gate, document: JSON.parse(String(init.body)) });
        maximumInFlight = Math.max(maximumInFlight, ++inFlight);
        return gate.promise.finally(() => {
          inFlight -= 1;
        });
      }
      return api(input, init);
    });
    await renderCanvas(3);
    fillNode('a', '第一版');
    act(() => view.canvas!.onRunNode(view.canvas!.nodes[0]));
    await waitFor(() => expect(saves).toHaveLength(1));
    fillNode('b', '保存期间的第二版');
    act(() => {
      view.canvas!.onRunNode(view.canvas!.nodes[1]);
      view.canvas!.onRunNode(view.canvas!.nodes[2]);
    });
    expect(pending.posts).toEqual([]);
    await act(async () =>
      saves[0].gate.resolve(json({ canvas: { ...saves[0].document, revision: 2 } })),
    );
    await waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(2));
    expect(saves).toHaveLength(2);
    expect(maximumInFlight).toBe(1);
    expect(saves[1].document.revision).toBe(2);
    expect(saves[1].document.nodes.find((node) => node.id === 'b')?.data.prompt).toBe(
      '保存期间的第二版',
    );
    await act(async () =>
      saves[1].gate.resolve(json({ canvas: { ...saves[1].document, revision: 3 } })),
    );
    await waitFor(() => expect(pending.posts).toHaveLength(3));
    expect(new Set(pending.posts)).toEqual(new Set(['a', 'b', 'c']));
    await act(async () => {
      for (const [id, gate] of pending.creates) {
        gate.resolve(json({ run: pending.runs.get(id) }, 202));
      }
      for (const [id, gate] of pending.polls) {
        gate.resolve(
          json({ run: { ...pending.runs.get(id), status: 'succeeded', progress: 100 } }),
        );
      }
    });
    await waitFor(() => expect(view.canvas!.busyNodeIds?.size).toBe(0));
    expect(maximumInFlight).toBe(1);
  });

  it('A 上传内容时只锁 A，B 仍可生成且内容失败不会解除 B 的锁', async () => {
    canvas.nodes = [imageNode('a', 'image-model'), imageNode('b', 'image-model')];
    const pending = pendingNodeRuns(['b']);
    const api = fetchMock.getMockImplementation()!;
    const upload = pendingResponse();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/v1/assets/uploads/init') ? upload.promise : api(input, init),
    );
    await renderCanvas(2);
    const file = new File(['image'], 'local.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    let uploading!: Promise<void>;
    act(() => {
      uploading = view.canvas!.nodeContentHandlers!.upload('a', file, vi.fn());
      view.canvas!.onRunNode(view.canvas!.nodes[0]);
    });
    const uploadResult = uploading.catch((error: Error) => error.message);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/uploads/init'))).toBe(
        true,
      ),
    );
    expect(view.canvas!.busyNodeIds).toEqual(new Set(['a']));
    act(() => {
      view.canvas!.onNodeSelect(view.canvas!.nodes[1]);
      view.canvas!.onRunNode(view.canvas!.nodes[1]);
    });
    await waitFor(() => expect(pending.posts).toEqual(['b']));
    expect(view.canvas!.busyNodeIds).toEqual(new Set(['a', 'b']));
    await act(async () => upload.resolve(json({ error: '合成上传失败' }, 500)));
    expect(await uploadResult).toBe('合成上传失败');
    await waitFor(() => expect(view.canvas!.busyNodeIds).toEqual(new Set(['b'])));
    await act(async () =>
      pending.polls.get('b')!.resolve(
        json({
          run: { ...pending.runs.get('b'), status: 'succeeded', progress: 100 },
        }),
      ),
    );
    await waitFor(() => expect(view.canvas!.busyNodeIds?.size).toBe(0));
  });

  it('连线改名只持久化目标 resourceRefs，保留提示词、视频模式、文件名、其它引用和连线并可撤销', async () => {
    const retained = {
      id: 'other-ref',
      assetId: 'other-asset',
      mediaType: 'image' as const,
      name: '背景',
    };
    canvas.nodes = [
      {
        ...imageNode('source', 'image-model'),
        data: { label: '原图片节点', mediaType: 'image', mode: 'source', assetId: asset.id },
      },
      {
        ...emptyNode('target'),
        type: 'video',
        data: {
          label: '视频',
          mode: 'generate',
          mediaType: 'video',
          prompt: '保持原提示词',
          videoMode: 'first_frame',
          resourceRefs: [retained],
        },
      },
      {
        ...emptyNode('downstream'),
        data: { ...emptyNode('downstream').data, prompt: '下游提示词' },
      },
    ];
    canvas.edges = [
      {
        id: 'input',
        sourceNodeId: 'source',
        targetNodeId: 'target',
        sourceHandle: 'output:image',
        targetHandle: 'input:firstFrame',
        order: 0,
      },
      {
        id: 'downstream',
        sourceNodeId: 'target',
        targetNodeId: 'downstream',
        sourceHandle: 'output:video',
        targetHandle: 'input:content',
        order: 0,
      },
    ];
    await renderCanvas(0);
    const edges = structuredClone(view.canvas!.edges);
    const sourceData = structuredClone(view.canvas!.nodes[0].data);
    act(() => {
      view.canvas!.onNodeSelect(view.canvas!.nodes[2]);
      view.canvas!.onConnectedResourceRename!(asset.id, ' 主角 ', 'target');
    });
    const renamed = view.canvas!.nodes.find((node) => node.id === 'target')!;
    expect(renamed.data).toMatchObject({
      prompt: '保持原提示词',
      videoMode: 'first_frame',
      stale: true,
      resourceRefs: [
        retained,
        {
          id: 'connected:' + asset.id,
          assetId: asset.id,
          mediaType: 'image',
          name: '主角',
        },
      ],
    });
    expect(renamed.data.promptDocument).toBeUndefined();
    expect(view.canvas!.nodes[0].data).toEqual(sourceData);
    expect(view.canvas!.nodes[2].data).toMatchObject({ stale: true, prompt: '下游提示词' });
    expect(view.canvas!.nodes[2].data.resourceRefs).toBeUndefined();
    expect(view.canvas!.edges).toEqual(edges);
    expect(view.canvas!.assets?.find((item) => item.id === asset.id)?.name).toBe(asset.name);
    await waitFor(() =>
      expect(canvas.nodes.find((node) => node.id === 'target')?.data.resourceRefs).toEqual(
        renamed.data.resourceRefs,
      ),
    );
    expect(renameRequests()).toHaveLength(0);
    act(() => view.canvas!.onConnectedResourceRename!(asset.id, '配角', 'target'));
    expect(view.canvas!.nodes.find((node) => node.id === 'target')?.data.resourceRefs).toEqual([
      retained,
      {
        id: 'connected:' + asset.id,
        assetId: asset.id,
        mediaType: 'image',
        name: '配角',
      },
    ]);
    act(() => view.canvas!.onUndoCanvas?.());
    expect(view.canvas!.nodes.find((node) => node.id === 'target')?.data.resourceRefs).toEqual(
      renamed.data.resourceRefs,
    );
    act(() => view.canvas!.onUndoCanvas?.());
    expect(view.canvas!.nodes.find((node) => node.id === 'target')?.data.resourceRefs).toEqual([
      retained,
    ]);
    expect(view.canvas!.edges).toEqual(edges);
    act(() => view.canvas!.onEdgesChange([{ type: 'remove', id: 'input' }]));
    expect(() => view.canvas!.onConnectedResourceRename!(asset.id, '失效别名', 'target')).toThrow(
      '连线资源已移除',
    );
    expect(view.canvas!.nodes.find((node) => node.id === 'target')?.data.resourceRefs).toEqual([
      retained,
    ]);
  });

  it('只有旧正文引用且无资料池或连线时立即改名，保留冻结版本和普通正文', async () => {
    const mention = {
      type: 'mention' as const,
      mentionId: 'legacy-independent-image',
      assetId: asset.id,
      assetVersion: 3,
      mediaType: 'image' as const,
      label: asset.name,
      entityName: '旧别名',
    };
    const document: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '保持正文；' },
        mention,
        { type: 'text', text: '；主角是普通文字。' },
      ],
    };
    const prompt = renderPromptDocument(document);
    resourceAssets = [{ ...asset, latestVersion: 9 }];
    canvas.nodes = [
      {
        ...imageNode('target', 'image-model'),
        data: { ...imageNode('target', 'image-model').data, prompt, promptDocument: document },
      },
    ];
    canvas.edges = [];
    await renderCanvas(0);
    expect(view.canvas!.nodes[0].data.resourceRefs).toBeUndefined();

    act(() => view.canvas!.onConnectedResourceRename!(asset.id, '主角', 'target', 3));

    const renamed = view.canvas!.nodes[0].data;
    expect(renamed.resourceRefs).toEqual([
      expect.objectContaining({
        assetId: asset.id,
        assetVersion: 3,
        mediaType: 'image',
        name: '主角',
        attached: true,
      }),
    ]);
    expect(renamed.prompt).toBe(prompt);
    expect(renderPromptDocument(renamed.promptDocument!)).toBe(prompt);
    expect(renamed.promptDocument?.blocks.filter((block) => block.type === 'mention')).toEqual([
      { ...mention, inline: true, entityName: '主角' },
    ]);
    expect(view.canvas!.edges).toEqual([]);
    expect(view.canvas!.assets?.find((item) => item.id === asset.id)?.name).toBe(asset.name);
    await waitFor(() => expect(canvas.nodes[0].data.resourceRefs).toEqual(renamed.resourceRefs));
    expect(canvas.nodes[0].data.prompt).toBe(prompt);
    expect(renameRequests()).toHaveLength(0);
  });

  it.each([false, true])(
    '连线改名复用旧 resourceRef，优先 connected 身份（已有专用引用：%s），满 40 项仍可改名',
    async (hasConnectedReference) => {
      const legacy = {
        id: 'imported-reference',
        assetId: asset.id,
        mediaType: 'image' as const,
        name: '导入别名',
        assetVersion: 3,
      };
      const connected = {
        ...legacy,
        id: 'connected:' + asset.id,
        name: '连线别名',
        assetVersion: 7,
      };
      const others = Array.from({ length: hasConnectedReference ? 38 : 39 }, (_, index) => ({
        id: 'retained-' + index,
        assetId: 'other-asset-' + index,
        mediaType: 'image' as const,
        name: '其它资源' + index,
      }));
      const references = [legacy, ...others, ...(hasConnectedReference ? [connected] : [])];
      canvas.nodes = [
        {
          ...imageNode('source', 'image-model'),
          data: { label: '原图片节点', mode: 'source', mediaType: 'image', assetId: asset.id },
        },
        {
          ...imageNode('target', 'image-model'),
          data: { ...imageNode('target', 'image-model').data, resourceRefs: references },
        },
      ];
      canvas.edges = [
        {
          id: 'input',
          sourceNodeId: 'source',
          targetNodeId: 'target',
          sourceHandle: 'output:image',
          targetHandle: 'input:content',
          order: 0,
        },
      ];
      await renderCanvas(0);
      act(() => view.canvas!.onConnectedResourceRename!(asset.id, ' 主角 ', 'target'));
      const updatedId = hasConnectedReference ? connected.id : legacy.id;
      const expected = references.map((reference) =>
        reference.id === updatedId ? { ...reference, name: '主角' } : reference,
      );
      expect(view.canvas!.nodes[1].data.resourceRefs).toEqual(expected);
      await waitFor(() => expect(canvas.nodes[1].data.resourceRefs).toEqual(expected));
      act(() => view.canvas!.onConnectedResourceRename!(asset.id, '配角', 'target'));
      expect(view.canvas!.nodes[1].data.resourceRefs).toHaveLength(40);
      expect(
        view.canvas!.nodes[1].data.resourceRefs?.find((reference) => reference.id === updatedId),
      ).toEqual({ ...(hasConnectedReference ? connected : legacy), name: '配角' });
      expect(view.canvas!.assets?.find((item) => item.id === asset.id)?.name).toBe(asset.name);
      expect(renameRequests()).toHaveLength(0);
    },
  );

  it('连线别名经历提示词修改、同资源改名和删除最后提及后仍保留，切换节点及重载读取保存值', async () => {
    const otherReference = {
      id: 'other-node-ref',
      assetId: asset.id,
      mediaType: 'image' as const,
      name: '另一节点别名',
    };
    canvas.nodes = [
      {
        ...imageNode('source', 'image-model'),
        data: { label: '原图片节点', mode: 'source', mediaType: 'image', assetId: asset.id },
      },
      {
        ...imageNode('target', 'image-model'),
        data: { ...imageNode('target', 'image-model').data, prompt: '保持文本' },
      },
      {
        ...emptyNode('other'),
        data: { ...emptyNode('other').data, prompt: '其它节点', resourceRefs: [otherReference] },
      },
    ];
    canvas.edges = [
      {
        id: 'input',
        sourceNodeId: 'source',
        targetNodeId: 'target',
        sourceHandle: 'output:image',
        targetHandle: 'input:content',
        order: 0,
      },
    ];
    const mounted = await renderCanvas(0);
    const originalEdges = structuredClone(view.canvas!.edges);
    act(() => view.canvas!.onConnectedResourceRename!(asset.id, '主角', 'target'));
    const firstAlias = [
      { id: 'connected:' + asset.id, assetId: asset.id, mediaType: 'image', name: '主角' },
    ];
    const mentioned: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '请绘制 ' },
        {
          type: 'mention',
          mentionId: 'mention-image',
          assetId: asset.id,
          mediaType: 'image',
          label: asset.name,
          entityName: '主角',
        },
      ],
    };
    act(() => view.canvas!.onPromptDocumentChange!(mentioned, 'target'));
    const attachedAlias = firstAlias;
    expect(view.canvas!.nodes[1].data.resourceRefs).toEqual(attachedAlias);
    const renamed: PromptDocument = {
      ...mentioned,
      blocks: mentioned.blocks.map((block) =>
        block.type === 'mention' ? { ...block, entityName: '配角' } : block,
      ),
    };
    act(() => {
      view.canvas!.onConnectedResourceRename!(asset.id, '配角', 'target');
      view.canvas!.onPromptDocumentChange!(renamed, 'target');
    });
    const finalAlias = [{ ...attachedAlias[0], name: '配角' }];
    expect(view.canvas!.nodes[1].data).toMatchObject({
      prompt: '请绘制 配角',
      resourceRefs: finalAlias,
    });
    const noMentions: PromptDocument = {
      version: 1,
      blocks: [{ type: 'text', text: '没有提及的提示词' }],
    };
    act(() => view.canvas!.onPromptDocumentChange!(noMentions, 'target'));
    expect(view.canvas!.nodes[1].data.resourceRefs).toEqual(finalAlias);
    act(() => view.canvas!.onNodeSelect(view.canvas!.nodes[2]));
    expect(view.canvas!.selectedNode?.data.resourceRefs).toEqual([otherReference]);
    act(() => view.canvas!.onNodeSelect(view.canvas!.nodes[1]));
    expect(view.canvas!.selectedNode?.data.resourceRefs).toEqual(finalAlias);
    await waitFor(() =>
      expect(canvas.nodes[1].data).toMatchObject({
        resourceRefs: finalAlias,
        promptDocument: noMentions,
        prompt: '没有提及的提示词',
      }),
    );
    mounted.unmount();
    view.canvas = null;
    await renderCanvas(0);
    expect(view.canvas!.nodes[1].data).toMatchObject({
      resourceRefs: finalAlias,
      promptDocument: noMentions,
      prompt: '没有提及的提示词',
    });
    expect(view.canvas!.nodes[2].data.resourceRefs).toEqual([otherReference]);
    expect(view.canvas!.edges).toEqual(originalEdges);
    expect(view.canvas!.assets?.find((item) => item.id === asset.id)?.name).toBe(asset.name);
    expect(renameRequests()).toHaveLength(0);
  });

  it('图片节点配置变化后重试复用原节点并创建新的运行', async () => {
    canvas = {
      revision: 1,
      nodes: [imageNode('image-node', 'image-new', 'credential-new')],
      edges: [],
    };
    const previousRun = runRecord({});
    currentRun = runRecord({
      id: 'run-image-new',
      status: 'succeeded',
      progress: 100,
      attempt: 1,
      modelAlias: 'image-new',
      snapshot: imageRunSnapshot(2, 'image-new'),
      createdAt: '2026-09-25T00:02:00.000Z',
      updatedAt: '2026-09-25T00:03:00.000Z',
      error: undefined,
    });
    projectRuns = [previousRun];

    await renderCanvas(1);
    await waitFor(() => expect(view.canvas?.nodes[0]?.data.runStatus).toBe('failed'));

    await act(async () => {
      await view.canvas!.onRetryNode('image-node');
    });

    const retryRequests = fetchMock.mock.calls.filter(
      ([url, init]) => init?.method === 'POST' && String(url).includes('/v1/nodes/image-node/runs'),
    );
    expect(retryRequests).toHaveLength(1);
    expect(JSON.parse(String(retryRequests[0]?.[1]?.body))).toMatchObject({
      projectId: project.id,
      modelAlias: 'image-new',
      credentialId: 'credential-new',
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/v1/runs/run-image-failed/retry'),
      ),
    ).toBe(false);
    expect(view.canvas?.nodes.map((node) => node.id)).toEqual(['image-node']);
    expect(view.canvas?.nodes[0]?.data.runStatus).toBe('succeeded');
  });

  it('失败视频节点只通过原 Run 获取资源，轮询期间同节点不重复请求或创建新运行', async () => {
    canvas = { revision: 1, nodes: [videoNode('video-node', 'video-new')], edges: [] };
    const previousRun = videoRunRecord();
    projectRuns = [previousRun];
    const recover = pendingResponse();
    const poll = pendingResponse();
    const originalApi = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === '/v1/runs/' + previousRun.id + '/recover' && init?.method === 'POST')
        return recover.promise;
      if (path === '/v1/runs/' + previousRun.id && (!init?.method || init.method === 'GET'))
        return poll.promise;
      return originalApi(input, init);
    });
    await renderCanvas(0);
    await waitFor(() => expect(view.canvas?.nodes[0]?.data.runStatus).toBe('failed'));

    let recovery!: Promise<void>;
    act(() => {
      recovery = view.canvas!.onRecoverNode!('video-node') as Promise<void>;
    });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith('/v1/runs/run-video-failed/recover') && init?.method === 'POST',
        ),
      ).toHaveLength(1),
    );
    await expect(view.canvas!.onRecoverNode!('video-node')).rejects.toThrow('该节点正在处理任务');
    const recoverRequest = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/v1/runs/run-video-failed/recover'),
    );
    expect(JSON.parse(String(recoverRequest?.[1]?.body))).toEqual({ retrieveOnly: true });

    const queuedRun = videoRunRecord({
      status: 'queued',
      progress: 0,
      error: undefined,
      updatedAt: '2026-09-25T00:02:00.000Z',
    });
    await act(async () => recover.resolve(json({ run: queuedRun }, 202)));
    await waitFor(() => expect(view.canvas?.nodes[0]?.data.runStatus).toBe('queued'));
    expect(view.canvas?.busyNodeIds?.has('video-node')).toBe(true);

    const assetResult = {
      assetId: 'recovered-video',
      version: 1,
      contentUrl: 'https://example.test/recovered.mp4',
      mimeType: 'video/mp4',
    };
    const succeededRun = videoRunRecord({
      status: 'succeeded',
      progress: 100,
      error: undefined,
      updatedAt: '2026-09-25T00:03:00.000Z',
      result: {
        provider: 'newapi',
        summary: '原任务资源已归档',
        targetNodeId: 'video-node',
        mediaType: 'video',
        inputCount: 0,
        asset: assetResult,
      },
    });
    await act(async () => poll.resolve(json({ run: succeededRun })));
    await act(async () => await recovery);
    expect(view.canvas?.nodes[0]?.data).toMatchObject({
      runStatus: 'succeeded',
      resultAsset: assetResult,
    });
    expect(view.canvas?.busyNodeIds?.has('video-node')).toBe(false);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          init?.method === 'POST' && String(url).includes('/v1/nodes/video-node/runs'),
      ),
    ).toHaveLength(0);
  });

  it('无原 Run 时明确拒绝获取', async () => {
    canvas = { revision: 1, nodes: [videoNode('video-node', 'video-new')], edges: [] };
    await renderCanvas(0);
    await expect(view.canvas!.onRecoverNode!('video-node')).rejects.toThrow(
      '没有可获取资源的运行记录',
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/recover'))).toBe(false);
  });

  it.each([
    ['图片失败', imageNode('image-node', 'image-new'), runRecord({})],
    ['视频取消', videoNode('video-node', 'video-new'), videoRunRecord({ status: 'cancelled' })],
    [
      '视频成功但无产物',
      videoNode('video-node', 'video-new'),
      videoRunRecord({ status: 'succeeded' }),
    ],
  ])('%s时回调不发起只读获取', async (_label, node, run) => {
    canvas = { revision: 1, nodes: [node], edges: [] };
    projectRuns = [run];
    await renderCanvas(node.data.mediaType === 'image' ? 1 : 0);
    await waitFor(() => expect(view.canvas?.nodes[0]?.data.runStatus).toBe(run.status));
    await expect(view.canvas!.onRecoverNode!(node.id)).rejects.toThrow(
      '仅失败的视频任务可获取原资源',
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/recover'))).toBe(false);
  });

  it('轮询响应来自其他 Run 时不覆盖节点结果', async () => {
    canvas = { revision: 1, nodes: [videoNode('video-node', 'video-new')], edges: [] };
    const previousRun = videoRunRecord();
    projectRuns = [previousRun];
    const poll = pendingResponse();
    const originalApi = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === '/v1/runs/' + previousRun.id + '/recover' && init?.method === 'POST')
        return Promise.resolve(
          json(
            {
              run: videoRunRecord({
                status: 'queued',
                progress: 0,
                updatedAt: '2026-09-25T00:02:00.000Z',
              }),
            },
            202,
          ),
        );
      if (path === '/v1/runs/' + previousRun.id && (!init?.method || init.method === 'GET'))
        return poll.promise;
      return originalApi(input, init);
    });
    await renderCanvas(0);
    await waitFor(() => expect(view.canvas?.nodes[0]?.data.runStatus).toBe('failed'));

    let recovery!: Promise<void>;
    act(() => {
      recovery = view.canvas!.onRecoverNode!('video-node') as Promise<void>;
    });
    const outcome = recovery.then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitFor(() => expect(view.canvas?.nodes[0]?.data.runStatus).toBe('queued'));
    await act(async () =>
      poll.resolve(json({ run: videoRunRecord({ id: 'other-run', status: 'succeeded' }) })),
    );
    await expect(outcome).resolves.toMatchObject({ message: '运行状态响应与原任务不一致' });
    expect(view.canvas?.nodes[0]?.data.runStatus).toBe('queued');
    expect(view.canvas?.nodes[0]?.data.resultAsset).toBeUndefined();
  });

  it('新建项目保留必填校验、取消和创建失败后的草稿', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByRole('button', { name: '打开项目集合' }));
    await user.click(await screen.findByRole('menuitem', { name: '新建' }));
    const dialog = await screen.findByRole('dialog', { name: '新建项目' });
    const name = within(dialog).getByRole('textbox', { name: '项目名称' });
    await user.clear(name);
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请输入项目名称');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    await user.type(name, ' 新的项目 ');
    createFailure = '创建请求失败';
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }));
    await screen.findByText('创建请求失败');
    expect(name).toHaveValue(' 新的项目 ');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument(),
    );
    expect(window.location.pathname).toBe('/projects/' + project.id);
  });

  it('清空画布取消不改变节点，确认后可一次撤销恢复', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByRole('button', { name: '测试清空画布' }));
    let dialog = await screen.findByRole('dialog', { name: '清空画布' });
    expect(dialog).toHaveTextContent('2 个节点');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(view.canvas?.nodes).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '测试清空画布' }));
    dialog = await screen.findByRole('dialog', { name: '清空画布' });
    await user.click(within(dialog).getByRole('button', { name: '确认清空' }));
    await waitFor(() => expect(view.canvas?.nodes).toHaveLength(0));
    await user.click(screen.getByRole('button', { name: '测试撤销' }));
    await waitFor(() =>
      expect(view.canvas?.nodes.map((node) => node.id)).toEqual(['empty-one', 'empty-two']),
    );
  });

  it('空节点确认等待期间新填写的提示词保留，范围缩小时再次确认', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByRole('button', { name: '测试清空空节点' }));
    let dialog = await screen.findByRole('dialog', { name: '清空空节点' });
    fillNode('empty-one', '等待期间写入的内容');
    await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
    dialog = await changedConfirmation('节点');
    expect(view.canvas?.nodes).toHaveLength(2);
    expect(dialog).toHaveTextContent('1 个空节点');
    await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
    await waitFor(() => expect(view.canvas?.nodes.map((node) => node.id)).toEqual(['empty-one']));
    expect(view.canvas?.nodes[0]?.data.prompt).toBe('等待期间写入的内容');
    await user.click(screen.getByRole('button', { name: '测试撤销' }));
    await waitFor(() => expect(view.canvas?.nodes).toHaveLength(2));
    expect(view.canvas?.nodes[0]?.data.prompt).toBe('等待期间写入的内容');
  });

  it('资源重命名取消或空值不写请求，失败保留草稿并允许重试', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByRole('button', { name: '重命名 原资源名称' }));
    let dialog = await screen.findByRole('dialog', { name: '重命名资源' });
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(renameRequests()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '重命名 原资源名称' }));
    dialog = await screen.findByRole('dialog', { name: '重命名资源' });
    const input = within(dialog).getByRole('textbox', { name: '资源名称' });
    await user.clear(input);
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请输入资源名称');
    expect(renameRequests()).toHaveLength(0);
    await user.type(input, ' 新资源 ');
    renameFailure = '测试保存失败';
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));
    await within(dialog).findByText('测试保存失败');
    expect(input).toHaveValue(' 新资源 ');
    renameFailure = null;
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '重命名资源' })).not.toBeInTheDocument(),
    );
    expect(JSON.parse(String(renameRequests().at(-1)?.[1]?.body))).toEqual({ name: '新资源' });
    expect(screen.getByRole('button', { name: '重命名 新资源' })).toBeInTheDocument();
  });

  it('空节点范围再次确认时取消，内容与节点保持最新状态', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByRole('button', { name: '测试清空空节点' }));
    const dialog = await screen.findByRole('dialog', { name: '清空空节点' });
    fillNode('empty-one', '保留内容');
    await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
    const updated = await changedConfirmation('节点');
    expect(updated).toHaveTextContent('1 个空节点');
    await user.click(within(updated).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '清空空节点' })).not.toBeInTheDocument(),
    );
    expect(view.canvas!.nodes.map((node) => node.id)).toEqual(['empty-one', 'empty-two']);
    expect(view.canvas!.nodes[0].data.prompt).toBe('保留内容');
    // 取消没有写入一笔重复历史：撤销直接回到异步填入内容前。
    await user.click(screen.getByRole('button', { name: '测试撤销' }));
    expect(view.canvas!.nodes[0].data.prompt).toBeUndefined();
  });

  it('所有空节点在等待期间失效时不删除，也不新增清理历史', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByRole('button', { name: '测试清空空节点' }));
    const dialog = await screen.findByRole('dialog', { name: '清空空节点' });
    fillNode('empty-one', '第一份内容');
    fillNode('empty-two', '第二份内容');
    await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
    await screen.findByText(/当前有 0 个可清理的空节点，未移除任何内容/);
    expect(view.canvas!.nodes).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '测试撤销' }));
    expect(view.canvas!.nodes[0].data.prompt).toBe('第一份内容');
    expect(view.canvas!.nodes[1].data.prompt).toBeUndefined();
  });

  it('等待期间新增的空节点不纳入既定清理范围，重复操作不增加确认窗', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByRole('button', { name: '测试清空空节点' }));
    const dialog = await screen.findByRole('dialog', { name: '清空空节点' });
    act(() => {
      view.canvas!.onClearEmptyNodes!();
      view.canvas!.onClearCanvas!();
      const node = view.canvas!.nodes[0];
      view.canvas!.onNodesChange([
        { type: 'add', item: { ...node, id: 'late-empty', data: { ...node.data } } },
      ]);
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(view.canvas!.nodes).toHaveLength(3);
    await user.click(within(dialog).getByRole('button', { name: '确认清理' }));
    await waitFor(() => expect(view.canvas!.nodes.map((node) => node.id)).toEqual(['late-empty']));
    await user.click(screen.getByRole('button', { name: '测试撤销' }));
    expect(view.canvas!.nodes.map((node) => node.id)).toEqual([
      'empty-one',
      'empty-two',
      'late-empty',
    ]);
  });

  it('全画布即使节点数量不变，身份变化也重新确认并按最新快照撤销', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByRole('button', { name: '测试清空画布' }));
    const dialog = await screen.findByRole('dialog', { name: '清空画布' });
    act(() => {
      const node = view.canvas!.nodes[0];
      view.canvas!.onNodesChange([
        {
          type: 'replace',
          id: node.id,
          item: { ...node, id: 'replacement', data: { ...node.data, prompt: '最新内容' } },
        },
      ]);
    });
    await user.click(within(dialog).getByRole('button', { name: '确认清空' }));
    const updated = await changedConfirmation('画布');
    expect(updated).toHaveTextContent('2 个节点');
    expect(view.canvas!.nodes).toHaveLength(2);
    await user.click(within(updated).getByRole('button', { name: '确认清空' }));
    await waitFor(() => expect(view.canvas!.nodes).toHaveLength(0));
    await user.click(screen.getByRole('button', { name: '测试撤销' }));
    expect(view.canvas!.nodes.map((node) => node.id)).toEqual(['replacement', 'empty-two']);
    expect(view.canvas!.nodes[0].data.prompt).toBe('最新内容');
  });

  it('确认等待期间切换项目，旧窗口和清理操作不进入新画布', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByRole('button', { name: '测试清空画布' }));
    await screen.findByRole('dialog', { name: '清空画布' });
    canvas = { revision: 1, nodes: [emptyNode('new-project-node')], edges: [] };
    act(() => {
      window.history.pushState(null, '', '/projects/' + secondProject.id);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() =>
      expect(view.canvas!.nodes.map((node) => node.id)).toEqual(['new-project-node']),
    );
    expect(screen.queryByRole('dialog', { name: '清空画布' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '测试清空画布' }));
    const current = await screen.findByRole('dialog', { name: '清空画布' });
    expect(current).toHaveTextContent('1 个节点');
    await user.click(within(current).getByRole('button', { name: '取消' }));
    expect(view.canvas!.nodes.map((node) => node.id)).toEqual(['new-project-node']);
  });

  it('项目菜单保存失败不跳转，重试成功后才加载目标项目', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    saveFailure = '画布保存失败测试';
    fillNode('empty-one', '需要保存的项目草稿');
    await user.click(screen.getByRole('button', { name: '打开项目集合' }));
    await user.click(await screen.findByRole('menuitem', { name: /第二个项目/ }));
    await screen.findByText('画布保存失败测试');
    expect(window.location.pathname).toBe('/projects/' + project.id);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/v1/projects/' + secondProject.id),
      ),
    ).toBe(false);
    saveFailure = null;
    await user.click(screen.getByRole('menuitem', { name: /第二个项目/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/projects/' + secondProject.id));
    const saveIndex = fetchMock.mock.calls.findIndex(
      ([url, init]) => String(url).endsWith('/canvas') && init?.method === 'PATCH',
    );
    await waitFor(() => {
      const nextIndex = fetchMock.mock.calls.findIndex(([url]) =>
        String(url).endsWith('/v1/projects/' + secondProject.id),
      );
      expect(nextIndex).toBeGreaterThan(saveIndex);
    });
  });

  it.each([
    ['workflow', '导出工作流 JSON', 'application/json'],
    ['results', '导出结果 ZIP', 'application/zip'],
  ])('导出菜单 %s 先保存后下载，保存失败不会导出', async (kind, label, accept) => {
    const user = userEvent.setup();
    await renderCanvas();
    saveFailure = '保存失败禁止导出';
    fillNode('empty-one', '需要保存的导出草稿');
    await user.click(screen.getByRole('button', { name: '导出' }));
    await user.click(await screen.findByRole('menuitem', { name: label }));
    await screen.findByText('保存失败禁止导出');
    expect(exports.downloadProjectExport).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/export/'))).toBe(false);
    saveFailure = null;
    fetchMock.mockClear();
    await user.click(screen.getByRole('button', { name: '导出' }));
    await user.click(await screen.findByRole('menuitem', { name: label }));
    await waitFor(() => expect(exports.downloadProjectExport).toHaveBeenCalledTimes(1));
    const saveIndex = fetchMock.mock.calls.findIndex(
      ([url, init]) => String(url).endsWith('/canvas') && init?.method === 'PATCH',
    );
    const exportIndex = fetchMock.mock.calls.findIndex(([url]) =>
      String(url).endsWith('/export/' + kind),
    );
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeGreaterThan(saveIndex);
    expect(new Headers(fetchMock.mock.calls[exportIndex][1]?.headers).get('accept')).toBe(accept);
  });

  it.each(['新建项目', '重命名资源'])(
    '%s 的 IME Enter/Escape 不误提交或关闭，普通 Escape 可取消',
    async (title) => {
      const user = userEvent.setup();
      if (title === '新建项目') {
        // 两个入口共用同一表单；工作台入口不受测试环境 Dropdown 重复 ID 干扰。
        window.history.replaceState(null, '', '/workspace');
        render(<App />);
        const create = await screen.findByRole('button', { name: '新建项目' });
        await waitFor(() => expect(create).toBeEnabled());
        await user.click(create);
      } else {
        await renderCanvas();
        await user.click(screen.getByRole('button', { name: '重命名 原资源名称' }));
      }
      const dialog = await screen.findByRole('dialog', { name: title });
      const input = within(dialog).getByRole('textbox');
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: '中文输入' } });
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: true });
      fireEvent.keyDown(input, { key: 'Escape', keyCode: 27, isComposing: true });
      expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
      expect(renameRequests()).toHaveLength(0);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
      fireEvent.compositionEnd(input, { data: '中文输入' });
      // 库在 compositionend 后保护 200ms，越过冷却期再验证一次独立的 Escape。
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 201);
      fireEvent.keyDown(input, { key: 'Escape', keyCode: 27 });
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: title })).not.toBeInTheDocument(),
      );
    },
  );

  it('资源名称未改变时关闭弹窗且不发送 PATCH', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByRole('button', { name: '重命名 原资源名称' }));
    const dialog = await screen.findByRole('dialog', { name: '重命名资源' });
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '重命名资源' })).not.toBeInTheDocument(),
    );
    expect(renameRequests()).toHaveLength(0);
  });
  it('新建项目保存旧画布并提交修剪后的名称，等待期间不关闭或重复创建', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    fillNode('empty-one', '创建前的工作草稿');
    const api = fetchMock.getMockImplementation()!;
    let finishCreate: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/projects') && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          finishCreate = resolve;
        });
      }
      return api(input, init);
    });
    await user.click(screen.getByRole('button', { name: '打开项目集合' }));
    await user.click(await screen.findByRole('menuitem', { name: '新建' }));
    const dialog = await screen.findByRole('dialog', { name: '新建项目' });
    const input = within(dialog).getByRole('textbox', { name: '项目名称' });
    await user.clear(input);
    await user.type(input, ' 新的工作流 ');
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(finishCreate).toBeDefined());
    expect(within(dialog).getByRole('button', { name: '创建中' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 27 });
    fireEvent.submit(input.closest('form')!);
    expect(dialog).toBeInTheDocument();
    const creates = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(creates).toHaveLength(1);
    expect(JSON.parse(String(creates[0][1]?.body))).toEqual({ name: '新的工作流' });
    const saved = fetchMock.mock.calls.findIndex(
      ([url, init]) => String(url).endsWith('/canvas') && init?.method === 'PATCH',
    );
    const created = fetchMock.mock.calls.findIndex(([, init]) => init?.method === 'POST');
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThan(saved);
    await act(async () =>
      finishCreate!(json({ project: { ...secondProject, name: '新的工作流' } })),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/projects/' + secondProject.id));
    expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument();
  });

  it('资源重命名请求未完成时禁止关闭和重复提交', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    const api = fetchMock.getMockImplementation()!;
    let finishRename: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/assets/' + asset.id) && init?.method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          finishRename = resolve;
        });
      }
      return api(input, init);
    });
    await user.click(screen.getByRole('button', { name: '重命名 原资源名称' }));
    const dialog = await screen.findByRole('dialog', { name: '重命名资源' });
    const input = within(dialog).getByRole('textbox', { name: '资源名称' });
    await user.clear(input);
    await user.type(input, '等待保存的名称');
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));
    await waitFor(() => expect(finishRename).toBeDefined());
    expect(within(dialog).getByRole('button', { name: '保存中' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    expect(input).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape', keyCode: 27 });
    fireEvent.submit(input.closest('form')!);
    expect(dialog).toBeInTheDocument();
    expect(renameRequests()).toHaveLength(1);
    resourceAssets = [{ ...asset, name: '等待保存的名称' }];
    await act(async () => finishRename!(json({ asset: resourceAssets[0] })));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '重命名资源' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '重命名 等待保存的名称' })).toBeInTheDocument();
  });
});

describe('App 节点参数提交', () => {
  it.each(['sameNode', 'newNode'] as const)(
    '不支持的音色在 %s 入口提前拒绝且保留历史值',
    async (target) => {
      const node: CanvasDocument['nodes'][number] = {
        ...emptyNode('image-node'),
        type: 'audio',
        data: {
          label: '历史音色',
          mediaType: 'audio',
          mode: 'generate',
          modelAlias: 'test-tts',
          prompt: 'Read the sample.',
          assetId: 'existing-audio',
          parameters: { voice: 'custom voice', response_format: 'wav' },
        },
      };
      canvas.nodes = [node];
      await renderCanvas(0);
      await act(async () => view.canvas!.onRunNode(view.canvas!.nodes[0]!, target));
      expect(screen.getByText(/当前接口不支持此音色/)).toBeInTheDocument();
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
      expect(view.canvas!.nodes).toHaveLength(1);
      expect(view.canvas!.nodes[0]!.data.parameters).toEqual(node.data.parameters);
    },
  );

  it.each(['sameNode', 'newNode'] as const)(
    '图片尺寸冲突时 %s 入口不创建任务或新节点',
    async (target) => {
      const node = imageNode('image-node', 'image-model');
      node.data = {
        ...node.data,
        prompt: 'Change the lighting.',
        assetId: asset.id,
        parameters: { quality: '4k', aspectRatio: '9:16', size: '1024x1024' },
      };
      canvas.nodes = [node];
      await renderCanvas(0);
      await act(async () => view.canvas!.onRunNode(view.canvas!.nodes[0]!, target));
      expect(screen.getByText(/图片参数.*冲突/)).toBeInTheDocument();
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
      expect(view.canvas!.nodes).toHaveLength(1);
      expect(canvas.nodes[0]!.data.parameters).toEqual(node.data.parameters);
    },
  );

  it.each(['sameNode', 'newNode'] as const)(
    '已知图片模型不支持的尺寸在 %s 入口按冻结模型拒绝',
    async (target) => {
      const node = imageNode('image-node', 'gpt-image-2.5-sunburst');
      node.data = {
        ...node.data,
        prompt: 'Change the lighting.',
        assetId: asset.id,
        parameters: { quality: '4k', aspectRatio: '1:1' },
      };
      canvas.nodes = [node];
      await renderCanvas(0);
      await act(async () => view.canvas!.onRunNode(view.canvas!.nodes[0]!, target));
      expect(screen.getByText(/总像素范围/)).toBeInTheDocument();
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
      expect(view.canvas!.nodes).toHaveLength(1);
      expect(view.canvas!.nodes[0]!.data.parameters).toEqual(node.data.parameters);
    },
  );

  it.each([
    ['image', { quality: 'standard', aspectRatio: '1:1' }],
    ['image', { quality: '2k', aspectRatio: '16:9' }],
    ['image', { quality: '3k', aspectRatio: '4:3' }],
    ['image', { quality: '4k', aspectRatio: '9:16' }],
    ['image', { quality: '4k', aspectRatio: '21:9', size: '3840x1648' }],
    ['video', { resolution: '1080p', aspectRatio: '9:16', duration: 10 }],
    ['audio', { voice: 'alloy', response_format: 'wav', speed: 1.25 }],
    ['text', { temperature: 0.7, max_tokens: 512, top_p: 0.9 }],
  ] as const)('%s 节点保存与提交不改写已选参数 %j', async (mediaType, parameters) => {
    const node: CanvasDocument['nodes'][number] = {
      ...emptyNode('image-node'),
      type: mediaType,
      data: {
        label: '参数提交测试',
        mediaType,
        mode: 'generate',
        modelAlias: 'exact-model-alias',
        credentialId: 'synthetic-parameter-credential',
        prompt: 'Describe the sample.',
        inferenceStrength: 'medium',
        parameters: { providerOption: 'preserved' },
      },
    };
    canvas.nodes = [node];
    currentRun = runRecord({ status: 'succeeded', error: undefined });
    await renderCanvas(0);
    const savedParameters = { ...parameters, providerOption: 'preserved' };
    act(() => view.canvas!.onParametersChange!(savedParameters, node.id));
    await act(async () => view.canvas!.onRunNode(view.canvas!.nodes[0]!));

    const requests = fetchMock.mock.calls.filter(
      ([url, init]) => init?.method === 'POST' && String(url).endsWith('/nodes/image-node/runs'),
    );
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]![1]!.body))).toEqual({
      projectId: project.id,
      modelAlias: 'exact-model-alias',
      credentialId: 'synthetic-parameter-credential',
      parameters: {
        ...savedParameters,
        prompt: 'Describe the sample.',
        inferenceStrength: 'medium',
      },
    });
    expect(canvas.nodes[0]!.data.parameters).toEqual(savedParameters);
  });

  it('拖动并修改图片参数后，旧运行入口仍按最新位置生成新节点并继承 4K 竖屏参数', async () => {
    const node = imageNode('image-node', 'exact-image-model', 'synthetic-image-credential');
    node.data = {
      ...node.data,
      prompt: 'Change the lighting.',
      assetId: asset.id,
      contentUrl: asset.contentUrl,
      parameters: {
        quality: '1k',
        aspectRatio: '9:16',
        providerOption: 'preserved',
      },
    };
    canvas.nodes = [node];

    const api = fetchMock.getMockImplementation()!;
    const submitted: Array<{ nodeId: string; body: Record<string, unknown> }> = [];
    const runs = new Map<string, RunRecord>();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'http://localhost:3000',
      );
      const pathMatch = /^\/v1\/nodes\/([^/]+)\/runs$/.exec(url.pathname);
      if (pathMatch && init?.method === 'POST' && pathMatch[1] !== node.id) {
        const nodeId = pathMatch[1]!;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const run = runRecord({
          id: 'run-' + nodeId,
          targetNodeId: nodeId,
          modelAlias: 'exact-image-model',
          status: 'succeeded',
          error: undefined,
        });
        submitted.push({ nodeId, body });
        runs.set(run.id, run);
        return json({ run }, 202);
      }
      const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (runMatch && runs.has(runMatch[1]!)) return json({ run: runs.get(runMatch[1]!) });
      return api(input, init);
    });

    await renderCanvas(0);
    const selectedNode = view.canvas!.nodes[0]!;
    const runFromCanvas = view.canvas!.onRunNode;
    const selectedParameters = {
      quality: '4k',
      aspectRatio: '9:16',
      providerOption: 'preserved',
    };
    act(() => view.canvas!.onParametersChange!(selectedParameters, selectedNode.id));
    const updatedNode = view.canvas!.nodes[0]!;
    expect(updatedNode.data.parameters).toEqual(selectedParameters);

    act(() =>
      view.canvas!.onNodesChange([
        { type: 'position', id: selectedNode.id, position: { x: 720, y: 480 }, dragging: false },
      ]),
    );
    expect(view.canvas!.onRunNode).toBe(runFromCanvas);
    await act(async () => runFromCanvas(selectedNode, 'newNode'));

    const child = view.canvas!.nodes.find((candidate) => candidate.id !== node.id);
    expect(child).toBeDefined();
    expect(child!.position.x).toBeGreaterThan(720);
    expect(child!.position.y).toBe(480);
    expect(child!.data.modelAlias).toBe('exact-image-model');
    expect(child!.data.credentialId).toBe('synthetic-image-credential');
    expect(child!.data.parameters).toEqual(selectedParameters);
    expect(
      resolveImageOutputParameters(child!.data.parameters ?? {}, child!.data.modelAlias),
    ).toEqual(
      expect.objectContaining({
        resolution: '4k',
        width: 2160,
        height: 3840,
        size: '2160x3840',
      }),
    );
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.nodeId).toBe(child!.id);
    expect(submitted[0]!.body).toEqual({
      projectId: project.id,
      modelAlias: 'exact-image-model',
      credentialId: 'synthetic-image-credential',
      parameters: {
        ...selectedParameters,
        prompt: 'Change the lighting.',
      },
    });
  });

  it.each([undefined, 'low'] as const)(
    '文字节点提交不为未设置的推理强度补 high，保留旧参数中的 %s',
    async (legacyInferenceStrength) => {
      const parameters = {
        max_tokens: 256,
        ...(legacyInferenceStrength ? { inferenceStrength: legacyInferenceStrength } : {}),
      };
      canvas.nodes = [
        {
          ...emptyNode('image-node'),
          data: {
            ...emptyNode('image-node').data,
            prompt: 'Summarize the sample.',
            modelAlias: 'text-model-without-reasoning-default',
            parameters,
          },
        },
      ];
      currentRun = runRecord({ status: 'succeeded', error: undefined });
      await renderCanvas(0);
      expect(view.canvas!.nodes[0]!.data.inferenceStrength).toBeUndefined();
      await act(async () => view.canvas!.onRunNode(view.canvas!.nodes[0]!));

      const requests = fetchMock.mock.calls.filter(
        ([url, init]) => init?.method === 'POST' && String(url).endsWith('/nodes/image-node/runs'),
      );
      expect(requests).toHaveLength(1);
      expect(JSON.parse(String(requests[0]![1]!.body)).parameters).toEqual({
        ...parameters,
        prompt: 'Summarize the sample.',
      });
      expect(view.canvas!.nodes[0]!.data.inferenceStrength).toBeUndefined();
    },
  );
});

describe('App 历史与共享保存快照', () => {
  /** 只读取合成项目的画布保存请求，不包含资源或真实 Provider 请求。 */
  function canvasRequests() {
    return fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith('/canvas') && init?.method === 'PATCH',
    );
  }

  it('长时间拖动不反复自动保存，松手后仍按 400ms 保存最新位置', async () => {
    await renderCanvas();
    const id = view.canvas!.nodes[0].id;
    vi.useFakeTimers();
    try {
      act(() => {
        view.canvas!.onNodeDragStart();
        view.canvas!.onNodesChange([
          { type: 'position', id, position: { x: 300, y: 180 }, dragging: true },
        ]);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(canvasRequests()).toHaveLength(0);
      act(() =>
        view.canvas!.onNodesChange([
          { type: 'position', id, position: { x: 420, y: 230 }, dragging: false },
        ]),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(399);
      });
      expect(canvasRequests()).toHaveLength(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(canvasRequests()).toHaveLength(1);
      expect(JSON.parse(String(canvasRequests()[0][1]?.body)).nodes[0].position).toEqual({
        x: 420,
        y: 230,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('连续 resize 的位置/尺寸事件合并为一次历史，下一轮 resize 独立撤销', async () => {
    await renderCanvas();
    const initial = view.canvas!.nodes[0];
    const resize = (width: number) => {
      act(() => view.canvas!.onResizeStart?.(initial.id));
      for (let step = 0; step < 5; step++) {
        act(() =>
          view.canvas!.onNodesChange([
            { type: 'position', id: initial.id, position: { x: 90 - step, y: 80 - step } },
            {
              type: 'dimensions',
              id: initial.id,
              resizing: true,
              setAttributes: true,
              dimensions: { width: width - 4 + step, height: 350 },
            },
          ]),
        );
      }
      act(() => view.canvas!.onResizeNode(initial.id, width, 350));
      act(() =>
        view.canvas!.onNodesChange([
          {
            type: 'dimensions',
            id: initial.id,
            resizing: false,
            dimensions: { width, height: 350 },
          },
        ]),
      );
    };
    resize(400);
    resize(500);
    act(() => view.canvas!.onUndoCanvas?.());
    expect(view.canvas!.nodes[0].width).toBe(400);
    act(() => view.canvas!.onUndoCanvas?.());
    expect(view.canvas!.nodes[0]).toMatchObject({
      width: initial.width,
      height: initial.height,
      position: initial.position,
    });
    expect(view.canvas!.canUndo).toBe(false);
    act(() => view.canvas!.onRedoCanvas?.());
    expect(view.canvas!.nodes[0].width).toBe(400);
    act(() => view.canvas!.onRedoCanvas?.());
    expect(view.canvas!.nodes[0].width).toBe(500);
  });

  it('多选拖动与删除恢复节点、连线和组成员，整组移动和解散也可撤销', async () => {
    canvas.edges = [
      {
        id: 'ab',
        sourceNodeId: 'empty-one',
        targetNodeId: 'empty-two',
        sourceHandle: 'output:content',
        targetHandle: 'input:content',
        order: 0,
      },
    ];
    canvas.groups = [
      {
        id: 'group-a',
        name: '组',
        position: { x: 0, y: 0 },
        width: 700,
        height: 500,
        nodeIds: ['empty-one', 'empty-two'],
      },
    ];
    await renderCanvas(1);
    act(() =>
      view.canvas!.onNodesChange(
        view.canvas!.nodes.map((node) => ({ type: 'select', id: node.id, selected: true })),
      ),
    );
    const positions = view.canvas!.nodes.map((node) => node.position);
    act(() => view.canvas!.onNodeDragStart());
    for (let step = 0; step < 4; step++) {
      act(() =>
        view.canvas!.onNodesChange(
          view.canvas!.nodes.map((node) => ({
            type: 'position',
            id: node.id,
            position: { x: 200 + step, y: 150 + step },
          })),
        ),
      );
    }
    act(() => view.canvas!.onUndoCanvas?.());
    expect(view.canvas!.nodes.map((node) => node.position)).toEqual(positions);
    act(() => view.canvas!.onRedoCanvas?.());
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(view.canvas!.nodes).toHaveLength(0);
    expect(view.canvas!.edges).toHaveLength(0);
    expect(view.canvas!.groups![0].nodeIds).toEqual([]);
    act(() => view.canvas!.onUndoCanvas?.());
    expect(view.canvas!.nodes).toHaveLength(2);
    expect(view.canvas!.edges).toHaveLength(1);
    expect(view.canvas!.groups![0].nodeIds).toEqual(['empty-one', 'empty-two']);
    act(() => view.canvas!.onGroupInteractionStart?.('group-a', 'move'));
    expect(view.canvas!.nodes.every((node) => node.dragging)).toBe(true);
    act(() => view.canvas!.onTranslateGroup?.('group-a', { x: 30, y: 40 }));
    act(() => view.canvas!.onGroupInteractionEnd?.());
    expect(view.canvas!.nodes.some((node) => node.dragging)).toBe(false);
    expect(view.canvas!.edges).toHaveLength(1);
    act(() => view.canvas!.onUndoCanvas?.());
    expect(view.canvas!.groups![0].position).toEqual({ x: 0, y: 0 });
    act(() => view.canvas!.onDissolveGroup?.('group-a'));
    expect(view.canvas!.groups).toHaveLength(0);
    act(() => view.canvas!.onUndoCanvas?.());
    expect(view.canvas!.groups).toHaveLength(1);
  });

  it('SSE 的进度、结果以及删除期间收到的完成事件不被用户撤销/重做回滚', async () => {
    let emit: Parameters<typeof auth.openAuthEventStream>[1] | undefined;
    vi.mocked(auth.openAuthEventStream).mockImplementation(async (_url, onEvent) => {
      emit = onEvent;
    });
    await renderCanvas();
    fillNode('empty-one', '用户编辑');
    const running = runRecord({
      id: 'run-one',
      targetNodeId: 'empty-one',
      status: 'running',
      progress: 60,
      error: undefined,
    });
    act(() => emit!('run.updated', JSON.stringify(running)));
    act(() => view.canvas!.onUndoCanvas?.());
    expect(view.canvas!.nodes[0].data).toMatchObject({ runStatus: 'running', runProgress: 60 });
    expect(view.canvas!.nodes[0].data.prompt).toBeUndefined();
    act(() => view.canvas!.onRedoCanvas?.());
    expect(view.canvas!.nodes[0].data).toMatchObject({ prompt: '用户编辑', runProgress: 60 });
    act(() => view.canvas!.onNodesChange([{ type: 'remove', id: 'empty-one' }]));
    const resultAsset = {
      assetId: 'synthetic-result',
      version: 1,
      contentUrl: '/synthetic/result',
    };
    act(() =>
      emit!(
        'run.updated',
        JSON.stringify({
          ...running,
          status: 'succeeded',
          progress: 100,
          updatedAt: '2026-10-02T00:01:00Z',
          result: { asset: resultAsset },
        }),
      ),
    );
    act(() => view.canvas!.onUndoCanvas?.());
    expect(view.canvas!.nodes[0].data).toMatchObject({
      prompt: '用户编辑',
      runStatus: 'succeeded',
      runProgress: 100,
      resultAsset,
    });
  });

  it('保存进行中继续编辑保留原请求，新编辑在下一修订串行保存', async () => {
    await renderCanvas();
    const api = fetchMock.getMockImplementation()!;
    const pending: Array<{ response: ReturnType<typeof pendingResponse>; body: CanvasDocument }> =
      [];
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/canvas') && init?.method === 'PATCH') {
        const response = pendingResponse();
        pending.push({ response, body: JSON.parse(String(init.body)) });
        return response.promise;
      }
      return api(input, init);
    });
    fillNode('empty-one', '第一次编辑');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(pending).toHaveLength(1));
    fillNode('empty-one', '保存中的新编辑');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(pending).toHaveLength(1);
    await act(async () =>
      pending[0].response.resolve(json({ canvas: { ...pending[0].body, revision: 2 } })),
    );
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].body.nodes[0].data.prompt).toBe('第一次编辑');
    expect(pending[1].body).toMatchObject({
      revision: 2,
      nodes: [{ data: { prompt: '保存中的新编辑' } }, expect.anything()],
    });
    await act(async () =>
      pending[1].response.resolve(json({ canvas: { ...pending[1].body, revision: 3 } })),
    );
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '已保存到项目' })).toBeInTheDocument(),
    );
    expect(pending).toHaveLength(2);
  });

  it('409 只重试冻结内容，重试期间的编辑仍在后续修订保存', async () => {
    await renderCanvas();
    const api = fetchMock.getMockImplementation()!;
    const retry = pendingResponse();
    const requests: CanvasDocument[] = [];
    let conflict = false;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/canvas') && init?.method === 'PATCH') {
        requests.push(JSON.parse(String(init.body)));
        if (requests.length === 1) {
          conflict = true;
          return Promise.resolve(json({ revision: 7 }, 409));
        }
        if (requests.length === 2) return retry.promise;
        return Promise.resolve(json({ canvas: { ...requests.at(-1), revision: 9 } }));
      }
      if (String(input).endsWith('/canvas') && conflict)
        return Promise.resolve(json({ canvas: { ...canvas, revision: 7 } }));
      return api(input, init);
    });
    fillNode('empty-one', '冲突前编辑');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual({ ...requests[0], revision: 7 });
    fillNode('empty-one', '重试中的编辑');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await act(async () => retry.resolve(json({ canvas: { ...requests[1], revision: 8 } })));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2].revision).toBe(8);
    expect(requests[2].nodes[0].data.prompt).toBe('重试中的编辑');
  });

  it('只修改组名也会触发既有 400ms 自动保存', async () => {
    canvas.groups = [
      {
        id: 'group-a',
        name: '原组名',
        position: { x: 0, y: 0 },
        width: 700,
        height: 500,
        nodeIds: [],
      },
    ];
    await renderCanvas();
    act(() => view.canvas!.onRenameGroup?.('group-a', '新组名'));
    await waitFor(() => expect(canvasRequests()).toHaveLength(1));
    expect(JSON.parse(String(canvasRequests()[0][1]?.body)).groups[0].name).toBe('新组名');
  });
});
