import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Asset, CanvasDocument, PromptDocument, RunRecord } from '@multimodal-canvas/domain';
import { canvasDocumentSchema } from '@multimodal-canvas/domain';

/** 所有运行都由路由夹具生成，不连接真实供应商。 */
const project = {
  id: 'node-generation-batch',
  name: '批量生成集成验收',
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
};
/** 本地真实位图与视频使验收同时检查结果媒体的加载。 */
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
const video = readFileSync(new URL('../public/demo/field-study.mp4', import.meta.url));

/** 记录每次创建请求的目标与原始参数，便于确认没有额外提交。 */
type Submission = { nodeId: string; body: Record<string, unknown> };

/** 返回合成 JSON 合同，状态码默认为成功。 */
async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
}

/** 构造待生成节点；图片包含一条上游输入，视频保持文字生视频模式。 */
function makeCanvas(mediaType: 'image' | 'video'): CanvasDocument {
  return canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      ...(mediaType === 'image'
        ? [
            {
              id: 'input-image',
              type: 'image' as const,
              position: { x: 140, y: 230 },
              width: 260,
              height: 180,
              data: {
                label: '参考图片',
                mediaType: 'image' as const,
                mode: 'source' as const,
                assetId: 'reference-image',
                mimeType: 'image/jpeg',
                contentUrl: '/v1/assets/reference-image/content',
              },
            },
          ]
        : []),
      {
        id: 'generation-root',
        type: mediaType,
        position: { x: 500, y: 230 },
        width: 300,
        height: 220,
        data: {
          label: '待生成节点',
          mediaType,
          mode: 'generate',
          enabled: true,
          prompt: 'Show a desk beside a bright window.',
          modelAlias: `mock-${mediaType}`,
          credentialId: 'batch-credential',
          ...(mediaType === 'video' ? { videoMode: 'text_to_video' as const } : {}),
        },
      },
    ],
    edges:
      mediaType === 'image'
        ? [
            {
              id: 'reference-edge',
              sourceNodeId: 'input-image',
              targetNodeId: 'generation-root',
              sourceHandle: 'output:image',
              targetHandle: 'input:content',
              order: 0,
            },
          ]
        : [],
  });
}

/** 安装指定或默认画布与独立运行结果，记录页面错误及未声明接口。 */
async function installFixture(
  page: Page,
  mediaType: 'image' | 'video' = 'image',
  initialCanvas: CanvasDocument = makeCanvas(mediaType),
  additionalAssets: Asset[] = [],
) {
  let canvas = structuredClone(initialCanvas);
  const submissions: Submission[] = [];
  const runs = new Map<string, RunRecord>();
  const assets = structuredClone(additionalAssets);
  const errors: string[] = [];
  if (mediaType === 'image') {
    assets.push({
      id: 'reference-image',
      name: '参考图片',
      mediaType: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: poster.byteLength,
      status: 'ready',
      latestVersion: 1,
      contentUrl: '/v1/assets/reference-image/content',
      tags: [],
    });
  }
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        user: {
          id: 'batch-user',
          displayName: '批量验收用户',
          role: 'admin',
          createdAt: '2026-09-18T00:00:00.000Z',
        },
      }),
    );
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === '/v1/auth/me')
      return json(route, {
        user: {
          id: 'batch-user',
          displayName: '批量验收用户',
          role: 'admin',
          createdAt: project.createdAt,
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    if (path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (path.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path.endsWith('/canvas')) {
      if (request.method() === 'PATCH')
        canvas = { ...request.postDataJSON(), revision: canvas.revision + 1 };
      return json(route, { canvas });
    }
    if (path.endsWith('/models/defaults')) return json(route, { defaults: {} });
    if (request.method() === 'POST' && /^\/v1\/nodes\/[^/]+\/runs$/.test(path)) {
      const nodeId = path.split('/')[3]!;
      const body = request.postDataJSON() as Record<string, unknown>;
      submissions.push({ nodeId, body });
      const node = canvas.nodes.find((entry) => entry.id === nodeId)!;
      const assetId = `result-${submissions.length}-${nodeId}`;
      const contentUrl = `/v1/assets/${assetId}/content`;
      const mimeType = node.data.mediaType === 'video' ? 'video/mp4' : 'image/jpeg';
      const sizeBytes = node.data.mediaType === 'video' ? video.byteLength : poster.byteLength;
      assets.push({
        id: assetId,
        name: `独立结果 ${submissions.length}`,
        mediaType: node.data.mediaType,
        mimeType,
        sizeBytes,
        status: 'ready',
        latestVersion: 1,
        contentUrl,
        tags: [],
      });
      const run: RunRecord = {
        id: `run-${submissions.length}`,
        projectId: project.id,
        targetNodeId: nodeId,
        status: 'succeeded',
        progress: 100,
        attempt: 1,
        provider: 'mock',
        modelAlias: `mock-${node.data.mediaType}`,
        snapshot: {
          projectId: project.id,
          targetNodeId: nodeId,
          canvasRevision: canvas.revision,
          modelAlias: `mock-${node.data.mediaType}`,
          parameters: body.parameters as Record<string, unknown>,
          submittedAt: project.createdAt,
          nodes: canvas.nodes,
          edges: canvas.edges,
          inputs: [],
        },
        result: {
          provider: 'mock',
          summary: `独立结果 ${submissions.length}`,
          targetNodeId: nodeId,
          mediaType: node.data.mediaType,
          inputCount: canvas.edges.filter((edge) => edge.targetNodeId === nodeId).length,
          asset: { assetId, version: 1, contentUrl, mimeType, sizeBytes },
        },
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
      runs.set(run.id, run);
      return json(route, { run }, 202);
    }
    if (path === `/v1/projects/${project.id}/runs`)
      return json(route, { runs: [...runs.values()] });
    if (/^\/v1\/runs\/[^/]+$/.test(path))
      return json(route, { run: runs.get(path.split('/')[3]!) });
    if (path === '/v1/assets') return json(route, { assets });
    if (path.endsWith('/reverse-prompts')) return json(route, { analysis: null });
    if (path.includes('/request-prompts')) return json(route, { records: [] });
    if (path.endsWith('/access-url'))
      return json(route, { url: path.replace('/access-url', '/content') });
    if (path.endsWith('/content')) {
      const asset = assets.find((entry) => path.includes(`/${entry.id}/`));
      return route.fulfill({
        contentType: asset?.mimeType ?? 'image/jpeg',
        body: asset?.mediaType === 'video' ? video : poster,
      });
    }
    if (path === '/v1/account/newapi')
      return json(route, {
        account: {
          issuer: 'https://newapi.example.test',
          externalUserId: 'batch-external-user',
          displayName: '批量验收用户',
          status: 'active',
          groups: [
            {
              group: 'alpha',
              credentialId: 'batch-credential',
              status: 'ready',
              modelCount: 2,
            },
          ],
          links: {},
        },
      });
    if (path === '/v1/settings/ai')
      return json(route, {
        settings: {
          defaultModels: { image: 'mock-image', video: 'mock-video' },
          timeoutMs: 900_000,
        },
      });
    if (path === '/v1/models')
      return json(route, {
        models: ['image', 'video'].map((type) => ({
          id: `mock-${type}`,
          name: `Mock ${type}`,
          mediaTypes: [type],
          group: 'alpha',
          credentialId: 'batch-credential',
          available: true,
        })),
      });
    errors.push(`未声明的 Mock 接口：${request.method()} ${path}`);
    return route.fulfill({ status: 404, body: '未声明的验收接口' });
  });
  await page.goto(`/projects/${project.id}`);
  await expect(page.locator('.react-flow__node[data-id="generation-root"]')).toBeVisible();
  return { errors, submissions, runs, canvas: () => canvas };
}

/** 等待保存或已恢复状态；无画布变更的单次运行由运行记录在刷新后恢复。 */
async function save(page: Page) {
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status', { name: /已保存|已从项目恢复/ })).toBeVisible();
}

for (const count of [1, 2, 3]) {
  test(`数量 ${count} 只提交 ${count} 次，独立结果与输入边可保存刷新`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const fixture = await installFixture(page);
    const root = page.locator('.react-flow__node[data-id="generation-root"]');
    await root.click();
    const editor = page.getByRole('region', { name: '待生成节点生成设置' });
    await editor.getByRole('spinbutton', { name: '生成数量' }).fill(String(count));
    expect(fixture.submissions).toHaveLength(0);
    await editor.getByRole('button', { name: '生成', exact: true }).click();
    await expect(
      page.getByText(count === 1 ? '待生成节点 已完成' : `已完成 ${count} 份生成`, { exact: true }),
    ).toBeVisible();
    expect(fixture.submissions).toHaveLength(count);
    expect(new Set(fixture.submissions.map((entry) => entry.nodeId)).size).toBe(count);
    expect(new Set([...fixture.runs.values()].map((run) => run.result!.asset!.assetId)).size).toBe(
      count,
    );
    await expect(page.locator('.react-flow__node')).toHaveCount(count + 1);
    for (const submission of fixture.submissions) {
      expect(submission.body).toMatchObject({
        projectId: project.id,
        modelAlias: 'mock-image',
        credentialId: 'batch-credential',
        parameters: { prompt: 'Show a desk beside a bright window.' },
      });
      expect(submission.body.parameters).not.toHaveProperty('generationCount');
      expect(submission.body.parameters).not.toHaveProperty('generationBatch');
    }
    if (count > 1) {
      const toggle = root.getByRole('button', { name: `展开 ${count} 个生成结果` });
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('.is-generation-batch-hidden')).toHaveCount(count - 1);
      const bounds = (await root.boundingBox())!;
      const toggleBounds = (await toggle.boundingBox())!;
      expect(toggleBounds.x).toBeGreaterThan(bounds.x + bounds.width / 2);
      expect(toggleBounds.y).toBeLessThan(bounds.y + bounds.height / 2);
      await page.screenshot({ path: testInfo.outputPath(`generated-${count}-collapsed.png`) });
      await toggle.click();
      await expect(page.locator('.is-generation-batch-hidden')).toHaveCount(0);
      await expect(root.getByRole('button', { name: `收起 ${count} 个生成结果` })).toBeVisible();
    } else {
      await expect(root.locator('.flow-node-batch-toggle')).toHaveCount(0);
    }
    for (const submission of fixture.submissions) {
      const node = page.locator(`.react-flow__node[data-id="${submission.nodeId}"]`);
      const preview = node.locator('img');
      await expect(preview).toBeVisible();
      await expect
        .poll(() => preview.evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
    }
    await save(page);
    const saved = structuredClone(fixture.canvas());
    expect(saved.edges).toHaveLength(count);
    for (const submission of fixture.submissions) {
      expect(saved.edges.find((edge) => edge.targetNodeId === submission.nodeId)).toMatchObject({
        sourceNodeId: 'input-image',
        sourceHandle: 'output:image',
        targetHandle: 'input:content',
        order: 0,
      });
    }
    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(count + 1);
    for (const submission of fixture.submissions) {
      await expect(
        page.locator(`.react-flow__node[data-id="${submission.nodeId}"] img`),
      ).toBeVisible();
    }
    if (count > 1) {
      await root.getByRole('button', { name: `收起 ${count} 个生成结果` }).click();
      await expect(page.locator('.is-generation-batch-hidden')).toHaveCount(count - 1);
      await save(page);
      await page.reload();
      await expect(root.getByRole('button', { name: `展开 ${count} 个生成结果` })).toBeVisible();
    }
    expect(fixture.submissions).toHaveLength(count);
    expect(fixture.canvas().edges).toEqual(saved.edges);
    expect(fixture.errors).toEqual([]);
  });
}

test('图片新节点只自动引用最新结果，保留文字要求且不丢弃用户后续显式引用', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const initialCanvas = makeCanvas('image');
  initialCanvas.edges = [];
  const fixture = await installFixture(page, 'image', initialCanvas);
  const root = page.locator('.react-flow__node[data-id="generation-root"]');
  await root.click();
  const editor = page.getByRole('region', { name: '待生成节点生成设置' });
  const instruction = 'Keep the desk and change the lighting to sunset.';
  await editor
    .getByRole('textbox', { name: '提示词', exact: true })
    .fill(`${instruction} @参考图片`);
  await page.getByRole('option', { name: /参考图片/ }).click();
  await editor.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page.getByText('待生成节点 已完成', { exact: true })).toBeVisible();
  expect(fixture.submissions).toHaveLength(1);
  const parentPromptDocument = structuredClone(
    fixture.submissions[0]!.body.promptDocument as PromptDocument,
  );
  expect(parentPromptDocument.blocks).toContainEqual(
    expect.objectContaining({ type: 'mention', assetId: 'reference-image' }),
  );
  expect(fixture.canvas().edges).toEqual([]);
  const latestImage = [...fixture.runs.values()][0]!.result!.asset!;
  await expect(root.locator('img')).toHaveAttribute('src', new RegExp(latestImage.assetId));

  await editor.getByRole('button', { name: '新节点', exact: true }).click();
  await expect(page.getByText('修改 待生成节点 已完成', { exact: true })).toBeVisible();
  expect(fixture.submissions).toHaveLength(2);
  const forkRequest = fixture.submissions[1]!;
  const child = fixture.canvas().nodes.find((node) => node.id === forkRequest.nodeId)!;
  writeFileSync(
    testInfo.outputPath('image-fork-request.json'),
    JSON.stringify({ parentPromptDocument, latestImage, forkRequest, child }, null, 2),
  );
  expect(child.id).not.toBe('generation-root');
  expect(child.data.imageEditSource).toMatchObject({
    sourceNodeId: 'generation-root',
    assetId: latestImage.assetId,
    version: latestImage.version,
    sourceKind: 'result',
  });
  expect(fixture.canvas().edges.filter((edge) => edge.targetNodeId === child.id)).toEqual([
    expect.objectContaining({ sourceNodeId: 'generation-root', targetHandle: 'input:imageEdit' }),
  ]);
  expect((forkRequest.body.promptDocument as PromptDocument | undefined)?.blocks ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'mention' })]),
  );
  expect(forkRequest.body.parameters).toMatchObject({ prompt: instruction });
  expect(child.data.promptDocument).toBeUndefined();
  expect(child.data.resourceRefs ?? []).toEqual([]);
  expect(
    fixture.canvas().nodes.find((node) => node.id === 'generation-root')!.data.promptDocument,
  ).toEqual(parentPromptDocument);
  const childEditor = page.getByRole('region', { name: '修改 待生成节点图片修改设置' });
  await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
  await page.getByRole('button', { name: '自动适配缩放', exact: true }).click();
  const childNode = page.locator(`.react-flow__node[data-id="${child.id}"]`);
  await expect(childNode).toBeInViewport({ ratio: 1 });
  await childNode.click();
  await page.screenshot({ path: testInfo.outputPath('fork-latest-image-only.png') });

  // 这里只检查显式提及仍提交到 API，不用合成成功响应宣称真实供应商支持多图编辑。
  await childEditor
    .getByRole('textbox', { name: '图片修改要求', exact: true })
    .fill('Use the original colors as an additional reference. @参考图片');
  await page.getByRole('option', { name: /参考图片/ }).click();
  await childEditor.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => fixture.submissions.length).toBe(3);
  await expect(page.getByText('修改 待生成节点 已完成', { exact: true })).toBeVisible();
  const explicitRequest = fixture.submissions[2]!;
  expect(explicitRequest.nodeId).toBe(child.id);
  expect((explicitRequest.body.promptDocument as PromptDocument).blocks).toContainEqual(
    expect.objectContaining({ type: 'mention', assetId: 'reference-image' }),
  );
  await save(page);
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  const savedChild = fixture.canvas().nodes.find((node) => node.id === child.id)!;
  expect(savedChild.data.imageEditSource?.assetId).toBe(latestImage.assetId);
  expect(savedChild.data.promptDocument).toEqual(explicitRequest.body.promptDocument);
  expect(
    fixture.canvas().nodes.find((node) => node.id === 'generation-root')!.data.promptDocument,
  ).toEqual(parentPromptDocument);
  expect(fixture.submissions).toHaveLength(3);
  expect(fixture.errors).toEqual([]);
});

test('图片新节点显式追加资源提及与连线，保存刷新后仍提交全部输入', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const connectedAsset: Asset = {
    id: 'reference-image-c',
    name: '连线参考 C',
    mediaType: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: poster.byteLength,
    status: 'ready',
    latestVersion: 1,
    contentUrl: '/v1/assets/reference-image-c/content',
    tags: [],
  };
  const initialCanvas = makeCanvas('image');
  initialCanvas.edges = [];
  initialCanvas.nodes.push({
    id: 'input-image-c',
    type: 'image',
    position: { x: 140, y: 550 },
    width: 260,
    height: 180,
    data: {
      label: connectedAsset.name,
      mediaType: 'image',
      mode: 'source',
      assetId: connectedAsset.id,
      mimeType: connectedAsset.mimeType,
      contentUrl: connectedAsset.contentUrl,
    },
  });
  const fixture = await installFixture(page, 'image', initialCanvas, [connectedAsset]);
  await page.locator('.react-flow__node[data-id="generation-root"]').click();
  const parentEditor = page.getByRole('region', { name: '待生成节点生成设置' });
  await parentEditor
    .getByRole('textbox', { name: '提示词', exact: true })
    .fill('Keep the room layout and brighten the scene. @参考图片');
  await page.getByRole('option', { name: /参考图片/ }).click();
  await parentEditor.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page.getByText('待生成节点 已完成', { exact: true })).toBeVisible();
  expect(fixture.submissions).toHaveLength(1);
  const parentDocument = structuredClone(fixture.submissions[0]!.body.promptDocument);
  const latestImage = [...fixture.runs.values()][0]!.result!.asset!;
  expect(fixture.canvas().edges).toEqual([]);

  await parentEditor.getByRole('button', { name: '新节点', exact: true }).click();
  await expect(page.getByText('修改 待生成节点 已完成', { exact: true })).toBeVisible();
  expect(fixture.submissions).toHaveLength(2);
  const childId = fixture.submissions[1]!.nodeId;
  expect((fixture.submissions[1]!.body.promptDocument as PromptDocument).blocks).toEqual([
    { type: 'text', text: 'Keep the room layout and brighten the scene. ' },
  ]);
  expect(
    fixture.canvas().nodes.find((node) => node.id === childId)!.data.imageEditSource,
  ).toMatchObject({
    assetId: latestImage.assetId,
    version: latestImage.version,
    sourceKind: 'result',
  });
  expect(fixture.canvas().edges).toHaveLength(1);

  await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
  await page.getByRole('button', { name: '自动适配缩放', exact: true }).click();
  const childNode = page.locator(`.react-flow__node[data-id="${childId}"]`);
  await expect(childNode).toBeInViewport({ ratio: 0.99 });
  const sourceHandle = page
    .locator('.react-flow__node[data-id="input-image-c"]')
    .locator('.react-flow__handle.source');
  const targetHandle = childNode.locator('.react-flow__handle[data-handleid="input:content"]');
  await sourceHandle.hover();
  const sourceBounds = (await sourceHandle.boundingBox())!;
  const targetBounds = (await targetHandle.boundingBox())!;
  await page.mouse.move(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBounds.x + targetBounds.width / 2,
    targetBounds.y + targetBounds.height / 2,
    { steps: 20 },
  );
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await childNode.click();
  const childEditor = page.getByRole('region', { name: '修改 待生成节点图片修改设置' });
  await childEditor
    .getByRole('textbox', { name: '图片修改要求', exact: true })
    .fill('Combine the original colors with the connected composition. @参考图片');
  await page.getByRole('option', { name: /参考图片/ }).click();
  await save(page);
  await expect.poll(() => fixture.canvas().edges.length).toBe(2);
  const saved = structuredClone(fixture.canvas());
  const savedChild = saved.nodes.find((node) => node.id === childId)!;
  expect(savedChild.data.promptDocument!.blocks).toContainEqual(
    expect.objectContaining({ type: 'mention', assetId: 'reference-image', assetVersion: 1 }),
  );
  expect(saved.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceNodeId: 'generation-root',
        targetNodeId: childId,
        targetHandle: 'input:imageEdit',
      }),
      expect.objectContaining({
        sourceNodeId: 'input-image-c',
        targetNodeId: childId,
        targetHandle: 'input:content',
      }),
    ]),
  );
  expect(fixture.submissions).toHaveLength(2);

  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await page.getByRole('button', { name: '自动适配缩放', exact: true }).click();
  await expect(childNode).toBeInViewport({ ratio: 0.99 });
  await childNode.click();
  await expect(
    childEditor.getByRole('button', { name: '预览并命名 参考图片', exact: true }),
  ).toBeVisible();
  await expect(
    childEditor.getByRole('button', { name: '预览并命名 连线参考 C', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('explicit-multi-image-restored.png') });
  // 合成响应只用于观察 Web 提交；真实图片数组、供应商能力和结果由服务端测试另行验收。
  await childEditor.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => fixture.submissions.length).toBe(3);
  await expect(page.getByText('修改 待生成节点 已完成', { exact: true })).toBeVisible();
  const request = fixture.submissions[2]!;
  expect(request.nodeId).toBe(childId);
  expect(request.body.promptDocument).toEqual(savedChild.data.promptDocument);
  expect(fixture.canvas().edges).toEqual(saved.edges);
  expect(fixture.canvas().nodes.find((node) => node.id === childId)!.data.imageEditSource).toEqual(
    savedChild.data.imageEditSource,
  );
  expect(
    fixture.canvas().nodes.find((node) => node.id === 'generation-root')!.data.promptDocument,
  ).toEqual(parentDocument);
  writeFileSync(
    testInfo.outputPath('explicit-multi-image-submission.json'),
    JSON.stringify(
      { request, child: savedChild, inputEdges: saved.edges, connectedAsset },
      null,
      2,
    ),
  );
  expect(fixture.errors).toEqual([]);
});

test('视频 15 秒预设和自定义秒数只在手动生成时提交', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const fixture = await installFixture(page, 'video');
  const root = page.locator('.react-flow__node[data-id="generation-root"]');
  await root.click();
  const editor = page.getByRole('region', { name: '待生成节点生成设置' });
  await editor.getByRole('button', { name: '媒体参数', exact: true }).click();
  await page.getByRole('combobox', { name: /^时长（秒）：/ }).click();
  await expect(page.getByRole('option', { name: '16 秒', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: '15 秒', exact: true }).click();
  const seconds = page.getByRole('spinbutton', { name: '自定义秒数' });
  await expect(seconds).toHaveValue('15');
  expect(fixture.submissions).toHaveLength(0);
  await editor.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page.getByText('待生成节点 已完成', { exact: true })).toBeVisible();
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.submissions[0]!.body.parameters).toMatchObject({ duration: 15 });
  await editor.getByRole('button', { name: '媒体参数', exact: true }).click();
  await seconds.fill('0');
  await expect(seconds).toHaveAttribute('aria-invalid', 'true');
  await expect(editor.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
  await seconds.fill('17');
  await expect(seconds).toHaveAttribute('aria-invalid', 'false');
  expect(fixture.submissions).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('video-custom-seconds.png') });
  await editor.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => fixture.submissions.length).toBe(2);
  await expect(page.getByText('待生成节点 已完成', { exact: true })).toBeVisible();
  expect(fixture.submissions[1]!.body.parameters).toMatchObject({ duration: 17 });
  await expect
    .poll(() => root.locator('video').evaluate((element) => element.readyState))
    .toBeGreaterThan(0);
  await save(page);
  await page.reload();
  await root.click();
  await editor.getByRole('button', { name: '媒体参数', exact: true }).click();
  await expect(seconds).toHaveValue('17');
  expect(fixture.submissions).toHaveLength(2);
  expect(fixture.errors).toEqual([]);
});

test('设置默认数量仅作用于新建节点，已有节点仍为一份', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const fixture = await installFixture(page);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'New API 与模型', exact: true });
  await settings.getByRole('tab', { name: '节点默认', exact: true }).click();
  await settings.getByRole('spinbutton', { name: '新节点默认生成数量' }).fill('3');
  await page.screenshot({ path: testInfo.outputPath('default-generation-count.png') });
  await page.keyboard.press('Escape');
  await page.locator('.react-flow__node[data-id="generation-root"]').click();
  await expect(page.getByRole('spinbutton', { name: '生成数量' })).toHaveValue('1');
  await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
  await page.getByRole('button', { name: '新建图片生成节点' }).click();
  await expect(page.getByRole('spinbutton', { name: '生成数量' })).toHaveValue('3');
  await save(page);
  const created = fixture
    .canvas()
    .nodes.find((node) => !['generation-root', 'input-image'].includes(node.id))!;
  expect(created.data.generationCount).toBe(3);
  expect(
    fixture.canvas().nodes.find((node) => node.id === 'generation-root')!.data.generationCount,
  ).toBeUndefined();
  await page.reload();
  await page.getByRole('button', { name: '新建图片生成节点' }).click();
  await expect(page.getByRole('spinbutton', { name: '生成数量' })).toHaveValue('3');
  expect(fixture.submissions).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});
