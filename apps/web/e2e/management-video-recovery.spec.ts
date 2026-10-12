/** 后台恢复只查询原视频任务；所有业务请求均由本地合成夹具响应。 */
import { expect, test, type Page, type Route } from '@playwright/test';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

/** 合成管理员与原资源用户使用不同身份，检验结果资源不会归入管理员账户。 */
const admin = {
  id: 'recovery-admin',
  displayName: '恢复验收管理员',
  role: 'admin',
  createdAt: '2026-10-12T00:00:00.000Z',
};
/** 原视频任务及后续归档资源的唯一所属用户。 */
const owner = {
  id: 'original-video-owner',
  displayName: '原视频用户',
  role: 'user',
  status: 'active',
  createdAt: admin.createdAt,
};

/** 浏览器只使用管理 API 的展示字段，不伪造或提交平台任务身份。 */
type FixtureRun = {
  id: string;
  projectId: string;
  targetNodeId: string;
  status: string;
  progress: number;
  provider: string;
  modelAlias: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  user: typeof owner;
  recoverableVideo: boolean;
  result?: { summary: string; asset: { assetId: string } };
};

/** 建立原 Run，恢复过程中始终保留 id、projectId 和 ownerId。 */
function runFixture(status: string, recoverableVideo: boolean): FixtureRun {
  return {
    id: `original-${status}-${recoverableVideo ? 'recoverable' : 'unavailable'}`,
    projectId: 'original-video-project',
    targetNodeId: 'original-video-node',
    status,
    progress: 60,
    provider: 'newapi',
    modelAlias: 'fixture-video',
    error: ['cancelled', 'failed'].includes(status) ? '历史任务未归档' : undefined,
    createdAt: admin.createdAt,
    updatedAt: '2026-10-12T00:01:00.000Z',
    ownerId: owner.id,
    user: owner,
    recoverableVideo,
  };
}

/** 返回合成 JSON，不读取 API、数据库、R2 或供应商。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * 隔离全部 API、外部 HTTP 和 WebSocket；仅放行本地 Web 静态资源。
 * 恢复 POST 使原 Run 离开状态筛选，两个独立详情 GET 后返回原用户的归档资源。
 */
async function installFixture(page: Page, initialRun: FixtureRun) {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error('缺少独立本地 Web 地址');
  const webURL = new URL(baseURL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(webURL.hostname) || webURL.port === '8080')
    throw new Error('后台恢复烟测只允许独立本地 Web，禁止访问用户项目');
  let run = initialRun;
  let recoveryAccepted = false;
  let detailUnavailable = false;
  let recoveryPolls = 0;
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const reads: string[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: Array<{ text: string; url: string }> = [];
  const expectedFailures = new Set<string>();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  await page.addInitScript((user) => {
    localStorage.setItem('multimodal-canvas:theme', 'light');
    localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user }));
  }, admin);
  await page.context().routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    if (url.host === webURL.host && url.pathname === '/' && url.searchParams.has('token')) {
      socket.send(JSON.stringify({ type: 'connected' }));
      return;
    }
    unexpected.push(`WebSocket ${url.origin}${url.pathname}`);
    socket.close();
  });
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith('/v1/')) {
      const documentRequest = request.resourceType() === 'document' && path === '/admin/runs';
      const staticRequest =
        ['script', 'stylesheet', 'font', 'image', 'media'].includes(request.resourceType()) &&
        /^\/(?:assets\/|brand\/|src\/|node_modules\/|@vite\/|@id\/|@fs\/|@react-refresh$)/.test(
          path,
        );
      if (url.origin === webURL.origin && method === 'GET') {
        if (documentRequest || staticRequest) return route.continue();
        if (path === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
      }
      unexpected.push(`${method} ${url.origin}${path}`);
      return route.abort('blockedbyclient');
    }
    if (!['http://localhost:3000', webURL.origin].includes(url.origin)) {
      unexpected.push(`${method} ${url.origin}${path}`);
      return route.abort('blockedbyclient');
    }
    if (method === 'GET') reads.push(`${path}${url.search}`);
    else
      writes.push({
        method,
        path,
        body: request.postData() === null ? null : request.postDataJSON(),
      });
    if (method === 'GET' && path === '/v1/auth/me')
      return json(route, { user: admin, expiresAt: '2099-01-01T00:00:00.000Z' });
    if (method === 'GET' && path === '/v1/projects') return json(route, { projects: [] });
    if (method === 'GET' && path === '/v1/admin/resource-groups')
      return json(route, {
        groups: [{ ownerId: owner.id, user: owner, resourceCount: 0, storageBytes: 0 }],
      });
    if (method === 'GET' && path === '/v1/admin/runs') {
      const filter = url.searchParams.get('status');
      const runs = !filter || filter === run.status ? [run] : [];
      return json(route, { runs, total: runs.length, page: 1, pageSize: 20 });
    }
    if (method === 'GET' && path === `/v1/admin/runs/${run.id}`) {
      if (detailUnavailable) {
        expectedFailures.add(request.url());
        return json(route, { error: '原任务详情暂不可用' }, 503);
      }
      if (recoveryAccepted && ++recoveryPolls >= 2)
        run = {
          ...run,
          status: 'succeeded',
          progress: 100,
          updatedAt: '2026-10-12T00:03:00.000Z',
          result: {
            summary: '原视频任务已完成，资源属于原视频用户',
            asset: { assetId: 'original-owner-recovered-video' },
          },
        };
      return json(route, { run });
    }
    if (method === 'POST' && path === `/v1/admin/runs/${run.id}/recover`) {
      recoveryAccepted = true;
      run = {
        ...run,
        status: 'queued',
        progress: 0,
        error: undefined,
        recoverableVideo: false,
        updatedAt: '2026-10-12T00:02:00.000Z',
      };
      return json(route, { accepted: true, run }, 202);
    }
    unexpected.push(`${method} ${path}`);
    return route.abort('blockedbyclient');
  });
  return {
    writes,
    reads,
    unexpected,
    pageErrors,
    consoleErrors,
    expectedFailures,
    recoveryPolls: () => recoveryPolls,
    rejectDetail: () => {
      detailUnavailable = true;
    },
  };
}

/** 校验没有未声明网络访问或浏览器异常；只允许刻意注入的详情 HTTP 503 日志。 */
function expectIsolated(fixture: Awaited<ReturnType<typeof installFixture>>) {
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
  expect(
    fixture.consoleErrors.filter(
      (error) =>
        !(
          fixture.expectedFailures.has(error.url) &&
          /Failed to load resource: the server responded with a status of 503\b/.test(error.text)
        ),
    ),
  ).toEqual([]);
}

for (const initialStatus of ['cancelled', 'failed']) {
  test(`后台获取历史 ${initialStatus} 原视频，离开状态筛选后详情仍轮询至归档`, async ({
    page,
  }, info) => {
    const run = runFixture(initialStatus, true);
    const fixture = await installFixture(page, run);
    await page.goto('/admin/runs');
    await expect(page.getByRole('heading', { name: '全站任务' })).toBeVisible();
    await page.getByRole('combobox', { name: '任务状态' }).click();
    await page
      .getByRole('option', { name: initialStatus === 'cancelled' ? '已取消' : '失败' })
      .click();
    const row = page.getByRole('row').filter({ hasText: run.id });
    await expect(row.getByText(owner.displayName, { exact: true })).toBeVisible();
    await row.getByRole('button', { name: '详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '任务详情' });
    const retrieve = dialog.getByRole('button', { name: '查询并获取视频', exact: true });
    await expect(retrieve).toBeEnabled();
    await expect(dialog.getByRole('link', { name: '查看结果资源' })).toHaveAttribute(
      'href',
      `/admin/users/${owner.id}/resources`,
    );
    await expect(dialog.getByRole('link', { name: '返回画布' })).toHaveCount(0);
    expect(fixture.writes).toEqual([]);
    await page.screenshot({
      path: info.outputPath('historical-video-detail.png'),
      animations: 'disabled',
    });
    await retrieve.click();
    await expect(dialog.getByText('已受理，正在查询原视频任务', { exact: true })).toBeVisible();
    await expect(page.getByText('没有符合条件的任务', { exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: run.id })).toHaveCount(0);
    await expect(dialog.getByText('视频资源已归档，可在资源库查看', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog.getByText('已完成', { exact: true })).toBeVisible();
    await expect(dialog.getByText('100%', { exact: true })).toBeVisible();
    await expect(dialog.getByText(run.id, { exact: true })).toBeVisible();
    await expect(
      dialog.getByText('原视频任务已完成，资源属于原视频用户', { exact: true }),
    ).toBeVisible();
    await expect(retrieve).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath('original-owner-video-archived.png'),
      animations: 'disabled',
    });
    expect(fixture.recoveryPolls()).toBeGreaterThanOrEqual(2);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]).toMatchObject({
      method: 'POST',
      path: `/v1/admin/runs/${run.id}/recover`,
    });
    expect([null, {}]).toContainEqual(fixture.writes[0]!.body);
    expectIsolated(fixture);
  });
}

for (const status of ['cancelled', 'failed', 'queued', 'running', 'succeeded']) {
  test(`不可恢复的 ${status} 任务不显示获取入口`, async ({ page }) => {
    const run = runFixture(status, false);
    const fixture = await installFixture(page, run);
    await page.goto('/admin/runs');
    await page
      .getByRole('row')
      .filter({ hasText: run.id })
      .getByRole('button', { name: '详情', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: '任务详情' });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() => fixture.reads.filter((path) => path === `/v1/admin/runs/${run.id}`).length)
      .toBeGreaterThan(0);
    await expect(dialog.getByRole('button', { name: '查询并获取视频', exact: true })).toHaveCount(
      0,
    );
    expect(fixture.writes).toEqual([]);
    expectIsolated(fixture);
  });
}

test('详情 GET 故障后不会使用此前可恢复的缓存发起恢复', async ({ page }, info) => {
  const run = runFixture('cancelled', true);
  const fixture = await installFixture(page, run);
  await page.goto('/admin/runs');
  await page.getByRole('button', { name: '详情', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '任务详情' });
  const retrieve = dialog.getByRole('button', { name: '查询并获取视频', exact: true });
  await expect(retrieve).toBeEnabled();
  fixture.rejectDetail();
  await expect(dialog.getByText('原任务详情暂不可用', { exact: true })).toBeVisible({
    timeout: 8_000,
  });
  await expect(dialog.getByText(run.id, { exact: true })).toBeVisible();
  await expect(retrieve).toHaveCount(0);
  await dialog.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(dialog.getByText('原任务详情暂不可用', { exact: true })).toBeVisible();
  await expect(retrieve).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('detail-failure-blocks-stale-recovery.png'),
    animations: 'disabled',
  });
  expect(fixture.writes).toEqual([]);
  expectIsolated(fixture);
});
