import { describe, expect, it } from 'vitest';
import { ImageOutputParameterError, resolveImageOutputParameters } from './image-output-parameters';

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

  it.each([
    { quality: '8k' },
    { resolution: '720p' },
    { quality: '4k', resolution: '2k' },
    { quality: 'high', imageQuality: 'low' },
    { size: '1024x1024', quality: '4k' },
    { size: '1024x1536', aspectRatio: '16:9' },
    { size: '1024x1536', aspectRatio: '9:16' },
    { size: '1024x1024', imageSize: '1536x1024' },
    { aspect_ratio: '9:16', aspectRatio: '16:9' },
    { aspectRatio: '0:1' },
    { aspectRatio: '1:0' },
    { aspectRatio: '-1:1' },
    { aspectRatio: 'landscape' },
    { aspectRatio: '1:999999999999999999' },
    { quality: '1k', aspectRatio: '1:100000' },
    { quality: '4k', aspectRatio: 'auto' },
    { size: '0x1024' },
    { size: '1024x-1' },
    { size: '1024.5x1024' },
    { size: '999999999999999999x1024' },
    { quality: 4 },
    { resolution: '' },
    { aspectRatio: null },
  ])('rejects invalid values or conflicts without guessing: %j', (parameters) => {
    expect(() => resolveImageOutputParameters(parameters)).toThrow(ImageOutputParameterError);
  });

  it('does not echo untrusted values in parameter errors', () => {
    const value = 'private-prompt-or-token';
    try {
      resolveImageOutputParameters({ size: value });
      throw new Error('Expected invalid size to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ImageOutputParameterError);
      expect((error as Error).message).not.toContain(value);
    }
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

  it.each([
    { resolution: '4k', aspectRatio: '1:1' },
    { resolution: '4k', aspectRatio: '4:3' },
    { resolution: '4k', aspectRatio: '3:2' },
    { resolution: '3k', aspectRatio: '1:1' },
    { resolution: '1k', aspectRatio: '9:16' },
    { resolution: '1k', aspectRatio: '16:9' },
    { resolution: '1k', aspectRatio: '21:9' },
    { size: '4096x2160' },
    { size: '1200x700' },
    { size: '3840x1024' },
  ])('rejects unsupported combinations rather than resizing: %j', (parameters) => {
    expect(() => resolveImageOutputParameters(parameters, 'gpt-image-2.5-sunburst')).toThrow(
      ImageOutputParameterError,
    );
  });

  it.each(['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'dall-e-2', 'dall-e-3'])(
    'preserves native sizes and rejects 4K for %s',
    (model) => {
      expect(resolveImageOutputParameters({ size: '1024x1024' }, model).size).toBe('1024x1024');
      expect(() =>
        resolveImageOutputParameters({ resolution: '4k', aspectRatio: '9:16' }, model),
      ).toThrow(ImageOutputParameterError);
    },
  );

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
  it.each(['dall-e-2', 'dall-e-3'])('rejects auto for fixed-size-only %s', (model) => {
    expect(() => resolveImageOutputParameters({ size: 'auto' }, model)).toThrow(
      ImageOutputParameterError,
    );
    expect(() => resolveImageOutputParameters({ aspectRatio: 'auto' }, model)).toThrow(
      ImageOutputParameterError,
    );
    expect(resolveImageOutputParameters({}, model)).toEqual({});
  });
  it.each(['gpt-image-2.5-sunburst', 'gpt-image-1', 'custom-image-alias'])(
    'preserves auto for %s',
    (model) => {
      expect(resolveImageOutputParameters({ size: 'auto' }, model)).toEqual({ size: 'auto' });
    },
  );
});
