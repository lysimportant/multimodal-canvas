import {
  billingParametersSchema,
  newApiCatalogSchema,
  newApiEstimateSchema,
  newApiReceiptSchema,
  newApiRequestIdSchema,
} from '@multimodal-canvas/domain';

/** 鉴权目录原样保留模型 ID、调用合同和上游显式能力，不通过模型名称推断。 */
export type NewApiCatalog = ReturnType<typeof newApiCatalogSchema.parse>;
/** 目录中的单个上游商品描述；available 仅代表该 Key 当前可用。 */
export type NewApiCatalogModel = NewApiCatalog['models'][number];
/** 单个模型的目录描述别名，便于调用方使用统一 DTO 名称。 */
export type NewApiModel = NewApiCatalogModel;
/** New API 当前预扣估算，用于生成 Canvas 人民币预算授权。 */
export type NewApiEstimate = ReturnType<typeof newApiEstimateSchema.parse>;
/** 原 Key 查询到的原请求最终净 quota；pending 不能用于结算。 */
export type NewApiReceipt = ReturnType<typeof newApiReceiptSchema.parse>;

/** 只从服务端按已冻结凭据版本读取，不接受浏览器提供 Key 或账单地址。 */
export type NewApiCredentials = { baseUrl: string; apiKey: string };

/** 只读预估的媒体描述，仅包含类型和角色，不携带资产地址、身份或内容。 */
export type NewApiEstimateMedia =
  | { type: 'image'; role: 'first_frame' | 'last_frame' | 'reference_image' }
  | { type: 'video'; role: 'reference_video' }
  | { type: 'audio'; role: 'reference_audio' };

/**
 * 使用实际 Provider 字段名估算；input_pending 表示工作流的输入还不完整。
 * input_media 仅用于 newapi-video-v1，最多 9 张图片、3 段视频和 3 段音频；
 * 首尾帧各最多一张且不能混用参考媒体。支持能力仍由上游实际路由确认。
 */
export type NewApiEstimateInput = {
  model: string;
  contract: string;
  parameters: Record<string, string | number | boolean>;
  input_text?: string;
  input_pending?: boolean;
  input_media?: NewApiEstimateMedia[];
};

/** 可注入测试传输及缩短限额，生产请求最长十秒、最多五 MiB，且不自动重试。 */
export type NewApiBridgeOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

/** 错误只返回稳定分类，不附带上游正文、地址、Key 或未经清洗的异常链。 */
export class NewApiBridgeError extends Error {
  constructor(
    public readonly code:
      'newapi_bridge_unavailable' | 'invalid_newapi_response' | 'invalid_newapi_request',
  ) {
    super(
      code === 'invalid_newapi_response'
        ? 'New API 联动响应格式不符合要求'
        : code === 'invalid_newapi_request'
          ? 'New API 联动请求格式不符合要求'
          : 'New API 联动接口暂不可用',
    );
    this.name = 'NewApiBridgeError';
  }
}

/** 获取当前 Key 的模型目录；不调用生成接口，也不使用匿名公开分组倍率。 */
export async function requestNewApiCatalog(
  credentials: NewApiCredentials,
  options: NewApiBridgeOptions = {},
): Promise<NewApiCatalog> {
  return parseResponse(newApiCatalogSchema, await requestBridge(credentials, 'catalog', options));
}

/** 获取当前上游引擎预算；不会创建生成任务，也不会把估算当成最终费用。 */
export async function requestNewApiEstimate(
  credentials: NewApiCredentials,
  input: NewApiEstimateInput,
  options: NewApiBridgeOptions = {},
): Promise<NewApiEstimate> {
  validateEstimateInput(input);
  return parseResponse(
    newApiEstimateSchema,
    await requestBridge(credentials, 'estimate', options, input),
  );
}

/** 查询原请求账单，不触发生成；requestId 始终按单一路径段编码。 */
export async function requestNewApiReceipt(
  credentials: NewApiCredentials,
  requestId: string,
  options: NewApiBridgeOptions = {},
): Promise<NewApiReceipt> {
  if (!newApiRequestIdSchema.safeParse(requestId).success)
    throw new NewApiBridgeError('invalid_newapi_request');
  return parseResponse(
    newApiReceiptSchema,
    await requestBridge(credentials, `receipts/${encodeURIComponent(requestId)}`, options),
  );
}

/** New API 接受的预估维度，必须与实际 Provider 请求使用同一 snake_case 字段。 */
const estimateParameterNames = new Set([
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'reasoning_effort',
  'n',
  'size',
  'quality',
  'seconds',
  'resolution',
  'aspect_ratio',
  'voice',
  'speed',
]);

/** 请求白名单防止把资产 URL、任意对象或未知计费表达式误发给预估接口。 */
function validateEstimateInput(input: NewApiEstimateInput): void {
  const parameters = billingParametersSchema.safeParse(input.parameters);
  if (
    !validIdentity(input.model) ||
    !validIdentity(input.contract) ||
    !parameters.success ||
    Object.keys(input.parameters).some((key) => !estimateParameterNames.has(key)) ||
    Object.keys(input).some(
      (key) =>
        !['model', 'contract', 'parameters', 'input_text', 'input_pending', 'input_media'].includes(
          key,
        ),
    ) ||
    (input.input_text !== undefined &&
      (typeof input.input_text !== 'string' ||
        Buffer.byteLength(input.input_text, 'utf8') > 1024 * 1024)) ||
    (input.input_pending !== undefined && typeof input.input_pending !== 'boolean') ||
    (input.input_media !== undefined &&
      (input.contract !== 'newapi-video-v1' || !validEstimateMedia(input.input_media)))
  )
    throw new NewApiBridgeError('invalid_newapi_request');
}

/** 校验媒体描述及数量上限；拒绝额外字段，避免只读估算意外携带资产或任意参数。 */
function validEstimateMedia(value: unknown): value is NewApiEstimateMedia[] {
  if (!Array.isArray(value) || value.length > 15) return false;
  let images = 0;
  let videos = 0;
  let audios = 0;
  let firstFrames = 0;
  let lastFrames = 0;
  let references = 0;
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => key !== 'type' && key !== 'role')
    )
      return false;
    if (item.type === 'image') {
      images += 1;
      if (item.role === 'first_frame') firstFrames += 1;
      else if (item.role === 'last_frame') lastFrames += 1;
      else if (item.role === 'reference_image') references += 1;
      else return false;
    } else if (item.type === 'video' && item.role === 'reference_video') {
      videos += 1;
      references += 1;
    } else if (item.type === 'audio' && item.role === 'reference_audio') {
      audios += 1;
      references += 1;
    } else return false;
  }
  return (
    images <= 9 &&
    videos <= 3 &&
    audios <= 3 &&
    firstFrames <= 1 &&
    lastFrames <= 1 &&
    (firstFrames + lastFrames === 0 || references === 0)
  );
}

/** 原始模型和请求身份不能有控制字符或首尾空白；不改写大小写及中文字面量。 */
function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    Buffer.byteLength(value, 'utf8') <= 512 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** 在调用边界消除 schema 错误里的输入值，防止错误响应暴露供应商敏感内容。 */
function parseResponse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new NewApiBridgeError('invalid_newapi_response');
  }
}

/** 保留反向代理前缀，只剥离末尾 /v1；只允许 HTTPS 或显式本机 HTTP。 */
function bridgeUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new NewApiBridgeError('newapi_bridge_unavailable');
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/canvas/${path}`;
  return url.toString();
}

/** 限时流式读取；不跟随重定向，不记录原始错误，任何失败均保持原有账务状态。 */
async function requestBridge(
  credentials: NewApiCredentials,
  path: string,
  options: NewApiBridgeOptions,
  body?: NewApiEstimateInput,
): Promise<unknown> {
  const timeoutMs = boundedLimit(options.timeoutMs, 10_000);
  const maxBytes = boundedLimit(options.maxResponseBytes, 5 * 1024 * 1024);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (!credentials.apiKey || /[\r\n]/.test(credentials.apiKey))
      throw new NewApiBridgeError('newapi_bridge_unavailable');
    const response = await (options.fetchImpl ?? fetch)(bridgeUrl(credentials.baseUrl, path), {
      method: body ? 'POST' : 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credentials.apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok || response.redirected)
      throw new NewApiBridgeError('newapi_bridge_unavailable');
    const declared = Number(response.headers.get('content-length'));
    if ((Number.isFinite(declared) && declared > maxBytes) || !response.body)
      throw new NewApiBridgeError('invalid_newapi_response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let complete = false;
    let rejectAbort: (error: NewApiBridgeError) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(new NewApiBridgeError('newapi_bridge_unavailable'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (controller.signal.aborted) throw new NewApiBridgeError('newapi_bridge_unavailable');
        if (done) {
          complete = true;
          break;
        }
        received += value.byteLength;
        if (received > maxBytes) throw new NewApiBridgeError('invalid_newapi_response');
        chunks.push(value);
      }
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
      // 注入传输不一定转发 AbortSignal，且流的 cancel 本身可能停滞；拒绝不能等待清理完成。
      if (!complete) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks, received).toString('utf8'));
    } catch {
      throw new NewApiBridgeError('invalid_newapi_response');
    }
  } catch (error) {
    if (error instanceof NewApiBridgeError) throw error;
    throw new NewApiBridgeError('newapi_bridge_unavailable');
  } finally {
    clearTimeout(timeout);
    // 状态码或声明长度可能在读取正文前被拒绝，仍须终止传输以释放未消费的响应流。
    controller.abort();
  }
}

/** 测试限额只能缩小默认上限，非法或无限值直接使用生产限额。 */
function boundedLimit(value: number | undefined, maximum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(1, Math.floor(value)))
    : maximum;
}
