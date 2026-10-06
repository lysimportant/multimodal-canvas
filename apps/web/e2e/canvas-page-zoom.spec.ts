import { expect, test as base, type CDPSession, type Page } from '@playwright/test';
import { installFixture, project } from './image-thumbnail-cache.helpers';

/** 所有请求使用内存夹具，测试不得触达真实账号、资源或生成接口。 */
const test = base.extend<{ workspace: Awaited<ReturnType<typeof installFixture>> }>({
  workspace: [
    async ({ page, baseURL }, use, testInfo) => {
      const fixture = await installFixture(page, baseURL, {
        nodes: 2,
        imageNodes: 1,
        sidebarImages: 20,
      });
      await page.addInitScript(() => {
        localStorage.setItem('multimodal-canvas:resource-panel-collapsed', 'true');
        localStorage.setItem('multimodal-canvas:resource-panel-drawer-version', '1');
      });
      try {
        await page.goto('/projects/' + project.id);
        await expect(page.locator('.react-flow__node')).toHaveCount(2, { timeout: 15_000 });
        await expect(page.locator('html')).toHaveClass(/is-canvas-page/);
        await use(fixture);
      } finally {
        const audit = { ...fixture.counts(), errors: fixture.errors };
        await testInfo.attach('request-audit.json', {
          contentType: 'application/json',
          body: JSON.stringify(audit, null, 2),
        });
        expect.soft(audit.blockedRequests).toBe(0);
        expect.soft(audit.errors).toEqual([]);
      }
    },
    { auto: true },
  ],
});

/** 对比浏览器页面倍率与 React Flow 自身倍率，避免把窗口缩放误认成画布缩放。 */
async function metrics(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    if (!viewport) throw new Error('画布未挂载');
    return {
      flowScale: new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a,
      pageScale: window.visualViewport?.scale ?? 1,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
}

/** 从真实命中结果选择空白画布，避免手势意外落在节点或浮层上。 */
async function blankPoint(page: Page) {
  return page.locator('.react-flow__pane').evaluate((pane) => {
    const rect = pane.getBoundingClientRect();
    for (const fraction of [0.72, 0.3, 0.55, 0.15]) {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height * fraction;
      if ([-90, -35, 35, 90].every((offset) => document.elementFromPoint(x + offset, y) === pane))
        return { x, y };
    }
    throw new Error('找不到足够的空白画布执行双指手势');
  });
}

/** Chromium 原生双指输入；不同于 dispatchEvent，它能实际触发浏览器默认手势。 */
async function pinch(session: CDPSession, x: number, y: number) {
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: x - 35, y, id: 1 },
      { x: x + 35, y, id: 2 },
    ],
  });
  for (const spread of [45, 55, 65, 75, 90]) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x - spread, y, id: 1 },
        { x: x + spread, y, id: 2 },
      ],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.setTimeout(60_000);
test.use({ serviceWorkers: 'block' });

for (const viewport of [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
]) {
  test.describe('触屏 ' + viewport.width, () => {
    test.use({ viewport, isMobile: true, hasTouch: true });

    test('双指仅缩放画布，胶囊区域不放大页面，缩放按钮仍可点击', async ({ page }, testInfo) => {
      const session = await page.context().newCDPSession(page);
      const initial = await metrics(page);
      const point = await blankPoint(page);
      await pinch(session, point.x, point.y);
      await expect
        .poll(async () => (await metrics(page)).flowScale)
        .toBeGreaterThan(initial.flowScale + 0.1);
      const afterPinch = await metrics(page);
      expect(afterPinch).toMatchObject({
        pageScale: 1,
        width: viewport.width,
        height: viewport.height,
      });

      const toolbar = await page.locator('.canvas-node-tools.is-mobile').boundingBox();
      if (!toolbar) throw new Error('手机胶囊不可见');
      await pinch(session, toolbar.x + toolbar.width / 2, toolbar.y + toolbar.height / 2);
      expect(await metrics(page)).toEqual(afterPinch);
      await page.locator('.react-flow__controls-zoomout').tap();
      await expect
        .poll(async () => (await metrics(page)).flowScale)
        .toBeLessThan(afterPinch.flowScale);
      expect((await metrics(page)).pageScale).toBe(1);
      await page.screenshot({
        path: testInfo.outputPath('mobile-zoom.png'),
        animations: 'disabled',
      });
      await testInfo.attach('zoom-metrics.json', {
        contentType: 'application/json',
        body: JSON.stringify({ initial, afterPinch, afterButton: await metrics(page) }, null, 2),
      });
      await session.detach();
    });

    test('资源浮层仍可单指滚动，搜索聚焦不放大窗口', async ({ page }, testInfo) => {
      await page.getByRole('button', { name: '打开全部资源', exact: true }).tap();
      const resources = page.getByRole('dialog', { name: '全部资源', exact: true });
      await expect(resources).toBeVisible();
      const search = resources.getByRole('searchbox');
      await search.tap();
      expect(
        await search.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
      ).toBeGreaterThanOrEqual(16);
      await search.fill('素材');
      expect((await metrics(page)).pageScale).toBe(1);
      await search.blur();
      const list = resources.locator('.asset-list');
      const box = await list.boundingBox();
      if (!box) throw new Error('资源滚动区不可见');
      const session = await page.context().newCDPSession(page);
      const x = box.x + box.width / 2;
      const startY = Math.min(box.y + box.height, viewport.height) - 35;
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y: startY, id: 1 }],
      });
      for (const offset of [30, 60, 90, 120, 150]) {
        // 分帧发送触点，避免同一帧合并掉整段滑动；不是等待页面异步就绪。
        await page.waitForTimeout(30);
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: startY - offset, id: 1 }],
        });
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect((await metrics(page)).pageScale).toBe(1);
      await page.screenshot({
        path: testInfo.outputPath('mobile-resource-scroll.png'),
        animations: 'disabled',
      });
      await resources.getByRole('button', { name: '关闭全部资源', exact: true }).tap();
      await expect(resources).toBeHidden();
      await session.detach();
    });
  });
}

test.describe('桌面与离开画布', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Ctrl 滚轮仅缩放画布，离开画布后恢复 viewport 和默认快捷键', async ({ page }, testInfo) => {
    const initial = await metrics(page);
    const point = await blankPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect
      .poll(async () => (await metrics(page)).flowScale)
      .toBeGreaterThan(initial.flowScale);
    expect((await metrics(page)).pageScale).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath('desktop-zoom.png'),
      animations: 'disabled',
    });
    const canceled = () =>
      page.evaluate(() => {
        const event = new KeyboardEvent('keydown', {
          key: '+',
          ctrlKey: true,
          cancelable: true,
          bubbles: true,
        });
        document.dispatchEvent(event);
        return event.defaultPrevented;
      });
    expect(await canceled()).toBe(true);
    await page.evaluate(() => {
      history.pushState(null, '', '/contact');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.react-flow')).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/is-canvas-page/);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      'content',
      'width=device-width, initial-scale=1.0',
    );
    expect(await canceled()).toBe(false);
  });
});
