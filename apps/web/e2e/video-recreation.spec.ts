import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  canvasDocumentSchema,
  PROMPT_SKILLS,
  type RunRecord,
  type VideoRecreationTemplate,
} from '@multimodal-canvas/domain';

test.use({ serviceWorkers: 'block' });
/** 合成连接标识用于检验分组模型冻结，不包含真实凭据。 */
const analysisCredentialId = 'fe3d8520-9f64-4daa-8364-7b0987123651';
/** 合成全片分析仅用于验证流程，不代表真实视频理解效果。 */
const template: VideoRecreationTemplate = {
  version: 1,
  durationSeconds: 10,
  roles: [{ id: 'character_a', label: '主角' }],
  shots: [
    {
      startSeconds: 0,
      endSeconds: 4,
      action: 'character_a抬手转身，商品保持在右手',
      camera: '中景向前跟随',
    },
    {
      startSeconds: 4,
      endSeconds: 10,
      action: 'character_a将商品朝向镜头，停住展示',
      camera: '推进至商品特写',
    },
  ],
  unknowns: ['原包装文字无法确认'],
};
/** 仓库内媒体不产生外部下载。 */
const image = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
const video = readFileSync(new URL('../public/demo/field-study.mp4', import.meta.url));
const project = {
  id: 'recreation-browser',
  name: '短视频复刻验收',
  createdAt: '2026-10-04T00:00:00Z',
  updatedAt: '2026-10-04T00:00:00Z',
};
/** 返回合成API对象。 */
async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
}

/** 拦截所有API与付费请求，保存操作只写本次测试的内存。 */
async function fixture(page: Page, sourceLatestVersion = 2, saveDelayMs = 0) {
  let canvas = canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: 'source-video',
        type: 'video',
        position: { x: 100, y: 100 },
        width: 400,
        height: 266,
        data: {
          label: '参考短视频',
          mediaType: 'video',
          mode: 'source',
          assetId: 'clip',
          contentUrl: '/v1/assets/clip/versions/2/content',
          mimeType: 'video/mp4',
        },
      },
    ],
    edges: [],
  });
  const assets = [
    {
      id: 'clip',
      name: '参考短视频',
      mediaType: 'video',
      mimeType: 'video/mp4',
      latestVersion: sourceLatestVersion,
      sizeBytes: video.length,
      status: 'ready',
      contentUrl: '/v1/assets/clip/versions/' + sourceLatestVersion + '/content',
      tags: [],
      metadata: { durationSeconds: sourceLatestVersion === 2 ? 10 : 20 },
    },
    ...['person-a', 'person-b', 'product'].map((id) => ({
      id,
      name: id === 'product' ? '新商品' : id === 'person-a' ? '我的人物' : '另一人物',
      mediaType: 'image',
      mimeType: 'image/jpeg',
      latestVersion: 3,
      sizeBytes: image.length,
      status: 'ready',
      contentUrl: '/v1/assets/' + id + '/versions/3/content',
      tags: [],
      metadata: {},
    })),
  ];
  const user = {
    id: 'recreation-user',
    displayName: '复刻验收',
    email: 'recreation@example.test',
    role: 'user',
    createdAt: '2026-10-04T00:00:00Z',
  };
  const posts: Record<string, unknown>[] = [];
  /** 媒体 access-url 的 POST 只读取播放票据；除此之外，任何 POST 都必须由明确操作触发。 */
  const postPaths: string[] = [];
  const generates: RunRecord[] = [];
  const uploads: string[] = [];
  const errors: string[] = [];
  let analysis: Record<string, unknown> | null = null;
  let hold = false;
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.addInitScript((user) => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-recreation-browser',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        user,
      }),
    );
  }, user);
  const base = test.info().project.use.baseURL;
  if (!base || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
    throw Error('只能使用本地浏览器验收入口');
  await page.context().route('**/*', (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (
      url.origin === new URL(base).origin &&
      request.method() === 'GET' &&
      !url.pathname.startsWith('/v1/')
    )
      return route.continue();
    errors.push('未声明外部请求：' + url.origin + url.pathname);
    return route.abort('blockedbyclient');
  });
  await page.route('**/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    if (method === 'POST' && !/^\/v1\/assets\/[^/]+\/access-url$/.test(path)) postPaths.push(path);
    if (method === 'GET' && path === '/v1/auth/me')
      return json(route, { user, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    if (path === '/v1/settings/ai')
      return json(route, {
        settings: {
          defaultModels: {
            text: { modelAlias: 'vision-test', credentialId: analysisCredentialId },
            video: { modelAlias: 'MiniMax-H3' },
          },
        },
      });
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === '/v1/projects/' + project.id) return json(route, { project });
    if (path === '/v1/projects/' + project.id + '/canvas') {
      if (method === 'PATCH') {
        if (saveDelayMs) await new Promise((resolve) => setTimeout(resolve, saveDelayMs));
        canvas = canvasDocumentSchema.parse({
          ...req.postDataJSON(),
          revision: canvas.revision + 1,
        });
      }
      return json(route, { canvas });
    }
    if (path === '/v1/projects/' + project.id + '/events')
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/v1/projects/' + project.id + '/models/defaults')
      return json(route, {
        defaults: {
          text: { modelAlias: 'vision-test', credentialId: analysisCredentialId },
          video: { modelAlias: 'MiniMax-H3' },
        },
      });
    if (path === '/v1/projects/' + project.id + '/runs') return json(route, { runs: generates });
    if (path === '/v1/models')
      return json(route, {
        models: [
          {
            id: 'vision-test',
            credentialId: analysisCredentialId,
            name: '视频分析模型',
            mediaTypes: ['text'],
            available: true,
            capabilities: { mentionMediaTypes: ['video'] },
          },
          {
            id: 'MiniMax-H3',
            name: '参考视频生成模型',
            mediaTypes: ['video'],
            available: true,
            capabilities: { mentionMediaTypes: ['image', 'video'] },
          },
        ],
      });
    if (path === '/v1/prompt-skills')
      return json(route, {
        skills: PROMPT_SKILLS.map((s) => ({ ...s, builtin: true, enabled: true, revision: 1 })),
      });
    if (path === '/v1/assets/uploads/init' && method === 'POST') {
      uploads.push('init');
      expect(req.postDataJSON().name).toBe('我的人物.jpg');
      return json(route, {
        uploadId: 'character-upload',
        uploadUrl: '/v1/assets/uploads/recreation-bytes',
        completeUrl: '/v1/assets/uploads/complete',
      });
    }
    if (path === '/v1/assets/uploads/recreation-bytes' && method === 'PUT') {
      uploads.push('bytes');
      expect(req.postDataBuffer()).toEqual(image);
      return route.fulfill({ status: 204 });
    }
    if (path === '/v1/assets/uploads/complete' && method === 'POST') {
      uploads.push('complete');
      expect(req.postDataJSON().uploadId).toBe('character-upload');
      const uploaded = {
        ...assets.find((entry) => entry.id === 'person-a')!,
        id: 'uploaded-character',
        name: '我的人物.jpg',
        latestVersion: 5,
        contentUrl: '/v1/assets/uploaded-character/versions/5/content',
      };
      assets.push(uploaded);
      return json(route, { asset: uploaded }, 201);
    }
    if (path === '/v1/assets') return json(route, { assets });
    const assetMatch = /^\/v1\/assets\/([^/]+)/.exec(path);
    const asset = assets.find((a) => a.id === assetMatch?.[1]);
    if (asset && path.endsWith('/versions'))
      return json(route, {
        versions: [
          ...new Set(asset.id === 'clip' ? [2, asset.latestVersion] : [asset.latestVersion]),
        ].map((version) => ({
          id: asset.id + 'v' + version,
          assetId: asset.id,
          version,
          sizeBytes: asset.sizeBytes,
          metadata: asset.id === 'clip' && version === 2 ? { durationSeconds: 10 } : asset.metadata,
          createdAt: project.createdAt,
          contentUrl: '/v1/assets/' + asset.id + '/versions/' + version + '/content',
        })),
      });
    if (asset && path.endsWith('/access-url')) return json(route, { url: asset.contentUrl });
    if (asset && (path.endsWith('/content') || path.endsWith('/derivatives/thumbnail')))
      return route.fulfill({
        contentType: asset.mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
        body: asset.mediaType === 'video' ? video : image,
      });
    if (path === '/v1/assets/clip/versions/2/reverse-prompts') {
      if (method === 'POST') {
        const body = req.postDataJSON();
        posts.push(body);
        const pending = canvas.nodes.find((n) => n.data.videoRecreation)?.data.videoRecreation
          ?.request;
        expect(pending?.idempotencyKey).toBe(body.idempotencyKey);
        expect(body.purpose).toBe('video_recreation');
        expect(body.credentialId).toBe(analysisCredentialId);
        expect(pending?.credentialId).toBe(analysisCredentialId);
        analysis = {
          runId: 'analysis-1',
          assetId: 'clip',
          assetVersion: 2,
          purpose: 'video_recreation',
          status: 'queued',
          modelAlias: 'vision-test',
          credentialId: analysisCredentialId,
        };
        return json(route, { analysis }, 202);
      }
      expect(url.searchParams.get('purpose')).toBe('video_recreation');
      return json(route, {
        analysis: analysis
          ? {
              ...analysis,
              status: hold ? 'running' : 'succeeded',
              ...(hold
                ? {}
                : { summary: '整条视频两个连续镜头', prompt: JSON.stringify(template) }),
            }
          : null,
        defaultModel: { modelAlias: 'vision-test', credentialId: analysisCredentialId },
      });
    }
    const target = canvas.nodes.find((n) => path === '/v1/nodes/' + n.id + '/runs');
    if (method === 'POST' && target) {
      const now = new Date().toISOString();
      const run: RunRecord = {
        id: 'recreation-generation-' + (generates.length + 1),
        projectId: project.id,
        targetNodeId: target.id,
        status: 'succeeded',
        progress: 100,
        attempt: 1,
        provider: 'mock',
        modelAlias: target.data.modelAlias!,
        createdAt: now,
        updatedAt: now,
        snapshot: {
          projectId: project.id,
          canvasRevision: canvas.revision,
          targetNodeId: target.id,
          modelAlias: target.data.modelAlias!,
          submittedAt: now,
          nodes: canvas.nodes,
          edges: [],
          inputs: [],
          parameters: target.data.parameters ?? {},
        },
      };
      generates.push(run);
      return json(route, { run }, 202);
    }
    if (path.startsWith('/v1/runs/')) {
      const run = generates.find((r) => r.id === path.split('/').at(-1));
      if (run) return json(route, { run });
    }
    errors.push('未声明接口：' + method + ' ' + path);
    return json(route, { error: '未声明接口' }, 404);
  });
  return {
    canvas: () => canvas,
    posts,
    postPaths,
    generates,
    uploads,
    errors,
    hold: (value: boolean) => {
      hold = value;
    },
  };
}
/** 从视频回显创建专属节点，不执行分析。 */
async function createNode(page: Page) {
  await page.goto('/projects/' + project.id);
  const source = page.locator('.react-flow__node[data-id="source-video"]');
  await expect(source).toBeVisible();
  await source.hover();
  await source.getByRole('button', { name: '复刻短视频：参考短视频', exact: true }).click();
  const node = page
    .locator('.react-flow__node')
    .filter({ has: page.getByRole('group', { name: '节点操作：短视频复刻', exact: true }) });
  await expect(node).toBeVisible();
  await node.getByText('尚未生成', { exact: true }).click();
  await expect(page.getByRole('region', { name: '短视频复刻', exact: true })).toBeVisible();
  return node;
}
/** 只重开既有节点。 */
async function openRecreation(page: Page, id: string) {
  const node = page.locator('.react-flow__node[data-id="' + id + '"]');
  await expect(node).toBeVisible();
  await node.getByText('尚未生成', { exact: true }).click();
  return page.getByRole('region', { name: '短视频复刻', exact: true });
}

/**
 * 验证共享说明是完整四步有序列表，明确整条视频、人物、可选商品和手动生成边界。
 * @param guide 具有“短视频复刻使用流程”可访问名称的有序列表。
 * @returns 全部断言通过后完成；缺少步骤或必要边界时由 Playwright 报错。
 */
async function expectRecreationGuide(guide: Locator) {
  await expect(guide).toBeVisible();
  await expect(guide).toHaveJSProperty('tagName', 'OL');
  await expect(guide.getByRole('listitem')).toHaveCount(4);
  await expect(guide).toContainText('整条视频');
  await expect(guide).toContainText('人物');
  await expect(guide).toContainText('商品');
  await expect(guide).toContainText('可选');
  await expect(guide.getByRole('listitem').last()).toContainText('生成');
  await expect(guide).toContainText(/手动|点击.{0,15}生成|明确.{0,15}生成/);
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 1366, height: 768 },
]) {
  test(
    'PC ' +
      viewport.width +
      '×' +
      viewport.height +
      ' 常驻入口、流程和失焦标识可发现，分析生成须明确点击',
    async ({ page }, info) => {
      await page.setViewportSize(viewport);
      const ctx = await fixture(page);
      await page.goto('/projects/' + project.id);
      const source = page.locator('.react-flow__node[data-id="source-video"]');
      await expect(source).toBeVisible({ timeout: 15000 });
      const sourceBefore = structuredClone(ctx.canvas().nodes[0]!);
      await page.mouse.move(0, 0);
      await expect(source).not.toHaveClass(/\bselected\b/);
      expect(await source.evaluate((element) => element.matches(':hover'))).toBe(false);
      const entry = page
        .getByRole('group', { name: '节点组', exact: true })
        .getByRole('button', { name: '短视频复刻', exact: true });
      await expect(entry).toBeVisible();
      await expect(entry).toBeInViewport({ ratio: 1 });
      await expect(entry.getByText('短视频复刻', { exact: true })).toBeVisible();
      await expect(entry.locator('svg.lucide-clapperboard')).toBeVisible();
      expect(await entry.evaluate((element) => element.matches(':hover'))).toBe(false);
      await expect(
        page.getByRole('group', { name: '创建节点', exact: true }).getByRole('button'),
      ).toHaveCount(4);
      expect(ctx.postPaths).toEqual([]);
      await page.screenshot({ path: info.outputPath('recreation-entry.png'), fullPage: true });

      await entry.click();
      const dialog = page.getByRole('dialog', { name: '短视频复刻 · 使用流程', exact: true });
      await expect(dialog).toBeVisible();
      const guide = dialog.getByRole('list', { name: '短视频复刻使用流程', exact: true });
      await expectRecreationGuide(guide);
      const reference = dialog.getByRole('combobox', { name: '参考视频节点', exact: true });
      await expect(reference).toHaveJSProperty('tagName', 'SELECT');
      await expect(reference).toHaveValue('source-video');
      await expect(reference.locator('option:checked')).toContainText('参考短视频');
      await expect(reference.getByRole('option', { name: /参考短视频/ })).toHaveCount(1);
      expect(ctx.canvas().nodes).toHaveLength(1);
      expect(ctx.postPaths).toEqual([]);
      const create = dialog.getByRole('button', { name: '创建复刻节点', exact: true });
      await expect(create).toBeEnabled();
      await create.scrollIntoViewIfNeeded();
      await expect(create).toBeInViewport({ ratio: 1 });
      await expect(dialog).toBeInViewport({ ratio: 0.99 });
      const dialogLayout = await dialog.evaluate((element) => {
        /** 读取布局边界与实际生效的尺寸约束，供裁切失败定位，不修改 DOM 或样式。 */
        const measure = (target: Element) => {
          const bounds = target.getBoundingClientRect();
          const style = getComputedStyle(target);
          return {
            bounds: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              top: bounds.top,
              right: bounds.right,
              bottom: bounds.bottom,
              left: bounds.left,
            },
            style: {
              maxHeight: style.maxHeight,
              height: style.height,
              padding: style.padding,
              paddingBottom: style.paddingBottom,
              borderBottomWidth: style.borderBottomWidth,
              display: style.display,
              minHeight: style.minHeight,
              boxSizing: style.boxSizing,
              overflow: style.overflow,
              flexShrink: style.flexShrink,
            },
            clientHeight: target.clientHeight,
            scrollHeight: target.scrollHeight,
            scrollTop: target.scrollTop,
          };
        };
        const footer = element.querySelector('footer');
        const button = [...element.querySelectorAll('button')].find(
          (candidate) => candidate.textContent?.trim() === '创建复刻节点',
        );
        if (!footer || !button) throw new Error('复刻流程缺少 footer 或创建按钮');
        return {
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
          scrollable: [element, ...element.querySelectorAll('*')].some((child) =>
            /^(auto|scroll)$/.test(getComputedStyle(child).overflowY),
          ),
          dialog: measure(element),
          footer: measure(footer),
          createButton: measure(button),
        };
      });
      const layoutPath = info.outputPath('recreation-dialog-layout.json');
      writeFileSync(layoutPath, JSON.stringify({ viewport, ...dialogLayout }, null, 2));
      await info.attach('复刻弹窗边界', { path: layoutPath, contentType: 'application/json' });
      expect(dialogLayout.scrollable).toBe(true);
      expect(dialogLayout.scrollWidth).toBeLessThanOrEqual(dialogLayout.width + 1);
      expect(
        await guide.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      await page.screenshot({ path: info.outputPath('recreation-use-guide.png'), fullPage: true });
      const paddingBottom = Number.parseFloat(dialogLayout.dialog.style.paddingBottom);
      const borderBottom = Number.parseFloat(dialogLayout.dialog.style.borderBottomWidth);
      const innerBottom = dialogLayout.dialog.bounds.bottom - borderBottom - paddingBottom;
      const buttonBottomGap =
        dialogLayout.dialog.bounds.bottom - borderBottom - dialogLayout.createButton.bounds.bottom;
      expect(
        buttonBottomGap,
        '创建按钮底部须保留弹窗声明的 padding，且至少留出 12px 安全区',
      ).toBeGreaterThanOrEqual(Math.max(12, paddingBottom) - 1);
      expect(
        dialogLayout.footer.bounds.bottom,
        'footer 不得进入弹窗底部 padding 或被容器裁切',
      ).toBeLessThanOrEqual(innerBottom + 1);

      await create.click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => ctx.canvas().nodes.length).toBe(2);
      const saved = ctx.canvas().nodes.find((item) => item.data.videoRecreation)!;
      const node = page.locator('.react-flow__node[data-id="' + saved.id + '"]');
      await expect(node).toBeVisible();
      expect(saved.data.videoRecreation?.source).toMatchObject({
        sourceNodeId: 'source-video',
        assetId: 'clip',
        assetVersion: 2,
        durationSeconds: 10,
      });
      expect(ctx.canvas().nodes.find((item) => item.id === sourceBefore.id)).toEqual(sourceBefore);
      expect(ctx.posts).toHaveLength(0);
      expect(ctx.generates).toHaveLength(0);
      expect(ctx.postPaths).toEqual([]);
      const size = await node.boundingBox();
      expect(size).not.toBeNull();
      // 左上角导航覆盖画布；在资源栏右侧的空白区域取消选择，不使用强制点击。
      await page.locator('.react-flow__pane').click({ position: { x: 300, y: 220 } });
      await page.mouse.move(0, 0);
      await expect(node).not.toHaveClass(/\bselected\b/);
      expect(await node.evaluate((element) => element.matches(':hover'))).toBe(false);
      const badge = node.locator('.flow-node-recreation-badge');
      await expect(badge).toBeVisible();
      // React Flow 缩放会产生 0.99999982 之类的交集浮点误差；保留百万分之一容差并核对完整边界。
      await expect(badge).toBeInViewport({ ratio: 1 - 1e-6 });
      const badgeBounds = await badge.boundingBox();
      expect(badgeBounds).not.toBeNull();
      expect(badgeBounds!.x).toBeGreaterThanOrEqual(0);
      expect(badgeBounds!.y).toBeGreaterThanOrEqual(0);
      expect(badgeBounds!.x + badgeBounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(badgeBounds!.y + badgeBounds!.height).toBeLessThanOrEqual(viewport.height);
      await expect(badge).toContainText('短视频复刻');
      await expect(badge.locator('svg.lucide-clapperboard')).toBeVisible();
      // Playwright 的可见性断言不排除 opacity: 0；同时检查祖先，避免隐藏在悬浮工具栏内。
      expect(
        await badge.evaluate((element) => {
          for (let current: Element | null = element; current; current = current.parentElement) {
            if (Number(getComputedStyle(current).opacity) === 0) return false;
          }
          return true;
        }),
      ).toBe(true);
      await expect(node.getByText('尚未生成', { exact: true })).toBeVisible();
      await expect(node.getByText('点击节点，按流程开始复刻', { exact: true })).toBeVisible();
      const deselectedSize = await node.boundingBox();
      expect(deselectedSize?.width).toBeCloseTo(size!.width, 0);
      expect(deselectedSize?.height).toBeCloseTo(size!.height, 0);
      await page.screenshot({ path: info.outputPath('recreation-node-badge.png'), fullPage: true });

      await node.getByText('尚未生成', { exact: true }).click();
      const panel = page.getByRole('region', { name: '短视频复刻', exact: true });
      await expect(panel).toBeVisible();
      await expect(
        panel
          .getByRole('heading', { name: '短视频复刻', exact: true })
          .locator('svg.lucide-clapperboard'),
      ).toBeVisible();
      const flowPath = panel.locator('.video-recreation-path');
      await expect(flowPath).toHaveText('分析整条视频 → 提供人物 → 可选换商品 → 生成');
      await flowPath.scrollIntoViewIfNeeded();
      await expect(flowPath).toBeInViewport({ ratio: 1 });
      const flowSummary = panel.locator('summary', { hasText: /^使用流程$/ });
      await expect(flowSummary).toBeVisible();
      await flowSummary.click();
      const panelGuide = panel.getByRole('list', { name: '短视频复刻使用流程', exact: true });
      await expectRecreationGuide(panelGuide);
      const panelSteps = panelGuide.getByRole('listitem');
      await panelSteps.first().scrollIntoViewIfNeeded();
      await expect(panelSteps.first()).toBeInViewport({ ratio: 1 });
      await panelSteps.last().scrollIntoViewIfNeeded();
      await expect(panelSteps.last()).toBeInViewport({ ratio: 1 });
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      expect(ctx.postPaths).toEqual([]);
      const expandedSize = await node.boundingBox();
      expect(expandedSize?.width).toBeCloseTo(size!.width, 0);
      expect(expandedSize?.height).toBeCloseTo(size!.height, 0);
      await page.screenshot({ path: info.outputPath('recreation-panel-flow.png'), fullPage: true });

      await flowSummary.click();
      await page.getByRole('button', { name: '打开完整编辑器', exact: true }).click();
      const fullEditor = page.getByRole('dialog', { name: '短视频复刻 · 编辑设置', exact: true });
      await expect(fullEditor).toBeVisible();
      const fullPanel = fullEditor.getByRole('region', { name: '短视频复刻', exact: true });
      await fullPanel.locator('summary', { hasText: /^使用流程$/ }).click();
      const fullGuide = fullPanel.getByRole('list', { name: '短视频复刻使用流程', exact: true });
      await expectRecreationGuide(fullGuide);
      await fullGuide.scrollIntoViewIfNeeded();
      await expect(fullGuide).toBeInViewport({ ratio: 1 });
      await expect(
        fullPanel.getByRole('heading', { name: '短视频复刻', exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect(ctx.postPaths).toEqual([]);
      await page.screenshot({
        path: info.outputPath('recreation-full-editor-flow.png'),
        fullPage: true,
      });
      await fullEditor.getByRole('button', { name: '关闭编辑器', exact: true }).click();
      await expect(fullEditor).toBeHidden();
      await expect(panel).toBeVisible();
      const closedEditorSize = await node.boundingBox();
      expect(closedEditorSize?.width).toBeCloseTo(size!.width, 0);
      expect(closedEditorSize?.height).toBeCloseTo(size!.height, 0);
      await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
      await expect(panel.getByRole('combobox', { name: '主角', exact: true })).toBeVisible();
      expect(ctx.posts).toHaveLength(1);
      expect(ctx.postPaths).toEqual(['/v1/assets/clip/versions/2/reverse-prompts']);
      expect(ctx.generates).toHaveLength(0);
      const generate = page
        .locator('.node-quick-editor')
        .getByRole('button', { name: '生成', exact: true });
      await expect(generate).toBeDisabled();
      await panel.getByRole('combobox', { name: '主角', exact: true }).selectOption('person-a');
      await expect
        .poll(() => ctx.canvas().nodes.find((item) => item.id === saved.id)?.data.prompt)
        .toContain('Full observed duration: 10 seconds');
      await expect(generate).toBeEnabled();
      expect(ctx.postPaths).toEqual(['/v1/assets/clip/versions/2/reverse-prompts']);
      expect(ctx.generates).toHaveLength(0);
      await generate.click();
      await expect.poll(() => ctx.generates.length).toBe(1);
      expect(ctx.postPaths).toEqual([
        '/v1/assets/clip/versions/2/reverse-prompts',
        '/v1/nodes/' + saved.id + '/runs',
      ]);
      expect(ctx.posts).toHaveLength(1);
      expect(ctx.errors).toEqual([]);
    },
  );
}

test('整条分析、绑定人物、自动组装和明确生成，保存重载不重复分析', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ctx = await fixture(page);
  const node = await createNode(page);
  const size = await node.boundingBox();
  const panel = page.getByRole('region', { name: '短视频复刻', exact: true });
  expect(ctx.posts).toHaveLength(0);
  expect(ctx.generates).toHaveLength(0);
  await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '主角', exact: true })).toBeVisible();
  await panel.getByRole('combobox', { name: '主角', exact: true }).selectOption('person-a');
  await expect
    .poll(() => ctx.canvas().nodes.find((n) => n.data.videoRecreation)?.data.prompt)
    .toContain('Full observed duration: 10 seconds');
  const saved = ctx.canvas().nodes.find((n) => n.data.videoRecreation)!;
  expect(saved.data.parameters?.duration).toBe(10);
  expect(saved.data.resourceRefs?.map((r) => r.assetId)).toEqual(['clip', 'person-a']);
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  const after = await node.boundingBox();
  expect(after?.width).toBeCloseTo(size!.width, 0);
  expect(after?.height).toBeCloseTo(size!.height, 0);
  await page.screenshot({ path: info.outputPath('recreation-bound-desktop.png'), fullPage: true });
  await page.reload();
  const restored = await openRecreation(page, saved.id);
  await expect(restored.getByRole('combobox', { name: '主角', exact: true })).toHaveValue(
    'person-a',
  );
  expect(ctx.posts).toHaveLength(1);
  await page
    .locator('.node-quick-editor')
    .getByRole('button', { name: '生成', exact: true })
    .click();
  await expect.poll(() => ctx.generates.length).toBe(1);
  expect(
    ctx.generates[0]!.snapshot.nodes?.find((n) => n.id === saved.id)?.data.videoRecreation?.source,
  ).toMatchObject({ assetId: 'clip', assetVersion: 2 });
  expect(ctx.errors).toEqual([]);
});

test('更换人物和商品不重复分析，慢保存不打断商品说明连续输入', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ctx = await fixture(page, 2, 150);
  await createNode(page);
  const panel = page.getByRole('region', { name: '短视频复刻', exact: true });
  await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
  await panel.getByRole('combobox', { name: '主角', exact: true }).selectOption('person-a');
  await panel.getByRole('combobox', { name: '主角', exact: true }).selectOption('person-b');
  await panel.getByRole('combobox', { name: /商品/ }).selectOption('product');
  await expect(
    page.locator('.node-quick-editor').getByRole('button', { name: '生成', exact: true }),
  ).toBeDisabled();
  const description = '香水，喷洒使用；不饮用，不添加未确认功效';
  const productInput = panel.getByRole('textbox', { name: /用途|卖点/ });
  await productInput.click();
  await productInput.pressSequentially(description, { delay: 10 });
  await expect(productInput).toHaveValue(description);
  await expect(productInput).toBeFocused();
  await expect
    .poll(
      () =>
        ctx.canvas().nodes.find((n) => n.data.videoRecreation)?.data.videoRecreation
          ?.productDescription,
    )
    .toBe(description);
  await expect
    .poll(() => ctx.canvas().nodes.find((n) => n.data.videoRecreation)?.data.prompt)
    .toContain('Never drink perfume');
  expect(
    ctx
      .canvas()
      .nodes.find((n) => n.data.videoRecreation)
      ?.data.resourceRefs?.map((r) => r.assetId),
  ).toEqual(['clip', 'person-b', 'product']);
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});

test('保存分析任务后刷新只查询原run，不重新POST', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const ctx = await fixture(page);
  ctx.hold(true);
  await createNode(page);
  await page
    .getByRole('region', { name: '短视频复刻', exact: true })
    .getByRole('button', { name: '分析整条视频', exact: true })
    .click();
  await expect
    .poll(
      () =>
        ctx.canvas().nodes.find((n) => n.data.videoRecreation)?.data.videoRecreation?.request
          ?.runId,
    )
    .toBe('analysis-1');
  const saved = ctx.canvas().nodes.find((n) => n.data.videoRecreation)!;
  await page.reload();
  await openRecreation(page, saved.id);
  expect(ctx.posts).toHaveLength(1);
  ctx.hold(false);
  await expect(page.getByRole('combobox', { name: '主角', exact: true })).toBeVisible({
    timeout: 10000,
  });
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});

test('历史回显冻结旧版本时长，较小PC完整编辑器可完成绑定', async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const ctx = await fixture(page, 3);
  const node = await createNode(page);
  const bounds = await node.boundingBox();
  await page.getByRole('button', { name: '打开完整编辑器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '短视频复刻 · 编辑设置', exact: true });
  const panel = dialog.getByRole('region', { name: '短视频复刻', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
  await panel.getByRole('combobox', { name: '主角', exact: true }).selectOption('person-a');
  await expect
    .poll(() => ctx.canvas().nodes.find((n) => n.data.videoRecreation)?.data.prompt)
    .toContain('Full observed duration: 10 seconds');
  const saved = ctx.canvas().nodes.find((n) => n.data.videoRecreation)!;
  expect(saved.data.videoRecreation?.source).toMatchObject({
    assetVersion: 2,
    durationSeconds: 10,
  });
  expect(saved.data.parameters?.duration).toBe(10);
  expect(saved.data.resourceRefs?.map((r) => [r.assetId, r.assetVersion])).toEqual([
    ['clip', 2],
    ['person-a', 3],
  ]);
  await expect(dialog.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
  await panel.getByRole('combobox', { name: '主角', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('recreation-expanded-pc.png'), fullPage: true });
  await dialog.getByRole('button', { name: '关闭编辑器', exact: true }).click();
  const after = await node.boundingBox();
  expect(after?.width).toBeCloseTo(bounds!.width, 0);
  expect(after?.height).toBeCloseTo(bounds!.height, 0);
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});

test('只上传人物图片即可绑定真实返回版本，不额外分析或自动生成', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ctx = await fixture(page);
  await createNode(page);
  const panel = page.getByRole('region', { name: '短视频复刻', exact: true });
  await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
  await panel.getByLabel('上传主角图片', { exact: true }).setInputFiles({
    name: '我的人物.jpg',
    mimeType: 'image/jpeg',
    buffer: image,
  });
  await expect
    .poll(
      () => ctx.canvas().nodes.find((n) => n.data.videoRecreation)?.data.videoRecreation?.bindings,
    )
    .toEqual([
      {
        roleId: 'character_a',
        assetId: 'uploaded-character',
        assetVersion: 5,
        name: '我的人物.jpg',
      },
    ]);
  await expect(panel.getByRole('combobox', { name: '主角', exact: true })).toHaveValue(
    'uploaded-character',
  );
  const saved = ctx.canvas().nodes.find((n) => n.data.videoRecreation)!;
  expect(saved.data.resourceRefs?.map((r) => [r.assetId, r.assetVersion])).toEqual([
    ['clip', 2],
    ['uploaded-character', 5],
  ]);
  expect(saved.data.videoRecreation?.product).toBeUndefined();
  expect(ctx.uploads).toEqual(['init', 'bytes', 'complete']);
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});
