import type {
  CanvasNode,
  FrozenPromptMention,
  RunInputSnapshot,
  RunSnapshot,
} from '@multimodal-canvas/domain';
import { describe, expect, it } from 'vitest';
import { validateRunImage2proVideo, validateRunVideoInputs } from './run-image2pro-video';

/** 构造只含身份和版本元数据的冻结快照，预检不需要图片字节。 */
function snapshot(): RunSnapshot {
  return {
    projectId: 'project',
    targetNodeId: 'video',
    canvasRevision: 1,
    modelAlias: 'Seedance2.0 0.9r',
    parameters: { duration: 5 },
    submittedAt: '2026-10-07T12:00:00.000Z',
    nodes: [
      {
        id: 'video',
        type: 'video',
        position: { x: 0, y: 0 },
        data: {
          label: '视频',
          mediaType: 'video',
          mode: 'generate',
          videoMode: 'omni_reference',
          modelAlias: 'Seedance2.0 0.9r',
          parameters: { duration: 5 },
        },
      },
    ],
    edges: [],
    inputs: [],
  };
}

/** 返回一项普通图片引用，供连线和提及的跨入口计数校验。 */
function imageInput(index: number): RunInputSnapshot {
  return {
    nodeId: `image-${index}`,
    role: 'referenceImage',
    sortOrder: index,
    sourceAssetId: `asset-${index}`,
    sourceAssetVersion: 1,
    snapshot: {
      id: `image-${index}`,
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        label: `图片 ${index}`,
        mediaType: 'image',
        mode: 'source',
        assetId: `asset-${index}`,
        contentUrl: `/v1/assets/asset-${index}/versions/1/content`,
      },
    },
  };
}

/** 创建相同图片不同版本的冻结提及；blockOrder 只决定顺序，不代替资产身份。 */
function mention(index: number, assetVersion = 1): FrozenPromptMention {
  return {
    nodeId: 'video',
    mentionId: `mention-${index}-${assetVersion}`,
    assetId: `asset-${index}`,
    assetVersion,
    mediaType: 'image',
    label: `参考图 ${index}`,
    blockOrder: index,
  };
}

/** 源流普通参考预检夹具，保留显式时长和非空正文。 */
function yuanSnapshot(modelAlias = 'Yuan-Seedance-2.5-LJ-Full'): RunSnapshot {
  const frozen = snapshot();
  frozen.modelAlias = modelAlias;
  frozen.nodes[0]!.data.modelAlias = modelAlias;
  frozen.nodes[0]!.data.prompt = 'Create a scene following the references.';
  return frozen;
}

describe('Yuan Run 提交预检', () => {
  it.each(['Yuan-Seedance-2.5-LW', 'yuan-seedance-2.5-lj', 'yl_unadapted_model'])(
    '%s 缺少 videoMode 的历史节点交给上游处理',
    (modelAlias) => {
      const frozen = yuanSnapshot(modelAlias);
      delete frozen.nodes[0]!.data.videoMode;
      const before = structuredClone(frozen);
      expect(() => validateRunVideoInputs(frozen)).not.toThrow();
      expect(frozen).toEqual(before);
    },
  );

  it('冻结 txt 待水合时延后正文验证，不能回落到旧参数正文', () => {
    const frozen = yuanSnapshot();
    frozen.nodes[0]!.data.videoMode = 'text_to_video';
    frozen.nodes[0]!.data.promptDocument = { version: 1, blocks: [{ type: 'text', text: ' ' }] };
    frozen.parameters.prompt = 'x'.repeat(16001);
    const input = imageInput(0);
    input.role = 'prompt';
    input.snapshot.type = 'text';
    input.snapshot.data.mediaType = 'text';
    frozen.inputs = [input];
    const before = structuredClone(frozen);
    expect(() => validateRunVideoInputs(frozen)).not.toThrow();
    expect(frozen).toEqual(before);
  });
});

describe('Image2Pro Run 提交预检', () => {
  it.each([false, true])('H3 空白节点或文档不遮盖合法 prompt 文字连线：document=%s', (document) => {
    const frozen = snapshot();
    frozen.modelAlias = '无限制-Flash-MAX-Video';
    frozen.nodes[0]!.data.videoMode = 'text_to_video';
    frozen.nodes[0]!.data.prompt = '';
    if (document)
      frozen.nodes[0]!.data.promptDocument = { version: 1, blocks: [{ type: 'text', text: ' ' }] };
    const input = imageInput(0);
    input.role = 'prompt';
    input.snapshot.type = 'text';
    input.snapshot.data.mediaType = 'text';
    input.snapshot.data.prompt = 'Use the connected text.';
    frozen.inputs = [input];
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
  });

  it('H3 明确文档与 content 文字替代旧长参数后，API 使用实际正文校验', () => {
    for (const source of ['document', 'connected'] as const) {
      const frozen = snapshot();
      frozen.modelAlias = '无限制-Flash-MAX-Video';
      frozen.nodes[0]!.data.modelAlias = frozen.modelAlias;
      frozen.nodes[0]!.data.videoMode = 'text_to_video';
      frozen.parameters = { duration: 5, prompt: 'old'.repeat(3000) };
      const prompt = 'Write --duration 15 on the sign.';
      if (source === 'document')
        frozen.nodes[0]!.data.promptDocument = {
          version: 1,
          blocks: [{ type: 'text', text: prompt }],
        };
      else {
        const input = imageInput(0);
        input.role = 'content';
        input.snapshot.type = 'text';
        input.snapshot.data.mediaType = 'text';
        input.snapshot.data.prompt = prompt;
        frozen.inputs = [input];
      }
      expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
      expect(frozen.parameters.prompt).toBe('old'.repeat(3000));
    }
  });

  it('H3 空白文档引用待水合冻结正文时不校验被替代的旧长参数', () => {
    const frozen = snapshot();
    frozen.modelAlias = '无限制-Flash-MAX-Video';
    frozen.parameters = { duration: 5, prompt: 'x'.repeat(7001) };
    frozen.nodes[0]!.data.videoMode = 'text_to_video';
    frozen.nodes[0]!.data.promptDocument = { version: 1, blocks: [{ type: 'text', text: ' ' }] };
    const input = imageInput(0);
    input.role = 'prompt';
    input.snapshot.type = 'text';
    input.snapshot.data.mediaType = 'text';
    frozen.inputs = [input];
    const before = structuredClone(frozen);
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
    expect(frozen).toEqual(before);
  });

  it.each(['node', 'document'] as const)(
    'H3 非空 %s 正文与 prompt 连线交给 Provider 合并',
    (source) => {
      const frozen = snapshot();
      frozen.modelAlias = '无限制-Flash-MAX-Video';
      frozen.nodes[0]!.data.videoMode = 'text_to_video';
      frozen.nodes[0]!.data.prompt = 'The explicit node prompt.';
      if (source === 'document')
        frozen.nodes[0]!.data.promptDocument = {
          version: 1,
          blocks: [{ type: 'text', text: 'The explicit document prompt.' }],
        };
      const input = imageInput(0);
      input.role = 'prompt';
      input.snapshot.type = 'text';
      input.snapshot.data.mediaType = 'text';
      input.snapshot.data.prompt = 'The connected prompt.';
      frozen.inputs = [input];
      const before = structuredClone(frozen);
      expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
      expect(frozen).toEqual(before);
    },
  );
  it.each(['无限制-Flash-中配-Video'])('%s 未写视频模式时保留快照并交给上游处理', (modelAlias) => {
    const frozen = snapshot();
    frozen.modelAlias = modelAlias;
    delete frozen.nodes[0]!.data.videoMode;
    const before = structuredClone(frozen);
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
    expect(frozen).toEqual(before);
  });

  it('文生视频中的图片提及使用全能参考预检，不把引用丢掉', () => {
    const frozen = snapshot();
    frozen.nodes[0]!.data.videoMode = 'text_to_video';
    frozen.promptMentions = [mention(0)];
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
    expect(frozen.nodes[0]!.data.videoMode).toBe('text_to_video');
  });
});
