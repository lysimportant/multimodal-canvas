import { describe, expect, it } from 'vitest';

import type { CanvasDocument, PromptMention } from '@multimodal-canvas/domain';

import { MemoryAssetStore } from './assets';
import { createWorkflowExport } from './export';
import { importWorkflowExport, parseWorkflowExport, WorkflowImportError } from './workflow-import';

function canvasWithMention(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return {
    revision: 1,
    nodes: [
      {
        id: 'node-text',
        type: 'text' as const,
        position: { x: 0, y: 0 },
        data: {
          label: '摘要',
          mediaType: 'text' as const,
          mode: 'generate' as const,
          promptDocument: {
            version: 1 as const,
            blocks: [
              { type: 'text' as const, text: '请参考 ' },
              {
                type: 'mention' as const,
                mentionId: 'mention-1',
                assetId: 'asset-1',
                label: '资料',
                mediaType: 'text' as const,
                assetVersion: 1,
                semanticRole: 'sourceDocument',
                entityName: '资料',
                scope: 'node' as const,
              },
              { type: 'text' as const, text: ' 输出摘要' },
            ],
          },
        },
      },
    ],
    edges: [],
    ...overrides,
  } satisfies CanvasDocument;
}

function workflowForCanvas(canvas: ReturnType<typeof canvasWithMention>) {
  return {
    schemaVersion: 1,
    exportedAt: '2026-09-04T00:00:00.000Z',
    project: {
      id: 'project-source',
      name: '导入测试',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    },
    canvas,
    runs: [],
    results: [],
  };
}

describe('workflow import contract', () => {
  it('parses the current schema and rejects unsupported versions', () => {
    expect(parseWorkflowExport(workflowForCanvas(canvasWithMention())).canvas.nodes).toHaveLength(
      1,
    );
    expect(() =>
      parseWorkflowExport({ ...workflowForCanvas(canvasWithMention()), schemaVersion: 99 }),
    ).toThrowError(WorkflowImportError);
    try {
      parseWorkflowExport({ ...workflowForCanvas(canvasWithMention()), schemaVersion: 99 });
    } catch (error) {
      expect(error).toMatchObject({ code: 'unsupported_schema_version' });
    }
  });

  it('retains identity and binding when an imported mention is unavailable', async () => {
    const result = await importWorkflowExport(workflowForCanvas(canvasWithMention()), {
      assetStore: new MemoryAssetStore(),
      assetScope: { ownerId: 'owner-1' },
      projectId: 'project-target',
    });
    const mention = result.canvas.nodes[0]?.data.promptDocument?.blocks[1];
    expect(mention).toMatchObject({
      type: 'mention',
      mentionId: 'mention-1',
      assetId: 'asset-1',
      label: '资料',
      mediaType: 'text',
      semanticRole: 'sourceDocument',
      entityName: '资料',
      scope: 'node',
      placeholder: true,
      placeholderReason: 'not_found',
    });
    expect(result.issues).toMatchObject([
      {
        code: 'RESOURCE_MENTION_IMPORT_NOT_FOUND',
        mentionId: 'mention-1',
        assetId: 'asset-1',
        nodeId: 'node-text',
        mediaType: 'text',
      },
    ]);
    expect(JSON.stringify(result.issues)).not.toContain('contentUrl');
  });

  it('keeps a valid mention unchanged and checks the selected version and size', async () => {
    const store = new MemoryAssetStore();
    const asset = await store.create({
      projectId: 'project-target',
      name: '资料.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('hello'),
    });
    const workflow = workflowForCanvas(
      canvasWithMention({
        nodes: [
          {
            ...canvasWithMention().nodes[0],
            data: {
              ...canvasWithMention().nodes[0].data,
              promptDocument: {
                ...canvasWithMention().nodes[0].data.promptDocument,
                version: 1 as const,
                blocks: [
                  {
                    type: 'mention' as const,
                    mentionId: 'valid',
                    assetId: asset.id,
                    label: '资料',
                    mediaType: 'text' as const,
                    assetVersion: 1,
                  },
                ],
              },
            },
          },
        ],
      }),
    );
    const imported = await importWorkflowExport(workflow, {
      assetStore: store,
      assetScope: { ownerId: undefined },
      projectId: 'project-target',
      maxMentionBytes: 5,
    });
    expect(imported.issues).toEqual([]);
    expect(imported.canvas.nodes[0]?.data.promptDocument?.blocks[0]).toMatchObject({
      mentionId: 'valid',
      assetId: asset.id,
      assetVersion: 1,
    });
  });

  it('reports archived, MIME, missing-version, and size failures separately', async () => {
    const store = new MemoryAssetStore();
    const archived = await store.create({
      projectId: 'project-target',
      name: 'archived.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('a'),
    });
    await store.setArchived(archived.id, true, { projectId: 'project-target' });
    const image = await store.create({
      projectId: 'project-target',
      name: 'image.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('123456'),
    });
    const workflow = workflowForCanvas(
      canvasWithMention({
        nodes: [
          {
            ...canvasWithMention().nodes[0],
            data: {
              ...canvasWithMention().nodes[0].data,
              promptDocument: {
                version: 1 as const,
                blocks: [
                  {
                    type: 'mention' as const,
                    mentionId: 'archived',
                    assetId: archived.id,
                    label: '归档',
                    mediaType: 'text' as const,
                    assetVersion: 1,
                  },
                  {
                    type: 'mention' as const,
                    mentionId: 'mime',
                    assetId: image.id,
                    label: '图片',
                    mediaType: 'text' as const,
                    assetVersion: 1,
                  },
                  {
                    type: 'mention' as const,
                    mentionId: 'version',
                    assetId: image.id,
                    label: '缺失版本',
                    mediaType: 'image' as const,
                    assetVersion: 99,
                  },
                  {
                    type: 'mention' as const,
                    mentionId: 'size',
                    assetId: image.id,
                    label: '超大',
                    mediaType: 'image' as const,
                    assetVersion: 1,
                  },
                ],
              },
            },
          },
        ],
      }),
    );
    const imported = await importWorkflowExport(workflow, {
      assetStore: store,
      projectId: 'project-target',
      maxMentionBytes: 5,
    });
    expect(imported.issues.map((issue) => issue.reason)).toEqual([
      'archived',
      'mime_mismatch',
      'version_missing',
      'size_exceeded',
    ]);
    expect(
      imported.canvas.nodes[0]?.data.promptDocument?.blocks.every((block) =>
        block.type === 'mention' ? block.placeholder === true : true,
      ),
    ).toBe(true);
  });

  it('preserves explicit placeholders and reports them without querying content', async () => {
    const canvas = canvasWithMention();
    const node = canvas.nodes[0]!;
    node.data.promptDocument!.blocks[1] = {
      ...(node.data.promptDocument!.blocks[1] as PromptMention),
      placeholder: true,
      placeholderReason: 'forbidden',
    };
    const result = await importWorkflowExport(workflowForCanvas(canvas), {
      assetStore: new MemoryAssetStore(),
    });
    expect(result.issues[0]).toMatchObject({
      code: 'RESOURCE_MENTION_IMPORT_PLACEHOLDER',
      reason: 'placeholder',
    });
    expect(result.canvas.nodes[0]?.data.promptDocument?.blocks[1]).toMatchObject({
      placeholder: true,
      placeholderReason: 'forbidden',
    });
  });
});
