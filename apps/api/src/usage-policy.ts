import { z } from 'zod';

const moneyPattern = /^\d{1,12}(?:\.\d{1,6})?$/;

export type ModelPrice = {
  currency?: string;
  perRun?: string | number;
  perInput?: string | number;
  perUnit?: string | number;
  unit?: string;
};

export type UsageQuote = {
  amount: string;
  currency: string;
  unit: string;
  inputCount: number;
  units: string;
};

export type RunCostPolicy = {
  maxCostPerRun?: string | number;
  currency?: string;
};

export class UsagePolicyError extends Error {
  constructor(
    public readonly code: 'invalid_price' | 'cost_limit_exceeded',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Price data is intentionally a small normalized contract. Unknown provider
 * fields are ignored, so a catalog refresh cannot silently invent a charge.
 */
export function parseModelPrice(value: unknown): ModelPrice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = z
    .object({
      currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .optional(),
      perRun: z.union([z.string(), z.number().finite()]).optional(),
      perInput: z.union([z.string(), z.number().finite()]).optional(),
      perUnit: z.union([z.string(), z.number().finite()]).optional(),
      unit: z.string().trim().min(1).max(40).optional(),
    })
    .safeParse(value);
  if (!result.success) return undefined;
  if (
    result.data.perRun === undefined &&
    result.data.perInput === undefined &&
    result.data.perUnit === undefined
  ) {
    return undefined;
  }
  return result.data;
}

export function quoteModelCost(
  price: unknown,
  inputCount: number,
  units: number | string = 1,
): UsageQuote | undefined {
  const parsed = parseModelPrice(price);
  if (!parsed) return undefined;
  if (!Number.isInteger(inputCount) || inputCount < 0) {
    throw new UsagePolicyError('invalid_price', 'inputCount must be a non-negative integer');
  }
  const normalizedUnits = normalizeMoney(units);
  const perRun = normalizeMoney(parsed.perRun ?? 0);
  const perInput = normalizeMoney(parsed.perInput ?? 0);
  const perUnit = normalizeMoney(parsed.perUnit ?? 0);
  const amount = addMoney(
    addMoney(perRun, multiplyMoney(perInput, inputCount)),
    multiplyMoney(perUnit, normalizedUnits),
  );
  return {
    amount,
    currency: (parsed.currency ?? 'USD').toUpperCase(),
    unit: parsed.unit ?? 'unit',
    inputCount,
    units: normalizedUnits,
  };
}

export function enforceRunCostPolicy(quote: UsageQuote | undefined, policy: RunCostPolicy) {
  if (!quote || policy.maxCostPerRun === undefined) return quote;
  const limit = normalizeMoney(policy.maxCostPerRun);
  const expectedCurrency = (policy.currency ?? 'USD').toUpperCase();
  if (quote.currency !== expectedCurrency) {
    throw new UsagePolicyError(
      'invalid_price',
      `model price currency ${quote.currency} does not match policy currency ${expectedCurrency}`,
    );
  }
  if (compareMoney(quote.amount, limit) > 0) {
    throw new UsagePolicyError(
      'cost_limit_exceeded',
      `estimated run cost ${quote.amount} ${quote.currency} exceeds the configured limit`,
    );
  }
  return quote;
}

export function parseRunCostPolicy(env: NodeJS.ProcessEnv = process.env): RunCostPolicy {
  const raw = env.MAX_RUN_COST?.trim();
  const maxCostPerRun = raw && moneyPattern.test(raw) ? raw : undefined;
  const currency = env.RUN_COST_CURRENCY?.trim().toUpperCase() || 'USD';
  return {
    ...(maxCostPerRun ? { maxCostPerRun } : {}),
    currency,
  };
}

function normalizeMoney(value: string | number): string {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!moneyPattern.test(raw)) {
    throw new UsagePolicyError(
      'invalid_price',
      'price must be a positive decimal with up to 6 places',
    );
  }
  const [whole, fraction = ''] = raw.split('.');
  return `${whole}.${fraction.padEnd(6, '0')}`;
}

function addMoney(left: string, right: string): string {
  return formatFixed(parseFixed(left) + parseFixed(right));
}

function multiplyMoney(left: string, right: string | number): string {
  const product = parseFixed(left) * parseFixed(normalizeMoney(right));
  return formatFixed((product + SCALE / 2n) / SCALE);
}

function compareMoney(left: string, right: string): number {
  const leftValue = parseFixed(left);
  const rightValue = parseFixed(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

const SCALE = 1_000_000n;

function parseFixed(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
}

function formatFixed(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}
