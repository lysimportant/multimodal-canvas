import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDocument, RunRecord } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiVideoProvider } from '@multimodal-canvas/providers';
import { verifyProviderAssetAccessToken } from '@multimodal-canvas/credential-crypto';
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
  vi.stubEnv('API_JWT_SECRET', 'synthetic-yuan-session-secret');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('CANVAS_WEB_URL', '');
  vi.stubEnv('ASSET_ACCESS_URL_SECRET', '');
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
  throw new Error('Yuan 隔离运行未在期限内结束');
}

/** 构造登录用户、冻结素材及真实 Provider，网络仅接受测试任务路径。 */
async function fixture(modelAlias: string, references: boolean) {
  const assetStore = new MemoryAssetStore();
  const projectStore = new MemoryProjectStore();
  const authStore = new MemoryAuthStore();
  const auth = new AuthService({
    store: authStore,
    jwtSecret: 'synthetic-yuan-session-secret',
  });
  const session = await auth.issueToken(await authStore.createUser({ email: 'yuan@example.test' }));
  const ownerId = session.user.id;
  const project = await projectStore.create({ name: 'Yuan 隔离验证' }, { ownerId });
  const frozenImage = Buffer.from('frozen-yuan-image-v1');
  const asset = await assetStore.create({
    ownerId,
    projectId: project.id,
    name: 'reference.png',
    mediaType: 'image',
    mimeType: 'image/png',
    content: frozenImage,
  });
  await assetStore.createVersion(asset.id, { content: Buffer.from('newer-yuan-image-v2') });
  const settingsStore = new MemoryAiSettingsStore('yuan-contract');
  settingsStore.update({
    baseUrl: 'https://newapi.example.test/v1',
    apiKey: 'synthetic-yuan-key',
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
          label: 'Yuan',
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
          },
        },
      },
    ],
    edges: [],
  };
  const savedCanvas = await projectStore.updateCanvas(project.id, canvas);
  const publicTaskId = 'task_yuan_public';
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
        url: 'https://cdn.example.test/yuan.mp4',
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
    imageAsset: asset,
    assetStore,
    projectStore,
    canvas: savedCanvas,
  };
}

describe('Yuan HTTP 运行合同', () => {
  it('普通混合参考使用被冻结版本的本站签名 URL，公开任务查询与持久记录不含签名', async () => {
    const secret = 'synthetic-yuan-asset-signing-secret';
    vi.stubEnv('CANVAS_WEB_URL', 'https://canvas.example.com');
    vi.stubEnv('ASSET_ACCESS_URL_SECRET', secret);
    const context = await fixture('Yuan-Seedance-2.5-LJ-Full', true);
    const target = context.canvas.nodes[0]!.data;
    const blocks = target.promptDocument!.blocks;
    blocks.push(
      {
        type: 'mention',
        mentionId: 'same-image-v1',
        assetId: context.imageAsset.id,
        assetVersion: 1,
        mediaType: 'image',
        label: '重复参考图',
      },
      {
        type: 'mention',
        mentionId: 'selected-image-v2',
        assetId: context.imageAsset.id,
        assetVersion: 2,
        mediaType: 'image',
        label: '另一版本',
      },
    );
    const expectedReferences: Array<{
      assetId: string;
      version: number;
      mediaType: 'image' | 'video' | 'audio';
      content: Buffer;
    }> = [
      {
        assetId: context.imageAsset.id,
        version: 1,
        mediaType: 'image',
        content: context.frozenImage,
      },
      {
        assetId: context.imageAsset.id,
        version: 2,
        mediaType: 'image',
        content: Buffer.from('newer-yuan-image-v2'),
      },
    ];
    for (const mediaType of ['video', 'audio'] as const) {
      const content = Buffer.from(`yuan-frozen-${mediaType}-v1`);
      const asset = await context.assetStore.create({
        ownerId: context.session.user.id,
        projectId: context.project.id,
        name: `reference-${mediaType}`,
        mediaType,
        mimeType: mediaType === 'video' ? 'video/mp4' : 'audio/mpeg',
        content,
      });
      await context.assetStore.createVersion(asset.id, {
        content: Buffer.from('unselected-newer-version'),
      });
      blocks.push({
        type: 'mention',
        mentionId: `selected-${mediaType}`,
        assetId: asset.id,
        assetVersion: 1,
        mediaType,
        label: '参考素材',
      });
      expectedReferences.push({ assetId: asset.id, version: 1, mediaType, content });
    }
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
    expect(context.fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://newapi.example.test/v1/videos',
      `https://newapi.example.test/v1/videos/${context.publicTaskId}`,
    ]);
    const body = JSON.parse(String(context.fetchImpl.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({
      model: 'Yuan-Seedance-2.5-LJ-Full',
      duration: 5,
      resolution: '720p',
      aspect_ratio: '9:16',
      metadata: { omni_reference_task_type: 'reference' },
    });
    expect(body.metadata.content[0]).toEqual({ type: 'text', text: body.prompt });
    const media = body.metadata.content.slice(1);
    expect(media).toHaveLength(expectedReferences.length);
    for (const [index, expected] of expectedReferences.entries()) {
      const reference = media[index];
      const url = new URL(reference[`${expected.mediaType}_url`].url);
      expect(reference).toMatchObject({
        type: `${expected.mediaType}_url`,
        role: `reference_${expected.mediaType}`,
      });
      expect(url.origin).toBe('https://canvas.example.com');
      expect(
        verifyProviderAssetAccessToken(url.searchParams.get('access_token')!, secret),
      ).toMatchObject({
        assetId: expected.assetId,
        version: expected.version,
        projectId: context.project.id,
        ownerId: context.session.user.id,
      });
      const content = await context.app.inject({
        method: 'GET',
        url: `${url.pathname}${url.search}`,
      });
      expect(content.statusCode, content.body).toBe(200);
      expect(content.rawPayload).toEqual(expected.content);
    }
    expect(run.providerJob).toMatchObject({
      platformJobId: context.publicTaskId,
      payload: { contract: 'newapi-video-v1' },
    });
    const summaries = await context.runService.listRequestPromptRecords(run.id);
    const records = await Promise.all(
      summaries.map((summary) => context.runService.getRequestPromptRecord(run.id, summary.id)),
    );
    expect(records).not.toHaveLength(0);
    const persistedCanvas = await context.projectStore.getCanvas(context.project.id);
    expect(persistedCanvas).toBeDefined();
    const persisted = JSON.stringify({
      snapshot: run.snapshot,
      canvas: persistedCanvas,
      records,
    });
    expect(persisted).not.toContain('access_token');
    expect(persisted).not.toContain('https://canvas.example.com/v1/provider-assets/');
    expect(persisted).not.toContain(';base64,');
    for (const expected of expectedReferences)
      expect(persisted).not.toContain(expected.content.toString('base64'));
  });

  it.each(['', 'http://localhost:5173', 'https://127.0.0.1'])(
    '网站来源 %s 不能签发公网素材 URL 时明确失败且零外发',
    async (webUrl) => {
      vi.stubEnv('CANVAS_WEB_URL', webUrl);
      const context = await fixture('Yuan-Seedance-2.5-LJ-Full', true);
      const submitted = await context.app.inject({
        method: 'POST',
        url: '/v1/nodes/video-target/runs',
        payload: { projectId: context.project.id },
        headers: { authorization: `Bearer ${context.session.accessToken}` },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      const run = await completedRun(context.runService, submitted.json().run.id);
      expect(run.status).toBe('failed');
      expect(JSON.stringify(run.error)).toContain('参考素材需要公网 HTTPS 访问');
      expect(context.fetchImpl).not.toHaveBeenCalled();
      expect(JSON.stringify(run.snapshot)).not.toContain(';base64,');
    },
  );
});
