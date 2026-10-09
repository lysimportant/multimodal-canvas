import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';

import { FileSystemBlobStore, PrismaAssetStore, S3BlobStore } from './assets';
import { PrismaProjectStore } from './projects';

/**
 * This suite intentionally has no DATABASE_URL fallback. It only runs with a
 * separately provisioned test connection. Store tests use a random schema and
 * migration compatibility uses a random temporary database on that same test
 * cluster. Set TEST_DATABASE_URL to a disposable database before running it;
 * all other test runs skip the suite.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
const requireIntegrationServices = process.env.REQUIRE_INTEGRATION_SERVICES === 'true';
const requiredIntegrationVariables = [
  'WORKER_PROVIDER',
  'TEST_DATABASE_URL',
  'TEST_REDIS_URL',
  'TEST_REDIS_NAMESPACE',
  'TEST_S3_ENDPOINT',
  'TEST_S3_REGION',
  'TEST_S3_BUCKET',
  'TEST_S3_ACCESS_KEY',
  'TEST_S3_SECRET_KEY',
  'TEST_S3_PREFIX',
] as const;
if (requireIntegrationServices) {
  const missing = requiredIntegrationVariables.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Integration test configuration is incomplete: ${missing.join(', ')}`);
  }
  if (process.env.WORKER_PROVIDER !== 'mock') {
    throw new Error('Integration tests require WORKER_PROVIDER=mock');
  }
}
if (
  testDatabaseUrl &&
  !isClearlyIsolatedTestDatabase(testDatabaseUrl) &&
  process.env.TEST_DATABASE_CONFIRMED_ISOLATED !== 'true'
) {
  throw new Error(
    'TEST_DATABASE_URL database name must include "test" or "ci", or TEST_DATABASE_CONFIRMED_ISOLATED=true must be set',
  );
}
if (
  testDatabaseUrl &&
  !isLoopbackDatabase(testDatabaseUrl) &&
  process.env.TEST_DATABASE_CONFIRMED_ISOLATED !== 'true'
) {
  throw new Error('Non-loopback TEST_DATABASE_URL requires TEST_DATABASE_CONFIRMED_ISOLATED=true');
}
if (
  testDatabaseUrl &&
  process.env.DATABASE_URL &&
  databaseIdentity(testDatabaseUrl) === databaseIdentity(process.env.DATABASE_URL)
) {
  throw new Error('TEST_DATABASE_URL must point to a separate database from DATABASE_URL');
}

const integrationDescribe = testDatabaseUrl ? describe : describe.skip;
const testRedisUrl = process.env.TEST_REDIS_URL?.trim();
const testRedisNamespace = process.env.TEST_REDIS_NAMESPACE?.trim();
const redisIntegrationDescribe =
  testDatabaseUrl && testRedisUrl && testRedisNamespace ? describe : describe.skip;
const testS3Config = resolveTestS3Config();
/** 完整恢复验收同时要求三类隔离服务，普通单测不得误连开发环境。 */
const workflowIntegrationDescribe =
  testDatabaseUrl && testRedisUrl && testRedisNamespace && testS3Config ? describe : describe.skip;

if (
  testRedisNamespace &&
  !isClearlyIsolatedResourceName(testRedisNamespace) &&
  process.env.TEST_REDIS_CONFIRMED_ISOLATED !== 'true'
) {
  throw new Error(
    'TEST_REDIS_NAMESPACE must include "test", "ci", or "integration", or TEST_REDIS_CONFIRMED_ISOLATED=true must be set',
  );
}
if (
  testRedisUrl &&
  !isLoopbackServiceUrl(testRedisUrl) &&
  process.env.TEST_REDIS_CONFIRMED_ISOLATED !== 'true'
) {
  throw new Error('Non-loopback TEST_REDIS_URL requires TEST_REDIS_CONFIRMED_ISOLATED=true');
}
if (
  testRedisNamespace &&
  process.env.REDIS_NAMESPACE?.trim() === testRedisNamespace &&
  process.env.TEST_REDIS_CONFIRMED_ISOLATED !== 'true'
) {
  throw new Error('TEST_REDIS_NAMESPACE must differ from REDIS_NAMESPACE');
}
if (
  testS3Config &&
  !isClearlyIsolatedResourceName(testS3Config.bucket) &&
  process.env.TEST_S3_CONFIRMED_ISOLATED !== 'true'
) {
  throw new Error(
    'TEST_S3_BUCKET must include "test", "ci", or "integration", or TEST_S3_CONFIRMED_ISOLATED=true must be set',
  );
}
if (
  testS3Config &&
  !isLoopbackServiceUrl(testS3Config.endpoint) &&
  process.env.TEST_S3_CONFIRMED_ISOLATED !== 'true'
) {
  throw new Error('Non-loopback TEST_S3_ENDPOINT requires TEST_S3_CONFIRMED_ISOLATED=true');
}
if (
  testS3Config &&
  process.env.S3_BUCKET?.trim() === testS3Config.bucket &&
  process.env.TEST_S3_CONFIRMED_ISOLATED !== 'true'
) {
  throw new Error('TEST_S3_BUCKET must differ from S3_BUCKET');
}

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const prismaRootPath = fileURLToPath(new URL('../../../prisma/', import.meta.url));
const prismaSchemaPath = join(prismaRootPath, 'schema.prisma');
const prismaMigrationsPath = join(prismaRootPath, 'migrations');
const projectArchiveMigrationPath = join(
  prismaMigrationsPath,
  '0007_project_archive',
  'migration.sql',
);
const lifecycleMigrationPath = join(
  prismaMigrationsPath,
  '0008_lifecycle_timestamps',
  'migration.sql',
);
const projectModelDefaultCredentialMigrationPath = join(
  prismaMigrationsPath,
  '0010_project_model_default_credential',
  'migration.sql',
);
const lifecycleTables = [
  'auth_sessions',
  'edges',
  'asset_versions',
  'upload_sessions',
  'run_inputs',
  'usage_ledger',
  'webhook_events',
] as const;
const preLifecycleMigrations = [
  '0001_init',
  '0002_upload_sessions',
  '0003_upload_session_owner',
  '0004_run_lifecycle_fields',
  '0005_user_auth_sessions',
  '0006_usage_ledger_idempotency',
  '0007_project_archive',
] as const;
const preModelCatalogCredentialMigrations = [
  ...preLifecycleMigrations,
  '0008_lifecycle_timestamps',
] as const;
const newApiLifecycleMigration = '20260921030000_newapi_lifecycle_timestamps';
const retireLegacyAccountsBillingMigration = '20260921050000_retire_legacy_accounts_billing';
const postLifecycleMigrations = [
  '0009_model_catalog_credentials',
  '0010_project_model_default_credential',
  '0011_webhook_event_lifecycle',
  '0012_capability_override_credential',
  '0013_fix_capability_override_index_name',
  '0014_ai_credential_encryption_key_id',
  '20260906120000_admin_accounts',
  '20260906130000_admin_lifecycle',
  // 画布分组布局与按节点计时，以及请求提示词记录。列表必须覆盖全部后续迁移，
  // 否则临时库停在旧结构，末尾的整库结构比对会报出真实存在的差异。
  '20260916120000_canvas_groups_run_node_timings',
  '20260917120000_run_request_prompts',
  '20260918090000_prompt_skills',
  '20260919090000_platform_billing',
  '20260919093000_platform_model_defaults',
  '20260919100000_billing_outbox_queue',
  '20260920140000_newapi_pricing_sync',
  '20260921010000_newapi_accounts_execution',
  '20260921020000_newapi_credential_revision',
  newApiLifecycleMigration,
  '20260921040000_newapi_revocation_recovery',
  retireLegacyAccountsBillingMigration,
  '20260921060000_retire_credential_settings',
  '20260921070000_newapi_credential_rotation',
] as const;

describe('integration configuration safety', () => {
  it('normalizes default PostgreSQL ports and local host aliases', () => {
    expect(databaseIdentity('postgresql://user:one@localhost/example_test')).toBe(
      databaseIdentity('postgres://user:two@127.0.0.1:5432/example_test?schema=isolated'),
    );
  });

  it('requires a clearly named test database unless isolation is explicitly confirmed', () => {
    expect(isClearlyIsolatedTestDatabase('postgresql://host/multimodal_canvas_ci')).toBe(true);
    expect(isClearlyIsolatedTestDatabase('postgresql://host/multimodal-test')).toBe(true);
    expect(isClearlyIsolatedTestDatabase('postgresql://host/multimodal_canvas')).toBe(false);
  });

  it('recognizes loopback database hosts used by disposable local services', () => {
    expect(isLoopbackDatabase('postgresql://user:pass@localhost/example_test')).toBe(true);
    expect(isLoopbackDatabase('postgresql://user:pass@[::1]/example_test')).toBe(true);
    expect(isLoopbackDatabase('postgresql://user:pass@database.example/example_test')).toBe(false);
  });

  it('recognizes only loopback Redis and object-storage test endpoints by default', () => {
    expect(isLoopbackServiceUrl('redis://localhost:6379/15')).toBe(true);
    expect(isLoopbackServiceUrl('http://127.0.0.1:9000')).toBe(true);
    expect(isLoopbackServiceUrl('https://storage.example.test')).toBe(false);
  });

  it('recognizes only explicit integration resource names', () => {
    expect(isClearlyIsolatedResourceName('multimodal-canvas-ci')).toBe(true);
    expect(isClearlyIsolatedResourceName('multimodal_canvas_integration_123')).toBe(true);
    expect(isClearlyIsolatedResourceName('multimodal-canvas-production')).toBe(false);
  });

  it('keeps the project archive migration transactional and public-qualified', async () => {
    const migrationSql = await readFile(projectArchiveMigrationPath, 'utf8');
    expect(migrationSql).toMatch(/\bBEGIN;/);
    expect(migrationSql.trimEnd()).toMatch(/COMMIT;$/);
    expect(migrationSql).toContain('ALTER TABLE "public"."projects"');
    expect(migrationSql).toContain('CREATE INDEX "projects_archivedAt_idx" ON "public"."projects"');
  });

  it('keeps the lifecycle migration transactional and expand-compatible', async () => {
    const migrationSql = await readFile(lifecycleMigrationPath, 'utf8');
    expect(migrationSql).toMatch(/\bBEGIN;/);
    expect(migrationSql.trimEnd()).toMatch(/COMMIT;$/);
    expect(migrationSql).not.toMatch(/DROP DEFAULT/i);
    expect(migrationSql).toMatch(/maintenance window/i);
    expect(migrationSql).toMatch(/\block time\b/i);
    expect(migrationSql).toMatch(/\bWAL\b/);

    const updateStatements = migrationSql.match(/UPDATE\s+"public"\."[^"]+"\s+SET[\s\S]*?;/gi);
    expect(updateStatements).toHaveLength(lifecycleTables.length);
    for (const table of lifecycleTables) {
      expect(migrationSql).toContain(`"public"."${table}"`);
      const updateStatement = updateStatements?.find((statement) =>
        statement.includes(`"public"."${table}"`),
      );
      expect(updateStatement).toMatch(/\bWHERE\b[\s\S]*\bIS NULL\b/i);
    }
  });

  it('declares the project model default credential index created by migration 0010', async () => {
    const [schema, migrationSql] = await Promise.all([
      readFile(prismaSchemaPath, 'utf8'),
      readFile(projectModelDefaultCredentialMigrationPath, 'utf8'),
    ]);

    const projectModelDefault = schema.match(/model ProjectModelDefault \{[\s\S]*?\n\}/)?.[0];
    expect(projectModelDefault).toContain('@@index([credentialId])');
    expect(migrationSql).toContain(
      'CREATE INDEX "project_model_defaults_credentialId_idx" ON "public"."project_model_defaults"("credentialId")',
    );
  });
});

integrationDescribe('冻结凭据跨进程恢复（隔离 PostgreSQL）', () => {
  const schemaName = `mc_rotation_test_${randomBytes(12).toString('hex')}`;
  let prisma: PrismaClient;
  let scopedDatabaseUrl = '';

  beforeAll(async () => {
    scopedDatabaseUrl = withSchema(testDatabaseUrl!, schemaName);
    await runPnpm(
      ['exec', 'prisma', 'db', 'push', '--schema', prismaSchemaPath, '--skip-generate'],
      scopedDatabaseUrl,
    );
    prisma = new PrismaClient({ datasources: { db: { url: scopedDatabaseUrl } } });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('Worker 按冻结 ID/版本轮换服务端密文，重启后仍能恢复同一 Key', async () => {
    const oldKeyring = new CredentialEncryptionKeyring({
      currentKeyId: 'old',
      currentSecret: 'synthetic-old-secret',
    });
    const historicalTime = new Date(Date.now() - 60_000);
    const historical = await prisma.aiCredential.create({
      data: {
        label: 'newapi:test',
        baseUrl: 'https://historical.example/v1',
        encryptedApiKey: oldKeyring.encrypt('synthetic-historical-key'),
        encryptionKeyId: 'old',
        keyFingerprint: 'synthetic-history',
        version: 7,
        updatedAt: historicalTime,
      },
    });
    const childEnvironment = {
      ...process.env,
      TEST_DATABASE_URL: scopedDatabaseUrl,
      TEST_CREDENTIAL_ID: historical.id,
      TEST_CREDENTIAL_VERSION: '7',
      AI_CREDENTIAL_ENCRYPTION_KEY: 'synthetic-new-secret',
      AI_CREDENTIAL_ENCRYPTION_KEY_ID: 'new',
      AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({ old: 'synthetic-old-secret' }),
    };
    const fixture = fileURLToPath(
      new URL('./fixtures/credential-recovery-process.ts', import.meta.url),
    );
    const first = await execFileAsync(process.execPath, ['--import', 'tsx', fixture], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: childEnvironment,
      timeout: 15_000,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    const second = await execFileAsync(process.execPath, ['--import', 'tsx', fixture], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...childEnvironment, AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: '{}' },
      timeout: 15_000,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });

    const expectedDigest = createHash('sha256').update('synthetic-historical-key').digest('hex');
    expect(JSON.parse(first.stdout)).toMatchObject({ digest: expectedDigest });
    expect(JSON.parse(second.stdout)).toMatchObject({ digest: expectedDigest });
    expect(JSON.parse(first.stdout).pid).not.toBe(JSON.parse(second.stdout).pid);
    const stored = await prisma.aiCredential.findUniqueOrThrow({ where: { id: historical.id } });
    expect(stored).toMatchObject({
      version: 7,
      encryptionKeyId: 'new',
      updatedAt: historicalTime,
    });
    expect(stored.encryptedApiKey).not.toContain('synthetic-historical-key');
    expect(`${first.stdout}${first.stderr}${second.stdout}${second.stderr}`).not.toContain(
      'synthetic-historical-key',
    );
  }, 30_000);
});

type LifecycleTable = (typeof lifecycleTables)[number];
type LifecycleRowSet = { ids: Record<LifecycleTable, string> };
type HistoricalLifecycleRows = LifecycleRowSet & {
  userId: string;
  canvasId: string;
  sourceNodeId: string;
  targetNodeId: string;
  assetId: string;
  runId: string;
  webhookReceivedAt: Date;
  webhookProcessedAt: Date;
};

async function createMigrationWorkspace(migrations: readonly string[]): Promise<{
  rootPath: string;
  schemaPath: string;
  migrationsPath: string;
}> {
  const rootPath = await mkdtemp(join(tmpdir(), 'multimodal-prisma-migrations-'));
  const schemaPath = join(rootPath, 'schema.prisma');
  const migrationsPath = join(rootPath, 'migrations');
  try {
    await mkdir(migrationsPath);
    await cp(prismaSchemaPath, schemaPath);
    await cp(
      join(prismaMigrationsPath, 'migration_lock.toml'),
      join(migrationsPath, 'migration_lock.toml'),
    );
    for (const migration of migrations) {
      // 同时接受仓库的四位序号和 Prisma 标准十四位时间戳，仍拒绝路径分隔符。
      if (!/^(?:\d{4}|\d{14})_[a-z0-9_]+$/.test(migration)) {
        throw new Error(`Unsafe migration directory name: ${migration}`);
      }
      await cp(join(prismaMigrationsPath, migration), join(migrationsPath, migration), {
        recursive: true,
      });
    }
    return { rootPath, schemaPath, migrationsPath };
  } catch (error) {
    await rm(rootPath, { recursive: true, force: true });
    throw error;
  }
}

async function copyMigrations(
  migrationWorkspace: { migrationsPath: string },
  migrations: readonly string[],
): Promise<void> {
  for (const migration of migrations) {
    // 时间戳迁移与旧序号迁移遵循相同的目录边界校验。
    if (!/^(?:\d{4}|\d{14})_[a-z0-9_]+$/.test(migration)) {
      throw new Error(`Unsafe migration directory name: ${migration}`);
    }
    await cp(
      join(prismaMigrationsPath, migration),
      join(migrationWorkspace.migrationsPath, migration),
      { recursive: true },
    );
  }
}

async function createTemporaryDatabase(
  adminDatabaseUrl: string,
  databaseName: string,
): Promise<void> {
  assertTemporaryDatabaseName(databaseName);
  const admin = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } } });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  } finally {
    await admin.$disconnect();
  }
}

async function dropTemporaryDatabase(
  adminDatabaseUrl: string,
  databaseName: string,
): Promise<void> {
  assertTemporaryDatabaseName(databaseName);
  const admin = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}

async function insertHistoricalLifecycleRows(
  prisma: PrismaClient,
): Promise<HistoricalLifecycleRows> {
  const suffix = randomBytes(10).toString('hex');
  const createdAt = new Date('2025-01-02T03:04:05.000Z');
  const webhookReceivedAt = new Date('2025-01-02T04:05:06.000Z');
  const webhookProcessedAt = new Date('2025-01-02T05:06:07.000Z');
  const userId = randomUUID();
  const projectId = randomUUID();
  const canvasId = randomUUID();
  const sourceNodeId = `legacy-source-${suffix}`;
  const targetNodeId = `legacy-target-${suffix}`;
  const assetId = randomUUID();
  const runId = randomUUID();
  const ids: Record<LifecycleTable, string> = {
    auth_sessions: randomUUID(),
    edges: `legacy-edge-${suffix}`,
    asset_versions: randomUUID(),
    upload_sessions: randomUUID(),
    run_inputs: randomUUID(),
    usage_ledger: randomUUID(),
    webhook_events: randomUUID(),
  };

  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."users" ("id", "email", "createdAt", "updatedAt")
      VALUES (${userId}::uuid, ${`legacy-${suffix}@example.test`}, ${createdAt}, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."auth_sessions"
        ("id", "userId", "tokenHash", "expiresAt", "createdAt", "lastUsedAt")
      VALUES
        (${ids.auth_sessions}::uuid, ${userId}::uuid, ${`legacy-token-${suffix}`},
         ${new Date('2026-01-02T03:04:05.000Z')}, ${createdAt}, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."projects"
        ("id", "ownerId", "name", "createdAt", "updatedAt")
      VALUES (${projectId}::uuid, ${userId}::uuid, ${`Legacy ${suffix}`}, ${createdAt}, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."canvases"
        ("id", "projectId", "revision", "createdAt", "updatedAt")
      VALUES (${canvasId}::uuid, ${projectId}::uuid, 0, ${createdAt}, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."nodes"
        ("id", "canvasId", "type", "mode", "label", "positionX", "positionY", "createdAt", "updatedAt")
      VALUES
        (${sourceNodeId}, ${canvasId}::uuid, 'TEXT'::"public"."MediaType",
         'SOURCE'::"public"."NodeMode", 'Legacy source', 0, 0, ${createdAt}, ${createdAt}),
        (${targetNodeId}, ${canvasId}::uuid, 'TEXT'::"public"."MediaType",
         'GENERATE'::"public"."NodeMode", 'Legacy target', 1, 1, ${createdAt}, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."edges"
        ("id", "canvasId", "sourceNodeId", "sourceHandle", "targetNodeId", "targetHandle", "sortOrder", "createdAt")
      VALUES
        (${ids.edges}, ${canvasId}::uuid, ${sourceNodeId}, 'output:text', ${targetNodeId},
         'input:prompt', 0, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."assets"
        ("id", "projectId", "ownerId", "name", "mediaType", "mimeType", "sizeBytes",
         "contentKey", "createdAt", "updatedAt")
      VALUES
        (${assetId}::uuid, ${projectId}::uuid, ${userId}::uuid, 'legacy.txt',
         'TEXT'::"public"."MediaType", 'text/plain', 1, ${`legacy/${suffix}/v1`},
         ${createdAt}, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."asset_versions"
        ("id", "assetId", "version", "sizeBytes", "contentKey", "createdAt")
      VALUES
        (${ids.asset_versions}::uuid, ${assetId}::uuid, 1, 1, ${`legacy/${suffix}/v1`}, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."upload_sessions"
        ("id", "uploadId", "ownerId", "name", "mimeType", "mediaType", "sizeBytes",
         "sha256", "contentKey", "createdAt", "expiresAt")
      VALUES
        (${ids.upload_sessions}::uuid, ${`legacy-upload-${suffix}`}, ${userId}::uuid,
         'legacy.txt', 'text/plain', 'TEXT'::"public"."MediaType", 1, ${'a'.repeat(64)},
         ${`uploads/${suffix}`}, ${createdAt}, ${new Date('2026-01-02T03:04:05.000Z')})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."runs"
        ("id", "projectId", "userId", "snapshot", "createdAt", "updatedAt")
      VALUES
        (${runId}::uuid, ${projectId}::uuid, ${userId}::uuid,
         ${JSON.stringify({ legacy: true })}::jsonb, ${createdAt}, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."run_inputs"
        ("id", "runId", "nodeId", "role", "sortOrder", "snapshot", "createdAt")
      VALUES
        (${ids.run_inputs}::uuid, ${runId}::uuid, ${sourceNodeId}, 'prompt', 0,
         ${JSON.stringify({ legacy: true })}::jsonb, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."usage_ledger"
        ("id", "runId", "userId", "amount", "createdAt")
      VALUES (${ids.usage_ledger}::uuid, ${runId}::uuid, ${userId}::uuid, 0.01, ${createdAt})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."webhook_events"
        ("id", "eventId", "provider", "payload", "receivedAt", "processedAt")
      VALUES
        (${ids.webhook_events}::uuid, ${`legacy-event-${suffix}`}, 'test',
         ${JSON.stringify({ legacy: true })}::jsonb, ${webhookReceivedAt}, ${webhookProcessedAt})
    `);
  });

  return {
    ids,
    userId,
    canvasId,
    sourceNodeId,
    targetNodeId,
    assetId,
    runId,
    webhookReceivedAt,
    webhookProcessedAt,
  };
}

async function insertExpandCompatibleRows(
  prisma: PrismaClient,
  parents: HistoricalLifecycleRows,
): Promise<LifecycleRowSet> {
  const suffix = randomBytes(10).toString('hex');
  const ids: Record<LifecycleTable, string> = {
    auth_sessions: randomUUID(),
    edges: `old-client-edge-${suffix}`,
    asset_versions: randomUUID(),
    upload_sessions: randomUUID(),
    run_inputs: randomUUID(),
    usage_ledger: randomUUID(),
    webhook_events: randomUUID(),
  };

  // These inserts intentionally omit every column introduced by 0008, which
  // is how a pre-0008 Prisma Client behaves during a rolling deployment.
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."auth_sessions" ("id", "userId", "tokenHash", "expiresAt")
      VALUES
        (${ids.auth_sessions}::uuid, ${parents.userId}::uuid, ${`old-client-token-${suffix}`},
         ${new Date('2026-02-03T04:05:06.000Z')})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."edges"
        ("id", "canvasId", "sourceNodeId", "sourceHandle", "targetNodeId", "targetHandle", "sortOrder")
      VALUES
        (${ids.edges}, ${parents.canvasId}::uuid, ${parents.sourceNodeId}, 'output:text',
         ${parents.targetNodeId}, 'input:prompt', 1)
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."asset_versions"
        ("id", "assetId", "version", "sizeBytes", "contentKey")
      VALUES
        (${ids.asset_versions}::uuid, ${parents.assetId}::uuid, 2, 1, ${`legacy/${suffix}/v2`})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."upload_sessions"
        ("id", "uploadId", "name", "mimeType", "mediaType", "sizeBytes", "sha256", "contentKey", "expiresAt")
      VALUES
        (${ids.upload_sessions}::uuid, ${`old-client-upload-${suffix}`}, 'old-client.txt',
         'text/plain', 'TEXT'::"public"."MediaType", 1, ${'b'.repeat(64)},
         ${`uploads/${suffix}`}, ${new Date('2026-02-03T04:05:06.000Z')})
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."run_inputs"
        ("id", "runId", "nodeId", "role", "sortOrder", "snapshot")
      VALUES
        (${ids.run_inputs}::uuid, ${parents.runId}::uuid, ${parents.sourceNodeId}, 'prompt', 1,
         ${JSON.stringify({ oldClient: true })}::jsonb)
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."usage_ledger" ("id", "runId", "amount")
      VALUES (${ids.usage_ledger}::uuid, ${parents.runId}::uuid, 0.02)
    `);
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."webhook_events" ("id", "eventId", "provider", "payload")
      VALUES
        (${ids.webhook_events}::uuid, ${`old-client-event-${suffix}`}, 'test',
         ${JSON.stringify({ oldClient: true })}::jsonb)
    `);
  });
  return { ids };
}

async function readHistoricalLifecycleRows(
  prisma: PrismaClient,
  rows: LifecycleRowSet,
): Promise<Array<{ tableName: LifecycleTable; createdAt: Date; updatedAt: Date }>> {
  const values: Array<{ tableName: LifecycleTable; createdAt: Date; updatedAt: Date }> = [];
  for (const tableName of lifecycleTables) {
    const result = await prisma.$queryRaw<Array<{ createdAt: Date; updatedAt: Date }>>(Prisma.sql`
      SELECT "createdAt", "updatedAt"
      FROM ${Prisma.raw(`"public"."${tableName}"`)}
      WHERE "id"::text = ${rows.ids[tableName]}
    `);
    if (!result[0]) throw new Error(`Missing lifecycle fixture row in ${tableName}`);
    values.push({ tableName, ...result[0] });
  }
  return values;
}

function resolveTestS3Config():
  | {
      endpoint: string;
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      keyPrefix: string;
    }
  | undefined {
  const endpoint = process.env.TEST_S3_ENDPOINT?.trim();
  const bucket = process.env.TEST_S3_BUCKET?.trim();
  const accessKeyId = process.env.TEST_S3_ACCESS_KEY?.trim();
  const secretAccessKey = process.env.TEST_S3_SECRET_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.TEST_S3_REGION?.trim() || 'us-east-1',
    keyPrefix: process.env.TEST_S3_PREFIX?.trim() || 'ci',
  };
}

async function runPnpm(args: string[], databaseUrl: string): Promise<void> {
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm.cmd', ...args] : args;
  try {
    await execFileAsync(executable, commandArgs, {
      cwd: workspaceRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const commandError = error as { stderr?: string; stdout?: string; message?: string };
    const detail = [commandError.stderr, commandError.stdout]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n')
      .trim();
    throw new Error(
      detail ? `${commandError.message ?? 'Command failed'}\n${detail}` : commandError.message,
    );
  }
}

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function withDatabase(databaseUrl: string, databaseName: string): string {
  assertTemporaryDatabaseName(databaseName);
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
}

function withoutSchema(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete('schema');
  return url.toString();
}

function databaseIdentity(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const protocol = ['postgres:', 'postgresql:'].includes(url.protocol)
    ? 'postgresql:'
    : url.protocol;
  const rawHostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const hostname = ['localhost', '127.0.0.1', '::1'].includes(rawHostname)
    ? 'loopback'
    : rawHostname;
  const port = url.port || (protocol === 'postgresql:' ? '5432' : '');
  return [protocol, hostname, port, decodeURIComponent(url.pathname)].join('|');
}

function isClearlyIsolatedTestDatabase(databaseUrl: string): boolean {
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  return /(?:^|[_-])(?:test|ci)(?:$|[_-])/i.test(databaseName);
}

function isLoopbackDatabase(databaseUrl: string): boolean {
  return isLoopbackServiceUrl(databaseUrl);
}

function isLoopbackServiceUrl(serviceUrl: string): boolean {
  const hostname = new URL(serviceUrl).hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

function assertTemporaryDatabaseName(databaseName: string): void {
  if (!/^mc_migration_test_[a-f0-9]{24}$/.test(databaseName)) {
    throw new Error(`Refusing unsafe temporary database name: ${databaseName}`);
  }
}

function isClearlyIsolatedResourceName(value: string): boolean {
  return /(?:^|[._:-])(?:test|ci|integration)(?:$|[._:-])/i.test(value);
}
