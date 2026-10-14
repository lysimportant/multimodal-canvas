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
/** 已失败任务的合成摘要，不含真实 Provider 或用户数据。 */
const run = {
  id: 'run-a',
  projectId: 'project-a',
  targetNodeId: 'node-a',
  targetNodeName: '文案节点',
  ownerId: 'owner-a',
  modelAlias: '测试模型',
  provider: 'mock',
  status: 'failed',
  progress: 37,
  recoverableVideo: false,
  error: '服务端任务失败摘要',
  result: { summary: '<b>仅按纯文本展示的结果</b>' },
  createdAt: '2026-09-12T00:00:00Z',
  updatedAt: '2026-09-12T00:01:00Z',
};
/** 原视频任务仅由管理 API 的资格字段决定是否显示获取入口。 */
const videoRun = {
  ...run,
  provider: 'newapi',
  status: 'cancelled',
  recoverableVideo: true,
  error: undefined as string | undefined,
  result: undefined as { summary?: string; asset?: { assetId: string } } | undefined,
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
  vi.restoreAllMocks();
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
    vi.mocked(managementRequest).mockImplementation(async (path) =>
      path === '/account/runs/run-a' ? { run } : { runs: [run], total: 1, page: 1, pageSize: 20 },
    );
    const view = renderPage(<RunsPage userId="owner-a" />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('文案节点')).toBeVisible();
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
    expect(within(dialog).getByText('文案节点')).toBeVisible();
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
    expect(managementRequest).toHaveBeenCalledWith('/account/runs/run-a', expect.anything());
    expect(within(dialog).queryByRole('button', { name: '查询并获取视频' })).toBeNull();
    expectReadOnly();
  });

  it('个人任务详情按需显示上游 ID、实际提示词与冻结资源，不自动发起恢复', async () => {
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path === '/account/runs/run-a')
        return { run: { ...videoRun, platformJobId: 'platform-job-a' } };
      if (path === '/runs/run-a/request-prompts')
        return {
          records: [
            {
              id: 'prompt-a',
              nodeId: 'node-a',
              modelAlias: '测试模型',
              requestIdentity: 'request-a',
              sendStatus: 'sent',
              createdAt: run.createdAt,
            },
          ],
        };
      if (path === '/runs/run-a/request-prompts/prompt-a')
        return {
          record: {
            parts: [{ order: 0, text: 'Generate the requested clip.' }],
            negativeText: 'Avoid blurred faces.',
            resources: [
              {
                assetId: 'asset-a',
                assetVersion: 3,
                name: '人物参考图',
                role: 'content',
                sortOrder: 0,
                mediaType: 'image',
              },
            ],
          },
        };
      return { runs: [videoRun], total: 1, page: 1, pageSize: 20 };
    });
    renderPage(<RunsPage userId="owner-a" />);
    await userEvent.click(
      within(await screen.findByRole('table')).getByRole('button', { name: '详情' }),
    );
    const dialog = await screen.findByRole('dialog', { name: '任务详情' });
    await waitFor(() => expect(within(dialog).getByText('platform-job-a')).toBeVisible());
    await userEvent.click(
      await within(dialog).findByRole('button', { name: '查看请求内容 · 测试模型 · node-a' }),
    );
    expect(await within(dialog).findByText('Generate the requested clip.')).toBeVisible();
    expect(within(dialog).getByText('Avoid blurred faces.')).toBeVisible();
    expect(within(dialog).getByText('人物参考图 · asset-a · v3')).toBeVisible();
    expectReadOnly();
  });

  it.each(['owner-a', 'admin-a'])(
    '管理员 %s 只能返回自己的画布，详情读取不会重试生成',
    async (userId) => {
      vi.mocked(managementRequest).mockImplementation(async (requestPath) =>
        requestPath === '/admin/runs/run-a'
          ? { run }
          : requestPath.startsWith('/admin/runs')
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
      if (requestPath === '/admin/runs/run-a') return { run: latest };
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
      await client.invalidateQueries({ queryKey: ['management', 'admin-a', 'run', true, run.id] });
    });
    expect(await within(dialog).findByText('已完成')).toBeVisible();
    expect(within(dialog).getByText('100%')).toBeVisible();
    expectReadOnly();
  });
});

describe('原视频任务获取', () => {
  it.each([
    { admin: false, userId: 'owner-a', status: 'cancelled' },
    { admin: true, userId: 'admin-a', status: 'failed' },
  ])(
    '$userId 显式获取原 $status 任务，受理后只有归档资源才报告成功',
    async ({ admin, userId, status }) => {
      const base = `${admin ? '/admin' : '/account'}/runs`;
      const detailKey = ['management', userId, 'run', admin, run.id];
      const resourceKey = ['management', userId, 'resources', admin ? run.ownerId : 'mine'];
      let latest = { ...videoRun, status };
      let accept!: (value: { accepted: boolean; run: typeof latest }) => void;
      const pending = new Promise<{ accepted: boolean; run: typeof latest }>((resolve) => {
        accept = resolve;
      });
      client.setQueryData(resourceKey, { assets: [] });
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      vi.mocked(managementRequest).mockImplementation(async (path, init) => {
        if (path === `${base}/${run.id}/recover` && init?.method === 'POST') return pending;
        if (path === `${base}/${run.id}`) return { run: latest };
        if (path.startsWith(`${base}?`)) return { runs: [latest], total: 1, page: 1, pageSize: 20 };
        if (path === '/admin/resource-groups') return { groups: [] };
        throw new Error(`未声明的测试请求：${path}`);
      });
      renderPage(<RunsPage userId={userId} admin={admin} />);
      await userEvent.click(await screen.findByRole('button', { name: '详情' }));
      const dialog = await screen.findByRole('dialog', { name: '任务详情' });
      const retrieve = await within(dialog).findByRole('button', { name: '查询并获取视频' });
      expectReadOnly();
      fireEvent.click(retrieve);
      fireEvent.click(retrieve);
      expect(retrieve).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: '关闭' })).toBeDisabled();
      expect(
        vi.mocked(managementRequest).mock.calls.filter(([, init]) => init?.method === 'POST'),
      ).toHaveLength(1);
      expect(managementRequest).toHaveBeenCalledWith(`${base}/${run.id}/recover`, {
        method: 'POST',
      });
      expect(within(dialog).queryByText('视频资源已归档，可在资源库查看')).toBeNull();
      latest = {
        ...latest,
        status: 'queued',
        recoverableVideo: false,
        updatedAt: '2026-09-12T00:02:00Z',
      };
      await act(async () => accept({ accepted: true, run: latest }));
      expect(await within(dialog).findByText('已受理，正在查询原视频任务')).toBeVisible();
      expect(within(dialog).queryByText('视频资源已归档，可在资源库查看')).toBeNull();
      expect(client.getQueryState(resourceKey)?.isInvalidated).toBe(false);
      expect(within(dialog).queryByRole('button', { name: '查询并获取视频' })).toBeNull();
      latest = {
        ...latest,
        status: 'succeeded',
        progress: 100,
        result: { summary: '原视频已获取', asset: { assetId: 'video-asset' } },
        updatedAt: '2026-09-12T00:03:00Z',
      };
      await act(async () => {
        await client.invalidateQueries({ queryKey: detailKey });
      });
      expect(await within(dialog).findByText('视频资源已归档，可在资源库查看')).toBeVisible();
      expect(client.getQueryState(resourceKey)?.isInvalidated).toBe(true);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['management', userId, 'resource-groups'],
      });
      expect(within(dialog).getByRole('link', { name: '查看结果资源' })).toHaveAttribute(
        'href',
        admin ? '/admin/users/owner-a/resources' : '/resources',
      );
      expect(
        vi.mocked(managementRequest).mock.calls.filter(([, init]) => init?.method === 'POST'),
      ).toHaveLength(1);
    },
  );

  it('详情每五秒按 ID 刷新，任务离开状态筛选列表后仍更新且关闭后停止轮询', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const clearInterval = vi.spyOn(globalThis, 'clearInterval');
    let latest = { ...run, status: 'running' };
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path === '/account/runs/run-a') return { run: latest };
      const status = new URL(path, 'http://canvas.test').searchParams.get('status');
      const rows = !status || status === latest.status ? [latest] : [];
      return { runs: rows, total: rows.length, page: 1, pageSize: 20 };
    });
    renderPage(<RunsPage userId="owner-a" />);
    await screen.findByRole('table');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '任务状态' }));
    fireEvent.click(await screen.findByRole('option', { name: '运行中' }));
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith(
        '/account/runs?status=running&page=1&pageSize=20',
        expect.anything(),
      ),
    );
    await userEvent.click(await screen.findByRole('button', { name: '详情' }));
    const dialog = await screen.findByRole('dialog', { name: '任务详情' });
    await waitFor(() => expect(dialog).toBeVisible());
    await within(dialog).findByText('运行中');
    const detailPoll = intervals.mock.calls.find(([, delay]) => delay === 5_000)?.[0];
    if (typeof detailPoll !== 'function') throw new Error('详情未注册五秒轮询');
    const detailsRead = () =>
      vi.mocked(managementRequest).mock.calls.filter(([path]) => path === '/account/runs/run-a')
        .length;
    expect(detailsRead()).toBe(1);
    latest = { ...latest, status: 'succeeded', progress: 100 };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['management', 'owner-a', 'runs'] });
    });
    expect(await screen.findByText('没有符合条件的任务')).toBeVisible();
    expect(within(dialog).getByText('运行中')).toBeVisible();
    await act(async () => {
      detailPoll();
    });
    expect(await within(dialog).findByText('已完成')).toBeVisible();
    expect(within(dialog).getByText('100%')).toBeVisible();
    expect(detailsRead()).toBe(2);
    const activeIntervalIndex = intervals.mock.calls.map(([, delay]) => delay).lastIndexOf(5_000);
    const activeInterval = intervals.mock.results[activeIntervalIndex]?.value;
    expect(activeInterval).toBeDefined();
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(clearInterval).toHaveBeenCalledWith(activeInterval);
    expect(intervals.mock.calls.map(([, delay]) => delay).lastIndexOf(5_000)).toBe(
      activeIntervalIndex,
    );
    expect(detailsRead()).toBe(2);
    expectReadOnly();
  });

  it('详情查询失败时拒绝使用缓存中的恢复资格，重新加载仅重发读取', async () => {
    let detailError = false;
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path === '/account/runs/run-a') {
        if (detailError) throw new Error('任务归属已变化，无法读取');
        return { run: videoRun };
      }
      return { runs: [videoRun], total: 1, page: 1, pageSize: 20 };
    });
    renderPage(<RunsPage userId="owner-a" />);
    await userEvent.click(await screen.findByRole('button', { name: '详情' }));
    const dialog = await screen.findByRole('dialog', { name: '任务详情' });
    await within(dialog).findByRole('button', { name: '查询并获取视频' });
    detailError = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['management', 'owner-a', 'run', false, run.id] });
    });
    expect(await within(dialog).findByText('任务归属已变化，无法读取')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: '查询并获取视频' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: '重新加载' }));
    await waitFor(() =>
      expect(
        vi.mocked(managementRequest).mock.calls.filter(([path]) => path === '/account/runs/run-a'),
      ).toHaveLength(3),
    );
    expectReadOnly();
  });

  it('取回受理后的详情读取失败可以重连，重新加载只读并继续确认归档结果', async () => {
    let latest = { ...videoRun };
    let detailError = false;
    vi.mocked(managementRequest).mockImplementation(async (path, init) => {
      if (init?.method === 'POST') {
        latest = {
          ...latest,
          status: 'queued',
          recoverableVideo: false,
          updatedAt: '2026-09-12T00:02:00Z',
        };
        return { accepted: true, run: latest };
      }
      if (path === '/account/runs/run-a') {
        if (detailError) throw new Error('详情连接暂时不可用');
        return { run: latest };
      }
      return { runs: [latest], total: 1, page: 1, pageSize: 20 };
    });
    renderPage(<RunsPage userId="owner-a" />);
    await userEvent.click(await screen.findByRole('button', { name: '详情' }));
    const dialog = await screen.findByRole('dialog', { name: '任务详情' });
    await userEvent.click(await within(dialog).findByRole('button', { name: '查询并获取视频' }));
    await within(dialog).findByText('已受理，正在查询原视频任务');
    detailError = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['management', 'owner-a', 'run', false, run.id] });
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('详情连接暂时不可用');
    expect(within(dialog).queryByRole('button', { name: '查询并获取视频' })).toBeNull();
    expect(within(dialog).queryByText('视频资源已归档，可在资源库查看')).toBeNull();
    detailError = false;
    latest = {
      ...latest,
      status: 'succeeded',
      progress: 100,
      result: { asset: { assetId: 'reconnected-video-asset' } },
      updatedAt: '2026-09-12T00:03:00Z',
    };
    await userEvent.click(within(dialog).getByRole('button', { name: '重新加载' }));
    expect(await within(dialog).findByText('视频资源已归档，可在资源库查看')).toBeVisible();
    expect(
      vi.mocked(managementRequest).mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
  });

  it.each(['原执行授权已撤销', '查询请求未被受理'])(
    'POST 未受理时保留错误“%s”，不自动重复请求',
    async (message) => {
      vi.mocked(managementRequest).mockImplementation(async (path, init) => {
        if (init?.method === 'POST') {
          if (message === '原执行授权已撤销') throw new Error(message);
          return { accepted: false, run: videoRun };
        }
        if (path === '/account/runs/run-a') return { run: videoRun };
        return { runs: [videoRun], total: 1, page: 1, pageSize: 20 };
      });
      renderPage(<RunsPage userId="owner-a" />);
      await userEvent.click(await screen.findByRole('button', { name: '详情' }));
      const dialog = await screen.findByRole('dialog', { name: '任务详情' });
      await userEvent.click(await within(dialog).findByRole('button', { name: '查询并获取视频' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
      expect(within(dialog).queryByText('已受理，正在查询原视频任务')).toBeNull();
      expect(within(dialog).queryByText('视频资源已归档，可在资源库查看')).toBeNull();
      await act(async () => {
        await client.invalidateQueries({
          queryKey: ['management', 'owner-a', 'run', false, run.id],
        });
      });
      expect(
        vi.mocked(managementRequest).mock.calls.filter(([, init]) => init?.method === 'POST'),
      ).toHaveLength(1);
    },
  );

  it.each(['failed', 'cancelled', 'succeeded'])(
    '受理后 %s 无归档资源时明确显示失败',
    async (status) => {
      let latest = { ...videoRun };
      vi.mocked(managementRequest).mockImplementation(async (path, init) => {
        if (init?.method === 'POST') {
          latest = {
            ...latest,
            status: 'queued',
            recoverableVideo: false,
            updatedAt: '2026-09-12T00:02:00Z',
          };
          return { accepted: true, run: latest };
        }
        if (path === '/account/runs/run-a') return { run: latest };
        return { runs: [latest], total: 1, page: 1, pageSize: 20 };
      });
      renderPage(<RunsPage userId="owner-a" />);
      await userEvent.click(await screen.findByRole('button', { name: '详情' }));
      const dialog = await screen.findByRole('dialog', { name: '任务详情' });
      await userEvent.click(await within(dialog).findByRole('button', { name: '查询并获取视频' }));
      await within(dialog).findByText('已受理，正在查询原视频任务');
      latest = {
        ...latest,
        status,
        error: status === 'failed' ? '原平台任务结果暂不可用' : undefined,
        updatedAt: '2026-09-12T00:03:00Z',
      };
      await act(async () => {
        await client.invalidateQueries({
          queryKey: ['management', 'owner-a', 'run', false, run.id],
        });
      });
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        status === 'failed' ? '原平台任务结果暂不可用' : '原视频任务查询未得到可归档资源',
      );
      expect(within(dialog).queryByText('视频资源已归档，可在资源库查看')).toBeNull();
      expect(
        vi.mocked(managementRequest).mock.calls.filter(([, init]) => init?.method === 'POST'),
      ).toHaveLength(1);
    },
  );
});
