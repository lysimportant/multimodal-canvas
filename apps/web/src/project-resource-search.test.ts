import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, MediaType } from '@multimodal-canvas/domain';

import {
  apiFetch,
  AuthSessionChangedError,
  clearAuthSession,
  getAuthSessionGeneration,
  persistAuthSession,
} from './auth-client';
import {
  searchProjectResources,
  type ProjectResourceSearch,
  type ProjectResourceSearchOptions,
  type ProjectResourceSearchPage,
} from './project-resource-search';

vi.mock('./auth-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth-client')>()),
  apiFetch: vi.fn(),
}));

/** 保留真实身份代次，只替换请求边界；所有响应均为合成夹具。 */
const fetchPage = vi.mocked(apiFetch);
/** 每个测试使用独立信号，取消不影响后续用例。 */
let controller: AbortController;

/** 创建符合 assetSchema 的最小资源，patch 只用于构造当前用例。 */
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

/** 模拟现代接口的固定 50 条分页；total 是整个查询的总数。 */
function page(
  assets: Asset[] = [],
  total = assets.length,
  pageNumber = 1,
): ProjectResourceSearchPage {
  return { assets, total, page: pageNumber, pageSize: 50 };
}

/** 构造真实 Response，允许测试 HTTP 错误和非法 JSON 结构。 */
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 绑定测试项目，模拟 App 提供给 Editor/Canvas 的回调签名。 */
function search(patch: Partial<ProjectResourceSearchOptions> = {}, projectId = 'project-a') {
  const projectSearch: ProjectResourceSearch = (options) =>
    searchProjectResources(projectId, options);
  return projectSearch({
    query: '',
    mediaType: 'all',
    page: 1,
    signal: controller.signal,
    ...patch,
  });
}

/** 模拟真实登录或权限变更；不包含认证令牌，也不调用远程服务。 */
function login(id = 'user-a', role: 'user' | 'admin' = 'user', renewal = false): void {
  persistAuthSession({ user: { id, role, createdAt: '2026-10-03T00:00:00Z' } }, { renewal });
}

/** 独立控制响应头或正文到达时机，故意不响应取消信号。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  controller = new AbortController();
  localStorage.clear();
  login();
  fetchPage.mockReset().mockRejectedValue(new Error('意外的额外 API 请求'));
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('测试禁止真实联网')));
});

afterEach(() => {
  clearAuthSession();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('项目范围的服务端搜索', () => {
  it('携带项目、固定分页、ready 状态、取消信号及发起时身份代次', async () => {
    fetchPage.mockResolvedValueOnce(response(page()));
    const generation = getAuthSessionGeneration();
    await expect(search()).resolves.toEqual(page());
    expect(fetchPage).toHaveBeenCalledOnce();
    const [input, init, context] = fetchPage.mock.calls[0];
    const url = new URL(String(input));
    expect(url.pathname).toMatch(/\/v1\/assets$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      projectId: 'project-a',
      page: '1',
      pageSize: '50',
      status: 'ready',
    });
    expect(init?.signal).toBe(controller.signal);
    expect(context).toEqual({ expectedAuthGeneration: generation });
  });

  it('首屏只有 50 条时仍查询整个项目，现代响应不按本地可见字段二次过滤', async () => {
    const first = Array.from({ length: 50 }, (_, index) => asset(`first-${index}`));
    const outside = asset('resource-137', { name: '服务端扩展索引命中的资源' });
    fetchPage
      .mockResolvedValueOnce(response(page(first, 180)))
      .mockResolvedValueOnce(response(page([outside])));
    await expect(search()).resolves.toEqual(page(first, 180));
    await expect(search({ query: '服务端别名' })).resolves.toEqual(page([outside]));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetchPage.mock.calls[1][0]));
    expect(url.searchParams.get('projectId')).toBe('project-a');
    expect(url.searchParams.get('query')).toBe('服务端别名');
    expect(url.searchParams.get('page')).toBe('1');
  });

  it('直接请求搜索结果第二页，不预取第一页，也不再次切掉已分页资源', async () => {
    const second = Array.from({ length: 25 }, (_, index) => asset(`second-${index}`));
    fetchPage.mockResolvedValueOnce(response(page(second, 75, 2)));
    await expect(search({ query: '跨页搜索', page: 2 })).resolves.toEqual(page(second, 75, 2));
    expect(fetchPage).toHaveBeenCalledOnce();
    const url = new URL(String(fetchPage.mock.calls[0][0]));
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('query')).toBe('跨页搜索');
  });

  it('query 和项目 ID 的特殊字符作为单一参数编码，按 API 规则去除首尾空白', async () => {
    const query = '  海报 & 50%_ + # ? = / \\ " 引用🙂  ';
    const projectId = '  项目 & /?=# +  ';
    fetchPage.mockResolvedValueOnce(response(page()));
    await search({ query, mediaType: 'image' }, projectId);
    const url = new URL(String(fetchPage.mock.calls[0][0]));
    expect(url.searchParams.getAll('query')).toEqual([query.trim()]);
    expect(url.searchParams.getAll('projectId')).toEqual([projectId.trim()]);
    expect(url.searchParams.get('mediaType')).toBe('image');
    expect([...url.searchParams.keys()]).toHaveLength(6);
    expect(url.hash).toBe('');
  });

  it.each<MediaType>(['text', 'image', 'audio', 'video'])(
    '传递合法媒体类型 %s',
    async (mediaType) => {
      const item = asset('typed', { mediaType });
      fetchPage.mockResolvedValueOnce(response(page([item])));
      await expect(search({ mediaType })).resolves.toEqual(page([item]));
      expect(new URL(String(fetchPage.mock.calls[0][0])).searchParams.get('mediaType')).toBe(
        mediaType,
      );
    },
  );

  it('允许去除首尾空白后恰好 512 个字符，不截断查询', async () => {
    const query = '字'.repeat(512);
    fetchPage.mockResolvedValueOnce(response(page()));
    await search({ query: ` ${query} ` });
    expect(new URL(String(fetchPage.mock.calls[0][0])).searchParams.get('query')).toBe(query);
  });

  it.each([1, 3, Number.MAX_SAFE_INTEGER])('接受合法空页 %s 并保留请求页码', async (pageNumber) => {
    fetchPage.mockResolvedValueOnce(response(page([], 0, pageNumber)));
    await expect(search({ page: pageNumber })).resolves.toEqual(page([], 0, pageNumber));
  });

  it('使用领域 schema 补齐旧资源缺省 tags', async () => {
    const { tags: _tags, ...item } = asset('no-tags');
    fetchPage.mockResolvedValueOnce(response({ ...page(), assets: [item], total: 1 }));
    await expect(search()).resolves.toEqual(page([asset('no-tags')]));
  });
});

describe('请求参数校验', () => {
  it.each([null, undefined, 1, true, {}, []])('拒绝非字符串 query：%j', async (query) => {
    await expect(search({ query: query as string })).rejects.toThrow('搜索内容必须为字符串');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('拒绝 513 字符的 query，不截断、重试或降级', async () => {
    await expect(search({ query: '字'.repeat(513) })).rejects.toThrow('不能超过 512');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined])(
    '拒绝非法页码 %s',
    async (pageNumber) => {
      await expect(search({ page: pageNumber as number })).rejects.toThrow('页码必须为正安全整数');
      expect(fetchPage).not.toHaveBeenCalled();
    },
  );

  it.each(['', ' ', 'pdf', 'IMAGE', null, undefined])('拒绝非法媒体类型 %s', async (mediaType) => {
    await expect(search({ mediaType: mediaType as MediaType })).rejects.toThrow('媒体类型无效');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'p'.repeat(513), null, 123])(
    '拒绝非法项目，不能退回全局查询：%s',
    async (projectId) => {
      await expect(search({}, projectId as string)).rejects.toThrow('项目 ID');
      expect(fetchPage).not.toHaveBeenCalled();
    },
  );
});

describe('HTTP 和网络错误不降级', () => {
  it.each([401, 403, 404, 500, 503])(
    '错误 %s 不返回上次结果，不扩大项目范围或重试',
    async (status) => {
      fetchPage
        .mockResolvedValueOnce(response(page([asset('previous')])))
        .mockResolvedValueOnce(response({ error: '服务端拒绝资源搜索' }, status));
      await search();
      await expect(search()).rejects.toThrow(
        status === 404 ? '项目不存在或无权访问' : '服务端拒绝资源搜索',
      );
      expect(fetchPage).toHaveBeenCalledTimes(2);
      for (const [input] of fetchPage.mock.calls) {
        expect(new URL(String(input)).searchParams.get('projectId')).toBe('project-a');
      }
    },
  );

  it.each([403, 502])('非 JSON 错误正文仍报告 HTTP 状态 %s', async (status) => {
    fetchPage.mockResolvedValueOnce(new Response('<html>failure</html>', { status }));
    await expect(search()).rejects.toThrow(`资源搜索失败（${status}）`);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it('保留网络错误，不伪装为空结果或改查旧 API', async () => {
    const error = new TypeError('网络连接中断');
    fetchPage.mockRejectedValueOnce(error);
    await expect(search()).rejects.toBe(error);
    expect(fetchPage).toHaveBeenCalledOnce();
  });
});

describe('旧 assets 响应兼容', () => {
  it('只在完整旧列表上切页，第二页保留总数而不是返回前 50 条', async () => {
    const all = Array.from({ length: 85 }, (_, index) => asset(`legacy-${index}`));
    fetchPage.mockResolvedValue(response({ assets: all }));
    await expect(search()).resolves.toEqual(page(all.slice(0, 50), 85));
    // Response 正文只能消费一次；第二个请求收到独立响应。
    fetchPage.mockResolvedValueOnce(response({ assets: all }));
    await expect(search({ page: 2 })).resolves.toEqual(page(all.slice(50), 85, 2));
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('先对完整列表按 ready、媒体类型和关键词过滤，再计算第二页及 total', async () => {
    const matching = Array.from({ length: 55 }, (_, index) =>
      asset(`match-${index}`, { mediaType: 'image', metadata: { alias: 'TARGET' } }),
    );
    const all = matching.flatMap((item, index) => [
      asset(`archived-${index}`, { ...item, id: `archived-${index}`, status: 'archived' }),
      asset(`text-${index}`, { metadata: { alias: 'target' } }),
      asset(`unrelated-${index}`, { mediaType: 'image' }),
      item,
    ]);
    fetchPage.mockResolvedValueOnce(response({ assets: all }));
    await expect(search({ query: ' target ', mediaType: 'image', page: 2 })).resolves.toEqual(
      page(matching.slice(50), 55, 2),
    );
  });

  it.each<Partial<Asset>>([
    { name: 'NEEDLE 文件' },
    { mimeType: 'application/NEEDLE' },
    { tags: ['NEEDLE'] },
    { metadata: { alias: 'NEEDLE' } },
    { metadata: { aliases: [null, 123, 'NEEDLE'] } },
  ])('旧协议兼容名称、MIME、标签和字符串别名：%j', async (patch) => {
    const match = asset('matched', patch);
    fetchPage.mockResolvedValueOnce(response({ assets: [asset('other'), match] }));
    await expect(search({ query: 'needle' })).resolves.toEqual(page([match]));
  });

  it('不将非字符串别名或其它 metadata 转成可搜索文字', async () => {
    const all = [
      asset('one', { metadata: { alias: 123, aliases: [123, { value: '123' }] } }),
      asset('two', { metadata: { aliases: '123', description: '123' } }),
    ];
    fetchPage.mockResolvedValueOnce(response({ assets: all }));
    await expect(search({ query: '123' })).resolves.toEqual(page());
  });

  it('特殊字符按字面量匹配，不当作正则或 SQL 通配符', async () => {
    const match = asset('literal', { name: '50%_\\[hero].*' });
    fetchPage.mockResolvedValueOnce(response({ assets: [asset('50-hero'), match] }));
    await expect(search({ query: '50%_\\[hero].*' })).resolves.toEqual(page([match]));
  });

  it('空 query 保留所有 ready 类型，超出末页时返回空页及可信总数', async () => {
    const all = (['text', 'image', 'audio', 'video'] as const).map((mediaType) =>
      asset(mediaType, { mediaType }),
    );
    const legacy = [...all, asset('archived', { status: 'archived' })];
    fetchPage.mockResolvedValueOnce(response({ assets: legacy }));
    await expect(search({ query: '   ' })).resolves.toEqual(page(all));
    fetchPage.mockResolvedValueOnce(response({ assets: legacy }));
    await expect(search({ page: 2 })).resolves.toEqual(page([], all.length, 2));
  });
});

describe('拒绝无效资源和分页响应', () => {
  it.each([
    null,
    [],
    'invalid',
    1,
    {},
    { assets: null },
    { assets: 'invalid' },
    { assets: [{ id: 'incomplete' }] },
    { assets: [asset('bad-type', { mediaType: 'pdf' as MediaType })] },
    { assets: [asset('bad-size', { sizeBytes: -1 })] },
    { assets: [], error: '失败' },
    { assets: [], error: null },
    { assets: [], total: 0 },
    { assets: [], page: 1 },
    { assets: [], pageSize: 50 },
    { assets: [], page: null },
  ])('非法或残缺响应不能伪装为旧协议成功：%j', async (body) => {
    fetchPage.mockResolvedValueOnce(response(body));
    await expect(search()).rejects.toThrow('资源分页响应格式无效');
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it.each([
    { total: -1 },
    { total: 1.5 },
    { total: '1' },
    { total: null },
    { total: Number.MAX_SAFE_INTEGER + 1 },
    { total: Infinity },
    { page: 2 },
    { page: '1' },
    { page: 1.5 },
    { page: 0 },
    { pageSize: 49 },
    { pageSize: '50' },
    { pageSize: null },
    { assets: [asset('too-many')], total: 0 },
    { assets: Array.from({ length: 51 }, (_, index) => asset(`overflow-${index}`)), total: 51 },
    { assets: [{ id: 'incomplete' }], total: 1 },
    { error: 'failure' },
  ])('现代分页必须是安全整数且与请求、资源数量一致：%j', async (patch) => {
    fetchPage.mockResolvedValueOnce(response({ ...page(), ...patch }));
    await expect(search()).rejects.toThrow('资源分页响应格式无效');
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it.each([50, 51])('第二页资源数量不能超出 total=%s 的剩余容量', async (total) => {
    fetchPage.mockResolvedValueOnce(response(page([asset('one'), asset('two')], total, 2)));
    await expect(search({ page: 2 })).rejects.toThrow('资源分页响应格式无效');
  });

  it('成功状态但非 JSON 的正文显式失败并保留解析原因', async () => {
    fetchPage.mockResolvedValueOnce(new Response('not JSON'));
    await expect(search()).rejects.toMatchObject({
      message: '资源分页响应格式无效',
      cause: expect.any(Error),
    });
  });

  it('旧列表中即使不匹配的条目非法，也拒绝整页而不是静默跳过', async () => {
    fetchPage.mockResolvedValueOnce(response({ assets: [asset('valid'), { id: 'broken' }] }));
    await expect(search({ query: 'valid' })).rejects.toThrow('资源分页响应格式无效');
  });
});

describe('取消和身份代次', () => {
  it('预先取消的请求不发送网络操作', async () => {
    controller.abort();
    await expect(search()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('保留 apiFetch 的取消异常，不转为空页', async () => {
    const error = new DOMException('已取消', 'AbortError');
    fetchPage.mockRejectedValueOnce(error);
    await expect(search()).rejects.toBe(error);
  });

  it.each(['响应头之前', '正文读取期间'])(
    '%s 取消后，即使请求忽略信号也拒绝迟到数据',
    async (stage) => {
      const headers = deferred<Response>();
      const body = deferred<unknown>();
      const resultPage = page([asset('late')]);
      const reply = response(resultPage);
      const json = vi.spyOn(reply, 'json').mockReturnValue(body.promise);
      fetchPage.mockReturnValueOnce(headers.promise);
      const result = search();
      const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
      if (stage === '正文读取期间') {
        headers.resolve(reply);
        await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
      }
      controller.abort('调用方已关闭 picker');
      headers.resolve(reply);
      body.resolve(resultPage);
      await rejected;
      if (stage === '响应头之前') expect(json).not.toHaveBeenCalled();
      expect(fetchPage).toHaveBeenCalledOnce();
    },
  );

  describe.each(['响应头之前', '正文读取期间'])('%s 身份变化', (stage) => {
    it.each([
      { action: '切换账号', change: () => login('user-b') },
      { action: '退出登录', change: () => clearAuthSession() },
      { action: '修改权限', change: () => login('user-a', 'admin') },
      { action: '同账号重新登录', change: () => login() },
      {
        action: '切换账号再切回',
        change: () => {
          login('user-b');
          login();
        },
      },
    ])('$action 后不返回旧数据，也不使用新身份重试', async ({ change }) => {
      const headers = deferred<Response>();
      const body = deferred<unknown>();
      const resultPage = page([asset('previous-user')]);
      const reply = response(resultPage);
      const json = vi.spyOn(reply, 'json').mockReturnValue(body.promise);
      fetchPage.mockReturnValueOnce(headers.promise);
      const generation = getAuthSessionGeneration();
      const result = search();
      const rejected = expect(result).rejects.toBeInstanceOf(AuthSessionChangedError);
      if (stage === '正文读取期间') {
        headers.resolve(reply);
        await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
      }
      change();
      expect(getAuthSessionGeneration()).not.toBe(generation);
      headers.resolve(reply);
      body.resolve(resultPage);
      await rejected;
      if (stage === '响应头之前') expect(json).not.toHaveBeenCalled();
      expect(fetchPage).toHaveBeenCalledOnce();
      expect(fetchPage.mock.calls[0][2]?.expectedAuthGeneration).toBe(generation);
    });
  });

  it('正常会话续期不改变身份代次，可继续接收原请求结果', async () => {
    const body = deferred<unknown>();
    const resultPage = page([asset('same-user')]);
    const reply = response(resultPage);
    const json = vi.spyOn(reply, 'json').mockReturnValue(body.promise);
    fetchPage.mockResolvedValueOnce(reply);
    const generation = getAuthSessionGeneration();
    const result = search();
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    login('user-a', 'user', true);
    expect(getAuthSessionGeneration()).toBe(generation);
    body.resolve(resultPage);
    await expect(result).resolves.toEqual(resultPage);
  });

  it('正文解析期间身份过期时优先报告代次错误，而不是无效 JSON', async () => {
    const reply = response(page());
    vi.spyOn(reply, 'json').mockImplementation(async () => {
      clearAuthSession();
      throw new SyntaxError('正文解析中断');
    });
    fetchPage.mockResolvedValueOnce(reply);
    await expect(search()).rejects.toBeInstanceOf(AuthSessionChangedError);
  });
});
