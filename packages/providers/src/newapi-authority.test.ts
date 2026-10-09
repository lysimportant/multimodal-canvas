import { describe, expect, it, vi } from 'vitest';
import type { RunExecutionBinding } from '@multimodal-canvas/domain';
import { verifyNewApiExecutionAuthority } from './newapi-authority';

/** 只使用合成授权响应；不访问 New API 或执行模型请求。 */
function fixture() {
  const binding: RunExecutionBinding = {
    credentialId: 'credential-1',
    credentialVersion: 1,
    modelAlias: 'new-unlisted-model',
    mediaType: 'video',
    contract: 'custom-upstream-contract',
    authority: {
      issuer: 'https://newapi.example',
      externalUserId: 'user-1',
      instanceId: 'canvas',
      grantId: 'grant-1',
      tokenId: 'token-1',
      credentialRevision: 'key-revision-1',
      group: 'default',
      permissionRevision: 'permission-1',
      autoGroups: ['default'],
    },
  };
  const account = {
    user: { id: 'user-1', status: 'active' },
    grant_id: 'grant-1',
    groups: ['default'],
  };
  const managed = {
    token_id: 'token-1',
    group: 'default',
    status: 'active',
    key: 'synthetic-api-key',
    credential_revision: 'key-revision-1',
    permission_revision: 'permission-1',
    auto_groups: ['default'],
  };
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/canvas/account') return Response.json(account);
    if (path === '/api/canvas/groups/default') return Response.json(managed);
    throw new Error('Unexpected catalog or model request');
  });
  const input = {
    binding,
    grant: 'synthetic-grant',
    apiKey: 'synthetic-api-key',
    operationId: 'operation-1',
    fetchImpl,
  };
  return { input, account, managed, fetchImpl };
}

describe('New API 执行身份复核', () => {
  it('未知模型和合同只复核账号与令牌，不再次请求目录判定能力', async () => {
    const { input, fetchImpl } = fixture();
    await expect(verifyNewApiExecutionAuthority(input)).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/canvas/account',
      '/api/canvas/groups/default',
    ]);
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe('{"operation_id":"operation-1"}');
  });

  it.each(['owner', 'grant', 'group'] as const)('账号 %s 已变化时阻止旧凭据发送', async (field) => {
    const { input, account, fetchImpl } = fixture();
    if (field === 'owner') account.user.id = 'other-user';
    if (field === 'grant') account.grant_id = 'other-grant';
    if (field === 'group') account.groups = [];
    await expect(verifyNewApiExecutionAuthority(input)).rejects.toThrow('账号或分组授权已变化');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['token_id', 'key', 'credential_revision', 'permission_revision'] as const)(
    '令牌 %s 已变化时仍拒绝执行',
    async (field) => {
      const { input, managed } = fixture();
      managed[field] = 'changed';
      await expect(verifyNewApiExecutionAuthority(input)).rejects.toThrow(
        '令牌、实际分组或权限修订已变化',
      );
    },
  );
});
