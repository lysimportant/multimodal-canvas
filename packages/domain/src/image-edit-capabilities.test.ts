import { describe, expect, it } from 'vitest';

import {
  IMAGE_EDIT_MAX_IMAGES,
  frozenImageEditCapabilitySchema,
  imageEditCapability,
  resolveImageEditMaxImages,
} from './index';

describe('图片编辑多图上限', () => {
  it('camelCase 声明优先，非法值不能被合法 snake_case 别名掩盖', () => {
    expect(
      imageEditCapability({ capabilities: { imageEdit: { maxImages: 2, max_images: 8 } } }),
    ).toEqual({ declared: true, maxImages: 2 });
    expect(
      imageEditCapability({ capabilities: { imageEdit: { maxImages: null, max_images: 8 } } }),
    ).toEqual({ declared: true, invalidMaxImages: true });
  });

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
