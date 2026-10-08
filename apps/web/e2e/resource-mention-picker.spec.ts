import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  canvasDocumentSchema,
  PROMPT_SKILLS,
  type Asset,
  type CanvasDocument,
  type PromptDocument,
} from '@multimodal-canvas/domain';

/** 本规格只使用本地媒体和浏览器路由 Mock，不调用真实后端或付费 Provider。 */
const project = {
  id: 'resource-mention-picker-browser',
  name: '资源引用选择器验收',
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
};
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
const video = readFileSync(new URL('../public/demo/field-study.mp4', import.meta.url));

test.use({ serviceWorkers: 'block' });

/** 构造完整资源索引项，确保浏览器验收覆盖真实领域字段。 */
function asset(
  id: string,
  name: string,
  mediaType: Asset['mediaType'],
  options: { tags?: string[]; metadata?: Record<string, unknown> } = {},
): Asset {
  const mimeType =
    mediaType === 'image'
      ? 'image/jpeg'
      : mediaType === 'video'
        ? 'video/mp4'
        : mediaType === 'audio'
          ? 'audio/mpeg'
          : 'text/plain';
  return {
    id,
    name,
    mediaType,
    mimeType,
    sizeBytes: mediaType === 'video' ? video.byteLength : poster.byteLength,
    status: 'ready',
    latestVersion: 1,
    contentUrl: `/v1/assets/${id}/versions/1/content`,
    tags: options.tags ?? [],
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

/** 提供足量四类资源，验证右侧结果列表独立滚动。 */
const assets: Asset[] = [
  asset('product-image', '产品图', 'image', { tags: ['电商', '主视觉'] }),
  ...Array.from({ length: 8 }, (_, index) =>
    asset(`scene-image-${index + 1}`, `场景参考图 ${index + 1}`, 'image', {
      tags: ['场景', `序号-${index + 1}`],
    }),
  ),
  asset('product-video', '产品视频', 'video', { tags: ['成片', '横版'] }),
  ...Array.from({ length: 5 }, (_, index) =>
    asset(`motion-video-${index + 1}`, `动作视频 ${index + 1}`, 'video', {
      tags: ['动作', `序号-${index + 1}`],
    }),
  ),
  asset('voice-sample', '声音样本', 'audio', { tags: ['旁白', '普通话'] }),
  ...Array.from({ length: 5 }, (_, index) =>
    asset(`music-audio-${index + 1}`, `配乐素材 ${index + 1}`, 'audio', {
      tags: ['音乐', `序号-${index + 1}`],
    }),
  ),
  asset('interview-script', '采访脚本', 'text', {
    tags: ['采访', '文案'],
    metadata: { alias: '资料文档' },
  }),
  asset('brief-document', '资料文档', 'text', { tags: ['需求', '说明'] }),
  ...Array.from({ length: 4 }, (_, index) =>
    asset(`note-text-${index + 1}`, `文本笔记 ${index + 1}`, 'text', {
      tags: ['笔记', `序号-${index + 1}`],
    }),
  ),
];

/** 初始提示词含同一资源的两处结构化引用，用于删除与撤销回归。 */
function initialCanvas(): CanvasDocument {
  return canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: 'resource-mention-node',
        type: 'image',
        position: { x: 390, y: 210 },
        width: 320,
        height: 240,
        data: {
          label: '资源引用节点',
          mediaType: 'image',
          mode: 'generate',
          enabled: true,
          modelAlias: 'mock-image',
          promptDocument: {
            version: 1,
            blocks: [
              { type: 'text', text: '开场 ' },
              {
                type: 'mention',
                mentionId: 'product-reference-first',
                assetId: 'product-image',
                assetVersion: 1,
                label: '产品图',
                mediaType: 'image',
              },
              { type: 'text', text: ' 转场 ' },
              {
                type: 'mention',
                mentionId: 'product-reference-second',
                assetId: 'product-image',
                assetVersion: 1,
                label: '产品图',
                mediaType: 'image',
              },
              { type: 'text', text: ' 收尾' },
            ],
          },
        },
      },
    ],
    edges: [],
  });
}

/** 为解绑回归构造一个目标节点和两条同类型来源，第二条用于验证其它引用不受影响。 */
function resourceRemovalAssets(mediaType: Asset['mediaType']): [Asset, Asset] {
  const sourceAssets: Record<Asset['mediaType'], [Asset, Asset]> = {
    text: [
      assets.find((item) => item.id === 'interview-script')!,
      assets.find((item) => item.id === 'brief-document')!,
    ],
    image: [
      assets.find((item) => item.id === 'product-image')!,
      assets.find((item) => item.id === 'scene-image-1')!,
    ],
    audio: [
      assets.find((item) => item.id === 'voice-sample')!,
      assets.find((item) => item.id === 'music-audio-1')!,
    ],
    video: [
      assets.find((item) => item.id === 'product-video')!,
      assets.find((item) => item.id === 'motion-video-1')!,
    ],
  };
  return sourceAssets[mediaType];
}

/** 为解绑回归构造一个目标节点和两条同类型来源，第二条用于验证其它引用不受影响。 */
function resourceRemovalCanvas(mediaType: Asset['mediaType']): CanvasDocument {
  const [primary, retained] = resourceRemovalAssets(mediaType);
  const targetId = `resource-removal-target-${mediaType}`;
  const sourceIds = [
    `resource-removal-primary-${mediaType}`,
    `resource-removal-retained-${mediaType}`,
  ];
  const target = {
    id: targetId,
    type: mediaType,
    position: { x: 560, y: 220 },
    width: 340,
    height: 240,
    data: {
      label: `${mediaType} 引用删除目标`,
      mediaType,
      mode: 'generate' as const,
      enabled: true,
      modelAlias: `mock-${mediaType}`,
      promptDocument: {
        version: 1 as const,
        blocks: [
          { type: 'text' as const, text: `保留开头-${mediaType} ` },
          {
            type: 'mention' as const,
            mentionId: `resource-removal-primary-mention-${mediaType}`,
            assetId: primary.id,
            assetVersion: 1,
            label: primary.name,
            mediaType: primary.mediaType,
          },
          { type: 'text' as const, text: ' 中间文字 ' },
          {
            type: 'mention' as const,
            mentionId: `resource-removal-retained-mention-${mediaType}`,
            assetId: retained.id,
            assetVersion: 1,
            label: retained.name,
            mediaType: retained.mediaType,
          },
          { type: 'text' as const, text: ` 保留结尾-${mediaType}` },
        ],
      },
      resourceRefs: [
        {
          id: `connected:source:${sourceIds[0]}:${primary.id}`,
          assetId: primary.id,
          assetVersion: 1,
          mediaType: primary.mediaType,
          name: primary.name,
        },
        {
          id: `connected:source:${sourceIds[1]}:${retained.id}`,
          assetId: retained.id,
          assetVersion: 1,
          mediaType: retained.mediaType,
          name: retained.name,
        },
      ],
    },
  } satisfies CanvasDocument['nodes'][number];
  const sourceNodes = [primary, retained].map(
    (entry, index) =>
      ({
        id: sourceIds[index]!,
        type: entry.mediaType,
        position: { x: 120 + index * 330, y: 520 },
        width: 260,
        height: 190,
        data: {
          label: entry.name,
          mediaType: entry.mediaType,
          mode: 'source' as const,
          enabled: true,
          assetId: entry.id,
          contentUrl: entry.contentUrl,
          mimeType: entry.mimeType,
        },
      }) satisfies CanvasDocument['nodes'][number],
  );
  return canvasDocumentSchema.parse({
    revision: 1,
    nodes: [target, ...sourceNodes],
    edges: sourceNodes.map((source, index) => ({
      id: `resource-removal-edge-${mediaType}-${index}`,
      sourceNodeId: source.id,
      sourceHandle: `output:${mediaType}`,
      targetNodeId: targetId,
      targetHandle: 'input:content',
      order: index,
    })),
  });
}

/** 以 JSON 返回浏览器 Mock，避免测试命中任何真实 API。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 上传三阶段审计；记录原始图片字节以校验长度、摘要和真实解码结果。 */
type ReferenceUpload = {
  uploadId: string;
  metadata: { name: string; mimeType: string; sizeBytes: number; sha256: string };
  stages: string[];
  bytes?: Buffer;
  asset?: Asset;
};

/** 合成相机的请求约束和轨道释放记录，不读取用户设备。 */
type ReferenceCameraAudit = {
  requests: MediaStreamConstraints[];
  tracks: { kind: string; stops: number; readyState: MediaStreamTrackState }[];
};

/** 安装离线 Mock 并记录浏览器异常；Cookie 会话有效期由 /v1/auth/me 返回。 */
async function installFixture(
  page: Page,
  baseURL: string | undefined,
  initial = initialCanvas(),
  projectCatalog?: Asset[],
) {
  const catalog = structuredClone(projectCatalog ?? assets);
  const uploads: ReferenceUpload[] = [];
  const assetAccesses: { assetId: string; version: number }[] = [];
  const assetQueries: Record<string, string>[] = [];
  if (!baseURL) throw new Error('请通过 WEB_BASE_URL 指定隔离浏览器验收地址');
  const webOrigin = new URL(baseURL).origin;
  if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) {
    throw new Error('浏览器验收只能连接本机隔离 Vite');
  }
  let canvas = structuredClone(initial);
  const apiRequests: Array<{ method: string; path: string }> = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    const audit: ReferenceCameraAudit = { requests: [], tracks: [] };
    Object.assign(window, { __referenceCameraAudit: audit });
    // 不保留原始 getUserMedia，任何相机请求都只能得到本页绘制的合成画面。
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        audit.requests.push(structuredClone(constraints));
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('合成相机缺少 Canvas 2D 上下文');
        let frame = 0;
        const paint = () => {
          context.fillStyle = '#e0f2fe';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#0369a1';
          context.fillRect(90 + (frame++ % 30), 80, 400, 260);
          context.fillStyle = '#ffffff';
          context.font = '28px sans-serif';
          context.fillText('SYNTHETIC CAMERA', 145, 220);
          context.fillStyle = '#fb923c';
          context.fillRect(30, 400, 580, 24);
        };
        paint();
        const stream = canvas.captureStream(12);
        const timer = window.setInterval(paint, 80);
        for (const track of stream.getTracks()) {
          const record = { kind: track.kind, stops: 0, readyState: track.readyState };
          audit.tracks.push(record);
          const stop = track.stop.bind(track);
          track.stop = () => {
            record.stops += 1;
            stop();
            record.readyState = track.readyState;
            if (stream.getTracks().every((item) => item.readyState === 'ended')) {
              window.clearInterval(timer);
            }
          };
        }
        return stream;
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: () => Promise.reject(new Error('隔离验收禁止访问真实屏幕或设备')),
    });
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        user: {
          id: 'resource-mention-user',
          email: 'resource-mention@example.test',
          role: 'user',
          createdAt: '2026-09-23T00:00:00.000Z',
        },
      }),
    );
  });
  await page.context().routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    if (url.protocol === 'ws:' && url.origin.replace(/^ws:/, 'http:') === webOrigin) {
      socket.connectToServer();
    } else {
      errors.push('已阻断未声明的 WebSocket：' + url.origin + url.pathname);
      socket.close();
    }
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
      errors.push('已阻断未声明的网络请求：' + method + ' ' + url.origin + path);
      return route.abort('blockedbyclient');
    }
    if (![webOrigin, 'http://localhost:3000'].includes(url.origin)) {
      errors.push('已阻断非 Mock 来源的 API：' + method + ' ' + url.origin + path);
      return route.abort('blockedbyclient');
    }
    apiRequests.push({ method, path });
    if (method === 'POST' && path === '/v1/assets/uploads/init') {
      const metadata = request.postDataJSON() as ReferenceUpload['metadata'];
      if (
        typeof metadata.name !== 'string' ||
        !['image/jpeg', 'image/png'].includes(metadata.mimeType) ||
        !Number.isInteger(metadata.sizeBytes) ||
        metadata.sizeBytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256)
      ) {
        errors.push('上传初始化没有提供有效图片元数据');
        return json(route, { error: '无效上传元数据' }, 400);
      }
      const uploadId = 'reference-upload-' + (uploads.length + 1);
      uploads.push({ uploadId, metadata, stages: ['init'] });
      return json(route, {
        uploadId,
        uploadUrl: '/v1/assets/uploads/' + uploadId + '/bytes',
        completeUrl: '/v1/assets/uploads/complete',
      });
    }
    const uploadBytesMatch = path.match(new RegExp('^/v1/assets/uploads/([^/]+)/bytes$'));
    if (method === 'PUT' && uploadBytesMatch) {
      const upload = uploads.find((item) => item.uploadId === uploadBytesMatch[1]);
      const bytes = request.postDataBuffer();
      if (
        !upload ||
        request.headers()['content-type'] !== 'application/octet-stream' ||
        upload.bytes ||
        !bytes ||
        bytes.byteLength !== upload.metadata.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== upload.metadata.sha256
      ) {
        errors.push('上传 PUT 的次序、长度或 SHA-256 不匹配');
        return json(route, { error: '上传字节校验失败' }, 400);
      }
      upload.bytes = bytes;
      upload.stages.push('PUT');
      return route.fulfill({ status: 204 });
    }
    if (method === 'POST' && path === '/v1/assets/uploads/complete') {
      const body = request.postDataJSON();
      const upload = uploads.find((item) => item.uploadId === body.uploadId);
      if (
        !upload?.bytes ||
        upload.asset ||
        Object.entries(upload.metadata).some(([key, value]) => body[key] !== value)
      ) {
        errors.push('上传完成请求未复用初始化元数据或缺少唯一 PUT');
        return json(route, { error: '上传完成校验失败' }, 400);
      }
      const id = 'camera-' + upload.uploadId;
      upload.asset = {
        ...asset(id, upload.metadata.name, 'image'),
        mimeType: upload.metadata.mimeType,
        sizeBytes: upload.bytes.byteLength,
      };
      upload.stages.push('complete');
      catalog.push(upload.asset);
      return json(route, { asset: upload.asset }, 201);
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/events`)
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (method === 'GET' && path === '/v1/auth/me')
      return json(route, {
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'resource-mention-user',
          email: 'resource-mention@example.test',
          role: 'user',
          createdAt: '2026-09-23T00:00:00.000Z',
        },
      });
    if (method === 'GET' && path === '/v1/projects') return json(route, { projects: [project] });
    if (method === 'GET' && path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path === `/v1/projects/${project.id}/canvas`) {
      if (method === 'PATCH') {
        canvas = canvasDocumentSchema.parse({
          ...request.postDataJSON(),
          revision: canvas.revision + 1,
        });
      }
      if (method === 'GET' || method === 'PATCH') return json(route, { canvas });
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/models/defaults`)
      return json(route, { defaults: {}, resolvedDefaults: {} });
    if (method === 'GET' && path === `/v1/projects/${project.id}/runs`)
      return json(route, { runs: [] });
    if (method === 'GET' && path === '/v1/assets') {
      assetQueries.push(Object.fromEntries(url.searchParams));
      if (!projectCatalog) return json(route, { assets: catalog });
      const query = (url.searchParams.get('query') ?? '').toLocaleLowerCase();
      const mediaType = url.searchParams.get('mediaType');
      const matching = catalog.filter(
        (item) =>
          (!mediaType || item.mediaType === mediaType) &&
          [item.name, ...item.tags].some((value) => value.toLocaleLowerCase().includes(query)),
      );
      const current = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '50');
      return json(route, {
        assets: matching.slice((current - 1) * pageSize, current * pageSize),
        total: matching.length,
        page: current,
        pageSize,
      });
    }
    if (method === 'GET' && path === '/v1/prompt-skills') return json(route, { skills: [] });
    if (method === 'GET' && path === '/v1/settings/ai')
      return json(route, {
        settings: { defaultModels: { image: 'mock-image' }, timeoutMs: 900_000 },
        resolvedDefaults: { image: 'mock-image' },
      });
    if (method === 'GET' && path === '/v1/models')
      return json(route, {
        models: ['text', 'image', 'video', 'audio'].map((mediaType) => ({
          id: `mock-${mediaType}`,
          name: `Mock ${mediaType}`,
          mediaTypes: [mediaType],
          group: 'alpha',
          credentialId: 'resource-mention-credential',
          available: true,
        })),
      });
    const accessMatch = path.match(/^\/v1\/assets\/([^/]+)\/access-url$/);
    if (method === 'POST' && accessMatch) {
      const id = decodeURIComponent(accessMatch[1]);
      const entry = catalog.find((item) => item.id === id);
      const version = request.postDataJSON()?.version ?? entry?.latestVersion;
      if (!entry || version !== 1) {
        errors.push('访问了未声明的资产版本：' + id + '@' + version);
        return json(route, { error: '资源版本不存在' }, 404);
      }
      assetAccesses.push({ assetId: id, version });
      return json(route, { url: '/v1/assets/' + id + '/versions/' + version + '/content' });
    }
    const thumbnailMatch = path.match(
      /^\/v1\/assets\/([^/]+)\/versions\/1\/derivatives\/thumbnail$/,
    );
    if (method === 'GET' && thumbnailMatch) {
      const entry = catalog.find(
        (candidate) => candidate.id === decodeURIComponent(thumbnailMatch[1]),
      );
      return route.fulfill({
        status: entry ? 200 : 404,
        contentType: entry?.mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
        body: entry
          ? (uploads.find((upload) => upload.asset?.id === entry.id)?.bytes ?? poster)
          : Buffer.alloc(0),
      });
    }
    const contentMatch = path.match(/^\/v1\/assets\/([^/]+)\/versions\/1\/content$/);
    if (method === 'GET' && contentMatch) {
      const entry = catalog.find(
        (candidate) => candidate.id === decodeURIComponent(contentMatch[1]),
      );
      if (!entry) return route.fulfill({ status: 404, body: '资源不存在' });
      if (entry.mediaType === 'text')
        return route.fulfill({ contentType: 'text/plain', body: `${entry.name} 的本地测试内容。` });
      return route.fulfill({
        contentType: entry.mimeType,
        body:
          uploads.find((upload) => upload.asset?.id === entry.id)?.bytes ??
          (entry.mediaType === 'video' ? video : poster),
      });
    }
    if (method === 'GET' && /^\/v1\/assets\/[^/]+\/versions\/1\/reverse-prompts$/.test(path))
      return json(route, { analysis: null });
    if (method === 'GET' && /^\/v1\/nodes\/[^/]+\/request-prompts$/.test(path))
      return json(route, { records: [] });
    errors.push(`未声明的 Mock 接口：${method} ${path}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return {
    errors,
    apiRequests,
    assetQueries,
    uploads,
    assetAccesses,
    canvas: () => structuredClone(canvas),
  };
}

/** 通过 PC 画布节点的真实入口打开紧凑编辑器。 */
async function openQuickEditor(page: Page) {
  const node = page.locator('.react-flow__node[data-id="resource-mention-node"]');
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.getByText('尚未生成', { exact: true }).click();
  const editor = page.locator('.node-quick-editor');
  await expect(editor).toBeVisible();
  return { node, editor };
}

/** 打开指定目标节点的编辑器；资源删除回归不依赖节点在画布中的选中状态。 */
async function openResourceRemovalEditor(page: Page, targetId: string, expanded = false) {
  const node = page.locator(`.react-flow__node[data-id="${targetId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.getByText('尚未生成', { exact: true }).click();
  const editor = page.locator('.node-quick-editor');
  await expect(editor).toBeVisible();
  if (!expanded) return { node, editor, scope: editor };
  await editor.getByRole('button', { name: '打开完整编辑器' }).click();
  const dialog = page.getByRole('dialog', { name: /· 编辑设置$/, exact: true });
  await expect(dialog).toBeVisible();
  return { node, editor, scope: dialog };
}

/** 断言删除后只解绑目标资源，正文、其它资源、来源节点和其它边均保留。 */
function expectResourceRemoved(
  canvas: CanvasDocument,
  mediaType: Asset['mediaType'],
  primary: Asset,
  retained: Asset,
) {
  const targetId = `resource-removal-target-${mediaType}`;
  const primarySourceId = `resource-removal-primary-${mediaType}`;
  const retainedSourceId = `resource-removal-retained-${mediaType}`;
  const target = canvas.nodes.find((node) => node.id === targetId)!;
  const targetEdges = canvas.edges.filter((edge) => edge.targetNodeId === targetId);
  expect(targetEdges.map((edge) => edge.sourceNodeId)).toEqual([retainedSourceId]);
  expect(target.data.resourceRefs?.map((reference) => reference.assetId)).toEqual([retained.id]);
  expect(target.data.promptDocument?.blocks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'mention', assetId: retained.id }),
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining(`保留开头-${mediaType}`),
      }),
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining(`保留结尾-${mediaType}`),
      }),
    ]),
  );
  expect(target.data.promptDocument?.blocks).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'mention', assetId: primary.id })]),
  );
  expect(canvas.nodes.find((node) => node.id === primarySourceId)).toBeDefined();
  expect(canvas.nodes.find((node) => node.id === retainedSourceId)).toBeDefined();
}

/** 断言画布撤销恢复完整绑定，供同一次历史记录的红绿回归。 */
function expectResourceRestored(
  canvas: CanvasDocument,
  mediaType: Asset['mediaType'],
  primary: Asset,
  retained: Asset,
) {
  const targetId = `resource-removal-target-${mediaType}`;
  const target = canvas.nodes.find((node) => node.id === targetId)!;
  expect(
    canvas.edges.filter((edge) => edge.targetNodeId === targetId).map((edge) => edge.sourceNodeId),
  ).toEqual([`resource-removal-primary-${mediaType}`, `resource-removal-retained-${mediaType}`]);
  expect(target.data.resourceRefs?.map((reference) => reference.assetId)).toEqual([
    primary.id,
    retained.id,
  ]);
  expect(
    target.data.promptDocument?.blocks
      .filter((block) => block.type === 'mention')
      .map((block) => block.assetId),
  ).toEqual([primary.id, retained.id]);
}

/** 读取普通正文，缩略图的内部预览内容不参与提示词。 */
async function readPromptText(input: Locator): Promise<string> {
  return input.evaluate((element) =>
    element instanceof HTMLTextAreaElement
      ? element.value
      : Array.from(element.childNodes)
          .map((node) =>
            node instanceof HTMLElement && node.hasAttribute('data-inline-reference')
              ? ''
              : (node.textContent ?? ''),
          )
          .join(''),
  );
}

/** 读取原生富文本光标前一个字符的实际矩形，用于验证 picker 贴近 @。 */
async function caretCharacterRect(textarea: Locator) {
  return textarea.evaluate((element) => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !element.contains(selection.anchorNode))
      throw new Error('提示词原生选区已丢失');
    const range = selection.getRangeAt(0).cloneRange();
    if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0)
      range.setStart(range.startContainer, range.startOffset - 1);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  });
}

/** 将光标放在独立引用前后，普通名称文字不参与原子删除。 */
async function placeReferenceCaret(input: Locator, name: string, after: boolean) {
  const position = await input.evaluate(
    (element, target) => {
      let offset = 0;
      for (const child of element.childNodes) {
        if (child instanceof HTMLElement && child.hasAttribute('data-inline-reference')) {
          if (child.getAttribute('aria-label') === `引用 ${target.name}`)
            return offset + (target.after ? 1 : 0);
          offset += 1;
        } else offset += child.textContent?.length ?? 0;
      }
      throw new Error(`找不到引用 ${target.name}`);
    },
    { name, after },
  );
  await selectReferenceText(input, position);
}

/** 比较节点外框，确保 portal 内容不会反向撑大 React Flow 节点。 */
function expectSameNodeSize(
  before: { width: number; height: number },
  after: { width: number; height: number },
) {
  expect(after.width).toBeCloseTo(before.width, 0);
  expect(after.height).toBeCloseTo(before.height, 0);
}

/** 在 PC 画布上寻找未被节点、编辑器或工具栏覆盖的真实 pane 坐标。 */
async function blankPanePoint(page: Page) {
  return page.locator('.react-flow__pane').evaluate((pane) => {
    const rect = pane.getBoundingClientRect();
    for (let y = rect.top + 48; y < rect.bottom - 48; y += 48) {
      for (let x = rect.left + 48; x < rect.right - 48; x += 48) {
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    throw new Error('找不到可用于点击和平移的画布空白区域');
  });
}

/** 只匹配 Ant Design 当前可见的提示；退出动画会短暂保留上一条 notice DOM。 */
function visibleMessage(page: Page, text: string) {
  return page.locator('.ant-message-notice:visible').filter({ hasText: text });
}

/** 统计字符串中的非重叠资源名称次数。 */
function occurrenceCount(value: string, name: string) {
  return value.split(name).length - 1;
}

/** 验证 picker 第二行的五个图标和两个 Tab 同行、保留最小间隔，且按钮不越出面板。 */
async function expectPickerControlsLayout(picker: Locator) {
  const filters = picker.getByRole('group', { name: '节点类型' });
  const tabs = picker.getByRole('tablist', { name: '资源范围' });
  await expect(filters.getByRole('button')).toHaveCount(5);
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  const panelBox = await picker.boundingBox();
  const filtersBox = await filters.boundingBox();
  const tabsBox = await tabs.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(filtersBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  expect(tabsBox!.y).toBeCloseTo(filtersBox!.y, 0);
  expect(tabsBox!.x - (filtersBox!.x + filtersBox!.width)).toBeGreaterThanOrEqual(16);

  for (const buttons of [filters.getByRole('button'), tabs.getByRole('tab')]) {
    let previous: { x: number; width: number } | null = null;
    for (const button of await buttons.all()) {
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeCloseTo(filtersBox!.y, 0);
      expect(box!.x).toBeGreaterThanOrEqual(panelBox!.x);
      expect(box!.y).toBeGreaterThanOrEqual(panelBox!.y);
      expect(box!.x + box!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height);

      if (previous) {
        expect(box!.x - (previous.x + previous.width)).toBeGreaterThanOrEqual(6);
      }
      previous = box;
    }
  }
}

for (const mediaType of ['text', 'image', 'audio'] as const) {
  test(`PC ${mediaType} 节点资源条解绑引用、连线和冻结资源且刷新不复活`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const initial = resourceRemovalCanvas(mediaType);
    const [primary, retained] = resourceRemovalAssets(mediaType);
    const fixture = await installFixture(page, baseURL, initial);
    const targetId = `resource-removal-target-${mediaType}`;
    await page.goto(`/projects/${project.id}`);
    let { editor, scope } = await openResourceRemovalEditor(page, targetId);
    const prompt = scope.getByRole('textbox', { name: '提示词', exact: true });
    const originalPrompt = await readPromptText(prompt);
    await expect(
      scope.getByRole('button', { name: `删除 ${primary.name}`, exact: true }),
    ).toBeVisible();
    await expect(
      scope.getByRole('button', { name: `删除 ${retained.name}`, exact: true }),
    ).toBeVisible();

    const removedRevision = fixture.canvas().revision;
    await scope.getByRole('button', { name: `删除 ${primary.name}`, exact: true }).click();
    await expect.poll(() => readPromptText(prompt)).toBe(originalPrompt);
    await expect(
      scope.getByRole('button', { name: `删除 ${primary.name}`, exact: true }),
    ).toHaveCount(0);
    await expect(
      scope.getByRole('button', { name: `删除 ${retained.name}`, exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Control+s');
    await expect.poll(() => fixture.canvas().revision).toBeGreaterThan(removedRevision);
    expectResourceRemoved(fixture.canvas(), mediaType, primary, retained);

    if (mediaType === 'text') {
      const restoredRevision = fixture.canvas().revision;
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(() => readPromptText(prompt)).toBe(originalPrompt);
      await expect(
        scope.getByRole('button', { name: `删除 ${primary.name}`, exact: true }),
      ).toBeVisible();
      await page.keyboard.press('Control+s');
      await expect.poll(() => fixture.canvas().revision).toBeGreaterThan(restoredRevision);
      expectResourceRestored(fixture.canvas(), mediaType, primary, retained);

      const redoneRevision = fixture.canvas().revision;
      await page.getByRole('button', { name: '重做', exact: true }).click();
      await expect.poll(() => readPromptText(prompt)).toBe(originalPrompt);
      await expect(
        scope.getByRole('button', { name: `删除 ${primary.name}`, exact: true }),
      ).toHaveCount(0);
      await page.keyboard.press('Control+s');
      await expect.poll(() => fixture.canvas().revision).toBeGreaterThan(redoneRevision);
      expectResourceRemoved(fixture.canvas(), mediaType, primary, retained);
    }

    await page.reload();
    ({ editor, scope } = await openResourceRemovalEditor(page, targetId));
    await expect
      .poll(() => readPromptText(scope.getByRole('textbox', { name: '提示词', exact: true })))
      .toBe(originalPrompt);
    await expect(
      scope.getByRole('button', { name: `删除 ${primary.name}`, exact: true }),
    ).toHaveCount(0);
    await expect(
      scope.getByRole('button', { name: `删除 ${retained.name}`, exact: true }),
    ).toBeVisible();
    expectResourceRemoved(fixture.canvas(), mediaType, primary, retained);
    await expect(editor).toBeVisible();
    expect(fixture.errors).toEqual([]);
  });
}

test('PC video 完整编辑器解绑资源引用、连线和冻结资源且刷新不复活', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const mediaType = 'video' as const;
  const initial = resourceRemovalCanvas(mediaType);
  const [primary, retained] = resourceRemovalAssets(mediaType);
  const fixture = await installFixture(page, baseURL, initial);
  const targetId = `resource-removal-target-${mediaType}`;
  await page.goto(`/projects/${project.id}`);
  let { scope } = await openResourceRemovalEditor(page, targetId, true);
  const prompt = scope.getByRole('textbox', { name: '提示词', exact: true });
  const originalPrompt = await readPromptText(prompt);

  const removedRevision = fixture.canvas().revision;
  await scope.getByRole('button', { name: `删除 ${primary.name}`, exact: true }).click();
  await expect.poll(() => readPromptText(prompt)).toBe(originalPrompt);
  await expect(
    scope.getByRole('button', { name: `删除 ${primary.name}`, exact: true }),
  ).toHaveCount(0);
  await expect(
    scope.getByRole('button', { name: `删除 ${retained.name}`, exact: true }),
  ).toBeVisible();
  await scope.getByRole('button', { name: '关闭编辑器', exact: true }).click();
  await expect(scope).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await expect.poll(() => fixture.canvas().revision).toBeGreaterThan(removedRevision);
  expectResourceRemoved(fixture.canvas(), mediaType, primary, retained);

  await page.reload();
  ({ scope } = await openResourceRemovalEditor(page, targetId, true));
  await expect
    .poll(() => readPromptText(scope.getByRole('textbox', { name: '提示词', exact: true })))
    .toBe(originalPrompt);
  await expect(
    scope.getByRole('button', { name: `删除 ${primary.name}`, exact: true }),
  ).toHaveCount(0);
  await expect(
    scope.getByRole('button', { name: `删除 ${retained.name}`, exact: true }),
  ).toBeVisible();
  expectResourceRemoved(fixture.canvas(), mediaType, primary, retained);
  expect(fixture.errors).toEqual([]);
});

test('1440 PC 节点 picker 贴近 @、独立搜索筛选滚动，并支持原子删除与撤销', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page, baseURL);
  await page.goto(`/projects/${project.id}`);
  const { node, editor } = await openQuickEditor(page);
  const prompt = editor.getByRole('textbox', { name: '提示词' });
  const nodeBefore = await node.boundingBox();
  expect(nodeBefore).not.toBeNull();
  const initialPrompt = await readPromptText(prompt);

  await prompt.press('End');
  await prompt.type(' @');
  const picker = page.locator('.resource-mention-picker');
  const searchbox = page.getByRole('searchbox', { name: '搜索资源' });
  const listbox = page.getByRole('listbox', { name: '选择资源' });
  await expect(picker).toBeVisible();
  await expect(searchbox).toBeVisible();
  await expect(listbox).toBeVisible();
  await expect(page.locator('.ant-popover.resource-mention-picker-popover')).toBeVisible();
  await expect(picker.getByRole('tab', { name: '节点资源', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(listbox.getByRole('option')).toHaveCount(1);
  await picker.getByRole('tab', { name: '项目资源', exact: true }).click();
  await expect(listbox.getByRole('option')).toHaveCount(10);
  await expect(picker.getByRole('navigation', { name: '项目资源分页' })).toHaveCount(0);
  expect(await picker.evaluate((element) => element.closest('.react-flow__node') === null)).toBe(
    true,
  );

  const promptBox = await prompt.boundingBox();
  const pickerBox = await picker.boundingBox();
  const caretBox = await caretCharacterRect(prompt);
  expect(promptBox).not.toBeNull();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox!.width).toBeCloseTo(380, 0);
  expect(pickerBox!.height).toBeCloseTo(480, 0);
  expect(pickerBox!.x).toBeGreaterThanOrEqual(8);
  expect(pickerBox!.y).toBeGreaterThanOrEqual(8);
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(1432);
  expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(892);
  expect(pickerBox!.y).toBeLessThan(promptBox!.y + promptBox!.height);
  const horizontalGap = Math.min(
    Math.abs(pickerBox!.x - caretBox.right),
    Math.abs(pickerBox!.x + pickerBox!.width - caretBox.left),
  );
  expect(horizontalGap).toBeLessThanOrEqual(16);
  // 输入面板贴近底边时 Popover 会沿 @ 的底边对齐，仍须紧邻同一个字符。
  const verticalGap = Math.min(
    Math.abs(pickerBox!.y - caretBox.top),
    Math.abs(pickerBox!.y + pickerBox!.height - caretBox.bottom),
  );
  expect(verticalGap).toBeLessThanOrEqual(20);
  const nodeWithPicker = await node.boundingBox();
  expect(nodeWithPicker).not.toBeNull();
  expectSameNodeSize(nodeBefore!, nodeWithPicker!);

  await expectPickerControlsLayout(picker);
  const filterNames = ['全部', '图片', '视频', '音频', '文本'] as const;
  for (const name of filterNames) {
    const filter = picker.getByRole('button', { name, exact: true });
    await expect(filter).toHaveAttribute('aria-pressed');
  }
  await expect(picker.getByRole('button', { name: '全部', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const filtersBox = await picker.locator('.resource-mention-filters').boundingBox();
  const resultsBox = await listbox.boundingBox();
  expect(resultsBox!.y).toBeGreaterThanOrEqual(filtersBox!.y + filtersBox!.height - 1);

  await searchbox.fill('采访');
  await expect.poll(() => readPromptText(prompt)).toBe(`${initialPrompt} @`);
  await expect(listbox.getByRole('option', { name: /采访脚本/ })).toBeVisible();
  await expect(listbox.getByRole('option', { name: /产品图/ })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('resource-mention-picker.png'),
    animations: 'disabled',
  });

  await searchbox.fill('');
  await expect(searchbox).toHaveValue('');
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole('option')).toHaveCount(10);
  await picker.screenshot({
    path: test.info().outputPath('resource-mention-picker-default-ten.png'),
    animations: 'disabled',
  });
  await picker.getByRole('button', { name: '视频', exact: true }).click();
  await expect(picker.getByRole('button', { name: '视频', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(listbox.getByRole('option', { name: /产品视频/ })).toBeVisible();
  await expect(listbox.getByRole('option', { name: /产品图/ })).toHaveCount(0);
  await expect.poll(() => readPromptText(prompt)).toBe(`${initialPrompt} @`);

  await picker.getByRole('button', { name: '全部', exact: true }).click();
  await expect(listbox.getByRole('option')).toHaveCount(10);
  await expect(picker.getByRole('navigation', { name: '项目资源分页' })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('resource-mention-picker-all-resources.png'),
    animations: 'disabled',
  });
  const filterScrollBefore = await picker
    .locator('.resource-mention-filters')
    .evaluate((element) => element.scrollTop);
  const resultScroll = await listbox.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      top: element.scrollTop,
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
    };
  });
  expect(resultScroll.contentHeight).toBeGreaterThan(resultScroll.height);
  expect(resultScroll.top).toBeGreaterThan(0);
  expect(
    await picker.locator('.resource-mention-filters').evaluate((element) => element.scrollTop),
  ).toBe(filterScrollBefore);

  await searchbox.fill('声音样本');
  await expect(picker.getByRole('option', { name: /声音样本/ })).toBeVisible();
  await searchbox.press('ArrowDown');
  await searchbox.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect.poll(() => readPromptText(prompt)).toBe(`${initialPrompt} `);
  await expect(editor.getByRole('button', { name: '删除 声音样本' })).toBeVisible();

  await placeReferenceCaret(prompt, '产品图', true);
  await prompt.press('Backspace');
  await expect(prompt.locator('[data-inline-reference][aria-label="引用 产品图"]')).toHaveCount(1);
  await expect(editor.getByRole('button', { name: '删除 产品图' })).toBeVisible();

  await placeReferenceCaret(prompt, '产品图', false);
  await prompt.press('Delete');
  await expect(prompt.locator('[data-inline-reference][aria-label="引用 产品图"]')).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '删除 产品图' })).toBeVisible();

  await prompt.press('Control+z');
  await expect(prompt.locator('[data-inline-reference][aria-label="引用 产品图"]')).toHaveCount(1);
  expect(occurrenceCount(await readPromptText(prompt), '产品图')).toBe(2);
  await expect(editor.getByRole('button', { name: '删除 产品图' })).toBeVisible();
  const nodeAfter = await node.boundingBox();
  expect(nodeAfter).not.toBeNull();
  expectSameNodeSize(nodeBefore!, nodeAfter!);
  expect(fixture.errors).toEqual([]);
});

test('1024 PC 放大 Dialog 的顶层 picker 保持搜索焦点、可选中且 Escape 不关闭模态框', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const fixture = await installFixture(page, baseURL);
  await page.goto(`/projects/${project.id}`);
  const { node, editor } = await openQuickEditor(page);
  const nodeBefore = await node.boundingBox();
  expect(nodeBefore).not.toBeNull();
  await editor.getByRole('button', { name: '打开完整编辑器' }).click();

  const dialog = page.getByRole('dialog', { name: '资源引用节点 · 编辑设置' });
  await expect(dialog).toBeVisible();
  const prompt = dialog.getByRole('textbox', { name: '提示词' });
  await expect(prompt).toBeFocused();
  const original = await readPromptText(prompt);
  await prompt.press('End');
  await prompt.type(' @');

  const picker = dialog.locator('.resource-mention-picker');
  const searchbox = picker.getByRole('searchbox', { name: '搜索资源' });
  const listbox = picker.getByRole('listbox', { name: '选择资源' });
  await expect(picker).toBeVisible();
  await expect(dialog.locator('.ant-popover.resource-mention-picker-popover')).toBeVisible();
  expect(await picker.evaluate((element) => element.closest('[role="dialog"]') !== null)).toBe(
    true,
  );
  await searchbox.click();
  await expect(searchbox).toBeFocused();
  await picker.getByRole('tab', { name: '项目资源', exact: true }).click();
  await expect(listbox.getByRole('option')).toHaveCount(10);
  await expect(picker.getByRole('navigation', { name: '项目资源分页' })).toHaveCount(0);
  await searchbox.fill('需求');
  await expect(searchbox).toBeFocused();
  await expect.poll(() => readPromptText(prompt)).toBe(`${original} @`);
  await expect(listbox.getByRole('option', { name: /资料文档/ })).toBeVisible();
  await expect(listbox.getByRole('option')).toHaveCount(1);

  const pickerBox = await picker.boundingBox();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox!.width).toBeCloseTo(380, 0);
  expect(pickerBox!.height).toBeCloseTo(480, 0);
  expect(pickerBox!.x).toBeGreaterThanOrEqual(8);
  expect(pickerBox!.y).toBeGreaterThanOrEqual(8);
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(1016);
  expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(760);
  await expectPickerControlsLayout(picker);
  await page.screenshot({
    path: test.info().outputPath('resource-mention-picker-dialog.png'),
    animations: 'disabled',
  });

  await searchbox.fill('');
  await expect(searchbox).toHaveValue('');
  await expect(searchbox).toBeFocused();
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole('option')).toHaveCount(10);
  await expect(picker.getByRole('navigation', { name: '项目资源分页' })).toHaveCount(0);
  await picker.screenshot({
    path: test.info().outputPath('resource-mention-picker-dialog-default-ten.png'),
    animations: 'disabled',
  });
  await searchbox.fill('需求');
  await expect(searchbox).toBeFocused();
  await expect(listbox.getByRole('option', { name: /资料文档/ })).toBeVisible();
  await expect(listbox.getByRole('option')).toHaveCount(1);

  await searchbox.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(picker).toHaveCount(0);
  await expect.poll(() => readPromptText(prompt)).toBe(`${original} `);
  await expect(prompt).toBeFocused();

  await prompt.press('End');
  await prompt.type(' @');
  const reopenedPicker = dialog.locator('.resource-mention-picker');
  const reopenedSearchbox = reopenedPicker.getByRole('searchbox', { name: '搜索资源' });
  await reopenedSearchbox.click();
  await expect(reopenedSearchbox).toBeFocused();
  await reopenedSearchbox.press('Escape');
  await expect(reopenedPicker).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(prompt).toBeFocused();
  await expect.poll(() => readPromptText(prompt)).toBe(`${original}  @`);

  const nodeAfter = await node.boundingBox();
  expect(nodeAfter).not.toBeNull();
  expectSameNodeSize(nodeBefore!, nodeAfter!);
  expect(fixture.errors).toEqual([]);
});

test('Ant Design 命令面板圈定焦点、保护 IME，并在关闭后恢复触发器', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page, baseURL);
  await page.goto(`/projects/${project.id}`);
  const trigger = page.getByRole('button', { name: '打开命令面板' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '命令面板' });
  await expect(dialog).toHaveClass(/ant-modal/);
  const input = dialog.getByRole('searchbox');
  const close = dialog.getByRole('button', { name: '关闭命令面板' });
  await expect(input).toBeFocused();
  await input.press('Tab');
  await expect(close).toBeFocused();
  await close.press('Tab');
  await expect(input).toBeFocused();
  await input.press('Shift+Tab');
  await expect(close).toBeFocused();
  await input.fill('设置');
  await input.press('Tab');
  const clear = dialog.getByRole('button', { name: '清空搜索' });
  await expect(clear).toBeFocused();
  await clear.press('Tab');
  await expect(close).toBeFocused();
  await close.press('Tab');
  await expect
    .poll(() =>
      page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        classes: document.activeElement?.className,
        label: document.activeElement?.getAttribute('aria-label'),
      })),
    )
    .toMatchObject({ classes: expect.stringContaining('command-palette-input') });
  await expect(input).toBeFocused();
  await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229 });
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: '../../test-results/component-library-command.png',
    animations: 'disabled',
  });
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.locator('.ant-modal-wrap').click({ position: { x: 8, y: 8 } });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(fixture.errors).toEqual([]);
});

/** 分类标题与只读 combobox 只保留文字焦点提示，不能叠加旧表单底色、边框或阴影。 */
async function expectPlainResourceFilter(field: Locator) {
  await expect
    .poll(() =>
      field.evaluate((root) =>
        [root, ...root.querySelectorAll('.ant-select, .ant-select-input')].map((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            shadow: style.boxShadow,
            outlined: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0,
            bordered:
              style.borderTopStyle !== 'none' &&
              Number.parseFloat(style.borderTopWidth) > 0 &&
              style.borderTopColor !== 'rgba(0, 0, 0, 0)',
          };
        }),
      ),
    )
    .toEqual(
      Array.from({ length: 3 }, () => ({
        background: 'rgba(0, 0, 0, 0)',
        shadow: 'none',
        outlined: false,
        bordered: false,
      })),
    );
}

test('资源分类在五种主题下没有叠加底色和点击边框，键盘与筛选仍可用', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page, baseURL);
  await page.goto('/projects/' + project.id);
  const panel = page.getByRole('complementary', { name: '项目资源' });
  const field = panel.locator('.resource-filter-field');
  const filter = panel.getByRole('combobox', { name: '资源类型', exact: true });
  await expect(filter).toBeVisible({ timeout: 30_000 });

  for (const [theme, label] of [
    ['eye-care', '护眼'],
    ['light', '明亮'],
    ['dark', '深色'],
    ['sepia', '暖白'],
    ['contrast', '高对比'],
  ]) {
    await page.getByRole('button', { name: '外观', exact: true }).first().hover();
    const appearance = page.getByRole('dialog', { name: '主题、画布背景与连接线' });
    await appearance.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.mouse.move(600, 50);
    await expect(appearance).toHaveCount(0);
    await expectPlainResourceFilter(field);
    await filter.click();
    await expect(filter).toHaveAttribute('aria-expanded', 'true');
    await expectPlainResourceFilter(field);
    await expect(panel.locator('.compact-select-antd-popup')).not.toHaveClass(
      /slide-up-(enter|appear)/,
    );
    await page.screenshot({ path: testInfo.outputPath('resource-filter-' + theme + '.png') });
    await filter.press('Escape');
    await expect(filter).toHaveAttribute('aria-expanded', 'false');
  }

  await filter.press('Tab');
  await expect(panel.getByRole('button', { name: '上传资源', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(filter).toBeFocused();
  await expect(field.locator('.ant-select-content')).toHaveCSS('text-decoration-line', 'underline');
  await expectPlainResourceFilter(field);
  await filter.press('ArrowDown');
  await expect(filter).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('option', { name: '图片（9）', exact: true }).click();
  await expect(field.locator('.ant-select-content')).toHaveText('图片（9）');
  await expect(panel.getByRole('button', { name: '预览 产品图', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '预览 产品视频', exact: true })).toHaveCount(0);
  await panel.getByPlaceholder('搜索资源').fill('产品');
  await expect(panel.getByRole('button', { name: /^预览 / })).toHaveCount(1);
  expect(
    fixture.apiRequests.some(
      (request) => /\/runs(?:\/|$)/.test(request.path) && request.method !== 'GET',
    ),
  ).toBe(false);
  expect(fixture.errors).toEqual([]);
});

test('外观入口的五种主题同步到组件库模型选项且不撑大节点', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page, baseURL);
  await page.goto('/projects/' + project.id);
  const { node, editor } = await openQuickEditor(page);
  const before = (await node.boundingBox())!;
  const dialog = page.getByRole('dialog', { name: '资源引用节点 · 编辑设置' });
  const model = dialog.getByRole('combobox', { name: /^模型：/ });
  for (const [theme, label] of [
    ['eye-care', '护眼'],
    ['light', '明亮'],
    ['dark', '深色'],
    ['sepia', '暖白'],
    ['contrast', '高对比'],
  ]) {
    await page.getByRole('button', { name: '外观', exact: true }).first().hover();
    const appearance = page.getByRole('dialog', { name: '主题、画布背景与连接线' });
    await appearance.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', theme);
    await page.mouse.move(600, 50);
    await expect(appearance).toHaveCount(0);
    await editor.getByRole('button', { name: '打开完整编辑器' }).click();
    await model.click();
    const options = dialog.getByRole('listbox', { name: '模型选项' });
    await expect(options).toBeVisible();
    await expect(options.getByRole('option').first()).toBeVisible();
    const popup = dialog.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
    await expect(popup).toBeVisible();
    await expect
      .poll(() => popup.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(
        theme === 'dark'
          ? 'rgb(26, 32, 40)'
          : theme === 'eye-care'
            ? 'rgb(248, 251, 245)'
            : theme === 'sepia'
              ? 'rgb(251, 248, 241)'
              : 'rgb(255, 255, 255)',
      );
    await page.screenshot({
      path: '../../test-results/component-library-theme-' + theme + '.png',
      animations: 'disabled',
    });
    await options.getByRole('option', { name: /Mock image/ }).click();
    await expect(options).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expectSameNodeSize(before, (await node.boundingBox())!);
    await dialog.getByRole('button', { name: '关闭编辑器' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(editor.getByRole('button', { name: '打开完整编辑器' })).toBeFocused();
  }
  expect(fixture.errors).toEqual([]);
});

test('组件库右键菜单避开 PC 视口边缘，窗口缩放后仍可见可取消', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page, baseURL);
  await page.goto('/projects/' + project.id);
  await expect(page.locator('.react-flow__pane')).toBeVisible();
  await page.mouse.click(1435, 700, { button: 'right' });
  const menu = page.getByRole('menu', { name: '画布操作' });
  await expect(menu).toBeVisible();
  /** 测量组件库定位后的菜单，而非没有布局的测试环境里的锚点。 */
  const expectInside = async (width: number, height: number) => {
    await expect
      .poll(async () => {
        const box = await menu.boundingBox();
        return Boolean(
          box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= width + 1 &&
          box.y + box.height <= height + 1,
        );
      })
      .toBe(true);
  };
  await expectInside(1440, 900);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectInside(1024, 768);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('资源管理的库组件支持保存、归档确认、恢复和键盘关闭', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await installFixture(page, baseURL);
  let entry = {
    ...assets[0],
    ownerId: 'resource-mention-user',
    projectId: project.id,
    source: 'upload',
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
  const writes: Record<string, unknown>[] = [];
  await page.route('**/v1/account/resources**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/content'))
      return route.fulfill({ contentType: 'image/jpeg', body: poster });
    if (url.pathname === '/v1/account/resources')
      return json(route, { assets: [entry], total: 1, page: 1, pageSize: 24 });
    if (request.method() === 'PATCH') {
      const patch = request.postDataJSON();
      writes.push(patch);
      entry = { ...entry, ...patch };
    }
    return json(route, { asset: entry, versions: [], project });
  });
  await page.goto('/resources');
  await expect(page.getByRole('heading', { name: '我的资源' })).toBeVisible();
  await page.getByRole('combobox', { name: '资源类型' }).click();
  await page.getByRole('option', { name: '图片', exact: true }).click();
  await page.getByRole('button', { name: /产品图.*上传资源/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveClass(/ant-modal/);
  await dialog.getByRole('textbox', { name: '资源名称' }).fill('组件库测试图');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByText('资源信息已保存')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ name: '组件库测试图' });
  await dialog.getByRole('button', { name: '归档', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '确认归档' })).toBeVisible();
  expect(writes).toHaveLength(1);
  await dialog.getByRole('button', { name: '确认归档' }).click();
  await expect(dialog.getByRole('button', { name: '恢复', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(dialog.getByText('资源已恢复')).toBeVisible();
  expect(writes.map((write) => write.status).filter(Boolean)).toEqual(['archived', 'ready']);
  await page.screenshot({
    path: '../../test-results/component-library-resources.png',
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('管理审计使用组件库表格和分页，并保留服务端页码', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await installFixture(page, baseURL);
  const user = {
    id: 'component-admin',
    role: 'admin',
    displayName: '组件验收管理员',
    createdAt: project.createdAt,
  };
  await page.addInitScript(
    (user) => localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user })),
    user,
  );
  await page.route('**/v1/auth/me', (route) => json(route, { user }));
  const pages: number[] = [];
  await page.route('**/v1/admin/audit**', (route) => {
    const pageNumber = Number(new URL(route.request().url()).searchParams.get('page') ?? 1);
    pages.push(pageNumber);
    return json(route, {
      events: [
        {
          id: 'audit-' + pageNumber,
          actorId: user.id,
          action: 'resource.update',
          targetId: '合成资源',
          summary: '第 ' + pageNumber + ' 页本地审计',
          createdAt: project.createdAt,
        },
      ],
      total: 31,
      page: pageNumber,
      pageSize: 30,
    });
  });
  await page.goto('/admin/audit');
  await expect(page.locator('.ant-table')).toBeVisible();
  await expect(page.getByText('第 1 页本地审计')).toBeVisible();
  await page.locator('.ant-pagination-next').click();
  await expect(page.getByText('第 2 页本地审计')).toBeVisible();
  expect(pages).toContain(2);
  await page.screenshot({
    path: '../../test-results/component-library-audit.png',
    animations: 'disabled',
  });
  expect(fixture.errors).toEqual([]);
});

test('资源预览由库模态承载，关闭后焦点回到原资源', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page, baseURL);
  await page.goto('/projects/' + project.id);
  await page.getByRole('button', { name: '展开资源栏', exact: true }).click();
  const trigger = page.getByRole('button', { name: '预览 产品图', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '产品图', exact: true });
  await expect(dialog).toHaveClass(/ant-modal/);
  await expect(dialog.getByRole('img', { name: '产品图' })).toBeVisible();
  await expect(dialog).toHaveCSS('opacity', '1');
  await expect(dialog).toHaveCSS('display', 'inline-grid');
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const stage = element
          .querySelector('.artifact-preview-viewer-stage')!
          .getBoundingClientRect();
        const image = element.querySelector('img')!.getBoundingClientRect();
        const title = element.querySelector('[data-slot="dialog-title"]')!.getBoundingClientRect();
        const zoom = element
          .querySelector('.artifact-preview-viewer-zoom')!
          .getBoundingClientRect();
        const close = element
          .querySelector('.artifact-preview-viewer-close')!
          .getBoundingClientRect();
        return Math.max(
          Math.abs(stage.width - image.width),
          Math.abs(stage.height - image.height),
          Math.abs(zoom.y - close.y),
          Math.abs(title.y - zoom.y),
        );
      }),
    )
    .toBeLessThan(2);
  await page.screenshot({
    path: '../../test-results/component-library-preview.png',
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '关闭预览' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(fixture.errors).toEqual([]);
});

test('设置、Skill 和生成说明模态保留业务布局及嵌套关闭语义', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page, baseURL);
  await page.route('**/v1/account/newapi', (route) =>
    json(route, {
      account: {
        issuer: 'https://provider.example.test',
        externalUserId: 'component-user',
        status: 'active',
        groups: [],
        links: {},
      },
    }),
  );
  await page.goto('/projects/' + project.id);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'New API 与模型', exact: true });
  await expect(settings).toHaveCSS('display', 'inline-flex');
  await expect(settings).toHaveCSS('width', '1080px');
  await expect(settings).toHaveCSS('padding', '0px');
  await settings.getByRole('tab', { name: '节点默认', exact: true }).click();
  const imageModel = settings.getByRole('combobox', { name: '图片', exact: true });
  await expect(imageModel).toBeEnabled();
  await imageModel.click();
  await expect(settings.getByRole('option', { name: /Mock image/ })).toBeVisible();
  await imageModel.press('Escape');
  await expect(settings.getByRole('option', { name: /Mock image/ })).toHaveCount(0);
  await expect(settings).toBeVisible();
  await page.screenshot({
    path: '../../test-results/component-library-settings.png',
    animations: 'disabled',
  });
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(settings).toHaveCount(0);

  await page.getByRole('button', { name: '技能工作台', exact: true }).first().click();
  const skills = page.getByRole('dialog', { name: 'Skill 工作台', exact: true });
  await expect(skills).toHaveCSS('display', 'inline-flex');
  await expect(skills).toHaveCSS('width', '1408px');
  const name = skills.getByRole('textbox', { name: '名称', exact: true });
  await expect(name).toBeEditable();
  await name.fill('未保存的本地测试');
  await skills.getByRole('button', { name: '关闭 Skill 工作台', exact: true }).click();
  const discard = page.getByRole('alertdialog', { name: '放弃未保存的更改？', exact: true });
  await expect(discard).toHaveCSS('width', '420px');
  await discard.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(discard).toHaveCount(0);
  await expect(name).toHaveValue('未保存的本地测试');
  await page.screenshot({
    path: '../../test-results/component-library-skills.png',
    animations: 'disabled',
  });
  await skills.getByRole('button', { name: '关闭 Skill 工作台', exact: true }).click();
  await discard.getByRole('button', { name: '放弃更改', exact: true }).click();
  await expect(skills).toHaveCount(0);

  const { node } = await openQuickEditor(page);
  await node.getByRole('button', { name: '查看生成提示词：资源引用节点', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: '生成提示词', exact: true });
  await expect(prompt).toHaveCSS('display', 'inline-flex');
  await expect(prompt).toHaveCSS('width', '800px');
  await prompt.getByRole('button', { name: '关闭生成提示词', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('组件库菜单和外观标签独占键盘，不删除节点或穿透撤销重做', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page, baseURL);
  await page.goto('/projects/' + project.id);
  await page.getByRole('button', { name: '新建文字生成节点', exact: true }).click();
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(2);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect.poll(() => fixture.canvas().nodes.length).toBe(2);

  /** 在真实菜单项和标签获得焦点后发键，防止只测到原生触发按钮。 */
  const assertKeysStayInControls = async (keys: string[], count: number) => {
    for (const entry of [
      { trigger: '打开项目集合', layer: '项目集合', type: 'menu' },
      { trigger: '导出', layer: '导出选项', type: 'menu' },
      { trigger: '账户菜单', layer: '账户操作', type: 'menu' },
      { trigger: '外观', layer: '主题、画布背景与连接线', type: 'dialog' },
    ] as const) {
      const trigger = page.getByRole('button', { name: entry.trigger, exact: true }).first();
      if (entry.trigger === '账户菜单' || entry.trigger === '外观') await trigger.hover();
      else await trigger.click();
      const layer = page.getByRole(entry.type, { name: entry.layer, exact: true });
      await expect(layer).toBeVisible();
      const control = layer.getByRole(entry.type === 'menu' ? 'menuitem' : 'tab').first();
      await control.focus();
      await expect(control).toBeFocused();
      for (const key of keys) {
        await page.keyboard.press(key);
        await expect(nodes, `${entry.trigger} 不响应画布 ${key}`).toHaveCount(count);
        await expect(layer).toBeVisible();
      }
      await page.mouse.click(600, 50);
      await expect(layer).toHaveCount(0);
      expect(fixture.canvas().nodes).toHaveLength(count);
    }
  };

  await assertKeysStayInControls(['Delete', 'Backspace', 'Control+z'], 2);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(nodes).toHaveCount(1);
  await expect.poll(() => fixture.canvas().nodes.length).toBe(1);
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
  await assertKeysStayInControls(['Control+Shift+z', 'Control+y'], 1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(nodes).toHaveCount(2);
  await expect.poll(() => fixture.canvas().nodes.length).toBe(2);
  const selectedNode = page.locator('.react-flow__node[data-id^="node_text_generate_"]');
  await selectedNode.getByText('尚未生成', { exact: true }).click();
  await expect(selectedNode).toHaveClass(/selected/);
  await selectedNode.focus();
  await page.keyboard.press('Delete');
  await expect(nodes).toHaveCount(1);
  await expect.poll(() => fixture.canvas().nodes.length).toBe(1);
  await page.keyboard.press('Control+z');
  await expect(nodes).toHaveCount(2);
  await selectedNode.getByText('尚未生成', { exact: true }).click();
  await expect(selectedNode).toHaveClass(/selected/);
  await selectedNode.focus();
  await page.keyboard.press('Backspace');
  await expect(nodes).toHaveCount(1);
  await expect.poll(() => fixture.canvas().nodes.length).toBe(1);
  await page.keyboard.press('Control+z');
  await expect(nodes).toHaveCount(2);
  expect(fixture.errors).toEqual([]);
});

test('节点输入区数量样式统一，Skill 同行悬浮且不撑大节点', async ({ page, baseURL }, testInfo) => {
  const fixture = await installFixture(page, baseURL);
  let generationRequests = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(runs|prompt-optimizations)$/.test(new URL(request.url()).pathname)
    )
      generationRequests++;
  });
  await page.goto('/projects/' + project.id);
  const { node, editor } = await openQuickEditor(page);
  const originalBounds = await node.boundingBox();
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    const count = editor.getByRole('combobox', { name: '生成数量：1份' });
    const skill = editor.getByRole('button', { name: 'Skill 配置', exact: true });
    await expect(count).toBeVisible();
    // 节点下方空间有限时，只滚动已有编辑区，不改变节点外框。
    await skill.scrollIntoViewIfNeeded();
    await expect(skill).toBeInViewport();
    const skillBounds = (await skill.boundingBox())!;
    const visibleEditor = (await editor.boundingBox())!;
    // 缩放后的原生滚动边界可能舍入不足一个屏幕像素，不能误判为按钮被遮挡。
    expect(skillBounds.x).toBeGreaterThanOrEqual(Math.max(0, visibleEditor.x) - 1);
    expect(skillBounds.y).toBeGreaterThanOrEqual(Math.max(0, visibleEditor.y) - 1);
    expect(skillBounds.x + skillBounds.width).toBeLessThanOrEqual(
      Math.min(viewport.width, visibleEditor.x + visibleEditor.width) + 1,
    );
    expect(skillBounds.y + skillBounds.height).toBeLessThanOrEqual(
      Math.min(viewport.height, visibleEditor.y + visibleEditor.height) + 1,
    );
    const layout = await editor.evaluate((element) => {
      const model = element.querySelector('.node-quick-editor-select-group .ant-select')!;
      const quantity = element.querySelector('.node-quick-editor-generation-count .ant-select')!;
      const controls = element.querySelector(
        '.node-quick-editor-controls:not(.node-quick-editor-topbar)',
      )!;
      const trigger = element.querySelector('.prompt-skill-trigger')!;
      const shape = (target: Element) => {
        const style = getComputedStyle(target);
        return {
          height: target.getBoundingClientRect().height,
          radius: style.borderRadius,
          background: style.backgroundColor,
          fontSize: style.fontSize,
        };
      };
      return {
        model: shape(model),
        quantity: shape(quantity),
        skillWidth: trigger.getBoundingClientRect().width,
        skillTop: trigger.getBoundingClientRect().top,
        modelTop: model.getBoundingClientRect().top,
        quantityTop: quantity.getBoundingClientRect().top,
        inControls: controls.contains(trigger),
        overflow: element.scrollWidth > element.clientWidth,
      };
    });
    expect(layout.quantity).toEqual(layout.model);
    expect(layout.skillWidth).toBeLessThan(100);
    expect(layout.inControls).toBe(true);
    expect(layout.skillTop).toBeCloseTo(layout.quantityTop, 0);
    expect(layout.overflow).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath(`node-controls-${viewport.width}.png`),
      animations: 'disabled',
    });
    const editorBounds = await editor.boundingBox();
    await skill.hover();
    const configuration = page.getByRole('group', { name: 'Skill 配置', exact: true });
    await expect(configuration).toBeInViewport({ ratio: 1 });
    await expect(editor.getByRole('group', { name: 'Skill 配置', exact: true })).toHaveCount(0);
    expect((await editor.boundingBox())!.height).toBeCloseTo(editorBounds!.height, 0);
    await page.screenshot({
      path: testInfo.outputPath(`node-controls-hover-${viewport.width}.png`),
      animations: 'disabled',
    });
    await expect(
      configuration.getByRole('combobox', { name: '提示词 Skill', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(configuration).toBeHidden();
  }
  await editor.getByRole('combobox', { name: '生成数量：1份' }).click();
  const options = page.getByRole('listbox', { name: '生成数量选项' });
  await expect(options.getByRole('option')).toHaveCount(20);
  await options.getByRole('option', { name: '3份', exact: true }).click();
  await expect(editor.getByRole('combobox', { name: '生成数量：3份' })).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect
    .poll(
      () =>
        fixture.canvas().nodes.find((entry) => entry.id === 'resource-mention-node')?.data
          .generationCount,
    )
    .toBe(3);
  await page.reload();
  await openQuickEditor(page);
  await expect(editor.getByRole('combobox', { name: '生成数量：3份' })).toBeVisible();
  await editor.getByRole('button', { name: '打开完整编辑器' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox', { name: '生成数量：3份' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Skill 配置', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Skill 配置', exact: true })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('node-controls-dialog.png'),
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '关闭编辑器' }).click();
  const finalBounds = await node.boundingBox();
  expect(finalBounds!.width).toBeCloseTo(originalBounds!.width, 0);
  expect(finalBounds!.height).toBeCloseTo(originalBounds!.height, 0);
  expect(generationRequests).toBe(0);
  expect(fixture.errors).toEqual([]);
});

test('Skill 优化预览在悬浮卡片和完整编辑器中可编辑，关闭后保留结果且不撑开输入区', async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page, baseURL);
  const source = structuredClone(fixture.canvas().nodes[0]!.data.promptDocument!);
  const skill = PROMPT_SKILLS[0]!;
  let submissions = 0;
  await page.route('**/v1/prompt-skills', (route) => json(route, { skills: [skill] }));
  await page.route('**/v1/**/prompt-optimizations', async (route) => {
    const body = route.request().postDataJSON();
    submissions++;
    expect(body.promptDocument).toEqual(source);
    return json(route, {
      optimization: {
        runId: 'synthetic-bottom-skill',
        nodeId: body.nodeId,
        skillId: skill.id,
        skillVersion: skill.version,
        status: 'succeeded',
        modelAlias: 'mock-text',
        promptDocument: {
          ...source,
          blocks: source.blocks.map((block: PromptDocument['blocks'][number]) =>
            block.type === 'text' ? { ...block, text: '优化后：' + block.text } : block,
          ),
        },
      },
    });
  });
  await page.goto('/projects/' + project.id);
  const { node, editor } = await openQuickEditor(page);
  const nodeBounds = await node.boundingBox();
  const editorBounds = await editor.boundingBox();
  const trigger = editor.getByRole('button', { name: 'Skill 配置', exact: true });
  await trigger.hover();
  const configuration = page.getByRole('group', { name: 'Skill 配置', exact: true });
  await configuration.getByRole('combobox', { name: '提示词 Skill', exact: true }).click();
  await page.getByRole('option', { name: skill.name, exact: true }).click();
  await configuration.getByRole('button', { name: '优化提示词', exact: true }).click();
  const preview = configuration.getByRole('group', { name: '优化预览', exact: true });
  await expect(preview).toBeVisible();
  await preview.getByRole('textbox', { name: '优化文字 1', exact: true }).click();
  await page.keyboard.press('Tab');
  await expect(preview.getByRole('textbox', { name: '优化文字 3', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(preview.getByRole('textbox', { name: '优化文字 5', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(preview.getByRole('button', { name: '丢弃', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(preview.getByRole('button', { name: '应用', exact: true })).toBeFocused();
  await expect(configuration).toBeVisible();
  await expect(editor.locator('.prompt-skill-preview')).toHaveCount(0);
  expect((await editor.boundingBox())!.height).toBeCloseTo(editorBounds!.height, 0);
  expect((await node.boundingBox())!.height).toBeCloseTo(nodeBounds!.height, 0);
  await configuration.getByRole('button', { name: '应用', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('inline-skill-preview.png'),
    animations: 'disabled',
  });
  await expect
    .poll(() => readPromptText(editor.getByRole('textbox', { name: '提示词', exact: true })))
    .not.toMatch(/优化后/);
  await page.keyboard.press('Escape');
  await expect(configuration).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-description', '优化预览待应用');
  await trigger.hover();
  await expect(configuration.getByRole('group', { name: '优化预览', exact: true })).toBeVisible();
  await configuration.getByRole('textbox', { name: '优化文字 1', exact: true }).click();
  await trigger.click();
  await expect(configuration).toBeHidden();
  await trigger.click();
  await expect(configuration.getByRole('group', { name: '优化预览', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(configuration).toBeHidden();
  await editor.getByRole('button', { name: '打开完整编辑器' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('group', { name: 'Skill 配置', exact: true })).toHaveCount(0);
  const dialogPreview = dialog.getByRole('group', { name: '优化预览', exact: true });
  await expect(dialogPreview).toBeVisible();
  const dialogHeight = await dialog.evaluate((element) => element.clientHeight);
  const dialogPreviewText = dialogPreview.getByRole('textbox', {
    name: '优化文字 1',
    exact: true,
  });
  await expect(dialogPreviewText).toBeEditable();
  await dialogPreviewText.fill('优化后：完整编辑器 ');
  await expect(dialogPreview).toHaveCount(1);
  await expect(dialog.locator('.node-quick-editor-dialog-body .prompt-skill-preview')).toHaveCount(
    1,
  );
  expect(await dialog.evaluate((element) => element.clientHeight)).toBe(dialogHeight);
  await dialogPreview.getByRole('button', { name: '应用', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('dialog-skill-preview.png'),
    animations: 'disabled',
  });
  await dialogPreview.getByRole('button', { name: '应用', exact: true }).click();
  await expect
    .poll(() => readPromptText(dialog.getByRole('textbox', { name: '提示词', exact: true })))
    .toMatch(/完整编辑器/);
  await expect(dialogPreview).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '关闭编辑器' }).click();
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => fixture.canvas().nodes[0]!.data.promptDocument?.blocks[0])
    .toEqual({ type: 'text', text: '优化后：完整编辑器 ' });
  expect(
    fixture
      .canvas()
      .nodes[0]!.data.promptDocument?.blocks.filter((block) => block.type === 'mention'),
  ).toEqual(source.blocks.filter((block) => block.type === 'mention'));
  expect(submissions).toBe(1);
  expect(fixture.errors).toEqual([]);
});

test('PC 连续添加参考、编号拖拽排序、搜索范围及保存重载', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const initial = initialCanvas();
  const target = initial.nodes[0]!;
  target.position = { x: 360, y: 430 };
  target.data.promptDocument = {
    version: 1,
    blocks: [{ type: 'text', text: '保持两张参考图的主体。' }],
  };
  target.data.mediaType = 'video';
  target.type = 'video';
  target.data.videoMode = 'omni_reference';
  target.data.modelAlias = 'mock-video';
  initial.nodes.push(
    ...[0, 1].map((index) => {
      const asset = assets[index + 1]!;
      return {
        id: `pick-${index + 1}`,
        type: 'image',
        width: 240,
        height: 150,
        position: { x: 80 + index * 700, y: 100 },
        data: {
          label: asset.name,
          mode: 'source' as const,
          mediaType: 'image' as const,
          assetId: asset.id,
          contentUrl: asset.contentUrl,
          mimeType: asset.mimeType,
          enabled: true,
        },
      };
    }),
  );
  const fixture = await installFixture(page, baseURL, initial);
  await page.goto(`/projects/${project.id}`);
  let { editor, node } = await openQuickEditor(page);
  const nodeBefore = await node.boundingBox();
  const pick = editor.getByRole('button', { name: '添加参考资料' });
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  const backdrop = page.locator('.node-reference-pick-backdrop');
  const banner = page.locator('.node-reference-pick-banner');
  await expect(backdrop).toBeVisible();
  await expect(backdrop).toHaveCSS('pointer-events', 'none');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('添加参考资料');

  const blank = await blankPanePoint(page);
  await page.mouse.click(blank.x, blank.y);
  const modeMessage = visibleMessage(page, '当前处于添加参考资料模式');
  await expect(modeMessage).toBeVisible();
  await expect(page.getByRole('button', { name: '继续添加资料', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '退出模式', exact: true })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('reference-pick-mode-guidance.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '继续添加资料', exact: true }).click();
  await expect(modeMessage).toBeHidden();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await expect(backdrop).toBeVisible();

  const viewport = page.locator('.react-flow__viewport');
  const transformBeforePan = await viewport.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  const paneBox = (await page.locator('.react-flow__pane').boundingBox())!;
  const panDelta = blank.x + 96 < paneBox.x + paneBox.width ? 80 : -80;
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.down();
  await page.mouse.move(blank.x + panDelta, blank.y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(() => viewport.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe(transformBeforePan);
  await expect(modeMessage).toBeHidden();

  for (const index of [1, 2, 1]) {
    await page
      .locator(`.react-flow__node[data-id="pick-${index}"]`)
      .click({ position: { x: index === 1 ? 40 : 200, y: 50 } });
    await expect(editor).toBeVisible();
    const successMessage = visibleMessage(page, '已添加参考资料');
    await expect(successMessage).toHaveCount(1);
    await expect(successMessage).toBeVisible();
  }
  await expect(editor.getByRole('article')).toHaveCount(2);
  await expect.poll(() => fixture.canvas().edges.length).toBe(2);
  await page.screenshot({
    path: test.info().outputPath('reference-pick-added.png'),
    animations: 'disabled',
  });
  const postAddBlank = await blankPanePoint(page);
  await page.mouse.click(postAddBlank.x, postAddBlank.y);
  await expect(modeMessage).toBeVisible();
  await expect(visibleMessage(page, '已添加参考资料')).toHaveCount(0);
  await page.getByRole('button', { name: '继续添加资料', exact: true }).click();
  await expect(modeMessage).toBeHidden();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  await expect(backdrop).toHaveCount(0);
  await expect(banner).toHaveCount(0);
  await expect(visibleMessage(page, '已添加参考资料')).toHaveCount(0);

  await pick.click();
  const exitBlank = await blankPanePoint(page);
  await page.mouse.click(exitBlank.x, exitBlank.y);
  await expect(modeMessage).toBeVisible();
  await page.getByRole('button', { name: '退出模式', exact: true }).click();
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  await expect(backdrop).toHaveCount(0);
  await expect(banner).toHaveCount(0);
  await expect(modeMessage).toBeHidden();
  const strip = editor.getByLabel('引用资源', { exact: true });
  const children = await strip.evaluate((element) =>
    Array.from(element.children)
      .filter((child) => child.tagName !== 'INPUT')
      .map((child) => child.getAttribute('aria-label')),
  );
  expect(children.slice(0, 3)).toEqual(['上传引用资源', '添加参考资料', '拍照引用']);
  expect(children[3]).toContain('参考资源 1：');
  expect(children[4]).toContain('参考资源 2：');
  const prompt = editor.getByRole('textbox', { name: '提示词' });
  const originalPrompt = await readPromptText(prompt);
  const originalDocument = fixture.canvas().nodes[0]!.data.promptDocument;
  const first = editor.getByRole('article').nth(0);
  const second = editor.getByRole('article').nth(1);
  await second.dragTo(first);
  await expect(editor.getByRole('article').nth(0)).toHaveAccessibleName('参考资源 1：场景参考图 2');
  await expect
    .poll(() => fixture.canvas().nodes[0]!.data.resourceRefs?.map((ref) => ref.assetId))
    .toEqual(['scene-image-2', 'scene-image-1']);
  expect(fixture.canvas().nodes[0]!.data.promptDocument).toEqual(originalDocument);
  await expect.poll(() => readPromptText(prompt)).toBe(originalPrompt);
  await page.screenshot({
    path: test.info().outputPath('reference-order.png'),
    animations: 'disabled',
  });
  const controls = editor.locator('.node-quick-editor-controls').last();
  const group = controls.locator('.node-quick-editor-run-group');
  const controlsBox = (await controls.boundingBox())!;
  const groupBox = (await group.boundingBox())!;
  expect(
    Math.abs(controlsBox.x + controlsBox.width - groupBox.x - groupBox.width),
  ).toBeLessThanOrEqual(2);

  await page.reload();
  ({ editor, node } = await openQuickEditor(page));
  await expect(editor.getByRole('article').nth(0)).toHaveAccessibleName('参考资源 1：场景参考图 2');
  expectSameNodeSize(nodeBefore!, (await node.boundingBox())!);
  const reloadedPrompt = editor.getByRole('textbox', { name: '提示词' });
  await reloadedPrompt.press('Control+End');
  await reloadedPrompt.pressSequentially(' @');
  const picker = page.locator('.resource-mention-picker');
  await expect(picker.getByRole('tab', { name: '节点资源', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(picker.getByRole('option')).toHaveCount(2);
  await picker.getByRole('tab', { name: '项目资源', exact: true }).click();
  await expect(picker.getByRole('option')).toHaveCount(10);
  await expect(picker.getByRole('navigation', { name: '项目资源分页' })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('reference-picker-combined.png'),
    animations: 'disabled',
  });
  expect(fixture.errors).toEqual([]);
  expect(
    fixture.apiRequests.filter(
      (request) => request.method === 'POST' && /runs|generations/.test(request.path),
    ),
  ).toEqual([]);
});

/** 按正文字符和每个缩略图一个位置设置浏览器选区，不模拟 textarea 属性。 */
async function selectReferenceText(input: Locator, start: number, end = start) {
  await input.evaluate(
    (element, selection) => {
      element.focus();
      if (element instanceof HTMLTextAreaElement) {
        element.setSelectionRange(selection.start, selection.end);
      } else {
        const locate = (position: number): [Node, number] => {
          let remaining = position;
          for (const child of element.childNodes) {
            if (child instanceof HTMLElement && child.hasAttribute('data-inline-reference')) {
              if (remaining <= 1)
                return [element, Array.from(element.childNodes).indexOf(child) + remaining];
              remaining -= 1;
            } else if (child.nodeType === Node.TEXT_NODE) {
              const length = child.textContent?.length ?? 0;
              if (remaining <= length) return [child, remaining];
              remaining -= length;
            }
          }
          return [element, element.childNodes.length];
        };
        const range = document.createRange();
        range.setStart(...locate(selection.start));
        range.setEnd(...locate(selection.end));
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    { start, end },
  );
}

for (const expanded of [false, true]) {
  test(`PC 引用解耦：${expanded ? '完整' : '快捷'}编辑器保留正文、复用缩略图和独立资料`, async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    const initial = initialCanvas();
    const target = initial.nodes[0]!;
    target.position = { x: 360, y: 430 };
    target.type = 'video';
    target.data.mediaType = 'video';
    target.data.videoMode = 'omni_reference';
    target.data.modelAlias = 'mock-video';
    target.data.promptDocument = { version: 1, blocks: [{ type: 'text', text: '让小明走进房间' }] };
    for (const index of [1, 2]) {
      const source = assets[index]!;
      initial.nodes.push({
        id: `decouple-${index}`,
        type: 'image',
        width: 240,
        height: 150,
        position: { x: 60 + (index - 1) * 700, y: 100 },
        data: {
          label: source.name,
          mode: 'source',
          mediaType: 'image',
          assetId: source.id,
          contentUrl: source.contentUrl,
          mimeType: source.mimeType,
          enabled: true,
        },
      });
    }
    const fixture = await installFixture(page, baseURL, initial);
    await page.goto(`/projects/${project.id}`);
    const { node, editor } = await openQuickEditor(page);
    const before = (await node.boundingBox())!;
    await editor.getByRole('button', { name: '添加参考资料' }).click();
    await expect(visibleMessage(page, '当前处于添加参考资料模式')).toBeVisible();
    for (const index of [1, 2, 1])
      await page
        .locator(`.react-flow__node[data-id="decouple-${index}"]`)
        .click({ position: { x: 30, y: 50 } });
    await page.keyboard.press('Escape');
    await expect(editor.getByRole('article')).toHaveCount(2);
    await expect(editor.getByRole('textbox', { name: '提示词' })).toHaveValue('让小明走进房间');
    const scope = expanded
      ? page.getByRole('dialog', { name: /· 编辑设置$/, exact: true })
      : editor;
    if (expanded) {
      await editor.getByRole('button', { name: '打开完整编辑器' }).click();
      await page.setViewportSize({ width: 1024, height: 1000 });
    }
    const input = scope.getByRole('textbox', { name: '提示词' });
    await selectReferenceText(input, 1, 3);
    let picker = page.locator('.resource-mention-picker');
    await picker.getByRole('option', { name: /场景参考图 2/ }).click();
    await expect(input).toHaveAttribute('contenteditable', 'true');
    await expect(input.locator('[data-inline-reference]')).toHaveCount(1);
    await expect(input.locator('[data-inline-reference] img')).toBeVisible();
    expect(await input.evaluate((element) => element.childNodes[0]?.textContent)).toBe('让小明');
    await expect(scope.getByRole('article').nth(0)).toHaveAccessibleName(
      '参考资源 1：场景参考图 1',
    );
    await expect(scope.getByRole('article').nth(1)).toHaveAccessibleName(
      '参考资源 2：场景参考图 2',
    );
    await selectReferenceText(input, 1, 3);
    await input.press('Backspace');
    await expect(input.locator('[data-inline-reference]')).toHaveCount(1);
    await expect(input).toHaveText('让走进房间');
    await selectReferenceText(input, 1, 2);
    await input.press('Backspace');
    await expect(input.locator('[data-inline-reference]')).toHaveCount(0);
    await expect(scope.getByRole('article')).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await input.press('Control+End');
      await input.pressSequentially(' @');
      picker = page.locator('.resource-mention-picker');
      await picker.getByRole('option', { name: /场景参考图 2/ }).click();
    }
    await expect(input.locator('[data-inline-reference]')).toHaveCount(2);
    await expect(scope.getByRole('article')).toHaveCount(2);
    await expect(input.locator('[data-inline-reference]').first()).toHaveAttribute(
      'aria-label',
      '引用 场景参考图 2',
    );
    await expect(input.locator('[data-inline-reference]').last()).toHaveAttribute(
      'aria-label',
      '引用 场景参考图 2',
    );
    await input.press('Control+z');
    await expect(input.locator('[data-inline-reference]')).toHaveCount(1);
    await input.press('Control+y');
    await expect(input.locator('[data-inline-reference]')).toHaveCount(2);
    await expect
      .poll(() =>
        fixture.canvas().nodes[0].data.resourceRefs?.map((reference) => reference.assetId),
      )
      .toEqual(['scene-image-1', 'scene-image-2']);
    await expect
      .poll(
        () =>
          fixture
            .canvas()
            .nodes[0].data.promptDocument?.blocks.filter((block) => block.type === 'mention')
            .length,
      )
      .toBe(2);
    await page.screenshot({
      path: test.info().outputPath('inline-reference-decoupled.png'),
      animations: 'disabled',
    });
    if (expanded) await page.keyboard.press('Escape');
    expectSameNodeSize(before, (await node.boundingBox())!);
    await page.reload();
    const restored = await openQuickEditor(page);
    await expect(restored.editor.getByRole('article')).toHaveCount(2);
    await expect(restored.editor.locator('[data-inline-reference]')).toHaveCount(2);
    await restored.editor.getByRole('button', { name: '删除 场景参考图 2', exact: true }).click();
    await expect(restored.editor.getByRole('article')).toHaveCount(1);
    await expect(restored.editor.locator('[data-inline-reference]')).toHaveCount(0);
    await expect(restored.editor.getByRole('textbox', { name: '提示词' })).toHaveText(
      '让走进房间  ',
    );
    expect(fixture.errors).toEqual([]);
    expect(
      fixture.apiRequests.filter(
        (request) => request.method === 'POST' && /runs|generations/.test(request.path),
      ),
    ).toEqual([]);
  });
}

test('PC 内联引用保留中文组合输入、换行和纯文本粘贴', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await installFixture(page, baseURL);
  await page.goto(`/projects/${project.id}`);
  const { editor } = await openQuickEditor(page);
  const input = editor.getByRole('textbox', { name: '提示词' });
  const original = await readPromptText(input);
  await input.press('Control+End');
  const session = await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition', {
    text: 'xiaoming',
    selectionStart: 8,
    selectionEnd: 8,
  });
  expect(fixture.canvas().nodes[0].data.promptDocument?.blocks).toEqual(
    initialCanvas().nodes[0].data.promptDocument?.blocks,
  );
  await session.send('Input.imeSetComposition', {
    text: '小明',
    selectionStart: 2,
    selectionEnd: 2,
  });
  await session.send('Input.insertText', { text: '小明' });
  await expect.poll(() => readPromptText(input)).toBe(original + '小明');
  await expect(input.locator('[data-inline-reference]')).toHaveCount(2);
  await input.press('Enter');
  await page.keyboard.insertText('走进房间');
  await expect.poll(() => readPromptText(input)).toBe(original + '小明\n走进房间');
  await input.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '粘贴\uFFFC');
    clipboardData.setData('text/html', '<img src=x onerror="window.__unsafePaste=true">');
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  });
  await expect.poll(() => readPromptText(input)).toBe(original + '小明\n走进房间粘贴');
  expect(await page.evaluate(() => '__unsafePaste' in window)).toBe(false);
  await expect(input.locator('[data-inline-reference]')).toHaveCount(2);
  await expect
    .poll(() => fixture.canvas().nodes[0].data.prompt)
    .toBe(original + '小明\n走进房间粘贴');
  await session.detach();
  await page.reload();
  await expect(page.getByRole('status', { name: '已从项目恢复', exact: true })).toBeVisible();
  const restored = await openQuickEditor(page);
  await expect
    .poll(() => readPromptText(restored.editor.getByRole('textbox', { name: '提示词' })))
    .toBe(original + '小明\n走进房间粘贴');
  await expect(restored.editor.locator('[data-inline-reference]')).toHaveCount(2);
  expect(fixture.errors).toEqual([]);
});

/** 零节点引用默认项目资源；空词只展示 10 项，关键词按真实匹配总数翻页。 */
test('零引用默认项目资源并跨越首页按服务端总数翻页', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const catalog = [
    assets[0]!,
    ...Array.from({ length: 64 }, (_, index) =>
      asset('paged-' + index, index === 63 ? '跨页隐藏参考图' : '分页参考图 ' + index, 'image'),
    ),
  ];
  const canvas = initialCanvas();
  canvas.nodes[0]!.data.promptDocument = {
    version: 1,
    blocks: [{ type: 'text', text: '从项目资源中寻找参考。' }],
  };
  const fixture = await installFixture(page, baseURL, canvas, catalog);
  await page.goto('/projects/' + project.id);
  const { editor } = await openQuickEditor(page);
  const prompt = editor.getByRole('textbox', { name: '提示词' });
  await prompt.press('Control+End');
  await prompt.pressSequentially(' @');
  const picker = page.locator('.resource-mention-picker');
  await expect(picker.getByRole('tab', { name: '项目资源', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(picker.getByRole('tab', { name: '节点资源', exact: true })).toHaveAttribute(
    'aria-selected',
    'false',
  );
  const searchbox = picker.getByRole('searchbox', { name: '搜索资源' });
  const pagination = picker.getByRole('navigation', { name: '项目资源分页' });
  const nextPage = picker.getByRole('button', { name: '下一页项目资源' });
  await expect(searchbox).toHaveValue('');
  await expect(picker.getByRole('option')).toHaveCount(10);
  const pickerBox = (await picker.boundingBox())!;
  const searchPanelBox = (await picker.locator('.resource-mention-search').boundingBox())!;
  expect(searchPanelBox.width).toBeCloseTo(pickerBox.width - 20, 0);
  expect(searchPanelBox.x + searchPanelBox.width / 2).toBeCloseTo(
    pickerBox.x + pickerBox.width / 2,
    0,
  );
  await expect(pagination).toHaveCount(0);
  await expect(nextPage).toHaveCount(0);
  await expect(picker.getByRole('option', { name: /跨页隐藏参考图/ })).toHaveCount(0);

  // 目录共 65 项，只有 64 项匹配“参考图”；分页总数必须来自筛选结果，不能沿用目录总数。
  await searchbox.fill('参考图');
  await expect(picker.getByRole('option')).toHaveCount(50);
  await expect(pagination).toContainText('1 / 2 · 共 64 项');
  await expect(picker.getByRole('option', { name: /产品图/ })).toHaveCount(0);
  await expect(picker.getByRole('option', { name: /跨页隐藏参考图/ })).toHaveCount(0);
  await expect(nextPage).toBeEnabled();
  await nextPage.click();
  await expect(picker.getByRole('option')).toHaveCount(14);
  await expect(pagination).toContainText('2 / 2 · 共 64 项');
  await expect(nextPage).toBeDisabled();
  await expect(picker.getByRole('option', { name: /跨页隐藏参考图/ })).toBeVisible();

  await searchbox.fill('跨页隐藏');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await expect(pagination).toContainText('1 / 1 · 共 1 项');
  await expect(picker.getByRole('button', { name: '上一页项目资源' })).toBeDisabled();
  await expect(nextPage).toBeDisabled();
  expect(fixture.assetQueries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        projectId: project.id,
        query: '参考图',
        page: '1',
        pageSize: '50',
        status: 'ready',
      }),
      expect.objectContaining({
        projectId: project.id,
        query: '参考图',
        page: '2',
        pageSize: '50',
        status: 'ready',
      }),
      expect.objectContaining({
        projectId: project.id,
        query: '跨页隐藏',
        page: '1',
        pageSize: '50',
        status: 'ready',
      }),
    ]),
  );
  await picker.getByRole('option', { name: /跨页隐藏参考图/ }).click();
  await expect(editor.getByRole('article', { name: /跨页隐藏参考图/ })).not.toHaveClass(
    /is-missing/,
  );
  await expect
    .poll(() =>
      fixture
        .canvas()
        .nodes[0]!.data.promptDocument?.blocks.some(
          (block) =>
            block.type === 'mention' && block.assetId === 'paged-63' && block.assetVersion === 1,
        ),
    )
    .toBe(true);
  expect(fixture.errors).toEqual([]);
  expect(
    fixture.apiRequests.filter(
      (item) => item.method === 'POST' && /runs|generations/.test(item.path),
    ),
  ).toEqual([]);
});

/** 使用可识别边缘的合成位图验证悬浮满框显示、冻结缩略图复用和节点尺寸不变。 */
for (const orientation of ['横图', '竖图'] as const) {
  test(`PC 引用预览复用缩略图，${orientation}完整适配悬浮卡片与完整编辑器`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const width = orientation === '横图' ? 480 : 270;
    const height = orientation === '横图' ? 270 : 480;
    const png = await page.evaluate(
      ({ width, height }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#224e69';
        context.fillRect(0, 0, width, height);
        context.fillStyle = '#ffd070';
        context.fillRect(0, 0, width, 24);
        context.fillStyle = '#5cdda6';
        context.fillRect(0, height - 24, width, 24);
        context.fillStyle = '#ffffff';
        context.font = '24px sans-serif';
        context.fillText(`${width} × ${height}`, 28, height / 2);
        return canvas.toDataURL('image/png').split(',')[1]!;
      },
      { width, height },
    );
    const fixture = await installFixture(page, baseURL);
    let thumbnailRequests = 0;
    await page.route(
      '**/v1/assets/product-image/versions/1/derivatives/thumbnail',
      async (route) => {
        thumbnailRequests++;
        await route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(png, 'base64'),
        });
      },
    );
    await page.goto('/projects/' + project.id);
    const { node, editor: quickEditor } = await openQuickEditor(page);
    const before = (await node.boundingBox())!;
    const originalDocument = fixture.canvas().nodes[0]!.data.promptDocument;
    for (const presentation of ['快捷', '完整'] as const) {
      if (presentation === '完整') {
        await quickEditor.getByRole('button', { name: '打开完整编辑器', exact: true }).click();
      }
      const editor =
        presentation === '完整'
          ? page.getByRole('dialog', { name: '资源引用节点 · 编辑设置', exact: true })
          : quickEditor;
      const prompt = editor.getByRole('textbox', { name: '提示词', exact: true });
      const inline = prompt.locator('[data-inline-reference]').first();
      await expect(inline.locator('img')).toHaveAttribute('src', /^blob:/);
      await inline.hover();
      const hover = page.getByRole('region', { name: '预览 产品图', exact: true });
      await expect(hover).toBeVisible();
      const preview = hover.locator('img');
      await expect
        .poll(() => preview.evaluate((element) => (element as HTMLImageElement).naturalWidth))
        .toBe(width);
      await expect.poll(async () => (await preview.boundingBox())?.width ?? 0).toBeGreaterThan(240);
      const geometry = await preview.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const container = element
          .closest('.resource-mention-hover-content')!
          .getBoundingClientRect();
        return {
          width: bounds.width,
          height: bounds.height,
          containerWidth: container.width,
          containerHeight: container.height,
          objectFit: getComputedStyle(element).objectFit,
        };
      });
      expect(geometry.width).toBeGreaterThan(240);
      expect(geometry.height).toBeGreaterThan(175);
      expect(geometry.width / geometry.containerWidth).toBeGreaterThan(0.9);
      expect(geometry.height / geometry.containerHeight).toBeGreaterThan(0.9);
      expect(geometry.width).toBeLessThanOrEqual(geometry.containerWidth);
      expect(geometry.height).toBeLessThanOrEqual(geometry.containerHeight);
      expect(geometry.objectFit).toBe('contain');
      expect(thumbnailRequests).toBe(1);
      expect(fixture.assetAccesses.filter((entry) => entry.assetId === 'product-image')).toEqual(
        [],
      );
      await page.screenshot({
        path: testInfo.outputPath(`${orientation}-${presentation}.png`),
        animations: 'disabled',
      });
      await page.mouse.move(8, 8);
      await expect(hover).toBeHidden();
      await inline.hover();
      await expect(hover.locator('img')).toHaveAttribute(
        'src',
        (await inline.locator('img').getAttribute('src'))!,
      );
      expect(thumbnailRequests).toBe(1);
      expectSameNodeSize(before, (await node.boundingBox())!);
      await page.mouse.move(8, 8);
      await expect(hover).toBeHidden();
    }
    const fullEditor = page.getByRole('dialog', { name: '资源引用节点 · 编辑设置', exact: true });
    await fullEditor.getByRole('button', { name: '预览并命名 产品图', exact: true }).click();
    const details = page.getByRole('dialog', { name: '资源预览', exact: true });
    await expect(details.locator('img')).toHaveAttribute('src', /\/versions\/1\/content$/);
    await expect
      .poll(() =>
        details.locator('img').evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBe(960);
    await details.locator('img').click();
    const viewer = page.getByRole('dialog', { name: '产品图', exact: true });
    await expect(viewer).toBeVisible();
    const download = page.waitForEvent('download');
    await viewer.getByRole('button', { name: '下载原文件', exact: true }).click();
    expect(readFileSync((await (await download).path())!)).toEqual(poster);
    expect(
      fixture.assetAccesses
        .filter((entry) => entry.assetId === 'product-image')
        .every((entry) => entry.version === 1),
    ).toBe(true);
    expect(fixture.canvas().nodes[0]!.data.promptDocument).toEqual(originalDocument);
    expect(fixture.errors).toEqual([]);
    expect(
      fixture.apiRequests.filter(
        (request) => request.method === 'POST' && /runs|generations/.test(request.path),
      ),
    ).toEqual([]);
  });
}

/** 目录外冻结身份虽可解析版本地址，但没有 MIME；预览入口必须降级图标而非让整页崩溃。 */
test('PC 目录外冻结引用的光标预览与卡片详情降级图标，节点检索保留 v4', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const frozenMention = {
    type: 'mention',
    mentionId: 'catalog-missing-v4',
    assetId: 'catalog-missing-frozen',
    assetVersion: 4,
    label: '目录外旧版主角',
    mediaType: 'image',
  } as const;
  const canvas = initialCanvas();
  canvas.nodes[0]!.data.promptDocument = {
    version: 1,
    blocks: [{ type: 'text', text: '开场 ' }, frozenMention, { type: 'text', text: ' 收尾' }],
  };
  const catalog = [assets[0]!];
  expect(catalog.some((item) => item.id === frozenMention.assetId)).toBe(false);
  const fixture = await installFixture(page, baseURL, canvas, catalog);
  await page.goto('/projects/' + project.id);
  const { editor, node } = await openQuickEditor(page);
  const prompt = editor.getByRole('textbox', { name: '提示词' });
  const originalPrompt = `开场 ${frozenMention.label} 收尾`;
  await expect.poll(() => readPromptText(prompt)).toBe(originalPrompt);
  const card = editor.getByRole('article', { name: `参考资源 1：${frozenMention.label}` });
  await expect(card).toBeVisible();
  await expect(card).not.toHaveClass(/is-missing/);

  // 未加载的冻结资源也常显占位图标，Hover 只负责扩展预览。
  const inline = prompt.locator('[data-inline-reference]');
  await expect(inline.locator('.resource-mention-media-icon.is-image')).toBeVisible();
  await inline.hover();
  const hover = page.getByRole('region', { name: `预览 ${frozenMention.label}`, exact: true });
  await expect(hover).toBeVisible();
  await expect(hover.locator('.resource-mention-media-icon.is-image')).toBeVisible();
  await expect(hover.locator('img, video, audio')).toHaveCount(0);
  await expect.poll(() => readPromptText(prompt)).toBe(originalPrompt);
  await expect(node).toBeVisible();
  expect(fixture.errors).toEqual([]);

  await card.getByRole('button', { name: `预览并命名 ${frozenMention.label}` }).click();
  const dialog = page.getByRole('dialog', { name: '资源预览', exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator('.resource-mention-dialog-preview .resource-mention-media-icon.is-image'),
  ).toBeVisible();
  await expect(
    dialog.locator('.resource-mention-dialog-preview').locator('img, video, audio'),
  ).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: '资源名称' })).toHaveValue(frozenMention.label);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => readPromptText(prompt)).toBe(originalPrompt);
  expect(fixture.canvas().nodes[0]!.data.promptDocument).toEqual(
    canvas.nodes[0]!.data.promptDocument,
  );
  expect(fixture.errors).toEqual([]);

  await prompt.press('Control+End');
  await prompt.pressSequentially(' @');
  const picker = page.locator('.resource-mention-picker');
  await expect(picker.getByRole('tab', { name: '节点资源', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await picker.getByRole('searchbox', { name: '搜索资源' }).fill(frozenMention.label);
  await expect(picker.getByRole('option')).toHaveCount(1);
  const option = picker.getByRole('option', { name: /目录外旧版主角.*v4/ });
  await expect(option).toBeEnabled();
  await expect(option.locator('.resource-mention-media-icon.is-image')).toBeVisible();
  await expect(option.locator('img, video, audio')).toHaveCount(0);
  expect(fixture.assetQueries.some((query) => query.query === frozenMention.label)).toBe(false);
  await option.click();
  await expect(picker).toHaveCount(0);
  // 再次插入复用名称，下面另验资源身份和冻结版本没有变化。
  await expect.poll(() => readPromptText(prompt)).toBe(`${originalPrompt} `);
  await expect
    .poll(() =>
      fixture
        .canvas()
        .nodes[0]!.data.promptDocument?.blocks.filter(
          (block) => block.type === 'mention' && block.assetId === frozenMention.assetId,
        )
        .map((block) => block.type === 'mention' && block.assetVersion),
    )
    .toEqual([4, 4]);
  await expect(editor).toBeVisible();
  await expect(card).not.toHaveClass(/is-missing/);
  expect(fixture.errors).toEqual([]);
  expect(
    fixture.apiRequests.filter((request) =>
      request.path.startsWith(`/v1/assets/${frozenMention.assetId}/`),
    ),
  ).toEqual([]);
  expect(
    fixture.apiRequests.filter(
      (request) => request.method === 'POST' && /runs|generations/.test(request.path),
    ),
  ).toEqual([]);
});

/** 构造单一目标和可见来源；文字/音频使用文本输入，其余节点使用图片输入。 */
function referenceCameraCanvas(
  mediaType: Asset['mediaType'],
  mode: 'generate' | 'source' = 'generate',
) {
  const canvas = initialCanvas();
  const target = canvas.nodes[0]!;
  target.type = mediaType;
  target.position = { x: 360, y: 430 };
  target.data = {
    label: '资源引用节点',
    mediaType,
    mode,
    enabled: true,
    modelAlias: 'mock-' + mediaType,
    promptDocument: { version: 1, blocks: [{ type: 'text', text: '保留原始提示词。' }] },
    ...(mediaType === 'video' ? { videoMode: 'omni_reference' as const } : {}),
    ...(mode === 'source'
      ? { assetId: assets[0]!.id, contentUrl: assets[0]!.contentUrl, mimeType: assets[0]!.mimeType }
      : {}),
  };
  const reference = assets.find(
    (item) =>
      item.id === (['text', 'audio'].includes(mediaType) ? 'interview-script' : 'scene-image-1'),
  )!;
  canvas.nodes.push({
    id: 'reference-camera-source',
    type: reference.mediaType,
    position: { x: 80, y: 100 },
    width: 240,
    height: 150,
    data: {
      label: reference.name,
      mediaType: reference.mediaType,
      mode: 'source',
      enabled: true,
      assetId: reference.id,
      contentUrl: reference.contentUrl,
      mimeType: reference.mimeType,
    },
  });
  return { canvas: canvasDocumentSchema.parse(canvas), reference };
}

/** 从边框选择目标，避免 source 预览内的播放器、重命名和全屏按钮。 */
async function openReferenceCameraEditor(page: Page) {
  const node = page.locator('.react-flow__node[data-id="resource-mention-node"]');
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ position: { x: 10, y: 10 } });
  const editor = page.locator('.node-quick-editor');
  await expect(editor).toBeVisible();
  return { node, editor };
}

/** 获取当前页面合成相机的可序列化审计；重载前必须先检查轨道已释放。 */
async function readReferenceCamera(page: Page): Promise<ReferenceCameraAudit> {
  return page.evaluate(
    () =>
      (window as Window & { __referenceCameraAudit: ReferenceCameraAudit }).__referenceCameraAudit,
  );
}

/** 引用入口仅呈现图标，宽高与上传入口一致，且不会越出编辑器。 */
async function expectReferenceIconButtons(editor: Locator) {
  const upload = editor.getByRole('button', { name: '上传引用资源', exact: true });
  const uploadSize = await upload.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: parseFloat(style.width), height: parseFloat(style.height) };
  });
  for (const name of ['添加参考资料', '拍照引用']) {
    const button = editor.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('');
    await expect(button.locator('svg')).toHaveCount(1);
    const size = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: parseFloat(style.width), height: parseFloat(style.height) };
    });
    expect(size).toEqual(uploadSize);
    await expect
      .poll(async () => {
        const [box, editorBox] = await Promise.all([button.boundingBox(), editor.boundingBox()]);
        return Boolean(
          box &&
          editorBox &&
          box.x >= editorBox.x &&
          box.x + box.width <= editorBox.x + editorBox.width,
        );
      })
      .toBe(true);
  }
}

/** 通过真实画布点选资料，并等待结构化引用保存；不触发生成。 */
async function pickReferenceCameraSource(
  page: Page,
  editor: Locator,
  fixture: Awaited<ReturnType<typeof installFixture>>,
  reference: Asset,
) {
  const pick = editor.getByRole('button', { name: '添加参考资料', exact: true });
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await page
    .locator('.react-flow__node[data-id="reference-camera-source"]')
    .click({ position: { x: 40, y: 50 } });
  await expect(
    editor.getByRole('article', { name: '参考资源 1：' + reference.name, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => fixture.canvas().nodes[0]!.data.resourceRefs)
    .toEqual([
      expect.objectContaining({
        assetId: reference.id,
        assetVersion: 1,
        mediaType: reference.mediaType,
      }),
    ]);
  await page.keyboard.press('Escape');
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  await expect(editor).toBeVisible();
}

/** 必须等合成帧真正进入 video 后才拍摄，防止只有假权限、没有有效视频帧的测试通过。 */
async function openSyntheticReferenceCamera(page: Page, editor: Locator) {
  await editor.getByRole('button', { name: '拍照引用', exact: true }).click();
  const camera = page.getByRole('dialog', { name: '拍照', exact: true });
  await expect(camera).toBeVisible();
  await expect(camera.getByRole('button', { name: '拍照', exact: true })).toBeEnabled();
  await expect
    .poll(() =>
      camera.locator('video').evaluate((element) => {
        const video = element as HTMLVideoElement;
        return { ready: video.readyState >= 2, width: video.videoWidth, height: video.videoHeight };
      }),
    )
    .toEqual({ ready: true, width: 640, height: 480 });
  return camera;
}

/** 真实执行拍照、重拍和确认上传，核对三阶段字节与有效图片解码，并检查相机关闭后停止所有轨道。 */
async function useSyntheticReferencePhoto(
  page: Page,
  editor: Locator,
  fixture: Awaited<ReturnType<typeof installFixture>>,
  screenshotName: string,
) {
  const originalRefs = fixture.canvas().nodes[0]!.data.resourceRefs;
  const camera = await openSyntheticReferenceCamera(page, editor);
  await page.screenshot({
    path: test.info().outputPath(screenshotName + '-camera-live.png'),
    animations: 'disabled',
  });
  await camera.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(camera.getByRole('button', { name: '使用照片', exact: true })).toBeEnabled();
  expect(fixture.uploads).toEqual([]);
  await expect
    .poll(async () =>
      (await readReferenceCamera(page)).tracks.every(
        (track) => track.stops > 0 && track.readyState === 'ended',
      ),
    )
    .toBe(true);
  await camera.getByRole('button', { name: '重拍', exact: true }).click();
  await expect(camera.getByRole('button', { name: '拍照', exact: true })).toBeEnabled();
  await expect
    .poll(() =>
      camera.locator('video').evaluate((element) => (element as HTMLVideoElement).readyState >= 2),
    )
    .toBe(true);
  await camera.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(camera.getByRole('button', { name: '使用照片', exact: true })).toBeEnabled();
  expect(fixture.uploads).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath(screenshotName + '-camera-review.png'),
    animations: 'disabled',
  });
  await camera.getByRole('button', { name: '使用照片', exact: true }).click();
  await expect(camera).toBeHidden();
  await expect
    .poll(() => fixture.uploads.map((upload) => upload.stages))
    .toEqual([['init', 'PUT', 'complete']]);
  const upload = fixture.uploads[0]!;
  expect((await readReferenceCamera(page)).requests.length).toBeGreaterThanOrEqual(2);
  expect(upload.metadata.name).toMatch(/^camera-[0-9]+[.](jpg|png)$/);
  expect(upload.bytes!.byteLength).toBeGreaterThan(1000);
  const dimensions = await page.evaluate(
    async ({ bytes, mimeType }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mimeType }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const center = Array.from(context.getImageData(320, 240, 1, 1).data);
      const marker = Array.from(context.getImageData(320, 410, 1, 1).data);
      const result = { width: bitmap.width, height: bitmap.height, center, marker };
      bitmap.close();
      return result;
    },
    { bytes: Array.from(upload.bytes!), mimeType: upload.metadata.mimeType },
  );
  expect(dimensions.width).toBe(640);
  expect(dimensions.height).toBe(480);
  expect(dimensions.center[0]).toBeLessThan(40);
  expect(dimensions.center[2]).toBeGreaterThan(100);
  expect(dimensions.marker[0]).toBeGreaterThan(200);
  await expect
    .poll(async () =>
      (await readReferenceCamera(page)).tracks.every(
        (track) => track.readyState === 'ended' && track.stops > 0,
      ),
    )
    .toBe(true);
  await expect
    .poll(() => fixture.canvas().nodes[0]!.data.promptDocument?.blocks)
    .toContainEqual(
      expect.objectContaining({
        type: 'mention',
        assetId: upload.asset!.id,
        assetVersion: 1,
        mediaType: 'image',
      }),
    );
  await expect(
    editor
      .locator(`[role="article"][data-resource-key='${JSON.stringify([upload.asset!.id, 1])}']`)
      .locator('img'),
  ).toBeVisible();
  expect(fixture.canvas().nodes[0]!.data.resourceRefs).toEqual([
    ...(originalRefs ?? []),
    expect.objectContaining({ assetId: upload.asset!.id, assetVersion: 1, attached: true }),
  ]);
  return upload.asset!;
}

/** 每项验收都保留请求/相机审计，并拒绝未声明网络、控制台异常和任何生成请求。 */
async function expectReferenceCameraIsolation(
  page: Page,
  fixture: Awaited<ReturnType<typeof installFixture>>,
) {
  const camera = await readReferenceCamera(page);
  await test.info().attach('reference-camera-audit', {
    body: JSON.stringify(
      {
        errors: fixture.errors,
        requests: fixture.apiRequests,
        assetAccesses: fixture.assetAccesses,
        uploads: fixture.uploads.map(({ uploadId, metadata, stages }) => ({
          uploadId,
          metadata,
          stages,
        })),
        camera,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  expect(fixture.errors).toEqual([]);
  expect(
    fixture.apiRequests.filter(
      (request) =>
        request.method === 'POST' &&
        !request.path.endsWith('/access-url') &&
        !['/v1/assets/uploads/init', '/v1/assets/uploads/complete'].includes(request.path),
    ),
  ).toEqual([]);
  for (const request of camera.requests) {
    expect(request.audio).toBe(false);
    expect(request.video).toBeTruthy();
  }
  for (const track of camera.tracks) {
    expect(track.kind).toBe('video');
    expect(track.stops).toBeGreaterThan(0);
    expect(track.readyState).toBe('ended');
  }
}

for (const mediaType of ['text', 'image', 'audio', 'video'] as const) {
  test(
    'PC 参考资料与拍照隔离：' + mediaType + ' 节点添加资料、重拍并上传版本化引用',
    async ({ page, baseURL }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      const { canvas, reference } = referenceCameraCanvas(mediaType);
      const fixture = await installFixture(page, baseURL, canvas);
      await page.goto('/projects/' + project.id);
      const { node, editor } = await openReferenceCameraEditor(page);
      const before = (await node.boundingBox())!;
      expect((await readReferenceCamera(page)).requests).toEqual([]);
      await expectReferenceIconButtons(editor);
      await pickReferenceCameraSource(page, editor, fixture, reference);
      await expect
        .poll(() => fixture.canvas().edges)
        .toEqual([
          expect.objectContaining({
            sourceNodeId: 'reference-camera-source',
            targetNodeId: 'resource-mention-node',
          }),
        ]);
      expect((await readReferenceCamera(page)).requests).toEqual([]);
      const photo = await useSyntheticReferencePhoto(page, editor, fixture, mediaType);
      const persisted = fixture.canvas();
      expect(persisted.nodes).toHaveLength(2);
      expect(persisted.edges).toHaveLength(1);
      expect(persisted.nodes[1]).toEqual(canvas.nodes[1]);
      expect(persisted.nodes[0]!.data.mediaType).toBe(mediaType);
      expect(persisted.nodes[0]!.data.mode).toBe('generate');
      expect(persisted.nodes[0]!.data.promptDocument!.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'mention', assetId: photo.id, assetVersion: 1 }),
        ]),
      );
      expect(persisted.nodes[0]!.data.resourceRefs).toEqual([
        expect.objectContaining({ assetId: reference.id, assetVersion: 1, attached: true }),
        expect.objectContaining({ assetId: photo.id, assetVersion: 1, attached: true }),
      ]);
      expect(
        persisted.nodes[0]!.data.promptDocument!.blocks.some(
          (block) => block.type === 'mention' && block.assetId === reference.id,
        ),
      ).toBe(false);
      expectSameNodeSize(before, (await node.boundingBox())!);
      await expectReferenceIconButtons(editor);
      await page.screenshot({
        path: test.info().outputPath(mediaType + '-reference-icons.png'),
        animations: 'disabled',
      });
      await expectReferenceCameraIsolation(page, fixture);
    },
  );
}

test('PC 参考资料与拍照隔离：source 节点引用和拍照不连边、不替换原素材', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { canvas, reference } = referenceCameraCanvas('image', 'source');
  const fixture = await installFixture(page, baseURL, canvas);
  await page.goto('/projects/' + project.id);
  const { node, editor } = await openReferenceCameraEditor(page);
  const before = (await node.boundingBox())!;
  await expect
    .poll(() =>
      node
        .locator('img')
        .first()
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const originalPreview = await node.locator('img').first().getAttribute('src');
  await expectReferenceIconButtons(editor);
  await pickReferenceCameraSource(page, editor, fixture, reference);
  expect(fixture.canvas().edges).toEqual([]);
  await useSyntheticReferencePhoto(page, editor, fixture, 'source');
  const saved = fixture.canvas();
  expect(saved.edges).toEqual([]);
  expect(saved.nodes).toHaveLength(2);
  expect(saved.nodes[1]).toEqual(canvas.nodes[1]);
  expect(saved.nodes[0]!.data).toMatchObject({
    mode: 'source',
    mediaType: 'image',
    assetId: canvas.nodes[0]!.data.assetId,
    contentUrl: canvas.nodes[0]!.data.contentUrl,
    mimeType: canvas.nodes[0]!.data.mimeType,
  });
  expect(saved.nodes[0]!.data.resultAsset).toBeUndefined();
  expect(saved.nodes[0]!.data.resourceRefs).toEqual([
    expect.objectContaining({ assetId: reference.id, assetVersion: 1 }),
    expect.objectContaining({
      assetId: fixture.uploads[0]!.asset!.id,
      assetVersion: 1,
      attached: true,
    }),
  ]);
  await expect(node.locator('.react-flow__handle-target')).toHaveCount(0);
  await expect(node.locator('img').first()).toHaveAttribute('src', originalPreview!);
  expectSameNodeSize(before, (await node.boundingBox())!);
  await page.screenshot({
    path: test.info().outputPath('source-preserved.png'),
    animations: 'disabled',
  });
  await expectReferenceCameraIsolation(page, fixture);
});

test('PC 参考资料与拍照隔离：完整编辑器嵌套相机 Escape 只关前层并释放轨道', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { canvas } = referenceCameraCanvas('image');
  const fixture = await installFixture(page, baseURL, canvas);
  await page.goto('/projects/' + project.id);
  const { node, editor } = await openReferenceCameraEditor(page);
  const before = (await node.boundingBox())!;
  await editor.getByRole('button', { name: '打开完整编辑器', exact: true }).click();
  const fullEditor = page.getByRole('dialog', { name: '资源引用节点 · 编辑设置', exact: true });
  await expect(fullEditor).toBeVisible();
  await expectReferenceIconButtons(fullEditor);
  const prompt = fullEditor.getByRole('textbox', { name: '提示词', exact: true });
  const originalPrompt = await readPromptText(prompt);
  expect((await readReferenceCamera(page)).requests).toEqual([]);
  const camera = await openSyntheticReferenceCamera(page, fullEditor);
  await page.screenshot({
    path: test.info().outputPath('full-editor-nested-camera.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(camera).toBeHidden();
  await expect(fullEditor).toBeVisible();
  await expect.poll(() => readPromptText(prompt)).toBe(originalPrompt);
  expect(fixture.uploads).toEqual([]);
  await expect
    .poll(async () =>
      (await readReferenceCamera(page)).tracks.every(
        (track) => track.stops > 0 && track.readyState === 'ended',
      ),
    )
    .toBe(true);
  // 再次开启并确认使用，证明 Escape 后后方编辑器仍可正常接收照片。
  await useSyntheticReferencePhoto(page, fullEditor, fixture, 'full-editor-reopen');
  await expect(fullEditor).toBeVisible();
  expectSameNodeSize(before, (await node.boundingBox())!);
  await expectReferenceCameraIsolation(page, fixture);
});

test('PC 参考资料与拍照隔离：照片保存重载后保留资产版本且不重复上传或开启相机', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { canvas } = referenceCameraCanvas('image');
  const fixture = await installFixture(page, baseURL, canvas);
  await page.goto('/projects/' + project.id);
  let { node, editor } = await openReferenceCameraEditor(page);
  const before = (await node.boundingBox())!;
  const photo = await useSyntheticReferencePhoto(page, editor, fixture, 'reload');
  const saved = fixture.canvas();
  const savedDocument = saved.nodes[0]!.data.promptDocument;
  const savedRefs = saved.nodes[0]!.data.resourceRefs;
  await expect
    .poll(() => fixture.assetAccesses.filter((item) => item.assetId === photo.id))
    .not.toHaveLength(0);
  expect(
    fixture.assetAccesses
      .filter((item) => item.assetId === photo.id)
      .every((item) => item.version === 1),
  ).toBe(true);
  await expectReferenceCameraIsolation(page, fixture);
  const accessCount = fixture.assetAccesses.filter((item) => item.assetId === photo.id).length;
  await page.reload();
  ({ node, editor } = await openReferenceCameraEditor(page));
  const card = editor.locator(
    `[role="article"][data-resource-key='${JSON.stringify([photo.id, 1])}']`,
  );
  await expect(card).toBeVisible();
  const preview = card.locator('img');
  await expect
    .poll(() =>
      preview.evaluate((element) => ({
        loaded: (element as HTMLImageElement).complete,
        width: (element as HTMLImageElement).naturalWidth,
      })),
    )
    .toEqual({ loaded: true, width: 640 });
  await expect
    .poll(() => fixture.assetAccesses.filter((item) => item.assetId === photo.id).length)
    .toBeGreaterThan(accessCount);
  expect(fixture.canvas().nodes[0]!.data.promptDocument).toEqual(savedDocument);
  expect(fixture.canvas().nodes[0]!.data.resourceRefs).toEqual(savedRefs);
  expect(fixture.canvas().edges).toEqual([]);
  expect(fixture.canvas().nodes).toHaveLength(2);
  expect(fixture.uploads.map((upload) => upload.stages)).toEqual([['init', 'PUT', 'complete']]);
  expect((await readReferenceCamera(page)).requests).toEqual([]);
  expectSameNodeSize(before, (await node.boundingBox())!);
  await expectReferenceIconButtons(editor);
  await page.screenshot({
    path: test.info().outputPath('photo-reference-reloaded.png'),
    animations: 'disabled',
  });
  await expectReferenceCameraIsolation(page, fixture);
});

for (const presentation of ['快捷', '完整'] as const) {
  test('PC ' + presentation + '编辑器三个引用按钮只响应自身点击', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { canvas } = referenceCameraCanvas('image');
    const fixture = await installFixture(page, baseURL, canvas);
    let fileChooserCount = 0;
    page.on('filechooser', () => {
      fileChooserCount += 1;
    });
    await page.goto('/projects/' + project.id);
    const { node, editor: quickEditor } = await openReferenceCameraEditor(page);
    const before = (await node.boundingBox())!;
    if (presentation === '完整') {
      await quickEditor.getByRole('button', { name: '打开完整编辑器', exact: true }).click();
    }
    const editor =
      presentation === '完整'
        ? page.getByRole('dialog', { name: '资源引用节点 · 编辑设置', exact: true })
        : quickEditor;
    await expect(editor).toBeVisible();
    const prompt = editor.getByRole('textbox', { name: '提示词', exact: true });
    const originalPrompt = await readPromptText(prompt);
    const strip = editor.locator('.resource-mention-strip');
    const buttons = ['上传引用资源', '添加参考资料', '拍照引用'].map((name) =>
      editor.getByRole('button', { name, exact: true }),
    );
    await expectReferenceIconButtons(editor);
    const boxes = await Promise.all(buttons.map((button) => button.boundingBox()));
    const stripBox = (await strip.boundingBox())!;
    // 真实坐标覆盖两个按钮间隙和整行尾部，不依赖 label/DOM 结构断言。
    const points = [
      {
        x: (boxes[0]!.x + boxes[0]!.width + boxes[1]!.x) / 2,
        y: boxes[0]!.y + boxes[0]!.height / 2,
      },
      {
        x: (boxes[1]!.x + boxes[1]!.width + boxes[2]!.x) / 2,
        y: boxes[1]!.y + boxes[1]!.height / 2,
      },
      { x: stripBox.x + stripBox.width - 4, y: stripBox.y + stripBox.height / 2 },
    ];
    for (const point of points) {
      expect(
        await page.evaluate(({ x, y }) => {
          const target = document.elementFromPoint(x, y);
          return Boolean(target?.closest('.resource-mention-strip') && !target.closest('button'));
        }, point),
      ).toBe(true);
      await page.mouse.click(point.x, point.y);
      await expect(editor).toBeVisible();
      await expect(buttons[1]!).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByRole('dialog', { name: '拍照', exact: true })).toBeHidden();
    }
    expect(fileChooserCount).toBe(0);
    expect((await readReferenceCamera(page)).requests).toEqual([]);
    await expect.poll(() => readPromptText(prompt)).toBe(originalPrompt);
    await page.screenshot({
      path: test.info().outputPath('reference-buttons-hitbox.png'),
      animations: 'disabled',
    });

    await buttons[0]!.click();
    await expect.poll(() => fileChooserCount).toBe(1);
    await expect(buttons[1]!).toHaveAttribute('aria-pressed', 'false');
    expect((await readReferenceCamera(page)).requests).toEqual([]);
    const camera = await openSyntheticReferenceCamera(page, editor);
    expect(fileChooserCount).toBe(1);
    await camera.getByRole('button', { name: '关闭拍照', exact: true }).click();
    await expect(camera).toBeHidden();
    await expect(editor).toBeVisible();
    await expect(buttons[1]!).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(async () => (await readReferenceCamera(page)).tracks.every((track) => track.stops > 0))
      .toBe(true);
    const cameraRequests = (await readReferenceCamera(page)).requests.length;
    await buttons[1]!.click();
    // 完整编辑器进入画布点选时按原契约收起，快捷编辑器显示已激活状态。
    await expect(
      quickEditor.getByRole('button', { name: '添加参考资料', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(fileChooserCount).toBe(1);
    expect((await readReferenceCamera(page)).requests).toHaveLength(cameraRequests);
    await page.keyboard.press('Escape');
    expect(fixture.uploads).toEqual([]);
    expectSameNodeSize(before, (await node.boundingBox())!);
    await expectReferenceCameraIsolation(page, fixture);
  });
}
