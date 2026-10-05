import { describe, expect, it, vi } from 'vitest';
import { NewApiAccountClient } from './newapi-account-client';

describe('New API 分组错误边界', () => {
  it('换号提示保留固定回调及 PKCE，普通授权不增加 prompt', () => {
    const client = new NewApiAccountClient({
      issuer: 'https://newapi.example.test',
      clientId: 'canvas',
      instanceId: 'test',
      redirectUri: 'http://localhost/v1/auth/newapi/callback',
    });
    const switching = new URL(client.authorizeUrl('state', 'challenge', 'select_account'));
    expect(switching.origin).toBe('https://newapi.example.test');
    expect(switching.pathname).toBe('/api/canvas/authorize');
    expect(Object.fromEntries(switching.searchParams)).toEqual({
      client_id: 'canvas',
      instance_id: 'test',
      redirect_uri: 'http://localhost/v1/auth/newapi/callback',
      state: 'state',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    expect(new URL(client.authorizeUrl('state', 'challenge')).searchParams.has('prompt')).toBe(
      false,
    );
  });

  it.each([
    [401, 'authorization_revoked', 401],
    [403, 'authorization_revoked', 401],
    [409, 'group_changed', 409],
    [429, 'upstream_unavailable', 503],
    [503, 'upstream_unavailable', 503],
  ] as const)(
    '上游 %s 保留可恢复语义，错误不包含上游原文',
    async (upstreamStatus, code, status) => {
      const client = new NewApiAccountClient({
        issuer: 'https://newapi.example.test',
        clientId: 'canvas',
        instanceId: 'test',
        redirectUri: 'http://localhost/v1/auth/newapi/callback',
        fetchImpl: vi.fn(
          async () => new Response('synthetic-sensitive-upstream-body', { status: upstreamStatus }),
        ),
      });
      const result = client.group('synthetic-grant', 'default', 'same-operation');
      await expect(result).rejects.toMatchObject({ code, status });
      await expect(result).rejects.not.toThrow('synthetic-sensitive-upstream-body');
    },
  );

  it('已删除分组使用独立 repair 路径并冻结原 Token 版本', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://newapi.example.test/api/canvas/groups/default/repair');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        accept: 'application/json',
        authorization: 'Bearer synthetic-grant-token',
        'content-type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        operation_id: 'repair-operation',
        repair: { token_id: 17, credential_revision: 3 },
      });
      return Response.json({
        token_id: '29',
        key: 'synthetic-repaired-key',
        group: 'default',
        status: 'active',
        credential_revision: '4',
        permission_revision: '3',
        auto_groups: [],
      });
    });
    const client = new NewApiAccountClient({
      issuer: 'https://newapi.example.test',
      clientId: 'canvas',
      instanceId: 'test',
      redirectUri: 'http://localhost/v1/auth/newapi/callback',
      fetchImpl,
    });

    await expect(
      client.repairGroup('synthetic-grant-token', 'default', 'repair-operation', {
        tokenId: '17',
        revision: '3',
      }),
    ).resolves.toMatchObject({
      token_id: '29',
      key: 'synthetic-repaired-key',
      credential_revision: '4',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ['canvas_managed_token_missing', 'group_token_missing'],
    ['canvas_managed_token_group_mismatch', 'group_token_mismatch'],
  ])('明确的 %s 返回恢复目标，其它 409 仍阻断', async (remoteCode, localCode) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            code: remoteCode,
            data: { token_id: '17', credential_revision: '3' },
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ success: false, code: 'canvas_managed_token_changed' }, { status: 409 }),
      );
    const client = new NewApiAccountClient({
      issuer: 'https://newapi.example.test',
      clientId: 'canvas',
      instanceId: 'test',
      redirectUri: 'http://localhost/v1/auth/newapi/callback',
      fetchImpl,
    });
    const expected = { tokenId: '17', revision: '3' };

    await expect(
      client.repairGroup('synthetic-grant-token', 'default', 'repair-operation', expected),
    ).rejects.toMatchObject({
      code: localCode,
      status: 409,
      recovery: { tokenId: '17', revision: '3' },
    });
    await expect(
      client.repairGroup('synthetic-grant-token', 'default', 'repair-operation', expected),
    ).rejects.toMatchObject({ code: 'group_changed', status: 409 });
  });

  it('超限错误响应丢弃原文后仍保留 401 失效语义', async () => {
    const client = new NewApiAccountClient({
      issuer: 'https://newapi.example.test',
      clientId: 'canvas',
      instanceId: 'test',
      redirectUri: 'http://localhost/v1/auth/newapi/callback',
      fetchImpl: vi.fn(
        async () => new Response('synthetic-sensitive-body'.repeat(1024), { status: 401 }),
      ),
    });
    const result = client.group('synthetic-grant-token', 'default', 'operation');
    await expect(result).rejects.toMatchObject({ code: 'authorization_revoked', status: 401 });
    await expect(result).rejects.not.toThrow('synthetic-sensitive-body');
  });
});
