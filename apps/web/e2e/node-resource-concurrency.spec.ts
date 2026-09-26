import {
  expect,
  test as base,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canvasDocumentSchema,
  type Asset,
  type CanvasDocument,
  type RunRecord,
} from '@multimodal-canvas/domain';

/** 截图和请求证据保存在 Git 忽略目录，不修改共享测试结果或 checkpoint。 */
const evidenceDirectory = fileURLToPath(
  new URL('../../../.data/node-resource-concurrency/', import.meta.url),
);
/** 媒体内容取自仓库，不访问资源服务器或付费 Provider。 */
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
/** 独立合成项目，不复用真实项目 ID。 */
const project = {
  id: 'node-resource-concurrency-browser',
  name: '节点资源与并发隔离验收',
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
};
/** A 的普通提示词含可鼠标圈选的中文，初始没有结构化引用。 */
const originalPrompt = '让白色小猫坐在窗边。';
/** 两个节点具有不同提示词，可发现并发请求错误复用选中节点数据。 */
const nodeLabels = { 'node-a': 'A 节点', 'node-b': 'B 节点' } as const;
/** 只允许两个明确的生成目标。 */
type GenerationNodeId = keyof typeof nodeLabels;
/** 保存真实 HTTP 请求和响应的顺序，不通过墙钟时间判断并发。 */
type Submission = {
  nodeId: GenerationNodeId;
  path: string;
  body: Record<string, unknown>;
  requestOrder: number;
  responseOrder?: number;
};
/** 记录画布写入原始方法和正文，验证 PATCH 与修订号合同。 */
type CanvasWrite = { method: string; body: CanvasDocument; order: number };

/** 创建完整的合成图片资源；名称与节点引用别名相互独立。 */
function makeAsset(id: string, name: string): Asset {
  return {
    id,
    name,
    mediaType: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: poster.byteLength,
    status: 'ready',
    latestVersion: 1,
    contentUrl: `/v1/assets/${id}/versions/1/content`,
    tags: [],
  };
}

/** A 连入源资源，B 没有输入边；二者初始都没有运行记录。 */
function makeCanvas(): CanvasDocument {
  return canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: 'source-image',
        type: 'image',
        position: { x: 70, y: 200 },
        width: 240,
        height: 180,
        data: {
          label: '源参考图片',
          mediaType: 'image',
          mode: 'source',
          assetId: 'reference-image',
          mimeType: 'image/jpeg',
          contentUrl: '/v1/assets/reference-image/versions/1/content',
        },
      },
      ...(['node-a', 'node-b'] as const).map((id, index) => ({
        id,
        type: 'image',
        position: { x: 410 + index * 410, y: 200 },
        width: 310,
        height: 220,
        data: {
          label: nodeLabels[id],
          mediaType: 'image',
          mode: 'generate',
          enabled: true,
          prompt: id === 'node-a' ? originalPrompt : 'Draw a blue boat beside a quiet lake.',
          modelAlias: 'mock-image',
          credentialId: 'synthetic-node-resource-credential',
        },
      })),
    ],
    edges: [
      {
        id: 'reference-to-a',
        sourceNodeId: 'source-image',
        targetNodeId: 'node-a',
        sourceHandle: 'output:image',
        targetHandle: 'input:content',
        order: 0,
      },
    ],
  });
}

/** 返回合成 JSON；未声明的接口必须另行返回失败，不能静默成功。 */
async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
}

/**
 * 安装与已有 picker/batch 规格相同的 auth/project/model Mock。
 * A 的首次 POST 响应可被测试显式释放；状态只由测试推进，确保 B 真正在 A 完成前提交。
 * 未声明 API、资源改名和外部请求均记录为失败，不向真实服务器转发。
 */
async function installFixture(page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error('请在 Playwright 配置或 WEB_BASE_URL 中指定浏览器验收地址');
  const webOrigin = new URL(baseURL).origin;
  let canvas = makeCanvas();
  let order = 0;
  let canvasReads = 0;
  let runListReads = 0;
  let generationConcurrency = 20;
  const concurrencyWrites: number[] = [];
  let holdAResponse = true;
  let releaseA!: () => void;
  const aResponseGate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const assets = [
    makeAsset('reference-image', '源参考图片'),
    makeAsset('character-image', '角色照片'),
  ];
  const submissions: Submission[] = [];
  const canvasWrites: CanvasWrite[] = [];
  const runs = new Map<GenerationNodeId, RunRecord>();
  const completedOrder = new Map<GenerationNodeId, number>();
  const runReads: Array<{ nodeId: string; status: string }> = [];
  const apiRequests: Array<{ method: string; path: string }> = [];
  const errors: string[] = [];
  const consoleMessages: Array<{ type: string; text: string }> = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return;
    consoleMessages.push({ type: message.type(), text: message.text() });
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        user: {
          id: 'node-resource-browser-user',
          displayName: '隔离浏览器用户',
          role: 'admin',
          createdAt: '2026-09-26T00:00:00.000Z',
        },
      }),
    );
  });
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith('/v1/')) {
      if (
        url.origin === webOrigin &&
        method === 'GET' &&
        !['fetch', 'xhr', 'eventsource'].includes(request.resourceType())
      ) {
        return route.continue();
      }
      errors.push(`已阻断未声明的网络请求：${method} ${url.origin}${path}`);
      return route.abort('blockedbyclient');
    }
    apiRequests.push({ method, path });
    if (method === 'GET' && path === '/v1/auth/me') {
      return json(route, {
        user: {
          id: 'node-resource-browser-user',
          displayName: '隔离浏览器用户',
          role: 'admin',
          createdAt: project.createdAt,
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }
    if (method === 'GET' && path === '/v1/projects') return json(route, { projects: [project] });
    if (method === 'GET' && path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path === `/v1/projects/${project.id}/canvas`) {
      if (method === 'GET') {
        canvasReads += 1;
        return json(route, { canvas });
      }
      if (method === 'PATCH') {
        const body = canvasDocumentSchema.parse(request.postDataJSON());
        canvasWrites.push({ method, body: structuredClone(body), order: ++order });
        canvas = { ...body, revision: canvas.revision + 1 };
        return json(route, { canvas });
      }
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/models/defaults`)
      return json(route, { defaults: {}, resolvedDefaults: {} });
    if (method === 'GET' && path === `/v1/projects/${project.id}/events`)
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (method === 'GET' && path === `/v1/projects/${project.id}/runs`) {
      runListReads += 1;
      return json(route, { runs: [...runs.values()] });
    }
    if (method === 'GET' && path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (path === '/v1/admin/generation-concurrency') {
      if (method === 'GET') {
        return json(route, { settings: { concurrency: generationConcurrency, scope: 'queue' } });
      }
      if (method === 'PATCH') {
        const body = request.postDataJSON() as { concurrency?: unknown };
        if (
          typeof body.concurrency !== 'number' ||
          !Number.isSafeInteger(body.concurrency) ||
          body.concurrency < 1
        ) {
          return json(route, { error: '并发数量必须是正整数' }, 400);
        }
        generationConcurrency = body.concurrency;
        concurrencyWrites.push(generationConcurrency);
        return json(route, { settings: { concurrency: generationConcurrency, scope: 'queue' } });
      }
    }
    if (method === 'GET' && path === '/v1/settings/ai')
      return json(route, {
        settings: { defaultModels: { image: 'mock-image' }, timeoutMs: 900_000 },
        resolvedDefaults: { image: 'mock-image' },
      });
    if (method === 'GET' && path === '/v1/models')
      return json(route, {
        models: [
          {
            id: 'mock-image',
            name: 'Mock image',
            mediaTypes: ['image'],
            group: 'alpha',
            credentialId: 'synthetic-node-resource-credential',
            available: true,
          },
        ],
      });
    if (method === 'GET' && path === '/v1/account/newapi')
      return json(route, {
        account: {
          issuer: 'https://newapi.example.test',
          externalUserId: 'synthetic-node-resource-user',
          displayName: '隔离浏览器用户',
          status: 'active',
          groups: [
            {
              group: 'alpha',
              credentialId: 'synthetic-node-resource-credential',
              status: 'ready',
              modelCount: 1,
            },
          ],
          links: {},
        },
      });
    const createRun = path.match(/^\/v1\/nodes\/(node-a|node-b)\/runs$/);
    if (method === 'POST' && createRun) {
      const nodeId = createRun[1] as GenerationNodeId;
      const body = request.postDataJSON() as Record<string, unknown>;
      const submission: Submission = { nodeId, path, body, requestOrder: ++order };
      submissions.push(submission);
      if (runs.has(nodeId)) {
        errors.push(`重复提交：${nodeId}`);
        return json(route, { error: '隔离回归检测到同节点重复 POST' }, 409);
      }
      const run: RunRecord = {
        id: `isolated-run-${nodeId}`,
        projectId: project.id,
        targetNodeId: nodeId,
        status: 'running',
        progress: 20,
        attempt: 1,
        provider: 'mock',
        modelAlias: 'mock-image',
        snapshot: {
          projectId: project.id,
          targetNodeId: nodeId,
          canvasRevision: canvas.revision,
          modelAlias: 'mock-image',
          parameters: body.parameters as Record<string, unknown>,
          submittedAt: project.createdAt,
          nodes: structuredClone(canvas.nodes),
          edges: structuredClone(canvas.edges),
          inputs: [],
        },
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
      runs.set(nodeId, run);
      if (nodeId === 'node-a' && holdAResponse) await aResponseGate;
      submission.responseOrder = ++order;
      return json(route, { run }, 202);
    }
    const getRun = path.match(/^\/v1\/runs\/isolated-run-(node-a|node-b)$/);
    if (method === 'GET' && getRun) {
      const run = runs.get(getRun[1] as GenerationNodeId);
      if (run) {
        runReads.push({ nodeId: run.targetNodeId, status: run.status });
        return json(route, { run });
      }
    }
    if (method === 'GET' && path === '/v1/assets') return json(route, { assets });
    const media = path.match(/^\/v1\/assets\/([^/]+)(?:\/versions\/1)?\/(content|access-url)$/);
    if (media && method === (media[2] === 'access-url' ? 'POST' : 'GET')) {
      const asset = assets.find((item) => item.id === media[1]);
      if (asset) {
        return media[2] === 'access-url'
          ? json(route, { url: asset.contentUrl })
          : route.fulfill({ contentType: asset.mimeType, body: poster });
      }
    }
    errors.push(`未声明的 Mock 接口：${method} ${path}`);
    return json(route, { error: '未声明的隔离测试接口' }, 404);
  });

  return {
    errors,
    consoleMessages,
    apiRequests,
    submissions,
    canvasWrites,
    concurrencyWrites,
    runs,
    completedOrder,
    runReads,
    assets,
    canvas: () => structuredClone(canvas),
    canvasReads: () => canvasReads,
    runListReads: () => runListReads,
    /** 释放 A 的响应，不改变服务端运行状态，也不触发第二次 POST。 */
    releaseAResponse() {
      holdAResponse = false;
      releaseA();
    },
    /** 显式完成指定 Mock 运行；没有创建记录时立即失败，不能补造提交。 */
    complete(nodeId: GenerationNodeId) {
      const run = runs.get(nodeId);
      if (!run) throw new Error(`节点 ${nodeId} 尚未提交，不能完成`);
      const asset = makeAsset(`result-${nodeId}`, `${nodeLabels[nodeId]} 独立结果`);
      assets.push(asset);
      runs.set(nodeId, {
        ...run,
        status: 'succeeded',
        progress: 100,
        updatedAt: '2026-09-26T00:01:00.000Z',
        result: {
          provider: 'mock',
          summary: `${nodeLabels[nodeId]} 独立完成`,
          targetNodeId: nodeId,
          mediaType: 'image',
          inputCount: canvas.edges.filter((edge) => edge.targetNodeId === nodeId).length,
          asset: {
            assetId: asset.id,
            version: 1,
            contentUrl: asset.contentUrl,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
          },
        },
      });
      completedOrder.set(nodeId, ++order);
    },
  };
}

/** 夹具 API 由实现推导，避免复制可变运行状态类型。 */
type Scenario = Awaited<ReturnType<typeof installFixture>>;

/** 保存 PC 截图；文件名使用测试 ID，重跑不会覆盖其他规格的证据。 */
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const directory = join(
    evidenceDirectory,
    `${testInfo.testId.replace(/[^a-zA-Z0-9_-]/g, '_')}-repeat-${testInfo.repeatEachIndex}`,
  );
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

/** 即使业务断言失败也保留网络、console、pageerror 证据，并关闭悬挂的 Mock 响应。 */
const test = base.extend<{ scenario: Scenario }>({
  scenario: async ({ page, baseURL }, use, testInfo) => {
    const scenario = await installFixture(page, baseURL);
    try {
      await use(scenario);
    } finally {
      scenario.releaseAResponse();
      const directory = join(
        evidenceDirectory,
        `${testInfo.testId.replace(/[^a-zA-Z0-9_-]/g, '_')}-repeat-${testInfo.repeatEachIndex}`,
      );
      mkdirSync(directory, { recursive: true });
      const evidencePath = join(directory, 'evidence.json');
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            title: testInfo.title,
            status: testInfo.status,
            apiRequests: scenario.apiRequests,
            submissions: scenario.submissions,
            canvasWrites: scenario.canvasWrites,
            concurrencyWrites: scenario.concurrencyWrites,
            canvasReads: scenario.canvasReads(),
            runListReads: scenario.runListReads(),
            runReads: scenario.runReads,
            completedOrder: Object.fromEntries(scenario.completedOrder),
            canvas: scenario.canvas(),
            runs: [...scenario.runs.values()],
            console: scenario.consoleMessages,
            errors: scenario.errors,
          },
          null,
          2,
        ),
      );
      await testInfo.attach('mock-network-and-browser-diagnostics', {
        path: evidencePath,
        contentType: 'application/json',
      });
      expect(scenario.errors, '浏览器异常、重复提交和任何未声明网络访问都必须为零').toEqual([]);
    }
  },
});

test.use({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });

/** 通过真实画布菜单适配视口，让 PC 截图同时包含源节点、A 和 B。 */
async function fitCanvas(page: Page) {
  await expect(page.locator('.react-flow__node[data-id="node-a"]')).toBeVisible({
    timeout: 20_000,
  });
  const pane = page.locator('.react-flow__pane');
  const bounds = await pane.boundingBox();
  if (!bounds) throw new Error('画布尚未取得可操作范围');
  // 左上角为资源抽屉，右下空白区避开抽屉、节点和底部工具栏。
  await pane.click({
    button: 'right',
    position: { x: bounds.width - 72, y: bounds.height - 144 },
  });
  await page.getByRole('menuitem', { name: '自动适配缩放', exact: true }).click();
  for (const id of ['source-image', 'node-a', 'node-b']) {
    await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).toBeInViewport();
  }
}

/** 打开独立项目并等待实际画布，允许 Vite 首次编译而非缩短业务断言。 */
async function openProject(page: Page) {
  await page.goto(`/projects/${project.id}`);
  await fitCanvas(page);
}

/** 从真实 PC 节点入口打开对应编辑器，不能直接操纵应用状态。 */
async function openEditor(page: Page, nodeId: GenerationNodeId) {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  const editor = page.getByRole('region', { name: `${nodeLabels[nodeId]}生成设置`, exact: true });
  // 已选中的结果图再次点击会打开预览；切换节点时才执行画布入口。
  if (!(await editor.isVisible())) await node.click({ position: { x: 130, y: 80 } });
  await expect(editor).toBeVisible();
  return editor;
}

/** 保存必须经过实际网络写入，并确认服务器响应；不把本地草稿状态当成持久化。 */
async function saveCanvas(page: Page, scenario: Scenario) {
  const previousWrites = scenario.canvasWrites.length;
  const previousRevision = scenario.canvas().revision;
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === `/v1/projects/${project.id}/canvas`,
  );
  await page.keyboard.press('Control+s');
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect((await response.json()).canvas.revision).toBe(previousRevision + 1);
  await expect.poll(() => scenario.canvasWrites.length).toBe(previousWrites + 1);
  await expect(page.getByRole('status', { name: '已保存到项目', exact: true })).toBeVisible();
  return scenario.canvasWrites.at(-1)!;
}

/**
 * 仅测量真实高亮文本的字符矩形，然后使用鼠标按下、拖动、抬起选字。
 * 不设置 selectionRange、不分发 select 事件，也不改变 DOM 或应用状态。
 * @throws 文本不存在、跨行或高亮层缺失时失败，避免错误坐标伪造测试。
 */
async function dragSelect(page: Page, input: Locator, text: string) {
  const points = await input.evaluate((element, selectedText) => {
    const textarea = element as HTMLTextAreaElement;
    const highlight = textarea
      .closest('.resource-mention-composer')
      ?.querySelector('.resource-mention-highlight');
    if (!highlight) throw new Error('缺少提示词高亮层');
    const start = textarea.value.indexOf(selectedText);
    if (start < 0) throw new Error('待圈选文字不存在');
    const walker = document.createTreeWalker(highlight, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      if (start >= offset && start + selectedText.length <= offset + length) {
        const range = document.createRange();
        range.setStart(node, start - offset);
        range.setEnd(node, start - offset + selectedText.length);
        const rects = range.getClientRects();
        if (rects.length !== 1) throw new Error('圈选文字必须在同一行');
        const rect = rects[0]!;
        return { x1: rect.left + 0.2, x2: rect.right - 0.2, y: rect.top + rect.height / 2 };
      }
      offset += length;
      node = walker.nextNode();
    }
    throw new Error('高亮层与提示词文本不一致');
  }, text);
  await page.mouse.move(points.x1, points.y);
  await page.mouse.down();
  await page.mouse.move(points.x2, points.y, { steps: 16 });
  await page.mouse.up();
  await expect
    .poll(() =>
      input.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      }),
    )
    .toBe(text);
  await expect(page.getByRole('listbox', { name: '选择资源', exact: true })).toBeVisible();
  await expect(
    page.getByText(`选择资源，将「${text}」设为引用名称`, { exact: true }),
  ).toBeVisible();
}

/** 真实鼠标点击已禁用按钮，验证不会通过残留事件重复提交。 */
async function attemptDuplicate(page: Page, editor: Locator) {
  const button = editor.getByRole('button', { name: '生成中', exact: true });
  await expect(button).toBeDisabled();
  const box = await button.boundingBox();
  if (!box) throw new Error('忙碌按钮没有可点击矩形');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2 });
}

/** 同时检查完成状态、结果媒体与恢复可用的生成按钮。 */
async function expectCompleted(page: Page, nodeId: GenerationNodeId) {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node.locator('.flow-node-status').first()).toHaveAttribute('title', '已完成');
  await expect
    .poll(() =>
      node
        .locator('img')
        .first()
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  const editor = await openEditor(page, nodeId);
  await expect(editor.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
}

test('连入资源别名通过 PATCH 保存并刷新恢复，revision 递增且源名称不变', async ({
  page,
  scenario,
}, testInfo) => {
  await openProject(page);
  const initial = scenario.canvas();
  const source = initial.nodes.find((node) => node.id === 'source-image')!;
  const originalAsset = structuredClone(scenario.assets[0]);
  const editor = await openEditor(page, 'node-a');
  const prompt = editor.getByRole('textbox', { name: '提示词', exact: true });
  await expect(prompt).toHaveValue(originalPrompt);
  await editor.getByRole('button', { name: '预览并命名 源参考图片', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '资源预览', exact: true });
  await expect(dialog.getByRole('button', { name: '保存名称', exact: true })).toBeEnabled();
  await dialog.getByRole('textbox', { name: '资源名称', exact: true }).fill('窗边参考');
  await screenshot(page, testInfo, 'connected-alias-edit');
  await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    editor.getByRole('button', { name: '预览并命名 窗边参考', exact: true }),
  ).toBeVisible();
  await expect(prompt).toHaveValue(originalPrompt);
  const write = await saveCanvas(page, scenario);
  const target = write.body.nodes.find((node) => node.id === 'node-a')!;
  expect(target.data.resourceRefs).toEqual([
    {
      id: 'connected:reference-image',
      assetId: 'reference-image',
      mediaType: 'image',
      name: '窗边参考',
    },
  ]);
  expect(target.data.prompt).toBe(originalPrompt);
  expect(target.data.promptDocument).toBeUndefined();
  expect(write.body.nodes.find((node) => node.id === 'source-image')).toEqual(source);
  expect(write.body.edges).toEqual(initial.edges);
  const reads = scenario.canvasReads();
  await page.reload();
  await fitCanvas(page);
  await expect.poll(scenario.canvasReads).toBeGreaterThan(reads);
  const restored = await openEditor(page, 'node-a');
  await expect(
    restored.getByRole('button', { name: '预览并命名 窗边参考', exact: true }),
  ).toBeVisible();
  await expect(restored.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue(
    originalPrompt,
  );
  await restored.getByRole('button', { name: '预览并命名 窗边参考', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '资源名称', exact: true })).toHaveValue(
    '窗边参考',
  );
  await page.keyboard.press('Escape');
  expect(scenario.canvas().nodes.find((node) => node.id === 'source-image')).toEqual(source);
  expect(scenario.assets[0]).toEqual(originalAsset);
  expect(
    scenario.apiRequests.filter(
      (entry) =>
        entry.method !== 'GET' &&
        entry.path.startsWith('/v1/assets') &&
        !(entry.method === 'POST' && /^\/v1\/assets\/[^/]+\/access-url$/.test(entry.path)),
    ),
  ).toEqual([]);
  expect(scenario.submissions).toEqual([]);
  await screenshot(page, testInfo, 'connected-alias-restored');
  expect(write.method).toBe('PATCH');
  expect(write.body.revision).toBe(initial.revision);
  expect(scenario.canvas().revision).toBe(initial.revision + 1);
});

test('真实鼠标拖选普通文字，以原文字为 entityName 引用资源且原文刷新后不变', async ({
  page,
  scenario,
}, testInfo) => {
  await openProject(page);
  const editor = await openEditor(page, 'node-a');
  const prompt = editor.getByRole('textbox', { name: '提示词', exact: true });
  await dragSelect(page, prompt, '白色小猫');
  await screenshot(page, testInfo, 'mouse-selection-picker');
  await page
    .getByRole('listbox', { name: '选择资源', exact: true })
    .getByRole('option', { name: /角色照片/ })
    .click();
  await expect(page.getByRole('listbox', { name: '选择资源', exact: true })).toBeHidden();
  await expect(prompt).toHaveValue(originalPrompt);
  await expect(
    editor.getByRole('button', { name: '预览并命名 白色小猫', exact: true }),
  ).toBeVisible();
  const write = await saveCanvas(page, scenario);
  const document = write.body.nodes.find((node) => node.id === 'node-a')!.data.promptDocument;
  expect(document).toEqual({
    version: 1,
    blocks: [
      { type: 'text', text: '让' },
      {
        type: 'mention',
        mentionId: expect.any(String),
        assetId: 'character-image',
        assetVersion: 1,
        label: '角色照片',
        mediaType: 'image',
        entityName: '白色小猫',
      },
      { type: 'text', text: '坐在窗边。' },
    ],
  });
  expect(write.body.nodes.find((node) => node.id === 'node-a')!.data.prompt).toBe(originalPrompt);
  await page.reload();
  await fitCanvas(page);
  const restored = await openEditor(page, 'node-a');
  await expect(restored.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue(
    originalPrompt,
  );
  await expect(
    restored.getByRole('button', { name: '预览并命名 白色小猫', exact: true }),
  ).toBeVisible();
  expect(scenario.assets.find((asset) => asset.id === 'character-image')!.name).toBe('角色照片');
  expect(scenario.submissions).toEqual([]);
  await screenshot(page, testInfo, 'mouse-selection-restored');
});

test('鼠标圈选后取消按钮和 Escape 均不改文字、引用、连线或持久化状态', async ({
  page,
  scenario,
}, testInfo) => {
  await openProject(page);
  const initial = scenario.canvas();
  const editor = await openEditor(page, 'node-a');
  const prompt = editor.getByRole('textbox', { name: '提示词', exact: true });
  for (const [action, text] of [
    ['button', '白色小猫'],
    ['escape', '窗边'],
  ] as const) {
    // 下一次从不同的普通文字起拖，避免原生浏览器把操作解释成拖移既有选区。
    await dragSelect(page, prompt, text);
    if (action === 'button')
      await page.getByRole('button', { name: '取消引用', exact: true }).click();
    else await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: '选择资源', exact: true })).toBeHidden();
    await expect(prompt).toHaveValue(originalPrompt);
    await expect(editor.getByRole('button', { name: /^预览并命名 / })).toHaveCount(1);
    await expect(
      editor.getByRole('button', { name: '预览并命名 源参考图片', exact: true }),
    ).toBeVisible();
  }
  await page.keyboard.press('Control+s');
  await page.waitForLoadState('networkidle');
  expect(scenario.canvasWrites).toEqual([]);
  expect(scenario.canvas()).toEqual(initial);
  await page.reload();
  await fitCanvas(page);
  const restored = await openEditor(page, 'node-a');
  await expect(restored.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue(
    originalPrompt,
  );
  await expect(restored.getByRole('button', { name: /^预览并命名 / })).toHaveCount(1);
  expect(scenario.canvas()).toEqual(initial);
  expect(scenario.submissions).toEqual([]);
  await screenshot(page, testInfo, 'selection-cancel-no-side-effects');
});

for (const phase of ['pending', 'running'] as const) {
  test(`A ${phase} 时 B 独立 POST 并先完成，A 防重复且两节点最终恢复`, async ({
    page,
    scenario,
  }, testInfo) => {
    await openProject(page);
    const editorA = await openEditor(page, 'node-a');
    await editorA.getByRole('button', { name: '生成', exact: true }).dblclick();
    await expect.poll(() => scenario.submissions.length).toBe(1);
    if (phase === 'running') {
      scenario.releaseAResponse();
      await expect
        .poll(() =>
          scenario.runReads.some(
            (entry) => entry.nodeId === 'node-a' && entry.status === 'running',
          ),
        )
        .toBe(true);
    }
    await attemptDuplicate(page, editorA);
    const editorB = await openEditor(page, 'node-b');
    const generateB = editorB.getByRole('button', { name: '生成', exact: true });
    await expect(generateB).toBeEnabled();
    await generateB.click();
    await expect.poll(() => scenario.submissions.length).toBe(2);
    expect(scenario.submissions.map((entry) => entry.nodeId)).toEqual(['node-a', 'node-b']);
    expect(scenario.submissions.map((entry) => entry.path)).toEqual([
      '/v1/nodes/node-a/runs',
      '/v1/nodes/node-b/runs',
    ]);
    for (const submission of scenario.submissions) {
      expect(submission.body).toMatchObject({
        projectId: project.id,
        modelAlias: 'mock-image',
        credentialId: 'synthetic-node-resource-credential',
        parameters: {
          prompt:
            submission.nodeId === 'node-a'
              ? originalPrompt
              : 'Draw a blue boat beside a quiet lake.',
        },
      });
    }
    if (phase === 'pending') expect(scenario.submissions[0]!.responseOrder).toBeUndefined();
    expect(scenario.runs.get('node-a')!.status).toBe('running');
    expect(scenario.completedOrder.has('node-a')).toBe(false);
    scenario.complete('node-b');
    await expectCompleted(page, 'node-b');
    expect(scenario.completedOrder.has('node-a')).toBe(false);
    await screenshot(page, testInfo, `b-completed-a-${phase}`);
    const stillBusyA = await openEditor(page, 'node-a');
    await attemptDuplicate(page, stillBusyA);
    expect(scenario.submissions).toHaveLength(2);
    scenario.releaseAResponse();
    await expect
      .poll(() =>
        scenario.runReads.some((entry) => entry.nodeId === 'node-a' && entry.status === 'running'),
      )
      .toBe(true);
    scenario.complete('node-a');
    await expectCompleted(page, 'node-a');
    await expectCompleted(page, 'node-b');
    expect(scenario.submissions[1]!.requestOrder).toBeLessThan(
      scenario.completedOrder.get('node-a')!,
    );
    expect(scenario.completedOrder.get('node-b')!).toBeLessThan(
      scenario.completedOrder.get('node-a')!,
    );
    if (phase === 'pending')
      expect(scenario.submissions[1]!.responseOrder!).toBeLessThan(
        scenario.submissions[0]!.responseOrder!,
      );
    expect(scenario.submissions).toHaveLength(2);
    await screenshot(page, testInfo, `concurrent-${phase}-both-completed`);
  });
}

test('reload 从服务端恢复两节点忙碌状态并防重复，终态刷新后均可生成', async ({
  page,
  scenario,
}, testInfo) => {
  scenario.releaseAResponse();
  await openProject(page);
  for (const nodeId of ['node-a', 'node-b'] as const) {
    const editor = await openEditor(page, nodeId);
    await editor.getByRole('button', { name: '生成', exact: true }).click();
    await expect
      .poll(() =>
        scenario.runReads.some((entry) => entry.nodeId === nodeId && entry.status === 'running'),
      )
      .toBe(true);
  }
  expect(scenario.submissions).toHaveLength(2);
  // 服务器保存的画布没有忙碌标记，必须由刷新后的 GET runs 恢复，不能依赖组件旧状态。
  for (const node of scenario.canvas().nodes) expect(node.data).not.toHaveProperty('runStatus');
  const reads = scenario.runListReads();
  await page.reload();
  await fitCanvas(page);
  await expect.poll(scenario.runListReads).toBeGreaterThan(reads);
  for (const nodeId of ['node-a', 'node-b'] as const) {
    const editor = await openEditor(page, nodeId);
    await expect(
      page.locator(`.react-flow__node[data-id="${nodeId}"] .flow-node-status`).first(),
    ).toHaveAttribute('title', '运行中');
    await attemptDuplicate(page, editor);
  }
  expect(scenario.submissions).toHaveLength(2);
  await screenshot(page, testInfo, 'reload-restored-busy-nodes');
  scenario.complete('node-b');
  scenario.complete('node-a');
  await page.reload();
  await fitCanvas(page);
  await expectCompleted(page, 'node-a');
  await expectCompleted(page, 'node-b');
  expect(scenario.submissions).toHaveLength(2);
  await screenshot(page, testInfo, 'reload-restored-completed-nodes');
});

/** 读取真实布局与 CSS 变换，不改写 DOM、React Flow 状态或缩放值。 */
async function editorGeometry(editor: Locator) {
  return editor.evaluate((element) => {
    const overlay = element.closest<HTMLElement>('.quick-editor-overlay');
    if (!overlay) throw new Error('节点输入面板没有独立定位层');
    const rect = overlay.getBoundingClientRect();
    const transform = new DOMMatrixReadOnly(getComputedStyle(overlay).transform);
    return { width: rect.width, height: rect.height, x: rect.x, y: rect.y, zoom: transform.a };
  });
}

test('输入面板随画布滚轮缩放，屏幕宽度始终匹配节点', async ({ page, scenario }, testInfo) => {
  await openProject(page);
  const editor = await openEditor(page, 'node-a');
  const node = page.locator('.react-flow__node[data-id="node-a"]');
  const before = await editorGeometry(editor);
  const nodeBefore = await node.boundingBox();
  expect(nodeBefore).not.toBeNull();
  expect(Math.abs(before.width - nodeBefore!.width)).toBeLessThan(1);
  await screenshot(page, testInfo, 'editor-before-zoom');

  const canvas = await page.getByRole('region', { name: '工作流画布' }).boundingBox();
  if (!canvas) throw new Error('画布不存在');
  await page.mouse.move(canvas.x + canvas.width - 120, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, 320);
  await expect
    .poll(async () => (await editorGeometry(editor)).zoom)
    .toBeLessThan(before.zoom * 0.9);
  await expect
    .poll(async () => {
      const geometry = await editorGeometry(editor);
      const bounds = await node.boundingBox();
      return bounds ? Math.abs(geometry.width - bounds.width) : Infinity;
    })
    .toBeLessThan(1);
  const after = await editorGeometry(editor);
  expect(Math.abs(after.width / before.width - after.zoom / before.zoom)).toBeLessThan(0.01);
  expect(scenario.canvasWrites).toHaveLength(0);
  expect(scenario.submissions).toHaveLength(0);
  await screenshot(page, testInfo, 'editor-after-zoom');
});

test('输入长文不撑大节点，只有拖拽手柄后节点与输入面板一起变窄', async ({
  page,
  scenario,
}, testInfo) => {
  await openProject(page);
  const editor = await openEditor(page, 'node-b');
  const node = page.locator('.react-flow__node[data-id="node-b"]');
  const before = await node.boundingBox();
  if (!before) throw new Error('目标节点不存在');
  await editor
    .getByRole('textbox', { name: '提示词' })
    .fill('Draw a small boat beside a quiet lake. '.repeat(40));
  await expect.poll(async () => (await node.boundingBox())?.width).toBeCloseTo(before.width, 1);
  await expect.poll(async () => (await node.boundingBox())?.height).toBeCloseTo(before.height, 1);

  const handle = node.locator('.react-flow__resize-control.bottom.right');
  await expect(handle).toBeVisible();
  const grip = await handle.boundingBox();
  if (!grip) throw new Error('右下角缩放手柄不可见');
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 70, y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await node.boundingBox())?.width).toBeLessThan(before.width - 20);
  await expect
    .poll(async () => {
      const geometry = await editorGeometry(editor);
      const bounds = await node.boundingBox();
      return bounds ? Math.abs(geometry.width - bounds.width) : Infinity;
    })
    .toBeLessThan(1);
  const write = await saveCanvas(page, scenario);
  expect(write.body.nodes.find((entry) => entry.id === 'node-b')?.width).toBeLessThan(310);
  expect(
    await editor.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  const editorBounds = await editor.boundingBox();
  const runBounds = await editor.getByRole('button', { name: '生成', exact: true }).boundingBox();
  expect(runBounds!.x + runBounds!.width).toBeLessThanOrEqual(
    editorBounds!.x + editorBounds!.width,
  );
  expect(scenario.submissions).toHaveLength(0);
  await screenshot(page, testInfo, 'editor-after-node-resize');
});

test('最小宽度节点的Skill、数量、生成和新节点按钮仍可同排使用', async ({
  page,
  scenario,
}, testInfo) => {
  await openProject(page);
  const node = page.locator('.react-flow__node[data-id="source-image"]');
  await node.click({ position: { x: 100, y: 60 } });
  const editor = page.getByRole('region', { name: '源参考图片生成设置', exact: true });
  await expect(editor).toBeVisible();
  const grip = await node.locator('.react-flow__resize-control.bottom.right').boundingBox();
  if (!grip) throw new Error('来源节点的缩放手柄不可见');
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 150, y, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () =>
      Number(await node.evaluate((element) => getComputedStyle(element).width.replace('px', ''))),
    )
    .toBeCloseTo(180, 0);
  const skill = editor.getByRole('button', { name: 'Skill 配置', exact: true });
  const run = editor.getByRole('button', { name: '生成', exact: true });
  const fork = editor.getByRole('button', { name: '新节点', exact: true });
  for (const button of [skill, run, fork]) {
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    const panel = await editor.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(panel!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
  }
  expect(Math.abs((await skill.boundingBox())!.y - (await run.boundingBox())!.y)).toBeLessThan(1);
  expect(Math.abs((await fork.boundingBox())!.y - (await run.boundingBox())!.y)).toBeLessThan(1);
  expect(
    await editor.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(scenario.submissions).toHaveLength(0);
  await screenshot(page, testInfo, 'editor-minimum-width');
});

test('资源抽屉默认只露出搜索区，悬停展开并释放收起后的画布命中区域', async ({
  page,
  scenario,
}, testInfo) => {
  await openProject(page);
  const drawer = page.getByRole('complementary', { name: '项目资源' });
  await expect(drawer).toHaveClass(/is-collapsed/);
  await expect(drawer.getByPlaceholder('搜索资源')).toBeVisible();
  const compact = await drawer.boundingBox();
  expect(compact!.height).toBeLessThan(160);
  const freePoint = { x: compact!.x + 30, y: compact!.y + compact!.height + 100 };
  expect(
    await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.canvas-area')),
      freePoint,
    ),
  ).toBe(true);
  await page.mouse.click(freePoint.x, freePoint.y);
  await screenshot(page, testInfo, 'resource-drawer-compact');

  await drawer.hover();
  await expect(drawer).toHaveClass(/is-expanded/);
  await expect(drawer.getByRole('button', { name: '预览 角色照片', exact: true })).toBeVisible();
  const expanded = await drawer.boundingBox();
  expect(expanded!.height).toBeGreaterThan(700);
  await screenshot(page, testInfo, 'resource-drawer-expanded');
  await page.mouse.move(1450, 800);
  await expect(drawer).toHaveClass(/is-collapsed/);

  await drawer.getByRole('button', { name: '展开资源栏', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '折叠资源栏', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.mouse.move(1450, 800);
  await expect(drawer).toHaveClass(/is-expanded/);
  await drawer.getByRole('button', { name: '折叠资源栏', exact: true }).click();
  await expect(drawer).toHaveClass(/is-collapsed/);
  await page.mouse.move(1450, 800);

  const search = drawer.getByPlaceholder('搜索资源');
  await search.fill('角色');
  await page.mouse.move(1450, 800);
  await expect(drawer).toHaveClass(/is-expanded/);
  await expect(drawer.getByRole('button', { name: '预览 角色照片', exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: '预览 源参考图片', exact: true })).toHaveCount(0);
  await search.press('Escape');
  await expect(drawer).toHaveClass(/is-collapsed/);
  expect(
    await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.canvas-area')),
      freePoint,
    ),
  ).toBe(true);
  expect(scenario.canvasWrites).toHaveLength(0);
  expect(scenario.submissions).toHaveLength(0);
});

test('连接选项排版无重叠，单点流星沿真实连线运动并持久保留', async ({
  page,
  scenario,
}, testInfo) => {
  await openProject(page);
  await page.locator('.topbar').getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('tab', { name: '连接', exact: true }).click();
  const picker = page.locator('.appearance-antd-popover');
  const cards = picker.locator('.appearance-edge-option');
  await expect(cards).toHaveCount(12);
  const overflow = await cards.evaluateAll((elements) =>
    elements.flatMap((element) => {
      const card = element.getBoundingClientRect();
      const title = element.querySelector('strong')!.getBoundingClientRect();
      const description = element.querySelector('small')!.getBoundingClientRect();
      return title.bottom > description.top + 1 ||
        description.bottom > card.bottom + 1 ||
        description.right > card.right + 1
        ? [element.textContent]
        : [];
    }),
  );
  expect(overflow).toEqual([]);
  await picker.locator('[data-edge-effect="shooting-star"]').click();
  const canvas = page.getByRole('region', { name: '工作流画布' });
  await expect(canvas).toHaveAttribute('data-edge-effect', 'shooting-star');
  const head = canvas.locator('.react-flow__edges .canvas-edge-shooting-star-head');
  await expect(head).toHaveCount(1);
  const firstOffset = await head.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).strokeDashoffset),
  );
  await expect
    .poll(async () =>
      Math.abs(
        (await head.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).strokeDashoffset),
        )) - firstOffset,
      ),
    )
    .toBeGreaterThan(0.04);
  expect(await head.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
  for (const style of ['bezier', 'gentle', 'smoothstep', 'step', 'straight']) {
    await picker.locator(`[data-edge-path-style="${style}"]`).click();
    await expect(canvas).toHaveAttribute('data-edge-path-style', style);
    const basePath = canvas.locator('.react-flow__edges .canvas-flow-edge-path');
    await expect(head).toHaveAttribute('d', (await basePath.getAttribute('d'))!);
  }
  await screenshot(page, testInfo, 'appearance-connection-shooting-star');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() => head.evaluate((element) => getComputedStyle(element).animationName))
    .toBe('none');
  expect(
    await head.evaluate((element) => Number.parseFloat(getComputedStyle(element).strokeDashoffset)),
  ).toBe(-0.5);
  await page.reload();
  await expect(canvas).toHaveAttribute('data-edge-effect', 'shooting-star');
  await expect(canvas).toHaveAttribute('data-edge-path-style', 'straight');
  expect(scenario.canvasWrites).toHaveLength(0);
  expect(scenario.submissions).toHaveLength(0);
});

test('设置页默认并发20，可保存大于20的值并刷新恢复，非法数值不能提交', async ({
  page,
  scenario,
}, testInfo) => {
  await page.goto('/settings');
  await page.getByRole('tab', { name: '生成并发', exact: true }).click();
  const input = page.getByRole('spinbutton', { name: '同时生成上限', exact: true });
  const save = page.getByRole('button', { name: '保存并发', exact: true });
  await expect(input).toHaveValue('20');
  await expect(save).toBeDisabled();
  for (const invalid of ['0', '-1', '1.5']) {
    await input.fill(invalid);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(save).toBeDisabled();
  }
  expect(scenario.concurrencyWrites).toHaveLength(0);
  await input.fill('32');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(/当前已保存：32/)).toBeVisible();
  expect(scenario.concurrencyWrites).toEqual([32]);
  await page.reload();
  await page.getByRole('tab', { name: '生成并发', exact: true }).click();
  await expect(input).toHaveValue('32');
  await expect(save).toBeDisabled();
  expect(scenario.concurrencyWrites).toEqual([32]);
  expect(scenario.submissions).toHaveLength(0);
  expect(scenario.canvasWrites).toHaveLength(0);
  await screenshot(page, testInfo, 'settings-generation-concurrency');
});

test('从展开抽屉拖入提示词后确认引用，抽屉让出画布且不触发生成', async ({
  page,
  scenario,
}, testInfo) => {
  await openProject(page);
  const editor = await openEditor(page, 'node-b');
  const prompt = editor.getByRole('textbox', { name: '提示词', exact: true });
  await prompt.click();
  await page.keyboard.press('Control+End');
  const drawer = page.getByRole('complementary', { name: '项目资源' });
  await drawer.hover();
  await expect(drawer).toHaveClass(/is-expanded/);
  const card = drawer
    .locator('.asset-card')
    .filter({ has: page.getByRole('button', { name: '预览 角色照片', exact: true }) });
  await expect(card).toHaveCount(1);
  await card.dragTo(prompt);
  const picker = page.getByRole('listbox', { name: '确认拖入资源', exact: true });
  await expect(picker).toBeVisible();
  await expect(drawer).toHaveClass(/is-collapsed/);
  await expect(prompt).toHaveValue('Draw a blue boat beside a quiet lake.');
  expect(scenario.canvasWrites).toHaveLength(0);
  await picker.getByRole('option', { name: /角色照片/ }).click();
  await expect(picker).toBeHidden();
  await expect(
    editor.getByRole('button', { name: '预览并命名 角色照片', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  const saved = await saveCanvas(page, scenario);
  expect(
    saved.body.nodes.find((node) => node.id === 'node-b')!.data.promptDocument?.blocks,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'mention', assetId: 'character-image' }),
    ]),
  );
  expect(saved.body.nodes).toHaveLength(3);
  expect(scenario.assets.map((asset) => asset.name)).toEqual(['源参考图片', '角色照片']);
  expect(scenario.submissions).toHaveLength(0);
  await screenshot(page, testInfo, 'resource-drawer-drag-to-prompt');
});
