import { expect, test, type Page, type Route } from '@playwright/test';

type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type AiSettings = {
  baseUrl: string;
  configured: boolean;
  keyFingerprint?: string;
  defaultModels: Record<string, string>;
};

const project: Project = {
  id: 'project-smoke',
  name: 'Smoke 项目',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const canvas = {
  revision: 0,
  nodes: [],
  edges: [],
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockApi(page: Page) {
  let settings: AiSettings = {
    baseUrl: '',
    configured: false,
    defaultModels: {},
  };
  const models = [
    { id: 'mock-text', name: 'Mock Text', mediaTypes: ['text'] },
    { id: 'mock-image', name: 'Mock Image', mediaTypes: ['image'] },
    { id: 'mock-audio', name: 'Mock Audio', mediaTypes: ['audio'] },
    { id: 'mock-video', name: 'Mock Video', mediaTypes: ['video'] },
  ];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === 'GET' && path === '/v1/assets') {
      await json(route, { assets: [] });
      return;
    }
    if (request.method() === 'GET' && path === '/v1/projects') {
      await json(route, { projects: [project] });
      return;
    }
    if (request.method() === 'POST' && path === '/v1/projects') {
      await json(route, { project }, 201);
      return;
    }
    if (request.method() === 'GET' && path === `/v1/projects/${project.id}`) {
      await json(route, { project });
      return;
    }
    if (request.method() === 'GET' && path === `/v1/projects/${project.id}/canvas`) {
      await json(route, { canvas });
      return;
    }
    if (request.method() === 'PATCH' && path === `/v1/projects/${project.id}/canvas`) {
      await json(route, { canvas: { ...canvas, revision: 1 } });
      return;
    }
    if (request.method() === 'GET' && path === '/v1/models') {
      await json(route, { models });
      return;
    }
    if (request.method() === 'GET' && path === '/v1/settings/ai') {
      await json(route, { settings });
      return;
    }
    if (request.method() === 'PATCH' && path === '/v1/settings/ai') {
      const body = request.postDataJSON() as {
        baseUrl?: string;
        apiKey?: string;
        defaultModels?: Record<string, string | null>;
      };
      settings = {
        ...settings,
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.apiKey ? { configured: true, keyFingerprint: 'smoke-fingerprint' } : {}),
        ...(body.defaultModels
          ? {
              defaultModels: {
                ...settings.defaultModels,
                ...Object.fromEntries(
                  Object.entries(body.defaultModels).filter(([, value]) => value),
                ),
              },
            }
          : {}),
      };
      await json(route, { settings });
      return;
    }
    if (request.method() === 'POST' && path === '/v1/settings/ai/test') {
      await json(route, { result: { ok: true, modelCount: models.length } });
      return;
    }
    if (request.method() === 'POST' && path === '/v1/settings/ai/models/refresh') {
      await json(route, { models });
      return;
    }
    if (request.method() === 'DELETE' && path === '/v1/settings/ai/credentials') {
      settings = { ...settings, configured: false, keyFingerprint: undefined };
      await json(route, {});
      return;
    }

    // The smoke suite does not exercise uploads or runs. Returning an empty
    // success response keeps incidental background requests from contacting a
    // real API while making those omissions explicit in the tests.
    await json(route, {});
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await mockApi(page);
});

test('starts with the resource library and workflow canvas visible', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Multimodal Canvas')).toBeVisible();
  await expect(page.getByRole('heading', { name: '项目资源' })).toBeVisible();
  await expect(page.getByRole('region', { name: '工作流画布' })).toBeVisible();
  await expect(page.getByText('从一个节点开始')).toBeVisible();
});

test('adds a generate node from the canvas toolbar', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '新建文字生成节点' }).click();
  const generatedNode = page.locator('.flow-generate-node');
  await expect(generatedNode).toHaveCount(1);
  await expect(generatedNode).toContainText('文字生成节点');
  await expect(page.getByRole('heading', { name: '节点设置' })).toBeVisible();
});

test('saves AI settings and tests the mocked connection', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开设置' }).click();

  const dialog = page.getByRole('dialog', { name: 'AI 连接' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('New API Base URL').fill('https://mock.newapi.local/v1');
  await dialog.getByLabel('API Key').fill('playwright-smoke-key');
  await dialog.getByRole('button', { name: '保存' }).click();

  await expect(dialog.getByText('已配置 · smoke-fingerprint')).toBeVisible();
  await dialog.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByRole('status')).toContainText('连接成功');
});
