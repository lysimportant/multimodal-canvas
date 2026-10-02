import { act, cleanup, renderHook } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from './canvas-utils';

import {
  apiFetch,
  clearAuthSession,
  getAuthSessionGeneration,
  persistAuthSession,
} from './auth-client';
import {
  PROJECT_ASSET_PAGE_SIZE,
  PROJECT_ASSET_SEARCH_DELAY_MS,
  useProjectAssets,
  canvasAssetSeeds,
  type ProjectAssetOptions,
} from './use-project-assets';

vi.mock('./auth-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth-client')>()),
  apiFetch: vi.fn(),
}));

/** 控制响应到达次序；有意不自动响应 AbortSignal，以覆盖迟到正文。 */
type PendingRequest = {
  url: URL;
  signal: AbortSignal;
  generation: number | undefined;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
};
const requests: PendingRequest[] = [];
/** 全部资源和身份均为合成夹具，不访问任何服务。 */
const options: ProjectAssetOptions = {
  projectId: 'project-a',
  userId: 'user-a',
  query: '',
  activeFilter: 'all',
  showArchived: false,
};

/** 创建符合现有领域合同的资源元数据。 */
function asset(id: string, patch: Partial<Asset> = {}): Asset {
  return {
    id,
    name: id,
    mediaType: 'text',
    mimeType: 'text/plain',
    sizeBytes: 10,
    status: 'ready',
    contentUrl: `/v1/assets/${id}/content`,
    tags: [],
    ...patch,
  };
}
/** 模拟真实身份通知，覆盖账号和权限代次，而不是只改变 hook 参数。 */
function login(id = 'user-a', role: 'user' | 'admin' = 'user') {
  persistAuthSession({ user: { id, role, createdAt: '2026-10-02T00:00:00Z' } });
}
/** 为请求指定响应的分页与总数；不隐式拉取其他页。 */
async function respond(index: number, assets: Asset[], total = assets.length, page = 1) {
  await reply(index, { assets, total, page, pageSize: PROJECT_ASSET_PAGE_SIZE });
}
/** 允许构造 HTTP 失败和非法正文，不隐藏服务端错误。 */
async function reply(index: number, body: unknown, status = 200) {
  await act(async () => requests[index].resolve(new Response(JSON.stringify(body), { status })));
}
/** 推进防抖并清空异步回调，避免测试依赖真实等待。 */
async function tick(ms = PROJECT_ASSET_SEARCH_DELAY_MS) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  requests.length = 0;
  login();
  vi.mocked(apiFetch).mockImplementation(
    (input, init, context) =>
      new Promise((resolve, reject) => {
        requests.push({
          url: new URL(String(input)),
          signal: init!.signal as AbortSignal,
          generation: context?.expectedAuthGeneration,
          resolve,
          reject,
        });
      }),
  );
});
afterEach(() => {
  cleanup();
  clearAuthSession();
  vi.useRealTimers();
});

describe('useProjectAssets 分页与已知索引', () => {
  it('只请求显式页并累积已知资源，保持 total 和未改变 props 的引用', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
      projectId: 'project-a',
      status: 'ready',
      page: '1',
      pageSize: String(PROJECT_ASSET_PAGE_SIZE),
    });
    expect(requests[0].generation).toBe(getAuthSessionGeneration());
    await respond(0, [asset('selected')], 81);
    await tick(10_000);
    expect(requests).toHaveLength(1);
    const first = hook.result.current;
    hook.rerender({ ...options });
    expect(hook.result.current.pagination).toBe(first.pagination);
    expect(hook.result.current.knownAssets).toBe(first.knownAssets);
    act(() => hook.result.current.pagination.onPageChange(2));
    expect(hook.result.current.pageAssets).toEqual([]);
    expect(hook.result.current.knownAssets).toEqual([asset('selected')]);
    expect(requests[1].url.searchParams.get('page')).toBe('2');
    await respond(1, [asset('other-page')], 81, 2);
    expect(hook.result.current.pageAssets.map((a) => a.id)).toEqual(['other-page']);
    expect(hook.result.current.knownAssets.map((a) => a.id)).toEqual(['selected', 'other-page']);
    expect(hook.result.current.pagination).toMatchObject({ page: 2, total: 81, loading: false });
  });

  it('类型、搜索和归档都在服务端过滤并回到第一页，已知索引不被搜索结果替换', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await respond(0, [asset('kept')], 101);
    act(() => hook.result.current.pagination.onPageChange(3));
    await respond(1, [asset('last')], 101, 3);
    hook.rerender({
      ...options,
      activeFilter: 'image',
      query: '  标签 & #中文  ',
      showArchived: true,
    });
    expect(hook.result.current.pagination.page).toBe(1);
    expect(hook.result.current.pageAssets).toEqual([]);
    await tick();
    expect(Object.fromEntries(requests[2].url.searchParams)).toEqual({
      projectId: 'project-a',
      status: 'archived',
      mediaType: 'image',
      query: '标签 & #中文',
      page: '1',
      pageSize: String(PROJECT_ASSET_PAGE_SIZE),
    });
    const archived = asset('name-does-not-match', { status: 'archived', mediaType: 'image' });
    await respond(2, [archived]);
    expect(hook.result.current.pageAssets).toEqual([archived]);
    expect(hook.result.current.knownAssets.map((a) => a.id)).toEqual(['kept', 'last', archived.id]);
    hook.rerender(options);
    expect(hook.result.current.pagination.page).toBe(1);
    await tick();
    expect(requests[3].url.searchParams.get('mediaType')).toBeNull();
    expect(requests[3].url.searchParams.get('status')).toBe('ready');
    expect(requests[3].url.searchParams.get('query')).toBeNull();
  });

  it('防抖期间立即作废旧搜索响应，连续输入只发送最终查询', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await respond(0, [asset('initial')]);
    hook.rerender({ ...options, query: 'old' });
    await tick();
    hook.rerender({ ...options, query: 'n' });
    expect(requests[1].signal.aborted).toBe(true);
    await respond(1, [asset('stale-search')]);
    expect(hook.result.current.pageAssets).toEqual([]);
    expect(hook.result.current.knownAssets.map((a) => a.id)).toEqual(['initial']);
    await tick(100);
    hook.rerender({ ...options, query: 'new' });
    await tick(PROJECT_ASSET_SEARCH_DELAY_MS - 1);
    expect(requests).toHaveLength(2);
    await tick(1);
    expect(requests[2].url.searchParams.get('query')).toBe('new');
    await respond(2, [asset('new')]);
    expect(hook.result.current.pageAssets).toEqual([asset('new')]);
  });

  it('旧搜索失败不得覆盖更新查询的成功结果', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    hook.rerender({ ...options, query: 'new' });
    await tick();
    await respond(1, [asset('new')]);
    await act(async () => requests[0].reject(new Error('old error')));
    expect(hook.result.current.pagination.error).toBeNull();
    expect(hook.result.current.pageAssets).toEqual([asset('new')]);
  });

  it('业务修改刷新列表且不被在途旧正文覆盖；归档保留索引，永久删除移除', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await respond(0, [asset('one'), asset('two')]);
    act(() => hook.result.current.reload());
    const archived = asset('one', { name: '已改名', status: 'archived' });
    act(() => hook.result.current.upsertAssets([archived]));
    await respond(1, [asset('one'), asset('two')]);
    expect(hook.result.current.knownAssets.find((a) => a.id === 'one')).toEqual(archived);
    await respond(2, [asset('two')]);
    expect(hook.result.current.pageAssets).toEqual([asset('two')]);
    expect(hook.result.current.knownAssets).toHaveLength(2);
    act(() => hook.result.current.removeAsset('one'));
    await respond(3, [asset('two')]);
    expect(hook.result.current.knownAssets).toEqual([asset('two')]);
    act(() => hook.result.current.upsertAssets([asset('uploaded')]));
    await respond(4, [asset('uploaded'), asset('two')]);
    expect(hook.result.current.knownAssets).toHaveLength(2);
  });

  it('归档或删除造成尾页越界时重新请求最后有效页', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await respond(0, [asset('first')], 101);
    act(() => hook.result.current.pagination.onPageChange(3));
    await respond(1, [asset('last')], 101, 3);
    act(() => hook.result.current.removeAsset('last'));
    await respond(2, [], 100, 3);
    expect(hook.result.current.pagination.page).toBe(2);
    expect(hook.result.current.pagination.loading).toBe(true);
    expect(requests[3].url.searchParams.get('page')).toBe('2');
    await respond(3, [asset('second')], 100, 2);
    expect(hook.result.current.pageAssets).toEqual([asset('second')]);
    expect(hook.result.current.knownAssets.map((a) => a.id)).toEqual(['first', 'second']);
  });

  it('拒绝无效页码，过大的页码限制到末页', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await respond(0, [], 80);
    for (const page of [0, -1, 1.5, Infinity, NaN])
      act(() => hook.result.current.pagination.onPageChange(page));
    expect(requests).toHaveLength(1);
    act(() => hook.result.current.pagination.onPageChange(999));
    expect(requests[1].url.searchParams.get('page')).toBe('2');
  });
});

describe('useProjectAssets 作用域和权限', () => {
  it('跨项目清空索引和页码；切回同一项目也不接收旧作用域的业务回调', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await respond(0, [asset('a')], 80);
    const old = hook.result.current;
    act(() => old.pagination.onPageChange(2));
    hook.rerender({ ...options, projectId: 'project-b' });
    expect(hook.result.current.pageAssets).toEqual([]);
    expect(hook.result.current.knownAssets).toEqual([]);
    expect(hook.result.current.pagination.page).toBe(1);
    expect(requests[1].signal.aborted).toBe(true);
    await respond(2, [asset('b')]);
    await respond(1, [asset('old-a')], 80, 2);
    expect(hook.result.current.pageAssets).toEqual([asset('b')]);
    hook.rerender(options);
    await respond(3, [asset('fresh-a')]);
    act(() => {
      old.seedAssets([asset('old-source')]);
      old.upsertAssets([asset('old-upload')]);
      old.removeAsset('fresh-a');
      old.reload();
    });
    expect(requests).toHaveLength(4);
    expect(hook.result.current.knownAssets).toEqual([asset('fresh-a')]);
    expect(requests.every((request) => request.url.searchParams.has('projectId'))).toBe(true);
  });

  it.each([
    { ...options, projectId: null },
    { ...options, userId: null },
    { ...options, userId: 'other-user' },
  ])('缺少有效项目或身份时禁止请求：%j', (input) => {
    const hook = renderHook(() => useProjectAssets(input));
    expect(requests).toHaveLength(0);
    expect(hook.result.current.pagination.loading).toBe(false);
    expect(hook.result.current.knownAssets).toEqual([]);
  });

  it('退出登录无需等待父级重渲染就清空列表、索引并中断请求', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await respond(0, [asset('private')]);
    const seedBeforeLogout = hook.result.current.seedAssets;
    act(() => hook.result.current.reload());
    act(() => clearAuthSession());
    act(() => seedBeforeLogout([asset('old-private-source')]));
    expect(hook.result.current.pageAssets).toEqual([]);
    expect(hook.result.current.knownAssets).toEqual([]);
    expect(hook.result.current.pagination.loading).toBe(false);
    expect(requests[1].signal.aborted).toBe(true);
    await respond(1, [asset('private-late')]);
    await tick(10_000);
    expect(hook.result.current.knownAssets).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('同账号权限变更隔离已返回响应头但尚未解析的正文', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    let resolveBody!: (body: unknown) => void;
    await act(async () =>
      requests[0].resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((resolve) => {
            resolveBody = resolve;
          }),
      } as Response),
    );
    act(() => login('user-a', 'admin'));
    expect(requests).toHaveLength(2);
    await respond(1, [asset('new-role')]);
    await act(async () =>
      resolveBody({
        assets: [asset('old-role')],
        total: 1,
        page: 1,
        pageSize: PROJECT_ASSET_PAGE_SIZE,
      }),
    );
    expect(hook.result.current.knownAssets).toEqual([asset('new-role')]);
    act(() => login('user-b'));
    expect(hook.result.current.knownAssets).toEqual([]);
    expect(requests).toHaveLength(2);
    hook.rerender({ ...options, userId: 'user-b' });
    await respond(2, [asset('new-user')]);
    expect(hook.result.current.knownAssets).toEqual([asset('new-user')]);
  });

  it.each([401, 403, 404])('权限拒绝 %s 清空索引，不扩大范围或自动重试', async (status) => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await respond(0, [asset('private')]);
    act(() => hook.result.current.reload());
    await reply(1, { error: 'denied' }, status);
    expect(hook.result.current.knownAssets).toEqual([]);
    expect(hook.result.current.pageAssets).toEqual([]);
    expect(hook.result.current.pagination.error).toBe(
      status === 404 ? '项目不存在或无权访问' : 'denied',
    );
    await tick(30_000);
    expect(requests).toHaveLength(2);
    act(() => hook.result.current.pagination.onRetry());
    expect(requests[2].url.toString()).toBe(requests[1].url.toString());
    await respond(2, [asset('allowed')]);
    expect(hook.result.current.knownAssets).toEqual([asset('allowed')]);
  });

  it('卸载中断读取和防抖，卸载后的业务回调不再发请求', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    const old = hook.result.current;
    hook.rerender({ ...options, query: 'pending' });
    hook.unmount();
    await tick();
    old.seedAssets([asset('late-source')]);
    old.upsertAssets([asset('late')]);
    old.reload();
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests).toHaveLength(1);
  });
});

describe('useProjectAssets 失败和输入边界', () => {
  it.each(['network', 'server'])('加载失败 %s 保留已知资源，显式重试恢复', async (failure) => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await respond(0, [asset('kept')], 80);
    act(() => hook.result.current.pagination.onPageChange(2));
    if (failure === 'network') await act(async () => requests[1].reject(new Error('连接中断')));
    else await reply(1, { error: '服务不可用' }, 503);
    expect(hook.result.current.pagination).toMatchObject({ page: 2, total: null, loading: false });
    expect(hook.result.current.pagination.error).toBe(
      failure === 'network' ? '连接中断' : '服务不可用',
    );
    expect(hook.result.current.knownAssets).toEqual([asset('kept')]);
    expect(hook.result.current.pageAssets).toEqual([]);
    act(() => hook.result.current.pagination.onRetry());
    await respond(2, [asset('recovered')], 80, 2);
    expect(hook.result.current.pageAssets).toEqual([asset('recovered')]);
  });

  it.each([
    { total: -1 },
    { total: '100' },
    { page: 2 },
    { pageSize: 200 },
    { assets: [{ id: 'broken' }] },
  ])('拒绝无效分页合同：%j', async (patch) => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await reply(0, { assets: [], total: 0, page: 1, pageSize: PROJECT_ASSET_PAGE_SIZE, ...patch });
    expect(hook.result.current.pagination.error).toBe('资源分页响应格式无效');
    expect(hook.result.current.knownAssets).toEqual([]);
  });

  it('搜索超出 API 长度上限时显式报错，不截断后偷偷搜索', async () => {
    const hook = renderHook(useProjectAssets, {
      initialProps: { ...options, query: 'a'.repeat(513) },
    });
    expect(requests).toHaveLength(0);
    expect(hook.result.current.pagination.error).toBe('搜索内容不能超过 512 个字符');
    hook.rerender({ ...options, query: '' });
    await tick();
    await respond(0, []);
    expect(hook.result.current.pagination).toMatchObject({ total: 0, error: null, loading: false });
  });
});

describe('useProjectAssets 旧列表协议兼容', () => {
  it('仅有 assets 的有效旧响应作为完整列表切页，已知索引保留所有资源', async () => {
    const all = Array.from({ length: 85 }, (_, i) => asset(`legacy-${i}`));
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await reply(0, { assets: all });
    expect(hook.result.current.pagination.total).toBe(85);
    expect(hook.result.current.pageAssets).toEqual(all.slice(0, PROJECT_ASSET_PAGE_SIZE));
    expect(hook.result.current.knownAssets).toEqual(all);
    act(() => hook.result.current.pagination.onPageChange(2));
    await reply(1, { assets: all });
    expect(hook.result.current.pageAssets).toEqual(
      all.slice(PROJECT_ASSET_PAGE_SIZE, PROJECT_ASSET_PAGE_SIZE * 2),
    );
    expect(hook.result.current.knownAssets).toHaveLength(85);
  });

  it('旧协议本地筛选兼容名称、标签、别名、类型和归档，现代结果不进入此分支', async () => {
    const target = asset('target', {
      mediaType: 'image',
      status: 'archived',
      metadata: { aliases: ['SEARCHABLE'] },
    });
    const all = [asset('hidden'), asset('ready-image', { mediaType: 'image' }), target];
    const hook = renderHook(useProjectAssets, {
      initialProps: {
        ...options,
        query: 'searchable',
        activeFilter: 'image' as const,
        showArchived: true,
      },
    });
    await reply(0, { assets: all });
    expect(hook.result.current.pageAssets).toEqual([target]);
    expect(hook.result.current.pagination.total).toBe(1);
    expect(hook.result.current.knownAssets).toEqual(all);
  });

  it.each([
    { assets: [], page: 1 },
    { assets: [], pageSize: 50 },
    { assets: [], total: 0 },
    { assets: [], page: null },
    { assets: [], error: 'failed' },
    { assets: 'invalid' },
  ])('残缺 metadata 或错误正文不能伪装为旧成功响应：%j', async (body) => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await reply(0, body);
    expect(hook.result.current.pagination.error).toBe('资源分页响应格式无效');
    expect(hook.result.current.pageAssets).toEqual([]);
  });
});

describe('useProjectAssets App 集成边界', () => {
  it('默认首页保持 50 项，未翻页也能解析原先第 41–50 项资源', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => asset(`source-${i + 1}`));
    const hook = renderHook(useProjectAssets, { initialProps: options });
    expect(PROJECT_ASSET_PAGE_SIZE).toBe(50);
    expect(requests[0].url.searchParams.get('pageSize')).toBe('50');
    await respond(0, firstPage, 150);
    expect(hook.result.current.pageAssets).toEqual(firstPage);
    expect(hook.result.current.knownAssets.slice(40, 50)).toEqual(firstPage.slice(40, 50));
    expect(requests).toHaveLength(1);
  });

  it('查询、类型、归档、翻页和刷新不改变 reload 引用，也不重跑依赖它的画布初始化', async () => {
    const loadProjectCanvas = vi.fn();
    const hook = renderHook(
      (input: ProjectAssetOptions) => {
        const resources = useProjectAssets(input);
        useEffect(() => {
          loadProjectCanvas();
        }, [resources.reload]);
        return resources;
      },
      { initialProps: options },
    );
    const reload = hook.result.current.reload;
    const seedAssets = hook.result.current.seedAssets;
    await respond(0, [asset('first')], 101);
    act(() => hook.result.current.pagination.onPageChange(2));
    expect(hook.result.current.reload).toBe(reload);
    await respond(1, [asset('second')], 101, 2);
    hook.rerender({ ...options, query: '新的搜索' });
    expect(hook.result.current.reload).toBe(reload);
    await tick();
    await respond(2, [asset('search-result')]);
    hook.rerender({ ...options, query: '新的搜索', activeFilter: 'image' });
    expect(hook.result.current.reload).toBe(reload);
    const image = asset('image', { mediaType: 'image' });
    await respond(3, [image]);
    hook.rerender({ ...options, query: '新的搜索', activeFilter: 'image', showArchived: true });
    expect(hook.result.current.reload).toBe(reload);
    const archived = { ...image, status: 'archived' as const };
    await respond(4, [archived]);
    expect(hook.result.current.seedAssets).toBe(seedAssets);
    act(() => reload());
    expect(Object.fromEntries(requests[5].url.searchParams)).toEqual({
      projectId: 'project-a',
      page: '1',
      pageSize: '50',
      query: '新的搜索',
      mediaType: 'image',
      status: 'archived',
    });
    await respond(5, [archived]);
    act(() => seedAssets([asset('explicit-source')]));
    expect(requests).toHaveLength(6);
    expect(hook.result.current.reload).toBe(reload);
    expect(loadProjectCanvas).toHaveBeenCalledTimes(1);
    hook.rerender({ ...options, projectId: 'project-b' });
    expect(hook.result.current.reload).not.toBe(reload);
    expect(loadProjectCanvas).toHaveBeenCalledTimes(2);
  });

  it('seed 只补缺失 ID、不刷新或取消在途查询、不改变当前页和总数，并由后续 API 元数据覆盖', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    const seed = hook.result.current.seedAssets;
    const pendingPagination = hook.result.current.pagination;
    const snapshot = asset('source', {
      name: '画布快照',
      contentUrl: '/v1/assets/source/versions/1/content',
    });
    act(() => seed([snapshot, { ...snapshot, name: '重复快照' }, asset('off-page')]));
    expect(requests).toHaveLength(1);
    expect(requests[0].signal.aborted).toBe(false);
    expect(hook.result.current.pagination).toBe(pendingPagination);
    expect(hook.result.current.pageAssets).toEqual([]);
    expect(hook.result.current.knownAssets).toEqual([snapshot, asset('off-page')]);
    const canonical = asset('source', { name: '服务端最新名称', latestVersion: 3 });
    await respond(0, [canonical], 100);
    expect(hook.result.current.knownAssets).toEqual([canonical, asset('off-page')]);
    const known = hook.result.current.knownAssets;
    const page = hook.result.current.pageAssets;
    const pagination = hook.result.current.pagination;
    act(() => seed([snapshot, asset('off-page')]));
    expect(hook.result.current.knownAssets).toBe(known);
    expect(hook.result.current.pageAssets).toBe(page);
    expect(hook.result.current.pagination).toBe(pagination);
    expect(requests).toHaveLength(1);
  });

  it('永久删除后的节点快照不能通过 seed 重新加入索引', async () => {
    const hook = renderHook(useProjectAssets, { initialProps: options });
    await respond(0, [asset('deleted')]);
    act(() => hook.result.current.removeAsset('deleted'));
    act(() => hook.result.current.seedAssets([asset('deleted')]));
    expect(hook.result.current.knownAssets).toEqual([]);
    await respond(1, []);
    act(() => hook.result.current.seedAssets([asset('deleted')]));
    expect(hook.result.current.knownAssets).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it.each([401, 403, 404])(
    '权限拒绝 %s 后 seed/upsert 不能重新加入资源，授权重查成功后才恢复',
    async (status) => {
      const hook = renderHook(useProjectAssets, { initialProps: options });
      act(() => hook.result.current.seedAssets([asset('private-source')]));
      await reply(0, { error: 'denied' }, status);
      act(() => {
        hook.result.current.seedAssets([asset('private-source')]);
        hook.result.current.upsertAssets([asset('late-mutation')]);
      });
      expect(hook.result.current.knownAssets).toEqual([]);
      expect(requests).toHaveLength(1);
      act(() => hook.result.current.reload());
      await respond(1, []);
      act(() => hook.result.current.seedAssets([asset('allowed-source')]));
      expect(hook.result.current.knownAssets).toEqual([asset('allowed-source')]);
      expect(hook.result.current.pageAssets).toEqual([]);
      expect(hook.result.current.pagination.total).toBe(0);
      expect(requests).toHaveLength(2);
    },
  );
});

it('画布索引只补明确资源，保留冻结地址但不虚构 latestVersion', () => {
  const nodes = [
    {
      id: 'source',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        label: '来源',
        mode: 'source',
        mediaType: 'image',
        assetId: 'asset-a',
        contentUrl: '/v1/assets/asset-a/versions/2/content',
        mimeType: 'image/png',
      },
    },
    {
      id: 'result',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        label: '结果',
        mode: 'generate',
        mediaType: 'image',
        resultAsset: { assetId: 'asset-b', version: 4, mimeType: 'image/png' },
      },
    },
    {
      id: 'empty',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        label: '空节点',
        mode: 'generate',
        mediaType: 'image',
      },
    },
  ] as AssetFlowNode[];
  const result = canvasAssetSeeds(nodes);
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({
    id: 'asset-a',
    contentUrl: '/v1/assets/asset-a/versions/2/content',
  });
  expect(result[1]).toMatchObject({
    id: 'asset-b',
    contentUrl: '/v1/assets/asset-b/versions/4/content',
  });
  expect(result.every((asset) => !('latestVersion' in asset))).toBe(true);
});
