import { expect, test, type Page, type Route } from '@playwright/test';
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

/** 返回隔离的 JSON 合同，不放行未声明的 API。 */
async function json(route: Route, value: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
}

/** 安装图片结果、请求说明和资源预览的最小合同，收集所有页面错误。 */
async function installFixture(page: Page) {
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
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events')) {
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    }
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path.endsWith('/canvas')) return json(route, { canvas });
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
              parameters: {},
              submittedAt: project.createdAt,
              nodes: canvas.nodes,
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
                mimeType: 'image/jpeg',
                sizeBytes: poster.byteLength,
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
          mimeType: 'image/jpeg',
          sizeBytes: poster.byteLength,
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
    if (path.endsWith('/content')) {
      return route.fulfill({ contentType: 'image/jpeg', body: poster });
    }
    if (path === '/v1/settings/ai/credentials') {
      return json(route, {
        credentials: [
          {
            id: 'hover-credential',
            version: 1,
            baseUrl: 'https://mock.example.test',
            keyFingerprint: 'synthetic-hover',
            active: true,
            createdAt: project.createdAt,
          },
        ],
      });
    }
    if (path === '/v1/settings/ai') {
      return json(route, {
        settings: { baseUrl: 'https://mock.example.test', configured: true, defaultModels: {} },
      });
    }
    if (path === '/v1/models') {
      return json(route, {
        models: ['image', 'text'].map((mediaType) => ({
          id: `mock-${mediaType}`,
          name: `Mock ${mediaType}`,
          mediaTypes: [mediaType],
          credentialId: 'hover-credential',
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
    await expect(toolbar.getByText('12.4 s')).toBeVisible();
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
    await expect(info.getByText('12.4 s')).toBeVisible();
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
    const previewBounds = await tooltip.boundingBox();
    expect(previewBounds!.width).toBe(280);
    expect(previewBounds!.height).toBe(210);
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
    const fullTokenBounds = await fullEditor.locator('.resource-mention-token').boundingBox();
    await page.mouse.move(
      fullTokenBounds!.x + fullTokenBounds!.width / 2,
      fullTokenBounds!.y + fullTokenBounds!.height / 2,
    );
    const fullPreview = page.locator('.resource-mention-hover-card-expanded');
    await expect(fullPreview).toBeVisible();
    await expect(fullPreview.locator('img')).toHaveCSS('object-fit', 'contain');
    const fullPreviewBounds = await fullPreview.boundingBox();
    expect(fullPreviewBounds!.width).toBe(280);
    expect(fullPreviewBounds!.height).toBe(210);
    await page.screenshot({ path: testInfo.outputPath('dialog-mention-preview.png') });
    expect(errors).toEqual([]);
  });
}
