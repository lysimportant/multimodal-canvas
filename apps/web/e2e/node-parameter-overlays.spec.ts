import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { canvasDocumentSchema } from '@multimodal-canvas/domain';

/** 参数回归仅操作内存项目；登录、目录和画布接口全部由浏览器拦截。 */
const project = {
  id: 'node-parameter-overlays-browser',
  name: '节点参数浮层回归',
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};
/** 不建立真实资源或生成任务，长模型名用于检查非枚举列表仍可正常换行。 */
const longModelName = '用于验证模型说明保留完整内容的合成视频模型'.repeat(4);

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });

/** 返回合成 JSON，不允许未声明请求进入真实 API。 */
async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * 提供有效 Cookie 会话和合成参数目录；PATCH 只更新本用例的内存画布。
 * modelAlias 选择 Wan3 或 Moon H3 的现有 UI 合同，不请求对应供应商。
 * @returns 错误、请求及当前参数读取器，用于核实交互没有产生任何生成请求。
 */
async function installFixture(
  page: Page,
  baseURL: string | undefined,
  modelAlias = 'wan3.0-video',
) {
  if (!baseURL) throw new Error('缺少隔离的 Playwright baseURL');
  const webUrl = new URL(baseURL);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(webUrl.hostname) ||
    !webUrl.port ||
    webUrl.port === '8080'
  )
    throw new Error('参数回归只允许独立本地 Web 端口，禁止使用真实 8080 项目');
  const webOrigin = webUrl.origin;
  const errors: string[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  const user = {
    id: 'parameter-user',
    email: 'parameter@example.test',
    role: 'user',
    createdAt: project.createdAt,
  };
  let canvas = canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: 'parameter-node',
        type: 'video',
        position: { x: 390, y: 220 },
        width: 320,
        height: 180,
        data: {
          label: '参数浮层验收节点',
          mediaType: 'video',
          mode: 'generate',
          videoMode: 'text_to_video',
          enabled: true,
          modelAlias,
          credentialId: 'synthetic-parameter-credential',
          prompt: 'A quiet room with soft daylight.',
          parameters: {
            resolution: modelAlias === 'minimax-h3' ? '768p' : '720p',
            aspectRatio: '16:9',
            duration: 5,
          },
        },
      },
    ],
    edges: [],
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript((user) => {
    localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user }));
  }, user);
  await page.context().routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    // 只模拟 Vite 握手，不建立真实 WebSocket 或转发业务消息。
    if (url.host === webUrl.host && url.pathname === '/' && url.searchParams.has('token')) {
      socket.send(JSON.stringify({ type: 'connected' }));
      return;
    }
    errors.push(`已阻断未声明 WebSocket：${url.origin}${url.pathname}`);
    socket.close({ code: 1008, reason: 'Only the isolated Vite handshake is allowed' });
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
        !['fetch', 'xhr', 'eventsource'].includes(request.resourceType()) &&
        (path === `/projects/${project.id}` ||
          /^\/(?:@vite\/|@id\/|@fs\/|@react-refresh$|src\/|node_modules\/|assets\/|favicon\.)/.test(
            path,
          ))
      )
        return route.continue();
      errors.push(`已阻断未声明网络请求：${method} ${url.origin}${path}`);
      return route.abort('blockedbyclient');
    }
    requests.push({ method, path });
    if (method === 'GET' && path === '/v1/auth/me')
      return json(route, { user, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    if (method === 'GET' && path === '/v1/projects') return json(route, { projects: [project] });
    if (method === 'GET' && path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path === `/v1/projects/${project.id}/canvas`) {
      if (method === 'PATCH')
        canvas = canvasDocumentSchema.parse({
          ...request.postDataJSON(),
          revision: canvas.revision + 1,
        });
      if (method === 'GET' || method === 'PATCH') return json(route, { canvas });
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/events`)
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (method === 'GET' && path === `/v1/projects/${project.id}/runs`)
      return json(route, { runs: [] });
    if (method === 'GET' && path === `/v1/projects/${project.id}/models/defaults`)
      return json(route, { defaults: {}, resolvedDefaults: {} });
    if (method === 'GET' && path === '/v1/settings/ai')
      return json(route, { settings: { defaultModels: {}, timeoutMs: 900_000 } });
    if (method === 'GET' && path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (method === 'GET' && path === '/v1/assets') return json(route, { assets: [] });
    if (method === 'GET' && path === '/v1/models')
      return json(route, {
        models: [
          {
            id: modelAlias,
            name: '参数回归视频模型',
            mediaTypes: ['video'],
            credentialId: 'synthetic-parameter-credential',
            group: 'synthetic',
            available: true,
            capabilities: {
              video: {
                resolutions: ['480p', '720p', '768p', '1080p'],
                aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
              },
            },
          },
          {
            id: 'synthetic-long-model',
            name: longModelName,
            mediaTypes: ['video'],
            credentialId: 'synthetic-parameter-credential',
            group: 'synthetic',
            available: true,
          },
        ],
      });
    // 未提供生成路由；误点或新增未知请求都会失败，不会到达真实服务。
    errors.push(`未声明的 Mock 接口：${method} ${path}`);
    return route.abort('blockedbyclient');
  });
  await page.goto(`/projects/${project.id}`);
  const node = page.locator('.react-flow__node[data-id="parameter-node"]');
  await expect(node).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() =>
      page
        .locator('.react-flow__viewport')
        .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
    )
    .toBeCloseTo(1.1, 3);
  const box = (await node.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.quick-editor-overlay')).toBeVisible();
  return { errors, requests, parameters: () => canvas.nodes[0]!.data.parameters };
}

/** 按用户路径进入快捷或完整编辑器，再打开共享的媒体参数页。 */
async function openParameters(page: Page, presentation: '快捷' | '完整') {
  if (presentation === '完整') await page.getByRole('button', { name: '打开完整编辑器' }).click();
  await page.getByRole('button', { name: '媒体参数', exact: true }).click();
  const panel = page.getByRole('region', { name: '生成参数' });
  await expect(panel).toBeVisible();
  return panel;
}

/** 检查真实绘制层级；仅存在于 DOM 或 boundingBox 可见不能证明控件没被覆盖。 */
async function expectUnobstructed(target: Locator) {
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return Boolean(hit && element.contains(hit));
      }),
    )
    .toBe(true);
}

/** 短枚举的标签和说明均应完整显示为单行，不能用 ellipsis 隐藏文字来通过验收。 */
async function expectSingleLineOptions(list: Locator) {
  const text = list.locator('.node-quick-editor-option-copy').locator('strong, small');
  await expect(text.first()).toBeVisible();
  const measurements = await text.evaluateAll((elements) =>
    elements.map((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        text: element.textContent,
        lines: range.getClientRects().length,
        clipped: element.scrollWidth > element.clientWidth + 1,
      };
    }),
  );
  expect(measurements.filter((item) => item.lines !== 1 || item.clipped)).toEqual([]);
}

test.afterEach(async ({ page }, testInfo) => {
  await page.screenshot({ path: testInfo.outputPath('parameter-overlays.png'), fullPage: true });
});

for (const presentation of ['快捷', '完整'] as const) {
  test(`${presentation}参数页的秒数浮卡不被父面板遮挡，滑块、自动及清除可操作`, async ({
    page,
    baseURL,
  }, testInfo) => {
    const fixture = await installFixture(page, baseURL);
    const panel = await openParameters(page, presentation);
    const trigger = panel.getByRole('button', { name: /^时长（秒）：/ });
    await trigger.click();
    const card = page.getByRole('dialog', { name: '视频时长', exact: true });
    const slider = card.getByRole('slider', { name: '视频时长（秒）', exact: true });
    const automatic = card.getByRole('button', { name: '自动时长', exact: true });
    const clear = card.getByRole('button', { name: '清除时长', exact: true });
    await expect(slider).toHaveAttribute('type', 'range');
    await expect(slider).toHaveAttribute('min', '5');
    await expect(slider).toHaveAttribute('max', '30');
    await expect(slider).toHaveAttribute('step', '1');
    await expect(slider).toHaveValue('5');
    for (const control of [slider, automatic, clear]) await expectUnobstructed(control);
    await page.screenshot({ path: testInfo.outputPath('duration-open.png'), fullPage: true });
    await slider.press('End');
    await expect(slider).toHaveValue('30');
    await expect.poll(() => fixture.parameters()?.duration).toBe(30);
    await expect(panel).toBeVisible();
    await slider.press('Home');
    await expect(slider).toHaveValue('5');
    for (let second = 5; second < 12; second++) await slider.press('ArrowRight');
    await expect(slider).toHaveValue('12');
    await expect.poll(() => fixture.parameters()?.duration).toBe(12);
    await automatic.click();
    await expect.poll(() => fixture.parameters()?.duration).toBe(-1);
    await expect(trigger).toHaveAccessibleName('时长（秒）：自动');
    await trigger.click();
    await expect(slider).toHaveValue('10');
    await expect(automatic).toHaveAttribute('aria-pressed', 'true');
    await clear.click();
    await expect.poll(() => fixture.parameters()?.duration).toBeUndefined();
    await expect(trigger).toHaveAccessibleName('时长（秒）：未设置');
    await trigger.click();
    await expect(slider).toHaveValue('10');
    await expect(clear).toBeDisabled();
    await slider.press('Home');
    for (let second = 5; second < 12; second++) await slider.press('ArrowRight');
    await expect.poll(() => fixture.parameters()?.duration).toBe(12);
    await slider.press('Escape');
    await expect(card).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(panel).toBeVisible();
    if (presentation === '完整')
      await expect(page.locator('.node-quick-editor-dialog')).toBeVisible();
    expect(fixture.errors).toEqual([]);
    expect(fixture.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  for (const modelAlias of ['wan3.0-video', 'minimax-h3']) {
    test(`${presentation} ${modelAlias} 比例值及中文说明不换行，短清晰度仍紧凑排列`, async ({
      page,
      baseURL,
    }, testInfo) => {
      const fixture = await installFixture(page, baseURL, modelAlias);
      const panel = await openParameters(page, presentation);
      await panel.getByRole('combobox', { name: /^视频比例：/ }).click();
      const ratios = page.getByRole('listbox', { name: '视频比例选项', exact: true });
      await expectSingleLineOptions(ratios);
      if (modelAlias === 'minimax-h3') {
        for (const label of ['16:9', '21:9', '摄影横向', '标准横向', '超宽屏'])
          await expect(ratios.getByText(label, { exact: true })).toBeVisible();
      }
      await page.screenshot({ path: testInfo.outputPath('ratios-open.png'), fullPage: true });
      const target = ratios.getByRole('option', {
        name: modelAlias === 'minimax-h3' ? /^21:9/ : /^自动比例/,
      });
      await expectUnobstructed(target);
      await target.click();
      await expect
        .poll(() => fixture.parameters()?.aspectRatio)
        .toBe(modelAlias === 'minimax-h3' ? '21:9' : 'adaptive');
      await panel.getByRole('combobox', { name: /^视频清晰度：/ }).click();
      const resolutions = page.getByRole('listbox', { name: '视频清晰度选项', exact: true });
      await expectSingleLineOptions(resolutions);
      const rows = await resolutions
        .getByRole('option')
        .evaluateAll((options) =>
          options.map((option) => Math.round(option.getBoundingClientRect().y)),
        );
      expect(rows).toHaveLength(3);
      expect(new Set(rows).size).toBe(1);
      await resolutions.getByRole('option', { name: /^1080p/i }).click();
      await expect.poll(() => fixture.parameters()?.resolution).toBe('1080p');
      await panel.getByRole('combobox', { name: /^视频清晰度：/ }).click();
      await expect(resolutions).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(resolutions).toBeHidden();
      await expect(panel).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(page.getByRole('button', { name: '媒体参数', exact: true })).toBeFocused();
      if (presentation === '完整')
        await expect(page.locator('.node-quick-editor-dialog')).toBeVisible();
      expect(fixture.errors).toEqual([]);
      expect(fixture.requests.filter((request) => request.method === 'POST')).toEqual([]);
    });
  }
}

test('模型长名称保持单列完整换行，不受短枚举排版影响', async ({ page, baseURL }) => {
  const fixture = await installFixture(page, baseURL);
  await page.getByRole('combobox', { name: /^模型：/ }).click();
  const models = page.getByRole('listbox', { name: '模型选项', exact: true });
  const option = models.getByRole('option', { name: new RegExp(`^${longModelName}`) });
  const label = option.locator('strong');
  await expect(label).toHaveText(longModelName);
  const layout = await label.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      lines: range.getClientRects().length,
      clipped: element.scrollWidth > element.clientWidth + 1,
    };
  });
  expect(layout.lines).toBeGreaterThan(1);
  expect(layout.clipped).toBe(false);
  expect(fixture.errors).toEqual([]);
  expect(fixture.requests.filter((request) => request.method === 'POST')).toEqual([]);
});
