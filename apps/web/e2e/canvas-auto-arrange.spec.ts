import { expect, test } from '@playwright/test';
import { installFixture, project, settleFrames } from './image-thumbnail-cache.helpers';

/** 整理、保存和刷新只写合成画布；所有生成请求由夹具拒绝，不接触真实项目。 */
for (const { name, withEdges, expectedRows } of [
  {
    name: '无连线节点按十列网格排列',
    withEdges: false,
    expectedRows: [10, 10, 10, 10, 10, 10, 1].map((size, row) =>
      Array.from({ length: size }, (_, column) => row * 10 + column),
    ),
  },
  {
    name: '七条连接链各自按依赖层级从左到右排列',
    withEdges: true,
    expectedRows: [9, 9, 9, 9, 9, 8, 8].map((size, component) =>
      Array.from({ length: size }, (_, depth) => component + depth * 7),
    ),
  },
]) {
  test(
    '整理61个节点：' + name + '，保留尺寸连线并支持撤销重做和刷新',
    async ({ page, baseURL }, testInfo) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1600, height: 900 });
      const fixture = await installFixture(page, baseURL, {
        nodes: 61,
        imageNodes: 61,
        withEdges,
      });
      const original = fixture.canvas();
      expect(original.edges).toHaveLength(withEdges ? 54 : 0);
      // 夹具每隔七个节点连接一次：每条链按依赖深度从左到右，后一条链在下方另起区块。
      const positionsById = new Map(
        expectedRows.flatMap((members, row) =>
          members.map(
            (index, column) =>
              ['thumb-node-' + index, { x: 90 + column * 280, y: 110 + row * 240 }] as const,
          ),
        ),
      );
      const positions = original.nodes.map((node) => positionsById.get(node.id)!);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('/projects/' + project.id);
      await expect(page.locator('.react-flow__node')).toHaveCount(61, { timeout: 60_000 });
      const arrange = page.getByRole('button', { name: '整理画布节点', exact: true });
      const topArrange = page.getByRole('button', { name: '整理节点', exact: true });
      for (const button of [arrange, topArrange]) {
        await expect(button).toBeVisible();
        await expect(button).toBeEnabled();
        await expect(button).toHaveAttribute('title', /每行最多 10 个/);
        await expect(button).toHaveAttribute('title', /相连节点按层级排列/);
      }
      await arrange.click();
      await expect
        .poll(() => fixture.canvas().nodes.map((node) => node.position))
        .toEqual(positions);
      const arranged = fixture.canvas();
      const rows = new Map<number, string[]>();
      for (const node of arranged.nodes) {
        const members = rows.get(node.position.y) ?? [];
        members.push(node.id);
        rows.set(node.position.y, members);
      }
      expect([...rows.entries()].sort(([left], [right]) => left - right)).toEqual(
        expectedRows.map((members, row) => [
          110 + row * 240,
          members.map((index) => 'thumb-node-' + index),
        ]),
      );
      expect(arranged.nodes.map(({ position: _position, ...node }) => node)).toEqual(
        original.nodes.map(({ position: _position, ...node }) => node),
      );
      expect(arranged.edges).toEqual(original.edges);
      expect(arranged.groups ?? []).toEqual(original.groups ?? []);
      await expect(page.locator('.react-flow__node').first()).toHaveCSS('width', '220px');
      await expect(page.locator('.react-flow__node').first()).toHaveCSS('height', '160px');
      const writes = fixture.counts().canvasWrites;
      await topArrange.click();
      await settleFrames(page);
      expect(fixture.canvas().nodes).toEqual(arranged.nodes);
      expect(fixture.counts().canvasWrites).toBe(writes);
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(() => fixture.canvas().nodes).toEqual(original.nodes);
      expect(fixture.canvas().edges).toEqual(original.edges);
      expect(fixture.canvas().groups ?? []).toEqual(original.groups ?? []);
      await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: '重做', exact: true }).click();
      await expect.poll(() => fixture.canvas().nodes).toEqual(arranged.nodes);
      expect(fixture.canvas().edges).toEqual(original.edges);
      expect(fixture.counts().canvasWrites).toBe(writes + 2);
      await page.reload();
      await expect(page.locator('.react-flow__node')).toHaveCount(61, { timeout: 60_000 });
      for (const index of [0, 30, 60]) {
        const position = positions[index]!;
        await expect(
          page.locator('.react-flow__node[data-id="thumb-node-' + index + '"]'),
        ).toHaveCSS('transform', 'matrix(1, 0, 0, 1, ' + position.x + ', ' + position.y + ')');
      }
      expect(fixture.canvas().nodes).toEqual(arranged.nodes);
      expect(fixture.canvas().edges).toEqual(original.edges);
      expect(fixture.canvas().groups ?? []).toEqual(original.groups ?? []);
      await page.screenshot({ path: testInfo.outputPath('canvas-auto-arrange.png') });
      expect(fixture.counts().blockedRequests).toBe(0);
      expect(fixture.errors).toEqual([]);
      expect(errors).toEqual([]);
    },
  );
}

/** 以真实节点 DOM 外框验证 0→1、0→2 的横向层级及父节点居中，只写合成画布。 */
test('整理三节点分叉将父节点放在第一列并居中于第二列的两个子节点', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  const fixture = await installFixture(page, baseURL, {
    nodes: 3,
    imageNodes: 3,
    sidebarImages: 0,
    edges: [1, 2].map((index) => ({
      id: 'tree-edge-' + index,
      sourceNodeId: 'thumb-node-0',
      targetNodeId: 'thumb-node-' + index,
      sourceHandle: 'output:image',
      targetHandle: 'input:content',
      order: 0,
    })),
  });
  const original = fixture.canvas();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/projects/' + project.id);
  await expect(page.locator('.react-flow__node')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  const writes = fixture.counts().canvasWrites;
  const arrange = page.getByRole('button', { name: '整理画布节点', exact: true });
  await expect(arrange).toBeEnabled();
  await arrange.click();
  await expect.poll(() => fixture.counts().canvasWrites).toBe(writes + 1);
  const arranged = fixture.canvas();
  expect(arranged.nodes.map((node) => node.position)).not.toEqual(
    original.nodes.map((node) => node.position),
  );
  expect(arranged.nodes.map(({ position: _position, ...node }) => node)).toEqual(
    original.nodes.map(({ position: _position, ...node }) => node),
  );
  expect(arranged.edges).toEqual(original.edges);
  expect(arranged.groups ?? []).toEqual(original.groups ?? []);
  await settleFrames(page);
  await expect(async () => {
    const parent = await page.locator('.react-flow__node[data-id="thumb-node-0"]').boundingBox();
    const first = await page.locator('.react-flow__node[data-id="thumb-node-1"]').boundingBox();
    const second = await page.locator('.react-flow__node[data-id="thumb-node-2"]').boundingBox();
    expect(parent).not.toBeNull();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.x).toBeGreaterThan(parent!.x + parent!.width);
    expect(first!.x).toBeCloseTo(second!.x, 1);
    expect(first!.y + first!.height).toBeLessThan(second!.y);
    const parentCenter = parent!.y + parent!.height / 2;
    const childrenCenter = (first!.y + first!.height / 2 + second!.y + second!.height / 2) / 2;
    expect(Math.abs(parentCenter - childrenCenter)).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 10_000 });
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await page.mouse.move(1500, 100);
  await page.screenshot({ path: testInfo.outputPath('tree-parent-centered.png') });
  expect(fixture.counts().blockedRequests).toBe(0);
  expect(fixture.errors).toEqual([]);
  expect(errors).toEqual([]);
});
