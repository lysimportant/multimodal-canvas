/** 图片分辨率档位；原生 K 档的实际像素由供应商决定。 */
export type ImageResolution = string;

/** 已知兼容档位的长边像素；其它档位原样交给上游。 */
const resolutionLongEdges: Readonly<Record<string, number>> = {
  '1k': 1024,
  '2k': 2048,
  '3k': 3072,
  '4k': 3840,
};

/** 只匹配官方模型标识；带供应商前缀的代理别名不继承 OpenAI 像素合同。 */
export function usesOpenAIImagePixelSize(modelAlias: string | undefined): boolean {
  return /^(?:gpt-image-(?:1(?:\.5|-mini)?|2(?:\.5-(?:sunburst|flare))?)(?:-\d{4}-\d{2}-\d{2})?|chatgpt-image-latest|dall-e(?:-[23])?)$/i.test(
    modelAlias?.trim() ?? '',
  );
}

/** 旧 OpenAI 图片模型只有固定像素枚举，不能把任意 K 档解释成支持的尺寸。 */
export function openAIImageSizeSuggestions(
  modelAlias: string | undefined,
): readonly string[] | undefined {
  if (!usesOpenAIImagePixelSize(modelAlias)) return undefined;
  const model = modelAlias!.trim().toLowerCase();
  if (/^(?:gpt-image-1|chatgpt-image-latest)/.test(model))
    return ['1024x1024', '1536x1024', '1024x1536'];
  if (model === 'dall-e-3') return ['1024x1024', '1792x1024', '1024x1792'];
  if (model === 'dall-e' || model === 'dall-e-2') return ['256x256', '512x512', '1024x1024'];
  return undefined;
}

/** 图片输出参数的只读解析结果；没有设置尺寸时不臆造供应商默认值。 */
export type ImageOutputParameters = {
  /** 原生 K 档、WIDTHxHEIGHT、auto 或无法解释的原始尺寸；不代替未知值。 */
  size?: string;
  /** 请求宽度，单位 px；自动尺寸时缺省。 */
  width?: number;
  /** 请求高度，单位 px；自动尺寸时缺省。 */
  height?: number;
  /** 新 resolution 的原值或旧 quality 中识别出的已知清晰度档位。 */
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

/** 只解析正有限数值比例；文本比例及零值交给上游，不替换为方形。 */
function parseAspectRatio(value: string | undefined): readonly [number, number] | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value ?? '');
  if (!match) return undefined;
  const horizontal = Number(match[1]);
  const vertical = Number(match[2]);
  return Number.isFinite(horizontal) && Number.isFinite(vertical) && horizontal > 0 && vertical > 0
    ? [horizontal, vertical]
    : undefined;
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
 * @param modelAlias 精确官方 OpenAI 标识使用像素尺寸；代理别名保留原生 size K 档。
 * @returns 明确 size、独立 quality 和用于界面解释的清晰度/像素。仅选比例时不补尺寸，
 * 仅选已知清晰度时按 1:1 计算；显式像素保持原值。未知尺寸、档位或比例保留原值，
 * 不补默认像素。短边对齐可能使实际比例有微小差异。
 * @throws ImageOutputParameterError 比例过于极端，无法转换为有效尺寸时抛出。
 * @example resolveImageOutputParameters({ quality: '4k', aspectRatio: '9:16' }).size // '2160x3840'
 */
export function resolveImageOutputParameters(
  parameters: Readonly<Record<string, unknown>>,
  modelAlias?: string,
): ImageOutputParameters {
  const rawQuality = readAlias(parameters, ['quality', 'image_quality', 'imageQuality']);
  const rawAspectRatio = readAlias(parameters, ['aspectRatio', 'aspect_ratio', 'ratio']);
  const rawSize = readAlias(parameters, ['size', 'image_size', 'imageSize']);
  const rawResolution = readAlias(parameters, ['resolution']);
  if (/^[1-4]k$/i.test(rawSize ?? '')) {
    if (usesOpenAIImagePixelSize(modelAlias)) {
      const output = resolveImageOutputParameters({
        ...parameters,
        size: undefined,
        image_size: undefined,
        imageSize: undefined,
        resolution: rawSize,
      });
      if (!output.width || !output.height)
        throw new ImageOutputParameterError('aspectRatio', 'OpenAI 的 K 档换算需要明确的数字比例');
      const suggestions = openAIImageSizeSuggestions(modelAlias);
      if (suggestions && !suggestions.includes(output.size ?? ''))
        throw new ImageOutputParameterError(
          'size',
          '该 OpenAI 模型不支持此 K 档与比例，请选择其明确支持的像素尺寸',
        );
      if (
        !suggestions &&
        output.width &&
        output.height &&
        (Math.max(output.width, output.height) > 3840 ||
          output.width * output.height > 3840 * 2160 ||
          Math.max(output.width, output.height) / Math.min(output.width, output.height) > 3)
      )
        throw new ImageOutputParameterError(
          'size',
          '此 K 档与比例超过 OpenAI 图片尺寸限制，请降低档位或调整比例',
        );
      return output;
    }
    return {
      size: rawSize!.toUpperCase(),
      resolution: rawSize!.toLowerCase(),
      ...(rawAspectRatio ? { aspectRatio: rawAspectRatio } : {}),
      ...(rawQuality && !/^[1-4]k$/i.test(rawQuality) ? { quality: rawQuality } : {}),
    };
  }
  const pixelResolution = /^\d+\s*[x×]\s*\d+$/.test(rawResolution ?? '');
  const automaticResolution = rawResolution?.toLowerCase() === 'auto';
  const explicitSize = (
    rawSize ?? (pixelResolution || automaticResolution ? rawResolution : undefined)
  )?.replace(/\s*[x×]\s*/i, 'x');
  const explicitDimensions = explicitSize ? /^(\d+)x(\d+)$/i.exec(explicitSize) : undefined;
  const knownQualityResolution = Object.hasOwn(
    resolutionLongEdges,
    rawQuality?.toLowerCase() ?? '',
  );
  if (
    usesOpenAIImagePixelSize(modelAlias) &&
    parseAspectRatio(rawAspectRatio) &&
    (rawSize === undefined || rawSize.toLowerCase() === 'auto') &&
    (rawResolution === undefined || rawResolution.toLowerCase() === 'auto') &&
    !knownQualityResolution
  )
    throw new ImageOutputParameterError('size', 'OpenAI 图片接口需要像素尺寸，请同时选择分辨率');
  const rawKResolution = pixelResolution
    ? undefined
    : ((automaticResolution ? undefined : rawResolution) ??
      (knownQualityResolution ? rawQuality : undefined));
  const knownResolution = Object.hasOwn(resolutionLongEdges, rawKResolution?.toLowerCase() ?? '');
  const canonicalResolution = knownResolution
    ? rawKResolution!.trim().toLowerCase()
    : rawKResolution;
  const quality =
    canonicalResolution &&
    knownQualityResolution &&
    canonicalResolution === rawQuality!.trim().toLowerCase()
      ? undefined
      : rawQuality;
  const ratio = parseAspectRatio(rawAspectRatio);
  const longEdge = knownResolution ? resolutionLongEdges[canonicalResolution!] : undefined;
  const generatedDimensions =
    !explicitDimensions &&
    (explicitSize === undefined || explicitSize.toLowerCase() === 'auto') &&
    longEdge &&
    (rawAspectRatio === undefined || ratio)
      ? dimensionsForRatio(longEdge, ratio ?? [1, 1])
      : undefined;
  const size = generatedDimensions
    ? `${generatedDimensions.width}x${generatedDimensions.height}`
    : explicitSize !== undefined && explicitSize.toLowerCase() !== 'auto'
      ? explicitSize
      : explicitSize?.toLowerCase() === 'auto' || rawAspectRatio?.toLowerCase() === 'auto'
        ? 'auto'
        : undefined;
  const dimensions =
    explicitDimensions ??
    (generatedDimensions ? ['', generatedDimensions.width, generatedDimensions.height] : undefined);
  const effectiveAspectRatio =
    rawAspectRatio?.trim().toLowerCase() === 'auto'
      ? undefined
      : (rawAspectRatio ?? (generatedDimensions ? '1:1' : undefined));
  const effectiveResolution =
    canonicalResolution ??
    (generatedDimensions && (!rawResolution || automaticResolution) ? '1k' : undefined);
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
 * @param modelAlias 精确官方 OpenAI 标识使用像素尺寸；代理别名保留原生 size K 档。
 * @returns 已解析尺寸写入 `size`，供应商原生质量写入 `quality`；仅删除完成转换的别名。
 * 无法解释的尺寸、清晰度和比例保留原字段和值，其它字段及假值保持不变。
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
  if (/^[1-4]k$/i.test(output.size ?? '')) {
    for (const key of ['size', 'image_size', 'imageSize', 'resolution']) {
      if (/^[1-4]k$/i.test(readAlias(parameters, [key]) ?? '')) delete normalized[key];
    }
    for (const key of ['quality', 'image_quality', 'imageQuality']) delete normalized[key];
    normalized.size = output.size;
    if (output.quality !== undefined) normalized.quality = output.quality;
    return normalized;
  }
  const hasCanonicalSize = /^(?:\d+x\d+|auto)$/i.test(output.size ?? '');
  if (hasCanonicalSize) {
    for (const key of ['size', 'image_size', 'imageSize', 'resolution']) {
      const value = readAlias(parameters, [key]);
      if (
        /^(?:\d+\s*[x×]\s*\d+|auto)$/i.test(value ?? '') ||
        (output.width !== undefined &&
          Object.hasOwn(resolutionLongEdges, value?.toLowerCase() ?? ''))
      )
        delete normalized[key];
    }
    for (const key of ['aspectRatio', 'aspect_ratio', 'ratio']) {
      const value = readAlias(parameters, [key]);
      if (
        (output.width !== undefined && parseAspectRatio(value)) ||
        (value?.toLowerCase() === 'auto' &&
          output.size === 'auto' &&
          output.resolution === undefined)
      )
        delete normalized[key];
    }
    normalized.size = output.size;
  }
  for (const key of ['quality', 'image_quality', 'imageQuality']) {
    const value = readAlias(parameters, [key]);
    if (
      output.quality !== undefined ||
      (output.width !== undefined && Object.hasOwn(resolutionLongEdges, value?.toLowerCase() ?? ''))
    )
      delete normalized[key];
  }
  if (output.quality !== undefined) normalized.quality = output.quality;
  return normalized;
}
