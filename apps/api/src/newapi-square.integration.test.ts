import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaNewApiSquare } from './newapi-square';

/** 真实数据库测试仅允许显式确认的本机测试库，每次使用独立 schema。 */
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    process.env.TEST_DATABASE_CONFIRMED_ISOLATED !== 'true' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !url.pathname.endsWith('_test')
  )
    throw new Error('需要已确认隔离的本机 _test 数据库');
}
const integration = databaseUrl ? describe : describe.skip;
integration('New API 广场持久草稿（隔离 PostgreSQL）', () => {
  const namespace = `pricing_test_${randomUUID().replaceAll('-', '')}`;
  let prisma: PrismaClient;
  let service: PrismaNewApiSquare;
  let price = 2.9;
  let version = 'initial';
  let patches = 0;
  let deny = false;
  const actorId = randomUUID();
  const apiKey = 'synthetic-integration-pat';
  const keyring = new CredentialEncryptionKeyring({
    currentSecret: 'synthetic-integration-keyring',
  });
  /** 合成传输由服务端调用；并发和持久化使用真实 PostgreSQL 事务。 */
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/pricing')
      return Response.json({
        success: true,
        data: [
          {
            model_name: 'Exact-Price',
            quota_type: 1,
            model_price: price,
            model_ratio: 0,
            completion_ratio: 0,
            enable_groups: ['default'],
          },
        ],
        group_ratio: { default: 1 },
      });
    if (path === '/api/status')
      return Response.json({
        success: true,
        data: { usd_exchange_rate: 1, quota_display_type: 'CNY' },
      });
    if (path === '/api/option/model_pricing') {
      if (deny || new Headers(init?.headers).get('authorization') !== `Bearer ${apiKey}`)
        return new Response('', { status: 403 });
      if (init?.method === 'PATCH') {
        const change = JSON.parse(String(init.body)).changes[0];
        if (change.expected_version !== version) return new Response('', { status: 409 });
        patches++;
        price = change.pricing.ModelPrice;
        version = `revision-${patches}`;
        return Response.json({ success: true, data: { updated_models: ['Exact-Price'] } });
      }
      return Response.json({
        success: true,
        data: {
          entries: [
            {
              model_name: 'Exact-Price',
              version,
              configured: { ModelPrice: price },
              effective: { ModelPrice: price },
            },
          ],
        },
      });
    }
    throw new Error('unexpected synthetic request');
  };
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    url.searchParams.set('schema', namespace);
    const cwd = fileURLToPath(new URL('../../../', import.meta.url));
    const cli = fileURLToPath(
      new URL('../../../node_modules/prisma/build/index.js', import.meta.url),
    );
    // 历史迁移显式引用 public；行为测试按项目惯例使用独立 schema，迁移另在独立数据库验收。
    await promisify(execFile)(process.execPath, [cli, 'db', 'push', '--skip-generate'], {
      cwd,
      env: { ...process.env, DATABASE_URL: url.toString() },
      maxBuffer: 4 * 1024 * 1024,
    });
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    service = new PrismaNewApiSquare(prisma, { fetchImpl, keyring });
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${namespace}@example.invalid`,
        passwordHash: 'synthetic-unused',
        role: 'ADMIN',
      },
    });
    await prisma.wallet.create({ data: { userId: actorId, currency: 'CNY' } });
  }, 60000);
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  it('同站地址共享草稿，凭据加密且不进入普通 Key 列表，重建服务后草稿仍可恢复', async () => {
    await service.configure({
      url: 'https://synthetic.invalid/pricing',
      revision: 0,
      accessToken: apiKey,
    });
    const source = await prisma.newApiPricingSource.findUniqueOrThrow({ where: { id: 'default' } });
    expect(source.encryptedAccessToken).not.toContain(apiKey);
    expect(keyring.decrypt(source.encryptedAccessToken!).plaintext).toBe(apiKey);
    expect(await prisma.aiCredential.count()).toBe(0);
    await service.saveDraft(
      {
        modelName: 'Exact-Price',
        revision: 0,
        sourceRevision: 1,
        expectedVersion: version,
        pricing: { ModelPrice: 3.2 },
      },
      actorId,
    );
    expect(await prisma.newApiPricingDraft.count()).toBe(1);
    const recovered = new PrismaNewApiSquare(prisma, { fetchImpl, keyring });
    expect((await recovered.edit('Exact-Price')).configured).toEqual({ ModelPrice: 3.2 });
    expect(price).toBe(2.9);
  });
  it('同时编辑只接受一个修订，双同步只写回一次，钱包不变', async () => {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: actorId } });
    const writes = await Promise.allSettled(
      [3.3, 3.4].map((amount) =>
        service.saveDraft(
          {
            modelName: 'Exact-Price',
            revision: 1,
            sourceRevision: 1,
            expectedVersion: version,
            pricing: { ModelPrice: amount },
          },
          actorId,
        ),
      ),
    );
    expect(writes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const desired = (await service.edit('Exact-Price')).configured.ModelPrice;
    await Promise.all([service.sync(1), service.sync(1)]);
    expect(price).toBe(desired);
    expect(patches).toBe(1);
    expect((await prisma.newApiPricingDraft.findFirstOrThrow()).status).toBe('synced');
    expect(await prisma.wallet.findUniqueOrThrow({ where: { userId: actorId } })).toEqual(wallet);
  });
  it('失效写回权限保存失败原因、旧草稿可恢复；更换域名阻止旧编辑器保存', async () => {
    const edit = await service.edit('Exact-Price');
    await service.saveDraft(
      {
        modelName: 'Exact-Price',
        revision: edit.revision,
        sourceRevision: 1,
        expectedVersion: version,
        pricing: { ModelPrice: 4 },
      },
      actorId,
    );
    deny = true;
    expect((await service.sync(1)).results[0]?.status).toBe('failed');
    expect((await prisma.newApiPricingDraft.findFirstOrThrow()).pricing).toEqual({ ModelPrice: 4 });
    await service.configure({ url: 'https://replacement.invalid/pricing', revision: 1 });
    await expect(
      service.saveDraft(
        {
          modelName: 'Exact-Price',
          revision: 0,
          sourceRevision: 1,
          expectedVersion: version,
          pricing: { ModelPrice: 8 },
        },
        actorId,
      ),
    ).rejects.toMatchObject({ code: 'source_conflict' });
    expect((await service.admin()).authorized).toBe(false);
    expect(await prisma.newApiPricingDraft.count()).toBe(1);
  });
});
