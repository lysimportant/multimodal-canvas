/** 审计与任务库组件回归：分页、权限范围、错误状态和只读操作。 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditPage, SystemPage } from './AdminPages';
import { ResourceGroupsPage, RunsPage } from './ResourcePages';
import { managementRequest } from './client';

vi.mock('./client', async (original) => ({
  ...(await original<typeof import('./client')>()),
  managementRequest: vi.fn(),
}));

/** 每项回归独立缓存，避免轮询和分页结果泄漏到下一项。 */
let client: QueryClient;
/** 已完成任务的合成摘要，不含真实 Provider 或用户数据。 */
const run = {
  id: 'run-a',
  projectId: 'project-a',
  targetNodeId: 'node-a',
  ownerId: 'owner-a',
  modelAlias: '测试模型',
  provider: 'mock',
  status: 'failed',
  progress: 37,
  error: '服务端任务失败摘要',
  result: { summary: '<b>仅按纯文本展示的结果</b>' },
  createdAt: '2026-09-12T00:00:00Z',
  updatedAt: '2026-09-12T00:01:00Z',
};
/** 在真实 React Query 上下文中渲染管理页面，不替换 Ant Design 控件。 */
function renderPage(page: ReactNode) {
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}
/** 所有可见列表操作必须维持只读，不产生任务重试或资源写请求。 */
function expectReadOnly() {
  expect(
    vi
      .mocked(managementRequest)
      .mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(managementRequest).mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe('审计与系统页面', () => {
  it('真实 Table 保留脱敏摘要、系统身份占位与固定 30 项分页', async () => {
    vi.mocked(managementRequest).mockImplementation(async (requestPath) => {
      const page = Number(new URL(requestPath, 'http://canvas.test').searchParams.get('page'));
      return {
        events: [
          {
            id: 'event-' + page,
            action: 'resource.update',
            summary: '已更新标签，第 ' + page + ' 页',
            createdAt: run.createdAt,
          },
        ],
        total: 61,
        page,
        pageSize: 30,
      };
    });
    const view = renderPage(<AuditPage userId="admin-a" />);
    const table = await screen.findByRole('table');
    expect(view.container.querySelector('.ant-table')).not.toBeNull();
    expect(within(table).getByRole('columnheader', { name: '操作者' })).toBeVisible();
    expect(within(table).getAllByText('系统')).toHaveLength(2);
    expect(within(table).getByText('resource.update')).toBeVisible();
    expect(within(table).getByText('已更新标签，第 1 页')).toBeVisible();
    expect(screen.getByText('共 61 项')).toBeVisible();
    fireEvent.click(screen.getByTitle('下一页'));
    expect(await screen.findByText('已更新标签，第 2 页')).toBeVisible();
    expect(managementRequest).toHaveBeenLastCalledWith(
      '/admin/audit?page=2&pageSize=30',
      expect.anything(),
    );
    expect(client.getQueryData(['management', 'admin-a', 'audit', 2])).toMatchObject({ page: 2 });
    expectReadOnly();
  });

  it('读取失败显示原错误，用户重试后才进入真实 Empty 状态', async () => {
    vi.mocked(managementRequest)
      .mockRejectedValueOnce(new Error('无权读取操作记录'))
      .mockResolvedValue({ events: [], total: 0, page: 1, pageSize: 30 });
    const view = renderPage(<AuditPage userId="admin-a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('无权读取操作记录');
    expect(screen.queryByText('暂无操作记录')).toBeNull();
    expect(managementRequest).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByText('暂无操作记录')).toBeVisible();
    expect(view.container.querySelector('.ant-empty')).not.toBeNull();
    expect(managementRequest).toHaveBeenCalledTimes(2);
    expectReadOnly();
  });

  it('系统状态仍区分正常、未检测和异常，刷新不写入', async () => {
    vi.mocked(managementRequest).mockResolvedValue({
      api: { status: 'ok' },
      storage: { status: 'unknown' },
      queue: { status: 'error' },
    });
    renderPage(<SystemPage userId="admin-a" />);
    expect(await screen.findByText('正常')).toBeVisible();
    expect(screen.getByText('未检测')).toBeVisible();
    expect(screen.getByText('异常')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() => expect(managementRequest).toHaveBeenCalledTimes(2));
    expect(managementRequest).toHaveBeenLastCalledWith('/admin/system', expect.anything());
    expectReadOnly();
  });
});

describe('资源分组与任务', () => {
  it('资源组搜索保留无归属入口与已登录管理员缓存', async () => {
    vi.mocked(managementRequest).mockResolvedValue({
      groups: [
        {
          ownerId: 'owner-a',
          user: { displayName: '资源主人甲' },
          resourceCount: 3,
          storageBytes: 4096,
        },
        { ownerId: null, user: null, resourceCount: 1, storageBytes: 100 },
      ],
    });
    renderPage(<ResourceGroupsPage userId="admin-a" />);
    expect(await screen.findByRole('link', { name: /资源主人甲/ })).toHaveAttribute(
      'href',
      '/admin/users/owner-a/resources',
    );
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索资源所属用户' }), {
      target: { value: '待确认归属' },
    });
    expect(screen.queryByRole('link', { name: /资源主人甲/ })).toBeNull();
    expect(screen.getByRole('link', { name: /待确认归属/ })).toHaveAttribute(
      'href',
      '/admin/users/unassigned/resources',
    );
    expect(client.getQueryData(['management', 'admin-a', 'resource-groups'])).toMatchObject({
      groups: expect.any(Array),
    });
    expectReadOnly();
  });

  it('个人任务 Table/Progress/Modal 保留详情错误、纯文本结果及安全资源入口', async () => {
    vi.mocked(managementRequest).mockResolvedValue({
      runs: [run],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    const view = renderPage(<RunsPage userId="owner-a" />);
    const table = await screen.findByRole('table');
    expect(view.container.querySelector('.ant-table')).not.toBeNull();
    expect(within(table).queryByRole('columnheader', { name: '所属用户' })).toBeNull();
    expect(within(table).getByRole('progressbar', { name: '测试模型的进度' })).toHaveAttribute(
      'aria-valuenow',
      '37',
    );
    expect(managementRequest).toHaveBeenCalledWith(
      '/account/runs?page=1&pageSize=20',
      expect.anything(),
    );
    await userEvent.click(within(table).getByRole('button', { name: '详情' }));
    const dialog = await screen.findByRole('dialog', { name: '任务详情' });
    await waitFor(() => expect(dialog).toBeVisible());
    expect(within(dialog).getByRole('alert')).toHaveTextContent(run.error);
    expect(within(dialog).getByText(run.result.summary)).toBeVisible();
    expect(dialog.querySelector('.mg-run-result b')).toBeNull();
    expect(within(dialog).getByRole('link', { name: '返回画布' })).toHaveAttribute(
      'href',
      '/projects/project-a',
    );
    expect(within(dialog).getByRole('link', { name: '查看结果资源' })).toHaveAttribute(
      'href',
      '/resources',
    );
    expectReadOnly();
  });

  it.each(['owner-a', 'admin-a'])(
    '管理员 %s 只能返回自己的画布，详情读取不会重试生成',
    async (userId) => {
      vi.mocked(managementRequest).mockImplementation(async (requestPath) =>
        requestPath.startsWith('/admin/runs')
          ? { runs: [run], total: 1, page: 1, pageSize: 20 }
          : { groups: [] },
      );
      renderPage(<RunsPage userId={userId} admin />);
      const table = await screen.findByRole('table');
      expect(within(table).getByRole('columnheader', { name: '所属用户' })).toBeVisible();
      await userEvent.click(within(table).getByRole('button', { name: '详情' }));
      const dialog = await screen.findByRole('dialog', { name: '任务详情' });
      await waitFor(() => expect(dialog).toBeVisible());
      if (userId === run.ownerId)
        expect(within(dialog).getByRole('link', { name: '返回画布' })).toBeVisible();
      else expect(within(dialog).queryByRole('link', { name: '返回画布' })).toBeNull();
      expect(within(dialog).getByRole('link', { name: '查看结果资源' })).toHaveAttribute(
        'href',
        '/admin/users/owner-a/resources',
      );
      expectReadOnly();
    },
  );

  it('任务筛选保持 ownerId 范围并重置页码，详情随已有查询刷新更新', async () => {
    let latest = { ...run, status: 'running' };
    vi.mocked(managementRequest).mockImplementation(async (requestPath) => {
      if (requestPath.startsWith('/admin/runs'))
        return { runs: [latest], total: 40, page: 1, pageSize: 20 };
      return {
        groups: [
          {
            ownerId: 'owner-a',
            user: { displayName: '资源主人甲' },
            resourceCount: 1,
            storageBytes: 1,
          },
        ],
      };
    });
    renderPage(<RunsPage userId="admin-a" admin />);
    await screen.findByText('共 40 项');
    fireEvent.click(screen.getByTitle('下一页'));
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith(
        '/admin/runs?page=2&pageSize=20',
        expect.anything(),
      ),
    );
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '任务状态' }));
    fireEvent.click(await screen.findByRole('option', { name: '运行中' }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '任务所属用户' }));
    fireEvent.click(await screen.findByRole('option', { name: '资源主人甲' }));
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith(
        '/admin/runs?ownerId=owner-a&status=running&page=1&pageSize=20',
        expect.anything(),
      ),
    );
    const key = ['management', 'admin-a', 'runs', true, 'owner-a', 'running', 1];
    expect(client.getQueryData(key)).toMatchObject({ runs: [{ id: run.id }] });
    await userEvent.click(screen.getByRole('button', { name: '详情' }));
    const dialog = await screen.findByRole('dialog', { name: '任务详情' });
    await waitFor(() => expect(dialog).toBeVisible());
    expect(within(dialog).getByText('运行中')).toBeVisible();
    latest = { ...latest, progress: 100, status: 'succeeded' };
    await act(async () => {
      await client.invalidateQueries({ queryKey: key });
    });
    expect(await within(dialog).findByText('已完成')).toBeVisible();
    expect(within(dialog).getByText('100%')).toBeVisible();
    expectReadOnly();
  });
});
