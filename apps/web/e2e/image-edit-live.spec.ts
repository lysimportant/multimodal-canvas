import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * 真实栈图片编辑验收（一次性手动入口）。
 *
 * 与 smoke.spec.ts 不同，本文件不 Mock `/v1/**`：它直接使用运行中的 compose 栈、
 * 真实 Postgres/MinIO、真实 Provider 凭据。仅在操作者显式授权计费后手动运行，
 * 每次运行最多产生一次 `/v1/images/edits` 请求，不自动重试。
 *
 * 运行方式：
 *   MC_ACCEPTANCE_EMAIL=... MC_ACCEPTANCE_PASSWORD=... \
 *   pnpm --filter @multimodal-canvas/web exec playwright test -c playwright.config.ts \
 *     e2e/image-edit-live.spec.ts --reporter=line
 */

const email = process.env.MC_ACCEPTANCE_EMAIL;
const password = process.env.MC_ACCEPTANCE_PASSWORD;
const authorized = process.env.MC_ACCEPTANCE_AUTHORIZED === 'I_ACCEPT_UPSTREAM_CHARGES';
const modelAlias = process.env.MC_ACCEPTANCE_IMAGE_MODEL ?? 'gpt-image-2';
const prompt = process.env.MC_ACCEPTANCE_PROMPT ?? '把背景换成夜晚的城市灯光';

/**
 * 原图只来自本地文件：默认使用内联合成 PNG，可用 MC_ACCEPTANCE_SOURCE_IMAGE
 * 指定更大的本地测试图，避免把第三方内容或纯色占位图送进上游。
 */
const png = process.env.MC_ACCEPTANCE_SOURCE_IMAGE
  ? readFileSync(process.env.MC_ACCEPTANCE_SOURCE_IMAGE)
  : Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAWklEQVR42u3QMQEAAAgDoJnc6BpjDyQgd1MFAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIEHAeWLwAAdrb0F8AAAAASUVORK5CYII=',
      'base64',
    );

type LoginResponse = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  user: { id: string; email: string; role: string; createdAt: string };
};

async function login(page: Page): Promise<LoginResponse> {
  const response = await page.request.post('/v1/auth/login', { data: { email, password } });
  expect(response.status(), `login failed: ${await response.text()}`).toBe(200);
  return (await response.json()) as LoginResponse;
}

test.describe('真实栈图片编辑验收', () => {
  test.skip(!email || !password, '需要 MC_ACCEPTANCE_EMAIL / MC_ACCEPTANCE_PASSWORD');
  test.skip(!authorized, '需要 MC_ACCEPTANCE_AUTHORIZED=I_ACCEPT_UPSTREAM_CHARGES');

  test('只发出一次 /images/edits 请求，结果只写入新节点', async ({ page }, testInfo) => {
    test.setTimeout(20 * 60_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    /** 记录每一次节点运行请求及其响应，用于证明只提交了一次。 */
    const runRequests: Array<{ url: string; body: string; runId?: string }> = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/v1\/nodes\/[^/]+\/runs$/.test(request.url())) {
        runRequests.push({ url: request.url(), body: request.postData() ?? '' });
      }
    });
    page.on('response', async (response) => {
      if (
        response.request().method() !== 'POST' ||
        !/\/v1\/nodes\/[^/]+\/runs$/.test(response.url())
      )
        return;
      const payload = (await response.json().catch(() => ({}))) as { run?: { id?: string } };
      const entry = runRequests[runRequests.length - 1];
      if (entry && payload.run?.id) entry.runId = payload.run.id;
    });

    const session = await login(page);
    await page.addInitScript((value) => {
      window.localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify(value));
    }, session);

    const projectResponse = await page.request.post('/v1/projects', {
      data: { name: `图片编辑真实验收 ${new Date().toISOString()}` },
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(projectResponse.status(), await projectResponse.text()).toBe(201);
    const project = (await projectResponse.json()).project as { id: string; name: string };

    await page.setViewportSize({ width: 1800, height: 1100 });
    await page.goto(`/projects/${project.id}`);

    // 上传本地合成 PNG 并放进画布，作为“修改图片”的来源节点。
    // 资源库是账户级的，重复执行会有同名资源，只取最新的一张。
    const fileName = `live-edit-source-${Date.now()}.png`;
    const uploadResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/v1\/assets\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname),
    );
    await page.locator('.resource-panel input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: 'image/png',
      buffer: png,
    });
    const uploadedAsset = ((await (await uploadResponse).json()) as { asset: { id: string } })
      .asset;
    expect(uploadedAsset.id).toMatch(/^[0-9a-f-]{36}$/);
    const assetCard = page.locator('.asset-card').filter({ hasText: fileName }).first();
    await expect(assetCard).toBeVisible({ timeout: 60_000 });
    await page
      .getByRole('button', { name: `添加 ${fileName} 到画布` })
      .first()
      .click();

    const sourceNode = page
      .locator('.react-flow__node')
      .filter({ has: page.getByRole('group', { name: `节点操作：${fileName}` }) });
    await expect(sourceNode).toHaveCount(1, { timeout: 30_000 });
    await expect(sourceNode.locator('img').first()).toBeVisible({ timeout: 60_000 });
    const sourceImgBefore = await sourceNode.locator('img').first().getAttribute('src');
    expect(sourceImgBefore).toContain(uploadedAsset.id);
    const sourceBoxBefore = await sourceNode.boundingBox();
    // 上传后节点尺寸会按图片原比例适配一次；等待稳定后再记录基线。
    await page.waitForTimeout(1500);
    const stableSourceBox = await sourceNode.boundingBox();

    await sourceNode.click();
    const sourceEditor = page.getByRole('region', { name: /生成设置$/ });
    await expect(sourceEditor).toBeVisible();
    const modelTrigger = sourceEditor.getByRole('combobox', { name: /^模型：/ });
    await modelTrigger.click();
    const modelList = page.getByRole('listbox').filter({ hasText: modelAlias });
    await expect(modelList).toBeVisible({ timeout: 15_000 });
    await modelList
      .getByRole('option', { name: new RegExp(`^${modelAlias}$`) })
      .first()
      .click();
    await expect(modelTrigger).toHaveAttribute('aria-expanded', 'false');
    await sourceEditor.getByRole('textbox', { name: '提示词' }).fill(prompt);

    // —— 授权范围内的唯一一次计费 POST：修改图片与新节点同一路径并立刻运行 ——
    const submittedAt = Date.now();
    await sourceNode.getByRole('button', { name: `修改图片：${fileName}` }).click();

    const editNode = page.locator('.react-flow__node[data-id^="node_image_generate"]');
    await expect(editNode).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    const editor = page.getByRole('region', { name: /图片修改设置$/ });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('group', { name: '来源图（只读）' })).toContainText(
      '来源图固定版本：v1',
    );

    await expect.poll(() => runRequests.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    expect(runRequests).toHaveLength(1);
    const runBody = JSON.parse(runRequests[0]!.body) as {
      modelAlias?: string;
      parameters?: Record<string, unknown>;
    };
    expect(runBody.modelAlias).toBe(modelAlias);
    expect(runBody.parameters?.prompt).toBe(prompt);
    await expect.poll(() => runRequests[0]?.runId ?? '', { timeout: 30_000 }).toMatch(/^run_/);
    const runId = runRequests[0]!.runId!;

    const readRun = async () => {
      const response = await page.request.get(`/v1/runs/${runId}`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      if (!response.ok()) return { status: `http_${response.status()}` };
      const body = (await response.json()) as { run: Record<string, unknown> };
      return body.run;
    };

    // 等待终态；失败时保留原始错误，不重发请求。
    let finalRun: Record<string, unknown> = { status: 'timeout' };
    await expect
      .poll(
        async () => {
          finalRun = await readRun();
          return finalRun.status;
        },
        { timeout: 15 * 60_000, intervals: [5_000] },
      )
      .toMatch(/^(succeeded|failed|cancelled)$/);

    const evidence = {
      startedAt: new Date(submittedAt).toISOString(),
      projectId: project.id,
      modelAlias,
      prompt,
      runId,
      requestCount: runRequests.length,
      status: finalRun.status,
      error: finalRun.error ?? null,
      result: finalRun.result ?? null,
      elapsedMs: Date.now() - submittedAt,
    };
    await testInfo.attach('live-image-edit-evidence', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    });
    console.log('EVIDENCE', JSON.stringify(evidence));

    expect(finalRun.status, JSON.stringify(evidence)).toBe('succeeded');

    // 结果只写入新节点：新节点显示的是本次运行的归档产物，
    // 来源节点仍指向最初上传的资产，且位置与尺寸不变。
    const result = finalRun.result as { asset?: { assetId?: string } } | undefined;
    const resultAssetId = result?.asset?.assetId ?? '';
    expect(resultAssetId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(editNode.locator('img').first()).toBeVisible({ timeout: 120_000 });
    await expect(editNode.locator('img').first()).toHaveAttribute('src', new RegExp(resultAssetId));
    await expect(sourceNode.locator('img').first()).toHaveAttribute(
      'src',
      new RegExp(uploadedAsset.id),
    );
    expect(await sourceNode.boundingBox()).toEqual(stableSourceBox);
    expect(sourceBoxBefore).not.toBeNull();

    await page.screenshot({ path: testInfo.outputPath('live-image-edit.png') });
    expect(errors).toEqual([]);
  });
});
