import { createHash, randomBytes } from 'node:crypto';
import { expect, type Download, type Locator, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { CanvasDocument } from '@multimodal-canvas/domain';

/** 固定 PC 场景：41 节点中的 36 张图片与 46 个资源卡片共享同一批资产。 */
export const scenario = { nodes: 41, imageNodes: 36, sidebarImages: 46, width: 1920, height: 1080 };
/** 每个浏览器上下文只使用这个不存在于真实服务的合成项目。 */
export const project = {
  id: 'image-thumbnail-cache-isolated',
  name: '缩略图隔离验收',
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};
/** 两版图像的原始字节及缩略字节；不包含外部素材。 */
export type ImageSet = { original: Buffer; thumbnail: Buffer }[];
/** 只记录路由与认证是否存在，不输出会话值。 */
export type MediaRequest = {
  kind: 'original' | 'thumbnail' | 'sign';
  assetId: string;
  version: number;
  path: string;
  bearer: boolean;
  cookie: boolean;
};
/** 浏览器探针只保存可量化的图片状态，尺寸单位为自然像素。 */
export type ImageProbe = { src: string; width: number; height: number; complete: boolean };

/** 返回可复现的 SHA-256，供图像及两种下载路径的字节一致性检查。 */
export function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}
/** 资产编号固定宽度，避免字符串排序改变同场景布局。 */
export function assetId(index: number) {
  return `image-thumb-${String(index).padStart(3, '0')}`;
}
/** 文件名取服务端原文件名，而非缩略图或浏览器 Blob 名称。 */
export function filename(id: string, version: number) {
  return `原始-${id}-v${version}-3840x2160.png`;
}
/** 最后两张使用原始 /content；一张携带 latestVersion，一张覆盖真正无版本旧资产。 */
export function contentUrl(index: number, version = 1) {
  return `/v1/assets/${assetId(index)}${index >= 44 ? '' : `/versions/${version}`}/content`;
}
/** 从空白页 Canvas 合成 4K 网格图及其 640x360 缩略图；版本颜色不同。 */
export async function createImages(page: Page): Promise<ImageSet> {
  const encoded = await page.evaluate(() =>
    [1, 2].map((version) => {
      const original = document.createElement('canvas');
      original.width = 3840;
      original.height = 2160;
      const ctx = original.getContext('2d');
      if (!ctx) throw new Error('浏览器缺少 Canvas 2D 支持');
      for (let y = 0; y < 2160; y += 24)
        for (let x = 0; x < 3840; x += 24) {
          const seed = (x * 37 + y * 73 + version * 109) % 360;
          ctx.fillStyle = `hsl(${seed} 65% 45%)`;
          ctx.fillRect(x, y, 24, 24);
        }
      ctx.fillStyle = version === 1 ? '#f4ad4b' : '#386de8';
      ctx.fillRect(1440, 780, 960, 600);
      ctx.fillStyle = '#ffffff';
      ctx.font = '120px sans-serif';
      ctx.fillText(`Synthetic v${version} 3840x2160`, 120, 240);
      const thumb = document.createElement('canvas');
      thumb.width = 640;
      thumb.height = 360;
      const small = thumb.getContext('2d');
      if (!small) throw new Error('浏览器缺少缩略 Canvas 支持');
      small.drawImage(original, 0, 0, 640, 360);
      return {
        original: original.toDataURL('image/png').split(',')[1]!,
        thumbnail: thumb.toDataURL('image/jpeg', 0.85).split(',')[1]!,
      };
    }),
  );
  return encoded.map((image) => ({
    original: Buffer.from(image.original, 'base64'),
    thumbnail: Buffer.from(image.thumbnail, 'base64'),
  }));
}
/** 对 JSON 合同执行路由响应，不连接真实 API。 */
async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}
/** 创建纯内存画布；图片大小不会改变节点外框，五个文字节点不含远程内容。 */
function makeCanvas(): CanvasDocument {
  return {
    revision: 1,
    nodes: Array.from({ length: scenario.nodes }, (_, index) => ({
      id: `thumb-node-${index}`,
      type: index < scenario.imageNodes ? ('image' as const) : ('text' as const),
      position: { x: 90 + (index % 7) * 250, y: 110 + Math.floor(index / 7) * 190 },
      width: 220,
      height: 160,
      data: {
        label: `图片 ${String(index).padStart(2, '0')}`,
        mediaType: index < scenario.imageNodes ? ('image' as const) : ('text' as const),
        mode: 'generate' as const,
        enabled: true,
        prompt: 'Synthetic isolated thumbnail performance scene.',
        ...(index < scenario.imageNodes
          ? { assetId: assetId(index), mimeType: 'image/png', contentUrl: contentUrl(index) }
          : {}),
      },
    })),
    edges: [],
  };
}
/**
 * 安装拒绝默认放行的内存 API：仅合成画布 PATCH 和 access-url POST 被接受。
 * @param baseURL 独立本机 Vite 地址；8080、非本机地址与缺少端口立即拒绝。
 * @returns 请求计数、错误、合成原图、版本切换入口；不会写真实项目或调用 Provider。
 */
export async function installFixture(page: Page, baseURL: string | undefined) {
  page.setDefaultTimeout(15000);
  if (!baseURL) throw new Error('缺少隔离 Vite baseURL');
  const origin = new URL(baseURL);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    !origin.port ||
    origin.port === '8080'
  )
    throw new Error('缩略图回归只允许独立本地端口，禁止访问真实 8080 项目');
  // 常规 pnpm dev 使用 localhost:3000；显式同源 Vite 测量同时支持当前 baseURL。
  const configuredApi = new URL(process.env.VITE_API_BASE_URL ?? 'http://localhost:3000');
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(configuredApi.hostname) ||
    configuredApi.port === '8080'
  )
    throw new Error('缩略图 fixture 禁止真实或外部 API origin');
  const allowedApiOrigins = new Set([origin.origin, configuredApi.origin]);
  const images = await createImages(page);
  const requests: MediaRequest[] = [];
  const errors: string[] = [];
  const token = `synthetic-thumbnail-${randomBytes(16).toString('hex')}`;
  const versions = new Map<string, number>();
  let canvas = makeCanvas();
  let canvasWrites = 0;
  let blockedRequests = 0;
  const user = {
    id: 'thumbnail-fixture-user',
    email: 'thumbnail@example.test',
    role: 'admin',
    createdAt: project.createdAt,
  };
  await page.context().addCookies(
    [...allowedApiOrigins].map((url) => ({
      name: 'synthetic-thumbnail-session',
      value: token,
      url,
      httpOnly: true,
      sameSite: 'Lax' as const,
    })),
  );
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(
    ({ user }) => {
      localStorage.setItem(
        'multimodal-canvas:auth-session',
        JSON.stringify({
          user,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
    },
    { user },
  );
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith('/v1/')) {
      if (url.origin === origin.origin && ['GET', 'HEAD'].includes(method)) return route.continue();
      blockedRequests += 1;
      errors.push(`阻止外部请求：${method} ${url.origin}${path}`);
      return route.abort('blockedbyclient');
    }
    if (!allowedApiOrigins.has(url.origin)) {
      blockedRequests += 1;
      errors.push(`阻止非fixture API origin：${url.origin}${path}`);
      return route.abort('blockedbyclient');
    }
    const media =
      /^\/v1\/assets\/(image-thumb-\d+)(?:\/versions\/(\d+))?\/(content|derivatives\/thumbnail|access-url)$/.exec(
        path,
      );
    const canvasPath = `/v1/projects/${project.id}/canvas`;
    if (
      !['GET', 'HEAD'].includes(method) &&
      !(method === 'PATCH' && path === canvasPath) &&
      !(method === 'POST' && media?.[3] === 'access-url')
    ) {
      blockedRequests += 1;
      errors.push(`阻止写请求：${method} ${path}`);
      return route.fulfill({ status: 405, body: '隔离测试禁止生成、上传和真实数据写入' });
    }
    if (media) {
      const id = media[1]!;
      const body =
        method === 'POST'
          ? (request.postDataJSON() as { version?: number; derivative?: string })
          : {};
      const version = Number(media[2] ?? body.version ?? versions.get(id) ?? 1);
      const kind =
        media[3] === 'access-url' ? 'sign' : media[3] === 'content' ? 'original' : 'thumbnail';
      const headers = await request.allHeaders();
      const bearer = headers.authorization === `Bearer ${token}`;
      const cookie = (headers.cookie ?? '').includes(`synthetic-thumbnail-session=${token}`);
      requests.push({ kind, assetId: id, version, path, bearer, cookie });
      if ((kind === 'thumbnail' || kind === 'sign') && !bearer && !cookie) {
        errors.push(`${kind} 未通过隔离会话认证：${path}`);
        return route.fulfill({ status: 401, body: 'fixture authorization required' });
      }
      if (kind === 'sign')
        return json(route, {
          url: `/v1/assets/${id}/versions/${version}/${body.derivative === 'thumbnail' ? 'derivatives/thumbnail' : 'content'}?fixture-signed=1`,
        });
      const image = images[version - 1];
      if (!image) {
        errors.push(`未声明图片版本：${version}`);
        return route.fulfill({ status: 404 });
      }
      return route.fulfill({
        contentType: kind === 'thumbnail' ? 'image/jpeg' : 'image/png',
        body: kind === 'thumbnail' ? image.thumbnail : image.original,
        headers: {
          'cache-control': 'no-store',
          'X-Original-Width': '3840',
          'X-Original-Height': '2160',
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename(id, version))}`,
        },
      });
    }
    if (path === '/v1/auth/me') return json(route, { user });
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path === canvasPath) {
      if (method === 'PATCH') {
        canvasWrites += 1;
        canvas = { ...request.postDataJSON(), revision: canvas.revision + 1 };
      }
      return json(route, { canvas });
    }
    if (path.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': synthetic ready\n\n' });
    if (path.endsWith('/models/defaults')) return json(route, { defaults: {} });
    if (path.endsWith('/runs')) return json(route, { runs: [] });
    if (path.endsWith('/reverse-prompts')) return json(route, { analysis: null });
    if (path.endsWith('/request-prompts')) return json(route, { records: [] });
    if (path === '/v1/assets')
      return json(route, {
        assets: Array.from({ length: scenario.sidebarImages }, (_, index) => ({
          id: assetId(index),
          name: `素材 ${String(index).padStart(2, '0')}`,
          mediaType: 'image',
          mimeType: 'image/png',
          sizeBytes: images[(versions.get(assetId(index)) ?? 1) - 1]!.original.byteLength,
          status: 'ready',
          ...(index === 45 ? {} : { latestVersion: versions.get(assetId(index)) ?? 1 }),
          contentUrl: contentUrl(index, versions.get(assetId(index)) ?? 1),
          tags: [],
        })),
      });
    if (path === '/v1/settings/ai')
      return json(route, { settings: { defaultModels: {}, timeoutMs: 900000 } });
    if (path === '/v1/models') return json(route, { models: [] });
    if (path === '/v1/prompt-skills') return json(route, { skills: [] });
    errors.push(`未声明接口：${method} ${path}`);
    return route.fulfill({ status: 404, body: '未声明的隔离测试接口' });
  });
  return {
    images,
    requests,
    errors,
    counts: () => ({ canvasWrites, blockedRequests }),
    canvas: () => structuredClone(canvas),
    /** 切换合成资产版本，下一次项目装载仍复用当前浏览器模块中的缓存。 */
    setVersion(index: number, version: number) {
      versions.set(assetId(index), version);
      const node = canvas.nodes[index];
      if (node) node.data.contentUrl = contentUrl(index, version);
      canvas.revision += 1;
    },
  };
}
/** 将测试所需的完整图片节点和侧栏全部等待到解码完成。 */
export async function openScenario(page: Page) {
  await page.goto(`/projects/${project.id}`);
  await expect(page.locator('.react-flow__node')).toHaveCount(scenario.nodes, { timeout: 90000 });
  await expect(page.locator('.asset-card')).toHaveCount(scenario.sidebarImages);
  await expect(page.locator('.flow-node-preview img')).toHaveCount(scenario.imageNodes, {
    timeout: 60000,
  });
  await expect
    .poll(
      async () =>
        (await imageProbes(page.locator('.flow-node-preview img, .asset-card img'))).filter(
          (image) => image.complete && image.width > 0,
        ).length,
      { timeout: 60000 },
    )
    .toBe(82);
  const expand = page.getByRole('button', { name: '展开资源栏', exact: true });
  if (await expand.isVisible()) await expand.click();
  // 基线的节点层可遮住右下角控件；使用其原生键盘行为完成准备，不修改层叠样式。
  const fit = page.getByRole('button', { name: '自动适配缩放', exact: true });
  await fit.focus();
  await fit.press('Enter');
  await expect
    .poll(() =>
      page
        .locator('.react-flow__viewport')
        .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
    )
    .toBeLessThan(1);
  await settleFrames(page);
}
/** 等待两次绘制回调，避免只测到事件提交而未测到渲染结尾。 */
export async function settleFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
/** 提取渲染元素实际解码尺寸，不读取业务元数据中的请求尺寸。 */
export async function imageProbes(locator: Locator): Promise<ImageProbe[]> {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const image = element as HTMLImageElement;
      return {
        src: image.currentSrc,
        width: image.naturalWidth,
        height: image.naturalHeight,
        complete: image.complete,
      };
    }),
  );
}
/** 校验真实浏览器下载事件中的文件名、原始字节与 SHA-256。 */
export async function inspectDownload(download: Download, expected: Buffer, expectedName: string) {
  expect(download.suggestedFilename()).toBe(expectedName);
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  expect(bytes).toEqual(expected);
  expect(sha256(bytes)).toBe(sha256(expected));
  return { filename: download.suggestedFilename(), bytes: bytes.byteLength, sha256: sha256(bytes) };
}
/** 统计路由侧的真实请求次数；每键多出的请求单列，不把 82 个 img 当 82 个独立资产。 */
export function requestSummary(requests: MediaRequest[]) {
  const thumbnails = requests.filter((item) => item.kind === 'thumbnail');
  const keys: Record<string, number> = {};
  for (const item of thumbnails) {
    const key = `${item.assetId}:v${item.version}`;
    keys[key] = (keys[key] ?? 0) + 1;
  }
  return {
    originalRequests: requests.filter((item) => item.kind === 'original').length,
    signingRequests: requests.filter((item) => item.kind === 'sign').length,
    thumbnailRequests: thumbnails.length,
    duplicateThumbnailRequests: Object.values(keys).reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    ),
    thumbnailKeys: keys,
    missingThumbnailAuthentication: thumbnails.filter((item) => !item.bearer && !item.cookie)
      .length,
  };
}
/** 返回毫秒分布及原始样本；本函数不换算或声称 FPS。 */
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? null,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
    samplesMs: values,
  };
}
