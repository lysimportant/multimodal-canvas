import type {
  CanvasNode,
  FrozenPromptMention,
  RunInputSnapshot,
  RunSnapshot,
} from '@multimodal-canvas/domain';
import { describe, expect, it } from 'vitest';
import {
  RunImage2proVideoError,
  validateRunImage2proVideo,
  validateRunVideoInputs,
} from './run-image2pro-video';

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
    '%s 缺少 videoMode 的历史节点仍明确拒绝',
    (modelAlias) => {
      const frozen = yuanSnapshot(modelAlias);
      delete frozen.nodes[0]!.data.videoMode;
      expect(() => validateRunVideoInputs(frozen)).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_INPUT_COMBINATION' }),
      );
    },
  );

  it.each([
    { modelAlias: 'Yuan-Seedance-2.5-LJ-Full', parameters: {} },
    { modelAlias: 'Yuan-Seedance-2.5-LJ-Full', parameters: { duration: 'auto' } },
    { modelAlias: 'Yuan-Seedance-2.5-LJ-Full', parameters: { duration: 5.5 } },
    { modelAlias: 'Yuan-Seedance-2.0-HD', parameters: { duration: 6 } },
    { modelAlias: 'Yuan-Seedance-2.5-LJ-Full', parameters: { duration: 5, watermark: false } },
  ])('$modelAlias 非法参数 %# 不改写冻结快照', ({ modelAlias, parameters }) => {
    const frozen = yuanSnapshot(modelAlias);
    frozen.nodes[0]!.data.videoMode = 'text_to_video';
    frozen.parameters = parameters;
    const before = structuredClone(frozen);
    expect(() => validateRunVideoInputs(frozen)).toThrow();
    expect(frozen).toEqual(before);
  });

  it.each(['first_frame', 'first_last_frame', 'video_edit', 'video_extend'] as const)(
    '未适配的 %s 不借用普通 Seedance 合同',
    (videoMode) => {
      const frozen = yuanSnapshot();
      frozen.nodes[0]!.data.videoMode = videoMode;
      frozen.inputs = [imageInput(0)];
      expect(() => validateRunVideoInputs(frozen)).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_INPUT_COMBINATION' }),
      );
    },
  );

  it.each(['firstFrame', 'lastFrame', 'negativePrompt'] as const)(
    '普通参考不能携带 %s 角色',
    (role) => {
      const frozen = yuanSnapshot();
      frozen.inputs = [{ ...imageInput(0), role }];
      expect(() => validateRunVideoInputs(frozen)).toThrow();
    },
  );

  it('连线和提及按资产、版本与角色去重，不同版本或角色占用独立名额', () => {
    const frozen = yuanSnapshot('Yuan-Seedance-2.0-LJ');
    frozen.inputs = Array.from({ length: 9 }, (_, index) => imageInput(index));
    frozen.promptMentions = [mention(0), { ...mention(0), mentionId: 'same-version' }];
    expect(() => validateRunVideoInputs(frozen)).not.toThrow();
    frozen.promptMentions.push(mention(0, 2));
    expect(() => validateRunVideoInputs(frozen)).toThrow('参考图数量超过模型上限 9');
    frozen.promptMentions.pop();
    frozen.inputs.push({ ...imageInput(0), role: 'style' });
    expect(() => validateRunVideoInputs(frozen)).toThrow('参考图数量超过模型上限 9');
  });

  it('音视频分别受精确型号上限约束，混合普通参考仍受总数 40 约束', () => {
    const frozen = yuanSnapshot();
    frozen.promptMentions = Array.from({ length: 30 }, (_, index) => mention(index));
    frozen.promptMentions.push(
      ...Array.from({ length: 10 }, (_, index) => ({
        ...mention(30 + index),
        mediaType: 'video' as const,
      })),
    );
    expect(() => validateRunVideoInputs(frozen)).not.toThrow();
    frozen.promptMentions.push({ ...mention(40), mediaType: 'audio' });
    expect(() => validateRunVideoInputs(frozen)).toThrow('参考素材总数不能超过 40');
    for (const mediaType of ['video', 'audio'] as const) {
      frozen.promptMentions = Array.from({ length: 11 }, (_, index) => ({
        ...mention(index),
        mediaType,
      }));
      expect(() => validateRunVideoInputs(frozen)).toThrow('超过模型上限 10');
    }
  });

  it.each(['node', 'document', 'connected'] as const)(
    '按最终 %s 正文验证必填和精确型号字符上限',
    (source) => {
      const frozen = yuanSnapshot('Yuan-Seedance-2.5-YL1');
      frozen.parameters = { duration: 30 };
      frozen.nodes[0]!.data.videoMode = 'text_to_video';
      const input = imageInput(0);
      input.role = 'content';
      input.snapshot.type = 'text';
      input.snapshot.data.mediaType = 'text';
      delete input.sourceAssetId;
      delete input.sourceAssetVersion;
      delete input.snapshot.data.assetId;
      delete input.snapshot.data.contentUrl;
      const setPrompt = (prompt: string) => {
        if (source === 'node') frozen.nodes[0]!.data.prompt = prompt;
        if (source === 'document')
          frozen.nodes[0]!.data.promptDocument = {
            version: 1,
            blocks: [{ type: 'text', text: prompt }],
          };
        if (source === 'connected') {
          input.snapshot.data.prompt = prompt;
          frozen.inputs = [input];
        }
      };
      setPrompt('');
      expect(() => validateRunVideoInputs(frozen)).toThrow('必须提供非空文本');
      setPrompt('x'.repeat(8001));
      expect(() => validateRunVideoInputs(frozen)).toThrow('8000');
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

  it('实际执行的上游 Yuan 节点使用自己的参数，不借用下游目标参数', () => {
    const frozen = yuanSnapshot();
    frozen.inputs = [];
    const video = frozen.nodes[0]!;
    video.data.videoMode = 'text_to_video';
    video.data.parameters = { duration: 5, generate_audio: false };
    const target: CanvasNode = {
      id: 'text-target',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { label: '下游', mediaType: 'text', mode: 'generate', modelAlias: 'text-model' },
    };
    frozen.targetNodeId = target.id;
    frozen.modelAlias = 'text-model';
    frozen.parameters = { duration: 30 };
    frozen.nodes.push(target);
    expect(() => validateRunVideoInputs(frozen)).toThrow('generate_audio');
    delete video.data.parameters.generate_audio;
    expect(() => validateRunVideoInputs(frozen)).not.toThrow();
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
  it('H3 精确 MAX 允许纯音频参考，不把 Seedance 参数和文本限制套用', () => {
    const frozen = snapshot();
    frozen.modelAlias = '无限制-Flash-MAX-Video';
    frozen.nodes[0]!.data.modelAlias = frozen.modelAlias;
    frozen.nodes[0]!.data.prompt = 'Create a scene following this audio.';
    frozen.parameters = { duration: 12, resolution: '720p', ratio: 'adaptive' };
    frozen.promptMentions = [{ ...mention(0), mediaType: 'audio', durationSeconds: 15 }];
    const before = structuredClone(frozen);
    expect(() => validateRunImage2proVideo(frozen)).not.toThrow();
    expect(frozen).toEqual(before);
    frozen.parameters.watermark = false;
    expect(() => validateRunImage2proVideo(frozen)).toThrow('watermark');
  });

  it.each(['node', 'document', 'connected'] as const)(
    'H3 最终 %s 提示词超过 7000 字符时在 Run 前拒绝',
    (source) => {
      const frozen = snapshot();
      frozen.modelAlias = '无限制-Flash-MAX-Video';
      frozen.nodes[0]!.data.modelAlias = frozen.modelAlias;
      frozen.nodes[0]!.data.videoMode = 'text_to_video';
      const prompt = 'x'.repeat(7001);
      if (source === 'node') frozen.nodes[0]!.data.prompt = prompt;
      if (source === 'document')
        frozen.nodes[0]!.data.promptDocument = {
          version: 1,
          blocks: [{ type: 'text', text: prompt }],
        };
      if (source === 'connected') {
        const input = imageInput(0);
        input.role = 'content';
        input.snapshot.type = 'text';
        input.snapshot.data.mediaType = 'text';
        input.snapshot.data.prompt = prompt;
        frozen.nodes[0]!.data.prompt = 'An older shorter prompt.';
        frozen.inputs = [input];
      }
      expect(() => validateRunImage2proVideo(frozen)).toThrow('7000');
    },
  );

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
    'H3 非空 %s 正文与 prompt 连线在 Run 前按 Provider 冲突拒绝',
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
      expect(() => validateRunImage2proVideo(frozen)).toThrow(
        expect.objectContaining({ code: 'INPUT_ROLE_CONFLICT' }),
      );
      expect(frozen).toEqual(before);
    },
  );

  it('节点正文中的参数覆盖标记在保存 Run 前拒绝', () => {
    const frozen = snapshot();
    frozen.nodes[0]!.data.videoMode = 'text_to_video';
    frozen.nodes[0]!.data.prompt = 'A scene --resolution 4k';
    expect(() => validateRunImage2proVideo(frozen)).toThrow('不能包含覆盖生成参数');
  });
  it.each(['无限制-Flash-中配-Video'])(
    '%s 在保存 Run 前拒绝，未写视频模式也不回落到通用路径',
    (modelAlias) => {
      const frozen = snapshot();
      frozen.modelAlias = modelAlias;
      delete frozen.nodes[0]!.data.videoMode;
      const before = structuredClone(frozen);
      expect(() => validateRunImage2proVideo(frozen)).toThrow('Flash 中配视频模型已停止适配');
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
