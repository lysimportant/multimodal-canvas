import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteDialog } from './QuoteDialog';
import { QuoteCancelledError, submitQuotedRequest } from './quote-client';

/** 合成报价/钱包与执行接口，检查真实用户点击前是否发生执行。 */
function setup(balance = '1000000000') {
  const execute = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/v1/billing/quotes'))
      return Response.json({
        quote: {
          id: 'quote-a',
          currency: 'CNY',
          capNanos: '200000000',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          items: [
            {
              id: 'item-a',
              nodeId: 'node-a',
              platformModelId: 'model-a',
              modelName: '图片标准',
              pricingVersionId: 'price-v1',
              capNanos: '200000000',
              unit: 'per_image',
              quantity: 2,
            },
          ],
        },
      });
    if (String(url).endsWith('/v1/account/wallet'))
      return Response.json({ wallet: { currency: 'CNY', availableNanos: balance } });
    execute();
    return Response.json({ run: { id: 'run-a' } });
  });
  return { fetcher, execute };
}
/** 只发给本地合成传输，不连接供应商。 */
const request = { path: '/v1/nodes/node-a/runs', body: { platformModelId: 'model-a' } };
afterEach(cleanup);

describe('生成费用确认窗口', () => {
  it('显示模型、计量和总上限，明确点击确认后才执行', async () => {
    const user = userEvent.setup();
    const { fetcher, execute } = setup();
    render(
      <>
        <button>原入口</button>
        <QuoteDialog ownerId="user-a" />
      </>,
    );
    screen.getByRole('button', { name: '原入口' }).focus();
    const result = submitQuotedRequest('', request, { fetcher });
    await screen.findByRole('dialog', { name: '确认本次生成费用' });
    expect(screen.getByText('图片标准')).toBeVisible();
    expect(screen.getByText('按张 · 2 份')).toBeVisible();
    const confirm = screen.getByRole('button', { name: '确认并生成 · 最高 ¥0.2' });
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    await user.click(confirm);
    await result;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '原入口' })).toHaveFocus();
  });

  it.each(['cancel', 'escape', 'unmount', 'account', 'abort'])(
    '%s 会关闭窗口且不执行',
    async (kind) => {
      const user = userEvent.setup();
      const { fetcher, execute } = setup();
      const controller = new AbortController();
      const view = render(<QuoteDialog ownerId="user-a" />);
      const result = submitQuotedRequest('', request, { fetcher, signal: controller.signal }).catch(
        (error: unknown) => error,
      );
      await screen.findByRole('dialog');
      if (kind === 'cancel') await user.click(screen.getByRole('button', { name: '取消' }));
      if (kind === 'escape') await user.keyboard('{Escape}');
      if (kind === 'unmount') view.unmount();
      if (kind === 'account') view.rerender(<QuoteDialog ownerId="user-b" />);
      if (kind === 'abort') act(() => controller.abort());
      expect(await result).toBeInstanceOf(QuoteCancelledError);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('余额不足时禁用确认，键盘无法离开取消按钮', async () => {
    const user = userEvent.setup();
    const { fetcher, execute } = setup('0');
    const view = render(<QuoteDialog ownerId="user-a" />);
    const result = submitQuotedRequest('', request, { fetcher }).catch((error: unknown) => error);
    expect(await screen.findByRole('alert')).toHaveTextContent('余额不足');
    expect(screen.getByRole('button', { name: /确认并生成/ })).toBeDisabled();
    await user.tab();
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    view.unmount();
    await result;
    expect(execute).not.toHaveBeenCalled();
  });
});
