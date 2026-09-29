import { expect, test, type Page, type Route } from '@playwright/test';
import { canvasDocumentSchema, type MediaType, type RunRecord } from '@multimodal-canvas/domain';

/** 每个用例只使用本文件的内存项目，所有业务网络均由路由拦截。 */
const project = {
  id: 'node-parameter-submission-browser',
  name: '生成参数隔离回归',
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
};
/** 仅测试字段身份，不包含真实凭据或可访问外部服务的密钥。 */
const credentialId = 'synthetic-parameter-credential';
/** 可独立恢复旧参数并选择媒体类型；未给出目录质量枚举时不展示原生质量控件。 */
type ParameterScenario = {
  mediaType?: MediaType;
  modelAlias?: string;
  parameters: Record<string, unknown>;
  nativeQuality?: boolean;
};

test.use({ serviceWorkers: 'block' });

/** 返回合成 JSON；终态任务仅用于断言请求体，绝不请求 Provider。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * 启动隔离画布、目录和一次性提交记录；不认识的网络请求立即阻断并纳入错误断言。
 * @returns 当前内存画布、原始 POST 参数和控制台错误，供刷新及零请求校验。
 */
async function installFixture(
  page: Page,
  baseURL: string | undefined,
  scenario: ParameterScenario,
) {
  if (!baseURL) throw new Error('缺少隔离浏览器地址');
  const origin = new URL(baseURL).origin;
  const mediaType = scenario.mediaType ?? 'image';
  const modelAlias = scenario.modelAlias ?? 'gpt-image-2.5-sunburst';
  const user = {
    id: 'parameter-user',
    email: 'parameter@example.test',
    role: 'user',
    createdAt: project.createdAt,
  };
  const errors: string[] = [];
  const submissions: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [];
  const runs = new Map<string, RunRecord>();
  let canvas = canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: 'parameter-node',
        type: mediaType,
        position: { x: 380, y: 220 },
        width: 320,
        height: 180,
        data: {
          label: '参数验收节点',
          mediaType,
          mode: 'generate',
          enabled: true,
          modelAlias,
          credentialId,
          prompt: 'Create a scene with soft light.',
          parameters: scenario.parameters,
          ...(mediaType === 'video' ? { videoMode: 'text_to_video' } : {}),
        },
      },
    ],
    edges: [],
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript((user) => {
    localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user }));
  }, user);
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith('/v1/')) {
      if (
        url.origin === origin &&
        method === 'GET' &&
        !['fetch', 'xhr', 'eventsource'].includes(request.resourceType())
      )
        return route.continue();
      errors.push(`已阻断未声明网络请求：${method} ${url.origin}${path}`);
      return route.abort('blockedbyclient');
    }
    if (method === 'GET' && path === '/v1/auth/me')
      return json(route, { user, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    if (method === 'GET' && path === '/v1/projects') return json(route, { projects: [project] });
    if (method === 'GET' && path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path === `/v1/projects/${project.id}/canvas` && (method === 'GET' || method === 'PATCH')) {
      if (method === 'PATCH') {
        patches.push(request.postDataJSON());
        canvas = canvasDocumentSchema.parse({
          ...request.postDataJSON(),
          revision: canvas.revision + 1,
        });
      }
      return json(route, { canvas });
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/events`)
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (method === 'GET' && path === `/v1/projects/${project.id}/runs`)
      return json(route, { runs: [...runs.values()] });
    if (method === 'GET' && path === `/v1/projects/${project.id}/models/defaults`)
      return json(route, { defaults: {}, resolvedDefaults: {} });
    if (method === 'GET' && path === '/v1/settings/ai')
      return json(route, { settings: { defaultModels: {} } });
    if (method === 'GET' && path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (method === 'GET' && path === '/v1/assets') return json(route, { assets: [] });
    if (method === 'GET' && path === '/v1/models')
      return json(route, {
        models: [
          {
            id: modelAlias,
            name: '参数验收模型',
            mediaTypes: [mediaType],
            credentialId,
            group: 'synthetic',
            availability: 'available',
            capabilities: {
              ...(scenario.nativeQuality
                ? { quality: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] }
                : {}),
              ...(mediaType === 'audio' ? { voices: ['custom-voice'] } : {}),
              ...(mediaType === 'text' ? { reasoning_effort: ['low', 'high'] } : {}),
            },
          },
        ],
      });
    if (method === 'POST' && path === '/v1/nodes/parameter-node/runs') {
      const body = request.postDataJSON() as Record<string, unknown>;
      submissions.push(body);
      const timestamp = new Date().toISOString();
      const run: RunRecord = {
        id: 'parameter-run-' + submissions.length,
        projectId: project.id,
        targetNodeId: 'parameter-node',
        status: 'succeeded',
        progress: 100,
        attempt: 1,
        provider: 'newapi',
        modelAlias,
        createdAt: timestamp,
        updatedAt: timestamp,
        snapshot: {
          projectId: project.id,
          canvasRevision: canvas.revision,
          targetNodeId: 'parameter-node',
          modelAlias,
          parameters: body.parameters as Record<string, unknown>,
          submittedAt: timestamp,
          nodes: canvas.nodes,
          edges: [],
          inputs: [],
        },
      };
      runs.set(run.id, run);
      return json(route, { run }, 202);
    }
    if (method === 'GET' && /^\/v1\/runs\/parameter-run-\d+$/.test(path))
      return json(route, { run: runs.get(path.split('/').at(-1)!) });
    errors.push(`未声明的合成接口：${method} ${path}`);
    return route.abort('blockedbyclient');
  });
  await page.goto(`/projects/${project.id}`);
  await selectNode(page);
  return { errors, submissions, patches, canvas: () => structuredClone(canvas) };
}

/** 等待画布完成定位再点击节点，避免入场缩放动画造成命中漂移。 */
async function selectNode(page: Page) {
  const node = page.locator('.react-flow__node[data-id="parameter-node"]');
  await expect(node).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() =>
      page
        .locator('.react-flow__viewport')
        .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
    )
    .toBeCloseTo(1.1, 3);
  const box = (await node.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.quick-editor-overlay')).toBeVisible();
}

/** 参数页与 Select 均使用真实 portal；按可访问名称操作，不使用 DOM 修改。 */
async function openParameters(page: Page) {
  await page.getByRole('button', { name: '媒体参数', exact: true }).click();
  await expect(page.getByRole('region', { name: '生成参数' })).toBeVisible();
}

/** 选择一个明确的字段选项，保持父参数页开启。 */
async function choose(page: Page, label: string, option: RegExp) {
  await page.getByRole('combobox', { name: new RegExp('^' + label + '：') }).click();
  await page.getByRole('option', { name: option }).click();
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
]) {
  test.describe(viewport.width + '×' + viewport.height + ' 桌面参数', () => {
    test.use({ viewport });

    for (const presentation of ['快捷', '完整'] as const) {
      test(`${presentation}编辑器显示请求像素，明确改比例后保存新字段并保持刷新`, async ({
        page,
        baseURL,
      }, testInfo) => {
        const fixture = await installFixture(page, baseURL, {
          parameters: { quality: '4k', aspectRatio: '21:9' },
        });
        if (presentation === '完整')
          await page.getByRole('button', { name: '打开完整编辑器' }).click();
        await openParameters(page);
        await expect(page.getByLabel('请求像素')).toHaveText('3840 × 1648');
        expect(fixture.patches).toHaveLength(0);
        expect(fixture.submissions).toHaveLength(0);
        await choose(page, '图片比例', /9:16/);
        await expect(page.getByLabel('请求像素')).toHaveText('2160 × 3840');
        await expect
          .poll(() => fixture.canvas().nodes[0]!.data.parameters)
          .toEqual({ resolution: '4k', aspectRatio: '9:16' });
        await page.screenshot({
          path: testInfo.outputPath('request-pixels.png'),
          animations: 'disabled',
        });
        await page.getByRole('button', { name: '媒体参数', exact: true }).click();
        await page.getByRole('button', { name: '生成', exact: true }).click();
        await expect.poll(() => fixture.submissions.length).toBe(1);
        expect(fixture.submissions[0]).toMatchObject({
          modelAlias: 'gpt-image-2.5-sunburst',
          credentialId,
          parameters: {
            resolution: '4k',
            aspectRatio: '9:16',
            prompt: 'Create a scene with soft light.',
          },
        });
        expect(fixture.submissions[0]!.parameters).not.toHaveProperty('quality');
        await page.reload();
        await selectNode(page);
        await openParameters(page);
        await expect(page.getByLabel('请求像素')).toHaveText('2160 × 3840');
        expect(fixture.submissions).toHaveLength(1);
        expect(fixture.errors).toEqual([]);
      });
    }

    test('已知模型不支持的历史组合不静默改写，用户改比例后才可生成', async ({
      page,
      baseURL,
    }, testInfo) => {
      const parameters = { quality: '4k', aspectRatio: '1:1' };
      const fixture = await installFixture(page, baseURL, { parameters });
      await openParameters(page);
      await expect(page.getByText(/总像素范围/)).toBeVisible();
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
      expect(fixture.canvas().nodes[0]!.data.parameters).toEqual(parameters);
      expect(fixture.patches).toHaveLength(0);
      expect(fixture.submissions).toHaveLength(0);
      await page.screenshot({
        path: testInfo.outputPath('unsupported-image-parameters.png'),
        animations: 'disabled',
      });
      await choose(page, '图片比例', /21:9/);
      await expect(page.getByLabel('请求像素')).toHaveText('3840 × 1648');
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
      expect(fixture.errors).toEqual([]);
    });

    test('显式改清晰度清除旧 size，真实质量保持独立且目录 max 原值提交', async ({
      page,
      baseURL,
    }) => {
      const fixture = await installFixture(page, baseURL, {
        parameters: {
          size: '1024x1024',
          image_size: '1024x1024',
          quality: 'high',
          aspectRatio: '1:1',
        },
        nativeQuality: true,
      });
      await openParameters(page);
      await choose(page, '图片清晰度', /4K/);
      await expect(page.getByText(/总像素范围/)).toBeVisible();
      await choose(page, '图片比例', /9:16/);
      await choose(page, '生成质量', /^MAX$/);
      await expect(page.getByLabel('请求像素')).toHaveText('2160 × 3840');
      await page.getByRole('button', { name: '媒体参数', exact: true }).click();
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => fixture.submissions.length).toBe(1);
      expect(fixture.submissions[0]!.parameters).toEqual({
        resolution: '4k',
        quality: 'max',
        aspectRatio: '9:16',
        prompt: 'Create a scene with soft light.',
      });
      expect(fixture.errors).toEqual([]);
    });

    test('音频自定义旧音色保持可见，改成支持音色后格式和小数语速原值提交', async ({
      page,
      baseURL,
    }) => {
      const fixture = await installFixture(page, baseURL, {
        mediaType: 'audio',
        modelAlias: 'test-tts',
        parameters: { voice: 'custom-voice', response_format: 'wav', speed: 1.25 },
      });
      await openParameters(page);
      await expect(page.getByRole('textbox', { name: '音色', exact: true })).toHaveValue(
        'custom-voice',
      );
      await expect(page.getByText(/当前接口不支持此音色/)).toBeVisible();
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
      expect(fixture.submissions).toHaveLength(0);
      expect(fixture.patches).toHaveLength(0);
      await page.getByRole('textbox', { name: '音色', exact: true }).fill('alloy');
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '媒体参数', exact: true }).click();
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => fixture.submissions.length).toBe(1);
      expect(fixture.submissions[0]!.parameters).toEqual({
        voice: 'alloy',
        response_format: 'wav',
        speed: 1.25,
        prompt: 'Create a scene with soft light.',
      });
      expect(fixture.errors).toEqual([]);
    });

    test('文字节点显示未设置的推理强度不在提交时补 high', async ({ page, baseURL }) => {
      const fixture = await installFixture(page, baseURL, {
        mediaType: 'text',
        modelAlias: 'text-model',
        parameters: {},
      });
      await expect(page.getByRole('combobox', { name: '推理强度：未设置' })).toBeVisible();
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => fixture.submissions.length).toBe(1);
      expect(fixture.submissions[0]!.parameters).toEqual({
        prompt: 'Create a scene with soft light.',
      });
      expect(fixture.errors).toEqual([]);
    });

    test('视频清晰度、比例和整数秒数保持各自字段，不混入图片质量', async ({ page, baseURL }) => {
      const fixture = await installFixture(page, baseURL, {
        mediaType: 'video',
        modelAlias: 'wan3.0-video',
        parameters: { resolution: '720p', aspectRatio: '16:9', duration: 5 },
      });
      await openParameters(page);
      await choose(page, '视频清晰度', /1080P/);
      await choose(page, '视频比例', /9:16/);
      await page.getByRole('button', { name: /^时长（秒）：/ }).click();
      await page
        .getByRole('dialog', { name: '视频时长' })
        .getByRole('button', { name: '10 秒', exact: true })
        .click();
      await page.getByRole('button', { name: '媒体参数', exact: true }).click();
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => fixture.submissions.length).toBe(1);
      expect(fixture.submissions[0]!.parameters).toEqual({
        resolution: '1080p',
        aspectRatio: '9:16',
        duration: 10,
        prompt: 'Create a scene with soft light.',
      });
      expect(fixture.errors).toEqual([]);
    });
  });
}
