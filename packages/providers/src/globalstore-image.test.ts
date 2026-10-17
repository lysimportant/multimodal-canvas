import { describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { GlobalStoreImageProvider, normalizeGlobalStoreBaseUrl } from './globalstore-image.js';
import type { NewApiProviderRequest } from './index.js';

const snapshot = {
  targetNodeId: 'image',
  modelAlias: 'seedream-5.0',
  parameters: {},
  inputs: [],
  nodes: [{ id: 'image', data: { mediaType: 'image', label: '图片', prompt: '一只猫' } }],
} as unknown as RunSnapshot;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=',
  'base64',
);
const task = (status: string, extra = {}) => Response.json({ id: 'task-1', status, ...extra });
function setup(responses: Response[], overrides = {}) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!);
  const provider = new GlobalStoreImageProvider({
    baseUrl: 'https://gs.example',
    apiKey: 'secret-test',
    pollIntervalMs: 1,
    fetchImpl,
    ...overrides,
  });
  const request: NewApiProviderRequest = {
    snapshot,
    runId: 'run-1',
    onRequestPrompt: vi.fn(),
    onProviderJob: vi.fn(),
  };
  return { fetchImpl, provider, request };
}
describe('GlobalStore 图片异步合同', () => {
  it('规范化三种文档基础地址', () => {
    for (const suffix of ['', '/kyyReactApiServer', '/kyyReactApiServer/v2/model-center'])
      expect(normalizeGlobalStoreBaseUrl(`https://gs.example${suffix}`)).toBe(
        'https://gs.example/kyyReactApiServer/v2/model-center',
      );
    expect(() => normalizeGlobalStoreBaseUrl('https://user:password@gs.example')).toThrow();
    for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '[::1]'])
      expect(() => normalizeGlobalStoreBaseUrl(`https://${host}`)).toThrow('公开网络');
  });
  it('记录提示词、提交、轮询并隔离下载认证，不持久化结果URL', async () => {
    const { provider, request, fetchImpl } = setup([
      task('queued'),
      task('processing', { progress: 30 }),
      task('completed', { result_url: 'https://cdn.example/signed.png' }),
      new Response(png),
    ]);
    const output = await provider.execute(request);
    expect(output.output).toMatchObject({ kind: 'base64', mimeType: 'image/png' });
    expect(fetchImpl.mock.calls.map((call) => call[1]?.method ?? 'GET')).toEqual([
      'POST',
      'GET',
      'GET',
      'GET',
    ]);
    expect(request.onRequestPrompt).toHaveBeenCalledBefore(
      request.onProviderJob as ReturnType<typeof vi.fn>,
    );
    expect(fetchImpl.mock.calls[3]?.[1]?.headers).toBeUndefined();
    expect(fetchImpl.mock.calls[3]?.[1]?.credentials).toBe('omit');
    expect(
      JSON.stringify((request.onProviderJob as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toMatch(/secret-test|cdn.example/);
  });
  it('持久化失败时禁止POST', async () => {
    const { provider, request, fetchImpl } = setup([]);
    request.onRequestPrompt = async () => {
      throw new Error('disk');
    };
    await expect(provider.execute(request)).rejects.toThrow('disk');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('恢复只GET，submitting无ID拒绝重复提交', async () => {
    const { provider, request, fetchImpl } = setup([task('failed')]);
    request.providerJob = {
      provider: 'globalstore',
      platformJobId: 'task-1',
      payload: { contract: 'globalstore-model-center-image-v2' },
    };
    await expect(provider.execute(request)).rejects.toThrow('任务失败');
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('GET');
    request.providerJob = {
      provider: 'globalstore',
      payload: { contract: 'globalstore-model-center-image-v2', phase: 'submitting' },
    };
    await expect(provider.execute(request)).rejects.toThrow('拒绝重复提交');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('取消发生在POST期间仍先保存返回的ID', async () => {
    const controller = new AbortController();
    const { provider, request, fetchImpl } = setup([]);
    request.signal = controller.signal;
    fetchImpl.mockImplementation(async () => {
      controller.abort();
      return task('queued');
    });
    await expect(provider.execute(request)).rejects.toThrow();
    expect(request.onProviderJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ platformJobId: 'task-1' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('轮询超时、发送前取消及伪图片均失败', async () => {
    const first = setup([task('queued')], { timeoutMs: 10, pollIntervalMs: 100 });
    await expect(first.provider.execute(first.request)).rejects.toThrow();
    const second = setup([]);
    second.request.signal = AbortSignal.abort();
    await expect(second.provider.execute(second.request)).rejects.toThrow();
    expect(second.fetchImpl).not.toHaveBeenCalled();
    const third = setup([
      task('completed', { image_url: 'https://cdn.example/result' }),
      new Response('<html>error</html>'),
    ]);
    await expect(third.provider.execute(third.request)).rejects.toThrow('不是真实受支持图片');
  });
  it.each([
    ['seedream-5.0', { size: '2048x2048' }, { model: 'seedream-5.0', size: '2048x2048' }],
    [
      'seedream-5.0',
      { aspectRatio: '16:9', resolution: '3k' },
      { model: 'seedream-5.0', aspect_ratio: '16:9', resolution: '3K' },
    ],
    [
      'seedream_5.0Pro',
      { size: '2048x2048' },
      { model: 'seedream_5.0Pro', aspect_ratio: '1:1', resolution: '2K' },
    ],
    ['banana2', { size: '1024x1024' }, { model: 'banana2', size: '1024x1024' }],
    [
      'banana_c1',
      { size: '1024x1024', quality: 'STANDARD' },
      { model: 'banana_c1', size: '1024x1024', quality: 'standard' },
    ],
    [
      'banana_c2',
      { size: '2048x2048' },
      { model: 'banana_c2', aspect_ratio: '1:1', resolution: '2K' },
    ],
    [
      'bananapro',
      { aspect_ratio: '16:9', resolution: '4k' },
      { model: 'bananapro', aspect_ratio: '16:9', resolution: '4K' },
    ],
    [
      'gpt-image-2',
      { size: '1024x1024', quality: 'medium' },
      { model: 'gpt-image-2', size: '1024x1024', quality: 'medium' },
    ],
    [
      'gpt-image-2.5',
      { size: '1280x720', imageQuality: 'high' },
      { model: 'gpt-image-2.5', size: '1280x720', quality: 'high' },
    ],
  ])('%s 只发送该型号支持的规范参数', async (modelAlias, parameters, expected) => {
    const current = setup([
      task('completed', { result_url: 'https://cdn.example/result.png' }),
      new Response(png),
    ]);
    current.request.snapshot = {
      ...snapshot,
      modelAlias,
      parameters,
    } as unknown as RunSnapshot;
    await current.provider.execute(current.request);
    const body = JSON.parse(String(current.fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject(expected);
    expect(body).not.toHaveProperty('aspectRatio');
    expect(body).not.toHaveProperty('imageQuality');
    expect(body).not.toHaveProperty('image_size');
  });

  it('拒绝模型不支持的参数、枚举和互斥组合', async () => {
    const invalidCases = [
      ['seedream-5.0', { size: '2048x2048', aspectRatio: '1:1' }, '不能同时设置'],
      ['seedream_5.0Pro', { size: '2048x2048', aspectRatio: '1:1' }, '不能同时设置'],
      ['seedream-5.0', { aspect_ratio: 'auto' }, '不支持该 aspect_ratio'],
      ['seedream-5.0', { resolution: '1k' }, '不支持该 resolution'],
      ['banana_c1', { quality: 'high' }, '不支持该 quality'],
      ['banana_c1', { size: '1024x1024', aspectRatio: '1:1' }, '不能同时设置'],
      ['banana_c2', { size: '1024x1024', aspectRatio: '1:1' }, '不能同时设置'],
      ['gpt-image-2', { aspectRatio: '1:1', resolution: '1K' }, '必须提供文档列出的 size'],
      ['gpt-image-2', { size: '1024x512' }, '只支持文档列出的 size'],
      ['gpt-image-2.5', { size: '2048x1024' }, '只支持文档列出的 size'],
      ['unlisted-image-model', { size: '1024x1024' }, '合同尚未核验'],
    ] as const;

    for (const [modelAlias, parameters, message] of invalidCases) {
      const current = setup([]);
      current.request.snapshot = {
        ...snapshot,
        modelAlias,
        parameters,
      } as unknown as RunSnapshot;
      await expect(current.provider.execute(current.request)).rejects.toThrow(message);
      expect(current.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('按型号文档限制参考图数量并以文档大小写发送模型 ID', async () => {
    for (const [modelAlias, limit] of [
      ['seedream_5.0Pro', 10],
      ['banana2', 14],
      ['banana_c1', 14],
      ['banana_c2', 6],
      ['bananapro', 14],
      ['gpt-image-2', 14],
      ['gpt-image-2.5', 14],
    ] as const) {
      const inputs = Array.from({ length: limit }, (_, index) => ({
        nodeId: `ref-${index}`,
        role: 'referenceImage',
        sortOrder: index,
        snapshot: {
          id: `ref-${index}`,
          data: {
            mediaType: 'image',
            label: `ref-${index}`,
            contentUrl: `https://ref-${index}.example/image.png`,
          },
        },
      }));
      const current = setup([
        task('completed', { result_url: 'https://cdn.example/result.png' }),
        new Response(png),
      ]);
      current.request.snapshot = {
        ...snapshot,
        modelAlias,
        inputs,
        parameters: modelAlias.startsWith('gpt-image') ? { size: '1024x1024' } : {},
      } as unknown as RunSnapshot;
      await current.provider.execute(current.request);
      const body = JSON.parse(String(current.fetchImpl.mock.calls[0]?.[1]?.body));
      expect(body.model).toBe(modelAlias);
      expect(body.reference_images).toHaveLength(limit);

      const overLimit = setup([]);
      overLimit.request.snapshot = {
        ...current.request.snapshot,
        inputs: [...inputs, { ...inputs[0]!, nodeId: 'over-limit', sortOrder: limit }],
      } as unknown as RunSnapshot;
      await expect(overLimit.provider.execute(overLimit.request)).rejects.toThrow(
        `${limit} 张参考图`,
      );
      expect(overLimit.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['gpt-image-2', '2048x1152', '2816x1584'],
    ['gpt-image-2.5', '1024x576', '1280x720'],
  ])('将画布像素尺寸映射为 %s 文档列出的固定 size', async (modelAlias, size, expectedSize) => {
    const current = setup([
      task('completed', { result_url: 'https://cdn.example/result.png' }),
      new Response(png),
    ]);
    current.request.snapshot = {
      ...snapshot,
      modelAlias,
      parameters: { size },
    } as unknown as RunSnapshot;

    await current.provider.execute(current.request);

    const body = JSON.parse(String(current.fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.size).toBe(expectedSize);
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(body).not.toHaveProperty('resolution');
  });

  it('拒绝零尺寸或无法映射到文档比例的 GPT 固定尺寸', async () => {
    for (const [modelAlias, size] of [
      ['seedream-5.0', '0x1024'],
      ['gpt-image-2', '1024x512'],
    ]) {
      const current = setup([]);
      current.request.snapshot = {
        ...snapshot,
        modelAlias,
        parameters: { size },
      } as unknown as RunSnapshot;
      await expect(current.provider.execute(current.request)).rejects.toThrow();
      expect(current.fetchImpl).not.toHaveBeenCalled();
    }
  });
});
