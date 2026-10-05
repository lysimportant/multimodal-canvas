/** New API 设置页布局验收使用合成账号与目录，不访问供应商或真实凭据。 */
import { expect, test, type Page, type Route } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

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

/** 项目弹窗只读取合成项目和空画布，不创建或修改真实项目。 */
const fixtureProject = {
  id: 'settings-layout-project',
  name: '设置主题离线验收',
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z',
};

/** 空画布没有媒体、节点或运行任务，打开设置不应产生写请求。 */
const fixtureCanvas = { revision: 0, nodes: [], edges: [], groups: [] };

/** 返回 JSON 响应，保持设置页浏览器测试完全隔离。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** 安装离线设置与项目合同；仅放行本站静态资源，记录浏览器错误及全部写请求。 */
async function installSettingsFixture(
  page: Page,
  theme: string,
  options: { account?: typeof fixtureAccount; syncAccount?: typeof fixtureAccount } = {},
) {
  await page.addInitScript(
    ({ theme, user, projectId }) => {
      localStorage.setItem('multimodal-canvas:theme', theme);
      localStorage.setItem('multimodal-canvas:project-id', projectId);
      localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user }));
    },
    { theme, user: fixtureUser, projectId: fixtureProject.id },
  );
  let settings = {
    defaultModels: {
      text: { modelAlias: 'shared-text-model', credentialId: 'credential-alpha' },
    },
    timeoutMs: 900_000,
  };
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const unexpected: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const webOrigin = new URL(test.info().project.use.baseURL!).origin;
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      let body: unknown = request.postData() ?? {};
      if (
        typeof body === 'string' &&
        request.headers()['content-type']?.includes('application/json')
      ) {
        try {
          body = JSON.parse(body);
        } catch {
          unexpected.push(`Invalid JSON request: ${method} ${path}`);
        }
      }
      writes.push({ method, path, body });
    }
    if (!path.startsWith('/v1/')) {
      const documentRequest =
        request.resourceType() === 'document' &&
        (path === '/settings' || path === `/projects/${fixtureProject.id}`);
      const staticRequest =
        ['script', 'stylesheet', 'font', 'image', 'media'].includes(request.resourceType()) &&
        /^\/(?:assets\/|brand\/|src\/|node_modules\/|@vite\/|@id\/|@fs\/|@react-refresh$)/.test(
          path,
        );
      if (url.origin === webOrigin && method === 'GET') {
        if (documentRequest || staticRequest) {
          await route.continue();
          return;
        }
        if (path === '/favicon.ico') {
          await route.fulfill({ status: 204, body: '' });
          return;
        }
      }
      unexpected.push(`${method} ${url.origin}${path}`);
      await route.abort('blockedbyclient');
      return;
    }
    if (method === 'GET' && path === '/v1/auth/me') {
      await json(route, { user: fixtureUser, expiresAt: '2099-01-01T00:00:00.000Z' });
      return;
    }
    if (method === 'GET' && path === '/v1/projects') {
      await json(route, { projects: [fixtureProject] });
      return;
    }
    if (method === 'GET' && path === `/v1/projects/${fixtureProject.id}`) {
      await json(route, { project: fixtureProject });
      return;
    }
    if (method === 'GET' && path === `/v1/projects/${fixtureProject.id}/canvas`) {
      await json(route, { canvas: fixtureCanvas });
      return;
    }
    if (method === 'GET' && path === `/v1/projects/${fixtureProject.id}/models/defaults`) {
      await json(route, { defaults: {}, resolvedDefaults: {} });
      return;
    }
    if (method === 'GET' && path === `/v1/projects/${fixtureProject.id}/runs`) {
      await json(route, { runs: [] });
      return;
    }
    if (method === 'GET' && path === `/v1/projects/${fixtureProject.id}/events`) {
      // 204 结束空项目的 SSE 订阅，避免后台重连干扰只读验收。
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (method === 'GET' && path === '/v1/assets') {
      await json(route, { assets: [] });
      return;
    }
    if (method === 'GET' && path === '/v1/prompt-skills') {
      await json(route, { skills: [] });
      return;
    }
    if (method === 'GET' && path === '/v1/account/newapi') {
      await json(route, { account: options.account ?? fixtureAccount });
      return;
    }
    if (method === 'POST' && path === '/v1/account/newapi/sync') {
      await json(route, { account: options.syncAccount ?? fixtureAccount });
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
      settings = { ...settings, ...body } as typeof settings;
      await json(route, { settings });
      return;
    }
    unexpected.push(`${method} ${path}`);
    await json(route, { error: `Unexpected fixture request: ${method} ${path}` }, 501);
  });
  return { unexpected, writes, consoleErrors, pageErrors };
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
    expect(fixture.consoleErrors).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

test('PC 设置页同步后展示服务端自动修复的分组，不发送浏览器 repair 请求', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const missingAccount = {
    ...fixtureAccount,
    groups: [
      {
        group: 'alpha',
        credentialId: 'credential-alpha',
        credentialVersion: 4,
        repairable: false,
        repairPending: false,
        status: 'missing',
        error: '分组 Key 正在自动恢复',
        modelCount: 0,
      },
    ],
  };
  const repairedAccount = {
    ...fixtureAccount,
    groups: [
      {
        group: 'alpha',
        credentialId: 'credential-alpha',
        credentialVersion: 5,
        repairable: false,
        repairPending: false,
        status: 'active',
        modelCount: 2,
      },
    ],
  };
  const fixture = await installSettingsFixture(page, 'light', {
    account: missingAccount,
    syncAccount: repairedAccount,
  });
  await page.goto('/settings');

  await expect(page.getByText('分组 Key 正在自动恢复')).toBeVisible();
  await page.getByRole('button', { name: '同步分组与模型' }).click();
  await expect(page.getByRole('cell', { name: 'active' })).toBeVisible();
  await expect(page.getByText('分组 Key 正在自动恢复')).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('newapi-auto-repair-after-sync.png'),
    fullPage: true,
    animations: 'disabled',
  });

  expect(fixture.writes.filter((entry) => entry.path.includes('/groups/'))).toEqual([]);
  expect(fixture.writes.filter((entry) => entry.path === '/v1/account/newapi/sync')).toHaveLength(
    1,
  );
  expect(
    fixture.consoleErrors.filter((error) => !error.includes('ERR_BLOCKED_BY_CLIENT.Inspector')),
  ).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ['eye-care', 'light', 'dark', 'sepia', 'contrast']) {
  for (const presentation of ['page', 'dialog']) {
    const entry = presentation === 'page' ? '独立 /settings 页' : '项目 Settings dialog';
    test(`设置分组表格 ${theme} 主题在 ${entry} 使用主题 token`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const fixture = await installSettingsFixture(page, theme);
      if (presentation === 'page') {
        await page.goto('/settings');
        await expect(page.getByRole('heading', { name: 'New API 与模型设置' })).toBeVisible();
      } else {
        await page.goto(`/projects/${fixtureProject.id}`);
        await expect(page.locator('.react-flow')).toBeVisible();
        await page.getByRole('button', { name: '打开设置', exact: true }).click();
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const panel =
        presentation === 'page'
          ? page.locator('.settings-panel-page')
          : page.getByRole('dialog', { name: 'New API 与模型', exact: true });
      await expect(panel).toBeVisible();
      const table = panel.locator('.settings-models-table');
      await expect(table.getByRole('cell', { name: 'alpha', exact: true })).toBeVisible();
      await expect(table.getByRole('cell', { name: 'beta', exact: true })).toBeVisible();

      const tokens = await table.evaluate((element) => {
        const style = getComputedStyle(element);
        const probe = document.createElement('span');
        probe.hidden = true;
        document.body.append(probe);
        try {
          return Object.fromEntries(
            ['--mc-surface', '--mc-surface-soft', '--mc-text', '--mc-text-muted'].map((name) => {
              const value = style.getPropertyValue(name).trim();
              if (!value) throw new Error(`缺少主题 token：${name}`);
              // 浏览器将 token 的十六进制等表示转换成与 computed style 一致的颜色。
              probe.style.color = value;
              return [name, getComputedStyle(probe).color];
            }),
          );
        } finally {
          probe.remove();
        }
      });
      await expect(table).toHaveCSS('background-color', tokens['--mc-surface']);
      await expect(table).toHaveCSS('color', tokens['--mc-text']);
      const headers = table.locator('thead th');
      await expect(headers).toHaveCount(3);
      for (const header of await headers.all()) {
        await expect(header).toHaveCSS('background-color', tokens['--mc-surface-soft']);
        await expect(header).toHaveCSS('color', tokens['--mc-text-muted']);
      }
      await expect(table.locator('tbody')).toHaveCSS('color', tokens['--mc-text']);
      await expect(table.locator('tbody code')).toHaveCount(2);
      for (const cell of await table.locator('tbody td, tbody code').all()) {
        await expect(cell).toHaveCSS('color', tokens['--mc-text']);
      }
      if (theme === 'dark' || theme === 'eye-care') {
        await page.screenshot({
          path: testInfo.outputPath(`settings-group-table-${presentation}-${theme}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      }
      expect(fixture.writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.consoleErrors).toEqual([]);
      expect(fixture.pageErrors).toEqual([]);
    });
  }
}
