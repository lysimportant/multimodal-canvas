/** 真实浏览器中的登录侧栏动效验收；账户及项目接口全部使用合成响应。 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

/** 单帧采样包含真实计算样式和退出交互状态。 */
type MotionFrame = {
  time: number;
  state: string | null;
  opacity: number;
  translationX: number;
  panelWidth: number;
  inert: boolean;
  disabled: boolean;
};

/** 页面内采样状态由每个独立浏览器上下文自行持有。 */
type MotionWindow = Window & {
  loginMotionFrames?: MotionFrame[];
  loginMotionSampling?: boolean;
  loginMotionRunId?: number;
};

/** 合成身份不与本地或正式账户共享任何凭据。 */
const session = {
  accessToken: 'synthetic-login-motion-browser-token',
  tokenType: 'Bearer',
  expiresIn: 900,
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: {
    id: 'login-motion-browser-user',
    email: 'motion@example.test',
    role: 'user',
    createdAt: '2026-09-06T00:00:00.000Z',
  },
};

/** 安装完整应用需要的最小业务 API，记录副作用且拒绝真实网络回退。 */
async function installSyntheticApi(page: Page) {
  const writes: string[] = [];
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
    if (request.method() !== 'GET') writes.push(path);
    let body: unknown;
    let status = 200;
    if (path === '/v1/projects' && request.method() === 'GET') body = { projects: [] };
    else if (path === '/v1/auth/login' || path === '/v1/auth/verify') body = session;
    else if (path === '/v1/auth/register') {
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

/** 每帧读取实际 transform 与 opacity，不通过修改动画速度制造中间状态。 */
async function startSampling(page: Page) {
  await page.evaluate(() => {
    const target = window as MotionWindow;
    target.loginMotionFrames = [];
    target.loginMotionSampling = true;
    const runId = (target.loginMotionRunId ?? 0) + 1;
    target.loginMotionRunId = runId;
    const startedAt = performance.now();
    const sample = () => {
      if (
        !target.loginMotionSampling ||
        target.loginMotionRunId !== runId ||
        performance.now() - startedAt > 2500
      )
        return;
      const backdrop = document.querySelector<HTMLElement>('.auth-backdrop');
      const panel = backdrop?.querySelector<HTMLElement>('.auth-panel');
      if (backdrop && panel) {
        const transform = getComputedStyle(panel).transform;
        target.loginMotionFrames!.push({
          time: performance.now() - startedAt,
          state: backdrop.dataset.state ?? null,
          opacity: Number(getComputedStyle(backdrop).opacity),
          translationX: transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41,
          panelWidth: panel.getBoundingClientRect().width,
          inert: panel.inert,
          disabled: Array.from(panel.querySelectorAll<HTMLInputElement>('input')).every(
            (input) => input.disabled,
          ),
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

/** 停止当前采样，并将样本保存在独立的测试附件目录。 */
async function stopSampling(page: Page, info: TestInfo, phase: string) {
  const samples = await page.evaluate(() => {
    const target = window as MotionWindow;
    target.loginMotionSampling = false;
    return target.loginMotionFrames ?? [];
  });
  const path = info.outputPath(`${phase}-motion-samples.json`);
  await writeFile(path, JSON.stringify(samples, null, 2));
  await info.attach(`${phase}-motion-samples`, { path, contentType: 'application/json' });
  return samples;
}

/** 等待运动中间帧，保证截图与位移采样发生于动画期间。 */
async function waitForIntermediateFrame(page: Page, phase: 'opening' | 'closing') {
  await page.waitForFunction(
    (expectedPhase) => {
      const backdrop = document.querySelector<HTMLElement>('.auth-backdrop');
      const panel = backdrop?.querySelector<HTMLElement>('.auth-panel');
      if (
        !backdrop ||
        !panel ||
        (expectedPhase === 'closing' && backdrop.dataset.state !== 'closing')
      )
        return false;
      const opacity = Number(getComputedStyle(backdrop).opacity);
      const x = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41;
      return (
        opacity > 0.02 && opacity < 0.98 && x > 2 && x < panel.getBoundingClientRect().width - 2
      );
    },
    phase,
    { polling: 'raf' },
  );
}

/** 面板到位时必须完全位于当前视口且保持预期的侧栏宽度。 */
async function expectPanelSettled(page: Page) {
  await expect
    .poll(() =>
      page
        .locator('.auth-panel')
        .evaluate((panel) => new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41),
    )
    .toBe(0);
  await expect(page.locator('.auth-backdrop')).toHaveCSS('opacity', '1');
  const bounds = await page.locator('.auth-panel').boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBe(Math.min(410, viewport.width));
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`${viewport.width}px 真实进退场中间帧、卸载和焦点恢复`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const { writes, errors } = await installSyntheticApi(page);
    const trigger = page.locator('.mc-workspace-heading').getByRole('button', { name: '新建项目' });
    await startSampling(page);
    await trigger.click();
    await waitForIntermediateFrame(page, 'opening');
    await page.screenshot({ path: info.outputPath('entering.png'), animations: 'allow' });
    await expectPanelSettled(page);
    await expect(page.getByLabel('邮箱', { exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath('open.png'), animations: 'allow' });
    const opening = await stopSampling(page, info, 'opening');
    expect(
      opening.some(
        (frame) =>
          frame.translationX > 2 &&
          frame.translationX < frame.panelWidth - 2 &&
          frame.opacity > 0.02 &&
          frame.opacity < 0.98,
      ),
    ).toBe(true);
    await startSampling(page);
    await page.getByRole('button', { name: '关闭登录' }).click();
    await waitForIntermediateFrame(page, 'closing');
    await page.screenshot({ path: info.outputPath('leaving.png'), animations: 'allow' });
    await expect(page.locator('.auth-backdrop')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.locator('.mc-page-shell')).not.toHaveAttribute('inert');
    await page.screenshot({ path: info.outputPath('closed.png') });
    const closing = await stopSampling(page, info, 'closing');
    expect(
      closing.some(
        (frame) =>
          frame.state === 'closing' &&
          frame.translationX > 2 &&
          frame.translationX < frame.panelWidth - 2 &&
          frame.opacity > 0.02 &&
          frame.opacity < 0.98,
      ),
    ).toBe(true);
    expect(
      closing
        .filter((frame) => frame.state === 'closing')
        .every((frame) => frame.inert && frame.disabled),
    ).toBe(true);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    console.log(
      JSON.stringify({
        viewport: `${viewport.width}x${viewport.height}`,
        openingFrames: opening.length,
        closingFrames: closing.length,
        authenticationPosts: writes.length,
        projectPosts: 0,
        consoleErrors: errors.length,
      }),
    );
  });
}

test('合成登录完成退场后续接可填写的新建表单，不自动创建项目', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { writes, errors } = await installSyntheticApi(page);
  await page.locator('.mc-workspace-heading').getByRole('button', { name: '新建项目' }).click();
  await expectPanelSettled(page);
  const dialog = page.getByRole('dialog', { name: '登录工作区' });
  await dialog.getByLabel('邮箱').fill(session.user.email);
  await dialog.getByLabel('密码').fill('synthetic-password');
  await dialog.getByRole('button', { name: '登录', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: '新建项目' });
  await expect(createDialog).toBeVisible();
  await expect(page.locator('.auth-backdrop')).toHaveCount(0);
  await expect(createDialog.getByLabel('项目名称')).toBeFocused();
  await createDialog.getByLabel('项目名称').fill('动效验证后的项目');
  await expect(createDialog.getByLabel('项目名称')).toHaveValue('动效验证后的项目');
  await page.screenshot({ path: info.outputPath('login-resumed-create.png') });
  expect(writes).toEqual(['/v1/auth/login']);
  expect(errors).toEqual([]);
});

test('注册202完成邮箱验证后续接新建表单，不重复注册或创建', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { writes, errors } = await installSyntheticApi(page);
  await page.locator('.mc-workspace-heading').getByRole('button', { name: '新建项目' }).click();
  await expectPanelSettled(page);
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  const registerDialog = page.getByRole('dialog', { name: '创建账户' });
  await registerDialog.getByLabel('邮箱').fill(session.user.email);
  await registerDialog.getByLabel('密码').fill('synthetic-password');
  await registerDialog.getByRole('button', { name: '注册', exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/verify\?/);
  await expect(page.locator('.auth-backdrop')).toHaveCount(0);
  await expect(page.getByLabel('邮箱验证码')).toBeFocused();
  await page.getByLabel('邮箱验证码').fill('123456');
  await page.getByRole('button', { name: '验证并进入工作台' }).click();
  await expect(page).toHaveURL('/workspace');
  const createDialog = page.getByRole('dialog', { name: '新建项目' });
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel('项目名称').fill('已验证账户的项目');
  await expect(createDialog.getByLabel('项目名称')).toHaveValue('已验证账户的项目');
  await page.screenshot({ path: info.outputPath('register-resumed-create.png') });
  expect(writes).toEqual(['/v1/auth/register', '/v1/auth/verify']);
  expect(errors).toEqual([]);
});

test('390px减少动态效果时无CSS过渡且不等待退出动画', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { writes, errors } = await installSyntheticApi(page);
  const trigger = page.locator('.mc-workspace-heading').getByRole('button', { name: '新建项目' });
  await trigger.click();
  await expectPanelSettled(page);
  await expect(page.locator('.auth-panel')).toHaveCSS('transition-duration', '0s');
  await expect(page.locator('.auth-backdrop')).toHaveCSS('transition-duration', '0s');
  await page.screenshot({ path: info.outputPath('reduced-motion-open.png') });
  const removalMs = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const startedAt = performance.now();
        const observer = new MutationObserver(() => {
          if (document.querySelector('.auth-backdrop')) return;
          observer.disconnect();
          resolve(performance.now() - startedAt);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        document.querySelector<HTMLButtonElement>('.auth-panel [aria-label="关闭登录"]')!.click();
      }),
  );
  expect(removalMs).toBeLessThan(160);
  await expect(trigger).toBeFocused();
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      reducedMotion: true,
      removalMs,
      skippedAnimationMs: 220,
      projectPosts: 0,
      consoleErrors: errors.length,
    }),
  );
});
