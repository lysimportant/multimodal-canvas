import { expect, test as base, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installFixture, project } from './image-thumbnail-cache.helpers';

/** 运行时将 WEB_PORT 与 VITE_API_BASE_URL 设为同一独立本机端口，避免跨站 mock Cookie。 */
/** 常见与最窄手机视口，单位为 CSS 像素。 */
const phoneViewports = [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];
/** 四种创建入口始终留在底部胶囊，不随更多工具折叠。 */
const createNames = ['文字', '图片', '音频', '视频'].map((name) => `新建${name}生成节点`);
/** 手机弹层与桌面胶囊应保留同一组动作及可访问名称。 */
const actionNames = [
  '上传资产',
  '新建分组',
  '整理画布节点',
  '清空',
  '画布撤销',
  '画布重做',
  '技能工作台',
  '搜索',
  '外观',
  '自动适配缩放',
];
/** 仅对内存项目执行画布写入，不调用真实 API 或 Provider。 */
type WorkspaceFixture = Awaited<ReturnType<typeof installFixture>>;

/** 沿用移动工作区的小夹具与资源栏偏好，每例审计未隔离请求和浏览器错误。 */
const test = base.extend<{ workspace: WorkspaceFixture }>({
  workspace: [
    async ({ page, baseURL }, use, testInfo) => {
      const fixture = await installFixture(page, baseURL, {
        nodes: 2,
        imageNodes: 1,
        sidebarImages: 2,
      });
      await page.addInitScript(() => {
        localStorage.setItem('multimodal-canvas:resource-panel-collapsed', 'true');
        localStorage.setItem('multimodal-canvas:resource-panel-drawer-version', '1');
      });
      try {
        await page.goto(`/projects/${project.id}`);
        await expect(page.locator('.react-flow__node')).toHaveCount(2, { timeout: 15_000 });
        await use(fixture);
      } finally {
        const audit = { ...fixture.counts(), errors: fixture.errors };
        await testInfo.attach('api-isolation-audit.json', {
          contentType: 'application/json',
          body: JSON.stringify(audit, null, 2),
        });
        expect.soft(audit.blockedRequests, '不得调用生成或未隔离接口').toBe(0);
        expect.soft(audit.errors, '不得出现浏览器错误或未声明请求').toEqual([]);
      }
    },
    { auto: true },
  ],
});

test.use({ viewport: phoneViewports[0], serviceWorkers: 'block' });
test.setTimeout(60_000);

/** 校验容器没有横向溢出；1px 容差仅用于浏览器像素取整。 */
async function expectNoHorizontalOverflow(container: Locator) {
  await expect
    .poll(() => container.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
}

/** 验证手机初始胶囊只含四种创建入口和折叠箭头，并完整落在视口内。 */
async function expectClosedPhoneTools(page: Page) {
  const capsule = page.locator('.canvas-node-tools');
  const create = capsule.getByRole('group', { name: '创建节点', exact: true });
  const arrow = capsule.getByRole('button', { name: '更多画布工具', exact: true });
  await expect(capsule.locator('button:visible')).toHaveCount(5);
  await expect(create.getByRole('button')).toHaveCount(4);
  for (const name of createNames) {
    await expect(create.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
  await expect(arrow).toBeInViewport({ ratio: 1 });
  await expect(arrow).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('dialog', { name: '更多画布工具', exact: true })).toBeHidden();
  await expect(capsule).toBeInViewport({ ratio: 1 });
  // 透明提示气泡也计入 scrollWidth；胶囊按可见按钮边界检查，页面仍检查真实横向溢出。
  const contained = await capsule.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('button')].every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
    });
  });
  expect(contained, '五个按钮不得溢出胶囊边界').toBe(true);
  await expectNoHorizontalOverflow(page.locator('html'));
}

/** 保存当前视口并附加到报告，避免整页截图掩盖手机裁切。 */
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const viewport of phoneViewports) {
  test.describe(`手机胶囊 ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('默认五个按钮，更多动作完整显示在箭头上方且无横向溢出', async ({ page }, testInfo) => {
      await expectClosedPhoneTools(page);
      await screenshot(page, testInfo, 'phone-tools-initial');
      const arrow = page.getByRole('button', { name: '更多画布工具', exact: true });
      await arrow.click();
      const popup = page.getByRole('dialog', { name: '更多画布工具', exact: true });
      await expect(arrow).toHaveAttribute('aria-expanded', 'true');
      await expect(popup).toBeVisible();
      await screenshot(page, testInfo, 'phone-tools-open');
      await expect(popup).toBeInViewport({ ratio: 1 });
      for (const name of actionNames) {
        const action = popup.getByRole('button', { name, exact: true });
        await expect(action).toBeVisible();
        await expect(action).toBeInViewport({ ratio: 1 });
      }
      for (const name of createNames) {
        await expect(
          page.getByRole('group', { name: '创建节点', exact: true }).getByRole('button', {
            name,
            exact: true,
          }),
        ).toBeInViewport({ ratio: 1 });
      }
      await expect(popup.getByRole('button', { name: '画布撤销', exact: true })).toBeDisabled();
      await expect(popup.getByRole('button', { name: '画布重做', exact: true })).toBeDisabled();
      await expect(popup.getByRole('button', { name: '整理画布节点', exact: true })).toBeEnabled();
      await expectNoHorizontalOverflow(popup);
      await expectNoHorizontalOverflow(page.locator('html'));
      const popupBox = await popup.boundingBox();
      const arrowBox = await arrow.boundingBox();
      expect(popupBox).not.toBeNull();
      expect(arrowBox).not.toBeNull();
      expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(arrowBox!.y + 1);
    });
  });
}

test('再次点击箭头、Escape 和画布外部点击均收起更多工具', async ({ page }) => {
  const arrow = page.getByRole('button', { name: '更多画布工具', exact: true });
  const popup = page.getByRole('dialog', { name: '更多画布工具', exact: true });
  await arrow.click();
  await expect(popup).toBeVisible();
  await arrow.click();
  await expectClosedPhoneTools(page);
  await arrow.click();
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expectClosedPhoneTools(page);
  await arrow.click();
  await expect(popup).toBeVisible();
  await page.locator('.react-flow__pane').click({ position: { x: 8, y: 100 } });
  await expectClosedPhoneTools(page);
});

test('整理动作真实更新节点并收起，撤销重做保留历史与禁用状态', async ({ page, workspace }) => {
  const original = workspace.canvas().nodes;
  const writes = workspace.counts().canvasWrites;
  const arrow = page.getByRole('button', { name: '更多画布工具', exact: true });
  const popup = page.getByRole('dialog', { name: '更多画布工具', exact: true });
  await arrow.click();
  await popup.getByRole('button', { name: '整理画布节点', exact: true }).click();
  await expectClosedPhoneTools(page);
  await expect.poll(() => workspace.counts().canvasWrites).toBe(writes + 1);
  await expect
    .poll(() => workspace.canvas().nodes.map((node) => node.position))
    .not.toEqual(original.map((node) => node.position));
  const arranged = workspace.canvas().nodes;
  // 保存会补全缺省 mimeType；保留原有字段和尺寸即可，不禁止序列化补充元数据。
  expect(arranged.map(({ position: _position, ...node }) => node)).toMatchObject(
    original.map(({ position: _position, ...node }) => node),
  );
  await arrow.click();
  await expect(popup.getByRole('button', { name: '画布撤销', exact: true })).toBeEnabled();
  await expect(popup.getByRole('button', { name: '画布重做', exact: true })).toBeDisabled();
  await popup.getByRole('button', { name: '画布撤销', exact: true }).click();
  await expectClosedPhoneTools(page);
  await expect.poll(() => workspace.canvas().nodes).toMatchObject(original);
  await arrow.click();
  await expect(popup.getByRole('button', { name: '画布撤销', exact: true })).toBeDisabled();
  await expect(popup.getByRole('button', { name: '画布重做', exact: true })).toBeEnabled();
  await popup.getByRole('button', { name: '画布重做', exact: true }).click();
  await expectClosedPhoneTools(page);
  await expect.poll(() => workspace.canvas().nodes).toEqual(arranged);
});

test('嵌套外观与清空选项可访问，只切换外观而不执行清空', async ({ page, workspace }) => {
  await page.setViewportSize(phoneViewports[1]);
  const original = workspace.canvas();
  const writes = workspace.counts().canvasWrites;
  const arrow = page.getByRole('button', { name: '更多画布工具', exact: true });
  const popup = page.getByRole('dialog', { name: '更多画布工具', exact: true });
  await arrow.click();
  await popup.getByRole('button', { name: '外观', exact: true }).click();
  const appearance = page.getByRole('dialog', { name: '主题、画布背景与连接线', exact: true });
  await expect(appearance).toBeVisible();
  await appearance.getByRole('button', { name: '深色', exact: true }).click();
  await expect(appearance.getByRole('button', { name: '深色', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('multimodal-canvas:theme')))
    .toBe('dark');
  await expect(popup).toBeVisible();
  await arrow.click();
  await expect(appearance).toBeHidden();
  await expectClosedPhoneTools(page);
  await arrow.click();
  await popup.getByRole('button', { name: '清空', exact: true }).click();
  const clearCanvas = page.getByRole('menuitem', { name: /^清空画布/ });
  const clearEmpty = page.getByRole('menuitem', { name: /^清空空节点/ });
  await expect(clearCanvas).toBeVisible();
  await expect(clearCanvas).toBeEnabled();
  await expect(clearEmpty).toBeVisible();
  await expect(clearEmpty).toBeDisabled();
  await expect(popup).toBeVisible();
  await arrow.click();
  await expect(clearCanvas).toBeHidden();
  await expectClosedPhoneTools(page);
  expect(workspace.canvas()).toEqual(original);
  expect(workspace.counts().canvasWrites).toBe(writes);
});

test('桌面保留完整胶囊，600px 及以下折叠，跨断点后重新进入默认关闭', async ({ page }) => {
  const capsule = page.locator('.canvas-node-tools');
  const arrow = page.getByRole('button', { name: '更多画布工具', exact: true });
  const popup = page.getByRole('dialog', { name: '更多画布工具', exact: true });
  await arrow.click();
  await expect(popup).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(popup).toBeHidden();
  await expect(arrow).toBeHidden();
  await expect(capsule.locator('button:visible')).toHaveCount(
    createNames.length + actionNames.length,
  );
  for (const name of [...createNames, ...actionNames]) {
    await expect(capsule.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 600, height: 900 });
  await expectClosedPhoneTools(page);
  await arrow.click();
  await expect(popup).toBeVisible();
  await page.setViewportSize({ width: 601, height: 900 });
  await expect(popup).toBeHidden();
  await expect(arrow).toBeHidden();
  await expect(capsule.locator('button:visible')).toHaveCount(
    createNames.length + actionNames.length,
  );
  await page.setViewportSize(phoneViewports[1]);
  await expectClosedPhoneTools(page);
});
