import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
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
  emptyCanvas?: boolean;
  capabilities?: Record<string, unknown>;
  additionalModels?: {
    id: string;
    name: string;
    capabilities?: Record<string, unknown>;
  }[];
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
  const webUrl = new URL(baseURL);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(webUrl.hostname) ||
    !webUrl.port ||
    webUrl.port === '8080'
  )
    throw new Error('参数回归只允许独立本地 Web 端口，禁止使用真实 8080 项目');
  const origin = webUrl.origin;
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
    nodes: scenario.emptyCanvas
      ? []
      : [
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
  await page.context().routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    // 只模拟 Vite 的连接确认，不连接 WebSocket 服务或转发业务消息。
    if (url.host === webUrl.host && url.pathname === '/' && url.searchParams.has('token')) {
      socket.send(JSON.stringify({ type: 'connected' }));
      return;
    }
    errors.push(`已阻断未声明 WebSocket：${url.origin}${url.pathname}`);
    socket.close({ code: 1008, reason: 'Only the isolated Vite handshake is allowed' });
  });
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith('/v1/')) {
      if (
        url.origin === origin &&
        method === 'GET' &&
        !['fetch', 'xhr', 'eventsource'].includes(request.resourceType()) &&
        (path === `/projects/${project.id}` ||
          /^\/(?:@vite\/|@id\/|@fs\/|@react-refresh$|src\/|node_modules\/|assets\/|favicon\.)/.test(
            path,
          ))
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
              ...scenario.capabilities,
            },
          },
          ...(scenario.additionalModels ?? []).map((model) => ({
            ...model,
            mediaTypes: [mediaType],
            credentialId,
            group: 'synthetic',
            availability: 'available',
          })),
        ],
      });
    const targetNode = canvas.nodes.find((node) => path === `/v1/nodes/${node.id}/runs`);
    if (method === 'POST' && targetNode) {
      const submittedModel = targetNode.data.modelAlias;
      if (!submittedModel) {
        errors.push('未选择模型的合成节点不得提交生成');
        return route.abort('blockedbyclient');
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      submissions.push(body);
      const timestamp = new Date().toISOString();
      const run: RunRecord = {
        id: 'parameter-run-' + submissions.length,
        projectId: project.id,
        targetNodeId: targetNode.id,
        status: 'succeeded',
        progress: 100,
        attempt: 1,
        provider: 'newapi',
        modelAlias: submittedModel,
        createdAt: timestamp,
        updatedAt: timestamp,
        snapshot: {
          projectId: project.id,
          canvasRevision: canvas.revision,
          targetNodeId: targetNode.id,
          modelAlias: submittedModel,
          parameters: body.parameters as Record<string, unknown>,
          submittedAt: timestamp,
          nodes: canvas.nodes,
          edges: canvas.edges,
          inputs: [],
        },
      };
      runs.set(run.id, run);
      return json(route, { run }, 202);
    }
    if (method === 'GET' && /^\/v1\/runs\/parameter-run-\d+$/.test(path)) {
      const run = runs.get(path.split('/').at(-1)!);
      if (run) return json(route, { run });
    }
    errors.push(`未声明的合成接口：${method} ${path}`);
    return route.abort('blockedbyclient');
  });
  const catalogLoaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/v1/models',
  );
  await page.goto(`/projects/${project.id}`);
  await catalogLoaded;
  if (scenario.emptyCanvas)
    await expect(page.getByRole('button', { name: '新建视频生成节点', exact: true })).toBeEnabled();
  else await selectNode(page);
  return { errors, submissions, patches, canvas: () => structuredClone(canvas) };
}

/** 等待画布完成定位再点击节点，避免入场缩放动画造成命中漂移。 */
async function selectNode(page: Page, nodeId = 'parameter-node') {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
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

/** 打开独立时长浮卡并校验固定滑轨合同；只读取控件，不触发参数保存。 */
async function openDuration(page: Page) {
  const trigger = page.getByRole('button', { name: /^时长（秒）：/ });
  await trigger.click();
  const card = page.getByRole('dialog', { name: '视频时长', exact: true });
  const slider = card.getByRole('slider', { name: '视频时长（秒）', exact: true });
  await expect(card).toBeVisible();
  await expect(card).toBeInViewport({ ratio: 1 });
  await expect(slider).toHaveAttribute('type', 'range');
  await expect(slider).toHaveAttribute('min', '5');
  await expect(slider).toHaveAttribute('max', '30');
  await expect(slider).toHaveAttribute('step', '1');
  await expect(slider).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      slider.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) ===
          element
        );
      }),
    )
    .toBe(true);
  return { trigger, card, slider };
}

/** 从当前原生滑块手柄拖至轨道内侧，返回浏览器产生的整数秒数；不注入 value 或事件。 */
async function dragDuration(page: Page, slider: Locator) {
  const before = Number(await slider.inputValue());
  const bounds = await slider.boundingBox();
  if (!bounds) throw new Error('视频时长滑块没有可拖动的屏幕区域');
  const trackLeft = bounds.x + 10;
  const trackWidth = bounds.width - 20;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(trackLeft + ((before - 5) / 25) * trackWidth, centerY);
  await page.mouse.down();
  try {
    await page.mouse.move(trackLeft + trackWidth * 0.72, centerY, { steps: 16 });
  } finally {
    await page.mouse.up();
  }
  const seconds = Number(await slider.inputValue());
  expect(Number.isSafeInteger(seconds)).toBe(true);
  expect(seconds).toBeGreaterThan(5);
  expect(seconds).toBeLessThan(30);
  expect(seconds).not.toBe(before);
  return seconds;
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
]) {
  test.describe(viewport.width + '×' + viewport.height + ' 桌面参数', () => {
    test.use({ viewport });
    test.describe.configure({ timeout: 60_000 });

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

    for (const presentation of ['快捷', '完整'] as const) {
      test(`${presentation}时长滑块真实拖拽、键盘和 5/30 秒边界保存刷新提交`, async ({
        page,
        baseURL,
      }, testInfo) => {
        const fixture = await installFixture(page, baseURL, {
          mediaType: 'video',
          modelAlias: 'wan3.0-video',
          parameters: { resolution: '720p', aspectRatio: '16:9', duration: 10 },
        });
        if (presentation === '完整')
          await page.getByRole('button', { name: '打开完整编辑器' }).click();
        await openParameters(page);
        const { trigger, card, slider } = await openDuration(page);
        await expect(trigger).toHaveAccessibleName('时长（秒）：10 秒');
        await expect(slider).toHaveValue('10');
        await expect(slider).toHaveAttribute('aria-invalid', 'false');
        expect(fixture.patches).toHaveLength(0);
        await page.screenshot({
          path: testInfo.outputPath('video-duration-slider.png'),
          animations: 'disabled',
        });

        const draggedSeconds = await dragDuration(page, slider);
        await expect
          .poll(() => fixture.canvas().nodes[0]!.data.parameters?.duration)
          .toBe(draggedSeconds);
        await expect(trigger).toHaveAccessibleName(`时长（秒）：${draggedSeconds} 秒`);
        await slider.press('Home');
        await expect(slider).toHaveValue('5');
        await slider.press('ArrowRight');
        await expect(slider).toHaveValue('6');
        await expect.poll(() => fixture.canvas().nodes[0]!.data.parameters?.duration).toBe(6);

        for (const seconds of [5, 30]) {
          await slider.press(seconds === 5 ? 'Home' : 'End');
          await slider.press(seconds === 5 ? 'ArrowLeft' : 'ArrowRight');
          await expect(slider).toHaveValue(String(seconds));
          await expect(trigger).toHaveAccessibleName(`时长（秒）：${seconds} 秒`);
          await expect
            .poll(() => fixture.canvas().nodes[0]!.data.parameters?.duration)
            .toBe(seconds);
          await slider.press('Escape');
          await expect(card).toBeHidden();
          await expect(trigger).toBeFocused();
          await expect(page.getByRole('region', { name: '生成参数' })).toBeVisible();
          if (presentation === '完整')
            await expect(page.locator('.node-quick-editor-dialog')).toBeVisible();
          await page.getByRole('button', { name: '媒体参数', exact: true }).click();
          await page.getByRole('button', { name: '生成', exact: true }).click();
          await expect.poll(() => fixture.submissions.length).toBe(seconds === 5 ? 1 : 2);
          expect(fixture.submissions.at(-1)).toMatchObject({
            modelAlias: 'wan3.0-video',
            credentialId,
            parameters: { resolution: '720p', aspectRatio: '16:9', duration: seconds },
          });
          expect(fixture.submissions.at(-1)!.parameters).not.toHaveProperty('quality');
          await openParameters(page);
          await openDuration(page);
        }

        await page.reload();
        await selectNode(page);
        await openParameters(page);
        await openDuration(page);
        await expect(slider).toHaveValue('30');
        await expect(trigger).toHaveAccessibleName('时长（秒）：30 秒');
        expect(fixture.submissions).toHaveLength(2);
        expect(fixture.errors).toEqual([]);
      });
    }

    test('4–15 秒模型仍显示 5–30 滑轨，30 秒保存刷新后明确阻止提交', async ({
      page,
      baseURL,
    }, testInfo) => {
      const fixture = await installFixture(page, baseURL, {
        mediaType: 'video',
        modelAlias: 'MiniMax-H3',
        parameters: { resolution: '768p', aspectRatio: '16:9', duration: 10 },
      });
      await openParameters(page);
      const { trigger, card, slider } = await openDuration(page);
      await expect(slider).toHaveAccessibleDescription(/当前模型支持 4–15 秒/);
      await slider.press('End');
      await expect(slider).toHaveValue('30');
      await expect(trigger).toHaveAccessibleName('时长（秒）：30 秒');
      await expect(slider).toHaveAttribute('aria-invalid', 'true');
      await expect(card.getByRole('status').filter({ hasText: '4 至 15 秒' })).toBeVisible();
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
      await expect.poll(() => fixture.canvas().nodes[0]!.data.parameters?.duration).toBe(30);
      expect(fixture.submissions).toHaveLength(0);

      await page.reload();
      await selectNode(page);
      await openParameters(page);
      await openDuration(page);
      await expect(slider).toHaveValue('30');
      await expect(slider).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
      await page.screenshot({
        path: testInfo.outputPath('video-duration-unsupported-30s.png'),
        animations: 'disabled',
      });
      expect(fixture.submissions).toHaveLength(0);
      await slider.press('Home');
      for (let step = 0; step < 10; step++) await slider.press('ArrowRight');
      await expect(slider).toHaveValue('15');
      await expect(slider).toHaveAttribute('aria-invalid', 'false');
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
      await slider.press('Escape');
      await page.getByRole('button', { name: '媒体参数', exact: true }).click();
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => fixture.submissions.length).toBe(1);
      expect(fixture.submissions[0]!.parameters).toEqual({
        resolution: '768p',
        aspectRatio: '16:9',
        duration: 15,
        prompt: 'Create a scene with soft light.',
      });
      expect(fixture.errors).toEqual([]);
    });

    for (const duration of [undefined, 2, 4]) {
      test(`历史${duration === undefined ? '缺省' : duration + ' 秒'}只显示参考起点，打开刷新提交不写成 10 或 5`, async ({
        page,
        baseURL,
      }, testInfo) => {
        const parameters = {
          resolution: '720p',
          aspectRatio: '16:9',
          ...(duration === undefined ? {} : { duration }),
        };
        const fixture = await installFixture(page, baseURL, {
          mediaType: 'video',
          modelAlias: 'wan3.0-video',
          parameters,
        });
        const label = duration === undefined ? '未设置' : `${duration} 秒`;
        const reference = duration === undefined ? '10' : '5';
        await openParameters(page);
        const { trigger, card, slider } = await openDuration(page);
        await expect(trigger).toHaveAccessibleName(`时长（秒）：${label}`);
        await expect(slider).toHaveValue(reference);
        await expect(slider).toHaveAttribute(
          'aria-valuetext',
          `${label}，滑块参考起点 ${reference} 秒`,
        );
        await expect(slider).toHaveAttribute('aria-invalid', 'false');
        await expect(slider).toHaveAccessibleDescription(
          duration === undefined ? /未设置.*拖动后才保存/ : /保留原值.*拖动后才修改/,
        );
        expect(fixture.canvas().nodes[0]!.data.parameters).toEqual(parameters);
        expect(fixture.patches).toHaveLength(0);
        expect(fixture.submissions).toHaveLength(0);
        await page.screenshot({
          path: testInfo.outputPath(`video-duration-historical-${duration ?? 'unset'}.png`),
          animations: 'disabled',
        });
        await slider.press('Escape');
        await expect(card).toBeHidden();
        await expect(trigger).toBeFocused();

        await page.reload();
        await selectNode(page);
        await openParameters(page);
        await openDuration(page);
        await expect(trigger).toHaveAccessibleName(`时长（秒）：${label}`);
        await expect(slider).toHaveValue(reference);
        expect(fixture.canvas().nodes[0]!.data.parameters).toEqual(parameters);
        expect(fixture.patches).toHaveLength(0);
        await slider.press('Escape');
        await page.getByRole('button', { name: '媒体参数', exact: true }).click();
        await page.getByRole('button', { name: '生成', exact: true }).click();
        await expect.poll(() => fixture.submissions.length).toBe(1);
        expect(fixture.submissions[0]!.parameters).toEqual({
          ...parameters,
          prompt: 'Create a scene with soft light.',
        });
        expect(fixture.errors).toEqual([]);
      });
    }

    test('历史 -1 刷新提交仍为自动，独立自动按钮与滑块可显式切换固定秒数', async ({
      page,
      baseURL,
    }) => {
      const parameters = { resolution: '720p', aspectRatio: '16:9', duration: -1 };
      const fixture = await installFixture(page, baseURL, {
        mediaType: 'video',
        modelAlias: 'wan3.0-video',
        parameters,
      });
      await openParameters(page);
      const { trigger, card, slider } = await openDuration(page);
      const automatic = card.getByRole('button', { name: '自动时长', exact: true });
      await expect(trigger).toHaveAccessibleName('时长（秒）：自动');
      await expect(slider).toHaveValue('10');
      await expect(slider).toHaveAttribute('aria-valuetext', '自动，滑块参考起点 10 秒');
      await expect(slider).toHaveAccessibleDescription(/当前为自动时长.*拖动后改用固定秒数/);
      await expect(automatic).toHaveAttribute('aria-pressed', 'true');
      expect(fixture.canvas().nodes[0]!.data.parameters).toEqual(parameters);
      expect(fixture.patches).toHaveLength(0);
      await page.reload();
      await selectNode(page);
      expect(fixture.patches).toHaveLength(0);
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => fixture.submissions.length).toBe(1);
      expect(fixture.submissions[0]!.parameters).toEqual({
        ...parameters,
        prompt: 'Create a scene with soft light.',
      });

      await openParameters(page);
      await openDuration(page);
      await slider.press('Home');
      await slider.press('ArrowRight');
      await expect(slider).toHaveValue('6');
      await expect(automatic).toHaveAttribute('aria-pressed', 'false');
      await expect(trigger).toHaveAccessibleName('时长（秒）：6 秒');
      await expect.poll(() => fixture.canvas().nodes[0]!.data.parameters?.duration).toBe(6);
      await automatic.click();
      await expect.poll(() => fixture.canvas().nodes[0]!.data.parameters?.duration).toBe(-1);
      await expect(trigger).toHaveAccessibleName('时长（秒）：自动');
      await openDuration(page);
      await expect(automatic).toHaveAttribute('aria-pressed', 'true');
      await slider.press('Home');
      await slider.press('ArrowRight');
      await expect.poll(() => fixture.canvas().nodes[0]!.data.parameters?.duration).toBe(6);
      await slider.press('Escape');
      await page.getByRole('button', { name: '媒体参数', exact: true }).click();
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => fixture.submissions.length).toBe(2);
      expect(fixture.submissions[1]!.parameters).toEqual({
        ...parameters,
        duration: 6,
        prompt: 'Create a scene with soft light.',
      });
      await page.reload();
      await selectNode(page);
      await openParameters(page);
      await openDuration(page);
      await expect(slider).toHaveValue('6');
      await expect(automatic).toHaveAttribute('aria-pressed', 'false');
      expect(fixture.errors).toEqual([]);
    });

    test('清除时长显式删除保存值，刷新与提交不得重新填入默认 10', async ({ page, baseURL }) => {
      const fixture = await installFixture(page, baseURL, {
        mediaType: 'video',
        modelAlias: 'wan3.0-video',
        parameters: { resolution: '720p', aspectRatio: '16:9', duration: 10 },
      });
      await openParameters(page);
      const { trigger, card, slider } = await openDuration(page);
      expect(fixture.patches).toHaveLength(0);
      await card.getByRole('button', { name: '清除时长', exact: true }).click();
      await expect(trigger).toHaveAccessibleName('时长（秒）：未设置');
      await expect
        .poll(() => fixture.canvas().nodes[0]!.data.parameters)
        .toEqual({
          resolution: '720p',
          aspectRatio: '16:9',
        });
      const savedPatches = fixture.patches.length;
      expect(savedPatches).toBeGreaterThan(0);
      await page.reload();
      await selectNode(page);
      await openParameters(page);
      await openDuration(page);
      await expect(slider).toHaveValue('10');
      await expect(slider).toHaveAttribute('aria-valuetext', '未设置，滑块参考起点 10 秒');
      await expect(card.getByRole('button', { name: '清除时长', exact: true })).toBeDisabled();
      expect(fixture.patches).toHaveLength(savedPatches);
      expect(fixture.canvas().nodes[0]!.data.parameters).not.toHaveProperty('duration');
      await slider.press('Escape');
      await page.getByRole('button', { name: '媒体参数', exact: true }).click();
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => fixture.submissions.length).toBe(1);
      expect(fixture.submissions[0]!.parameters).toEqual({
        resolution: '720p',
        aspectRatio: '16:9',
        prompt: 'Create a scene with soft light.',
      });
      expect(fixture.errors).toEqual([]);
    });

    for (const directory of [
      { id: 'supported', label: '目录支持 10', durations: [5, 10, 30], issue: undefined },
      {
        id: 'restricted',
        label: '目录仅支持 4/8/12',
        durations: [4, 8, 12],
        issue: '当前模型仅支持 4、8、12 秒',
      },
      {
        id: 'empty',
        label: '目录时长枚举为空',
        durations: [],
        issue: '当前模型未声明可用的视频时长',
      },
    ]) {
      for (const operation of ['新建', '明确切换模型'] as const) {
        test(`${operation}在${directory.label}时仍保存数字 10，刷新后遵守目录提交合同`, async ({
          page,
          baseURL,
        }, testInfo) => {
          const targetModel = `isolated-${directory.id}-video`;
          const capabilities = {
            resolutions: ['720p'],
            aspectRatios: ['16:9'],
            durations: directory.durations,
          };
          const fixture = await installFixture(page, baseURL, {
            mediaType: 'video',
            modelAlias: operation === '新建' ? targetModel : 'isolated-previous-video',
            parameters: operation === '新建' ? {} : { resolution: '720p', aspectRatio: '16:9' },
            emptyCanvas: operation === '新建',
            capabilities,
            additionalModels:
              operation === '新建'
                ? []
                : [
                    {
                      id: targetModel,
                      name: '切换时长验收模型',
                      capabilities,
                    },
                  ],
          });
          if (operation === '新建') {
            expect(fixture.canvas().nodes).toHaveLength(0);
            await page.getByRole('button', { name: '新建视频生成节点', exact: true }).click();
            await expect.poll(() => fixture.canvas().nodes.length).toBe(1);
          } else {
            expect(fixture.canvas().nodes[0]!.data.parameters).not.toHaveProperty('duration');
            expect(fixture.patches).toHaveLength(0);
            await choose(page, '模型', /^切换时长验收模型(?:\s|$)/);
          }
          await expect
            .poll(() => fixture.canvas().nodes[0]!.data.parameters)
            .toEqual({
              resolution: '720p',
              aspectRatio: '16:9',
              duration: 10,
            });
          await expect.poll(() => fixture.canvas().nodes[0]!.data.modelAlias).toBe(targetModel);
          await page
            .getByRole('textbox', { name: '提示词', exact: true })
            .fill('Create a scene with soft light.');
          await expect
            .poll(() => fixture.canvas().nodes[0]!.data.prompt)
            .toBe('Create a scene with soft light.');
          const savedNode = fixture.canvas().nodes[0]!;
          const savedPatches = fixture.patches.length;
          expect(savedPatches).toBeGreaterThan(0);
          expect(typeof savedNode.data.parameters!.duration).toBe('number');
          await openParameters(page);
          const { trigger, card, slider } = await openDuration(page);
          await expect(trigger).toHaveAccessibleName('时长（秒）：10 秒');
          await expect(slider).toHaveValue('10');
          await expect(slider).toHaveAttribute('aria-invalid', String(Boolean(directory.issue)));
          if (directory.issue) {
            await expect(card.getByRole('status').filter({ hasText: directory.issue })).toHaveText(
              directory.issue,
            );
            await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
          }
          expect(fixture.submissions).toHaveLength(0);

          await page.reload();
          await selectNode(page, savedNode.id);
          await openParameters(page);
          await openDuration(page);
          await expect(trigger).toHaveAccessibleName('时长（秒）：10 秒');
          await expect(slider).toHaveValue('10');
          await expect(slider).toHaveAttribute('aria-invalid', String(Boolean(directory.issue)));
          expect(fixture.canvas().nodes[0]!.data.parameters).toEqual(savedNode.data.parameters);
          expect(fixture.patches).toHaveLength(savedPatches);
          await page.screenshot({
            path: testInfo.outputPath(
              `video-duration-default-${operation === '新建' ? 'new' : 'switch'}-${directory.id}.png`,
            ),
            animations: 'disabled',
          });
          await slider.press('Escape');
          await page.getByRole('button', { name: '媒体参数', exact: true }).click();
          if (directory.issue) {
            await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
            expect(fixture.submissions).toHaveLength(0);
          } else {
            await expect(page.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
            await page.getByRole('button', { name: '生成', exact: true }).click();
            await expect.poll(() => fixture.submissions.length).toBe(1);
            expect(fixture.submissions[0]).toMatchObject({ modelAlias: targetModel, credentialId });
            expect(fixture.submissions[0]!.parameters).toEqual({
              resolution: '720p',
              aspectRatio: '16:9',
              duration: 10,
              prompt: 'Create a scene with soft light.',
            });
          }
          expect(fixture.errors).toEqual([]);
        });
      }
    }

    test('进入视频编辑仍强制自动与原视频比例，打开刷新不改 -1，退出编辑恢复 10', async ({
      page,
      baseURL,
    }, testInfo) => {
      const fixture = await installFixture(page, baseURL, {
        mediaType: 'video',
        modelAlias: 'seedance-2-0-official',
        parameters: { resolution: '720p', aspectRatio: '16:9', duration: 10 },
      });
      await choose(page, '生成模式', /^视频编辑(?:\s|$)/);
      await expect
        .poll(() => fixture.canvas().nodes[0]!.data)
        .toMatchObject({
          videoMode: 'video_edit',
          parameters: { duration: -1, aspectRatio: 'adaptive' },
        });
      const savedPatches = fixture.patches.length;
      await openParameters(page);
      const { trigger, card, slider } = await openDuration(page);
      await expect(trigger).toHaveAccessibleName('时长（秒）：自动');
      await expect(slider).toHaveValue('10');
      await expect(slider).toHaveAttribute('aria-valuetext', '自动，滑块参考起点 10 秒');
      await expect(card.getByRole('button', { name: '自动时长', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(fixture.patches).toHaveLength(savedPatches);
      await page.reload();
      await selectNode(page);
      await openParameters(page);
      await openDuration(page);
      await expect(trigger).toHaveAccessibleName('时长（秒）：自动');
      expect(fixture.canvas().nodes[0]!.data.parameters?.duration).toBe(-1);
      expect(fixture.patches).toHaveLength(savedPatches);
      expect(fixture.submissions).toHaveLength(0);
      await slider.press('Escape');
      await page.getByRole('button', { name: '媒体参数', exact: true }).click();
      await choose(page, '生成模式', /^文生视频(?:\s|$)/);
      await expect
        .poll(() => fixture.canvas().nodes[0]!.data)
        .toMatchObject({
          videoMode: 'text_to_video',
          parameters: { duration: 10 },
        });
      expect(fixture.canvas().nodes[0]!.data.parameters?.aspectRatio).not.toBe('adaptive');
      await openParameters(page);
      await openDuration(page);
      await expect(trigger).toHaveAccessibleName('时长（秒）：10 秒');
      await expect(card.getByRole('button', { name: '自动时长', exact: true })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await page.screenshot({
        path: testInfo.outputPath('video-duration-exit-edit-auto.png'),
        animations: 'disabled',
      });
      await slider.press('Escape');
      await page.getByRole('button', { name: '媒体参数', exact: true }).click();
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect.poll(() => fixture.submissions.length).toBe(1);
      expect(fixture.submissions[0]).toMatchObject({
        modelAlias: 'seedance-2-0-official',
        credentialId,
        parameters: { duration: 10 },
      });
      expect(fixture.errors).toEqual([]);
    });

    test('小写 minimax-h3 清除必填时长后标记无效，刷新仍禁止生成且零提交', async ({
      page,
      baseURL,
    }, testInfo) => {
      const fixture = await installFixture(page, baseURL, {
        mediaType: 'video',
        modelAlias: 'minimax-h3',
        parameters: { resolution: '768p', aspectRatio: '16:9', duration: 10 },
      });
      const issue = 'Moon MiniMax H3 必须选择 4 至 15 秒的视频时长';
      await openParameters(page);
      const { trigger, card, slider } = await openDuration(page);
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
      expect(fixture.patches).toHaveLength(0);
      await card.getByRole('button', { name: '清除时长', exact: true }).click();
      await expect
        .poll(() => fixture.canvas().nodes[0]!.data.parameters)
        .toEqual({
          resolution: '768p',
          aspectRatio: '16:9',
        });
      const savedPatches = fixture.patches.length;
      expect(savedPatches).toBeGreaterThan(0);
      await openDuration(page);
      await expect(trigger).toHaveAccessibleName('时长（秒）：未设置');
      await expect(slider).toHaveValue('10');
      await expect(slider).toHaveAttribute('aria-invalid', 'true');
      await expect(card.getByRole('status').filter({ hasText: issue })).toHaveText(issue);
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
      expect(fixture.submissions).toHaveLength(0);

      await page.reload();
      await selectNode(page);
      await openParameters(page);
      await openDuration(page);
      await expect(trigger).toHaveAccessibleName('时长（秒）：未设置');
      await expect(slider).toHaveAttribute('aria-invalid', 'true');
      await expect(slider).toHaveAccessibleDescription(new RegExp(issue));
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
      expect(fixture.canvas().nodes[0]!.data.parameters).not.toHaveProperty('duration');
      expect(fixture.patches).toHaveLength(savedPatches);
      expect(fixture.submissions).toHaveLength(0);
      await page.screenshot({
        path: testInfo.outputPath('video-duration-minimax-required-cleared.png'),
        animations: 'disabled',
      });
      expect(fixture.errors).toEqual([]);
    });

    for (const legacy of [
      { label: '历史 4 秒', duration: 4, action: 'Home', seconds: 5 },
      { label: '自动 -1', duration: -1, action: '点击', seconds: 10 },
      { label: '历史未设置', duration: undefined, action: '点击', seconds: 10 },
    ]) {
      test(`${legacy.label}的同值参考点通过${legacy.action}显式保存 ${legacy.seconds} 秒`, async ({
        page,
        baseURL,
      }) => {
        const fixture = await installFixture(page, baseURL, {
          mediaType: 'video',
          modelAlias: 'wan3.0-video',
          parameters: {
            resolution: '720p',
            aspectRatio: '16:9',
            ...(legacy.duration === undefined ? {} : { duration: legacy.duration }),
          },
        });
        await openParameters(page);
        const { trigger, slider } = await openDuration(page);
        await expect(slider).toHaveValue(String(legacy.seconds));
        await expect(slider).toHaveAttribute('aria-valuetext', /滑块参考起点/);
        expect(fixture.patches).toHaveLength(0);
        if (legacy.action === 'Home') {
          await slider.press('Home');
        } else {
          const bounds = await slider.boundingBox();
          if (!bounds) throw new Error('视频时长参考点没有可点击的屏幕区域');
          await slider.click({
            position: {
              x: 10 + ((legacy.seconds - 5) / 25) * (bounds.width - 20),
              y: bounds.height / 2,
            },
          });
        }
        await expect(slider).toHaveValue(String(legacy.seconds));
        await expect(trigger).toHaveAccessibleName(`时长（秒）：${legacy.seconds} 秒`);
        await expect(slider).toHaveAttribute('aria-valuetext', `${legacy.seconds} 秒`);
        await expect
          .poll(() => fixture.canvas().nodes[0]!.data.parameters?.duration)
          .toBe(legacy.seconds);
        const savedPatches = fixture.patches.length;
        expect(savedPatches).toBeGreaterThan(0);
        await page.reload();
        await selectNode(page);
        await openParameters(page);
        await openDuration(page);
        await expect(trigger).toHaveAccessibleName(`时长（秒）：${legacy.seconds} 秒`);
        await expect(slider).toHaveValue(String(legacy.seconds));
        expect(fixture.patches).toHaveLength(savedPatches);
        await slider.press('Escape');
        await page.getByRole('button', { name: '媒体参数', exact: true }).click();
        await page.getByRole('button', { name: '生成', exact: true }).click();
        await expect.poll(() => fixture.submissions.length).toBe(1);
        expect(fixture.submissions[0]!.parameters).toEqual({
          resolution: '720p',
          aspectRatio: '16:9',
          duration: legacy.seconds,
          prompt: 'Create a scene with soft light.',
        });
        expect(fixture.errors).toEqual([]);
      });
    }

    test('视频清晰度、比例和整数秒数保持各自字段，不混入图片质量', async ({ page, baseURL }) => {
      const fixture = await installFixture(page, baseURL, {
        mediaType: 'video',
        modelAlias: 'wan3.0-video',
        parameters: { resolution: '720p', aspectRatio: '16:9', duration: 5 },
      });
      await openParameters(page);
      await choose(page, '视频清晰度', /1080P/);
      await choose(page, '视频比例', /9:16/);
      const { slider, trigger } = await openDuration(page);
      await slider.press('Home');
      for (let step = 0; step < 5; step++) await slider.press('ArrowRight');
      await expect(slider).toHaveValue('10');
      await expect(trigger).toHaveAccessibleName('时长（秒）：10 秒');
      await expect.poll(() => fixture.canvas().nodes[0]!.data.parameters?.duration).toBe(10);
      await slider.press('Escape');
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
