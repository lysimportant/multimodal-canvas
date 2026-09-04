import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasDocument, MediaType, RunRecord } from '@multimodal-canvas/domain';

import { buildApp } from './app';
import { MemoryAssetStore } from './assets';
import { MemoryProjectStore } from './projects';
import { MemoryRunService, type RunExecutorRequest } from './runs';
import { AiSettingsStore } from './settings';

const apps: Array<ReturnType<typeof buildApp>> = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WORKER_PROVIDER', 'mock');
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

/** 创建不经过 HTTP 校验的测试画布，用于覆盖运行边界的防御性检查。 */
async function storeCanvas(
  projectStore: MemoryProjectStore,
  projectId: string,
  canvas: CanvasDocument,
): Promise<CanvasDocument> {
  return projectStore.updateCanvas(projectId, canvas);
}

/** 等待内存运行到达终态，并在超时时保留最后状态。 */
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
          { content: Buffer.from(`${mediaType}-v2`) },
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
        expect(content?.toString('utf8')).toContain('document-text @text-reference');
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

  it('真实 Provider 能力未知时在创建运行和调用 executor 前 fail-closed', async () => {
    vi.stubEnv('WORKER_PROVIDER', 'newapi');
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 0 });
    const settingsStore = new AiSettingsStore('resource-mention-real-preflight');
    settingsStore.update({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'synthetic-resource-mention-key',
    });
    const credential = settingsStore.listCredentials()[0];
    if (!credential) throw new Error('测试凭据创建失败');
    settingsStore.replaceModels(
      [
        {
          id: 'real-image',
          name: 'Real image',
          mediaTypes: ['image'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credential.id,
    );
    const project = await projectStore.create({ name: '真实能力预检' });
    const asset = await assetStore.create({
      projectId: project.id,
      name: 'reference.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('image'),
    });
    await storeCanvas(projectStore, project.id, {
      revision: 0,
      nodes: [
        {
          id: 'node-real-image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: '真实图片',
            mediaType: 'image',
            mode: 'generate',
            modelAlias: 'real-image',
            credentialId: credential.id,
            promptDocument: {
              version: 1,
              blocks: [
                {
                  type: 'mention',
                  mentionId: 'mention-real',
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
      summary: '不应执行',
      targetNodeId: snapshot.targetNodeId,
      mediaType: 'image' as const,
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
      url: '/v1/nodes/node-real-image/runs',
      payload: { projectId: project.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'RESOURCE_MENTION_CAPABILITY_UNSUPPORTED',
      issues: [
        {
          code: 'RESOURCE_MENTION_CAPABILITY_UNKNOWN',
          nodeId: 'node-real-image',
          mentionId: 'mention-real',
          assetId: asset.id,
          mediaType: 'image',
          modelAlias: 'real-image',
        },
      ],
    });
    expect(executor).not.toHaveBeenCalled();
    expect(await runService.listByProject(project.id)).toEqual([]);
    expect(JSON.stringify(response.json())).not.toContain('synthetic-resource-mention-key');
  });
});
