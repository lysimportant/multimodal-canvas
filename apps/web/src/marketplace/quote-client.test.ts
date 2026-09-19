import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingQuote } from '@multimodal-canvas/domain';
import { AuthSessionChangedError, clearAuthSession } from '../auth-client';
import {
  confirmQuotedRequests,
  QuoteCancelledError,
  QuoteRequestError,
  registerQuoteConfirmation,
  submitQuotedRequest,
  type QuotedRequest,
  type QuoteConfirmation,
} from './quote-client';

/** 有稳定模型身份的合成生成请求。 */
const request: QuotedRequest = {
  path: '/v1/nodes/node-a/runs',
  body: { projectId: 'project-a', platformModelId: 'model-a', parameters: { prompt: 'Original' } },
};
/** 报价金额以 nanos 表示，允许精确检验大整数汇总。 */
function quote(
  id = 'quote-a',
  capNanos = '100000000',
  expiresAt = Date.now() + 60_000,
): BillingQuote {
  return {
    id,
    currency: 'CNY',
    capNanos,
    expiresAt: new Date(expiresAt).toISOString(),
    items: [
      {
        id: `${id}-item`,
        nodeId: 'node-a',
        modelName: '文字商品',
        platformModelId: 'model-a',
        pricingVersionId: 'price-v1',
        unit: 'per_call',
        quantity: 1,
        capNanos,
      },
    ],
  };
}
/** 三个 HTTP 阶段使用独立响应，便于核对执行次数。 */
function transport(
  input: { quotes?: BillingQuote[]; balance?: string; execute?: () => Promise<Response> } = {},
) {
  let index = 0;
  return vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/v1/billing/quotes'))
      return Response.json({ quote: input.quotes?.[index++] ?? quote() });
    if (String(url).endsWith('/v1/account/wallet'))
      return Response.json({
        wallet: { currency: 'CNY', availableNanos: input.balance ?? '100000000000' },
      });
    return input.execute ? input.execute() : Response.json({ run: { id: 'run-a' } });
  });
}
let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
  clearAuthSession();
  vi.restoreAllMocks();
});

describe('付费请求报价确认', () => {
  it('取消或未挂载确认界面都不提交生成', async () => {
    const fetcher = transport();
    await expect(submitQuotedRequest('', request, { fetcher })).rejects.toBeInstanceOf(
      QuoteCancelledError,
    );
    unregister = registerQuoteConfirmation(async () => false);
    await expect(submitQuotedRequest('', request, { fetcher })).rejects.toBeInstanceOf(
      QuoteCancelledError,
    );
    expect(fetcher.mock.calls.every(([url]) => !String(url).endsWith('/runs'))).toBe(true);
  });

  it('确认只提交一次冻结正文与报价 ID，后续草稿变更不改变请求', async () => {
    const draft = structuredClone(request);
    const fetcher = transport();
    unregister = registerQuoteConfirmation(async () => {
      draft.body.parameters = { prompt: 'Changed' };
      return true;
    });
    expect((await submitQuotedRequest('https://api.test/', draft, { fetcher })).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]![0]).toBe('https://api.test/v1/nodes/node-a/runs');
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toEqual({
      ...request.body,
      quoteId: 'quote-a',
    });
  });

  it('批量先取得全部报价再一次确认，金额不丢失整数精度', async () => {
    const amount = '9007199254740993';
    const fetcher = transport({
      quotes: [quote('first', amount), quote('second', amount)],
      balance: '99999999999999999',
    });
    const handler = vi.fn<(input: QuoteConfirmation) => Promise<boolean>>(async () => true);
    unregister = registerQuoteConfirmation(handler);
    const confirmed = await confirmQuotedRequests(
      '',
      [request, { ...request, path: '/v1/nodes/node-b/runs' }],
      { fetcher },
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ capNanos: '18014398509481986', quotes: expect.any(Array) }),
    );
    expect(confirmed.map((entry) => entry.quoteId)).toEqual(['first', 'second']);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('确认期间过期需要重新报价并再次确认', async () => {
    const fetcher = transport({
      quotes: [quote('expired', '100', Date.now() - 1), quote('fresh', '200')],
    });
    const handler = vi.fn<(input: QuoteConfirmation) => Promise<boolean>>(async () => true);
    unregister = registerQuoteConfirmation(handler);
    await submitQuotedRequest('', request, { fetcher });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map(([input]) => input.capNanos)).toEqual(['100', '200']);
    expect(JSON.parse(String(fetcher.mock.calls[4]![1]?.body)).quoteId).toBe('fresh');
  });

  it('余额不足即使确认处理器返回同意也不会执行', async () => {
    const fetcher = transport({ balance: '1' });
    unregister = registerQuoteConfirmation(async () => true);
    await expect(submitQuotedRequest('', request, { fetcher })).rejects.toMatchObject({
      status: 402,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('报价期间切换账户立即停止后续钱包查询与执行', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      clearAuthSession();
      return Response.json({ quote: quote() });
    });
    unregister = registerQuoteConfirmation(async () => true);
    await expect(submitQuotedRequest('', request, { fetcher })).rejects.toBeInstanceOf(
      AuthSessionChangedError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('确认期间切换账户不使用新账户提交', async () => {
    const fetcher = transport();
    unregister = registerQuoteConfirmation(async () => {
      clearAuthSession();
      return true;
    });
    await expect(submitQuotedRequest('', request, { fetcher })).rejects.toBeInstanceOf(
      AuthSessionChangedError,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('取消信号在确认后阻止执行', async () => {
    const fetcher = transport();
    const controller = new AbortController();
    unregister = registerQuoteConfirmation(async () => {
      controller.abort();
      return true;
    });
    await expect(
      submitQuotedRequest('', request, { fetcher, signal: controller.signal }),
    ).rejects.toBeInstanceOf(QuoteCancelledError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('错误报价金额和 HTTP 拒绝均不降级为无报价提交', async () => {
    const bad = { ...quote(), capNanos: '1' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ quote: bad }))
      .mockResolvedValueOnce(
        Response.json({ error: '未发布价格', code: 'MODEL_UNPRICED' }, { status: 409 }),
      );
    unregister = registerQuoteConfirmation(async () => true);
    await expect(submitQuotedRequest('', request, { fetcher })).rejects.toBeInstanceOf(
      QuoteRequestError,
    );
    await expect(submitQuotedRequest('', request, { fetcher })).rejects.toMatchObject({
      code: 'MODEL_UNPRICED',
      status: 409,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('执行 POST 网络结果未知不自动重新报价或重发', async () => {
    const execute = vi.fn(async () => {
      throw new Error('connection lost');
    });
    const fetcher = transport({ execute });
    unregister = registerQuoteConfirmation(async () => true);
    await expect(submitQuotedRequest('', request, { fetcher })).rejects.toThrow('connection lost');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    { path: '/v1/projects/p/prompt-optimizations', field: 'optimization' },
    { path: '/v1/assets/a/versions/2/reverse-prompts', field: 'analysis' },
  ])('恢复已受理 $field 不再确认或发送执行 POST', async ({ path, field }) => {
    const payload = { [field]: { runId: 'existing-run', status: 'running' } };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(payload, { status: 202 }));
    const handler = vi.fn(async () => true);
    unregister = registerQuoteConfirmation(handler);
    const result = await submitQuotedRequest(
      '',
      { path, body: { idempotencyKey: 'stable-key' } },
      { fetcher },
    );
    expect(await result.json()).toEqual(payload);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });
});
