/** 图片清晰度档位；表示请求长边像素，不表示供应商的采样质量。 */
export type ImageResolution = string;

/** 已知兼容档位的长边像素；其它档位原样交给上游。 */
const resolutionLongEdges: Readonly<Record<string, number>> = {
  '1k': 1024,
  '2k': 2048,
  '3k': 3072,
  '4k': 3840,
};

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
  /** 用户填写的比例；单独选择清晰度时使用明确的 1:1 默认比例。 */
  aspectRatio?: string;
  /** 供应商原生 quality，与像素分辨率无关。 */
  quality?: string;
};

/** 参数结构无法转换时的非重试错误；消息只含字段和本地格式诊断。 */
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

/** 读取第一个已提供的字段别名；能力和取值语义交给上游模型处理。 */
function readAlias(
  parameters: Readonly<Record<string, unknown>>,
  aliases: readonly string[],
): string | undefined {
  for (const name of aliases) {
    const value = parameters[name];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') return value.trim();
    return String(value);
  }
  return undefined;
}

/** 根据长边和比例计算像素；短边按 16 px 对齐，不能舍入成零。 */
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
 * @param modelAlias 兼容保留的模型别名；不会用于本地能力门禁。
 * @returns 明确 size、独立 quality 和用于界面解释的清晰度/像素。仅选比例时以 1K 长边计算，
 * 仅选清晰度时按 1:1 计算；显式像素保持原值。短边对齐可能使实际比例有微小差异。
 * @throws ImageOutputParameterError 比例过于极端，无法转换为有效尺寸时抛出。
 * @example resolveImageOutputParameters({ quality: '4k', aspectRatio: '9:16' }).size // '2160x3840'
 */
export function resolveImageOutputParameters(
  parameters: Readonly<Record<string, unknown>>,
  modelAlias?: string,
): ImageOutputParameters {
  void modelAlias;
  const rawQuality = readAlias(parameters, ['quality', 'image_quality', 'imageQuality']);
  const rawAspectRatio = readAlias(parameters, ['aspectRatio', 'aspect_ratio']);
  const rawSize = readAlias(parameters, ['size', 'image_size', 'imageSize']);
  const rawResolution = readAlias(parameters, ['resolution']);
  const pixelResolution = /^\d+\s*[x×]\s*\d+$/.test(rawResolution ?? '');
  const explicitSize = (rawSize ?? (pixelResolution ? rawResolution : undefined))?.replace(
    /\s*[x×]\s*/i,
    'x',
  );
  const explicitDimensions = explicitSize ? /^(\d+)x(\d+)$/i.exec(explicitSize) : undefined;
  const rawKResolution = pixelResolution
    ? undefined
    : (rawResolution ?? (/^\d+k$/i.test(rawQuality ?? '') ? rawQuality : undefined));
  const canonicalResolution = /^\d+k$/i.test(rawKResolution ?? '')
    ? rawKResolution!.trim().toLowerCase()
    : rawKResolution;
  const quality =
    canonicalResolution &&
    /^\d+k$/i.test(rawQuality ?? '') &&
    canonicalResolution === rawQuality!.trim().toLowerCase()
      ? undefined
      : rawQuality;
  const ratioMatch = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(rawAspectRatio ?? '');
  const ratio = ratioMatch ? ([Number(ratioMatch[1]), Number(ratioMatch[2])] as const) : undefined;
  const longEdge =
    (canonicalResolution ? resolutionLongEdges[canonicalResolution] : undefined) ??
    (rawAspectRatio && rawAspectRatio.trim().toLowerCase() !== 'auto' ? 1024 : undefined);
  const generatedDimensions =
    !explicitDimensions && longEdge && rawAspectRatio?.trim().toLowerCase() !== 'auto'
      ? dimensionsForRatio(longEdge, ratio && ratio[0] > 0 && ratio[1] > 0 ? ratio : [1, 1])
      : undefined;
  const size = generatedDimensions
    ? `${generatedDimensions.width}x${generatedDimensions.height}`
    : explicitSize === 'auto' || rawAspectRatio?.trim().toLowerCase() === 'auto'
      ? 'auto'
      : explicitSize;
  const dimensions =
    explicitDimensions ??
    (generatedDimensions ? ['', generatedDimensions.width, generatedDimensions.height] : undefined);
  const effectiveAspectRatio =
    rawAspectRatio?.trim().toLowerCase() === 'auto'
      ? undefined
      : (rawAspectRatio ?? (generatedDimensions ? '1:1' : undefined));
  const effectiveResolution =
    canonicalResolution ??
    (generatedDimensions && !rawResolution && !rawQuality ? '1k' : undefined);
  return {
    ...(size ? { size } : {}),
    ...(dimensions ? { width: Number(dimensions[1]), height: Number(dimensions[2]) } : {}),
    ...(effectiveResolution ? { resolution: effectiveResolution } : {}),
    ...(effectiveAspectRatio ? { aspectRatio: effectiveAspectRatio } : {}),
    ...(quality ? { quality } : {}),
  };
}

/**
 * 将图片输出字段规范为 Provider 官方的 `size` 与原生 `quality`，保留其它参数。
 *
 * @param parameters 节点或冻结 Run 参数；函数复制输入，不修改原对象。
 * @param modelAlias 兼容保留的模型别名；不会用于本地能力门禁。
 * @returns 删除图片尺寸、清晰度、比例和质量别名后的新对象；已解析尺寸写入
 * `size`，供应商原生质量写入 `quality`，其它字段及假值保持不变。
 * @throws ImageOutputParameterError 比例过于极端，无法转换为有效尺寸时抛出。
 * @example normalizeImageOutputParameters({ size: '2160x3840', quality: 'high' })
 * // { size: '2160x3840', quality: 'high' }
 */
export function normalizeImageOutputParameters(
  parameters: Readonly<Record<string, unknown>>,
  modelAlias?: string,
): Record<string, unknown> {
  const output = resolveImageOutputParameters(parameters, modelAlias);
  const normalized = { ...parameters };
  for (const key of [
    'size',
    'image_size',
    'imageSize',
    'resolution',
    'quality',
    'image_quality',
    'imageQuality',
    'aspectRatio',
    'aspect_ratio',
  ]) {
    delete normalized[key];
  }
  if (output.size !== undefined) normalized.size = output.size;
  if (output.quality !== undefined) normalized.quality = output.quality;
  if (output.width === undefined && output.resolution !== undefined)
    normalized.resolution = output.resolution;
  if (output.width === undefined && output.aspectRatio !== undefined)
    normalized.aspect_ratio = output.aspectRatio;
  return normalized;
}
