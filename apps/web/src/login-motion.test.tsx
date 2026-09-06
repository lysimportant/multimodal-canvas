/** 独立认证页面的导航、键盘与异步取消回归；所有 API 使用合成响应。 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import {
  clearAuthSession,
  readAuthSession,
  setUnauthorizedHandler,
  type AuthTokenResponse,
} from './auth-client';
import { navigateApp } from './routing';

/** 合成会话在所有流程测试期间保持有效，不与真实账户共享数据。 */
const session: AuthTokenResponse = {
  accessToken: 'authentication-page-test-session',
  tokenType: 'Bearer',
  expiresIn: 900,
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: {
    id: 'authentication-user',
    email: 'authentication@example.test',
    role: 'user',
    createdAt: '2026-09-06T00:00:00.000Z',
  },
};

/** 构造本地 JSON 响应，不允许回退真实业务接口。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 标准化请求路径，兼容 fetch 的三种输入形式。 */
function requestPath(input: RequestInfo | URL) {
  return new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    'http://localhost:3000',
  ).pathname;
}

/** 返回实际发生的写请求，认证跳转不应隐式创建项目。 */
function writes() {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([input]) => requestPath(input));
}

/** 从工作台的创建入口进入带明确续接目标的登录页。 */
async function openCreateLogin() {
  const actor = userEvent.setup();
  render(<App />);
  await actor.click(screen.getAllByRole('button', { name: '新建项目' })[0]!);
  await screen.findByRole('heading', { name: '登录工作台' });
  expect(window.location.pathname).toBe('/auth/login');
  expect(new URLSearchParams(window.location.search).get('next')).toBe('/workspace?create=1');
  return actor;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearAuthSession();
  window.history.replaceState(null, '', '/workspace');
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = requestPath(input);
    if (path === '/v1/projects' && (init?.method ?? 'GET') === 'GET') return json({ projects: [] });
    if ((path === '/v1/auth/login' || path === '/v1/auth/verify') && init?.method === 'POST')
      return json(session);
    if (path === '/v1/auth/register' && init?.method === 'POST')
      return json(
        {
          verificationRequired: true,
          email: session.user.email,
          delivery: { id: 'synthetic-delivery', status: 'accepted' },
        },
        202,
      );
    throw new Error(`未预期的认证页面回归请求：${init?.method ?? 'GET'} ${path}`);
  });
});

afterEach(() => {
  cleanup();
  setUnauthorizedHandler(undefined);
  clearAuthSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('独立认证页面', () => {
  it('创建入口进入独立URL，登录注册链接真正换页且不请求私有数据', async () => {
    const actor = await openCreateLogin();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('.auth-backdrop')).toBeNull();
    await actor.click(screen.getByRole('link', { name: '创建账户' }));
    expect(await screen.findByRole('heading', { name: '创建账户' })).toBeVisible();
    expect(window.location.pathname).toBe('/auth/register');
    expect(screen.getByLabelText('确认密码')).toBeVisible();
    await actor.click(screen.getByRole('link', { name: '返回登录' }));
    expect(await screen.findByRole('heading', { name: '登录工作台' })).toBeVisible();
    expect(window.location.pathname).toBe('/auth/login');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('切页和浏览器后退清理密码，不把秘密放入URL或Storage', async () => {
    const actor = await openCreateLogin();
    await actor.type(screen.getByLabelText('密码'), 'synthetic-secret-password');
    await actor.click(screen.getByRole('link', { name: '创建账户' }));
    await screen.findByRole('heading', { name: '创建账户' });
    expect(screen.getByLabelText('密码')).toHaveValue('');
    act(() => window.history.back());
    await screen.findByRole('heading', { name: '登录工作台' });
    expect(screen.getByLabelText('密码')).toHaveValue('');
    expect(window.location.href).not.toContain('synthetic-secret-password');
    expect(JSON.stringify(localStorage)).not.toContain('synthetic-secret-password');
    expect(JSON.stringify(sessionStorage)).not.toContain('synthetic-secret-password');
    expect(writes()).toEqual([]);
  });

  it('减少动态效果时仍可直接返回工作台，没有旧侧栏或退出计时', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const actor = await openCreateLogin();
    await actor.click(screen.getByRole('link', { name: '返回工作台' }));
    expect(await screen.findByRole('heading', { name: '项目工作台' })).toBeVisible();
    expect(window.location.pathname).toBe('/workspace');
    expect(document.querySelector('.auth-backdrop')).toBeNull();
    expect(document.querySelector('.mc-page-shell[inert]')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('登录阻止重复提交并只恢复一次新建表单，不自动创建项目', async () => {
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let finish!: (response: Response) => void;
    vi.mocked(globalThis.fetch).mockImplementation((input, init) =>
      requestPath(input) === '/v1/auth/login'
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(input, init),
    );
    const actor = await openCreateLogin();
    await actor.type(screen.getByLabelText('邮箱'), session.user.email);
    await actor.type(screen.getByLabelText('密码'), 'synthetic-password');
    const form = screen.getByLabelText('密码').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(writes()).toEqual(['/v1/auth/login']));
    await act(async () => {
      finish(json(session));
    });
    const createDialog = await screen.findByRole('dialog', { name: '新建项目' });
    expect(within(createDialog).getByLabelText('项目名称')).toBeEnabled();
    expect(window.location.pathname).toBe('/workspace');
    expect(new URLSearchParams(window.location.search).has('create')).toBe(false);
    expect(writes()).toEqual(['/v1/auth/login']);
  });

  it('页面键盘遵循普通Tab顺序，IME Enter不提交且Escape不假装关闭弹层', async () => {
    const actor = await openCreateLogin();
    const email = screen.getByLabelText('邮箱');
    email.focus();
    await actor.tab();
    expect(screen.getByLabelText('密码')).toHaveFocus();
    fireEvent.keyDown(screen.getByLabelText('密码'), {
      key: 'Enter',
      keyCode: 229,
      isComposing: true,
    });
    await actor.keyboard('{Escape}');
    expect(window.location.pathname).toBe('/auth/login');
    expect(screen.getByRole('heading', { name: '登录工作台' })).toBeVisible();
    expect(writes()).toEqual([]);
    const returnLink = screen.getByRole('link', { name: '返回工作台' });
    returnLink.focus();
    expect(returnLink).toHaveFocus();
  });

  it('注册确认密码一致后才POST，验证码确认直接进入工作台并丢弃创建意图', async () => {
    const actor = await openCreateLogin();
    await actor.click(screen.getByRole('link', { name: '创建账户' }));
    await screen.findByRole('heading', { name: '创建账户' });
    await actor.type(screen.getByLabelText('邮箱'), session.user.email);
    await actor.type(screen.getByLabelText('密码'), 'synthetic-password');
    await actor.type(screen.getByLabelText('确认密码'), 'different-password');
    await actor.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/一致/);
    expect(writes()).toEqual([]);
    await actor.clear(screen.getByLabelText('确认密码'));
    await actor.type(screen.getByLabelText('确认密码'), 'synthetic-password');
    await actor.click(screen.getByRole('button', { name: '注册' }));
    await screen.findByRole('heading', { name: '验证你的邮箱' });
    expect(window.location.pathname).toBe('/auth/verify');
    expect(readAuthSession()).toBeNull();
    await actor.type(screen.getByLabelText('邮箱验证码'), '123456');
    await actor.click(screen.getByRole('button', { name: '确认' }));
    expect(await screen.findByRole('heading', { name: '项目工作台' })).toBeVisible();
    expect(window.location.pathname).toBe('/workspace');
    expect(window.location.search).toBe('');
    expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument();
    expect(writes()).toEqual(['/v1/auth/register', '/v1/auth/verify']);
    expect(JSON.stringify(localStorage)).not.toContain('123456');
    expect(JSON.stringify(sessionStorage)).not.toContain('123456');
  });

  it.each(['login', 'verify'] as const)(
    '离开%s页面取消在途认证，晚到成功响应不能重新登录或跳页',
    async (page) => {
      const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
      let finish!: (response: Response) => void;
      let signal: AbortSignal | null | undefined;
      vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
        if (requestPath(input) === `/v1/auth/${page}`) {
          signal = init?.signal;
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return original(input, init);
      });
      window.history.replaceState(
        null,
        '',
        page === 'login'
          ? '/auth/login?next=%2Fworkspace%3Fcreate%3D1'
          : `/auth/verify?email=${encodeURIComponent(session.user.email)}&purpose=register`,
      );
      const actor = userEvent.setup();
      render(<App />);
      if (page === 'login') {
        await screen.findByRole('heading', { name: '登录工作台' });
        await actor.type(screen.getByLabelText('邮箱'), session.user.email);
        await actor.type(screen.getByLabelText('密码'), 'synthetic-password');
      } else {
        await screen.findByRole('heading', { name: '验证你的邮箱' });
        await actor.type(screen.getByLabelText('邮箱验证码'), '123456');
      }
      await actor.click(screen.getByRole('button', { name: page === 'login' ? '登录' : '确认' }));
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      act(() => navigateApp('/workspace', { transition: false }));
      await screen.findByRole('heading', { name: '项目工作台' });
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        finish(json(session));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(window.location.pathname).toBe('/workspace');
      expect(readAuthSession()).toBeNull();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(writes()).toEqual([`/v1/auth/${page}`]);
    },
  );

  it('完整App重发验证码清理投递标记时保留验证码和60秒倒计时，不能立即重复发送', async () => {
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation((input, init) =>
      requestPath(input) === '/v1/auth/verification/resend'
        ? Promise.resolve(json({ delivery: { id: 'synthetic-resend', status: 'queued' } }))
        : original(input, init),
    );
    window.history.replaceState(
      null,
      '',
      `/auth/verify?email=${encodeURIComponent(session.user.email)}&purpose=register&delivery=failed`,
    );
    const actor = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: '验证你的邮箱' });
    await actor.type(screen.getByLabelText('邮箱验证码'), '123456');
    await actor.click(screen.getByRole('button', { name: '重新发送验证码' }));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).has('delivery')).toBe(false),
    );
    expect(window.location.pathname).toBe('/auth/verify');
    expect(screen.getByLabelText('邮箱验证码')).toHaveValue('123456');
    const resend = screen.getByRole('button', { name: '60 秒后可重发' });
    expect(resend).toBeDisabled();
    await actor.click(resend);
    expect(writes()).toEqual(['/v1/auth/verification/resend']);
    expect(readAuthSession()).toBeNull();
    expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body))).toEqual({
      email: session.user.email,
      purpose: 'register',
    });
  });
});
