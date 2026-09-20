import { useState } from 'react';
import type { NewApiPriceModel } from '@multimodal-canvas/domain';
import type { PricingModel } from './newapi/types';
import {
  getDynamicPriceEntries,
  getDynamicPricingSummary,
  getDynamicPricingTiers,
  isDynamicPricingModel,
  isUnconfiguredTaskUsageModel,
  type DynamicPriceEntry,
} from './newapi/lib/dynamic-price';
import { getDisplayGroupRatio } from './newapi/lib/model-helpers';
import { withPluginPricing } from './newapi/lib/plugin-pricing';
import { getTaskPricingDisplayTiers } from './newapi/lib/task-matrix-display';
import { evaluateTaskUsageExamples } from './newapi/lib/task-expr';
import {
  splitBillingExprAndRequestRules,
  type ParsedTaskTier,
  type ParsedTier,
} from './newapi/lib/billing-expr';

/** 原广场价格名的中文适配；上游用量字段自带中文时优先使用。 */
const labels: Record<string, string> = {
  p: '输入',
  c: '输出',
  cr: '缓存读取',
  cc: '缓存写入',
  cc1h: '缓存写入 1 小时',
  img: '图片输入',
  img_cr: '图片缓存',
  img_o: '图片输出',
  ai: '音频输入',
  ao: '音频输出',
  fixed: '按次',
  constant: '基础费用',
  modelPrice: '按次',
  'Input price': '输入',
  'Completion price': '输出',
  'Cache Creation (5m)': '缓存写入 5 分钟',
  'Price per image': '图片生成',
  'Price per request': '按次',
  'Image input price': '图片输入',
};
/** 原数据多语言说明按中文、英文、原字段顺序解析，不翻译模型 ID。 */
export function pricingText(
  value: string | Record<string, string> | undefined,
  fallback = '',
): string {
  return typeof value === 'string'
    ? value
    : (value?.zh ?? value?.['zh-CN'] ?? value?.en ?? fallback);
}
/** USD 原价与人民币参考价共享上游倍率；显示最多八位小数，账务继续使用服务端整数。 */
function money(value: number, rate: number | null, currency: 'USD' | 'CNY'): string {
  const amount = currency === 'CNY' && rate ? value * rate : value;
  return `${currency === 'CNY' && rate ? '¥' : '$'}${amount.toLocaleString('zh-CN', { maximumFractionDigits: 8 })}`;
}
/** 从原价格明细读取单位，Token 单价沿用每百万的原约定。 */
function unit(entry: DynamicPriceEntry): string {
  if (entry.unit === 'count') return pricingText(entry.unitLabel, '份');
  return (
    (
      { token: '百万 Token', second: '秒', credit: 'credit', request: '次', image: '张' } as Record<
        string,
        string
      >
    )[entry.unit] ?? entry.unit
  );
}
/** 传统倍率模式的字段换算与 New API price.ts 保持一致，显式零不会被省略。 */
export function legacyPriceEntries(model: PricingModel): DynamicPriceEntry[] {
  if (isUnconfiguredTaskUsageModel(model)) return [];
  if (model.quota_type === 1)
    return typeof model.model_price === 'number'
      ? [
          {
            key: 'fixed',
            field: 'fixed',
            label: '按次',
            shortLabel: '按次',
            labelKind: 'i18n',
            unit: 'request',
            value: model.model_price,
            formatted: '',
          },
        ]
      : [];
  const base = model.model_ratio * 2;
  const values: Array<[string, number | undefined | null]> = [
    ['p', base],
    ['c', base * model.completion_ratio],
    ['cr', model.cache_ratio == null ? undefined : base * model.cache_ratio],
    ['cc', model.create_cache_ratio == null ? undefined : base * model.create_cache_ratio],
    ['img', model.image_ratio == null ? undefined : base * model.image_ratio],
    ['ai', model.audio_ratio == null ? undefined : base * model.audio_ratio],
    [
      'ao',
      model.audio_ratio == null || model.audio_completion_ratio == null
        ? undefined
        : base * model.audio_ratio * model.audio_completion_ratio,
    ],
  ];
  return values.flatMap(([key, value]) =>
    value == null
      ? []
      : [
          {
            key,
            field: key,
            label: labels[key]!,
            shortLabel: labels[key]!,
            labelKind: 'i18n' as const,
            unit: 'token' as const,
            value,
            formatted: '',
          },
        ],
  );
}
/** 明细保留所有阶梯与任务规格，不将最后的兜底分支错误标成默认免费。 */
function tierLabel(tier: ParsedTier | ParsedTaskTier, model: PricingModel): string {
  const conditions = tier.conditions.map((condition) => {
    if ('field' in condition) {
      const field = model.billing_usage_schema?.[condition.field];
      return `${pricingText(field?.description, condition.field)}：${pricingText(field?.enumLabels?.[condition.value], condition.value)}`;
    }
    return `${condition.var === 'len' ? '上下文' : (labels[condition.var] ?? condition.var)} ${condition.op} ${condition.value}`;
  });
  if ('conditionText' in tier && tier.conditionText) conditions.push(String(tier.conditionText));
  return conditions.join(' · ') || tier.label;
}
/** 完整展示单个模型的原价、分组、阶梯、缓存、音频、插件和请求附加规则。 */
export function NewApiPrice({
  model,
  rate,
  detail = false,
  displayCurrency = 'USD',
}: {
  model: NewApiPriceModel;
  rate: number | null;
  detail?: boolean;
  displayCurrency?: 'USD' | 'CNY';
}) {
  const [group, setGroup] = useState('');
  const [currency, setCurrency] = useState<'USD' | 'CNY'>(displayCurrency);
  const ratio = getDisplayGroupRatio(model, group);
  const summary = getDynamicPricingSummary(model, {
    tokenUnit: 'M',
    groupRatioMultiplier: ratio,
    usageSchema: model.billing_usage_schema,
  });
  const entries = summary?.entries ?? legacyPriceEntries(model);
  /** 每一行金额按当前分组计算；范围来自原广场摘要算法。 */
  const priceRows = (items: DynamicPriceEntry[]) =>
    items.map((entry) => (
      <div className="na-price-row" key={entry.key}>
        <span>
          {pricingText(entry.description, labels[entry.key] ?? labels[entry.label] ?? entry.label)}
        </span>
        <strong>
          {money((entry.minValue ?? entry.value) * ratio, rate, currency)}
          {entry.maxValue !== undefined && entry.maxValue !== (entry.minValue ?? entry.value)
            ? ` – ${money(entry.maxValue * ratio, rate, currency)}`
            : ''}
          <small> / {unit(entry)}</small>
        </strong>
      </div>
    ));
  const variants = model.billing_plugin_variants?.length
    ? model.billing_plugin_variants.map((variant) => ({
        name: variant.plugin_name,
        model: withPluginPricing(model, variant),
      }))
    : [{ name: '', model }];
  return (
    <div className="na-prices">
      {detail && (
        <div className="na-price-controls">
          <label>
            分组
            <select
              aria-label={`${model.model_name} 价格分组`}
              value={group}
              onChange={(event) => setGroup(event.target.value)}
            >
              <option value="">最低可用分组</option>
              {model.enable_groups.map((name) => (
                <option key={name} value={name}>
                  {name} · {model.group_ratio?.[name] ?? '—'} 倍
                </option>
              ))}
            </select>
          </label>
          <label>
            币种
            <select
              aria-label={`${model.model_name} 价格币种`}
              value={currency}
              onChange={(event) => setCurrency(event.target.value as 'USD' | 'CNY')}
            >
              <option value="USD">USD 美元</option>
              {rate !== null && <option value="CNY">CNY 人民币</option>}
            </select>
          </label>
        </div>
      )}
      {priceRows(detail ? entries : entries.slice(0, 3))}
      {!entries.length && (
        <p>
          {isDynamicPricingModel(model) ? '特殊计费规则，查看完整规则' : '上游未配置可显示价格'}
        </p>
      )}
      {!detail && entries.length > 3 && <small>另有 {entries.length - 3} 项费用</small>}
      {detail &&
        variants.map((variant) => {
          const item = variant.model;
          const { billingExpr, requestRuleExpr } = splitBillingExprAndRequestRules(
            item.billing_expr ?? '',
          );
          const tiers = item.billing_usage_schema
            ? getTaskPricingDisplayTiers(billingExpr, item.billing_usage_schema)
            : getDynamicPricingTiers(item);
          const examples = evaluateTaskUsageExamples(
            item.billing_expr,
            item.billing_usage_schema,
            item.billing_usage_examples,
          );
          return (
            <section className="na-tiers" key={variant.name}>
              {variant.name && <h4>{variant.name}</h4>}
              {tiers.map((tier, index) => (
                <div className="na-tier" key={index}>
                  <h4>{tierLabel(tier, item)}</h4>
                  {priceRows(
                    getDynamicPriceEntries(tier, {
                      tokenUnit: 'M',
                      usageSchema: item.billing_usage_schema,
                    }),
                  )}
                </div>
              ))}
              {!!requestRuleExpr && (
                <p>
                  请求附加倍率：<code>{requestRuleExpr}</code>
                </p>
              )}
              {!!examples.length && (
                <div className="na-tier">
                  <h4>上游用量示例</h4>
                  {examples.map((example, index) => (
                    <div className="na-price-row" key={index}>
                      <span>{example.label}</span>
                      <strong>{money(example.total * ratio, rate, currency)}</strong>
                    </div>
                  ))}
                  {!!requestRuleExpr && <small>示例为基础费用，请求附加倍率按实际请求计算。</small>}
                </div>
              )}
              {item.billing_expr && (
                <details>
                  <summary>New API 原始计费规则</summary>
                  <pre>{item.billing_expr}</pre>
                </details>
              )}
              {!item.billing_expr && variant.name && priceRows(legacyPriceEntries(item))}
            </section>
          );
        })}
      {detail && (
        <p className="mg-muted">
          分组倍率 {ratio}；
          {rate ? `上游汇率 1 USD = ${rate} CNY。` : '上游未提供汇率，仅展示 USD。'}
          画布钱包以提交前报价和最终回执结算。
        </p>
      )}
    </div>
  );
}
