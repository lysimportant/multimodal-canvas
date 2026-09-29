/** 桌面连线回归的专属内存后端；不连接数据库、真实项目、供应商或用户会话。 */
import { expect, test as base, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  canvasDocumentSchema,
  runRecordSchema,
  type Asset,
  type CanvasDocument,
  type PromptDocument,
  type RunRecord,
} from '@multimodal-canvas/domain';

/** 项目、节点与资产全部使用本规格独占的合成 ID。 */
export const connectedIds = {
  project: 'connected-node-regression-project',
  source: 'connected-image-node-six',
  target: 'connected-video-target',
  asset: 'connected-generated-image-six',
  history: 'connected-successful-image-history',
  submission: 'connected-captured-video-submission',
  outputAsset: 'connected-synthetic-video-output',
} as const;
/** 两处中文别名是本用例的输入数据，不得翻译或预先转换为 mention。 */
export const connectedPrompt = '良站在窗边，镜头缓缓靠近良。';
/** 节点原名与资源文件名、目标节点内的别名相互独立。 */
export const connectedLabels = { source: '图片生成节点 6', target: '视频生成节点' } as const;
/** 固定时间只用于历史记录；登录会话的过期时间另按执行时间计算。 */
const timestamp = '2026-09-29T00:00:00.000Z';
/** 仓库内的图片 bytes；包括访问授权返回的 URL 也必须再次被路由拦截。 */
const imageBytes = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
/** 成功的模拟提交回显仓库视频，避免缺失产物占位错误污染验收截图。 */
const videoBytes = readFileSync(new URL('../public/demo/field-study.mp4', import.meta.url));
/** 只有项目元数据，没有任何真实用户标识。 */
const project = {
  id: connectedIds.project,
  name: '桌面连线隔离回归',
  createdAt: timestamp,
  updatedAt: timestamp,
};
/** 保存发送前的原始正文与当时的持久画布，不模拟服务端补全或冻结逻辑。 */
export type ConnectedSubmission = {
  body: {
    projectId?: string;
    modelAlias?: string;
    parameters?: Record<string, unknown>;
    promptDocument?: PromptDocument;
  };
  canvas: CanvasDocument;
};
/** 两种旧数据入口共用同一真实领域结构；无连线模式只用于端口切换。 */
type ConnectedOptions = { legacyAlias: boolean; connectedEdge: boolean };

/**
 * 源节点没有 assetId、contentUrl 或 resultAsset，只能从成功历史 run 恢复图片。
 * 旧项目保留缺版本的 resourceRefs 和纯 text 文档，禁止 fixture 自己修复数据。
 * @returns 可独立保存和刷新的内存画布。
 */
function initialCanvas({ legacyAlias, connectedEdge }: ConnectedOptions): CanvasDocument {
  return canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: connectedIds.source,
        type: 'image',
        position: { x: 160, y: 190 },
        width: 280,
        height: 190,
        data: {
          label: connectedLabels.source,
          mediaType: 'image',
          mimeType: 'application/octet-stream',
          mode: 'generate',
          enabled: true,
          stale: false,
          prompt: 'A character standing beside a window.',
          modelAlias: 'synthetic-connected-image',
          credentialId: 'synthetic-connected-credential',
        },
      },
      {
        id: connectedIds.target,
        type: 'video',
        position: { x: 600, y: 190 },
        width: 320,
        height: 180,
        data: {
          label: connectedLabels.target,
          mediaType: 'video',
          mode: 'generate',
          enabled: true,
          videoMode: 'omni_reference',
          modelAlias: 'minimax-h3',
          credentialId: 'synthetic-connected-credential',
          prompt: connectedPrompt,
          parameters: { resolution: '768p', aspectRatio: '16:9', duration: 5 },
          ...(legacyAlias
            ? {
                promptDocument: { version: 1, blocks: [{ type: 'text', text: connectedPrompt }] },
                resourceRefs: [
                  {
                    id: `connected:${connectedIds.asset}`,
                    assetId: connectedIds.asset,
                    mediaType: 'image',
                    name: '良',
                  },
                ],
              }
            : {}),
        },
      },
    ],
    edges: connectedEdge
      ? [
          {
            id: 'connected-six-to-video-reference',
            sourceNodeId: connectedIds.source,
            sourceHandle: 'output:image',
            targetNodeId: connectedIds.target,
            targetHandle: 'input:referenceImage',
            order: 0,
          },
        ]
      : [],
  });
}

/** 返回 schema 校验后的历史成功 run；v2 与资源目录的最新 v9 故意不同。 */
function imageHistory(canvas: CanvasDocument): RunRecord {
  return runRecordSchema.parse({
    id: connectedIds.history,
    projectId: project.id,
    targetNodeId: connectedIds.source,
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    provider: 'mock',
    modelAlias: 'synthetic-connected-image',
    createdAt: timestamp,
    updatedAt: timestamp,
    snapshot: {
      projectId: project.id,
      targetNodeId: connectedIds.source,
      canvasRevision: canvas.revision,
      modelAlias: 'synthetic-connected-image',
      parameters: {},
      submittedAt: timestamp,
      nodes: [structuredClone(canvas.nodes[0])],
      edges: [],
      inputs: [],
    },
    result: {
      provider: 'mock',
      summary: '仅用于浏览器回归的历史图片',
      simulated: true,
      targetNodeId: connectedIds.source,
      mediaType: 'image',
      inputCount: 0,
      asset: {
        assetId: connectedIds.asset,
        version: 2,
        contentUrl: `/v1/assets/${connectedIds.asset}/versions/2/content`,
        mimeType: 'image/jpeg',
        sizeBytes: imageBytes.byteLength,
      },
    },
  });
}

/**
 * 安装有效 Cookie 会话合同和全网络白名单；不启动任何服务。
 * @param baseURL 仅接受 localhost、127.0.0.1 或 IPv6 回环的页面地址。
 * @returns 内存画布、原始请求和诊断；只有显式授权的一次目标提交会被 Mock 接收。
 * @throws 缺少本机地址、非法画布或未声明请求时使测试失败。
 */
async function installConnectedFixture(
  page: Page,
  baseURL: string | undefined,
  options: ConnectedOptions,
) {
  if (!baseURL) throw new Error('请显式设置本机 WEB_BASE_URL，禁止本规格启动服务');
  const webURL = new URL(baseURL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(webURL.hostname))
    throw new Error('连线隔离回归只接受本机 WEB_BASE_URL');
  const initial = initialCanvas(options);
  let canvas = structuredClone(initial);
  const history = imageHistory(initial);
  const asset: Asset = {
    id: connectedIds.asset,
    name: 'generated',
    mediaType: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: imageBytes.byteLength,
    status: 'ready',
    latestVersion: 9,
    contentUrl: `/v1/assets/${connectedIds.asset}/versions/9/content`,
    tags: [],
  };
  const videoAsset: Asset = {
    id: connectedIds.outputAsset,
    name: 'synthetic-video-output',
    mediaType: 'video',
    mimeType: 'video/mp4',
    sizeBytes: videoBytes.byteLength,
    status: 'ready',
    latestVersion: 1,
    contentUrl: '/v1/assets/' + connectedIds.outputAsset + '/versions/1/content',
    tags: [],
  };
  const errors: string[] = [];
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const staticRequests: string[] = [];
  const writes: CanvasDocument[] = [];
  const submissions: ConnectedSubmission[] = [];
  const observations: Record<string, unknown> = {};
  let canvasReads = 0;
  let allowSubmission = false;
  let submittedRun: RunRecord | undefined;
  const user = {
    id: 'connected-browser-user',
    email: 'connected-browser@example.test',
    role: 'user',
    createdAt: timestamp,
  };
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.context().addCookies([
    {
      name: 'canvas_session',
      value: 'synthetic-connected-session',
      url: webURL.origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.addInitScript((user) => {
    localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user }));
  }, user);

  // Vite HMR 只在浏览器内回应 connected；从不调用 connectToServer。
  await page.context().routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    if (url.host === webURL.host && url.pathname === '/') {
      socket.send(JSON.stringify({ type: 'connected' }));
      return;
    }
    errors.push(`已阻断未声明 WebSocket：${url.origin}${url.pathname}`);
    socket.close({ code: 1008, reason: 'Undeclared test connection' });
  });

  /** 同时支持页面同源及本地开发 API 的跨源 Mock，不回传真实认证信息。 */
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': webURL.origin,
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify(body),
    });
  /** 未声明请求一律 abort，后置断言会连同浏览器错误和请求证据报告失败。 */
  const block = async (route: Route, reason: string) => {
    errors.push(reason);
    await route.abort('blockedbyclient');
  };
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith('/v1/')) {
      const staticModule =
        ['script', 'stylesheet', 'font'].includes(request.resourceType()) &&
        /^\/(?:assets\/|src\/|node_modules\/|@vite\/|@id\/|@fs\/|@react-refresh$)/.test(path);
      if (
        url.origin === webURL.origin &&
        method === 'GET' &&
        ((request.resourceType() === 'document' && path === `/projects/${project.id}`) ||
          staticModule)
      ) {
        staticRequests.push(path);
        return route.continue();
      }
      if (url.origin === webURL.origin && method === 'GET' && path === '/favicon.ico')
        return route.fulfill({ status: 204, body: '' });
      return block(route, `已阻断未声明网络请求：${method} ${url.origin}${path}`);
    }
    let body: unknown;
    if (request.postData()) {
      try {
        body = request.postDataJSON();
      } catch {
        return block(route, `已阻断非 JSON API 请求：${method} ${path}`);
      }
    }
    requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
    if (url.searchParams.has('projectId') && url.searchParams.get('projectId') !== project.id)
      return block(route, `禁止访问非合成项目：${method} ${path}`);
    if (method === 'GET' && path === '/v1/auth/me')
      return json(route, { user, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    if (method === 'GET' && path === '/v1/projects') return json(route, { projects: [project] });
    if (method === 'GET' && path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path === `/v1/projects/${project.id}/canvas`) {
      if (method === 'GET') {
        canvasReads += 1;
        return json(route, { canvas });
      }
      if (method === 'PATCH') {
        const parsed = canvasDocumentSchema.safeParse(body);
        if (!parsed.success) return block(route, `非法画布 PATCH：${parsed.error.message}`);
        if (
          JSON.stringify(parsed.data.nodes.map((node) => node.id).sort()) !==
          JSON.stringify(initial.nodes.map((node) => node.id).sort())
        )
          return block(route, '本规格不允许创建或删除节点');
        writes.push(structuredClone(parsed.data));
        canvas = { ...parsed.data, revision: canvas.revision + 1 };
        return json(route, { canvas });
      }
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/events`)
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 3600000\n: isolated\n\n',
      });
    if (method === 'GET' && path === `/v1/projects/${project.id}/runs`)
      return json(route, { runs: submittedRun ? [history, submittedRun] : [history] });
    if (method === 'GET' && path === `/v1/runs/${history.id}`) return json(route, { run: history });
    if (method === 'GET' && path === `/v1/projects/${project.id}/models/defaults`)
      return json(route, { defaults: {}, resolvedDefaults: {} });
    if (method === 'GET' && path === '/v1/settings/ai')
      return json(route, { settings: { defaultModels: {}, timeoutMs: 900_000 } });
    if (method === 'GET' && path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (method === 'GET' && path === '/v1/assets')
      return json(route, { assets: submittedRun ? [asset, videoAsset] : [asset] });
    if (method === 'GET' && path === '/v1/models')
      return json(route, {
        models: [
          {
            id: 'minimax-h3',
            name: '隔离 Minimax H3',
            mediaTypes: ['video'],
            credentialId: 'synthetic-connected-credential',
            available: true,
            group: 'synthetic',
            capabilities: {
              mentionMediaTypes: ['image'],
              video: {
                resolutions: ['768p', '1080p'],
                aspectRatios: ['16:9', '9:16', '1:1'],
              },
            },
          },
          {
            id: 'synthetic-connected-image',
            name: '仅历史展示的合成图片模型',
            mediaTypes: ['image'],
            credentialId: 'synthetic-connected-credential',
            available: true,
            group: 'synthetic',
          },
        ],
      });
    if (method === 'POST' && path === `/v1/assets/${asset.id}/access-url`) {
      const version = (body as { version?: number } | undefined)?.version ?? asset.latestVersion;
      if (![2, 9, 10].includes(version!)) return block(route, `未声明的图片版本：${version}`);
      return json(route, { url: `/v1/assets/${asset.id}/versions/${version}/content` });
    }
    if (
      method === 'GET' &&
      [2, 9, 10].some((version) => path === `/v1/assets/${asset.id}/versions/${version}/content`)
    )
      return route.fulfill({ contentType: 'image/jpeg', body: imageBytes });
    if (
      submittedRun &&
      method === 'POST' &&
      path === '/v1/assets/' + videoAsset.id + '/access-url'
    ) {
      const version = (body as { version?: number } | undefined)?.version ?? 1;
      if (version !== 1) return block(route, '未声明的模拟视频版本：' + version);
      return json(route, { url: videoAsset.contentUrl });
    }
    if (submittedRun && method === 'GET' && path === videoAsset.contentUrl)
      return route.fulfill({ contentType: 'video/mp4', body: videoBytes });
    if (
      method === 'POST' &&
      path === `/v1/nodes/${connectedIds.target}/runs` &&
      allowSubmission &&
      submissions.length === 0
    ) {
      allowSubmission = false;
      const submission = {
        body: body as ConnectedSubmission['body'],
        canvas: structuredClone(canvas),
      };
      if (submission.body.projectId !== project.id) return block(route, '模拟提交缺少合成项目 ID');
      submissions.push(submission);
      submittedRun = runRecordSchema.parse({
        id: connectedIds.submission,
        projectId: project.id,
        targetNodeId: connectedIds.target,
        status: 'succeeded',
        progress: 100,
        attempt: 1,
        provider: 'mock',
        modelAlias: 'minimax-h3',
        createdAt: '2026-09-29T00:01:00.000Z',
        updatedAt: '2026-09-29T00:01:00.000Z',
        snapshot: {
          projectId: project.id,
          targetNodeId: connectedIds.target,
          canvasRevision: canvas.revision,
          modelAlias: 'minimax-h3',
          parameters: submission.body.parameters ?? {},
          submittedAt: timestamp,
          nodes: structuredClone(canvas.nodes),
          edges: structuredClone(canvas.edges),
          inputs: [],
        },
        result: {
          provider: 'mock',
          summary: '仅捕获提交，未执行任何生成',
          simulated: true,
          targetNodeId: connectedIds.target,
          mediaType: 'video',
          inputCount: canvas.edges.length,
          asset: {
            assetId: videoAsset.id,
            version: 1,
            contentUrl: videoAsset.contentUrl,
            mimeType: videoAsset.mimeType,
            sizeBytes: videoAsset.sizeBytes,
          },
        },
      });
      return json(route, { run: submittedRun }, 202);
    }
    if (method === 'GET' && path === `/v1/runs/${connectedIds.submission}` && submittedRun)
      return json(route, { run: submittedRun });
    return block(route, `已阻断未声明 API：${method} ${path}`);
  });
  return {
    initial,
    errors,
    consoleMessages,
    requests,
    staticRequests,
    writes,
    submissions,
    observations,
    canvas: () => structuredClone(canvas),
    canvasReads: () => canvasReads,
    /** 只授权当前用例的一次目标 POST；上游生成、新节点及重试始终不在白名单中。 */
    armSubmission() {
      if (submissions.length) throw new Error('不能重复授权模拟生成');
      allowSubmission = true;
    },
    /** 目录升级不能移动正文引用或历史 run 的 v2。 */
    advanceCatalog() {
      asset.latestVersion = 10;
      asset.contentUrl = `/v1/assets/${asset.id}/versions/10/content`;
    },
  };
}

/** 专属场景状态；不向其它规格暴露真实应用状态或网络通道。 */
export type ConnectedScenario = Awaited<ReturnType<typeof installConnectedFixture>>;
/** 每例独立安装路由并落盘截图、浏览器日志和 Mock 请求，失败也保留证据。 */
export const test = base.extend<ConnectedOptions & { scenario: ConnectedScenario }>({
  legacyAlias: [false, { option: true }],
  connectedEdge: [true, { option: true }],
  scenario: [
    async ({ page, baseURL, legacyAlias, connectedEdge }, use, testInfo) => {
      const scenario = await installConnectedFixture(page, baseURL, { legacyAlias, connectedEdge });
      try {
        await use(scenario);
      } finally {
        await mkdir(testInfo.outputDir, { recursive: true });
        const diagnosticsPath = testInfo.outputPath('network-and-console.json');
        await writeFile(
          diagnosticsPath,
          JSON.stringify(
            {
              baseURL,
              title: testInfo.title,
              titlePath: testInfo.titlePath,
              viewport: page.viewportSize(),
              status: testInfo.status,
              initial: scenario.initial,
              canvas: scenario.canvas(),
              requests: scenario.requests,
              staticRequests: scenario.staticRequests,
              writes: scenario.writes,
              submissions: scenario.submissions,
              observations: scenario.observations,
              console: scenario.consoleMessages,
              errors: scenario.errors,
            },
            null,
            2,
          ),
          'utf8',
        );
        await testInfo.attach('isolated-network-and-console', {
          path: diagnosticsPath,
          contentType: 'application/json',
        });
        if (!page.isClosed()) {
          const screenshot = testInfo.outputPath('connected-node-final.png');
          await page.screenshot({ path: screenshot, fullPage: true });
          await testInfo.attach('connected-node-final', {
            path: screenshot,
            contentType: 'image/png',
          });
        }
        expect(
          scenario.errors,
          'console/pageerror、未知请求、真实 API 及重复提交必须全部为零',
        ).toEqual([]);
      }
    },
    { auto: true },
  ],
});
