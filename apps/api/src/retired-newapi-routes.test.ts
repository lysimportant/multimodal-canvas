import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './fixtures/test-app';
import { isRetiredNewApiRoute } from './newapi-account-routes';

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('New API 旧入口退出边界', () => {
  it.each([
    ['GET', '/v1/settings/ai/credentials'],
    ['GET', '/v1/account/wallet'],
    ['GET', '/v1/account/billing'],
    ['POST', '/v1/runs/run-legacy/charge'],
    ['GET', '/v1/admin/wallets/user-legacy'],
    ['POST', '/v1/admin/wallets/user-legacy/adjust'],
    ['GET', '/v1/admin/charge-items'],
    ['POST', '/v1/admin/charge-items/item-legacy/refund'],
    ['GET', '/v1/admin/reconciliation'],
    ['POST', '/v1/admin/reconciliation/item-legacy/resolve'],
    ['GET', '/v1/model-marketplace'],
    ['GET', '/v1/model-marketplace/newapi'],
    ['POST', '/v1/admin/model-marketplace/models'],
    ['PATCH', '/v1/admin/model-marketplace/models/model-legacy'],
    ['PUT', '/v1/admin/model-marketplace/newapi'],
    ['DELETE', '/v1/admin/model-marketplace/newapi?modelName=legacy'],
    ['POST', '/v1/admin/model-marketplace/newapi/sync'],
    ['GET', '/v1/admin/pricing-versions'],
    ['POST', '/v1/admin/pricing-versions'],
  ] as const)('%s %s 返回明确的 410 退出提示', async (method, url) => {
    const app = buildApp({ logger: false });
    apps.push(app);

    const response = await app.inject({
      method,
      url,
      ...(method === 'GET' ? {} : { payload: {} }),
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      code: 'legacy_endpoint_retired',
      error: '此入口已退出，请刷新并使用 New API 登录',
    });
  });

  it.each([
    ['GET', '/v1/account/newapi'],
    ['POST', '/v1/account/newapi/sync'],
    ['POST', '/v1/account/newapi/revoke'],
    ['GET', '/v1/models'],
    ['POST', '/v1/projects'],
    ['GET', '/v1/projects/project-current/models/defaults'],
    ['GET', '/v1/assets'],
    ['GET', '/v1/runs/run-current'],
    ['POST', '/v1/runs/run-current/retry'],
    ['POST', '/v1/runs/run-current/recover'],
    ['POST', '/v1/runs/run-current/cancel'],
    ['GET', '/v1/settings/ai'],
    ['PATCH', '/v1/settings/ai'],
  ] as const)('%s %s 不属于旧入口', (method, path) => {
    expect(isRetiredNewApiRoute(path, method)).toBe(false);
  });
});
