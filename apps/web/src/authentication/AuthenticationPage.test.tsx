/** 独立认证页面的表单验证、跳转回调和取消边界；请求均为合成数据。 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailVerificationRequired, login, register, type StoredAuthSession } from '../auth-client';
import { managementRequest, verifyAccount } from '../management/client';
import { VerificationForm } from '../management/AccountPages';
import { AuthenticationPage, type AuthenticationPageProps } from './AuthenticationPage';

vi.mock('../auth-client', async (original) => ({
  ...(await original<typeof import('../auth-client')>()),
  login: vi.fn(),
  register: vi.fn(),
}));
vi.mock('../management/client', async (original) => ({
  ...(await original<typeof import('../management/client')>()),
  managementRequest: vi.fn(),
  verifyAccount: vi.fn(),
}));

/** 测试会话没有真实凭据，所有成功跳转仍由父组件回调负责。 */
const session: StoredAuthSession = {
  accessToken: 'synthetic-auth-page-session',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: {
    id: 'auth-page-user',
    email: 'page@example.test',
    role: 'user',
    createdAt: '2026-09-06T00:00:00.000Z',
  },
};

/** 手动推进忽略取消信号的请求，验证页面不会接纳迟到结果。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 为页面提供最小公共契约；调用者可保留回调以断言完成来源。 */
function propsFor(page: AuthenticationPageProps['page']): AuthenticationPageProps {
  return { page, authUser: null, onAuthenticated: vi.fn(), onRequestLogin: vi.fn() };
}

/** 只填写本页可见字段，确认密码不参与网络请求。 */
function fillCredentials(registering = false) {
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: session.user.email } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'synthetic-password' } });
  if (registering)
    fireEvent.change(screen.getByLabelText('确认密码'), {
      target: { value: 'synthetic-password' },
    });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/auth/login');
  vi.mocked(login).mockReset();
  vi.mocked(register).mockReset();
  vi.mocked(verifyAccount).mockReset();
  vi.mocked(managementRequest).mockReset();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('独立认证页面', () => {
  it('注册先校验确认密码，未通过时不发请求', () => {
    render(<AuthenticationPage {...propsFor('register')} />);
    expect(screen.getByRole('heading', { name: '创建账户', level: 1 })).toBeVisible();
    fillCredentials(true);
    fireEvent.change(screen.getByLabelText('确认密码'), {
      target: { value: 'different-password' },
    });
    fireEvent.submit(screen.getByRole('form', { name: '注册表单' }));
    expect(screen.getByRole('alert')).toHaveTextContent('两次输入的密码不一致');
    expect(register).not.toHaveBeenCalled();
  });

  it('注册等待验证时进入验证码 URL，不携带密码或确认密码', async () => {
    const props = propsFor('register');
    vi.mocked(register).mockRejectedValue(new EmailVerificationRequired(session.user.email));
    render(<AuthenticationPage {...props} />);
    fillCredentials(true);
    fireEvent.change(screen.getByLabelText('显示名称（可选）'), { target: { value: '测试账户' } });
    fireEvent.submit(screen.getByRole('form', { name: '注册表单' }));
    await waitFor(() => expect(window.location.pathname).toBe('/auth/verify'));
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      email: session.user.email,
      purpose: 'register',
    });
    expect(register).toHaveBeenCalledWith(
      expect.any(String),
      { email: session.user.email, password: 'synthetic-password', displayName: '测试账户' },
      { signal: expect.any(AbortSignal) },
    );
    expect(props.onAuthenticated).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('严格模式下登录信号有效，快速重复提交只发送一次', async () => {
    const pending = deferred<StoredAuthSession>();
    const props = propsFor('login');
    vi.mocked(login).mockReturnValue(pending.promise);
    render(
      <StrictMode>
        <AuthenticationPage {...props} />
      </StrictMode>,
    );
    expect(screen.getByRole('heading', { name: '登录工作台', level: 1 })).toBeVisible();
    fillCredentials();
    fireEvent.submit(screen.getByRole('form', { name: '登录表单' }));
    fireEvent.submit(screen.getByRole('form', { name: '登录表单' }));
    expect(login).toHaveBeenCalledTimes(1);
    expect(vi.mocked(login).mock.calls[0]?.[2]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve(session));
    expect(props.onAuthenticated).toHaveBeenCalledWith(session, 'login');
  });

  it('从登录切换注册立即取消请求，晚到会话不触发跳转', async () => {
    const pending = deferred<StoredAuthSession>();
    const props = propsFor('login');
    vi.mocked(login).mockReturnValue(pending.promise);
    const view = render(<AuthenticationPage {...props} />);
    fillCredentials();
    fireEvent.submit(screen.getByRole('form', { name: '登录表单' }));
    const signal = vi.mocked(login).mock.calls[0]?.[2]?.signal;
    view.rerender(<AuthenticationPage {...props} page="register" />);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(session));
    expect(props.onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '创建账户', level: 1 })).toBeVisible();
  });

  it('点击当前页跳转在快照切换前取消请求，修饰键新开页面不取消', async () => {
    const pending = deferred<StoredAuthSession>();
    const props = propsFor('login');
    vi.mocked(login).mockReturnValue(pending.promise);
    render(<AuthenticationPage {...props} />);
    fillCredentials();
    fireEvent.submit(screen.getByRole('form', { name: '登录表单' }));
    const signal = vi.mocked(login).mock.calls[0]?.[2]?.signal;
    fireEvent.click(screen.getByRole('link', { name: '创建账户' }), { ctrlKey: true });
    expect(signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: '创建账户' }));
    expect(signal?.aborted).toBe(true);
    expect(window.location.pathname).toBe('/auth/register');
    await act(async () => pending.resolve(session));
    expect(props.onAuthenticated).not.toHaveBeenCalled();
  });

  it('卸载后迟到的待验证响应不把用户带回验证码页', async () => {
    const pending = deferred<StoredAuthSession>();
    vi.mocked(register).mockReturnValue(pending.promise);
    const view = render(<AuthenticationPage {...propsFor('register')} />);
    fillCredentials(true);
    fireEvent.submit(screen.getByRole('form', { name: '注册表单' }));
    view.unmount();
    window.history.replaceState(null, '', '/workspace');
    await act(async () => pending.reject(new EmailVerificationRequired(session.user.email)));
    expect(window.location.pathname).toBe('/workspace');
  });

  it('验证码确认只回传验证会话，失败保留页面和明确错误', async () => {
    const props = propsFor('verify');
    window.history.replaceState(
      null,
      '',
      `/auth/verify?email=${session.user.email}&purpose=register`,
    );
    vi.mocked(verifyAccount).mockRejectedValueOnce(new Error('验证码错误或已过期'));
    vi.mocked(verifyAccount).mockResolvedValueOnce(session);
    render(<AuthenticationPage {...props} />);
    expect(screen.getByRole('heading', { name: '验证你的邮箱', level: 1 })).toBeVisible();
    expect(screen.getByRole('button', { name: '确认' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('form', { name: '邮箱验证表单' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('验证码错误或已过期');
    expect(props.onAuthenticated).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole('form', { name: '邮箱验证表单' }));
    await waitFor(() =>
      expect(props.onAuthenticated).toHaveBeenCalledWith(session, 'verification'),
    );
    expect(verifyAccount).toHaveBeenLastCalledWith(
      { email: session.user.email, code: '123456', purpose: 'register' },
      { signal: expect.any(AbortSignal) },
    );
    expect(window.location.pathname).toBe('/auth/verify');
  });

  it('验证码页卸载后取消验证，旧会话不能回调', async () => {
    const pending = deferred<StoredAuthSession>();
    const props = propsFor('verify');
    vi.mocked(verifyAccount).mockReturnValue(pending.promise);
    window.history.replaceState(null, '', `/auth/verify?email=${session.user.email}`);
    const view = render(<AuthenticationPage {...props} />);
    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('form', { name: '邮箱验证表单' }));
    const signal = vi.mocked(verifyAccount).mock.calls[0]?.[1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(session));
    expect(props.onAuthenticated).not.toHaveBeenCalled();
  });

  it('验证码页切换时也取消重发请求，取消后不更新投递状态', async () => {
    const pending = deferred<unknown>();
    vi.mocked(managementRequest).mockReturnValue(pending.promise);
    window.history.replaceState(
      null,
      '',
      `/auth/verify?email=${session.user.email}&delivery=failed`,
    );
    const view = render(<AuthenticationPage {...propsFor('verify')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('账户已保留');
    fireEvent.click(screen.getByRole('button', { name: '重新发送验证码' }));
    const signal = vi.mocked(managementRequest).mock.calls[0]?.[1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      pending.resolve({ delivery: { status: 'queued', id: 'synthetic-mail' } }),
    );
    expect(new URLSearchParams(window.location.search).get('delivery')).toBe('failed');
  });

  it('重发成功清理投递失败标记，页面持续挂载时保留倒计时与已填验证码', async () => {
    const props = propsFor('verify');
    vi.mocked(managementRequest).mockResolvedValue({
      delivery: { status: 'queued', id: 'synthetic-mail' },
    });
    window.history.replaceState(
      null,
      '',
      `/auth/verify?email=${session.user.email}&purpose=register&delivery=failed`,
    );
    const view = render(<AuthenticationPage {...props} />);
    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '重新发送验证码' }));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).has('delivery')).toBe(false),
    );
    view.rerender(<AuthenticationPage {...props} />);
    expect(screen.getByRole('button', { name: '60 秒后可重发' })).toBeDisabled();
    expect(screen.getByLabelText('邮箱验证码')).toHaveValue('123456');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(managementRequest).toHaveBeenCalledTimes(1);
  });

  it('更换邮箱验证先请求登录，不允许匿名提交验证码', () => {
    const props = propsFor('verify');
    window.history.replaceState(null, '', `/auth/verify?email=${session.user.email}&purpose=email`);
    render(<AuthenticationPage {...props} />);
    expect(screen.queryByLabelText('邮箱验证码')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '登录账户' }));
    expect(props.onRequestLogin).toHaveBeenCalledTimes(1);
    expect(verifyAccount).not.toHaveBeenCalled();
  });

  it('复用验证码表单保留初始化文案，并阻止中文输入法确认键误提交', () => {
    render(
      <VerificationForm
        email={session.user.email}
        purpose="bootstrap"
        onSessionChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '验证并完成初始化' })).toBeVisible();
    const allowed = fireEvent.keyDown(screen.getByLabelText('邮箱验证码'), {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
    });
    expect(allowed).toBe(false);
    expect(verifyAccount).not.toHaveBeenCalled();
  });
});
