import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { CanvasDocument, RequestPromptRecord } from '@multimodal-canvas/domain';

/** 全部内容来自本地夹具，悬浮与提示词查看不产生供应商请求。 */
const project = {
  id: 'node-hover-preview',
  name: '节点悬浮验收',
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:00:12.400Z',
};
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
const timing = {
  nodeId: 'image-result',
  startedAt: project.createdAt,
  finishedAt: project.updatedAt,
  outcome: 'succeeded',
};
const canvas: CanvasDocument = {
  revision: 1,
  nodes: [
    {
      id: 'image-result',
      type: 'image',
      position: { x: 300, y: 250 },
      width: 320,
      height: 240,
      data: {
        createdAt: project.createdAt,
        label: '图片结果',
        mediaType: 'image',
        mode: 'generate',
        enabled: true,
        assetId: 'result-image',
        mimeType: 'image/jpeg',
        contentUrl: '/v1/assets/result-image/versions/1/content',
        prompt: '参考 产品图 保留构图',
        modelAlias: 'mock-image',
        promptDocument: {
          version: 1,
          blocks: [
            { type: 'text', text: '参考 ' },
            {
              type: 'mention',
              mentionId: 'reference-image',
              assetId: 'reference-image',
              label: '产品图',
              mediaType: 'image',
            },
            { type: 'text', text: ' 保留构图' },
          ],
        },
      },
    },
  ],
  edges: [],
};
const record: RequestPromptRecord = {
  schemaVersion: 1,
  runId: 'hover-run',
  nodeId: 'image-result',
  attempt: 1,
  requestIdentity: 'POST /images/edits#1',
  provider: 'mock',
  modelAlias: 'mock-image',
  mediaType: 'image',
  format: 'plain',
  parts: [{ order: 0, text: 'Keep the reference composition and lighting.' }],
  resources: [],
  sendStatus: 'sent',
  createdAt: project.createdAt,
  assetId: 'result-image',
  assetVersion: 1,
  summary: '保留参考图的构图与光照。',
};

/** 两份原图字节只用于 Mock；不写入项目资源或磁盘素材。 */
type PreviewImages = { result: Buffer; reference: Buffer; mimeType: string };

/** 在空白测试页生成已知像素的 PNG，返回下载校验所需的原始字节。 */
async function createHdImages(page: Page): Promise<PreviewImages> {
  const images = await page.evaluate(() => {
    /** 绘制不含外部资源的色块与单像素网格，尺寸单位为原图像素。 */
    const render = (width: number, height: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('测试浏览器不支持 PNG 夹具绘制');
      context.fillStyle = '#14283c';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#f4ad4b';
      context.fillRect(width / 2, 0, width / 2, height / 2);
      context.fillStyle = '#2da899';
      context.fillRect(0, height / 2, width / 2, height / 2);
      context.fillStyle = '#ffffff';
      for (let x = 0; x < width; x += 16) context.fillRect(x, 0, 1, height);
      for (let y = 0; y < height; y += 16) context.fillRect(0, y, width, 1);
      return canvas.toDataURL('image/png').split(',')[1]!;
    };
    return { result: render(3840, 2160), reference: render(1200, 1600) };
  });
  return {
    result: Buffer.from(images.result, 'base64'),
    reference: Buffer.from(images.reference, 'base64'),
    mimeType: 'image/png',
  };
}

/** 返回隔离的 JSON 合同，不放行未声明的 API。 */
async function json(route: Route, value: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
}

/** 安装图片结果、请求说明和资源预览的最小合同，收集所有页面错误。 */
async function installFixture(
  page: Page,
  parameters: Record<string, unknown> = {},
  images: PreviewImages = { result: poster, reference: poster, mimeType: 'image/jpeg' },
) {
  const fixtureCanvas = structuredClone(canvas);
  fixtureCanvas.nodes[0]!.data.parameters = parameters;
  fixtureCanvas.nodes[0]!.data.mimeType = images.mimeType;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-hover-preview',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'hover-user',
          email: 'hover@example.test',
          role: 'admin',
          createdAt: '2026-09-17T10:00:00.000Z',
        },
      }),
    );
  });
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    errors.push('阻止未声明的外部请求：' + route.request().url());
    return route.abort('blockedbyclient');
  });
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    // 仅允许隔离画布保存及资源签名 Mock；生成、上传等请求一律拒绝。
    if (
      !['GET', 'HEAD'].includes(method) &&
      path !== '/v1/projects/' + project.id + '/canvas' &&
      !['/v1/assets/result-image/access-url', '/v1/assets/reference-image/access-url'].includes(
        path,
      )
    ) {
      errors.push('阻止未声明的写请求：' + method + ' ' + path);
      return route.fulfill({ status: 405, body: '隔离测试禁止生成或上传' });
    }
    if (path === '/v1/auth/me') {
      return json(route, {
        user: {
          id: 'hover-user',
          email: 'hover@example.test',
          role: 'admin',
          createdAt: '2026-09-17T10:00:00.000Z',
        },
      });
    }
    if (path.endsWith('/reverse-prompts')) return json(route, { analysis: null });
    if (path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (path.endsWith('/events')) {
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    }
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path.endsWith('/canvas')) return json(route, { canvas: fixtureCanvas });
    if (path.endsWith('/models/defaults')) return json(route, { defaults: {} });
    if (path.endsWith('/runs')) {
      return json(route, {
        runs: [
          {
            id: record.runId,
            projectId: project.id,
            targetNodeId: record.nodeId,
            status: 'succeeded',
            progress: 100,
            attempt: 1,
            provider: 'mock',
            modelAlias: record.modelAlias,
            snapshot: {
              projectId: project.id,
              targetNodeId: record.nodeId,
              canvasRevision: 1,
              modelAlias: record.modelAlias,
              parameters,
              submittedAt: project.createdAt,
              nodes: fixtureCanvas.nodes,
              edges: [],
              inputs: [],
            },
            result: {
              provider: 'mock',
              summary: '结果已归档',
              targetNodeId: record.nodeId,
              mediaType: 'image',
              inputCount: 1,
              asset: {
                assetId: record.assetId,
                version: 1,
                contentUrl: '/v1/assets/result-image/versions/1/content',
                mimeType: images.mimeType,
                sizeBytes: images.result.byteLength,
              },
            },
            nodeTimings: { [record.nodeId]: timing },
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        ],
      });
    }
    if (path.includes('/request-prompts')) {
      return json(route, { records: [{ id: 'record-hover', ...record }], timing });
    }
    if (path.endsWith('/reverse-prompts')) return json(route, { analysis: null });
    if (path === '/v1/assets') {
      return json(route, {
        assets: ['result-image', 'reference-image'].map((id) => ({
          id,
          name: id === 'reference-image' ? '产品图' : '图片结果',
          mediaType: 'image',
          mimeType: images.mimeType,
          sizeBytes: (id === 'reference-image' ? images.reference : images.result).byteLength,
          status: 'ready',
          latestVersion: 1,
          contentUrl: `/v1/assets/${id}/versions/1/content`,
          tags: [],
        })),
      });
    }
    if (path.endsWith('/access-url')) {
      return json(route, { url: path.replace('/access-url', '/versions/1/content') });
    }
    if (path === '/v1/assets/result-image/versions/1/content') {
      return route.fulfill({ contentType: images.mimeType, body: images.result });
    }
    if (path === '/v1/assets/reference-image/versions/1/content') {
      return route.fulfill({ contentType: images.mimeType, body: images.reference });
    }
    if (path === '/v1/settings/ai') {
      return json(route, {
        settings: { defaultModels: {}, timeoutMs: 900_000 },
      });
    }
    if (path === '/v1/models') {
      return json(route, {
        models: ['image', 'text'].map((mediaType) => ({
          id: `mock-${mediaType}`,
          name: `Mock ${mediaType}`,
          mediaTypes: [mediaType],
          group: 'alpha',
          credentialId: 'hover-credential',
          available: true,
        })),
      });
    }
    errors.push(`未声明的 Mock 接口：${route.request().method()} ${path}`);
    return route.fulfill({ status: 404, body: '未声明的验收接口' });
  });
  return errors;
}

for (const viewport of [
  { width: 1366, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
]) {
  test(`${viewport.width}x${viewport.height} 节点悬浮计时只显示完整秒数且终态冻结`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors = await installFixture(page);
    await page.goto(`/projects/${project.id}`);
    const node = page.locator('.react-flow__node[data-id="image-result"]');
    await expect(node).toBeVisible();
    const bounds = await node.boundingBox();
    await node.hover();
    const toolbar = node.getByRole('group', { name: '节点操作：图片结果' });
    const duration = toolbar.locator('.node-duration-badge');
    await expect(duration).toHaveText('耗时 12秒');
    await expect(duration).toHaveAttribute('title', '耗时 12秒');
    await page.clock.install();
    await page.clock.fastForward(3_000);
    await expect(duration).toHaveText('耗时 12秒');
    await toolbar.getByRole('button', { name: '查看节点信息' }).click();
    const info = page.getByRole('dialog', { name: '节点信息', exact: true });
    await expect(info.locator(`time[datetime="${project.createdAt}"]`)).toBeVisible();
    await expect(info.locator(`time[datetime="${timing.finishedAt}"]`)).toBeVisible();
    await expect(info).toContainText('服务端完成');
    await expect(info.locator('.node-duration-badge')).toHaveText('12秒');
    await info.getByRole('button', { name: '关闭节点信息' }).click();
    await node.hover();
    expect((await node.boundingBox())!.width).toBeCloseTo(bounds!.width, 0);
    expect((await node.boundingBox())!.height).toBeCloseTo(bounds!.height, 0);
    await page.screenshot({
      path: testInfo.outputPath('node-duration-integer.png'),
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
  });

  test(`${viewport.width}x${viewport.height} 悬浮卡片直接展示提示词耗时，资源预览放大居中`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors = await installFixture(page);
    await page.goto(`/projects/${project.id}`);
    const node = page.locator('.react-flow__node[data-id="image-result"]');
    await expect(node).toBeVisible();
    const before = await node.boundingBox();
    await node.hover();
    const toolbar = node.getByRole('group', { name: '节点操作：图片结果' });
    await expect(toolbar.getByText('12秒')).toBeVisible();
    const trigger = toolbar.getByRole('button', { name: '查看生成提示词：图片结果' });
    await expect(trigger).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('node-toolbar.png') });
    await trigger.click();
    const prompt = page.getByRole('dialog', { name: '生成提示词', exact: true });
    await expect(prompt).toBeVisible();
    await expect(prompt.locator('.request-prompt-text')).toHaveText(record.parts[0]!.text);
    await expect(page.locator('.node-quick-editor')).toHaveCount(0);
    await prompt.getByRole('button', { name: '关闭生成提示词' }).click();
    await toolbar.getByRole('button', { name: '查看节点信息' }).click();
    const info = page.getByRole('dialog', { name: '节点信息', exact: true });
    await expect(info.getByText('12秒')).toBeVisible();
    await expect(info.getByRole('button', { name: '查看生成提示词：图片结果' })).toBeVisible();
    await info.getByRole('button', { name: '关闭节点信息' }).click();

    const editor = page.locator('.node-quick-editor');
    if (!(await editor.isVisible())) await node.locator('.flow-node-preview').click();
    await expect(editor).toBeVisible();
    const token = editor.locator('.resource-mention-token');
    const tokenBounds = await token.boundingBox();
    expect(tokenBounds).not.toBeNull();
    await page.mouse.move(
      tokenBounds!.x + tokenBounds!.width / 2,
      tokenBounds!.y + tokenBounds!.height / 2,
    );
    const tooltip = page.getByRole('tooltip', { name: '预览 产品图' });
    await expect(tooltip).toBeVisible();
    const image = tooltip.locator('img');
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    // 等待 Tooltip 入场缩放结束，不把动画中间帧误判成布局变化。
    await expect.poll(async () => (await tooltip.boundingBox())!.width).toBeCloseTo(280, 1);
    await expect.poll(async () => (await tooltip.boundingBox())!.height).toBeCloseTo(210, 1);
    const previewBounds = await tooltip.boundingBox();
    expect(previewBounds!.x).toBeGreaterThanOrEqual(12);
    expect(previewBounds!.x + previewBounds!.width).toBeLessThanOrEqual(viewport.width - 12);
    expect(previewBounds!.y).toBeGreaterThanOrEqual(12);
    expect(previewBounds!.y + previewBounds!.height).toBeLessThanOrEqual(viewport.height - 12);
    await expect(image).toHaveCSS('object-fit', 'contain');
    await expect(image).toHaveCSS('object-position', '50% 50%');
    const imageBounds = await image.boundingBox();
    expect(
      Math.abs(imageBounds!.x + imageBounds!.width / 2 - (previewBounds!.x + 140)),
    ).toBeLessThan(1);
    expect(
      Math.abs(imageBounds!.y + imageBounds!.height / 2 - (previewBounds!.y + 105)),
    ).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath('mention-preview.png') });
    const after = await node.boundingBox();
    expect(after!.width).toBeCloseTo(before!.width, 0);
    expect(after!.height).toBeCloseTo(before!.height, 0);

    await editor.getByRole('button', { name: '打开完整编辑器' }).click();
    const fullEditor = page.getByRole('dialog', { name: '图片结果 · 编辑设置' });
    await expect(fullEditor).toBeVisible();
    // 等待完整编辑器动画结束后再取引用坐标，避免后续移动错过透明输入层上的标记。
    await expect
      .poll(() =>
        fullEditor.evaluate(
          (element) =>
            element
              .getAnimations({ subtree: true })
              .filter(
                (animation) =>
                  animation.playState === 'running' &&
                  Number.isFinite(animation.effect?.getComputedTiming().endTime),
              ).length,
        ),
      )
      .toBe(0);
    await fullEditor.getByRole('textbox', { name: '提示词', exact: true }).hover();
    const fullTokenBounds = await fullEditor.locator('.resource-mention-token').boundingBox();
    await page.mouse.move(
      fullTokenBounds!.x + fullTokenBounds!.width / 2,
      fullTokenBounds!.y + fullTokenBounds!.height / 2,
    );
    const fullPreview = fullEditor.getByRole('region', { name: '预览 产品图' });
    await expect(fullPreview).toBeVisible();
    await expect(fullPreview.locator('img')).toHaveCSS('object-fit', 'contain');
    await expect.poll(async () => (await fullPreview.boundingBox())!.width).toBeCloseTo(280, 1);
    await expect.poll(async () => (await fullPreview.boundingBox())!.height).toBeCloseTo(210, 1);
    await page.screenshot({ path: testInfo.outputPath('dialog-mention-preview.png') });
    expect(errors).toEqual([]);
  });
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
]) {
  test(`${viewport.width}x${viewport.height} 实际像素与原图下载、输入高度不撑大节点`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors = await installFixture(page, { resolution: '4k', aspectRatio: '16:9' });
    await page.goto(`/projects/${project.id}`);
    const node = page.locator('.react-flow__node[data-id="image-result"]');
    const image = node.locator('img');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    const pixels = await image.evaluate((element: HTMLImageElement) => ({
      width: element.naturalWidth,
      height: element.naturalHeight,
    }));
    expect(pixels.width).toBeLessThan(3840);
    await expect(node.locator('.flow-node-download-feedback')).toHaveCount(0);
    await node.hover();
    await node.getByRole('button', { name: '查看节点信息', exact: true }).click();
    const information = page.getByRole('dialog', { name: '节点信息', exact: true });
    await expect(information).toContainText(
      `实际 ${pixels.width}×${pixels.height}，未达到所选 3840×2160`,
    );
    await information.getByRole('button', { name: '关闭节点信息', exact: true }).click();
    const before = await node.boundingBox();
    await node.hover();
    const pending = page.waitForEvent('download');
    await node.getByRole('button', { name: '下载图片', exact: true }).click();
    const downloaded = await pending;
    const path = await downloaded.path();
    expect(path).not.toBeNull();
    expect(readFileSync(path!)).toEqual(poster);
    const input = page.getByRole('textbox', { name: '提示词', exact: true });
    if (!(await input.isVisible())) await node.click({ position: { x: 40, y: 40 } });
    await expect(input).toBeVisible();
    await image.click();
    const viewer = page.getByRole('dialog', { name: '图片结果结果', exact: true });
    await expect(viewer).toBeVisible();
    const previewDownload = page.waitForEvent('download');
    await viewer.getByRole('button', { name: '下载原文件', exact: true }).click();
    expect(readFileSync((await (await previewDownload).path())!)).toEqual(poster);
    await expect(viewer.getByRole('button', { name: '下载原文件', exact: true })).toBeEnabled();
    await expect(viewer.getByRole('alert')).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('preview-original-download.png'),
      animations: 'disabled',
    });
    await viewer.getByRole('button', { name: '关闭预览' }).click();
    if (!(await input.isVisible())) await node.click({ position: { x: 40, y: 40 } });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(input).toBeVisible();
    expect(
      await input.evaluate((element) => Number.parseFloat(getComputedStyle(element).height)),
    ).toBe(180);
    await input.fill('A synthetic long prompt for scroll verification.\n'.repeat(50).trimEnd());
    // 文字由高亮层绘制，必须占满透明输入框，不能保留旧高度形成空白。
    const highlight = page.locator('.node-quick-editor .resource-mention-highlight');
    const composer = page.locator('.node-quick-editor .resource-mention-composer');
    const inputBounds = (await input.boundingBox())!;
    const highlightBounds = (await highlight.boundingBox())!;
    expect(highlightBounds.y).toBeCloseTo(inputBounds.y, 0);
    expect(highlightBounds.height).toBeCloseTo(inputBounds.height, 0);
    expect((await composer.boundingBox())!.height).toBeCloseTo(inputBounds.height, 0);
    await input.press('Control+End');
    await expect.poll(() => input.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await highlight.evaluate((element) => element.scrollTop)).toBeCloseTo(
      await input.evaluate((element) => element.scrollTop),
      0,
    );
    expect(await input.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    expect((await node.boundingBox())!.width).toBeCloseTo(before!.width, 0);
    expect((await node.boundingBox())!.height).toBeCloseTo(before!.height, 0);
    const editor = await page.locator('.node-quick-editor').boundingBox();
    expect(editor!.y).toBeGreaterThanOrEqual(0);
    expect(editor!.y + editor!.height).toBeLessThanOrEqual(viewport.height);
    // 小高度桌面沿用面板内部滚动，底部操作必须仍能到达。
    const expand = page
      .locator('.node-quick-editor')
      .getByRole('button', { name: '打开完整编辑器' });
    await expand.scrollIntoViewIfNeeded();
    const expandBounds = await expand.boundingBox();
    expect(expandBounds!.y).toBeGreaterThanOrEqual(editor!.y);
    expect(expandBounds!.y + expandBounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({
      path: testInfo.outputPath('image-dimensions-input-height.png'),
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
  });
}

/** 读取 img 的原始尺寸、实际绘制尺寸及祖先矩阵，避免仅验证百分比文案。 */
async function imageGeometry(image: Locator) {
  return image.evaluate((element: HTMLImageElement) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const transforms = [];
    let layer: HTMLElement | null = element;
    while (layer) {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(layer).transform);
      transforms.push({
        layer: layer.className || layer.tagName,
        scaleX: Math.hypot(matrix.a, matrix.b),
        scaleY: Math.hypot(matrix.c, matrix.d),
      });
      if (layer.classList.contains('artifact-preview-image-stage')) break;
      layer = layer.parentElement;
    }
    const matrix = new DOMMatrixReadOnly(style.transform);
    return {
      src: element.currentSrc,
      devicePixelRatio: window.devicePixelRatio,
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
      cssWidth: Number.parseFloat(style.width),
      cssHeight: Number.parseFloat(style.height),
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      matrix: { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d },
      determinant: matrix.a * matrix.d - matrix.b * matrix.c,
      transforms,
    };
  });
}

/** 校验物理屏幕像素比例，100% 的 CSS 宽高为原图 / DPR；quarterTurn 表示宽高因 90/270 度旋转而互换。 */
async function expectPixelScale(image: Locator, scale: number, quarterTurn = false) {
  await expect(image).toHaveAttribute(
    'src',
    /\/v1\/assets\/(?:result-image|reference-image)\/versions\/1\/content$/,
  );
  const intrinsic = await imageGeometry(image);
  expect([intrinsic.naturalWidth, intrinsic.naturalHeight]).toEqual(
    intrinsic.src.includes('/reference-image/') ? [1200, 1600] : [3840, 2160],
  );
  await expect
    .poll(async () => (await imageGeometry(image)).cssWidth)
    .toBeCloseTo((intrinsic.naturalWidth * scale) / intrinsic.devicePixelRatio, 0);
  const geometry = await imageGeometry(image);
  expect(geometry.cssHeight).toBeCloseTo(
    (geometry.naturalHeight * scale) / geometry.devicePixelRatio,
    0,
  );
  expect(geometry.width).toBeCloseTo(
    ((quarterTurn ? geometry.naturalHeight : geometry.naturalWidth) * scale) /
      geometry.devicePixelRatio,
    0,
  );
  expect(geometry.height).toBeCloseTo(
    ((quarterTurn ? geometry.naturalWidth : geometry.naturalHeight) * scale) /
      geometry.devicePixelRatio,
    0,
  );
  for (const transform of geometry.transforms) {
    expect(transform.scaleX, transform.layer + ' 不得放大适配图层').toBeCloseTo(1, 6);
    expect(transform.scaleY, transform.layer + ' 不得放大适配图层').toBeCloseTo(1, 6);
  }
}

/** 按当前舞台和原图计算真实适配比例，并校验绘制尺寸及一位小数读数。 */
async function expectFitted(viewer: Locator, quarterTurn = false) {
  const stage = viewer.locator('.artifact-preview-image-stage');
  const image = stage.locator('img');
  await expect(viewer.getByRole('button', { name: '原图 1:1', exact: true })).toBeEnabled();
  // 等待 Dialog 入场或窗口尺寸变化稳定，不把动画中间帧当作真实舞台尺寸。
  await stage.hover();
  const geometry = await imageGeometry(image);
  const box = await stage.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
  }));
  const scale = Math.min(
    1,
    (box.width * geometry.devicePixelRatio) /
      (quarterTurn ? geometry.naturalHeight : geometry.naturalWidth),
    (box.height * geometry.devicePixelRatio) /
      (quarterTurn ? geometry.naturalWidth : geometry.naturalHeight),
  );
  expect(scale).toBeLessThan(1);
  await expect
    .poll(async () =>
      Number.parseFloat((await viewer.getByLabel('图片缩放比例', { exact: true }).textContent())!),
    )
    .toBeCloseTo(Math.round(scale * 1000) / 10, 1);
  await expectPixelScale(image, scale, quarterTurn);
  return scale;
}

/** 打开唯一的隔离 4K 节点预览；返回源字节、外框和画布位置以校验无副作用。 */
async function openHdViewer(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const images = await createHdImages(page);
  const errors = await installFixture(page, { resolution: '4k', aspectRatio: '16:9' }, images);
  await page.goto('/projects/' + project.id);
  const node = page.locator('.react-flow__node[data-id="image-result"]');
  await expect(node).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => node.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(3840);
  await expect(node.getByRole('status')).toHaveCount(0);
  await node.hover();
  const nodeBefore = (await node.boundingBox())!;
  const canvasTransform = await page.locator('.react-flow__viewport').getAttribute('style');
  await node.getByRole('button', { name: /^预览图片：/ }).click();
  const viewer = page.getByRole('dialog', { name: '图片结果结果', exact: true });
  await expect(viewer).toBeVisible();
  const stage = viewer.locator('.artifact-preview-image-stage');
  const image = stage.locator('img');
  await expect(image).toBeVisible();
  await expect.poll(async () => (await imageGeometry(image)).naturalWidth).toBe(3840);
  expect((await imageGeometry(image)).naturalHeight).toBe(2160);
  await expect(viewer.locator('output[aria-label="图片缩放比例"]')).toBeVisible();
  await expect(stage.locator('.artifact-preview-image-content > img')).toHaveCount(1);
  await expect(stage.locator('canvas')).toHaveCount(0);
  await expectFitted(viewer);
  return { errors, images, node, nodeBefore, canvasTransform, viewer, stage, image };
}

/** 预览不改变节点外框和背景画布变换，不向后端提交真实资源。 */
async function expectNodeUnchanged(page: Page, state: Awaited<ReturnType<typeof openHdViewer>>) {
  const after = (await state.node.boundingBox())!;
  expect(after.width).toBeCloseTo(state.nodeBefore.width, 0);
  expect(after.height).toBeCloseTo(state.nodeBefore.height, 0);
  expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(
    state.canvasTransform,
  );
  expect(state.errors).toEqual([]);
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
]) {
  test(
    viewport.width + 'x' + viewport.height + ' 4K真实适配、1:1像素图层与键盘双击',
    async ({ page }, testInfo) => {
      const state = await openHdViewer(page, viewport);
      const { viewer, stage, image } = state;
      const source = (await imageGeometry(image)).src;
      await expect(viewer.getByLabel('图片缩放比例', { exact: true })).not.toHaveText('100%');
      await page.screenshot({ path: testInfo.outputPath('4k-fit.png'), animations: 'disabled' });
      await viewer.getByRole('button', { name: '原图 1:1', exact: true }).click();
      await expect(viewer.getByLabel('图片缩放比例', { exact: true })).toHaveText('100%');
      await expectPixelScale(image, 1);
      await testInfo.attach('4k-native-pixels', {
        body: JSON.stringify(await imageGeometry(image), null, 2),
        contentType: 'application/json',
      });
      await page.screenshot({
        path: testInfo.outputPath('4k-native-pixels.png'),
        animations: 'disabled',
      });
      await viewer.getByRole('button', { name: '放大预览', exact: true }).click();
      await expectPixelScale(image, 1.25);
      await expect(viewer.getByLabel('图片缩放比例', { exact: true })).toHaveText('125%');
      await viewer.getByRole('button', { name: '缩小预览', exact: true }).click();
      await expectPixelScale(image, 1);
      await stage.press('Minus');
      await expectPixelScale(image, 0.8);
      await stage.press('Shift+Equal');
      await expectPixelScale(image, 1);
      await stage.press('0');
      await expectFitted(viewer);
      await stage.press('1');
      await expectPixelScale(image, 1);
      await stage.dblclick();
      await expectFitted(viewer);
      await stage.dblclick();
      await expectPixelScale(image, 1);
      expect((await imageGeometry(image)).src).toBe(source);
      await expectNodeUnchanged(page, state);
    },
  );

  test(
    viewport.width + 'x' + viewport.height + ' 4K滚轮拖动、旋转翻转重置及原字节下载',
    async ({ page }, testInfo) => {
      const state = await openHdViewer(page, viewport);
      const { viewer, stage, image, images, node } = state;
      const source = (await imageGeometry(image)).src;
      const box = (await stage.boundingBox())!;
      const anchor = { x: box.x + box.width / 2 + 40, y: box.y + box.height / 2 + 20 };
      const beforeWheel = await imageGeometry(image);
      await page.mouse.move(anchor.x, anchor.y);
      await page.mouse.wheel(0, -200);
      await expect
        .poll(async () => (await imageGeometry(image)).cssWidth)
        .toBeGreaterThan(beforeWheel.cssWidth);
      const afterWheel = await imageGeometry(image);
      expect((anchor.x - afterWheel.x) / afterWheel.width).toBeCloseTo(
        (anchor.x - beforeWheel.x) / beforeWheel.width,
        2,
      );
      expect((anchor.y - afterWheel.y) / afterWheel.height).toBeCloseTo(
        (anchor.y - beforeWheel.y) / beforeWheel.height,
        2,
      );
      await expectPixelScale(
        image,
        (afterWheel.cssWidth * afterWheel.devicePixelRatio) / afterWheel.naturalWidth,
      );
      await page.mouse.wheel(0, 200);
      await expect
        .poll(async () => (await imageGeometry(image)).cssWidth)
        .toBeLessThan(afterWheel.cssWidth);
      await viewer.getByRole('button', { name: '原图 1:1', exact: true }).click();
      await expectPixelScale(image, 1);
      const beforeDrag = await imageGeometry(image);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 6 });
      await page.mouse.up();
      await expect
        .poll(async () => (await imageGeometry(image)).x - beforeDrag.x)
        .toBeCloseTo(120, 0);
      expect((await imageGeometry(image)).y - beforeDrag.y).toBeCloseTo(80, 0);
      await expectPixelScale(image, 1);
      await viewer.getByRole('button', { name: '向右旋转90度', exact: true }).click();
      await expectPixelScale(image, 1, true);
      expect((await imageGeometry(image)).matrix.b).toBeCloseTo(1, 6);
      await viewer.getByRole('button', { name: '水平翻转', exact: true }).click();
      expect((await imageGeometry(image)).determinant).toBeCloseTo(-1, 6);
      await expectPixelScale(image, 1, true);
      const pending = page.waitForEvent('download');
      await viewer.getByRole('button', { name: '下载原文件', exact: true }).click();
      const download = await pending;
      expect(await download.failure()).toBeNull();
      expect(readFileSync((await download.path())!)).toEqual(images.result);
      await viewer.getByRole('button', { name: '适应窗口', exact: true }).click();
      await expectFitted(viewer, true);
      await page.screenshot({
        path: testInfo.outputPath('4k-rotated-flipped-fit.png'),
        animations: 'disabled',
      });
      await stage.press('r');
      await expectFitted(viewer);
      expect((await imageGeometry(image)).determinant).toBeCloseTo(-1, 6);
      await viewer.getByRole('button', { name: '重置图片视图', exact: true }).click();
      await expectFitted(viewer);
      expect((await imageGeometry(image)).matrix).toEqual({ a: 1, b: 0, c: 0, d: 1 });
      expect((await imageGeometry(image)).src).toBe(source);
      await viewer.getByRole('button', { name: '关闭预览', exact: true }).click();
      await expect(viewer).toBeHidden();
      await node.hover();
      const nodePending = page.waitForEvent('download');
      await node.getByRole('button', { name: '下载图片', exact: true }).click();
      const nodeDownload = await nodePending;
      expect(await nodeDownload.failure()).toBeNull();
      expect(readFileSync((await nodeDownload.path())!)).toEqual(images.result);
      await expectNodeUnchanged(page, state);
    },
  );

  test(
    viewport.width + 'x' + viewport.height + ' 4K铺满当前窗口、资源切换与重新打开恢复适配',
    async ({ page }, testInfo) => {
      const state = await openHdViewer(page, viewport);
      const { viewer, stage, image, node } = state;
      const normal = (await viewer.boundingBox())!;
      await viewer.getByRole('button', { name: '铺满窗口', exact: true }).click();
      await expect(viewer.getByRole('button', { name: '退出铺满窗口', exact: true })).toBeVisible();
      await expect
        .poll(async () => (await viewer.boundingBox())!.width)
        .toBeCloseTo(viewport.width, 0);
      const expanded = (await viewer.boundingBox())!;
      expect(expanded.height).toBeCloseTo(viewport.height, 0);
      expect(expanded.x).toBeCloseTo(0, 0);
      expect(expanded.y).toBeCloseTo(0, 0);
      expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
      await expectFitted(viewer);
      await page.screenshot({
        path: testInfo.outputPath('4k-window-expanded.png'),
        animations: 'disabled',
      });
      await stage.press('1');
      await expectPixelScale(image, 1);
      await stage.press('f');
      await expect(viewer.getByRole('button', { name: '铺满窗口', exact: true })).toBeVisible();
      await expect
        .poll(async () => (await viewer.boundingBox())!.width)
        .toBeCloseTo(normal.width, 0);
      await expectPixelScale(image, 1);
      await stage.press('f');
      await expect(viewer.getByRole('button', { name: '退出铺满窗口', exact: true })).toBeVisible();
      await viewer.getByRole('button', { name: '退出铺满窗口', exact: true }).click();
      await viewer.getByRole('button', { name: '向右旋转90度', exact: true }).click();
      await viewer.getByRole('button', { name: '水平翻转', exact: true }).click();
      await stage.press('Escape');
      await expect(viewer).toBeHidden();
      await page.getByRole('button', { name: '展开资源栏', exact: true }).click();
      const panel = page.getByRole('complementary', { name: '项目资源' });
      await panel.getByRole('button', { name: '预览 产品图', exact: true }).click();
      const reference = page.getByRole('dialog', { name: '产品图', exact: true });
      await expect(reference).toBeVisible();
      const referenceImage = reference.locator('.artifact-preview-image-content > img');
      await expect.poll(async () => (await imageGeometry(referenceImage)).naturalHeight).toBe(1600);
      expect((await imageGeometry(referenceImage)).naturalWidth).toBe(1200);
      expect((await imageGeometry(referenceImage)).src).toContain('/reference-image/');
      expect((await imageGeometry(referenceImage)).matrix).toEqual({ a: 1, b: 0, c: 0, d: 1 });
      await expectFitted(reference);
      await expect(reference.getByRole('button', { name: '铺满窗口', exact: true })).toBeVisible();
      await reference.getByRole('button', { name: '原图 1:1', exact: true }).click();
      await expectPixelScale(referenceImage, 1);
      const referencePending = page.waitForEvent('download');
      await reference.getByRole('button', { name: '下载原文件', exact: true }).click();
      expect(readFileSync((await (await referencePending).path())!)).toEqual(
        state.images.reference,
      );
      await page.screenshot({
        path: testInfo.outputPath('portrait-resource-native.png'),
        animations: 'disabled',
      });
      await reference.getByRole('button', { name: '关闭预览', exact: true }).click();
      await page.getByRole('button', { name: '折叠资源栏', exact: true }).click();
      await node.hover();
      await node.getByRole('button', { name: /^预览图片：/ }).click();
      await expect(viewer).toBeVisible();
      await expectFitted(viewer);
      expect((await imageGeometry(image)).naturalWidth).toBe(3840);
      expect((await imageGeometry(image)).src).toContain('/result-image/');
      expect((await imageGeometry(image)).matrix).toEqual({ a: 1, b: 0, c: 0, d: 1 });
      await expect(viewer.getByRole('button', { name: '铺满窗口', exact: true })).toBeVisible();
      await expectNodeUnchanged(page, state);
    },
  );
}

test('390x844 窄窗口工具栏可达且原图比例随窗口重算', async ({ page }, testInfo) => {
  const state = await openHdViewer(page, { width: 1366, height: 768 });
  const { viewer, stage, image } = state;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await viewer.boundingBox())!.width).toBeCloseTo(358, 0);
  await expectFitted(viewer);
  for (const label of [
    '缩小预览',
    '放大预览',
    '适应窗口',
    '原图 1:1',
    '向右旋转90度',
    '水平翻转',
    '重置图片视图',
    '铺满窗口',
    '下载原文件',
    '关闭预览',
  ]) {
    const button = viewer.getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible();
    const bounds = (await button.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  }
  const stageBounds = (await stage.boundingBox())!;
  expect(stageBounds.height).toBeGreaterThan(100);
  await page.screenshot({
    path: testInfo.outputPath('narrow-fit-tools.png'),
    animations: 'disabled',
  });
  await viewer.getByRole('button', { name: '原图 1:1', exact: true }).click();
  await expectPixelScale(image, 1);
  await viewer.getByRole('button', { name: '铺满窗口', exact: true }).click();
  await expect.poll(async () => (await viewer.boundingBox())!.width).toBeCloseTo(390, 0);
  await expectPixelScale(image, 1);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await page.screenshot({
    path: testInfo.outputPath('narrow-native-expanded.png'),
    animations: 'disabled',
  });
  await viewer.getByRole('button', { name: '退出铺满窗口', exact: true }).click();
  await viewer.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.setViewportSize({ width: 1366, height: 768 });
  await expectNodeUnchanged(page, state);
});

for (const deviceScaleFactor of [1.5, 2]) {
  test.describe('DPR=' + deviceScaleFactor + ' 物理屏幕像素', () => {
    test.use({ deviceScaleFactor });

    test('4K原图100%对应物理屏幕1:1且不更换源图', async ({ page }, testInfo) => {
      const state = await openHdViewer(page, { width: 1366, height: 768 });
      const { viewer, image, stage } = state;
      const source = (await imageGeometry(image)).src;
      expect((await imageGeometry(image)).devicePixelRatio).toBe(deviceScaleFactor);
      await expectFitted(viewer);
      await page.screenshot({
        path: testInfo.outputPath('high-dpi-fit.png'),
        animations: 'disabled',
      });
      await viewer.getByRole('button', { name: '原图 1:1', exact: true }).click();
      await expect(viewer.getByLabel('图片缩放比例', { exact: true })).toHaveText('100%');
      await expectPixelScale(image, 1);
      const native = await imageGeometry(image);
      expect(native.width * deviceScaleFactor).toBeCloseTo(3840, 0);
      expect(native.height * deviceScaleFactor).toBeCloseTo(2160, 0);
      expect(native.x * deviceScaleFactor).toBeCloseTo(Math.round(native.x * deviceScaleFactor), 4);
      expect(native.y * deviceScaleFactor).toBeCloseTo(Math.round(native.y * deviceScaleFactor), 4);
      await testInfo.attach('high-dpi-native-geometry', {
        body: JSON.stringify(native, null, 2),
        contentType: 'application/json',
      });
      await page.screenshot({
        path: testInfo.outputPath('high-dpi-native-pixels.png'),
        animations: 'disabled',
      });
      await stage.press('Shift+Equal');
      await expectPixelScale(image, 1.25);
      await stage.press('Minus');
      await expectPixelScale(image, 1);
      await stage.dblclick();
      await expectFitted(viewer);
      await stage.dblclick();
      await expectPixelScale(image, 1);
      expect((await imageGeometry(image)).src).toBe(source);
      await expectNodeUnchanged(page, state);
    });
  });
}
