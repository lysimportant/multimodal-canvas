import { describe, expect, it } from 'vitest';

import {
  IMAGE_EDIT_MAX_IMAGES,
  frozenImageEditCapabilitySchema,
  imageEditCapability,
  resolveImageEditMaxImages,
} from './index';

describe('图片编辑多图上限', () => {
  it.each(['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'chatgpt-image-latest'])(
    '%s 未声明时采用官方 16 张上限',
    (modelAlias) => {
      expect(IMAGE_EDIT_MAX_IMAGES).toBe(16);
      expect(resolveImageEditMaxImages(modelAlias)).toBe(16);
    },
  );

  it.each(['compatible-image', 'dall-e-2', 'vendor/gpt-image-1', 'gpt-image-', ''])(
    '未知模型 %s 保持单图默认值',
    (modelAlias) => {
      expect(resolveImageEditMaxImages(modelAlias)).toBe(1);
    },
  );

  it.each([
    ['gpt-image-1', 1, 1],
    ['gpt-image-1', 4, 4],
    ['compatible-image', 8, 8],
    ['compatible-image', 16, 16],
    ['compatible-image', 32, 16],
  ] as const)('模型 %s 的显式限制 %s 最终取 %s', (modelAlias, maxImages, expected) => {
    expect(resolveImageEditMaxImages(modelAlias, { maxImages })).toBe(expected);
  });

  it.each(['maxImages', 'max_images'])('解析目录字段 %s 并保留原声明', (key) => {
    const capability = imageEditCapability({
      capabilities: { image_edit: { supported: true, [key]: 32 } },
    });
    expect(capability).toEqual({ declared: true, maxImages: 32 });
    expect(resolveImageEditMaxImages('compatible-image', capability)).toBe(16);
  });

  it('camelCase 声明优先，非法值不能被合法 snake_case 别名掩盖', () => {
    expect(
      imageEditCapability({ capabilities: { imageEdit: { maxImages: 2, max_images: 8 } } }),
    ).toEqual({ declared: true, maxImages: 2 });
    expect(
      imageEditCapability({ capabilities: { imageEdit: { maxImages: null, max_images: 8 } } }),
    ).toEqual({ declared: true, invalidMaxImages: true });
  });

  it.each([0, -1, 1.5, '4', null, NaN, Infinity, {}, []])(
    '非法声明 %j 显式标错，解析请求上限时拒绝',
    (maxImages) => {
      for (const key of ['maxImages', 'max_images']) {
        expect(imageEditCapability({ capabilities: { imageEdit: { [key]: maxImages } } })).toEqual({
          declared: true,
          invalidMaxImages: true,
        });
      }
      expect(() =>
        resolveImageEditMaxImages('gpt-image-1', { maxImages: maxImages as number }),
      ).toThrow(RangeError);
      expect(frozenImageEditCapabilitySchema.safeParse({ declared: true, maxImages }).success).toBe(
        false,
      );
    },
  );

  it('显式 undefined 的目录声明标错，旧快照缺省字段仍兼容', () => {
    expect(imageEditCapability({ capabilities: { imageEdit: { maxImages: undefined } } })).toEqual({
      declared: true,
      invalidMaxImages: true,
    });
    expect(frozenImageEditCapabilitySchema.parse({ declared: true })).toEqual({ declared: true });
    expect(frozenImageEditCapabilitySchema.parse({ declared: true, maxImages: 4 })).toEqual({
      declared: true,
      maxImages: 4,
    });
  });
});
