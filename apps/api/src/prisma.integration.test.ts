import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FileSystemBlobStore, PrismaAssetStore, S3BlobStore } from './assets';
import { PrismaProjectStore } from './projects';
import { PrismaAiSettingsStore } from './settings';

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
const minioIntegrationDescribe = testDatabaseUrl && testS3Config ? describe : describe.skip;

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
const modelCatalogCredentialMigrationPath = join(
  prismaMigrationsPath,
  '0009_model_catalog_credentials',
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
const postLifecycleMigrations = [
  '0009_model_catalog_credentials',
  '0010_project_model_default_credential',
  '0011_webhook_event_lifecycle',
  '0012_capability_override_credential',
  '0013_fix_capability_override_index_name',
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

integrationDescribe('Prisma stores (isolated PostgreSQL)', () => {
  let schemaName = '';
  let scopedDatabaseUrl = '';
  let blobRoot = '';
  let prisma: PrismaClient;

  beforeAll(async () => {
    schemaName = `mc_test_${randomBytes(12).toString('hex')}`;
    scopedDatabaseUrl = withSchema(testDatabaseUrl!, schemaName);

    // Bootstrap only the random schema using the explicitly supplied test URL.
    const bootstrap = new PrismaClient({
      datasources: { db: { url: withoutSchema(testDatabaseUrl!) } },
    });
    try {
      await bootstrap.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    } finally {
      await bootstrap.$disconnect();
    }

    await runPnpm(
      ['exec', 'prisma', 'db', 'push', '--schema', prismaSchemaPath, '--skip-generate'],
      scopedDatabaseUrl,
    );

    prisma = new PrismaClient({ datasources: { db: { url: scopedDatabaseUrl } } });
    blobRoot = await mkdtemp(join(tmpdir(), 'multimodal-prisma-assets-'));
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (testDatabaseUrl && schemaName) {
      const cleanup = new PrismaClient({
        datasources: { db: { url: withoutSchema(testDatabaseUrl) } },
      });
      try {
        // The schema is unique to this test run; no shared tables are touched.
        await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await cleanup.$disconnect();
      }
    }
    if (blobRoot) await rm(blobRoot, { recursive: true, force: true });
  });

  it('persists projects/assets/settings across client restart and isolates assets by project', async () => {
    const projectStore = new PrismaProjectStore(prisma);
    const projectA = await projectStore.create({ name: `Integration A ${schemaName}` });
    const projectB = await projectStore.create({ name: `Integration B ${schemaName}` });

    const blobStore = new FileSystemBlobStore(blobRoot);
    const assetStoreA = new PrismaAssetStore(prisma, {
      blobStore,
      projectId: projectA.id,
    });
    const assetA = await assetStoreA.create({
      name: 'reference.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('persistent asset'),
    });
    expect(assetA.sha256).toMatch(/^[a-f0-9]{64}$/);

    const canvas = {
      revision: 0,
      nodes: [
        {
          id: 'node_reference',
          type: 'text' as const,
          position: { x: 10, y: 20 },
          data: {
            label: 'Reference',
            mediaType: 'text' as const,
            mode: 'source' as const,
            assetId: assetA.id,
            contentUrl: assetA.contentUrl,
            mimeType: assetA.mimeType,
          },
        },
      ],
      edges: [],
    };
    await expect(projectStore.updateCanvas(projectA.id, canvas)).resolves.toMatchObject({
      revision: 1,
    });
    await expect(
      projectStore.updateModelDefaults(projectA.id, {
        text: 'project-text-model',
        image: 'project-image-model',
      }),
    ).resolves.toEqual({
      text: 'project-text-model',
      image: 'project-image-model',
    });

    // The second project cannot read or reference project A's private asset.
    const assetStoreB = new PrismaAssetStore(prisma, {
      blobStore,
      projectId: projectB.id,
    });
    await expect(assetStoreB.get(assetA.id)).resolves.toBeUndefined();
    await expect(
      projectStore.updateCanvas(projectB.id, {
        ...canvas,
        nodes: [{ ...canvas.nodes[0], id: 'node_cross_project' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_asset' });

    // A new Prisma client represents an API restart; both metadata and bytes
    // are recovered from PostgreSQL and the filesystem object store.
    await prisma.$disconnect();
    prisma = new PrismaClient({ datasources: { db: { url: scopedDatabaseUrl } } });
    const restartedProjects = new PrismaProjectStore(prisma);
    const restartedAssets = new PrismaAssetStore(prisma, {
      blobStore: new FileSystemBlobStore(blobRoot),
      projectId: projectA.id,
    });
    await expect(restartedProjects.get(projectA.id)).resolves.toMatchObject({
      id: projectA.id,
      name: projectA.name,
    });
    await expect(restartedProjects.getCanvas(projectA.id)).resolves.toMatchObject({
      revision: 1,
      nodes: [{ data: { assetId: assetA.id } }],
    });
    await expect(restartedProjects.getModelDefaults(projectA.id)).resolves.toEqual({
      text: 'project-text-model',
      image: 'project-image-model',
    });
    await expect(restartedAssets.get(assetA.id)).resolves.toMatchObject({
      id: assetA.id,
      content: Buffer.from('persistent asset'),
    });

    const settingsSecret = 'integration-encryption-secret';
    const firstSettings = new PrismaAiSettingsStore(prisma, settingsSecret);
    const updated = await firstSettings.update({
      baseUrl: 'https://newapi.integration.test/v1',
      apiKey: 'integration-api-key',
      defaultModels: { text: 'integration-text-model' },
    });
    expect(updated).toMatchObject({
      configured: true,
      defaultModels: { text: { modelAlias: 'integration-text-model' } },
    });
    expect(JSON.stringify(updated)).not.toContain('integration-api-key');
    await firstSettings.close?.();

    const restartedSettings = new PrismaAiSettingsStore(prisma, settingsSecret);
    await expect(restartedSettings.get()).resolves.toMatchObject({
      configured: true,
      defaultModels: { text: { modelAlias: 'integration-text-model' } },
    });
    await expect(restartedSettings.getCredentialReference()).resolves.toMatchObject({
      credentialVersion: 1,
    });
    const credential = await prisma.aiCredential.findFirst({ where: { projectId: null } });
    expect(credential?.encryptedApiKey).toBeTruthy();
    expect(credential?.encryptedApiKey).not.toContain('integration-api-key');
  });

  it('materializes lifecycle timestamps for mutable and append-only business rows', async () => {
    const tablesMissingLifecycleColumns = await prisma.$queryRaw<Array<{ tableName: string }>>(
      Prisma.sql`
        SELECT tables.table_name AS "tableName"
        FROM information_schema.tables AS tables
        WHERE tables.table_schema = ${schemaName}
          AND tables.table_type = 'BASE TABLE'
          AND tables.table_name <> '_prisma_migrations'
          AND (
            NOT EXISTS (
              SELECT 1
              FROM information_schema.columns AS created_columns
              WHERE created_columns.table_schema = tables.table_schema
                AND created_columns.table_name = tables.table_name
                AND created_columns.column_name = 'createdAt'
            )
            OR NOT EXISTS (
              SELECT 1
              FROM information_schema.columns AS updated_columns
              WHERE updated_columns.table_schema = tables.table_schema
                AND updated_columns.table_name = tables.table_name
                AND updated_columns.column_name = 'updatedAt'
            )
          )
      `,
    );
    expect(tablesMissingLifecycleColumns).toEqual([]);

    const user = await prisma.user.create({
      data: { email: `lifecycle-${schemaName}@example.test` },
    });
    const session = await prisma.authSession.create({
      data: {
        userId: user.id,
        tokenHash: `lifecycle-token-${schemaName}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const project = await prisma.project.create({ data: { name: `Lifecycle ${schemaName}` } });
    const canvas = await prisma.canvas.create({ data: { projectId: project.id } });
    const source = await prisma.canvasNode.create({
      data: {
        id: `lifecycle-source-${schemaName}`,
        canvasId: canvas.id,
        type: 'TEXT',
        mode: 'SOURCE',
        label: 'Source',
        positionX: 0,
        positionY: 0,
      },
    });
    const target = await prisma.canvasNode.create({
      data: {
        id: `lifecycle-target-${schemaName}`,
        canvasId: canvas.id,
        type: 'TEXT',
        mode: 'GENERATE',
        label: 'Target',
        positionX: 1,
        positionY: 1,
      },
    });
    const edge = await prisma.canvasEdge.create({
      data: {
        id: `lifecycle-edge-${schemaName}`,
        canvasId: canvas.id,
        sourceNodeId: source.id,
        sourceHandle: 'output:text',
        targetNodeId: target.id,
        targetHandle: 'input:prompt',
        sortOrder: 0,
      },
    });
    const asset = await prisma.asset.create({
      data: {
        projectId: project.id,
        name: 'lifecycle.txt',
        mediaType: 'TEXT',
        mimeType: 'text/plain',
        sizeBytes: 1n,
        contentKey: `lifecycle/${schemaName}/v1`,
      },
    });
    const assetVersion = await prisma.assetVersion.create({
      data: {
        assetId: asset.id,
        version: 1,
        sizeBytes: 1n,
        contentKey: `lifecycle/${schemaName}/v1`,
      },
    });
    const upload = await prisma.uploadSession.create({
      data: {
        uploadId: `lifecycle-upload-${schemaName}`,
        name: 'lifecycle.txt',
        mimeType: 'text/plain',
        mediaType: 'TEXT',
        sizeBytes: 1n,
        sha256: 'a'.repeat(64),
        contentKey: `uploads/${schemaName}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const run = await prisma.run.create({
      data: {
        projectId: project.id,
        snapshot: { lifecycle: true } as Prisma.InputJsonValue,
      },
    });
    const runInput = await prisma.runInput.create({
      data: {
        runId: run.id,
        nodeId: source.id,
        role: 'prompt',
        sortOrder: 0,
        snapshot: { lifecycle: true } as Prisma.InputJsonValue,
      },
    });
    const ledger = await prisma.usageLedger.create({
      data: { runId: run.id, amount: '0.01' },
    });
    const webhook = await prisma.webhookEvent.create({
      data: {
        eventId: `lifecycle-event-${schemaName}`,
        provider: 'test',
        payload: { lifecycle: true } as Prisma.InputJsonValue,
      },
    });

    const createdRows = [session, edge, assetVersion, upload, runInput, ledger, webhook];
    for (const row of createdRows) {
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
    }

    // @updatedAt is owned by Prisma, so use a later clock tick and verify each
    // newly migrated table updates its lifecycle value without hand-written SQL.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [
      updatedSession,
      updatedEdge,
      updatedVersion,
      updatedUpload,
      updatedRunInput,
      updatedLedger,
      updatedWebhook,
    ] = await Promise.all([
      prisma.authSession.update({
        where: { id: session.id },
        data: { lastUsedAt: new Date() },
      }),
      prisma.canvasEdge.update({ where: { id: edge.id }, data: { sortOrder: 1 } }),
      prisma.assetVersion.update({
        where: { id: assetVersion.id },
        data: { metadata: { lifecycle: 'updated' } },
      }),
      prisma.uploadSession.update({
        where: { id: upload.id },
        data: { expiresAt: new Date(Date.now() + 120_000) },
      }),
      prisma.runInput.update({
        where: { id: runInput.id },
        data: { snapshot: { lifecycle: 'updated' } as Prisma.InputJsonValue },
      }),
      prisma.usageLedger.update({
        where: { id: ledger.id },
        data: { metadata: { lifecycle: 'updated' } },
      }),
      prisma.webhookEvent.update({
        where: { id: webhook.id },
        data: { processedAt: new Date() },
      }),
    ]);

    for (const [created, updated] of [
      [session, updatedSession],
      [edge, updatedEdge],
      [assetVersion, updatedVersion],
      [upload, updatedUpload],
      [runInput, updatedRunInput],
      [ledger, updatedLedger],
      [webhook, updatedWebhook],
    ]) {
      expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    }
  });

  it('applies 0001-0007, preserves historical rows, then applies 0008 in a temporary database', async () => {
    const migrationDatabaseName = `mc_migration_test_${randomBytes(12).toString('hex')}`;
    assertTemporaryDatabaseName(migrationDatabaseName);
    const adminDatabaseUrl = withoutSchema(testDatabaseUrl!);
    const migrationDatabaseUrl = withDatabase(testDatabaseUrl!, migrationDatabaseName);
    const migrationWorkspace = await createMigrationWorkspace(preLifecycleMigrations);
    let legacy: PrismaClient | undefined;
    let databaseCreated = false;

    try {
      await createTemporaryDatabase(adminDatabaseUrl, migrationDatabaseName);
      databaseCreated = true;

      // Run the real historical chain from an isolated copy. It contains no
      // application data and is removed in the finally block.
      await runPnpm(
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', migrationWorkspace.schemaPath],
        migrationDatabaseUrl,
      );

      legacy = new PrismaClient({ datasources: { db: { url: migrationDatabaseUrl } } });
      const historicalRows = await insertHistoricalLifecycleRows(legacy);
      await legacy.$disconnect();
      legacy = undefined;

      await cp(
        join(prismaMigrationsPath, '0008_lifecycle_timestamps'),
        join(migrationWorkspace.migrationsPath, '0008_lifecycle_timestamps'),
        { recursive: true },
      );
      await runPnpm(
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', migrationWorkspace.schemaPath],
        migrationDatabaseUrl,
      );

      // Bring the isolated database to the current schema before comparing it
      // with the current datamodel. The assertions above already prove the
      // 0008 compatibility boundary; later migrations only close the diff.
      await copyMigrations(migrationWorkspace, postLifecycleMigrations);
      await runPnpm(
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', migrationWorkspace.schemaPath],
        migrationDatabaseUrl,
      );

      legacy = new PrismaClient({ datasources: { db: { url: migrationDatabaseUrl } } });

      const updatedColumns = await legacy.$queryRaw<
        Array<{ tableName: string; columnDefault: string | null; isNullable: string }>
      >(Prisma.sql`
        SELECT
          table_name AS "tableName",
          column_default AS "columnDefault",
          is_nullable AS "isNullable"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'updatedAt'
          AND table_name IN (${Prisma.join(lifecycleTables)})
        ORDER BY table_name
      `);
      expect(updatedColumns).toHaveLength(lifecycleTables.length);
      expect(updatedColumns.map((column) => column.tableName)).toEqual([...lifecycleTables].sort());
      for (const column of updatedColumns) {
        expect(column.columnDefault).toMatch(/CURRENT_TIMESTAMP/i);
        expect(column.isNullable).toBe('NO');
      }

      const historicalValues = await readHistoricalLifecycleRows(legacy, historicalRows);
      for (const row of historicalValues.filter((value) => value.tableName !== 'webhook_events')) {
        expect(row.updatedAt.getTime()).toBe(row.createdAt.getTime());
      }
      const webhook = historicalValues.find((row) => row.tableName === 'webhook_events');
      expect(webhook?.createdAt.getTime()).toBe(historicalRows.webhookReceivedAt.getTime());
      expect(webhook?.updatedAt.getTime()).toBe(historicalRows.webhookProcessedAt.getTime());

      const oldClientRows = await insertExpandCompatibleRows(legacy, historicalRows);
      const oldClientValues = await readHistoricalLifecycleRows(legacy, oldClientRows);
      for (const row of oldClientValues) {
        expect(row.createdAt).toBeInstanceOf(Date);
        expect(row.updatedAt).toBeInstanceOf(Date);
      }

      // Full schema diff catches public-schema and default mismatches.
      await runPnpm(
        [
          'exec',
          'prisma',
          'migrate',
          'diff',
          '--from-url',
          migrationDatabaseUrl,
          '--to-schema-datamodel',
          prismaSchemaPath,
          '--exit-code',
        ],
        migrationDatabaseUrl,
      );
    } finally {
      await legacy?.$disconnect();
      try {
        if (databaseCreated) await dropTemporaryDatabase(adminDatabaseUrl, migrationDatabaseName);
      } finally {
        await rm(migrationWorkspace.rootPath, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('rolls back every 0008 table change when a later backfill fails', async () => {
    const migrationDatabaseName = `mc_migration_test_${randomBytes(12).toString('hex')}`;
    assertTemporaryDatabaseName(migrationDatabaseName);
    const adminDatabaseUrl = withoutSchema(testDatabaseUrl!);
    const migrationDatabaseUrl = withDatabase(testDatabaseUrl!, migrationDatabaseName);
    const migrationWorkspace = await createMigrationWorkspace(preLifecycleMigrations);
    let databaseCreated = false;
    let rollbackClient: PrismaClient | undefined;

    try {
      await createTemporaryDatabase(adminDatabaseUrl, migrationDatabaseName);
      databaseCreated = true;
      await runPnpm(
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', migrationWorkspace.schemaPath],
        migrationDatabaseUrl,
      );

      rollbackClient = new PrismaClient({ datasources: { db: { url: migrationDatabaseUrl } } });
      await insertHistoricalLifecycleRows(rollbackClient);
      await rollbackClient.$executeRawUnsafe(`
        CREATE FUNCTION "public"."fail_0008_backfill"() RETURNS trigger
        LANGUAGE plpgsql AS $function$
        BEGIN
          RAISE EXCEPTION 'forced 0008 rollback test';
        END;
        $function$
      `);
      await rollbackClient.$executeRawUnsafe(`
        CREATE TRIGGER "fail_0008_backfill"
        BEFORE UPDATE ON "public"."usage_ledger"
        FOR EACH ROW EXECUTE FUNCTION "public"."fail_0008_backfill"()
      `);
      await rollbackClient.$disconnect();
      rollbackClient = undefined;

      await cp(
        join(prismaMigrationsPath, '0008_lifecycle_timestamps'),
        join(migrationWorkspace.migrationsPath, '0008_lifecycle_timestamps'),
        { recursive: true },
      );
      await expect(
        runPnpm(
          ['exec', 'prisma', 'migrate', 'deploy', '--schema', migrationWorkspace.schemaPath],
          migrationDatabaseUrl,
        ),
      ).rejects.toThrow();

      rollbackClient = new PrismaClient({ datasources: { db: { url: migrationDatabaseUrl } } });
      const leakedColumns = await rollbackClient.$queryRaw<Array<{ tableName: string }>>(Prisma.sql`
        SELECT table_name AS "tableName"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'updatedAt'
          AND table_name IN (${Prisma.join(lifecycleTables)})
        ORDER BY table_name
      `);
      expect(leakedColumns).toEqual([]);
    } finally {
      await rollbackClient?.$disconnect();
      try {
        if (databaseCreated) await dropTemporaryDatabase(adminDatabaseUrl, migrationDatabaseName);
      } finally {
        await rm(migrationWorkspace.rootPath, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('applies 0009 to the pre-credential model catalog without losing legacy rows', async () => {
    const migrationDatabaseName = `mc_migration_test_${randomBytes(12).toString('hex')}`;
    assertTemporaryDatabaseName(migrationDatabaseName);
    const adminDatabaseUrl = withoutSchema(testDatabaseUrl!);
    const migrationDatabaseUrl = withDatabase(testDatabaseUrl!, migrationDatabaseName);
    const migrationWorkspace = await createMigrationWorkspace(preModelCatalogCredentialMigrations);
    let databaseCreated = false;
    let migrationClient: PrismaClient | undefined;

    try {
      await createTemporaryDatabase(adminDatabaseUrl, migrationDatabaseName);
      databaseCreated = true;
      await runPnpm(
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', migrationWorkspace.schemaPath],
        migrationDatabaseUrl,
      );

      migrationClient = new PrismaClient({
        datasources: { db: { url: migrationDatabaseUrl } },
      });
      const fixtures = await insertHistoricalModelCatalogRows(migrationClient);
      const legacyRows = await readLegacyModelCatalogRows(migrationClient);
      await migrationClient.$disconnect();
      migrationClient = undefined;

      await cp(
        modelCatalogCredentialMigrationPath,
        join(migrationWorkspace.migrationsPath, '0009_model_catalog_credentials'),
        { recursive: true },
      );
      await runPnpm(
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', migrationWorkspace.schemaPath],
        migrationDatabaseUrl,
      );

      // Apply the remaining migrations only after 0009 has been recorded.
      // Keeping the directory in lexical order mirrors a real forward upgrade
      // and avoids introducing an already-applied migration out of sequence.
      await copyMigrations(migrationWorkspace, postLifecycleMigrations.slice(1));
      await runPnpm(
        ['exec', 'prisma', 'migrate', 'deploy', '--schema', migrationWorkspace.schemaPath],
        migrationDatabaseUrl,
      );

      migrationClient = new PrismaClient({
        datasources: { db: { url: migrationDatabaseUrl } },
      });

      const credentialColumn = await migrationClient.$queryRaw<
        Array<{ dataType: string; isNullable: string }>
      >(Prisma.sql`
        SELECT data_type AS "dataType", is_nullable AS "isNullable"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'model_catalog'
          AND column_name = 'credentialId'
      `);
      expect(credentialColumn).toEqual([{ dataType: 'uuid', isNullable: 'YES' }]);

      const migratedRows = await migrationClient.$queryRaw<
        Array<LegacyModelCatalogRow & { credentialId: string | null }>
      >(Prisma.sql`
        SELECT
          "id",
          "credentialId",
          "modelAlias",
          "name",
          "mediaType"::text AS "mediaType",
          "capabilities",
          "limitations",
          "price",
          "refreshedAt",
          "createdAt",
          "updatedAt"
        FROM "public"."model_catalog"
        ORDER BY "modelAlias", "mediaType"::text
      `);
      expect(
        migratedRows.map(({ credentialId, ...row }) => {
          expect(credentialId).toBe(fixtures.activeCredentialId);
          return row;
        }),
      ).toEqual(legacyRows);

      const indexes = await migrationClient.$queryRaw<
        Array<{ indexDefinition: string; indexName: string }>
      >(Prisma.sql`
        SELECT indexname AS "indexName", indexdef AS "indexDefinition"
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'model_catalog'
        ORDER BY indexname
      `);
      const indexesByName = new Map(
        indexes.map(({ indexDefinition, indexName }) => [indexName, indexDefinition]),
      );
      expect(indexesByName.has('model_catalog_modelAlias_mediaType_key')).toBe(false);
      expect(indexesByName.has('model_catalog_mediaType_idx')).toBe(false);
      expect(indexesByName.get('model_catalog_credentialId_modelAlias_mediaType_key')).toMatch(
        /UNIQUE INDEX[\s\S]*\("credentialId", "modelAlias", "mediaType"\)/,
      );
      expect(indexesByName.get('model_catalog_credentialId_mediaType_idx')).toMatch(
        /INDEX[\s\S]*\("credentialId", "mediaType"\)/,
      );

      const foreignKeys = await migrationClient.$queryRaw<
        Array<{
          constraintName: string;
          deleteAction: string;
          updateAction: string;
        }>
      >(Prisma.sql`
        SELECT
          constraints.conname AS "constraintName",
          constraints.confdeltype::text AS "deleteAction",
          constraints.confupdtype::text AS "updateAction"
        FROM pg_constraint AS constraints
        JOIN pg_class AS tables ON tables.oid = constraints.conrelid
        JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
        WHERE schemas.nspname = 'public'
          AND tables.relname = 'model_catalog'
          AND constraints.contype = 'f'
          AND constraints.conname = 'model_catalog_credentialId_fkey'
      `);
      expect(foreignKeys).toEqual([
        {
          constraintName: 'model_catalog_credentialId_fkey',
          deleteAction: 'c',
          updateAction: 'c',
        },
      ]);

      const scopedDuplicateId = randomUUID();
      await migrationClient.$executeRaw(Prisma.sql`
        INSERT INTO "public"."model_catalog"
          ("id", "credentialId", "modelAlias", "name", "mediaType", "refreshedAt", "createdAt", "updatedAt")
        VALUES
          (${scopedDuplicateId}::uuid, ${fixtures.olderCredentialId}::uuid,
           ${legacyRows[0]!.modelAlias}, 'Credential-scoped duplicate',
           ${legacyRows[0]!.mediaType}::"public"."MediaType", CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `);

      await expect(
        migrationClient.$executeRaw(Prisma.sql`
          INSERT INTO "public"."model_catalog"
            ("id", "credentialId", "modelAlias", "name", "mediaType", "refreshedAt", "createdAt", "updatedAt")
          VALUES
            (${randomUUID()}::uuid, ${fixtures.activeCredentialId}::uuid,
             ${legacyRows[0]!.modelAlias}, 'Duplicate in one credential',
             ${legacyRows[0]!.mediaType}::"public"."MediaType", CURRENT_TIMESTAMP,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `),
      ).rejects.toThrow();

      await expect(
        migrationClient.$executeRaw(Prisma.sql`
          INSERT INTO "public"."model_catalog"
            ("id", "credentialId", "modelAlias", "name", "mediaType", "refreshedAt", "createdAt", "updatedAt")
          VALUES
            (${randomUUID()}::uuid, ${randomUUID()}::uuid, 'missing-credential-model',
             'Missing credential', 'TEXT'::"public"."MediaType", CURRENT_TIMESTAMP,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `),
      ).rejects.toThrow();

      await migrationClient.$executeRaw(Prisma.sql`
        DELETE FROM "public"."ai_credentials"
        WHERE "id" = ${fixtures.olderCredentialId}::uuid
      `);
      const cascadedRows = await migrationClient.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "count"
        FROM "public"."model_catalog"
        WHERE "id" = ${scopedDuplicateId}::uuid
      `);
      expect(cascadedRows).toEqual([{ count: 0n }]);

      await runPnpm(
        [
          'exec',
          'prisma',
          'migrate',
          'diff',
          '--from-url',
          migrationDatabaseUrl,
          '--to-schema-datamodel',
          prismaSchemaPath,
          '--exit-code',
        ],
        migrationDatabaseUrl,
      );
    } finally {
      await migrationClient?.$disconnect();
      try {
        if (databaseCreated) await dropTemporaryDatabase(adminDatabaseUrl, migrationDatabaseName);
      } finally {
        await rm(migrationWorkspace.rootPath, { recursive: true, force: true });
      }
    }
  }, 120_000);

  redisIntegrationDescribe('Redis isolation', () => {
    it('uses only the explicit test namespace', async () => {
      const client = new Redis(testRedisUrl!, {
        connectTimeout: 5_000,
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      const key = `${testRedisNamespace}:health:${randomBytes(12).toString('hex')}`;
      try {
        await client.connect();
        await client.set(key, 'isolated', 'PX', 60_000);
        await expect(client.get(key)).resolves.toBe('isolated');
        await client.del(key);
        await expect(client.get(key)).resolves.toBeNull();
      } finally {
        client.disconnect();
      }
    });
  });

  minioIntegrationDescribe('MinIO isolation', () => {
    it('writes and removes bytes only under the configured test prefix', async () => {
      const config = testS3Config!;
      const blobStore = new S3BlobStore(config.bucket, {
        endpoint: config.endpoint,
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        forcePathStyle: true,
      });
      const key = `${config.keyPrefix}/${schemaName}/${randomBytes(12).toString('hex')}.txt`;
      try {
        await blobStore.put(key, Buffer.from('isolated minio integration'));
        await expect(blobStore.get(key)).resolves.toEqual(
          Buffer.from('isolated minio integration'),
        );
      } finally {
        await blobStore.delete(key);
      }
      await expect(blobStore.get(key)).resolves.toBeUndefined();
    });
  });
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

type LegacyModelCatalogRow = {
  id: string;
  modelAlias: string;
  name: string;
  mediaType: string;
  capabilities: Prisma.JsonValue | null;
  limitations: Prisma.JsonValue | null;
  price: Prisma.JsonValue | null;
  refreshedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

async function insertHistoricalModelCatalogRows(prisma: PrismaClient): Promise<{
  activeCredentialId: string;
  olderCredentialId: string;
}> {
  const activeCredentialId = randomUUID();
  const olderCredentialId = randomUUID();
  const incompleteCredentialId = randomUUID();
  const credentialCreatedAt = new Date('2025-02-01T00:00:00.000Z');
  const activeCredentialUpdatedAt = new Date('2025-03-01T00:00:00.000Z');
  const incompleteCredentialUpdatedAt = new Date('2025-04-01T00:00:00.000Z');
  const catalogCreatedAt = new Date('2025-03-02T01:02:03.000Z');
  const catalogUpdatedAt = new Date('2025-03-03T04:05:06.000Z');
  const refreshedAt = new Date('2025-03-04T07:08:09.000Z');
  const catalogRows = [
    {
      id: randomUUID(),
      modelAlias: 'legacy-image-model',
      name: 'Legacy Image Model',
      mediaType: 'IMAGE',
      capabilities: { image: true, references: 2 },
      limitations: { maxPromptLength: 2048 },
      price: { currency: 'USD', unit: 'image', value: 0.02 },
    },
    {
      id: randomUUID(),
      modelAlias: 'legacy-text-model',
      name: 'Legacy Text Model',
      mediaType: 'TEXT',
      capabilities: { chat: true, contextWindow: 8192 },
      limitations: null,
      price: { currency: 'USD', unit: 'token', value: 0.000001 },
    },
  ] as const;

  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "public"."ai_credentials"
        ("id", "projectId", "ownerId", "label", "baseUrl", "encryptedApiKey",
         "keyFingerprint", "version", "defaultModels", "createdAt", "updatedAt")
      VALUES
        (${olderCredentialId}::uuid, NULL, NULL, 'Legacy platform key v1',
         'https://newapi.integration.test/v1', 'integration-encrypted-v1',
         'integration-fingerprint-v1', 1, NULL, ${credentialCreatedAt},
         ${activeCredentialUpdatedAt}),
        (${activeCredentialId}::uuid, NULL, NULL, 'Legacy platform key v2',
         'https://newapi.integration.test/v1', 'integration-encrypted-v2',
         'integration-fingerprint-v2', 2, NULL, ${credentialCreatedAt},
         ${activeCredentialUpdatedAt}),
        (${incompleteCredentialId}::uuid, NULL, NULL, 'Incomplete platform key', '', '',
         'integration-fingerprint-incomplete', 3, NULL, ${credentialCreatedAt},
         ${incompleteCredentialUpdatedAt})
    `);

    for (const row of catalogRows) {
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "public"."model_catalog"
          ("id", "modelAlias", "name", "mediaType", "capabilities", "limitations", "price",
           "refreshedAt", "createdAt", "updatedAt")
        VALUES
          (${row.id}::uuid, ${row.modelAlias}, ${row.name},
           ${row.mediaType}::"public"."MediaType",
           ${JSON.stringify(row.capabilities)}::jsonb,
           ${row.limitations === null ? Prisma.sql`NULL` : Prisma.sql`${JSON.stringify(row.limitations)}::jsonb`},
           ${JSON.stringify(row.price)}::jsonb, ${refreshedAt}, ${catalogCreatedAt},
           ${catalogUpdatedAt})
      `);
    }
  });

  return { activeCredentialId, olderCredentialId };
}

async function readLegacyModelCatalogRows(prisma: PrismaClient): Promise<LegacyModelCatalogRow[]> {
  return prisma.$queryRaw<LegacyModelCatalogRow[]>(Prisma.sql`
    SELECT
      "id",
      "modelAlias",
      "name",
      "mediaType"::text AS "mediaType",
      "capabilities",
      "limitations",
      "price",
      "refreshedAt",
      "createdAt",
      "updatedAt"
    FROM "public"."model_catalog"
    ORDER BY "modelAlias", "mediaType"::text
  `);
}

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
      if (!/^\d{4}_[a-z0-9_]+$/.test(migration)) {
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
    if (!/^\d{4}_[a-z0-9_]+$/.test(migration)) {
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
