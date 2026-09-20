/** 管理 API 的 Cookie 会话、响应和路径边界回归。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../auth-client';
import { managementRequest, ManagementError, queryString, type ManagedUser } from './client';

vi.mock('../auth-client', async (original) => ({
  ...(await original<typeof import('../auth-client')>()),
  apiFetch: vi.fn(),
}));

/** New API 身份可以没有邮箱，资源归属始终依赖不可变用户 ID。 */
const userWithoutEmail: ManagedUser = {
  id: 'owner-without-email',
  displayName: '无邮箱用户',
  role: 'user',
  status: 'active',
  createdAt: '2026-09-21T00:00:00.000Z',
};

afterEach(() => vi.mocked(apiFetch).mockReset());

describe('managementRequest', () => {
  it('通过站内 /v1 路径携带 Cookie 会话并序列化 JSON', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ user: userWithoutEmail }));

    await expect(
      managementRequest<{ user: ManagedUser }>('/admin/resource-owners/owner-without-email', {
        method: 'POST',
        body: { ownerId: userWithoutEmail.id },
      }),
    ).resolves.toEqual({ user: userWithoutEmail });

    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(
      'http://localhost:3000/v1/admin/resource-owners/owner-without-email',
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerId: userWithoutEmail.id }),
        signal: undefined,
      },
      { skipUnauthorized: undefined },
    );
  });

  it('204 不读取 JSON，成功写入不会被误报为解析失败', async () => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, 'json');
    vi.mocked(apiFetch).mockResolvedValue(response);

    await expect(
      managementRequest('/account/resources/resource-a', { method: 'DELETE' }),
    ).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('保留服务端错误和 HTTP 状态，缺少错误正文时使用状态回退', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(Response.json({ error: '没有资源管理权限' }, { status: 403 }))
      .mockResolvedValueOnce(new Response('gateway failure', { status: 502 }));

    await expect(managementRequest('/admin/resources')).rejects.toMatchObject({
      message: '没有资源管理权限',
      status: 403,
    });
    await expect(managementRequest('/admin/resources')).rejects.toMatchObject({
      message: '请求失败（502）',
      status: 502,
    });
  });

  it('成功响应不是合法 JSON 时明确失败', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('not json', { status: 200 }));

    await expect(managementRequest('/account/resources')).rejects.toEqual(
      expect.objectContaining<Partial<ManagementError>>({
        message: '服务返回了无法解析的数据，请重试',
        status: 200,
      }),
    );
  });

  it.each(['admin/resources', '//external.example.test/path'])(
    '拒绝非站内绝对 API 路径 %s',
    async (path) => {
      await expect(managementRequest(path)).rejects.toThrow('无效的接口路径');
      expect(apiFetch).not.toHaveBeenCalled();
    },
  );
});

describe('queryString', () => {
  it('编码有效筛选并省略空值', () => {
    expect(queryString({ query: '甲 & 乙', page: 2, empty: '', absent: undefined })).toBe(
      '?query=%E7%94%B2+%26+%E4%B9%99&page=2',
    );
    expect(queryString({ query: '', page: undefined })).toBe('');
  });
});
