import { expect, test } from '@playwright/test';

/** 匿名页面验收不接触真实账号、资源或生成接口。 */
test.beforeEach(async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/auth/me' || path === '/v1/auth/refresh') {
      await route.fulfill({ status: 401, json: { error: 'unauthorized' } });
      return;
    }
    throw new Error(`公开页不应调用业务接口：${path}`);
  });
});

test('公开入口首响应包含 LoveTV、正式域名与鲸鱼娘图标', async ({ request }) => {
  for (const path of ['/', '/contact']) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain(`href="https://love.lolicon.beer${path}"`);
    expect(html).toContain('name="description"');
    expect(html).toMatch(/AI (?:生成|图片生成)/);
    expect(html).toContain('application/ld+json');
    expect(html).toContain('/brand/favicon.ico');
    expect(html).not.toMatch(/Multimodal Canvas|MULTIMODAL CANVAS/);
  }
  const icon = await request.get('/brand/favicon.ico');
  expect(icon.ok()).toBe(true);
  expect((await icon.body()).byteLength).toBeGreaterThan(100);
});

test('分享入口首响应提供通用卡片且明确禁止收录', async ({ request }) => {
  const response = await request.get('/share');
  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain('<title>共享资源 · LoveTV</title>');
  expect(html).toContain('content="noindex, nofollow"');
  expect(html).toContain('property="og:image:type" content="image/jpeg"');
  expect(html).not.toMatch(/<link\s+rel="canonical"/);
  expect(html).toContain('property="og:url" content="https://love.lolicon.beer/share"');
  expect(html).not.toContain('id="lovetv-structured-data"');
});

test('通用卡片的品牌 JPEG 无需登录即可解码且尺寸匹配声明', async ({ page }) => {
  const response = await page.goto('/brand/lovetv-social.jpg');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toContain('image/jpeg');
  const image = page.locator('img');
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(1200);
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalHeight)).toBe(630);
});

test('站内跳转同步标题及 canonical，工作台不收录', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page).toHaveTitle('LoveTV');
  await expect(page.getByRole('heading', { level: 1, name: 'LoveTV' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'LoveTV 主页', exact: true })).toBeVisible();
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute(
    'href',
    'https://love.lolicon.beer/',
  );
  const brand = page.locator('.mc-navigation-brand img');
  await expect(brand).toBeVisible();
  await expect
    .poll(() => brand.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(brand).toHaveCSS('filter', 'none');
  await page.locator('.mc-navigation-header-link').filter({ hasText: '联系我们' }).click();
  await expect(page).toHaveTitle(/关于 LoveTV/);
  await expect(page.getByRole('heading', { level: 1, name: '联系我们' })).toBeVisible();
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute(
    'href',
    'https://love.lolicon.beer/contact',
  );
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.screenshot({ path: info.outputPath('lovetv-contact-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: '进入工作台', exact: true }).click();
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.locator('link[rel=canonical]')).toHaveCount(0);
  await expect(page.locator('#lovetv-structured-data')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveTitle(/关于 LoveTV/);
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /index, follow/);
  expect(errors).toEqual([]);
});

test('离开分享页不会恢复旧标题或将令牌写入搜索标签', async ({ page }) => {
  await page.goto('/share#invalid-private-token');
  await expect(page).toHaveTitle('共享资源 · LoveTV');
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    'https://love.lolicon.beer/share',
  );
  expect(await page.locator('head').innerHTML()).not.toContain('invalid-private-token');
  await page.evaluate(() => {
    history.pushState(null, '', '/contact');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: '联系我们', level: 1 })).toBeVisible();
  await expect(page).toHaveTitle(/关于 LoveTV/);
  await expect(page.locator('link[rel=canonical]')).toHaveCount(1);
});
