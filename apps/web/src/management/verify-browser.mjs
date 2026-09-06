/** 完整 Web 应用的管理页面视觉与交互回归；所有业务响应都是合成数据。 */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

/** 可由外部指定已运行的 Web，不启动额外服务器或发送真实邮件。 */
const baseUrl = process.env.WEB_BASE_URL ?? 'http://127.0.0.1:5187';
/** 截图存放于仓库忽略的测试产物目录。 */
const output = resolve('../../.data/management-review');
await mkdir(output, { recursive: true });
/** 固定测试时间避免截图文案随运行时间变化。 */
const timestamp = '2026-09-06T00:00:00.000Z';
/** 所有邮箱都是 IANA 保留测试域名。 */
const admin = {
  id: 'admin-review',
  email: 'administrator@example.test',
  displayName: '管理员',
  role: 'admin',
  status: 'active',
  emailVerifiedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  bio: '创作团队管理员',
};
/** 超长用户资料用于验证表格和侧栏截断。 */
const author = {
  ...admin,
  id: 'author-review',
  email: 'author-with-a-long-address-for-layout-review@example.test',
  displayName: '创作者甲',
  role: 'user',
};
/** 第二用户只拥有自己分组的数据。 */
const secondAuthor = {
  ...author,
  id: 'second-review',
  email: 'another@example.test',
  displayName: '创作者乙',
};
/** 图片预览复用仓库的真实公开演示图片。 */
const image = await readFile(resolve('public/demo/field-study-poster.jpg'));
/** 测试资源覆盖四类媒体与上传、生成来源。 */
const assets = ['image', 'text', 'audio', 'video'].map((mediaType, index) => ({
  id: `asset-${mediaType}`,
  name: ['场景分镜参考.jpg', '项目文字设定.txt', '旁白音频.wav', '片段预览.webm'][index],
  mediaType,
  mimeType: { image: 'image/jpeg', text: 'text/plain', audio: 'audio/wav', video: 'video/webm' }[
    mediaType
  ],
  sizeBytes: index === 0 ? image.length : 2048,
  ownerId: author.id,
  projectId: 'project-review',
  status: 'ready',
  source: index % 2 ? 'generated' : 'upload',
  tags: ['项目素材', index % 2 ? '生成' : '参考'],
  createdAt: timestamp,
  updatedAt: timestamp,
  contentUrl: `/v1/assets/asset-${mediaType}/content`,
  latestVersion: 2,
}));
/** 图像以外使用明确的纯文本预览测试，音视频解码由现有全站媒体测试覆盖。 */
const browser = await chromium.launch({ headless: true });
/** 错误收集只记录合成测试产生的异常。 */
const errors = [];
/** 记录被执行的写操作以验证归档、保存以及无意注销。 */
const mutations = [];
/** 不同桌面尺寸共享同一组管理页面，避免遗漏次级页面。 */
const pageChecks = [
  ['/admin', '管理概览', 'overview-desktop'],
  ['/admin/users', '用户管理', 'users-desktop'],
  ['/admin/resources', '用户资源', 'resource-groups-desktop'],
  ['/admin/users/author-review', '创作者甲', 'user-detail-desktop'],
  ['/account/profile', '个人信息', 'profile-desktop'],
  ['/account/security', '账户安全', 'security-desktop'],
  ['/admin/runs', '全站任务', 'runs-desktop'],
  ['/admin/audit', '操作记录', 'audit-desktop'],
  ['/admin/settings/email', '邮件服务', 'email-desktop'],
];

/** 安装固定管理数据，不访问真实 API、邮箱或数据库。 */
async function mockApi(page) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method !== 'GET') mutations.push({ path, method });
    /** 单个响应采用标准 JSON，不伪造浏览器本身的登录行为。 */
    const json = (value, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/v1/admin/bootstrap')
      return json({ initialized: true, mailConfigured: true, setupTokenRequired: false });
    if (path === '/v1/auth/me') return json({ user: admin });
    if (path === '/v1/admin/overview')
      return json({
        users: { total: 3, active: 2, pending: 1, disabled: 0 },
        resources: { total: 4, storageBytes: image.length + 6144, unassigned: 0 },
        runs: { total: 12, failed: 1, active: 2 },
        mail: { configured: true, failed: 0 },
      });
    if (path === '/v1/admin/users')
      return json({
        users: [admin, author, { ...secondAuthor, status: 'pending', emailVerifiedAt: undefined }],
        total: 3,
        page: 1,
        pageSize: 20,
      });
    if (path.startsWith('/v1/admin/users/'))
      return json({
        user: author,
        projects: [{ id: 'project-review', name: '短片创作', updatedAt: timestamp }],
        stats: { resourceCount: 4, storageBytes: image.length + 6144, runCount: 12 },
      });
    if (path === '/v1/admin/resource-groups')
      return json({
        groups: [
          { ownerId: author.id, user: author, resourceCount: 4, storageBytes: image.length + 6144 },
          { ownerId: secondAuthor.id, user: secondAuthor, resourceCount: 0, storageBytes: 0 },
          { ownerId: null, user: null, resourceCount: 0, storageBytes: 0 },
        ],
      });
    if (path === '/v1/admin/resources' || path === '/v1/account/resources')
      return json({
        assets: assets.filter(
          (asset) =>
            !url.searchParams.get('status') || asset.status === url.searchParams.get('status'),
        ),
        total: 4,
        page: 1,
        pageSize: 24,
      });
    const resource = /^\/v1\/(?:admin|account)\/resources\/(asset-[^/]+)(\/content)?$/.exec(path);
    if (resource) {
      const asset = assets.find((item) => item.id === resource[1]);
      if (!asset) return json({ error: '不存在' }, 404);
      if (resource[2])
        return route.fulfill({
          contentType: asset.mediaType === 'image' ? 'image/jpeg' : 'text/plain',
          body:
            asset.mediaType === 'image'
              ? image
              : '这是受控读取的测试文本资源。\n<script>文本不会作为 HTML 执行。</script>',
        });
      if (method === 'PATCH') Object.assign(asset, request.postDataJSON());
      return json({
        asset,
        project: { id: 'project-review', name: '短片创作' },
        versions: [
          { version: 1, sizeBytes: asset.sizeBytes, createdAt: timestamp },
          { version: 2, sizeBytes: asset.sizeBytes, createdAt: timestamp },
        ],
      });
    }
    if (path === '/v1/account/profile') {
      if (method === 'PATCH') Object.assign(admin, request.postDataJSON());
      return json({ user: admin });
    }
    if (path === '/v1/account/sessions')
      return json({
        sessions: [
          {
            id: 'session-current',
            createdAt: timestamp,
            lastUsedAt: timestamp,
            expiresAt: '2099-01-01T00:00:00.000Z',
            current: true,
          },
          {
            id: 'session-other',
            createdAt: timestamp,
            lastUsedAt: timestamp,
            expiresAt: '2099-01-01T00:00:00.000Z',
            current: false,
          },
        ],
      });
    if (path === '/v1/admin/runs' || path === '/v1/account/runs')
      return json({
        runs: [
          {
            id: 'run-review',
            projectId: 'project-review',
            targetNodeId: 'node-review',
            status: 'succeeded',
            progress: 100,
            modelAlias: '创作模型',
            ownerId: author.id,
            user: author,
            createdAt: timestamp,
            updatedAt: timestamp,
            result: { summary: '生成完成', asset: { assetId: 'asset-text' } },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    if (path === '/v1/admin/audit')
      return json({
        events: [
          {
            id: 'audit-review',
            actorId: admin.id,
            ownerId: author.id,
            targetId: author.id,
            action: 'user.profile.update',
            summary: '已修改用户资料',
            createdAt: timestamp,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 30,
      });
    if (path === '/v1/admin/system')
      return json({
        api: { status: 'ok' },
        storage: { status: 'ok' },
        queue: { status: 'available' },
        mail: {
          configured: true,
          host: 'smtp.example.test',
          port: 465,
          secure: true,
          from: 'no-reply@example.test',
          deliveries: [
            {
              id: 'delivery-review',
              to: secondAuthor.email,
              purpose: 'invite',
              status: 'accepted',
              createdAt: timestamp,
            },
          ],
        },
      });
    if (path === '/v1/projects') return json({ projects: [] });
    if (path === '/v1/assets') return json({ assets: [] });
    if (path.includes('credentials')) return json({ credentials: [] });
    if (path.includes('models')) return json({ models: [], data: [] });
    if (path.includes('settings'))
      return json({ configured: false, defaultModels: {}, baseUrl: '' });
    return json({ error: `未模拟的接口 ${path}` }, 404);
  });
}

/** 验证完整页面没有不必要的横向溢出并保存实际渲染截图。 */
async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const hasDialog = (await page.locator('dialog[open]').count()) > 0;
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: !hasDialog });
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(
    dimensions.scroll <= dimensions.viewport + 1,
    `${name} 出现整页横向溢出: ${JSON.stringify(dimensions)}`,
  );
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  await context.addInitScript((user) => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        user,
        accessToken: 'synthetic-review-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    );
    localStorage.setItem('multimodal-canvas:theme', 'light');
  }, admin);
  const page = await context.newPage();
  await mockApi(page);
  for (const [path, heading, name] of pageChecks) {
    await page.goto(`${baseUrl}${path}`);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    await screenshot(page, name);
  }
  await page.goto(`${baseUrl}/admin/users/author-review/resources`);
  await page.getByRole('heading', { name: '创作者甲的资源' }).waitFor();
  await page.getByRole('button', { name: /场景分镜参考/ }).waitFor();
  await screenshot(page, 'resources-desktop');
  await page.getByRole('button', { name: /场景分镜参考/ }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('img', { name: '场景分镜参考.jpg' }).waitFor();
  await screenshot(page, 'image-preview-desktop');
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await page.getByRole('button', { name: '确认归档' }).click();
  await page.getByRole('button', { name: '恢复', exact: true }).waitFor();
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByRole('button', { name: '归档', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /项目文字设定/ }).click();
  await page.getByText('<script>文本不会作为 HTML 执行。</script>', { exact: false }).waitFor();
  assert.equal(await page.locator('.mg-media-preview script').count(), 0);
  await screenshot(page, 'text-preview-desktop');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '账户菜单' }).click();
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(mutations.filter((mutation) => mutation.path.includes('logout')).length, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/account/profile`);
  await page.getByRole('heading', { name: '个人信息', exact: true }).waitFor();
  await screenshot(page, 'profile-mobile');
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.locator('.mg-sidebar').getByRole('link', { name: '账户安全', exact: true }).waitFor();
  await screenshot(page, 'sidebar-mobile');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.mg-sidebar').getAttribute('inert'), '');
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.locator('.mg-sidebar').getByRole('link', { name: '账户安全', exact: true }).click();
  await page.getByRole('heading', { name: '账户安全', exact: true }).waitFor();
  await screenshot(page, 'security-mobile');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${baseUrl}/admin/users`);
  await page.getByRole('heading', { name: '用户管理', exact: true }).waitFor();
  await screenshot(page, 'users-1280');
  await page.getByRole('button', { name: '创建普通用户' }).click();
  await page.getByRole('dialog').waitFor();
  await screenshot(page, 'invite-desktop');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  // 720x450 仅模拟 1440x900 在 200% 缩放后的 CSS 布局空间，不更改真实浏览器缩放。
  for (const viewport of [
    { width: 1920, height: 1080, name: '1920' },
    { width: 720, height: 450, name: '200pct-equivalent-720x450' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const [path, heading, name] of pageChecks) {
      await page.goto(`${baseUrl}${path}`);
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      await screenshot(page, `${name.replace(/-desktop$/, '')}-${viewport.name}`);
      const accountFooter = await page.locator('.mg-sidebar-user').boundingBox();
      assert.ok(
        accountFooter && accountFooter.y + accountFooter.height <= viewport.height + 1,
        `${viewport.name} 侧栏账户区域被裁切`,
      );
    }
    await page.locator('.mg-sidebar').getByRole('link', { name: '系统状态', exact: true }).click();
    await page.getByRole('heading', { name: '系统状态', exact: true }).waitFor();
    await screenshot(page, `system-${viewport.name}`);
    await page.goto(`${baseUrl}/admin/users/author-review/resources`);
    await page.getByRole('heading', { name: '创作者甲的资源' }).waitFor();
    await page.getByRole('button', { name: /场景分镜参考/ }).waitFor();
    await screenshot(page, `resources-${viewport.name}`);
    await page.getByRole('button', { name: /场景分镜参考/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const preview = page.getByRole('img', { name: '场景分镜参考.jpg' });
    await preview.waitFor();
    assert.ok(
      await preview.evaluate((element) => element.naturalWidth > 0),
      `${viewport.name} 图片没有实际解码`,
    );
    const bounds = await dialog.boundingBox();
    assert.ok(
      bounds &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= viewport.width + 1 &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= viewport.height + 1,
      `${viewport.name} 资源弹窗超出视口`,
    );
    assert.ok(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      `${viewport.name} 资源弹窗出现横向溢出`,
    );
    await screenshot(page, `image-preview-${viewport.name}`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.goto(`${baseUrl}/admin/users`);
    await page.getByRole('button', { name: '创建普通用户' }).click();
    await dialog.waitFor();
    await screenshot(page, `invite-${viewport.name}`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'passed',
      screenshots: output,
      consoleErrors: errors.length,
      archiveMutations: mutations.filter(
        (mutation) => mutation.path.endsWith('/asset-image') && mutation.method === 'PATCH',
      ).length,
      logoutMutations: 0,
      viewports: ['1440x900', '1280x720', '390x844', '1920x1080', '720x450'],
      zoomLayoutCheck: {
        equivalentCssViewport: '720x450',
        referenceViewport: '1440x900',
        percent: 200,
        actualBrowserZoom: false,
      },
    }),
  );
} finally {
  await browser.close();
}
