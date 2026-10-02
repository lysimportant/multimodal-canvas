import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Asset, CanvasDocument } from '@multimodal-canvas/domain';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResourcePanel } from './workspace/ResourcePanel';
import type { WorkflowCanvasProps } from './workspace/WorkflowCanvas';
import type { AssetFilter } from './workspace/contracts';

/** 只简化绘制层，保留真实 App、资源 hook、认证作用域、编辑历史和重命名弹窗。 */
const view = vi.hoisted(() => ({
  canvas: null as WorkflowCanvasProps | null,
  resource: null as ComponentProps<typeof ResourcePanel> | null,
}));
vi.mock('./workspace/WorkflowCanvas', () => ({
  WorkflowCanvas: (props: WorkflowCanvasProps) => {
    view.canvas = props;
    return (
      <section aria-label="分页测试画布">{props.nodes.map((node) => node.id).join(',')}</section>
    );
  },
}));
vi.mock('./workspace/ResourcePanel', () => ({
  ResourcePanel: (props: ComponentProps<typeof ResourcePanel>) => {
    view.resource = props;
    const pagination = props.pagination;
    const last = props.assets.at(-1);
    return (
      <section aria-label="分页测试资源栏">
        <input
          aria-label="资源搜索"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
        <select
          aria-label="资源类型"
          value={props.activeFilter}
          onChange={(event) => props.onFilterChange(event.target.value as AssetFilter)}
        >
          <option value="all">全部</option>
          <option value="text">文字</option>
          <option value="image">图片</option>
        </select>
        <button type="button" onClick={props.onToggleArchived}>
          {props.showArchived ? '查看可用资源' : '查看已归档资源'}
        </button>
        <button
          type="button"
          disabled={
            !pagination ||
            pagination.loading ||
            pagination.page * pagination.pageSize >= (pagination.total ?? 0)
          }
          onClick={() => pagination?.onPageChange(pagination.page + 1)}
        >
          下一页资源
        </button>
        <button
          type="button"
          disabled={!props.assets[0]}
          onClick={() => props.onAddAsset(props.assets[0])}
        >
          添加本页首项
        </button>
        <button type="button" disabled={!last} onClick={() => last && props.onRenameAsset(last)}>
          重命名本页末项
        </button>
        <button type="button" disabled={!last} onClick={() => last && props.onArchiveAsset(last)}>
          归档或恢复本页末项
        </button>
        <button
          type="button"
          disabled={!last || !props.onDeleteAsset}
          onClick={() => last && props.onDeleteAsset?.(last)}
        >
          永久删除本页末项
        </button>
        <output aria-label="当前资源页">{props.assets.map((asset) => asset.id).join(',')}</output>
      </section>
    );
  },
}));

import { App } from './App';
import * as auth from './auth-client';
import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from './state/workspace-preferences';

/** 合成项目及会话不包含凭据，所有网络入口均被内存 API 截获。 */
const project = {
  id: 'asset-pagination-project',
  name: '资源分页集成',
  createdAt: '2026-10-02T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
};
const session: auth.StoredAuthSession = {
  user: { id: 'asset-pagination-user', role: 'admin', createdAt: project.createdAt },
  expiresAt: '2099-01-01T00:00:00Z',
};
/** 记录实际请求顺序；测试失败时能区分画布重载、错误范围和多余分页读取。 */
type ApiRequest = { url: URL; method: string; body?: Record<string, unknown> };
let requests: ApiRequest[];
let unexpectedRequests: string[];
let catalog: Asset[];
let canvas: CanvasDocument;

/** 资源默认有明确版本，供跨页后画布来源和提及解析继续使用。 */
function makeAsset(index: number, status: Asset['status'] = 'ready'): Asset {
  return {
    id: `${status}-${index}`,
    name: `合成资源 ${index}`,
    mediaType: 'text',
    mimeType: 'text/plain',
    sizeBytes: 16,
    status,
    tags: [],
    latestVersion: 3,
    contentUrl: `/v1/assets/${status}-${index}/content`,
  };
}

/** 包含页外来源和冻结手动输出，检查 App 通过 canvasAssetSeeds 补齐索引而不伪造最新版。 */
function initialCanvas(): CanvasDocument {
  return {
    revision: 1,
    edges: [],
    nodes: [
      {
        id: 'editor',
        type: 'text',
        position: { x: 100, y: 100 },
        data: {
          label: '原始标题',
          mode: 'generate',
          mediaType: 'text',
          parameters: {},
          prompt: '原始提示词',
        },
      },
      {
        id: 'restored-source',
        type: 'text',
        position: { x: 300, y: 100 },
        data: {
          label: '页外来源快照',
          mode: 'source',
          mediaType: 'text',
          parameters: {},
          assetId: 'seed-source',
          mimeType: 'text/plain',
          contentUrl: '/v1/assets/seed-source/content',
        },
      },
      {
        id: 'restored-result',
        type: 'text',
        position: { x: 500, y: 100 },
        data: {
          label: '冻结结果快照',
          mode: 'generate',
          mediaType: 'text',
          parameters: {},
          manualOutput: true,
          assetId: 'seed-result',
          mimeType: 'text/plain',
          contentUrl: '/v1/assets/seed-result/versions/2/content',
        },
      },
    ],
  };
}

/** 只处理明确声明的合成端点，不回退到真实 fetch；意外请求即使被 UI 捕获也会使测试失败。 */
function installApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'http://localhost:3000',
      );
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      requests.push({ url, method, body });
      const path = url.pathname;
      if (method === 'GET') {
        if (path === '/v1/auth/me') return Response.json(session);
        if (path === '/v1/models') return Response.json({ models: [] });
        if (path === '/v1/settings/ai') return Response.json({ settings: { defaultModels: {} } });
        if (path === `/v1/projects/${project.id}/models/defaults`)
          return Response.json({ defaults: {} });
        if (path === '/v1/prompt-skills') return Response.json({ skills: [] });
        if (path === '/v1/projects') return Response.json({ projects: [project] });
        if (path === `/v1/projects/${project.id}`) return Response.json({ project });
        if (path === `/v1/projects/${project.id}/canvas`) return Response.json({ canvas });
        if (path === `/v1/projects/${project.id}/runs`) return Response.json({ runs: [] });
        if (path === '/v1/assets') {
          const page = Number(url.searchParams.get('page'));
          const pageSize = Number(url.searchParams.get('pageSize'));
          const status = url.searchParams.get('status');
          const mediaType = url.searchParams.get('mediaType');
          const query = (url.searchParams.get('query') ?? '').trim().toLowerCase();
          if (
            url.searchParams.get('projectId') !== project.id ||
            !Number.isInteger(page) ||
            page < 1 ||
            pageSize !== 50 ||
            !['ready', 'archived'].includes(status ?? '')
          ) {
            unexpectedRequests.push(`无效资源查询：${url.search}`);
            return Response.json({ error: '无效资源查询' }, { status: 400 });
          }
          const matching = catalog.filter(
            (asset) =>
              asset.status === status &&
              (!mediaType || asset.mediaType === mediaType) &&
              [asset.name, ...asset.tags].join(' ').toLowerCase().includes(query),
          );
          return Response.json({
            assets: matching.slice((page - 1) * pageSize, page * pageSize),
            total: matching.length,
            page,
            pageSize,
          });
        }
      }
      if (path === `/v1/projects/${project.id}/canvas` && method === 'PATCH') {
        canvas = { ...body, revision: canvas.revision + 1 } as CanvasDocument;
        return Response.json({ canvas });
      }
      const assetRoute = /^\/v1\/assets\/([^/]+)(?:\/(archive|restore))?$/.exec(path);
      if (assetRoute) {
        const asset = catalog.find((entry) => entry.id === assetRoute[1]);
        if (asset && method === 'PATCH' && !assetRoute[2] && typeof body?.name === 'string') {
          asset.name = body.name;
          return Response.json({ asset });
        }
        if (asset && method === 'POST' && assetRoute[2]) {
          asset.status = assetRoute[2] === 'archive' ? 'archived' : 'ready';
          return Response.json({ asset });
        }
        if (asset && method === 'DELETE' && !assetRoute[2]) {
          catalog = catalog.filter((entry) => entry.id !== asset.id);
          return new Response(null, { status: 204 });
        }
      }
      unexpectedRequests.push(`${method} ${path}`);
      throw new Error(`未声明的分页集成测试请求：${method} ${path}`);
    }),
  );
}

/** 只读取真实资源列表请求，避免将画布自动保存计入分页刷新。 */
function assetReads() {
  return requests.filter(({ url, method }) => method === 'GET' && url.pathname === '/v1/assets');
}
/** 画布只允许初始化一次；筛选、翻页或资源变更不能重新 GET。 */
function expectSingleCanvasLoad() {
  expect(
    requests.filter(
      ({ url, method }) => method === 'GET' && url.pathname === `/v1/projects/${project.id}/canvas`,
    ),
  ).toHaveLength(1);
}
/** 等待真实 hook 完成指定页，不能仅以本地页码切换当作加载成功。 */
async function expectPage(page: number, total: number) {
  await waitFor(() =>
    expect(view.resource?.pagination).toMatchObject({
      page,
      total,
      pageSize: 50,
      loading: false,
      error: null,
    }),
  );
}
/** 挂载真实 App，并等待画布、种子索引和首次资源查询一起就绪。 */
async function renderApp(total: number) {
  render(<App />);
  await screen.findByRole('region', { name: '分页测试画布' });
  await waitFor(() =>
    expect(view.canvas?.nodes.map((node) => node.id)).toEqual(canvas.nodes.map((node) => node.id)),
  );
  await expectPage(1, total);
  expectSingleCanvasLoad();
}
/** 通过真实编辑回调提交选中、标题、位置和提示词，后续查询必须保留这些变更。 */
function editCanvas() {
  act(() => view.canvas!.onNodeSelect(view.canvas!.nodes.find((node) => node.id === 'editor')!));
  act(() => {
    view.canvas!.onNodeLabelChange!('editor', '分页期间保留的标题');
    view.canvas!.onPromptDocumentChange!(
      { version: 1, blocks: [{ type: 'text', text: '分页期间保留的提示词' }] },
      'editor',
    );
    view.canvas!.onNodesChange([
      { type: 'position', id: 'editor', position: { x: 720, y: 360 }, dragging: false },
    ]);
  });
}
/** 同时检查选中身份和编辑内容，避免只看资源页而漏掉隐式画布重置。 */
function expectEditsPreserved() {
  expect(view.canvas?.selectedNode?.id).toBe('editor');
  expect(view.canvas?.nodes.find((node) => node.id === 'editor')).toMatchObject({
    position: { x: 720, y: 360 },
    data: {
      label: '分页期间保留的标题',
      prompt: '分页期间保留的提示词',
      promptDocument: { version: 1, blocks: [{ type: 'text', text: '分页期间保留的提示词' }] },
    },
  });
  expectSingleCanvasLoad();
}

beforeEach(() => {
  window.history.replaceState(null, '', `/projects/${project.id}`);
  localStorage.clear();
  auth.clearAuthSession();
  auth.persistAuthSession(session);
  vi.spyOn(auth, 'fetchCurrentSession').mockResolvedValue(session);
  vi.spyOn(auth, 'openAuthEventStream').mockResolvedValue(undefined);
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  view.canvas = null;
  view.resource = null;
  requests = [];
  unexpectedRequests = [];
  catalog = [];
  canvas = initialCanvas();
  installApi();
});
afterEach(() => {
  cleanup();
  auth.clearAuthSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  expect(unexpectedRequests).toEqual([]);
});

describe('App 资源分页集成', () => {
  it('首页到第二页再跨页搜索、类型及归档切换，保留编辑、选择和已知资源且只加载一次画布', async () => {
    catalog = Array.from({ length: 101 }, (_, i) => makeAsset(i + 1));
    catalog[99].tags = ['跨页匹配'];
    catalog[100] = {
      ...catalog[100],
      mediaType: 'image',
      mimeType: 'image/png',
      tags: ['跨页匹配'],
    };
    const archived = {
      ...makeAsset(1, 'archived'),
      mediaType: 'image' as const,
      mimeType: 'image/png',
      tags: ['跨页匹配'],
    };
    catalog.push(archived);
    await renderApp(101);
    expect(view.resource!.assets).toHaveLength(50);
    expect(view.canvas!.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'seed-source',
          contentUrl: '/v1/assets/seed-source/content',
        }),
        expect.objectContaining({
          id: 'seed-result',
          contentUrl: '/v1/assets/seed-result/versions/2/content',
        }),
      ]),
    );
    expect(
      view.canvas!.assets!.find((asset) => asset.id === 'seed-result')?.latestVersion,
    ).toBeUndefined();
    expect(view.canvas!.assets!.some((asset) => asset.id === 'ready-101')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '添加本页首项' }));
    const addedNode = view.canvas!.nodes.find((node) => node.data.assetId === 'ready-1')!;
    expect(addedNode).toBeDefined();
    editCanvas();
    fireEvent.click(screen.getByRole('button', { name: '下一页资源' }));
    await expectPage(2, 101);
    expect(view.resource!.assets[0].id).toBe('ready-51');
    expectEditsPreserved();
    expect(view.canvas!.assets!.some((asset) => asset.id === 'ready-1')).toBe(true);
    expect(view.canvas!.assets!.some((asset) => asset.id === 'ready-101')).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: '资源搜索' }), {
      target: { value: '跨页匹配' },
    });
    await expectPage(1, 2);
    expect(view.resource!.assets.map((asset) => asset.id)).toEqual(['ready-100', 'ready-101']);
    expect(assetReads().at(-1)!.url.searchParams.get('query')).toBe('跨页匹配');
    expectEditsPreserved();
    fireEvent.change(screen.getByRole('combobox', { name: '资源类型' }), {
      target: { value: 'image' },
    });
    await expectPage(1, 1);
    expect(view.resource!.assets.map((asset) => asset.id)).toEqual(['ready-101']);
    expect(assetReads().at(-1)!.url.searchParams.get('mediaType')).toBe('image');
    expectEditsPreserved();
    fireEvent.click(screen.getByRole('button', { name: '查看已归档资源' }));
    await waitFor(() =>
      expect(view.resource!.assets.map((asset) => asset.id)).toEqual([archived.id]),
    );
    await expectPage(1, 1);
    expect(assetReads().at(-1)!.url.searchParams.get('status')).toBe('archived');
    expect(view.canvas!.assets!.map((asset) => asset.id)).toEqual(
      expect.arrayContaining([
        'ready-1',
        'ready-50',
        'ready-100',
        'ready-101',
        archived.id,
        'seed-source',
        'seed-result',
      ]),
    );
    expect(view.canvas!.nodes.find((node) => node.id === addedNode.id)?.data.assetId).toBe(
      'ready-1',
    );
    expect(assetReads().map(({ url }) => url.searchParams.get('page'))).toEqual([
      '1',
      '2',
      '1',
      '1',
      '1',
    ]);
    expectEditsPreserved();
  });

  it('重命名刷新当前页，归档尾页最后一项后退回有效页，并更新而不替换已知索引', async () => {
    catalog = Array.from({ length: 51 }, (_, i) => makeAsset(i + 1));
    await renderApp(51);
    editCanvas();
    fireEvent.click(screen.getByRole('button', { name: '下一页资源' }));
    await expectPage(2, 51);
    expect(view.resource!.assets.map((asset) => asset.id)).toEqual(['ready-51']);
    fireEvent.click(screen.getByRole('button', { name: '重命名本页末项' }));
    const dialog = await screen.findByRole('dialog', { name: '重命名资源' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '资源名称' }), {
      target: { value: '新的尾页资源名称' },
    });
    const beforeRename = assetReads().length;
    fireEvent.click(within(dialog).getByRole('button', { name: '保存名称' }));
    await waitFor(() => expect(view.resource!.assets[0]?.name).toBe('新的尾页资源名称'));
    await expectPage(2, 51);
    expect(
      requests
        .filter(({ method, url }) => method === 'PATCH' && url.pathname === '/v1/assets/ready-51')
        .map(({ body }) => body),
    ).toEqual([{ name: '新的尾页资源名称' }]);
    expect(
      assetReads()
        .slice(beforeRename)
        .map(({ url }) => url.searchParams.get('page')),
    ).toEqual(['2']);
    expect(view.canvas!.assets!.find((asset) => asset.id === 'ready-51')?.name).toBe(
      '新的尾页资源名称',
    );
    const beforeArchive = assetReads().length;
    fireEvent.click(screen.getByRole('button', { name: '归档或恢复本页末项' }));
    await expectPage(1, 50);
    expect(
      requests.filter(
        ({ method, url }) => method === 'POST' && url.pathname === '/v1/assets/ready-51/archive',
      ),
    ).toHaveLength(1);
    expect(
      assetReads()
        .slice(beforeArchive)
        .map(({ url }) => url.searchParams.get('page')),
    ).toEqual(['2', '1']);
    expect(view.resource!.assets).toHaveLength(50);
    expect(view.canvas!.assets!.find((asset) => asset.id === 'ready-51')).toMatchObject({
      name: '新的尾页资源名称',
      status: 'archived',
    });
    expect(view.canvas!.assets!.some((asset) => asset.id === 'ready-1')).toBe(true);
    expectEditsPreserved();
  });

  it('永久删除归档尾页资源接受 204 并退页，仅移除该索引项而不重载画布或重新 seed 已删除项', async () => {
    catalog = Array.from({ length: 51 }, (_, i) => makeAsset(i + 1, 'archived'));
    canvas.nodes[1].data.assetId = 'archived-51';
    canvas.nodes[1].data.contentUrl = '/v1/assets/archived-51/content';
    await renderApp(0);
    editCanvas();
    fireEvent.click(screen.getByRole('button', { name: '查看已归档资源' }));
    await expectPage(1, 51);
    fireEvent.click(screen.getByRole('button', { name: '下一页资源' }));
    await expectPage(2, 51);
    expect(view.resource!.assets.map((asset) => asset.id)).toEqual(['archived-51']);
    const beforeDelete = assetReads().length;
    fireEvent.click(screen.getByRole('button', { name: '永久删除本页末项' }));
    await expectPage(1, 50);
    expect(
      requests.filter(
        ({ method, url }) => method === 'DELETE' && url.pathname === '/v1/assets/archived-51',
      ),
    ).toHaveLength(1);
    expect(
      assetReads()
        .slice(beforeDelete)
        .map(({ url }) => [url.searchParams.get('page'), url.searchParams.get('status')]),
    ).toEqual([
      ['2', 'archived'],
      ['1', 'archived'],
    ]);
    expect(view.canvas!.assets!.some((asset) => asset.id === 'archived-51')).toBe(false);
    expect(view.canvas!.assets!.some((asset) => asset.id === 'archived-1')).toBe(true);
    expect(view.canvas!.nodes.find((node) => node.id === 'restored-source')?.data.assetId).toBe(
      'archived-51',
    );
    expectEditsPreserved();
  });
});
