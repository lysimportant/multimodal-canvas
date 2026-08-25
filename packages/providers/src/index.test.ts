import { describe, expect, it, vi } from 'vitest';

import { MockProvider, NewApiProvider, NewApiProviderError } from './index';

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
