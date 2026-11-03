/**
 * 新建画布节点的卡片尺寸推导。
 *
 * `width` / `height` 是画布上的展示尺寸，和生成分辨率（`parameters.aspectRatio`、
 * `resolution`）无关；但新建节点若不带尺寸，前端只能用历史默认的 230×216 近方形卡片，
 * 9:16 竖屏成片会被塞进方卡里。这里按创作参数里的比例推导一个接近真实画面的卡片，
 * 让后续新建的节点默认就是长方形；旧画布恢复仍走 Web 的 230×216 历史默认，不在此处改动。
 */

/** 卡片尺寸上限；与 Web 内容适配尺寸一致，避免新建节点一出现就过大。 */
export const CANVAS_NODE_CARD_MAX_WIDTH = 520;
export const CANVAS_NODE_CARD_MAX_HEIGHT = 420;
/** 卡片尺寸下限；再小就无法显示标题与操作按钮。 */
export const CANVAS_NODE_CARD_MIN_WIDTH = 180;
export const CANVAS_NODE_CARD_MIN_HEIGHT = 140;

/** 未提供可解析比例时、图片/视频卡片的兜底尺寸；与 Web 新建入口保持一致。 */
export const DEFAULT_IMAGE_VIDEO_NODE_CARD_SIZE = { width: 400, height: 266 } as const;
/** 未提供可解析比例时、文字/音频卡片的兜底尺寸；与 Web 新建入口保持一致。 */
export const DEFAULT_TEXT_AUDIO_NODE_CARD_SIZE = { width: 320, height: 200 } as const;

/** canvasNodeSchema 允许的最大边长；补齐单个缺失维度时同样不得越界。 */
const MAX_CARD_DIMENSION = 10_000;

/** 只依赖媒体类型，避免从 index 引入运行时值造成循环初始化。 */
export type CanvasNodeCardMediaType = 'text' | 'image' | 'audio' | 'video';

export interface CanvasNodeCardSizeInput {
  mediaType: CanvasNodeCardMediaType;
  /** 节点创作参数；只读取比例字段，不猜测模型默认分辨率。 */
  parameters?: Readonly<Record<string, unknown>> | undefined;
  /** 调用方显式给出的宽度；给了就原样保留。 */
  width?: number | undefined;
  /** 调用方显式给出的高度；给了就原样保留。 */
  height?: number | undefined;
}

/** 读取第一个可解析的比例别名；auto/adaptive 等文本或非法值返回 undefined。 */
function readAspectRatio(
  parameters: Readonly<Record<string, unknown>> | undefined,
): readonly [number, number] | undefined {
  if (!parameters) return undefined;
  for (const name of ['aspectRatio', 'aspect_ratio', 'ratio']) {
    const value = parameters[name];
    if (typeof value !== 'string') continue;
    const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
    if (!match) continue;
    const horizontal = Number(match[1]);
    const vertical = Number(match[2]);
    if (Number.isFinite(horizontal) && Number.isFinite(vertical) && horizontal > 0 && vertical > 0)
      return [horizontal, vertical];
  }
  return undefined;
}

/** 无比例可解析时按媒体类型回退，与 Web 新建入口的默认尺寸保持一致。 */
function defaultCardSize(mediaType: CanvasNodeCardMediaType): {
  readonly width: number;
  readonly height: number;
} {
  return mediaType === 'text' || mediaType === 'audio'
    ? DEFAULT_TEXT_AUDIO_NODE_CARD_SIZE
    : DEFAULT_IMAGE_VIDEO_NODE_CARD_SIZE;
}

/** 推导出的边长必须仍落在 canvasNodeSchema 的合法范围内。 */
function clampDimension(value: number): number {
  return Math.min(MAX_CARD_DIMENSION, Math.max(1, Math.round(value)));
}

/** 等比缩放进 520×420 的可用区域，并兜住最小尺寸。 */
function fitAspectRatio(ratio: readonly [number, number]): { width: number; height: number } {
  const [horizontal, vertical] = ratio;
  const scale = Math.min(
    CANVAS_NODE_CARD_MAX_WIDTH / horizontal,
    CANVAS_NODE_CARD_MAX_HEIGHT / vertical,
  );
  return {
    width: Math.max(CANVAS_NODE_CARD_MIN_WIDTH, Math.round(horizontal * scale)),
    height: Math.max(CANVAS_NODE_CARD_MIN_HEIGHT, Math.round(vertical * scale)),
  };
}

/**
 * 计算新建画布节点的卡片尺寸（画布展示尺寸，不是生成分辨率）。
 *
 * @param input 节点媒体类型、创作参数和调用方显式给出的宽高。
 * @returns 两个维度都完整；显式给出的维度保持原值，缺失的维度按比例或媒体默认值补齐。
 * @example resolveCanvasNodeCardSize({ mediaType: 'video', parameters: { aspectRatio: '9:16' } })
 * // { width: 236, height: 420 }
 */
export function resolveCanvasNodeCardSize(input: CanvasNodeCardSizeInput): {
  width: number;
  height: number;
} {
  if (input.width !== undefined && input.height !== undefined)
    return { width: input.width, height: input.height };
  const ratio = readAspectRatio(input.parameters);
  const fallback = defaultCardSize(input.mediaType);
  if (input.width !== undefined)
    return {
      width: input.width,
      height: clampDimension(ratio ? (input.width * ratio[1]) / ratio[0] : fallback.height),
    };
  if (input.height !== undefined)
    return {
      width: clampDimension(ratio ? (input.height * ratio[0]) / ratio[1] : fallback.width),
      height: input.height,
    };
  return ratio ? fitAspectRatio(ratio) : { width: fallback.width, height: fallback.height };
}
