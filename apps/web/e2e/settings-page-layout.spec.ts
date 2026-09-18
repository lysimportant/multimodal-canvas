/** 设置页布局验收使用合成目录，不访问供应商或保存真实凭据。 */
import { expect, test, type Page } from '@playwright/test';

/** 安装只读设置夹具；未知业务接口直接失败，防止测试落到真实服务。 */
async function installSettingsFixture(page: Page, theme: string) {
  await page.addInitScript((theme) => {
    localStorage.setItem('multimodal-canvas:theme', theme);
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-layout-session',
        tokenType: 'Bearer',
        expiresIn: 900,
        expiresAt: '2099-01-01T00:00:00Z',
        user: {
          id: 'layout-admin',
          email: 'layout@example.test',
          role: 'admin',
          createdAt: '2026-09-18T00:00:00Z',
        },
      }),
    );
  }, theme);
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const models = [
      { id: 'synthetic-text-model', mediaTypes: ['text'], credentialId: 'layout-connection' },
    ];
    const payloads: Record<string, unknown> = {
      '/v1/settings/ai': { settings: { baseUrl: '', configured: false, defaultModels: {} } },
      '/v1/settings/ai/credentials': {
        credentials: [
          {
            id: 'layout-connection',
            baseUrl: 'https://provider.example.test/v1',
            keyFingerprint: 'sha256:layout',
            active: false,
            updatedAt: '2026-09-18T00:00:00Z',
            defaultModels: {
              text: { modelAlias: 'synthetic-text-model', credentialId: 'layout-connection' },
            },
          },
        ],
      },
      '/v1/models': { models },
      '/v1/projects': { projects: [] },
      '/v1/assets': { assets: [] },
    };
    await route.fulfill({
      status: path in payloads ? 200 : 501,
      contentType: 'application/json',
      body: JSON.stringify(payloads[path] ?? { error: `Unexpected fixture request: ${path}` }),
    });
  });
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 1000 },
  { width: 1280, height: 800 },
]) {
  for (const theme of ['light', 'dark']) {
    test(`设置页 ${viewport.width}px ${theme} 排版与键盘导航`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await installSettingsFixture(page, theme);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto('/settings');
      await page.getByRole('tab', { name: '连接与 Key', exact: true }).focus();
      await page.keyboard.press('ArrowUp');
      await expect(page.getByRole('tab', { name: '节点默认', exact: true })).toBeFocused();
      await expect(page.getByRole('tabpanel')).toHaveAccessibleName('节点默认');
      const model = page.getByRole('combobox', { name: '文字生成默认模型' });
      await expect(model).toHaveValue('synthetic-text-model');
      expect((await model.boundingBox())!.width).toBeGreaterThanOrEqual(280);
      const infoButton = page.getByRole('button', { name: '查看模型来源解析顺序' }).first();
      await infoButton.focus();
      await expect(page.getByRole('tooltip')).toBeVisible();
      const tooltip = (await page.getByRole('tooltip').boundingBox())!;
      expect(tooltip.x).toBeGreaterThanOrEqual(0);
      expect(tooltip.x + tooltip.width).toBeLessThanOrEqual(viewport.width);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await page.screenshot({ path: info.outputPath('defaults.png'), fullPage: true });
      const row = page.locator('.settings-default-row[data-media-type="text"]');
      await row.getByRole('button', { name: '配置文字生成连接' }).click();
      await expect(row.getByRole('textbox', { name: '文字生成独立连接 Base URL' })).toBeVisible();
      await row.getByRole('button', { name: '取消配置文字生成连接' }).click();
      for (const category of ['连接与 Key', '总览', '自动化', '画布外观']) {
        await page.getByRole('tab', { name: category, exact: true }).click();
        await expect(page.getByRole('tabpanel')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false,
        );
      }
      await page.getByRole('tab', { name: '画布外观', exact: true }).focus();
      await page.keyboard.press('Home');
      await expect(page.getByRole('tab', { name: '总览', exact: true })).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}

test('设置页窄屏退化时字段和工具提示保持在视口内', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSettingsFixture(page, 'light');
  await page.goto('/settings');
  await page.getByRole('tab', { name: '节点默认', exact: true }).click();
  await page.getByRole('button', { name: '查看模型来源解析顺序' }).first().focus();
  const tooltip = (await page.getByRole('tooltip').boundingBox())!;
  expect(tooltip.x).toBeGreaterThanOrEqual(0);
  expect(tooltip.x + tooltip.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
