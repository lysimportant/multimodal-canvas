/** 真实 PostgreSQL 设置同步验收；只使用 TEST_DATABASE_URL 和本次随机 schema。 */
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaAiSettingsStore, type CredentialReference } from './settings';
import {
  settingsCredentialDigest,
  validateSettingsSyncDatabaseUrl,
  type SettingsSyncSnapshot,
} from './fixtures/settings-sync-process';

/** 无测试连接时仅跳过数据库用例；强制集成模式下缺失配置直接失败。 */
const configuredDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!configuredDatabaseUrl && process.env.REQUIRE_INTEGRATION_SERVICES === 'true') {
  throw new Error('Settings sync integration requires TEST_DATABASE_URL');
}
if (configuredDatabaseUrl)
  validateSettingsSyncDatabaseUrl(configuredDatabaseUrl, process.env.DATABASE_URL);
/** 随机 schema 只由当前测试创建和清理，不接触 public 或其他代理的 schema。 */
const schemaName = `settings_sync_test_${randomUUID().replaceAll('-', '')}`;
/** 合成加密材料只用于本次隔离数据库，不调用任何上游 Provider。 */
const encryptionSecret = `synthetic-settings-sync-${randomUUID()}`;
/** Node 直接执行本地 Prisma CLI，避免 Windows shell 插值或暴露连接参数。 */
const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const prismaCli = fileURLToPath(
  new URL('../../../node_modules/prisma/build/index.js', import.meta.url),
);
const prismaSchema = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));
const integrationDescribe = configuredDatabaseUrl ? describe : describe.skip;

/** 创建无定时猜测的屏障，固定真实数据库操作的读写交错顺序。 */
function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** 等待真实 PostgreSQL 出现未获准的设置表锁；返回等待期间数据库的 wall clock。 */
async function waitForCredentialWriteLock(prisma: PrismaClient): Promise<Date> {
  await vi.waitFor(
    async () => {
      const waiting = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::integer AS count
      FROM pg_locks AS locks
      JOIN pg_class AS relations ON relations.oid = locks.relation
      JOIN pg_namespace AS namespaces ON namespaces.oid = relations.relnamespace
      WHERE namespaces.nspname = ${schemaName}
        AND relations.relname = 'ai_credentials'
        AND NOT locks.granted
    `;
      expect(waiting[0]?.count).toBeGreaterThan(0);
    },
    { timeout: 3_000, interval: 20 },
  );
  const timestamps = await prisma.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp()::timestamp(3) AS now`;
  return timestamps[0]!.now;
}

/** 启动一个真实长驻 Node 进程；所有读取命令复用该进程内唯一的 store。 */
function startSettingsReader(databaseUrl: string) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/settings-sync-process.ts', import.meta.url)),
    [],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        TEST_DATABASE_URL: databaseUrl,
        AI_CREDENTIAL_ENCRYPTION_KEY: encryptionSecret,
        AI_CREDENTIAL_ENCRYPTION_KEY_ID: 'settings-sync',
        AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: '{}',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let output = '';
  const pending = new Map<
    string,
    { resolve: (snapshot: SettingsSyncSnapshot) => void; reject: (error: Error) => void }
  >();
  const initialized = createSignal();
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once('close', (code) => {
      exitCode = code;
      initialized.resolve();
      for (const request of pending.values())
        request.reject(new Error('Settings sync reader exited unexpectedly'));
      pending.clear();
      resolve();
    });
  });
  child.on('error', () => {
    initialized.resolve();
    for (const request of pending.values())
      request.reject(new Error('Settings sync reader could not start'));
    pending.clear();
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-64_000);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-64_000);
  });
  child.on(
    'message',
    (message: { type?: string; requestId: string; snapshot: SettingsSyncSnapshot }) => {
      if (message.type === 'ready') {
        initialized.resolve();
        return;
      }
      pending.get(message.requestId)?.resolve(message.snapshot);
      pending.delete(message.requestId);
    },
  );
  return {
    /** 每轮命令有独立超时；失败不打印子进程环境或数据库连接字符串。 */
    async read(references: CredentialReference[]): Promise<SettingsSyncSnapshot> {
      const requestId = randomUUID();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Settings sync reader timed out')), 15_000);
      });
      try {
        await Promise.race([initialized.promise, deadline]);
        if (!child.connected) throw new Error('Settings sync reader is disconnected');
        const response = new Promise<SettingsSyncSnapshot>((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
          child.send({ type: 'read', requestId, references }, (error) => {
            if (error) reject(new Error('Settings sync reader IPC failed'));
          });
        });
        return await Promise.race([response, deadline]);
      } finally {
        clearTimeout(timeout);
        pending.delete(requestId);
      }
    },
    /** 先正常退出，超过五秒才强制终止当前测试创建的子进程并等待回收。 */
    async close(): Promise<string> {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5_000);
      try {
        if (child.connected)
          child.send({ type: 'close', requestId: randomUUID() }, () => undefined);
        await exited;
        if (exitCode !== 0) throw new Error('Settings sync reader did not exit cleanly');
        return output;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

describe('settings sync integration safety', () => {
  it('rejects an unlabelled database even with a random test schema', () => {
    expect(() =>
      validateSettingsSyncDatabaseUrl(
        'postgresql://localhost/production?schema=settings_sync_test_123',
      ),
    ).toThrow('test or ci');
  });
  it('rejects the application database despite alternate loopback names and credentials', () => {
    expect(() =>
      validateSettingsSyncDatabaseUrl(
        'postgresql://reader:synthetic@localhost/shared_test?schema=one',
        'postgres://writer:synthetic@127.0.0.1:5432/shared_test?schema=two',
      ),
    ).toThrow('must differ');
  });
  it('rejects missing or non-PostgreSQL test URLs without falling back', () => {
    expect(() => validateSettingsSyncDatabaseUrl('')).toThrow('TEST_DATABASE_URL');
    expect(() => validateSettingsSyncDatabaseUrl('https://localhost/example_test')).toThrow(
      'test or ci',
    );
  });
});

integrationDescribe('PostgreSQL settings synchronization in long-lived instances', () => {
  let databaseUrl = '';
  let prisma: PrismaClient;
  let writer: PrismaAiSettingsStore;
  let schemaCreated = false;

  beforeAll(async () => {
    const database = validateSettingsSyncDatabaseUrl(
      configuredDatabaseUrl!,
      process.env.DATABASE_URL,
    );
    database.searchParams.set('schema', schemaName);
    database.searchParams.set('connection_limit', '3');
    databaseUrl = database.toString();
    vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_KEY_ID', 'settings-sync');
    vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS', '{}');
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
    try {
      await execFileAsync(
        process.execPath,
        [prismaCli, 'db', 'push', '--schema', prismaSchema, '--skip-generate'],
        {
          cwd: workspaceRoot,
          env: { ...process.env, DATABASE_URL: databaseUrl },
          timeout: 45_000,
          windowsHide: true,
        },
      );
    } catch {
      throw new Error('Could not initialize isolated settings sync schema');
    }
    writer = new PrismaAiSettingsStore(prisma, encryptionSecret);
    await writer.get();
  }, 60_000);

  beforeEach(async () => {
    await prisma.modelCatalog.deleteMany();
    await prisma.aiCredential.deleteMany();
  });

  afterAll(async () => {
    try {
      await writer?.close();
      if (schemaCreated && /^settings_sync_test_[a-f0-9]{32}$/.test(schemaName)) {
        await prisma.$executeRawUnsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      }
    } finally {
      await prisma?.$disconnect();
      vi.unstubAllEnvs();
    }
  });

  it('observes updates and revocation in the same already-started process while decrypting frozen versions', async () => {
    const firstKey = `synthetic-first-${randomUUID()}`;
    const secondKey = `synthetic-second-${randomUUID()}`;
    await writer.update({ baseUrl: 'https://settings-sync.example/v1', apiKey: firstKey });
    const first = await writer.getCredentialReference();
    const reader = startSettingsReader(databaseUrl);
    try {
      const warmed = await reader.read([first]);
      expect(warmed.pid).not.toBe(process.pid);
      expect(warmed.activeDigest).toBe(settingsCredentialDigest(firstKey));
      await writer.update({ defaultModels: { text: 'synthetic-text' } });
      const defaults = await reader.read([first]);
      expect(defaults.settings.defaultModels).toEqual({ text: { modelAlias: 'synthetic-text' } });
      await writer.update({ apiKey: secondKey });
      const second = await writer.getCredentialReference();
      const rotated = await reader.read([first, second]);
      expect(rotated.activeReference).toEqual(second);
      expect(rotated.activeDigest).toBe(settingsCredentialDigest(secondKey));
      await writer.removeCredentials();
      const revoked = await reader.read([first, second]);
      expect(revoked.settings.configured).toBe(false);
      expect(revoked.activeReference).toEqual({});
      expect(revoked.activeDigest).toBeNull();
      expect(revoked.historical).toEqual([
        { reference: first, digest: settingsCredentialDigest(firstKey), selectable: false },
        { reference: second, digest: settingsCredentialDigest(secondKey), selectable: false },
      ]);
      for (const [index, snapshot] of [warmed, defaults, rotated, revoked].entries()) {
        expect(snapshot.pid).toBe(warmed.pid);
        expect(snapshot.instanceId).toBe(warmed.instanceId);
        expect(snapshot.sequence).toBe(index + 1);
        expect(JSON.stringify(snapshot)).not.toContain(firstKey);
        expect(JSON.stringify(snapshot)).not.toContain(secondKey);
      }
    } finally {
      const output = await reader.close();
      expect(output).not.toContain(firstKey);
      expect(output).not.toContain(secondKey);
      expect(output).not.toContain(encryptionSecret);
    }
  }, 60_000);

  it.each(['defaults', 'connection', 'activation'])(
    'rejects a late %s write that read an active credential before another instance revoked it',
    async (operation) => {
      await writer.update({
        baseUrl: 'https://settings-sync.example/v1',
        apiKey: 'synthetic-race-key',
      });
      const frozen = await writer.getCredentialReference();
      if (operation === 'activation') await writer.update({ apiKey: 'synthetic-other-race-key' });
      const entered = createSignal();
      const release = createSignal();
      let holdNextRead = false;
      const otherClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      const delayedClient = otherClient.$extends({
        query: {
          aiCredential: {
            async findFirst({ args, query }) {
              const row = await query(args);
              if (holdNextRead) {
                holdNextRead = false;
                entered.resolve();
                await release.promise;
              }
              return row;
            },
          },
        },
      });
      const delayedWriter = new PrismaAiSettingsStore(
        delayedClient as unknown as PrismaClient,
        encryptionSecret,
      );
      await delayedWriter.get();
      holdNextRead = true;
      const mutation =
        operation === 'defaults'
          ? delayedWriter.update({ defaultModels: { text: 'synthetic-late-default' } })
          : operation === 'connection'
            ? delayedWriter.update({ baseUrl: 'https://late-settings-sync.example/v1' })
            : delayedWriter.activateCredential(frozen.credentialId!);
      const writing = mutation.then(
        () => ({ ok: true, message: '' }),
        (error: Error) => ({ ok: false, message: error.message }),
      );
      try {
        await entered.promise;
        await writer.removeCredentials();
        release.resolve();
        const result = await writing;
        await expect(writer.getProviderCredentials()).resolves.toBeUndefined();
        expect(result).toEqual({
          ok: false,
          message: 'AI settings changed before they could be persisted',
        });
        await expect(delayedWriter.getProviderCredentials()).resolves.toBeUndefined();
        await expect(delayedWriter.getProviderCredentials(frozen)).resolves.toMatchObject({
          apiKey: 'synthetic-race-key',
        });
      } finally {
        release.resolve();
        await writing;
        await delayedWriter.close();
        await otherClient.$disconnect();
      }
    },
    30_000,
  );

  it('serializes a revocation behind a defaults transaction already holding the PostgreSQL lock', async () => {
    await writer.update({
      baseUrl: 'https://settings-sync.example/v1',
      apiKey: 'synthetic-lock-key',
    });
    const frozen = await writer.getCredentialReference();
    const entered = createSignal();
    const release = createSignal();
    const otherClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const delayedClient = otherClient.$extends({
      query: {
        aiCredential: {
          async update({ args, query }) {
            entered.resolve();
            await release.promise;
            return query(args);
          },
        },
      },
    });
    const delayedWriter = new PrismaAiSettingsStore(
      delayedClient as unknown as PrismaClient,
      encryptionSecret,
    );
    await delayedWriter.get();
    const writing = delayedWriter.update({ defaultModels: { text: 'synthetic-locked-default' } });
    let revoking: ReturnType<PrismaAiSettingsStore['removeCredentials']> | undefined;
    try {
      await entered.promise;
      revoking = writer.removeCredentials();
      const observedAt = await waitForCredentialWriteLock(prisma);
      release.resolve();
      await writing;
      await revoking;
      const revoked = await writer.get();
      expect(new Date(revoked.updatedAt).getTime()).toBeGreaterThanOrEqual(observedAt.getTime());
      await expect(writer.getProviderCredentials()).resolves.toBeUndefined();
      await expect(delayedWriter.getProviderCredentials()).resolves.toBeUndefined();
      await expect(delayedWriter.getProviderCredentials(frozen)).resolves.toMatchObject({
        apiKey: 'synthetic-lock-key',
      });
    } finally {
      release.resolve();
      await Promise.allSettled([writing, ...(revoking ? [revoking] : [])]);
      await delayedWriter.close();
      await otherClient.$disconnect();
    }
  }, 30_000);

  it('uses the database clock despite fast and slow application clocks', async () => {
    const timestamps = await prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    const databaseNow = timestamps[0]!.now.getTime();
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(databaseNow + 48 * 60 * 60 * 1000));
      const created = await writer.update({
        baseUrl: 'https://settings-sync.example/v1',
        apiKey: 'synthetic-skew-key',
      });
      const frozen = await writer.getCredentialReference();
      const defaults = await writer.update({ defaultModels: { text: 'synthetic-skew-default' } });
      expect(new Date(created.updatedAt).getTime()).toBeLessThan(databaseNow + 60_000);
      expect(new Date(defaults.updatedAt).getTime()).toBeLessThan(databaseNow + 60_000);
      vi.setSystemTime(new Date(databaseNow - 48 * 60 * 60 * 1000));
      const revoked = await writer.removeCredentials();
      expect(new Date(revoked.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(defaults.updatedAt).getTime(),
      );
      expect(new Date(revoked.updatedAt).getTime()).toBeGreaterThanOrEqual(databaseNow);
      await expect(writer.getProviderCredentials()).resolves.toBeUndefined();
      await expect(writer.getProviderCredentials(frozen)).resolves.toMatchObject({
        apiKey: 'synthetic-skew-key',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps revocation ordered after legacy rows with a future application timestamp', async () => {
    await writer.update({
      baseUrl: 'https://settings-sync.example/v1',
      apiKey: 'synthetic-future-key',
    });
    const frozen = await writer.getCredentialReference();
    await prisma.$executeRaw`UPDATE "ai_credentials" SET "updatedAt" = clock_timestamp() + interval '2 days' WHERE id = ${frozen.credentialId}::uuid`;
    const defaults = await writer.update({ defaultModels: { text: 'synthetic-future-default' } });
    const revoked = await writer.removeCredentials();
    expect(new Date(revoked.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(defaults.updatedAt).getTime(),
    );
    await expect(writer.getProviderCredentials()).resolves.toBeUndefined();
    await expect(writer.getProviderCredentials(frozen)).resolves.toMatchObject({
      apiKey: 'synthetic-future-key',
    });
  });

  it('timestamps explicit key creation and queued revocation after each transaction acquires its lock', async () => {
    const entered = createSignal();
    const release = createSignal();
    const otherClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const delayedClient = otherClient.$extends({
      query: {
        aiCredential: {
          async create({ args, query }) {
            entered.resolve();
            await release.promise;
            return query(args);
          },
        },
      },
    });
    const delayedWriter = new PrismaAiSettingsStore(
      delayedClient as unknown as PrismaClient,
      encryptionSecret,
    );
    await delayedWriter.get();
    const writing = delayedWriter.update({
      baseUrl: 'https://settings-sync.example/v1',
      apiKey: 'synthetic-create-lock-key',
    });
    let revoking: ReturnType<PrismaAiSettingsStore['removeCredentials']> | undefined;
    try {
      await entered.promise;
      revoking = writer.removeCredentials();
      const observedAt = await waitForCredentialWriteLock(prisma);
      release.resolve();
      const created = await writing;
      const revoked = await revoking;
      expect(new Date(revoked.updatedAt).getTime()).toBeGreaterThanOrEqual(observedAt.getTime());
      expect(new Date(revoked.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime(),
      );
      await expect(writer.getProviderCredentials()).resolves.toBeUndefined();
      await expect(delayedWriter.getProviderCredentials()).resolves.toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled([writing, ...(revoking ? [revoking] : [])]);
      await delayedWriter.close();
      await otherClient.$disconnect();
    }
  }, 30_000);
});
