import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import {
  assetId,
  contentUrl,
  distribution,
  filename,
  imageProbes,
  inspectDownload,
  installFixture,
  openScenario,
  project,
  requestSummary,
  scenario,
  settleFrames,
  sha256,
} from './image-thumbnail-cache.helpers';

/** 同场景前后测量只接受显式标签；缺省执行新版行为回归而不输出性能结论。 */
const phase = process.env.THUMBNAIL_PHASE;
if (phase && !['before', 'after'].includes(phase))
  throw new Error('THUMBNAIL_PHASE 仅允许 before 或 after');
test.use({ serviceWorkers: 'block', viewport: { width: scenario.width, height: scenario.height } });
test.setTimeout(180000);

/** 将审计结果写进 Playwright 指定的隔离输出目录，同时保留报告附件。 */
async function evidence(info: TestInfo, name: string, value: unknown) {
  const body = JSON.stringify(value, null, 2);
  await writeFile(info.outputPath(name), body);
  await info.attach(name, { contentType: 'application/json', body });
}
/** 在鼠标操作期间记录 rAF 时间间隔，停止时取消循环，避免影响后续阶段。 */
async function startFrames(page: Page) {
  await page.evaluate(() => {
    const state = { samples: [] as number[], previous: 0, active: true, handle: 0 };
    Object.assign(window, { thumbnailFrameProbe: state });
    /** 只采集相邻实际回调间隔，不把鼠标步数当作帧数。 */
    const tick = (now: number) => {
      if (!state.active) return;
      if (state.previous) state.samples.push(now - state.previous);
      state.previous = now;
      state.handle = requestAnimationFrame(tick);
    };
    state.handle = requestAnimationFrame(tick);
  });
}
/** 停止并返回页面内帧调度样本，不涉及硬件渲染 FPS 推算。 */
async function stopFrames(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as typeof window & {
        thumbnailFrameProbe: { samples: number[]; active: boolean; handle: number };
      }
    ).thumbnailFrameProbe;
    state.active = false;
    cancelAnimationFrame(state.handle);
    return state.samples;
  });
}
/** 对固定距离执行五次往返 pan 或单节点 drag，分别保存自动化端到端耗时与帧调度。 */
async function measureInteraction(page: Page, kind: 'pan' | 'drag') {
  const wholeDrag: number[] = [];
  const motionFrames: number[] = [];
  const transforms: { before: string; after: string }[] = [];
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const node = page.locator('.react-flow__node[data-id="thumb-node-10"]');
    const viewport = page.locator('.react-flow__viewport');
    const bounds = await (kind === 'pan' ? page.locator('.react-flow__pane') : node).boundingBox();
    if (!bounds) throw new Error(`${kind} 缺少可见交互区域`);
    const x = kind === 'pan' ? bounds.x + bounds.width - 60 : bounds.x + bounds.width / 2;
    const y = kind === 'pan' ? bounds.y + bounds.height - 70 : bounds.y + 10;
    const target = kind === 'pan' ? viewport : node;
    const before = await target.evaluate((element) => getComputedStyle(element).transform);
    await page.mouse.move(x, y);
    await startFrames(page);
    const start = performance.now();
    await page.mouse.down({ button: kind === 'pan' ? 'middle' : 'left' });
    await page.mouse.move(x + (iteration % 2 ? -64 : 64), y + (iteration % 2 ? -32 : 32), {
      steps: 24,
    });
    await page.mouse.up({ button: kind === 'pan' ? 'middle' : 'left' });
    await settleFrames(page);
    wholeDrag.push(performance.now() - start);
    motionFrames.push(...(await stopFrames(page)));
    const after = await target.evaluate((element) => getComputedStyle(element).transform);
    expect(after, `${kind} 必须真实改变目标 transform`).not.toBe(before);
    transforms.push({ before, after });
  }
  return {
    wholeDrag: distribution(wholeDrag),
    animationFrameIntervals: distribution(motionFrames),
    transforms,
    definition:
      'wholeDrag 包含 Playwright mouse down/24 moves/up、进程通信与两次 rAF；不是 FPS。rAF 仅为 headless Chromium 帧调度间隔。',
  };
}

test('同场景 before/after：41节点36图片与46侧栏的小预览、网络和pan/drag', async ({
  page,
  baseURL,
}, info) => {
  test.skip(!phase, '需显式设置 THUMBNAIL_PHASE=before 或 after，不能把不同场景的数字比较');
  const fixture = await installFixture(page, baseURL);
  await openScenario(page);
  const nodes = await imageProbes(page.locator('.flow-node-preview img'));
  const sidebar = await imageProbes(page.locator('.asset-card img'));
  const beforeInteraction = requestSummary(fixture.requests);
  expect(new Set([...nodes, ...sidebar].map((image) => `${image.width}x${image.height}`))).toEqual(
    new Set([phase === 'before' ? '3840x2160' : '640x360']),
  );
  if (phase === 'after') {
    expect(beforeInteraction.originalRequests).toBe(0);
    expect(beforeInteraction.signingRequests).toBe(0);
    expect(beforeInteraction.thumbnailRequests).toBe(46);
    expect(beforeInteraction.duplicateThumbnailRequests).toBe(0);
  }
  await page.screenshot({ path: info.outputPath('closed-preview.png'), animations: 'disabled' });
  const pan = await measureInteraction(page, 'pan');
  const drag = await measureInteraction(page, 'drag');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fixture.counts().canvasWrites).toBeGreaterThan(0);
  await evidence(info, 'performance.json', {
    phase,
    sourceRevision: process.env.THUMBNAIL_REVISION ?? 'unspecified',
    baseURL,
    scenario,
    browser: 'Chromium headless',
    browserVersion: page.context().browser()?.version(),
    measuredAt: new Date().toISOString(),
    loadCondition:
      process.env.THUMBNAIL_LOAD_CONDITION ?? 'unspecified-do-not-claim-performance-gain',
    trace: info.project.use.trace,
    naturalPixelSum: [...nodes, ...sidebar].reduce(
      (sum, image) => sum + image.width * image.height,
      0,
    ),
    fixturePayloadBytes: fixture.requests.reduce(
      (sum, request) =>
        sum +
        (request.kind === 'original'
          ? fixture.images[request.version - 1]!.original.length
          : request.kind === 'thumbnail'
            ? fixture.images[request.version - 1]!.thumbnail.length
            : 0),
      0,
    ),
    deviceScaleFactor: 1,
    stepsPerDrag: 24,
    repetitions: 5,
    fixture: fixture.images.map((image, index) => ({
      version: index + 1,
      originalBytes: image.original.length,
      originalSha256: sha256(image.original),
      thumbnailBytes: image.thumbnail.length,
      thumbnailSha256: sha256(image.thumbnail),
    })),
    closedDialog: { nodes, sidebar, requests: beforeInteraction },
    afterInteractions: requestSummary(fixture.requests),
    pan,
    drag,
    fixtureWrites: fixture.counts(),
    limitations: [
      '合成路由 fixture，不代表真实网络、API 生成缩略图耗时或生产 GPU 表现。',
      '同一场景和浏览器的 rAF 间隔与自动化 whole-drag 延迟分开报告，不能把 whole-drag 换算为 FPS。',
    ],
  });
  expect(fixture.errors).toEqual([]);
});

test.describe('新版缩略图缓存验收', () => {
  test.skip(phase === 'before', '冻结源码只运行 before 基线；不把预期失败计为新版回归');

  test('小卡片全部640、关闭Dialog不拉原图、同版跨节点与侧栏复用', async ({
    page,
    baseURL,
  }, info) => {
    const fixture = await installFixture(page, baseURL);
    await openScenario(page);
    const nodes = await imageProbes(page.locator('.flow-node-preview img'));
    const sidebar = await imageProbes(page.locator('.asset-card img'));
    expect(nodes).toHaveLength(36);
    expect(sidebar).toHaveLength(46);
    for (const image of [...nodes, ...sidebar]) {
      expect([image.width, image.height]).toEqual([640, 360]);
      expect(image.src).toMatch(/^blob:/);
    }
    for (let index = 0; index < 36; index += 1) expect(nodes[index]!.src).toBe(sidebar[index]!.src);
    const initial = requestSummary(fixture.requests);
    expect(initial).toMatchObject({
      originalRequests: 0,
      signingRequests: 0,
      thumbnailRequests: 46,
      duplicateThumbnailRequests: 0,
      missingThumbnailAuthentication: 0,
    });
    expect(fixture.requests.find((request) => request.assetId === assetId(44))?.path).toBe(
      `/v1/assets/${assetId(44)}/versions/1/derivatives/thumbnail`,
    );
    expect(fixture.requests.find((request) => request.assetId === assetId(45))?.path).toBe(
      `/v1/assets/${assetId(45)}/derivatives/thumbnail`,
    );
    const search = page.getByPlaceholder('搜索资源', { exact: true });
    await search.fill('不匹配的合成资源');
    await expect(page.locator('.asset-card')).toHaveCount(0);
    await search.fill('');
    await expect(page.locator('.asset-card')).toHaveCount(46);
    await settleFrames(page);
    const remount = await imageProbes(page.locator('.asset-card img'));
    expect(remount[0]!.src).toBe(nodes[0]!.src);
    expect(requestSummary(fixture.requests)).toEqual(initial);
    await page.waitForTimeout(350);
    expect(
      fixture.requests.filter((request) => request.kind === 'original' || request.kind === 'sign'),
    ).toEqual([]);
    await evidence(info, 'cache-and-lazy-original.json', {
      initial,
      afterRemount: requestSummary(fixture.requests),
      nodes,
      sidebar,
      remount,
    });
    expect(fixture.errors).toEqual([]);
  });

  test('Dialog解码3840且节点和Dialog下载原始bytes/hash/文件名', async ({ page, baseURL }, info) => {
    const fixture = await installFixture(page, baseURL);
    await openScenario(page);
    expect(requestSummary(fixture.requests).originalRequests).toBe(0);
    const node = page.locator('.react-flow__node[data-id="thumb-node-0"]');
    await node.hover();
    const nodeDownload = page.waitForEvent('download');
    await node.getByRole('button', { name: '下载图片', exact: true }).click();
    const nodeResult = await inspectDownload(
      await nodeDownload,
      fixture.images[0]!.original,
      filename(assetId(0), 1),
    );
    expect(
      fixture.requests
        .filter((request) => request.kind === 'original')
        .map((request) => request.path),
    ).toEqual([contentUrl(0)]);
    expect(fixture.requests.filter((request) => request.kind === 'sign')).toHaveLength(0);
    await node.getByRole('button', { name: /^预览图片：/ }).click();
    const viewer = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: '下载原文件', exact: true }) });
    await expect(viewer).toBeVisible();
    const image = viewer.locator('img').first();
    await expect.poll(async () => (await imageProbes(image))[0]!.width).toBe(3840);
    expect((await imageProbes(image))[0]!.height).toBe(2160);
    expect(
      fixture.requests.filter(
        (request) => request.kind === 'sign' && request.assetId === assetId(0),
      ),
    ).toHaveLength(1);
    const dialogDownload = page.waitForEvent('download');
    await viewer.getByRole('button', { name: '下载原文件', exact: true }).click();
    const dialogResult = await inspectDownload(
      await dialogDownload,
      fixture.images[0]!.original,
      filename(assetId(0), 1),
    );
    await page.screenshot({ path: info.outputPath('dialog-original-3840.png') });
    const dialogProbe = await imageProbes(image);
    await viewer.getByRole('button', { name: '关闭预览', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    const closed = requestSummary(fixture.requests);
    await page.waitForTimeout(350);
    expect(requestSummary(fixture.requests)).toEqual(closed);
    expect((await imageProbes(node.locator('img')))[0]!.width).toBe(640);
    await evidence(info, 'original-dialog-and-downloads.json', {
      nodeResult,
      dialogResult,
      dialogProbe,
      afterClose: closed,
      requests: fixture.requests,
    });
    expect(fixture.errors).toEqual([]);
  });

  test('同页面模块保留时切换版本不复用旧缩略图', async ({ page, baseURL }, info) => {
    const fixture = await installFixture(page, baseURL);
    await openScenario(page);
    const nodeImage = page.locator('.react-flow__node[data-id="thumb-node-0"] img');
    const before = (await imageProbes(nodeImage))[0]!;
    /** SPA 离开项目触发组件卸载，但保留 JS 模块及其缩略图缓存。 */
    await page.evaluate(() => {
      history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    fixture.setVersion(0, 2);
    await page.evaluate((id) => {
      for (const key of Object.keys(localStorage))
        if (key.startsWith('multimodal-canvas:canvas:') && key.includes(id))
          localStorage.removeItem(key);
      history.pushState({}, '', `/projects/${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, project.id);
    await expect(page.locator('.react-flow__node')).toHaveCount(41, { timeout: 60000 });
    await expect
      .poll(async () => (await imageProbes(nodeImage))[0]?.width, { timeout: 60000 })
      .toBe(640);
    const after = (await imageProbes(nodeImage))[0]!;
    expect(after.src).not.toBe(before.src);
    const pixelHash = await nodeImage.evaluate(async (element) => {
      const bytes = await (await fetch((element as HTMLImageElement).currentSrc)).arrayBuffer();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (part) =>
        part.toString(16).padStart(2, '0'),
      ).join('');
    });
    expect(pixelHash).toBe(sha256(fixture.images[1]!.thumbnail));
    expect(pixelHash).not.toBe(sha256(fixture.images[0]!.thumbnail));
    const requested = fixture.requests.filter(
      (request) => request.assetId === assetId(0) && request.kind === 'thumbnail',
    );
    expect(requested.map((request) => request.version)).toEqual([1, 2]);
    expect(requestSummary(fixture.requests).originalRequests).toBe(0);
    await evidence(info, 'version-isolation.json', {
      before,
      after,
      pixelHash,
      requested,
      totals: requestSummary(fixture.requests),
    });
    expect(fixture.errors).toEqual([]);
  });
});
