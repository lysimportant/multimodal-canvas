/** 输入层与可见正文的真实排版回归；复用内存后端，禁止真实生成与用户项目写入。 */
import { expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { renderPromptDocument, type PromptDocument } from '@multimodal-canvas/domain';
import {
  connectedIds,
  connectedLabels,
  test,
  type ConnectedScenario,
} from './connected-node-regression.fixture';

/** 长中文引用必须参与自然换行，不用英文首行或伪造 DOM 几何替代。 */
const referenceName = '满穗站在左窗前面向陶缸的全身场景参考图'.repeat(3);
/** 同时覆盖中文句号、长引用、段落与末尾空行。 */
const promptDocument: PromptDocument = {
  version: 1,
  blocks: Array.from({ length: 24 }, (_, index) => [
    {
      type: 'text' as const,
      text: '第' + (index + 1) + '段：全局站位：俯视后厨。窗在画面左（东），灶门在画面右（西），',
    },
    {
      type: 'mention' as const,
      mentionId: 'alignment-reference-' + index,
      assetId: connectedIds.asset,
      assetVersion: 2,
      mediaType: 'image' as const,
      label: referenceName,
    },
    { type: 'text' as const, text: '面向灶门。案上碗碟在灶台前方。\n\n' },
  ]).flat(),
};
/** 输入值由领域渲染器生成，索引沿用原生 textarea 的 UTF-16 单位。 */
const prompt = renderPromptDocument(promptDocument);

test.use({
  viewport: { width: 1800, height: 1200 },
  serviceWorkers: 'block',
  // 无头浏览器也显示原生滚动条，覆盖 Windows 桌面的实际占位宽度。
  launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
});

/** 只覆盖夹具第一次画布读取的提示词，其余登录、模型、保存与网络阻断仍由现有夹具负责。 */
async function openLongPrompt(
  page: Page,
  scenario: ConnectedScenario,
  zoom: number,
  dialog: boolean,
) {
  const canvas = structuredClone(scenario.initial);
  const node = canvas.nodes.find((item) => item.id === connectedIds.target)!;
  node.data.prompt = prompt;
  node.data.promptDocument = promptDocument;
  await page.route(
    '**/v1/projects/' + connectedIds.project + '/canvas',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ canvas }) });
    },
    { times: 1 },
  );
  // 旧夹具未声明缩略图派生路由；只补这张合成图片的已有版本，未知请求仍由夹具拒绝。
  await page.route(
    /\/v1\/assets\/connected-generated-image-six\/versions\/(2|9)\/derivatives\/thumbnail$/,
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        contentType: 'image/jpeg',
        body: readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url)),
      });
    },
  );
  await page.goto('/projects/' + connectedIds.project);
  const target = page.locator('.react-flow__node[data-id="' + connectedIds.target + '"]');
  await expect(target).toBeVisible({ timeout: 30_000 });
  const viewport = page.locator('.react-flow__viewport');
  await expect
    .poll(() =>
      viewport.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
    )
    .toBeCloseTo(1.1, 3);
  const box = (await target.boundingBox())!;
  await page.locator('.react-flow__pane').dispatchEvent('wheel', {
    deltaY: -Math.log2(zoom / 1.1) / 0.002,
    deltaMode: 0,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
    bubbles: true,
    cancelable: true,
  });
  await expect
    .poll(() =>
      viewport.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
    )
    .toBeCloseTo(zoom, 3);
  await target.click({ position: { x: 80 * zoom, y: 70 * zoom } });
  let editor = page.getByRole('region', { name: connectedLabels.target + '生成设置', exact: true });
  await expect(editor).toBeVisible();
  if (dialog) {
    await editor.getByRole('button', { name: '打开完整编辑器', exact: true }).click();
    editor = page.getByRole('dialog', {
      name: connectedLabels.target + ' · 编辑设置',
      exact: true,
    });
    await expect(editor).toBeVisible();
    // 按真实字符坐标点击前等入场动画结束，不用固定睡眠或重新点击掩盖落点问题。
    await editor.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      );
    });
  }
  const input = editor.getByRole('textbox', { name: '提示词', exact: true });
  await expect(input).toHaveValue(prompt);
  await input.click({ trial: true });
  await expect(editor.locator('.resource-mention-token')).toHaveCount(24);
  return { editor, input, target };
}

/** 取高亮层第 offset 个字符的左侧命中点；偏移必须由浏览器原生点击决定。 */
async function characterPoint(input: Locator, offset: number) {
  return input.evaluate((element, offset) => {
    const highlight = element.parentElement!.querySelector('.resource-mention-highlight')!;
    const walker = document.createTreeWalker(highlight, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    let remaining = offset;
    while (text && remaining >= (text.textContent?.length ?? 0)) {
      remaining -= text.textContent?.length ?? 0;
      text = walker.nextNode();
    }
    if (!text) throw new Error('没有找到字符：' + offset);
    const range = document.createRange();
    range.setStart(text, remaining);
    range.setEnd(text, remaining + 1);
    const rect = range.getBoundingClientRect();
    const point = { x: rect.left + rect.width * 0.2, y: rect.top + rect.height / 2 };
    if (document.elementFromPoint(point.x, point.y) !== element)
      throw new Error('字符被裁剪或遮挡：' + JSON.stringify({ offset, point }));
    return { ...point, left: rect.left, top: rect.top };
  }, offset);
}

/** 两层正文区宽度及可滚动范围一致，高亮层只能接受程序化滚动。 */
async function expectAligned(input: Locator) {
  const geometry = await input.evaluate((element) => {
    const highlight = element.parentElement!.querySelector<HTMLElement>(
      '.resource-mention-highlight',
    )!;
    return {
      overflowX: getComputedStyle(highlight).overflowX,
      overflowY: getComputedStyle(highlight).overflowY,
      inputWidth: element.clientWidth,
      inputTextRendering: getComputedStyle(element).textRendering,
      highlightTextRendering: getComputedStyle(highlight).textRendering,
      highlightWidth: highlight.clientWidth,
      inputHeight: element.clientHeight,
      highlightHeight: highlight.clientHeight,
      inputScrollHeight: element.scrollHeight,
      highlightScrollHeight: highlight.scrollHeight,
      scrollDifference: Math.abs(element.scrollTop - highlight.scrollTop),
    };
  });
  expect(geometry.overflowX).toBe('hidden');
  expect(geometry.overflowY).toBe('hidden');
  expect(geometry.highlightWidth).toBe(geometry.inputWidth);
  expect(geometry.highlightTextRendering).toBe(geometry.inputTextRendering);
  expect(geometry.highlightHeight).toBe(geometry.inputHeight);
  expect(Math.abs(geometry.highlightScrollHeight - geometry.inputScrollHeight)).toBeLessThanOrEqual(
    1,
  );
  expect(geometry.scrollDifference).toBeLessThanOrEqual(1);
  expect(geometry.inputScrollHeight).toBeGreaterThan(geometry.inputHeight * 2);
  return geometry;
}

/** 底部右对齐不得挪用上方设置栏；检查实际按钮边界与单行布局。 */
async function expectRightAligned(editor: Locator) {
  // 在同一布局帧读取全部边界，避免 Dialog 入场动画让分次测量出现假偏移。
  const geometry = await editor.evaluate((element) => {
    const controls = element.querySelector(
      '.node-quick-editor-controls:not(.node-quick-editor-topbar)',
    )!;
    const group = controls.querySelector('.node-quick-editor-run-group')!;
    const skill = group.querySelector('.prompt-skill-trigger')?.getBoundingClientRect();
    const count = group
      .querySelector('.node-quick-editor-generation-count')!
      .getBoundingClientRect();
    const run = group.querySelector('[aria-label="生成"]')!.getBoundingClientRect();
    return {
      rightDifference: Math.abs(
        controls.getBoundingClientRect().right - group.getBoundingClientRect().right,
      ),
      countGap: run.left - count.right,
      skillGap: skill ? count.left - skill.right : null,
      skillRow: skill ? Math.abs(skill.top - run.top) : null,
      dialog: element.classList.contains('node-quick-editor-dialog'),
      topDisplay: getComputedStyle(element.querySelector('.node-quick-editor-topbar')!).display,
    };
  });
  expect(geometry.rightDifference).toBeLessThan(1);
  expect(geometry.countGap).toBeGreaterThanOrEqual(-1);
  // Dialog 原本没有 Skill 触发器，不在本任务中改变其组件结构。
  if (geometry.dialog) expect(geometry.skillGap).toBeNull();
  else {
    expect(geometry.skillGap).not.toBeNull();
    expect(geometry.skillGap!).toBeGreaterThanOrEqual(-1);
    expect(geometry.skillRow!).toBeLessThan(1);
  }
  expect(geometry.topDisplay).toBe('grid');
}

/** Ctrl+End 只保证插入点可见；再用真实滚轮滚到底部，覆盖底部 padding 与末尾空行。 */
async function scrollToBottom(page: Page, input: Locator) {
  await input.press('Control+End');
  const box = (await input.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 10000);
  await expect
    .poll(() =>
      input.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(1);
}

for (const zoom of [0.75, 1, 1.5, 2]) {
  test(
    '画布 ' + zoom + ' 倍长中文引用连续拖选、滚到底及行尾点击对齐',
    async ({ page, scenario }) => {
      const { editor, input, target } = await openLongPrompt(page, scenario, zoom, false);
      const initialBox = (await target.boundingBox())!;
      scenario.observations.layout = await expectAligned(input);
      await expectRightAligned(editor);
      const end = prompt.indexOf('方。');
      for (let index = 0; index < 5; index += 1) {
        const start = 2 + index;
        // 每轮先清除前次选区，真实拖动跨过长引用与换行，禁止 setSelectionRange 掩盖命中错误。
        const from = await characterPoint(input, start);
        const to = await characterPoint(input, end);
        await page.mouse.click(from.x, from.y);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 10 });
        await page.mouse.up();
        await expect
          .poll(() =>
            input.evaluate((element: HTMLTextAreaElement) => [
              element.selectionStart,
              element.selectionEnd,
            ]),
          )
          .toEqual([start, end]);
        await page.mouse.click(to.x, to.y);
        await expect
          .poll(() =>
            input.evaluate((element: HTMLTextAreaElement) => [
              element.selectionStart,
              element.selectionEnd,
            ]),
          )
          .toEqual([end, end]);
        await expect(input).toHaveValue(prompt);
      }
      await scrollToBottom(page, input);
      await expect
        .poll(() =>
          input.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      scenario.observations.layout = await expectAligned(input);
      const lastOffset = prompt.lastIndexOf('方。');
      const last = await characterPoint(input, lastOffset);
      await page.mouse.click(last.x, last.y);
      await expect
        .poll(() => input.evaluate((element: HTMLTextAreaElement) => element.selectionStart))
        .toBe(lastOffset);
      await expect(editor.locator('.resource-mention-caret')).toBeVisible();
      const caret = (await editor.locator('.resource-mention-caret').boundingBox())!;
      expect(caret.width).toBeCloseTo(2, 1);
      expect(Math.abs(caret.x - last.left)).toBeLessThan(1);
      expect(Math.abs(caret.y - last.top)).toBeLessThan(1);
      await page.keyboard.insertText('验收');
      await expect(input).toHaveValue(
        prompt.slice(0, lastOffset) + '验收' + prompt.slice(lastOffset),
      );
      expect((await target.boundingBox())!.width).toBeCloseTo(initialBox.width, 1);
      expect((await target.boundingBox())!.height).toBeCloseTo(initialBox.height, 1);
      expect(scenario.submissions).toEqual([]);
    },
  );
}

test('完整 Dialog 使用相同单滚动层与底部右对齐，末尾空行可达', async ({ page, scenario }) => {
  const { editor, input } = await openLongPrompt(page, scenario, 1.5, true);
  await expectAligned(input);
  await expectRightAligned(editor);
  const end = prompt.indexOf('方。');
  const point = await characterPoint(input, end);
  await page.mouse.click(point.x, point.y);
  await expect
    .poll(() => input.evaluate((element: HTMLTextAreaElement) => element.selectionStart))
    .toBe(end);
  await scrollToBottom(page, input);
  await expectAligned(input);
  await expect
    .poll(() =>
      input.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(1);
  await expect(editor.locator('.resource-mention-caret')).toBeVisible();
  expect(scenario.submissions).toEqual([]);
});
