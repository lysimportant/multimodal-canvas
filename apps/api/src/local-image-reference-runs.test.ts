import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { NewApiProvider, NewApiVideoProvider } from '@multimodal-canvas/providers';
import type { CanvasDocument, RunRecord } from '@multimodal-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './fixtures/test-app';
import { MemoryAssetStore } from './assets';
import { MemoryAuthStore } from './auth-store';
import { AuthService } from './auth-service';
import { createNewApiRunExecutor } from './newapi-run-executor';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';

/** 等待内存执行器终态，失败时保留 Provider 错误以便诊断。 */
async function waitForRun(service: MemoryRunService, id: string): Promise<RunRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await service.get(id);
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('本地图片执行未在测试期限内结束');
}

const apps: Array<ReturnType<typeof buildApp>> = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WORKER_PROVIDER', 'newapi');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-local-image-jwt-secret');
  vi.stubEnv('API_AUTH_TOKEN', '');
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

describe('本地图片执行与 Provider 适配器', () => {
  it('HTTP 多图提及按文档顺序发送 image[]，保留不同历史版本并去重同版本', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const authStore = new MemoryAuthStore();
    const auth = new AuthService({
      store: authStore,
      jwtSecret: 'synthetic-local-image-jwt-secret',
    });
    const session = await auth.issueToken(
      await authStore.createUser({ email: 'multiple-images@example.test' }),
    );
    const ownerId = session.user.id;
    const project = await projectStore.create({ name: '冻结多图引用' }, { ownerId });
    const firstVersion = Buffer.from('first-image-version-one');
    const secondVersion = Buffer.from('first-image-version-two');
    const otherImage = Buffer.from('second-image-version-one');
    const first = await assetStore.create({
      ownerId,
      name: 'first.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: firstVersion,
    });
    await assetStore.createVersion(first.id, { content: secondVersion });
    const second = await assetStore.create({
      ownerId,
      name: 'second.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: otherImage,
    });
    const settingsStore = new MemoryAiSettingsStore('local-multiple-images');
    settingsStore.update({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'synthetic-local-image-key',
    });
    const credential = settingsStore.listCredentials()[0]!;
    settingsStore.replaceModels(
      [
        {
          id: 'gpt-image-1',
          name: 'GPT Image',
          mediaTypes: ['image'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credential.id,
    );
    const references = [
      { assetId: first.id, assetVersion: 2 },
      { assetId: second.id, assetVersion: 1 },
      { assetId: first.id, assetVersion: 1 },
      { assetId: first.id, assetVersion: 2 },
    ];
    const canvas: CanvasDocument = {
      revision: 0,
      nodes: [
        {
          id: 'image-target',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: '多图组合',
            mediaType: 'image',
            mode: 'generate',
            modelAlias: 'gpt-image-1',
            credentialId: credential.id,
            promptDocument: {
              version: 1,
              blocks: [
                { type: 'text', text: 'Combine these reference images in order.' },
                ...references.map((reference, index) => ({
                  type: 'mention' as const,
                  mentionId: `reference-${index}`,
                  ...reference,
                  label: `参考图 ${index + 1}`,
                  mediaType: 'image' as const,
                })),
              ],
            },
          },
        },
      ],
      edges: [],
    };
    await projectStore.updateCanvas(project.id, canvas);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: [{ b64_json: Buffer.from('combined-output').toString('base64') }] }),
      );
    const executor = createNewApiRunExecutor({
      settingsStore,
      providerFactory: {
        createStandard: (options) => new NewApiProvider({ ...options, fetchImpl }),
        createVideo: (options) => new NewApiVideoProvider({ ...options, fetchImpl }),
      },
    });
    const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 5 });
    const app = buildApp({
      logger: false,
      assetStore,
      projectStore,
      settingsStore,
      runService,
      runExecutor: executor,
      authStore,
    });
    apps.push(app);
    const reader = vi.spyOn(assetStore, 'getVersionContent');
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/image-target/runs',
      payload: { projectId: project.id },
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    await assetStore.createVersion(first.id, { content: Buffer.from('later-first-version') });
    await assetStore.createVersion(second.id, { content: Buffer.from('later-second-version') });
    const run = await waitForRun(runService, submitted.json().run.id);
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://newapi.example.test/v1/images/edits');
    const form = init!.body as FormData;
    expect(form.getAll('image')).toEqual([]);
    expect(form.getAll('image[]')).toHaveLength(3);
    expect(
      await Promise.all(
        form.getAll('image[]').map(async (file) => Buffer.from(await (file as File).arrayBuffer())),
      ),
    ).toEqual([secondVersion, otherImage, firstVersion]);
    expect(form.get('model')).toBe('gpt-image-1');
    expect(form.get('n')).toBe('1');
    expect(reader.mock.calls.map(([assetId, version]) => ({ assetId, version }))).toEqual(
      references.map(({ assetId, assetVersion }) => ({ assetId, version: assetVersion })),
    );
    expect(
      run.snapshot.promptMentions?.map(({ assetId, assetVersion }) => ({ assetId, assetVersion })),
    ).toEqual(references);
    const durable = JSON.stringify({ run, canvas: await projectStore.getCanvas(project.id) });
    expect(durable).not.toContain('data:image/');
    for (const content of [firstVersion, secondVersion, otherImage]) {
      expect(durable).not.toContain(content.toString('base64'));
    }
  });

  it.each([
    { kind: 'mention', outcome: 'success' },
    { kind: 'mention-without-env', outcome: 'success' },
    { kind: 'imageEdit', outcome: 'success' },
    { kind: 'referenceImage', outcome: 'success' },
    { kind: 'mention', outcome: 'archived' },
    { kind: 'mention', outcome: 'deleted' },
    { kind: 'mention', outcome: 'version-missing' },
    { kind: 'mention', outcome: 'scope-revoked' },
    { kind: 'mention', outcome: 'cancelled' },
    { kind: 'mention', outcome: 'provider-rejected' },
  ])('HTTP → 图片 $kind → $outcome 保留冻结版本和授权边界', async ({ kind, outcome }) => {
    if (kind === 'mention-without-env') vi.stubEnv('WORKER_PROVIDER', '');
    const isMention = kind.startsWith('mention');
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const authStore = new MemoryAuthStore();
    const auth = new AuthService({
      store: authStore,
      jwtSecret: 'synthetic-local-image-jwt-secret',
    });
    const session = await auth.issueToken(
      await authStore.createUser({ email: 'local-image@example.test' }),
    );
    const ownerId = session.user.id;
    const project = await projectStore.create({ name: '本地图片编辑' }, { ownerId });
    const original = Buffer.from('original-png-version');
    const asset = await assetStore.create({
      ...(isMention ? { ownerId } : { projectId: project.id }),
      name: 'reference.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: original,
    });
    await assetStore.createVersion(asset.id, { content: Buffer.from('newer-version') });
    const settingsStore = new MemoryAiSettingsStore('local-image-reference');
    settingsStore.update({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'synthetic-local-image-key',
    });
    const credential = settingsStore.listCredentials()[0]!;
    settingsStore.replaceModels(
      [
        {
          id: 'gpt-image-test',
          name: 'GPT Image Test',
          mediaTypes: ['image'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credential.id,
    );
    const canvas: CanvasDocument = {
      revision: 0,
      nodes: [
        {
          id: 'image-target',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: '图片',
            mediaType: 'image',
            mode: 'generate',
            modelAlias: 'gpt-image-test',
            credentialId: credential.id,
            promptDocument: {
              version: 1,
              blocks: [
                { type: 'text', text: 'Make the background blue.' },
                {
                  type: 'mention',
                  mentionId: 'reference',
                  assetId: asset.id,
                  assetVersion: 1,
                  label: '原图',
                  mediaType: 'image',
                },
              ],
            },
          },
        },
      ],
      edges: [],
    };
    if (!isMention) {
      const target = canvas.nodes[0]!;
      target.data.promptDocument = {
        version: 1,
        blocks: [{ type: 'text', text: 'Make the background blue.' }],
      };
      if (kind === 'imageEdit')
        target.data.imageEditSource = {
          sourceNodeId: 'image-source',
          assetId: asset.id,
          version: 1,
        };
      canvas.nodes.push({
        id: 'image-source',
        type: 'image',
        position: { x: -300, y: 0 },
        data: {
          label: '原图',
          mediaType: 'image',
          mode: 'source',
          assetId: asset.id,
          contentUrl: `/v1/assets/${asset.id}/content`,
          mimeType: 'image/png',
        },
      });
      canvas.edges.push({
        id: 'image-edge',
        sourceNodeId: 'image-source',
        sourceHandle: 'output:image',
        targetNodeId: 'image-target',
        targetHandle: `input:${kind}`,
        order: 0,
      });
    }
    await projectStore.updateCanvas(project.id, canvas);
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            outcome === 'provider-rejected'
              ? { error: { message: 'Synthetic edits rejection' } }
              : { data: [{ b64_json: Buffer.from('generated-png').toString('base64') }] },
          ),
          {
            status: outcome === 'provider-rejected' ? 400 : 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const executor = createNewApiRunExecutor({
      settingsStore,
      providerFactory: {
        createStandard: (options) => new NewApiProvider({ ...options, fetchImpl }),
        createVideo: (options) => new NewApiVideoProvider({ ...options, fetchImpl }),
      },
    });
    const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 5 });
    const app = buildApp({
      logger: false,
      assetStore,
      projectStore,
      settingsStore,
      runService,
      runExecutor: executor,
      authStore,
    });
    apps.push(app);
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/image-target/runs',
      payload: { projectId: project.id },
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(submitted.statusCode).toBe(202);
    const runId = submitted.json().run.id;
    await assetStore.createVersion(asset.id, { content: Buffer.from('changed-after-submission') });
    const originalReader = assetStore.getVersionContent.bind(assetStore);
    const reader = vi.spyOn(assetStore, 'getVersionContent');
    if (outcome === 'archived') await assetStore.setArchived(asset.id, true);
    if (outcome === 'deleted') await assetStore.delete(asset.id);
    if (outcome === 'version-missing') reader.mockResolvedValueOnce(undefined);
    if (outcome === 'scope-revoked')
      vi.spyOn(assetStore, 'getOwnership').mockResolvedValue({
        ownerId: 'different-owner',
        projectId: null,
      });
    if (outcome === 'cancelled')
      reader.mockImplementationOnce(async (...args) => {
        await runService.cancel(runId);
        return originalReader(...args);
      });
    const run = await waitForRun(runService, submitted.json().run.id);
    expect(run.userId).toBe(ownerId);
    expect(JSON.stringify(run.snapshot)).not.toContain('data:image/');
    expect(JSON.stringify(await projectStore.getCanvas(project.id))).not.toContain('data:image/');
    if (outcome !== 'success' && outcome !== 'provider-rejected') {
      expect(run.status, JSON.stringify(run.error)).toBe(
        outcome === 'cancelled' ? 'cancelled' : 'failed',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      return;
    }
    if (outcome === 'provider-rejected') {
      expect(run.status).toBe('failed');
      expect(run.error).toContain('Synthetic edits rejection');
      expect(fetchImpl).toHaveBeenCalledOnce();
      return;
    }
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example.test/v1/images/edits');
    const form = fetchImpl.mock.calls[0]?.[1]?.body as FormData;
    expect(Buffer.from(await (form.get('image') as File).arrayBuffer())).toEqual(
      kind === 'referenceImage' ? Buffer.from('newer-version') : original,
    );
    expect(reader).toHaveBeenCalledWith(
      asset.id,
      kind === 'referenceImage' ? 2 : 1,
      isMention ? { projectId: null, ownerId } : { projectId: project.id },
    );
  });
});
