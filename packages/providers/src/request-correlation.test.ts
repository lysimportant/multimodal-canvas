import { describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider } from './index.js';

/** 构造成功响应关联测试，不依赖真实模型、凭据或供应商请求。 */
function correlationSnapshot(mediaType: 'text' | 'image' | 'audio'): RunSnapshot {
  return {
    projectId: 'correlation-test',
    canvasRevision: 1,
    targetNodeId: 'target',
    modelAlias: 'synthetic-model',
    submittedAt: '2026-09-05T00:00:00.000Z',
    parameters: mediaType === 'audio' ? { voice: 'alloy' } : {},
    nodes: [
      {
        id: 'target',
        type: mediaType,
        position: { x: 0, y: 0 },
        data: { label: 'test', mediaType, mode: 'generate', prompt: 'test prompt' },
      },
    ],
    edges: [],
    inputs: [],
  };
}

/** 提供不包含媒体 URL 的最小成功输出及上游 usage。 */
function correlationPayload(mediaType: 'text' | 'image' | 'audio'): Record<string, unknown> {
  return {
    ...(mediaType === 'text'
      ? { choices: [{ message: { content: 'done' } }] }
      : { data: [{ b64_json: 'AA==' }] }),
    usage: { total_tokens: 7 },
  };
}

describe('普通 NewAPI 成功请求关联', () => {
  it.each(['text', 'image', 'audio'] as const)(
    '%s 提供可持久化 header 请求 ID 且保留 usage',
    async (mediaType) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...correlationPayload(mediaType),
            id: 'completion-body-id',
            request_id: 'body-request-id',
          }),
          { headers: { 'content-type': 'application/json', 'x-request-id': 'header-request-id' } },
        ),
      );
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example/v1',
        apiKey: 'synthetic-private-key',
        fetchImpl,
      });
      const providerJob = {
        provider: 'newapi' as const,
        id: 'durable-local-job',
        payload: { workflowNodeId: 'target' },
      };
      const execution = await provider.execute({
        snapshot: correlationSnapshot(mediaType),
        providerJob,
      });
      expect(execution.providerJob).toEqual({
        provider: 'newapi',
        payload: { requestId: 'header-request-id' },
      });
      expect(execution.providerJob).not.toHaveProperty('platformJobId');
      expect(execution.providerJob).not.toHaveProperty('id');
      expect(execution.usage).toEqual({ metadata: { total_tokens: 7 } });
      expect(providerJob).toEqual({
        provider: 'newapi',
        id: 'durable-local-job',
        payload: { workflowNodeId: 'target' },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['request_id', 'requestId', 'id'])(
    '缺 header 时从顶层 %s 回退，不把 completion ID 当视频任务',
    async (field) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...correlationPayload('text'),
            [field]: 'chatcmpl-body-id',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example/v1',
        apiKey: 'synthetic-private-key',
        fetchImpl,
      });
      const execution = await provider.execute({ snapshot: correlationSnapshot('text') });
      expect(execution.providerJob).toEqual({
        provider: 'newapi',
        payload: { requestId: 'chatcmpl-body-id' },
      });
      expect(execution.usage).toEqual({ metadata: { total_tokens: 7 } });
    },
  );

  it.each(['header', 'body'] as const)('%s ID 脱敏并限制长度，不复制整个响应', async (source) => {
    const rawId = `request synthetic-private-key Bearer other-secret https://user:password@assets.example/id?token=query-secret#private-fragment ${'long'.repeat(200)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...correlationPayload('text'),
          ...(source === 'body' ? { id: rawId } : {}),
          secret: 'private metadata',
        }),
        {
          headers: {
            'content-type': 'application/json',
            ...(source === 'header' ? { 'x-request-id': rawId } : {}),
          },
        },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-private-key',
      fetchImpl,
    });
    const execution = await provider.execute({ snapshot: correlationSnapshot('text') });
    const payload = execution.providerJob?.payload;
    expect(Object.keys(payload ?? {})).toEqual(['requestId']);
    expect(payload?.requestId).toContain('[REDACTED]');
    expect(String(payload?.requestId).length).toBeLessThanOrEqual(512);
    for (const secret of [
      'synthetic-private-key',
      'other-secret',
      'user:password',
      'query-secret',
      'private-fragment',
      'private metadata',
    ]) {
      expect(JSON.stringify(payload)).not.toContain(secret);
    }
  });

  it('没有有效请求 ID 时不伪造平台关联或从 usage/嵌套媒体里猜 ID', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...correlationPayload('image'),
          id: 123,
          requestId: {},
          request_id: ' ',
          data: [{ id: 'asset-not-request', b64_json: 'AA==' }],
          usage: { total_tokens: 7, requestId: 'usage-not-request' },
        }),
        { headers: { 'content-type': 'application/json', 'x-request-id': ' ' } },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-private-key',
      fetchImpl,
    });
    const execution = await provider.execute({ snapshot: correlationSnapshot('image') });
    expect(execution).not.toHaveProperty('providerJob');
    expect(execution.usage).toMatchObject({ metadata: { total_tokens: 7 } });
  });
});
