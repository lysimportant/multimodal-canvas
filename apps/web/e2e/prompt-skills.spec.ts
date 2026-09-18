import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  PROMPT_SKILLS,
  canvasDocumentSchema,
  type MediaType,
  type PromptDocument,
  type PromptSkill,
} from '@multimodal-canvas/domain';

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

/** 模拟用户级目录、画布保存与独立优化，记录意外调用和脚本错误。 */
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
  const errors: string[] = [];
  let serial = 0;
  let hold = false;
  const optimizations = new Map<string, Record<string, unknown>>();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-skill-browser',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        user: {
          id: 'skill-user',
          email: 'skill@example.test',
          role: 'user',
          createdAt: '2026-09-18T00:00:00.000Z',
        },
      }),
    );
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/v1/projects') return json(route, { projects: [project] });
    if (path === `/v1/projects/${project.id}`) return json(route, { project });
    if (path.endsWith('/canvas')) {
      if (method === 'PATCH')
        canvas = canvasDocumentSchema.parse({
          ...request.postDataJSON(),
          revision: canvas.revision + 1,
        });
      return json(route, { canvas });
    }
    if (path.endsWith('/models/defaults')) return json(route, { defaults: {} });
    if (path === '/v1/models')
      return json(route, {
        models: ['text', 'image', 'video', 'audio'].map((type) => ({
          id: `mock-${type}`,
          name: `${type} 模型`,
          mediaTypes: [type],
        })),
      });
    if (path.endsWith('/runs')) return json(route, { runs: [] });
    if (path === '/v1/assets')
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
    if (path.endsWith('/content')) return route.fulfill({ contentType: 'image/jpeg', body: image });
    if (path.endsWith('/access-url'))
      return json(route, { url: '/v1/assets/character-image/versions/2/content' });
    if (path === '/v1/prompt-skills') {
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
    if (path.startsWith('/v1/prompt-skills/')) {
      const id = decodeURIComponent(path.split('/').at(-1)!);
      const skill = skills.find((entry) => entry.id === id)!;
      const revision =
        method === 'DELETE'
          ? Number(url.searchParams.get('revision'))
          : request.postDataJSON().revision;
      if (revision !== skill.revision) return json(route, { error: '修订冲突' }, 409);
      if (method === 'DELETE') {
        skills = skills.filter((entry) => entry.id !== id);
        return route.fulfill({ status: 204 });
      }
      const nextRevision = revision + 1;
      const updated = {
        ...skill,
        ...request.postDataJSON(),
        revision: nextRevision,
        version: skill.builtin ? skill.version : `1.0.${nextRevision - 1}`,
      };
      skills = skills.map((entry) => (entry.id === id ? updated : entry));
      return json(route, { skill: updated });
    }
    if (path.endsWith('/prompt-optimizations')) {
      const body = request.postDataJSON();
      submissions.push(body);
      const runId = `optimization-${submissions.length}`;
      const skill = skills.find((entry) => entry.id === body.skillId)!;
      const result = {
        runId,
        nodeId: body.nodeId,
        skillId: skill.id,
        skillVersion: skill.version,
        status: 'queued',
        modelAlias: 'mock-text',
      };
      optimizations.set(runId, {
        ...result,
        promptDocument: {
          ...body.promptDocument,
          blocks: body.promptDocument.blocks.map((block: PromptDocument['blocks'][number]) =>
            block.type === 'text' ? { ...block, text: `优化后：${block.text}` } : block,
          ),
        },
      });
      return json(route, { optimization: result }, 202);
    }
    if (path.includes('/prompt-optimizations/')) {
      const result = optimizations.get(path.split('/').at(-1)!)!;
      return json(route, { optimization: { ...result, status: hold ? 'running' : 'succeeded' } });
    }
    errors.push(`未声明接口：${method} ${path}`);
    return json(route, { error: '未声明接口' }, 404);
  });
  return {
    errors,
    submissions,
    canvas: () => canvas,
    skills: () => skills,
    hold: (value: boolean) => {
      hold = value;
    },
  };
}

/** 通过实际节点进入提示词编辑器。 */
async function editor(page: Page) {
  const node = page.locator('.react-flow__node[data-id="skill-node"]');
  await expect(node).toBeVisible();
  await node.getByText('尚未生成', { exact: true }).click();
  return page.locator('.node-quick-editor');
}

for (const mediaType of ['text', 'image', 'audio', 'video'] as const) {
  test(`${mediaType} 节点共用分类 Skill 并显示用途提示`, async ({ page }) => {
    const fixture = await installFixture(page, mediaType);
    await page.goto(`/projects/${project.id}`);
    const panel = await editor(page);
    const trigger = panel.getByRole('button', { name: 'Skill 配置', exact: true });
    const settings = panel.getByRole('group', { name: 'Skill 配置', exact: true });
    const select = panel.getByRole('combobox', { name: '提示词 Skill', exact: true });
    await expect(trigger).toHaveText('Skill');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(settings).toBeHidden();
    await expect(select).toBeHidden();
    await expect(panel.getByRole('combobox', { name: '优化模型', exact: true })).toBeHidden();
    await expect(panel.getByRole('button', { name: '技能工作台', exact: true })).toBeHidden();
    await expect(panel.getByRole('button', { name: '优化提示词', exact: true })).toBeHidden();
    await trigger.hover();
    await expect(settings).toBeVisible();
    await select.click();
    await expect(page.getByRole('option', { name: '生成人物', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: '生成场景', exact: true })).toBeVisible();
    const novel = page.getByRole('option', { name: '小说正文创作', exact: true });
    await novel.hover();
    await expect(settings).toBeVisible();
    await expect(
      page.getByRole('tooltip').filter({
        hasText: PROMPT_SKILLS.find((skill) => skill.id === 'novel-draft')!.description,
      }),
    ).toBeVisible();
    await novel.click();
    await expect(select).toContainText('小说正文创作');
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
  const settings = panel.getByRole('group', { name: 'Skill 配置', exact: true });
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(settings).toBeHidden();
    if (viewport.width === 1920) {
      await expect.poll(async () => (await panel.boundingBox())?.width).toBe(570);
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
  const menu = page.getByRole('listbox', { name: 'Skill选项', exact: true });
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

test('完整编辑器内 Escape 依次关闭 Skill 子菜单和配置，保持 Dialog 打开', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page);
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: '打开完整编辑器' }).click();
  const expanded = page.getByRole('dialog', { name: '创作节点 · 编辑设置' });
  const trigger = expanded.getByRole('button', { name: 'Skill 配置', exact: true });
  const settings = expanded.getByRole('group', { name: 'Skill 配置', exact: true });
  await expect(expanded).toBeVisible();
  await expect(settings).toBeHidden();
  const prompt = expanded.getByRole('textbox', { name: '提示词', exact: true });
  await prompt.focus();
  await trigger.hover();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(expanded).toBeVisible();
  await expect(prompt).toBeFocused();
  await trigger.click();
  await expect(settings).toBeVisible();
  const select = settings.getByRole('combobox', { name: '提示词 Skill', exact: true });
  await select.click();
  const menu = page.getByRole('listbox', { name: 'Skill选项', exact: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(expanded).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(select).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(expanded).toBeVisible();
  await expect(settings).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(fixture.submissions).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test('优化预览显式应用、资源不变、选择与结果可保存重载', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installFixture(page);
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await panel.getByRole('combobox', { name: '提示词 Skill', exact: true }).click();
  await page.getByRole('option', { name: '生成人物', exact: true }).click();
  await panel.getByRole('button', { name: '优化提示词', exact: true }).click();
  await expect(panel.getByRole('group', { name: '优化预览' })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: '提示词', exact: true })).not.toContainText(
    '优化后',
  );
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.submissions[0]!.promptDocument).toEqual(original);
  await panel.getByRole('textbox', { name: '优化文字 1', exact: true }).fill('尚未应用的角色 ');
  await expect(panel.getByRole('group', { name: 'Skill 配置', exact: true })).toBeHidden();
  await expect(panel.getByRole('group', { name: '优化预览', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '打开完整编辑器' }).click();
  const expanded = page.getByRole('dialog', { name: '创作节点 · 编辑设置' });
  await expect(expanded.getByRole('group', { name: '优化预览' })).toBeVisible();
  await expect(expanded.getByRole('group', { name: 'Skill 配置', exact: true })).toBeHidden();
  await expect(expanded.getByRole('textbox', { name: '优化文字 1' })).toHaveValue(
    '尚未应用的角色 ',
  );
  await expanded.getByRole('textbox', { name: '优化文字 1' }).fill('优化后：庭院晨光，保持角色 ');
  await page.screenshot({ path: testInfo.outputPath('skill-preview-desktop.png') });
  await expanded.getByRole('button', { name: '应用', exact: true }).click();
  await expect(expanded.getByRole('textbox', { name: '提示词', exact: true })).toContainText(
    '庭院晨光',
  );
  await expanded.getByRole('button', { name: '关闭编辑器' }).click();
  await expect
    .poll(() => fixture.canvas().nodes[0]!.data.promptDocument?.blocks[0])
    .toEqual({ type: 'text', text: '优化后：庭院晨光，保持角色 ' });
  expect(
    fixture
      .canvas()
      .nodes[0]!.data.promptDocument!.blocks.filter((block) => block.type === 'mention'),
  ).toEqual(original.blocks.filter((block) => block.type === 'mention'));
  await page.reload();
  const restored = await editor(page);
  await restored.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await expect(restored.getByRole('combobox', { name: '提示词 Skill', exact: true })).toContainText(
    '生成人物',
  );
  await expect(restored.getByRole('textbox', { name: '提示词', exact: true })).toContainText(
    '庭院晨光',
  );
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test('原文变化后旧预览不可覆盖，丢弃不调用生成', async ({ page }) => {
  const fixture = await installFixture(page, 'text');
  fixture.hold(true);
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await panel.getByRole('combobox', { name: '提示词 Skill', exact: true }).click();
  await page.getByRole('option', { name: '小说章纲规划', exact: true }).click();
  await panel.getByRole('button', { name: '优化提示词', exact: true }).click();
  await expect.poll(() => fixture.submissions.length).toBe(1);
  await panel.getByRole('textbox', { name: '提示词', exact: true }).press('Control+End');
  await page.keyboard.insertText('用户新的创作要求');
  fixture.hold(false);
  await expect(panel.getByRole('button', { name: '应用', exact: true })).toBeDisabled();
  await expect(
    panel.getByText('原提示词、节点或 Skill 版本已改变', { exact: false }),
  ).toBeVisible();
  await panel.getByRole('button', { name: '丢弃', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '提示词', exact: true })).toContainText(
    '用户新的创作要求',
  );
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
    const select = panel.getByRole('combobox', { name: '提示词 Skill', exact: true });
    await expect(select).toBeDisabled();
    await expect(select).toContainText('目录加载中');
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '优化提示词', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
    expect(fixture.canvas().nodes[0]!.data.promptSkillId).toBe('character');
    release();
    await expect(select).toBeEnabled();
    await expect(select).toContainText('生成人物');
    await panel.getByRole('textbox', { name: '提示词', exact: true }).press('Control+End');
    await page.keyboard.insertText('保留原选择');
    await expect.poll(() => fixture.canvas().revision).toBeGreaterThan(1);
    expect(fixture.canvas().nodes[0]!.data.promptSkillId).toBe('character');
    await page.reload();
    const restored = await editor(page);
    await restored.getByRole('button', { name: 'Skill 配置', exact: true }).click();
    await expect(
      restored.getByRole('combobox', { name: '提示词 Skill', exact: true }),
    ).toContainText('生成人物');
    expect(fixture.submissions).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    release();
  }
});

test('优化预览内 Ctrl+S 到达全局保存且不触发浏览器另存', async ({ page }) => {
  const fixture = await installFixture(page);
  fixture.canvas().nodes[0]!.data.promptSkillId = 'character';
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await panel.getByRole('button', { name: '优化提示词', exact: true }).click();
  const preview = panel.getByRole('textbox', { name: '优化文字 1', exact: true });
  await expect(preview).toBeVisible();
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
  await preview.press('Control+s');
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
  const select = panel.getByRole('combobox', { name: '提示词 Skill', exact: true });
  await select.click();
  const option = page.getByRole('option', { name: '长说明技能', exact: true });
  await option.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  const menu = page.getByRole('listbox', { name: 'Skill选项', exact: true });
  const geometry = await menu.evaluate((element) => {
    const options = element.querySelector('.compact-select-options')!;
    const tip = element.querySelector<HTMLElement>('[role="tooltip"]')!;
    return {
      optionsHeight: options.getBoundingClientRect().height,
      menuBottom: element.getBoundingClientRect().bottom,
      tipBottom: tip.getBoundingClientRect().bottom,
      tipHeight: tip.clientHeight,
      tipContent: tip.scrollHeight,
    };
  });
  expect(geometry.optionsHeight).toBeGreaterThanOrEqual(64);
  expect(geometry.tipBottom).toBeLessThanOrEqual(geometry.menuBottom);
  expect(geometry.tipContent).toBeGreaterThan(geometry.tipHeight);
  await tip.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => tip.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('skill-long-description.png') });
  await option.click();
  await expect(select).toContainText('长说明技能');
  await select.press('Enter');
  await select.press('End');
  await expect(page.getByRole('tooltip')).toBeVisible();
  await select.press('Enter');
  await expect(select).not.toContainText('长说明技能');
  expect(fixture.errors).toEqual([]);
});

test('PC 小视口多引用长预览与过期提示不遮挡原生成控件', async ({ page }, testInfo) => {
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
  await panel.getByRole('button', { name: '优化提示词', exact: true }).click();
  await expect(panel.getByRole('button', { name: '应用', exact: true })).toBeEnabled();
  await panel.getByRole('textbox', { name: '提示词', exact: true }).press('Control+End');
  await page.keyboard.insertText('新要求');
  await expect(panel.getByRole('button', { name: '应用', exact: true })).toBeDisabled();
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(panel).toBeInViewport({ ratio: 1 });
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
    await expect(panel.locator('.node-quick-editor-controls')).toBeInViewport({ ratio: 1 });
    const modelSelect = panel.getByRole('combobox', { name: /^模型：/ });
    expect((await modelSelect.boundingBox())!.width).toBeGreaterThanOrEqual(140);
    await modelSelect.click();
    await expect(page.getByRole('listbox', { name: '模型选项', exact: true })).toBeVisible();
    await modelSelect.press('Escape');
    await expect(panel.getByRole('button', { name: '丢弃', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await page.screenshot({
      path: testInfo.outputPath(`skill-long-preview-${viewport.width}.png`),
    });
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await panel.getByRole('button', { name: '打开完整编辑器' }).click();
  const expanded = page.getByRole('dialog', { name: '创作节点 · 编辑设置' });
  await expanded.getByRole('button', { name: '丢弃', exact: true }).scrollIntoViewIfNeeded();
  await expect(expanded.getByRole('button', { name: '丢弃', exact: true })).toBeInViewport({
    ratio: 1,
  });
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
  await panel.getByRole('button', { name: '优化提示词', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('缺少提示词文字');
  await expect(panel.getByRole('button', { name: '优化提示词', exact: true })).toBeEnabled();
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.canvas().nodes[0]!.data.promptDocument).toEqual(original);
  await panel.getByRole('button', { name: '优化提示词', exact: true }).click();
  await expect(panel.getByRole('button', { name: '应用', exact: true })).toBeEnabled();
  expect(fixture.submissions).toHaveLength(2);
  expect(fixture.submissions[0]!.idempotencyKey).not.toBe(fixture.submissions[1]!.idempotencyKey);
  expect(fixture.errors).toEqual([]);
});

test('工作台增改查复制启停删除，所有节点同步目录', async ({ page }, testInfo) => {
  const fixture = await installFixture(page);
  await page.goto(`/projects/${project.id}`);
  const panel = await editor(page);
  await panel.getByRole('button', { name: 'Skill 配置', exact: true }).click();
  await panel.getByRole('button', { name: '技能工作台', exact: true }).click();
  const workbench = page.getByRole('dialog', { name: 'Skill 工作台', exact: true });
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
  await panel.getByRole('combobox', { name: '提示词 Skill', exact: true }).click();
  await page.getByRole('option', { name: '悬疑节奏修订', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '提示词 Skill', exact: true })).toContainText(
    '悬疑节奏修订',
  );
  expect(fixture.errors).toEqual([]);
});
