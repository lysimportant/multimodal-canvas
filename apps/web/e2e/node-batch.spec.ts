import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { CanvasDocument } from '@multimodal-canvas/domain';

/** 隔离项目包含三张真实图片结果，不会访问供应商。 */
const project = {
  id: 'node-batch',
  name: '批量卡牌验收',
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:00:00.000Z',
};
/** 仓库已有位图用于确认折叠、展开前后媒体正常显示。 */
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
/** 真实节点位置使用展开布局，只有首节点保存展开开关。 */
const initialCanvas: CanvasDocument = {
  revision: 1,
  nodes: Array.from({ length: 3 }, (_, index) => ({
    id: `batch-result-${index}`,
    type: 'image',
    position: { x: 180 + index * 340, y: 200 },
    width: 300,
    height: 220,
    data: {
      label: `批量图片 ${index + 1}`,
      mediaType: 'image',
      mode: 'generate',
      enabled: true,
      prompt: 'A desk beside a window.',
      assetId: `batch-asset-${index}`,
      contentUrl: `/v1/assets/batch-asset-${index}/versions/1/content`,
      mimeType: 'image/jpeg',
      generationBatch: { id: 'batch-example', rootNodeId: 'batch-result-0', index },
    },
  })),
  edges: [],
};

/** 返回隔离 JSON 合同。 */
async function json(route: Route, value: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
}

/** 安装可保存与刷新恢复的画布，记录所有未声明请求和页面异常。 */
async function installFixture(page: Page) {
  let canvas = structuredClone(initialCanvas);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-batch-test',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'batch-user',
          email: 'batch@example.test',
          role: 'admin',
          createdAt: '2026-09-17T10:00:00.000Z',
        },
      }),
    );
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
    if (path.endsWith('/runs')) return json(route, { runs: [] });
    if (path.endsWith('/reverse-prompts')) return json(route, { analysis: null });
    if (path.includes('/request-prompts')) return json(route, { records: [] });
    if (path === '/v1/assets') return json(route, { assets: [] });
    if (path.endsWith('/access-url'))
      return json(route, { url: path.replace('/access-url', '/versions/1/content') });
    if (path.endsWith('/content'))
      return route.fulfill({ contentType: 'image/jpeg', body: poster });
    if (path === '/v1/settings/ai/credentials') return json(route, { credentials: [] });
    if (path === '/v1/settings/ai')
      return json(route, {
        settings: { baseUrl: 'https://mock.example.test', configured: false, defaultModels: {} },
      });
    if (path === '/v1/models') return json(route, { models: [] });
    errors.push(`未声明的 Mock 接口：${request.method()} ${path}`);
    return route.fulfill({ status: 404, body: '未声明的验收接口' });
  });
  await page.goto(`/projects/${project.id}`);
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  return { errors, canvas: () => canvas };
}

/** 保存当前真实节点位置，等待持久化完成。 */
async function save(page: Page) {
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status', { name: /已保存/ })).toBeVisible();
}

/** 左右边缘节点的全部操作保持在画布内。 */
async function expectToolbarInsideCanvas(page: Page, node: Locator) {
  const toolbar = node.getByRole('group', { name: /^节点操作：/ });
  await node.hover();
  await expect(toolbar).toBeVisible();
  await expect
    .poll(async () => {
      const canvas = (await page.locator('.react-flow').boundingBox())!;
      const bounds = (await toolbar.boundingBox())!;
      return (
        bounds.x >= canvas.x + 7 &&
        bounds.y >= canvas.y + 7 &&
        bounds.x + bounds.width <= canvas.x + canvas.width - 7 &&
        bounds.y + bounds.height <= canvas.y + canvas.height - 7
      );
    })
    .toBe(true);
  for (const button of await toolbar.getByRole('button').all()) {
    await expect(button).toBeInViewport();
  }
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 900 },
]) {
  test(`${viewport.width} 批量图片折叠、整叠拖动、展开、保存刷新和删除首节点`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixture = await installFixture(page);
    const root = page.locator('.react-flow__node[data-id="batch-result-0"]');
    const back = page.locator('.react-flow__node[data-id="batch-result-1"]');
    const toggle = root.getByRole('button', { name: '展开 3 个生成结果' });
    await expect(toggle).toBeVisible();
    await expect(back).toHaveClass(/is-generation-batch-hidden/);
    await expect(back.locator('.flow-asset-node')).toHaveAttribute('inert', '');
    await expect(back).toHaveCSS('pointer-events', 'none');
    await expect(root).toHaveCSS('transition-duration', '0.22s');
    await expect(root.getByRole('img', { name: '批量图片 1', exact: true })).toBeVisible();
    const before = await root.boundingBox();
    await page.screenshot({ path: testInfo.outputPath('batch-collapsed.png') });

    await expectToolbarInsideCanvas(page, root);
    const dragHandle = root.getByRole('button', { name: '拖动移动节点' });
    const handleBounds = (await dragHandle.boundingBox())!;
    const start = {
      x: handleBounds.x + handleBounds.width / 2,
      y: handleBounds.y + handleBounds.height / 2,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 80, start.y + 50, { steps: 10 });
    await page.mouse.up();
    await save(page);
    const moved = fixture.canvas();
    const rootDelta = {
      x: moved.nodes[0]!.position.x - initialCanvas.nodes[0]!.position.x,
      y: moved.nodes[0]!.position.y - initialCanvas.nodes[0]!.position.y,
    };
    expect(rootDelta.x).toBeGreaterThan(0);
    for (let index = 1; index < 3; index += 1) {
      expect(moved.nodes[index]!.position.x - initialCanvas.nodes[index]!.position.x).toBeCloseTo(
        rootDelta.x,
        2,
      );
      expect(moved.nodes[index]!.position.y - initialCanvas.nodes[index]!.position.y).toBeCloseTo(
        rootDelta.y,
        2,
      );
    }

    await toggle.click();
    await expect(root.getByRole('button', { name: '收起 3 个生成结果' })).toBeVisible();
    await expect(back).not.toHaveClass(/is-generation-batch-hidden/);
    await expect
      .poll(async () => {
        const first = (await root.boundingBox())!;
        const second = (await back.boundingBox())!;
        return second.x - first.x - first.width;
      })
      .toBeGreaterThan(10);
    const expandedBounds = (await root.boundingBox())!;
    expect(expandedBounds.width).toBeCloseTo(before!.width, 1);
    expect(expandedBounds.height).toBeCloseTo(before!.height, 1);
    await page.getByRole('button', { name: '自动适配缩放', exact: true }).click();
    await expect
      .poll(async () => {
        const bounds = (await page
          .locator('.react-flow__node[data-id="batch-result-2"]')
          .boundingBox())!;
        return bounds.x + bounds.width;
      })
      .toBeLessThan(viewport.width - 20);
    await expectToolbarInsideCanvas(page, root);
    const rename = root.getByRole('button', { name: '重命名节点：批量图片 1' });
    await expect(rename).toBeInViewport();
    expect(
      await rename.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        return (
          document
            .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            ?.closest('button') === button
        );
      }),
    ).toBe(true);
    expect(
      await root.locator('.flow-node-handle--top').evaluate((handle) => {
        const bounds = handle.getBoundingClientRect();
        return (
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) ===
          handle
        );
      }),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('batch-expanded.png') });
    await expectToolbarInsideCanvas(
      page,
      page.locator('.react-flow__node[data-id="batch-result-2"]'),
    );
    await save(page);
    expect(fixture.canvas().nodes[0]!.data.generationBatchExpanded).toBe(true);
    await page.reload();
    await expect(root.getByRole('button', { name: '收起 3 个生成结果' })).toBeVisible();
    await root.getByRole('button', { name: '收起 3 个生成结果' }).click();
    await expect(back).toHaveClass(/is-generation-batch-hidden/);
    await root.hover();
    await root.getByRole('button', { name: '删除节点：批量图片 1' }).click();
    await expect(root).toHaveCount(0);
    await expect(back).not.toHaveClass(/is-generation-batch-hidden/);
    await expect(back.locator('.flow-asset-node')).not.toHaveAttribute('inert');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    expect(fixture.errors).toEqual([]);
  });
}
