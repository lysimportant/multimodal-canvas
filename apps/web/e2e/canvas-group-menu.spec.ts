import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { CanvasDocument } from '@multimodal-canvas/domain';

/** 专用画布使用隔离接口，不连接供应商。 */
const project = {
  id: 'canvas-group-menu',
  name: '分组与菜单验收',
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:00:00.000Z',
};
/** 媒体类型不同的两个组成员以及一个组外节点。 */
const initialCanvas: CanvasDocument = {
  revision: 1,
  nodes: [
    {
      id: 'text-member',
      type: 'text',
      position: { x: 160, y: 180 },
      width: 220,
      height: 170,
      data: {
        label: '文字成员',
        mediaType: 'text',
        mode: 'generate',
        enabled: true,
        prompt: 'A desk beside a window.',
      },
    },
    {
      id: 'image-member',
      type: 'image',
      position: { x: 460, y: 180 },
      width: 220,
      height: 170,
      data: { label: '图片成员', mediaType: 'image', mode: 'generate', enabled: true },
    },
    {
      id: 'video-outside',
      type: 'video',
      position: { x: 820, y: 180 },
      width: 220,
      height: 170,
      data: { label: '组外视频', mediaType: 'video', mode: 'generate', enabled: true },
    },
  ],
  edges: [],
  groups: [
    {
      id: 'example-group',
      name: '素材组',
      position: { x: 130, y: 120 },
      width: 580,
      height: 270,
      nodeIds: ['text-member', 'image-member'],
    },
  ],
};

/** 返回 JSON，所有 API 都由当前测试处理。 */
async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

/** 安装可保存并刷新恢复的隔离画布，记录未声明请求与页面错误。 */
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
        accessToken: 'synthetic-canvas-interactions',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'canvas-user',
          email: 'canvas@example.test',
          role: 'admin',
          createdAt: '2026-09-17T10:00:00.000Z',
        },
      }),
    );
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/prompt-skills') return json(route, { skills: [] });
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
    if (path === '/v1/assets') return json(route, { assets: [] });
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

/** 使用真实鼠标从目标中心拖动，位移单位为屏幕像素。 */
async function drag(page: Page, target: Locator, dx: number, dy: number) {
  const bounds = (await target.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

/** 等待正式保存接口完成，便于检查成员和外框坐标。 */
async function save(page: Page) {
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status', { name: /已保存/ })).toBeVisible();
}

for (const zoom of [0.5, 1, 2]) {
  test(`组名拖动 ${zoom * 100}%：成员同步移动、卡片统计、撤销和刷新`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const fixture = await installFixture(page);
    const group = page.locator('.canvas-group[data-group-id="example-group"]');
    const bounds = (await group.boundingBox())!;
    const currentZoom = await page
      .locator('.react-flow__viewport')
      .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
    await page.locator('.react-flow__pane').dispatchEvent('wheel', {
      deltaY: -Math.log2(zoom / currentZoom) / 0.002,
      deltaMode: 0,
      clientX: bounds.x,
      clientY: bounds.y,
      bubbles: true,
      cancelable: true,
    });
    await expect
      .poll(() =>
        page
          .locator('.react-flow__viewport')
          .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
      )
      .toBeCloseTo(zoom, 2);
    const name = group.locator('.canvas-group-name');
    await name.hover();
    const card = page.getByRole('region', { name: '素材组分组信息' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('2 个节点');
    await expect(card.locator('.canvas-group-hover-members')).toHaveText('文字1图片1音频0视频0');
    await page.screenshot({ path: testInfo.outputPath(`group-card-${zoom}.png`) });
    await drag(page, name, 40, 30);
    await save(page);
    const moved = structuredClone(fixture.canvas());
    for (const id of ['text-member', 'image-member']) {
      const initial = initialCanvas.nodes.find((node) => node.id === id)!;
      const node = moved.nodes.find((node) => node.id === id)!;
      expect(node.position.x).toBeCloseTo(initial.position.x + 40 / zoom, 1);
      expect(node.position.y).toBeCloseTo(initial.position.y + 30 / zoom, 1);
    }
    expect(moved.nodes[2]!.position).toEqual(initialCanvas.nodes[2]!.position);
    expect(moved.groups![0]!.position.x).toBeCloseTo(130 + 40 / zoom, 1);
    await page.getByRole('button', { name: '画布撤销', exact: true }).click();
    await save(page);
    expect(fixture.canvas().nodes.map((node) => node.position)).toEqual(
      initialCanvas.nodes.map((node) => node.position),
    );
    await page.getByRole('button', { name: '画布重做', exact: true }).click();
    await save(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.canvas-group')).toHaveCount(1);
    expect(fixture.canvas().groups).toEqual(moved.groups);
    await name.dblclick();
    await page.getByRole('textbox', { name: '组名称' }).fill('场景素材');
    await page.getByRole('textbox', { name: '组名称' }).press('Enter');
    await expect(name).toContainText('场景素材');
    expect(fixture.errors).toEqual([]);
  });
}

test('组内空白与悬浮栏可拖动，成员和端口仍可交互，解散保留成员', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const fixture = await installFixture(page);
  const group = page.locator('.canvas-group[data-group-id="example-group"]');
  const before = (await group.boundingBox())!;
  const zoom = await page
    .locator('.react-flow__viewport')
    .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  const point = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  const hit = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('.canvas-group')?.getAttribute('data-group-id'),
    point,
  );
  expect(hit).toBe('example-group');
  await drag(page, group, 40, 30);
  await expect(group).toHaveClass(/is-selected/);
  await expect(group.locator('.canvas-group-name')).toHaveAttribute('aria-pressed', 'true');
  const card = page.getByRole('region', { name: '素材组分组信息' });
  await expect(card).toBeVisible();
  await page.mouse.move(1870, 960);
  await expect(card).toBeVisible();
  await drag(page, card.getByRole('button', { name: '拖动组 素材组' }), 20, 10);
  await save(page);
  const moved = fixture.canvas();
  expect(moved.groups![0]!.position.x).toBeCloseTo(130 + 60 / zoom, 1);
  expect(moved.groups![0]!.position.y).toBeCloseTo(120 + 40 / zoom, 1);
  for (const id of ['text-member', 'image-member']) {
    const initial = initialCanvas.nodes.find((node) => node.id === id)!;
    const node = moved.nodes.find((node) => node.id === id)!;
    expect(node.position.x).toBeCloseTo(initial.position.x + 60 / zoom, 1);
    expect(node.position.y).toBeCloseTo(initial.position.y + 40 / zoom, 1);
  }
  const text = page.locator('.react-flow__node[data-id="text-member"]');
  await text.click();
  await expect(text).toHaveClass(/selected/);
  await expect(group).not.toHaveClass(/is-selected/);
  await expect(group.locator('.canvas-group-name')).toHaveAttribute('aria-pressed', 'false');
  const port = text.locator('.react-flow__handle').first();
  const portHit = await port.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const target = document.elementFromPoint(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    return {
      isHandle: Boolean(target?.closest('.react-flow__handle')),
      target: target?.className,
      layers: [
        '.react-flow',
        '.react-flow__renderer',
        '.react-flow__pane',
        '.react-flow__viewport',
      ].map((selector) => {
        const layer = document.querySelector(selector)!;
        return { selector, zIndex: getComputedStyle(layer).zIndex };
      }),
    };
  });
  expect(portHit.isHandle, JSON.stringify(portHit)).toBe(true);
  const output = (await text.locator('.react-flow__handle.source').boundingBox())!;
  const input = (await page
    .locator('.react-flow__node[data-id="image-member"] .flow-node-handle--top')
    .boundingBox())!;
  await page.mouse.move(output.x + output.width / 2, output.y + output.height / 2);
  await page.mouse.down();
  await page.mouse.move(input.x + input.width / 2, input.y + input.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await save(page);
  expect(fixture.canvas().edges[0]).toMatchObject({
    sourceNodeId: 'text-member',
    targetNodeId: 'image-member',
    targetHandle: 'input:prompt',
  });
  const selectableArea = (await group.boundingBox())!;
  await group.click({
    position: { x: selectableArea.width - 14, y: selectableArea.height - 14 },
  });
  await expect(group).toHaveClass(/is-selected/);
  await expect(text).not.toHaveClass(/selected/);
  await expect(page.getByRole('region', { name: '文字成员生成设置' })).toHaveCount(0);
  await drag(page, group.locator('.canvas-group-handle-se'), 35, 25);
  await save(page);
  expect(fixture.canvas().groups![0]!.width).toBeCloseTo(580 + 35 / zoom, 1);
  expect(fixture.canvas().groups![0]!.height).toBeCloseTo(270 + 25 / zoom, 1);
  expect(fixture.canvas().nodes.map((node) => node.position)).toEqual(
    moved.nodes.map((node) => node.position),
  );
  await page.screenshot({ path: testInfo.outputPath('group-blank-drag-and-toolbar.png') });
  await card.getByRole('button', { name: '解散组 素材组' }).click();
  await expect(group).toHaveCount(0);
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await save(page);
  expect(fixture.canvas().groups).toEqual([]);
  expect(fixture.canvas().edges).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

for (const viewport of [
  { width: 1366, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`${viewport.width} 竖向右键菜单、键盘关闭、新建空组可拖动`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixture = await installFixture(page);
    await page.mouse.click(viewport.width - 32, viewport.height - 120, { button: 'right' });
    const menu = page.getByRole('menu', { name: '画布操作' });
    await expect(menu).toBeVisible();
    const items = await menu.locator('.canvas-context-menu-list [role="menuitem"]').all();
    const positions = await Promise.all(items.map((item) => item.boundingBox()));
    expect(positions).toHaveLength(4);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!.x).toBeCloseTo(positions[0]!.x, 1);
      expect(positions[i]!.y).toBeGreaterThanOrEqual(
        positions[i - 1]!.y + positions[i - 1]!.height,
      );
    }
    const menuBounds = (await menu.boundingBox())!;
    expect(menuBounds.x).toBeGreaterThanOrEqual(8);
    expect(menuBounds.y).toBeGreaterThanOrEqual(8);
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height - 8);
    await expect(menu.getByRole('menuitem', { name: '撤销', exact: true })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: '清空画布', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('vertical-context-menu.png') });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await page.getByRole('button', { name: '新建分组', exact: true }).click();
    await expect(page.locator('.canvas-group')).toHaveCount(2);
    const newGroup = page.locator('.canvas-group').last();
    const before = (await newGroup.boundingBox())!;
    await drag(page, newGroup.locator('.canvas-group-name'), 35, 20);
    const after = (await newGroup.boundingBox())!;
    expect(after.x - before.x).toBeCloseTo(35, 0);
    expect(after.y - before.y).toBeCloseTo(20, 0);
    await save(page);
    expect(fixture.canvas().groups).toHaveLength(2);
    expect(fixture.errors).toEqual([]);
  });
}
