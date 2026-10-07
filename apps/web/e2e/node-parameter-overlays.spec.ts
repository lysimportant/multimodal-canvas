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
 * modelAlias 选择视频合同或合成图片模型；mediaType 决定节点与模型目录类型，不请求供应商。
 * initialParameters 可覆盖初始参数，用于区分未设置占位与已保存选择。
 * @returns 错误、请求及当前参数读取器，用于核实交互没有产生任何生成请求。
 */
async function installFixture(
  page: Page,
  baseURL: string | undefined,
  modelAlias = 'wan3.0-video',
  mediaType: 'image' | 'video' = 'video',
  initialParameters?: Record<string, unknown>,
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
        type: mediaType,
        position: { x: 390, y: 220 },
        width: 320,
        height: 180,
        data: {
          label: '参数浮层验收节点',
          mediaType,
          mode: 'generate',
          ...(mediaType === 'video' ? { videoMode: 'text_to_video' } : {}),
          enabled: true,
          modelAlias,
          credentialId: 'synthetic-parameter-credential',
          prompt: 'A quiet room with soft daylight.',
          parameters: initialParameters ?? {
            resolution:
              mediaType === 'image' ? '1k' : modelAlias === 'minimax-h3' ? '768p' : '720p',
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
          /^\/(?:@vite\/|@id\/|@fs\/|@react-refresh$|src\/|node_modules\/|assets\/|brand\/|favicon\.)/.test(
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
            name: '参数回归模型',
            mediaTypes: [mediaType],
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
  await selectParameterNode(page);
  return {
    errors,
    requests,
    parameters: () => canvas.nodes[0]!.data.parameters,
    node: () => canvas.nodes[0]!,
  };
}

/** 选择合成节点并等缩放收敛；刷新回读仍沿用同一内存画布。 */
async function selectParameterNode(page: Page) {
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

/** 短枚举须单行完整显示；自动比例的完整说明允许换行，但不能裁切或省略。 */
async function expectSingleLineOptions(list: Locator, wrappingDescriptions: string[] = []) {
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
  expect(
    measurements.filter(
      (item) =>
        (item.lines !== 1 && !wrappingDescriptions.includes(item.text ?? '')) || item.clipped,
    ),
  ).toEqual([]);
}

/** 用浏览器几何验证两列、固定图标槽及完整文本，不以 CSS 声明代替实际排版。 */
async function expectAspectLayout(list: Locator) {
  await expect(list).toBeInViewport({ ratio: 1 });
  await list.evaluate(async (element) => {
    const popup = element.closest('.node-parameter-aspect-options');
    if (!popup) throw new Error('比例菜单未使用独立浮层');
    await Promise.all(
      popup
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    );
  });
  const listWidth = await list.evaluate((element) => {
    const popup = element.closest('.node-parameter-aspect-options')!;
    const bounds = popup.getBoundingClientRect();
    const style = getComputedStyle(popup);
    const scale = bounds.width / Number.parseFloat(style.width);
    const horizontalInsets =
      Number.parseFloat(style.paddingLeft) +
      Number.parseFloat(style.paddingRight) +
      Number.parseFloat(style.borderLeftWidth) +
      Number.parseFloat(style.borderRightWidth);
    return {
      actual: element.getBoundingClientRect().width,
      expected: bounds.width - horizontalInsets * scale,
    };
  });
  expect(Math.abs(listWidth.actual - listWidth.expected)).toBeLessThanOrEqual(1);
  const options = list.getByRole('option');
  const measurements = await options.evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const scaleX = bounds.width / Number.parseFloat(style.width);
      const scaleY = bounds.height / Number.parseFloat(style.height);
      const icon = element.querySelector('.node-quick-editor-aspect-icon');
      const preview = element.querySelector('.node-quick-editor-aspect-preview');
      const copy = element.querySelector('.node-quick-editor-option-copy');
      const iconBounds = icon?.getBoundingClientRect();
      const previewBounds = preview?.getBoundingClientRect();
      const copyBounds = copy?.getBoundingClientRect();
      const drawing = preview?.querySelector('rect')?.getBoundingClientRect();
      const ratio = /^(\d+):(\d+)$/.exec(element.querySelector('strong')?.textContent ?? '');
      return {
        label: element.textContent,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height / scaleY,
        icon: iconBounds && {
          width: iconBounds.width / scaleX,
          height: iconBounds.height / scaleY,
          right: iconBounds.right,
        },
        previewFits:
          Boolean(iconBounds && previewBounds) &&
          previewBounds!.x >= iconBounds!.x - 1 &&
          previewBounds!.right <= iconBounds!.right + 1 &&
          previewBounds!.y >= iconBounds!.y - 1 &&
          previewBounds!.bottom <= iconBounds!.bottom + 1,
        copy: copyBounds && { left: copyBounds.x - bounds.x, x: copyBounds.x },
        drawingRatio: drawing && drawing.width / drawing.height,
        expectedRatio: ratio ? Number(ratio[1]) / Number(ratio[2]) : undefined,
        clippedText: Array.from(element.querySelectorAll('strong, small')).flatMap((text) => {
          const range = document.createRange();
          range.selectNodeContents(text);
          const rects = Array.from(range.getClientRects());
          return text.scrollWidth > text.clientWidth + 1 ||
            text.scrollHeight > text.clientHeight + 1 ||
            rects.some(
              (rect) =>
                rect.x < bounds.x - 1 ||
                rect.right > bounds.right + 1 ||
                rect.y < bounds.y - 1 ||
                rect.bottom > bounds.bottom + 1,
            )
            ? [text.textContent]
            : [];
        }),
      };
    }),
  );
  expect(measurements.length).toBeGreaterThanOrEqual(6);
  expect(new Set(measurements.map((option) => Math.round(option.x))).size).toBe(2);
  const widths = measurements.map((option) => option.width);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  for (let index = 0; index < measurements.length; index += 2) {
    const left = measurements[index]!;
    const right = measurements[index + 1];
    if (right) {
      expect(right.y).toBeCloseTo(left.y, 0);
      expect(right.x).toBeGreaterThan(left.x + left.width - 1);
    }
    if (index > 0) expect(left.y).toBeGreaterThan(measurements[index - 2]!.y);
  }
  for (const option of measurements) {
    expect(option.height, option.label ?? '').toBeGreaterThanOrEqual(55.9);
    expect(option.icon, option.label ?? '').toBeDefined();
    expect(option.icon!.width).toBeCloseTo(44, 1);
    expect(option.icon!.height).toBeCloseTo(32, 1);
    expect(option.previewFits, option.label ?? '').toBe(true);
    expect(option.copy!.x).toBeGreaterThan(option.icon!.right);
    expect(option.copy!.left).toBeCloseTo(measurements[0]!.copy!.left, 1);
    expect(option.clippedText, option.label ?? '').toEqual([]);
    if (option.expectedRatio !== undefined)
      expect(option.drawingRatio, option.label ?? '').toBeCloseTo(option.expectedRatio, 2);
  }
  await expectSingleLineOptions(list, ['由模型根据提示词和素材决定']);
}

/** 读取选中控件 SVG 的真实矩形尺寸，确认缩小图标槽后仍保留原始横纵比例。 */
async function expectSelectedAspectPreview(field: Locator, horizontal: number, vertical: number) {
  const drawing = field.locator('.node-quick-editor-aspect-preview rect');
  await expect(drawing).toBeVisible();
  const ratio = await drawing.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.width / bounds.height;
  });
  expect(ratio).toBeCloseTo(horizontal / vertical, 2);
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
    test(`${presentation} ${modelAlias} 固定比例与短说明不换行，清晰度仍紧凑排列`, async ({
      page,
      baseURL,
    }, testInfo) => {
      const fixture = await installFixture(page, baseURL, modelAlias);
      const panel = await openParameters(page, presentation);
      await panel.getByRole('combobox', { name: /^视频比例：/ }).click();
      const ratios = page.getByRole('listbox', { name: '视频比例选项', exact: true });
      await expectSingleLineOptions(ratios, ['由模型根据提示词和素材决定']);
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

for (const presentation of ['快捷', '完整'] as const) {
  test(`${presentation}模型列表分组只显示一次，切换模型不触发生成`, async ({
    page,
    baseURL,
  }, info) => {
    const fixture = await installFixture(page, baseURL);
    if (presentation === '完整') {
      await page.getByRole('button', { name: '打开完整编辑器' }).click();
    }
    const trigger = page.getByRole('combobox', { name: /^模型：/ });
    await expect(trigger).toHaveAttribute('aria-label', '模型：参数回归模型 · synthetic');
    await trigger.click();
    const models = page.getByRole('listbox', { name: '模型选项', exact: true });
    await expect(models.getByText('synthetic', { exact: true })).toHaveCount(1);
    await expect(models.getByRole('option')).toHaveCount(2);
    await expect(models.locator('small')).toHaveCount(0);
    const target = models.getByRole('option', { name: `${longModelName} synthetic`, exact: true });
    await page.screenshot({ path: info.outputPath('model-groups.png'), fullPage: true });
    await target.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toHaveAttribute('aria-label', `模型：${longModelName} · synthetic`);
    expect(fixture.errors).toEqual([]);
    expect(fixture.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });
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

for (const width of [1440, 1366]) {
  for (const presentation of ['快捷', '完整'] as const) {
    test(
      width + ' PC ' + presentation + '图片四档像素分辨率等宽，末项换行不拉满',
      async ({ page, baseURL }, info) => {
        await page.setViewportSize({ width, height: 900 });
        const fixture = await installFixture(page, baseURL, 'synthetic-image', 'image');
        const panel = await openParameters(page, presentation);
        await panel.getByRole('combobox', { name: /^图片分辨率：/ }).click();
        const list = page.getByRole('listbox', { name: '图片分辨率选项', exact: true });
        const options = list.getByRole('option');
        await expect(options).toHaveCount(4);
        await expectSingleLineOptions(list);
        const widths = await options.evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().width),
        );
        expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: info.outputPath('image-resolution-four-options.png'),
          animations: 'disabled',
        });
        const largestSize = list.getByRole('option', { name: /^3840\s*×\s*2160/ });
        await expectUnobstructed(largestSize);
        await largestSize.click();
        await expect.poll(() => fixture.parameters()?.size).toBe('3840x2160');
        await expect(panel.getByRole('combobox', { name: /^图片分辨率：/ })).toHaveAccessibleName(
          '图片分辨率：3840 × 2160',
        );
        expect(fixture.errors).toEqual([]);
        expect(fixture.requests.filter((request) => request.method === 'POST')).toEqual([]);
      },
    );
  }
}

test('固定图片模型的比例禁用说明完整换行，灰色图标及键盘保留原参数', async ({
  page,
  baseURL,
}, info) => {
  const fixture = await installFixture(page, baseURL, 'gpt-image-1', 'image', {
    size: '1024x1024',
  });
  const panel = await openParameters(page, '快捷');
  const trigger = panel.getByRole('combobox', { name: '图片比例：1:1', exact: true });
  await trigger.click();
  const ratios = page.getByRole('listbox', { name: '图片比例选项', exact: true });
  const disabled = ratios.getByRole('option', { name: /^9:16/ });
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await disabled.scrollIntoViewIfNeeded();
  const description = disabled.locator('small');
  await expect(description).toHaveText('当前模型不支持此比例对应的像素尺寸');
  await page.locator('.node-parameter-aspect-options:visible').screenshot({
    path: info.outputPath('aspect-disabled-description.png'),
    animations: 'disabled',
  });
  const text = await description.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const option = element.closest('[role="option"]')!.getBoundingClientRect();
    const rects = Array.from(range.getClientRects());
    return {
      lines: rects.length,
      clipped:
        element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1 ||
        rects.some(
          (rect) =>
            rect.x < option.x - 1 ||
            rect.right > option.right + 1 ||
            rect.y < option.y - 1 ||
            rect.bottom > option.bottom + 1,
        ),
    };
  });
  expect(text.lines).toBeGreaterThan(1);
  expect(text.clipped).toBe(false);
  const colors = await disabled.evaluate((element) => ({
    option: getComputedStyle(element).color,
    icon: getComputedStyle(element.querySelector('.node-quick-editor-aspect-preview rect')!).stroke,
  }));
  expect(colors.icon).toBe(colors.option);
  await disabled.click({ force: true });
  await expect(trigger).toHaveAccessibleName('图片比例：1:1');
  await trigger.press('ArrowDown');
  const selected = ratios.getByRole('option', { name: /^1:1/ });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(trigger).toHaveAttribute(
    'aria-activedescendant',
    (await selected.getAttribute('id'))!,
  );
  await trigger.press('Escape');
  await expect(ratios).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(fixture.parameters()).toEqual({ size: '1024x1024' });
  expect(fixture.requests.filter((request) => request.method === 'PATCH')).toEqual([]);
  expect(fixture.errors).toEqual([]);
  expect(fixture.requests.filter((request) => request.method === 'POST')).toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
]) {
  for (const presentation of ['快捷', '完整'] as const) {
    for (const mediaType of ['image', 'video'] as const) {
      const mediaLabel = mediaType === 'image' ? '图片' : '视频';
      test(`${viewport.width}×${viewport.height} ${presentation}${mediaLabel}比例双列左图右文，保存及键盘不改变节点尺寸`, async ({
        page,
        baseURL,
      }, info) => {
        await page.setViewportSize(viewport);
        const fixture = await installFixture(
          page,
          baseURL,
          mediaType === 'image' ? 'synthetic-image' : 'wan3.0-video',
          mediaType,
          {},
        );
        const node = page.locator('.react-flow__node[data-id="parameter-node"]');
        const initialBounds = (await node.boundingBox())!;
        let panel = await openParameters(page, presentation);
        let trigger = panel.getByRole('combobox', { name: new RegExp(`^${mediaLabel}比例：`) });
        let field = panel.locator('.node-parameter-select').filter({
          has: page.getByRole('combobox', { name: new RegExp(`^${mediaLabel}比例：`) }),
        });
        await expect(trigger).toHaveAccessibleName(`${mediaLabel}比例：未设置`);
        await expect(field.getByText('未设置', { exact: true })).toBeVisible();
        await expect(field.locator('.node-quick-editor-aspect-preview')).toHaveCount(0);
        expect(fixture.requests.filter((request) => request.method === 'PATCH')).toEqual([]);
        await trigger.click();
        const ratios = page.getByRole('listbox', { name: `${mediaLabel}比例选项`, exact: true });
        await expectAspectLayout(ratios);
        if (mediaType === 'video') {
          const automatic = ratios.getByRole('option', { name: /^自动比例/ });
          expect(
            await automatic
              .locator('.node-quick-editor-aspect-preview rect')
              .evaluate((element) => getComputedStyle(element).strokeDasharray),
          ).not.toBe('none');
        }
        await page.screenshot({
          path: info.outputPath('aspect-two-columns-open.png'),
          animations: 'disabled',
          fullPage: true,
        });
        const landscape = ratios.getByRole('option', { name: /^16:9/ });
        await expectUnobstructed(landscape);
        await landscape.click();
        await expect(ratios).toBeHidden();
        await expect(trigger).toHaveAccessibleName(`${mediaLabel}比例：16:9`);
        await expect(
          field.locator('.node-parameter-aspect-selection').getByText('16:9', { exact: true }),
        ).toBeVisible();
        await expect(field.locator('.node-quick-editor-aspect-icon')).toHaveCount(1);
        await expectSelectedAspectPreview(field, 16, 9);
        await expect
          .poll(() =>
            mediaType === 'image' ? fixture.parameters()?.size : fixture.parameters()?.aspectRatio,
          )
          .toBe(mediaType === 'image' ? '1024x576' : '16:9');
        await trigger.press('ArrowDown');
        await expect(ratios).toBeVisible();
        await expect(field.locator('.ant-select-content-has-value')).toHaveCSS('opacity', '1');
        await page.screenshot({
          path: info.outputPath('aspect-selected-open.png'),
          animations: 'disabled',
          fullPage: true,
        });
        await page.locator('.node-parameter-aspect-options:visible').screenshot({
          path: info.outputPath('aspect-popup.png'),
          animations: 'disabled',
        });
        await trigger.press('ArrowDown');
        await trigger.press('Enter');
        await expect(ratios).toBeHidden();
        await expect(trigger).toHaveAccessibleName(`${mediaLabel}比例：9:16`);
        await expect
          .poll(() =>
            mediaType === 'image' ? fixture.parameters()?.size : fixture.parameters()?.aspectRatio,
          )
          .toBe(mediaType === 'image' ? '576x1024' : '9:16');
        await trigger.press('ArrowDown');
        await expect(ratios.getByRole('option', { name: /^9:16/ })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await trigger.press('Escape');
        await expect(ratios).toBeHidden();
        await expect(trigger).toBeFocused();
        await expect(panel).toBeVisible();
        await page.reload();
        await selectParameterNode(page);
        panel = await openParameters(page, presentation);
        trigger = panel.getByRole('combobox', { name: `${mediaLabel}比例：9:16`, exact: true });
        field = panel.locator('.node-parameter-select').filter({
          has: page.getByRole('combobox', { name: `${mediaLabel}比例：9:16`, exact: true }),
        });
        await expect(trigger).toBeVisible();
        await expectSelectedAspectPreview(field, 9, 16);
        await page.screenshot({
          path: info.outputPath('aspect-selected-restored.png'),
          animations: 'disabled',
          fullPage: true,
        });
        const updatedBounds = (await node.boundingBox())!;
        expect(updatedBounds.width).toBeCloseTo(initialBounds.width, 2);
        expect(updatedBounds.height).toBeCloseTo(initialBounds.height, 2);
        expect(fixture.node()).toMatchObject({ width: 320, height: 180 });
        expect(fixture.errors).toEqual([]);
        expect(fixture.requests.filter((request) => request.method === 'POST')).toEqual([]);
      });
    }
  }
}
