/** 管理 API 请求的响应契约与凭据传递回归。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiFetch,
  clearAuthSession,
  persistAuthSession,
  readAuthSession,
  type AuthTokenResponse,
} from '../auth-client';
import {
  managementRequest,
  ManagementError,
  queryString,
  updateStoredUser,
  verifyAccount,
} from './client';

vi.mock('../auth-client', async (original) => {
  const actual = await original<typeof import('../auth-client')>();
  return { ...actual, apiFetch: vi.fn(), persistAuthSession: vi.fn(actual.persistAuthSession) };
});

/** 延迟会话测试只使用合成身份和令牌。 */
function sessionResponse(id: string, token: string): AuthTokenResponse {
  return {
    accessToken: token,
    tokenType: 'Bearer',
    expiresIn: 900,
    expiresAt: '2099-01-01T00:00:00.000Z',
    user: {
      id,
      email: `${id}@example.test`,
      displayName: id,
      role: 'user',
      createdAt: '2026-09-06T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  clearAuthSession();
  window.localStorage.clear();
  vi.mocked(persistAuthSession).mockClear();
});

afterEach(() => vi.mocked(apiFetch).mockReset());

describe('异步管理结果的会话隔离', () => {
  it.each(['logout', 'replace', 'refresh'] as const)(
    '验证码请求期间发生 %s 时拒绝晚到会话',
    async (change) => {
      persistAuthSession(sessionResponse('user-a', 'session-a'));
      let finish!: (response: Response) => void;
      vi.mocked(apiFetch).mockReturnValue(
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      );
      const pending = verifyAccount({
        email: 'user-a@example.test',
        code: '123456',
        purpose: 'register',
      });
      if (change === 'logout') clearAuthSession();
      else
        persistAuthSession(
          sessionResponse(change === 'replace' ? 'user-b' : 'user-a', 'later-session'),
        );
      const savedBeforeResponse = vi.mocked(persistAuthSession).mock.calls.length;
      finish(new Response(JSON.stringify(sessionResponse('user-a', 'late-session'))));
      await expect(pending).rejects.toMatchObject({
        message: '账户状态已改变，请在当前账户中重新操作',
        status: 409,
      });
      expect(persistAuthSession).toHaveBeenCalledTimes(savedBeforeResponse);
      expect(readAuthSession()?.accessToken ?? null).toBe(
        change === 'logout' ? null : 'later-session',
      );
    },
  );

  it('会话未变化时正常消费验证码并保存新令牌', async () => {
    const response = sessionResponse('user-a', 'verified-session');
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(response)));
    const verified = await verifyAccount({
      email: response.user.email,
      code: '123456',
      purpose: 'register',
    });
    expect(verified.accessToken).toBe('verified-session');
    expect(persistAuthSession).toHaveBeenCalledExactlyOnceWith(response);
    expect(readAuthSession()?.user.id).toBe('user-a');
  });

  it('旧用户资料不得合并进后来账户的访问令牌', () => {
    persistAuthSession(sessionResponse('user-b', 'session-b'));
    const oldUser = {
      ...sessionResponse('user-a', 'unused').user,
      status: 'active',
      displayName: '旧账户保存结果',
    };
    expect(() => updateStoredUser(oldUser)).toThrow('账户状态已改变');
    expect(persistAuthSession).toHaveBeenCalledTimes(1);
    expect(readAuthSession()).toMatchObject({
      accessToken: 'session-b',
      user: { id: 'user-b', displayName: 'user-b' },
    });
  });

  it('同一用户的资料更新保留当前访问令牌和到期时间', () => {
    const initial = sessionResponse('user-a', 'current-session');
    persistAuthSession(initial);
    const updated = updateStoredUser({ ...initial.user, status: 'active', displayName: '新昵称' });
    expect(updated).toMatchObject({
      accessToken: initial.accessToken,
      expiresAt: initial.expiresAt,
      user: { id: 'user-a', displayName: '新昵称' },
    });
  });
});

describe('managementRequest', () => {
  it('204 没有 JSON 请求体，不把已成功写入误报为解析失败', async () => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, 'json');
    vi.mocked(apiFetch).mockResolvedValue(response);
    await expect(
      managementRequest('/account/sessions/session-a', { method: 'DELETE' }),
    ).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('保留服务器校验错误与 HTTP 状态', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: '邮箱已经被使用' }), { status: 409 }),
    );
    await expect(
      managementRequest('/admin/users', {
        method: 'POST',
        body: { email: 'someone@example.test' },
      }),
    ).rejects.toMatchObject({ message: '邮箱已经被使用', status: 409 });
  });

  it('无法解析的成功响应明确失败，不虚报提交成功', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('gateway response', { status: 200 }));
    await expect(managementRequest('/account/profile')).rejects.toBeInstanceOf(ManagementError);
  });

  it('公共验证失败不能触发当前会话注销，密码不进入 URL', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ verified: true }), { status: 200 }),
    );
    await managementRequest('/auth/verify', {
      method: 'POST',
      body: { code: '123456', password: 'synthetic-password' },
      public: true,
    });
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/auth\/verify$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: '123456', password: 'synthetic-password' }),
      }),
      { skipUnauthorized: true },
    );
  });

  it('拒绝非站内 API 路径，并按 URL 规则编码筛选条件', async () => {
    await expect(managementRequest('//external.example.test/path')).rejects.toThrow(
      '无效的接口路径',
    );
    expect(apiFetch).not.toHaveBeenCalled();
    expect(queryString({ query: '甲 & 乙', page: 2, empty: '', absent: undefined })).toBe(
      '?query=%E7%94%B2+%26+%E4%B9%99&page=2',
    );
  });
});
