import { describe, expect, it, vi } from 'vitest';
import {
  REQUEST_PROMPT_SCHEMA_VERSION,
  type MediaType,
  type PortRole,
  type RequestPromptRecord,
  type RunInputSnapshot,
  type RunSnapshot,
} from '@multimodal-canvas/domain';

import {
  MockProvider,
  NewApiProvider,
  NewApiProviderError,
  NewApiVideoProvider,
  newApiExecutionHeaders,
  normalizeNewApiBaseUrl,
  describeVideoInputMedia,
  resolveProviderMentions,
  type ResolvedMention,
} from './index';

const allPortRoles = [
  'prompt',
  'negativePrompt',
  'content',
  'style',
  'character',
  'referenceImage',
  'firstFrame',
  'lastFrame',
  'audioTrack',
  'transcript',
  'mask',
] as const satisfies readonly PortRole[];

describe('New API 执行受理头', () => {
  it('以 ASCII 单头传递完整权限，中文分组与 auto 范围可精确还原', () => {
    const headers = newApiExecutionHeaders({
      issuer: 'https://newapi.example',
      externalUserId: 'user-1',
      instanceId: 'canvas-1',
      grantId: 'grant-1',
      tokenId: 'token-1',
      credentialRevision: 'credential-1',
      group: 'auto',
      permissionRevision: 'permission-1',
      autoGroups: ['default', '视频分组'],
    });
    const encoded = new Headers(headers).get('x-canvas-execution')!;
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual({
      version: 1,
      issuer: 'https://newapi.example',
      user_id: 'user-1',
      instance_id: 'canvas-1',
      grant_id: 'grant-1',
      token_id: 'token-1',
      expected_group: 'auto',
      permission_revision: 'permission-1',
      auto_groups: ['default', '视频分组'],
    });
    expect(newApiExecutionHeaders()).toEqual({});
  });
});

type StandardMediaType = Exclude<MediaType, 'video'>;

const standardSupportedInputRoles = {
  text: ['prompt', 'content', 'transcript'],
  // 文本节点可通过提示词或内容语义端口连接；两者都映射到接口的主文字字段。
  image: ['prompt', 'content', 'referenceImage'],
  audio: ['prompt', 'content'],
} as const satisfies Record<StandardMediaType, readonly PortRole[]>;

const unsupportedStandardRoleCases = (['text', 'image', 'audio'] as const).flatMap((mediaType) =>
  allPortRoles
    .filter(
      (role) => !(standardSupportedInputRoles[mediaType] as readonly PortRole[]).includes(role),
    )
    .map((role) => ({ mediaType, role })),
);

const grok15MappedVideoRoles = [
  'prompt',
  'content',
  'firstFrame',
  'lastFrame',
  'character',
  'style',
  'referenceImage',
] as const;
const unsupportedVideoInputRoles = allPortRoles.filter(
  (role) => !(grok15MappedVideoRoles as readonly PortRole[]).includes(role),
);

const inputMediaTypeByRole: Record<PortRole, MediaType> = {
  prompt: 'text',
  negativePrompt: 'text',
  content: 'text',
  style: 'image',
  character: 'image',
  referenceImage: 'image',
  firstFrame: 'image',
  lastFrame: 'image',
  audioTrack: 'audio',
  transcript: 'text',
  mask: 'image',
  imageEdit: 'image',
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
    parameters: mediaType === 'audio' ? { voice: 'alloy' } : {},
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
    { targetMediaType: 'image' as const, mentionMediaType: 'text' as const },
    { targetMediaType: 'image' as const, mentionMediaType: 'audio' as const },
    { targetMediaType: 'image' as const, mentionMediaType: 'video' as const },
    { targetMediaType: 'audio' as const, mentionMediaType: 'audio' as const },
  ])(
    'rejects a $mentionMediaType mention on the $targetMediaType generation endpoint before POST',
    async ({ targetMediaType, mentionMediaType }) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const snapshot = standardSnapshot(targetMediaType);
      const mimeType = mentionMediaType === 'text' ? 'text/plain' : `${mentionMediaType}/wav`;
      const dataUrl = `data:${mimeType};base64,YXVkaW8=`;
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
            mimeType,
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
        message: expect.stringContaining(`当前项目尚未接通 New API ${targetMediaType}`),
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

  it('maps an image content input to the official image edits endpoint', async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/edited.png' }] }), {
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
        imageEditCapability: { declared: true },
        parameters: { size: '1024x1024', prompt: '改成夜景' },
        inputs: [
          {
            nodeId: 'node_source',
            role: 'content',
            sortOrder: 0,
            snapshot: {
              id: 'node_source',
              type: 'image',
              position: { x: 0, y: 0 },
              data: {
                label: 'source',
                mediaType: 'image',
                mode: 'source',
                contentUrl: `data:image/png;base64,${png}`,
                mimeType: 'image/png',
              },
            },
          },
        ],
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://newapi.example.com/v1/images/edits');
    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer server-secret',
        }),
      }),
    );
    expect((init?.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('image-v1');
    expect(form.get('prompt')).toBe('改成夜景');
    expect(form.get('n')).toBe('1');
    expect(form.get('size')).toBe('1024x1024');
    const image = form.get('image');
    expect(image).toBeInstanceOf(File);
    expect((image as File).name).toBe('node_source.png');
    expect((image as File).type).toBe('image/png');
  });

  it('rejects an image content input that is not a hydrated data URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(
      provider.execute({
        snapshot: {
          ...standardSnapshot('image'),
          imageEditCapability: { declared: true },
          inputs: [providerInputWithMediaType('node_input', 'content', 0, 'image')],
        },
      }),
    ).rejects.toMatchObject({
      code: 'INPUT_ROLE_VALUE_MISSING',
      retryable: false,
      message: 'New API image 输入角色 content 缺少可发送的图片内容',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const editPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  /** 构造一条带原图的图片编辑运行输入。 */
  function editImageInput(id: string, role: PortRole = 'imageEdit', mimeType = 'image/png') {
    const input = providerInputWithMediaType(id, role, 0, 'image');
    return {
      ...input,
      snapshot: {
        ...input.snapshot,
        data: {
          ...input.snapshot.data,
          contentUrl: `data:${mimeType};base64,${editPng}`,
          mimeType,
        },
      },
    };
  }

  /** 构造已水合的图片提及快照；每条提及保留独立 ID 和冻结资产版本。 */
  function imageMentionSnapshot(
    sources: { assetId: string; assetVersion: number }[] = [
      { assetId: 'asset-photo', assetVersion: 3 },
    ],
  ): RunSnapshot {
    const snapshot = standardSnapshot('image');
    const mentions = sources.map((source, index) => ({
      ...source,
      nodeId: snapshot.targetNodeId,
      mentionId: `mention-photo-${index}`,
      mediaType: 'image' as const,
      label: `Photo ${index + 1}`,
      blockOrder: 1 + index * 2,
    }));
    snapshot.promptMentions = mentions;
    snapshot.nodes[0].data.promptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: 'Restyle ' },
        ...mentions.flatMap((mention) => [
          {
            type: 'mention',
            ...mention,
            mimeType: 'image/png',
            contentUrl: `data:image/png;base64,${editPng}`,
          },
          { type: 'text', text: ' with warm light. ' },
        ]),
      ],
    } as unknown as NonNullable<RunSnapshot['nodes'][number]['data']['promptDocument']>;
    return snapshot;
  }

  it('uploads an undeclared image mention as exact edits bytes and records frozen identity', async () => {
    const snapshot = imageMentionSnapshot();
    snapshot.modelAlias = 'gpt-image-2.5-sunburst';
    snapshot.parameters = { quality: 'high' };
    const records: RequestPromptRecord[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/edited.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      resolvedMentions: resolveProviderMentions(snapshot),
      runId: 'run-mentioned-image',
      onRequestPrompt: (record) => {
        records.push(record);
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://newapi.example.com/v1/images/edits');
    const body = init!.body as FormData;
    expect(body.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(body.get('prompt')).toBe('Restyle Photo 1 with warm light. ');
    expect(body.get('quality')).toBe('high');
    expect(body.getAll('image')).toHaveLength(1);
    const image = body.get('image') as File;
    expect(image.type).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(
      Uint8Array.from(atob(editPng), (character) => character.charCodeAt(0)),
    );
    expect(records[0]).toMatchObject({
      requestIdentity: 'POST /images/edits#1',
      parts: [{ order: 0, text: 'Restyle Photo 1 with warm light. ' }],
      resources: [
        {
          assetId: 'asset-photo',
          assetVersion: 3,
          role: 'imageEdit',
          sortOrder: 0,
          mediaType: 'image',
        },
      ],
    });
    expect(JSON.stringify(records)).not.toMatch(/base64|data:image|server-secret/);
  });

  it.each([
    { model: 'gpt-image-1.5', count: 2 },
    { model: 'gpt-image-2.5-sunburst', count: 16 },
    { model: 'custom-image', count: 3, maxImages: 3 },
  ])(
    'uploads $count reference images in one edits request for $model',
    async ({ model, count, maxImages }) => {
      const snapshot = imageMentionSnapshot(
        Array.from({ length: count }, (_, index) => ({
          assetId: `asset-${index}`,
          assetVersion: index + 1,
        })),
      );
      snapshot.modelAlias = model;
      if (maxImages) snapshot.imageEditCapability = { declared: true, maxImages };
      const records: RequestPromptRecord[] = [];
      const resolved = resolveProviderMentions(snapshot);
      resolved.forEach((mention, index) => {
        mention.source = {
          kind: 'data-url',
          mimeType: mention.source.mimeType,
          dataUrl: `data:image/png;base64,${btoa(`reference-${index}`)}`,
        };
      });
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/edited.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({
        snapshot,
        resolvedMentions: resolved,
        runId: 'run-multiple-images',
        onRequestPrompt: (record) => {
          records.push(record);
        },
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe('https://newapi.example.com/v1/images/edits');
      const form = init!.body as FormData;
      expect(form.get('model')).toBe(model);
      expect(form.get('n')).toBe('1');
      expect(form.has('image')).toBe(false);
      const files = form.getAll('image[]') as File[];
      expect(files).toHaveLength(count);
      expect(await Promise.all(files.map((file) => file.text()))).toEqual(
        Array.from({ length: count }, (_, index) => `reference-${index}`),
      );
      expect(records[0]!.resources).toEqual(
        Array.from({ length: count }, (_, index) => ({
          assetId: `asset-${index}`,
          assetVersion: index + 1,
          role: 'imageEdit',
          sortOrder: index,
          mediaType: 'image',
        })),
      );
      expect(JSON.stringify(records)).not.toMatch(/base64|data:image|server-secret|reference-0/);
    },
  );

  it('deduplicates frozen linked versions before appending distinct mention versions in order', async () => {
    const snapshot = imageMentionSnapshot([
      { assetId: 'asset-photo', assetVersion: 3 },
      { assetId: 'asset-photo', assetVersion: 4 },
    ]);
    snapshot.modelAlias = 'gpt-image-1';
    snapshot.imageEditCapability = { declared: true, maxImages: 3 };
    snapshot.inputs = [
      {
        ...editImageInput('second'),
        sourceAssetId: 'asset-photo',
        sourceAssetVersion: 3,
        sortOrder: 2,
      },
      {
        ...editImageInput('first'),
        sourceAssetId: 'asset-other',
        sourceAssetVersion: 1,
        sortOrder: 1,
      },
    ];
    const records: RequestPromptRecord[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/edited.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      resolvedMentions: resolveProviderMentions(snapshot),
      runId: 'run-ordered-images',
      onRequestPrompt: (record) => {
        records.push(record);
      },
    });
    const form = fetchImpl.mock.calls[0]![1]!.body as FormData;
    expect(form.getAll('image[]')).toHaveLength(3);
    expect((form.getAll('image[]') as File[]).slice(0, 2).map((file) => file.name)).toEqual([
      'first.png',
      'second.png',
    ]);
    expect(
      records[0]!.resources.map(({ assetId, assetVersion }) => ({ assetId, assetVersion })),
    ).toEqual([
      { assetId: 'asset-other', assetVersion: 1 },
      { assetId: 'asset-photo', assetVersion: 3 },
      { assetId: 'asset-photo', assetVersion: 4 },
    ]);
  });

  it.each([
    { model: 'gpt-image-1.5', count: 17, maxImages: undefined, limit: 16 },
    { model: 'gpt-image-1.5', count: 2, maxImages: 1, limit: 1 },
    { model: 'custom-image', count: 4, maxImages: 3, limit: 3 },
  ])(
    'rejects $count images above the limit $limit before POST',
    async ({ model, count, maxImages, limit }) => {
      const snapshot = imageMentionSnapshot(
        Array.from({ length: count }, (_, index) => ({
          assetId: `asset-${index}`,
          assetVersion: 1,
        })),
      );
      snapshot.modelAlias = model;
      if (maxImages) snapshot.imageEditCapability = { declared: true, maxImages };
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        new NewApiProvider({
          baseUrl: 'https://newapi.example.com/v1',
          apiKey: 'server-secret',
          fetchImpl,
        }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) }),
      ).rejects.toMatchObject({
        code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
        retryable: false,
        message: expect.stringContaining(`最多支持 ${limit} 张`),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['invalid-bytes', 'unsupported-mime'])(
    'validates every reference image before POST: %s',
    async (failure) => {
      const snapshot = standardSnapshot('image');
      snapshot.modelAlias = 'gpt-image-1.5';
      snapshot.imageEditCapability = { declared: true, mimeTypes: ['image/png'] };
      snapshot.inputs = [editImageInput('first'), editImageInput('second')];
      if (failure === 'invalid-bytes') {
        snapshot.inputs[1]!.snapshot.data.contentUrl = 'data:image/png;base64,%%%';
      } else {
        snapshot.inputs[1] = editImageInput('second', 'referenceImage', 'image/jpeg');
      }
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        new NewApiProvider({
          baseUrl: 'https://newapi.example.com/v1',
          apiKey: 'server-secret',
          fetchImpl,
        }).execute({ snapshot }),
      ).rejects.toMatchObject({
        code:
          failure === 'invalid-bytes'
            ? 'PROVIDER_OUTPUT_BASE64_INVALID'
            : 'INPUT_ROLE_VALUE_MISSING',
        retryable: false,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rejects conflicting frozen edit-source and linked versions before POST', async () => {
    const snapshot = standardSnapshot('image');
    snapshot.nodes[0]!.data.imageEditSource = {
      sourceNodeId: 'source',
      assetId: 'asset-photo',
      version: 3,
    };
    snapshot.inputs = [
      { ...editImageInput('source'), sourceAssetId: 'asset-photo', sourceAssetVersion: 4 },
    ];
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot }),
    ).rejects.toMatchObject({ code: 'INPUT_ROLE_VALUE_MISSING', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uploads one image for repeated mentions and a linked source of the same frozen version', async () => {
    const snapshot = imageMentionSnapshot([
      { assetId: 'asset-photo', assetVersion: 3 },
      { assetId: 'asset-photo', assetVersion: 3 },
    ]);
    snapshot.nodes[0].data.imageEditSource = {
      sourceNodeId: 'source',
      assetId: 'asset-photo',
      version: 3,
    };
    snapshot.inputs = [{ ...editImageInput('source'), sourceAssetId: 'asset-photo' }];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/edited.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      resolvedMentions: resolveProviderMentions(snapshot),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = fetchImpl.mock.calls[0]![1]!.body as FormData;
    expect(body.getAll('image')).toHaveLength(1);
    expect(body.get('prompt')).toBe('Restyle Photo 1 with warm light. Photo 2 with warm light. ');
  });

  it.each([
    [
      { assetId: 'asset-photo', assetVersion: 3 },
      { assetId: 'asset-other', assetVersion: 3 },
    ],
    [
      { assetId: 'asset-photo', assetVersion: 3 },
      { assetId: 'asset-photo', assetVersion: 4 },
    ],
  ])('rejects multiple distinct images or versions before POST (%j, %j)', async (first, second) => {
    const snapshot = imageMentionSnapshot([first, second]);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({
        snapshot,
        resolvedMentions: resolveProviderMentions(snapshot),
      }),
    ).rejects.toMatchObject({ code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not merge a second linked source with the edit source solely by asset and bytes', async () => {
    const snapshot = standardSnapshot('image');
    snapshot.nodes[0]!.data.imageEditSource = {
      sourceNodeId: 'source-v3',
      assetId: 'asset-photo',
      version: 3,
    };
    snapshot.inputs = [
      { ...editImageInput('source-v3'), sourceAssetId: 'asset-photo' },
      { ...editImageInput('source-unknown-version', 'content'), sourceAssetId: 'asset-photo' },
    ];
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot }),
    ).rejects.toMatchObject({ code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not use a resource pool version to merge a linked image with a frozen mention', async () => {
    const snapshot = imageMentionSnapshot();
    snapshot.nodes[0]!.data.resourceRefs = [
      {
        id: 'ref-photo',
        assetId: 'asset-photo',
        assetVersion: 3,
        name: 'Photo',
        mediaType: 'image',
      },
    ];
    snapshot.inputs = [
      { ...editImageInput('source-unknown-version', 'content'), sourceAssetId: 'asset-photo' },
    ];
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) }),
    ).rejects.toMatchObject({ code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not record a resource pool version as the linked image version', async () => {
    const snapshot = standardSnapshot('image');
    snapshot.nodes[0]!.data.resourceRefs = [
      {
        id: 'ref-photo',
        assetId: 'asset-photo',
        assetVersion: 3,
        name: 'Photo',
        mediaType: 'image',
      },
    ];
    snapshot.inputs = [
      { ...editImageInput('source-unknown-version', 'content'), sourceAssetId: 'asset-photo' },
    ];
    const records: RequestPromptRecord[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/edited.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      runId: 'run-unknown-source-version',
      onRequestPrompt: (record) => {
        records.push(record);
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(records[0]!.resources).toEqual([
      { assetId: 'asset-photo', role: 'content', sortOrder: 0, mediaType: 'image' },
    ]);
  });

  it.each<{
    name: string;
    mutate: (snapshot: RunSnapshot, resolved: ResolvedMention[]) => void;
    code: string;
  }>([
    {
      name: 'missing hydration',
      mutate: (_snapshot, resolved) => {
        resolved.length = 0;
      },
      code: 'RESOURCE_MENTION_RESOLUTION_MISSING',
    },
    {
      name: 'missing frozen identity',
      mutate: (snapshot) => {
        snapshot.promptMentions = [];
      },
      code: 'RESOURCE_MENTION_RESOLUTION_MISSING',
    },
    {
      name: 'wrong resolved version',
      mutate: (_snapshot, resolved) => {
        resolved[0]!.assetVersion = 4;
      },
      code: 'RESOURCE_MENTION_RESOLUTION_INVALID',
    },
    {
      name: 'wrong frozen version',
      mutate: (snapshot) => {
        snapshot.promptMentions![0]!.assetVersion = 4;
      },
      code: 'RESOURCE_MENTION_RESOLUTION_INVALID',
    },
    {
      name: 'wrong asset',
      mutate: (_snapshot, resolved) => {
        resolved[0]!.assetId = 'asset-other';
      },
      code: 'RESOURCE_MENTION_RESOLUTION_INVALID',
    },
    {
      name: 'wrong node',
      mutate: (_snapshot, resolved) => {
        resolved[0]!.nodeId = 'node-other';
      },
      code: 'RESOURCE_MENTION_RESOLUTION_MISSING',
    },
    {
      name: 'wrong media type',
      mutate: (_snapshot, resolved) => {
        resolved[0]!.mediaType = 'video';
      },
      code: 'RESOURCE_MENTION_RESOLUTION_INVALID',
    },
    {
      name: 'duplicate hydration',
      mutate: (_snapshot, resolved) => {
        resolved.push({ ...resolved[0]! });
      },
      code: 'RESOURCE_MENTION_RESOLUTION_INVALID',
    },
    {
      name: 'duplicate frozen identity',
      mutate: (snapshot) => {
        snapshot.promptMentions!.push({ ...snapshot.promptMentions![0]! });
      },
      code: 'RESOURCE_MENTION_RESOLUTION_INVALID',
    },
    {
      name: 'orphaned frozen mention',
      mutate: (snapshot) => {
        snapshot.nodes[0]!.data.promptDocument = {
          version: 1,
          blocks: [{ type: 'text', text: 'No image' }],
        };
      },
      code: 'RESOURCE_MENTION_RESOLUTION_INVALID',
    },
    {
      name: 'orphaned hydration',
      mutate: (_snapshot, resolved) => {
        resolved.push({ ...resolved[0]!, mentionId: 'orphan' });
      },
      code: 'RESOURCE_MENTION_RESOLUTION_INVALID',
    },
    {
      name: 'MIME mismatch',
      mutate: (_snapshot, resolved) => {
        resolved[0]!.source.mimeType = 'image/jpeg';
      },
      code: 'RESOURCE_MENTION_PROVIDER_MAPPING_INVALID',
    },
    {
      name: 'remote URL instead of hydrated bytes',
      mutate: (_snapshot, resolved) => {
        resolved[0]!.source = {
          kind: 'data-url',
          mimeType: 'image/png',
          dataUrl: 'https://assets.example/photo.png',
        };
      },
      code: 'RESOURCE_MENTION_PROVIDER_MAPPING_INVALID',
    },
  ])('rejects $name for image mentions before any request', async ({ mutate, code }) => {
    const snapshot = imageMentionSnapshot();
    const resolved = resolveProviderMentions(snapshot);
    mutate(snapshot, resolved);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot, resolvedMentions: resolved }),
    ).rejects.toMatchObject({ code, retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects conflicting content for repeated mentions of one frozen asset version', async () => {
    const snapshot = imageMentionSnapshot([
      { assetId: 'asset-photo', assetVersion: 3 },
      { assetId: 'asset-photo', assetVersion: 3 },
    ]);
    const resolved = resolveProviderMentions(snapshot);
    resolved[1]!.source = {
      kind: 'data-url',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,b3RoZXI=',
    };
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot, resolvedMentions: resolved }),
    ).rejects.toMatchObject({ code: 'INPUT_ROLE_VALUE_MISSING', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves edits rejection without retrying or falling back to generations', async () => {
    const snapshot = imageMentionSnapshot();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: 'edits unavailable for this model', code: 'unsupported_model' },
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-edit-rejected' },
        },
      ),
    );
    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'unsupported_model',
      requestId: 'req-edit-rejected',
      retryable: false,
      message: expect.stringContaining('edits unavailable for this model'),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://newapi.example.com/v1/images/edits');
  });

  it('sends linked image edits when the catalog omits image edit capability', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/edited.png' }] }), {
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
        parameters: { prompt: '改成夜景' },
        inputs: [editImageInput('node_source')],
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example.com/v1/images/edits');
    expect((fetchImpl.mock.calls[0]?.[1]?.body as FormData).get('image')).toBeInstanceOf(File);
  });

  it('refuses to fall back to text-to-image when the edit source input is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(
      provider.execute({
        snapshot: {
          ...standardSnapshot('image'),
          nodes: [
            {
              id: 'node_image',
              type: 'image',
              position: { x: 0, y: 0 },
              data: {
                label: '修改图',
                mediaType: 'image',
                mode: 'generate',
                imageEditSource: { sourceNodeId: 'node_source', assetId: 'asset_1' },
              },
            },
          ],
          parameters: { prompt: '改成夜景' },
          inputs: [],
        },
      }),
    ).rejects.toMatchObject({
      code: 'IMAGE_EDIT_SOURCE_INPUT_MISSING',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards every declared edit parameter and rejects undeclared ones', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/edited.png' }] }), {
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
        imageEditCapability: {
          declared: true,
          mimeTypes: ['image/png'],
          parameters: ['size', 'quality'],
        },
        parameters: { prompt: '改成夜景', size: '1024x1024', quality: 'high' },
        inputs: [editImageInput('node_source')],
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const form = fetchImpl.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get('size')).toBe('1024x1024');
    expect(form.get('quality')).toBe('high');
    expect(form.get('image')).toBeInstanceOf(File);

    fetchImpl.mockClear();
    await expect(
      provider.execute({
        snapshot: {
          ...standardSnapshot('image'),
          imageEditCapability: {
            declared: true,
            mimeTypes: ['image/png'],
            parameters: ['size'],
          },
          parameters: { prompt: '改成夜景', quality: 'high' },
          inputs: [editImageInput('node_source')],
        },
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_EDIT_PARAMETER_UNSUPPORTED', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an edit source whose MIME type is outside the declared capability', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(
      provider.execute({
        snapshot: {
          ...standardSnapshot('image'),
          imageEditCapability: { declared: true, mimeTypes: ['image/webp'] },
          parameters: { prompt: '改成夜景' },
          inputs: [editImageInput('node_source')],
        },
      }),
    ).rejects.toMatchObject({ code: 'INPUT_ROLE_VALUE_MISSING', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
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
        parameters: { response_format: 'mp3', voice: 'alloy' },
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
          voice: 'alloy',
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
            ...(mediaType === 'audio' ? { voice: 'alloy' } : {}),
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
            ? `New API ${targetMediaType} 不支持该输入角色：${role}（上游媒体类型 ${sourceMediaType} 无法映射为文字或图片） 图生图请把图片连到「内容」或「通用参考」口；提示词请连到「提示词」口或在节点中填写。`
            : `New API ${targetMediaType} 不支持该输入角色：${role}`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['audio', 'video'] as const)(
    'rejects an unimplemented $sourceMediaType linked content mapping before a text request',
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
        message: `当前项目 New API 文字适配器尚未接通 ${sourceMediaType} 到 content 的连线输入映射`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('sends linked images and text in sorted named messages without dropping image bytes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const snapshot = textSnapshot();
    const firstImage: RunInputSnapshot = editImageInput('first-image', 'content');
    firstImage.sourceAssetId = 'asset-first';
    firstImage.sourceAssetVersion = 4;
    firstImage.snapshot.data.prompt = 'Source generation prompt must not replace image bytes.';
    const secondImage = editImageInput('second-image', 'content');
    secondImage.sourceAssetId = 'asset-second';
    secondImage.sortOrder = 2;
    snapshot.inputs = [
      secondImage,
      textInput('text-input', 'prompt', 1, 'Compare the images.'),
      firstImage,
    ];
    const records: RequestPromptRecord[] = [];

    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      runId: 'run-linked-images',
      onRequestPrompt: collectRequestPrompts(records),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example.com/v1/chat/completions');
    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(payload.messages).toEqual([
      {
        role: 'user',
        name: 'canvas_content',
        content: [{ type: 'image_url', image_url: { url: firstImage.snapshot.data.contentUrl } }],
      },
      { role: 'user', name: 'canvas_prompt', content: 'Compare the images.' },
      {
        role: 'user',
        name: 'canvas_content',
        content: [{ type: 'image_url', image_url: { url: secondImage.snapshot.data.contentUrl } }],
      },
    ]);
    expect(records[0]?.parts).toEqual([
      { order: 0, role: 'user', name: 'canvas_content', text: '' },
      { order: 1, role: 'user', name: 'canvas_prompt', text: 'Compare the images.' },
      { order: 2, role: 'user', name: 'canvas_content', text: '' },
    ]);
    expect(records[0]?.resources).toEqual([
      {
        assetId: 'asset-first',
        assetVersion: 4,
        role: 'content',
        sortOrder: 0,
        mediaType: 'image',
      },
      { assetId: 'asset-second', role: 'content', sortOrder: 1, mediaType: 'image' },
    ]);
    expect(JSON.stringify(records)).not.toMatch(/data:image|base64|iVBOR/);
  });

  it('records prompt media and linked images separately after a text mention', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const snapshot = textSnapshot();
    const linkedImage = editImageInput('linked-image', 'content');
    linkedImage.sourceAssetId = 'asset-linked';
    snapshot.inputs = [linkedImage];
    snapshot.nodes[0].data.promptDocument = {
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'text-mention',
          assetId: 'asset-text',
          label: 'Text',
          mediaType: 'text',
        },
        {
          type: 'mention',
          mentionId: 'image-mention',
          assetId: 'asset-mentioned',
          label: 'Image',
          mediaType: 'image',
        },
      ],
    };
    snapshot.promptMentions = [
      {
        nodeId: snapshot.targetNodeId,
        mentionId: 'text-mention',
        assetId: 'asset-text',
        assetVersion: 2,
        label: 'Text',
        mediaType: 'text',
        blockOrder: 0,
      },
      {
        nodeId: snapshot.targetNodeId,
        mentionId: 'image-mention',
        assetId: 'asset-mentioned',
        assetVersion: 3,
        label: 'Image',
        mediaType: 'image',
        blockOrder: 1,
      },
    ];
    const resolvedMentions: ResolvedMention[] = snapshot.promptMentions.map((mention) => ({
      ...mention,
      nodeId: snapshot.targetNodeId,
      source:
        mention.mediaType === 'text'
          ? {
              kind: 'data-url',
              dataUrl: 'data:text/plain;base64,Q29tcGFyZS4=',
              mimeType: 'text/plain',
            }
          : {
              kind: 'data-url',
              dataUrl: linkedImage.snapshot.data.contentUrl,
              mimeType: 'image/png',
            },
    }));
    const records: RequestPromptRecord[] = [];

    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      resolvedMentions,
      runId: 'run-mentioned-linked',
      onRequestPrompt: collectRequestPrompts(records),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(records[0]?.parts).toEqual([
      { order: 0, role: 'user', text: 'Compare.' },
      { order: 1, role: 'user', name: 'canvas_content', text: '' },
    ]);
    expect(records[0]?.resources).toEqual([
      {
        assetId: 'asset-mentioned',
        assetVersion: 3,
        role: 'referenceImage',
        sortOrder: 0,
        mediaType: 'image',
      },
      { assetId: 'asset-linked', role: 'content', sortOrder: 1, mediaType: 'image' },
    ]);
    expect(JSON.stringify(records)).not.toMatch(/data:image|base64|iVBOR/);
  });

  it.each([
    { name: 'remote URL', contentUrl: 'https://assets.example/image.png', mimeType: 'image/png' },
    {
      name: 'unhydrated asset URL',
      contentUrl: '/api/assets/asset-image/content',
      mimeType: 'image/png',
    },
    { name: 'invalid base64', contentUrl: 'data:image/png;base64,%%%', mimeType: 'image/png' },
    { name: 'empty base64', contentUrl: 'data:image/png;base64,', mimeType: 'image/png' },
    { name: 'missing MIME', contentUrl: 'data:image/png;base64,aW1hZ2U=', mimeType: undefined },
    {
      name: 'mismatching MIME',
      contentUrl: 'data:image/png;base64,aW1hZ2U=',
      mimeType: 'image/jpeg',
    },
    {
      name: 'wrong media MIME',
      contentUrl: 'data:text/plain;base64,aW1hZ2U=',
      mimeType: 'text/plain',
    },
  ])(
    'rejects linked image $name before any request or prompt recording',
    async ({ contentUrl, mimeType }) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const onRequestPrompt = vi.fn();
      const input = editImageInput('invalid-image', 'content');
      const snapshot = textSnapshot();
      snapshot.inputs = [
        {
          ...input,
          snapshot: { ...input.snapshot, data: { ...input.snapshot.data, contentUrl, mimeType } },
        },
      ];

      await expect(
        new NewApiProvider({
          baseUrl: 'https://newapi.example.com/v1',
          apiKey: 'server-secret',
          fetchImpl,
        }).execute({ snapshot, runId: 'run-invalid-image', onRequestPrompt }),
      ).rejects.toMatchObject({
        code: 'INPUT_MEDIA_INVALID',
        retryable: false,
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(onRequestPrompt).not.toHaveBeenCalled();
    },
  );

  it('does not resend or strip a linked image after a provider rejection', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: 'Image input rejected', code: 'unsupported_image' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    const snapshot = textSnapshot();
    const input = editImageInput('rejected-image', 'content');
    snapshot.inputs = [input];

    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot }),
    ).rejects.toMatchObject({ status: 400, retryable: false });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).messages[0]?.content).toEqual([
      { type: 'image_url', image_url: { url: input.snapshot.data.contentUrl } },
    ]);
  });

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

  it.each(['b64_json', 'b64Json', 'base64', 'data'])(
    'prefers inline image bytes in %s over HTTP and HTTPS URLs without changing the request',
    async (field) => {
      for (const protocol of ['http', 'https']) {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            JSON.stringify({
              data: [{ url: protocol + '://cdn.example/image.jpg', [field]: editPng }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
        const provider = new NewApiProvider({
          baseUrl: 'https://newapi.example.com/v1',
          apiKey: 'server-secret',
          fetchImpl,
        });

        const result = await provider.execute({ snapshot: standardSnapshot('image') });

        expect(result.output).toEqual({
          mediaType: 'image',
          kind: 'base64',
          base64: editPng,
          mimeType: 'image/png',
          format: undefined,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0]?.[0]).toBe(
          'https://newapi.example.com/v1/images/generations',
        );
        expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
          'response_format',
        );
      }
    },
  );

  it.each([
    { image_url: { url: 'http://cdn.example/image.jpg' } },
    { imageUrl: 'https://cdn.example/image.jpg' },
    { data: 'http://cdn.example/image.jpg' },
  ])('prefers an inline data URL over remote image URL aliases %#', async (remote) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ ...remote, b64_json: 'data:image/png;base64,' + editPng }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    });

    const result = await provider.execute({ snapshot: standardSnapshot('image') });

    expect(result.output).toEqual({
      mediaType: 'image',
      kind: 'base64',
      base64: editPng,
      mimeType: 'image/png',
      format: 'png',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['http', 'https'])(
    'preserves %s URL-only image responses including existing URL aliases',
    async (protocol) => {
      const url = protocol + '://cdn.example/image.webp';
      for (const item of [{ url }, { image_url: { url } }, { imageUrl: url }, { data: url }]) {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify({ data: [item] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
        const provider = new NewApiProvider({
          baseUrl: 'https://newapi.example.com/v1',
          apiKey: 'server-secret',
          fetchImpl,
        });

        const result = await provider.execute({ snapshot: standardSnapshot('image') });

        expect(result.output).toEqual({
          mediaType: 'image',
          kind: 'url',
          url,
          mimeType: 'image/webp',
          format: 'webp',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([undefined, null, '', ' \n\t '])(
    'falls back to the image URL for absent or empty inline fields: %j',
    async (inline) => {
      for (const field of ['b64_json', 'b64Json', 'base64', 'data']) {
        const url = 'http://cdn.example/image.webp';
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify({ data: [{ url, [field]: inline }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
        const provider = new NewApiProvider({
          baseUrl: 'https://newapi.example.com/v1',
          apiKey: 'server-secret',
          fetchImpl,
        });

        const result = await provider.execute({ snapshot: standardSnapshot('image') });

        expect(result.output).toEqual({
          mediaType: 'image',
          kind: 'url',
          url,
          mimeType: 'image/webp',
          format: 'webp',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([undefined, null, '', ' \n\t '])(
    'keeps the missing-content error for empty inline fields without a URL: %j',
    async (inline) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ b64_json: inline }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      });

      await expect(provider.execute({ snapshot: standardSnapshot('image') })).rejects.toMatchObject(
        {
          name: 'NewApiProviderError',
          message: 'New API 图片响应缺少 url 或 base64 内容',
          retryable: false,
        },
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { inline: '%%%', code: 'PROVIDER_OUTPUT_BASE64_INVALID' },
    { inline: 'data:image/png;base64,%%%', code: 'PROVIDER_OUTPUT_BASE64_INVALID' },
    { inline: 'data:image/png;base64,', code: 'PROVIDER_OUTPUT_BASE64_INVALID' },
    { inline: 'data:audio/mpeg;base64,YXVkaW8=', code: 'PROVIDER_OUTPUT_MIME_MISMATCH' },
  ])(
    'rejects malformed inline images rather than falling back to a URL: $inline',
    async ({ inline, code }) => {
      for (const url of [
        undefined,
        'http://cdn.example/image.png',
        'https://cdn.example/image.png',
      ]) {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify({ data: [{ url, b64_json: inline }] }), {
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
          provider.execute({ snapshot: standardSnapshot('image') }),
        ).rejects.toMatchObject({
          name: 'NewApiProviderError',
          code,
          retryable: false,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([undefined, 'http://cdn.example/image.jpg', 'https://cdn.example/image.jpg'])(
    'uses the New API top-level output format for data[0].b64_json responses (%s)',
    async (url) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            created: 1_756_000_000,
            output_format: 'webp',
            data: [{ url, b64_json: 'd2VicC1pbWFnZQ==', format: 'jpeg' }],
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
    },
  );

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

  it.each([undefined, 'http://cdn.example/image.jpg', 'https://cdn.example/image.jpg'])(
    'rejects an image response that explicitly declares an audio MIME type (%s)',
    async (url) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ mime_type: 'audio/mpeg', data: [{ url, b64_json: 'aW1hZ2U=' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      });

      await expect(provider.execute({ snapshot: standardSnapshot('image') })).rejects.toMatchObject(
        {
          name: 'NewApiProviderError',
          code: 'PROVIDER_OUTPUT_MIME_MISMATCH',
          message: 'New API 图片响应 MIME 类型与媒体类型不匹配',
        },
      );
    },
  );

  it.each([undefined, 'http://cdn.example/image.jpg', 'https://cdn.example/image.jpg'])(
    'rejects an image data URL that explicitly carries an audio MIME type (%s)',
    async (url) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ url, b64_json: 'data:audio/mpeg;base64,YXVkaW8=' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      });

      await expect(provider.execute({ snapshot: standardSnapshot('image') })).rejects.toMatchObject(
        {
          name: 'NewApiProviderError',
          code: 'PROVIDER_OUTPUT_MIME_MISMATCH',
        },
      );
    },
  );

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
        parameters: { input: 'say hello', response_format: 'mp3', voice: 'alloy' },
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
        parameters: { voice: 'alloy' },
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
    expect((error as NewApiProviderError).message.length).toBeLessThanOrEqual(2_000);
    expect((error as NewApiProviderError).message).toMatch(/\.\.\. \[truncated\]$/);
    expect((error as NewApiProviderError).message).toContain('模型调用失败（HTTP 503）');
    expect((error as NewApiProviderError).message).toContain('错误代码：overloaded');
    expect((error as NewApiProviderError).message).toContain('供应商返回：');
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

  it('classifies a caller abort separately from a provider timeout', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('operation aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      timeoutMs: 10_000,
    });

    const execution = provider.execute({ snapshot: textSnapshot(), signal: controller.signal });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestSignal = fetchImpl.mock.calls[0]?.[1]?.signal;
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      code: 'ABORTED',
      retryable: false,
      message: 'New API 请求已取消',
    });
    expect(requestSignal?.aborted).toBe(true);
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

  /** 收集 Provider 在发送前交给 Worker 的请求记录。 */
  function collectRequestPrompts(records: RequestPromptRecord[]) {
    return (record: RequestPromptRecord) => {
      records.push(record);
    };
  }

  it('records the messages actually posted for a multi-input text run', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const records: RequestPromptRecord[] = [];
    const snapshot = textSnapshot();
    snapshot.inputs = [
      providerInput('node_transcript', 'transcript', 2),
      providerInput('node_prompt', 'prompt', 0),
      providerInput('node_content', 'content', 1),
    ];

    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      runId: 'run-text',
      attempt: 2,
      onRequestPrompt: collectRequestPrompts(records),
    });

    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; name?: string; content: string }>;
    };
    expect(payload.messages).toEqual([
      { role: 'user', name: 'canvas_prompt', content: 'prompt value' },
      { role: 'user', name: 'canvas_content', content: 'content value' },
      { role: 'user', name: 'canvas_transcript', content: 'transcript value' },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      schemaVersion: REQUEST_PROMPT_SCHEMA_VERSION,
      runId: 'run-text',
      nodeId: 'node_text',
      attempt: 2,
      requestIdentity: 'POST /chat/completions#1',
      provider: 'newapi',
      modelAlias: 'text-v1',
      mediaType: 'text',
      format: 'messages',
      parts: [
        { order: 0, role: 'user', name: 'canvas_prompt', text: 'prompt value' },
        { order: 1, role: 'user', name: 'canvas_content', text: 'content value' },
        { order: 2, role: 'user', name: 'canvas_transcript', text: 'transcript value' },
      ],
      resources: [],
      sendStatus: 'pending',
      createdAt: expect.any(String),
    });
    expect(new Date(records[0]?.createdAt ?? '').toISOString()).toBe(records[0]?.createdAt);
  });

  it('records the sent text of a prompt document together with image identity only', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const records: RequestPromptRecord[] = [];
    const snapshot = textSnapshot();
    snapshot.nodes[0].data.promptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '把背景改成' },
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
        { type: 'text', text: '的颜色' },
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
        blockOrder: 1,
      },
    ];

    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      resolvedMentions: resolveProviderMentions(snapshot),
      runId: 'run-text',
      attempt: 1,
      onRequestPrompt: collectRequestPrompts(records),
    });

    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(payload.messages[0]?.content).toEqual([
      { type: 'text', text: '把背景改成' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
      { type: 'text', text: '的颜色' },
    ]);
    expect(records[0]?.parts).toEqual([{ order: 0, role: 'user', text: '把背景改成的颜色' }]);
    expect(records[0]?.resources).toEqual([
      {
        assetId: 'asset-image',
        assetVersion: 2,
        role: 'referenceImage',
        sortOrder: 0,
        mediaType: 'image',
      },
    ]);
    expect(JSON.stringify(records[0])).not.toMatch(/base64|data:image|aW1hZ2U=/);
  });

  it('records one plain part equal to the posted text-to-image prompt', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const records: RequestPromptRecord[] = [];
    const snapshot = standardSnapshot('image');
    snapshot.parameters = { size: '1024x1024', prompt: 'A neon portrait' };
    snapshot.credentialId = 'cred-image';
    snapshot.credentialVersion = 4;
    snapshot.nodeCredentialReferences = {
      node_image: { credentialId: 'cred-image', credentialVersion: 4 },
    };

    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      runId: 'run-image',
      attempt: 1,
      onRequestPrompt: collectRequestPrompts(records),
    });

    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      size: '1024x1024',
      model: 'image-v1',
      prompt: 'A neon portrait',
      n: 1,
    });
    expect(records[0]).toMatchObject({
      provider: 'newapi',
      modelAlias: 'image-v1',
      credentialId: 'cred-image',
      credentialVersion: 4,
      mediaType: 'image',
      format: 'plain',
      requestIdentity: 'POST /images/generations#1',
      parts: [{ order: 0, text: 'A neon portrait' }],
      resources: [],
      sendStatus: 'pending',
    });
    expect(records[0]?.parts[0]?.text).toBe(payload.prompt);
  });

  it('records the multipart prompt and the source image identity of an image edit', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/edited.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const records: RequestPromptRecord[] = [];
    const snapshot = standardSnapshot('image');
    snapshot.imageEditCapability = { declared: true };
    snapshot.parameters = { prompt: '改成夜景' };
    snapshot.nodes[0].data.imageEditSource = {
      sourceNodeId: 'node_source',
      assetId: 'asset-source',
      version: 3,
    };
    snapshot.inputs = [{ ...editImageInput('node_source'), sourceAssetId: 'asset-source' }];

    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      runId: 'run-image',
      attempt: 1,
      onRequestPrompt: collectRequestPrompts(records),
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://newapi.example.com/v1/images/edits');
    const form = init?.body as FormData;
    expect(form.get('prompt')).toBe('改成夜景');
    expect(records[0]?.parts).toEqual([{ order: 0, text: form.get('prompt') }]);
    expect(records[0]?.resources).toEqual([
      {
        assetId: 'asset-source',
        assetVersion: 3,
        role: 'imageEdit',
        sortOrder: 0,
        mediaType: 'image',
      },
    ]);
    expect(records[0]).toMatchObject({
      format: 'plain',
      mediaType: 'image',
      requestIdentity: 'POST /images/edits#1',
    });
    expect(JSON.stringify(records[0])).not.toMatch(/base64|data:image/);
  });

  it('records the audio input string actually posted', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );
    const records: RequestPromptRecord[] = [];
    const snapshot = standardSnapshot('audio');
    snapshot.parameters = { input: 'say hello', response_format: 'mp3', voice: 'alloy' };
    // 旧快照没有单节点引用，只写根级凭据；记录必须沿用同一来源的两个字段。
    snapshot.credentialId = 'cred-audio';
    snapshot.credentialVersion = 2;

    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
    }).execute({
      snapshot,
      runId: 'run-audio',
      attempt: 1,
      onRequestPrompt: collectRequestPrompts(records),
    });

    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(payload.input).toBe('say hello');
    expect(records[0]).toMatchObject({
      provider: 'newapi',
      credentialId: 'cred-audio',
      credentialVersion: 2,
      mediaType: 'audio',
      format: 'plain',
      requestIdentity: 'POST /audio/speech#1',
      parts: [{ order: 0, text: 'say hello' }],
      resources: [],
      sendStatus: 'pending',
    });
    expect(records[0]?.parts[0]?.text).toBe(payload.input);
  });

  it('never writes inline media, credentials, or authorization into a record', async () => {
    const apiKey = syntheticApiKey('prompt-record');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const records: RequestPromptRecord[] = [];
    const snapshot = textSnapshot();
    snapshot.nodes[0].data.promptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '看图 ' },
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
        blockOrder: 1,
      },
    ];

    await new NewApiProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey,
      fetchImpl,
    }).execute({
      snapshot,
      resolvedMentions: resolveProviderMentions(snapshot),
      runId: 'run-text',
      attempt: 1,
      onRequestPrompt: collectRequestPrompts(records),
    });

    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain('data:image/png;base64');
    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toMatch(/base64|data:|authorization|Bearer/i);
    expect(serialized).not.toContain(apiKey);
  });

  it('aborts before the request when prompt persistence fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const failure = new Error('prompt store unavailable');

    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({
        snapshot: textSnapshot(),
        runId: 'run-text',
        attempt: 1,
        onRequestPrompt: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to record without the run identity supplied by the Worker', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const onRequestPrompt = vi.fn();

    await expect(
      new NewApiProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
      }).execute({ snapshot: textSnapshot(), attempt: 1, onRequestPrompt }),
    ).rejects.toThrow('需要 Worker 提供 runId');
    expect(onRequestPrompt).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
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

    await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
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

    await provider.execute({ snapshot, onProviderJob: vi.fn() });

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

  it.each(['grok-imagine-video-1.5（按次）', 'grok-imagine-video-1.5 （按次）'])(
    '视频模型名按 UTF-8 原样发送，不规范化空格或后缀：%s',
    async (modelAlias) => {
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
      snapshot.modelAlias = modelAlias;

      await provider.execute({ snapshot, onProviderJob: vi.fn() });

      const [requestUrl, requestInit] = fetchImpl.mock.calls[0]!;
      const requestBytes = await new Request(requestUrl, requestInit).arrayBuffer();
      const requestBody = new TextDecoder('utf-8', { fatal: true }).decode(requestBytes);
      expect(JSON.parse(requestBody).model).toBe(modelAlias);
      expect(requestBody).toContain(`"model":${JSON.stringify(modelAlias)}`);
      expect(snapshot.modelAlias).toBe(modelAlias);
      expect(requestUrl).toBe('https://newapi.example.com/v1/videos/generations');
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    },
  );

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

    await provider.execute({ snapshot, onProviderJob: vi.fn() });

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

    await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
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
      message: expect.stringContaining('当前项目尚未接通 New API video'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps omni prompt image mentions to grok-imagine-video-1.5 reference_images', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'grok-imagine-video-1.5.1';
    snapshot.inputs = [];
    snapshot.nodes = snapshot.nodes.map((node) =>
      node.id === 'node_video'
        ? {
            ...node,
            data: {
              ...node.data,
              videoMode: 'omni_reference' as const,
              promptDocument: {
                version: 1,
                blocks: [
                  { type: 'text', text: 'Keep the product identity' },
                  {
                    type: 'mention',
                    mentionId: 'mention-omni-image',
                    assetId: 'asset-omni-image',
                    assetVersion: 1,
                    label: '产品图',
                    mediaType: 'image',
                    mimeType: 'image/png',
                    contentUrl: 'data:image/png;base64,aW1hZ2U=',
                  },
                ],
              },
            },
          }
        : node,
    );
    snapshot.promptMentions = [
      {
        nodeId: 'node_video',
        mentionId: 'mention-omni-image',
        assetId: 'asset-omni-image',
        assetVersion: 1,
        label: '产品图',
        mediaType: 'image',
        blockOrder: 1,
      },
    ];

    await expect(
      new NewApiVideoProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        videoContract: 'newapi-video-v1',
        fetchImpl,
        pollIntervalMs: 0,
      }).execute({
        snapshot,
        resolvedMentions: resolveProviderMentions(snapshot),
        onProviderJob: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'VIDEO_SUBMISSION_UNKNOWN' });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'grok-imagine-video-1.5.1',
      prompt: 'Keep the product identity产品图',
      reference_images: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).image).toBeUndefined();
  });

  it('absorbs duplicate omni prompt image mentions as one grok reference image', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'grok-imagine-video-1.5.1';
    snapshot.inputs = [];
    const imageMention = {
      type: 'mention' as const,
      assetId: 'asset-omni-image',
      assetVersion: 1,
      label: '产品图',
      mediaType: 'image' as const,
      mimeType: 'image/png',
      contentUrl: 'data:image/png;base64,aW1hZ2U=',
    };
    snapshot.nodes = snapshot.nodes.map((node) =>
      node.id === 'node_video'
        ? {
            ...node,
            data: {
              ...node.data,
              videoMode: 'omni_reference' as const,
              promptDocument: {
                version: 1,
                blocks: [
                  { type: 'text', text: 'Keep ' },
                  { ...imageMention, mentionId: 'mention-omni-image-a' },
                  { type: 'text', text: ' and ' },
                  { ...imageMention, mentionId: 'mention-omni-image-b' },
                ],
              },
            },
          }
        : node,
    );
    snapshot.promptMentions = [
      {
        nodeId: 'node_video',
        mentionId: 'mention-omni-image-a',
        assetId: 'asset-omni-image',
        assetVersion: 1,
        label: '产品图',
        mediaType: 'image',
        blockOrder: 1,
      },
      {
        nodeId: 'node_video',
        mentionId: 'mention-omni-image-b',
        assetId: 'asset-omni-image',
        assetVersion: 1,
        label: '产品图',
        mediaType: 'image',
        blockOrder: 3,
      },
    ];

    await expect(
      new NewApiVideoProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        videoContract: 'newapi-video-v1',
        fetchImpl,
        pollIntervalMs: 0,
      }).execute({
        snapshot,
        resolvedMentions: resolveProviderMentions(snapshot),
        onProviderJob: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'VIDEO_SUBMISSION_UNKNOWN' });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'grok-imagine-video-1.5.1',
      prompt: 'Keep 产品图 and 产品图',
      reference_images: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).reference_images).toHaveLength(1);
  });

  it('maps text-to-video prompt image mentions as grok omni reference_images', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'grok-imagine-video-1.5.1';
    snapshot.inputs = [];
    snapshot.nodes = snapshot.nodes.map((node) =>
      node.id === 'node_video'
        ? {
            ...node,
            data: {
              ...node.data,
              videoMode: 'text_to_video' as const,
              promptDocument: {
                version: 1,
                blocks: [
                  { type: 'text', text: 'Keep the product identity' },
                  {
                    type: 'mention',
                    mentionId: 'mention-omni-image',
                    assetId: 'asset-omni-image',
                    assetVersion: 1,
                    label: '产品图',
                    mediaType: 'image',
                    mimeType: 'image/png',
                    contentUrl: 'data:image/png;base64,aW1hZ2U=',
                  },
                ],
              },
            },
          }
        : node,
    );
    snapshot.promptMentions = [
      {
        nodeId: 'node_video',
        mentionId: 'mention-omni-image',
        assetId: 'asset-omni-image',
        assetVersion: 1,
        label: '产品图',
        mediaType: 'image',
        blockOrder: 1,
      },
    ];

    await expect(
      new NewApiVideoProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        videoContract: 'newapi-video-v1',
        fetchImpl,
        pollIntervalMs: 0,
      }).execute({
        snapshot,
        resolvedMentions: resolveProviderMentions(snapshot),
        onProviderJob: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'VIDEO_SUBMISSION_UNKNOWN' });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'grok-imagine-video-1.5.1',
      prompt: 'Keep the product identity产品图',
      reference_images: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
    });
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
        contract: 'legacy-v1',
        phase: 'completed',
        modelAlias: 'grok-imagine-video-1.5',
        providerStatus: 'done',
        progress: 100,
      },
    });
    expect(onProviderJob).toHaveBeenNthCalledWith(1, {
      provider: 'newapi',
      status: 'queued',
      progress: 0,
      payload: { contract: 'legacy-v1', phase: 'submitting', modelAlias: 'grok-imagine-video-1.5' },
    });
    expect(onProviderJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: 'newapi',
        platformJobId: 'video-request-123',
        status: 'submitted',
        payload: expect.objectContaining({
          contract: 'legacy-v1',
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
          contract: 'legacy-v1',
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

      await provider.execute({ snapshot, onProviderJob: vi.fn() });

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

    await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT_ROLE',
      retryable: false,
      message:
        'New API video 不支持该输入角色：firstFrame（上游媒体类型 text 无法映射为图片） 图生视频请把图片连到「首帧」口；提示词请连到「提示词」口或在节点中填写。',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps an image connected to the content port as the video first frame', async () => {
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
    const snapshot = videoSnapshot();
    snapshot.inputs[0] = { ...snapshot.inputs[0], role: 'content' };

    await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
      code: 'VIDEO_SUBMISSION_UNKNOWN',
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      image: { url: 'https://assets.example/first.png' },
    });
  });

  it('keeps no-available-channel video errors instead of wrapping them as unknown', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 'model_not_found',
            message: 'No available channel for model grok-imagine-video-1.5.1 under group 神秘分组',
            type: 'new_api_error',
          },
        }),
        {
          status: 503,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-no-channel' },
        },
      ),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });

    const error = await provider
      .execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 503,
      code: 'model_not_found',
      retryable: false,
    });
    expect((error as NewApiProviderError).message).toContain('视频创建失败（HTTP 503）');
    expect((error as NewApiProviderError).message).toContain('No available channel');
    expect((error as NewApiProviderError).message).toContain('当前分组没有可用渠道');
    expect((error as NewApiProviderError).message).toContain('req-no-channel');
    expect((error as NewApiProviderError).code).not.toBe('VIDEO_SUBMISSION_UNKNOWN');
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
      onProviderJob: vi.fn(),
      providerJob: { provider: 'newapi' as const, id: 'provider_job_video_retry' },
    };

    const error = await provider.execute(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'VIDEO_SUBMISSION_UNKNOWN',
      retryable: false,
    });
    expect((error as NewApiProviderError).message).toContain('视频创建失败（HTTP 503）');
    expect((error as NewApiProviderError).message).toContain('temporarily unavailable');
    expect((error as NewApiProviderError).message).toContain(
      'New API 视频创建结果未知，请先核对平台任务状态',
    );

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

  it('stops an in-flight video creation without automatically retrying it', async () => {
    const controller = new AbortController();
    let markCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/videos/generations')) {
        throw new Error(`unexpected New API request: ${String(url)}`);
      }
      markCreateStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('operation aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      timeoutMs: 10_000,
    });

    const execution = provider.execute({
      snapshot: videoSnapshot(),
      signal: controller.signal,
      onProviderJob: vi.fn(),
    });
    await createStarted;
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      code: 'ABORTED',
      retryable: false,
      message: 'New API 请求已取消',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('创建立即失败时仅冻结提交合同，不轮询或持久化成功状态', async () => {
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
        contract: 'legacy-v1',
        phase: 'failed',
        providerStatus: 'failed',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onProviderJob).toHaveBeenCalledExactlyOnceWith({
      provider: 'newapi',
      status: 'queued',
      progress: 0,
      payload: { contract: 'legacy-v1', phase: 'submitting', modelAlias: 'grok-imagine-video-1.5' },
    });
  });

  it.each(unsupportedVideoInputRoles)(
    'rejects unsupported video role %s before creating a paid task',
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
          onProviderJob: vi.fn(),
        }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_INPUT_ROLE',
        retryable: false,
        message: `New API video 不支持该输入角色：${role}`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rejects role-shaped video parameters before creating a paid task', async () => {
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
          onProviderJob: vi.fn(),
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

    await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
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

      await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
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

    const execution = await provider.execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() });

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

    await provider.execute({ snapshot, onProviderJob: vi.fn() });

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

    await expect(
      provider.execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({
      code: 'VIDEO_GENERATION_FAILED',
      retryable: false,
      message: 'content rejected',
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('explains a failed video poll when the provider omits failure_reason', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'task_no_reason',
            object: 'video',
            model: 'grok-imagine-video-1.5.1',
            status: 'queued',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'task_no_reason',
            object: 'video',
            model: 'grok-imagine-video-1.5.1',
            status: 'failed',
            progress: 100,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      videoContract: 'newapi-video-v1',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 2,
    });

    await expect(
      provider.execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({
      code: 'VIDEO_GENERATION_FAILED',
      retryable: false,
      platformJobId: 'task_no_reason',
      message:
        'New API 视频任务失败（status=failed, progress=100, model=grok-imagine-video-1.5, task=task_no_reason）。供应商未返回失败原因。',
    });
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

    await expect(
      provider.execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({
      code: 'VIDEO_POLL_TIMEOUT',
      platformJobId: 'slow-video',
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('根据自定义等待时间扩展默认视频轮询，且只提交一次生成', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
        async (_url, init) =>
          new Response(
            JSON.stringify(
              init?.method === 'POST' ? { request_id: 'long-video' } : { status: 'pending' },
            ),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      );
      const provider = new NewApiVideoProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'synthetic-key',
        fetchImpl,
        pollIntervalMs: 2_000,
        timeoutMs: 1_200_000,
      });
      const result = expect(
        provider.execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() }),
      ).rejects.toMatchObject({
        code: 'VIDEO_POLL_TIMEOUT',
        platformJobId: 'long-video',
      });
      await vi.advanceTimersByTimeAsync(1_200_000);
      await result;
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(195);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a caller abort through video polling with a non-retryable diagnostic', async () => {
    const controller = new AbortController();
    let pollSignal: AbortSignal | undefined;
    let markPollStarted: (() => void) | undefined;
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'cancelled-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.endsWith('/videos/cancelled-video')) {
        pollSignal = init?.signal ?? undefined;
        markPollStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('operation aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      throw new Error(`unexpected New API request: ${requestUrl}`);
    });
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 3,
      timeoutMs: 10_000,
    });

    const execution = provider.execute({
      snapshot: videoSnapshot(),
      signal: controller.signal,
      onProviderJob: vi.fn(),
    });
    await pollStarted;
    expect(pollSignal).toBeInstanceOf(AbortSignal);
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      code: 'ABORTED',
      platformJobId: 'cancelled-video',
      retryable: false,
      message: 'New API 请求已取消',
    });
    expect(pollSignal?.aborted).toBe(true);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('stops an in-flight poll delay before sending the next video status request', async () => {
    const controller = new AbortController();
    let markSubmitted: (() => void) | undefined;
    const submitted = new Promise<void>((resolve) => {
      markSubmitted = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'delayed-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected New API request: ${requestUrl}`);
    });
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 10_000,
      timeoutMs: 10_000,
    });

    const execution = provider.execute({
      snapshot: videoSnapshot(),
      signal: controller.signal,
      onProviderJob: async (providerJob) => {
        if (providerJob.platformJobId === 'delayed-video') markSubmitted?.();
      },
    });
    await submitted;
    // 平台身份持久化后，等待进入本地轮询延迟再取消，避免只测到请求前取消。
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      code: 'ABORTED',
      platformJobId: 'delayed-video',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

    await expect(
      provider.execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({
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
      .execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() })
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
      .execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() })
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

    await expect(
      provider.execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({
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
      .execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NewApiProviderError);
    expect(error).toMatchObject({ code: 'VIDEO_SUBMISSION_UNKNOWN', retryable: false });
    expect((error as NewApiProviderError).message).toContain(
      'New API 视频创建结果未知，请先核对平台任务状态',
    );
    expect((error as NewApiProviderError).message).toContain('response stream failed');
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
        onProviderJob: async (update) => {
          if (update.platformJobId) throw new Error('database unavailable');
        },
      }),
    ).rejects.toMatchObject({
      code: 'VIDEO_JOB_PERSISTENCE_FAILED',
      platformJobId: 'durable-video',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { model: 'grok-imagine-video-1.5', contract: 'newapi-video-v1' },
    { model: 'MiniMax-H3', contract: 'legacy-v1' },
    { model: 'wan3.0-video', contract: 'newapi-video-v1' },
    { model: 'doubao-seedance-2-5-260628', contract: 'newapi-video-v1' },
  ] as const)(
    'resumes an existing $model $contract job without hydrating inputs or another POST',
    async ({ model, contract }) => {
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
      const snapshot = { ...videoSnapshot(), modelAlias: model };
      snapshot.inputs[0].snapshot.data.contentUrl = undefined;
      const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId)!;
      target.data.promptDocument = {
        version: 1,
        blocks: [
          { type: 'text', text: 'Animate ' },
          {
            type: 'mention',
            mentionId: 'archived-reference',
            assetId: 'archived-image',
            assetVersion: 2,
            mediaType: 'image',
            label: 'Archived image',
          },
        ],
      };
      snapshot.promptMentions = [
        {
          nodeId: target.id,
          mentionId: 'archived-reference',
          assetId: 'archived-image',
          assetVersion: 2,
          mediaType: 'image',
          label: 'Archived image',
          blockOrder: 1,
        },
      ];
      const onRequestPrompt = vi.fn();
      const execution = await provider.execute({
        snapshot,
        providerJob: {
          provider: 'newapi',
          platformJobId: 'already-created',
          status: 'submitted',
          progress: 35,
          payload: { contract, phase: 'submitted' },
        },
        onProviderJob,
        onRequestPrompt,
      });

      expect(onRequestPrompt).not.toHaveBeenCalled();
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
    },
  );

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
    expect(error.providerPayload?.long).toHaveLength(1_000);
  });

  it('sends grok-imagine-video-1.5 reference images in connection order', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      videoContract: 'newapi-video-v1',
      fetchImpl,
      pollIntervalMs: 0,
    });
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'grok-imagine-video-1.5.1';
    snapshot.inputs.push(
      providerInput('node_character_a', 'character', 1),
      providerInput('node_style_a', 'style', 2),
      providerInput('node_reference_a', 'referenceImage', 3),
      providerInput('node_character_b', 'character', 4),
    );

    await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
      code: 'VIDEO_SUBMISSION_UNKNOWN',
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'grok-imagine-video-1.5.1',
      image: 'https://assets.example/first.png',
      reference_images: [
        { url: 'https://assets.example/node_character_a.png' },
        { url: 'https://assets.example/node_style_a.png' },
        { url: 'https://assets.example/node_reference_a.png' },
        { url: 'https://assets.example/node_character_b.png' },
      ],
    });
  });

  it('sends grok-imagine-video-1.5 last_frame with the same image shape as first frame', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      videoContract: 'newapi-video-v1',
      fetchImpl,
      pollIntervalMs: 0,
    });
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'grok-imagine-video-1.5.1';
    snapshot.inputs.push(providerInput('node_last', 'lastFrame', 1));

    await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
      code: 'VIDEO_SUBMISSION_UNKNOWN',
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      image: 'https://assets.example/first.png',
      last_frame: 'https://assets.example/node_last.png',
    });
  });

  it('sends grok-imagine-video-1.5 omni references without a first frame when videoMode is omni', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      videoContract: 'newapi-video-v1',
      fetchImpl,
      pollIntervalMs: 0,
    });
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'grok-imagine-video-1.5.1';
    snapshot.nodes = snapshot.nodes.map((node) =>
      node.id === 'node_video'
        ? { ...node, data: { ...node.data, videoMode: 'omni_reference' as const } }
        : node,
    );
    snapshot.inputs = [providerInput('node_reference_a', 'referenceImage', 0)];

    await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
      code: 'VIDEO_SUBMISSION_UNKNOWN',
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.image).toBeUndefined();
    expect(body.last_frame).toBeUndefined();
    expect(body.reference_images).toEqual([{ url: 'https://assets.example/node_reference_a.png' }]);
  });

  it('rejects first-frame plus omni references when the node is locked to omni mode', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'grok-imagine-video-1.5.1';
    snapshot.nodes = snapshot.nodes.map((node) =>
      node.id === 'node_video'
        ? { ...node, data: { ...node.data, videoMode: 'omni_reference' as const } }
        : node,
    );
    snapshot.inputs.push(providerInput('node_reference_a', 'referenceImage', 1));

    await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT_ROLE',
      message: 'New API video 不支持该输入角色：firstFrame',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still rejects referenceImage on models without a confirmed reference contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
    });
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'sora-2';
    snapshot.inputs.push(providerInput('node_reference_a', 'referenceImage', 1));

    await expect(provider.execute({ snapshot, onProviderJob: vi.fn() })).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT_ROLE',
      retryable: false,
      message: 'New API video 不支持该输入角色：referenceImage',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /** 通过隔离的创建/查询响应检查已确认插件请求，不调用上游或下载素材。 */
  async function submitOfficialVideo(snapshot: RunSnapshot, records: RequestPromptRecord[] = []) {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'official-task', status: 'queued' })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'official-task',
            status: 'completed',
            video: { url: 'https://cdn.example/official.mp4' },
          }),
        ),
      );
    const execution = await new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'test-secret',
      videoContract: 'newapi-video-v1',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    }).execute({
      snapshot,
      resolvedMentions: resolveProviderMentions(snapshot),
      onProviderJob: vi.fn(),
      runId: 'run-official',
      onRequestPrompt: (record) => {
        records.push(record);
      },
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example.com/v1/videos');
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    return { body: JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)), execution };
  }

  it.each(
    [
      'minimax-h3',
      'MiniMax-H3',
      'wan3.0-video',
      'wan3.0-video-prime',
      'doubao-seedance-2-0-260128',
      'seedance-2-0-official',
      'seedance-2-0-fast-official',
      'seedance-2-0-mini-official',
      'doubao-seedance-2-5-260628',
    ].flatMap((model) =>
      (['text_to_video', 'first_frame', 'first_last_frame', 'omni_reference'] as const).map(
        (mode) => ({ model, mode }),
      ),
    ),
  )('maps $model $mode through the confirmed plugin contract', async ({ model, mode }) => {
    const snapshot = videoSnapshot();
    snapshot.modelAlias = model;
    const h3 = model === 'minimax-h3' || model === 'MiniMax-H3';
    const ratio =
      model.includes('2-5') && (mode === 'first_frame' || mode === 'first_last_frame')
        ? 'adaptive'
        : '16:9';
    snapshot.parameters = {
      duration: 8,
      resolution: h3 ? '768p' : '720p',
      aspectRatio: ratio,
    };
    snapshot.nodes[1]!.data.videoMode = mode;
    snapshot.inputs =
      mode === 'text_to_video'
        ? []
        : mode === 'omni_reference'
          ? [
              providerInput('reference', 'referenceImage', 0),
              providerInput('voice', 'audioTrack', 2),
            ]
          : [providerInput('first', 'firstFrame', 0)];
    if (mode === 'first_last_frame') snapshot.inputs.push(providerInput('last', 'lastFrame', 1));
    if (mode === 'omni_reference') {
      const video = providerInput('clip', 'content', 1);
      video.snapshot.data = {
        label: 'Clip',
        mode: 'source',
        mediaType: 'video',
        contentUrl: 'https://assets.example/clip.mp4',
        mimeType: 'video/mp4',
      };
      snapshot.inputs.push(video);
    }
    snapshot.inputs.forEach((input, index) => {
      input.sourceAssetId = `asset-${index}`;
      input.sourceAssetVersion = index + 1;
    });
    const estimatedMedia = model === 'MiniMax-H3' ? describeVideoInputMedia(snapshot) : undefined;
    const records: RequestPromptRecord[] = [];
    const { body } = await submitOfficialVideo(snapshot, records);
    expect(body).toMatchObject({ model, prompt: 'Animate the scene', seconds: '8', duration: 8 });
    const roles =
      mode === 'text_to_video'
        ? []
        : mode === 'first_frame'
          ? ['first_frame']
          : mode === 'first_last_frame'
            ? ['first_frame', 'last_frame']
            : ['reference_image', 'reference_video', 'reference_audio'];
    if (model.startsWith('wan')) {
      expect(body.metadata.input.media.map((item: { type: string }) => item.type)).toEqual(roles);
      expect(body).toMatchObject({ resolution: '720P', ratio: '16:9' });
      expect(body.aspect_ratio).toBeUndefined();
      expect(
        body.metadata.input.media.every((item: { url: unknown }) => typeof item.url === 'string'),
      ).toBe(true);
    } else {
      const media = body.metadata.content.filter((item: { type: string }) => item.type !== 'text');
      expect(media.map((item: { role: string }) => item.role)).toEqual(roles);
      if (estimatedMedia) {
        expect(estimatedMedia).toEqual(
          media.map((item: { type: string; role: string }) => ({
            type: item.type.replace('_url', ''),
            role: item.role,
          })),
        );
      }
      expect(
        media.every((item: Record<string, any>) => typeof item[item.type]?.url === 'string'),
      ).toBe(true);
      expect(body.metadata).toMatchObject({
        resolution: h3 ? '768P' : '720p',
        ratio,
      });
    }
    expect(body.image).toBeUndefined();
    expect(body.reference_images).toBeUndefined();
    expect(records[0]?.resources).toEqual(
      [...snapshot.inputs]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((input, sortOrder) => ({
          assetId: input.sourceAssetId,
          assetVersion: input.sourceAssetVersion,
          role: input.role,
          sortOrder,
          mediaType: input.snapshot.data.mediaType,
        })),
    );
    expect(JSON.stringify(records)).not.toContain('https://');
  });

  it('serializes frozen Wan reference-video durations as an ordered metadata sidecar', async () => {
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'wan3.0-video';
    snapshot.nodes[1]!.data.videoMode = 'omni_reference';
    const laterVideo = providerInput('later-video', 'content', 3);
    laterVideo.sourceDurationSeconds = 7.25;
    laterVideo.snapshot.data = {
      label: 'Later video',
      mediaType: 'video',
      mode: 'source',
      contentUrl: 'https://assets.example/later.mp4',
      mimeType: 'video/mp4',
    };
    const earlierVideo = providerInput('earlier-video', 'content', 1);
    earlierVideo.sourceDurationSeconds = 4.5;
    earlierVideo.snapshot.data = {
      label: 'Earlier video',
      mediaType: 'video',
      mode: 'source',
      contentUrl: 'https://assets.example/earlier.mp4',
      mimeType: 'video/mp4',
    };
    snapshot.inputs = [
      laterVideo,
      providerInput('reference-image', 'referenceImage', 2),
      earlierVideo,
    ];

    const { body } = await submitOfficialVideo(snapshot);

    expect(body.metadata.reference_video_durations).toEqual([4.5, 7.25]);
    expect(body.metadata.input.media.map((item: { type: string }) => item.type)).toEqual([
      'reference_video',
      'reference_image',
      'reference_video',
    ]);
    expect(body.metadata.input).not.toHaveProperty('reference_video_durations');
    expect(
      body.metadata.input.media.every(
        (item: Record<string, unknown>) =>
          !('duration' in item) && !('sourceDurationSeconds' in item),
      ),
    ).toBe(true);
  });

  it('omits the entire Wan duration sidecar when one reference video lacks frozen duration', async () => {
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'wan3.0-video';
    snapshot.nodes[1]!.data.videoMode = 'omni_reference';
    const withDuration = providerInput('known-video', 'content', 0);
    withDuration.sourceDurationSeconds = 6.5;
    withDuration.snapshot.data = {
      label: 'Known video',
      mediaType: 'video',
      mode: 'source',
      contentUrl: 'https://assets.example/known.mp4',
      mimeType: 'video/mp4',
    };
    const withoutDuration = providerInput('legacy-video', 'content', 1);
    withoutDuration.snapshot.data = {
      label: 'Legacy video',
      mediaType: 'video',
      mode: 'source',
      contentUrl: 'https://assets.example/legacy.mp4',
      mimeType: 'video/mp4',
    };
    snapshot.inputs = [withDuration, withoutDuration];

    const { body } = await submitOfficialVideo(snapshot);

    expect(body.metadata).not.toHaveProperty('reference_video_durations');
    expect(body.metadata.input).toEqual({
      media: [
        { type: 'reference_video', url: 'https://assets.example/known.mp4' },
        { type: 'reference_video', url: 'https://assets.example/legacy.mp4' },
      ],
    });
  });

  it('copies a frozen video-mention duration into the Wan metadata sidecar', async () => {
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'wan3.0-video';
    const mention = {
      type: 'mention' as const,
      mentionId: 'mention-video',
      assetId: 'asset-video',
      assetVersion: 3,
      label: 'Reference video',
      mediaType: 'video' as const,
      mimeType: 'video/mp4',
      contentUrl: 'https://assets.example/frozen-video.mp4',
    };
    snapshot.nodes[1]!.data = {
      ...snapshot.nodes[1]!.data,
      videoMode: 'omni_reference',
      promptDocument: {
        version: 1,
        blocks: [{ type: 'text', text: 'Animate this clip ' }, mention],
      },
    };
    snapshot.inputs = [];
    snapshot.promptMentions = [
      {
        nodeId: 'node_video',
        mentionId: 'mention-video',
        assetId: 'asset-video',
        assetVersion: 3,
        label: 'Reference video',
        mediaType: 'video',
        durationSeconds: 8.75,
        blockOrder: 1,
      },
    ];

    const { body } = await submitOfficialVideo(snapshot);

    expect(body.metadata.reference_video_durations).toEqual([8.75]);
    expect(body.metadata.input.media).toEqual([
      { type: 'reference_video', url: 'https://assets.example/frozen-video.mp4' },
    ]);
  });

  it('sends both H3 image mentions with their frozen versions instead of applying the Grok guard', async () => {
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'MiniMax-H3';
    snapshot.parameters = { duration: 5, resolution: '768P' };
    snapshot.inputs = [];
    const mentions = [1, 2].map((version) => ({
      type: 'mention' as const,
      mentionId: `mention-${version}`,
      assetId: 'asset-photo',
      assetVersion: version,
      label: `Photo ${version}`,
      mediaType: 'image' as const,
      mimeType: 'image/png',
      contentUrl: `data:image/png;base64,${btoa(`image-${version}`)}`,
    }));
    snapshot.nodes[1]!.data = {
      ...snapshot.nodes[1]!.data,
      videoMode: 'omni_reference',
      promptDocument: {
        version: 1,
        blocks: [{ type: 'text', text: 'Animate these photos ' }, ...mentions],
      },
    };
    snapshot.promptMentions = mentions.map((mention, blockOrder) => ({
      ...mention,
      nodeId: 'node_video',
      blockOrder: blockOrder + 1,
    }));
    const mediaEstimate = describeVideoInputMedia(snapshot);
    const records: RequestPromptRecord[] = [];
    const { body } = await submitOfficialVideo(snapshot, records);
    expect(body.metadata.content).toEqual([
      { type: 'text', text: 'Animate these photos Photo 1Photo 2' },
      ...mentions.map((mention) => ({
        type: 'image_url',
        role: 'reference_image',
        image_url: { url: mention.contentUrl },
      })),
    ]);
    expect(records[0]?.resources.map((resource) => resource.assetVersion)).toEqual([1, 2]);
    expect(mediaEstimate).toEqual(
      body.metadata.content
        .filter((item: { type: string }) => item.type !== 'text')
        .map((item: { type: string; role: string }) => ({
          type: item.type.replace('_url', ''),
          role: item.role,
        })),
    );
    expect(JSON.stringify(records)).not.toContain('base64');
  });

  it.each(
    [
      'wan3.0-video',
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-5-260628',
      'seedance-2-0-official',
      'seedance-2-0-fast-official',
      'seedance-2-0-mini-official',
    ].flatMap((model) =>
      (['video_edit', 'video_extend'] as const).map((mode) => ({ model, mode })),
    ),
  )(
    'maps $model $mode without inventing another model version task type',
    async ({ model, mode }) => {
      const snapshot = videoSnapshot();
      snapshot.modelAlias = model;
      const moonSeedance = model.startsWith('seedance-2-0-');
      snapshot.parameters = {
        duration: (model.includes('2-5') || moonSeedance) && mode === 'video_edit' ? -1 : 8,
        aspectRatio:
          model.includes('2-5') || moonSeedance
            ? 'adaptive'
            : model.includes('2-0')
              ? '16:9'
              : 'adaptive',
      };
      snapshot.nodes[1]!.data.videoMode = mode;
      const input = providerInput('clip', 'content', 0);
      input.snapshot.data = {
        label: 'Clip',
        mediaType: 'video',
        mode: 'source',
        contentUrl: 'https://assets.example/clip.mp4',
        mimeType: 'video/mp4',
      };
      snapshot.inputs = [input];
      const { body } = await submitOfficialVideo(snapshot);
      if (model.includes('2-5') || moonSeedance)
        expect(body.metadata.omni_reference_task_type).toBe(
          mode === 'video_edit' ? 'edit' : 'extend',
        );
      else expect(body.metadata.omni_reference_task_type).toBeUndefined();
      expect(body.seconds).toBe(String(snapshot.parameters.duration));
      expect(model.startsWith('wan') ? body.ratio : body.metadata.ratio).toBe(
        moonSeedance ? 'adaptive' : snapshot.parameters.aspectRatio,
      );
    },
  );

  it.each(
    ['seedance-2-0-official', 'seedance-2-0-fast-official', 'seedance-2-0-mini-official'].flatMap(
      (model) => [
        { model, mode: 'video_edit' as const, duration: 8, aspectRatio: 'adaptive' },
        { model, mode: 'video_extend' as const, duration: 8, aspectRatio: '16:9' },
      ],
    ),
  )(
    'rejects Moon $model $mode when automatic duration or adaptive ratio is missing',
    async ({ model, mode, duration, aspectRatio }) => {
      const snapshot = videoSnapshot();
      snapshot.modelAlias = model;
      snapshot.parameters = { duration, aspectRatio };
      snapshot.nodes[1]!.data.videoMode = mode;
      const video = providerInput('clip', 'content', 0);
      video.snapshot.data = {
        label: 'Clip',
        mediaType: 'video',
        mode: 'source',
        contentUrl: 'https://assets.example/clip.mp4',
        mimeType: 'video/mp4',
      };
      snapshot.inputs = [video];
      const fetchImpl = vi.fn<typeof fetch>();

      await expect(
        new NewApiVideoProvider({
          baseUrl: 'https://newapi.example/v1',
          apiKey: 'test-secret',
          videoContract: 'newapi-video-v1',
          fetchImpl,
        }).execute({ snapshot, onProviderJob: vi.fn() }),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['wan3.0-video', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628'])(
    '%s accepts adaptive text-to-video without visual references',
    async (model) => {
      const snapshot = videoSnapshot();
      snapshot.modelAlias = model;
      snapshot.parameters = { duration: 8, aspectRatio: 'adaptive' };
      snapshot.nodes[1]!.data.videoMode = 'text_to_video';
      snapshot.inputs = [];
      const { body } = await submitOfficialVideo(snapshot);
      expect(model.startsWith('wan') ? body.ratio : body.metadata.ratio).toBe('adaptive');
    },
  );

  it.each([
    { model: 'MiniMax-H3', parameters: { resolution: '720p' } },
    { model: 'MiniMax-H3', parameters: { duration: 16 } },
    { model: 'minimax-h3', parameters: { aspectRatio: 'adaptive' } },
    { model: 'wan3.0-video', parameters: { aspectRatio: '21:9' } },
    { model: 'doubao-seedance-2-0-fast-260128', parameters: { resolution: '1080p' } },
    { model: 'doubao-seedance-2-5-260628', parameters: { aspectRatio: '16:9' } },
  ])(
    '$model rejects unsupported frame parameters before POST: $parameters',
    async ({ model, parameters }) => {
      const snapshot = videoSnapshot();
      snapshot.modelAlias = model;
      snapshot.parameters = { ...parameters };
      snapshot.nodes[1]!.data.videoMode = 'first_frame';
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        new NewApiVideoProvider({
          baseUrl: 'https://newapi.example/v1',
          apiKey: 'test-secret',
          videoContract: 'newapi-video-v1',
          fetchImpl,
        }).execute({ snapshot, onProviderJob: vi.fn() }),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['2k', '4k'])(
    'requires a reference for Moon H3 %s text-to-video before POST',
    async (resolution) => {
      const snapshot = videoSnapshot();
      snapshot.modelAlias = 'minimax-h3';
      snapshot.parameters = { duration: 8, resolution, aspectRatio: '16:9' };
      snapshot.nodes[1]!.data.videoMode = 'text_to_video';
      snapshot.inputs = [];
      const fetchImpl = vi.fn<typeof fetch>();

      await expect(
        new NewApiVideoProvider({
          baseUrl: 'https://newapi.example/v1',
          apiKey: 'test-secret',
          videoContract: 'newapi-video-v1',
          fetchImpl,
        }).execute({ snapshot, onProviderJob: vi.fn() }),
      ).rejects.toMatchObject({
        code: 'INVALID_PROVIDER_PARAMETER',
        retryable: false,
        message: expect.stringContaining('需要首尾帧或参考素材'),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    { model: 'wan3.0-video', mediaType: 'video' as const, role: 'content' as const },
    { model: 'wan3.0-video', mediaType: 'audio' as const, role: 'audioTrack' as const },
    { model: 'doubao-seedance-2-0-260128', mediaType: 'video' as const, role: 'content' as const },
    { model: 'minimax-h3', mediaType: 'image' as const, role: 'referenceImage' as const },
    {
      model: 'seedance-2-0-official',
      mediaType: 'image' as const,
      role: 'referenceImage' as const,
    },
  ])(
    'rejects $model $mediaType data URLs before POST when the plugin contract requires a public URL',
    async ({ model, mediaType, role }) => {
      const snapshot = videoSnapshot();
      snapshot.modelAlias = model;
      if (model === 'minimax-h3') snapshot.parameters.resolution = '768p';
      snapshot.nodes[1]!.data.videoMode = 'omni_reference';
      const input = providerInput('media', role, 1);
      input.snapshot.data = {
        label: 'Reference',
        mediaType,
        mode: 'source',
        contentUrl: `data:${mediaType}/mp4;base64,bWVkaWE=`,
        mimeType: `${mediaType}/mp4`,
      };
      snapshot.inputs = [providerInput('reference', 'referenceImage', 0), input];
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        new NewApiVideoProvider({
          baseUrl: 'https://newapi.example/v1',
          apiKey: 'test-secret',
          videoContract: 'newapi-video-v1',
          fetchImpl,
        }).execute({ snapshot, onProviderJob: vi.fn() }),
      ).rejects.toMatchObject({ code: 'VIDEO_REFERENCE_PUBLIC_URL_REQUIRED' });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('preserves Wan negative prompt, automatic duration and plugin-facing ratio', async () => {
    const snapshot = videoSnapshot();
    snapshot.modelAlias = 'wan3.0-video';
    snapshot.parameters = { duration: -1, aspectRatio: '16:9' };
    snapshot.nodes[1]!.data.videoMode = 'text_to_video';
    snapshot.inputs = [providerInput('negative', 'negativePrompt', 0)];
    const records: RequestPromptRecord[] = [];
    const { body } = await submitOfficialVideo(snapshot, records);
    expect(body).toMatchObject({
      seconds: '-1',
      duration: -1,
      ratio: '16:9',
      metadata: { input: { negative_prompt: 'negativePrompt value' } },
    });
    expect(body.aspect_ratio).toBeUndefined();
    expect(records[0]?.negativeText).toBe('negativePrompt value');
  });

  /** 收集视频创建前交给 Worker 的请求记录。 */
  function collectVideoPrompts(records: RequestPromptRecord[]) {
    return (record: RequestPromptRecord) => {
      records.push(record);
    };
  }

  it('records the create prompt once and no negative text that was never sent', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'prompt-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'done', video: { url: 'https://cdn.example/prompt.mp4' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const records: RequestPromptRecord[] = [];
    const snapshot = videoSnapshot();
    snapshot.inputs = [];

    await new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    }).execute({
      snapshot,
      onProviderJob: vi.fn(),
      runId: 'run-video',
      attempt: 1,
      onRequestPrompt: collectVideoPrompts(records),
    });

    const createBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(createBody).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: 'Animate the scene',
      duration: 8,
      resolution: '720p',
      aspect_ratio: '16:9',
    });
    expect(createBody.negative_prompt).toBeUndefined();
    expect(createBody.negativePrompt).toBeUndefined();
    // 创建一次加一次状态查询，但只有创建请求产生记录。
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      schemaVersion: REQUEST_PROMPT_SCHEMA_VERSION,
      runId: 'run-video',
      nodeId: 'node_video',
      attempt: 1,
      requestIdentity: 'POST /videos/generations#1',
      provider: 'newapi',
      modelAlias: 'grok-imagine-video-1.5',
      mediaType: 'video',
      format: 'plain',
      parts: [{ order: 0, text: 'Animate the scene' }],
      resources: [],
      sendStatus: 'pending',
      createdAt: expect.any(String),
    });
    expect(records[0]?.parts[0]?.text).toBe(createBody.prompt);
    expect(records[0]?.negativeText).toBeUndefined();
  });

  it('records the reference images actually written into the create body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ request_id: 'reference-video' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'done', video: { url: 'https://cdn.example/reference.mp4' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const records: RequestPromptRecord[] = [];
    const snapshot = videoSnapshot();
    snapshot.inputs = [{ ...snapshot.inputs[0]!, sourceAssetId: 'asset-first-frame' }];

    await new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: 'server-secret',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    }).execute({
      snapshot,
      onProviderJob: vi.fn(),
      runId: 'run-video',
      attempt: 1,
      onRequestPrompt: collectVideoPrompts(records),
    });

    const createBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(createBody.image).toEqual({ url: 'https://assets.example/first.png' });
    expect(records[0]?.parts).toEqual([{ order: 0, text: createBody.prompt }]);
    expect(records[0]?.resources).toEqual([
      { assetId: 'asset-first-frame', role: 'firstFrame', sortOrder: 0, mediaType: 'image' },
    ]);
    // 参考资源只留身份，不保存供应商 URL 或媒体内容。
    expect(JSON.stringify(records)).not.toContain('assets.example');
  });

  it('does not persist a contract or submit when prompt persistence fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const onProviderJob = vi.fn();
    const failure = new Error('prompt store unavailable');

    await expect(
      new NewApiVideoProvider({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'server-secret',
        fetchImpl,
        pollIntervalMs: 0,
      }).execute({
        snapshot: videoSnapshot(),
        onProviderJob,
        runId: 'run-video',
        attempt: 1,
        onRequestPrompt: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(onProviderJob).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
