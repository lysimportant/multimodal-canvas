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
});
