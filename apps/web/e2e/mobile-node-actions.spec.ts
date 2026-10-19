import { expect, test as base, type Locator } from '@playwright/test';
import { installFixture, project } from './image-thumbnail-cache.helpers';

type WorkspaceFixture = Awaited<ReturnType<typeof installFixture>>;

/** 所有请求由已有合成资源夹具拦截；未声明网络请求会使验收失败。 */
const test = base.extend<{ workspace: WorkspaceFixture }>({
  workspace: [
    async ({ page, baseURL }, use, testInfo) => {
      const fixture = await installFixture(page, baseURL, {
        nodes: 1,
        imageNodes: 1,
        sidebarImages: 1,
      });
      await page.addInitScript(() => {
        localStorage.setItem('multimodal-canvas:resource-panel-collapsed', 'true');
        localStorage.setItem('multimodal-canvas:resource-panel-drawer-version', '1');
      });
      try {
        await page.goto(`/projects/${project.id}`);
        await expect(page.locator('.react-flow__node')).toHaveCount(1, { timeout: 15_000 });
        await use(fixture);
      } finally {
        const audit = { ...fixture.counts(), errors: fixture.errors };
        await testInfo.attach('api-isolation-audit.json', {
          contentType: 'application/json',
          body: JSON.stringify(audit, null, 2),
        });
        expect.soft(audit.blockedRequests, '不得调用未隔离接口').toBe(0);
        expect.soft(audit.errors, '不得出现浏览器错误或未声明请求').toEqual([]);
      }
    },
    { auto: true },
  ],
});

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
test.setTimeout(60_000);

/** 对真实浏览器布局检查溢出，保留 1px 的像素取整容差。 */
async function expectNoOverflow(locator: Locator) {
  await expect
    .poll(() => locator.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
}

for (const width of [320, 390, 600]) {
  test(`${width}px 手机节点只有一个操作入口，触控抽屉按钮不溢出`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const node = page.locator('.react-flow__node[data-id="thumb-node-0"]');
    const trigger = node.getByRole('button', { name: '节点操作：图片 00', exact: true });
    await expect(trigger).toBeInViewport({ ratio: 1 });
    await expect(node.locator('.flow-node-header')).toHaveCount(0);
    await expect(node.locator('.flow-node-mobile-controls button')).toHaveCount(1);
    const triggerSize = await trigger.boundingBox();
    expect(triggerSize!.width).toBeGreaterThanOrEqual(43);
    expect(triggerSize!.height).toBeGreaterThanOrEqual(43);
    await trigger.tap();
    const panel = page.getByRole('dialog', { name: '节点操作：图片 00', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toBeInViewport({ ratio: 1 });
    for (const name of [
      '重命名节点：图片 00',
      '查看节点信息',
      '查看生成提示词：图片 00',
      '停用节点',
      '上传到节点：图片 00',
      '下载图片',
      '修改图片：图片 00',
      '删除节点：图片 00',
    ]) {
      const action = panel.getByRole('button', { name, exact: true });
      await expect(action).toBeEnabled();
      const bounds = await action.boundingBox();
      expect(bounds!.height, `${name} 触控高度`).toBeGreaterThanOrEqual(43);
    }
    await expectNoOverflow(panel);
    await expectNoOverflow(page.locator('html'));
    await testInfo.attach(`mobile-node-actions-${width}.png`, {
      contentType: 'image/png',
      body: await page.screenshot({
        path: testInfo.outputPath(`mobile-node-actions-${width}.png`),
      }),
    });
    await panel.getByRole('button', { name: '关闭节点操作：图片 00', exact: true }).tap();
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(node.locator('.flow-node-header')).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
}

test('键盘可关闭手机面板，切到桌面恢复悬浮栏且回到手机不会粘住', async ({ page }) => {
  const trigger = page.getByRole('button', { name: '节点操作：图片 00', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: '节点操作：图片 00', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '重命名节点：图片 00' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.tap();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(panel).toBeHidden();
  await expect(page.locator('.flow-node-mobile-trigger')).toHaveCount(0);
  const node = page.locator('.react-flow__node[data-id="thumb-node-0"]');
  await node.hover();
  await expect(node.getByRole('group', { name: '节点操作：图片 00' })).toBeVisible();
  await expect(node.getByRole('button', { name: '拖动移动节点' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();
  await expect(node.locator('.flow-node-header')).toHaveCount(0);
});
