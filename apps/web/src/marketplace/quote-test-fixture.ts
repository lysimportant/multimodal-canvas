import { registerQuoteConfirmation } from './quote-client';

/** 仅用于测试的合成报价身份；绝不连接供应商或真实钱包。 */
export const TEST_QUOTE_ID = '123e4567-e89b-42d3-a456-426614174299';

/** 业务客户端测试显式模拟“确认”操作；弹窗交互由 QuoteDialog 测试另外覆盖。 */
export function acceptTestQuotes(): () => void {
  return registerQuoteConfirmation(async () => true);
}

/** 增补报价与钱包 HTTP 合同，不修改执行请求；原传输桩继续记录每次真实业务 POST。 */
export function withTestQuoteTransport(execute: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/billing/quotes')) {
      const request = JSON.parse(String(init?.body)) as {
        path: string;
        body: Record<string, unknown>;
      };
      return Response.json({
        quote: {
          id: TEST_QUOTE_ID,
          currency: 'CNY',
          capNanos: '1000',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          items: [
            {
              id: 'test-item',
              nodeId: typeof request.body.nodeId === 'string' ? request.body.nodeId : 'node-test',
              platformModelId: 'model-test',
              modelName: '测试模型',
              pricingVersionId: 'price-test',
              capNanos: '1000',
              unit: 'per_call',
              quantity: 1,
            },
          ],
        },
      });
    }
    if (url.endsWith('/v1/account/wallet'))
      return Response.json({
        wallet: { currency: 'CNY', availableNanos: '10000000000', heldNanos: '0' },
      });
    return execute(input, init);
  };
}
