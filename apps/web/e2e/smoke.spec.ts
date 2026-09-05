import { expect, test, type Page, type Route } from '@playwright/test';
import type { Asset, CanvasDocument, ModelSelection, RunRecord } from '@multimodal-canvas/domain';

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
  defaultModels: Record<string, string | ModelSelection>;
};

type AiCredentialSummary = {
  id: string;
  version: number;
  baseUrl: string;
  keyFingerprint: string;
  active: boolean;
  createdAt: string;
};

const project: Project = {
  id: 'project-smoke',
  name: 'Smoke 项目',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const initialCredential: AiCredentialSummary = {
  id: 'credential-initial',
  version: 1,
  baseUrl: 'https://mock.initial.local/v1',
  keyFingerprint: 'initial-fingerprint',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const projectPath = `/projects/${project.id}`;
const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const validWebm = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAHLEU2bdLlNu4tTq4QVSalmU6yBbk27i1OrhBZUrmtTrIGTTbuLU6uEH0O2dVOsgcFNu4xTq4QcU7trU6yCAbnsrgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBEiYRDVcMSTYCGQ2hyb21lV0GGQ2hyb21lFlSua6mup9eBAXPFh2qkl4hJb02DgQFV7oEBhoVWX1ZQOOCKsIEQuoEQU8CBAR9DtnUBAAAAAAAA7OeBAKDdobKBAAAAcAIAnQEqEAAQAAAHCIWFiJmEiAEkEBOtUBBl8CT+/znG/3BmfV2OH9zY5xbIYHWhpqak7oEBpZ8QAgCdASoQABAAAAcIhYWImYSIASQQAGBrAP7/uoMAoLehloEAjgDRAQAAEAkgAMAAwsF/oABAAAB1oZmml+6BAaWS0QEAABAJIADAAMLBf6AAQAAA+4EAoM+hroEA1QARAgAAEAkgAMA6QEGfMZ+YACAA/v2BkP/PzO7cX9Vv/0TX9E1/RNf/Q3B1oZmml+6BAaWS0QEAABAJIADAAMLBf6AAQAAA+4GOHFO7a427i7OBALeG94EB8YHB',
  'base64',
);

function createSilentWav() {
  const sampleCount = 800;
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(16_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(sampleCount * 2, 40);
  return buffer;
}

const validWav = createSilentWav();

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
    baseUrl: initialCredential.baseUrl,
    configured: true,
    keyFingerprint: initialCredential.keyFingerprint,
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
  const modelsForCredential = (credentialId: string) =>
    models.map((model) => ({ ...model, credentialId }));

  let credentials: AiCredentialSummary[] = [initialCredential];
  const credentialByKey = new Map<string, AiCredentialSummary>();
  const generatedContent = new Map<string, { contentType: string; body: Buffer | string }>();
  let projectDefaults: Record<string, string | ModelSelection> = {};
  const pendingUploads = new Map<
    string,
    { name: string; mimeType: string; sizeBytes: number; sha256: string }
  >();
  const runs = new Map<string, RunRecord>();
  let currentCanvas: CanvasDocument = structuredClone(emptyCanvas);
  let credentialSequence = 0;
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
    const parameters =
      body.parameters && typeof body.parameters === 'object'
        ? (body.parameters as Record<string, unknown>)
        : {};
    const prompt = typeof parameters.prompt === 'string' ? parameters.prompt : '未提供提示词';
    const requestedModelAlias =
      typeof body.modelAlias === 'string' && body.modelAlias.length > 0
        ? body.modelAlias
        : (settings.defaultModels[mediaType] ?? `mock-${mediaType}`);
    const modelAlias =
      typeof requestedModelAlias === 'string'
        ? requestedModelAlias
        : requestedModelAlias.modelAlias;
    const resultAssetId = `result-${nodeId}`;
    const contentUrl = `/v1/assets/${resultAssetId}/content`;
    const output =
      mediaType === 'image'
        ? { contentType: 'image/png', body: validPng, extension: 'png' }
        : mediaType === 'audio'
          ? { contentType: 'audio/wav', body: validWav, extension: 'wav' }
          : mediaType === 'video'
            ? { contentType: 'video/webm', body: validWebm, extension: 'webm' }
            : {
                contentType: 'text/plain; charset=utf-8',
                body: `这是根据“${prompt}”生成的真实文本结果。\n支持换行、复制和滚动查看。`,
                extension: 'txt',
              };
    const sizeBytes = Buffer.isBuffer(output.body)
      ? output.body.byteLength
      : Buffer.byteLength(output.body, 'utf8');
    generatedContent.set(contentUrl, { contentType: output.contentType, body: output.body });
    const resultAsset: Asset = {
      id: resultAssetId,
      name: `generated-${mediaType}.${output.extension}`,
      mediaType,
      mimeType: output.contentType.split(';')[0]!,
      sizeBytes,
      status: 'ready',
      contentUrl,
      tags: ['generated'],
    };
    const existingAssetIndex = assets.findIndex((asset) => asset.id === resultAssetId);
    if (existingAssetIndex >= 0) assets.splice(existingAssetIndex, 1);
    assets.unshift(resultAsset);
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
          assetId: resultAssetId,
          version: 1,
          contentUrl,
          mimeType: resultAsset.mimeType,
          sizeBytes,
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
      const generated = generatedContent.get(path);
      if (generated) {
        await route.fulfill({
          status: 200,
          contentType: generated.contentType,
          body: generated.body,
        });
        return;
      }
      const asset = assets.find((item) => item.contentUrl === path);
      const body =
        asset?.mediaType === 'image'
          ? validPng
          : asset?.mediaType === 'audio'
            ? validWav
            : asset?.mediaType === 'video'
              ? validWebm
              : 'mock content';
      await route.fulfill({
        status: 200,
        contentType: asset?.mimeType ?? 'text/plain',
        body,
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
    if (request.method() === 'GET' && path === `/v1/projects/${project.id}/runs`) {
      await json(route, { runs: [...runs.values()] });
      return;
    }
    if (request.method() === 'GET' && path === `/v1/projects/${project.id}/models/defaults`) {
      await json(route, { defaults: projectDefaults });
      return;
    }
    if (request.method() === 'PATCH' && path === `/v1/projects/${project.id}/models/defaults`) {
      const body = request.postDataJSON() as Record<string, string | ModelSelection | null>;
      projectDefaults = {
        ...projectDefaults,
        ...Object.fromEntries(Object.entries(body).filter(([, value]) => value)),
      };
      for (const [mediaType, modelAlias] of Object.entries(body)) {
        if (!modelAlias) delete projectDefaults[mediaType];
      }
      await json(route, { defaults: projectDefaults });
      return;
    }
    if (request.method() === 'GET' && path === `/v1/projects/${project.id}/export/workflow`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'content-disposition': 'attachment; filename="Smoke.workflow.json"',
          'access-control-expose-headers': 'content-disposition, content-length',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          project,
          canvas: currentCanvas,
          runs: [],
          results: [],
        }),
      });
      return;
    }
    if (request.method() === 'GET' && path === `/v1/projects/${project.id}/export/results`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/zip',
        headers: {
          'content-disposition': 'attachment; filename="Smoke.results.zip"',
          'access-control-expose-headers': 'content-disposition, content-length',
        },
        // The UI only needs a non-empty response to trigger a browser download;
        // the API suite validates the archive structure and contents.
        body: Buffer.from('mock-results-archive'),
      });
      return;
    }
    if (request.method() === 'PATCH' && path === `/v1/projects/${project.id}/canvas`) {
      const body = request.postDataJSON() as CanvasDocument;
      currentCanvas = { ...body, revision: currentCanvas.revision + 1 };
      await json(route, { canvas: currentCanvas });
      return;
    }
    if (request.method() === 'GET' && /^\/v1\/projects\/[^/]+$/.test(path)) {
      await json(route, { error: '项目不存在' }, 404);
      return;
    }
    if (request.method() === 'GET' && path === '/v1/models') {
      const credentialId =
        url.searchParams.get('credentialId') ??
        credentials.find((credential) => credential.active)?.id;
      await json(route, { models: credentialId ? modelsForCredential(credentialId) : [] });
      return;
    }
    if (request.method() === 'GET' && path === '/v1/settings/ai') {
      await json(route, { settings });
      return;
    }
    if (request.method() === 'GET' && path === '/v1/settings/ai/credentials') {
      await json(route, { credentials });
      return;
    }
    if (request.method() === 'PATCH' && path === '/v1/settings/ai') {
      const body = request.postDataJSON() as {
        baseUrl?: string;
        apiKey?: string;
        defaultModels?: Record<string, string | ModelSelection | null>;
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
      if (body.apiKey) {
        const existing = credentialByKey.get(`${settings.baseUrl}\u0000${body.apiKey}`);
        const saved =
          existing ??
          ({
            id: `credential-${++credentialSequence}`,
            version: credentialSequence,
            baseUrl: settings.baseUrl,
            keyFingerprint: 'smoke-fingerprint',
            active: true,
            createdAt: new Date().toISOString(),
          } satisfies AiCredentialSummary);
        if (!existing) credentialByKey.set(`${settings.baseUrl}\u0000${body.apiKey}`, saved);
        credentials = [
          { ...saved, active: true },
          ...credentials
            .filter((credential) => credential.id !== saved.id)
            .map((credential) => ({ ...credential, active: false })),
        ];
      }
      await json(route, { settings, credentials });
      return;
    }
    if (
      request.method() === 'POST' &&
      /^\/v1\/settings\/ai\/credentials\/[^/]+\/activate$/.test(path)
    ) {
      const credentialId = path.split('/')[5];
      const selected = credentials.find((credential) => credential.id === credentialId);
      if (!selected) {
        await json(route, { error: '凭据不存在' }, 404);
        return;
      }
      credentials = credentials.map((credential) => ({
        ...credential,
        active: credential.id === credentialId,
      }));
      settings = {
        ...settings,
        baseUrl: selected.baseUrl,
        configured: true,
        keyFingerprint: selected.keyFingerprint,
      };
      await json(route, { settings, credentials });
      return;
    }
    if (request.method() === 'POST' && path === '/v1/settings/ai/test') {
      await json(route, { result: { ok: true, modelCount: models.length } });
      return;
    }
    if (request.method() === 'POST' && path === '/v1/settings/ai/models/refresh') {
      const body = (request.postDataJSON() ?? {}) as { credentialId?: string };
      const credentialId =
        body.credentialId ?? credentials.find((credential) => credential.active)?.id;
      await json(route, { models: credentialId ? modelsForCredential(credentialId) : [] });
      return;
    }
    if (request.method() === 'DELETE' && path === '/v1/settings/ai/credentials') {
      settings = { ...settings, baseUrl: '', configured: false, keyFingerprint: undefined };
      credentials = credentials.map((credential) => ({ ...credential, active: false }));
      await json(route, { settings, credentials });
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

test('主页进入工作台和项目深链，并在刷新后恢复画布', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'Multimodal Canvas' })).toBeVisible();
  await expect(page.getByLabel('多模态生成工作流预览')).toBeVisible();
  await expect(page.getByRole('heading', { name: '从参考输入到可复用产物' })).toBeVisible();

  await page.getByRole('link', { name: '进入工作台', exact: true }).click();
  await expect(page).toHaveURL('/workspace');
  await expect(page.getByRole('heading', { name: '项目工作台' })).toBeVisible();
  await expect(page.getByRole('link', { name: project.name, exact: true })).toBeVisible();
  const projectSearch = page.getByRole('searchbox', { name: '搜索项目' });
  await projectSearch.focus();
  await expect
    .poll(() => projectSearch.evaluate((element) => getComputedStyle(element).outlineStyle))
    .toBe('none');

  await page.getByRole('link', { name: project.name, exact: true }).click();
  await expect(page).toHaveURL(projectPath);
  await expect(page.getByRole('region', { name: '工作流画布' })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(projectPath);
  await expect(page.getByRole('region', { name: '工作流画布' })).toBeVisible();
});

test('主菜单支持键盘关闭、当前页高亮，并可进入设置和错误页面', async ({ page }) => {
  await page.goto('/');

  const menuTrigger = page.getByRole('button', { name: '打开主菜单' });
  await menuTrigger.click();
  let menu = page.getByRole('dialog', { name: 'Multimodal Canvas' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('link', { name: /主页/ })).toHaveAttribute('aria-current', 'page');

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(menuTrigger).toBeFocused();

  await menuTrigger.click();
  menu = page.getByRole('dialog', { name: 'Multimodal Canvas' });
  await menu.getByRole('link', { name: /设置/ }).click();
  await expect(page).toHaveURL('/settings');
  await expect(page.getByRole('heading', { name: '连接与模型设置' })).toBeVisible();

  await page.goto('/not-a-real-page');
  await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
  await expect(page.getByText('/not-a-real-page')).toBeVisible();

  await page.goto('/projects/missing-project');
  await expect(page.getByRole('heading', { name: '项目不存在' })).toBeVisible();
  await expect(page.getByText('无法访问项目 missing-project。')).toBeVisible();
});

test('starts with the resource library and workflow canvas visible', async ({ page }) => {
  await page.goto(projectPath);

  await expect(page.getByRole('button', { name: '打开主菜单' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '资源类型' })).toBeVisible();
  await expect(page.getByRole('region', { name: '工作流画布' })).toBeVisible();
  await expect(page.getByText('从一个节点开始')).toBeVisible();
  const resourceSearch = page.locator('.search-field input');
  await resourceSearch.focus();
  const resourceSearchStyle = await resourceSearch.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    outline: getComputedStyle(element).outlineStyle,
    parentShadow: getComputedStyle(element.parentElement!).boxShadow,
  }));
  expect(resourceSearchStyle).toMatchObject({
    background: 'rgba(0, 0, 0, 0)',
    outline: 'none',
  });
  expect(resourceSearchStyle.parentShadow).not.toBe('none');
});

test('keeps mobile header and node tools inside the viewport', async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(projectPath);

    await expect(page.getByRole('region', { name: '工作流画布' })).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    expect(layout.documentWidth, `document overflow at ${width}px`).toBeLessThanOrEqual(
      layout.clientWidth,
    );
    expect(layout.bodyWidth, `body overflow at ${width}px`).toBeLessThanOrEqual(layout.clientWidth);

    const chrome = [
      page.locator('.resource-filter-field'),
      page.locator('.topbar-tool-cluster'),
      page.locator('.canvas-node-tools'),
    ];
    for (const container of chrome) {
      await expect(container).toBeVisible();
      const bounds = await container.boundingBox();
      expect(bounds).not.toBeNull();
      expect(
        bounds!.x,
        `left overflow for ${await container.getAttribute('class')}`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        bounds!.x + bounds!.width,
        `right overflow for ${await container.getAttribute('class')}`,
      ).toBeLessThanOrEqual(layout.clientWidth);
    }

    const resourceFilter = page.locator('.resource-filter-field');
    await resourceFilter.getByRole('combobox', { name: '资源类型' }).focus();
    await expect(resourceFilter).toHaveCSS('box-shadow', /0px 0px 0px 3px/);
    const resourceFilterBounds = await resourceFilter.boundingBox();
    const resourceSelectBounds = await resourceFilter
      .getByRole('combobox', { name: '资源类型' })
      .boundingBox();
    expect(resourceFilterBounds).not.toBeNull();
    expect(resourceSelectBounds).not.toBeNull();
    if (resourceFilterBounds && resourceSelectBounds) {
      expect(resourceSelectBounds.x).toBeGreaterThanOrEqual(resourceFilterBounds.x);
      expect(resourceSelectBounds.x + resourceSelectBounds.width).toBeLessThanOrEqual(
        resourceFilterBounds.x + resourceFilterBounds.width,
      );
    }

    const toolCluster = page.locator('.topbar-tool-cluster');
    const commandButton = toolCluster.getByRole('button', { name: '打开命令面板' });
    await commandButton.focus();
    await expect(commandButton).toBeFocused();

    const nodeTools = page.locator('.canvas-node-tools');
    await expect(nodeTools).toHaveCSS('overflow-x', 'auto');
    const firstNodeButton = nodeTools.getByRole('button').first();
    const lastNodeButton = nodeTools.getByRole('button').last();
    await expect(firstNodeButton).toBeVisible();
    await nodeTools.evaluate((element) => {
      element.scrollLeft = element.scrollWidth - element.clientWidth;
    });
    await expect(lastNodeButton).toBeVisible();
    const lastButtonBounds = await lastNodeButton.boundingBox();
    const toolsBounds = await nodeTools.boundingBox();
    expect(lastButtonBounds).not.toBeNull();
    expect(toolsBounds).not.toBeNull();
    expect(lastButtonBounds!.x).toBeGreaterThanOrEqual(toolsBounds!.x);
    expect(lastButtonBounds!.x + lastButtonBounds!.width).toBeLessThanOrEqual(
      toolsBounds!.x + toolsBounds!.width,
    );
  }
});

test('keeps the narrow project menu visible inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(projectPath);

  await page.getByRole('button', { name: '打开项目集合' }).click();
  const menu = page.getByRole('menu', { name: '项目集合' });
  await expect(menu).toBeVisible();
  const menuBounds = await menu.boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(320);
});

test('traps login focus and restores it to the trigger', async ({ page }) => {
  await page.goto(projectPath);

  const trigger = page.getByRole('button', { name: '登录' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '登录工作区' });
  const closeButton = dialog.getByRole('button', { name: '关闭登录' });
  const continueButton = dialog.getByRole('button', { name: '继续匿名使用' });

  await expect(dialog).toBeVisible();
  await expect(page.locator('main.app-shell')).toHaveAttribute('inert', '');
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(continueButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('exports the workflow JSON and result ZIP from the header menu', async ({ page }) => {
  await page.goto(projectPath);

  const exportButton = page.getByRole('button', { name: /^导出$/ });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect(page.getByRole('menu', { name: '导出选项' })).toBeVisible();

  const workflowDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /工作流 JSON/ }).click();
  const workflow = await workflowDownload;
  expect(workflow.suggestedFilename()).toBe('Smoke.workflow.json');

  await exportButton.click();
  const resultsDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /结果 ZIP/ }).click();
  const results = await resultsDownload;
  expect(results.suggestedFilename()).toBe('Smoke.results.zip');
});

test('adds a generate node from the canvas toolbar', async ({ page }) => {
  await page.goto(projectPath);

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  const generatedNode = page.locator('.flow-generate-node');
  await expect(generatedNode).toHaveCount(1);
  await expect(generatedNode).toContainText('文字生成节点');
  await expect(page.getByRole('heading', { name: '节点设置' })).toBeVisible();
});

test('supports theme/sidebar controls, node body connections, and corner resizing', async ({
  page,
}) => {
  await page.goto(projectPath);

  await page.getByRole('button', { name: '新建图片生成节点' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'body-reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from('mock image'),
  });
  const assetCard = page.locator('.asset-card').filter({ hasText: 'body-reference.png' });
  await expect(assetCard).toBeVisible();
  const canvasBox = await page.locator('.canvas-area').boundingBox();
  const cardBox = await assetCard.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  if (!canvasBox || !cardBox) return;
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 130, { steps: 14 });
  await page.mouse.up();

  const source = page.locator('.flow-asset-node').filter({ hasText: 'body-reference.png' });
  const target = page.locator('.flow-generate-node').filter({ hasText: '图片生成节点' });
  const sourceHandle = source.locator('.react-flow__handle.source');
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  if (!sourceBox || !targetBox) return;
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await target.click();
  await expect(page.locator('.node-quick-editor')).toBeVisible();
  await expect(page.locator('.inspector-panel textarea')).toHaveCount(0);
  const resizeHandle = page.locator('.react-flow__resize-control.bottom.right');
  await expect(resizeHandle).toBeVisible();
  const before = await target.boundingBox();
  const previewBefore = await target.locator('.flow-node-placeholder').boundingBox();
  const resizeBox = await resizeHandle.boundingBox();
  expect(before).not.toBeNull();
  expect(previewBefore).not.toBeNull();
  expect(resizeBox).not.toBeNull();
  if (!before || !previewBefore || !resizeBox) return;
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x + 30, resizeBox.y + 24, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await target.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before.width);
  await expect
    .poll(async () => (await target.boundingBox())?.height ?? 0)
    .toBeGreaterThan(before.height);
  await expect
    .poll(async () => (await target.locator('.flow-node-placeholder').boundingBox())?.height ?? 0)
    .toBeGreaterThan(previewBefore.height);

  await page.getByRole('button', { name: '选择画布背景' }).click();
  await page.getByRole('menuitemradio', { name: '空白' }).click();
  await expect(page.locator('.react-flow__background')).toHaveCount(0);
  await page.getByRole('button', { name: '选择画布背景' }).click();
  await page.getByRole('menuitemradio', { name: '点' }).click();
  await expect(page.locator('.react-flow__background')).toHaveCount(1);

  await page.getByRole('button', { name: '切换主题' }).click();
  await page.getByRole('option', { name: '深色' }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '折叠资源栏' }).click();
  await expect(page.locator('.resource-panel')).toHaveClass(/is-collapsed/);
});

test('saves AI settings and tests the mocked connection', async ({ page }) => {
  await page.goto(projectPath);
  await page.getByRole('button', { name: '打开设置' }).click();

  const dialog = page.getByRole('dialog', { name: 'AI 连接' });
  const automaticRefresh = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/settings/ai/models/refresh' &&
      response.request().method() === 'POST',
  );
  let refreshRequestCount = 0;
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname === '/v1/settings/ai/models/refresh' &&
      request.method() === 'POST'
    ) {
      refreshRequestCount += 1;
    }
  });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('New API Base URL').fill('https://mock.newapi.local/v1');
  await dialog.getByRole('textbox', { name: 'API Key' }).fill('playwright-smoke-key');
  await dialog.getByRole('button', { name: '保存' }).click();

  await expect((await automaticRefresh).status()).toBe(200);
  await expect(dialog.getByText('已配置 · smoke-fingerprint')).toBeVisible();
  const credentialSelect = dialog.getByLabel('已保存的 API Key');
  await expect(credentialSelect).toHaveValue('credential-1');
  await expect(credentialSelect.locator('option', { hasText: 'smoke-fingerprint' })).toHaveCount(1);
  await expect.poll(() => refreshRequestCount).toBe(1);
  await dialog.getByRole('button', { name: '测试连接' }).click();
  await expect(dialog.getByRole('status')).toContainText('连接成功');
});

test('settings are truly modal and contained on desktop and narrow viewports', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.getByRole('option', { name: '深色' }).click();

  const trigger = page.getByRole('button', { name: '打开设置' });
  await trigger.click();
  let dialog = page.getByRole('dialog', { name: 'AI 连接' });
  let overlay = page.locator('.settings-backdrop');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(overlay).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(dialog.getByRole('button', { name: '关闭设置' })).toBeFocused();

  const desktopModalState = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.settings-panel');
    const backdrop = document.querySelector<HTMLElement>('.settings-backdrop');
    return {
      bodyOverflow: getComputedStyle(document.body).overflow,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      panelBackground: panel ? getComputedStyle(panel).backgroundColor : '',
      panelZIndex: panel ? Number(getComputedStyle(panel).zIndex) : 0,
      backdropZIndex: backdrop ? Number(getComputedStyle(backdrop).zIndex) : 0,
    };
  });
  expect(desktopModalState).toMatchObject({
    bodyOverflow: 'hidden',
    htmlOverflow: 'hidden',
    panelBackground: 'rgb(26, 32, 40)',
  });
  expect(desktopModalState.panelZIndex).toBeGreaterThan(desktopModalState.backdropZIndex);

  await page.evaluate(() => {
    (window as Window & { backgroundPointerDown?: boolean }).backgroundPointerDown = false;
    document.querySelector('.react-flow__pane')?.addEventListener(
      'pointerdown',
      () => {
        (window as Window & { backgroundPointerDown?: boolean }).backgroundPointerDown = true;
      },
      { once: true },
    );
  });
  await overlay.click({ position: { x: 12, y: 12 } });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as Window & { backgroundPointerDown?: boolean }).backgroundPointerDown,
    ),
  ).toBe(false);

  await trigger.click();
  dialog = page.getByRole('dialog', { name: 'AI 连接' });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto(projectPath);
    const narrowTrigger = page.getByRole('button', { name: '打开设置' });
    await narrowTrigger.click();
    dialog = page.getByRole('dialog', { name: 'AI 连接' });
    overlay = page.locator('.settings-backdrop');
    await expect(dialog).toBeVisible();
    await expect(overlay).toBeVisible();
    await expect(dialog.getByRole('button', { name: '关闭设置' })).toBeFocused();

    const metrics = await dialog.evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      return {
        bodyOverflow: getComputedStyle(document.body).overflow,
        htmlOverflow: getComputedStyle(document.documentElement).overflow,
        clientHeight: panel.clientHeight,
        clientWidth: panel.clientWidth,
        height: rect.height,
        left: rect.left,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        right: rect.right,
        scrollHeight: panel.scrollHeight,
        scrollWidth: panel.scrollWidth,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      };
    });
    expect(metrics.bodyOverflow).toBe('hidden');
    expect(metrics.htmlOverflow).toBe('hidden');
    expect(metrics.height).toBe(metrics.viewportHeight);
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.clientWidth).toBeGreaterThanOrEqual(metrics.scrollWidth);
    expect(metrics.overflowX).toBe('hidden');
    expect(metrics.overflowY).toBe('auto');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    const scrollTop = await dialog.evaluate((panel) => {
      panel.scrollTop = 120;
      return panel.scrollTop;
    });
    expect(scrollTop).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(narrowTrigger).toBeFocused();
  }
});

test('uploads an asset and drags it into the workflow canvas', async ({ page }) => {
  await page.goto(projectPath);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'story.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A short story reference.'),
  });

  const assetCard = page.locator('.asset-card').filter({ hasText: 'story.txt' });
  await expect(assetCard).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '1 个资源已加入项目' })).toBeVisible();

  await assetCard.dragTo(page.locator('.canvas-area'));

  await expect(page.locator('.flow-asset-node')).toHaveCount(1);
  await expect(page.locator('.flow-asset-node')).toContainText('story.txt');
});

test('connects three image references to one video generation node', async ({ page }) => {
  await page.goto(projectPath);

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

  await focusCanvas(page);
  await expect(page.locator('.node-quick-editor')).toHaveCount(0);

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

  const selectedEdge = page.locator('.react-flow__edge').first();
  await expect(selectedEdge).toHaveClass(/animated/);
  await selectedEdge.locator('.react-flow__edge-interaction').click();
  await expect(selectedEdge).toHaveClass(/selected/);

  const selectedEdgeStyles = await selectedEdge.evaluate((edge) => {
    const path = edge.querySelector<SVGPathElement>('.react-flow__edge-path');
    const shell = document.querySelector<HTMLElement>('.app-shell');
    if (!path || !shell) return null;

    const colorProbe = document.createElement('span');
    colorProbe.style.color = 'var(--mc-accent-strong)';
    shell.append(colorProbe);
    const accentStrong = getComputedStyle(colorProbe).color;
    colorProbe.remove();

    const style = getComputedStyle(path);
    return {
      accentStrong,
      animationDuration: style.animationDuration,
      animationName: style.animationName,
      stroke: style.stroke,
    };
  });
  expect(selectedEdgeStyles).not.toBeNull();
  if (!selectedEdgeStyles) return;
  expect(selectedEdgeStyles.animationDuration).toBe('0.2s');
  expect(selectedEdgeStyles.animationName).not.toBe('none');
  expect(selectedEdgeStyles.stroke).toBe(selectedEdgeStyles.accentStrong);
});

test('connects mixed text, image, and audio references to one video generation node', async ({
  page,
}) => {
  await page.goto(projectPath);

  const references = [
    {
      name: 'scene-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('A spoken scene description.'),
      role: 'content',
    },
    { name: 'reference-style.png', mimeType: 'image/png', buffer: validPng, role: 'style' },
    { name: 'voice-track.wav', mimeType: 'audio/wav', buffer: validWav, role: 'audioTrack' },
  ] as const;

  for (const reference of references) {
    await page.locator('input[type="file"]').setInputFiles(reference);
    await expect(page.locator('.asset-card').filter({ hasText: reference.name })).toBeVisible();
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
  await page.mouse.move(canvasBox.x + 640, canvasBox.y + 280, { steps: 12 });
  await page.mouse.up();

  for (const [index, reference] of references.entries()) {
    const card = page.locator('.asset-card').filter({ hasText: reference.name });
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    if (!cardBox) return;
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 170, canvasBox.y + 120 + index * 170, { steps: 12 });
    await page.mouse.up();
    await expect(sourceNodes).toHaveCount(index + 1);
  }

  await focusCanvas(page);
  const sourceHandle = (index: number) =>
    sourceNodes.nth(index).locator('.react-flow__handle.source');
  const targetHandle = (role: string) =>
    videoNode.locator(`.react-flow__handle.target[data-handleid="input:${role}"]`);

  const connect = async (sourceIndex: number, role: string) => {
    const sourceBox = await sourceHandle(sourceIndex).boundingBox();
    const targetBox = await targetHandle(role).boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    if (!sourceBox || !targetBox) return;
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 24,
    });
    await page.mouse.up();
  };

  for (const [index, reference] of references.entries()) {
    await connect(index, reference.role);
  }

  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
});

test('overrides a node model and displays the completed run result', async ({ page }) => {
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建文字生成节点' }).click();

  const modelSelect = page.getByRole('combobox', { name: /^模型：/ });
  await expect(modelSelect).toBeVisible();
  await modelSelect.hover();
  await page.getByRole('option', { name: 'Mock Text v2' }).click();
  await expect(page.getByRole('combobox', { name: '模型：Mock Text v2' })).toBeVisible();

  const prompt = page.locator('.node-quick-editor textarea');
  await expect(prompt).toBeVisible();
  await prompt.fill('验证模型覆盖后的生成结果');
  await page.getByRole('button', { name: '生成', exact: true }).click();

  await expect(page.getByRole('region', { name: '运行结果' })).toBeVisible();
  await expect(page.getByText('Mock 结果已归档')).toBeVisible();
  await expect(page.getByText('版本 1')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '文字生成节点 已完成' })).toBeVisible();
});

test('四类节点都可以填写提示词、运行并显示对应结果预览', async ({ page }) => {
  await page.goto(projectPath);

  const mediaCases = [
    { mediaType: '文字', resultSelector: '.inspector-result .inspector-result-text' },
    { mediaType: '图片', resultSelector: '.inspector-result img' },
    { mediaType: '音频', resultSelector: '.inspector-result audio' },
    { mediaType: '视频', resultSelector: '.inspector-result video' },
  ] as const;

  for (const [index, { mediaType, resultSelector }] of mediaCases.entries()) {
    if (index > 0) {
      await focusCanvas(page);
      await expect(page.locator('.node-quick-editor')).toHaveCount(0);
    }
    await page.getByRole('button', { name: `新建${mediaType}生成节点` }).click();

    const node = page
      .locator('.flow-generate-node')
      .filter({ hasText: `${mediaType}生成节点` })
      .last();
    await expect(node).toBeVisible();
    await expect(page.getByRole('heading', { name: '节点设置' })).toBeVisible();

    const prompt = page.locator('.node-quick-editor textarea');
    await expect(prompt).toBeVisible();
    await prompt.fill(`Playwright ${mediaType} 生成测试`);
    await expect(prompt).toHaveValue(`Playwright ${mediaType} 生成测试`);

    const audioRunRequest =
      mediaType === '音频'
        ? page.waitForRequest(
            (request) =>
              request.method() === 'POST' &&
              /^\/v1\/nodes\/[^/]+\/runs$/.test(new URL(request.url()).pathname),
          )
        : undefined;
    if (mediaType === '音频') {
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
      await page.getByRole('textbox', { name: '音色', exact: true }).fill('synthetic-smoke-voice');
    }
    await page.getByRole('button', { name: '生成', exact: true }).click();
    if (audioRunRequest) {
      const body = (await audioRunRequest).postDataJSON();
      expect(body.parameters).toMatchObject({
        voice: 'synthetic-smoke-voice',
        prompt: 'Playwright 音频 生成测试',
      });
      expect(body.parameters).not.toHaveProperty('response_format');
      expect(body.parameters).not.toHaveProperty('speed');
    }

    await expect(page.getByRole('region', { name: '运行结果' })).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: `${mediaType}生成节点 已完成` }),
    ).toBeVisible();
    const result = page.locator(resultSelector);
    await expect(result).toHaveCount(1);
    await expect(node.locator('.flow-node-preview')).toBeVisible();

    if (mediaType === '文字') {
      await expect(result).toContainText('生成的真实文本结果');
      await expect(node.locator('.artifact-preview-text-content')).toContainText(
        '生成的真实文本结果',
      );
    } else if (mediaType === '图片') {
      await expect
        .poll(() => result.evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBe(1);
      await expect
        .poll(() => node.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBe(1);
    } else {
      await expect(result).toHaveAttribute('controls', '');
      await expect
        .poll(() =>
          result.evaluate((media: HTMLMediaElement) => ({
            readyState: media.readyState,
            networkState: media.networkState,
          })),
        )
        .toMatchObject({ readyState: expect.any(Number), networkState: expect.any(Number) });
      await expect
        .poll(() => result.evaluate((media: HTMLMediaElement) => media.readyState))
        .toBeGreaterThanOrEqual(1);
    }
  }
});

test('PC 音频参数显式输入、保存恢复并提交，桌面截图无布局或控制台错误', async ({
  page,
}, testInfo) => {
  /** 收集本用例错误及意外外部地址；所有 v1 请求仍由 beforeEach 的 Mock 路由响应。 */
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const blockedOrigins: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    ) {
      blockedOrigins.push(url.origin);
      await route.abort('blockedbyclient');
      return;
    }
    await route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建音频生成节点' }).click();

  const editor = page.locator('.node-quick-editor');
  const voice = editor.getByRole('textbox', { name: '音色', exact: true });
  const speed = editor.getByRole('spinbutton', { name: '语速', exact: true });
  const run = editor.getByRole('button', { name: '生成', exact: true });
  const syntheticVoice = 'synthetic/custom Voice-42';
  await editor.locator('textarea').fill('Playwright 音频参数保存恢复');
  await expect(voice).toHaveValue('');
  await expect(voice).toHaveAttribute('required', '');
  await expect(speed).toHaveValue('');
  await expect(editor.getByRole('combobox', { name: '音频格式：未设置' })).toBeVisible();
  await expect(run).toBeDisabled();
  await voice.fill(syntheticVoice);
  await editor.getByRole('combobox', { name: /^音频格式：/ }).hover();
  await editor.getByRole('option', { name: 'WAV', exact: true }).click();
  await speed.fill('4.001');
  await expect(speed).toHaveAttribute('aria-invalid', 'true');
  await expect(run).toBeDisabled();
  await speed.fill('0.25');
  await expect(run).toBeEnabled();
  await speed.fill('4');
  await expect(run).toBeEnabled();

  const savedResponse = page.waitForResponse((response) => {
    if (
      response.request().method() !== 'PATCH' ||
      new URL(response.url()).pathname !== `/v1/projects/${project.id}/canvas` ||
      response.status() !== 200
    )
      return false;
    const canvas = response.request().postDataJSON() as CanvasDocument;
    return canvas.nodes.some((node) => {
      const parameters = node.data.parameters;
      return (
        node.data.mediaType === 'audio' &&
        parameters?.voice === syntheticVoice &&
        parameters.response_format === 'wav' &&
        parameters.speed === 1.25
      );
    });
  });
  await speed.fill('1.25');
  await savedResponse;
  await page.reload();
  await page.locator('.flow-generate-node').filter({ hasText: '音频生成节点' }).click();
  await expect(voice).toHaveValue(syntheticVoice);
  await expect(editor.getByRole('combobox', { name: '音频格式：WAV' })).toBeVisible();
  await expect(speed).toHaveValue('1.25');
  await expect(run).toBeEnabled();

  /** 三个紧凑参数控件必须完整位于桌面和编辑器中，并保持同一行且互不重叠。 */
  const editorBox = await editor.boundingBox();
  expect(editorBox).not.toBeNull();
  const boxes = [];
  for (const control of [voice, editor.getByRole('combobox', { name: /^音频格式：/ }), speed]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(60);
    expect(box!.height).toBeGreaterThanOrEqual(28);
    expect(box!.x).toBeGreaterThanOrEqual(Math.max(0, editorBox!.x));
    expect(box!.y).toBeGreaterThanOrEqual(Math.max(0, editorBox!.y));
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      Math.min(1440, editorBox!.x + editorBox!.width),
    );
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      Math.min(1000, editorBox!.y + editorBox!.height),
    );
    boxes.push(box!);
  }
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index].x).toBeGreaterThanOrEqual(boxes[index - 1].x + boxes[index - 1].width);
    expect(Math.abs(boxes[index].y - boxes[index - 1].y)).toBeLessThanOrEqual(1);
  }
  /** 保留可直接查看的 PNG 文件，附件引用文件而不内嵌截图字节。 */
  const audioScreenshotPath = testInfo.outputPath('audio-desktop.png');
  await page.screenshot({ path: audioScreenshotPath, fullPage: false, animations: 'disabled' });
  await testInfo.attach('audio-editor-desktop-1440x1000', {
    path: audioScreenshotPath,
    contentType: 'image/png',
  });

  await voice.fill('   ');
  await expect(voice).toHaveValue('');
  await expect(run).toBeDisabled();
  await voice.fill(syntheticVoice);
  const submittedRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /^\/v1\/nodes\/[^/]+\/runs$/.test(new URL(request.url()).pathname),
  );
  await run.click();
  expect((await submittedRequest).postDataJSON().parameters).toEqual({
    prompt: 'Playwright 音频参数保存恢复',
    voice: syntheticVoice,
    response_format: 'wav',
    speed: 1.25,
  });
  await expect(page.getByRole('status').filter({ hasText: '音频生成节点 已完成' })).toBeVisible();
  await expect(page.locator('.inspector-result audio')).toHaveAttribute('controls', '');
  expect(blockedOrigins).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('PC 视频像素尺寸可保存清空恢复，提交显式宽高且不猜测 legacy alias', async ({
  page,
}, testInfo) => {
  /** 仅使用 beforeEach 的本地 Mock API，保存与运行请求不访问真实 Provider。 */
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建视频生成节点' }).click();
  const editor = page.locator('.node-quick-editor');
  const width = editor.getByRole('spinbutton', { name: '宽度（像素）', exact: true });
  const height = editor.getByRole('spinbutton', { name: '高度（像素）', exact: true });
  const run = editor.getByRole('button', { name: '生成', exact: true });
  await editor.locator('textarea').fill('Playwright 视频像素尺寸');
  await expect(width).toHaveValue('');
  await expect(height).toHaveValue('');
  await expect(run).toBeEnabled();
  await editor.getByRole('combobox', { name: /^时长（秒）：/ }).hover();
  await editor.getByRole('option', { name: '8 秒', exact: true }).click();
  await width.fill('1280.5');
  await expect(width).toHaveValue('1280.5');
  await expect(width).toHaveAttribute('aria-invalid', 'true');
  await expect(run).toBeDisabled();
  await width.fill('1280');
  const savedDimensions = page.waitForResponse((response) => {
    if (
      response.request().method() !== 'PATCH' ||
      new URL(response.url()).pathname !== `/v1/projects/${project.id}/canvas` ||
      response.status() !== 200
    )
      return false;
    const canvas = response.request().postDataJSON() as CanvasDocument;
    return canvas.nodes.some(
      (node) =>
        node.data.mediaType === 'video' &&
        node.data.parameters?.width === 1280 &&
        node.data.parameters?.height === 720,
    );
  });
  await height.fill('720');
  await savedDimensions;
  await page.reload();
  await page.locator('.flow-generate-node').filter({ hasText: '视频生成节点' }).click();
  await expect(width).toHaveValue('1280');
  await expect(height).toHaveValue('720');
  await expect(editor.getByRole('combobox', { name: '时长（秒）：8' })).toBeVisible();
  await expect(editor.getByRole('combobox', { name: '视频清晰度：未设置' })).toBeVisible();
  await expect(editor.getByRole('button', { name: '视频比例：未设置' })).toBeVisible();
  await testInfo.attach('video-dimensions-desktop-1440x1000', {
    body: await page.screenshot({ fullPage: false, animations: 'disabled' }),
    contentType: 'image/png',
  });

  const clearedDimensions = page.waitForResponse((response) => {
    if (
      response.request().method() !== 'PATCH' ||
      new URL(response.url()).pathname !== `/v1/projects/${project.id}/canvas` ||
      response.status() !== 200
    )
      return false;
    const canvas = response.request().postDataJSON() as CanvasDocument;
    return canvas.nodes.some(
      (node) =>
        node.data.mediaType === 'video' &&
        node.data.parameters?.duration === 8 &&
        !Object.hasOwn(node.data.parameters, 'width') &&
        !Object.hasOwn(node.data.parameters, 'height'),
    );
  });
  await width.fill('');
  await height.fill('');
  await clearedDimensions;
  await page.reload();
  await page.locator('.flow-generate-node').filter({ hasText: '视频生成节点' }).click();
  await expect(width).toHaveValue('');
  await expect(height).toHaveValue('');
  await expect(editor.getByRole('combobox', { name: '时长（秒）：8' })).toBeVisible();
  await expect(run).toBeEnabled();
  await width.fill('1920');
  await height.fill('1080');
  const submittedRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /^\/v1\/nodes\/[^/]+\/runs$/.test(new URL(request.url()).pathname),
  );
  await run.click();
  expect((await submittedRequest).postDataJSON().parameters).toEqual({
    prompt: 'Playwright 视频像素尺寸',
    duration: 8,
    width: 1920,
    height: 1080,
  });
  await expect(page.getByRole('status').filter({ hasText: '视频生成节点 已完成' })).toBeVisible();
  await expect(page.locator('.inspector-result video')).toHaveAttribute('controls', '');
  expect(errors).toEqual([]);
});

test('切换 Mock 默认模型后新运行使用新模型', async ({ page }) => {
  await page.goto(projectPath);
  await page.getByRole('button', { name: '打开设置' }).click();

  const dialog = page.getByRole('dialog', { name: 'AI 连接' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('New API Base URL').fill('https://mock.newapi.local/v1');
  await dialog.getByRole('textbox', { name: 'API Key' }).fill('playwright-smoke-key');
  const refreshResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/settings/ai/models/refresh' &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog.getByText('已配置 · smoke-fingerprint')).toBeVisible();
  await expect((await refreshResponse).status()).toBe(200);
  await expect(dialog.getByRole('status')).toContainText('模型列表已自动刷新');
  const textDefault = dialog.getByLabel('平台全局默认 · 文字');
  await expect(textDefault).toBeVisible();
  const savedCredentialId = await dialog.getByLabel('已保存的 API Key').inputValue();
  const mockTextV2Value = JSON.stringify([savedCredentialId, 'mock-text-v2']);
  await expect(textDefault.locator(`option[value='${mockTextV2Value}']`)).toHaveCount(1);
  await textDefault.selectOption(mockTextV2Value);
  await expect(textDefault).toHaveValue(mockTextV2Value);
  await dialog.getByRole('button', { name: '关闭设置' }).click();

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  const runResponse = page.waitForResponse(
    (response) =>
      /\/v1\/nodes\/[^/]+\/runs$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );
  const prompt = page.locator('.node-quick-editor textarea');
  await expect(prompt).toBeVisible();
  await prompt.fill('验证默认模型切换后的新运行');
  await page.getByRole('button', { name: '生成', exact: true }).click();
  const run = (await (await runResponse).json()).run as RunRecord;

  expect(run.modelAlias).toBe('mock-text-v2');
  await expect(page.getByRole('region', { name: '运行结果' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '文字生成节点 已完成' })).toBeVisible();
});

test('允许 Clipboard 权限时可以跨画布页面复制粘贴', async ({ page }) => {
  await page.goto(projectPath);
  await grantClipboardPermissions(page);

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await expect(page.getByRole('heading', { name: '节点设置' })).toBeVisible();
  await page.bringToFront();
  await page.keyboard.press('Control+c');
  await expect.poll(() => readSystemClipboard(page)).toContain('multimodal-canvas/clipboard');

  const secondPage = await page.context().newPage();
  try {
    await mockApi(secondPage);
    await secondPage.goto(projectPath);
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
  await page.goto(projectPath);
  await setClipboardPermission(page, 'clipboard-read', 'denied');
  await setClipboardPermission(page, 'clipboard-write', 'denied');

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await expect(page.getByRole('heading', { name: '节点设置' })).toBeVisible();
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
  await page.goto(projectPath);
  await grantClipboardPermissions(page);

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await expect(page.getByRole('heading', { name: '节点设置' })).toBeVisible();
  await page.bringToFront();
  await page.keyboard.press('Control+c');
  await expect.poll(() => readSystemClipboard(page)).toContain('multimodal-canvas/clipboard');

  await page.evaluate(async () => navigator.clipboard.writeText('plain text from outside the app'));
  await page.keyboard.press('Control+v');

  await expect(page.locator('.flow-generate-node')).toHaveCount(2);
});
