/** 管理页面的权限、导航、资源归属和账户切换回归。 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../auth-client';
import { managementRequest } from './client';
import { ManagementPage } from './ManagementPage';

vi.mock('./client', async (original) => ({
  ...(await original<typeof import('./client')>()),
  managementRequest: vi.fn(),
}));

/** New API 用户资料不要求邮箱。 */
const ordinaryUser: AuthUser = {
  id: 'user-a',
  displayName: '普通用户',
  role: 'user',
  createdAt: '2026-09-21T00:00:00.000Z',
};

/** 合成管理员仅用于前端权限与缓存隔离测试。 */
const adminUser: AuthUser = {
  ...ordinaryUser,
  id: 'admin-a',
  displayName: '管理员甲',
  role: 'admin',
};

const clients: QueryClient[] = [];

/** 使用无重试查询客户端挂载管理页，避免失败请求被自动重放。 */
function renderManagement(routePath: string, authUser: AuthUser | null, onRequestLogin = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const page = (user: AuthUser | null) => (
    <QueryClientProvider client={client}>
      <ManagementPage routePath={routePath} authUser={user} onRequestLogin={onRequestLogin} />
    </QueryClientProvider>
  );
  const view = render(page(authUser));
  return { ...view, client, rerenderUser: (user: AuthUser | null) => view.rerender(page(user)) };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  vi.mocked(managementRequest).mockReset();
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

describe('管理权限与入口', () => {
  it('匿名访问后台只显示统一登录入口，不读取后台数据', () => {
    const onRequestLogin = vi.fn();
    renderManagement('/admin', null, onRequestLogin);

    expect(screen.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(onRequestLogin).toHaveBeenCalledOnce();
    expect(managementRequest).not.toHaveBeenCalled();
  });

  it('普通用户不能进入后台，也不会发起管理员请求', () => {
    renderManagement('/admin/resources', ordinaryUser);

    expect(screen.getByRole('heading', { name: '仅管理员可访问' })).toBeVisible();
    expect(managementRequest).not.toHaveBeenCalled();
  });

  it('管理员导航只保留资源、任务、审计和系统能力，不显示旧账号入口', async () => {
    vi.mocked(managementRequest).mockResolvedValue({
      resources: { total: 8, storageBytes: 2_048, unassigned: 1 },
      runs: { total: 5, failed: 1, active: 2 },
    });
    renderManagement('/admin', adminUser);

    expect(await screen.findByRole('heading', { name: '管理概览' })).toBeVisible();
    const navigation = screen.getByRole('complementary', { name: '后台导航' });
    expect(within(navigation).getByRole('link', { name: '用户资源' })).toHaveAttribute(
      'href',
      '/admin/resources',
    );
    expect(within(navigation).getByRole('link', { name: '全站任务' })).toHaveAttribute(
      'href',
      '/admin/runs',
    );
    expect(within(navigation).getByRole('link', { name: '操作记录' })).toHaveAttribute(
      'href',
      '/admin/audit',
    );
    expect(within(navigation).getByRole('link', { name: '系统状态' })).toHaveAttribute(
      'href',
      '/admin/system',
    );
    expect(within(navigation).queryByRole('link', { name: /用户管理|账号|邮箱|密码/ })).toBeNull();
    expect(screen.queryByText(/邀请用户|更换邮箱|修改密码/)).toBeNull();
    expect(managementRequest).toHaveBeenCalledWith('/admin/overview', expect.anything());
  });
});

describe('管理数据的身份与资源范围', () => {
  it('切换管理员后，旧账号迟到的概览不能覆盖新账号', async () => {
    let finishOld!: (value: unknown) => void;
    const oldOverview = new Promise((resolve) => {
      finishOld = resolve;
    });
    vi.mocked(managementRequest)
      .mockReturnValueOnce(oldOverview)
      .mockResolvedValueOnce({
        resources: { total: 22, storageBytes: 4_096, unassigned: 0 },
        runs: { total: 9, failed: 0, active: 3 },
      });
    const view = renderManagement('/admin', adminUser);
    await waitFor(() => expect(managementRequest).toHaveBeenCalledTimes(1));

    view.rerenderUser({ ...adminUser, id: 'admin-b', displayName: '管理员乙' });
    expect(await screen.findByText('22')).toBeVisible();

    await act(async () => {
      finishOld({
        resources: { total: 999, storageBytes: 1, unassigned: 0 },
        runs: { total: 999, failed: 0, active: 0 },
      });
    });
    expect(screen.getByText('22')).toBeVisible();
    expect(screen.queryByText('999')).toBeNull();
    expect(view.client.getQueryData(['management', 'admin-b', 'overview'])).toMatchObject({
      resources: { total: 22 },
    });
  });

  it('资源详情通过 resource-owners 读取无邮箱 owner', async () => {
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path === '/admin/resource-owners/owner-no-mail') {
        return {
          user: {
            id: 'owner-no-mail',
            displayName: '资源主人',
            role: 'user',
            status: 'active',
            createdAt: '2026-09-21T00:00:00.000Z',
          },
          projects: [],
          stats: { resourceCount: 0, storageBytes: 0, runCount: 0 },
        };
      }
      if (path.startsWith('/admin/resources?')) {
        return { assets: [], total: 0, page: 1, pageSize: 24 };
      }
      throw new Error(`未处理的测试请求：${path}`);
    });
    renderManagement('/admin/users/owner-no-mail/resources', adminUser);

    expect(await screen.findByRole('heading', { name: '资源主人的资源' })).toBeVisible();
    expect(managementRequest).toHaveBeenCalledWith(
      '/admin/resource-owners/owner-no-mail',
      expect.anything(),
    );
    expect(
      vi
        .mocked(managementRequest)
        .mock.calls.some(([path]) => path.startsWith('/admin/users/owner-no-mail')),
    ).toBe(false);
  });
});
