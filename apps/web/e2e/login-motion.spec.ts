/** 独立认证页面的浏览器验收；账户及项目接口全部使用合成响应。 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

/** 内容入场时记录真实计算样式，不调整动画速度。 */
type MotionFrame = { time: number; opacity: number; translationY: number };

/** 每个独立浏览器上下文自行持有采样状态。 */
type MotionWindow = Window & {
  authenticationMotionFrames?: MotionFrame[];
  authenticationMotionSampling?: boolean;
};

/** 认证写入的精确请求，用于检查无隐式项目创建。 */
type SyntheticWrite = { path: string; body: unknown; authorization?: string };

/** 合成身份不与本地或正式账户共享任何凭据。 */
const session = {
  accessToken: 'synthetic-authentication-browser-token',
  tokenType: 'Bearer',
  expiresIn: 900,
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: {
    id: 'authentication-browser-user',
    email: 'authentication@example.test',
    role: 'user',
    createdAt: '2026-09-06T00:00:00.000Z',
  },
};

/** 安装最小业务 API，记录副作用且拒绝真实业务网络回退。 */
async function installSyntheticApi(page: Page) {
  const writes: SyntheticWrite[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.removeItem('multimodal-canvas:auth-session');
    localStorage.setItem('multimodal-canvas:theme', 'light');
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET')
      writes.push({
        path,
        body: request.postDataJSON(),
        authorization: request.headers().authorization,
      });
    let body: unknown;
    let status = 200;
    if (path === '/v1/projects' && request.method() === 'GET') body = { projects: [] };
    else if (
      (path === '/v1/auth/login' || path === '/v1/auth/verify') &&
      request.method() === 'POST'
    )
      body = session;
    else if (path === '/v1/auth/register' && request.method() === 'POST') {
      body = {
        verificationRequired: true,
        email: session.user.email,
        delivery: { id: 'synthetic-delivery', status: 'accepted' },
      };
      status = 202;
    } else {
      errors.push(`未声明的模拟接口：${request.method()} ${path}`);
      body = { error: '此测试不允许访问真实业务接口' };
      status = 400;
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/workspace');
  await expect(page.getByRole('heading', { name: '项目工作台' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { writes, errors };
}

/** 在导航之前启动 RAF 采样，捕获真实页面入场动画。 */
async function startSampling(page: Page) {
  await page.evaluate(() => {
    const target = window as MotionWindow;
    target.authenticationMotionFrames = [];
    target.authenticationMotionSampling = true;
    const startedAt = performance.now();
    const sample = () => {
      if (!target.authenticationMotionSampling || performance.now() - startedAt > 2500) return;
      const content = document.querySelector<HTMLElement>('.auth-entry-content');
      if (content) {
        const style = getComputedStyle(content);
        target.authenticationMotionFrames!.push({
          time: performance.now() - startedAt,
          opacity: Number(style.opacity),
          translationY: style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m42,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

/** 停止采样并保存独立证据附件，返回期间采集的全部帧。 */
async function stopSampling(page: Page, info: TestInfo) {
  const samples = await page.evaluate(() => {
    const target = window as MotionWindow;
    target.authenticationMotionSampling = false;
    return target.authenticationMotionFrames ?? [];
  });
  const path = info.outputPath('authentication-motion-samples.json');
  await writeFile(path, JSON.stringify(samples, null, 2));
  await info.attach('authentication-motion-samples', { path, contentType: 'application/json' });
  return samples;
}

/** 等待认证内容与页面快照过渡结束后截图；无限装饰动画不阻塞视觉验收。 */
async function screenshotSettledPage(page: Page, info: TestInfo, name: string, fullPage = true) {
  await page.evaluate(async () => {
    const nextFrames = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    await nextFrames();
    const animations = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.allSettled(animations.map((animation) => animation.finished));
    await nextFrames();
  });
  await page.screenshot({ path: info.outputPath(name), fullPage });
}

/** 新建入口指向独立登录页，仅携带受控的站内续接路径。 */
async function openCreateLogin(page: Page) {
  await page.locator('.mc-workspace-heading').getByRole('button', { name: '新建项目' }).click();
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/auth/login');
  expect(new URL(page.url()).searchParams.get('next')).toBe('/workspace?create=1');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.auth-backdrop')).toHaveCount(0);
}

for (const viewport of [
  { width: 1440, height: 960 },
  { width: 390, height: 844 },
]) {
  test(`${viewport.width}px独立换页、真实入场动效、浏览器返回清理密码`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const { writes, errors } = await installSyntheticApi(page);
    await startSampling(page);
    await openCreateLogin(page);
    await expect(page.locator('.auth-entry-content')).toHaveCSS('opacity', '1');
    const samples = await stopSampling(page, info);
    expect(samples.some((sample) => sample.opacity > 0 && sample.opacity < 1)).toBe(true);
    expect(samples.some((sample) => sample.translationY > 0)).toBe(true);
    await expect(page.getByLabel('邮箱', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
    await page.getByLabel('密码', { exact: true }).fill('synthetic-secret-password');
    await page.getByRole('link', { name: '创建账户', exact: true }).click();
    await expect(page.getByRole('heading', { name: '创建账户' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/auth/register');
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('确认密码', { exact: true })).toBeVisible();
    await screenshotSettledPage(page, info, 'register-page.png');
    await page.goBack();
    await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
    await screenshotSettledPage(page, info, 'login-page.png');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('link', { name: '返回工作台' }).click();
    await expect(page).toHaveURL('/workspace');
    await expect(page.getByRole('heading', { name: '项目工作台' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const persisted = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
    expect(persisted).not.toContain('synthetic-secret-password');
    expect(page.url()).not.toContain('synthetic-secret-password');
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('登录确认后只恢复一次可填写的新建表单，不自动创建项目', async ({ page }, info) => {
  const { writes, errors } = await installSyntheticApi(page);
  await openCreateLogin(page);
  await page.getByLabel('邮箱', { exact: true }).fill(session.user.email);
  await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL('/workspace');
  const createDialog = page.getByRole('dialog', { name: '新建项目' });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByLabel('项目名称')).toBeFocused();
  await createDialog.getByLabel('项目名称').fill('认证后手动创建的项目');
  await expect(createDialog.getByLabel('项目名称')).toHaveValue('认证后手动创建的项目');
  await screenshotSettledPage(page, info, 'login-resumed-create.png', false);
  await createDialog.getByRole('button', { name: '取消' }).click();
  await expect(createDialog).toHaveCount(0);
  expect(writes).toEqual([
    {
      path: '/v1/auth/login',
      body: { email: session.user.email, password: 'synthetic-password' },
      authorization: undefined,
    },
  ]);
  expect(errors).toEqual([]);
});

test('注册校验后进入验证码独立页面，确认直接返回工作台且不继承新建意图', async ({ page }, info) => {
  const { writes, errors } = await installSyntheticApi(page);
  await openCreateLogin(page);
  await page.getByRole('link', { name: '创建账户', exact: true }).click();
  await expect(page.getByRole('heading', { name: '创建账户' })).toBeVisible();
  await page.getByLabel('显示名称（可选）', { exact: true }).fill('合成验证用户');
  await page.getByLabel('邮箱', { exact: true }).fill(session.user.email);
  await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
  await page.getByLabel('确认密码', { exact: true }).fill('different-password');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不一致');
  expect(writes).toEqual([]);
  await page.getByLabel('确认密码', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await expect(page.getByRole('heading', { name: '验证你的邮箱' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/auth/verify');
  expect(new URL(page.url()).searchParams.get('next')).toBeNull();
  await expect(page.getByLabel('邮箱验证码')).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem('multimodal-canvas:auth-session')),
  ).toBeNull();
  await screenshotSettledPage(page, info, 'verification-page.png');
  await page.getByLabel('邮箱验证码').fill('123456');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page).toHaveURL('/workspace');
  await expect(page.getByRole('heading', { name: '项目工作台' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '账户菜单' })).toBeVisible();
  expect(writes).toEqual([
    {
      path: '/v1/auth/register',
      body: {
        email: session.user.email,
        password: 'synthetic-password',
        displayName: '合成验证用户',
      },
      authorization: undefined,
    },
    {
      path: '/v1/auth/verify',
      body: { email: session.user.email, purpose: 'register', code: '123456' },
      authorization: undefined,
    },
  ]);
  const persisted = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
  expect(persisted).not.toContain('123456');
  expect(persisted).not.toContain('synthetic-password');
  expect(errors).toEqual([]);
});

test('验证码刷新保留邮箱流程，不保存验证码或重复注册，确认仍回工作台', async ({ page }) => {
  const { writes, errors } = await installSyntheticApi(page);
  await page.goto(`/auth/verify?email=${encodeURIComponent(session.user.email)}&purpose=register`);
  await expect(page.getByRole('heading', { name: '验证你的邮箱' })).toBeVisible();
  await page.getByLabel('邮箱验证码').fill('654321');
  await page.reload();
  await expect(page.getByRole('heading', { name: '验证你的邮箱' })).toBeVisible();
  await expect(page.getByLabel('邮箱验证码')).toHaveValue('');
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue(session.user.email);
  expect(writes).toEqual([]);
  await page.getByLabel('邮箱验证码').fill('123456');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page).toHaveURL('/workspace');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes.map((write) => write.path)).toEqual(['/v1/auth/verify']);
  expect(errors).toEqual([]);
});

test('减少动态效果时停用认证入场动画，链接导航仍正常', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { writes, errors } = await installSyntheticApi(page);
  await openCreateLogin(page);
  await expect(page.locator('.auth-entry-content')).toHaveCSS('animation-name', 'none');
  await page.getByRole('link', { name: '创建账户', exact: true }).click();
  await expect(page.getByRole('heading', { name: '创建账户' })).toBeVisible();
  await expect(page.locator('.auth-entry-content')).toHaveCSS('animation-name', 'none');
  await screenshotSettledPage(page, info, 'reduced-motion-register.png');
  await page.getByRole('link', { name: '返回登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  await page.getByRole('link', { name: '返回工作台' }).click();
  await expect(page).toHaveURL('/workspace');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
