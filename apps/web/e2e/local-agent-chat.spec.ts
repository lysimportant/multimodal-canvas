import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { installFixture, project } from './image-thumbnail-cache.helpers';

const sessionId = 'sess-e2e';
const localBridgeOrigin = 'http://127.0.0.1:17871';
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

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,accept',
  'access-control-allow-private-network': 'true',
};

type LocalSessionCreate = { authorization?: string; body: unknown };

/** 叠加本地 Agent 桥接的纯内存合同；其余请求仍走拒绝默认放行的通用隔离夹具。 */
async function installLocalAgentFixture(page: Page, baseURL: string | undefined) {
  const isolation = await installFixture(page, baseURL, {
    nodes: 1,
    imageNodes: 0,
    sidebarImages: 0,
  });
  const configuredApi = new URL(process.env.VITE_API_BASE_URL ?? 'http://localhost:3000');
  const apiOrigins = new Set([new URL(baseURL!).origin, configuredApi.origin]);
  const canvas = isolation.canvas();
  const sessionCreates: LocalSessionCreate[] = [];
  const canvasPath = `/v1/projects/${project.id}/canvas`;
  const connectionPath = `/v1/projects/${project.id}/agent-url-connections`;
  const mcpPath = `/v1/projects/${encodeURIComponent(project.id)}/mcp?connection=${connectionKey}`;
  await page.addInitScript(() => {
    localStorage.setItem('multimodal-canvas:resource-panel-collapsed', 'true');
    localStorage.setItem('multimodal-canvas:resource-panel-drawer-version', '1');
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    // 本机桥接服务：浏览器直连，需要 CORS 预检响应与跨域头。
    if (url.origin === localBridgeOrigin) {
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders });
      if (url.pathname === '/health' && method === 'GET')
        return route.fulfill({
          status: 200,
          headers: corsHeaders,
          json: {
            ok: true,
            name: 'canvas-bridge',
            version: '0.2.0',
            agent: 'claude',
            auth: 'none',
          },
        });
      if (url.pathname === '/sessions' && method === 'POST') {
        const headers = await request.allHeaders();
        sessionCreates.push({ authorization: headers.authorization, body: request.postDataJSON() });
        return route.fulfill({
          status: 201,
          headers: corsHeaders,
          json: {
            sessionId,
            agent: 'claude',
            models: [
              { value: 'fake-small', name: 'Fake Small', description: '快速模型' },
              { value: 'fake-large', name: 'Fake Large', description: '更强模型' },
            ],
            currentModel: 'fake-small',
          },
        });
      }
      if (url.pathname === `/sessions/${sessionId}/model` && method === 'POST') {
        const body = request.postDataJSON() as { model?: string };
        return route.fulfill({
          status: 200,
          headers: corsHeaders,
          json: {
            sessionId,
            agent: 'claude',
            models: [
              { value: 'fake-small', name: 'Fake Small', description: '快速模型' },
              { value: 'fake-large', name: 'Fake Large', description: '更强模型' },
            ],
            currentModel: body.model,
          },
        });
      }
      if (url.pathname === `/sessions/${sessionId}/events` && method === 'GET')
        return route.fulfill({
          status: 200,
          headers: {
            ...corsHeaders,
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
          },
          body: `: connected\n\ndata: ${JSON.stringify({
            type: 'agent_thought_chunk',
            text: '先想一下再回答',
          })}\n\ndata: ${JSON.stringify({
            type: 'agent_message_chunk',
            text: '你好，我在。',
          })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`,
        });
      if (url.pathname === `/sessions/${sessionId}` && method === 'DELETE')
        return route.fulfill({ status: 204, headers: corsHeaders });
      return route.fulfill({
        status: 404,
        headers: corsHeaders,
        body: 'unexpected bridge request',
      });
    }
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
              mcpPath,
            },
          ],
        },
      });
    if (url.pathname === '/v1/account/newapi' && method === 'GET')
      return route.fulfill({ json: { account } });
    if (url.pathname === '/v1/account/newapi/sync' && method === 'POST')
      return route.fulfill({ json: { account } });
    return route.fallback();
  });
  return { isolation, sessionCreates, mcpPath };
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

/** 按钮文字必须完整落在按钮自身盒子里，防止固定宽度把标签挤出边界。 */
async function expectLabelInsideButton(locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return Math.ceil(
          Math.max(
            box.left - text.left,
            text.right - box.right,
            box.top - text.top,
            text.bottom - box.bottom,
            element.scrollWidth - element.clientWidth,
          ),
        );
      }),
    )
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
    test('展示本机启动命令并直连本地服务进入聊天界面，面板无横向溢出', async ({
      page,
      localAgent,
      baseURL,
    }) => {
      // 顶栏两个文字入口按钮按内容伸展，文字不得溢出按钮自身边框。
      if (width > 600) {
        await expectLabelInsideButton(
          page.getByRole('button', { name: '连接 Agent', exact: true }),
        );
        await expectLabelInsideButton(
          page.getByRole('button', { name: '打开本地 Agent 聊天', exact: true }),
        );
      }
      const panel = await openLocalAgent(page, width <= 600);
      await expect(panel).toBeInViewport({ ratio: 1 });
      const command = panel.getByRole('textbox', { name: '启动命令', exact: true });
      await expect(command).toHaveValue('node canvas-bridge.js --local --no-token --agent claude');
      await expectNoHorizontalOverflow(panel);
      await expectNoHorizontalOverflow(page.locator('.local-agent-chat-panel .ant-drawer-body'));
      await expectNoHorizontalOverflow(page.locator('html'));

      await expect(panel.getByLabel('本地地址', { exact: true })).toHaveValue(
        'http://127.0.0.1:17871',
      );
      // 面板命令带 --no-token：不填令牌也能连。
      await panel.getByRole('button', { name: /^连\s*接$/ }).click();
      await expect(panel.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
      await expect(panel.getByText('已连接本机 Agent')).toBeVisible();
      // 连接后展示 Agent 身份、模型选择器，并把思考链渲染为可折叠区块。
      await expect(panel.getByText(/Agent：claude/)).toBeVisible();
      await expect(panel.getByRole('combobox', { name: '选择模型' })).toBeVisible();
      await expect(panel.getByText('思考过程')).toBeVisible();
      await expect(panel.getByText('你好，我在。')).toBeVisible();

      const apiOrigin = new URL(process.env.VITE_API_BASE_URL ?? 'http://localhost:3000').origin;
      expect(localAgent.sessionCreates).toEqual([
        {
          authorization: undefined,
          body: { projectId: project.id, mcpUrl: `${apiOrigin}${localAgent.mcpPath}` },
        },
      ]);
      await expect(panel).toBeInViewport({ ratio: 1 });
      await expectNoHorizontalOverflow(panel);
      await expectNoHorizontalOverflow(page.locator('.local-agent-chat-panel .ant-drawer-body'));
      await expectNoHorizontalOverflow(page.locator('html'));

      await panel.getByRole('button', { name: '关闭本地 Agent 聊天', exact: true }).click();
      await expect(panel).toBeHidden();

      // 关闭只是收起界面：重新打开后仍保留会话与对话，不会重新建立会话。
      const reopened = await openLocalAgent(page, width <= 600);
      await expect(reopened.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
      await expect(reopened.getByText('你好，我在。')).toBeVisible();
      expect(localAgent.sessionCreates).toHaveLength(1);
    });
  });
}
