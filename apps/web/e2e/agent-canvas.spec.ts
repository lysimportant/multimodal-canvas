import { expect, test as base, type Locator, type Page } from '@playwright/test';
import type { CanvasDocument } from '@multimodal-canvas/domain';
import { installFixture, project } from './image-thumbnail-cache.helpers';

const initialLabel = '初始节点';
const localLabel = '保留的本地草稿';
const remoteLabel = 'Agent 远端名称';
const nodeId = 'thumb-node-0';
const draftKey = `multimodal-canvas:canvas:thumbnail-fixture-user:${project.id}`;

type Connection = {
  id: string;
  projectId: string;
  allowGeneration: boolean;
  createdAt: string;
  expiresAt: string;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 叠加纯内存合同；其余请求仍走拒绝默认放行的通用隔离夹具。 */
async function installAgentFixture(page: Page, baseURL: string | undefined) {
  const isolation = await installFixture(page, baseURL, {
    nodes: 1,
    imageNodes: 0,
    sidebarImages: 0,
  });
  const apiOrigins = new Set([
    new URL(baseURL!).origin,
    new URL(process.env.VITE_API_BASE_URL ?? 'http://localhost:3000').origin,
  ]);
  let canvas = isolation.canvas();
  canvas.nodes[0]!.data.label = initialLabel;
  const canvasWrites: CanvasDocument[] = [];
  const connectionCreates: { allowGeneration: boolean; expiresInHours: number }[] = [];
  const revoked: string[] = [];
  let connections: Connection[] = [];
  let connectionCounter = 0;
  let saveGate: ReturnType<typeof deferred> | undefined;
  let pendingSave = false;
  const canvasPath = `/v1/projects/${project.id}/canvas`;
  const connectionPath = `/v1/projects/${project.id}/agent-connections`;
  await page.addInitScript(() => {
    localStorage.setItem('multimodal-canvas:resource-panel-collapsed', 'true');
    localStorage.setItem('multimodal-canvas:resource-panel-drawer-version', '1');
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (!apiOrigins.has(url.origin)) return route.fallback();
    if (url.pathname === canvasPath) {
      if (method === 'GET') return route.fulfill({ json: { canvas } });
      if (method !== 'PATCH') return route.fallback();
      const submitted = request.postDataJSON() as CanvasDocument;
      canvasWrites.push(structuredClone(submitted));
      if (submitted.revision !== canvas.revision)
        return route.fulfill({ status: 409, json: { revision: canvas.revision } });
      canvas = { ...submitted, revision: canvas.revision + 1 };
      // 冻结本次成功提交的回执，允许远端在回执到达前产生下一修订。
      const saved = structuredClone(canvas);
      if (saveGate) {
        pendingSave = true;
        await saveGate.promise;
        pendingSave = false;
      }
      return route.fulfill({ json: { canvas: saved } });
    }
    if (url.pathname === connectionPath) {
      if (method === 'GET')
        return route.fulfill({ json: { connections, mcpPath: '/v1/agent/mcp' } });
      if (method !== 'POST') return route.fallback();
      const body = request.postDataJSON() as {
        allowGeneration: boolean;
        expiresInHours: number;
      };
      connectionCreates.push(body);
      const connection: Connection = {
        id: `synthetic-connection-${++connectionCounter}`,
        projectId: project.id,
        allowGeneration: body.allowGeneration,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + body.expiresInHours * 3_600_000).toISOString(),
      };
      connections = [connection, ...connections];
      return route.fulfill({
        status: 201,
        json: {
          connection,
          token: `synthetic-agent-e2e-token-${connectionCounter}`,
          mcpPath: '/v1/agent/mcp',
        },
      });
    }
    if (url.pathname.startsWith(`${connectionPath}/`) && method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice(connectionPath.length + 1));
      const exists = connections.some((connection) => connection.id === id);
      if (!exists) return route.fulfill({ status: 404 });
      revoked.push(id);
      connections = connections.filter((connection) => connection.id !== id);
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  return {
    isolation,
    canvasWrites,
    connectionCreates,
    revoked,
    canvas: () => structuredClone(canvas),
    updateRemote(update: (document: CanvasDocument) => void) {
      const next = structuredClone(canvas);
      update(next);
      canvas = { ...next, revision: canvas.revision + 1 };
    },
    pauseNextSave() {
      saveGate = deferred();
    },
    isSavePending: () => pendingSave,
    releaseSave() {
      saveGate?.resolve();
      saveGate = undefined;
    },
  };
}

type AgentFixture = Awaited<ReturnType<typeof installAgentFixture>>;
const test = base.extend<{ agent: AgentFixture }>({
  agent: [
    async ({ page, baseURL }, use, testInfo) => {
      const agent = await installAgentFixture(page, baseURL);
      try {
        await page.goto(`/projects/${project.id}`);
        await expect(page.locator('.react-flow__node')).toHaveCount(1);
        // 手机样式隐藏状态栏；恢复状态仍须在节点加载后准确写入 DOM。
        await expect(page.locator('.save-state')).toHaveAttribute('aria-label', '已从项目恢复');
        await use(agent);
      } finally {
        agent.releaseSave();
        const audit = {
          ...agent.isolation.counts(),
          canvasWrites: agent.canvasWrites.length,
          connectionCreates: agent.connectionCreates.length,
          connectionRevokes: agent.revoked.length,
          errors: agent.isolation.errors,
        };
        await testInfo.attach('agent-api-isolation-audit.json', {
          contentType: 'application/json',
          body: JSON.stringify(audit, null, 2),
        });
        expect.soft(audit.blockedRequests, '不得调用真实或未隔离接口').toBe(0);
        expect.soft(audit.errors, '不得出现浏览器错误或未声明请求').toEqual([]);
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

async function openConnections(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole('button', { name: '打开画布菜单', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: '画布菜单', exact: true })).toBeVisible();
  }
  const trigger = page.getByRole('button', { name: '连接 Agent', exact: true });
  if (mobile) await trigger.tap();
  else await trigger.click();
  const panel = page.getByRole('dialog', { name: '连接外部 Agent', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '创建连接令牌', exact: true })).toBeEnabled();
  return panel;
}

for (const width of [1440, 390, 320]) {
  test.describe(`${width}px Agent 连接`, () => {
    test.use({ viewport: { width, height: width > 600 ? 900 : 844 }, hasTouch: width <= 600 });
    test('创建和撤销遵循显式授权，模板不含令牌，关闭后清除令牌', async ({ page, agent }) => {
      const panel = await openConnections(page, width <= 600);
      await expect(panel).toBeInViewport({ ratio: 1 });
      await expectNoHorizontalOverflow(panel);
      await expectNoHorizontalOverflow(page.locator('html'));
      await expect(panel.getByRole('checkbox', { name: '允许发起生成' })).not.toBeChecked();
      await expect(panel.getByRole('spinbutton', { name: '连接有效期（小时）' })).toHaveValue('8');
      await panel.getByRole('button', { name: '创建连接令牌', exact: true }).click();
      const token = 'synthetic-agent-e2e-token-1';
      await expect(panel.getByLabel('Agent 连接令牌', { exact: true })).toHaveValue(token);
      expect(agent.connectionCreates).toEqual([{ allowGeneration: false, expiresInHours: 8 }]);
      const codex = await panel.getByRole('textbox', { name: 'Codex 配置模板' }).inputValue();
      expect(codex).toContain('bearer_token_env_var = "CANVAS_AGENT_TOKEN"');
      expect(codex).not.toContain(token);
      await panel.getByRole('tab', { name: 'DeepSeek Harness', exact: true }).click();
      const harness = await panel
        .getByRole('textbox', { name: 'DeepSeek Harness 配置模板' })
        .inputValue();
      expect(harness).toContain('- insert:\n    - id: canvas-mcp');
      expect(harness).toContain('process.env.CANVAS_AGENT_TOKEN');
      expect(harness).not.toContain(token);
      await expectNoHorizontalOverflow(panel);
      const persistedToken = await page.evaluate(
        (value) =>
          [localStorage, sessionStorage].some((storage) =>
            Object.values(storage).some((item) => String(item).includes(value)),
          ),
        token,
      );
      expect(persistedToken).toBe(false);
      await panel.getByRole('button', { name: '关闭 Agent 连接', exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(page.getByLabel('Agent 连接令牌', { exact: true })).toHaveCount(0);

      const reopened = await openConnections(page, width <= 600);
      await expect(reopened.getByLabel('Agent 连接令牌', { exact: true })).toHaveCount(0);
      await expect(reopened.getByText('synthetic-connection-1', { exact: true })).toBeVisible();
      await reopened.getByRole('button', { name: '撤销连接 synthetic-connection-1' }).click();
      await expect(reopened.getByText('暂无连接', { exact: true })).toBeVisible();
      expect(agent.revoked).toEqual(['synthetic-connection-1']);

      await reopened.getByRole('checkbox', { name: '允许发起生成' }).check();
      await reopened.getByRole('spinbutton', { name: '连接有效期（小时）' }).fill('24');
      await reopened.getByRole('button', { name: '创建连接令牌', exact: true }).click();
      await expect(reopened.getByText('可编辑并生成', { exact: true })).toBeVisible();
      expect(agent.connectionCreates[1]).toEqual({ allowGeneration: true, expiresInHours: 24 });
      await reopened.getByRole('button', { name: '撤销连接 synthetic-connection-2' }).click();
      await expect(reopened.getByLabel('Agent 连接令牌', { exact: true })).toHaveCount(0);
      await expect(reopened.getByText('暂无连接', { exact: true })).toBeVisible();
      expect(agent.revoked).toEqual(['synthetic-connection-1', 'synthetic-connection-2']);
      expect(agent.canvasWrites).toHaveLength(0);
    });
  });
}

test.describe('外部画布同步与草稿保护', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('重新聚焦页面后显示外部新节点和连线，不回写远端文档', async ({ page, agent }) => {
    agent.updateRemote((canvas) => {
      canvas.nodes[0]!.data.label = remoteLabel;
      canvas.nodes.push({
        id: 'agent-created-node',
        type: 'text',
        position: { x: 380, y: 110 },
        width: 220,
        height: 160,
        data: { label: 'Agent 新节点', mediaType: 'text', mode: 'generate', enabled: true },
      });
      canvas.edges.push({
        id: 'agent-created-edge',
        sourceNodeId: nodeId,
        targetNodeId: 'agent-created-node',
        sourceHandle: 'output:text',
        targetHandle: 'input:content',
        order: 0,
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(page.locator('.react-flow__node[data-id="agent-created-node"]')).toBeVisible();
    await expect(page.locator('.react-flow__edge[data-id="agent-created-edge"]')).toBeVisible();
    await expect(
      page.locator(`.react-flow__node[data-id="${nodeId}"] .flow-node-label-button`),
    ).toHaveAttribute('aria-label', `重命名节点：${remoteLabel}`);
    await expect(page.getByRole('status', { name: '已同步外部更新', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '画布存在外部更新' })).toHaveCount(0);
    expect(agent.canvasWrites).toHaveLength(0);
  });

  test('外部更新遇到本地保存时保留草稿，迟到回执不解锁，备份可恢复', async ({ page, agent }) => {
    agent.pauseNextSave();
    const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
    await node.hover();
    await page.getByRole('button', { name: `重命名节点：${initialLabel}`, exact: true }).click();
    const rename = page.getByRole('dialog', { name: '重命名节点', exact: true });
    await rename.getByRole('textbox', { name: '编辑节点名称', exact: true }).fill(localLabel);
    await rename.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(agent.isSavePending).toBe(true);
    agent.updateRemote((canvas) => {
      canvas.nodes[0]!.data.label = remoteLabel;
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const conflict = page.getByRole('dialog', { name: '画布存在外部更新', exact: true });
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('本地草稿仍完整保留');
    const readDraft = () =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), draftKey);
    await expect.poll(async () => (await readDraft())?.nodes[0]?.data.label).toBe(localLabel);

    const saveResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/v1/projects/${project.id}/canvas`,
    );
    agent.releaseSave();
    await saveResponse;
    await expect.poll(agent.isSavePending).toBe(false);
    await conflict.getByRole('button', { name: '保留本地草稿', exact: true }).click();
    await expect(conflict).toBeHidden();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByRole('button', { name: '处理画布冲突', exact: true })).toBeVisible();
    await expect.poll(async () => (await readDraft())?.nodes[0]?.data.label).toBe(localLabel);
    expect(agent.canvasWrites).toHaveLength(1);
    expect(agent.canvas().nodes[0]!.data.label).toBe(remoteLabel);

    await page.getByRole('button', { name: '处理画布冲突', exact: true }).click();
    await conflict.getByRole('button', { name: '备份草稿并加载远端', exact: true }).click();
    await expect(conflict).toBeHidden();
    await expect(node.locator('.flow-node-label-button')).toHaveAttribute(
      'aria-label',
      `重命名节点：${remoteLabel}`,
    );
    const backup = await page.evaluate((key) => {
      const backupKey = localStorage.getItem(`${key}:conflict-backup`);
      return backupKey ? JSON.parse(localStorage.getItem(backupKey) ?? 'null') : null;
    }, draftKey);
    expect(backup.nodes[0].data.label).toBe(localLabel);
    await page.getByRole('button', { name: '恢复本地副本', exact: true }).click();
    await expect(conflict).toBeVisible();
    await expect(node.locator('.flow-node-label-button')).toHaveAttribute(
      'aria-label',
      `重命名节点：${localLabel}`,
    );
    await expect.poll(async () => (await readDraft())?.nodes[0]?.data.label).toBe(localLabel);
    expect(agent.canvasWrites).toHaveLength(1);
    expect(agent.canvas().nodes[0]!.data.label).toBe(remoteLabel);
  });
});
