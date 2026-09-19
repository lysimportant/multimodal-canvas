import { describe, expect, it } from 'vitest';

import type { RunSnapshot } from '@multimodal-canvas/domain';

import {
  WorkflowNodeConfigurationError,
  assertWorkflowModelAliases,
  createInitialWorkflowState,
  createNodeRunSnapshot,
  replaceWorkflowNodeState,
  workflowExecutionOrder,
  workflowSnapshotFingerprint,
  workflowSnapshotFingerprintV1,
} from './workflow-dag';

const snapshot: RunSnapshot = {
  projectId: 'project_1',
  canvasRevision: 7,
  targetNodeId: 'node_video',
  modelAlias: 'video-model',
  parameters: { prompt: 'only the final node receives this prompt', resolution: '1080p' },
  submittedAt: '2026-08-27T00:00:00.000Z',
  nodes: [
    {
      id: 'node_prompt',
      type: 'text' as const,
      position: { x: 0, y: 0 },
      data: { label: 'Outline prompt', mediaType: 'text' as const, mode: 'source' as const },
    },
    {
      id: 'node_draft',
      type: 'text' as const,
      position: { x: 200, y: 0 },
      data: { label: 'Draft', mediaType: 'text' as const, mode: 'generate' as const },
    },
    {
      id: 'node_style',
      type: 'image' as const,
      position: { x: 0, y: 200 },
      data: {
        label: 'Style source',
        mediaType: 'image' as const,
        mode: 'source' as const,
        assetId: 'asset_style',
        contentUrl: '/v1/assets/asset_style/content',
        mimeType: 'image/png',
      },
    },
    {
      id: 'node_image',
      type: 'image' as const,
      position: { x: 200, y: 200 },
      data: {
        label: 'Key frame',
        mediaType: 'image' as const,
        mode: 'generate' as const,
        modelAlias: 'image-override',
        inferenceStrength: 'high' as const,
      },
    },
    {
      id: 'node_video',
      type: 'video' as const,
      position: { x: 400, y: 100 },
      data: { label: 'Video', mediaType: 'video' as const, mode: 'generate' as const },
    },
  ],
  edges: [
    {
      id: 'edge_prompt_draft',
      sourceNodeId: 'node_prompt',
      sourceHandle: 'output:text',
      targetNodeId: 'node_draft',
      targetHandle: 'input:content',
      order: 0,
    },
    {
      id: 'edge_draft_image',
      sourceNodeId: 'node_draft',
      sourceHandle: 'output:text',
      targetNodeId: 'node_image',
      targetHandle: 'input:prompt',
      order: 0,
    },
    {
      id: 'edge_style_image',
      sourceNodeId: 'node_style',
      sourceHandle: 'output:image',
      targetNodeId: 'node_image',
      targetHandle: 'input:style',
      order: 1,
    },
    {
      id: 'edge_draft_video',
      sourceNodeId: 'node_draft',
      sourceHandle: 'output:text',
      targetNodeId: 'node_video',
      targetHandle: 'input:prompt',
      order: 0,
    },
    {
      id: 'edge_image_video',
      sourceNodeId: 'node_image',
      sourceHandle: 'output:image',
      targetNodeId: 'node_video',
      targetHandle: 'input:firstFrame',
      order: 1,
    },
  ],
  inputs: [
    {
      nodeId: 'node_draft',
      role: 'prompt' as const,
      sortOrder: 0,
      snapshot: {
        id: 'node_draft',
        type: 'text' as const,
        position: { x: 200, y: 0 },
        data: { label: 'Draft', mediaType: 'text' as const, mode: 'generate' as const },
      },
    },
    {
      nodeId: 'node_image',
      role: 'firstFrame' as const,
      sortOrder: 1,
      snapshot: {
        id: 'node_image',
        type: 'image' as const,
        position: { x: 200, y: 200 },
        data: {
          label: 'Key frame',
          mediaType: 'image' as const,
          mode: 'generate' as const,
          modelAlias: 'image-override',
          inferenceStrength: 'high' as const,
        },
      },
    },
  ],
};

describe('frozen workflow DAG', () => {
  it('uses a stable topological order for fan-in dependencies', () => {
    expect(workflowExecutionOrder(snapshot).map((node) => node.id)).toEqual([
      'node_prompt',
      'node_draft',
      'node_style',
      'node_image',
      'node_video',
    ]);
  });

  it('passes archived upstream output into a derived node snapshot only', () => {
    let state = createInitialWorkflowState(snapshot);
    state = replaceWorkflowNodeState(state, {
      nodeId: 'node_draft',
      status: 'succeeded',
      result: {
        provider: 'mock',
        summary: 'draft complete',
        targetNodeId: 'node_draft',
        mediaType: 'text',
        inputCount: 1,
        asset: {
          assetId: 'asset_draft',
          version: 1,
          contentUrl: '/v1/assets/asset_draft/content',
          mimeType: 'text/plain',
        },
      },
    });

    const imageSnapshot = createNodeRunSnapshot(snapshot, state, 'node_image');

    expect(imageSnapshot.targetNodeId).toBe('node_image');
    expect(imageSnapshot.modelAlias).toBe('image-override');
    expect(imageSnapshot.parameters).toEqual({ resolution: '1080p', inferenceStrength: 'high' });
    expect(imageSnapshot.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'node_draft',
          role: 'prompt',
          sourceAssetId: 'asset_draft',
          snapshot: expect.objectContaining({
            data: expect.objectContaining({ contentUrl: '/v1/assets/asset_draft/content' }),
          }),
        }),
        expect.objectContaining({
          nodeId: 'node_style',
          role: 'style',
          sourceAssetId: 'asset_style',
        }),
      ]),
    );
    expect(imageSnapshot.edges.map((edge) => edge.id)).toEqual([
      'edge_draft_image',
      'edge_style_image',
    ]);
  });

  it('keeps the original target static video version and duration frozen by the API', () => {
    const frozen = structuredClone(snapshot);
    const source = {
      id: 'node_video_source',
      type: 'video' as const,
      position: { x: 0, y: 400 },
      data: {
        label: 'Frozen clip',
        mediaType: 'video' as const,
        mode: 'source' as const,
        assetId: 'asset_video_source',
        contentUrl: '/v1/assets/asset_video_source/versions/3/content',
        mimeType: 'video/mp4',
      },
    };
    frozen.nodes.push(source);
    frozen.edges.push({
      id: 'edge_video_source_target',
      sourceNodeId: source.id,
      sourceHandle: 'output:video',
      targetNodeId: frozen.targetNodeId,
      targetHandle: 'input:content',
      order: 2,
    });
    frozen.inputs.push({
      nodeId: source.id,
      role: 'content',
      sortOrder: 2,
      sourceAssetId: 'asset_video_source',
      sourceAssetVersion: 3,
      sourceDurationSeconds: 6.25,
      snapshot: source,
    });

    const targetSnapshot = createNodeRunSnapshot(
      frozen,
      createInitialWorkflowState(frozen),
      frozen.targetNodeId,
    );

    expect(targetSnapshot.inputs.find((input) => input.nodeId === source.id)).toMatchObject({
      sourceAssetId: 'asset_video_source',
      sourceAssetVersion: 3,
      sourceDurationSeconds: 6.25,
    });
  });

  it('does not copy a stale frozen version or duration onto a generated upstream result', () => {
    const frozen = structuredClone(snapshot);
    const generatedInput = frozen.inputs.find((input) => input.nodeId === 'node_image')!;
    generatedInput.sourceAssetId = 'asset_image_old';
    generatedInput.sourceAssetVersion = 1;
    generatedInput.sourceDurationSeconds = 4;
    let state = createInitialWorkflowState(frozen);
    state = replaceWorkflowNodeState(state, {
      nodeId: 'node_image',
      status: 'succeeded',
      result: {
        provider: 'mock',
        summary: 'new generated video',
        targetNodeId: 'node_image',
        mediaType: 'image',
        inputCount: 2,
        asset: {
          assetId: 'asset_image_new',
          version: 2,
          contentUrl: '/v1/assets/asset_image_new/versions/2/content',
          mimeType: 'image/png',
        },
      },
    });

    const targetSnapshot = createNodeRunSnapshot(frozen, state, frozen.targetNodeId);
    const input = targetSnapshot.inputs.find((candidate) => candidate.nodeId === 'node_image');

    expect(input).toMatchObject({ sourceAssetId: 'asset_image_new' });
    expect(input?.sourceAssetVersion).toBeUndefined();
    expect(input?.sourceDurationSeconds).toBeUndefined();
  });

  it('按节点继承图片编辑限制，不把目标模型的限制传给其它模型', () => {
    const frozen: RunSnapshot = {
      ...snapshot,
      imageEditCapability: {
        declared: true,
        mimeTypes: ['image/jpeg'],
      },
      nodeImageEditCapabilities: {
        node_image: {
          declared: true,
          mimeTypes: ['image/png'],
          parameters: ['size'],
        },
      },
    };

    const imageSnapshot = createNodeRunSnapshot(
      frozen,
      createInitialWorkflowState(frozen),
      'node_image',
    );

    expect(imageSnapshot.imageEditCapability).toEqual({
      declared: true,
      mimeTypes: ['image/png'],
      parameters: ['size'],
    });
    // 原始快照不被修改，且副本互不影响。
    expect(frozen.imageEditCapability).toEqual({
      declared: true,
      mimeTypes: ['image/jpeg'],
    });
    imageSnapshot.imageEditCapability!.mimeTypes![0] = 'image/webp';
    expect(frozen.nodeImageEditCapabilities?.node_image.mimeTypes).toEqual(['image/png']);
    expect(imageSnapshot).not.toBe(frozen);
  });

  it('旧快照的编辑能力仅回退给原目标节点，其他节点缺声明时不冒用', () => {
    const frozen: RunSnapshot = {
      ...snapshot,
      imageEditCapability: { declared: true, mimeTypes: ['image/png'] },
    };
    const state = createInitialWorkflowState(frozen);
    expect(createNodeRunSnapshot(frozen, state, 'node_image').imageEditCapability).toBeUndefined();
    expect(createNodeRunSnapshot(frozen, state, 'node_video').imageEditCapability).toEqual(
      frozen.imageEditCapability,
    );
  });

  it('requires a frozen model for every provider-backed intermediate node', () => {
    const frozenModels = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) =>
        node.id === 'node_draft'
          ? { ...node, data: { ...node.data, modelAlias: 'text-frozen' } }
          : node,
      ),
    };

    expect(() => assertWorkflowModelAliases(snapshot)).toThrow(
      'workflow node node_draft is missing a frozen model alias',
    );
    expect(() => assertWorkflowModelAliases(frozenModels)).not.toThrow();
    expect(
      createNodeRunSnapshot(frozenModels, createInitialWorkflowState(frozenModels), 'node_draft')
        .modelAlias,
    ).toBe('text-frozen');
  });

  it('uses the root credential only for legacy snapshots without a node credential map', () => {
    const legacySnapshot = {
      ...snapshot,
      credentialId: 'credential-legacy',
      credentialVersion: 4,
    };

    expect(
      createNodeRunSnapshot(
        legacySnapshot,
        createInitialWorkflowState(legacySnapshot),
        'node_image',
      ),
    ).toMatchObject({
      credentialId: 'credential-legacy',
      credentialVersion: 4,
      nodeCredentialReferences: {
        node_image: { credentialId: 'credential-legacy', credentialVersion: 4 },
      },
    });
  });

  it('selects the immutable credential assigned to each workflow node', () => {
    const credentialSnapshot = {
      ...snapshot,
      credentialId: 'credential-video',
      credentialVersion: 3,
      nodeCredentialReferences: {
        node_draft: { credentialId: 'credential-chat', credentialVersion: 1 },
        node_image: { credentialId: 'credential-image', credentialVersion: 2 },
        node_video: { credentialId: 'credential-video', credentialVersion: 3 },
      },
      nodes: snapshot.nodes.map((node) =>
        node.id === 'node_draft'
          ? { ...node, data: { ...node.data, modelAlias: 'chat-model' } }
          : node,
      ),
    };
    const state = createInitialWorkflowState(credentialSnapshot);

    expect(createNodeRunSnapshot(credentialSnapshot, state, 'node_draft')).toMatchObject({
      credentialId: 'credential-chat',
      credentialVersion: 1,
      nodeCredentialReferences: {
        node_draft: { credentialId: 'credential-chat', credentialVersion: 1 },
      },
    });
    expect(createNodeRunSnapshot(credentialSnapshot, state, 'node_image')).toMatchObject({
      credentialId: 'credential-image',
      credentialVersion: 2,
      nodeCredentialReferences: {
        node_image: { credentialId: 'credential-image', credentialVersion: 2 },
      },
    });
    expect(createNodeRunSnapshot(credentialSnapshot, state, 'node_video')).toMatchObject({
      credentialId: 'credential-video',
      credentialVersion: 3,
      nodeCredentialReferences: {
        node_video: { credentialId: 'credential-video', credentialVersion: 3 },
      },
    });
  });

  it('rejects a provider-backed node missing from an explicit credential map', () => {
    const partialCredentialSnapshot = {
      ...snapshot,
      credentialId: 'credential-video',
      credentialVersion: 3,
      nodeCredentialReferences: {
        node_video: { credentialId: 'credential-video', credentialVersion: 3 },
      },
    };

    let thrown: unknown;
    try {
      createNodeRunSnapshot(
        partialCredentialSnapshot,
        createInitialWorkflowState(partialCredentialSnapshot),
        'node_image',
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkflowNodeConfigurationError);
    expect(thrown).toMatchObject({
      nodeId: 'node_image',
      message: 'workflow node node_image is missing a frozen credential reference',
    });
  });

  it('keeps multiple roles from one upstream without duplicating its node', () => {
    const repeatedSourceSnapshot = {
      ...snapshot,
      edges: [
        ...snapshot.edges,
        {
          id: 'edge_draft_image_negative',
          sourceNodeId: 'node_draft',
          sourceHandle: 'output:text',
          targetNodeId: 'node_image',
          targetHandle: 'input:negativePrompt',
          order: 2,
        },
      ],
    };

    const imageSnapshot = createNodeRunSnapshot(
      repeatedSourceSnapshot,
      createInitialWorkflowState(repeatedSourceSnapshot),
      'node_image',
    );

    expect(imageSnapshot.nodes.filter((node) => node.id === 'node_draft')).toHaveLength(1);
    expect(imageSnapshot.inputs.filter((input) => input.nodeId === 'node_draft')).toMatchObject([
      { role: 'prompt', sortOrder: 0 },
      { role: 'negativePrompt', sortOrder: 2 },
    ]);
  });

  it('carries only the current node frozen prompt mentions into provider snapshots', () => {
    const withMentions = structuredClone(snapshot);
    withMentions.nodes = withMentions.nodes.map((node) =>
      node.id === 'node_image'
        ? {
            ...node,
            data: {
              ...node.data,
              promptDocument: {
                version: 1 as const,
                blocks: [
                  { type: 'text' as const, text: 'use ' },
                  {
                    type: 'mention' as const,
                    mentionId: 'image-mention',
                    assetId: 'asset_style',
                    label: 'style',
                    mediaType: 'image' as const,
                  },
                ],
              },
            },
          }
        : node.id === 'node_video'
          ? {
              ...node,
              data: {
                ...node.data,
                promptDocument: {
                  version: 1 as const,
                  blocks: [
                    { type: 'text' as const, text: 'animate ' },
                    {
                      type: 'mention' as const,
                      mentionId: 'video-mention',
                      assetId: 'asset_style',
                      label: 'style',
                      mediaType: 'image' as const,
                    },
                  ],
                },
              },
            }
          : node,
    );
    withMentions.promptMentions = [
      {
        nodeId: 'node_image',
        mentionId: 'image-mention',
        assetId: 'asset_style',
        assetVersion: 2,
        mediaType: 'image',
        label: 'style',
        blockOrder: 1,
      },
      {
        nodeId: 'node_video',
        mentionId: 'video-mention',
        assetId: 'asset_style',
        assetVersion: 3,
        mediaType: 'image',
        label: 'style',
        blockOrder: 1,
      },
    ];

    const imageSnapshot = createNodeRunSnapshot(
      withMentions,
      createInitialWorkflowState(withMentions),
      'node_image',
    );
    const videoSnapshot = createNodeRunSnapshot(
      withMentions,
      createInitialWorkflowState(withMentions),
      'node_video',
    );

    expect(imageSnapshot.promptMentions?.map((mention) => mention.mentionId)).toEqual([
      'image-mention',
    ]);
    expect(videoSnapshot.promptMentions?.map((mention) => mention.mentionId)).toEqual([
      'video-mention',
    ]);
  });

  it('rejects a provider snapshot for a node outside the target execution closure', () => {
    const unrelatedSnapshot = {
      ...snapshot,
      nodes: [
        ...snapshot.nodes,
        {
          id: 'node_unrelated',
          type: 'text' as const,
          position: { x: 600, y: 0 },
          data: {
            label: 'Unrelated',
            mediaType: 'text' as const,
            mode: 'generate' as const,
            modelAlias: 'text-model',
          },
        },
      ],
    };

    expect(() =>
      createNodeRunSnapshot(
        unrelatedSnapshot,
        createInitialWorkflowState(unrelatedSnapshot),
        'node_unrelated',
      ),
    ).toThrow('workflow node is outside the target execution closure: node_unrelated');
  });

  it('rejects a provider snapshot for a disabled upstream node', () => {
    const disabledSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) =>
        node.id === 'node_image' ? { ...node, data: { ...node.data, enabled: false } } : node,
      ),
    };

    expect(() =>
      createNodeRunSnapshot(
        disabledSnapshot,
        createInitialWorkflowState(disabledSnapshot),
        'node_image',
      ),
    ).toThrow('disabled workflow node cannot be executed: node_image');
  });

  it('uses the shared timestamp-independent fingerprint and exposes exact v1 compatibility', () => {
    const equivalent = {
      ...snapshot,
      submittedAt: '2026-08-27T00:01:00.000Z',
      parameters: {
        resolution: '1080p',
        prompt: 'only the final node receives this prompt',
      },
    };

    expect(workflowSnapshotFingerprint(equivalent)).toBe(workflowSnapshotFingerprint(snapshot));
    expect(workflowSnapshotFingerprintV1(equivalent)).not.toBe(
      workflowSnapshotFingerprintV1(snapshot),
    );
    expect(workflowSnapshotFingerprint(snapshot)).not.toBe(workflowSnapshotFingerprintV1(snapshot));
  });
});
