import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { CanvasDocument, RequestPromptRecord } from '@multimodal-canvas/domain';

/** 六项功能共用的隔离项目，不访问真实账户、供应商或持久化数据库。 */
const project = {
  id: 'next-acceptance',
  name: '六项功能验收',
  createdAt: '2026-09-16T10:00:00.000Z',
  updatedAt: '2026-09-16T10:00:00.000Z',
};
/** 长提示词同时包含角色、换行、中文和不可断英文段，用于检查复制及溢出。 */
const promptText = `Describe the complete scene without inventing details.\n${'窗前的书桌上放着打开的笔记，午后的阳光落在纸页上。'.repeat(70)}\n${'long-unbroken-reference-'.repeat(40)}`;
/** 结果版本对应的服务端记录；当前编辑框故意使用不同内容。 */
const promptRecord: RequestPromptRecord = {
  schemaVersion: 1,
  runId: 'acceptance-run',
  nodeId: 'generated-text',
  attempt: 1,
  requestIdentity: 'POST /chat/completions#1',
  provider: 'mock',
  modelAlias: 'mock-text',
  mediaType: 'text',
  format: 'messages',
  parts: [{ order: 0, role: 'user', text: promptText }],
  resources: [],
  sendStatus: 'sent',
  createdAt: '2026-09-16T10:00:00.000Z',
  assetId: 'acceptance-text',
  assetVersion: 1,
  summary: '午后窗前的书桌上，一本打开的笔记沐浴在阳光中；保持原有环境与物件，不增加未描述的细节。',
};
/** 标准画布覆盖保留结果、已填写提示词、空模板、连线及双成员分组。 */
const initialCanvas: CanvasDocument = {
  revision: 1,
  nodes: [
    {
      id: 'generated-text',
      type: 'text',
      position: { x: 100, y: 140 },
      width: 220,
      height: 170,
      data: {
        label: '已生成文字',
        mediaType: 'text',
        mode: 'generate',
        enabled: true,
        prompt: '编辑后的输入，不能冒充旧结果提示词',
        assetId: 'acceptance-text',
        contentUrl: '/v1/assets/acceptance-text/content',
        mimeType: 'text/plain',
      },
    },
    {
      id: 'filled-text',
      type: 'text',
      position: { x: 420, y: 140 },
      width: 220,
      height: 170,
      data: {
        label: '已填写提示词',
        mediaType: 'text',
        mode: 'generate',
        enabled: true,
        prompt: '这段内容必须保留',
      },
    },
    {
      id: 'empty-image',
      type: 'image',
      position: { x: 750, y: 140 },
      width: 220,
      height: 170,
      data: { label: '空图片模板', mediaType: 'image', mode: 'generate', enabled: true },
    },
  ],
  edges: [
    {
      id: 'acceptance-edge',
      sourceNodeId: 'generated-text',
      sourceHandle: 'output:text',
      targetNodeId: 'filled-text',
      targetHandle: 'input:content',
      order: 0,
    },
  ],
  groups: [
    {
      id: 'acceptance-group',
      name: '创作资料',
      position: { x: 70, y: 85 },
      width: 610,
      height: 255,
      nodeIds: ['generated-text', 'filled-text'],
    },
  ],
};

/** 返回 JSON 响应，不透传未声明接口到真实服务。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 安装最小 API 合同，保存后的画布及设置在同一浏览器测试内可刷新恢复。 */
async function installFixture(page: Page) {
  let canvas = structuredClone(initialCanvas);
  const records = new Map<string, RequestPromptRecord>([
    ['acceptance-text', structuredClone(promptRecord)],
  ]);
  let defaults: Record<string, unknown> = {};
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const errors: string[] = [];
  const credentials = [
    {
      id: 'active-credential',
      version: 1,
      baseUrl: 'https://mock.example.test/v1',
      keyFingerprint: 'active-fingerprint',
      active: true,
      createdAt: project.createdAt,
      defaultModels: {} as Record<string, unknown>,
    },
  ];
  const settings = {
    baseUrl: credentials[0]!.baseUrl,
    configured: true,
    keyFingerprint: credentials[0]!.keyFingerprint,
    defaultModels: {} as Record<string, unknown>,
  };
  const models = ['text', 'image', 'audio', 'video'].map((mediaType) => ({
    id: `mock-${mediaType}`,
    name: `Mock ${mediaType}`,
    mediaTypes: [mediaType],
  }));
  const run = {
    id: promptRecord.runId,
    projectId: project.id,
    targetNodeId: 'generated-text',
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    provider: 'mock',
    modelAlias: 'mock-text',
    snapshot: {
      projectId: project.id,
      canvasRevision: 1,
      targetNodeId: 'generated-text',
      modelAlias: 'mock-text',
      parameters: {},
      submittedAt: project.createdAt,
      nodes: [canvas.nodes[0]],
      edges: [],
      inputs: [],
    },
    result: {
      provider: 'mock',
      summary: '结果已归档',
      targetNodeId: 'generated-text',
      mediaType: 'text',
      inputCount: 0,
      asset: {
        assetId: 'acceptance-text',
        version: 1,
        contentUrl: '/v1/assets/acceptance-text/content',
        mimeType: 'text/plain',
        sizeBytes: 200,
      },
    },
    nodeTimings: {
      'generated-text': {
        nodeId: 'generated-text',
        startedAt: project.createdAt,
        finishedAt: '2026-09-16T10:00:12.400Z',
        outcome: 'succeeded',
      },
    },
    createdAt: project.createdAt,
    updatedAt: '2026-09-16T10:00:12.400Z',
  };
  const runs = new Map<string, unknown>([[run.id, run]]);
  const timings = new Map([[promptRecord.assetId!, run.nodeTimings['generated-text']]]);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-next-acceptance',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'acceptance-user',
          email: 'acceptance@example.test',
          role: 'admin',
          createdAt: '2026-09-16T10:00:00.000Z',
        },
      }),
    );
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method !== 'GET') writes.push({ path, body: request.postDataJSON() ?? {} });
    if (path.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path.endsWith('/canvas')) {
      if (method === 'PATCH') canvas = { ...request.postDataJSON(), revision: canvas.revision + 1 };
      return json(route, { canvas });
    }
    if (path.endsWith('/models/defaults')) {
      if (method === 'PATCH') {
        for (const [key, value] of Object.entries(request.postDataJSON())) {
          if (value === null) delete defaults[key];
          else defaults[key] = value;
        }
      }
      return json(route, { defaults });
    }
    if (path.endsWith('/reverse-prompts') && method === 'GET') {
      return json(route, {
        analysis: null,
        defaultModel: { modelAlias: 'text-model', credentialId: 'active-credential' },
      });
    }
    if (path.includes('/request-prompts')) {
      const assetId = path.startsWith('/v1/assets/') ? path.split('/')[3]! : 'acceptance-text';
      const record = records.get(assetId);
      if (!record) return json(route, { records: [] });
      if (method === 'PATCH') {
        const summary = request.postDataJSON().summary as string;
        record.summary = summary;
        record.summarySource = 'manual';
      }
      return path.endsWith('/prompt-record')
        ? json(route, { record })
        : json(route, {
            records: [{ id: 'prompt-record', ...record }],
            timing: timings.get(assetId),
          });
    }
    if (method === 'POST' && /^\/v1\/nodes\/[^/]+\/runs$/.test(path)) {
      const nodeId = path.split('/')[3]!;
      const body = request.postDataJSON();
      const node = canvas.nodes.find((entry) => entry.id === nodeId)!;
      const assetId = `generated-${nodeId}`;
      const timing = { ...run.nodeTimings['generated-text'], nodeId };
      const generatedRun = {
        ...run,
        id: `run-${nodeId}`,
        targetNodeId: nodeId,
        modelAlias: body.modelAlias,
        snapshot: {
          ...run.snapshot,
          targetNodeId: nodeId,
          modelAlias: body.modelAlias,
          nodes: canvas.nodes,
          edges: canvas.edges,
        },
        result: {
          ...run.result,
          targetNodeId: nodeId,
          asset: { ...run.result.asset, assetId, contentUrl: `/v1/assets/${assetId}/content` },
        },
        nodeTimings: { [nodeId]: timing },
      };
      records.set(assetId, {
        ...promptRecord,
        runId: generatedRun.id,
        nodeId,
        assetId,
        modelAlias: body.modelAlias,
        parts: [{ order: 0, role: 'user', text: node.data.prompt ?? '' }],
        summary: undefined,
      });
      timings.set(assetId, timing);
      runs.set(generatedRun.id, generatedRun);
      return json(route, { run: generatedRun }, 202);
    }
    if (path === `/v1/projects/${project.id}/runs`)
      return json(route, { runs: [...runs.values()] });
    if (/^\/v1\/runs\/[^/]+$/.test(path))
      return json(route, { run: runs.get(path.split('/')[3]!) });
    if (path === '/v1/assets')
      return json(route, {
        assets: [
          {
            id: 'acceptance-text',
            name: '已生成文字.txt',
            mediaType: 'text',
            mimeType: 'text/plain',
            status: 'ready',
            sizeBytes: 200,
            contentUrl: '/v1/assets/acceptance-text/content',
            tags: [],
          },
        ],
      });
    if (path.endsWith('/access-url'))
      return json(route, { url: path.replace('/access-url', '/content') });
    if (/^\/v1\/assets\/[^/]+\/content$/.test(path))
      return route.fulfill({
        contentType: 'text/plain',
        body: '午后的阳光落在打开的笔记上。\n这份结果对应旧提示词和 12.4 秒耗时。',
      });
    if (path.endsWith('/versions')) {
      const assetId = path.split('/')[3]!;
      return json(route, {
        versions: records.has(assetId)
          ? [
              {
                id: `${assetId}-version-1`,
                assetId,
                version: 1,
                sizeBytes: 200,
                createdAt: project.createdAt,
                contentUrl: `/v1/assets/${assetId}/content?version=1`,
                metadata: { nodeTiming: timings.get(assetId) },
              },
            ]
          : [],
      });
    }
    if (path === '/v1/settings/ai/credentials') return json(route, { credentials });
    if (/\/credentials\/[^/]+\/defaults$/.test(path)) {
      const credential = credentials.find((entry) => entry.id === path.split('/')[5]);
      if (credential)
        credential.defaultModels = { ...credential.defaultModels, ...request.postDataJSON() };
      return json(route, { credentials });
    }
    if (path === '/v1/settings/ai') {
      if (method === 'PATCH') {
        const body = request.postDataJSON();
        if (body.activate === false) {
          credentials.push({
            id: 'independent-credential',
            version: 2,
            baseUrl: body.baseUrl,
            keyFingerprint: 'independent-fingerprint',
            active: false,
            createdAt: project.createdAt,
            defaultModels: {},
          });
          return json(route, {
            settings,
            credentials,
            createdCredentialId: 'independent-credential',
          });
        }
        if (body.defaultModels)
          settings.defaultModels = { ...settings.defaultModels, ...body.defaultModels };
      }
      return json(route, { settings, credentials });
    }
    if (path === '/v1/models' || path === '/v1/settings/ai/models/refresh') {
      const credentialId =
        url.searchParams.get('credentialId') ??
        (method === 'POST' ? request.postDataJSON()?.credentialId : undefined) ??
        'active-credential';
      return json(route, { models: models.map((model) => ({ ...model, credentialId })) });
    }
    errors.push(`未声明的 Mock 接口：${method} ${path}`);
    return json(route, { error: '未声明的验收接口' }, 404);
  });
  return {
    errors,
    writes,
    credentials,
    records,
    settings,
    canvas: () => canvas,
    defaults: () => defaults,
  };
}

/** 打开当前项目并等待画布完成首屏恢复。 */
async function openCanvas(page: Page) {
  await page.goto(`/projects/${project.id}`);
  await expect(page.locator('.react-flow__node')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.locator('.canvas-group')).toHaveCount(1);
}

/** 鼠标拖动指定区域；偏移量为屏幕像素。 */
async function drag(page: Page, locator: Locator, dx: number, dy: number) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.65, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.65 + dx, box!.y + box!.height / 2 + dy, {
    steps: 8,
  });
  await page.mouse.up();
}

/** 通过正式保存动作等待本地 Mock 收到当前文档。 */
async function save(page: Page) {
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status', { name: /已保存/ })).toBeVisible();
}

/** 通过画布滚轮缩放到指定比例，保持组中心的屏幕锚点不变。 */
async function zoomCanvas(page: Page, target: number) {
  const pane = page.locator('.react-flow__pane');
  const group = await page.locator('.canvas-group').first().boundingBox();
  const current = await page
    .locator('.react-flow__viewport')
    .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  await pane.dispatchEvent('wheel', {
    deltaY: -Math.log2(target / current) / 0.002,
    deltaMode: 0,
    clientX: group!.x + group!.width / 2,
    clientY: group!.y + group!.height / 2,
    bubbles: true,
    cancelable: true,
  });
  await expect
    .poll(() =>
      page
        .locator('.react-flow__viewport')
        .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
    )
    .toBeCloseTo(target, 2);
}

/** 按 WCAG 相对亮度核对正文；透明背景沿 DOM 向上查找实际底色。 */
async function expectReadableText(locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const channels = (color: string) =>
          color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number);
        const luminance = (color: string) =>
          channels(color).reduce((sum, value, index) => {
            const channel = value / 255;
            return (
              sum +
              (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
                [0.2126, 0.7152, 0.0722][index]!
            );
          }, 0);
        let current: Element | null = element;
        let background = 'rgb(255, 255, 255)';
        while (current) {
          const candidate = getComputedStyle(current).backgroundColor;
          if (candidate !== 'transparent' && candidate !== 'rgba(0, 0, 0, 0)') {
            background = candidate;
            break;
          }
          current = current.parentElement;
        }
        const foreground = luminance(getComputedStyle(element).color);
        const backdrop = luminance(background);
        return (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05);
      }),
    )
    .toBeGreaterThanOrEqual(4.5);
}

test('设置：宽版四类默认及独立连接保存后保留全局活动 Key', async ({ page }) => {
  const fixture = await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 连接', exact: true });
  await expect(dialog).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeGreaterThan(900);
  await dialog.getByRole('tab', { name: '节点默认', exact: true }).click();
  await expect(dialog.locator('.settings-default-row')).toHaveCount(4);
  await dialog.getByRole('button', { name: '当前项目', exact: true }).click();
  await dialog.getByRole('combobox', { name: '文字生成默认模型' }).fill('mock-text');
  await page.keyboard.press('Enter');
  await expect.poll(() => fixture.defaults().text).toBeTruthy();
  await dialog.getByRole('button', { name: '配置图片生成连接' }).click();
  const key = dialog.getByRole('textbox', { name: '图片生成独立连接 Key', exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await dialog
    .getByRole('textbox', { name: '图片生成独立连接 Base URL' })
    .fill('https://independent.example.test/v1');
  await key.fill('synthetic-independent-key');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect.poll(() => fixture.credentials.length).toBe(2);
  expect(fixture.credentials.find((entry) => entry.active)?.id).toBe('active-credential');
  expect(fixture.writes.find((entry) => entry.body.apiKey)?.body.activate).toBe(false);
  await expect(key).toHaveValue('');
  expect(fixture.errors).toEqual([]);
});

test('分组：整组移动、外框缩放、一次撤销及保存刷新保持成员坐标', async ({ page }) => {
  const fixture = await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  const group = page.locator('.canvas-group');
  const node = page.locator('.react-flow__node[data-id="generated-text"]');
  const original = await node.boundingBox();
  await drag(page, group.locator('.canvas-group-header'), 70, 45);
  await expect.poll(async () => (await node.boundingBox())!.x - original!.x).toBeCloseTo(70, 0);
  await save(page);
  const moved = structuredClone(fixture.canvas());
  const memberPosition = moved.nodes[0]!.position;
  const movedWidth = moved.groups![0]!.width;
  await drag(page, group.locator('[data-corner="se"]'), 55, 35);
  await save(page);
  expect(fixture.canvas().groups![0]!.width).toBeGreaterThan(movedWidth);
  expect(fixture.canvas().nodes[0]!.position).toEqual(memberPosition);
  await page.getByRole('button', { name: '画布撤销', exact: true }).click();
  await save(page);
  expect(fixture.canvas().groups![0]!.width).toBe(movedWidth);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.canvas-group')).toHaveCount(1);
  await expect
    .poll(() => node.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m41))
    .toBeCloseTo(memberPosition.x, 2);
  await expect
    .poll(() => node.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m42))
    .toBeCloseTo(memberPosition.y, 2);
  expect(fixture.canvas().groups![0]!.nodeIds).toEqual(['generated-text', 'filled-text']);
  expect(fixture.canvas().nodes[0]!.position).toEqual(memberPosition);
  expect(fixture.errors).toEqual([]);
});

test('清空：hover 预览、取消无副作用、仅空模板删除及一次撤销', async ({ page }) => {
  const fixture = await installFixture(page);
  await openCanvas(page);
  await page.getByRole('button', { name: '清空', exact: true }).hover();
  const clearEmpty = page.getByRole('menuitem', { name: /清空空节点/ });
  await expect(clearEmpty).toContainText('1 节点');
  page.once('dialog', (dialog) => dialog.dismiss());
  await clearEmpty.click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await page.getByRole('button', { name: '清空', exact: true }).hover();
  page.once('dialog', (dialog) => dialog.accept());
  await clearEmpty.click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.react-flow__node[data-id="filled-text"]')).toBeVisible();
  await expect(page.locator('.canvas-group')).toHaveCount(1);
  await page.getByRole('button', { name: '画布撤销', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  expect(fixture.errors).toEqual([]);
});

test('提示词与耗时：旧结果只读长文本、双复制、焦点及刷新恢复', async ({ page }) => {
  const fixture = await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const node = page.locator('.react-flow__node[data-id="generated-text"]');
  const nodeBox = await node.boundingBox();
  await node.hover();
  await node.getByRole('button', { name: '查看节点信息' }).click();
  const info = page.getByRole('dialog', { name: '节点信息', exact: true });
  await expect(info.locator('.node-duration-badge')).toHaveText('12.4秒');
  const trigger = info.getByRole('button', { name: /查看生成提示词/ });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '生成提示词' });
  await expect(dialog.locator('.request-prompt-text')).toHaveText(`[user] ${promptText}`);
  await dialog.getByRole('button', { name: '复制摘要', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(promptRecord.summary);
  await dialog.getByRole('button', { name: '复制完整提示词', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n')),
    )
    .toBe(`[user] ${promptText}`);
  await expect(dialog.getByRole('button', { name: '复制摘要', exact: true })).toHaveText('已复制');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await node.boundingBox())!.width).toBe(nodeBox!.width);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await node.hover();
  await node.getByRole('button', { name: '查看节点信息' }).click();
  await expect(info.locator('.node-duration-badge')).toHaveText('12.4秒');
  expect(fixture.errors).toEqual([]);
});

test('连线：五种路径与六种特效独立切换并在刷新后恢复', async ({ page }) => {
  const fixture = await installFixture(page);
  await openCanvas(page);
  await page.getByRole('button', { name: '外观', exact: true }).first().click();
  const appearance = page.getByRole('dialog', { name: '主题、画布背景与连接线' });
  await appearance.getByRole('tab', { name: '连接', exact: true }).click();
  const paths = appearance.getByRole('group', { name: '连接线路径' });
  const effects = appearance.getByRole('group', { name: '连接线特效' });
  await expect(paths.getByRole('button')).toHaveCount(5);
  await expect(effects.getByRole('button')).toHaveCount(6);
  await paths.getByRole('button', { name: /直角折线/ }).click();
  await effects.getByRole('button', { name: /呼吸脉冲/ }).click();
  await expect(paths.getByRole('button', { name: /直角折线/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await effects.getByRole('button', { name: /无特效/ }).click();
  await expect(paths.getByRole('button', { name: /直角折线/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('multimodal-canvas:edge-path-style')))
    .toBe('step');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('multimodal-canvas:edge-effect')))
    .toBe('none');
  expect(fixture.errors).toEqual([]);
});

test('联合流程：独立连接与类型默认、生成、摘要、分组、清理、撤销及刷新', async ({ page }) => {
  const fixture = await installFixture(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCanvas(page);
  await page.getByRole('button', { name: '新建分组', exact: true }).click();
  await expect(page.locator('.canvas-group')).toHaveCount(2);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'AI 连接', exact: true });
  await settings.getByRole('tab', { name: '节点默认', exact: true }).click();
  await settings.getByRole('button', { name: '当前项目', exact: true }).click();
  await settings.getByRole('combobox', { name: '文字生成默认模型' }).fill('mock-text');
  await page.keyboard.press('Enter');
  await expect.poll(() => fixture.defaults().text).toBeTruthy();
  await settings.getByRole('button', { name: '配置图片生成连接' }).click();
  await settings
    .getByRole('textbox', { name: '图片生成独立连接 Base URL' })
    .fill('https://independent.example.test/v1');
  await settings
    .getByRole('textbox', { name: '图片生成独立连接 Key', exact: true })
    .fill('synthetic-independent-key');
  await settings.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect.poll(() => fixture.credentials.length).toBe(2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  await expect(page.getByRole('combobox', { name: '模型：Mock text' })).toBeVisible();
  const submittedPrompt = 'Summarize the scene: sunlight on a notebook beside the window.';
  await page.getByRole('textbox', { name: '提示词', exact: true }).fill(submittedPrompt);
  const response = page.waitForResponse(
    (entry) =>
      entry.request().method() === 'POST' &&
      /\/v1\/nodes\/[^/]+\/runs$/.test(new URL(entry.url()).pathname),
  );
  await page.getByRole('button', { name: '生成', exact: true }).click();
  const created = await (await response).json();
  expect(fixture.writes.find((entry) => entry.path.endsWith('/runs'))?.body).toMatchObject({
    modelAlias: 'mock-text',
    credentialId: 'active-credential',
  });
  const node = page.locator(`.react-flow__node[data-id="${created.run.targetNodeId}"]`);
  await expect(node.getByRole('img', { name: '运行成功' })).toBeVisible();
  await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
  await node.hover();
  await node.getByRole('button', { name: '查看节点信息' }).click();
  await page.getByRole('button', { name: /查看生成提示词/ }).click();
  const prompt = page.getByRole('dialog', { name: '生成提示词' });
  await expect(prompt.locator('.request-prompt-text')).toHaveText(`[user] ${submittedPrompt}`);
  await expect(prompt.locator('.node-duration-badge')).toHaveText('12.4秒');
  await prompt.getByRole('button', { name: '添加摘要', exact: true }).click();
  const summary = '窗边笔记上的阳光，保持原始场景。';
  await prompt.getByRole('textbox', { name: '摘要正文' }).fill(summary);
  await prompt.getByRole('button', { name: '保存摘要', exact: true }).click();
  await expect(prompt.locator('.request-prompt-summary')).toHaveText(summary);
  await prompt.getByRole('button', { name: '复制摘要', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(summary);
  await prompt.getByRole('button', { name: '复制完整提示词', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`[user] ${submittedPrompt}`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
  await drag(
    page,
    page.locator('.canvas-group[data-group-id="acceptance-group"] .canvas-group-header'),
    30,
    20,
  );
  await page.getByRole('button', { name: '清空', exact: true }).hover();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('menuitem', { name: /清空空节点/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await page.getByRole('button', { name: '画布撤销', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await save(page);
  const saved = structuredClone(fixture.canvas());
  expect(saved.nodes.find((entry) => entry.id === created.run.targetNodeId)?.data).toMatchObject({
    modelAlias: 'mock-text',
    credentialId: 'active-credential',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await expect(page.locator('.canvas-group')).toHaveCount(2);
  await node.hover();
  await node.getByRole('button', { name: '查看节点信息' }).click();
  await page.getByRole('button', { name: /查看生成提示词/ }).click();
  await expect(prompt.locator('.request-prompt-summary')).toHaveText(summary);
  await expect(prompt.locator('.node-duration-badge')).toHaveText('12.4秒');
  expect(fixture.canvas().groups).toEqual(saved.groups);
  expect(fixture.credentials.find((entry) => entry.active)?.id).toBe('active-credential');
  expect(fixture.errors).toEqual([]);
});

test('资源历史：删除原节点后按精确版本切换提示词、摘要、耗时与预览', async ({ page }, testInfo) => {
  const fixture = await installFixture(page);
  const versionTwo: RequestPromptRecord = {
    ...promptRecord,
    runId: 'second-run',
    assetVersion: 2,
    summary: '第二版摘要',
    parts: [{ order: 0, role: 'user', text: 'Second immutable version prompt.' }],
  };
  await page.route('**/v1/assets/acceptance-text/versions', (route) =>
    json(route, {
      versions: [1, 2].map((version) => ({
        id: `version-${version}`,
        assetId: 'acceptance-text',
        version,
        sizeBytes: 200,
        createdAt: project.createdAt,
        contentUrl: `/v1/assets/acceptance-text/content?version=${version}`,
      })),
    }),
  );
  await page.route('**/v1/assets/acceptance-text/versions/2/request-prompts', (route) =>
    json(route, {
      records: [{ id: 'prompt-record-two', ...versionTwo }],
      timing: {
        nodeId: 'generated-text',
        startedAt: project.createdAt,
        finishedAt: '2026-09-16T10:00:26.000Z',
        outcome: 'succeeded',
      },
    }),
  );
  await page.route('**/v1/assets/acceptance-text/content?version=2', (route) =>
    route.fulfill({ contentType: 'text/plain', body: 'Second immutable result.' }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  const node = page.locator('.react-flow__node[data-id="generated-text"]');
  await node.hover();
  await node.getByRole('button', { name: '删除节点：已生成文字', exact: true }).click();
  await expect(node).toHaveCount(0);
  await page.getByRole('button', { name: '生成记录 已生成文字.txt', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: '生成提示词' });
  await expect(prompt.getByRole('combobox', { name: '结果版本' })).toHaveValue('2');
  await expect(prompt.locator('.request-prompt-text')).toHaveText(
    '[user] Second immutable version prompt.',
  );
  await expect(prompt.locator('.node-duration-badge')).toHaveText('26秒');
  await prompt.getByRole('button', { name: '编辑摘要', exact: true }).click();
  await prompt.getByRole('textbox', { name: '摘要正文' }).fill('预览期间保留的未保存草稿');
  await prompt.getByRole('button', { name: '预览此版本', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '已生成文字.txt', exact: true });
  await expect(preview).toContainText('Second immutable result.');
  await page.screenshot({ path: testInfo.outputPath('asset-history-preview.png') });
  await preview.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(prompt.getByRole('textbox', { name: '摘要正文' })).toHaveValue(
    '预览期间保留的未保存草稿',
  );
  await prompt.getByRole('button', { name: '取消', exact: true }).click();
  await prompt.getByRole('combobox', { name: '结果版本' }).selectOption('1');
  await expect(prompt.locator('.request-prompt-text')).toHaveText(`[user] ${promptText}`);
  await expect(prompt.locator('.node-duration-badge')).toHaveText('12.4秒');
  await prompt.getByRole('button', { name: '编辑摘要', exact: true }).click();
  await prompt.getByRole('textbox', { name: '摘要正文' }).fill('第一版独立保存的摘要');
  await prompt.getByRole('button', { name: '保存摘要', exact: true }).click();
  await expect(prompt.locator('.request-prompt-summary')).toHaveText('第一版独立保存的摘要');
  await prompt.getByRole('combobox', { name: '结果版本' }).selectOption('2');
  await expect(prompt.locator('.request-prompt-summary')).toHaveText('第二版摘要');
  await page.keyboard.press('Escape');
  await save(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await page.getByRole('button', { name: '生成记录 已生成文字.txt', exact: true }).click();
  await prompt.getByRole('combobox', { name: '结果版本' }).selectOption('1');
  await expect(prompt.locator('.request-prompt-summary')).toHaveText('第一版独立保存的摘要');
  await page.screenshot({ path: testInfo.outputPath('asset-history-restored.png') });
  expect(fixture.errors).toEqual([]);
});

for (const zoom of [0.25, 1, 2]) {
  test(`分组缩放往返：${zoom * 100}% 移动、缩放、撤销、保存及刷新`, async ({ page }, testInfo) => {
    const fixture = await installFixture(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openCanvas(page);
    await zoomCanvas(page, zoom);
    if (zoom === 2) {
      const pane = (await page.locator('.react-flow__pane').boundingBox())!;
      await page.mouse.move(pane.x + 160, pane.y + 80);
      await page.mouse.down();
      await page.mouse.move(pane.x + 60, pane.y + 80, { steps: 6 });
      await page.mouse.up();
    }
    const group = page.locator('.canvas-group');
    if (zoom === 0.25) {
      const header = group.locator('.canvas-group-header');
      const headerBounds = (await header.boundingBox())!;
      const memberBounds = (await page
        .locator('.react-flow__node[data-id="generated-text"]')
        .boundingBox())!;
      expect(headerBounds.y + headerBounds.height).toBeLessThan(memberBounds.y);
      const hit = await header.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Boolean(
          document
            .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            ?.closest('.canvas-group-header'),
        );
      });
      expect(hit).toBe(true);
      await group.locator('.canvas-group-name').focus();
      const card = page.getByRole('region', { name: '创作资料分组信息' });
      await expect(card).toBeVisible();
      await expect(card).toContainText('2 个节点');
      expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(46);
      await page.screenshot({ path: testInfo.outputPath('group-25-accessible-header.png') });
    }
    await drag(page, group.locator('.canvas-group-header'), 20, 15);
    await save(page);
    const moved = structuredClone(fixture.canvas());
    expect(moved.nodes[0]!.position.x).toBeCloseTo(100 + 20 / zoom, 1);
    expect(moved.nodes[0]!.position.y).toBeCloseTo(140 + 15 / zoom, 1);
    await drag(page, group.locator('[data-corner="se"]'), 20, 15);
    await save(page);
    expect(fixture.canvas().groups![0]!.width).toBeCloseTo(moved.groups![0]!.width + 20 / zoom, 1);
    expect(fixture.canvas().nodes.map((entry) => entry.position)).toEqual(
      moved.nodes.map((entry) => entry.position),
    );
    await page.screenshot({ path: testInfo.outputPath(`group-${zoom * 100}.png`) });
    await page.getByRole('button', { name: '画布撤销', exact: true }).click();
    await save(page);
    expect(fixture.canvas().groups).toEqual(moved.groups);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.canvas-group')).toHaveCount(1);
    await expect
      .poll(() =>
        page
          .locator('.react-flow__node[data-id="generated-text"]')
          .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m41),
      )
      .toBeCloseTo(moved.nodes[0]!.position.x, 1);
    expect(fixture.canvas().groups![0]!.nodeIds).toEqual(['generated-text', 'filled-text']);
    expect(fixture.errors).toEqual([]);
  });
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  for (const theme of ['明亮', '深色']) {
    test(`视觉：${viewport.width}x${viewport.height} ${theme} 设置与长提示词`, async ({
      page,
    }, testInfo) => {
      const fixture = await installFixture(page);
      await page.setViewportSize(viewport);
      await openCanvas(page);
      await page.getByRole('button', { name: '外观', exact: true }).first().click();
      const appearance = page.getByRole('dialog', { name: '主题、画布背景与连接线' });
      await appearance.getByRole('tab', { name: '主题', exact: true }).click();
      await appearance.getByRole('button', { name: theme, exact: true }).click();
      await page.keyboard.press('Escape');
      await page.screenshot({ path: testInfo.outputPath('canvas.png') });
      await page.getByRole('button', { name: '打开设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'AI 连接', exact: true });
      await settings.getByRole('tab', { name: '节点默认', exact: true }).click();
      const bounds = await settings.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({ path: testInfo.outputPath('settings.png') });
      await expectReadableText(settings.locator('.settings-default-type').first());
      await expectReadableText(settings.getByRole('heading', { name: '节点默认', exact: true }));
      await page.keyboard.press('Escape');
      const node = page.locator('.react-flow__node[data-id="generated-text"]');
      await node.hover();
      await node.getByRole('button', { name: '查看节点信息' }).click();
      await page.getByRole('button', { name: /查看生成提示词/ }).click();
      const prompt = page.getByRole('dialog', { name: '生成提示词' });
      await expect(prompt.locator('.request-prompt-text')).toHaveText(`[user] ${promptText}`);
      expect(await prompt.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath('prompt-long.png') });
      await expectReadableText(prompt.locator('.request-prompt-summary'));
      await expectReadableText(prompt.locator('.request-prompt-text'));
      expect(fixture.errors).toEqual([]);
    });
  }
}
