import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE2PRO_IMAGE_TASK_CONTRACT,
  type ProviderJob,
  type RunInputSnapshot,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiProviderError, type ProviderJobUpdate } from './index';

function imageSnapshot(
  parameters: Record<string, unknown> = {},
  inputs: RunInputSnapshot[] = [],
): RunSnapshot {
  return {
    projectId: 'project-image-task',
    canvasRevision: 1,
    targetNodeId: 'node-image-task',
    modelAlias: 'unlimited-image-v1',
    executionBindings: {
      'node-image-task': {
        credentialId: 'credential-1',
        credentialVersion: 1,
        modelAlias: 'unlimited-image-v1',
        mediaType: 'image',
        contract: IMAGE2PRO_IMAGE_TASK_CONTRACT,
      } as never,
    },
    parameters,
    submittedAt: '2026-10-20T00:00:00.000Z',
    nodes: [
      {
        id: 'node-image-task',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: '图片生成节点 6',
          mediaType: 'image',
          mode: 'generate',
          prompt: '保持主体，生成蓝色海报',
        },
      },
    ],
    edges: [],
    inputs,
  } as RunSnapshot;
}

function referenceImageInput(contentUrl: string): RunInputSnapshot {
  return {
    nodeId: 'source-image',
    role: 'referenceImage',
    sortOrder: 0,
    snapshot: {
      id: 'source-image',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        label: '参考图',
        mediaType: 'image',
        mode: 'source',
        contentUrl,
        mimeType: 'image/png',
      },
    },
  } as RunInputSnapshot;
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function provider(fetchImpl: typeof fetch, maxPollAttempts = 2): NewApiProvider {
  return new NewApiProvider({
    baseUrl: 'https://image2pro.example/v1',
    apiKey: 'test-api-key',
    fetchImpl,
    imageTaskPollIntervalMs: 0,
    imageTaskMaxPollAttempts: maxPollAttempts,
  });
}

describe('Image2Pro 异步图片任务协议', () => {
  it.each([undefined, '1K', '2K', '4K'])(
    '参考图使用 input_image，分辨率 %s 保留原档位且不补默认像素',
    async (size) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response({ id: 'task-1', status: 'queued' }, 202))
        .mockResolvedValueOnce(
          response({
            id: 'task-1',
            status: 'completed',
            data: [{ url: 'https://cdn.example/generated.png' }],
          }),
        );
      await provider(fetchImpl).execute({
        snapshot: imageSnapshot(
          {
            n: 1,
            ...(size ? { size } : {}),
            aspectRatio: '3:2',
            quality: 'high',
            background: 'transparent',
            output_format: 'webp',
            output_compression: 80,
          },
          [referenceImageInput('https://assets.example/reference.png')],
        ),
        providerJob: { id: 'provider-job-1', provider: 'newapi' },
        onProviderJob: vi.fn(),
      });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe('https://image2pro.example/v1/images/tasks');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
      expect(new Headers(init?.headers).get('idempotency-key')).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/,
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'unlimited-image-v1',
        prompt: '保持主体，生成蓝色海报',
        n: 1,
        aspect_ratio: '3:2',
        input_image: 'https://assets.example/reference.png',
      });
      expect(body).not.toHaveProperty('quality');
      expect(body).not.toHaveProperty('background');
      expect(body).not.toHaveProperty('output_format');
      expect(body).not.toHaveProperty('output_compression');
      if (size) expect(body.size).toBe(size);
      else expect(body).not.toHaveProperty('size');
      expect(body).not.toHaveProperty('aspectRatio');
      expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://image2pro.example/v1/images/tasks/task-1');
      expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe('GET');
    },
  );

  it('已有平台 ID 的恢复只查询，不重复 POST', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        id: 'task-existing',
        status: 'completed',
        data: [{ url: 'https://cdn.example/done.png' }],
      }),
    );
    const job: ProviderJobUpdate = {
      id: 'provider-job-existing',
      provider: 'newapi',
      platformJobId: 'task-existing',
      status: 'running',
      progress: 40,
      payload: { contract: IMAGE2PRO_IMAGE_TASK_CONTRACT, phase: 'polling' },
    };
    await provider(fetchImpl).execute({
      snapshot: imageSnapshot(),
      providerJob: job,
      resumeOnly: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('提交结果未知时仅允许用相同请求体和幂等键重试', async () => {
    const persisted: ProviderJobUpdate[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: { message: 'temporarily unavailable' } }, 503))
      .mockResolvedValueOnce(response({ id: 'task-recovered', status: 'queued' }, 202))
      .mockResolvedValueOnce(
        response({
          id: 'task-recovered',
          status: 'completed',
          data: [{ url: 'https://cdn.example/recovered.png' }],
        }),
      );
    const currentProvider = provider(fetchImpl);
    const firstError = await currentProvider
      .execute({
        snapshot: imageSnapshot(),
        providerJob: { id: 'provider-job-retry', provider: 'newapi' },
        onProviderJob: (job) => {
          persisted.push(job);
        },
      })
      .catch((error: unknown) => error);
    expect(firstError).toBeInstanceOf(NewApiProviderError);
    expect((firstError as NewApiProviderError).code).toBe('IMAGE_TASK_SUBMISSION_UNKNOWN');
    expect((firstError as NewApiProviderError).retryable).toBe(true);
    const savedJob = { ...persisted[0], id: 'provider-job-retry' } as ProviderJob;

    await currentProvider.execute({
      snapshot: imageSnapshot(),
      providerJob: savedJob,
      onProviderJob: vi.fn(),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const firstHeaders = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    const retryHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(retryHeaders.get('idempotency-key')).toBe(firstHeaders.get('idempotency-key'));

    const mismatchFetch = vi.fn<typeof fetch>();
    const mismatch = await provider(mismatchFetch)
      .execute({
        snapshot: imageSnapshot({ size: '1024x1024' }),
        providerJob: savedJob,
        onProviderJob: vi.fn(),
      })
      .catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(NewApiProviderError);
    expect((mismatch as NewApiProviderError).code).toBe('IMAGE_TASK_SUBMISSION_UNKNOWN');
    expect(mismatchFetch).not.toHaveBeenCalled();
  });

  it('将超长或非法本地任务 ID 映射为文档允许的幂等键', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: 'task-key', status: 'queued' }, 202))
      .mockResolvedValueOnce(
        response({
          id: 'task-key',
          status: 'completed',
          data: [{ url: 'https://cdn.example/key.png' }],
        }),
      );
    await provider(fetchImpl).execute({
      snapshot: imageSnapshot(),
      providerJob: { id: `-${'x'.repeat(110)}`, provider: 'newapi' },
      onProviderJob: vi.fn(),
    });
    const key = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('idempotency-key');
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/);
    expect(key).toHaveLength(71);
  });
});
