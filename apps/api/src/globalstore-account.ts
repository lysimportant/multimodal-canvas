import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GLOBALSTORE_IMAGE_CONTRACT, GLOBALSTORE_VIDEO_CONTRACT } from '@multimodal-canvas/domain';
import {
  CredentialEncryptionKeyring,
  normalizeProviderAssetEndpoint,
} from '@multimodal-canvas/credential-crypto';
import type { AiCredential, PrismaClient } from '@prisma/client';
import { NewApiAccountError } from './newapi-account-client';
import type { ModelCatalogEntry } from './settings';

/** Model Center 没有 OpenAI 模型发现端点，目录由本人明确登记。 */
export const globalStoreCatalogSchema = z
  .array(
    z
      .object({
        id: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
        // 旧账号目录只有 id；其历史语义一直是图片模型。
        mediaType: z.enum(['image', 'video']).default('image'),
      })
      .strict(),
  )
  .min(1)
  .max(100);

export const globalStoreSettingsSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(2048),
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .regex(/^[^\r\n\x00-\x1f\x7f]+$/),
    models: globalStoreCatalogSchema,
  })
  .strict();

/** 只接受公网 HTTPS，路径限定为 Model Center 基址，统一到文档中的任务 API。 */
export function normalizeGlobalStoreBaseUrl(value: string): string {
  try {
    const url = new URL(normalizeProviderAssetEndpoint(value));
    const path = url.pathname.replace(/\/+$/, '');
    if (
      ![
        '',
        '/kyyReactApiServer',
        '/v2/model-center',
        '/kyyReactApiServer/v2/model-center',
      ].includes(path)
    )
      throw new Error();
    return `${url.origin}/kyyReactApiServer/v2/model-center`;
  } catch {
    throw new NewApiAccountError(
      'invalid_globalstore_configuration',
      '请填写有效的 GlobalStore HTTPS Model Center 地址',
    );
  }
}

/** 将非敏感持久目录转换为统一画布目录；不返回 Key 或密文。 */
export function globalStoreModels(credential: AiCredential): ModelCatalogEntry[] {
  const catalog = globalStoreCatalogSchema.safeParse(credential.modelCatalog);
  if (!catalog.success || credential.provider !== 'globalstore') return [];
  return catalog.data.map((entry) => ({
    id: entry.id,
    name: entry.id,
    mediaTypes: [entry.mediaType],
    provider: 'globalstore',
    credentialId: credential.id,
    group: 'GlobalStore Model Center',
    contract: entry.mediaType === 'video' ? GLOBALSTORE_VIDEO_CONTRACT : GLOBALSTORE_IMAGE_CONTRACT,
    available: true,
    capabilities: { mentionMediaTypes: [] },
    limitations: {
      note:
        entry.mediaType === 'image'
          ? '支持图片参考连线；暂不支持提示词内素材提及。'
          : '视频生成暂不支持提示词内素材提及。',
    },
    refreshedAt: credential.updatedAt.toISOString(),
  }));
}

/** 本人凭据不可变新增；旧记录继续服务历史任务与轮询恢复。 */
export class GlobalStoreAccount {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly keyring: CredentialEncryptionKeyring,
  ) {}

  async credential(userId: string, credentialId?: string): Promise<AiCredential | null> {
    return this.prisma.aiCredential.findFirst({
      where: {
        ownerId: userId,
        projectId: null,
        provider: 'globalstore',
        ...(credentialId ? { id: credentialId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** 返回本人全部 GlobalStore 凭据；无范围目录必须保留每个凭据的模型身份。 */
  async credentials(userId: string): Promise<AiCredential[]> {
    // Keep lightweight in-memory settings fixtures compatible with the Prisma boundary.
    if (typeof this.prisma.aiCredential.findMany !== 'function') {
      const latest = await this.credential(userId);
      return latest ? [latest] : [];
    }
    return this.prisma.aiCredential.findMany({
      where: { ownerId: userId, projectId: null, provider: 'globalstore' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async get(userId: string) {
    const credential = await this.credential(userId);
    return credential
      ? {
          credentialId: credential.id,
          baseUrl: credential.baseUrl,
          models: globalStoreModels(credential),
        }
      : { models: [] };
  }

  async save(userId: string, input: z.infer<typeof globalStoreSettingsSchema>) {
    const parsed = globalStoreSettingsSchema.safeParse(input);
    if (!parsed.success)
      throw new NewApiAccountError(
        'invalid_globalstore_configuration',
        '请填写地址、Key 和精确的图片或视频模型 ID',
      );
    const baseUrl = normalizeGlobalStoreBaseUrl(parsed.data.baseUrl);
    const models = [
      ...new Map(
        parsed.data.models.map((entry) => [`${entry.id}:${entry.mediaType}`, entry]),
      ).values(),
    ];
    const credential = await this.prisma.aiCredential.create({
      data: {
        ownerId: userId,
        provider: 'globalstore',
        label: 'GlobalStore Model Center',
        baseUrl,
        encryptedApiKey: this.keyring.encrypt(parsed.data.apiKey),
        encryptionKeyId: this.keyring.currentKeyId,
        keyFingerprint: createHash('sha256').update(parsed.data.apiKey).digest('hex'),
        modelCatalog: models,
      },
    });
    return { credentialId: credential.id, models: globalStoreModels(credential) };
  }
}
