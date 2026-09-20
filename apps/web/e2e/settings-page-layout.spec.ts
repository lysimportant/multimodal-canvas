/** New API 设置页布局验收使用合成账号与目录，不访问供应商或真实凭据。 */
import { expect, test, type Page, type Route } from '@playwright/test';

const fixtureUser = {
  id: 'layout-user',
  displayName: '布局验收账号',
  role: 'user',
  createdAt: '2026-09-21T00:00:00.000Z',
};

const fixtureAccount = {
  issuer: 'https://newapi.example.test',
  externalUserId: 'newapi-layout-user',
  displayName: '布局验收账号',
  status: 'active',
  syncedAt: '2026-09-21T00:00:00.000Z',
  groups: [
    { group: 'alpha', credentialId: 'credential-alpha', status: 'ready', modelCount: 2 },
    { group: 'beta', credentialId: 'credential-beta', status: 'ready', modelCount: 1 },
  ],
  links: { models: 'https://newapi.example.test/pricing' },
};

const fixtureModels = [
  {
    id: 'shared-text-model',
    name: '同名文字模型',
    group: 'alpha',
    credentialId: 'credential-alpha',
    mediaTypes: ['text'],
    available: true,
  },
  {
    id: 'shared-text-model',
    name: '同名文字模型',
    group: 'beta',
    credentialId: 'credential-beta',
    mediaTypes: ['text'],
    available: true,
  },
  {
    id: 'image-model',
    name: '图片模型',
    group: 'alpha',
    credentialId: 'credential-alpha',
    mediaTypes: ['image'],
    available: true,
  },
];

/** 返回 JSON 响应，保持设置页浏览器测试完全隔离。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** 安装当前设置合同并记录写请求与未知接口。 */
async function installSettingsFixture(page: Page, theme: string) {
  await page.addInitScript(
    ({ theme, user }) => {
      localStorage.setItem('multimodal-canvas:theme', theme);
      localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user }));
    },
    { theme, user: fixtureUser },
  );
  let settings = {
    defaultModels: {
      text: { modelAlias: 'shared-text-model', credentialId: 'credential-alpha' },
    },
    timeoutMs: 900_000,
  };
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const unexpected: string[] = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (method === 'GET' && path === '/v1/auth/me') {
      await json(route, { user: fixtureUser, expiresAt: '2099-01-01T00:00:00.000Z' });
      return;
    }
    if (method === 'GET' && path === '/v1/projects') {
      await json(route, { projects: [] });
      return;
    }
    if (method === 'GET' && path === '/v1/account/newapi') {
      await json(route, { account: fixtureAccount });
      return;
    }
    if (method === 'POST' && path === '/v1/account/newapi/sync') {
      writes.push({ method, path, body: {} });
      await json(route, { account: fixtureAccount });
      return;
    }
    if (method === 'GET' && path === '/v1/models') {
      await json(route, { models: fixtureModels });
      return;
    }
    if (path === '/v1/settings/ai' && method === 'GET') {
      await json(route, { settings });
      return;
    }
    if (path === '/v1/settings/ai' && method === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method, path, body });
      settings = { ...settings, ...body } as typeof settings;
      await json(route, { settings });
      return;
    }
    unexpected.push(`${method} ${path}`);
    await json(route, { error: `Unexpected fixture request: ${method} ${path}` }, 501);
  });
  return { unexpected, writes };
}

for (const viewport of [
  { width: 1440, height: 900, theme: 'light' },
  { width: 1024, height: 768, theme: 'dark' },
  { width: 390, height: 844, theme: 'light' },
]) {
  test(`设置页 ${viewport.width}px 展示账号分组并支持键盘切换`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await installSettingsFixture(page, viewport.theme);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto('/settings');

    await expect(page.getByRole('heading', { name: 'New API 与模型设置' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'alpha' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'beta' })).toBeVisible();
    await expect(page.getByText(/Base URL|API Key|连接与 Key/)).toHaveCount(0);

    const overviewTab = page.getByRole('tab', { name: 'New API 账号' });
    await overviewTab.focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: '画布外观' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(overviewTab).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '节点默认' })).toBeFocused();
    await expect(page.getByRole('tabpanel', { name: '节点默认' })).toBeVisible();

    const model = page.getByRole('combobox', { name: '文字' });
    await expect(model.getByRole('option', { name: '同名文字模型 · alpha' })).toHaveCount(1);
    await expect(model.getByRole('option', { name: '同名文字模型 · beta' })).toHaveCount(1);
    await model.selectOption(JSON.stringify(['credential-beta', 'shared-text-model']));
    await page.getByRole('button', { name: '保存' }).click();
    await expect
      .poll(() => fixture.writes.filter((entry) => entry.path === '/v1/settings/ai').length)
      .toBe(1);
    const save = fixture.writes.find((entry) => entry.path === '/v1/settings/ai');
    expect(save?.body).toEqual({
      defaultModels: {
        text: { modelAlias: 'shared-text-model', credentialId: 'credential-beta' },
      },
      timeoutMs: 900_000,
    });

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('newapi-settings.png'), fullPage: true });
    expect(pageErrors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
