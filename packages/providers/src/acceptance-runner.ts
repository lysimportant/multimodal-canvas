/** 真实 Provider 验收的显式授权边界；默认不调用网络，不读取文件中的凭据。 */
import { createHash, randomUUID } from 'node:crypto';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiProviderError, normalizeNewApiBaseUrl } from './index.js';

/** 验收入口只消费列出的进程环境配置，不自动加载仓库 .env。 */
export type AcceptanceEnvironment = Readonly<Record<string, string | undefined>>;

/** 不含提示词、密钥、生成内容或签名 URL 的单次验收记录。 */
export type AcceptanceReport = {
  runId: string;
  status: 'blocked' | 'succeeded' | 'failed';
  code?: string;
  field?: string;
  httpStatus?: number;
  requestCount: number;
  requestIdDigests: string[];
  outputKind?: string;
  usage?: { amount?: number | string; currency?: string; counters: Record<string, number> };
};

/** 必需配置为空时仅返回字段名，不打印配置值。 */
const requiredAcceptanceFields = [
  'PROVIDER_ACCEPTANCE_BASE_URL',
  'PROVIDER_ACCEPTANCE_MODEL',
  'PROVIDER_ACCEPTANCE_API_KEY',
  'PROVIDER_ACCEPTANCE_PROMPT',
] as const;

/**
 * 执行一次已授权的标准 NewAPI 生成，永不自动重试或下载返回 URL。
 * @param environment 显式提供的验收配置；授权短语必须精确匹配。
 * @param fetchImpl 可注入的传输，测试只能使用本地替身；配置校验前绝不调用。
 * @returns 脱敏关联记录；blocked 未发送请求，failed 不代表供应商未受理或未计费。
 */
export async function runProviderAcceptance(
  environment: AcceptanceEnvironment,
  fetchImpl: typeof fetch = fetch,
): Promise<AcceptanceReport> {
  const report: AcceptanceReport = {
    runId: randomUUID(),
    status: 'blocked',
    requestCount: 0,
    requestIdDigests: [],
  };
  if (environment.PROVIDER_ACCEPTANCE_AUTHORIZED !== 'I_ACCEPT_UPSTREAM_CHARGES') {
    return { ...report, code: 'EXPLICIT_AUTHORIZATION_REQUIRED' };
  }
  if (environment.PROVIDER_ACCEPTANCE_PLATFORM !== 'newapi') {
    return { ...report, code: 'PLATFORM_CONTRACT_UNVERIFIED' };
  }
  const mediaType = environment.PROVIDER_ACCEPTANCE_MEDIA_TYPE;
  if (mediaType !== 'text' && mediaType !== 'image' && mediaType !== 'audio') {
    return { ...report, code: 'MEDIA_TYPE_UNSUPPORTED' };
  }
  for (const field of requiredAcceptanceFields) {
    if (!environment[field]?.trim()) return { ...report, code: 'CONFIG_REQUIRED', field };
  }
  if (mediaType === 'audio' && !environment.PROVIDER_ACCEPTANCE_VOICE?.trim()) {
    return { ...report, code: 'CONFIG_REQUIRED', field: 'PROVIDER_ACCEPTANCE_VOICE' };
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeNewApiBaseUrl(environment.PROVIDER_ACCEPTANCE_BASE_URL!);
    if (!baseUrl.startsWith('https://')) throw new Error('HTTPS required');
  } catch {
    return { ...report, code: 'CONFIG_INVALID', field: 'PROVIDER_ACCEPTANCE_BASE_URL' };
  }
  const snapshot: RunSnapshot = {
    projectId: report.runId,
    canvasRevision: 1,
    targetNodeId: 'acceptance',
    modelAlias: environment.PROVIDER_ACCEPTANCE_MODEL!.trim(),
    submittedAt: new Date().toISOString(),
    parameters:
      mediaType === 'audio' ? { voice: environment.PROVIDER_ACCEPTANCE_VOICE!.trim() } : {},
    nodes: [
      {
        id: 'acceptance',
        type: mediaType,
        position: { x: 0, y: 0 },
        data: {
          label: 'Provider acceptance',
          mediaType,
          mode: 'generate',
          prompt: environment.PROVIDER_ACCEPTANCE_PROMPT!,
        },
      },
    ],
    edges: [],
    inputs: [],
  };
  const provider = new NewApiProvider({
    baseUrl,
    apiKey: environment.PROVIDER_ACCEPTANCE_API_KEY!,
    requireHttps: true,
    timeoutMs: 30_000,
    fetchImpl: async (url, init) => {
      report.requestCount += 1;
      const response = await fetchImpl(url, init);
      report.httpStatus = response.status;
      const requestId =
        response.headers.get('x-request-id') ??
        response.headers.get('request-id') ??
        response.headers.get('x-correlation-id');
      if (requestId)
        report.requestIdDigests.push(createHash('sha256').update(requestId).digest('hex'));
      return response;
    },
  });
  try {
    const execution = await provider.execute({
      snapshot,
      providerJob: { provider: 'newapi', id: report.runId },
    });
    const bodyRequestId = execution.providerJob?.payload?.requestId;
    if (report.requestIdDigests.length === 0 && typeof bodyRequestId === 'string') {
      report.requestIdDigests.push(createHash('sha256').update(bodyRequestId).digest('hex'));
    }
    const counters: Record<string, number> = {};
    for (const counter of [
      'prompt_tokens',
      'completion_tokens',
      'input_tokens',
      'output_tokens',
      'total_tokens',
    ]) {
      const value = execution.usage?.metadata?.[counter];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
        counters[counter] = value;
    }
    return {
      ...report,
      status: 'succeeded',
      outputKind: execution.output.kind,
      ...(execution.usage
        ? {
            usage: { amount: execution.usage.amount, currency: execution.usage.currency, counters },
          }
        : {}),
    };
  } catch (error) {
    return {
      ...report,
      status: report.requestCount === 0 ? 'blocked' : 'failed',
      code:
        error instanceof NewApiProviderError && report.requestCount === 0
          ? 'INPUT_INVALID'
          : 'PROVIDER_REQUEST_FAILED',
    };
  }
}
