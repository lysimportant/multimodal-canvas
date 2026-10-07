import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { canvasDocumentSchema, type Asset, type RunRecord } from '@multimodal-canvas/domain';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

/** 使用本地视频验证失败任务的手动获取；所有业务请求均由隔离夹具响应。 */
const video = readFileSync(new URL('../public/demo/field-study.mp4', import.meta.url));
const project = {
  id: 'video-manual-recovery',
  name: '原视频任务恢复验收',
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:01:00.000Z',
};

/** 返回合成 JSON，不连接 API、队列或供应商。 */
async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
}

/** 建立原失败 Run，记录恢复请求、新建请求及控制台错误。 */
async function installFixture(page: Page, rejectRecovery = false) {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error('缺少本地 Web 地址');
  const webUrl = new URL(baseURL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(webUrl.hostname) || webUrl.port === '8080')
    throw new Error('恢复冒烟只允许独立本地 Web，禁止访问用户项目');
  let canvas = canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: 'video-node',
        type: 'video',
        position: { x: 420, y: 220 },
        width: 360,
        height: 280,
        data: {
          label: '视频生成节点',
          mediaType: 'video',
          mode: 'generate',
          prompt: 'Show a desk beside a bright window.',
          modelAlias: 'fixture-video',
          credentialId: 'fixture-credential',
          videoMode: 'text_to_video',
        },
      },
    ],
    edges: [],
  });
  let run: RunRecord = {
    id: 'run-video-original',
    projectId: project.id,
    targetNodeId: 'video-node',
    status: 'failed',
    progress: 60,
    attempt: 1,
    provider: 'newapi',
    modelAlias: 'fixture-video',
    snapshot: {
      projectId: project.id,
      targetNodeId: 'video-node',
      canvasRevision: 1,
      modelAlias: 'fixture-video',
      parameters: {},
      submittedAt: project.createdAt,
      nodes: canvas.nodes,
      edges: [],
      inputs: [],
    },
    providerJob: {
      id: 'provider-original',
      provider: 'newapi',
      platformJobId: 'platform-original',
      status: 'failed',
      progress: 60,
      payload: { contract: 'legacy-v1' },
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    error: '原任务查询超时',
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
  const assets: Asset[] = [];
  const errors: string[] = [];
  const recoveries: unknown[] = [];
  const creates: string[] = [];
  let polls = 0;
  let recovered = false;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        user: {
          id: 'fixture-user',
          displayName: '恢复验收用户',
          role: 'admin',
          createdAt: '2026-10-07T00:00:00.000Z',
        },
      }),
    );
  });
  await page.context().routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    if (url.host === webUrl.host && url.pathname === '/' && url.searchParams.has('token')) {
      socket.send(JSON.stringify({ type: 'connected' }));
      return;
    }
    errors.push(`已阻断未声明 WebSocket：${url.origin}${url.pathname}`);
    socket.close();
  });
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin === webUrl.origin &&
      request.method() === 'GET' &&
      !['fetch', 'xhr', 'eventsource'].includes(request.resourceType()) &&
      (url.pathname === `/projects/${project.id}` ||
        /^\/(?:@vite\/|@id\/|@fs\/|@react-refresh$|src\/|node_modules\/|assets\/|demo\/|brand\/|favicon\.)/.test(
          url.pathname,
        ))
    )
      return route.continue();
    errors.push(`已阻断未声明请求：${request.method()} ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/auth/me')
      return json(route, {
        user: {
          id: 'fixture-user',
          displayName: '恢复验收用户',
          role: 'admin',
          createdAt: project.createdAt,
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    if (path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (path.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path.endsWith('/canvas')) {
      if (request.method() === 'PATCH')
        canvas = { ...request.postDataJSON(), revision: canvas.revision + 1 };
      return json(route, { canvas });
    }
    if (path.endsWith('/models/defaults')) return json(route, { defaults: {} });
    if (path === `/v1/projects/${project.id}/runs`) return json(route, { runs: [run] });
    if (path === `/v1/runs/${run.id}/recover` && request.method() === 'POST') {
      recoveries.push(request.postDataJSON());
      if (rejectRecovery) return json(route, { error: '原视频节点缺少匹配的平台任务身份' }, 409);
      recovered = true;
      run = {
        ...run,
        status: 'queued',
        progress: 0,
        error: undefined,
        updatedAt: '2026-10-07T00:02:00.000Z',
      };
      return json(route, { run }, 202);
    }
    if (path === `/v1/runs/${run.id}` && request.method() === 'GET') {
      if (recovered && ++polls >= 2) {
        const asset = {
          id: 'recovered-video',
          name: '原任务视频',
          mediaType: 'video' as const,
          mimeType: 'video/mp4',
          sizeBytes: video.byteLength,
          status: 'ready' as const,
          latestVersion: 1,
          contentUrl: '/v1/assets/recovered-video/content',
          tags: [],
        };
        if (!assets.length) assets.push(asset);
        run = {
          ...run,
          status: 'succeeded',
          progress: 100,
          updatedAt: '2026-10-07T00:03:00.000Z',
          result: {
            provider: 'newapi',
            summary: '原任务已完成',
            targetNodeId: 'video-node',
            mediaType: 'video',
            inputCount: 0,
            asset: {
              assetId: asset.id,
              version: 1,
              contentUrl: asset.contentUrl,
              mimeType: asset.mimeType,
              sizeBytes: asset.sizeBytes,
            },
          },
        };
      }
      return json(route, { run });
    }
    if (
      request.method() === 'POST' &&
      (path === '/v1/runs' || path.endsWith('/runs') || path.endsWith('/retry'))
    ) {
      creates.push(path);
      return json(route, { error: '验收禁止创建新任务' }, 409);
    }
    if (path === '/v1/assets') return json(route, { assets });
    if (path.endsWith('/request-prompts')) return json(route, { records: [] });
    if (path.endsWith('/reverse-prompts')) return json(route, { analysis: null });
    if (path.endsWith('/access-url'))
      return json(route, { url: '/v1/assets/recovered-video/content' });
    if (path.endsWith('/content')) return route.fulfill({ contentType: 'video/mp4', body: video });
    if (path === '/v1/account/newapi')
      return json(route, {
        account: {
          issuer: 'https://newapi.example.test',
          externalUserId: 'fixture-external',
          displayName: '恢复验收用户',
          status: 'active',
          groups: [
            { group: 'alpha', credentialId: 'fixture-credential', status: 'ready', modelCount: 1 },
          ],
          links: {},
        },
      });
    if (path === '/v1/settings/ai')
      return json(route, {
        settings: { defaultModels: { video: 'fixture-video' }, timeoutMs: 900_000 },
      });
    if (path === '/v1/models')
      return json(route, {
        models: [
          {
            id: 'fixture-video',
            name: 'Fixture video',
            mediaTypes: ['video'],
            group: 'alpha',
            credentialId: 'fixture-credential',
            available: true,
          },
        ],
      });
    errors.push(`未声明接口：${request.method()} ${path}`);
    return route.abort('blockedbyclient');
  });
  await page.goto(`/projects/${project.id}`);
  const node = page.locator('.react-flow__node[data-id="video-node"]');
  await expect(node.getByRole('button', { name: '获取资源', exact: true })).toBeVisible();
  return { node, errors, recoveries, creates };
}

test('失败视频手动查询原任务并回显，期间不创建新生成请求', async ({ page }) => {
  const fixture = await installFixture(page);
  await expect(fixture.node.getByRole('button', { name: '重试生成', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('failed-video-actions.png') });
  await fixture.node.getByRole('button', { name: '获取资源', exact: true }).click();
  await expect(page.getByText('已获取原任务资源', { exact: true })).toBeVisible();
  await expect(fixture.node.locator('video')).toBeVisible();
  await expect
    .poll(() =>
      fixture.node.locator('video').evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('recovered-video.png') });
  expect(fixture.recoveries).toEqual([{ retrieveOnly: true }]);
  expect(fixture.creates).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('原任务不可恢复时保留手动入口，不自动重试生成', async ({ page }) => {
  const fixture = await installFixture(page, true);
  await fixture.node.getByRole('button', { name: '获取资源', exact: true }).click();
  await expect(fixture.node.getByText('原视频节点缺少匹配的平台任务身份')).toBeVisible();
  await expect(fixture.node.getByRole('button', { name: '获取资源', exact: true })).toBeEnabled();
  await expect(fixture.node.getByRole('button', { name: '重试生成', exact: true })).toBeEnabled();
  expect(fixture.recoveries).toEqual([{ retrieveOnly: true }]);
  expect(fixture.creates).toEqual([]);
  // HTTP 409 是夹具刻意返回的业务拒绝；页面异常及其他控制台错误仍视为失败。
  expect(fixture.errors.filter((message) => !message.includes('409'))).toEqual([]);
});
