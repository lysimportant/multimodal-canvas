import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiFetch,
  clearAuthSession,
  getAuthToken,
  persistAuthSession,
  readAuthSession,
  setUnauthorizedHandler,
  type AuthTokenResponse,
} from './auth-client';

const response: AuthTokenResponse = {
  accessToken: 'jwt-test-token',
  tokenType: 'Bearer',
  expiresIn: 900,
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  user: {
    id: 'user-1',
    email: 'user@example.com',
    role: 'user',
    createdAt: new Date().toISOString(),
  },
};

describe('auth-client', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAuthSession();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setUnauthorizedHandler(undefined);
    clearAuthSession();
  });

  it('persists and restores a non-expired session without exposing the password', () => {
    persistAuthSession(response);
    expect(getAuthToken()).toBe('jwt-test-token');
    expect(readAuthSession()).toMatchObject({
      accessToken: 'jwt-test-token',
      user: { email: 'user@example.com' },
    });
    expect(localStorage.getItem('multimodal-canvas:auth-session')).not.toContain('password');
  });

  it('adds a Bearer header and clears the session on 401', async () => {
    persistAuthSession(response);
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'authentication required' }), { status: 401 }),
      );

    const result = await apiFetch('http://localhost:3000/v1/projects');
    expect(result.status).toBe(401);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const headers = fetcher.mock.calls[0]?.[1]?.headers;
    expect(new Headers(headers).get('authorization')).toBe('Bearer jwt-test-token');
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(getAuthToken()).toBeUndefined();
  });

  it('does not notify the app for an intentionally skipped 401', async () => {
    persistAuthSession(response);
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));

    await apiFetch(
      'http://localhost:3000/v1/auth/logout',
      { method: 'POST' },
      { skipUnauthorized: true },
    );
    expect(unauthorized).not.toHaveBeenCalled();
    expect(getAuthToken()).toBe('jwt-test-token');
  });

  it('drops expired sessions', () => {
    persistAuthSession({
      ...response,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(readAuthSession()).toBeNull();
    expect(localStorage.getItem('multimodal-canvas:auth-session')).toBeNull();
  });
});
