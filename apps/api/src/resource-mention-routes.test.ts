/** 保留真实 HTTP 预检与资源冻结，仅以内存执行器替代 Provider，禁止外网生成。 */
import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasDocument, MediaType, RunRecord } from '@multimodal-canvas/domain';

import { buildApp } from './fixtures/test-app';
import { MemoryAssetStore } from './assets';
import { MemoryProjectStore } from './projects';
import { MemoryRunService, type RunExecutorRequest } from './runs';

/** HTTP 仅公开冻结提及投影；完整节点从内存运行记录或执行器入参读取。 */
type SubmittedRun = Pick<RunRecord, 'id' | 'targetNodeId' | 'modelAlias'> & {
  snapshot: Pick<RunRecord['snapshot'], 'promptMentions'>;
};

/** 每个用例结束后关闭其内存应用，避免运行状态串扰。 */
const apps: Array<ReturnType<typeof buildApp>> = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WORKER_PROVIDER', 'mock');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('资源提及 HTTP 回归禁止外部网络请求');
    }),
  );
});

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

/**
 * 创建不经过 HTTP 校验的测试画布，用于覆盖运行边界的防御性检查。
 * @param projectStore 当前用例的内存项目存储。
 * @param projectId 画布所属项目 ID。
 * @param canvas 待保存的节点、连线和当前修订号。
 * @returns 已保存且修订号递增的画布；存储校验错误直接向上传递。
 */
async function storeCanvas(
  projectStore: MemoryProjectStore,
  projectId: string,
  canvas: CanvasDocument,
): Promise<CanvasDocument> {
  return projectStore.updateCanvas(projectId, canvas);
}

/**
 * 每隔 5 毫秒查询一次内存运行，最多查询 100 次，不重发生成请求。
 * @param runService 当前用例的内存运行服务。
 * @param runId 已由 HTTP 提交返回的运行 ID。
 * @param expectedStatus 需要等待的运行状态。
 * @returns 达到指定状态的完整运行记录。
 * @throws 超过轮询次数时抛出含运行 ID 和最后状态的错误。
 */
async function waitForRun(
  runService: MemoryRunService,
  runId: string,
  expectedStatus: RunRecord['status'],
): Promise<RunRecord> {
  let last: RunRecord | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await runService.get(runId);
    if (last?.status === expectedStatus) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `运行 ${runId} 未到达 ${expectedStatus}，最后状态为 ${last?.status ?? 'missing'}`,
  );
}

describe('资源提及 HTTP 边界', () => {
  it('在保存和运行时聚合全部冻结错误，并且不会调用 Provider', async () => {
    vi.stubEnv('RESOURCE_MENTION_MAX_BYTES', '3');
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: '冻结诊断' });
    const archived = await assetStore.create({
      projectId: project.id,
      name: 'archived.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('a'),
    });
    await assetStore.setArchived(archived.id, true, { projectId: project.id });
    const wrongMime = await assetStore.create({
      projectId: project.id,
      name: 'image.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('a'),
    });
    const missingVersion = await assetStore.create({
      projectId: project.id,
      name: 'version.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('a'),
    });
    const oversized = await assetStore.create({
      projectId: project.id,
      name: 'large.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('1234'),
    });
    const forbidden = await assetStore.create({
      projectId: 'another-project',
      name: 'private.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('a'),
    });
    const mention = (
      mentionId: string,
      assetId: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      type: 'mention' as const,
      mentionId,
      assetId,
      label: mentionId,
      mediaType: 'text' as const,
      ...overrides,
    });
    const canvas = await storeCanvas(projectStore, project.id, {
      revision: 0,
      nodes: [
        {
          id: 'node-errors',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: '错误聚合',
            mediaType: 'text',
            mode: 'generate',
            promptDocument: {
              version: 1,
              blocks: [
                mention('missing', 'asset-missing'),
                mention('forbidden', forbidden.id),
                mention('archived', archived.id),
                mention('version', missingVersion.id, { assetVersion: 99 }),
                mention('mime', wrongMime.id),
                mention('size', oversized.id),
                mention('placeholder', 'asset-imported', {
                  placeholder: true,
                  placeholderReason: 'not_found',
                }),
              ],
            },
          },
        },
      ],
      edges: [],
    });
    const executor = vi.fn(async ({ snapshot }: RunExecutorRequest) => ({
      provider: 'mock',
      summary: '不应执行',
      targetNodeId: snapshot.targetNodeId,
      mediaType: 'text' as const,
      inputCount: 0,
    }));
    const runService = new MemoryRunService({ stepDelayMs: 0 });
    const app = buildApp({
      logger: false,
      assetStore,
      projectStore,
      runService,
      runExecutor: executor,
    });
    apps.push(app);

    const save = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/canvas`,
      payload: canvas,
    });
    expect(save.statusCode).toBe(400);
    expect(save.json()).toMatchObject({
      code: 'RESOURCE_MENTION_FREEZE_FAILED',
    });
    expect(
      save.json().issues.map((issue: { code: string; mentionId: string }) => ({
        code: issue.code,
        mentionId: issue.mentionId,
      })),
    ).toEqual([
      { code: 'RESOURCE_MENTION_NOT_FOUND', mentionId: 'missing' },
      { code: 'RESOURCE_MENTION_FORBIDDEN', mentionId: 'forbidden' },
      { code: 'RESOURCE_MENTION_ARCHIVED', mentionId: 'archived' },
      { code: 'RESOURCE_MENTION_VERSION_MISSING', mentionId: 'version' },
      { code: 'RESOURCE_MENTION_MIME_MISMATCH', mentionId: 'mime' },
      { code: 'RESOURCE_MENTION_SIZE_EXCEEDED', mentionId: 'size' },
      { code: 'RESOURCE_MENTION_PLACEHOLDER', mentionId: 'placeholder' },
    ]);
    expect(save.json().issues).toHaveLength(7);
    expect(
      save.json().issues.every((issue: { requestId?: string }) => Boolean(issue.requestId)),
    ).toBe(true);

    const run = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node-errors/runs',
      payload: { projectId: project.id },
    });
    expect(run.statusCode).toBe(400);
    expect(run.json().issues).toHaveLength(7);
    expect(executor).not.toHaveBeenCalled();
    expect(await runService.listByProject(project.id)).toEqual([]);
    expect((await projectStore.getCanvas(project.id))?.revision).toBe(1);
  });

  it('冻结四类节点的版本和重复提及，并在 Mock 结果中明确标记模拟', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const runService = new MemoryRunService({ stepDelayMs: 0 });
    const project = await projectStore.create({ name: 'Mock 提及闭环' });
    const mediaFixtures: Record<MediaType, { mimeType: string; content: Buffer }> = {
      text: { mimeType: 'text/plain', content: Buffer.from('text-v1') },
      image: { mimeType: 'image/png', content: Buffer.from('image-v1') },
      audio: { mimeType: 'audio/wav', content: Buffer.from('audio-v1') },
      video: { mimeType: 'video/mp4', content: Buffer.from('video-v1') },
    };
    const assets = Object.fromEntries(
      await Promise.all(
        (Object.keys(mediaFixtures) as MediaType[]).map(async (mediaType) => {
          const fixture = mediaFixtures[mediaType];
          const asset = await assetStore.create({
            projectId: project.id,
            name: `${mediaType}-reference`,
            mediaType,
            mimeType: fixture.mimeType,
            content: fixture.content,
            metadata: {
              durationSeconds: mediaType === 'video' || mediaType === 'audio' ? 4.5 : 99,
            },
          });
          return [mediaType, asset] as const;
        }),
      ),
    ) as Record<MediaType, Awaited<ReturnType<MemoryAssetStore['create']>>>;
    const nodes = (Object.keys(mediaFixtures) as MediaType[]).map((mediaType, index) => ({
      id: `node-${mediaType}`,
      type: mediaType,
      position: { x: index * 200, y: 0 },
      data: {
        label: `${mediaType} node`,
        mediaType,
        mode: 'generate' as const,
        prompt: `legacy-${mediaType}`,
        promptDocument: {
          version: 1 as const,
          blocks: [
            { type: 'text' as const, text: `document-${mediaType} ` },
            {
              type: 'mention' as const,
              mentionId: `mention-${mediaType}-1`,
              assetId: assets[mediaType].id,
              assetVersion: 1,
              label: assets[mediaType].name,
              mediaType,
              semanticRole: 'reference',
              entityName: mediaType,
              scope: 'node' as const,
            },
            ...(mediaType === 'text'
              ? [
                  { type: 'text' as const, text: ' + ' },
                  {
                    type: 'mention' as const,
                    mentionId: 'mention-text-2',
                    assetId: assets.text.id,
                    assetVersion: 1,
                    label: assets.text.name,
                    mediaType: 'text' as const,
                  },
                ]
              : []),
          ],
        },
      },
    }));
    const app = buildApp({ logger: false, assetStore, projectStore, runService });
    apps.push(app);

    const save = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/canvas`,
      payload: { revision: 0, nodes, edges: [] },
    });
    expect(save.statusCode).toBe(200);
    await Promise.all(
      (Object.keys(mediaFixtures) as MediaType[]).map((mediaType) =>
        assetStore.createVersion(
          assets[mediaType].id,
          {
            content: Buffer.from(`${mediaType}-v2`),
            metadata: {
              durationSeconds: mediaType === 'video' || mediaType === 'audio' ? 9.25 : 199,
            },
          },
          { projectId: project.id },
        ),
      ),
    );

    for (const mediaType of Object.keys(mediaFixtures) as MediaType[]) {
      const submitted = await app.inject({
        method: 'POST',
        url: `/v1/nodes/node-${mediaType}/runs`,
        payload: { projectId: project.id },
      });
      expect(submitted.statusCode).toBe(202);
      const submittedRun = submitted.json().run;
      const expectedCount = mediaType === 'text' ? 2 : 1;
      expect(submittedRun.snapshot.promptMentions).toHaveLength(expectedCount);
      expect(
        submittedRun.snapshot.promptMentions.every(
          (mention: { assetVersion: number }) => mention.assetVersion === 1,
        ),
      ).toBe(true);
      const frozenMention = submittedRun.snapshot.promptMentions[0];
      if (mediaType === 'video' || mediaType === 'audio')
        expect(frozenMention.durationSeconds).toBe(4.5);
      else expect(frozenMention).not.toHaveProperty('durationSeconds');

      const completed = await waitForRun(runService, submittedRun.id, 'succeeded');
      expect(completed.snapshot.promptMentions).toHaveLength(expectedCount);
      expect(completed.result).toMatchObject({
        provider: 'mock',
        simulated: true,
        promptMentions: submittedRun.snapshot.promptMentions,
      });
      const response = await app.inject({ method: 'GET', url: `/v1/runs/${submittedRun.id}` });
      expect(response.json().run.result).toMatchObject({
        simulated: true,
        promptMentions: submittedRun.snapshot.promptMentions,
      });

      if (mediaType === 'text') {
        const resultAsset = completed.result?.asset;
        expect(resultAsset?.version).toBeDefined();
        const content = await assetStore.getVersionContent(
          resultAsset!.assetId,
          resultAsset!.version!,
          { projectId: project.id },
        );
        expect(content?.toString('utf8')).toContain('document-text text + text-reference');
        expect(content?.toString('utf8')).not.toContain('legacy-text');
      }
    }
  });

  it('将来源节点说明中的 @ 视为元数据，不触发资源冻结', async () => {
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: '来源元数据' });
    const canvas: CanvasDocument = {
      revision: 0,
      nodes: [
        {
          id: 'node-source-meta',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: '来源说明',
            mediaType: 'text',
            mode: 'source',
            promptDocument: {
              version: 1,
              blocks: [
                {
                  type: 'mention',
                  mentionId: 'metadata-only',
                  assetId: 'missing-asset',
                  label: '外部说明',
                  mediaType: 'image',
                },
              ],
            },
          },
        },
        {
          id: 'node-source-target',
          type: 'text',
          position: { x: 240, y: 0 },
          data: { label: '目标', mediaType: 'text', mode: 'generate', prompt: '继续' },
        },
      ],
      edges: [
        {
          id: 'edge-source-target',
          sourceNodeId: 'node-source-meta',
          sourceHandle: 'output:text',
          targetNodeId: 'node-source-target',
          targetHandle: 'input:content',
          order: 0,
        },
      ],
    };
    const app = buildApp({ logger: false, projectStore });
    apps.push(app);

    const saved = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/canvas`,
      payload: canvas,
    });
    expect(saved.statusCode).toBe(200);
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node-source-target/runs',
      payload: { projectId: project.id },
    });
    expect(submitted.statusCode).toBe(202);
    expect(submitted.json().run.snapshot.promptMentions).toBeUndefined();
  });

  it('无正文的独立资料按授权版本进入执行快照，重复身份只冻结一次且不改画布', async () => {
    vi.stubEnv('WORKER_PROVIDER', 'newapi');
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 0 });
    const settingsStore = new MemoryAiSettingsStore('attached-reference-snapshot');
    settingsStore.update({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'synthetic-attached-reference-key',
    });
    const credential = settingsStore.listCredentials()[0]!;
    settingsStore.replaceModels(
      [
        {
          id: 'attached-text-model',
          name: 'attached-text-model',
          mediaTypes: ['text'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credential.id,
    );
    const project = await projectStore.create({ name: '无正文独立资料' });
    const asset = await assetStore.create({
      projectId: project.id,
      name: 'reference.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('version-one'),
    });
    await assetStore.createVersion(asset.id, { content: Buffer.from('version-two') });
    const canvas: CanvasDocument = {
      revision: 0,
      nodes: [
        {
          id: 'attached-target',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: '目标',
            mediaType: 'text',
            mode: 'generate',
            modelAlias: 'attached-text-model',
            credentialId: credential.id,
            prompt: '只有正文',
            resourceRefs: [
              {
                id: 'attached-one',
                assetId: asset.id,
                assetVersion: 1,
                mediaType: 'image',
                name: '参考图',
                attached: true,
              },
              {
                id: 'attached-duplicate',
                assetId: asset.id,
                assetVersion: 1,
                mediaType: 'image',
                name: '重复名称不会覆盖',
                attached: true,
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const executor = vi.fn(async ({ snapshot }: RunExecutorRequest) => ({
      provider: 'newapi',
      summary: 'attached reference executed',
      targetNodeId: snapshot.targetNodeId,
      mediaType: 'text' as const,
      inputCount: 0,
    }));
    const app = buildApp({
      logger: false,
      assetStore,
      projectStore,
      runService,
      runExecutor: executor,
      settingsStore,
    });
    apps.push(app);

    const save = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/canvas`,
      payload: canvas,
    });
    expect(save.statusCode).toBe(200);
    const savedCanvas = await projectStore.getCanvas(project.id);
    expect(savedCanvas?.nodes[0]?.data.promptDocument).toBeUndefined();
    const savedReferencePool = structuredClone(savedCanvas?.nodes[0]?.data.resourceRefs);

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/attached-target/runs',
      payload: { projectId: project.id },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const submittedRun = submitted.json().run as RunRecord;
    expect(submittedRun.snapshot.promptMentions).toEqual([
      expect.objectContaining({
        nodeId: 'attached-target',
        mentionId: 'attached_0',
        assetId: asset.id,
        assetVersion: 1,
        mediaType: 'image',
      }),
    ]);
    const completed = await waitForRun(runService, submittedRun.id, 'succeeded');
    expect(completed.snapshot.nodes[0]?.data.promptDocument).toEqual({
      version: 1,
      blocks: [
        { type: 'text', text: '只有正文' },
        expect.objectContaining({
          type: 'mention',
          mentionId: 'attached_0',
          assetId: asset.id,
          assetVersion: 1,
          inline: true,
        }),
      ],
    });
    expect(executor).toHaveBeenCalledOnce();

    const afterRunCanvas = await projectStore.getCanvas(project.id);
    expect(afterRunCanvas?.nodes[0]?.data.promptDocument).toBeUndefined();
    expect(afterRunCanvas?.nodes[0]?.data.resourceRefs).toEqual(savedReferencePool);
  });

  it('无正文独立资料的权限、版本、归档、媒体和大小错误会聚合并阻止保存', async () => {
    vi.stubEnv('RESOURCE_MENTION_MAX_BYTES', '3');
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: '独立资料错误边界' });
    const foreign = await assetStore.create({
      projectId: 'another-project',
      name: 'foreign.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('ok'),
    });
    const archived = await assetStore.create({
      projectId: project.id,
      name: 'archived.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('ok'),
    });
    await assetStore.setArchived(archived.id, true, { projectId: project.id });
    const versioned = await assetStore.create({
      projectId: project.id,
      name: 'versioned.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('ok'),
    });
    const oversized = await assetStore.create({
      projectId: project.id,
      name: 'oversized.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('1234'),
    });
    const canvas: CanvasDocument = {
      revision: 0,
      nodes: [
        {
          id: 'attached-errors',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: '错误边界',
            mediaType: 'text',
            mode: 'generate',
            prompt: '没有引用标记',
            resourceRefs: [
              {
                id: 'missing',
                assetId: 'asset-does-not-exist',
                mediaType: 'text',
                name: '不存在',
                attached: true,
              },
              {
                id: 'foreign',
                assetId: foreign.id,
                mediaType: 'text',
                name: '无权访问',
                attached: true,
              },
              {
                id: 'archived',
                assetId: archived.id,
                mediaType: 'text',
                name: '已归档',
                attached: true,
              },
              {
                id: 'version-missing',
                assetId: versioned.id,
                assetVersion: 99,
                mediaType: 'text',
                name: '版本不存在',
                attached: true,
              },
              {
                id: 'mime-mismatch',
                assetId: versioned.id,
                mediaType: 'image',
                name: '媒体不符',
                attached: true,
              },
              {
                id: 'oversized',
                assetId: oversized.id,
                mediaType: 'text',
                name: '过大',
                attached: true,
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const app = buildApp({ logger: false, assetStore, projectStore });
    apps.push(app);

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/canvas`,
      payload: canvas,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: 'RESOURCE_MENTION_FREEZE_FAILED' });
    expect(response.json().issues.map((issue: { code: string }) => issue.code)).toEqual([
      'RESOURCE_MENTION_NOT_FOUND',
      'RESOURCE_MENTION_FORBIDDEN',
      'RESOURCE_MENTION_ARCHIVED',
      'RESOURCE_MENTION_VERSION_MISSING',
      'RESOURCE_MENTION_MIME_MISMATCH',
      'RESOURCE_MENTION_SIZE_EXCEEDED',
    ]);
    expect((await projectStore.getCanvas(project.id))?.revision).toBe(0);
  });

  it('全能参考把提示词图片提及收成视频参考，不走聊天提及能力预检', async () => {
    vi.stubEnv('WORKER_PROVIDER', 'newapi');
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 0 });
    const settingsStore = new MemoryAiSettingsStore('resource-mention-video-omni');
    settingsStore.update({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'synthetic-resource-mention-key',
    });
    const credential = settingsStore.listCredentials()[0];
    if (!credential) throw new Error('测试凭据创建失败');
    settingsStore.replaceModels(
      [
        {
          id: 'grok-imagine-video-1.5.1',
          name: 'Grok video',
          mediaTypes: ['video'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credential.id,
    );
    const project = await projectStore.create({ name: '视频全能参考' });
    const asset = await assetStore.create({
      projectId: project.id,
      name: 'product.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('image'),
    });
    await storeCanvas(projectStore, project.id, {
      revision: 0,
      nodes: [
        {
          id: 'node-omni-video',
          type: 'video',
          position: { x: 0, y: 0 },
          data: {
            label: '全能参考',
            mediaType: 'video',
            mode: 'generate',
            videoMode: 'omni_reference',
            modelAlias: 'grok-imagine-video-1.5.1',
            credentialId: credential.id,
            prompt: '保持主体',
            promptDocument: {
              version: 1,
              blocks: [
                { type: 'text', text: '保持主体' },
                {
                  type: 'mention',
                  mentionId: 'mention-omni',
                  assetId: asset.id,
                  assetVersion: 1,
                  label: asset.name,
                  mediaType: 'image',
                },
              ],
            },
          },
        },
      ],
      edges: [],
    });
    const executor = vi.fn(async ({ snapshot }: RunExecutorRequest) => ({
      provider: 'newapi',
      summary: '不应在本测试执行到 Provider',
      targetNodeId: snapshot.targetNodeId,
      mediaType: 'video' as const,
      inputCount: 0,
    }));
    const app = buildApp({
      logger: false,
      assetStore,
      projectStore,
      runService,
      runExecutor: executor,
      settingsStore,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node-omni-video/runs',
      payload: { projectId: project.id },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().run.snapshot.promptMentions).toEqual([
      expect.objectContaining({ mentionId: 'mention-omni', mediaType: 'image' }),
    ]);
  });

  it('文生视频节点上的图片提及按全能参考吸收，不再报能力不兼容', async () => {
    vi.stubEnv('WORKER_PROVIDER', 'newapi');
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 0 });
    const settingsStore = new MemoryAiSettingsStore('resource-mention-video-text');
    settingsStore.update({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'synthetic-resource-mention-key',
    });
    const credential = settingsStore.listCredentials()[0];
    if (!credential) throw new Error('测试凭据创建失败');
    settingsStore.replaceModels(
      [
        {
          id: 'grok-imagine-video-1.5.1',
          name: 'Grok video',
          mediaTypes: ['video'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credential.id,
    );
    const project = await projectStore.create({ name: '视频文生提及' });
    const asset = await assetStore.create({
      projectId: project.id,
      name: 'product.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('image'),
    });
    await storeCanvas(projectStore, project.id, {
      revision: 0,
      nodes: [
        {
          id: 'node-text-video',
          type: 'video',
          position: { x: 0, y: 0 },
          data: {
            label: '文生视频',
            mediaType: 'video',
            mode: 'generate',
            videoMode: 'text_to_video',
            modelAlias: 'grok-imagine-video-1.5.1',
            credentialId: credential.id,
            prompt: '保持主体',
            promptDocument: {
              version: 1,
              blocks: [
                { type: 'text', text: '保持主体' },
                {
                  type: 'mention',
                  mentionId: 'mention-text',
                  assetId: asset.id,
                  assetVersion: 1,
                  label: asset.name,
                  mediaType: 'image',
                },
              ],
            },
          },
        },
      ],
      edges: [],
    });
    const executor = vi.fn(async ({ snapshot }: RunExecutorRequest) => ({
      provider: 'newapi',
      summary: '不应在本测试执行到 Provider',
      targetNodeId: snapshot.targetNodeId,
      mediaType: 'video' as const,
      inputCount: 0,
    }));
    const app = buildApp({
      logger: false,
      assetStore,
      projectStore,
      runService,
      runExecutor: executor,
      settingsStore,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node-text-video/runs',
      payload: { projectId: project.id },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().error).toBeUndefined();
    expect(response.json().run.snapshot.promptMentions).toEqual([
      expect.objectContaining({ mentionId: 'mention-text', mediaType: 'image' }),
    ]);
  });
});
