import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@multimodal-canvas/ui';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    if (name === '/v1/assets' && method === 'GET') return json({ assets: [asset] });
    if (name === '/v1/assets/' + asset.id && method === 'PATCH') {
      if (renameFailure) return json({ error: renameFailure }, 500);
      return json({ asset: { ...asset, ...JSON.parse(String(init?.body)) } });
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
    expect(screen.getByRole('button', { name: '运行中' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '打开命令面板' }));
    expect(screen.getByRole('option', { name: /运行「图片生成节点」/ })).toBeDisabled();
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
    '恢复 %s 任务后只禁用其节点，直接回调和重试也不能重复提交',
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
      expect(screen.getByRole('button', { name: '运行中' })).toBeDisabled();
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
      expect(screen.getByRole('button', { name: '运行中' })).toBeDisabled();
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
        { id: 'connected:' + asset.id, assetId: asset.id, mediaType: 'image', name: '主角' },
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
      { id: 'connected:' + asset.id, assetId: asset.id, mediaType: 'image', name: '配角' },
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
    expect(view.canvas!.nodes[1].data.resourceRefs).toEqual(firstAlias);
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
    const finalAlias = [{ ...firstAlias[0], name: '配角' }];
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
    await act(async () => finishRename!(json({ asset: { ...asset, name: '等待保存的名称' } })));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '重命名资源' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '重命名 等待保存的名称' })).toBeInTheDocument();
  });
});
