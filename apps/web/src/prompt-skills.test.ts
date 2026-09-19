import {
  acceptTestQuotes,
  withTestQuoteTransport,
  TEST_QUOTE_ID,
} from './marketplace/quote-test-fixture';
import type { PromptDocument } from '@multimodal-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSessionChangedError, clearAuthSession, persistAuthSession } from './auth-client';

import {
  clearPendingPromptOptimization,
  fetchPromptOptimization,
  pendingPromptOptimizationKey,
  PromptOptimizationRequestError,
  PromptOptimizationResultError,
  readPendingPromptOptimization,
  savePendingPromptOptimization,
  submitPromptOptimization,
  validateOptimizedPromptDocument,
  type PromptOptimizationRequest,
} from './prompt-skills';

/** 包含精确版本和角色元数据的原始文档，用于验证引用身份不会丢失。 */
const source: PromptDocument = {
  version: 1,
  blocks: [
    { type: 'text', text: '保持角色 ' },
    {
      type: 'mention',
      mentionId: 'ref-a',
      assetId: 'asset-a',
      assetVersion: 3,
      mediaType: 'image',
      label: '角色图.png',
      semanticRole: 'character',
      entityName: '主角',
      scope: 'scene',
    },
    { type: 'text', text: ' 的服装' },
  ],
};

/** 一次稳定请求，网络恢复时所有字段必须原样保留。 */
const request: PromptOptimizationRequest = {
  projectId: 'project/a',
  nodeId: 'node-a',
  skillId: 'character',
  skillVersion: '1.0.0',
  mediaType: 'image',
  promptDocument: source,
  idempotencyKey: 'stable-key',
};

/** 测试用成功响应，不会调用真实模型。 */
const optimization = {
  runId: 'run/a',
  nodeId: request.nodeId,
  skillId: request.skillId,
  skillVersion: request.skillVersion,
  status: 'succeeded',
  modelAlias: 'text-model',
  credentialId: 'connection-a',
  simulated: true,
  promptDocument: {
    ...source,
    blocks: [{ type: 'text', text: '清晰描述角色 ' }, ...source.blocks.slice(1)],
  },
};

/** 为每次测试返回新的响应流。 */
function response(value: unknown = optimization, status = 200): Response {
  return new Response(JSON.stringify({ optimization: value }), { status });
}

let releaseQuoteConfirmation: (() => void) | undefined;
beforeEach(() => {
  releaseQuoteConfirmation = acceptTestQuotes();
});
afterEach(() => {
  releaseQuoteConfirmation?.();
  clearAuthSession();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('提示词优化客户端', () => {
  it('更换上游后仅提交平台 ID，并按平台身份校验返回结果', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ ...optimization, modelAlias: 'new-alias', platformModelId: 'product-a' }),
      );
    const result = await submitPromptOptimization(
      {
        ...request,
        platformModelId: 'product-a',
        modelAlias: 'old-alias',
        credentialId: 'old-provider',
      },
      '',
      { fetcher: withTestQuoteTransport(fetcher) },
    );
    expect(result.platformModelId).toBe('product-a');
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.platformModelId).toBe('product-a');
    expect(body).not.toHaveProperty('modelAlias');
    expect(body).not.toHaveProperty('credentialId');
    const wrong = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...optimization, platformModelId: 'other-product' }));
    await expect(
      submitPromptOptimization({ ...request, platformModelId: 'product-a' }, '', {
        fetcher: withTestQuoteTransport(wrong),
      }),
    ).rejects.toThrow('身份不一致');
  });
  it('编码项目路由并只提交一次，不向服务器默认模型附加客户端猜测', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    expect(
      await submitPromptOptimization(request, 'https://api.test/', {
        fetcher: withTestQuoteTransport(fetcher),
      }),
    ).toEqual(optimization);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/projects/project%2Fa/prompt-optimizations');
    expect(JSON.parse(String(init?.body))).toEqual({
      nodeId: request.nodeId,
      skillId: request.skillId,
      skillVersion: request.skillVersion,
      mediaType: request.mediaType,
      promptDocument: source,
      idempotencyKey: 'stable-key',
      quoteId: TEST_QUOTE_ID,
    });
    expect(init?.method).toBe('POST');
    expect(source.blocks[0]).toEqual({ type: 'text', text: '保持角色 ' });
  });

  it('透传精确模型、凭据和取消信号，网络失败不自动重试', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection lost'));
    const controller = new AbortController();
    await expect(
      submitPromptOptimization(
        { ...request, modelAlias: 'text-model', credentialId: 'key-b' },
        '',
        { fetcher: withTestQuoteTransport(fetcher), signal: controller.signal },
      ),
    ).rejects.toThrow('connection lost');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.signal).toBe(controller.signal);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      modelAlias: 'text-model',
      credentialId: 'key-b',
      idempotencyKey: 'stable-key',
    });
  });

  it.each([
    { ...optimization, nodeId: 'other' },
    { ...optimization, skillId: 'other' },
    { ...optimization, skillVersion: '2.0.0' },
    { ...optimization, modelAlias: 'other' },
    { ...optimization, credentialId: 'other' },
    { ...optimization, status: 'unexpected' },
    { ...optimization, promptDocument: undefined },
    { ...optimization, promptDocument: { version: 1, blocks: [{ type: 'text', text: ' ' }] } },
  ])('拒绝串任务、模型或无效成功结果 %#', async (invalid) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(invalid));
    await expect(
      submitPromptOptimization(
        { ...request, modelAlias: 'text-model', credentialId: 'connection-a' },
        '',
        { fetcher: withTestQuoteTransport(fetcher) },
      ),
    ).rejects.toThrow();
  });

  it('GET 核对任务 ID 与冻结模型，公开响应不回显旧连接时仍可恢复且不重新提交', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ ...optimization, runId: 'wrong' }))
      .mockResolvedValueOnce(response({ ...optimization, credentialId: undefined }));
    const pending = {
      request,
      runId: 'run/a',
      model: { modelAlias: 'text-model', credentialId: 'connection-a' },
    };
    await expect(
      fetchPromptOptimization(pending, '', { fetcher: withTestQuoteTransport(fetcher) }),
    ).resolves.toEqual(optimization);
    expect(fetcher.mock.calls[0]![0]).toBe('/v1/projects/project%2Fa/prompt-optimizations/run%2Fa');
    expect(fetcher.mock.calls[0]![1]?.method).toBeUndefined();
    await expect(
      fetchPromptOptimization(pending, '', { fetcher: withTestQuoteTransport(fetcher) }),
    ).rejects.toThrow('身份不一致');
    await expect(
      fetchPromptOptimization(pending, '', { fetcher: withTestQuoteTransport(fetcher) }),
    ).resolves.toEqual(
      expect.objectContaining({ runId: pending.runId, modelAlias: pending.model.modelAlias }),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
  });

  it('旧模型请求兼容公开响应省略连接 ID，仍拒绝模型 alias 不一致', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ...optimization, credentialId: undefined }))
      .mockResolvedValueOnce(
        response({ ...optimization, credentialId: undefined, modelAlias: 'other' }),
      );
    const legacyRequest = {
      ...request,
      modelAlias: 'text-model',
      credentialId: 'connection-a',
    };
    const result = await submitPromptOptimization(legacyRequest, '', {
      fetcher: withTestQuoteTransport(fetcher),
    });
    expect(result.modelAlias).toBe('text-model');
    expect(result).not.toHaveProperty('credentialId');
    await expect(
      submitPromptOptimization(legacyRequest, '', {
        fetcher: withTestQuoteTransport(fetcher),
      }),
    ).rejects.toThrow('身份不一致');
  });

  it('GET 恢复按平台身份核对已冻结模型，不因旧 alias 或连接提示拒绝有效响应', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          ...optimization,
          modelAlias: 'current-provider-alias',
          platformModelId: 'product-a',
          credentialId: undefined,
        }),
      )
      .mockResolvedValueOnce(
        response({ ...optimization, platformModelId: 'wrong-product', credentialId: undefined }),
      );
    const pending = {
      request: { ...request, platformModelId: 'product-a' },
      runId: 'run/a',
      model: {
        modelAlias: 'old-provider-alias',
        credentialId: 'old-connection',
        platformModelId: 'product-a',
      },
    };
    await expect(fetchPromptOptimization(pending, '', { fetcher })).resolves.toMatchObject({
      platformModelId: 'product-a',
      modelAlias: 'current-provider-alias',
    });
    await expect(fetchPromptOptimization(pending, '', { fetcher })).rejects.toThrow('身份不一致');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
  });

  it.each([
    undefined,
    { version: 2, blocks: [] },
    { version: 1, blocks: source.blocks.filter((block) => block.type === 'mention') },
    { version: 1, blocks: [{ type: 'text', text: '丢失引用' }] },
  ])('身份确认后把无效成功文档标记为终态错误 %#', async (promptDocument) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ ...optimization, promptDocument }));
    await expect(
      submitPromptOptimization(request, '', { fetcher: withTestQuoteTransport(fetcher) }),
    ).rejects.toBeInstanceOf(PromptOptimizationResultError);
    await expect(
      fetchPromptOptimization({ request, runId: 'run/a' }, '', {
        fetcher: withTestQuoteTransport(fetcher),
      }),
    ).rejects.toMatchObject({
      name: 'PromptOptimizationResultError',
      runId: 'run/a',
    });
  });

  it.each([
    { nodeId: 'other' },
    { runId: 'other' },
    { skillVersion: 'other' },
    { modelAlias: 'other' },
    { credentialId: 'unexpected' },
    { status: 'unrecognized' },
  ])('文档无效但身份或状态不一致时仍为未知响应 %#', async (changes) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        ...optimization,
        credentialId: undefined,
        promptDocument: { version: 1, blocks: [] },
        ...changes,
      }),
    );
    const cause = await fetchPromptOptimization(
      {
        request,
        runId: 'run/a',
        model: { modelAlias: 'text-model' },
      },
      '',
      { fetcher: withTestQuoteTransport(fetcher) },
    ).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBeInstanceOf(PromptOptimizationResultError);
  });

  it.each(['post', 'get'] as const)('%s 在续期等待期间切换账户后不发送优化请求', async (method) => {
    const session = {
      accessToken: 'synthetic-old-token',
      tokenType: 'Bearer' as const,
      expiresIn: 3600,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      user: {
        id: 'user-a',
        email: 'a@example.test',
        role: 'user' as const,
        createdAt: '2026-09-18T00:00:00.000Z',
      },
    };
    persistAuthSession(session);
    let finish!: (value: Response) => void;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending =
      method === 'post'
        ? submitPromptOptimization(request, 'https://api.test')
        : fetchPromptOptimization({ request, runId: 'run/a' }, 'https://api.test');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/auth\/refresh$/);
    persistAuthSession({
      ...session,
      accessToken: 'synthetic-new-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      user: { ...session.user, id: 'user-b' },
    });
    finish(
      new Response(
        JSON.stringify({ ...session, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
      ),
    );
    await expect(pending).rejects.toBeInstanceOf(AuthSessionChangedError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('读取无效终态正文期间切换账户，不能误判为可释放的终态错误', async () => {
    let finish!: (value: unknown) => void;
    const received = response();
    vi.spyOn(received, 'json').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = submitPromptOptimization(request, '', {
      fetcher: withTestQuoteTransport(vi.fn().mockResolvedValue(received)),
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    clearAuthSession();
    finish({ optimization: { ...optimization, promptDocument: undefined } });
    await expect(pending).rejects.toBeInstanceOf(AuthSessionChangedError);
  });

  it('保留失败详情并区分明确拒绝与响应未知', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ error: '模型不可用' }), { status: 422 }));
    await expect(
      submitPromptOptimization(request, '', { fetcher: withTestQuoteTransport(fetcher) }),
    ).rejects.toMatchObject({
      message: '模型不可用',
      status: 422,
      rejected: true,
    });
    expect(new PromptOptimizationRequestError('timeout', 504).rejected).toBe(false);
    expect(new PromptOptimizationRequestError('conflict', 409).rejected).toBe(false);
  });

  it('完整保留引用版本和元数据，并拒绝丢失、改变或新增提及', () => {
    const result = validateOptimizedPromptDocument(
      optimization.promptDocument as PromptDocument,
      source,
    );
    expect(result.blocks[1]).toEqual(source.blocks[1]);
    expect(result.blocks[1]).not.toBe(source.blocks[1]);
    const mention = source.blocks[1]!;
    if (mention.type !== 'mention') throw new Error('fixture');
    for (const blocks of [
      [{ type: 'text' as const, text: 'missing' }],
      [
        { type: 'text' as const, text: 'changed' },
        { ...mention, assetVersion: 4 },
      ],
      [
        { type: 'text' as const, text: 'changed' },
        { ...mention, semanticRole: 'style' },
      ],
      [...source.blocks, { ...mention, mentionId: 'another' }],
    ])
      expect(() => validateOptimizedPromptDocument({ version: 1, blocks }, source)).toThrow(
        '资源提及',
      );
  });

  it('刷新恢复完整快照且仅相同键可清除，损坏记录不静默重建', () => {
    const key = pendingPromptOptimizationKey(
      'user-a',
      'https://api.test',
      request.projectId,
      request.nodeId,
    );
    const pending = { request, runId: 'run/a', model: { modelAlias: 'text-model' } };
    savePendingPromptOptimization(key, pending);
    expect(readPendingPromptOptimization(key)).toEqual(pending);
    clearPendingPromptOptimization(key, 'different-key');
    expect(readPendingPromptOptimization(key)).toEqual(pending);
    clearPendingPromptOptimization(key, request.idempotencyKey);
    expect(readPendingPromptOptimization(key)).toBeUndefined();
    expect(
      pendingPromptOptimizationKey('user-b', 'https://api.test', request.projectId, request.nodeId),
    ).not.toBe(key);
    sessionStorage.setItem(key, '{');
    expect(() => readPendingPromptOptimization(key)).toThrow();
  });
});
