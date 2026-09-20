import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Asset, CanvasDocument, ModelSelection, RunRecord } from '@multimodal-canvas/domain';
import type { ReversePromptAnalysis } from '../src/reverse-prompts';

/** 反推验收只使用本地图片和合成 API，不访问真实供应商。 */
const imageBytes = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
const project = {
  id: 'reverse-prompt-browser',
  name: '反推提示词验收',
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:00:12.400Z',
};
const requestText = 'Keep the original image composition and lighting.';
const reverseSummary = '近景中的花苞与绿色叶片，背景自然虚化。';
const reverseText =
  '微距摄影，一枚红色花苞位于画面中央，周围是带紫色边缘的绿色叶片。柔和的自然光，浅景深，绿色和褐色背景虚化。';

/** 返回稳定的 JSON 响应；status 只用于模拟提交，不穿透到外部服务。 */
async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
}

/** 创建带精确版本的本地图片资源。 */
function imageAsset(id: string): Asset {
  return {
    id,
    name: `${id}.jpg`,
    mediaType: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: imageBytes.byteLength,
    status: 'ready',
    latestVersion: 1,
    contentUrl: `/v1/assets/${id}/versions/1/content`,
    tags: [],
  };
}

/** 模拟保存、上传、生成和反推各自的接口，保留 POST 证据以检查去重。 */
async function installFixture(
  page: Page,
  options: {
    configuredDefault?: ModelSelection;
    role?: 'admin' | 'user';
    replayHistory?: boolean;
    sourceAsset?: boolean;
    failFirstReverse?: boolean;
  } = {},
) {
  let canvas: CanvasDocument = {
    revision: 1,
    nodes: [
      {
        id: 'image-node',
        type: 'image',
        position: { x: 300, y: 250 },
        width: 320,
        height: 240,
        data: {
          label: '图片节点',
          mediaType: 'image',
          mode: 'generate',
          enabled: true,
          prompt: requestText,
          modelAlias: 'mock-image',
          credentialId: 'connection-a',
          assetId: 'history-image',
          contentUrl: '/v1/assets/history-image/versions/1/content',
          mimeType: 'image/jpeg',
        },
      },
    ],
    edges: [],
  };
  const assets = new Map([['history-image', imageAsset('history-image')]]);
  if (options.sourceAsset) {
    canvas.nodes[0]!.data.mode = 'source';
    assets.set('history-image', { ...imageAsset('history-image'), latestVersion: 2 });
  }
  const analyses = new Map<string, ReversePromptAnalysis>();
  const reversePosts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const reverseGets: URL[] = [];
  const settingsReads: string[] = [];
  const errors: string[] = [];
  const settings = {
    defaultModels: options.configuredDefault ? { text: options.configuredDefault } : {},
    timeoutMs: 900_000,
  };
  const makeRun = (id: string, assetId: string): RunRecord => ({
    id,
    projectId: project.id,
    targetNodeId: 'image-node',
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    provider: 'mock',
    modelAlias: 'mock-image',
    snapshot: {
      projectId: project.id,
      canvasRevision: canvas.revision,
      targetNodeId: 'image-node',
      modelAlias: 'mock-image',
      parameters: {},
      submittedAt: project.createdAt,
      nodes: canvas.nodes,
      edges: [],
      inputs: [],
    },
    result: {
      provider: 'mock',
      summary: '图片已完成',
      targetNodeId: 'image-node',
      mediaType: 'image',
      inputCount: 0,
      asset: {
        assetId,
        version: 1,
        contentUrl: `/v1/assets/${assetId}/versions/1/content`,
        mimeType: 'image/jpeg',
        sizeBytes: imageBytes.byteLength,
      },
    },
    nodeTimings: {
      'image-node': {
        nodeId: 'image-node',
        startedAt: project.createdAt,
        finishedAt: project.updatedAt,
        outcome: 'succeeded',
      },
    },
    createdAt: id === 'history-run' ? project.createdAt : '2026-09-17T11:00:00.000Z',
    updatedAt: id === 'history-run' ? project.updatedAt : '2026-09-17T11:00:12.400Z',
  });
  const runs = new Map<string, RunRecord>(
    options.sourceAsset ? [] : [['history-run', makeRun('history-run', 'history-image')]],
  );
  let eventRequests = 0;
  let releaseHistory = () => {};
  const historyGate = options.replayHistory
    ? new Promise<void>((resolve) => {
        releaseHistory = resolve;
      })
    : Promise.resolve();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      if (options.failFirstReverse && message.text() === 'Failed to load resource: net::ERR_FAILED')
        return;
      errors.push(message.text());
    }
  });
  await page.addInitScript(
    ({ role }) => {
      localStorage.setItem(
        'multimodal-canvas:auth-session',
        JSON.stringify({
          user: {
            id: 'reverse-user',
            displayName: '反推验收用户',
            role,
            createdAt: '2026-09-17T10:00:00.000Z',
          },
        }),
      );
    },
    { role: options.role ?? 'admin' },
  );
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method === 'GET' && path === '/v1/auth/me')
      return json(route, {
        user: {
          id: 'reverse-user',
          displayName: '反推验收用户',
          role: options.role ?? 'admin',
          createdAt: project.createdAt,
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    if (path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (path.endsWith('/events')) {
      eventRequests += 1;
      return route.fulfill({
        contentType: 'text/event-stream',
        body: options.replayHistory
          ? `event: run.updated\ndata: ${JSON.stringify(runs.get('history-run'))}\n\n`
          : ': ready\n\n',
      });
    }
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path.endsWith('/canvas')) {
      if (method === 'PATCH') canvas = { ...request.postDataJSON(), revision: canvas.revision + 1 };
      return json(route, { canvas });
    }
    if (path.endsWith('/models/defaults')) return json(route, { defaults: {} });
    if (path === '/v1/settings/ai') {
      settingsReads.push(path);
      return json(route, { settings });
    }
    if (path === '/v1/models') {
      return json(route, {
        models: [
          {
            id: 'first-text',
            name: '第一个文字模型',
            mediaTypes: ['text'],
            group: 'alpha',
            credentialId: 'connection-a',
            available: true,
          },
          {
            id: 'shared-text',
            name: '同名文字模型',
            mediaTypes: ['text'],
            group: 'alpha',
            credentialId: 'connection-a',
            available: true,
          },
          {
            id: 'mock-image',
            name: '图片模型',
            mediaTypes: ['image'],
            group: 'alpha',
            credentialId: 'connection-a',
            available: true,
          },
          {
            id: 'shared-text',
            name: '同名文字模型',
            mediaTypes: ['text'],
            group: 'beta',
            credentialId: 'connection-b',
            available: true,
          },
        ],
      });
    }
    if (path.endsWith('/reverse-prompts')) {
      const assetId = path.split('/')[3]!;
      if (method === 'POST') {
        const body = request.postDataJSON() as Record<string, unknown>;
        reversePosts.push({ path, body });
        if (options.failFirstReverse && reversePosts.length === 1) return route.abort('failed');
        const analysis: ReversePromptAnalysis = {
          runId: `analysis-${reversePosts.length}`,
          assetId,
          assetVersion: 1,
          status: 'queued',
          modelAlias: typeof body.modelAlias === 'string' ? body.modelAlias : 'first-text',
          ...(typeof body.credentialId === 'string' ? { credentialId: body.credentialId } : {}),
        };
        analyses.set(assetId, analysis);
        return json(route, { analysis }, 202);
      }
      reverseGets.push(url);
      const previous = analyses.get(assetId);
      const analysis = previous
        ? {
            ...previous,
            status: 'succeeded' as const,
            summary: reverseSummary,
            prompt: reverseText,
          }
        : null;
      if (analysis) analyses.set(assetId, analysis);
      return json(route, {
        analysis,
        defaultModel: options.configuredDefault ?? {
          modelAlias: 'first-text',
          credentialId: 'connection-a',
        },
      });
    }
    if (path.includes('/request-prompts')) {
      const assetId = path.split('/')[3]!;
      return json(route, {
        records:
          assetId === 'history-image'
            ? [
                {
                  id: 'original-request',
                  schemaVersion: 1,
                  runId: 'history-run',
                  nodeId: 'image-node',
                  attempt: 1,
                  requestIdentity: 'POST /images/generations#1',
                  provider: 'mock',
                  modelAlias: 'mock-image',
                  mediaType: 'image',
                  format: 'plain',
                  parts: [{ order: 0, text: requestText }],
                  resources: [],
                  sendStatus: 'sent',
                  createdAt: project.createdAt,
                  assetId,
                  assetVersion: 1,
                  summary: '原生成摘要。',
                },
              ]
            : [],
      });
    }
    if (path === '/v1/assets') return json(route, { assets: [...assets.values()] });
    if (path.endsWith('/versions')) {
      const assetId = path.split('/')[3]!;
      return json(route, {
        versions: (options.sourceAsset ? [1, 2] : [1]).map((version) => ({
          id: `${assetId}-v${version}`,
          assetId,
          version,
          sizeBytes: imageBytes.byteLength,
          createdAt: project.createdAt,
          contentUrl: `/v1/assets/${assetId}/versions/${version}/content`,
        })),
      });
    }
    if (path.endsWith('/access-url'))
      return json(route, { url: path.replace('/access-url', '/versions/1/content') });
    if (path.endsWith('/content'))
      return route.fulfill({ contentType: 'image/jpeg', body: imageBytes });
    if (path === `/v1/projects/${project.id}/runs`) {
      await historyGate;
      return json(route, { runs: [...runs.values()] });
    }
    if (/^\/v1\/runs\/[^/]+$/.test(path))
      return json(route, { run: runs.get(path.split('/')[3]!) });
    errors.push(`未声明的隔离接口：${method} ${path}`);
    return route.fulfill({ status: 404, body: '未声明的隔离接口' });
  });
  return {
    errors,
    reversePosts,
    reverseGets,
    settingsReads,
    releaseHistory,
    eventRequests: () => eventRequests,
  };
}

/** 从悬浮卡片直接进入资源说明。 */
async function openPrompt(page: Page) {
  const node = page.locator('.react-flow__node[data-id="image-node"]');
  await expect(node).toBeVisible();
  await node.hover();
  await node.getByRole('button', { name: '查看生成提示词：图片节点' }).click();
  const dialog = page.getByRole('dialog', { name: '生成提示词', exact: true });
  await expect(dialog.getByRole('combobox', { name: '反推文字模型' })).toBeVisible();
  return dialog;
}

test('反推默认遵循设置，模型与连接可调整，结果独立展示且重开不重发', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await installFixture(page, {
    configuredDefault: { modelAlias: 'shared-text', credentialId: 'connection-b' },
  });
  await page.goto(`/projects/${project.id}`);
  const dialog = await openPrompt(page);
  const model = dialog.getByRole('combobox', { name: '反推文字模型' });
  await expect(model).toHaveValue(JSON.stringify(['shared-text', 'connection-b']));
  await expect(model.locator('option')).toHaveCount(3);
  await model.selectOption(JSON.stringify(['shared-text', 'connection-a']));
  await dialog.getByRole('button', { name: '反推提示词', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '反推整体摘要', exact: true })).toContainText(
    reverseSummary,
  );
  await expect(dialog.getByRole('region', { name: '反推详细提示词', exact: true })).toContainText(
    reverseText,
  );
  await expect(dialog.getByRole('region', { name: '完整提示词', exact: true })).toContainText(
    requestText,
  );
  await expect(dialog.getByRole('region', { name: '整体摘要', exact: true })).toContainText(
    '原生成摘要。',
  );
  expect(fixture.reversePosts).toHaveLength(1);
  expect(fixture.reversePosts[0]).toEqual({
    path: '/v1/assets/history-image/versions/1/reverse-prompts',
    body: {
      projectId: project.id,
      modelAlias: 'shared-text',
      credentialId: 'connection-a',
      idempotencyKey: expect.stringMatching(/^reverse-prompt-/),
    },
  });
  expect(fixture.reverseGets.some((url) => url.searchParams.get('runId') === 'analysis-1')).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('reverse-prompt-result.png') });
  await dialog.getByRole('button', { name: '关闭生成提示词' }).click();
  const reopened = await openPrompt(page);
  await expect(reopened.getByRole('region', { name: '反推详细提示词', exact: true })).toContainText(
    reverseText,
  );
  expect(fixture.reversePosts).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('未设置默认文字模型时选择第一个文字模型', async ({ page }) => {
  const fixture = await installFixture(page);
  await page.goto(`/projects/${project.id}`);
  const dialog = await openPrompt(page);
  await expect(dialog.getByRole('combobox', { name: '反推文字模型' })).toHaveValue(
    JSON.stringify(['first-text', 'connection-a']),
  );
  await dialog.getByRole('button', { name: '反推提示词', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '反推详细提示词', exact: true })).toContainText(
    reverseText,
  );
  expect(fixture.reversePosts[0]!.body).toMatchObject({
    modelAlias: 'first-text',
    credentialId: 'connection-a',
  });
  expect(fixture.reversePosts).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('普通账号使用服务端返回的分组默认模型', async ({ page }) => {
  const fixture = await installFixture(page, {
    role: 'user',
    configuredDefault: { modelAlias: 'shared-text', credentialId: 'connection-b' },
  });
  await page.goto(`/projects/${project.id}`);
  const dialog = await openPrompt(page);
  await expect(dialog.getByRole('combobox', { name: '反推文字模型' })).toHaveValue(
    JSON.stringify(['shared-text', 'connection-b']),
  );
  expect(fixture.settingsReads).toEqual(['/v1/settings/ai']);
  expect(fixture.reversePosts).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('先于 REST 恢复的历史 SSE 成功事件不会自动触发反推', async ({ page }) => {
  const fixture = await installFixture(page, { replayHistory: true });
  await page.goto(`/projects/${project.id}`);
  await expect.poll(fixture.eventRequests).toBeGreaterThan(0);
  expect(fixture.reversePosts).toHaveLength(0);
  fixture.releaseHistory();
  const dialog = await openPrompt(page);
  await expect(dialog.getByRole('region', { name: '完整提示词', exact: true })).toContainText(
    requestText,
  );
  expect(fixture.reversePosts).toHaveLength(0);
  await page.reload();
  await openPrompt(page);
  expect(fixture.reversePosts).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test('来源节点仍展示旧版本时，反推使用当前回显版本而非资源最新版本', async ({ page }) => {
  const fixture = await installFixture(page, { sourceAsset: true });
  await page.goto(`/projects/${project.id}`);
  const dialog = await openPrompt(page);
  await dialog.getByRole('button', { name: '反推提示词', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '反推详细提示词', exact: true })).toContainText(
    reverseText,
  );
  expect(fixture.reversePosts).toHaveLength(1);
  expect(fixture.reversePosts[0]!.path).toBe('/v1/assets/history-image/versions/1/reverse-prompts');
  expect(fixture.errors).toEqual([]);
});

test('提交网络结果未知后关闭重开，显式重试复用原模型与请求键', async ({ page }) => {
  const fixture = await installFixture(page, { failFirstReverse: true });
  await page.goto(`/projects/${project.id}`);
  const dialog = await openPrompt(page);
  await dialog
    .getByRole('combobox', { name: '反推文字模型' })
    .selectOption(JSON.stringify(['shared-text', 'connection-b']));
  await dialog.getByRole('button', { name: '反推提示词', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(fixture.reversePosts).toHaveLength(1);
  await dialog.getByRole('button', { name: '关闭生成提示词' }).click();
  const reopened = await openPrompt(page);
  const model = reopened.getByRole('combobox', { name: '反推文字模型' });
  await expect(model).toHaveValue(JSON.stringify(['shared-text', 'connection-b']));
  await expect(model).toBeDisabled();
  expect(fixture.reversePosts).toHaveLength(1);
  await reopened.getByRole('button', { name: '反推提示词', exact: true }).click();
  await expect(reopened.getByRole('region', { name: '反推详细提示词', exact: true })).toContainText(
    reverseText,
  );
  expect(fixture.reversePosts).toHaveLength(2);
  expect(fixture.reversePosts[1]).toEqual(fixture.reversePosts[0]);
  expect(fixture.errors).toEqual([]);
});
