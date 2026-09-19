import { describe, expect, it } from 'vitest';

import type { AssetFlowNode } from '../canvas-utils';
import type { ModelEntry } from './contracts';
import { applyNodeGenerationDefaults, resolvePreviousOperationSeed } from './NodeQuickEditor';

/** 构造只包含模型目录声明的测试模型，不请求外部 Provider。 */
function model(
  mediaType: AssetFlowNode['data']['mediaType'],
  capabilities: Record<string, unknown> = {},
): ModelEntry {
  return { id: 'test-model', name: '测试模型', mediaTypes: [mediaType], capabilities };
}

/** 构造待初始化的节点数据，其他业务字段随默认值应用保持不变。 */
function data(mediaType: AssetFlowNode['data']['mediaType']): AssetFlowNode['data'] {
  return {
    label: '测试节点',
    mediaType,
    mode: 'generate',
    modelAlias: 'test-model',
    prompt: '测试提示词',
  };
}

describe('applyNodeGenerationDefaults', () => {
  it('只在明确事务中把目录的第一个有效选项写入真实节点参数', () => {
    const original = data('video');
    const configured = applyNodeGenerationDefaults(
      original,
      model('video', {
        video: {
          resolutions: ['360p', '720p', '1080p'],
          aspectRatios: ['1:1', '16:9', '9:16'],
          durations: [4, 8, 12],
          reasoning_effort: ['low', 'medium', 'high'],
        },
      }),
    );
    expect(configured).toMatchObject({
      prompt: original.prompt,
      parameters: { resolution: '360p', aspectRatio: '1:1', duration: 4 },
      inferenceStrength: 'high',
    });
    expect(JSON.parse(JSON.stringify(configured)).parameters.duration).toBe(4);
    expect(original.parameters).toBeUndefined();
  });

  it('跳过空项、重复项和目录禁用项，只有唯一可用项时选择该项', () => {
    const configured = applyNodeGenerationDefaults(
      data('image'),
      model('image', {
        quality: [
          '',
          { value: 'low', disabled: true },
          'medium',
          'medium',
          { value: 'high', enabled: false },
          'ultra',
        ],
        aspectRatios: [{ value: '1:1', available: false }, '16:9'],
      }),
    );
    expect(configured.parameters).toEqual({ quality: 'medium', aspectRatio: '16:9' });
  });

  it('已有参数、未知字段与历史推理强度不被默认值覆盖', () => {
    const original = {
      ...data('video'),
      parameters: { resolution: 'legacy', width: 1920, custom: true },
      inferenceStrength: 'custom-effort',
    };
    const configured = applyNodeGenerationDefaults(
      original,
      model('video', {
        resolutions: ['480p', '720p'],
        durations: [4, 8],
        reasoning_effort: ['low', 'medium'],
      }),
    );
    expect(configured.parameters).toEqual({
      resolution: 'legacy',
      width: 1920,
      custom: true,
      duration: 4,
    });
    expect(configured.inferenceStrength).toBe('custom-effort');
    expect(original.parameters).toEqual({ resolution: 'legacy', width: 1920, custom: true });
  });

  it('缺失模型、不兼容媒体或未声明的媒体枚举不能使用旧菜单回退值', () => {
    for (const candidate of [undefined, model('image'), model('text')]) {
      expect(applyNodeGenerationDefaults(data('image'), candidate).parameters).toEqual({});
    }
    expect(
      applyNodeGenerationDefaults(
        data('image'),
        model('image', {
          quality: { type: 'string', default: 'high' },
          aspectRatios: [],
        }),
      ).parameters,
    ).toEqual({});
  });

  it('无效时长不成为默认值，宽高和连续数值不推算', () => {
    const configured = applyNodeGenerationDefaults(
      data('video'),
      model('video', {
        durations: ['invalid', -1, 0, 5.5, 10],
        width: { min: 1, max: 1920 },
      }),
    );
    expect(configured.parameters).toEqual({ duration: 10 });
  });

  it('官方 MiniMax-H3 在目录缺项时使用官方默认，并清理其他家族的自动参数', () => {
    const original = {
      ...data('video'),
      modelAlias: 'MiniMax-H3',
      parameters: { duration: -1, aspectRatio: 'adaptive', custom: true },
    };
    const configured = applyNodeGenerationDefaults(original, {
      id: 'MiniMax-H3',
      name: 'MiniMax H3',
      mediaTypes: ['video'],
    });
    expect(configured.parameters).toEqual({ custom: true, resolution: '768p', duration: 4 });
    expect(original.parameters).toEqual({
      duration: -1,
      aspectRatio: 'adaptive',
      custom: true,
    });
  });

  it('Moon 小写 minimax-h3 在文生模式使用普通档位和固定比例默认值', () => {
    const original = {
      ...data('video'),
      modelAlias: 'minimax-h3',
      videoMode: 'text_to_video' as const,
      parameters: { duration: -1, aspectRatio: 'adaptive', custom: true },
    };
    const configured = applyNodeGenerationDefaults(original, {
      id: 'minimax-h3',
      name: 'Moon MiniMax H3',
      mediaTypes: ['video'],
    });
    expect(configured.parameters).toEqual({
      custom: true,
      resolution: '480p',
      aspectRatio: '16:9',
      duration: 4,
    });
    expect(original.parameters).toEqual({
      duration: -1,
      aspectRatio: 'adaptive',
      custom: true,
    });
  });

  it('切换到 Wan3 时保留自动时长和 adaptive 比例', () => {
    const configured = applyNodeGenerationDefaults(
      {
        ...data('video'),
        modelAlias: 'wan3.0-video',
        parameters: { duration: -1, aspectRatio: 'adaptive' },
      },
      { id: 'wan3.0-video', name: 'Moon Wan3', mediaTypes: ['video'] },
    );
    expect(configured.parameters).toEqual({
      resolution: '480p',
      aspectRatio: 'adaptive',
      duration: -1,
    });
  });

  it('音频仅初始化已确认格式的第一项，保留必填音色与连续语速的输入含义', () => {
    const configured = applyNodeGenerationDefaults(data('audio'), model('audio'));
    expect(configured.parameters).toEqual({ response_format: 'mp3' });
    expect(configured.parameters).not.toHaveProperty('voice');
    expect(configured.parameters).not.toHaveProperty('speed');
  });

  it('模型限制音频格式时只从实际支持项选择，空枚举不回退到通用格式', () => {
    expect(
      applyNodeGenerationDefaults(
        data('audio'),
        model('audio', {
          audio: { response_formats: ['mp3', 'wav'] },
        }),
      ).parameters,
    ).toEqual({ response_format: 'mp3' });
    expect(
      applyNodeGenerationDefaults(
        data('audio'),
        model('audio', {
          audio: { response_formats: ['mp3'] },
        }),
      ).parameters,
    ).toEqual({ response_format: 'mp3' });
    expect(
      applyNodeGenerationDefaults(
        data('audio'),
        model('audio', {
          audio: { response_formats: [] },
        }),
      ).parameters,
    ).toEqual({});
  });

  it('GPT 已确认推理档位使用 high，并保留单项目录的声明值', () => {
    expect(
      applyNodeGenerationDefaults(data('text'), { ...model('text'), id: 'gpt-5.6-sol' })
        .inferenceStrength,
    ).toBe('high');
    expect(
      applyNodeGenerationDefaults(data('text'), model('text', { reasoning_effort: ['xhigh'] }))
        .inferenceStrength,
    ).toBe('xhigh');
    expect(
      applyNodeGenerationDefaults(data('text'), model('text', { reasoning_effort: [] }))
        .inferenceStrength,
    ).toBeUndefined();
  });

  it('推理强度按 high、中文高标签、第一可用值依次回退', () => {
    for (const [options, expected] of [
      [[{ value: 'custom', label: '高' }, 'high'], 'high'],
      [['low', { value: 'deep', label: '高' }, 'max'], 'deep'],
      [[{ value: 'high', disabled: true }, 'low', 'max'], 'low'],
      [['xhigh', 'ultra'], 'xhigh'],
      [[], undefined],
    ] as const) {
      expect(
        applyNodeGenerationDefaults(data('text'), model('text', { reasoning_effort: options }))
          .inferenceStrength,
      ).toBe(expected);
    }
  });

  it('新建节点沿用画布上一个同类节点的模型与参数', () => {
    const previous = {
      id: 'node_old',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        ...data('image'),
        mode: 'generate',
        modelAlias: 'prev-model',
        credentialId: 'cred-1',
        parameters: { quality: '4k', aspectRatio: '9:16' },
        inferenceStrength: 'medium',
      },
    } as const;
    const seed = resolvePreviousOperationSeed([previous], 'image', 'generate');
    expect(seed).toEqual({
      modelAlias: 'prev-model',
      credentialId: 'cred-1',
      parameters: { quality: '4k', aspectRatio: '9:16' },
      inferenceStrength: 'medium',
    });
    const configured = applyNodeGenerationDefaults(
      { ...data('image'), ...seed },
      model('image', { quality: ['1k', '2k', '4k'], aspectRatios: ['1:1', '9:16'] }),
    );
    expect(configured.parameters).toEqual({ quality: '4k', aspectRatio: '9:16' });
  });

  it('选项文案是默认值时改用实际取值，不把默认值三个字展示给用户', () => {
    const configured = applyNodeGenerationDefaults(
      data('image'),
      model('image', {
        quality: [
          { value: '1k', label: '默认值' },
          { value: '2k', label: '2K' },
        ],
        aspectRatios: ['1:1'],
      }),
    );
    expect(configured.parameters).toEqual({ quality: '1k', aspectRatio: '1:1' });
  });
});
