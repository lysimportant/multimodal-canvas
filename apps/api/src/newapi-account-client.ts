import { z } from 'zod';

/** 账号接入只接受部署者固定的站点，禁止用户输入任意代理地址。 */
export function normalizeNewApiIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NewApiAccountError('invalid_configuration', 'New API 站点配置无效', 503);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new NewApiAccountError('invalid_configuration', 'New API 站点配置无效', 503);
  return url.toString().replace(/\/+$/, '');
}

/** 上游拒绝与暂时不可用明确区分；错误不包含响应正文或凭据。 */
export class NewApiAccountError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'NewApiAccountError';
  }
}

/** 已验证的不可变用户身份，邮箱只是可选展示资料。 */
export const newApiAccountUserSchema = z.object({
  id: z.coerce.string().min(1),
  display_name: z.string().max(1024).optional(),
  email: z.string().max(512).optional(),
  status: z.literal('active'),
});

/** 受限授权只保存在加密的服务端记录，不返回浏览器。 */
export const newApiGrantSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(16),
  expires_at: z.string().datetime(),
  scopes: z.array(z.string()),
});

/** 首次登录交换的权威事实。 */
export const newApiLoginResultSchema = z.object({
  issuer: z.string(),
  user: newApiAccountUserSchema,
  grant: newApiGrantSchema,
});

/** 同步先读取本人可用组，排除项在任何 Key 请求之前过滤。 */
export const newApiAccountStateSchema = z.object({
  user: newApiAccountUserSchema,
  grant_id: z.string().min(1),
  groups: z.array(z.string().min(1)).max(1024),
});

/** 同组管理关系只能恢复原令牌；权限修订不包含余额和价格变动。 */
export const newApiManagedGroupSchema = z.object({
  token_id: z.coerce.string().min(1),
  key: z.string().min(1),
  group: z.string().min(1),
  status: z.literal('active'),
  credential_revision: z.coerce.string().min(1),
  permission_revision: z.coerce.string().min(1),
  auto_groups: z.array(z.string()).default([]),
});

/** 目录合同不依赖 Canvas 人民币换算字段；available=false 始终不可执行。 */
export const accountCatalogSchema = z.object({
  models: z
    .array(
      z.object({
        id: z.string().min(1).max(512),
        name: z.string().optional(),
        media_type: z.enum(['text', 'image', 'audio', 'video']).optional(),
        contract: z.string().min(1).optional(),
        available: z.boolean(),
        unavailable_reason: z.string().optional(),
        capabilities: z.record(z.unknown()).optional(),
        limitations: z.record(z.unknown()).optional(),
        input_media_types: z.array(z.enum(['text', 'image', 'audio', 'video'])).optional(),
      }),
    )
    .max(20000),
});

/** 桥接传输只连接固定站点，禁止重定向、重试及超限正文。 */
export class NewApiAccountClient {
  readonly issuer: string;
  constructor(
    readonly options: {
      issuer: string;
      clientId: string;
      instanceId: string;
      redirectUri: string;
      clientSecret?: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.issuer = normalizeNewApiIssuer(options.issuer);
    normalizeNewApiIssuer(options.redirectUri);
    if (new URL(options.redirectUri).pathname !== '/v1/auth/newapi/callback')
      throw new NewApiAccountError('invalid_configuration', 'New API 回调地址不匹配', 503);
  }

  /** 构造授权跳转；不在 URL 中携带长期授权。 */
  authorizeUrl(state: string, challenge: string): string {
    const url = new URL(`${this.issuer}/api/canvas/authorize`);
    for (const [key, value] of Object.entries({
      client_id: this.options.clientId,
      instance_id: this.options.instanceId,
      redirect_uri: this.options.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value);
    return url.toString();
  }

  /** 一次性授权码交换；网络结果未知不会自动重试。 */
  async exchange(code: string, verifier: string) {
    return newApiLoginResultSchema.parse(
      await this.request('/api/canvas/token', 'POST', undefined, {
        code,
        code_verifier: verifier,
        client_id: this.options.clientId,
        instance_id: this.options.instanceId,
        redirect_uri: this.options.redirectUri,
        ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
      }),
    );
  }

  /** 校验当前授权以及本人资格，禁止从公开分组清单推断权限。 */
  async account(token: string) {
    return newApiAccountStateSchema.parse(await this.request('/api/canvas/account', 'GET', token));
  }

  /** 上游必须以原 operation_id 事务创建或恢复，不能先查名称再创建。 */
  async group(token: string, group: string, operationId: string) {
    if (group === '神秘分组')
      throw new NewApiAccountError('excluded_group', '该分组不参与画布接入');
    return newApiManagedGroupSchema.parse(
      await this.request(`/api/canvas/groups/${encodeURIComponent(group)}`, 'PUT', token, {
        operation_id: operationId,
      }),
    );
  }

  /** 每个 Key 读取本人目录，不执行公开价格导入或生成。 */
  async catalog(key: string) {
    return accountCatalogSchema.parse(await this.request('/v1/canvas/catalog', 'GET', key));
  }

  /** 明确撤销 grant 及其派生权限，上游必须限制在本实例拥有的管理关系内。 */
  async revoke(token: string) {
    await this.request('/api/canvas/revoke', 'POST', token, {});
  }

  /** 有界 JSON 读取；拒绝跨站跳转及包含不可信上游原文的异常。 */
  private async request(
    path: string,
    method: string,
    token?: string,
    body?: unknown,
  ): Promise<unknown> {
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.issuer}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok)
        throw new NewApiAccountError(
          response.status === 401 || response.status === 403
            ? 'authorization_revoked'
            : response.status === 409
              ? 'group_changed'
              : 'upstream_unavailable',
          response.status === 401 || response.status === 403
            ? 'New API 授权已失效，请重新授权'
            : response.status === 409
              ? 'New API 分组令牌或权限已变化，请在上游核对后重新授权'
              : 'New API 暂不可用，请稍后刷新',
          response.status === 401 || response.status === 403
            ? 401
            : response.status === 409
              ? 409
              : 503,
        );
      if (!response.body) throw new Error('missing body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 5 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('response too large');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value?.success === false)
        throw new NewApiAccountError('upstream_rejected', 'New API 拒绝当前授权操作', 409);
      return value?.success === true && value.data !== undefined ? value.data : value;
    } catch (error) {
      if (error instanceof NewApiAccountError) throw error;
      throw new NewApiAccountError('upstream_unavailable', 'New API 联动暂不可用或合同不匹配', 503);
    }
  }
}
