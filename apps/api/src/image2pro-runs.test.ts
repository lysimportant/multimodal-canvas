import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDocument, RunRecord } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiVideoProvider } from '@multimodal-canvas/providers';
import { MemoryAssetStore } from './assets';
import { AuthService } from './auth-service';
import { MemoryAuthStore } from './auth-store';
import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { buildApp } from './fixtures/test-app';
import { createNewApiRunExecutor } from './newapi-run-executor';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';

const apps: ReturnType<typeof buildApp>[] = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WORKER_PROVIDER', 'newapi');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-image2pro-session-secret');
  vi.stubEnv('API_AUTH_TOKEN', '');
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

/** 等待内存运行结束，只调用隔离的 New API 响应替身。 */
async function completedRun(service: MemoryRunService, id: string): Promise<RunRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await service.get(id);
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Image2Pro 隔离运行未在期限内结束');
}

/** 构造登录用户、冻结素材及真实 Provider，网络仅接受测试任务路径。 */
async function fixture(modelAlias: string, references: boolean, invalidResolution = false) {
  const assetStore = new MemoryAssetStore();
  const projectStore = new MemoryProjectStore();
  const authStore = new MemoryAuthStore();
  const auth = new AuthService({
    store: authStore,
    jwtSecret: 'synthetic-image2pro-session-secret',
  });
  const session = await auth.issueToken(
    await authStore.createUser({ email: 'image2pro@example.test' }),
  );
  const ownerId = session.user.id;
  const project = await projectStore.create({ name: 'Image2Pro 隔离验证' }, { ownerId });
  const frozenImage = Buffer.from('frozen-image2pro-image-v1');
  const asset = await assetStore.create({
    ownerId,
    projectId: project.id,
    name: 'reference.png',
    mediaType: 'image',
    mimeType: 'image/png',
    content: frozenImage,
  });
  await assetStore.createVersion(asset.id, { content: Buffer.from('newer-image2pro-image-v2') });
  const settingsStore = new MemoryAiSettingsStore('image2pro-contract');
  settingsStore.update({
    baseUrl: 'https://newapi.example.test/v1',
    apiKey: 'synthetic-image2pro-key',
  });
  const credential = settingsStore.listCredentials()[0]!;
  settingsStore.replaceModels(
    [
      {
        id: modelAlias,
        name: modelAlias,
        mediaTypes: ['video'],
        capabilities: { mentionMediaTypes: ['text'] },
        refreshedAt: new Date().toISOString(),
      },
    ],
    credential.id,
  );
  const canvas: CanvasDocument = {
    revision: 0,
    nodes: [
      {
        id: 'video-target',
        type: 'video',
        position: { x: 0, y: 0 },
        data: {
          label: 'Image2Pro',
          mediaType: 'video',
          mode: 'generate',
          modelAlias,
          credentialId: credential.id,
          videoMode: references ? 'omni_reference' : 'text_to_video',
          prompt: 'Create a calm tracking shot.',
          ...(references
            ? {
                promptDocument: {
                  version: 1 as const,
                  blocks: [
                    {
                      type: 'text' as const,
                      text: 'Create a calm tracking shot using this reference.',
                    },
                    {
                      type: 'mention' as const,
                      mentionId: 'image-reference',
                      assetId: asset.id,
                      assetVersion: 1,
                      mediaType: 'image' as const,
                      label: '参考图',
                    },
                  ],
                },
              }
            : {}),
          parameters: {
            duration: 5,
            aspectRatio: '9:16',
            ...(invalidResolution ? { resolution: '720p' } : {}),
          },
        },
      },
    ],
    edges: [],
  };
  await projectStore.updateCanvas(project.id, canvas);
  const publicTaskId = 'task_image2pro_public';
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (url === 'https://newapi.example.test/v1/videos' && init?.method === 'POST') {
      return Response.json({
        id: publicTaskId,
        object: 'video',
        model: modelAlias,
        status: 'queued',
      });
    }
    if (url === `https://newapi.example.test/v1/videos/${publicTaskId}` && init?.method === 'GET') {
      return Response.json({
        id: publicTaskId,
        object: 'video',
        model: modelAlias,
        status: 'completed',
        url: 'https://cdn.example.test/image2pro.mp4',
      });
    }
    throw new Error(`非预期隔离请求 ${String(url)}`);
  });
  const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 1 });
  const app = buildApp({
    logger: false,
    assetStore,
    projectStore,
    settingsStore,
    runService,
    authStore,
    runExecutor: createNewApiRunExecutor({
      settingsStore,
      videoPollIntervalMs: 0,
      videoMaxPollAttempts: 1,
      providerFactory: {
        createStandard: (options) => new NewApiProvider({ ...options, fetchImpl }),
        createVideo: (options) => new NewApiVideoProvider({ ...options, fetchImpl }),
      },
    }),
  });
  apps.push(app);
  return { app, session, project, runService, fetchImpl, publicTaskId, frozenImage };
}

describe('Image2Pro HTTP 运行合同', () => {
  it.each(['无限制-Flash-中配-Video', '无限制-Flash-MAX-Video', 'Seedance2.0 0.9r'])(
    '%s 文生视频和图片提及均使用标准视频路径与公共任务 ID',
    async (modelAlias) => {
      for (const references of [false, true]) {
        const context = await fixture(modelAlias, references);
        const submitted = await context.app.inject({
          method: 'POST',
          url: '/v1/nodes/video-target/runs',
          payload: { projectId: context.project.id },
          headers: { authorization: `Bearer ${context.session.accessToken}` },
        });
        expect(submitted.statusCode, submitted.body).toBe(202);
        const run = await completedRun(context.runService, submitted.json().run.id);
        expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
        expect(context.fetchImpl).toHaveBeenCalledTimes(2);
        const body = JSON.parse(String(context.fetchImpl.mock.calls[0]![1]!.body));
        expect(body).toMatchObject({ model: modelAlias, duration: 5, ratio: '9:16' });
        expect(Object.keys(body).sort()).toEqual(
          (references
            ? ['model', 'prompt', 'duration', 'ratio', 'images']
            : ['model', 'prompt', 'duration', 'ratio']
          ).sort(),
        );
        if (references)
          expect(body.images).toEqual([
            `data:image/png;base64,${context.frozenImage.toString('base64')}`,
          ]);
        expect(run.providerJob).toMatchObject({
          platformJobId: context.publicTaskId,
          payload: { contract: 'newapi-video-v1' },
        });
        expect(JSON.stringify(run.snapshot)).not.toContain(context.frozenImage.toString('base64'));
      }
    },
  );

  it('旧分辨率必须先移除，不能在真实 POST 时静默忽略', async () => {
    const context = await fixture('无限制-Flash-MAX-Video', true, true);
    const submitted = await context.app.inject({
      method: 'POST',
      url: '/v1/nodes/video-target/runs',
      payload: { projectId: context.project.id },
      headers: { authorization: `Bearer ${context.session.accessToken}` },
    });
    expect(submitted.statusCode, submitted.body).toBe(400);
    expect(submitted.body).toContain('resolution');
    expect(context.fetchImpl).not.toHaveBeenCalled();
  });
});
