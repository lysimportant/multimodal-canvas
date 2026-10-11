import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';

import type { Asset, CanvasDocument } from '@multimodal-canvas/domain';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
test.setTimeout(60_000);

/** 验收只读本仓库已有的演示字节，不访问供应商或真实素材。 */
const video = readFileSync(new URL('../public/demo/field-study.mp4', import.meta.url));
const poster = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
const project = {
  id: 'resource-preview-recovery',
  name: '资源回显恢复验收',
  createdAt: '2026-10-11T08:00:00.000Z',
  updatedAt: '2026-10-11T08:01:00.000Z',
};
const frozenVersion = 2;
const directOrigin = 'https://private-preview-r2.example.test';

/** 生成两秒 PCM 静音 WAV，浏览器实际读取元数据而非模拟 loadedmetadata。 */
function createSilentWav(): Buffer {
  const samples = 16_000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

const audio = createSilentWav();

/** 保存读取与授权请求，便于核验冻结版本、代理模式和媒体 Range 合同。 */
type RequestRecord = {
  method: string;
  path: string;
  url: string;
  range?: string;
  body?: Record<string, unknown>;
  status?: number;
};

/** 隔离夹具的证据；失败次数按授权 URL 计，不按浏览器内部的 Range 次数计。 */
type PreviewFixture = {
  asset: Asset;
  requests: RequestRecord[];
  authorizations: RequestRecord[];
  errors: string[];
  expectedNetworkErrors: string[];
};

/**
 * 返回当前媒体的原始字节；不创建本地素材或写入资源索引。
 * @param kind 夹具的媒体类型。
 * @returns 可由 Chromium 解码的图片、视频或 PCM 音频。
 */
function mediaBytes(kind: 'image' | 'video' | 'audio'): Buffer {
  return kind === 'image' ? poster : kind === 'video' ? video : audio;
}

/**
 * 按实际 Range 请求返回 206；无 Range 的图片读取保持 200。
 * @param route 已拦截且不会访问网络的媒体请求。
 * @param asset 当前冻结资源，仅使用其 MIME 信息。
 * @param bytes 本仓库演示字节或内存 WAV。
 * @param record 用于记录响应状态的请求证据。
 * @param cors 当前 PC Web 的跨端口响应头。
 */
async function fulfillMedia(
  route: Route,
  asset: Asset,
  bytes: Buffer,
  record: RequestRecord,
  cors: Record<string, string>,
): Promise<void> {
  const headers = { ...cors, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  const range = record.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    record.status = 200;
    await route.fulfill({
      status: 200,
      contentType: asset.mimeType,
      headers: { ...headers, 'content-length': String(bytes.length) },
      body: record.method === 'HEAD' ? undefined : bytes,
    });
    return;
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
  const end = Math.min(
    bytes.length - 1,
    range[1] && range[2] ? Number(range[2]) : bytes.length - 1,
  );
  expect(start).toBeLessThanOrEqual(end);
  const body = bytes.subarray(start, end + 1);
  record.status = 206;
  await route.fulfill({
    status: 206,
    contentType: asset.mimeType,
    headers: {
      ...headers,
      'content-range': `bytes ${start}-${end}/${bytes.length}`,
      'content-length': String(body.length),
    },
    body: record.method === 'HEAD' ? undefined : body,
  });
}

/**
 * 安装登录、画布和私有资源 Mock；未声明的写请求及外部地址一律拒绝并记为错误。
 * @param page 只用于本次 PC Web 验收的独立页面。
 * @param kind 要展示的媒体类型。
 * @param failedAttempts 哪些授权代次返回 503；同一代次的 Range 请求保持相同结果。
 * @returns 请求、授权和错误证据，不产生真实 API、生成或素材写入。
 */
async function installFixture(
  page: Page,
  kind: 'image' | 'video' | 'audio',
  failedAttempts: number[],
): Promise<PreviewFixture> {
  const asset: Asset = {
    id: `recovery-${kind}`,
    name: `冻结版本${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}`,
    mediaType: kind,
    mimeType: kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/wav',
    sizeBytes: mediaBytes(kind).length,
    latestVersion: 7,
    status: 'ready',
    contentUrl: `/v1/assets/recovery-${kind}/versions/${frozenVersion}/content`,
    tags: [],
  };
  const canvas: CanvasDocument = {
    revision: 1,
    nodes: [
      {
        id: 'recovery-node',
        type: kind,
        position: { x: 320, y: 220 },
        width: 360,
        height: 260,
        data: {
          createdAt: project.createdAt,
          label: asset.name,
          mediaType: kind,
          mode: 'generate',
          enabled: true,
          assetId: asset.id,
          mimeType: asset.mimeType,
          contentUrl: asset.contentUrl,
        },
      },
    ],
    edges: [],
  };
  const fixture: PreviewFixture = {
    asset,
    requests: [],
    authorizations: [],
    errors: [],
    expectedNetworkErrors: [],
  };
  const failedUrls = new Set<string>();
  page.on('pageerror', (error) => fixture.errors.push('pageerror: ' + error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location().url;
    if (
      failedUrls.has(location) &&
      message.text().includes('Failed to load resource') &&
      message.text().includes('503')
    ) {
      fixture.expectedNetworkErrors.push(message.text());
      return;
    }
    fixture.errors.push('console: ' + message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-preview-recovery',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'preview-recovery-user',
          email: 'preview-recovery@example.test',
          role: 'user',
          createdAt: '2026-10-11T08:00:00.000Z',
        },
      }),
    );
  });
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const cors = {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'authorization, content-type, range',
    'access-control-allow-methods': 'GET, HEAD, POST, PATCH, OPTIONS',
    'access-control-expose-headers': 'content-range, accept-ranges, content-length',
  };
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    fixture.errors.push('阻止未声明的外部请求：' + route.request().url());
    return route.abort('blockedbyclient');
  });

  /** 只为签名夹具返回内容；裸 content URL 不能绕过本次授权。 */
  const signedContent = async (route: Route, record: RequestRecord) => {
    const url = new URL(record.url);
    const attempt = Number(url.searchParams.get('attempt'));
    expect(attempt).toBeGreaterThan(0);
    expect(url.pathname).toContain(`/versions/${frozenVersion}/`);
    if (failedAttempts.includes(attempt)) {
      failedUrls.add(record.url);
      record.status = 503;
      return route.fulfill({
        status: 503,
        contentType: 'text/plain',
        headers: { ...cors, 'cache-control': 'no-store' },
        body: '隔离夹具：签名媒体暂不可达',
      });
    }
    return fulfillMedia(route, asset, mediaBytes(kind), record, cors);
  };
  await page.route(`${directOrigin}/**`, async (route) => {
    const request = route.request();
    const record: RequestRecord = {
      method: request.method(),
      url: request.url(),
      path: new URL(request.url()).pathname,
      range: request.headers().range,
    };
    fixture.requests.push(record);
    expect(['GET', 'HEAD']).toContain(record.method);
    return signedContent(route, record);
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const record: RequestRecord = {
      method: request.method(),
      path: url.pathname,
      url: request.url(),
      range: request.headers().range,
      ...(request.postData() ? { body: request.postDataJSON() } : {}),
    };
    fixture.requests.push(record);
    const json = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    if (record.method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (record.path === `/v1/assets/${asset.id}/access-url` && record.method === 'POST') {
      expect(record.body?.version).toBe(frozenVersion);
      fixture.authorizations.push(record);
      const attempt = fixture.authorizations.length;
      const source = record.body?.mode === 'proxy' ? '' : directOrigin;
      return json({
        url: `${source}${asset.contentUrl}?attempt=${attempt}&token=synthetic-preview-signature`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (record.path === asset.contentUrl && ['GET', 'HEAD'].includes(record.method))
      return signedContent(route, record);
    if (
      record.path === `/v1/assets/${asset.id}/versions/${frozenVersion}/derivatives/thumbnail` &&
      kind === 'image' &&
      record.method === 'GET'
    )
      return route.fulfill({
        contentType: 'image/jpeg',
        headers: { ...cors, 'x-original-width': '960', 'x-original-height': '540' },
        body: poster,
      });
    if (record.path === `/v1/projects/${project.id}/canvas` && record.method === 'PATCH')
      return json({ canvas });
    if (record.method !== 'GET') {
      fixture.errors.push(`阻止未声明的写请求：${record.method} ${record.path}`);
      return route.fulfill({ status: 405, headers: cors, body: '隔离验收禁止生成或上传' });
    }
    if (record.path === '/v1/auth/me')
      return json({
        user: {
          id: 'preview-recovery-user',
          email: 'preview-recovery@example.test',
          role: 'user',
          createdAt: project.createdAt,
        },
      });
    if (record.path === '/v1/projects') return json({ projects: [project] });
    if (record.path === `/v1/projects/${project.id}`) return json({ project });
    if (record.path === `/v1/projects/${project.id}/canvas`) return json({ canvas });
    if (record.path === `/v1/projects/${project.id}/models/defaults`) return json({ defaults: {} });
    if (record.path === `/v1/projects/${project.id}/runs`) return json({ runs: [] });
    if (record.path === `/v1/projects/${project.id}/events`)
      return route.fulfill({
        contentType: 'text/event-stream',
        headers: cors,
        body: ': ready\n\n',
      });
    if (record.path === '/v1/assets') return json({ assets: [asset] });
    if (record.path === '/v1/prompt-skills') return json({ skills: [] });
    if (record.path === '/v1/settings/ai')
      return json({ settings: { defaultModels: {}, timeoutMs: 900_000 } });
    if (record.path === '/v1/models') return json({ models: [] });
    if (record.path.endsWith('/reverse-prompts')) return json({ analysis: null });
    if (record.path.endsWith('/request-prompts')) return json({ records: [] });
    fixture.errors.push(`未声明的 Mock 接口：${record.method} ${record.path}`);
    return route.fulfill({ status: 418, headers: cors, body: '未声明的验收接口' });
  });
  return fixture;
}

/** 读取逻辑节点外框；避开画布 fitView 的视觉缩放动画，不改变节点或媒体状态。 */
async function nodeSize(node: Locator): Promise<{ width: number; height: number }> {
  return node.evaluate((element: HTMLElement) => ({
    width: element.offsetWidth,
    height: element.offsetHeight,
  }));
}

/** 元数据由浏览器真实解码；视频同时校验原始宽高和可用时长。 */
async function expectDecodedMedia(media: Locator, kind: 'video' | 'audio'): Promise<void> {
  await expect
    .poll(() => media.evaluate((element: HTMLMediaElement) => element.readyState))
    .toBeGreaterThan(0);
  expect(await media.evaluate((element: HTMLMediaElement) => element.duration)).toBeGreaterThan(0);
  if (kind === 'video') {
    expect(await media.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(
      0,
    );
    expect(
      await media.evaluate((element: HTMLVideoElement) => element.videoHeight),
    ).toBeGreaterThan(0);
  }
}

/** 仅忽略已登记夹具 URL 的 503 控制台记录；生成、上传和其他页面异常必须为空。 */
function expectIsolated(fixture: PreviewFixture): void {
  expect(fixture.errors).toEqual([]);
  expect(
    fixture.requests.filter(
      ({ method, path }) => method === 'POST' && !path.endsWith('/access-url'),
    ),
  ).toEqual([]);
  expect(fixture.authorizations.every(({ body }) => body?.version === frozenVersion)).toBe(true);
}

test('PC 视频签名失败后代理恢复，过期后弹窗重新授权并实际播放与定位，不撑大节点', async ({
  page,
}) => {
  const fixture = await installFixture(page, 'video', [1]);
  await page.goto(`/projects/${project.id}`);
  const node = page.locator('.react-flow__node[data-id="recovery-node"]');
  await expect(node).toBeVisible({ timeout: 30_000 });
  const before = await nodeSize(node);
  const nodeMedia = node.locator('video');
  await expectDecodedMedia(nodeMedia, 'video');
  await expect
    .poll(() => nodeMedia.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  await expect(node.locator('.artifact-preview-loading')).toHaveCount(0);
  expect(fixture.authorizations.map(({ body }) => body)).toEqual([
    { version: frozenVersion },
    { version: frozenVersion, mode: 'proxy' },
  ]);
  const nodeSrc = await nodeMedia.getAttribute('src');
  expect(nodeSrc).toContain('attempt=2');
  expect(
    fixture.requests.some(({ range, status, url }) => range && status === 206 && url === nodeSrc),
  ).toBe(true);
  expect(await nodeSize(node)).toEqual(before);
  await page.screenshot({
    path: '../../.local-tests/resource-preview/1440x900-video-node-recovered.png',
    animations: 'disabled',
  });
  await page.clock.install();
  await page.clock.fastForward(65_000);
  await node.hover();
  await node.getByRole('button', { name: /^预览视频：/ }).click();
  const viewer = page.getByRole('dialog', { name: fixture.asset.name, exact: true });
  await expect(viewer).toBeVisible();
  const media = viewer.locator('video');
  await expectDecodedMedia(media, 'video');
  await expect(media).toHaveAttribute('src', /attempt=3/);
  expect(await media.getAttribute('src')).not.toBe(nodeSrc);
  expect(fixture.authorizations).toHaveLength(3);
  const pause = viewer.getByRole('button', { name: '暂停视频', exact: true });
  if (!(await pause.isVisible()))
    await viewer.getByRole('button', { name: '播放视频', exact: true }).first().click();
  await expect
    .poll(() => media.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0);
  await pause.click();
  const target = await media.evaluate((element: HTMLVideoElement) => {
    element.currentTime = element.duration / 2;
    return element.duration / 2;
  });
  await expect
    .poll(() => media.evaluate((element: HTMLVideoElement) => element.seeking))
    .toBe(false);
  expect(await media.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(
    target,
    1,
  );
  await viewer.getByRole('button', { name: '播放视频', exact: true }).first().click();
  await expect
    .poll(() => media.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(target);
  await pause.click();
  await page.screenshot({
    path: '../../.local-tests/resource-preview/1440x900-video-dialog-playing-and-seek.png',
    animations: 'disabled',
  });
  await viewer.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(viewer).toBeHidden();
  expect(await nodeSize(node)).toEqual(before);
  expectIsolated(fixture);
});

for (const kind of ['video', 'audio'] as const) {
  test(`PC ${kind} 两次失败停止自动授权，手动重载重新授权同一版本`, async ({ page }) => {
    const fixture = await installFixture(page, kind, [1, 2]);
    await page.goto(`/projects/${project.id}`);
    const node = page.locator('.react-flow__node[data-id="recovery-node"]');
    await expect(node).toBeVisible({ timeout: 30_000 });
    const before = await nodeSize(node);
    await expect(node.getByRole('alert')).toContainText(
      kind === 'video' ? '视频加载失败' : '音频加载失败',
    );
    await expect(node.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
    await page.waitForTimeout(400);
    expect(fixture.authorizations.map(({ body }) => body)).toEqual([
      { version: frozenVersion },
      { version: frozenVersion, mode: 'proxy' },
    ]);
    await node.getByRole('button', { name: '重新加载', exact: true }).click();
    const media = node.locator(kind);
    await expectDecodedMedia(media, kind);
    await expect(media).toHaveAttribute('src', /attempt=3/);
    expect(fixture.authorizations).toHaveLength(3);
    expect(await nodeSize(node)).toEqual(before);
    await expect(node.getByRole('alert')).toHaveCount(0);
    expectIsolated(fixture);
  });
}

test('PC 图片原图弹窗失败后重试重新授权，过期后关闭再开也刷新签名', async ({ page }) => {
  const fixture = await installFixture(page, 'image', [1, 2]);
  await page.goto(`/projects/${project.id}`);
  const node = page.locator('.react-flow__node[data-id="recovery-node"]');
  await expect(node).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => node.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  const before = await nodeSize(node);
  await node.hover();
  await node.getByRole('button', { name: /^预览图片：/ }).click();
  const viewer = page.getByRole('dialog', { name: fixture.asset.name, exact: true });
  await expect(viewer.getByRole('alert')).toContainText('图片加载失败');
  expect(fixture.authorizations.map(({ body }) => body)).toEqual([
    { version: frozenVersion },
    { version: frozenVersion, mode: 'proxy' },
  ]);
  await viewer.getByRole('button', { name: '重新加载预览', exact: true }).click();
  const image = viewer.getByRole('img', { name: fixture.asset.name, exact: true });
  await expect(image).toHaveAttribute('src', /attempt=3/);
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  expect(fixture.authorizations).toHaveLength(3);
  await viewer.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(viewer).toBeHidden();
  await page.locator('.react-flow__pane').click({ position: { x: 80, y: 280 } });
  await expect(page.locator('.node-quick-editor')).toBeHidden();
  await page.clock.install();
  await page.clock.fastForward(65_000);
  await node.hover();
  await node.getByRole('button', { name: /^预览图片：/ }).click();
  await expect(image).toHaveAttribute('src', /attempt=4/);
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  expect(fixture.authorizations).toHaveLength(4);
  await page.screenshot({
    path: '../../.local-tests/resource-preview/1440x900-image-dialog-recovered.png',
    animations: 'disabled',
  });
  await viewer.getByRole('button', { name: '关闭预览', exact: true }).click();
  expect(await nodeSize(node)).toEqual(before);
  expectIsolated(fixture);
});

test('PC 视频弹窗两次失败后，播放器手动重试重新授权而非复用失败地址', async ({ page }) => {
  const fixture = await installFixture(page, 'video', [2, 3]);
  await page.goto(`/projects/${project.id}`);
  const node = page.locator('.react-flow__node[data-id="recovery-node"]');
  await expect(node).toBeVisible({ timeout: 30_000 });
  await expectDecodedMedia(node.locator('video'), 'video');
  const before = await nodeSize(node);
  await page.clock.install();
  await page.clock.fastForward(65_000);
  await node.hover();
  await node.getByRole('button', { name: /^预览视频：/ }).click();
  const viewer = page.getByRole('dialog', { name: fixture.asset.name, exact: true });
  await expect(viewer.getByRole('alert')).toContainText('视频加载失败');
  expect(fixture.authorizations).toHaveLength(3);
  expect(fixture.authorizations[2]!.body).toEqual({ version: frozenVersion, mode: 'proxy' });
  await viewer.getByRole('button', { name: '重新加载预览', exact: true }).click();
  const media = viewer.locator('video');
  await expectDecodedMedia(media, 'video');
  await expect(media).toHaveAttribute('src', /attempt=4/);
  expect(fixture.authorizations).toHaveLength(4);
  await expect(viewer.getByRole('alert')).toHaveCount(0);
  const pause = viewer.getByRole('button', { name: '暂停视频', exact: true });
  if (!(await pause.isVisible()))
    await viewer.getByRole('button', { name: '播放视频', exact: true }).first().click();
  await expect
    .poll(() => media.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0);
  await pause.click();
  await expect(viewer.locator('.media-preview-player-tools [role="status"]')).toHaveCount(0);
  await page.screenshot({
    path: '../../.local-tests/resource-preview/1440x900-video-dialog-manual-retry.png',
    animations: 'disabled',
  });
  await viewer.getByRole('button', { name: '关闭预览', exact: true }).click();
  expect(await nodeSize(node)).toEqual(before);
  expectIsolated(fixture);
});
