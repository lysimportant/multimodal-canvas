import { describe, expect, it } from 'vitest';
import type { PromptDocument, RunRecord } from '@multimodal-canvas/domain';

import type { AssetFlowNode } from '../canvas-utils';
import {
  GENERATED_CONTENT_MARKER,
  appendGeneratedContentToPrompt,
  canForkNewNode,
  canRunSameNode,
  createUniqueForkLabel,
  findReadyFinalFrameImageNode,
  freezeImageEditSource,
  imageForkPromptOverride,
  inheritedGenerateData,
  nodeHasPrompt,
} from './fork-generate-node';

function imageNode(
  overrides: { id?: string; data?: Partial<AssetFlowNode['data']> } = {},
): AssetFlowNode {
  return {
    id: overrides.id ?? 'node_image',
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      label: '产品主图',
      mediaType: 'image',
      mode: 'generate',
      prompt: '白色背景',
      ...overrides.data,
    },
  } as AssetFlowNode;
}

describe('fork-generate-node', () => {
  it('空节点不能分叉，来源节点也可以点生成', () => {
    const empty = imageNode();
    expect(canForkNewNode(empty)).toBe(false);
    expect(canRunSameNode(empty)).toBe(true);
    expect(
      canRunSameNode(imageNode({ data: { mode: 'source', assetId: 'a', contentUrl: '/c' } })),
    ).toBe(true);
    expect(
      canForkNewNode(imageNode({ data: { mode: 'source', assetId: 'a', contentUrl: '/c' } })),
    ).toBe(true);
  });

  it('无提示词时不能提交分叉', () => {
    expect(nodeHasPrompt({ prompt: '  ' })).toBe(false);
    expect(nodeHasPrompt({ prompt: '夜景' })).toBe(true);
  });

  it('继承模型和参数，不带提示词和产物字段', () => {
    const inherited = inheritedGenerateData({
      label: '产品主图',
      mediaType: 'image',
      mode: 'generate',
      prompt: '白色背景',
      modelAlias: 'image-edit-model',
      platformModelId: 'platform-image-model',
      credentialId: 'cred_1',
      parameters: { quality: '2k' },
      resourceRefs: [{ id: 'ref', assetId: 'asset_1', mediaType: 'image', name: '参考' }],
      inferenceStrength: 'high',
      resultAsset: { assetId: 'result_1' },
      assetId: 'asset_old',
      contentUrl: '/old',
    } as AssetFlowNode['data']);
    expect(inherited).toMatchObject({
      modelAlias: 'image-edit-model',
      platformModelId: 'platform-image-model',
      credentialId: 'cred_1',
      parameters: { quality: '2k' },
      inferenceStrength: 'high',
    });
    expect(inherited).not.toHaveProperty('prompt');
    expect(inherited).not.toHaveProperty('promptDocument');
    expect(inherited).not.toHaveProperty('resourceRefs');
    expect(inherited).not.toHaveProperty('resultAsset');
    expect(inherited).not.toHaveProperty('assetId');
    expect(inherited).not.toHaveProperty('contentUrl');
  });

  it('图片分叉只清理图片提及，保留文字和其他类型引用且不修改父文档', () => {
    const document: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: 'Keep the composition. ' },
        {
          type: 'mention',
          mentionId: 'old-image',
          assetId: 'image-a',
          assetVersion: 2,
          label: 'reference.png',
          mediaType: 'image',
        },
        { type: 'text', text: '\nFollow the notes: ' },
        {
          type: 'mention',
          mentionId: 'notes',
          assetId: 'notes-asset',
          label: 'notes.txt',
          mediaType: 'text',
        },
      ],
    };
    const original = structuredClone(document);
    const result = imageForkPromptOverride({ prompt: 'stale fallback', promptDocument: document });
    expect(result.promptDocument?.blocks).toEqual([
      original.blocks[0],
      original.blocks[2],
      original.blocks[3],
    ]);
    expect(result.prompt).toBe('Keep the composition. \nFollow the notes: notes');
    expect(document).toEqual(original);
    expect(result.promptDocument?.blocks[2]).not.toBe(document.blocks[3]);
  });

  it('仅有图片提及时返回合法空文档，不回退父节点的旧提示词', () => {
    const result = imageForkPromptOverride({
      prompt: 'reference',
      promptDocument: {
        version: 1,
        blocks: [
          {
            type: 'mention',
            mentionId: 'old-image',
            assetId: 'image-a',
            label: 'reference.png',
            mediaType: 'image',
          },
        ],
      },
    });
    expect(result).toEqual({
      prompt: '',
      promptDocument: { version: 1, blocks: [{ type: 'text', text: '' }] },
    });
    expect(nodeHasPrompt(result)).toBe(false);
  });

  it('纯文本图片要求原样保留，不把普通 @ 字符猜成资源引用', () => {
    expect(imageForkPromptOverride({ prompt: 'Paint the sign @home.' })).toEqual({
      prompt: 'Paint the sign @home.',
    });
    expect(imageForkPromptOverride({})).toEqual({});
  });

  it('冻结生成结果用 result 版本，上传资源不写 version', () => {
    expect(
      freezeImageEditSource(
        imageNode({
          id: 'node_result',
          data: {
            resultAsset: { assetId: 'asset_result', version: 3 },
          },
        }),
      ),
    ).toEqual({
      sourceNodeId: 'node_result',
      assetId: 'asset_result',
      version: 3,
      sourceKind: 'result',
    });
    expect(
      freezeImageEditSource(
        imageNode({
          id: 'node_upload',
          data: { assetId: 'asset_upload', contentUrl: '/c' },
        }),
      ),
    ).toEqual({
      sourceNodeId: 'node_upload',
      assetId: 'asset_upload',
      sourceKind: 'asset',
    });
    expect(freezeImageEditSource(imageNode())).toBeUndefined();
  });

  it('追加回显正文时保留资源提及块', () => {
    const document: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '参考 ' },
        {
          type: 'mention',
          mentionId: 'm1',
          assetId: 'asset_1',
          mediaType: 'image',
          label: 'hero.png',
          entityName: '主图',
        },
      ],
    };
    const result = appendGeneratedContentToPrompt({ promptDocument: document }, '已写好的文章');
    expect(result.promptDocument.blocks[0]).toEqual({ type: 'text', text: '参考 ' });
    expect(result.promptDocument.blocks[1]).toMatchObject({ type: 'mention', mentionId: 'm1' });
    expect(result.promptDocument.blocks.at(-1)).toEqual({
      type: 'text',
      text: `\n\n${GENERATED_CONTENT_MARKER}\n已写好的文章`,
    });
    expect(result.prompt).toContain('参考 ');
    expect(result.prompt).toContain(GENERATED_CONTENT_MARKER);
    expect(result.prompt).toContain('已写好的文章');
  });

  it('回显为空时拒绝拼接', () => {
    expect(() => appendGeneratedContentToPrompt({ prompt: '写一篇' }, '  ')).toThrow(
      '无法读取当前回显正文',
    );
  });

  it('优先使用运行记录里现成的末帧图片节点，没有则不造节点', () => {
    const video = {
      id: 'node_video',
      type: 'video',
      position: { x: 0, y: 0 },
      data: { label: '广告视频', mediaType: 'video', mode: 'generate' },
    } as AssetFlowNode;
    const frameNode = imageNode({
      id: 'node_frame',
      data: { label: '广告视频末帧', assetId: 'asset_frame', contentUrl: '/frame' },
    });
    const run = {
      result: {
        finalFrame: { status: 'ready', nodeId: 'node_frame', assetId: 'asset_frame' },
      },
    } as RunRecord;
    expect(findReadyFinalFrameImageNode(video, [video, frameNode], run)?.id).toBe('node_frame');
    expect(findReadyFinalFrameImageNode(video, [video], run)).toBeUndefined();
    expect(findReadyFinalFrameImageNode(video, [video, frameNode])?.id).toBe('node_frame');
  });

  it('分叉名称在画布内唯一', () => {
    const nodes = [imageNode({ data: { label: '修改 产品主图' } })];
    expect(createUniqueForkLabel('产品主图', nodes)).toBe('修改 产品主图 2');
  });
});
