import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewApiAccountError } from './newapi-account-client';
import { NewApiAccountService } from './newapi-account-service';

const now = new Date('2026-10-09T12:00:00Z').getTime();
const maxAge = 5 * 60_000;

/** 替换身份、上游账号与本地分组读取，验证登录检查的节流判定，不连接数据库或上游。 */
function createService(input: {
  status?: string;
  syncedAt?: Date | null;
  upstreamGroups?: string[];
  localGroups?: string[];
  account?: () => Promise<unknown>;
}) {
  const identity = {
    id: 'identity-1',
    userId: 'user-1',
    externalUserId: 'external-1',
    grantId: 'grant-1',
    encryptedGrant: 'cipher',
    status: input.status ?? 'active',
    syncedAt: input.syncedAt === undefined ? new Date(now - 1_000) : input.syncedAt,
  };
  const account = vi.fn(
    input.account ??
      (async () => ({
        user: { id: 'external-1' },
        grant_id: 'grant-1',
        groups: input.upstreamGroups ?? ['default', 'GPT_Image'],
      })),
  );
  const findMany = vi
    .fn()
    .mockResolvedValue((input.localGroups ?? ['default', 'GPT_Image']).map((group) => ({ group })));
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    newApiGroupBinding: { findMany },
    newApiIdentity: { updateMany },
    authSession: { updateMany: vi.fn() },
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  const service = new NewApiAccountService({
    prisma,
    client: { account },
    keyring: { decrypt: () => ({ plaintext: 'grant-token' }) },
    auth: {},
    webUrl: 'http://localhost:5173',
  } as unknown as ConstructorParameters<typeof NewApiAccountService>[0]);
  vi.spyOn(service, 'identity').mockResolvedValue(
    identity as unknown as Awaited<ReturnType<typeof service.identity>>,
  );
  const synchronize = vi
    .spyOn(service, 'synchronize')
    .mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof service.synchronize>>);
  return { service, synchronize, account, updateMany };
}

describe('New API 登录检查节流同步', () => {
  afterEach(() => vi.restoreAllMocks());

  it('同步未过期且分组集合一致时只复核上游授权', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { service, synchronize, account } = createService({
      upstreamGroups: ['GPT_Image', 'default', '神秘分组'],
    });
    await expect(service.synchronizeIfStale('user-1', maxAge)).resolves.toBe(false);
    expect(account).toHaveBeenCalledWith('grant-token');
    expect(synchronize).not.toHaveBeenCalled();
  });

  it.each([
    ['同步已过期', { syncedAt: new Date(now - maxAge) }],
    ['从未同步', { syncedAt: null }],
    ['上次同步失败', { status: 'unavailable' }],
  ])('%s时直接执行全量同步', async (_label, input) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { service, synchronize, account } = createService(input);
    await expect(service.synchronizeIfStale('user-1', maxAge)).resolves.toBe(true);
    expect(synchronize).toHaveBeenCalledWith('user-1');
    expect(account).not.toHaveBeenCalled();
  });

  it.each([
    ['上游新增分组', { upstreamGroups: ['default', 'GPT_Image', 'Video'] }],
    ['上游移除分组', { upstreamGroups: ['default'] }],
  ])('%s时执行全量同步', async (_label, input) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { service, synchronize } = createService(input);
    await expect(service.synchronizeIfStale('user-1', maxAge)).resolves.toBe(true);
    expect(synchronize).toHaveBeenCalledWith('user-1');
  });

  it('上游授权已撤销时记录撤销并抛出 401，不使用缓存', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { service, synchronize, updateMany } = createService({
      account: async () => {
        throw new NewApiAccountError('authorization_revoked', '授权已撤销', 401);
      },
    });
    await expect(service.synchronizeIfStale('user-1', maxAge)).rejects.toMatchObject({
      status: 401,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'revoked' }) }),
    );
    expect(synchronize).not.toHaveBeenCalled();
  });

  it('上游账号或授权变化时拒绝', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { service } = createService({
      account: async () => ({ user: { id: 'external-2' }, grant_id: 'grant-1', groups: [] }),
    });
    await expect(service.synchronizeIfStale('user-1', maxAge)).rejects.toMatchObject({
      code: 'identity_changed',
      status: 401,
    });
  });
});
