/** 后台真实 HTTP/Prisma/浏览器验收；邮件只进入内存替身，模型使用既有 mock 执行器。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/** 仅连接现有隔离测试 PG 实例；每次使用新数据库，保留结果以便复核。 */
const root = process.cwd();
const database = `mc_admin_browser_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
const controlUrl =
  'postgresql://test_user:synthetic-test-password@127.0.0.1:19432/postgres?schema=public';
const databaseUrl = `postgresql://test_user:synthetic-test-password@127.0.0.1:19432/${database}?schema=public`;
const webUrl = process.env.ADMIN_BROWSER_WEB_URL ?? 'http://127.0.0.1:5187';
const evidence = resolve(root, '.data/admin-browser', database);
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const { PrismaClient } = requireApi('@prisma/client');
const { chromium, expect } = requireWeb('@playwright/test');
const password = 'Synthetic-browser-pass-2026';
const checks = [];
const pageErrors = [];
const consoleErrors = [];
await mkdir(evidence, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  API_AUTH_TOKEN: '',
  API_JWT_SECRET: 'synthetic-admin-browser-session-secret',
  AI_CREDENTIAL_ENCRYPTION_KEY: 'synthetic-browser-encryption-key-2026',
  ADMIN_SETUP_TOKEN: '',
  API_TRUST_PROXY_HOPS: '0',
  API_AUTH_RATE_LIMIT_PER_MINUTE: '2000',
  API_RATE_LIMIT_PER_MINUTE: '4000',
  WORKER_PROVIDER: 'mock',
  RUN_SERVICE: 'memory',
  CORS_ORIGIN: webUrl,
});

/** 只创建固定前缀的新测试数据库，不清空/迁移其他数据库。 */
const control = new PrismaClient({ datasourceUrl: controlUrl });
await control.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
await control.$disconnect();
execFileSync(
  process.execPath,
  [resolve(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
  { cwd: root, env: process.env, stdio: 'pipe' },
);

const { buildApp } = await import('../../apps/api/src/app.ts');
const { PrismaAuthStore } = await import('../../apps/api/src/auth-store.ts');
const { PrismaProjectStore } = await import('../../apps/api/src/projects.ts');
const { PrismaAssetStore, FileSystemBlobStore } = await import('../../apps/api/src/assets.ts');
const { MemoryRunService } = await import('../../apps/api/src/runs.ts');
const { TestAccountMailSender } = await import('../../apps/api/src/fixtures/account-mail.ts');
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const authStore = new PrismaAuthStore(prisma);
const mail = new TestAccountMailSender();
const app = buildApp({
  logger: false,
  authStore,
  accountMailSender: mail,
  projectStore: new PrismaProjectStore(prisma),
  assetStore: new PrismaAssetStore(prisma, {
    blobStore: new FileSystemBlobStore(resolve(evidence, 'assets')),
  }),
  // 每阶段保留可观察的两秒窗口，核验离开画布不会取消正在执行的任务。
  runService: new MemoryRunService({ providerName: 'mock', stepDelayMs: 2000 }),
});
await app.listen({ host: '127.0.0.1', port: 0 });
const apiUrl = app.listeningOrigin;
const browser = await chromium.launch({ headless: true });

/** 浏览器仍加载真实应用，只将 API 的目的端口指向本次真实隔离服务。 */
async function newPage() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.route('**/v1/**', (route) => {
    const target = new URL(route.request().url());
    assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
    return route.continue({ url: `${apiUrl}${target.pathname}${target.search}` });
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return page;
}

/** 只读取合成浏览器上下文中的会话，绝不打印令牌。 */
async function token(page) {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem('multimodal-canvas:auth-session')).accessToken,
  );
}

/** 通过真实服务接口发出有状态请求，供浏览器操作后的存储与越权断言。 */
async function request(page, method, path, body) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await token(page)}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response;
}

try {
  const admin = await newPage();
  await admin.goto(`${webUrl}/admin`);
  await expect(admin.getByRole('heading', { name: '创建管理员账户' })).toBeVisible();
  await admin.getByLabel('管理员昵称').fill('验收管理员');
  await admin.getByLabel('邮箱', { exact: true }).fill('admin@example.test');
  await admin.getByLabel('密码', { exact: true }).fill(password);
  await admin.getByLabel('确认密码', { exact: true }).fill(password);
  await admin.getByRole('button', { name: '发送验证邮件', exact: true }).click();
  await expect(admin.getByLabel('邮箱验证码')).toBeVisible();
  await admin.getByLabel('邮箱验证码').fill(mail.latest('admin@example.test', 'bootstrap').code);
  await admin.getByRole('button', { name: '验证并完成初始化' }).click();
  await expect(admin.getByRole('heading', { name: '管理概览' })).toBeVisible();
  await admin.reload();
  await expect(admin.getByRole('heading', { name: '管理概览' })).toBeVisible();
  assert.equal(
    (await fetch(`${apiUrl}/v1/admin/bootstrap`).then((response) => response.json())).initialized,
    true,
  );
  await admin.screenshot({ path: resolve(evidence, 'admin-overview.png'), fullPage: true });
  checks.push('首次 /admin 配置、邮件验证、持久化初始化、刷新后不重新初始化');

  await admin.getByLabel('后台导航').getByRole('link', { name: '用户管理', exact: true }).click();
  for (const name of ['A', 'B']) {
    await admin.getByRole('button', { name: '创建普通用户', exact: true }).click();
    const dialog = admin.getByRole('dialog', { name: '创建普通用户' });
    await dialog.getByLabel('邮箱', { exact: true }).fill(`${name.toLowerCase()}@example.test`);
    await dialog.getByLabel('昵称', { exact: true }).fill(`用户${name}`);
    await dialog.getByRole('button', { name: '创建并发送邀请' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      admin.getByText(`${name.toLowerCase()}@example.test`, { exact: true }),
    ).toBeVisible();
  }
  await admin.screenshot({ path: resolve(evidence, 'admin-users.png'), fullPage: true });
  checks.push('管理员通过真实界面邀请 A/B，待验证用户持久化');

  const userA = await newPage();
  const userB = await newPage();
  for (const [page, email] of [
    [userA, 'a@example.test'],
    [userB, 'b@example.test'],
  ]) {
    await page.goto(`${webUrl}/auth/verify?${new URLSearchParams({ email, purpose: 'invite' })}`);
    await page.getByLabel('邮箱验证码').fill(mail.latest(email, 'invite').code);
    await page.getByLabel('新密码', { exact: true }).fill(password);
    await page.getByLabel('确认新密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('heading', { name: '项目工作台' })).toBeVisible();
    await page.getByRole('button', { name: '账户菜单' }).click();
    await expect(page.getByRole('menuitem', { name: '管理后台' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    assert.equal((await request(page, 'GET', '/v1/admin/users')).status, 403);
  }
  checks.push('A/B 邮件激活与设置密码；普通用户菜单及管理 API 权限');

  const registered = await newPage();
  let registrationProjectPosts = 0;
  registered.on('request', (entry) => {
    if (entry.method() === 'POST' && new URL(entry.url()).pathname === '/v1/projects')
      registrationProjectPosts++;
  });
  await registered.goto(`${webUrl}/workspace`);
  await registered.getByRole('button', { name: '新建项目', exact: true }).first().click();
  await expect(registered).toHaveURL(/\/auth\/login\?/);
  await expect(registered.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  await registered.getByRole('link', { name: '创建账户', exact: true }).click();
  await expect(registered).toHaveURL(/\/auth\/register\?/);
  await registered.getByLabel('显示名称（可选）').fill('注册验收用户');
  await registered.getByLabel('邮箱', { exact: true }).fill('registered@example.test');
  await registered.getByLabel('密码', { exact: true }).fill(password);
  await registered.getByLabel('确认密码', { exact: true }).fill(password);
  await registered.getByRole('button', { name: '注册', exact: true }).click();
  await expect(registered).toHaveURL(/\/auth\/verify\?/);
  assert.equal(
    await registered.evaluate(() => localStorage.getItem('multimodal-canvas:auth-session')),
    null,
  );
  assert.equal(new URL(registered.url()).searchParams.has('next'), false);
  await registered.reload();
  await expect(registered.getByLabel('邮箱', { exact: true })).toHaveValue(
    'registered@example.test',
  );
  await registered
    .getByLabel('邮箱验证码')
    .fill(mail.latest('registered@example.test', 'register').code);
  await registered.screenshot({
    path: resolve(evidence, 'registration-verify.png'),
    fullPage: true,
  });
  await registered.getByRole('button', { name: '确认', exact: true }).click();
  await expect(registered).toHaveURL(`${webUrl}/workspace`);
  await expect(registered.getByRole('heading', { name: '项目工作台' })).toBeVisible();
  await expect(registered.getByRole('dialog')).toHaveCount(0);
  assert.equal(registrationProjectPosts, 0);
  assert.ok(
    (await request(registered, 'GET', '/v1/account/profile').then((reply) => reply.json())).user
      .emailVerifiedAt,
  );
  checks.push(
    '真实登录页到注册页，再到可刷新验证码页；确认激活后回工作台，无提前会话、自动创建或创建弹窗',
  );

  await registered.getByRole('button', { name: '账户菜单' }).click();
  await registered.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(registered.getByRole('button', { name: '登录账户' })).toBeVisible();
  await registered.goto(`${webUrl}/auth/login?next=%2Fresources`);
  await registered.getByLabel('邮箱', { exact: true }).fill('registered@example.test');
  await registered.getByLabel('密码', { exact: true }).fill(password);
  await registered.getByRole('button', { name: '登录', exact: true }).click();
  await expect(registered).toHaveURL(`${webUrl}/resources`);
  assert.equal((await request(registered, 'GET', '/v1/account/profile')).status, 200);
  assert.equal(registrationProjectPosts, 0);
  checks.push('已激活账户可通过独立登录页重新登录，受控返回我的资源页，不重放注册或项目创建');

  await userA.getByRole('button', { name: '新建项目', exact: true }).first().click();
  const create = userA.getByRole('dialog', { name: '新建项目' });
  await create.getByLabel('项目名称').fill('用户A验收项目');
  await create.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(userA.locator('.app-shell')).toBeVisible();
  const projectPath = new URL(userA.url()).pathname;
  await userA
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: '用户A上传.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('隔离验收上传文本'),
    });
  await expect
    .poll(
      async () => {
        const resources = await request(userA, 'GET', '/v1/account/resources').then((response) =>
          response.json(),
        );
        return resources.assets?.filter((asset) => asset.source === 'upload').length;
      },
      { timeout: 15000 },
    )
    .toBe(1);
  await userA.getByRole('button', { name: '新建文字生成节点' }).click();
  await userA.locator('.node-quick-editor textarea').fill('真实接口验收文本结果');
  const originalUserId = (
    await request(userA, 'GET', '/v1/account/profile').then((response) => response.json())
  ).user.id;
  const originalNodeSize = await userA.locator('.flow-generate-node').evaluate((node) => ({
    width: node.clientWidth,
    height: node.clientHeight,
  }));
  let logoutRequests = 0;
  let runRequests = 0;
  userA.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/auth/logout'))
      logoutRequests++;
    if (req.method() === 'POST' && /\/nodes\/[^/]+\/runs$/.test(new URL(req.url()).pathname))
      runRequests++;
  });
  await userA.getByRole('button', { name: '生成', exact: true }).click();
  await expect
    .poll(
      async () => {
        const result = await request(userA, 'GET', '/v1/account/runs').then((response) =>
          response.json(),
        );
        return result.runs[0]?.status;
      },
      { timeout: 12000, intervals: [100, 200] },
    )
    .toBe('running');
  const executionCanvas = (
    await request(userA, 'GET', `/v1${projectPath}/canvas`).then((response) => response.json())
  ).canvas;
  await userA.getByRole('button', { name: '账户菜单' }).click();
  await expect(userA.getByRole('menuitem', { name: '个人信息' })).toBeVisible();
  await userA.keyboard.press('Escape');
  await userA.getByRole('button', { name: '账户菜单' }).click();
  await userA.getByRole('menuitem', { name: '个人信息' }).click();
  await expect(userA.getByRole('heading', { name: '个人信息', exact: true })).toBeVisible();
  assert.ok(
    ['running', 'processing'].includes(
      (await request(userA, 'GET', '/v1/account/runs').then((response) => response.json())).runs[0]
        .status,
    ),
  );
  await userA.goto(`${webUrl}${projectPath}`);
  await expect(userA.locator('.flow-generate-node')).toHaveCount(1);
  await expect
    .poll(
      async () => {
        const resources = await request(userA, 'GET', '/v1/account/resources').then((response) =>
          response.json(),
        );
        return resources.assets?.filter((asset) => asset.source === 'generated').length;
      },
      { timeout: 20000 },
    )
    .toBe(1);
  await userA.getByRole('button', { name: '账户菜单' }).click();
  await userA.getByRole('menuitem', { name: '个人信息' }).click();
  await expect(userA.getByRole('heading', { name: '个人信息', exact: true })).toBeVisible();
  await userA.goto(`${webUrl}${projectPath}`);
  await expect(userA.locator('.flow-generate-node')).toHaveCount(1);
  await expect(
    userA.locator('.flow-generate-node .flow-node-preview-content').getByText('Mock output', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(userA.locator('.flow-generate-node .flow-node-stale-badge')).toHaveCount(0);
  assert.deepEqual(
    await userA.locator('.flow-generate-node').evaluate((node) => ({
      width: node.clientWidth,
      height: node.clientHeight,
    })),
    originalNodeSize,
  );
  assert.equal(
    (await request(userA, 'GET', '/v1/account/profile').then((response) => response.json())).user
      .id,
    originalUserId,
  );
  assert.equal(logoutRequests, 0);
  assert.equal(runRequests, 1);
  await userA.screenshot({ path: resolve(evidence, 'canvas-account-flow.png'), fullPage: true });
  checks.push(
    '登录/创建项目/真实 mock 执行归档；运行中和完成后头像/个人信息往返均保留身份和节点尺寸，结果可见；注销 0 次、生成 1 次',
  );
  await userA.goto(`${webUrl}/`);
  await expect(userA.getByRole('button', { name: '账户菜单' })).toBeVisible();
  await userA.getByRole('link', { name: '进入工作台', exact: true }).first().click();
  await expect(userA.getByRole('heading', { name: '项目工作台' })).toBeVisible();
  assert.equal(
    (await request(userA, 'GET', `/v1${projectPath}/canvas`).then((response) => response.json()))
      .canvas.revision,
    executionCanvas.revision,
  );
  assert.equal(logoutRequests, 0);
  assert.equal(runRequests, 1);
  checks.push('已登录返回首页再进入工作台仍保留身份，没有重复生成或注销');

  const aResources = await request(userA, 'GET', '/v1/account/resources').then((response) =>
    response.json(),
  );
  const generated = aResources.assets.find((asset) => asset.source === 'generated');
  assert.ok(generated);
  assert.equal((await request(userB, 'GET', `/v1/account/resources/${generated.id}`)).status, 404);
  assert.equal(
    (await request(userB, 'GET', `/v1/account/resources/${generated.id}/content`)).status,
    404,
  );
  assert.equal(
    (await request(userB, 'GET', '/v1/account/resources').then((response) => response.json()))
      .total,
    0,
  );
  await userA.goto(`${webUrl}/resources`);
  await expect(userA.getByText(generated.name, { exact: true }).first()).toBeVisible();
  await admin.goto(`${webUrl}/admin/resources`);
  await expect(admin.getByRole('heading', { name: '用户资源', exact: true })).toBeVisible();
  await expect(admin.getByText('a@example.test', { exact: true })).toBeVisible();
  await expect(admin.getByText('b@example.test', { exact: true })).toBeVisible();
  await admin.screenshot({ path: resolve(evidence, 'resource-groups.png'), fullPage: true });
  checks.push('新生成资源进入 A 资源库，B 无法列表/详情/下载，管理员按用户分组');

  const aId = (
    await request(userA, 'GET', '/v1/account/profile').then((response) => response.json())
  ).user.id;
  await admin.goto(`${webUrl}/admin/users/${aId}/resources`);
  await admin
    .getByRole('button', { name: new RegExp(generated.name) })
    .first()
    .click();
  const resourceDialog = admin.getByRole('dialog');
  await expect(resourceDialog).toBeVisible();
  await resourceDialog.getByLabel('资源名称').fill('管理员编辑后的资源');
  await resourceDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await request(userA, 'GET', `/v1/account/resources/${generated.id}`).then((response) =>
            response.json(),
          )
        ).asset.name,
    )
    .toBe('管理员编辑后的资源');
  await resourceDialog.getByRole('button', { name: '归档', exact: true }).click();
  await resourceDialog.getByRole('button', { name: '确认归档', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await request(userA, 'GET', `/v1/account/resources/${generated.id}`).then((response) =>
            response.json(),
          )
        ).asset.status,
    )
    .toBe('archived');
  await resourceDialog.getByRole('button', { name: '恢复', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await request(userA, 'GET', `/v1/account/resources/${generated.id}`).then((response) =>
            response.json(),
          )
        ).asset.status,
    )
    .toBe('ready');
  checks.push('管理员通过界面编辑/归档用户资源，用户读取到真实持久化结果');

  const oldToken = await token(userB);
  const bId = (
    await request(userB, 'GET', '/v1/account/profile').then((response) => response.json())
  ).user.id;
  assert.equal(
    (await request(admin, 'PATCH', `/v1/admin/users/${bId}`, { status: 'disabled' })).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${apiUrl}/v1/account/profile`, {
        headers: { authorization: `Bearer ${oldToken}` },
      })
    ).status,
    401,
  );
  checks.push('禁用普通用户后旧会话立即失效');

  await userA.getByRole('button', { name: '账户菜单' }).click();
  await userA.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(userA.getByRole('button', { name: '登录账户' })).toBeVisible();
  assert.equal(
    await userA.evaluate(() => localStorage.getItem('multimodal-canvas:auth-session')),
    null,
  );
  assert.equal(logoutRequests, 1);
  checks.push('独立退出命令只请求一次，浏览器本地会话清空');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  await writeFile(
    resolve(evidence, 'report.json'),
    JSON.stringify(
      { database, webUrl, checks, pageErrors, consoleErrors, result: 'passed' },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ result: 'passed', checks: checks.length, evidence }, null, 2));
} catch (error) {
  await writeFile(
    resolve(evidence, 'report.json'),
    JSON.stringify(
      {
        database,
        webUrl,
        checks,
        pageErrors,
        consoleErrors,
        result: 'failed',
        error: String(error),
      },
      null,
      2,
    ),
  );
  console.error(`后台浏览器验收失败，报告目录：${evidence}`);
  throw error;
} finally {
  await browser.close();
  await app.close();
  await prisma.$disconnect();
}
