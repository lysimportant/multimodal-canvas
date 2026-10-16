import { describe, expect, it } from 'vitest';

import {
  IMAGE_EDIT_MAX_IMAGES,
  frozenImageEditCapabilitySchema,
  imageEditCapability,
  imageEditReferencesRequirePublicUrl,
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

describe('参考图公网传输声明', () => {
  const target = { targetNodeId: 'node_image' };

  it('只在该节点的冻结限制明确声明 public-url 时生效', () => {
    expect(
      imageEditReferencesRequirePublicUrl(
        { ...target, imageEditCapability: { declared: true } },
        'node_image',
      ),
    ).toBe(false);
    expect(
      imageEditReferencesRequirePublicUrl(
        { ...target, imageEditCapability: { declared: true, referenceImages: 'public-url' } },
        'node_image',
      ),
    ).toBe(true);
  });

  it('按节点冻结值优先，其它节点不继承运行目标的声明', () => {
    const snapshot = {
      ...target,
      imageEditCapability: { declared: true as const, referenceImages: 'public-url' as const },
      nodeImageEditCapabilities: { node_other: { declared: true as const } },
    };
    expect(imageEditReferencesRequirePublicUrl(snapshot, 'node_other')).toBe(false);
    expect(imageEditReferencesRequirePublicUrl(snapshot, 'node_image')).toBe(true);
    expect(imageEditReferencesRequirePublicUrl(snapshot, 'node_unknown')).toBe(false);
  });

  it('未知或非法声明保持缺省，不回退到更宽松的行为', () => {
    expect(imageEditReferencesRequirePublicUrl(target, 'node_image')).toBe(false);
    expect(imageEditReferencesRequirePublicUrl({ ...target, targetNodeId: 'other' }, 'node_image')).toBe(
      false,
    );
    expect(
      frozenImageEditCapabilitySchema.safeParse({
        declared: true,
        referenceImages: 'inline-base64',
      }).success,
    ).toBe(false);
  });
});
