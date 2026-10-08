import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  canvasDocumentSchema,
  PROMPT_SKILLS,
  runRecordSchema,
  type Asset,
  type CanvasDocument,
} from '@multimodal-canvas/domain';

test.use({ serviceWorkers: 'block' });

/** 本规格只使用合成账号、项目、资料和固定版本，不连接真实生成服务。 */
const project = {
  id: 'canvas-resource-interactions',
  name: 'PC 资源交互隔离验收',
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
};
const nodeId = 'reference-editor-target';
const successNodeId = 'successful-share-target';
const promptText = '保留这段正文，选择文字只建立选区，明确引用才能插入。';
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));

/** 生成 Chromium 可解码的短静音 WAV，保证音频控件走真实媒体布局。 */
function silentWav() {
  const sampleCount = 80_000;
  const bytes = Buffer.alloc(44 + sampleCount * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(sampleCount * 2, 40);
  return bytes;
}

const audioBytes = silentWav();
const audioAsset: Asset = {
  id: 'synthetic-audio',
  name: '拖动验收音频.wav',
  mediaType: 'audio',
  mimeType: 'audio/wav',
  sizeBytes: audioBytes.length,
  status: 'ready',
  latestVersion: 1,
  contentUrl: '/v1/assets/synthetic-audio/versions/1/content',
  tags: [],
};
const images: Asset[] = Array.from({ length: 4 }, (_, index) => ({
  id: `reference-image-${index + 1}`,
  name: `项目参考图${index + 1}.jpg`,
  mediaType: 'image',
  mimeType: 'image/jpeg',
  sizeBytes: poster.length,
  status: 'ready',
  latestVersion: 2,
  contentUrl: `/v1/assets/reference-image-${index + 1}/versions/2/content`,
  tags: [],
}));
const successAsset: Asset = {
  ...images[0]!,
  id: 'successful-artifact',
  name: '成功产物.jpg',
  latestVersion: 5,
  contentUrl: '/v1/assets/successful-artifact/versions/5/content',
};

/** 根据交互场景建立最小画布；分享节点固定显示 v3，目录最新版本为 v5。 */
function initialCanvas(scenario: 'audio' | 'prompt' | 'share'): CanvasDocument {
  const promptNode = {
    id: nodeId,
    type: 'image',
    position: { x: 260, y: 200 },
    width: 320,
    height: 240,
    data: {
      label: '参考资料验收节点',
      mediaType: 'image',
      mode: 'generate',
      enabled: true,
      modelAlias: 'mock-image',
      promptDocument: { version: 1, blocks: [{ type: 'text', text: promptText }] },
    },
  };
  return canvasDocumentSchema.parse({
    revision: 1,
    nodes:
      scenario === 'audio'
        ? []
        : scenario === 'prompt'
          ? [promptNode]
          : [
              promptNode,
              {
                id: successNodeId,
                type: 'image',
                position: { x: 690, y: 200 },
                width: 320,
                height: 240,
                data: {
                  label: '成功产物',
                  mediaType: 'image',
                  mode: 'generate',
                  enabled: true,
                  modelAlias: 'mock-image',
                  assetId: successAsset.id,
                  mimeType: 'image/jpeg',
                  contentUrl: '/v1/assets/successful-artifact/versions/3/content',
                },
              },
            ],
    edges: [],
  });
}

/** 运行态由 GET runs 恢复，不能塞入会被持久画布校验剔除的运行字段。 */
function successfulRun() {
  const canvas = initialCanvas('share');
  return runRecordSchema.parse({
    id: 'synthetic-successful-run',
    projectId: project.id,
    targetNodeId: successNodeId,
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    provider: 'mock',
    modelAlias: 'mock-image',
    snapshot: {
      projectId: project.id,
      canvasRevision: canvas.revision,
      targetNodeId: successNodeId,
      modelAlias: 'mock-image',
      parameters: {},
      submittedAt: project.createdAt,
      nodes: canvas.nodes.filter((node) => node.id === successNodeId),
      edges: [],
      inputs: [],
    },
    result: {
      provider: 'mock',
      summary: '本地合成固定版本成功产物',
      simulated: true,
      targetNodeId: successNodeId,
      mediaType: 'image',
      inputCount: 0,
      asset: {
        assetId: successAsset.id,
        version: 3,
        mimeType: 'image/jpeg',
        sizeBytes: poster.length,
        contentUrl: '/v1/assets/successful-artifact/versions/3/content',
      },
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
}

/** 保留接口 JSON 结构及状态码。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 记录完整上传三阶段，断言只传本规格图片内容。 */
type Upload = {
  id: string;
  metadata: { name: string; mimeType: string; sizeBytes: number; sha256: string };
  stages: string[];
  asset?: Asset;
};

/** 安装严格本机 Mock；未声明网络、真实媒体设备和 Run 请求均会导致验收失败。 */
async function installFixture(
  page: Page,
  baseURL: string | undefined,
  scenario: 'audio' | 'prompt' | 'share',
) {
  if (!baseURL || !['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) {
    throw new Error('PC 资源验收只允许本机隔离 Web');
  }
  const webOrigin = new URL(baseURL).origin;
  const errors: string[] = [];
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const uploads: Upload[] = [];
  let canvas = initialCanvas(scenario);
  const assets = () => [
    audioAsset,
    ...images,
    successAsset,
    ...uploads.flatMap((u) => u.asset ?? []),
  ];
  const user = {
    id: 'canvas-resource-browser-user',
    email: 'canvas-resource-browser@example.test',
    role: 'user',
    createdAt: project.createdAt,
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript((sessionUser) => {
    localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user: sessionUser }));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    for (const name of ['getUserMedia', 'getDisplayMedia'] as const) {
      Object.defineProperty(navigator.mediaDevices, name, {
        configurable: true,
        value: () => Promise.reject(new Error('隔离验收禁止真实媒体设备')),
      });
    }
  }, user);
  await page.context().routeWebSocket('**/*', (socket) => {
    if (
      socket
        .url()
        .replace(/^ws:/, 'http:')
        .startsWith(webOrigin + '/')
    ) {
      socket.connectToServer();
      return;
    }
    errors.push('未声明 WebSocket：' + socket.url());
    socket.close();
  });
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (!path.startsWith('/v1/')) {
      if (
        url.origin === webOrigin &&
        method === 'GET' &&
        !['fetch', 'xhr', 'eventsource'].includes(request.resourceType())
      ) {
        return route.continue();
      }
      errors.push('未声明网络：' + method + ' ' + url.origin + path);
      return route.abort('blockedbyclient');
    }
    if (![webOrigin, 'http://localhost:3000'].includes(url.origin)) {
      errors.push('非 Mock API：' + method + ' ' + url.origin + path);
      return route.abort('blockedbyclient');
    }
    const body = request.headers()['content-type']?.includes('application/json')
      ? request.postDataJSON()
      : undefined;
    requests.push({ method, path, body });
    if (method === 'GET' && path === '/v1/auth/me') {
      return json(route, { user, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (method === 'GET' && path === '/v1/projects') return json(route, { projects: [project] });
    if (method === 'GET' && path === `/v1/projects/${project.id}`) return json(route, { project });
    if (method === 'GET' && path === `/v1/projects/${project.id}/events`) {
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    }
    if (path === `/v1/projects/${project.id}/canvas` && ['GET', 'PATCH'].includes(method)) {
      if (method === 'PATCH')
        canvas = canvasDocumentSchema.parse({ ...body!, revision: canvas.revision + 1 });
      return json(route, { canvas });
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/models/defaults`) {
      return json(route, { defaults: {}, resolvedDefaults: {} });
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/runs`)
      return json(route, { runs: scenario === 'share' ? [successfulRun()] : [] });
    if (method === 'GET' && path === '/v1/runs/synthetic-successful-run' && scenario === 'share') {
      return json(route, { run: successfulRun() });
    }
    if (method === 'GET' && path === '/v1/prompt-skills')
      return json(route, { skills: [PROMPT_SKILLS[0]!] });
    if (method === 'GET' && path === '/v1/settings/ai') {
      return json(route, {
        settings: { defaultModels: { image: 'mock-image' }, timeoutMs: 900_000 },
        resolvedDefaults: { image: 'mock-image' },
      });
    }
    if (method === 'GET' && path === '/v1/models') {
      return json(route, {
        models: ['text', 'image', 'audio'].map((type) => ({
          id: `mock-${type}`,
          name: `Mock ${type}`,
          mediaTypes: [type],
          mentionMediaTypes: ['image', 'audio'],
          group: 'alpha',
          credentialId: 'synthetic-credential',
          available: true,
        })),
      });
    }
    if (method === 'GET' && path === '/v1/assets') {
      const type = url.searchParams.get('mediaType');
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const catalog = assets().filter(
        (asset) =>
          (!type || type === 'all' || asset.mediaType === type) &&
          asset.name.toLowerCase().includes(query),
      );
      return json(route, { assets: catalog, total: catalog.length, page: 1, pageSize: 50 });
    }
    if (method === 'POST' && path === '/v1/assets/uploads/init') {
      const metadata = body as Upload['metadata'];
      expect(metadata).toMatchObject({
        name: 'local-reference.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: poster.length,
      });
      expect(metadata.sha256).toBe(createHash('sha256').update(poster).digest('hex'));
      const id = 'synthetic-upload-' + (uploads.length + 1);
      uploads.push({ id, metadata, stages: ['init'] });
      return json(route, {
        uploadId: id,
        uploadUrl: `/v1/assets/uploads/${id}/bytes`,
        completeUrl: '/v1/assets/uploads/complete',
      });
    }
    const bytesMatch = path.match(/^\/v1\/assets\/uploads\/([^/]+)\/bytes$/);
    if (method === 'PUT' && bytesMatch) {
      const upload = uploads.find((entry) => entry.id === bytesMatch[1])!;
      expect(upload.stages).toEqual(['init']);
      expect(request.postDataBuffer()).toEqual(poster);
      upload.stages.push('PUT');
      return route.fulfill({ status: 204 });
    }
    if (method === 'POST' && path === '/v1/assets/uploads/complete') {
      const upload = uploads.find((entry) => entry.id === (body as { uploadId: string }).uploadId)!;
      expect(upload.stages).toEqual(['init', 'PUT']);
      expect(body).toMatchObject(upload.metadata);
      upload.asset = {
        ...images[0]!,
        id: upload.id,
        name: upload.metadata.name,
        latestVersion: 1,
        contentUrl: `/v1/assets/${upload.id}/versions/1/content`,
      };
      upload.stages.push('complete');
      return json(route, { asset: upload.asset }, 201);
    }
    const access = path.match(/^\/v1\/assets\/([^/]+)\/access-url$/);
    if (method === 'POST' && access) {
      const asset = assets().find((entry) => entry.id === access[1])!;
      expect(asset).toBeTruthy();
      const version = (body as { version?: number } | undefined)?.version ?? asset.latestVersion;
      return json(route, { url: `/v1/assets/${asset.id}/versions/${version}/content` });
    }
    if (method === 'POST' && path === `/v1/assets/${successAsset.id}/share`) {
      expect(body).toEqual({ version: 3 });
      return json(route, {
        token: 'synthetic-node-share.signature',
        version: 3,
        expiresAt: '2030-10-08T00:00:00.000Z',
      });
    }
    const content = path.match(
      /^\/v1\/assets\/([^/]+)\/versions\/(\d+)\/(content|derivatives\/thumbnail)$/,
    );
    if (['GET', 'HEAD'].includes(method) && content) {
      const asset = assets().find((entry) => entry.id === content[1])!;
      expect(asset).toBeTruthy();
      return route.fulfill({
        status: 200,
        contentType: asset.mimeType,
        body: method === 'HEAD' ? undefined : asset.mediaType === 'audio' ? audioBytes : poster,
      });
    }
    if (method === 'GET' && /^\/v1\/assets\/[^/]+\/versions\/\d+\/reverse-prompts$/.test(path))
      return json(route, { analysis: null });
    if (method === 'GET' && /^\/v1\/nodes\/[^/]+\/request-prompts$/.test(path))
      return json(route, { records: [] });
    errors.push('未声明 Mock 接口：' + method + ' ' + path);
    return json(route, { error: '隔离验收拒绝未声明请求' }, 404);
  });
  return { errors, requests, uploads, canvas: () => structuredClone(canvas) };
}

/** 审计浏览器错误与写请求，明确拒绝真实生成。 */
async function expectIsolation(fixture: Awaited<ReturnType<typeof installFixture>>) {
  await test.info().attach('pc-resource-network-audit', {
    body: JSON.stringify({ errors: fixture.errors, requests: fixture.requests }, null, 2),
    contentType: 'application/json',
  });
  expect(fixture.errors).toEqual([]);
  expect(
    fixture.requests.filter(
      ({ method, path }) =>
        method === 'POST' &&
        !path.endsWith('/access-url') &&
        ![
          '/v1/assets/uploads/init',
          '/v1/assets/uploads/complete',
          `/v1/assets/${successAsset.id}/share`,
        ].includes(path),
    ),
  ).toEqual([]);
}

/** 读取 textarea 正文，兼容产品后续切换 contenteditable 的展示方式。 */
async function readPrompt(prompt: Locator) {
  return prompt.evaluate((element) =>
    element instanceof HTMLTextAreaElement ? element.value : (element as HTMLElement).innerText,
  );
}

/** 从真实节点预览打开快捷输入面板。 */
async function openEditor(page: Page) {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible();
  await node.getByText('尚未生成', { exact: true }).click();
  const editor = page.locator('.node-quick-editor');
  await expect(editor).toBeVisible();
  return { node, editor, prompt: editor.getByRole('textbox', { name: '提示词', exact: true }) };
}

/** 点击实际空白画布关闭浮层，避免资源栏、节点或工具栏拦截。 */
async function closeEditor(page: Page) {
  const point = await page.locator('.react-flow__pane').evaluate((pane) => {
    const bounds = pane.getBoundingClientRect();
    for (let y = bounds.top + 48; y < bounds.bottom - 48; y += 48) {
      for (let x = bounds.left + 48; x < bounds.right - 48; x += 48) {
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    throw new Error('未找到可点击的空白画布');
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.node-quick-editor')).toBeHidden();
}

/** 用鼠标越过 React Flow 阈值再拖动，断言外框尺寸始终不变。 */
async function dragNode(
  page: Page,
  node: Locator,
  point: { x: number; y: number },
  delta: { x: number; y: number },
) {
  const before = (await node.boundingBox())!;
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 8, point.y);
  // React Flow 在越过阈值的这一点记录拖动起点，因此目标坐标也从此点偏移。
  await page.mouse.move(point.x + 8 + delta.x, point.y + delta.y, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.abs((await node.boundingBox())!.x - before.x - delta.x))
    .toBeLessThanOrEqual(2);
  await expect
    .poll(async () => Math.abs((await node.boundingBox())!.y - before.y - delta.y))
    .toBeLessThanOrEqual(2);
  const after = (await node.boundingBox())!;
  expect(after.width).toBeCloseTo(before.width, 2);
  expect(after.height).toBeCloseTo(before.height, 2);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
]) {
  test(`${viewport.width}x${viewport.height} 资源栏音频在非控件区与移动入口都能拖动`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const fixture = await installFixture(page, baseURL, 'audio');
    await page.goto(`/projects/${project.id}`);
    await page.locator('.resource-panel').hover();
    await page.getByRole('button', { name: `添加 ${audioAsset.name} 到画布`, exact: true }).click();
    const node = page.locator('.react-flow__node').filter({ has: page.locator('audio') });
    await expect(node).toHaveCount(1);
    await expect(node.locator('audio')).toHaveJSProperty('readyState', 4);
    await closeEditor(page);
    const point = await node.locator('.artifact-preview-audio-shell').evaluate((shell) => {
      const bounds = shell.getBoundingClientRect();
      for (let y = bounds.top + 10; y < bounds.bottom - 10; y += 10) {
        for (let x = bounds.left + 10; x < bounds.right - 10; x += 10) {
          if (document.elementFromPoint(x, y) === shell) return { x, y };
        }
      }
      throw new Error('音频预览没有非控件留白');
    });
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return {
        className: element?.className,
        nodragAncestor: element?.closest('.nodrag')?.className ?? null,
      };
    }, point);
    await test
      .info()
      .attach('audio-drag-hit', { body: JSON.stringify(hit), contentType: 'application/json' });
    await page.screenshot({
      path: test.info().outputPath('audio-drag-start.png'),
      animations: 'disabled',
    });
    await dragNode(page, node, point, { x: -90, y: 45 });
    await closeEditor(page);
    const player = node.locator('audio');
    await expect(player).toHaveClass(/nodrag/);
    const playPoint = await player.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const scale = bounds.width / (element as HTMLElement).offsetWidth;
      return {
        x: bounds.left + 28 * scale,
        y: bounds.bottom - 27 * scale,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        scale,
      };
    });
    await test.info().attach('audio-native-control-target', {
      body: JSON.stringify(playPoint),
      contentType: 'application/json',
    });
    const beforePlayback = await node.boundingBox();
    await page.screenshot({
      path: test.info().outputPath('audio-controls-before-playback.png'),
      animations: 'disabled',
    });
    await page.mouse.click(playPoint.x, playPoint.y);
    await expect(player).toHaveJSProperty('paused', false);
    expect(await node.boundingBox()).toEqual(beforePlayback);
    await closeEditor(page);
    await page.mouse.click(playPoint.x, playPoint.y);
    await expect(player).toHaveJSProperty('paused', true);
    await closeEditor(page);
    await node.hover();
    const handle = node.getByRole('button', { name: '拖动移动节点', exact: true });
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    await dragNode(
      page,
      node,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: 70, y: -35 },
    );
    await page.screenshot({
      path: test.info().outputPath('audio-drag-complete.png'),
      animations: 'disabled',
    });
    await expectIsolation(fixture);
  });

  test(`${viewport.width}x${viewport.height} 引用窗口两列且选用和上传不改正文，选区不搜索而 @ 可引用`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const fixture = await installFixture(page, baseURL, 'prompt');
    await page.goto(`/projects/${project.id}`);
    const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
    await expect(node).toBeVisible();
    const originalSize = await node.evaluate((element) => ({
      width: (element as HTMLElement).offsetWidth,
      height: (element as HTMLElement).offsetHeight,
    }));
    const { editor, prompt } = await openEditor(page);
    await expect(node).toHaveClass(/selected/);
    await expect(node.locator('.flow-asset-node')).toHaveCSS(
      'border-top-color',
      'rgba(0, 0, 0, 0)',
    );
    const border = await node.locator('.flow-asset-node').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        widths: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ],
        colors: [
          style.borderTopColor,
          style.borderRightColor,
          style.borderBottomColor,
          style.borderLeftColor,
        ],
      };
    });
    expect(border.widths).toEqual(['1px', '1px', '1px', '1px']);
    expect(border.colors).toEqual(Array(4).fill('rgba(0, 0, 0, 0)'));
    expect(
      await node.evaluate((element) => ({
        width: (element as HTMLElement).offsetWidth,
        height: (element as HTMLElement).offsetHeight,
      })),
    ).toEqual(originalSize);
    expect(await readPrompt(prompt)).toBe(promptText);
    let chooserCount = 0;
    page.on('filechooser', () => {
      chooserCount += 1;
    });
    await editor.getByRole('button', { name: '上传引用资源', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '选择参考资料', exact: true });
    await expect(dialog).toBeVisible();
    const grid = dialog.getByRole('list', { name: '项目参考资料', exact: true });
    await expect(grid).toBeVisible();
    const cards = grid.locator('li');
    await expect(cards).toHaveCount(6);
    const boxes = await cards.evaluateAll((elements) =>
      elements.slice(0, 4).map((element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    expect(boxes[0]!.y).toBeCloseTo(boxes[1]!.y, 1);
    expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
    expect(boxes[2]!.y).toBeCloseTo(boxes[3]!.y, 1);
    expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
    expect(boxes[2]!.x).toBeCloseTo(boxes[0]!.x, 1);
    await expect(dialog.getByRole('button', { name: '上传本地文件', exact: true })).toBeVisible();
    expect(chooserCount).toBe(0);
    expect(fixture.uploads).toHaveLength(0);
    await page.screenshot({
      path: test.info().outputPath('reference-dialog-two-columns.png'),
      animations: 'disabled',
    });
    await dialog
      .getByRole('button', { name: `添加参考资料 ${images[0]!.name} v2`, exact: true })
      .click();
    await expect
      .poll(() => fixture.canvas().nodes[0]!.data.resourceRefs)
      .toContainEqual(
        expect.objectContaining({ assetId: images[0]!.id, assetVersion: 2, attached: true }),
      );
    expect(await readPrompt(prompt)).toBe(promptText);
    expect(fixture.canvas().nodes[0]!.data.promptDocument).toEqual(
      initialCanvas('prompt').nodes[0]!.data.promptDocument,
    );
    if (await dialog.isVisible()) await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await editor.getByRole('button', { name: '上传引用资源', exact: true }).click();
    await expect(dialog).toBeVisible();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      dialog.getByRole('button', { name: '上传本地文件', exact: true }).click(),
    ]);
    await chooser.setFiles({ name: 'local-reference.jpg', mimeType: 'image/jpeg', buffer: poster });
    await expect
      .poll(() => fixture.uploads.map((upload) => upload.stages))
      .toEqual([['init', 'PUT', 'complete']]);
    await expect
      .poll(() => fixture.canvas().nodes[0]!.data.resourceRefs)
      .toContainEqual(
        expect.objectContaining({
          assetId: fixture.uploads[0]!.asset!.id,
          assetVersion: 1,
          attached: true,
        }),
      );
    if (await dialog.isVisible()) await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(chooserCount).toBe(1);
    expect(await readPrompt(prompt)).toBe(promptText);
    expect(fixture.canvas().nodes[0]!.data.promptDocument).toEqual(
      initialCanvas('prompt').nodes[0]!.data.promptDocument,
    );
    await expect(editor.getByRole('article', { name: /^参考资源 1：项目参考图1/ })).toBeVisible();
    await expect(
      editor.getByRole('article', { name: /^参考资源 2：local-reference/ }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('reference-pool-preserves-prompt.png'),
      animations: 'disabled',
    });
    const textPoint = await prompt.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: bounds.left + parseFloat(style.paddingLeft) + 2,
        y: bounds.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2,
      };
    });
    await page.mouse.move(textPoint.x, textPoint.y);
    await page.mouse.down();
    await page.mouse.move(textPoint.x + 120, textPoint.y, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() =>
        prompt.evaluate((element) =>
          element instanceof HTMLTextAreaElement
            ? element.selectionEnd - element.selectionStart
            : (document.getSelection()?.toString().length ?? 0),
        ),
      )
      .toBeGreaterThan(0);
    await expect(page.getByRole('searchbox', { name: '搜索资源', exact: true })).toBeHidden();
    await page.keyboard.press('Control+c');
    expect(await readPrompt(prompt)).toBe(promptText);
    await page.screenshot({
      path: test.info().outputPath('text-selection-without-search.png'),
      animations: 'disabled',
    });
    await prompt.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('@');
    await expect(page.getByRole('searchbox', { name: '搜索资源', exact: true })).toBeVisible();
    await page.getByRole('option').filter({ hasText: '项目参考图1' }).click();
    await expect
      .poll(() => fixture.canvas().nodes[0]!.data.promptDocument?.blocks)
      .toContainEqual(
        expect.objectContaining({ type: 'mention', assetId: images[0]!.id, assetVersion: 2 }),
      );
    await page.screenshot({
      path: test.info().outputPath('explicit-at-reference.png'),
      animations: 'disabled',
    });
    expect(
      await node.evaluate((element) => ({
        width: (element as HTMLElement).offsetWidth,
        height: (element as HTMLElement).offsetHeight,
      })),
    ).toEqual(originalSize);
    await expectIsolation(fixture);
  });

  test(`${viewport.width}x${viewport.height} 成功产物浮栏显式无密码分享并冻结回显版本，未成功无入口`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const fixture = await installFixture(page, baseURL, 'share');
    await page.goto(`/projects/${project.id}`);
    const success = page.locator(`.react-flow__node[data-id="${successNodeId}"]`);
    await expect(success).toBeVisible();
    await expect(success.locator('img')).toBeVisible();
    await success.hover();
    const controls = success.getByRole('group', { name: '节点操作：成功产物', exact: true });
    const share = controls.getByRole('button', { name: '分享当前版本', exact: true });
    await expect(share).toBeVisible();
    await expect(page.getByLabel('分享查看密码', { exact: true })).toHaveCount(0);
    expect(fixture.requests.filter(({ path }) => path.endsWith('/share'))).toHaveLength(0);
    const nodeSize = await success.boundingBox();
    await page.screenshot({
      path: test.info().outputPath('successful-node-share-toolbar.png'),
      animations: 'disabled',
    });
    await share.click();
    const sharePanel = page.getByRole('group', { name: '资源分享链接', exact: true });
    await expect(sharePanel).toBeVisible();
    await expect(page.getByRole('textbox', { name: '分享链接', exact: true })).toHaveValue(
      /\/share#token=synthetic-node-share\.signature$/,
    );
    expect(fixture.requests.filter(({ path }) => path.endsWith('/share'))).toEqual([
      { method: 'POST', path: `/v1/assets/${successAsset.id}/share`, body: { version: 3 } },
    ]);
    await expect(page.getByLabel('分享查看密码', { exact: true })).toHaveCount(0);
    const panelBounds = (await sharePanel.boundingBox())!;
    expect(panelBounds.x).toBeGreaterThanOrEqual(0);
    expect(panelBounds.y).toBeGreaterThanOrEqual(0);
    expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(viewport.width);
    expect(panelBounds.y + panelBounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await success.boundingBox()).toEqual(nodeSize);
    await page.screenshot({
      path: test.info().outputPath('node-share-fixed-version.png'),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '关闭分享面板', exact: true }).click();
    await expect(sharePanel).toBeHidden();
    await share.click();
    await expect(sharePanel).toBeVisible();
    expect(fixture.requests.filter(({ path }) => path.endsWith('/share'))).toHaveLength(1);
    await page.getByRole('button', { name: '关闭分享面板', exact: true }).click();
    const empty = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
    await empty.hover();
    await expect(
      empty.getByRole('group', { name: '节点操作：参考资料验收节点', exact: true }),
    ).toBeVisible();
    await expect(empty.getByRole('button', { name: '分享当前版本', exact: true })).toHaveCount(0);
    await expectIsolation(fixture);
  });
}
