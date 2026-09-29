/** 图片清晰度档位；表示请求长边像素，不表示供应商的采样质量。 */
export type ImageResolution = '1k' | '2k' | '3k' | '4k';

/** 各档请求长边，单位 px；4K 使用 UHD 的 3840，而非 DCI 的 4096。 */
const resolutionLongEdges: Readonly<Record<ImageResolution, number>> = {
  '1k': 1024,
  '2k': 2048,
  '3k': 3072,
  '4k': 3840,
};

/** 官方 Images 合同已确认支持灵活尺寸的精确模型，不按名称前缀推断未知别名。 */
const flexibleImageSizeModels = new Set([
  'gpt-image-2',
  'gpt-image-2-2026-04-21',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-sunburst-2026-09-08',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-flare-2026-09-08',
]);
/** 图片输出参数的只读解析结果；没有设置尺寸时不臆造供应商默认值。 */
export type ImageOutputParameters = {
  /** Images 接口的 WIDTHxHEIGHT 或 auto；不含清晰度档位字符串。 */
  size?: string;
  /** 请求宽度，单位 px；自动尺寸时缺省。 */
  width?: number;
  /** 请求高度，单位 px；自动尺寸时缺省。 */
  height?: number;
  /** 新 resolution 或旧 quality 中识别出的清晰度档位。 */
  resolution?: ImageResolution;
  /** 固定比例；单独选择清晰度时使用明确的 1:1 默认比例。 */
  aspectRatio?: string;
  /** 供应商原生 quality，与像素分辨率无关。 */
  quality?: string;
};

/** 参数非法或互相矛盾时的非重试错误；消息只含字段和本地约束，不回显用户输入。 */
export class ImageOutputParameterError extends Error {
  /** @param parameter 有问题的参数名。 @param constraint 中文约束，不包含用户原值。 */
  constructor(
    readonly parameter: string,
    constraint: string,
  ) {
    super(`图片参数 ${parameter} ${constraint}`);
    this.name = 'ImageOutputParameterError';
  }
}

/** 读取文本别名并拒绝冲突；缺省字段不参与，大小写和外围空白不影响比较。 */
function readAlias(
  parameters: Readonly<Record<string, unknown>>,
  aliases: readonly string[],
): string | undefined {
  const values = aliases.flatMap((name) => {
    const value = parameters[name];
    if (value === undefined) return [];
    if (typeof value !== 'string' || !value.trim()) {
      throw new ImageOutputParameterError(name, '必须为非空字符串');
    }
    return [value.trim().toLowerCase()];
  });
  if (new Set(values).size > 1) {
    throw new ImageOutputParameterError(aliases.join('/'), '别名值冲突');
  }
  return values[0];
}

/** 解析 K 档，拒绝未知档位；非 K 字符串返回 undefined，留给原生尺寸或质量解析。 */
function resolutionValue(
  value: string | undefined,
  parameter: string,
): ImageResolution | undefined {
  if (!value || !/^\d+k$/i.test(value)) return undefined;
  if (!Object.hasOwn(resolutionLongEdges, value)) {
    throw new ImageOutputParameterError(parameter, '清晰度仅支持 1K、2K、3K 或 4K');
  }
  return value as ImageResolution;
}

/** 读取正整数像素；这里只校验格式，不猜测自定义模型的尺寸能力。 */
function pixelSize(value: string, parameter: string): { width: number; height: number } {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/.exec(value);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new ImageOutputParameterError(
      parameter,
      '必须为正整数 WIDTHxHEIGHT、auto 或已支持的清晰度档位',
    );
  }
  return { width, height };
}

/** 根据长边和固定比例计算像素；短边按 16 px 对齐，不能舍入成零。 */
function dimensionsForRatio(
  longEdge: number,
  ratio: readonly [number, number],
): { width: number; height: number } {
  const [horizontal, vertical] = ratio;
  const shortEdge =
    Math.round((longEdge * Math.min(horizontal, vertical)) / Math.max(horizontal, vertical) / 16) *
    16;
  if (!Number.isSafeInteger(shortEdge) || shortEdge <= 0) {
    throw new ImageOutputParameterError('aspectRatio', '比例过于极端，无法生成有效像素尺寸');
  }
  return horizontal >= vertical
    ? { width: longEdge, height: shortEdge }
    : { width: shortEdge, height: longEdge };
}

/**
 * 将清晰度与比例解析为 Images 接口尺寸，兼容旧 quality=1k/2k/3k/4k。
 *
 * @param parameters 节点或冻结 Run 参数；不会修改输入，也不包含模型能力猜测。
 * @param modelAlias 可选精确模型名；仅对有公开尺寸合同的模型追加边界校验，未知别名不猜测能力。
 * @returns 明确 size、独立 quality 和用于界面解释的清晰度/像素。仅选比例时以 1K 长边计算，
 * 仅选清晰度时按 1:1 计算；显式像素保持原值。短边对齐可能使实际比例有微小差异。
 * @throws ImageOutputParameterError 非法值、冲突别名、显式像素与清晰度/比例矛盾时拒绝，绝不静默缩小。
 * @example resolveImageOutputParameters({ quality: '4k', aspectRatio: '9:16' }).size // '2160x3840'
 */
export function resolveImageOutputParameters(
  parameters: Readonly<Record<string, unknown>>,
  modelAlias?: string,
): ImageOutputParameters {
  const rawQuality = readAlias(parameters, ['quality', 'image_quality', 'imageQuality']);
  let resolution = resolutionValue(rawQuality, 'quality');
  const quality = resolution ? undefined : rawQuality;
  const rawAspectRatio = readAlias(parameters, ['aspectRatio', 'aspect_ratio']);
  let ratio: [number, number] | undefined;
  let aspectRatio: string | undefined;
  if (rawAspectRatio && rawAspectRatio !== 'auto') {
    const match = /^(\d+)\s*:\s*(\d+)$/.exec(rawAspectRatio);
    const horizontal = Number(match?.[1]);
    const vertical = Number(match?.[2]);
    if (
      !Number.isSafeInteger(horizontal) ||
      !Number.isSafeInteger(vertical) ||
      horizontal <= 0 ||
      vertical <= 0
    ) {
      throw new ImageOutputParameterError('aspectRatio', '必须为正整数比例，例如 9:16');
    }
    ratio = [horizontal, vertical];
    aspectRatio = `${horizontal}:${vertical}`;
  }

  let dimensions: { width: number; height: number } | undefined;
  let automatic = rawAspectRatio === 'auto';
  for (const parameter of ['size', 'image_size', 'imageSize', 'resolution']) {
    const value = readAlias(parameters, [parameter]);
    if (!value) continue;
    const candidateResolution = resolutionValue(value, parameter);
    if (candidateResolution) {
      if (resolution && resolution !== candidateResolution) {
        throw new ImageOutputParameterError('resolution/quality', '清晰度档位冲突');
      }
      resolution = candidateResolution;
    } else if (value === 'auto') {
      automatic = true;
    } else {
      const candidate = pixelSize(value, parameter);
      if (
        dimensions &&
        (dimensions.width !== candidate.width || dimensions.height !== candidate.height)
      ) {
        throw new ImageOutputParameterError(
          'size/image_size/imageSize/resolution',
          '像素尺寸别名冲突',
        );
      }
      dimensions = candidate;
    }
  }

  if (dimensions) {
    const { width, height } = dimensions;
    if (resolution && Math.max(width, height) !== resolutionLongEdges[resolution]) {
      throw new ImageOutputParameterError(
        'size/resolution',
        '显式像素与清晰度冲突，请重新选择清晰度或尺寸',
      );
    }
    if (ratio) {
      const [horizontal, vertical] = ratio;
      const shortSideDifference =
        horizontal >= vertical
          ? Math.abs(height - (width * vertical) / horizontal)
          : Math.abs(width - (height * horizontal) / vertical);
      if (shortSideDifference > 8) {
        throw new ImageOutputParameterError(
          'size/aspectRatio',
          '显式像素与比例冲突，请重新选择比例或尺寸',
        );
      }
    }
  } else if (resolution || ratio) {
    if (resolution && rawAspectRatio === 'auto') {
      throw new ImageOutputParameterError(
        'resolution/aspectRatio',
        '固定清晰度需要固定比例，不能使用自动比例',
      );
    }
    resolution ??= '1k';
    ratio ??= [1, 1];
    aspectRatio ??= '1:1';
    dimensions = dimensionsForRatio(resolutionLongEdges[resolution], ratio);
  }

  if (!dimensions && automatic && ['dall-e-2', 'dall-e-3'].includes(modelAlias?.trim() ?? '')) {
    throw new ImageOutputParameterError('size', '当前模型不支持自动尺寸，请选择其原生像素尺寸');
  }
  if (dimensions) validateModelDimensions(dimensions, modelAlias);

  return {
    ...(dimensions
      ? { ...dimensions, size: `${dimensions.width}x${dimensions.height}` }
      : automatic
        ? { size: 'auto' }
        : {}),
    ...(resolution ? { resolution } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(quality ? { quality } : {}),
  };
}

/**
 * 根据明确公开的模型尺寸合同预检，不向更小的尺寸回退。
 * @param dimensions 已解析的正整数像素。
 * @param modelAlias 可选精确模型 ID；未知别名由其网关按独立合同受理。
 * @throws ImageOutputParameterError 已知模型不支持所选边长、像素数或比例。
 */
function validateModelDimensions(
  dimensions: { width: number; height: number },
  modelAlias: string | undefined,
): void {
  const model = modelAlias?.trim();
  if (!model) return;
  const { width, height } = dimensions;
  if (flexibleImageSizeModels.has(model)) {
    if (width % 16 !== 0 || height % 16 !== 0) {
      throw new ImageOutputParameterError('size', '当前模型要求宽高均为 16 的倍数');
    }
    if (Math.max(width, height) > 3840) {
      throw new ImageOutputParameterError('size', '当前模型的最长边不能超过 3840 px');
    }
    if (Math.max(width, height) / Math.min(width, height) > 3) {
      throw new ImageOutputParameterError('aspectRatio', '当前模型的长短边比例不能超过 3:1');
    }
    const pixels = width * height;
    if (pixels < 655_360 || pixels > 8_294_400) {
      throw new ImageOutputParameterError(
        'size',
        '当前清晰度与比例超出模型 655360–8294400 总像素范围，请调整清晰度或比例',
      );
    }
    return;
  }
  const nativeSizes =
    model === 'dall-e-2'
      ? ['256x256', '512x512', '1024x1024']
      : model === 'dall-e-3'
        ? ['1024x1024', '1792x1024', '1024x1792']
        : ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5'].includes(model)
          ? ['1024x1024', '1536x1024', '1024x1536']
          : undefined;
  if (nativeSizes && !nativeSizes.includes(`${width}x${height}`)) {
    throw new ImageOutputParameterError(
      'size',
      `当前模型仅支持 ${nativeSizes.join('、')}${model.startsWith('dall-e-') ? '' : ' 或自动尺寸'}`,
    );
  }
}
