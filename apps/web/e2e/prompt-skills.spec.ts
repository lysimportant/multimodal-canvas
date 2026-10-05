import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  PROMPT_OPTIMIZATION_NODE_ID,
  PROMPT_SKILLS,
  SKILL_AUTHORING_SKILL_ID,
  canvasDocumentSchema,
  createPromptOptimizationCanvas,
  type CanvasDocument,
  type MediaType,
  type PromptDocument,
  type PromptSkill,
} from '@multimodal-canvas/domain';

// 禁止 Service Worker 绕过路由拦截；只有本地前端静态资源可以继续请求。
test.use({ serviceWorkers: 'block' });

/** 显式选择非默认文字模型，验证模型别名与合成凭据成对提交。 */
const authoringModel = {
  id: 'mock-authoring-text',
  name: 'Skill 升级文字模型',
  credentialId: '123e4567-e89b-42d3-a456-426614174099',
  credentialLabel: '隔离升级 Key',
  mediaTypes: ['text'],
  available: true,
};
/** 合成升级结果只有可保存指令，不回显工作台的 JSON 字段或一次性要求。 */
const authoringInstruction =
  'Refine the supplied prompt without performing its task. Preserve {{subject}}, input/output constraints, original language and exact model/API identifiers.';

/** 隔离浏览器验收只使用本地图片和合成接口，不向供应商发请求。 */
const project = {
  id: 'prompt-skills-browser',
  name: 'Skill 集成验收',
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
};
const image = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
const original: PromptDocument = {
  version: 1,
  blocks: [
    { type: 'text', text: '以庭院为背景，保持角色 ' },
    {
      type: 'mention',
      mentionId: 'character-ref',
      assetId: 'character-image',
      assetVersion: 2,
      label: '人物参考',
      mediaType: 'image',
      semanticRole: 'character',
    },
    { type: 'text', text: ' 的服饰。' },
  ],
};

/** 序列化 API 响应，所有写入仅保存在本次测试的内存中。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 模拟用户级目录、画布保存与独立优化；未知接口和出站请求一律拒绝。 */
async function installFixture(page: Page, mediaType: MediaType = 'image') {
  let canvas = canvasDocumentSchema.parse({
    revision: 1,
    nodes: [
      {
        id: 'skill-node',
        type: mediaType,
        position: { x: 300, y: 180 },
        width: 300,
        height: 220,
        data: {
          label: '创作节点',
          mediaType,
          mode: 'generate',
          enabled: true,
          promptDocument: original,
          modelAlias: `mock-${mediaType}`,
          ...(mediaType === 'video' ? { videoMode: 'text_to_video' } : {}),
        },
      },
    ],
    edges: [],
  });
  let skills: PromptSkill[] = PROMPT_SKILLS.map((skill) => ({
    ...skill,
    builtin: true,
    enabled: true,
    revision: 1,
  }));
  const submissions: Record<string, unknown>[] = [];
  /** 用真实 domain 构造器记录合成服务端的冻结文字输入，不代表真实 API 或 Provider 执行。 */
  const optimizationRuns: Array<{
    runId: string;
    modelAlias: string;
    skill: PromptSkill;
    canvas: CanvasDocument;
  }> = [];
  /** 记录数据修改；获取合成媒体访问 URL 的 POST 不属于持久化或生成操作。 */
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const errors: string[] = [];
  const user = {
    id: 'skill-user',
    displayName: 'Skill 验收用户',
    email: 'skill@example.test',
    role: 'user',
    createdAt: '2026-09-18T00:00:00.000Z',
  };
  let serial = 0;
  let hold = false;
  const optimizations = new Map<string, Record<string, unknown>>();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript((user) => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-skill-browser',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user,
      }),
    );
  }, user);
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error('Skill 浏览器验收需要本地前端 URL');
  const preview = new URL(baseURL);
  if (
    !['http:', 'https:'].includes(preview.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(preview.hostname) ||
    preview.port === '8080'
  )
    throw new Error('Skill 浏览器验收只允许本地前端，不允许使用 8080 API 服务作为入口');
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin === preview.origin &&
      request.method() === 'GET' &&
      !url.pathname.startsWith('/v1/') &&
      ['document', 'script', 'stylesheet', 'font', 'image', 'manifest'].includes(
        request.resourceType(),
      )
    )
      return route.continue();
    errors.push(`未声明网络请求：${request.method()} ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method === 'POST' && path === '/v1/assets/character-image/access-url')
      return json(route, { url: '/v1/assets/character-image/versions/2/content' });
    if (['POST', 'PATCH', 'DELETE'].includes(method))
      writes.push({ method, path, body: request.postDataJSON() });
    if (method === 'GET' && path === '/v1/auth/me')
      return json(route, { user, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    if (method === 'GET' && path === '/v1/settings/ai')
      return json(route, { settings: { defaultModels: {} } });
    if (method === 'GET' && path === `/v1/projects/${project.id}/events`)
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (method === 'GET' && path === '/v1/projects') return json(route, { projects: [project] });
    if (method === 'GET' && path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path === `/v1/projects/${project.id}/canvas` && ['GET', 'PATCH'].includes(method)) {
      if (method === 'PATCH')
        canvas = canvasDocumentSchema.parse({
          ...request.postDataJSON(),
          revision: canvas.revision + 1,
        });
      return json(route, { canvas });
    }
    if (method === 'GET' && path === `/v1/projects/${project.id}/models/defaults`)
      return json(route, { defaults: {} });
    if (method === 'GET' && path === '/v1/models')
      return json(route, {
        models: [
          ...['text', 'image', 'video', 'audio'].map((type) => ({
            id: `mock-${type}`,
            name: `${type} 模型`,
            mediaTypes: [type],
          })),
          authoringModel,
        ],
      });
    if (method === 'GET' && path === `/v1/projects/${project.id}/runs`)
      return json(route, { runs: [] });
    if (method === 'GET' && path === '/v1/assets')
      return json(route, {
        assets: [
          {
            id: 'character-image',
            name: '人物参考',
            mediaType: 'image',
            mimeType: 'image/jpeg',
            sizeBytes: image.byteLength,
            status: 'ready',
            latestVersion: 2,
            tags: [],
            contentUrl: '/v1/assets/character-image/versions/2/content',
          },
        ],
      });
    if (
      method === 'GET' &&
      [
        '/v1/assets/character-image/versions/2/content',
        '/v1/assets/character-image/versions/2/derivatives/thumbnail',
      ].includes(path)
    )
      return route.fulfill({ contentType: 'image/jpeg', body: image });
    if (path === '/v1/prompt-skills' && ['GET', 'POST'].includes(method)) {
      if (method === 'POST') {
        const skill: PromptSkill = {
          ...request.postDataJSON(),
          id: `custom-${++serial}`,
          version: '1.0.0',
          revision: 1,
          builtin: false,
        };
        skills.push(skill);
        return json(route, { skill }, 201);
      }
      return json(route, { skills });
    }
    if (path.startsWith('/v1/prompt-skills/') && ['PATCH', 'DELETE'].includes(method)) {
      const id = decodeURIComponent(path.split('/').at(-1)!);
      const skill = skills.find((entry) => entry.id === id);
      if (!skill) return json(route, { error: 'Skill 不存在' }, 404);
      const body = method === 'PATCH' ? request.postDataJSON() : undefined;
      const revision =
        method === 'DELETE' ? Number(url.searchParams.get('revision')) : body.revision;
      if (revision !== skill.revision) return json(route, { error: '修订冲突' }, 409);
      if (
        skill.builtin &&
        (method === 'DELETE' ||
          Object.keys(body).some((field) => !['enabled', 'revision'].includes(field)))
      )
        return json(route, { error: '内置 Skill 定义不可修改' }, 403);
      if (method === 'DELETE') {
        skills = skills.filter((entry) => entry.id !== id);
        return route.fulfill({ status: 204 });
      }
      const nextRevision = revision + 1;
      const updated = {
        ...skill,
        ...body,
        revision: nextRevision,
        version: skill.builtin ? skill.version : `1.0.${nextRevision - 1}`,
      };
      skills = skills.map((entry) => (entry.id === id ? updated : entry));
      return json(route, { skill: updated });
    }
    if (method === 'POST' && path === `/v1/projects/${project.id}/prompt-optimizations`) {
      const body = request.postDataJSON();
      submissions.push(body);
      const runId = `optimization-${submissions.length}`;
      const skill = skills.find((entry) => entry.id === body.skillId);
      if (!skill || skill.enabled === false) return json(route, { error: 'Skill 不可用' }, 400);
      const isAuthoring = skill.id === SKILL_AUTHORING_SKILL_ID;
      const result = {
        runId,
        nodeId: body.nodeId,
        skillId: skill.id,
        skillVersion: skill.version,
        status: 'queued',
        modelAlias: body.modelAlias ?? 'mock-text',
        ...(body.credentialId ? { credentialId: body.credentialId } : {}),
        ...(isAuthoring ? { simulated: true } : {}),
      };
      const frozenSkill = structuredClone(skill);
      optimizationRuns.push({
        runId,
        modelAlias: result.modelAlias,
        skill: frozenSkill,
        canvas: createPromptOptimizationCanvas({
          skillId: frozenSkill.id,
          skill: frozenSkill,
          input: body.promptDocument,
          mediaType: body.mediaType,
        }),
      });
      optimizations.set(runId, {
        ...result,
        promptDocument: isAuthoring
          ? { version: 1, blocks: [{ type: 'text', text: authoringInstruction }] }
          : {
              ...body.promptDocument,
              blocks: body.promptDocument.blocks.map((block: PromptDocument['blocks'][number]) =>
                block.type === 'text' ? { ...block, text: `优化后：${block.text}` } : block,
              ),
            },
      });
      return json(route, { optimization: result }, 202);
    }
    if (method === 'GET' && path.startsWith(`/v1/projects/${project.id}/prompt-optimizations/`)) {
      const result = optimizations.get(path.split('/').at(-1)!);
      if (!result) return json(route, { error: '优化任务不存在' }, 404);
      return json(route, { optimization: { ...result, status: hold ? 'running' : 'succeeded' } });
    }
    errors.push(`未声明接口：${method} ${path}`);
    return json(route, { error: '未声明接口' }, 404);
  });
  return {
    errors,
    submissions,
    optimizationRuns,
    writes,
    canvas: () => canvas,
    skills: () => skills,
    hold: (value: boolean) => {
      hold = value;
    },
  };
}

/** 通过实际节点进入提示词编辑器。 */
/** 返回 Ant Design Select 的可见容器，用于断言已选标签或占位文案。 */
function selectContainer(select: Locator) {
  return select.locator('xpath=ancestor::div[contains(@class, "ant-select")][1]');
}

async function editor(page: Page) {
  const node = page.locator('.react-flow__node[data-id="skill-node"]');
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.getByText('尚未生成', { exact: true }).click();
  return page.locator('.node-quick-editor');
}

for (const mediaType of ['text', 'image', 'audio', 'video'] as const) {
  test(`${mediaType} 节点共用分类 Skill 并显示用途提示`, async ({ page }) => {
    const fixture = await installFixture(page, mediaType);
    await page.goto(`/projects/${project.id}`);
    const panel = await editor(page);
    const trigger = panel.getByRole('button', { name: 'Skill 配置', exact: true });
    const settings = page.getByRole('group', { name: 'Skill 配置', exact: true });
    const select = page
      .getByRole('group', { name: 'Skill 配置', exact: true })
      .getByRole('combobox', { name: '提示词 Skill', exact: true });
    await expect(trigger).toHaveText('Skill');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(settings).toBeHidden();
    await expect(select).toBeHidden();
    await expect(
      page
        .getByRole('group', { name: 'Skill 配置', exact: true })
        .getByRole('combobox', { name: '优化模型', exact: true }),
    ).toBeHidden();
    await expect(
      page
        .getByRole('group', { name: 'Skill 配置', exact: true })
        .getByRole('button', { name: '技能工作台', exact: true }),
    ).toBeHidden();
    await expect(
      page
        .getByRole('group', { name: 'Skill 配置', exact: true })
        .getByRole('button', { name: '优化提示词', exact: true }),
    ).toBeHidden();
    await trigger.hover();
    await expect(settings).toBeVisible();
    await select.click();
    await expect(page.getByRole('option', { name: '生成人物', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: '生成场景', exact: true })).toBeVisible();
    const novel = page.getByRole('option', { name: '小说正文创作', exact: true });
    await novel.getByText('小说正文创作', { exact: true }).hover();
    await expect(settings).toBeVisible();
    await expect(
      page.getByRole('tooltip').filter({
        hasText: PROMPT_SKILLS.find((skill) => skill.id === 'novel-draft')!.description,
      }),
    ).toBeVisible();
    await novel.getByText('小说正文创作', { exact: true }).click();
    await expect(selectContainer(select)).toContainText('小说正文创作');
    expect(fixture.submissions).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
  });
}

test('PC Skill 配置悬停展开、离开收起，点击固定后可用 Escape 或外点关闭', async ({
  page,
}, testInfo) => {
  const fixture = await installFixture(page);
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  const trigger = panel.getByRole('button', { name: 'Skill 配置', exact: true });
  const settings = page.getByRole('group', { name: 'Skill 配置', exact: true });
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(settings).toBeHidden();
    if (viewport.width === 1920) {
      await expect.poll(async () => (await panel.boundingBox())?.width).toBe(660);
    }
    await page.screenshot({ path: testInfo.outputPath(`skill-collapsed-${viewport.width}.png`) });
    await trigger.hover();
    await settings.hover();
    await expect(settings).toBeInViewport({ ratio: 1 });
    await expect(
      settings.getByRole('combobox', { name: '提示词 Skill', exact: true }),
    ).toBeVisible();
    await expect(settings.getByRole('combobox', { name: '优化模型', exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: '技能工作台', exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: '优化提示词', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`skill-hover-${viewport.width}.png`) });
    await page.mouse.move(0, 0);
    await expect(settings).toBeHidden();
  }
  await trigger.click();
  await page.mouse.move(0, 0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await settings.getByRole('combobox', { name: '提示词 Skill', exact: true }).click();
  const menu = page.getByRole('listbox');
  await menu.getByRole('option', { name: '生成人物', exact: true }).hover();
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const bounds = await panel.boundingBox();
  if (!bounds) throw new Error('未找到编辑器边界');
  await page.mouse.click(bounds.x + bounds.width - 6, bounds.y + bounds.height - 6);
  await expect(settings).toBeHidden();
  await trigger.click();
  await page.mouse.click(0, 0);
  await expect(settings).toBeHidden();
  expect(fixture.submissions).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test('完整编辑器不嵌套 Skill 配置，保持提示词编辑可用', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page);
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: '打开完整编辑器' }).click();
  const expanded = page.getByRole('dialog', { name: '创作节点 · 编辑设置' });
  await expect(expanded).toBeVisible();
  await expect(expanded.getByRole('button', { name: 'Skill 配置', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Skill 配置', exact: true })).toHaveCount(0);
  const prompt = expanded.getByRole('textbox', { name: '提示词', exact: true });
  await prompt.focus();
  await expect(prompt).toBeFocused();
  await prompt.fill('完整编辑器内可继续编辑');
  await expect(prompt).toHaveValue('完整编辑器内可继续编辑');
  expect(fixture.submissions).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

for (const skill of [
  { id: 'character', name: '生成人物' },
  { id: 'xianxia-dress-character', name: '仙妖同款裙装' },
  { id: 'soft-anime-atmosphere', name: '柔光日系氛围插画' },
  { id: 'extract-assets-3d', name: '三维动画资产提取' },
  { id: 'storyboard-15s', name: '十五秒分镜编排' },
  { id: 'video-breakdown', name: '视频逐镜拆解' },
]) {
  test(`${skill.name} 显式优化为独立文字任务、冻结指令与引用不变、直写可撤销和保存重载`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installFixture(page);
    const definition = structuredClone(fixture.skills().find((entry) => entry.id === skill.id)!);
    await page.goto('/projects/' + project.id);
    const panel = await editor(page);
    await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
    const settings = page.getByRole('group', { name: 'Skill 配置', exact: true });
    const select = settings.getByRole('combobox', { name: '提示词 Skill', exact: true });
    await select.click();
    await page.getByRole('option', { name: '生成场景', exact: true }).click();
    await expect.poll(() => fixture.canvas().nodes[0]!.data.promptSkillId).toBe('scene');
    expect(fixture.submissions).toEqual([]);
    expect(fixture.optimizationRuns).toEqual([]);
    await select.click();
    await page.getByRole('option', { name: skill.name, exact: true }).click();
    await expect.poll(() => fixture.canvas().nodes[0]!.data.promptSkillId).toBe(skill.id);
    expect(fixture.canvas().nodes[0]!.data.promptDocument).toEqual(original);
    expect(fixture.submissions).toEqual([]);
    expect(fixture.optimizationRuns).toEqual([]);
    expect(fixture.writes.filter((write) => write.method === 'POST')).toEqual([]);
    const optimize = settings.getByRole('button', { name: '优化提示词', exact: true });
    await optimize.click();
    const prompt = panel.getByRole('textbox', { name: '提示词', exact: true });
    await expect(prompt).toContainText('优化后：');
    await expect(page.getByRole('group', { name: '优化预览', exact: true })).toHaveCount(0);
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0]).toMatchObject({
      nodeId: 'skill-node',
      mediaType: 'image',
      skillId: skill.id,
      skillVersion: definition.version,
      promptDocument: original,
    });
    expect(fixture.optimizationRuns).toHaveLength(1);
    const run = fixture.optimizationRuns[0]!;
    expect(run).toMatchObject({
      runId: 'optimization-1',
      modelAlias: 'mock-text',
      skill: definition,
    });
    expect(run.canvas.nodes).toHaveLength(1);
    expect(run.canvas.edges).toEqual([]);
    expect(run.canvas.nodes[0]).toMatchObject({
      id: PROMPT_OPTIMIZATION_NODE_ID,
      type: 'text',
      data: {
        mediaType: 'text',
        mode: 'generate',
        promptDocument: {
          version: 1,
          blocks: [{ type: 'text', text: expect.stringContaining(definition.instruction) }],
        },
      },
    });
    const input = run.canvas.nodes[0]!.data.promptDocument!.blocks[0]!;
    if (input.type !== 'text') throw new Error('独立优化任务必须使用文字输入');
    expect(JSON.parse(input.text.split('\n').at(-1)!)).toEqual({
      prompt: '以庭院为背景，保持角色 [[SKILL_REF_1]] 的服饰。',
      references: [{ token: '[[SKILL_REF_1]]', label: '人物参考', mediaType: 'image' }],
    });
    await expect
      .poll(() => fixture.canvas().nodes[0]!.data.promptDocument?.blocks[0])
      .toEqual({
        type: 'text',
        text: '优化后：以庭院为背景，保持角色 ',
      });
    expect(
      fixture
        .canvas()
        .nodes[0]!.data.promptDocument!.blocks.filter((block) => block.type === 'mention'),
    ).toEqual(original.blocks.filter((block) => block.type === 'mention'));
    await page.screenshot({ path: testInfo.outputPath('skill-direct-desktop.png') });
    await settings.getByRole('button', { name: '撤销提示词', exact: true }).click();
    await expect(prompt).not.toContainText('优化后：');
    await expect.poll(() => fixture.canvas().nodes[0]!.data.promptDocument).toEqual(original);
    expect(fixture.submissions).toHaveLength(1);
    await optimize.click();
    await expect(prompt).toContainText('优化后：');
    await expect
      .poll(() => fixture.canvas().nodes[0]!.data.promptDocument?.blocks[0])
      .toEqual({
        type: 'text',
        text: '优化后：以庭院为背景，保持角色 ',
      });
    expect(fixture.submissions).toHaveLength(2);
    expect(fixture.submissions[1]!.idempotencyKey).not.toBe(fixture.submissions[0]!.idempotencyKey);
    await page.reload();
    const restored = await editor(page);
    await restored.getByRole('button', { name: 'Skill 配置', exact: true }).click();
    await expect(
      selectContainer(
        page
          .getByRole('group', { name: 'Skill 配置', exact: true })
          .getByRole('combobox', { name: '提示词 Skill', exact: true }),
      ),
    ).toContainText(skill.name);
    await expect(restored.getByRole('textbox', { name: '提示词', exact: true })).toContainText(
      '优化后：',
    );
    expect(fixture.submissions).toHaveLength(2);
    expect(fixture.optimizationRuns).toHaveLength(2);
    expect(fixture.optimizationRuns.map((entry) => entry.skill)).toEqual([definition, definition]);
    expect(
      fixture
        .canvas()
        .nodes[0]!.data.promptDocument!.blocks.filter((block) => block.type === 'mention'),
    ).toEqual(original.blocks.filter((block) => block.type === 'mention'));
    expect(
      fixture.writes.filter((write) => write.method === 'POST').map((write) => write.path),
    ).toEqual([
      `/v1/projects/${project.id}/prompt-optimizations`,
      `/v1/projects/${project.id}/prompt-optimizations`,
    ]);
    expect(fixture.errors).toEqual([]);
  });
}

/** 分别覆盖显式深色横幅约束与新增奶油窗光分支；输出为合成文字，不代表模型扩写质量。 */
const softAnimeSparseCases = [
  {
    name: '黑发人类雨夜横幅反向约束',
    brief: '黑发成年人类女性，雨夜书店窗边，深色外套，横构图半身',
    mockPrompt:
      '黑发成年人类女性站在雨夜书店窗边，保留人类耳部，不添加兽耳或尾巴；身穿深色外套，横幅半身构图，脸部清晰且为视觉焦点。窗框与书架建立前中后景，窗外保持蓝灰雨夜、雨痕与湿地反光，店内局部暖灯只勾勒脸侧和黑发边缘，不把深色服装漂白，也不把夜景改成高曝光日景。细浅线稿、柔和分层上色与克制纸感，无文字或水印。',
    screenshot: 'soft-anime-rainy-human-mock-desktop.png',
  },
  {
    name: '奶油窗边客厅沙发坐姿',
    brief: '成年女性，奶油窗边客厅，沙发自然坐姿，浅桃收褶连衣裙，罗纹开衫',
    mockPrompt:
      '成年女性自然坐在奶油色窗边客厅的象牙色沙发上，身穿浅桃色收褶连衣裙和象牙色罗纹开衫，领口、腰线、裙摆收褶与袖口织纹清晰。9:16 竖幅环境构图，脸部位于上三分之一并保持视觉焦点；骨盆由坐垫承托，双手自然接触裙摆，膝踝连接与前后透视可信。纱帘过滤的侧逆窗光形成柔和边缘光、暖灰接触阴影和保留中间调的奶油浅桃配色，不把人物与沙发并成泛白色块。细暖灰线条、柔和二维体积和克制纸感，无文字或水印。',
    screenshot: 'soft-anime-cream-window-mock-desktop.png',
  },
] as const;

/** 稀疏输入只验证本地 Mock 的提交、冻结与直写合同，不把预设扩写作为真实模型效果证据。 */
for (const example of softAnimeSparseCases) {
  test(
    '柔光日系氛围插画 ' + example.name + ' 保留原文，仅显式优化文字任务（Mock）',
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const fixture = await installFixture(page);
      const skill = structuredClone(
        fixture.skills().find((entry) => entry.id === 'soft-anime-atmosphere')!,
      );
      expect(skill).toMatchObject({ version: '1.1.0', id: 'soft-anime-atmosphere' });
      const brief = example.brief;
      const source: PromptDocument = { version: 1, blocks: [{ type: 'text', text: brief }] };
      fixture.canvas().nodes[0]!.data.promptDocument = source;
      const mockPrompt = example.mockPrompt;
      const optimized: PromptDocument = {
        version: 1,
        blocks: [{ type: 'text', text: mockPrompt }],
      };
      testInfo.annotations.push({
        type: 'evidence',
        description: '仅本地 Mock 合同与交互；未调用真实模型或生图，不作为模型画风验证。',
      });
      await page.route('**/prompt-optimizations/optimization-1', (route) =>
        json(route, {
          optimization: {
            runId: 'optimization-1',
            nodeId: 'skill-node',
            skillId: skill.id,
            skillVersion: skill.version,
            status: 'succeeded',
            modelAlias: 'mock-text',
            simulated: true,
            promptDocument: optimized,
          },
        }),
      );
      await page.goto(`/projects/${project.id}`);
      const panel = await editor(page);
      const prompt = panel.getByRole('textbox', { name: '提示词', exact: true });
      await expect(prompt).toContainText(brief);
      await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
      const settings = page.getByRole('group', { name: 'Skill 配置', exact: true });
      await settings.getByRole('combobox', { name: '提示词 Skill', exact: true }).click();
      await page.getByRole('option', { name: skill.name, exact: true }).click();
      await expect.poll(() => fixture.canvas().nodes[0]!.data.promptSkillId).toBe(skill.id);
      expect(fixture.submissions).toEqual([]);
      expect(fixture.optimizationRuns).toEqual([]);
      expect(fixture.writes.filter((write) => write.method === 'POST')).toEqual([]);
      await settings.getByRole('button', { name: '优化提示词', exact: true }).click();
      await expect(prompt).toHaveText(mockPrompt);
      await expect(page.getByRole('group', { name: '优化预览', exact: true })).toHaveCount(0);
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0]).toMatchObject({
        nodeId: 'skill-node',
        mediaType: 'image',
        skillId: skill.id,
        skillVersion: '1.1.0',
        promptDocument: source,
      });
      expect(fixture.optimizationRuns).toHaveLength(1);
      const run = fixture.optimizationRuns[0]!;
      expect(run.skill).toEqual(skill);
      expect(run.modelAlias).toBe('mock-text');
      expect(run.canvas.nodes).toHaveLength(1);
      expect(run.canvas.edges).toEqual([]);
      expect(run.canvas.nodes[0]).toMatchObject({
        id: PROMPT_OPTIMIZATION_NODE_ID,
        type: 'text',
        data: {
          mediaType: 'text',
          mode: 'generate',
          promptDocument: {
            version: 1,
            blocks: [{ type: 'text', text: expect.stringContaining(skill.instruction) }],
          },
        },
      });
      const input = run.canvas.nodes[0]!.data.promptDocument!.blocks[0]!;
      if (input.type !== 'text') throw new Error('独立优化任务必须使用文字输入');
      expect(JSON.parse(input.text.split('\n').at(-1)!)).toEqual({ prompt: brief, references: [] });
      await expect.poll(() => fixture.canvas().nodes[0]!.data.promptDocument).toEqual(optimized);
      await page.screenshot({ path: testInfo.outputPath(example.screenshot) });
      expect(
        fixture.writes.filter((write) => write.method === 'POST').map((write) => write.path),
      ).toEqual([`/v1/projects/${project.id}/prompt-optimizations`]);
      expect(fixture.errors).toEqual([]);
    },
  );
}

test('工作台升级要求变化后旧预览不可覆盖，丢弃不改画布或指令', async ({ page }) => {
  const fixture = await installFixture(page);
  const beforeCanvas = structuredClone(fixture.canvas());
  const beforeSkills = structuredClone(fixture.skills());
  fixture.hold(true);
  await page.goto('/projects/' + project.id);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await page.getByRole('button', { name: '技能工作台', exact: true }).click();
  const workbench = page.getByRole('dialog', { name: 'Skill 工作台', exact: true });
  const assistant = workbench.getByRole('complementary', { name: 'AI 升级 Skill', exact: true });
  const requirements = assistant.getByRole('textbox', { name: 'Skill 升级要求', exact: true });
  await requirements.fill('Clarify the reusable instruction without performing the task.');
  await assistant.getByRole('button', { name: '生成升级预览', exact: true }).click();
  await expect.poll(() => fixture.submissions.length).toBe(1);
  await requirements.fill('Preserve literal placeholders and add source-evidence requirements.');
  fixture.hold(false);
  const preview = assistant.getByRole('group', { name: 'Skill 升级预览', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('button', { name: '采用到草稿', exact: true })).toBeDisabled();
  await expect(preview.getByText('草稿或升级要求已改变', { exact: false })).toBeVisible();
  await preview.getByRole('button', { name: '丢弃', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(requirements).toHaveValue(
    'Preserve literal placeholders and add source-evidence requirements.',
  );
  expect(fixture.canvas()).toEqual(beforeCanvas);
  expect(fixture.skills()).toEqual(beforeSkills);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]!.path).toBe('/v1/projects/' + project.id + '/prompt-optimizations');
  expect(fixture.errors).toEqual([]);
});

test('目录加载期间保留已存选择，不能误清空，完成后仍可保存重载', async ({ page }) => {
  const fixture = await installFixture(page);
  fixture.canvas().nodes[0]!.data.promptSkillId = 'character';
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/v1/prompt-skills', async (route) => {
    await loaded;
    return route.fallback();
  });
  try {
    await page.goto(`/projects/${project.id}`);
    const panel = await editor(page);
    await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
    const select = page
      .getByRole('group', { name: 'Skill 配置', exact: true })
      .getByRole('combobox', { name: '提示词 Skill', exact: true });
    await expect(select).toBeDisabled();
    await expect(selectContainer(select)).toContainText('Skill 目录加载中');
    await expect(
      page.getByRole('group', { name: 'Skill 配置', exact: true }).getByRole('alert'),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole('group', { name: 'Skill 配置', exact: true })
        .getByRole('button', { name: '优化提示词', exact: true }),
    ).toBeDisabled();
    await expect(panel.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
    expect(fixture.canvas().nodes[0]!.data.promptSkillId).toBe('character');
    release();
    await expect(select).toBeEnabled();
    await expect(selectContainer(select)).toContainText('生成人物');
    await panel.getByRole('textbox', { name: '提示词', exact: true }).press('Control+End');
    await page.keyboard.insertText('保留原选择');
    await expect.poll(() => fixture.canvas().revision).toBeGreaterThan(1);
    expect(fixture.canvas().nodes[0]!.data.promptSkillId).toBe('character');
    await page.reload();
    const restored = await editor(page);
    await restored.getByRole('button', { name: 'Skill 配置', exact: true }).click();
    await expect(
      selectContainer(
        page
          .getByRole('group', { name: 'Skill 配置', exact: true })
          .getByRole('combobox', { name: '提示词 Skill', exact: true }),
      ),
    ).toContainText('生成人物');
    expect(fixture.submissions).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    release();
  }
});

test('优化直写后 Ctrl+S 到达全局保存且不触发浏览器另存', async ({ page }) => {
  const fixture = await installFixture(page);
  fixture.canvas().nodes[0]!.data.promptSkillId = 'character';
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await page
    .getByRole('group', { name: 'Skill 配置', exact: true })
    .getByRole('button', { name: '优化提示词', exact: true })
    .click();
  const prompt = panel.getByRole('textbox', { name: '提示词', exact: true });
  await expect(prompt).toContainText('优化后：');
  await panel.getByRole('textbox', { name: '提示词', exact: true }).press('Control+End');
  await page.keyboard.insertText('保存新要求');
  await page.evaluate(() => {
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.ctrlKey && event.key === 's')
          setTimeout(() => {
            document.body.dataset.savePrevented = String(event.defaultPrevented);
          }, 0);
      },
      true,
    );
  });
  await prompt.press('Control+s');
  await expect(page.locator('body')).toHaveAttribute('data-save-prevented', 'true');
  await expect.poll(() => JSON.stringify(fixture.canvas())).toContain('保存新要求');
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('长用途说明不挤没选项，鼠标和键盘都可继续选择', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const fixture = await installFixture(page);
  fixture.skills().unshift({
    id: 'custom-long-description',
    name: '长说明技能',
    category: '自定义',
    description: '用途说明'.repeat(500),
    instruction: 'Refine the prompt.',
    version: '1.0.0',
    enabled: true,
  });
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  const select = page
    .getByRole('group', { name: 'Skill 配置', exact: true })
    .getByRole('combobox', { name: '提示词 Skill', exact: true });
  await select.click();
  const option = page.getByRole('option', { name: '长说明技能', exact: true });
  await option.getByText('长说明技能', { exact: true }).hover();
  const hoverTip = page.getByRole('tooltip').filter({ hasText: '用途说明' });
  await expect(hoverTip).toBeVisible();
  const menu = page.getByRole('listbox');
  await expect(menu).toBeVisible();
  const tip = page.getByRole('tooltip').filter({ hasText: '用途说明' }).last();
  const tipBody = tip;
  const geometry = await tipBody.evaluate((element) => ({
    bottom: element.getBoundingClientRect().bottom,
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    viewportHeight: window.innerHeight,
  }));
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.overflowY).toMatch(/auto|scroll/);
  await tip.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => tipBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('skill-long-description.png') });
  await option.click();
  await expect(selectContainer(select)).toContainText('长说明技能');
  await select.press('Enter');
  await expect(menu).toBeVisible();
  await select.press('ArrowUp');
  await select.press('Enter');
  await expect(selectContainer(select)).toContainText('不使用 Skill');
  await expect(selectContainer(select)).not.toContainText('长说明技能');
  expect(fixture.errors).toEqual([]);
});

test('PC 小视口多引用优化直写不遮挡生成控件并可撤销', async ({ page }, testInfo) => {
  const fixture = await installFixture(page);
  const node = fixture.canvas().nodes[0]!;
  const mention = original.blocks[1]!;
  if (mention.type !== 'mention') throw new Error('缺少引用夹具');
  node.data.promptSkillId = 'character';
  node.data.promptDocument = {
    version: 1,
    blocks: [
      { type: 'text', text: '第一段\n'.repeat(10) },
      mention,
      { type: 'text', text: '第二段\n'.repeat(10) },
      { ...mention, mentionId: 'second-ref' },
      { type: 'text', text: '第三段\n'.repeat(10) },
    ],
  };
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await page
    .getByRole('group', { name: 'Skill 配置', exact: true })
    .getByRole('button', { name: '优化提示词', exact: true })
    .click();
  const prompt = panel.getByRole('textbox', { name: '提示词', exact: true });
  await expect(prompt).toContainText('优化后：');
  await expect(page.getByRole('group', { name: '优化预览', exact: true })).toHaveCount(0);
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(panel).toBeInViewport({ ratio: 0.99 });
    await expect
      .poll(() =>
        panel.evaluate((element) => {
          const editor = element.getBoundingClientRect();
          const node = document
            .querySelector('.react-flow__node[data-id="skill-node"]')!
            .getBoundingClientRect();
          return (
            editor.right <= node.left ||
            editor.left >= node.right ||
            editor.bottom <= node.top ||
            editor.top >= node.bottom
          );
        }),
      )
      .toBe(true);
    await panel.getByRole('button', { name: '生成', exact: true }).scrollIntoViewIfNeeded();
    await expect(
      panel.locator('.node-quick-editor-controls').filter({
        has: page.getByRole('button', { name: '生成', exact: true }),
      }),
    ).toBeInViewport({ ratio: 0.99 });
    const modelSelect = panel.getByRole('combobox', { name: /^模型：/ });
    await modelSelect.scrollIntoViewIfNeeded();
    await expect(modelSelect).toBeInViewport({ ratio: 0.99 });
    expect((await modelSelect.boundingBox())!.width).toBeGreaterThanOrEqual(100);
    await modelSelect.click();
    await expect(page.getByRole('listbox', { name: '模型选项', exact: true })).toBeVisible();
    await modelSelect.press('Escape');
    const configuration = page.getByRole('group', { name: 'Skill 配置', exact: true });
    if (!(await configuration.isVisible())) {
      await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
    }
    await expect(configuration).toBeVisible();
    const undo = configuration.getByRole('button', { name: '撤销提示词', exact: true });
    await expect(undo).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`skill-long-direct-${viewport.width}.png`),
    });
  }
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).hover();
  await page.getByRole('group', { name: 'Skill 配置', exact: true }).hover();
  await page
    .getByRole('group', { name: 'Skill 配置', exact: true })
    .getByRole('button', { name: '撤销提示词', exact: true })
    .click();
  await expect(prompt).not.toContainText('优化后：');
  await page.setViewportSize({ width: 1366, height: 768 });
  await panel.getByRole('button', { name: '打开完整编辑器' }).click();
  const expanded = page.getByRole('dialog', { name: '创作节点 · 编辑设置' });
  await expect(expanded.getByRole('textbox', { name: '提示词', exact: true })).not.toContainText(
    '优化后：',
  );
  await expanded.getByRole('button', { name: '关闭编辑器', exact: true }).click();
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('已确认的资源-only成功结果允许手动重新优化且保留原文', async ({ page }) => {
  const fixture = await installFixture(page);
  fixture.canvas().nodes[0]!.data.promptSkillId = 'character';
  await page.route('**/prompt-optimizations/optimization-1', (route) =>
    json(route, {
      optimization: {
        runId: 'optimization-1',
        nodeId: 'skill-node',
        skillId: 'character',
        skillVersion: PROMPT_SKILLS.find((skill) => skill.id === 'character')!.version,
        status: 'succeeded',
        modelAlias: 'mock-text',
        promptDocument: {
          version: 1,
          blocks: original.blocks.filter((block) => block.type === 'mention'),
        },
      },
    }),
  );
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await page
    .getByRole('group', { name: 'Skill 配置', exact: true })
    .getByRole('button', { name: '优化提示词', exact: true })
    .click();
  await expect(
    page.getByRole('group', { name: 'Skill 配置', exact: true }).getByRole('alert'),
  ).toContainText('缺少提示词文字');
  await expect(
    page
      .getByRole('group', { name: 'Skill 配置', exact: true })
      .getByRole('button', { name: '优化提示词', exact: true }),
  ).toBeEnabled();
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.canvas().nodes[0]!.data.promptDocument).toEqual(original);
  await page
    .getByRole('group', { name: 'Skill 配置', exact: true })
    .getByRole('button', { name: '优化提示词', exact: true })
    .click();
  await expect(panel.getByRole('textbox', { name: '提示词', exact: true })).toContainText(
    '优化后：',
  );
  await expect(
    page
      .getByRole('group', { name: 'Skill 配置', exact: true })
      .getByRole('button', { name: '撤销提示词', exact: true }),
  ).toBeVisible();
  expect(fixture.submissions).toHaveLength(2);
  expect(fixture.submissions[0]!.idempotencyKey).not.toBe(fixture.submissions[1]!.idempotencyKey);
  expect(fixture.errors).toEqual([]);
});

/** 比较普通、悬停与键盘焦点状态的真实几何，防止 Ant 边框恢复后多出滚动条。 */
test('工作台列表 hover 不增高、不横向溢出或新增内部滚动条', async ({ page }, testInfo) => {
  const fixture = await installFixture(page);
  const longName = 'SkillLongName'.repeat(9);
  fixture.skills().push({
    id: 'long-workbench-entry',
    name: longName,
    category: 'LongCategory'.repeat(6),
    description: 'UnbrokenDescription'.repeat(100),
    instruction: 'Preserve {{subject}} exactly.',
    version: '1.0.0',
    revision: 1,
    builtin: false,
    enabled: true,
  });
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await page.getByRole('button', { name: '技能工作台', exact: true }).click();
  const workbench = page.getByRole('dialog', { name: 'Skill 工作台', exact: true });
  const list = workbench.getByRole('list', { name: 'Skill 列表' });
  const items = list.locator('.skill-library-item');
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    for (const index of [0, Math.floor(fixture.skills().length / 2), fixture.skills().length - 1]) {
      const item = items.nth(index);
      await item.scrollIntoViewIfNeeded();
      await workbench.getByRole('heading', { name: 'Skill 工作台', exact: true }).hover();
      const before = await item.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const list = element.closest('.skill-library-list')!;
        return {
          width: bounds.width,
          height: bounds.height,
          clientWidth: list.clientWidth,
          scrollWidth: list.scrollWidth,
          scrollHeight: list.scrollHeight,
        };
      });
      await item.hover();
      await expect
        .poll(() =>
          item.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const list = element.closest('.skill-library-list')!;
            return {
              width: bounds.width,
              height: bounds.height,
              clientWidth: list.clientWidth,
              scrollWidth: list.scrollWidth,
              scrollHeight: list.scrollHeight,
            };
          }),
        )
        .toEqual(before);
      expect(before.scrollWidth).toBeLessThanOrEqual(before.clientWidth);
      await item.focus();
      await expect(item).toBeFocused();
      const innerScrollers = await list.evaluate((element) =>
        [...element.querySelectorAll('*')]
          .filter((child) => {
            const style = getComputedStyle(child);
            return (
              (['auto', 'scroll'].includes(style.overflowX) &&
                child.scrollWidth > child.clientWidth) ||
              (['auto', 'scroll'].includes(style.overflowY) &&
                child.scrollHeight > child.clientHeight)
            );
          })
          .map((child) => child.className),
      );
      expect(innerScrollers).toEqual([]);
    }
    expect(await workbench.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  await workbench.getByRole('searchbox', { name: '搜索 Skill' }).fill(longName);
  await expect(items).toHaveCount(1);
  await items.first().hover();
  expect(
    await list.evaluate((element) => ({
      width: element.scrollWidth <= element.clientWidth,
      height: element.scrollHeight <= element.clientHeight,
    })),
  ).toEqual({ width: true, height: true });
  await items.first().press('Enter');
  await expect(workbench.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(longName);
  await page.screenshot({ path: testInfo.outputPath('skill-workbench-hover.png') });
  expect(fixture.writes).toEqual([]);
  expect(fixture.submissions).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

/** 中文只作读取视图；切换、复制与保存均校验服务端模型中的执行原文。 */
test('工作台中文说明与执行原文切换，复制及导入内容保持原文', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page);
  const builtin = structuredClone(fixture.skills()[0]!);
  const imported: PromptSkill = {
    ...builtin,
    id: 'imported-english-skill',
    name: '导入英文指令',
    builtin: false,
    instruction:
      'Preserve {{subject}}, model-id and "quoted literals". Do not translate this instruction.',
  };
  fixture.skills().push(imported);
  const originals = structuredClone(fixture.skills());
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await page.getByRole('button', { name: '技能工作台', exact: true }).click();
  const workbench = page.getByRole('dialog', { name: 'Skill 工作台', exact: true });
  const chinese = workbench.getByRole('region', { name: '指令中文说明' });
  const original = workbench.getByRole('textbox', { name: '指令', exact: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect(chinese).toBeVisible();
    await expect(chinese).toContainText('主角欲望');
    await expect(chinese).toContainText('不照搬参考故事');
    await expect(chinese).toContainText('不写故事本身');
    await workbench.getByRole('button', { name: '执行原文', exact: true }).click();
    await expect(original).toHaveValue(builtin.instruction);
    await expect(original).toHaveAttribute('readonly', '');
    await workbench.getByRole('button', { name: '中文说明', exact: true }).click();
  }
  const dress = fixture.skills().find((skill) => skill.id === 'xianxia-dress-character')!;
  await workbench.getByRole('button', { name: dress.name, exact: true }).click();
  await expect(chinese).toContainText('明确为未成年时');
  await expect(chinese).toContainText('资源标记仍只按原顺序出现一次');
  await expect(chinese).toContainText('不声称看过图像');
  await expect(chinese).toContainText('Stable Diffusion');
  await chinese.locator('p').last().scrollIntoViewIfNeeded();
  expect(await chinese.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await workbench.getByRole('button', { name: '执行原文', exact: true }).click();
  await expect(original).toHaveValue(dress.instruction);
  await workbench.getByRole('button', { name: builtin.name, exact: true }).click();
  expect(fixture.skills()).toEqual(originals);
  expect(fixture.writes).toEqual([]);
  expect(fixture.submissions).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('skill-workbench-chinese.png') });
  await workbench.getByRole('button', { name: '复制为新 Skill', exact: true }).click();
  await expect(original).toHaveValue(builtin.instruction);
  await expect(original).not.toHaveAttribute('readonly', '');
  await expect(workbench.getByRole('group', { name: '指令显示' })).toHaveCount(0);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]).toMatchObject({
    method: 'POST',
    path: '/v1/prompt-skills',
    body: { instruction: builtin.instruction },
  });
  await workbench.getByRole('button', { name: imported.name, exact: true }).click();
  await expect(original).toHaveValue(imported.instruction);
  await expect(chinese).toHaveCount(0);
  await expect(
    workbench.getByText('执行原文保持原样；自定义、导入或未匹配本地版本的指令不自动翻译。'),
  ).toBeVisible();
  await workbench.getByRole('textbox', { name: '说明', exact: true }).fill('只更新说明');
  await workbench.getByRole('button', { name: '保存 Skill', exact: true }).click();
  await expect.poll(() => fixture.writes.length).toBe(2);
  expect(fixture.writes[1]).toMatchObject({
    method: 'PATCH',
    body: { instruction: imported.instruction, description: '只更新说明' },
  });
  expect(fixture.skills().find((skill) => skill.id === builtin.id)).toEqual(builtin);
  expect(fixture.submissions).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('工作台增改查复制启停删除，所有节点同步目录', async ({ page }, testInfo) => {
  const fixture = await installFixture(page);
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await page
    .getByRole('group', { name: 'Skill 配置', exact: true })
    .getByRole('button', { name: '技能工作台', exact: true })
    .click();
  const workbench = page.getByRole('dialog', { name: 'Skill 工作台', exact: true });
  await expect(workbench.getByRole('region', { name: '指令中文说明' })).toBeVisible();
  await workbench.getByRole('button', { name: '执行原文', exact: true }).click();
  await expect(workbench.getByRole('textbox', { name: '指令', exact: true })).toHaveAttribute(
    'readonly',
    '',
  );
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(workbench).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath(`skill-workbench-${viewport.width}.png`) });
  }
  await workbench.getByRole('button', { name: '新建 Skill', exact: true }).click();
  await workbench.getByRole('textbox', { name: '名称', exact: true }).fill('悬疑章节节奏');
  await workbench.getByRole('combobox', { name: '分类', exact: true }).fill('小说创作');
  await workbench
    .getByRole('textbox', { name: '说明', exact: true })
    .fill('保留线索与悬念，调整章节节奏。');
  await workbench
    .getByRole('textbox', { name: '指令', exact: true })
    .fill('Refine pacing while preserving clues, names and chronology.');
  await workbench.getByRole('button', { name: '保存 Skill', exact: true }).click();
  await expect(workbench.getByRole('button', { name: '悬疑章节节奏', exact: true })).toBeVisible();
  await workbench.getByRole('textbox', { name: '名称', exact: true }).fill('悬疑节奏修订');
  await workbench.getByRole('button', { name: '保存 Skill', exact: true }).click();
  await expect(workbench.getByRole('button', { name: '悬疑节奏修订', exact: true })).toBeVisible();
  await workbench.getByRole('checkbox', { name: '启用 Skill' }).click();
  await expect(workbench.getByRole('checkbox', { name: '启用 Skill' })).not.toBeChecked();
  await expect
    .poll(() => fixture.skills().find((skill) => skill.name === '悬疑节奏修订')?.enabled)
    .toBe(false);
  await workbench.getByRole('checkbox', { name: '启用 Skill' }).click();
  await expect(workbench.getByRole('checkbox', { name: '启用 Skill' })).toBeChecked();
  await expect
    .poll(() => fixture.skills().find((skill) => skill.name === '悬疑节奏修订')?.enabled)
    .toBe(true);
  await workbench.getByRole('button', { name: '复制为新 Skill' }).click();
  await expect(workbench.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(
    '悬疑节奏修订（副本）',
  );
  await workbench.getByRole('button', { name: '删除 Skill', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认删除' }).click();
  await expect(
    workbench.getByRole('button', { name: '悬疑节奏修订（副本）', exact: true }),
  ).toHaveCount(0);
  await workbench.getByRole('button', { name: '关闭 Skill 工作台' }).click();
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await page
    .getByRole('group', { name: 'Skill 配置', exact: true })
    .getByRole('combobox', { name: '提示词 Skill', exact: true })
    .click();
  await page.getByRole('option', { name: '悬疑节奏修订', exact: true }).click();
  await expect(
    selectContainer(
      page
        .getByRole('group', { name: 'Skill 配置', exact: true })
        .getByRole('combobox', { name: '提示词 Skill', exact: true }),
    ),
  ).toContainText('悬疑节奏修订');
  expect(fixture.errors).toEqual([]);
});

for (const sourceKind of ['custom', 'builtin'] as const) {
  test(`工作台 AI 升级：${sourceKind === 'custom' ? '自定义仅采用到草稿再 PATCH 保存' : '内置采用为未保存副本再 POST 保存'}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installFixture(page);
    const builtin = sourceKind === 'builtin';
    const source: PromptSkill = builtin
      ? fixture.skills().find((skill) => skill.id === 'character')!
      : {
          id: 'custom-authoring-source',
          name: '精确占位符优化',
          category: '技能创作',
          description: '只优化可复用提示词，保留精确占位符。',
          instruction: 'Refine {{subject}} prompts without performing their downstream task.',
          version: '1.0.6',
          revision: 7,
          builtin: false,
          enabled: true,
        };
    if (!builtin) fixture.skills().push(source);
    const beforeSkill = structuredClone(source);
    const beforeCanvas = structuredClone(fixture.canvas());
    const beforeCount = fixture.skills().length;
    await page.goto(`/projects/${project.id}`);
    const panel = await editor(page);
    await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
    await page.getByRole('button', { name: '技能工作台', exact: true }).click();
    const workbench = page.getByRole('dialog', { name: 'Skill 工作台', exact: true });
    await workbench.getByRole('button', { name: source.name, exact: true }).click();
    if (builtin) await workbench.getByRole('button', { name: '执行原文', exact: true }).click();
    const instruction = workbench.getByRole('textbox', { name: '指令', exact: true });
    await expect(instruction).toHaveValue(source.instruction);
    const assistant = workbench.getByRole('complementary', { name: 'AI 升级 Skill', exact: true });
    await expect(assistant).toBeVisible();
    const requirements =
      'Preserve exact placeholders and API identifiers. Clarify reusable input/output rules; do not execute the Skill.';
    await assistant
      .getByRole('textbox', { name: 'Skill 升级要求', exact: true })
      .fill(requirements);
    await assistant.getByRole('combobox', { name: '优化模型', exact: true }).click();
    await workbench
      .getByRole('option', {
        name: `${authoringModel.name} · ${authoringModel.credentialLabel}`,
        exact: true,
      })
      .click();
    fixture.hold(true);
    await assistant.getByRole('button', { name: '生成升级预览', exact: true }).click();
    await expect.poll(() => fixture.submissions.length).toBe(1);
    const submitted = fixture.submissions[0]!;
    expect(submitted).toEqual({
      nodeId: `skill-workbench:${source.id}`,
      skillId: SKILL_AUTHORING_SKILL_ID,
      skillVersion: '1.0.0',
      mediaType: 'text',
      promptDocument: {
        version: 1,
        blocks: [{ type: 'text', text: expect.any(String) }],
      },
      idempotencyKey: expect.any(String),
      modelAlias: authoringModel.id,
      credentialId: authoringModel.credentialId,
    });
    const promptDocument = submitted.promptDocument as PromptDocument;
    const block = promptDocument.blocks[0]!;
    if (block.type !== 'text') throw new Error('升级请求必须使用单个文字块');
    expect(JSON.parse(block.text)).toEqual({
      task: 'Improve this reusable prompt-optimization Skill. Do not perform its task.',
      skill: {
        name: source.name,
        category: source.category,
        description: source.description,
        instruction: source.instruction,
      },
      requirements,
      output:
        'Only the revised reusable Skill instruction, preserving its language and exact placeholders. Do not repeat the surrounding metadata. Maximum 12000 characters.',
    });
    const optimizationWrite = {
      method: 'POST',
      path: `/v1/projects/${project.id}/prompt-optimizations`,
      body: submitted,
    };
    expect(fixture.writes).toEqual([optimizationWrite]);
    await expect(assistant.getByRole('button', { name: '升级中', exact: true })).toBeDisabled();
    expect(fixture.skills().find((skill) => skill.id === source.id)).toEqual(beforeSkill);
    fixture.hold(false);
    const preview = assistant.getByRole('group', { name: 'Skill 升级预览', exact: true });
    await expect(preview).toBeVisible();
    const previewInstruction = preview.getByRole('textbox', {
      name: '升级后的 Skill 指令 1',
      exact: true,
    });
    await expect(previewInstruction).toHaveValue(authoringInstruction);
    const adoptedInstruction = `${authoringInstruction}\nKeep literal examples unchanged.`;
    await previewInstruction.fill(adoptedInstruction);
    await expect(instruction).toHaveValue(source.instruction);
    if (builtin) await expect(instruction).toHaveAttribute('readonly', '');
    const adopt = preview.getByRole('button', { name: '采用到草稿', exact: true });
    for (const viewport of [
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await adopt.scrollIntoViewIfNeeded();
      await expect(workbench).toBeInViewport({ ratio: 1 });
      await expect(adopt).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      await page.screenshot({
        path: testInfo.outputPath(`skill-authoring-${sourceKind}-preview-${viewport.width}.png`),
      });
    }
    await adopt.click();
    const savedName = builtin ? `${source.name}（升级版）` : source.name;
    await expect(instruction).toHaveValue(adoptedInstruction);
    await expect(instruction).not.toHaveAttribute('readonly', '');
    await expect(workbench.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(
      savedName,
    );
    await expect(workbench.getByRole('combobox', { name: '分类', exact: true })).toHaveValue(
      source.category,
    );
    await expect(workbench.getByRole('textbox', { name: '说明', exact: true })).toHaveValue(
      source.description,
    );
    expect(fixture.skills()).toHaveLength(beforeCount);
    expect(fixture.skills().find((skill) => skill.id === source.id)).toEqual(beforeSkill);
    expect(fixture.writes).toEqual([optimizationWrite]);
    expect(fixture.canvas()).toEqual(beforeCanvas);
    await workbench.getByRole('button', { name: '保存 Skill', exact: true }).click();
    await expect
      .poll(() => fixture.skills().find((skill) => skill.name === savedName)?.instruction)
      .toBe(adoptedInstruction);
    const saved = fixture.skills().find((skill) => skill.name === savedName)!;
    expect(saved).toMatchObject({
      builtin: false,
      name: savedName,
      category: source.category,
      description: source.description,
      instruction: adoptedInstruction,
      enabled: true,
      revision: builtin ? 1 : source.revision! + 1,
    });
    if (builtin) {
      expect(saved.id).not.toBe(source.id);
      expect(fixture.skills()).toHaveLength(beforeCount + 1);
      expect(fixture.skills().find((skill) => skill.id === source.id)).toEqual(beforeSkill);
    } else {
      expect(saved.id).toBe(source.id);
      expect(fixture.skills()).toHaveLength(beforeCount);
    }
    expect(fixture.writes).toEqual([
      optimizationWrite,
      {
        method: builtin ? 'POST' : 'PATCH',
        path: builtin ? '/v1/prompt-skills' : `/v1/prompt-skills/${source.id}`,
        body: {
          name: savedName,
          category: source.category,
          description: source.description,
          instruction: adoptedInstruction,
          enabled: true,
          ...(builtin ? {} : { revision: source.revision }),
        },
      },
    ]);
    expect(fixture.canvas()).toEqual(beforeCanvas);
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  });
}

/** 核对工具包扩充后的真实工作台目录；只验证界面与合同，不代表模型输出质量。 */
test('应用内 Skill 目录保留三十三项及原有顺序并提供匹配版本的中文说明', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page);
  expect(fixture.skills()).toHaveLength(33);
  expect(fixture.skills().map((skill) => skill.id)).toEqual([
    'novel-premise',
    'novel-outline',
    'novel-draft',
    'novel-revise',
    'character',
    'xianxia-dress-character',
    'character-views',
    'scene',
    'scene-views',
    'prop',
    'extract-assets',
    'screenplay',
    'storyboard',
    'image-quality',
    'camera',
    'expression',
    'action',
    SKILL_AUTHORING_SKILL_ID,
    'novel-adaptation',
    'story-analysis',
    'video-breakdown',
    'short-video',
    'extract-assets-3d',
    'extract-assets-live-action',
    'prop-views',
    'screenplay-urban',
    'screenplay-historical',
    'screenplay-xianxia',
    'screenplay-fantasy',
    'storyboard-10s',
    'storyboard-15s',
    'visual-effects',
    'soft-anime-atmosphere',
  ]);
  expect(fixture.skills().at(-1)).toMatchObject({
    id: 'soft-anime-atmosphere',
    name: '柔光日系氛围插画',
    version: '1.1.0',
    category: '人物与场景',
  });
  await page.goto('/projects/' + project.id);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await page.getByRole('button', { name: '技能工作台', exact: true }).click();
  const workbench = page.getByRole('dialog', { name: 'Skill 工作台', exact: true });
  for (const skill of fixture.skills()) {
    await workbench.getByRole('button', { name: skill.name, exact: true }).click();
    const chinese = workbench.getByRole('region', { name: '指令中文说明' });
    await expect(chinese).toBeVisible();
    await expect(chinese).toContainText(/[一-鿿]/);
    if (skill.id === 'soft-anime-atmosphere') {
      await expect(chinese).toContainText('日系');
      await expect(chinese).toContainText('2D');
      await expect(chinese).toContainText('针织');
      await expect(chinese).toContainText('蕾丝');
      await expect(chinese).toContainText('第五种奶油窗光客厅搭配');
      await expect(chinese).toContainText('小圆领或娃娃领');
      await expect(chinese).toContainText('纱帘过滤的侧逆窗光');
      await expect(chinese).toContainText('骨盆由坐垫承托，双手接触自然');
      await expect(chinese).toContainText('不自动添加');
      await expect(chinese).toContainText(/雨夜[^。]*不[^。]*(?:漂白|高曝光|日景)/);
    }
    await workbench.getByRole('button', { name: '执行原文', exact: true }).click();
    await expect(workbench.getByRole('textbox', { name: '指令', exact: true })).toHaveValue(
      skill.instruction,
    );
    await workbench.getByRole('button', { name: '中文说明', exact: true }).click();
  }
  await page.screenshot({ path: testInfo.outputPath('toolkit-skills-workbench-desktop.png') });
  expect(fixture.writes).toEqual([]);
  expect(fixture.submissions).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
