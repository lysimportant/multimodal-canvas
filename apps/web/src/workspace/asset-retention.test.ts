import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAssetRetention, useAssetExpiryClock } from './asset-retention';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('generated asset retention', () => {
  it('requires an explicit valid ISO expiry and never backfills old assets', () => {
    expect(getAssetRetention()).toBeUndefined();
    expect(getAssetRetention({ generatedAt: '2026-10-23T00:00:00Z' })).toBeUndefined();
    for (const expiresAt of ['invalid', '2026-10-26', '2026-02-30T00:00:00Z']) {
      expect(getAssetRetention({ expiresAt })).toBeUndefined();
    }
    const metadata = {
      generatedAt: '2026-10-23T00:00:00Z',
      expiresAt: '2026-10-26T00:00:00Z',
      retentionHours: 72,
    };
    const retention = getAssetRetention(metadata)!;
    expect(retention.expiresAt.timestamp - retention.generatedAt!.timestamp).toBe(
      72 * 60 * 60 * 1000,
    );
    expect(retention.expiresAt.dateTime).toBe('2026-10-26T00:00:00.000Z');
    expect(metadata.expiresAt).toBe('2026-10-26T00:00:00Z');
  });

  it('refreshes at the expiry boundary without polling every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
    const start = Date.now();
    const { result } = renderHook(() => useAssetExpiryClock(start + 5000));
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(result.current).toBe(start);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current).toBeGreaterThanOrEqual(start + 5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
