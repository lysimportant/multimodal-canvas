import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_CARD_MAX_HEIGHT,
  CANVAS_NODE_CARD_MAX_WIDTH,
  CANVAS_NODE_CARD_MIN_HEIGHT,
  CANVAS_NODE_CARD_MIN_WIDTH,
  DEFAULT_IMAGE_VIDEO_NODE_CARD_SIZE,
  DEFAULT_TEXT_AUDIO_NODE_CARD_SIZE,
  resolveCanvasNodeCardSize,
} from './canvas-node-size.js';

describe('新建画布节点卡片尺寸', () => {
  it('按 9:16、16:9、1:1 推导长方形或正方形卡片，并落在 520×420 内', () => {
    expect(
      resolveCanvasNodeCardSize({ mediaType: 'video', parameters: { aspectRatio: '9:16' } }),
    ).toEqual({ width: 236, height: 420 });
    expect(
      resolveCanvasNodeCardSize({ mediaType: 'video', parameters: { aspectRatio: '16:9' } }),
    ).toEqual({ width: 520, height: 293 });
    expect(
      resolveCanvasNodeCardSize({ mediaType: 'image', parameters: { aspectRatio: '1:1' } }),
    ).toEqual({ width: 420, height: 420 });
  });

  it('支持小数比例并等比缩放，不把卡片拉成畸形', () => {
    expect(
      resolveCanvasNodeCardSize({ mediaType: 'image', parameters: { aspectRatio: '1.5:1' } }),
    ).toEqual({ width: 520, height: 347 });
    expect(
      resolveCanvasNodeCardSize({ mediaType: 'video', parameters: { aspectRatio: '21:9' } }),
    ).toEqual({ width: 520, height: 223 });
  });

  it('兼容 aspect_ratio / ratio 别名', () => {
    expect(
      resolveCanvasNodeCardSize({ mediaType: 'video', parameters: { aspect_ratio: '9:16' } }),
    ).toEqual({ width: 236, height: 420 });
    expect(
      resolveCanvasNodeCardSize({ mediaType: 'video', parameters: { ratio: '16:9' } }),
    ).toEqual({ width: 520, height: 293 });
  });

  it.each(['auto', 'adaptive', 'panorama', '16x9', '', '0:9', '9:0', '9:16:1'])(
    '无效或非数字比例 %s 回退媒体默认尺寸',
    (aspectRatio) => {
      expect(
        resolveCanvasNodeCardSize({ mediaType: 'image', parameters: { aspectRatio } }),
      ).toEqual(DEFAULT_IMAGE_VIDEO_NODE_CARD_SIZE);
      expect(resolveCanvasNodeCardSize({ mediaType: 'text', parameters: { aspectRatio } })).toEqual(
        DEFAULT_TEXT_AUDIO_NODE_CARD_SIZE,
      );
    },
  );

  it('没有参数时按媒体类型回退：图片/视频 400×266，文字/音频 320×200', () => {
    expect(resolveCanvasNodeCardSize({ mediaType: 'image' })).toEqual(
      DEFAULT_IMAGE_VIDEO_NODE_CARD_SIZE,
    );
    expect(resolveCanvasNodeCardSize({ mediaType: 'video' })).toEqual(
      DEFAULT_IMAGE_VIDEO_NODE_CARD_SIZE,
    );
    expect(resolveCanvasNodeCardSize({ mediaType: 'text' })).toEqual(
      DEFAULT_TEXT_AUDIO_NODE_CARD_SIZE,
    );
    expect(resolveCanvasNodeCardSize({ mediaType: 'audio' })).toEqual(
      DEFAULT_TEXT_AUDIO_NODE_CARD_SIZE,
    );
    expect(resolveCanvasNodeCardSize({ mediaType: 'video', parameters: { seed: 7 } })).toEqual(
      DEFAULT_IMAGE_VIDEO_NODE_CARD_SIZE,
    );
  });

  it('调用方显式给出的宽高保持原值', () => {
    expect(
      resolveCanvasNodeCardSize({
        mediaType: 'video',
        parameters: { aspectRatio: '9:16' },
        width: 300,
        height: 533,
      }),
    ).toEqual({ width: 300, height: 533 });
  });

  it('只缺一个维度时按比例推导另一边；无比例时用媒体默认值补齐', () => {
    expect(
      resolveCanvasNodeCardSize({
        mediaType: 'video',
        parameters: { aspectRatio: '9:16' },
        width: 300,
      }),
    ).toEqual({ width: 300, height: 533 });
    expect(
      resolveCanvasNodeCardSize({
        mediaType: 'video',
        parameters: { aspectRatio: '16:9' },
        height: 300,
      }),
    ).toEqual({ width: 533, height: 300 });
    expect(resolveCanvasNodeCardSize({ mediaType: 'video', width: 300 })).toEqual({
      width: 300,
      height: DEFAULT_IMAGE_VIDEO_NODE_CARD_SIZE.height,
    });
    expect(resolveCanvasNodeCardSize({ mediaType: 'text', height: 180 })).toEqual({
      width: DEFAULT_TEXT_AUDIO_NODE_CARD_SIZE.width,
      height: 180,
    });
  });

  it('极端比例先缩放到最小卡片尺寸，不会出现零或越界尺寸', () => {
    const extreme = resolveCanvasNodeCardSize({
      mediaType: 'image',
      parameters: { aspectRatio: '1:100' },
    });
    expect(extreme).toEqual({ width: CANVAS_NODE_CARD_MIN_WIDTH, height: 420 });
    expect(
      resolveCanvasNodeCardSize({
        mediaType: 'image',
        parameters: { aspectRatio: '100:1' },
      }),
    ).toEqual({ width: 520, height: CANVAS_NODE_CARD_MIN_HEIGHT });
    expect(
      resolveCanvasNodeCardSize({
        mediaType: 'video',
        parameters: { aspectRatio: '1:100' },
        width: 10_000,
      }),
    ).toEqual({ width: 10_000, height: 10_000 });
    for (const size of [
      { width: CANVAS_NODE_CARD_MAX_WIDTH, height: CANVAS_NODE_CARD_MAX_HEIGHT },
      { width: CANVAS_NODE_CARD_MIN_WIDTH, height: CANVAS_NODE_CARD_MIN_HEIGHT },
    ]) {
      expect(Number.isInteger(size.width) && Number.isInteger(size.height)).toBe(true);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
  });
});
