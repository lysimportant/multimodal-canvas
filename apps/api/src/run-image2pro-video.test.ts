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

describe('Image2Pro Run 提交预检', () => {
  it('节点正文中的参数覆盖标记在保存 Run 前拒绝', () => {
    const frozen = snapshot();
    frozen.nodes[0]!.data.videoMode = 'text_to_video';
    frozen.nodes[0]!.data.prompt = 'A scene --resolution 4k';
    expect(() => validateRunImage2proVideo(frozen)).toThrow('不能包含覆盖生成参数');
  });
  it.each(['无限制-Flash-中配-Video', '无限制-Flash-MAX-Video'])(
    '%s 在保存 Run 前拒绝，未写视频模式也不回落到通用路径',
    (modelAlias) => {
      const frozen = snapshot();
      frozen.modelAlias = modelAlias;
      delete frozen.nodes[0]!.data.videoMode;
      const before = structuredClone(frozen);
      expect(() => validateRunImage2proVideo(frozen)).toThrow('Flash 视频模型已停止适配');
      expect(frozen).toEqual(before);
    },
  );

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

  it.each(['video_edit', 'video_extend'] as const)('尚未开放的 %s 在排队前拒绝', (videoMode) => {
    const frozen = snapshot();
    frozen.nodes[0]!.data.videoMode = videoMode;
    frozen.inputs = [imageInput(0)];
    expect(() => validateRunImage2proVideo(frozen)).toThrow(RunImage2proVideoError);
  });

  it('全能参考吸收音视频提及，纯音频仍拒绝', () => {
    for (const mediaType of ['audio', 'video'] as const) {
      const frozen = snapshot();
      frozen.promptMentions = [mention(0), { ...mention(1), mediaType }];
      expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
    }
    const audioOnly = snapshot();
    audioOnly.promptMentions = [{ ...mention(0), mediaType: 'audio' }];
    expect(() => validateRunImage2proVideo(audioOnly)).toThrow('不支持只用参考音频');
  });

  it.each(['audio', 'video'] as const)(
    '冻结 %s 提及时长进入预检，单段及累计非法明确拒绝',
    (mediaType) => {
      for (const durations of [[2], [15], [2, 13], [undefined]]) {
        const frozen = snapshot();
        frozen.promptMentions = [
          mention(0),
          ...durations.map((durationSeconds, index) => ({
            ...mention(index + 1),
            mediaType,
            ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          })),
        ];
        expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
      }
      for (const durations of [[1.99], [15.01], [8, 8]]) {
        const frozen = snapshot();
        frozen.promptMentions = [
          mention(0),
          ...durations.map((durationSeconds, index) => ({
            ...mention(index + 1),
            mediaType,
            durationSeconds,
          })),
        ];
        expect(() => validateRunImage2proVideo(frozen)).toThrow(RunImage2proVideoError);
      }
    },
  );

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
    video.data.parameters = { duration: 5, quality: 'high' };
    expect(() => validateRunImage2proVideo(frozen)).toThrow('quality');
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
