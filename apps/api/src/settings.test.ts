import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrismaAiSettingsStore } from './settings';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Prisma AI settings encryption', () => {
  it('requires a stable encryption secret instead of generating one at runtime', () => {
    vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_KEY', '');

    expect(() => new PrismaAiSettingsStore({} as never)).toThrow(
      'AI_CREDENTIAL_ENCRYPTION_KEY is required',
    );
  });
});
