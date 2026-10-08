import type { RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiVideoProvider } from '@multimodal-canvas/providers';
import { createProviderAssetUrlSignerFromEnvironment } from '@multimodal-canvas/credential-crypto';
import { describe, expect, it, vi } from 'vitest';

import { withAssetOwnershipPolicy } from './asset-ownership';
import { MemoryAssetStore } from './assets';
import { withLocalResourceReferences } from './local-resource-references';
import { MemoryProjectStore } from './projects';

describe('本地资源发送前的授权复查', () => {
  it.each([
    'Seedance2.0 0.9r',
    '无限制-Flash-中配-Video',
    '无限制-Flash-MAX-Video',
    'Yuan-Seedance-2.5-LJ-Full',
  ])('%s 已有公共任务恢复时不重新读取已失效的原图', async (modelAlias) => {
    const snapshot: RunSnapshot = {
      projectId: 'resume-project',
      canvasRevision: 1,
      targetNodeId: 'video',
      modelAlias,
      parameters: { resolution: 'legacy-value' },
      submittedAt: '2026-10-07T00:00:00.000Z',
      nodes: [
        {
          id: 'video',
          type: 'video',
          position: { x: 0, y: 0 },
          data: {
            label: '恢复视频',
            mediaType: 'video',
            mode: 'generate',
            videoMode: 'omni_reference',
          },
        },
      ],
      edges: [],
      inputs: [],
      promptMentions: [
        {
          nodeId: 'video',
          mentionId: 'old-image',
          assetId: 'deleted-image',
          assetVersion: 1,
          mediaType: 'image',
          label: '旧原图',
          blockOrder: 0,
        },
      ],
    };
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const readAsset = vi.spyOn(assetStore, 'get');
    const readProject = vi.spyOn(projectStore, 'get');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 'task_image2pro_existing',
        status: 'completed',
        url: 'https://cdn.example.test/resumed.mp4',
      }),
    );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'synthetic-resume-key',
      fetchImpl,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    });
    const executor = withLocalResourceReferences(
      (request) => provider.execute(request),
      assetStore,
      projectStore,
      1024,
    );
    const request = {
      snapshot,
      providerJob: {
        provider: 'newapi',
        platformJobId: 'task_image2pro_existing',
        payload: { contract: 'newapi-video-v1' },
      },
    };
    await (typeof executor === 'function' ? executor(request) : executor.execute(request));
    expect(readAsset).not.toHaveBeenCalled();
    expect(readProject).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://newapi.example.test/v1/videos/task_image2pro_existing',
    );
    expect(fetchImpl.mock.calls[0]![1]!.method).toBe('GET');
  });

  it.each(
    ['during-next-read', 'during-prompt', 'project-during-prompt'].flatMap((stage) =>
      [
        { mediaType: 'text' as const, modelAlias: 'text-multimodal-test' },
        { mediaType: 'video' as const, modelAlias: 'Seedance2.0 0.9r' },
        { mediaType: 'video' as const, modelAlias: 'Yuan-Seedance-2.5-LJ-Full' },
      ].map((model) => ({ stage, ...model })),
    ),
  )(
    '$modelAlias $stage 撤销后不发送 Provider 请求，也不重复读取文件',
    async ({ stage, mediaType, modelAlias }) => {
      const ownerId = 'resource-race-owner';
      const projectStore = new MemoryProjectStore();
      const project = await projectStore.create({ name: '资源授权复查' }, { ownerId });
      const assetStore = new MemoryAssetStore();
      const assets = await Promise.all(
        ['A', 'B'].map((label) =>
          assetStore.create({
            ownerId,
            name: `${label}.png`,
            mediaType: 'image',
            mimeType: 'image/png',
            content: Buffer.from(`image-${label}`),
          }),
        ),
      );
      const first = assets[0]!;
      const second = assets[1]!;
      const originalReader = assetStore.getVersionContent.bind(assetStore);
      const reader = vi
        .spyOn(assetStore, 'getVersionContent')
        .mockImplementation(async (...args) => {
          const content = await originalReader(...args);
          if (stage === 'during-next-read' && args[0] === second.id) {
            await assetStore.setArchived(first.id, true);
          }
          return content;
        });
      const snapshot: RunSnapshot = {
        projectId: project.id,
        canvasRevision: 0,
        targetNodeId: 'text-target',
        modelAlias,
        parameters: mediaType === 'video' ? { duration: 5 } : {},
        submittedAt: new Date().toISOString(),
        nodes: [
          {
            id: 'text-target',
            type: mediaType,
            position: { x: 0, y: 0 },
            data: {
              label: '比较图片',
              mediaType,
              mode: 'generate',
              ...(mediaType === 'video' ? { videoMode: 'omni_reference' as const } : {}),
              promptDocument: {
                version: 1,
                blocks: [
                  { type: 'text', text: 'Compare the references.' },
                  ...assets.map((asset, index) => ({
                    type: 'mention' as const,
                    mentionId: `image-${index}`,
                    assetId: asset.id,
                    assetVersion: 1,
                    mediaType: 'image' as const,
                    label: asset.name,
                  })),
                ],
              },
            },
          },
        ],
        edges: [],
        inputs: [],
        promptMentions: assets.map((asset, index) => ({
          nodeId: 'text-target',
          mentionId: `image-${index}`,
          assetId: asset.id,
          assetVersion: 1,
          mediaType: 'image',
          label: asset.name,
          blockOrder: index + 1,
        })),
      };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ choices: [{ message: { content: 'ACCEPTANCE_OK' } }] }));
      const providerOptions = {
        baseUrl: 'https://newapi.example.test/v1',
        apiKey: 'synthetic-resource-race-key',
        fetchImpl,
      };
      const provider =
        mediaType === 'video'
          ? new NewApiVideoProvider({ ...providerOptions, videoContract: 'newapi-video-v1' })
          : new NewApiProvider(providerOptions);
      const executor = withLocalResourceReferences(
        (request) => provider.execute(request),
        withAssetOwnershipPolicy(assetStore, projectStore),
        projectStore,
        1024,
        createProviderAssetUrlSignerFromEnvironment({
          CANVAS_WEB_URL: 'https://canvas.example.com',
          API_JWT_SECRET: 'synthetic-resource-race-signing-key',
        }),
      );
      const capture = vi.fn(async () => {
        if (stage === 'during-prompt') {
          const getOwnership = assetStore.getOwnership.bind(assetStore);
          vi.spyOn(assetStore, 'getOwnership').mockImplementation((id) =>
            id === first.id
              ? Promise.resolve({ ownerId: 'different-owner', projectId: null })
              : getOwnership(id),
          );
        }
        if (stage === 'project-during-prompt') {
          await projectStore.setArchived(project.id, true);
        }
      });
      const request = {
        snapshot,
        userId: ownerId,
        runId: 'resource-race-run',
        attempt: 1,
        onRequestPrompt: capture,
      };

      await expect(
        typeof executor === 'function' ? executor(request) : executor.execute(request),
      ).rejects.toThrow(stage === 'project-during-prompt' ? '项目' : first.id);

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(capture).toHaveBeenCalledTimes(stage === 'during-next-read' ? 0 : 1);
      expect(reader).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(snapshot)).not.toContain(';base64,');
      expect(JSON.stringify(snapshot)).not.toContain('access_token');
    },
  );
});
