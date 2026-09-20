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
