import type { PortRole, VideoMode } from './index.js';

/** Image2Pro 已核对的网关合同；不把宿主安全上限当作供应商逐模型的产出保证。 */
export type Image2proVideoModelContract = {
  /** 模型目录中的精确 ID；大小写或后缀不同的名称不自动适配。 */
  modelAlias: string;
  family: 'image2pro';
  modes: readonly VideoMode[];
  confirmedInputRoles: readonly PortRole[];
  referenceLimits: { images: number; videos: number; audios: number; total: number };
  /** 秒数允许小数，min 为开区间；default 仅用于编辑器新建参数，不补写已冻结请求。 */
  duration: { min: number; max: number; default: number };
  /** 插件未公布比例枚举，只确认非空、无控制字符且不超过此长度。 */
  aspectRatio: { maxLength: number };
  maxPromptLength: number;
};

/** 已确认的精确模型 ID，不包含渠道别名或通过前缀推断的名称。 */
export const image2proVideoModelAliases = Object.freeze([
  '无限制-Flash-中配-Video',
  '无限制-Flash-MAX-Video',
  'Seedance2.0 0.9r',
]);

/** 三个模型共用插件公开合同；音视频兼容字段尚未取得上游支持证据。 */
const image2proVideoContracts: ReadonlyMap<string, Image2proVideoModelContract> = new Map(
  image2proVideoModelAliases.map((modelAlias) => [
    modelAlias,
    Object.freeze({
      modelAlias,
      family: 'image2pro' as const,
      modes: Object.freeze(['text_to_video', 'omni_reference'] satisfies VideoMode[]),
      confirmedInputRoles: Object.freeze([
        'prompt',
        'referenceImage',
        'character',
        'style',
      ] satisfies PortRole[]),
      referenceLimits: Object.freeze({ images: 9, videos: 0, audios: 0, total: 9 }),
      duration: Object.freeze({ min: 0, max: 3600, default: 5 }),
      aspectRatio: Object.freeze({ maxLength: 64 }),
      maxPromptLength: 30_000,
    }),
  ]),
);

/**
 * 按精确 ID 读取 Image2Pro 合同，不影响旧画布数据或其它 Seedance 合同。
 * @param modelAlias 节点或冻结运行中的精确模型 ID，允许外围空白。
 * @returns 已确认合同；未知名称返回 undefined。
 */
export function image2proVideoContractForModel(
  modelAlias?: string,
): Image2proVideoModelContract | undefined {
  return modelAlias ? image2proVideoContracts.get(modelAlias.trim()) : undefined;
}

/** 节点参数兼容别名；引用只能来自画布端口或冻结提及，不能由参数绕过所有权检查。 */
export const image2proVideoParameterKeys = Object.freeze([
  'prompt',
  'duration',
  'seconds',
  'durationSeconds',
  'aspectRatio',
  'aspect_ratio',
  'ratio',
]);

/** Image2Pro 参数错误；字段名可展示，消息不回显用户参数值。 */
export class Image2proVideoParameterError extends Error {
  /**
   * @param parameter 有问题的参数或别名组。
   * @param constraint 本地约束说明，不拼接用户原值。
   * @param code 不支持的字段与不合法值使用不同的非重试错误码。
   */
  constructor(
    readonly parameter: string,
    constraint: string,
    readonly code:
      | 'UNSUPPORTED_PROVIDER_PARAMETER'
      | 'INVALID_PROVIDER_PARAMETER' = 'INVALID_PROVIDER_PARAMETER',
  ) {
    super(`Image2Pro 视频参数 ${parameter} ${constraint}`);
    this.name = 'Image2proVideoParameterError';
  }
}

/** 解析后的网关参数；秒数不取整，比例不替换或补写默认值。 */
export type Image2proVideoParameters = { seconds: number; aspectRatio?: string };

/**
 * 校验 Image2Pro 参数并归一画布历史别名，不修改原参数或丢弃不支持字段。
 * @param parameters 节点或冻结 Run 的参数；duration/seconds/durationSeconds 至少提供一个。
 * @returns 精确秒数与可选比例，供 Web 预检、API 与 Provider 共用。
 * @throws Image2proVideoParameterError 未知字段、别名冲突、缺少时长或类型/范围非法。
 */
export function resolveImage2proVideoParameters(
  parameters: Readonly<Record<string, unknown>>,
): Image2proVideoParameters {
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && !image2proVideoParameterKeys.includes(key)) {
      throw new Image2proVideoParameterError(
        key,
        '尚不支持，请明确移除后重试',
        'UNSUPPORTED_PROVIDER_PARAMETER',
      );
    }
  }
  if (
    parameters.prompt !== undefined &&
    (typeof parameters.prompt !== 'string' || parameters.prompt.length > 30_000)
  ) {
    throw new Image2proVideoParameterError('prompt', '必须为不超过 30000 字符的字符串');
  }
  const durations = ['duration', 'seconds', 'durationSeconds'].flatMap((key) => {
    const value = parameters[key];
    if (value === undefined) return [];
    if (
      (typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) ||
      !Number.isFinite(Number(value)) ||
      Number(value) <= 0 ||
      Number(value) > 3600
    ) {
      throw new Image2proVideoParameterError(key, '必须大于 0 且不超过 3600 秒，允许小数');
    }
    return [Number(value)];
  });
  if (!durations.length) {
    throw new Image2proVideoParameterError('duration', '必须显式指定秒数');
  }
  if (new Set(durations).size > 1) {
    throw new Image2proVideoParameterError('duration/seconds/durationSeconds', '别名值冲突');
  }
  const ratios = ['aspectRatio', 'aspect_ratio', 'ratio'].flatMap((key) => {
    const value = parameters[key];
    if (value === undefined) return [];
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 64 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Image2proVideoParameterError(key, '必须为 1 至 64 字符且无控制字符的非空比例');
    }
    return [value];
  });
  if (new Set(ratios).size > 1) {
    throw new Image2proVideoParameterError('aspectRatio/aspect_ratio/ratio', '别名值冲突');
  }
  return { seconds: durations[0]!, ...(ratios.length ? { aspectRatio: ratios[0] } : {}) };
}
