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
  dialogue: [{ startSeconds: 1.2, endSeconds: 2.8, speakerId: 'character_a', text: '请看这个。' }],
  unknowns: ['原包装文字无法确认'],
};
/** 两个人物与两件物品的合成识别结果，仅验证选择、定位和保存，不代表演示视频真实内容。 */
const identifiedTemplate: VideoRecreationTemplate = {
  version: 1,
  durationSeconds: 10,
  roles: [
    {
      id: 'character_a',
      label: '主角',
      description: '画面左侧人物，右手拿着香水瓶',
      appearances: [{ startSeconds: 0, endSeconds: 10 }],
      preview: {
        timestampSeconds: 0.3,
        boundingBox: { x: 0.05, y: 0.05, width: 0.4, height: 0.85 },
      },
    },
    {
      id: 'character_b',
      label: '同伴',
      description: '画面右侧人物，提着手提袋',
      appearances: [{ startSeconds: 1, endSeconds: 10 }],
      preview: {
        timestampSeconds: 1.2,
        boundingBox: { x: 0.55, y: 0.05, width: 0.35, height: 0.85 },
      },
    },
  ],
  products: [
    {
      id: 'product_a',
      label: '香水瓶',
      description: '主角右手的小瓶，浅色矩形瓶盖',
      appearances: [{ startSeconds: 0, endSeconds: 10 }],
      preview: {
        timestampSeconds: 0.7,
        boundingBox: { x: 0.25, y: 0.3, width: 0.2, height: 0.4 },
      },
    },
    {
      id: 'product_b',
      label: '手提袋',
      description: '同伴手中的方形手提袋，文字无法确认',
      appearances: [{ startSeconds: 1, endSeconds: 10 }],
      preview: {
        timestampSeconds: 2,
        boundingBox: { x: 0.55, y: 0.4, width: 0.3, height: 0.5 },
      },
    },
  ],
  shots: [
    {
      startSeconds: 0,
      endSeconds: 4,
      action: 'character_a拿着product_a向前转身，character_b在右侧提着product_b',
      camera: '中景向前跟随',
    },
    {
      startSeconds: 4,
      endSeconds: 10,
      action: 'character_a将product_a朝向镜头展示，character_b将product_b保持在身侧',
      camera: '推进至product_a特写',
    },
  ],
  unknowns: ['原包装与手提袋文字无法确认'],
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

/** 通过触发器关联的 Ant Design 下拉选择，避免误点退出动画中的其他同名选项。 */
async function selectOption(select: Locator, option: string | RegExp) {
  await select.click();
  await expect(select).toHaveAttribute('aria-expanded', 'true');
  const listId = await select.getAttribute('aria-controls');
  expect(listId).toBeTruthy();
  const listbox = select.page().locator('[id="' + listId + '"]');
  await listbox.getByRole('option', { name: option }).click();
  await expect(select).toHaveAttribute('aria-expanded', 'false');
  await expect(listbox).toBeHidden();
}

/** Ant Design 搜索输入值与绑定无关；核对可见选中标签。 */
async function expectSelection(select: Locator, label: string) {
  await expect(select.locator('xpath=ancestor::*[contains(@class,"ant-select")][1]')).toContainText(
    label,
  );
}

/**
 * 拦截所有 API 与付费请求，保存只写测试内存；现代识别夹具不改变旧格式场景。
 * @param identified 使用带人物、物品定位的合成结果及文本 qwen 目录项。
 * @param generationMediaType 为 image 时返回成功归档图片，验证原视频节点的结果展示。
 */
async function fixture(
  page: Page,
  sourceLatestVersion = 2,
  saveDelayMs = 0,
  identified = false,
  generationMediaType?: 'image',
) {
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
      name: '参考短视频-人物与商品逐项替换-保留完整镜头动作和逐句台词-文件名较长仍然冻结原版本-不能撑大来源栏.mp4',
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
  /** 只在项目搜索响应出现，初次画布资源缓存不含该图片。 */
  const remotePortrait = {
    ...assets[1]!,
    id: 'remote-person',
    name: '项目新人物',
    latestVersion: 8,
    contentUrl: '/v1/assets/remote-person/versions/8/content',
  };
  const resourceSearches: { query: string; mediaType: string; page: string; projectId: string }[] =
    [];
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
  /** 来源内容读取记录用于区分节点播放和同批对象共享的截帧请求。 */
  const sourceContentRequests: { path: string; resourceType: string }[] = [];
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
    if (method === 'GET' && /^\/v1\/assets\/clip\/versions\/\d+\/content$/.test(path))
      sourceContentRequests.push({ path, resourceType: req.resourceType() });
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
          ...(identified
            ? [
                {
                  id: 'qwen3.8-omni-flash',
                  credentialId: analysisCredentialId,
                  name: 'qwen3.8-omni-flash',
                  mediaTypes: ['text'],
                  available: true,
                },
                {
                  id: 'sora-2',
                  name: '独立视频生成模型',
                  mediaTypes: ['video'],
                  available: true,
                },
              ]
            : []),
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
    if (path === '/v1/assets') {
      if (url.searchParams.get('mediaType') === 'image') {
        const query = url.searchParams.get('query') ?? '';
        resourceSearches.push({
          query,
          mediaType: url.searchParams.get('mediaType')!,
          page: url.searchParams.get('page')!,
          projectId: url.searchParams.get('projectId')!,
        });
        const matching = [...assets, remotePortrait].filter(
          (asset) => asset.mediaType === 'image' && asset.name.includes(query),
        );
        return json(route, { assets: matching, total: matching.length, page: 1, pageSize: 50 });
      }
      return json(route, { assets });
    }
    const assetMatch = /^\/v1\/assets\/([^/]+)/.exec(path);
    const asset = [...assets, remotePortrait].find((a) => a.id === assetMatch?.[1]);
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
    if (asset && path.endsWith('/access-url')) {
      const scope = method === 'POST' ? req.postDataJSON() : {};
      return json(route, {
        url: scope.version
          ? '/v1/assets/' + asset.id + '/versions/' + scope.version + '/content'
          : asset.contentUrl,
      });
    }
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
        expect(pending?.modelAlias).toBe(body.modelAlias);
        expect(pending?.credentialId).toBe(body.credentialId);
        analysis = {
          runId: 'analysis-1',
          assetId: 'clip',
          assetVersion: 2,
          purpose: 'video_recreation',
          status: 'queued',
          modelAlias: body.modelAlias,
          ...(body.credentialId ? { credentialId: body.credentialId } : {}),
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
                : {
                    summary: identified ? '整条视频两个人物、两件物品' : '整条视频两个连续镜头',
                    prompt: JSON.stringify(identified ? identifiedTemplate : template),
                  }),
            }
          : null,
        defaultModel: { modelAlias: 'vision-test', credentialId: analysisCredentialId },
      });
    }
    const target = canvas.nodes.find((n) => path === '/v1/nodes/' + n.id + '/runs');
    if (method === 'POST' && target) {
      const now = new Date().toISOString();
      const generatedImage = generationMediaType
        ? {
            ...assets[1]!,
            id: 'recreation-result-image',
            name: '复刻生成图片',
            latestVersion: 7,
            contentUrl: '/v1/assets/recreation-result-image/versions/7/content',
          }
        : undefined;
      if (generatedImage) assets.push(generatedImage);
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
        ...(generatedImage
          ? {
              result: {
                summary: '图片结果已归档',
                mediaType: 'image' as const,
                targetNodeId: target.id,
                provider: 'mock',
                inputCount: 1,
                asset: {
                  assetId: generatedImage.id,
                  version: generatedImage.latestVersion,
                  mimeType: generatedImage.mimeType,
                  sizeBytes: generatedImage.sizeBytes,
                },
              },
            }
          : {}),
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
    sourceContentRequests,
    resourceSearches,
    generates,
    uploads,
    errors,
    hold: (value: boolean) => {
      hold = value;
    },
  };
}
/**
 * 从工具栏创建空草稿，点击节点后在专用 Dialog 绑定来源；历史回显另验证冻结版本入口。
 * @param page 已安装隔离 API Mock 的浏览器页面。
 * @param fromFrozenSource 是否从保存了旧版本的视频节点创建，默认走工具栏草稿流程。
 * @returns 已绑定来源的复刻节点；不执行分析或生成。
 */
async function createNode(page: Page, fromFrozenSource = false) {
  await page.goto('/projects/' + project.id);
  const source = page.locator('.react-flow__node[data-id="source-video"]');
  // Vite 冷启动会按需编译工作区模块，来源就绪后才开始核对交互。
  await expect(source).toBeVisible({ timeout: 15000 });
  if (fromFrozenSource) {
    await source.hover();
    await source.getByRole('button', { name: '复刻短视频：参考短视频', exact: true }).click();
  } else {
    await page
      .getByRole('group', { name: '节点组', exact: true })
      .getByRole('button', { name: '短视频复刻', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const node = page
    .locator('.react-flow__node')
    .filter({ has: page.getByRole('group', { name: '节点操作：短视频复刻', exact: true }) });
  await expect(node).toBeVisible();
  const dialog = await clickRecreationNode(page, node);
  await expect(page.locator('.node-quick-editor')).toHaveCount(0);
  if (!fromFrozenSource) {
    await selectOption(
      dialog.getByRole('combobox', { name: '参考视频', exact: true }),
      /参考短视频/,
    );
    await dialog.getByRole('button', { name: '使用此视频', exact: true }).click();
  }
  await expect(dialog.getByRole('region', { name: '短视频复刻', exact: true })).toBeVisible();
  return node;
}
/** 首次点击聚焦节点，第二次点击同一内容区才打开复刻编辑器。 */
async function clickRecreationNode(page: Page, node: Locator) {
  const dialog = page.getByRole('dialog', { name: '短视频复刻', exact: true });
  const content = node.locator('.flow-node-preview, .flow-node-placeholder').first();
  await expect(content).toBeVisible();
  await content.click({ position: { x: 12, y: 12 } });
  await expect(dialog).toBeHidden();
  await content.click({ position: { x: 12, y: 12 } });
  await expect(dialog).toBeVisible();
  return dialog;
}
/** 在当前视口实际可点到的画布空白处取消节点选择。 */
async function clickEmptyPane(page: Page) {
  const point = await page.locator('.react-flow__pane').evaluate((pane) => {
    const bounds = pane.getBoundingClientRect();
    for (const yRatio of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      for (const xRatio of [0.8, 0.65, 0.5, 0.35, 0.2]) {
        const x = bounds.left + bounds.width * xRatio;
        const y = bounds.top + bounds.height * yRatio;
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    throw new Error('当前视口没有可点击的画布空白位置');
  });
  await page.mouse.click(point.x, point.y);
}
/** 只点击重开既有节点的专用 Dialog，不重新绑定、分析或生成。 */
async function openRecreation(page: Page, id: string) {
  const node = page.locator('.react-flow__node[data-id="' + id + '"]');
  await expect(node).toBeVisible();
  const dialog = await clickRecreationNode(page, node);
  await expect(page.locator('.node-quick-editor')).toHaveCount(0);
  return dialog.getByRole('region', { name: '短视频复刻', exact: true });
}

/**
 * 核对真实 PC 布局尺寸、三栏顺序与有界滚动，尺寸缩小或被正文撑大时失败。
 * @param dialog 专用复刻 Dialog，可处于空草稿或已绑定来源状态。
 * @param viewport 当前 PC 视口尺寸，单位为 CSS 像素。
 * @returns Dialog 和三栏测量值，供截图与浏览器验收记录。
 */
async function expectRecreationLayout(
  dialog: Locator,
  viewport: { width: number; height: number },
) {
  // Modal 入场动画会缩放测量值；动画结束后再核对最终尺寸，不修改页面样式。
  await expect
    .poll(() =>
      dialog.evaluate(
        (element) =>
          element.getAnimations().filter((animation) => animation.playState === 'running').length,
      ),
    )
    .toBe(0);
  const layout = await dialog.evaluate((element) => {
    /** 只读取最终布局和滚动边界，不修改待验收页面。 */
    const measure = (target: Element) => {
      const bounds = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return {
        className: target.getAttribute('class'),
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        right: bounds.right,
        bottom: bounds.bottom,
        overflowY: style.overflowY,
        clientWidth: target.clientWidth,
        scrollWidth: target.scrollWidth,
        clientHeight: target.clientHeight,
        scrollHeight: target.scrollHeight,
        scrollTop: target.scrollTop,
        display: style.display,
        computedHeight: style.height,
        minHeight: style.minHeight,
        gridRows: style.gridTemplateRows,
        position: style.position,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
      };
    };
    const body = element.querySelector('.node-quick-editor-recreation-body');
    const analysis = element.querySelector(
      '.video-recreation-analysis-column, .node-quick-editor-recreation-source',
    );
    const resources = element.querySelector(
      '.video-recreation-resources-column, .node-quick-editor-recreation-pending',
    );
    const generation = element.querySelector('.node-quick-editor-recreation-generate');
    const panel = element.querySelector('.video-recreation-panel');
    const sourceInfo = element.querySelector('.video-recreation-source-meta');
    if (!body || !analysis || !resources || !generation)
      throw new Error('复刻 Dialog 缺少分析、替换或生成栏');
    const wrappers = [];
    for (
      let wrapper = body.parentElement;
      wrapper && wrapper !== element;
      wrapper = wrapper.parentElement
    )
      wrappers.push(measure(wrapper));
    const overlay = element.closest('.ant-modal-wrap');
    const before = overlay ? getComputedStyle(overlay, '::before') : null;
    return {
      dialog: measure(element),
      overlay: overlay ? measure(overlay) : null,
      overlayBefore: before
        ? {
            display: before.display,
            height: before.height,
            width: before.width,
            content: before.content,
          }
        : null,
      wrappers,
      body: measure(body),
      panel: panel ? measure(panel) : null,
      sourceInfo: sourceInfo
        ? {
            ...measure(sourceInfo),
            fields: Array.from(sourceInfo.children, (field) => ({
              ...measure(field),
              text: field.textContent,
              textOverflow: getComputedStyle(field).textOverflow,
            })),
          }
        : null,
      gridColumns: getComputedStyle(body).gridTemplateColumns,
      gridRows: getComputedStyle(body).gridTemplateRows,
      columns: [analysis, resources, generation].map(measure),
    };
  });
  const layoutPath = test
    .info()
    .outputPath(layout.panel ? 'recreation-bound-layout.json' : 'recreation-draft-layout.json');
  writeFileSync(layoutPath, JSON.stringify({ viewport, ...layout }, null, 2));
  await test.info().attach('复刻三栏测量', {
    path: layoutPath,
    contentType: 'application/json',
  });
  await expect(dialog).toBeInViewport({ ratio: 1 - 1e-6 });
  expect(layout.dialog.width).toBeCloseTo(viewport.width * 0.75, 0);
  expect(layout.dialog.height).toBeCloseTo(viewport.height * 0.75, 0);
  expect(layout.dialog.x).toBeCloseTo(viewport.width * 0.125, 0);
  expect(layout.dialog.y).toBeCloseTo(viewport.height * 0.125, 0);
  expect(layout.gridColumns.split(' ')).toHaveLength(3);
  expect(layout.dialog.scrollHeight).toBeLessThanOrEqual(layout.dialog.clientHeight + 1);
  for (const [index, column] of layout.columns.entries()) {
    expect(column.width).toBeGreaterThan(200);
    expect(column.x).toBeGreaterThan(layout.dialog.x);
    expect(column.right).toBeLessThan(layout.dialog.right);
    expect(column.bottom).toBeLessThan(layout.dialog.bottom);
    expect(column.scrollWidth).toBeLessThanOrEqual(column.clientWidth + 1);
    expect(column.overflowY).toBe('auto');
    expect(column.y).toBeCloseTo(layout.columns[0]!.y, 0);
    expect(column.height).toBeCloseTo(layout.columns[0]!.height, 0);
    if (index > 0) expect(column.x).toBeGreaterThan(layout.columns[index - 1]!.right);
  }
  if (layout.panel) {
    expect(layout.sourceInfo).not.toBeNull();
    const sourceInfo = layout.sourceInfo!;
    expect(sourceInfo.fields).toHaveLength(3);
    expect(sourceInfo.fields[0]!.text).toMatch(/^来源：(v\d+|版本未知)$/);
    expect(sourceInfo.fields[1]!.text).toMatch(/^时长：/);
    expect(sourceInfo.fields[2]!.text).toMatch(/^文件：/);
    expect(sourceInfo.fields[2]!.textOverflow).toBe('ellipsis');
    expect(sourceInfo.scrollWidth).toBeLessThanOrEqual(sourceInfo.clientWidth + 1);
    for (const field of sourceInfo.fields) {
      expect(field.width).toBeGreaterThan(0);
      expect(field.y).toBeCloseTo(sourceInfo.fields[0]!.y, 0);
      expect(field.x).toBeGreaterThanOrEqual(sourceInfo.x);
      expect(field.right).toBeLessThanOrEqual(sourceInfo.right + 1);
    }
  }
  const controls = await dialog.evaluate((element) => {
    const model = element.querySelector('.node-quick-editor-settings .node-parameter-select');
    const parameters = element.querySelector(
      '.node-quick-editor-settings .node-quick-editor-summary-button',
    );
    if (!model || !parameters) throw new Error('右栏缺少模型或视频参数入口');
    const modelBounds = model.getBoundingClientRect();
    const parameterBounds = parameters.getBoundingClientRect();
    return {
      modelCenterY: modelBounds.y + modelBounds.height / 2,
      parameterCenterY: parameterBounds.y + parameterBounds.height / 2,
      modelRight: modelBounds.right,
      parameterLeft: parameterBounds.left,
    };
  });
  expect(controls.modelCenterY).toBeCloseTo(controls.parameterCenterY, 0);
  expect(controls.modelRight).toBeLessThan(controls.parameterLeft);
  return layout;
}

/**
 * 核对场景完整帧与四张对象截图，黑图、重复占位图或忽略裁剪时失败。
 * @param panel 当前可交互的复刻区域；截图时间均位于仓库演示视频的真实时长内。
 * @returns 每张图片的像素尺寸和颜色范围，用于附加浏览器验收证据。
 */
async function expectSourcePreviews(panel: Locator) {
  const objects = [...identifiedTemplate.roles, ...identifiedTemplate.products!];
  await expect(panel.locator('.video-recreation-object')).toHaveCount(objects.length);
  await expect(
    panel.locator('.video-recreation-object .video-recreation-preview-image'),
  ).toHaveCount(objects.length);
  const scene = panel.getByRole('img', { name: '原视频场景的原视频画面', exact: true });
  await expect(scene).toBeVisible({ timeout: 15000 });
  await expect(scene.locator('xpath=ancestor::figure[1]')).toHaveAttribute(
    'data-timestamp-seconds',
    '0',
  );
  await expect(scene.locator('xpath=ancestor::figure[1]')).toHaveAttribute('data-cropped', 'false');
  await scene.evaluate((element) => (element as HTMLImageElement).decode());
  const sceneLayout = await panel.locator('.video-recreation-scenes').evaluate((element) => {
    const columns = getComputedStyle(element).gridTemplateColumns.split(' ').length;
    const name = element.querySelector('h4')?.getBoundingClientRect();
    const frame = element.querySelector('figure')?.getBoundingClientRect();
    const hint = element.querySelector('p')?.getBoundingClientRect();
    if (!name || !frame || !hint) throw new Error('场景缺少名称、缩略图或说明');
    return {
      columns,
      height: element.getBoundingClientRect().height,
      nameRight: name.right,
      frameLeft: frame.left,
      frameRight: frame.right,
      hintLeft: hint.left,
    };
  });
  expect(sceneLayout.columns).toBe(3);
  expect(sceneLayout.height).toBeLessThanOrEqual(130);
  expect(sceneLayout.nameRight).toBeLessThanOrEqual(sceneLayout.frameLeft + 1);
  expect(sceneLayout.frameRight).toBeLessThanOrEqual(sceneLayout.hintLeft + 1);
  const measurements = [];
  for (const object of objects) {
    const preview = panel.getByRole('img', { name: object.label + '的原视频画面', exact: true });
    await expect(preview).toBeVisible({ timeout: 15000 });
    const objectLayout = await preview.locator('xpath=ancestor::article[1]').evaluate((article) => {
      const name = article.querySelector('h4')?.getBoundingClientRect();
      const frame = article.querySelector('.video-recreation-preview')?.getBoundingClientRect();
      const resource = article
        .querySelector('.video-recreation-object-resource')
        ?.getBoundingClientRect();
      if (!name || !frame || !resource) throw new Error('对象缺少名称、原视频图或资源操作');
      return {
        nameRight: name.right,
        frameLeft: frame.left,
        frameRight: frame.right,
        resourceLeft: resource.left,
        columns: getComputedStyle(article).gridTemplateColumns.split(' ').length,
        height: article.getBoundingClientRect().height,
        bounded: article.scrollWidth <= article.clientWidth + 1,
      };
    });
    expect(objectLayout.columns, object.label + '三段应在同一横排').toBe(3);
    expect(objectLayout.height, object.label + '单项最高 130px').toBeLessThanOrEqual(130);
    expect(objectLayout.nameRight).toBeLessThanOrEqual(objectLayout.frameLeft + 1);
    expect(objectLayout.frameRight).toBeLessThanOrEqual(objectLayout.resourceLeft + 1);
    expect(objectLayout.bounded).toBe(true);
    const figure = preview.locator('xpath=ancestor::figure[1]');
    await expect(figure).toHaveAttribute(
      'data-timestamp-seconds',
      String(object.preview!.timestampSeconds),
    );
    await expect(figure).toHaveAttribute('data-cropped', 'true');
    await expect(figure).toContainText('局部裁剪');
    const pixels = await preview.evaluate(async (element) => {
      const image = element as HTMLImageElement;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器不能读取来源截图像素');
      context.drawImage(image, 0, 0, 32, 32);
      const colors = context.getImageData(0, 0, 32, 32).data.filter((_, index) => index % 4 !== 3);
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        minimum: Math.min(...colors),
        maximum: Math.max(...colors),
      };
    });
    expect(pixels.width).toBeGreaterThan(0);
    expect(pixels.height).toBeGreaterThan(0);
    expect(pixels.maximum - pixels.minimum, object.label + '截图不能是空白占位图').toBeGreaterThan(
      20,
    );
    measurements.push({ label: object.label, ...pixels });
  }
  const sourceRatios = measurements.map((measurement, index) => {
    const box = objects[index]!.preview!.boundingBox!;
    return (measurement.width / measurement.height / box.width) * box.height;
  });
  for (const ratio of sourceRatios) expect(ratio).toBeCloseTo(sourceRatios[0]!, 1);
  return measurements;
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
      ' 工具栏建草稿、节点专用三栏 Dialog 和明确分析生成',
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
      await expect(entry).toHaveText('');
      await expect(entry).toHaveAttribute('title', '新建短视频复刻节点');
      await expect(entry.locator('svg.lucide-clapperboard')).toBeVisible();
      expect(await entry.evaluate((element) => element.matches(':hover'))).toBe(false);
      await expect(
        page.getByRole('group', { name: '创建节点', exact: true }).getByRole('button'),
      ).toHaveCount(4);
      expect(ctx.postPaths).toEqual([]);
      await page.screenshot({ path: info.outputPath('recreation-entry.png'), fullPage: true });

      await entry.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('.node-quick-editor')).toHaveCount(0);
      await expect.poll(() => ctx.canvas().nodes.length).toBe(2);
      const draft = ctx.canvas().nodes.find((item) => item.data.videoRecreationDraft)!;
      expect(draft.data.videoRecreation).toBeUndefined();
      expect(draft.data.mode).toBe('generate');
      const node = page.locator('.react-flow__node[data-id="' + draft.id + '"]');
      await expect(node).toBeVisible();
      const size = await node.boundingBox();
      expect(size).not.toBeNull();
      const dialog = await clickRecreationNode(page, node);
      const draftLayout = await expectRecreationLayout(dialog, viewport);
      await expect(dialog.getByRole('region', { name: '分析视频', exact: true })).toBeVisible();
      await expect(dialog.getByRole('region', { name: '替换资源', exact: true })).toBeVisible();
      await expect(dialog.getByRole('region', { name: '生成设置', exact: true })).toBeVisible();
      const reference = dialog.getByRole('combobox', { name: '参考视频', exact: true });
      await expectSelection(reference, '选择项目视频');
      await expect(dialog.getByRole('button', { name: '使用此视频', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('status')).toContainText('请先选择参考视频并完成分析');
      await expect(dialog.getByLabel('上传参考视频', { exact: true })).toBeAttached();
      expect(ctx.posts).toHaveLength(0);
      expect(ctx.generates).toHaveLength(0);
      expect(ctx.postPaths).toEqual([]);
      await page.screenshot({
        path: info.outputPath('recreation-draft-dialog.png'),
        animations: 'disabled',
        fullPage: true,
      });

      await selectOption(reference, /参考短视频/);
      expect(
        ctx.canvas().nodes.find((item) => item.id === draft.id)?.data.videoRecreation,
      ).toBeUndefined();
      expect(ctx.postPaths).toEqual([]);
      await dialog.getByRole('button', { name: '使用此视频', exact: true }).click();
      await expect(dialog.getByRole('region', { name: '短视频复刻', exact: true })).toBeVisible();
      await expect
        .poll(() => ctx.canvas().nodes.find((item) => item.id === draft.id)?.data.videoRecreation)
        .toBeTruthy();
      const saved = ctx.canvas().nodes.find((item) => item.id === draft.id)!;
      expect(saved.data.videoRecreationDraft).toBeUndefined();
      expect(saved.data.videoRecreation?.source).toMatchObject({
        assetId: 'clip',
        assetVersion: 2,
        durationSeconds: 10,
      });
      expect(ctx.canvas().nodes.find((item) => item.id === sourceBefore.id)).toEqual(sourceBefore);
      expect(ctx.posts).toHaveLength(0);
      expect(ctx.generates).toHaveLength(0);
      expect(ctx.postPaths).toEqual([]);
      const boundLayout = await expectRecreationLayout(dialog, viewport);
      const player = dialog.locator('.video-recreation-source-preview video');
      await expect(player).toHaveAttribute('controls');
      await expect(player).toHaveAttribute('src', /\/v1\/assets\/clip\/versions\/2\/content$/);
      await expect
        .poll(() => player.evaluate((element) => (element as HTMLVideoElement).readyState))
        .toBeGreaterThanOrEqual(1);
      const layoutPath = info.outputPath('recreation-dialog-layout.json');
      writeFileSync(layoutPath, JSON.stringify({ viewport, draftLayout, boundLayout }, null, 2));
      await info.attach('复刻三栏边界', { path: layoutPath, contentType: 'application/json' });
      await dialog.getByRole('button', { name: '关闭编辑器', exact: true }).click();
      await expect(dialog).toBeHidden();
      await clickEmptyPane(page);
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
      await expect(node.locator('.flow-node-preview video')).toHaveAttribute(
        'src',
        /\/v1\/assets\/clip\/versions\/2\/content$/,
      );
      const deselectedSize = await node.boundingBox();
      expect(deselectedSize?.width).toBeCloseTo(size!.width, 0);
      expect(deselectedSize?.height).toBeCloseTo(size!.height, 0);
      await page.screenshot({ path: info.outputPath('recreation-node-badge.png'), fullPage: true });

      await clickRecreationNode(page, node);
      const panel = page.getByRole('region', { name: '短视频复刻', exact: true });
      await expect(panel).toBeVisible();
      await expect(
        panel
          .getByRole('heading', { name: '分析视频', exact: true })
          .locator('svg.lucide-clapperboard'),
      ).toBeVisible();
      await expect(panel.getByText('使用流程', { exact: true })).toHaveCount(0);
      await expect(panel.getByText('完整时长：10 秒', { exact: true })).toHaveCount(0);
      await expect(panel.getByRole('textbox', { name: '分析模型 ID', exact: true })).toHaveCount(0);
      await expect(panel.getByText('分析模型', { exact: true })).toHaveCount(0);
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      expect(ctx.postPaths).toEqual([]);
      const expandedSize = await node.boundingBox();
      expect(expandedSize?.width).toBeCloseTo(size!.width, 0);
      expect(expandedSize?.height).toBeCloseTo(size!.height, 0);
      await page.screenshot({
        path: info.outputPath('recreation-panel-controls.png'),
        fullPage: true,
      });
      const fullEditor = dialog;
      await expect(fullEditor).toBeVisible();
      const fullPanel = fullEditor.getByRole('region', { name: '短视频复刻', exact: true });
      await fullPanel
        .getByRole('heading', { name: '分析视频', exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        fullPanel.getByRole('heading', { name: '分析视频', exact: true }),
      ).toBeInViewport({ ratio: 1 - 1e-6 });
      expect(ctx.postPaths).toEqual([]);
      await page.mouse.move(0, 0);
      await expect(page.getByRole('tooltip')).toBeHidden();
      await page.screenshot({
        path: info.outputPath('recreation-full-editor-controls.png'),
        animations: 'disabled',
        fullPage: true,
      });
      await fullEditor.getByRole('button', { name: '关闭编辑器', exact: true }).click();
      await expect(fullEditor).toBeHidden();
      await expect(page.locator('.node-quick-editor')).toHaveCount(0);
      const closedEditorSize = await node.boundingBox();
      expect(closedEditorSize?.width).toBeCloseTo(size!.width, 0);
      expect(closedEditorSize?.height).toBeCloseTo(size!.height, 0);
      await openRecreation(page, saved.id);
      await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
      await expect(panel.getByRole('combobox', { name: '主角', exact: true })).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: '提示词', exact: true })).toHaveValue(
        /Full observed duration: 10 seconds/,
      );
      expect(ctx.posts).toHaveLength(1);
      expect(ctx.postPaths).toEqual(['/v1/assets/clip/versions/2/reverse-prompts']);
      expect(ctx.generates).toHaveLength(0);
      const generate = dialog.getByRole('button', { name: '生成', exact: true });
      await expect(generate).toBeEnabled();
      await selectOption(panel.getByRole('combobox', { name: '主角', exact: true }), '我的人物');
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
  await selectOption(panel.getByRole('combobox', { name: '主角', exact: true }), '我的人物');
  await expect
    .poll(() => ctx.canvas().nodes.find((n) => n.data.videoRecreation)?.data.prompt)
    .toContain('Full observed duration: 10 seconds');
  const saved = ctx.canvas().nodes.find((n) => n.data.videoRecreation)!;
  expect(saved.data.parameters?.duration).toBe(10);
  expect(saved.data.resourceRefs?.map((r) => r.assetId)).toEqual(['person-a']);
  expect(saved.data.videoRecreation?.analysis?.template.dialogue).toEqual(template.dialogue);
  expect(saved.data.prompt).toContain('请看这个。');
  await expect(panel.getByText('查看完整模板、镜头动作与台词')).toHaveCount(0);
  expect(ctx.posts).toHaveLength(1);
  await expect(
    page
      .getByRole('dialog', { name: '短视频复刻', exact: true })
      .getByRole('textbox', { name: '提示词', exact: true }),
  ).toContainText('请看这个。');
  expect(ctx.generates).toHaveLength(0);
  const after = await node.boundingBox();
  expect(after?.width).toBeCloseTo(size!.width, 0);
  expect(after?.height).toBeCloseTo(size!.height, 0);
  await page.screenshot({ path: info.outputPath('recreation-bound-desktop.png'), fullPage: true });
  await page.reload();
  const restored = await openRecreation(page, saved.id);
  await expectSelection(restored.getByRole('combobox', { name: '主角', exact: true }), '我的人物');
  expect(ctx.posts).toHaveLength(1);
  await page
    .getByRole('dialog', { name: '短视频复刻', exact: true })
    .getByRole('button', { name: '生成', exact: true })
    .click();
  await expect.poll(() => ctx.generates.length).toBe(1);
  expect(
    ctx.generates[0]!.snapshot.nodes?.find((n) => n.id === saved.id)?.data.videoRecreation?.source,
  ).toMatchObject({ assetId: 'clip', assetVersion: 2 });
  expect(ctx.generates[0]!.snapshot.nodes?.find((n) => n.id === saved.id)?.data.prompt).toContain(
    '请看这个。',
  );
  expect(ctx.errors).toEqual([]);
});

test('更换人物和商品不重复分析，慢保存不打断商品说明连续输入', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ctx = await fixture(page, 2, 150);
  await createNode(page);
  const panel = page.getByRole('region', { name: '短视频复刻', exact: true });
  await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
  await selectOption(panel.getByRole('combobox', { name: '主角', exact: true }), '我的人物');
  await selectOption(panel.getByRole('combobox', { name: '主角', exact: true }), '另一人物');
  await selectOption(panel.getByRole('combobox', { name: '商品', exact: true }), '新商品');
  await expect(
    page
      .getByRole('dialog', { name: '短视频复刻', exact: true })
      .getByRole('button', { name: '生成', exact: true }),
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
  ).toEqual(['person-b', 'product']);
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

test('历史回显冻结旧版本视频与时长，较小PC专用 Dialog 可完成绑定', async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const ctx = await fixture(page, 3);
  const node = await createNode(page, true);
  const bounds = await node.boundingBox();
  const dialog = page.getByRole('dialog', { name: '短视频复刻', exact: true });
  const panel = dialog.getByRole('region', { name: '短视频复刻', exact: true });
  await expect(panel).toBeVisible();
  const layout = await expectRecreationLayout(dialog, { width: 1366, height: 900 });
  const player = panel.locator('.video-recreation-source-preview video');
  await expect(player).toHaveAttribute('src', /\/v1\/assets\/clip\/versions\/2\/content$/);
  await expect(player).toHaveAttribute('controls');
  await expect
    .poll(() => player.evaluate((element) => (element as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);
  await player.evaluate((element) => (element as HTMLVideoElement).play());
  await expect
    .poll(() => player.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0);
  await player.evaluate((element) => (element as HTMLVideoElement).pause());
  expect(ctx.posts).toHaveLength(0);
  expect(ctx.generates).toHaveLength(0);
  await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
  await selectOption(panel.getByRole('combobox', { name: '主角', exact: true }), '我的人物');
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
    ['person-a', 3],
  ]);
  await expect(dialog.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
  await panel.getByRole('combobox', { name: '主角', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('recreation-expanded-pc.png'), fullPage: true });
  const layoutPath = info.outputPath('recreation-frozen-video-layout.json');
  writeFileSync(layoutPath, JSON.stringify({ layout, consoleErrors: ctx.errors }, null, 2));
  await info.attach('冻结版本视频布局', { path: layoutPath, contentType: 'application/json' });
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
  await expectSelection(panel.getByRole('combobox', { name: '主角', exact: true }), '我的人物.jpg');
  const saved = ctx.canvas().nodes.find((n) => n.data.videoRecreation)!;
  expect(saved.data.resourceRefs?.map((r) => [r.assetId, r.assetVersion])).toEqual([
    ['uploaded-character', 5],
  ]);
  expect(saved.data.videoRecreation?.product).toBeUndefined();
  expect(ctx.uploads).toEqual(['init', 'bytes', 'complete']);
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 1920, height: 1080 },
]) {
  test(
    'PC ' + viewport.width + '×' + viewport.height + ' 逐个人物和商品识别预览、单件替换并保存重载',
    async ({ page }, info) => {
      test.setTimeout(60000);
      await page.setViewportSize(viewport);
      const ctx = await fixture(page, 2, 0, true);
      const node = await createNode(page);
      const size = await node.boundingBox();
      const panel = page.getByRole('region', { name: '短视频复刻', exact: true });
      const analysisModel = panel.getByRole('combobox', { name: '分析模型', exact: true });
      await expectSelection(analysisModel, 'qwen3.8-omni-flash');
      expect(ctx.posts).toHaveLength(0);
      expect(ctx.generates).toHaveLength(0);
      const sourceReadsBeforeAnalysis = ctx.sourceContentRequests.length;
      await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
      await expect(panel.getByRole('combobox', { name: '同伴', exact: true })).toBeVisible();
      expect(ctx.posts).toHaveLength(1);
      expect(ctx.posts[0]).toMatchObject({
        modelAlias: 'qwen3.8-omni-flash',
        credentialId: analysisCredentialId,
        purpose: 'video_recreation',
      });
      await expect(panel.getByText('本次分析模型：qwen3.8-omni-flash')).toHaveCount(0);
      const sourcePreviews = await expectSourcePreviews(panel);
      const sourceReadsAfterAnalysis = ctx.sourceContentRequests.length;
      await expectSelection(
        panel.getByRole('combobox', { name: '主角', exact: true }),
        '保留原视频人物（不替换）',
      );
      await expectSelection(
        panel.getByRole('combobox', { name: '同伴', exact: true }),
        '保留原视频人物（不替换）',
      );
      await expectSelection(
        panel.getByRole('combobox', { name: '香水瓶', exact: true }),
        '保留原视频商品（不替换）',
      );
      await expectSelection(
        panel.getByRole('combobox', { name: '手提袋', exact: true }),
        '保留原视频商品（不替换）',
      );

      await selectOption(panel.getByRole('combobox', { name: '主角', exact: true }), '我的人物');
      await selectOption(
        panel.getByRole('combobox', { name: '主角', exact: true }),
        '保留原视频人物（不替换）',
      );
      await expect
        .poll(
          () =>
            ctx.canvas().nodes.find((entry) => entry.data.videoRecreation)?.data.videoRecreation
              ?.bindings,
        )
        .toEqual([]);
      await selectOption(panel.getByRole('combobox', { name: '主角', exact: true }), '另一人物');
      await selectOption(panel.getByRole('combobox', { name: '香水瓶', exact: true }), '新商品');
      const generate = page
        .getByRole('dialog', { name: '短视频复刻', exact: true })
        .getByRole('button', { name: '生成', exact: true });
      await expect(generate).toBeDisabled();
      const description = '香水，喷洒使用；不饮用，不添加未确认功效';
      await panel
        .getByRole('textbox', { name: '香水瓶用途与已确认卖点', exact: true })
        .fill(description);
      await expect(generate).toBeEnabled();
      await expect
        .poll(
          () =>
            ctx.canvas().nodes.find((entry) => entry.data.videoRecreation)?.data.videoRecreation
              ?.productBindings,
        )
        .toEqual([
          {
            productId: 'product_a',
            assetId: 'product',
            assetVersion: 3,
            name: '新商品',
            description,
          },
        ]);
      await expect
        .poll(
          () =>
            ctx.canvas().nodes.find((entry) => entry.data.videoRecreation)?.data.videoRecreation
              ?.preservedRoleIds,
        )
        .toEqual(['character_b']);
      await expect
        .poll(() =>
          ctx
            .canvas()
            .nodes.find((entry) => entry.data.videoRecreation)
            ?.data.resourceRefs?.map((reference) => [reference.assetId, reference.assetVersion]),
        )
        .toEqual([
          ['person-b', 3],
          ['product', 3],
        ]);

      await selectOption(analysisModel, /视频分析模型/);
      const generationModel = page.getByRole('combobox', { name: /^视频生成模型：/ });
      await generationModel.click();
      await page
        .getByRole('listbox', { name: '视频生成模型选项', exact: true })
        .getByRole('option', { name: /独立视频生成模型/ })
        .click();
      await expect
        .poll(() => ctx.canvas().nodes.find((entry) => entry.data.videoRecreation)?.data.modelAlias)
        .toBe('sora-2');
      const saved = ctx.canvas().nodes.find((entry) => entry.data.videoRecreation)!;
      expect(saved.data.videoRecreation?.analysis?.modelAlias).toBe('qwen3.8-omni-flash');
      expect(saved.data.videoRecreation?.product).toBeUndefined();
      expect(saved.data.parameters?.duration).toBe(10);
      expect(saved.data.prompt).toContain('Never drink perfume');
      expect(saved.data.prompt).toContain('Character character_b: Keep this character consistent');
      expect(saved.data.prompt).toContain(
        'Product product_b: Keep this product and its interactions consistent',
      );
      expect(ctx.postPaths).toEqual(['/v1/assets/clip/versions/2/reverse-prompts']);
      expect(ctx.generates).toHaveLength(0);
      const after = await node.boundingBox();
      expect(after?.width).toBeCloseTo(size!.width, 0);
      expect(after?.height).toBeCloseTo(size!.height, 0);

      await page.reload();
      const restored = await openRecreation(page, saved.id);
      await expectSelection(
        restored.getByRole('combobox', { name: '主角', exact: true }),
        '另一人物',
      );
      await expectSelection(
        restored.getByRole('combobox', { name: '同伴', exact: true }),
        '保留原视频人物（不替换）',
      );
      await expectSelection(
        restored.getByRole('combobox', { name: '香水瓶', exact: true }),
        '新商品',
      );
      await expectSelection(
        restored.getByRole('combobox', { name: '手提袋', exact: true }),
        '保留原视频商品（不替换）',
      );
      await expect(
        restored.getByRole('textbox', { name: '香水瓶用途与已确认卖点', exact: true }),
      ).toHaveValue(description);
      await expect(restored.getByText('本次分析模型：qwen3.8-omni-flash')).toHaveCount(0);
      expect(ctx.posts).toHaveLength(1);
      expect(ctx.generates).toHaveLength(0);

      const editor = page.getByRole('dialog', { name: '短视频复刻', exact: true });
      const fullPanel = editor.getByRole('region', { name: '短视频复刻', exact: true });
      const dialogLayout = await expectRecreationLayout(editor, viewport);
      const sourceName = fullPanel.locator('.video-recreation-source-name');
      await sourceName.hover();
      await expect(page.getByRole('tooltip')).toHaveText(saved.data.videoRecreation!.source.name);
      await page.mouse.move(0, 0);
      await expect(page.getByRole('tooltip')).toBeHidden();
      const fullEditorPreviews = await expectSourcePreviews(fullPanel);
      const analysisColumn = fullPanel.getByRole('region', { name: '原视频与分析', exact: true });
      const resourcesColumn = fullPanel.getByRole('region', { name: '替换资源', exact: true });
      const generationColumn = editor.getByRole('region', { name: '生成设置', exact: true });
      const analysisScrollTop = await analysisColumn.evaluate((element) => element.scrollTop);
      const generationScrollTop = await generationColumn.evaluate((element) => element.scrollTop);
      const replacementSelectors = fullPanel.locator(
        '.video-recreation-object-resource [role="combobox"]',
      );
      await expect(replacementSelectors).toHaveCount(4);
      await expectSelection(replacementSelectors.nth(0)!, '另一人物');
      await expectSelection(replacementSelectors.nth(2)!, '新商品');
      await fullPanel
        .getByRole('img', { name: '主角的原视频画面', exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath('recreation-identified-roles-pc.png'),
        animations: 'disabled',
        fullPage: true,
      });
      await fullPanel
        .getByRole('button', { name: '上传手提袋图片', exact: true })
        .scrollIntoViewIfNeeded();
      const resourceScroll = await resourcesColumn.evaluate((element) => ({
        top: element.scrollTop,
        overflows: element.scrollHeight > element.clientHeight + 1,
      }));
      if (resourceScroll.overflows) expect(resourceScroll.top).toBeGreaterThan(0);
      else expect(resourceScroll.top).toBe(0);
      expect(await analysisColumn.evaluate((element) => element.scrollTop)).toBe(analysisScrollTop);
      expect(await generationColumn.evaluate((element) => element.scrollTop)).toBe(
        generationScrollTop,
      );
      await page.screenshot({
        path: info.outputPath('recreation-identified-products-pc.png'),
        animations: 'disabled',
        fullPage: true,
      });
      expect(
        await fullPanel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      await editor.getByRole('button', { name: '关闭编辑器', exact: true }).click();
      await expect(editor).toBeHidden();
      const closedSize = await node.boundingBox();
      expect(closedSize?.width).toBeCloseTo(size!.width, 0);
      expect(closedSize?.height).toBeCloseTo(size!.height, 0);
      await page.screenshot({
        path: info.outputPath('recreation-identified-workspace-pc.png'),
        animations: 'disabled',
        fullPage: true,
      });
      await openRecreation(page, saved.id);
      await generate.click();
      await expect.poll(() => ctx.generates.length).toBe(1);
      expect(ctx.generates[0]!.modelAlias).toBe('sora-2');
      expect(
        ctx.generates[0]!.snapshot.nodes?.find((entry) => entry.id === saved.id)?.data
          .videoRecreation,
      ).toEqual(saved.data.videoRecreation);
      expect(ctx.posts).toHaveLength(1);
      expect(ctx.errors).toEqual([]);
      const evidencePath = info.outputPath('recreation-identified-evidence.json');
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            viewport,
            dialogLayout,
            previews: sourcePreviews,
            fullEditorPreviews,
            sourceReadsBeforeAnalysis,
            sourceReadsAfterAnalysis,
            sourceContentRequests: ctx.sourceContentRequests,
            nodeBounds: { initial: size, afterBindings: after, afterEditor: closedSize },
            consoleErrors: ctx.errors,
          },
          null,
          2,
        ),
      );
      await info.attach('复刻截图、请求与节点尺寸', {
        path: evidencePath,
        contentType: 'application/json',
      });
    },
  );
}

test('分析目录只列文本项，选择模型与分组后仅在明确分析时提交', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ctx = await fixture(page, 2, 0, true);
  await createNode(page);
  const panel = page.getByRole('region', { name: '短视频复刻', exact: true });
  const select = panel.getByRole('combobox', { name: '分析模型', exact: true });
  await expectSelection(select, 'qwen3.8-omni-flash');
  await expect(panel.getByRole('textbox', { name: '分析模型 ID', exact: true })).toHaveCount(0);
  await select.click();
  await expect(page.getByRole('option', { name: /参考视频生成模型|独立视频生成模型/ })).toHaveCount(
    0,
  );
  await page.getByRole('option', { name: /视频分析模型/ }).click();
  expect(ctx.posts).toHaveLength(0);
  expect(ctx.generates).toHaveLength(0);
  await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '同伴', exact: true })).toBeVisible();
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.posts[0]).toMatchObject({
    modelAlias: 'vision-test',
    credentialId: analysisCredentialId,
  });
  await expect(panel.getByText('本次分析模型：vision-test')).toHaveCount(0);
  expect(ctx.canvas().nodes.find((entry) => entry.data.videoRecreation)?.data.modelAlias).toBe(
    'MiniMax-H3',
  );
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});

test('对象预览与项目图片搜索弹窗可交互，显式生成的图片回显原节点并保持尺寸', async ({
  page,
}, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ctx = await fixture(page, 2, 0, true, 'image');
  const createdNode = await createNode(page);
  const nodeId = (await createdNode.getAttribute('data-id'))!;
  const node = page.locator('.react-flow__node[data-id="' + nodeId + '"]');
  const size = await node.boundingBox();
  const editor = page.getByRole('dialog', { name: '短视频复刻', exact: true });
  const panel = editor.getByRole('region', { name: '短视频复刻', exact: true });
  await panel.getByRole('button', { name: '分析整条视频', exact: true }).click();
  await expectSourcePreviews(panel);
  const savedAnalysis = structuredClone(
    ctx.canvas().nodes.find((entry) => entry.id === nodeId)?.data.videoRecreation?.analysis,
  );
  await panel.getByRole('tab', { name: '未确认证据', exact: true }).click();
  await expect(panel.getByText(identifiedTemplate.unknowns[0]!, { exact: true })).toBeVisible();
  await panel.getByRole('tab', { name: '整体摘要', exact: true }).click();
  await expect(panel.getByText('整条视频两个人物、两件物品', { exact: true })).toBeVisible();
  const role = panel.getByRole('article', { name: '人物：主角', exact: true });
  const heading = role.getByRole('heading', { name: '主角', exact: true });
  await heading.hover();
  await expect(page.getByRole('tooltip')).toContainText('画面左侧人物，右手拿着香水瓶');
  await expect(page.getByRole('tooltip')).toContainText('出现时间：0–10 秒');
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toBeHidden();
  const preview = role.getByRole('img', { name: '主角的原视频画面', exact: true });
  await preview.click();
  const expandedImage = page.locator('.ant-image-preview-img');
  await expect(expandedImage).toBeVisible();
  await expect(expandedImage).toHaveAttribute('src', await preview.getAttribute('src')!);
  await page.screenshot({
    path: info.outputPath('recreation-image-preview.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expect(expandedImage).toBeHidden();
  await expect(editor).toBeVisible();
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);

  const summary = editor.getByRole('button', { name: '视频参数', exact: true });
  await summary.click();
  const duration = page.getByRole('button', { name: /^时长（秒）：/ });
  await duration.click();
  const durationDialog = page.getByRole('dialog', { name: '视频时长', exact: true });
  await durationDialog.getByRole('spinbutton', { name: '自定义时长（秒）', exact: true }).fill('7');
  await durationDialog
    .getByRole('spinbutton', { name: '自定义时长（秒）', exact: true })
    .press('Escape');
  await expect(durationDialog).toBeHidden();
  await expect(editor).toBeVisible();

  await role.getByRole('button', { name: '搜索主角替换资源', exact: true }).click();
  const search = page.getByRole('dialog', { name: '选择替换图片', exact: true });
  await expect(search).toBeVisible();
  await search.getByRole('searchbox', { name: '搜索项目资料', exact: true }).fill('项目新人物');
  const resource = search.getByRole('button', { name: '添加参考资料 项目新人物 v8', exact: true });
  await expect(resource).toBeVisible();
  expect(ctx.resourceSearches.at(-1)).toEqual({
    query: '项目新人物',
    mediaType: 'image',
    page: '1',
    projectId: project.id,
  });
  await expect(search.getByRole('button', { name: /添加参考资料 参考短视频/ })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('recreation-resource-search.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await resource.click();
  await expect(search).toBeHidden();
  await expect(editor).toBeVisible();
  await expectSelection(role.getByRole('combobox', { name: '主角', exact: true }), '项目新人物');
  await expect
    .poll(
      () => ctx.canvas().nodes.find((entry) => entry.id === nodeId)?.data.videoRecreation?.bindings,
    )
    .toEqual([
      { roleId: 'character_a', assetId: 'remote-person', assetVersion: 8, name: '项目新人物' },
    ]);
  const saved = ctx.canvas().nodes.find((entry) => entry.id === nodeId)!;
  expect(saved.data.videoRecreation?.preservedRoleIds).toEqual(['character_b']);
  expect(saved.data.videoRecreation?.productBindings ?? []).toEqual([]);
  expect(saved.data.videoRecreation?.analysis).toEqual(savedAnalysis);
  expect(saved.data.parameters?.duration).toBe(7);
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  await editor.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => ctx.generates.length).toBe(1);
  expect(ctx.generates[0]!.snapshot.parameters.duration).toBe(7);
  await editor.getByRole('button', { name: '关闭编辑器', exact: true }).click();
  await expect(editor).toBeHidden();
  const result = node.locator('.flow-node-preview img');
  await expect(result).toBeVisible();
  await result.evaluate((element) => (element as HTMLImageElement).decode());
  const afterGeneration = await node.boundingBox();
  expect(afterGeneration?.width).toBeCloseTo(size!.width, 0);
  expect(afterGeneration?.height).toBeCloseTo(size!.height, 0);
  await page.screenshot({
    path: info.outputPath('recreation-generated-image.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.reload();
  await expect(node).toBeVisible({ timeout: 15000 });
  await expect(result).toBeVisible();
  await result.evaluate((element) => (element as HTMLImageElement).decode());
  const afterRestore = await node.boundingBox();
  expect(afterRestore?.width).toBeCloseTo(size!.width, 0);
  expect(afterRestore?.height).toBeCloseTo(size!.height, 0);
  expect(ctx.canvas().nodes).toHaveLength(2);
  expect(ctx.canvas().nodes.find((entry) => entry.id === nodeId)?.type).toBe('video');
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(1);
  expect(ctx.errors).toEqual([]);
  const evidencePath = info.outputPath('recreation-generated-image-evidence.json');
  writeFileSync(
    evidencePath,
    JSON.stringify(
      { initial: size, afterGeneration, afterRestore, consoleErrors: ctx.errors },
      null,
      2,
    ),
  );
  await info.attach('原节点图片回显与恢复尺寸', {
    path: evidencePath,
    contentType: 'application/json',
  });
});
