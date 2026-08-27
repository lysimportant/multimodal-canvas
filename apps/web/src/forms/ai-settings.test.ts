import { describe, expect, it } from 'vitest';

import { aiSettingsFormSchema } from './ai-settings';

describe('AI settings form schema', () => {
  it('reports field-level URL and credential errors', () => {
    const result = aiSettingsFormSchema.safeParse({
      baseUrl: 'ftp://invalid.example.com',
      apiKey: '',
      configured: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.flatten().fieldErrors).toMatchObject({
      baseUrl: ['请输入有效的 HTTP(S) Base URL'],
      apiKey: ['未配置凭据时请输入 API Key'],
    });
  });

  it('allows an empty key when a credential is already configured', () => {
    const result = aiSettingsFormSchema.safeParse({
      baseUrl: '  https://newapi.example.com/v1  ',
      apiKey: '   ',
      configured: true,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      baseUrl: 'https://newapi.example.com/v1',
      apiKey: '',
      configured: true,
    });
  });

  it('rejects a whitespace-only key when no credential exists', () => {
    expect(
      aiSettingsFormSchema.safeParse({
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: '   ',
        configured: false,
      }).success,
    ).toBe(false);
  });
});
