/** 原广场展示算法的货币适配：算法输出保留 USD，界面按上游汇率另列人民币。 */
export function formatBillingCurrencyFromUSD(
  amount: number,
  options: {
    showSymbol?: boolean;
    digitsLarge?: number;
    digitsSmall?: number;
    abbreviate?: boolean;
  } = {},
): string {
  if (!Number.isFinite(amount)) return '—';
  return `${options.showSymbol === false ? '' : '$'}${amount.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
}
