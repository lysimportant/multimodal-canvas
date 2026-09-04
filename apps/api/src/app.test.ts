import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { MemoryAssetStore } from './assets';
import { buildApp } from './app';
import { MemoryAuthStore } from './auth-store';
import { MemoryProjectStore } from './projects';
import { AiSettingsStore, type ModelCatalogEntry } from './settings';
import { MemoryRunService } from './runs';
import { MemoryWebhookEventStore } from './webhooks';

const appSettingsStore = new AiSettingsStore('app-test-model-catalog');
const appModelRefreshedAt = new Date().toISOString();
appSettingsStore.replaceModels([
  {
    id: 'text-model',
    name: 'Text model',
    mediaTypes: ['text'],
    refreshedAt: appModelRefreshedAt,
  },
  {
    id: 'video-model',
    name: 'Video model',
    mediaTypes: ['video'],
    refreshedAt: appModelRefreshedAt,
  },
  {
    id: 'image-node-model',
    name: 'Image node model',
    mediaTypes: ['image'],
    refreshedAt: appModelRefreshedAt,
  },
  {
    id: 'image-special',
    name: 'Image special',
    mediaTypes: ['image'],
    refreshedAt: appModelRefreshedAt,
  },
]);
const appRunService = new MemoryRunService();
const app = buildApp({
  logger: false,
  assetStore: new MemoryAssetStore(),
  settingsStore: appSettingsStore,
  runService: appRunService,
});

afterAll(async () => app.close());

describe('health endpoint', () => {
  it('reports that the API is available', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'api' });
  });
});

describe('project management endpoints', () => {
  it('renames, archives, lists, and restores a project without losing it', async () => {
    const projectApp = buildApp({ logger: false, projectStore: new MemoryProjectStore() });
    try {
      const created = await projectApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Draft project' },
      });
      expect(created.statusCode).toBe(201);
      const projectId = created.json().project.id as string;

      const renamed = await projectApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}`,
        payload: { name: 'Final project' },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().project).toMatchObject({ id: projectId, name: 'Final project' });

      const archived = await projectApp.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/archive`,
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().project).toMatchObject({
        id: projectId,
        name: 'Final project',
        archivedAt: expect.any(String),
      });

      const defaultList = await projectApp.inject({ method: 'GET', url: '/v1/projects' });
      expect(defaultList.statusCode).toBe(200);
      expect(defaultList.json().projects).toEqual([]);

      const archivedList = await projectApp.inject({
        method: 'GET',
        url: '/v1/projects?includeArchived=true',
      });
      expect(archivedList.statusCode).toBe(200);
      expect(archivedList.json().projects).toMatchObject([
        { id: projectId, name: 'Final project', archivedAt: expect.any(String) },
      ]);

      const restored = await projectApp.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/restore`,
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().project).toMatchObject({ id: projectId, name: 'Final project' });
      expect(restored.json().project.archivedAt).toBeUndefined();

      const restoredList = await projectApp.inject({ method: 'GET', url: '/v1/projects' });
      expect(restoredList.json().projects).toMatchObject([
        { id: projectId, name: 'Final project' },
      ]);
    } finally {
      await projectApp.close();
    }
  });

  it('rejects blank project names when creating or renaming', async () => {
    const projectApp = buildApp({ logger: false, projectStore: new MemoryProjectStore() });
    try {
      const create = await projectApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: '   ' },
      });
      expect(create.statusCode).toBe(400);

      const project = await projectApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Keep this name' },
      });
      const rename = await projectApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${project.json().project.id}`,
        payload: { name: '' },
      });
      expect(rename.statusCode).toBe(400);
    } finally {
      await projectApp.close();
    }
  });
});

describe('OpenAPI endpoint', () => {
  it('publishes the documented retry and credential routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/documentation/json' });

    expect(response.statusCode).toBe(200);
    expect(response.json().paths['/v1/runs/{runId}/retry']).toBeDefined();
    expect(response.json().paths['/v1/projects/{projectId}/runs']).toBeDefined();
    expect(response.json().paths['/v1/projects/{projectId}/models/defaults']).toBeDefined();
    expect(response.json().paths['/v1/settings/ai'].get.responses).toMatchObject({
      '200': expect.any(Object),
      '403': expect.any(Object),
    });
    expect(response.json().paths['/v1/settings/ai'].patch.responses).toMatchObject({
      '200': expect.any(Object),
      '400': expect.any(Object),
      '403': expect.any(Object),
      '404': expect.any(Object),
    });
    expect(response.json().paths['/v1/settings/ai/credentials'].get).toBeDefined();
    expect(response.json().paths['/v1/settings/ai/credentials'].delete).toBeDefined();
    expect(
      response.json().paths['/v1/settings/ai/credentials/{credentialId}/activate'].post,
    ).toBeDefined();
    expect(response.json().paths['/v1/runs/{runId/retry}']).toBeUndefined();

    const runSchema = response.json().components.schemas.Run;
    expect(runSchema.additionalProperties).toBe(false);
    expect(runSchema.properties.providerJob).toBeUndefined();
    expect(runSchema.properties.snapshot).toMatchObject({
      required: ['canvasRevision', 'inputCount', 'inputs'],
      additionalProperties: false,
    });
    expect(runSchema.properties.result).toMatchObject({ additionalProperties: false });
  });
});

describe('AI settings endpoints', () => {
  it('never returns the configured API key and exposes model defaults', async () => {
    const credentialUpdate = await app.inject({
      method: 'PATCH',
      url: '/v1/settings/ai',
      payload: {
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'secret-test-key',
      },
    });
    expect(credentialUpdate.statusCode).toBe(200);
    const credentialId = credentialUpdate
      .json()
      .credentials.find(
        (credential: { baseUrl: string }) => credential.baseUrl === 'https://newapi.example.com/v1',
      ).id as string;
    appSettingsStore.replaceModels(
      [
        {
          id: 'text-model',
          name: 'Text model',
          mediaTypes: ['text'],
          refreshedAt: appModelRefreshedAt,
        },
        {
          id: 'video-model',
          name: 'Video model',
          mediaTypes: ['video'],
          refreshedAt: appModelRefreshedAt,
        },
        {
          id: 'image-node-model',
          name: 'Image node model',
          mediaTypes: ['image'],
          refreshedAt: appModelRefreshedAt,
        },
        {
          id: 'image-special',
          name: 'Image special',
          mediaTypes: ['image'],
          refreshedAt: appModelRefreshedAt,
        },
      ],
      credentialId,
    );
    const update = await app.inject({
      method: 'PATCH',
      url: '/v1/settings/ai',
      payload: { defaultModels: { text: 'text-model', video: 'video-model' } },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().settings).toMatchObject({
      baseUrl: 'https://newapi.example.com/v1',
      configured: true,
      keyFingerprint: expect.stringMatching(/^[a-f0-9]{12}$/),
      defaultModels: {
        text: { modelAlias: 'text-model' },
        video: { modelAlias: 'video-model' },
      },
    });
    expect(JSON.stringify(update.json())).not.toContain('secret-test-key');

    const get = await app.inject({ method: 'GET', url: '/v1/settings/ai' });
    expect(get.json().settings.configured).toBe(true);
  });

  it('validates platform defaults against the active credential catalog before saving', async () => {
    const settingsStore = new AiSettingsStore('platform-default-validation');
    const settingsApp = buildApp({ logger: false, settingsStore });
    try {
      const credentialSave = await settingsApp.inject({
        method: 'PATCH',
        url: '/v1/settings/ai',
        payload: {
          baseUrl: 'https://platform-defaults.example/v1',
          apiKey: 'synthetic-platform-defaults-key',
        },
      });
      const credentialId = credentialSave.json().credentials[0].id as string;
      settingsStore.replaceModels(
        [
          {
            id: 'platform-image',
            name: 'Platform image',
            mediaTypes: ['image'],
            refreshedAt: new Date().toISOString(),
          },
        ],
        credentialId,
      );

      const saved = await settingsApp.inject({
        method: 'PATCH',
        url: '/v1/settings/ai',
        payload: {
          defaultModels: {
            image: { modelAlias: 'platform-image', credentialId },
          },
        },
      });
      expect(saved.statusCode).toBe(200);

      const wrongMediaType = await settingsApp.inject({
        method: 'PATCH',
        url: '/v1/settings/ai',
        payload: {
          defaultModels: {
            video: { modelAlias: 'platform-image', credentialId },
          },
        },
      });
      expect(wrongMediaType.statusCode).toBe(400);
      expect(wrongMediaType.json()).toMatchObject({ code: 'model_unavailable' });

      const unknownModel = await settingsApp.inject({
        method: 'PATCH',
        url: '/v1/settings/ai',
        payload: { defaultModels: { image: 'missing-platform-model' } },
      });
      expect(unknownModel.statusCode).toBe(400);
      expect(unknownModel.json()).toMatchObject({ code: 'model_unavailable' });

      const unknownCredential = await settingsApp.inject({
        method: 'PATCH',
        url: '/v1/settings/ai',
        payload: {
          defaultModels: {
            image: {
              modelAlias: 'platform-image',
              credentialId: '123e4567-e89b-12d3-a456-426614174099',
            },
          },
        },
      });
      expect(unknownCredential.statusCode).toBe(404);
      expect(unknownCredential.json()).toMatchObject({ code: 'credential_not_found' });

      const current = await settingsApp.inject({ method: 'GET', url: '/v1/settings/ai' });
      expect(current.json().settings.defaultModels).toEqual({
        image: { modelAlias: 'platform-image', credentialId },
      });
    } finally {
      await settingsApp.close();
    }
  });

  it('lists, deduplicates, and activates credential summaries without exposing keys', async () => {
    const settingsStore = new AiSettingsStore('credential-route-test');
    const credentialApp = buildApp({ logger: false, settingsStore });
    const firstKey = 'first-route-secret';
    const secondKey = 'second-route-secret';
    try {
      const firstSave = await credentialApp.inject({
        method: 'PATCH',
        url: '/v1/settings/ai',
        payload: { baseUrl: 'https://first.example.com/v1', apiKey: firstKey },
      });
      expect(firstSave.statusCode).toBe(200);
      const firstCredential = firstSave.json().credentials[0];
      expect(firstCredential).toMatchObject({
        baseUrl: 'https://first.example.com/v1',
        active: true,
      });

      const duplicateSave = await credentialApp.inject({
        method: 'PATCH',
        url: '/v1/settings/ai',
        payload: { baseUrl: 'https://first.example.com/v1', apiKey: firstKey },
      });
      expect(duplicateSave.json().credentials).toHaveLength(1);
      expect(duplicateSave.json().credentials[0].id).toBe(firstCredential.id);

      const secondSave = await credentialApp.inject({
        method: 'PATCH',
        url: '/v1/settings/ai',
        payload: { baseUrl: 'https://second.example.com/v1', apiKey: secondKey },
      });
      expect(secondSave.json().credentials).toHaveLength(2);
      expect(
        secondSave.json().credentials.find((item: { active: boolean }) => item.active),
      ).toMatchObject({ baseUrl: 'https://second.example.com/v1' });

      const list = await credentialApp.inject({
        method: 'GET',
        url: '/v1/settings/ai/credentials',
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().credentials).toHaveLength(2);

      const activated = await credentialApp.inject({
        method: 'POST',
        url: `/v1/settings/ai/credentials/${firstCredential.id}/activate`,
      });
      expect(activated.statusCode).toBe(200);
      expect(activated.json().settings).toMatchObject({
        baseUrl: 'https://first.example.com/v1',
        keyFingerprint: firstCredential.keyFingerprint,
      });
      expect(
        activated.json().credentials.find((item: { active: boolean }) => item.active),
      ).toMatchObject({ baseUrl: 'https://first.example.com/v1' });

      const missing = await credentialApp.inject({
        method: 'POST',
        url: '/v1/settings/ai/credentials/123e4567-e89b-12d3-a456-426614174099/activate',
      });
      expect(missing.statusCode).toBe(404);

      const serialized = [firstSave, duplicateSave, secondSave, list, activated]
        .map((response) => response.body)
        .join('\n');
      expect(serialized).not.toContain(firstKey);
      expect(serialized).not.toContain(secondKey);
    } finally {
      await credentialApp.close();
    }
  });

  it('rejects insecure remote base URLs', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/settings/ai',
      payload: { baseUrl: 'http://api.example.com/v1' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps the previous model catalog when refresh fails', async () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'secret-test-key' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'image-v1', mediaType: 'image' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockRejectedValue(new Error('upstream unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(store.refreshModels()).resolves.toMatchObject([{ id: 'image-v1' }]);
      await expect(store.refreshModels()).rejects.toThrow('upstream unavailable');
      expect(store.listModels()).toMatchObject([{ id: 'image-v1', mediaTypes: ['image'] }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves a media-compatible default or explicit model at submission time', async () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.update({ defaultModels: { image: 'image-v2' } });
    expect(store.resolveModel('image')).toBe('image-v2');
    expect(store.resolveModel('image', 'mock-image')).toBe('mock-image');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'image-v2', mediaType: 'image' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      store.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'secret-test-key' });
      await store.refreshModels();
      expect(() => store.resolveModel('text', 'image-v2')).toThrow('不支持 text');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('asset endpoints', () => {
  it('starts with an empty asset collection', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/assets' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assets: [], total: 0, page: 1, pageSize: 50 });
  });

  it('filters, paginates, and scopes asset search results to the authenticated owner', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', 'asset-list-query-secret');
    const assetStore = new MemoryAssetStore();
    const authStore = new MemoryAuthStore();
    const listApp = buildApp({ logger: false, assetStore, authStore });
    try {
      const register = async (email: string) => {
        const response = await listApp.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: { email, password: 'strong-password-123' },
        });
        expect(response.statusCode).toBe(201);
        return response.json() as { accessToken: string; user: { id: string } };
      };
      const owner = await register('asset-list-owner@example.test');
      const other = await register('asset-list-other@example.test');

      await assetStore.create({
        ownerId: owner.user.id,
        name: 'hero-one.png',
        mediaType: 'image',
        mimeType: 'image/png',
        content: Buffer.from('one'),
        tags: ['Hero', 'Reference'],
      });
      await assetStore.create({
        ownerId: owner.user.id,
        name: 'hero-two.png',
        mediaType: 'image',
        mimeType: 'image/png',
        content: Buffer.from('two'),
        tags: ['hero', 'Reference'],
      });
      const archived = await assetStore.create({
        ownerId: owner.user.id,
        name: 'hero-archived.png',
        mediaType: 'image',
        mimeType: 'image/png',
        content: Buffer.from('archived'),
        tags: ['hero', 'Reference'],
      });
      await assetStore.setArchived(archived.id, true, { ownerId: owner.user.id });
      await assetStore.create({
        ownerId: other.user.id,
        name: 'hero-other.png',
        mediaType: 'image',
        mimeType: 'image/png',
        content: Buffer.from('other'),
        tags: ['hero', 'Reference'],
      });

      const headers = { authorization: `Bearer ${owner.accessToken}` };
      const firstPage = await listApp.inject({
        method: 'GET',
        url: '/v1/assets?query=hero&mediaType=image&status=ready&tags=HERO,reference&page=1&pageSize=1',
        headers,
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json()).toMatchObject({ total: 2, page: 1, pageSize: 1 });
      expect(firstPage.json().assets).toHaveLength(1);
      expect(firstPage.json().assets[0].name).toBe('hero-one.png');

      const secondPage = await listApp.inject({
        method: 'GET',
        url: '/v1/assets?query=hero&mediaType=image&status=ready&tags=hero&Page=ignored&page=2&pageSize=1',
        headers,
      });
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json()).toMatchObject({ total: 2, page: 2, pageSize: 1 });
      expect(secondPage.json().assets).toHaveLength(1);
      expect(secondPage.json().assets[0].name).toBe('hero-two.png');

      const archivedResults = await listApp.inject({
        method: 'GET',
        url: '/v1/assets?status=archived&mediaType=image',
        headers,
      });
      expect(archivedResults.statusCode).toBe(200);
      expect(archivedResults.json()).toMatchObject({ total: 1, page: 1, pageSize: 50 });
      expect(archivedResults.json().assets[0].name).toBe('hero-archived.png');

      expect(
        (
          await listApp.inject({
            method: 'GET',
            url: '/v1/assets',
            headers: { authorization: `Bearer ${other.accessToken}` },
          })
        ).json().total,
      ).toBe(1);
      expect(
        (await listApp.inject({ method: 'GET', url: '/v1/assets?mediaType=invalid', headers }))
          .statusCode,
      ).toBe(400);
      expect(
        (await listApp.inject({ method: 'GET', url: '/v1/assets?page=0', headers })).statusCode,
      ).toBe(400);
    } finally {
      await listApp.close();
      vi.unstubAllEnvs();
    }
  });

  it('limits project-scoped asset search to the selected project plus personal resources', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', 'asset-project-scope-secret');
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const authStore = new MemoryAuthStore();
    const listApp = buildApp({ logger: false, assetStore, projectStore, authStore });
    try {
      const register = async (email: string) => {
        const response = await listApp.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: { email, password: 'strong-password-123' },
        });
        expect(response.statusCode).toBe(201);
        return response.json() as { accessToken: string; user: { id: string } };
      };
      const owner = await register('asset-project-owner@example.test');
      const other = await register('asset-project-other@example.test');
      const createProject = async (name: string, accessToken: string) => {
        const response = await listApp.inject({
          method: 'POST',
          url: '/v1/projects',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name },
        });
        expect(response.statusCode).toBe(201);
        return response.json().project as { id: string };
      };
      const ownerProject = await createProject('Owner project', owner.accessToken);
      const otherProject = await createProject('Other project', other.accessToken);

      const createAsset = (input: { name: string; projectId?: string; ownerId?: string }) =>
        assetStore.create({
          ...input,
          mediaType: 'image',
          mimeType: 'image/png',
          content: Buffer.from(input.name),
        });
      await createAsset({ name: 'project-only.png', projectId: ownerProject.id });
      await createAsset({ name: 'personal.png', ownerId: owner.user.id });
      await createAsset({
        name: 'other-project.png',
        projectId: otherProject.id,
        ownerId: other.user.id,
      });

      const scoped = await listApp.inject({
        method: 'GET',
        url: `/v1/assets?projectId=${encodeURIComponent(ownerProject.id)}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(scoped.statusCode).toBe(200);
      expect(scoped.json().total).toBe(2);
      expect(scoped.json().assets.map((asset: { name: string }) => asset.name)).toEqual(
        expect.arrayContaining(['project-only.png', 'personal.png']),
      );
      expect(scoped.json().assets.map((asset: { name: string }) => asset.name)).not.toContain(
        'other-project.png',
      );

      const forbiddenProject = await listApp.inject({
        method: 'GET',
        url: `/v1/assets?projectId=${encodeURIComponent(otherProject.id)}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(forbiddenProject.statusCode).toBe(404);
    } finally {
      await listApp.close();
      vi.unstubAllEnvs();
    }
  });

  it('returns the current asset version in an explicit field and legacy metadata', async () => {
    const assetStore = new MemoryAssetStore();
    const listApp = buildApp({ logger: false, assetStore });
    try {
      const created = await assetStore.create({
        name: 'versioned-reference.png',
        mediaType: 'image',
        mimeType: 'image/png',
        content: Buffer.from('version-one'),
      });
      await assetStore.createVersion(created.id, { content: Buffer.from('version-two') });

      const response = await listApp.inject({ method: 'GET', url: '/v1/assets' });
      expect(response.statusCode).toBe(200);
      expect(response.json().assets).toEqual([
        expect.objectContaining({
          id: created.id,
          latestVersion: 2,
          metadata: expect.objectContaining({ version: 2 }),
        }),
      ]);
    } finally {
      await listApp.close();
    }
  });

  it('uploads an asset and serves its original content', async () => {
    const boundary = 'asset-test-boundary';
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(upload.statusCode).toBe(201);
    const uploadedAsset = upload.json().asset;
    expect(uploadedAsset).toMatchObject({
      name: 'reference.png',
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: content.byteLength,
      status: 'ready',
    });

    const contentResponse = await app.inject({
      method: 'GET',
      url: uploadedAsset.contentUrl,
    });

    expect(contentResponse.statusCode).toBe(200);
    expect(contentResponse.headers['content-type']).toContain('image/png');
    expect(contentResponse.rawPayload).toEqual(content);
  });

  it('stores and serves generated media derivatives through the asset boundary', async () => {
    const derivativeApp = buildApp({
      logger: false,
      mediaDerivativeGenerator: {
        generate: async () => [
          { kind: 'thumbnail', mimeType: 'image/jpeg', content: Buffer.from('thumbnail') },
        ],
      },
    });
    try {
      const boundary = 'derivative-boundary';
      const payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\nimage\r\n--${boundary}--\r\n`,
      );
      const upload = await derivativeApp.inject({
        method: 'POST',
        url: '/v1/assets/uploads',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(upload.statusCode).toBe(201);
      const asset = upload.json().asset;
      expect(asset.metadata.derivatives.thumbnail).toMatchObject({
        mimeType: 'image/jpeg',
        contentUrl: `/v1/assets/${asset.id}/derivatives/thumbnail`,
      });
      const derivative = await derivativeApp.inject({
        method: 'GET',
        url: asset.metadata.derivatives.thumbnail.contentUrl,
      });
      expect(derivative.statusCode).toBe(200);
      expect(derivative.headers['content-type']).toContain('image/jpeg');
      expect(derivative.rawPayload).toEqual(Buffer.from('thumbnail'));
    } finally {
      await derivativeApp.close();
    }
  });

  it('rejects unsupported uploads', async () => {
    const boundary = 'unsupported-asset-boundary';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\narchive\r\n--${boundary}--\r\n`,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: 'unsupported media type' });
  });

  it('updates, archives, restores, and searches assets without deleting content', async () => {
    const boundary = 'lifecycle-boundary';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
    );
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    const asset = upload.json().asset;

    const update = await app.inject({
      method: 'PATCH',
      url: `/v1/assets/${asset.id}`,
      payload: { name: 'prompt.txt', tags: ['prompt', 'draft'] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().asset).toMatchObject({ name: 'prompt.txt', tags: ['prompt', 'draft'] });

    const search = await app.inject({ method: 'GET', url: '/v1/assets?query=draft' });
    expect(search.json().assets).toHaveLength(1);

    const archive = await app.inject({ method: 'POST', url: `/v1/assets/${asset.id}/archive` });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().asset.status).toBe('archived');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/assets?status=ready' }))
        .json()
        .assets.some((item: { id: string }) => item.id === asset.id),
    ).toBe(false);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/assets?status=archived' }))
        .json()
        .assets.some((item: { id: string }) => item.id === asset.id),
    ).toBe(true);

    const restore = await app.inject({ method: 'POST', url: `/v1/assets/${asset.id}/restore` });
    expect(restore.json().asset.status).toBe('ready');
    const content = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/content` });
    expect(content.rawPayload.toString()).toBe('hello');
  });

  it('supports an integrity-checked direct upload session', async () => {
    const content = Buffer.from('direct upload payload');
    const digest = createHash('sha256').update(content).digest('hex');
    const init = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads/init',
      payload: {
        name: 'direct.txt',
        mimeType: 'text/plain',
        sizeBytes: content.byteLength,
        sha256: digest,
        tags: ['direct'],
      },
    });
    expect(init.statusCode).toBe(201);
    const upload = init.json();

    const put = await app.inject({
      method: 'PUT',
      url: upload.uploadUrl,
      headers: { 'content-type': 'application/octet-stream' },
      payload: content,
    });
    expect(put.statusCode).toBe(204);

    const complete = await app.inject({
      method: 'POST',
      url: upload.completeUrl,
      payload: {
        uploadId: upload.uploadId,
        name: 'direct.txt',
        mimeType: 'text/plain',
        sizeBytes: content.byteLength,
        sha256: digest,
      },
    });
    expect(complete.statusCode).toBe(201);
    expect(complete.json().asset).toMatchObject({
      name: 'direct.txt',
      mediaType: 'text',
      sha256: digest,
      tags: ['direct'],
    });
  });

  it('rejects direct upload bytes whose digest differs from initialization', async () => {
    const content = Buffer.from('expected');
    const init = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads/init',
      payload: {
        name: 'mismatch.txt',
        mimeType: 'text/plain',
        sizeBytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    });
    const upload = init.json();
    const put = await app.inject({
      method: 'PUT',
      url: upload.uploadUrl,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('tampered'),
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).toContain('SHA-256');
  });

  it('issues short-lived signed content URLs and rejects tampering or expiry', async () => {
    const signedApp = buildApp({ logger: false });
    try {
      const boundary = 'signed-url-boundary';
      const upload = await signedApp.inject({
        method: 'POST',
        url: '/v1/assets/uploads',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="signed.txt"\r\nContent-Type: text/plain\r\n\r\nsigned payload\r\n--${boundary}--\r\n`,
        ),
      });
      const asset = upload.json().asset;
      const issued = await signedApp.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        payload: { expiresInSeconds: 30 },
      });
      expect(issued.statusCode).toBe(200);
      const signedUrl = issued.json().url as string;
      expect(signedUrl).toContain('access_token=');
      expect(
        (await signedApp.inject({ method: 'GET', url: signedUrl })).rawPayload.toString(),
      ).toBe('signed payload');

      const tampered = signedUrl.replace(/access_token=([^&])/, 'access_token=x$1');
      expect((await signedApp.inject({ method: 'GET', url: tampered })).statusCode).toBe(401);

      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 31_000));
      try {
        expect((await signedApp.inject({ method: 'GET', url: signedUrl })).statusCode).toBe(401);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await signedApp.close();
    }
  });

  it('does not allow a different authenticated user to mint or use an asset URL', async () => {
    vi.stubEnv('API_JWT_SECRET', 'asset-url-test-secret');
    vi.stubEnv('API_AUTH_TOKEN', '');
    const scopedApp = buildApp({ logger: false });
    try {
      const register = async (email: string) => {
        const response = await scopedApp.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: { email, password: 'strong-password-123' },
        });
        return response.json().accessToken as string;
      };
      const firstToken = await register('signed-first@example.com');
      const secondToken = await register('signed-second@example.com');
      const boundary = 'scoped-signed-url-boundary';
      const upload = await scopedApp.inject({
        method: 'POST',
        url: '/v1/assets/uploads',
        headers: {
          authorization: `Bearer ${firstToken}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.txt"\r\nContent-Type: text/plain\r\n\r\nprivate\r\n--${boundary}--\r\n`,
        ),
      });
      const asset = upload.json().asset;
      const forbiddenIssue = await scopedApp.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        headers: { authorization: `Bearer ${secondToken}` },
      });
      expect(forbiddenIssue.statusCode).toBe(404);

      const issued = await scopedApp.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        headers: { authorization: `Bearer ${firstToken}` },
      });
      expect(issued.statusCode).toBe(200);
      expect(
        (await scopedApp.inject({ method: 'GET', url: issued.json().url })).rawPayload.toString(),
      ).toBe('private');
    } finally {
      await scopedApp.close();
      vi.unstubAllEnvs();
    }
  });

  it('issues scoped URLs for archived versions and media derivatives', async () => {
    const versionedStore = new MemoryAssetStore();
    const asset = await versionedStore.create({
      name: 'versioned.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('current-image'),
      derivatives: {
        thumbnail: { mimeType: 'image/png', content: Buffer.from('thumbnail-image') },
      },
    });
    const version = await versionedStore.createVersion(asset.id, {
      content: Buffer.from('previous-image'),
      metadata: { source: 'test' },
    });
    expect(version?.version).toBe(2);

    const versionedApp = buildApp({ logger: false, assetStore: versionedStore });
    try {
      const issueVersion = await versionedApp.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        payload: { version: 2, expiresInSeconds: 60 },
      });
      expect(issueVersion.statusCode).toBe(200);
      const versionUrl = issueVersion.json().url as string;
      expect(
        (await versionedApp.inject({ method: 'GET', url: versionUrl })).rawPayload.toString(),
      ).toBe('previous-image');

      const issueDerivative = await versionedApp.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        payload: { derivative: 'thumbnail', expiresInSeconds: 60 },
      });
      expect(issueDerivative.statusCode).toBe(200);
      const derivativeUrl = issueDerivative.json().url as string;
      expect(
        (await versionedApp.inject({ method: 'GET', url: derivativeUrl })).rawPayload.toString(),
      ).toBe('thumbnail-image');
    } finally {
      await versionedApp.close();
    }
  });
});

describe('project and canvas endpoints', () => {
  it('lists project summaries in updated order', async () => {
    const projectStore = new MemoryProjectStore();
    const listApp = buildApp({ logger: false, projectStore });
    try {
      const first = await listApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'First project' },
      });
      const second = await listApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Second project' },
      });

      const response = await listApp.inject({ method: 'GET', url: '/v1/projects' });

      expect(response.statusCode).toBe(200);
      const projects = response.json().projects;
      expect(projects).toHaveLength(2);
      expect(projects.map((project: { id: string }) => project.id)).toEqual(
        expect.arrayContaining([first.json().project.id, second.json().project.id]),
      );
      expect(projects[0]).not.toHaveProperty('canvas');
      expect(projects).toEqual(
        [...projects].sort((left, right) => {
          const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
          return updatedOrder !== 0 ? updatedOrder : right.id.localeCompare(left.id);
        }),
      );
    } finally {
      await listApp.close();
    }
  });

  it('creates a project and saves its canvas with an incremented revision', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Storyboard' },
    });

    expect(create.statusCode).toBe(201);
    const project = create.json().project;
    expect(project).toMatchObject({ name: 'Storyboard' });

    const initial = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/canvas`,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().canvas).toEqual({ revision: 0, nodes: [], edges: [] });

    const save = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/canvas`,
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_prompt',
            type: 'text',
            position: { x: 40, y: 60 },
            data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
          },
        ],
        edges: [],
      },
    });

    expect(save.statusCode).toBe(200);
    expect(save.json().canvas.revision).toBe(1);
    expect(save.json().canvas.nodes).toHaveLength(1);
  });

  it('rejects a stale canvas revision without overwriting the current canvas', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Revision test' },
    });
    const projectId = create.json().project.id;
    const canvas = { revision: 0, nodes: [], edges: [] };

    const firstSave = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: canvas,
    });
    expect(firstSave.statusCode).toBe(200);

    const staleSave = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: canvas,
    });
    expect(staleSave.statusCode).toBe(409);
    expect(staleSave.json()).toMatchObject({ revision: 1 });

    const current = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/canvas`,
    });
    expect(current.json().canvas).toEqual({ revision: 1, nodes: [], edges: [] });
  });

  it('rejects an invalid canvas before it reaches the project store', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Validation test' },
    });
    const projectId = create.json().project.id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_audio',
            type: 'audio',
            position: { x: 0, y: 0 },
            data: { label: 'Audio', mediaType: 'audio', mode: 'source' },
          },
          {
            id: 'node_image',
            type: 'image',
            position: { x: 200, y: 0 },
            data: { label: 'Image', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [
          {
            id: 'edge_invalid',
            sourceNodeId: 'node_audio',
            sourceHandle: 'output:audio',
            targetNodeId: 'node_image',
            targetHandle: 'input:style',
            order: 0,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid canvas');
  });
});

describe('workflow import HTTP contract', () => {
  /** 构造只包含一个文本节点的最小工作流导出文档。 */
  function workflowImportPayload(
    options: {
      nodeId?: string;
      projectId?: string;
      projectName?: string;
      canvasRevision?: number;
      promptBlocks?: Array<Record<string, unknown>>;
      modelDefaults?: Record<string, unknown>;
    } = {},
  ) {
    return {
      schemaVersion: 1,
      exportedAt: '2026-09-04T00:00:00.000Z',
      project: {
        id: options.projectId ?? 'project_source_import',
        name: options.projectName ?? 'Source workflow',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
      canvas: {
        revision: options.canvasRevision ?? 27,
        nodes: [
          {
            id: options.nodeId ?? 'node_imported_text',
            type: 'text',
            position: { x: 32, y: 48 },
            data: {
              label: 'Imported text',
              mediaType: 'text',
              mode: 'generate',
              ...(options.promptBlocks
                ? { promptDocument: { version: 1, blocks: options.promptBlocks } }
                : {}),
            },
          },
        ],
        edges: [],
      },
      ...(options.modelDefaults ? { modelDefaults: options.modelDefaults } : {}),
      runs: [],
      results: [],
    };
  }

  it('imports a direct workflow body without overwriting the target project identity', async () => {
    const projectStore = new MemoryProjectStore();
    const importApp = buildApp({ logger: false, projectStore });
    try {
      const created = await importApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Target project' },
      });
      const target = created.json().project as {
        id: string;
        name: string;
        createdAt: string;
      };
      const workflow = workflowImportPayload({
        nodeId: 'node_direct_import',
        projectId: 'project_source_direct',
        projectName: 'Source direct project',
      });

      const response = await importApp.inject({
        method: 'POST',
        url: `/v1/projects/${target.id}/import/workflow`,
        payload: { ...workflow, expectedRevision: 0 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workflow: {
          project: { id: 'project_source_direct', name: 'Source direct project' },
        },
        canvas: { revision: 1, nodes: [{ id: 'node_direct_import' }] },
        issues: [],
      });
      const currentProject = await importApp.inject({
        method: 'GET',
        url: `/v1/projects/${target.id}`,
      });
      expect(currentProject.json().project).toMatchObject({
        id: target.id,
        name: target.name,
        createdAt: target.createdAt,
      });
      expect(currentProject.json().project.id).not.toBe(workflow.project.id);
    } finally {
      await importApp.close();
    }
  });

  it('imports a wrapped workflow with an expected target revision', async () => {
    const importApp = buildApp({ logger: false, projectStore: new MemoryProjectStore() });
    try {
      const created = await importApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Wrapped target' },
      });
      const projectId = created.json().project.id as string;
      const workflow = workflowImportPayload({
        nodeId: 'node_wrapped_import',
        canvasRevision: 91,
      });

      const response = await importApp.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/import/workflow`,
        payload: { workflow, expectedRevision: 0 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        canvas: { revision: 1, nodes: [{ id: 'node_wrapped_import' }] },
        issues: [],
      });
      const currentCanvas = await importApp.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/canvas`,
      });
      expect(currentCanvas.json().canvas).toMatchObject({
        revision: 1,
        nodes: [{ id: 'node_wrapped_import' }],
      });
    } finally {
      await importApp.close();
    }
  });

  it('returns 409 for a stale revision without partially writing model defaults', async () => {
    const projectStore = new MemoryProjectStore();
    const settingsStore = new AiSettingsStore('workflow-import-revision-atomicity');
    settingsStore.replaceModels([
      {
        id: 'revision-image-model',
        name: 'Revision image model',
        mediaTypes: ['image'],
        refreshedAt: appModelRefreshedAt,
      },
      {
        id: 'revision-text-model',
        name: 'Revision text model',
        mediaTypes: ['text'],
        refreshedAt: appModelRefreshedAt,
      },
    ]);
    const importApp = buildApp({ logger: false, projectStore, settingsStore });
    try {
      const created = await importApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Revision target' },
      });
      const projectId = created.json().project.id as string;
      const saved = await importApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_current_before_conflict',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Current', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });
      expect(saved.statusCode).toBe(200);
      const defaults = await importApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/models/defaults`,
        payload: { image: 'revision-image-model' },
      });
      expect(defaults.statusCode).toBe(200);

      const response = await importApp.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/import/workflow`,
        payload: {
          workflow: workflowImportPayload({
            nodeId: 'node_must_not_replace_current',
            modelDefaults: { text: 'revision-text-model' },
          }),
          expectedRevision: 0,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'revision_conflict', revision: 1 });
      const currentDefaults = await importApp.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/models/defaults`,
      });
      expect(currentDefaults.json()).toEqual({
        defaults: { image: 'revision-image-model' },
      });
      const currentCanvas = await importApp.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/canvas`,
      });
      expect(currentCanvas.json().canvas).toMatchObject({
        revision: 1,
        nodes: [{ id: 'node_current_before_conflict' }],
      });
    } finally {
      await importApp.close();
    }
  });

  it('persists one placeholder and issue for every missing mentioned resource', async () => {
    const assetStore = new MemoryAssetStore();
    const importApp = buildApp({
      logger: false,
      assetStore,
      projectStore: new MemoryProjectStore(),
    });
    try {
      const created = await importApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Missing resource target' },
      });
      const projectId = created.json().project.id as string;
      const workflow = workflowImportPayload({
        nodeId: 'node_missing_mentions',
        promptBlocks: [
          { type: 'text', text: '参考 ' },
          {
            type: 'mention',
            mentionId: 'mention_missing_image',
            assetId: 'asset_missing_image',
            label: '缺失图片',
            mediaType: 'image',
            assetVersion: 2,
            semanticRole: 'style',
          },
          { type: 'text', text: ' 和 ' },
          {
            type: 'mention',
            mentionId: 'mention_missing_audio',
            assetId: 'asset_missing_audio',
            label: '缺失音频',
            mediaType: 'audio',
            assetVersion: 1,
            binding: { entityName: '角色甲', semanticRole: 'characterVoice' },
          },
        ],
      });

      const response = await importApp.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/import/workflow`,
        payload: { ...workflow, expectedRevision: 0 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'RESOURCE_MENTION_IMPORT_NOT_FOUND',
            nodeId: 'node_missing_mentions',
            mentionId: 'mention_missing_image',
            assetId: 'asset_missing_image',
            reason: 'not_found',
          }),
          expect.objectContaining({
            code: 'RESOURCE_MENTION_IMPORT_NOT_FOUND',
            nodeId: 'node_missing_mentions',
            mentionId: 'mention_missing_audio',
            assetId: 'asset_missing_audio',
            reason: 'not_found',
          }),
        ]),
      );
      expect(response.json().issues).toHaveLength(2);
      const importedBlocks = response.json().canvas.nodes[0].data.promptDocument.blocks as Array<
        Record<string, unknown>
      >;
      expect(importedBlocks.filter((block) => block.type === 'mention')).toMatchObject([
        {
          mentionId: 'mention_missing_image',
          assetId: 'asset_missing_image',
          placeholder: true,
          placeholderReason: 'not_found',
          semanticRole: 'style',
        },
        {
          mentionId: 'mention_missing_audio',
          assetId: 'asset_missing_audio',
          placeholder: true,
          placeholderReason: 'not_found',
          binding: { entityName: '角色甲', semanticRole: 'characterVoice' },
        },
      ]);
      expect(JSON.stringify(response.json().issues)).not.toMatch(/contentUrl|signedUrl|apiKey/i);

      const currentCanvas = await importApp.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/canvas`,
      });
      expect(
        currentCanvas
          .json()
          .canvas.nodes[0].data.promptDocument.blocks.filter(
            (block: { type: string }) => block.type === 'mention',
          ),
      ).toEqual(importedBlocks.filter((block) => block.type === 'mention'));
    } finally {
      await importApp.close();
    }
  });

  it('imports valid model defaults and rejects invalid defaults without changing saved state', async () => {
    const settingsStore = new AiSettingsStore('workflow-import-model-defaults');
    settingsStore.replaceModels([
      {
        id: 'import-image-model',
        name: 'Import image model',
        mediaTypes: ['image'],
        refreshedAt: appModelRefreshedAt,
      },
      {
        id: 'import-text-model',
        name: 'Import text model',
        mediaTypes: ['text'],
        refreshedAt: appModelRefreshedAt,
      },
      {
        id: 'import-text-model-next',
        name: 'Next import text model',
        mediaTypes: ['text'],
        refreshedAt: appModelRefreshedAt,
      },
    ]);
    const importApp = buildApp({
      logger: false,
      settingsStore,
      projectStore: new MemoryProjectStore(),
    });
    try {
      const created = await importApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Model defaults target' },
      });
      const projectId = created.json().project.id as string;
      const valid = await importApp.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/import/workflow`,
        payload: {
          ...workflowImportPayload({
            nodeId: 'node_valid_defaults',
            modelDefaults: {
              image: 'import-image-model',
              text: 'import-text-model',
            },
          }),
          expectedRevision: 0,
        },
      });

      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toMatchObject({
        modelDefaults: {
          image: 'import-image-model',
          text: 'import-text-model',
        },
        canvas: { revision: 1, nodes: [{ id: 'node_valid_defaults' }] },
      });
      const invalid = await importApp.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/import/workflow`,
        payload: {
          ...workflowImportPayload({
            nodeId: 'node_invalid_defaults',
            modelDefaults: {
              text: 'import-text-model-next',
              image: 'model_not_in_catalog',
            },
          }),
          expectedRevision: 1,
        },
      });

      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({
        code: 'model_unavailable',
        requestId: expect.any(String),
      });
      const currentDefaults = await importApp.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/models/defaults`,
      });
      expect(currentDefaults.json()).toEqual({
        defaults: {
          image: 'import-image-model',
          text: 'import-text-model',
        },
      });
      const currentCanvas = await importApp.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/canvas`,
      });
      expect(currentCanvas.json().canvas).toMatchObject({
        revision: 1,
        nodes: [{ id: 'node_valid_defaults' }],
      });
    } finally {
      await importApp.close();
    }
  });
});

describe('run endpoints', () => {
  it('lists run history after checking project access', async () => {
    const historyApp = buildApp({ logger: false });
    try {
      const create = await historyApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Run history test' },
      });
      const projectId = create.json().project.id as string;
      await historyApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_history_text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Generate', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });
      const submit = await historyApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_history_text/runs',
        payload: { projectId },
      });
      const runId = submit.json().run.id as string;

      const response = await historyApp.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/runs`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().runs).toEqual([expect.objectContaining({ id: runId, projectId })]);

      const missing = await historyApp.inject({
        method: 'GET',
        url: '/v1/projects/project_missing/runs',
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'project not found' });
    } finally {
      await historyApp.close();
    }
  });

  it('does not block a priced run on local cost policy settings', async () => {
    vi.stubEnv('MAX_RUN_COST', '1.00');
    vi.stubEnv('RUN_COST_CURRENCY', 'USD');
    const settingsStore = new AiSettingsStore('cost-policy-test-secret');
    settingsStore.replaceModels([
      {
        id: 'priced-image',
        name: 'Priced image',
        mediaTypes: ['image'],
        price: { currency: 'USD', perRun: '1.01' },
        refreshedAt: new Date().toISOString(),
      },
    ]);
    const costApp = buildApp({ logger: false, settingsStore });
    try {
      const create = await costApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Cost policy test' },
      });
      const projectId = create.json().project.id;
      await costApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'priced_image',
              type: 'image',
              position: { x: 0, y: 0 },
              data: {
                label: 'Priced image',
                mediaType: 'image',
                mode: 'generate',
                modelAlias: 'priced-image',
              },
            },
          ],
          edges: [],
        },
      });

      const response = await costApp.inject({
        method: 'POST',
        url: '/v1/nodes/priced_image/runs',
        payload: { projectId },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().run).toMatchObject({
        targetNodeId: 'priced_image',
        modelAlias: 'priced-image',
        provider: 'mock',
      });
    } finally {
      await costApp.close();
      vi.unstubAllEnvs();
    }
  });

  it('uses a node model override when the request does not provide one', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Node model override' },
    });
    const projectId = create.json().project.id;
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_image_override',
            type: 'image',
            position: { x: 0, y: 0 },
            data: {
              label: 'Override image',
              mediaType: 'image',
              mode: 'generate',
              modelAlias: 'image-node-model',
            },
          },
        ],
        edges: [],
      },
    });
    const submit = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_image_override/runs',
      payload: { projectId },
    });
    expect(submit.statusCode).toBe(202);
    expect(submit.json().run.modelAlias).toBe('image-node-model');
  });

  it('rejects source nodes and runs a generated node from an immutable input snapshot', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Run test' },
    });
    const projectId = create.json().project.id;
    const canvas = {
      revision: 0,
      nodes: [
        {
          id: 'node_prompt',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
        },
        {
          id: 'node_image',
          type: 'image',
          position: { x: 240, y: 0 },
          data: { label: 'Generate image', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [
        {
          id: 'edge_prompt',
          sourceNodeId: 'node_prompt',
          sourceHandle: 'output:text',
          targetNodeId: 'node_image',
          targetHandle: 'input:prompt',
          order: 0,
        },
      ],
    };
    const save = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: canvas,
    });
    expect(save.statusCode).toBe(200);

    const sourceRun = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_prompt/runs',
      payload: { projectId },
    });
    expect(sourceRun.statusCode).toBe(400);

    const submit = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_image/runs',
      payload: { projectId, modelAlias: 'image-special', parameters: { width: 1024 } },
    });
    expect(submit.statusCode).toBe(202);
    const run = submit.json().run;
    expect(run.status).toBe('queued');
    expect(run.modelAlias).toBe('image-special');
    expect(run.snapshot.canvasRevision).toBe(1);
    expect(run.snapshot).toEqual({ canvasRevision: 1, inputCount: 1, inputs: [null] });
    const internalRun = await appRunService.get(run.id);
    expect(internalRun).toBeDefined();
    expect(internalRun!.snapshot.inputs).toMatchObject([
      { nodeId: 'node_prompt', role: 'prompt', sortOrder: 0 },
    ]);

    const update = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: {
        ...canvas,
        revision: 1,
        nodes: canvas.nodes.map((node) =>
          node.id === 'node_prompt'
            ? { ...node, data: { ...node.data, label: 'Changed after submit' } }
            : node,
        ),
      },
    });
    expect(update.statusCode).toBe(200);

    const completed = await waitForRun(run.id, 'succeeded');
    expect(completed.result).toMatchObject({
      provider: 'mock',
      targetNodeId: 'node_image',
      inputCount: 1,
    });
    const completedInternalRun = await appRunService.get(completed.id);
    expect(completedInternalRun).toBeDefined();
    expect(completedInternalRun!.snapshot.inputs[0].snapshot.data.label).toBe('Prompt');
  });

  it('cancels a queued run and retries it without changing its attempt snapshot', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Cancel test' },
    });
    const projectId = create.json().project.id;
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_video',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { label: 'Generate video', mediaType: 'video', mode: 'generate' },
          },
        ],
        edges: [],
      },
    });

    const submit = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_video/runs',
      payload: { projectId },
    });
    const run = submit.json().run;
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
    });
    expect(cancel.statusCode).toBe(202);

    const cancelled = await waitForRun(run.id, 'cancelled');
    expect(cancelled.progress).toBe(0);

    const retry = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/retry`,
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().run).toMatchObject({ attempt: 2, retryOf: run.id });

    const completed = await waitForRun(retry.json().run.id, 'succeeded');
    expect(completed.snapshot).toEqual(run.snapshot);
  });
});

describe('T15C credential and model resolution contracts', () => {
  const refreshedAt = new Date().toISOString();

  const configureCredential = (settingsStore: AiSettingsStore, baseUrl: string, apiKey: string) => {
    settingsStore.update({ baseUrl, apiKey });
    const credential = settingsStore.listCredentials().find((item) => item.baseUrl === baseUrl);
    if (!credential) throw new Error(`credential fixture was not created for ${baseUrl}`);
    return credential;
  };

  const imageModel = (id: string): ModelCatalogEntry => ({
    id,
    name: id,
    mediaTypes: ['image'],
    refreshedAt,
  });

  it('accepts a known credentialId and freezes its version in the run snapshot', async () => {
    const settingsStore = new AiSettingsStore('t15c-known-credential');
    const credential = configureCredential(
      settingsStore,
      'https://known-credential.example/v1',
      'synthetic-known-credential-key',
    );
    settingsStore.replaceModels([imageModel('credential-image')], credential.id);
    const credentialRunService = new MemoryRunService();
    const credentialApp = buildApp({
      logger: false,
      settingsStore,
      projectStore: new MemoryProjectStore(),
      runService: credentialRunService,
    });

    try {
      const create = await credentialApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Known credential run' },
      });
      const projectId = create.json().project.id as string;
      const save = await credentialApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_known_credential',
              type: 'image',
              position: { x: 0, y: 0 },
              data: { label: 'Image', mediaType: 'image', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });
      expect(save.statusCode).toBe(200);

      const response = await credentialApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_known_credential/runs',
        payload: { projectId, modelAlias: 'credential-image', credentialId: credential.id },
      });
      expect(response.statusCode).toBe(202);
      const publicRun = response.json().run;
      expect(publicRun.modelAlias).toBe('credential-image');
      expect(publicRun.snapshot).toEqual({ canvasRevision: 1, inputCount: 0, inputs: [] });
      const internalRun = await credentialRunService.get(publicRun.id);
      expect(internalRun).toBeDefined();
      const reference = internalRun!.snapshot.nodeCredentialReferences!.node_known_credential;
      expect(internalRun!.snapshot).toMatchObject({
        modelAlias: 'credential-image',
        credentialId: credential.id,
        credentialVersion: expect.any(Number),
        nodeCredentialReferences: {
          node_known_credential: {
            credentialId: credential.id,
            credentialVersion: expect.any(Number),
          },
        },
      });
      expect(internalRun!.snapshot.credentialVersion).toBe(reference.credentialVersion);
      expect(JSON.stringify(response.json())).not.toContain('synthetic-known-credential-key');
    } finally {
      await credentialApp.close();
    }
  });

  it('rejects a syntactically valid but unknown credentialId before resolving a run', async () => {
    const settingsStore = new AiSettingsStore('t15c-unknown-credential');
    const credentialApp = buildApp({ logger: false, settingsStore });
    const unknownCredentialId = '123e4567-e89b-12d3-a456-426614174099';

    try {
      const create = await credentialApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Unknown credential run' },
      });
      const response = await credentialApp.inject({
        method: 'POST',
        url: '/v1/nodes/missing-node/runs',
        payload: { projectId: create.json().project.id, credentialId: unknownCredentialId },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'credential not found' });
    } finally {
      await credentialApp.close();
    }
  });

  it('isolates projects across users while allowing a shared platform credential in another project', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', 't15c-auth-secret');
    const authStore = new MemoryAuthStore();
    const projectStore = new MemoryProjectStore();
    const settingsStore = new AiSettingsStore('t15c-cross-user-credential');
    const credential = configureCredential(
      settingsStore,
      'https://shared-credential.example/v1',
      'synthetic-shared-credential-key',
    );
    settingsStore.replaceModels([imageModel('shared-image')], credential.id);
    const authRunService = new MemoryRunService();
    const authApp = buildApp({
      logger: false,
      authStore,
      projectStore,
      settingsStore,
      runService: authRunService,
    });

    try {
      const aliceRegistration = await authApp.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'alice-t15c@example.test', password: 'alice-password' },
      });
      const bobRegistration = await authApp.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'bob-t15c@example.test', password: 'bob-password' },
      });
      expect(aliceRegistration.statusCode).toBe(201);
      expect(bobRegistration.statusCode).toBe(201);
      const aliceToken = aliceRegistration.json().accessToken as string;
      const bobToken = bobRegistration.json().accessToken as string;
      const aliceHeaders = { authorization: `Bearer ${aliceToken}` };
      const bobHeaders = { authorization: `Bearer ${bobToken}` };

      const aliceProject = await authApp.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: aliceHeaders,
        payload: { name: 'Alice project' },
      });
      const aliceProjectId = aliceProject.json().project.id as string;
      await authApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${aliceProjectId}/canvas`,
        headers: aliceHeaders,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_alice_image',
              type: 'image',
              position: { x: 0, y: 0 },
              data: { label: 'Alice image', mediaType: 'image', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });

      const forbiddenRun = await authApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_alice_image/runs',
        headers: bobHeaders,
        payload: {
          projectId: aliceProjectId,
          modelAlias: 'shared-image',
          credentialId: credential.id,
        },
      });
      expect(forbiddenRun.statusCode).toBe(404);
      expect(forbiddenRun.json()).toEqual({ error: 'project not found' });

      const bobProject = await authApp.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: bobHeaders,
        payload: { name: 'Bob project' },
      });
      const bobProjectId = bobProject.json().project.id as string;
      await authApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${bobProjectId}/canvas`,
        headers: bobHeaders,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_bob_image',
              type: 'image',
              position: { x: 0, y: 0 },
              data: { label: 'Bob image', mediaType: 'image', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });
      const sharedCredentialRun = await authApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_bob_image/runs',
        headers: bobHeaders,
        payload: {
          projectId: bobProjectId,
          modelAlias: 'shared-image',
          credentialId: credential.id,
        },
      });
      expect(sharedCredentialRun.statusCode).toBe(202);
      const publicRun = sharedCredentialRun.json().run;
      expect(publicRun).toMatchObject({
        projectId: bobProjectId,
        snapshot: { canvasRevision: 1, inputCount: 0, inputs: [] },
      });
      expect(publicRun.userId).toBeUndefined();
      const internalRun = await authRunService.get(publicRun.id);
      expect(internalRun).toBeDefined();
      expect(internalRun!).toMatchObject({
        projectId: bobProjectId,
        userId: bobRegistration.json().user.id,
        snapshot: {
          credentialId: credential.id,
          nodeCredentialReferences: {
            node_bob_image: { credentialId: credential.id, credentialVersion: expect.any(Number) },
          },
        },
      });
    } finally {
      await authApp.close();
      vi.unstubAllEnvs();
    }
  });

  it('resolves node, project, then platform model selections and credential references', async () => {
    const settingsStore = new AiSettingsStore('t15c-model-priority');
    const platformCredential = configureCredential(
      settingsStore,
      'https://platform-priority.example/v1',
      'synthetic-platform-priority-key',
    );
    const projectCredential = configureCredential(
      settingsStore,
      'https://project-priority.example/v1',
      'synthetic-project-priority-key',
    );
    const nodeCredential = configureCredential(
      settingsStore,
      'https://node-priority.example/v1',
      'synthetic-node-priority-key',
    );
    settingsStore.replaceModels([imageModel('platform-image')], platformCredential.id);
    settingsStore.replaceModels([imageModel('project-image')], projectCredential.id);
    settingsStore.replaceModels([imageModel('node-image')], nodeCredential.id);
    settingsStore.update({
      defaultModels: {
        image: { modelAlias: 'platform-image', credentialId: platformCredential.id },
      },
    });
    const priorityRunService = new MemoryRunService();
    const priorityApp = buildApp({ logger: false, settingsStore, runService: priorityRunService });

    const createRun = async (
      nodeId: string,
      projectName: string,
      nodeData: Record<string, string>,
      projectDefault?: { modelAlias: string; credentialId: string },
    ) => {
      const create = await priorityApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: projectName },
      });
      const projectId = create.json().project.id as string;
      const save = await priorityApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: nodeId,
              type: 'image',
              position: { x: 0, y: 0 },
              data: {
                label: nodeId,
                mediaType: 'image',
                mode: 'generate',
                ...nodeData,
              },
            },
          ],
          edges: [],
        },
      });
      expect(save.statusCode).toBe(200);
      if (projectDefault) {
        const defaults = await priorityApp.inject({
          method: 'PATCH',
          url: `/v1/projects/${projectId}/models/defaults`,
          payload: { image: projectDefault },
        });
        expect(defaults.statusCode).toBe(200);
      }
      const response = await priorityApp.inject({
        method: 'POST',
        url: `/v1/nodes/${nodeId}/runs`,
        payload: { projectId },
      });
      expect(response.statusCode).toBe(202);
      const publicRun = response.json().run;
      expect(publicRun.snapshot).toEqual({ canvasRevision: 1, inputCount: 0, inputs: [] });
      const internalRun = await priorityRunService.get(publicRun.id);
      expect(internalRun).toBeDefined();
      return { publicRun, internalRun: internalRun! };
    };

    try {
      const nodeRun = await createRun(
        'node_priority_override',
        'Node priority',
        { modelAlias: 'node-image', credentialId: nodeCredential.id },
        { modelAlias: 'project-image', credentialId: projectCredential.id },
      );
      expect(nodeRun.publicRun).toMatchObject({ modelAlias: 'node-image' });
      expect(nodeRun.internalRun).toMatchObject({
        modelAlias: 'node-image',
        snapshot: {
          credentialId: nodeCredential.id,
          nodeCredentialReferences: {
            node_priority_override: {
              credentialId: nodeCredential.id,
              credentialVersion: expect.any(Number),
            },
          },
        },
      });

      const projectRun = await createRun(
        'node_project_default',
        'Project priority',
        {},
        { modelAlias: 'project-image', credentialId: projectCredential.id },
      );
      expect(projectRun.publicRun).toMatchObject({ modelAlias: 'project-image' });
      expect(projectRun.internalRun).toMatchObject({
        modelAlias: 'project-image',
        snapshot: {
          credentialId: projectCredential.id,
          nodeCredentialReferences: {
            node_project_default: {
              credentialId: projectCredential.id,
              credentialVersion: expect.any(Number),
            },
          },
        },
      });

      const platformRun = await createRun('node_platform_default', 'Platform priority', {});
      expect(platformRun.publicRun).toMatchObject({ modelAlias: 'platform-image' });
      expect(platformRun.internalRun).toMatchObject({
        modelAlias: 'platform-image',
        snapshot: {
          credentialId: platformCredential.id,
          nodeCredentialReferences: {
            node_platform_default: {
              credentialId: platformCredential.id,
              credentialVersion: expect.any(Number),
            },
          },
        },
      });
    } finally {
      await priorityApp.close();
    }
  });

  it('keeps an explicit node credential when inheriting unbound defaults and rejects a conflicting bound default', async () => {
    const settingsStore = new AiSettingsStore('t17a-inherited-credential');
    const projectStore = new MemoryProjectStore();
    const platformCredential = configureCredential(
      settingsStore,
      'https://platform-inherited.example/v1',
      'synthetic-platform-inherited-key',
    );
    const nodeCredential = configureCredential(
      settingsStore,
      'https://node-inherited.example/v1',
      'synthetic-node-inherited-key',
    );
    settingsStore.replaceModels(
      [imageModel('platform-inherited'), imageModel('global-inherited')],
      platformCredential.id,
    );
    settingsStore.replaceModels(
      [imageModel('project-inherited'), imageModel('global-inherited')],
      nodeCredential.id,
    );
    settingsStore.update({ defaultModels: { image: 'global-inherited' } });
    const inheritedRunService = new MemoryRunService();
    const inheritedApp = buildApp({
      logger: false,
      projectStore,
      settingsStore,
      runService: inheritedRunService,
    });

    try {
      const create = await inheritedApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Inherited credential' },
      });
      const projectId = create.json().project.id as string;
      await inheritedApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_inherited_credential',
              type: 'image',
              position: { x: 0, y: 0 },
              data: {
                label: 'Inherited image',
                mediaType: 'image',
                mode: 'generate',
                credentialId: nodeCredential.id,
              },
            },
          ],
          edges: [],
        },
      });

      const projectDefault = await inheritedApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/models/defaults`,
        payload: { image: 'project-inherited' },
      });
      expect(projectDefault.statusCode).toBe(200);
      const projectRun = await inheritedApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_inherited_credential/runs',
        payload: { projectId },
      });
      expect(projectRun.statusCode).toBe(202);
      const projectPublicRun = projectRun.json().run;
      expect(projectPublicRun).toMatchObject({
        modelAlias: 'project-inherited',
        snapshot: { canvasRevision: 1, inputCount: 0, inputs: [] },
      });
      const projectInternalRun = await inheritedRunService.get(projectPublicRun.id);
      expect(projectInternalRun).toBeDefined();
      expect(projectInternalRun!.snapshot).toMatchObject({
        modelAlias: 'project-inherited',
        credentialId: nodeCredential.id,
      });

      await inheritedApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/models/defaults`,
        payload: { image: null },
      });
      const platformRun = await inheritedApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_inherited_credential/runs',
        payload: { projectId },
      });
      expect(platformRun.statusCode).toBe(202);
      const platformPublicRun = platformRun.json().run;
      expect(platformPublicRun).toMatchObject({
        modelAlias: 'global-inherited',
        snapshot: { canvasRevision: 1, inputCount: 0, inputs: [] },
      });
      const platformInternalRun = await inheritedRunService.get(platformPublicRun.id);
      expect(platformInternalRun).toBeDefined();
      expect(platformInternalRun!.snapshot).toMatchObject({
        modelAlias: 'global-inherited',
        credentialId: nodeCredential.id,
      });

      settingsStore.update({
        defaultModels: {
          image: { modelAlias: 'platform-inherited', credentialId: platformCredential.id },
        },
      });
      const conflictingRun = await inheritedApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_inherited_credential/runs',
        payload: { projectId },
      });
      expect(conflictingRun.statusCode).toBe(400);
      expect(conflictingRun.json()).toMatchObject({ code: 'model_unavailable' });
    } finally {
      await inheritedApp.close();
    }
  });

  it('keeps legacy string model defaults compatible while normalizing platform settings', async () => {
    const settingsStore = new AiSettingsStore('t15c-legacy-defaults');
    const legacyApp = buildApp({ logger: false, settingsStore });

    try {
      const update = await legacyApp.inject({
        method: 'PATCH',
        url: '/v1/settings/ai',
        payload: {
          baseUrl: 'https://legacy-defaults.example/v1',
          apiKey: 'synthetic-legacy-defaults-key',
        },
      });
      expect(update.statusCode).toBe(200);
      const credentialId = update.json().credentials[0].id as string;
      settingsStore.replaceModels(
        [imageModel('legacy-platform'), imageModel('legacy-project')],
        credentialId,
      );
      const defaults = await legacyApp.inject({
        method: 'PATCH',
        url: '/v1/settings/ai',
        payload: { defaultModels: { image: 'legacy-platform' } },
      });
      expect(defaults.statusCode).toBe(200);
      expect(update.json().settings.defaultModels).toEqual({});
      expect(defaults.json().settings.defaultModels).toEqual({
        image: { modelAlias: 'legacy-platform' },
      });

      const create = await legacyApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Legacy defaults' },
      });
      const projectId = create.json().project.id as string;
      await legacyApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_legacy_defaults',
              type: 'image',
              position: { x: 0, y: 0 },
              data: { label: 'Legacy image', mediaType: 'image', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });

      const projectDefault = await legacyApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/models/defaults`,
        payload: { image: 'legacy-project' },
      });
      expect(projectDefault.statusCode).toBe(200);
      expect(projectDefault.json()).toEqual({ defaults: { image: 'legacy-project' } });

      const projectRun = await legacyApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_legacy_defaults/runs',
        payload: { projectId },
      });
      expect(projectRun.statusCode).toBe(202);
      expect(projectRun.json().run.modelAlias).toBe('legacy-project');

      const removeProjectDefault = await legacyApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/models/defaults`,
        payload: { image: null },
      });
      expect(removeProjectDefault.statusCode).toBe(200);
      expect(removeProjectDefault.json()).toEqual({ defaults: {} });

      const platformRun = await legacyApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_legacy_defaults/runs',
        payload: { projectId },
      });
      expect(platformRun.statusCode).toBe(202);
      expect(platformRun.json().run.modelAlias).toBe('legacy-platform');
      const currentSettings = await legacyApp.inject({ method: 'GET', url: '/v1/settings/ai' });
      expect(currentSettings.json().settings.defaultModels).toEqual({
        image: { modelAlias: 'legacy-platform' },
      });
      expect(JSON.stringify(update.json())).not.toContain('synthetic-legacy-defaults-key');
    } finally {
      await legacyApp.close();
    }
  });
});

describe('project event stream', () => {
  it('returns not found for an unknown project', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/projects/project_missing/events',
    });
    expect(response.statusCode).toBe(404);
  });

  it('publishes a ready event and the current run snapshot', async () => {
    const streamApp = buildApp({ logger: false });
    const address = await streamApp.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    try {
      const create = await streamApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Event stream test' },
      });
      const projectId = create.json().project.id;
      await streamApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Generate text', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });
      const runResponse = await streamApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_text/runs',
        payload: { projectId },
      });
      expect(runResponse.statusCode).toBe(202);

      const response = await fetch(`${address}/v1/projects/${projectId}/events`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const firstChunk = await Promise.race([
        reader!.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SSE stream did not publish an initial event')), 1_000),
        ),
      ]);
      const text = new TextDecoder().decode(firstChunk.value);
      expect(text).toContain('event: ready');
      expect(text).toContain('event: run.updated');
      await reader!.cancel();
    } finally {
      controller.abort();
      await streamApp.close();
    }
  });
});

describe('webhook and run idempotency boundaries', () => {
  it('applies a New API callback to the matching run and provider job', async () => {
    let releaseExecutor!: () => void;
    let signalProviderReady!: () => void;
    const executorReleased = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    const providerReady = new Promise<void>((resolve) => {
      signalProviderReady = resolve;
    });
    const runService = new MemoryRunService({
      stepDelayMs: 0,
      providerName: 'newapi',
      executor: async (request) => {
        await request.onProviderJob?.({
          provider: 'newapi',
          platformJobId: 'platform-webhook-app',
          status: 'submitted',
          progress: 5,
        });
        signalProviderReady();
        await executorReleased;
        return {
          result: {
            provider: 'newapi',
            summary: 'webhook output',
            targetNodeId: 'node_webhook_app',
            mediaType: 'video',
            inputCount: 0,
          },
        };
      },
    });
    const webhookEventStore = new MemoryWebhookEventStore();
    const runPersistence = {
      upsertProviderJob: vi.fn(),
      updateRun: vi.fn(),
    };
    const webhookApp = buildApp({ logger: false, runService, webhookEventStore, runPersistence });

    try {
      const project = await webhookApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Webhook lifecycle' },
      });
      const projectId = project.json().project.id;
      await webhookApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_webhook_app',
              type: 'video',
              position: { x: 0, y: 0 },
              data: { label: 'Video', mediaType: 'video', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });
      const created = await webhookApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_webhook_app/runs',
        payload: { projectId },
      });
      expect(created.statusCode).toBe(202);
      await providerReady;

      const callback = await webhookApp.inject({
        method: 'POST',
        url: '/v1/webhooks/newapi',
        payload: {
          eventId: 'webhook-event-app-1',
          taskId: 'platform-webhook-app',
          status: 'running',
          progress: 95,
          authorization: 'must-not-appear-in-run',
        },
      });
      expect(callback.statusCode).toBe(202);
      expect(callback.json()).toMatchObject({
        accepted: true,
        deduplicated: false,
        processed: true,
        status: 'processed',
        attempt: 1,
        updatedRunId: created.json().run.id,
      });
      await expect(webhookEventStore.get('webhook-event-app-1')).resolves.toMatchObject({
        status: 'processed',
        attempt: 1,
      });
      expect(runPersistence.upsertProviderJob).toHaveBeenCalledWith(
        expect.objectContaining({
          providerJob: expect.objectContaining({
            platformJobId: 'platform-webhook-app',
            status: 'running',
          }),
        }),
      );
      expect(runPersistence.updateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: created.json().run.id,
          status: 'processing',
        }),
      );

      const current = await webhookApp.inject({
        method: 'GET',
        url: `/v1/runs/${created.json().run.id}`,
      });
      expect(current.json().run).toMatchObject({
        status: 'processing',
        progress: 95,
        snapshot: { canvasRevision: 1, inputCount: 0, inputs: [] },
      });
      expect(current.json().run.providerJob).toBeUndefined();
      const internalCurrent = await runService.get(created.json().run.id);
      expect(internalCurrent).toBeDefined();
      expect(internalCurrent!).toMatchObject({
        providerJob: {
          platformJobId: 'platform-webhook-app',
          status: 'running',
          progress: 95,
          payload: {
            eventId: 'webhook-event-app-1',
            taskId: 'platform-webhook-app',
            status: 'running',
            progress: 95,
          },
        },
      });
      expect(JSON.stringify(current.json())).not.toContain('must-not-appear-in-run');
    } finally {
      releaseExecutor();
      await webhookApp.close();
    }
  });

  it('deduplicates New API webhook event ids without applying the update twice', async () => {
    const runService = new MemoryRunService({ providerName: 'newapi' });
    const applyProviderWebhook = vi.spyOn(runService, 'applyProviderWebhook');
    const webhookApp = buildApp({ logger: false, runService });

    try {
      const payload = { eventId: 'event_1', taskId: 'task_1', status: 'running' };
      const first = await webhookApp.inject({
        method: 'POST',
        url: '/v1/webhooks/newapi',
        payload,
      });
      const second = await webhookApp.inject({
        method: 'POST',
        url: '/v1/webhooks/newapi',
        payload,
      });
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect(second.json()).toMatchObject({
        accepted: true,
        deduplicated: true,
        eventId: 'event_1',
      });
      expect(applyProviderWebhook).toHaveBeenCalledTimes(1);
    } finally {
      await webhookApp.close();
    }
  });

  it('keeps a callback without a platform job id retryable instead of processed', async () => {
    const webhookEventStore = new MemoryWebhookEventStore();
    const webhookApp = buildApp({ logger: false, webhookEventStore });

    try {
      const response = await webhookApp.inject({
        method: 'POST',
        url: '/v1/webhooks/newapi',
        payload: { eventId: 'event-missing-platform-job', status: 'running' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'webhook platform job id is required',
        code: 'invalid_webhook',
        eventId: 'event-missing-platform-job',
      });
      await expect(webhookEventStore.get('event-missing-platform-job')).resolves.toMatchObject({
        status: 'failed',
        attempt: 1,
        lastError: 'webhook platform job id is required',
      });
    } finally {
      await webhookApp.close();
    }
  });

  it('marks a failed callback retryable and processes it on the next delivery', async () => {
    const runService = new MemoryRunService({ providerName: 'newapi' });
    const applyProviderWebhook = vi
      .spyOn(runService, 'applyProviderWebhook')
      .mockRejectedValueOnce(new Error('synthetic webhook failure'));
    const webhookEventStore = new MemoryWebhookEventStore();
    const webhookApp = buildApp({ logger: false, runService, webhookEventStore });

    try {
      const payload = { eventId: 'event-retry', taskId: 'task-retry', status: 'running' };
      const failed = await webhookApp.inject({
        method: 'POST',
        url: '/v1/webhooks/newapi',
        payload,
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({
        error: 'internal server error',
        code: 'internal_error',
        requestId: expect.any(String),
      });
      expect(failed.body).not.toContain('synthetic webhook failure');
      await expect(webhookEventStore.get('event-retry')).resolves.toMatchObject({
        status: 'failed',
        lastError: 'synthetic webhook failure',
      });

      applyProviderWebhook.mockResolvedValue(undefined);
      const retried = await webhookApp.inject({
        method: 'POST',
        url: '/v1/webhooks/newapi',
        payload,
      });
      expect(retried.statusCode).toBe(202);
      expect(retried.json()).toMatchObject({
        accepted: true,
        deduplicated: false,
        processed: true,
        status: 'processed',
        attempt: 2,
        eventId: 'event-retry',
      });
      await expect(webhookEventStore.get('event-retry')).resolves.toMatchObject({
        status: 'processed',
        attempt: 2,
      });
      expect(applyProviderWebhook).toHaveBeenCalledTimes(2);
    } finally {
      await webhookApp.close();
    }
  });

  it('returns the same run for repeated idempotency keys', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Idempotent run' },
    });
    const projectId = create.json().project.id;
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_text_idempotent',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: 'Generate', mediaType: 'text', mode: 'generate' },
          },
        ],
        edges: [],
      },
    });
    const payload = { projectId, idempotencyKey: 'client-run-1' };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_text_idempotent/runs',
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_text_idempotent/runs',
      headers: { 'idempotency-key': 'client-run-1' },
      payload: { projectId },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().run.id).toBe(first.json().run.id);
  });
});

describe('API development CORS defaults', () => {
  it.each(['http://127.0.0.1:5173', 'http://localhost:5173'])(
    'allows the development origin %s',
    async (origin) => {
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('CORS_ORIGIN', '');
      const corsApp = buildApp({ logger: false });
      try {
        const response = await corsApp.inject({
          method: 'GET',
          url: '/health',
          headers: { origin },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBe(origin);

        const preflight = await corsApp.inject({
          method: 'OPTIONS',
          url: '/v1/projects/project-1/events',
          headers: {
            origin,
            'access-control-request-method': 'GET',
          },
        });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBe(origin);
      } finally {
        await corsApp.close();
        vi.unstubAllEnvs();
      }
    },
  );
});

async function waitForRun(runId: string, expectedStatus: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/v1/runs/${runId}` });
    const run = response.json().run;
    if (run.status === expectedStatus) return run;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`run ${runId} did not reach ${expectedStatus}`);
}
