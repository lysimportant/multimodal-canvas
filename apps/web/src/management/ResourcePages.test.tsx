/** 资源列表衍生预览、取消释放和详情切换回归，全部使用合成资源。 */
import '@testing-library/jest-dom/vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../auth-client';
import { managementRequest } from './client';
import { ResourcesPage } from './ResourcePages';

vi.mock('../auth-client', async (original) => ({
  ...(await original<typeof import('../auth-client')>()),
  apiFetch: vi.fn(),
}));
vi.mock('./client', async (original) => ({
  ...(await original<typeof import('./client')>()),
  managementRequest: vi.fn(),
}));

/** 稳定的各媒体资源与服务端尺寸，避免依赖真实用户数据。 */
const assets = ['image', 'video', 'audio', 'text'].map((mediaType) => ({
  id: mediaType,
  name: `${mediaType}-resource`,
  mediaType,
  mimeType: mediaType === 'text' ? 'text/plain' : `${mediaType}/test`,
  sizeBytes: 5000,
  contentUrl: `/v1/assets/${mediaType}/content`,
  tags: [],
  status: 'ready',
  source: 'generated',
  ownerId: 'user',
  projectId: 'origin',
  createdAt: '2026-09-12T00:00:00Z',
  updatedAt: '2026-09-12T00:00:00Z',
  metadata: { width: 800, height: 1000 },
}));
/** 每个测试独立的查询缓存，结束时清理轮询。 */
let client: QueryClient;
/** jsdom 的 Blob 缺少 text，使用 Node Blob 模拟真实浏览器的读取能力。 */
function contentResponse(content: string): Response {
  return { ok: true, blob: async () => new NodeBlob([content]) } as unknown as Response;
}
/** 将列表挂载到与生产相同的查询上下文。 */
function renderResources({ userId = 'user', ownerId }: { userId?: string; ownerId?: string } = {}) {
  return render(
    <QueryClientProvider client={client}>
      <ResourcesPage userId={userId} ownerId={ownerId} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  window.history.replaceState(null, '', '/resources');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(managementRequest).mockReset();
  vi.mocked(managementRequest).mockImplementation(async (path) =>
    path.startsWith('/projects')
      ? { projects: [] }
      : path.includes('/resources?')
        ? { assets, total: assets.length, page: 1, pageSize: 24 }
        : { asset: assets.find((asset) => path.endsWith(asset.id)), versions: [] },
  );
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    contentResponse(String(path).endsWith('/text/content') ? '<b>纯文本摘录</b>' : 'image-bytes'),
  );
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:${Math.random()}`);
      static revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('资源内容预览', () => {
  it('列表只读取三种衍生图和有上限的纯文本，并保留尺寸比例', async () => {
    const view = renderResources();
    expect(await screen.findByText('<b>纯文本摘录</b>')).toBeVisible();
    const paths = vi.mocked(apiFetch).mock.calls.map(([path]) => String(path));
    for (const derivative of ['thumbnail', 'poster', 'waveform'])
      expect(paths.some((path) => path.endsWith(`?derivative=${derivative}`))).toBe(true);
    expect(paths.some((path) => /\/(video|audio)\/content$/.test(path))).toBe(false);
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/text/content'),
      expect.objectContaining({ headers: { Range: 'bytes=0-4095' } }),
    );
    expect(view.container.querySelector('.mg-resource-preview')).toHaveStyle({
      aspectRatio: '0.8',
    });
    expect(view.container.querySelector('.mg-resource-excerpt b')).toBeNull();
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(3));
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('离开可见区域取消在途读取，晚到内容不能生成对象 URL', async () => {
    const observers: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    let finish: ((value: Response) => void) | undefined;
    vi.mocked(apiFetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderResources();
    await screen.findByText('image-resource');
    expect(apiFetch).not.toHaveBeenCalled();
    act(() =>
      observers[0]!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(apiFetch).mock.calls[0]?.[1]?.signal;
    act(() =>
      observers[0]!(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => finish?.(contentResponse('late')));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('详情支持左右切换，输入框方向键不切换，Escape 关闭真实弹层', async () => {
    renderResources();
    fireEvent.click(await screen.findByRole('button', { name: /image-resource/ }));
    await screen.findByRole('dialog', { name: 'image-resource' });
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'image-resource' })).toBeVisible(),
    );
    expect(screen.getByRole('button', { name: '上一个资源' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('资源名称'), { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'image-resource' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一个资源' }));
    await screen.findByRole('dialog', { name: 'video-resource' });
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'video-resource' })).toBeVisible(),
    );
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/video\/content$/),
        expect.anything(),
      ),
    );
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    const dialog = await screen.findByRole('dialog', { name: 'image-resource' });
    await waitFor(() => expect(dialog).toBeVisible());
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('资源归属范围', () => {
  it('普通用户资源请求不发送可伪造的 ownerId', async () => {
    renderResources();
    await screen.findByText('image-resource');

    const resourcePath = vi
      .mocked(managementRequest)
      .mock.calls.map(([path]) => path)
      .find((path) => path.startsWith('/account/resources?'));
    expect(resourcePath).toBeDefined();
    expect(new URL(resourcePath!, 'http://canvas.test').searchParams.has('ownerId')).toBe(false);
  });

  it('管理员资源详情读取 resource-owners，并在列表请求中限定 ownerId', async () => {
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path === '/admin/resource-owners/owner-a') {
        return {
          user: {
            id: 'owner-a',
            displayName: '资源主人甲',
            role: 'user',
            status: 'active',
            createdAt: '2026-09-21T00:00:00.000Z',
          },
          projects: [],
          stats: { resourceCount: 0, storageBytes: 0, runCount: 0 },
        };
      }
      if (path.startsWith('/admin/resources?')) {
        return { assets: [], total: 0, page: 1, pageSize: 24 };
      }
      throw new Error(`未处理的测试请求：${path}`);
    });

    renderResources({ userId: 'admin-a', ownerId: 'owner-a' });
    expect(await screen.findByRole('heading', { name: '资源主人甲的资源' })).toBeVisible();
    expect(managementRequest).toHaveBeenCalledWith(
      '/admin/resource-owners/owner-a',
      expect.anything(),
    );
    const resourcePath = vi
      .mocked(managementRequest)
      .mock.calls.map(([path]) => path)
      .find((path) => path.startsWith('/admin/resources?'));
    expect(new URL(resourcePath!, 'http://canvas.test').searchParams.get('ownerId')).toBe(
      'owner-a',
    );
  });

  it('切换 owner 后，旧 owner 的迟到结果不能覆盖当前详情', async () => {
    let finishOld!: (value: unknown) => void;
    const oldOwner = new Promise((resolve) => {
      finishOld = resolve;
    });
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path === '/admin/resource-owners/owner-old') return oldOwner;
      if (path === '/admin/resource-owners/owner-new') {
        return {
          user: {
            id: 'owner-new',
            displayName: '当前资源主人',
            role: 'user',
            status: 'active',
            createdAt: '2026-09-21T00:00:00.000Z',
          },
          projects: [],
          stats: { resourceCount: 0, storageBytes: 0, runCount: 0 },
        };
      }
      if (path.startsWith('/admin/resources?')) {
        return { assets: [], total: 0, page: 1, pageSize: 24 };
      }
      throw new Error(`未处理的测试请求：${path}`);
    });
    const view = renderResources({ userId: 'admin-a', ownerId: 'owner-old' });
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith(
        '/admin/resource-owners/owner-old',
        expect.anything(),
      ),
    );

    view.rerender(
      <QueryClientProvider client={client}>
        <ResourcesPage userId="admin-a" ownerId="owner-new" />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: '当前资源主人的资源' })).toBeVisible();

    await act(async () => {
      finishOld({
        user: {
          id: 'owner-old',
          displayName: '迟到的旧主人',
          role: 'user',
          status: 'active',
          createdAt: '2026-09-21T00:00:00.000Z',
        },
        projects: [],
        stats: { resourceCount: 0, storageBytes: 0, runCount: 0 },
      });
    });
    expect(screen.getByRole('heading', { name: '当前资源主人的资源' })).toBeVisible();
    expect(screen.queryByText('迟到的旧主人')).toBeNull();
  });
});

/** 从真实非虚拟列表选择选项，不将 Select 替换为原生控件。 */
async function selectResourceOption(label: string, option: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: label })).toHaveAttribute('aria-expanded', 'false'),
  );
}

/** 当前测试中明确由用户提交的资源写操作。 */
function resourceWrites() {
  return vi.mocked(managementRequest).mock.calls.filter(([, init]) => init?.method === 'PATCH');
}

describe('资源库组件交互', () => {
  it('真实分页与全部筛选保持请求参数和身份缓存，筛选变化回到第一页', async () => {
    vi.mocked(managementRequest).mockImplementation(async (requestPath) => {
      if (requestPath.startsWith('/projects'))
        return { projects: [{ id: 'project-a', name: '项目甲' }] };
      if (requestPath.startsWith('/account/resources?')) {
        const params = new URL(requestPath, 'http://canvas.test').searchParams;
        return { assets, total: 48, page: Number(params.get('page')), pageSize: 24 };
      }
      throw new Error('未处理的请求：' + requestPath);
    });
    renderResources();
    await screen.findByText('共 48 项');
    fireEvent.click(screen.getByTitle('下一页'));
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith(
        expect.stringContaining('page=2'),
        expect.anything(),
      ),
    );
    await selectResourceOption('资源类型', '图片');
    await selectResourceOption('资源来源', '生成资源');
    await selectResourceOption('资源状态', '已归档');
    await selectResourceOption('所属项目', '项目甲');
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索资源' }), {
      target: { value: ' 测试资源 ' },
    });
    await userEvent.click(screen.getByRole('button', { name: '提交资源搜索' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '筛选资源标签' }), {
      target: { value: ' 标签甲， 标签乙,, ' },
    });
    await userEvent.click(screen.getByRole('button', { name: '应用标签筛选' }));
    await waitFor(() =>
      expect(
        client.getQueryData([
          'management',
          'user',
          'resources',
          'mine',
          '测试资源',
          'image',
          'generated',
          '标签甲,标签乙',
          'archived',
          'project-a',
          1,
        ]),
      ).toMatchObject({ total: 48 }),
    );
    const requestPath = vi
      .mocked(managementRequest)
      .mock.calls.map(([value]) => value)
      .filter((value) => value.startsWith('/account/resources?'))
      .at(-1)!;
    expect(Object.fromEntries(new URL(requestPath, 'http://canvas.test').searchParams)).toEqual({
      query: '测试资源',
      mediaType: 'image',
      source: 'generated',
      tags: '标签甲,标签乙',
      status: 'archived',
      projectId: 'project-a',
      page: '1',
      pageSize: '24',
    });
    expect(resourceWrites()).toHaveLength(0);
  });

  it('保存通过原生 submit 语义提交白名单字段，写入期间禁止关闭和重复提交', async () => {
    const read = vi.mocked(managementRequest).getMockImplementation()!;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(managementRequest).mockImplementation((requestPath, init) =>
      init?.method === 'PATCH' ? pending : read(requestPath, init),
    );
    renderResources();
    await userEvent.click(await screen.findByRole('button', { name: /image-resource/ }));
    const dialog = await screen.findByRole('dialog', { name: 'image-resource' });
    await waitFor(() => expect(dialog).toBeVisible());
    fireEvent.change(within(dialog).getByLabelText('资源名称'), {
      target: { value: ' 新资源名称 ' },
    });
    fireEvent.change(within(dialog).getByLabelText('标签'), {
      target: { value: ' 标签甲，标签甲, 标签乙 ' },
    });
    const save = within(dialog).getByRole('button', { name: '保存' });
    expect(save).toHaveAttribute('type', 'submit');
    await userEvent.click(save);
    expect(save).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '关闭弹窗' })).toBeDisabled();
    fireEvent.click(save);
    fireEvent.keyDown(dialog, { key: 'Escape', keyCode: 27 });
    expect(dialog).toBeVisible();
    expect(resourceWrites()).toEqual([
      [
        '/account/resources/image',
        { method: 'PATCH', body: { name: '新资源名称', tags: ['标签甲', '标签乙'] } },
      ],
    ]);
    await act(async () => {
      finish();
    });
    expect(await within(dialog).findByRole('status')).toHaveTextContent('资源信息已保存');
    expect(resourceWrites()).toHaveLength(1);
    expect(save).toBeEnabled();
  });

  it('保存失败保持错误与当前弹层，不重放 PATCH', async () => {
    const read = vi.mocked(managementRequest).getMockImplementation()!;
    vi.mocked(managementRequest).mockImplementation((requestPath, init) =>
      init?.method === 'PATCH'
        ? Promise.reject(new Error('此资源没有修改权限'))
        : read(requestPath, init),
    );
    renderResources();
    await userEvent.click(await screen.findByRole('button', { name: /image-resource/ }));
    const dialog = await screen.findByRole('dialog', { name: 'image-resource' });
    await waitFor(() => expect(dialog).toBeVisible());
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('此资源没有修改权限');
    expect(dialog).toBeVisible();
    expect(resourceWrites()).toHaveLength(1);
    expect(within(dialog).queryByText('资源信息已保存')).toBeNull();
  });

  it('归档需要确认，取消不写入，归档后可以恢复', async () => {
    let current = { ...assets[0]! };
    const read = vi.mocked(managementRequest).getMockImplementation()!;
    vi.mocked(managementRequest).mockImplementation(async (requestPath, init) => {
      if (requestPath === '/account/resources/image') {
        if (init?.method === 'PATCH')
          current = { ...current, ...(init.body as { status: string }) };
        return { asset: current, versions: [] };
      }
      return read(requestPath, init);
    });
    renderResources();
    await userEvent.click(await screen.findByRole('button', { name: /image-resource/ }));
    const dialog = await screen.findByRole('dialog', { name: 'image-resource' });
    await waitFor(() => expect(dialog).toBeVisible());
    await userEvent.click(within(dialog).getByRole('button', { name: '归档' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('可随时恢复');
    expect(resourceWrites()).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: /取\s*消/ }));
    expect(resourceWrites()).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: '归档' }));
    await userEvent.click(within(dialog).getByRole('button', { name: '确认归档' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('资源已归档');
    await userEvent.click(within(dialog).getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('资源已恢复'));
    expect(resourceWrites().map(([, init]) => init?.body)).toEqual([
      { status: 'archived' },
      { status: 'ready' },
    ]);
  });

  it.each([Array.from({ length: 33 }, (_, index) => '标签' + index).join(','), '长'.repeat(65)])(
    '标签越界时在前端明确报错，不写入资源（%#）',
    async (tags) => {
      renderResources();
      await userEvent.click(await screen.findByRole('button', { name: /image-resource/ }));
      const dialog = await screen.findByRole('dialog', { name: 'image-resource' });
      await waitFor(() => expect(dialog).toBeVisible());
      fireEvent.change(within(dialog).getByLabelText('标签'), { target: { value: tags } });
      await userEvent.click(within(dialog).getByRole('button', { name: '保存' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        '最多添加 32 个标签，每个标签不超过 64 个字符',
      );
      expect(resourceWrites()).toHaveLength(0);
    },
  );

  it('版本 Select 保持字符串请求值，选择器方向键不会切换资源', async () => {
    const read = vi.mocked(managementRequest).getMockImplementation()!;
    vi.mocked(managementRequest).mockImplementation((requestPath, init) =>
      requestPath === '/account/resources/image'
        ? Promise.resolve({
            asset: assets[0],
            versions: [{ version: 1, sizeBytes: 3, createdAt: '2026-09-12T00:00:00Z' }],
          })
        : read(requestPath, init),
    );
    renderResources();
    await userEvent.click(await screen.findByRole('button', { name: /image-resource/ }));
    await screen.findByRole('combobox', { name: '资源版本' });
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'image-resource' })).toBeVisible(),
    );
    fireEvent.keyDown(screen.getByRole('combobox', { name: '资源版本' }), { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'image-resource' })).toBeVisible();
    await selectResourceOption('资源版本', /版本 1/);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp('/image/content[?]version=1$')),
        expect.anything(),
      ),
    );
    expect(resourceWrites()).toHaveLength(0);
  });
});
