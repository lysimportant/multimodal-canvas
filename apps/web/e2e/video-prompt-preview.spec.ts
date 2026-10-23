import { expect, test } from '@playwright/test';
import { canvasDocumentSchema } from '@multimodal-canvas/domain';

test.use({ serviceWorkers: 'block' });

for (const { width, channel } of [
  { width: 1440, channel: false },
  { width: 390, channel: false },
  { width: 1440, channel: true },
  { width: 390, channel: true },
]) {
  test(`真实提示词预览 ${width}px${channel ? ' 渠道契约' : ''}`, async ({
    page,
    baseURL,
  }, info) => {
    test.setTimeout(60_000);
    if (!baseURL || new URL(baseURL).hostname !== '127.0.0.1')
      throw new Error('仅允许本机隔离验证');
    await page.setViewportSize({ width, height: 900 });
    const webOrigin = new URL(baseURL).origin;
    const project = {
      id: 'prompt-preview-test',
      name: '预览验收',
      createdAt: '2026-10-23T00:00:00Z',
      updatedAt: '2026-10-23T00:00:00Z',
    };
    const user = { id: 'preview-user', role: 'user', createdAt: project.createdAt };
    const model = {
      id: channel ? '/future/channel-video' : 'wan3.0-video',
      name: channel ? '渠道视频模型' : 'Wan 3',
      ...(channel
        ? {
            capabilities: {
              videoReferences: {
                version: 1,
                adapter: 'seedance-video',
                tokenSyntax: 'numbered-media',
                maxImages: 30,
                maxVideos: 10,
                maxAudios: 10,
              },
            },
          }
        : {}),
      mediaTypes: ['video'],
      group: 'test',
      credentialId: 'preview-credential',
      available: true,
    };
    const account = {
      issuer: 'https://synthetic.test',
      externalUserId: 'synthetic-user',
      status: 'active',
      groups: [
        { group: 'test', status: 'active', credentialId: model.credentialId, modelCount: 1 },
      ],
      links: {},
    };
    const errors: string[] = [];
    const unexpected: string[] = [];
    let canvas = canvasDocumentSchema.parse({
      revision: 1,
      nodes: [
        {
          id: 'preview-node',
          type: 'video',
          position: { x: 250, y: 180 },
          width: 320,
          height: 240,
          data: {
            label: '视频预览验收',
            mediaType: 'video',
            mode: 'generate',
            enabled: true,
            modelAlias: model.id,
            credentialId: model.credentialId,
            videoMode: 'omni_reference',
            promptDocument: {
              version: 1,
              blocks: [
                { type: 'text', text: '使用' },
                {
                  type: 'mention',
                  mentionId: 'hero',
                  assetId: 'hero',
                  assetVersion: 1,
                  mediaType: 'image',
                  inline: true,
                  label: '人物',
                },
                { type: 'text', text: '走进房间。\n' + '人物转身，看向窗外。'.repeat(150) },
              ],
            },
          },
        },
      ],
      edges: [],
    });
    await page.addInitScript(
      (value) =>
        localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify({ user: value })),
      user,
    );
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const json = (body: unknown) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin === webOrigin && !path.startsWith('/v1/') && method === 'GET')
        return route.continue();
      if (![webOrigin, 'http://localhost:3000'].includes(url.origin)) {
        unexpected.push('外部网络');
        return route.abort();
      }
      if (path === '/v1/auth/me')
        return json({ user, expiresAt: new Date(Date.now() + 3600000).toISOString() });
      if (path === '/v1/account/newapi') return json({ account });
      if (path === '/v1/account/newapi/sync' && method === 'POST') {
        return json({ account });
      }
      if (path === '/v1/models') return json({ models: [model] });
      if (path === '/v1/projects') return json({ projects: [project] });
      if (path === `/v1/projects/${project.id}`) return json({ project });
      if (path.endsWith('/events'))
        return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
      if (path.endsWith('/canvas')) {
        if (method === 'PATCH')
          canvas = canvasDocumentSchema.parse({
            ...request.postDataJSON(),
            revision: canvas.revision + 1,
          });
        return json({ canvas });
      }
      if (path.endsWith('/models/defaults')) return json({ defaults: {}, resolvedDefaults: {} });
      if (path.endsWith('/runs') && method === 'GET') return json({ runs: [] });
      if (path === '/v1/prompt-skills') return json({ skills: [] });
      if (path === '/v1/settings/ai')
        return json({ settings: { defaultModels: {}, timeoutMs: 900000 }, resolvedDefaults: {} });
      if (path === '/v1/assets') return json({ assets: [], total: 0, page: 1, pageSize: 50 });
      if (path.endsWith('/request-prompts')) return json({ records: [] });
      unexpected.push(method + ' ' + path);
      return route.abort();
    });
    await page.goto(`/projects/${project.id}`);
    const openEditor = async () => {
      const node = page.locator('.react-flow__node[data-id="preview-node"]');
      await expect(node).toBeVisible({ timeout: 20000 });
      await node.getByText('尚未生成', { exact: true }).click();
      await expect(page.getByRole('button', { name: '查看真实提示词' })).toBeVisible();
    };
    await openEditor();
    const trigger = page.getByRole('button', { name: '查看真实提示词' });
    const composer = trigger.locator(
      'xpath=ancestor::*[contains(@class,"node-quick-editor-run-group")]',
    );
    const triggerBox = (await trigger.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    const generateBox = (await composer
      .getByRole('button', { name: '生成', exact: true })
      .boundingBox())!;
    expect(
      Math.abs(triggerBox.y + triggerBox.height / 2 - generateBox.y - generateBox.height / 2),
    ).toBeLessThan(3);
    expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(
      composerBox.y + composerBox.height + 1,
    );
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '真实提示词', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(dialog.getByLabel('真实提示词正文')).toContainText(
      channel ? '使用Image 1走进房间。' : '使用图1走进房间。',
    );
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(901);
    const text = dialog.getByLabel('真实提示词正文');
    expect(
      await text.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    await text.focus();
    await page.keyboard.press('End');
    await page.screenshot({
      path: info.outputPath(`preview-${width}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.reload();
    await openEditor();
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}
