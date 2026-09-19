import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatCnyNanos } from '@multimodal-canvas/domain';
import { registerQuoteConfirmation, type QuoteConfirmation } from './quote-client';
import './quote-dialog.css';

/** 全局费用确认队列；只有明确点击确认才解析为 true，卸载、取消和账户变化均拒绝。 */
export function QuoteDialog({ ownerId }: { ownerId?: string }) {
  const [current, setCurrent] = useState<QuoteConfirmation>();
  const dialog = useRef<HTMLElement>(null);
  const pending = useRef<Array<{ input: QuoteConfirmation; resolve(value: boolean): void }>>([]);
  useEffect(() => {
    const unregister = registerQuoteConfirmation(
      (input) =>
        new Promise<boolean>((resolve) => {
          if (input.signal?.aborted) {
            resolve(false);
            return;
          }
          const entry = {
            input,
            resolve(value: boolean) {
              input.signal?.removeEventListener('abort', onAbort);
              resolve(value);
            },
          };
          const onAbort = () => {
            const index = pending.current.indexOf(entry);
            if (index < 0) return;
            pending.current.splice(index, 1);
            entry.resolve(false);
            if (index === 0) setCurrent(pending.current[0]?.input);
          };
          input.signal?.addEventListener('abort', onAbort, { once: true });
          pending.current.push(entry);
          if (pending.current.length === 1) setCurrent(input);
        }),
    );
    return () => {
      unregister();
      for (const entry of pending.current.splice(0)) entry.resolve(false);
      setCurrent(undefined);
    };
  }, [ownerId]);
  const finish = (accepted: boolean) => {
    pending.current.shift()?.resolve(accepted);
    setCurrent(pending.current[0]?.input);
  };
  useEffect(() => {
    if (!current) return;
    const previousFocus = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === 'Tab') {
        const buttons =
          dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0]!;
        const last = buttons[buttons.length - 1]!;
        if (
          event.shiftKey &&
          (document.activeElement === first || !dialog.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !dialog.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', listener, true);
    return () => {
      document.removeEventListener('keydown', listener, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [current]);
  if (!current) return null;
  const insufficient = BigInt(current.capNanos) > BigInt(current.availableNanos);
  return createPortal(
    <div className="billing-quote-backdrop">
      <section
        ref={dialog}
        className="billing-quote-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="billing-quote-title"
      >
        <h2 id="billing-quote-title">确认本次生成费用</h2>
        <p>费用按成功交付与已发布价格结算，最高扣费不超过本次确认额度。</p>
        {current.quotes.some((quote) =>
          quote.items.some((item) => item.unit === 'upstream_cost'),
        ) && (
          <p>
            New API
            模型按执行时价格和最终账单结算，使用本次报价的人民币换算。当前金额为预算授权，实际扣款不超过确认额度。
          </p>
        )}
        <div className="billing-quote-items">
          {current.quotes.flatMap((quote, index) =>
            quote.items.map((item) => (
              <div key={`${quote.id}:${item.id}`}>
                <span>
                  {current.quotes.length > 1 ? `${index + 1}. ` : ''}
                  {item.modelName}
                  <small>
                    {quoteUnitLabels[item.unit]} · {item.quantity} 份
                  </small>
                </span>
                <strong>最高 ¥{formatCnyNanos(item.capNanos)}</strong>
              </div>
            )),
          )}
        </div>
        <dl>
          <div>
            <dt>可用余额</dt>
            <dd>¥{formatCnyNanos(current.availableNanos)}</dd>
          </div>
          <div>
            <dt>本次最高费用</dt>
            <dd>¥{formatCnyNanos(current.capNanos)}</dd>
          </div>
        </dl>
        {insufficient ? <p role="alert">余额不足，请联系管理员补充内部测试额度。</p> : null}
        <p className="billing-quote-note">
          报价有效至{' '}
          {new Date(
            Math.min(...current.quotes.map((quote) => Date.parse(quote.expiresAt))),
          ).toLocaleTimeString('zh-CN')}
          ，到期后需重新确认。
        </p>
        <footer>
          <button type="button" onClick={() => finish(false)}>
            取消
          </button>
          <button type="button" disabled={insufficient} onClick={() => finish(true)}>
            确认并生成 · 最高 ¥{formatCnyNanos(current.capNanos)}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/** 报价只展示平台售价的计量方式，不暴露上游成本。 */
const quoteUnitLabels = {
  per_call: '按次',
  upstream_cost: '沿用 New API 价格',
  per_image: '按张',
  per_second: '按秒',
  per_token: '按 Token',
  per_character: '按字符',
};
