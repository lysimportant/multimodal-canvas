import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';

import type { CanvasDocument, MediaType } from '@multimodal-canvas/domain';

test.use({ serviceWorkers: 'block' });

const project = {
  id: 'asset-share-smoke',
  name: '资源分享验收',
  createdAt: '2026-10-05T08:00:00.000Z',
  updatedAt: '2026-10-05T08:01:00.000Z',
};
const privateAsset = {
  id: 'share-image',
  name: '秋日观察图',
  mediaType: 'image' as const,
  mimeType: 'image/jpeg',
  sizeBytes: 69_636,
  status: 'ready' as const,
  latestVersion: 1,
  contentUrl: '/v1/assets/share-image/versions/1/content',
  tags: [],
};
const shareToken = 'synthetic-share-token.signature';
const protectedShareToken = 'v2.synthetic-protected-share.signature';
const expiresAt = '2030-10-12T08:00:00.000Z';
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
const video = readFileSync(new URL('../public/demo/field-study.mp4', import.meta.url));

/** 生成可由 Chromium 读取元数据的短静音 WAV。 */
function createSilentWav() {
  const sampleCount = 80_000;
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(16_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(sampleCount * 2, 40);
  return buffer;
}

const audio = createSilentWav();
const textBody = '这是一份通过只读分享链接打开的文字资源。\n不会加载项目、提示词或账户信息。';
const canvas: CanvasDocument = {
  revision: 1,
  nodes: [
    {
      id: 'share-image-node',
      type: 'image',
      position: { x: 320, y: 220 },
      width: 360,
      height: 260,
      data: {
        createdAt: project.createdAt,
        label: privateAsset.name,
        mediaType: 'image',
        mode: 'generate',
        enabled: true,
        assetId: privateAsset.id,
        mimeType: privateAsset.mimeType,
        contentUrl: privateAsset.contentUrl,
      },
    },
  ],
  edges: [],
};

type RequestRecord = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
};

type PublicFixture = {
  token: string;
  asset: {
    name: string;
    mediaType: MediaType;
    mimeType: string;
    sizeBytes: number;
    version: number;
  };
  content: Buffer | string;
  status?: number;
};

/** 返回允许跨开发端口读取的本地 JSON，不访问真实 API。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

/** 收集页面异常；验收结束时控制台和运行时错误都必须为空。 */
function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push('pageerror: ' + error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push('console: ' + message.text());
  });
  return errors;
}

/** 安装私有画布最小夹具；除固定分享外不允许生成、上传或真实数据请求。 */
async function installPrivateFixture(
  page: Page,
  requests: RequestRecord[],
  mediaType: 'image' | 'video' = 'image',
  password?: string,
) {
  const asset = {
    ...privateAsset,
    mediaType,
    mimeType: mediaType === 'video' ? 'video/mp4' : privateAsset.mimeType,
  };
  const content = mediaType === 'video' ? video : poster;
  const document: CanvasDocument = {
    ...canvas,
    nodes: canvas.nodes.map((node) => ({
      ...node,
      type: mediaType,
      data: { ...node.data, mediaType, mimeType: asset.mimeType },
    })),
  };
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-asset-share',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'asset-share-user',
          email: 'asset-share@example.test',
          role: 'user',
          createdAt: '2026-10-05T08:00:00.000Z',
        },
      }),
    );
  });
  const pageOrigin = new URL(test.info().project.use.baseURL!).origin;
  const corsHeaders = {
    'access-control-allow-origin': pageOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, HEAD, POST, PATCH, OPTIONS',
  };
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === pageOrigin) return route.continue();
    return route.abort('blockedbyclient');
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const record: RequestRecord = {
      method: request.method(),
      path: url.pathname,
      headers: await request.allHeaders(),
    };
    const rawBody = request.postData();
    if (rawBody) {
      try {
        record.body = JSON.parse(rawBody);
      } catch {
        record.body = rawBody;
      }
    }
    requests.push(record);

    const { path, method } = record;
    const privateJson = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify(body),
      });
    if (method === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: corsHeaders,
      });
    if (path === '/v1/auth/me') {
      return privateJson({
        user: {
          id: 'asset-share-user',
          email: 'asset-share@example.test',
          role: 'user',
          createdAt: project.createdAt,
        },
      });
    }
    if (path === '/v1/projects') return privateJson({ projects: [project] });
    if (path === '/v1/projects/' + project.id) return privateJson({ project });
    if (path === '/v1/projects/' + project.id + '/canvas') return privateJson({ canvas: document });
    if (path === '/v1/projects/' + project.id + '/models/defaults')
      return privateJson({ defaults: {} });
    if (path === '/v1/projects/' + project.id + '/runs') return privateJson({ runs: [] });
    if (path === '/v1/projects/' + project.id + '/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        headers: corsHeaders,
        body: ': ready\n\n',
      });
    if (path === '/v1/assets') return privateJson({ assets: [asset] });
    if (path === '/v1/prompt-skills') return privateJson({ skills: [] });
    if (path === '/v1/settings/ai')
      return privateJson({ settings: { defaultModels: {}, timeoutMs: 900_000 } });
    if (path === '/v1/models')
      return privateJson({
        models: [
          {
            id: 'mock-image',
            name: 'Mock Image',
            mediaTypes: ['image'],
            group: 'alpha',
            credentialId: 'share-credential',
            available: true,
          },
        ],
      });
    if (path.endsWith('/reverse-prompts')) return privateJson({ analysis: null });
    if (path.endsWith('/request-prompts')) return privateJson({ records: [] });
    if (path === '/v1/assets/' + privateAsset.id + '/access-url' && method === 'POST')
      return privateJson({ url: privateAsset.contentUrl });
    if (
      path === '/v1/assets/' + privateAsset.id + '/versions/1/derivatives/thumbnail' &&
      method === 'GET'
    )
      return route.fulfill({
        status: 200,
        contentType: privateAsset.mimeType,
        headers: {
          ...corsHeaders,
          'x-original-width': '960',
          'x-original-height': '640',
        },
        body: poster,
      });
    if (path === privateAsset.contentUrl && ['GET', 'HEAD'].includes(method))
      return route.fulfill({
        status: 200,
        contentType: asset.mimeType,
        headers: corsHeaders,
        body: method === 'HEAD' ? undefined : content,
      });
    if (path === '/v1/assets/' + privateAsset.id + '/share' && method === 'POST') {
      expect(record.body).toEqual({ version: 1, ...(password ? { password } : {}) });
      return privateJson({
        token: password ? protectedShareToken : shareToken,
        expiresAt,
        version: 1,
      });
    }
    return route.fulfill({ status: 418, body: '未声明的私有接口：' + method + ' ' + path });
  });
}

/** 安装匿名公开分享夹具；记录并拒绝任何会话、私有资源或生成接口。 */
async function installPublicFixture(
  page: Page,
  fixture: PublicFixture,
  requests: RequestRecord[],
  unexpected: string[],
) {
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const record: RequestRecord = {
      method: request.method(),
      path: url.pathname,
      headers: await request.allHeaders(),
    };
    requests.push(record);
    if (record.method !== 'GET') {
      unexpected.push(record.method + ' ' + url.pathname);
      return route.fulfill({ status: 405, body: '匿名分享仅允许读取' });
    }
    if (url.pathname === '/v1/asset-shares' && url.searchParams.get('token') === fixture.token) {
      if (fixture.status) return json(route, { error: 'share unavailable' }, fixture.status);
      return json(route, {
        asset: {
          ...fixture.asset,
          contentUrl: '/v1/asset-shares/content?token=' + encodeURIComponent(fixture.token),
        },
        expiresAt,
      });
    }
    if (
      url.pathname === '/v1/asset-shares/content' &&
      url.searchParams.get('token') === fixture.token &&
      !fixture.status
    ) {
      return route.fulfill({
        status: 200,
        contentType: fixture.asset.mimeType,
        headers: { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' },
        body: fixture.content,
      });
    }
    unexpected.push(record.method + ' ' + url.pathname);
    return route.fulfill({ status: 418, body: '匿名页面访问了未声明的私有接口' });
  });
}

/** 校验公开页只调用公开读取端点，且元信息与媒体请求都不携带登录身份。 */
function expectPublicOnly(
  requests: RequestRecord[],
  unexpected: string[],
  { expectContent = true }: { expectContent?: boolean } = {},
) {
  expect(unexpected).toEqual([]);
  const metadataRequests = requests.filter(({ path }) => path === '/v1/asset-shares');
  const contentRequests = requests.filter(({ path }) => path === '/v1/asset-shares/content');
  expect(metadataRequests.length).toBeGreaterThan(0);
  if (expectContent) expect(contentRequests.length).toBeGreaterThan(0);
  else expect(contentRequests).toHaveLength(0);
  expect(
    [...metadataRequests, ...contentRequests].every(
      ({ headers }) => !headers.authorization && !headers.cookie,
    ),
  ).toBe(true);
  expect(
    requests.every(
      ({ method, path, headers }) =>
        method === 'GET' &&
        ['/v1/asset-shares', '/v1/asset-shares/content'].includes(path) &&
        !headers.authorization &&
        !headers.cookie,
    ),
  ).toBe(true);
  expect(requests.some(({ path }) => path.includes('/auth/'))).toBe(false);
  expect(
    requests.some(
      ({ path }) =>
        path.startsWith('/v1/projects') ||
        path.startsWith('/v1/assets/') ||
        path.includes('/runs') ||
        path.includes('/generate') ||
        path.includes('/uploads'),
    ),
  ).toBe(false);
}

function appUrl(path: string) {
  return new URL(path, test.info().project.use.baseURL!).toString();
}

test('Dialog 自定义分享密码，匿名解锁后查看图片，刷新重新锁定', async ({
  browser,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const privateErrors = captureErrors(page);
  const privateRequests: RequestRecord[] = [];
  const password = 'synthetic-share-password';
  await installPrivateFixture(page, privateRequests, 'image', password);
  await page.goto('/projects/' + project.id);
  const node = page.locator('.react-flow__node[data-id="share-image-node"]');
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.hover();
  await node.getByRole('button', { name: /^预览图片：/ }).click();
  const viewer = page.getByRole('dialog').filter({
    has: page.getByRole('button', { name: '分享当前版本', exact: true }),
  });
  const passwordInput = viewer.getByLabel('分享查看密码', { exact: true });
  await expect(passwordInput).toHaveValue('');
  await expect(passwordInput).toHaveAttribute('type', 'password');
  await passwordInput.fill(password);
  expect(privateRequests.filter(({ path }) => path.endsWith('/share'))).toHaveLength(0);
  await viewer.getByRole('button', { name: '分享当前版本', exact: true }).click();
  const expectedUrl = appUrl('/share#token=' + protectedShareToken);
  await expect(page.getByRole('textbox', { name: '分享链接', exact: true })).toHaveValue(
    expectedUrl,
  );
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedUrl);
  expect(expectedUrl).not.toContain(password);
  await page.screenshot({
    path: testInfo.outputPath('1440x900-password-share-dialog.png'),
    animations: 'disabled',
  });
  await passwordInput.fill('synthetic-next-password');
  await expect(page.getByRole('group', { name: '资源分享链接', exact: true })).toBeHidden();
  await expect(passwordInput).toBeFocused();
  expect(
    privateRequests.filter(({ method, path }) => method === 'POST' && path.endsWith('/share')),
  ).toHaveLength(1);
  expect(privateErrors).toEqual([]);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const anonymous = await context.newPage();
  const errors = captureErrors(anonymous);
  const requests: RequestRecord[] = [];
  const accessToken = 'synthetic-browser-unlock.signature';
  let unlockCount = 0;
  let contentCount = 0;
  await anonymous.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(url.href).not.toContain(password);
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    requests.push({
      method: request.method(),
      path: url.pathname,
      headers: await request.allHeaders(),
    });
    if (url.pathname === '/v1/asset-shares/unlock' && request.method() === 'POST') {
      unlockCount++;
      const body = request.postDataJSON();
      expect(body.token).toBe(protectedShareToken);
      if (body.password !== password) return json(route, { code: 'SHARE_PASSWORD_INVALID' }, 401);
      return json(route, { accessToken, expiresAt });
    }
    expect(request.method()).toBe('GET');
    expect(url.searchParams.get('token')).toBe(protectedShareToken);
    if (url.searchParams.get('access_token') !== accessToken)
      return json(route, { code: 'SHARE_PASSWORD_REQUIRED' }, 401);
    if (url.pathname === '/v1/asset-shares')
      return json(route, {
        asset: {
          name: privateAsset.name,
          mediaType: 'image',
          mimeType: 'image/jpeg',
          sizeBytes: poster.byteLength,
          version: 1,
          contentUrl: `/v1/asset-shares/content?token=${protectedShareToken}&access_token=${accessToken}`,
        },
        expiresAt,
      });
    expect(url.pathname).toBe('/v1/asset-shares/content');
    contentCount++;
    return route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      headers: { 'access-control-allow-origin': '*' },
      body: poster,
    });
  });
  await anonymous.goto(expectedUrl);
  await expect(anonymous.getByRole('heading', { name: '此分享已设置查看密码' })).toBeVisible();
  const mascot = anonymous.getByRole('img', { name: 'LoveTV 大肥鱼（鲸鱼娘）' });
  await expect(mascot).toHaveAttribute('src', '/brand/lovetv-icon-192.png');
  await expect.poll(() => mascot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(192);
  expect(contentCount).toBe(0);
  await expect(anonymous.getByRole('link', { name: '打开原文件' })).toHaveCount(0);
  await expect(anonymous).toHaveTitle('共享资源 · LoveTV');
  await anonymous.screenshot({
    path: testInfo.outputPath('1440x900-share-unlock.png'),
    animations: 'disabled',
  });
  await anonymous.getByLabel('查看密码', { exact: true }).fill('synthetic-wrong');
  await anonymous.getByRole('button', { name: '解锁查看' }).click();
  await expect(anonymous.getByRole('alert')).toHaveText('查看密码不正确，请重新输入。');
  expect(contentCount).toBe(0);
  await anonymous.getByLabel('查看密码', { exact: true }).fill(password);
  await anonymous.getByRole('button', { name: '解锁查看' }).click();
  const image = anonymous.getByRole('img', { name: privateAsset.name, exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(anonymous.getByRole('link', { name: '打开原文件' })).toHaveAttribute(
    'href',
    new RegExp('access_token=' + accessToken),
  );
  await anonymous.getByRole('button', { name: '放大预览', exact: true }).click();
  expect(unlockCount).toBe(2);
  const contentBeforeReload = contentCount;
  expect(
    await anonymous.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    })),
  ).toEqual({ local: {}, session: {} });
  expect(new URL(anonymous.url()).hash).toBe('#token=' + protectedShareToken);
  await anonymous.reload();
  await expect(anonymous.getByRole('heading', { name: '此分享已设置查看密码' })).toBeVisible();
  await expect(anonymous.getByLabel('查看密码', { exact: true })).toHaveValue('');
  expect(contentCount).toBe(contentBeforeReload);
  expect(unlockCount).toBe(2);
  expect(
    requests.every(
      ({ headers, path }) =>
        !headers.cookie &&
        !headers.authorization &&
        ['/v1/asset-shares', '/v1/asset-shares/unlock', '/v1/asset-shares/content'].includes(path),
    ),
  ).toBe(true);
  expect(errors).toEqual(
    Array(3).fill(
      'console: Failed to load resource: the server responded with a status of 401 (Unauthorized)',
    ),
  );
  await context.close();
});

test('1440x900 从私有预览创建并复制固定版本，匿名上下文打开图片分享', async ({
  browser,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const privateErrors = captureErrors(page);
  const privateRequests: RequestRecord[] = [];
  await installPrivateFixture(page, privateRequests);
  await page.goto('/projects/' + project.id);

  const node = page.locator('.react-flow__node[data-id="share-image-node"]');
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.hover();
  await node.getByRole('button', { name: /^预览图片：/ }).click();
  const viewer = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: '分享当前版本', exact: true }) });
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: '分享当前版本', exact: true }).click();
  const shareInput = page.getByRole('textbox', { name: '分享链接', exact: true });
  const expectedUrl = appUrl('/share#token=' + shareToken);
  await expect(shareInput).toHaveValue(expectedUrl);
  await expect(page.getByText('当前第 1 版', { exact: false })).toBeVisible();
  await expect(page.getByText('无需登录', { exact: false })).toBeVisible();
  await expect(page.getByText('分享链接已复制', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedUrl);
  const shareTrigger = viewer.getByRole('button', { name: '分享当前版本', exact: true });
  const sharePanel = page.getByRole('group', { name: '资源分享链接', exact: true });
  await page.keyboard.press('Escape');
  await expect(sharePanel).toBeHidden();
  await expect(viewer).toBeVisible();
  await expect(shareTrigger).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 480 });
  const viewerBefore = await viewer.boundingBox();
  expect(viewerBefore).not.toBeNull();
  await shareTrigger.click();
  await expect(shareInput).toHaveValue(expectedUrl);
  const popover = page.locator('.asset-share-popover');
  await expect(popover).toBeVisible();
  const [viewerAfter, popoverBox] = await Promise.all([
    viewer.boundingBox(),
    popover.boundingBox(),
  ]);
  expect(viewerAfter).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(await popover.evaluate((element) => element.closest('[role="dialog"]') === null)).toBe(
    true,
  );
  expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(1280);
  expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(480);
  expect(Math.abs(viewerAfter!.x - viewerBefore!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(viewerAfter!.y - viewerBefore!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(viewerAfter!.width - viewerBefore!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(viewerAfter!.height - viewerBefore!.height)).toBeLessThanOrEqual(1);
  expect(
    privateRequests.filter(
      ({ method, path }) =>
        method === 'POST' && path === '/v1/assets/' + privateAsset.id + '/share',
    ),
  ).toHaveLength(1);
  expect(
    privateRequests.some(
      ({ method, path }) =>
        method !== 'GET' && ['/runs', '/generate', '/uploads'].some((part) => path.includes(part)),
    ),
  ).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath('1280x480-private-share-popover.png'),
    animations: 'disabled',
  });
  expect(privateErrors).toEqual([]);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const anonymous = await context.newPage();
  const publicErrors = captureErrors(anonymous);
  const publicRequests: RequestRecord[] = [];
  const unexpected: string[] = [];
  await installPublicFixture(
    anonymous,
    {
      token: shareToken,
      asset: {
        name: privateAsset.name,
        mediaType: 'image',
        mimeType: privateAsset.mimeType,
        sizeBytes: poster.byteLength,
        version: 1,
      },
      content: poster,
    },
    publicRequests,
    unexpected,
  );
  await anonymous.goto(expectedUrl);
  expect(
    await anonymous.evaluate(() => localStorage.getItem('multimodal-canvas:auth-session')),
  ).toBeNull();
  await expect(anonymous.getByText('共享资源', { exact: true })).toBeVisible();
  await expect(anonymous.getByText('只读预览', { exact: true })).toBeVisible();
  await expect(
    anonymous.getByRole('heading', { name: privateAsset.name, exact: true }),
  ).toBeVisible();
  await expect(anonymous.getByText(/图片 · 版本 1/)).toBeVisible();
  await expect(anonymous).toHaveTitle(new RegExp(privateAsset.name));
  const image = anonymous.getByRole('img', { name: privateAsset.name, exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveAttribute('src', /\/v1\/asset-shares\/content\?token=/);
  const mascot = anonymous.getByRole('img', { name: 'LoveTV 大肥鱼（鲸鱼娘）' });
  await expect(mascot).toBeVisible();
  await expect
    .poll(() => mascot.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  const ratio = anonymous.getByLabel('图片缩放比例');
  const initialRatio = await ratio.textContent();
  await anonymous.getByRole('button', { name: '放大预览', exact: true }).click();
  await expect(ratio).not.toHaveText(initialRatio!);
  await anonymous.getByRole('button', { name: '原图 1:1', exact: true }).click();
  await expect(ratio).toHaveText('100%');
  await anonymous.getByRole('button', { name: '向右旋转90度' }).click();
  await expect(image).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
  await anonymous.getByRole('button', { name: '水平翻转', exact: true }).click();
  await expect(anonymous.getByRole('button', { name: '水平翻转', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await anonymous.getByRole('button', { name: '重置图片视图' }).click();
  await expect(ratio).toHaveText(initialRatio!);
  await anonymous.screenshot({
    path: testInfo.outputPath('1440x900-public-image-share.png'),
    animations: 'disabled',
  });
  await anonymous.setViewportSize({ width: 1280, height: 480 });
  await anonymous.getByRole('button', { name: '铺满窗口', exact: true }).click();
  const stage = anonymous.getByRole('region', { name: '图片预览画布' });
  await expect(stage).toBeVisible();
  const expandedBox = await anonymous.getByRole('region', { name: '分享资源内容' }).boundingBox();
  expect(expandedBox).toMatchObject({ x: 0, y: 0, width: 1280, height: 480 });
  await anonymous.screenshot({
    path: testInfo.outputPath('1280x480-expanded-image.png'),
    animations: 'disabled',
  });
  await anonymous.keyboard.press('Escape');
  await expect(mascot).toBeVisible();
  await expect(anonymous.getByRole('button', { name: '铺满窗口', exact: true })).toBeInViewport();
  expectPublicOnly(publicRequests, unexpected);
  expect(publicErrors).toEqual([]);
  await context.close();
});

test('1280x480 视频 Dialog 播放操作完整且关闭后停止，不撑大节点', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  const errors = captureErrors(page);
  await installPrivateFixture(page, [], 'video');
  await page.goto('/projects/' + project.id);
  const node = page.locator('.react-flow__node[data-id="share-image-node"]');
  await expect(node).toBeVisible({ timeout: 15_000 });
  const before = await node.boundingBox();
  await node.hover();
  await node.getByRole('button', { name: /^预览视频：/ }).click();
  const viewer = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: '分享当前版本', exact: true }) });
  await expect(viewer).toBeVisible();
  const media = viewer.locator('video');
  await expect
    .poll(() => media.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThan(0);
  const pause = viewer.getByRole('button', { name: '暂停视频', exact: true });
  // Dialog 可在显式打开后自动播放；被浏览器阻止时仍可手动播放。
  if (!(await pause.isVisible()))
    await viewer.getByRole('button', { name: '播放视频', exact: true }).first().click();
  await expect
    .poll(() => media.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0);
  await pause.click();
  await expect.poll(() => media.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await viewer.getByLabel('播放速度', { exact: true }).selectOption('1.5');
  expect(await media.evaluate((element: HTMLVideoElement) => element.playbackRate)).toBe(1.5);
  await expect(viewer.getByLabel('播放速度', { exact: true })).toBeInViewport();
  const box = await viewer.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(480);
  await page.screenshot({
    path: testInfo.outputPath('1280x480-video-dialog.png'),
    animations: 'disabled',
  });
  const mediaHandle = await media.elementHandle();
  await viewer.getByRole('button', { name: '播放视频', exact: true }).first().click();
  await viewer.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(viewer).toBeHidden();
  expect(await mediaHandle!.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  const after = await node.boundingBox();
  expect(after!.width).toBe(before!.width);
  expect(after!.height).toBe(before!.height);
  expect(errors).toEqual([]);
});

test('1366x768 匿名页展示视频、音频、文字并明确显示失效链接', async ({ browser }, testInfo) => {
  const fixtures: PublicFixture[] = [
    {
      token: 'synthetic-public-video-token.signature',
      asset: {
        name: '共享观察视频',
        mediaType: 'video',
        mimeType: 'video/mp4',
        sizeBytes: video.byteLength,
        version: 2,
      },
      content: video,
    },
    {
      token: 'synthetic-public-audio-token.signature',
      asset: {
        name: '共享静音音轨',
        mediaType: 'audio',
        mimeType: 'audio/wav',
        sizeBytes: audio.byteLength,
        version: 3,
      },
      content: audio,
    },
    {
      token: 'synthetic-public-text-token.signature',
      asset: {
        name: '共享文字说明',
        mediaType: 'text',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(textBody, 'utf8'),
        version: 4,
      },
      content: textBody,
    },
  ];

  for (const fixture of fixtures) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const requests: RequestRecord[] = [];
    const unexpected: string[] = [];
    await installPublicFixture(page, fixture, requests, unexpected);
    await page.goto(appUrl('/share#token=' + encodeURIComponent(fixture.token)));
    expect(
      await page.evaluate(() => localStorage.getItem('multimodal-canvas:auth-session')),
    ).toBeNull();
    await expect(
      page.getByRole('heading', { name: fixture.asset.name, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(new RegExp('版本 ' + fixture.asset.version))).toBeVisible();
    await expect(page).toHaveTitle(new RegExp(fixture.asset.name));
    if (fixture.asset.mediaType === 'video' || fixture.asset.mediaType === 'audio') {
      const media = page.getByLabel(fixture.asset.name, { exact: true });
      await expect(media).toBeVisible();
      await expect
        .poll(() => media.evaluate((element: HTMLVideoElement) => element.readyState))
        .toBeGreaterThan(0);
      expect(await media.evaluate((element: HTMLMediaElement) => element.paused)).toBe(true);
      // 使用真实媒体解码和用户点击，确保按钮确实驱动播放而非仅切换图标。
      const kindLabel = fixture.asset.mediaType === 'video' ? '视频' : '音频';
      await page
        .getByRole('button', { name: '播放' + kindLabel, exact: true })
        .first()
        .click();
      await expect
        .poll(() => media.evaluate((element: HTMLMediaElement) => element.currentTime))
        .toBeGreaterThan(0);
      await page.getByRole('button', { name: '暂停' + kindLabel, exact: true }).click();
      await expect
        .poll(() => media.evaluate((element: HTMLMediaElement) => element.paused))
        .toBe(true);
      await page.getByLabel('播放速度', { exact: true }).selectOption('1.5');
      expect(await media.evaluate((element: HTMLMediaElement) => element.playbackRate)).toBe(1.5);
      await page.getByRole('button', { name: '循环播放', exact: true }).click();
      expect(await media.evaluate((element: HTMLMediaElement) => element.loop)).toBe(true);
      await expect(media).toHaveAttribute('controls', '');
      await page.setViewportSize({ width: 1280, height: 480 });
      await expect(page.getByLabel('播放速度', { exact: true })).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath('1280x480-public-' + fixture.asset.mediaType + '.png'),
        animations: 'disabled',
      });
      await page.setViewportSize({ width: 1366, height: 768 });
    } else {
      await expect(page.locator('pre')).toHaveText(textBody);
    }
    await page.screenshot({
      path: testInfo.outputPath('1366x768-public-' + fixture.asset.mediaType + '-share.png'),
      animations: 'disabled',
    });
    expectPublicOnly(requests, unexpected);
    expect(errors).toEqual([]);
    await context.close();
  }

  const expiredToken = 'synthetic-expired-share-token.signature';
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const errors = captureErrors(page);
  const requests: RequestRecord[] = [];
  const unexpected: string[] = [];
  await installPublicFixture(
    page,
    {
      token: expiredToken,
      asset: {
        name: '已失效资源',
        mediaType: 'video',
        mimeType: 'video/mp4',
        sizeBytes: video.byteLength,
        version: 1,
      },
      content: video,
      status: 410,
    },
    requests,
    unexpected,
  );
  await page.goto(appUrl('/share#token=' + expiredToken));
  await expect(page.getByRole('heading', { name: '暂时无法查看资源' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('分享链接已失效或资源不可用');
  await page.screenshot({
    path: testInfo.outputPath('1366x768-expired-share.png'),
    animations: 'disabled',
  });
  expectPublicOnly(requests, unexpected, { expectContent: false });
  expect(errors).toEqual([
    'console: Failed to load resource: the server responded with a status of 410 (Gone)',
  ]);
  await context.close();
});
