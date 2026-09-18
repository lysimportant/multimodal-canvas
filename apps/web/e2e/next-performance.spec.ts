import { expect, test, type Page, type Route } from '@playwright/test';
import type { CanvasDocument, RequestPromptRecord } from '@multimodal-canvas/domain';
import { writeFile } from 'node:fs/promises';

/** 固定规模和固定文本，允许同一脚本对历史工作树与当前版本做同机比较。 */
const nodeCount = 100;
/** 项目夹具只接收本地浏览器请求，不连接真实供应商或持久化服务。 */
async function installPerformanceFixture(page: Page) {
  const createdAt = '2026-09-16T10:00:00.000Z';
  const project = {
    id: 'performance-project',
    name: '固定规模性能验收',
    createdAt,
    updatedAt: createdAt,
  };
  let canvas: CanvasDocument = {
    revision: 1,
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      id: `node-${index}`,
      type: 'text',
      position: { x: 100 + (index % 10) * 260, y: 140 + Math.floor(index / 10) * 210 },
      width: 220,
      height: 170,
      data: {
        label: `文字 ${index}`,
        mediaType: 'text',
        mode: 'generate',
        enabled: true,
        prompt: 'A fixed synthetic prompt for rendering measurement.',
        ...(index === 0
          ? {
              assetId: 'performance-asset',
              contentUrl: '/v1/assets/performance-asset/content',
              mimeType: 'text/plain',
            }
          : {}),
      },
    })),
    edges: Array.from({ length: nodeCount - 1 }, (_, index) => ({
      id: `edge-${index}`,
      sourceNodeId: `node-${index}`,
      sourceHandle: 'output:text',
      targetNodeId: `node-${index + 1}`,
      targetHandle: 'input:content',
      order: 0,
    })),
    groups: [
      {
        id: 'large-group',
        name: '100 个成员',
        position: { x: 70, y: 85 },
        width: 2640,
        height: 2150,
        nodeIds: Array.from({ length: nodeCount }, (_, index) => `node-${index}`),
      },
    ],
  };
  const timing = {
    nodeId: 'node-0',
    startedAt: createdAt,
    finishedAt: '2026-09-16T10:00:12.400Z',
    outcome: 'succeeded',
  };
  const record: RequestPromptRecord = {
    schemaVersion: 1,
    runId: 'performance-run',
    nodeId: 'node-0',
    attempt: 1,
    requestIdentity: 'POST /chat/completions#1',
    provider: 'mock',
    modelAlias: 'mock-text',
    mediaType: 'text',
    format: 'messages',
    parts: [{ order: 0, role: 'user', text: 'Long performance prompt. '.repeat(1000) }],
    resources: [],
    sendStatus: 'sent',
    createdAt,
    assetId: 'performance-asset',
    assetVersion: 1,
    summary: '固定规模的长提示词用于比较弹窗打开耗时。',
  };
  const run = {
    id: record.runId,
    projectId: project.id,
    targetNodeId: 'node-0',
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    provider: 'mock',
    modelAlias: 'mock-text',
    snapshot: {
      projectId: project.id,
      canvasRevision: 1,
      targetNodeId: 'node-0',
      modelAlias: 'mock-text',
      parameters: {},
      submittedAt: createdAt,
      nodes: canvas.nodes,
      edges: canvas.edges,
      inputs: [],
    },
    result: {
      provider: 'mock',
      summary: '已归档',
      targetNodeId: 'node-0',
      mediaType: 'text',
      inputCount: 0,
      asset: {
        assetId: 'performance-asset',
        version: 1,
        contentUrl: '/v1/assets/performance-asset/content',
        mimeType: 'text/plain',
        sizeBytes: 100,
      },
    },
    nodeTimings: { 'node-0': timing },
    createdAt,
    updatedAt: timing.finishedAt,
  };
  const running = {
    ...run,
    id: 'performance-running',
    targetNodeId: 'node-1',
    status: 'running',
    result: undefined,
    nodeTimings: {
      'node-1': { nodeId: 'node-1', startedAt: new Date(Date.now() - 30_000).toISOString() },
    },
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-performance',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        user: {
          id: 'performance-user',
          email: 'performance@example.test',
          role: 'admin',
          createdAt: '2026-09-16T10:00:00.000Z',
        },
      }),
    );
    localStorage.setItem('multimodal-canvas:edge-effect', 'meteor');
  });
  await page.route('**/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const send = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/v1/projects') return send({ projects: [project] });
    if (path === `/v1/projects/${project.id}`) return send({ project });
    if (path.endsWith('/canvas')) {
      if (route.request().method() === 'PATCH')
        canvas = { ...route.request().postDataJSON(), revision: canvas.revision + 1 };
      return send({ canvas });
    }
    if (path.endsWith('/models/defaults')) return send({ defaults: {} });
    if (path.endsWith('/request-prompts/prompt-record')) return send({ record });
    if (path.endsWith('/request-prompts'))
      return send({ records: [{ id: 'prompt-record', ...record }], timing });
    if (path.endsWith('/runs')) return send({ runs: [run, running] });
    if (path === `/v1/runs/${run.id}`) return send({ run });
    if (path === `/v1/runs/${running.id}`) return send({ run: running });
    if (path.endsWith('/versions'))
      return send({
        versions: [
          {
            id: 'version-1',
            assetId: record.assetId,
            version: 1,
            sizeBytes: 100,
            createdAt,
            contentUrl: '/v1/assets/performance-asset/content?version=1',
            metadata: { nodeTiming: timing },
          },
        ],
      });
    if (path.endsWith('/access-url')) return send({ url: path.replace('/access-url', '/content') });
    if (path.endsWith('/content'))
      return route.fulfill({ contentType: 'text/plain', body: 'Fixed synthetic result.' });
    if (path === '/v1/assets') return send({ assets: [] });
    if (path === '/v1/settings/ai/credentials') return send({ credentials: [] });
    if (path === '/v1/settings/ai')
      return send({ settings: { configured: false, defaultModels: {} }, credentials: [] });
    if (path === '/v1/models') return send({ models: [] });
    if (path === '/v1/prompt-skills') return send({ skills: [] });
    errors.push(`未声明的接口: ${path}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return { errors, canvas: () => canvas };
}

/** 连续动画帧间隔，反映此环境中的帧调度；不能外推真实 GPU 或生产负载。 */
async function sampleFrames(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const samples: number[] = [];
        let previous = performance.now();
        const tick = (now: number) => {
          samples.push(now - previous);
          previous = now;
          if (samples.length < 120) requestAnimationFrame(tick);
          else resolve(samples.slice(1));
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** 统一输出中位数与 P95，保留原始样本以免均值掩盖偶发停顿。 */
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    samplesMs: values,
  };
}

test('固定规模性能：100 节点、99 连线、100 成员组及长提示词', async ({ page }, testInfo) => {
  test.skip(!process.env.PERFORMANCE_LABEL, '性能比较需独立执行并明确标注基线或当前版本');
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const fixture = await installPerformanceFixture(page);
  await page.goto('/projects/performance-project');
  await expect(page.locator('.react-flow__node')).toHaveCount(nodeCount, { timeout: 20_000 });
  await expect(page.locator('.react-flow__edge')).toHaveCount(nodeCount - 1);
  await page.getByRole('button', { name: '自动适配缩放', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('.react-flow__viewport')
        .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
    )
    .toBeLessThan(0.5);
  const frames = await sampleFrames(page);
  const movement: number[] = [];
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const header = page.locator('.canvas-group-header');
    const bounds = (await header.boundingBox())!;
    const before = performance.now();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 15, bounds.y + bounds.height / 2 + 10, {
      steps: 12,
    });
    await page.mouse.up();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    movement.push(performance.now() - before);
  }
  await page.keyboard.press('Control+s');
  await expect.poll(() => fixture.canvas().nodes[0]!.position.x).toBeGreaterThan(100);
  const node = page.locator('.react-flow__node[data-id="node-0"]');
  await node.hover();
  await node.getByRole('button', { name: '查看节点信息' }).click();
  const dialog: number[] = [];
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const before = performance.now();
    await page.getByRole('button', { name: /查看生成提示词/ }).click();
    await expect(page.locator('.request-prompt-text')).toContainText('Long performance prompt.');
    dialog.push(performance.now() - before);
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
  const activeNode = page.locator('.react-flow__node[data-id="node-1"]');
  await activeNode.hover();
  await activeNode.getByRole('button', { name: '查看节点信息' }).click();
  const duration = page.locator('.node-duration-badge');
  const beforeDuration = await duration.innerText();
  const clockFrames = await sampleFrames(page);
  await expect(duration).not.toHaveText(beforeDuration);
  const result = {
    label: process.env.PERFORMANCE_LABEL ?? 'current',
    nodeCount,
    edgeCount: nodeCount - 1,
    groupMembers: nodeCount,
    viewport: '1920x1080',
    browser: 'Chromium headless',
    animationFrames: distribution(frames),
    groupDrag: distribution(movement),
    promptDialog: distribution(dialog),
    activeClockFrames: distribution(clockFrames),
  };
  await writeFile(testInfo.outputPath('performance.json'), JSON.stringify(result, null, 2));
  await testInfo.attach('performance.json', {
    contentType: 'application/json',
    body: JSON.stringify(result, null, 2),
  });
  console.log(`PERFORMANCE ${JSON.stringify(result)}`);
  expect(fixture.errors).toEqual([]);
});
