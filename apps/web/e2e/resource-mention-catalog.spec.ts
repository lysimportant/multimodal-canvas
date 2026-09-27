import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  canvasDocumentSchema,
  type Asset,
  type CanvasDocument,
  type PromptDocument,
  type RunRecord,
} from '@multimodal-canvas/domain';

/** 仅存在于路由内存中的合成项目，不读取或修改用户项目。 */
const project = {
  id: 'resource-mention-catalog',
  name: '资源提及目录回归',
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};
/** 精确复现目录的输出媒体与提及声明不一致；不借助模型名称特例。 */
const model = {
  id: 'gpt-image-2.5-sunburst',
  name: 'gpt-image-2.5-sunburst',
  mediaTypes: ['image'],
  capabilities: { mentionMediaTypes: ['text'] },
  credentialId: 'catalog-test-credential',
  group: 'default',
  available: true,
};
/** 复用仓库内的真实位图作为参考与合成结果，不请求外部素材。 */
const image = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
/** 图片资源有明确版本，必须通过 picker 插入结构化提及，而不是普通文字。 */
const reference: Asset = {
  id: 'catalog-reference',
  name: 'reference.jpg',
  mediaType: 'image',
  mimeType: 'image/jpeg',
  sizeBytes: image.byteLength,
  status: 'ready',
  latestVersion: 1,
  contentUrl: '/v1/assets/catalog-reference/versions/1/content',
  tags: [],
};
/** 请求体与提交瞬间已保存的输入边分别留证，不能用合成响应替代请求断言。 */
type Submission = { nodeId: string; body: Record<string, unknown>; canvas: CanvasDocument };

/** 返回合成 JSON；status 是 HTTP 状态码，任何调用都不会转发给 API。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * 截获全部 API 与外部请求；只允许隔离 Web 站点加载静态页面资源。
 * @param page 当前测试的独立浏览器页面。
 * @param baseURL Playwright 的隔离 Web 地址，缺失时拒绝启动。
 * @param failure 首份创建的合成失败；省略时返回独立图片结果，不模拟 Provider 能力校验。
 * @returns 内存画布、实际 POST、运行记录及浏览器错误，用于断言没有额外发送。
 * @throws 缺少 baseURL 或画布不符合领域结构时抛错。
 */
async function installFixture(
  page: Page,
  baseURL: string | undefined,
  failure?: 'HTTP 400' | '断网',
) {
  if (!baseURL) throw new Error('请指定隔离浏览器验收地址');
  const webOrigin = new URL(baseURL).origin;
  let canvas = canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: 'reference-node',
        type: 'image',
        position: { x: 120, y: 220 },
        width: 260,
        height: 200,
        data: {
          label: '参考图片',
          mediaType: 'image',
          mode: 'source',
          assetId: reference.id,
          contentUrl: reference.contentUrl,
          mimeType: reference.mimeType,
        },
      },
      {
        id: 'generation-root',
        type: 'image',
        position: { x: 520, y: 220 },
        width: 320,
        height: 240,
        data: {
          label: '两份图片',
          mediaType: 'image',
          mode: 'generate',
          modelAlias: model.id,
          credentialId: model.credentialId,
          parameters: { aspectRatio: '1:1' },
        },
      },
    ],
    edges: [
      {
        id: 'reference-edge',
        sourceNodeId: 'reference-node',
        targetNodeId: 'generation-root',
        sourceHandle: 'output:image',
        targetHandle: 'input:content',
        order: 0,
      },
    ],
  });
  const submissions: Submission[] = [];
  const runs = new Map<string, RunRecord>();
  const assets = [structuredClone(reference)];
  const errors: string[] = [];
  const consoleErrors: Array<{ message: string; url: string }> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push({ message: message.text(), url: message.location().url });
  });
  const user = {
    id: 'catalog-test-user',
    email: 'catalog@example.test',
    role: 'user',
    createdAt: project.createdAt,
  };
  await page.addInitScript((user) => {
    localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user }));
  }, user);
  await page.clock.install();
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
      )
        return route.continue();
      errors.push(`已阻断未声明网络请求：${method} ${url.origin}${path}`);
      return route.abort('blockedbyclient');
    }
    if (method === 'GET' && path === '/v1/auth/me')
      return json(route, { user, expiresAt: '2099-01-01T00:00:00.000Z' });
    if (method === 'GET' && path === '/v1/projects') return json(route, { projects: [project] });
    if (method === 'GET' && path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path === `/v1/projects/${project.id}/canvas`) {
      if (method === 'PATCH')
        canvas = canvasDocumentSchema.parse({
          ...request.postDataJSON(),
          revision: canvas.revision + 1,
        });
      if (method === 'GET' || method === 'PATCH') return json(route, { canvas });
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/events`)
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (method === 'GET' && path === `/v1/projects/${project.id}/models/defaults`)
      return json(route, { defaults: {} });
    if (method === 'GET' && path === '/v1/settings/ai')
      return json(route, { settings: { defaultModels: {}, timeoutMs: 900_000 } });
    if (method === 'GET' && path === '/v1/models') return json(route, { models: [model] });
    if (method === 'GET' && path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (method === 'GET' && path === '/v1/assets') return json(route, { assets });
    if (method === 'POST' && /^\/v1\/assets\/[^/]+\/access-url$/.test(path)) {
      const asset = assets.find((entry) => entry.id === path.split('/')[3]);
      if (asset) return json(route, { url: asset.contentUrl });
    }
    if (method === 'GET' && assets.some((asset) => asset.contentUrl === path))
      return route.fulfill({ contentType: 'image/jpeg', body: image });
    if (method === 'GET' && path.endsWith('/reverse-prompts'))
      return json(route, { analysis: null });
    if (method === 'GET' && path.endsWith('/request-prompts')) return json(route, { records: [] });
    const target = /^\/v1\/nodes\/([^/]+)\/runs$/.exec(path);
    if (method === 'POST' && target) {
      const nodeId = decodeURIComponent(target[1]!);
      const body = request.postDataJSON() as Record<string, unknown>;
      const savedCanvas = structuredClone(canvas);
      submissions.push({ nodeId, body, canvas: savedCanvas });
      if (failure === 'HTTP 400')
        return json(route, { error: '输入参数不合法', code: 'INVALID_INPUT' }, 400);
      if (failure === '断网') return route.abort('internetdisconnected');
      const resultAsset = {
        ...reference,
        id: `catalog-result-${submissions.length}`,
        name: `合成图片 ${submissions.length}`,
        contentUrl: `/v1/assets/catalog-result-${submissions.length}/versions/1/content`,
      };
      assets.push(resultAsset);
      const run: RunRecord = {
        id: `catalog-run-${submissions.length}`,
        projectId: project.id,
        targetNodeId: nodeId,
        status: 'succeeded',
        progress: 100,
        attempt: 1,
        provider: 'mock',
        modelAlias: body.modelAlias as string,
        snapshot: {
          projectId: project.id,
          targetNodeId: nodeId,
          canvasRevision: savedCanvas.revision,
          modelAlias: body.modelAlias as string,
          parameters: body.parameters as Record<string, unknown>,
          submittedAt: project.createdAt,
          nodes: savedCanvas.nodes,
          edges: savedCanvas.edges,
          inputs: [],
        },
        result: {
          provider: 'mock',
          summary: resultAsset.name,
          targetNodeId: nodeId,
          mediaType: 'image',
          inputCount: savedCanvas.edges.filter((edge) => edge.targetNodeId === nodeId).length,
          asset: {
            assetId: resultAsset.id,
            version: 1,
            contentUrl: resultAsset.contentUrl,
            mimeType: resultAsset.mimeType,
            sizeBytes: resultAsset.sizeBytes,
          },
        },
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
      runs.set(run.id, run);
      return json(route, { run }, 202);
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/runs`)
      return json(route, { runs: [...runs.values()] });
    if (method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(path))
      return json(route, { run: runs.get(path.split('/')[3]!) });
    errors.push(`未声明的 Mock 接口：${method} ${path}`);
    return route.abort('blockedbyclient');
  });
  return { submissions, runs, errors, consoleErrors, canvas: () => structuredClone(canvas) };
}

test.use({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' });

for (const outcome of ['成功', 'HTTP 400', '断网'] as const) {
  test(`目录仅声明文字提及的图片模型选择两份：${outcome}，不自动重发`, async ({
    page,
    baseURL,
  }, testInfo) => {
    const fixture = await installFixture(page, baseURL, outcome === '成功' ? undefined : outcome);
    await page.goto(`/projects/${project.id}`);
    const root = page.locator('.react-flow__node[data-id="generation-root"]');
    await expect(root).toBeVisible({ timeout: 15_000 });
    await root.getByText('尚未生成', { exact: true }).click();
    const editor = page.getByRole('region', { name: '两份图片生成设置' });
    await expect(editor.getByRole('combobox', { name: /^模型：/ })).toHaveAccessibleName(
      `模型：${model.id} · default`,
    );
    const prompt = editor.getByRole('textbox', { name: '提示词', exact: true });
    await prompt.fill('Use @reference');
    await page.getByRole('option', { name: /reference.jpg/ }).click();
    await editor.getByRole('combobox', { name: '生成数量：1份' }).click();
    await page
      .getByRole('listbox', { name: '生成数量选项' })
      .getByRole('option', { name: '2份', exact: true })
      .click();
    await expect(editor.getByRole('combobox', { name: '生成数量：2份' })).toBeVisible();
    const expectedPrompt = (await prompt.inputValue()).trim();
    expect(expectedPrompt).toMatch(/^Use\s+reference/);
    expect(fixture.submissions).toEqual([]);
    await editor.getByRole('button', { name: '生成', exact: true }).click();
    const expectedCount = outcome === '成功' ? 2 : 1;
    if (outcome === '成功') {
      await expect(page.getByText('已完成 2 份生成', { exact: true })).toBeVisible();
      await root.getByRole('button', { name: '展开 2 个生成结果' }).click();
      expect(fixture.runs.size).toBe(2);
      expect(
        new Set([...fixture.runs.values()].map((run) => run.result!.asset!.assetId)).size,
      ).toBe(2);
      for (const submission of fixture.submissions) {
        const preview = page.locator(`.react-flow__node[data-id="${submission.nodeId}"] img`);
        await expect(preview).toBeVisible();
        await expect
          .poll(() => preview.evaluate((element) => (element as HTMLImageElement).naturalWidth))
          .toBeGreaterThan(0);
      }
      await page.screenshot({ path: testInfo.outputPath('two-image-mentions-succeeded.png') });
    } else {
      await expect(
        page.getByText(/已完成 0\/2 份.*已停止后续提交，请先核对运行记录/),
      ).toBeVisible();
      expect(fixture.runs.size).toBe(0);
    }
    await expect(editor.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
    expect(fixture.submissions).toHaveLength(expectedCount);
    expect(new Set(fixture.submissions.map((submission) => submission.nodeId)).size).toBe(
      expectedCount,
    );
    const promptDocument = fixture.submissions[0]!.body.promptDocument as PromptDocument;
    expect(promptDocument.blocks).toEqual([
      { type: 'text', text: 'Use ' },
      expect.objectContaining({
        type: 'mention',
        mentionId: expect.any(String),
        assetId: reference.id,
        assetVersion: 1,
        label: reference.name,
        mediaType: 'image',
      }),
    ]);
    for (const submission of fixture.submissions) {
      expect(submission.body).toMatchObject({
        projectId: project.id,
        modelAlias: model.id,
        credentialId: model.credentialId,
        promptDocument,
        parameters: { aspectRatio: '1:1', prompt: expectedPrompt },
      });
      expect(submission.body.parameters).not.toHaveProperty('generationCount');
      expect(
        submission.canvas.nodes.find((node) => node.id === submission.nodeId)?.data,
      ).toMatchObject({
        modelAlias: model.id,
        promptDocument,
      });
      expect(
        submission.canvas.nodes.find((node) => node.id === 'reference-node')?.data,
      ).toMatchObject({
        assetId: reference.id,
        contentUrl: reference.contentUrl,
        mimeType: reference.mimeType,
      });
      expect(
        submission.canvas.edges.filter((edge) => edge.targetNodeId === submission.nodeId),
      ).toEqual([
        expect.objectContaining({
          sourceNodeId: 'reference-node',
          sourceHandle: 'output:image',
          targetHandle: 'input:content',
          order: 0,
        }),
      ]);
    }
    await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: /已保存|已从项目恢复/ })).toBeVisible();
    await page.clock.fastForward(65_000);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
    });
    await page.reload();
    await expect(root).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await page.clock.fastForward(65_000);
    expect(fixture.submissions).toHaveLength(expectedCount);
    expect(fixture.canvas().edges).toHaveLength(2);
    expect(fixture.errors).toEqual([]);
    expect(fixture.consoleErrors).toEqual(
      outcome === '成功'
        ? []
        : [
            {
              message: expect.stringMatching(
                outcome === 'HTTP 400' ? /400/ : /ERR_INTERNET_DISCONNECTED/,
              ),
              url: expect.stringMatching(/\/v1\/nodes\/generation-root\/runs$/),
            },
          ],
    );
    await testInfo.attach('intercepted-generation-requests', {
      body: JSON.stringify({ model, outcome, submissions: fixture.submissions }, null, 2),
      contentType: 'application/json',
    });
  });
}
