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
  it.each(['node', 'document'] as const)(
    'MAX 非空 %s 正文与 prompt 连线冲突时零 Run、零 Provider 请求',
    async (source) => {
      const context = await fixture('无限制-Flash-MAX-Video', false);
      if (source === 'document')
        context.canvas.nodes[0]!.data.promptDocument = {
          version: 1,
          blocks: [{ type: 'text', text: 'The explicit document prompt.' }],
        };
      context.canvas.nodes.push({
        id: 'text-prompt',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          label: '连线正文',
          mediaType: 'text',
          mode: 'source',
          prompt: 'The connected prompt.',
        },
      });
      context.canvas.edges.push({
        id: 'prompt-edge',
        sourceNodeId: 'text-prompt',
        sourceHandle: 'output:text',
        targetNodeId: 'video-target',
        targetHandle: 'input:prompt',
        order: 0,
      });
      await context.projectStore.updateCanvas(context.project.id, context.canvas);
      const submitted = await context.app.inject({
        method: 'POST',
        url: '/v1/nodes/video-target/runs',
        payload: { projectId: context.project.id },
        headers: { authorization: `Bearer ${context.session.accessToken}` },
      });
      expect(submitted.statusCode, submitted.body).toBe(400);
      expect(submitted.json()).toMatchObject({ code: 'INPUT_ROLE_CONFLICT' });
      expect(await context.runService.listByProject(context.project.id)).toEqual([]);
      expect(context.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'MAX 空白目标通过 prompt 连线读取选中 txt v1，而不是 v2：document=%s',
    async (document) => {
      const context = await fixture('无限制-Flash-MAX-Video', false);
      const prompt = 'Write --duration 15 on the sign.';
      const text = await context.assetStore.create({
        ownerId: context.session.user.id,
        projectId: context.project.id,
        name: 'prompt.txt',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from(prompt),
      });
      await context.assetStore.createVersion(text.id, { content: Buffer.from('x'.repeat(7001)) });
      const target = context.canvas.nodes[0]!.data;
      target.prompt = '';
      if (document) {
        target.promptDocument = { version: 1, blocks: [{ type: 'text', text: ' ' }] };
        target.parameters!.prompt = 'x'.repeat(7001);
      }
      context.canvas.nodes.push({
        id: 'frozen-text',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          label: '冻结文字',
          mediaType: 'text',
          mode: 'generate',
          prompt: 'An older generation instruction is not the result text.',
          assetId: text.id,
          mimeType: 'text/plain',
          contentUrl: `/v1/assets/${text.id}/versions/1/content`,
        },
      });
      // 真实连线复用从已完成 Run 取得明确版本，普通来源 URL 本身不是选版字段。
      vi.spyOn(context.runService, 'listByProject').mockResolvedValue([
        {
          projectId: context.project.id,
          targetNodeId: 'frozen-text',
          status: 'succeeded',
          createdAt: '2026-10-08T00:00:00Z',
          result: {
            targetNodeId: 'frozen-text',
            mediaType: 'text',
            asset: { assetId: text.id, version: 1, mimeType: 'text/plain' },
          },
        } as RunRecord,
      ]);
      context.canvas.edges.push({
        id: 'text-prompt',
        sourceNodeId: 'frozen-text',
        sourceHandle: 'output:text',
        targetNodeId: 'video-target',
        targetHandle: 'input:prompt',
        order: 0,
      });
      await context.projectStore.updateCanvas(context.project.id, context.canvas);
      const submitted = await context.app.inject({
        method: 'POST',
        url: '/v1/nodes/video-target/runs',
        payload: { projectId: context.project.id },
        headers: { authorization: `Bearer ${context.session.accessToken}` },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      const run = await completedRun(context.runService, submitted.json().run.id);
      expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
      expect(run.snapshot.inputs[0]).toMatchObject({
        sourceAssetId: text.id,
        sourceAssetVersion: 1,
      });
      expect(JSON.parse(String(context.fetchImpl.mock.calls[0]![1]!.body)).content).toEqual([
        { type: 'text', text: prompt },
      ]);
      expect(JSON.stringify(run.snapshot)).not.toContain(';base64,');
    },
  );
  it.each(['Seedance2.0 0.9r', '无限制-Flash-MAX-Video'])(
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

  it.each(
    ['Seedance2.0 0.9r', '无限制-Flash-MAX-Video'].flatMap((modelAlias) =>
      (['video', 'audio'] as const).map((mediaType) => ({ modelAlias, mediaType })),
    ),
  )(
    '$modelAlias 冻结 $mediaType 提及时长非法时，零 Run、零 POST',
    async ({ modelAlias, mediaType }) => {
      for (const durations of [[1.99], [15.01], [8, 8]]) {
        const context = await fixture(modelAlias, true);
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

  it.each([
    { parameters: { duration: 13 } },
    { parameters: { duration: 5.5 } },
    { parameters: { duration: 5, resolution: '1080p' } },
    { parameters: { duration: 5, generate_audio: false } },
    { parameters: { duration: 5, watermark: false } },
    { parameters: { duration: 5, return_last_frame: false } },
    { parameters: { duration: 5, ratio: 'adaptive' } },
    { parameters: { duration: 5 }, prompt: '' },
    { parameters: { duration: 5 }, prompt: 'x'.repeat(7001) },
  ])('MAX 非法参数或文本 %# 在创建 Run 前明确拒绝', async ({ parameters, prompt }) => {
    const context = await fixture('无限制-Flash-MAX-Video', false);
    context.canvas.nodes[0]!.data.parameters = parameters;
    if (prompt !== undefined) context.canvas.nodes[0]!.data.prompt = prompt;
    await context.projectStore.updateCanvas(context.project.id, context.canvas);
    const submitted = await context.app.inject({
      method: 'POST',
      url: '/v1/nodes/video-target/runs',
      payload: { projectId: context.project.id },
      headers: { authorization: `Bearer ${context.session.accessToken}` },
    });
    expect(submitted.statusCode, submitted.body).toBe(400);
    expect(await context.runService.listByProject(context.project.id)).toEqual([]);
    expect(context.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['audio', 'video'] as const)(
    'MAX 内存 API 水合纯 %s 参考的冻结版本，保持公开任务与历史元数据',
    async (mediaType) => {
      const context = await fixture('无限制-Flash-MAX-Video', false);
      const content = Buffer.from(`h3-frozen-${mediaType}-v1`);
      const mimeType = mediaType === 'video' ? 'video/mp4' : 'audio/mpeg';
      const asset = await context.assetStore.create({
        ownerId: context.session.user.id,
        projectId: context.project.id,
        name: 'frozen-reference',
        mediaType,
        mimeType,
        content,
        metadata: { durationSeconds: 2 },
      });
      await context.assetStore.createVersion(asset.id, {
        content: Buffer.from('newer-version-must-not-be-used'),
        metadata: { durationSeconds: 16 },
      });
      const target = context.canvas.nodes[0]!.data;
      target.videoMode = 'omni_reference';
      target.parameters = { duration: 4, resolution: '720p', ratio: 'adaptive' };
      target.promptDocument = {
        version: 1,
        blocks: [
          { type: 'text', text: 'Create a scene following the reference.' },
          {
            type: 'mention',
            mentionId: 'h3-reference',
            assetId: asset.id,
            assetVersion: 1,
            mediaType,
            label: '参考素材',
          },
        ],
      };
      await context.projectStore.updateCanvas(context.project.id, context.canvas);
      const submitted = await context.app.inject({
        method: 'POST',
        url: '/v1/nodes/video-target/runs',
        payload: { projectId: context.project.id },
        headers: { authorization: `Bearer ${context.session.accessToken}` },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      const run = await completedRun(context.runService, submitted.json().run.id);
      expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
      const body = JSON.parse(String(context.fetchImpl.mock.calls[0]![1]!.body));
      expect(body).toMatchObject({
        model: '无限制-Flash-MAX-Video',
        duration: 4,
        ratio: 'adaptive',
        resolution: '720p',
      });
      expect(body.content).toContainEqual({
        type: `${mediaType}_url`,
        [`${mediaType}_url`]: { url: `data:${mimeType};base64,${content.toString('base64')}` },
        role: `reference_${mediaType}`,
      });
      expect(run.snapshot.promptMentions).toContainEqual(
        expect.objectContaining({ assetId: asset.id, assetVersion: 1, durationSeconds: 2 }),
      );
      expect(JSON.stringify(run.snapshot)).not.toContain(';base64,');
      expect(context.fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    },
  );

  it.each(['无限制-Flash-中配-Video'])(
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
