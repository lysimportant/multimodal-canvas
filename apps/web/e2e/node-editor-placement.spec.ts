import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  canvasDocumentSchema,
  renderPromptDocument,
  type Asset,
  type PromptDocument,
} from '@multimodal-canvas/domain';

/** 合成项目只存在于浏览器路由内，画布保存不会访问用户项目。 */
const project = {
  id: 'node-editor-placement-browser',
  name: '输入面板布局回归',
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};
/** 使用仓库已有图片提供引用预览，不下载外部媒体。 */
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
/** 首行使用可预测字符，真实点击和拖选不能被手动 focus 或设置 selectionRange 代替。 */
const firstLine = '0123456789 abcdefghijklmnopqrstuvwxyz';
/** 所有测试都操作同一个合成节点，不通过生产接口创建节点。 */
const nodeSelector = '.react-flow__node[data-id="placement-node"]';

test.use({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });

/** 返回合成 JSON；未声明的请求不能借此放行到后端。 */
async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * 安装现有资源提及 E2E 使用的登录、模型、资源及内存画布合同。
 * longPrompt 为 true 时提供多行提示词和结构化图片引用，制造真实 textarea 溢出。
 * height 是合成节点的画布高度；较高节点用于产生真实的父面板滚动区域。
 * @returns 页面错误及 API 请求记录；所有未知网络请求均阻断并记录。
 */
async function installFixture(
  page: Page,
  baseURL: string | undefined,
  { longPrompt = false, height = 120 } = {},
) {
  if (!baseURL) throw new Error('缺少隔离的 Playwright baseURL');
  const webOrigin = new URL(baseURL).origin;
  const errors: string[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  const assets: Asset[] = [
    {
      id: 'placement-reference',
      name: '布局参考图',
      mediaType: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: poster.byteLength,
      status: 'ready',
      latestVersion: 1,
      tags: [],
      contentUrl: '/v1/assets/placement-reference/versions/1/content',
    },
  ];
  const promptDocument: PromptDocument = {
    version: 1,
    blocks: longPrompt
      ? [
          { type: 'text', text: `${firstLine}\nReference: ` },
          {
            type: 'mention',
            mentionId: 'placement-image-mention',
            assetId: 'placement-reference',
            assetVersion: 1,
            label: '布局参考图',
            mediaType: 'image',
          },
          {
            type: 'text',
            text:
              '\n' +
              Array.from(
                { length: 80 },
                (_, index) => `Line ${index + 1}: preserve the scene composition and soft light.`,
              ).join('\n'),
          },
        ]
      : [{ type: 'text', text: 'A quiet room with soft daylight.' }],
  };
  let canvas = canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: 'placement-node',
        type: 'image',
        position: { x: 390, y: 220 },
        width: 320,
        height,
        data: {
          label: '输入面板验收节点',
          mediaType: 'image',
          mode: 'generate',
          enabled: true,
          modelAlias: 'mock-image',
          credentialId: 'synthetic-placement-credential',
          prompt: renderPromptDocument(promptDocument),
          promptDocument,
        },
      },
    ],
    edges: [],
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        user: {
          id: 'placement-user',
          email: 'placement@example.test',
          role: 'user',
          createdAt: '2026-09-27T00:00:00.000Z',
        },
      }),
    );
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
        !['fetch', 'xhr', 'eventsource'].includes(request.resourceType())
      )
        return route.continue();
      errors.push(`已阻断未声明网络请求：${method} ${url.origin}${path}`);
      return route.abort('blockedbyclient');
    }
    requests.push({ method, path });
    if (method === 'GET' && path === '/v1/auth/me')
      return json(route, {
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'placement-user',
          email: 'placement@example.test',
          role: 'user',
          createdAt: project.createdAt,
        },
      });
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
    if (method === 'GET' && path === '/v1/models')
      return json(route, {
        models: [
          {
            id: 'mock-image',
            name: 'Mock Image',
            mediaTypes: ['image'],
            mentionMediaTypes: ['image'],
            group: 'synthetic',
            credentialId: 'synthetic-placement-credential',
            available: true,
          },
        ],
      });
    if (method === 'GET' && path === '/v1/assets') return json(route, { assets });
    if (method === 'POST' && path === '/v1/assets/placement-reference/access-url')
      return json(route, { url: assets[0].contentUrl });
    if (
      method === 'GET' &&
      (path === assets[0].contentUrl ||
        path === '/v1/assets/placement-reference/versions/1/derivatives/thumbnail')
    )
      return route.fulfill({ contentType: 'image/jpeg', body: poster });
    // 特意不声明生成入口；即使错误点击生成，也只会失败，不会付费。
    errors.push(`未声明的 Mock 接口：${method} ${path}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`/projects/${project.id}`);
  await expect(page.locator(nodeSelector)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => canvasZoom(page)).toBeCloseTo(1.1, 3);
  return { errors, requests };
}

/** 读取真实 React Flow 矩阵，不写入 transform 或内部 store。 */
async function canvasZoom(page: Page) {
  return page
    .locator('.react-flow__viewport')
    .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
}

/** 按 React Flow 的滚轮公式设定画布倍率，不直接写入视口矩阵或内部状态。 */
async function zoomCanvas(page: Page, target: number) {
  const box = (await page.locator(nodeSelector).boundingBox())!;
  const current = await canvasZoom(page);
  await page.locator('.react-flow__pane').dispatchEvent('wheel', {
    deltaY: -Math.log2(target / current) / 0.002,
    deltaMode: 0,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
    bubbles: true,
    cancelable: true,
  });
  await expect.poll(() => canvasZoom(page)).toBeCloseTo(target, 3);
}

/** 用节点可见中心打开编辑器，不对输入框执行任何预先聚焦或自动滚动。 */
async function openEditor(page: Page) {
  const box = (await page.locator(nodeSelector).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const overlay = page.locator('.quick-editor-overlay');
  await expect(overlay).toBeVisible();
  const textarea = overlay.getByRole('textbox', { name: '提示词', exact: true });
  await expect(textarea).toBeVisible();
  await samplePanel(page, 3);
  return { overlay, editor: overlay.locator('.node-quick-editor'), textarea };
}

/** 读取面板及输入框的屏幕几何；采样不触发 scrollIntoView、focus 或 DOM 样式修改。 */
async function samplePanel(page: Page, frames = 1) {
  return page.locator('.quick-editor-overlay').evaluate(async (element, count) => {
    const overlay = element as HTMLElement;
    const editor = overlay.querySelector<HTMLElement>('.node-quick-editor')!;
    const textarea = editor.querySelector<HTMLTextAreaElement>('textarea')!;
    const rect = (target: HTMLElement) => {
      const { x, y, width, height } = target.getBoundingClientRect();
      return { x, y, width, height };
    };
    const read = () => ({
      overlay: rect(overlay),
      editor: rect(editor),
      textarea: rect(textarea),
      placement: overlay.dataset.placement,
      transform: overlay.style.transform,
      maxHeight: Number.parseFloat(overlay.style.getPropertyValue('--quick-editor-max-height')),
      editorScrollTop: editor.scrollTop,
      editorScrollHeight: editor.scrollHeight,
      editorClientHeight: editor.clientHeight,
      editorScrollWidth: editor.scrollWidth,
      editorClientWidth: editor.clientWidth,
      textareaScrollTop: textarea.scrollTop,
      textareaScrollHeight: textarea.scrollHeight,
      textareaClientHeight: textarea.clientHeight,
    });
    const samples: ReturnType<typeof read>[] = [];
    for (let frame = 0; frame < count; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(read());
    }
    return samples;
  }, frames);
}

/** 允许 CSS 亚像素取整，但不能容忍可见的坐标、尺寸、方向或父滚动变化。 */
function expectStationary(
  before: Awaited<ReturnType<typeof samplePanel>>[number],
  after: Awaited<ReturnType<typeof samplePanel>>[number],
) {
  for (const target of ['overlay', 'textarea'] as const)
    for (const field of ['x', 'y', 'width', 'height'] as const)
      expect(
        Math.abs(after[target][field] - before[target][field]),
        `${target}.${field}`,
      ).toBeLessThan(1);
  expect(after.placement).toBe(before.placement);
  expect(after.transform).toBe(before.transform);
  expect(after.editorScrollTop).toBe(before.editorScrollTop);
  expect(after.editorScrollHeight).toBe(before.editorScrollHeight);
}

/**
 * 取真实高亮文本第 offset 个字符内靠左的可见点击点，不创建可能影响滚动的镜像。
 * 命中校验同时排除父面板裁剪、资源浮层遮挡和画布外坐标；不可见时直接失败。
 */
async function visibleCharacterPoint(textarea: Locator, offset: number) {
  return textarea.evaluate((element, index) => {
    const input = element as HTMLTextAreaElement;
    const highlight = input.parentElement!.querySelector('.resource-mention-highlight')!;
    const walker = document.createTreeWalker(highlight, NodeFilter.SHOW_TEXT);
    let remaining = index;
    let text = walker.nextNode();
    while (text && remaining >= (text.textContent?.length ?? 0)) {
      remaining -= text.textContent?.length ?? 0;
      text = walker.nextNode();
    }
    if (!text) throw new Error(`提示词缺少字符 ${index}`);
    const range = document.createRange();
    range.setStart(text, remaining);
    range.setEnd(text, remaining + 1);
    const rect = range.getBoundingClientRect();
    const point = { x: rect.left + rect.width * 0.2, y: rect.top + rect.height / 2 };
    if (document.elementFromPoint(point.x, point.y) !== input)
      throw new Error(`字符 ${index} 不在输入框实际可点击区域：${JSON.stringify(point)}`);
    return point;
  }, offset);
}

/**
 * 从可见工具栏或预览空白处拖动，越过激活阈值后返回屏幕坐标；调用方必须释放鼠标。
 * React Flow 从激活帧而非 mousedown 帧计算位移，不能把第一步激活距离计入节点移动。
 */
async function startNodeDrag(page: Page) {
  const node = page.locator(nodeSelector);
  // 触边时浮层可能遮住工具栏或部分预览，只使用真实可命中的入口。
  const anchor = await node.evaluate((element) => {
    for (const target of [
      element.querySelector('.flow-node-drag-handle'),
      element.querySelector('.flow-node-placeholder'),
    ]) {
      if (!target) continue;
      const box = target.getBoundingClientRect();
      for (const fraction of [0.5, 0.15, 0.85]) {
        const point = { x: box.x + box.width / 2, y: box.y + box.height * fraction };
        if (target.contains(document.elementFromPoint(point.x, point.y))) return point;
      }
    }
    throw new Error('节点没有可命中的拖动入口');
  });
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.down();
  anchor.x += 6;
  await page.mouse.move(anchor.x, anchor.y);
  anchor.x += 1;
  await page.mouse.move(anchor.x, anchor.y);
  await expect(page.locator('.canvas-area')).toHaveClass(/is-node-dragging/);
  return { node, anchor, from: (await node.boundingBox())! };
}

/** 使用真实鼠标拖动，把节点左上角移到屏幕坐标，不注入几何或 React 状态。 */
async function moveNode(page: Page, x: number, y: number) {
  const { node, anchor, from } = await startNodeDrag(page);
  try {
    await page.mouse.move(anchor.x + x - from.x, anchor.y + y - from.y, { steps: 16 });
  } finally {
    await page.mouse.up();
  }
  // 缩放后的鼠标坐标会取整，允许最多一个 CSS 像素的落点误差。
  await expect.poll(async () => Math.abs((await node.boundingBox())!.y - y)).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs((await node.boundingBox())!.x - x)).toBeLessThanOrEqual(1);
  await samplePanel(page, 3);
}

/** 验收必须没有页面错误、未知请求和生成 POST，即使测试只做光标或滚动操作。 */
function expectIsolated(fixture: Awaited<ReturnType<typeof installFixture>>) {
  expect(fixture.errors).toEqual([]);
  expect(
    fixture.requests.filter(({ method, path }) => method === 'POST' && /\/runs$/.test(path)),
  ).toEqual([]);
}

test('PC 左右边缘和上下空间不足时只使用 above/below', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1600, height: 800 });
  const fixture = await installFixture(page, baseURL, { height: 240 });
  await zoomCanvas(page, 1.5);
  const { overlay } = await openEditor(page);
  const canvas = (await page.locator('.canvas-area').boundingBox())!;
  const node = (await page.locator(nodeSelector).boundingBox())!;
  const middle = canvas.y + (canvas.height - node.height) / 2;
  for (const x of [canvas.x + 30, canvas.x + canvas.width - node.width - 30]) {
    await moveNode(page, x, middle);
    // 重新选择覆盖初次择位，而不只检查已有上下方向的惯性。
    await page.mouse.click(canvas.x + canvas.width - 16, canvas.y + 80);
    await expect(overlay).toHaveCount(0);
    await openEditor(page);
    for (const state of await samplePanel(page, 3)) {
      expect(state.placement).toMatch(/^(above|below)$/);
      expect(state.overlay.x).toBeGreaterThanOrEqual(canvas.x + 7);
      expect(state.overlay.x + state.overlay.width).toBeLessThanOrEqual(
        canvas.x + canvas.width - 7,
      );
      expect(state.overlay.y).toBeGreaterThanOrEqual(canvas.y + 7);
      expect(state.overlay.y + state.overlay.height).toBeLessThanOrEqual(
        canvas.y + canvas.height - 7,
      );
    }
  }
  expectIsolated(fixture);
});

for (const releaseOutside of [false, true]) {
  test(`拖动时隐藏输入框，${releaseOutside ? '画布外' : '画布内'}松手恢复原草稿和光标`, async ({
    page,
    baseURL,
  }) => {
    const fixture = await installFixture(page, baseURL);
    await zoomCanvas(page, 1);
    const { overlay, textarea } = await openEditor(page);
    const draft = 'A pending prompt draft 🙂 keep the same input.';
    await textarea.fill(draft);
    await textarea.press('Home');
    await textarea.press('Shift+ArrowRight');
    // 选中文字会打开引用选择器，先按正常交互关闭，避免遮挡拖动起点。
    await textarea.press('Escape');
    await expect(page.locator('.resource-mention-picker')).toBeHidden();
    const originalInput = await textarea.elementHandle();
    const selection = await textarea.evaluate((input: HTMLTextAreaElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]);
    const node = page.locator(nodeSelector);
    const size = await node.evaluate((element: HTMLElement) => [
      element.offsetWidth,
      element.offsetHeight,
    ]);
    const before = await node.getAttribute('style');
    const { anchor } = await startNodeDrag(page);
    try {
      await page.mouse.move(anchor.x + 70, anchor.y + 35, { steps: 12 });
      await expect(overlay).toHaveAttribute('inert', '');
      expect(await originalInput!.evaluate((input) => input.isConnected)).toBe(true);
      await expect(overlay).toBeHidden();
      await expect(node).not.toHaveAttribute('style', before!);
      if (releaseOutside) await page.mouse.move(-5, -5, { steps: 12 });
    } finally {
      await page.mouse.up();
    }
    await expect(overlay).toBeVisible();
    await expect(overlay).not.toHaveAttribute('inert');
    await expect(textarea).toHaveValue(draft);
    expect(await textarea.evaluate((input, original) => input === original, originalInput)).toBe(
      true,
    );
    expect(
      await textarea.evaluate((input: HTMLTextAreaElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual(selection);
    expect(
      await node.evaluate((element: HTMLElement) => [element.offsetWidth, element.offsetHeight]),
    ).toEqual(size);
    await originalInput?.dispose();
    expectIsolated(fixture);
  });
}

for (const direction of ['below', 'above'] as const) {
  test(`PC ${direction} 拖动时隐藏，松手后按触边距离换边且反向微动不回切`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1200 });
    const fixture = await installFixture(page, baseURL);
    await zoomCanvas(page, 1);
    const { overlay } = await openEditor(page);
    const canvas = (await page.locator('.canvas-area').boundingBox())!;
    const node = page.locator(nodeSelector);
    const initial = (await node.boundingBox())!;
    const topbar = (await page.locator('.topbar').boundingBox())!;
    // 画布铺满窗口，但输入面板的上边界还须避开覆盖在画布上的顶栏。
    const bounds = {
      top: Math.max(canvas.y, topbar.y + topbar.height) + 8,
      bottom: canvas.y + canvas.height - 8,
    };
    const startTop = direction === 'below' ? bounds.top + 110 : bounds.bottom - initial.height - 45;
    await moveNode(page, initial.x, startTop);
    await expect(overlay).toHaveAttribute('data-placement', direction);
    const before = (await samplePanel(page, 3)).at(-1)!;
    const from = (await node.boundingBox())!;
    const outward = direction === 'below' ? 1 : -1;
    const contactTop =
      direction === 'below'
        ? bounds.bottom - before.maxHeight - 16 - from.height
        : bounds.top + 64 + before.maxHeight;
    const threshold = from.height * 0.75;
    // 隐藏期间不再逐帧定位；每次松手测量仍保留 75% 换边阈值与反向滞后。
    const offsets = [
      -24,
      -2,
      0,
      threshold - 2,
      threshold,
      threshold + 2,
      threshold - 1,
      threshold + 1,
    ];
    for (const [step, offset] of offsets.entries()) {
      const top = contactTop + offset * outward;
      const drag = await startNodeDrag(page);
      try {
        await page.mouse.move(drag.anchor.x, drag.anchor.y + top - drag.from.y, { steps: 8 });
        await expect(overlay).toBeHidden();
      } finally {
        await page.mouse.up();
      }
      await expect(overlay).toBeVisible();
      await expect.poll(async () => Math.abs((await node.boundingBox())!.y - top)).toBeLessThan(1);
      const expected = step >= 5 ? (direction === 'below' ? 'above' : 'below') : direction;
      await expect(overlay).toHaveAttribute('data-placement', expected);
      const state = (await samplePanel(page, 2)).at(-1)!;
      expect(Math.abs(state.overlay.height - before.overlay.height)).toBeLessThan(1);
      expect(state.overlay.y).toBeGreaterThanOrEqual(bounds.top - 1);
      expect(state.overlay.y + state.overlay.height).toBeLessThanOrEqual(bounds.bottom + 1);
      if (step === 2) {
        const edge =
          direction === 'below' ? state.overlay.y + state.overlay.height : state.overlay.y;
        expect(Math.abs(edge - (direction === 'below' ? bounds.bottom : bounds.top))).toBeLessThan(
          2,
        );
      }
    }
    expectIsolated(fixture);
  });
}

test('1.5 倍长提示词和引用资源：真实可见点击聚焦前后几何与父滚动不变', async ({
  page,
  baseURL,
}) => {
  const fixture = await installFixture(page, baseURL, { longPrompt: true, height: 240 });
  await zoomCanvas(page, 1.5);
  const { editor, textarea } = await openEditor(page);
  const reference = editor.locator(
    '.resource-mention-thumb[data-mention-id="placement-image-mention"]',
  );
  await expect(reference).toHaveCount(1);
  await expect
    .poll(() => reference.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(textarea).not.toBeFocused();
  const point = await visibleCharacterPoint(textarea, 8);
  const before = (await samplePanel(page, 3)).at(-1)!;
  expect(before.textareaScrollHeight).toBeGreaterThan(before.textareaClientHeight * 5);
  await page.mouse.click(point.x, point.y);
  await expect(textarea).toBeFocused();
  expect(
    await textarea.evaluate((input: HTMLTextAreaElement) => input.selectionStart),
  ).toBeGreaterThan(0);
  // 连续采样超过短时滚动补偿窗口，不能只断言 click 同一轮的 inline style。
  const samples = await samplePanel(page, 40);
  await test.info().attach('focus-geometry.json', {
    body: JSON.stringify({ before, samples }, null, 2),
    contentType: 'application/json',
  });
  for (const after of samples) expectStationary(before, after);
  expectIsolated(fixture);
});

test('1.5 倍首次鼠标点击按可见字符放置光标，拖选保持原生选区', async ({ page, baseURL }) => {
  const fixture = await installFixture(page, baseURL, { longPrompt: true, height: 240 });
  await zoomCanvas(page, 1.5);
  const { textarea } = await openEditor(page);
  await expect(textarea).not.toBeFocused();
  const point = await visibleCharacterPoint(textarea, 8);
  await page.mouse.click(point.x, point.y);
  await expect(textarea).toBeFocused();
  await expect
    .poll(() =>
      textarea.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd]),
    )
    .toEqual([8, 8]);
  const start = await visibleCharacterPoint(textarea, 2);
  const end = await visibleCharacterPoint(textarea, 9);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() =>
      textarea.evaluate((input: HTMLTextAreaElement) =>
        input.value.slice(input.selectionStart, input.selectionEnd),
      ),
    )
    .toBe('2345678');
  await expect(textarea).toBeFocused();
  expectIsolated(fixture);
});

test('1.5 倍保持输入焦点时仍可手动滚动父面板和提示词', async ({ page, baseURL }) => {
  const fixture = await installFixture(page, baseURL, { longPrompt: true, height: 240 });
  await zoomCanvas(page, 1.5);
  const { editor, textarea } = await openEditor(page);
  const point = await visibleCharacterPoint(textarea, 8);
  await page.mouse.click(point.x, point.y);
  await expect(textarea).toBeFocused();
  const before = (await samplePanel(page, 3)).at(-1)!;
  expect(before.editorScrollHeight - before.editorClientHeight).toBeGreaterThan(20);
  const gutter = { x: before.editor.x + 6, y: before.editor.y + before.editor.height / 2 };
  expect(
    await editor.evaluate((element, at) => {
      const hit = document.elementFromPoint(at.x, at.y);
      return hit !== null && element.contains(hit) && !hit.closest('textarea,button,input');
    }, gutter),
  ).toBe(true);
  await page.mouse.move(gutter.x, gutter.y);
  await page.mouse.wheel(0, 140);
  await expect
    .poll(() => editor.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before.editorScrollTop + 5);
  for (const state of await samplePanel(page, 25))
    expect(state.editorScrollTop).toBeGreaterThan(before.editorScrollTop + 5);
  await expect(textarea).toBeFocused();
  await page.mouse.wheel(0, -2000);
  await expect.poll(() => editor.evaluate((element) => element.scrollTop)).toBe(0);
  const visible = await visibleCharacterPoint(textarea, 8);
  await page.mouse.move(visible.x, visible.y);
  await page.mouse.wheel(0, 180);
  await expect.poll(() => textarea.evaluate((input) => input.scrollTop)).toBeGreaterThan(20);
  await expect(textarea).toBeFocused();
  expect(await editor.evaluate((element) => element.scrollTop)).toBe(0);
  expectIsolated(fixture);
});

test('1.5 倍长提示词失焦后拖小节点，面板不产生横向溢出', async ({ page, baseURL }) => {
  const fixture = await installFixture(page, baseURL, { longPrompt: true, height: 240 });
  await zoomCanvas(page, 1.5);
  const { overlay, editor, textarea } = await openEditor(page);
  const point = await visibleCharacterPoint(textarea, 8);
  await page.mouse.click(point.x, point.y);
  await expect(textarea).toBeFocused();
  const before = (await samplePanel(page, 3)).at(-1)!;
  const node = page.locator(nodeSelector);
  const nodeBefore = (await node.boundingBox())!;

  // 点击节点本体使提示词失焦但保留面板，缩小过程中不能靠重新聚焦刷新镜像宽度。
  await page.mouse.click(nodeBefore.x + nodeBefore.width / 2, nodeBefore.y + nodeBefore.height / 2);
  await expect(textarea).not.toBeFocused();
  await expect(overlay).toBeVisible();
  const handle = node.locator('.react-flow__resize-control.bottom.right');
  await expect(handle).toBeVisible();
  const grip = (await handle.boundingBox())!;
  const anchor = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  expect(
    await handle.evaluate((element, at) => {
      const hit = document.elementFromPoint(at.x, at.y);
      return hit !== null && element.contains(hit);
    }, anchor),
  ).toBe(true);
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.down();
  try {
    await page.mouse.move(anchor.x - 90, anchor.y, { steps: 12 });
  } finally {
    await page.mouse.up();
  }
  await expect
    .poll(async () => (await node.boundingBox())!.width)
    .toBeLessThan(nodeBefore.width - 60);
  await expect
    .poll(async () => (await overlay.boundingBox())!.width)
    .toBeLessThan(before.overlay.width - 100);
  await expect(textarea).not.toBeFocused();

  const samples = await samplePanel(page, 25);
  const mirror = await editor.evaluate((element) => {
    const mirror = element.querySelector<HTMLElement>('.resource-mention-caret-mirror');
    return (
      mirror && {
        hidden: mirror.hidden,
        display: getComputedStyle(mirror).display,
        width: mirror.style.width,
        height: mirror.style.height,
      }
    );
  });
  await test.info().attach('blur-resize-geometry.json', {
    body: JSON.stringify(
      { before, nodeBefore, nodeAfter: await node.boundingBox(), mirror, samples },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  for (const state of samples)
    expect(state.editorScrollWidth - state.editorClientWidth).toBeLessThanOrEqual(1);
  expectIsolated(fixture);
});

for (const size of [
  { width: 1600, height: 1000 },
  { width: 1280, height: 800 },
]) {
  test(`胶囊新建图片靠上且媒体参数可见 ${size.width}x${size.height}`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize(size);
    const fixture = await installFixture(page, baseURL);
    await page.getByRole('button', { name: '新建图片生成节点', exact: true }).click();
    const node = page.locator('.react-flow__node.selected');
    await expect(node).toHaveCount(1);
    const nodeBounds = (await node.boundingBox())!;
    const canvas = (await page.locator('.canvas-area').boundingBox())!;
    expect(nodeBounds.y - canvas.y).toBeGreaterThanOrEqual(60);
    expect(nodeBounds.y - canvas.y).toBeLessThanOrEqual(100);
    const parameters = page.getByRole('button', { name: '媒体参数', exact: true });
    await expect(parameters).toBeInViewport({ ratio: 0.999 });
    await parameters.click();
    await expect(page.getByRole('region', { name: '生成参数', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('toolbar-node-top.png') });
    expectIsolated(fixture);
  });
}
