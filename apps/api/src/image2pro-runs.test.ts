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
async function fixture(modelAlias: string, references: boolean, invalidQuality = false) {
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
            resolution: '720p',
            aspectRatio: '9:16',
            ...(invalidQuality ? { quality: 'high' } : {}),
          },
        },
      },
    ],
    edges: [],
  };
  const savedCanvas = await projectStore.updateCanvas(project.id, canvas);
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
  return {
    app,
    session,
    project,
    runService,
    fetchImpl,
    publicTaskId,
    frozenImage,
    assetStore,
    projectStore,
    canvas: savedCanvas,
  };
}

describe('Image2Pro HTTP 运行合同', () => {
  it.each(['Seedance2.0 0.9r'])(
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
          ['model', 'content', 'duration', 'resolution', 'ratio'].sort(),
        );
        if (references)
          expect(body.content).toContainEqual({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${context.frozenImage.toString('base64')}` },
            role: 'reference_image',
          });
        expect(run.providerJob).toMatchObject({
          platformJobId: context.publicTaskId,
          payload: { contract: 'newapi-video-v1' },
        });
        expect(JSON.stringify(run.snapshot)).not.toContain(context.frozenImage.toString('base64'));
      }
    },
  );

  it('不支持的旧质量必须先移除，不能在真实 POST 时静默忽略', async () => {
    const context = await fixture('Seedance2.0 0.9r', true, true);
    const submitted = await context.app.inject({
      method: 'POST',
      url: '/v1/nodes/video-target/runs',
      payload: { projectId: context.project.id },
      headers: { authorization: `Bearer ${context.session.accessToken}` },
    });
    expect(submitted.statusCode, submitted.body).toBe(400);
    expect(submitted.body).toContain('quality');
    expect(context.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['video', 'audio'] as const)(
    '冻结 %s 提及时长单段或累计非法时，零 Run、零 POST',
    async (mediaType) => {
      for (const durations of [[1.99], [15.01], [8, 8]]) {
        const context = await fixture('Seedance2.0 0.9r', true);
        const blocks = context.canvas.nodes[0]!.data.promptDocument!.blocks;
        for (const [index, durationSeconds] of durations.entries()) {
          const asset = await context.assetStore.create({
            ownerId: context.session.user.id,
            projectId: context.project.id,
            name: `${mediaType}-${index}`,
            mediaType,
            mimeType: mediaType === 'video' ? 'video/mp4' : 'audio/mpeg',
            content: Buffer.from(`frozen-${mediaType}-${index}`),
            metadata: { durationSeconds },
          });
          // 最新版本合法不能覆盖用户明确选择的旧版本时长。
          await context.assetStore.createVersion(asset.id, {
            content: Buffer.from('newer-valid-media'),
            metadata: { durationSeconds: 2 },
          });
          blocks.push({
            type: 'mention',
            mentionId: `media-${index}`,
            assetId: asset.id,
            assetVersion: 1,
            mediaType,
            label: '参考素材',
          });
        }
        await context.projectStore.updateCanvas(context.project.id, context.canvas);
        const submitted = await context.app.inject({
          method: 'POST',
          url: '/v1/nodes/video-target/runs',
          payload: { projectId: context.project.id },
          headers: { authorization: `Bearer ${context.session.accessToken}` },
        });
        expect(submitted.statusCode, submitted.body).toBe(400);
        expect(submitted.json()).toMatchObject({ code: 'UNSUPPORTED_INPUT_COMBINATION' });
        expect(submitted.body).toContain(
          durations.length > 1 ? '累计时长不能超过 15 秒' : '单段时长必须为 2 至 15 秒',
        );
        expect(await context.runService.listByProject(context.project.id)).toEqual([]);
        expect(context.fetchImpl).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['无限制-Flash-中配-Video', '无限制-Flash-MAX-Video'])(
    '%s 在 API 保存 Run 前拒绝，不发送 Provider 请求',
    async (modelAlias) => {
      const context = await fixture(modelAlias, false);
      const submitted = await context.app.inject({
        method: 'POST',
        url: '/v1/nodes/video-target/runs',
        payload: { projectId: context.project.id },
        headers: { authorization: `Bearer ${context.session.accessToken}` },
      });
      expect(submitted.statusCode, submitted.body).toBe(400);
      expect(submitted.json()).toMatchObject({ code: 'model_unavailable' });
      expect(submitted.body).toContain(modelAlias);
      expect(await context.runService.listByProject(context.project.id)).toEqual([]);
      expect(context.fetchImpl).not.toHaveBeenCalled();
    },
  );
});
