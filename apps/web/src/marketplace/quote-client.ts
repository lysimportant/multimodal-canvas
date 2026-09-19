import { billingQuoteSchema, type BillingQuote } from '@multimodal-canvas/domain';
import { z } from 'zod';
import { apiFetch, AuthSessionChangedError, getAuthSessionGeneration } from '../auth-client';
import { serverClockNow } from '../server-clock';

/** 用户尚未同意本次费用；调用方可以保留草稿，但不能继续发出生成请求。 */
export class QuoteCancelledError extends Error {
  constructor(message = '已取消费用确认，未提交生成') {
    super(message);
    this.name = 'QuoteCancelledError';
  }
}
/** 一条待报价的业务请求；确认后仍使用同一 body，禁止重新读取可变画布。 */
export type QuotedRequest = { path: string; body: Record<string, unknown> };
/** 已确认的冻结请求；执行前还需校验报价有效期与账号代次。 */
export type ConfirmedQuotedRequest = QuotedRequest & {
  quoteId: string;
  expiresAt: string;
  authGeneration: number;
};
/** 确认页面所需的公开费用与账户余额，不含上游连接或成本。 */
export type QuoteConfirmation = {
  quotes: BillingQuote[];
  availableNanos: string;
  capNanos: string;
  signal?: AbortSignal;
};
/** 报价读取及最终提交共用的网络上下文。 */
type QuoteRequestOptions = { fetcher?: typeof fetch; signal?: AbortSignal };
/** 应用挂载的显式确认回调；缺少页面时 fail closed。 */
let confirmationHandler: ((input: QuoteConfirmation) => Promise<boolean>) | undefined;

/** 注册费用弹窗，卸载只移除当前实例的处理器。 */
export function registerQuoteConfirmation(
  handler: (input: QuoteConfirmation) => Promise<boolean>,
): () => void {
  confirmationHandler = handler;
  return () => {
    if (confirmationHandler === handler) confirmationHandler = undefined;
  };
}

/** 只读报价和钱包也保留 HTTP 语义，方便业务面板区分明确拒绝与未知执行。 */
export class QuoteRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

/** 读取已验证报价，失败时不退回无报价付费接口。 */
async function responseJson(response: Response): Promise<unknown> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z.object({ error: z.string(), code: z.string().optional() }).safeParse(value);
    throw new QuoteRequestError(
      parsed.success ? parsed.data.error : '费用信息暂不可用',
      response.status,
      parsed.success ? parsed.data.code : undefined,
    );
  }
  return value;
}

/** 每次等待后校验同一账户与取消状态，不允许晚到响应开启下一次请求。 */
function assertQuoteContext(generation: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw new QuoteCancelledError();
  if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
}

/** 只允许有稳定请求键的反推或优化端点返回已受理任务，交由业务解析器继续核对身份。 */
function isRecoveredRequest(request: QuotedRequest, response: Response, payload: unknown): boolean {
  if (response.status !== 202 || typeof request.body.idempotencyKey !== 'string') return false;
  const field = /\/prompt-optimizations$/.test(request.path)
    ? 'optimization'
    : /\/reverse-prompts$/.test(request.path)
      ? 'analysis'
      : undefined;
  if (!field || !payload || typeof payload !== 'object') return false;
  const result = (payload as Record<string, unknown>)[field];
  return z.object({ runId: z.string().min(1) }).safeParse(result).success;
}

/** 统一获取和确认报价；单次幂等恢复可直接返回已受理响应，始终不发送执行 POST。 */
async function prepareQuotedRequests(
  apiBaseUrl: string,
  requests: QuotedRequest[],
  options: QuoteRequestOptions,
  allowRecovery: boolean,
): Promise<{ requests: ConfirmedQuotedRequest[] } | { recovered: Response }> {
  const generation = getAuthSessionGeneration();
  const fetcher =
    options.fetcher ??
    ((input, init) => apiFetch(input, init, { expectedAuthGeneration: generation }));
  const frozen = structuredClone(requests);
  if (!frozen.length) throw new Error('没有需要确认的生成任务');
  for (;;) {
    assertQuoteContext(generation, options.signal);
    const quotes: BillingQuote[] = [];
    for (const request of frozen) {
      const response = await fetcher(`${apiBaseUrl.replace(/\/$/, '')}/v1/billing/quotes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: options.signal,
        body: JSON.stringify(request),
      });
      assertQuoteContext(generation, options.signal);
      const payload = await responseJson(response);
      assertQuoteContext(generation, options.signal);
      if (allowRecovery && frozen.length === 1 && isRecoveredRequest(request, response, payload))
        return { recovered: Response.json(payload, { status: 202 }) };
      const envelope = z.object({ quote: z.unknown() }).safeParse(payload);
      const parsed = billingQuoteSchema.safeParse(
        envelope.success ? envelope.data.quote : undefined,
      );
      if (!parsed.success) throw new QuoteRequestError('报价信息格式无效，请重新获取', 502);
      quotes.push(parsed.data);
    }
    const wallet = z
      .object({
        wallet: z.object({
          currency: z.literal('CNY'),
          availableNanos: z.string().regex(/^(0|[1-9]\d*)$/),
        }),
      })
      .parse(
        await responseJson(
          await fetcher(`${apiBaseUrl.replace(/\/$/, '')}/v1/account/wallet`, {
            signal: options.signal,
          }),
        ),
      ).wallet;
    assertQuoteContext(generation, options.signal);
    const capNanos = quotes.reduce((sum, quote) => sum + BigInt(quote.capNanos), 0n).toString();
    if (!confirmationHandler) throw new QuoteCancelledError('费用确认窗口未就绪，请返回工作台重试');
    const accepted = await confirmationHandler({
      quotes,
      availableNanos: wallet.availableNanos,
      capNanos,
      signal: options.signal,
    });
    assertQuoteContext(generation, options.signal);
    if (!accepted) throw new QuoteCancelledError();
    if (BigInt(capNanos) > BigInt(wallet.availableNanos))
      throw new QuoteRequestError('可用余额不足，请联系管理员补充内部测试额度', 402);
    if (quotes.some((quote) => Date.parse(quote.expiresAt) <= serverClockNow())) continue;
    return {
      requests: frozen.map((request, index) => ({
        ...request,
        quoteId: quotes[index]!.id,
        expiresAt: quotes[index]!.expiresAt,
        authGeneration: generation,
      })),
    };
  }
}

/**
 * 获取全部报价后一次确认总上限；过期只重新报价并再次确认，从不自动同意涨价。
 * @returns 与输入顺序对应的 quoteId；取消、账户改变或报价失败均不会发起执行 POST。
 */
export async function confirmQuotedRequests(
  apiBaseUrl: string,
  requests: QuotedRequest[],
  options: QuoteRequestOptions = {},
): Promise<ConfirmedQuotedRequest[]> {
  const result = await prepareQuotedRequests(apiBaseUrl, requests, options, false);
  if ('recovered' in result) throw new Error('批量生成不能接受任务恢复响应');
  return result.requests;
}

/** 确认后只发送一次原业务请求；网络结果未知时由既有运行恢复流程处理。 */
export async function submitQuotedRequest(
  apiBaseUrl: string,
  request: QuotedRequest,
  options: QuoteRequestOptions = {},
): Promise<Response> {
  const result = await prepareQuotedRequests(apiBaseUrl, [request], options, true);
  if ('recovered' in result) return result.recovered;
  const confirmed = result.requests[0]!;
  assertQuoteContext(confirmed.authGeneration, options.signal);
  if (Date.parse(confirmed.expiresAt) <= serverClockNow())
    throw new QuoteCancelledError('报价已过期，请重新确认费用');
  const fetcher =
    options.fetcher ??
    ((input, init) => apiFetch(input, init, { expectedAuthGeneration: confirmed.authGeneration }));
  const response = await fetcher(`${apiBaseUrl.replace(/\/$/, '')}${confirmed.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({ ...confirmed.body, quoteId: confirmed.quoteId }),
  });
  if (confirmed.authGeneration !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
  return response;
}
