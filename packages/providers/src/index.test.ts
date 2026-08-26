import { describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '@multimodal-canvas/domain';

import {
  MockProvider,
  NewApiProvider,
  NewApiProviderError,
  NewApiVideoProvider,
  normalizeNewApiBaseUrl,
} from './index';

describe('MockProvider', () => {
  it('returns a deterministic result from an immutable run snapshot', async () => {
    const reportProgress = vi.fn();
    const provider = new MockProvider();
    const result = await provider.execute({
      reportProgress,
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 4,
        targetNodeId: 'node_image',
        modelAlias: 'mock-image',
        parameters: {},
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Hero image', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
    });

    expect(reportProgress).toHaveBeenCalledWith(100);
    expect(result).toEqual({
      provider: 'mock',
      summary: 'Mock Provider 已完成 Hero image',
      targetNodeId: 'node_image',
      mediaType: 'image',
      inputCount: 0,
    });
  });
});

describe('NewApiProvider', () => {
  const textSnapshot = () => ({
    projectId: 'project_usage',
    canvasRevision: 1,
    targetNodeId: 'node_text',
    modelAlias: 'text-v1',
    parameters: {},
    submittedAt: '2026-08-24T00:00:00.000Z',
    nodes: [
      {
        id: 'node_text',
        type: 'text' as const,
        position: { x: 0, y: 0 },
        data: { label: 'Usage text', mediaType: 'text' as const, mode: 'generate' as const },
      },
    ],
    edges: [],
    inputs: [],
  });

  it('normalizes a pasted gateway origin to the /v1 API prefix', async () => {
    expect(normalizeNewApiBaseUrl('https://gateway.example.com/')).toBe(
      'https://gateway.example.com/v1',
    );
    expect(normalizeNewApiBaseUrl('https://gateway.example.com/custom/')).toBe(
      'https://gateway.example.com/custom',
    );

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await new NewApiProvider({
      baseUrl: 'https://gateway.example.com',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({ snapshot: textSnapshot() });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gateway.example.com/v1/chat/completions',
      expect.any(Object),
    );
  });

  it('rejects ambiguous base URLs and can require HTTPS for production', () => {
    expect(() => normalizeNewApiBaseUrl('https://user:pass@gateway.example.com/v1')).toThrow(
      '用户信息',
    );
    expect(() => normalizeNewApiBaseUrl('https://gateway.example.com/v1?tenant=one')).toThrow(
      '查询参数',
    );
    expect(
      () =>
        new NewApiProvider({
          baseUrl: 'http://localhost:4010/v1',
          apiKey: 'server-secret',
          requireHttps: true,
        }),
    ).toThrow('必须使用 HTTPS');
  });

  it('enforces HTTPS automatically in production but keeps local HTTP in tests', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(
      () =>
        new NewApiProvider({
          baseUrl: 'http://localhost:4010/v1',
          apiKey: 'server-secret',
        }),
    ).toThrow('必须使用 HTTPS');

    vi.stubEnv('NODE_ENV', 'test');
    expect(
      () =>
        new NewApiProvider({
          baseUrl: 'http://localhost:4010/v1',
          apiKey: 'server-secret',
        }),
    ).not.toThrow();
    vi.unstubAllEnvs();
  });

  it('keeps text token usage as metadata without inventing a price', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Generated text' } }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({ snapshot: textSnapshot() });

    expect(result.usage).toEqual({
      metadata: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
    expect(result.usage?.amount).toBeUndefined();
    expect(result.usage?.currency).toBeUndefined();
  });

  it('returns an explicit provider amount only with a valid currency', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Generated text' } }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_cost: '0.0123', currency: 'usd' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({ snapshot: textSnapshot() });

    expect(result.usage).toEqual({
      amount: '0.0123',
      currency: 'USD',
      metadata: { prompt_tokens: 12, completion_tokens: 3, total_cost: '0.0123', currency: 'usd' },
    });
  });

  it('does not attach usage when the provider omits it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'Generated text' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({ snapshot: textSnapshot() });

    expect(result).not.toHaveProperty('usage');
  });

  it('maps an image snapshot to the New API image generation request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const reportProgress = vi.fn();
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1/',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({
      reportProgress,
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 4,
        targetNodeId: 'node_image',
        modelAlias: 'image-v2',
        parameters: {
          size: '1024x1024',
          prompt: 'A neon portrait',
          inferenceStrength: 'medium',
        },
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Hero image', mediaType: 'image', mode: 'generate' },
          },
          {
            id: 'node_style',
            type: 'image',
            position: { x: -200, y: 0 },
            data: {
              label: 'Studio reference',
              mediaType: 'image',
              mode: 'source',
              contentUrl: '/v1/assets/asset_style/content',
            },
          },
        ],
        edges: [
          {
            id: 'edge_style',
            sourceNodeId: 'node_style',
            sourceHandle: 'output:image',
            targetNodeId: 'node_image',
            targetHandle: 'input:style',
            order: 0,
          },
        ],
        inputs: [
          {
            nodeId: 'node_style',
            role: 'style',
            sortOrder: 0,
            snapshot: {
              id: 'node_style',
              type: 'image',
              position: { x: -200, y: 0 },
              data: {
                label: 'Studio reference',
                mediaType: 'image',
                mode: 'source',
                contentUrl: '/v1/assets/asset_style/content',
              },
            },
          },
        ],
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer server-secret' }),
        body: JSON.stringify({
          size: '1024x1024',
          prompt: 'A neon portrait\nstyle: /v1/assets/asset_style/content',
          inferenceStrength: 'medium',
          model: 'image-v2',
          n: 1,
        }),
      }),
    );
    expect(result.result.provider).toBe('newapi');
    expect(result.output).toEqual({
      mediaType: 'image',
      kind: 'url',
      url: 'https://cdn.example/image.png',
      mimeType: 'image/png',
      format: 'png',
    });
    expect(reportProgress).toHaveBeenCalledWith(100);
  });

  it('falls back to the target node prompt when no runtime prompt is provided', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'Generated text' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_text',
        modelAlias: 'text-v1',
        parameters: {},
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_text',
            type: 'text',
            position: { x: 0, y: 0 },
            data: {
              label: 'Fallback label',
              mediaType: 'text',
              mode: 'generate',
              prompt: 'Node prompt',
            },
          },
        ],
        edges: [],
        inputs: [],
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/chat/completions',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'text-v1',
          messages: [{ role: 'user', content: 'Node prompt' }],
        }),
      }),
    );
    expect(result.output).toEqual({
      mediaType: 'text',
      kind: 'text',
      text: 'Generated text',
      mimeType: 'text/plain',
      format: 'txt',
    });
  });

  it('extracts inline base64 image responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_image',
        modelAlias: 'image-v1',
        parameters: { output_format: 'jpeg' },
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Image', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
    });

    expect(result.output).toEqual({
      mediaType: 'image',
      kind: 'base64',
      base64: 'aW1hZ2U=',
      mimeType: 'image/jpeg',
      format: 'jpeg',
    });
  });

  it('uses the New API top-level output format for data[0].b64_json responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          created: 1_756_000_000,
          output_format: 'webp',
          data: [{ b64_json: 'd2VicC1pbWFnZQ==' }],
          usage: { input_tokens: 12, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_image',
        modelAlias: 'gpt-image-2',
        parameters: {},
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Image', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
    });

    expect(result.output).toEqual({
      mediaType: 'image',
      kind: 'base64',
      base64: 'd2VicC1pbWFnZQ==',
      mimeType: 'image/webp',
      format: 'webp',
    });
  });

  it('accepts image arrays returned under a provider-compatible output alias', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ images: [{ url: 'https://cdn.example/alias.webp' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_image',
        modelAlias: 'image-v1',
        parameters: {},
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Image', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
    });

    expect(result.output).toMatchObject({
      mediaType: 'image',
      kind: 'url',
      url: 'https://cdn.example/alias.webp',
      mimeType: 'image/webp',
      format: 'webp',
    });
  });

  it('keeps a response-level image format when the result URL has no known extension', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_format: 'webp',
          data: [{ url: 'https://cdn.example/generated/asset-123' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_image',
        modelAlias: 'gpt-image-2',
        parameters: {},
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Image', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
    });

    expect(result.output).toMatchObject({
      mediaType: 'image',
      kind: 'url',
      mimeType: 'image/webp',
      format: 'webp',
    });
  });

  it('prefers an explicit response image format over a conflicting URL extension', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_format: 'webp',
          data: [{ url: 'https://cdn.example/generated/asset.png' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_image',
        modelAlias: 'gpt-image-2',
        parameters: {},
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Image', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
    });

    expect(result.output).toMatchObject({
      mediaType: 'image',
      kind: 'url',
      mimeType: 'image/webp',
      format: 'webp',
    });
  });

  it('converts an OpenAI-compatible raw audio response to base64', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_audio',
        modelAlias: 'audio-v1',
        parameters: { input: 'say hello', response_format: 'mp3' },
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_audio',
            type: 'audio',
            position: { x: 0, y: 0 },
            data: { label: 'Audio', mediaType: 'audio', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
    });

    expect(result.output).toEqual({
      mediaType: 'audio',
      kind: 'base64',
      base64: 'AAECAw==',
      mimeType: 'audio/mpeg',
      format: 'mp3',
    });
  });

  it('rejects a successful response that has no generated content', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(
      provider.execute({
        snapshot: {
          projectId: 'project_1',
          canvasRevision: 1,
          targetNodeId: 'node_text',
          modelAlias: 'text-v1',
          parameters: {},
          submittedAt: '2026-08-24T00:00:00.000Z',
          nodes: [
            {
              id: 'node_text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Text', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
          inputs: [],
        },
      }),
    ).rejects.toMatchObject({
      name: 'NewApiProviderError',
      message: expect.stringContaining('choices'),
    });
  });

  it('rejects video until the asynchronous video contract is available', async () => {
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl: vi.fn(),
    });
    await expect(
      provider.execute({
        snapshot: {
          projectId: 'project_1',
          canvasRevision: 1,
          targetNodeId: 'node_video',
          modelAlias: 'video-v1',
          parameters: {},
          submittedAt: '2026-08-24T00:00:00.000Z',
          nodes: [
            {
              id: 'node_video',
              type: 'video',
              position: { x: 0, y: 0 },
              data: { label: 'Video', mediaType: 'video', mode: 'generate' },
            },
          ],
          edges: [],
          inputs: [],
        },
      }),
    ).rejects.toBeInstanceOf(NewApiProviderError);
  });

  it('classifies transient provider errors without retrying the generation request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'temporarily overloaded',
            type: 'rate_limit_error',
            code: 'rate_limit',
          },
        }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req-rate-1',
          },
        },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const error = await provider
      .execute({
        snapshot: {
          projectId: 'project_1',
          canvasRevision: 1,
          targetNodeId: 'node_text',
          modelAlias: 'text-v1',
          parameters: {},
          submittedAt: '2026-08-24T00:00:00.000Z',
          nodes: [
            {
              id: 'node_text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Text', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
          inputs: [],
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NewApiProviderError);
    expect(error).toMatchObject({
      status: 429,
      code: 'rate_limit',
      requestId: 'req-rate-1',
      retryable: true,
    });
    expect((error as NewApiProviderError).message).toContain('temporarily overloaded');
    // Retry policy belongs to the caller; one Provider execution means one HTTP request.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('marks validation errors as non-retryable and preserves provider request IDs', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'invalid model', code: 'model_not_found' } }),
        {
          status: 400,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req-invalid-1',
          },
        },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(
      provider.execute({
        snapshot: {
          projectId: 'project_1',
          canvasRevision: 1,
          targetNodeId: 'node_text',
          modelAlias: 'missing-model',
          parameters: {},
          submittedAt: '2026-08-24T00:00:00.000Z',
          nodes: [
            {
              id: 'node_text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Text', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
          inputs: [],
        },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'model_not_found',
      requestId: 'req-invalid-1',
      retryable: false,
    });
  });

  it('classifies transport failures as retryable without exposing credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket closed'));
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(
      provider.execute({
        snapshot: {
          projectId: 'project_1',
          canvasRevision: 1,
          targetNodeId: 'node_text',
          modelAlias: 'text-v1',
          parameters: {},
          submittedAt: '2026-08-24T00:00:00.000Z',
          nodes: [
            {
              id: 'node_text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Text', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
          inputs: [],
        },
      }),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
      message: 'socket closed',
    });
  });

  it('reports aborts as timeouts with a stable diagnostic code', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('operation aborted', 'AbortError'));
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      timeoutMs: 1,
    });

    await expect(
      provider.execute({
        snapshot: {
          projectId: 'project_1',
          canvasRevision: 1,
          targetNodeId: 'node_text',
          modelAlias: 'text-v1',
          parameters: {},
          submittedAt: '2026-08-24T00:00:00.000Z',
          nodes: [
            {
              id: 'node_text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Text', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
          inputs: [],
        },
      }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
      message: 'New API 请求超时',
    });
  });
});

describe('NewApiVideoProvider', () => {
  const videoSnapshot = (): RunSnapshot => ({
    projectId: 'project_video',
    canvasRevision: 3,
    targetNodeId: 'node_video',
    modelAlias: 'grok-imagine-video-1.5',
    parameters: { duration: 8, resolution: '720p', aspectRatio: '16:9' },
    submittedAt: '2026-08-24T00:00:00.000Z',
    nodes: [
      {
        id: 'node_first_frame',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: 'First frame',
          mediaType: 'image',
          mode: 'source',
          contentUrl: 'https://assets.example/first.png',
        },
      },
      {
        id: 'node_style',
        type: 'image',
        position: { x: 0, y: 100 },
        data: {
          label: 'Style reference',
          mediaType: 'image',
          mode: 'source',
          contentUrl: 'https://assets.example/style.png',
        },
      },
      {
        id: 'node_video',
        type: 'video',
        position: { x: 300, y: 0 },
        data: {
          label: 'Generated clip',
          mediaType: 'video',
          mode: 'generate',
          prompt: 'Animate the scene',
        },
      },
    ],
    edges: [],
    inputs: [
      {
        nodeId: 'node_first_frame',
        role: 'firstFrame',
        sortOrder: 0,
        snapshot: {
          id: 'node_first_frame',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'First frame',
            mediaType: 'image',
            mode: 'source',
            contentUrl: 'https://assets.example/first.png',
          },
        },
      },
      {
        nodeId: 'node_style',
        role: 'style',
        sortOrder: 1,
        snapshot: {
          id: 'node_style',
          type: 'image',
          position: { x: 0, y: 100 },
          data: {
            label: 'Style reference',
            mediaType: 'image',
            mode: 'source',
            contentUrl: 'https://assets.example/style.png',
          },
        },
      },
    ],
  });

  it('also enforces HTTPS by default in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(
      () =>
        new NewApiVideoProvider({
          baseUrl: 'http://localhost:4010/v1',
          apiKey: 'server-secret',
        }),
    ).toThrow('必须使用 HTTPS');
    vi.unstubAllEnvs();
  });

  it('submits once, polls to done, and returns an external video URL', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'video-request-123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'pending', progress: 0.2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'done',
            model: 'grok-imagine-video-1.5',
            video: { url: 'https://cdn.example/generated.mp4', duration: 8 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const reportProgress = vi.fn();
    const onProviderJob = vi.fn();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1/',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 3,
    });

    const execution = await provider.execute({
      snapshot: videoSnapshot(),
      reportProgress,
      onProviderJob,
    });

    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://newapi.example.com/v1/videos/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer server-secret' }),
        body: JSON.stringify({
          model: 'grok-imagine-video-1.5',
          prompt:
            'Animate the scene\nfirstFrame: https://assets.example/first.png\nstyle: https://assets.example/style.png',
          duration: 8,
          resolution: '720p',
          aspect_ratio: '16:9',
          image: { url: 'https://assets.example/first.png' },
          reference_images: [{ url: 'https://assets.example/style.png' }],
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://newapi.example.com/v1/videos/video-request-123',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(execution.result).toMatchObject({
      provider: 'newapi',
      targetNodeId: 'node_video',
      mediaType: 'video',
      inputCount: 2,
    });
    expect(execution.output).toEqual({
      mediaType: 'video',
      kind: 'url',
      url: 'https://cdn.example/generated.mp4',
      mimeType: 'video/mp4',
      format: 'mp4',
    });
    expect(execution.providerJob).toMatchObject({
      provider: 'newapi',
      platformJobId: 'video-request-123',
      status: 'succeeded',
      progress: 100,
      payload: {
        contract: 'newapi-video-v1',
        phase: 'completed',
        modelAlias: 'grok-imagine-video-1.5',
        providerStatus: 'done',
        progress: 100,
      },
    });
    expect(onProviderJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: 'newapi',
        platformJobId: 'video-request-123',
        status: 'submitted',
        payload: expect.objectContaining({
          contract: 'newapi-video-v1',
          phase: 'submitted',
          modelAlias: 'grok-imagine-video-1.5',
        }),
      }),
    );
    expect(onProviderJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        platformJobId: 'video-request-123',
        status: 'running',
        payload: expect.objectContaining({
          contract: 'newapi-video-v1',
          phase: 'completed',
          providerStatus: 'done',
        }),
      }),
    );
    expect(reportProgress).toHaveBeenLastCalledWith(100);
  });

  it('downloads the authenticated content endpoint when done has no public URL', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'private-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'done', video: { duration: 8 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '4' },
        }),
      );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    });

    const execution = await provider.execute({ snapshot: videoSnapshot() });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://newapi.example.com/v1/videos/private-video/content',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer server-secret' }),
      }),
    );
    expect(execution.output).toEqual({
      mediaType: 'video',
      kind: 'base64',
      base64: 'AAECAw==',
      mimeType: 'video/mp4',
      format: 'mp4',
    });
  });

  it('keeps custom creation and task paths independent', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'custom-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'done', video: { url: 'https://cdn.example/custom.mp4' } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      videoCreatePath: '/videos/generations',
      videoJobsPath: '/video-tasks',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    });

    await provider.execute({ snapshot: videoSnapshot() });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://newapi.example.com/v1/videos/generations',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://newapi.example.com/v1/video-tasks/custom-video',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('surfaces terminal provider failures without creating a second task', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'failed-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'failed',
            error: { message: 'content rejected', code: 'moderation_rejected' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 2,
    });

    await expect(provider.execute({ snapshot: videoSnapshot() })).rejects.toMatchObject({
      code: 'VIDEO_GENERATION_FAILED',
      retryable: false,
      message: 'content rejected',
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('bounds polling and reports a retryable timeout', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'slow-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ status: 'pending' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 2,
    });

    await expect(provider.execute({ snapshot: videoSnapshot() })).rejects.toMatchObject({
      code: 'VIDEO_POLL_TIMEOUT',
      platformJobId: 'slow-video',
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('rejects a creation response that omits the platform request ID', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 'accepted' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'transport-request' },
      }),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });

    await expect(provider.execute({ snapshot: videoSnapshot() })).rejects.toMatchObject({
      code: 'VIDEO_REQUEST_ID_MISSING',
      requestId: 'transport-request',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('marks an ambiguous creation transport failure non-retryable', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('socket closed after upload'));
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });

    await expect(provider.execute({ snapshot: videoSnapshot() })).rejects.toMatchObject({
      code: 'VIDEO_SUBMISSION_UNKNOWN',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops after creation when the platform job ID cannot be persisted', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ request_id: 'durable-video' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });

    await expect(
      provider.execute({
        snapshot: videoSnapshot(),
        onProviderJob: async () => {
          throw new Error('database unavailable');
        },
      }),
    ).rejects.toMatchObject({
      code: 'VIDEO_JOB_PERSISTENCE_FAILED',
      platformJobId: 'durable-video',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resumes an existing platform job without issuing another POST', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'done',
          video: { url: 'https://cdn.example/resumed.mp4' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const onProviderJob = vi.fn();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    });

    const execution = await provider.execute({
      snapshot: videoSnapshot(),
      providerJob: {
        provider: 'newapi',
        platformJobId: 'already-created',
        status: 'submitted',
        progress: 35,
        payload: { contract: 'newapi-video-v1', phase: 'submitted' },
      },
      onProviderJob,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/videos/already-created',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(execution.output).toMatchObject({
      mediaType: 'video',
      kind: 'url',
      url: 'https://cdn.example/resumed.mp4',
    });
    expect(onProviderJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        platformJobId: 'already-created',
        status: 'submitted',
        progress: 35,
        payload: expect.objectContaining({ phase: 'resumed' }),
      }),
    );
  });
});
