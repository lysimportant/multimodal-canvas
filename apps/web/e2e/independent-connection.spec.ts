/** 独立连接的 PC Web 验收；所有业务接口均使用合成数据，不访问真实供应商。 */
import { expect, test, type Page } from '@playwright/test';

import type { AiCredentialSummary } from '../src/contracts';
import type { AiSettings, ModelDefaults } from '../src/workspace/contracts';

/** 仅用于本文件模拟接口的凭据 ID。 */
const independentId = '123e4567-e89b-12d3-a456-000000000002';
/** 模拟旧活动连接，用于断言刷新和选模没有误用旧连接。 */
const activeId = '123e4567-e89b-12d3-a456-000000000001';
/** 合成 Key 只用于模拟保存请求，不是有效凭据。 */
const syntheticKey = 'synthetic-independent-browser-key';

/**
 * 安装隔离的设置接口，记录保存、刷新与模型绑定顺序。
 * @param page 当前浏览器页；未声明的业务请求会被记录为验收错误。
 * @param hasActiveConnection 是否预置旧活动连接；有旧连接时首次刷新注入 404。
 * @returns 脱敏请求记录、凭据摘要与浏览器错误，供交互完成后断言。
 */
async function installIndependentApi(page: Page, hasActiveConnection: boolean) {
  const settings: AiSettings = {
    baseUrl: hasActiveConnection ? 'https://active.example.test/v1' : '',
    configured: hasActiveConnection,
    defaultModels: hasActiveConnection ? { text: 'old-text' } : {},
  };
  let credentials: AiCredentialSummary[] = hasActiveConnection
    ? [
        {
          id: activeId,
          baseUrl: settings.baseUrl,
          keyFingerprint: 'sha256:active',
          active: true,
          updatedAt: '2026-09-18T00:00:00Z',
        },
      ]
    : [];
  const events: string[] = [];
  const errors: string[] = [];
  const bindings: ModelDefaults[] = [];
  let refreshCount = 0;
  let refreshed = false;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // 浏览器会为主动注入的 404 打印网络错误；其余 console error 全部作为失败。
    if (
      hasActiveConnection &&
      message.location().url.endsWith('/v1/settings/ai/models/refresh') &&
      message.text().includes('404')
    )
      return;
    errors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'multimodal-canvas:auth-session',
      JSON.stringify({
        accessToken: 'synthetic-independent-browser-session',
        tokenType: 'Bearer',
        expiresIn: 900,
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: {
          id: 'independent-browser-admin',
          email: 'independent@example.test',
          role: 'admin',
          createdAt: '2026-09-18T00:00:00Z',
        },
      }),
    );
  });
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    let body: unknown;
    let status = 200;
    if (path === '/v1/settings/ai' && method === 'GET') body = { settings };
    else if (path === '/v1/settings/ai/credentials' && method === 'GET') body = { credentials };
    else if (path === '/v1/projects' && method === 'GET') body = { projects: [] };
    else if (path === '/v1/assets' && method === 'GET') body = { assets: [] };
    else if (path === '/v1/settings/ai' && method === 'PATCH') {
      const input = request.postDataJSON();
      expect(input).toEqual({
        baseUrl: 'https://independent.example.test/v1',
        apiKey: syntheticKey,
        activate: false,
      });
      events.push(`save:${independentId}`);
      credentials = [
        ...credentials,
        {
          id: independentId,
          baseUrl: input.baseUrl,
          keyFingerprint: 'sha256:independent',
          active: false,
          updatedAt: '2026-09-18T00:00:01Z',
        },
      ];
      body = { settings, credentials, createdCredentialId: independentId };
    } else if (path === '/v1/settings/ai/models/refresh' && method === 'POST') {
      const input = request.postDataJSON();
      expect(input).toEqual({ credentialId: independentId });
      events.push(`refresh:${input.credentialId}`);
      refreshCount += 1;
      if (hasActiveConnection && refreshCount === 1) {
        status = 404;
        body = { error: 'credential not found' };
      } else {
        refreshed = true;
        body = {
          models: [
            {
              id: 'independent-text',
              name: '独立文字模型',
              mediaTypes: ['text'],
              credentialId: independentId,
            },
          ],
        };
      }
    } else if (path === '/v1/models' && method === 'GET') {
      const credentialId = url.searchParams.get('credentialId');
      body = {
        models:
          credentialId === independentId
            ? refreshed
              ? [
                  {
                    id: 'independent-text',
                    name: '独立文字模型',
                    mediaTypes: ['text'],
                    credentialId: independentId,
                  },
                ]
              : []
            : hasActiveConnection
              ? [
                  {
                    id: 'old-text',
                    name: '旧文字模型',
                    mediaTypes: ['text'],
                    credentialId: activeId,
                  },
                ]
              : [],
      };
    } else if (
      path === `/v1/settings/ai/credentials/${independentId}/defaults` &&
      method === 'PATCH'
    ) {
      const defaults = request.postDataJSON() as ModelDefaults;
      bindings.push(defaults);
      events.push(`bind:${independentId}`);
      credentials = credentials.map((credential) =>
        credential.id === independentId ? { ...credential, defaultModels: defaults } : credential,
      );
      body = { credentials };
    } else {
      errors.push(`未声明的模拟接口：${method} ${path}`);
      status = 501;
      body = { error: '测试禁止真实业务接口回退' };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { events, errors, bindings, settings, getCredentials: () => credentials };
}

for (const hasActiveConnection of [false, true]) {
  test(
    hasActiveConnection
      ? '已有全局连接时刷新失败保留新 ID，重试后只绑定新目录模型'
      : '首次无全局配置时独立连接可保存刷新选模，取消不提交草稿',
    async ({ page }, info) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      const state = await installIndependentApi(page, hasActiveConnection);
      await page.goto('/settings');
      await page.getByRole('tab', { name: '节点默认', exact: true }).click();
      const row = page.locator('.settings-default-row[data-media-type="text"]');
      await row.getByRole('button', { name: '配置文字生成连接', exact: true }).click();
      const baseUrl = row.getByRole('textbox', { name: '文字生成独立连接 Base URL' });
      const apiKey = row.getByLabel('文字生成独立连接 Key', { exact: true });
      const cancel = row.getByRole('button', { name: '取消配置文字生成连接' });
      await baseUrl.fill('https://discarded.example.test/v1');
      await apiKey.fill('synthetic-discarded-key');
      await cancel.click();
      await expect(row.locator('.settings-default-connection')).toHaveCount(0);
      expect(state.events).toEqual([]);
      await row.getByRole('button', { name: '配置文字生成连接', exact: true }).click();
      await expect(apiKey).toHaveValue('');
      await expect(baseUrl).toHaveValue(state.settings.baseUrl);
      await baseUrl.fill('https://independent.example.test/v1');
      await apiKey.fill(syntheticKey);
      await row.getByRole('button', { name: '保存连接', exact: true }).click();
      await expect(row.locator('[data-settings-status="connection"]')).toContainText(
        '连接已保存为独立凭据',
      );
      await expect(apiKey).toHaveValue('');
      if (hasActiveConnection) {
        await expect(row.locator('[data-settings-status="refresh"]')).toContainText(
          '连接凭据不存在或已删除，请重新保存连接后再刷新模型',
        );
        expect(state.bindings).toEqual([]);
        await page.screenshot({
          path: info.outputPath('independent-refresh-error.png'),
          fullPage: true,
        });
        await cancel.click();
        await row.getByRole('button', { name: '配置文字生成连接', exact: true }).click();
        await expect(baseUrl).toHaveValue('https://independent.example.test/v1');
        await expect(apiKey).toHaveValue('');
        await row.getByRole('button', { name: '刷新文字生成连接模型' }).click();
      }
      await expect(row.locator('[data-settings-status="refresh"]')).toContainText('模型列表已刷新');
      expect(state.bindings).toEqual([]);
      const model = row.getByRole('combobox', { name: '文字生成默认模型' });
      await expect(model).toHaveValue('');
      await expect(row.locator('datalist option')).toHaveCount(1);
      await expect(row.locator('datalist option')).toHaveAttribute('value', 'independent-text');
      await model.fill('independent-text');
      await model.press('Tab');
      await expect
        .poll(() => state.bindings)
        .toEqual([{ text: { modelAlias: 'independent-text', credentialId: independentId } }]);
      await expect(row).not.toContainText('待选择模型');
      await cancel.click();
      await row.getByRole('button', { name: '配置文字生成连接', exact: true }).click();
      await expect(model).toHaveValue('independent-text');
      await expect(apiKey).toHaveValue('');
      expect(state.events).toEqual([
        `save:${independentId}`,
        `refresh:${independentId}`,
        ...(hasActiveConnection ? [`refresh:${independentId}`] : []),
        `bind:${independentId}`,
      ]);
      expect(state.getCredentials().find((credential) => credential.active)?.id).toBe(
        hasActiveConnection ? activeId : undefined,
      );
      expect(state.settings.configured).toBe(hasActiveConnection);
      await expect(page.locator('body')).not.toContainText(syntheticKey);
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(syntheticKey);
      await page.screenshot({
        path: info.outputPath('independent-connection.png'),
        fullPage: true,
      });
      expect(state.errors).toEqual([]);
    },
  );
}
