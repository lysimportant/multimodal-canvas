import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import type { MediaType, ModelSelection } from '@multimodal-canvas/domain';
import { NewApiAccountService, authority } from './newapi-account-service';
import { NewApiAccountError } from './newapi-account-client';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  normalizeProviderTimeout,
  type AiSettingsStoreLike,
  type UpdateAiSettingsInput,
  type CredentialReference,
} from './settings';

/** 请求上下文隔离个人设置；无已验证用户时禁止共享连接回退。 */
export const newApiRequestUser = new AsyncLocalStorage<string>();

/** New API 本人目录的适配器；接口兼容运行模块，手工凭据写入一律退出。 */
export class NewApiAccountSettings implements AiSettingsStoreLike {
  constructor(private readonly service: NewApiAccountService) {}

  /** 所有目录与默认设置都按当前已验证内部用户读取。 */
  private userId(): string {
    const id = newApiRequestUser.getStore();
    if (!id) throw new NewApiAccountError('authentication_required', '请使用 New API 登录', 401);
    return id;
  }

  /** 获取本人偏好，不返回 Key、来源地址和指纹。 */
  async get() {
    const identity = await this.service.identity(this.userId());
    const preferences = (identity.preferences ?? {}) as {
      defaultModels?: Partial<Record<MediaType, ModelSelection>>;
      timeoutMs?: number;
    };
    return {
      configured: (await this.listCredentials()).some((entry) => entry.active),
      defaultModels: preferences.defaultModels ?? {},
      timeoutMs: preferences.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      updatedAt: identity.updatedAt.toISOString(),
    };
  }

  /** 仅更新已验证用户的个人模型默认和超时。 */
  async update(input: UpdateAiSettingsInput) {
    const identity = await this.service.identity(this.userId());
    const current = await this.get();
    const defaults = { ...current.defaultModels };
    for (const [type, selected] of Object.entries(input.defaultModels ?? {})) {
      const mediaType = type as MediaType;
      if (selected === null) delete defaults[mediaType];
      else if (selected) {
        if (typeof selected === 'string' || !selected.credentialId)
          throw new NewApiAccountError('model_unavailable', '请重新选择本人分组模型');
        const models = await this.service.models(this.userId(), mediaType, selected.credentialId);
        if (!models.some((entry) => entry.id === selected.modelAlias && entry.available))
          throw new NewApiAccountError('model_unavailable', '默认模型不可调用');
        defaults[mediaType] = {
          modelAlias: selected.modelAlias,
          credentialId: selected.credentialId,
        };
      }
    }
    await this.service.options.prisma.newApiIdentity.update({
      where: { id: identity.id },
      data: {
        preferences: {
          defaultModels: defaults,
          timeoutMs: normalizeProviderTimeout(input.timeoutMs, current.timeoutMs),
        } as Prisma.InputJsonValue,
      },
    });
    return this.get();
  }

  /** 返回本人分组的内部路由引用和同步状态，不暴露密钥材料。 */
  async listCredentials() {
    const identity = await this.service.identity(this.userId());
    const rows = await this.service.options.prisma.newApiGroupBinding.findMany({
      where: { identityId: identity.id, group: { not: '神秘分组' }, credentialId: { not: null } },
      include: { credential: true },
    });
    return rows.map((row) => ({
      id: row.credentialId!,
      version: row.credential?.version,
      active: row.status === 'active',
      group: row.group,
      status: row.status,
      error: row.error ?? undefined,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** 检查管理引用只在当前用户纳入组内有效。 */
  async hasCredential(id: string) {
    return (await this.listCredentials()).some((entry) => entry.id === id);
  }
  /** 刷新时复用所有原令牌，部分失败在账号状态中显示。 */
  async refreshModels(id?: string) {
    await this.service.synchronize(this.userId());
    return this.listModels(undefined, id);
  }
  /** 列出各组目录，同名模型不合并。 */
  async listModels(type?: MediaType, id?: string) {
    return this.service.models(this.userId(), type, id);
  }
  /** 没有唯一显式个人默认时拒绝隐式选组。 */
  async resolveModel(type: MediaType, alias?: string) {
    const models = (await this.listModels(type)).filter(
      (entry) => entry.available && (!alias || entry.id === alias),
    );
    if (models.length !== 1)
      throw new NewApiAccountError('model_unavailable', '请选择明确的分组模型');
    return models[0]!.id;
  }
  /** 按本人管理关系冻结凭据版本；不使用全站活动 Key。 */
  async getCredentialReference(
    id?: string,
  ): Promise<
    CredentialReference & { newApi: import('@multimodal-canvas/domain').NewApiExecutionAuthority }
  > {
    if (!id) throw new NewApiAccountError('credential_required', '请明确选择分组模型');
    const identity = await this.service.identity(this.userId());
    const row = await this.service.options.prisma.newApiGroupBinding.findFirst({
      where: {
        identityId: identity.id,
        credentialId: id,
        group: { not: '神秘分组' },
        status: 'active',
      },
      include: { credential: true },
    });
    if (!row?.credential || row.credential.ownerId !== identity.userId)
      throw new NewApiAccountError('credential_not_found', '分组模型不可调用', 404);
    return {
      credentialId: id,
      credentialVersion: row.credential.version,
      newApi: authority(identity, row),
    };
  }
  /** 密钥只允许服务端按本人不可变版本读取。 */
  async getProviderCredentials(reference?: CredentialReference) {
    const current = await this.getCredentialReference(reference?.credentialId);
    if (current.credentialVersion !== reference?.credentialVersion)
      throw new NewApiAccountError('credential_changed', '分组凭据版本已变化', 409);
    const row = await this.service.options.prisma.aiCredential.findFirst({
      where: {
        id: current.credentialId,
        ownerId: this.userId(),
        version: current.credentialVersion,
      },
    });
    return row
      ? {
          baseUrl: row.baseUrl,
          apiKey: this.service.options.keyring.decrypt(row.encryptedApiKey).plaintext,
        }
      : undefined;
  }
}
