import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  fetchCurrentSession,
  refreshAuthSession,
  clearAuthSession,
  persistAuthSession,
  readAuthSession,
  AuthSessionChangedError,
  apiFetch,
} from './auth-client';
const user = { id: 'account-a', role: 'user' as const, createdAt: '2026-09-21T00:00:00Z' };
const session = { user, expiresAt: '2099-01-01T00:00:00Z' };
/** 模拟响应正文迟于账号切换完成；不调用真实认证接口。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => clearAuthSession());
afterEach(() => {
  clearAuthSession();
  vi.unstubAllGlobals();
});
describe('Cookie 认证的迟到响应隔离', () => {
  it.each(['restore', 'refresh'])('%s 的旧正文不能覆盖新账号', async (kind) => {
    persistAuthSession(session);
    const body = deferred<unknown>();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => body.promise }),
    );
    const pending = kind === 'restore' ? fetchCurrentSession('') : refreshAuthSession('');
    const rejected = expect(pending).rejects.toBeInstanceOf(AuthSessionChangedError);
    await Promise.resolve();
    await Promise.resolve();
    persistAuthSession({ ...session, user: { ...user, id: 'account-b' } });
    body.resolve(session);
    await rejected;
    expect(readAuthSession()?.user.id).toBe('account-b');
  });
  it('续期等待期间退出，禁止继续发出业务 POST', async () => {
    persistAuthSession({ ...session, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const body = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(body.promise);
    vi.stubGlobal('fetch', fetcher);
    const pending = apiFetch('/v1/projects', { method: 'POST' });
    const rejected = expect(pending).rejects.toBeInstanceOf(AuthSessionChangedError);
    clearAuthSession();
    body.resolve(Response.json(session));
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/auth/refresh');
  });
});
