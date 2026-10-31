import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { installFixture, project } from './image-thumbnail-cache.helpers';

const sessionId = 'sess-e2e';
const connectionKey = `00000001-0000-4000-8000-000000000000.${'A'.repeat(43)}`;
/** New API 账号合同；页面装载与同步都会读取它，形状与设置页验收一致。 */
const account = {
  issuer: 'https://newapi.example.test',
  externalUserId: 'newapi-local-agent-user',
  displayName: '本地 Agent 验收账号',
  status: 'active',
  syncedAt: '2026-09-21T00:00:00.000Z',
  groups: [{ group: 'alpha', credentialId: 'credential-alpha', status: 'ready', modelCount: 2 }],
  links: { models: 'https://newapi.example.test/pricing' },
};

/** 叠加本地 Agent 桥接的纯内存合同；其余请求仍走拒绝默认放行的通用隔离夹具。 */
async function installLocalAgentFixture(page: Page, baseURL: string | undefined) {
  const isolation = await installFixture(page, baseURL, {
    nodes: 1,
    imageNodes: 0,
    sidebarImages: 0,
  });
  const apiOrigins = new Set([
    new URL(baseURL!).origin,
    new URL(process.env.VITE_API_BASE_URL ?? 'http://localhost:3000').origin,
  ]);
  const canvas = isolation.canvas();
  const sessionCreates: unknown[] = [];
  const canvasPath = `/v1/projects/${project.id}/canvas`;
  const connectionPath = `/v1/projects/${project.id}/agent-url-connections`;
  await page.addInitScript(() => {
    localStorage.setItem('multimodal-canvas:resource-panel-collapsed', 'true');
    localStorage.setItem('multimodal-canvas:resource-panel-drawer-version', '1');
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (!apiOrigins.has(url.origin)) return route.fallback();
    if (url.pathname === canvasPath && method === 'GET') return route.fulfill({ json: { canvas } });
    if (url.pathname === connectionPath && method === 'GET')
      return route.fulfill({
        json: {
          available: true,
          connections: [
            {
              id: 'synthetic-connection-1',
              projectId: project.id,
              allowGeneration: true,
              createdAt: new Date().toISOString(),
              expiresAt: null,
              mcpPath: `/v1/projects/${encodeURIComponent(project.id)}/mcp?connection=${connectionKey}`,
            },
          ],
        },
      });
    if (url.pathname === '/v1/account/newapi' && method === 'GET')
      return route.fulfill({ json: { account } });
    if (url.pathname === '/v1/account/newapi/sync' && method === 'POST')
      return route.fulfill({ json: { account } });
    if (url.pathname === '/v1/agent-bridge/sessions' && method === 'POST') {
      sessionCreates.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { sessionId } });
    }
    if (url.pathname === `/v1/agent-bridge/sessions/${sessionId}/stream` && method === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'done' })}\n\n`,
      });
    return route.fallback();
  });
  return { isolation, sessionCreates };
}

type LocalAgentFixture = Awaited<ReturnType<typeof installLocalAgentFixture>>;
const test = base.extend<{ localAgent: LocalAgentFixture }>({
  localAgent: [
    async ({ page, baseURL }, use, testInfo) => {
      const localAgent = await installLocalAgentFixture(page, baseURL);
      try {
        await page.goto(`/projects/${project.id}`);
        await expect(page.locator('.react-flow__node')).toHaveCount(1, { timeout: 15_000 });
        await expect(page.locator('.save-state')).toHaveAttribute('aria-label', '已从项目恢复');
        await use(localAgent);
      } finally {
        const audit = {
          ...localAgent.isolation.counts(),
          sessionCreates: localAgent.sessionCreates.length,
          errors: localAgent.isolation.errors,
        };
        await testInfo.attach('local-agent-api-isolation-audit.json', {
          contentType: 'application/json',
          body: JSON.stringify(audit, null, 2),
        });
        expect.soft(audit.blockedRequests, '不得调用真实或未隔离接口').toBe(0);
        expect.soft(audit.errors, '浏览器不得出现异常').toEqual([]);
      }
    },
    { auto: true },
  ],
});

test.use({ serviceWorkers: 'block' });
test.setTimeout(60_000);

async function expectNoHorizontalOverflow(locator: Locator) {
  await expect
    .poll(() => locator.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
}

async function openLocalAgent(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole('button', { name: '打开画布菜单', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: '画布菜单', exact: true })).toBeVisible();
  }
  const trigger = page.getByRole('button', { name: '打开本地 Agent 聊天', exact: true });
  if (mobile) await trigger.tap();
  else await trigger.click();
  const panel = page.getByRole('dialog', { name: '本地 Agent', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

for (const width of [1440, 390, 320]) {
  test.describe(`${width}px 本地 Agent 聊天`, () => {
    test.use({ viewport: { width, height: width > 600 ? 900 : 844 }, hasTouch: width <= 600 });
    test('展示桥接命令并连接进入聊天界面，面板无横向溢出', async ({ page, localAgent }) => {
      const panel = await openLocalAgent(page, width <= 600);
      await expect(panel).toBeInViewport({ ratio: 1 });
      const command = panel.getByRole('textbox', { name: '桥接程序启动命令', exact: true });
      await expect(command).toHaveValue(new RegExp(`--token ${connectionKey.replace('.', '\\.')}`));
      await expectNoHorizontalOverflow(panel);
      await expectNoHorizontalOverflow(page.locator('.local-agent-chat-panel .ant-drawer-body'));
      await expectNoHorizontalOverflow(page.locator('html'));

      await panel.getByRole('button', { name: /^连\s*接$/ }).click();
      await expect(panel.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
      expect(localAgent.sessionCreates).toEqual([{ projectId: project.id }]);
      await expect(panel).toBeInViewport({ ratio: 1 });
      await expectNoHorizontalOverflow(panel);
      await expectNoHorizontalOverflow(page.locator('.local-agent-chat-panel .ant-drawer-body'));
      await expectNoHorizontalOverflow(page.locator('html'));

      await panel.getByRole('button', { name: '关闭本地 Agent 聊天', exact: true }).click();
      await expect(panel).toBeHidden();
    });
  });
}
