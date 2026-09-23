/** New API 唯一登录入口的浏览器回归；所有认证响应均为本地合成数据。 */
import { expect, test, type Page, type Route } from '@playwright/test';

/** 返回 JSON 响应，避免测试请求落到真实认证服务。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** 安装匿名 Cookie 会话和 New API 授权入口夹具。 */
async function installAnonymousAuthFixture(page: Page) {
  const authorizationRequests: URL[] = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/v1/auth/me') {
      await json(route, { error: 'unauthorized' }, 401);
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/v1/auth/refresh') {
      await json(route, { error: 'unauthorized' }, 401);
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/v1/auth/newapi/start') {
      authorizationRequests.push(url);
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>New API authorization fixture</title>',
      });
      return;
    }
    await json(
      route,
      { error: `Unexpected fixture request: ${request.method()} ${url.pathname}` },
      501,
    );
  });
  return authorizationRequests;
}

test('旧认证地址统一显示 New API 登录入口且不回显旧字段', async ({ page }) => {
  await installAnonymousAuthFixture(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  for (const path of ['/auth/register', '/auth/verify', '/auth/forgot-password']) {
    await page.goto(`${path}?email=secret%40example.test&purpose=register&error=private-detail`);
    await expect(page.getByRole('heading', { name: '使用 New API 登录' })).toBeVisible();
    await expect(page.getByRole('button', { name: '使用 New API 登录' })).toBeEnabled();
    await expect(page.getByRole('alert')).toContainText('登录未完成');
    await expect(page.getByLabel('邮箱')).toHaveCount(0);
    await expect(page.getByLabel('密码')).toHaveCount(0);
    await expect(page.getByText(/secret@example\.test|private-detail/)).toHaveCount(0);
  }

  expect(pageErrors).toEqual([]);
});

test('登录按钮只带受控 next 跳转到 New API，窄屏和减少动态效果均不溢出', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const authorizationRequests = await installAnonymousAuthFixture(page);
  await page.goto('/auth/login?next=%2Fprojects%2Fproject-a');

  const content = page.locator('.auth-entry-content');
  await expect(content).toHaveCSS('animation-name', 'none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('newapi-login-mobile.png'), fullPage: true });

  await page.getByRole('button', { name: '使用 New API 登录' }).click();
  await expect.poll(() => authorizationRequests.length).toBe(1);
  expect(authorizationRequests[0]!.pathname).toBe('/v1/auth/newapi/start');
  expect(authorizationRequests[0]!.searchParams.get('next')).toBe('/projects/project-a');
});

test('会话校验超过 10 秒后仍能进入页面，不重复请求', async ({ page }) => {
  test.setTimeout(40_000);
  const pageErrors: string[] = [];
  let checks = 0;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/v1/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/v1/auth/me') {
      checks++;
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      await json(route, {
        user: { id: 'e2e-user', role: 'user', createdAt: '2026-01-01T00:00:00Z' },
        expiresAt: '2099-01-01T00:00:00Z',
      });
      return;
    }
    await json(route, { error: 'unexpected fixture request' }, 501);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Multimodal Canvas' })).toBeVisible({
    timeout: 20_000,
  });
  expect(checks).toBe(1);
  await expect(page.getByLabel('关闭账户提示')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('会话超时明确提示检查 Canvas API 而非回显浏览器异常', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) =>
      String(input).endsWith('/v1/auth/me')
        ? Promise.reject(new DOMException('signal timed out', 'TimeoutError'))
        : originalFetch(input, init);
  });

  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Canvas API 会话校验超时');
  await expect(page.getByRole('alert')).not.toContainText('signal timed out');
});

test('已缓存登录遇到暂时故障不退出，焦点恢复后自动续期', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        user: { id: 'synthetic-e2e-user', role: 'user', createdAt: '2026-01-01T00:00:00Z' },
        expiresAt: '2026-01-01T00:00:00Z',
      }),
    );
  });
  let connected = false;
  let refreshes = 0;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/auth/me') return json(route, { error: 'unauthorized' }, 401);
    if (path === '/v1/auth/refresh') {
      refreshes++;
      return connected
        ? json(route, {
            user: { id: 'synthetic-e2e-user', role: 'user', createdAt: '2026-01-01T00:00:00Z' },
            expiresAt: '2099-01-01T00:00:00Z',
          })
        : json(route, { error: 'temporary outage' }, 503);
    }
    return json(route, { error: 'unavailable' }, 503);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Multimodal Canvas' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('当前内容已保留');
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('multimodal-canvas:auth-session')!).user.id,
    ),
  ).toBe('synthetic-e2e-user');
  connected = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect
    .poll(async () =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('multimodal-canvas:auth-session')!).expiresAt,
      ),
    )
    .toBe('2099-01-01T00:00:00Z');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(refreshes).toBeGreaterThanOrEqual(2);
  expect(pageErrors).toEqual([]);
});
