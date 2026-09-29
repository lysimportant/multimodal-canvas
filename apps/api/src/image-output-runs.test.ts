import type { CanvasDocument, RunRecord } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiVideoProvider } from '@multimodal-canvas/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { buildApp } from './fixtures/test-app';
import { MemoryAssetStore } from './assets';
import { MemoryAuthStore } from './auth-store';
import { AuthService } from './auth-service';
import { createNewApiRunExecutor } from './newapi-run-executor';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';

/** 只使用内存服务和 stub 供应商的图片参数端到端测试应用。 */
const apps: Array<ReturnType<typeof buildApp>> = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WORKER_PROVIDER', 'newapi');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-image-size-jwt');
  vi.stubEnv('API_AUTH_TOKEN', '');
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

/** 构造已授权节点及可选参考图片；所有凭据和图片内容均为合成测试值。 */
async function setup(parameters: Record<string, unknown>, edit = false) {
  const projectStore = new MemoryProjectStore();
  const assetStore = new MemoryAssetStore();
  const authStore = new MemoryAuthStore();
  const auth = new AuthService({ store: authStore, jwtSecret: 'synthetic-image-size-jwt' });
  const session = await auth.issueToken(
    await authStore.createUser({ email: 'image-size@example.test' }),
  );
  const ownerId = session.user.id;
  const project = await projectStore.create({ name: 'Image parameter test' }, { ownerId });
  const settingsStore = new MemoryAiSettingsStore('image-output-tests');
  settingsStore.update({
    baseUrl: 'https://newapi.example.test/v1',
    apiKey: 'synthetic-image-size-key',
  });
  const credential = settingsStore.listCredentials()[0]!;
  settingsStore.replaceModels(
    ['gpt-image-2.5-sunburst', 'gpt-image-1'].map((id) => ({
      id,
      name: id,
      mediaTypes: ['image'],
      refreshedAt: '2026-09-29T00:00:00.000Z',
    })),
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
          label: 'Synthetic target',
          mediaType: 'image',
          mode: 'generate',
          modelAlias: 'gpt-image-2.5-sunburst',
          credentialId: credential.id,
          prompt: 'Create a portrait.',
          parameters,
        },
      },
    ],
    edges: [],
  };
  if (edit) {
    const asset = await assetStore.create({
      projectId: project.id,
      ownerId,
      name: 'reference.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('synthetic-reference-image'),
    });
    canvas.nodes.push({
      id: 'image-source',
      type: 'image',
      position: { x: -100, y: 0 },
      data: {
        label: 'Source',
        mode: 'source',
        mediaType: 'image',
        assetId: asset.id,
        mimeType: 'image/png',
      },
    });
    canvas.edges.push({
      id: 'reference-edge',
      sourceNodeId: 'image-source',
      sourceHandle: 'output:image',
      targetNodeId: 'image-target',
      targetHandle: 'input:referenceImage',
      order: 0,
    });
  }
  await projectStore.updateCanvas(project.id, canvas, { ownerId });
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      data: [{ b64_json: Buffer.from('synthetic-result-image').toString('base64') }],
    }),
  );
  const executor = createNewApiRunExecutor({
    settingsStore,
    providerFactory: {
      createStandard: (options) => new NewApiProvider({ ...options, fetchImpl }),
      createVideo: (options) => new NewApiVideoProvider({ ...options, fetchImpl }),
    },
  });
  const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 1 });
  const create = vi.spyOn(runService, 'create');
  const app = buildApp({
    logger: false,
    projectStore,
    assetStore,
    authStore,
    settingsStore,
    runService,
    runExecutor: executor,
  });
  apps.push(app);
  return {
    app,
    project,
    projectStore,
    ownerId,
    canvas,
    runService,
    create,
    fetchImpl,
    headers: { authorization: `Bearer ${session.accessToken}` },
  };
}

/** 只等待本地内存执行器，不会轮询任何外部供应商。 */
async function finished(service: MemoryRunService, id: string): Promise<RunRecord> {
  for (let i = 0; i < 200; i += 1) {
    const run = await service.get(id);
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic run did not finish');
}

describe('image output request preflight', () => {
  it.each([
    { quality: '4k', size: '1024x1024', aspectRatio: '9:16' },
    { resolution: '4k', aspectRatio: '1:1' },
    { resolution: '1k', aspectRatio: '9:16' },
    { resolution: '4k', aspectRatio: '0:16' },
    { quality: '8k' },
  ])('rejects bad sizes before run creation or provider submission: %j', async (parameters) => {
    const fixture = await setup(parameters);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v1/nodes/image-target/runs',
      headers: fixture.headers,
      payload: { projectId: fixture.project.id },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'IMAGE_OUTPUT_PARAMETERS_INVALID',
      nodeId: 'image-target',
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    expect(await fixture.runService.listByProject(fixture.project.id)).toEqual([]);
  });

  it('uses the request-resolved model instead of the node model for dimension limits', async () => {
    const fixture = await setup({ resolution: '4k', aspectRatio: '9:16' });
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v1/nodes/image-target/runs',
      headers: fixture.headers,
      payload: { projectId: fixture.project.id, modelAlias: 'gpt-image-1' },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe('IMAGE_OUTPUT_PARAMETERS_INVALID');
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });
});

describe.each([false, true])('image output HTTP to provider (edit=%s)', (edit) => {
  it.each([
    { quality: '4k', aspectRatio: '9:16' },
    { resolution: '4k', quality: 'xhigh', aspectRatio: '9:16' },
  ])('freezes saved parameters and sends their exact pixels once: %j', async (parameters) => {
    const fixture = await setup(parameters, edit);
    const before = await fixture.projectStore.getCanvas(fixture.project.id, {
      ownerId: fixture.ownerId,
    });
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v1/nodes/image-target/runs',
      headers: fixture.headers,
      payload: { projectId: fixture.project.id },
    });
    expect(response.statusCode, response.body).toBe(202);
    const run = await finished(fixture.runService, response.json().run.id);
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    expect(run.snapshot.parameters).toEqual(parameters);
    expect(fixture.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fixture.fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://newapi.example.test/v1/images/${edit ? 'edits' : 'generations'}`);
    const body = edit
      ? Object.fromEntries((init!.body as FormData).entries())
      : JSON.parse(init!.body as string);
    expect(body.size).toBe('2160x3840');
    expect(body.quality).toBe(parameters.quality === '4k' ? undefined : 'xhigh');
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(body).not.toHaveProperty('resolution');
    expect(
      await fixture.projectStore.getCanvas(fixture.project.id, { ownerId: fixture.ownerId }),
    ).toEqual(before);
  });
});
