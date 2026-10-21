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
  mcpUrl?: string;
  mcpPath?: string;
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
  const expectedConsoleErrors: string[] = [];
  const connectionCreates: { expiresInHours: number }[] = [];
  const revoked: string[] = [];
  let connections: Connection[] = [];
  let connectionCounter = 0;
  let localAvailable = true;
  let saveGate: ReturnType<typeof deferred> | undefined;
  let pendingSave = false;
  const canvasPath = `/v1/projects/${project.id}/canvas`;
  const connectionPath = `/v1/projects/${project.id}/local-agent-connections`;
  const serverConnectionPath = `/v1/projects/${project.id}/agent-url-connections`;
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
    if (url.pathname === connectionPath || url.pathname === serverConnectionPath) {
      const server = url.pathname === serverConnectionPath;
      if (method === 'GET')
        return route.fulfill({
          json: {
            available: server || localAvailable,
            ...(server || localAvailable ? {} : { reason: 'local_api_required' }),
            connections: server || localAvailable ? connections : [],
          },
        });
      if (method !== 'POST') return route.fallback();
      const body = request.postDataJSON() as {
        expiresInHours: number;
      };
      connectionCreates.push(body);
      const connection: Connection = {
        id: `synthetic-connection-${++connectionCounter}`,
        projectId: project.id,
        allowGeneration: true,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + body.expiresInHours * 3_600_000).toISOString(),
        ...(server
          ? {
              mcpPath: `/v1/projects/${encodeURIComponent(project.id)}/mcp?connection=${'A'.repeat(42)}${connectionCounter}`,
            }
          : { mcpUrl: `http://127.0.0.1:${49151 + connectionCounter}/mcp` }),
      };
      connections = [connection, ...connections];
      return route.fulfill({
        status: 201,
        json: { connection },
      });
    }
    const managementPath = [connectionPath, serverConnectionPath].find((path) =>
      url.pathname.startsWith(`${path}/`),
    );
    if (managementPath && method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice(managementPath.length + 1));
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
    expectedConsoleErrors,
    canvasWrites,
    connectionCreates,
    revoked,
    setLocalAvailable(available: boolean) {
      localAvailable = available;
    },
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
        await expect(page.locator('.react-flow__node')).toHaveCount(1, { timeout: 15_000 });
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
          expectedConsoleErrors: agent.expectedConsoleErrors,
        };
        await testInfo.attach('agent-api-isolation-audit.json', {
          contentType: 'application/json',
          body: JSON.stringify(audit, null, 2),
        });
        expect.soft(audit.blockedRequests, '不得调用真实或未隔离接口').toBe(0);
        expect
          .soft(audit.errors, '浏览器错误必须与明确注入的故障完全一致，不得有额外异常')
          .toEqual(audit.expectedConsoleErrors);
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

async function openConnections(page: Page, mobile: boolean, server = false) {
  if (mobile) {
    await page.getByRole('button', { name: '打开画布菜单', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: '画布菜单', exact: true })).toBeVisible();
  }
  const trigger = page.getByRole('button', { name: '连接 Agent', exact: true });
  if (mobile) await trigger.tap();
  else await trigger.click();
  const panel = page.getByRole('dialog', { name: '连接外部 Agent', exact: true });
  await expect(panel).toBeVisible();
  const enable = panel.getByRole('button', {
    name: server ? '启用服务器连接' : '启用本地连接',
    exact: true,
  });
  await expect(enable).toBeEnabled();
  return panel;
}

for (const width of [1440, 390, 320]) {
  test.describe(`${width}px Agent 连接`, () => {
    test.use({ viewport: { width, height: width > 600 ? 900 : 844 }, hasTouch: width <= 600 });
    test('启用本地连接即可复制无令牌配置，重开可恢复并停止连接', async ({ page, agent }) => {
      const panel = await openConnections(page, width <= 600);
      await expect(panel).toBeInViewport({ ratio: 1 });
      await expectNoHorizontalOverflow(panel);
      await expectNoHorizontalOverflow(page.locator('html'));
      await expect(panel.getByRole('checkbox')).toHaveCount(0);
      await expect(panel.getByRole('spinbutton', { name: '连接有效期（小时）' })).toHaveValue('8');
      await panel.getByRole('button', { name: '启用本地连接', exact: true }).click();
      const mcpUrl = 'http://127.0.0.1:49152/mcp';
      await expect(panel.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(mcpUrl);
      await expect(panel.getByLabel('Agent 连接令牌', { exact: true })).toHaveCount(0);
      expect(agent.connectionCreates).toEqual([{ expiresInHours: 8 }]);
      await expect(panel.getByText('可编辑并运行任务', { exact: true })).toBeVisible();
      const codex = await panel.getByRole('textbox', { name: 'Codex 配置模板' }).inputValue();
      expect(codex).toBe(`[mcp_servers.canvas]\nurl = "${mcpUrl}"`);
      expect(codex).not.toMatch(/token|bearer|Authorization/i);
      await panel.getByRole('tab', { name: 'DeepSeek Harness', exact: true }).click();
      const harness = await panel
        .getByRole('textbox', { name: 'DeepSeek Harness 配置模板' })
        .inputValue();
      expect(harness).toContain('- insert:\n    - id: canvas-mcp');
      expect(harness).toContain(mcpUrl);
      expect(harness).not.toMatch(/token|headers|Authorization/i);
      await expectNoHorizontalOverflow(panel);
      await panel.getByRole('button', { name: '关闭 Agent 连接', exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(page.getByLabel('Agent 连接令牌', { exact: true })).toHaveCount(0);

      const reopened = await openConnections(page, width <= 600);
      await expect(reopened.getByLabel('Agent 连接令牌', { exact: true })).toHaveCount(0);
      await expect(reopened.getByText('synthetic-connection-1', { exact: true })).toBeVisible();
      await expect(reopened.getByRole('textbox', { name: 'Codex 配置模板' })).toHaveValue(codex);
      await reopened.getByRole('button', { name: '停止连接 synthetic-connection-1' }).click();
      await expect(reopened.getByText('暂无连接', { exact: true })).toBeVisible();
      expect(agent.revoked).toEqual(['synthetic-connection-1']);

      await reopened.getByRole('spinbutton', { name: '连接有效期（小时）' }).fill('24');
      await reopened.getByRole('button', { name: '启用本地连接', exact: true }).click();
      await expect(reopened.getByText('可编辑并运行任务', { exact: true })).toBeVisible();
      expect(agent.connectionCreates[1]).toEqual({ expiresInHours: 24 });
      await reopened.getByRole('button', { name: '停止连接 synthetic-connection-2' }).click();
      await expect(reopened.getByLabel('Agent 连接令牌', { exact: true })).toHaveCount(0);
      await expect(reopened.getByText('暂无连接', { exact: true })).toBeVisible();
      expect(agent.revoked).toEqual(['synthetic-connection-1', 'synthetic-connection-2']);
      expect(agent.canvasWrites).toHaveLength(0);
    });
  });
}

for (const width of [1440, 390, 320]) {
  test.describe(`${width}px 服务器 Agent 连接`, () => {
    test.use({ viewport: { width, height: width > 600 ? 900 : 844 }, hasTouch: width <= 600 });
    test('自动切换服务器连接，默认可生成，完整配置可恢复并停止', async ({ page, agent }) => {
      agent.setLocalAvailable(false);
      const panel = await openConnections(page, width <= 600, true);
      await expect(panel.getByRole('checkbox')).toHaveCount(0);
      await panel.getByRole('button', { name: '启用服务器连接', exact: true }).click();
      await expect(panel.getByText('可编辑并运行任务', { exact: true })).toBeVisible();
      expect(agent.connectionCreates).toEqual([{ expiresInHours: 8 }]);
      const mcpUrl = await panel.getByRole('textbox', { name: 'MCP 服务地址' }).inputValue();
      const apiRoot = (process.env.VITE_API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
      expect(mcpUrl).toBe(
        `${apiRoot}/v1/projects/${encodeURIComponent(project.id)}/mcp?connection=${'A'.repeat(42)}1`,
      );
      const codex = `[mcp_servers.canvas]\nurl = "${mcpUrl}"`;
      await expect(panel.getByRole('textbox', { name: 'Codex 配置模板' })).toHaveValue(codex);
      await panel.getByRole('tab', { name: 'DeepSeek Harness', exact: true }).click();
      const harness = await panel
        .getByRole('textbox', { name: 'DeepSeek Harness 配置模板' })
        .inputValue();
      expect(harness).toContain(mcpUrl);
      expect(harness).not.toMatch(/headers|Authorization|bearer/i);
      await expectNoHorizontalOverflow(panel);
      await expectNoHorizontalOverflow(page.locator('html'));
      await panel.getByRole('button', { name: '关闭 Agent 连接', exact: true }).click();
      const reopened = await openConnections(page, width <= 600, true);
      await expect(reopened.getByRole('textbox', { name: 'Codex 配置模板' })).toHaveValue(codex);
      await reopened.getByRole('button', { name: '停止连接 synthetic-connection-1' }).click();
      await expect(reopened.getByText('暂无连接', { exact: true })).toBeVisible();
      expect(agent.revoked).toEqual(['synthetic-connection-1']);
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
});

for (const width of [1440, 390]) {
  test.describe('默认自动同步最新画布 ' + width + 'px', () => {
    test.use({ viewport: { width, height: 900 } });

    async function expectNoSyncControls(page: Page) {
      await expect(page.getByRole('dialog', { name: '画布存在外部更新' })).toHaveCount(0);
      for (const name of ['获取最新画布', '停止自动同步', '处理画布冲突', '恢复本地副本']) {
        await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      }
    }

    test('保存竞争自动备份并同步，迟到回执和后续更新不弹窗', async ({ page, agent }) => {
      agent.pauseNextSave();
      const node = page.locator('.react-flow__node[data-id="' + nodeId + '"]');
      await node.hover();
      if (width < 600)
        await node.getByRole('button', { name: '节点操作：' + initialLabel, exact: true }).click();
      await page.getByRole('button', { name: '重命名节点：' + initialLabel, exact: true }).click();
      const rename = page.getByRole('dialog', { name: '重命名节点', exact: true });
      await rename.getByRole('textbox', { name: '编辑节点名称', exact: true }).fill(localLabel);
      await rename.getByRole('button', { name: '保存', exact: true }).click();
      if (width < 600)
        await page
          .getByRole('button', { name: '关闭节点操作：' + localLabel, exact: true })
          .click();
      await expect.poll(agent.isSavePending).toBe(true);
      agent.updateRemote((canvas) => {
        canvas.nodes[0]!.data.label = remoteLabel;
      });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.locator('.save-state')).toHaveAttribute('aria-label', '正在同步最新画布');
      await expectNoSyncControls(page);
      agent.releaseSave();
      const label = node.locator(width < 600 ? '.flow-node-mobile-trigger' : '.flow-node-header');
      await expect(label).toHaveAttribute('aria-label', '节点操作：' + remoteLabel);

      const readBackup = () =>
        page.evaluate((key) => {
          const backupKey = localStorage.getItem(key + ':conflict-backup');
          return backupKey ? JSON.parse(localStorage.getItem(backupKey) ?? 'null') : null;
        }, draftKey);
      await expect.poll(async () => (await readBackup())?.nodes[0]?.data.label).toBe(localLabel);
      agent.updateRemote((canvas) => {
        canvas.nodes[0]!.data.label = '后续最新名称';
      });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(label).toHaveAttribute('aria-label', '节点操作：后续最新名称');
      await page.reload();
      await expect(label).toHaveAttribute('aria-label', '节点操作：后续最新名称');
      await expect.poll(async () => (await readBackup())?.nodes[0]?.data.label).toBe(localLabel);
      await expectNoSyncControls(page);
      await expectNoHorizontalOverflow(page.locator('html'));
      await expectNoHorizontalOverflow(page.locator('.topbar'));
      expect(agent.canvasWrites).toHaveLength(1);
      expect(agent.canvas().nodes[0]!.data.label).toBe('后续最新名称');
    });

    test('重新打开直接显示最新画布，旧草稿单独备份且忽略旧手动设置', async ({ page, agent }) => {
      const local = agent.canvas();
      local.nodes[0]!.data.label = localLabel;
      // 在新文档启动前种入既有草稿，避免旧页面 pagehide 正常落盘覆盖测试输入。
      await page.addInitScript(
        ({ key, local }) => {
          localStorage.setItem(key, JSON.stringify(local));
          localStorage.setItem(key + ':follow-remote', 'false');
        },
        { key: draftKey, local },
      );
      agent.updateRemote((canvas) => {
        canvas.nodes[0]!.data.label = remoteLabel;
      });
      await page.reload();
      const node = page.locator('.react-flow__node[data-id="' + nodeId + '"]');
      await expect(
        node.locator(width < 600 ? '.flow-node-mobile-trigger' : '.flow-node-header'),
      ).toHaveAttribute('aria-label', '节点操作：' + remoteLabel);
      const backup = await page.evaluate((key) => {
        const backupKey = localStorage.getItem(key + ':conflict-backup');
        return backupKey ? JSON.parse(localStorage.getItem(backupKey) ?? 'null') : null;
      }, draftKey);
      expect(backup.nodes[0].data.label).toBe(localLabel);
      await expectNoSyncControls(page);
      expect(agent.canvasWrites).toHaveLength(0);
    });

    test('读取失败保留画布，恢复后自动重试获取最新且不需要操作按钮', async ({ page, agent }) => {
      let failing = true;
      agent.expectedConsoleErrors.push(
        'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      );
      await page.route('**/v1/projects/' + project.id + '/canvas', async (route) => {
        if (failing && route.request().method() === 'GET')
          return route.fulfill({ status: 503, json: { error: 'synthetic temporary failure' } });
        return route.fallback();
      });
      agent.updateRemote((canvas) => {
        canvas.nodes[0]!.data.label = remoteLabel;
      });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.locator('.save-state')).toHaveAttribute(
        'aria-label',
        '最新画布同步失败，本地内容已保留，正在自动重试',
      );
      failing = false;
      const node = page.locator('.react-flow__node[data-id="' + nodeId + '"]');
      await expect(
        node.locator(width < 600 ? '.flow-node-mobile-trigger' : '.flow-node-header'),
      ).toHaveAttribute('aria-label', '节点操作：' + remoteLabel);
      await expectNoSyncControls(page);
      expect(agent.canvasWrites).toHaveLength(0);
    });
  });
}
