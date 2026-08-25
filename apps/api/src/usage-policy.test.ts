import { describe, expect, it } from 'vitest';

import {
  enforceRunCostPolicy,
  parseRunCostPolicy,
  quoteModelCost,
  UsagePolicyError,
} from './usage-policy';

describe('run usage policy', () => {
  it('quotes normalized per-run, per-input and per-unit prices', () => {
    expect(
      quoteModelCost(
        { currency: 'usd', perRun: '0.100000', perInput: '0.025', perUnit: 0.01, unit: 'second' },
        2,
        3,
      ),
    ).toEqual({
      amount: '0.180000',
      currency: 'USD',
      unit: 'second',
      inputCount: 2,
      units: '3.000000',
    });
  });

  it('rejects a quote over the configured per-run ceiling', () => {
    const quote = quoteModelCost({ perRun: '1.25' }, 0);
    expect(() => enforceRunCostPolicy(quote, { maxCostPerRun: '1.249999' })).toThrow(
      'exceeds the configured limit',
    );
    expect(() => enforceRunCostPolicy(quote, { maxCostPerRun: '1.249999' })).toThrowError(
      expect.objectContaining<Partial<UsagePolicyError>>({ code: 'cost_limit_exceeded' }),
    );
  });

  it('ignores unsupported provider price shapes and parses opt-in environment limits', () => {
    expect(quoteModelCost({ input: { price: 1 } }, 2)).toBeUndefined();
    expect(parseRunCostPolicy({ MAX_RUN_COST: '2.50', RUN_COST_CURRENCY: 'eur' })).toEqual({
      maxCostPerRun: '2.50',
      currency: 'EUR',
    });
    expect(parseRunCostPolicy({ MAX_RUN_COST: 'not-money' })).toEqual({ currency: 'USD' });
  });

  it('keeps known pricing when provider metadata contains extra fields, then enforces MAX_RUN_COST', () => {
    const quote = quoteModelCost(
      {
        currency: 'USD',
        perRun: '1.01',
        providerModelId: 'upstream-image-v1',
        metadata: { billingTier: 'standard' },
      },
      0,
    );

    expect(quote).toMatchObject({ amount: '1.010000', currency: 'USD' });
    expect(() => enforceRunCostPolicy(quote, parseRunCostPolicy({ MAX_RUN_COST: '1.00' }))).toThrow(
      'exceeds the configured limit',
    );
    expect(() =>
      enforceRunCostPolicy(quote, parseRunCostPolicy({ MAX_RUN_COST: '1.00' })),
    ).toThrowError(
      expect.objectContaining<Partial<UsagePolicyError>>({ code: 'cost_limit_exceeded' }),
    );
  });

  it('keeps six-decimal money arithmetic exact for large values', () => {
    expect(
      quoteModelCost({ perRun: '999999999999.999999', perInput: '0.000001' }, 1),
    ).toMatchObject({ amount: '1000000000000.000000' });
  });
});
