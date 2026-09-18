import { NewApiProvider, NewApiVideoProvider } from '@multimodal-canvas/providers';
import type { CanvasDocument, MediaType, RunRecord } from '@multimodal-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';
import { MemoryAssetStore } from './assets';
import { MemoryAuthStore } from './auth-store';
import { AuthService } from './auth-service';
import { createNewApiRunExecutor } from './newapi-run-executor';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';
import { AiSettingsStore } from './settings';

/** 等待真实适配器的合成网络调用结束，失败状态由测试断言报告。 */
async function waitForRun(service: MemoryRunService, id: string): Promise<RunRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await service.get(id);
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('本地文字执行未在测试期限内结束');
}

/** 每种媒体对应已实现的 Chat Completions 内容块。 */
const mediaFixtures: Record<MediaType, { mimeType: string; content: string }> = {
  text: { mimeType: 'text/markdown', content: '# Frozen document' },
  image: { mimeType: 'image/png', content: 'frozen-image-bytes' },
  audio: { mimeType: 'audio/wav', content: 'frozen-audio-bytes' },
  video: { mimeType: 'video/mp4', content: 'frozen-video-bytes' },
};

const apps: Array<ReturnType<typeof buildApp>> = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WORKER_PROVIDER', 'newapi');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-local-text-jwt-secret');
  vi.stubEnv('API_AUTH_TOKEN', '');
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

describe('本地文字资源到 Chat Completions', () => {
  it.each([
    { kind: 'mention', mediaType: 'text', outcome: 'independent-success' },
    { kind: 'mention', mediaType: 'text', outcome: 'success' },
    { kind: 'mention', mediaType: 'image', outcome: 'success' },
    { kind: 'mention', mediaType: 'audio', outcome: 'success' },
    { kind: 'mention', mediaType: 'video', outcome: 'success' },
    { kind: 'link', mediaType: 'text', outcome: 'success' },
    { kind: 'link', mediaType: 'image', outcome: 'success' },
    { kind: 'mixed', mediaType: 'image', outcome: 'success' },
    { kind: 'mention', mediaType: 'image', outcome: 'scope-revoked' },
    { kind: 'link', mediaType: 'image', outcome: 'scope-revoked' },
    { kind: 'mention', mediaType: 'audio', outcome: 'archived' },
    { kind: 'mention', mediaType: 'video', outcome: 'deleted' },
    { kind: 'mention', mediaType: 'image', outcome: 'version-missing' },
    { kind: 'mention', mediaType: 'image', outcome: 'cancelled' },
    { kind: 'link', mediaType: 'image', outcome: 'provider-rejected' },
    { kind: 'mention', mediaType: 'text', outcome: 'invalid-utf8' },
    { kind: 'link', mediaType: 'image', outcome: 'project-archived' },
    { kind: 'mention', mediaType: 'image', outcome: 'mime-mismatch' },
    { kind: 'mention', mediaType: 'image', outcome: 'size-mismatch' },
  ] as const)('HTTP → $mediaType $kind → $outcome', async ({ kind, mediaType, outcome }) => {
    const isMention = kind !== 'link';
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const authStore = new MemoryAuthStore();
    const auth = new AuthService({
      store: authStore,
      jwtSecret: 'synthetic-local-text-jwt-secret',
    });
    const session = await auth.register({
      email: 'local-text@example.test',
      password: 'synthetic-test-password',
    });
    const ownerId = session.user.id;
    const project = await projectStore.create({ name: '本地文字资源' }, { ownerId });
    const fixture = mediaFixtures[mediaType];
    const original =
      outcome === 'invalid-utf8' ? Buffer.from([0xff, 0xfe]) : Buffer.from(fixture.content);
    const asset = await assetStore.create({
      ...(isMention ? { ownerId } : { projectId: project.id }),
      name: `reference-${mediaType}`,
      mediaType,
      mimeType: fixture.mimeType,
      content: original,
    });
    const settingsStore = new AiSettingsStore('local-text-reference');
    settingsStore.update({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'synthetic-local-text-key',
      ...(outcome === 'independent-success' ? { activate: false } : {}),
    });
    const credential = settingsStore.listCredentials()[0]!;
    if (outcome === 'independent-success') {
      expect(settingsStore.get().configured).toBe(false);
      expect(credential.active).toBe(false);
    }
    settingsStore.replaceModels(
      [
        {
          id: 'text-multimodal-test',
          name: 'Text Multimodal Test',
          mediaTypes: ['text'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credential.id,
    );
    const canvas: CanvasDocument = {
      revision: 0,
      nodes: [
        {
          id: 'text-target',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: '文字',
            mediaType: 'text',
            mode: 'generate',
            modelAlias: 'text-multimodal-test',
            credentialId: credential.id,
            promptDocument: {
              version: 1,
              blocks: [
                { type: 'text', text: 'Describe this resource.' },
                ...(isMention
                  ? [
                      {
                        type: 'mention' as const,
                        mentionId: 'reference',
                        assetId: asset.id,
                        assetVersion: 1,
                        label: '参考素材',
                        mediaType,
                      },
                    ]
                  : []),
              ],
            },
          },
        },
      ],
      edges: [],
    };
    if (kind === 'mixed') {
      const document = await assetStore.create({
        ownerId,
        name: 'instructions.md',
        mediaType: 'text',
        mimeType: 'text/markdown',
        content: Buffer.from('Compare this document with the image.'),
      });
      canvas.nodes[0]!.data.promptDocument!.blocks.push({
        type: 'mention',
        mentionId: 'reference-document',
        assetId: document.id,
        assetVersion: 1,
        label: '参考文档',
        mediaType: 'text',
        semanticRole: 'content',
      });
    }
    if (kind === 'link') {
      canvas.nodes.push({
        id: 'resource-source',
        type: mediaType,
        position: { x: -300, y: 0 },
        data: {
          label: '参考素材',
          mediaType,
          mode: 'source',
          assetId: asset.id,
          contentUrl: `/v1/assets/${asset.id}/content`,
          mimeType: fixture.mimeType,
          ...(mediaType === 'text' ? { prompt: 'stale editor text' } : {}),
        },
      });
      canvas.edges.push({
        id: 'resource-edge',
        sourceNodeId: 'resource-source',
        sourceHandle: `output:${mediaType}`,
        targetNodeId: 'text-target',
        targetHandle: 'input:content',
        order: 0,
      });
    }
    await projectStore.updateCanvas(project.id, canvas);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(
          outcome === 'provider-rejected'
            ? { error: { message: 'Synthetic chat rejection' } }
            : { choices: [{ message: { content: 'ACCEPTANCE_OK' } }] },
          { status: outcome === 'provider-rejected' ? 400 : 200 },
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
      url: '/v1/nodes/text-target/runs',
      payload: { projectId: project.id },
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const runId = submitted.json().run.id;
    await assetStore.createVersion(asset.id, { content: Buffer.from('newer-resource-content') });
    const originalReader = assetStore.getVersionContent.bind(assetStore);
    const reader = vi.spyOn(assetStore, 'getVersionContent');
    if (outcome === 'archived') await assetStore.setArchived(asset.id, true);
    if (outcome === 'deleted') await assetStore.delete(asset.id);
    if (outcome === 'project-archived') await projectStore.setArchived(project.id, true);
    if (outcome === 'version-missing') reader.mockResolvedValueOnce(undefined);
    if (outcome === 'size-mismatch') reader.mockResolvedValueOnce(Buffer.from('wrong-size'));
    if (outcome === 'mime-mismatch') {
      const originalGetter = assetStore.get.bind(assetStore);
      vi.spyOn(assetStore, 'get').mockImplementation(async (...args) => {
        const current = await originalGetter(...args);
        return current ? { ...current, mimeType: 'audio/wav' } : undefined;
      });
    }
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
    const run = await waitForRun(runService, runId);
    expect(JSON.stringify(run.snapshot)).not.toContain(';base64,');
    expect(JSON.stringify(await projectStore.getCanvas(project.id))).not.toContain(';base64,');
    if (kind === 'link') {
      expect(run.snapshot.inputs[0]).toMatchObject({
        sourceAssetId: asset.id,
        sourceAssetVersion: 1,
        snapshot: { data: { contentUrl: `/v1/assets/${asset.id}/versions/1/content` } },
      });
    }
    if (
      outcome !== 'success' &&
      outcome !== 'independent-success' &&
      outcome !== 'provider-rejected'
    ) {
      expect(run.status, JSON.stringify(run.error)).toBe(
        outcome === 'cancelled' ? 'cancelled' : 'failed',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      return;
    }
    expect(fetchImpl, JSON.stringify(run.error)).toHaveBeenCalledOnce();
    if (kind === 'link' && mediaType === 'image') {
      const summaries = await runService.listRequestPromptRecords(runId);
      expect(summaries).toHaveLength(1);
      const requestPrompt = await runService.getRequestPromptRecord(runId, summaries[0]!.id);
      expect(requestPrompt?.resources).toEqual([
        {
          assetId: asset.id,
          assetVersion: 1,
          role: 'content',
          sortOrder: 0,
          mediaType: 'image',
        },
      ]);
      expect(JSON.stringify(requestPrompt)).not.toContain(original.toString('base64'));
    }
    if (outcome === 'provider-rejected') {
      expect(run.status).toBe('failed');
      expect(run.error).toContain('Synthetic chat rejection');
      return;
    }
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example.test/v1/chat/completions');
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    const contents = JSON.stringify(body.messages);
    expect(contents).toContain(
      mediaType === 'text' ? fixture.content : original.toString('base64'),
    );
    expect(contents).not.toContain('stale editor text');
    expect(contents).not.toContain(Buffer.from('newer-resource-content').toString('base64'));
    if (kind === 'mixed') expect(contents).toContain('Compare this document with the image.');
    expect(reader).toHaveBeenCalledWith(
      asset.id,
      1,
      isMention ? { projectId: null, ownerId } : { projectId: project.id },
    );
  });
});
