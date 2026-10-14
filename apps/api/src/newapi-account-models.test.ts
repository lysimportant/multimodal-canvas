import { describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiAccountService } from './newapi-account-service';
import { NewApiAccountSettings, newApiRequestUser } from './newapi-account-settings';

describe('New API 本人缓存模型目录', () => {
  it.each([
    ['gemini-3-pro-image-preview', 'openai-images', 'openai-chat-completions'],
    ['gemini-nano-banana-2.1', undefined, 'openai-chat-completions'],
    ['imagen-4.0-generate-001', 'openai-images', 'openai-images'],
  ] as const)('为 %s 冻结正确的图片执行协议', async (modelAlias, catalogContract, expected) => {
    const service = new NewApiAccountService({
      prisma: {},
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
    expect((await service.freeze('user', snapshot)).executionBindings?.image?.contract).toBe(
      expected,
    );
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
      prisma: { newApiGroupBinding: { findMany } },
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
        prisma: { newApiGroupBinding: { findMany } },
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
