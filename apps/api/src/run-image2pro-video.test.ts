import type {
  CanvasNode,
  FrozenPromptMention,
  RunInputSnapshot,
  RunSnapshot,
} from '@multimodal-canvas/domain';
import { describe, expect, it } from 'vitest';
import { RunImage2proVideoError, validateRunImage2proVideo } from './run-image2pro-video';

/** 构造只含身份和版本元数据的冻结快照，预检不需要图片字节。 */
function snapshot(): RunSnapshot {
  return {
    projectId: 'project',
    targetNodeId: 'video',
    canvasRevision: 1,
    modelAlias: '无限制-Flash-MAX-Video',
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
          modelAlias: '无限制-Flash-MAX-Video',
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

describe('Image2Pro Run 提交预检', () => {
  it('连线与同版本提及去重，第十张或另一版本图片明确拒绝', () => {
    const frozen = snapshot();
    frozen.inputs = Array.from({ length: 9 }, (_, index) => imageInput(index));
    frozen.promptMentions = [mention(0), { ...mention(0), mentionId: 'repeated' }];
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
    frozen.promptMentions.push(mention(0, 2));
    expect(() => validateRunImage2proVideo(frozen)).toThrow('参考图数量超过模型上限 9');
    expect(frozen.promptMentions.at(-1)?.assetVersion).toBe(2);
  });

  it('文生视频中的图片提及使用全能参考预检，不把引用丢掉', () => {
    const frozen = snapshot();
    frozen.nodes[0]!.data.videoMode = 'text_to_video';
    frozen.promptMentions = [mention(0)];
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
    expect(frozen.nodes[0]!.data.videoMode).toBe('text_to_video');
  });

  it.each(['first_frame', 'first_last_frame', 'video_edit', 'video_extend'] as const)(
    '尚未开放的 %s 在排队前拒绝',
    (videoMode) => {
      const frozen = snapshot();
      frozen.nodes[0]!.data.videoMode = videoMode;
      frozen.inputs = [imageInput(0)];
      expect(() => validateRunImage2proVideo(frozen)).toThrow(RunImage2proVideoError);
    },
  );

  it('音视频提及不能绕过普通图片合同', () => {
    for (const mediaType of ['audio', 'video'] as const) {
      const frozen = snapshot();
      frozen.promptMentions = [{ ...mention(0), mediaType }];
      expect(() => validateRunImage2proVideo(frozen)).toThrow('不支持首尾帧或音视频提及');
    }
  });

  it('检查实际执行的上游视频参数，跳过来源或禁用节点并保持其他模型行为', () => {
    const frozen = snapshot();
    const video = frozen.nodes[0]!;
    const target: CanvasNode = {
      id: 'target',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { label: '下游', mediaType: 'text', mode: 'generate', modelAlias: 'text-model' },
    };
    frozen.targetNodeId = target.id;
    frozen.modelAlias = 'text-model';
    frozen.parameters = {};
    frozen.nodes.push(target);
    video.data.videoMode = 'text_to_video';
    video.data.parameters = { duration: 5, resolution: '720p' };
    expect(() => validateRunImage2proVideo(frozen)).toThrow('resolution');
    video.data.enabled = false;
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
    video.data.enabled = true;
    video.data.mode = 'source';
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
    video.data.mode = 'generate';
    video.data.modelAlias = 'sd2-930-fast';
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
  });

  it('上游连线来源与冻结提及按实际版本合并，不借用根目标参数', () => {
    const frozen = snapshot();
    const video = frozen.nodes[0]!;
    const image = imageInput(0).snapshot;
    const target: CanvasNode = {
      id: 'target',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { label: '下游', mediaType: 'text', mode: 'generate', modelAlias: 'text-model' },
    };
    frozen.targetNodeId = target.id;
    frozen.modelAlias = 'text-model';
    frozen.parameters = { resolution: '4k' };
    frozen.nodes.push(image, target);
    frozen.edges = [
      {
        id: 'image-video',
        sourceNodeId: image.id,
        targetNodeId: video.id,
        sourceHandle: 'output:image',
        targetHandle: 'input:referenceImage',
        order: 0,
      },
    ];
    frozen.promptMentions = Array.from({ length: 9 }, (_, index) => mention(index));
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
    frozen.promptMentions.push(mention(0, 2));
    expect(() => validateRunImage2proVideo(frozen)).toThrow('参考图数量超过模型上限 9');
  });
});
