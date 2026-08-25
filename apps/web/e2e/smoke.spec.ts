import { expect, test, type Page, type Route } from '@playwright/test';
import type { Asset, CanvasDocument, RunRecord } from '@multimodal-canvas/domain';

type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type AiSettings = {
  baseUrl: string;
  configured: boolean;
  keyFingerprint?: string;
  defaultModels: Record<string, string>;
};

const project: Project = {
  id: 'project-smoke',
  name: 'Smoke 项目',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const emptyCanvas: CanvasDocument = {
  revision: 0,
  nodes: [],
  edges: [],
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockApi(page: Page) {
  let settings: AiSettings = {
    baseUrl: '',
    configured: false,
    defaultModels: {},
  };
  const models = [
    { id: 'mock-text', name: 'Mock Text', mediaTypes: ['text'] },
    { id: 'mock-text-v2', name: 'Mock Text v2', mediaTypes: ['text'] },
    { id: 'mock-image', name: 'Mock Image', mediaTypes: ['image'] },
    { id: 'mock-audio', name: 'Mock Audio', mediaTypes: ['audio'] },
    { id: 'mock-video', name: 'Mock Video', mediaTypes: ['video'] },
  ];

  const assets: Asset[] = [];
  const pendingUploads = new Map<
    string,
    { name: string; mimeType: string; sizeBytes: number; sha256: string }
  >();
  const runs = new Map<string, RunRecord>();
  let currentCanvas: CanvasDocument = structuredClone(emptyCanvas);
  let uploadSequence = 0;

  const assetMediaType = (mimeType: string): Asset['mediaType'] => {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'text';
  };

  const createRun = (nodeId: string, body: Record<string, unknown>): RunRecord => {
    const node = currentCanvas.nodes.find((item) => item.id === nodeId);
    const mediaType = node?.data.mediaType ?? 'text';
    const modelAlias =
      typeof body.modelAlias === 'string' && body.modelAlias.length > 0
        ? body.modelAlias
        : (settings.defaultModels[mediaType] ?? `mock-${mediaType}`);
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: `run-${nodeId}`,
      projectId: project.id,
      targetNodeId: nodeId,
      status: 'succeeded',
      progress: 100,
      attempt: 1,
      provider: 'mock',
      modelAlias,
      snapshot: {
        projectId: project.id,
        canvasRevision: currentCanvas.revision,
        targetNodeId: nodeId,
        modelAlias,
        parameters: {},
        submittedAt: now,
        nodes: node ? [node] : [],
        edges: [],
        inputs: [],
      },
      result: {
        provider: 'mock',
        summary: 'Mock 结果已归档',
        targetNodeId: nodeId,
        mediaType,
        inputCount: 0,
        asset: {
          assetId: `result-${nodeId}`,
          version: 1,
          contentUrl: `/v1/assets/result-${nodeId}/content`,
          mimeType: mediaType === 'text' ? 'text/plain' : `${mediaType}/*`,
          sizeBytes: 16,
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    runs.set(run.id, run);
    return run;
  };

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === 'GET' && path === `/v1/projects/${project.id}/events`) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: ': ready\n\n',
      });
      return;
    }

    if (request.method() === 'GET' && path === '/v1/assets') {
      await json(route, { assets });
      return;
    }
    if (request.method() === 'POST' && path === '/v1/assets/uploads/init') {
      const body = request.postDataJSON() as {
        name: string;
        mimeType: string;
        sizeBytes: number;
        sha256: string;
      };
      const uploadId = `upload-${++uploadSequence}`;
      pendingUploads.set(uploadId, body);
      await json(route, {
        uploadId,
        uploadUrl: `/v1/assets/uploads/${uploadId}/content`,
        completeUrl: `/v1/assets/uploads/${uploadId}/complete`,
      });
      return;
    }
    if (request.method() === 'PUT' && /^\/v1\/assets\/uploads\/[^/]+\/content$/.test(path)) {
      await route.fulfill({ status: 200, body: '' });
      return;
    }
    if (request.method() === 'POST' && /^\/v1\/assets\/uploads\/[^/]+\/complete$/.test(path)) {
      const uploadId = path.split('/')[4];
      const metadata = pendingUploads.get(uploadId);
      const body = request.postDataJSON() as {
        name?: string;
        mimeType?: string;
        sizeBytes?: number;
        sha256?: string;
      };
      if (!metadata) {
        await json(route, { error: '上传会话不存在' }, 404);
        return;
      }
      const assetId = `asset-${uploadSequence}-${assets.length + 1}`;
      const asset: Asset = {
        id: assetId,
        name: body.name ?? metadata.name,
        mediaType: assetMediaType(body.mimeType ?? metadata.mimeType),
        mimeType: body.mimeType ?? metadata.mimeType,
        sizeBytes: body.sizeBytes ?? metadata.sizeBytes,
        sha256: body.sha256 ?? metadata.sha256,
        status: 'ready',
        contentUrl: `/v1/assets/${assetId}/content`,
        tags: [],
      };
      pendingUploads.delete(uploadId);
      assets.unshift(asset);
      await json(route, { asset }, 201);
      return;
    }
    if (request.method() === 'GET' && /^\/v1\/assets\/[^/]+\/content$/.test(path)) {
      const asset = assets.find((item) => item.contentUrl === path);
      await route.fulfill({
        status: 200,
        contentType: asset?.mimeType ?? 'text/plain',
        body: asset?.mediaType === 'image' ? Buffer.from('iVBORw0KGgo=', 'base64') : 'mock content',
      });
      return;
    }
    if (request.method() === 'GET' && path === '/v1/projects') {
      await json(route, { projects: [project] });
      return;
    }
    if (request.method() === 'POST' && path === '/v1/projects') {
      await json(route, { project }, 201);
      return;
    }
    if (request.method() === 'GET' && path === `/v1/projects/${project.id}`) {
      await json(route, { project });
      return;
    }
    if (request.method() === 'GET' && path === `/v1/projects/${project.id}/canvas`) {
      await json(route, { canvas: currentCanvas });
      return;
    }
    if (request.method() === 'PATCH' && path === `/v1/projects/${project.id}/canvas`) {
      const body = request.postDataJSON() as CanvasDocument;
      currentCanvas = { ...body, revision: currentCanvas.revision + 1 };
      await json(route, { canvas: currentCanvas });
      return;
    }
    if (request.method() === 'GET' && path === '/v1/models') {
      await json(route, { models });
      return;
    }
    if (request.method() === 'GET' && path === '/v1/settings/ai') {
      await json(route, { settings });
      return;
    }
    if (request.method() === 'PATCH' && path === '/v1/settings/ai') {
      const body = request.postDataJSON() as {
        baseUrl?: string;
        apiKey?: string;
        defaultModels?: Record<string, string | null>;
      };
      settings = {
        ...settings,
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.apiKey ? { configured: true, keyFingerprint: 'smoke-fingerprint' } : {}),
        ...(body.defaultModels
          ? {
              defaultModels: {
                ...settings.defaultModels,
                ...Object.fromEntries(
                  Object.entries(body.defaultModels).filter(([, value]) => value),
                ),
              },
            }
          : {}),
      };
      await json(route, { settings });
      return;
    }
    if (request.method() === 'POST' && path === '/v1/settings/ai/test') {
      await json(route, { result: { ok: true, modelCount: models.length } });
      return;
    }
    if (request.method() === 'POST' && path === '/v1/settings/ai/models/refresh') {
      await json(route, { models });
      return;
    }
    if (request.method() === 'DELETE' && path === '/v1/settings/ai/credentials') {
      settings = { ...settings, configured: false, keyFingerprint: undefined };
      await json(route, {});
      return;
    }

    if (request.method() === 'POST' && /^\/v1\/nodes\/[^/]+\/runs$/.test(path)) {
      const nodeId = path.split('/')[3];
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      await json(route, { run: createRun(nodeId, body) }, 201);
      return;
    }
    if (request.method() === 'GET' && /^\/v1\/runs\/[^/]+$/.test(path)) {
      const run = runs.get(path.split('/')[3]);
      if (!run) {
        await json(route, { error: '运行不存在' }, 404);
        return;
      }
      await json(route, { run });
      return;
    }

    await json(route, {});
  });
}

const clipboardPermissions = ['clipboard-read', 'clipboard-write'] as const;

async function grantClipboardPermissions(page: Page) {
  await page.context().grantPermissions([...clipboardPermissions], {
    origin: new URL(page.url()).origin,
  });
}

async function setClipboardPermission(
  page: Page,
  permission: (typeof clipboardPermissions)[number],
  setting: 'granted' | 'denied' | 'prompt',
) {
  const client = await page.context().newCDPSession(page);
  await client.send('Browser.setPermission', {
    permission: { name: permission },
    setting,
    origin: new URL(page.url()).origin,
  });
}

async function readSystemClipboard(page: Page) {
  return page.evaluate(async () => navigator.clipboard.readText());
}

async function focusCanvas(page: Page) {
  await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await mockApi(page);
});

test('starts with the resource library and workflow canvas visible', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Multimodal Canvas')).toBeVisible();
  await expect(page.getByRole('heading', { name: '项目资源' })).toBeVisible();
  await expect(page.getByRole('region', { name: '工作流画布' })).toBeVisible();
  await expect(page.getByText('从一个节点开始')).toBeVisible();
});

test('adds a generate node from the canvas toolbar', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  const generatedNode = page.locator('.flow-generate-node');
  await expect(generatedNode).toHaveCount(1);
  await expect(generatedNode).toContainText('文字生成节点');
  await expect(page.getByRole('heading', { name: '节点设置' })).toBeVisible();
});

test('saves AI settings and tests the mocked connection', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开设置' }).click();

  const dialog = page.getByRole('dialog', { name: 'AI 连接' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('New API Base URL').fill('https://mock.newapi.local/v1');
  await dialog.getByLabel('API Key').fill('playwright-smoke-key');
  await dialog.getByRole('button', { name: '保存' }).click();

  await expect(dialog.getByText('已配置 · smoke-fingerprint')).toBeVisible();
  await dialog.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByRole('status')).toContainText('连接成功');
});

test('uploads an asset and drags it into the workflow canvas', async ({ page }) => {
  await page.goto('/');

  await page.locator('input[type="file"]').setInputFiles({
    name: 'story.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A short story reference.'),
  });

  const assetCard = page.locator('.asset-card').filter({ hasText: 'story.txt' });
  await expect(assetCard).toBeVisible();
  await expect(page.getByRole('status')).toContainText('1 个资源已加入项目');

  await assetCard.dragTo(page.locator('.canvas-area'));

  await expect(page.locator('.flow-asset-node')).toHaveCount(1);
  await expect(page.locator('.flow-asset-node')).toContainText('story.txt');
});

test('connects three image references to one video generation node', async ({ page }) => {
  await page.goto('/');

  for (const name of ['character.png', 'style.png', 'frame.png']) {
    await page.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from('mock image'),
    });
    await expect(page.locator('.asset-card').filter({ hasText: name })).toBeVisible();
  }

  await page.getByRole('button', { name: '新建视频生成节点' }).click();
  const videoNode = page.locator('.flow-generate-node').filter({ hasText: '视频生成节点' });
  await expect(videoNode).toHaveCount(1);
  const sourceNodes = page.locator('.flow-asset-node:not(.flow-generate-node)');
  const canvasBox = await page.locator('.canvas-area').boundingBox();
  expect(canvasBox).not.toBeNull();
  if (!canvasBox) return;
  const videoHeader = await videoNode.locator('.flow-node-header').boundingBox();
  expect(videoHeader).not.toBeNull();
  if (!videoHeader) return;
  await page.mouse.move(
    videoHeader.x + videoHeader.width / 2,
    videoHeader.y + videoHeader.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 630, canvasBox.y + 280, { steps: 12 });
  await page.mouse.up();
  for (const [index, name] of ['character.png', 'style.png', 'frame.png'].entries()) {
    const card = page.locator('.asset-card').filter({ hasText: name });
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    if (!cardBox) return;
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 170, canvasBox.y + 120 + index * 170, { steps: 12 });
    await page.mouse.up();
    await expect(sourceNodes).toHaveCount(index + 1);
  }

  const sourceHandle = (index: number) =>
    sourceNodes.nth(index).locator('.react-flow__handle.source');
  const targetHandle = (role: string) =>
    videoNode.locator(`.react-flow__handle.target[data-handleid="input:${role}"]`);

  const connect = async (
    source: ReturnType<typeof sourceHandle>,
    target: ReturnType<typeof targetHandle>,
  ) => {
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    if (!sourceBox || !targetBox) return;
    const sourcePoint = {
      x: sourceBox.x + sourceBox.width / 2,
      y: sourceBox.y + sourceBox.height / 2,
    };
    const targetPoint = {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + targetBox.height / 2,
    };
    await page.mouse.move(sourcePoint.x, sourcePoint.y);
    await page.mouse.down();
    await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 24 });
    await page.mouse.up();
  };

  await connect(sourceHandle(0), targetHandle('character'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await connect(sourceHandle(1), targetHandle('style'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await connect(sourceHandle(2), targetHandle('firstFrame'));

  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
});

test('overrides a node model and displays the completed run result', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文字生成节点' }).click();

  const modelSelect = page
    .locator('select')
    .filter({ has: page.locator('option[value="mock-text-v2"]') });
  await expect(modelSelect).toBeVisible();
  await modelSelect.selectOption('mock-text-v2');
  await expect(modelSelect).toHaveValue('mock-text-v2');

  await page.getByRole('button', { name: '生成', exact: true }).click();

  await expect(page.getByRole('region', { name: '运行结果' })).toBeVisible();
  await expect(page.getByText('Mock 结果已归档')).toBeVisible();
  await expect(page.getByText('版本 1')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('文字生成节点 已完成');
});

test('切换 Mock 默认模型后新运行使用新模型', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开设置' }).click();

  const dialog = page.getByRole('dialog', { name: 'AI 连接' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('New API Base URL').fill('https://mock.newapi.local/v1');
  await dialog.getByLabel('API Key').fill('playwright-smoke-key');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog.getByText('已配置 · smoke-fingerprint')).toBeVisible();
  const refreshResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/settings/ai/models/refresh' &&
      response.request().method() === 'POST',
  );
  await expect(dialog.getByRole('button', { name: '刷新模型' })).toBeEnabled();
  await dialog.getByRole('button', { name: '刷新模型' }).click();
  await expect((await refreshResponse).status()).toBe(200);
  await expect(page.getByRole('status')).toContainText('模型列表已刷新');
  const textDefault = dialog.locator('select').first();
  await expect(textDefault).toBeVisible();
  await expect(textDefault.locator('option[value="mock-text-v2"]')).toHaveCount(1);
  await textDefault.selectOption('mock-text-v2');
  await expect(textDefault).toHaveValue('mock-text-v2');
  await dialog.getByRole('button', { name: '关闭设置' }).click();

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  const runResponse = page.waitForResponse(
    (response) =>
      /\/v1\/nodes\/[^/]+\/runs$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '生成', exact: true }).click();
  const run = (await (await runResponse).json()).run as RunRecord;

  expect(run.modelAlias).toBe('mock-text-v2');
  await expect(page.getByRole('region', { name: '运行结果' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('文字生成节点 已完成');
});

test('允许 Clipboard 权限时可以跨画布页面复制粘贴', async ({ page }) => {
  await page.goto('/');
  await grantClipboardPermissions(page);

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await expect(page.getByRole('heading', { name: '节点设置' })).toBeVisible();
  await focusCanvas(page);
  await page.bringToFront();
  await page.keyboard.press('Control+c');
  await expect.poll(() => readSystemClipboard(page)).toContain('multimodal-canvas/clipboard');

  const secondPage = await page.context().newPage();
  try {
    await mockApi(secondPage);
    await secondPage.goto('/');
    await expect(secondPage.getByText('从一个节点开始')).toBeVisible();
    await focusCanvas(secondPage);
    await secondPage.bringToFront();
    await secondPage.keyboard.press('Control+v');

    await expect(secondPage.locator('.flow-generate-node')).toHaveCount(1);
    await expect(secondPage.locator('.flow-generate-node')).toContainText('文字生成节点');
  } finally {
    await secondPage.close();
  }
});

test('Clipboard 读取权限被拒绝时回退到内存剪贴板', async ({ page }) => {
  await page.goto('/');
  await setClipboardPermission(page, 'clipboard-read', 'denied');
  await setClipboardPermission(page, 'clipboard-write', 'denied');

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await expect(page.getByRole('heading', { name: '节点设置' })).toBeVisible();
  await focusCanvas(page);
  await page.bringToFront();
  await page.keyboard.press('Control+c');
  await expect(page.locator('.flow-generate-node')).toHaveCount(1);

  await expect
    .poll(async () => {
      try {
        await readSystemClipboard(page);
        return 'granted';
      } catch {
        return 'denied';
      }
    })
    .toBe('denied');

  await page.keyboard.press('Control+v');
  await expect(page.locator('.flow-generate-node')).toHaveCount(2);
});

test('系统剪贴板是非法文本时回退到内存剪贴板', async ({ page }) => {
  await page.goto('/');
  await grantClipboardPermissions(page);

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await expect(page.getByRole('heading', { name: '节点设置' })).toBeVisible();
  await focusCanvas(page);
  await page.bringToFront();
  await page.keyboard.press('Control+c');
  await expect.poll(() => readSystemClipboard(page)).toContain('multimodal-canvas/clipboard');

  await page.evaluate(async () => navigator.clipboard.writeText('plain text from outside the app'));
  await page.keyboard.press('Control+v');

  await expect(page.locator('.flow-generate-node')).toHaveCount(2);
});
