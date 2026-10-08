import { describe, expect, it, vi } from 'vitest';
import { NewApiAccountService } from './newapi-account-service';
import { NewApiAccountSettings, newApiRequestUser } from './newapi-account-settings';

describe('New API 本人缓存模型目录', () => {
  it.each([undefined, 'video'] as const)(
    '实际设置入口过滤中配缓存，保留精确 MAX 与 Seedance 声明：%s',
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
