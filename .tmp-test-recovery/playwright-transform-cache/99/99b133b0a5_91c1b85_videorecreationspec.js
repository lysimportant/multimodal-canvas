// 52831d3668b6689774a95d192a2f7631557536f3
import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { canvasDocumentSchema, PROMPT_SKILLS } from '@multimodal-canvas/domain';
test.use({
  serviceWorkers: 'block'
});
/** 合成连接标识用于检验分组模型冻结，不包含真实凭据。 */
const analysisCredentialId = 'fe3d8520-9f64-4daa-8364-7b0987123651';
/** 合成全片分析仅用于验证流程，不代表真实视频理解效果。 */
const template = {
  version: 1,
  durationSeconds: 10,
  roles: [{
    id: 'character_a',
    label: '主角'
  }],
  shots: [{
    startSeconds: 0,
    endSeconds: 4,
    action: 'character_a抬手转身，商品保持在右手',
    camera: '中景向前跟随'
  }, {
    startSeconds: 4,
    endSeconds: 10,
    action: 'character_a将商品朝向镜头，停住展示',
    camera: '推进至商品特写'
  }],
  dialogue: [{
    startSeconds: 1.2,
    endSeconds: 2.8,
    speakerId: 'character_a',
    text: '请看这个。'
  }],
  unknowns: ['原包装文字无法确认']
};
/** 两个人物与两件物品的合成识别结果，仅验证选择、定位和保存，不代表演示视频真实内容。 */
const identifiedTemplate = {
  version: 1,
  durationSeconds: 10,
  roles: [{
    id: 'character_a',
    label: '主角',
    description: '画面左侧人物，右手拿着香水瓶',
    appearances: [{
      startSeconds: 0,
      endSeconds: 10
    }],
    preview: {
      timestampSeconds: 0.3,
      boundingBox: {
        x: 0.05,
        y: 0.05,
        width: 0.4,
        height: 0.85
      }
    }
  }, {
    id: 'character_b',
    label: '同伴',
    description: '画面右侧人物，提着手提袋',
    appearances: [{
      startSeconds: 1,
      endSeconds: 10
    }],
    preview: {
      timestampSeconds: 1.2,
      boundingBox: {
        x: 0.55,
        y: 0.05,
        width: 0.35,
        height: 0.85
      }
    }
  }],
  products: [{
    id: 'product_a',
    label: '香水瓶',
    description: '主角右手的小瓶，浅色矩形瓶盖',
    appearances: [{
      startSeconds: 0,
      endSeconds: 10
    }],
    preview: {
      timestampSeconds: 0.7,
      boundingBox: {
        x: 0.25,
        y: 0.3,
        width: 0.2,
        height: 0.4
      }
    }
  }, {
    id: 'product_b',
    label: '手提袋',
    description: '同伴手中的方形手提袋，文字无法确认',
    appearances: [{
      startSeconds: 1,
      endSeconds: 10
    }],
    preview: {
      timestampSeconds: 2,
      boundingBox: {
        x: 0.55,
        y: 0.4,
        width: 0.3,
        height: 0.5
      }
    }
  }],
  shots: [{
    startSeconds: 0,
    endSeconds: 4,
    action: 'character_a拿着product_a向前转身，character_b在右侧提着product_b',
    camera: '中景向前跟随'
  }, {
    startSeconds: 4,
    endSeconds: 10,
    action: 'character_a将product_a朝向镜头展示，character_b将product_b保持在身侧',
    camera: '推进至product_a特写'
  }],
  unknowns: ['原包装与手提袋文字无法确认']
};
/** 仓库内媒体不产生外部下载。 */
const image = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
const video = readFileSync(new URL('../public/demo/field-study.mp4', import.meta.url));
const project = {
  id: 'recreation-browser',
  name: '短视频复刻验收',
  createdAt: '2026-10-04T00:00:00Z',
  updatedAt: '2026-10-04T00:00:00Z'
};
/** 返回合成API对象。 */
async function json(route, value, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value)
  });
}

/** 通过触发器关联的 Ant Design 下拉选择，避免误点退出动画中的其他同名选项。 */
async function selectOption(select, option) {
  await select.click();
  await expect(select).toHaveAttribute('aria-expanded', 'true');
  const listId = await select.getAttribute('aria-controls');
  expect(listId).toBeTruthy();
  const listbox = select.page().locator('[id="' + listId + '"]');
  await listbox.getByRole('option', {
    name: option
  }).click();
  await expect(select).toHaveAttribute('aria-expanded', 'false');
  await expect(listbox).toBeHidden();
}

/** Ant Design 搜索输入值与绑定无关；核对可见选中标签。 */
async function expectSelection(select, label) {
  await expect(select.locator('xpath=ancestor::*[contains(@class,"ant-select")][1]')).toContainText(label);
}

/**
 * 拦截所有 API 与付费请求，保存只写测试内存；现代识别夹具不改变旧格式场景。
 * @param identified 使用带人物、物品定位的合成结果及文本 qwen 目录项。
 * @param generationMediaType 为 image 时返回成功归档图片，验证原视频节点的结果展示。
 */
async function fixture(page, sourceLatestVersion = 2, saveDelayMs = 0, identified = false, generationMediaType) {
  let canvas = canvasDocumentSchema.parse({
    revision: 1,
    nodes: [{
      id: 'source-video',
      type: 'video',
      position: {
        x: 100,
        y: 100
      },
      width: 400,
      height: 266,
      data: {
        label: '参考短视频',
        mediaType: 'video',
        mode: 'source',
        assetId: 'clip',
        contentUrl: '/v1/assets/clip/versions/2/content',
        mimeType: 'video/mp4'
      }
    }],
    edges: []
  });
  const assets = [{
    id: 'clip',
    name: '参考短视频-人物与商品逐项替换-保留完整镜头动作和逐句台词-文件名较长仍然冻结原版本-不能撑大来源栏.mp4',
    mediaType: 'video',
    mimeType: 'video/mp4',
    latestVersion: sourceLatestVersion,
    sizeBytes: video.length,
    status: 'ready',
    contentUrl: '/v1/assets/clip/versions/' + sourceLatestVersion + '/content',
    tags: [],
    metadata: {
      durationSeconds: sourceLatestVersion === 2 ? 10 : 20
    }
  }, ...['person-a', 'person-b', 'product'].map(id => ({
    id,
    name: id === 'product' ? '新商品' : id === 'person-a' ? '我的人物' : '另一人物',
    mediaType: 'image',
    mimeType: 'image/jpeg',
    latestVersion: 3,
    sizeBytes: image.length,
    status: 'ready',
    contentUrl: '/v1/assets/' + id + '/versions/3/content',
    tags: [],
    metadata: {}
  }))];
  /** 只在项目搜索响应出现，初次画布资源缓存不含该图片。 */
  const remotePortrait = {
    ...assets[1],
    id: 'remote-person',
    name: '项目新人物',
    latestVersion: 8,
    contentUrl: '/v1/assets/remote-person/versions/8/content'
  };
  const resourceSearches = [];
  const user = {
    id: 'recreation-user',
    displayName: '复刻验收',
    email: 'recreation@example.test',
    role: 'user',
    createdAt: '2026-10-04T00:00:00Z'
  };
  const posts = [];
  /** 媒体 access-url 的 POST 只读取播放票据；除此之外，任何 POST 都必须由明确操作触发。 */
  const postPaths = [];
  /** 来源内容读取记录用于区分节点播放和同批对象共享的截帧请求。 */
  const sourceContentRequests = [];
  const generates = [];
  const uploads = [];
  const errors = [];
  let analysis = null;
  let hold = false;
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.addInitScript(user => {
    localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({
      accessToken: 'synthetic-recreation-browser',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      user
    }));
  }, user);
  const base = test.info().project.use.baseURL;
  if (!base || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw Error('只能使用本地浏览器验收入口');
  await page.context().route('**/*', route => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === new URL(base).origin && request.method() === 'GET' && !url.pathname.startsWith('/v1/')) return route.continue();
    errors.push('未声明外部请求：' + url.origin + url.pathname);
    return route.abort('blockedbyclient');
  });
  await page.route('**/v1/**', async route => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    if (method === 'POST' && !/^\/v1\/assets\/[^/]+\/access-url$/.test(path)) postPaths.push(path);
    if (method === 'GET' && /^\/v1\/assets\/clip\/versions\/\d+\/content$/.test(path)) sourceContentRequests.push({
      path,
      resourceType: req.resourceType()
    });
    if (method === 'GET' && path === '/v1/auth/me') return json(route, {
      user,
      expiresAt: new Date(Date.now() + 3600000).toISOString()
    });
    if (path === '/v1/settings/ai') return json(route, {
      settings: {
        defaultModels: {
          text: {
            modelAlias: 'vision-test',
            credentialId: analysisCredentialId
          },
          video: {
            modelAlias: 'MiniMax-H3'
          }
        }
      }
    });
    if (path === '/v1/projects') return json(route, {
      projects: [project]
    });
    if (path === '/v1/projects/' + project.id) return json(route, {
      project
    });
    if (path === '/v1/projects/' + project.id + '/canvas') {
      if (method === 'PATCH') {
        if (saveDelayMs) await new Promise(resolve => setTimeout(resolve, saveDelayMs));
        canvas = canvasDocumentSchema.parse({
          ...req.postDataJSON(),
          revision: canvas.revision + 1
        });
      }
      return json(route, {
        canvas
      });
    }
    if (path === '/v1/projects/' + project.id + '/events') return route.fulfill({
      contentType: 'text/event-stream',
      body: ': ready\n\n'
    });
    if (path === '/v1/projects/' + project.id + '/models/defaults') return json(route, {
      defaults: {
        text: {
          modelAlias: 'vision-test',
          credentialId: analysisCredentialId
        },
        video: {
          modelAlias: 'MiniMax-H3'
        }
      }
    });
    if (path === '/v1/projects/' + project.id + '/runs') return json(route, {
      runs: generates
    });
    if (path === '/v1/models') return json(route, {
      models: [{
        id: 'vision-test',
        credentialId: analysisCredentialId,
        name: '视频分析模型',
        mediaTypes: ['text'],
        available: true,
        capabilities: {
          mentionMediaTypes: ['video']
        }
      }, {
        id: 'MiniMax-H3',
        name: '参考视频生成模型',
        mediaTypes: ['video'],
        available: true,
        capabilities: {
          mentionMediaTypes: ['image', 'video']
        }
      }, ...(identified ? [{
        id: 'qwen3.8-omni-flash',
        credentialId: analysisCredentialId,
        name: 'qwen3.8-omni-flash',
        mediaTypes: ['text'],
        available: true
      }, {
        id: 'sora-2',
        name: '独立视频生成模型',
        mediaTypes: ['video'],
        available: true
      }] : [])]
    });
    if (path === '/v1/prompt-skills') return json(route, {
      skills: PROMPT_SKILLS.map(s => ({
        ...s,
        builtin: true,
        enabled: true,
        revision: 1
      }))
    });
    if (path === '/v1/assets/uploads/init' && method === 'POST') {
      uploads.push('init');
      expect(req.postDataJSON().name).toBe('我的人物.jpg');
      return json(route, {
        uploadId: 'character-upload',
        uploadUrl: '/v1/assets/uploads/recreation-bytes',
        completeUrl: '/v1/assets/uploads/complete'
      });
    }
    if (path === '/v1/assets/uploads/recreation-bytes' && method === 'PUT') {
      uploads.push('bytes');
      expect(req.postDataBuffer()).toEqual(image);
      return route.fulfill({
        status: 204
      });
    }
    if (path === '/v1/assets/uploads/complete' && method === 'POST') {
      uploads.push('complete');
      expect(req.postDataJSON().uploadId).toBe('character-upload');
      const uploaded = {
        ...assets.find(entry => entry.id === 'person-a'),
        id: 'uploaded-character',
        name: '我的人物.jpg',
        latestVersion: 5,
        contentUrl: '/v1/assets/uploaded-character/versions/5/content'
      };
      assets.push(uploaded);
      return json(route, {
        asset: uploaded
      }, 201);
    }
    if (path === '/v1/assets') {
      if (url.searchParams.get('mediaType') === 'image') {
        var _url$searchParams$get;
        const query = (_url$searchParams$get = url.searchParams.get('query')) !== null && _url$searchParams$get !== void 0 ? _url$searchParams$get : '';
        resourceSearches.push({
          query,
          mediaType: url.searchParams.get('mediaType'),
          page: url.searchParams.get('page'),
          projectId: url.searchParams.get('projectId')
        });
        const matching = [...assets, remotePortrait].filter(asset => asset.mediaType === 'image' && asset.name.includes(query));
        return json(route, {
          assets: matching,
          total: matching.length,
          page: 1,
          pageSize: 50
        });
      }
      return json(route, {
        assets
      });
    }
    const assetMatch = /^\/v1\/assets\/([^/]+)/.exec(path);
    const asset = [...assets, remotePortrait].find(a => a.id === (assetMatch === null || assetMatch === void 0 ? void 0 : assetMatch[1]));
    if (asset && path.endsWith('/versions')) return json(route, {
      versions: [...new Set(asset.id === 'clip' ? [2, asset.latestVersion] : [asset.latestVersion])].map(version => ({
        id: asset.id + 'v' + version,
        assetId: asset.id,
        version,
        sizeBytes: asset.sizeBytes,
        metadata: asset.id === 'clip' && version === 2 ? {
          durationSeconds: 10
        } : asset.metadata,
        createdAt: project.createdAt,
        contentUrl: '/v1/assets/' + asset.id + '/versions/' + version + '/content'
      }))
    });
    if (asset && path.endsWith('/access-url')) {
      const scope = method === 'POST' ? req.postDataJSON() : {};
      return json(route, {
        url: scope.version ? '/v1/assets/' + asset.id + '/versions/' + scope.version + '/content' : asset.contentUrl
      });
    }
    if (asset && (path.endsWith('/content') || path.endsWith('/derivatives/thumbnail'))) return route.fulfill({
      contentType: asset.mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
      body: asset.mediaType === 'video' ? video : image
    });
    if (path === '/v1/assets/clip/versions/2/reverse-prompts') {
      if (method === 'POST') {
        var _canvas$nodes$find;
        const body = req.postDataJSON();
        posts.push(body);
        const pending = (_canvas$nodes$find = canvas.nodes.find(n => n.data.videoRecreation)) === null || _canvas$nodes$find === void 0 || (_canvas$nodes$find = _canvas$nodes$find.data.videoRecreation) === null || _canvas$nodes$find === void 0 ? void 0 : _canvas$nodes$find.request;
        expect(pending === null || pending === void 0 ? void 0 : pending.idempotencyKey).toBe(body.idempotencyKey);
        expect(body.purpose).toBe('video_recreation');
        expect(pending === null || pending === void 0 ? void 0 : pending.modelAlias).toBe(body.modelAlias);
        expect(pending === null || pending === void 0 ? void 0 : pending.credentialId).toBe(body.credentialId);
        analysis = {
          runId: 'analysis-1',
          assetId: 'clip',
          assetVersion: 2,
          purpose: 'video_recreation',
          status: 'queued',
          modelAlias: body.modelAlias,
          ...(body.credentialId ? {
            credentialId: body.credentialId
          } : {})
        };
        return json(route, {
          analysis
        }, 202);
      }
      expect(url.searchParams.get('purpose')).toBe('video_recreation');
      return json(route, {
        analysis: analysis ? {
          ...analysis,
          status: hold ? 'running' : 'succeeded',
          ...(hold ? {} : {
            summary: identified ? '整条视频两个人物、两件物品' : '整条视频两个连续镜头',
            prompt: JSON.stringify(identified ? identifiedTemplate : template)
          })
        } : null,
        defaultModel: {
          modelAlias: 'vision-test',
          credentialId: analysisCredentialId
        }
      });
    }
    const target = canvas.nodes.find(n => path === '/v1/nodes/' + n.id + '/runs');
    if (method === 'POST' && target) {
      var _target$data$paramete;
      const now = new Date().toISOString();
      const generatedImage = generationMediaType ? {
        ...assets[1],
        id: 'recreation-result-image',
        name: '复刻生成图片',
        latestVersion: 7,
        contentUrl: '/v1/assets/recreation-result-image/versions/7/content'
      } : undefined;
      if (generatedImage) assets.push(generatedImage);
      const run = {
        id: 'recreation-generation-' + (generates.length + 1),
        projectId: project.id,
        targetNodeId: target.id,
        status: 'succeeded',
        progress: 100,
        attempt: 1,
        provider: 'mock',
        modelAlias: target.data.modelAlias,
        createdAt: now,
        updatedAt: now,
        snapshot: {
          projectId: project.id,
          canvasRevision: canvas.revision,
          targetNodeId: target.id,
          modelAlias: target.data.modelAlias,
          submittedAt: now,
          nodes: canvas.nodes,
          edges: [],
          inputs: [],
          parameters: (_target$data$paramete = target.data.parameters) !== null && _target$data$paramete !== void 0 ? _target$data$paramete : {}
        },
        ...(generatedImage ? {
          result: {
            summary: '图片结果已归档',
            mediaType: 'image',
            targetNodeId: target.id,
            provider: 'mock',
            inputCount: 1,
            asset: {
              assetId: generatedImage.id,
              version: generatedImage.latestVersion,
              mimeType: generatedImage.mimeType,
              sizeBytes: generatedImage.sizeBytes
            }
          }
        } : {})
      };
      generates.push(run);
      return json(route, {
        run
      }, 202);
    }
    if (path.startsWith('/v1/runs/')) {
      const run = generates.find(r => r.id === path.split('/').at(-1));
      if (run) return json(route, {
        run
      });
    }
    errors.push('未声明接口：' + method + ' ' + path);
    return json(route, {
      error: '未声明接口'
    }, 404);
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
    hold: value => {
      hold = value;
    }
  };
}
/**
 * 从工具栏创建空草稿，点击节点后在专用 Dialog 绑定来源；历史回显另验证冻结版本入口。
 * @param page 已安装隔离 API Mock 的浏览器页面。
 * @param fromFrozenSource 是否从保存了旧版本的视频节点创建，默认走工具栏草稿流程。
 * @returns 已绑定来源的复刻节点；不执行分析或生成。
 */
async function createNode(page, fromFrozenSource = false) {
  await page.goto('/projects/' + project.id);
  const source = page.locator('.react-flow__node[data-id="source-video"]');
  // Vite 冷启动会按需编译工作区模块，来源就绪后才开始核对交互。
  await expect(source).toBeVisible({
    timeout: 15000
  });
  if (fromFrozenSource) {
    await source.hover();
    await source.getByRole('button', {
      name: '复刻短视频：参考短视频',
      exact: true
    }).click();
  } else {
    await page.getByRole('group', {
      name: '节点组',
      exact: true
    }).getByRole('button', {
      name: '短视频复刻',
      exact: true
    }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const node = page.locator('.react-flow__node').filter({
    has: page.getByRole('group', {
      name: '节点操作：短视频复刻',
      exact: true
    })
  });
  await expect(node).toBeVisible();
  const dialog = await clickRecreationNode(page, node);
  await expect(page.locator('.node-quick-editor')).toHaveCount(0);
  if (!fromFrozenSource) {
    await selectOption(dialog.getByRole('combobox', {
      name: '参考视频',
      exact: true
    }), /参考短视频/);
    await dialog.getByRole('button', {
      name: '使用此视频',
      exact: true
    }).click();
  }
  await expect(dialog.getByRole('region', {
    name: '短视频复刻',
    exact: true
  })).toBeVisible();
  return node;
}
/** 首次点击聚焦节点，第二次点击同一内容区才打开复刻编辑器。 */
async function clickRecreationNode(page, node) {
  const dialog = page.getByRole('dialog', {
    name: '短视频复刻',
    exact: true
  });
  const content = node.locator('.flow-node-preview, .flow-node-placeholder').first();
  await expect(content).toBeVisible();
  await content.click({
    position: {
      x: 12,
      y: 12
    }
  });
  await expect(dialog).toBeHidden();
  await content.click({
    position: {
      x: 12,
      y: 12
    }
  });
  await expect(dialog).toBeVisible();
  return dialog;
}
/** 在当前视口实际可点到的画布空白处取消节点选择。 */
async function clickEmptyPane(page) {
  const point = await page.locator('.react-flow__pane').evaluate(pane => {
    const bounds = pane.getBoundingClientRect();
    for (const yRatio of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      for (const xRatio of [0.8, 0.65, 0.5, 0.35, 0.2]) {
        const x = bounds.left + bounds.width * xRatio;
        const y = bounds.top + bounds.height * yRatio;
        if (document.elementFromPoint(x, y) === pane) return {
          x,
          y
        };
      }
    }
    throw new Error('当前视口没有可点击的画布空白位置');
  });
  await page.mouse.click(point.x, point.y);
}
/** 只点击重开既有节点的专用 Dialog，不重新绑定、分析或生成。 */
async function openRecreation(page, id) {
  const node = page.locator('.react-flow__node[data-id="' + id + '"]');
  await expect(node).toBeVisible();
  const dialog = await clickRecreationNode(page, node);
  await expect(page.locator('.node-quick-editor')).toHaveCount(0);
  return dialog.getByRole('region', {
    name: '短视频复刻',
    exact: true
  });
}

/**
 * 核对真实 PC 布局尺寸、三栏顺序与有界滚动，尺寸缩小或被正文撑大时失败。
 * @param dialog 专用复刻 Dialog，可处于空草稿或已绑定来源状态。
 * @param viewport 当前 PC 视口尺寸，单位为 CSS 像素。
 * @returns Dialog 和三栏测量值，供截图与浏览器验收记录。
 */
async function expectRecreationLayout(dialog, viewport) {
  // Modal 入场动画会缩放测量值；动画结束后再核对最终尺寸，不修改页面样式。
  await expect.poll(() => dialog.evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
  const layout = await dialog.evaluate(element => {
    /** 只读取最终布局和滚动边界，不修改待验收页面。 */
    const measure = target => {
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
        justifyContent: style.justifyContent
      };
    };
    const body = element.querySelector('.node-quick-editor-recreation-body');
    const analysis = element.querySelector('.video-recreation-analysis-column, .node-quick-editor-recreation-source');
    const resources = element.querySelector('.video-recreation-resources-column, .node-quick-editor-recreation-pending');
    const generation = element.querySelector('.node-quick-editor-recreation-generate');
    const panel = element.querySelector('.video-recreation-panel');
    const sourceInfo = element.querySelector('.video-recreation-source-meta');
    if (!body || !analysis || !resources || !generation) throw new Error('复刻 Dialog 缺少分析、替换或生成栏');
    const wrappers = [];
    for (let wrapper = body.parentElement; wrapper && wrapper !== element; wrapper = wrapper.parentElement) wrappers.push(measure(wrapper));
    const overlay = element.closest('.ant-modal-wrap');
    const before = overlay ? getComputedStyle(overlay, '::before') : null;
    return {
      dialog: measure(element),
      overlay: overlay ? measure(overlay) : null,
      overlayBefore: before ? {
        display: before.display,
        height: before.height,
        width: before.width,
        content: before.content
      } : null,
      wrappers,
      body: measure(body),
      panel: panel ? measure(panel) : null,
      sourceInfo: sourceInfo ? {
        ...measure(sourceInfo),
        fields: Array.from(sourceInfo.children, field => ({
          ...measure(field),
          text: field.textContent,
          textOverflow: getComputedStyle(field).textOverflow
        }))
      } : null,
      gridColumns: getComputedStyle(body).gridTemplateColumns,
      gridRows: getComputedStyle(body).gridTemplateRows,
      columns: [analysis, resources, generation].map(measure)
    };
  });
  const layoutPath = test.info().outputPath(layout.panel ? 'recreation-bound-layout.json' : 'recreation-draft-layout.json');
  writeFileSync(layoutPath, JSON.stringify({
    viewport,
    ...layout
  }, null, 2));
  await test.info().attach('复刻三栏测量', {
    path: layoutPath,
    contentType: 'application/json'
  });
  await expect(dialog).toBeInViewport({
    ratio: 1 - 1e-6
  });
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
    expect(column.y).toBeCloseTo(layout.columns[0].y, 0);
    expect(column.height).toBeCloseTo(layout.columns[0].height, 0);
    if (index > 0) expect(column.x).toBeGreaterThan(layout.columns[index - 1].right);
  }
  if (layout.panel) {
    expect(layout.sourceInfo).not.toBeNull();
    const sourceInfo = layout.sourceInfo;
    expect(sourceInfo.fields).toHaveLength(3);
    expect(sourceInfo.fields[0].text).toMatch(/^来源：(v\d+|版本未知)$/);
    expect(sourceInfo.fields[1].text).toMatch(/^时长：/);
    expect(sourceInfo.fields[2].text).toMatch(/^文件：/);
    expect(sourceInfo.fields[2].textOverflow).toBe('ellipsis');
    expect(sourceInfo.scrollWidth).toBeLessThanOrEqual(sourceInfo.clientWidth + 1);
    for (const field of sourceInfo.fields) {
      expect(field.width).toBeGreaterThan(0);
      expect(field.y).toBeCloseTo(sourceInfo.fields[0].y, 0);
      expect(field.x).toBeGreaterThanOrEqual(sourceInfo.x);
      expect(field.right).toBeLessThanOrEqual(sourceInfo.right + 1);
    }
  }
  const controls = await dialog.evaluate(element => {
    const model = element.querySelector('.node-quick-editor-settings .node-parameter-select');
    const parameters = element.querySelector('.node-quick-editor-settings .node-quick-editor-summary-button');
    if (!model || !parameters) throw new Error('右栏缺少模型或视频参数入口');
    const modelBounds = model.getBoundingClientRect();
    const parameterBounds = parameters.getBoundingClientRect();
    return {
      modelCenterY: modelBounds.y + modelBounds.height / 2,
      parameterCenterY: parameterBounds.y + parameterBounds.height / 2,
      modelRight: modelBounds.right,
      parameterLeft: parameterBounds.left
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
async function expectSourcePreviews(panel) {
  const objects = [...identifiedTemplate.roles, ...identifiedTemplate.products];
  await expect(panel.locator('.video-recreation-object')).toHaveCount(objects.length);
  await expect(panel.locator('.video-recreation-object .video-recreation-preview-image')).toHaveCount(objects.length);
  const scene = panel.getByRole('img', {
    name: '原视频场景的原视频画面',
    exact: true
  });
  await expect(scene).toBeVisible({
    timeout: 15000
  });
  await expect(scene.locator('xpath=ancestor::figure[1]')).toHaveAttribute('data-timestamp-seconds', '0');
  await expect(scene.locator('xpath=ancestor::figure[1]')).toHaveAttribute('data-cropped', 'false');
  await scene.evaluate(element => element.decode());
  const sceneLayout = await panel.locator('.video-recreation-scenes').evaluate(element => {
    var _element$querySelecto, _element$querySelecto2, _element$querySelecto3;
    const columns = getComputedStyle(element).gridTemplateColumns.split(' ').length;
    const name = (_element$querySelecto = element.querySelector('h4')) === null || _element$querySelecto === void 0 ? void 0 : _element$querySelecto.getBoundingClientRect();
    const frame = (_element$querySelecto2 = element.querySelector('figure')) === null || _element$querySelecto2 === void 0 ? void 0 : _element$querySelecto2.getBoundingClientRect();
    const hint = (_element$querySelecto3 = element.querySelector('p')) === null || _element$querySelecto3 === void 0 ? void 0 : _element$querySelecto3.getBoundingClientRect();
    if (!name || !frame || !hint) throw new Error('场景缺少名称、缩略图或说明');
    return {
      columns,
      height: element.getBoundingClientRect().height,
      nameRight: name.right,
      frameLeft: frame.left,
      frameRight: frame.right,
      hintLeft: hint.left
    };
  });
  expect(sceneLayout.columns).toBe(3);
  expect(sceneLayout.height).toBeLessThanOrEqual(130);
  expect(sceneLayout.nameRight).toBeLessThanOrEqual(sceneLayout.frameLeft + 1);
  expect(sceneLayout.frameRight).toBeLessThanOrEqual(sceneLayout.hintLeft + 1);
  const measurements = [];
  for (const object of objects) {
    const preview = panel.getByRole('img', {
      name: object.label + '的原视频画面',
      exact: true
    });
    await expect(preview).toBeVisible({
      timeout: 15000
    });
    const objectLayout = await preview.locator('xpath=ancestor::article[1]').evaluate(article => {
      var _article$querySelecto, _article$querySelecto2, _article$querySelecto3;
      const name = (_article$querySelecto = article.querySelector('h4')) === null || _article$querySelecto === void 0 ? void 0 : _article$querySelecto.getBoundingClientRect();
      const frame = (_article$querySelecto2 = article.querySelector('.video-recreation-preview')) === null || _article$querySelecto2 === void 0 ? void 0 : _article$querySelecto2.getBoundingClientRect();
      const resource = (_article$querySelecto3 = article.querySelector('.video-recreation-object-resource')) === null || _article$querySelecto3 === void 0 ? void 0 : _article$querySelecto3.getBoundingClientRect();
      if (!name || !frame || !resource) throw new Error('对象缺少名称、原视频图或资源操作');
      return {
        nameRight: name.right,
        frameLeft: frame.left,
        frameRight: frame.right,
        resourceLeft: resource.left,
        columns: getComputedStyle(article).gridTemplateColumns.split(' ').length,
        height: article.getBoundingClientRect().height,
        bounded: article.scrollWidth <= article.clientWidth + 1
      };
    });
    expect(objectLayout.columns, object.label + '三段应在同一横排').toBe(3);
    expect(objectLayout.height, object.label + '单项最高 130px').toBeLessThanOrEqual(130);
    expect(objectLayout.nameRight).toBeLessThanOrEqual(objectLayout.frameLeft + 1);
    expect(objectLayout.frameRight).toBeLessThanOrEqual(objectLayout.resourceLeft + 1);
    expect(objectLayout.bounded).toBe(true);
    const figure = preview.locator('xpath=ancestor::figure[1]');
    await expect(figure).toHaveAttribute('data-timestamp-seconds', String(object.preview.timestampSeconds));
    await expect(figure).toHaveAttribute('data-cropped', 'true');
    await expect(figure).toContainText('局部裁剪');
    const pixels = await preview.evaluate(async element => {
      const image = element;
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
        maximum: Math.max(...colors)
      };
    });
    expect(pixels.width).toBeGreaterThan(0);
    expect(pixels.height).toBeGreaterThan(0);
    expect(pixels.maximum - pixels.minimum, object.label + '截图不能是空白占位图').toBeGreaterThan(20);
    measurements.push({
      label: object.label,
      ...pixels
    });
  }
  const sourceRatios = measurements.map((measurement, index) => {
    const box = objects[index].preview.boundingBox;
    return measurement.width / measurement.height / box.width * box.height;
  });
  for (const ratio of sourceRatios) expect(ratio).toBeCloseTo(sourceRatios[0], 1);
  return measurements;
}
for (const viewport of [{
  width: 1440,
  height: 1000
}, {
  width: 1366,
  height: 768
}]) {
  test('PC ' + viewport.width + '×' + viewport.height + ' 工具栏建草稿、节点专用三栏 Dialog 和明确分析生成', async ({
    page
  }, info) => {
    var _ctx$canvas$nodes$fin, _saved$data$videoRecr;
    await page.setViewportSize(viewport);
    const ctx = await fixture(page);
    await page.goto('/projects/' + project.id);
    const source = page.locator('.react-flow__node[data-id="source-video"]');
    await expect(source).toBeVisible({
      timeout: 15000
    });
    const sourceBefore = structuredClone(ctx.canvas().nodes[0]);
    await page.mouse.move(0, 0);
    await expect(source).not.toHaveClass(/\bselected\b/);
    expect(await source.evaluate(element => element.matches(':hover'))).toBe(false);
    const entry = page.getByRole('group', {
      name: '节点组',
      exact: true
    }).getByRole('button', {
      name: '短视频复刻',
      exact: true
    });
    await expect(entry).toBeVisible();
    await expect(entry).toBeInViewport({
      ratio: 1
    });
    await expect(entry).toHaveText('');
    await expect(entry).toHaveAttribute('title', '新建短视频复刻节点');
    await expect(entry.locator('svg.lucide-clapperboard')).toBeVisible();
    expect(await entry.evaluate(element => element.matches(':hover'))).toBe(false);
    await expect(page.getByRole('group', {
      name: '创建节点',
      exact: true
    }).getByRole('button')).toHaveCount(4);
    expect(ctx.postPaths).toEqual([]);
    await page.screenshot({
      path: info.outputPath('recreation-entry.png'),
      fullPage: true
    });
    await entry.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.node-quick-editor')).toHaveCount(0);
    await expect.poll(() => ctx.canvas().nodes.length).toBe(2);
    const draft = ctx.canvas().nodes.find(item => item.data.videoRecreationDraft);
    expect(draft.data.videoRecreation).toBeUndefined();
    expect(draft.data.mode).toBe('generate');
    const node = page.locator('.react-flow__node[data-id="' + draft.id + '"]');
    await expect(node).toBeVisible();
    const size = await node.boundingBox();
    expect(size).not.toBeNull();
    const dialog = await clickRecreationNode(page, node);
    const draftLayout = await expectRecreationLayout(dialog, viewport);
    await expect(dialog.getByRole('region', {
      name: '分析视频',
      exact: true
    })).toBeVisible();
    await expect(dialog.getByRole('region', {
      name: '替换资源',
      exact: true
    })).toBeVisible();
    await expect(dialog.getByRole('region', {
      name: '生成设置',
      exact: true
    })).toBeVisible();
    const reference = dialog.getByRole('combobox', {
      name: '参考视频',
      exact: true
    });
    await expectSelection(reference, '选择项目视频');
    await expect(dialog.getByRole('button', {
      name: '使用此视频',
      exact: true
    })).toBeDisabled();
    await expect(dialog.getByRole('button', {
      name: '生成',
      exact: true
    })).toBeDisabled();
    await expect(dialog.getByRole('status')).toContainText('请先选择参考视频并完成分析');
    await expect(dialog.getByLabel('上传参考视频', {
      exact: true
    })).toBeAttached();
    expect(ctx.posts).toHaveLength(0);
    expect(ctx.generates).toHaveLength(0);
    expect(ctx.postPaths).toEqual([]);
    await page.screenshot({
      path: info.outputPath('recreation-draft-dialog.png'),
      animations: 'disabled',
      fullPage: true
    });
    await selectOption(reference, /参考短视频/);
    expect((_ctx$canvas$nodes$fin = ctx.canvas().nodes.find(item => item.id === draft.id)) === null || _ctx$canvas$nodes$fin === void 0 ? void 0 : _ctx$canvas$nodes$fin.data.videoRecreation).toBeUndefined();
    expect(ctx.postPaths).toEqual([]);
    await dialog.getByRole('button', {
      name: '使用此视频',
      exact: true
    }).click();
    await expect(dialog.getByRole('region', {
      name: '短视频复刻',
      exact: true
    })).toBeVisible();
    await expect.poll(() => {
      var _ctx$canvas$nodes$fin2;
      return (_ctx$canvas$nodes$fin2 = ctx.canvas().nodes.find(item => item.id === draft.id)) === null || _ctx$canvas$nodes$fin2 === void 0 ? void 0 : _ctx$canvas$nodes$fin2.data.videoRecreation;
    }).toBeTruthy();
    const saved = ctx.canvas().nodes.find(item => item.id === draft.id);
    expect(saved.data.videoRecreationDraft).toBeUndefined();
    expect((_saved$data$videoRecr = saved.data.videoRecreation) === null || _saved$data$videoRecr === void 0 ? void 0 : _saved$data$videoRecr.source).toMatchObject({
      assetId: 'clip',
      assetVersion: 2,
      durationSeconds: 10
    });
    expect(ctx.canvas().nodes.find(item => item.id === sourceBefore.id)).toEqual(sourceBefore);
    expect(ctx.posts).toHaveLength(0);
    expect(ctx.generates).toHaveLength(0);
    expect(ctx.postPaths).toEqual([]);
    const boundLayout = await expectRecreationLayout(dialog, viewport);
    const player = dialog.locator('.video-recreation-source-preview video');
    await expect(player).toHaveAttribute('controls');
    await expect(player).toHaveAttribute('src', /\/v1\/assets\/clip\/versions\/2\/content$/);
    await expect.poll(() => player.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(1);
    const layoutPath = info.outputPath('recreation-dialog-layout.json');
    writeFileSync(layoutPath, JSON.stringify({
      viewport,
      draftLayout,
      boundLayout
    }, null, 2));
    await info.attach('复刻三栏边界', {
      path: layoutPath,
      contentType: 'application/json'
    });
    await dialog.getByRole('button', {
      name: '关闭编辑器',
      exact: true
    }).click();
    await expect(dialog).toBeHidden();
    await clickEmptyPane(page);
    await page.mouse.move(0, 0);
    await expect(node).not.toHaveClass(/\bselected\b/);
    expect(await node.evaluate(element => element.matches(':hover'))).toBe(false);
    const badge = node.locator('.flow-node-recreation-badge');
    await expect(badge).toBeVisible();
    // React Flow 缩放会产生 0.99999982 之类的交集浮点误差；保留百万分之一容差并核对完整边界。
    await expect(badge).toBeInViewport({
      ratio: 1 - 1e-6
    });
    const badgeBounds = await badge.boundingBox();
    expect(badgeBounds).not.toBeNull();
    expect(badgeBounds.x).toBeGreaterThanOrEqual(0);
    expect(badgeBounds.y).toBeGreaterThanOrEqual(0);
    expect(badgeBounds.x + badgeBounds.width).toBeLessThanOrEqual(viewport.width);
    expect(badgeBounds.y + badgeBounds.height).toBeLessThanOrEqual(viewport.height);
    await expect(badge).toContainText('短视频复刻');
    await expect(badge.locator('svg.lucide-clapperboard')).toBeVisible();
    // Playwright 的可见性断言不排除 opacity: 0；同时检查祖先，避免隐藏在悬浮工具栏内。
    expect(await badge.evaluate(element => {
      for (let current = element; current; current = current.parentElement) {
        if (Number(getComputedStyle(current).opacity) === 0) return false;
      }
      return true;
    })).toBe(true);
    await expect(node.locator('.flow-node-preview video')).toHaveAttribute('src', /\/v1\/assets\/clip\/versions\/2\/content$/);
    const deselectedSize = await node.boundingBox();
    expect(deselectedSize === null || deselectedSize === void 0 ? void 0 : deselectedSize.width).toBeCloseTo(size.width, 0);
    expect(deselectedSize === null || deselectedSize === void 0 ? void 0 : deselectedSize.height).toBeCloseTo(size.height, 0);
    await page.screenshot({
      path: info.outputPath('recreation-node-badge.png'),
      fullPage: true
    });
    await clickRecreationNode(page, node);
    const panel = page.getByRole('region', {
      name: '短视频复刻',
      exact: true
    });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', {
      name: '分析视频',
      exact: true
    }).locator('svg.lucide-clapperboard')).toBeVisible();
    await expect(panel.getByText('使用流程', {
      exact: true
    })).toHaveCount(0);
    await expect(panel.getByText('完整时长：10 秒', {
      exact: true
    })).toHaveCount(0);
    await expect(panel.getByRole('textbox', {
      name: '分析模型 ID',
      exact: true
    })).toHaveCount(0);
    await expect(panel.getByText('分析模型', {
      exact: true
    })).toHaveCount(0);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(ctx.postPaths).toEqual([]);
    const expandedSize = await node.boundingBox();
    expect(expandedSize === null || expandedSize === void 0 ? void 0 : expandedSize.width).toBeCloseTo(size.width, 0);
    expect(expandedSize === null || expandedSize === void 0 ? void 0 : expandedSize.height).toBeCloseTo(size.height, 0);
    await page.screenshot({
      path: info.outputPath('recreation-panel-controls.png'),
      fullPage: true
    });
    const fullEditor = dialog;
    await expect(fullEditor).toBeVisible();
    const fullPanel = fullEditor.getByRole('region', {
      name: '短视频复刻',
      exact: true
    });
    await fullPanel.getByRole('heading', {
      name: '分析视频',
      exact: true
    }).scrollIntoViewIfNeeded();
    await expect(fullPanel.getByRole('heading', {
      name: '分析视频',
      exact: true
    })).toBeInViewport({
      ratio: 1 - 1e-6
    });
    expect(ctx.postPaths).toEqual([]);
    await page.mouse.move(0, 0);
    await expect(page.getByRole('tooltip')).toBeHidden();
    await page.screenshot({
      path: info.outputPath('recreation-full-editor-controls.png'),
      animations: 'disabled',
      fullPage: true
    });
    await fullEditor.getByRole('button', {
      name: '关闭编辑器',
      exact: true
    }).click();
    await expect(fullEditor).toBeHidden();
    await expect(page.locator('.node-quick-editor')).toHaveCount(0);
    const closedEditorSize = await node.boundingBox();
    expect(closedEditorSize === null || closedEditorSize === void 0 ? void 0 : closedEditorSize.width).toBeCloseTo(size.width, 0);
    expect(closedEditorSize === null || closedEditorSize === void 0 ? void 0 : closedEditorSize.height).toBeCloseTo(size.height, 0);
    await openRecreation(page, saved.id);
    await panel.getByRole('button', {
      name: '分析整条视频',
      exact: true
    }).click();
    await expect(panel.getByRole('combobox', {
      name: '主角',
      exact: true
    })).toBeVisible();
    await expect(dialog.getByRole('textbox', {
      name: '提示词',
      exact: true
    })).toHaveValue(/【镜头编号】：Shot 01/);
    expect(ctx.posts).toHaveLength(1);
    expect(ctx.postPaths).toEqual(['/v1/assets/clip/versions/2/reverse-prompts']);
    expect(ctx.generates).toHaveLength(0);
    const generate = dialog.getByRole('button', {
      name: '生成',
      exact: true
    });
    await expect(generate).toBeEnabled();
    await selectOption(panel.getByRole('combobox', {
      name: '主角',
      exact: true
    }), '我的人物');
    await expect.poll(() => {
      var _ctx$canvas$nodes$fin3;
      return (_ctx$canvas$nodes$fin3 = ctx.canvas().nodes.find(item => item.id === saved.id)) === null || _ctx$canvas$nodes$fin3 === void 0 ? void 0 : _ctx$canvas$nodes$fin3.data.prompt;
    }).toContain('【镜头编号】：Shot 01');
    await expect(generate).toBeEnabled();
    expect(ctx.postPaths).toEqual(['/v1/assets/clip/versions/2/reverse-prompts']);
    expect(ctx.generates).toHaveLength(0);
    await generate.click();
    await expect.poll(() => ctx.generates.length).toBe(1);
    expect(ctx.postPaths).toEqual(['/v1/assets/clip/versions/2/reverse-prompts', '/v1/nodes/' + saved.id + '/runs']);
    expect(ctx.posts).toHaveLength(1);
    expect(ctx.errors).toEqual([]);
  });
}
test('整条分析、绑定人物、自动组装和明确生成，保存重载不重复分析', async ({
  page
}, info) => {
  var _saved$data$parameter, _saved$data$resourceR, _saved$data$videoRecr2, _snapshot$nodes, _snapshot$nodes2;
  await page.setViewportSize({
    width: 1440,
    height: 1000
  });
  const ctx = await fixture(page);
  const node = await createNode(page);
  const size = await node.boundingBox();
  const panel = page.getByRole('region', {
    name: '短视频复刻',
    exact: true
  });
  expect(ctx.posts).toHaveLength(0);
  expect(ctx.generates).toHaveLength(0);
  await panel.getByRole('button', {
    name: '分析整条视频',
    exact: true
  }).click();
  await expect(panel.getByRole('combobox', {
    name: '主角',
    exact: true
  })).toBeVisible();
  await selectOption(panel.getByRole('combobox', {
    name: '主角',
    exact: true
  }), '我的人物');
  await expect.poll(() => {
    var _ctx$canvas$nodes$fin4;
    return (_ctx$canvas$nodes$fin4 = ctx.canvas().nodes.find(n => n.data.videoRecreation)) === null || _ctx$canvas$nodes$fin4 === void 0 ? void 0 : _ctx$canvas$nodes$fin4.data.prompt;
  }).toContain('【镜头编号】：Shot 01');
  const saved = ctx.canvas().nodes.find(n => n.data.videoRecreation);
  expect((_saved$data$parameter = saved.data.parameters) === null || _saved$data$parameter === void 0 ? void 0 : _saved$data$parameter.duration).toBe(10);
  expect((_saved$data$resourceR = saved.data.resourceRefs) === null || _saved$data$resourceR === void 0 ? void 0 : _saved$data$resourceR.map(r => r.assetId)).toEqual(['person-a']);
  expect((_saved$data$videoRecr2 = saved.data.videoRecreation) === null || _saved$data$videoRecr2 === void 0 || (_saved$data$videoRecr2 = _saved$data$videoRecr2.analysis) === null || _saved$data$videoRecr2 === void 0 ? void 0 : _saved$data$videoRecr2.template.dialogue).toEqual(template.dialogue);
  expect(saved.data.prompt).toContain('请看这个。');
  await expect(panel.getByText('查看完整模板、镜头动作与台词')).toHaveCount(0);
  expect(ctx.posts).toHaveLength(1);
  await expect(page.getByRole('dialog', {
    name: '短视频复刻',
    exact: true
  }).getByRole('textbox', {
    name: '提示词',
    exact: true
  })).toContainText('请看这个。');
  expect(ctx.generates).toHaveLength(0);
  const after = await node.boundingBox();
  expect(after === null || after === void 0 ? void 0 : after.width).toBeCloseTo(size.width, 0);
  expect(after === null || after === void 0 ? void 0 : after.height).toBeCloseTo(size.height, 0);
  await page.screenshot({
    path: info.outputPath('recreation-bound-desktop.png'),
    fullPage: true
  });
  await page.reload();
  const restored = await openRecreation(page, saved.id);
  await expectSelection(restored.getByRole('combobox', {
    name: '主角',
    exact: true
  }), '我的人物');
  expect(ctx.posts).toHaveLength(1);
  await page.getByRole('dialog', {
    name: '短视频复刻',
    exact: true
  }).getByRole('button', {
    name: '生成',
    exact: true
  }).click();
  await expect.poll(() => ctx.generates.length).toBe(1);
  expect((_snapshot$nodes = ctx.generates[0].snapshot.nodes) === null || _snapshot$nodes === void 0 || (_snapshot$nodes = _snapshot$nodes.find(n => n.id === saved.id)) === null || _snapshot$nodes === void 0 || (_snapshot$nodes = _snapshot$nodes.data.videoRecreation) === null || _snapshot$nodes === void 0 ? void 0 : _snapshot$nodes.source).toMatchObject({
    assetId: 'clip',
    assetVersion: 2
  });
  expect((_snapshot$nodes2 = ctx.generates[0].snapshot.nodes) === null || _snapshot$nodes2 === void 0 || (_snapshot$nodes2 = _snapshot$nodes2.find(n => n.id === saved.id)) === null || _snapshot$nodes2 === void 0 ? void 0 : _snapshot$nodes2.data.prompt).toContain('请看这个。');
  expect(ctx.errors).toEqual([]);
});
test('右栏放大提示词后可编辑完整中文分镜，并同步回原输入框', async ({
  page
}, info) => {
  await page.setViewportSize({
    width: 1440,
    height: 1000
  });
  const ctx = await fixture(page);
  await createNode(page);
  const recreation = page.getByRole('dialog', {
    name: '短视频复刻',
    exact: true
  });
  await recreation.getByRole('button', {
    name: '分析整条视频',
    exact: true
  }).click();
  const rightEditor = recreation.getByRole('textbox', {
    name: '提示词',
    exact: true
  });
  await expect(rightEditor).toHaveValue(/【镜头编号】：Shot 01/);
  await recreation.getByRole('button', {
    name: '放大编辑提示词',
    exact: true
  }).click();
  const expanded = page.getByRole('dialog', {
    name: '完整提示词',
    exact: true
  });
  await expect(expanded).toBeVisible();
  const fullEditor = expanded.getByRole('textbox', {
    name: '提示词',
    exact: true
  });
  await expect(fullEditor).toHaveValue(/【镜头编号】：Shot 02/);
  await expect.poll(async () => {
    const panel = await expanded.boundingBox();
    const editor = await fullEditor.boundingBox();
    return Boolean(panel && editor && panel.y >= 20 && panel.y + panel.height <= 980 && editor.y >= panel.y && editor.y + editor.height <= panel.y + panel.height + 1);
  }).toBe(true);
  await page.screenshot({
    path: info.outputPath('recreation-prompt-expanded.png')
  });
  await fullEditor.fill('【镜头编号】：Shot 01\n【动作】：手动校对分镜');
  await expect(fullEditor).toHaveValue(/手动校对分镜/);
  await expanded.getByRole('button', {
    name: '关闭完整提示词',
    exact: true
  }).click();
  await expect(expanded).toBeHidden();
  await expect(rightEditor).toHaveValue(/手动校对分镜/);
  await expect.poll(() => {
    var _ctx$canvas$nodes$fin5;
    return (_ctx$canvas$nodes$fin5 = ctx.canvas().nodes.find(node => node.data.videoRecreation)) === null || _ctx$canvas$nodes$fin5 === void 0 ? void 0 : _ctx$canvas$nodes$fin5.data.prompt;
  }).toContain('手动校对分镜');
  await recreation.getByRole('button', {
    name: '整理为中文分镜',
    exact: true
  }).click();
  await expect(rightEditor).toHaveValue(/【镜头编号】：Shot 02/);
  await expect(rightEditor).not.toHaveValue(/手动校对分镜/);
  expect(ctx.postPaths).toEqual(['/v1/assets/clip/versions/2/reverse-prompts']);
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});
test('更换人物和商品不重复分析，慢保存不打断商品说明连续输入', async ({
  page
}) => {
  var _ctx$canvas$nodes$fin8;
  await page.setViewportSize({
    width: 1440,
    height: 1000
  });
  const ctx = await fixture(page, 2, 150);
  await createNode(page);
  const panel = page.getByRole('region', {
    name: '短视频复刻',
    exact: true
  });
  await panel.getByRole('button', {
    name: '分析整条视频',
    exact: true
  }).click();
  await selectOption(panel.getByRole('combobox', {
    name: '主角',
    exact: true
  }), '我的人物');
  await selectOption(panel.getByRole('combobox', {
    name: '主角',
    exact: true
  }), '另一人物');
  await selectOption(panel.getByRole('combobox', {
    name: '商品',
    exact: true
  }), '新商品');
  await expect(page.getByRole('dialog', {
    name: '短视频复刻',
    exact: true
  }).getByRole('button', {
    name: '生成',
    exact: true
  })).toBeDisabled();
  const description = '香水，喷洒使用；不饮用，不添加未确认功效';
  const productInput = panel.getByRole('textbox', {
    name: /用途|卖点/
  });
  await productInput.click();
  await productInput.pressSequentially(description, {
    delay: 10
  });
  await expect(productInput).toHaveValue(description);
  await expect(productInput).toBeFocused();
  await expect.poll(() => {
    var _ctx$canvas$nodes$fin6;
    return (_ctx$canvas$nodes$fin6 = ctx.canvas().nodes.find(n => n.data.videoRecreation)) === null || _ctx$canvas$nodes$fin6 === void 0 || (_ctx$canvas$nodes$fin6 = _ctx$canvas$nodes$fin6.data.videoRecreation) === null || _ctx$canvas$nodes$fin6 === void 0 ? void 0 : _ctx$canvas$nodes$fin6.productDescription;
  }).toBe(description);
  await expect.poll(() => {
    var _ctx$canvas$nodes$fin7;
    return (_ctx$canvas$nodes$fin7 = ctx.canvas().nodes.find(n => n.data.videoRecreation)) === null || _ctx$canvas$nodes$fin7 === void 0 ? void 0 : _ctx$canvas$nodes$fin7.data.prompt;
  }).toContain('替换商品仅按已确认用途调整不兼容动作');
  expect((_ctx$canvas$nodes$fin8 = ctx.canvas().nodes.find(n => n.data.videoRecreation)) === null || _ctx$canvas$nodes$fin8 === void 0 || (_ctx$canvas$nodes$fin8 = _ctx$canvas$nodes$fin8.data.resourceRefs) === null || _ctx$canvas$nodes$fin8 === void 0 ? void 0 : _ctx$canvas$nodes$fin8.map(r => r.assetId)).toEqual(['person-b', 'product']);
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});
test('保存分析任务后刷新只查询原run，不重新POST', async ({
  page
}) => {
  await page.setViewportSize({
    width: 1366,
    height: 900
  });
  const ctx = await fixture(page);
  ctx.hold(true);
  await createNode(page);
  await page.getByRole('region', {
    name: '短视频复刻',
    exact: true
  }).getByRole('button', {
    name: '分析整条视频',
    exact: true
  }).click();
  await expect.poll(() => {
    var _ctx$canvas$nodes$fin9;
    return (_ctx$canvas$nodes$fin9 = ctx.canvas().nodes.find(n => n.data.videoRecreation)) === null || _ctx$canvas$nodes$fin9 === void 0 || (_ctx$canvas$nodes$fin9 = _ctx$canvas$nodes$fin9.data.videoRecreation) === null || _ctx$canvas$nodes$fin9 === void 0 || (_ctx$canvas$nodes$fin9 = _ctx$canvas$nodes$fin9.request) === null || _ctx$canvas$nodes$fin9 === void 0 ? void 0 : _ctx$canvas$nodes$fin9.runId;
  }).toBe('analysis-1');
  const saved = ctx.canvas().nodes.find(n => n.data.videoRecreation);
  await page.reload();
  await openRecreation(page, saved.id);
  expect(ctx.posts).toHaveLength(1);
  ctx.hold(false);
  await expect(page.getByRole('combobox', {
    name: '主角',
    exact: true
  })).toBeVisible({
    timeout: 10000
  });
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});
test('历史回显冻结旧版本视频与时长，较小PC专用 Dialog 可完成绑定', async ({
  page
}, info) => {
  var _saved$data$videoRecr3, _saved$data$parameter2, _saved$data$resourceR2;
  await page.setViewportSize({
    width: 1366,
    height: 900
  });
  const ctx = await fixture(page, 3);
  const node = await createNode(page, true);
  const bounds = await node.boundingBox();
  const dialog = page.getByRole('dialog', {
    name: '短视频复刻',
    exact: true
  });
  const panel = dialog.getByRole('region', {
    name: '短视频复刻',
    exact: true
  });
  await expect(panel).toBeVisible();
  const layout = await expectRecreationLayout(dialog, {
    width: 1366,
    height: 900
  });
  const player = panel.locator('.video-recreation-source-preview video');
  await expect(player).toHaveAttribute('src', /\/v1\/assets\/clip\/versions\/2\/content$/);
  await expect(player).toHaveAttribute('controls');
  await expect.poll(() => player.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(1);
  await player.evaluate(element => element.play());
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  await player.evaluate(element => element.pause());
  expect(ctx.posts).toHaveLength(0);
  expect(ctx.generates).toHaveLength(0);
  await panel.getByRole('button', {
    name: '分析整条视频',
    exact: true
  }).click();
  await selectOption(panel.getByRole('combobox', {
    name: '主角',
    exact: true
  }), '我的人物');
  await expect.poll(() => {
    var _ctx$canvas$nodes$fin0;
    return (_ctx$canvas$nodes$fin0 = ctx.canvas().nodes.find(n => n.data.videoRecreation)) === null || _ctx$canvas$nodes$fin0 === void 0 ? void 0 : _ctx$canvas$nodes$fin0.data.prompt;
  }).toContain('【镜头编号】：Shot 01');
  const saved = ctx.canvas().nodes.find(n => n.data.videoRecreation);
  expect((_saved$data$videoRecr3 = saved.data.videoRecreation) === null || _saved$data$videoRecr3 === void 0 ? void 0 : _saved$data$videoRecr3.source).toMatchObject({
    assetVersion: 2,
    durationSeconds: 10
  });
  expect((_saved$data$parameter2 = saved.data.parameters) === null || _saved$data$parameter2 === void 0 ? void 0 : _saved$data$parameter2.duration).toBe(10);
  expect((_saved$data$resourceR2 = saved.data.resourceRefs) === null || _saved$data$resourceR2 === void 0 ? void 0 : _saved$data$resourceR2.map(r => [r.assetId, r.assetVersion])).toEqual([['person-a', 3]]);
  await expect(dialog.getByRole('button', {
    name: '生成',
    exact: true
  })).toBeEnabled();
  await panel.getByRole('combobox', {
    name: '主角',
    exact: true
  }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('recreation-expanded-pc.png'),
    fullPage: true
  });
  const layoutPath = info.outputPath('recreation-frozen-video-layout.json');
  writeFileSync(layoutPath, JSON.stringify({
    layout,
    consoleErrors: ctx.errors
  }, null, 2));
  await info.attach('冻结版本视频布局', {
    path: layoutPath,
    contentType: 'application/json'
  });
  await dialog.getByRole('button', {
    name: '关闭编辑器',
    exact: true
  }).click();
  const after = await node.boundingBox();
  expect(after === null || after === void 0 ? void 0 : after.width).toBeCloseTo(bounds.width, 0);
  expect(after === null || after === void 0 ? void 0 : after.height).toBeCloseTo(bounds.height, 0);
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});
test('只上传人物图片即可绑定真实返回版本，不额外分析或自动生成', async ({
  page
}) => {
  var _saved$data$resourceR3, _saved$data$videoRecr4;
  await page.setViewportSize({
    width: 1440,
    height: 1000
  });
  const ctx = await fixture(page);
  await createNode(page);
  const panel = page.getByRole('region', {
    name: '短视频复刻',
    exact: true
  });
  await panel.getByRole('button', {
    name: '分析整条视频',
    exact: true
  }).click();
  await panel.getByLabel('上传主角图片', {
    exact: true
  }).setInputFiles({
    name: '我的人物.jpg',
    mimeType: 'image/jpeg',
    buffer: image
  });
  await expect.poll(() => {
    var _ctx$canvas$nodes$fin1;
    return (_ctx$canvas$nodes$fin1 = ctx.canvas().nodes.find(n => n.data.videoRecreation)) === null || _ctx$canvas$nodes$fin1 === void 0 || (_ctx$canvas$nodes$fin1 = _ctx$canvas$nodes$fin1.data.videoRecreation) === null || _ctx$canvas$nodes$fin1 === void 0 ? void 0 : _ctx$canvas$nodes$fin1.bindings;
  }).toEqual([{
    roleId: 'character_a',
    assetId: 'uploaded-character',
    assetVersion: 5,
    name: '我的人物.jpg'
  }]);
  await expectSelection(panel.getByRole('combobox', {
    name: '主角',
    exact: true
  }), '我的人物.jpg');
  const saved = ctx.canvas().nodes.find(n => n.data.videoRecreation);
  expect((_saved$data$resourceR3 = saved.data.resourceRefs) === null || _saved$data$resourceR3 === void 0 ? void 0 : _saved$data$resourceR3.map(r => [r.assetId, r.assetVersion])).toEqual([['uploaded-character', 5]]);
  expect((_saved$data$videoRecr4 = saved.data.videoRecreation) === null || _saved$data$videoRecr4 === void 0 ? void 0 : _saved$data$videoRecr4.product).toBeUndefined();
  expect(ctx.uploads).toEqual(['init', 'bytes', 'complete']);
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});
for (const viewport of [{
  width: 1440,
  height: 1000
}, {
  width: 1920,
  height: 1080
}]) {
  test('PC ' + viewport.width + '×' + viewport.height + ' 逐个人物和商品识别预览、单件替换并保存重载', async ({
    page
  }, info) => {
    var _saved$data$videoRecr5, _saved$data$videoRecr6, _saved$data$parameter3, _snapshot$nodes3;
    test.setTimeout(60000);
    await page.setViewportSize(viewport);
    const ctx = await fixture(page, 2, 0, true);
    const node = await createNode(page);
    const size = await node.boundingBox();
    const panel = page.getByRole('region', {
      name: '短视频复刻',
      exact: true
    });
    const analysisModel = panel.getByRole('combobox', {
      name: '分析模型',
      exact: true
    });
    await expectSelection(analysisModel, 'qwen3.8-omni-flash');
    expect(ctx.posts).toHaveLength(0);
    expect(ctx.generates).toHaveLength(0);
    const sourceReadsBeforeAnalysis = ctx.sourceContentRequests.length;
    await panel.getByRole('button', {
      name: '分析整条视频',
      exact: true
    }).click();
    await expect(panel.getByRole('combobox', {
      name: '同伴',
      exact: true
    })).toBeVisible();
    expect(ctx.posts).toHaveLength(1);
    expect(ctx.posts[0]).toMatchObject({
      modelAlias: 'qwen3.8-omni-flash',
      credentialId: analysisCredentialId,
      purpose: 'video_recreation'
    });
    await expect(panel.getByText('本次分析模型：qwen3.8-omni-flash')).toHaveCount(0);
    const sourcePreviews = await expectSourcePreviews(panel);
    const sourceReadsAfterAnalysis = ctx.sourceContentRequests.length;
    await expectSelection(panel.getByRole('combobox', {
      name: '主角',
      exact: true
    }), '保留原视频人物（不替换）');
    await expectSelection(panel.getByRole('combobox', {
      name: '同伴',
      exact: true
    }), '保留原视频人物（不替换）');
    await expectSelection(panel.getByRole('combobox', {
      name: '香水瓶',
      exact: true
    }), '保留原视频商品（不替换）');
    await expectSelection(panel.getByRole('combobox', {
      name: '手提袋',
      exact: true
    }), '保留原视频商品（不替换）');
    await selectOption(panel.getByRole('combobox', {
      name: '主角',
      exact: true
    }), '我的人物');
    await selectOption(panel.getByRole('combobox', {
      name: '主角',
      exact: true
    }), '保留原视频人物（不替换）');
    await expect.poll(() => {
      var _ctx$canvas$nodes$fin10;
      return (_ctx$canvas$nodes$fin10 = ctx.canvas().nodes.find(entry => entry.data.videoRecreation)) === null || _ctx$canvas$nodes$fin10 === void 0 || (_ctx$canvas$nodes$fin10 = _ctx$canvas$nodes$fin10.data.videoRecreation) === null || _ctx$canvas$nodes$fin10 === void 0 ? void 0 : _ctx$canvas$nodes$fin10.bindings;
    }).toEqual([]);
    await selectOption(panel.getByRole('combobox', {
      name: '主角',
      exact: true
    }), '另一人物');
    await selectOption(panel.getByRole('combobox', {
      name: '香水瓶',
      exact: true
    }), '新商品');
    const generate = page.getByRole('dialog', {
      name: '短视频复刻',
      exact: true
    }).getByRole('button', {
      name: '生成',
      exact: true
    });
    await expect(generate).toBeDisabled();
    const description = '香水，喷洒使用；不饮用，不添加未确认功效';
    await panel.getByRole('textbox', {
      name: '香水瓶用途与已确认卖点',
      exact: true
    }).fill(description);
    await expect(generate).toBeEnabled();
    await expect.poll(() => {
      var _ctx$canvas$nodes$fin11;
      return (_ctx$canvas$nodes$fin11 = ctx.canvas().nodes.find(entry => entry.data.videoRecreation)) === null || _ctx$canvas$nodes$fin11 === void 0 || (_ctx$canvas$nodes$fin11 = _ctx$canvas$nodes$fin11.data.videoRecreation) === null || _ctx$canvas$nodes$fin11 === void 0 ? void 0 : _ctx$canvas$nodes$fin11.productBindings;
    }).toEqual([{
      productId: 'product_a',
      assetId: 'product',
      assetVersion: 3,
      name: '新商品',
      description
    }]);
    await expect.poll(() => {
      var _ctx$canvas$nodes$fin12;
      return (_ctx$canvas$nodes$fin12 = ctx.canvas().nodes.find(entry => entry.data.videoRecreation)) === null || _ctx$canvas$nodes$fin12 === void 0 || (_ctx$canvas$nodes$fin12 = _ctx$canvas$nodes$fin12.data.videoRecreation) === null || _ctx$canvas$nodes$fin12 === void 0 ? void 0 : _ctx$canvas$nodes$fin12.preservedRoleIds;
    }).toEqual(['character_b']);
    await expect.poll(() => {
      var _ctx$canvas$nodes$fin13;
      return (_ctx$canvas$nodes$fin13 = ctx.canvas().nodes.find(entry => entry.data.videoRecreation)) === null || _ctx$canvas$nodes$fin13 === void 0 || (_ctx$canvas$nodes$fin13 = _ctx$canvas$nodes$fin13.data.resourceRefs) === null || _ctx$canvas$nodes$fin13 === void 0 ? void 0 : _ctx$canvas$nodes$fin13.map(reference => [reference.assetId, reference.assetVersion]);
    }).toEqual([['person-b', 3], ['product', 3]]);
    await selectOption(analysisModel, /视频分析模型/);
    const generationModel = page.getByRole('combobox', {
      name: /^视频生成模型：/
    });
    await generationModel.click();
    await page.getByRole('listbox', {
      name: '视频生成模型选项',
      exact: true
    }).getByRole('option', {
      name: /独立视频生成模型/
    }).click();
    await expect.poll(() => {
      var _ctx$canvas$nodes$fin14;
      return (_ctx$canvas$nodes$fin14 = ctx.canvas().nodes.find(entry => entry.data.videoRecreation)) === null || _ctx$canvas$nodes$fin14 === void 0 ? void 0 : _ctx$canvas$nodes$fin14.data.modelAlias;
    }).toBe('sora-2');
    const saved = ctx.canvas().nodes.find(entry => entry.data.videoRecreation);
    expect((_saved$data$videoRecr5 = saved.data.videoRecreation) === null || _saved$data$videoRecr5 === void 0 || (_saved$data$videoRecr5 = _saved$data$videoRecr5.analysis) === null || _saved$data$videoRecr5 === void 0 ? void 0 : _saved$data$videoRecr5.modelAlias).toBe('qwen3.8-omni-flash');
    expect((_saved$data$videoRecr6 = saved.data.videoRecreation) === null || _saved$data$videoRecr6 === void 0 ? void 0 : _saved$data$videoRecr6.product).toBeUndefined();
    expect((_saved$data$parameter3 = saved.data.parameters) === null || _saved$data$parameter3 === void 0 ? void 0 : _saved$data$parameter3.duration).toBe(10);
    expect(saved.data.prompt).toContain('替换商品仅按已确认用途调整不兼容动作');
    expect(saved.data.prompt).toContain('同伴（保留分析外观');
    expect(saved.data.prompt).toContain('手提袋（按分析描述保留');
    expect(ctx.postPaths).toEqual(['/v1/assets/clip/versions/2/reverse-prompts']);
    expect(ctx.generates).toHaveLength(0);
    const after = await node.boundingBox();
    expect(after === null || after === void 0 ? void 0 : after.width).toBeCloseTo(size.width, 0);
    expect(after === null || after === void 0 ? void 0 : after.height).toBeCloseTo(size.height, 0);
    await page.reload();
    const restored = await openRecreation(page, saved.id);
    await expectSelection(restored.getByRole('combobox', {
      name: '主角',
      exact: true
    }), '另一人物');
    await expectSelection(restored.getByRole('combobox', {
      name: '同伴',
      exact: true
    }), '保留原视频人物（不替换）');
    await expectSelection(restored.getByRole('combobox', {
      name: '香水瓶',
      exact: true
    }), '新商品');
    await expectSelection(restored.getByRole('combobox', {
      name: '手提袋',
      exact: true
    }), '保留原视频商品（不替换）');
    await expect(restored.getByRole('textbox', {
      name: '香水瓶用途与已确认卖点',
      exact: true
    })).toHaveValue(description);
    await expect(restored.getByText('本次分析模型：qwen3.8-omni-flash')).toHaveCount(0);
    expect(ctx.posts).toHaveLength(1);
    expect(ctx.generates).toHaveLength(0);
    const editor = page.getByRole('dialog', {
      name: '短视频复刻',
      exact: true
    });
    const fullPanel = editor.getByRole('region', {
      name: '短视频复刻',
      exact: true
    });
    const dialogLayout = await expectRecreationLayout(editor, viewport);
    const sourceName = fullPanel.locator('.video-recreation-source-name');
    await sourceName.hover();
    await expect(page.getByRole('tooltip')).toHaveText(saved.data.videoRecreation.source.name);
    await page.mouse.move(0, 0);
    await expect(page.getByRole('tooltip')).toBeHidden();
    const fullEditorPreviews = await expectSourcePreviews(fullPanel);
    const analysisColumn = fullPanel.getByRole('region', {
      name: '原视频与分析',
      exact: true
    });
    const resourcesColumn = fullPanel.getByRole('region', {
      name: '替换资源',
      exact: true
    });
    const generationColumn = editor.getByRole('region', {
      name: '生成设置',
      exact: true
    });
    const analysisScrollTop = await analysisColumn.evaluate(element => element.scrollTop);
    const generationScrollTop = await generationColumn.evaluate(element => element.scrollTop);
    const replacementSelectors = fullPanel.locator('.video-recreation-object-resource [role="combobox"]');
    await expect(replacementSelectors).toHaveCount(4);
    await expectSelection(replacementSelectors.nth(0), '另一人物');
    await expectSelection(replacementSelectors.nth(2), '新商品');
    await fullPanel.getByRole('img', {
      name: '主角的原视频画面',
      exact: true
    }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath('recreation-identified-roles-pc.png'),
      animations: 'disabled',
      fullPage: true
    });
    await fullPanel.getByRole('button', {
      name: '上传手提袋图片',
      exact: true
    }).scrollIntoViewIfNeeded();
    const resourceScroll = await resourcesColumn.evaluate(element => ({
      top: element.scrollTop,
      overflows: element.scrollHeight > element.clientHeight + 1
    }));
    if (resourceScroll.overflows) expect(resourceScroll.top).toBeGreaterThan(0);else expect(resourceScroll.top).toBe(0);
    expect(await analysisColumn.evaluate(element => element.scrollTop)).toBe(analysisScrollTop);
    expect(await generationColumn.evaluate(element => element.scrollTop)).toBe(generationScrollTop);
    await page.screenshot({
      path: info.outputPath('recreation-identified-products-pc.png'),
      animations: 'disabled',
      fullPage: true
    });
    expect(await fullPanel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await editor.getByRole('button', {
      name: '关闭编辑器',
      exact: true
    }).click();
    await expect(editor).toBeHidden();
    const closedSize = await node.boundingBox();
    expect(closedSize === null || closedSize === void 0 ? void 0 : closedSize.width).toBeCloseTo(size.width, 0);
    expect(closedSize === null || closedSize === void 0 ? void 0 : closedSize.height).toBeCloseTo(size.height, 0);
    await page.screenshot({
      path: info.outputPath('recreation-identified-workspace-pc.png'),
      animations: 'disabled',
      fullPage: true
    });
    await openRecreation(page, saved.id);
    await generate.click();
    await expect.poll(() => ctx.generates.length).toBe(1);
    expect(ctx.generates[0].modelAlias).toBe('sora-2');
    expect((_snapshot$nodes3 = ctx.generates[0].snapshot.nodes) === null || _snapshot$nodes3 === void 0 || (_snapshot$nodes3 = _snapshot$nodes3.find(entry => entry.id === saved.id)) === null || _snapshot$nodes3 === void 0 ? void 0 : _snapshot$nodes3.data.videoRecreation).toEqual(saved.data.videoRecreation);
    expect(ctx.posts).toHaveLength(1);
    expect(ctx.errors).toEqual([]);
    const evidencePath = info.outputPath('recreation-identified-evidence.json');
    writeFileSync(evidencePath, JSON.stringify({
      viewport,
      dialogLayout,
      previews: sourcePreviews,
      fullEditorPreviews,
      sourceReadsBeforeAnalysis,
      sourceReadsAfterAnalysis,
      sourceContentRequests: ctx.sourceContentRequests,
      nodeBounds: {
        initial: size,
        afterBindings: after,
        afterEditor: closedSize
      },
      consoleErrors: ctx.errors
    }, null, 2));
    await info.attach('复刻截图、请求与节点尺寸', {
      path: evidencePath,
      contentType: 'application/json'
    });
  });
}
test('分析目录只列文本项，选择模型与分组后仅在明确分析时提交', async ({
  page
}) => {
  var _ctx$canvas$nodes$fin15;
  await page.setViewportSize({
    width: 1440,
    height: 1000
  });
  const ctx = await fixture(page, 2, 0, true);
  await createNode(page);
  const panel = page.getByRole('region', {
    name: '短视频复刻',
    exact: true
  });
  const select = panel.getByRole('combobox', {
    name: '分析模型',
    exact: true
  });
  await expectSelection(select, 'qwen3.8-omni-flash');
  await expect(panel.getByRole('textbox', {
    name: '分析模型 ID',
    exact: true
  })).toHaveCount(0);
  await select.click();
  await expect(page.getByRole('option', {
    name: /参考视频生成模型|独立视频生成模型/
  })).toHaveCount(0);
  await page.getByRole('option', {
    name: /视频分析模型/
  }).click();
  expect(ctx.posts).toHaveLength(0);
  expect(ctx.generates).toHaveLength(0);
  await panel.getByRole('button', {
    name: '分析整条视频',
    exact: true
  }).click();
  await expect(panel.getByRole('combobox', {
    name: '同伴',
    exact: true
  })).toBeVisible();
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.posts[0]).toMatchObject({
    modelAlias: 'vision-test',
    credentialId: analysisCredentialId
  });
  await expect(panel.getByText('本次分析模型：vision-test')).toHaveCount(0);
  expect((_ctx$canvas$nodes$fin15 = ctx.canvas().nodes.find(entry => entry.data.videoRecreation)) === null || _ctx$canvas$nodes$fin15 === void 0 ? void 0 : _ctx$canvas$nodes$fin15.data.modelAlias).toBe('MiniMax-H3');
  expect(ctx.generates).toHaveLength(0);
  expect(ctx.errors).toEqual([]);
});
test('对象预览与项目图片搜索弹窗可交互，显式生成的图片回显原节点并保持尺寸', async ({
  page
}, info) => {
  var _ctx$canvas$nodes$fin16, _saved$data$videoRecr7, _saved$data$videoRecr8, _saved$data$videoRecr9, _saved$data$videoRecr0, _saved$data$parameter4, _ctx$canvas$nodes$fin18;
  test.setTimeout(60000);
  await page.setViewportSize({
    width: 1440,
    height: 1000
  });
  const ctx = await fixture(page, 2, 0, true, 'image');
  const createdNode = await createNode(page);
  const nodeId = await createdNode.getAttribute('data-id');
  const node = page.locator('.react-flow__node[data-id="' + nodeId + '"]');
  const size = await node.boundingBox();
  const editor = page.getByRole('dialog', {
    name: '短视频复刻',
    exact: true
  });
  const panel = editor.getByRole('region', {
    name: '短视频复刻',
    exact: true
  });
  await panel.getByRole('button', {
    name: '分析整条视频',
    exact: true
  }).click();
  await expectSourcePreviews(panel);
  const savedAnalysis = structuredClone((_ctx$canvas$nodes$fin16 = ctx.canvas().nodes.find(entry => entry.id === nodeId)) === null || _ctx$canvas$nodes$fin16 === void 0 || (_ctx$canvas$nodes$fin16 = _ctx$canvas$nodes$fin16.data.videoRecreation) === null || _ctx$canvas$nodes$fin16 === void 0 ? void 0 : _ctx$canvas$nodes$fin16.analysis);
  await panel.getByRole('tab', {
    name: '未确认证据',
    exact: true
  }).click();
  await expect(panel.getByText(identifiedTemplate.unknowns[0], {
    exact: true
  })).toBeVisible();
  await panel.getByRole('tab', {
    name: '整体摘要',
    exact: true
  }).click();
  await expect(panel.getByText('整条视频两个人物、两件物品', {
    exact: true
  })).toBeVisible();
  const role = panel.getByRole('article', {
    name: '人物：主角',
    exact: true
  });
  const heading = role.getByRole('heading', {
    name: '主角',
    exact: true
  });
  await heading.hover();
  await expect(page.getByRole('tooltip')).toContainText('画面左侧人物，右手拿着香水瓶');
  await expect(page.getByRole('tooltip')).toContainText('出现时间：0–10 秒');
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toBeHidden();
  const preview = role.getByRole('img', {
    name: '主角的原视频画面',
    exact: true
  });
  await preview.click();
  const expandedImage = page.locator('.ant-image-preview-img');
  await expect(expandedImage).toBeVisible();
  await expect(expandedImage).toHaveAttribute('src', await preview.getAttribute('src'));
  await page.screenshot({
    path: info.outputPath('recreation-image-preview.png'),
    animations: 'disabled',
    fullPage: true
  });
  await page.keyboard.press('Escape');
  await expect(expandedImage).toBeHidden();
  await expect(editor).toBeVisible();
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  const summary = editor.getByRole('button', {
    name: '视频参数',
    exact: true
  });
  await summary.click();
  const duration = page.getByRole('button', {
    name: /^时长（秒）：/
  });
  await duration.click();
  const durationDialog = page.getByRole('dialog', {
    name: '视频时长',
    exact: true
  });
  await durationDialog.getByRole('spinbutton', {
    name: '自定义时长（秒）',
    exact: true
  }).fill('7');
  await durationDialog.getByRole('spinbutton', {
    name: '自定义时长（秒）',
    exact: true
  }).press('Escape');
  await expect(durationDialog).toBeHidden();
  await expect(editor).toBeVisible();
  await role.getByRole('button', {
    name: '搜索主角替换资源',
    exact: true
  }).click();
  const search = page.getByRole('dialog', {
    name: '选择替换图片',
    exact: true
  });
  await expect(search).toBeVisible();
  await search.getByRole('searchbox', {
    name: '搜索项目资料',
    exact: true
  }).fill('项目新人物');
  const resource = search.getByRole('button', {
    name: '添加参考资料 项目新人物 v8',
    exact: true
  });
  await expect(resource).toBeVisible();
  expect(ctx.resourceSearches.at(-1)).toEqual({
    query: '项目新人物',
    mediaType: 'image',
    page: '1',
    projectId: project.id
  });
  await expect(search.getByRole('button', {
    name: /添加参考资料 参考短视频/
  })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('recreation-resource-search.png'),
    animations: 'disabled',
    fullPage: true
  });
  await resource.click();
  await expect(search).toBeHidden();
  await expect(editor).toBeVisible();
  await expectSelection(role.getByRole('combobox', {
    name: '主角',
    exact: true
  }), '项目新人物');
  await expect.poll(() => {
    var _ctx$canvas$nodes$fin17;
    return (_ctx$canvas$nodes$fin17 = ctx.canvas().nodes.find(entry => entry.id === nodeId)) === null || _ctx$canvas$nodes$fin17 === void 0 || (_ctx$canvas$nodes$fin17 = _ctx$canvas$nodes$fin17.data.videoRecreation) === null || _ctx$canvas$nodes$fin17 === void 0 ? void 0 : _ctx$canvas$nodes$fin17.bindings;
  }).toEqual([{
    roleId: 'character_a',
    assetId: 'remote-person',
    assetVersion: 8,
    name: '项目新人物'
  }]);
  const saved = ctx.canvas().nodes.find(entry => entry.id === nodeId);
  expect((_saved$data$videoRecr7 = saved.data.videoRecreation) === null || _saved$data$videoRecr7 === void 0 ? void 0 : _saved$data$videoRecr7.preservedRoleIds).toEqual(['character_b']);
  expect((_saved$data$videoRecr8 = (_saved$data$videoRecr9 = saved.data.videoRecreation) === null || _saved$data$videoRecr9 === void 0 ? void 0 : _saved$data$videoRecr9.productBindings) !== null && _saved$data$videoRecr8 !== void 0 ? _saved$data$videoRecr8 : []).toEqual([]);
  expect((_saved$data$videoRecr0 = saved.data.videoRecreation) === null || _saved$data$videoRecr0 === void 0 ? void 0 : _saved$data$videoRecr0.analysis).toEqual(savedAnalysis);
  expect((_saved$data$parameter4 = saved.data.parameters) === null || _saved$data$parameter4 === void 0 ? void 0 : _saved$data$parameter4.duration).toBe(7);
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(0);
  await editor.getByRole('button', {
    name: '生成',
    exact: true
  }).click();
  await expect.poll(() => ctx.generates.length).toBe(1);
  expect(ctx.generates[0].snapshot.parameters.duration).toBe(7);
  await editor.getByRole('button', {
    name: '关闭编辑器',
    exact: true
  }).click();
  await expect(editor).toBeHidden();
  const result = node.locator('.flow-node-preview img');
  await expect(result).toBeVisible();
  await result.evaluate(element => element.decode());
  const afterGeneration = await node.boundingBox();
  expect(afterGeneration === null || afterGeneration === void 0 ? void 0 : afterGeneration.width).toBeCloseTo(size.width, 0);
  expect(afterGeneration === null || afterGeneration === void 0 ? void 0 : afterGeneration.height).toBeCloseTo(size.height, 0);
  await page.screenshot({
    path: info.outputPath('recreation-generated-image.png'),
    animations: 'disabled',
    fullPage: true
  });
  await page.reload();
  await expect(node).toBeVisible({
    timeout: 15000
  });
  await expect(result).toBeVisible();
  await result.evaluate(element => element.decode());
  const afterRestore = await node.boundingBox();
  expect(afterRestore === null || afterRestore === void 0 ? void 0 : afterRestore.width).toBeCloseTo(size.width, 0);
  expect(afterRestore === null || afterRestore === void 0 ? void 0 : afterRestore.height).toBeCloseTo(size.height, 0);
  expect(ctx.canvas().nodes).toHaveLength(2);
  expect((_ctx$canvas$nodes$fin18 = ctx.canvas().nodes.find(entry => entry.id === nodeId)) === null || _ctx$canvas$nodes$fin18 === void 0 ? void 0 : _ctx$canvas$nodes$fin18.type).toBe('video');
  expect(ctx.posts).toHaveLength(1);
  expect(ctx.generates).toHaveLength(1);
  expect(ctx.errors).toEqual([]);
  const evidencePath = info.outputPath('recreation-generated-image-evidence.json');
  writeFileSync(evidencePath, JSON.stringify({
    initial: size,
    afterGeneration,
    afterRestore,
    consoleErrors: ctx.errors
  }, null, 2));
  await info.attach('原节点图片回显与恢复尺寸', {
    path: evidencePath,
    contentType: 'application/json'
  });
});
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJleHBlY3QiLCJ0ZXN0IiwicmVhZEZpbGVTeW5jIiwid3JpdGVGaWxlU3luYyIsImNhbnZhc0RvY3VtZW50U2NoZW1hIiwiUFJPTVBUX1NLSUxMUyIsInVzZSIsInNlcnZpY2VXb3JrZXJzIiwiYW5hbHlzaXNDcmVkZW50aWFsSWQiLCJ0ZW1wbGF0ZSIsInZlcnNpb24iLCJkdXJhdGlvblNlY29uZHMiLCJyb2xlcyIsImlkIiwibGFiZWwiLCJzaG90cyIsInN0YXJ0U2Vjb25kcyIsImVuZFNlY29uZHMiLCJhY3Rpb24iLCJjYW1lcmEiLCJkaWFsb2d1ZSIsInNwZWFrZXJJZCIsInRleHQiLCJ1bmtub3ducyIsImlkZW50aWZpZWRUZW1wbGF0ZSIsImRlc2NyaXB0aW9uIiwiYXBwZWFyYW5jZXMiLCJwcmV2aWV3IiwidGltZXN0YW1wU2Vjb25kcyIsImJvdW5kaW5nQm94IiwieCIsInkiLCJ3aWR0aCIsImhlaWdodCIsInByb2R1Y3RzIiwiaW1hZ2UiLCJVUkwiLCJpbXBvcnQiLCJtZXRhIiwidXJsIiwidmlkZW8iLCJwcm9qZWN0IiwibmFtZSIsImNyZWF0ZWRBdCIsInVwZGF0ZWRBdCIsImpzb24iLCJyb3V0ZSIsInZhbHVlIiwic3RhdHVzIiwiZnVsZmlsbCIsImNvbnRlbnRUeXBlIiwiYm9keSIsIkpTT04iLCJzdHJpbmdpZnkiLCJzZWxlY3RPcHRpb24iLCJzZWxlY3QiLCJvcHRpb24iLCJjbGljayIsInRvSGF2ZUF0dHJpYnV0ZSIsImxpc3RJZCIsImdldEF0dHJpYnV0ZSIsInRvQmVUcnV0aHkiLCJsaXN0Ym94IiwicGFnZSIsImxvY2F0b3IiLCJnZXRCeVJvbGUiLCJ0b0JlSGlkZGVuIiwiZXhwZWN0U2VsZWN0aW9uIiwidG9Db250YWluVGV4dCIsImZpeHR1cmUiLCJzb3VyY2VMYXRlc3RWZXJzaW9uIiwic2F2ZURlbGF5TXMiLCJpZGVudGlmaWVkIiwiZ2VuZXJhdGlvbk1lZGlhVHlwZSIsImNhbnZhcyIsInBhcnNlIiwicmV2aXNpb24iLCJub2RlcyIsInR5cGUiLCJwb3NpdGlvbiIsImRhdGEiLCJtZWRpYVR5cGUiLCJtb2RlIiwiYXNzZXRJZCIsImNvbnRlbnRVcmwiLCJtaW1lVHlwZSIsImVkZ2VzIiwiYXNzZXRzIiwibGF0ZXN0VmVyc2lvbiIsInNpemVCeXRlcyIsImxlbmd0aCIsInRhZ3MiLCJtZXRhZGF0YSIsIm1hcCIsInJlbW90ZVBvcnRyYWl0IiwicmVzb3VyY2VTZWFyY2hlcyIsInVzZXIiLCJkaXNwbGF5TmFtZSIsImVtYWlsIiwicm9sZSIsInBvc3RzIiwicG9zdFBhdGhzIiwic291cmNlQ29udGVudFJlcXVlc3RzIiwiZ2VuZXJhdGVzIiwidXBsb2FkcyIsImVycm9ycyIsImFuYWx5c2lzIiwiaG9sZCIsIm9uIiwiZXJyIiwicHVzaCIsIm1lc3NhZ2UiLCJtc2ciLCJhZGRJbml0U2NyaXB0IiwibG9jYWxTdG9yYWdlIiwic2V0SXRlbSIsImFjY2Vzc1Rva2VuIiwiZXhwaXJlc0F0IiwiRGF0ZSIsIm5vdyIsInRvSVNPU3RyaW5nIiwiYmFzZSIsImluZm8iLCJiYXNlVVJMIiwiaW5jbHVkZXMiLCJob3N0bmFtZSIsIkVycm9yIiwiY29udGV4dCIsInJlcXVlc3QiLCJvcmlnaW4iLCJtZXRob2QiLCJwYXRobmFtZSIsInN0YXJ0c1dpdGgiLCJjb250aW51ZSIsImFib3J0IiwicmVxIiwicGF0aCIsInJlc291cmNlVHlwZSIsInNldHRpbmdzIiwiZGVmYXVsdE1vZGVscyIsIm1vZGVsQWxpYXMiLCJjcmVkZW50aWFsSWQiLCJwcm9qZWN0cyIsIlByb21pc2UiLCJyZXNvbHZlIiwic2V0VGltZW91dCIsInBvc3REYXRhSlNPTiIsImRlZmF1bHRzIiwicnVucyIsIm1vZGVscyIsIm1lZGlhVHlwZXMiLCJhdmFpbGFibGUiLCJjYXBhYmlsaXRpZXMiLCJtZW50aW9uTWVkaWFUeXBlcyIsInNraWxscyIsInMiLCJidWlsdGluIiwiZW5hYmxlZCIsInRvQmUiLCJ1cGxvYWRJZCIsInVwbG9hZFVybCIsImNvbXBsZXRlVXJsIiwicG9zdERhdGFCdWZmZXIiLCJ0b0VxdWFsIiwidXBsb2FkZWQiLCJmaW5kIiwiZW50cnkiLCJhc3NldCIsInNlYXJjaFBhcmFtcyIsImdldCIsIl91cmwkc2VhcmNoUGFyYW1zJGdldCIsInF1ZXJ5IiwicHJvamVjdElkIiwibWF0Y2hpbmciLCJmaWx0ZXIiLCJ0b3RhbCIsInBhZ2VTaXplIiwiYXNzZXRNYXRjaCIsImV4ZWMiLCJhIiwiZW5kc1dpdGgiLCJ2ZXJzaW9ucyIsIlNldCIsInNjb3BlIiwiX2NhbnZhcyRub2RlcyRmaW5kIiwicGVuZGluZyIsIm4iLCJ2aWRlb1JlY3JlYXRpb24iLCJpZGVtcG90ZW5jeUtleSIsInB1cnBvc2UiLCJydW5JZCIsImFzc2V0VmVyc2lvbiIsInN1bW1hcnkiLCJwcm9tcHQiLCJkZWZhdWx0TW9kZWwiLCJ0YXJnZXQiLCJfdGFyZ2V0JGRhdGEkcGFyYW1ldGUiLCJnZW5lcmF0ZWRJbWFnZSIsInVuZGVmaW5lZCIsInJ1biIsInRhcmdldE5vZGVJZCIsInByb2dyZXNzIiwiYXR0ZW1wdCIsInByb3ZpZGVyIiwic25hcHNob3QiLCJjYW52YXNSZXZpc2lvbiIsInN1Ym1pdHRlZEF0IiwiaW5wdXRzIiwicGFyYW1ldGVycyIsInJlc3VsdCIsImlucHV0Q291bnQiLCJyIiwic3BsaXQiLCJhdCIsImVycm9yIiwiY3JlYXRlTm9kZSIsImZyb21Gcm96ZW5Tb3VyY2UiLCJnb3RvIiwic291cmNlIiwidG9CZVZpc2libGUiLCJ0aW1lb3V0IiwiaG92ZXIiLCJleGFjdCIsInRvSGF2ZUNvdW50Iiwibm9kZSIsImhhcyIsImRpYWxvZyIsImNsaWNrUmVjcmVhdGlvbk5vZGUiLCJjb250ZW50IiwiZmlyc3QiLCJjbGlja0VtcHR5UGFuZSIsInBvaW50IiwiZXZhbHVhdGUiLCJwYW5lIiwiYm91bmRzIiwiZ2V0Qm91bmRpbmdDbGllbnRSZWN0IiwieVJhdGlvIiwieFJhdGlvIiwibGVmdCIsInRvcCIsImRvY3VtZW50IiwiZWxlbWVudEZyb21Qb2ludCIsIm1vdXNlIiwib3BlblJlY3JlYXRpb24iLCJleHBlY3RSZWNyZWF0aW9uTGF5b3V0Iiwidmlld3BvcnQiLCJwb2xsIiwiZWxlbWVudCIsImdldEFuaW1hdGlvbnMiLCJhbmltYXRpb24iLCJwbGF5U3RhdGUiLCJsYXlvdXQiLCJtZWFzdXJlIiwic3R5bGUiLCJnZXRDb21wdXRlZFN0eWxlIiwiY2xhc3NOYW1lIiwicmlnaHQiLCJib3R0b20iLCJvdmVyZmxvd1kiLCJjbGllbnRXaWR0aCIsInNjcm9sbFdpZHRoIiwiY2xpZW50SGVpZ2h0Iiwic2Nyb2xsSGVpZ2h0Iiwic2Nyb2xsVG9wIiwiZGlzcGxheSIsImNvbXB1dGVkSGVpZ2h0IiwibWluSGVpZ2h0IiwiZ3JpZFJvd3MiLCJncmlkVGVtcGxhdGVSb3dzIiwiYWxpZ25JdGVtcyIsImp1c3RpZnlDb250ZW50IiwicXVlcnlTZWxlY3RvciIsInJlc291cmNlcyIsImdlbmVyYXRpb24iLCJwYW5lbCIsInNvdXJjZUluZm8iLCJ3cmFwcGVycyIsIndyYXBwZXIiLCJwYXJlbnRFbGVtZW50Iiwib3ZlcmxheSIsImNsb3Nlc3QiLCJiZWZvcmUiLCJvdmVybGF5QmVmb3JlIiwiZmllbGRzIiwiQXJyYXkiLCJmcm9tIiwiY2hpbGRyZW4iLCJmaWVsZCIsInRleHRDb250ZW50IiwidGV4dE92ZXJmbG93IiwiZ3JpZENvbHVtbnMiLCJncmlkVGVtcGxhdGVDb2x1bW5zIiwiY29sdW1ucyIsImxheW91dFBhdGgiLCJvdXRwdXRQYXRoIiwiYXR0YWNoIiwidG9CZUluVmlld3BvcnQiLCJyYXRpbyIsInRvQmVDbG9zZVRvIiwidG9IYXZlTGVuZ3RoIiwidG9CZUxlc3NUaGFuT3JFcXVhbCIsImluZGV4IiwiY29sdW1uIiwiZW50cmllcyIsInRvQmVHcmVhdGVyVGhhbiIsInRvQmVMZXNzVGhhbiIsIm5vdCIsInRvQmVOdWxsIiwidG9NYXRjaCIsInRvQmVHcmVhdGVyVGhhbk9yRXF1YWwiLCJjb250cm9scyIsIm1vZGVsIiwibW9kZWxCb3VuZHMiLCJwYXJhbWV0ZXJCb3VuZHMiLCJtb2RlbENlbnRlclkiLCJwYXJhbWV0ZXJDZW50ZXJZIiwibW9kZWxSaWdodCIsInBhcmFtZXRlckxlZnQiLCJleHBlY3RTb3VyY2VQcmV2aWV3cyIsIm9iamVjdHMiLCJzY2VuZSIsImRlY29kZSIsInNjZW5lTGF5b3V0IiwiX2VsZW1lbnQkcXVlcnlTZWxlY3RvIiwiX2VsZW1lbnQkcXVlcnlTZWxlY3RvMiIsIl9lbGVtZW50JHF1ZXJ5U2VsZWN0bzMiLCJmcmFtZSIsImhpbnQiLCJuYW1lUmlnaHQiLCJmcmFtZUxlZnQiLCJmcmFtZVJpZ2h0IiwiaGludExlZnQiLCJtZWFzdXJlbWVudHMiLCJvYmplY3QiLCJvYmplY3RMYXlvdXQiLCJhcnRpY2xlIiwiX2FydGljbGUkcXVlcnlTZWxlY3RvIiwiX2FydGljbGUkcXVlcnlTZWxlY3RvMiIsIl9hcnRpY2xlJHF1ZXJ5U2VsZWN0bzMiLCJyZXNvdXJjZSIsInJlc291cmNlTGVmdCIsImJvdW5kZWQiLCJmaWd1cmUiLCJTdHJpbmciLCJwaXhlbHMiLCJjcmVhdGVFbGVtZW50IiwiZ2V0Q29udGV4dCIsImRyYXdJbWFnZSIsImNvbG9ycyIsImdldEltYWdlRGF0YSIsIl8iLCJuYXR1cmFsV2lkdGgiLCJuYXR1cmFsSGVpZ2h0IiwibWluaW11bSIsIk1hdGgiLCJtaW4iLCJtYXhpbXVtIiwibWF4Iiwic291cmNlUmF0aW9zIiwibWVhc3VyZW1lbnQiLCJib3giLCJfY3R4JGNhbnZhcyRub2RlcyRmaW4iLCJfc2F2ZWQkZGF0YSR2aWRlb1JlY3IiLCJzZXRWaWV3cG9ydFNpemUiLCJjdHgiLCJzb3VyY2VCZWZvcmUiLCJzdHJ1Y3R1cmVkQ2xvbmUiLCJtb3ZlIiwidG9IYXZlQ2xhc3MiLCJtYXRjaGVzIiwidG9IYXZlVGV4dCIsInNjcmVlbnNob3QiLCJmdWxsUGFnZSIsImRyYWZ0IiwiaXRlbSIsInZpZGVvUmVjcmVhdGlvbkRyYWZ0IiwidG9CZVVuZGVmaW5lZCIsInNpemUiLCJkcmFmdExheW91dCIsInJlZmVyZW5jZSIsInRvQmVEaXNhYmxlZCIsImdldEJ5TGFiZWwiLCJ0b0JlQXR0YWNoZWQiLCJhbmltYXRpb25zIiwiX2N0eCRjYW52YXMkbm9kZXMkZmluMiIsInNhdmVkIiwidG9NYXRjaE9iamVjdCIsImJvdW5kTGF5b3V0IiwicGxheWVyIiwicmVhZHlTdGF0ZSIsImJhZGdlIiwiYmFkZ2VCb3VuZHMiLCJjdXJyZW50IiwiTnVtYmVyIiwib3BhY2l0eSIsImRlc2VsZWN0ZWRTaXplIiwiZ2V0QnlUZXh0IiwiZXhwYW5kZWRTaXplIiwiZnVsbEVkaXRvciIsImZ1bGxQYW5lbCIsInNjcm9sbEludG9WaWV3SWZOZWVkZWQiLCJjbG9zZWRFZGl0b3JTaXplIiwidG9IYXZlVmFsdWUiLCJnZW5lcmF0ZSIsInRvQmVFbmFibGVkIiwiX2N0eCRjYW52YXMkbm9kZXMkZmluMyIsInRvQ29udGFpbiIsIl9zYXZlZCRkYXRhJHBhcmFtZXRlciIsIl9zYXZlZCRkYXRhJHJlc291cmNlUiIsIl9zYXZlZCRkYXRhJHZpZGVvUmVjcjIiLCJfc25hcHNob3Qkbm9kZXMiLCJfc25hcHNob3Qkbm9kZXMyIiwiX2N0eCRjYW52YXMkbm9kZXMkZmluNCIsImR1cmF0aW9uIiwicmVzb3VyY2VSZWZzIiwiYWZ0ZXIiLCJyZWxvYWQiLCJyZXN0b3JlZCIsInJlY3JlYXRpb24iLCJyaWdodEVkaXRvciIsImV4cGFuZGVkIiwiZWRpdG9yIiwiQm9vbGVhbiIsImZpbGwiLCJfY3R4JGNhbnZhcyRub2RlcyRmaW41IiwiX2N0eCRjYW52YXMkbm9kZXMkZmluOCIsInByb2R1Y3RJbnB1dCIsInByZXNzU2VxdWVudGlhbGx5IiwiZGVsYXkiLCJ0b0JlRm9jdXNlZCIsIl9jdHgkY2FudmFzJG5vZGVzJGZpbjYiLCJwcm9kdWN0RGVzY3JpcHRpb24iLCJfY3R4JGNhbnZhcyRub2RlcyRmaW43IiwiX2N0eCRjYW52YXMkbm9kZXMkZmluOSIsIl9zYXZlZCRkYXRhJHZpZGVvUmVjcjMiLCJfc2F2ZWQkZGF0YSRwYXJhbWV0ZXIyIiwiX3NhdmVkJGRhdGEkcmVzb3VyY2VSMiIsInBsYXkiLCJjdXJyZW50VGltZSIsInBhdXNlIiwiX2N0eCRjYW52YXMkbm9kZXMkZmluMCIsImNvbnNvbGVFcnJvcnMiLCJfc2F2ZWQkZGF0YSRyZXNvdXJjZVIzIiwiX3NhdmVkJGRhdGEkdmlkZW9SZWNyNCIsInNldElucHV0RmlsZXMiLCJidWZmZXIiLCJfY3R4JGNhbnZhcyRub2RlcyRmaW4xIiwiYmluZGluZ3MiLCJyb2xlSWQiLCJwcm9kdWN0IiwiX3NhdmVkJGRhdGEkdmlkZW9SZWNyNSIsIl9zYXZlZCRkYXRhJHZpZGVvUmVjcjYiLCJfc2F2ZWQkZGF0YSRwYXJhbWV0ZXIzIiwiX3NuYXBzaG90JG5vZGVzMyIsImFuYWx5c2lzTW9kZWwiLCJzb3VyY2VSZWFkc0JlZm9yZUFuYWx5c2lzIiwic291cmNlUHJldmlld3MiLCJzb3VyY2VSZWFkc0FmdGVyQW5hbHlzaXMiLCJfY3R4JGNhbnZhcyRub2RlcyRmaW4xMCIsIl9jdHgkY2FudmFzJG5vZGVzJGZpbjExIiwicHJvZHVjdEJpbmRpbmdzIiwicHJvZHVjdElkIiwiX2N0eCRjYW52YXMkbm9kZXMkZmluMTIiLCJwcmVzZXJ2ZWRSb2xlSWRzIiwiX2N0eCRjYW52YXMkbm9kZXMkZmluMTMiLCJnZW5lcmF0aW9uTW9kZWwiLCJfY3R4JGNhbnZhcyRub2RlcyRmaW4xNCIsImRpYWxvZ0xheW91dCIsInNvdXJjZU5hbWUiLCJmdWxsRWRpdG9yUHJldmlld3MiLCJhbmFseXNpc0NvbHVtbiIsInJlc291cmNlc0NvbHVtbiIsImdlbmVyYXRpb25Db2x1bW4iLCJhbmFseXNpc1Njcm9sbFRvcCIsImdlbmVyYXRpb25TY3JvbGxUb3AiLCJyZXBsYWNlbWVudFNlbGVjdG9ycyIsIm50aCIsInJlc291cmNlU2Nyb2xsIiwib3ZlcmZsb3dzIiwiZG9jdW1lbnRFbGVtZW50IiwiY2xvc2VkU2l6ZSIsImV2aWRlbmNlUGF0aCIsInByZXZpZXdzIiwibm9kZUJvdW5kcyIsImluaXRpYWwiLCJhZnRlckJpbmRpbmdzIiwiYWZ0ZXJFZGl0b3IiLCJfY3R4JGNhbnZhcyRub2RlcyRmaW4xNSIsIl9jdHgkY2FudmFzJG5vZGVzJGZpbjE2IiwiX3NhdmVkJGRhdGEkdmlkZW9SZWNyNyIsIl9zYXZlZCRkYXRhJHZpZGVvUmVjcjgiLCJfc2F2ZWQkZGF0YSR2aWRlb1JlY3I5IiwiX3NhdmVkJGRhdGEkdmlkZW9SZWNyMCIsIl9zYXZlZCRkYXRhJHBhcmFtZXRlcjQiLCJfY3R4JGNhbnZhcyRub2RlcyRmaW4xOCIsImNyZWF0ZWROb2RlIiwibm9kZUlkIiwic2F2ZWRBbmFseXNpcyIsImhlYWRpbmciLCJleHBhbmRlZEltYWdlIiwia2V5Ym9hcmQiLCJwcmVzcyIsImR1cmF0aW9uRGlhbG9nIiwic2VhcmNoIiwiX2N0eCRjYW52YXMkbm9kZXMkZmluMTciLCJhZnRlckdlbmVyYXRpb24iLCJhZnRlclJlc3RvcmUiXSwic291cmNlcyI6WyJ2aWRlby1yZWNyZWF0aW9uLnNwZWMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZXhwZWN0LCB0ZXN0LCB0eXBlIExvY2F0b3IsIHR5cGUgUGFnZSwgdHlwZSBSb3V0ZSB9IGZyb20gJ0BwbGF5d3JpZ2h0L3Rlc3QnO1xyXG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcclxuaW1wb3J0IHtcclxuICBjYW52YXNEb2N1bWVudFNjaGVtYSxcclxuICBQUk9NUFRfU0tJTExTLFxyXG4gIHR5cGUgUnVuUmVjb3JkLFxyXG4gIHR5cGUgVmlkZW9SZWNyZWF0aW9uVGVtcGxhdGUsXHJcbn0gZnJvbSAnQG11bHRpbW9kYWwtY2FudmFzL2RvbWFpbic7XHJcblxyXG50ZXN0LnVzZSh7IHNlcnZpY2VXb3JrZXJzOiAnYmxvY2snIH0pO1xyXG4vKiog5ZCI5oiQ6L+e5o6l5qCH6K+G55So5LqO5qOA6aqM5YiG57uE5qih5Z6L5Ya757uT77yM5LiN5YyF5ZCr55yf5a6e5Yet5o2u44CCICovXHJcbmNvbnN0IGFuYWx5c2lzQ3JlZGVudGlhbElkID0gJ2ZlM2Q4NTIwLTlmNjQtNGRhYS04MzY0LTdiMDk4NzEyMzY1MSc7XHJcbi8qKiDlkIjmiJDlhajniYfliIbmnpDku4XnlKjkuo7pqozor4HmtYHnqIvvvIzkuI3ku6PooajnnJ/lrp7op4bpopHnkIbop6PmlYjmnpzjgIIgKi9cclxuY29uc3QgdGVtcGxhdGU6IFZpZGVvUmVjcmVhdGlvblRlbXBsYXRlID0ge1xyXG4gIHZlcnNpb246IDEsXHJcbiAgZHVyYXRpb25TZWNvbmRzOiAxMCxcclxuICByb2xlczogW3sgaWQ6ICdjaGFyYWN0ZXJfYScsIGxhYmVsOiAn5Li76KeSJyB9XSxcclxuICBzaG90czogW1xyXG4gICAge1xyXG4gICAgICBzdGFydFNlY29uZHM6IDAsXHJcbiAgICAgIGVuZFNlY29uZHM6IDQsXHJcbiAgICAgIGFjdGlvbjogJ2NoYXJhY3Rlcl9h5oqs5omL6L2s6Lqr77yM5ZWG5ZOB5L+d5oyB5Zyo5Y+z5omLJyxcclxuICAgICAgY2FtZXJhOiAn5Lit5pmv5ZCR5YmN6Lef6ZqPJyxcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIHN0YXJ0U2Vjb25kczogNCxcclxuICAgICAgZW5kU2Vjb25kczogMTAsXHJcbiAgICAgIGFjdGlvbjogJ2NoYXJhY3Rlcl9h5bCG5ZWG5ZOB5pyd5ZCR6ZWc5aS077yM5YGc5L2P5bGV56S6JyxcclxuICAgICAgY2FtZXJhOiAn5o6o6L+b6Iez5ZWG5ZOB54m55YaZJyxcclxuICAgIH0sXHJcbiAgXSxcclxuICBkaWFsb2d1ZTogW3sgc3RhcnRTZWNvbmRzOiAxLjIsIGVuZFNlY29uZHM6IDIuOCwgc3BlYWtlcklkOiAnY2hhcmFjdGVyX2EnLCB0ZXh0OiAn6K+355yL6L+Z5Liq44CCJyB9XSxcclxuICB1bmtub3duczogWyfljp/ljIXoo4XmloflrZfml6Dms5Xnoa7orqQnXSxcclxufTtcclxuLyoqIOS4pOS4quS6uueJqeS4juS4pOS7tueJqeWTgeeahOWQiOaIkOivhuWIq+e7k+aenO+8jOS7hemqjOivgemAieaLqeOAgeWumuS9jeWSjOS/neWtmO+8jOS4jeS7o+ihqOa8lOekuuinhumikeecn+WunuWGheWuueOAgiAqL1xyXG5jb25zdCBpZGVudGlmaWVkVGVtcGxhdGU6IFZpZGVvUmVjcmVhdGlvblRlbXBsYXRlID0ge1xyXG4gIHZlcnNpb246IDEsXHJcbiAgZHVyYXRpb25TZWNvbmRzOiAxMCxcclxuICByb2xlczogW1xyXG4gICAge1xyXG4gICAgICBpZDogJ2NoYXJhY3Rlcl9hJyxcclxuICAgICAgbGFiZWw6ICfkuLvop5InLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ+eUu+mdouW3puS+p+S6uueJqe+8jOWPs+aJi+aLv+edgOmmmeawtOeTticsXHJcbiAgICAgIGFwcGVhcmFuY2VzOiBbeyBzdGFydFNlY29uZHM6IDAsIGVuZFNlY29uZHM6IDEwIH1dLFxyXG4gICAgICBwcmV2aWV3OiB7XHJcbiAgICAgICAgdGltZXN0YW1wU2Vjb25kczogMC4zLFxyXG4gICAgICAgIGJvdW5kaW5nQm94OiB7IHg6IDAuMDUsIHk6IDAuMDUsIHdpZHRoOiAwLjQsIGhlaWdodDogMC44NSB9LFxyXG4gICAgICB9LFxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgaWQ6ICdjaGFyYWN0ZXJfYicsXHJcbiAgICAgIGxhYmVsOiAn5ZCM5Ly0JyxcclxuICAgICAgZGVzY3JpcHRpb246ICfnlLvpnaLlj7PkvqfkurrnianvvIzmj5DnnYDmiYvmj5DooosnLFxyXG4gICAgICBhcHBlYXJhbmNlczogW3sgc3RhcnRTZWNvbmRzOiAxLCBlbmRTZWNvbmRzOiAxMCB9XSxcclxuICAgICAgcHJldmlldzoge1xyXG4gICAgICAgIHRpbWVzdGFtcFNlY29uZHM6IDEuMixcclxuICAgICAgICBib3VuZGluZ0JveDogeyB4OiAwLjU1LCB5OiAwLjA1LCB3aWR0aDogMC4zNSwgaGVpZ2h0OiAwLjg1IH0sXHJcbiAgICAgIH0sXHJcbiAgICB9LFxyXG4gIF0sXHJcbiAgcHJvZHVjdHM6IFtcclxuICAgIHtcclxuICAgICAgaWQ6ICdwcm9kdWN0X2EnLFxyXG4gICAgICBsYWJlbDogJ+mmmeawtOeTticsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAn5Li76KeS5Y+z5omL55qE5bCP55O277yM5rWF6Imy55+p5b2i55O255uWJyxcclxuICAgICAgYXBwZWFyYW5jZXM6IFt7IHN0YXJ0U2Vjb25kczogMCwgZW5kU2Vjb25kczogMTAgfV0sXHJcbiAgICAgIHByZXZpZXc6IHtcclxuICAgICAgICB0aW1lc3RhbXBTZWNvbmRzOiAwLjcsXHJcbiAgICAgICAgYm91bmRpbmdCb3g6IHsgeDogMC4yNSwgeTogMC4zLCB3aWR0aDogMC4yLCBoZWlnaHQ6IDAuNCB9LFxyXG4gICAgICB9LFxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgaWQ6ICdwcm9kdWN0X2InLFxyXG4gICAgICBsYWJlbDogJ+aJi+aPkOiiiycsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAn5ZCM5Ly05omL5Lit55qE5pa55b2i5omL5o+Q6KKL77yM5paH5a2X5peg5rOV56Gu6K6kJyxcclxuICAgICAgYXBwZWFyYW5jZXM6IFt7IHN0YXJ0U2Vjb25kczogMSwgZW5kU2Vjb25kczogMTAgfV0sXHJcbiAgICAgIHByZXZpZXc6IHtcclxuICAgICAgICB0aW1lc3RhbXBTZWNvbmRzOiAyLFxyXG4gICAgICAgIGJvdW5kaW5nQm94OiB7IHg6IDAuNTUsIHk6IDAuNCwgd2lkdGg6IDAuMywgaGVpZ2h0OiAwLjUgfSxcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgXSxcclxuICBzaG90czogW1xyXG4gICAge1xyXG4gICAgICBzdGFydFNlY29uZHM6IDAsXHJcbiAgICAgIGVuZFNlY29uZHM6IDQsXHJcbiAgICAgIGFjdGlvbjogJ2NoYXJhY3Rlcl9h5ou/552AcHJvZHVjdF9h5ZCR5YmN6L2s6Lqr77yMY2hhcmFjdGVyX2LlnKjlj7Pkvqfmj5DnnYBwcm9kdWN0X2InLFxyXG4gICAgICBjYW1lcmE6ICfkuK3mma/lkJHliY3ot5/pmo8nLFxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgc3RhcnRTZWNvbmRzOiA0LFxyXG4gICAgICBlbmRTZWNvbmRzOiAxMCxcclxuICAgICAgYWN0aW9uOiAnY2hhcmFjdGVyX2HlsIZwcm9kdWN0X2HmnJ3lkJHplZzlpLTlsZXnpLrvvIxjaGFyYWN0ZXJfYuWwhnByb2R1Y3RfYuS/neaMgeWcqOi6q+S+pycsXHJcbiAgICAgIGNhbWVyYTogJ+aOqOi/m+iHs3Byb2R1Y3RfYeeJueWGmScsXHJcbiAgICB9LFxyXG4gIF0sXHJcbiAgdW5rbm93bnM6IFsn5Y6f5YyF6KOF5LiO5omL5o+Q6KKL5paH5a2X5peg5rOV56Gu6K6kJ10sXHJcbn07XHJcbi8qKiDku5PlupPlhoXlqpLkvZPkuI3kuqfnlJ/lpJbpg6jkuIvovb3jgIIgKi9cclxuY29uc3QgaW1hZ2UgPSByZWFkRmlsZVN5bmMobmV3IFVSTCgnLi4vcHVibGljL2RlbW8vZmllbGQtc3R1ZHktcG9zdGVyLmpwZycsIGltcG9ydC5tZXRhLnVybCkpO1xyXG5jb25zdCB2aWRlbyA9IHJlYWRGaWxlU3luYyhuZXcgVVJMKCcuLi9wdWJsaWMvZGVtby9maWVsZC1zdHVkeS5tcDQnLCBpbXBvcnQubWV0YS51cmwpKTtcclxuY29uc3QgcHJvamVjdCA9IHtcclxuICBpZDogJ3JlY3JlYXRpb24tYnJvd3NlcicsXHJcbiAgbmFtZTogJ+efreinhumikeWkjeWIu+mqjOaUticsXHJcbiAgY3JlYXRlZEF0OiAnMjAyNi0xMC0wNFQwMDowMDowMFonLFxyXG4gIHVwZGF0ZWRBdDogJzIwMjYtMTAtMDRUMDA6MDA6MDBaJyxcclxufTtcclxuLyoqIOi/lOWbnuWQiOaIkEFQSeWvueixoeOAgiAqL1xyXG5hc3luYyBmdW5jdGlvbiBqc29uKHJvdXRlOiBSb3V0ZSwgdmFsdWU6IHVua25vd24sIHN0YXR1cyA9IDIwMCkge1xyXG4gIGF3YWl0IHJvdXRlLmZ1bGZpbGwoeyBzdGF0dXMsIGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbicsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHZhbHVlKSB9KTtcclxufVxyXG5cclxuLyoqIOmAmui/h+inpuWPkeWZqOWFs+iBlOeahCBBbnQgRGVzaWduIOS4i+aLiemAieaLqe+8jOmBv+WFjeivr+eCuemAgOWHuuWKqOeUu+S4reeahOWFtuS7luWQjOWQjemAiemhueOAgiAqL1xyXG5hc3luYyBmdW5jdGlvbiBzZWxlY3RPcHRpb24oc2VsZWN0OiBMb2NhdG9yLCBvcHRpb246IHN0cmluZyB8IFJlZ0V4cCkge1xyXG4gIGF3YWl0IHNlbGVjdC5jbGljaygpO1xyXG4gIGF3YWl0IGV4cGVjdChzZWxlY3QpLnRvSGF2ZUF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcsICd0cnVlJyk7XHJcbiAgY29uc3QgbGlzdElkID0gYXdhaXQgc2VsZWN0LmdldEF0dHJpYnV0ZSgnYXJpYS1jb250cm9scycpO1xyXG4gIGV4cGVjdChsaXN0SWQpLnRvQmVUcnV0aHkoKTtcclxuICBjb25zdCBsaXN0Ym94ID0gc2VsZWN0LnBhZ2UoKS5sb2NhdG9yKCdbaWQ9XCInICsgbGlzdElkICsgJ1wiXScpO1xyXG4gIGF3YWl0IGxpc3Rib3guZ2V0QnlSb2xlKCdvcHRpb24nLCB7IG5hbWU6IG9wdGlvbiB9KS5jbGljaygpO1xyXG4gIGF3YWl0IGV4cGVjdChzZWxlY3QpLnRvSGF2ZUF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcsICdmYWxzZScpO1xyXG4gIGF3YWl0IGV4cGVjdChsaXN0Ym94KS50b0JlSGlkZGVuKCk7XHJcbn1cclxuXHJcbi8qKiBBbnQgRGVzaWduIOaQnOe0oui+k+WFpeWAvOS4jue7keWumuaXoOWFs++8m+aguOWvueWPr+ingemAieS4reagh+etvuOAgiAqL1xyXG5hc3luYyBmdW5jdGlvbiBleHBlY3RTZWxlY3Rpb24oc2VsZWN0OiBMb2NhdG9yLCBsYWJlbDogc3RyaW5nKSB7XHJcbiAgYXdhaXQgZXhwZWN0KHNlbGVjdC5sb2NhdG9yKCd4cGF0aD1hbmNlc3Rvcjo6Kltjb250YWlucyhAY2xhc3MsXCJhbnQtc2VsZWN0XCIpXVsxXScpKS50b0NvbnRhaW5UZXh0KFxyXG4gICAgbGFiZWwsXHJcbiAgKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOaLpuaIquaJgOaciSBBUEkg5LiO5LuY6LS56K+35rGC77yM5L+d5a2Y5Y+q5YaZ5rWL6K+V5YaF5a2Y77yb546w5Luj6K+G5Yir5aS55YW35LiN5pS55Y+Y5pen5qC85byP5Zy65pmv44CCXHJcbiAqIEBwYXJhbSBpZGVudGlmaWVkIOS9v+eUqOW4puS6uueJqeOAgeeJqeWTgeWumuS9jeeahOWQiOaIkOe7k+aenOWPiuaWh+acrCBxd2VuIOebruW9lemhueOAglxyXG4gKiBAcGFyYW0gZ2VuZXJhdGlvbk1lZGlhVHlwZSDkuLogaW1hZ2Ug5pe26L+U5Zue5oiQ5Yqf5b2S5qGj5Zu+54mH77yM6aqM6K+B5Y6f6KeG6aKR6IqC54K555qE57uT5p6c5bGV56S644CCXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBmaXh0dXJlKFxyXG4gIHBhZ2U6IFBhZ2UsXHJcbiAgc291cmNlTGF0ZXN0VmVyc2lvbiA9IDIsXHJcbiAgc2F2ZURlbGF5TXMgPSAwLFxyXG4gIGlkZW50aWZpZWQgPSBmYWxzZSxcclxuICBnZW5lcmF0aW9uTWVkaWFUeXBlPzogJ2ltYWdlJyxcclxuKSB7XHJcbiAgbGV0IGNhbnZhcyA9IGNhbnZhc0RvY3VtZW50U2NoZW1hLnBhcnNlKHtcclxuICAgIHJldmlzaW9uOiAxLFxyXG4gICAgbm9kZXM6IFtcclxuICAgICAge1xyXG4gICAgICAgIGlkOiAnc291cmNlLXZpZGVvJyxcclxuICAgICAgICB0eXBlOiAndmlkZW8nLFxyXG4gICAgICAgIHBvc2l0aW9uOiB7IHg6IDEwMCwgeTogMTAwIH0sXHJcbiAgICAgICAgd2lkdGg6IDQwMCxcclxuICAgICAgICBoZWlnaHQ6IDI2NixcclxuICAgICAgICBkYXRhOiB7XHJcbiAgICAgICAgICBsYWJlbDogJ+WPguiAg+efreinhumikScsXHJcbiAgICAgICAgICBtZWRpYVR5cGU6ICd2aWRlbycsXHJcbiAgICAgICAgICBtb2RlOiAnc291cmNlJyxcclxuICAgICAgICAgIGFzc2V0SWQ6ICdjbGlwJyxcclxuICAgICAgICAgIGNvbnRlbnRVcmw6ICcvdjEvYXNzZXRzL2NsaXAvdmVyc2lvbnMvMi9jb250ZW50JyxcclxuICAgICAgICAgIG1pbWVUeXBlOiAndmlkZW8vbXA0JyxcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgXSxcclxuICAgIGVkZ2VzOiBbXSxcclxuICB9KTtcclxuICBjb25zdCBhc3NldHMgPSBbXHJcbiAgICB7XHJcbiAgICAgIGlkOiAnY2xpcCcsXHJcbiAgICAgIG5hbWU6ICflj4LogIPnn63op4bpopEt5Lq654mp5LiO5ZWG5ZOB6YCQ6aG55pu/5o2iLeS/neeVmeWujOaVtOmVnOWktOWKqOS9nOWSjOmAkOWPpeWPsOivjS3mlofku7blkI3ovoPplb/ku43nhLblhrvnu5Pljp/niYjmnKwt5LiN6IO95pKR5aSn5p2l5rqQ5qCPLm1wNCcsXHJcbiAgICAgIG1lZGlhVHlwZTogJ3ZpZGVvJyxcclxuICAgICAgbWltZVR5cGU6ICd2aWRlby9tcDQnLFxyXG4gICAgICBsYXRlc3RWZXJzaW9uOiBzb3VyY2VMYXRlc3RWZXJzaW9uLFxyXG4gICAgICBzaXplQnl0ZXM6IHZpZGVvLmxlbmd0aCxcclxuICAgICAgc3RhdHVzOiAncmVhZHknLFxyXG4gICAgICBjb250ZW50VXJsOiAnL3YxL2Fzc2V0cy9jbGlwL3ZlcnNpb25zLycgKyBzb3VyY2VMYXRlc3RWZXJzaW9uICsgJy9jb250ZW50JyxcclxuICAgICAgdGFnczogW10sXHJcbiAgICAgIG1ldGFkYXRhOiB7IGR1cmF0aW9uU2Vjb25kczogc291cmNlTGF0ZXN0VmVyc2lvbiA9PT0gMiA/IDEwIDogMjAgfSxcclxuICAgIH0sXHJcbiAgICAuLi5bJ3BlcnNvbi1hJywgJ3BlcnNvbi1iJywgJ3Byb2R1Y3QnXS5tYXAoKGlkKSA9PiAoe1xyXG4gICAgICBpZCxcclxuICAgICAgbmFtZTogaWQgPT09ICdwcm9kdWN0JyA/ICfmlrDllYblk4EnIDogaWQgPT09ICdwZXJzb24tYScgPyAn5oiR55qE5Lq654mpJyA6ICflj6bkuIDkurrniaknLFxyXG4gICAgICBtZWRpYVR5cGU6ICdpbWFnZScsXHJcbiAgICAgIG1pbWVUeXBlOiAnaW1hZ2UvanBlZycsXHJcbiAgICAgIGxhdGVzdFZlcnNpb246IDMsXHJcbiAgICAgIHNpemVCeXRlczogaW1hZ2UubGVuZ3RoLFxyXG4gICAgICBzdGF0dXM6ICdyZWFkeScsXHJcbiAgICAgIGNvbnRlbnRVcmw6ICcvdjEvYXNzZXRzLycgKyBpZCArICcvdmVyc2lvbnMvMy9jb250ZW50JyxcclxuICAgICAgdGFnczogW10sXHJcbiAgICAgIG1ldGFkYXRhOiB7fSxcclxuICAgIH0pKSxcclxuICBdO1xyXG4gIC8qKiDlj6rlnKjpobnnm67mkJzntKLlk43lupTlh7rnjrDvvIzliJ3mrKHnlLvluIPotYTmupDnvJPlrZjkuI3lkKvor6Xlm77niYfjgIIgKi9cclxuICBjb25zdCByZW1vdGVQb3J0cmFpdCA9IHtcclxuICAgIC4uLmFzc2V0c1sxXSEsXHJcbiAgICBpZDogJ3JlbW90ZS1wZXJzb24nLFxyXG4gICAgbmFtZTogJ+mhueebruaWsOS6uueJqScsXHJcbiAgICBsYXRlc3RWZXJzaW9uOiA4LFxyXG4gICAgY29udGVudFVybDogJy92MS9hc3NldHMvcmVtb3RlLXBlcnNvbi92ZXJzaW9ucy84L2NvbnRlbnQnLFxyXG4gIH07XHJcbiAgY29uc3QgcmVzb3VyY2VTZWFyY2hlczogeyBxdWVyeTogc3RyaW5nOyBtZWRpYVR5cGU6IHN0cmluZzsgcGFnZTogc3RyaW5nOyBwcm9qZWN0SWQ6IHN0cmluZyB9W10gPVxyXG4gICAgW107XHJcbiAgY29uc3QgdXNlciA9IHtcclxuICAgIGlkOiAncmVjcmVhdGlvbi11c2VyJyxcclxuICAgIGRpc3BsYXlOYW1lOiAn5aSN5Yi76aqM5pS2JyxcclxuICAgIGVtYWlsOiAncmVjcmVhdGlvbkBleGFtcGxlLnRlc3QnLFxyXG4gICAgcm9sZTogJ3VzZXInLFxyXG4gICAgY3JlYXRlZEF0OiAnMjAyNi0xMC0wNFQwMDowMDowMFonLFxyXG4gIH07XHJcbiAgY29uc3QgcG9zdHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+W10gPSBbXTtcclxuICAvKiog5aqS5L2TIGFjY2Vzcy11cmwg55qEIFBPU1Qg5Y+q6K+75Y+W5pKt5pS+56Wo5o2u77yb6Zmk5q2k5LmL5aSW77yM5Lu75L2VIFBPU1Qg6YO95b+F6aG755Sx5piO56Gu5pON5L2c6Kem5Y+R44CCICovXHJcbiAgY29uc3QgcG9zdFBhdGhzOiBzdHJpbmdbXSA9IFtdO1xyXG4gIC8qKiDmnaXmupDlhoXlrrnor7vlj5borrDlvZXnlKjkuo7ljLrliIboioLngrnmkq3mlL7lkozlkIzmibnlr7nosaHlhbHkuqvnmoTmiKrluKfor7fmsYLjgIIgKi9cclxuICBjb25zdCBzb3VyY2VDb250ZW50UmVxdWVzdHM6IHsgcGF0aDogc3RyaW5nOyByZXNvdXJjZVR5cGU6IHN0cmluZyB9W10gPSBbXTtcclxuICBjb25zdCBnZW5lcmF0ZXM6IFJ1blJlY29yZFtdID0gW107XHJcbiAgY29uc3QgdXBsb2Fkczogc3RyaW5nW10gPSBbXTtcclxuICBjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XHJcbiAgbGV0IGFuYWx5c2lzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBob2xkID0gZmFsc2U7XHJcbiAgcGFnZS5vbigncGFnZWVycm9yJywgKGVycikgPT4gZXJyb3JzLnB1c2goZXJyLm1lc3NhZ2UpKTtcclxuICBwYWdlLm9uKCdjb25zb2xlJywgKG1zZykgPT4ge1xyXG4gICAgaWYgKG1zZy50eXBlKCkgPT09ICdlcnJvcicpIGVycm9ycy5wdXNoKG1zZy50ZXh0KCkpO1xyXG4gIH0pO1xyXG4gIGF3YWl0IHBhZ2UuYWRkSW5pdFNjcmlwdCgodXNlcikgPT4ge1xyXG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oXHJcbiAgICAgICdtdWx0aW1vZGFsLWNhbnZhczphdXRoLXNlc3Npb24nLFxyXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgYWNjZXNzVG9rZW46ICdzeW50aGV0aWMtcmVjcmVhdGlvbi1icm93c2VyJyxcclxuICAgICAgICBleHBpcmVzQXQ6IG5ldyBEYXRlKERhdGUubm93KCkgKyAzNjAwMDAwKS50b0lTT1N0cmluZygpLFxyXG4gICAgICAgIHVzZXIsXHJcbiAgICAgIH0pLFxyXG4gICAgKTtcclxuICB9LCB1c2VyKTtcclxuICBjb25zdCBiYXNlID0gdGVzdC5pbmZvKCkucHJvamVjdC51c2UuYmFzZVVSTDtcclxuICBpZiAoIWJhc2UgfHwgIVsnMTI3LjAuMC4xJywgJ2xvY2FsaG9zdCcsICdbOjoxXSddLmluY2x1ZGVzKG5ldyBVUkwoYmFzZSkuaG9zdG5hbWUpKVxyXG4gICAgdGhyb3cgRXJyb3IoJ+WPquiDveS9v+eUqOacrOWcsOa1j+iniOWZqOmqjOaUtuWFpeWPoycpO1xyXG4gIGF3YWl0IHBhZ2UuY29udGV4dCgpLnJvdXRlKCcqKi8qJywgKHJvdXRlKSA9PiB7XHJcbiAgICBjb25zdCByZXF1ZXN0ID0gcm91dGUucmVxdWVzdCgpLFxyXG4gICAgICB1cmwgPSBuZXcgVVJMKHJlcXVlc3QudXJsKCkpO1xyXG4gICAgaWYgKFxyXG4gICAgICB1cmwub3JpZ2luID09PSBuZXcgVVJMKGJhc2UpLm9yaWdpbiAmJlxyXG4gICAgICByZXF1ZXN0Lm1ldGhvZCgpID09PSAnR0VUJyAmJlxyXG4gICAgICAhdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy92MS8nKVxyXG4gICAgKVxyXG4gICAgICByZXR1cm4gcm91dGUuY29udGludWUoKTtcclxuICAgIGVycm9ycy5wdXNoKCfmnKrlo7DmmI7lpJbpg6jor7fmsYLvvJonICsgdXJsLm9yaWdpbiArIHVybC5wYXRobmFtZSk7XHJcbiAgICByZXR1cm4gcm91dGUuYWJvcnQoJ2Jsb2NrZWRieWNsaWVudCcpO1xyXG4gIH0pO1xyXG4gIGF3YWl0IHBhZ2Uucm91dGUoJyoqL3YxLyoqJywgYXN5bmMgKHJvdXRlKSA9PiB7XHJcbiAgICBjb25zdCByZXEgPSByb3V0ZS5yZXF1ZXN0KCksXHJcbiAgICAgIHVybCA9IG5ldyBVUkwocmVxLnVybCgpKSxcclxuICAgICAgcGF0aCA9IHVybC5wYXRobmFtZSxcclxuICAgICAgbWV0aG9kID0gcmVxLm1ldGhvZCgpO1xyXG4gICAgaWYgKG1ldGhvZCA9PT0gJ1BPU1QnICYmICEvXlxcL3YxXFwvYXNzZXRzXFwvW14vXStcXC9hY2Nlc3MtdXJsJC8udGVzdChwYXRoKSkgcG9zdFBhdGhzLnB1c2gocGF0aCk7XHJcbiAgICBpZiAobWV0aG9kID09PSAnR0VUJyAmJiAvXlxcL3YxXFwvYXNzZXRzXFwvY2xpcFxcL3ZlcnNpb25zXFwvXFxkK1xcL2NvbnRlbnQkLy50ZXN0KHBhdGgpKVxyXG4gICAgICBzb3VyY2VDb250ZW50UmVxdWVzdHMucHVzaCh7IHBhdGgsIHJlc291cmNlVHlwZTogcmVxLnJlc291cmNlVHlwZSgpIH0pO1xyXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0dFVCcgJiYgcGF0aCA9PT0gJy92MS9hdXRoL21lJylcclxuICAgICAgcmV0dXJuIGpzb24ocm91dGUsIHsgdXNlciwgZXhwaXJlc0F0OiBuZXcgRGF0ZShEYXRlLm5vdygpICsgMzYwMDAwMCkudG9JU09TdHJpbmcoKSB9KTtcclxuICAgIGlmIChwYXRoID09PSAnL3YxL3NldHRpbmdzL2FpJylcclxuICAgICAgcmV0dXJuIGpzb24ocm91dGUsIHtcclxuICAgICAgICBzZXR0aW5nczoge1xyXG4gICAgICAgICAgZGVmYXVsdE1vZGVsczoge1xyXG4gICAgICAgICAgICB0ZXh0OiB7IG1vZGVsQWxpYXM6ICd2aXNpb24tdGVzdCcsIGNyZWRlbnRpYWxJZDogYW5hbHlzaXNDcmVkZW50aWFsSWQgfSxcclxuICAgICAgICAgICAgdmlkZW86IHsgbW9kZWxBbGlhczogJ01pbmlNYXgtSDMnIH0sXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pO1xyXG4gICAgaWYgKHBhdGggPT09ICcvdjEvcHJvamVjdHMnKSByZXR1cm4ganNvbihyb3V0ZSwgeyBwcm9qZWN0czogW3Byb2plY3RdIH0pO1xyXG4gICAgaWYgKHBhdGggPT09ICcvdjEvcHJvamVjdHMvJyArIHByb2plY3QuaWQpIHJldHVybiBqc29uKHJvdXRlLCB7IHByb2plY3QgfSk7XHJcbiAgICBpZiAocGF0aCA9PT0gJy92MS9wcm9qZWN0cy8nICsgcHJvamVjdC5pZCArICcvY2FudmFzJykge1xyXG4gICAgICBpZiAobWV0aG9kID09PSAnUEFUQ0gnKSB7XHJcbiAgICAgICAgaWYgKHNhdmVEZWxheU1zKSBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCBzYXZlRGVsYXlNcykpO1xyXG4gICAgICAgIGNhbnZhcyA9IGNhbnZhc0RvY3VtZW50U2NoZW1hLnBhcnNlKHtcclxuICAgICAgICAgIC4uLnJlcS5wb3N0RGF0YUpTT04oKSxcclxuICAgICAgICAgIHJldmlzaW9uOiBjYW52YXMucmV2aXNpb24gKyAxLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiBqc29uKHJvdXRlLCB7IGNhbnZhcyB9KTtcclxuICAgIH1cclxuICAgIGlmIChwYXRoID09PSAnL3YxL3Byb2plY3RzLycgKyBwcm9qZWN0LmlkICsgJy9ldmVudHMnKVxyXG4gICAgICByZXR1cm4gcm91dGUuZnVsZmlsbCh7IGNvbnRlbnRUeXBlOiAndGV4dC9ldmVudC1zdHJlYW0nLCBib2R5OiAnOiByZWFkeVxcblxcbicgfSk7XHJcbiAgICBpZiAocGF0aCA9PT0gJy92MS9wcm9qZWN0cy8nICsgcHJvamVjdC5pZCArICcvbW9kZWxzL2RlZmF1bHRzJylcclxuICAgICAgcmV0dXJuIGpzb24ocm91dGUsIHtcclxuICAgICAgICBkZWZhdWx0czoge1xyXG4gICAgICAgICAgdGV4dDogeyBtb2RlbEFsaWFzOiAndmlzaW9uLXRlc3QnLCBjcmVkZW50aWFsSWQ6IGFuYWx5c2lzQ3JlZGVudGlhbElkIH0sXHJcbiAgICAgICAgICB2aWRlbzogeyBtb2RlbEFsaWFzOiAnTWluaU1heC1IMycgfSxcclxuICAgICAgICB9LFxyXG4gICAgICB9KTtcclxuICAgIGlmIChwYXRoID09PSAnL3YxL3Byb2plY3RzLycgKyBwcm9qZWN0LmlkICsgJy9ydW5zJykgcmV0dXJuIGpzb24ocm91dGUsIHsgcnVuczogZ2VuZXJhdGVzIH0pO1xyXG4gICAgaWYgKHBhdGggPT09ICcvdjEvbW9kZWxzJylcclxuICAgICAgcmV0dXJuIGpzb24ocm91dGUsIHtcclxuICAgICAgICBtb2RlbHM6IFtcclxuICAgICAgICAgIHtcclxuICAgICAgICAgICAgaWQ6ICd2aXNpb24tdGVzdCcsXHJcbiAgICAgICAgICAgIGNyZWRlbnRpYWxJZDogYW5hbHlzaXNDcmVkZW50aWFsSWQsXHJcbiAgICAgICAgICAgIG5hbWU6ICfop4bpopHliIbmnpDmqKHlnosnLFxyXG4gICAgICAgICAgICBtZWRpYVR5cGVzOiBbJ3RleHQnXSxcclxuICAgICAgICAgICAgYXZhaWxhYmxlOiB0cnVlLFxyXG4gICAgICAgICAgICBjYXBhYmlsaXRpZXM6IHsgbWVudGlvbk1lZGlhVHlwZXM6IFsndmlkZW8nXSB9LFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIHtcclxuICAgICAgICAgICAgaWQ6ICdNaW5pTWF4LUgzJyxcclxuICAgICAgICAgICAgbmFtZTogJ+WPguiAg+inhumikeeUn+aIkOaooeWeiycsXHJcbiAgICAgICAgICAgIG1lZGlhVHlwZXM6IFsndmlkZW8nXSxcclxuICAgICAgICAgICAgYXZhaWxhYmxlOiB0cnVlLFxyXG4gICAgICAgICAgICBjYXBhYmlsaXRpZXM6IHsgbWVudGlvbk1lZGlhVHlwZXM6IFsnaW1hZ2UnLCAndmlkZW8nXSB9LFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIC4uLihpZGVudGlmaWVkXHJcbiAgICAgICAgICAgID8gW1xyXG4gICAgICAgICAgICAgICAge1xyXG4gICAgICAgICAgICAgICAgICBpZDogJ3F3ZW4zLjgtb21uaS1mbGFzaCcsXHJcbiAgICAgICAgICAgICAgICAgIGNyZWRlbnRpYWxJZDogYW5hbHlzaXNDcmVkZW50aWFsSWQsXHJcbiAgICAgICAgICAgICAgICAgIG5hbWU6ICdxd2VuMy44LW9tbmktZmxhc2gnLFxyXG4gICAgICAgICAgICAgICAgICBtZWRpYVR5cGVzOiBbJ3RleHQnXSxcclxuICAgICAgICAgICAgICAgICAgYXZhaWxhYmxlOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgIHtcclxuICAgICAgICAgICAgICAgICAgaWQ6ICdzb3JhLTInLFxyXG4gICAgICAgICAgICAgICAgICBuYW1lOiAn54us56uL6KeG6aKR55Sf5oiQ5qih5Z6LJyxcclxuICAgICAgICAgICAgICAgICAgbWVkaWFUeXBlczogWyd2aWRlbyddLFxyXG4gICAgICAgICAgICAgICAgICBhdmFpbGFibGU6IHRydWUsXHJcbiAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICAgIF1cclxuICAgICAgICAgICAgOiBbXSksXHJcbiAgICAgICAgXSxcclxuICAgICAgfSk7XHJcbiAgICBpZiAocGF0aCA9PT0gJy92MS9wcm9tcHQtc2tpbGxzJylcclxuICAgICAgcmV0dXJuIGpzb24ocm91dGUsIHtcclxuICAgICAgICBza2lsbHM6IFBST01QVF9TS0lMTFMubWFwKChzKSA9PiAoeyAuLi5zLCBidWlsdGluOiB0cnVlLCBlbmFibGVkOiB0cnVlLCByZXZpc2lvbjogMSB9KSksXHJcbiAgICAgIH0pO1xyXG4gICAgaWYgKHBhdGggPT09ICcvdjEvYXNzZXRzL3VwbG9hZHMvaW5pdCcgJiYgbWV0aG9kID09PSAnUE9TVCcpIHtcclxuICAgICAgdXBsb2Fkcy5wdXNoKCdpbml0Jyk7XHJcbiAgICAgIGV4cGVjdChyZXEucG9zdERhdGFKU09OKCkubmFtZSkudG9CZSgn5oiR55qE5Lq654mpLmpwZycpO1xyXG4gICAgICByZXR1cm4ganNvbihyb3V0ZSwge1xyXG4gICAgICAgIHVwbG9hZElkOiAnY2hhcmFjdGVyLXVwbG9hZCcsXHJcbiAgICAgICAgdXBsb2FkVXJsOiAnL3YxL2Fzc2V0cy91cGxvYWRzL3JlY3JlYXRpb24tYnl0ZXMnLFxyXG4gICAgICAgIGNvbXBsZXRlVXJsOiAnL3YxL2Fzc2V0cy91cGxvYWRzL2NvbXBsZXRlJyxcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBpZiAocGF0aCA9PT0gJy92MS9hc3NldHMvdXBsb2Fkcy9yZWNyZWF0aW9uLWJ5dGVzJyAmJiBtZXRob2QgPT09ICdQVVQnKSB7XHJcbiAgICAgIHVwbG9hZHMucHVzaCgnYnl0ZXMnKTtcclxuICAgICAgZXhwZWN0KHJlcS5wb3N0RGF0YUJ1ZmZlcigpKS50b0VxdWFsKGltYWdlKTtcclxuICAgICAgcmV0dXJuIHJvdXRlLmZ1bGZpbGwoeyBzdGF0dXM6IDIwNCB9KTtcclxuICAgIH1cclxuICAgIGlmIChwYXRoID09PSAnL3YxL2Fzc2V0cy91cGxvYWRzL2NvbXBsZXRlJyAmJiBtZXRob2QgPT09ICdQT1NUJykge1xyXG4gICAgICB1cGxvYWRzLnB1c2goJ2NvbXBsZXRlJyk7XHJcbiAgICAgIGV4cGVjdChyZXEucG9zdERhdGFKU09OKCkudXBsb2FkSWQpLnRvQmUoJ2NoYXJhY3Rlci11cGxvYWQnKTtcclxuICAgICAgY29uc3QgdXBsb2FkZWQgPSB7XHJcbiAgICAgICAgLi4uYXNzZXRzLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5pZCA9PT0gJ3BlcnNvbi1hJykhLFxyXG4gICAgICAgIGlkOiAndXBsb2FkZWQtY2hhcmFjdGVyJyxcclxuICAgICAgICBuYW1lOiAn5oiR55qE5Lq654mpLmpwZycsXHJcbiAgICAgICAgbGF0ZXN0VmVyc2lvbjogNSxcclxuICAgICAgICBjb250ZW50VXJsOiAnL3YxL2Fzc2V0cy91cGxvYWRlZC1jaGFyYWN0ZXIvdmVyc2lvbnMvNS9jb250ZW50JyxcclxuICAgICAgfTtcclxuICAgICAgYXNzZXRzLnB1c2godXBsb2FkZWQpO1xyXG4gICAgICByZXR1cm4ganNvbihyb3V0ZSwgeyBhc3NldDogdXBsb2FkZWQgfSwgMjAxKTtcclxuICAgIH1cclxuICAgIGlmIChwYXRoID09PSAnL3YxL2Fzc2V0cycpIHtcclxuICAgICAgaWYgKHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdtZWRpYVR5cGUnKSA9PT0gJ2ltYWdlJykge1xyXG4gICAgICAgIGNvbnN0IHF1ZXJ5ID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3F1ZXJ5JykgPz8gJyc7XHJcbiAgICAgICAgcmVzb3VyY2VTZWFyY2hlcy5wdXNoKHtcclxuICAgICAgICAgIHF1ZXJ5LFxyXG4gICAgICAgICAgbWVkaWFUeXBlOiB1cmwuc2VhcmNoUGFyYW1zLmdldCgnbWVkaWFUeXBlJykhLFxyXG4gICAgICAgICAgcGFnZTogdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhZ2UnKSEsXHJcbiAgICAgICAgICBwcm9qZWN0SWQ6IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwcm9qZWN0SWQnKSEsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29uc3QgbWF0Y2hpbmcgPSBbLi4uYXNzZXRzLCByZW1vdGVQb3J0cmFpdF0uZmlsdGVyKFxyXG4gICAgICAgICAgKGFzc2V0KSA9PiBhc3NldC5tZWRpYVR5cGUgPT09ICdpbWFnZScgJiYgYXNzZXQubmFtZS5pbmNsdWRlcyhxdWVyeSksXHJcbiAgICAgICAgKTtcclxuICAgICAgICByZXR1cm4ganNvbihyb3V0ZSwgeyBhc3NldHM6IG1hdGNoaW5nLCB0b3RhbDogbWF0Y2hpbmcubGVuZ3RoLCBwYWdlOiAxLCBwYWdlU2l6ZTogNTAgfSk7XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIGpzb24ocm91dGUsIHsgYXNzZXRzIH0pO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYXNzZXRNYXRjaCA9IC9eXFwvdjFcXC9hc3NldHNcXC8oW14vXSspLy5leGVjKHBhdGgpO1xyXG4gICAgY29uc3QgYXNzZXQgPSBbLi4uYXNzZXRzLCByZW1vdGVQb3J0cmFpdF0uZmluZCgoYSkgPT4gYS5pZCA9PT0gYXNzZXRNYXRjaD8uWzFdKTtcclxuICAgIGlmIChhc3NldCAmJiBwYXRoLmVuZHNXaXRoKCcvdmVyc2lvbnMnKSlcclxuICAgICAgcmV0dXJuIGpzb24ocm91dGUsIHtcclxuICAgICAgICB2ZXJzaW9uczogW1xyXG4gICAgICAgICAgLi4ubmV3IFNldChhc3NldC5pZCA9PT0gJ2NsaXAnID8gWzIsIGFzc2V0LmxhdGVzdFZlcnNpb25dIDogW2Fzc2V0LmxhdGVzdFZlcnNpb25dKSxcclxuICAgICAgICBdLm1hcCgodmVyc2lvbikgPT4gKHtcclxuICAgICAgICAgIGlkOiBhc3NldC5pZCArICd2JyArIHZlcnNpb24sXHJcbiAgICAgICAgICBhc3NldElkOiBhc3NldC5pZCxcclxuICAgICAgICAgIHZlcnNpb24sXHJcbiAgICAgICAgICBzaXplQnl0ZXM6IGFzc2V0LnNpemVCeXRlcyxcclxuICAgICAgICAgIG1ldGFkYXRhOiBhc3NldC5pZCA9PT0gJ2NsaXAnICYmIHZlcnNpb24gPT09IDIgPyB7IGR1cmF0aW9uU2Vjb25kczogMTAgfSA6IGFzc2V0Lm1ldGFkYXRhLFxyXG4gICAgICAgICAgY3JlYXRlZEF0OiBwcm9qZWN0LmNyZWF0ZWRBdCxcclxuICAgICAgICAgIGNvbnRlbnRVcmw6ICcvdjEvYXNzZXRzLycgKyBhc3NldC5pZCArICcvdmVyc2lvbnMvJyArIHZlcnNpb24gKyAnL2NvbnRlbnQnLFxyXG4gICAgICAgIH0pKSxcclxuICAgICAgfSk7XHJcbiAgICBpZiAoYXNzZXQgJiYgcGF0aC5lbmRzV2l0aCgnL2FjY2Vzcy11cmwnKSkge1xyXG4gICAgICBjb25zdCBzY29wZSA9IG1ldGhvZCA9PT0gJ1BPU1QnID8gcmVxLnBvc3REYXRhSlNPTigpIDoge307XHJcbiAgICAgIHJldHVybiBqc29uKHJvdXRlLCB7XHJcbiAgICAgICAgdXJsOiBzY29wZS52ZXJzaW9uXHJcbiAgICAgICAgICA/ICcvdjEvYXNzZXRzLycgKyBhc3NldC5pZCArICcvdmVyc2lvbnMvJyArIHNjb3BlLnZlcnNpb24gKyAnL2NvbnRlbnQnXHJcbiAgICAgICAgICA6IGFzc2V0LmNvbnRlbnRVcmwsXHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgaWYgKGFzc2V0ICYmIChwYXRoLmVuZHNXaXRoKCcvY29udGVudCcpIHx8IHBhdGguZW5kc1dpdGgoJy9kZXJpdmF0aXZlcy90aHVtYm5haWwnKSkpXHJcbiAgICAgIHJldHVybiByb3V0ZS5mdWxmaWxsKHtcclxuICAgICAgICBjb250ZW50VHlwZTogYXNzZXQubWVkaWFUeXBlID09PSAndmlkZW8nID8gJ3ZpZGVvL21wNCcgOiAnaW1hZ2UvanBlZycsXHJcbiAgICAgICAgYm9keTogYXNzZXQubWVkaWFUeXBlID09PSAndmlkZW8nID8gdmlkZW8gOiBpbWFnZSxcclxuICAgICAgfSk7XHJcbiAgICBpZiAocGF0aCA9PT0gJy92MS9hc3NldHMvY2xpcC92ZXJzaW9ucy8yL3JldmVyc2UtcHJvbXB0cycpIHtcclxuICAgICAgaWYgKG1ldGhvZCA9PT0gJ1BPU1QnKSB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IHJlcS5wb3N0RGF0YUpTT04oKTtcclxuICAgICAgICBwb3N0cy5wdXNoKGJvZHkpO1xyXG4gICAgICAgIGNvbnN0IHBlbmRpbmcgPSBjYW52YXMubm9kZXMuZmluZCgobikgPT4gbi5kYXRhLnZpZGVvUmVjcmVhdGlvbik/LmRhdGEudmlkZW9SZWNyZWF0aW9uXHJcbiAgICAgICAgICA/LnJlcXVlc3Q7XHJcbiAgICAgICAgZXhwZWN0KHBlbmRpbmc/LmlkZW1wb3RlbmN5S2V5KS50b0JlKGJvZHkuaWRlbXBvdGVuY3lLZXkpO1xyXG4gICAgICAgIGV4cGVjdChib2R5LnB1cnBvc2UpLnRvQmUoJ3ZpZGVvX3JlY3JlYXRpb24nKTtcclxuICAgICAgICBleHBlY3QocGVuZGluZz8ubW9kZWxBbGlhcykudG9CZShib2R5Lm1vZGVsQWxpYXMpO1xyXG4gICAgICAgIGV4cGVjdChwZW5kaW5nPy5jcmVkZW50aWFsSWQpLnRvQmUoYm9keS5jcmVkZW50aWFsSWQpO1xyXG4gICAgICAgIGFuYWx5c2lzID0ge1xyXG4gICAgICAgICAgcnVuSWQ6ICdhbmFseXNpcy0xJyxcclxuICAgICAgICAgIGFzc2V0SWQ6ICdjbGlwJyxcclxuICAgICAgICAgIGFzc2V0VmVyc2lvbjogMixcclxuICAgICAgICAgIHB1cnBvc2U6ICd2aWRlb19yZWNyZWF0aW9uJyxcclxuICAgICAgICAgIHN0YXR1czogJ3F1ZXVlZCcsXHJcbiAgICAgICAgICBtb2RlbEFsaWFzOiBib2R5Lm1vZGVsQWxpYXMsXHJcbiAgICAgICAgICAuLi4oYm9keS5jcmVkZW50aWFsSWQgPyB7IGNyZWRlbnRpYWxJZDogYm9keS5jcmVkZW50aWFsSWQgfSA6IHt9KSxcclxuICAgICAgICB9O1xyXG4gICAgICAgIHJldHVybiBqc29uKHJvdXRlLCB7IGFuYWx5c2lzIH0sIDIwMik7XHJcbiAgICAgIH1cclxuICAgICAgZXhwZWN0KHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwdXJwb3NlJykpLnRvQmUoJ3ZpZGVvX3JlY3JlYXRpb24nKTtcclxuICAgICAgcmV0dXJuIGpzb24ocm91dGUsIHtcclxuICAgICAgICBhbmFseXNpczogYW5hbHlzaXNcclxuICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgIC4uLmFuYWx5c2lzLFxyXG4gICAgICAgICAgICAgIHN0YXR1czogaG9sZCA/ICdydW5uaW5nJyA6ICdzdWNjZWVkZWQnLFxyXG4gICAgICAgICAgICAgIC4uLihob2xkXHJcbiAgICAgICAgICAgICAgICA/IHt9XHJcbiAgICAgICAgICAgICAgICA6IHtcclxuICAgICAgICAgICAgICAgICAgICBzdW1tYXJ5OiBpZGVudGlmaWVkID8gJ+aVtOadoeinhumikeS4pOS4quS6uueJqeOAgeS4pOS7tueJqeWTgScgOiAn5pW05p2h6KeG6aKR5Lik5Liq6L+e57ut6ZWc5aS0JyxcclxuICAgICAgICAgICAgICAgICAgICBwcm9tcHQ6IEpTT04uc3RyaW5naWZ5KGlkZW50aWZpZWQgPyBpZGVudGlmaWVkVGVtcGxhdGUgOiB0ZW1wbGF0ZSksXHJcbiAgICAgICAgICAgICAgICAgIH0pLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgZGVmYXVsdE1vZGVsOiB7IG1vZGVsQWxpYXM6ICd2aXNpb24tdGVzdCcsIGNyZWRlbnRpYWxJZDogYW5hbHlzaXNDcmVkZW50aWFsSWQgfSxcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0YXJnZXQgPSBjYW52YXMubm9kZXMuZmluZCgobikgPT4gcGF0aCA9PT0gJy92MS9ub2Rlcy8nICsgbi5pZCArICcvcnVucycpO1xyXG4gICAgaWYgKG1ldGhvZCA9PT0gJ1BPU1QnICYmIHRhcmdldCkge1xyXG4gICAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICAgIGNvbnN0IGdlbmVyYXRlZEltYWdlID0gZ2VuZXJhdGlvbk1lZGlhVHlwZVxyXG4gICAgICAgID8ge1xyXG4gICAgICAgICAgICAuLi5hc3NldHNbMV0hLFxyXG4gICAgICAgICAgICBpZDogJ3JlY3JlYXRpb24tcmVzdWx0LWltYWdlJyxcclxuICAgICAgICAgICAgbmFtZTogJ+WkjeWIu+eUn+aIkOWbvueJhycsXHJcbiAgICAgICAgICAgIGxhdGVzdFZlcnNpb246IDcsXHJcbiAgICAgICAgICAgIGNvbnRlbnRVcmw6ICcvdjEvYXNzZXRzL3JlY3JlYXRpb24tcmVzdWx0LWltYWdlL3ZlcnNpb25zLzcvY29udGVudCcsXHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICAgIGlmIChnZW5lcmF0ZWRJbWFnZSkgYXNzZXRzLnB1c2goZ2VuZXJhdGVkSW1hZ2UpO1xyXG4gICAgICBjb25zdCBydW46IFJ1blJlY29yZCA9IHtcclxuICAgICAgICBpZDogJ3JlY3JlYXRpb24tZ2VuZXJhdGlvbi0nICsgKGdlbmVyYXRlcy5sZW5ndGggKyAxKSxcclxuICAgICAgICBwcm9qZWN0SWQ6IHByb2plY3QuaWQsXHJcbiAgICAgICAgdGFyZ2V0Tm9kZUlkOiB0YXJnZXQuaWQsXHJcbiAgICAgICAgc3RhdHVzOiAnc3VjY2VlZGVkJyxcclxuICAgICAgICBwcm9ncmVzczogMTAwLFxyXG4gICAgICAgIGF0dGVtcHQ6IDEsXHJcbiAgICAgICAgcHJvdmlkZXI6ICdtb2NrJyxcclxuICAgICAgICBtb2RlbEFsaWFzOiB0YXJnZXQuZGF0YS5tb2RlbEFsaWFzISxcclxuICAgICAgICBjcmVhdGVkQXQ6IG5vdyxcclxuICAgICAgICB1cGRhdGVkQXQ6IG5vdyxcclxuICAgICAgICBzbmFwc2hvdDoge1xyXG4gICAgICAgICAgcHJvamVjdElkOiBwcm9qZWN0LmlkLFxyXG4gICAgICAgICAgY2FudmFzUmV2aXNpb246IGNhbnZhcy5yZXZpc2lvbixcclxuICAgICAgICAgIHRhcmdldE5vZGVJZDogdGFyZ2V0LmlkLFxyXG4gICAgICAgICAgbW9kZWxBbGlhczogdGFyZ2V0LmRhdGEubW9kZWxBbGlhcyEsXHJcbiAgICAgICAgICBzdWJtaXR0ZWRBdDogbm93LFxyXG4gICAgICAgICAgbm9kZXM6IGNhbnZhcy5ub2RlcyxcclxuICAgICAgICAgIGVkZ2VzOiBbXSxcclxuICAgICAgICAgIGlucHV0czogW10sXHJcbiAgICAgICAgICBwYXJhbWV0ZXJzOiB0YXJnZXQuZGF0YS5wYXJhbWV0ZXJzID8/IHt9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgLi4uKGdlbmVyYXRlZEltYWdlXHJcbiAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICByZXN1bHQ6IHtcclxuICAgICAgICAgICAgICAgIHN1bW1hcnk6ICflm77niYfnu5Pmnpzlt7LlvZLmoaMnLFxyXG4gICAgICAgICAgICAgICAgbWVkaWFUeXBlOiAnaW1hZ2UnIGFzIGNvbnN0LFxyXG4gICAgICAgICAgICAgICAgdGFyZ2V0Tm9kZUlkOiB0YXJnZXQuaWQsXHJcbiAgICAgICAgICAgICAgICBwcm92aWRlcjogJ21vY2snLFxyXG4gICAgICAgICAgICAgICAgaW5wdXRDb3VudDogMSxcclxuICAgICAgICAgICAgICAgIGFzc2V0OiB7XHJcbiAgICAgICAgICAgICAgICAgIGFzc2V0SWQ6IGdlbmVyYXRlZEltYWdlLmlkLFxyXG4gICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBnZW5lcmF0ZWRJbWFnZS5sYXRlc3RWZXJzaW9uLFxyXG4gICAgICAgICAgICAgICAgICBtaW1lVHlwZTogZ2VuZXJhdGVkSW1hZ2UubWltZVR5cGUsXHJcbiAgICAgICAgICAgICAgICAgIHNpemVCeXRlczogZ2VuZXJhdGVkSW1hZ2Uuc2l6ZUJ5dGVzLFxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICA6IHt9KSxcclxuICAgICAgfTtcclxuICAgICAgZ2VuZXJhdGVzLnB1c2gocnVuKTtcclxuICAgICAgcmV0dXJuIGpzb24ocm91dGUsIHsgcnVuIH0sIDIwMik7XHJcbiAgICB9XHJcbiAgICBpZiAocGF0aC5zdGFydHNXaXRoKCcvdjEvcnVucy8nKSkge1xyXG4gICAgICBjb25zdCBydW4gPSBnZW5lcmF0ZXMuZmluZCgocikgPT4gci5pZCA9PT0gcGF0aC5zcGxpdCgnLycpLmF0KC0xKSk7XHJcbiAgICAgIGlmIChydW4pIHJldHVybiBqc29uKHJvdXRlLCB7IHJ1biB9KTtcclxuICAgIH1cclxuICAgIGVycm9ycy5wdXNoKCfmnKrlo7DmmI7mjqXlj6PvvJonICsgbWV0aG9kICsgJyAnICsgcGF0aCk7XHJcbiAgICByZXR1cm4ganNvbihyb3V0ZSwgeyBlcnJvcjogJ+acquWjsOaYjuaOpeWPoycgfSwgNDA0KTtcclxuICB9KTtcclxuICByZXR1cm4ge1xyXG4gICAgY2FudmFzOiAoKSA9PiBjYW52YXMsXHJcbiAgICBwb3N0cyxcclxuICAgIHBvc3RQYXRocyxcclxuICAgIHNvdXJjZUNvbnRlbnRSZXF1ZXN0cyxcclxuICAgIHJlc291cmNlU2VhcmNoZXMsXHJcbiAgICBnZW5lcmF0ZXMsXHJcbiAgICB1cGxvYWRzLFxyXG4gICAgZXJyb3JzLFxyXG4gICAgaG9sZDogKHZhbHVlOiBib29sZWFuKSA9PiB7XHJcbiAgICAgIGhvbGQgPSB2YWx1ZTtcclxuICAgIH0sXHJcbiAgfTtcclxufVxyXG4vKipcclxuICog5LuO5bel5YW35qCP5Yib5bu656m66I2J56i/77yM54K55Ye76IqC54K55ZCO5Zyo5LiT55SoIERpYWxvZyDnu5HlrprmnaXmupDvvJvljoblj7Llm57mmL7lj6bpqozor4Hlhrvnu5PniYjmnKzlhaXlj6PjgIJcclxuICogQHBhcmFtIHBhZ2Ug5bey5a6J6KOF6ZqU56a7IEFQSSBNb2NrIOeahOa1j+iniOWZqOmhtemdouOAglxyXG4gKiBAcGFyYW0gZnJvbUZyb3plblNvdXJjZSDmmK/lkKbku47kv53lrZjkuobml6fniYjmnKznmoTop4bpopHoioLngrnliJvlu7rvvIzpu5jorqTotbDlt6XlhbfmoI/ojYnnqL/mtYHnqIvjgIJcclxuICogQHJldHVybnMg5bey57uR5a6a5p2l5rqQ55qE5aSN5Yi76IqC54K577yb5LiN5omn6KGM5YiG5p6Q5oiW55Sf5oiQ44CCXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVOb2RlKHBhZ2U6IFBhZ2UsIGZyb21Gcm96ZW5Tb3VyY2UgPSBmYWxzZSkge1xyXG4gIGF3YWl0IHBhZ2UuZ290bygnL3Byb2plY3RzLycgKyBwcm9qZWN0LmlkKTtcclxuICBjb25zdCBzb3VyY2UgPSBwYWdlLmxvY2F0b3IoJy5yZWFjdC1mbG93X19ub2RlW2RhdGEtaWQ9XCJzb3VyY2UtdmlkZW9cIl0nKTtcclxuICAvLyBWaXRlIOWGt+WQr+WKqOS8muaMiemcgOe8luivkeW3peS9nOWMuuaooeWdl++8jOadpea6kOWwsee7quWQjuaJjeW8gOWni+aguOWvueS6pOS6kuOAglxyXG4gIGF3YWl0IGV4cGVjdChzb3VyY2UpLnRvQmVWaXNpYmxlKHsgdGltZW91dDogMTUwMDAgfSk7XHJcbiAgaWYgKGZyb21Gcm96ZW5Tb3VyY2UpIHtcclxuICAgIGF3YWl0IHNvdXJjZS5ob3ZlcigpO1xyXG4gICAgYXdhaXQgc291cmNlLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5aSN5Yi755+t6KeG6aKR77ya5Y+C6ICD55+t6KeG6aKRJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICB9IGVsc2Uge1xyXG4gICAgYXdhaXQgcGFnZVxyXG4gICAgICAuZ2V0QnlSb2xlKCdncm91cCcsIHsgbmFtZTogJ+iKgueCuee7hCcsIGV4YWN0OiB0cnVlIH0pXHJcbiAgICAgIC5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+efreinhumikeWkjeWIuycsIGV4YWN0OiB0cnVlIH0pXHJcbiAgICAgIC5jbGljaygpO1xyXG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UuZ2V0QnlSb2xlKCdkaWFsb2cnKSkudG9IYXZlQ291bnQoMCk7XHJcbiAgfVxyXG4gIGNvbnN0IG5vZGUgPSBwYWdlXHJcbiAgICAubG9jYXRvcignLnJlYWN0LWZsb3dfX25vZGUnKVxyXG4gICAgLmZpbHRlcih7IGhhczogcGFnZS5nZXRCeVJvbGUoJ2dyb3VwJywgeyBuYW1lOiAn6IqC54K55pON5L2c77ya55+t6KeG6aKR5aSN5Yi7JywgZXhhY3Q6IHRydWUgfSkgfSk7XHJcbiAgYXdhaXQgZXhwZWN0KG5vZGUpLnRvQmVWaXNpYmxlKCk7XHJcbiAgY29uc3QgZGlhbG9nID0gYXdhaXQgY2xpY2tSZWNyZWF0aW9uTm9kZShwYWdlLCBub2RlKTtcclxuICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCcubm9kZS1xdWljay1lZGl0b3InKSkudG9IYXZlQ291bnQoMCk7XHJcbiAgaWYgKCFmcm9tRnJvemVuU291cmNlKSB7XHJcbiAgICBhd2FpdCBzZWxlY3RPcHRpb24oXHJcbiAgICAgIGRpYWxvZy5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Y+C6ICD6KeG6aKRJywgZXhhY3Q6IHRydWUgfSksXHJcbiAgICAgIC/lj4LogIPnn63op4bpopEvLFxyXG4gICAgKTtcclxuICAgIGF3YWl0IGRpYWxvZy5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+S9v+eUqOatpOinhumikScsIGV4YWN0OiB0cnVlIH0pLmNsaWNrKCk7XHJcbiAgfVxyXG4gIGF3YWl0IGV4cGVjdChkaWFsb2cuZ2V0QnlSb2xlKCdyZWdpb24nLCB7IG5hbWU6ICfnn63op4bpopHlpI3liLsnLCBleGFjdDogdHJ1ZSB9KSkudG9CZVZpc2libGUoKTtcclxuICByZXR1cm4gbm9kZTtcclxufVxyXG4vKiog6aaW5qyh54K55Ye76IGa54Sm6IqC54K577yM56ys5LqM5qyh54K55Ye75ZCM5LiA5YaF5a655Yy65omN5omT5byA5aSN5Yi757yW6L6R5Zmo44CCICovXHJcbmFzeW5jIGZ1bmN0aW9uIGNsaWNrUmVjcmVhdGlvbk5vZGUocGFnZTogUGFnZSwgbm9kZTogTG9jYXRvcikge1xyXG4gIGNvbnN0IGRpYWxvZyA9IHBhZ2UuZ2V0QnlSb2xlKCdkaWFsb2cnLCB7IG5hbWU6ICfnn63op4bpopHlpI3liLsnLCBleGFjdDogdHJ1ZSB9KTtcclxuICBjb25zdCBjb250ZW50ID0gbm9kZS5sb2NhdG9yKCcuZmxvdy1ub2RlLXByZXZpZXcsIC5mbG93LW5vZGUtcGxhY2Vob2xkZXInKS5maXJzdCgpO1xyXG4gIGF3YWl0IGV4cGVjdChjb250ZW50KS50b0JlVmlzaWJsZSgpO1xyXG4gIGF3YWl0IGNvbnRlbnQuY2xpY2soeyBwb3NpdGlvbjogeyB4OiAxMiwgeTogMTIgfSB9KTtcclxuICBhd2FpdCBleHBlY3QoZGlhbG9nKS50b0JlSGlkZGVuKCk7XHJcbiAgYXdhaXQgY29udGVudC5jbGljayh7IHBvc2l0aW9uOiB7IHg6IDEyLCB5OiAxMiB9IH0pO1xyXG4gIGF3YWl0IGV4cGVjdChkaWFsb2cpLnRvQmVWaXNpYmxlKCk7XHJcbiAgcmV0dXJuIGRpYWxvZztcclxufVxyXG4vKiog5Zyo5b2T5YmN6KeG5Y+j5a6e6ZmF5Y+v54K55Yiw55qE55S75biD56m655m95aSE5Y+W5raI6IqC54K56YCJ5oup44CCICovXHJcbmFzeW5jIGZ1bmN0aW9uIGNsaWNrRW1wdHlQYW5lKHBhZ2U6IFBhZ2UpIHtcclxuICBjb25zdCBwb2ludCA9IGF3YWl0IHBhZ2UubG9jYXRvcignLnJlYWN0LWZsb3dfX3BhbmUnKS5ldmFsdWF0ZSgocGFuZSkgPT4ge1xyXG4gICAgY29uc3QgYm91bmRzID0gcGFuZS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgIGZvciAoY29uc3QgeVJhdGlvIG9mIFswLjIsIDAuMzUsIDAuNSwgMC42NSwgMC44XSkge1xyXG4gICAgICBmb3IgKGNvbnN0IHhSYXRpbyBvZiBbMC44LCAwLjY1LCAwLjUsIDAuMzUsIDAuMl0pIHtcclxuICAgICAgICBjb25zdCB4ID0gYm91bmRzLmxlZnQgKyBib3VuZHMud2lkdGggKiB4UmF0aW87XHJcbiAgICAgICAgY29uc3QgeSA9IGJvdW5kcy50b3AgKyBib3VuZHMuaGVpZ2h0ICogeVJhdGlvO1xyXG4gICAgICAgIGlmIChkb2N1bWVudC5lbGVtZW50RnJvbVBvaW50KHgsIHkpID09PSBwYW5lKSByZXR1cm4geyB4LCB5IH07XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN6KeG5Y+j5rKh5pyJ5Y+v54K55Ye755qE55S75biD56m655m95L2N572uJyk7XHJcbiAgfSk7XHJcbiAgYXdhaXQgcGFnZS5tb3VzZS5jbGljayhwb2ludC54LCBwb2ludC55KTtcclxufVxyXG4vKiog5Y+q54K55Ye76YeN5byA5pei5pyJ6IqC54K555qE5LiT55SoIERpYWxvZ++8jOS4jemHjeaWsOe7keWumuOAgeWIhuaekOaIlueUn+aIkOOAgiAqL1xyXG5hc3luYyBmdW5jdGlvbiBvcGVuUmVjcmVhdGlvbihwYWdlOiBQYWdlLCBpZDogc3RyaW5nKSB7XHJcbiAgY29uc3Qgbm9kZSA9IHBhZ2UubG9jYXRvcignLnJlYWN0LWZsb3dfX25vZGVbZGF0YS1pZD1cIicgKyBpZCArICdcIl0nKTtcclxuICBhd2FpdCBleHBlY3Qobm9kZSkudG9CZVZpc2libGUoKTtcclxuICBjb25zdCBkaWFsb2cgPSBhd2FpdCBjbGlja1JlY3JlYXRpb25Ob2RlKHBhZ2UsIG5vZGUpO1xyXG4gIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJy5ub2RlLXF1aWNrLWVkaXRvcicpKS50b0hhdmVDb3VudCgwKTtcclxuICByZXR1cm4gZGlhbG9nLmdldEJ5Um9sZSgncmVnaW9uJywgeyBuYW1lOiAn55+t6KeG6aKR5aSN5Yi7JywgZXhhY3Q6IHRydWUgfSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDmoLjlr7nnnJ/lrp4gUEMg5biD5bGA5bC65a+444CB5LiJ5qCP6aG65bqP5LiO5pyJ55WM5rua5Yqo77yM5bC65a+457yp5bCP5oiW6KKr5q2j5paH5pKR5aSn5pe25aSx6LSl44CCXHJcbiAqIEBwYXJhbSBkaWFsb2cg5LiT55So5aSN5Yi7IERpYWxvZ++8jOWPr+WkhOS6juepuuiNieeov+aIluW3sue7keWumuadpea6kOeKtuaAgeOAglxyXG4gKiBAcGFyYW0gdmlld3BvcnQg5b2T5YmNIFBDIOinhuWPo+WwuuWvuO+8jOWNleS9jeS4uiBDU1Mg5YOP57Sg44CCXHJcbiAqIEByZXR1cm5zIERpYWxvZyDlkozkuInmoI/mtYvph4/lgLzvvIzkvpvmiKrlm77kuI7mtY/op4jlmajpqozmlLborrDlvZXjgIJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIGV4cGVjdFJlY3JlYXRpb25MYXlvdXQoXHJcbiAgZGlhbG9nOiBMb2NhdG9yLFxyXG4gIHZpZXdwb3J0OiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0sXHJcbikge1xyXG4gIC8vIE1vZGFsIOWFpeWcuuWKqOeUu+S8mue8qeaUvua1i+mHj+WAvO+8m+WKqOeUu+e7k+adn+WQjuWGjeaguOWvueacgOe7iOWwuuWvuO+8jOS4jeS/ruaUuemhtemdouagt+W8j+OAglxyXG4gIGF3YWl0IGV4cGVjdFxyXG4gICAgLnBvbGwoKCkgPT5cclxuICAgICAgZGlhbG9nLmV2YWx1YXRlKFxyXG4gICAgICAgIChlbGVtZW50KSA9PlxyXG4gICAgICAgICAgZWxlbWVudC5nZXRBbmltYXRpb25zKCkuZmlsdGVyKChhbmltYXRpb24pID0+IGFuaW1hdGlvbi5wbGF5U3RhdGUgPT09ICdydW5uaW5nJykubGVuZ3RoLFxyXG4gICAgICApLFxyXG4gICAgKVxyXG4gICAgLnRvQmUoMCk7XHJcbiAgY29uc3QgbGF5b3V0ID0gYXdhaXQgZGlhbG9nLmV2YWx1YXRlKChlbGVtZW50KSA9PiB7XHJcbiAgICAvKiog5Y+q6K+75Y+W5pyA57uI5biD5bGA5ZKM5rua5Yqo6L6555WM77yM5LiN5L+u5pS55b6F6aqM5pS26aG16Z2i44CCICovXHJcbiAgICBjb25zdCBtZWFzdXJlID0gKHRhcmdldDogRWxlbWVudCkgPT4ge1xyXG4gICAgICBjb25zdCBib3VuZHMgPSB0YXJnZXQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICAgIGNvbnN0IHN0eWxlID0gZ2V0Q29tcHV0ZWRTdHlsZSh0YXJnZXQpO1xyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIGNsYXNzTmFtZTogdGFyZ2V0LmdldEF0dHJpYnV0ZSgnY2xhc3MnKSxcclxuICAgICAgICB4OiBib3VuZHMueCxcclxuICAgICAgICB5OiBib3VuZHMueSxcclxuICAgICAgICB3aWR0aDogYm91bmRzLndpZHRoLFxyXG4gICAgICAgIGhlaWdodDogYm91bmRzLmhlaWdodCxcclxuICAgICAgICByaWdodDogYm91bmRzLnJpZ2h0LFxyXG4gICAgICAgIGJvdHRvbTogYm91bmRzLmJvdHRvbSxcclxuICAgICAgICBvdmVyZmxvd1k6IHN0eWxlLm92ZXJmbG93WSxcclxuICAgICAgICBjbGllbnRXaWR0aDogdGFyZ2V0LmNsaWVudFdpZHRoLFxyXG4gICAgICAgIHNjcm9sbFdpZHRoOiB0YXJnZXQuc2Nyb2xsV2lkdGgsXHJcbiAgICAgICAgY2xpZW50SGVpZ2h0OiB0YXJnZXQuY2xpZW50SGVpZ2h0LFxyXG4gICAgICAgIHNjcm9sbEhlaWdodDogdGFyZ2V0LnNjcm9sbEhlaWdodCxcclxuICAgICAgICBzY3JvbGxUb3A6IHRhcmdldC5zY3JvbGxUb3AsXHJcbiAgICAgICAgZGlzcGxheTogc3R5bGUuZGlzcGxheSxcclxuICAgICAgICBjb21wdXRlZEhlaWdodDogc3R5bGUuaGVpZ2h0LFxyXG4gICAgICAgIG1pbkhlaWdodDogc3R5bGUubWluSGVpZ2h0LFxyXG4gICAgICAgIGdyaWRSb3dzOiBzdHlsZS5ncmlkVGVtcGxhdGVSb3dzLFxyXG4gICAgICAgIHBvc2l0aW9uOiBzdHlsZS5wb3NpdGlvbixcclxuICAgICAgICBhbGlnbkl0ZW1zOiBzdHlsZS5hbGlnbkl0ZW1zLFxyXG4gICAgICAgIGp1c3RpZnlDb250ZW50OiBzdHlsZS5qdXN0aWZ5Q29udGVudCxcclxuICAgICAgfTtcclxuICAgIH07XHJcbiAgICBjb25zdCBib2R5ID0gZWxlbWVudC5xdWVyeVNlbGVjdG9yKCcubm9kZS1xdWljay1lZGl0b3ItcmVjcmVhdGlvbi1ib2R5Jyk7XHJcbiAgICBjb25zdCBhbmFseXNpcyA9IGVsZW1lbnQucXVlcnlTZWxlY3RvcihcclxuICAgICAgJy52aWRlby1yZWNyZWF0aW9uLWFuYWx5c2lzLWNvbHVtbiwgLm5vZGUtcXVpY2stZWRpdG9yLXJlY3JlYXRpb24tc291cmNlJyxcclxuICAgICk7XHJcbiAgICBjb25zdCByZXNvdXJjZXMgPSBlbGVtZW50LnF1ZXJ5U2VsZWN0b3IoXHJcbiAgICAgICcudmlkZW8tcmVjcmVhdGlvbi1yZXNvdXJjZXMtY29sdW1uLCAubm9kZS1xdWljay1lZGl0b3ItcmVjcmVhdGlvbi1wZW5kaW5nJyxcclxuICAgICk7XHJcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gZWxlbWVudC5xdWVyeVNlbGVjdG9yKCcubm9kZS1xdWljay1lZGl0b3ItcmVjcmVhdGlvbi1nZW5lcmF0ZScpO1xyXG4gICAgY29uc3QgcGFuZWwgPSBlbGVtZW50LnF1ZXJ5U2VsZWN0b3IoJy52aWRlby1yZWNyZWF0aW9uLXBhbmVsJyk7XHJcbiAgICBjb25zdCBzb3VyY2VJbmZvID0gZWxlbWVudC5xdWVyeVNlbGVjdG9yKCcudmlkZW8tcmVjcmVhdGlvbi1zb3VyY2UtbWV0YScpO1xyXG4gICAgaWYgKCFib2R5IHx8ICFhbmFseXNpcyB8fCAhcmVzb3VyY2VzIHx8ICFnZW5lcmF0aW9uKVxyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WkjeWIuyBEaWFsb2cg57y65bCR5YiG5p6Q44CB5pu/5o2i5oiW55Sf5oiQ5qCPJyk7XHJcbiAgICBjb25zdCB3cmFwcGVycyA9IFtdO1xyXG4gICAgZm9yIChcclxuICAgICAgbGV0IHdyYXBwZXIgPSBib2R5LnBhcmVudEVsZW1lbnQ7XHJcbiAgICAgIHdyYXBwZXIgJiYgd3JhcHBlciAhPT0gZWxlbWVudDtcclxuICAgICAgd3JhcHBlciA9IHdyYXBwZXIucGFyZW50RWxlbWVudFxyXG4gICAgKVxyXG4gICAgICB3cmFwcGVycy5wdXNoKG1lYXN1cmUod3JhcHBlcikpO1xyXG4gICAgY29uc3Qgb3ZlcmxheSA9IGVsZW1lbnQuY2xvc2VzdCgnLmFudC1tb2RhbC13cmFwJyk7XHJcbiAgICBjb25zdCBiZWZvcmUgPSBvdmVybGF5ID8gZ2V0Q29tcHV0ZWRTdHlsZShvdmVybGF5LCAnOjpiZWZvcmUnKSA6IG51bGw7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBkaWFsb2c6IG1lYXN1cmUoZWxlbWVudCksXHJcbiAgICAgIG92ZXJsYXk6IG92ZXJsYXkgPyBtZWFzdXJlKG92ZXJsYXkpIDogbnVsbCxcclxuICAgICAgb3ZlcmxheUJlZm9yZTogYmVmb3JlXHJcbiAgICAgICAgPyB7XHJcbiAgICAgICAgICAgIGRpc3BsYXk6IGJlZm9yZS5kaXNwbGF5LFxyXG4gICAgICAgICAgICBoZWlnaHQ6IGJlZm9yZS5oZWlnaHQsXHJcbiAgICAgICAgICAgIHdpZHRoOiBiZWZvcmUud2lkdGgsXHJcbiAgICAgICAgICAgIGNvbnRlbnQ6IGJlZm9yZS5jb250ZW50LFxyXG4gICAgICAgICAgfVxyXG4gICAgICAgIDogbnVsbCxcclxuICAgICAgd3JhcHBlcnMsXHJcbiAgICAgIGJvZHk6IG1lYXN1cmUoYm9keSksXHJcbiAgICAgIHBhbmVsOiBwYW5lbCA/IG1lYXN1cmUocGFuZWwpIDogbnVsbCxcclxuICAgICAgc291cmNlSW5mbzogc291cmNlSW5mb1xyXG4gICAgICAgID8ge1xyXG4gICAgICAgICAgICAuLi5tZWFzdXJlKHNvdXJjZUluZm8pLFxyXG4gICAgICAgICAgICBmaWVsZHM6IEFycmF5LmZyb20oc291cmNlSW5mby5jaGlsZHJlbiwgKGZpZWxkKSA9PiAoe1xyXG4gICAgICAgICAgICAgIC4uLm1lYXN1cmUoZmllbGQpLFxyXG4gICAgICAgICAgICAgIHRleHQ6IGZpZWxkLnRleHRDb250ZW50LFxyXG4gICAgICAgICAgICAgIHRleHRPdmVyZmxvdzogZ2V0Q29tcHV0ZWRTdHlsZShmaWVsZCkudGV4dE92ZXJmbG93LFxyXG4gICAgICAgICAgICB9KSksXHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgOiBudWxsLFxyXG4gICAgICBncmlkQ29sdW1uczogZ2V0Q29tcHV0ZWRTdHlsZShib2R5KS5ncmlkVGVtcGxhdGVDb2x1bW5zLFxyXG4gICAgICBncmlkUm93czogZ2V0Q29tcHV0ZWRTdHlsZShib2R5KS5ncmlkVGVtcGxhdGVSb3dzLFxyXG4gICAgICBjb2x1bW5zOiBbYW5hbHlzaXMsIHJlc291cmNlcywgZ2VuZXJhdGlvbl0ubWFwKG1lYXN1cmUpLFxyXG4gICAgfTtcclxuICB9KTtcclxuICBjb25zdCBsYXlvdXRQYXRoID0gdGVzdFxyXG4gICAgLmluZm8oKVxyXG4gICAgLm91dHB1dFBhdGgobGF5b3V0LnBhbmVsID8gJ3JlY3JlYXRpb24tYm91bmQtbGF5b3V0Lmpzb24nIDogJ3JlY3JlYXRpb24tZHJhZnQtbGF5b3V0Lmpzb24nKTtcclxuICB3cml0ZUZpbGVTeW5jKGxheW91dFBhdGgsIEpTT04uc3RyaW5naWZ5KHsgdmlld3BvcnQsIC4uLmxheW91dCB9LCBudWxsLCAyKSk7XHJcbiAgYXdhaXQgdGVzdC5pbmZvKCkuYXR0YWNoKCflpI3liLvkuInmoI/mtYvph48nLCB7XHJcbiAgICBwYXRoOiBsYXlvdXRQYXRoLFxyXG4gICAgY29udGVudFR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJyxcclxuICB9KTtcclxuICBhd2FpdCBleHBlY3QoZGlhbG9nKS50b0JlSW5WaWV3cG9ydCh7IHJhdGlvOiAxIC0gMWUtNiB9KTtcclxuICBleHBlY3QobGF5b3V0LmRpYWxvZy53aWR0aCkudG9CZUNsb3NlVG8odmlld3BvcnQud2lkdGggKiAwLjc1LCAwKTtcclxuICBleHBlY3QobGF5b3V0LmRpYWxvZy5oZWlnaHQpLnRvQmVDbG9zZVRvKHZpZXdwb3J0LmhlaWdodCAqIDAuNzUsIDApO1xyXG4gIGV4cGVjdChsYXlvdXQuZGlhbG9nLngpLnRvQmVDbG9zZVRvKHZpZXdwb3J0LndpZHRoICogMC4xMjUsIDApO1xyXG4gIGV4cGVjdChsYXlvdXQuZGlhbG9nLnkpLnRvQmVDbG9zZVRvKHZpZXdwb3J0LmhlaWdodCAqIDAuMTI1LCAwKTtcclxuICBleHBlY3QobGF5b3V0LmdyaWRDb2x1bW5zLnNwbGl0KCcgJykpLnRvSGF2ZUxlbmd0aCgzKTtcclxuICBleHBlY3QobGF5b3V0LmRpYWxvZy5zY3JvbGxIZWlnaHQpLnRvQmVMZXNzVGhhbk9yRXF1YWwobGF5b3V0LmRpYWxvZy5jbGllbnRIZWlnaHQgKyAxKTtcclxuICBmb3IgKGNvbnN0IFtpbmRleCwgY29sdW1uXSBvZiBsYXlvdXQuY29sdW1ucy5lbnRyaWVzKCkpIHtcclxuICAgIGV4cGVjdChjb2x1bW4ud2lkdGgpLnRvQmVHcmVhdGVyVGhhbigyMDApO1xyXG4gICAgZXhwZWN0KGNvbHVtbi54KS50b0JlR3JlYXRlclRoYW4obGF5b3V0LmRpYWxvZy54KTtcclxuICAgIGV4cGVjdChjb2x1bW4ucmlnaHQpLnRvQmVMZXNzVGhhbihsYXlvdXQuZGlhbG9nLnJpZ2h0KTtcclxuICAgIGV4cGVjdChjb2x1bW4uYm90dG9tKS50b0JlTGVzc1RoYW4obGF5b3V0LmRpYWxvZy5ib3R0b20pO1xyXG4gICAgZXhwZWN0KGNvbHVtbi5zY3JvbGxXaWR0aCkudG9CZUxlc3NUaGFuT3JFcXVhbChjb2x1bW4uY2xpZW50V2lkdGggKyAxKTtcclxuICAgIGV4cGVjdChjb2x1bW4ub3ZlcmZsb3dZKS50b0JlKCdhdXRvJyk7XHJcbiAgICBleHBlY3QoY29sdW1uLnkpLnRvQmVDbG9zZVRvKGxheW91dC5jb2x1bW5zWzBdIS55LCAwKTtcclxuICAgIGV4cGVjdChjb2x1bW4uaGVpZ2h0KS50b0JlQ2xvc2VUbyhsYXlvdXQuY29sdW1uc1swXSEuaGVpZ2h0LCAwKTtcclxuICAgIGlmIChpbmRleCA+IDApIGV4cGVjdChjb2x1bW4ueCkudG9CZUdyZWF0ZXJUaGFuKGxheW91dC5jb2x1bW5zW2luZGV4IC0gMV0hLnJpZ2h0KTtcclxuICB9XHJcbiAgaWYgKGxheW91dC5wYW5lbCkge1xyXG4gICAgZXhwZWN0KGxheW91dC5zb3VyY2VJbmZvKS5ub3QudG9CZU51bGwoKTtcclxuICAgIGNvbnN0IHNvdXJjZUluZm8gPSBsYXlvdXQuc291cmNlSW5mbyE7XHJcbiAgICBleHBlY3Qoc291cmNlSW5mby5maWVsZHMpLnRvSGF2ZUxlbmd0aCgzKTtcclxuICAgIGV4cGVjdChzb3VyY2VJbmZvLmZpZWxkc1swXSEudGV4dCkudG9NYXRjaCgvXuadpea6kO+8mih2XFxkK3zniYjmnKzmnKrnn6UpJC8pO1xyXG4gICAgZXhwZWN0KHNvdXJjZUluZm8uZmllbGRzWzFdIS50ZXh0KS50b01hdGNoKC9e5pe26ZW/77yaLyk7XHJcbiAgICBleHBlY3Qoc291cmNlSW5mby5maWVsZHNbMl0hLnRleHQpLnRvTWF0Y2goL17mlofku7bvvJovKTtcclxuICAgIGV4cGVjdChzb3VyY2VJbmZvLmZpZWxkc1syXSEudGV4dE92ZXJmbG93KS50b0JlKCdlbGxpcHNpcycpO1xyXG4gICAgZXhwZWN0KHNvdXJjZUluZm8uc2Nyb2xsV2lkdGgpLnRvQmVMZXNzVGhhbk9yRXF1YWwoc291cmNlSW5mby5jbGllbnRXaWR0aCArIDEpO1xyXG4gICAgZm9yIChjb25zdCBmaWVsZCBvZiBzb3VyY2VJbmZvLmZpZWxkcykge1xyXG4gICAgICBleHBlY3QoZmllbGQud2lkdGgpLnRvQmVHcmVhdGVyVGhhbigwKTtcclxuICAgICAgZXhwZWN0KGZpZWxkLnkpLnRvQmVDbG9zZVRvKHNvdXJjZUluZm8uZmllbGRzWzBdIS55LCAwKTtcclxuICAgICAgZXhwZWN0KGZpZWxkLngpLnRvQmVHcmVhdGVyVGhhbk9yRXF1YWwoc291cmNlSW5mby54KTtcclxuICAgICAgZXhwZWN0KGZpZWxkLnJpZ2h0KS50b0JlTGVzc1RoYW5PckVxdWFsKHNvdXJjZUluZm8ucmlnaHQgKyAxKTtcclxuICAgIH1cclxuICB9XHJcbiAgY29uc3QgY29udHJvbHMgPSBhd2FpdCBkaWFsb2cuZXZhbHVhdGUoKGVsZW1lbnQpID0+IHtcclxuICAgIGNvbnN0IG1vZGVsID0gZWxlbWVudC5xdWVyeVNlbGVjdG9yKCcubm9kZS1xdWljay1lZGl0b3Itc2V0dGluZ3MgLm5vZGUtcGFyYW1ldGVyLXNlbGVjdCcpO1xyXG4gICAgY29uc3QgcGFyYW1ldGVycyA9IGVsZW1lbnQucXVlcnlTZWxlY3RvcihcclxuICAgICAgJy5ub2RlLXF1aWNrLWVkaXRvci1zZXR0aW5ncyAubm9kZS1xdWljay1lZGl0b3Itc3VtbWFyeS1idXR0b24nLFxyXG4gICAgKTtcclxuICAgIGlmICghbW9kZWwgfHwgIXBhcmFtZXRlcnMpIHRocm93IG5ldyBFcnJvcign5Y+z5qCP57y65bCR5qih5Z6L5oiW6KeG6aKR5Y+C5pWw5YWl5Y+jJyk7XHJcbiAgICBjb25zdCBtb2RlbEJvdW5kcyA9IG1vZGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgY29uc3QgcGFyYW1ldGVyQm91bmRzID0gcGFyYW1ldGVycy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgIG1vZGVsQ2VudGVyWTogbW9kZWxCb3VuZHMueSArIG1vZGVsQm91bmRzLmhlaWdodCAvIDIsXHJcbiAgICAgIHBhcmFtZXRlckNlbnRlclk6IHBhcmFtZXRlckJvdW5kcy55ICsgcGFyYW1ldGVyQm91bmRzLmhlaWdodCAvIDIsXHJcbiAgICAgIG1vZGVsUmlnaHQ6IG1vZGVsQm91bmRzLnJpZ2h0LFxyXG4gICAgICBwYXJhbWV0ZXJMZWZ0OiBwYXJhbWV0ZXJCb3VuZHMubGVmdCxcclxuICAgIH07XHJcbiAgfSk7XHJcbiAgZXhwZWN0KGNvbnRyb2xzLm1vZGVsQ2VudGVyWSkudG9CZUNsb3NlVG8oY29udHJvbHMucGFyYW1ldGVyQ2VudGVyWSwgMCk7XHJcbiAgZXhwZWN0KGNvbnRyb2xzLm1vZGVsUmlnaHQpLnRvQmVMZXNzVGhhbihjb250cm9scy5wYXJhbWV0ZXJMZWZ0KTtcclxuICByZXR1cm4gbGF5b3V0O1xyXG59XHJcblxyXG4vKipcclxuICog5qC45a+55Zy65pmv5a6M5pW05bin5LiO5Zub5byg5a+56LGh5oiq5Zu+77yM6buR5Zu+44CB6YeN5aSN5Y2g5L2N5Zu+5oiW5b+955Wl6KOB5Ymq5pe25aSx6LSl44CCXHJcbiAqIEBwYXJhbSBwYW5lbCDlvZPliY3lj6/kuqTkupLnmoTlpI3liLvljLrln5/vvJvmiKrlm77ml7bpl7TlnYfkvY3kuo7ku5PlupPmvJTnpLrop4bpopHnmoTnnJ/lrp7ml7bplb/lhoXjgIJcclxuICogQHJldHVybnMg5q+P5byg5Zu+54mH55qE5YOP57Sg5bC65a+45ZKM6aKc6Imy6IyD5Zu077yM55So5LqO6ZmE5Yqg5rWP6KeI5Zmo6aqM5pS26K+B5o2u44CCXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBleHBlY3RTb3VyY2VQcmV2aWV3cyhwYW5lbDogTG9jYXRvcikge1xyXG4gIGNvbnN0IG9iamVjdHMgPSBbLi4uaWRlbnRpZmllZFRlbXBsYXRlLnJvbGVzLCAuLi5pZGVudGlmaWVkVGVtcGxhdGUucHJvZHVjdHMhXTtcclxuICBhd2FpdCBleHBlY3QocGFuZWwubG9jYXRvcignLnZpZGVvLXJlY3JlYXRpb24tb2JqZWN0JykpLnRvSGF2ZUNvdW50KG9iamVjdHMubGVuZ3RoKTtcclxuICBhd2FpdCBleHBlY3QoXHJcbiAgICBwYW5lbC5sb2NhdG9yKCcudmlkZW8tcmVjcmVhdGlvbi1vYmplY3QgLnZpZGVvLXJlY3JlYXRpb24tcHJldmlldy1pbWFnZScpLFxyXG4gICkudG9IYXZlQ291bnQob2JqZWN0cy5sZW5ndGgpO1xyXG4gIGNvbnN0IHNjZW5lID0gcGFuZWwuZ2V0QnlSb2xlKCdpbWcnLCB7IG5hbWU6ICfljp/op4bpopHlnLrmma/nmoTljp/op4bpopHnlLvpnaInLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBleHBlY3Qoc2NlbmUpLnRvQmVWaXNpYmxlKHsgdGltZW91dDogMTUwMDAgfSk7XHJcbiAgYXdhaXQgZXhwZWN0KHNjZW5lLmxvY2F0b3IoJ3hwYXRoPWFuY2VzdG9yOjpmaWd1cmVbMV0nKSkudG9IYXZlQXR0cmlidXRlKFxyXG4gICAgJ2RhdGEtdGltZXN0YW1wLXNlY29uZHMnLFxyXG4gICAgJzAnLFxyXG4gICk7XHJcbiAgYXdhaXQgZXhwZWN0KHNjZW5lLmxvY2F0b3IoJ3hwYXRoPWFuY2VzdG9yOjpmaWd1cmVbMV0nKSkudG9IYXZlQXR0cmlidXRlKCdkYXRhLWNyb3BwZWQnLCAnZmFsc2UnKTtcclxuICBhd2FpdCBzY2VuZS5ldmFsdWF0ZSgoZWxlbWVudCkgPT4gKGVsZW1lbnQgYXMgSFRNTEltYWdlRWxlbWVudCkuZGVjb2RlKCkpO1xyXG4gIGNvbnN0IHNjZW5lTGF5b3V0ID0gYXdhaXQgcGFuZWwubG9jYXRvcignLnZpZGVvLXJlY3JlYXRpb24tc2NlbmVzJykuZXZhbHVhdGUoKGVsZW1lbnQpID0+IHtcclxuICAgIGNvbnN0IGNvbHVtbnMgPSBnZXRDb21wdXRlZFN0eWxlKGVsZW1lbnQpLmdyaWRUZW1wbGF0ZUNvbHVtbnMuc3BsaXQoJyAnKS5sZW5ndGg7XHJcbiAgICBjb25zdCBuYW1lID0gZWxlbWVudC5xdWVyeVNlbGVjdG9yKCdoNCcpPy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgIGNvbnN0IGZyYW1lID0gZWxlbWVudC5xdWVyeVNlbGVjdG9yKCdmaWd1cmUnKT8uZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICBjb25zdCBoaW50ID0gZWxlbWVudC5xdWVyeVNlbGVjdG9yKCdwJyk/LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgaWYgKCFuYW1lIHx8ICFmcmFtZSB8fCAhaGludCkgdGhyb3cgbmV3IEVycm9yKCflnLrmma/nvLrlsJHlkI3np7DjgIHnvKnnlaXlm77miJbor7TmmI4nKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgIGNvbHVtbnMsXHJcbiAgICAgIGhlaWdodDogZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS5oZWlnaHQsXHJcbiAgICAgIG5hbWVSaWdodDogbmFtZS5yaWdodCxcclxuICAgICAgZnJhbWVMZWZ0OiBmcmFtZS5sZWZ0LFxyXG4gICAgICBmcmFtZVJpZ2h0OiBmcmFtZS5yaWdodCxcclxuICAgICAgaGludExlZnQ6IGhpbnQubGVmdCxcclxuICAgIH07XHJcbiAgfSk7XHJcbiAgZXhwZWN0KHNjZW5lTGF5b3V0LmNvbHVtbnMpLnRvQmUoMyk7XHJcbiAgZXhwZWN0KHNjZW5lTGF5b3V0LmhlaWdodCkudG9CZUxlc3NUaGFuT3JFcXVhbCgxMzApO1xyXG4gIGV4cGVjdChzY2VuZUxheW91dC5uYW1lUmlnaHQpLnRvQmVMZXNzVGhhbk9yRXF1YWwoc2NlbmVMYXlvdXQuZnJhbWVMZWZ0ICsgMSk7XHJcbiAgZXhwZWN0KHNjZW5lTGF5b3V0LmZyYW1lUmlnaHQpLnRvQmVMZXNzVGhhbk9yRXF1YWwoc2NlbmVMYXlvdXQuaGludExlZnQgKyAxKTtcclxuICBjb25zdCBtZWFzdXJlbWVudHMgPSBbXTtcclxuICBmb3IgKGNvbnN0IG9iamVjdCBvZiBvYmplY3RzKSB7XHJcbiAgICBjb25zdCBwcmV2aWV3ID0gcGFuZWwuZ2V0QnlSb2xlKCdpbWcnLCB7IG5hbWU6IG9iamVjdC5sYWJlbCArICfnmoTljp/op4bpopHnlLvpnaInLCBleGFjdDogdHJ1ZSB9KTtcclxuICAgIGF3YWl0IGV4cGVjdChwcmV2aWV3KS50b0JlVmlzaWJsZSh7IHRpbWVvdXQ6IDE1MDAwIH0pO1xyXG4gICAgY29uc3Qgb2JqZWN0TGF5b3V0ID0gYXdhaXQgcHJldmlldy5sb2NhdG9yKCd4cGF0aD1hbmNlc3Rvcjo6YXJ0aWNsZVsxXScpLmV2YWx1YXRlKChhcnRpY2xlKSA9PiB7XHJcbiAgICAgIGNvbnN0IG5hbWUgPSBhcnRpY2xlLnF1ZXJ5U2VsZWN0b3IoJ2g0Jyk/LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgICBjb25zdCBmcmFtZSA9IGFydGljbGUucXVlcnlTZWxlY3RvcignLnZpZGVvLXJlY3JlYXRpb24tcHJldmlldycpPy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgY29uc3QgcmVzb3VyY2UgPSBhcnRpY2xlXHJcbiAgICAgICAgLnF1ZXJ5U2VsZWN0b3IoJy52aWRlby1yZWNyZWF0aW9uLW9iamVjdC1yZXNvdXJjZScpXHJcbiAgICAgICAgPy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgaWYgKCFuYW1lIHx8ICFmcmFtZSB8fCAhcmVzb3VyY2UpIHRocm93IG5ldyBFcnJvcign5a+56LGh57y65bCR5ZCN56ew44CB5Y6f6KeG6aKR5Zu+5oiW6LWE5rqQ5pON5L2cJyk7XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgbmFtZVJpZ2h0OiBuYW1lLnJpZ2h0LFxyXG4gICAgICAgIGZyYW1lTGVmdDogZnJhbWUubGVmdCxcclxuICAgICAgICBmcmFtZVJpZ2h0OiBmcmFtZS5yaWdodCxcclxuICAgICAgICByZXNvdXJjZUxlZnQ6IHJlc291cmNlLmxlZnQsXHJcbiAgICAgICAgY29sdW1uczogZ2V0Q29tcHV0ZWRTdHlsZShhcnRpY2xlKS5ncmlkVGVtcGxhdGVDb2x1bW5zLnNwbGl0KCcgJykubGVuZ3RoLFxyXG4gICAgICAgIGhlaWdodDogYXJ0aWNsZS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS5oZWlnaHQsXHJcbiAgICAgICAgYm91bmRlZDogYXJ0aWNsZS5zY3JvbGxXaWR0aCA8PSBhcnRpY2xlLmNsaWVudFdpZHRoICsgMSxcclxuICAgICAgfTtcclxuICAgIH0pO1xyXG4gICAgZXhwZWN0KG9iamVjdExheW91dC5jb2x1bW5zLCBvYmplY3QubGFiZWwgKyAn5LiJ5q615bqU5Zyo5ZCM5LiA5qiq5o6SJykudG9CZSgzKTtcclxuICAgIGV4cGVjdChvYmplY3RMYXlvdXQuaGVpZ2h0LCBvYmplY3QubGFiZWwgKyAn5Y2V6aG55pyA6auYIDEzMHB4JykudG9CZUxlc3NUaGFuT3JFcXVhbCgxMzApO1xyXG4gICAgZXhwZWN0KG9iamVjdExheW91dC5uYW1lUmlnaHQpLnRvQmVMZXNzVGhhbk9yRXF1YWwob2JqZWN0TGF5b3V0LmZyYW1lTGVmdCArIDEpO1xyXG4gICAgZXhwZWN0KG9iamVjdExheW91dC5mcmFtZVJpZ2h0KS50b0JlTGVzc1RoYW5PckVxdWFsKG9iamVjdExheW91dC5yZXNvdXJjZUxlZnQgKyAxKTtcclxuICAgIGV4cGVjdChvYmplY3RMYXlvdXQuYm91bmRlZCkudG9CZSh0cnVlKTtcclxuICAgIGNvbnN0IGZpZ3VyZSA9IHByZXZpZXcubG9jYXRvcigneHBhdGg9YW5jZXN0b3I6OmZpZ3VyZVsxXScpO1xyXG4gICAgYXdhaXQgZXhwZWN0KGZpZ3VyZSkudG9IYXZlQXR0cmlidXRlKFxyXG4gICAgICAnZGF0YS10aW1lc3RhbXAtc2Vjb25kcycsXHJcbiAgICAgIFN0cmluZyhvYmplY3QucHJldmlldyEudGltZXN0YW1wU2Vjb25kcyksXHJcbiAgICApO1xyXG4gICAgYXdhaXQgZXhwZWN0KGZpZ3VyZSkudG9IYXZlQXR0cmlidXRlKCdkYXRhLWNyb3BwZWQnLCAndHJ1ZScpO1xyXG4gICAgYXdhaXQgZXhwZWN0KGZpZ3VyZSkudG9Db250YWluVGV4dCgn5bGA6YOo6KOB5YmqJyk7XHJcbiAgICBjb25zdCBwaXhlbHMgPSBhd2FpdCBwcmV2aWV3LmV2YWx1YXRlKGFzeW5jIChlbGVtZW50KSA9PiB7XHJcbiAgICAgIGNvbnN0IGltYWdlID0gZWxlbWVudCBhcyBIVE1MSW1hZ2VFbGVtZW50O1xyXG4gICAgICBhd2FpdCBpbWFnZS5kZWNvZGUoKTtcclxuICAgICAgY29uc3QgY2FudmFzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XHJcbiAgICAgIGNhbnZhcy53aWR0aCA9IGNhbnZhcy5oZWlnaHQgPSAzMjtcclxuICAgICAgY29uc3QgY29udGV4dCA9IGNhbnZhcy5nZXRDb250ZXh0KCcyZCcpO1xyXG4gICAgICBpZiAoIWNvbnRleHQpIHRocm93IG5ldyBFcnJvcign5rWP6KeI5Zmo5LiN6IO96K+75Y+W5p2l5rqQ5oiq5Zu+5YOP57SgJyk7XHJcbiAgICAgIGNvbnRleHQuZHJhd0ltYWdlKGltYWdlLCAwLCAwLCAzMiwgMzIpO1xyXG4gICAgICBjb25zdCBjb2xvcnMgPSBjb250ZXh0LmdldEltYWdlRGF0YSgwLCAwLCAzMiwgMzIpLmRhdGEuZmlsdGVyKChfLCBpbmRleCkgPT4gaW5kZXggJSA0ICE9PSAzKTtcclxuICAgICAgcmV0dXJuIHtcclxuICAgICAgICB3aWR0aDogaW1hZ2UubmF0dXJhbFdpZHRoLFxyXG4gICAgICAgIGhlaWdodDogaW1hZ2UubmF0dXJhbEhlaWdodCxcclxuICAgICAgICBtaW5pbXVtOiBNYXRoLm1pbiguLi5jb2xvcnMpLFxyXG4gICAgICAgIG1heGltdW06IE1hdGgubWF4KC4uLmNvbG9ycyksXHJcbiAgICAgIH07XHJcbiAgICB9KTtcclxuICAgIGV4cGVjdChwaXhlbHMud2lkdGgpLnRvQmVHcmVhdGVyVGhhbigwKTtcclxuICAgIGV4cGVjdChwaXhlbHMuaGVpZ2h0KS50b0JlR3JlYXRlclRoYW4oMCk7XHJcbiAgICBleHBlY3QocGl4ZWxzLm1heGltdW0gLSBwaXhlbHMubWluaW11bSwgb2JqZWN0LmxhYmVsICsgJ+aIquWbvuS4jeiDveaYr+epuueZveWNoOS9jeWbvicpLnRvQmVHcmVhdGVyVGhhbihcclxuICAgICAgMjAsXHJcbiAgICApO1xyXG4gICAgbWVhc3VyZW1lbnRzLnB1c2goeyBsYWJlbDogb2JqZWN0LmxhYmVsLCAuLi5waXhlbHMgfSk7XHJcbiAgfVxyXG4gIGNvbnN0IHNvdXJjZVJhdGlvcyA9IG1lYXN1cmVtZW50cy5tYXAoKG1lYXN1cmVtZW50LCBpbmRleCkgPT4ge1xyXG4gICAgY29uc3QgYm94ID0gb2JqZWN0c1tpbmRleF0hLnByZXZpZXchLmJvdW5kaW5nQm94ITtcclxuICAgIHJldHVybiAobWVhc3VyZW1lbnQud2lkdGggLyBtZWFzdXJlbWVudC5oZWlnaHQgLyBib3gud2lkdGgpICogYm94LmhlaWdodDtcclxuICB9KTtcclxuICBmb3IgKGNvbnN0IHJhdGlvIG9mIHNvdXJjZVJhdGlvcykgZXhwZWN0KHJhdGlvKS50b0JlQ2xvc2VUbyhzb3VyY2VSYXRpb3NbMF0hLCAxKTtcclxuICByZXR1cm4gbWVhc3VyZW1lbnRzO1xyXG59XHJcblxyXG5mb3IgKGNvbnN0IHZpZXdwb3J0IG9mIFtcclxuICB7IHdpZHRoOiAxNDQwLCBoZWlnaHQ6IDEwMDAgfSxcclxuICB7IHdpZHRoOiAxMzY2LCBoZWlnaHQ6IDc2OCB9LFxyXG5dKSB7XHJcbiAgdGVzdChcclxuICAgICdQQyAnICtcclxuICAgICAgdmlld3BvcnQud2lkdGggK1xyXG4gICAgICAnw5cnICtcclxuICAgICAgdmlld3BvcnQuaGVpZ2h0ICtcclxuICAgICAgJyDlt6XlhbfmoI/lu7rojYnnqL/jgIHoioLngrnkuJPnlKjkuInmoI8gRGlhbG9nIOWSjOaYjuehruWIhuaekOeUn+aIkCcsXHJcbiAgICBhc3luYyAoeyBwYWdlIH0sIGluZm8pID0+IHtcclxuICAgICAgYXdhaXQgcGFnZS5zZXRWaWV3cG9ydFNpemUodmlld3BvcnQpO1xyXG4gICAgICBjb25zdCBjdHggPSBhd2FpdCBmaXh0dXJlKHBhZ2UpO1xyXG4gICAgICBhd2FpdCBwYWdlLmdvdG8oJy9wcm9qZWN0cy8nICsgcHJvamVjdC5pZCk7XHJcbiAgICAgIGNvbnN0IHNvdXJjZSA9IHBhZ2UubG9jYXRvcignLnJlYWN0LWZsb3dfX25vZGVbZGF0YS1pZD1cInNvdXJjZS12aWRlb1wiXScpO1xyXG4gICAgICBhd2FpdCBleHBlY3Qoc291cmNlKS50b0JlVmlzaWJsZSh7IHRpbWVvdXQ6IDE1MDAwIH0pO1xyXG4gICAgICBjb25zdCBzb3VyY2VCZWZvcmUgPSBzdHJ1Y3R1cmVkQ2xvbmUoY3R4LmNhbnZhcygpLm5vZGVzWzBdISk7XHJcbiAgICAgIGF3YWl0IHBhZ2UubW91c2UubW92ZSgwLCAwKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KHNvdXJjZSkubm90LnRvSGF2ZUNsYXNzKC9cXGJzZWxlY3RlZFxcYi8pO1xyXG4gICAgICBleHBlY3QoYXdhaXQgc291cmNlLmV2YWx1YXRlKChlbGVtZW50KSA9PiBlbGVtZW50Lm1hdGNoZXMoJzpob3ZlcicpKSkudG9CZShmYWxzZSk7XHJcbiAgICAgIGNvbnN0IGVudHJ5ID0gcGFnZVxyXG4gICAgICAgIC5nZXRCeVJvbGUoJ2dyb3VwJywgeyBuYW1lOiAn6IqC54K557uEJywgZXhhY3Q6IHRydWUgfSlcclxuICAgICAgICAuZ2V0QnlSb2xlKCdidXR0b24nLCB7IG5hbWU6ICfnn63op4bpopHlpI3liLsnLCBleGFjdDogdHJ1ZSB9KTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGVudHJ5KS50b0JlVmlzaWJsZSgpO1xyXG4gICAgICBhd2FpdCBleHBlY3QoZW50cnkpLnRvQmVJblZpZXdwb3J0KHsgcmF0aW86IDEgfSk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChlbnRyeSkudG9IYXZlVGV4dCgnJyk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChlbnRyeSkudG9IYXZlQXR0cmlidXRlKCd0aXRsZScsICfmlrDlu7rnn63op4bpopHlpI3liLvoioLngrknKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGVudHJ5LmxvY2F0b3IoJ3N2Zy5sdWNpZGUtY2xhcHBlcmJvYXJkJykpLnRvQmVWaXNpYmxlKCk7XHJcbiAgICAgIGV4cGVjdChhd2FpdCBlbnRyeS5ldmFsdWF0ZSgoZWxlbWVudCkgPT4gZWxlbWVudC5tYXRjaGVzKCc6aG92ZXInKSkpLnRvQmUoZmFsc2UpO1xyXG4gICAgICBhd2FpdCBleHBlY3QoXHJcbiAgICAgICAgcGFnZS5nZXRCeVJvbGUoJ2dyb3VwJywgeyBuYW1lOiAn5Yib5bu66IqC54K5JywgZXhhY3Q6IHRydWUgfSkuZ2V0QnlSb2xlKCdidXR0b24nKSxcclxuICAgICAgKS50b0hhdmVDb3VudCg0KTtcclxuICAgICAgZXhwZWN0KGN0eC5wb3N0UGF0aHMpLnRvRXF1YWwoW10pO1xyXG4gICAgICBhd2FpdCBwYWdlLnNjcmVlbnNob3QoeyBwYXRoOiBpbmZvLm91dHB1dFBhdGgoJ3JlY3JlYXRpb24tZW50cnkucG5nJyksIGZ1bGxQYWdlOiB0cnVlIH0pO1xyXG5cclxuICAgICAgYXdhaXQgZW50cnkuY2xpY2soKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KHBhZ2UuZ2V0QnlSb2xlKCdkaWFsb2cnKSkudG9IYXZlQ291bnQoMCk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJy5ub2RlLXF1aWNrLWVkaXRvcicpKS50b0hhdmVDb3VudCgwKTtcclxuICAgICAgYXdhaXQgZXhwZWN0LnBvbGwoKCkgPT4gY3R4LmNhbnZhcygpLm5vZGVzLmxlbmd0aCkudG9CZSgyKTtcclxuICAgICAgY29uc3QgZHJhZnQgPSBjdHguY2FudmFzKCkubm9kZXMuZmluZCgoaXRlbSkgPT4gaXRlbS5kYXRhLnZpZGVvUmVjcmVhdGlvbkRyYWZ0KSE7XHJcbiAgICAgIGV4cGVjdChkcmFmdC5kYXRhLnZpZGVvUmVjcmVhdGlvbikudG9CZVVuZGVmaW5lZCgpO1xyXG4gICAgICBleHBlY3QoZHJhZnQuZGF0YS5tb2RlKS50b0JlKCdnZW5lcmF0ZScpO1xyXG4gICAgICBjb25zdCBub2RlID0gcGFnZS5sb2NhdG9yKCcucmVhY3QtZmxvd19fbm9kZVtkYXRhLWlkPVwiJyArIGRyYWZ0LmlkICsgJ1wiXScpO1xyXG4gICAgICBhd2FpdCBleHBlY3Qobm9kZSkudG9CZVZpc2libGUoKTtcclxuICAgICAgY29uc3Qgc2l6ZSA9IGF3YWl0IG5vZGUuYm91bmRpbmdCb3goKTtcclxuICAgICAgZXhwZWN0KHNpemUpLm5vdC50b0JlTnVsbCgpO1xyXG4gICAgICBjb25zdCBkaWFsb2cgPSBhd2FpdCBjbGlja1JlY3JlYXRpb25Ob2RlKHBhZ2UsIG5vZGUpO1xyXG4gICAgICBjb25zdCBkcmFmdExheW91dCA9IGF3YWl0IGV4cGVjdFJlY3JlYXRpb25MYXlvdXQoZGlhbG9nLCB2aWV3cG9ydCk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChkaWFsb2cuZ2V0QnlSb2xlKCdyZWdpb24nLCB7IG5hbWU6ICfliIbmnpDop4bpopEnLCBleGFjdDogdHJ1ZSB9KSkudG9CZVZpc2libGUoKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGRpYWxvZy5nZXRCeVJvbGUoJ3JlZ2lvbicsIHsgbmFtZTogJ+abv+aNoui1hOa6kCcsIGV4YWN0OiB0cnVlIH0pKS50b0JlVmlzaWJsZSgpO1xyXG4gICAgICBhd2FpdCBleHBlY3QoZGlhbG9nLmdldEJ5Um9sZSgncmVnaW9uJywgeyBuYW1lOiAn55Sf5oiQ6K6+572uJywgZXhhY3Q6IHRydWUgfSkpLnRvQmVWaXNpYmxlKCk7XHJcbiAgICAgIGNvbnN0IHJlZmVyZW5jZSA9IGRpYWxvZy5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Y+C6ICD6KeG6aKRJywgZXhhY3Q6IHRydWUgfSk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihyZWZlcmVuY2UsICfpgInmi6npobnnm67op4bpopEnKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGRpYWxvZy5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+S9v+eUqOatpOinhumikScsIGV4YWN0OiB0cnVlIH0pKS50b0JlRGlzYWJsZWQoKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGRpYWxvZy5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+eUn+aIkCcsIGV4YWN0OiB0cnVlIH0pKS50b0JlRGlzYWJsZWQoKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGRpYWxvZy5nZXRCeVJvbGUoJ3N0YXR1cycpKS50b0NvbnRhaW5UZXh0KCfor7flhYjpgInmi6nlj4LogIPop4bpopHlubblrozmiJDliIbmnpAnKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGRpYWxvZy5nZXRCeUxhYmVsKCfkuIrkvKDlj4LogIPop4bpopEnLCB7IGV4YWN0OiB0cnVlIH0pKS50b0JlQXR0YWNoZWQoKTtcclxuICAgICAgZXhwZWN0KGN0eC5wb3N0cykudG9IYXZlTGVuZ3RoKDApO1xyXG4gICAgICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG4gICAgICBleHBlY3QoY3R4LnBvc3RQYXRocykudG9FcXVhbChbXSk7XHJcbiAgICAgIGF3YWl0IHBhZ2Uuc2NyZWVuc2hvdCh7XHJcbiAgICAgICAgcGF0aDogaW5mby5vdXRwdXRQYXRoKCdyZWNyZWF0aW9uLWRyYWZ0LWRpYWxvZy5wbmcnKSxcclxuICAgICAgICBhbmltYXRpb25zOiAnZGlzYWJsZWQnLFxyXG4gICAgICAgIGZ1bGxQYWdlOiB0cnVlLFxyXG4gICAgICB9KTtcclxuXHJcbiAgICAgIGF3YWl0IHNlbGVjdE9wdGlvbihyZWZlcmVuY2UsIC/lj4LogIPnn63op4bpopEvKTtcclxuICAgICAgZXhwZWN0KFxyXG4gICAgICAgIGN0eC5jYW52YXMoKS5ub2Rlcy5maW5kKChpdGVtKSA9PiBpdGVtLmlkID09PSBkcmFmdC5pZCk/LmRhdGEudmlkZW9SZWNyZWF0aW9uLFxyXG4gICAgICApLnRvQmVVbmRlZmluZWQoKTtcclxuICAgICAgZXhwZWN0KGN0eC5wb3N0UGF0aHMpLnRvRXF1YWwoW10pO1xyXG4gICAgICBhd2FpdCBkaWFsb2cuZ2V0QnlSb2xlKCdidXR0b24nLCB7IG5hbWU6ICfkvb/nlKjmraTop4bpopEnLCBleGFjdDogdHJ1ZSB9KS5jbGljaygpO1xyXG4gICAgICBhd2FpdCBleHBlY3QoZGlhbG9nLmdldEJ5Um9sZSgncmVnaW9uJywgeyBuYW1lOiAn55+t6KeG6aKR5aSN5Yi7JywgZXhhY3Q6IHRydWUgfSkpLnRvQmVWaXNpYmxlKCk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdFxyXG4gICAgICAgIC5wb2xsKCgpID0+IGN0eC5jYW52YXMoKS5ub2Rlcy5maW5kKChpdGVtKSA9PiBpdGVtLmlkID09PSBkcmFmdC5pZCk/LmRhdGEudmlkZW9SZWNyZWF0aW9uKVxyXG4gICAgICAgIC50b0JlVHJ1dGh5KCk7XHJcbiAgICAgIGNvbnN0IHNhdmVkID0gY3R4LmNhbnZhcygpLm5vZGVzLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IGRyYWZ0LmlkKSE7XHJcbiAgICAgIGV4cGVjdChzYXZlZC5kYXRhLnZpZGVvUmVjcmVhdGlvbkRyYWZ0KS50b0JlVW5kZWZpbmVkKCk7XHJcbiAgICAgIGV4cGVjdChzYXZlZC5kYXRhLnZpZGVvUmVjcmVhdGlvbj8uc291cmNlKS50b01hdGNoT2JqZWN0KHtcclxuICAgICAgICBhc3NldElkOiAnY2xpcCcsXHJcbiAgICAgICAgYXNzZXRWZXJzaW9uOiAyLFxyXG4gICAgICAgIGR1cmF0aW9uU2Vjb25kczogMTAsXHJcbiAgICAgIH0pO1xyXG4gICAgICBleHBlY3QoY3R4LmNhbnZhcygpLm5vZGVzLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IHNvdXJjZUJlZm9yZS5pZCkpLnRvRXF1YWwoc291cmNlQmVmb3JlKTtcclxuICAgICAgZXhwZWN0KGN0eC5wb3N0cykudG9IYXZlTGVuZ3RoKDApO1xyXG4gICAgICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG4gICAgICBleHBlY3QoY3R4LnBvc3RQYXRocykudG9FcXVhbChbXSk7XHJcbiAgICAgIGNvbnN0IGJvdW5kTGF5b3V0ID0gYXdhaXQgZXhwZWN0UmVjcmVhdGlvbkxheW91dChkaWFsb2csIHZpZXdwb3J0KTtcclxuICAgICAgY29uc3QgcGxheWVyID0gZGlhbG9nLmxvY2F0b3IoJy52aWRlby1yZWNyZWF0aW9uLXNvdXJjZS1wcmV2aWV3IHZpZGVvJyk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChwbGF5ZXIpLnRvSGF2ZUF0dHJpYnV0ZSgnY29udHJvbHMnKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KHBsYXllcikudG9IYXZlQXR0cmlidXRlKCdzcmMnLCAvXFwvdjFcXC9hc3NldHNcXC9jbGlwXFwvdmVyc2lvbnNcXC8yXFwvY29udGVudCQvKTtcclxuICAgICAgYXdhaXQgZXhwZWN0XHJcbiAgICAgICAgLnBvbGwoKCkgPT4gcGxheWVyLmV2YWx1YXRlKChlbGVtZW50KSA9PiAoZWxlbWVudCBhcyBIVE1MVmlkZW9FbGVtZW50KS5yZWFkeVN0YXRlKSlcclxuICAgICAgICAudG9CZUdyZWF0ZXJUaGFuT3JFcXVhbCgxKTtcclxuICAgICAgY29uc3QgbGF5b3V0UGF0aCA9IGluZm8ub3V0cHV0UGF0aCgncmVjcmVhdGlvbi1kaWFsb2ctbGF5b3V0Lmpzb24nKTtcclxuICAgICAgd3JpdGVGaWxlU3luYyhsYXlvdXRQYXRoLCBKU09OLnN0cmluZ2lmeSh7IHZpZXdwb3J0LCBkcmFmdExheW91dCwgYm91bmRMYXlvdXQgfSwgbnVsbCwgMikpO1xyXG4gICAgICBhd2FpdCBpbmZvLmF0dGFjaCgn5aSN5Yi75LiJ5qCP6L6555WMJywgeyBwYXRoOiBsYXlvdXRQYXRoLCBjb250ZW50VHlwZTogJ2FwcGxpY2F0aW9uL2pzb24nIH0pO1xyXG4gICAgICBhd2FpdCBkaWFsb2cuZ2V0QnlSb2xlKCdidXR0b24nLCB7IG5hbWU6ICflhbPpl63nvJbovpHlmagnLCBleGFjdDogdHJ1ZSB9KS5jbGljaygpO1xyXG4gICAgICBhd2FpdCBleHBlY3QoZGlhbG9nKS50b0JlSGlkZGVuKCk7XHJcbiAgICAgIGF3YWl0IGNsaWNrRW1wdHlQYW5lKHBhZ2UpO1xyXG4gICAgICBhd2FpdCBwYWdlLm1vdXNlLm1vdmUoMCwgMCk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChub2RlKS5ub3QudG9IYXZlQ2xhc3MoL1xcYnNlbGVjdGVkXFxiLyk7XHJcbiAgICAgIGV4cGVjdChhd2FpdCBub2RlLmV2YWx1YXRlKChlbGVtZW50KSA9PiBlbGVtZW50Lm1hdGNoZXMoJzpob3ZlcicpKSkudG9CZShmYWxzZSk7XHJcbiAgICAgIGNvbnN0IGJhZGdlID0gbm9kZS5sb2NhdG9yKCcuZmxvdy1ub2RlLXJlY3JlYXRpb24tYmFkZ2UnKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGJhZGdlKS50b0JlVmlzaWJsZSgpO1xyXG4gICAgICAvLyBSZWFjdCBGbG93IOe8qeaUvuS8muS6p+eUnyAwLjk5OTk5OTgyIOS5i+exu+eahOS6pOmbhua1rueCueivr+W3ru+8m+S/neeVmeeZvuS4h+WIhuS5i+S4gOWuueW3ruW5tuaguOWvueWujOaVtOi+ueeVjOOAglxyXG4gICAgICBhd2FpdCBleHBlY3QoYmFkZ2UpLnRvQmVJblZpZXdwb3J0KHsgcmF0aW86IDEgLSAxZS02IH0pO1xyXG4gICAgICBjb25zdCBiYWRnZUJvdW5kcyA9IGF3YWl0IGJhZGdlLmJvdW5kaW5nQm94KCk7XHJcbiAgICAgIGV4cGVjdChiYWRnZUJvdW5kcykubm90LnRvQmVOdWxsKCk7XHJcbiAgICAgIGV4cGVjdChiYWRnZUJvdW5kcyEueCkudG9CZUdyZWF0ZXJUaGFuT3JFcXVhbCgwKTtcclxuICAgICAgZXhwZWN0KGJhZGdlQm91bmRzIS55KS50b0JlR3JlYXRlclRoYW5PckVxdWFsKDApO1xyXG4gICAgICBleHBlY3QoYmFkZ2VCb3VuZHMhLnggKyBiYWRnZUJvdW5kcyEud2lkdGgpLnRvQmVMZXNzVGhhbk9yRXF1YWwodmlld3BvcnQud2lkdGgpO1xyXG4gICAgICBleHBlY3QoYmFkZ2VCb3VuZHMhLnkgKyBiYWRnZUJvdW5kcyEuaGVpZ2h0KS50b0JlTGVzc1RoYW5PckVxdWFsKHZpZXdwb3J0LmhlaWdodCk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChiYWRnZSkudG9Db250YWluVGV4dCgn55+t6KeG6aKR5aSN5Yi7Jyk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChiYWRnZS5sb2NhdG9yKCdzdmcubHVjaWRlLWNsYXBwZXJib2FyZCcpKS50b0JlVmlzaWJsZSgpO1xyXG4gICAgICAvLyBQbGF5d3JpZ2h0IOeahOWPr+ingeaAp+aWreiogOS4jeaOkumZpCBvcGFjaXR5OiAw77yb5ZCM5pe25qOA5p+l56WW5YWI77yM6YG/5YWN6ZqQ6JeP5Zyo5oKs5rWu5bel5YW35qCP5YaF44CCXHJcbiAgICAgIGV4cGVjdChcclxuICAgICAgICBhd2FpdCBiYWRnZS5ldmFsdWF0ZSgoZWxlbWVudCkgPT4ge1xyXG4gICAgICAgICAgZm9yIChsZXQgY3VycmVudDogRWxlbWVudCB8IG51bGwgPSBlbGVtZW50OyBjdXJyZW50OyBjdXJyZW50ID0gY3VycmVudC5wYXJlbnRFbGVtZW50KSB7XHJcbiAgICAgICAgICAgIGlmIChOdW1iZXIoZ2V0Q29tcHV0ZWRTdHlsZShjdXJyZW50KS5vcGFjaXR5KSA9PT0gMCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgfSksXHJcbiAgICAgICkudG9CZSh0cnVlKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KG5vZGUubG9jYXRvcignLmZsb3ctbm9kZS1wcmV2aWV3IHZpZGVvJykpLnRvSGF2ZUF0dHJpYnV0ZShcclxuICAgICAgICAnc3JjJyxcclxuICAgICAgICAvXFwvdjFcXC9hc3NldHNcXC9jbGlwXFwvdmVyc2lvbnNcXC8yXFwvY29udGVudCQvLFxyXG4gICAgICApO1xyXG4gICAgICBjb25zdCBkZXNlbGVjdGVkU2l6ZSA9IGF3YWl0IG5vZGUuYm91bmRpbmdCb3goKTtcclxuICAgICAgZXhwZWN0KGRlc2VsZWN0ZWRTaXplPy53aWR0aCkudG9CZUNsb3NlVG8oc2l6ZSEud2lkdGgsIDApO1xyXG4gICAgICBleHBlY3QoZGVzZWxlY3RlZFNpemU/LmhlaWdodCkudG9CZUNsb3NlVG8oc2l6ZSEuaGVpZ2h0LCAwKTtcclxuICAgICAgYXdhaXQgcGFnZS5zY3JlZW5zaG90KHsgcGF0aDogaW5mby5vdXRwdXRQYXRoKCdyZWNyZWF0aW9uLW5vZGUtYmFkZ2UucG5nJyksIGZ1bGxQYWdlOiB0cnVlIH0pO1xyXG5cclxuICAgICAgYXdhaXQgY2xpY2tSZWNyZWF0aW9uTm9kZShwYWdlLCBub2RlKTtcclxuICAgICAgY29uc3QgcGFuZWwgPSBwYWdlLmdldEJ5Um9sZSgncmVnaW9uJywgeyBuYW1lOiAn55+t6KeG6aKR5aSN5Yi7JywgZXhhY3Q6IHRydWUgfSk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChwYW5lbCkudG9CZVZpc2libGUoKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KFxyXG4gICAgICAgIHBhbmVsXHJcbiAgICAgICAgICAuZ2V0QnlSb2xlKCdoZWFkaW5nJywgeyBuYW1lOiAn5YiG5p6Q6KeG6aKRJywgZXhhY3Q6IHRydWUgfSlcclxuICAgICAgICAgIC5sb2NhdG9yKCdzdmcubHVjaWRlLWNsYXBwZXJib2FyZCcpLFxyXG4gICAgICApLnRvQmVWaXNpYmxlKCk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChwYW5lbC5nZXRCeVRleHQoJ+S9v+eUqOa1geeoiycsIHsgZXhhY3Q6IHRydWUgfSkpLnRvSGF2ZUNvdW50KDApO1xyXG4gICAgICBhd2FpdCBleHBlY3QocGFuZWwuZ2V0QnlUZXh0KCflrozmlbTml7bplb/vvJoxMCDnp5InLCB7IGV4YWN0OiB0cnVlIH0pKS50b0hhdmVDb3VudCgwKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KHBhbmVsLmdldEJ5Um9sZSgndGV4dGJveCcsIHsgbmFtZTogJ+WIhuaekOaooeWeiyBJRCcsIGV4YWN0OiB0cnVlIH0pKS50b0hhdmVDb3VudCgwKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KHBhbmVsLmdldEJ5VGV4dCgn5YiG5p6Q5qih5Z6LJywgeyBleGFjdDogdHJ1ZSB9KSkudG9IYXZlQ291bnQoMCk7XHJcbiAgICAgIGV4cGVjdChcclxuICAgICAgICBhd2FpdCBwYW5lbC5ldmFsdWF0ZSgoZWxlbWVudCkgPT4gZWxlbWVudC5zY3JvbGxXaWR0aCA8PSBlbGVtZW50LmNsaWVudFdpZHRoICsgMSksXHJcbiAgICAgICkudG9CZSh0cnVlKTtcclxuICAgICAgZXhwZWN0KGN0eC5wb3N0UGF0aHMpLnRvRXF1YWwoW10pO1xyXG4gICAgICBjb25zdCBleHBhbmRlZFNpemUgPSBhd2FpdCBub2RlLmJvdW5kaW5nQm94KCk7XHJcbiAgICAgIGV4cGVjdChleHBhbmRlZFNpemU/LndpZHRoKS50b0JlQ2xvc2VUbyhzaXplIS53aWR0aCwgMCk7XHJcbiAgICAgIGV4cGVjdChleHBhbmRlZFNpemU/LmhlaWdodCkudG9CZUNsb3NlVG8oc2l6ZSEuaGVpZ2h0LCAwKTtcclxuICAgICAgYXdhaXQgcGFnZS5zY3JlZW5zaG90KHtcclxuICAgICAgICBwYXRoOiBpbmZvLm91dHB1dFBhdGgoJ3JlY3JlYXRpb24tcGFuZWwtY29udHJvbHMucG5nJyksXHJcbiAgICAgICAgZnVsbFBhZ2U6IHRydWUsXHJcbiAgICAgIH0pO1xyXG4gICAgICBjb25zdCBmdWxsRWRpdG9yID0gZGlhbG9nO1xyXG4gICAgICBhd2FpdCBleHBlY3QoZnVsbEVkaXRvcikudG9CZVZpc2libGUoKTtcclxuICAgICAgY29uc3QgZnVsbFBhbmVsID0gZnVsbEVkaXRvci5nZXRCeVJvbGUoJ3JlZ2lvbicsIHsgbmFtZTogJ+efreinhumikeWkjeWIuycsIGV4YWN0OiB0cnVlIH0pO1xyXG4gICAgICBhd2FpdCBmdWxsUGFuZWxcclxuICAgICAgICAuZ2V0QnlSb2xlKCdoZWFkaW5nJywgeyBuYW1lOiAn5YiG5p6Q6KeG6aKRJywgZXhhY3Q6IHRydWUgfSlcclxuICAgICAgICAuc2Nyb2xsSW50b1ZpZXdJZk5lZWRlZCgpO1xyXG4gICAgICBhd2FpdCBleHBlY3QoXHJcbiAgICAgICAgZnVsbFBhbmVsLmdldEJ5Um9sZSgnaGVhZGluZycsIHsgbmFtZTogJ+WIhuaekOinhumikScsIGV4YWN0OiB0cnVlIH0pLFxyXG4gICAgICApLnRvQmVJblZpZXdwb3J0KHsgcmF0aW86IDEgLSAxZS02IH0pO1xyXG4gICAgICBleHBlY3QoY3R4LnBvc3RQYXRocykudG9FcXVhbChbXSk7XHJcbiAgICAgIGF3YWl0IHBhZ2UubW91c2UubW92ZSgwLCAwKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KHBhZ2UuZ2V0QnlSb2xlKCd0b29sdGlwJykpLnRvQmVIaWRkZW4oKTtcclxuICAgICAgYXdhaXQgcGFnZS5zY3JlZW5zaG90KHtcclxuICAgICAgICBwYXRoOiBpbmZvLm91dHB1dFBhdGgoJ3JlY3JlYXRpb24tZnVsbC1lZGl0b3ItY29udHJvbHMucG5nJyksXHJcbiAgICAgICAgYW5pbWF0aW9uczogJ2Rpc2FibGVkJyxcclxuICAgICAgICBmdWxsUGFnZTogdHJ1ZSxcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IGZ1bGxFZGl0b3IuZ2V0QnlSb2xlKCdidXR0b24nLCB7IG5hbWU6ICflhbPpl63nvJbovpHlmagnLCBleGFjdDogdHJ1ZSB9KS5jbGljaygpO1xyXG4gICAgICBhd2FpdCBleHBlY3QoZnVsbEVkaXRvcikudG9CZUhpZGRlbigpO1xyXG4gICAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCcubm9kZS1xdWljay1lZGl0b3InKSkudG9IYXZlQ291bnQoMCk7XHJcbiAgICAgIGNvbnN0IGNsb3NlZEVkaXRvclNpemUgPSBhd2FpdCBub2RlLmJvdW5kaW5nQm94KCk7XHJcbiAgICAgIGV4cGVjdChjbG9zZWRFZGl0b3JTaXplPy53aWR0aCkudG9CZUNsb3NlVG8oc2l6ZSEud2lkdGgsIDApO1xyXG4gICAgICBleHBlY3QoY2xvc2VkRWRpdG9yU2l6ZT8uaGVpZ2h0KS50b0JlQ2xvc2VUbyhzaXplIS5oZWlnaHQsIDApO1xyXG4gICAgICBhd2FpdCBvcGVuUmVjcmVhdGlvbihwYWdlLCBzYXZlZC5pZCk7XHJcbiAgICAgIGF3YWl0IHBhbmVsLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5YiG5p6Q5pW05p2h6KeG6aKRJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KHBhbmVsLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICfkuLvop5InLCBleGFjdDogdHJ1ZSB9KSkudG9CZVZpc2libGUoKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGRpYWxvZy5nZXRCeVJvbGUoJ3RleHRib3gnLCB7IG5hbWU6ICfmj5DnpLror40nLCBleGFjdDogdHJ1ZSB9KSkudG9IYXZlVmFsdWUoXHJcbiAgICAgICAgL+OAkOmVnOWktOe8luWPt+OAke+8mlNob3QgMDEvLFxyXG4gICAgICApO1xyXG4gICAgICBleHBlY3QoY3R4LnBvc3RzKS50b0hhdmVMZW5ndGgoMSk7XHJcbiAgICAgIGV4cGVjdChjdHgucG9zdFBhdGhzKS50b0VxdWFsKFsnL3YxL2Fzc2V0cy9jbGlwL3ZlcnNpb25zLzIvcmV2ZXJzZS1wcm9tcHRzJ10pO1xyXG4gICAgICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG4gICAgICBjb25zdCBnZW5lcmF0ZSA9IGRpYWxvZy5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+eUn+aIkCcsIGV4YWN0OiB0cnVlIH0pO1xyXG4gICAgICBhd2FpdCBleHBlY3QoZ2VuZXJhdGUpLnRvQmVFbmFibGVkKCk7XHJcbiAgICAgIGF3YWl0IHNlbGVjdE9wdGlvbihwYW5lbC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Li76KeSJywgZXhhY3Q6IHRydWUgfSksICfmiJHnmoTkurrniaknKTtcclxuICAgICAgYXdhaXQgZXhwZWN0XHJcbiAgICAgICAgLnBvbGwoKCkgPT4gY3R4LmNhbnZhcygpLm5vZGVzLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IHNhdmVkLmlkKT8uZGF0YS5wcm9tcHQpXHJcbiAgICAgICAgLnRvQ29udGFpbign44CQ6ZWc5aS057yW5Y+344CR77yaU2hvdCAwMScpO1xyXG4gICAgICBhd2FpdCBleHBlY3QoZ2VuZXJhdGUpLnRvQmVFbmFibGVkKCk7XHJcbiAgICAgIGV4cGVjdChjdHgucG9zdFBhdGhzKS50b0VxdWFsKFsnL3YxL2Fzc2V0cy9jbGlwL3ZlcnNpb25zLzIvcmV2ZXJzZS1wcm9tcHRzJ10pO1xyXG4gICAgICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG4gICAgICBhd2FpdCBnZW5lcmF0ZS5jbGljaygpO1xyXG4gICAgICBhd2FpdCBleHBlY3QucG9sbCgoKSA9PiBjdHguZ2VuZXJhdGVzLmxlbmd0aCkudG9CZSgxKTtcclxuICAgICAgZXhwZWN0KGN0eC5wb3N0UGF0aHMpLnRvRXF1YWwoW1xyXG4gICAgICAgICcvdjEvYXNzZXRzL2NsaXAvdmVyc2lvbnMvMi9yZXZlcnNlLXByb21wdHMnLFxyXG4gICAgICAgICcvdjEvbm9kZXMvJyArIHNhdmVkLmlkICsgJy9ydW5zJyxcclxuICAgICAgXSk7XHJcbiAgICAgIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgxKTtcclxuICAgICAgZXhwZWN0KGN0eC5lcnJvcnMpLnRvRXF1YWwoW10pO1xyXG4gICAgfSxcclxuICApO1xyXG59XHJcblxyXG50ZXN0KCfmlbTmnaHliIbmnpDjgIHnu5HlrprkurrnianjgIHoh6rliqjnu4Too4XlkozmmI7noa7nlJ/miJDvvIzkv53lrZjph43ovb3kuI3ph43lpI3liIbmnpAnLCBhc3luYyAoeyBwYWdlIH0sIGluZm8pID0+IHtcclxuICBhd2FpdCBwYWdlLnNldFZpZXdwb3J0U2l6ZSh7IHdpZHRoOiAxNDQwLCBoZWlnaHQ6IDEwMDAgfSk7XHJcbiAgY29uc3QgY3R4ID0gYXdhaXQgZml4dHVyZShwYWdlKTtcclxuICBjb25zdCBub2RlID0gYXdhaXQgY3JlYXRlTm9kZShwYWdlKTtcclxuICBjb25zdCBzaXplID0gYXdhaXQgbm9kZS5ib3VuZGluZ0JveCgpO1xyXG4gIGNvbnN0IHBhbmVsID0gcGFnZS5nZXRCeVJvbGUoJ3JlZ2lvbicsIHsgbmFtZTogJ+efreinhumikeWkjeWIuycsIGV4YWN0OiB0cnVlIH0pO1xyXG4gIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgwKTtcclxuICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG4gIGF3YWl0IHBhbmVsLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5YiG5p6Q5pW05p2h6KeG6aKRJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICBhd2FpdCBleHBlY3QocGFuZWwuZ2V0QnlSb2xlKCdjb21ib2JveCcsIHsgbmFtZTogJ+S4u+inkicsIGV4YWN0OiB0cnVlIH0pKS50b0JlVmlzaWJsZSgpO1xyXG4gIGF3YWl0IHNlbGVjdE9wdGlvbihwYW5lbC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Li76KeSJywgZXhhY3Q6IHRydWUgfSksICfmiJHnmoTkurrniaknKTtcclxuICBhd2FpdCBleHBlY3RcclxuICAgIC5wb2xsKCgpID0+IGN0eC5jYW52YXMoKS5ub2Rlcy5maW5kKChuKSA9PiBuLmRhdGEudmlkZW9SZWNyZWF0aW9uKT8uZGF0YS5wcm9tcHQpXHJcbiAgICAudG9Db250YWluKCfjgJDplZzlpLTnvJblj7fjgJHvvJpTaG90IDAxJyk7XHJcbiAgY29uc3Qgc2F2ZWQgPSBjdHguY2FudmFzKCkubm9kZXMuZmluZCgobikgPT4gbi5kYXRhLnZpZGVvUmVjcmVhdGlvbikhO1xyXG4gIGV4cGVjdChzYXZlZC5kYXRhLnBhcmFtZXRlcnM/LmR1cmF0aW9uKS50b0JlKDEwKTtcclxuICBleHBlY3Qoc2F2ZWQuZGF0YS5yZXNvdXJjZVJlZnM/Lm1hcCgocikgPT4gci5hc3NldElkKSkudG9FcXVhbChbJ3BlcnNvbi1hJ10pO1xyXG4gIGV4cGVjdChzYXZlZC5kYXRhLnZpZGVvUmVjcmVhdGlvbj8uYW5hbHlzaXM/LnRlbXBsYXRlLmRpYWxvZ3VlKS50b0VxdWFsKHRlbXBsYXRlLmRpYWxvZ3VlKTtcclxuICBleHBlY3Qoc2F2ZWQuZGF0YS5wcm9tcHQpLnRvQ29udGFpbign6K+355yL6L+Z5Liq44CCJyk7XHJcbiAgYXdhaXQgZXhwZWN0KHBhbmVsLmdldEJ5VGV4dCgn5p+l55yL5a6M5pW05qih5p2/44CB6ZWc5aS05Yqo5L2c5LiO5Y+w6K+NJykpLnRvSGF2ZUNvdW50KDApO1xyXG4gIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgxKTtcclxuICBhd2FpdCBleHBlY3QoXHJcbiAgICBwYWdlXHJcbiAgICAgIC5nZXRCeVJvbGUoJ2RpYWxvZycsIHsgbmFtZTogJ+efreinhumikeWkjeWIuycsIGV4YWN0OiB0cnVlIH0pXHJcbiAgICAgIC5nZXRCeVJvbGUoJ3RleHRib3gnLCB7IG5hbWU6ICfmj5DnpLror40nLCBleGFjdDogdHJ1ZSB9KSxcclxuICApLnRvQ29udGFpblRleHQoJ+ivt+eci+i/meS4quOAgicpO1xyXG4gIGV4cGVjdChjdHguZ2VuZXJhdGVzKS50b0hhdmVMZW5ndGgoMCk7XHJcbiAgY29uc3QgYWZ0ZXIgPSBhd2FpdCBub2RlLmJvdW5kaW5nQm94KCk7XHJcbiAgZXhwZWN0KGFmdGVyPy53aWR0aCkudG9CZUNsb3NlVG8oc2l6ZSEud2lkdGgsIDApO1xyXG4gIGV4cGVjdChhZnRlcj8uaGVpZ2h0KS50b0JlQ2xvc2VUbyhzaXplIS5oZWlnaHQsIDApO1xyXG4gIGF3YWl0IHBhZ2Uuc2NyZWVuc2hvdCh7IHBhdGg6IGluZm8ub3V0cHV0UGF0aCgncmVjcmVhdGlvbi1ib3VuZC1kZXNrdG9wLnBuZycpLCBmdWxsUGFnZTogdHJ1ZSB9KTtcclxuICBhd2FpdCBwYWdlLnJlbG9hZCgpO1xyXG4gIGNvbnN0IHJlc3RvcmVkID0gYXdhaXQgb3BlblJlY3JlYXRpb24ocGFnZSwgc2F2ZWQuaWQpO1xyXG4gIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihyZXN0b3JlZC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Li76KeSJywgZXhhY3Q6IHRydWUgfSksICfmiJHnmoTkurrniaknKTtcclxuICBleHBlY3QoY3R4LnBvc3RzKS50b0hhdmVMZW5ndGgoMSk7XHJcbiAgYXdhaXQgcGFnZVxyXG4gICAgLmdldEJ5Um9sZSgnZGlhbG9nJywgeyBuYW1lOiAn55+t6KeG6aKR5aSN5Yi7JywgZXhhY3Q6IHRydWUgfSlcclxuICAgIC5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+eUn+aIkCcsIGV4YWN0OiB0cnVlIH0pXHJcbiAgICAuY2xpY2soKTtcclxuICBhd2FpdCBleHBlY3QucG9sbCgoKSA9PiBjdHguZ2VuZXJhdGVzLmxlbmd0aCkudG9CZSgxKTtcclxuICBleHBlY3QoXHJcbiAgICBjdHguZ2VuZXJhdGVzWzBdIS5zbmFwc2hvdC5ub2Rlcz8uZmluZCgobikgPT4gbi5pZCA9PT0gc2F2ZWQuaWQpPy5kYXRhLnZpZGVvUmVjcmVhdGlvbj8uc291cmNlLFxyXG4gICkudG9NYXRjaE9iamVjdCh7IGFzc2V0SWQ6ICdjbGlwJywgYXNzZXRWZXJzaW9uOiAyIH0pO1xyXG4gIGV4cGVjdChjdHguZ2VuZXJhdGVzWzBdIS5zbmFwc2hvdC5ub2Rlcz8uZmluZCgobikgPT4gbi5pZCA9PT0gc2F2ZWQuaWQpPy5kYXRhLnByb21wdCkudG9Db250YWluKFxyXG4gICAgJ+ivt+eci+i/meS4quOAgicsXHJcbiAgKTtcclxuICBleHBlY3QoY3R4LmVycm9ycykudG9FcXVhbChbXSk7XHJcbn0pO1xyXG5cclxudGVzdCgn5Y+z5qCP5pS+5aSn5o+Q56S66K+N5ZCO5Y+v57yW6L6R5a6M5pW05Lit5paH5YiG6ZWc77yM5bm25ZCM5q2l5Zue5Y6f6L6T5YWl5qGGJywgYXN5bmMgKHsgcGFnZSB9LCBpbmZvKSA9PiB7XHJcbiAgYXdhaXQgcGFnZS5zZXRWaWV3cG9ydFNpemUoeyB3aWR0aDogMTQ0MCwgaGVpZ2h0OiAxMDAwIH0pO1xyXG4gIGNvbnN0IGN0eCA9IGF3YWl0IGZpeHR1cmUocGFnZSk7XHJcbiAgYXdhaXQgY3JlYXRlTm9kZShwYWdlKTtcclxuICBjb25zdCByZWNyZWF0aW9uID0gcGFnZS5nZXRCeVJvbGUoJ2RpYWxvZycsIHsgbmFtZTogJ+efreinhumikeWkjeWIuycsIGV4YWN0OiB0cnVlIH0pO1xyXG4gIGF3YWl0IHJlY3JlYXRpb24uZ2V0QnlSb2xlKCdidXR0b24nLCB7IG5hbWU6ICfliIbmnpDmlbTmnaHop4bpopEnLCBleGFjdDogdHJ1ZSB9KS5jbGljaygpO1xyXG4gIGNvbnN0IHJpZ2h0RWRpdG9yID0gcmVjcmVhdGlvbi5nZXRCeVJvbGUoJ3RleHRib3gnLCB7IG5hbWU6ICfmj5DnpLror40nLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBleHBlY3QocmlnaHRFZGl0b3IpLnRvSGF2ZVZhbHVlKC/jgJDplZzlpLTnvJblj7fjgJHvvJpTaG90IDAxLyk7XHJcbiAgYXdhaXQgcmVjcmVhdGlvbi5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+aUvuWkp+e8lui+keaPkOekuuivjScsIGV4YWN0OiB0cnVlIH0pLmNsaWNrKCk7XHJcbiAgY29uc3QgZXhwYW5kZWQgPSBwYWdlLmdldEJ5Um9sZSgnZGlhbG9nJywgeyBuYW1lOiAn5a6M5pW05o+Q56S66K+NJywgZXhhY3Q6IHRydWUgfSk7XHJcbiAgYXdhaXQgZXhwZWN0KGV4cGFuZGVkKS50b0JlVmlzaWJsZSgpO1xyXG4gIGNvbnN0IGZ1bGxFZGl0b3IgPSBleHBhbmRlZC5nZXRCeVJvbGUoJ3RleHRib3gnLCB7IG5hbWU6ICfmj5DnpLror40nLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBleHBlY3QoZnVsbEVkaXRvcikudG9IYXZlVmFsdWUoL+OAkOmVnOWktOe8luWPt+OAke+8mlNob3QgMDIvKTtcclxuICBhd2FpdCBleHBlY3RcclxuICAgIC5wb2xsKGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgcGFuZWwgPSBhd2FpdCBleHBhbmRlZC5ib3VuZGluZ0JveCgpO1xyXG4gICAgICBjb25zdCBlZGl0b3IgPSBhd2FpdCBmdWxsRWRpdG9yLmJvdW5kaW5nQm94KCk7XHJcbiAgICAgIHJldHVybiBCb29sZWFuKFxyXG4gICAgICAgIHBhbmVsICYmXHJcbiAgICAgICAgZWRpdG9yICYmXHJcbiAgICAgICAgcGFuZWwueSA+PSAyMCAmJlxyXG4gICAgICAgIHBhbmVsLnkgKyBwYW5lbC5oZWlnaHQgPD0gOTgwICYmXHJcbiAgICAgICAgZWRpdG9yLnkgPj0gcGFuZWwueSAmJlxyXG4gICAgICAgIGVkaXRvci55ICsgZWRpdG9yLmhlaWdodCA8PSBwYW5lbC55ICsgcGFuZWwuaGVpZ2h0ICsgMSxcclxuICAgICAgKTtcclxuICAgIH0pXHJcbiAgICAudG9CZSh0cnVlKTtcclxuICBhd2FpdCBwYWdlLnNjcmVlbnNob3Qoe1xyXG4gICAgcGF0aDogaW5mby5vdXRwdXRQYXRoKCdyZWNyZWF0aW9uLXByb21wdC1leHBhbmRlZC5wbmcnKSxcclxuICB9KTtcclxuICBhd2FpdCBmdWxsRWRpdG9yLmZpbGwoJ+OAkOmVnOWktOe8luWPt+OAke+8mlNob3QgMDFcXG7jgJDliqjkvZzjgJHvvJrmiYvliqjmoKHlr7nliIbplZwnKTtcclxuICBhd2FpdCBleHBlY3QoZnVsbEVkaXRvcikudG9IYXZlVmFsdWUoL+aJi+WKqOagoeWvueWIhumVnC8pO1xyXG4gIGF3YWl0IGV4cGFuZGVkLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5YWz6Zet5a6M5pW05o+Q56S66K+NJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICBhd2FpdCBleHBlY3QoZXhwYW5kZWQpLnRvQmVIaWRkZW4oKTtcclxuICBhd2FpdCBleHBlY3QocmlnaHRFZGl0b3IpLnRvSGF2ZVZhbHVlKC/miYvliqjmoKHlr7nliIbplZwvKTtcclxuICBhd2FpdCBleHBlY3RcclxuICAgIC5wb2xsKCgpID0+IGN0eC5jYW52YXMoKS5ub2Rlcy5maW5kKChub2RlKSA9PiBub2RlLmRhdGEudmlkZW9SZWNyZWF0aW9uKT8uZGF0YS5wcm9tcHQpXHJcbiAgICAudG9Db250YWluKCfmiYvliqjmoKHlr7nliIbplZwnKTtcclxuICBhd2FpdCByZWNyZWF0aW9uLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5pW055CG5Li65Lit5paH5YiG6ZWcJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICBhd2FpdCBleHBlY3QocmlnaHRFZGl0b3IpLnRvSGF2ZVZhbHVlKC/jgJDplZzlpLTnvJblj7fjgJHvvJpTaG90IDAyLyk7XHJcbiAgYXdhaXQgZXhwZWN0KHJpZ2h0RWRpdG9yKS5ub3QudG9IYXZlVmFsdWUoL+aJi+WKqOagoeWvueWIhumVnC8pO1xyXG4gIGV4cGVjdChjdHgucG9zdFBhdGhzKS50b0VxdWFsKFsnL3YxL2Fzc2V0cy9jbGlwL3ZlcnNpb25zLzIvcmV2ZXJzZS1wcm9tcHRzJ10pO1xyXG4gIGV4cGVjdChjdHguZ2VuZXJhdGVzKS50b0hhdmVMZW5ndGgoMCk7XHJcbiAgZXhwZWN0KGN0eC5lcnJvcnMpLnRvRXF1YWwoW10pO1xyXG59KTtcclxuXHJcbnRlc3QoJ+abtOaNouS6uueJqeWSjOWVhuWTgeS4jemHjeWkjeWIhuaekO+8jOaFouS/neWtmOS4jeaJk+aWreWVhuWTgeivtOaYjui/nue7rei+k+WFpScsIGFzeW5jICh7IHBhZ2UgfSkgPT4ge1xyXG4gIGF3YWl0IHBhZ2Uuc2V0Vmlld3BvcnRTaXplKHsgd2lkdGg6IDE0NDAsIGhlaWdodDogMTAwMCB9KTtcclxuICBjb25zdCBjdHggPSBhd2FpdCBmaXh0dXJlKHBhZ2UsIDIsIDE1MCk7XHJcbiAgYXdhaXQgY3JlYXRlTm9kZShwYWdlKTtcclxuICBjb25zdCBwYW5lbCA9IHBhZ2UuZ2V0QnlSb2xlKCdyZWdpb24nLCB7IG5hbWU6ICfnn63op4bpopHlpI3liLsnLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBwYW5lbC5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+WIhuaekOaVtOadoeinhumikScsIGV4YWN0OiB0cnVlIH0pLmNsaWNrKCk7XHJcbiAgYXdhaXQgc2VsZWN0T3B0aW9uKHBhbmVsLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICfkuLvop5InLCBleGFjdDogdHJ1ZSB9KSwgJ+aIkeeahOS6uueJqScpO1xyXG4gIGF3YWl0IHNlbGVjdE9wdGlvbihwYW5lbC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Li76KeSJywgZXhhY3Q6IHRydWUgfSksICflj6bkuIDkurrniaknKTtcclxuICBhd2FpdCBzZWxlY3RPcHRpb24ocGFuZWwuZ2V0QnlSb2xlKCdjb21ib2JveCcsIHsgbmFtZTogJ+WVhuWTgScsIGV4YWN0OiB0cnVlIH0pLCAn5paw5ZWG5ZOBJyk7XHJcbiAgYXdhaXQgZXhwZWN0KFxyXG4gICAgcGFnZVxyXG4gICAgICAuZ2V0QnlSb2xlKCdkaWFsb2cnLCB7IG5hbWU6ICfnn63op4bpopHlpI3liLsnLCBleGFjdDogdHJ1ZSB9KVxyXG4gICAgICAuZ2V0QnlSb2xlKCdidXR0b24nLCB7IG5hbWU6ICfnlJ/miJAnLCBleGFjdDogdHJ1ZSB9KSxcclxuICApLnRvQmVEaXNhYmxlZCgpO1xyXG4gIGNvbnN0IGRlc2NyaXB0aW9uID0gJ+mmmeawtO+8jOWWt+a0kuS9v+eUqO+8m+S4jemlrueUqO+8jOS4jea3u+WKoOacquehruiupOWKn+aViCc7XHJcbiAgY29uc3QgcHJvZHVjdElucHV0ID0gcGFuZWwuZ2V0QnlSb2xlKCd0ZXh0Ym94JywgeyBuYW1lOiAv55So6YCUfOWNlueCuS8gfSk7XHJcbiAgYXdhaXQgcHJvZHVjdElucHV0LmNsaWNrKCk7XHJcbiAgYXdhaXQgcHJvZHVjdElucHV0LnByZXNzU2VxdWVudGlhbGx5KGRlc2NyaXB0aW9uLCB7IGRlbGF5OiAxMCB9KTtcclxuICBhd2FpdCBleHBlY3QocHJvZHVjdElucHV0KS50b0hhdmVWYWx1ZShkZXNjcmlwdGlvbik7XHJcbiAgYXdhaXQgZXhwZWN0KHByb2R1Y3RJbnB1dCkudG9CZUZvY3VzZWQoKTtcclxuICBhd2FpdCBleHBlY3RcclxuICAgIC5wb2xsKFxyXG4gICAgICAoKSA9PlxyXG4gICAgICAgIGN0eC5jYW52YXMoKS5ub2Rlcy5maW5kKChuKSA9PiBuLmRhdGEudmlkZW9SZWNyZWF0aW9uKT8uZGF0YS52aWRlb1JlY3JlYXRpb25cclxuICAgICAgICAgID8ucHJvZHVjdERlc2NyaXB0aW9uLFxyXG4gICAgKVxyXG4gICAgLnRvQmUoZGVzY3JpcHRpb24pO1xyXG4gIGF3YWl0IGV4cGVjdFxyXG4gICAgLnBvbGwoKCkgPT4gY3R4LmNhbnZhcygpLm5vZGVzLmZpbmQoKG4pID0+IG4uZGF0YS52aWRlb1JlY3JlYXRpb24pPy5kYXRhLnByb21wdClcclxuICAgIC50b0NvbnRhaW4oJ+abv+aNouWVhuWTgeS7heaMieW3suehruiupOeUqOmAlOiwg+aVtOS4jeWFvOWuueWKqOS9nCcpO1xyXG4gIGV4cGVjdChcclxuICAgIGN0eFxyXG4gICAgICAuY2FudmFzKClcclxuICAgICAgLm5vZGVzLmZpbmQoKG4pID0+IG4uZGF0YS52aWRlb1JlY3JlYXRpb24pXHJcbiAgICAgID8uZGF0YS5yZXNvdXJjZVJlZnM/Lm1hcCgocikgPT4gci5hc3NldElkKSxcclxuICApLnRvRXF1YWwoWydwZXJzb24tYicsICdwcm9kdWN0J10pO1xyXG4gIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgxKTtcclxuICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG4gIGV4cGVjdChjdHguZXJyb3JzKS50b0VxdWFsKFtdKTtcclxufSk7XHJcblxyXG50ZXN0KCfkv53lrZjliIbmnpDku7vliqHlkI7liLfmlrDlj6rmn6Xor6Lljp9ydW7vvIzkuI3ph43mlrBQT1NUJywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XHJcbiAgYXdhaXQgcGFnZS5zZXRWaWV3cG9ydFNpemUoeyB3aWR0aDogMTM2NiwgaGVpZ2h0OiA5MDAgfSk7XHJcbiAgY29uc3QgY3R4ID0gYXdhaXQgZml4dHVyZShwYWdlKTtcclxuICBjdHguaG9sZCh0cnVlKTtcclxuICBhd2FpdCBjcmVhdGVOb2RlKHBhZ2UpO1xyXG4gIGF3YWl0IHBhZ2VcclxuICAgIC5nZXRCeVJvbGUoJ3JlZ2lvbicsIHsgbmFtZTogJ+efreinhumikeWkjeWIuycsIGV4YWN0OiB0cnVlIH0pXHJcbiAgICAuZ2V0QnlSb2xlKCdidXR0b24nLCB7IG5hbWU6ICfliIbmnpDmlbTmnaHop4bpopEnLCBleGFjdDogdHJ1ZSB9KVxyXG4gICAgLmNsaWNrKCk7XHJcbiAgYXdhaXQgZXhwZWN0XHJcbiAgICAucG9sbChcclxuICAgICAgKCkgPT5cclxuICAgICAgICBjdHguY2FudmFzKCkubm9kZXMuZmluZCgobikgPT4gbi5kYXRhLnZpZGVvUmVjcmVhdGlvbik/LmRhdGEudmlkZW9SZWNyZWF0aW9uPy5yZXF1ZXN0XHJcbiAgICAgICAgICA/LnJ1bklkLFxyXG4gICAgKVxyXG4gICAgLnRvQmUoJ2FuYWx5c2lzLTEnKTtcclxuICBjb25zdCBzYXZlZCA9IGN0eC5jYW52YXMoKS5ub2Rlcy5maW5kKChuKSA9PiBuLmRhdGEudmlkZW9SZWNyZWF0aW9uKSE7XHJcbiAgYXdhaXQgcGFnZS5yZWxvYWQoKTtcclxuICBhd2FpdCBvcGVuUmVjcmVhdGlvbihwYWdlLCBzYXZlZC5pZCk7XHJcbiAgZXhwZWN0KGN0eC5wb3N0cykudG9IYXZlTGVuZ3RoKDEpO1xyXG4gIGN0eC5ob2xkKGZhbHNlKTtcclxuICBhd2FpdCBleHBlY3QocGFnZS5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Li76KeSJywgZXhhY3Q6IHRydWUgfSkpLnRvQmVWaXNpYmxlKHtcclxuICAgIHRpbWVvdXQ6IDEwMDAwLFxyXG4gIH0pO1xyXG4gIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgxKTtcclxuICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG4gIGV4cGVjdChjdHguZXJyb3JzKS50b0VxdWFsKFtdKTtcclxufSk7XHJcblxyXG50ZXN0KCfljoblj7Llm57mmL7lhrvnu5Pml6fniYjmnKzop4bpopHkuI7ml7bplb/vvIzovoPlsI9QQ+S4k+eUqCBEaWFsb2cg5Y+v5a6M5oiQ57uR5a6aJywgYXN5bmMgKHsgcGFnZSB9LCBpbmZvKSA9PiB7XHJcbiAgYXdhaXQgcGFnZS5zZXRWaWV3cG9ydFNpemUoeyB3aWR0aDogMTM2NiwgaGVpZ2h0OiA5MDAgfSk7XHJcbiAgY29uc3QgY3R4ID0gYXdhaXQgZml4dHVyZShwYWdlLCAzKTtcclxuICBjb25zdCBub2RlID0gYXdhaXQgY3JlYXRlTm9kZShwYWdlLCB0cnVlKTtcclxuICBjb25zdCBib3VuZHMgPSBhd2FpdCBub2RlLmJvdW5kaW5nQm94KCk7XHJcbiAgY29uc3QgZGlhbG9nID0gcGFnZS5nZXRCeVJvbGUoJ2RpYWxvZycsIHsgbmFtZTogJ+efreinhumikeWkjeWIuycsIGV4YWN0OiB0cnVlIH0pO1xyXG4gIGNvbnN0IHBhbmVsID0gZGlhbG9nLmdldEJ5Um9sZSgncmVnaW9uJywgeyBuYW1lOiAn55+t6KeG6aKR5aSN5Yi7JywgZXhhY3Q6IHRydWUgfSk7XHJcbiAgYXdhaXQgZXhwZWN0KHBhbmVsKS50b0JlVmlzaWJsZSgpO1xyXG4gIGNvbnN0IGxheW91dCA9IGF3YWl0IGV4cGVjdFJlY3JlYXRpb25MYXlvdXQoZGlhbG9nLCB7IHdpZHRoOiAxMzY2LCBoZWlnaHQ6IDkwMCB9KTtcclxuICBjb25zdCBwbGF5ZXIgPSBwYW5lbC5sb2NhdG9yKCcudmlkZW8tcmVjcmVhdGlvbi1zb3VyY2UtcHJldmlldyB2aWRlbycpO1xyXG4gIGF3YWl0IGV4cGVjdChwbGF5ZXIpLnRvSGF2ZUF0dHJpYnV0ZSgnc3JjJywgL1xcL3YxXFwvYXNzZXRzXFwvY2xpcFxcL3ZlcnNpb25zXFwvMlxcL2NvbnRlbnQkLyk7XHJcbiAgYXdhaXQgZXhwZWN0KHBsYXllcikudG9IYXZlQXR0cmlidXRlKCdjb250cm9scycpO1xyXG4gIGF3YWl0IGV4cGVjdFxyXG4gICAgLnBvbGwoKCkgPT4gcGxheWVyLmV2YWx1YXRlKChlbGVtZW50KSA9PiAoZWxlbWVudCBhcyBIVE1MVmlkZW9FbGVtZW50KS5yZWFkeVN0YXRlKSlcclxuICAgIC50b0JlR3JlYXRlclRoYW5PckVxdWFsKDEpO1xyXG4gIGF3YWl0IHBsYXllci5ldmFsdWF0ZSgoZWxlbWVudCkgPT4gKGVsZW1lbnQgYXMgSFRNTFZpZGVvRWxlbWVudCkucGxheSgpKTtcclxuICBhd2FpdCBleHBlY3RcclxuICAgIC5wb2xsKCgpID0+IHBsYXllci5ldmFsdWF0ZSgoZWxlbWVudCkgPT4gKGVsZW1lbnQgYXMgSFRNTFZpZGVvRWxlbWVudCkuY3VycmVudFRpbWUpKVxyXG4gICAgLnRvQmVHcmVhdGVyVGhhbigwKTtcclxuICBhd2FpdCBwbGF5ZXIuZXZhbHVhdGUoKGVsZW1lbnQpID0+IChlbGVtZW50IGFzIEhUTUxWaWRlb0VsZW1lbnQpLnBhdXNlKCkpO1xyXG4gIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgwKTtcclxuICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG4gIGF3YWl0IHBhbmVsLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5YiG5p6Q5pW05p2h6KeG6aKRJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICBhd2FpdCBzZWxlY3RPcHRpb24ocGFuZWwuZ2V0QnlSb2xlKCdjb21ib2JveCcsIHsgbmFtZTogJ+S4u+inkicsIGV4YWN0OiB0cnVlIH0pLCAn5oiR55qE5Lq654mpJyk7XHJcbiAgYXdhaXQgZXhwZWN0XHJcbiAgICAucG9sbCgoKSA9PiBjdHguY2FudmFzKCkubm9kZXMuZmluZCgobikgPT4gbi5kYXRhLnZpZGVvUmVjcmVhdGlvbik/LmRhdGEucHJvbXB0KVxyXG4gICAgLnRvQ29udGFpbign44CQ6ZWc5aS057yW5Y+344CR77yaU2hvdCAwMScpO1xyXG4gIGNvbnN0IHNhdmVkID0gY3R4LmNhbnZhcygpLm5vZGVzLmZpbmQoKG4pID0+IG4uZGF0YS52aWRlb1JlY3JlYXRpb24pITtcclxuICBleHBlY3Qoc2F2ZWQuZGF0YS52aWRlb1JlY3JlYXRpb24/LnNvdXJjZSkudG9NYXRjaE9iamVjdCh7XHJcbiAgICBhc3NldFZlcnNpb246IDIsXHJcbiAgICBkdXJhdGlvblNlY29uZHM6IDEwLFxyXG4gIH0pO1xyXG4gIGV4cGVjdChzYXZlZC5kYXRhLnBhcmFtZXRlcnM/LmR1cmF0aW9uKS50b0JlKDEwKTtcclxuICBleHBlY3Qoc2F2ZWQuZGF0YS5yZXNvdXJjZVJlZnM/Lm1hcCgocikgPT4gW3IuYXNzZXRJZCwgci5hc3NldFZlcnNpb25dKSkudG9FcXVhbChbXHJcbiAgICBbJ3BlcnNvbi1hJywgM10sXHJcbiAgXSk7XHJcbiAgYXdhaXQgZXhwZWN0KGRpYWxvZy5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+eUn+aIkCcsIGV4YWN0OiB0cnVlIH0pKS50b0JlRW5hYmxlZCgpO1xyXG4gIGF3YWl0IHBhbmVsLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICfkuLvop5InLCBleGFjdDogdHJ1ZSB9KS5zY3JvbGxJbnRvVmlld0lmTmVlZGVkKCk7XHJcbiAgYXdhaXQgcGFnZS5zY3JlZW5zaG90KHsgcGF0aDogaW5mby5vdXRwdXRQYXRoKCdyZWNyZWF0aW9uLWV4cGFuZGVkLXBjLnBuZycpLCBmdWxsUGFnZTogdHJ1ZSB9KTtcclxuICBjb25zdCBsYXlvdXRQYXRoID0gaW5mby5vdXRwdXRQYXRoKCdyZWNyZWF0aW9uLWZyb3plbi12aWRlby1sYXlvdXQuanNvbicpO1xyXG4gIHdyaXRlRmlsZVN5bmMobGF5b3V0UGF0aCwgSlNPTi5zdHJpbmdpZnkoeyBsYXlvdXQsIGNvbnNvbGVFcnJvcnM6IGN0eC5lcnJvcnMgfSwgbnVsbCwgMikpO1xyXG4gIGF3YWl0IGluZm8uYXR0YWNoKCflhrvnu5PniYjmnKzop4bpopHluIPlsYAnLCB7IHBhdGg6IGxheW91dFBhdGgsIGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbicgfSk7XHJcbiAgYXdhaXQgZGlhbG9nLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5YWz6Zet57yW6L6R5ZmoJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICBjb25zdCBhZnRlciA9IGF3YWl0IG5vZGUuYm91bmRpbmdCb3goKTtcclxuICBleHBlY3QoYWZ0ZXI/LndpZHRoKS50b0JlQ2xvc2VUbyhib3VuZHMhLndpZHRoLCAwKTtcclxuICBleHBlY3QoYWZ0ZXI/LmhlaWdodCkudG9CZUNsb3NlVG8oYm91bmRzIS5oZWlnaHQsIDApO1xyXG4gIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgxKTtcclxuICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG4gIGV4cGVjdChjdHguZXJyb3JzKS50b0VxdWFsKFtdKTtcclxufSk7XHJcblxyXG50ZXN0KCflj6rkuIrkvKDkurrnianlm77niYfljbPlj6/nu5HlrprnnJ/lrp7ov5Tlm57niYjmnKzvvIzkuI3pop3lpJbliIbmnpDmiJboh6rliqjnlJ/miJAnLCBhc3luYyAoeyBwYWdlIH0pID0+IHtcclxuICBhd2FpdCBwYWdlLnNldFZpZXdwb3J0U2l6ZSh7IHdpZHRoOiAxNDQwLCBoZWlnaHQ6IDEwMDAgfSk7XHJcbiAgY29uc3QgY3R4ID0gYXdhaXQgZml4dHVyZShwYWdlKTtcclxuICBhd2FpdCBjcmVhdGVOb2RlKHBhZ2UpO1xyXG4gIGNvbnN0IHBhbmVsID0gcGFnZS5nZXRCeVJvbGUoJ3JlZ2lvbicsIHsgbmFtZTogJ+efreinhumikeWkjeWIuycsIGV4YWN0OiB0cnVlIH0pO1xyXG4gIGF3YWl0IHBhbmVsLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5YiG5p6Q5pW05p2h6KeG6aKRJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICBhd2FpdCBwYW5lbC5nZXRCeUxhYmVsKCfkuIrkvKDkuLvop5Llm77niYcnLCB7IGV4YWN0OiB0cnVlIH0pLnNldElucHV0RmlsZXMoe1xyXG4gICAgbmFtZTogJ+aIkeeahOS6uueJqS5qcGcnLFxyXG4gICAgbWltZVR5cGU6ICdpbWFnZS9qcGVnJyxcclxuICAgIGJ1ZmZlcjogaW1hZ2UsXHJcbiAgfSk7XHJcbiAgYXdhaXQgZXhwZWN0XHJcbiAgICAucG9sbChcclxuICAgICAgKCkgPT4gY3R4LmNhbnZhcygpLm5vZGVzLmZpbmQoKG4pID0+IG4uZGF0YS52aWRlb1JlY3JlYXRpb24pPy5kYXRhLnZpZGVvUmVjcmVhdGlvbj8uYmluZGluZ3MsXHJcbiAgICApXHJcbiAgICAudG9FcXVhbChbXHJcbiAgICAgIHtcclxuICAgICAgICByb2xlSWQ6ICdjaGFyYWN0ZXJfYScsXHJcbiAgICAgICAgYXNzZXRJZDogJ3VwbG9hZGVkLWNoYXJhY3RlcicsXHJcbiAgICAgICAgYXNzZXRWZXJzaW9uOiA1LFxyXG4gICAgICAgIG5hbWU6ICfmiJHnmoTkurrniakuanBnJyxcclxuICAgICAgfSxcclxuICAgIF0pO1xyXG4gIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihwYW5lbC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Li76KeSJywgZXhhY3Q6IHRydWUgfSksICfmiJHnmoTkurrniakuanBnJyk7XHJcbiAgY29uc3Qgc2F2ZWQgPSBjdHguY2FudmFzKCkubm9kZXMuZmluZCgobikgPT4gbi5kYXRhLnZpZGVvUmVjcmVhdGlvbikhO1xyXG4gIGV4cGVjdChzYXZlZC5kYXRhLnJlc291cmNlUmVmcz8ubWFwKChyKSA9PiBbci5hc3NldElkLCByLmFzc2V0VmVyc2lvbl0pKS50b0VxdWFsKFtcclxuICAgIFsndXBsb2FkZWQtY2hhcmFjdGVyJywgNV0sXHJcbiAgXSk7XHJcbiAgZXhwZWN0KHNhdmVkLmRhdGEudmlkZW9SZWNyZWF0aW9uPy5wcm9kdWN0KS50b0JlVW5kZWZpbmVkKCk7XHJcbiAgZXhwZWN0KGN0eC51cGxvYWRzKS50b0VxdWFsKFsnaW5pdCcsICdieXRlcycsICdjb21wbGV0ZSddKTtcclxuICBleHBlY3QoY3R4LnBvc3RzKS50b0hhdmVMZW5ndGgoMSk7XHJcbiAgZXhwZWN0KGN0eC5nZW5lcmF0ZXMpLnRvSGF2ZUxlbmd0aCgwKTtcclxuICBleHBlY3QoY3R4LmVycm9ycykudG9FcXVhbChbXSk7XHJcbn0pO1xyXG5cclxuZm9yIChjb25zdCB2aWV3cG9ydCBvZiBbXHJcbiAgeyB3aWR0aDogMTQ0MCwgaGVpZ2h0OiAxMDAwIH0sXHJcbiAgeyB3aWR0aDogMTkyMCwgaGVpZ2h0OiAxMDgwIH0sXHJcbl0pIHtcclxuICB0ZXN0KFxyXG4gICAgJ1BDICcgKyB2aWV3cG9ydC53aWR0aCArICfDlycgKyB2aWV3cG9ydC5oZWlnaHQgKyAnIOmAkOS4quS6uueJqeWSjOWVhuWTgeivhuWIq+mihOiniOOAgeWNleS7tuabv+aNouW5tuS/neWtmOmHjei9vScsXHJcbiAgICBhc3luYyAoeyBwYWdlIH0sIGluZm8pID0+IHtcclxuICAgICAgdGVzdC5zZXRUaW1lb3V0KDYwMDAwKTtcclxuICAgICAgYXdhaXQgcGFnZS5zZXRWaWV3cG9ydFNpemUodmlld3BvcnQpO1xyXG4gICAgICBjb25zdCBjdHggPSBhd2FpdCBmaXh0dXJlKHBhZ2UsIDIsIDAsIHRydWUpO1xyXG4gICAgICBjb25zdCBub2RlID0gYXdhaXQgY3JlYXRlTm9kZShwYWdlKTtcclxuICAgICAgY29uc3Qgc2l6ZSA9IGF3YWl0IG5vZGUuYm91bmRpbmdCb3goKTtcclxuICAgICAgY29uc3QgcGFuZWwgPSBwYWdlLmdldEJ5Um9sZSgncmVnaW9uJywgeyBuYW1lOiAn55+t6KeG6aKR5aSN5Yi7JywgZXhhY3Q6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IGFuYWx5c2lzTW9kZWwgPSBwYW5lbC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5YiG5p6Q5qih5Z6LJywgZXhhY3Q6IHRydWUgfSk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihhbmFseXNpc01vZGVsLCAncXdlbjMuOC1vbW5pLWZsYXNoJyk7XHJcbiAgICAgIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgwKTtcclxuICAgICAgZXhwZWN0KGN0eC5nZW5lcmF0ZXMpLnRvSGF2ZUxlbmd0aCgwKTtcclxuICAgICAgY29uc3Qgc291cmNlUmVhZHNCZWZvcmVBbmFseXNpcyA9IGN0eC5zb3VyY2VDb250ZW50UmVxdWVzdHMubGVuZ3RoO1xyXG4gICAgICBhd2FpdCBwYW5lbC5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+WIhuaekOaVtOadoeinhumikScsIGV4YWN0OiB0cnVlIH0pLmNsaWNrKCk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChwYW5lbC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5ZCM5Ly0JywgZXhhY3Q6IHRydWUgfSkpLnRvQmVWaXNpYmxlKCk7XHJcbiAgICAgIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgxKTtcclxuICAgICAgZXhwZWN0KGN0eC5wb3N0c1swXSkudG9NYXRjaE9iamVjdCh7XHJcbiAgICAgICAgbW9kZWxBbGlhczogJ3F3ZW4zLjgtb21uaS1mbGFzaCcsXHJcbiAgICAgICAgY3JlZGVudGlhbElkOiBhbmFseXNpc0NyZWRlbnRpYWxJZCxcclxuICAgICAgICBwdXJwb3NlOiAndmlkZW9fcmVjcmVhdGlvbicsXHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBleHBlY3QocGFuZWwuZ2V0QnlUZXh0KCfmnKzmrKHliIbmnpDmqKHlnovvvJpxd2VuMy44LW9tbmktZmxhc2gnKSkudG9IYXZlQ291bnQoMCk7XHJcbiAgICAgIGNvbnN0IHNvdXJjZVByZXZpZXdzID0gYXdhaXQgZXhwZWN0U291cmNlUHJldmlld3MocGFuZWwpO1xyXG4gICAgICBjb25zdCBzb3VyY2VSZWFkc0FmdGVyQW5hbHlzaXMgPSBjdHguc291cmNlQ29udGVudFJlcXVlc3RzLmxlbmd0aDtcclxuICAgICAgYXdhaXQgZXhwZWN0U2VsZWN0aW9uKFxyXG4gICAgICAgIHBhbmVsLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICfkuLvop5InLCBleGFjdDogdHJ1ZSB9KSxcclxuICAgICAgICAn5L+d55WZ5Y6f6KeG6aKR5Lq654mp77yI5LiN5pu/5o2i77yJJyxcclxuICAgICAgKTtcclxuICAgICAgYXdhaXQgZXhwZWN0U2VsZWN0aW9uKFxyXG4gICAgICAgIHBhbmVsLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICflkIzkvLQnLCBleGFjdDogdHJ1ZSB9KSxcclxuICAgICAgICAn5L+d55WZ5Y6f6KeG6aKR5Lq654mp77yI5LiN5pu/5o2i77yJJyxcclxuICAgICAgKTtcclxuICAgICAgYXdhaXQgZXhwZWN0U2VsZWN0aW9uKFxyXG4gICAgICAgIHBhbmVsLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICfpppnmsLTnk7YnLCBleGFjdDogdHJ1ZSB9KSxcclxuICAgICAgICAn5L+d55WZ5Y6f6KeG6aKR5ZWG5ZOB77yI5LiN5pu/5o2i77yJJyxcclxuICAgICAgKTtcclxuICAgICAgYXdhaXQgZXhwZWN0U2VsZWN0aW9uKFxyXG4gICAgICAgIHBhbmVsLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICfmiYvmj5DooosnLCBleGFjdDogdHJ1ZSB9KSxcclxuICAgICAgICAn5L+d55WZ5Y6f6KeG6aKR5ZWG5ZOB77yI5LiN5pu/5o2i77yJJyxcclxuICAgICAgKTtcclxuXHJcbiAgICAgIGF3YWl0IHNlbGVjdE9wdGlvbihwYW5lbC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Li76KeSJywgZXhhY3Q6IHRydWUgfSksICfmiJHnmoTkurrniaknKTtcclxuICAgICAgYXdhaXQgc2VsZWN0T3B0aW9uKFxyXG4gICAgICAgIHBhbmVsLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICfkuLvop5InLCBleGFjdDogdHJ1ZSB9KSxcclxuICAgICAgICAn5L+d55WZ5Y6f6KeG6aKR5Lq654mp77yI5LiN5pu/5o2i77yJJyxcclxuICAgICAgKTtcclxuICAgICAgYXdhaXQgZXhwZWN0XHJcbiAgICAgICAgLnBvbGwoXHJcbiAgICAgICAgICAoKSA9PlxyXG4gICAgICAgICAgICBjdHguY2FudmFzKCkubm9kZXMuZmluZCgoZW50cnkpID0+IGVudHJ5LmRhdGEudmlkZW9SZWNyZWF0aW9uKT8uZGF0YS52aWRlb1JlY3JlYXRpb25cclxuICAgICAgICAgICAgICA/LmJpbmRpbmdzLFxyXG4gICAgICAgIClcclxuICAgICAgICAudG9FcXVhbChbXSk7XHJcbiAgICAgIGF3YWl0IHNlbGVjdE9wdGlvbihwYW5lbC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Li76KeSJywgZXhhY3Q6IHRydWUgfSksICflj6bkuIDkurrniaknKTtcclxuICAgICAgYXdhaXQgc2VsZWN0T3B0aW9uKHBhbmVsLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICfpppnmsLTnk7YnLCBleGFjdDogdHJ1ZSB9KSwgJ+aWsOWVhuWTgScpO1xyXG4gICAgICBjb25zdCBnZW5lcmF0ZSA9IHBhZ2VcclxuICAgICAgICAuZ2V0QnlSb2xlKCdkaWFsb2cnLCB7IG5hbWU6ICfnn63op4bpopHlpI3liLsnLCBleGFjdDogdHJ1ZSB9KVxyXG4gICAgICAgIC5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+eUn+aIkCcsIGV4YWN0OiB0cnVlIH0pO1xyXG4gICAgICBhd2FpdCBleHBlY3QoZ2VuZXJhdGUpLnRvQmVEaXNhYmxlZCgpO1xyXG4gICAgICBjb25zdCBkZXNjcmlwdGlvbiA9ICfpppnmsLTvvIzllrfmtJLkvb/nlKjvvJvkuI3ppa7nlKjvvIzkuI3mt7vliqDmnKrnoa7orqTlip/mlYgnO1xyXG4gICAgICBhd2FpdCBwYW5lbFxyXG4gICAgICAgIC5nZXRCeVJvbGUoJ3RleHRib3gnLCB7IG5hbWU6ICfpppnmsLTnk7bnlKjpgJTkuI7lt7Lnoa7orqTljZbngrknLCBleGFjdDogdHJ1ZSB9KVxyXG4gICAgICAgIC5maWxsKGRlc2NyaXB0aW9uKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KGdlbmVyYXRlKS50b0JlRW5hYmxlZCgpO1xyXG4gICAgICBhd2FpdCBleHBlY3RcclxuICAgICAgICAucG9sbChcclxuICAgICAgICAgICgpID0+XHJcbiAgICAgICAgICAgIGN0eC5jYW52YXMoKS5ub2Rlcy5maW5kKChlbnRyeSkgPT4gZW50cnkuZGF0YS52aWRlb1JlY3JlYXRpb24pPy5kYXRhLnZpZGVvUmVjcmVhdGlvblxyXG4gICAgICAgICAgICAgID8ucHJvZHVjdEJpbmRpbmdzLFxyXG4gICAgICAgIClcclxuICAgICAgICAudG9FcXVhbChbXHJcbiAgICAgICAgICB7XHJcbiAgICAgICAgICAgIHByb2R1Y3RJZDogJ3Byb2R1Y3RfYScsXHJcbiAgICAgICAgICAgIGFzc2V0SWQ6ICdwcm9kdWN0JyxcclxuICAgICAgICAgICAgYXNzZXRWZXJzaW9uOiAzLFxyXG4gICAgICAgICAgICBuYW1lOiAn5paw5ZWG5ZOBJyxcclxuICAgICAgICAgICAgZGVzY3JpcHRpb24sXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIF0pO1xyXG4gICAgICBhd2FpdCBleHBlY3RcclxuICAgICAgICAucG9sbChcclxuICAgICAgICAgICgpID0+XHJcbiAgICAgICAgICAgIGN0eC5jYW52YXMoKS5ub2Rlcy5maW5kKChlbnRyeSkgPT4gZW50cnkuZGF0YS52aWRlb1JlY3JlYXRpb24pPy5kYXRhLnZpZGVvUmVjcmVhdGlvblxyXG4gICAgICAgICAgICAgID8ucHJlc2VydmVkUm9sZUlkcyxcclxuICAgICAgICApXHJcbiAgICAgICAgLnRvRXF1YWwoWydjaGFyYWN0ZXJfYiddKTtcclxuICAgICAgYXdhaXQgZXhwZWN0XHJcbiAgICAgICAgLnBvbGwoKCkgPT5cclxuICAgICAgICAgIGN0eFxyXG4gICAgICAgICAgICAuY2FudmFzKClcclxuICAgICAgICAgICAgLm5vZGVzLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5kYXRhLnZpZGVvUmVjcmVhdGlvbilcclxuICAgICAgICAgICAgPy5kYXRhLnJlc291cmNlUmVmcz8ubWFwKChyZWZlcmVuY2UpID0+IFtyZWZlcmVuY2UuYXNzZXRJZCwgcmVmZXJlbmNlLmFzc2V0VmVyc2lvbl0pLFxyXG4gICAgICAgIClcclxuICAgICAgICAudG9FcXVhbChbXHJcbiAgICAgICAgICBbJ3BlcnNvbi1iJywgM10sXHJcbiAgICAgICAgICBbJ3Byb2R1Y3QnLCAzXSxcclxuICAgICAgICBdKTtcclxuXHJcbiAgICAgIGF3YWl0IHNlbGVjdE9wdGlvbihhbmFseXNpc01vZGVsLCAv6KeG6aKR5YiG5p6Q5qih5Z6LLyk7XHJcbiAgICAgIGNvbnN0IGdlbmVyYXRpb25Nb2RlbCA9IHBhZ2UuZ2V0QnlSb2xlKCdjb21ib2JveCcsIHsgbmFtZTogL17op4bpopHnlJ/miJDmqKHlnovvvJovIH0pO1xyXG4gICAgICBhd2FpdCBnZW5lcmF0aW9uTW9kZWwuY2xpY2soKTtcclxuICAgICAgYXdhaXQgcGFnZVxyXG4gICAgICAgIC5nZXRCeVJvbGUoJ2xpc3Rib3gnLCB7IG5hbWU6ICfop4bpopHnlJ/miJDmqKHlnovpgInpobknLCBleGFjdDogdHJ1ZSB9KVxyXG4gICAgICAgIC5nZXRCeVJvbGUoJ29wdGlvbicsIHsgbmFtZTogL+eLrOeri+inhumikeeUn+aIkOaooeWeiy8gfSlcclxuICAgICAgICAuY2xpY2soKTtcclxuICAgICAgYXdhaXQgZXhwZWN0XHJcbiAgICAgICAgLnBvbGwoKCkgPT4gY3R4LmNhbnZhcygpLm5vZGVzLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5kYXRhLnZpZGVvUmVjcmVhdGlvbik/LmRhdGEubW9kZWxBbGlhcylcclxuICAgICAgICAudG9CZSgnc29yYS0yJyk7XHJcbiAgICAgIGNvbnN0IHNhdmVkID0gY3R4LmNhbnZhcygpLm5vZGVzLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5kYXRhLnZpZGVvUmVjcmVhdGlvbikhO1xyXG4gICAgICBleHBlY3Qoc2F2ZWQuZGF0YS52aWRlb1JlY3JlYXRpb24/LmFuYWx5c2lzPy5tb2RlbEFsaWFzKS50b0JlKCdxd2VuMy44LW9tbmktZmxhc2gnKTtcclxuICAgICAgZXhwZWN0KHNhdmVkLmRhdGEudmlkZW9SZWNyZWF0aW9uPy5wcm9kdWN0KS50b0JlVW5kZWZpbmVkKCk7XHJcbiAgICAgIGV4cGVjdChzYXZlZC5kYXRhLnBhcmFtZXRlcnM/LmR1cmF0aW9uKS50b0JlKDEwKTtcclxuICAgICAgZXhwZWN0KHNhdmVkLmRhdGEucHJvbXB0KS50b0NvbnRhaW4oJ+abv+aNouWVhuWTgeS7heaMieW3suehruiupOeUqOmAlOiwg+aVtOS4jeWFvOWuueWKqOS9nCcpO1xyXG4gICAgICBleHBlY3Qoc2F2ZWQuZGF0YS5wcm9tcHQpLnRvQ29udGFpbign5ZCM5Ly077yI5L+d55WZ5YiG5p6Q5aSW6KeCJyk7XHJcbiAgICAgIGV4cGVjdChzYXZlZC5kYXRhLnByb21wdCkudG9Db250YWluKCfmiYvmj5DooovvvIjmjInliIbmnpDmj4/ov7Dkv53nlZknKTtcclxuICAgICAgZXhwZWN0KGN0eC5wb3N0UGF0aHMpLnRvRXF1YWwoWycvdjEvYXNzZXRzL2NsaXAvdmVyc2lvbnMvMi9yZXZlcnNlLXByb21wdHMnXSk7XHJcbiAgICAgIGV4cGVjdChjdHguZ2VuZXJhdGVzKS50b0hhdmVMZW5ndGgoMCk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gYXdhaXQgbm9kZS5ib3VuZGluZ0JveCgpO1xyXG4gICAgICBleHBlY3QoYWZ0ZXI/LndpZHRoKS50b0JlQ2xvc2VUbyhzaXplIS53aWR0aCwgMCk7XHJcbiAgICAgIGV4cGVjdChhZnRlcj8uaGVpZ2h0KS50b0JlQ2xvc2VUbyhzaXplIS5oZWlnaHQsIDApO1xyXG5cclxuICAgICAgYXdhaXQgcGFnZS5yZWxvYWQoKTtcclxuICAgICAgY29uc3QgcmVzdG9yZWQgPSBhd2FpdCBvcGVuUmVjcmVhdGlvbihwYWdlLCBzYXZlZC5pZCk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihcclxuICAgICAgICByZXN0b3JlZC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5Li76KeSJywgZXhhY3Q6IHRydWUgfSksXHJcbiAgICAgICAgJ+WPpuS4gOS6uueJqScsXHJcbiAgICAgICk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihcclxuICAgICAgICByZXN0b3JlZC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5ZCM5Ly0JywgZXhhY3Q6IHRydWUgfSksXHJcbiAgICAgICAgJ+S/neeVmeWOn+inhumikeS6uueJqe+8iOS4jeabv+aNou+8iScsXHJcbiAgICAgICk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihcclxuICAgICAgICByZXN0b3JlZC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn6aaZ5rC055O2JywgZXhhY3Q6IHRydWUgfSksXHJcbiAgICAgICAgJ+aWsOWVhuWTgScsXHJcbiAgICAgICk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihcclxuICAgICAgICByZXN0b3JlZC5nZXRCeVJvbGUoJ2NvbWJvYm94JywgeyBuYW1lOiAn5omL5o+Q6KKLJywgZXhhY3Q6IHRydWUgfSksXHJcbiAgICAgICAgJ+S/neeVmeWOn+inhumikeWVhuWTge+8iOS4jeabv+aNou+8iScsXHJcbiAgICAgICk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChcclxuICAgICAgICByZXN0b3JlZC5nZXRCeVJvbGUoJ3RleHRib3gnLCB7IG5hbWU6ICfpppnmsLTnk7bnlKjpgJTkuI7lt7Lnoa7orqTljZbngrknLCBleGFjdDogdHJ1ZSB9KSxcclxuICAgICAgKS50b0hhdmVWYWx1ZShkZXNjcmlwdGlvbik7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChyZXN0b3JlZC5nZXRCeVRleHQoJ+acrOasoeWIhuaekOaooeWei++8mnF3ZW4zLjgtb21uaS1mbGFzaCcpKS50b0hhdmVDb3VudCgwKTtcclxuICAgICAgZXhwZWN0KGN0eC5wb3N0cykudG9IYXZlTGVuZ3RoKDEpO1xyXG4gICAgICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG5cclxuICAgICAgY29uc3QgZWRpdG9yID0gcGFnZS5nZXRCeVJvbGUoJ2RpYWxvZycsIHsgbmFtZTogJ+efreinhumikeWkjeWIuycsIGV4YWN0OiB0cnVlIH0pO1xyXG4gICAgICBjb25zdCBmdWxsUGFuZWwgPSBlZGl0b3IuZ2V0QnlSb2xlKCdyZWdpb24nLCB7IG5hbWU6ICfnn63op4bpopHlpI3liLsnLCBleGFjdDogdHJ1ZSB9KTtcclxuICAgICAgY29uc3QgZGlhbG9nTGF5b3V0ID0gYXdhaXQgZXhwZWN0UmVjcmVhdGlvbkxheW91dChlZGl0b3IsIHZpZXdwb3J0KTtcclxuICAgICAgY29uc3Qgc291cmNlTmFtZSA9IGZ1bGxQYW5lbC5sb2NhdG9yKCcudmlkZW8tcmVjcmVhdGlvbi1zb3VyY2UtbmFtZScpO1xyXG4gICAgICBhd2FpdCBzb3VyY2VOYW1lLmhvdmVyKCk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChwYWdlLmdldEJ5Um9sZSgndG9vbHRpcCcpKS50b0hhdmVUZXh0KHNhdmVkLmRhdGEudmlkZW9SZWNyZWF0aW9uIS5zb3VyY2UubmFtZSk7XHJcbiAgICAgIGF3YWl0IHBhZ2UubW91c2UubW92ZSgwLCAwKTtcclxuICAgICAgYXdhaXQgZXhwZWN0KHBhZ2UuZ2V0QnlSb2xlKCd0b29sdGlwJykpLnRvQmVIaWRkZW4oKTtcclxuICAgICAgY29uc3QgZnVsbEVkaXRvclByZXZpZXdzID0gYXdhaXQgZXhwZWN0U291cmNlUHJldmlld3MoZnVsbFBhbmVsKTtcclxuICAgICAgY29uc3QgYW5hbHlzaXNDb2x1bW4gPSBmdWxsUGFuZWwuZ2V0QnlSb2xlKCdyZWdpb24nLCB7IG5hbWU6ICfljp/op4bpopHkuI7liIbmnpAnLCBleGFjdDogdHJ1ZSB9KTtcclxuICAgICAgY29uc3QgcmVzb3VyY2VzQ29sdW1uID0gZnVsbFBhbmVsLmdldEJ5Um9sZSgncmVnaW9uJywgeyBuYW1lOiAn5pu/5o2i6LWE5rqQJywgZXhhY3Q6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IGdlbmVyYXRpb25Db2x1bW4gPSBlZGl0b3IuZ2V0QnlSb2xlKCdyZWdpb24nLCB7IG5hbWU6ICfnlJ/miJDorr7nva4nLCBleGFjdDogdHJ1ZSB9KTtcclxuICAgICAgY29uc3QgYW5hbHlzaXNTY3JvbGxUb3AgPSBhd2FpdCBhbmFseXNpc0NvbHVtbi5ldmFsdWF0ZSgoZWxlbWVudCkgPT4gZWxlbWVudC5zY3JvbGxUb3ApO1xyXG4gICAgICBjb25zdCBnZW5lcmF0aW9uU2Nyb2xsVG9wID0gYXdhaXQgZ2VuZXJhdGlvbkNvbHVtbi5ldmFsdWF0ZSgoZWxlbWVudCkgPT4gZWxlbWVudC5zY3JvbGxUb3ApO1xyXG4gICAgICBjb25zdCByZXBsYWNlbWVudFNlbGVjdG9ycyA9IGZ1bGxQYW5lbC5sb2NhdG9yKFxyXG4gICAgICAgICcudmlkZW8tcmVjcmVhdGlvbi1vYmplY3QtcmVzb3VyY2UgW3JvbGU9XCJjb21ib2JveFwiXScsXHJcbiAgICAgICk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdChyZXBsYWNlbWVudFNlbGVjdG9ycykudG9IYXZlQ291bnQoNCk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihyZXBsYWNlbWVudFNlbGVjdG9ycy5udGgoMCkhLCAn5Y+m5LiA5Lq654mpJyk7XHJcbiAgICAgIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihyZXBsYWNlbWVudFNlbGVjdG9ycy5udGgoMikhLCAn5paw5ZWG5ZOBJyk7XHJcbiAgICAgIGF3YWl0IGZ1bGxQYW5lbFxyXG4gICAgICAgIC5nZXRCeVJvbGUoJ2ltZycsIHsgbmFtZTogJ+S4u+inkueahOWOn+inhumikeeUu+mdoicsIGV4YWN0OiB0cnVlIH0pXHJcbiAgICAgICAgLnNjcm9sbEludG9WaWV3SWZOZWVkZWQoKTtcclxuICAgICAgYXdhaXQgcGFnZS5zY3JlZW5zaG90KHtcclxuICAgICAgICBwYXRoOiBpbmZvLm91dHB1dFBhdGgoJ3JlY3JlYXRpb24taWRlbnRpZmllZC1yb2xlcy1wYy5wbmcnKSxcclxuICAgICAgICBhbmltYXRpb25zOiAnZGlzYWJsZWQnLFxyXG4gICAgICAgIGZ1bGxQYWdlOiB0cnVlLFxyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgZnVsbFBhbmVsXHJcbiAgICAgICAgLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5LiK5Lyg5omL5o+Q6KKL5Zu+54mHJywgZXhhY3Q6IHRydWUgfSlcclxuICAgICAgICAuc2Nyb2xsSW50b1ZpZXdJZk5lZWRlZCgpO1xyXG4gICAgICBjb25zdCByZXNvdXJjZVNjcm9sbCA9IGF3YWl0IHJlc291cmNlc0NvbHVtbi5ldmFsdWF0ZSgoZWxlbWVudCkgPT4gKHtcclxuICAgICAgICB0b3A6IGVsZW1lbnQuc2Nyb2xsVG9wLFxyXG4gICAgICAgIG92ZXJmbG93czogZWxlbWVudC5zY3JvbGxIZWlnaHQgPiBlbGVtZW50LmNsaWVudEhlaWdodCArIDEsXHJcbiAgICAgIH0pKTtcclxuICAgICAgaWYgKHJlc291cmNlU2Nyb2xsLm92ZXJmbG93cykgZXhwZWN0KHJlc291cmNlU2Nyb2xsLnRvcCkudG9CZUdyZWF0ZXJUaGFuKDApO1xyXG4gICAgICBlbHNlIGV4cGVjdChyZXNvdXJjZVNjcm9sbC50b3ApLnRvQmUoMCk7XHJcbiAgICAgIGV4cGVjdChhd2FpdCBhbmFseXNpc0NvbHVtbi5ldmFsdWF0ZSgoZWxlbWVudCkgPT4gZWxlbWVudC5zY3JvbGxUb3ApKS50b0JlKGFuYWx5c2lzU2Nyb2xsVG9wKTtcclxuICAgICAgZXhwZWN0KGF3YWl0IGdlbmVyYXRpb25Db2x1bW4uZXZhbHVhdGUoKGVsZW1lbnQpID0+IGVsZW1lbnQuc2Nyb2xsVG9wKSkudG9CZShcclxuICAgICAgICBnZW5lcmF0aW9uU2Nyb2xsVG9wLFxyXG4gICAgICApO1xyXG4gICAgICBhd2FpdCBwYWdlLnNjcmVlbnNob3Qoe1xyXG4gICAgICAgIHBhdGg6IGluZm8ub3V0cHV0UGF0aCgncmVjcmVhdGlvbi1pZGVudGlmaWVkLXByb2R1Y3RzLXBjLnBuZycpLFxyXG4gICAgICAgIGFuaW1hdGlvbnM6ICdkaXNhYmxlZCcsXHJcbiAgICAgICAgZnVsbFBhZ2U6IHRydWUsXHJcbiAgICAgIH0pO1xyXG4gICAgICBleHBlY3QoXHJcbiAgICAgICAgYXdhaXQgZnVsbFBhbmVsLmV2YWx1YXRlKChlbGVtZW50KSA9PiBlbGVtZW50LnNjcm9sbFdpZHRoIDw9IGVsZW1lbnQuY2xpZW50V2lkdGggKyAxKSxcclxuICAgICAgKS50b0JlKHRydWUpO1xyXG4gICAgICBleHBlY3QoYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuc2Nyb2xsV2lkdGgpKS50b0JlTGVzc1RoYW5PckVxdWFsKFxyXG4gICAgICAgIHZpZXdwb3J0LndpZHRoLFxyXG4gICAgICApO1xyXG4gICAgICBhd2FpdCBlZGl0b3IuZ2V0QnlSb2xlKCdidXR0b24nLCB7IG5hbWU6ICflhbPpl63nvJbovpHlmagnLCBleGFjdDogdHJ1ZSB9KS5jbGljaygpO1xyXG4gICAgICBhd2FpdCBleHBlY3QoZWRpdG9yKS50b0JlSGlkZGVuKCk7XHJcbiAgICAgIGNvbnN0IGNsb3NlZFNpemUgPSBhd2FpdCBub2RlLmJvdW5kaW5nQm94KCk7XHJcbiAgICAgIGV4cGVjdChjbG9zZWRTaXplPy53aWR0aCkudG9CZUNsb3NlVG8oc2l6ZSEud2lkdGgsIDApO1xyXG4gICAgICBleHBlY3QoY2xvc2VkU2l6ZT8uaGVpZ2h0KS50b0JlQ2xvc2VUbyhzaXplIS5oZWlnaHQsIDApO1xyXG4gICAgICBhd2FpdCBwYWdlLnNjcmVlbnNob3Qoe1xyXG4gICAgICAgIHBhdGg6IGluZm8ub3V0cHV0UGF0aCgncmVjcmVhdGlvbi1pZGVudGlmaWVkLXdvcmtzcGFjZS1wYy5wbmcnKSxcclxuICAgICAgICBhbmltYXRpb25zOiAnZGlzYWJsZWQnLFxyXG4gICAgICAgIGZ1bGxQYWdlOiB0cnVlLFxyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgb3BlblJlY3JlYXRpb24ocGFnZSwgc2F2ZWQuaWQpO1xyXG4gICAgICBhd2FpdCBnZW5lcmF0ZS5jbGljaygpO1xyXG4gICAgICBhd2FpdCBleHBlY3QucG9sbCgoKSA9PiBjdHguZ2VuZXJhdGVzLmxlbmd0aCkudG9CZSgxKTtcclxuICAgICAgZXhwZWN0KGN0eC5nZW5lcmF0ZXNbMF0hLm1vZGVsQWxpYXMpLnRvQmUoJ3NvcmEtMicpO1xyXG4gICAgICBleHBlY3QoXHJcbiAgICAgICAgY3R4LmdlbmVyYXRlc1swXSEuc25hcHNob3Qubm9kZXM/LmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5pZCA9PT0gc2F2ZWQuaWQpPy5kYXRhXHJcbiAgICAgICAgICAudmlkZW9SZWNyZWF0aW9uLFxyXG4gICAgICApLnRvRXF1YWwoc2F2ZWQuZGF0YS52aWRlb1JlY3JlYXRpb24pO1xyXG4gICAgICBleHBlY3QoY3R4LnBvc3RzKS50b0hhdmVMZW5ndGgoMSk7XHJcbiAgICAgIGV4cGVjdChjdHguZXJyb3JzKS50b0VxdWFsKFtdKTtcclxuICAgICAgY29uc3QgZXZpZGVuY2VQYXRoID0gaW5mby5vdXRwdXRQYXRoKCdyZWNyZWF0aW9uLWlkZW50aWZpZWQtZXZpZGVuY2UuanNvbicpO1xyXG4gICAgICB3cml0ZUZpbGVTeW5jKFxyXG4gICAgICAgIGV2aWRlbmNlUGF0aCxcclxuICAgICAgICBKU09OLnN0cmluZ2lmeShcclxuICAgICAgICAgIHtcclxuICAgICAgICAgICAgdmlld3BvcnQsXHJcbiAgICAgICAgICAgIGRpYWxvZ0xheW91dCxcclxuICAgICAgICAgICAgcHJldmlld3M6IHNvdXJjZVByZXZpZXdzLFxyXG4gICAgICAgICAgICBmdWxsRWRpdG9yUHJldmlld3MsXHJcbiAgICAgICAgICAgIHNvdXJjZVJlYWRzQmVmb3JlQW5hbHlzaXMsXHJcbiAgICAgICAgICAgIHNvdXJjZVJlYWRzQWZ0ZXJBbmFseXNpcyxcclxuICAgICAgICAgICAgc291cmNlQ29udGVudFJlcXVlc3RzOiBjdHguc291cmNlQ29udGVudFJlcXVlc3RzLFxyXG4gICAgICAgICAgICBub2RlQm91bmRzOiB7IGluaXRpYWw6IHNpemUsIGFmdGVyQmluZGluZ3M6IGFmdGVyLCBhZnRlckVkaXRvcjogY2xvc2VkU2l6ZSB9LFxyXG4gICAgICAgICAgICBjb25zb2xlRXJyb3JzOiBjdHguZXJyb3JzLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIG51bGwsXHJcbiAgICAgICAgICAyLFxyXG4gICAgICAgICksXHJcbiAgICAgICk7XHJcbiAgICAgIGF3YWl0IGluZm8uYXR0YWNoKCflpI3liLvmiKrlm77jgIHor7fmsYLkuI7oioLngrnlsLrlr7gnLCB7XHJcbiAgICAgICAgcGF0aDogZXZpZGVuY2VQYXRoLFxyXG4gICAgICAgIGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgIH0pO1xyXG4gICAgfSxcclxuICApO1xyXG59XHJcblxyXG50ZXN0KCfliIbmnpDnm67lvZXlj6rliJfmlofmnKzpobnvvIzpgInmi6nmqKHlnovkuI7liIbnu4TlkI7ku4XlnKjmmI7noa7liIbmnpDml7bmj5DkuqQnLCBhc3luYyAoeyBwYWdlIH0pID0+IHtcclxuICBhd2FpdCBwYWdlLnNldFZpZXdwb3J0U2l6ZSh7IHdpZHRoOiAxNDQwLCBoZWlnaHQ6IDEwMDAgfSk7XHJcbiAgY29uc3QgY3R4ID0gYXdhaXQgZml4dHVyZShwYWdlLCAyLCAwLCB0cnVlKTtcclxuICBhd2FpdCBjcmVhdGVOb2RlKHBhZ2UpO1xyXG4gIGNvbnN0IHBhbmVsID0gcGFnZS5nZXRCeVJvbGUoJ3JlZ2lvbicsIHsgbmFtZTogJ+efreinhumikeWkjeWIuycsIGV4YWN0OiB0cnVlIH0pO1xyXG4gIGNvbnN0IHNlbGVjdCA9IHBhbmVsLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICfliIbmnpDmqKHlnosnLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBleHBlY3RTZWxlY3Rpb24oc2VsZWN0LCAncXdlbjMuOC1vbW5pLWZsYXNoJyk7XHJcbiAgYXdhaXQgZXhwZWN0KHBhbmVsLmdldEJ5Um9sZSgndGV4dGJveCcsIHsgbmFtZTogJ+WIhuaekOaooeWeiyBJRCcsIGV4YWN0OiB0cnVlIH0pKS50b0hhdmVDb3VudCgwKTtcclxuICBhd2FpdCBzZWxlY3QuY2xpY2soKTtcclxuICBhd2FpdCBleHBlY3QocGFnZS5nZXRCeVJvbGUoJ29wdGlvbicsIHsgbmFtZTogL+WPguiAg+inhumikeeUn+aIkOaooeWei3zni6znq4vop4bpopHnlJ/miJDmqKHlnosvIH0pKS50b0hhdmVDb3VudChcclxuICAgIDAsXHJcbiAgKTtcclxuICBhd2FpdCBwYWdlLmdldEJ5Um9sZSgnb3B0aW9uJywgeyBuYW1lOiAv6KeG6aKR5YiG5p6Q5qih5Z6LLyB9KS5jbGljaygpO1xyXG4gIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgwKTtcclxuICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDApO1xyXG4gIGF3YWl0IHBhbmVsLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5YiG5p6Q5pW05p2h6KeG6aKRJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICBhd2FpdCBleHBlY3QocGFuZWwuZ2V0QnlSb2xlKCdjb21ib2JveCcsIHsgbmFtZTogJ+WQjOS8tCcsIGV4YWN0OiB0cnVlIH0pKS50b0JlVmlzaWJsZSgpO1xyXG4gIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgxKTtcclxuICBleHBlY3QoY3R4LnBvc3RzWzBdKS50b01hdGNoT2JqZWN0KHtcclxuICAgIG1vZGVsQWxpYXM6ICd2aXNpb24tdGVzdCcsXHJcbiAgICBjcmVkZW50aWFsSWQ6IGFuYWx5c2lzQ3JlZGVudGlhbElkLFxyXG4gIH0pO1xyXG4gIGF3YWl0IGV4cGVjdChwYW5lbC5nZXRCeVRleHQoJ+acrOasoeWIhuaekOaooeWei++8mnZpc2lvbi10ZXN0JykpLnRvSGF2ZUNvdW50KDApO1xyXG4gIGV4cGVjdChjdHguY2FudmFzKCkubm9kZXMuZmluZCgoZW50cnkpID0+IGVudHJ5LmRhdGEudmlkZW9SZWNyZWF0aW9uKT8uZGF0YS5tb2RlbEFsaWFzKS50b0JlKFxyXG4gICAgJ01pbmlNYXgtSDMnLFxyXG4gICk7XHJcbiAgZXhwZWN0KGN0eC5nZW5lcmF0ZXMpLnRvSGF2ZUxlbmd0aCgwKTtcclxuICBleHBlY3QoY3R4LmVycm9ycykudG9FcXVhbChbXSk7XHJcbn0pO1xyXG5cclxudGVzdCgn5a+56LGh6aKE6KeI5LiO6aG555uu5Zu+54mH5pCc57Si5by556qX5Y+v5Lqk5LqS77yM5pi+5byP55Sf5oiQ55qE5Zu+54mH5Zue5pi+5Y6f6IqC54K55bm25L+d5oyB5bC65a+4JywgYXN5bmMgKHtcclxuICBwYWdlLFxyXG59LCBpbmZvKSA9PiB7XHJcbiAgdGVzdC5zZXRUaW1lb3V0KDYwMDAwKTtcclxuICBhd2FpdCBwYWdlLnNldFZpZXdwb3J0U2l6ZSh7IHdpZHRoOiAxNDQwLCBoZWlnaHQ6IDEwMDAgfSk7XHJcbiAgY29uc3QgY3R4ID0gYXdhaXQgZml4dHVyZShwYWdlLCAyLCAwLCB0cnVlLCAnaW1hZ2UnKTtcclxuICBjb25zdCBjcmVhdGVkTm9kZSA9IGF3YWl0IGNyZWF0ZU5vZGUocGFnZSk7XHJcbiAgY29uc3Qgbm9kZUlkID0gKGF3YWl0IGNyZWF0ZWROb2RlLmdldEF0dHJpYnV0ZSgnZGF0YS1pZCcpKSE7XHJcbiAgY29uc3Qgbm9kZSA9IHBhZ2UubG9jYXRvcignLnJlYWN0LWZsb3dfX25vZGVbZGF0YS1pZD1cIicgKyBub2RlSWQgKyAnXCJdJyk7XHJcbiAgY29uc3Qgc2l6ZSA9IGF3YWl0IG5vZGUuYm91bmRpbmdCb3goKTtcclxuICBjb25zdCBlZGl0b3IgPSBwYWdlLmdldEJ5Um9sZSgnZGlhbG9nJywgeyBuYW1lOiAn55+t6KeG6aKR5aSN5Yi7JywgZXhhY3Q6IHRydWUgfSk7XHJcbiAgY29uc3QgcGFuZWwgPSBlZGl0b3IuZ2V0QnlSb2xlKCdyZWdpb24nLCB7IG5hbWU6ICfnn63op4bpopHlpI3liLsnLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBwYW5lbC5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+WIhuaekOaVtOadoeinhumikScsIGV4YWN0OiB0cnVlIH0pLmNsaWNrKCk7XHJcbiAgYXdhaXQgZXhwZWN0U291cmNlUHJldmlld3MocGFuZWwpO1xyXG4gIGNvbnN0IHNhdmVkQW5hbHlzaXMgPSBzdHJ1Y3R1cmVkQ2xvbmUoXHJcbiAgICBjdHguY2FudmFzKCkubm9kZXMuZmluZCgoZW50cnkpID0+IGVudHJ5LmlkID09PSBub2RlSWQpPy5kYXRhLnZpZGVvUmVjcmVhdGlvbj8uYW5hbHlzaXMsXHJcbiAgKTtcclxuICBhd2FpdCBwYW5lbC5nZXRCeVJvbGUoJ3RhYicsIHsgbmFtZTogJ+acquehruiupOivgeaNricsIGV4YWN0OiB0cnVlIH0pLmNsaWNrKCk7XHJcbiAgYXdhaXQgZXhwZWN0KHBhbmVsLmdldEJ5VGV4dChpZGVudGlmaWVkVGVtcGxhdGUudW5rbm93bnNbMF0hLCB7IGV4YWN0OiB0cnVlIH0pKS50b0JlVmlzaWJsZSgpO1xyXG4gIGF3YWl0IHBhbmVsLmdldEJ5Um9sZSgndGFiJywgeyBuYW1lOiAn5pW05L2T5pGY6KaBJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICBhd2FpdCBleHBlY3QocGFuZWwuZ2V0QnlUZXh0KCfmlbTmnaHop4bpopHkuKTkuKrkurrnianjgIHkuKTku7bnianlk4EnLCB7IGV4YWN0OiB0cnVlIH0pKS50b0JlVmlzaWJsZSgpO1xyXG4gIGNvbnN0IHJvbGUgPSBwYW5lbC5nZXRCeVJvbGUoJ2FydGljbGUnLCB7IG5hbWU6ICfkurrnianvvJrkuLvop5InLCBleGFjdDogdHJ1ZSB9KTtcclxuICBjb25zdCBoZWFkaW5nID0gcm9sZS5nZXRCeVJvbGUoJ2hlYWRpbmcnLCB7IG5hbWU6ICfkuLvop5InLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBoZWFkaW5nLmhvdmVyKCk7XHJcbiAgYXdhaXQgZXhwZWN0KHBhZ2UuZ2V0QnlSb2xlKCd0b29sdGlwJykpLnRvQ29udGFpblRleHQoJ+eUu+mdouW3puS+p+S6uueJqe+8jOWPs+aJi+aLv+edgOmmmeawtOeTticpO1xyXG4gIGF3YWl0IGV4cGVjdChwYWdlLmdldEJ5Um9sZSgndG9vbHRpcCcpKS50b0NvbnRhaW5UZXh0KCflh7rnjrDml7bpl7TvvJow4oCTMTAg56eSJyk7XHJcbiAgYXdhaXQgcGFnZS5tb3VzZS5tb3ZlKDAsIDApO1xyXG4gIGF3YWl0IGV4cGVjdChwYWdlLmdldEJ5Um9sZSgndG9vbHRpcCcpKS50b0JlSGlkZGVuKCk7XHJcbiAgY29uc3QgcHJldmlldyA9IHJvbGUuZ2V0QnlSb2xlKCdpbWcnLCB7IG5hbWU6ICfkuLvop5LnmoTljp/op4bpopHnlLvpnaInLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBwcmV2aWV3LmNsaWNrKCk7XHJcbiAgY29uc3QgZXhwYW5kZWRJbWFnZSA9IHBhZ2UubG9jYXRvcignLmFudC1pbWFnZS1wcmV2aWV3LWltZycpO1xyXG4gIGF3YWl0IGV4cGVjdChleHBhbmRlZEltYWdlKS50b0JlVmlzaWJsZSgpO1xyXG4gIGF3YWl0IGV4cGVjdChleHBhbmRlZEltYWdlKS50b0hhdmVBdHRyaWJ1dGUoJ3NyYycsIGF3YWl0IHByZXZpZXcuZ2V0QXR0cmlidXRlKCdzcmMnKSEpO1xyXG4gIGF3YWl0IHBhZ2Uuc2NyZWVuc2hvdCh7XHJcbiAgICBwYXRoOiBpbmZvLm91dHB1dFBhdGgoJ3JlY3JlYXRpb24taW1hZ2UtcHJldmlldy5wbmcnKSxcclxuICAgIGFuaW1hdGlvbnM6ICdkaXNhYmxlZCcsXHJcbiAgICBmdWxsUGFnZTogdHJ1ZSxcclxuICB9KTtcclxuICBhd2FpdCBwYWdlLmtleWJvYXJkLnByZXNzKCdFc2NhcGUnKTtcclxuICBhd2FpdCBleHBlY3QoZXhwYW5kZWRJbWFnZSkudG9CZUhpZGRlbigpO1xyXG4gIGF3YWl0IGV4cGVjdChlZGl0b3IpLnRvQmVWaXNpYmxlKCk7XHJcbiAgZXhwZWN0KGN0eC5wb3N0cykudG9IYXZlTGVuZ3RoKDEpO1xyXG4gIGV4cGVjdChjdHguZ2VuZXJhdGVzKS50b0hhdmVMZW5ndGgoMCk7XHJcblxyXG4gIGNvbnN0IHN1bW1hcnkgPSBlZGl0b3IuZ2V0QnlSb2xlKCdidXR0b24nLCB7IG5hbWU6ICfop4bpopHlj4LmlbAnLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBzdW1tYXJ5LmNsaWNrKCk7XHJcbiAgY29uc3QgZHVyYXRpb24gPSBwYWdlLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAvXuaXtumVv++8iOenku+8ie+8mi8gfSk7XHJcbiAgYXdhaXQgZHVyYXRpb24uY2xpY2soKTtcclxuICBjb25zdCBkdXJhdGlvbkRpYWxvZyA9IHBhZ2UuZ2V0QnlSb2xlKCdkaWFsb2cnLCB7IG5hbWU6ICfop4bpopHml7bplb8nLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBkdXJhdGlvbkRpYWxvZy5nZXRCeVJvbGUoJ3NwaW5idXR0b24nLCB7IG5hbWU6ICfoh6rlrprkuYnml7bplb/vvIjnp5LvvIknLCBleGFjdDogdHJ1ZSB9KS5maWxsKCc3Jyk7XHJcbiAgYXdhaXQgZHVyYXRpb25EaWFsb2dcclxuICAgIC5nZXRCeVJvbGUoJ3NwaW5idXR0b24nLCB7IG5hbWU6ICfoh6rlrprkuYnml7bplb/vvIjnp5LvvIknLCBleGFjdDogdHJ1ZSB9KVxyXG4gICAgLnByZXNzKCdFc2NhcGUnKTtcclxuICBhd2FpdCBleHBlY3QoZHVyYXRpb25EaWFsb2cpLnRvQmVIaWRkZW4oKTtcclxuICBhd2FpdCBleHBlY3QoZWRpdG9yKS50b0JlVmlzaWJsZSgpO1xyXG5cclxuICBhd2FpdCByb2xlLmdldEJ5Um9sZSgnYnV0dG9uJywgeyBuYW1lOiAn5pCc57Si5Li76KeS5pu/5o2i6LWE5rqQJywgZXhhY3Q6IHRydWUgfSkuY2xpY2soKTtcclxuICBjb25zdCBzZWFyY2ggPSBwYWdlLmdldEJ5Um9sZSgnZGlhbG9nJywgeyBuYW1lOiAn6YCJ5oup5pu/5o2i5Zu+54mHJywgZXhhY3Q6IHRydWUgfSk7XHJcbiAgYXdhaXQgZXhwZWN0KHNlYXJjaCkudG9CZVZpc2libGUoKTtcclxuICBhd2FpdCBzZWFyY2guZ2V0QnlSb2xlKCdzZWFyY2hib3gnLCB7IG5hbWU6ICfmkJzntKLpobnnm67otYTmlpknLCBleGFjdDogdHJ1ZSB9KS5maWxsKCfpobnnm67mlrDkurrniaknKTtcclxuICBjb25zdCByZXNvdXJjZSA9IHNlYXJjaC5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+a3u+WKoOWPguiAg+i1hOaWmSDpobnnm67mlrDkurrniakgdjgnLCBleGFjdDogdHJ1ZSB9KTtcclxuICBhd2FpdCBleHBlY3QocmVzb3VyY2UpLnRvQmVWaXNpYmxlKCk7XHJcbiAgZXhwZWN0KGN0eC5yZXNvdXJjZVNlYXJjaGVzLmF0KC0xKSkudG9FcXVhbCh7XHJcbiAgICBxdWVyeTogJ+mhueebruaWsOS6uueJqScsXHJcbiAgICBtZWRpYVR5cGU6ICdpbWFnZScsXHJcbiAgICBwYWdlOiAnMScsXHJcbiAgICBwcm9qZWN0SWQ6IHByb2plY3QuaWQsXHJcbiAgfSk7XHJcbiAgYXdhaXQgZXhwZWN0KHNlYXJjaC5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogL+a3u+WKoOWPguiAg+i1hOaWmSDlj4LogIPnn63op4bpopEvIH0pKS50b0hhdmVDb3VudCgwKTtcclxuICBhd2FpdCBwYWdlLnNjcmVlbnNob3Qoe1xyXG4gICAgcGF0aDogaW5mby5vdXRwdXRQYXRoKCdyZWNyZWF0aW9uLXJlc291cmNlLXNlYXJjaC5wbmcnKSxcclxuICAgIGFuaW1hdGlvbnM6ICdkaXNhYmxlZCcsXHJcbiAgICBmdWxsUGFnZTogdHJ1ZSxcclxuICB9KTtcclxuICBhd2FpdCByZXNvdXJjZS5jbGljaygpO1xyXG4gIGF3YWl0IGV4cGVjdChzZWFyY2gpLnRvQmVIaWRkZW4oKTtcclxuICBhd2FpdCBleHBlY3QoZWRpdG9yKS50b0JlVmlzaWJsZSgpO1xyXG4gIGF3YWl0IGV4cGVjdFNlbGVjdGlvbihyb2xlLmdldEJ5Um9sZSgnY29tYm9ib3gnLCB7IG5hbWU6ICfkuLvop5InLCBleGFjdDogdHJ1ZSB9KSwgJ+mhueebruaWsOS6uueJqScpO1xyXG4gIGF3YWl0IGV4cGVjdFxyXG4gICAgLnBvbGwoXHJcbiAgICAgICgpID0+IGN0eC5jYW52YXMoKS5ub2Rlcy5maW5kKChlbnRyeSkgPT4gZW50cnkuaWQgPT09IG5vZGVJZCk/LmRhdGEudmlkZW9SZWNyZWF0aW9uPy5iaW5kaW5ncyxcclxuICAgIClcclxuICAgIC50b0VxdWFsKFtcclxuICAgICAgeyByb2xlSWQ6ICdjaGFyYWN0ZXJfYScsIGFzc2V0SWQ6ICdyZW1vdGUtcGVyc29uJywgYXNzZXRWZXJzaW9uOiA4LCBuYW1lOiAn6aG555uu5paw5Lq654mpJyB9LFxyXG4gICAgXSk7XHJcbiAgY29uc3Qgc2F2ZWQgPSBjdHguY2FudmFzKCkubm9kZXMuZmluZCgoZW50cnkpID0+IGVudHJ5LmlkID09PSBub2RlSWQpITtcclxuICBleHBlY3Qoc2F2ZWQuZGF0YS52aWRlb1JlY3JlYXRpb24/LnByZXNlcnZlZFJvbGVJZHMpLnRvRXF1YWwoWydjaGFyYWN0ZXJfYiddKTtcclxuICBleHBlY3Qoc2F2ZWQuZGF0YS52aWRlb1JlY3JlYXRpb24/LnByb2R1Y3RCaW5kaW5ncyA/PyBbXSkudG9FcXVhbChbXSk7XHJcbiAgZXhwZWN0KHNhdmVkLmRhdGEudmlkZW9SZWNyZWF0aW9uPy5hbmFseXNpcykudG9FcXVhbChzYXZlZEFuYWx5c2lzKTtcclxuICBleHBlY3Qoc2F2ZWQuZGF0YS5wYXJhbWV0ZXJzPy5kdXJhdGlvbikudG9CZSg3KTtcclxuICBleHBlY3QoY3R4LnBvc3RzKS50b0hhdmVMZW5ndGgoMSk7XHJcbiAgZXhwZWN0KGN0eC5nZW5lcmF0ZXMpLnRvSGF2ZUxlbmd0aCgwKTtcclxuICBhd2FpdCBlZGl0b3IuZ2V0QnlSb2xlKCdidXR0b24nLCB7IG5hbWU6ICfnlJ/miJAnLCBleGFjdDogdHJ1ZSB9KS5jbGljaygpO1xyXG4gIGF3YWl0IGV4cGVjdC5wb2xsKCgpID0+IGN0eC5nZW5lcmF0ZXMubGVuZ3RoKS50b0JlKDEpO1xyXG4gIGV4cGVjdChjdHguZ2VuZXJhdGVzWzBdIS5zbmFwc2hvdC5wYXJhbWV0ZXJzLmR1cmF0aW9uKS50b0JlKDcpO1xyXG4gIGF3YWl0IGVkaXRvci5nZXRCeVJvbGUoJ2J1dHRvbicsIHsgbmFtZTogJ+WFs+mXree8lui+keWZqCcsIGV4YWN0OiB0cnVlIH0pLmNsaWNrKCk7XHJcbiAgYXdhaXQgZXhwZWN0KGVkaXRvcikudG9CZUhpZGRlbigpO1xyXG4gIGNvbnN0IHJlc3VsdCA9IG5vZGUubG9jYXRvcignLmZsb3ctbm9kZS1wcmV2aWV3IGltZycpO1xyXG4gIGF3YWl0IGV4cGVjdChyZXN1bHQpLnRvQmVWaXNpYmxlKCk7XHJcbiAgYXdhaXQgcmVzdWx0LmV2YWx1YXRlKChlbGVtZW50KSA9PiAoZWxlbWVudCBhcyBIVE1MSW1hZ2VFbGVtZW50KS5kZWNvZGUoKSk7XHJcbiAgY29uc3QgYWZ0ZXJHZW5lcmF0aW9uID0gYXdhaXQgbm9kZS5ib3VuZGluZ0JveCgpO1xyXG4gIGV4cGVjdChhZnRlckdlbmVyYXRpb24/LndpZHRoKS50b0JlQ2xvc2VUbyhzaXplIS53aWR0aCwgMCk7XHJcbiAgZXhwZWN0KGFmdGVyR2VuZXJhdGlvbj8uaGVpZ2h0KS50b0JlQ2xvc2VUbyhzaXplIS5oZWlnaHQsIDApO1xyXG4gIGF3YWl0IHBhZ2Uuc2NyZWVuc2hvdCh7XHJcbiAgICBwYXRoOiBpbmZvLm91dHB1dFBhdGgoJ3JlY3JlYXRpb24tZ2VuZXJhdGVkLWltYWdlLnBuZycpLFxyXG4gICAgYW5pbWF0aW9uczogJ2Rpc2FibGVkJyxcclxuICAgIGZ1bGxQYWdlOiB0cnVlLFxyXG4gIH0pO1xyXG4gIGF3YWl0IHBhZ2UucmVsb2FkKCk7XHJcbiAgYXdhaXQgZXhwZWN0KG5vZGUpLnRvQmVWaXNpYmxlKHsgdGltZW91dDogMTUwMDAgfSk7XHJcbiAgYXdhaXQgZXhwZWN0KHJlc3VsdCkudG9CZVZpc2libGUoKTtcclxuICBhd2FpdCByZXN1bHQuZXZhbHVhdGUoKGVsZW1lbnQpID0+IChlbGVtZW50IGFzIEhUTUxJbWFnZUVsZW1lbnQpLmRlY29kZSgpKTtcclxuICBjb25zdCBhZnRlclJlc3RvcmUgPSBhd2FpdCBub2RlLmJvdW5kaW5nQm94KCk7XHJcbiAgZXhwZWN0KGFmdGVyUmVzdG9yZT8ud2lkdGgpLnRvQmVDbG9zZVRvKHNpemUhLndpZHRoLCAwKTtcclxuICBleHBlY3QoYWZ0ZXJSZXN0b3JlPy5oZWlnaHQpLnRvQmVDbG9zZVRvKHNpemUhLmhlaWdodCwgMCk7XHJcbiAgZXhwZWN0KGN0eC5jYW52YXMoKS5ub2RlcykudG9IYXZlTGVuZ3RoKDIpO1xyXG4gIGV4cGVjdChjdHguY2FudmFzKCkubm9kZXMuZmluZCgoZW50cnkpID0+IGVudHJ5LmlkID09PSBub2RlSWQpPy50eXBlKS50b0JlKCd2aWRlbycpO1xyXG4gIGV4cGVjdChjdHgucG9zdHMpLnRvSGF2ZUxlbmd0aCgxKTtcclxuICBleHBlY3QoY3R4LmdlbmVyYXRlcykudG9IYXZlTGVuZ3RoKDEpO1xyXG4gIGV4cGVjdChjdHguZXJyb3JzKS50b0VxdWFsKFtdKTtcclxuICBjb25zdCBldmlkZW5jZVBhdGggPSBpbmZvLm91dHB1dFBhdGgoJ3JlY3JlYXRpb24tZ2VuZXJhdGVkLWltYWdlLWV2aWRlbmNlLmpzb24nKTtcclxuICB3cml0ZUZpbGVTeW5jKFxyXG4gICAgZXZpZGVuY2VQYXRoLFxyXG4gICAgSlNPTi5zdHJpbmdpZnkoXHJcbiAgICAgIHsgaW5pdGlhbDogc2l6ZSwgYWZ0ZXJHZW5lcmF0aW9uLCBhZnRlclJlc3RvcmUsIGNvbnNvbGVFcnJvcnM6IGN0eC5lcnJvcnMgfSxcclxuICAgICAgbnVsbCxcclxuICAgICAgMixcclxuICAgICksXHJcbiAgKTtcclxuICBhd2FpdCBpbmZvLmF0dGFjaCgn5Y6f6IqC54K55Zu+54mH5Zue5pi+5LiO5oGi5aSN5bC65a+4Jywge1xyXG4gICAgcGF0aDogZXZpZGVuY2VQYXRoLFxyXG4gICAgY29udGVudFR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJyxcclxuICB9KTtcclxufSk7XHJcbiJdLCJtYXBwaW5ncyI6IkFBQUEsU0FBU0EsTUFBTSxFQUFFQyxJQUFJLFFBQTZDLGtCQUFrQjtBQUNwRixTQUFTQyxZQUFZLEVBQUVDLGFBQWEsUUFBUSxTQUFTO0FBQ3JELFNBQ0VDLG9CQUFvQixFQUNwQkMsYUFBYSxRQUdSLDJCQUEyQjtBQUVsQ0osSUFBSSxDQUFDSyxHQUFHLENBQUM7RUFBRUMs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