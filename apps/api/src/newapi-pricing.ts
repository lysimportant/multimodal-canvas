/** New API 公开报价仅作为管理员来源参考；不执行表达式、不推断模型能力或生成平台售价。 */
export type NewApiPricingReference = {
  source: 'newapi_pricing';
  quotaType?: 0 | 1;
  modelPrice?: { amount: string; currency: 'USD'; unit: 'per_call' };
  ratios: Array<{ name: string; value: string }>;
  groups: Array<{ name: string; ratio?: string; description?: string }>;
  billingMode?: string;
  expression?: string;
  pricingVersion?: string;
  incomplete?: true;
};

/** 未验证候选不把 endpoint、名称、计费参数或插件声明当作真实输出能力。 */
export type NewApiPricingCandidate = {
  id: string;
  name: string;
  description?: string;
  vendorName?: string;
  tags: string[];
  endpointTypes: string[];
  mediaTypes: [];
  capabilities: Record<string, never>;
  limitations: Record<string, never>;
  pricingReference: NewApiPricingReference;
  refreshedAt: string;
  verification: 'unverified';
};

/** 目录读取失败只暴露稳定代码，不包含上游地址、正文或连接凭据。 */
export class NewApiPricingError extends Error {
  constructor(public readonly code: 'upstream_pricing_unavailable' | 'invalid_pricing_catalog') {
    super(
      code === 'invalid_pricing_catalog' ? '上游公开定价格式不符合要求' : '上游公开定价暂不可用',
    );
    this.name = 'NewApiPricingError';
  }
}

/** 只允许测试注入传输和较小限额；生产不重试，最多等待十秒并接收五 MiB。 */
export type NewApiPricingRequestOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

/**
 * 从已保存连接派生公开定价路径，保留部署前缀，只剥离末尾 /v1。
 * @throws 无效 URL、非 HTTPS 公网地址、userinfo、查询串或片段均拒绝；不接受响应内提供的 URL。
 */
export function newApiPricingUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new NewApiPricingError('upstream_pricing_unavailable');
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/pricing`;
  return url.toString();
}

/**
 * 匿名 GET 指定已保存连接的公开定价；不读取 Key、不带认证头或 Cookie、不跟随重定向。
 * @returns 经白名单投影的候选；非成功响应、超时、超限和格式错误均抛稳定错误。
 */
export async function requestNewApiPricing(
  baseUrl: string,
  options: NewApiPricingRequestOptions = {},
): Promise<NewApiPricingCandidate[]> {
  const timeoutMs = Math.min(10_000, Math.max(1, options.timeoutMs ?? 10_000));
  const maxBytes = Math.min(
    5 * 1024 * 1024,
    Math.max(1, options.maxResponseBytes ?? 5 * 1024 * 1024),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(newApiPricingUrl(baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok || response.redirected)
      throw new NewApiPricingError('upstream_pricing_unavailable');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new NewApiPricingError('invalid_pricing_catalog');
    if (!response.body) throw new NewApiPricingError('invalid_pricing_catalog');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) throw new NewApiPricingError('invalid_pricing_catalog');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    return normalizeNewApiPricing(JSON.parse(Buffer.concat(chunks, received).toString('utf8')));
  } catch (error) {
    if (error instanceof NewApiPricingError) throw error;
    throw new NewApiPricingError('upstream_pricing_unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

/** 只保留明确的原始价格倍率，不使用浮点乘法、汇率或表达式解释器推导费用。 */
const ratioFields = [
  'model_ratio',
  'completion_ratio',
  'cache_ratio',
  'create_cache_ratio',
  'image_ratio',
  'audio_ratio',
  'audio_completion_ratio',
] as const;

/**
 * 将 success/data 公开响应投影为最多一万条未验证候选，精确 ID 区分大小写。
 * @throws 空白/过长 ID、非法结构或同一 ID 的冲突条目拒绝整次同步，旧来源快照保持不变。
 */
export function normalizeNewApiPricing(payload: unknown): NewApiPricingCandidate[] {
  if (
    !record(payload) ||
    payload.success !== true ||
    !Array.isArray(payload.data) ||
    payload.data.length > 10_000
  )
    throw new NewApiPricingError('invalid_pricing_catalog');
  const vendors = new Map<number, string>();
  if (Array.isArray(payload.vendors)) {
    for (const vendor of payload.vendors.slice(0, 1_000)) {
      if (!record(vendor) || !Number.isSafeInteger(vendor.id)) continue;
      const name = plainText(vendor.name, 160);
      if (name) vendors.set(vendor.id as number, name);
    }
  }
  const ratios = record(payload.group_ratio) ? payload.group_ratio : {};
  const descriptions = record(payload.usable_group) ? payload.usable_group : {};
  const refreshedAt = new Date().toISOString();
  const candidates = new Map<string, NewApiPricingCandidate>();
  let normalizedBytes = 2;
  for (const value of payload.data) {
    if (!record(value)) throw new NewApiPricingError('invalid_pricing_catalog');
    const id = plainText(value.model_name, 512);
    if (!id || id !== id.trim()) throw new NewApiPricingError('invalid_pricing_catalog');
    const description = plainText(value.description, 4_000);
    const vendorName =
      typeof value.vendor_id === 'number' ? vendors.get(value.vendor_id) : undefined;
    const quotaType =
      value.quota_type === 0 || value.quota_type === 1 ? value.quota_type : undefined;
    const amount = decimalText(value.model_price);
    const billingMode = plainText(value.billing_mode, 80);
    const expression = plainText(value.billing_expr, 8_000);
    const pricingVersion =
      plainText(value.pricing_version, 160) ?? plainText(payload.pricing_version, 160);
    const pluginBilling =
      Array.isArray(value.billing_plugin_variants) && value.billing_plugin_variants.length > 0;
    const candidate: NewApiPricingCandidate = {
      id,
      name: id.slice(0, 160),
      ...(description ? { description } : {}),
      ...(vendorName ? { vendorName } : {}),
      tags: textList(
        typeof value.tags === 'string'
          ? value.tags.split(',').map((tag) => tag.trim())
          : value.tags,
        80,
      ),
      endpointTypes: textList(value.supported_endpoint_types, 80),
      mediaTypes: [],
      capabilities: {},
      limitations: {},
      pricingReference: {
        source: 'newapi_pricing',
        ...(quotaType === undefined ? {} : { quotaType }),
        // New API 的 quota_type=1 固定 model_price 合同是 USD/次；表达式存在时旧价格不代表当前费用。
        ...(quotaType === 1 &&
        amount !== undefined &&
        !value.billing_mode &&
        !value.billing_expr &&
        !pluginBilling
          ? { modelPrice: { amount, currency: 'USD', unit: 'per_call' } }
          : {}),
        ratios: ratioFields.flatMap((name) => {
          const numeric = decimalText(value[name]);
          return numeric === undefined ? [] : [{ name, value: numeric }];
        }),
        groups: textList(value.enable_groups, 160).map((name) => {
          const ratio = Object.hasOwn(ratios, name) ? decimalText(ratios[name]) : undefined;
          const description = Object.hasOwn(descriptions, name)
            ? plainText(descriptions[name], 500)
            : undefined;
          return {
            name,
            ...(ratio === undefined ? {} : { ratio }),
            ...(description ? { description } : {}),
          };
        }),
        ...(billingMode ? { billingMode } : {}),
        ...(expression ? { expression } : {}),
        ...(pricingVersion ? { pricingVersion } : {}),
        ...(pluginBilling ? { incomplete: true as const } : {}),
      },
      refreshedAt,
      verification: 'unverified',
    };
    const previous = candidates.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(candidate))
      throw new NewApiPricingError('invalid_pricing_catalog');
    if (!previous) {
      normalizedBytes += Buffer.byteLength(JSON.stringify(candidate), 'utf8') + 1;
      if (normalizedBytes > 5 * 1024 * 1024)
        throw new NewApiPricingError('invalid_pricing_catalog');
    }
    candidates.set(id, candidate);
  }
  return [...candidates.values()];
}

/** 元数据只读取普通对象，不把数组或原型字段当作可投影记录。 */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 来源字符串是有界纯文本；不保存认证材料、签名 URL、控制符或 HTML 标记。 */
function plainText(value: unknown, maximum: number): string | undefined {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<\/?[A-Za-z][^>]*>|https?:\/\/|\bbearer\s|\bsk-[A-Za-z0-9_-]{12,}/i.test(
      value,
    )
  )
    return undefined;
  return value;
}

/** 有界字符串数组保留原文和大小写，精确重复只保留一次。 */
function textList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.slice(0, 256).flatMap((item) => {
        const text = plainText(item, maximum);
        return text ? [text] : [];
      }),
    ),
  ];
}

/** 原始数字仅转十进制文本；不接受负数、NaN、无限值或含 URL 的任意字符串。 */
function decimalText(value: unknown): string | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) && value >= 0 ? String(value) : undefined;
  if (
    typeof value !== 'string' ||
    value.length > 100 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
  )
    return undefined;
  return Number.isFinite(Number(value)) ? value : undefined;
}
