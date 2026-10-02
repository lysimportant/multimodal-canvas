import { expect, test } from '@playwright/test';
import { installFixture, project, settleFrames } from './image-thumbnail-cache.helpers';

/** 整理、保存和刷新只写合成画布；所有生成请求由夹具拒绝，不接触真实项目。 */
test('整理61个节点每行最多30个，保留尺寸连线并支持撤销重做和刷新', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  const fixture = await installFixture(page, baseURL, {
    nodes: 61,
    imageNodes: 61,
    withEdges: true,
  });
  const original = fixture.canvas();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/projects/' + project.id);
  await expect(page.locator('.react-flow__node')).toHaveCount(61, { timeout: 60_000 });
  const arrange = page.getByRole('button', { name: '整理画布节点', exact: true });
  const topArrange = page.getByRole('button', { name: '整理节点', exact: true });
  await expect(topArrange).toBeVisible();
  await expect(arrange).toBeVisible();
  await expect(arrange).toBeEnabled();
  await arrange.click();
  await expect.poll(() => fixture.canvas().nodes[30]?.position).toEqual({ x: 90, y: 350 });
  const arranged = fixture.canvas();
  const rows = new Map<number, number>();
  for (const node of arranged.nodes)
    rows.set(node.position.y, (rows.get(node.position.y) ?? 0) + 1);
  expect([...rows.values()]).toEqual([30, 30, 1]);
  expect(arranged.nodes[29]?.position).toEqual({ x: 8210, y: 110 });
  expect(arranged.nodes[60]?.position).toEqual({ x: 90, y: 590 });
  expect(arranged.nodes.map(({ position: _position, ...node }) => node)).toEqual(
    original.nodes.map(({ position: _position, ...node }) => node),
  );
  expect(arranged.edges).toEqual(original.edges);
  await expect(page.locator('.react-flow__node').first()).toHaveCSS('width', '220px');
  await expect(page.locator('.react-flow__node').first()).toHaveCSS('height', '160px');
  const writes = fixture.counts().canvasWrites;
  await topArrange.click();
  await settleFrames(page);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => fixture.canvas().nodes).toEqual(original.nodes);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(() => fixture.canvas().nodes).toEqual(arranged.nodes);
  expect(fixture.canvas().edges).toEqual(original.edges);
  expect(fixture.counts().canvasWrites).toBe(writes + 2);
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(61, { timeout: 60_000 });
  await expect(page.locator('.react-flow__node[data-id="thumb-node-30"]')).toHaveCSS(
    'transform',
    'matrix(1, 0, 0, 1, 90, 350)',
  );
  expect(fixture.canvas().nodes).toEqual(arranged.nodes);
  expect(fixture.canvas().edges).toEqual(original.edges);
  await page.screenshot({ path: testInfo.outputPath('canvas-auto-arrange.png') });
  expect(fixture.counts().blockedRequests).toBe(0);
  expect(fixture.errors).toEqual([]);
  expect(errors).toEqual([]);
});
