import { describe, expect, it } from 'vitest';

import {
  assetSchema,
  canonicalRunSnapshotJson,
  canTransitionRunStatus,
  canvasDocumentSchema,
  nodeModeSchema,
  isCanvasNodeEnabled,
  getEffectivePromptDocument,
  mediaTypes,
  nodeModes,
  portRoles,
  collectVideoInputSet,
  inferVideoOperation,
  precheckVideoGenerationInputs,
  resolveVideoCompletionAction,
  canvasNodeSchema,
  displayVideoMode,
  inferVideoModeFromRoles,
  isPortConnectionAllowed,
  targetPortRolesForNode,
  implementedVideoModes,
  videoFamilyForModel,
  videoImageRolesForMode,
  videoModeCapability,
  videoModes,
  unabsorbedVideoPromptMentions,
  videoInputRoleForPromptMention,
  videoModeForPromptMentions,
  promptDocumentSchema,
  renderPromptDocument,
  mentionDisplayName,
  uniqueResourceDisplayName,
  defaultResourceDisplayName,
  runJobDataSchema,
  runSnapshotFingerprintMaterial,
  runSnapshotSchema,
  targetPortRolesForMediaType,
  imageEditCapability,
  imageEditSourceOf,
  isImageEditSourceNode,
  nodeHasEcho,
} from './index';

describe('canvas protocol', () => {
  it('exposes the supported media, modes, and port roles', () => {
    expect(mediaTypes).toEqual(['text', 'image', 'audio', 'video']);
    expect(nodeModes).toEqual(['source', 'generate']);
    expect(portRoles).toContain('character');
    expect(portRoles).toContain('referenceImage');
    expect(targetPortRolesForMediaType('video')).toEqual(
      expect.arrayContaining([
        'prompt',
        'character',
        'referenceImage',
        'firstFrame',
        'lastFrame',
        'audioTrack',
      ]),
    );
  });

  it('把历史转换节点读成生成节点', () => {
    expect(nodeModeSchema.parse('transform')).toBe('generate');
    expect(nodeModeSchema.parse('generate')).toBe('generate');
  });

  describe('图片编辑语义', () => {
    const generateImageNode = (data: Record<string, unknown> = {}) => ({
      id: 'node_edit',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { label: '修改图', mediaType: 'image', mode: 'generate', ...data },
    });

    it('校验版本化来源引用并在缺省时兼容旧画布', () => {
      expect(targetPortRolesForMediaType('image')).toContain('imageEdit');
      expect(targetPortRolesForMediaType('text')).not.toContain('imageEdit');
      expect(portRoles).toContain('imageEdit');

      const parsed = canvasNodeSchema.parse(
        generateImageNode({
          imageEditSource: {
            sourceNodeId: 'node_source',
            assetId: 'asset_1',
            version: 3,
            sourceKind: 'result',
          },
        }),
      );
      expect(parsed.data.imageEditSource).toEqual({
        sourceNodeId: 'node_source',
        assetId: 'asset_1',
        version: 3,
        sourceKind: 'result',
      });

      // 旧画布没有编辑字段时仍是普通图片生成节点。
      const legacy = canvasNodeSchema.parse(generateImageNode());
      expect(legacy.data.imageEditSource).toBeUndefined();
      expect(imageEditSourceOf(legacy.data)).toBeUndefined();
    });

    it('拒绝缺少来源身份或非法版本的编辑字段', () => {
      expect(
        canvasNodeSchema.safeParse(
          generateImageNode({ imageEditSource: { assetId: 'asset_1', version: 1 } }),
        ).success,
      ).toBe(false);
      expect(
        canvasNodeSchema.safeParse(
          generateImageNode({ imageEditSource: { sourceNodeId: 'a', assetId: 'b', version: 0 } }),
        ).success,
      ).toBe(false);
      expect(
        canvasNodeSchema.safeParse(
          generateImageNode({
            imageEditSource: { sourceNodeId: 'a', assetId: 'b', version: 1.5 },
          }),
        ).success,
      ).toBe(false);
      // 读取非法字段时不猜测语义，直接视为普通生成节点。
      expect(imageEditSourceOf({ imageEditSource: { assetId: 'x' } })).toBeUndefined();
    });

    it('只允许图片生成节点接收编辑原图，并保持单向输入', () => {
      const source = canvasNodeSchema.parse({
        id: 'node_source',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { label: '原图', mediaType: 'image', mode: 'source', assetId: 'asset_1' },
      });
      const textSource = canvasNodeSchema.parse({
        id: 'node_text',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { label: '文字', mediaType: 'text', mode: 'source' },
      });
      const editNode = canvasNodeSchema.parse(generateImageNode());

      expect(isPortConnectionAllowed(source, 'output:image', editNode, 'input:imageEdit')).toBe(
        true,
      );
      expect(isPortConnectionAllowed(textSource, 'output:text', editNode, 'input:imageEdit')).toBe(
        false,
      );

      const sourceTarget = canvasNodeSchema.parse({
        id: 'node_other',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { label: '来源', mediaType: 'image', mode: 'source' },
      });
      expect(isPortConnectionAllowed(source, 'output:image', sourceTarget, 'input:imageEdit')).toBe(
        false,
      );
    });

    it('判断节点是否已有可修改的图片内容', () => {
      expect(
        isImageEditSourceNode({ data: { mediaType: 'image', assetId: 'a', contentUrl: '/c' } }),
      ).toBe(true);
      expect(
        isImageEditSourceNode({ data: { mediaType: 'image', resultAsset: { assetId: 'r' } } }),
      ).toBe(true);
      expect(isImageEditSourceNode({ data: { mediaType: 'image' } })).toBe(false);
      expect(
        isImageEditSourceNode({ data: { mediaType: 'video', assetId: 'a', contentUrl: '/c' } }),
      ).toBe(false);
    });

    it('判断任意媒体类型节点是否已有回显', () => {
      expect(nodeHasEcho({ mediaType: 'text', resultAsset: { assetId: 't' } })).toBe(true);
      expect(nodeHasEcho({ data: { mediaType: 'audio', assetId: 'a', contentUrl: '/c' } })).toBe(
        true,
      );
      expect(nodeHasEcho({ mediaType: 'video' })).toBe(false);
      expect(nodeHasEcho({ assetId: 'a' })).toBe(false);
    });

    it('区分图片编辑能力未知、明确禁用和正向限制', () => {
      expect(imageEditCapability(undefined)).toEqual({ declared: false });
      expect(imageEditCapability({ capabilities: {} })).toEqual({ declared: false });
      expect(imageEditCapability({ capabilities: { imageEdit: false } })).toEqual({
        declared: false,
        unsupported: true,
      });
      expect(imageEditCapability({ capabilities: { imageEdit: { supported: false } } })).toEqual({
        declared: false,
        unsupported: true,
      });
      expect(
        imageEditCapability({ capabilities: { supportsImageEdit: { supports: false } } }),
      ).toEqual({
        declared: false,
        unsupported: true,
      });
      expect(imageEditCapability({ capabilities: { imageEdit: {} } })).toEqual({ declared: false });
      expect(imageEditCapability({ capabilities: { image_edit: true } })).toEqual({
        declared: true,
      });
      expect(
        imageEditCapability({
          capabilities: {
            imageEdit: {
              supported: true,
              mimeTypes: ['image/png', 'image/jpeg'],
              sizes: ['1024x1024'],
              parameters: ['size', 'quality'],
            },
          },
        }),
      ).toEqual({
        declared: true,
        mimeTypes: ['image/png', 'image/jpeg'],
        sizes: ['1024x1024'],
        parameters: ['size', 'quality'],
      });
    });
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

  it('preserves manual output identity without changing the generation mode', () => {
    const document = canvasDocumentSchema.parse({
      revision: 2,
      nodes: [
        {
          id: 'manual',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: 'Manual text',
            mediaType: 'text',
            mode: 'generate',
            manualOutput: true,
            manualOutputRunId: 'run_explicit',
            assetId: 'asset_manual',
            contentUrl: '/v1/assets/asset_manual/content',
            mimeType: 'text/plain',
          },
        },
      ],
      edges: [],
    });
    expect(document.nodes[0].data).toMatchObject({
      mode: 'generate',
      manualOutput: true,
      manualOutputRunId: 'run_explicit',
      assetId: 'asset_manual',
    });
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

  it('validates versioned prompt documents and preserves mention order and bindings', () => {
    const document = promptDocumentSchema.parse({
      version: 1,
      blocks: [
        { type: 'text', text: '把 ' },
        {
          type: 'mention',
          mentionId: 'mention-product',
          assetId: 'asset-product',
          label: '产品图',
          mediaType: 'image',
          binding: { entityName: '产品', semanticRole: 'style', scope: 'node', future: 'keep' },
        },
        { type: 'text', text: ' 放在场景中' },
      ],
    });

    expect(renderPromptDocument(document)).toBe('把 产品 放在场景中');
    expect(mentionDisplayName({ label: 'hero.png', entityName: '满穗' })).toBe('满穗');
    expect(uniqueResourceDisplayName('满穗.png', ['满穗'])).toBe('满穗2');
    expect(defaultResourceDisplayName('满穗.png')).toBe('满穗');
    expect(defaultResourceDisplayName('2.mp4')).toBe('2.mp4');
    expect(defaultResourceDisplayName('3.txt')).toBe('3.txt');
    expect(defaultResourceDisplayName('12.png')).toBe('12.png');
    expect(defaultResourceDisplayName('hero.png')).toBe('hero');
    expect(document.blocks[1]).toMatchObject({
      type: 'mention',
      mentionId: 'mention-product',
      binding: { entityName: '产品', future: 'keep' },
    });
  });

  it('rejects empty documents, duplicate mention ids, and invalid mention fields', () => {
    const base = { version: 1 as const, blocks: [{ type: 'text' as const, text: '' }] };
    expect(promptDocumentSchema.safeParse({ ...base, blocks: [] }).success).toBe(false);
    expect(
      promptDocumentSchema.safeParse({
        version: 1,
        blocks: [
          { type: 'mention', mentionId: 'same', assetId: 'a', label: 'A', mediaType: 'image' },
          { type: 'mention', mentionId: 'same', assetId: 'b', label: 'B', mediaType: 'audio' },
        ],
      }).success,
    ).toBe(false);
    expect(
      promptDocumentSchema.safeParse({
        version: 1,
        blocks: [{ type: 'mention', mentionId: 'm', assetId: '', label: 'A', mediaType: 'image' }],
      }).success,
    ).toBe(false);
    expect(
      promptDocumentSchema.safeParse({
        version: 1,
        blocks: [{ type: 'mention', mentionId: 'm', assetId: 'a', label: 'A', mediaType: 'model' }],
      }).success,
    ).toBe(false);
    expect(
      promptDocumentSchema.safeParse({
        version: 1,
        blocks: [
          {
            type: 'mention',
            mentionId: 'placeholder-reason-only',
            assetId: 'asset-a',
            label: 'A',
            mediaType: 'image',
            placeholderReason: 'not_found',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('strips provider-only fields while retaining safe forward-compatible binding fields', () => {
    const parsed = promptDocumentSchema.parse({
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'm-safe',
          assetId: 'asset-a',
          label: 'A',
          mediaType: 'image',
          contentUrl: 'https://signed.example/a?signature=secret',
          apiKey: 'must-not-persist',
          localPath: 'C:\\private\\a.png',
          binding: {
            entityName: '角色',
            futureRole: 'appearance',
            apiKey: 'binding-secret',
            contentUrl: 'https://signed.example.invalid/binding',
            localPath: 'C:\\private\\binding.png',
          },
        },
      ],
      apiKey: 'document-secret',
    });

    const mention = parsed.blocks[0];
    expect(mention).not.toHaveProperty('contentUrl');
    expect(mention).not.toHaveProperty('apiKey');
    expect(mention).not.toHaveProperty('localPath');
    expect(parsed).not.toHaveProperty('apiKey');
    expect(mention).toMatchObject({
      type: 'mention',
      binding: { entityName: '角色', futureRole: 'appearance' },
    });
    if (mention.type === 'mention') {
      expect(mention.binding).not.toHaveProperty('apiKey');
      expect(mention.binding).not.toHaveProperty('contentUrl');
      expect(mention.binding).not.toHaveProperty('localPath');
    }
  });

  it('uses promptDocument before the legacy prompt and adapts legacy prompts', () => {
    const document = { version: 1 as const, blocks: [{ type: 'text' as const, text: 'new text' }] };
    expect(getEffectivePromptDocument({ prompt: 'old text', promptDocument: document })).toEqual(
      document,
    );
    expect(getEffectivePromptDocument({ prompt: 'old text' })).toEqual({
      version: 1,
      blocks: [{ type: 'text', text: 'old text' }],
    });
  });

  it('validates an uploaded asset reference', () => {
    const asset = assetSchema.parse({
      id: 'asset_image',
      name: 'reference.png',
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: 128,
      latestVersion: 3,
      status: 'ready',
      contentUrl: '/v1/assets/asset_image/content',
    });

    expect(asset.mediaType).toBe('image');
    expect(asset.latestVersion).toBe(3);
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
    expect(
      runSnapshotSchema.parse({
        ...snapshot,
        nodeImageEditCapabilities: { node_image: { declared: true, mimeTypes: ['image/png'] } },
      }).nodeImageEditCapabilities,
    ).toEqual({
      node_image: { declared: true, mimeTypes: ['image/png'] },
    });
    for (const nodeId of ['node_missing', 'node_prompt']) {
      expect(
        runSnapshotSchema.safeParse({
          ...snapshot,
          nodeImageEditCapabilities: { [nodeId]: { declared: true } },
        }).success,
      ).toBe(false);
    }
    expect(canTransitionRunStatus('queued', 'preparing')).toBe(true);
    expect(canTransitionRunStatus('succeeded', 'running')).toBe(false);
  });

  it('validates frozen prompt mentions against snapshot nodes and uniqueness', () => {
    const base = {
      projectId: 'project_frozen_mentions',
      canvasRevision: 1,
      targetNodeId: 'node_image',
      modelAlias: 'mock-image',
      parameters: {},
      submittedAt: '2026-08-24T00:00:00.000Z',
      nodes: [
        {
          id: 'node_image' as const,
          type: 'image' as const,
          position: { x: 0, y: 0 },
          data: {
            label: 'Image',
            mediaType: 'image' as const,
            mode: 'generate' as const,
          },
        },
      ],
      edges: [],
      inputs: [],
    };
    const frozen = runSnapshotSchema.parse({
      ...base,
      promptMentions: [
        {
          nodeId: 'node_image',
          mentionId: 'm-1',
          assetId: 'asset-image',
          assetVersion: 2,
          mediaType: 'image',
          label: '产品图',
          blockOrder: 1,
          binding: { entityName: '产品', semanticRole: 'appearance' },
        },
        {
          nodeId: 'node_image',
          mentionId: 'm-2',
          assetId: 'asset-image',
          assetVersion: 2,
          mediaType: 'image',
          label: '产品图',
          blockOrder: 3,
        },
      ],
    });
    expect(frozen.promptMentions?.map((mention) => mention.mentionId)).toEqual(['m-1', 'm-2']);
    expect(
      runSnapshotSchema.safeParse({
        ...base,
        promptMentions: [
          { ...frozen.promptMentions![0], mentionId: 'duplicate' },
          { ...frozen.promptMentions![1], mentionId: 'duplicate' },
        ],
      }).success,
    ).toBe(false);
    expect(
      runSnapshotSchema.safeParse({
        ...base,
        promptMentions: [{ ...frozen.promptMentions![0], nodeId: 'missing-node' }],
      }).success,
    ).toBe(false);
    expect(
      runSnapshotSchema.safeParse({
        ...base,
        promptMentions: [
          { ...frozen.promptMentions![0], mentionId: 'm-order-a', blockOrder: 3 },
          { ...frozen.promptMentions![1], mentionId: 'm-order-b', blockOrder: 1 },
        ],
      }).success,
    ).toBe(false);
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

function videoInput(
  id: string,
  role: (typeof portRoles)[number],
  sortOrder: number,
  mediaType: 'text' | 'image' | 'audio' | 'video' = 'image',
) {
  return {
    nodeId: id,
    role,
    sortOrder,
    snapshot: {
      id,
      type: mediaType,
      position: { x: 0, y: 0 },
      data: {
        label: id,
        mediaType,
        mode: 'source' as const,
        ...(mediaType === 'text'
          ? { prompt: `${role} value` }
          : { contentUrl: `https://assets.example/${id}` }),
      },
    },
  };
}

describe('video input set', () => {
  it('keeps repeatable reference roles in connection order', () => {
    const { inputSet, issues } = collectVideoInputSet([
      videoInput('char-b', 'character', 2),
      videoInput('style-a', 'style', 1),
      videoInput('ref-c', 'referenceImage', 4),
      videoInput('char-a', 'character', 0),
      videoInput('ref-a', 'referenceImage', 3),
      videoInput('style-b', 'style', 5),
    ]);

    expect(issues).toEqual([]);
    expect(inputSet.character.map((input) => input.nodeId)).toEqual(['char-a', 'char-b']);
    expect(inputSet.style.map((input) => input.nodeId)).toEqual(['style-a', 'style-b']);
    expect(inputSet.referenceImage.map((input) => input.nodeId)).toEqual(['ref-a', 'ref-c']);
    expect(inferVideoOperation(inputSet)).toBe('reference_guided');
  });

  it('maps image content to firstFrame and video content to fusion content', () => {
    const { inputSet, issues } = collectVideoInputSet([
      videoInput('prompt', 'prompt', 0, 'text'),
      videoInput('still', 'content', 1, 'image'),
      videoInput('clip', 'content', 2, 'video'),
    ]);

    expect(issues).toEqual([]);
    expect(inputSet.prompt?.nodeId).toBe('prompt');
    expect(inputSet.firstFrame?.nodeId).toBe('still');
    expect(inputSet.content.map((input) => input.nodeId)).toEqual(['clip']);
    expect(inferVideoOperation(inputSet)).toBe('omni_reference');
  });

  it('rejects unconfirmed live roles before a provider request would be created', () => {
    const precheck = precheckVideoGenerationInputs([
      videoInput('prompt', 'prompt', 0, 'text'),
      videoInput('first', 'firstFrame', 1),
      videoInput('last', 'lastFrame', 2),
      videoInput('hero', 'character', 3),
      videoInput('look', 'style', 4),
      videoInput('prop', 'referenceImage', 5),
    ]);

    expect(precheck.operation).toBe('omni_reference');
    expect(precheck.inputSet.referenceImage).toHaveLength(1);
    expect(precheck.issues.map((issue) => issue.role)).toEqual([
      'lastFrame',
      'character',
      'style',
      'referenceImage',
    ]);
    expect(precheck.issues.every((issue) => issue.code === 'UNSUPPORTED_INPUT_ROLE')).toBe(true);
  });

  it('keeps legacy Grok frame and reference requests compatible without an explicit mode', () => {
    const precheck = precheckVideoGenerationInputs(
      [
        videoInput('prompt', 'prompt', 0, 'text'),
        videoInput('first', 'firstFrame', 1),
        videoInput('last', 'lastFrame', 2),
        videoInput('hero', 'character', 3),
        videoInput('look', 'style', 4),
        videoInput('prop', 'referenceImage', 5),
      ],
      { modelAlias: 'grok-imagine-video-1.5.1', parameters: { resolution: '720p' } },
    );
    expect(precheck.operation).toBe('omni_reference');
    expect(precheck.issues).toEqual([]);
    expect(precheck.inputSet.referenceImage).toHaveLength(1);
  });

  it('rejects grok-imagine-video-1.5 reference or last-frame requests above 720p', () => {
    const precheck = precheckVideoGenerationInputs(
      [videoInput('prompt', 'prompt', 0, 'text'), videoInput('prop', 'referenceImage', 1)],
      { modelAlias: 'grok-imagine-video-1.5.1', parameters: { resolution: '1080p' } },
    );
    expect(precheck.issues).toEqual([
      {
        code: 'UNSUPPORTED_INPUT_COMBINATION',
        message: 'grok-imagine-video-1.5 的参考图或尾帧合同最高 720p',
      },
    ]);
  });

  it('reports duplicate first frames instead of keeping only the first image', () => {
    const { issues } = collectVideoInputSet([
      videoInput('frame-a', 'firstFrame', 0),
      videoInput('frame-b', 'firstFrame', 1),
    ]);
    expect(issues).toEqual([
      {
        code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
        role: 'firstFrame',
        message: 'New API video 不支持该输入角色的多个值：firstFrame',
      },
    ]);
  });

  it('keeps omitted videoMode on the legacy allowlist so old canvases still load', () => {
    const precheck = precheckVideoGenerationInputs(
      [videoInput('prompt', 'prompt', 0, 'text'), videoInput('first', 'firstFrame', 1)],
      { modelAlias: 'sora-2' },
    );
    expect(precheck.operation).toBe('image_to_video');
    expect(precheck.issues).toEqual([]);
  });

  it('maps omni image content to reference images instead of first frame', () => {
    const { inputSet, issues } = collectVideoInputSet(
      [
        videoInput('prompt', 'prompt', 0, 'text'),
        videoInput('still', 'content', 1, 'image'),
        videoInput('clip', 'content', 2, 'video'),
      ],
      'omni_reference',
    );
    expect(issues).toEqual([]);
    expect(inputSet.firstFrame).toBeUndefined();
    expect(inputSet.referenceImage.map((input) => input.nodeId)).toEqual(['still']);
    expect(inputSet.content.map((input) => input.nodeId)).toEqual(['clip']);
  });

  it('requires first and last frames in first_last_frame mode', () => {
    const precheck = precheckVideoGenerationInputs(
      [videoInput('prompt', 'prompt', 0, 'text'), videoInput('first', 'firstFrame', 1)],
      { modelAlias: 'grok-imagine-video-1.5.1', videoMode: 'first_last_frame' },
    );
    expect(precheck.operation).toBe('first_last_frame');
    expect(precheck.issues).toEqual([
      {
        code: 'UNSUPPORTED_INPUT_COMBINATION',
        role: 'lastFrame',
        message: '首尾帧模式需要同时连接首帧和尾帧',
      },
    ]);
  });

  it('rejects first frame in omni mode even on grok-imagine-video-1.5', () => {
    const precheck = precheckVideoGenerationInputs(
      [
        videoInput('prompt', 'prompt', 0, 'text'),
        videoInput('first', 'firstFrame', 1),
        videoInput('prop', 'referenceImage', 2),
      ],
      {
        modelAlias: 'grok-imagine-video-1.5.1',
        videoMode: 'omni_reference',
        parameters: { resolution: '720p' },
      },
    );
    expect(precheck.operation).toBe('omni_reference');
    expect(precheck.issues.map((issue) => issue.role)).toEqual(['firstFrame']);
  });

  it('allows grok-imagine-video-1.5 omni reference images without pinning a first frame', () => {
    const precheck = precheckVideoGenerationInputs(
      [videoInput('prompt', 'prompt', 0, 'text'), videoInput('prop', 'referenceImage', 1)],
      {
        modelAlias: 'grok-imagine-video-1.5.1',
        videoMode: 'omni_reference',
        parameters: { resolution: '720p' },
      },
    );
    expect(precheck.issues).toEqual([]);
    expect(precheck.operation).toBe('omni_reference');
  });

  it('fail-closes unmapped omni reference on unknown models before a POST', () => {
    const precheck = precheckVideoGenerationInputs(
      [videoInput('prompt', 'prompt', 0, 'text'), videoInput('prop', 'referenceImage', 1)],
      { modelAlias: 'sora-2', videoMode: 'omni_reference' },
    );
    expect(precheck.issues).toEqual([
      {
        code: 'UNSUPPORTED_INPUT_COMBINATION',
        message: '该模型的全能参考尚未接通 New API 字段映射，不能发起真实请求',
      },
    ]);
  });

  it('rejects text_to_video media inputs and keeps first_frame required', () => {
    const textOnly = precheckVideoGenerationInputs(
      [videoInput('prompt', 'prompt', 0, 'text'), videoInput('first', 'firstFrame', 1)],
      { videoMode: 'text_to_video' },
    );
    expect(textOnly.issues.some((issue) => issue.role === 'firstFrame')).toBe(true);

    const missingFirst = precheckVideoGenerationInputs(
      [videoInput('prompt', 'prompt', 0, 'text')],
      { videoMode: 'first_frame' },
    );
    expect(missingFirst.issues).toEqual([
      {
        code: 'UNSUPPORTED_INPUT_COMBINATION',
        role: 'firstFrame',
        message: '首帧模式需要连接一张首帧图',
      },
    ]);
  });

  it.each([
    'minimax-h3',
    'wan3.0-video',
    'wan3.0-video-prime',
    'doubao-seedance-2-0-fast-260128',
    'doubao-seedance-2-5-260628',
  ])('supports all four generation modes for official model %s', (modelAlias) => {
    const cases = [
      {
        mode: 'text_to_video' as const,
        inputs: [videoInput('prompt', 'prompt', 0, 'text')],
      },
      {
        mode: 'first_frame' as const,
        inputs: [videoInput('prompt', 'prompt', 0, 'text'), videoInput('first', 'firstFrame', 1)],
      },
      {
        mode: 'first_last_frame' as const,
        inputs: [
          videoInput('prompt', 'prompt', 0, 'text'),
          videoInput('first', 'firstFrame', 1),
          videoInput('last', 'lastFrame', 2),
        ],
      },
      {
        mode: 'omni_reference' as const,
        inputs: [
          videoInput('prompt', 'prompt', 0, 'text'),
          videoInput('hero', 'character', 1),
          videoInput('look', 'style', 2),
          videoInput('prop', 'referenceImage', 3),
          videoInput('clip', 'content', 4, 'video'),
          videoInput('sound', 'audioTrack', 5, 'audio'),
        ],
      },
    ];

    for (const { mode, inputs } of cases) {
      const precheck = precheckVideoGenerationInputs(inputs, { modelAlias, videoMode: mode });
      expect(precheck.issues, `${modelAlias} ${mode}`).toEqual([]);
    }
  });

  it.each(['wan3.0-video', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628'])(
    'supports edit and extend references for official model %s',
    (modelAlias) => {
      for (const videoMode of ['video_edit', 'video_extend'] as const) {
        const precheck = precheckVideoGenerationInputs(
          [
            videoInput('prompt', 'prompt', 0, 'text'),
            videoInput('still', 'content', 1),
            videoInput('clip', 'content', 2, 'video'),
            videoInput('sound', 'content', 3, 'audio'),
          ],
          { modelAlias, videoMode },
        );
        expect(precheck.issues, `${modelAlias} ${videoMode}`).toEqual([]);
        expect(precheck.inputSet.referenceImage.map((input) => input.nodeId)).toEqual(['still']);
        expect(precheck.inputSet.content.map((input) => input.nodeId)).toEqual(['clip']);
        expect(precheck.inputSet.audioTrack.map((input) => input.nodeId)).toEqual(['sound']);
      }
    },
  );

  it('requires a source video for edit and extend and keeps H3 unavailable', () => {
    for (const videoMode of ['video_edit', 'video_extend'] as const) {
      const missingVideo = precheckVideoGenerationInputs(
        [videoInput('prompt', 'prompt', 0, 'text'), videoInput('still', 'referenceImage', 1)],
        { modelAlias: 'wan3.0-video', videoMode },
      );
      expect(missingVideo.issues).toEqual([
        {
          code: 'UNSUPPORTED_INPUT_COMBINATION',
          role: 'content',
          message:
            videoMode === 'video_edit'
              ? '视频编辑模式需要连接一段待编辑视频'
              : '视频延长模式需要连接一段待延长视频',
        },
      ]);

      const h3 = precheckVideoGenerationInputs(
        [videoInput('prompt', 'prompt', 0, 'text'), videoInput('clip', 'content', 1, 'video')],
        { modelAlias: 'minimax-h3', videoMode },
      );
      expect(h3.issues).toEqual([
        {
          code: 'UNSUPPORTED_INPUT_COMBINATION',
          message: `该模型尚无「${videoMode === 'video_edit' ? '视频编辑' : '视频延长'}」的正式字段映射，不能发起真实请求`,
        },
      ]);
    }
  });

  it('only allows Wan3 negative prompts among the newly mapped official families', () => {
    const inputs = [
      videoInput('prompt', 'prompt', 0, 'text'),
      videoInput('negative', 'negativePrompt', 1, 'text'),
    ];
    expect(
      precheckVideoGenerationInputs(inputs, {
        modelAlias: 'wan3.0-video-prime',
        videoMode: 'text_to_video',
      }).issues,
    ).toEqual([]);
    for (const modelAlias of [
      'minimax-h3',
      'doubao-seedance-2-0-mini-260615',
      'doubao-seedance-2-5-260628',
    ]) {
      expect(
        precheckVideoGenerationInputs(inputs, { modelAlias, videoMode: 'text_to_video' }).issues,
      ).toEqual([
        {
          code: 'UNSUPPORTED_INPUT_ROLE',
          role: 'negativePrompt',
          message: 'New API video 不支持该输入角色：negativePrompt',
        },
      ]);
    }
  });

  it.each([
    ['minimax-h3', 9, 3, 3],
    ['wan3.0-video', 10, 5, 5],
    ['doubao-seedance-2-0-fast-260128', 9, 3, 3],
    ['doubao-seedance-2-5-260628', 30, 10, 10],
  ] as const)(
    'enforces reference count limits for %s',
    (modelAlias, imageLimit, videoLimit, audioLimit) => {
      const inputs = [
        videoInput('prompt', 'prompt', 0, 'text'),
        ...Array.from({ length: imageLimit + 1 }, (_, index) =>
          videoInput(`image-${index}`, 'referenceImage', index + 1),
        ),
        ...Array.from({ length: videoLimit + 1 }, (_, index) =>
          videoInput(`video-${index}`, 'content', imageLimit + index + 2, 'video'),
        ),
        ...Array.from({ length: audioLimit + 1 }, (_, index) =>
          videoInput(`audio-${index}`, 'audioTrack', imageLimit + videoLimit + index + 3, 'audio'),
        ),
      ];
      const { issues } = precheckVideoGenerationInputs(inputs, {
        modelAlias,
        videoMode: 'omni_reference',
      });
      expect(issues.map((issue) => issue.role)).toEqual([
        'referenceImage',
        'content',
        'audioTrack',
      ]);
      expect(issues.every((issue) => issue.code === 'INPUT_ROLE_CARDINALITY_UNSUPPORTED')).toBe(
        true,
      );
    },
  );

  it('rejects Seedance 2.0 audio-only reference and allows it on Seedance 2.5', () => {
    const inputs = [
      videoInput('prompt', 'prompt', 0, 'text'),
      videoInput('sound', 'audioTrack', 1, 'audio'),
    ];
    expect(
      precheckVideoGenerationInputs(inputs, {
        modelAlias: 'doubao-seedance-2-0-260128',
        videoMode: 'omni_reference',
      }).issues,
    ).toEqual([
      {
        code: 'UNSUPPORTED_INPUT_COMBINATION',
        message: 'Seedance 2.0 不支持只用参考音频生成视频',
      },
    ]);
    expect(
      precheckVideoGenerationInputs(inputs, {
        modelAlias: 'doubao-seedance-2-5-260628',
        videoMode: 'omni_reference',
      }).issues,
    ).toEqual([]);
  });

  it('rejects role media mismatches before provider serialization', () => {
    const { issues } = precheckVideoGenerationInputs(
      [
        videoInput('prompt', 'prompt', 0, 'text'),
        videoInput('bad-image', 'referenceImage', 1, 'video'),
        videoInput('bad-audio', 'audioTrack', 2, 'video'),
      ],
      { modelAlias: 'minimax-h3', videoMode: 'omni_reference' },
    );
    expect(issues).toEqual([
      {
        code: 'UNSUPPORTED_INPUT_COMBINATION',
        role: 'referenceImage',
        message: '视频输入角色 referenceImage 不接受 video 媒体',
      },
      {
        code: 'UNSUPPORTED_INPUT_COMBINATION',
        role: 'audioTrack',
        message: '视频输入角色 audioTrack 不接受 video 媒体',
      },
    ]);
  });

  it('keeps mapped legacy nodes working but rejects legacy frame/reference mixing', () => {
    const references = [
      videoInput('prompt', 'prompt', 0, 'text'),
      videoInput('prop', 'referenceImage', 1),
      videoInput('clip', 'content', 2, 'video'),
      videoInput('sound', 'audioTrack', 3, 'audio'),
    ];
    expect(precheckVideoGenerationInputs(references, { modelAlias: 'minimax-h3' }).issues).toEqual(
      [],
    );
    expect(
      precheckVideoGenerationInputs([...references, videoInput('first', 'firstFrame', 4)], {
        modelAlias: 'minimax-h3',
      }).issues,
    ).toEqual([
      {
        code: 'UNSUPPORTED_INPUT_COMBINATION',
        message: '首帧或尾帧不能与参考图、参考视频或参考音频混用',
      },
    ]);
  });
});

describe('video mode ports', () => {
  it('recognizes only confirmed official model families', () => {
    expect(videoFamilyForModel('MiniMax-H3')).toBe('minimax-h3');
    expect(videoFamilyForModel('minimax_h3-1080p')).toBe('unknown');
    expect(videoFamilyForModel('wan3.0-video')).toBe('wan3');
    expect(videoFamilyForModel('wan3.0-video-prime')).toBe('wan3');
    expect(videoFamilyForModel('wan2.6-video')).toBe('wan');
    expect(videoFamilyForModel('doubao-seedance-2-0-260128')).toBe('seedance-2');
    expect(videoFamilyForModel('doubao-seedance-2-0-fast-260128')).toBe('seedance-2');
    expect(videoFamilyForModel('doubao-seedance-2-0-mini-260615')).toBe('seedance-2');
    expect(videoFamilyForModel('doubao-seedance-2-5-260628')).toBe('seedance-2.5');
    expect(videoFamilyForModel('doubao-seedance-2-0-mini-260128')).toBe('unknown');
    expect(videoFamilyForModel('doubao-seedance-2-5-pro-260901')).toBe('unknown');
    expect(videoFamilyForModel('doubao-seedance-2-5')).toBe('unknown');
    expect(videoFamilyForModel('doubao-seedance-1-5-pro')).toBe('unknown');
  });

  it('exposes the six product modes and infers omitted mode from connected roles', () => {
    expect(videoModes).toEqual([
      'text_to_video',
      'first_frame',
      'first_last_frame',
      'omni_reference',
      'video_edit',
      'video_extend',
    ]);
    expect(inferVideoModeFromRoles(['firstFrame'])).toBe('first_frame');
    expect(inferVideoModeFromRoles(['lastFrame'])).toBe('first_last_frame');
    expect(inferVideoModeFromRoles(['referenceImage'])).toBe('omni_reference');
    expect(displayVideoMode({ videoMode: 'first_frame' }, ['referenceImage'])).toBe('first_frame');
    expect(implementedVideoModes).toEqual(videoModes);
    expect(videoModeCapability('video_edit').selectable).toBe(false);
    expect(videoModeCapability('video_edit', 'wan3.0-video').selectable).toBe(true);
    expect(videoModeCapability('omni_reference', 'grok-imagine-video-1.5').livePost).toBe(true);
    expect(videoModeCapability('omni_reference', 'minimax-h3').livePost).toBe(true);
  });

  it('narrows video ports once an explicit mode is saved', () => {
    const legacy = canvasNodeSchema.parse({
      id: 'node_video',
      type: 'video',
      position: { x: 0, y: 0 },
      data: { label: '视频', mediaType: 'video', mode: 'generate' },
    });
    expect(legacy.data.videoMode).toBeUndefined();
    expect(targetPortRolesForNode(legacy)).toEqual(
      expect.arrayContaining(['firstFrame', 'character', 'referenceImage', 'lastFrame']),
    );

    const omni = canvasNodeSchema.parse({
      id: 'node_video',
      type: 'video',
      position: { x: 0, y: 0 },
      data: {
        label: '视频',
        mediaType: 'video',
        mode: 'generate',
        videoMode: 'omni_reference',
        modelAlias: 'grok-imagine-video-1.5',
      },
    });
    expect(targetPortRolesForNode(omni)).toEqual(
      expect.arrayContaining(['prompt', 'referenceImage', 'character', 'style']),
    );
    expect(targetPortRolesForNode(omni)).not.toContain('firstFrame');

    const image = canvasNodeSchema.parse({
      id: 'node_image',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { label: '图', mediaType: 'image', mode: 'source' },
    });
    expect(isPortConnectionAllowed(image, 'output:image', omni, 'input:referenceImage')).toBe(true);
    expect(isPortConnectionAllowed(image, 'output:image', omni, 'input:firstFrame')).toBe(false);
  });

  it('absorbs omni prompt image mentions as reference images on grok-imagine-video-1.5', () => {
    expect(
      videoInputRoleForPromptMention('image', 'omni_reference', 'grok-imagine-video-1.5.1'),
    ).toBe('referenceImage');
    expect(
      videoInputRoleForPromptMention('video', 'omni_reference', 'grok-imagine-video-1.5.1'),
    ).toBeUndefined();
    expect(videoModeForPromptMentions('text_to_video', true)).toBe('omni_reference');
    expect(videoModeForPromptMentions(undefined, true)).toBe('omni_reference');
    expect(videoModeForPromptMentions('first_frame', true)).toBe('first_frame');
    expect(
      videoInputRoleForPromptMention('image', 'text_to_video', 'grok-imagine-video-1.5.1'),
    ).toBe('referenceImage');
    expect(
      videoInputRoleForPromptMention('image', 'first_frame', 'grok-imagine-video-1.5.1'),
    ).toBeUndefined();
    const mentions = [
      { mediaType: 'image' as const, mentionId: 'm-image' },
      { mediaType: 'video' as const, mentionId: 'm-video' },
    ];
    expect(
      unabsorbedVideoPromptMentions(
        {
          mediaType: 'video',
          mode: 'generate',
          videoMode: 'omni_reference',
          modelAlias: 'grok-imagine-video-1.5.1',
        },
        mentions,
      ).map((mention) => mention.mentionId),
    ).toEqual(['m-video']);
    expect(
      unabsorbedVideoPromptMentions(
        {
          mediaType: 'video',
          mode: 'generate',
          videoMode: 'text_to_video',
          modelAlias: 'grok-imagine-video-1.5.1',
        },
        mentions,
      ).map((mention) => mention.mentionId),
    ).toEqual(['m-video']);
    expect(
      unabsorbedVideoPromptMentions(
        {
          mediaType: 'video',
          mode: 'generate',
          modelAlias: 'grok-imagine-video-1.5.1',
        },
        mentions,
      ).map((mention) => mention.mentionId),
    ).toEqual(['m-video']);
  });

  it('absorbs official reference media mentions for omni, edit, and extend modes', () => {
    for (const modelAlias of [
      'minimax-h3',
      'wan3.0-video',
      'doubao-seedance-2-0-fast-260128',
      'doubao-seedance-2-5-260628',
    ]) {
      for (const videoMode of ['omni_reference', 'video_edit', 'video_extend'] as const) {
        const capability = videoModeCapability(videoMode, modelAlias);
        if (!capability.selectable) continue;
        expect(videoInputRoleForPromptMention('image', videoMode, modelAlias)).toBe(
          'referenceImage',
        );
        expect(videoInputRoleForPromptMention('video', videoMode, modelAlias)).toBe('content');
        expect(videoInputRoleForPromptMention('audio', videoMode, modelAlias)).toBe('audioTrack');
      }
    }
    expect(videoInputRoleForPromptMention('video', 'video_edit', 'minimax-h3')).toBeUndefined();
    expect(videoImageRolesForMode('video_edit')).toEqual(['referenceImage']);
    expect(videoImageRolesForMode('video_extend')).toEqual(['referenceImage']);
  });
});

describe('video completion action', () => {
  it('treats omitted completionAction as none and keeps an explicit preview action', () => {
    const legacy = canvasNodeSchema.parse({
      id: 'node_video',
      type: 'video',
      position: { x: 0, y: 0 },
      data: { label: '视频', mediaType: 'video', mode: 'generate' },
    });
    expect(resolveVideoCompletionAction(legacy.data)).toBe('none');
    expect(legacy.data.completionAction).toBeUndefined();

    const configured = canvasNodeSchema.parse({
      id: 'node_video',
      type: 'video',
      position: { x: 0, y: 0 },
      data: {
        label: '视频',
        mediaType: 'video',
        mode: 'generate',
        completionAction: 'preview_final_frame',
      },
    });
    expect(resolveVideoCompletionAction(configured.data)).toBe('preview_final_frame');
  });
});
