import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * 只读验收：确认已声明的图片编辑能力在真实栈上对用户可见且可运行。
 *
 * 只验证到"运行按钮可用"为止，绝不点击运行 —— 不产生任何上游请求或费用。
 */

const email = process.env.MC_ACCEPTANCE_EMAIL;
const password = process.env.MC_ACCEPTANCE_PASSWORD;
const modelAlias = process.env.MC_ACCEPTANCE_IMAGE_MODEL ?? 'gpt-image-2';
const sourceImage = process.env.MC_ACCEPTANCE_SOURCE_IMAGE;

const png = sourceImage
  ? readFileSync(sourceImage)
  : Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAWklEQVR42u3QMQEAAAgDoJnc6BpjDyQgd1MFAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIEHAeWLwAAdrb0F8AAAAASUVORK5CYII=',
      'base64',
    );

async function login(page: Page) {
  const response = await page.request.post('/v1/auth/login', {
    data: { email, password },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as { accessToken: string };
}

test.describe('图片编辑能力可见性（只读）', () => {
  test.skip(!email || !password, '需要 MC_ACCEPTANCE_EMAIL / MC_ACCEPTANCE_PASSWORD');

  test('目录声明在客户端可见，且编辑节点可直接运行', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    const runRequests: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/v1\/nodes\/[^/]+\/runs$/.test(request.url())) {
        runRequests.push(request.url());
      }
    });

    const session = await login(page);

    // 1) 客户端拿到的是不带 mediaType 的完整目录，能力声明必须同样可见。
    const catalogResponse = await page.request.get('/v1/models', {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(catalogResponse.status()).toBe(200);
    const catalog = (await catalogResponse.json()) as {
      models: Array<{ id: string; capabilities?: Record<string, unknown> }>;
    };
    const entry = catalog.models.find((model) => model.id === modelAlias);
    expect(entry, `${modelAlias} 必须在完整目录中`).toBeDefined();
    expect(entry?.capabilities).toMatchObject({
      imageEdit: { supported: true },
    });

    // 2) 画布上确认编辑节点可以运行（但不点击）。
    await page.addInitScript((value) => {
      window.localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify(value));
    }, session);
    const projectResponse = await page.request.post('/v1/projects', {
      data: { name: `能力可见性验收 ${Date.now()}` },
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    const project = (await projectResponse.json()).project as { id: string };

    await page.setViewportSize({ width: 1800, height: 1100 });
    await page.goto(`/projects/${project.id}`);

    const fileName = `capability-check-${Date.now()}.png`;
    await page.locator('.resource-panel input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: 'image/png',
      buffer: png,
    });
    await expect(page.locator('.asset-card').filter({ hasText: fileName }).first()).toBeVisible({
      timeout: 60_000,
    });
    await page
      .getByRole('button', { name: `添加 ${fileName} 到画布` })
      .first()
      .click();

    const sourceNode = page
      .locator('.react-flow__node')
      .filter({ has: page.getByRole('group', { name: `节点操作：${fileName}` }) });
    await expect(sourceNode).toHaveCount(1, { timeout: 30_000 });
    await sourceNode.click();
    const editor = page.getByRole('region', { name: /生成设置$/ });
    await expect(editor).toBeVisible({ timeout: 30_000 });
    const newNodeButton = editor.getByRole('button', { name: '新节点' });
    await expect(newNodeButton).toBeDisabled();

    const modelTrigger = editor.getByRole('combobox', { name: /^模型：/ });
    await modelTrigger.click();
    const modelList = page.getByRole('listbox').filter({ hasText: modelAlias });
    await expect(modelList).toBeVisible({ timeout: 15_000 });
    await modelList
      .getByRole('option', { name: new RegExp(`^${modelAlias}$`) })
      .first()
      .click();
    await expect(modelTrigger).toHaveAttribute('aria-label', `模型：${modelAlias}`);

    await editor.getByRole('textbox', { name: '提示词' }).fill('把背景换成夜晚的城市灯光');
    await expect(newNodeButton).toBeEnabled({ timeout: 15_000 });
    await expect(newNodeButton).toHaveAttribute('title', '把修改结果写到新节点');

    // 只读到按钮可用为止：不点击，因此不产生任何上游请求。
    expect(runRequests).toEqual([]);
  });
});
