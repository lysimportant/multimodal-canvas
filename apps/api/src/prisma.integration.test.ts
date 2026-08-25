import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FileSystemBlobStore, PrismaAssetStore } from './assets';
import { PrismaProjectStore } from './projects';
import { PrismaAiSettingsStore } from './settings';

/**
 * This suite intentionally has no DATABASE_URL fallback. It only runs with a
 * separately provisioned test connection and creates a random PostgreSQL
 * schema inside that database. Set TEST_DATABASE_URL to a disposable database
 * before running it; all other test runs skip the suite.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (
  testDatabaseUrl &&
  process.env.DATABASE_URL &&
  databaseIdentity(testDatabaseUrl) === databaseIdentity(process.env.DATABASE_URL)
) {
  throw new Error('TEST_DATABASE_URL must point to a separate database from DATABASE_URL');
}

const integrationDescribe = testDatabaseUrl ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const prismaSchemaPath = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));

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

    await execFileAsync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'prisma', 'db', 'push', '--schema', prismaSchemaPath, '--skip-generate'],
      {
        cwd: workspaceRoot,
        env: { ...process.env, DATABASE_URL: scopedDatabaseUrl },
        maxBuffer: 8 * 1024 * 1024,
      },
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
      defaultModels: { text: 'integration-text-model' },
    });
    expect(JSON.stringify(updated)).not.toContain('integration-api-key');
    await firstSettings.close?.();

    const restartedSettings = new PrismaAiSettingsStore(prisma, settingsSecret);
    await expect(restartedSettings.get()).resolves.toMatchObject({
      configured: true,
      defaultModels: { text: 'integration-text-model' },
    });
    await expect(restartedSettings.getCredentialReference()).resolves.toMatchObject({
      credentialVersion: 1,
    });
    const credential = await prisma.aiCredential.findFirst({ where: { projectId: null } });
    expect(credential?.encryptedApiKey).toBeTruthy();
    expect(credential?.encryptedApiKey).not.toContain('integration-api-key');
  });
});

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function withoutSchema(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete('schema');
  return url.toString();
}

function databaseIdentity(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return [url.hostname, url.port, url.pathname].join('|');
}
