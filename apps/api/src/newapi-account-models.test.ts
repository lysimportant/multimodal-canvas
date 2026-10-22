import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE2PRO_IMAGE_EDIT_CONTRACT,
  IMAGE2PRO_IMAGE_TASK_CONTRACT,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import { NewApiProvider } from '@multimodal-canvas/providers';
import { NewApiAccountService } from './newapi-account-service';
import { NewApiAccountSettings, newApiRequestUser } from './newapi-account-settings';

describe('New API 本人缓存模型目录', () => {
  it.each(['unavailable', 'missing', 'pending'])(
    '分组 %s 时保留同步失败原因，不把有效凭据误报为模型不存在',
    async (status) => {
      const findFirst = vi.fn().mockResolvedValue({
        status,
        error: '分组授权与令牌状态不一致，请重新连接 New API 账号后同步分组',
        credential: { ownerId: 'user-current', version: 3 },
      });
      const service = new NewApiAccountService({
        prisma: {
          aiCredential: { findFirst: vi.fn().mockResolvedValue(null) },
          newApiGroupBinding: { findFirst },
        },
        webUrl: 'http://localhost:5173',
      } as unknown as ConstructorParameters<typeof NewApiAccountService>[0]);
      vi.spyOn(service, 'identity').mockResolvedValue({
        id: 'identity-current',
        userId: 'user-current',
      } as Awaited<ReturnType<typeof service.identity>>);
      const settings = new NewApiAccountSettings(service);
      await expect(
        newApiRequestUser.run('user-current', () =>
          settings.getCredentialReference('credential-video'),
        ),
      ).rejects.toMatchObject({
        code: 'group_unavailable',
        status: 409,
        message: '分组授权与令牌状态不一致，请重新连接 New API 账号后同步分组',
      });
      expect(findFirst).toHaveBeenCalledWith({
        where: {
          identityId: 'identity-current',
          credentialId: 'credential-video',
          group: { not: '神秘分组' },
          status: { not: 'removed' },
        },
        include: { credential: true },
      });
    },
  );

  it.each([
    ['gemini-3-pro-image-preview', 'openai-images', 'openai-chat-completions'],
    ['gemini-nano-banana-2.1', undefined, 'openai-chat-completions'],
    ['imagen-4.0-generate-001', 'openai-images', 'openai-images'],
    ['普通图片模型', undefined, 'openai-images'],
    ['无限制-Z-Image', 'openai-images', 'openai-images'],
    ['无限制-图片模型', undefined, 'openai-images'],
    ['无限制-异步图片模型', IMAGE2PRO_IMAGE_TASK_CONTRACT, IMAGE2PRO_IMAGE_TASK_CONTRACT],
    ['普通异步图片模型', IMAGE2PRO_IMAGE_TASK_CONTRACT, IMAGE2PRO_IMAGE_TASK_CONTRACT],
    ['gpt-image-2.5-flare', IMAGE2PRO_IMAGE_EDIT_CONTRACT, IMAGE2PRO_IMAGE_EDIT_CONTRACT],
    ['Nano-banana-2.1', IMAGE2PRO_IMAGE_EDIT_CONTRACT, IMAGE2PRO_IMAGE_EDIT_CONTRACT],
  ] as const)('为 %s 冻结正确的图片执行协议', async (modelAlias, catalogContract, expected) => {
    const service = new NewApiAccountService({
      prisma: { aiCredential: { findFirst: vi.fn().mockResolvedValue(null) } },
      client: {},
      keyring: {},
      auth: {},
      webUrl: 'http://localhost:5173',
    } as unknown as ConstructorParameters<typeof NewApiAccountService>[0]);
    vi.spyOn(service, 'validateGroup').mockResolvedValue({
      credential: { version: 1 },
      catalog: {
        models: [
          { id: modelAlias, media_type: 'image', contract: catalogContract, available: true },
        ],
      },
      identity: {
        issuer: 'https://newapi.example.test',
        externalUserId: 'user',
        instanceId: 'canvas',
        grantId: 'grant',
      },
      upstreamTokenId: 'token',
      credentialRevision: '1',
      permissionRevision: '1',
      group: 'default',
      autoGroups: [],
    } as unknown as Awaited<ReturnType<typeof service.validateGroup>>);
    const snapshot: RunSnapshot = {
      projectId: 'project',
      canvasRevision: 1,
      targetNodeId: 'image',
      modelAlias,
      credentialId: 'credential',
      credentialVersion: 1,
      nodeCredentialReferences: { image: { credentialId: 'credential', credentialVersion: 1 } },
      parameters: {},
      submittedAt: '2026-10-14T00:00:00.000Z',
      nodes: [
        {
          id: 'image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { label: 'Image', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [],
      inputs: [],
    };
    const frozen = await service.freeze('user', snapshot);
    expect(frozen.executionBindings?.image?.contract).toBe(expected);
    if (expected === 'openai-images') {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [{ b64_json: Buffer.from('synthetic-image').toString('base64') }],
        }),
      );
      await new NewApiProvider({
        baseUrl: 'https://newapi.example.test/v1',
        apiKey: 'synthetic-key',
        fetchImpl,
      }).execute({ snapshot: frozen });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe('https://newapi.example.test/v1/images/generations');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: modelAlias });
    }
  });

  it('Gemini 生图聊天模型在图片节点目录中可选', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        group: 'default',
        credentialId: 'credential-gemini',
        status: 'active',
        catalog: {
          models: [
            {
              id: 'gemini-3-pro-image-preview',
              media_type: 'text',
              contract: 'openai-chat-completions',
              available: true,
            },
            { id: 'gemini-nano-banana-2.1', media_type: 'image', available: true },
            {
              id: 'imagen-4.0-generate-001',
              media_type: 'image',
              contract: 'openai-images',
              available: true,
            },
          ],
        },
        syncedAt: new Date('2026-10-14T00:00:00Z'),
      },
    ]);
    const service = new NewApiAccountService({
      prisma: {
        aiCredential: { findFirst: vi.fn().mockResolvedValue(null) },
        newApiGroupBinding: { findMany },
      },
      client: {},
      keyring: {},
      auth: {},
      webUrl: 'http://localhost:5173',
    } as unknown as ConstructorParameters<typeof NewApiAccountService>[0]);
    vi.spyOn(service, 'identity').mockResolvedValue({
      id: 'identity-current',
      updatedAt: new Date('2026-10-14T00:00:00Z'),
    } as Awaited<ReturnType<typeof service.identity>>);
    const models = await service.models('user-current', 'image');
    expect(models.map((model) => model.id)).toEqual([
      'gemini-3-pro-image-preview',
      'gemini-nano-banana-2.1',
      'imagen-4.0-generate-001',
    ]);
    expect(models[0]?.mediaTypes).toEqual(['text', 'image']);
    expect(models[0]?.contract).toBe('openai-chat-completions');
  });

  it.each([undefined, 'video'] as const)(
    '实际设置入口保留上游缓存模型及精确合同声明：%s',
    async (mediaType) => {
      const cachedFlash = ['无限制-Flash-中配-Video', '无限制-Flash-MAX-Video'].map((id) => ({
        id,
        media_type: 'video',
        contract: 'newapi-video-v1',
        available: true,
      }));
      const capabilities = { resolution: ['720p'], generate_audio: true };
      const findMany = vi.fn().mockResolvedValue([
        {
          group: 'default',
          credentialId: 'credential-seedance',
          status: 'active',
          catalog: {
            models: [
              ...cachedFlash,
              {
                id: 'Seedance2.0 0.9r',
                media_type: 'video',
                contract: 'newapi-video-v1',
                available: true,
                input_media_types: ['image'],
                capabilities,
              },
            ],
          },
          syncedAt: new Date('2026-10-08T00:00:00Z'),
        },
      ]);
      const service = new NewApiAccountService({
        prisma: {
          aiCredential: { findFirst: vi.fn().mockResolvedValue(null) },
          newApiGroupBinding: { findMany },
        },
        client: {},
        keyring: {},
        auth: {},
        webUrl: 'http://localhost:5173',
      } as unknown as ConstructorParameters<typeof NewApiAccountService>[0]);
      vi.spyOn(service, 'identity').mockResolvedValue({
        id: 'identity-current',
        updatedAt: new Date('2026-10-08T00:00:00Z'),
      } as Awaited<ReturnType<typeof service.identity>>);
      const settings = new NewApiAccountSettings(service);
      const models = await newApiRequestUser.run('user-current', () =>
        settings.listModels(mediaType),
      );
      expect(service.identity).toHaveBeenCalledWith('user-current');
      expect(findMany).toHaveBeenCalledWith({
        where: {
          identityId: 'identity-current',
          group: { not: '神秘分组' },
          status: { not: 'removed' },
        },
      });
      expect(models).toEqual([
        expect.objectContaining({
          id: '无限制-Flash-中配-Video',
          contract: 'newapi-video-v1',
          available: true,
          mediaTypes: ['video'],
        }),
        expect.objectContaining({
          id: '无限制-Flash-MAX-Video',
          contract: 'newapi-video-v1',
          available: true,
          mediaTypes: ['video'],
        }),
        expect.objectContaining({
          id: 'Seedance2.0 0.9r',
          credentialId: 'credential-seedance',
          group: 'default',
          contract: 'newapi-video-v1',
          available: true,
          mediaTypes: ['video'],
          capabilities: { ...capabilities, mentionMediaTypes: ['image'] },
        }),
      ]);
    },
  );
});
