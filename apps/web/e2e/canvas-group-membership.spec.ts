import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { CanvasDocument } from '@multimodal-canvas/domain';

/** 专用画布使用隔离接口，不连接供应商。 */
const project = {
  id: 'canvas-group-membership',
  name: '分组归属验收',
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
        mimeType: 'text/plain',
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
      data: {
        label: '图片成员',
        mediaType: 'image',
        mimeType: 'image/png',
        mode: 'generate',
        enabled: true,
      },
    },
    {
      id: 'video-outside',
      type: 'video',
      position: { x: 820, y: 180 },
      width: 220,
      height: 170,
      data: {
        label: '组外视频',
        mediaType: 'video',
        mimeType: 'video/mp4',
        mode: 'generate',
        enabled: true,
      },
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
async function installFixture(page: Page, source: CanvasDocument = initialCanvas) {
  const baseURL = test.info().project.use.baseURL;
  if (
    !baseURL ||
    new URL(baseURL).port === '8080' ||
    !['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)
  )
    throw new Error('组验收只允许隔离本地端口');
  const origin = new URL(baseURL).origin;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === origin)
      return route.fallback();
    throw new Error('组验收阻断外部访问：' + url.origin);
  });
  let canvas = structuredClone(source);
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
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== origin) {
      errors.push('组验收拒绝外部 API：' + requestUrl.origin);
      return route.fulfill({ status: 403, body: '仅允许隔离同源接口' });
    }
    const path = requestUrl.pathname;
    if (path === '/v1/auth/me')
      return json(route, {
        user: {
          id: 'canvas-user',
          email: 'canvas@example.test',
          role: 'admin',
          createdAt: '2026-09-17T10:00:00.000Z',
        },
      });
    if (path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (
      !['GET', 'HEAD'].includes(request.method()) &&
      !(request.method() === 'PATCH' && path === `/v1/projects/${project.id}/canvas`)
    ) {
      errors.push('组验收拒绝未声明写入：' + request.method() + ' ' + path);
      return route.fulfill({ status: 403, body: '禁止验收之外的写入' });
    }
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
    if (path === '/v1/settings/ai')
      return json(route, {
        settings: { defaultModels: {}, timeoutMs: 900_000 },
      });
    if (path === '/v1/models') return json(route, { models: [] });
    errors.push(`未声明的 Mock 接口：${request.method()} ${path}`);
    return route.fulfill({ status: 404, body: '未声明的验收接口' });
  });
  await page.goto(`/projects/${project.id}`);
  await expect(page.locator('.react-flow__node')).toHaveCount(3, { timeout: 60_000 });
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

test('已有空组覆盖节点：首次整组拖动补齐成员，撤销重做及刷新一致', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const source = structuredClone(initialCanvas);
  source.groups![0]!.nodeIds = [];
  const fixture = await installFixture(page, source);
  const group = page.locator('.canvas-group[data-group-id="example-group"]');
  const zoom = await page
    .locator('.react-flow__viewport')
    .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  await drag(page, group.locator('.canvas-group-name'), 60, 40);
  await save(page);
  const moved = structuredClone(fixture.canvas());
  expect(moved.groups![0]!.nodeIds).toEqual(['text-member', 'image-member']);
  for (const index of [0, 1]) {
    expect(moved.nodes[index]!.position.x).toBeCloseTo(
      source.nodes[index]!.position.x + 60 / zoom,
      1,
    );
    expect(moved.nodes[index]!.position.y).toBeCloseTo(
      source.nodes[index]!.position.y + 40 / zoom,
      1,
    );
  }
  expect(moved.nodes[2]).toEqual(source.nodes[2]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await save(page);
  expect(fixture.canvas().groups).toEqual(source.groups);
  expect(fixture.canvas().nodes).toEqual(source.nodes);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await save(page);
  expect(fixture.canvas().groups).toEqual(moved.groups);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(group.locator('.canvas-group-name small')).toHaveText('2');
  expect(fixture.canvas().nodes).toEqual(moved.nodes);
  expect(fixture.errors).toEqual([]);
});

test('放大组框吸纳未归属节点，不移动节点，缩放和归属共用一次撤销', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const source = structuredClone(initialCanvas);
  source.groups![0]!.width = 290;
  source.groups![0]!.nodeIds = ['text-member'];
  const fixture = await installFixture(page, source);
  const group = page.locator('.canvas-group[data-group-id="example-group"]');
  await group.locator('.canvas-group-name').click();
  const zoom = await page
    .locator('.react-flow__viewport')
    .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  await drag(page, group.locator('.canvas-group-handle-se'), 300 * zoom, 20 * zoom);
  await save(page);
  expect(fixture.canvas().groups![0]!.nodeIds).toEqual(['text-member', 'image-member']);
  expect(fixture.canvas().nodes).toEqual(source.nodes);
  const resized = structuredClone(fixture.canvas());
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await save(page);
  expect(fixture.canvas().groups).toEqual(source.groups);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await save(page);
  expect(fixture.canvas().groups).toEqual(resized.groups);
  await drag(page, group.locator('.canvas-group-name'), 30, 20);
  await save(page);
  for (const index of [0, 1])
    expect(fixture.canvas().nodes[index]!.position.x).toBeCloseTo(
      source.nodes[index]!.position.x + 30 / zoom,
      1,
    );
  expect(fixture.canvas().nodes[2]).toEqual(source.nodes[2]);
  expect(fixture.errors).toEqual([]);
});

test('新建组立即归纳框内节点，创建和归属可一步撤销重做', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const source = structuredClone(initialCanvas);
  source.groups = [];
  const fixture = await installFixture(page, source);
  await page.getByRole('button', { name: '新建分组', exact: true }).click();
  await save(page);
  const created = fixture.canvas().groups![0]!;
  const enclosed = source.nodes
    .filter((node) => {
      const x = node.position.x + node.width! / 2;
      const y = node.position.y + node.height! / 2;
      return (
        x >= created.position.x + 24 &&
        x <= created.position.x + created.width - 24 &&
        y >= created.position.y + 24 &&
        y <= created.position.y + created.height - 24
      );
    })
    .map((node) => node.id);
  expect(enclosed.length).toBeGreaterThan(0);
  expect(created.nodeIds).toEqual(enclosed);
  expect(fixture.canvas().nodes).toEqual(source.nodes);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await save(page);
  expect(fixture.canvas().groups).toEqual([]);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await save(page);
  expect(fixture.canvas().groups).toEqual([created]);
  expect(fixture.errors).toEqual([]);
});

test('整理先补齐旧空组成员，再布局；节点尺寸和连线保留，可撤销重做', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const source = structuredClone(initialCanvas);
  source.groups![0]!.nodeIds = [];
  const fixture = await installFixture(page, source);
  await page.getByRole('button', { name: '整理节点', exact: true }).click();
  await save(page);
  const arranged = structuredClone(fixture.canvas());
  expect(arranged.groups![0]!.nodeIds).toEqual(['text-member', 'image-member']);
  expect(arranged.edges).toEqual(source.edges);
  expect(arranged.nodes.map(({ position, ...node }) => node)).toEqual(
    source.nodes.map(({ position, ...node }) => node),
  );
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await save(page);
  expect(fixture.canvas().groups).toEqual(source.groups);
  expect(fixture.canvas().nodes).toEqual(source.nodes);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await save(page);
  expect(fixture.canvas().groups).toEqual(arranged.groups);
  expect(fixture.errors).toEqual([]);
});

test('空组移动到节点上方，松手才吸纳，下次拖动成员一起移动', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const source = structuredClone(initialCanvas);
  source.groups![0]!.position.y = 450;
  source.groups![0]!.nodeIds = [];
  const fixture = await installFixture(page, source);
  const group = page.locator('.canvas-group[data-group-id="example-group"]');
  const zoom = await page
    .locator('.react-flow__viewport')
    .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  await drag(page, group.locator('.canvas-group-name'), 0, -330 * zoom);
  await save(page);
  expect(fixture.canvas().groups![0]!.nodeIds).toEqual(['text-member', 'image-member']);
  expect(fixture.canvas().nodes).toEqual(source.nodes);
  await drag(page, group.locator('.canvas-group-name'), 40, 20);
  await save(page);
  for (const index of [0, 1])
    expect(fixture.canvas().nodes[index]!.position.x).toBeCloseTo(
      source.nodes[index]!.position.x + 40 / zoom,
      1,
    );
  expect(fixture.canvas().nodes[2]).toEqual(source.nodes[2]);
  expect(fixture.errors).toEqual([]);
});
