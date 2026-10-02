import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { CanvasDocument } from '@multimodal-canvas/domain';

/** 隔离合成项目；不复用真实项目、凭据或 Provider。 */
const project = {
  id: 'canvas-group-overflow-fixture',
  name: '分组滚动范围回归',
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

/** 创建两个成员组、61 个组外节点和可选空组；整理后组框超出当前视口，节点尺寸不变。 */
function createCanvas(includeEmpty = false): CanvasDocument {
  return {
    revision: 1,
    nodes: Array.from({ length: 65 }, (_, index) => ({
      id: `overflow-node-${index}`,
      type: 'text',
      position:
        index < 4
          ? { x: 170 + (index % 2) * 280, y: 170 + Math.floor(index / 2) * 350 }
          : { x: 900 + ((index - 4) % 7) * 250, y: 170 + Math.floor((index - 4) / 7) * 190 },
      width: 220,
      height: 160,
      data: {
        label: `合成文字 ${index}`,
        mediaType: 'text',
        mimeType: 'text/plain',
        mode: 'generate',
        enabled: true,
        prompt: 'Synthetic layout regression; never generate content.',
      },
    })),
    edges: [],
    groups: [
      ...[0, 1].map((index) => ({
        id: `overflow-group-${index}`,
        name: `合成分组 ${index}`,
        position: { x: 130, y: 110 + index * 350 },
        width: 580,
        height: 270,
        nodeIds: [`overflow-node-${index * 2}`, `overflow-node-${index * 2 + 1}`],
      })),
      ...(includeEmpty
        ? [
            {
              id: 'overflow-empty',
              name: '合成空组',
              position: { x: 730, y: 110 },
              width: 150,
              height: 270,
              nodeIds: [],
            },
          ]
        : []),
    ],
  };
}

/** 安装同源内存 API；仅允许合成画布保存，任何未声明或外部请求都计为错误。 */
async function installFixture(page: Page, baseURL: string | undefined, includeEmpty = false) {
  if (!baseURL) throw new Error('分组溢出回归需要隔离本地地址');
  const url = new URL(baseURL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || url.port === '8080')
    throw new Error('分组溢出回归禁止真实项目端口和外部服务');
  let canvas = createCanvas(includeEmpty);
  let writes = 0;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-group-overflow',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'overflow-user',
          email: 'overflow@example.test',
          role: 'admin',
          createdAt: '2026-10-02T00:00:00.000Z',
        },
      }),
    );
  });
  /** 只向当前被拦截请求返回内存 JSON，不发起网络访问。 */
  const json = (route: Route, body: unknown) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const path = target.pathname;
    const method = request.method();
    if (target.protocol === 'data:' || target.protocol === 'blob:') return route.continue();
    if (target.origin !== url.origin) {
      errors.push(`拒绝外部访问：${method} ${target.origin}${path}`);
      return route.abort('blockedbyclient');
    }
    if (!path.startsWith('/v1/') && ['GET', 'HEAD'].includes(method)) return route.continue();
    if (method === 'PATCH' && path === `/v1/projects/${project.id}/canvas`) {
      canvas = { ...request.postDataJSON(), revision: canvas.revision + 1 };
      writes += 1;
      return json(route, { canvas });
    }
    if (!['GET', 'HEAD'].includes(method)) {
      errors.push(`拒绝未声明写入：${method} ${path}`);
      return route.fulfill({ status: 403, body: '仅允许合成画布保存' });
    }
    if (path === '/v1/auth/me')
      return json(route, {
        user: { id: 'overflow-user', email: 'overflow@example.test', role: 'admin' },
      });
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path === `/v1/projects/${project.id}/canvas`) return json(route, { canvas });
    if (path.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path.endsWith('/models/defaults')) return json(route, { defaults: {} });
    if (path.endsWith('/runs')) return json(route, { runs: [] });
    if (path === '/v1/assets') return json(route, { assets: [] });
    if (path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (path === '/v1/models') return json(route, { models: [] });
    if (path === '/v1/settings/ai')
      return json(route, { settings: { defaultModels: {}, timeoutMs: 900_000 } });
    errors.push(`未声明的隔离接口：${method} ${path}`);
    return route.fulfill({ status: 404, body: '未声明的隔离接口' });
  });
  return { canvas: () => canvas, writes: () => writes, errors };
}

/** 测量文档滚动尺寸、组框与节点视口；单位为 CSS 像素，不修改页面样式。 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const area = document.querySelector('.canvas-area')!;
    const layer = document.querySelector('.canvas-group-layer')!;
    const viewport = document.querySelector('.react-flow__viewport')!;
    return {
      window: { width: innerWidth, height: innerHeight, x: scrollX, y: scrollY },
      root: { width: root.scrollWidth, height: root.scrollHeight },
      body: { width: body.scrollWidth, height: body.scrollHeight },
      area: area.getBoundingClientRect().toJSON(),
      layer: {
        rect: layer.getBoundingClientRect().toJSON(),
        overflow: getComputedStyle(layer).overflow,
        zIndex: getComputedStyle(layer).zIndex,
      },
      viewport: getComputedStyle(viewport).transform,
      groups: [...document.querySelectorAll('.canvas-group')].map((group) => ({
        id: group.getAttribute('data-group-id'),
        rect: group.getBoundingClientRect().toJSON(),
      })),
      popovers: [...document.querySelectorAll('.canvas-group-popover')].map((element) => ({
        rect: element.getBoundingClientRect().toJSON(),
        visibility: getComputedStyle(element).visibility,
      })),
    };
  });
}

/** 一帧的文档滚动范围及页面位移，单位为 CSS 像素。 */
type ScrollFrame = { width: number; height: number; x: number; y: number };

/** 连续采样 90 帧，覆盖浮卡离场动画；不修改样式，不掩盖短暂滚动溢出。 */
async function sampleScrollFrames(page: Page): Promise<ScrollFrame[]> {
  return page.evaluate(
    () =>
      new Promise<ScrollFrame[]>((resolve) => {
        const frames: ScrollFrame[] = [];
        /** 读取本帧文档范围，样本齐全时返回而不留下持续运行的监听器。 */
        const sample = () => {
          frames.push({
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
            x: scrollX,
            y: scrollY,
          });
          if (frames.length === 90) resolve(frames);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
}

/** 对照保存坐标、视口矩阵与真实 DOM，验证远处组框和成员没有坐标漂移或尺寸变化。 */
async function expectProjection(page: Page, canvas: CanvasDocument) {
  const metrics = await measure(page);
  const viewport = await page.locator('.react-flow__viewport').evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
  for (const group of canvas.groups ?? []) {
    const box = metrics.groups.find((item) => item.id === group.id)!.rect;
    expect(
      Math.abs(box.x - metrics.area.x - viewport.x - group.position.x * viewport.zoom),
    ).toBeLessThan(0.1);
    expect(
      Math.abs(box.y - metrics.area.y - viewport.y - group.position.y * viewport.zoom),
    ).toBeLessThan(0.1);
    expect(Math.abs(box.width - group.width * viewport.zoom)).toBeLessThan(0.1);
    expect(Math.abs(box.height - group.height * viewport.zoom)).toBeLessThan(0.1);
    expect(group.width).toBeLessThanOrEqual(10_000);
    expect(group.height).toBeLessThanOrEqual(10_000);
    for (const id of group.nodeIds) {
      const member = canvas.nodes.find((node) => node.id === id)!;
      const memberBox = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
      expect(
        Math.abs(memberBox.x - box.x - (member.position.x - group.position.x) * viewport.zoom),
      ).toBeLessThan(0.1);
      expect(
        Math.abs(memberBox.y - box.y - (member.position.y - group.position.y) * viewport.zoom),
      ).toBeLessThan(0.1);
      expect(memberBox.x).toBeGreaterThanOrEqual(box.x);
      expect(memberBox.y).toBeGreaterThanOrEqual(box.y);
      expect(memberBox.x + memberBox.width).toBeLessThanOrEqual(box.right);
      expect(memberBox.y + memberBox.height).toBeLessThanOrEqual(box.bottom);
    }
  }
}

/** 在不同缩放下整理到视口外，验证组框不撑开文档且仍与节点使用同一坐标投影。 */
for (const { zoom, includeEmpty } of [
  { zoom: 0.5, includeEmpty: false },
  { zoom: 1, includeEmpty: false },
  { zoom: 2, includeEmpty: false },
  { zoom: 1, includeEmpty: true },
]) {
  test(`${includeEmpty ? '空组' : '分组'}整理 ${zoom * 100}% 不扩大文档滚动范围`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    const fixture = await installFixture(page, baseURL, includeEmpty);
    const original = structuredClone(fixture.canvas());
    await page.goto(`/projects/${project.id}`);
    await expect(page.locator('.react-flow__node')).toHaveCount(65, { timeout: 60_000 });
    const groupId = includeEmpty ? 'overflow-empty' : 'overflow-group-0';
    const cardName = includeEmpty ? '合成空组分组信息' : '合成分组 0分组信息';
    const group = page.locator(`.canvas-group[data-group-id="${groupId}"]`);
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
    await group.locator('.canvas-group-name').hover();
    await expect(page.getByRole('region', { name: cardName })).toBeVisible();
    const before = await measure(page);
    await page.screenshot({ path: testInfo.outputPath('before-arrange.png') });
    const samplesPromise = sampleScrollFrames(page);
    await page.getByRole('button', { name: '整理画布节点', exact: true }).click();
    await expect.poll(fixture.writes).toBe(1);
    const after = await measure(page);
    const frames = await samplesPromise;
    const settled = await measure(page);
    const metricsPath = testInfo.outputPath('document-overflow-metrics.json');
    await writeFile(
      metricsPath,
      JSON.stringify({ before, after, settled, frames, canvas: fixture.canvas() }, null, 2),
    );
    await testInfo.attach('document-overflow-metrics', {
      path: metricsPath,
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('arranged-groups.png') });
    expect(fixture.errors).toEqual([]);
    expect(fixture.canvas().nodes.map(({ position: _position, ...node }) => node)).toEqual(
      original.nodes.map(({ position: _position, ...node }) => node),
    );
    expect(fixture.canvas().edges).toEqual(original.edges);
    expect(fixture.canvas().groups?.map((item) => item.nodeIds)).toEqual(
      original.groups?.map((item) => item.nodeIds),
    );
    for (const metrics of [before, after, settled]) {
      expect(metrics.root).toEqual({ width: 1600, height: 900 });
      expect(metrics.body).toEqual({ width: 1600, height: 900 });
      expect(metrics.window).toEqual(before.window);
    }
    expect(Math.max(...frames.map((frame) => frame.width))).toBe(1600);
    expect(Math.max(...frames.map((frame) => frame.height))).toBe(900);
    expect(frames.every((frame) => frame.x === 0 && frame.y === 0)).toBe(true);
    expect(after.viewport).toBe(before.viewport);
    expect(after.groups.every((item) => item.rect.top > 900)).toBe(true);
    for (let index = 0; index < 61; index += 1) {
      expect(fixture.canvas().nodes[index + 4]!.position).toEqual({
        x: 130 + (index % 5) * 280,
        y: 110 + Math.floor(index / 5) * 240,
      });
    }
    await expectProjection(page, fixture.canvas());
    // 组框在当前视口外是五列整理的合法结果，适配视图后必须仍能访问，不能靠隐藏组框消除溢出。
    await page.locator('.react-flow__controls-fitview').click();
    if (includeEmpty) {
      // 空组不参与既有节点适配范围；通过实际画布平移确认可找回，不强制改变缩放策略。
      const box = (await group.boundingBox())!;
      await page.mouse.move(1450, 700);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(1450, 700 + 450 - box.y - box.height / 2, { steps: 8 });
      await page.mouse.up({ button: 'middle' });
    }
    await expect(async () => {
      const box = (await group.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(900);
    }).toPass({ timeout: 5000 });
    await group.locator('.canvas-group-name').hover();
    const card = page.getByRole('region', { name: cardName });
    await expect(card).toBeVisible();
    const popup = page.locator('.canvas-group-popover').filter({ has: card });
    await expect(popup).toHaveCSS('position', 'fixed');
    await expectProjection(page, fixture.canvas());
    expect((await measure(page)).root).toEqual({ width: 1600, height: 900 });
    await page.screenshot({ path: testInfo.outputPath('fit-view-groups.png') });
    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(65, { timeout: 60_000 });
    await expectProjection(page, fixture.canvas());
    expect((await measure(page)).root).toEqual({ width: 1600, height: 900 });
    expect(fixture.errors).toEqual([]);
  });
}
