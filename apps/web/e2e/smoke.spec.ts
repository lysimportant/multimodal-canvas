import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
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
/** 仓库内真实示例封面用于视觉验收，不访问外部图片服务。 */
const reviewPoster = readFileSync(
  new URL('../public/demo/field-study-poster.jpg', import.meta.url),
);

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

async function mockApi(target: Pick<Page, 'route'>) {
  let settings: AiSettings = {
    baseUrl: initialCredential.baseUrl,
    configured: true,
    keyFingerprint: initialCredential.keyFingerprint,
    defaultModels: {},
  };
  const models = [
    { id: 'mock-text', name: 'Mock Text', mediaTypes: ['text'] },
    { id: 'mock-text-v2', name: 'Mock Text v2', mediaTypes: ['text'] },
    {
      id: 'mock-image',
      name: 'Mock Image',
      mediaTypes: ['image'],
      capabilities: {
        qualities: ['1k', '2k', '3k', '4k'],
        aspectRatios: ['1:1', '16:9', '9:16'],
        // 图片编辑能力必须由目录显式声明；未声明的模型在请求前失败。
        imageEdit: { supported: true, mimeTypes: ['image/png', 'image/jpeg'] },
      },
    },
    { id: 'mock-audio', name: 'Mock Audio', mediaTypes: ['audio'] },
    {
      id: 'mock-video',
      name: 'Mock Video',
      mediaTypes: ['video'],
      capabilities: {
        resolutions: ['360p', '480p', '720p', '1080p'],
        aspectRatios: ['1:1', '16:9', '9:16'],
        durations: [4, 8, 12],
      },
    },
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
  /** 上传字节在隔离 Mock 中按会话保存，验证文本修改刷新后的实际内容。 */
  const uploadedBytes = new Map<string, Buffer>();
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

  await target.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === 'POST' && path === '/v1/auth/logout') {
      await json(route, { ok: true });
      return;
    }

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
      uploadedBytes.set(path.split('/')[4], request.postDataBuffer() ?? Buffer.alloc(0));
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
      const bytes = uploadedBytes.get(uploadId);
      if (bytes)
        generatedContent.set(asset.contentUrl, { contentType: asset.mimeType, body: bytes });
      assets.unshift(asset);
      await json(route, { asset }, 201);
      return;
    }
    if (request.method() === 'POST' && /^\/v1\/assets\/[^/]+\/access-url$/.test(path)) {
      return json(route, {
        url: `${path.replace('/access-url', '/content')}?access_token=synthetic-preview`,
      });
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
    if (request.method() === 'DELETE' && /^\/v1\/settings\/ai\/credentials\/[^/]+$/.test(path)) {
      const id = path.split('/')[5];
      const removed = credentials.find((entry) => entry.id === id);
      if (!removed) return json(route, { error: '凭据不存在' }, 404);
      credentials = credentials.filter((entry) => entry.id !== id);
      if (removed.active)
        settings = { ...settings, baseUrl: '', configured: false, keyFingerprint: undefined };
      await json(route, { settings, credentials });
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
  await page.context().addInitScript(() => {
    // Playwright 为每个测试创建独立上下文；刷新时保留模型记忆等真实持久化行为。
    // 私有画布验收使用模拟会话；所有 API 均由本文件拦截，不访问真实账户。
    window.localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'e2e-synthetic-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'e2e-user',
          email: 'e2e@example.com',
          role: 'admin',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
  });
  await mockApi(page);
});

/** 安装单节点媒体夹具，所有读写均由既有 Mock 接管，不访问真实账户或供应商。 */
async function installPreviewControlsFixture(
  page: Page,
  mediaType: 'text' | 'image' | 'video',
  width = 640,
  height = 360,
) {
  const mimeType =
    mediaType === 'image' ? 'image/svg+xml' : mediaType === 'video' ? 'video/mp4' : 'text/plain';
  const body =
    mediaType === 'image'
      ? Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#518575"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#f6deb0"/></svg>`,
        )
      : mediaType === 'video'
        ? readFileSync(new URL('../public/demo/field-study.mp4', import.meta.url))
        : Buffer.from('独立的文本节点验收内容');
  const asset: Asset = {
    id: 'preview-controls-asset',
    name: `${mediaType}-original`,
    mediaType,
    mimeType,
    sizeBytes: body.length,
    status: 'ready',
    tags: [],
    contentUrl: '/v1/assets/preview-controls-asset/content',
  };
  const canvas: CanvasDocument = {
    revision: 0,
    edges: [],
    nodes: [
      {
        id: 'preview-controls-node',
        type: mediaType,
        position: { x: 100, y: 120 },
        width: 180,
        height: 180,
        data: {
          label: '预览验收节点',
          mediaType,
          mode: 'generate',
          enabled: true,
          assetId: asset.id,
          contentUrl: asset.contentUrl,
          mimeType,
          manualOutput: true,
        },
      },
    ],
  };
  await page.route('**/v1/projects/project-smoke/canvas', async (route) => {
    if (route.request().method() === 'GET') await json(route, { canvas });
    else await route.fallback();
  });
  await page.route('**/v1/assets', async (route) => json(route, { assets: [asset] }));
  await page.route('**/v1/assets/preview-controls-asset/content**', async (route) => {
    await route.fulfill({ contentType: mimeType, body });
  });
  return { asset, body };
}

test('节点操作改进：文本悬浮卡片随图标收缩并允许超出节点', async ({ page }, testInfo) => {
  await installPreviewControlsFixture(page, 'text');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(projectPath);
  const node = page.locator('.flow-generate-node');
  await expect(node.locator('pre')).toBeVisible();
  await page.locator('.react-flow__controls-zoomout').click({ clickCount: 4 });
  await expect
    .poll(() => node.evaluate((element) => element.getBoundingClientRect().width))
    .toBeLessThan(180);
  await node.hover();
  const controls = node.locator('.flow-node-floating-controls');
  await expect(controls).toBeVisible();
  await expect(controls.getByRole('button', { name: '重命名节点：预览验收节点' })).toBeVisible();
  await expect(controls.locator('.flow-node-label')).toHaveCount(0);
  await expect(controls.locator('.flow-node-actions')).toHaveCount(0);
  const sizes = { node: await node.boundingBox(), controls: await controls.boundingBox() };
  expect(sizes.controls!.width).toBeGreaterThan(sizes.node!.width);
  await page.screenshot({ path: testInfo.outputPath('text-controls-zoomed-out.png') });
  const beforeDrag = await node.boundingBox();
  const handle = await controls.getByRole('button', { name: '拖动移动节点' }).boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 80, handle!.y + handle!.height / 2 + 40, {
    steps: 6,
  });
  await page.mouse.up();
  await expect.poll(async () => (await node.boundingBox())!.x - beforeDrag!.x).toBeGreaterThan(50);
});

for (const size of [
  { width: 1600, height: 900, name: '横图' },
  { width: 900, height: 1600, name: '竖图' },
  { width: 1200, height: 1200, name: '方图' },
  { width: 120, height: 80, name: '小图' },
]) {
  test(`节点操作改进：${size.name}首击输入再次预览且适配原始比例`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await installPreviewControlsFixture(page, 'image', size.width, size.height);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(projectPath);
    const node = page.locator('.flow-generate-node');
    const inlineImage = node.locator('img');
    await expect
      .poll(() => inlineImage.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(size.width);
    const originalBounds = await node.boundingBox();
    await inlineImage.click();
    await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await inlineImage.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const image = dialog.locator('img');
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(size.width);
    await expect
      .poll(async () => {
        const box = await image.boundingBox();
        return Math.abs(box!.width / box!.height - size.width / size.height);
      })
      .toBeLessThan(0.02);
    const imageBounds = await image.boundingBox();
    expect(imageBounds!.width).toBeLessThanOrEqual(size.width + 1);
    expect(imageBounds!.height).toBeLessThanOrEqual(size.height + 1);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1441);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(901);
    const stageBounds = await dialog.locator('.artifact-preview-viewer-stage').boundingBox();
    expect(Math.abs(stageBounds!.width - imageBounds!.width)).toBeLessThan(2);
    expect(Math.abs(stageBounds!.height - imageBounds!.height)).toBeLessThan(2);
    await page.screenshot({
      path: testInfo.outputPath(`preview-${size.width}x${size.height}.png`),
    });
    await page.setViewportSize({ width: 1024, height: 640 });
    await expect
      .poll(async () => {
        const b = await dialog.boundingBox();
        return b!.y + b!.height;
      })
      .toBeLessThanOrEqual(641);
    await page.screenshot({ path: testInfo.outputPath('preview-desktop-compact.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => {
        const b = await dialog.boundingBox();
        return b!.x + b!.width;
      })
      .toBeLessThanOrEqual(391);
    await page.screenshot({ path: testInfo.outputPath('preview-narrow.png') });
    await page.getByRole('button', { name: '关闭预览' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    expect((await node.boundingBox())!.width).toBeCloseTo(originalBounds!.width, 1);
    expect((await node.boundingBox())!.height).toBeCloseTo(originalBounds!.height, 1);
    expect(errors).toEqual([]);
  });
}

test('节点操作改进：全选后图片仍先打开输入框再预览', async ({ page }) => {
  await installPreviewControlsFixture(page, 'image');
  await page.goto(projectPath);
  const node = page.locator('.flow-generate-node');
  await expect(node.locator('img')).toBeVisible();
  await focusCanvas(page);
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toHaveCount(0);
  await node.locator('img').click();
  await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await node.locator('img').click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('节点操作改进：资源图片节点首击输入再次预览', async ({ page }) => {
  await installPreviewControlsFixture(page, 'image');
  await page.goto(projectPath);
  const node = page.locator('.flow-generate-node');
  await expect(node.locator('img')).toBeVisible();
  await node.locator('img').click();
  await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await node.locator('img').click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

for (const mediaType of ['image', 'video'] as const) {
  test(`节点操作改进：${mediaType}悬浮下载保存原始字节且不打开预览`, async ({ page }, testInfo) => {
    const { body } = await installPreviewControlsFixture(page, mediaType);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(projectPath);
    const node = page.locator('.flow-generate-node');
    await expect(node.locator(mediaType === 'image' ? 'img' : 'video')).toBeVisible();
    await node.hover();
    const downloadEvent = page.waitForEvent('download');
    await node.getByRole('button', { name: /^下载/ }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(mediaType === 'image' ? /\.svg$/ : /\.mp4$/);
    const saved = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(saved);
    expect(readFileSync(saved).equals(body)).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (mediaType === 'video') {
      await node.getByRole('button', { name: '播放视频', exact: true }).click();
      await expect
        .poll(() => node.locator('video').evaluate((video: HTMLVideoElement) => video.paused))
        .toBe(false);
      await node.getByRole('button', { name: /^预览视频/ }).click();
      const dialog = page.getByRole('dialog');
      const video = dialog.locator('video');
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth))
        .toBeGreaterThan(0);
      const ratio = await video.evaluate(
        (element: HTMLVideoElement) => element.videoWidth / element.videoHeight,
      );
      await expect
        .poll(async () => {
          const box = await video.boundingBox();
          return Math.abs(box!.width / box!.height - ratio);
        })
        .toBeLessThan(0.02);
      await page.screenshot({ path: testInfo.outputPath('video-preview-original-ratio.png') });
    }
  });
}

test('相对签名产物地址在 API origin 加载且回显不改变节点尺寸', async ({ page }, testInfo) => {
  const requests: string[] = [];
  await page.route('**/v1/assets/*/access-url', async (route) => {
    const assetId = new URL(route.request().url()).pathname.split('/')[3];
    await json(route, { url: `/v1/assets/${assetId}/content?access_token=synthetic-preview` });
  });
  page.on('request', (request) => {
    if (request.url().includes('access_token=synthetic-preview')) requests.push(request.url());
  });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建图片生成节点' }).click();
  await page.getByRole('textbox', { name: '提示词', exact: true }).fill('签名地址回显验收');
  const node = page.locator('.flow-generate-node').last();
  const initial = await node.boundingBox();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await testInfo.attach('signed-preview-requests', {
    body: JSON.stringify(
      requests.map((url) => url.replace(/access_token=[^&]+/, 'access_token=REDACTED')),
    ),
    contentType: 'application/json',
  });
  expect(new URL(requests.at(-1)!).origin).toBe('http://localhost:3000');
  await expect
    .poll(() => node.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(1);
  expect((await node.boundingBox())!.height).toBeCloseTo(initial!.height, 1);
});

test('当前节点上传、文字双击保存、刷新与重新生成保持输出优先级', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await page.getByRole('textbox', { name: '提示词', exact: true }).fill('原生成任务');
  await page.getByRole('button', { name: '生成', exact: true }).click();
  const node = page.locator('.flow-generate-node');
  await expect(node.locator('pre')).toContainText('原生成任务');
  const originalBounds = await node.boundingBox();
  await node.locator('input[type="file"]').setInputFiles({
    name: 'manual.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('手动上传正文'),
  });
  await expect(node.locator('pre')).toHaveText('手动上传正文');
  await expect(page.getByText('已保存到项目', { exact: true })).toBeVisible();
  await page.reload();
  await expect(node.locator('pre')).toHaveText('手动上传正文');
  await node.locator('pre').dblclick();
  const editor = node.getByRole('textbox', { name: '编辑文字结果' });
  await editor.fill('修改后的第一行\n修改后的第二行');
  await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
  await expect(node.locator('pre')).toHaveText('修改后的第一行\n修改后的第二行');
  await expect(page.getByText('已保存到项目', { exact: true })).toBeVisible();
  await page.reload();
  await expect(node.locator('pre')).toHaveText('修改后的第一行\n修改后的第二行');
  await expect(node).toHaveCount(1);
  const stored = await page.evaluate(async () => {
    const response = await fetch('http://localhost:3000/v1/projects/project-smoke/canvas');
    return (await response.json()).canvas as CanvasDocument;
  });
  expect(stored.nodes[0].data).toMatchObject({
    mode: 'generate',
    manualOutput: true,
    prompt: '原生成任务',
  });
  expect(stored.nodes[0]).toMatchObject({ width: 270, height: 246 });
  expect(originalBounds).not.toBeNull();
  await node.locator('pre').click();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(node.locator('pre')).toContainText('原生成任务');
  await expect(page.getByText('已保存到项目', { exact: true })).toBeVisible();
  await page.reload();
  await expect(node.locator('pre')).toContainText('原生成任务');
  expect(errors).toEqual([]);
});

test('文字保存失败保留草稿且重试不重复上传', async ({ page }) => {
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  const node = page.locator('.flow-generate-node');
  await node
    .locator('input[type="file"]')
    .setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('原始文本') });
  await expect(node.locator('pre')).toHaveText('原始文本');
  await expect(page.getByText('已保存到项目', { exact: true })).toBeVisible();
  let failSave = true;
  let uploads = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/uploads/init')) uploads++;
  });
  await page.route('**/v1/projects/project-smoke/canvas', async (route) => {
    if (failSave && route.request().method() === 'PATCH')
      await json(route, { error: '隔离保存失败' }, 503);
    else await route.fallback();
  });
  await node.locator('pre').dblclick();
  await node.getByRole('textbox', { name: '编辑文字结果' }).fill('失败后保留的正文');
  await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
  await expect(node.getByRole('textbox', { name: '编辑文字结果' })).toHaveValue('失败后保留的正文');
  await expect(node.getByRole('button', { name: '重试保存' })).toBeVisible();
  failSave = false;
  await node.getByRole('button', { name: '重试保存' }).click();
  await expect(node.locator('pre')).toHaveText('失败后保留的正文');
  expect(uploads).toBe(1);
  await page.reload();
  await expect(node.locator('pre')).toHaveText('失败后保留的正文');
});

test('上传中禁止生成且删除节点后不会被晚到上传复活', async ({ page }) => {
  let releaseUpload!: () => void;
  const delayed = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route('**/v1/assets/uploads/*/content', async (route) => {
    await delayed;
    await route.fallback();
  });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建图片生成节点' }).click();
  const node = page.locator('.flow-generate-node');
  await page.getByRole('textbox', { name: '提示词', exact: true }).fill('上传期间不可生成');
  const pending = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().includes('/uploads/'),
  );
  await node
    .locator('input[type="file"]')
    .setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: validPng });
  await pending;
  // 上传会让生成按钮进入“生成中”状态；两种状态都必须保持不可点击。
  await expect(page.getByRole('button', { name: /^(生成|生成中)$/ })).toBeDisabled();
  await node.getByRole('button', { name: /^删除节点：/ }).click();
  releaseUpload();
  await expect(page.locator('.asset-card').filter({ hasText: 'late.png' })).toBeVisible();
  await expect(node).toHaveCount(0);
});

test('画布保存失败时账户菜单导航停留原项目', async ({ page }) => {
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await page.route('**/v1/projects/project-smoke/canvas', async (route) => {
    if (route.request().method() === 'PATCH') await json(route, { error: '隔离导航保存失败' }, 503);
    else await route.fallback();
  });
  await page.getByRole('textbox', { name: '提示词', exact: true }).fill('不能丢失的导航前草稿');
  await page.getByRole('button', { name: '账户菜单' }).click();
  await page.getByRole('menuitem', { name: '我的资源', exact: true }).click();
  await expect(page).toHaveURL(projectPath);
  await expect(page.getByRole('alert')).toContainText('隔离导航保存失败');
  await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue(
    '不能丢失的导航前草稿',
  );
});

test('桌面六主题节点外壳与短枚举菜单保持尺寸和可点击布局', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建图片生成节点' }).click();
  const node = page.locator('.flow-generate-node');
  await node
    .locator('input[type="file"]')
    .setInputFiles({ name: 'review.jpg', mimeType: 'image/jpeg', buffer: reviewPoster });
  await expect
    .poll(() => node.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(1);
  const initial = await node.boundingBox();
  await page.getByRole('button', { name: '媒体参数', exact: true }).hover();
  await page.getByRole('combobox', { name: /^图片清晰度：/ }).hover();
  await expect(page.getByRole('option', { name: '1K', exact: true })).toBeVisible();
  const columns = await page
    .locator('.compact-select-menu[data-layout="grid"]')
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(columns.split(' ')).toHaveLength(3);
  const chrome = await node.evaluate((element) => {
    const style = getComputedStyle(element);
    return { shadow: style.boxShadow };
  });
  expect(chrome.shadow).not.toMatch(/0px 0px 0px 2px/);
  expect(chrome.shadow).not.toMatch(/0px 0px 0px 3px/);
  expect(chrome.shadow).not.toMatch(/8px 22px/);
  for (const theme of ['default', 'light', 'eye-care', 'dark', 'sepia', 'contrast']) {
    await page.evaluate((value) => {
      for (const element of [document.documentElement, document.querySelector('.app-shell')!]) {
        if (value === 'default') element.removeAttribute('data-theme');
        else element.setAttribute('data-theme', value);
      }
    }, theme);
    await page.screenshot({
      path: `../../.data/canvas-optimization-review/theme-${theme}.png`,
      animations: 'disabled',
    });
    const bounds = await node.boundingBox();
    expect(bounds!.height).toBeCloseTo(initial!.height, 1);
    expect(bounds!.width).toBeCloseTo(initial!.width, 1);
  }
  expect(errors).toEqual([]);
});

test('资源预览按衍生图加载，筛选不改变返回项目且跨页前保存', async ({ page }) => {
  const resourceAssets = (['image', 'video', 'audio', 'text'] as const).map((mediaType) => ({
    id: `review-${mediaType}`,
    name: `${mediaType}-review`,
    mediaType,
    mimeType:
      mediaType === 'text'
        ? 'text/plain'
        : `${mediaType}/${mediaType === 'image' ? 'jpeg' : mediaType === 'video' ? 'webm' : 'wav'}`,
    contentUrl: `/v1/assets/review-${mediaType}/content`,
    sizeBytes: 2048,
    status: 'ready',
    tags: [],
    ownerId: 'e2e-user',
    projectId: project.id,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    source: 'upload',
    metadata: { width: mediaType === 'image' ? 800 : 1200, height: 600 },
  }));
  const contentRequests: string[] = [];
  await mockApi(page.context());
  await page.context().route('**/v1/assets/*/content**', async (route) => {
    const url = new URL(route.request().url());
    contentRequests.push(url.pathname + url.search);
    const asset = resourceAssets.find((candidate) => url.pathname.includes(candidate.id))!;
    if (asset.mediaType === 'text')
      return route.fulfill({ contentType: 'text/plain', body: '这是一段可检查的文本摘录。' });
    if (url.searchParams.has('derivative') || asset.mediaType === 'image')
      return route.fulfill({ contentType: 'image/jpeg', body: reviewPoster });
    return route.fulfill({
      contentType: asset.mimeType,
      body: asset.mediaType === 'video' ? validWebm : validWav,
    });
  });
  await page.context().route('**/v1/account/resources**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/content')) {
      contentRequests.push(url.pathname + url.search);
      const asset = resourceAssets.find((candidate) => url.pathname.includes(candidate.id))!;
      if (asset.mediaType === 'text')
        return route.fulfill({ contentType: 'text/plain', body: '这是一段可检查的文本摘录。' });
      if (url.searchParams.has('derivative') || asset.mediaType === 'image')
        return route.fulfill({ contentType: 'image/jpeg', body: reviewPoster });
      return route.fulfill({
        contentType: asset.mimeType,
        body: asset.mediaType === 'video' ? validWebm : validWav,
      });
    }
    const selected = resourceAssets.find((candidate) => url.pathname.endsWith(candidate.id));
    await json(
      route,
      selected
        ? { asset: selected, versions: [] }
        : { assets: resourceAssets, total: 4, page: 1, pageSize: 24 },
    );
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await page.getByRole('textbox', { name: '提示词', exact: true }).fill('离开前必须保存');
  await page.getByRole('button', { name: '账户菜单' }).click();
  const resourcesPagePromise = page.waitForEvent('popup');
  await page.getByRole('menuitem', { name: '我的资源', exact: true }).click();
  const resourcesPage = await resourcesPagePromise;
  await expect(page).toHaveURL(projectPath);
  await expect(resourcesPage).toHaveURL(/resources\?returnProjectId=project-smoke/);
  await expect(resourcesPage.locator('.mg-resource-item')).toHaveCount(4);
  await expect(resourcesPage.getByText('这是一段可检查的文本摘录。')).toBeVisible();
  await expect
    .poll(() =>
      resourcesPage
        .locator('.mg-thumbnail img')
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  expect(contentRequests.some((url) => url.includes('derivative=poster'))).toBe(true);
  expect(contentRequests.some((url) => url.includes('derivative=waveform'))).toBe(true);
  expect(contentRequests.some((url) => /review-(video|audio)\/content$/.test(url))).toBe(false);
  await resourcesPage.getByRole('combobox', { name: '所属项目' }).selectOption(project.id);
  await resourcesPage.getByRole('combobox', { name: '所属项目' }).selectOption('');
  const back = resourcesPage.getByRole('link', { name: /返回项目/ });
  await expect(back).toHaveAttribute('href', projectPath);
  await resourcesPage.screenshot({ path: '../../.data/canvas-optimization-review/resources.png' });
  await resourcesPage.locator('.mg-resource-item').filter({ hasText: 'image-review' }).click();
  await expect(resourcesPage.getByRole('dialog')).toBeVisible();
  await resourcesPage.getByRole('button', { name: '下一个资源' }).click();
  await expect(resourcesPage.getByRole('dialog').locator('video')).toBeVisible();
  await resourcesPage.keyboard.press('Escape');
  await expect(resourcesPage.getByRole('dialog')).toHaveCount(0);
  await back.click();
  await expect(resourcesPage).toHaveURL(projectPath);
  await page.locator('.flow-generate-node').click();
  await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue(
    '离开前必须保存',
  );
});

test('主页进入工作台和项目深链，并在刷新后恢复画布', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'Multimodal Canvas' })).toBeVisible();
  await expect(page.getByLabel('多模态生成工作流预览')).toBeVisible();
  await expect(page.getByRole('heading', { name: '从第一个想法，到最终画面。' })).toBeVisible();

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

test('独立登录页支持键盘和浏览器返回，不锁住工作台焦点', async ({ page }) => {
  await page.goto(projectPath);

  await page.getByRole('button', { name: '账户菜单' }).click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Multimodal Canvas' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: '进入工作台', exact: true }).click();
  const trigger = page.locator('.mc-workspace-heading').getByRole('button', { name: '新建项目' });
  await trigger.click();
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/auth/login');
  expect(new URL(page.url()).searchParams.get('next')).toBe('/workspace?create=1');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('邮箱', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/workspace');
  await expect(page.getByRole('heading', { name: '项目工作台' })).toBeVisible();
  await expect(trigger).toBeEnabled();
  await expect(page.locator('.mc-page-shell')).not.toHaveAttribute('inert');
});

test('匿名新建项目在登录后恢复表单，显式提交才创建并进入画布', async ({ page }) => {
  // 登录和创建均命中模拟 API，不创建真实账户或项目。
  await page.route('**/v1/auth/login', async (route) => {
    await json(route, {
      accessToken: 'e2e-synthetic-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      user: {
        id: 'e2e-user',
        email: 'e2e@example.com',
        role: 'user',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '账户菜单' }).click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page).toHaveURL('/');
  /** 记录创建调用，验证认证成功不会自动重放用户写入。 */
  const projectPosts: Array<{ authorization?: string; body: unknown }> = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/v1/projects' && request.method() === 'POST') {
      projectPosts.push({
        authorization: request.headers().authorization,
        body: request.postDataJSON(),
      });
    }
  });
  await page.getByRole('link', { name: '进入工作台', exact: true }).click();
  await page.locator('.mc-workspace-heading').getByRole('button', { name: '新建项目' }).click();
  const loginHeading = page.getByRole('heading', { name: '登录工作台' });
  await expect(loginHeading).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/auth/login');
  expect(new URL(page.url()).searchParams.get('next')).toBe('/workspace?create=1');
  expect(projectPosts).toHaveLength(0);
  await page.getByLabel('邮箱', { exact: true }).fill('e2e@example.com');
  await page.getByLabel('密码', { exact: true }).fill('synthetic-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: '新建项目' });
  await expect(createDialog).toBeVisible();
  await expect(loginHeading).toHaveCount(0);
  await expect(page).toHaveURL('/workspace');
  expect(projectPosts).toHaveLength(0);
  await createDialog.getByLabel('项目名称').fill(project.name);
  await createDialog.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page).toHaveURL(projectPath);
  await expect(page.locator('.react-flow')).toBeVisible();
  expect(projectPosts).toEqual([
    { authorization: 'Bearer e2e-synthetic-token', body: { name: project.name } },
  ]);
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
  await expect(page.getByRole('region', { name: '文字生成节点生成设置' })).toBeVisible();
});

test('supports theme/sidebar controls, node body connections, and corner resizing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto(projectPath);

  await page.getByRole('button', { name: '新建图片生成节点' }).click();
  await page.locator('.resource-panel input[type="file"]').setInputFiles({
    name: 'body-reference.png',
    mimeType: 'image/png',
    buffer: validPng,
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

test('设置删除当前 Key 完整移除列表与模型，操作期间显示 loading', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '打开设置' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 连接' });
  await dialog.getByLabel('New API Base URL').fill('https://delete-smoke.example.test/v1');
  await dialog.getByRole('textbox', { name: 'API Key' }).fill('synthetic-browser-key');
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route('**/v1/settings/ai', async (route) => {
    if (route.request().method() === 'PATCH') await saveGate;
    await route.fallback();
  });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '正在保存', exact: true })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(dialog.getByRole('button', { name: '关闭设置' })).toBeDisabled();
  releaseSave();
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  const keys = dialog.getByLabel('已保存的 API Key');
  await expect(keys.locator('option')).toHaveCount(3);
  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  await page.route('**/v1/settings/ai/credentials/*', async (route) => {
    if (route.request().method() === 'DELETE') await deleteGate;
    await route.fallback();
  });
  await dialog.getByRole('button', { name: '删除当前 Key', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '正在删除', exact: true })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await page.screenshot({ path: testInfo.outputPath('settings-delete-loading.png') });
  releaseDelete();
  await expect(keys.locator('option')).toHaveCount(2);
  await expect(keys).not.toContainText('delete-smoke');
  await expect(dialog.getByText('平台全局默认')).toHaveCount(0);
  await expect(dialog.getByText('当前项目默认')).toHaveCount(0);
  await keys.selectOption(initialCredential.id);
  await expect(dialog.getByRole('button', { name: '删除当前 Key', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '删除当前 Key', exact: true }).click();
  await expect(keys.locator('option')).toHaveCount(1);
  await expect(keys).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('settings-all-removed.png') });
  await dialog.getByRole('button', { name: '关闭设置' }).click();
  await page.reload();
  await page.getByRole('button', { name: '打开设置' }).click();
  await expect(page.getByLabel('已保存的 API Key').locator('option')).toHaveCount(1);
  expect(errors).toEqual([]);
});

for (const width of [1440, 1024, 390]) {
  test(`生成节点轻描边与顶部悬浮操作 ${width}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(projectPath);
    await page.getByRole('button', { name: '新建图片生成节点' }).click();
    const node = page.locator('.flow-generate-node');
    const placeholder = node.locator('.flow-node-placeholder');
    await expect(placeholder).toBeVisible();
    const appearance = await node.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const controls = element
        .querySelector('.flow-node-floating-controls')!
        .getBoundingClientRect();
      const content = element.querySelector('.flow-node-placeholder')!.getBoundingClientRect();
      return {
        border: style.borderTopWidth,
        shadow: style.boxShadow,
        padding: style.paddingTop,
        controlsAbove: controls.bottom <= bounds.top + 1,
        fillsWidth: Math.abs(content.width - bounds.width) <= 2.3,
        fillsHeight: Math.abs(content.height - bounds.height) <= 2.3,
      };
    });
    expect(appearance).toMatchObject({
      border: '1px',
      padding: '0px',
      controlsAbove: true,
      fillsWidth: true,
      fillsHeight: true,
    });
    expect(appearance.shadow).not.toBe('none');
    await page.screenshot({ path: testInfo.outputPath('node-floating-controls.png') });
    await node.getByRole('button', { name: '停用节点' }).click();
    await expect(node).toHaveAttribute('aria-disabled', 'true');
    await node.getByRole('button', { name: '启用节点' }).click();
    await expect(node).toHaveAttribute('aria-disabled', 'false');
    await node.getByRole('button', { name: /^删除节点：/ }).click();
    await expect(page.locator('.flow-generate-node')).toHaveCount(0);
    await page.getByRole('button', { name: '画布撤销', exact: true }).click();
    await expect(page.locator('.flow-generate-node')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

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
    // 居中设置对话框在窄屏保留上下各 12px 的边距。
    expect(metrics.height).toBe(metrics.viewportHeight - 24);
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

test('uploads an asset and adds it to the workflow canvas with the add button', async ({
  page,
}) => {
  await page.goto(projectPath);

  await page.locator('.resource-panel input[type="file"]').setInputFiles({
    name: 'story.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A short story reference.'),
  });

  const assetCard = page.locator('.asset-card').filter({ hasText: 'story.txt' });
  await expect(assetCard).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '1 个资源已加入项目' })).toBeVisible();

  await assetCard.dragTo(page.locator('.canvas-area'));
  await expect(page.locator('.flow-asset-node')).toHaveCount(0);

  await page.getByRole('button', { name: '添加 story.txt 到画布' }).click();
  await expect(page.locator('.flow-asset-node')).toHaveCount(1);
  await expect(page.locator('.flow-asset-node')).toContainText('story.txt');
});

test('connects three image references to one video generation node', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1400 });
  await page.goto(projectPath);

  for (const name of ['character.png', 'style.png', 'frame.png']) {
    await page.locator('.resource-panel input[type="file"]').setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: validPng,
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
  const videoHeader = await videoNode.locator('.flow-node-placeholder').boundingBox();
  expect(videoHeader).not.toBeNull();
  if (!videoHeader) return;
  await page.mouse.move(
    videoHeader.x + videoHeader.width / 2,
    videoHeader.y + videoHeader.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 1100, canvasBox.y + 500, { steps: 12 });
  await page.mouse.up();
  for (const [index, name] of ['character.png', 'style.png', 'frame.png'].entries()) {
    const card = page.locator('.asset-card').filter({ hasText: name });
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    if (!cardBox) return;
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 100, canvasBox.y + 120 + index * 350, { steps: 12 });
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
  // 多条曲线在目标端交叠，点击靠近来源的可见线段，避免命中其他连接。
  const edgePoint = await selectedEdge
    .locator('.react-flow__edge-interaction')
    .evaluate((element) => {
      const path = element as SVGPathElement;
      for (let index = 1; index < 20; index++) {
        const point = path.getPointAtLength((path.getTotalLength() * index) / 20);
        const transformed = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
        if (
          document.elementFromPoint(transformed.x, transformed.y)?.closest('.react-flow__edge') ===
          path.closest('.react-flow__edge')
        )
          return { x: transformed.x, y: transformed.y };
      }
      throw new Error('没有可点击的未遮挡连接线段');
    });
  await page.mouse.click(edgePoint.x, edgePoint.y);
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
    await page.locator('.resource-panel input[type="file"]').setInputFiles(reference);
    await expect(page.locator('.asset-card').filter({ hasText: reference.name })).toBeVisible();
  }

  await page.getByRole('button', { name: '新建视频生成节点' }).click();
  const videoNode = page.locator('.flow-generate-node').filter({ hasText: '视频生成节点' });
  await expect(videoNode).toHaveCount(1);
  const sourceNodes = page.locator('.flow-asset-node:not(.flow-generate-node)');
  const canvasBox = await page.locator('.canvas-area').boundingBox();
  expect(canvasBox).not.toBeNull();
  if (!canvasBox) return;
  const videoHeader = await videoNode.locator('.flow-node-placeholder').boundingBox();
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

  const prompt = page.getByRole('textbox', { name: '提示词', exact: true });
  await expect(prompt).toBeVisible();
  await prompt.fill('验证模型覆盖后的生成结果');
  const runResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /^\/v1\/nodes\/[^/]+\/runs$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: '生成', exact: true }).click();
  const completedRun = ((await (await runResponse).json()) as { run: RunRecord }).run;
  expect(completedRun).toMatchObject({
    modelAlias: 'mock-text-v2',
    status: 'succeeded',
    result: { summary: 'Mock 结果已归档', asset: { version: 1 } },
  });
  const resultNode = page.locator('.flow-generate-node');
  await expect(resultNode.locator('.flow-node-preview')).toBeVisible();
  await expect(resultNode.locator('.artifact-preview-text-body')).toContainText(
    '这是根据“验证模型覆盖后的生成结果”生成的真实文本结果。',
  );
  await expect(resultNode.getByRole('img', { name: '运行成功' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '文字生成节点 已完成' })).toBeVisible();
});

test('新节点使用目录首项及凭据，历史手动模型刷新保留', async ({ page }) => {
  /** 记录浏览器运行错误；业务请求全部由合成 API 响应。 */
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await page.getByRole('combobox', { name: /^模型：/ }).hover();
  await page.getByRole('option', { name: 'Mock Text v2', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '模型：Mock Text v2' })).toBeVisible();

  await focusCanvas(page);
  await page.getByRole('button', { name: '新建图片生成节点' }).click();
  await expect(page.getByRole('combobox', { name: /^模型：/ })).not.toHaveAccessibleName(
    '模型：Mock Text v2',
  );
  await page.getByRole('combobox', { name: /^模型：/ }).hover();
  await page.getByRole('option', { name: 'Mock Image', exact: true }).click();
  await focusCanvas(page);
  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await expect(page.getByRole('combobox', { name: '模型：Mock Text' })).toBeVisible();

  /** 先等待包含模型和来源凭据的画布成功保存，再刷新验证持久化。 */
  const saved = page.waitForResponse((response) => {
    if (
      response.request().method() !== 'PATCH' ||
      new URL(response.url()).pathname !== `/v1/projects/${project.id}/canvas`
    )
      return false;
    const canvas = response.request().postDataJSON() as CanvasDocument;
    return (
      canvas.nodes.filter((node) => node.data.modelAlias === 'mock-text-v2').length === 1 &&
      canvas.nodes.some((node) => node.data.modelAlias === 'mock-text')
    );
  });
  await page.getByRole('textbox', { name: '提示词', exact: true }).fill('刷新后新建仍选目录首项');
  await saved;
  await page.reload();
  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await expect(page.getByRole('combobox', { name: '模型：Mock Text' })).toBeVisible();
  await page
    .getByRole('textbox', { name: '提示词', exact: true })
    .fill('复用的模型用于真实运行参数');
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /^\/v1\/nodes\/[^/]+\/runs$/.test(new URL(request.url()).pathname),
  );
  await page.getByRole('button', { name: '生成', exact: true }).click();
  expect((await submitted).postDataJSON()).toMatchObject({
    modelAlias: 'mock-text',
    credentialId: initialCredential.id,
  });
  await focusCanvas(page);
  await page.getByRole('button', { name: '新建图片生成节点' }).click();
  await expect(page.getByRole('combobox', { name: '模型：Mock Image' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('模型目录第二个真实选项写入新节点，保存刷新与生成提交保持一致', async ({ page }) => {
  /** 合成目录的第二项刻意区别于通用回退，验证实际目录而非固定界面文案。 */
  await page.route('**/v1/models*', (route) =>
    json(route, {
      models: [
        {
          id: 'mock-video',
          name: 'Mock Video',
          credentialId: initialCredential.id,
          mediaTypes: ['video'],
          capabilities: {
            resolutions: ['360p', '720p', '2160p'],
            aspectRatios: ['1:1', '4:3', '16:9'],
            durations: [2, 6, 10],
          },
        },
      ],
    }),
  );
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建视频生成节点' }).click();
  await page.getByRole('combobox', { name: /^模型：/ }).hover();
  await page.getByRole('option', { name: 'Mock Video', exact: true }).click();
  await focusCanvas(page);
  await page.getByRole('button', { name: '新建视频生成节点' }).click();
  const editor = page.locator('.node-quick-editor');
  await expect(editor.getByRole('button', { name: '媒体参数', exact: true })).toHaveText(
    '720p · 4:3 · 6s',
  );
  const saved = page.waitForResponse((response) => {
    if (
      response.request().method() !== 'PATCH' ||
      new URL(response.url()).pathname !== `/v1/projects/${project.id}/canvas`
    )
      return false;
    const canvas = response.request().postDataJSON() as CanvasDocument;
    return canvas.nodes.some((node) => node.data.prompt === '目录参数必须保存并用于生成');
  });
  await editor
    .getByRole('textbox', { name: '提示词', exact: true })
    .fill('目录参数必须保存并用于生成');
  const savedCanvas = ((await (await saved).json()) as { canvas: CanvasDocument }).canvas;
  const savedNode = savedCanvas.nodes.at(-1)!;
  expect(savedNode.data.parameters).toEqual({
    resolution: '720p',
    aspectRatio: '4:3',
    duration: 6,
  });
  await page.reload();
  await page.locator('.flow-generate-node').last().click();
  await expect(editor.getByRole('button', { name: '媒体参数', exact: true })).toHaveText(
    '720p · 4:3 · 6s',
  );
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /^\/v1\/nodes\/[^/]+\/runs$/.test(new URL(request.url()).pathname),
  );
  await editor.getByRole('button', { name: '生成', exact: true }).click();
  expect((await submitted).postDataJSON().parameters).toEqual({
    prompt: '目录参数必须保存并用于生成',
    ...savedNode.data.parameters,
  });
});

test('四类节点都可以填写提示词、运行并显示对应结果预览', async ({ page }) => {
  await page.goto(projectPath);

  const mediaCases = [
    { mediaType: '文字', resultSelector: '.flow-node-preview .artifact-preview-text-body' },
    { mediaType: '图片', resultSelector: '.flow-node-preview img' },
    { mediaType: '音频', resultSelector: '.flow-node-preview audio' },
    { mediaType: '视频', resultSelector: '.flow-node-preview video' },
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
    await expect(page.getByRole('region', { name: `${mediaType}生成节点生成设置` })).toBeVisible();
    /** 内容回显不能改变节点外框；只有用户拖拽允许修改尺寸。 */
    const initialNodeBounds = await node.boundingBox();
    expect(initialNodeBounds).not.toBeNull();

    const prompt = page.getByRole('textbox', { name: '提示词', exact: true });
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
      await page.getByRole('combobox', { name: /^模型：/ }).hover();
      await page.getByRole('option', { name: 'Mock Audio', exact: true }).click();
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: '媒体参数', exact: true }).click();
      await page.getByRole('textbox', { name: '音色', exact: true }).fill('synthetic-smoke-voice');
    }
    await page.getByRole('button', { name: '生成', exact: true }).click();
    if (audioRunRequest) {
      const body = (await audioRunRequest).postDataJSON();
      expect(body.parameters).toMatchObject({
        voice: 'synthetic-smoke-voice',
        prompt: 'Playwright 音频 生成测试',
      });
      expect(body.parameters.response_format).toBe('opus');
      expect(body.parameters).not.toHaveProperty('speed');
    }

    await expect(node.getByRole('img', { name: '运行成功' })).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: `${mediaType}生成节点 已完成` }),
    ).toBeVisible();
    const result = node.locator(resultSelector);
    await expect(result).toHaveCount(1);
    await expect(node.locator('.flow-node-preview')).toBeVisible();
    const completedNodeBounds = await node.boundingBox();
    expect(completedNodeBounds).not.toBeNull();
    expect(completedNodeBounds!.width).toBeCloseTo(initialNodeBounds!.width, 1);
    expect(completedNodeBounds!.height).toBeCloseTo(initialNodeBounds!.height, 1);

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
  await page.getByRole('combobox', { name: /^模型：/ }).hover();
  await page.getByRole('option', { name: 'Mock Audio', exact: true }).click();

  const editor = page.locator('.node-quick-editor');
  const voice = editor.getByRole('textbox', { name: '音色', exact: true });
  const speed = editor.getByRole('spinbutton', { name: '语速', exact: true });
  const run = editor.getByRole('button', { name: '生成', exact: true });
  const syntheticVoice = 'synthetic/custom Voice-42';
  await editor.locator('textarea').fill('Playwright 音频参数保存恢复');
  await editor.getByRole('button', { name: '媒体参数', exact: true }).click();
  await expect(voice).toHaveValue('');
  await expect(voice).toHaveAttribute('required', '');
  await expect(speed).toHaveValue('');
  await expect(editor.getByRole('combobox', { name: '音频格式：OPUS' })).toBeVisible();
  await expect(run).toBeDisabled();
  await voice.fill(syntheticVoice);
  await editor.getByRole('combobox', { name: /^音频格式：/ }).click();
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
  await editor.getByRole('button', { name: '媒体参数', exact: true }).click();
  await expect(voice).toHaveValue(syntheticVoice);
  await expect(editor.getByRole('combobox', { name: '音频格式：WAV' })).toBeVisible();
  await expect(speed).toHaveValue('1.25');
  await expect(run).toBeEnabled();

  /** 三个音频字段在桌面同行展示，同时保留较长音色的可编辑宽度。 */
  const panel = editor.getByRole('region', { name: '生成参数' });
  const boxes = [];
  for (const control of [voice, editor.getByRole('combobox', { name: /^音频格式：/ }), speed]) {
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(panelBox!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
    expect(box!.width).toBeGreaterThan(60);
    boxes.push(box!);
  }
  expect(boxes[0].width).toBeCloseTo(boxes[1].width, 0);
  expect(boxes[0].y).toBeCloseTo(boxes[1].y, 0);
  expect(boxes[1].y).toBeCloseTo(boxes[2].y, 0);
  expect(boxes[0].x + boxes[0].width).toBeLessThan(boxes[1].x);
  expect(boxes[1].x + boxes[1].width).toBeLessThan(boxes[2].x);
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
  await expect(page.locator('.flow-generate-node .flow-node-preview audio')).toHaveAttribute(
    'controls',
    '',
  );
  expect(blockedOrigins).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('PC 视频仅显示清晰度比例时长，新建保存刷新与提交不填像素尺寸', async ({ page }, testInfo) => {
  /** 仅使用 beforeEach 的本地 Mock API，保存与运行请求不访问真实 Provider。 */
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(projectPath);
  await page.getByRole('button', { name: '新建视频生成节点' }).click();
  await page.getByRole('combobox', { name: /^模型：/ }).hover();
  await page.getByRole('option', { name: 'Mock Video', exact: true }).click();
  const editor = page.locator('.node-quick-editor');
  const width = editor.getByRole('spinbutton', { name: '宽度（像素）', exact: true });
  const height = editor.getByRole('spinbutton', { name: '高度（像素）', exact: true });
  const run = editor.getByRole('button', { name: '生成', exact: true });
  await editor.locator('textarea').fill('Playwright 视频像素尺寸');
  await editor.getByRole('button', { name: '媒体参数', exact: true }).click();
  await expect(width).toHaveCount(0);
  await expect(height).toHaveCount(0);
  await expect(run).toBeEnabled();
  await editor.getByRole('combobox', { name: /^时长（秒）：/ }).click();
  await editor.getByRole('option', { name: '8 秒', exact: true }).click();
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
        node.data.parameters?.duration === 8 &&
        node.data.parameters?.width === undefined &&
        node.data.parameters?.height === undefined,
    );
  });
  await editor.locator('textarea').fill('Playwright 视频参数');
  await savedDimensions;
  await page.reload();
  await page.locator('.flow-generate-node').filter({ hasText: '视频生成节点' }).click();
  await editor.getByRole('button', { name: '媒体参数', exact: true }).click();
  await expect(width).toHaveCount(0);
  await expect(height).toHaveCount(0);
  await expect(editor.getByRole('combobox', { name: '时长（秒）：8' })).toBeVisible();
  await expect(editor.getByRole('combobox', { name: '视频清晰度：480p' })).toBeVisible();
  await expect(editor.getByRole('button', { name: '视频比例：16:9' })).toBeVisible();
  await testInfo.attach('video-dimensions-desktop-1440x1000', {
    body: await page.screenshot({ fullPage: false, animations: 'disabled' }),
    contentType: 'image/png',
  });

  await expect(editor.getByRole('combobox', { name: '时长（秒）：8' })).toBeVisible();
  await expect(run).toBeEnabled();
  const submittedRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /^\/v1\/nodes\/[^/]+\/runs$/.test(new URL(request.url()).pathname),
  );
  await run.click();
  expect((await submittedRequest).postDataJSON().parameters).toEqual({
    prompt: 'Playwright 视频参数',
    duration: 8,
    resolution: '480p',
    aspectRatio: '16:9',
  });
  await expect(page.getByRole('status').filter({ hasText: '视频生成节点 已完成' })).toBeVisible();
  await expect(page.locator('.flow-generate-node .flow-node-preview video')).toHaveAttribute(
    'controls',
    '',
  );
  expect(errors).toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
]) {
  test(`编辑器参数浮层和放大对话框 ${viewport.width}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize(viewport);
    await page.goto(projectPath);
    await page.getByRole('button', { name: '新建视频生成节点' }).click();
    await page.getByRole('combobox', { name: /^模型：/ }).hover();
    await page.getByRole('option', { name: 'Mock Video', exact: true }).click();
    const editor = page.locator('.node-quick-editor');
    await editor.getByRole('textbox', { name: '提示词' }).fill('镜头缓缓掠过山间，晨光照亮林梢。');
    const summary = editor.getByRole('button', { name: '媒体参数', exact: true });
    await expect(summary).toHaveText('480p · 16:9 · 8s');
    await expect(editor.getByRole('region', { name: '生成参数' })).toBeHidden();
    const before = await editor.boundingBox();
    await summary.click();
    const panel = editor.getByRole('region', { name: '生成参数' });
    await expect(panel).toBeVisible();
    expect((await editor.boundingBox())!.height).toBeCloseTo(before!.height, 0);
    /** PC 参数首行固定三个字段；基础移动验收只要求不溢出。 */
    const resolution = panel.getByRole('combobox', { name: /视频清晰度/ });
    const ratio = panel.getByRole('button', { name: /视频比例：/ });
    const duration = panel.getByRole('combobox', { name: /时长（秒）/ });
    const controlBoxes = await Promise.all([
      resolution.boundingBox(),
      ratio.boundingBox(),
      duration.boundingBox(),
    ]);
    if (viewport.width >= 1024) {
      expect(Math.abs(controlBoxes[0]!.y - controlBoxes[1]!.y)).toBeLessThanOrEqual(3);
      expect(Math.abs(controlBoxes[1]!.y - controlBoxes[2]!.y)).toBeLessThanOrEqual(3);
      expect(controlBoxes[0]!.x + controlBoxes[0]!.width).toBeLessThan(controlBoxes[1]!.x);
      expect(controlBoxes[1]!.x + controlBoxes[1]!.width).toBeLessThan(controlBoxes[2]!.x);
    }
    await resolution.hover();
    const resolutionMenu = panel.getByRole('listbox', { name: '视频清晰度' });
    await expect(resolutionMenu).toBeVisible();
    /** 鼠标悬停向上展示，菜单无需撑大参数页且可直接点击。 */
    const menuBox = await resolutionMenu.boundingBox();
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(controlBoxes[0]!.y);
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({
      path: testInfo.outputPath('parameters-hover-upward.png'),
      animations: 'disabled',
    });
    await panel.getByRole('option', { name: '720p', exact: true }).click();
    await panel.getByRole('button', { name: /视频比例：/ }).click();
    await panel.getByRole('button', { name: /16:9/, exact: false }).last().click();
    await panel.getByRole('combobox', { name: /时长（秒）/ }).click();
    await panel.getByRole('option', { name: '8 秒', exact: true }).click();
    await page.mouse.move(1, 1);
    await panel.getByRole('button', { name: '收起媒体参数' }).click();
    await expect(summary).toHaveText('720p · 16:9 · 8s');
    for (const theme of ['明亮', '深色']) {
      await page.getByRole('button', { name: '切换主题', exact: true }).click();
      await page.getByRole('option', { name: theme, exact: true }).click();
      await expect
        .poll(() =>
          editor.evaluate(
            (el) =>
              getComputedStyle(el).backgroundColor ===
              getComputedStyle(el.querySelector('textarea')!).backgroundColor,
          ),
        )
        .toBe(true);
      await editor.getByRole('textbox', { name: '提示词' }).focus();
      /** 鼠标及键盘聚焦不产生提示词输入边框、描边或阴影。 */
      const promptFrame = await editor.getByRole('textbox', { name: '提示词' }).evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          border: style.borderTopColor,
          outline: style.outlineStyle,
          shadow: style.boxShadow,
        };
      });
      expect(promptFrame).toEqual({ border: 'rgba(0, 0, 0, 0)', outline: 'none', shadow: 'none' });
      await page.screenshot({
        path: testInfo.outputPath(`compact-${theme}.png`),
        animations: 'disabled',
      });
      await editor.getByRole('button', { name: '打开完整编辑器' }).click();
      const dialog = page.getByRole('dialog', { name: /视频生成节点 · 编辑设置/ });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: '提示词' })).toBeFocused();
      expect(
        await dialog.getByRole('textbox', { name: '提示词' }).evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            border: style.borderTopColor,
            outline: style.outlineStyle,
            shadow: style.boxShadow,
          };
        }),
      ).toEqual({ border: 'rgba(0, 0, 0, 0)', outline: 'none', shadow: 'none' });
      const geometry = await dialog.evaluate((el) => ({
        left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right,
        width: el.clientWidth,
        contentWidth: el.scrollWidth,
        background: getComputedStyle(el).backgroundColor,
        inputBackground: getComputedStyle(el.querySelector('textarea')!).backgroundColor,
      }));
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(viewport.width);
      expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.width);
      expect(geometry.background).toBe(geometry.inputBackground);
      await dialog.getByRole('textbox', { name: '提示词' }).fill('Dialog 编辑后仍保留最新提示词。');
      await page.screenshot({
        path: testInfo.outputPath(`dialog-${theme}.png`),
        animations: 'disabled',
      });
      await dialog.getByRole('button', { name: '关闭编辑器' }).click();
      await expect(editor.getByRole('textbox', { name: '提示词' })).toHaveValue(
        'Dialog 编辑后仍保留最新提示词。',
      );
      await expect(editor.getByRole('button', { name: '打开完整编辑器' })).toBeFocused();
    }
    expect(errors).toEqual([]);
  });
}

test('设置移除默认模型入口，节点自行选择模型后按所选模型运行', async ({ page }) => {
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
  await expect(dialog.getByText('平台全局默认')).toHaveCount(0);
  await expect(dialog.getByText('当前项目默认')).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭设置' }).click();

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await page.getByRole('combobox', { name: /^模型：/ }).hover();
  await page.getByRole('option', { name: 'Mock Text v2', exact: true }).first().click();
  const runResponse = page.waitForResponse(
    (response) =>
      /\/v1\/nodes\/[^/]+\/runs$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'POST',
  );
  const prompt = page.getByRole('textbox', { name: '提示词', exact: true });
  await expect(prompt).toBeVisible();
  await prompt.fill('验证默认模型切换后的新运行');
  await page.getByRole('button', { name: '生成', exact: true }).click();
  const run = (await (await runResponse).json()).run as RunRecord;

  expect(run.modelAlias).toBe('mock-text-v2');
  const resultNode = page.locator('.flow-generate-node');
  await expect(resultNode.locator('.flow-node-preview')).toBeVisible();
  await expect(resultNode.locator('.artifact-preview-text-body')).toContainText(
    '这是根据“验证默认模型切换后的新运行”生成的真实文本结果。',
  );
  await expect(page.getByRole('status').filter({ hasText: '文字生成节点 已完成' })).toBeVisible();
});

test('允许 Clipboard 权限时可以跨画布页面复制粘贴', async ({ page }) => {
  await page.goto(projectPath);
  await grantClipboardPermissions(page);

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await expect(page.getByRole('region', { name: '文字生成节点生成设置' })).toBeVisible();
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
  await expect(page.getByRole('region', { name: '文字生成节点生成设置' })).toBeVisible();
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
  await expect(page.getByRole('region', { name: '文字生成节点生成设置' })).toBeVisible();
  await page.bringToFront();
  await page.keyboard.press('Control+c');
  await expect.poll(() => readSystemClipboard(page)).toContain('multimodal-canvas/clipboard');

  await page.evaluate(async () => navigator.clipboard.writeText('plain text from outside the app'));
  await page.keyboard.press('Control+v');

  await expect(page.locator('.flow-generate-node')).toHaveCount(2);
});

/**
 * 安装“修改图片”验收夹具：一个已有回显的图片节点，以及一个正好占住其右侧
 * 首选位置的空图片节点，用于验证碰撞定位不会重叠。
 */
async function installImageEditFixture(page: Page) {
  const mimeType = 'image/png';
  const asset: Asset = {
    id: 'image-edit-source-asset',
    name: 'source-photo.png',
    mediaType: 'image',
    mimeType,
    sizeBytes: validPng.byteLength,
    latestVersion: 1,
    status: 'ready',
    contentUrl: '/v1/assets/image-edit-source-asset/content',
    tags: [],
  };
  const blockerAsset: Asset = {
    id: 'image-edit-blocker-asset',
    name: 'blocker-photo.png',
    mediaType: 'image',
    mimeType,
    sizeBytes: validPng.byteLength,
    latestVersion: 1,
    status: 'ready',
    contentUrl: '/v1/assets/image-edit-blocker-asset/content',
    tags: [],
  };
  const canvas: CanvasDocument = {
    revision: 0,
    edges: [],
    nodes: [
      {
        id: 'node-image-source',
        type: 'image',
        position: { x: 80, y: 140 },
        width: 400,
        height: 266,
        data: {
          label: '原始图片',
          mediaType: 'image',
          mode: 'generate',
          assetId: asset.id,
          contentUrl: asset.contentUrl,
          mimeType,
          manualOutput: true,
          // 来源是已归档的生成结果时，编辑节点在创建时就能冻结明确的资产版本。
          resultAsset: {
            assetId: asset.id,
            version: 1,
            contentUrl: asset.contentUrl,
            mimeType,
            sizeBytes: asset.sizeBytes,
          },
        },
      },
      {
        id: 'node-image-blocker',
        type: 'image',
        position: { x: 528, y: 140 },
        width: 400,
        height: 266,
        data: {
          label: '占位图片',
          mediaType: 'image',
          mode: 'generate',
          assetId: blockerAsset.id,
          contentUrl: blockerAsset.contentUrl,
          mimeType,
          manualOutput: true,
        },
      },
    ],
  };
  await page.route('**/v1/projects/project-smoke/canvas', async (route) => {
    if (route.request().method() === 'GET') await json(route, { canvas });
    else await route.fallback();
  });
  await page.route('**/v1/assets', async (route) => json(route, { assets: [asset, blockerAsset] }));
  await page.route('**/v1/assets/image-edit-source-asset/content**', async (route) => {
    await route.fulfill({ contentType: mimeType, body: validPng });
  });
  await page.route('**/v1/assets/image-edit-blocker-asset/content**', async (route) => {
    await route.fulfill({ contentType: mimeType, body: validPng });
  });
  return { asset, blockerAsset, canvas };
}

for (const viewport of [
  { width: 1600, height: 900, name: '桌面宽屏' },
  { width: 1100, height: 1100, name: '方形画布' },
]) {
  test(`修改图片：${viewport.name}新建节点并只把结果写入新节点`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const fixture = await installImageEditFixture(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(projectPath);

    const sourceNode = page.locator('.react-flow__node[data-id="node-image-source"]');
    const blockerNode = page.locator('.react-flow__node[data-id="node-image-blocker"]');
    await expect(sourceNode).toBeVisible();
    const sourceBoxBefore = await sourceNode.boundingBox();
    const blockerBoxBefore = await blockerNode.boundingBox();

    await sourceNode.hover();
    await expect(sourceNode.getByRole('button', { name: '修改图片：原始图片' })).toBeVisible();
    await sourceNode.getByRole('button', { name: '修改图片：原始图片' }).click();

    // 新节点使用全新 ID，画布节点数与显式来源边各增加一项。
    const editNode = page.locator('.react-flow__node[data-id^="node_image_generate"]');
    await expect(editNode).toHaveCount(1);
    await expect(editNode.getByRole('group', { name: '节点操作：修改 原始图片' })).toBeVisible();
    await expect(editNode).not.toHaveAttribute('data-id', 'node-image-source');
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    const editor = page.getByRole('region', { name: '修改 原始图片图片修改设置' });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('textbox', { name: '图片修改要求' })).toHaveValue('');
    await editor.getByRole('textbox', { name: '图片修改要求' }).fill('换成夜景');
    await editor.getByRole('button', { name: '生成' }).click();
    const readOnlySource = editor.getByRole('group', { name: '来源图（只读）' });
    await expect(readOnlySource).toContainText('原始图片');
    await expect(readOnlySource).toContainText('来源图固定版本：v1');
    await expect(readOnlySource.getByRole('img')).toHaveAttribute(
      'src',
      /\/v1\/assets\/image-edit-source-asset\/content/,
    );

    // 原节点位置与尺寸都不变，新节点避开已有节点。
    expect(await sourceNode.boundingBox()).toEqual(sourceBoxBefore);
    expect(await blockerNode.boundingBox()).toEqual(blockerBoxBefore);
    const editBox = await editNode.boundingBox();
    expect(editBox).not.toBeNull();
    expect(sourceBoxBefore).not.toBeNull();
    expect(blockerBoxBefore).not.toBeNull();
    if (editBox && sourceBoxBefore && blockerBoxBefore) {
      expect(editBox.x).toBeGreaterThan(sourceBoxBefore.x);
      const overlaps =
        editBox.x < blockerBoxBefore.x + blockerBoxBefore.width &&
        blockerBoxBefore.x < editBox.x + editBox.width &&
        editBox.y < blockerBoxBefore.y + blockerBoxBefore.height &&
        blockerBoxBefore.y < editBox.y + editBox.height;
      expect(overlaps).toBe(false);
    }

    await expect(page.getByText('修改 原始图片 已完成')).toBeVisible();
    await expect(editNode.locator('img').first()).toHaveAttribute('src', /\/v1\/assets\/result-/);
    await expect(sourceNode.locator('img').first()).toHaveAttribute(
      'src',
      /\/v1\/assets\/image-edit-source-asset\/content/,
    );
    expect(await sourceNode.boundingBox()).toEqual(sourceBoxBefore);

    await page.screenshot({ path: testInfo.outputPath(`image-edit-${viewport.name}.png`) });
    expect(errors).toEqual([]);
  });
}
