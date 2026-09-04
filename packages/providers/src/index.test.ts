import { describe, expect, it, vi } from 'vitest';
import type { MediaType, PortRole, RunInputSnapshot, RunSnapshot } from '@multimodal-canvas/domain';

import {
  MockProvider,
  NewApiProvider,
  NewApiProviderError,
  NewApiVideoProvider,
  normalizeNewApiBaseUrl,
  resolveProviderMentions,
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
  // 文本节点可通过提示词或内容语义端口连接；两者都映射到接口的主文字字段。
  image: ['prompt', 'content'],
  audio: ['prompt', 'content'],
} as const satisfies Record<StandardMediaType, readonly PortRole[]>;

const unsupportedStandardRoleCases = (['text', 'image', 'audio'] as const).flatMap((mediaType) =>
  allPortRoles
    .filter(
      (role) => !(standardSupportedInputRoles[mediaType] as readonly PortRole[]).includes(role),
    )
    .map((role) => ({ mediaType, role })),
);

const unsupportedVideoInputRoles = allPortRoles.filter(
  (role) => !(role === 'prompt' || role === 'content' || role === 'firstFrame'),
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

function syntheticApiKey(label: string): string {
  return `${['s', 'k'].join('')}-test-${label}-123456`;
}

function providerInputWithMediaType(
  id: string,
  role: PortRole,
  sortOrder: number,
  mediaType: MediaType,
): RunInputSnapshot {
  const input = providerInput(id, role, sortOrder);
  return {
    ...input,
    snapshot: {
      ...input.snapshot,
      type: mediaType,
      data: {
        ...input.snapshot.data,
        mediaType,
        ...(mediaType === 'text'
          ? { prompt: `${role} value`, contentUrl: undefined }
          : { prompt: undefined, contentUrl: `https://assets.example/${id}.${mediaType}` }),
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

  it('echoes every frozen prompt mention without exposing media content', async () => {
    const mentions = [
      {
        nodeId: 'node_image',
        mentionId: 'm-1',
        assetId: 'asset-image',
        assetVersion: 3,
        mediaType: 'image' as const,
        label: '产品图',
        blockOrder: 0,
        binding: { entityName: '产品', semanticRole: 'appearance' },
      },
      {
        nodeId: 'node_image',
        mentionId: 'm-2',
        assetId: 'asset-image',
        assetVersion: 3,
        mediaType: 'image' as const,
        label: '产品图',
        blockOrder: 2,
      },
    ];
    const result = await new MockProvider().execute({
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_image',
        modelAlias: 'mock-image',
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
        promptMentions: mentions,
      },
    });

    expect(result.promptMentions).toEqual(mentions);
    expect(result.simulated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('contentUrl');
  });
});

describe('NewApiProvider', () => {
  const textSnapshot = (): RunSnapshot => ({
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

  it('uses a structured prompt document before the legacy node prompt', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const snapshot = textSnapshot();
    snapshot.parameters.prompt = 'derived parameter prompt';
    snapshot.nodes[0].data = {
      ...snapshot.nodes[0].data,
      prompt: 'legacy prompt',
      promptDocument: {
        version: 1,
        blocks: [
          { type: 'text', text: 'new prompt ' },
          { type: 'text', text: '@产品图' },
        ],
      },
    };
    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({ snapshot });

    const request = fetchImpl.mock.calls[0]?.[1];
    const payload = JSON.parse(String(request?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(payload.messages[0]?.content).toBe('new prompt @产品图');
    expect(String(payload.messages[0]?.content)).not.toContain('legacy prompt');
    expect(String(payload.messages[0]?.content)).not.toContain('derived parameter prompt');
  });

  it('maps a resolved image mention to an image_url content part', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const snapshot = textSnapshot();
    // 这两个字段只由 Worker 在 Provider 调用前临时注入，故测试通过
    // 受控类型断言构造内存态文档，不把它们加入持久化 PromptMention 类型。
    snapshot.nodes[0].data.promptDocument = {
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'mention-image',
          assetId: 'asset-image',
          assetVersion: 2,
          label: '产品图',
          mediaType: 'image',
          mimeType: 'image/png',
          contentUrl: 'data:image/png;base64,aW1hZ2U=',
        },
      ],
    } as unknown as NonNullable<RunSnapshot['nodes'][number]['data']['promptDocument']>;
    snapshot.promptMentions = [
      {
        nodeId: 'node_text',
        mentionId: 'mention-image',
        assetId: 'asset-image',
        assetVersion: 2,
        label: '产品图',
        mediaType: 'image',
        blockOrder: 0,
      },
    ];
    const resolvedMentions = resolveProviderMentions(snapshot);

    expect(resolvedMentions).toMatchObject([
      {
        nodeId: 'node_text',
        mentionId: 'mention-image',
        assetVersion: 2,
        source: {
          kind: 'data-url',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,aW1hZ2U=',
        },
      },
    ]);
    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({ snapshot, resolvedMentions });

    const request = fetchImpl.mock.calls[0]?.[1];
    const payload = JSON.parse(String(request?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(payload.messages[0]?.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
    ]);
  });

  it('fails closed when a structured mention is present without a frozen list', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const snapshot = textSnapshot();
    snapshot.nodes[0].data.promptDocument = {
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'mention-unfrozen',
          assetId: 'asset-image',
          label: '产品图',
          mediaType: 'image',
        },
      ],
    };

    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_MENTION_RESOLUTION_MISSING',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves promptDocument order and maps text, image, audio, and video mentions', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const snapshot = textSnapshot();
    snapshot.nodes[0].data.promptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: 'before ' },
        {
          type: 'mention',
          mentionId: 'mention-text',
          assetId: 'asset-text',
          assetVersion: 1,
          label: '资料',
          mediaType: 'text',
          mimeType: 'text/plain',
          contentUrl: 'data:text/plain;base64,5LiW55WM',
        },
        { type: 'text', text: ' middle ' },
        {
          type: 'mention',
          mentionId: 'mention-image-1',
          assetId: 'asset-image',
          assetVersion: 2,
          label: '产品图',
          mediaType: 'image',
          mimeType: 'image/png',
          contentUrl: 'data:image/png;base64,aW1hZ2U=',
        },
        {
          type: 'mention',
          mentionId: 'mention-image-2',
          assetId: 'asset-image',
          assetVersion: 2,
          label: '产品图重复引用',
          mediaType: 'image',
          mimeType: 'image/png',
          contentUrl: 'data:image/png;base64,aW1hZ2U=',
        },
        {
          type: 'mention',
          mentionId: 'mention-audio',
          assetId: 'asset-audio',
          assetVersion: 3,
          label: '声音样本',
          mediaType: 'audio',
          mimeType: 'audio/wav',
          contentUrl: 'data:audio/wav;base64,YXVkaW8=',
        },
        {
          type: 'mention',
          mentionId: 'mention-video',
          assetId: 'asset-video',
          assetVersion: 4,
          label: '参考视频',
          mediaType: 'video',
          mimeType: 'video/mp4',
          contentUrl: 'data:video/mp4;base64,dmlkZW8=',
        },
        { type: 'text', text: ' after' },
      ],
    } as unknown as NonNullable<RunSnapshot['nodes'][number]['data']['promptDocument']>;
    snapshot.promptMentions = [
      {
        nodeId: 'node_text',
        mentionId: 'mention-text',
        assetId: 'asset-text',
        assetVersion: 1,
        label: '资料',
        mediaType: 'text',
        blockOrder: 1,
      },
      {
        nodeId: 'node_text',
        mentionId: 'mention-image-1',
        assetId: 'asset-image',
        assetVersion: 2,
        label: '产品图',
        mediaType: 'image',
        blockOrder: 3,
      },
      {
        nodeId: 'node_text',
        mentionId: 'mention-image-2',
        assetId: 'asset-image',
        assetVersion: 2,
        label: '产品图重复引用',
        mediaType: 'image',
        blockOrder: 4,
      },
      {
        nodeId: 'node_text',
        mentionId: 'mention-audio',
        assetId: 'asset-audio',
        assetVersion: 3,
        label: '声音样本',
        mediaType: 'audio',
        blockOrder: 5,
      },
      {
        nodeId: 'node_text',
        mentionId: 'mention-video',
        assetId: 'asset-video',
        assetVersion: 4,
        label: '参考视频',
        mediaType: 'video',
        blockOrder: 6,
      },
    ];

    const resolvedMentions = resolveProviderMentions(snapshot);
    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({ snapshot, resolvedMentions });

    const request = fetchImpl.mock.calls[0]?.[1];
    const payload = JSON.parse(String(request?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(payload.messages[0]?.content).toEqual([
      { type: 'text', text: 'before ' },
      { type: 'text', text: '世界' },
      { type: 'text', text: ' middle ' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
      { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
      { type: 'video_url', video_url: 'data:video/mp4;base64,dmlkZW8=' },
      { type: 'text', text: ' after' },
    ]);
  });

  it('rejects an invalid mention payload before the text request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const snapshot = textSnapshot();
    snapshot.nodes[0].data.promptDocument = {
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'mention-audio',
          assetId: 'asset-audio',
          assetVersion: 1,
          label: '声音样本',
          mediaType: 'audio',
          mimeType: 'audio/wav',
          contentUrl: 'data:audio/wav,not-base64',
        },
      ],
    } as unknown as NonNullable<RunSnapshot['nodes'][number]['data']['promptDocument']>;
    snapshot.promptMentions = [
      {
        nodeId: 'node_text',
        mentionId: 'mention-audio',
        assetId: 'asset-audio',
        assetVersion: 1,
        label: '声音样本',
        mediaType: 'audio',
        blockOrder: 0,
      },
    ];

    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_MENTION_PROVIDER_MAPPING_UNSUPPORTED',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      mimeType: 'application/json',
      contentUrl: 'data:application/json,%7B%22name%22%3A%22%E4%B8%96%E7%95%8C%22%7D',
      expectedText: '{"name":"世界"}',
    },
    {
      mimeType: 'application/xml',
      contentUrl: 'data:application/xml,%3Ctitle%3E%E4%B8%96%E7%95%8C%3C%2Ftitle%3E',
      expectedText: '<title>世界</title>',
    },
  ])(
    'decodes $mimeType text mentions as UTF-8 content',
    async ({ mimeType, contentUrl, expectedText }) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const snapshot = textSnapshot();
      snapshot.nodes[0].data.promptDocument = {
        version: 1,
        blocks: [
          {
            type: 'mention',
            mentionId: 'mention-text-document',
            assetId: 'asset-text-document',
            assetVersion: 1,
            label: '文档',
            mediaType: 'text',
            mimeType,
            contentUrl,
          },
        ],
      } as unknown as NonNullable<RunSnapshot['nodes'][number]['data']['promptDocument']>;
      snapshot.promptMentions = [
        {
          nodeId: snapshot.targetNodeId,
          mentionId: 'mention-text-document',
          assetId: 'asset-text-document',
          assetVersion: 1,
          label: '文档',
          mediaType: 'text',
          blockOrder: 0,
        },
      ];

      await new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) });

      const request = fetchImpl.mock.calls[0]?.[1];
      const payload = JSON.parse(String(request?.body)) as {
        messages: Array<{ content: unknown }>;
      };
      expect(payload.messages[0]?.content).toEqual([{ type: 'text', text: expectedText }]);
    },
  );

  it('rejects invalid UTF-8 text mention bytes before the text request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const snapshot = textSnapshot();
    snapshot.nodes[0].data.promptDocument = {
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'mention-invalid-utf8',
          assetId: 'asset-invalid-utf8',
          assetVersion: 1,
          label: '损坏文档',
          mediaType: 'text',
          mimeType: 'text/plain',
          contentUrl: 'data:text/plain;base64,//4=',
        },
      ],
    } as unknown as NonNullable<RunSnapshot['nodes'][number]['data']['promptDocument']>;
    snapshot.promptMentions = [
      {
        nodeId: snapshot.targetNodeId,
        mentionId: 'mention-invalid-utf8',
        assetId: 'asset-invalid-utf8',
        assetVersion: 1,
        label: '损坏文档',
        mediaType: 'text',
        blockOrder: 0,
      },
    ];

    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_MENTION_PROVIDER_MAPPING_INVALID',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects audio mention formats outside the New API input_audio enum', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const snapshot = textSnapshot();
    snapshot.nodes[0].data.promptDocument = {
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'mention-ogg',
          assetId: 'asset-ogg',
          assetVersion: 1,
          label: 'Ogg 音频',
          mediaType: 'audio',
          mimeType: 'audio/ogg',
          contentUrl: 'data:audio/ogg;base64,b2dn',
        },
      ],
    } as unknown as NonNullable<RunSnapshot['nodes'][number]['data']['promptDocument']>;
    snapshot.promptMentions = [
      {
        nodeId: snapshot.targetNodeId,
        mentionId: 'mention-ogg',
        assetId: 'asset-ogg',
        assetVersion: 1,
        label: 'Ogg 音频',
        mediaType: 'audio',
        blockOrder: 0,
      },
    ];

    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_MENTION_PROVIDER_MAPPING_UNSUPPORTED',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { targetMediaType: 'image' as const, mentionMediaType: 'image' as const },
    { targetMediaType: 'audio' as const, mentionMediaType: 'audio' as const },
  ])(
    'rejects a $mentionMediaType mention on the $targetMediaType generation endpoint before POST',
    async ({ targetMediaType, mentionMediaType }) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const snapshot = standardSnapshot(targetMediaType);
      const dataUrl =
        mentionMediaType === 'image'
          ? 'data:image/png;base64,aW1hZ2U='
          : 'data:audio/wav;base64,YXVkaW8=';
      snapshot.nodes[0].data.promptDocument = {
        version: 1,
        blocks: [
          {
            type: 'mention',
            mentionId: `mention-${mentionMediaType}`,
            assetId: `asset-${mentionMediaType}`,
            assetVersion: 1,
            label: mentionMediaType,
            mediaType: mentionMediaType,
            mimeType: mentionMediaType === 'image' ? 'image/png' : 'audio/wav',
            contentUrl: dataUrl,
          },
        ],
      } as unknown as NonNullable<RunSnapshot['nodes'][number]['data']['promptDocument']>;
      snapshot.promptMentions = [
        {
          nodeId: snapshot.targetNodeId,
          mentionId: `mention-${mentionMediaType}`,
          assetId: `asset-${mentionMediaType}`,
          assetVersion: 1,
          label: mentionMediaType,
          mediaType: mentionMediaType,
          blockOrder: 0,
        },
      ];

      await expect(
        new NewApiProvider({
          baseUrl: 'https://newapi.example.com/v1',
          apiKey: 'server-secret',
          fetchImpl,
        }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) }),
      ).rejects.toMatchObject({
        code: 'RESOURCE_MENTION_PROVIDER_MAPPING_UNSUPPORTED',
        retryable: false,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('parses the explicit Responses output_text envelope', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ output_text: 'Responses text' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({ snapshot: textSnapshot() });
    expect(result.output).toMatchObject({ kind: 'text', text: 'Responses text' });
  });

  it('parses only typed output_text parts from a Responses output array', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            { type: 'reasoning', summary: [{ text: 'internal' }] },
            {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Visible ' },
                { type: 'refusal', text: 'no' },
              ],
            },
            { type: 'output_text', text: 'text' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({ snapshot: textSnapshot() });
    expect(result.output).toMatchObject({ kind: 'text', text: 'Visible text' });
  });

  it('keeps choices as the canonical envelope when other output fields exist', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Canonical text' } }],
          output_text: 'Fallback text',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({ snapshot: textSnapshot() });
    expect(result.output).toMatchObject({ kind: 'text', text: 'Canonical text' });
  });

  it('rejects reasoning-only Responses output', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ output: [{ type: 'reasoning', summary: [{ text: 'internal' }] }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot: textSnapshot() }),
    ).rejects.toMatchObject({ name: 'NewApiProviderError', message: 'New API 文本响应内容为空' });
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

  it('passes through dynamic reasoning effort identifiers for text models', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '回答' } }] }), {
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
          inferenceStrength: ' xhigh ',
        },
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"reasoning_effort":"xhigh"'),
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

  it('normalizes image size and quality aliases for the New API payload', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/alias.png' }] }), {
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
        ...standardSnapshot('image'),
        modelAlias: 'image-alias-v1',
        parameters: {
          imageSize: '1536x1024',
          imageQuality: 'high',
          prompt: 'Alias image',
        },
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/images/generations',
      expect.objectContaining({
        body: JSON.stringify({
          size: '1536x1024',
          quality: 'high',
          model: 'image-alias-v1',
          prompt: 'Alias image',
          n: 1,
        }),
      }),
    );
  });

  it('maps image aspect ratio to the New API field', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/portrait.png' }] }), {
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
        ...standardSnapshot('image'),
        modelAlias: 'image-portrait-v1',
        parameters: {
          size: '1024x1536',
          quality: '4k',
          aspectRatio: '9:16',
          prompt: 'Portrait image',
        },
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/images/generations',
      expect.objectContaining({
        body: JSON.stringify({
          size: '1024x1536',
          quality: '4k',
          aspect_ratio: '9:16',
          model: 'image-portrait-v1',
          prompt: 'Portrait image',
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

  it.each(['image', 'audio'] as const)(
    'maps text content connected to a %s node into its primary prompt field',
    async (mediaType) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        mediaType === 'image'
          ? new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/content.png' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(new Uint8Array([0, 1, 2]), {
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
          ...standardSnapshot(mediaType),
          modelAlias: `${mediaType}-v1`,
          inputs: [providerInput('node_content', 'content', 0)],
        },
      });

      expect(fetchImpl).toHaveBeenCalledWith(
        `https://newapi.example.com/v1/${mediaType === 'image' ? 'images/generations' : 'audio/speech'}`,
        expect.objectContaining({
          body: JSON.stringify({
            model: `${mediaType}-v1`,
            ...(mediaType === 'image'
              ? { prompt: 'content value', n: 1 }
              : { input: 'content value' }),
          }),
        }),
      );
    },
  );

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

  it.each([
    { targetMediaType: 'image', sourceMediaType: 'image', role: 'style' },
    { targetMediaType: 'image', sourceMediaType: 'video', role: 'content' },
  ] as const)(
    'rejects $sourceMediaType input to unsupported $targetMediaType role $role before sending',
    async ({ targetMediaType, sourceMediaType, role }) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      });

      await expect(
        provider.execute({
          snapshot: {
            ...standardSnapshot(targetMediaType),
            inputs: [providerInputWithMediaType('node_input', role, 0, sourceMediaType)],
          },
        }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_INPUT_ROLE',
        retryable: false,
        message:
          sourceMediaType === 'video' && targetMediaType === 'image' && role === 'content'
            ? `New API ${targetMediaType} 不支持该输入角色：${role}（上游媒体类型 ${sourceMediaType} 无法映射为文字）`
            : `New API ${targetMediaType} 不支持该输入角色：${role}`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['image', 'audio', 'video'] as const)(
    'rejects $sourceMediaType content when text mapping requires text input',
    async (sourceMediaType) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      });

      await expect(
        provider.execute({
          snapshot: {
            ...standardSnapshot('text'),
            inputs: [providerInputWithMediaType('node_input', 'content', 0, sourceMediaType)],
          },
        }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_INPUT_ROLE',
        retryable: false,
        message: `New API text 不支持该输入角色：content（上游媒体类型 ${sourceMediaType} 无法映射为文字）`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['text', 'image', 'audio'] as const)(
    'rejects role-shaped parameters for $mediaType before sending a generation request',
    async (mediaType) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      });

      for (const role of allPortRoles) {
        if (role === 'prompt') continue;
        await expect(
          provider.execute({
            snapshot: {
              ...standardSnapshot(mediaType),
              parameters: { [role]: `${role} parameter` },
            },
          }),
        ).rejects.toMatchObject({
          code: 'UNSUPPORTED_INPUT_ROLE',
          retryable: false,
          message: `New API ${mediaType} 不支持该输入角色：${role}`,
        });
      }
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

  it('rejects an image response that explicitly declares an audio MIME type', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ mime_type: 'audio/mpeg', data: [{ b64_json: 'aW1hZ2U=' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(provider.execute({ snapshot: standardSnapshot('image') })).rejects.toMatchObject({
      name: 'NewApiProviderError',
      code: 'PROVIDER_OUTPUT_MIME_MISMATCH',
      message: 'New API 图片响应 MIME 类型与媒体类型不匹配',
    });
  });

  it('rejects an image data URL that explicitly carries an audio MIME type', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: 'data:audio/mpeg;base64,YXVkaW8=' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(provider.execute({ snapshot: standardSnapshot('image') })).rejects.toMatchObject({
      name: 'NewApiProviderError',
      code: 'PROVIDER_OUTPUT_MIME_MISMATCH',
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

  it('rejects a raw audio response with an image MIME type', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(provider.execute({ snapshot: standardSnapshot('audio') })).rejects.toMatchObject({
      name: 'NewApiProviderError',
      code: 'PROVIDER_OUTPUT_MIME_MISMATCH',
      message: 'New API 音频响应 MIME 类型与媒体类型不匹配',
    });
  });

  it('returns an audio URL from a JSON media response without fabricating bytes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/speech.ogg' }] }), {
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
        ...standardSnapshot('audio'),
        parameters: {},
      },
    });

    expect(result.output).toEqual({
      mediaType: 'audio',
      kind: 'url',
      url: 'https://cdn.example/speech.ogg',
      mimeType: 'audio/ogg',
      format: 'ogg',
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

  it('redacts the configured API key from an upstream error and preserves diagnostics', async () => {
    const apiKey = syntheticApiKey('configured-value');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: `upstream echoed API key: ${apiKey}`,
            code: 'rate_limit',
          },
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-redacted-key' },
        },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey,
      fetchImpl,
    });

    const error = await provider
      .execute({ snapshot: textSnapshot() })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NewApiProviderError);
    expect(error).toMatchObject({
      status: 429,
      code: 'rate_limit',
      requestId: 'req-redacted-key',
      retryable: true,
    });
    expect((error as NewApiProviderError).message).toContain('[REDACTED]');
    expect((error as NewApiProviderError).message).not.toContain(apiKey);
  });

  it('redacts Authorization values from an upstream error', async () => {
    const authorizationValue = 'synthetic-authorization-value-123456';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: `Authorization: Bearer ${authorizationValue}`,
            code: 'invalid_auth',
            request_id: 'req-invalid-auth',
          },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'synthetic-provider-key',
      fetchImpl,
    });

    const error = await provider
      .execute({ snapshot: textSnapshot() })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 401,
      code: 'invalid_auth',
      requestId: 'req-invalid-auth',
      retryable: false,
    });
    expect((error as NewApiProviderError).message).toContain('Authorization: [REDACTED]');
    expect((error as NewApiProviderError).message).not.toContain(authorizationValue);
  });

  it('removes URL query parameters and fragments from transport errors', async () => {
    const apiKey = 'synthetic-transport-provider-key';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error(
          `GET https://newapi.example.com/v1/models?api_key=query-secret&tenant=alpha#trace failed with ${apiKey}`,
        ),
      );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey,
      fetchImpl,
    });

    const error = await provider
      .execute({ snapshot: textSnapshot() })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
    expect((error as NewApiProviderError).message).toBe(
      'GET https://newapi.example.com/v1/models failed with [REDACTED]',
    );
    expect((error as NewApiProviderError).message).not.toContain('query-secret');
    expect((error as NewApiProviderError).message).not.toContain('tenant=alpha');
    expect((error as NewApiProviderError).message).not.toContain(apiKey);
  });

  it('bounds an oversized upstream error without losing its structured classification', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: `upstream body: ${'x'.repeat(2_000)}`, code: 'overloaded' },
        }),
        {
          status: 503,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-overloaded' },
        },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'synthetic-provider-key',
      fetchImpl,
    });

    const error = await provider
      .execute({ snapshot: textSnapshot() })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NewApiProviderError);
    expect(error).toMatchObject({
      status: 503,
      code: 'overloaded',
      requestId: 'req-overloaded',
      retryable: true,
    });
    expect((error as NewApiProviderError).message).toHaveLength(512);
    expect((error as NewApiProviderError).message).toMatch(/\.\.\. \[truncated\]$/);
  });

  it('sanitizes structured standard diagnostics from body and response headers', async () => {
    const apiKey = 'synthetic-standard-provider-key-123456';
    const authorizationValue = 'synthetic-standard-authorization-123456';
    const rawCode = `rate_limit Authorization: Bearer ${authorizationValue}; key=${apiKey}; https://newapi.example.com/debug?token=query-secret&tenant=alpha#trace \u0007${'x'.repeat(800)}`;
    const rawRequestId = `req-standard Authorization: Bearer ${authorizationValue}; key=${apiKey}; https://newapi.example.com/trace?token=query-secret&tenant=alpha#trace \u0000${'y'.repeat(800)}`;
    const response = new Response(
      JSON.stringify({ error: { message: 'temporarily overloaded', code: rawCode } }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
    const getHeader = response.headers.get.bind(response.headers);
    vi.spyOn(response.headers, 'get').mockImplementation((name) =>
      name === 'x-request-id' ? rawRequestId : getHeader(name),
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey,
      fetchImpl,
    });

    const caught = await provider
      .execute({ snapshot: textSnapshot() })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(NewApiProviderError);
    const error = caught as NewApiProviderError;
    expect(error).toMatchObject({ status: 429, retryable: true });
    expect(error.code).toContain('rate_limit');
    expect(error.requestId).toContain('req-standard');
    for (const diagnostic of [error.code, error.requestId]) {
      expect(diagnostic).toBeDefined();
      expect(diagnostic).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(diagnostic?.length).toBeLessThanOrEqual(512);
      expect(diagnostic).toMatch(/\.\.\. \[truncated\]$/);
      for (const secret of [apiKey, authorizationValue, 'query-secret', 'tenant=alpha']) {
        expect(diagnostic).not.toContain(secret);
      }
    }
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

  it('uses the common base URL for the standard video endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'prefixed-video',
          status: 'failed',
          error: { message: 'No eligible media account' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });
    const snapshot = videoSnapshot();
    snapshot.inputs = [];

    await expect(provider.execute({ snapshot })).rejects.toMatchObject({
      code: 'VIDEO_GENERATION_FAILED',
      platformJobId: 'prefixed-video',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example.com/v1/videos/generations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends standard video parameters by default', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'minimal-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'done', video: { url: 'https://cdn.example/minimal.mp4' } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
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
    snapshot.inputs = [];

    await provider.execute({ snapshot });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://newapi.example.com/v1/videos/generations',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'grok-imagine-video-1.5',
          prompt: 'Animate the scene',
          duration: 8,
          resolution: '720p',
          aspect_ratio: '16:9',
        }),
      }),
    );
  });

  it('forwards a Unicode video model ID without alias normalization', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'unicode-model-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'done', video: { url: 'https://cdn.example/unicode.mp4' } }),
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
    snapshot.inputs = [];
    snapshot.modelAlias = 'grok-imagine-video-1.5（按次）';

    await provider.execute({ snapshot });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe('grok-imagine-video-1.5（按次）');
  });

  it('normalizes video size, quality, and seconds aliases', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'video-alias' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'done', video: { url: 'https://cdn.example/alias.mp4' } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
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
    snapshot.inputs = [];
    snapshot.parameters = {
      prompt: 'Alias video',
      seconds: '12',
      videoSize: '1920x1080',
      videoQuality: 'high',
    };

    await provider.execute({ snapshot });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://newapi.example.com/v1/videos/generations',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'grok-imagine-video-1.5',
          prompt: 'Alias video',
          duration: 12,
          size: '1920x1080',
          quality: 'high',
        }),
      }),
    );
  });

  it('requires an explicit prompt instead of using the node label', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });
    const snapshot = videoSnapshot();
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new Error('video target fixture is missing');
    target.data = { ...target.data, prompt: undefined };
    snapshot.inputs = [];

    await expect(provider.execute({ snapshot })).rejects.toMatchObject({
      code: 'VIDEO_PROMPT_REQUIRED',
      retryable: false,
      message: 'New API video 需要 prompt',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an inline prompt mention before creating a video task', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const snapshot = videoSnapshot();
    snapshot.nodes[1]!.data.promptDocument = {
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'mention-video-reference',
          assetId: 'asset-video-reference',
          assetVersion: 1,
          label: '参考视频',
          mediaType: 'video',
          mimeType: 'video/mp4',
          contentUrl: 'data:video/mp4;base64,dmlkZW8=',
        },
      ],
    } as unknown as NonNullable<RunSnapshot['nodes'][number]['data']['promptDocument']>;
    snapshot.promptMentions = [
      {
        nodeId: snapshot.targetNodeId,
        mentionId: 'mention-video-reference',
        assetId: 'asset-video-reference',
        assetVersion: 1,
        label: '参考视频',
        mediaType: 'video',
        blockOrder: 0,
      },
    ];

    await expect(
      new NewApiVideoProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
        pollIntervalMs: 0,
      }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_MENTION_PROVIDER_MAPPING_UNSUPPORTED',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it.each(['prompt', 'content'] as const)(
    'maps a linked %s and first frame through the documented video fields',
    async (promptRole) => {
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
        role: promptRole,
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
    },
  );

  it('rejects a non-image first frame before creating a video task', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });
    const snapshot = videoSnapshot();
    snapshot.inputs[0] = providerInputWithMediaType(
      'node_text_first_frame',
      'firstFrame',
      0,
      'text',
    );

    await expect(provider.execute({ snapshot })).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT_ROLE',
      retryable: false,
      message: 'New API video 不支持该输入角色：firstFrame（上游媒体类型 text 无法映射为图片）',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('surfaces an immediately failed creation response without persisting or polling it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'failed-at-create',
          status: 'failed',
          error: { message: 'No eligible media account', code: 'media_account_unavailable' },
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
    });

    await expect(
      provider.execute({ snapshot: videoSnapshot(), onProviderJob }),
    ).rejects.toMatchObject({
      code: 'VIDEO_GENERATION_FAILED',
      platformJobId: 'failed-at-create',
      retryable: false,
      message: 'No eligible media account',
      providerPayload: {
        contract: 'newapi-video-v1',
        phase: 'failed',
        providerStatus: 'failed',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onProviderJob).not.toHaveBeenCalled();
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

  it('rejects role-shaped video parameters before creating or resuming a paid task', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });

    for (const role of allPortRoles) {
      if (role === 'prompt') continue;
      const snapshot = videoSnapshot();
      snapshot.parameters = { ...snapshot.parameters, [role]: `${role} parameter` };

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
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an audio input mapped to video audioTrack before creating a paid task', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });

    const snapshot = videoSnapshot();
    snapshot.inputs.push(providerInputWithMediaType('node_audio_track', 'audioTrack', 1, 'audio'));

    await expect(provider.execute({ snapshot })).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT_ROLE',
      retryable: false,
      message: 'New API video 不支持该输入角色：audioTrack',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

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

  it('resolves a relative authenticated content URL against the New API base path', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'relative-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'done',
            video: { url: '/v1/videos/relative-video/content' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '3' },
        }),
      );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    });
    const snapshot = videoSnapshot();
    snapshot.inputs = [];

    await provider.execute({ snapshot });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://newapi.example.com/v1/videos/relative-video/content',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer server-secret' }),
      }),
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

  it('sanitizes video HTTP errors without changing failure metadata', async () => {
    const apiKey = syntheticApiKey('video-value');
    const authorizationValue = 'synthetic-video-authorization-123456';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: `Authorization: Bearer ${authorizationValue}; key=${apiKey}; see https://newapi.example.com/debug?token=query-secret`,
            code: 'video_auth_failed',
            request_id: 'req-video-auth',
          },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey,
      fetchImpl,
      pollIntervalMs: 0,
    });

    const error = await provider
      .execute({ snapshot: videoSnapshot() })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NewApiProviderError);
    expect(error).toMatchObject({
      status: 401,
      code: 'video_auth_failed',
      requestId: 'req-video-auth',
      retryable: false,
    });
    expect((error as NewApiProviderError).message).not.toContain(apiKey);
    expect((error as NewApiProviderError).message).not.toContain(authorizationValue);
    expect((error as NewApiProviderError).message).not.toContain('query-secret');
    expect((error as NewApiProviderError).message).toContain('https://newapi.example.com/debug');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sanitizes structured video error diagnostics without changing retry behavior', async () => {
    const apiKey = 'synthetic-video-provider-key-123456';
    const authorizationValue = 'synthetic-video-authorization-123456';
    const rawCode = `video_auth_failed Authorization: Bearer ${authorizationValue}; key=${apiKey}; https://newapi.example.com/debug?token=query-secret&tenant=alpha#trace \u0007${'x'.repeat(800)}`;
    const rawRequestId = `req-video Authorization: Bearer ${authorizationValue}; key=${apiKey}; https://newapi.example.com/trace?token=query-secret&tenant=alpha#trace \u0000${'y'.repeat(800)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'video authentication failed',
            code: rawCode,
            request_id: rawRequestId,
          },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey,
      fetchImpl,
      pollIntervalMs: 0,
    });

    const caught = await provider
      .execute({ snapshot: videoSnapshot() })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(NewApiProviderError);
    const error = caught as NewApiProviderError;
    expect(error).toMatchObject({ status: 401, retryable: false });
    expect(error.code).toContain('video_auth_failed');
    expect(error.requestId).toContain('req-video');
    for (const diagnostic of [error.code, error.requestId]) {
      expect(diagnostic).toBeDefined();
      expect(diagnostic).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(diagnostic?.length).toBeLessThanOrEqual(512);
      expect(diagnostic).toMatch(/\.\.\. \[truncated\]$/);
      for (const secret of [apiKey, authorizationValue, 'query-secret', 'tenant=alpha']) {
        expect(diagnostic).not.toContain(secret);
      }
    }
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

  it('does not expose a raw response-body read error after video submission', async () => {
    const apiKey = syntheticApiKey('video-read-value');
    const response = new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(
      new Error(`response stream failed with ${apiKey}`),
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey,
      fetchImpl,
      pollIntervalMs: 0,
    });

    const error = await provider
      .execute({ snapshot: videoSnapshot() })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NewApiProviderError);
    expect(error).toMatchObject({ code: 'VIDEO_SUBMISSION_UNKNOWN', retryable: false });
    expect((error as NewApiProviderError).message).toBe(
      'New API 视频创建结果未知，请先核对平台任务状态',
    );
    expect((error as NewApiProviderError).message).not.toContain(apiKey);
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

  it('bounds and sanitizes structured provider payloads on errors', () => {
    const error = new NewApiProviderError('provider failed', {
      providerPayload: {
        phase: 'failed',
        authorization: 'Bearer provider-secret',
        outputUrl: 'https://cdn.example.com/output.mp4?signature=secret',
        nested: { token: 'nested-secret', safe: 'kept' },
        long: 'x'.repeat(2_000),
      },
    });

    expect(error.providerPayload).toMatchObject({
      phase: 'failed',
      nested: { safe: 'kept' },
    });
    expect(error.providerPayload).not.toHaveProperty('authorization');
    expect(error.providerPayload).not.toHaveProperty('outputUrl');
    expect(JSON.stringify(error.providerPayload)).not.toContain('provider-secret');
    expect(JSON.stringify(error.providerPayload)).not.toContain('signature=secret');
    expect(error.providerPayload?.long).toHaveLength(512);
  });
});
