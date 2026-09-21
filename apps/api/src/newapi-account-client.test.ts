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
});
