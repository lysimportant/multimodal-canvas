import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  canvasDocumentSchema,
  PROMPT_SKILLS,
  type Asset,
  type CanvasDocument,
} from '@multimodal-canvas/domain';

/** PC 输入布局只连接本机 Vite，资源和保存均由浏览器合成，不接触用户项目或 Provider。 */
const project = {
  id: 'node-editor-layout-browser',
  name: '输入布局隔离验收',
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
};
const nodeId = 'node-editor-layout-target';
const promptText = '保留输入正文，只有明确选择引用才插入。';
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));

test.use({ serviceWorkers: 'block' });

/** 合成一个固定外框的生成节点，长正文由测试自行填入。 */
function initialCanvas(): CanvasDocument {
  return canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: nodeId,
        type: 'image',
        position: { x: 390, y: 210 },
        width: 320,
        height: 240,
        data: {
          label: '布局验收节点',
          mediaType: 'image',
          mode: 'generate',
          enabled: true,
          modelAlias: 'mock-image',
          promptDocument: { version: 1, blocks: [{ type: 'text', text: promptText }] },
        },
      },
    ],
    edges: [],
  });
}

/** JSON Mock 保留真实接口状态码与响应格式。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 上传元数据和三阶段请求记录，用于验证用户上传只执行一次。 */
type Upload = {
  uploadId: string;
  metadata: { name: string; mimeType: string; sizeBytes: number; sha256: string };
  stages: string[];
  bytes?: Buffer;
  asset?: Asset;
};

/** 安装最小 API，并拒绝未声明网络、真实媒体设备和任何生成请求。 */
async function installFixture(page: Page, baseURL: string | undefined) {
  if (!baseURL || !['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) {
    throw new Error('输入布局验收只能连接本机隔离 Vite');
  }
  const webOrigin = new URL(baseURL).origin;
  const errors: string[] = [];
  const requests: { method: string; path: string }[] = [];
  const uploads: Upload[] = [];
  let canvas = initialCanvas();
  const user = {
    id: 'node-editor-layout-user',
    email: 'node-editor-layout@example.test',
    role: 'user',
    createdAt: project.createdAt,
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript((sessionUser) => {
    localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user: sessionUser }));
    for (const name of ['getUserMedia', 'getDisplayMedia'] as const) {
      Object.defineProperty(navigator.mediaDevices, name, {
        configurable: true,
        value: () => Promise.reject(new Error('布局隔离验收禁止真实媒体设备')),
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
    } else {
      errors.push('未声明 WebSocket：' + socket.url());
      socket.close();
    }
  });
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
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
    requests.push({ method, path });
    if (method === 'GET' && path === '/v1/auth/me') {
      return json(route, { user, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (method === 'GET' && path === '/v1/projects') return json(route, { projects: [project] });
    if (method === 'GET' && path === `/v1/projects/${project.id}`) return json(route, { project });
    if (method === 'GET' && path === `/v1/projects/${project.id}/events`) {
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    }
    if (path === `/v1/projects/${project.id}/canvas`) {
      if (method === 'PATCH') {
        canvas = canvasDocumentSchema.parse({
          ...request.postDataJSON(),
          revision: canvas.revision + 1,
        });
      }
      if (method === 'GET' || method === 'PATCH') return json(route, { canvas });
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/models/defaults`) {
      return json(route, { defaults: {}, resolvedDefaults: {} });
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/runs`)
      return json(route, { runs: [] });
    if (method === 'GET' && path === '/v1/prompt-skills') {
      return json(route, { skills: [PROMPT_SKILLS[0]!] });
    }
    if (method === 'GET' && path === '/v1/settings/ai') {
      return json(route, {
        settings: { defaultModels: { image: 'mock-image' }, timeoutMs: 900_000 },
        resolvedDefaults: { image: 'mock-image' },
      });
    }
    if (method === 'GET' && path === '/v1/models') {
      return json(route, {
        models: ['text', 'image'].map((mediaType) => ({
          id: `mock-${mediaType}`,
          name: `Mock ${mediaType}`,
          mediaTypes: [mediaType],
          mentionMediaTypes: ['image'],
          group: 'alpha',
          credentialId: 'node-editor-layout-credential',
          available: true,
        })),
      });
    }
    if (method === 'GET' && path === '/v1/assets') {
      const catalog = uploads.flatMap((upload) => (upload.asset ? [upload.asset] : []));
      return json(route, { assets: catalog, total: catalog.length, page: 1, pageSize: 50 });
    }
    if (method === 'POST' && path === '/v1/assets/uploads/init') {
      const metadata = request.postDataJSON() as Upload['metadata'];
      expect(metadata).toMatchObject({ name: 'layout-reference.jpg', mimeType: 'image/jpeg' });
      expect(metadata.sizeBytes).toBe(poster.byteLength);
      expect(metadata.sha256).toBe(createHash('sha256').update(poster).digest('hex'));
      const uploadId = 'layout-upload-' + (uploads.length + 1);
      uploads.push({ uploadId, metadata, stages: ['init'] });
      return json(route, {
        uploadId,
        uploadUrl: `/v1/assets/uploads/${uploadId}/bytes`,
        completeUrl: '/v1/assets/uploads/complete',
      });
    }
    const uploadMatch = path.match(/^\/v1\/assets\/uploads\/([^/]+)\/bytes$/);
    if (method === 'PUT' && uploadMatch) {
      const upload = uploads.find((entry) => entry.uploadId === uploadMatch[1]);
      const bytes = request.postDataBuffer();
      expect(upload?.stages).toEqual(['init']);
      expect(bytes).toEqual(poster);
      upload!.bytes = bytes!;
      upload!.stages.push('PUT');
      return route.fulfill({ status: 204 });
    }
    if (method === 'POST' && path === '/v1/assets/uploads/complete') {
      const body = request.postDataJSON();
      const upload = uploads.find((entry) => entry.uploadId === body.uploadId);
      expect(upload?.stages).toEqual(['init', 'PUT']);
      expect(body).toMatchObject(upload!.metadata);
      const id = 'layout-reference-' + upload!.uploadId;
      upload!.asset = {
        id,
        name: upload!.metadata.name,
        mediaType: 'image',
        mimeType: 'image/jpeg',
        sizeBytes: poster.byteLength,
        status: 'ready',
        latestVersion: 1,
        contentUrl: `/v1/assets/${id}/versions/1/content`,
        tags: [],
      };
      upload!.stages.push('complete');
      return json(route, { asset: upload!.asset }, 201);
    }
    const accessMatch = path.match(/^\/v1\/assets\/([^/]+)\/access-url$/);
    if (method === 'POST' && accessMatch) {
      const entry = uploads.find((upload) => upload.asset?.id === accessMatch[1])?.asset;
      expect(entry).toBeTruthy();
      expect(request.postDataJSON()?.version ?? 1).toBe(1);
      return json(route, { url: entry!.contentUrl });
    }
    if (
      method === 'GET' &&
      /^\/v1\/assets\/[^/]+\/versions\/1\/(content|derivatives\/thumbnail)$/.test(path)
    ) {
      return route.fulfill({ contentType: 'image/jpeg', body: poster });
    }
    if (method === 'GET' && /^\/v1\/assets\/[^/]+\/versions\/1\/reverse-prompts$/.test(path)) {
      return json(route, { analysis: null });
    }
    if (method === 'GET' && /^\/v1\/nodes\/[^/]+\/request-prompts$/.test(path)) {
      return json(route, { records: [] });
    }
    errors.push('未声明 Mock 接口：' + method + ' ' + path);
    return json(route, { error: '隔离验收拒绝未声明请求' }, 404);
  });
  return { errors, requests, uploads, canvas: () => structuredClone(canvas) };
}

/** 通过真实 PC 节点入口打开提示词面板。 */
async function openEditor(page: Page) {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.getByText('尚未生成', { exact: true }).click();
  const editor = page.locator('.node-quick-editor');
  await expect(editor).toBeVisible();
  return { node, editor };
}

/** 读取结构化正文的可见文字，不依赖 contenteditable 的浏览器换行序列化。 */
async function readPrompt(prompt: Locator) {
  return prompt.evaluate((element) =>
    element instanceof HTMLTextAreaElement ? element.value : (element as HTMLElement).innerText,
  );
}

/** 每项浏览器验证都审计错误和写请求，不允许触发 Run 或 Provider。 */
async function expectIsolation(fixture: Awaited<ReturnType<typeof installFixture>>) {
  await test.info().attach('node-editor-layout-audit', {
    body: JSON.stringify({ errors: fixture.errors, requests: fixture.requests }, null, 2),
    contentType: 'application/json',
  });
  expect(fixture.errors).toEqual([]);
  expect(
    fixture.requests.filter(
      ({ method, path }) =>
        method === 'POST' &&
        !path.endsWith('/access-url') &&
        !['/v1/assets/uploads/init', '/v1/assets/uploads/complete'].includes(path),
    ),
  ).toEqual([]);
}

/** 模型栏能接收真实点击，面板及底部操作完整可见，外框不滚动。 */
async function expectEditorBounds(page: Page, editor: Locator) {
  const bounds = (await editor.boundingBox())!;
  const canvas = (await page.locator('.canvas-area').boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(canvas.x - 1);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
  expect(bounds.y).toBeGreaterThanOrEqual(canvas.y - 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
  const overflow = await editor.evaluate((element) => ({
    vertical: element.scrollHeight - element.clientHeight,
    horizontal: element.scrollWidth - element.clientWidth,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(overflow.vertical).toBeLessThanOrEqual(1);
  expect(overflow.horizontal).toBeLessThanOrEqual(1);
  expect(overflow.overflowY).not.toBe('auto');
  const model = editor.getByRole('combobox', { name: /^模型：/ });
  await expect(model).toBeVisible();
  const modelHitTargets = await model.evaluate((element) => {
    const control = element.closest('.ant-select');
    if (!control) throw new Error('模型选择器缺少实际点击容器');
    const bounds = control.getBoundingClientRect();
    return [bounds.left + 8, bounds.left + bounds.width / 2].map((x) => {
      const hit = document.elementFromPoint(x, bounds.top + bounds.height / 2);
      return Boolean(hit && control.contains(hit));
    });
  });
  expect(modelHitTargets).toEqual([true, true]);
  for (const name of ['Skill 配置', '生成数量', '生成']) {
    const button =
      name === '生成数量'
        ? editor.getByRole('combobox', { name })
        : editor.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  }
}

/** 先适配节点，再以节点中心为滚轮锚点设置真实倍率，不注入 React Flow store。 */
async function setCanvasZoom(page: Page, zoom: number) {
  const viewport = page.locator('.react-flow__viewport');
  await page.getByRole('button', { name: 'Fit View', exact: true }).click();
  await expect
    .poll(() =>
      viewport.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a),
    )
    .toBeCloseTo(2, 2);
  const current = await viewport.evaluate(
    (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
  );
  const node = (await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox())!;
  await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
  await page.mouse.wheel(0, -Math.log2(zoom / current) / 0.002);
  await expect
    .poll(() =>
      viewport.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a),
    )
    .toBeCloseTo(zoom, 2);
}

/** 使用实际未被工具栏、节点和面板遮挡的画布坐标。 */
async function blankPanePoint(page: Page) {
  return page.locator('.react-flow__pane').evaluate((pane) => {
    const rect = pane.getBoundingClientRect();
    for (let y = rect.top + 48; y < rect.bottom - 48; y += 48) {
      for (let x = rect.left + 48; x < rect.right - 48; x += 48) {
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    throw new Error('没有可用的画布空白区域');
  });
}

/** 点击真实画布空白处收起快捷面板，让下一次节点拖动不受浮层遮挡。 */
async function closeQuickEditor(page: Page) {
  const blank = await blankPanePoint(page);
  await page.mouse.click(blank.x, blank.y);
  await expect(page.locator('.node-quick-editor')).toBeHidden();
}

/** 拖动节点到画布上下边，面板重新打开后须吸附到可见范围。 */
async function moveNodeToEdge(page: Page, node: Locator, edge: 'top' | 'bottom') {
  const canvas = (await page.locator('.canvas-area').boundingBox())!;
  const box = (await node.boundingBox())!;
  const topbar = (await page.locator('.topbar').boundingBox())!;
  const targetY =
    edge === 'top'
      ? Math.max(canvas.y, topbar.y + topbar.height) + 24
      : canvas.y + canvas.height - box.height - 24;
  const start = { x: box.x + 16, y: box.y + box.height - 22 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // 先越过拖动阈值，避免首个纵向步长被节点点击识别消耗。
  await page.mouse.move(start.x + 8, start.y);
  await page.mouse.move(start.x, start.y + targetY - box.y, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.abs((await node.boundingBox())!.y - targetY))
    .toBeLessThanOrEqual(2);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
]) {
  test(`${viewport.width}x${viewport.height} 上传只加入资料，明确 @ 选择后才插入正文`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const fixture = await installFixture(page, baseURL);
    await page.goto(`/projects/${project.id}`);
    const { editor } = await openEditor(page);
    const prompt = editor.getByRole('textbox', { name: '提示词', exact: true });
    const before = await readPrompt(prompt);
    expect(before).toBe(promptText);
    await editor.getByRole('button', { name: '上传引用资源', exact: true }).click();
    const resources = page.getByRole('dialog', { name: '选择参考资料', exact: true });
    await expect(resources).toBeVisible();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      resources.getByRole('button', { name: '上传本地文件', exact: true }).click(),
    ]);
    await chooser.setFiles({
      name: 'layout-reference.jpg',
      mimeType: 'image/jpeg',
      buffer: poster,
    });
    await expect
      .poll(() => fixture.uploads.map((upload) => upload.stages))
      .toEqual([['init', 'PUT', 'complete']]);
    await resources.getByRole('button', { name: '关闭参考资料选择', exact: true }).click();
    const card = editor.getByRole('article', {
      name: '参考资源 1：layout-reference',
      exact: true,
    });
    await expect(card).toBeVisible();
    await expect
      .poll(() => fixture.canvas().nodes[0]!.data.resourceRefs)
      .toContainEqual(
        expect.objectContaining({
          assetId: fixture.uploads[0]!.asset!.id,
          assetVersion: 1,
          attached: true,
        }),
      );
    expect(await readPrompt(prompt)).toBe(before);
    expect(fixture.canvas().nodes[0]!.data.promptDocument).toEqual(
      initialCanvas().nodes[0]!.data.promptDocument,
    );
    await page.screenshot({
      path: test.info().outputPath('upload-pool-only.png'),
      animations: 'disabled',
    });
    await card.getByRole('button', { name: '预览并命名 layout-reference', exact: true }).click();
    const preview = page.locator('.resource-mention-dialog');
    await expect(preview).toBeVisible();
    await preview.getByRole('button', { name: '关闭', exact: true }).click();
    await prompt.focus();
    await page.keyboard.press('End');
    await page.keyboard.insertText('@');
    await page.getByRole('option').filter({ hasText: 'layout-reference' }).click();
    await expect
      .poll(() => fixture.canvas().nodes[0]!.data.promptDocument?.blocks)
      .toContainEqual(
        expect.objectContaining({
          type: 'mention',
          assetId: fixture.uploads[0]!.asset!.id,
          assetVersion: 1,
        }),
      );
    await page.screenshot({
      path: test.info().outputPath('upload-explicit-reference.png'),
      animations: 'disabled',
    });
    await expectIsolation(fixture);
  });

  test(`${viewport.width}x${viewport.height} 1、1.5、2 倍上下边面板完整且仅正文滚动`, async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const fixture = await installFixture(page, baseURL);
    await page.goto(`/projects/${project.id}`);
    const { editor, node } = await openEditor(page);
    const prompt = editor.getByRole('textbox', { name: '提示词', exact: true });
    await prompt.fill(
      Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行固定输入高度验收。`).join('\n'),
    );
    expect(await prompt.evaluate((element) => getComputedStyle(element).height)).toBe('250px');
    const originalSize = await node.evaluate((element) => ({
      width: (element as HTMLElement).offsetWidth,
      height: (element as HTMLElement).offsetHeight,
    }));
    for (const zoom of [1, 1.5, 2]) {
      await closeQuickEditor(page);
      await setCanvasZoom(page, zoom);
      for (const edge of ['top', 'bottom'] as const) {
        await moveNodeToEdge(page, node, edge);
        if (!(await editor.isVisible())) {
          await node.getByText('尚未生成', { exact: true }).click();
        }
        await expect(editor).toBeVisible();
        await expectEditorBounds(page, editor);
        expect(await prompt.evaluate((element) => getComputedStyle(element).height)).toBe('250px');
        expect(
          await prompt.evaluate((element) => element.scrollHeight > element.clientHeight),
        ).toBe(true);
        await prompt.focus();
        await page.keyboard.press('Control+Home');
        await expect.poll(() => prompt.evaluate((element) => element.scrollTop)).toBe(0);
        await prompt.hover();
        await page.mouse.wheel(0, 400);
        await expect.poll(() => prompt.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await editor.evaluate((element) => element.scrollTop)).toBe(0);
        expect(
          await node.evaluate((element) => ({
            width: (element as HTMLElement).offsetWidth,
            height: (element as HTMLElement).offsetHeight,
          })),
        ).toEqual(originalSize);
        await page.screenshot({
          path: test.info().outputPath(`quick-editor-${zoom}-${edge}.png`),
          animations: 'disabled',
        });
        await closeQuickEditor(page);
      }
    }
    await expectIsolation(fixture);
  });

  test(`${viewport.width}x${viewport.height} 完整 Dialog 底部 Skill 可悬浮、选择且位于前层`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const fixture = await installFixture(page, baseURL);
    await page.goto(`/projects/${project.id}`);
    const { editor } = await openEditor(page);
    await editor.getByRole('button', { name: '打开完整编辑器', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '布局验收节点 · 编辑设置', exact: true });
    await expect(dialog).toBeVisible();
    const trigger = dialog.getByRole('button', { name: 'Skill 配置', exact: true });
    await expect(trigger).toBeVisible();
    const triggerBox = (await trigger.boundingBox())!;
    expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(viewport.height);
    await trigger.hover();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const popup = dialog.locator('.prompt-skill-settings-overlay');
    await expect(popup).toBeVisible();
    const model = popup.getByRole('combobox', { name: '优化模型', exact: true });
    await expect(model).toBeVisible();
    const modelBox = (await model.boundingBox())!;
    expect(
      await page.evaluate(
        ({ x, y }) =>
          Boolean(document.elementFromPoint(x, y)?.closest('.prompt-skill-settings-overlay')),
        { x: modelBox.x + modelBox.width / 2, y: modelBox.y + modelBox.height / 2 },
      ),
    ).toBe(true);
    await popup.getByRole('combobox', { name: '提示词 Skill', exact: true }).click();
    await page.getByRole('option', { name: '原创故事构思', exact: true }).click();
    await expect.poll(() => fixture.canvas().nodes[0]!.data.promptSkillId).toBe('novel-premise');
    await expect(popup.getByRole('button', { name: '优化提示词', exact: true })).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath('dialog-skill-visible.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(dialog).toBeVisible();
    await trigger.click();
    await expect(popup).toBeVisible();
    await expect(popup.getByRole('button', { name: '优化提示词', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(dialog).toBeVisible();
    await expectIsolation(fixture);
  });
}
