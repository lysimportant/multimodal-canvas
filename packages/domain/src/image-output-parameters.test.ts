import { describe, expect, it } from 'vitest';
import {
  ImageOutputParameterError,
  normalizeImageOutputParameters,
  resolveImageOutputParameters,
} from './image-output-parameters';

describe('resolveImageOutputParameters', () => {
  it.each([
    [
      { quality: '4k', aspectRatio: '9:16' },
      { size: '2160x3840', width: 2160, height: 3840, resolution: '4k', aspectRatio: '9:16' },
    ],
    [
      { resolution: '4K', quality: 'high', aspect_ratio: '21:9' },
      {
        size: '3840x1648',
        width: 3840,
        height: 1648,
        resolution: '4k',
        aspectRatio: '21:9',
        quality: 'high',
      },
    ],
    [
      { imageQuality: ' 2K ', aspectRatio: '16:9' },
      { size: '2048x1152', width: 2048, height: 1152, resolution: '2k', aspectRatio: '16:9' },
    ],
    [
      { resolution: '3k' },
      { size: '3072x3072', width: 3072, height: 3072, resolution: '3k', aspectRatio: '1:1' },
    ],
    [
      { aspectRatio: '9:16' },
      { size: '576x1024', width: 576, height: 1024, resolution: '1k', aspectRatio: '9:16' },
    ],
    [
      { size: '1536x1024', image_quality: 'high' },
      { size: '1536x1024', width: 1536, height: 1024, quality: 'high' },
    ],
    [{ resolution: '1024x1536' }, { size: '1024x1536', width: 1024, height: 1536 }],
    [
      { size: '2160x3840', resolution: '4k', aspectRatio: '9:16' },
      { size: '2160x3840', width: 2160, height: 3840, resolution: '4k', aspectRatio: '9:16' },
    ],
    [
      { image_size: ' 1536 × 1024 ', imageSize: '1536x1024' },
      { size: '1536x1024', width: 1536, height: 1024 },
    ],
    [
      { quality: '4K', image_quality: '4k', resolution: '4k', size: 'auto', aspectRatio: '9:16' },
      { size: '2160x3840', width: 2160, height: 3840, resolution: '4k', aspectRatio: '9:16' },
    ],
    [
      { size: '3840x1648', aspectRatio: '21:9' },
      { size: '3840x1648', width: 3840, height: 1648, aspectRatio: '21:9' },
    ],
    [
      { size: 'auto', quality: 'auto' },
      { size: 'auto', quality: 'auto' },
    ],
    [{ aspectRatio: 'auto' }, { size: 'auto' }],
    [{ quality: 'standard' }, { quality: 'standard' }],
    [{ quality: 'hd' }, { quality: 'hd' }],
    [{ quality: 'medium' }, { quality: 'medium' }],
    [{ quality: 'low' }, { quality: 'low' }],
    [{ prompt: 'Do not modify this input.' }, {}],
    [{}, {}],
  ])('resolves only declared image output semantics: %j', (parameters, expected) => {
    const before = structuredClone(parameters);
    expect(resolveImageOutputParameters(parameters)).toEqual(expected);
    expect(parameters).toEqual(before);
  });
});

describe('known image model size contracts', () => {
  it.each([
    'gpt-image-2',
    'gpt-image-2-2026-04-21',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5-sunburst-2026-09-08',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-flare-2026-09-08',
  ])('allows UHD portrait and aligned ultrawide for %s', (model) => {
    expect(resolveImageOutputParameters({ quality: '4k', aspectRatio: '9:16' }, model).size).toBe(
      '2160x3840',
    );
    expect(resolveImageOutputParameters({ quality: '4k', aspectRatio: '21:9' }, model).size).toBe(
      '3840x1648',
    );
  });

  it('does not infer a custom alias capability from its name', () => {
    expect(
      resolveImageOutputParameters(
        { resolution: '4k', aspectRatio: '1:1' },
        'custom-gpt-image-2.5-sunburst',
      ).size,
    ).toBe('3840x3840');
  });
});

describe('automatic size model compatibility', () => {
  it.each(['gpt-image-2.5-sunburst', 'gpt-image-1', 'custom-image-alias'])(
    'preserves auto for %s',
    (model) => {
      expect(resolveImageOutputParameters({ size: 'auto' }, model)).toEqual({ size: 'auto' });
    },
  );
});

describe('normalizeImageOutputParameters', () => {
  it('只保留官方 size 与真实 quality，并原样保留其它字段和假值', () => {
    const parameters = {
      size: '2160x3840',
      image_size: '2160x3840',
      imageSize: '2160x3840',
      resolution: '4k',
      quality: 'high',
      image_quality: 'HIGH',
      imageQuality: ' high ',
      aspectRatio: '9:16',
      aspect_ratio: '9:16',
      prompt: 'Keep the subject unchanged.',
      inferenceStrength: 'medium',
      seed: 0,
      useWatermark: false,
      providerOption: '',
    };
    const before = structuredClone(parameters);

    expect(normalizeImageOutputParameters(parameters, 'gpt-image-2.5-sunburst')).toEqual({
      prompt: 'Keep the subject unchanged.',
      inferenceStrength: 'medium',
      seed: 0,
      useWatermark: false,
      providerOption: '',
      size: '2160x3840',
      quality: 'high',
    });
    expect(parameters).toEqual(before);
  });
});
