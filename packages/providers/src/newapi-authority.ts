import type { RunExecutionBinding } from '@multimodal-canvas/domain';

/** Worker 首次发送前复核已冻结的本人分组；不会产生供应商生成请求或修改原管理操作身份。 */
export async function verifyNewApiExecutionAuthority(input: {
  binding: RunExecutionBinding;
  grant: string;
  apiKey: string;
  operationId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { authority } = input.binding;
  const issuer = new URL(authority.issuer);
  if (
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    !['https:', 'http:'].includes(issuer.protocol) ||
    (issuer.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)) ||
    authority.group === '神秘分组'
  )
    throw new Error('New API 执行站点或分组无效');
  const origin = authority.issuer.replace(/\/$/, '');
  const account = await readAuthorityResponse(
    input.fetchImpl ?? fetch,
    `${origin}/api/canvas/account`,
    input.grant,
  );
  const user = record(account.user);
  if (
    String(user.id) !== authority.externalUserId ||
    user.status !== 'active' ||
    account.grant_id !== authority.grantId ||
    !Array.isArray(account.groups) ||
    !account.groups.includes(authority.group)
  )
    throw new Error('New API 账号或分组授权已变化');

  const managed = await readAuthorityResponse(
    input.fetchImpl ?? fetch,
    `${origin}/api/canvas/groups/${encodeURIComponent(authority.group)}`,
    input.grant,
    { operation_id: input.operationId },
  );
  if (
    String(managed.token_id) !== authority.tokenId ||
    managed.group !== authority.group ||
    managed.status !== 'active' ||
    managed.key !== input.apiKey ||
    String(managed.credential_revision) !== authority.credentialRevision ||
    String(managed.permission_revision) !== authority.permissionRevision ||
    !Array.isArray(managed.auto_groups) ||
    JSON.stringify(managed.auto_groups) !== JSON.stringify(authority.autoGroups) ||
    managed.auto_groups.includes('神秘分组')
  )
    throw new Error('New API 令牌、实际分组或权限修订已变化');

  const catalog = await readAuthorityResponse(
    input.fetchImpl ?? fetch,
    `${origin}/v1/canvas/catalog`,
    input.apiKey,
  );
  const models = Array.isArray(catalog.models)
    ? catalog.models.map(record).filter((model) => model.id === input.binding.modelAlias)
    : [];
  if (
    models.length !== 1 ||
    models[0]!.available !== true ||
    models[0]!.media_type !== input.binding.mediaType ||
    models[0]!.contract !== input.binding.contract
  )
    throw new Error('New API 精确模型或输入协议已变化');
}

/** 仅接收对象字段，坏响应不会被转换成可用权限。 */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('New API 权限响应格式无效');
  return value as Record<string, unknown>;
}

/** 有界读取受信站点响应；禁止重定向和自动重试，异常不回显凭据或上游正文。 */
async function readAuthorityResponse(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  body?: { operation_id: string },
): Promise<Record<string, unknown>> {
  try {
    const response = await fetchImpl(url, {
      method: body ? 'PUT' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok || !response.body) throw new Error('authority unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 5 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('authority response too large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const payload = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (payload.success === false) throw new Error('authority rejected');
    return payload.success === true ? record(payload.data) : payload;
  } catch {
    throw new Error('New API 执行资格复核失败，请刷新账号后重试');
  }
}
