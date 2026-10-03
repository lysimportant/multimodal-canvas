import { expect, test as base, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { installFixture, project } from './image-thumbnail-cache.helpers';

/** 复验时将 WEB_PORT 和 VITE_API_BASE_URL 指向同一独立本机端口，避免跨站 mock Cookie 被拦截。 */

/** 手机断点内的常见与最窄验收视口；尺寸单位为 CSS 像素。 */
const phoneViewports = [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];
/** 桌面原有工具栏和资源抽屉的验收尺寸，不模拟手机触摸设备。 */
const desktopViewport = { width: 1440, height: 900 };
/** 使用现有可访问名称定位，禁用按钮仍须保留入口。 */
const actionNames = [
  '打开命令面板',
  '撤销',
  '重做',
  '整理节点',
  '外观',
  '打开设置',
  '账户菜单',
  '导出',
  '运行',
];
/** 桌面固定/收起状态的现有持久化合同；手机浮层不得改写它。 */
const resourcePreferenceKey = 'multimodal-canvas:resource-panel-collapsed';
/** 默认拒绝 API 放行的既有 fixture，所有画布写入只保存在测试内存。 */
type WorkspaceFixture = Awaited<ReturnType<typeof installFixture>>;

/** 自动装载小规模合成项目；每例结束审计错误和被阻止请求，不执行真实生成。 */
const test = base.extend<{ workspace: WorkspaceFixture; resourceCollapsed: boolean }>({
  resourceCollapsed: [true, { option: true }],
  workspace: [
    async ({ page, baseURL, resourceCollapsed }, use, testInfo) => {
      const fixture = await installFixture(page, baseURL, {
        nodes: 2,
        imageNodes: 1,
        sidebarImages: 2,
      });
      await page.addInitScript(
        ({ key, collapsed }) => {
          localStorage.setItem(key, String(collapsed));
          localStorage.setItem('multimodal-canvas:resource-panel-drawer-version', '1');
        },
        { key: resourcePreferenceKey, collapsed: resourceCollapsed },
      );
      try {
        // openScenario 会强制展开桌面侧栏并等待 41 个节点，不适用于隐藏侧栏的手机验收。
        await page.goto(`/projects/${project.id}`);
        await expect(page.locator('.react-flow__node')).toHaveCount(2, { timeout: 15_000 });
        await use(fixture);
      } finally {
        const audit = { ...fixture.counts(), errors: fixture.errors };
        if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
          const focus = await page.evaluate(() => {
            const active = document.activeElement;
            return {
              tag: active?.tagName,
              id: active?.id,
              className: active?.className,
              label: active?.getAttribute('aria-label'),
              role: active?.getAttribute('role'),
              dialogLabel: active?.closest('[role="dialog"]')?.getAttribute('aria-label'),
              inMenu: Boolean(active?.closest('.mobile-workspace-menu')),
              inResources: Boolean(active?.closest('.mobile-workspace-resources')),
            };
          });
          await testInfo.attach('focus-at-failure.json', {
            contentType: 'application/json',
            body: JSON.stringify(focus, null, 2),
          });
        }
        await testInfo.attach('api-isolation-audit.json', {
          contentType: 'application/json',
          body: JSON.stringify(audit, null, 2),
        });
        expect.soft(audit.blockedRequests, '不得发起生成或未隔离的外部请求').toBe(0);
        expect.soft(audit.errors, '不得出现浏览器错误或未声明的 API 请求').toEqual([]);
      }
    },
    { auto: true },
  ],
});

test.use({ serviceWorkers: 'block' });
test.setTimeout(60_000);

/** 检查手机仅显示两个顶栏入口，整个资源栏及原工具栏均不可见。 */
async function expectPhoneChrome(page: Page) {
  for (const name of ['打开画布菜单', '打开全部资源']) {
    const trigger = page.getByRole('button', { name, exact: true });
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeInViewport({ ratio: 1 });
  }
  await expect(page.locator('.topbar-actions:visible')).toHaveCount(0);
  await expect(page.locator('.resource-panel:visible')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '画布菜单', exact: true })).toBeHidden();
  await expect(page.getByRole('dialog', { name: '全部资源', exact: true })).toBeHidden();
}

/** 只检查入口可见，不要求没有历史、选中节点或模型的动作可执行。 */
async function expectActions(container: Locator) {
  for (const name of actionNames) {
    await expect(container.getByRole('button', { name, exact: true })).toBeVisible();
  }
}

/** 检查切回桌面后恢复原工具栏和资源抽屉，并卸载或隐藏手机浮层。 */
async function expectDesktopChrome(page: Page, collapsed: boolean) {
  await expect(page.getByRole('button', { name: '打开画布菜单', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '打开全部资源', exact: true })).toBeHidden();
  await expect(page.getByRole('dialog', { name: '画布菜单', exact: true })).toBeHidden();
  await expect(page.getByRole('dialog', { name: '全部资源', exact: true })).toBeHidden();
  await expect(page.locator('.topbar-actions:visible')).toHaveCount(1);
  await expect(page.locator('.resource-panel')).toBeVisible();
  await expect(
    page.locator('.resource-panel').getByRole('button', {
      name: collapsed ? '展开资源栏' : '折叠资源栏',
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), resourcePreferenceKey))
    .toBe(String(collapsed));
}

/** 保存当前视口而非整页长图，便于复核手机浮层是否裁切或遮挡。 */
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const viewport of phoneViewports) {
  test.describe(`手机 ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('初始隐藏整个资源栏和原工具栏，画布菜单保留所有动作并可关闭', async ({
      page,
    }, testInfo) => {
      await expectPhoneChrome(page);
      await screenshot(page, testInfo, 'phone-initial');
      await page.getByRole('button', { name: '打开画布菜单', exact: true }).click();
      const menu = page.getByRole('dialog', { name: '画布菜单', exact: true });
      await expect(menu).toBeVisible();
      await expect(menu).toBeInViewport({ ratio: 1 });
      await expectActions(menu);
      await expect(menu.getByRole('button', { name: '运行', exact: true })).toBeDisabled();
      await expect(page.locator('.resource-panel:visible')).toHaveCount(0);
      await screenshot(page, testInfo, 'phone-canvas-menu');
      await menu.getByRole('button', { name: '关闭画布菜单', exact: true }).click();
      await expectPhoneChrome(page);
    });

    test('菜单内外观设置和嵌套导出可操作，工作流下载完全来自 mock', async ({
      page,
      workspace,
      baseURL,
    }, testInfo) => {
      const allowedOrigins = new Set([
        new URL(baseURL!).origin,
        new URL(process.env.VITE_API_BASE_URL ?? 'http://localhost:3000').origin,
      ]);
      const exportedWorkflow = { project, canvas: workspace.canvas() };
      let exportRequests = 0;
      await page.route(`**/v1/projects/${project.id}/export/workflow`, async (route) => {
        if (
          route.request().method() !== 'GET' ||
          !allowedOrigins.has(new URL(route.request().url()).origin)
        ) {
          await route.fallback();
          return;
        }
        exportRequests += 1;
        await route.fulfill({
          contentType: 'application/json',
          headers: {
            'content-disposition': 'attachment; filename="mobile-workspace.workflow.json"',
          },
          body: JSON.stringify(exportedWorkflow),
        });
      });
      await page.getByRole('button', { name: '打开画布菜单', exact: true }).click();
      const menu = page.getByRole('dialog', { name: '画布菜单', exact: true });
      await menu.getByRole('button', { name: '外观', exact: true }).click();
      const appearance = page.getByRole('dialog', { name: '主题、画布背景与连接线', exact: true });
      await expect(appearance).toBeVisible();
      await appearance.getByRole('button', { name: '深色', exact: true }).click();
      await expect(appearance.getByRole('button', { name: '深色', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await appearance.getByRole('tab', { name: '背景', exact: true }).click();
      await appearance.getByRole('button', { name: '空白', exact: true }).click();
      await expect(appearance.getByRole('button', { name: '空白', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect
        .poll(() =>
          page.evaluate(() => ({
            theme: localStorage.getItem('multimodal-canvas:theme'),
            background: localStorage.getItem('multimodal-canvas:background'),
          })),
        )
        .toEqual({ theme: 'dark', background: 'blank' });
      await screenshot(page, testInfo, 'phone-nested-appearance');
      // 点击同一菜单的标题关闭子浮层，不能把整个手机菜单一并销毁。
      await menu.getByText('画布菜单', { exact: true }).click();
      await expect(appearance).toBeHidden();
      await expect(menu).toBeVisible();
      await menu.getByRole('button', { name: '导出', exact: true }).click();
      const exportMenu = page.getByRole('menu', { name: '导出选项', exact: true });
      await expect(exportMenu).toBeVisible();
      await expect(
        exportMenu.getByRole('menuitem', { name: '导出工作流 JSON', exact: true }),
      ).toBeVisible();
      await expect(
        exportMenu.getByRole('menuitem', { name: '导出结果 ZIP', exact: true }),
      ).toBeVisible();
      await screenshot(page, testInfo, 'phone-nested-export');
      const downloading = page.waitForEvent('download');
      await exportMenu.getByRole('menuitem', { name: '导出工作流 JSON', exact: true }).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe('mobile-workspace.workflow.json');
      const downloadPath = await download.path();
      expect(downloadPath).not.toBeNull();
      expect(JSON.parse(await readFile(downloadPath!, 'utf8'))).toEqual(exportedWorkflow);
      expect(exportRequests).toBe(1);
      await expect(exportMenu).toBeHidden();
      await expect(menu).toBeVisible();
      await menu.getByRole('button', { name: '关闭画布菜单', exact: true }).click();
      await expectPhoneChrome(page);
    });

    test('全部资源以具名浮层打开、关闭并能再次打开', async ({ page }, testInfo) => {
      await expectPhoneChrome(page);
      const resources = page.getByRole('dialog', { name: '全部资源', exact: true });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await page.getByRole('button', { name: '打开全部资源', exact: true }).click();
        await expect(resources).toBeVisible();
        await expect(resources).toBeInViewport({ ratio: 1 });
        await expect(resources.locator('.resource-panel')).toBeVisible();
        await expect(resources.locator('.asset-card')).toHaveCount(2);
        await expect(resources.locator('.asset-card').first()).toBeVisible();
        await expect(page.locator('.topbar-actions:visible')).toHaveCount(0);
        if (attempt === 0) await screenshot(page, testInfo, 'phone-resources');
        await resources.getByRole('button', { name: '关闭全部资源', exact: true }).click();
        await expectPhoneChrome(page);
      }
    });

    test('资源搜索、添加与 Escape 关闭保持可用并返回入口焦点', async ({ page }, testInfo) => {
      const trigger = page.getByRole('button', { name: '打开全部资源', exact: true });
      await trigger.click();
      const resources = page.getByRole('dialog', { name: '全部资源', exact: true });
      const search = resources.getByRole('searchbox');
      const searching = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/v1/assets' && url.searchParams.get('query') === '素材 01';
      });
      await search.fill('素材 01');
      expect((await searching).ok()).toBe(true);
      await expect(resources.locator('.asset-card')).toHaveCount(1);
      await expect(
        resources.getByRole('button', { name: '预览 素材 01', exact: true }),
      ).toBeVisible();
      await resources.getByRole('button', { name: '添加 素材 01 到画布', exact: true }).click();
      await expect(page.locator('.react-flow__node')).toHaveCount(3);
      await expect(page.locator('.react-flow__node.selected')).toHaveAttribute(
        'data-id',
        /^node_image-thumb-001_/,
      );
      // 共享清除按钮存在 IME 草稿重置问题；本用例只验收手机搜索和添加，不扩大到该存量缺陷。
      await search.fill('');
      await expect(resources.locator('.asset-card')).toHaveCount(2);
      await expect(search).toHaveValue('');
      await screenshot(page, testInfo, 'phone-resource-added');
      await page.keyboard.press('Escape');
      await expect(resources).toBeHidden();
      await expect(trigger).toBeFocused();
      await expectPhoneChrome(page);
    });

    test('画布菜单 Escape 关闭并返回入口焦点', async ({ page }) => {
      const trigger = page.getByRole('button', { name: '打开画布菜单', exact: true });
      const menu = page.getByRole('dialog', { name: '画布菜单', exact: true });
      await trigger.click();
      await expect(menu).toBeVisible();
      // 抽屉先开始动画再自动聚焦，按键前等待焦点进入，避免将 Escape 发给背景画布。
      await expect
        .poll(() =>
          page
            .locator('.mobile-workspace-menu')
            .evaluate((element) => element.contains(document.activeElement)),
        )
        .toBe(true);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await expectPhoneChrome(page);
    });

    test('命令和设置切换不残留菜单遮罩，关闭后返回手机入口', async ({
      page,
      baseURL,
    }, testInfo) => {
      const allowedOrigins = new Set([
        new URL(baseURL!).origin,
        new URL(process.env.VITE_API_BASE_URL ?? 'http://localhost:3000').origin,
      ]);
      await page.route('**/v1/account/newapi', async (route) => {
        if (
          route.request().method() !== 'GET' ||
          !allowedOrigins.has(new URL(route.request().url()).origin)
        ) {
          await route.fallback();
          return;
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            account: {
              issuer: 'https://newapi.example.test',
              externalUserId: 'mobile-workspace-fixture',
              displayName: '手机隔离测试用户',
              status: 'active',
              syncedAt: project.updatedAt,
              groups: [],
              links: {},
            },
          }),
        });
      });
      const trigger = page.getByRole('button', { name: '打开画布菜单', exact: true });
      const menu = page.getByRole('dialog', { name: '画布菜单', exact: true });
      await trigger.click();
      await menu.getByRole('button', { name: '打开命令面板', exact: true }).click();
      const command = page.getByRole('dialog', { name: '命令面板', exact: true });
      await expect(command).toBeVisible();
      await expect(menu).toBeHidden();
      const commandSearch = command.getByRole('searchbox', { name: '搜索命令…', exact: true });
      await expect(commandSearch).toBeFocused();
      await commandSearch.fill('设置');
      await expect(command.getByRole('option').first()).toBeVisible();
      await screenshot(page, testInfo, 'phone-command-transition');
      await page.keyboard.press('Escape');
      await expect(command).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await menu.getByRole('button', { name: '打开设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'New API 与模型', exact: true });
      await expect(settings).toBeVisible();
      await expect(settings.getByRole('button', { name: '关闭设置', exact: true })).toBeEnabled();
      await expect(menu).toBeHidden();
      await screenshot(page, testInfo, 'phone-settings-transition');
      await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
      await expect(settings).toBeHidden();
      await expect(trigger).toBeFocused();
      await expectPhoneChrome(page);
    });
    for (const resourceCollapsed of [true, false]) {
      test.describe(`保留桌面${resourceCollapsed ? '收起' : '固定展开'}偏好`, () => {
        test.use({ resourceCollapsed });

        test('资源或菜单打开时切回桌面，清除手机浮层而不改写资源栏偏好', async ({ page }) => {
          await expectPhoneChrome(page);
          await page.getByRole('button', { name: '打开全部资源', exact: true }).click();
          await expect(page.getByRole('dialog', { name: '全部资源', exact: true })).toBeVisible();
          await page.setViewportSize(desktopViewport);
          await expectDesktopChrome(page, resourceCollapsed);
          await expectActions(page.locator('.topbar-actions:visible'));
          await page.setViewportSize(viewport);
          await expectPhoneChrome(page);
          await page.getByRole('button', { name: '打开画布菜单', exact: true }).click();
          await expect(page.getByRole('dialog', { name: '画布菜单', exact: true })).toBeVisible();
          await page.setViewportSize(desktopViewport);
          await expectDesktopChrome(page, resourceCollapsed);
          await page.setViewportSize(viewport);
          await expectPhoneChrome(page);
        });
      });
    }
  });
}

test.describe('桌面 1440x900', () => {
  test.use({ viewport: desktopViewport });

  test('原工具栏及资源抽屉保持可用，不显示手机入口', async ({ page }, testInfo) => {
    await expectDesktopChrome(page, true);
    await expectActions(page.locator('.topbar-actions:visible'));
    await screenshot(page, testInfo, 'desktop-original-chrome');
    const sidebar = page.locator('.resource-panel');
    await sidebar.getByRole('button', { name: '展开资源栏', exact: true }).click();
    await expectDesktopChrome(page, false);
    await expect(sidebar.locator('.asset-card').first()).toBeVisible();
    await sidebar.getByRole('button', { name: '折叠资源栏', exact: true }).click();
    await expectDesktopChrome(page, true);
  });
});

test.describe('600px 断点', () => {
  test.use({ viewport: { width: 600, height: 900 } });

  test('600px 使用手机入口，601px 恢复桌面资源栏和工具栏', async ({ page }) => {
    await expectPhoneChrome(page);
    await page.setViewportSize({ width: 601, height: 900 });
    await expectDesktopChrome(page, true);
    await page.setViewportSize({ width: 600, height: 900 });
    await expectPhoneChrome(page);
  });
});
