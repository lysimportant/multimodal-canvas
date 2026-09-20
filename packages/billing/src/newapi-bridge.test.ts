import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  requestNewApiCatalog,
  requestNewApiEstimate,
  requestNewApiReceipt,
  type NewApiEstimateInput,
} from './newapi-bridge.js';

/** 所有测试只使用合成 Key 和注入传输，绝不发出真实收费调用。 */
const credentials = {
  baseUrl: 'https://newapi.example.invalid/deployment/v1/',
  apiKey: 'synthetic-key',
};
/** 目录只表达已鉴权的模型可用性，不包含可执行计费表达式。 */
const catalog = {
  version: 1,
  currency: 'CNY',
  quota_per_unit: '500000',
  usd_to_cny: '7.1',
  models: [
    {
      id: 'exact-model（按次）',
      available: true,
      media_type: 'text',
      contract: 'openai-chat-completions',
      pricing_version: 'v1',
    },
  ],
};
/** 预估与最终回执都使用整数字符串，不经过浮点金额。 */
const estimate = {
  version: 1,
  model: 'exact-model（按次）',
  group: 'VIP',
  pricing_version: 'v1',
  estimated_quota: '3',
  quota_per_unit: '500000',
  usd_to_cny: '7.1',
  expires_at: '2026-09-19T12:00:00Z',
  estimate_only: true,
};

describe('New API 鉴权账务传输', () => {
  it('合法中文模型原样估算，超过 512 UTF-8 字节时不发送请求', async () => {
    const model = '中'.repeat(170) + 'ab';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...estimate, model }));
    const input = { model, contract: 'openai-chat-completions', parameters: {} };
    expect((await requestNewApiEstimate(credentials, input, { fetchImpl })).model).toBe(model);
    await expect(
      requestNewApiEstimate(credentials, { ...input, model: '中'.repeat(171) }, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'invalid_newapi_request' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('保留部署前缀和精确模型 ID，认证只发给保存的连接且禁止重定向', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(catalog));
    expect(await requestNewApiCatalog(credentials, { fetchImpl })).toEqual(catalog);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.invalid/deployment/v1/canvas/catalog',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { accept: 'application/json', authorization: 'Bearer synthetic-key' },
      }),
    );
  });

  it('估算 POST 只访问 canvas/estimate，回执 GET 对已验证 requestId 进行路径编码', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(estimate))
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          request_id: 'request:with-safe.ID_1',
          model: estimate.model,
          group: 'actual',
          status: 'settled',
          quota: '3',
          quota_per_unit: '500000',
          settled_at: '2026-09-19T12:00:00.123456789Z',
        }),
      );
    const input = {
      model: estimate.model,
      contract: 'openai-chat-completions',
      parameters: { max_tokens: 100 },
      input_text: 'English input',
      input_pending: true,
    };
    expect(await requestNewApiEstimate(credentials, input, { fetchImpl })).toEqual(estimate);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://newapi.example.invalid/deployment/v1/canvas/estimate',
    );
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual(input);
    await requestNewApiReceipt(credentials, 'request:with-safe.ID_1', { fetchImpl });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://newapi.example.invalid/deployment/v1/canvas/receipts/request%3Awith-safe.ID_1',
    );
  });

  it.each([
    [
      '参考媒体上限',
      [
        ...Array.from({ length: 9 }, () => ({ type: 'image', role: 'reference_image' })),
        ...Array.from({ length: 3 }, () => ({ type: 'video', role: 'reference_video' })),
        ...Array.from({ length: 3 }, () => ({ type: 'audio', role: 'reference_audio' })),
      ],
    ],
    [
      '首尾帧',
      [
        { type: 'image', role: 'first_frame' },
        { type: 'image', role: 'last_frame' },
      ],
    ],
    ['空媒体数组', []],
  ])('只传输 %s 的媒体类型和角色，不发送资产地址', async (_name, inputMedia) => {
    const input = {
      model: 'MiniMax-H3',
      contract: 'newapi-video-v1',
      parameters: { seconds: 5, resolution: '768P' },
      input_text: 'Animate the scene.',
      input_media: inputMedia,
    } as NewApiEstimateInput;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...estimate, model: input.model }));
    await requestNewApiEstimate(credentials, input, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://newapi.example.invalid/deployment/v1/canvas/estimate',
    );
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual(input);
  });

  it.each([
    ['null', null],
    ['对象', { type: 'image', role: 'reference_image' }],
    ['负数', -1],
    ['空媒体项', [null]],
    ['字符串媒体项', ['image']],
    ['未知类型', [{ type: 'text', role: 'reference_image' }]],
    ['未知角色', [{ type: 'image', role: 'middle_frame' }]],
    ['图片角色不匹配', [{ type: 'image', role: 'reference_video' }]],
    ['视频角色不匹配', [{ type: 'video', role: 'reference_image' }]],
    ['音频角色不匹配', [{ type: 'audio', role: 'first_frame' }]],
    ['缺少角色', [{ type: 'image' }]],
    ['资产地址', [{ type: 'image', role: 'reference_image', url: 'https://asset.invalid' }]],
    ['资产身份', [{ type: 'image', role: 'reference_image', id: 'asset-id' }]],
    ['嵌套参数', [{ type: 'image', role: 'reference_image', options: {} }]],
    ['图片超限', Array.from({ length: 10 }, () => ({ type: 'image', role: 'reference_image' }))],
    ['视频超限', Array.from({ length: 4 }, () => ({ type: 'video', role: 'reference_video' }))],
    ['音频超限', Array.from({ length: 4 }, () => ({ type: 'audio', role: 'reference_audio' }))],
    [
      '总数超限',
      [
        ...Array.from({ length: 9 }, () => ({ type: 'image', role: 'reference_image' })),
        ...Array.from({ length: 3 }, () => ({ type: 'video', role: 'reference_video' })),
        ...Array.from({ length: 4 }, () => ({ type: 'audio', role: 'reference_audio' })),
      ],
    ],
    [
      '重复首帧',
      [
        { type: 'image', role: 'first_frame' },
        { type: 'image', role: 'first_frame' },
      ],
    ],
    [
      '重复尾帧',
      [
        { type: 'image', role: 'last_frame' },
        { type: 'image', role: 'last_frame' },
      ],
    ],
    [
      '帧与参考图片混用',
      [
        { type: 'image', role: 'first_frame' },
        { type: 'image', role: 'reference_image' },
      ],
    ],
    [
      '帧与参考视频混用',
      [
        { type: 'image', role: 'last_frame' },
        { type: 'video', role: 'reference_video' },
      ],
    ],
    [
      '帧与参考音频混用',
      [
        { type: 'image', role: 'first_frame' },
        { type: 'audio', role: 'reference_audio' },
      ],
    ],
  ])('拒绝预估媒体的 %s，且不发送请求', async (_name, inputMedia) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      requestNewApiEstimate(
        credentials,
        {
          model: 'MiniMax-H3',
          contract: 'newapi-video-v1',
          parameters: {},
          input_media: inputMedia,
        } as NewApiEstimateInput,
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'invalid_newapi_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['openai-chat-completions', 'openai-images-generations', 'openai-video-v1'])(
    '未确认的合同 %s 不能发送媒体预估，即使数组为空',
    async (contract) => {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        requestNewApiEstimate(
          credentials,
          { model: 'model', contract, parameters: {}, input_media: [] } as NewApiEstimateInput,
          { fetchImpl },
        ),
      ).rejects.toMatchObject({ code: 'invalid_newapi_request' });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['.', '..', 'request/segment', 'request with space', 'r'.repeat(65), '中文'])(
    '拒绝超出上游 request_id 合同的路径 %s',
    async (requestId) => {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        requestNewApiReceipt(credentials, requestId, { fetchImpl }),
      ).rejects.toMatchObject({ code: 'invalid_newapi_request' });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    'http://example.invalid',
    'https://user:password@example.invalid',
    'https://example.invalid?key=secret',
    'https://example.invalid#secret',
    'invalid',
  ])('拒绝不安全保存地址 %s 且不暴露原 URL 或 Key', async (baseUrl) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      requestNewApiCatalog({ ...credentials, baseUrl }, { fetchImpl }),
    ).rejects.toMatchObject({
      code: 'newapi_bridge_unavailable',
      message: 'New API 联动接口暂不可用',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['http://127.0.0.1:3001', 'http://localhost:3001/v1', 'http://[::1]:3001/proxy/v1'])(
    '允许显式本机 HTTP %s',
    async (baseUrl) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(catalog));
      await requestNewApiCatalog({ ...credentials, baseUrl }, { fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('拒绝未知估算参数和回执金额类型，不用默认价格补齐', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...estimate, estimated_quota: 3 }));
    await expect(
      requestNewApiEstimate(
        credentials,
        {
          model: 'model',
          contract: 'openai-chat-completions',
          parameters: { asset_url: 'https://asset.invalid' },
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'invalid_newapi_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      requestNewApiEstimate(
        credentials,
        { model: 'model', contract: 'openai-chat-completions', parameters: {} },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'invalid_newapi_response' });
  });

  it.each([301, 401, 404, 500])('上游 %s 只返回稳定错误且不自动重试', async (status) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private upstream secret', { status }));
    await expect(requestNewApiCatalog(credentials, { fetchImpl })).rejects.toMatchObject({
      code: 'newapi_bridge_unavailable',
      message: 'New API 联动接口暂不可用',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['http', 'redirect', 'declared-size'] as const)(
    '%s 在读取正文前拒绝时立即中止原传输，不留到超时后回收',
    async (failure) => {
      const response = new Response(new ReadableStream<Uint8Array>(), {
        status: failure === 'http' ? 503 : 200,
        headers: failure === 'declared-size' ? { 'content-length': '11' } : {},
      });
      if (failure === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
      const read = vi.spyOn(response.body!, 'getReader');
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        expect(init?.signal?.aborted).toBe(false);
        return response;
      });
      await expect(
        requestNewApiCatalog(credentials, { fetchImpl, maxResponseBytes: 10 }),
      ).rejects.toMatchObject({
        code: failure === 'declared-size' ? 'invalid_newapi_response' : 'newapi_bridge_unavailable',
      });
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(read).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('流式计数在超过限额时取消读取，不依赖 content-length', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(
      requestNewApiCatalog(credentials, { fetchImpl, maxResponseBytes: 10 }),
    ).rejects.toMatchObject({ code: 'invalid_newapi_response' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('超时中止原只读请求，不暴露底层错误且不自动重试', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('secret upstream key')));
        }),
    );
    await expect(
      requestNewApiCatalog(credentials, { fetchImpl, timeoutMs: 1 }),
    ).rejects.toMatchObject({
      code: 'newapi_bridge_unavailable',
      message: 'New API 联动接口暂不可用',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('正文停滞且 cancel 不结束的注入流仍按超时退出，不依赖传输支持信号', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const started = Date.now();
    await expect(
      requestNewApiCatalog(credentials, { fetchImpl, timeoutMs: 25 }),
    ).rejects.toMatchObject({
      code: 'newapi_bridge_unavailable',
      message: 'New API 联动接口暂不可用',
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('注入流读取异常时拒绝并释放 reader，清理异常不会产生未处理拒绝', async () => {
    const response = new Response(new ReadableStream<Uint8Array>());
    const reader = response.body!.getReader();
    vi.spyOn(reader, 'read').mockRejectedValue(new Error('private streaming error'));
    const cancel = vi.spyOn(reader, 'cancel').mockRejectedValue(new Error('private cleanup error'));
    vi.spyOn(response.body!, 'getReader').mockReturnValue(reader);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(requestNewApiCatalog(credentials, { fetchImpl })).rejects.toMatchObject({
      code: 'newapi_bridge_unavailable',
      message: 'New API 联动接口暂不可用',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('真实本机 HTTP 在响应头后停滞时中止正文并关闭连接', async () => {
    let requested = false;
    let resolveClosed: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const server = createServer((request, response) => {
      requested = true;
      expect(request.url).toBe('/v1/canvas/catalog');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      response.write('{');
      response.on('close', () => resolveClosed());
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('未分配测试端口');
    try {
      await expect(
        requestNewApiCatalog(
          { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'synthetic-local-key' },
          { timeoutMs: 200 },
        ),
      ).rejects.toMatchObject({
        code: 'newapi_bridge_unavailable',
        message: 'New API 联动接口暂不可用',
      });
      expect(requested).toBe(true);
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('测试连接未按中止信号关闭')), 1000);
          timer.unref();
          void closed.then(() => clearTimeout(timer));
        }),
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('拒绝重复目录身份、非 JSON 正文与重定向响应', async () => {
    const redirected = Response.json(catalog);
    Object.defineProperty(redirected, 'redirected', { value: true });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ...catalog, models: [catalog.models[0], catalog.models[0]] }),
      )
      .mockResolvedValueOnce(new Response('secret html'))
      .mockResolvedValueOnce(redirected);
    await expect(requestNewApiCatalog(credentials, { fetchImpl })).rejects.toMatchObject({
      code: 'invalid_newapi_response',
    });
    await expect(requestNewApiCatalog(credentials, { fetchImpl })).rejects.toMatchObject({
      code: 'invalid_newapi_response',
    });
    await expect(requestNewApiCatalog(credentials, { fetchImpl })).rejects.toMatchObject({
      code: 'newapi_bridge_unavailable',
    });
  });
});
