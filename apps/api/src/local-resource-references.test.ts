import type { RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider } from '@multimodal-canvas/providers';
import { describe, expect, it, vi } from 'vitest';

import { withAssetOwnershipPolicy } from './asset-ownership';
import { MemoryAssetStore } from './assets';
import { withLocalResourceReferences } from './local-resource-references';
import { MemoryProjectStore } from './projects';

describe('本地资源发送前的授权复查', () => {
  it.each(['during-next-read', 'during-prompt', 'project-during-prompt'] as const)(
    '%s 撤销后不发送 Provider 请求，也不重复读取文件',
    async (stage) => {
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
        modelAlias: 'text-multimodal-test',
        parameters: {},
        submittedAt: new Date().toISOString(),
        nodes: [
          {
            id: 'text-target',
            type: 'text',
            position: { x: 0, y: 0 },
            data: {
              label: '比较图片',
              mediaType: 'text',
              mode: 'generate',
              promptDocument: {
                version: 1,
                blocks: assets.map((asset, index) => ({
                  type: 'mention',
                  mentionId: `image-${index}`,
                  assetId: asset.id,
                  assetVersion: 1,
                  mediaType: 'image',
                  label: asset.name,
                })),
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
          blockOrder: index,
        })),
      };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ choices: [{ message: { content: 'ACCEPTANCE_OK' } }] }));
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.test/v1',
        apiKey: 'synthetic-resource-race-key',
        fetchImpl,
      });
      const executor = withLocalResourceReferences(
        (request) => provider.execute(request),
        withAssetOwnershipPolicy(assetStore, projectStore),
        projectStore,
        1024,
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
    },
  );
});
