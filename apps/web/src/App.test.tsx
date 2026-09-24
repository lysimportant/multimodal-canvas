import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@multimodal-canvas/ui';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, CanvasDocument } from '@multimodal-canvas/domain';
import type { WorkflowCanvasProps } from './workspace/WorkflowCanvas';
import type { ResourcePanel } from './workspace/ResourcePanel';

/** 只替换重型画布视图，保留 App 的真实状态、请求与 Ant Design 交互。 */
const view = vi.hoisted(() => ({ canvas: null as WorkflowCanvasProps | null }));
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
  ResourcePanel: (props: ComponentProps<typeof ResourcePanel>) => (
    <section aria-label="测试资源库">
      {props.assets.map((asset) => (
        <Button type="button" key={asset.id} onClick={() => props.onRenameAsset(asset)}>
          重命名 {asset.name}
        </Button>
      ))}
    </section>
  ),
}));

import { App } from './App';
import * as auth from './auth-client';
import * as exports from './export-utils';
import {
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
/** 返回 JSON 响应并保留 HTTP 状态，供 App 的真实错误处理消费。 */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
let canvas: CanvasDocument;
let fetchMock: ReturnType<typeof vi.fn>;
let renameFailure: string | null;
let createFailure: string | null;
let saveFailure: string | null;

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
    if (name.endsWith('/runs') && method === 'GET') return json({ runs: [] });
    if (name.includes('/export/'))
      return new Response('export-fixture', {
        headers: { 'content-disposition': 'attachment; filename="workflow.json"' },
      });
    throw new Error('未声明的测试请求：' + method + ' ' + name);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** 等待画布和运行状态回填完毕，不使用空测试或固定时间替代加载断言。 */
async function renderCanvas() {
  const result = render(<App />);
  await screen.findByRole('region', { name: '测试画布' });
  await waitFor(() => expect(screen.getByRole('button', { name: '打开项目集合' })).toBeEnabled());
  await waitFor(() => expect(view.canvas?.clearCounts?.emptyNodes).toBe(2));
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
  renameFailure = null;
  createFailure = null;
  saveFailure = null;
  installApi();
});
afterEach(() => {
  cleanup();
  auth.clearAuthSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
});

describe('App 组件库迁移', () => {
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
