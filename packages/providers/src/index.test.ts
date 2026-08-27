import { describe, expect, it, vi } from 'vitest';
import type { MediaType, PortRole, RunInputSnapshot, RunSnapshot } from '@multimodal-canvas/domain';

import {
  MockProvider,
  NewApiProvider,
  NewApiProviderError,
  NewApiVideoProvider,
  normalizeNewApiBaseUrl,
} from './index';

const allPortRoles = [
  'prompt',
  'negativePrompt',
  'content',
  'style',
  'character',
  'firstFrame',
  'lastFrame',
  'audioTrack',
  'transcript',
  'mask',
] as const satisfies readonly PortRole[];

type StandardMediaType = Exclude<MediaType, 'video'>;

const standardSupportedInputRoles = {
  text: ['prompt', 'content', 'transcript'],
  image: ['prompt'],
  audio: ['prompt'],
} as const satisfies Record<StandardMediaType, readonly PortRole[]>;

const unsupportedStandardRoleCases = (['text', 'image', 'audio'] as const).flatMap((mediaType) =>
  allPortRoles
    .filter(
      (role) => !(standardSupportedInputRoles[mediaType] as readonly PortRole[]).includes(role),
    )
    .map((role) => ({ mediaType, role })),
);

const unsupportedVideoInputRoles = allPortRoles.filter(
  (role) => !(role === 'prompt' || role === 'firstFrame'),
);

const inputMediaTypeByRole: Record<PortRole, MediaType> = {
  prompt: 'text',
  negativePrompt: 'text',
  content: 'text',
  style: 'image',
  character: 'image',
  firstFrame: 'image',
  lastFrame: 'image',
  audioTrack: 'audio',
  transcript: 'text',
  mask: 'image',
};

function providerInput(id: string, role: PortRole, sortOrder: number): RunInputSnapshot {
  const mediaType = inputMediaTypeByRole[role];
  return {
    nodeId: id,
    role,
    sortOrder,
    snapshot: {
      id,
      type: mediaType,
      position: { x: 0, y: 0 },
      data: {
        label: id,
        mediaType,
        mode: 'source',
        ...(mediaType === 'text'
          ? { prompt: `${role} value` }
          : {
              contentUrl: `https://assets.example/${id}.${mediaType === 'image' ? 'png' : 'mp3'}`,
            }),
      },
    },
  };
}

function standardSnapshot(mediaType: StandardMediaType): RunSnapshot {
  const targetNodeId = `node_${mediaType}`;
  return {
    projectId: 'project_role_matrix',
    canvasRevision: 1,
    targetNodeId,
    modelAlias: `${mediaType}-v1`,
    parameters: {},
    submittedAt: '2026-08-24T00:00:00.000Z',
    nodes: [
      {
        id: targetNodeId,
        type: mediaType,
        position: { x: 0, y: 0 },
        data: { label: `${mediaType} target`, mediaType, mode: 'generate' },
      },
    ],
    edges: [],
    inputs: [],
  };
}

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

  const textInput = (id: string, role: PortRole, sortOrder: number, prompt: string) => ({
    nodeId: id,
    role,
    sortOrder,
    snapshot: {
      id,
      type: 'text' as const,
      position: { x: 0, y: 0 },
      data: { label: id, mediaType: 'text' as const, mode: 'source' as const, prompt },
    },
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

  it('maps the node thinking mode to reasoning_effort for text models', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '深度回答' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await provider.execute({
      snapshot: {
        ...textSnapshot(),
        parameters: {
          prompt: 'runtime prompt',
          inferenceStrength: 'high',
          temperature: 0.2,
        },
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/chat/completions',
      expect.objectContaining({
        body: JSON.stringify({
          temperature: 0.2,
          reasoning_effort: 'high',
          model: 'text-v1',
          messages: [{ role: 'user', content: 'runtime prompt' }],
        }),
      }),
    );
  });

  it('maps ordered text roles to separate chat messages without concatenating them', async () => {
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

    await provider.execute({
      snapshot: {
        ...textSnapshot(),
        inputs: [
          textInput('node_prompt', 'prompt', 4, 'Primary instruction'),
          textInput('node_content_later', 'content', 3, 'Later supporting content'),
          textInput('node_content_earlier', 'content', 2, 'Earlier supporting content'),
          textInput('node_transcript', 'transcript', 1, 'Transcript context'),
        ],
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/chat/completions',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'text-v1',
          messages: [
            { role: 'user', name: 'canvas_transcript', content: 'Transcript context' },
            { role: 'user', name: 'canvas_content', content: 'Earlier supporting content' },
            { role: 'user', name: 'canvas_content', content: 'Later supporting content' },
            { role: 'user', name: 'canvas_prompt', content: 'Primary instruction' },
          ],
        }),
      }),
    );
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
        ],
        edges: [],
        inputs: [],
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer server-secret' }),
        body: JSON.stringify({
          size: '1024x1024',
          model: 'image-v2',
          prompt: 'A neon portrait',
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

  it('maps one linked prompt to the image prompt field without appending reference labels', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/linked.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await provider.execute({
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_image',
        modelAlias: 'image-v2',
        parameters: { size: '1024x1024' },
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Image fallback', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [textInput('node_prompt', 'prompt', 0, 'Linked image prompt')],
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/images/generations',
      expect.objectContaining({
        body: JSON.stringify({
          size: '1024x1024',
          model: 'image-v2',
          prompt: 'Linked image prompt',
          n: 1,
        }),
      }),
    );
  });

  it('maps one linked prompt to the audio input field', async () => {
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

    await provider.execute({
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_audio',
        modelAlias: 'audio-v1',
        parameters: { response_format: 'mp3' },
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_audio',
            type: 'audio',
            position: { x: 0, y: 0 },
            data: { label: 'Audio fallback', mediaType: 'audio', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [textInput('node_prompt', 'prompt', 0, 'Read this sentence')],
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/audio/speech',
      expect.objectContaining({
        body: JSON.stringify({
          response_format: 'mp3',
          model: 'audio-v1',
          input: 'Read this sentence',
        }),
      }),
    );
  });

  it.each(unsupportedStandardRoleCases)(
    '$mediaType rejects unsupported $role before sending a generation request',
    async ({ mediaType, role }) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      });

      await expect(
        provider.execute({
          snapshot: {
            ...standardSnapshot(mediaType),
            inputs: [providerInput('node_input', role, 0)],
          },
        }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_INPUT_ROLE',
        retryable: false,
        message: `New API ${mediaType} 不支持该输入角色：${role}`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['image', 'audio'] as const)(
    '$mediaType rejects multiple prompt values instead of dropping their order',
    async (mediaType) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      });

      await expect(
        provider.execute({
          snapshot: {
            ...standardSnapshot(mediaType),
            inputs: [
              providerInput('node_prompt_later', 'prompt', 2),
              providerInput('node_prompt_earlier', 'prompt', 1),
            ],
          },
        }),
      ).rejects.toMatchObject({
        code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
        retryable: false,
        message: `New API ${mediaType} 不支持该输入角色的多个值：prompt`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

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

  it('stops buffering provider responses after the configured size limit', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('12345', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '5' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      maxResponseBytes: 4,
      fetchImpl,
    });

    await expect(provider.execute({ snapshot: textSnapshot() })).rejects.toMatchObject({
      name: 'NewApiProviderError',
      code: 'RESPONSE_TOO_LARGE',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it('reuses the durable provider-job ID as the idempotency key across caller retries', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
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
    const request = {
      snapshot: textSnapshot(),
      providerJob: { provider: 'newapi' as const, id: 'provider_job_run_1' },
    };

    await expect(provider.execute(request)).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
    await provider.execute(request);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const callIndex of [1, 2]) {
      expect(fetchImpl).toHaveBeenNthCalledWith(
        callIndex,
        'https://newapi.example.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'idempotency-key': 'provider_job_run_1' }),
        }),
      );
    }
  });

  it('rejects a mismatched provider job before a paid standard request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(
      provider.execute({
        snapshot: textSnapshot(),
        providerJob: { provider: 'mock', id: 'provider_job_wrong' },
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
          prompt: 'Animate the scene',
          duration: 8,
          resolution: '720p',
          aspect_ratio: '16:9',
          image: { url: 'https://assets.example/first.png' },
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://newapi.example.com/v1/videos/generations',
      expect.objectContaining({
        headers: expect.objectContaining({ 'idempotency-key': expect.any(String) }),
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
      inputCount: 1,
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

  it('maps a linked prompt and first frame through the documented video fields', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'linked-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'done', video: { url: 'https://cdn.example/linked.mp4' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    });
    const snapshot = videoSnapshot();
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new Error('video target fixture is missing');
    target.data = { ...target.data, prompt: undefined };
    const promptInput = {
      nodeId: 'node_prompt',
      role: 'prompt' as const,
      sortOrder: 0,
      snapshot: {
        id: 'node_prompt',
        type: 'text' as const,
        position: { x: -200, y: 0 },
        data: {
          label: 'Video prompt',
          mediaType: 'text' as const,
          mode: 'source' as const,
          prompt: 'A slow camera move',
        },
      },
    };
    snapshot.nodes.push(promptInput.snapshot);
    snapshot.inputs = [promptInput, ...snapshot.inputs];

    await provider.execute({ snapshot });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://newapi.example.com/v1/videos/generations',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'grok-imagine-video-1.5',
          prompt: 'A slow camera move',
          duration: 8,
          resolution: '720p',
          aspect_ratio: '16:9',
          image: { url: 'https://assets.example/first.png' },
        }),
      }),
    );
  });

  it('sends one idempotent video POST and forbids automatic retry when submission is ambiguous', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });
    const request = {
      snapshot: videoSnapshot(),
      providerJob: { provider: 'newapi' as const, id: 'provider_job_video_retry' },
    };

    await expect(provider.execute(request)).rejects.toMatchObject({
      code: 'VIDEO_SUBMISSION_UNKNOWN',
      retryable: false,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/videos/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'idempotency-key': 'provider_job_video_retry',
        }),
      }),
    );
  });

  it.each(unsupportedVideoInputRoles)(
    'rejects unsupported video role %s before creating or resuming a paid task',
    async (role) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new NewApiVideoProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
        pollIntervalMs: 0,
      });
      const snapshot = videoSnapshot();
      snapshot.inputs.push(providerInput(`node_${role}`, role, 1));

      await expect(
        provider.execute({
          snapshot,
          providerJob: {
            provider: 'newapi',
            platformJobId: 'must-not-resume',
            status: 'submitted',
            progress: 10,
          },
        }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_INPUT_ROLE',
        retryable: false,
        message: `New API video 不支持该输入角色：${role}`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['prompt', 'firstFrame'] as const)(
    'rejects multiple video %s inputs instead of dropping their order',
    async (role) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new NewApiVideoProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
        pollIntervalMs: 0,
      });
      const snapshot = videoSnapshot();
      snapshot.inputs.push(providerInput(`node_${role}_later`, role, 2));
      if (role === 'prompt') {
        snapshot.inputs.push(providerInput('node_prompt_earlier', role, 1));
      }

      await expect(provider.execute({ snapshot })).rejects.toMatchObject({
        code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
        retryable: false,
        message: `New API video 不支持该输入角色的多个值：${role}`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

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
