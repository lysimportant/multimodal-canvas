import { expect, test } from '@playwright/test';
import {
  installFixture,
  inspectDownload,
  filename,
  project,
  settleFrames,
} from './image-thumbnail-cache.helpers';

/** 只使用独立本地夹具，禁止访问真实 8080 项目或执行生成。 */
test('大画布按需内容保留端口、原图与下载，拖动后保存撤销正确', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  const fixture = await installFixture(page, baseURL, {
    nodes: 180,
    imageNodes: 180,
    withEdges: true,
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/projects/${project.id}`);
  await expect(page.locator('.react-flow__node')).toHaveCount(180, { timeout: 90_000 });
  await page.getByRole('button', { name: '自动适配缩放', exact: true }).click();
  await expect(page.locator('[data-render-detail="compact"]')).not.toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(173);
  const handles = await page.locator('.react-flow__handle').count();
  for (let step = 0; step < 20; step++) {
    const zoom = await page
      .locator('.react-flow__viewport')
      .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
    if (zoom >= 0.85) break;
    await page.locator('.react-flow__controls-zoomin').click();
  }
  await expect(page.locator('[data-render-detail="offscreen"]')).not.toHaveCount(0);
  expect(await page.locator('.react-flow__node img').count()).toBeLessThan(80);
  await expect(page.locator('.react-flow__handle')).toHaveCount(handles);
  await expect(page.locator('.react-flow__edge')).toHaveCount(173);
  const id = await page.locator('.react-flow__node').evaluateAll((nodes) => {
    const visible = nodes.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left > 350 && rect.right < 1400 && rect.top > 230 && rect.bottom < 700;
    });
    if (!visible) throw new Error('夹具没有可交互节点');
    return (visible as HTMLElement).dataset.id!;
  });
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  await node.hover();
  await expect(node.locator('.flow-node-floating-controls')).toBeVisible();
  const image = node.locator('.flow-node-preview img');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(640);
  const before = fixture.canvas().nodes.find((item) => item.id === id)!;
  const bounds = (await node.boundingBox())!;
  await page.mouse.move(bounds.x + 15, bounds.y + 15);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 75, bounds.y + 35, { steps: 12 });
  expect(await page.locator('.react-flow__edge').count()).toBeLessThan(173);
  await expect(page.getByRole('region', { name: '工作流画布' })).toHaveClass(/is-node-dragging/);
  const effect = page.locator('.canvas-edge-effect-meteor').first();
  await expect(effect).toHaveCSS('animation-play-state', 'paused');
  await expect(effect).toHaveCSS('visibility', 'hidden');
  await expect(effect).toHaveCSS('filter', 'none');
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(173);
  await expect(page.getByRole('region', { name: '工作流画布' })).not.toHaveClass(
    /is-node-dragging/,
  );
  await expect(effect).toHaveCSS('animation-play-state', 'running');
  await expect(effect).toHaveCSS('visibility', 'visible');
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => fixture.canvas().nodes.find((item) => item.id === id)!.position.x)
    .not.toBe(before.position.x);
  expect(fixture.canvas().edges).toHaveLength(173);
  expect(fixture.canvas().edges.every((edge) => !('hidden' in edge))).toBe(true);
  expect(fixture.canvas().nodes.find((item) => item.id === id)).toMatchObject({
    width: 220,
    height: 160,
  });
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => fixture.canvas().nodes.find((item) => item.id === id)!.position)
    .toEqual(before.position);
  await node.hover();
  await node.getByRole('button', { name: /^预览图片/ }).click();
  const dialog = page.getByRole('dialog');
  const original = dialog.locator('img');
  await expect
    .poll(() => original.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(3840);
  const index = Number(id.slice('thumb-node-'.length));
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载原文件' }).click();
  await inspectDownload(
    await downloadPromise,
    fixture.images[0]!.original,
    filename(`image-thumb-${String(index).padStart(3, '0')}`, 1),
  );
  await dialog.getByRole('button', { name: '关闭预览' }).click();
  await settleFrames(page);
  await page.screenshot({ path: testInfo.outputPath('large-canvas-normal.png') });
  expect(errors).toEqual([]);
  expect(fixture.errors).toEqual([]);
  expect(fixture.counts().blockedRequests).toBe(0);
});
