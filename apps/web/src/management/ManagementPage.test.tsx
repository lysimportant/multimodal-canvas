/** 管理页面的角色、初始化、邮箱与资源作用域回归。 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAuthSession,
  persistAuthSession,
  readAuthSession,
  type AuthTokenResponse,
  type AuthUser,
  type StoredAuthSession,
} from '../auth-client';
import { BootstrapPage, ProfilePage, SecurityPage, VerifyPage } from './AccountPages';
import { UserDetailPage } from './AdminPages';
import { managementRequest, verifyAccount } from './client';
import { ManagementPage } from './ManagementPage';
import { ResourceGroupsPage, ResourcesPage } from './ResourcePages';

vi.mock('./client', async (original) => ({
  ...(await original<typeof import('./client')>()),
  managementRequest: vi.fn(),
  verifyAccount: vi.fn(),
}));

/** 所有测试只使用合成用户和邮箱，不依赖真实服务。 */
const ordinaryUser: AuthUser = {
  id: 'user-a',
  email: 'reader@example.test',
  displayName: '读者甲',
  role: 'user',
  createdAt: '2026-09-06T00:00:00.000Z',
};
/** 合成管理员用于验证前端菜单及后台查询边界。 */
const adminUser: AuthUser = {
  ...ordinaryUser,
  id: 'admin-a',
  role: 'admin',
  displayName: '管理者',
};
/** 测试期间创建的查询客户端，结束时统一清理轮询。 */
const clients: QueryClient[] = [];

/** 合成服务端会话响应，用于检测晚到结果是否覆盖浏览器当前身份。 */
function responseFor(user: AuthUser, token: string): AuthTokenResponse {
  return {
    user,
    accessToken: token,
    tokenType: 'Bearer',
    expiresIn: 900,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

/** 为被测页面提供与应用相同的查询边界，禁用重试以保持失败可观察。 */
function renderPage(page: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}

beforeEach(() => {
  clearAuthSession();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.mocked(managementRequest).mockReset();
  vi.mocked(verifyAccount).mockReset();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

describe('管理访问与首次初始化', () => {
  it('首次进入未初始化 /admin 直接显示管理员创建页，不要求先登录', async () => {
    vi.mocked(managementRequest).mockResolvedValue({
      initialized: false,
      mailConfigured: true,
      setupTokenRequired: true,
    });
    renderPage(
      <ManagementPage
        routePath="/admin"
        authUser={null}
        onRequestLogin={vi.fn()}
        onSessionChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('heading', { name: '创建管理员账户' })).toBeVisible();
    expect(screen.getByLabelText('部署初始化凭据')).toBeRequired();
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
    expect(managementRequest).toHaveBeenCalledTimes(1);
  });

  it('已初始化后不再显示创建页，普通用户也不发起后台列表请求', async () => {
    vi.mocked(managementRequest).mockResolvedValue({
      initialized: true,
      mailConfigured: true,
      setupTokenRequired: false,
    });
    renderPage(
      <ManagementPage
        routePath="/admin/users"
        authUser={ordinaryUser}
        onRequestLogin={vi.fn()}
        onSessionChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('heading', { name: '仅管理员可访问' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '创建管理员账户' })).not.toBeInTheDocument();
    expect(managementRequest).not.toHaveBeenCalledWith(
      expect.stringContaining('/admin/users'),
      expect.anything(),
    );
  });

  it('初始化状态读取失败不能误开放管理员创建', async () => {
    vi.mocked(managementRequest).mockRejectedValue(new Error('网络暂时断开'));
    renderPage(
      <ManagementPage
        routePath="/admin"
        authUser={null}
        onRequestLogin={vi.fn()}
        onSessionChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('网络暂时断开');
    expect(screen.queryByRole('heading', { name: '创建管理员账户' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeEnabled();
  });

  it('未配置邮件时禁止初始化提交', () => {
    renderPage(
      <BootstrapPage
        status={{ initialized: false, mailConfigured: false, setupTokenRequired: false }}
        onSessionChanged={vi.fn()}
        onInitialized={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '发送验证邮件' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('邮件服务尚未配置');
  });

  it('初始化邮件失败保留已创建的验证流程并显示真实失败', async () => {
    vi.mocked(managementRequest).mockResolvedValue({
      email: 'owner@example.test',
      delivery: { status: 'failed', id: 'mail-a' },
    });
    renderPage(
      <BootstrapPage
        status={{ initialized: false, mailConfigured: true, setupTokenRequired: false }}
        onSessionChanged={vi.fn()}
        onInitialized={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('管理员昵称'), { target: { value: '管理员' } });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'owner@example.test' } });
    fireEvent.change(screen.getByLabelText('密码', { selector: 'input' }), {
      target: { value: 'test-password' },
    });
    fireEvent.change(screen.getByLabelText('确认密码', { selector: 'input' }), {
      target: { value: 'test-password' },
    });
    fireEvent.submit(screen.getByRole('button', { name: '发送验证邮件' }).closest('form')!);
    expect(await screen.findByLabelText('邮箱验证码')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('邮件发送失败');
    expect(screen.getByRole('button', { name: '重新发送验证码' })).toBeEnabled();
    expect(managementRequest).toHaveBeenCalledTimes(1);
  });
});

describe('邮箱验证与安全操作', () => {
  it('管理员从本人用户详情更换邮箱时进入有当前密码校验的安全页', async () => {
    window.history.replaceState(null, '', `/admin/users/${adminUser.id}`);
    vi.mocked(managementRequest).mockResolvedValue({
      user: { ...adminUser, status: 'active' },
      projects: [],
      stats: { resourceCount: 0, storageBytes: 0, runCount: 0 },
    });
    renderPage(<UserDetailPage actorId={adminUser.id} userId={adminUser.id} />);
    const link = await screen.findByRole('link', { name: '更换邮箱' });
    expect(link).toHaveAttribute('href', '/account/security');
    fireEvent.click(link);
    expect(window.location.pathname).toBe('/account/security');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(managementRequest).toHaveBeenCalledTimes(1);
  });

  it('管理员更换其他用户邮箱仍通过管理弹窗发送目标邮箱验证', async () => {
    window.history.replaceState(null, '', `/admin/users/${ordinaryUser.id}`);
    vi.mocked(managementRequest).mockImplementation(async (_path, options) =>
      options?.method === 'POST'
        ? { delivery: { id: 'other-user-email', status: 'accepted' } }
        : {
            user: { ...ordinaryUser, status: 'active' },
            projects: [],
            stats: { resourceCount: 0, storageBytes: 0, runCount: 0 },
          },
    );
    renderPage(<UserDetailPage actorId={adminUser.id} userId={ordinaryUser.id} />);
    fireEvent.click(await screen.findByRole('button', { name: '更换邮箱' }));
    const dialog = await screen.findByRole('dialog', { name: '更换用户邮箱' });
    fireEvent.change(within(dialog).getByLabelText('新邮箱'), {
      target: { value: 'new-user@example.test' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '发送验证邮件' }));
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith(`/admin/users/${ordinaryUser.id}/email`, {
        method: 'POST',
        body: { email: 'new-user@example.test' },
      }),
    );
    expect(window.location.pathname).toBe(`/admin/users/${ordinaryUser.id}`);
    expect(await screen.findByRole('status')).toHaveTextContent('新邮箱验证邮件已提交发送');
  });

  it('改密期间登录另一个账户时，旧密码响应不得覆盖会话或通知应用登录', async () => {
    persistAuthSession(responseFor(ordinaryUser, 'original-session'));
    let finish!: (response: AuthTokenResponse) => void;
    const pending = new Promise<AuthTokenResponse>((resolve) => {
      finish = resolve;
    });
    vi.mocked(managementRequest).mockImplementation(async (path) =>
      path === '/account/password' ? pending : { sessions: [] },
    );
    const onSessionChanged = vi.fn();
    renderPage(<SecurityPage userId={ordinaryUser.id} onSessionChanged={onSessionChanged} />);
    const form = screen.getByRole('button', { name: '修改密码' }).closest('form')!;
    fireEvent.change(within(form).getByLabelText('当前密码', { selector: 'input' }), {
      target: { value: 'old-password' },
    });
    fireEvent.change(within(form).getByLabelText('新密码', { selector: 'input' }), {
      target: { value: 'new-password' },
    });
    fireEvent.change(within(form).getByLabelText('确认新密码', { selector: 'input' }), {
      target: { value: 'new-password' },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith('/account/password', expect.anything()),
    );
    persistAuthSession(responseFor(adminUser, 'later-session'));
    finish(responseFor(ordinaryUser, 'late-password-session'));
    expect(await screen.findByRole('alert')).toHaveTextContent('账户状态已改变');
    expect(readAuthSession()).toMatchObject({
      accessToken: 'later-session',
      user: { id: adminUser.id },
    });
    expect(onSessionChanged).not.toHaveBeenCalled();
  });

  it('绑定邮箱验证码请求期间退出时，晚到响应不得重新登录', async () => {
    persistAuthSession(responseFor(ordinaryUser, 'original-session'));
    let finish!: (response: AuthTokenResponse) => void;
    const pending = new Promise<AuthTokenResponse>((resolve) => {
      finish = resolve;
    });
    vi.mocked(managementRequest).mockImplementation(async (path) =>
      path === '/auth/verify'
        ? pending
        : path === '/account/email/request'
          ? { delivery: { id: 'email-request', status: 'accepted' } }
          : { sessions: [] },
    );
    const onSessionChanged = vi.fn();
    renderPage(<SecurityPage userId={ordinaryUser.id} onSessionChanged={onSessionChanged} />);
    const emailForm = screen.getByRole('button', { name: '发送验证邮件' }).closest('form')!;
    fireEvent.change(within(emailForm).getByLabelText('新邮箱'), {
      target: { value: 'new@example.test' },
    });
    fireEvent.change(within(emailForm).getByLabelText('当前密码', { selector: 'input' }), {
      target: { value: 'old-password' },
    });
    fireEvent.submit(emailForm);
    fireEvent.change(await screen.findByLabelText('邮箱验证码'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('button', { name: '验证并绑定' }).closest('form')!);
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith('/auth/verify', expect.anything()),
    );
    clearAuthSession();
    finish(responseFor({ ...ordinaryUser, email: 'new@example.test' }, 'late-email-session'));
    expect(await screen.findByRole('alert')).toHaveTextContent('账户状态已改变');
    expect(readAuthSession()).toBeNull();
    expect(onSessionChanged).not.toHaveBeenCalled();
  });

  it('资料保存晚于账户切换返回时，不把旧昵称合并到新账户', async () => {
    persistAuthSession(responseFor(ordinaryUser, 'original-session'));
    let finish!: (response: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    vi.mocked(managementRequest).mockImplementation(async (_path, options) =>
      options?.method === 'PATCH' ? pending : { user: { ...ordinaryUser, status: 'active' } },
    );
    const onSessionChanged = vi.fn();
    renderPage(<ProfilePage userId={ordinaryUser.id} onSessionChanged={onSessionChanged} />);
    fireEvent.change(await screen.findByLabelText('昵称'), {
      target: { value: '尚未完成的旧昵称' },
    });
    fireEvent.submit(screen.getByRole('button', { name: '保存资料' }).closest('form')!);
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith(
        '/account/profile',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    persistAuthSession(responseFor(adminUser, 'later-session'));
    finish({ user: { ...ordinaryUser, status: 'active', displayName: '尚未完成的旧昵称' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('账户状态已改变');
    expect(readAuthSession()).toMatchObject({
      accessToken: 'later-session',
      user: { id: adminUser.id, displayName: adminUser.displayName },
    });
    expect(onSessionChanged).not.toHaveBeenCalled();
  });

  it('注册邮件失败保留邮箱和重发入口，重发成功替换失败提示且不重复注册', async () => {
    window.history.replaceState(
      null,
      '',
      '/auth/verify?email=reader@example.test&purpose=register&delivery=failed',
    );
    vi.mocked(managementRequest).mockResolvedValue({
      email: 'reader@example.test',
      delivery: { id: 'resent-mail', status: 'accepted' },
    });
    renderPage(<VerifyPage authUser={null} onRequestLogin={vi.fn()} onSessionChanged={vi.fn()} />);
    const failure = '账户已保留，但验证邮件发送失败，请检查邮箱后重新发送验证码。';
    expect(screen.getByRole('alert')).toHaveTextContent(failure);
    expect(screen.getByLabelText('邮箱')).toHaveValue('reader@example.test');
    expect(screen.getByLabelText('邮箱验证码')).toBeVisible();
    expect(managementRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新发送验证码' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '验证邮件已提交发送，请查收邮箱中的验证码。',
    );
    expect(screen.queryByText(failure)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('delivery')).toBeNull();
    expect(screen.getByLabelText('邮箱')).toHaveValue('reader@example.test');
    expect(managementRequest).toHaveBeenCalledExactlyOnceWith('/auth/verification/resend', {
      method: 'POST',
      body: { email: 'reader@example.test', purpose: 'register' },
      public: true,
    });
    expect(verifyAccount).not.toHaveBeenCalled();
  });

  it('未保存资料离开时先确认，取消保留输入，确认后才切换页面', async () => {
    window.history.replaceState(null, '', '/account/profile');
    vi.mocked(managementRequest).mockResolvedValue({ user: { ...ordinaryUser, status: 'active' } });
    renderPage(<ProfilePage userId={ordinaryUser.id} onSessionChanged={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('昵称'), { target: { value: '尚未保存的昵称' } });
    fireEvent.click(screen.getByRole('link', { name: '账户安全' }));
    expect(await screen.findByRole('dialog')).toHaveAccessibleName('放弃未保存的修改？');
    expect(window.location.pathname).toBe('/account/profile');
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('昵称')).toHaveValue('尚未保存的昵称');
    fireEvent.click(screen.getByRole('link', { name: '账户安全' }));
    fireEvent.click(await screen.findByRole('button', { name: '放弃修改并离开' }));
    expect(window.location.pathname).toBe('/account/security');
    expect(managementRequest).toHaveBeenCalledTimes(1);
  });

  it('邀请激活必须确认新密码，不一致时不消费验证码', async () => {
    window.history.replaceState(null, '', '/auth/verify?email=invite@example.test&purpose=invite');
    renderPage(<VerifyPage authUser={null} onRequestLogin={vi.fn()} onSessionChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('新密码', { selector: 'input' }), {
      target: { value: 'first-password' },
    });
    fireEvent.change(screen.getByLabelText('确认新密码', { selector: 'input' }), {
      target: { value: 'second-password' },
    });
    fireEvent.submit(screen.getByRole('button', { name: '验证并进入工作台' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的密码不一致');
    expect(verifyAccount).not.toHaveBeenCalled();
  });

  it('验证成功回调统一认证入口，不覆盖应用的续接路由', async () => {
    window.history.replaceState(
      null,
      '',
      '/auth/verify?email=reader@example.test&purpose=register',
    );
    const session: StoredAuthSession = {
      user: ordinaryUser,
      accessToken: 'synthetic-session',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    vi.mocked(verifyAccount).mockResolvedValue(session);
    const onSessionChanged = vi.fn();
    renderPage(
      <VerifyPage authUser={null} onRequestLogin={vi.fn()} onSessionChanged={onSessionChanged} />,
    );
    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('button', { name: '验证并进入工作台' }).closest('form')!);
    await waitFor(() => expect(onSessionChanged).toHaveBeenCalledWith(session));
    expect(window.location.pathname).toBe('/auth/verify');
    expect(verifyAccount).toHaveBeenCalledWith({
      email: 'reader@example.test',
      code: '123456',
      purpose: 'register',
    });
  });

  it('更换邮箱的深链要求目标用户先登录，不能匿名消费', () => {
    window.history.replaceState(null, '', '/auth/verify?email=new@example.test&purpose=email');
    const onRequestLogin = vi.fn();
    renderPage(
      <VerifyPage authUser={null} onRequestLogin={onRequestLogin} onSessionChanged={vi.fn()} />,
    );
    expect(screen.queryByLabelText('邮箱验证码')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '登录账户' }));
    expect(onRequestLogin).toHaveBeenCalledTimes(1);
    expect(verifyAccount).not.toHaveBeenCalled();
  });

  it('密码重置不显示服务器不支持的重发按钮', () => {
    window.history.replaceState(null, '', '/auth/verify?email=reader@example.test&purpose=reset');
    renderPage(<VerifyPage authUser={null} onRequestLogin={vi.fn()} onSessionChanged={vi.fn()} />);
    expect(screen.getByLabelText('新密码', { selector: 'input' })).toBeRequired();
    expect(screen.queryByRole('button', { name: '重新发送验证码' })).not.toBeInTheDocument();
  });

  it('当前设备会话没有退出按钮，其他会话可单独撤销', async () => {
    vi.mocked(managementRequest).mockResolvedValue({
      sessions: [
        {
          id: 'current-a',
          current: true,
          createdAt: ordinaryUser.createdAt,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
        {
          id: 'other-b',
          current: false,
          createdAt: ordinaryUser.createdAt,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    });
    renderPage(<SecurityPage userId={ordinaryUser.id} onSessionChanged={vi.fn()} />);
    const current = await screen.findByText('当前会话');
    expect(
      within(current.closest('tr')!).queryByRole('button', { name: '退出会话' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出会话' }));
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith('/account/sessions/other-b', {
        method: 'DELETE',
      }),
    );
  });
});

describe('资源用户分组', () => {
  it('后台先展示用户分组及各自资源入口，不请求无范围的全部资源', async () => {
    vi.mocked(managementRequest).mockResolvedValue({
      groups: [
        {
          ownerId: 'owner-a',
          user: { ...ordinaryUser, id: 'owner-a', displayName: '作者甲' },
          resourceCount: 3,
          storageBytes: 100,
        },
        {
          ownerId: 'owner-b',
          user: {
            ...ordinaryUser,
            id: 'owner-b',
            email: 'second@example.test',
            displayName: '作者乙',
          },
          resourceCount: 5,
          storageBytes: 200,
        },
      ],
    });
    renderPage(<ResourceGroupsPage userId={adminUser.id} />);
    expect(await screen.findByRole('link', { name: /作者甲/ })).toHaveAttribute(
      'href',
      '/admin/users/owner-a/resources',
    );
    expect(screen.getByRole('link', { name: /作者乙/ })).toHaveAttribute(
      'href',
      '/admin/users/owner-b/resources',
    );
    expect(managementRequest).toHaveBeenCalledTimes(1);
    expect(managementRequest).toHaveBeenCalledWith('/admin/resource-groups', expect.anything());
  });

  it('普通用户资源请求没有可伪造的 ownerId，不出现后台入口', async () => {
    vi.mocked(managementRequest).mockResolvedValue({ assets: [], total: 0, page: 1, pageSize: 24 });
    renderPage(<ResourcesPage userId={ordinaryUser.id} />);
    expect(await screen.findByText('暂无资源')).toBeVisible();
    const paths = vi.mocked(managementRequest).mock.calls.map(([path]) => path);
    expect(
      paths.every(
        (path) =>
          (path.startsWith('/account/resources?') || path === '/projects?includeArchived=true') &&
          !path.includes('ownerId'),
      ),
    ).toBe(true);
    expect(screen.queryByRole('link', { name: /全部用户分组/ })).not.toBeInTheDocument();
  });

  it('管理员必须以当前选中用户查询资源，并在切换来源时复位页码', async () => {
    vi.mocked(managementRequest).mockImplementation(async (path) =>
      path.startsWith('/admin/users/')
        ? { user: { ...ordinaryUser, displayName: '作者甲' }, projects: [] }
        : { assets: [], total: 0, page: 1, pageSize: 24 },
    );
    renderPage(<ResourcesPage userId={adminUser.id} ownerId="owner-a" />);
    expect(await screen.findByRole('heading', { name: '作者甲的资源' })).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: '资源来源' }), {
      target: { value: 'generated' },
    });
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith(
        expect.stringContaining('ownerId=owner-a'),
        expect.anything(),
      ),
    );
    const resourcePaths = vi
      .mocked(managementRequest)
      .mock.calls.map(([path]) => path)
      .filter((path) => path.startsWith('/admin/resources'));
    expect(resourcePaths.every((path) => path.includes('ownerId=owner-a'))).toBe(true);
    expect(
      resourcePaths.some((path) => path.includes('source=generated') && path.includes('page=1')),
    ).toBe(true);
  });
});
