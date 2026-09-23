import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canvasDocumentSchema, type Asset, type CanvasDocument } from '@multimodal-canvas/domain';

/** 本规格只使用本地媒体和浏览器路由 Mock，不调用真实后端或付费 Provider。 */
const project = {
  id: 'resource-mention-picker-browser',
  name: '资源引用选择器验收',
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
};
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
const video = readFileSync(new URL('../public/demo/field-study.mp4', import.meta.url));
const screenshotPath = fileURLToPath(
  new URL('../../../test-results/resource-mention-picker.png', import.meta.url),
);
const dialogScreenshotPath = fileURLToPath(
  new URL('../../../test-results/resource-mention-picker-dialog.png', import.meta.url),
);

/** 构造完整资源索引项，确保浏览器验收覆盖真实领域字段。 */
function asset(
  id: string,
  name: string,
  mediaType: Asset['mediaType'],
  options: { tags?: string[]; metadata?: Record<string, unknown> } = {},
): Asset {
  const mimeType =
    mediaType === 'image'
      ? 'image/jpeg'
      : mediaType === 'video'
        ? 'video/mp4'
        : mediaType === 'audio'
          ? 'audio/mpeg'
          : 'text/plain';
  return {
    id,
    name,
    mediaType,
    mimeType,
    sizeBytes: mediaType === 'video' ? video.byteLength : poster.byteLength,
    status: 'ready',
    latestVersion: 1,
    contentUrl: `/v1/assets/${id}/versions/1/content`,
    tags: options.tags ?? [],
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

/** 提供足量四类资源，验证右侧结果列表独立滚动。 */
const assets: Asset[] = [
  asset('product-image', '产品图', 'image', { tags: ['电商', '主视觉'] }),
  ...Array.from({ length: 8 }, (_, index) =>
    asset(`scene-image-${index + 1}`, `场景参考图 ${index + 1}`, 'image', {
      tags: ['场景', `序号-${index + 1}`],
    }),
  ),
  asset('product-video', '产品视频', 'video', { tags: ['成片', '横版'] }),
  ...Array.from({ length: 5 }, (_, index) =>
    asset(`motion-video-${index + 1}`, `动作视频 ${index + 1}`, 'video', {
      tags: ['动作', `序号-${index + 1}`],
    }),
  ),
  asset('voice-sample', '声音样本', 'audio', { tags: ['旁白', '普通话'] }),
  ...Array.from({ length: 5 }, (_, index) =>
    asset(`music-audio-${index + 1}`, `配乐素材 ${index + 1}`, 'audio', {
      tags: ['音乐', `序号-${index + 1}`],
    }),
  ),
  asset('interview-script', '采访脚本', 'text', {
    tags: ['采访', '文案'],
    metadata: { alias: '资料文档' },
  }),
  asset('brief-document', '资料文档', 'text', { tags: ['需求', '说明'] }),
  ...Array.from({ length: 4 }, (_, index) =>
    asset(`note-text-${index + 1}`, `文本笔记 ${index + 1}`, 'text', {
      tags: ['笔记', `序号-${index + 1}`],
    }),
  ),
];

/** 初始提示词含同一资源的两处结构化引用，用于删除与撤销回归。 */
function initialCanvas(): CanvasDocument {
  return canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: 'resource-mention-node',
        type: 'image',
        position: { x: 390, y: 210 },
        width: 320,
        height: 240,
        data: {
          label: '资源引用节点',
          mediaType: 'image',
          mode: 'generate',
          enabled: true,
          modelAlias: 'mock-image',
          promptDocument: {
            version: 1,
            blocks: [
              { type: 'text', text: '开场 ' },
              {
                type: 'mention',
                mentionId: 'product-reference-first',
                assetId: 'product-image',
                assetVersion: 1,
                label: '产品图',
                mediaType: 'image',
              },
              { type: 'text', text: ' 转场 ' },
              {
                type: 'mention',
                mentionId: 'product-reference-second',
                assetId: 'product-image',
                assetVersion: 1,
                label: '产品图',
                mediaType: 'image',
              },
              { type: 'text', text: ' 收尾' },
            ],
          },
        },
      },
    ],
    edges: [],
  });
}

/** 以 JSON 返回浏览器 Mock，避免测试命中任何真实 API。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 安装项目、资源、模型及画布离线 Mock，并记录浏览器异常。 */
async function installFixture(page: Page) {
  let canvas = initialCanvas();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-resource-mention-browser',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'resource-mention-user',
          email: 'resource-mention@example.test',
          role: 'user',
          createdAt: '2026-09-23T00:00:00.000Z',
        },
      }),
    );
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/v1/auth/me')
      return json(route, {
        user: {
          id: 'resource-mention-user',
          email: 'resource-mention@example.test',
          role: 'user',
          createdAt: '2026-09-23T00:00:00.000Z',
        },
      });
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path === `/v1/projects/${project.id}/canvas`) {
      if (method === 'PATCH') {
        canvas = canvasDocumentSchema.parse({
          ...request.postDataJSON(),
          revision: canvas.revision + 1,
        });
      }
      return json(route, { canvas });
    }
    if (path === `/v1/projects/${project.id}/models/defaults`)
      return json(route, { defaults: {}, resolvedDefaults: {} });
    if (path === `/v1/projects/${project.id}/runs`) return json(route, { runs: [] });
    if (path === '/v1/assets') return json(route, { assets });
    if (path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (path === '/v1/settings/ai')
      return json(route, {
        settings: { defaultModels: { image: 'mock-image' }, timeoutMs: 900_000 },
        resolvedDefaults: { image: 'mock-image' },
      });
    if (path === '/v1/models')
      return json(route, {
        models: ['text', 'image', 'video', 'audio'].map((mediaType) => ({
          id: `mock-${mediaType}`,
          name: `Mock ${mediaType}`,
          mediaTypes: [mediaType],
          group: 'alpha',
          credentialId: 'resource-mention-credential',
          available: true,
        })),
      });
    const accessMatch = path.match(/^\/v1\/assets\/([^/]+)\/access-url$/);
    if (accessMatch) {
      const id = decodeURIComponent(accessMatch[1]);
      return json(route, { url: `/v1/assets/${id}/versions/1/content` });
    }
    const contentMatch = path.match(/^\/v1\/assets\/([^/]+)\/versions\/1\/content$/);
    if (contentMatch) {
      const entry = assets.find(
        (candidate) => candidate.id === decodeURIComponent(contentMatch[1]),
      );
      if (!entry) return route.fulfill({ status: 404, body: '资源不存在' });
      if (entry.mediaType === 'text')
        return route.fulfill({ contentType: 'text/plain', body: `${entry.name} 的本地测试内容。` });
      return route.fulfill({
        contentType: entry.mimeType,
        body: entry.mediaType === 'video' ? video : poster,
      });
    }
    if (path.endsWith('/reverse-prompts')) return json(route, { analysis: null });
    if (path.includes('/request-prompts')) return json(route, { records: [] });
    errors.push(`未声明的 Mock 接口：${method} ${path}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return { errors, canvas: () => canvas };
}

/** 通过 PC 画布节点的真实入口打开紧凑编辑器。 */
async function openQuickEditor(page: Page) {
  const node = page.locator('.react-flow__node[data-id="resource-mention-node"]');
  await expect(node).toBeVisible();
  await node.getByText('尚未生成', { exact: true }).click();
  const editor = page.locator('.node-quick-editor');
  await expect(editor).toBeVisible();
  return { node, editor };
}

/** 读取提示词中当前光标前一个字符的实际矩形，用于验证 picker 贴近 @。 */
async function caretCharacterRect(textarea: Locator) {
  return textarea.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    const highlight = input.previousElementSibling as HTMLElement | null;
    if (!highlight) throw new Error('缺少提示词高亮层');
    const offset = Math.max(0, (input.selectionStart ?? 1) - 1);
    const walker = document.createTreeWalker(highlight, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      if (remaining < length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, Math.min(length, remaining + 1));
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }
      remaining -= length;
      node = walker.nextNode();
    }
    const rect = input.getBoundingClientRect();
    return { left: rect.left, right: rect.left, top: rect.top, bottom: rect.top };
  });
}

/** 将原生 textarea 光标放进指定次序的资源名称。 */
async function placeCaretInside(textarea: Locator, name: string, occurrence: number) {
  await textarea.evaluate(
    (element, target) => {
      const input = element as HTMLTextAreaElement;
      let index = -1;
      let from = 0;
      for (let current = 0; current <= target.occurrence; current += 1) {
        index = input.value.indexOf(target.name, from);
        if (index < 0) throw new Error(`找不到第 ${target.occurrence + 1} 处 ${target.name}`);
        from = index + target.name.length;
      }
      input.focus();
      input.setSelectionRange(index + 1, index + 1);
    },
    { name, occurrence },
  );
}

/** 比较节点外框，确保 portal 内容不会反向撑大 React Flow 节点。 */
function expectSameNodeSize(
  before: { width: number; height: number },
  after: { width: number; height: number },
) {
  expect(after.width).toBeCloseTo(before.width, 0);
  expect(after.height).toBeCloseTo(before.height, 0);
}

/** 统计字符串中的非重叠资源名称次数。 */
function occurrenceCount(value: string, name: string) {
  return value.split(name).length - 1;
}

test('1440 PC 节点 picker 贴近 @、独立搜索筛选滚动，并支持原子删除与撤销', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page);
  await page.goto(`/projects/${project.id}`);
  const { node, editor } = await openQuickEditor(page);
  const prompt = editor.getByRole('textbox', { name: '提示词' });
  const nodeBefore = await node.boundingBox();
  expect(nodeBefore).not.toBeNull();
  const initialPrompt = await prompt.inputValue();

  await prompt.press('End');
  await prompt.type(' @');
  const picker = page.locator('.resource-mention-picker');
  const searchbox = page.getByRole('searchbox', { name: '搜索资源' });
  const listbox = page.getByRole('listbox', { name: '选择资源' });
  await expect(picker).toBeVisible();
  await expect(searchbox).toBeVisible();
  await expect(listbox).toBeVisible();
  expect(await picker.evaluate((element) => element.parentElement === document.body)).toBe(true);
  await expect(picker).toHaveCSS('position', 'fixed');

  const promptBox = await prompt.boundingBox();
  const pickerBox = await picker.boundingBox();
  const caretBox = await caretCharacterRect(prompt);
  expect(promptBox).not.toBeNull();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox!.width).toBeCloseTo(420, 0);
  expect(pickerBox!.height).toBeLessThanOrEqual(320);
  expect(pickerBox!.x).toBeGreaterThanOrEqual(8);
  expect(pickerBox!.y).toBeGreaterThanOrEqual(8);
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(1432);
  expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(892);
  expect(pickerBox!.y).toBeLessThan(promptBox!.y + promptBox!.height);
  const horizontalGap = Math.min(
    Math.abs(pickerBox!.x - caretBox.right),
    Math.abs(pickerBox!.x + pickerBox!.width - caretBox.left),
  );
  expect(horizontalGap).toBeLessThanOrEqual(16);
  expect(Math.abs(pickerBox!.y - caretBox.top)).toBeLessThanOrEqual(20);
  const nodeWithPicker = await node.boundingBox();
  expect(nodeWithPicker).not.toBeNull();
  expectSameNodeSize(nodeBefore!, nodeWithPicker!);

  const filterNames = ['全部', '图片', '视频', '音频', '文本'] as const;
  const filterBoxes = [];
  for (const name of filterNames) {
    const filter = picker.getByRole('button', { name, exact: true });
    await expect(filter).toHaveAttribute('aria-pressed');
    filterBoxes.push((await filter.boundingBox())!);
  }
  await expect(picker.getByRole('button', { name: '全部', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  for (let index = 1; index < filterBoxes.length; index += 1) {
    expect(filterBoxes[index].y).toBeGreaterThan(filterBoxes[index - 1].y);
    expect(filterBoxes[index].x).toBeCloseTo(filterBoxes[0].x, 0);
  }
  const filtersBox = await picker.locator('.resource-mention-filters').boundingBox();
  const resultsBox = await listbox.boundingBox();
  expect(resultsBox!.x).toBeGreaterThanOrEqual(filtersBox!.x + filtersBox!.width - 1);

  await searchbox.fill('采访');
  await expect(prompt).toHaveValue(`${initialPrompt} @`);
  await expect(listbox.getByRole('option', { name: /采访脚本/ })).toBeVisible();
  await expect(listbox.getByRole('option', { name: /产品图/ })).toHaveCount(0);
  mkdirSync(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, animations: 'disabled' });

  await searchbox.fill('');
  await picker.getByRole('button', { name: '视频', exact: true }).click();
  await expect(picker.getByRole('button', { name: '视频', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(listbox.getByRole('option', { name: /产品视频/ })).toBeVisible();
  await expect(listbox.getByRole('option', { name: /产品图/ })).toHaveCount(0);
  await expect(prompt).toHaveValue(`${initialPrompt} @`);

  await picker.getByRole('button', { name: '全部', exact: true }).click();
  await expect(listbox.getByRole('option')).toHaveCount(assets.length);
  await page.screenshot({
    path: screenshotPath.replace('.png', '-all-resources.png'),
    animations: 'disabled',
  });
  const filterScrollBefore = await picker
    .locator('.resource-mention-filters')
    .evaluate((element) => element.scrollTop);
  const resultScroll = await listbox.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      top: element.scrollTop,
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
    };
  });
  expect(resultScroll.contentHeight).toBeGreaterThan(resultScroll.height);
  expect(resultScroll.top).toBeGreaterThan(0);
  expect(
    await picker.locator('.resource-mention-filters').evaluate((element) => element.scrollTop),
  ).toBe(filterScrollBefore);

  await searchbox.fill('声音样本');
  await searchbox.press('ArrowDown');
  await searchbox.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(prompt).toHaveValue(`${initialPrompt} 声音样本`);
  await expect(editor.getByRole('button', { name: '删除 声音样本' })).toBeVisible();

  await placeCaretInside(prompt, '产品图', 0);
  await prompt.press('Backspace');
  expect(occurrenceCount(await prompt.inputValue(), '产品图')).toBe(1);
  await expect(editor.getByRole('button', { name: '删除 产品图' })).toBeVisible();

  await placeCaretInside(prompt, '产品图', 0);
  await prompt.press('Delete');
  expect(occurrenceCount(await prompt.inputValue(), '产品图')).toBe(0);
  await expect(editor.getByRole('button', { name: '删除 产品图' })).toHaveCount(0);

  await prompt.press('Control+z');
  expect(occurrenceCount(await prompt.inputValue(), '产品图')).toBe(1);
  await expect(editor.getByRole('button', { name: '删除 产品图' })).toBeVisible();
  const nodeAfter = await node.boundingBox();
  expect(nodeAfter).not.toBeNull();
  expectSameNodeSize(nodeBefore!, nodeAfter!);
  expect(fixture.errors).toEqual([]);
});

test('1024 PC 放大 Dialog 的顶层 picker 保持搜索焦点、可选中且 Escape 不关闭模态框', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const fixture = await installFixture(page);
  await page.goto(`/projects/${project.id}`);
  const { node, editor } = await openQuickEditor(page);
  const nodeBefore = await node.boundingBox();
  expect(nodeBefore).not.toBeNull();
  await editor.getByRole('button', { name: '打开完整编辑器' }).click();

  const dialog = page.getByRole('dialog', { name: '资源引用节点 · 编辑设置' });
  await expect(dialog).toBeVisible();
  const prompt = dialog.getByRole('textbox', { name: '提示词' });
  await expect(prompt).toBeFocused();
  const original = await prompt.inputValue();
  await prompt.press('End');
  await prompt.type(' @');

  const picker = dialog.locator('.resource-mention-picker');
  const searchbox = picker.getByRole('searchbox', { name: '搜索资源' });
  const listbox = picker.getByRole('listbox', { name: '选择资源' });
  await expect(picker).toBeVisible();
  await expect(picker).toHaveAttribute('popover', 'manual');
  expect(await picker.evaluate((element) => element.matches(':popover-open'))).toBe(true);
  expect(await picker.evaluate((element) => element.closest('[role="dialog"]') !== null)).toBe(
    true,
  );
  await searchbox.click();
  await expect(searchbox).toBeFocused();
  await searchbox.fill('需求');
  await expect(searchbox).toBeFocused();
  await expect(prompt).toHaveValue(`${original} @`);
  await expect(listbox.getByRole('option', { name: /资料文档/ })).toBeVisible();
  await expect(listbox.getByRole('option')).toHaveCount(1);

  const pickerBox = await picker.boundingBox();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox!.width).toBeCloseTo(420, 0);
  expect(pickerBox!.height).toBeLessThanOrEqual(320);
  expect(pickerBox!.x).toBeGreaterThanOrEqual(8);
  expect(pickerBox!.y).toBeGreaterThanOrEqual(8);
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(1016);
  expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(760);
  mkdirSync(dirname(dialogScreenshotPath), { recursive: true });
  await page.screenshot({ path: dialogScreenshotPath, animations: 'disabled' });

  await searchbox.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(picker).toHaveCount(0);
  await expect(prompt).toHaveValue(`${original} 资料文档`);
  await expect(prompt).toBeFocused();

  await prompt.press('End');
  await prompt.type(' @');
  const reopenedPicker = dialog.locator('.resource-mention-picker');
  const reopenedSearchbox = reopenedPicker.getByRole('searchbox', { name: '搜索资源' });
  await reopenedSearchbox.click();
  await expect(reopenedSearchbox).toBeFocused();
  await reopenedSearchbox.press('Escape');
  await expect(reopenedPicker).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue(`${original} 资料文档 @`);

  const nodeAfter = await node.boundingBox();
  expect(nodeAfter).not.toBeNull();
  expectSameNodeSize(nodeBefore!, nodeAfter!);
  expect(fixture.errors).toEqual([]);
});
