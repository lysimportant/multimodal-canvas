import { describe, expect, it } from 'vitest';

import {
  assetSchema,
  canonicalRunSnapshotJson,
  canTransitionRunStatus,
  canvasDocumentSchema,
  isCanvasNodeEnabled,
  mediaTypes,
  nodeModes,
  portRoles,
  runJobDataSchema,
  runSnapshotFingerprintMaterial,
  runSnapshotSchema,
  targetPortRolesForMediaType,
} from './index';

describe('canvas protocol', () => {
  it('exposes the supported media, modes, and port roles', () => {
    expect(mediaTypes).toEqual(['text', 'image', 'audio', 'video']);
    expect(nodeModes).toEqual(['source', 'generate', 'transform']);
    expect(portRoles).toContain('character');
    expect(targetPortRolesForMediaType('video')).toEqual(
      expect.arrayContaining(['prompt', 'character', 'firstFrame', 'lastFrame', 'audioTrack']),
    );
  });

  it('validates a minimal canvas document', () => {
    const document = canvasDocumentSchema.parse({
      revision: 0,
      nodes: [
        {
          id: 'node_text',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
        },
      ],
      edges: [],
    });

    expect(document.nodes).toHaveLength(1);
    // Legacy documents omit the new controls and retain their implicit defaults.
    expect(document.nodes[0].data.enabled).toBeUndefined();
    expect(document.nodes[0].width).toBeUndefined();
    expect(isCanvasNodeEnabled(document.nodes[0])).toBe(true);
  });

  it('accepts enabled state and user-resizable node dimensions', () => {
    const document = canvasDocumentSchema.parse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          width: 320,
          height: 240,
          data: { label: 'Image', mediaType: 'image', mode: 'generate', enabled: false },
        },
      ],
      edges: [],
    });

    expect(document.nodes[0]).toMatchObject({ width: 320, height: 240 });
    expect(document.nodes[0].data.enabled).toBe(false);
    expect(isCanvasNodeEnabled(document.nodes[0])).toBe(false);
  });

  it('rejects non-positive or unreasonably large node dimensions', () => {
    const base = {
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image' as const,
          position: { x: 0, y: 0 },
          data: { label: 'Image', mediaType: 'image' as const, mode: 'generate' as const },
        },
      ],
      edges: [],
    };

    expect(
      canvasDocumentSchema.safeParse({ ...base, nodes: [{ ...base.nodes[0], width: 0 }] }).success,
    ).toBe(false);
    expect(
      canvasDocumentSchema.safeParse({ ...base, nodes: [{ ...base.nodes[0], height: 10_001 }] })
        .success,
    ).toBe(false);
  });

  it('accepts node prompt, inference strength, and credential-bound model settings', () => {
    const document = canvasDocumentSchema.parse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Image',
            mediaType: 'image',
            mode: 'generate',
            prompt: 'A quiet mountain lake at dawn',
            inferenceStrength: 'high',
            modelAlias: 'image-studio-v2',
            credentialId: 'credential-image',
          },
        },
      ],
      edges: [],
    });

    expect(document.nodes[0].data.prompt).toBe('A quiet mountain lake at dawn');
    expect(document.nodes[0].data.inferenceStrength).toBe('high');
    expect(document.nodes[0].data.modelAlias).toBe('image-studio-v2');
    expect(document.nodes[0].data.credentialId).toBe('credential-image');
  });

  it('preserves optional node prompt and inference strength settings', () => {
    const node = canvasDocumentSchema.parse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Generate',
            mediaType: 'image',
            mode: 'generate',
            prompt: '  A cinematic portrait  ',
            inferenceStrength: 'high',
          },
        },
      ],
      edges: [],
    }).nodes[0];

    expect(node.data.prompt).toBe('A cinematic portrait');
    expect(node.data.inferenceStrength).toBe('high');
  });

  it('preserves optional media generation parameters on image and video nodes', () => {
    const document = canvasDocumentSchema.parse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Image',
            mediaType: 'image',
            mode: 'generate',
            parameters: { size: '1536x1024', quality: 'high' },
          },
        },
        {
          id: 'node_video',
          type: 'video',
          position: { x: 100, y: 0 },
          data: {
            label: 'Video',
            mediaType: 'video',
            mode: 'generate',
            parameters: { resolution: '1080p', quality: 'high', duration: 8 },
          },
        },
      ],
      edges: [],
    });

    expect(document.nodes[0].data.parameters).toMatchObject({ size: '1536x1024', quality: 'high' });
    expect(document.nodes[1].data.parameters).toMatchObject({ resolution: '1080p', duration: 8 });
  });

  it('rejects invalid node prompt and empty inference strength settings', () => {
    const invalidPrompt = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Generate',
            mediaType: 'image',
            mode: 'generate',
            prompt: 'x'.repeat(20_001),
          },
        },
      ],
      edges: [],
    });
    const dynamicStrength = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Generate',
            mediaType: 'image',
            mode: 'generate',
            inferenceStrength: 'xhigh',
          },
        },
      ],
      edges: [],
    });
    const invalidStrength = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Generate',
            mediaType: 'image',
            mode: 'generate',
            inferenceStrength: '   ',
          },
        },
      ],
      edges: [],
    });

    expect(invalidPrompt.success).toBe(false);
    expect(dynamicStrength.success).toBe(true);
    expect(invalidStrength.success).toBe(false);
  });

  it('validates an uploaded asset reference', () => {
    const asset = assetSchema.parse({
      id: 'asset_image',
      name: 'reference.png',
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: 128,
      status: 'ready',
      contentUrl: '/v1/assets/asset_image/content',
    });

    expect(asset.mediaType).toBe('image');
  });

  it('accepts compatible reference inputs and rejects cycles', () => {
    const valid = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_prompt',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
        },
        {
          id: 'node_image',
          type: 'image',
          position: { x: 200, y: 0 },
          data: { label: 'Image', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [
        {
          id: 'edge_prompt',
          sourceNodeId: 'node_prompt',
          sourceHandle: 'output:text',
          targetNodeId: 'node_image',
          targetHandle: 'input:prompt',
          order: 0,
        },
      ],
    });
    expect(valid.success).toBe(true);

    const cyclic = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_a',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'A', mediaType: 'text', mode: 'source' },
        },
        {
          id: 'node_b',
          type: 'text',
          position: { x: 200, y: 0 },
          data: { label: 'B', mediaType: 'text', mode: 'transform' },
        },
      ],
      edges: [
        {
          id: 'edge_ab',
          sourceNodeId: 'node_a',
          sourceHandle: 'output:text',
          targetNodeId: 'node_b',
          targetHandle: 'input:content',
          order: 0,
        },
        {
          id: 'edge_ba',
          sourceNodeId: 'node_b',
          sourceHandle: 'output:text',
          targetNodeId: 'node_a',
          targetHandle: 'input:content',
          order: 0,
        },
      ],
    });
    expect(cyclic.success).toBe(false);
    if (!cyclic.success)
      expect(cyclic.error.issues).toContainEqual(
        expect.objectContaining({ message: 'canvas graph must be acyclic' }),
      );
  });

  it('rejects incompatible reference inputs', () => {
    const result = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_audio',
          type: 'audio',
          position: { x: 0, y: 0 },
          data: { label: 'Audio', mediaType: 'audio', mode: 'source' },
        },
        {
          id: 'node_image',
          type: 'image',
          position: { x: 200, y: 0 },
          data: { label: 'Image', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [
        {
          id: 'edge_audio_style',
          sourceNodeId: 'node_audio',
          sourceHandle: 'output:audio',
          targetNodeId: 'node_image',
          targetHandle: 'input:style',
          order: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects connections into source nodes', () => {
    const result = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_prompt',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
        },
        {
          id: 'node_source_image',
          type: 'image',
          position: { x: 200, y: 0 },
          data: { label: 'Reference', mediaType: 'image', mode: 'source' },
        },
      ],
      edges: [
        {
          id: 'edge_invalid_target',
          sourceNodeId: 'node_prompt',
          sourceHandle: 'output:text',
          targetNodeId: 'node_source_image',
          targetHandle: 'input:content',
          order: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('validates an immutable run snapshot and its status transitions', () => {
    const snapshot = runSnapshotSchema.parse({
      projectId: 'project_1',
      canvasRevision: 3,
      targetNodeId: 'node_image',
      modelAlias: 'mock-image',
      parameters: {},
      submittedAt: '2026-08-24T00:00:00.000Z',
      nodes: [
        {
          id: 'node_prompt',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
        },
        {
          id: 'node_image',
          type: 'image',
          position: { x: 200, y: 0 },
          data: { label: 'Generate', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [
        {
          id: 'edge_prompt',
          sourceNodeId: 'node_prompt',
          sourceHandle: 'output:text',
          targetNodeId: 'node_image',
          targetHandle: 'input:prompt',
          order: 0,
        },
      ],
      inputs: [
        {
          nodeId: 'node_prompt',
          role: 'prompt',
          sortOrder: 0,
          snapshot: {
            id: 'node_prompt',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
          },
        },
      ],
    });

    expect(snapshot.canvasRevision).toBe(3);
    expect(canTransitionRunStatus('queued', 'preparing')).toBe(true);
    expect(canTransitionRunStatus('succeeded', 'running')).toBe(false);
  });

  it('canonicalizes run identity independently of timestamp and object key order', () => {
    const base = runSnapshotSchema.parse({
      projectId: 'project_1',
      canvasRevision: 3,
      targetNodeId: 'node_image',
      modelAlias: 'mock-image',
      parameters: {
        nested: { first: 'one', second: 'two' },
        list: ['first', 'second'],
      },
      submittedAt: '2026-08-24T00:00:00.000Z',
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { label: 'Generate', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [],
      inputs: [],
    });
    const equivalent = runSnapshotSchema.parse({
      ...base,
      submittedAt: '2026-08-24T00:01:00.000Z',
      parameters: {
        list: ['first', 'second'],
        nested: { second: 'two', first: 'one' },
      },
    });
    const changed = runSnapshotSchema.parse({
      ...equivalent,
      parameters: {
        ...equivalent.parameters,
        list: ['second', 'first'],
      },
    });

    expect(canonicalRunSnapshotJson(equivalent)).toBe(canonicalRunSnapshotJson(base));
    expect(canonicalRunSnapshotJson(changed)).not.toBe(canonicalRunSnapshotJson(base));
    expect(runSnapshotFingerprintMaterial(equivalent)).toBe(
      `multimodal-canvas:run-snapshot:v2:${canonicalRunSnapshotJson(base)}`,
    );
  });

  it('preserves whether node credential references were omitted or explicitly provided', () => {
    const base = {
      projectId: 'project_1',
      canvasRevision: 3,
      targetNodeId: 'node_image',
      modelAlias: 'mock-image',
      credentialId: 'credential-image',
      credentialVersion: 2,
      parameters: {},
      submittedAt: '2026-08-24T00:00:00.000Z',
      nodes: [
        {
          id: 'node_image',
          type: 'image' as const,
          position: { x: 0, y: 0 },
          data: { label: 'Generate', mediaType: 'image' as const, mode: 'generate' as const },
        },
      ],
      edges: [],
      inputs: [],
    };

    const legacySnapshot = runSnapshotSchema.parse(base);
    const emptyMappedSnapshot = runSnapshotSchema.parse({
      ...base,
      nodeCredentialReferences: {},
    });
    const mappedSnapshot = runSnapshotSchema.parse({
      ...base,
      nodeCredentialReferences: {
        node_image: { credentialId: 'credential-image', credentialVersion: 2 },
      },
    });

    expect(legacySnapshot.nodeCredentialReferences).toBeUndefined();
    expect(emptyMappedSnapshot.nodeCredentialReferences).toEqual({});
    expect(mappedSnapshot.nodeCredentialReferences).toEqual({
      node_image: { credentialId: 'credential-image', credentialVersion: 2 },
    });
  });

  it('defaults a queued job to an active cancellation flag of false', () => {
    const result = runJobDataSchema.parse({
      runId: 'run_1',
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 0,
        targetNodeId: 'node_image',
        modelAlias: 'mock-image',
        parameters: {},
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Generate', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
      attempt: 1,
    });

    expect(result.cancelRequested).toBe(false);
    expect(result.provider).toBe('mock');
  });

  it('revalidates graph integrity and input references at the run boundary', () => {
    const base = {
      projectId: 'project_1',
      canvasRevision: 1,
      targetNodeId: 'node_image',
      modelAlias: 'mock-image',
      parameters: {},
      submittedAt: '2026-08-24T00:00:00.000Z',
      nodes: [
        {
          id: 'node_image',
          type: 'image' as const,
          position: { x: 0, y: 0 },
          data: { label: 'Generate', mediaType: 'image' as const, mode: 'generate' as const },
        },
      ],
      edges: [],
      inputs: [],
    };

    expect(
      runSnapshotSchema.safeParse({
        ...base,
        edges: [
          {
            id: 'edge_missing',
            sourceNodeId: 'node_missing',
            sourceHandle: 'output:text',
            targetNodeId: 'node_image',
            targetHandle: 'input:prompt',
            order: 0,
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      runSnapshotSchema.safeParse({
        ...base,
        inputs: [
          {
            nodeId: 'node_missing',
            role: 'prompt',
            sortOrder: 0,
            snapshot: base.nodes[0],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('persists resumable node-level workflow state alongside a frozen run snapshot', () => {
    const job = runJobDataSchema.parse({
      runId: 'run_workflow_1',
      attempt: 1,
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_image',
        modelAlias: 'mock-image',
        parameters: {},
        submittedAt: '2026-08-27T00:00:00.000Z',
        nodes: [
          {
            id: 'node_prompt',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
          },
          {
            id: 'node_image',
            type: 'image',
            position: { x: 200, y: 0 },
            data: { label: 'Image', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [
          {
            id: 'edge_prompt',
            sourceNodeId: 'node_prompt',
            sourceHandle: 'output:text',
            targetNodeId: 'node_image',
            targetHandle: 'input:prompt',
            order: 0,
          },
        ],
        inputs: [
          {
            nodeId: 'node_prompt',
            role: 'prompt',
            sortOrder: 0,
            snapshot: {
              id: 'node_prompt',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
            },
          },
        ],
      },
      workflowState: {
        nodes: [
          {
            nodeId: 'node_prompt',
            status: 'succeeded',
            result: {
              provider: 'source',
              summary: 'source ready',
              targetNodeId: 'node_prompt',
              mediaType: 'text',
              inputCount: 0,
            },
          },
          {
            nodeId: 'node_image',
            status: 'pending',
          },
        ],
      },
    });

    expect(job.workflowState?.nodes[0]).toMatchObject({
      nodeId: 'node_prompt',
      status: 'succeeded',
    });
  });

  it('rejects workflow state that cannot be safely applied to its snapshot', () => {
    const parse = runJobDataSchema.safeParse({
      runId: 'run_workflow_invalid',
      attempt: 1,
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 1,
        targetNodeId: 'node_image',
        modelAlias: 'mock-image',
        parameters: {},
        submittedAt: '2026-08-27T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Image', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
      workflowState: {
        nodes: [
          { nodeId: 'node_missing', status: 'pending' },
          { nodeId: 'node_image', status: 'succeeded' },
        ],
      },
    });

    expect(parse.success).toBe(false);
  });
});
