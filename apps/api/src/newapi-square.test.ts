import { randomUUID } from 'node:crypto';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';
import type { NewApiPricingDraft, NewApiPricingSource, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaNewApiSquare, normalizeNewApiSquareUrl, requestNewApiSquare } from './newapi-square';

/** 夹具只含合成凭据和原模型价格，不访问真实站点。 */
function fixture() {
  let source: NewApiPricingSource | null = null;
  const drafts = new Map<string, NewApiPricingDraft>();
  let configured: Record<string, unknown> = {
    'billing_setting.billing_mode': 'tiered_expr',
    'billing_setting.billing_expr': 'tier("base", fixed(2.9))',
  };
  let version = 'v1';
  let failWrite = false;
  let responseLost = false;
  let rejectToken = false;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/pricing'))
      return Response.json({
        success: true,
        group_ratio: { default: 2, hidden: 99 },
        vendors: [{ id: 1, name: '合成厂商' }],
        data: [
          {
            model_name: 'Exact-Model',
            quota_type: 0,
            model_ratio: 1,
            completion_ratio: 2,
            enable_groups: ['default'],
            vendor_id: 1,
            billing_mode: 'tiered_expr',
            billing_expr: configured['billing_setting.billing_expr'],
            credential: 'do-not-publish',
          },
        ],
      });
    if (url.pathname.endsWith('/api/status'))
      return Response.json({ success: true, data: { usd_exchange_rate: 7.2 } });
    if (url.pathname.endsWith('/api/option/model_pricing')) {
      if (
        rejectToken ||
        new Headers(init?.headers).get('authorization') !== 'Bearer synthetic-admin-pat'
      )
        return new Response('', { status: 403 });
      if (init?.method === 'PATCH') {
        if (failWrite) return new Response('', { status: 500 });
        const body = JSON.parse(String(init.body));
        if (body.changes[0].expected_version !== version) return new Response('', { status: 409 });
        configured = body.changes[0].pricing;
        version = 'v2';
        if (responseLost) throw new Error('synthetic response lost');
        return Response.json({ success: true, data: { updated_models: ['Exact-Model'] } });
      }
      return Response.json({
        success: true,
        data: {
          entries: [{ model_name: 'Exact-Model', version, configured, effective: configured }],
        },
      });
    }
    throw new Error('unexpected synthetic request');
  });
  /** 模拟单行 CAS 只用于业务状态断言；真实事务由独立 PostgreSQL 用例验证。 */
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return true;
      if (value && typeof value === 'object' && 'not' in value)
        return row[key] !== (value as { not: unknown }).not;
      if (value instanceof Date) return (row[key] as Date).getTime() === value.getTime();
      return row[key] === value;
    });
  const db = {
    newApiPricingSource: {
      findUnique: vi.fn(async () => source && { ...source }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        source = {
          id: 'default',
          revision: 1,
          updatedAt: new Date(),
          ...data,
        } as NewApiPricingSource;
        return source;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (!source || !matches(source, where)) return { count: 0 };
          source = {
            ...source,
            ...data,
            revision: data.revision ? source.revision + 1 : source.revision,
            updatedAt: data.updatedAt ?? new Date(),
          } as NewApiPricingSource;
          return { count: 1 };
        },
      ),
    },
    newApiPricingDraft: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { baseUrl_modelName: { baseUrl: string; modelName: string } };
        }) => {
          const row = drafts.get(where.baseUrl_modelName.modelName);
          return row?.baseUrl === where.baseUrl_modelName.baseUrl ? { ...row } : null;
        },
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...drafts.values()].filter((row) => matches(row, where)).map((row) => ({ ...row })),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: randomUUID(),
          revision: 1,
          updatedAt: new Date(),
          ...data,
        } as NewApiPricingDraft;
        drafts.set(row.modelName, row);
        return row;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const row = [...drafts.values()].find((item) => matches(item, where));
          if (!row) return { count: 0 };
          drafts.set(row.modelName, {
            ...row,
            ...data,
            revision: data.revision ? row.revision + 1 : row.revision,
            updatedAt: data.updatedAt ?? new Date(),
          } as NewApiPricingDraft);
          return { count: 1 };
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = [...drafts.values()].find((item) => matches(item, where));
        if (!row) return { count: 0 };
        drafts.delete(row.modelName);
        return { count: 1 };
      }),
    },
    $transaction: async (operation: (database: unknown) => Promise<unknown>) => operation(db),
  };
  const service = new PrismaNewApiSquare(db as unknown as PrismaClient, {
    fetchImpl,
    keyring: new CredentialEncryptionKeyring({ currentSecret: 'synthetic-encryption-secret' }),
  });
  const authorize = () =>
    service.configure({
      url: 'https://square.invalid/pricing',
      revision: 0,
      accessToken: 'synthetic-admin-pat',
    });
  const save = () =>
    service.saveDraft(
      {
        modelName: 'Exact-Model',
        revision: 0,
        expectedVersion: 'v1',
        sourceRevision: 1,
        pricing: { ...configured, 'billing_setting.billing_expr': 'tier("base", fixed(3.2))' },
      },
      '11111111-1111-4111-8111-111111111111',
    );
  return {
    service,
    fetchImpl,
    db,
    drafts,
    authorize,
    save,
    source: () => source,
    upstream: () => configured,
    conflict: () => {
      version = 'elsewhere';
      configured = { ...configured, 'billing_setting.billing_expr': 'tier("base", fixed(9))' };
    },
    fail: () => {
      failWrite = true;
    },
    loseResponse: () => {
      responseLost = true;
    },
    reject: () => {
      rejectToken = true;
    },
  };
}

describe('New API URL 广场与价格写回', () => {
  it('站点、广场、API 和前缀地址规范一致，拒绝嵌入凭据及公网明文', () => {
    for (const suffix of ['', '/', '/pricing', '/api/pricing', '/v1'])
      expect(normalizeNewApiSquareUrl(`https://example.invalid/proxy${suffix}`)).toBe(
        'https://example.invalid/proxy',
      );
    expect(normalizeNewApiSquareUrl('http://127.0.0.1:1234/pricing')).toBe('http://127.0.0.1:1234');
    for (const url of [
      'http://example.invalid',
      'https://user:secret@example.invalid',
      'https://example.invalid?key=bad',
      'file:///tmp/key',
    ])
      expect(() => normalizeNewApiSquareUrl(url)).toThrow();
  });
  it('只读地址无需授权，原价和分组完整同步，公开 DTO 无管理凭据', async () => {
    const f = fixture();
    await f.service.configure({ url: 'https://square.invalid/pricing', revision: 0 });
    const result = await f.service.published();
    expect(result.snapshot?.models[0]).toMatchObject({
      billing_expr: 'tier("base", fixed(2.9))',
      vendor_name: '合成厂商',
      group_ratio: { default: 2 },
    });
    expect(JSON.stringify(result)).not.toMatch(/credential|AccessToken|synthetic-admin|hidden/);
    expect(
      f.fetchImpl.mock.calls.every(([, init]) => !new Headers(init?.headers).has('authorization')),
    ).toBe(true);
    await expect(f.service.edit('Exact-Model')).rejects.toMatchObject({
      code: 'authorization_required',
    });
  });
  it('改价只保存草稿，下一次同步一次写回并重读一致，重复同步不重复 PATCH', async () => {
    const f = fixture();
    await f.authorize();
    await f.save();
    expect(f.source()?.encryptedAccessToken).not.toContain('synthetic-admin-pat');
    expect(f.upstream()['billing_setting.billing_expr']).toContain('2.9');
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
    const result = await f.service.sync(1);
    expect(result.results).toEqual([{ modelName: 'Exact-Model', status: 'synced' }]);
    expect(result.snapshot?.models[0]?.billing_expr).toContain('3.2');
    await f.service.sync(1);
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });
  it('上游并发修改拒绝覆盖，草稿和基线保留，放弃草稿后读取最新', async () => {
    const f = fixture();
    await f.authorize();
    await f.save();
    f.conflict();
    expect((await f.service.sync(1)).results[0]?.status).toBe('conflict');
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
    expect(
      (await f.service.edit('Exact-Model')).configured['billing_setting.billing_expr'],
    ).toContain('3.2');
    expect(
      (await f.service.discard('Exact-Model', 1, 1)).configured['billing_setting.billing_expr'],
    ).toContain('9');
  });
  it('写回响应丢失保留草稿，下次先读到目标价并确认，不重复发 PATCH', async () => {
    const f = fixture();
    await f.authorize();
    await f.save();
    f.loseResponse();
    expect((await f.service.sync(1)).results[0]?.status).toBe('failed');
    expect((await f.service.sync(1)).results[0]?.status).toBe('synced');
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });
  it('无权限与写回失败都保留原草稿，不把失败伪装成功', async () => {
    for (const failure of ['reject', 'fail'] as const) {
      const f = fixture();
      await f.authorize();
      await f.save();
      f[failure]();
      const result = await f.service.sync(1);
      expect(result.results[0]?.status).toBe('failed');
      expect(f.drafts.get('Exact-Model')?.pricing).toMatchObject({
        'billing_setting.billing_expr': 'tier("base", fixed(3.2))',
      });
      expect(f.upstream()['billing_setting.billing_expr']).toContain('2.9');
    }
  });
  it('改域名不转发旧授权，旧站草稿保留且新站没有写回权限', async () => {
    const f = fixture();
    await f.authorize();
    await f.save();
    f.fetchImpl.mockClear();
    const next = await f.service.configure({
      url: 'https://replacement.invalid/pricing',
      revision: 1,
    });
    expect(next.authorized).toBe(false);
    expect(next.drafts).toEqual([]);
    expect(f.drafts.size).toBe(1);
    await expect(f.service.sync(1)).rejects.toMatchObject({ code: 'source_conflict' });
    await expect(f.service.discard('Exact-Model', 1, 1)).rejects.toMatchObject({
      code: 'source_conflict',
    });
    expect(
      f.fetchImpl.mock.calls.every(([, init]) => !new Headers(init?.headers).has('authorization')),
    ).toBe(true);
    await expect(f.service.edit('Exact-Model')).rejects.toMatchObject({
      code: 'authorization_required',
    });
  });
  it('拒绝过期草稿修订、未知模型和负价，不更改已有配置', async () => {
    const f = fixture();
    await f.authorize();
    await f.save();
    await expect(f.save()).rejects.toMatchObject({ code: 'draft_conflict' });
    await expect(f.service.edit('unknown')).rejects.toMatchObject({ code: 'model_missing' });
    await expect(
      f.service.saveDraft(
        {
          modelName: 'Exact-Model',
          revision: 1,
          expectedVersion: 'v1',
          sourceRevision: 1,
          pricing: { ModelPrice: -1 },
        },
        randomUUID(),
      ),
    ).rejects.toThrow();
    expect(f.drafts.get('Exact-Model')?.revision).toBe(1);
  });
  it('撤销管理授权不依赖站点在线，保留原快照和未写回草稿', async () => {
    const f = fixture();
    await f.authorize();
    await f.save();
    f.fetchImpl.mockImplementation(async () => {
      throw new Error('synthetic offline');
    });
    const result = await f.service.configure({
      url: 'https://square.invalid/pricing',
      revision: 1,
      removeAuthorization: true,
    });
    expect(result.authorized).toBe(false);
    expect(result.snapshot?.models).toHaveLength(1);
    expect(result.drafts).toHaveLength(1);
    expect(f.source()?.encryptedAccessToken).toBeNull();
  });
  it('上游不可读时不能删掉草稿，也不伪报撤销成功', async () => {
    const f = fixture();
    await f.authorize();
    await f.save();
    f.reject();
    await expect(f.service.discard('Exact-Model', 1, 1)).rejects.toMatchObject({
      code: 'upstream_permission_denied',
    });
    expect(f.drafts.get('Exact-Model')?.status).toBe('pending');
  });
  it('响应边界拒绝重定向和超限，不回显远端报错或认证材料', async () => {
    await expect(
      requestNewApiSquare('https://square.invalid', '/api/pricing', {
        fetchImpl: async () => new Response('private-secret', { status: 302 }),
      }),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(
      requestNewApiSquare('https://square.invalid', '/api/pricing', {
        fetchImpl: async () => new Response('x'.repeat(5 * 1024 * 1024 + 1)),
      }),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});
